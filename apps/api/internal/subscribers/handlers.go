package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/emailidentity"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/regions"
	"github.com/postwave/postwave/apps/api/internal/sar"
)

const listmonkIDField = "_listmonk_id"
const subscriberJSONMaxBodyBytes int64 = 512 << 10 // 512 KiB

// Engine is the Listmonk HTTP surface needed by subscriber handlers. It stays
// separate from listmonk.Doer so forms tests are not forced to implement
// delete/search methods.
type Engine interface {
	CreateSubscriber(context.Context, listmonk.CreateSubscriberReq) (*listmonk.Subscriber, error)
	UpdateSubscriberStatus(context.Context, int64, listmonk.UpdateSubscriberStatusReq) error
	FindSubscriberByEmail(context.Context, string) (*listmonk.Subscriber, error)
	DeleteSubscriber(context.Context, int64) error
}

// Deps bundles subscriber handler dependencies.
type Deps struct {
	Repo   *Repo
	Engine Engine
	Limits *limits.Enforcer
	// Bus, when non-nil, receives subscriber.* events at the end of
	// mutating handlers. Optional.
	Bus *events.Bus
	// Logger, when non-nil, is used by httperror.WriteInternal to log
	// the raw error text server-side (with tenant_id + request_id
	// enrichment) while keeping the client response generic. Optional
	// — leaving it nil is safe in tests; production wires the shared
	// slog instance.
	Logger *slog.Logger
	// TriggerReplayer, when non-nil, drives the SUB-003 retroactive trigger
	// window after an /identify call that carried an anonymous_id: it emits
	// synthetic 'identified' events for the profile's pre-identification
	// activity within a 72h backward window so automations re-evaluate.
	// Optional — nil disables the replay (the stitch + event reparent still
	// happen inside the identify tx).
	TriggerReplayer TriggerReplayer
	// PIIGateway, when non-nil, backs the SUB-072 PII gateway control plane
	// (GET/PATCH /api/v1/settings/pii-config) + the internal token-lookup
	// endpoint. nil = the surface returns 503 pii_gateway_unconfigured. The
	// concrete *pii_gateway.Repo is wired in main.go.
	PIIGateway PIIGatewayStore
	// GppWebhookSecret, when non-nil, resolves the per-tenant HMAC signing
	// secret used to verify a SUB-120 CMP GPP-ingest webhook. Returns "" when
	// the tenant has no configured secret (the POST /gpp route is already
	// API-key gated, so an unsigned ingest is then accepted). nil disables
	// signature verification entirely.
	GppWebhookSecret func(tenantID string) string
	// VerifyPublicGroupSubject proves that an anonymous storefront caller is
	// authorized to query exactly this subscriber identifier. A public site
	// key alone identifies the tenant but is not subscriber authentication.
	// Production currently leaves the public route unmounted until a
	// tenant-specific signed-subject issuer is available.
	VerifyPublicGroupSubject func(ctx context.Context, siteKey, identifier, proof string) error
	// PlaygroundSubjectAccess keeps the legacy subscriber ZIP export aligned
	// with the canonical SAR bundle's encrypted Route45 receipt section.
	PlaygroundSubjectAccess sar.PlaygroundSubjectAccess
}

// TriggerReplayer is the minimal slice of trigger_replayer.Replayer the
// identify handler needs, kept package-local so subscribers does not import
// the trigger_replayer package (the wiring in main.go adapts the concrete
// type, which already satisfies this shape).
type TriggerReplayer interface {
	RetryIdentifiedEventsWithin(ctx context.Context, tenantID, subscriberEmail string, window time.Duration) (*ReplayResult, error)
}

// ReplayResult mirrors trigger_replayer.ReplayResult so the interface above
// stays import-free. The concrete *trigger_replayer.Replayer returns a
// *trigger_replayer.ReplayResult; main.go's adapter maps it to this type.
type ReplayResult struct {
	EventsInWindow   int
	SyntheticEmitted int
}

// emit publishes a subscriber.* event when the bus is configured. nil-
// safe so tests don't have to thread the broker through.
func (d *Deps) emit(tenantID, topic string, payload map[string]any) {
	if d == nil || d.Bus == nil || tenantID == "" {
		return
	}
	d.Bus.Publish(events.Event{
		Topic:    topic,
		TenantID: tenantID,
		Payload:  payload,
	})
}

// busPublisher adapts an *events.Bus to the repo's package-local
// EventPublisher interface (SUB-119) so the repo can bridge committed
// mutations to the SSE stream without importing events at the repo layer.
// Wire it via subscribers.NewBusPublisher(bus) into Repo.Bus.
type busPublisher struct{ bus *events.Bus }

// NewBusPublisher wraps an *events.Bus as an EventPublisher for Repo.Bus.
// Returns nil when bus is nil so the repo's nil-safe guard keeps holding.
func NewBusPublisher(bus *events.Bus) EventPublisher {
	if bus == nil {
		return nil
	}
	return busPublisher{bus: bus}
}

// Publish forwards a repo-level emit onto the SSE Bus as an events.Event.
func (b busPublisher) Publish(tenantID, topic string, payload map[string]any) {
	if b.bus == nil || tenantID == "" {
		return
	}
	b.bus.Publish(events.Event{
		Topic:    topic,
		TenantID: tenantID,
		Payload:  payload,
	})
}

// MountRead registers read-only subscriber routes. Mutating routes are mounted
// separately so main.go can wrap them in idempotency middleware.
func MountRead(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/subscribers", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/subscribers/search", d.Search)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/suppressions", d.ListSuppressions)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/subscribers/{id}", d.Get)
}

// MountWrite registers mutating subscriber routes.
//
// Each mutating route is wrapped with observability.RecordSurfaceFunc so
// the standardized pw_subscribers_<action>_total counter and
// pw_subscribers_duration_seconds histogram are emitted for every call
// (Phase 4 p4d-recordsurface-wire-subscribers). The action label is the
// stable verb for the route — adding new actions here means adding new
// time series, so keep the verbs snake_case and Prometheus-name-safe.
func MountWrite(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/subscribers",
		observability.RecordSurfaceFunc("subscribers", "create", d.Create))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch("/api/v1/subscribers/{id}",
		observability.RecordSurfaceFunc("subscribers", "update", d.Update))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete("/api/v1/subscribers/{id}",
		observability.RecordSurfaceFunc("subscribers", "delete", d.Delete))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/subscribers/{id}/suppress",
		observability.RecordSurfaceFunc("subscribers", "suppress", d.Suppress))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/suppressions",
		observability.RecordSurfaceFunc("subscribers", "create_suppression", d.CreateSuppression))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete("/api/v1/suppressions/{id}",
		observability.RecordSurfaceFunc("subscribers", "delete_suppression", d.DeleteSuppression))
	// Bulk CSV import: capped at 10k rows; bigger imports use the migration service.
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/subscribers/import",
		observability.RecordSurfaceFunc("subscribers", "import_csv", d.ImportCSV))
	// SUB-089 bulk paste: a raw newline/comma-separated address list pasted into
	// the add-subscriber modal; capped at MaxBulkPasteEmails. Bigger lists use
	// the CSV importer above.
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/subscribers/bulk-paste",
		observability.RecordSurfaceFunc("subscribers", "bulk_paste", d.BulkPaste))
	// Per-record batch upsert (each record carries its own custom_fields /
	// merge_fields / tags) — the shape an API/agent caller needs, distinct
	// from the emails-only CSV import / bulk-paste.
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/subscribers/batch",
		observability.RecordSurfaceFunc("subscribers", "batch_upsert", d.BatchUpsert))
}

// List GET /api/v1/subscribers
//
// All of the following query params are OPTIONAL and combinable; a
// request with none of them is byte-identical to the historic endpoint
// (ORDER BY updated_at DESC, OFFSET paging, full `total`):
//
//	page, per_page  — offset paging (unchanged; default 1 / 50, max 200).
//	q               — free-text search (same ILIKE predicate as /search).
//	status          — exact-match filter; allowed values are the engine
//	                  statuses (enabled/disabled/blocklisted/unconfirmed)
//	                  and the marketing lifecycle states
//	                  (subscribed/unsubscribed/non_subscribed/pending/
//	                  transactional/cleaned/archived/deleted); "bounced" is
//	                  an alias for cleaned. "all" is a no-op. Unknown values
//	                  → 400 invalid_status.
//	sort, order     — sort.allow-list {updated_at, created_at|joined,
//	                  email, status, engagement, first_name, last_name,
//	                  churn|churn_score, rating}; order ∈ {asc, desc}
//	                  (default updated_at desc). Unknown sort silently
//	                  falls back to updated_at; it is never spliced raw.
//	cursor          — opaque keyset cursor for deep paging. Honoured ONLY
//	                  under the default sort; returns next_cursor. A
//	                  malformed cursor → 400 invalid_cursor.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	q := r.URL.Query()
	page, perPage := pageParams(r)

	// Validate status up front so an unknown value is a clear 400 rather
	// than silently returning the unfiltered list. Empty and "all" are
	// allowed no-ops; any other unrecognised value is rejected.
	status := strings.TrimSpace(q.Get("status"))
	if status != "" && !strings.EqualFold(status, "all") {
		if _, _, ok := statusFilterClause(status); !ok {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_status",
				"status must be one of enabled, disabled, blocklisted, unconfirmed, subscribed, unsubscribed, non_subscribed, pending, transactional, cleaned, archived, deleted, bounced, or all"))
			return
		}
	}

	cur, err := decodeListCursor(q.Get("cursor"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}

	out, err := d.Repo.ListWithOptions(r.Context(), t.ID, ListOptions{
		Q:       strings.TrimSpace(q.Get("q")),
		Status:  status,
		Sort:    q.Get("sort"),
		Order:   q.Get("order"),
		Cursor:  cur,
		Page:    page,
		PerPage: perPage,
		// SUB-009: archived (soft-deleted) rows are hidden unless the
		// caller explicitly opts in via ?include_archived=true.
		IncludeArchived: isTruthy(q.Get("include_archived")),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Search GET /api/v1/subscribers/search?q=...
//
// SUB-039: the query is parsed by ParseSearch so operator syntax —
// tag:/-tag:, @domain, email:, name:, status:, source: with negation —
// routes through the FTS + pg_trgm structured path (SearchWithQuery /
// buildSearchWhere against the search_tsv + email-trgm indexes, mig 0242).
// A plain free-text query (no operators) flows through the same path via
// websearch_to_tsquery, so existing callers keep working; an empty q is
// still a 400. A query that parses to nothing actionable (e.g. only a
// half-typed `tag:`) degrades to a 400 rather than scanning the whole list.
func (d *Deps) Search(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_query", "q is required"))
		return
	}
	page, perPage := pageParams(r)
	// SUB-009: archived (soft-deleted) rows are hidden unless the caller
	// explicitly opts in via ?include_archived=true, mirroring List.
	includeArchived := isTruthy(r.URL.Query().Get("include_archived"))

	// SUB-039: parse the box into structured terms + free text. If the parse
	// yields nothing (the raw query was all dropped operators), reject rather
	// than silently returning the full tenant list.
	parsed := ParseSearch(q)
	if parsed.IsEmpty() {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_query", "q is required"))
		return
	}
	out, err := d.Repo.SearchWithQuery(r.Context(), t.ID, parsed, page, perPage, includeArchived)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Get GET /api/v1/subscribers/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	sub, err := d.Repo.Get(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Emit the optimistic-concurrency token (updated_at-based, so unaffected
	// by the hydration steps below) for clients to echo in If-Match.
	w.Header().Set("ETag", httpcache.ConcurrencyToken("subscriber", sub.ID, sub.UpdatedAt))
	// SUB-013: hydrate catalog_attributes inline on the detail GET so the
	// slideover can show favorite_category / last_viewed_sku without a
	// second round-trip. Only attach when at least one trait is present —
	// a subscriber with no catalog history keeps catalog_attributes omitted
	// (omitempty). Best-effort: a trait-fetch failure logs but does not fail
	// the subscriber GET (the core record still returns).
	if attrs, attrErr := d.Repo.GetCatalogAttributes(r.Context(), t.ID, sub.ID); attrErr != nil {
		if d.Logger != nil {
			d.Logger.Warn("hydrate catalog_attributes failed", "subscriber", sub.ID, "err", attrErr.Error())
		}
	} else if attrs != nil && (attrs.FavoriteCategory != nil || attrs.LastViewedSKU != nil) {
		sub.CatalogAttributes = attrs
	}
	// SUB-023: hydrate federated_master_id inline on the detail GET so the
	// list-row/detail badge can show the cross-tenant master link. Best-effort:
	// a link-fetch failure logs but does not fail the subscriber GET (the core
	// record still returns). Empty master id (the common non-federated case)
	// leaves FederatedMasterID nil so it stays omitted from the response.
	if master, mErr := d.Repo.GetFederatedMasterID(r.Context(), t.ID, sub.ID); mErr != nil {
		if d.Logger != nil {
			d.Logger.Warn("hydrate federated_master_id failed", "subscriber", sub.ID, "err", mErr.Error())
		}
	} else if master != "" {
		sub.FederatedMasterID = &master
	}
	// SUB-010: hydrate prediction_model_version + prediction_confidence inline
	// on the detail GET so the slideover can render the Klaviyo-style
	// explainability badge ("scored by churn-xgb-v2, confidence 0.82") without
	// a second round-trip. Best-effort: a metadata-fetch failure logs but does
	// not fail the subscriber GET; absent metadata leaves both fields nil
	// (omitted from JSON). The full per-feature history lives at
	// GET /api/v1/subscribers/{id}/prediction-metadata.
	if pErr := d.Repo.hydratePredictionLineage(r.Context(), t.ID, sub.ID, sub); pErr != nil {
		if d.Logger != nil {
			d.Logger.Warn("hydrate prediction lineage failed", "subscriber", sub.ID, "err", pErr.Error())
		}
	}
	// SUB-059: hydrate the predictive-CLV projection (historic/predicted/total
	// CLV + churn risk + SUB-060 churn drivers) inline on the detail GET so the
	// slideover's Insights section can render first-class CLV without a second
	// round-trip to /api/v1/predictive. Best-effort: a join failure logs but
	// does not fail the GET; an unscored email leaves Prediction nil (omitted).
	if cErr := d.Repo.hydrateCLVPrediction(r.Context(), t.ID, sub); cErr != nil {
		if d.Logger != nil {
			d.Logger.Warn("hydrate clv prediction failed", "subscriber", sub.ID, "err", cErr.Error())
		}
	}
	// SUB-061 / SUB-062: hydrate the replenishment-cadence projection
	// (expected_next_order_at) and the compact repeat-purchase metric
	// (order_cadence_metrics) inline on the detail GET so the slideover can
	// render the "next order expected" + "Repeat Purchase Behavior" cards
	// without a second round-trip. Best-effort: a trait-fetch failure logs but
	// does not fail the GET; a profile with no order cadence leaves both fields
	// nil (omitted). The full cadence read/write surface lives at
	// GET/PATCH /api/v1/subscribers/{id}/replenishment-cadence.
	if oErr := d.Repo.hydrateOrderCadence(r.Context(), t.ID, sub); oErr != nil {
		if d.Logger != nil {
			d.Logger.Warn("hydrate order cadence failed", "subscriber", sub.ID, "err", oErr.Error())
		}
	}
	// SUB-063: hydrate the inferred-demographics projection (gender / age
	// group / interests with confidence labels) inline on the detail GET so
	// the slideover can render the confidence meter without a second round-
	// trip. Best-effort: a trait-fetch failure logs but does not fail the GET;
	// a profile with no inferred demographics leaves the field nil (omitted).
	// The full demographics surface lives at
	// GET /api/v1/subscribers/{id}/demographics.
	if dErr := d.Repo.hydrateDemographics(r.Context(), t.ID, sub); dErr != nil {
		if d.Logger != nil {
			d.Logger.Warn("hydrate demographics failed", "subscriber", sub.ID, "err", dErr.Error())
		}
	}
	// SUB-134: hydrate the per-topic opt-in state inline on the detail GET so
	// the slideover's Preferences tab can render each topic with its current
	// opt-in toggle without a second round-trip to /subscribers/{email}/topics.
	// Best-effort: a topics-fetch failure logs but does not fail the GET; a
	// tenant with no topics leaves PreferenceTopics nil (omitted). Only attach
	// when at least one topic exists so the field stays omitted in the common
	// no-topics case.
	if topics, tErr := d.Repo.ListSubscriberTopics(r.Context(), t.ID, sub.Email); tErr != nil {
		if d.Logger != nil {
			d.Logger.Warn("hydrate preference_topics failed", "subscriber", sub.ID, "err", tErr.Error())
		}
	} else if len(topics) > 0 {
		sub.PreferenceTopics = topics
	}
	writeJSON(w, http.StatusOK, sub)
}

// ListSuppressions GET /api/v1/suppressions?q=&email=&reason=
func (d *Deps) ListSuppressions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	page, perPage := pageParams(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	out, err := d.Repo.ListSuppressions(r.Context(), t.ID, r.URL.Query().Get("email"), r.URL.Query().Get("reason"), q, page, perPage)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Create POST /api/v1/subscribers
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := normalizeCreate(&in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	// SUB-018: apply per-tenant identifier transforms (optional dot/plus email
	// stripping + phone E.164) after the unconditional lowercase + validation.
	// Fail-open: a config read error logs and falls back to all-off defaults so
	// a transform-config glitch never blocks a create.
	d.applyTenantIdentifierTransforms(r.Context(), t.ID, &in.Email, in.MergeFields, in.CustomFields)
	// Apply tenant-defined property transform rules (migration 0201): derive
	// custom_fields[target_key] from a source key/path. Best-effort, same
	// fail-open contract as the identifier transforms above. allocateIfNil=true:
	// this is Create, so deriving a custom field into a fresh map is safe.
	d.applyPropertyTransformRules(r.Context(), t.ID, in.MergeFields, &in.CustomFields, true)
	if err := d.Repo.PreflightUpsert(r.Context(), t.ID, in.Email, in.MergeFields); err != nil {
		if writeCustomFieldsValidationError(w, err) {
			return
		}
		if errors.Is(err, ErrErasureBlocked) {
			writeJSON(w, http.StatusConflict, errEnv("erasure_blocked", erasureBlockedMessage))
			return
		}
		if errors.Is(err, ErrEmailTaken) {
			httperror.Write(w, http.StatusConflict, "email_taken", "that address is already attached to another profile")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if d.Limits != nil {
		exists, err := d.Repo.ExistsByEmail(r.Context(), t.ID, in.Email)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		if !exists {
			if err := d.Limits.Check(r.Context(), t.ID, limits.ResourceContacts, 1); err != nil {
				if limits.WriteExceeded(w, err) {
					return
				}
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
				return
			}
		}
	}
	if err := d.syncCreateWithEngine(r.Context(), &in); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	sub, err := d.Repo.UpsertWithAudit(r.Context(), t.ID, in, auditMeta)
	if err != nil {
		if writeCustomFieldsValidationError(w, err) {
			return
		}
		if errors.Is(err, ErrErasureBlocked) {
			// 409 Conflict — the address carries an erasure tombstone from a
			// contact deletion or a privacy request. The tombstone cannot be
			// removed through suppression management.
			writeJSON(w, http.StatusConflict, errEnv("erasure_blocked", erasureBlockedMessage))
			return
		}
		if errors.Is(err, ErrEmailTaken) {
			httperror.Write(w, http.StatusConflict, "email_taken", "that address is already attached to another profile")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.emit(t.ID, "subscriber.added", map[string]any{
		"id":     sub.ID,
		"email":  sub.Email,
		"status": sub.Status,
	})
	// A newly created subscriber is immediately mutable. Return the same
	// strong revision carried in the representation so clients can issue the
	// next exact If-Match operation without an otherwise redundant detail GET.
	w.Header().Set("ETag", sub.Version)
	writeJSON(w, http.StatusCreated, sub)
}

func (d *Deps) syncCreateWithEngine(ctx context.Context, in *CreateInput) error {
	if d.Engine == nil || in == nil || (d.Repo != nil && d.Repo.DurableEngineSyncEnabled()) {
		return nil
	}
	found, err := d.Engine.FindSubscriberByEmail(ctx, in.Email)
	if err != nil {
		return err
	}
	if found != nil && found.ID > 0 {
		in.CustomFields[listmonkIDField] = strconv.FormatInt(found.ID, 10)
		return d.Engine.UpdateSubscriberStatus(ctx, found.ID, listmonk.UpdateSubscriberStatusReq{
			Email:  in.Email,
			Name:   nameFromCustomFields(in.CustomFields),
			Status: listmonkStatus(in.Status),
			Tags:   in.Tags,
		})
	}
	created, err := d.Engine.CreateSubscriber(ctx, listmonk.CreateSubscriberReq{
		Email:                   in.Email,
		Name:                    nameFromCustomFields(in.CustomFields),
		Status:                  listmonkStatus(in.Status),
		Attribs:                 in.CustomFields,
		Tags:                    in.Tags,
		PreconfirmSubscriptions: in.Status == StatusEnabled,
	})
	if err != nil {
		return err
	}
	if created != nil && created.ID > 0 {
		in.CustomFields[listmonkIDField] = strconv.FormatInt(created.ID, 10)
	}
	return nil
}

// Update PATCH /api/v1/subscribers/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := normalizeUpdate(&in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	// SUB-018: apply per-tenant identifier transforms to whatever identifier
	// fields the PATCH carried. in.Email is a pointer (nil = not patched), so
	// it is only reshaped when the caller actually supplied a new address.
	// Fail-open, same as Create.
	d.applyTenantIdentifierTransforms(r.Context(), t.ID, in.Email, in.MergeFields, in.CustomFields)
	// Apply tenant-defined property transform rules (migration 0201) to the
	// patched custom/merge fields. Best-effort, fail-open. allocateIfNil=false:
	// on PATCH a nil custom_fields means "leave untouched" and Repo.Update
	// treats a non-nil map as a FULL REPLACEMENT, so a rule must never fabricate
	// a one-key map here (it would wipe the subscriber's other custom fields).
	d.applyPropertyTransformRules(r.Context(), t.ID, in.MergeFields, &in.CustomFields, false)
	cur, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Reject a stale conditional request before any external engine mutation.
	// Repo.Update repeats the token check under its row lock, closing the local
	// race between this fast check and the database commit.
	currentToken := httpcache.ConcurrencyToken("subscriber", cur.ID, cur.UpdatedAt)
	tok, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard {
		httpcache.WritePreconditionRequired(w)
		return
	}
	if tok != currentToken {
		httpcache.WritePreconditionFailed(w)
		return
	}
	in.IfMatchToken = tok
	targetEmail := cur.Email
	if in.Email != nil {
		targetEmail = *in.Email
	}
	if err := d.Repo.PreflightUpdate(r.Context(), t.ID, cur.ID, targetEmail, cur.MergeFields, in.MergeFields); err != nil {
		if writeCustomFieldsValidationError(w, err) {
			return
		}
		if errors.Is(err, ErrErasureBlocked) {
			writeJSON(w, http.StatusConflict, errEnv("erasure_blocked", erasureBlockedMessage))
			return
		}
		if errors.Is(err, ErrEmailTaken) {
			httperror.Write(w, http.StatusConflict, "email_taken", "that address is already attached to another profile")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if in.Status != nil {
		if err := d.syncStatus(r.Context(), cur, *in.Status); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	prevStatus := cur.Status
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	sub, err := d.Repo.UpdateWithAudit(r.Context(), t.ID, id, in, auditMeta)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		if errors.Is(err, ErrPreconditionFailed) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		if errors.Is(err, ErrEmailTaken) {
			httperror.Write(w, http.StatusConflict, "email_taken", "that address is already attached to another profile")
			return
		}
		if errors.Is(err, ErrInvalidInput) {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		if writeCustomFieldsValidationError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// SUB-119: bridge the subscriber mutation to the in-process SSE Bus so
	// the desktop's "subscriber.*" wildcard subscription receives live
	// updates without polling. Mirrors the outbound-webhook catalog the repo
	// fires: always subscriber.updated, plus subscriber.status_changed and
	// subscriber.consent_changed when those transitions occurred.
	d.emit(t.ID, EventSubscriberUpdated, map[string]any{
		"id":     sub.ID,
		"email":  sub.Email,
		"status": sub.Status,
	})
	if prevStatus != sub.Status {
		d.emit(t.ID, EventSubscriberStatusChanged, map[string]any{
			"id":          sub.ID,
			"email":       sub.Email,
			"status":      sub.Status,
			"prev_status": prevStatus,
		})
	}
	if consentChanged(in) {
		d.emit(t.ID, EventSubscriberConsentChanged, map[string]any{
			"id":             sub.ID,
			"email":          sub.Email,
			"consent_source": sub.ConsentSource,
		})
	}
	if in.GppSections != nil {
		d.emit(t.ID, "subscriber.gpp.updated", map[string]any{
			"subscriber_id": sub.ID,
			"jurisdictions": gppKeys(in.GppSections),
			"source":        "api",
		})
	}
	if in.PredictionModelVersion != nil || in.PredictionConfidence != nil {
		d.emit(t.ID, "subscriber.prediction_metadata.updated", map[string]any{"id": sub.ID})
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("subscriber", sub.ID, sub.UpdatedAt))
	writeJSON(w, http.StatusOK, sub)
}

// isPIIAuditField reports whether a diff field name (a scalar field or a
// "<prefix>.<key>" jsonb path) counts as PII for the SUB-054 audit row. The
// scalar PII set is piiAttributeFields; any custom_fields/merge_fields change
// is conservatively treated as potentially-PII.
func isPIIAuditField(field string) bool {
	if _, ok := piiAttributeFields[field]; ok {
		return true
	}
	return strings.HasPrefix(field, "custom_fields.") || strings.HasPrefix(field, "merge_fields.")
}

// writeCustomFieldsValidationError translates a Validator error into a
// 422 with a structured code so SDKs can branch on it. Returns true when
// it handled the error; the caller should then return immediately.
//
// We accept *both* customfields.ErrUnknownKey and *ErrTypeMismatch even
// though the latter is also a value type with a pointer receiver on
// Error() — errors.As walks wrapped chains either way.
func writeCustomFieldsValidationError(w http.ResponseWriter, err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "PW001" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(
			"merge_field_validation_failed",
			pgErr.Message,
		))
		return true
	}
	var unk *customfields.ErrUnknownKey
	if errors.As(err, &unk) {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(
			"unknown_custom_field",
			fmt.Sprintf("custom field %q is not declared. Define it via POST /api/v1/custom-fields or set custom_fields_mode='auto' on the tenant.", unk.Key),
		))
		return true
	}
	var tm *customfields.ErrTypeMismatch
	if errors.As(err, &tm) {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(
			"custom_field_type_mismatch",
			tm.Error(),
		))
		return true
	}
	return false
}

// Suppress POST /api/v1/subscribers/{id}/suppress
func (d *Deps) Suppress(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	ifMatch, present, wildcard := httpcache.ParseIfMatch(r)
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if !present || wildcard || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httpcache.WritePreconditionRequired(w)
		return
	}
	id := chi.URLParam(r, "id")
	cur, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if ifMatch != cur.Version {
		httpcache.WritePreconditionFailed(w)
		return
	}
	var in CreateSuppressionInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	in.Email = cur.Email
	if in.Reason == "" {
		in.Reason = "manual"
	}
	if err := normalizeSuppression(&in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	_, freshVersion, err := d.Repo.CreateSuppressionExact(
		r.Context(), t.ID, cur.ID, ifMatch, in, middleware.AuditMetaFromRequest(r),
	)
	if err != nil {
		if errors.Is(err, ErrPreconditionFailed) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "subscriber not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Production uses the durable engine-sync intent committed above. Preserve
	// legacy/dev parity only after the canonical suppression is durable.
	if err := d.syncStatus(r.Context(), cur, StatusBlocklisted); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.Header().Set("ETag", freshVersion)
	w.WriteHeader(http.StatusNoContent)
}

// CreateSuppression POST /api/v1/suppressions
func (d *Deps) CreateSuppression(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CreateSuppressionInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := normalizeSuppression(&in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.CreateSuppression(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// DeleteSuppression DELETE /api/v1/suppressions/{id}
func (d *Deps) DeleteSuppression(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if err := d.Repo.DeleteSuppression(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "suppression not found"))
			return
		}
		if errors.Is(err, ErrSuppressionNotReversible) {
			httperror.Write(w, http.StatusConflict, "not_reversible", "privacy-erasure suppressions cannot be removed")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Delete DELETE /api/v1/subscribers/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	cur, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	currentToken := httpcache.ConcurrencyToken("subscriber", cur.ID, cur.UpdatedAt)
	tok, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard {
		httpcache.WritePreconditionRequired(w)
		return
	}
	if tok != currentToken {
		httpcache.WritePreconditionFailed(w)
		return
	}
	meta := middleware.AuditMetaFromRequest(r)
	meta.TenantID = t.ID
	deleted, err := d.Repo.DeleteWithAudit(r.Context(), t.ID, id, tok, meta)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		if errors.Is(err, ErrPreconditionFailed) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Legacy/dev compositions without the production transactional outbox may
	// still provide a direct engine. Perform that side effect only after the
	// canonical erasure committed; never delete the external copy first.
	if d.Engine != nil && !d.Repo.DurableEngineSyncEnabled() {
		if err := d.deleteInEngine(r.Context(), deleted); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	d.emit(t.ID, "subscriber.removed", map[string]any{
		"id":             deleted.ID,
		"email_redacted": observability.RedactEmail(deleted.Email),
	})
	// SUB-118/SUB-119: also emit the catalog-aligned subscriber.deleted on the
	// SSE Bus so the "subscriber.*" wildcard receivers (desktop) and the
	// in-process bridge see the same lifecycle event the outbound webhook
	// fires from the repo. Email is redacted — a delete event should not carry
	// the very PII it documents erasing.
	d.emit(t.ID, EventSubscriberDeleted, map[string]any{
		"id":             deleted.ID,
		"email_redacted": observability.RedactEmail(deleted.Email),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) syncStatus(ctx context.Context, sub *Subscriber, status string) error {
	if d.Engine == nil || sub == nil || (d.Repo != nil && d.Repo.DurableEngineSyncEnabled()) {
		return nil
	}
	id, err := d.resolveListmonkID(ctx, sub)
	if err != nil || id == 0 {
		return err
	}
	return d.Engine.UpdateSubscriberStatus(ctx, id, listmonk.UpdateSubscriberStatusReq{
		Email:  sub.Email,
		Status: listmonkStatus(status),
		Tags:   sub.Tags,
	})
}

func (d *Deps) deleteInEngine(ctx context.Context, sub *Subscriber) error {
	if d.Engine == nil || sub == nil {
		return nil
	}
	id, err := d.resolveListmonkID(ctx, sub)
	if err != nil || id == 0 {
		return err
	}
	return d.Engine.DeleteSubscriber(ctx, id)
}

func (d *Deps) resolveListmonkID(ctx context.Context, sub *Subscriber) (int64, error) {
	if id := listmonkIDFromCustomFields(sub.CustomFields); id > 0 {
		return id, nil
	}
	found, err := d.Engine.FindSubscriberByEmail(ctx, sub.Email)
	if err != nil || found == nil {
		return 0, err
	}
	return found.ID, nil
}

func normalizeCreate(in *CreateInput) error {
	email, err := normalizeEmail(in.Email)
	if err != nil {
		return err
	}
	in.Email = email
	if in.Status == "" {
		in.Status = StatusUnconfirmed
	}
	in.Status = strings.ToLower(strings.TrimSpace(in.Status))
	if !validStatus(in.Status) {
		return errors.New("invalid status")
	}
	if in.ConsentSource == "" {
		in.ConsentSource = ConsentUnknown
	}
	in.ConsentSource = strings.ToLower(strings.TrimSpace(in.ConsentSource))
	if !validConsentSource(in.ConsentSource) {
		return errors.New("invalid consent_source")
	}
	in.ConsentChannel = strings.ToLower(strings.TrimSpace(in.ConsentChannel))
	in.ConsentLegalBasis = strings.ToLower(strings.TrimSpace(in.ConsentLegalBasis))
	in.ConsentEvidence = strings.TrimSpace(in.ConsentEvidence)
	in.ConsentReason = strings.TrimSpace(in.ConsentReason)
	in.ConsentPolicyVersion = strings.TrimSpace(in.ConsentPolicyVersion)
	hasConsentClaim := in.ConsentTimestamp != nil || in.ConsentSource != ConsentUnknown ||
		in.ConsentChannel != "" || in.ConsentLegalBasis != "" ||
		in.ConsentEvidence != "" || in.ConsentReason != "" ||
		in.ConsentPolicyVersion != ""
	if in.Status != StatusEnabled && hasConsentClaim {
		return errors.New("consent evidence can only be attached when status is enabled; record non-sendable decisions through the consent ledger")
	}
	if in.Status == StatusEnabled {
		// An enabled subscriber needs EIGHT consent facts. These were checked in
		// source order with a return on the first failure, so a caller holding
		// none of them learned about exactly one per attempt -- eight rejected
		// requests to find out what the ninth would need. Every one of those
		// trips writes a rejected-write audit row, spends a rate-limit token,
		// and on a phone is a separate round trip, while the information was
		// already available on the first call.
		//
		// Collect instead. When exactly one requirement fails the message is
		// unchanged, so existing callers and docs keep the wording they have;
		// only the multi-failure case differs, and it was never observable.
		var problems []string
		switch {
		case in.ConsentTimestamp == nil:
			problems = append(problems, "consent_timestamp is required when status is enabled")
		case in.ConsentTimestamp.After(time.Now().UTC().Add(5 * time.Minute)):
			problems = append(problems, "consent_timestamp cannot be in the future")
		}
		if in.ConsentSource != ConsentDoubleOptIn && in.ConsentSource != ConsentSingleOptIn {
			problems = append(problems, "enabled subscribers require double_optin or single_optin consent_source")
		}
		if !consentChannels[in.ConsentChannel] {
			problems = append(problems, "consent_channel is required and must be one of web/mobile/desktop/email/import/api")
		}
		if !consentLegalBases[in.ConsentLegalBasis] {
			problems = append(problems, "consent_legal_basis is required")
		}
		if in.ConsentEvidence == "" || len(in.ConsentEvidence) > 2048 {
			problems = append(problems, "consent_evidence is required and must be 2048 characters or fewer")
		}
		if in.ConsentReason == "" || len(in.ConsentReason) > 500 {
			problems = append(problems, "consent_reason is required and must be 500 characters or fewer")
		}
		if strings.TrimSpace(in.Country) == "" {
			problems = append(problems, "country is required as the consent jurisdiction when status is enabled")
		}
		if in.ConsentPolicyVersion == "" || len(in.ConsentPolicyVersion) > 100 {
			problems = append(problems, "consent_policy_version is required and must be 100 characters or fewer")
		}
		if len(problems) > 0 {
			return errors.New(strings.Join(problems, "; "))
		}
	}
	in.CustomFields = nonNilMap(in.CustomFields)
	// Keep merge_fields omission distinct from an explicit empty object.
	// Omitted means "this caller is not updating audience fields"; a non-nil
	// empty map is the intentional clear operation. Historically we aliased an
	// omitted merge_fields object to custom_fields here, which both copied
	// unrelated traits into the Mailchimp-compatible namespace and caused an
	// email-only upsert to replace existing audience fields with {}.
	if in.MergeFields != nil {
		in.MergeFields = nonNilMap(in.MergeFields)
	}
	in.Tags = normalizeTags(in.Tags)
	// Cap tag count to keep the row small and prevent abuse: an
	// attacker could otherwise pump tens of thousands of tags per
	// subscriber, bloating the row and the every-list serialization.
	const maxTagsPerSubscriber = 50
	if len(in.Tags) > maxTagsPerSubscriber {
		return fmt.Errorf("too many tags: %d (max %d)", len(in.Tags), maxTagsPerSubscriber)
	}
	in.MailchimpStatus = normalizeMailchimpStatus(in.MailchimpStatus, in.Status)
	if !validMailchimpStatus(in.MailchimpStatus) {
		return errors.New("invalid mailchimp_status")
	}
	if strings.TrimSpace(in.SignupIP) != "" && net.ParseIP(strings.TrimSpace(in.SignupIP)) == nil {
		return errors.New("signup_ip must be a valid IP address")
	}
	in.SignupIP = strings.TrimSpace(in.SignupIP)
	in.UnsubscribeReason = strings.TrimSpace(in.UnsubscribeReason)
	in.ActivitySummary = nonNilMap(in.ActivitySummary)
	// Name columns (SUB-004) — trim only; derivation from merge/custom
	// fields happens in Repo.Upsert.deriveNames.
	in.FirstName = strings.TrimSpace(in.FirstName)
	in.LastName = strings.TrimSpace(in.LastName)
	in.FullName = strings.TrimSpace(in.FullName)
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	// Localization columns (SUB-005) — best-effort normalisation. Empty
	// values become NULL via NULLIF in the upsert; language/country are
	// upper/lower-cased to their canonical ISO casing.
	in.Locale = strings.TrimSpace(in.Locale)
	in.Language = strings.ToLower(strings.TrimSpace(in.Language))
	in.Country = strings.ToUpper(strings.TrimSpace(in.Country))
	in.Region = strings.TrimSpace(in.Region)
	if err := validateLocalization(in.Locale, in.Language, in.Country); err != nil {
		return err
	}
	return nil
}

// validateLocalization runs the best-effort ISO sanity checks shared by
// create + update. It is intentionally lenient: empty values pass (the
// field is optional), and only the obvious shape is enforced — ISO 639-1
// language is two ASCII letters, ISO 3166-1 alpha-2 country is two ASCII
// letters. Locale is free-text (BCP-47-ish) so it is length-capped only.
func validateLocalization(locale, language, country string) error {
	if language != "" && !isTwoAsciiLetters(language) {
		return errors.New("language must be a 2-letter ISO 639-1 code")
	}
	if country != "" && !isTwoAsciiLetters(country) {
		return errors.New("country must be a 2-letter ISO 3166-1 alpha-2 code")
	}
	if len(locale) > 35 {
		return errors.New("locale must be 35 characters or fewer")
	}
	return nil
}

func isTwoAsciiLetters(s string) bool {
	if len(s) != 2 {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	return true
}

// normalizeSuppressionReason maps a caller-supplied suppression reason
// (and a small set of aliases) onto the canonical label the
// email_suppressions CHECK constraint accepts (widened by migration
// 0513 to carry the Klaviyo-compatible rich taxonomy alongside the
// legacy short labels). Returns "" when the reason is unrecognised so
// the caller can reject with a 422.
//
// SUB-047 / SUB-048: this is the validator the consolidated suppression
// taxonomy flows through. The legacy short labels (complaint /
// unsubscribe / manual / imported) stay valid for back-compat with the
// shipped frontend filter chips; the new reasons (soft_bounce /
// list_unsub_header / spamtrap / role_account / dns_failure /
// invalid_address) pass straight through.
func normalizeSuppressionReason(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	// Legacy short labels (0030 email_suppressions enum).
	case "hard_bounce", "bounce", "hardbounce", "hard-bounce":
		return "hard_bounce"
	case "complaint", "spam_complaint", "spam", "fbl":
		return "complaint"
	case "unsubscribe", "manual_unsubscribe", "one_click":
		return "unsubscribe"
	case "manual":
		return "manual"
	case "imported", "import":
		return "imported"
	// SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy.
	case "soft_bounce", "softbounce", "soft-bounce", "transient":
		return "soft_bounce"
	case "list_unsub_header", "list_unsubscribe_header", "list_unsubscribe",
		"list-unsubscribe", "rfc8058":
		return "list_unsub_header"
	case "spamtrap", "spam_trap", "spamtrap_hit", "honeypot", "trap":
		return "spamtrap"
	case "role_account", "role-account", "roleaccount", "role_address", "role":
		return "role_account"
	case "dns_failure", "dns_fail", "dnsfailure", "dns-failure",
		"nxdomain", "no_mx", "mx_not_found":
		return "dns_failure"
	case "invalid_address", "invalid-address", "invalidaddress",
		"invalid_email", "invalid", "bad_address":
		return "invalid_address"
	}
	return ""
}

func normalizeSuppression(in *CreateSuppressionInput) error {
	email, err := normalizeEmail(in.Email)
	if err != nil {
		return err
	}
	in.Email = email
	in.Reason = normalizeSuppressionReason(in.Reason)
	if in.Reason == "" {
		return errors.New("reason must be one of the supported suppression reasons (hard_bounce, soft_bounce, complaint, list_unsub_header, spamtrap, role_account, dns_failure, invalid_address, unsubscribe, manual, imported)")
	}
	in.Source = strings.TrimSpace(in.Source)
	if in.Source == "" {
		in.Source = "manual"
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	return nil
}

func normalizeUpdate(in *UpdateInput) error {
	if in.Email != nil {
		email, err := normalizeEmail(*in.Email)
		if err != nil {
			return err
		}
		in.Email = &email
	}
	if in.Status != nil {
		status := strings.ToLower(strings.TrimSpace(*in.Status))
		if !validStatus(status) {
			return errors.New("invalid status")
		}
		in.Status = &status
	}
	if in.ConsentSource != nil {
		source := strings.ToLower(strings.TrimSpace(*in.ConsentSource))
		if !validConsentSource(source) {
			return errors.New("invalid consent_source")
		}
		in.ConsentSource = &source
	}
	if _, _, err := normalizeSubscriberUpdateConsentIntent(in); err != nil {
		return errors.New(strings.TrimPrefix(err.Error(), ErrInvalidInput.Error()+": "))
	}
	if in.MailchimpStatus != nil {
		status := strings.ToLower(strings.TrimSpace(*in.MailchimpStatus))
		if !validMailchimpStatus(status) {
			return errors.New("invalid mailchimp_status")
		}
		in.MailchimpStatus = &status
	}
	if in.Tags != nil {
		in.Tags = normalizeTags(in.Tags)
	}
	if in.SignupIP != nil {
		ip := strings.TrimSpace(*in.SignupIP)
		if ip != "" && net.ParseIP(ip) == nil {
			return errors.New("signup_ip must be a valid IP address")
		}
		in.SignupIP = &ip
	}
	if in.UnsubscribeReason != nil {
		reason := strings.TrimSpace(*in.UnsubscribeReason)
		in.UnsubscribeReason = &reason
	}
	// Name columns (SUB-004) — trim explicit patches in place.
	if in.FirstName != nil {
		v := strings.TrimSpace(*in.FirstName)
		in.FirstName = &v
	}
	if in.LastName != nil {
		v := strings.TrimSpace(*in.LastName)
		in.LastName = &v
	}
	if in.FullName != nil {
		v := strings.TrimSpace(*in.FullName)
		in.FullName = &v
	}
	if in.DisplayName != nil {
		v := strings.TrimSpace(*in.DisplayName)
		in.DisplayName = &v
	}
	// Localization columns (SUB-005) — trim + canonical-case, then validate.
	if in.Locale != nil {
		v := strings.TrimSpace(*in.Locale)
		in.Locale = &v
	}
	if in.Language != nil {
		v := strings.ToLower(strings.TrimSpace(*in.Language))
		in.Language = &v
	}
	if in.Country != nil {
		v := strings.ToUpper(strings.TrimSpace(*in.Country))
		in.Country = &v
	}
	if in.Region != nil {
		v := strings.TrimSpace(*in.Region)
		in.Region = &v
	}
	// DataRegion (SUB-052) — trim + validate. An explicit "" is allowed
	// (clears the per-subscriber override → inherit the tenant region); a
	// non-empty value must be one of regions.Allowed() so an unsupported
	// string cannot land and later silently break backup/sub-processor
	// selection.
	if in.DataRegion != nil {
		v := strings.ToLower(strings.TrimSpace(*in.DataRegion))
		if v != "" {
			if err := regions.Validate(v); err != nil {
				return errors.New("invalid data_region")
			}
		}
		in.DataRegion = &v
	}
	hasPredictionMetadata := in.PredictionModelVersion != nil || in.PredictionConfidence != nil
	if in.PredictionModelVersion != nil {
		v := strings.TrimSpace(*in.PredictionModelVersion)
		if v == "" || len(v) > 200 {
			return errors.New("prediction_model_version must be 1 to 200 characters")
		}
		in.PredictionModelVersion = &v
	}
	if in.PredictionConfidence != nil && (*in.PredictionConfidence < 0 || *in.PredictionConfidence > 1) {
		return errors.New("prediction_confidence must be in [0,1]")
	}
	if in.PredictionScoreType != "" {
		in.PredictionScoreType = strings.ToLower(strings.TrimSpace(in.PredictionScoreType))
		if !hasPredictionMetadata {
			return errors.New("prediction_score_type requires prediction_model_version or prediction_confidence")
		}
		if !ValidPredictionScoreType(in.PredictionScoreType) {
			return errors.New("invalid prediction_score_type")
		}
	}
	// FrequencyPreference (SUB-132) — trim + lowercase, then validate against
	// the migration 0180 CHECK vocabulary so an unknown value 422s at the
	// application layer instead of crashing on the DB constraint.
	if in.FrequencyPreference != nil {
		v := strings.ToLower(strings.TrimSpace(*in.FrequencyPreference))
		if !ValidFrequencyPreference(v) {
			return errors.New("frequency_preference must be one of default, weekly, monthly, paused")
		}
		in.FrequencyPreference = &v
	}
	// PauseDays (SUB-135 vacation mode) — when supplied, bounds-check 1..365 and
	// compute paused_until = now + days, so "pause for N days" is a single field
	// on the authenticated REST surface (mirroring the smart-unsubscribe public
	// endpoint's pauseDays semantics). Unlike the public clamp, the REST surface
	// rejects an out-of-range value so a typo surfaces as a 422 rather than a
	// silent clamp. PauseDays wins over a supplied PausedUntil (one canonical
	// source) and, when the caller left frequency_preference unset, also pins it
	// to 'paused' so the row is coherent. ClearPausedUntil and PauseDays are
	// mutually exclusive — "clear" plus "pause for N" is contradictory.
	if in.PauseDays != 0 {
		if in.ClearPausedUntil {
			return errors.New("pause_days and clear_paused_until are mutually exclusive")
		}
		if in.PauseDays < 1 || in.PauseDays > 365 {
			return errors.New("pause_days must be between 1 and 365")
		}
		until := time.Now().UTC().Add(time.Duration(in.PauseDays) * 24 * time.Hour)
		in.PausedUntil = &until
		if in.FrequencyPreference == nil {
			paused := "paused"
			in.FrequencyPreference = &paused
		}
	}
	if err := validateLocalization(
		valueOrEmpty(in.Locale), valueOrEmpty(in.Language), valueOrEmpty(in.Country),
	); err != nil {
		return err
	}
	return nil
}

func normalizeEmail(raw string) (string, error) {
	return emailidentity.Normalize(raw)
}

func validStatus(s string) bool {
	switch s {
	case StatusEnabled, StatusDisabled, StatusBlocklisted, StatusUnconfirmed:
		return true
	default:
		return false
	}
}

func validConsentSource(s string) bool {
	switch s {
	case ConsentDoubleOptIn, ConsentSingleOptIn, ConsentImport, ConsentAPI, ConsentUnknown:
		return true
	default:
		return false
	}
}

func validMailchimpStatus(s string) bool {
	switch s {
	case "subscribed", "unsubscribed", "non_subscribed", "pending", "transactional", "cleaned", "archived", "deleted":
		return true
	default:
		return false
	}
}

func normalizeMailchimpStatus(mailchimpStatus, listmonkStatus string) string {
	status := strings.ToLower(strings.TrimSpace(mailchimpStatus))
	if status != "" {
		return status
	}
	return mailchimpStatusFromListmonk(listmonkStatus)
}

func mailchimpStatusFromListmonk(status string) string {
	switch status {
	case StatusEnabled:
		return "subscribed"
	case StatusDisabled:
		return "unsubscribed"
	case StatusBlocklisted:
		return "cleaned"
	case StatusUnconfirmed:
		return "non_subscribed"
	default:
		return "non_subscribed"
	}
}

func normalizeTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := map[string]struct{}{}
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, tag)
	}
	return out
}

func listmonkStatus(status string) string {
	if status == StatusUnconfirmed {
		return StatusDisabled
	}
	return status
}

func nameFromCustomFields(fields map[string]any) string {
	if v, ok := fields["name"].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func listmonkIDFromCustomFields(fields map[string]any) int64 {
	switch v := fields[listmonkIDField].(type) {
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	default:
		return 0
	}
}

func pageParams(r *http.Request) (int, int) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	perPage, _ := strconv.Atoi(q.Get("per_page"))
	return normalizePage(page, perPage)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// MountTimelineRoutes registers the subscriber drill-down timeline
// endpoint. Kept separate from MountRead so main.go can opt in
// independently inside the subscriber-drilldown region.
func MountTimelineRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/timeline", d.Timeline)
}

// Timeline GET /api/v1/subscribers/{id}/timeline?cursor=<opaque>&limit=50
//
// Returns the aggregated event timeline for a single subscriber: sends,
// opens, clicks, bounces, suppressions, replies, list/tag changes, and
// the import/added markers. Stats are computed over the unbounded set,
// not just the page.
func (d *Deps) Timeline(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	category, err := ParseTimelineCategory(r.URL.Query().Get("category"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_category", "category must be all, engagement, delivery, consent, or profile"))
		return
	}
	limit := 50
	if q := r.URL.Query().Get("limit"); q != "" {
		if n, err := strconv.Atoi(q); err == nil && n > 0 {
			limit = n
		}
	}
	var cursor *timelineCursor
	if q := r.URL.Query().Get("cursor"); q != "" {
		var decodeErr error
		cursor, decodeErr = decodeTimelineCursor(q)
		if decodeErr != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_cursor", "cursor is invalid"))
			return
		}
	} else if q := r.URL.Query().Get("before"); q != "" {
		if ts, err := time.Parse(time.RFC3339, q); err == nil {
			cursor = &timelineCursor{At: ts, Source: "\uffff", Type: "\uffff", SubjectID: "\uffff"}
		} else {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_before", "before must be RFC3339"))
			return
		}
	}
	tl, err := d.Repo.GetTimelineFiltered(r.Context(), t.ID, id, cursor, limit, category)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, tl)
}
