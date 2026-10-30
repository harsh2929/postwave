package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/gdprpermissions"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/pushauthoritylock"
)

var ErrNotFound = errors.New("subscriber not found")

// ErrPreconditionFailed is returned by Update when the caller's If-Match
// concurrency token no longer matches the row's current version. The handler
// maps it to 412.
var ErrPreconditionFailed = errors.New("subscriber: precondition failed (stale If-Match)")

// ErrSuppressionNotReversible protects privacy-erasure tombstones from the
// legacy suppression DELETE compatibility route. Restoring an erased identity
// requires a dedicated compliance workflow; ordinary suppression management
// can never remove this evidence.
var ErrSuppressionNotReversible = errors.New("subscriber: suppression is an irreversible privacy tombstone")

// ErrErasureBlocked is returned by every writer that would create or move a
// subscriber onto an address an irreversible erasure tombstone protects: a
// contact delete or a privacy request (see suppressions.ErasedAddresses). The
// tombstone cannot be removed through ordinary suppression management, so the
// address can't flow back into the audience. Closes the subscriber-merge
// CRITICAL #1 re-subscribe-after-erasure regression.
var ErrErasureBlocked = errors.New("subscriber: address was permanently erased")

// Repo is the Postgres-backed subscriber mirror. All methods bind
// app.tenant_id before touching the RLS-protected subscribers table.
// TransactionalEngagementClassifier attaches the raw observation + shadow
// classification to a subscriber event, inside the caller's transaction.
//
// Declared here rather than imported as a shared type so this package keeps its
// narrow dependency surface, matching the other producer packages. They
// declare the same single-method shape; that is deliberate
// duplication of a CONTRACT, not of a rule.
type TransactionalEngagementClassifier interface {
	RecordProviderEvent(
		context.Context,
		pgx.Tx,
		string,
		engagementclassification.ProviderEventInput,
	) error
}

type TransactionalCampaignReportProjector interface {
	ProjectCanonicalEvent(
		context.Context,
		pgx.Tx,
		string,
		campaignreportprojection.CanonicalEvent,
	) error
}

type Repo struct {
	Pool *db.Pool
	// EngagementClassifier records the raw observation + classification for
	// events arriving through RecordSubscriberEvent, including the authenticated
	// subscriber-event API and the identified first-party publictrack path.
	// AttributeAnonymousEvents uses the same hook directly when it stitches a
	// pre-identification event. MCP custom events and lifecycle stage transitions
	// have independent direct writers; they do NOT delegate here and are governed
	// as fixed non-engagement event types by F01's writer coverage ledger.
	//
	// Without it, those events were invisible to reclassification: the corpus
	// covered the Listmonk path and (since the ESP fix) the seven provider
	// webhooks, and silently omitted every event a customer sent through the
	// public track endpoint. nil keeps the rollout disabled.
	EngagementClassifier TransactionalEngagementClassifier
	// CampaignReportProjector attaches eligible campaign-scoped API events to
	// the compatibility report ledger in the same transaction. Anonymous
	// attribution always writes campaign_id NULL and is deliberately ineligible.
	CampaignReportProjector TransactionalCampaignReportProjector
	// EngineSyncOutbox durably reconciles the canonical subscriber row to the
	// external delivery engine. When configured, every create/update/status or
	// suppression mutation appends an intent inside the same transaction as the
	// local write. Ordinary payloads contain only the subscriber UUID; a legacy
	// marker-free email rotation may also carry the previous address needed to
	// locate the external row. A nil value preserves the historical lightweight
	// dev/test behaviour (the HTTP handlers may synchronize directly).
	// Production must wire this to the shared transactional outbox.
	EngineSyncOutbox EngineSyncOutboxAppender
	// CustomFields is an optional validator. When set, it normalises
	// custom_fields + merge_fields against the tenant's registry on
	// every Upsert/Update so the jsonb blob stays in lockstep with
	// the typed schema. nil = legacy passthrough.
	CustomFields *customfields.Validator
	// Webhooks is an optional dispatcher. When set, Upsert/Update fire
	// outbound webhook events INSIDE the same tx as the business write
	// — so a tenant's webhook receiver never sees an event for a row
	// that didn't actually land in the database. nil = no events fired.
	Webhooks WebhookDispatcher
	// TagHistory is optional. When set, Upsert/Update dual-write tag
	// add/remove deltas into tag_history inside the same tx as the
	// subscriber mutation.
	TagHistory TagHistoryEmitter
	// AttributeHistory, when true, makes Upsert/Update dual-write a
	// per-field before/after snapshot into subscriber_attribute_history
	// (SUB-008, migration 0425) inside the same tx as the mutation. Opt-in
	// (off by default) so a deployment without the 0425 table — or a test
	// fake without a live DB — is unaffected. Tags are excluded here;
	// tag_history (TagHistory above) owns them.
	AttributeHistory bool
	// Jurisdiction is the optional SUB-055 IP→jurisdiction detector. When set,
	// Upsert infers the subject's country from signup_ip and, on a drift into
	// a stricter consent regime, stamps detected_jurisdiction /
	// jurisdiction_changed_at and flips jurisdiction_reconfirm_required
	// (migration 0538). nil = jurisdiction detection disabled (the column
	// defaults stand). Interface kept package-local so subscribers doesn't
	// hard-depend on the geolocation package's concrete type.
	Jurisdiction JurisdictionDetector
	// ConsentSyncLedger is the optional SUB-121 per-destination consent-sync
	// ledger. When set, an unsubscribe/consent-revoke status transition on
	// Update/SetStatus records one pending ledger row per configured downstream
	// destination INSIDE the same tx as the status write (migration 0563), so
	// the per-destination delivery + retry audit trail never disagrees with the
	// committed status. nil = no ledger rows written. Implemented by
	// *ConsentSyncLedger in consent_sync_ledger.go.
	ConsentSyncLedger ConsentSyncLedgerEmitter
	// Demographics is the optional SUB-063 demographic-inference predictor.
	// When set, Upsert infers gender / age group / interests with confidence
	// scores from the subject's name and stamps the results onto
	// subscriber_computed_traits under the inferred_* well-known keys (no new
	// table). nil = demographic inference disabled (the columns simply stay
	// absent). Interface kept package-local so subscribers doesn't hard-depend
	// on the demographics package's concrete type — main.go wires an adapter.
	Demographics DemographicPredictor
	// PIIScanner is a legacy compatibility/test seam for the pre-1762
	// post-commit scanner. Production deliberately leaves it nil: migration
	// 1762's database trigger + durable revision intent is the authoritative
	// all-writer coverage boundary. Keeping the seam temporarily lets older
	// embedders compile without implying that best-effort hooks provide durable
	// coverage.
	PIIScanner PIIScanner
	// Bus is an optional in-process SSE event publisher (SUB-119). When set,
	// repo-level mutation paths that have NO handler-level emit covering them
	// — today the double-opt-in confirmation transition (Update/SetStatus
	// moving a subscriber from unconfirmed → enabled) — publish the matching
	// subscriber.* event to the Bus AFTER a successful commit, so the desktop's
	// "subscriber.*" wildcard subscription sees the same lifecycle moment the
	// outbound webhook fires. nil-safe: a nil Bus disables every repo emit.
	//
	// NB: handler-level emits (Create/Update/Delete in handlers.go) already
	// bridge those HTTP paths to the Bus, so the repo deliberately does NOT
	// re-emit subscriber.{created,updated,deleted,status_changed,consent_changed}
	// for them — that would double-emit. The repo only owns subscriber.confirmed,
	// which no handler covers.
	Bus EventPublisher
}

// PIIScanner is the legacy pre-1762 compatibility seam. It is not wired by the
// production composition root and must not be treated as coverage evidence.
type PIIScanner interface {
	// ScanSubscriber scans the supplied free-text fields for undeclared PII and
	// records any findings, returning the count of newly-inserted findings. It
	// must be best-effort: the caller invokes it post-commit and ignores the
	// error, so an internal failure can never fail the subscriber write.
	ScanSubscriber(ctx context.Context, tenantID, subscriberID string, fields map[string]any) (int, error)
}

// DemographicPredictor is the minimal slice of demographics.Predictor the
// subscribers package needs. Implemented by an adapter in main.go over the
// demographics package so this package does not import it (keeps the
// dependency direction one-way and the tests light).
type DemographicPredictor interface {
	// PredictDemographics scores a subject's name into a confidence-labelled
	// demographic prediction. Returns ok=false when nothing could be inferred
	// (callers then skip persisting / surfacing demographics).
	PredictDemographics(firstName, fullName string) (out PredictedDemographics, ok bool)
}

// PredictedDemographics is the import-free mirror of demographics.Prediction
// the adapter in main.go returns. Each field is confidence-labelled; a zero
// confidence means "not inferred".
type PredictedDemographics struct {
	Gender              string
	GenderConfidence    float64
	AgeGroup            string
	AgeGroupConfidence  float64
	Interests           []string
	InterestsConfidence float64
}

// ConsentSyncLedgerEmitter records per-destination ledger rows for a consent/
// status change, in the supplied tx. Kept package-local so the dispatch path
// has no extra import surface beyond the subscribers package itself.
type ConsentSyncLedgerEmitter interface {
	RecordEvent(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, eventType string) error
}

// JurisdictionDetector is the minimal slice of geolocation.Detector +
// drift-evaluation the subscribers package needs. Implemented by an adapter in
// main.go over the geolocation package so this package does not import it
// (keeps the dependency direction one-way and the tests light).
type JurisdictionDetector interface {
	// DetectDrift compares the stored country/region against the country
	// inferred from ip. Returns the inferred country (empty when undetectable),
	// whether the jurisdiction changed, and whether a consent re-confirmation
	// is required.
	DetectDrift(storedCountry, storedRegion, ip string) (inferred string, changed, reconfirmRequired bool)
	// ConsentRegime returns the canonical re-confirmation vocabulary for a
	// detected country/region. The write path uses this server-owned result so
	// a client cannot label a Canadian receipt as GDPR (or vice versa).
	ConsentRegime(country, region string) string
}

// EventPublisher is the minimal slice of events.Bus the repo needs to bridge
// a committed mutation to the in-process SSE stream (SUB-119). Kept package-
// local + nil-safe so the repo does not import the events package and tests
// can pass a tiny recorder. *events.Bus is adapted to this shape via
// busPublisher in handlers.go.
type EventPublisher interface {
	Publish(tenantID, topic string, payload map[string]any)
}

// WebhookDispatcher is the minimal slice of webhooks.Dispatcher this
// package needs. Defined here so subscribers tests don't pull in the
// full webhooks + outbox + crypto stack.
type WebhookDispatcher interface {
	Fire(ctx context.Context, tx pgx.Tx, in WebhookFireInput) (int, error)
}

// TagHistoryEmitter is implemented by tags.History. Kept package-local
// so subscribers does not import the tags package.
type TagHistoryEmitter interface {
	EmitSubscriberTagDelta(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string, added, removed []string, actorID, source string) error
}

// WebhookFireInput mirrors webhooks.FireInput verbatim — kept under a
// package-local name so subscribers doesn't import webhooks (the
// adapter in main.go translates between the two).
type WebhookFireInput struct {
	TenantID       string
	EventType      string
	Body           any
	IdempotencyKey string
}

// List returns subscribers newest-first.
//
// With a zero ListOptions it is byte-identical to the historic endpoint:
// no filter, ORDER BY updated_at DESC, OFFSET paging, and a full COUNT
// returned as Total. The optional ListOptions add, all combinable:
//
//   - Q       — the shared indexed free-text predicate
//     (subscriberFreeTextPredicate), the same one /search uses.
//   - Status  — an exact-match filter on status or mailchimp_status
//     (statusFilterClause picks the column). The handler has already
//     validated/rejected unknown values, so a non-empty Status here is
//     always a recognised one.
//   - Sort/Order — an allow-listed ORDER BY (normalizeSort). The column
//     is NEVER user input: it is a fixed string chosen by a switch.
//   - Cursor  — keyset paging on (updated_at, id). Honoured ONLY for the
//     default sort (updated_at DESC); see usesKeyset(). Any non-default
//     sort ignores the cursor and uses OFFSET.
//
// Paging mechanism:
//   - Offset path (no cursor, or a non-default sort): LIMIT/OFFSET, and a
//     COUNT(*) over the same WHERE is returned as Total.
//   - Keyset path (cursor + default sort): WHERE (updated_at, id) <
//     (cursor) ORDER BY updated_at DESC, id DESC LIMIT perPage. Total is
//     left 0 — a COUNT would re-scan the whole filtered set on every page
//     and defeat the point of keyset paging at 5M rows; NextCursor drives
//     "load more" instead. This is intentional, not a silent cap.
//
// List keeps the historic (page, perPage) signature so existing callers
// (the compat Mailchimp facade) compile unchanged; it delegates to
// ListWithOptions with a zero filter set. New paging/search/sort knobs go
// through ListWithOptions.
func (r *Repo) List(ctx context.Context, tenantID string, page, perPage int) (*Page, error) {
	return r.ListWithOptions(ctx, tenantID, ListOptions{Page: page, PerPage: perPage})
}

// ListWithOptions is the full-featured list path backing
// GET /api/v1/subscribers. See the ListOptions field docs and the paging
// notes above for the offset-vs-keyset behaviour.
func (r *Repo) ListWithOptions(ctx context.Context, tenantID string, opts ListOptions) (*Page, error) {
	page, perPage := normalizePage(opts.Page, opts.PerPage)
	col, dir := normalizeSort(opts.Sort, opts.Order)

	// Shared WHERE: tenant scope + optional q + optional status. $1 is
	// always the tenant; further filters append $2, $3 in order.
	args := []any{tenantID}
	where := `WHERE tenant_id = $1::uuid`
	if q := strings.TrimSpace(opts.Q); q != "" {
		args = append(args, q)
		where += `
  AND ` + subscriberFreeTextPredicate(len(args))
	}
	if scol, sval, ok := statusFilterClause(opts.Status); ok {
		args = append(args, sval)
		// scol is a fixed allow-listed column name from statusFilterClause,
		// never user input; the value binds via the $N placeholder.
		where += fmt.Sprintf(`
  AND %s = $%d`, scol, len(args))
	}
	// SUB-009: hide soft-deleted (archived) rows by default. No bound arg —
	// the predicate is a fixed IS NULL so it composes cleanly with the
	// keyset cursor's positional args downstream.
	if !opts.IncludeArchived {
		where += `
  AND archived_at IS NULL`
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if opts.usesKeyset() {
		return r.listKeyset(ctx, tx, where, args, opts.Cursor, perPage, page)
	}

	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers `+where, args...).Scan(&total); err != nil {
		return nil, err
	}
	// ORDER BY uses the allow-listed (col, dir) plus an id tiebreak so the
	// ordering is total and deep OFFSET pages don't shuffle rows that
	// share a sort key.
	limitArg := len(args) + 1
	offsetArg := len(args) + 2
	args = append(args, perPage, (page-1)*perPage)
	rows, err := tx.Query(ctx, subscriberSelectSQL+where+fmt.Sprintf(`
ORDER BY %s %s, id %s
LIMIT $%d OFFSET $%d`, col, dir, dir, limitArg, offsetArg), args...)
	if err != nil {
		return nil, err
	}
	items, err := scanSubscribers(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &Page{Items: items, Total: total, Page: page, PerPage: perPage}, nil
}

// listKeyset runs the keyset (cursor) page for the DEFAULT sort only:
// updated_at DESC, id DESC tiebreak. The boundary predicate is the
// row-value comparison (updated_at, id) < (cursor.updated_at, cursor.id),
// which an index on (tenant_id, updated_at DESC, id DESC) serves as a
// single range scan regardless of how deep the cursor is. perPage+1 rows
// are fetched to detect whether a further page exists without a COUNT;
// the extra row is trimmed and its predecessor's keys become NextCursor.
func (r *Repo) listKeyset(ctx context.Context, tx pgx.Tx, where string, args []any, cur listCursor, perPage, page int) (*Page, error) {
	uArg := len(args) + 1
	idArg := len(args) + 2
	limArg := len(args) + 3
	args = append(args, cur.UpdatedAt, cur.ID, perPage+1)
	rows, err := tx.Query(ctx, subscriberSelectSQL+where+fmt.Sprintf(`
  AND (updated_at, id) < ($%d::timestamptz, $%d::uuid)
ORDER BY updated_at DESC, id DESC
LIMIT $%d`, uArg, idArg, limArg), args...)
	if err != nil {
		return nil, err
	}
	items, err := scanSubscribers(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	var next string
	if len(items) > perPage {
		items = items[:perPage]
		last := items[len(items)-1]
		next = encodeListCursor(listCursor{UpdatedAt: last.UpdatedAt, ID: last.ID})
	}
	// Total is intentionally 0 on the keyset path (see List doc). Page is
	// echoed for shape stability but is not meaningful for keyset paging.
	return &Page{Items: items, Total: 0, Page: page, PerPage: perPage, NextCursor: next}, nil
}

// Search performs a small free-text search across email, tags, and JSON custom
// fields. It intentionally stays conservative so indexes remain useful for the
// normal list/status paths.
//
// SUB-009: archived (soft-deleted) rows are hidden by default; pass
// includeArchived=true (wired from ?include_archived=true) to surface them,
// mirroring ListWithOptions so the /search and /subscribers toggles behave
// identically.
func (r *Repo) Search(ctx context.Context, tenantID, q string, page, perPage int, includeArchived bool) (*Page, error) {
	page, perPage = normalizePage(page, perPage)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q = strings.TrimSpace(q)
	// $1 = tenant, $2 = query term. subscriberFreeTextPredicate is the shared
	// predicate the List endpoint's optional ?q also uses, so the two
	// stay in lockstep.
	where := `
WHERE tenant_id = $1::uuid
  AND ` + subscriberFreeTextPredicate(2)
	// Hide soft-deleted rows by default. Fixed IS NULL predicate (no bound
	// arg) so the positional $3/$4 LIMIT/OFFSET args stay stable.
	if !includeArchived {
		where += `
  AND archived_at IS NULL`
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers `+where, tenantID, q).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, subscriberSelectSQL+where+`
ORDER BY updated_at DESC
LIMIT $3 OFFSET $4`, tenantID, q, perPage, (page-1)*perPage)
	if err != nil {
		return nil, err
	}
	items, err := scanSubscribers(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &Page{Items: items, Total: total, Page: page, PerPage: perPage}, nil
}

// SearchWithQuery is the FTS + pg_trgm structured-search path (SUB-039).
// Unlike Search (the legacy per-row ILIKE scan), it builds the WHERE from a
// parsed SearchQuery via buildSearchWhere so operator terms — tag:/-tag:,
// @domain, email:, name:, status:, source: — become index-backed predicates
// against the GENERATED search_tsv column and the pg_trgm email index
// (migration 0242). Free text is matched through websearch_to_tsquery.
//
// Tenant scoping is preserved: buildSearchWhere seeds $1 with the tenant id
// and emits `WHERE tenant_id = $1::uuid` as its first part, and the query
// still runs inside a db.WithTenant tx so RLS is enforced regardless. The
// archived filter mirrors Search/ListWithOptions: soft-deleted rows are
// hidden unless includeArchived is true. Pagination is OFFSET-based, matching
// Search's return shape (a full COUNT(*) over the same WHERE as Total).
func (r *Repo) SearchWithQuery(ctx context.Context, tenantID string, q SearchQuery, page, perPage int, includeArchived bool) (*Page, error) {
	page, perPage = normalizePage(page, perPage)

	// buildSearchWhere seeds $1 = tenant and appends each operator/free-text
	// term as $2, $3, … . The column names it splices are fixed allow-listed
	// strings (never user input); only values bind through placeholders.
	where, args := buildSearchWhere(q, []any{tenantID})
	// Hide soft-deleted rows by default. Fixed IS NULL predicate (no bound
	// arg) so the LIMIT/OFFSET placeholders appended below stay stable.
	if !includeArchived {
		where += `
  AND archived_at IS NULL`
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers `+where, args...).Scan(&total); err != nil {
		return nil, err
	}

	limitArg := len(args) + 1
	offsetArg := len(args) + 2
	args = append(args, perPage, (page-1)*perPage)
	rows, err := tx.Query(ctx, subscriberSelectSQL+where+fmt.Sprintf(`
ORDER BY updated_at DESC, id DESC
LIMIT $%d OFFSET $%d`, limitArg, offsetArg), args...)
	if err != nil {
		return nil, err
	}
	items, err := scanSubscribers(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &Page{Items: items, Total: total, Page: page, PerPage: perPage}, nil
}

// Get fetches by Moosewave UUID or email address.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Subscriber, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return sub, nil
}

// getInTx runs the GET lookup inside an already-open tenant-scoped
// tx. Lets Update reuse one tx for both the lookup and the UPDATE
// (audit perf finding BE-5: prior code did GET → commit → second
// tx for the UPDATE, doubling round-trips + lock contention on
// every PATCH).
func getInTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Subscriber, error) {
	return getInTxWithLock(ctx, tx, tenantID, id, false)
}

func getInTxForUpdate(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Subscriber, error) {
	return getInTxWithLock(ctx, tx, tenantID, id, true)
}

func getInTxWithLock(ctx context.Context, tx pgx.Tx, tenantID, id string, lock bool) (*Subscriber, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	row := tx.QueryRow(ctx, subscriberSelectSQL+`
WHERE tenant_id = $1::uuid
  AND (id::text = $2 OR lower(email::text) = lower($2))`+suffix, tenantID, id)
	sub, err := scanSubscriber(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return sub, nil
}

func (r *Repo) ExistsByEmail(ctx context.Context, tenantID, email string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM subscribers
   WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
)`, tenantID, email).Scan(&exists); err != nil {
		return false, err
	}
	return exists, tx.Commit(ctx)
}

// Upsert creates or replaces a subscriber by tenant+email.
func (r *Repo) Upsert(ctx context.Context, tenantID string, in CreateInput) (*Subscriber, error) {
	return r.upsert(ctx, tenantID, in, nil)
}

// UpsertWithAudit is the request-attributed variant used by mutating HTTP
// surfaces. The audit row is appended in the subscriber transaction, so an
// audit failure rolls back the write instead of leaving an untraceable change.
func (r *Repo) UpsertWithAudit(ctx context.Context, tenantID string, in CreateInput, auditMeta db.AuditMeta) (*Subscriber, error) {
	auditMeta.TenantID = tenantID
	return r.upsert(ctx, tenantID, in, &auditMeta)
}

func (r *Repo) upsert(ctx context.Context, tenantID string, in CreateInput, auditMeta *db.AuditMeta) (*Subscriber, error) {
	// Every caller—not only the public HTTP handler—crosses the same consent
	// boundary. Integration sinks historically bypassed normalizeCreate and
	// could re-enable an unsubscribed profile with status=enabled/api and no
	// evidence. Reject that shape before opening a transaction.
	if err := normalizeCreate(&in); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidInput, err.Error())
	}
	// nil is an omission contract, while a non-nil empty map is an explicit
	// request to clear merge fields. Capture it before validation/marshalling so
	// an email-only create/upsert cannot erase an existing audience profile.
	mergeFieldsProvided := in.MergeFields != nil
	// pgx encodes a nil []string as SQL NULL. subscribers.tags is NOT NULL,
	// and callers that omit the optional JSON field should get the schema's
	// empty-list semantics rather than a persistence failure.
	if in.Tags == nil {
		in.Tags = []string{}
	}
	if strings.TrimSpace(in.MailchimpStatus) == "" {
		in.MailchimpStatus = mailchimpStatusFromListmonk(in.Status)
	}
	if r.CustomFields != nil {
		if cf, err := r.CustomFields.Validate(ctx, tenantID, nonNilMap(in.CustomFields)); err != nil {
			return nil, fmt.Errorf("validate custom_fields: %w", err)
		} else {
			in.CustomFields = cf
		}
	}
	// merge_fields has a separate Mailchimp-compatible schema
	// (merge_field_schema). Database compatibility triggers validate every
	// declared key against that schema and mirror its typed sidecar. Do not run
	// these values through tenant_custom_fields: its strict/auto/off policy and
	// lowercase key grammar belong exclusively to custom_fields.
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	previousSub, previousTags, err := r.upsertPreviousState(ctx, tx, tenantID, in.Email, auditMeta)
	if err != nil {
		return nil, err
	}

	customRaw, _ := json.Marshal(nonNilMap(in.CustomFields))
	mergeRaw, _ := json.Marshal(nonNilMap(in.MergeFields))
	groupsRaw, _ := json.Marshal(nonNilSliceMap(in.Groups))
	gdprRaw, _ := json.Marshal(nonNilSliceMap(in.GDPRPermissions))
	summaryRaw, _ := json.Marshal(nonNilMap(in.ActivitySummary))
	// Derive first/last/full/display name columns (SUB-004) from the
	// explicit input fields, falling back to merge_fields FNAME/LNAME
	// (Mailchimp) and custom_fields first_name/last_name (Klaviyo).
	names := deriveNames(in)
	row := tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, consent_timestamp, consent_source,
    custom_fields, tags, source_id, source_platform, mailchimp_status,
    merge_fields, groups, gdpr_permissions, signup_ip, unsubscribe_reason,
    mailchimp_last_changed, activity_summary,
    first_name, last_name, full_name, display_name,
    locale, language, country, region
)
VALUES (
    -- SUB-016: primary_email defaults to the canonical email on insert,
    -- mirroring migration 0452's backfill so a freshly created subscriber
    -- carries a non-empty primary_email. The multi-email set-primary path
    -- re-points it when a different address is promoted.
    $1::uuid, $2, $2, $3, $4, $5, $6::jsonb, $7, NULLIF($8, ''), NULLIF($9, ''),
    $10, $11::jsonb, $12::jsonb, $13::jsonb, NULLIF($14, '')::inet,
    NULLIF($15, ''), $16, $17::jsonb,
    $18, $19, $20, $21,
    NULLIF($22, ''), NULLIF($23, ''), NULLIF($24, ''), NULLIF($25, '')
)
ON CONFLICT (tenant_id, email) DO UPDATE SET
    status = CASE WHEN $27::boolean THEN subscribers.status ELSE EXCLUDED.status END,
    consent_timestamp = CASE WHEN $27::boolean THEN subscribers.consent_timestamp ELSE EXCLUDED.consent_timestamp END,
    consent_source = CASE WHEN $27::boolean THEN subscribers.consent_source ELSE EXCLUDED.consent_source END,
    custom_fields = EXCLUDED.custom_fields,
    tags = EXCLUDED.tags,
    source_id = EXCLUDED.source_id,
    source_platform = EXCLUDED.source_platform,
    mailchimp_status = CASE WHEN $27::boolean THEN subscribers.mailchimp_status ELSE EXCLUDED.mailchimp_status END,
    merge_fields = CASE
        WHEN $26::boolean THEN EXCLUDED.merge_fields
        ELSE subscribers.merge_fields
    END,
    groups = EXCLUDED.groups,
    gdpr_permissions = EXCLUDED.gdpr_permissions,
    signup_ip = EXCLUDED.signup_ip,
    unsubscribe_reason = CASE WHEN $27::boolean THEN subscribers.unsubscribe_reason ELSE EXCLUDED.unsubscribe_reason END,
    mailchimp_last_changed = EXCLUDED.mailchimp_last_changed,
    activity_summary = EXCLUDED.activity_summary,
    first_name = CASE
        WHEN $26::boolean THEN EXCLUDED.first_name
        ELSE COALESCE(
            NULLIF(BTRIM(EXCLUDED.first_name), ''),
            NULLIF(BTRIM(subscribers.merge_fields ->> 'FNAME'), ''),
            NULLIF(BTRIM(subscribers.first_name), ''),
            ''
        )
    END,
    last_name = CASE
        WHEN $26::boolean THEN EXCLUDED.last_name
        ELSE COALESCE(
            NULLIF(BTRIM(EXCLUDED.last_name), ''),
            NULLIF(BTRIM(subscribers.merge_fields ->> 'LNAME'), ''),
            NULLIF(BTRIM(subscribers.last_name), ''),
            ''
        )
    END,
    full_name = CASE
        WHEN $26::boolean THEN EXCLUDED.full_name
        ELSE COALESCE(
            NULLIF(BTRIM(EXCLUDED.full_name), ''),
            NULLIF(BTRIM(CONCAT_WS(' ',
                COALESCE(NULLIF(BTRIM(subscribers.merge_fields ->> 'FNAME'), ''), NULLIF(BTRIM(subscribers.first_name), '')),
                COALESCE(NULLIF(BTRIM(subscribers.merge_fields ->> 'LNAME'), ''), NULLIF(BTRIM(subscribers.last_name), ''))
            )), ''),
            NULLIF(BTRIM(subscribers.full_name), ''),
            ''
        )
    END,
    display_name = CASE
        WHEN $26::boolean THEN EXCLUDED.display_name
        ELSE COALESCE(
            NULLIF(BTRIM(EXCLUDED.display_name), ''),
            NULLIF(BTRIM(CONCAT_WS(' ',
                COALESCE(NULLIF(BTRIM(subscribers.merge_fields ->> 'FNAME'), ''), NULLIF(BTRIM(subscribers.first_name), '')),
                COALESCE(NULLIF(BTRIM(subscribers.merge_fields ->> 'LNAME'), ''), NULLIF(BTRIM(subscribers.last_name), ''))
            )), ''),
            NULLIF(BTRIM(subscribers.display_name), ''),
            ''
        )
    END,
    locale = EXCLUDED.locale,
    language = EXCLUDED.language,
    country = EXCLUDED.country,
    region = EXCLUDED.region,
    updated_at = now()
RETURNING `+subscriberColumns,
		tenantID, in.Email, in.Status, in.ConsentTimestamp, in.ConsentSource,
		string(customRaw), in.Tags, in.SourceID, in.SourcePlatform, in.MailchimpStatus,
		string(mergeRaw), string(groupsRaw), string(gdprRaw), in.SignupIP,
		in.UnsubscribeReason, in.MailchimpLastChanged, string(summaryRaw),
		names.first, names.last, names.full, names.display,
		in.Locale, in.Language, in.Country, in.Region, mergeFieldsProvided, in.PreserveConsentState)
	sub, err := scanSubscriber(row)
	if err != nil {
		return nil, err
	}
	// Preserve insert-vs-update before consent projection triggers legitimately
	// advance updated_at later in this transaction.
	wasCreated := sub.CreatedAt.Equal(sub.UpdatedAt)
	if r.TagHistory != nil {
		added, removed := tagDelta(previousTags, sub.Tags)
		if len(added) > 0 || len(removed) > 0 {
			if err := r.TagHistory.EmitSubscriberTagDelta(ctx, tx, tenantID, sub.ID, added, removed, "", "subscriber_upsert"); err != nil {
				return nil, fmt.Errorf("emit tag history: %w", err)
			}
		}
	}
	// Attribute history (SUB-008): per-field before/after snapshot,
	// dual-written in the same tx. previousSub is nil on a fresh insert —
	// diffSubscriberAttributes treats that as an empty before, so a new
	// row logs only its non-empty attributes.
	if r.AttributeHistory {
		if changes := diffSubscriberAttributes(previousSub, sub); len(changes) > 0 {
			if err := emitAttributeHistory(ctx, tx, tenantID, sub.ID, changes, "", "subscriber_upsert"); err != nil {
				return nil, err
			}
		}
	}
	jurisdictionDrift, err := r.stampJurisdictionDriftInTx(ctx, tx, tenantID, sub)
	if err != nil {
		return nil, err
	}
	// SUB-117: keep the normalized subscriber_group_memberships junction in
	// lockstep with the groups jsonb just written. Same tx; best-effort
	// (no-op pre-1112).
	if err := syncGroupMembershipsFromJSONB(ctx, tx, tenantID, sub.ID, sub.Groups); err != nil {
		return nil, err
	}
	// SUB-120: persist any GPP sections supplied at create/update time into
	// the subscriber's gpp_sections jsonb, inside this same tx so the section
	// write + audit rows commit atomically with the subscriber row. nil/empty
	// is a no-op (column stays at its '{}' default). source="api" mirrors the
	// generic PATCH gpp-merge convention; the dedicated POST/PATCH
	// /subscribers/{id}/gpp endpoints remain the primary CMP/override paths.
	if len(in.GppSections) > 0 {
		gpp, gerr := setGppSectionsInTx(ctx, tx, tenantID, sub.ID, in.GppSections, "api")
		if gerr != nil {
			return nil, fmt.Errorf("apply gpp_sections on upsert: %w", gerr)
		}
		sub.GppSections = gpp.Sections
	}
	canonicalAddress, err := ensureCanonicalSubscriberEmailForEvidenceInTx(
		ctx, tx, tenantID, sub,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEmailTaken
		}
		return nil, fmt.Errorf("ensure canonical subscriber email row: %w", err)
	}
	if completeEmailConsentGrant(in) {
		if err := r.grantUpsertConsentInTx(ctx, tx, tenantID, sub, canonicalAddress, in); err != nil {
			return nil, err
		}
	}
	if err := r.fireUpsertWebhooksInTx(ctx, tx, tenantID, sub, wasCreated, jurisdictionDrift); err != nil {
		return nil, err
	}
	if auditMeta != nil {
		action := "subscriber.updated"
		if wasCreated {
			action = "subscriber.created"
		}
		metadata := subscriberMutationAuditMetadata(previousSub, sub)
		metadata["operation"] = "subscriber_upsert"
		metadata["status"] = sub.Status
		if err := db.Audit(ctx, tx, *auditMeta, action, "subscriber", sub.ID, metadata); err != nil {
			return nil, fmt.Errorf("audit subscriber upsert: %w", err)
		}
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, sub.ID, ""); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	r.inferDemographicsPostCommit(ctx, tenantID, sub)
	// Legacy pre-1762 compatibility hook. Production leaves PIIScanner nil;
	// durable database intents cover this and every other writer transactionally.
	r.scanPII(ctx, tenantID, sub)
	return sub, nil
}

// upsertPreviousState runs the erasure-suppression pre-check and, when a
// history or audit consumer needs it, captures the pre-write row (or just its
// tags) so deltas can be computed after INSERT ... ON CONFLICT. previousSub is
// nil when the row is new or neither attribute history nor auditing is on.
func (r *Repo) upsertPreviousState(ctx context.Context, tx pgx.Tx, tenantID, email string, auditMeta *db.AuditMeta) (*Subscriber, []string, error) {
	// Erasure pre-check (subscriber-merge CRITICAL #1). A contact delete or a
	// privacy request leaves an irreversible tombstone; refuse the upsert with
	// ErrErasureBlocked so the handler can explain the refusal instead of
	// silently re-creating the row.
	//
	// Non-erasure suppressions (bounce, complaint, manual) DON'T block the
	// upsert — they just prevent sends downstream. Re-importing a bounced
	// address into the active list is legitimate (the operator may have new
	// consent and a different email service).
	if err := rejectErasedAddress(ctx, tx, tenantID, email); err != nil {
		return nil, nil, err
	}

	var previousID string
	var previousTags []string
	// Full before-snapshot for attribute history (SUB-008).
	var previousSub *Subscriber
	if r.TagHistory != nil || r.AttributeHistory || auditMeta != nil {
		if r.AttributeHistory || auditMeta != nil {
			prev, err := getInTx(ctx, tx, tenantID, email)
			if err != nil && !errors.Is(err, ErrNotFound) {
				return nil, nil, err
			}
			if prev != nil {
				previousSub = prev
				previousID = prev.ID
				previousTags = append([]string(nil), prev.Tags...)
			}
		} else {
			err := tx.QueryRow(ctx, `
SELECT id::text, COALESCE(tags, ARRAY[]::text[])
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)`,
				tenantID, email).Scan(&previousID, &previousTags)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, nil, err
			}
		}
	}
	return previousSub, previousTags, nil
}

// stampJurisdictionDriftInTx implements SUB-055 jurisdiction-change detection.
// When a detector is wired, infer the subject's country from signup_ip and
// compare it against the stored country. On a drift into a stricter consent
// regime, stamp the three jurisdiction columns inside this same tx so the
// returned row reflects the flag — the handler/UI then surfaces the
// re-confirmation banner. It returns whether re-confirmation is now required.
// A detector with no signup_ip (or an undetectable IP) is a no-op.
func (r *Repo) stampJurisdictionDriftInTx(ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber) (bool, error) {
	if r.Jurisdiction == nil || strings.TrimSpace(sub.SignupIP) == "" {
		return false, nil
	}
	inferred, changed, reconfirm := r.Jurisdiction.DetectDrift(
		derefOrEmpty(sub.Country), derefOrEmpty(sub.Region), sub.SignupIP)
	if !changed || inferred == "" {
		return false, nil
	}
	if err := tx.QueryRow(ctx, `
UPDATE subscribers
   SET detected_jurisdiction          = $3,
       jurisdiction_changed_at         = now(),
       jurisdiction_reconfirm_required = $4
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING detected_jurisdiction, jurisdiction_changed_at, jurisdiction_reconfirm_required`,
		tenantID, sub.ID, inferred, reconfirm).Scan(
		&sub.DetectedJurisdiction, &sub.JurisdictionChangedAt, &sub.JurisdictionReconfirmRequired); err != nil {
		return false, fmt.Errorf("stamp jurisdiction drift: %w", err)
	}
	return reconfirm, nil
}

// completeEmailConsentGrant reports whether a create carries the complete
// exact-address consent envelope that lets the upsert append consent evidence.
func completeEmailConsentGrant(in CreateInput) bool {
	return in.Status == StatusEnabled && in.ConsentTimestamp != nil &&
		in.ConsentChannel != "" && in.ConsentLegalBasis != "" &&
		in.ConsentEvidence != "" && in.ConsentReason != "" &&
		in.ConsentPolicyVersion != ""
}

// grantUpsertConsentInTx appends the create-time consent evidence, clears this
// workflow's own reversible consent-status hold, fires the consent webhook, and
// refreshes the purpose projection on the returned row so clients never
// receive a stale nil purpose grant immediately after a successful create.
func (r *Repo) grantUpsertConsentInTx(ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber, canonicalAddress *SubscriberEmail, in CreateInput) error {
	consentEventID, err := recordEmailConsentEvidence(ctx, tx, tenantID, sub, canonicalAddress, "subscribed", ConsentProvenanceInput{
		Source:        in.ConsentSource,
		Channel:       in.ConsentChannel,
		LegalBasis:    in.ConsentLegalBasis,
		OccurredAt:    in.ConsentTimestamp,
		Jurisdiction:  in.Country,
		Evidence:      in.ConsentEvidence,
		Reason:        in.ConsentReason,
		PolicyVersion: in.ConsentPolicyVersion,
	}, "subscriber_create", db.AuditMeta{
		TenantID:   tenantID,
		IP:         in.SignupIP,
		ActorType:  "system",
		ActorLabel: "subscriber-upsert",
	})
	if err != nil {
		return fmt.Errorf("append create consent evidence: %w", err)
	}
	if err := clearEmailConsentStatusSuppression(ctx, tx, tenantID, canonicalAddress.Email); err != nil {
		return err
	}
	canonicalAddress, _, err = lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, sub.ID, sub.Email,
	)
	if err != nil {
		return err
	}
	if canonicalAddress == nil {
		return ErrNotFound
	}
	if err := fireEmailConsentWebhook(ctx, r, tx, tenantID, sub, canonicalAddress, consentEventID); err != nil {
		return err
	}
	// The purpose-projection trigger runs after the immutable event insert.
	// Refresh the returned/webhooked representation so clients never receive
	// a stale nil purpose grant immediately after a successful create.
	if err := tx.QueryRow(ctx, `
SELECT consent_email_marketing_at, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, sub.ID).Scan(
		&sub.ConsentEmailMarketingAt, &sub.UpdatedAt); err != nil {
		return fmt.Errorf("refresh create consent projection: %w", err)
	}
	return nil
}

// fireUpsertWebhooksInTx fires webhooks INSIDE the same tx and only after every
// derived consent/GPP projection is current, so receivers never observe a
// partial subscriber. Insert vs update is detected via timestamp parity:
// ON CONFLICT DO UPDATE sets updated_at while CreatedAt stays at the original
// insert time.
func (r *Repo) fireUpsertWebhooksInTx(ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber, wasCreated, jurisdictionDrift bool) error {
	if r.Webhooks == nil {
		return nil
	}
	event := EventSubscriberUpdated
	if wasCreated {
		event = EventSubscriberCreated
	}
	idempotencyKey := ""
	if wasCreated {
		idempotencyKey = "subscriber-created:" + sub.ID
	}
	if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
		TenantID:       tenantID,
		EventType:      event,
		Body:           sub,
		IdempotencyKey: idempotencyKey,
	}); err != nil {
		return fmt.Errorf("dispatch webhook: %w", err)
	}
	// SUB-055: emit a dedicated jurisdiction-changed webhook so receivers
	// can drive a re-confirmation flow without diffing every .updated.
	if jurisdictionDrift {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:  tenantID,
			EventType: EventSubscriberJurisdictionChanged,
			Body:      sub,
		}); err != nil {
			return fmt.Errorf("dispatch jurisdiction webhook: %w", err)
		}
	}
	return nil
}

// inferDemographicsPostCommit (SUB-063) runs the optional demographic-inference
// predictor over the subject's name after the subscriber row has committed and
// stamps the confidence-labelled inferred_* traits onto
// subscriber_computed_traits. Best-effort + post-commit (a separate
// trait-upsert tx): a predictor hiccup must not fail the subscriber write, and
// an absent predictor is a no-op. nil-predictor-safe.
func (r *Repo) inferDemographicsPostCommit(ctx context.Context, tenantID string, sub *Subscriber) {
	if r.Demographics == nil {
		return
	}
	// Prefer the full name (so the predictor can extract a first token);
	// fall back to first name alone. applyDemographicInference is a no-op
	// when the name is empty or nothing could be inferred.
	name := strings.TrimSpace(sub.FullName)
	if name == "" {
		name = strings.TrimSpace(sub.FirstName)
	}
	if name != "" {
		_ = r.applyDemographicInference(ctx, tenantID, sub.ID, name)
	}
}

// scanPII runs only the optional legacy compatibility scanner over a committed
// subscriber. It is intentionally nil in production; the durable 1762 path
// does not call this method.
func (r *Repo) scanPII(ctx context.Context, tenantID string, sub *Subscriber) {
	if r.PIIScanner == nil || sub == nil {
		return
	}
	fields := scannableFreeText(sub)
	if len(fields) == 0 {
		return
	}
	_, _ = r.PIIScanner.ScanSubscriber(ctx, tenantID, sub.ID, fields)
}

// scannableFreeText assembles the free-text field map the shadow-PII scanner
// inspects: the subscriber's custom_fields + merge_fields plus the derived
// name columns and unsubscribe_reason. The name/reason columns are folded in
// under reserved keys so an SSN typed into "full name" or a card number left
// in an unsubscribe reason is still surfaced. custom/merge keys win on
// collision (they are the operator's declared field names).
func scannableFreeText(sub *Subscriber) map[string]any {
	out := make(map[string]any, len(sub.CustomFields)+len(sub.MergeFields)+5)
	addNonEmpty := func(k, v string) {
		if strings.TrimSpace(v) != "" {
			out[k] = v
		}
	}
	addNonEmpty("first_name", sub.FirstName)
	addNonEmpty("last_name", sub.LastName)
	addNonEmpty("full_name", sub.FullName)
	addNonEmpty("display_name", sub.DisplayName)
	addNonEmpty("unsubscribe_reason", sub.UnsubscribeReason)
	for k, v := range sub.MergeFields {
		out[k] = v
	}
	for k, v := range sub.CustomFields {
		out[k] = v
	}
	return out
}

// Event-name constants used by the webhook firing path. Mirrored from
// internal/webhooks; kept here as plain strings so this package doesn't
// import that one.
const (
	EventSubscriberCreated             = "subscriber.created"
	EventSubscriberUpdated             = "subscriber.updated"
	EventSubscriberUnsubscribed        = "subscriber.unsubscribed"
	EventSubscriberMerged              = "subscriber.merged"
	EventSubscriberJurisdictionChanged = "subscriber.jurisdiction_changed"
	// SUB-118 — lifecycle webhook coverage gaps. These four close the catalog
	// so a tenant can subscribe to the full subscriber lifecycle:
	//   - deleted:         fired from the Delete path (erasure).
	//   - status_changed:  fired from Update/SetStatus when the status column
	//     transitions to a *different* value (distinct from .unsubscribed,
	//     which is only the final-stop transition).
	//   - consent_changed: fired from Update when consent_source /
	//     consent_timestamp move.
	//   - merged is already defined above.
	EventSubscriberDeleted        = "subscriber.deleted"
	EventSubscriberStatusChanged  = "subscriber.status_changed"
	EventSubscriberConsentChanged = "subscriber.consent_changed"
	// SUB-119 — subscriber.confirmed is defined in the webhook catalog
	// (internal/webhooks) but had no producer. The double-opt-in confirmation
	// is, in Moosewave's status model, the transition from 'unconfirmed' to
	// 'enabled'. Update/SetStatus detect that transition and fire this event on
	// BOTH the outbound webhook and the SSE Bus.
	EventSubscriberConfirmed = "subscriber.confirmed"
	// SUB-096 — subscriber.engagement_updated drives the live open/click
	// counter increments on the subscriber detail slideover. It is emitted on
	// the SSE Bus (NOT the outbound webhook catalog — it is a UI-affordance
	// event, not a durable lifecycle event) whenever a new open/click event is
	// durably ingested for a subscriber. The payload carries the subscriber's
	// id + email + the triggering event_type plus a fresh 90-day counter
	// rollup (sends/opens/clicks) so the slideover can update without polling.
	EventSubscriberEngagementUpdated = "subscriber.engagement_updated"
)

// emitBus publishes a subscriber.* event to the optional SSE Bus (SUB-119).
// nil-safe: a nil Bus or empty tenant is a no-op. Call AFTER a successful
// commit so the Bus never advertises a mutation that was rolled back.
func (r *Repo) emitBus(tenantID, topic string, payload map[string]any) {
	if r == nil || r.Bus == nil || tenantID == "" {
		return
	}
	r.Bus.Publish(tenantID, topic, payload)
}

// isConfirmationTransition reports whether prev→next is a double-opt-in
// confirmation in Moosewave's status model: a subscriber leaving the
// 'unconfirmed' state for the deliverable 'enabled' state (SUB-119).
func isConfirmationTransition(prev, next string) bool {
	return prev == StatusUnconfirmed && next == StatusEnabled
}

func tagDelta(before, after []string) (added, removed []string) {
	before = normalizeTags(before)
	after = normalizeTags(after)
	beforeSet := make(map[string]string, len(before))
	afterSet := make(map[string]string, len(after))
	for _, tag := range before {
		beforeSet[strings.ToLower(tag)] = tag
	}
	for _, tag := range after {
		afterSet[strings.ToLower(tag)] = tag
	}
	for key, tag := range afterSet {
		if _, ok := beforeSet[key]; !ok {
			added = append(added, tag)
		}
	}
	for key, tag := range beforeSet {
		if _, ok := afterSet[key]; !ok {
			removed = append(removed, tag)
		}
	}
	return added, removed
}

// subscriberMutationAuditMetadata deliberately records field names and
// cardinalities, never raw subscriber values. The attribute-history table owns
// the encrypted/retained before/after detail; audit_log answers who changed
// which classes of data without duplicating PII.
func subscriberMutationAuditMetadata(before, after *Subscriber) map[string]any {
	changes := diffSubscriberAttributes(before, after)
	changed := make([]string, 0, len(changes)+1)
	piiChanged := false
	for _, change := range changes {
		changed = append(changed, change.field)
		if isPIIAuditField(change.field) {
			piiChanged = true
		}
	}
	var beforeTags []string
	if before != nil {
		beforeTags = before.Tags
	}
	var afterTags []string
	if after != nil {
		afterTags = after.Tags
	}
	addedTags, removedTags := tagDelta(beforeTags, afterTags)
	if len(addedTags) > 0 || len(removedTags) > 0 {
		changed = append(changed, "tags")
	}
	return map[string]any{
		"changed_fields":     changed,
		"pii_changed":        piiChanged,
		"tags_added_count":   len(addedTags),
		"tags_removed_count": len(removedTags),
	}
}

// SetStatus updates a non-sendable status and returns the resulting row.
// Enabling is intentionally unavailable on this evidence-free convenience
// path; callers must use Update with the complete exact-address consent
// envelope so status, address grant, proof, and purpose projection co-commit.
func (r *Repo) SetStatus(ctx context.Context, tenantID, id, status string) (*Subscriber, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	if !validStatus(status) {
		return nil, fmt.Errorf("%w: invalid status", ErrInvalidInput)
	}
	if status == StatusEnabled {
		return nil, fmt.Errorf("%w: enabling requires Update with reviewed consent evidence", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// SUB-118: snapshot the prior status so we can emit subscriber.status_changed
	// only on an actual transition. A missing row leaves prevStatus empty; the
	// UPDATE below returns ErrNotFound in that case so we never fire.
	var prevStatus string
	_ = tx.QueryRow(ctx, `
SELECT status FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 LIMIT 1`, tenantID, id).Scan(&prevStatus)

	row := tx.QueryRow(ctx, `
UPDATE subscribers
   SET status = $3,
       mailchimp_status = CASE
         WHEN $3 = 'enabled' THEN 'subscribed'
         WHEN $3 = 'disabled' THEN 'unsubscribed'
         WHEN $3 = 'blocklisted' THEN 'cleaned'
         WHEN $3 = 'unconfirmed' THEN 'non_subscribed'
         ELSE mailchimp_status
       END,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
RETURNING `+subscriberColumns, tenantID, id, status)
	sub, err := scanSubscriber(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	isUnsub := status == StatusBlocklisted || status == "unsubscribed"
	if r.Webhooks != nil {
		event := EventSubscriberUpdated
		if isUnsub {
			event = EventSubscriberUnsubscribed
		}
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:       tenantID,
			EventType:      event,
			Body:           sub,
			IdempotencyKey: "subscriber-unsubscribed:" + sub.ID + ":" + sub.Version,
		}); err != nil {
			return nil, fmt.Errorf("dispatch webhook: %w", err)
		}
		// SUB-118: dedicated status_changed on any actual transition.
		if prevStatus != "" && prevStatus != sub.Status {
			if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
				TenantID:  tenantID,
				EventType: EventSubscriberStatusChanged,
				Body:      sub,
			}); err != nil {
				return nil, fmt.Errorf("dispatch status_changed webhook: %w", err)
			}
		}
	}
	// SUB-121: same-tx ledger rows on an unsubscribe via the SetStatus path.
	if r.ConsentSyncLedger != nil && isUnsub {
		if err := r.ConsentSyncLedger.RecordEvent(ctx, tx, tenantID, sub.ID, ConsentSyncEventUnsubscribe); err != nil {
			return nil, fmt.Errorf("record consent sync ledger: %w", err)
		}
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, sub.ID, ""); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return sub, nil
}

// Delete removes by Moosewave UUID or email and returns the deleted row so the
// a durable external-engine deletion tombstone can reconcile after commit.
// Delete erases a subscriber row AND inserts a permanent
// suppression entry so the same email cannot be silently re-imported
// via CSV / API (GDPR audit CRITICAL #2: BulkDelete + single delete
// previously left no suppression, defeating right-to-be-forgotten).
//
// Both writes happen in a single tenant-scoped tx — partial failure
// leaves no orphaned suppression and no half-deleted subscriber.
// The audit row and external deletion intent are part of this same commit.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) (*Subscriber, error) {
	meta := db.AuditMeta{
		TenantID:   tenantID,
		ActorType:  "system",
		ActorLabel: "subscriber-repo-delete",
	}
	return r.delete(ctx, tenantID, id, "", meta)
}

// DeleteWithAudit applies a request-attributed privacy deletion. ifMatchToken
// is compared again under the row lock so a concurrent mutation between the
// handler's fast pre-check and this transaction cannot be erased silently.
func (r *Repo) DeleteWithAudit(
	ctx context.Context,
	tenantID, id, ifMatchToken string,
	auditMeta db.AuditMeta,
) (*Subscriber, error) {
	auditMeta.TenantID = tenantID
	return r.delete(ctx, tenantID, id, ifMatchToken, auditMeta)
}

func (r *Repo) delete(
	ctx context.Context,
	tenantID, id, ifMatchToken string,
	auditMeta db.AuditMeta,
) (*Subscriber, error) {
	if err := pushauthoritylock.EnsureMutationAllowed(ctx); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Deleting a subscriber cascades into push_devices. Take the Route43
	// writer lease before locking the subscriber/address rows so concurrent
	// device registration cannot invert its FK key lock with the cascade.
	if err := pushauthoritylock.Exclusive(ctx, tx, tenantID); err != nil {
		return nil, err
	}
	current, err := getInTxForUpdate(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if ifMatchToken != "" && ifMatchToken != current.Version {
		return nil, ErrPreconditionFailed
	}
	addressRows, err := tx.Query(ctx, `
SELECT email::text
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY (lower(email::text) = lower($3)) DESC, created_at, id
 FOR UPDATE`, tenantID, current.ID, current.Email)
	if err != nil {
		return nil, fmt.Errorf("delete: lock profile addresses: %w", err)
	}
	addresses := make([]string, 0, MaxEmailsPerProfile)
	seenAddress := make(map[string]struct{}, MaxEmailsPerProfile)
	for addressRows.Next() {
		var address string
		if err := addressRows.Scan(&address); err != nil {
			addressRows.Close()
			return nil, fmt.Errorf("delete: read profile address: %w", err)
		}
		normalized := strings.ToLower(strings.TrimSpace(address))
		if normalized == "" {
			continue
		}
		if _, exists := seenAddress[normalized]; !exists {
			seenAddress[normalized] = struct{}{}
			addresses = append(addresses, normalized)
		}
	}
	if err := addressRows.Err(); err != nil {
		addressRows.Close()
		return nil, fmt.Errorf("delete: enumerate profile addresses: %w", err)
	}
	addressRows.Close()
	canonical := strings.ToLower(strings.TrimSpace(current.Email))
	if _, exists := seenAddress[canonical]; !exists {
		addresses = append([]string{canonical}, addresses...)
	}

	row := tx.QueryRow(ctx, `
DELETE FROM subscribers
 WHERE tenant_id = $1::uuid
	AND id = $2::uuid
RETURNING `+subscriberColumns, tenantID, current.ID)
	sub, err := scanSubscriber(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	// Insert a permanent suppression so re-import is a no-op. The
	// `manual` reason is the closest match to operator-initiated
	// erasure in the existing CHECK-constrained vocabulary; the
	// metadata.gdpr_erasure=true tag lets the dashboard surface
	// "erased" status distinctly from "manually unsubscribed".
	if _, err := tx.Exec(ctx, `
INSERT INTO email_suppressions
       (tenant_id, email, reason, source, metadata)
SELECT $1::uuid, address, 'manual', 'gdpr_delete',
        jsonb_strip_nulls(jsonb_build_object(
          'gdpr_erasure', true,
          'deleted_at', now(),
          'deleted_subscriber_id', $3::text,
          'listmonk_id', NULLIF($4::bigint, 0),
          'is_canonical', lower(address) = lower($5)
        ))
  FROM unnest($2::text[]) AS address
ON CONFLICT (tenant_id, email, reason) DO UPDATE SET
       metadata = email_suppressions.metadata || EXCLUDED.metadata,
       suppressed_at = now()`,
		tenantID, addresses, sub.ID, listmonkIDFromCustomFields(sub.CustomFields), sub.Email); err != nil {
		return nil, fmt.Errorf("delete: write suppression: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_suppressions
       (tenant_id, email, reason, source, metadata)
SELECT $1::uuid, address, 'dsar_deletion', 'api',
        jsonb_strip_nulls(jsonb_build_object(
          'gdpr_erasure', true,
          'deleted_at', now(),
          'deleted_subscriber_id', $3::text,
          'listmonk_id', NULLIF($4::bigint, 0),
          'is_canonical', lower(address) = lower($5)
        ))
  FROM unnest($2::text[]) AS address
ON CONFLICT (tenant_id, email) DO UPDATE SET
       reason = 'dsar_deletion', source = 'api', expires_at = NULL,
       metadata = subscriber_suppressions.metadata || EXCLUDED.metadata`,
		tenantID, addresses, sub.ID, listmonkIDFromCustomFields(sub.CustomFields), sub.Email); err != nil {
		return nil, fmt.Errorf("delete: write canonical suppression: %w", err)
	}

	// SUB-046: dual-write a machine-readable erasure receipt in the SAME tx so
	// an erasure can never be performed without its proof artifact. We persist
	// only non-reversible tokens (a redacted {hash}@{domain} label + a SHA-256
	// hash of the cleartext) — never the cleartext itself, since the address is
	// being forgotten. The receipt reuses the audit_log row (written by the
	// handler) via metadata for the regulator trail; this row is the fetchable
	// proof for downstream DSAR tools (W3C DPV consent-27560).
	if err := writeErasureReceipt(ctx, tx, tenantID, sub); err != nil {
		return nil, fmt.Errorf("delete: write erasure receipt: %w", err)
	}

	// SUB-118: fire subscriber.deleted inside the same tx as the row removal +
	// suppression write, so a receiver never sees a delete event for a row
	// that didn't actually erase. Distinct from the SSE subscriber.removed
	// emitted by the handler — this is the outbound-webhook lifecycle event.
	if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:       tenantID,
			EventType:      EventSubscriberDeleted,
			Body:           sub,
			IdempotencyKey: "subscriber-deleted:" + sub.ID,
		}); err != nil {
			return nil, fmt.Errorf("dispatch deleted webhook: %w", err)
		}
	}
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.deleted", "subscriber", sub.ID, map[string]any{
		"email_redacted":    observability.RedactEmail(sub.Email),
		"prev_status":       sub.Status,
		"suppression_added": true,
	}); err != nil {
		return nil, fmt.Errorf("delete: append audit: %w", err)
	}
	if err := r.appendEngineDelete(ctx, tx, tenantID, sub.ID); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return sub, nil
}

// subscriberColumns is the single source of truth for the projected
// subscriber columns, shared by the SELECT path (subscriberSelectSQL) and
// every RETURNING clause (Upsert/Update/SetStatus/Delete). Keep this in
// lockstep with scanSubscriber's Scan order — adding a column here means
// adding a scan target there.
const subscriberColumns = `id::text, email::text, status, mailchimp_status, consent_timestamp, consent_source,
       custom_fields, merge_fields, tags, groups, gdpr_permissions,
       COALESCE(host(signup_ip), ''), COALESCE(unsubscribe_reason, ''),
       mailchimp_last_changed, activity_summary,
       COALESCE(source_id, ''), COALESCE(source_platform, ''),
       first_name, last_name, full_name, display_name,
       locale, language, country, region,
       COALESCE(external_id, ''),
       account_id::text,
       COALESCE(profile_id::text, ''),
       created_at, updated_at, archived_at,
       COALESCE(primary_email::text, ''),
       consent_email_marketing_at, consent_sms_marketing_at,
       consent_profiling_at, consent_targeted_ads_at, consent_ai_processing_at,
       data_region,
       detected_jurisdiction, jurisdiction_changed_at, jurisdiction_reconfirm_required,
       COALESCE(frequency_preference, 'default'), paused_until,
       engagement_score, churn_score, rating`

const subscriberSelectSQL = `
SELECT ` + subscriberColumns + `
FROM subscribers
`

const suppressionSelectSQL = `
SELECT ` + suppressionColumns + `
FROM email_suppressions
`

const suppressionColumns = `id::text, email::text, reason, source,
       COALESCE(provider_event_id, ''), COALESCE(campaign_id::text, ''),
       metadata, suppressed_at, expires_at, created_at`

func scanSubscribers(rows pgx.Rows) ([]Subscriber, error) {
	defer rows.Close()
	out := []Subscriber{}
	for rows.Next() {
		sub, err := scanSubscriber(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sub)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanSuppressions(rows pgx.Rows) ([]Suppression, error) {
	defer rows.Close()
	out := []Suppression{}
	for rows.Next() {
		s, err := scanSuppression(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanSubscriber(row scanner) (*Subscriber, error) {
	var s Subscriber
	var customRaw, mergeRaw, groupsRaw, gdprRaw, summaryRaw []byte
	var externalID string
	if err := row.Scan(
		&s.ID,
		&s.Email,
		&s.Status,
		&s.MailchimpStatus,
		&s.ConsentTimestamp,
		&s.ConsentSource,
		&customRaw,
		&mergeRaw,
		&s.Tags,
		&groupsRaw,
		&gdprRaw,
		&s.SignupIP,
		&s.UnsubscribeReason,
		&s.MailchimpLastChanged,
		&summaryRaw,
		&s.SourceID,
		&s.SourcePlatform,
		&s.FirstName,
		&s.LastName,
		&s.FullName,
		&s.DisplayName,
		&s.Locale,
		&s.Language,
		&s.Country,
		&s.Region,
		&externalID,
		&s.AccountID,
		&s.ProfileID,
		&s.CreatedAt,
		&s.UpdatedAt,
		&s.ArchivedAt,
		&s.PrimaryEmail,
		&s.ConsentEmailMarketingAt,
		&s.ConsentSMSMarketingAt,
		&s.ConsentProfilingAt,
		&s.ConsentTargetedAdsAt,
		&s.ConsentAIProcessingAt,
		&s.DataRegion,
		&s.DetectedJurisdiction,
		&s.JurisdictionChangedAt,
		&s.JurisdictionReconfirmRequired,
		&s.FrequencyPreference,
		&s.PausedUntil,
		&s.EngagementScore,
		&s.ChurnScore,
		&s.Rating,
	); err != nil {
		return nil, err
	}
	s.CustomFields = map[string]any{}
	if len(customRaw) > 0 {
		if err := json.Unmarshal(customRaw, &s.CustomFields); err != nil {
			return nil, fmt.Errorf("decode custom_fields: %w", err)
		}
	}
	s.MergeFields = map[string]any{}
	if len(mergeRaw) > 0 {
		if err := json.Unmarshal(mergeRaw, &s.MergeFields); err != nil {
			return nil, fmt.Errorf("decode merge_fields: %w", err)
		}
	}
	s.Groups = []map[string]any{}
	if len(groupsRaw) > 0 {
		if err := json.Unmarshal(groupsRaw, &s.Groups); err != nil {
			return nil, fmt.Errorf("decode groups: %w", err)
		}
	}
	permissions, err := gdprpermissions.Decode(gdprRaw)
	if err != nil {
		return nil, fmt.Errorf("decode gdpr_permissions: %w", err)
	}
	s.GDPRPermissions = permissions
	s.ActivitySummary = map[string]any{}
	if len(summaryRaw) > 0 {
		if err := json.Unmarshal(summaryRaw, &s.ActivitySummary); err != nil {
			return nil, fmt.Errorf("decode activity_summary: %w", err)
		}
	}
	if s.Tags == nil {
		s.Tags = []string{}
	}
	if s.MailchimpStatus == "" {
		s.MailchimpStatus = mailchimpStatusFromListmonk(s.Status)
	}
	if strings.TrimSpace(externalID) != "" {
		s.ExternalID = &externalID
	}
	s.Version = httpcache.ConcurrencyToken("subscriber", s.ID, s.UpdatedAt)
	return &s, nil
}

func scanSuppression(row scanner) (*Suppression, error) {
	var s Suppression
	var metaRaw []byte
	if err := row.Scan(&s.ID, &s.Email, &s.Reason, &s.Source, &s.ProviderEventID, &s.CampaignID, &metaRaw, &s.SuppressedAt, &s.ExpiresAt, &s.CreatedAt); err != nil {
		return nil, err
	}
	s.Metadata = map[string]any{}
	if len(metaRaw) > 0 {
		if err := json.Unmarshal(metaRaw, &s.Metadata); err != nil {
			return nil, fmt.Errorf("decode suppression metadata: %w", err)
		}
	}
	return &s, nil
}

// ListSubscriberTopics returns the per-topic opt-in state for a subscriber
// (SUB-134), keyed by the subscriber's email. Topics with no explicit
// subscriber_topics row fall back to the topic's default_opt_in. Mirrors the
// query in preferences.Repo.ListSubscriberTopics but returns the subscribers-
// package SubscriberTopicView so the detail GET can hydrate PreferenceTopics
// without importing the preferences package. Tables (topics / subscriber_topics)
// already exist from migration 0016 — no migration needed.
func (r *Repo) ListSubscriberTopics(ctx context.Context, tenantID, email string) ([]SubscriberTopicView, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT t.id::text, t.slug, t.name, COALESCE(t.description, ''),
       t.default_opt_in, t.display_order,
       COALESCE(st.opted_in, t.default_opt_in) AS opted_in
FROM topics t
LEFT JOIN subscriber_topics st
    ON st.tenant_id = t.tenant_id
   AND st.topic_id = t.id
   AND st.subscriber_email = $2::citext
WHERE t.tenant_id = $1::uuid
ORDER BY t.display_order ASC, t.slug ASC`, tenantID, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubscriberTopicView{}
	for rows.Next() {
		var v SubscriberTopicView
		if err := rows.Scan(&v.TopicID, &v.Slug, &v.Name, &v.Description,
			&v.DefaultOptIn, &v.DisplayOrder, &v.OptedIn); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizePage(page, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 50
	}
	if perPage > 200 {
		perPage = 200
	}
	return page, perPage
}

func nonNilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func nonNilSliceMap(v []map[string]any) []map[string]any {
	if v == nil {
		return []map[string]any{}
	}
	return v
}

// copyAnyMap returns a shallow copy of m so a snapshot taken before an
// in-place reassignment doesn't alias the live map. nil in → nil out.
func copyAnyMap(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
