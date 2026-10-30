// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	defaultChildrenLimit = 100
	maxChildrenLimit     = 200
)

var errInvalidChildProjection = errors.New("agency child row violates the public projection contract")

// Child is the fixed, non-secret projection returned by the roster definer.
// It intentionally contains no user, Stripe, metadata, or credential fields.
type Child struct {
	ID                string    `json:"id"`
	Slug              string    `json:"slug"`
	Name              string    `json:"name"`
	Tier              string    `json:"tier"`
	ParentTenantID    string    `json:"parent_tenant_id"`
	BillingMode       string    `json:"billing_mode"`
	ResellerMarkupBps int       `json:"reseller_markup_bps"`
	WhitelabelEnabled bool      `json:"whitelabel_enabled"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type childrenResponse struct {
	Children   []Child `json:"children"`
	Count      int     `json:"count"`
	HasMore    bool    `json:"has_more"`
	NextCursor string  `json:"next_cursor,omitempty"`
}

type childrenCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
}

func (d *Deps) ListChildren(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var isAgency bool
	if err := tx.QueryRow(r.Context(),
		`SELECT is_agency_account FROM tenants WHERE id = $1::uuid FOR SHARE`, tenant.ID,
	).Scan(&isAgency); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !isAgency {
		writeNotAgencyDenial(w)
		return
	}
	limit, cursor, code, message := parseChildrenPage(r)
	if code != "" {
		writeJSON(w, http.StatusBadRequest, errEnv(code, message))
		return
	}

	var afterAt *time.Time
	var afterID *string
	if cursor != nil {
		afterAt, afterID = &cursor.CreatedAt, &cursor.ID
	}
	rows, err := tx.Query(r.Context(), `
SELECT child_id, slug, name, tier, parent_tenant_id, billing_mode,
       reseller_markup_bps, whitelabel_enabled, created_at, updated_at
  FROM public.agency_list_children($1::uuid, $2::timestamptz, $3::uuid, $4::int)`,
		tenant.ID, afterAt, afterID, limit+1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	children := make([]Child, 0, limit+1)
	for rows.Next() {
		var child Child
		if err := rows.Scan(&child.ID, &child.Slug, &child.Name, &child.Tier,
			&child.ParentTenantID, &child.BillingMode, &child.ResellerMarkupBps,
			&child.WhitelabelEnabled, &child.CreatedAt, &child.UpdatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if !validChildProjection(child, tenant.ID) {
			httperror.WriteInternal(w, d.Logger, errInvalidChildProjection, r.Context())
			return
		}
		children = append(children, child)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	hasMore := len(children) > limit
	if hasMore {
		children = children[:limit]
	}
	response := childrenResponse{Children: children, Count: len(children), HasMore: hasMore}
	if hasMore && len(children) != 0 {
		last := children[len(children)-1]
		response.NextCursor = encodeChildrenCursor(childrenCursor{CreatedAt: last.CreatedAt, ID: last.ID})
	}
	writeJSON(w, http.StatusOK, response)
}

// validChildProjection rejects malformed legacy rows rather than silently
// rewriting an identity or emitting a shape that strict clients cannot decode.
func validChildProjection(child Child, expectedParentID string) bool {
	if !validCanonicalUUID(child.ID) || !validCanonicalUUID(child.ParentTenantID) ||
		child.ParentTenantID != expectedParentID || child.ID == expectedParentID {
		return false
	}
	if !rosterSlugRE.MatchString(child.Slug) || !validBoundedText(child.Name, 1, 120) {
		return false
	}
	if child.Tier != "studio" && child.Tier != "sending" && child.Tier != "pro" {
		return false
	}
	if child.BillingMode != "self" && child.BillingMode != "parent" {
		return false
	}
	if child.ResellerMarkupBps < 0 || child.ResellerMarkupBps > 100000 {
		return false
	}
	return validJSONTimestamp(child.CreatedAt) && validJSONTimestamp(child.UpdatedAt)
}

func validJSONTimestamp(value time.Time) bool {
	if value.IsZero() {
		return false
	}
	_, err := value.MarshalJSON()
	return err == nil
}

func parseChildrenPage(r *http.Request) (int, *childrenCursor, string, string) {
	query := r.URL.Query()
	for key := range query {
		if key != "limit" && key != "cursor" {
			return 0, nil, "unknown_query_parameter", "only limit and cursor are supported"
		}
		if len(query[key]) != 1 {
			return 0, nil, "duplicate_query_parameter", key + " must be supplied at most once"
		}
	}
	limit := defaultChildrenLimit
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxChildrenLimit {
			return 0, nil, "invalid_limit", "limit must be an integer from 1 through 200"
		}
		limit = parsed
	}
	if raw := strings.TrimSpace(query.Get("cursor")); raw != "" {
		if len(raw) > 512 {
			return 0, nil, "invalid_cursor", "cursor is invalid"
		}
		decoded, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || len(decoded) > 256 || !utf8.Valid(decoded) {
			return 0, nil, "invalid_cursor", "cursor is invalid"
		}
		var cursor childrenCursor
		if err := httpbody.DecodeJSONValue(decoded, &cursor, httpbody.Options{}); err != nil {
			return 0, nil, "invalid_cursor", "cursor is invalid"
		}
		if err := decodeAgencyJSON(decoded); err != nil || cursor.CreatedAt.IsZero() {
			return 0, nil, "invalid_cursor", "cursor is invalid"
		}
		if !validCanonicalUUID(cursor.ID) {
			return 0, nil, "invalid_cursor", "cursor is invalid"
		}
		return limit, &cursor, "", ""
	}
	return limit, nil, "", ""
}

func encodeChildrenCursor(cursor childrenCursor) string {
	raw, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(raw)
}

type createChildInput struct {
	Slug              string `json:"slug"`
	Name              string `json:"name"`
	Tier              string `json:"tier"`
	BillingMode       string `json:"billing_mode"`
	ResellerMarkupBps int    `json:"reseller_markup_bps"`
}

func (d *Deps) CreateChild(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeNotCommitted(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.requireAgencyTenant(r.Context(), tenant.ID); err != nil {
		if errors.Is(err, errNotAgency) {
			setMutationOutcome(w, mutationOutcomeNotCommitted)
			writeNotAgencyDenial(w)
			return
		}
		setMutationOutcome(w, mutationOutcomeNotCommitted)
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var input createChildInput
	if !decodeMutationBody(w, r, &input) {
		return
	}
	input.Slug = strings.ToLower(strings.TrimSpace(input.Slug))
	input.Name = strings.TrimSpace(input.Name)
	if !validWorkspaceSlug(input.Slug) {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_slug", "slug must be 1 to 40 lowercase letters, digits, or interior hyphens")
		return
	}
	if !validBoundedText(input.Name, 1, 120) {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_name", "name must be 1 to 120 visible characters")
		return
	}
	if input.Tier == "" {
		input.Tier = "studio"
	}
	if input.Tier != "studio" && input.Tier != "sending" && input.Tier != "pro" {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_tier", "tier must be studio, sending, or pro")
		return
	}
	if input.BillingMode == "" {
		input.BillingMode = "self"
	}
	if input.BillingMode != "self" && input.BillingMode != "parent" {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_billing_mode", "billing_mode must be self or parent")
		return
	}
	if input.ResellerMarkupBps < 0 || input.ResellerMarkupBps > 100000 {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_markup", "reseller_markup_bps must be from 0 through 100000")
		return
	}
	writeHeldMutation(w, "agency_child_create_release_hold",
		"child creation is unavailable until ownership, invitation, regional bootstrap, and billing provisioning commit atomically; no tenant was created")
}

func (d *Deps) UnlinkChild(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeNotCommitted(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.requireAgencyTenant(r.Context(), tenant.ID); err != nil {
		if errors.Is(err, errNotAgency) {
			setMutationOutcome(w, mutationOutcomeNotCommitted)
			writeNotAgencyDenial(w)
			return
		}
		setMutationOutcome(w, mutationOutcomeNotCommitted)
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	childID := strings.TrimSpace(chi.URLParam(r, "id"))
	if !validCanonicalUUID(childID) {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_child_id", "child id must be a UUID")
		return
	}
	writeHeldMutation(w, "agency_child_unlink_release_hold",
		"child unlink is unavailable until independent ownership and active billing authority can be proven atomically; no relationship was changed")
}

type billingModeInput struct {
	TargetTenantID string `json:"target_tenant_id"`
	Mode           string `json:"mode"`
	Reason         string `json:"reason"`
}

func (d *Deps) SetBillingMode(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeNotCommitted(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.requireAgencyTenant(r.Context(), tenant.ID); err != nil {
		if errors.Is(err, errNotAgency) {
			setMutationOutcome(w, mutationOutcomeNotCommitted)
			writeNotAgencyDenial(w)
			return
		}
		setMutationOutcome(w, mutationOutcomeNotCommitted)
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var input billingModeInput
	if !decodeMutationBody(w, r, &input) {
		return
	}
	input.TargetTenantID = strings.TrimSpace(input.TargetTenantID)
	if !validCanonicalUUID(input.TargetTenantID) {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_target_tenant_id", "target_tenant_id must be a UUID")
		return
	}
	if input.Mode != "self" && input.Mode != "parent" {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_mode", "mode must be self or parent")
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if !validBoundedText(input.Reason, 1, 500) {
		writeNotCommitted(w, http.StatusBadRequest, "invalid_reason", "reason must be 1 to 500 visible characters")
		return
	}
	writeHeldMutation(w, "agency_billing_mode_release_hold",
		"billing-mode changes are unavailable until payer authority and consolidated invoicing are durably implemented; no billing state was changed")
}

func decodeMutationBody(w http.ResponseWriter, r *http.Request, destination any) bool {
	raw, err := httpbody.DecodeJSONBytes(r, agencyJSONMaxBytes, destination, httpbody.Options{})
	if err != nil {
		setMutationOutcome(w, mutationOutcomeNotCommitted)
		httpbody.WriteError(w, err)
		return false
	}
	if err := decodeAgencyJSON(raw); err != nil {
		code, message := "bad_json", "request body is not valid JSON"
		if errors.Is(err, errDuplicateJSONKey) {
			code, message = "duplicate_json_key", "request body contains a duplicate JSON object key"
		}
		writeNotCommitted(w, http.StatusBadRequest, code, message)
		return false
	}
	return true
}

func writeHeldMutation(w http.ResponseWriter, code, message string) {
	writeNotCommitted(w, http.StatusServiceUnavailable, code, message)
}
