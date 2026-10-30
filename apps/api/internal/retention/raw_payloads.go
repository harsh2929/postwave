// Package retention owns low-frequency data minimization jobs that are not
// tied to one feature package. These jobs keep operational evidence while
// trimming raw provider payloads, anonymous telemetry, expired delivery
// records, and stale unsubscribed-subscriber rows after their useful
// support window.
//
// The package was originally a single-purpose RawPayloadSweeper (only
// scrubbed bounce_events.raw / complaint_events.raw jsonb). It was
// consolidated in 2026-06 into a single Sweeper type that fans out
// to per-class sweep_*.go siblings — one tx per (tenant, class) so a
// stuck table can't block any other.
package retention

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	DefaultRawPayloadInterval = 24 * time.Hour
	DefaultWebVitalsDays      = 90
	DefaultStripeAttemptDays  = 30
	MinEmailEventDays         = 30
	// workerNoTenantID keeps older RLS predicates that cast app.tenant_id
	// directly to uuid safe on a recycled connection. PostgreSQL can retain an
	// empty custom-GUC placeholder after SET LOCAL rolls back; binding a valid
	// no-tenant sentinel prevents those legacy casts from aborting discovery.
	// Worker-visible tables still require their command-specific worker policy.
	workerNoTenantID = "00000000-0000-0000-0000-000000000000"
	// DefaultBatchSize bounds how many rows the per-tenant deletes
	// remove per tx so we don't take long-lived locks on a hot table.
	DefaultBatchSize = 1000
	// DefaultMaxBatchesPerTenant caps work per class per tick at
	// (DefaultBatchSize * DefaultMaxBatchesPerTenant) rows.
	DefaultMaxBatchesPerTenant = 64
)

// PrivacyReader is the per-tenant retention-window source the Sweeper
// reads to size each class's cutoff. PrivacyRepo satisfies all of
// these methods; tests pass in a stub.
type PrivacyReader interface {
	EmailEventRetentionDays(ctx context.Context, tenantID string) (int, error)
	UnsubscribedSubscriberRetentionDays(ctx context.Context, tenantID string) (int, error)
	EngagementEventRetentionDays(ctx context.Context, tenantID string) (int, error)
	InboundEmailRetentionDays(ctx context.Context, tenantID string) (int, error)
	WebhookDeliveryRetentionDays(ctx context.Context, tenantID string) (int, error)
	FormSubmissionRetentionDays(ctx context.Context, tenantID string) (int, error)
	ExportGraceDays(ctx context.Context, tenantID string) (int, error)
}

// EmailEventRetentionReader is the historical narrow surface the old
// RawPayloadSweeper consumed. Kept as a separate alias so callers
// that only have the audit-side reader can still wire the legacy
// sweeper paths.
type EmailEventRetentionReader interface {
	EmailEventRetentionDays(ctx context.Context, tenantID string) (int, error)
}

// Sweeper is the consolidated retention worker. Construct with a Pool
// + PrivacyReader and call Run in a goroutine. All per-class sweeps
// are best-effort: one class's failure is logged and surfaced via
// metrics but never fails the iteration.
type Sweeper struct {
	Pool                   *pgxpool.Pool
	Privacy                PrivacyReader
	Interval               time.Duration
	WebVitalsDays          int
	StripeWebhookRetryDays int
	BatchSize              int
	MaxBatchesPerTenant    int
	Logger                 *slog.Logger
	// ExportStore is the dedicated private export store. LegacyExportStore is
	// the former asset/CDN sink and exists only to revoke pre-migration bundles.
	// A row with an object key is never unlinked unless the corresponding store
	// confirms deletion; missing storage configuration fails closed and retries.
	ExportStore       ExportObjectStore
	LegacyExportStore ExportObjectStore
}

// logWarn writes a sweeper-side warning via the configured logger or
// the package default; centralised so sweeps can emit consistent
// structured warnings without nil-checking the logger themselves.
func (s *Sweeper) logWarn(msg string, args ...any) {
	s.logger().Warn(msg, args...)
}

// RawPayloadSweeper is the original name; preserved as an alias so
// existing wire-ups in main.go and tests keep compiling. New code
// should reference Sweeper directly.
type RawPayloadSweeper = Sweeper

func (s *Sweeper) Run(ctx context.Context) {
	if s == nil || s.Pool == nil {
		return
	}
	logger := s.logger()
	logger.Info("retention sweeper: starting",
		"interval", s.interval(),
		"web_vitals_days", s.webVitalsDays(),
		"stripe_retry_days", s.stripeRetryDays(),
	)
	if err := s.sweepOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Warn("retention sweeper: first sweep failed", "err", err.Error())
	}
	ticker := time.NewTicker(s.interval())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("retention sweeper: context cancelled, exiting")
			return
		case <-ticker.C:
			if err := s.sweepOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("retention sweeper: sweep failed", "err", err.Error())
			}
		}
	}
}

// sweepOnce is the per-tick fan-out: one global pass, then one pass
// per (tenant, class) tuple. SweepOnceForTenant is exposed so the
// admin POST /api/v1/retention/run handler can trigger an
// out-of-band sweep for the calling tenant.
func (s *Sweeper) sweepOnce(ctx context.Context) error {
	if err := s.sweepGlobal(ctx); err != nil {
		iterationsTotal.WithLabelValues("global", "error").Inc()
		return err
	}
	iterationsTotal.WithLabelValues("global", "ok").Inc()
	tenants, err := s.listTenants(ctx)
	if err != nil {
		return err
	}
	for _, tenantID := range tenants {
		if err := ctx.Err(); err != nil {
			return err
		}
		_, _ = s.SweepOnceForTenant(ctx, tenantID)
	}
	return nil
}

// SweepOnceForTenant runs every per-class sweep for one tenant and
// returns a class -> rows-purged map. Errors per class are logged +
// counted via iterationsTotal but never bubble out: a stuck table
// shouldn't deny the rest of the tenant.
func (s *Sweeper) SweepOnceForTenant(ctx context.Context, tenantID string) (map[string]int64, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("retention sweeper: nil pool")
	}
	if tenantID == "" {
		return nil, errors.New("retention sweeper: tenantID required")
	}
	out := map[string]int64{}
	logger := s.logger()

	// 1) raw provider payload jsonb scrub (legacy)
	days := s.tenantEmailEventDays(ctx, tenantID)
	if err := s.sweepTenantProviderPayloads(ctx, tenantID, days); err != nil {
		iterationsTotal.WithLabelValues("raw_payloads", "error").Inc()
		logger.Warn("retention sweeper: raw payload scrub failed",
			"tenant_id", tenantID, "err", err.Error())
	} else {
		iterationsTotal.WithLabelValues("raw_payloads", "ok").Inc()
	}

	// 2..N: the new class sweeps. Each helper is in sweep_*.go and
	// returns (rows_affected, error).
	type sweep struct {
		class string
		fn    func() (int64, error)
	}
	sweeps := []sweep{
		{"subscriber_send_log", func() (int64, error) {
			d, err := s.sendingIdentityRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepSubscriberSendLog(ctx, tenantID, d)
		}},
		{"intelligent_retry_events", func() (int64, error) {
			d, err := s.sendingIdentityRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepIntelligentRetryEvents(ctx, tenantID, d)
		}},
		{"unsubscribed_subscribers", func() (int64, error) {
			d, err := s.Privacy.UnsubscribedSubscriberRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepUnsubscribedSubscribers(ctx, tenantID, d)
		}},
		{"inbound_email_bodies", func() (int64, error) {
			d, err := s.Privacy.InboundEmailRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepInboundEmailBodies(ctx, tenantID, d)
		}},
		{"outbound_webhook_deliveries", func() (int64, error) {
			d, err := s.Privacy.WebhookDeliveryRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepOutboundWebhookDeliveries(ctx, tenantID, d)
		}},
		{"outbound_webhook_playground_fires", func() (int64, error) {
			d, err := s.Privacy.WebhookDeliveryRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepOutboundWebhookPlaygroundFires(ctx, tenantID, d)
		}},
		{"outbound_webhook_event_receipts", func() (int64, error) {
			d, err := s.Privacy.WebhookDeliveryRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepOutboundWebhookEventReceipts(ctx, tenantID, d)
		}},
		{"outbound_webhook_operator_notifications", func() (int64, error) {
			d, err := s.Privacy.WebhookDeliveryRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepOutboundWebhookOperatorNotifications(ctx, tenantID, d)
		}},
		{"deleted_outbound_webhook_endpoints", func() (int64, error) {
			d, err := s.Privacy.WebhookDeliveryRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepDeletedOutboundWebhookEndpoints(ctx, tenantID, d)
		}},
		{"inbound_webhook_deliveries", func() (int64, error) {
			d, err := s.Privacy.WebhookDeliveryRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepInboundWebhookDeliveries(ctx, tenantID, d)
		}},
		{"inbound_webhook_events", func() (int64, error) {
			d, err := s.Privacy.WebhookDeliveryRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepInboundWebhookEvents(ctx, tenantID, d)
		}},
		{"deleted_inbound_webhook_endpoints", func() (int64, error) {
			d, err := s.Privacy.WebhookDeliveryRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepDeletedInboundWebhookEndpoints(ctx, tenantID, d)
		}},
		{"form_submissions", func() (int64, error) {
			d, err := s.Privacy.FormSubmissionRetentionDays(ctx, tenantID)
			if err != nil {
				return 0, err
			}
			return s.sweepFormSubmissions(ctx, tenantID, d)
		}},
		{"tenant_exports", func() (int64, error) {
			// tenant_exports.expires_at is the canonical deadline from
			// export_retention_policy. Adding the separate privacy grace value
			// would retain bundles beyond the policy the workspace reviewed.
			return s.sweepExpiredExports(ctx, tenantID, 0)
		}},
		{"subscriber_duplicate_scans", func() (int64, error) {
			return s.sweepExpiredSubscriberDuplicateScans(ctx, tenantID)
		}},
		// SUB-049: time-bounded suppressions auto-unblock — delete rows
		// whose own expires_at has fired. No retention-day setting: the
		// cutoff is the row's expires_at < now().
		{"expired_suppressions", func() (int64, error) {
			return s.sweepExpiredSuppressions(ctx, tenantID)
		}},
		// Unfinished editor drafts. No retention-day setting: the cutoff is the
		// owning package's SweepAge, because a half-written subject line is a
		// convenience with a short life rather than a record a tenant would
		// choose a policy for.
		{"editor_checkpoints", func() (int64, error) {
			return s.sweepEditorCheckpoints(ctx, tenantID)
		}},
	}
	for _, sw := range sweeps {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		n, err := sw.fn()
		if err != nil {
			iterationsTotal.WithLabelValues(sw.class, "error").Inc()
			logger.Warn("retention sweeper: class failed",
				"class", sw.class, "tenant_id", tenantID, "err", err.Error())
			continue
		}
		iterationsTotal.WithLabelValues(sw.class, "ok").Inc()
		out[sw.class] = n
		if n > 0 {
			rowsPurgedTotal.WithLabelValues(tenantID, sw.class).Add(float64(n))
			logger.Info("retention sweeper: rows purged",
				"class", sw.class, "tenant_id", tenantID, "rows", n)
		}
	}
	return out, nil
}

func (s *Sweeper) tenantEmailEventDays(ctx context.Context, tenantID string) int {
	days := 365
	if s.Privacy != nil {
		if value, err := s.Privacy.EmailEventRetentionDays(ctx, tenantID); err == nil && value > 0 {
			days = value
		}
	}
	if days < MinEmailEventDays {
		days = MinEmailEventDays
	}
	return days
}

func (s *Sweeper) sweepGlobal(ctx context.Context) error {
	if _, err := s.Pool.Exec(ctx,
		`DELETE FROM web_vitals_events WHERE at < now() - ($1::int * interval '1 day')`,
		s.webVitalsDays()); err != nil {
		return fmt.Errorf("retention sweeper: web vitals: %w", err)
	}
	if _, err := s.Pool.Exec(ctx, `
DELETE FROM stripe_webhook_attempts
 WHERE status IN ('succeeded', 'dead_lettered')
   AND updated_at < now() - ($1::int * interval '1 day')`,
		s.stripeRetryDays()); err != nil {
		return fmt.Errorf("retention sweeper: stripe retries: %w", err)
	}
	return nil
}

// listTenants enumerates tenant_ids visible to the sweeper. Discovery MUST run
// inside a transaction-local worker scope: several source tables use FORCE RLS
// and expose only a narrow SELECT policy to background workers. A bare pool
// query silently sees no rows from those tables, which would leave retained
// payloads untouched forever.
//
// We union over the tables whose rows the sweeper might prune. Using DISTINCT
// per table + UNION (rather than a single big UNION ALL) keeps the result small
// even with multi-million-row tables. The worker policies are deliberately
// SELECT-only; every mutation below re-enters db.WithTenant.
func (s *Sweeper) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, fmt.Errorf("retention sweeper: begin tenant discovery: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.tenant_id', $1, true),
       set_config('app.retention_worker', 'true', true)`, workerNoTenantID); err != nil {
		return nil, fmt.Errorf("retention sweeper: bind tenant-discovery sentinel: %w", err)
	}

	rows, err := tx.Query(ctx, `
SELECT DISTINCT tenant_id::text FROM bounce_events
UNION
SELECT DISTINCT tenant_id::text FROM complaint_events
UNION
SELECT DISTINCT tenant_id::text FROM subscribers
UNION
SELECT DISTINCT tenant_id::text FROM inbound_emails
UNION
SELECT DISTINCT tenant_id::text FROM campaign_replies
UNION
SELECT DISTINCT tenant_id::text FROM outbound_webhook_deliveries
UNION
SELECT DISTINCT tenant_id::text FROM inbound_events
UNION
SELECT DISTINCT tenant_id::text FROM inbound_webhook_endpoints WHERE deleted_at IS NOT NULL
UNION
SELECT DISTINCT tenant_id::text FROM form_submissions
UNION
SELECT DISTINCT tenant_id::text FROM tenant_exports
UNION
SELECT DISTINCT tenant_id::text FROM subscriber_duplicate_scans
UNION
SELECT DISTINCT tenant_id::text FROM email_suppressions WHERE expires_at IS NOT NULL
UNION
SELECT DISTINCT tenant_id::text FROM subscriber_suppressions WHERE expires_at IS NOT NULL
UNION
SELECT DISTINCT tenant_id::text FROM editor_checkpoints
UNION
SELECT DISTINCT tenant_id::text FROM subscriber_send_log
UNION
SELECT DISTINCT tenant_id::text FROM intelligent_retry_events
ORDER BY 1`)
	if err != nil {
		return nil, fmt.Errorf("retention sweeper: list tenants: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Sweeper) sweepTenantProviderPayloads(ctx context.Context, tenantID string, days int) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, table := range []string{"bounce_events", "complaint_events"} {
		if err := clearRawPayload(ctx, tx, table, days); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func clearRawPayload(ctx context.Context, tx pgx.Tx, table string, days int) error {
	if table != "bounce_events" && table != "complaint_events" {
		return fmt.Errorf("unsupported raw payload table %q", table)
	}
	_, err := tx.Exec(ctx, fmt.Sprintf(`
UPDATE %s
   SET raw = '{}'::jsonb
 WHERE raw <> '{}'::jsonb
   AND received_at < now() - ($1::int * interval '1 day')`, table), days)
	return err
}

func (s *Sweeper) interval() time.Duration {
	if s.Interval > 0 {
		return s.Interval
	}
	return DefaultRawPayloadInterval
}

func (s *Sweeper) webVitalsDays() int {
	if s.WebVitalsDays > 0 {
		return s.WebVitalsDays
	}
	return DefaultWebVitalsDays
}

func (s *Sweeper) stripeRetryDays() int {
	if s.StripeWebhookRetryDays > 0 {
		return s.StripeWebhookRetryDays
	}
	return DefaultStripeAttemptDays
}

func (s *Sweeper) batchSize() int {
	if s == nil || s.BatchSize <= 0 {
		return DefaultBatchSize
	}
	return s.BatchSize
}

func (s *Sweeper) maxBatchesPerTenant() int {
	if s == nil || s.MaxBatchesPerTenant <= 0 {
		return DefaultMaxBatchesPerTenant
	}
	return s.MaxBatchesPerTenant
}

func (s *Sweeper) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}
