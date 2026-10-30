// Saved segments — Mailchimp-parity "save this segment query under a
// name and load it back". This is the persistent-bookmark surface
// the segment builder reuses to fill the Saved-segments dropdown.
//
// The existing `segments` table already supports CRUD over predicate
// ASTs. saved_segments is the smaller name+predicate_json bookmark
// kept separate so the lifecycle (saved/touched/deleted) is decoupled
// from full segment evaluation + previewing.
package segments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const savedSegmentJSONMaxBodyBytes int64 = 256 << 10 // 256 KiB

const (
	// SavedSegmentMaxItems bounds a tenant's reusable-view library. The cap is
	// enforced transactionally in CreateSaved and returned by ListSaved so the
	// desktop can explain the boundary before a write is attempted.
	SavedSegmentMaxItems       = 200
	savedSegmentMaxNameRunes   = 120
	savedSegmentMaxDescription = 1_000
)

// ErrSavedNameConflict surfaces when (tenant_id, name) collides.
var ErrSavedNameConflict = errors.New("segments: saved segment name already in use")

// ErrSavedLimitReached is returned when a tenant already owns the maximum
// number of saved segments. It is a stable product boundary, not a transport
// rate limit, so handlers surface it as a 409 conflict.
var ErrSavedLimitReached = errors.New("segments: saved segment limit reached")

// ErrPersonalScopeRequiresUser prevents a machine/API-key actor without an
// attributable user identity from creating a supposedly personal bookmark.
var ErrPersonalScopeRequiresUser = errors.New("segments: personal scope requires a user identity")

// ErrFolderNotFound surfaces when a saved segment references a folder_id
// that does not exist for the tenant (FK violation), or a folder lookup
// misses (SUB-040).
var ErrFolderNotFound = errors.New("segments: folder not found")

// ErrFolderNameConflict surfaces when (tenant_id, name) collides on the
// segment_folders table (SUB-040).
var ErrFolderNameConflict = errors.New("segments: folder name already in use")

// SavedSegment is the public projection of one saved_segments row.
// PredicateJSON is the raw filter set the desktop captured — kept as
// json.RawMessage so the segment-builder UI can apply the predicate
// to its current filter state without us defining a Go-side type for
// every possible filter shape.
//
// SUB-026 — full predicate AST persistence. The predicate_json column
// accepts arbitrary jsonb, but the client-server contract is now the
// structured shape:
//
//	{
//	  "filters": {              // for UI reconstruction (optional)
//	    "status": "subscribed",
//	    "q": "acme",
//	    "tags": ["vip"],
//	    "custom_fields": {...},
//	    "engagement": {...},
//	    "date_range": {...}
//	  },
//	  "ast": <SegmentNode>      // for server-side evaluation (optional)
//	}
//
// The legacy {status, q} shape is still accepted verbatim (backward
// compatible) — it simply has no top-level `ast`, so PreviewSaved
// falls back to compiling the filters into an AST. See savedPredicate
// for the extraction logic.
type SavedSegment struct {
	ID            string          `json:"id"`
	TenantID      string          `json:"tenant_id"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	PredicateJSON json.RawMessage `json:"predicate_json"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
	LastRunAt     *time.Time      `json:"last_run_at,omitempty"`

	// SUB-040 — sharing / pinning / ordering / folders.
	//
	// IsPinned pins the bookmark to the top of the segment picker.
	IsPinned bool `json:"is_pinned"`
	// PinOrder is the manual drag-to-reorder position WITHIN the pinned
	// group (lower = higher). nil when unpinned.
	PinOrder *int `json:"pin_order,omitempty"`
	// VisibilityScope is 'personal' (creator-only) or 'workspace'
	// (every tenant member). Migration 1755 explicitly moves historical,
	// unattributed rows to workspace scope; a personal row without an owner is
	// never made visible implicitly.
	VisibilityScope string `json:"visibility_scope"`
	// CreatedByUserID links the bookmark to the user who saved it. nil
	// for API-key workspace writes and personal rows orphaned by user deletion.
	CreatedByUserID *string `json:"created_by_user_id,omitempty"`
	// FolderID files the bookmark under a segment_folders row. nil when
	// unfiled.
	FolderID *string `json:"folder_id,omitempty"`

	// SUB-084 — denormalised live membership for the SavedSegmentsManager
	// count badge (migration 1512).
	//
	// LastCount is the membership size from the most recent preview /
	// evaluation. nil = never evaluated → the badge renders "—". A populated
	// value renders "<n> member(s)". Refreshed on an explicit preview/recount
	// (PreviewSaved / PreviewSavedDetail write it back via UpdateSavedEvaluated) and
	// cleared whenever predicate_json changes;
	// there is no background recompute worker yet (SUB-029 partial), so the
	// value can lag — the UI pairs it with LastEvaluatedAt to signal staleness.
	LastCount *int `json:"last_count,omitempty"`
	// LastEvaluatedAt is when LastCount was last written. nil = never. The UI
	// renders it next to the count ("123 members · 2h ago").
	LastEvaluatedAt *time.Time `json:"last_evaluated_at,omitempty"`
}

// Valid visibility scopes for a saved segment (SUB-040).
const (
	SavedScopePersonal  = "personal"
	SavedScopeWorkspace = "workspace"
)

// validSavedScope reports whether s is an accepted visibility_scope.
func validSavedScope(s string) bool {
	return s == SavedScopePersonal || s == SavedScopeWorkspace
}

func savedSegmentActorID(ctx context.Context) string {
	if user, ok := middleware.UserFromContext(ctx); ok && user != nil {
		return strings.TrimSpace(user.ID)
	}
	return ""
}

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func validateSavedSegmentText(name, description string) (code, message string) {
	if name == "" {
		return "missing_name", "name required"
	}
	if utf8.RuneCountInString(name) > savedSegmentMaxNameRunes {
		return "name_too_long", "name must be 120 characters or fewer"
	}
	if utf8.RuneCountInString(description) > savedSegmentMaxDescription {
		return "description_too_long", "description must be 1000 characters or fewer"
	}
	invalidName := strings.IndexFunc(name, func(r rune) bool {
		return (r >= 0 && r < 0x20) || r == 0x7f
	}) >= 0
	invalidDescription := strings.IndexFunc(description, func(r rune) bool {
		return (r >= 0 && r < 0x20 && r != '\n' && r != '\t') || r == 0x7f
	}) >= 0
	if invalidName || invalidDescription {
		return "invalid_text", "name and description cannot contain control characters"
	}
	return "", ""
}

// SavedSegmentInput is the body of POST /segments/saved.
//
// PredicateJSON SHOULD carry the structured {filters?, ast?} shape (see
// SavedSegment) so the saved segment can be both re-applied in the UI
// (via filters) and evaluated server-side (via ast). The legacy
// {status, q} blob is still accepted unchanged.
type SavedSegmentInput struct {
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	PredicateJSON json.RawMessage `json:"predicate_json"`

	// SUB-040 — optional organizer fields on create. VisibilityScope
	// defaults to 'personal' when empty. FolderID files the new
	// bookmark immediately.
	VisibilityScope string  `json:"visibility_scope,omitempty"`
	FolderID        *string `json:"folder_id,omitempty"`
}

// SavedSegmentPatch is the body of PATCH /segments/saved/{id}.
type SavedSegmentPatch struct {
	Name          *string          `json:"name,omitempty"`
	Description   *string          `json:"description,omitempty"`
	PredicateJSON *json.RawMessage `json:"predicate_json,omitempty"`
	// Touch flips last_run_at to now() — called by the dashboard when
	// the operator clicks a saved segment to load it.
	Touch *bool `json:"touch,omitempty"`

	// SUB-040 — organizer fields.
	//
	// IsPinned / PinOrder / VisibilityScope are patched when present
	// (nil = leave unchanged). Pinning a segment without a PinOrder
	// leaves the order untouched; unpinning is the caller's job (set
	// IsPinned=false).
	IsPinned        *bool   `json:"is_pinned,omitempty"`
	PinOrder        *int    `json:"pin_order,omitempty"`
	VisibilityScope *string `json:"visibility_scope,omitempty"`
	// FolderID is a *string so the caller can distinguish "omit (leave
	// unchanged)" from an explicit re-file/unfile:
	//   - omitted OR JSON null  → nil pointer → leave unchanged;
	//   - "" (empty string)     → unfile (folder_id set to NULL);
	//   - "<uuid>"              → file under that folder.
	// (encoding/json maps a literal null to a nil pointer, so null and
	// omission are intentionally treated the same — "leave unchanged".)
	FolderID *string `json:"folder_id,omitempty"`
}

// savedPredicateEnvelope is the structured predicate_json contract for
// saved segments (SUB-026). Both fields are optional so the legacy
// {status, q} blob still decodes (into neither field).
type savedPredicateEnvelope struct {
	Filters  *savedFilters      `json:"filters,omitempty"`
	AST      json.RawMessage    `json:"ast,omitempty"`
	Snapshot *savedViewSnapshot `json:"snapshot,omitempty"`
}

type savedViewSnapshot struct {
	IncludeArchived *bool `json:"include_archived,omitempty"`
	ShowArchived    *bool `json:"show_archived,omitempty"`
}

// savedFilters captures the UI filter state for reconstruction and as a
// fallback compile source when no top-level ast is persisted. Only the
// status + q legacy fields are compiled server-side today; the richer
// fields (tags/custom_fields/engagement/date_range) are persisted for
// the UI and compiled once the visual builder emits a full ast.
type savedFilters struct {
	Status       string          `json:"status,omitempty"`
	Q            string          `json:"q,omitempty"`
	Tags         []string        `json:"tags,omitempty"`
	CustomFields json.RawMessage `json:"custom_fields,omitempty"`
	Engagement   json.RawMessage `json:"engagement,omitempty"`
	DateRange    json.RawMessage `json:"date_range,omitempty"`
}

// legacyFilters is the historic flat {status, q} predicate_json shape.
type legacyFilters struct {
	Status string `json:"status,omitempty"`
	Q      string `json:"q,omitempty"`
}

// savedSegmentAST resolves the predicate_json blob to an evaluable
// SegmentNode AST for previewing (SUB-026). Resolution order:
//
//  1. a top-level `ast` (the NL builder + future visual builder write
//     this) — used verbatim;
//  2. else `filters.{status,q}` — compiled into an AST;
//  3. else the legacy flat `{status, q}` blob — compiled into an AST.
//
// Returns ("", nil) when nothing evaluable is present, so the caller can
// surface a clear 422 rather than counting the whole audience.
func savedSegmentAST(predicate json.RawMessage) (json.RawMessage, error) {
	if len(predicate) == 0 {
		return nil, nil
	}
	var env savedPredicateEnvelope
	if err := json.Unmarshal(predicate, &env); err == nil {
		if len(env.AST) > 0 {
			return env.AST, nil
		}
		if env.Filters != nil {
			return filtersToAST(env.Filters.Status, env.Filters.Q), nil
		}
	}
	// Fall back to the legacy flat shape.
	var legacy legacyFilters
	if err := json.Unmarshal(predicate, &legacy); err == nil {
		return filtersToAST(legacy.Status, legacy.Q), nil
	}
	return nil, nil
}

// filtersToAST compiles the {status, q} filter pair into a canonical
// SegmentNode AST (an AND of the present conditions). An empty status +
// empty q yields an explicit email-is-present condition. Subscriber email is
// NOT NULL, so this preserves the desktop's "no filters = everyone" semantics
// without persisting a structurally invalid empty boolean group.
func filtersToAST(status, q string) json.RawMessage {
	children := []map[string]any{}
	if s := strings.TrimSpace(status); s != "" && !strings.EqualFold(s, "all") {
		s = savedStatusForEngine(s)
		children = append(children, map[string]any{
			"op":         "condition",
			"field":      "status",
			"comparator": "equals",
			"value":      s,
		})
	}
	if term := strings.TrimSpace(q); term != "" {
		children = append(children, map[string]any{
			"op":         "condition",
			"field":      "email",
			"comparator": "contains",
			"value":      term,
		})
	}
	if len(children) == 0 {
		children = append(children, map[string]any{
			"op":         "condition",
			"field":      "email",
			"comparator": "is_not_null",
		})
	}
	node := map[string]any{"op": "and", "children": children}
	buf, _ := json.Marshal(node)
	return buf
}

func savedStatusForEngine(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "subscribed", "active":
		return "enabled"
	case "unsubscribed", "bounced":
		return "blocklisted"
	default:
		return strings.ToLower(strings.TrimSpace(status))
	}
}

func savedSegmentIncludesArchived(predicate json.RawMessage) bool {
	var envelope savedPredicateEnvelope
	if err := json.Unmarshal(predicate, &envelope); err != nil || envelope.Snapshot == nil {
		return false
	}
	if envelope.Snapshot.IncludeArchived != nil {
		return *envelope.Snapshot.IncludeArchived
	}
	return envelope.Snapshot.ShowArchived != nil && *envelope.Snapshot.ShowArchived
}

func savedSegmentAudienceFragment(fragment string, predicate json.RawMessage) string {
	if savedSegmentIncludesArchived(predicate) {
		return fragment
	}
	return "(" + fragment + ") AND subscribers.archived_at IS NULL"
}

// MountSavedRoutes registers the saved-segment CRUD surface. Same
// scope shape as the rest of segments: read scope for GET, write for
// mutating.
func MountSavedRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/segments/saved", d.ListSaved)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/segments/saved", d.CreateSaved)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/segments/saved/{id}", d.PatchSaved)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/segments/saved/{id}", d.DeleteSaved)
	// SUB-026: compile the saved segment's persisted AST (or its
	// filter snapshot) and return the live match count so the UI can
	// show "X subscribers match" before loading. POST (not GET) to
	// mirror /segments/preview + keep the body free for future params.
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Post("/api/v1/segments/saved/{id}/preview", d.PreviewSaved)
	// SUB-030: the GET variant enriches the bare count with workspace
	// percentage and generated-at evidence. It is aggregate-only: member
	// identifiers and email addresses never leave this preview boundary.
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/segments/saved/{id}/preview", d.PreviewSavedDetail)
}

// SavedPreviewResponse is the wire shape for POST
// /segments/saved/{id}/preview. Count is the number of subscribers the
// saved segment's predicate matches right now.
type SavedPreviewResponse struct {
	Count int `json:"count"`
}

// SavedSegmentPreview is the wire shape for GET
// /segments/saved/{id}/preview (SUB-030). It is deliberately aggregate-only:
// a count preview is not a justified reason to disclose member identifiers or
// email addresses. GeneratedAt lets clients distinguish a fresh computation
// from a retained/stale count without inventing freshness.
type SavedSegmentPreview struct {
	// ID echoes the saved segment id for client-side caching.
	ID string `json:"id"`
	// Count is the number of subscribers the predicate matches now.
	Count int `json:"count"`
	// WorkspaceTotal is the total subscriber count in the saved view's archive
	// scope (all statuses), the denominator for WorkspacePercentage.
	WorkspaceTotal int `json:"workspace_total"`
	// WorkspacePercentage is Count / WorkspaceTotal * 100, rounded to
	// one decimal. 0 when the workspace is empty.
	WorkspacePercentage float64 `json:"workspace_percentage"`
	// GeneratedAt is the server time after the aggregate queries completed.
	GeneratedAt time.Time `json:"generated_at"`
}

// PreviewSaved POST /api/v1/segments/saved/{id}/preview — SUB-026.
// Resolves the saved segment's predicate_json to an evaluable AST
// (preferring a persisted top-level `ast`, falling back to the
// {status, q} filter snapshot), compiles it, and returns the live
// COUNT(*) of matching subscribers. Capped by previewCountTimeout so a
// pathological predicate can't stall the UI.
func (d *Deps) PreviewSaved(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "saved segment id required")
		return
	}
	actorID := savedSegmentActorID(r.Context())
	saved, err := d.Repo.GetSaved(r.Context(), t.ID, actorID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such saved segment"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	ast, err := savedSegmentAST(saved.PredicateJSON)
	if err != nil {
		httperror.WriteValidation(w, "bad_predicate", "request payload is invalid")
		return
	}
	if len(ast) == 0 {
		httperror.Write(w, http.StatusUnprocessableEntity, "unevaluable_predicate",
			"saved segment has no evaluable predicate (no ast or filters)")
		return
	}
	includeArchived := savedSegmentIncludesArchived(saved.PredicateJSON)
	predicate, err := CompilePopulation(r.Context(), ast, t.ID, d.Repo, DefinitionPopulation(includeArchived))
	if err != nil {
		httperror.WriteValidation(w, "bad_ast", "request payload is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), previewCountTimeout)
	defer cancel()
	n, err := d.Repo.Count(ctx, t.ID, predicate.SQL, predicate.Args)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// SUB-084: denormalise the freshly-computed count back onto the bookmark
	// so the SavedSegmentsManager badge reflects live state on the next load.
	// Best-effort — a write failure must not fail the (already-computed) count.
	if err := d.Repo.UpdateSavedEvaluated(r.Context(), t.ID, id, n); err != nil && d.Logger != nil {
		d.Logger.Warn("saved-segment preview count store-back failed",
			"tenant_id", t.ID, "saved_segment_id", id, "err", err.Error())
	}
	writeJSON(w, http.StatusOK, SavedPreviewResponse{Count: n})
}

// PreviewSavedDetail GET /api/v1/segments/saved/{id}/preview — SUB-030.
// Same predicate resolution as PreviewSaved, but returns the enriched
// preview the segment-picker dropdown needs: the live match count, the
// total workspace subscriber count, membership-as-%-of-workspace, and the
// time those aggregates finished. Capped by previewCountTimeout so a
// pathological predicate can't stall the dropdown.
func (d *Deps) PreviewSavedDetail(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "saved segment id required")
		return
	}
	actorID := savedSegmentActorID(r.Context())
	saved, err := d.Repo.GetSaved(r.Context(), t.ID, actorID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such saved segment"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	ast, err := savedSegmentAST(saved.PredicateJSON)
	if err != nil {
		httperror.WriteValidation(w, "bad_predicate", "request payload is invalid")
		return
	}
	if len(ast) == 0 {
		httperror.Write(w, http.StatusUnprocessableEntity, "unevaluable_predicate",
			"saved segment has no evaluable predicate (no ast or filters)")
		return
	}
	includeArchived := savedSegmentIncludesArchived(saved.PredicateJSON)
	predicate, err := CompilePopulation(r.Context(), ast, t.ID, d.Repo, DefinitionPopulation(includeArchived))
	if err != nil {
		httperror.WriteValidation(w, "bad_ast", "request payload is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), previewCountTimeout)
	defer cancel()
	count, total, err := d.Repo.CountWithWorkspaceTotal(ctx, t.ID, predicate.SQL, predicate.Args, includeArchived)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// SUB-084: store the live count back onto the bookmark (same best-effort
	// path as PreviewSaved) so the count badge stays fresh after a hover/open.
	if err := d.Repo.UpdateSavedEvaluated(r.Context(), t.ID, id, count); err != nil && d.Logger != nil {
		d.Logger.Warn("saved-segment preview count store-back failed",
			"tenant_id", t.ID, "saved_segment_id", id, "err", err.Error())
	}
	writeJSON(w, http.StatusOK, SavedSegmentPreview{
		ID:                  id,
		Count:               count,
		WorkspaceTotal:      total,
		WorkspacePercentage: workspacePercentage(count, total),
		GeneratedAt:         time.Now().UTC(),
	})
}

// workspacePercentage computes count/total as a percentage rounded to
// one decimal place (so the badge stays terse, e.g. "12.3%"). Returns 0
// when the workspace is empty to avoid a divide-by-zero.
func workspacePercentage(count, total int) float64 {
	if total <= 0 {
		return 0
	}
	return float64(int((float64(count)/float64(total))*1000+0.5)) / 10
}

// ListSaved GET /api/v1/segments/saved
func (d *Deps) ListSaved(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, total, err := d.Repo.ListSaved(r.Context(), t.ID, savedSegmentActorID(r.Context()))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":       out,
		"total_items": total,
		"max_items":   SavedSegmentMaxItems,
	})
}

// CreateSaved POST /api/v1/segments/saved
func (d *Deps) CreateSaved(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in SavedSegmentInput
	if err := httpbody.DecodeJSON(w, r, savedSegmentJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	name := strings.TrimSpace(in.Name)
	description := strings.TrimSpace(in.Description)
	if code, message := validateSavedSegmentText(name, description); code != "" {
		httperror.Write(w, http.StatusBadRequest, code, message)
		return
	}
	if len(in.PredicateJSON) == 0 {
		httperror.Write(w, http.StatusBadRequest, "missing_predicate", "predicate_json required")
		return
	}
	actorID := savedSegmentActorID(r.Context())
	scope := strings.TrimSpace(in.VisibilityScope)
	if scope == "" {
		scope = SavedScopePersonal
	}
	if !validSavedScope(scope) {
		httperror.Write(w, http.StatusBadRequest, "bad_scope",
			"visibility_scope must be 'personal' or 'workspace'")
		return
	}
	if scope == SavedScopePersonal && actorID == "" {
		httperror.Write(w, http.StatusBadRequest, "personal_scope_requires_user",
			"personal saved segments require an attributable user identity")
		return
	}
	in.Name = name
	in.Description = description
	in.VisibilityScope = scope
	out, err := d.Repo.CreateSaved(r.Context(), t.ID, actorID, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrSavedNameConflict):
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
		case errors.Is(err, ErrSavedLimitReached):
			httperror.Write(w, http.StatusConflict, "saved_segment_limit_reached",
				"this workspace has reached its 200 saved-segment limit")
		case errors.Is(err, ErrFolderNotFound):
			httperror.Write(w, http.StatusBadRequest, "folder_not_found", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// PatchSaved PATCH /api/v1/segments/saved/{id}
func (d *Deps) PatchSaved(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in SavedSegmentPatch
	if err := httpbody.DecodeJSON(w, r, savedSegmentJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.VisibilityScope != nil {
		if scope := strings.TrimSpace(*in.VisibilityScope); !validSavedScope(scope) {
			httperror.Write(w, http.StatusBadRequest, "bad_scope",
				"visibility_scope must be 'personal' or 'workspace'")
			return
		}
		if strings.TrimSpace(*in.VisibilityScope) == SavedScopePersonal && savedSegmentActorID(r.Context()) == "" {
			httperror.Write(w, http.StatusBadRequest, "personal_scope_requires_user",
				"personal saved segments require an attributable user identity")
			return
		}
	}
	if in.Name != nil || in.Description != nil {
		name, description := "valid", ""
		if in.Name != nil {
			name = strings.TrimSpace(*in.Name)
			*in.Name = name
		}
		if in.Description != nil {
			description = strings.TrimSpace(*in.Description)
			*in.Description = description
		}
		if code, message := validateSavedSegmentText(name, description); code != "" {
			httperror.Write(w, http.StatusBadRequest, code, message)
			return
		}
	}
	out, err := d.Repo.PatchSaved(r.Context(), t.ID, savedSegmentActorID(r.Context()), id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrSavedNameConflict):
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
		case errors.Is(err, ErrPersonalScopeRequiresUser):
			httperror.Write(w, http.StatusBadRequest, "personal_scope_requires_user",
				"personal saved segments require an attributable user identity")
		case errors.Is(err, ErrFolderNotFound):
			httperror.Write(w, http.StatusBadRequest, "folder_not_found", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteSaved DELETE /api/v1/segments/saved/{id}
func (d *Deps) DeleteSaved(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if err := d.Repo.DeleteSaved(r.Context(), t.ID, savedSegmentActorID(r.Context()), chi.URLParam(r, "id")); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

/* ------- repo methods (saved_segments table) ---------------------- */

// ListSaved returns all saved segments newest-first.
func (r *Repo) ListSaved(ctx context.Context, tenantID, actorID string) ([]SavedSegment, int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, description, predicate_json,
       created_at, updated_at, last_run_at,
       is_pinned, pin_order,
       visibility_scope,
       created_by_user_id::text, folder_id::text,
       last_count, last_evaluated_at
  FROM saved_segments
 WHERE tenant_id = $1::uuid
   AND (
        visibility_scope = 'workspace'
        OR created_by_user_id::text = $2
   )
 ORDER BY is_pinned DESC,
          pin_order ASC NULLS LAST,
          updated_at DESC,
          created_at DESC`, tenantID, actorID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []SavedSegment{}
	for rows.Next() {
		var s SavedSegment
		if err := rows.Scan(&s.ID, &s.TenantID, &s.Name, &s.Description,
			&s.PredicateJSON, &s.CreatedAt, &s.UpdatedAt, &s.LastRunAt,
			&s.IsPinned, &s.PinOrder, &s.VisibilityScope,
			&s.CreatedByUserID, &s.FolderID,
			&s.LastCount, &s.LastEvaluatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	rows.Close()
	var total int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM saved_segments WHERE tenant_id = $1::uuid`, tenantID).Scan(&total); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// GetSaved fetches a single saved segment by id, tenant-scoped.
// Returns ErrNotFound when the id is unknown for this tenant.
func (r *Repo) GetSaved(ctx context.Context, tenantID, actorID, id string) (*SavedSegment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s SavedSegment
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, description, predicate_json,
       created_at, updated_at, last_run_at,
       is_pinned, pin_order,
       visibility_scope,
       created_by_user_id::text, folder_id::text,
       last_count, last_evaluated_at
  FROM saved_segments
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND (
        visibility_scope = 'workspace'
        OR created_by_user_id::text = $3
   )`, tenantID, id, actorID).
		Scan(&s.ID, &s.TenantID, &s.Name, &s.Description, &s.PredicateJSON,
			&s.CreatedAt, &s.UpdatedAt, &s.LastRunAt,
			&s.IsPinned, &s.PinOrder, &s.VisibilityScope,
			&s.CreatedByUserID, &s.FolderID,
			&s.LastCount, &s.LastEvaluatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// CreateSaved inserts a new bookmark.
func (r *Repo) CreateSaved(ctx context.Context, tenantID, actorID string, in SavedSegmentInput) (*SavedSegment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	scope := strings.TrimSpace(in.VisibilityScope)
	if scope == "" {
		scope = SavedScopePersonal
	}
	if scope == SavedScopePersonal && actorID == "" {
		return nil, ErrPersonalScopeRequiresUser
	}
	// Serialize the tenant-local count and case-insensitive duplicate check.
	// The existing unique constraint remains the final exact-name backstop;
	// this lock also closes concurrent case-variant and max-cap races.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('saved-segments:' || $1, 0))`, tenantID); err != nil {
		return nil, err
	}
	var count int
	var duplicate bool
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*), COALESCE(BOOL_OR(LOWER(name) = LOWER($2)), false)
  FROM saved_segments
 WHERE tenant_id = $1::uuid`, tenantID, in.Name).Scan(&count, &duplicate); err != nil {
		return nil, err
	}
	if duplicate {
		return nil, ErrSavedNameConflict
	}
	if count >= SavedSegmentMaxItems {
		return nil, ErrSavedLimitReached
	}
	var s SavedSegment
	err = tx.QueryRow(ctx, `
INSERT INTO saved_segments
       (tenant_id, name, description, predicate_json, visibility_scope,
        folder_id, created_by_user_id)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6::uuid, NULLIF($7, '')::uuid)
RETURNING id::text, tenant_id::text, name, description, predicate_json,
          created_at, updated_at, last_run_at,
          is_pinned, pin_order, visibility_scope,
          created_by_user_id::text, folder_id::text,
          last_count, last_evaluated_at`,
		tenantID, in.Name, in.Description, []byte(in.PredicateJSON), scope, in.FolderID, actorID).
		Scan(&s.ID, &s.TenantID, &s.Name, &s.Description, &s.PredicateJSON,
			&s.CreatedAt, &s.UpdatedAt, &s.LastRunAt,
			&s.IsPinned, &s.PinOrder, &s.VisibilityScope,
			&s.CreatedByUserID, &s.FolderID,
			&s.LastCount, &s.LastEvaluatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSavedNameConflict
		}
		if isForeignKeyViolation(err) {
			return nil, ErrFolderNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// PatchSaved applies a partial patch + optional Touch (last_run_at).
func (r *Repo) PatchSaved(ctx context.Context, tenantID, actorID, id string, in SavedSegmentPatch) (*SavedSegment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('saved-segments:' || $1, 0))`, tenantID); err != nil {
		return nil, err
	}
	var cur SavedSegment
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, description, predicate_json,
       created_at, updated_at, last_run_at,
       is_pinned, pin_order,
       visibility_scope,
       created_by_user_id::text, folder_id::text,
       last_count, last_evaluated_at
  FROM saved_segments
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND (
        visibility_scope = 'workspace'
        OR created_by_user_id::text = $3
   )
 FOR UPDATE`, tenantID, id, actorID).
		Scan(&cur.ID, &cur.TenantID, &cur.Name, &cur.Description,
			&cur.PredicateJSON, &cur.CreatedAt, &cur.UpdatedAt, &cur.LastRunAt,
			&cur.IsPinned, &cur.PinOrder, &cur.VisibilityScope,
			&cur.CreatedByUserID, &cur.FolderID,
			&cur.LastCount, &cur.LastEvaluatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if in.Name != nil {
		cur.Name = strings.TrimSpace(*in.Name)
		var duplicate bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1
    FROM saved_segments
   WHERE tenant_id = $1::uuid
     AND id::text <> $2
     AND LOWER(name) = LOWER($3)
)`, tenantID, id, cur.Name).Scan(&duplicate); err != nil {
			return nil, err
		}
		if duplicate {
			return nil, ErrSavedNameConflict
		}
	}
	if in.Description != nil {
		cur.Description = strings.TrimSpace(*in.Description)
	}
	if in.PredicateJSON != nil {
		cur.PredicateJSON = *in.PredicateJSON
	}
	if in.IsPinned != nil {
		cur.IsPinned = *in.IsPinned
	}
	if in.PinOrder != nil {
		cur.PinOrder = in.PinOrder
	}
	if in.VisibilityScope != nil {
		cur.VisibilityScope = strings.TrimSpace(*in.VisibilityScope)
		if cur.VisibilityScope == SavedScopePersonal {
			if actorID == "" {
				return nil, ErrPersonalScopeRequiresUser
			}
			cur.CreatedByUserID = &actorID
		}
	}
	// FolderID is a *string: nil = leave unchanged; "" = unfile (NULL);
	// "<uuid>" = re-file.
	if in.FolderID != nil {
		fid := strings.TrimSpace(*in.FolderID)
		if fid == "" {
			cur.FolderID = nil
		} else {
			cur.FolderID = &fid
		}
	}
	bumpRun := in.Touch != nil && *in.Touch
	predicateChanged := in.PredicateJSON != nil
	err = tx.QueryRow(ctx, `
UPDATE saved_segments
   SET name             = $3,
       description      = $4,
       predicate_json   = $5::jsonb,
       is_pinned        = $6,
       pin_order        = $7,
       visibility_scope = $8,
       folder_id        = $9::uuid,
       created_by_user_id = NULLIF($10, '')::uuid,
       last_run_at      = CASE WHEN $11 THEN now() ELSE last_run_at END,
       last_count       = CASE WHEN $12 THEN NULL ELSE last_count END,
       last_evaluated_at = CASE WHEN $12 THEN NULL ELSE last_evaluated_at END,
       updated_at       = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING updated_at, last_run_at, last_count, last_evaluated_at`,
		tenantID, id, cur.Name, cur.Description, []byte(cur.PredicateJSON),
		cur.IsPinned, cur.PinOrder, cur.VisibilityScope, cur.FolderID,
		stringPointerValue(cur.CreatedByUserID), bumpRun, predicateChanged).
		Scan(&cur.UpdatedAt, &cur.LastRunAt, &cur.LastCount, &cur.LastEvaluatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSavedNameConflict
		}
		if isForeignKeyViolation(err) {
			return nil, ErrFolderNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &cur, nil
}

// DeleteSaved removes a bookmark.
func (r *Repo) DeleteSaved(ctx context.Context, tenantID, actorID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM saved_segments
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND (
        visibility_scope = 'workspace'
        OR created_by_user_id::text = $3
   )`, tenantID, id, actorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// UpdateSavedEvaluated denormalises a freshly-computed membership count back
// onto the saved_segments row (SUB-084, migration 1512), mirroring the
// segments.RecordEvaluation pattern. Called by PreviewSaved / PreviewSavedDetail
// after counting so the SavedSegmentsManager badge reflects live state on the
// next load. Tenant-scoped; a miss (unknown id) is a silent no-op so a stale
// client preview cannot error the (already-returned) count.
func (r *Repo) UpdateSavedEvaluated(ctx context.Context, tenantID, id string, count int) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE saved_segments
   SET last_count = $1, last_evaluated_at = now()
 WHERE tenant_id = $2::uuid AND id::text = $3`, count, tenantID, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
