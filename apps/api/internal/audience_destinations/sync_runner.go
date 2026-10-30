// SPDX-License-Identifier: AGPL-3.0-only
//
// sync_runner.go — executes one audience sync: resolve the source
// list/segment members, serialize rows (email, status, tags, consent),
// and deliver them in HMAC-signed batches to the destination webhook.
//
// v1 execution model (documented per the A13 scope decision): the run
// is SYNCHRONOUS and BOUNDED — POST /{id}/run executes inline under a
// hard deadline + row/batch caps instead of going through an async job
// queue. The audience_sync_runs ledger row is written first
// ('running') and closed at the end ('succeeded'/'failed'), so the UI
// history stays honest even when the process dies mid-run (the row
// stays 'running' with no finished_at).
//
// Signature convention reuses outbound_webhooks verbatim:
//
//	X-Postwave-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256(secret, "<t>." + body)>
//
// so a receiver already verifying Moosewave outbound webhooks can use
// the exact same code path.
package audience_destinations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

const (
	// SyncMaxRows caps how many members one run exports. Runs over the
	// cap succeed and report rows_exported == SyncMaxRows; the error
	// column carries a truncation note so the operator knows.
	SyncMaxRows = 50_000
	// SyncBatchSize is the number of rows per delivery POST.
	SyncBatchSize = 500
	// SyncRunTimeout is the hard wall-clock bound on one run (resolve
	// + all deliveries). Run-now executes inline in the HTTP handler,
	// so this also bounds the request.
	SyncRunTimeout = 60 * time.Second
)

// SignatureHeader / EventHeader are the delivery headers. Signature
// format matches outbound_webhooks.SignBody.
const (
	SyncSignatureHeader = "X-Postwave-Signature"
	SyncEventHeader     = "X-Postwave-Event"
	SyncBatchIDHeader   = "X-Postwave-Batch-Id"
	SyncEventType       = "audience.sync.batch"
)

// SyncBatchPayload is the JSON body POSTed to the destination, once
// per batch.
type SyncBatchPayload struct {
	Type       string      `json:"type"` // always "audience.sync.batch"
	SyncID     string      `json:"sync_id"`
	SyncName   string      `json:"sync_name"`
	RunID      string      `json:"run_id"`
	BatchID    string      `json:"batch_id"`
	Sequence   int         `json:"sequence"`    // 1-based batch index
	BatchCount int         `json:"batch_count"` // total batches in this run
	RowCount   int         `json:"row_count"`
	Truncated  bool        `json:"truncated,omitempty"` // true when SyncMaxRows hit
	SentAt     time.Time   `json:"sent_at"`
	Rows       []MemberRow `json:"rows"`
}

// SyncRunner executes audience syncs against webhook destinations.
type SyncRunner struct {
	Repo *Repo
	// Firewall (feature #2) gates members on per-purpose consent +
	// suppression before any row leaves. Nil = ungated (degraded mode).
	Firewall       *activation_firewall.Filter
	ReceiptStore   activation_firewall.Store
	ReceiptSignKey string
	// HTTPClient should be the SSRF-safe outbound-webhooks client in
	// production (outbound_webhooks.NewSecureHTTPClient).
	HTTPClient *http.Client
	Logger     *slog.Logger
	// Adapters routes non-webhook destination types (meta / google_ads /
	// tiktok / linkedin / snap) to their platform adapter (SUB-113). Nil
	// is tolerated: a non-webhook destination then fails the run with a
	// clear "adapter not registered" message.
	Adapters AdapterRegistry
	// CredentialResolver hydrates a stored credential_ref into the adapter's
	// secret fields (access_token, developer_token, ...) before delivery. Nil
	// leaves reference-only configs at the credential_resolution_required gate.
	CredentialResolver AudienceCredentialResolver
	// now is swappable in tests; defaults to time.Now.
	now func() time.Time
	// verifySourceFn is swappable in tests; defaults to
	// (*SyncRunner).verifySourceExists.
	verifySourceFn func(ctx context.Context, tenantID string, s *Sync) error
	// resolveMembersFn is a focused test seam for pre-effect safety assertions.
	resolveMembersFn func(ctx context.Context, tenantID string, s *Sync) ([]MemberRow, bool, error)
}

func (sr *SyncRunner) clock() time.Time {
	if sr.now != nil {
		return sr.now()
	}
	return time.Now()
}

// Run executes the sync synchronously and returns the closed ledger
// row. Errors during execution are recorded on the run (status
// 'failed' + error text); only infrastructure errors that prevent the
// ledger itself from being written are returned as Go errors.
func (sr *SyncRunner) Run(ctx context.Context, tenantID, syncID string) (*SyncRun, error) {
	return sr.RunIdempotent(ctx, tenantID, syncID, "")
}

// RunIdempotent executes a manual operation. A repeated caller key observes
// the original run row and never repeats its external effects.
func (sr *SyncRunner) RunIdempotent(ctx context.Context, tenantID, syncID, callerKey string) (*SyncRun, error) {
	return sr.RunIdempotentIfCurrent(ctx, tenantID, syncID, callerKey, "")
}

// RunIdempotentIfCurrent begins a new manual run only when ifMatchToken still
// identifies the locked sync row. A retry with the same idempotency key replays
// its existing run even after the first attempt advanced updated_at.
func (sr *SyncRunner) RunIdempotentIfCurrent(ctx context.Context, tenantID, syncID, callerKey, ifMatchToken string) (*SyncRun, error) {
	return sr.runClaimed(ctx, tenantID, syncID, manualOperationKey(callerKey), operationTriggerManual, "", false, false, ifMatchToken)
}

// RunScheduled executes a scheduler-preclaimed operation. operationKey and
// leaseOwner come from the atomic SKIP LOCKED claim.
func (sr *SyncRunner) RunScheduled(ctx context.Context, tenantID, syncID, operationKey, leaseOwner string, recovered bool) (*SyncRun, error) {
	return sr.runClaimed(ctx, tenantID, syncID, operationKey, operationTriggerScheduled, leaseOwner, true, recovered, "")
}

func (sr *SyncRunner) runClaimed(ctx context.Context, tenantID, syncID, operationKey, trigger, leaseOwner string, preclaimed, recovered bool, ifMatchToken string) (*SyncRun, error) {
	claim, err := sr.Repo.beginSyncOperationIfCurrent(ctx, tenantID, syncID, operationKey, trigger, leaseOwner, preclaimed, recovered, ifMatchToken)
	if err != nil {
		return nil, err
	}
	if !claim.Created {
		return claim.Run, nil
	}

	runCtx, cancel := context.WithTimeout(ctx, SyncRunTimeout)
	defer cancel()

	result, runErr := sr.execute(runCtx, tenantID, claim.Sync, claim.Run.ID)
	status := runTerminalStatus(result, runErr)
	errMsg := ""
	if runErr != nil {
		errMsg = runErr.Error()
	}
	// Close the ledger with the parent ctx (the run deadline may have
	// fired) — fall back to Background so a cancelled request can't
	// leave the row stuck on 'running'.
	finishCtx := ctx
	if finishCtx.Err() != nil {
		var c context.CancelFunc
		finishCtx, c = context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
	}
	finished, err := sr.Repo.finishSyncOperationForTenant(finishCtx, tenantID, claim, status, result, errMsg)
	if err != nil {
		return nil, err
	}
	return finished, nil
}

func runTerminalStatus(result syncExecutionResult, runErr error) string {
	if runErr == nil {
		return RunStatusSucceeded
	}
	if errors.Is(runErr, ErrAudienceCapExceeded) {
		return RunStatusRejected
	}
	if result.RowsExported > 0 || result.BatchesSent > 0 {
		return RunStatusPartial
	}
	if result.ExternalEffectAttempted {
		return RunStatusNeedsReconciliation
	}
	return RunStatusFailed
}

// execute resolves members and delivers batches. Returns rows + batches
// actually delivered.
func (sr *SyncRunner) execute(ctx context.Context, tenantID string, s *Sync, runID string) (syncExecutionResult, error) {
	destType := strings.ToLower(strings.TrimSpace(s.Destination.Type))
	isWebhook := destType == "" || destType == DestinationTypeWebhook
	if isWebhook {
		if s.secret == "" {
			return syncExecutionResult{}, errors.New("destination secret missing — edit the sync and set a secret")
		}
	} else {
		// Platform destination (SUB-113): must have a registered adapter.
		if sr.Adapters == nil || sr.Adapters[destType] == nil {
			return syncExecutionResult{}, fmt.Errorf("destination type %q not supported", s.Destination.Type)
		}
	}
	// Ghost-source guard: a deleted list/segment makes the member JOIN
	// yield zero rows, which used to record a 'succeeded' run with
	// rows_exported=0 — silently masking a broken scheduled sync. Verify
	// the source still exists and fail the run loudly when it doesn't.
	verify := sr.verifySourceFn
	if verify == nil {
		verify = sr.verifySourceExists
	}
	if err := verify(ctx, tenantID, s); err != nil {
		return syncExecutionResult{}, err
	}
	resolve := sr.resolveMembersFn
	if resolve == nil {
		resolve = sr.resolveMembers
	}
	members, truncated, err := resolve(ctx, tenantID, s)
	if err != nil {
		return syncExecutionResult{}, err
	}
	resultBase := syncExecutionResult{SourceMembersObserved: len(members)}
	if truncated {
		// Resolver reads max+1 specifically so this is an honest lower bound.
		// Reject before consent lookup, provider calls, or webhook delivery;
		// a bounded full-snapshot operation must never silently become partial.
		resultBase.SourceMembersObserved = SyncMaxRows + 1
		resultBase.CapExceeded = true
		return resultBase, fmt.Errorf("%w: source has at least %d members; maximum is %d", ErrAudienceCapExceeded, SyncMaxRows+1, SyncMaxRows)
	}

	// Consent-safe activation firewall (feature #2): withhold members that
	// lack the required per-purpose consent or are suppressed, BEFORE any
	// row leaves for the destination. Fail-DENY on consent-lookup error.
	if sr.Firewall != nil {
		purpose := activation_firewall.ResolvePurpose(s.Destination.Type, s.RequiredConsentPurpose)
		emails := make([]string, 0, len(members))
		for _, m := range members {
			emails = append(emails, m.Email)
		}
		dec := sr.Firewall.Decide(ctx, tenantID, purpose, s.Destination.Type, emails)
		if len(dec.Excluded) > 0 {
			keptSet := make(map[string]struct{}, len(dec.Kept))
			for _, e := range dec.Kept {
				keptSet[e] = struct{}{}
			}
			filtered := members[:0]
			for _, m := range members {
				if _, ok := keptSet[strings.ToLower(strings.TrimSpace(m.Email))]; ok {
					filtered = append(filtered, m)
				}
			}
			members = filtered
			if sr.ReceiptStore != nil {
				if _, werr := sr.ReceiptStore.WriteExclusions(ctx, tenantID, runID, activation_firewall.RunTypeAudienceSync, dec.Excluded, sr.ReceiptSignKey); werr != nil && sr.Logger != nil {
					sr.Logger.Warn("audience_sync: failed to persist exclusion receipts", "tenant_id", tenantID, "run_id", runID, "err", werr.Error())
				}
				_ = sr.Repo.setRunExcludedCount(ctx, tenantID, runID, len(dec.Excluded))
			}
		}
	}

	// Platform destination (SUB-113): hand the consent-filtered members to
	// the provider's Custom-Audience adapter instead of POSTing a webhook.
	if !isWebhook {
		adapter := sr.Adapters[destType]
		// Read the destination Config (SUB-113 gap #4) — the unmasked
		// platform settings (audience id, account id, credential ref) the
		// adapter needs. AdapterConfig() returns rawConfig (DB-loaded,
		// unmasked) and falls back to the wire Config for in-memory Syncs.
		hydrated, err := hydrateAdapterConfig(ctx, sr.CredentialResolver, s.AdapterConfig())
		if err != nil {
			return syncExecutionResult{}, fmt.Errorf("%s sync: %w", destType, err)
		}
		plan := operationAttemptPlan{
			Sequence:       1,
			Kind:           "provider_operation",
			IdempotencyKey: runID + ":provider:1",
			PayloadSHA256:  membersPayloadSHA256(members),
			RowCount:       len(members),
		}
		if err := sr.Repo.planRunAttempts(ctx, tenantID, runID, []operationAttemptPlan{plan}); err != nil {
			return resultBase, fmt.Errorf("persist provider operation plan: %w", err)
		}
		if err := sr.Repo.markRunAttemptDelivering(ctx, tenantID, runID, 1); err != nil {
			return resultBase, fmt.Errorf("claim provider operation attempt: %w", err)
		}
		res, err := adapter.Sync(ctx, hydrated, members)
		result := syncExecutionResult{
			RowsExported:            res.MembersSent,
			BatchesSent:             platformAdapterBatchesSent(res),
			SourceMembersObserved:   resultBase.SourceMembersObserved,
			ExternalEffectAttempted: len(members) > 0,
			DiagnosticsSchedule: providerDiagnosticsScheduleContext{
				Provider: destType,
				Config:   s.AdapterConfig(),
			},
			Evidence: ProviderRunEvidence{
				ExternalJobID:      res.ExternalJobID,
				ExternalAudienceID: res.ExternalAudienceID,
				ProviderMessage:    res.Message,
			},
		}
		if err != nil {
			_ = sr.Repo.finishRunAttempt(ctx, tenantID, runID, 1, false, err.Error())
			return result, fmt.Errorf("%s sync: %w", destType, err)
		}
		if err := sr.Repo.finishRunAttempt(ctx, tenantID, runID, 1, true, ""); err != nil {
			return result, fmt.Errorf("persist provider acknowledgement: %w", err)
		}
		return result, nil
	}

	batches := chunkRows(members, SyncBatchSize)
	payloads := make([]SyncBatchPayload, 0, len(batches))
	plans := make([]operationAttemptPlan, 0, len(batches))
	sentAt := sr.clock().UTC()
	for i, batch := range batches {
		batchID := fmt.Sprintf("%s:webhook:%d", runID, i+1)
		payload := SyncBatchPayload{
			Type:       SyncEventType,
			SyncID:     s.ID,
			SyncName:   s.Name,
			RunID:      runID,
			BatchID:    batchID,
			Sequence:   i + 1,
			BatchCount: len(batches),
			RowCount:   len(batch),
			SentAt:     sentAt,
			Rows:       batch,
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			return resultBase, fmt.Errorf("encode batch plan: %w", err)
		}
		payloads = append(payloads, payload)
		plans = append(plans, operationAttemptPlan{
			Sequence:       i + 1,
			Kind:           "webhook_batch",
			IdempotencyKey: batchID,
			PayloadSHA256:  payloadSHA256(raw),
			RowCount:       len(batch),
		})
	}
	if err := sr.Repo.planRunAttempts(ctx, tenantID, runID, plans); err != nil {
		return resultBase, fmt.Errorf("persist webhook batch plan: %w", err)
	}
	delivered := 0
	rows := 0
	for i, payload := range payloads {
		if err := sr.Repo.markRunAttemptDelivering(ctx, tenantID, runID, i+1); err != nil {
			return syncExecutionResult{RowsExported: rows, BatchesSent: delivered, SourceMembersObserved: resultBase.SourceMembersObserved}, fmt.Errorf("claim batch %d/%d: %w", i+1, len(batches), err)
		}
		if err := sr.deliverBatch(ctx, s, payload); err != nil {
			_ = sr.Repo.finishRunAttempt(ctx, tenantID, runID, i+1, false, err.Error())
			return syncExecutionResult{RowsExported: rows, BatchesSent: delivered, SourceMembersObserved: resultBase.SourceMembersObserved, ExternalEffectAttempted: true}, fmt.Errorf("batch %d/%d: %w", i+1, len(batches), err)
		}
		if err := sr.Repo.finishRunAttempt(ctx, tenantID, runID, i+1, true, ""); err != nil {
			return syncExecutionResult{RowsExported: rows + payload.RowCount, BatchesSent: delivered + 1, SourceMembersObserved: resultBase.SourceMembersObserved, ExternalEffectAttempted: true}, fmt.Errorf("persist batch %d/%d acknowledgement: %w", i+1, len(batches), err)
		}
		delivered++
		rows += payload.RowCount
	}
	return syncExecutionResult{RowsExported: rows, BatchesSent: delivered, SourceMembersObserved: resultBase.SourceMembersObserved, ExternalEffectAttempted: delivered > 0}, nil
}

func platformAdapterBatchesSent(res PlatformSyncResult) int {
	if res.BatchesSent > 0 {
		return res.BatchesSent
	}
	if res.MembersSent > 0 {
		return 1
	}
	return 0
}

type syncExecutionResult struct {
	RowsExported            int
	BatchesSent             int
	SourceMembersObserved   int
	CapExceeded             bool
	ExternalEffectAttempted bool
	Evidence                ProviderRunEvidence
	DiagnosticsSchedule     providerDiagnosticsScheduleContext
}

// deliverBatch signs + POSTs one batch and enforces a 2xx response.
func (sr *SyncRunner) deliverBatch(ctx context.Context, s *Sync, payload SyncBatchPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode payload: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.Destination.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Moosewave-AudienceSync/1.0")
	req.Header.Set(SyncEventHeader, SyncEventType)
	req.Header.Set(SyncSignatureHeader, outbound_webhooks.SignBody(s.secret, sr.clock(), body))
	if payload.BatchID != "" {
		req.Header.Set(SyncBatchIDHeader, payload.BatchID)
		req.Header.Set("Idempotency-Key", payload.BatchID)
	}

	client := sr.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("deliver: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	// Drain a bounded amount so keep-alive connections can be reused.
	_, _ = io.CopyN(io.Discard, resp.Body, 4<<10)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("receiver returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// ResolveSourceMembers loads members for a raw list/segment id pair
// (exactly one set). Used by the consent-exclusion preview for the older
// audience_destinations table, which carries list_id/segment_id directly
// rather than a *Sync. Returns members, truncated, error.
func (sr *SyncRunner) ResolveSourceMembers(ctx context.Context, tenantID string, listID, segmentID *string) ([]MemberRow, bool, error) {
	s := &Sync{Source: SyncSource{ListID: listID, SegmentID: segmentID}}
	return sr.resolveMembers(ctx, tenantID, s)
}

// resolveMembers loads up to SyncMaxRows member rows for the sync's
// source. The second return is true when the cap was hit.
func (sr *SyncRunner) resolveMembers(ctx context.Context, tenantID string, s *Sync) ([]MemberRow, bool, error) {
	switch {
	case s.Source.ListID != nil && *s.Source.ListID != "":
		return sr.listMembers(ctx, tenantID, *s.Source.ListID)
	case s.Source.SegmentID != nil && *s.Source.SegmentID != "":
		return sr.segmentMembers(ctx, tenantID, *s.Source.SegmentID)
	}
	return nil, false, errors.New("sync has no source — set list_id or segment_id")
}

// verifySourceExists confirms the sync's source list/segment still
// exists before any members are resolved (see the ghost-source guard in
// execute).
//
//   - Segment: a segments row for the tenant. Deleting a segment removes
//     the row, so a stale sync fails with a clear error instead of
//     exporting nothing.
//   - List: lists are Listmonk-engine rows; every list the gateway ever
//     issued is recorded in list_id_map at create time (lists/id_map.go)
//     and sync sources resolve through that map (resolveListRef). The
//     map row survives a list delete, so existence = "the map entry's
//     bigint id still has a lists row". A uuid with no map entry never
//     pointed at a live list either way — both cases fail the run.
func (sr *SyncRunner) verifySourceExists(ctx context.Context, tenantID string, s *Sync) error {
	tx, err := db.WithTenant(ctx, sr.Repo.Pool, tenantID)
	if err != nil {
		return err
	}
	// Read-only — the deferred rollback is the close path.
	defer func() { _ = tx.Rollback(ctx) }()
	switch {
	case s.Source.ListID != nil && *s.Source.ListID != "":
		var exists bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM list_id_map m
      JOIN lists l
        ON l.tenant_id = m.tenant_id
       AND l.id = m.listmonk_bigint_id
     WHERE m.tenant_id = $1::uuid
       AND m.postwave_uuid = $2::uuid)`,
			tenantID, *s.Source.ListID).Scan(&exists); err != nil {
			return fmt.Errorf("verify source list: %w", err)
		}
		if !exists {
			return fmt.Errorf("source list no longer exists (list %s) — point the sync at a new source or delete it", *s.Source.ListID)
		}
	case s.Source.SegmentID != nil && *s.Source.SegmentID != "":
		var exists bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM segments
     WHERE tenant_id = $1::uuid AND id = $2::uuid)`,
			tenantID, *s.Source.SegmentID).Scan(&exists); err != nil {
			return fmt.Errorf("verify source segment: %w", err)
		}
		if !exists {
			return fmt.Errorf("source segment no longer exists (segment %s) — point the sync at a new source or delete it", *s.Source.SegmentID)
		}
	}
	return nil
}

// listMembers walks the local list_subscribers join (migration 0222).
func (sr *SyncRunner) listMembers(ctx context.Context, tenantID, listID string) ([]MemberRow, bool, error) {
	tx, err := db.WithTenant(ctx, sr.Repo.Pool, tenantID)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT s.email::text, s.status, s.tags, s.consent_source, s.consent_timestamp
  FROM list_subscribers ls
  JOIN subscribers s ON s.id = ls.subscriber_id
 WHERE ls.tenant_id = $1::uuid
   AND ls.list_id = $2::uuid
   AND ls.removed_at IS NULL
 ORDER BY s.email ASC
 LIMIT $3`, tenantID, listID, SyncMaxRows+1)
	if err != nil {
		return nil, false, fmt.Errorf("resolve list members: %w", err)
	}
	out, truncated, err := scanMemberRows(rows)
	if err != nil {
		return nil, false, err
	}
	return out, truncated, tx.Commit(ctx)
}

// segmentMembers evaluates the persisted definition live through the canonical
// resolver-aware population contract. Destination sync is an explicit export;
// serving a potentially stale materialized cache would be worse than failing
// the bounded run and retrying.
func (sr *SyncRunner) segmentMembers(ctx context.Context, tenantID, segmentID string) ([]MemberRow, bool, error) {
	tx, err := db.WithTenant(ctx, sr.Repo.Pool, tenantID)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ast json.RawMessage
	err = tx.QueryRow(ctx, `
SELECT query_ast FROM segments
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, segmentID).Scan(&ast)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, fmt.Errorf("load segment: %w", err)
	}
	predicate, err := segments.CompilePopulation(
		ctx,
		ast,
		tenantID,
		segments.TransactionSegmentResolver{Queryer: tx},
		segments.DefinitionPopulation(false),
	)
	if err != nil {
		return nil, false, fmt.Errorf("compile segment: %w", err)
	}
	args := append(predicate.Args, SyncMaxRows+1)
	q := `
SELECT email::text, status, tags, consent_source, consent_timestamp
  FROM subscribers
 WHERE ` + predicate.SQL + `
 ORDER BY email ASC
 LIMIT $` + strconv.Itoa(len(args))
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, false, fmt.Errorf("resolve segment members: %w", err)
	}
	out, truncated, err := scanMemberRows(rows)
	if err != nil {
		return nil, false, err
	}
	return out, truncated, tx.Commit(ctx)
}

// scanMemberRows drains a (email, status, tags, consent_source,
// consent_timestamp) cursor into MemberRows. Reads up to
// SyncMaxRows+1 rows and reports truncation.
func scanMemberRows(rows pgx.Rows) ([]MemberRow, bool, error) {
	defer rows.Close()
	out := make([]MemberRow, 0, 256)
	for rows.Next() {
		var m MemberRow
		var tags []string
		var consentAt *time.Time
		if err := rows.Scan(&m.Email, &m.Status, &tags, &m.ConsentSource, &consentAt); err != nil {
			return nil, false, fmt.Errorf("scan member: %w", err)
		}
		if tags == nil {
			tags = []string{}
		}
		m.Tags = tags
		if consentAt != nil {
			ts := consentAt.UTC().Format(time.RFC3339)
			m.ConsentTimestamp = &ts
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(out) > SyncMaxRows {
		return out[:SyncMaxRows], true, nil
	}
	return out, false, nil
}

// chunkRows splits rows into batches of at most size. Empty input
// yields zero batches (a run over an empty audience succeeds with
// rows_exported = 0 and no deliveries — honest, not a fake ping).
func chunkRows(rows []MemberRow, size int) [][]MemberRow {
	if size <= 0 {
		size = SyncBatchSize
	}
	var out [][]MemberRow
	for start := 0; start < len(rows); start += size {
		end := start + size
		if end > len(rows) {
			end = len(rows)
		}
		out = append(out, rows[start:end])
	}
	return out
}

// resolveListRef accepts either a Moosewave uuid (returned as-is) or a
// Listmonk bigint id (resolved via list_id_map — same semantics as
// lists.Repo.resolveListUUID). Used at create/update time so the
// desktop picker can pass whichever id the lists API returned.
func (r *Repo) resolveListRef(ctx context.Context, tenantID, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	bigintID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		// Not numeric — treat as uuid; downstream cast rejects garbage.
		return raw, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got string
	err = tx.QueryRow(ctx, `
SELECT postwave_uuid::text FROM list_id_map
 WHERE tenant_id = $1::uuid AND listmonk_bigint_id = $2`, tenantID, bigintID).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("%w: list %s has no Moosewave mapping — re-sync lists first", ErrInvalidInput, raw)
	}
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return got, nil
}
