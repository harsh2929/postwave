// SPDX-License-Identifier: AGPL-3.0-only

package transactional

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned by Get when no row matches.
var ErrNotFound = errors.New("transactional: not found")

// Repo persists transactional_emails rows.
type Repo struct {
	Pool *db.Pool
}

// Record is one transactional_emails row.
type Record struct {
	ID                string     `json:"id"`
	From              string     `json:"from"`
	To                []string   `json:"to"`
	Subject           string     `json:"subject"`
	Status            string     `json:"status"`
	ScheduledAt       *time.Time `json:"scheduled_at,omitempty"`
	ProviderMessageID string     `json:"provider_message_id,omitempty"`
	LastError         string     `json:"last_error,omitempty"`
	Source            string     `json:"source"`
	SuppressedCount   int        `json:"suppressed"`
	CreatedAt         time.Time  `json:"created_at"`
	SentAt            *time.Time `json:"sent_at,omitempty"`
	// AttemptState / ExternalEffect separate "what this process attempted" from
	// "what we believe reached the outside world". `unknown` is the honest
	// answer for a transport failure: the provider may have accepted the
	// message and no receipt exists to say. Exposed because an escalation
	// nobody can query is a log line, not an escalation.
	AttemptState   string `json:"attempt_state,omitempty"`
	ExternalEffect string `json:"external_effect,omitempty"`

	// Outcomes is what happened AT THE RECIPIENT, one entry per (recipient,
	// outcome). Empty until the provider tells us something.
	//
	// Separate from Status on purpose. Status describes our submission and
	// stops at `sent`; it cannot describe a mailbox, and reusing it to do so is
	// how `sent` came to be read as `delivered`. Keeping both lets the API say
	// "we sent it AND it bounced", which is the true and useful answer.
	//
	// Per recipient because `to` is a list: a bounce concerns one address, and
	// a single message-level verdict would either slander the addresses that
	// worked or hide the one that did not.
	Outcomes []Outcome `json:"outcomes,omitempty"`
}

// Outcome is one recipient-level fact about a message.
type Outcome struct {
	Recipient  string    `json:"recipient"`
	Outcome    string    `json:"outcome"`
	Reason     string    `json:"reason,omitempty"`
	ESP        string    `json:"esp,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
}

// InsertInput is the row to create.
type InsertInput struct {
	From              string
	To                []string
	Subject           string
	Status            string
	ScheduledAt       *time.Time
	Source            string
	SuppressedCount   int
	ProviderMessageID string
	// Payload is the full SendRequest JSON — set ONLY for scheduled sends so
	// the worker can dispatch later. Empty/nil for immediate sends.
	Payload json.RawMessage
	// AttemptState / ExternalEffect record what the provider did. Empty means
	// `prepared` / `none` — the column defaults — which is correct for a
	// scheduled row that has not been dispatched yet.
	AttemptState   string
	ExternalEffect string
}

// ClaimIntent reserves a send BEFORE the provider is called, and reports
// whether this caller owns it.
//
// The old order was dispatch-then-insert ("dispatch first, then record the
// outcome — one write"), which is one write and two failure modes: mail
// delivered with no ledger row when the insert failed, and a `sending` row that
// the worker re-dispatched ten minutes later. Claiming first costs a second
// write and removes both.
//
// `owned=false` means another request already claimed this intent — a client
// retry, or a concurrent replica. The caller returns the existing id and does
// NOT call the provider. The uniqueness is a partial unique index rather than a
// read-then-write check here, because two replicas would both pass a SELECT
// before either INSERTed.
//
// A reused key carrying different content returns ErrIntentConflict: answering
// it with the first message's id would silently drop the second, which is worse
// than refusing.
func (r *Repo) ClaimIntent(ctx context.Context, tenantID string, in InsertInput, intentKey, requestHash string) (id string, owned bool, err error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	payload := in.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	var (
		existingHash *string
		inserted     bool
	)
	// DO UPDATE, not DO NOTHING.
	//
	// DO NOTHING plus a UNION ALL fallback SELECT loses the race it exists to
	// handle: the loser's INSERT yields no row, and its SELECT reads a snapshot
	// taken before the winner committed, so it finds nothing either and the
	// whole statement returns no rows. A concurrency test caught exactly that.
	//
	// A no-op DO UPDATE always returns the row AND takes a row lock, so the
	// loser blocks until the winner commits and then reads the committed value.
	// `xmax = 0` is the standard way to tell an inserted row from an updated
	// one in RETURNING: a freshly inserted tuple has no updating transaction.
	err = tx.QueryRow(ctx, `
INSERT INTO transactional_emails
  (tenant_id, from_addr, to_addrs, subject, status, scheduled_at, source,
   suppressed_count, payload, intent_key, request_hash, attempt_state, external_effect)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 0, $8::jsonb, $9, $10, 'prepared', 'none')
ON CONFLICT (tenant_id, intent_key) WHERE intent_key IS NOT NULL
DO UPDATE SET updated_at = transactional_emails.updated_at
RETURNING id::text, request_hash, (xmax = 0) AS inserted`,
		tenantID, in.From, in.To, in.Subject, in.Status, in.ScheduledAt, in.Source,
		string(payload), intentKey, requestHash,
	).Scan(&id, &existingHash, &inserted)
	if err != nil {
		return "", false, err
	}
	// Nullable: a row written by Repo.Insert (the scheduled or unclaimed path)
	// carries no request_hash, and scanning NULL into a string would 500 — which
	// makes the idempotency middleware drop its claim.
	if !inserted && existingHash != nil && *existingHash != "" && *existingHash != requestHash {
		return id, false, ErrIntentConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return id, inserted, nil
}

// SettleIntent records what the provider actually did.
//
// `attemptState` and `externalEffect` are separate because "we failed to record
// it" and "it did not happen" are different facts. Conflating them is what let
// the worker re-send a message SES had already accepted.
func (r *Repo) SettleIntent(ctx context.Context, tenantID, id, attemptState, externalEffect, status, providerMessageID, lastError string, suppressed int) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE transactional_emails
   SET attempt_state = $3,
       external_effect = $4,
       status = $5,
       provider_message_id = NULLIF($6,''),
       last_error = NULLIF($7,''),
       suppressed_count = $8,
       sent_at = CASE WHEN $5 = 'sent' THEN now() ELSE sent_at END,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id, attemptState, externalEffect, status,
		strings.TrimSpace(providerMessageID), lastError, suppressed); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Insert creates a row and returns its id.
func (r *Repo) Insert(ctx context.Context, tenantID string, in InsertInput) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	payload := in.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	status := in.Status
	if status == "" {
		status = "queued"
	}
	source := in.Source
	if source == "" {
		source = "api"
	}
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO transactional_emails
  (tenant_id, from_addr, to_addrs, subject, status, scheduled_at, source, suppressed_count, payload,
   provider_message_id, sent_at, attempt_state, external_effect)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NULLIF($10,''),
   CASE WHEN $5 = 'sent' THEN now() ELSE NULL END,
   COALESCE(NULLIF($11,''), 'prepared'), COALESCE(NULLIF($12,''), 'none'))
RETURNING id::text`,
		tenantID, in.From, in.To, in.Subject, status, in.ScheduledAt, source, in.SuppressedCount, string(payload),
		strings.TrimSpace(in.ProviderMessageID), in.AttemptState, in.ExternalEffect,
	).Scan(&id)
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// Get returns one row for the tenant.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Record, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rec, err := scanRecord(tx.QueryRow(ctx, `
SELECT id::text, from_addr, to_addrs, subject, status, scheduled_at,
       COALESCE(provider_message_id,''), COALESCE(last_error,''), source,
       suppressed_count, created_at, sent_at, attempt_state, external_effect
  FROM transactional_emails
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	// Read in the SAME transaction as the record. Two reads could otherwise
	// straddle a bounce arriving, and the response would show a message with no
	// outcomes beside a status that had already moved — a snapshot of a moment
	// that never existed.
	outcomes, err := recipientOutcomes(ctx, tx, tenantID, rec.ID)
	if err != nil {
		return nil, err
	}
	rec.Outcomes = outcomes
	return rec, tx.Commit(ctx)
}

// recipientOutcomes returns what the provider reported about each recipient.
//
// Ordered oldest-first: "delivered, then complained" is a sequence, and a
// caller rendering it in arrival order should not have to sort.
func recipientOutcomes(ctx context.Context, tx pgx.Tx, tenantID, emailID string) ([]Outcome, error) {
	rows, err := tx.Query(ctx, `
SELECT recipient, outcome, reason, esp, occurred_at
  FROM transactional_email_outcomes
 WHERE tenant_id = $1::uuid AND email_id = $2::uuid
 ORDER BY occurred_at ASC, recipient ASC`, tenantID, emailID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Outcome
	for rows.Next() {
		var o Outcome
		if err := rows.Scan(&o.Recipient, &o.Outcome, &o.Reason, &o.ESP, &o.OccurredAt); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ListRecent returns the tenant's most recent sends (activity feed).
func (r *Repo) ListRecent(ctx context.Context, tenantID string, limit int, attemptState string) ([]Record, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, from_addr, to_addrs, subject, status, scheduled_at,
       COALESCE(provider_message_id,''), COALESCE(last_error,''), source,
       suppressed_count, created_at, sent_at, attempt_state, external_effect
  FROM transactional_emails
 WHERE tenant_id = $1::uuid
   -- The attempt_state query parameter narrows to a lifecycle state. The one
   -- that matters is unknown: a send whose provider outcome was not established,
   -- a human must reconcile because neither retrying nor discarding is safe.
   AND ($3 = '' OR attempt_state = $3)
 ORDER BY created_at DESC
 LIMIT $2`, tenantID, limit, attemptState)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		rec, err := scanRecordRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// MarkSent stamps a row sent + records the provider message id.
//
// BOTH of these statements used to bind $1 (the tenant) without referencing it,
// which Postgres rejects outright: "could not determine data type of parameter
// $1" (42P18). Every call failed, and every call site discarded the error with
// `_ =`. The consequence was not cosmetic — a scheduled row never left
// `status='sending'`, so ClaimDue re-claimed it every ten minutes and the
// message was delivered again, and again, forever. An adversarial review
// reproduced four deliveries in four ticks.
//
// `attempt_state` is settled here too: a terminal status with a `prepared`
// attempt is exactly the combination the claim predicate treats as retryable.
func (r *Repo) MarkSent(ctx context.Context, tenantID, id, providerMsgID string) error {
	return r.update(ctx, tenantID, `
UPDATE transactional_emails
   SET status='sent', provider_message_id=NULLIF($3,''), sent_at=now(),
       last_error=NULL, attempt_state='submitted', external_effect='full',
       updated_at=now()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id, providerMsgID)
}

// MarkFailed stamps a row failed + records the error. See MarkSent for why the
// tenant predicate and attempt_state are load-bearing rather than tidy.
func (r *Repo) MarkFailed(ctx context.Context, tenantID, id, errMsg string) error {
	return r.update(ctx, tenantID, `
UPDATE transactional_emails
   SET status='failed', last_error=$3, attempt_state='rejected',
       external_effect='none', updated_at=now()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id, truncate(errMsg, 1000))
}

// MarkUnknown records a dispatch whose outcome cannot be established.
//
// Distinct from MarkFailed on purpose: the provider may have accepted the
// message. The row is terminal for the worker — never re-dispatched — and is
// surfaced instead, because guessing either way is a duplicate send or a lost
// one.
func (r *Repo) MarkUnknown(ctx context.Context, tenantID, id, errMsg string) error {
	return r.update(ctx, tenantID, `
UPDATE transactional_emails
   SET status='sending', last_error=$3, attempt_state='unknown',
       external_effect='unknown', updated_at=now()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id, truncate(errMsg, 1000))
}

// IntentOutcome is what a PREVIOUS attempt on this intent achieved.
type IntentOutcome struct {
	Status         string
	AttemptState   string
	ExternalEffect string
	LastError      string
}

// Retryable reports whether re-dispatching is safe.
//
// Only a DECIDED failure qualifies: `rejected` with no external effect means
// the attempt concluded without reaching the provider, so trying again cannot
// duplicate anything. That is what makes a transient throttle recoverable
// instead of permanently swallowing a password reset.
//
// `prepared` is deliberately NOT retryable, and this is the subtle one: for a
// concurrent caller it means the winner has claimed the row and is dispatching
// right now. Treating it as retryable made six concurrent sends produce three
// provider calls — the exact duplicate the claim exists to prevent,
// reintroduced through the replay path. A genuinely stranded `prepared` row is
// recovered by the worker's claim predicate, not by a racing caller.
//
// `submitted` and `unknown` are never retryable: the first definitely reached
// the provider, the second may have and no receipt exists to say.
func (o IntentOutcome) Retryable() bool {
	return o.AttemptState == "rejected" && o.ExternalEffect == "none"
}

// IntentOutcome reads a claimed row's recorded outcome.
func (r *Repo) IntentOutcome(ctx context.Context, tenantID, id string) (IntentOutcome, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return IntentOutcome{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out IntentOutcome
	var lastError *string
	if err := tx.QueryRow(ctx, `
SELECT status, attempt_state, external_effect, last_error
  FROM transactional_emails
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id,
	).Scan(&out.Status, &out.AttemptState, &out.ExternalEffect, &lastError); err != nil {
		return IntentOutcome{}, err
	}
	if lastError != nil {
		out.LastError = *lastError
	}
	return out, nil
}

func (r *Repo) update(ctx context.Context, tenantID, sql string, args ...any) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DueRow is a scheduled row claimed for dispatch.
type DueRow struct {
	ID       string
	TenantID string
	Payload  json.RawMessage
}

// ClaimDue flips up to `limit` due scheduled rows to 'sending' (cross-tenant,
// worker scope) and returns them with their payloads. SKIP LOCKED so two
// workers never claim the same row.
func (r *Repo) ClaimDue(ctx context.Context, now time.Time, limit int) ([]DueRow, error) {
	if limit <= 0 {
		limit = 100
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Claim due rows that PROVABLY never reached the provider.
	//
	// This used to also re-claim anything stuck in `status='sending'` for ten
	// minutes, on the reasoning that a worker had crashed mid-dispatch. But
	// `sending` cannot distinguish "we never called SES" from "SES accepted it
	// and we stopped before writing the result" — so the ten-minute rule
	// re-sent real mail to real people. The old comment said as much: "Re-
	// dispatch is at-least-once; the 10-min guard makes a genuine double-send
	// unlikely." Unlikely is not a property.
	//
	// `attempt_state` carries the distinction the status column cannot.
	// `prepared` means the provider call has not been made, and is the only
	// state safe to claim. `submitted`, `rejected` and `unknown` are terminal
	// for this worker; an `unknown` row is surfaced for a human rather than
	// guessed at, because no receipt exists to say what the provider did.
	rows, err := tx.Query(ctx, `
UPDATE transactional_emails
   SET status='sending', updated_at=now()
 WHERE id IN (
   SELECT id FROM transactional_emails
    WHERE attempt_state = 'prepared'
      AND (
        (status='scheduled' AND scheduled_at <= $1)
        OR (status='sending' AND updated_at < $1 - interval '10 minutes')
      )
    ORDER BY scheduled_at ASC NULLS FIRST
    FOR UPDATE SKIP LOCKED
    LIMIT $2
 )
RETURNING id::text, tenant_id::text, payload`, now, limit)
	if err != nil {
		return nil, err
	}
	out := []DueRow{}
	for rows.Next() {
		var d DueRow
		var payload []byte
		if err := rows.Scan(&d.ID, &d.TenantID, &payload); err != nil {
			rows.Close()
			return nil, err
		}
		d.Payload = payload
		out = append(out, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func scanRecord(row pgx.Row) (*Record, error) {
	var rec Record
	if err := row.Scan(&rec.ID, &rec.From, &rec.To, &rec.Subject, &rec.Status, &rec.ScheduledAt,
		&rec.ProviderMessageID, &rec.LastError, &rec.Source, &rec.SuppressedCount, &rec.CreatedAt, &rec.SentAt,
		&rec.AttemptState, &rec.ExternalEffect); err != nil {
		return nil, err
	}
	return &rec, nil
}

func scanRecordRows(rows pgx.Rows) (*Record, error) {
	var rec Record
	if err := rows.Scan(&rec.ID, &rec.From, &rec.To, &rec.Subject, &rec.Status, &rec.ScheduledAt,
		&rec.ProviderMessageID, &rec.LastError, &rec.Source, &rec.SuppressedCount, &rec.CreatedAt, &rec.SentAt,
		&rec.AttemptState, &rec.ExternalEffect); err != nil {
		return nil, err
	}
	return &rec, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// SendingIdentityVerifier is the production FromVerifier: a domain is allowed
// when the tenant has a verify_state='verified' sending_identities row for it.
// Mirrors the campaigns compliance gate (anti cross-tenant From-spoofing on the
// shared SES account).
type SendingIdentityVerifier struct {
	Pool *db.Pool
}

func (v *SendingIdentityVerifier) IsFromDomainVerified(ctx context.Context, tenantID, domain string) (bool, error) {
	tx, err := db.WithTenant(ctx, v.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ok bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM sending_identities
   WHERE tenant_id = $1::uuid AND verify_state = 'verified' AND lower(domain) = $2
)`, tenantID, domain).Scan(&ok); err != nil {
		return false, err
	}
	return ok, tx.Commit(ctx)
}

// ClaimSMTPDedup reserves a message dedup key for the tenant. Returns isNew=true
// when this message has not been seen within the window (so it should be sent);
// isNew=false means a duplicate (retry of an already-accepted message) → skip.
// An expired prior entry (older than windowSecs) is refreshed and treated as new.
func (r *Repo) ClaimSMTPDedup(ctx context.Context, tenantID, key string, windowSecs int) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var inserted bool
	err = tx.QueryRow(ctx, `
INSERT INTO transactional_smtp_dedup (tenant_id, dedup_key)
VALUES ($1::uuid, $2)
ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET seen_at = now()
  WHERE transactional_smtp_dedup.seen_at < now() - make_interval(secs => $3)
RETURNING (xmax = 0)`, tenantID, key, windowSecs).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		// Row exists and is NOT expired → genuine duplicate.
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	// Fresh insert (inserted=true) or an expired row refreshed (inserted=false):
	// either way this message should be sent.
	return true, tx.Commit(ctx)
}

// ReleaseSMTPDedup removes a claimed key so a retry can re-send. Call it only
// for pre-provider failures or a definite transient provider refusal. An
// ambiguous transport outcome must retain the claim to prevent a duplicate.
func (r *Repo) ReleaseSMTPDedup(ctx context.Context, tenantID, key string) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM transactional_smtp_dedup WHERE tenant_id=$1::uuid AND dedup_key=$2`, tenantID, key); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

// CleanupSMTPDedup deletes dedup rows older than windowSecs (cross-tenant,
// worker scope). Run periodically so the table stays small.
func (r *Repo) CleanupSMTPDedup(ctx context.Context, windowSecs int) error {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM transactional_smtp_dedup WHERE seen_at < now() - make_interval(secs => $1)`, windowSecs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
