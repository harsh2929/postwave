// SPDX-License-Identifier: AGPL-3.0-only
//
// Package auditsink streams audit_log rows to tenant-configured
// external destinations (S3, Datadog, Splunk, generic HTTP). The
// streaming worker tails the audit_log table (cursor: highest
// audit_log.id forwarded per sink) and POSTs each batch to the
// configured destination.
//
// Failure semantics: a sink that errors is recorded in
// audit_sink_failures + has consecutive_failures incremented. After
// 100 consecutive failures (SOC2 incident threshold) the sink is
// auto-disabled and the tenant owner is notified. Successful
// deliveries reset the counter.

package auditsink

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/auditsink/ocsf"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// Output-format strings stored in audit_sinks.output_format (see
// migration 0275_audit_sink_output_format.sql). When OutputFormat is
// empty (e.g. older code paths constructing a Sink struct manually)
// the deliver path treats it as FormatNative for backward compat.
const (
	FormatNative = "postwave_native"
	FormatOCSF18 = "ocsf_1_8"
)

// Sink is one row from audit_sinks. Credentials are decrypted lazily
// (when the worker actually issues a request).
type Sink struct {
	ID                  string
	TenantID            string
	Kind                string // s3 | datadog | splunk | http | archive | snowflake_shareback | otlp_logs
	Name                string
	Enabled             bool
	Config              map[string]any
	CredentialsEnvelope []byte
	ConsecutiveFailures int
	// OutputFormat is FormatNative or FormatOCSF18. Empty string is
	// treated as FormatNative for backward compat with older code paths.
	OutputFormat string
	// WebhookFormat selects the HTTP signature shape for kind=http sinks:
	// WebhookFormatPostwaveV1 (legacy `X-Postwave-Signature: sha256=...`)
	// or WebhookFormatStandardWebhook (RFC 9499 webhook-id/timestamp/sig).
	// Empty string is treated as WebhookFormatPostwaveV1 for back-compat.
	WebhookFormat string
}

// AuditRow mirrors the canonical audit_log columns the worker streams.
type AuditRow struct {
	ID           int64          `json:"id"`
	TenantID     string         `json:"tenant_id"`
	UserID       string         `json:"user_id,omitempty"`
	Action       string         `json:"action"`
	ResourceType string         `json:"resource_type,omitempty"`
	ResourceID   string         `json:"resource_id,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	IP           string         `json:"ip,omitempty"`
	UserAgent    string         `json:"user_agent,omitempty"`
	ActorType    string         `json:"actor_type,omitempty"`
	ActorLabel   string         `json:"actor_label,omitempty"`
	At           time.Time      `json:"at"`
	RowHash      string         `json:"row_hash,omitempty"` // hex
	PrevHash     string         `json:"prev_hash,omitempty"`
	// EventID is the stable webhook-id idempotency key. Populated from
	// audit_log.event_id when present; otherwise the worker derives it
	// on the fly via DeriveEventID so older rows still get a value.
	EventID string `json:"event_id,omitempty"`
}

// Cipher is the narrow surface this package needs from the platform
// envelope cipher. The composite cipher in apps/api/internal/byok
// satisfies it; tests pass a no-op fake.
type Cipher interface {
	Decrypt(ctx context.Context, blob []byte, legacyKEK []byte) ([]byte, error)
}

// Deps wires the writer worker.
type Deps struct {
	Pool   *db.Pool
	Cipher Cipher
	// Encrypter wraps freshly-generated Standard Webhooks signing keys
	// before they're written to audit_sink_signing_keys. Nil-safe (dev
	// mode stores raw, mirroring admin.go's nil-Encrypter convention).
	Encrypter Encrypter
	// HTTP is retained as a package test seam. Production callers must use
	// New; an arbitrary externally-supplied client is ignored unless the
	// package marked it as hardened after constructing it through the
	// canonical outbound-webhook transport.
	HTTP *http.Client
	// httpClientHardened is deliberately unexported so external callers cannot
	// opt an arbitrary proxy/redirect-following transport into sink delivery.
	httpClientHardened bool
	Logger             *slog.Logger
	// BatchSize caps how many rows we ship per sink per tick. Defaults
	// to 100. Combined with the tick interval (5s by default) this
	// gives ~1200 rows/min/sink at full throttle — well above any
	// real audit volume.
	BatchSize int
	// AutoDisableAfter is the consecutive-failure count that flips a
	// sink to enabled=false. Default 100.
	AutoDisableAfter int
	// CircuitNotifier raises the operator alert when a sink's breaker opens
	// (GOVERNANCE#48). nil = the historical behaviour: the state change is
	// recorded and nobody is told. See circuit_notify.go.
	CircuitNotifier CircuitNotifier
}

// New returns a Worker with sensible defaults.
//
// HTTP client uses the SSRF-safe transport so tenant-configured sink
// URLs (the `http` kind especially) can't be pointed at private/
// link-local/loopback IPs to exfiltrate audit-log content into the
// internal network. 30s timeout preserved (vs the secure default 10s)
// because audit sinks like Splunk HEC and Datadog HTTP intake legit-
// imately take longer to ack a 100-event batch than a single webhook
// delivery. Audit finding H3 (SSRF).
func New(pool *db.Pool, cipher Cipher, logger *slog.Logger) *Deps {
	return &Deps{
		Pool: pool, Cipher: cipher,
		HTTP:               newAuditSinkHTTPClient(30 * time.Second),
		httpClientHardened: true,
		Logger:             logger,
		BatchSize:          100,
		AutoDisableAfter:   100,
	}
}

var (
	errAuditSinkDestination = errors.New("audit sink destination is not allowed")
	errAuditSinkRedirect    = errors.New("audit sink redirects are not allowed")
)

// newAuditSinkHTTPClient is the only production client constructor in this
// package. It reuses the canonical no-proxy, dial-time DNS/private-IP guarded
// transport and rejects redirects entirely so credentials, signatures, and
// audit payloads cannot be replayed to a second origin.
func newAuditSinkHTTPClient(timeout time.Duration) *http.Client {
	return newAuditSinkHTTPClientWithTransport(timeout, nil)
}

// newAuditSinkHTTPClientWithTransport exists for adversarial unit tests. All
// production call sites pass nil and therefore get NewSecureTransport.
func newAuditSinkHTTPClientWithTransport(timeout time.Duration, transport http.RoundTripper) *http.Client {
	client := outbound_webhooks.NewSecureHTTPClient(transport)
	if timeout > 0 {
		client.Timeout = timeout
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errAuditSinkRedirect
	}
	return client
}

// httpClient fails closed when a Deps value was constructed outside this
// package with an arbitrary client. Package tests deliberately opt their fake
// transports in by setting httpClientHardened.
func (d *Deps) httpClient() *http.Client {
	if d != nil && d.HTTP != nil && d.httpClientHardened {
		return d.HTTP
	}
	return newAuditSinkHTTPClient(30 * time.Second)
}

func validateAuditSinkDestination(rawURL string) error {
	if err := outbound_webhooks.ValidateURL(rawURL, true); err != nil {
		return errAuditSinkDestination
	}
	return nil
}

// Run drives the worker on the configured interval.
func (d *Deps) Run(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	if d.Logger != nil {
		d.Logger.Info("auditsink worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
		if err := d.tick(ctx); err != nil && d.Logger != nil {
			d.Logger.Warn("auditsink tick failed", "err", err.Error())
		}
	}
}

// tick runs one pass: load all enabled sinks across all tenants,
// stream the next batch to each.
func (d *Deps) tick(ctx context.Context) error {
	sinks, err := d.loadEnabledSinks(ctx)
	if err != nil {
		return fmt.Errorf("load sinks: %w", err)
	}
	for _, s := range sinks {
		// Session advisory locks belong to a PostgreSQL connection, not a
		// pool. acquireAdvisoryLockSink pins one pgxpool.Conn and returns a
		// release closure that unlocks on that exact session. The wrapper's
		// defer covers every early-return branch in processSink.
		_, lockErr := withSinkAdvisoryLock(ctx, s.ID, d.acquireAdvisoryLockSink, func() error {
			d.processSink(ctx, s)
			return nil
		})
		if lockErr != nil {
			if d.Logger != nil {
				d.Logger.Warn("auditsink advisory lock failed",
					"sink", s.ID, "err", lockErr.Error())
			}
		}
	}
	return nil
}

// processSink performs one locked sink iteration. It intentionally returns
// through each failure/empty/circuit branch; withSinkAdvisoryLock owns the
// surrounding defer so none of those exits can strand the session lock.
func (d *Deps) processSink(ctx context.Context, s Sink) {
	// Circuit-breaker preflight. When the sink is `open` and the cooldown
	// hasn't elapsed yet, skip the network call entirely and capture the
	// would-be batch in the DLQ.
	decision, err := d.breakerCheck(ctx, s)
	if err != nil && d.Logger != nil {
		d.Logger.Warn("auditsink breaker check failed",
			"sink", s.ID, "err", err.Error())
	}
	cursor, _ := cursorFromConfig(s.Config)
	rows, err := d.loadBatch(ctx, s.TenantID, cursor, d.BatchSize)
	if err != nil {
		d.recordFailure(ctx, s, 0, fmt.Errorf("load batch: %w", err))
		return
	}
	if len(rows) == 0 {
		return
	}
	if decision == circuitDeny {
		fromID := rows[0].ID
		toID := rows[len(rows)-1].ID
		if dlqErr := d.writeDLQ(ctx, s, fromID, toID,
			"circuit open"); dlqErr != nil && d.Logger != nil {
			d.Logger.Warn("auditsink dlq write failed",
				"sink", s.ID, "err", dlqErr.Error())
		}
		if err := d.updateCursor(ctx, s, toID); err != nil && d.Logger != nil {
			d.Logger.Warn("auditsink update cursor failed",
				"sink", s.ID, "err", err.Error())
		}
		return
	}
	if err := d.deliver(ctx, s, rows); err != nil {
		d.recordFailure(ctx, s, 0, err)
		transitioned, brErr := d.breakerOnFailure(ctx, s, err.Error())
		if brErr != nil && d.Logger != nil {
			d.Logger.Warn("auditsink breaker on-failure failed",
				"sink", s.ID, "err", brErr.Error())
		}
		if transitioned {
			_ = d.writeDLQ(ctx, s, rows[0].ID, rows[len(rows)-1].ID, err.Error())
			// GOVERNANCE#48 — the breaker is committed; audit records are now
			// being held instead of shipped. Say so.
			d.notifyCircuitOpened(ctx, s, s.ConsecutiveFailures+1)
		}
		return
	}
	newCursor := rows[len(rows)-1].ID
	if err := d.updateCursor(ctx, s, newCursor); err != nil && d.Logger != nil {
		d.Logger.Warn("auditsink update cursor failed", "sink", s.ID, "err", err.Error())
	}
	d.recordSuccess(ctx, s)
	if err := d.breakerOnSuccess(ctx, s); err != nil && d.Logger != nil {
		d.Logger.Warn("auditsink breaker on-success failed",
			"sink", s.ID, "err", err.Error())
	}
	// Replay jobs share the same per-sink serialization boundary as live
	// delivery and therefore run before the deferred unlock.
	if err := d.processReplayJobs(ctx, s); err != nil && d.Logger != nil {
		d.Logger.Warn("auditsink replay drain failed",
			"sink", s.ID, "err", err.Error())
	}
}

// processReplayJobs drains pending/in_progress replay jobs for the
// sink, one batch per call, respecting BatchSize and the circuit
// breaker. Each call processes at most one batch per job (we want to
// share airtime with live-stream traffic). Returns nil on success or
// when no jobs are available.
func (d *Deps) processReplayJobs(ctx context.Context, s Sink) error {
	job, err := d.claimReplayJob(ctx, s.ID)
	if err != nil || job == nil {
		return err
	}
	// Circuit-breaker check: if the sink is open, leave the job in
	// in_progress and let the next tick try again once the cooldown
	// elapses. The job stays visible in the UI as "waiting on breaker".
	decision, brErr := d.breakerCheck(ctx, s)
	if brErr != nil && d.Logger != nil {
		d.Logger.Warn("auditsink replay breaker check failed",
			"sink", s.ID, "err", brErr.Error())
	}
	if decision == circuitDeny {
		return nil
	}
	batchSize := d.BatchSize
	if batchSize <= 0 {
		batchSize = 100
	}
	cursor := int64(0)
	if job.NextCursorID != nil {
		cursor = *job.NextCursorID
	}
	rows, err := d.loadReplayBatch(ctx, s.TenantID, cursor, job.FromAuditID, job.ToAuditID, batchSize)
	if err != nil {
		return fmt.Errorf("load replay batch: %w", err)
	}
	if len(rows) == 0 {
		// No more rows in [cursor+1, toID] — job complete.
		return d.markReplayCompleted(ctx, job.ID)
	}
	if err := d.deliver(ctx, s, rows); err != nil {
		// Record + bubble through the same breaker path the live
		// stream uses. Replay failures count toward auto-disable too.
		d.recordFailure(ctx, s, 0, err)
		transitioned, brErr := d.breakerOnFailure(ctx, s, err.Error())
		if brErr != nil && d.Logger != nil {
			d.Logger.Warn("auditsink replay breaker on-failure failed",
				"sink", s.ID, "err", brErr.Error())
		}
		if transitioned {
			// Same DLQ contract as live stream: capture the range we
			// just couldn't ship so an operator can re-replay or
			// inspect.
			_ = d.writeDLQ(ctx, s, rows[0].ID, rows[len(rows)-1].ID, err.Error())
			// A breaker that opens during a REPLAY has exactly the same
			// consequence as one that opens on the live stream: audit
			// records stop leaving. Same alert (GOVERNANCE#48).
			d.notifyCircuitOpened(ctx, s, s.ConsecutiveFailures+1)
			_ = d.markReplayFailed(ctx, job.ID, err.Error(), int64(len(rows)))
			return nil
		}
		return nil
	}
	newCursor := rows[len(rows)-1].ID
	if err := d.advanceReplayCursor(ctx, job.ID, newCursor, int64(len(rows))); err != nil && d.Logger != nil {
		d.Logger.Warn("auditsink replay cursor advance failed",
			"job", job.ID, "err", err.Error())
	}
	d.recordSuccess(ctx, s)
	_ = d.breakerOnSuccess(ctx, s)
	return nil
}

type sinkLockAcquirer func(context.Context, string) (bool, func() error, error)

// withSinkAdvisoryLock guarantees that a successfully-acquired lock is
// released exactly once even when work returns an error or panics.
func withSinkAdvisoryLock(
	ctx context.Context,
	sinkID string,
	acquire sinkLockAcquirer,
	work func() error,
) (processed bool, err error) {
	got, release, err := acquire(ctx, sinkID)
	if err != nil || !got {
		return false, err
	}
	defer func() {
		if releaseErr := release(); releaseErr != nil {
			err = errors.Join(err, fmt.Errorf("release advisory lock for sink %s: %w", sinkID, releaseErr))
		}
	}()
	return true, work()
}

// acquireAdvisoryLockSink pins one pool connection for the full lock
// lifetime. Unlock runs on that same session with a fresh bounded context so
// cancellation of the worker operation cannot strand the lock. If lock state
// is uncertain (acquire scan or unlock failure), the connection is destroyed
// instead of being returned to the pool with a possible session lock.
func (d *Deps) acquireAdvisoryLockSink(ctx context.Context, sinkID string) (bool, func() error, error) {
	noop := func() error { return nil }
	if d == nil || d.Pool == nil {
		return false, noop, errors.New("auditsink: pool required for advisory lock")
	}
	conn, err := d.Pool.Acquire(ctx)
	if err != nil {
		return false, noop, err
	}
	discard := func() {
		raw := conn.Hijack()
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = raw.Close(closeCtx)
	}

	var got bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtext($1)::bigint)`, sinkID).Scan(&got); err != nil {
		discard()
		return false, noop, err
	}
	if !got {
		conn.Release()
		return false, noop, nil
	}

	release := func() error {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		unlockErr := conn.QueryRow(unlockCtx,
			`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, sinkID).Scan(&unlocked)
		if unlockErr == nil && unlocked {
			conn.Release()
			return nil
		}
		// Never recycle a session whose advisory-lock state is unknown.
		discard()
		if unlockErr != nil {
			return unlockErr
		}
		return errors.New("postgresql reported that the advisory lock was not held")
	}
	return true, release, nil
}

func cursorFromConfig(cfg map[string]any) (int64, bool) {
	v, ok := cfg["cursor"]
	if !ok {
		return 0, false
	}
	switch t := v.(type) {
	case float64:
		return int64(t), true
	case int64:
		return t, true
	case int:
		return int64(t), true
	}
	return 0, false
}

// loadEnabledSinks returns every enabled sink across every tenant.
// Worker-permissive context.
func (d *Deps) loadEnabledSinks(ctx context.Context) ([]Sink, error) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, kind, name, config,
       COALESCE(credentials_envelope, ''::bytea),
       consecutive_failures,
       COALESCE(output_format, 'postwave_native'),
       COALESCE(webhook_format, 'postwave_v1')
  FROM audit_sinks
 WHERE enabled = true`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Sink{}
	for rows.Next() {
		var s Sink
		var configBytes []byte
		if err := rows.Scan(&s.ID, &s.TenantID, &s.Kind, &s.Name,
			&configBytes, &s.CredentialsEnvelope, &s.ConsecutiveFailures,
			&s.OutputFormat, &s.WebhookFormat); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(configBytes, &s.Config)
		out = append(out, s)
	}
	return out, rows.Err()
}

// loadBatch returns rows with id > cursor for the given tenant, oldest
// first, capped at limit.
func (d *Deps) loadBatch(ctx context.Context, tenantID string, cursor int64, limit int) ([]AuditRow, error) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text,
       COALESCE(user_id::text,''), action,
       COALESCE(resource_type,''), COALESCE(resource_id,''),
       COALESCE(metadata, '{}'::jsonb),
       COALESCE(host(ip), ''), COALESCE(user_agent, ''),
       COALESCE(actor_type, 'human'), COALESCE(actor_label, ''),
       at,
       COALESCE(prev_hash, ''::bytea),
       COALESCE(row_hash, ''::bytea),
       COALESCE(event_id::text, '')
  FROM audit_log
 WHERE tenant_id = $1::uuid AND id > $2
 ORDER BY id ASC
 LIMIT $3`, tenantID, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var a AuditRow
		var meta []byte
		var prevHash, rowHash []byte
		if err := rows.Scan(&a.ID, &a.TenantID, &a.UserID, &a.Action,
			&a.ResourceType, &a.ResourceID, &meta, &a.IP, &a.UserAgent,
			&a.ActorType, &a.ActorLabel, &a.At, &prevHash, &rowHash,
			&a.EventID); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(meta, &a.Metadata)
		if len(rowHash) > 0 {
			a.RowHash = hex.EncodeToString(rowHash)
		}
		if len(prevHash) > 0 {
			a.PrevHash = hex.EncodeToString(prevHash)
		}
		// Backfill event_id for pre-migration rows so the Standard
		// Webhooks `webhook-id` header is always populated. Deterministic
		// — same row → same uuid across replicas.
		if a.EventID == "" {
			a.EventID = DeriveEventID(a.TenantID, a.Action,
				a.ResourceType, a.ResourceID, a.ActorLabel, a.At)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// rowPayloads materialises each row in the configured output format.
// Returns a parallel slice of map[string]any (rather than []byte) so
// the kind-specific helpers can embed the row inside vendor envelopes
// (Datadog log object, Splunk HEC event, etc.) without re-parsing.
//
// FormatNative round-trips the AuditRow struct; FormatOCSF18 routes
// through ocsf.Map and flattens the class-specific extension.
func rowPayloads(s Sink, rows []AuditRow) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	useOCSF := s.OutputFormat == FormatOCSF18
	for _, r := range rows {
		if useOCSF {
			ocsfRow := ocsf.AuditRow{
				ID: r.ID, TenantID: r.TenantID, UserID: r.UserID,
				Action: r.Action, ResourceType: r.ResourceType,
				ResourceID: r.ResourceID, Metadata: r.Metadata,
				IP: r.IP, UserAgent: r.UserAgent,
				ActorType: r.ActorType, ActorLabel: r.ActorLabel,
				At: r.At, RowHash: r.RowHash, PrevHash: r.PrevHash,
			}
			ev := ocsf.Map(ocsfRow)
			b, _ := ocsf.MarshalNDJSON([]ocsf.Event{ev})
			b = bytes.TrimRight(b, "\n")
			var m map[string]any
			if err := json.Unmarshal(b, &m); err == nil {
				out = append(out, m)
				continue
			}
		}
		raw, _ := json.Marshal(r)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		out = append(out, m)
	}
	return out
}

// formatLabel returns the public-facing tag for the sink's output
// format, used in Datadog ddtags (and any other vendor tag header)
// so SOC analysts can filter on it directly.
func formatLabel(s Sink) string {
	if s.OutputFormat == FormatOCSF18 {
		return "ocsf_1_8"
	}
	return "postwave_native"
}

// deliver ships a batch to the sink. Dispatches by kind.
func (d *Deps) deliver(ctx context.Context, s Sink, rows []AuditRow) error {
	creds, err := d.decryptCreds(ctx, s)
	if err != nil {
		observability.AuditSinkDeliveriesTotal.WithLabelValues(s.Kind, "failure").Inc()
		return fmt.Errorf("decrypt creds: %w", err)
	}
	// Batch-size histogram fires once per delivery regardless of
	// outcome; latency histogram + outcome counter fire from the
	// kind-specific helper below.
	observability.AuditSinkBatchRows.WithLabelValues(s.Kind).Observe(float64(len(rows)))
	start := time.Now()
	var deliverErr error
	switch s.Kind {
	case "datadog":
		deliverErr = d.deliverDatadog(ctx, s, rows, creds)
	case "splunk":
		deliverErr = d.deliverSplunk(ctx, s, rows, creds)
	case "s3":
		deliverErr = d.deliverS3(ctx, s, rows, creds)
	case "http":
		deliverErr = d.deliverHTTP(ctx, s, rows, creds)
	case "archive":
		// retention-trail-archive (Compliance, P1): Parquet + S3 Object
		// Lock (WORM) archive. deliverArchive re-decrypts internally
		// since parquet encoding + SigV4 PUT live in its own helper.
		_ = creds
		deliverErr = d.deliverArchive(ctx, s, rows)
	case "snowflake_shareback":
		// snowflake-shareback (SIEM/Sink, P2): zero-copy data share into
		// the customer's Snowflake account via a signed reverse-pull from
		// the Moosewave-owned S3 OCSF archive. See snowflake_shareback.go.
		deliverErr = d.deliverSnowflakeShareback(ctx, s, rows, creds)
	case "otlp_logs":
		// snowflake-shareback (SIEM/Sink, P2): OTLP Logs over HTTP/JSON
		// to a user-configured collector endpoint. See otlp_logs.go.
		deliverErr = d.deliverOTLPLogs(ctx, s, rows, creds)
	default:
		observability.AuditSinkDeliveriesTotal.WithLabelValues(s.Kind, "failure").Inc()
		return fmt.Errorf("unknown sink kind %q", s.Kind)
	}
	observability.AuditSinkDeliveryLatency.WithLabelValues(s.Kind).Observe(time.Since(start).Seconds())
	if deliverErr != nil {
		observability.AuditSinkDeliveriesTotal.WithLabelValues(s.Kind, "failure").Inc()
	} else {
		observability.AuditSinkDeliveriesTotal.WithLabelValues(s.Kind, "success").Inc()
	}
	return deliverErr
}

// decryptCreds decodes the JSON credentials blob via the platform
// cipher.
func (d *Deps) decryptCreds(ctx context.Context, s Sink) (map[string]string, error) {
	if len(s.CredentialsEnvelope) == 0 {
		return map[string]string{}, nil
	}
	if d.Cipher == nil {
		return nil, errors.New("auditsink: cipher unconfigured")
	}
	pt, err := d.Cipher.Decrypt(ctx, s.CredentialsEnvelope, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]string
	if err := json.Unmarshal(pt, &out); err != nil {
		return nil, fmt.Errorf("creds decode: %w", err)
	}
	return out, nil
}

// --- Datadog: Logs API. Endpoint:
//
//	POST https://http-intake.logs.<site>/api/v2/logs
//	Header: DD-API-KEY: <api_key>
//	Body: array of log JSON objects.
//
// Site is taken from creds (e.g. "datadoghq.com", "datadoghq.eu").
func (d *Deps) deliverDatadog(ctx context.Context, s Sink, rows []AuditRow, creds map[string]string) error {
	apiKey := creds["api_key"]
	if apiKey == "" {
		return errors.New("datadog: api_key missing")
	}
	// `site` is non-secret and stored in `config`. Tolerate legacy
	// sinks where it landed under credentials so an old DB row keeps
	// working.
	site, _ := s.Config["site"].(string)
	if site == "" {
		site = creds["site"]
	}
	if site == "" {
		site = "datadoghq.com"
	}
	payloads := rowPayloads(s, rows)
	logs := make([]map[string]any, 0, len(rows))
	for i, r := range rows {
		entry := map[string]any{
			"ddsource":  "postwave",
			"ddtags":    fmt.Sprintf("tenant:%s,action:%s,format:%s", r.TenantID, r.Action, formatLabel(s)),
			"hostname":  "postwave-api",
			"service":   "postwave-audit",
			"message":   fmt.Sprintf("%s by %s", r.Action, r.UserID),
			"timestamp": r.At.UnixMilli(),
		}
		if s.OutputFormat == FormatOCSF18 {
			for k, v := range payloads[i] {
				if _, dup := entry[k]; dup {
					continue
				}
				entry[k] = v
			}
		} else {
			entry["audit"] = r
		}
		logs = append(logs, entry)
	}
	body, _ := json.Marshal(logs)
	url := fmt.Sprintf("https://http-intake.logs.%s/api/v2/logs", site)
	return d.postJSON(ctx, url, map[string]string{
		"Content-Type": "application/json",
		"DD-API-KEY":   apiKey,
	}, body)
}

// --- Splunk HEC: POST to <hec_url> with Authorization: Splunk <token>.
// Body is one JSON object per line; we wrap each row in Splunk's
// `event` envelope.
func (d *Deps) deliverSplunk(ctx context.Context, s Sink, rows []AuditRow, creds map[string]string) error {
	token := creds["token"]
	// `hec_url` and `index` are non-secret → config. Legacy fallback
	// preserved so old rows that stashed these in credentials still ship.
	hecURL, _ := s.Config["hec_url"].(string)
	if hecURL == "" {
		hecURL = creds["hec_url"]
	}
	index, _ := s.Config["index"].(string)
	if index == "" {
		index = creds["index"]
	}
	if token == "" || hecURL == "" {
		return errors.New("splunk: token and hec_url required")
	}
	payloads := rowPayloads(s, rows)
	var buf bytes.Buffer
	sourcetype := "postwave:audit"
	if s.OutputFormat == FormatOCSF18 {
		sourcetype = "postwave:audit:ocsf"
	}
	for i, r := range rows {
		evt := map[string]any{
			"sourcetype": sourcetype,
			"source":     "postwave-api",
			"index":      index,
			"time":       r.At.Unix(),
			"event":      payloads[i],
		}
		line, _ := json.Marshal(evt)
		buf.Write(line)
		buf.WriteByte('\n')
	}
	return d.postJSON(ctx, hecURL, map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Splunk " + token,
	}, buf.Bytes())
}

// --- S3: PUT object to bucket/<prefix>/<tenant>/<batch-first-id>.jsonl.
//
// Uses S3 REST signed via AWS SigV4. To avoid pulling aws-sdk-go-v2
// into apps/api here, we implement the canonical AWS4 PUT signer
// inline below.
func (d *Deps) deliverS3(ctx context.Context, s Sink, rows []AuditRow, creds map[string]string) error {
	// bucket/region/prefix are non-secret → config. Access key + secret
	// are credentials. Legacy fallback preserved (see datadog/splunk).
	bucket, _ := s.Config["bucket"].(string)
	if bucket == "" {
		bucket = creds["bucket"]
	}
	region, _ := s.Config["region"].(string)
	if region == "" {
		region = creds["region"]
	}
	prefix, _ := s.Config["prefix"].(string)
	if prefix == "" {
		prefix = creds["prefix"]
	}
	access := creds["aws_access_key_id"]
	secret := creds["aws_secret_access_key"]
	if bucket == "" || region == "" || access == "" || secret == "" {
		return errors.New("s3: bucket, region, aws_access_key_id, aws_secret_access_key required")
	}
	payloads := rowPayloads(s, rows)
	var buf bytes.Buffer
	for _, p := range payloads {
		line, _ := json.Marshal(p)
		buf.Write(line)
		buf.WriteByte('\n')
	}
	key := strings.TrimPrefix(prefix, "/")
	if key != "" && !strings.HasSuffix(key, "/") {
		key += "/"
	}
	suffix := "jsonl"
	if s.OutputFormat == FormatOCSF18 {
		suffix = "ocsf.jsonl"
	}
	key += fmt.Sprintf("%s/%d-%d.%s", s.TenantID, rows[0].ID, rows[len(rows)-1].ID, suffix)
	return s3PutObject(ctx, d.httpClient(), region, bucket, key, access, secret, buf.Bytes())
}

// --- Generic HTTP: POST batch as JSON to the configured URL.
//
// Two signature shapes, selected via audit_sinks.webhook_format:
//
//   - postwave_v1 (default, legacy):
//     Authorization: Bearer <bearer_token>            (when set)
//     X-Postwave-Signature: sha256=<hex(hmac(hmac_secret, body))>
//     (when hmac_secret set)
//
//   - standard_webhooks (RFC 9499 / standardwebhooks.com):
//     webhook-id:        <first row's stable event_id>
//     webhook-timestamp: <unix seconds, now>
//     webhook-signature: v1,<base64(hmac_sha256(active_key,
//     webhook_id "." timestamp "." body))>
//     Idempotency-Key:   <webhook-id>                 (extra hint)
//     The active signing key is loaded from audit_sink_signing_keys
//     (most recent non-revoked row); if no key exists, the worker
//     bootstraps one on the fly so the first delivery still goes out.
func (d *Deps) deliverHTTP(ctx context.Context, s Sink, rows []AuditRow, creds map[string]string) error {
	urlV, _ := s.Config["url"].(string)
	if urlV == "" {
		return errors.New("http: config.url required")
	}
	payloads := rowPayloads(s, rows)
	body, _ := json.Marshal(map[string]any{
		"sink":   s.Name,
		"format": formatLabel(s),
		"rows":   payloads,
	})
	headers := map[string]string{"Content-Type": "application/json"}
	if tok := creds["bearer_token"]; tok != "" {
		headers["Authorization"] = "Bearer " + tok
	}

	switch s.WebhookFormat {
	case WebhookFormatStandardWebhook:
		// Standard Webhooks shape. Idempotency key = first row's
		// derived event_id so the receiver can dedupe replays.
		eventID := ""
		if len(rows) > 0 {
			eventID = rows[0].EventID
		}
		if eventID == "" {
			// Shouldn't happen (loadBatch backfills), but be defensive.
			eventID = DeriveEventID(s.TenantID, s.Name, "audit_batch", s.ID, "auditsink", time.Now())
		}
		secret, kid, err := d.activeSigningKey(ctx, s)
		if err != nil {
			return fmt.Errorf("signing key: %w", err)
		}
		now := time.Now()
		headers["webhook-id"] = eventID
		headers["webhook-timestamp"] = fmt.Sprintf("%d", now.Unix())
		headers["webhook-signature"] = SignatureV1(secret, eventID, now, body)
		// Surface the kid so receivers verifying against the JWKS know
		// which key to use during rotation. Not part of the RFC, but
		// standardwebhooks.com SDKs commonly accept multi-version keys
		// keyed by id — this is the hook for that.
		headers["webhook-key-id"] = kid
		headers["Idempotency-Key"] = eventID
	default:
		// postwave_v1 (or empty / unknown → legacy for back-compat).
		if secret := creds["hmac_secret"]; secret != "" {
			headers["X-Postwave-Signature"] = LegacySignatureV1([]byte(secret), body)
		}
		if len(rows) > 0 && rows[0].EventID != "" {
			// Even legacy callers benefit from a stable idempotency
			// hint; receivers that don't recognise the header just
			// ignore it.
			headers["Idempotency-Key"] = rows[0].EventID
		}
	}
	return d.postJSON(ctx, urlV, headers, body)
}

// postJSON is a tiny helper. Any non-2xx response returns a status-only
// error so the caller increments consecutive_failures without persisting an
// upstream-controlled response body.
func (d *Deps) postJSON(ctx context.Context, url string, headers map[string]string, body []byte) error {
	if err := validateAuditSinkDestination(url); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return errAuditSinkDestination
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := d.httpClient().Do(req)
	if err != nil {
		if errors.Is(err, errAuditSinkRedirect) {
			return errAuditSinkRedirect
		}
		// net/http errors can embed the URL and resolver/dial details. Test
		// endpoints are customer-facing, so retain the detail only inside
		// the canonical transport and expose a stable, non-oracular error.
		return errors.New("audit sink request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		// Never copy the upstream response body into an error. The same
		// error feeds API responses, structured logs, breaker state, and the
		// DLQ; including the body made all of those a 4 KiB response oracle.
		return fmt.Errorf("audit sink destination returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// updateCursor stamps audit_sinks.config.cursor = newCursor.
func (d *Deps) updateCursor(ctx context.Context, s Sink, newCursor int64) error {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE audit_sinks
   SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{cursor}', to_jsonb($2::bigint), true),
       updated_at = now()
 WHERE id::text = $1`, s.ID, newCursor)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (d *Deps) recordSuccess(ctx context.Context, s Sink) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audit_sinks
   SET last_success_at = now(),
       consecutive_failures = 0,
       last_failure_reason = NULL
	 WHERE id::text = $1`, s.ID); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

func (d *Deps) recordFailure(ctx context.Context, s Sink, statusCode int, err error) {
	tx, cerr := db.WithWorkerScope(ctx, d.Pool)
	if cerr != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	msg := err.Error()
	if len(msg) > 4096 {
		msg = msg[:4096]
	}
	if _, execErr := tx.Exec(ctx, `
UPDATE audit_sinks
   SET last_failure_at = now(),
       last_failure_reason = $2,
       consecutive_failures = consecutive_failures + 1,
       enabled = (consecutive_failures + 1 < $3)
	 WHERE id::text = $1`, s.ID, msg, d.AutoDisableAfter); execErr != nil {
		return
	}
	if _, execErr := tx.Exec(ctx, `
INSERT INTO audit_sink_failures (tenant_id, sink_id, status_code, error)
VALUES ($1::uuid, $2::uuid, NULLIF($3, 0), $4)`,
		s.TenantID, s.ID, statusCode, msg); execErr != nil {
		return
	}
	_ = tx.Commit(ctx)
}
