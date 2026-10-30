// SPDX-License-Identifier: AGPL-3.0-only
//
// Package sar implements per-subscriber Subject Access Requests
// (GDPR Article 15 / CCPA §1798.100 / LGPD Art. 18 I-II).
//
// A SAR is "show me everything you have about person X". Unlike
// the tenant-wide data export in `privacy/`, the SAR is bounded
// (one subscriber's data) and therefore runs synchronously: we
// stitch together their subscriber row, event history, consent
// receipts, form submissions and topic preferences into a single
// JSON bundle, persist it to `sar_bundles`, and return the
// request id.
//
// Wire surfaces:
//
//   POST   /api/v1/sar/requests              admin scope; body {kind, email, fanout_enabled, notes}
//   GET    /api/v1/sar/requests              admin scope; list newest 100
//   GET    /api/v1/sar/requests/{id}         admin scope; returns bundle JSON
//   GET    /api/v1/sar/requests/{id}.zip     admin scope; returns ZIP download
//
// The bundle is also retained in the table for the GDPR-mandated
// audit trail — a regulator must be able to see both that the
// request was honoured AND what was actually disclosed.

package sar

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 16 << 10 // 16 KiB

var errOptionalSARRelationMissing = errors.New("optional SAR relation is unavailable")

// Deps wires the SAR HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// with tenant_id+request_id+err context without leaking err text
	// to the client. May be nil; in that case nothing is logged.
	Logger *slog.Logger
	// PlaygroundSubjectAccess opens Route45's envelope-encrypted inspection
	// receipts by their subject locator. nil is surfaced as an explicitly
	// unavailable bundle section rather than a misleading empty disclosure.
	PlaygroundSubjectAccess PlaygroundSubjectAccess
}

// PlaygroundSubjectAccess is the transaction-bound Route45 disclosure seam.
// Implementations must enforce tenant scope, verify the encrypted receipt's
// row binding, and report truncation explicitly.
type PlaygroundSubjectAccess interface {
	LoadPlaygroundSubjectReceipts(
		context.Context, pgx.Tx, string, string,
	) ([]map[string]any, int64, bool, error)
}

// Request is one row of sar_bundles for listing.
type Request struct {
	ID              string     `json:"id"`
	Kind            string     `json:"kind"`
	SubscriberEmail string     `json:"subscriber_email"`
	Status          string     `json:"status"`
	RowsDeleted     *int64     `json:"rows_deleted,omitempty"`
	EventCount      int        `json:"event_count"`
	ConsentCount    int        `json:"consent_count"`
	BundleBytes     int        `json:"bundle_bytes"`
	RequestedBy     string     `json:"requested_by,omitempty"`
	RequestedAt     time.Time  `json:"requested_at"`
	ReadyAt         *time.Time `json:"ready_at,omitempty"`
	Region          string     `json:"region,omitempty"`
	Error           string     `json:"error,omitempty"`
}

type createReq struct {
	Email string `json:"email"`
	Notes string `json:"notes"`
	// Kind selects what this request DOES. It is required: "access" builds a
	// read-only subject-access disclosure bundle; "erase" performs a
	// Moosewave-only Art. 17 erasure.
	//
	// Before this field existed, the product's "Right to Erasure" button
	// posted here and got an access bundle: the endpoint's only write was a
	// complete cleartext snapshot of the subject's PII. It deleted nothing
	// and reported success, so pressing "erase" left us holding strictly more
	// personal data than before.
	Kind   string `json:"kind"`
	Region string `json:"region"`
	// FanoutEnabled (SUB-053) opts an ACCESS request into read-only connected
	// store collection. Legacy provider auto-delete policies are ignored.
	// Provider erasure is not implemented by this synchronous endpoint, so an
	// ERASE request with fanout enabled is rejected rather than overstating its
	// scope.
	FanoutEnabled bool `json:"fanout_enabled"`
}

// MountRoutes registers the admin-scope endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Post("/api/v1/sar/requests", d.Create)
	r.With(admin).Get("/api/v1/sar/requests", d.List)
	r.With(admin).Get("/api/v1/sar/requests/{id}", d.Fetch)
	r.With(admin).Get("/api/v1/sar/requests/{id}.zip", d.Download)
	// SUB-053: admin view of the per-store DSAR fan-out outcomes for a
	// given SAR request.
	r.With(admin).Get("/api/v1/sar/requests/{id}/store-responses", d.StoreResponses)
}

// Create POST /api/v1/sar/requests — runs bundle build synchronously.
//
// The endpoint is authenticated as a tenant admin acting on
// behalf of the subscriber (the normal pattern when a SAR comes
// through a support inbox). A subscriber-self-serve flow can be
// layered on later with a signed token.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body createReq
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	kind := strings.ToLower(strings.TrimSpace(body.Kind))
	if kind == "" {
		writeErr(w, http.StatusBadRequest, "bad_kind", `kind is required and must be "access" or "erase"`)
		return
	}
	if kind != kindAccess && kind != kindErase {
		writeErr(w, http.StatusBadRequest, "bad_kind", `kind must be "access" or "erase"`)
		return
	}
	if kind == kindErase && body.FanoutEnabled {
		writeErr(w, http.StatusBadRequest, "erase_fanout_unsupported", "connected-store erasure is not available; submit fanout_enabled=false for Moosewave-only erasure")
		return
	}

	email := strings.ToLower(strings.TrimSpace(body.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeErr(w, http.StatusBadRequest, "missing_email", "email required")
		return
	}

	requestedBy := "admin:unknown"
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		if strings.TrimSpace(u.Email) != "" {
			requestedBy = "admin:" + strings.TrimSpace(u.Email)
		}
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if kind == kindErase {
		d.createErasure(w, r, tx, t.ID, email, requestedBy, body)
		return
	}

	bundle, counts, err := buildBundleWithPlaygroundSubjectAccess(
		r.Context(), tx, t.ID, email, d.PlaygroundSubjectAccess,
	)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// SUB-053: optional read-only access collection across connected stores.
	// Network calls are made here (synchronously, before the row is
	// persisted) and the per-store outcomes are merged into the bundle so
	// the regulator trail shows the cross-store disclosure. A
	// fan-out failure must NOT silently produce a Moosewave-only bundle, so
	// any enumeration error 500s; per-store failures are captured inline as
	// "error" responses by the orchestrator.
	var storeResponses []StoreResponse
	if body.FanoutEnabled {
		storeResponses, err = FanoutToStores(r.Context(), tx, t.ID, email, kindAccess)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		bundle["store_responses"] = storeResponses
	}

	raw, err := json.Marshal(bundle)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO sar_bundles
  (tenant_id, subscriber_email, status, kind, event_count, consent_count,
   bundle_bytes, bundle, requested_by, ready_at, region)
VALUES ($1::uuid, $2, 'ready', 'access', $3, $4, $5, $6::jsonb, $7, now(), NULLIF($8, ''))
RETURNING id::text`,
		t.ID, email, counts.events, counts.consents, len(raw), raw,
		requestedBy, strings.ToUpper(strings.TrimSpace(body.Region))).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// SUB-053: persist the per-store receipts into dsar_store_responses in
	// the SAME tx as the bundle so the receipts and the disclosure commit
	// atomically.
	if len(storeResponses) > 0 {
		if err := PersistStoreResponses(r.Context(), tx, t.ID, id, storeResponses); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	out := map[string]any{
		"id":               id,
		"kind":             kindAccess,
		"subscriber_email": email,
		"status":           "ready",
		"event_count":      counts.events,
		"consent_count":    counts.consents,
		"bundle_bytes":     len(raw),
		"download_url":     fmt.Sprintf("/api/v1/sar/requests/%s.zip", id),
	}
	if body.FanoutEnabled {
		out["store_responses"] = storeResponses
	}
	writeJSON(w, http.StatusCreated, out)
}

// StoreResponses GET /api/v1/sar/requests/{id}/store-responses — admin view of
// the SUB-053 per-store DSAR fan-out outcomes for a given SAR request.
func (d *Deps) StoreResponses(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Confirm the SAR request exists (and is tenant-visible) so a bogus id
	// 404s rather than returning an empty list.
	var exists bool
	if err := tx.QueryRow(r.Context(), `
SELECT EXISTS (SELECT 1 FROM sar_bundles WHERE tenant_id = $1::uuid AND id = $2::uuid)`,
		t.ID, id).Scan(&exists); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !exists {
		httperror.Write(w, http.StatusNotFound, "not_found", "sar request not found")
		return
	}

	responses, err := listStoreResponses(r.Context(), tx, t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"request_id":      id,
		"store_responses": responses,
		"count":           len(responses),
	})
}

// List GET /api/v1/sar/requests?email=&limit=.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	limit := 100
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	email := strings.ToLower(strings.TrimSpace(q.Get("email")))

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
SELECT id::text, kind, subscriber_email::text, status, rows_deleted,
       event_count, consent_count, bundle_bytes, COALESCE(requested_by, ''), requested_at, ready_at,
       COALESCE(region, ''), COALESCE(error, '')
  FROM sar_bundles
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR subscriber_email = $2)
 ORDER BY requested_at DESC
 LIMIT $3`, t.ID, email, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := []Request{}
	for rows.Next() {
		var rq Request
		if err := rows.Scan(&rq.ID, &rq.Kind, &rq.SubscriberEmail, &rq.Status,
			&rq.RowsDeleted, &rq.EventCount, &rq.ConsentCount, &rq.BundleBytes,
			&rq.RequestedBy, &rq.RequestedAt, &rq.ReadyAt,
			&rq.Region, &rq.Error); err != nil {
			continue
		}
		out = append(out, rq)
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": out, "count": len(out)})
}

// Fetch GET /api/v1/sar/requests/{id} — returns bundle JSON.
func (d *Deps) Fetch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var meta Request
	var raw []byte
	err = tx.QueryRow(r.Context(), `
SELECT id::text, kind, subscriber_email::text, status, rows_deleted,
       event_count, consent_count, bundle_bytes, COALESCE(requested_by, ''), requested_at, ready_at,
       COALESCE(region, ''), COALESCE(error, ''),
       COALESCE(bundle::text, '{}')::bytea
  FROM sar_bundles
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, t.ID, id).Scan(
		&meta.ID, &meta.Kind, &meta.SubscriberEmail, &meta.Status,
		&meta.RowsDeleted, &meta.EventCount, &meta.ConsentCount, &meta.BundleBytes,
		&meta.RequestedBy, &meta.RequestedAt, &meta.ReadyAt,
		&meta.Region, &meta.Error, &raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "sar request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	var bundle any
	_ = json.Unmarshal(raw, &bundle)
	writeJSON(w, http.StatusOK, map[string]any{
		"request": meta,
		"bundle":  bundle,
	})
}

// Download GET /api/v1/sar/requests/{id}.zip — returns the bundle
// as a zip archive (bundle.json + README.txt).
func (d *Deps) Download(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var kind, email string
	var bundleBytes []byte
	var requestedAt time.Time
	err = tx.QueryRow(r.Context(), `
SELECT kind, subscriber_email::text, COALESCE(bundle::text, '{}')::bytea, requested_at
  FROM sar_bundles
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'ready'`,
		t.ID, id).Scan(&kind, &email, &bundleBytes, &requestedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "sar request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if kind != kindAccess {
		writeErr(w, http.StatusConflict, "not_access_bundle", "erasure receipts are counts-only and are not downloadable subject-access bundles")
		return
	}

	zipBytes, err := buildZip(id, email, requestedAt, bundleBytes)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	filename := fmt.Sprintf("sar-%s-%s.zip",
		requestedAt.UTC().Format("20060102T150405Z"),
		sanitizeEmail(email))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("X-Postwave-SAR-Request-ID", id)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(zipBytes)
}

// --- bundle construction ---

type bundleCounts struct {
	events   int
	consents int
}

// BundleCounts is the exported projection of bundleCounts returned by
// BuildBundle. Added so packages outside `sar` (e.g. subscribers'
// data_export handler) can read the section sizes without reaching
// into the private struct.
type BundleCounts struct {
	Events   int
	Consents int
}

type sarSectionQuery struct {
	name  string
	query string
	limit int
}

const defaultAutomationSARSectionLimit = 10000

func (section sarSectionQuery) rowLimit() int {
	if section.limit > 0 {
		return section.limit
	}
	return defaultAutomationSARSectionLimit
}

type automationSARSectionMetadata struct {
	ReturnedCount int  `json:"returned_count"`
	Truncated     bool `json:"truncated"`
	Limit         int  `json:"limit"`
}

// automationSARSections is the bounded subject-attributable automation
// inventory. Definition/control-plane tables are intentionally absent:
// automations, automation_journeys/versions/registries,
// external_warehouse_triggers, warehouse_connections, omni campaign/path
// configuration, and message templates belong to the tenant rather than the
// subject and can contain SQL, configuration, credentials references, or
// reusable content. Execution errors, push tokens, activation-receipt
// signatures, and LLM prompts/raw responses are likewise excluded from the
// projections below. Arbitrary JSON and unconstrained explanatory text are
// excluded rather than recursively guessed at; schema-constrained scalar
// outcomes (for example lifecycle dispatch result and zero-copy DLQ reason)
// remain because their CHECK constraints make the allowlist finite.
//
// Every query is independently tenant constrained, returns one jsonb column,
// and is capped. ID-attributed sections join through subscribers using both
// tenant_id and subscriber_id; email-attributed ledgers retain their direct
// case-insensitive match so historical rows remain discoverable.
var automationSARSections = []sarSectionQuery{
	{
		name: "automation_executions",
		query: `
SELECT jsonb_build_object(
         'id', e.id,
         'automation_id', e.automation_id,
         'subscriber_email', e.subscriber_email,
         'current_node', e.current_node,
         'completed_nodes', e.completed_nodes,
         'started_at', e.started_at,
         'last_at', e.last_at,
         'paused', e.paused,
         'run_id', e.run_id
       )
  FROM automation_executions e
 WHERE e.tenant_id = $1::uuid
   AND lower(e.subscriber_email::text) = lower($2)
 ORDER BY e.last_at DESC, e.id
 LIMIT $3`,
	},
	{
		name: "automation_journey_executions",
		query: `
SELECT jsonb_build_object(
         'id', j.id,
         'journey_id', j.journey_id,
         'subscriber_email', j.subscriber_email,
         'status', j.status,
         'current_node_id', j.current_node_id,
         'completed_nodes', j.completed_nodes,
         'started_at', j.started_at,
         'last_at', j.last_at,
         'next_run_at', j.next_run_at
       )
  FROM automation_journey_executions j
 WHERE j.tenant_id = $1::uuid
   AND lower(j.subscriber_email::text) = lower($2)
 ORDER BY j.last_at DESC, j.id
 LIMIT $3`,
	},
	{
		name: "automation_journey_events",
		query: `
SELECT jsonb_build_object(
         'id', j.id,
         'automation_id', j.automation_id,
         'subscriber_email', j.subscriber_email,
         'event_type', j.event_type,
         'node_id', j.node_id,
         'status', j.status,
         'at', j.at
       )
  FROM automation_journey_events j
 WHERE j.tenant_id = $1::uuid
   AND lower(j.subscriber_email::text) = lower($2)
 ORDER BY j.at DESC, j.id DESC
 LIMIT $3`,
	},
	{
		name: "automation_flow_activity",
		query: `
SELECT jsonb_build_object(
         'id', a.id,
         'automation_id', a.automation_id,
         'journey_id', a.journey_id,
         'node_id', a.node_id,
         'subscriber_email', a.subscriber_email,
         'event_type', a.event_type,
         'status', a.status,
         'at', a.at
       )
  FROM automation_flow_activity a
 WHERE a.tenant_id = $1::uuid
   AND lower(a.subscriber_email::text) = lower($2)
 ORDER BY a.at DESC, a.id DESC
 LIMIT $3`,
	},
	{
		name: "flow_ab_test_assignments",
		query: `
SELECT jsonb_build_object(
         'id', a.id,
         'automation_id', a.automation_id,
         'node_id', a.node_id,
         'subscriber_email', a.subscriber_email,
         'variant_id', a.variant_id,
         'assigned_at', a.assigned_at,
         'converted_at', a.converted_at
       )
  FROM flow_ab_test_assignments a
 WHERE a.tenant_id = $1::uuid
   AND lower(a.subscriber_email::text) = lower($2)
 ORDER BY a.assigned_at DESC, a.id DESC
 LIMIT $3`,
	},
	{
		name: "flow_runs",
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
)
SELECT jsonb_build_object(
         'id', r.id,
         'flow_id', r.flow_id,
         'subscriber_id', r.subscriber_id,
         'trigger_event_id', r.trigger_event_id,
         'trigger_event_name', r.trigger_event_name,
         'status', r.status,
         'scheduled_at', r.scheduled_at,
         'started_at', r.started_at,
         'finished_at', r.finished_at,
         'created_at', r.created_at
       )
  FROM flow_runs r
  JOIN subject s ON s.id = r.subscriber_id
 WHERE r.tenant_id = $1::uuid
 ORDER BY r.created_at DESC, r.id
 LIMIT $3`,
	},
	{
		name: "external_warehouse_trigger_fires",
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
), subject_runs AS (
  SELECT r.id
    FROM flow_runs r
    JOIN subject s ON s.id = r.subscriber_id
   WHERE r.tenant_id = $1::uuid
)
SELECT jsonb_build_object(
         'id', f.id,
         'trigger_id', f.trigger_id,
         'flow_run_id', f.flow_run_id,
         'subscriber_id', f.subscriber_id,
         'status', f.status,
         'fired_at', f.fired_at
       )
  FROM external_warehouse_trigger_fires f
 WHERE f.tenant_id = $1::uuid
   AND (
     f.subscriber_id IN (SELECT id FROM subject)
     OR lower(f.profile_key) = lower($2)
     OR f.flow_run_id IN (SELECT id FROM subject_runs)
   )
 ORDER BY f.fired_at DESC, f.id DESC
 LIMIT $3`,
	},
	{
		name: "external_warehouse_trigger_dlq",
		query: `
SELECT jsonb_build_object(
         'id', d.id,
         'trigger_id', d.trigger_id,
         'profile_key', d.profile_key,
         'reason', d.reason,
         'retry_count', d.retry_count,
         'last_retried_at', d.last_retried_at,
         'status', d.status,
         'created_at', d.created_at,
         'updated_at', d.updated_at
       )
  FROM external_warehouse_trigger_dlq d
 WHERE d.tenant_id = $1::uuid
   AND lower(d.profile_key) = lower($2)
 ORDER BY d.created_at DESC, d.id DESC
 LIMIT $3`,
	},
	{
		name: "activation_exclusion_receipts",
		query: `
SELECT jsonb_build_object(
         'id', r.id,
         'run_id', r.run_id,
         'run_type', r.run_type,
         'subscriber_email', r.subscriber_email,
         'rule_class', r.rule_class,
         'consent_event_id', r.consent_event_id,
         'purpose', r.purpose,
         'destination_type', r.destination_type,
         'excluded_at', r.excluded_at
       )
  FROM activation_exclusion_receipts r
 WHERE r.tenant_id = $1::uuid
   AND lower(r.subscriber_email) = lower($2)
 ORDER BY r.excluded_at DESC, r.id DESC
 LIMIT $3`,
	},
	{
		name:  "trigger_delay_preferences",
		limit: 1000,
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
)
SELECT jsonb_build_object(
         'subscriber_id', p.subscriber_id,
         'event_name', p.event_name,
         'optimal_delay_seconds', p.optimal_delay_seconds,
         'sample_count', p.sample_count,
         'confidence', p.confidence,
         'computed_at', p.computed_at,
         'updated_at', p.updated_at
       )
  FROM trigger_delay_preferences p
  JOIN subject s ON s.id = p.subscriber_id
 WHERE p.tenant_id = $1::uuid
 ORDER BY p.updated_at DESC, p.event_name
 LIMIT $3`,
	},
	{
		name: "omni_recipients",
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
)
SELECT jsonb_build_object(
         'id', r.id,
         'campaign_id', r.campaign_id,
         'path_id', r.path_id,
         'subscriber_id', r.subscriber_id,
         'email', r.email,
         'phone_e164', r.phone_e164,
         'channel', r.channel,
         'status', r.status,
         'scheduled_at', r.scheduled_at,
         'sent_at', r.sent_at,
         'created_at', r.created_at,
         'updated_at', r.updated_at
       )
  FROM omni_recipients r
 WHERE r.tenant_id = $1::uuid
   AND (
     r.subscriber_id IN (SELECT id FROM subject)
     OR lower(r.email::text) = lower($2)
   )
 ORDER BY r.created_at DESC, r.id
 LIMIT $3`,
	},
	{
		name: "channel_send_history",
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
), subject_recipients AS (
  SELECT r.id
    FROM omni_recipients r
   WHERE r.tenant_id = $1::uuid
     AND (
       r.subscriber_id IN (SELECT id FROM subject)
       OR lower(r.email::text) = lower($2)
     )
)
SELECT jsonb_build_object(
         'id', h.id,
         'campaign_id', h.campaign_id,
         'path_id', h.path_id,
         'recipient_id', h.recipient_id,
         'message_template_id', h.message_template_id,
         'subscriber_id', h.subscriber_id,
         'email', h.email,
         'phone_e164', h.phone_e164,
         'channel', h.channel,
         'provider', h.provider,
         'provider_message_id', h.provider_message_id,
         'status', h.status,
         'sent_at', h.sent_at,
         'delivered_at', h.delivered_at,
         'opened_at', h.opened_at,
         'clicked_at', h.clicked_at,
         'created_at', h.created_at
       )
  FROM channel_send_history h
 WHERE h.tenant_id = $1::uuid
   AND (
     h.subscriber_id IN (SELECT id FROM subject)
     OR lower(h.email::text) = lower($2)
     OR h.recipient_id IN (SELECT id FROM subject_recipients)
   )
 ORDER BY h.created_at DESC, h.id
 LIMIT $3`,
	},
	{
		name: "subscriber_send_log",
		query: `
SELECT jsonb_build_object(
         'id', l.id,
         'subscriber_email', l.subscriber_email,
         'campaign_id', l.campaign_id,
         'channel', l.channel,
         'sent_at', l.sent_at
       )
  FROM subscriber_send_log l
 WHERE l.tenant_id = $1::uuid
   AND lower(l.subscriber_email::text) = lower($2)
 ORDER BY l.sent_at DESC, l.id DESC
 LIMIT $3`,
	},
	{
		name: "intelligent_retry_events",
		query: `
SELECT jsonb_build_object(
         'id', r.id,
         'campaign_id', r.campaign_id,
         'subscriber_email', r.subscriber_email,
         'status', r.status,
         'retry_after', r.retry_after,
         'attempts', r.attempts,
         'created_at', r.created_at,
         'updated_at', r.updated_at
       )
  FROM intelligent_retry_events r
 WHERE r.tenant_id = $1::uuid
   AND lower(r.subscriber_email::text) = lower($2)
 ORDER BY r.created_at DESC, r.id
 LIMIT $3`,
	},
	{
		name: "sequence_enrollments",
		query: `
SELECT jsonb_build_object(
         'id', e.id,
         'sequence_id', e.sequence_id,
         'subscriber_email', e.subscriber_email,
         'enrolled_at', e.enrolled_at,
         'completed_goal_at', e.completed_goal_at,
         'completed_goal_kind', e.completed_goal_kind
       )
  FROM sequence_enrollments e
 WHERE e.tenant_id = $1::uuid
   AND lower(e.subscriber_email::text) = lower($2)
 ORDER BY e.enrolled_at DESC, e.id DESC
 LIMIT $3`,
	},
	{
		name: "sequence_funnel_events",
		query: `
SELECT jsonb_build_object(
         'id', e.id,
         'sequence_id', e.sequence_id,
         'subscriber_email', e.subscriber_email,
         'position', e.position,
         'step_id', e.step_id,
         'variant_key', e.variant_key,
         'sent_at', e.sent_at,
         'opened_at', e.opened_at,
         'clicked_at', e.clicked_at
       )
  FROM sequence_funnel_events e
 WHERE e.tenant_id = $1::uuid
   AND lower(e.subscriber_email::text) = lower($2)
 ORDER BY e.sent_at DESC, e.id DESC
 LIMIT $3`,
	},
	{
		name: "journey_attributes",
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
)
SELECT jsonb_build_object(
         'id', a.id,
         'run_id', a.run_id,
         'flow_id', a.flow_id,
         'subscriber_id', a.subscriber_id,
         'name', a.name,
         'output_type', a.output_type,
         'source_node_id', a.source_node_id,
         'created_at', a.created_at,
         'updated_at', a.updated_at
       )
  FROM journey_attributes a
  JOIN subject s ON s.id = a.subscriber_id
 WHERE a.tenant_id = $1::uuid
 ORDER BY a.created_at DESC, a.id
 LIMIT $3`,
	},
	{
		name: "llm_action_invocations",
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
)
SELECT jsonb_build_object(
         'id', i.id,
         'run_id', i.run_id,
         'flow_id', i.flow_id,
         'node_id', i.node_id,
         'subscriber_id', i.subscriber_id,
         'model', i.model,
         'output_type', i.output_type,
         'output_attribute', i.output_attribute,
         'retry_count', i.retry_count,
         'latency_ms', i.latency_ms,
         'status', i.status,
         'created_at', i.created_at
       )
  FROM llm_action_invocations i
  JOIN subject s ON s.id = i.subscriber_id
 WHERE i.tenant_id = $1::uuid
 ORDER BY i.created_at DESC, i.id DESC
 LIMIT $3`,
	},
	{
		name: "automation_lifecycle_event_inbox",
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
)
SELECT jsonb_build_object(
         'source_event_id', i.source_event_id,
         'subscriber_key', i.subscriber_key,
         'subscriber_id', i.subscriber_id,
         'transition_sequence', i.transition_sequence,
         'event_type', i.event_type,
         'previous_stage', i.previous_stage,
         'next_stage', i.next_stage,
         'score', i.score,
         'transitioned_at', i.transitioned_at,
         'target_set_frozen', i.target_set_frozen,
         'intended_count', i.intended_count,
         'state', i.state,
         'accepted_at', i.accepted_at,
         'created_at', i.created_at,
         'updated_at', i.updated_at
       )
  FROM automation_lifecycle_event_inbox i
  JOIN subject s ON s.id = i.subscriber_key
 WHERE i.tenant_id = $1::uuid
 ORDER BY i.transition_sequence DESC, i.source_event_id
 LIMIT $3`,
	},
	{
		name: "automation_lifecycle_event_dispatches",
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
), subject_inbox AS (
  SELECT i.source_event_id
    FROM automation_lifecycle_event_inbox i
    JOIN subject s ON s.id = i.subscriber_key
   WHERE i.tenant_id = $1::uuid
)
SELECT jsonb_build_object(
         'source_event_id', d.source_event_id,
         'automation_id', d.automation_id,
         'trigger_type', d.trigger_type,
         'state', d.state,
         'result', d.result,
         'attempt_count', d.attempt_count,
         'accepted_at', d.accepted_at,
         'created_at', d.created_at,
         'updated_at', d.updated_at
       )
  FROM automation_lifecycle_event_dispatches d
  JOIN subject_inbox i ON i.source_event_id = d.source_event_id
 WHERE d.tenant_id = $1::uuid
 ORDER BY d.created_at DESC, d.source_event_id, d.automation_id
 LIMIT $3`,
	},
	{
		name:  "automation_lifecycle_subscriber_cursors",
		limit: 1000,
		query: `
WITH subject AS (
  SELECT s.id
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND lower(s.email::text) = lower($2)
)
SELECT jsonb_build_object(
         'subscriber_id', c.subscriber_id,
         'last_accepted_sequence', c.last_accepted_sequence,
         'last_source_event_id', c.last_source_event_id,
         'updated_at', c.updated_at
       )
  FROM automation_lifecycle_subscriber_cursors c
  JOIN subject s ON s.id = c.subscriber_id
 WHERE c.tenant_id = $1::uuid
 ORDER BY c.updated_at DESC
 LIMIT $3`,
	},
}

// BuildBundle is the exported entry point that mirrors the internal
// buildBundle helper. Wrapping rather than renaming keeps the existing
// in-package call sites (and tests) untouched.
func BuildBundle(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email string,
	playgroundSubjectAccess ...PlaygroundSubjectAccess,
) (map[string]any, BundleCounts, error) {
	var access PlaygroundSubjectAccess
	if len(playgroundSubjectAccess) > 0 {
		access = playgroundSubjectAccess[0]
	}
	out, counts, err := buildBundleWithPlaygroundSubjectAccess(
		ctx, tx, tenantID, email, access,
	)
	return out, BundleCounts{Events: counts.events, Consents: counts.consents}, err
}

func newBundleEnvelope(email string) map[string]any {
	return map[string]any{
		"schema":           "postwave.sar.v1",
		"generated_at":     time.Now().UTC().Format(time.RFC3339),
		"subscriber_email": email,
	}
}

func recordOptionalSARSection(
	out map[string]any,
	unavailableSections *[]string,
	section string,
	rows []map[string]any,
	err error,
) error {
	if errors.Is(err, errOptionalSARRelationMissing) {
		out[section] = rows
		*unavailableSections = append(*unavailableSections, section)
		return nil
	}
	if err != nil {
		return fmt.Errorf("load SAR section %q: %w", section, err)
	}
	out[section] = rows
	return nil
}

func trimAutomationSARSection(rows []map[string]any, limit int) ([]map[string]any, automationSARSectionMetadata) {
	if limit <= 0 {
		limit = defaultAutomationSARSectionLimit
	}
	truncated := len(rows) > limit
	if truncated {
		rows = rows[:limit]
	}
	return rows, automationSARSectionMetadata{
		ReturnedCount: len(rows),
		Truncated:     truncated,
		Limit:         limit,
	}
}

func loadAutomationSARSection(
	ctx context.Context,
	tx pgx.Tx,
	section sarSectionQuery,
	tenantID string,
	email string,
) ([]map[string]any, automationSARSectionMetadata, error) {
	limit := section.rowLimit()
	rows, err := loadOptionalEmail(ctx, tx, section.query, tenantID, email, limit+1)
	rows, metadata := trimAutomationSARSection(rows, limit)
	return rows, metadata, err
}

// buildBundle stitches the per-subscriber JSON view. Every section
// is tenant-scoped via the open tx; we explicitly never query the
// pool directly here. Missing tables (consent_receipts, forms,
// etc) degrade gracefully — a tenant with no consent log still
// gets a valid bundle with `consent_receipts: []`.
func buildBundle(ctx context.Context, tx pgx.Tx, tenantID, email string) (map[string]any, bundleCounts, error) {
	return buildBundleWithPlaygroundSubjectAccess(ctx, tx, tenantID, email, nil)
}

func buildBundleWithPlaygroundSubjectAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email string,
	playgroundSubjectAccess PlaygroundSubjectAccess,
) (map[string]any, bundleCounts, error) {
	out := newBundleEnvelope(email)
	counts := bundleCounts{}
	unavailableSections := make([]string, 0)
	// Helpdesk rows are relationally linked across conversations, messages,
	// tickets, assignments, assessments, agent records, note intents, provider
	// evidence, and Customer Hub configuration. Canonical subject discovery,
	// retention, and projection caps across that graph are not yet certified.
	// Keep the entire section explicitly unavailable even when legacy queries or
	// other sections happen to find no matching rows.
	unavailableSections = append(unavailableSections, "helpdesk_subject_access_complete")
	out["helpdesk_subject_access_status"] = map[string]any{
		"complete": false,
		"code":     "helpdesk_subject_access_release_held",
		"reason":   "Helpdesk subject discovery and lifecycle coverage are incomplete; this bundle must not be treated as a complete Helpdesk disclosure",
	}
	loadOptional := func(section, query string) error {
		rows, err := loadOptionalEmail(ctx, tx, query, tenantID, email)
		return recordOptionalSARSection(out, &unavailableSections, section, rows, err)
	}

	// 1. Canonical subscriber row.
	sub, err := loadSubscriber(ctx, tx, tenantID, email)
	if err != nil {
		return nil, counts, err
	}
	out["subscriber"] = sub

	// 2. Event history (capped — bundles >10k events should be
	//    rare, and beyond that the regulator's right-of-access is
	//    satisfied by the count + a representative window).
	events, err := loadEvents(ctx, tx, email)
	if err != nil {
		return nil, counts, err
	}
	out["events"] = events
	counts.events = len(events)

	// 3. Consent receipts (the table we just shipped). If the
	//    table doesn't exist in older deploys, fall back to []
	//    rather than 500ing.
	receipts, err := loadConsentReceipts(ctx, tx, email)
	if err != nil {
		return nil, counts, err
	}
	out["consent_receipts"] = receipts
	counts.consents = len(receipts)

	// 4. Form submissions tied to this email. This is a required disclosure
	//    section: a query, scan, or decoding failure must fail the request rather
	//    than turn retained form PII into a facially valid empty array.
	formSubmissions, err := loadFormSubmissions(ctx, tx, tenantID, email)
	if err != nil {
		return nil, counts, fmt.Errorf("load SAR section %q: %w", "form_submissions", err)
	}
	out["form_submissions"] = formSubmissions

	// 5. Topic preferences if the package is in use.
	out["topic_preferences"] = loadTopicPrefs(ctx, tx, tenantID, email)

	// 6. Additional PII-bearing tables (GDPR audit HIGH #1). Missing tables
	//    on an older deploy return []; every other error fails the export so a
	//    current-schema defect cannot masquerade as "the subject has no data".
	// bounce_events / complaint_events order by received_at, NOT `at` — there
	// is no `at` column on either table and there never was. Both sections
	// therefore returned nothing from the day they were written, and (before
	// loadOptionalEmail gained a savepoint) their failure aborted the whole
	// transaction and 500'd the entire subject-access export.
	if err := loadOptional("bounce_events", `
SELECT to_jsonb(b) - 'tenant_id'
  FROM bounce_events b
 WHERE b.tenant_id = $1::uuid AND lower(b.subscriber_email) = lower($2)
 ORDER BY b.received_at DESC LIMIT 10000`); err != nil {
		return nil, counts, err
	}
	if err := loadOptional("complaint_events", `
SELECT to_jsonb(c) - 'tenant_id'
  FROM complaint_events c
 WHERE c.tenant_id = $1::uuid AND lower(c.subscriber_email) = lower($2)
 ORDER BY c.received_at DESC LIMIT 10000`); err != nil {
		return nil, counts, err
	}
	if err := loadOptional("email_suppressions", `
SELECT to_jsonb(s) - 'tenant_id'
  FROM email_suppressions s
 WHERE s.tenant_id = $1::uuid AND lower(s.email) = lower($2)
 ORDER BY s.suppressed_at DESC LIMIT 1000`); err != nil {
		return nil, counts, err
	}
	if err := loadOptional("subscriber_notes", `
SELECT to_jsonb(n) - 'tenant_id'
  FROM subscriber_notes n
 WHERE n.tenant_id = $1::uuid AND lower(n.subscriber_email) = lower($2)
 ORDER BY n.created_at DESC LIMIT 1000`); err != nil {
		return nil, counts, err
	}

	// Route45 receipts are encrypted arbitrary-content records, so a plaintext
	// SQL projection cannot participate in the generic loadOptional family. The
	// injected loader resolves the subject digest, opens and binding-verifies each
	// retained envelope, and makes its synchronous cap explicit.
	if err := recordPlaygroundSubjectAccess(
		ctx, tx, tenantID, email, playgroundSubjectAccess,
		out, &unavailableSections,
	); err != nil {
		return nil, counts, err
	}

	// 7. SMS channel tables. This is a bounded legacy projection, not a
	// complete subject-access inventory: phone discovery through subscriptions
	// can miss inbox-only numbers and direct email-attributed consent, and the
	// current query family does not yet include clicks/tokens, conversation
	// state/tags/read receipts, or campaign/broadcast recipient attribution.
	// Keep the partial rows for compatibility, but mark the plane unavailable so
	// an empty array can never be treated as proof that no SMS data exists.
	unavailableSections = append(unavailableSections, "sms_subject_access_complete")
	out["sms_subject_access_status"] = map[string]any{
		"complete": false,
		"code":     "sms_subject_access_release_held",
		"reason":   "SMS subject discovery and lifecycle inventory are incomplete; partial legacy sections must not be treated as a complete disclosure",
	}
	if err := loadOptional("sms_subscriptions", `
SELECT to_jsonb(s) - 'tenant_id'
  FROM sms_subscriptions s
 WHERE s.tenant_id = $1::uuid AND lower(s.subscriber_email::text) = lower($2)
 ORDER BY s.updated_at DESC LIMIT 1000`); err != nil {
		return nil, counts, err
	}
	// Phone-keyed tables: a single CTE-joined query so we don't
	// have to round-trip phones back to Go and re-query.
	if err := loadOptional("sms_messages", `
WITH phones AS (
  SELECT DISTINCT phone_e164
    FROM sms_subscriptions
   WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
)
SELECT to_jsonb(m) - 'tenant_id'
  FROM sms_messages m
  JOIN phones p ON p.phone_e164 = m.phone_e164
 WHERE m.tenant_id = $1::uuid
 ORDER BY m.created_at DESC LIMIT 10000`); err != nil {
		return nil, counts, err
	}
	if err := loadOptional("sms_consent_events", `
WITH phones AS (
  SELECT DISTINCT phone_e164
    FROM sms_subscriptions
   WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
)
SELECT to_jsonb(c) - 'tenant_id'
  FROM sms_consent_events c
  JOIN phones p ON p.phone_e164 = c.phone_e164
 WHERE c.tenant_id = $1::uuid
 ORDER BY c.created_at DESC LIMIT 1000`); err != nil {
		return nil, counts, err
	}
	if err := loadOptional("sms_suppressions", `
WITH phones AS (
  SELECT DISTINCT phone_e164
    FROM sms_subscriptions
   WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
)
SELECT to_jsonb(s) - 'tenant_id'
  FROM sms_suppressions s
  JOIN phones p ON p.phone_e164 = s.phone_e164
 WHERE s.tenant_id = $1::uuid LIMIT 1000`); err != nil {
		return nil, counts, err
	}

	// 8. Subject-attributable automation history. Arrays retain their original
	// shape for wire compatibility. The additive metadata map makes every cap
	// explicit and reports whether the query's one-row look-ahead was trimmed.
	// Projections deliberately omit tenant ids, secrets, definitions, arbitrary
	// payload/metadata/value content, and operational error blobs.
	automationSectionMetadata := make(map[string]automationSARSectionMetadata, len(automationSARSections))
	for _, section := range automationSARSections {
		rows, metadata, err := loadAutomationSARSection(ctx, tx, section, tenantID, email)
		if err := recordOptionalSARSection(out, &unavailableSections, section.name, rows, err); err != nil {
			return nil, counts, err
		}
		automationSectionMetadata[section.name] = metadata
	}
	out["automation_section_metadata"] = automationSectionMetadata
	if len(unavailableSections) > 0 {
		// A rolling deploy against an older schema remains downloadable, but
		// the bundle must not misrepresent an unavailable relation as proof that
		// the subject had no rows in it.
		out["unavailable_sections"] = unavailableSections
	}

	return out, counts, nil
}

func recordPlaygroundSubjectAccess(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email string,
	access PlaygroundSubjectAccess,
	out map[string]any,
	unavailableSections *[]string,
) error {
	const availabilitySection = "webhook_simulator_email_locator_query_complete"
	if access == nil {
		out["webhook_simulator_receipts"] = []map[string]any{}
		out["webhook_simulator_subject_access_status"] = map[string]any{
			"complete":               false,
			"code":                   "webhook_simulator_email_locator_unconfigured",
			"scope":                  "retained receipts containing the requested conventional email-shaped identifier",
			"identity_scope":         "requested_email_literal",
			"aliases_included":       false,
			"continuation_available": false,
			"reason":                 "Webhook Simulator encrypted email-locator access is not configured; an empty section is not proof that no retained matching receipt exists",
		}
		*unavailableSections = append(*unavailableSections, availabilitySection)
		return nil
	}
	receipts, total, truncated, err := access.LoadPlaygroundSubjectReceipts(
		ctx, tx, tenantID, email,
	)
	if err != nil {
		return fmt.Errorf("load SAR section %q: %w", "webhook_simulator_receipts", err)
	}
	out["webhook_simulator_receipts"] = receipts
	status := map[string]any{
		"complete":                           !truncated,
		"code":                               "webhook_simulator_email_locator_query_complete",
		"scope":                              "retained receipts containing the requested conventional email-shaped identifier",
		"identity_scope":                     "requested_email_literal",
		"aliases_included":                   false,
		"continuation_available":             false,
		"non_email_identifiers_discoverable": false,
		"returned_count":                     len(receipts),
		"total_count":                        total,
		"truncated":                          truncated,
	}
	if truncated {
		status["code"] = "webhook_simulator_email_locator_query_truncated"
		status["reason"] = "The synchronous encrypted-receipt email-locator limit was reached; this bundle must not be treated as a complete query result even within the supported email scope"
		*unavailableSections = append(*unavailableSections, availabilitySection)
	}
	out["webhook_simulator_subject_access_status"] = status
	return nil
}

// loadOptionalEmail runs one of the optional PII-bearing sections of the
// disclosure. A genuinely absent relation (SQLSTATE 42P01) is the sole legacy
// compatibility case and returns an empty array plus an availability sentinel,
// which buildBundle records in unavailable_sections. Undefined columns and
// every other query/scan/JSON/transaction error are returned: silently
// translating those failures to [] would produce a facially successful but
// incomplete statutory disclosure.
func loadOptionalEmail(
	ctx context.Context,
	tx pgx.Tx,
	sql string,
	tenantID string,
	email string,
	extraArgs ...any,
) ([]map[string]any, error) {
	const sp = "sar_optional_section"
	if _, err := tx.Exec(ctx, "SAVEPOINT "+sp); err != nil {
		return nil, fmt.Errorf("create optional-section savepoint: %w", err)
	}
	abort := func(cause error) ([]map[string]any, error) {
		_, rollbackErr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+sp)
		_, releaseErr := tx.Exec(ctx, "RELEASE SAVEPOINT "+sp)
		if rollbackErr != nil {
			cause = errors.Join(cause, fmt.Errorf("rollback optional-section savepoint: %w", rollbackErr))
		}
		if releaseErr != nil {
			cause = errors.Join(cause, fmt.Errorf("release rolled-back optional-section savepoint: %w", releaseErr))
		}
		if rollbackErr == nil && releaseErr == nil && isUndefinedTable(cause) {
			return []map[string]any{}, errors.Join(errOptionalSARRelationMissing, cause)
		}
		return nil, cause
	}

	queryArgs := make([]any, 0, 2+len(extraArgs))
	queryArgs = append(queryArgs, tenantID, email)
	queryArgs = append(queryArgs, extraArgs...)
	rows, err := tx.Query(ctx, sql, queryArgs...)
	if err != nil {
		return abort(err)
	}
	defer rows.Close()

	out := make([]map[string]any, 0, 8)
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			return abort(fmt.Errorf("scan optional-section row: %w", err))
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			rows.Close()
			return abort(fmt.Errorf("decode optional-section row: %w", err))
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return abort(err)
	}
	rows.Close()

	if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT "+sp); err != nil {
		return nil, fmt.Errorf("release optional-section savepoint: %w", err)
	}
	return out, nil
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

func loadSubscriber(ctx context.Context, tx pgx.Tx, tenantID, email string) (map[string]any, error) {
	var raw []byte
	// Explicit tenant_id predicate alongside the RLS GUC (GDPR
	// audit CRITICAL #3). RLS already filters by app.tenant_id but
	// adding the WHERE clause hardens against any future code path
	// that reaches here without a tenant-scoped tx (e.g. a worker
	// using app.outbox_worker bypass).
	err := tx.QueryRow(ctx, `
SELECT COALESCE(to_jsonb(s) - 'tenant_id', '{}'::jsonb)::text::bytea
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid
   AND s.email     = $2`, tenantID, email).Scan(&raw)
	if err != nil {
		if err == pgx.ErrNoRows {
			return map[string]any{"found": false}, nil
		}
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}, nil
	}
	out["found"] = true
	return out, nil
}

func loadEvents(ctx context.Context, tx pgx.Tx, email string) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `
SELECT event_type, COALESCE(campaign_id::text, ''),
       COALESCE(link_url, ''), COALESCE(user_agent, ''),
       COALESCE(host(ip), ''), at
  FROM subscriber_events
 WHERE subscriber_email = $1
 ORDER BY at DESC
 LIMIT 10000`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var et, cid, link, ua, ip string
		var at time.Time
		if err := rows.Scan(&et, &cid, &link, &ua, &ip, &at); err != nil {
			continue
		}
		row := map[string]any{"event_type": et, "at": at}
		if cid != "" {
			row["campaign_id"] = cid
		}
		if link != "" {
			row["link_url"] = link
		}
		if ua != "" {
			row["user_agent"] = ua
		}
		if ip != "" {
			row["ip"] = ip
		}
		out = append(out, row)
	}
	return out, nil
}

func loadConsentReceipts(ctx context.Context, tx pgx.Tx, email string) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `
SELECT id, COALESCE(prev_state, ''), new_state, source,
       COALESCE(source_detail, ''), COALESCE(host(ip), ''),
       COALESCE(user_agent, ''), COALESCE(privacy_policy_version, ''),
       COALESCE(captured_text, ''), at
  FROM consent_receipts
 WHERE subscriber_email = $1
 ORDER BY at DESC`, email)
	if err != nil {
		// Table missing or any other read failure: return []
		// rather than failing the whole bundle.
		return []map[string]any{}, nil
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var prev, ns, src, det, ip, ua, ver, txt string
		var at time.Time
		if err := rows.Scan(&id, &prev, &ns, &src, &det, &ip, &ua, &ver, &txt, &at); err != nil {
			continue
		}
		row := map[string]any{
			"id":        id,
			"new_state": ns,
			"source":    src,
			"at":        at,
		}
		if prev != "" {
			row["prev_state"] = prev
		}
		if det != "" {
			row["source_detail"] = det
		}
		if ip != "" {
			row["ip"] = ip
		}
		if ua != "" {
			row["user_agent"] = ua
		}
		if ver != "" {
			row["privacy_policy_version"] = ver
		}
		if txt != "" {
			row["captured_text"] = txt
		}
		out = append(out, row)
	}
	return out, nil
}

// formSubmissionsSARQuery is an explicit disclosure allowlist for the current
// form_submissions schema. The public confirmation token is intentionally not
// disclosed: it is a live bearer capability rather than subject data. Tenant
// ids are likewise internal isolation keys. All other subject-provided,
// ambient, status, network, and chronology fields are retained, together with
// the consent evidence written for the exact submission.
//
// There is deliberately no silent row cap. A subject-access response must not
// claim completeness while truncating older submissions.
const formSubmissionsSARQuery = `
SELECT jsonb_build_object(
         'id', s.id,
         'form_id', s.form_id,
         'email', s.email,
         'name', s.name,
         'signup_source', s.signup_source,
         'target_list_ids', to_jsonb(s.target_list_ids),
         'custom_fields', s.custom_fields,
         'metadata', s.metadata,
         'status', s.status,
         'ip', host(s.ip),
         'user_agent', s.user_agent,
         'submitted_at', s.submitted_at,
         'confirmed_at', s.confirmed_at,
         'consent_events', COALESCE((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', c.id,
                      'channel', c.channel,
                      'category', c.category,
                      'action', c.action,
                      'source', c.source,
                      'policy_version', c.policy_version,
                      'preferences', c.preferences,
                      'proof_text', c.proof_text,
                      'ip', host(c.ip),
                      'user_agent', c.user_agent,
                      'occurred_at', c.created_at,
                      'recorded_at', c.recorded_at
                    )
                    ORDER BY c.created_at DESC, c.id DESC
                  )
             FROM consent_events c
            WHERE c.tenant_id = s.tenant_id
              AND c.subject_type = 'subscriber'
              AND c.subject_id = s.id::text
              AND lower(c.subject_email::text) = lower(s.email::text)
              AND c.source = 'public_form'
         ), '[]'::jsonb)
       )
  FROM form_submissions s
 WHERE s.tenant_id = $1::uuid
   AND lower(s.email::text) = lower($2)
 ORDER BY s.submitted_at DESC, s.id DESC`

func loadFormSubmissions(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	email string,
) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, formSubmissionsSARQuery, tenantID, email)
	if err != nil {
		return nil, fmt.Errorf("query form submissions: %w", err)
	}
	defer rows.Close()

	out := make([]map[string]any, 0, 8)
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("scan form submission: %w", err)
		}
		var submission map[string]any
		if err := json.Unmarshal(raw, &submission); err != nil {
			return nil, fmt.Errorf("decode form submission: %w", err)
		}
		out = append(out, submission)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate form submissions: %w", err)
	}
	return out, nil
}

// loadTopicPrefs reads the subject's topic opt-ins for the Art. 15 disclosure.
//
// This query was broken from the day it was written: it selected
// `subscribed, updated_at FROM subscriber_topic_preferences`, and NO migration
// has ever created a table by that name. The real table is `subscriber_topics`
// (columns opted_in, at). The SAVEPOINT below was supposed to contain that
// failure — but pgx defers a query error to rows.Next()/rows.Err(), so err was
// nil here, the rollback never fired, and the aborted transaction poisoned the
// whole export: every subject-access request 500'd.
//
// Two fixes, therefore: query the table that exists, and actually check
// rows.Err() so a future schema drift degrades this one section instead of
// taking the entire disclosure down with it.
func loadTopicPrefs(ctx context.Context, tx pgx.Tx, tenantID, email string) []map[string]any {
	if _, err := tx.Exec(ctx, "SAVEPOINT sar_topic_prefs"); err != nil {
		return []map[string]any{}
	}
	abort := func() []map[string]any {
		_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT sar_topic_prefs")
		return []map[string]any{}
	}

	rows, err := tx.Query(ctx, `
SELECT topic_id::text, opted_in, at
  FROM subscriber_topics
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2
 ORDER BY at DESC`, tenantID, email)
	if err != nil {
		return abort()
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var tid string
		var optedIn bool
		var at time.Time
		if err := rows.Scan(&tid, &optedIn, &at); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"topic_id":   tid,
			"subscribed": optedIn,
			"updated_at": at,
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return abort()
	}
	rows.Close()

	_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT sar_topic_prefs")
	return out
}

// --- zip helpers ---

func buildZip(id, email string, requestedAt time.Time, bundle []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	readme := fmt.Sprintf(`Moosewave Subject Access Request bundle
=======================================

Request ID:        %s
Subscriber email:  %s
Generated at:      %s

Contents:
  bundle.json    Full point-in-time JSON view of all personal data
                 the operator holds about this subscriber. See the
                 'schema' field for format version.

This bundle was produced under GDPR Article 15 / CCPA §1798.100.
It is a snapshot. Subsequent activity is NOT reflected — re-run
the SAR to get a fresh bundle.
`, id, email, requestedAt.UTC().Format(time.RFC3339))
	if err := writeZip(zw, "README.txt", []byte(readme)); err != nil {
		return nil, err
	}
	if err := writeZip(zw, "bundle.json", bundle); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeZip(zw *zip.Writer, name string, content []byte) error {
	f, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = f.Write(content)
	return err
}

func sanitizeEmail(email string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(email) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-_.")
	if out == "" {
		return "subscriber"
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
