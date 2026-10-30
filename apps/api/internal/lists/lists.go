// Package lists exposes a tenant-scoped passthrough to Listmonk's lists.
//
// Per LICENSE-BOUNDARY.md the gateway only ever talks to Listmonk over HTTP.
// Listmonk's lists carry no tenant: the gateway attributes each one through
// list_id_map, which pairs the engine's bigint with the Moosewave uuid that
// membership, webhooks and analytics are keyed on (identity.go). A list with
// no identity in the calling tenant is not that tenant's, unless the tenant is
// the only one the process-global engine serves (engine_tenancy.go).
package lists

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// Repo is a thin Postgres-backed sidecar to the Listmonk-proxying Deps
// surface. It owns the queries that need to live in the gateway rather
// than upstream (e.g. counting subscribers for the campaign pre-send
// checklist, where the round-trip latency of going through Listmonk
// would block the checklist render). The HTTP CRUD surface for lists
// still proxies straight to Listmonk via Deps.
type Repo struct {
	Pool *db.Pool
	// OutboundWebhooks is the sole writer for list-scoped customer webhook
	// endpoints. Keeping it here prevents the legacy list façade from
	// bypassing destination/signing-secret envelopes, tombstones, activation
	// readiness, delivery pausing, and canonical validation.
	OutboundWebhooks *outbound_webhooks.Store
	// MembershipWebhooks is wired in production to the canonical set-based
	// transactional fanout. A fanout error fails the membership transaction
	// closed so committed state and customer delivery intent cannot diverge.
	// nil preserves lightweight read-only/unit-test construction.
	MembershipWebhooks MembershipWebhookFanout
}

// CountListAudience returns the number of subscribers attached to
// listID. The local `list_subscribers` join table (migration 0222) is
// the source of truth for Moosewave-side membership; Listmonk's own
// list count can drift when the migration materialiser hasn't run yet,
// so we read the gateway's view rather than round-tripping upstream.
//
// listID accepts either a canonical Moosewave UUID or a positive Listmonk
// bigint, resolved through list_id_map inside the same tenant-scoped
// transaction as the count. A list the tenant has no live identity for — in
// either form — is returned as a typed error instead of being misrepresented
// as an empty audience.
func (r *Repo) CountListAudience(ctx context.Context, tenantID, listID string) (int64, error) {
	if strings.TrimSpace(tenantID) == "" {
		return 0, fmt.Errorf("lists: tenant id required")
	}
	if _, _, err := ParseListID(listID); err != nil {
		return 0, err
	}
	if r == nil || r.Pool == nil {
		return 0, ErrListsRepoUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	identity, err := ResolveListIdentityTx(ctx, tx, tenantID, listID)
	if err != nil {
		return 0, err
	}
	var n int64
	err = tx.QueryRow(ctx, `
SELECT COUNT(*) FROM `+activeMembersFrom+`
 WHERE ls.tenant_id = $1::uuid
   AND ls.list_id = $2::uuid
   AND `+activeMemberPredicate, tenantID, identity.UUID).Scan(&n)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

type Deps struct {
	Destination     func(context.Context) (listmonk.Config, error)
	ListmonkBaseURL string
	Username        string
	Password        string
	HTTPClient      *http.Client
	// WebhookHTTPClient is separate from the Listmonk proxy client because
	// tenant-controlled webhook destinations require the canonical hardened
	// outbound transport in non-development environments.
	WebhookHTTPClient   *http.Client
	RequireWebhookHTTPS bool
	// Repo is the Postgres-backed sidecar used by analytics / archive /
	// members handlers that need direct DB access. Wired by the caller
	// after New() returns; analytics handlers guard on Repo == nil.
	Repo *Repo
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller after
	// New() returns; nil-safe at the httperror call site.
	Logger *slog.Logger
	// ensureListIdentity is a focused test seam. Production always leaves it
	// nil and writes through Repo.ensureListIDMap.
	ensureListIdentity func(context.Context, string, string, int64) (string, error)
}

const (
	listJSONMaxBodyBytes      int64 = 64 << 10 // 64 KiB
	listmonkProxyMaxBodyBytes int64 = 4 << 20  // 4 MiB
)

func New(baseURL, username, password string) *Deps {
	return &Deps{
		ListmonkBaseURL: baseURL,
		Username:        username,
		Password:        password,
		HTTPClient:      &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

func (d *Deps) MountRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadSubscribers)
	write := apikeys.RequireScope(apikeys.ScopeWriteSubscribers)
	r.With(read).Get("/api/v1/lists", d.List)
	// AUDIT-DESKTOP-2026-06-10 §5.1: the members handler existed in
	// members.go but was never mounted, so the desktop Members tab
	// 404'd end-to-end. Wrapped with RecordSurfaceFunc consistent with
	// the sibling mutating routes.
	r.With(read).Get("/api/v1/lists/{id}/subscribers", observability.RecordSurfaceFunc("lists", "members", d.GetSubscribers))
	// D04#10: the reverse membership read — which lists a subscriber
	// belongs to — backs the subscriber slideover's Lists section. Routed
	// under /lists/for-subscriber/{sub_id} (a literal segment, so it never
	// collides with /lists/{id}/subscribers or the subscribers package's
	// /subscribers/{id} param). Read-scoped for API-key callers.
	r.With(read).
		Get("/api/v1/lists/for-subscriber/{sub_id}", observability.RecordSurfaceFunc("lists", "for_subscriber", d.GetListsForSubscriber))
	// AUDIT-DESKTOP-2026-06-10 §A1: membership write surface
	// (membership_write.go). POST is idempotent by construction
	// (re-adding an active member is a counted no-op) so it lives here
	// rather than in the idempotency-middleware group. Both mutating
	// routes are scope-gated for API-key callers with
	// write:subscribers, matching the audience-syncs / sms route
	// pattern (r.With(apikeys.RequireScope(...))).
	r.With(write).
		Post("/api/v1/lists/{id}/subscribers", observability.RecordSurfaceFunc("lists", "members_add", d.AddSubscribers))
	r.With(write).
		Delete("/api/v1/lists/{id}/subscribers/{sub_id}", observability.RecordSurfaceFunc("lists", "members_remove", d.RemoveSubscriber))
	// AUDIT-DESKTOP-2026-06-10 §A2 (GAP-LS-143): list-scoped
	// suppressions read (member_suppressions.go). Read-scoped for
	// API-key callers.
	r.With(read).
		Get("/api/v1/lists/{id}/suppressions", observability.RecordSurfaceFunc("lists", "member_suppressions", d.GetSuppressions))
	// p4d-recordsurface-wire-others: mutating route gets the
	// pw_lists_<action>_total + pw_lists_duration_seconds pair.
	r.With(write).Delete("/api/v1/lists/{id}", observability.RecordSurfaceFunc("lists", "delete", d.Delete))
}

func (d *Deps) MountIdempotentRoutes(r chi.Router) {
	write := apikeys.RequireScope(apikeys.ScopeWriteSubscribers)
	r.With(write).Post("/api/v1/lists", observability.RecordSurfaceFunc("lists", "create", d.Create))
	// PATCH lives inside the idempotency group so a retried partial
	// update (network flake mid-flight) doesn't double-apply field
	// changes. Listmonk exposes the update as PUT /api/lists/{id};
	// we expose it as PATCH to match the rest of the gateway's
	// REST surface (PATCH = partial update of a single resource).
	r.With(write).Patch("/api/v1/lists/{id}", observability.RecordSurfaceFunc("lists", "update", d.Update))
}

type List struct {
	// ID remains Listmonk's engine bigint for compatibility with the
	// catalogue API. PostwaveUUID is the canonical identity for local detail,
	// membership and analytics routes.
	ID           int64    `json:"id"`
	PostwaveUUID string   `json:"postwave_uuid,omitempty"`
	Name         string   `json:"name"`
	Type         string   `json:"type,omitempty"`
	Optin        string   `json:"optin,omitempty"`
	Tags         []string `json:"tags,omitempty"`
	Description  string   `json:"description,omitempty"`
}

type CreateListInput struct {
	Name        string   `json:"name"`
	Type        string   `json:"type,omitempty"`
	Optin       string   `json:"optin,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Description string   `json:"description,omitempty"`
}

func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CreateListInput
	if err := httpbody.DecodeJSON(w, r, listJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_name", "name required"))
		return
	}
	if in.Type == "" {
		in.Type = "private"
	}
	if in.Optin == "" {
		in.Optin = "single"
	}
	if !d.canPersistListIdentity() {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	payload, _ := json.Marshal(in)
	body, status, err := d.proxy(r, http.MethodPost, "/api/lists", payload)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if status < 200 || status >= 300 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(body)
		return
	}
	created, err := decodeCreatedList(body)
	if err != nil {
		d.logCreateIdentityFailure("unverifiable upstream create response", 0, "", err, 0)
		d.recordUnverifiableCreate(r.Context(), in, status)
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]any{
				"code":                   "list_identity_unverifiable",
				"message":                "list service returned success without an exact list identity; contact support before retrying",
				"mapping_state":          "unverifiable",
				"recovery_required":      true,
				"compensation_attempted": false,
			},
		})
		return
	}
	postwaveUUID, identityFailure := d.establishCreatedListIdentity(r.Context(), tenant.ID, created.ID)
	if identityFailure != nil {
		d.writeCreateIdentityFailure(w, identityFailure)
		return
	}
	created.PostwaveUUID = postwaveUUID
	body, err = addCreatedListIdentity(body, postwaveUUID)
	if err != nil {
		// The response was already decoded above. Fall back to the canonical
		// projection rather than returning a retryable 5xx after the mapping has
		// committed (which could cause a second upstream create).
		d.logCreateIdentityFailure("could not bind create response identity", created.ID, postwaveUUID, err, 0)
		body, _ = json.Marshal(map[string]any{"data": created})
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.create", "list", postwaveUUID,
		nil, created, map[string]any{"engine_id": created.ID})
	w.Header().Set("X-Postwave-List-UUID", postwaveUUID)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func decodeCreatedList(body []byte) (*List, error) {
	var env struct {
		Data List `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("decode list create response: %w", err)
	}
	if env.Data.ID <= 0 {
		return nil, errors.New("list create response has no positive engine id")
	}
	return &env.Data, nil
}

func addCreatedListIdentity(body []byte, postwaveUUID string) ([]byte, error) {
	if _, err := normalizeListUUID(postwaveUUID); err != nil {
		return nil, err
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, err
	}
	dataRaw, ok := env["data"]
	if !ok {
		return nil, errors.New("list create response has no data object")
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(dataRaw, &data); err != nil {
		return nil, err
	}
	encodedUUID, _ := json.Marshal(postwaveUUID)
	data["postwave_uuid"] = encodedUUID
	encodedData, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	env["data"] = encodedData
	return json.Marshal(env)
}

// extractListIDFromResponse parses Listmonk's `{"data":{"id":N}}`
// envelope to drive the audit row's resourceID after Create. Returns
// "" on malformed/empty bodies so the audit row still records — just
// without a concrete id — rather than dropping the row entirely.
func extractListIDFromResponse(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var env struct {
		Data struct {
			ID int64 `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return ""
	}
	if env.Data.ID == 0 {
		return ""
	}
	return strconv.FormatInt(env.Data.ID, 10)
}

// CreateForAgent creates a Listmonk list on behalf of an autonomous agent
// (native MCP / in-app). It is the request-less twin of the Create HTTP
// handler: identical defaults (type=private, optin=single), the same single
// HTTP hop to Listmonk via proxyCtx, and the same audit emit — just callable
// without an *http.Request. tenantID is required (the auth gate the HTTP
// handler enforces via TenantFromContext); it is also used for the audit row.
func (d *Deps) CreateForAgent(ctx context.Context, tenantID string, in CreateListInput) (*List, error) {
	ctx = tenantengine.WithTenant(ctx, tenantID)
	if strings.TrimSpace(tenantID) == "" {
		return nil, errors.New("lists: tenant required")
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return nil, errors.New("name is required")
	}
	if in.Type == "" {
		in.Type = "private"
	}
	if in.Optin == "" {
		in.Optin = "single"
	}
	if !d.canPersistListIdentity() {
		return nil, ErrListsRepoUnavailable
	}
	payload, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	body, status, err := d.proxyCtx(ctx, http.MethodPost, "/api/lists", payload)
	if err != nil {
		// Transport/connection failure — keep raw detail (host/dial) out of
		// the agent-facing error.
		return nil, errors.New("could not reach the list service")
	}
	if status < 200 || status >= 300 {
		// Listmonk's error envelope ({"message":"..."}) is operator-facing
		// (e.g. "list name already exists"); surface it when present.
		var em struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &em)
		if msg := strings.TrimSpace(em.Message); msg != "" {
			return nil, fmt.Errorf("could not create list: %s", msg)
		}
		return nil, fmt.Errorf("could not create list (listmonk status %d)", status)
	}
	created, err := decodeCreatedList(body)
	if err != nil {
		d.recordUnverifiableCreate(ctx, in, status)
		return nil, &ListIdentityCreateError{
			MappingState:       "unverifiable",
			RecoveryRequired:   true,
			CompensationStatus: 0,
		}
	}
	postwaveUUID, identityFailure := d.establishCreatedListIdentity(ctx, tenantID, created.ID)
	if identityFailure != nil {
		return nil, identityFailure
	}
	created.PostwaveUUID = postwaveUUID
	audit.EmitOrLog(ctx, d.auditPool(), "list.create", "list", postwaveUUID, nil, created,
		map[string]any{"engine_id": created.ID})
	return created, nil
}

// auditPool resolves the *db.Pool used for audit emits. Returns nil
// when no Repo is wired (tests / lite mode) — audit.EmitOrLog handles
// nil pool as a warn-and-return so the caller doesn't need a guard.
func (d *Deps) auditPool() *db.Pool {
	if d == nil || d.Repo == nil {
		return nil
	}
	return d.Repo.Pool
}

func (d *Deps) recordUnverifiableCreate(ctx context.Context, in CreateListInput, upstreamStatus int) {
	audit.EmitOrLog(ctx, d.auditPool(), "list.create_identity_unverifiable", "list", "",
		nil, nil, map[string]any{
			"requested_name":  in.Name,
			"upstream_status": upstreamStatus,
		})
}

// updateAllowedFields enumerates the body keys PATCH accepts. Anything
// else is rejected with 400 unknown_field so a typo (`Name` instead of
// `name`) doesn't silently no-op and create a confusing operator
// experience. The set mirrors what Listmonk's PUT /api/lists/{id}
// understands plus the gateway-side defaults that Create fills in.
var updateAllowedFields = map[string]struct{}{
	"name":        {},
	"type":        {},
	"optin":       {},
	"description": {},
	"tags":        {},
}

// Update proxies PATCH /api/v1/lists/{id} to Listmonk's PUT
// /api/lists/{id}. Body fields are whitelisted; unknown fields fail
// closed with 400 rather than being silently dropped. Required
// validation matches Create: name (if provided) must be non-empty,
// type/optin (if provided) must be one of the values Listmonk accepts.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	engineID, ok := parseInt64Strict(id)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "id must be a positive integer"))
		return
	}
	// Decode into a RawMessage map so we can both (a) reject unknown
	// fields by key inspection and (b) preserve the original JSON
	// shape for forwarding (tags is a []string, description a string;
	// re-marshalling a map[string]any would normalise number/bool
	// types we don't intend to touch).
	var raw map[string]json.RawMessage
	if err := httpbody.DecodeJSON(w, r, listJSONMaxBodyBytes, &raw); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(raw) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("empty_body", "at least one field required"))
		return
	}
	for k := range raw {
		if _, ok := updateAllowedFields[k]; !ok {
			writeJSON(w, http.StatusBadRequest, errEnv("unknown_field", "field not allowed: "+k))
			return
		}
	}
	// Per-field validation: catch obvious bad shapes before going
	// upstream so operators get a meaningful 400 instead of a
	// Listmonk 422 echoed verbatim.
	if v, ok := raw["name"]; ok {
		var name string
		if err := json.Unmarshal(v, &name); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_field", "name must be string"))
			return
		}
		if strings.TrimSpace(name) == "" {
			writeJSON(w, http.StatusBadRequest, errEnv("missing_name", "name required"))
			return
		}
	}
	if v, ok := raw["type"]; ok {
		var t string
		if err := json.Unmarshal(v, &t); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_field", "type must be string"))
			return
		}
		if t != "private" && t != "public" && t != "temporary" {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_field", "type must be private|public|temporary"))
			return
		}
	}
	if v, ok := raw["optin"]; ok {
		var o string
		if err := json.Unmarshal(v, &o); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_field", "optin must be string"))
			return
		}
		if o != "single" && o != "double" {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_field", "optin must be single|double"))
			return
		}
	}
	if v, ok := raw["description"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_field", "description must be string"))
			return
		}
	}
	if v, ok := raw["tags"]; ok {
		var tags []string
		if err := json.Unmarshal(v, &tags); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_field", "tags must be []string"))
			return
		}
	}
	if !d.authorizeEngineListChange(w, r, tenant.ID, engineID) {
		return
	}
	payload, _ := json.Marshal(raw)
	body, status, err := d.proxy(r, http.MethodPut, "/api/lists/"+id, payload)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if status >= 200 && status < 300 {
		audit.EmitOrLog(r.Context(), d.auditPool(), "list.update", "list", id,
			nil, raw, nil)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// authorizeEngineListChange decides whether this tenant may change engine list
// engineID on the process-global Listmonk. A list the tenant has an identity
// for is its own. A list nobody has an identity for belongs to the tenant only
// when it is the sole tenant (engine_tenancy.go). Anything else is another
// tenant's list, or one no tenant can prove, and is reported as not found —
// the catalogue does not show it either. Writes the response and returns false
// when the change must not go upstream.
func (d *Deps) authorizeEngineListChange(w http.ResponseWriter, r *http.Request, tenantID string, engineID int64) bool {
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return false
	}
	_, err := d.Repo.GetListUUIDByBigintID(r.Context(), tenantID, engineID)
	if err == nil {
		return true
	}
	if !errors.Is(err, ErrListIDNotMapped) {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return false
	}
	sole, err := d.Repo.isSoleTenant(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return false
	}
	if !sole {
		writeJSON(w, http.StatusNotFound, errEnv("list_not_found", "list not found"))
		return false
	}
	return true
}

func (d *Deps) proxy(r *http.Request, method, path string, body []byte) ([]byte, int, error) {
	return d.proxyCtx(r.Context(), method, path, body)
}

// proxyCtx is the request-less core of proxy: a single HTTP hop to Listmonk
// (LICENSE-BOUNDARY: the gateway only ever talks to Listmonk over HTTP) with
// config-based basic auth. proxy is a thin *http.Request wrapper over it;
// CreateForAgent (the native-tool path) calls this directly with the caller's
// context so a list can be created without an inbound HTTP request.
func (d *Deps) proxyCtx(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	if d.HTTPClient == nil {
		d.HTTPClient = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	base, user, password := d.ListmonkBaseURL, d.Username, d.Password
	if d.Destination != nil {
		destination, err := d.Destination(ctx)
		if err != nil {
			return nil, 0, err
		}
		base, user, password = destination.BaseURL, destination.Username, destination.Password
	}
	endpoint, err := listmonkProxyURL(base, path)
	if err != nil {
		return nil, 0, err
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, rdr)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if user != "" || password != "" {
		req.SetBasicAuth(user, password)
	}
	resp, err := d.HTTPClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	buf, err := readProxyResponseBody(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("read body: %w", err)
	}
	return buf, resp.StatusCode, nil
}

func listmonkProxyURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid listmonk base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported listmonk base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe listmonk base URL")
	}
	rel := strings.TrimLeft(path, "/")
	pathPart, rawQuery, _ := strings.Cut(rel, "?")
	for _, segment := range strings.Split(pathPart, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe listmonk request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") || strings.Contains(unescaped, "\\") {
			return "", fmt.Errorf("unsafe listmonk request path")
		}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + pathPart
	base.RawQuery = rawQuery
	return base.String(), nil
}

func readProxyResponseBody(r io.Reader) ([]byte, error) {
	buf, err := io.ReadAll(io.LimitReader(r, listmonkProxyMaxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) > listmonkProxyMaxBodyBytes {
		return nil, fmt.Errorf("response body exceeds %d bytes", listmonkProxyMaxBodyBytes)
	}
	return buf, nil
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
