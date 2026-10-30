// Store is the canonical access point for the new
// subscriber_suppressions table introduced by migration 0081. It lives
// alongside the legacy Repo (which targets the `suppressions` table
// from migration 0060) because the deliverability webhook loop and the
// send-loop filter target the X1 schema while the older admin-list UI
// still reads from the legacy shape.
//
// Why a new table + new Store: the legacy `suppressions` table has no
// provider event id, no source attribution, no expires_at, and no
// metadata bag. Building the bounce+engagement webhook loop on top of
// it would require additive ALTERs that would also have to land on the
// other surface still reading the legacy shape. Cleaner to introduce
// the deliverability-shaped table and migrate readers later.

package suppressions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Reason is the enum-like classification stored on every row. Kept in
// sync with the CHECK constraint in migration 0081.
type Reason string

const (
	ReasonHardBounce          Reason = "hard_bounce"
	ReasonSpamComplaint       Reason = "spam_complaint"
	ReasonManualUnsubscribe   Reason = "manual_unsubscribe"
	ReasonListManual          Reason = "list_manual"
	ReasonGlobalUnsubscribe   Reason = "global_unsubscribe"
	ReasonSoftBounceThreshold Reason = "soft_bounce_threshold"

	// SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy. The CHECK
	// constraint on subscriber_suppressions accepts these from migration
	// 0512 onward; ValidReasons below mirrors that set. The bounce-ingest
	// receivers (webhooks/deliverability*.go) and spam_trap_guard classify
	// provider signals into these buckets.
	ReasonSoftBounce      Reason = "soft_bounce"       // transient delivery failure (single event)
	ReasonComplaint       Reason = "complaint"         // Klaviyo short label for a spam/FBL complaint
	ReasonListUnsubHeader Reason = "list_unsub_header" // RFC 8058 one-click List-Unsubscribe
	ReasonSpamtrap        Reason = "spamtrap"          // known spamtrap / honeypot recipient
	ReasonRoleAccount     Reason = "role_account"      // role address (info@, abuse@, …)
	ReasonDNSFail         Reason = "dns_failure"       // recipient domain has no deliverable MX / NXDOMAIN
	ReasonInvalidAddress  Reason = "invalid_address"   // syntactically/semantically invalid mailbox
)

// Source attributes a suppression to the surface that wrote it.
type Source string

const (
	SourcePostmark   Source = "postmark"
	SourceMailgun    Source = "mailgun"
	SourceSES        Source = "ses"
	SourceSendGrid   Source = "sendgrid"
	SourceResend     Source = "resend"
	SourceSparkPost  Source = "sparkpost"
	SourceMailerSend Source = "mailersend"
	SourceMailchimp  Source = "mailchimp"
	SourceManual     Source = "manual"
	SourceAPI        Source = "api"
	SourceImport     Source = "import"
)

// ValidReasons + ValidSources mirror the migration's CHECK constraints
// so handlers can pre-validate without round-tripping to Postgres.
var ValidReasons = map[Reason]bool{
	ReasonHardBounce:          true,
	ReasonSpamComplaint:       true,
	ReasonManualUnsubscribe:   true,
	ReasonListManual:          true,
	ReasonGlobalUnsubscribe:   true,
	ReasonSoftBounceThreshold: true,
	// Operator-driven categories the CHECK has accepted since 0244 and
	// that NormalizeReason maps to (declared in channel.go). Added here
	// so Store.Add accepts a write through NormalizeReason without a
	// false "invalid reason" rejection.
	ReasonDSARDeletion:  true,
	ReasonRoleAddress:   true,
	ReasonInvalidEmail:  true,
	ReasonBlocklistAuto: true,
	// SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy (CHECK widened
	// in migration 0512).
	ReasonSoftBounce:      true,
	ReasonComplaint:       true,
	ReasonListUnsubHeader: true,
	ReasonSpamtrap:        true,
	ReasonRoleAccount:     true,
	ReasonDNSFail:         true,
	ReasonInvalidAddress:  true,
}

var ValidSources = map[Source]bool{
	SourcePostmark:   true,
	SourceMailgun:    true,
	SourceSES:        true,
	SourceSendGrid:   true,
	SourceResend:     true,
	SourceSparkPost:  true,
	SourceMailerSend: true,
	SourceMailchimp:  true,
	SourceManual:     true,
	SourceAPI:        true,
	SourceImport:     true,
}

// Entry is one row of subscriber_suppressions. Named Entry rather than
// Suppression so it doesn't collide with the legacy `suppressions`
// table type (Suppression in suppressions.go) shipped in the same
// package.
type Entry struct {
	ID            string         `json:"id"`
	TenantID      string         `json:"tenant_id"`
	Email         string         `json:"email"`
	Reason        Reason         `json:"reason"`
	Source        Source         `json:"source"`
	SourceEventID string         `json:"source_event_id,omitempty"`
	CreatedAt     time.Time      `json:"created_at"`
	ExpiresAt     *time.Time     `json:"expires_at,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	// BounceCategory (SUB-048) is the durable raw classification the
	// bounce-ingest receiver derived from provider codes + metadata at
	// ingest time (spamtrap / role_account / dns_failure / …). Survives
	// an operator reclassification of Reason. Empty for manual adds.
	BounceCategory string `json:"bounce_category,omitempty"`
	// Extended fields surfaced by the converger (GAP-LS-007/010).
	Channel         Channel   `json:"channel,omitempty"`
	Scope           Scope     `json:"scope,omitempty"`
	MatchKind       MatchKind `json:"match_kind,omitempty"`
	SourceTable     string    `json:"source_table,omitempty"`
	CampaignID      string    `json:"campaign_id,omitempty"`
	MessageID       string    `json:"message_id,omitempty"`
	BounceCode      string    `json:"bounce_code,omitempty"`
	ProviderEventID string    `json:"provider_event_id,omitempty"`
	// RowVersion is an opaque PostgreSQL MVCC token captured by the admin
	// lookup paths. Destructive operations compare it before deleting so a
	// row that was reclassified or replaced after review is preserved. It is
	// deliberately not part of the wire representation: clients select a
	// suppression, while the server owns the short-lived review snapshot.
	RowVersion string `json:"-"`
}

// legacyMirrorSuppressionIDKey is the server-owned link from a dual-written
// email_suppressions row back to its canonical subscriber_suppressions row.
// Removal may delete a legacy row only when this explicit identity link is
// present and matches the canonical row that was actually deleted. Email,
// reason, source, and provider-event similarity are not strong enough proof:
// each can legitimately identify an independent or newer suppression.
const legacyMirrorSuppressionIDKey = "subscriber_suppression_id"

func linkedLegacyMetadata(metadata map[string]any, suppressionID string) map[string]any {
	linked := make(map[string]any, len(metadata)+1)
	for key, value := range metadata {
		linked[key] = value
	}
	// Always overwrite a caller-provided value. The link is an integrity
	// field, not user metadata.
	linked[legacyMirrorSuppressionIDKey] = suppressionID
	return linked
}

// IsActive reports whether the suppression is still in force at t.
// expires_at IS NULL means permanent; otherwise the row is active
// while t < expires_at.
func (s *Entry) IsActive(t time.Time) bool {
	if s == nil {
		return false
	}
	if s.ExpiresAt == nil {
		return true
	}
	return t.Before(*s.ExpiresAt)
}

// SoftBounceThreshold + SoftBounceWindow are the auto-suppression
// trigger: if a subscriber accumulates >= SoftBounceThreshold soft
// bounces within SoftBounceWindow, the webhook receiver auto-creates
// a `soft_bounce_threshold` suppression that expires after
// SoftBounceSuppressionDuration. Constants here so tests + receivers
// share one source of truth.
const (
	SoftBounceThreshold           = 5
	SoftBounceWindow              = 30 * 24 * time.Hour
	SoftBounceSuppressionDuration = 30 * 24 * time.Hour
)

// Store wraps subscriber_suppressions row CRUD. Distinct from the
// legacy Repo so the Mailchimp-compat handlers and the X1 deliverability
// surface don't accidentally cross-contaminate (different tables,
// different RLS shape, different idempotency story).
type Store struct {
	Pool *db.Pool
}

// Add upserts a suppression row for (tenantID, email). Idempotent on
// (tenant_id, source, source_event_id) so duplicate webhook
// re-deliveries don't churn metadata. When sourceEventID is empty we
// fall back to upserting on (tenant_id, email) — same row but with
// reason/source updated to the latest signal (e.g. spam complaint
// replacing a prior hard bounce).
//
// expiresAt is optional: nil => permanent suppression. Soft-bounce-
// threshold callers pass NOW()+30d so the row rolls off automatically.
func (s *Store) Add(
	ctx context.Context,
	tenantID, email string,
	reason Reason,
	source Source,
	sourceEventID string,
	expiresAt *time.Time,
	metadata map[string]any,
) (*Entry, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("suppressions: nil store")
	}
	if !ValidReasons[reason] {
		return nil, fmt.Errorf("suppressions: invalid reason %q", reason)
	}
	if !ValidSources[source] {
		return nil, fmt.Errorf("suppressions: invalid source %q", source)
	}
	// Channel/scope carry the per-dimension suppression semantics
	// (GAP-LS-005/006, surfaced by GOV-031). They ride in metadata (stashed by
	// AddWithChannel / the admin handler) so this chokepoint can write the
	// columns without every caller changing signature. Empty → the same
	// email/marketing defaults the column CHECK constraints already enforce;
	// an invalid non-empty value is rejected here rather than as a DB 500.
	channel := Channel(metadataString(metadata, "channel"))
	scope := Scope(metadataString(metadata, "scope"))
	if !ValidChannel(channel) {
		return nil, fmt.Errorf("suppressions: invalid channel %q", channel)
	}
	if !ValidScope(scope) {
		return nil, fmt.Errorf("suppressions: invalid scope %q", scope)
	}
	if channel == "" {
		channel = ChannelEmail
	}
	if scope == "" {
		scope = ScopeMarketing
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || !strings.Contains(email, "@") {
		return nil, fmt.Errorf("suppressions: invalid email")
	}
	if metadata == nil {
		metadata = map[string]any{}
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Two idempotency keys protect different surfaces. The send-loop
	// filter only cares about (tenant, email); webhook re-deliveries
	// are deduped on (tenant, source, source_event_id) via the
	// partial unique index from 0081. We try the source-event guard
	// first when source_event_id is present so duplicate webhooks
	// short-circuit BEFORE we hit the (tenant,email) update path.
	if sourceEventID != "" {
		var existingID string
		err := tx.QueryRow(ctx, `
SELECT id::text FROM subscriber_suppressions
WHERE tenant_id = $1::uuid AND source = $2 AND source_event_id = $3`,
			tenantID, string(source), sourceEventID,
		).Scan(&existingID)
		if err == nil {
			out, gerr := fetchByID(ctx, tx, existingID)
			if gerr != nil {
				return nil, gerr
			}
			if cerr := tx.Commit(ctx); cerr != nil {
				return nil, cerr
			}
			return out, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("suppressions: lookup by source_event: %w", err)
		}
	}

	const upsert = `
INSERT INTO subscriber_suppressions
    (tenant_id, email, reason, source, source_event_id, expires_at, metadata,
     channel, scope)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5,''), $6, $7, $8, $9)
ON CONFLICT (tenant_id, email) DO UPDATE SET
    reason          = EXCLUDED.reason,
    source          = EXCLUDED.source,
    source_event_id = COALESCE(EXCLUDED.source_event_id, subscriber_suppressions.source_event_id),
    expires_at      = EXCLUDED.expires_at,
    metadata        = subscriber_suppressions.metadata || EXCLUDED.metadata,
    channel         = EXCLUDED.channel,
    scope           = EXCLUDED.scope
RETURNING id::text, tenant_id::text, email::text, reason, source,
          COALESCE(source_event_id,''), created_at, expires_at, metadata,
          channel, scope, match_kind`

	out := &Entry{}
	var meta []byte
	if err := tx.QueryRow(ctx, upsert,
		tenantID, email, string(reason), string(source), sourceEventID, expiresAt, metadata,
		string(channel), string(scope),
	).Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
		&out.Channel, &out.Scope, &out.MatchKind,
	); err != nil {
		return nil, fmt.Errorf("suppressions: upsert: %w", err)
	}
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	// Converge the legacy Mailchimp-compatible store in the same transaction so
	// every admin/subscriber surface lists and removes the same suppression.
	legacyReason := legacyReasonFor(reason)
	legacyMetadata := linkedLegacyMetadata(metadata, out.ID)
	if _, err := tx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata, expires_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, email, reason) DO UPDATE SET
    source = EXCLUDED.source,
	    metadata = email_suppressions.metadata || EXCLUDED.metadata,
	    expires_at = EXCLUDED.expires_at,
	    suppressed_at = now()`,
		tenantID, email, legacyReason, string(source), legacyMetadata, expiresAt); err != nil {
		return nil, fmt.Errorf("suppressions: mirror legacy store: %w", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET status = 'blocklisted', updated_at = now()
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`, tenantID, email); err != nil {
		return nil, fmt.Errorf("suppressions: mark subscriber blocklisted: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// BulkImportResult mirrors the legacy suppressions.BulkResult wire
// shape (imported / skipped / errors) so the modern bulk-import
// endpoint returns the same envelope the legacy /bulk path always
// returned. `Imported` counts rows newly written; `Skipped` counts
// duplicate-or-invalid rows the import silently dropped; `Errors`
// carries per-row "email: reason" strings for rows that errored at the
// DB layer (rare — usually empty).
type BulkImportResult struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors"`
	// Emails is the de-duplicated, normalised set of addresses that were
	// newly written (RowsAffected > 0). The handler uses it to emit one
	// audit row per imported address without a second round-trip.
	Emails []string `json:"-"`
}

// BulkImport idempotently inserts up to 50k+ addresses into the modern
// subscriber_suppressions table in a single transaction, mirroring the
// legacy suppressions.Repo.BulkAdd signature so callers can move from
// the legacy table (which the send loop never consults) to the X1 table
// (which the send-loop converger reads on every dispatch).
//
// Each row lands with channel/scope defaults applied (email / marketing
// when the caller passes empty), source = import, and the supplied
// reason normalised through NormalizeReason (so legacy labels like
// "manual" fold onto the canonical "manual_unsubscribe"). Idempotency is
// via ON CONFLICT (tenant_id, email) DO NOTHING — re-running the same
// batch increments Skipped, never churns existing rows' reason/source.
//
// Invalid or duplicate-within-batch rows are counted in Skipped and
// never abort the import (partial-success semantics matching the legacy
// path). The whole batch commits atomically.
func (s *Store) BulkImport(
	ctx context.Context,
	tenantID string,
	emails []string,
	reason Reason,
	channel Channel,
	scope Scope,
) (*BulkImportResult, error) {
	out := &BulkImportResult{Errors: []string{}}
	if reason == "" {
		reason = ReasonManualUnsubscribe
	}
	if !ValidReasons[reason] {
		return out, fmt.Errorf("suppressions: invalid reason %q", reason)
	}
	if channel == "" {
		channel = ChannelEmail
	}
	if scope == "" {
		scope = ScopeMarketing
	}
	// Empty batch is a no-op that never touches the pool (mirrors the
	// legacy BulkAdd contract — the handler relies on this for its
	// empty-input fast path).
	if len(emails) == 0 {
		return out, nil
	}
	if s == nil || s.Pool == nil {
		return out, errors.New("suppressions: nil store")
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	seen := make(map[string]struct{}, len(emails))
	for _, raw := range emails {
		email := strings.ToLower(strings.TrimSpace(raw))
		if email == "" || !strings.Contains(email, "@") {
			out.Skipped++
			continue
		}
		if _, dup := seen[email]; dup {
			out.Skipped++
			continue
		}
		seen[email] = struct{}{}
		ct, err := tx.Exec(ctx, `
INSERT INTO subscriber_suppressions
    (tenant_id, email, reason, source, channel, scope)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, email) DO NOTHING`,
			tenantID, email, string(reason), string(SourceImport),
			string(channel), string(scope))
		if err != nil {
			out.Errors = append(out.Errors, email+": "+err.Error())
			continue
		}
		if ct.RowsAffected() == 0 {
			out.Skipped++
			continue
		}
		out.Imported++
		out.Emails = append(out.Emails, email)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// BounceCategory is the durable raw-classification signal (SUB-048).
// It's the bounce-derived subset of the reason taxonomy; ValidBounceCategories
// mirrors the CHECK constraint added in migration 0514.
type BounceCategory string

const (
	CategoryHardBounce     BounceCategory = "hard_bounce"
	CategorySoftBounce     BounceCategory = "soft_bounce"
	CategorySpamtrap       BounceCategory = "spamtrap"
	CategoryRoleAccount    BounceCategory = "role_account"
	CategoryDNSFailure     BounceCategory = "dns_failure"
	CategoryInvalidAddress BounceCategory = "invalid_address"
	CategoryComplaint      BounceCategory = "complaint"
)

// ValidBounceCategories mirrors the CHECK constraint on
// subscriber_suppressions.bounce_category (migration 0514).
var ValidBounceCategories = map[BounceCategory]bool{
	CategoryHardBounce:     true,
	CategorySoftBounce:     true,
	CategorySpamtrap:       true,
	CategoryRoleAccount:    true,
	CategoryDNSFailure:     true,
	CategoryInvalidAddress: true,
	CategoryComplaint:      true,
}

// AddWithCategory is the SUB-048 write path: identical to Add but also
// persists the raw bounce_category classification signal. Used by the
// deliverability webhook receivers and spam_trap_guard so the durable
// categorisation survives a later operator reclassification of `reason`.
//
// category may be empty (degrades to Add semantics: bounce_category
// stays NULL). When non-empty it MUST be a member of
// ValidBounceCategories or the call errors before touching the pool.
func (s *Store) AddWithCategory(
	ctx context.Context,
	tenantID, email string,
	reason Reason,
	source Source,
	sourceEventID string,
	expiresAt *time.Time,
	metadata map[string]any,
	category BounceCategory,
) (*Entry, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("suppressions: nil store")
	}
	if !ValidReasons[reason] {
		return nil, fmt.Errorf("suppressions: invalid reason %q", reason)
	}
	if !ValidSources[source] {
		return nil, fmt.Errorf("suppressions: invalid source %q", source)
	}
	if category != "" && !ValidBounceCategories[category] {
		return nil, fmt.Errorf("suppressions: invalid bounce category %q", category)
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || !strings.Contains(email, "@") {
		return nil, fmt.Errorf("suppressions: invalid email")
	}
	if metadata == nil {
		metadata = map[string]any{}
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Mirror Add's source-event idempotency short-circuit.
	if sourceEventID != "" {
		var existingID string
		err := tx.QueryRow(ctx, `
SELECT id::text FROM subscriber_suppressions
WHERE tenant_id = $1::uuid AND source = $2 AND source_event_id = $3`,
			tenantID, string(source), sourceEventID,
		).Scan(&existingID)
		if err == nil {
			out, gerr := fetchByID(ctx, tx, existingID)
			if gerr != nil {
				return nil, gerr
			}
			if cerr := tx.Commit(ctx); cerr != nil {
				return nil, cerr
			}
			return out, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("suppressions: lookup by source_event: %w", err)
		}
	}

	var catArg any
	if category != "" {
		catArg = string(category)
	}

	const upsert = `
INSERT INTO subscriber_suppressions
    (tenant_id, email, reason, source, source_event_id, expires_at, metadata, bounce_category)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5,''), $6, $7, $8)
ON CONFLICT (tenant_id, email) DO UPDATE SET
    reason          = EXCLUDED.reason,
    source          = EXCLUDED.source,
    source_event_id = COALESCE(EXCLUDED.source_event_id, subscriber_suppressions.source_event_id),
    expires_at      = EXCLUDED.expires_at,
    metadata        = subscriber_suppressions.metadata || EXCLUDED.metadata,
    bounce_category = COALESCE(EXCLUDED.bounce_category, subscriber_suppressions.bounce_category)
RETURNING id::text, tenant_id::text, email::text, reason, source,
          COALESCE(source_event_id,''), created_at, expires_at, metadata,
          COALESCE(bounce_category,'')`

	out := &Entry{}
	var meta []byte
	if err := tx.QueryRow(ctx, upsert,
		tenantID, email, string(reason), string(source), sourceEventID, expiresAt, metadata, catArg,
	).Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta, &out.BounceCategory,
	); err != nil {
		return nil, fmt.Errorf("suppressions: upsert with category: %w", err)
	}
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ErrSuppressionChanged means a reviewed suppression was updated or replaced
// before the compare-and-delete completed. The safe response is to preserve
// the current row and require the operator to refresh and review it again.
var ErrSuppressionChanged = errors.New("suppressions: reviewed row changed; refresh before removing")

// Remove drops the canonical suppression that is current for (tenantID,
// email) when the transaction acquires its row lock. It deletes by primary-key
// identity and removes only legacy rows explicitly linked to that identity.
// It never changes subscribers.status: re-enabling a subscriber is a separate,
// reviewed resubscribe/consent operation.
//
// The admin HTTP path uses RemoveSelected instead because its reversibility
// review occurs before this store call and therefore needs compare-and-delete
// semantics. This lower-level method remains for internal cleanup callers and
// is idempotent when no row exists. Permanent DSAR rows remain a no-op.
func (s *Store) Remove(ctx context.Context, tenantID, email string) error {
	if s == nil || s.Pool == nil {
		return errors.New("suppressions: nil store")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return fmt.Errorf("suppressions: empty email")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	var reason Reason
	err = tx.QueryRow(ctx, `
SELECT id::text, reason
  FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid AND email = $2::citext
 FOR UPDATE`, tenantID, email).Scan(&id, &reason)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return fmt.Errorf("suppressions: select for removal: %w", err)
	}
	if ReversibilityFor(reason) == ReversibilityPermanent {
		return tx.Commit(ctx)
	}
	if err := deleteSuppressionIdentity(ctx, tx, tenantID, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RemoveSelected removes exactly the row represented by selected. The row's
// PostgreSQL version is compared atomically with the DELETE, closing the gap
// between the handler's reversibility review and mutation. A concurrent
// reclassification/upsert is preserved and reported as
// ErrSuppressionChanged. A competing delete is treated as an idempotent no-op.
//
// The bool is true only when this call deleted the reviewed canonical row.
func (s *Store) RemoveSelected(ctx context.Context, tenantID string, selected *Entry) (bool, error) {
	if s == nil || s.Pool == nil {
		return false, errors.New("suppressions: nil store")
	}
	if selected == nil || tenantID == "" || selected.ID == "" || selected.RowVersion == "" {
		return false, fmt.Errorf("suppressions: invalid reviewed row")
	}
	if selected.TenantID != "" && selected.TenantID != tenantID {
		return false, fmt.Errorf("suppressions: reviewed row tenant mismatch")
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var deletedID string
	err = tx.QueryRow(ctx, `
DELETE FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
	AND id = $2::uuid
	AND xmin::text = $3
RETURNING id::text`, tenantID, selected.ID, selected.RowVersion).Scan(&deletedID)
	if errors.Is(err, pgx.ErrNoRows) {
		var currentExists bool
		if qerr := tx.QueryRow(ctx, `
SELECT EXISTS (
	SELECT 1
	  FROM subscriber_suppressions
	 WHERE tenant_id = $1::uuid
	   AND (id = $2::uuid OR email = $3::citext)
)`, tenantID, selected.ID, selected.Email).Scan(&currentExists); qerr != nil {
			return false, fmt.Errorf("suppressions: verify reviewed row: %w", qerr)
		}
		if currentExists {
			return false, ErrSuppressionChanged
		}
		if cerr := tx.Commit(ctx); cerr != nil {
			return false, cerr
		}
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("suppressions: delete reviewed row: %w", err)
	}
	if err := deleteLinkedLegacyRows(ctx, tx, tenantID, deletedID); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func deleteSuppressionIdentity(ctx context.Context, tx pgx.Tx, tenantID, id string) error {
	tag, err := tx.Exec(ctx, `
DELETE FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		return fmt.Errorf("suppressions: delete canonical row: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	return deleteLinkedLegacyRows(ctx, tx, tenantID, id)
}

func deleteLinkedLegacyRows(ctx context.Context, tx pgx.Tx, tenantID, id string) error {
	if _, err := tx.Exec(ctx, `
DELETE FROM email_suppressions
 WHERE tenant_id = $1::uuid
	AND metadata ->> $2 = $3`, tenantID, legacyMirrorSuppressionIDKey, id); err != nil {
		return fmt.Errorf("suppressions: delete linked legacy mirror: %w", err)
	}
	return nil
}

func legacyReasonFor(reason Reason) string {
	switch reason {
	case ReasonHardBounce:
		return "hard_bounce"
	case ReasonSpamComplaint, ReasonComplaint:
		return "complaint"
	case ReasonSoftBounce, ReasonSoftBounceThreshold:
		return "soft_bounce"
	case ReasonListUnsubHeader:
		return "list_unsub_header"
	case ReasonSpamtrap:
		return "spamtrap"
	case ReasonRoleAccount, ReasonRoleAddress:
		return "role_account"
	case ReasonDNSFail:
		return "dns_failure"
	case ReasonInvalidAddress, ReasonInvalidEmail:
		return "invalid_address"
	case ReasonDSARDeletion:
		return "manual"
	default:
		return "unsubscribe"
	}
}

// Check returns (true, *Entry) when (tenantID, email) is currently
// suppressed. expires_at IS NULL or in the future counts as active;
// an expired row is treated as not suppressed (the cleanup reaper
// deletes them eventually but we don't block on that).
//
// The match is plaintext-OR-hash so a DSAR-erased subscriber stays
// suppressed even after their email column was overwritten with an
// erased placeholder. The hash is sha256(lower(trim(original_email)))
// stored in email_sha256 by the privacy deletion worker.
func (s *Store) Check(ctx context.Context, tenantID, email string) (bool, *Entry, error) {
	if s == nil || s.Pool == nil {
		return false, nil, errors.New("suppressions: nil store")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false, nil, nil
	}
	sum := sha256.Sum256([]byte(email))
	hashHex := hex.EncodeToString(sum[:])
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &Entry{}
	var meta []byte
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, email::text, reason, source,
       COALESCE(source_event_id,''), created_at, expires_at, metadata
FROM subscriber_suppressions
WHERE tenant_id = $1::uuid
  AND (email = $2 OR email_sha256 = $3)
  AND (expires_at IS NULL OR expires_at > now())
LIMIT 1`, tenantID, email, hashHex)
	if err := row.Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.Commit(ctx); err != nil {
				return false, nil, err
			}
			return false, nil, nil
		}
		return false, nil, fmt.Errorf("suppressions: check: %w", err)
	}
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, nil, err
	}
	return true, out, nil
}

// ListPaged returns active + expired suppressions for the tenant
// newest-first. total is the unfiltered row count for pagination.
func (s *Store) ListPaged(ctx context.Context, tenantID string, page, size int) ([]Entry, int, error) {
	return s.ListPagedFiltered(ctx, tenantID, "", "", page, size)
}

// escapeLike escapes LIKE/ILIKE metacharacters in a user-supplied
// pattern fragment so a `q=50%` filter matches the literal characters
// instead of acting as a wildcard.
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

// ListPagedFiltered is ListPaged plus the GAP A20 filters: emailExact
// matches one address exactly (case-insensitive — the column is
// citext, so the (tenant_id, email) index serves it), and prefix
// narrows by case-insensitive email prefix. Empty strings disable a
// filter. total is the row count under the same filters so the
// dashboard's pager stays correct.
func (s *Store) ListPagedFiltered(ctx context.Context, tenantID, emailExact, prefix string, page, size int) ([]Entry, int, error) {
	if s == nil || s.Pool == nil {
		return nil, 0, errors.New("suppressions: nil store")
	}
	if page < 1 {
		page = 1
	}
	if size <= 0 {
		size = 50
	}
	if size > 200 {
		size = 200
	}
	offset := (page - 1) * size
	emailExact = strings.ToLower(strings.TrimSpace(emailExact))
	prefix = strings.ToLower(strings.TrimSpace(prefix))

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const filterPredicate = `
  AND ($2 = '' OR email = $2::citext)
  AND ($3 = '' OR email::text ILIKE $3)`
	likePrefix := ""
	if prefix != "" {
		likePrefix = escapeLike(prefix) + "%"
	}

	var total int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM subscriber_suppressions WHERE tenant_id = $1::uuid`+filterPredicate,
		tenantID, emailExact, likePrefix,
	).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("suppressions: count: %w", err)
	}

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, email::text, reason, source,
       COALESCE(source_event_id,''), created_at, expires_at, metadata,
       channel, scope, match_kind
FROM subscriber_suppressions
WHERE tenant_id = $1::uuid`+filterPredicate+`
ORDER BY created_at DESC
LIMIT $4 OFFSET $5`, tenantID, emailExact, likePrefix, size, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("suppressions: list query: %w", err)
	}
	defer rows.Close()
	out := make([]Entry, 0, size)
	for rows.Next() {
		var s Entry
		var meta []byte
		if err := rows.Scan(
			&s.ID, &s.TenantID, &s.Email, &s.Reason, &s.Source,
			&s.SourceEventID, &s.CreatedAt, &s.ExpiresAt, &meta,
			&s.Channel, &s.Scope, &s.MatchKind,
		); err != nil {
			return nil, 0, fmt.Errorf("suppressions: list scan: %w", err)
		}
		if len(meta) > 0 {
			s.Metadata = decodeJSON(meta)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// LookupBulk returns the subset of `emails` that are currently
// suppressed for `tenantID` (active rows: expires_at IS NULL OR
// expires_at > now()). The returned map is keyed by the LOWERCASED
// email so callers can look up case-insensitively without re-normalising.
//
// One round-trip per call regardless of audience size: joins a normalized
// email/SHA-256 request set so DSAR-erased suppression rows remain effective.
// Empty input → empty map, nil error.
//
// Used by campaign queue-fill and send-time preflight to drop suppressed
// addresses before they consume rate-limit slots. The send loop still performs
// a last-moment scalar check for batch-clear addresses because a suppression
// may land while earlier recipients in the batch are being dispatched.
func (s *Store) LookupBulk(ctx context.Context, tenantID string, emails []string) (map[string]bool, error) {
	out := map[string]bool{}
	if s == nil || s.Pool == nil {
		return out, errors.New("suppressions: nil store")
	}
	if tenantID == "" || len(emails) == 0 {
		return out, nil
	}
	// Normalise + de-dupe so we don't bind the same value twice.
	seen := make(map[string]struct{}, len(emails))
	norm := make([]string, 0, len(emails))
	for _, e := range emails {
		k := strings.ToLower(strings.TrimSpace(e))
		if k == "" {
			continue
		}
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		norm = append(norm, k)
	}
	if len(norm) == 0 {
		return out, nil
	}
	hashes := make([]string, len(norm))
	for i, email := range norm {
		sum := sha256.Sum256([]byte(email))
		hashes[i] = hex.EncodeToString(sum[:])
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH requested(email, email_sha256) AS (
  SELECT *
  FROM unnest($2::text[], $3::text[])
)
SELECT requested.email
  FROM requested
  JOIN subscriber_suppressions suppression
    ON suppression.tenant_id = $1::uuid
   AND (
        lower(suppression.email::text) = requested.email
        OR (
          suppression.email_sha256 IS NOT NULL
          AND suppression.email_sha256 = requested.email_sha256
        )
   )
 WHERE suppression.expires_at IS NULL OR suppression.expires_at > now()`, tenantID, norm, hashes)
	if err != nil {
		return nil, fmt.Errorf("suppressions: lookup bulk: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, fmt.Errorf("suppressions: lookup bulk scan: %w", err)
		}
		out[strings.ToLower(strings.TrimSpace(e))] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CountSoftBouncesSince counts soft-bounce events in subscriber_events
// for (tenantID, email) since `since`. Used by the auto-suppression
// threshold check: ≥SoftBounceThreshold within SoftBounceWindow rolls
// the address into a time-limited suppression.
func (s *Store) CountSoftBouncesSince(ctx context.Context, tenantID, email string, since time.Time) (int, error) {
	if s == nil || s.Pool == nil {
		return 0, errors.New("suppressions: nil store")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return 0, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
FROM subscriber_events
WHERE tenant_id = $1::uuid
  AND subscriber_email = $2
  AND event_type = 'bounced'
  AND bounce_type = 'soft'
  AND at >= $3`, tenantID, email, since).Scan(&n); err != nil {
		return 0, fmt.Errorf("suppressions: count soft bounces: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// FetchByID returns a single suppression by primary key, scoped to
// `tenantID` via the RLS GUC. Returns (nil, nil) when the row is
// missing — callers (bulk-delete) treat that as a silent drop because
// the caller-supplied id list may include stale ids from a tab that
// raced a competing delete.
//
// Used by the bulk-delete pre-check to look up the row's reason for
// the reversibility gate.
func (s *Store) FetchByID(ctx context.Context, tenantID, id string) (*Entry, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("suppressions: nil store")
	}
	if tenantID == "" || id == "" {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &Entry{}
	var meta []byte
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, email::text, reason, source,
	       COALESCE(source_event_id,''), created_at, expires_at, metadata,
	       xmin::text
FROM subscriber_suppressions
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1`, tenantID, id).Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
		&out.RowVersion,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if cerr := tx.Commit(ctx); cerr != nil {
				return nil, cerr
			}
			return nil, nil
		}
		return nil, fmt.Errorf("suppressions: fetch by id: %w", err)
	}
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// FetchByEmail returns the suppression row for (tenantID, email)
// regardless of expiry state, or (nil, nil) when no row exists. Used
// by the email-keyed bulk endpoints to resolve operator-supplied
// addresses to rows so the reversibility gate can inspect the reason.
// The (tenant_id, email) unique index serves the lookup; email is
// citext so the comparison is case-insensitive.
func (s *Store) FetchByEmail(ctx context.Context, tenantID, email string) (*Entry, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("suppressions: nil store")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if tenantID == "" || email == "" {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &Entry{}
	var meta []byte
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, email::text, reason, source,
	       COALESCE(source_event_id,''), created_at, expires_at, metadata,
	       xmin::text
FROM subscriber_suppressions
WHERE tenant_id = $1::uuid AND email = $2::citext
LIMIT 1`, tenantID, email).Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
		&out.RowVersion,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if cerr := tx.Commit(ctx); cerr != nil {
				return nil, cerr
			}
			return nil, nil
		}
		return nil, fmt.Errorf("suppressions: fetch by email: %w", err)
	}
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// BulkRemoveByIDs deletes the rows whose primary key is in `ids`, scoped
// to `tenantID`. Returns the deleted row count and a per-id error slice
// so the dashboard can render "47 of 50 deleted" — though in practice
// the single DELETE … WHERE id = ANY(...) is all-or-nothing, so errs is
// usually empty and the second return is reserved for future per-row
// validation. The third return is the fatal tx error (nil on success).
func (s *Store) BulkRemoveByIDs(ctx context.Context, tenantID string, ids []string) (int, []string, error) {
	if s == nil || s.Pool == nil {
		return 0, nil, errors.New("suppressions: nil store")
	}
	if tenantID == "" || len(ids) == 0 {
		return 0, nil, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM subscriber_suppressions
WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
		tenantID, ids)
	if err != nil {
		return 0, nil, fmt.Errorf("suppressions: bulk remove: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, err
	}
	return int(tag.RowsAffected()), nil, nil
}

// BulkRemoveSelected is the race-safe admin bulk deletion path. Every row is
// compare-and-deleted using the MVCC version captured during the handler's
// reversibility review. Rows changed/replaced in the interim are preserved and
// returned as per-row errors; independently deleted rows remain idempotent.
// The returned IDs are the rows this transaction actually deleted, allowing
// callers to avoid emitting false audit records for stale selections.
func (s *Store) BulkRemoveSelected(ctx context.Context, tenantID string, selected []*Entry) ([]string, []string, error) {
	deletedIDs := []string{}
	rowErrors := []string{}
	if s == nil || s.Pool == nil {
		return deletedIDs, rowErrors, errors.New("suppressions: nil store")
	}
	if tenantID == "" || len(selected) == 0 {
		return deletedIDs, rowErrors, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return deletedIDs, rowErrors, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	seen := make(map[string]struct{}, len(selected))
	for _, row := range selected {
		if row == nil || row.ID == "" || row.RowVersion == "" ||
			(row.TenantID != "" && row.TenantID != tenantID) {
			rowErrors = append(rowErrors, "invalid reviewed suppression selection")
			continue
		}
		if _, ok := seen[row.ID]; ok {
			continue
		}
		seen[row.ID] = struct{}{}

		var deletedID string
		err := tx.QueryRow(ctx, `
DELETE FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
	AND id = $2::uuid
	AND xmin::text = $3
RETURNING id::text`, tenantID, row.ID, row.RowVersion).Scan(&deletedID)
		if errors.Is(err, pgx.ErrNoRows) {
			var currentExists bool
			if qerr := tx.QueryRow(ctx, `
SELECT EXISTS (
	SELECT 1
	  FROM subscriber_suppressions
	 WHERE tenant_id = $1::uuid
	   AND (id = $2::uuid OR email = $3::citext)
)`, tenantID, row.ID, row.Email).Scan(&currentExists); qerr != nil {
				return nil, rowErrors, fmt.Errorf("suppressions: verify bulk reviewed row %s: %w", row.ID, qerr)
			}
			if currentExists {
				rowErrors = append(rowErrors, row.ID+": suppression changed after review; refresh and retry")
			}
			continue
		}
		if err != nil {
			return nil, rowErrors, fmt.Errorf("suppressions: bulk delete reviewed row %s: %w", row.ID, err)
		}
		if err := deleteLinkedLegacyRows(ctx, tx, tenantID, deletedID); err != nil {
			return nil, rowErrors, err
		}
		deletedIDs = append(deletedIDs, deletedID)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, rowErrors, err
	}
	return deletedIDs, rowErrors, nil
}

// ErrPermanentSuppressionReclassification means the reviewed selection now
// contains a compliance-pinned row. The whole mutation is refused: partially
// changing the remaining rows would make the operator's confirmed scope false.
var ErrPermanentSuppressionReclassification = errors.New("suppressions: permanent row cannot be reclassified")

// ErrSuppressionReasonChanged means a row stopped matching the current reason
// captured under lock. The transaction is rolled back so neither the reason nor
// its audit evidence can become a partial or stale account of the change.
var ErrSuppressionReasonChanged = errors.New("suppressions: reviewed reason changed")

// BulkReasonChangeEvidence is the exact current-state evidence written for one
// row by BulkChangeReason. It is returned for response reconciliation; the same
// values are inserted into suppression_audit inside the mutation transaction.
type BulkReasonChangeEvidence struct {
	ID             string
	Email          string
	PreviousReason Reason
	NewReason      Reason
}

// rejectPermanentReasonChange checks the CURRENT locked rows, not the earlier
// handler lookup or a client snapshot. DSAR deletion rows are immutable outside
// the dedicated erasure/rescind workflow.
func rejectPermanentReasonChange(rows []BulkReasonChangeEvidence) error {
	for _, row := range rows {
		if ReversibilityFor(row.PreviousReason) == ReversibilityPermanent {
			return fmt.Errorf("%w: %s", ErrPermanentSuppressionReclassification, row.ID)
		}
	}
	return nil
}

// BulkChangeReason atomically locks the selected canonical rows, refuses the
// full scope if any current row is permanent, updates with an explicit
// current-reason predicate, and inserts one prior/new suppression_audit row per
// update before committing. Audit failure rolls the reason update back: this
// path never reports a classification change without durable evidence.
func (s *Store) BulkChangeReason(
	ctx context.Context,
	tenantID string,
	ids []string,
	newReason Reason,
	actorUserID string,
	actorAPIKeyID string,
) ([]BulkReasonChangeEvidence, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("suppressions: nil store")
	}
	if !ValidReasons[newReason] {
		return nil, fmt.Errorf("suppressions: invalid reason %q", newReason)
	}
	if newReason == ReasonDSARDeletion {
		return nil, fmt.Errorf("%w: target reason", ErrPermanentSuppressionReclassification)
	}
	if tenantID == "" || len(ids) == 0 {
		return []BulkReasonChangeEvidence{}, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	lockedRows, err := tx.Query(ctx, `
SELECT id::text, email::text, reason
FROM subscriber_suppressions
WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])
ORDER BY id
FOR UPDATE`, tenantID, ids)
	if err != nil {
		return nil, fmt.Errorf("suppressions: lock bulk reason scope: %w", err)
	}
	evidence := make([]BulkReasonChangeEvidence, 0, len(ids))
	for lockedRows.Next() {
		row := BulkReasonChangeEvidence{NewReason: newReason}
		if err := lockedRows.Scan(&row.ID, &row.Email, &row.PreviousReason); err != nil {
			lockedRows.Close()
			return nil, fmt.Errorf("suppressions: scan locked reason scope: %w", err)
		}
		evidence = append(evidence, row)
	}
	if err := lockedRows.Err(); err != nil {
		lockedRows.Close()
		return nil, fmt.Errorf("suppressions: iterate locked reason scope: %w", err)
	}
	lockedRows.Close()
	if err := rejectPermanentReasonChange(evidence); err != nil {
		return nil, err
	}
	if len(evidence) == 0 {
		return []BulkReasonChangeEvidence{}, nil
	}

	lockedIDs := make([]string, 0, len(evidence))
	lockedEmails := make([]string, 0, len(evidence))
	lockedReasons := make([]string, 0, len(evidence))
	for _, row := range evidence {
		lockedIDs = append(lockedIDs, row.ID)
		lockedEmails = append(lockedEmails, row.Email)
		lockedReasons = append(lockedReasons, string(row.PreviousReason))
	}
	updatedRows, err := tx.Query(ctx, `
UPDATE subscriber_suppressions AS suppression
SET reason = $3
FROM unnest($2::uuid[], $4::text[]) AS reviewed(id, previous_reason)
WHERE suppression.tenant_id = $1::uuid
  AND suppression.id = reviewed.id
  AND suppression.reason = reviewed.previous_reason
RETURNING suppression.id::text`, tenantID, lockedIDs, string(newReason), lockedReasons)
	if err != nil {
		return nil, fmt.Errorf("suppressions: bulk change reason: %w", err)
	}
	updatedIDs := make(map[string]struct{}, len(evidence))
	for updatedRows.Next() {
		var id string
		if err := updatedRows.Scan(&id); err != nil {
			updatedRows.Close()
			return nil, fmt.Errorf("suppressions: scan changed reason: %w", err)
		}
		updatedIDs[id] = struct{}{}
	}
	if err := updatedRows.Err(); err != nil {
		updatedRows.Close()
		return nil, fmt.Errorf("suppressions: iterate changed reasons: %w", err)
	}
	updatedRows.Close()
	if len(updatedIDs) != len(evidence) {
		return nil, ErrSuppressionReasonChanged
	}
	for _, row := range evidence {
		if _, ok := updatedIDs[row.ID]; !ok {
			return nil, ErrSuppressionReasonChanged
		}
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO suppression_audit
    (tenant_id, email, action, actor_user_id, actor_api_key_id,
     reason, source_table, payload)
SELECT $1::uuid,
       reviewed.email::citext,
       'update',
       NULLIF($5, '')::uuid,
       NULLIF($6, '')::uuid,
       $3::text,
       'subscriber_suppressions',
       jsonb_build_object(
           'id', reviewed.id::text,
           'bulk', true,
           'previous_reason', reviewed.previous_reason,
           'new_reason', $3::text
       )
FROM unnest($2::uuid[], $4::text[], $7::text[])
     AS reviewed(id, previous_reason, email)`,
		tenantID, lockedIDs, string(newReason), lockedReasons,
		actorUserID, actorAPIKeyID, lockedEmails,
	); err != nil {
		return nil, fmt.Errorf("suppressions: audit bulk reason change: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return evidence, nil
}

// UpdateExpiresAt rewrites the expires_at on a single row, scoped to
// tenant via the RLS GUC. nil clears the column (permanent). Returns
// the post-update row so the PATCH handler can echo the canonical
// shape back to the caller.
func (s *Store) UpdateExpiresAt(ctx context.Context, tenantID, id string, expiresAt *time.Time) (*Entry, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("suppressions: nil store")
	}
	if tenantID == "" || id == "" {
		return nil, fmt.Errorf("suppressions: missing tenant or id")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &Entry{}
	var meta []byte
	err = tx.QueryRow(ctx, `
UPDATE subscriber_suppressions
SET expires_at = $3
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, email::text, reason, source,
          COALESCE(source_event_id,''), created_at, expires_at, metadata`,
		tenantID, id, expiresAt,
	).Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if cerr := tx.Commit(ctx); cerr != nil {
				return nil, cerr
			}
			return nil, nil
		}
		return nil, fmt.Errorf("suppressions: update expires_at: %w", err)
	}
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RecentAuditForEmail returns the most recent audit rows for an email
// within the tenant. Limit is hard-capped at 100 so the timeline
// endpoint can't accidentally page-fault a noisy address.
func (s *Store) RecentAuditForEmail(ctx context.Context, tenantID, email string, limit int) ([]AuditEntry, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("suppressions: nil store")
	}
	if tenantID == "" || email == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// NOTE: ORDER BY created_at — an earlier revision ordered by a
	// non-existent `at` column; the endpoint was unmounted so the bug
	// never fired in production.
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, email::text, action,
       COALESCE(actor_user_id::text,''), COALESCE(actor_api_key_id::text,''),
       COALESCE(reason,''), source_table, payload, created_at
FROM suppression_audit
WHERE tenant_id = $1::uuid AND email = $2::citext
ORDER BY created_at DESC
LIMIT $3`, tenantID, strings.ToLower(strings.TrimSpace(email)), limit)
	if err != nil {
		return nil, fmt.Errorf("suppressions: audit list: %w", err)
	}
	defer rows.Close()
	out, err := scanAuditRows(rows, limit)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// AuditForEmailPaged is the GAP-LS-008 read path: the audit trail for
// one address, newest-first, with a filtered total for pagination.
// Served by GET /api/v1/suppressions/{email-or-id}/audit.
func (s *Store) AuditForEmailPaged(ctx context.Context, tenantID, email string, page, size int) ([]AuditEntry, int, error) {
	if s == nil || s.Pool == nil {
		return nil, 0, errors.New("suppressions: nil store")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if tenantID == "" || email == "" {
		return []AuditEntry{}, 0, nil
	}
	if page < 1 {
		page = 1
	}
	if size <= 0 {
		size = 50
	}
	if size > 200 {
		size = 200
	}
	offset := (page - 1) * size

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM suppression_audit
WHERE tenant_id = $1::uuid AND email = $2::citext`,
		tenantID, email).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("suppressions: audit count: %w", err)
	}

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, email::text, action,
       COALESCE(actor_user_id::text,''), COALESCE(actor_api_key_id::text,''),
       COALESCE(reason,''), source_table, payload, created_at
FROM suppression_audit
WHERE tenant_id = $1::uuid AND email = $2::citext
ORDER BY created_at DESC
LIMIT $3 OFFSET $4`, tenantID, email, size, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("suppressions: audit page: %w", err)
	}
	defer rows.Close()
	out, err := scanAuditRows(rows, size)
	if err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// scanAuditRows drains an audit-query cursor into []AuditEntry and
// fills the derived Actor convenience field (user id wins over API
// key id; the dashboard renders whichever is present).
func scanAuditRows(rows pgx.Rows, capacity int) ([]AuditEntry, error) {
	if capacity < 0 {
		capacity = 0
	}
	out := make([]AuditEntry, 0, capacity)
	for rows.Next() {
		var e AuditEntry
		var payload []byte
		if err := rows.Scan(
			&e.ID, &e.TenantID, &e.Email, &e.Action,
			&e.ActorUserID, &e.ActorAPIKeyID,
			&e.Reason, &e.SourceTable, &payload, &e.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("suppressions: audit scan: %w", err)
		}
		if len(payload) > 0 {
			e.Payload = decodeJSON(payload)
		}
		e.Actor = e.ActorUserID
		if e.Actor == "" {
			e.Actor = e.ActorAPIKeyID
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// TrendPoint is one day of the suppression-growth chart (desktop
// audit A5). Count is the number of rows created that UTC day;
// ByReason breaks the same count down per canonical reason so the
// chart can render stacked series without a second request.
type TrendPoint struct {
	Date     string         `json:"date"` // YYYY-MM-DD (UTC)
	Count    int            `json:"count"`
	ByReason map[string]int `json:"by_reason"`
}

// Trend aggregates subscriber_suppressions by UTC day-of-created_at
// over the trailing `days` window (inclusive of today). Cheap
// date_trunc GROUP BY served by the (tenant_id, created_at DESC)
// index from migration 0380. Days are zero-filled so the chart gets a
// continuous axis; the handler clamps `days` to 1..365 (default 30)
// and this method re-clamps defensively.
func (s *Store) Trend(ctx context.Context, tenantID string, days int) ([]TrendPoint, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("suppressions: nil store")
	}
	if days < 1 {
		days = 30
	}
	if days > 365 {
		days = 365
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Window start is the UTC midnight `days-1` days ago so days=1
	// means "today only" and days=30 spans 30 calendar days.
	now := time.Now().UTC()
	start := now.Truncate(24*time.Hour).AddDate(0, 0, -(days - 1))

	rows, err := tx.Query(ctx, `
SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       reason,
       count(*)::int
FROM subscriber_suppressions
WHERE tenant_id = $1::uuid AND created_at >= $2
GROUP BY 1, 2
ORDER BY 1 ASC`, tenantID, start)
	if err != nil {
		return nil, fmt.Errorf("suppressions: trend query: %w", err)
	}
	defer rows.Close()

	byDay := make(map[string]*TrendPoint, days)
	for rows.Next() {
		var day, reason string
		var n int
		if err := rows.Scan(&day, &reason, &n); err != nil {
			return nil, fmt.Errorf("suppressions: trend scan: %w", err)
		}
		p, ok := byDay[day]
		if !ok {
			p = &TrendPoint{Date: day, ByReason: map[string]int{}}
			byDay[day] = p
		}
		p.Count += n
		p.ByReason[reason] += n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	// Zero-fill the continuous date axis oldest-first.
	out := make([]TrendPoint, 0, days)
	for i := 0; i < days; i++ {
		date := start.AddDate(0, 0, i).Format("2006-01-02")
		if p, ok := byDay[date]; ok {
			out = append(out, *p)
			continue
		}
		out = append(out, TrendPoint{Date: date, Count: 0, ByReason: map[string]int{}})
	}
	return out, nil
}

// fetchByID rehydrates a single row by primary key inside an existing
// tx. Used by Add when a (source, source_event_id) dedup hit short-
// circuits the upsert.
func fetchByID(ctx context.Context, tx pgx.Tx, id string) (*Entry, error) {
	out := &Entry{}
	var meta []byte
	err := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, email::text, reason, source,
       COALESCE(source_event_id,''), created_at, expires_at, metadata
FROM subscriber_suppressions WHERE id = $1::uuid`, id).Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
	)
	if err != nil {
		return nil, err
	}
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	return out, nil
}
