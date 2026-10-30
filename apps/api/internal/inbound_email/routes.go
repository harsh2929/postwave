// SPDX-License-Identifier: AGPL-3.0-only
//
// routes.go — Mailgun-Routes-killer inbound matcher + action
// dispatcher. The Ingest handler calls Match() with the parsed
// inbound email; the matcher walks inbound_routes by ascending
// priority and returns the first matching route (or every match
// when stop_on_match=false).
//
// Actions are applied in order; failures are logged but don't halt
// the rest of the actions (best-effort fanout — the inbound_emails
// row write is the durable contract).

package inbound_email

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Route mirrors a single inbound_routes row.
//
// v2 (migration 0194) added the retry-policy columns:
//   - ActionRetryMax: 0..5 additional attempts per retryable action.
//   - ActionRetryBackoffSeconds: base for exponential backoff
//     between retries.
//
// Both default to v1 semantics (no retry, 2s base) so existing
// routes keep their old behaviour without an explicit edit.
type Route struct {
	ID                        string        `json:"id"`
	Name                      string        `json:"name"`
	Priority                  int           `json:"priority"`
	StopOnMatch               bool          `json:"stop_on_match"`
	Enabled                   bool          `json:"enabled"`
	MatchRecipient            string        `json:"match_recipient"`
	MatchSubjectPrefix        string        `json:"match_subject_prefix,omitempty"`
	MatchFromDomain           string        `json:"match_from_domain,omitempty"`
	Actions                   []RouteAction `json:"actions"`
	LastMatchedAt             *time.Time    `json:"last_matched_at,omitempty"`
	MatchCount                int           `json:"match_count"`
	ActionRetryMax            int           `json:"action_retry_max"`
	ActionRetryBackoffSeconds int           `json:"action_retry_backoff_seconds"`
	// UpdatedAt is the configuration revision used by action-array writes.
	// Runtime match counters deliberately do not advance it.
	UpdatedAt time.Time `json:"updated_at"`
}

// RouteAction is one step of a route's reaction.
type RouteAction struct {
	Kind                  string         `json:"kind"` // tag | automation_trigger | webhook | forward | store_only
	Tag                   string         `json:"tag,omitempty"`
	EventType             string         `json:"event_type,omitempty"`
	URL                   string         `json:"url,omitempty"`
	To                    string         `json:"to,omitempty"`
	Extra                 map[string]any `json:"extra,omitempty"`
	HasStoredHMACSecret   bool           `json:"has_stored_hmac_secret,omitempty"`
	PreserveHMACFromIndex *int           `json:"preserve_hmac_from_index,omitempty"`
	RemoveStoredHMAC      bool           `json:"remove_stored_hmac,omitempty"`
}

const maxRouteActions = 50

func cloneRouteActionExtra(extra map[string]any) map[string]any {
	if len(extra) == 0 {
		return nil
	}
	out := make(map[string]any, len(extra))
	for key, value := range extra {
		out[key] = value
	}
	return out
}

// redactRouteActionSecrets returns an admin-safe projection. Stored webhook
// signing material remains available to the executor but is never serialized
// into catalogue or preview responses.
func redactRouteActionSecrets(actions []RouteAction) []RouteAction {
	if actions == nil {
		return []RouteAction{}
	}
	out := make([]RouteAction, len(actions))
	for index, action := range actions {
		safe := action
		safe.Extra = cloneRouteActionExtra(action.Extra)
		safe.HasStoredHMACSecret = false
		safe.PreserveHMACFromIndex = nil
		safe.RemoveStoredHMAC = false
		if secret, ok := safe.Extra["hmac_secret"].(string); ok && secret != "" {
			safe.HasStoredHMACSecret = true
		}
		delete(safe.Extra, "hmac_secret")
		if len(safe.Extra) == 0 {
			safe.Extra = nil
		}
		out[index] = safe
	}
	return out
}

func validRouteHMACSecret(value any) (string, bool) {
	secret, ok := value.(string)
	if !ok || secret == "" || len([]byte(secret)) > 4_096 {
		return "", false
	}
	for _, character := range secret {
		if character < 0x20 || character == 0x7f {
			return "", false
		}
	}
	return secret, true
}

// prepareCreatedRouteActions strips response-only fields and rejects update
// preservation controls on a new route.
func prepareCreatedRouteActions(actions []RouteAction) ([]RouteAction, error) {
	if len(actions) > maxRouteActions {
		return nil, fmt.Errorf("at most %d actions are allowed", maxRouteActions)
	}
	out := make([]RouteAction, len(actions))
	for index, action := range actions {
		if action.PreserveHMACFromIndex != nil || action.RemoveStoredHMAC {
			return nil, fmt.Errorf("action %d: stored HMAC controls require an existing route", index+1)
		}
		action.HasStoredHMACSecret = false
		action.PreserveHMACFromIndex = nil
		action.RemoveStoredHMAC = false
		action.Extra = cloneRouteActionExtra(action.Extra)
		if raw, present := action.Extra["hmac_secret"]; present {
			if action.Kind != "webhook" {
				return nil, fmt.Errorf("action %d: HMAC signing material is valid only for webhooks", index+1)
			}
			if _, ok := validRouteHMACSecret(raw); !ok {
				return nil, fmt.Errorf("action %d: HMAC secret must use 1-4096 bytes without control characters", index+1)
			}
		}
		out[index] = action
	}
	return out, nil
}

// mergeUpdatedRouteActionSecrets resolves opaque preservation controls against
// the locked pre-update action array. Only the merged RouteAction values are
// persisted; control and response-marker fields are always stripped.
var errRouteConfigurationChanged = errors.New("route configuration changed; refresh before saving")

func mergeUpdatedRouteActionSecrets(
	next, existing []RouteAction,
	expectedUpdatedAt *time.Time,
	currentUpdatedAt time.Time,
) ([]RouteAction, error) {
	if expectedUpdatedAt == nil || !expectedUpdatedAt.Equal(currentUpdatedAt) {
		return nil, errRouteConfigurationChanged
	}
	if len(next) > maxRouteActions {
		return nil, fmt.Errorf("at most %d actions are allowed", maxRouteActions)
	}
	out := make([]RouteAction, len(next))
	for index, action := range next {
		extra := cloneRouteActionExtra(action.Extra)
		rawReplacement, hasReplacement := extra["hmac_secret"]
		if action.Kind != "webhook" &&
			(hasReplacement || action.PreserveHMACFromIndex != nil || action.RemoveStoredHMAC) {
			return nil, fmt.Errorf("action %d: HMAC controls are valid only for webhooks", index+1)
		}
		if action.RemoveStoredHMAC && hasReplacement {
			return nil, fmt.Errorf("action %d: choose HMAC replacement or removal, not both", index+1)
		}
		if hasReplacement {
			if _, ok := validRouteHMACSecret(rawReplacement); !ok {
				return nil, fmt.Errorf("action %d: HMAC secret must use 1-4096 bytes without control characters", index+1)
			}
		} else if action.RemoveStoredHMAC {
			delete(extra, "hmac_secret")
		} else if action.PreserveHMACFromIndex != nil {
			sourceIndex := *action.PreserveHMACFromIndex
			if sourceIndex < 0 || sourceIndex >= len(existing) || existing[sourceIndex].Kind != "webhook" {
				return nil, fmt.Errorf("action %d: stored HMAC source is no longer valid", index+1)
			}
			secret, ok := validRouteHMACSecret(existing[sourceIndex].Extra["hmac_secret"])
			if !ok {
				return nil, fmt.Errorf("action %d: stored HMAC source is no longer available", index+1)
			}
			if extra == nil {
				extra = make(map[string]any, 1)
			}
			extra["hmac_secret"] = secret
		}
		action.Extra = extra
		action.HasStoredHMACSecret = false
		action.PreserveHMACFromIndex = nil
		action.RemoveStoredHMAC = false
		out[index] = action
	}
	return out, nil
}

// MountRouteAdminRoutes registers operator-facing CRUD endpoints.
//
//	GET    /api/v1/inbound-routes
//	POST   /api/v1/inbound-routes
//	POST   /api/v1/inbound-routes/reorder
//	PATCH  /api/v1/inbound-routes/{id}
//	DELETE /api/v1/inbound-routes/{id}
//	POST   /api/v1/inbound-routes/preview      (dry-run matcher)
//	GET    /api/v1/inbound-routes/{id}/matches (per-rule history)
//	GET    /api/v1/inbound-routes/matches/{match_id}/runs
//	                                               (per-match action-run drilldown)
func (d *Deps) MountRouteAdminRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/inbound-routes", d.ListRoutes)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/inbound-routes", d.CreateRoute)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/inbound-routes/reorder", d.ReorderRoutes)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/inbound-routes/{id}", d.UpdateRoute)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/inbound-routes/{id}", d.DeleteRoute)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/inbound-routes/preview", d.PreviewRoutes)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/inbound-routes/{id}/matches", d.ListRouteMatches)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/inbound-routes/matches/{match_id}/runs", d.ListActionRuns)
}

type routeReorderInput struct {
	RouteIDs []string `json:"route_ids"`
}

// MatchRoutes loads enabled routes for tenantID, walks them in
// priority order, and returns the matched routes (first stop_on_match
// wins). Returns empty when nothing matched.
func MatchRoutes(ctx context.Context, pool *db.Pool, tenantID, recipient, subject, fromEmail string) ([]Route, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, priority, stop_on_match,
       match_recipient, match_subject_prefix, match_from_domain,
       actions, match_count
  FROM inbound_routes
 WHERE tenant_id = $1::uuid AND enabled = true
 ORDER BY priority ASC, created_at ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Route{}
	fromDomain := domainOf(fromEmail)
	for rows.Next() {
		var r Route
		var actions []byte
		if err := rows.Scan(&r.ID, &r.Name, &r.Priority, &r.StopOnMatch,
			&r.MatchRecipient, &r.MatchSubjectPrefix, &r.MatchFromDomain,
			&actions, &r.MatchCount); err != nil {
			return nil, err
		}
		if !routeMatches(r, recipient, subject, fromDomain) {
			continue
		}
		if err := json.Unmarshal(actions, &r.Actions); err != nil {
			return nil, errors.New("stored inbound route actions are invalid")
		}
		out = append(out, r)
		if r.StopOnMatch {
			break
		}
	}
	return out, rows.Err()
}

// BumpRouteHits stamps last_matched_at + increments match_count for
// the supplied routes. Best-effort — failures don't bubble.
func BumpRouteHits(ctx context.Context, pool *db.Pool, tenantID string, routeIDs []string) {
	if len(routeIDs) == 0 {
		return
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `
UPDATE inbound_routes
   SET last_matched_at = now(),
       match_count = match_count + 1
 WHERE tenant_id = $1::uuid AND id::text = ANY($2)`, tenantID, routeIDs)
	_ = tx.Commit(ctx)
}

// RecordRouteMatches writes one inbound_route_matches row per matched
// route so the admin UI can render a per-rule history timeline.
// Best-effort — failures don't bubble. inboundEmailID may be 0 when the
// caller doesn't have one (e.g. a replay flow that doesn't go through
// the email Insert path).
//
// Returns a `routeID → matchID` map so the caller can associate
// downstream per-action run rows with the specific match that fired
// them. Empty map on any error / no-match.
func RecordRouteMatches(
	ctx context.Context,
	pool *db.Pool,
	tenantID string,
	routeIDs []string,
	inboundEmailID int64,
	recipient, subject, fromEmail string,
) map[string]int64 {
	if len(routeIDs) == 0 {
		return nil
	}
	out := make(map[string]int64, len(routeIDs))
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return out
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var emailIDArg any
	if inboundEmailID > 0 {
		emailIDArg = inboundEmailID
	} else {
		emailIDArg = nil
	}
	// Single round-trip insert via unnest($routeIDs) — but now using
	// RETURNING so the caller can thread the match ids through to the
	// per-action run rows.
	rows, err := tx.Query(ctx, `
INSERT INTO inbound_route_matches
  (tenant_id, route_id, inbound_email_id, recipient, subject, from_email)
SELECT $1::uuid, rid::uuid, $3, $4, $5, $6
  FROM unnest($2::text[]) AS rid
RETURNING route_id::text, id`,
		tenantID, routeIDs, emailIDArg, recipient, subject, fromEmail)
	if err != nil {
		return out
	}
	for rows.Next() {
		var rid string
		var mid int64
		if err := rows.Scan(&rid, &mid); err == nil {
			out[rid] = mid
		}
	}
	rows.Close()
	if rows.Err() != nil {
		return out
	}
	_ = tx.Commit(ctx)
	return out
}

// RouteMatch is one row from inbound_route_matches, returned by
// ListMatchesForRoute.
type RouteMatch struct {
	ID             int64     `json:"id"`
	RouteID        string    `json:"route_id"`
	InboundEmailID *int64    `json:"inbound_email_id,omitempty"`
	Recipient      string    `json:"recipient"`
	Subject        string    `json:"subject"`
	FromEmail      string    `json:"from_email"`
	MatchedAt      time.Time `json:"matched_at"`
}

// routeMatches returns true when every non-empty matcher in r passes.
func routeMatches(r Route, recipient, subject, fromDomain string) bool {
	if r.MatchRecipient != "" && !globMatch(r.MatchRecipient, recipient) {
		return false
	}
	if r.MatchSubjectPrefix != "" &&
		!strings.HasPrefix(strings.ToLower(subject), strings.ToLower(r.MatchSubjectPrefix)) {
		return false
	}
	if r.MatchFromDomain != "" &&
		!strings.EqualFold(r.MatchFromDomain, fromDomain) {
		return false
	}
	return true
}

// globMatch implements a tiny shell-glob: '*' matches any run of
// characters and '?' matches exactly one character. Case-insensitive.
func globMatch(pattern, candidate string) bool {
	pat := strings.ToLower(pattern)
	cand := strings.ToLower(candidate)
	return globMatchAt(pat, cand, 0, 0, map[[2]int]bool{})
}

func globMatchAt(pattern, candidate string, pi, ci int, memo map[[2]int]bool) bool {
	key := [2]int{pi, ci}
	if memo[key] {
		return false
	}
	for pi < len(pattern) {
		if pattern[pi] == '*' {
			for pi < len(pattern) && pattern[pi] == '*' {
				pi++
			}
			if pi == len(pattern) {
				return true
			}
			for j := ci; j <= len(candidate); j++ {
				if globMatchAt(pattern, candidate, pi, j, memo) {
					return true
				}
			}
			memo[key] = true
			return false
		}
		if ci >= len(candidate) {
			memo[key] = true
			return false
		}
		if pattern[pi] != '?' && pattern[pi] != candidate[ci] {
			memo[key] = true
			return false
		}
		pi++
		ci++
	}
	return ci == len(candidate)
}

func domainOf(email string) string {
	i := strings.LastIndexByte(email, '@')
	if i < 0 {
		return ""
	}
	return strings.ToLower(email[i+1:])
}

// --- Admin CRUD ---

type routeInput struct {
	Name               string        `json:"name"`
	Priority           int           `json:"priority"`
	StopOnMatch        *bool         `json:"stop_on_match,omitempty"`
	Enabled            *bool         `json:"enabled,omitempty"`
	MatchRecipient     string        `json:"match_recipient"`
	MatchSubjectPrefix string        `json:"match_subject_prefix"`
	MatchFromDomain    string        `json:"match_from_domain"`
	Actions            []RouteAction `json:"actions"`
	// v2 retry-policy fields. Pointer-typed so callers can omit them
	// to preserve the existing value (PATCH semantics) — a literal
	// zero in the JSON IS still a meaningful value (no retries).
	ActionRetryMax            *int `json:"action_retry_max,omitempty"`
	ActionRetryBackoffSeconds *int `json:"action_retry_backoff_seconds,omitempty"`
	// ExpectedUpdatedAt is mandatory whenever actions are replaced or cleared.
	// It binds opaque HMAC preservation indexes to the exact configuration the
	// caller reviewed while the row is locked.
	ExpectedUpdatedAt *time.Time `json:"expected_updated_at,omitempty"`
	// v2 explicit-clear: when true, an empty `actions` array clears
	// every action on the row instead of being silently preserved.
	// The v1 backend used `CASE WHEN '[]' THEN keep ELSE replace` for
	// safety against an accidental empty PATCH from a buggy client;
	// the v2 frontend always sends ClearActions=true alongside an
	// intentional empty array so the two can be distinguished.
	ClearActions bool `json:"clear_actions,omitempty"`
}

// validRouteActionKinds is the set of action.kind values accepted by
// the executor. Anything else is rejected at save time (audit found
// invalid kinds silently persisted in v1 and failed at fire time
// with a swallowed log).
var validRouteActionKinds = map[string]struct{}{
	"tag":                {},
	"automation_trigger": {},
	"webhook":            {},
	"forward":            {},
	"store_only":         {},
}

// validateActions enforces per-kind required fields at save time so
// "silently dead" routes don't get persisted. Returns a (field-index,
// message) tuple via a multierror-style joined string so the client
// can present per-row error feedback in the editor.
func validateActions(actions []RouteAction) error {
	if len(actions) > maxRouteActions {
		return fmt.Errorf("at most %d actions are allowed", maxRouteActions)
	}
	for i, a := range actions {
		if _, ok := validRouteActionKinds[a.Kind]; !ok {
			return fmt.Errorf("action %d: unknown kind %q (must be one of tag, automation_trigger, webhook, forward, store_only)", i+1, a.Kind)
		}
		switch a.Kind {
		case "tag":
			if strings.TrimSpace(a.Tag) == "" {
				return fmt.Errorf("action %d (tag): `tag` is required", i+1)
			}
		case "automation_trigger":
			if strings.TrimSpace(a.EventType) == "" {
				return fmt.Errorf("action %d (automation_trigger): `event_type` is required", i+1)
			}
		case "webhook":
			u := strings.TrimSpace(a.URL)
			if u == "" {
				return fmt.Errorf("action %d (webhook): `url` is required", i+1)
			}
			// Basic URL sanity — full SSRF gating runs at fire time
			// via outbound_webhooks.NewSecureHTTPClient. Reject the
			// obvious shapes here so the editor surfaces "fix this
			// before save" feedback.
			if !(strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")) {
				return fmt.Errorf("action %d (webhook): `url` must start with http:// or https://", i+1)
			}
		case "forward":
			to := strings.TrimSpace(a.To)
			if to == "" {
				return fmt.Errorf("action %d (forward): `to` is required", i+1)
			}
			if !strings.Contains(to, "@") {
				return fmt.Errorf("action %d (forward): `to` must look like an email address", i+1)
			}
		case "store_only":
			// no-op; zero required fields.
		}
	}
	return nil
}

func (d *Deps) ListRoutes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, name, priority, stop_on_match, enabled,
       match_recipient, match_subject_prefix, match_from_domain,
       actions, last_matched_at, match_count,
       COALESCE(action_retry_max, 0),
       COALESCE(action_retry_backoff_seconds, 2), updated_at
  FROM inbound_routes
 WHERE tenant_id = $1::uuid
 ORDER BY priority ASC, created_at ASC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []Route{}
	for rows.Next() {
		var rr Route
		var actions []byte
		var lastMatched *time.Time
		if err := rows.Scan(&rr.ID, &rr.Name, &rr.Priority, &rr.StopOnMatch, &rr.Enabled,
			&rr.MatchRecipient, &rr.MatchSubjectPrefix, &rr.MatchFromDomain,
			&actions, &lastMatched, &rr.MatchCount,
			&rr.ActionRetryMax, &rr.ActionRetryBackoffSeconds, &rr.UpdatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		if err := json.Unmarshal(actions, &rr.Actions); err != nil {
			httperror.WriteInternal(w, d.Logger, errors.New("stored inbound route actions are invalid"), httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		rr.Actions = redactRouteActionSecrets(rr.Actions)
		rr.LastMatchedAt = lastMatched
		out = append(out, rr)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"routes": out})
}

func (d *Deps) CreateRoute(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in routeInput
	if err := httpbody.DecodeJSON(w, r, 32<<10, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.MatchRecipient == "" {
		in.MatchRecipient = "*"
	}
	if in.Priority < 0 || in.Priority > 10000 {
		in.Priority = 100
	}
	// v2: action-level validation runs at save time so invalid kinds
	// or missing required fields are rejected here instead of
	// failing silently at fire time.
	if err := validateActions(in.Actions); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	stopOnMatch := true
	if in.StopOnMatch != nil {
		stopOnMatch = *in.StopOnMatch
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	retryMax := 0
	if in.ActionRetryMax != nil {
		retryMax = clamp(*in.ActionRetryMax, 0, 5)
	}
	retryBackoff := 2
	if in.ActionRetryBackoffSeconds != nil {
		retryBackoff = clamp(*in.ActionRetryBackoffSeconds, 0, 60)
	}
	// json.Marshal of a nil slice is `null`, not `[]`, and inbound_routes has
	// CHECK (jsonb_typeof(actions) = 'array'). A create body that omits
	// `actions` therefore violated the constraint and surfaced as a 500.
	//
	// Only the CREATE path takes this treatment. The UPDATE path below uses nil
	// deliberately -- there, omitted means "keep the existing actions", which is
	// the ClearActions distinction, and coalescing it to `[]` would silently
	// wipe a route's actions on every partial update.
	//
	// The constraint permits an empty array, so nil becomes `[]`. Whether an
	// action-less route should be REJECTED is a product decision the schema has
	// not made, and a bug fix is the wrong place to invent it.
	createActions, err := prepareCreatedRouteActions(in.Actions)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	if createActions == nil {
		createActions = []RouteAction{}
	}
	if err := validateActions(createActions); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	actionsJSON, err := json.Marshal(createActions)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var id string
	row := tx.QueryRow(r.Context(), `
INSERT INTO inbound_routes
    (tenant_id, name, priority, stop_on_match, enabled,
     match_recipient, match_subject_prefix, match_from_domain, actions,
     action_retry_max, action_retry_backoff_seconds)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
RETURNING id::text`,
		t.ID, in.Name, in.Priority, stopOnMatch, enabled,
		in.MatchRecipient, in.MatchSubjectPrefix, in.MatchFromDomain,
		string(actionsJSON), retryMax, retryBackoff)
	if err := row.Scan(&id); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// v2: explicit audit row alongside the generic middleware fallback.
	auditRouteChange(r.Context(), d.Repo.Pool, r, t.ID, "inbound_route.created", id, map[string]any{
		"name":     in.Name,
		"priority": in.Priority,
		"enabled":  enabled,
	})
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// clamp is the standard inclusive lo/hi range clamp.
func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func (d *Deps) UpdateRoute(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var in routeInput
	if err := httpbody.DecodeJSON(w, r, 32<<10, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	clearActions := in.ClearActions && len(in.Actions) == 0
	if len(in.Actions) > 0 || clearActions {
		var storedActionsJSON []byte
		var storedUpdatedAt time.Time
		if err := tx.QueryRow(r.Context(), `
SELECT actions, updated_at
  FROM inbound_routes
 WHERE tenant_id = $1::uuid AND id::text = $2
 FOR UPDATE`, t.ID, id).Scan(&storedActionsJSON, &storedUpdatedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				httperror.Write(w, http.StatusNotFound, "not_found", "route not found")
				return
			}
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		if in.ExpectedUpdatedAt == nil || !in.ExpectedUpdatedAt.Equal(storedUpdatedAt) {
			httperror.Write(w, http.StatusConflict, "route_changed", errRouteConfigurationChanged.Error())
			return
		}
		if len(in.Actions) > 0 {
			var storedActions []RouteAction
			if err := json.Unmarshal(storedActionsJSON, &storedActions); err != nil {
				httperror.WriteInternal(w, d.Logger, errors.New("stored inbound route actions are invalid"), httperror.WithTenantIDLog(r.Context(), t.ID))
				return
			}
			in.Actions, err = mergeUpdatedRouteActionSecrets(
				in.Actions,
				storedActions,
				in.ExpectedUpdatedAt,
				storedUpdatedAt,
			)
			if err != nil {
				if errors.Is(err, errRouteConfigurationChanged) {
					httperror.Write(w, http.StatusConflict, "route_changed", err.Error())
					return
				}
				httperror.WriteValidation(w, "validation_failed", err.Error())
				return
			}
			if err := validateActions(in.Actions); err != nil {
				httperror.WriteValidation(w, "validation_failed", err.Error())
				return
			}
		}
	}
	var actionsArgument any
	if in.Actions != nil {
		actionsJSON, marshalErr := json.Marshal(in.Actions)
		if marshalErr != nil {
			httperror.WriteInternal(w, d.Logger, marshalErr, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		actionsArgument = string(actionsJSON)
	}
	// v2: the actions-clear semantics. The v1 SQL silently preserved
	// existing actions when the client sent `[]`, which made it
	// impossible to legitimately clear actions on a route and hid a
	// real data-loss footgun (the UI showed "actions removed" while
	// the DB retained them). v2 distinguishes:
	//   - Omitted entirely / null  → keep existing actions.
	//   - Non-empty array          → replace.
	//   - Empty array + ClearActions=true → clear all actions.
	//   - Empty array + ClearActions=false → keep existing (legacy
	//     guard preserved so old clients that send `actions: []` by
	//     habit don't accidentally wipe everything).
	// v2 retry config — same pointer semantics as the create path.
	tag, err := tx.Exec(r.Context(), `
UPDATE inbound_routes SET
    name                 = COALESCE(NULLIF($3,''), name),
    priority             = CASE WHEN $4 BETWEEN 0 AND 10000 THEN $4 ELSE priority END,
    stop_on_match        = COALESCE($5, stop_on_match),
    enabled              = COALESCE($6, enabled),
    match_recipient      = COALESCE(NULLIF($7,''), match_recipient),
    match_subject_prefix = $8,
    match_from_domain    = $9,
    actions              = CASE
                              WHEN $11::boolean = true               THEN '[]'::jsonb
                              WHEN $10::jsonb IS NULL                 THEN actions
                              WHEN $10::jsonb = '[]'::jsonb           THEN actions
                              ELSE                                         $10::jsonb
                           END,
    action_retry_max     = COALESCE($12, action_retry_max),
    action_retry_backoff_seconds = COALESCE($13, action_retry_backoff_seconds),
    updated_at           = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		t.ID, id, in.Name, in.Priority, in.StopOnMatch, in.Enabled,
		in.MatchRecipient, in.MatchSubjectPrefix, in.MatchFromDomain,
		actionsArgument, clearActions,
		in.ActionRetryMax, in.ActionRetryBackoffSeconds)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		httperror.Write(w, http.StatusNotFound, "not_found", "route not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	auditRouteChange(r.Context(), d.Repo.Pool, r, t.ID, "inbound_route.updated", id, map[string]any{
		"name":             in.Name,
		"enabled":          in.Enabled,
		"priority":         in.Priority,
		"clear_actions":    clearActions,
		"action_count":     len(in.Actions),
		"action_retry_max": in.ActionRetryMax,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) DeleteRoute(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM inbound_routes WHERE tenant_id = $1::uuid AND id::text = $2`, t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		httperror.Write(w, http.StatusNotFound, "not_found", "route not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	auditRouteChange(r.Context(), d.Repo.Pool, r, t.ID, "inbound_route.deleted", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// ReorderRoutes POST /api/v1/inbound-routes/reorder
//
// Atomically assigns dense priorities (10, 20, 30...) in the supplied
// order. The endpoint refuses duplicate/missing route ids so the UI
// never leaves the chain half-reordered after one PATCH fails.
func (d *Deps) ReorderRoutes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in routeReorderInput
	if err := httpbody.DecodeJSON(w, r, 32<<10, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.RouteIDs) == 0 {
		httperror.Write(w, http.StatusBadRequest, "missing_route_ids", "route_ids required")
		return
	}
	if len(in.RouteIDs) > 500 {
		httperror.Write(w, http.StatusBadRequest, "too_many_routes", "at most 500 routes can be reordered at once")
		return
	}
	seen := make(map[string]struct{}, len(in.RouteIDs))
	for i, id := range in.RouteIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			httperror.Write(w, http.StatusBadRequest, "bad_route_id", "route_ids must not contain blanks")
			return
		}
		if _, dup := seen[id]; dup {
			httperror.Write(w, http.StatusBadRequest, "duplicate_route_id", "route_ids must be unique")
			return
		}
		seen[id] = struct{}{}
		in.RouteIDs[i] = id
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
WITH ordered AS (
    SELECT rid::uuid AS id, (ord::int * 10) AS priority
      FROM unnest($2::text[]) WITH ORDINALITY AS u(rid, ord)
)
UPDATE inbound_routes r
   SET priority = ordered.priority,
       updated_at = now()
  FROM ordered
 WHERE r.tenant_id = $1::uuid
   AND r.id = ordered.id`,
		t.ID, in.RouteIDs)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() != int64(len(in.RouteIDs)) {
		httperror.Write(w, http.StatusNotFound, "route_not_found", "one or more route ids were not found for this tenant")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	auditRouteChange(r.Context(), d.Repo.Pool, r, t.ID, "inbound_route.reordered", "", map[string]any{
		"route_ids": in.RouteIDs,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(in.RouteIDs)})
}

// previewInput is the request body for POST /api/v1/inbound-routes/preview.
type previewInput struct {
	Recipient string `json:"recipient"`
	Subject   string `json:"subject"`
	From      string `json:"from"`
}

// previewHit describes a single rule that matched in a preview run.
// `Reason` explains *which* matcher fired so the operator can debug
// surprises (e.g. "subject prefix matched: [urgent]").
type previewHit struct {
	Route  Route  `json:"route"`
	Reason string `json:"reason"`
}

// previewResponse is the wire shape returned by PreviewRoutes.
type previewResponse struct {
	Matches   []previewHit `json:"matches"`
	Evaluated int          `json:"evaluated"`
	StoppedAt *string      `json:"stopped_at_route_id,omitempty"`
	NoMatches bool         `json:"no_matches,omitempty"`
}

// PreviewRoutes POST /api/v1/inbound-routes/preview — dry-run the
// matcher against an operator-supplied {recipient, subject?, from?}
// triple. Walks the same priority order as MatchRoutes, returns every
// route that would have fired (respecting stop_on_match), and includes
// a human-readable reason per hit.
//
// IMPORTANT: this does NOT execute actions, increment match_count, or
// stamp last_matched_at. It's a pure read.
func (d *Deps) PreviewRoutes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in previewInput
	if err := httpbody.DecodeJSON(w, r, 8<<10, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	recipient := strings.TrimSpace(in.Recipient)
	if recipient == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_recipient",
			"recipient required (this is the To: address inbound mail would arrive at)")
		return
	}

	// Read enabled+disabled routes — operators want to know whether a
	// disabled rule WOULD have fired if they re-enabled it. We still
	// honour stop_on_match for enabled rules in the chain so the order
	// of operations is honest.
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, name, priority, stop_on_match, enabled,
       match_recipient, match_subject_prefix, match_from_domain,
       actions, last_matched_at, match_count, updated_at
  FROM inbound_routes
 WHERE tenant_id = $1::uuid
 ORDER BY priority ASC, created_at ASC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()

	resp := previewResponse{Matches: []previewHit{}}
	fromDomain := domainOf(in.From)
	stopped := false
	for rows.Next() {
		var rr Route
		var actions []byte
		var lastMatched *time.Time
		if err := rows.Scan(&rr.ID, &rr.Name, &rr.Priority, &rr.StopOnMatch, &rr.Enabled,
			&rr.MatchRecipient, &rr.MatchSubjectPrefix, &rr.MatchFromDomain,
			&actions, &lastMatched, &rr.MatchCount, &rr.UpdatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		if err := json.Unmarshal(actions, &rr.Actions); err != nil {
			httperror.WriteInternal(w, d.Logger, errors.New("stored inbound route actions are invalid"), httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		rr.Actions = redactRouteActionSecrets(rr.Actions)
		rr.LastMatchedAt = lastMatched
		resp.Evaluated++
		if stopped {
			// Earlier enabled rule with stop_on_match already won — the
			// real matcher would never reach this row. Skip rather than
			// pretend it would have fired.
			continue
		}
		if !routeMatches(rr, recipient, in.Subject, fromDomain) {
			continue
		}
		reason := matchReason(rr, recipient, in.Subject, fromDomain)
		resp.Matches = append(resp.Matches, previewHit{Route: rr, Reason: reason})
		if rr.Enabled && rr.StopOnMatch {
			id := rr.ID
			resp.StoppedAt = &id
			stopped = true
		}
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if len(resp.Matches) == 0 {
		resp.NoMatches = true
	}
	writeJSON(w, http.StatusOK, resp)
}

// matchReason renders a one-line explanation of which matchers fired
// for a given route. The empty-matcher case (rule with no constraints)
// gets the "matches everything" string because that's the operator's
// most likely surprise.
func matchReason(r Route, recipient, subject, fromDomain string) string {
	parts := []string{}
	if r.MatchRecipient != "" && r.MatchRecipient != "*" {
		parts = append(parts, fmt.Sprintf("recipient %q matched %q",
			recipient, r.MatchRecipient))
	}
	if r.MatchSubjectPrefix != "" {
		parts = append(parts, fmt.Sprintf("subject begins with %q",
			r.MatchSubjectPrefix))
	}
	if r.MatchFromDomain != "" {
		parts = append(parts, fmt.Sprintf("from-domain is %q", fromDomain))
	}
	if len(parts) == 0 {
		return "catch-all (no constraints)"
	}
	return strings.Join(parts, "; ")
}

// ListRouteMatches GET /api/v1/inbound-routes/{id}/matches?limit=50.
//
// Returns the most-recent matches for a single rule, newest first.
// Used by the admin UI to render a per-rule history timeline — "this
// rule fired 14 times today; here are the actual recipient/subject
// strings that hit it." Useful for debugging matchers without piecing
// it together from inbound_emails plus a re-evaluation.
func (d *Deps) ListRouteMatches(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "route id required")
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id, route_id::text, inbound_email_id,
       recipient, subject, from_email, matched_at
  FROM inbound_route_matches
 WHERE tenant_id = $1::uuid AND route_id = $2::uuid
 ORDER BY matched_at DESC
 LIMIT $3`, t.ID, id, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []RouteMatch{}
	for rows.Next() {
		var m RouteMatch
		if err := rows.Scan(&m.ID, &m.RouteID, &m.InboundEmailID,
			&m.Recipient, &m.Subject, &m.FromEmail, &m.MatchedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		out = append(out, m)
	}
	writeJSON(w, http.StatusOK, map[string]any{"matches": out, "count": len(out)})
}

// Silence unused import noise — `errors` only referenced via the
// upstream helpers in handlers.go.
var _ = errors.New
var _ = fmt.Sprintf

// auditRouteChange writes a typed audit row alongside the generic
// middleware HTTP audit. The audit table is already wired with RLS +
// FORCE; this helper just adds the named action + before/after
// payload the project convention asks for. Best-effort: failures
// log + swallow so a transient audit-DB hiccup doesn't surface as a
// 500 on the route write.
//
// Conventions:
//
//	action      e.g. "inbound_route.created", "inbound_route.updated"
//	routeID     the inbound_routes.id (UUID text)
//	payload     arbitrary JSON-encodable map describing the change
func auditRouteChange(
	ctx context.Context,
	pool *db.Pool,
	r *http.Request,
	tenantID string,
	action string,
	routeID string,
	payload map[string]any,
) {
	if pool == nil || tenantID == "" {
		return
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	meta := middleware.AuditMetaFromRequest(r)
	if err := db.Audit(ctx, tx, meta, action, "inbound_route", routeID, payload); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}
