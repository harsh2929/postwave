// bulk.go — GAP-LS-016 + 017 + 037. Bulk-delete and bulk-action
// endpoints for the X1 deliverability surface plus the per-reason
// reversibility check. Routes are mounted by handlers.go via
// MountX1BulkRoutes; admin scope is enforced at the main.go mount.

package suppressions

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// bulkActionMaxIDs caps a single bulk request. Postmark caps its own
// bulk delete at 50/req; we pick 500 as a safer ceiling that lets the
// dashboard "select all on page" path through in one round-trip
// (page sizes max at 200) but still bounds DB-side work.
const bulkActionMaxIDs = 500

// suppressionLargeJSONMaxBodyBytes raises the body cap on the X1
// admin endpoints from the legacy 2 MiB to 16 MiB (GAP-LS-030). The
// dashboard bulk-add path realistically ships 50K emails with
// per-row reasons + metadata; at ~150 bytes/row that's ~7.5 MiB so
// 16 MiB gives comfortable headroom. The legacy Deps endpoints
// (POST /api/v1/suppressions and /bulk) keep the 2 MiB cap so a
// migration mistake on the older shape can't accidentally send 50K
// rows through the Repo.Add per-row path.
const suppressionLargeJSONMaxBodyBytes int64 = 16 << 20

// MountX1BulkRoutes registers the bulk + PATCH routes. Caller wraps
// in apikeys.RequireScope(ScopeAdmin) — every route here is
// destructive. The read-shaped timeline/audit/trend routes live in
// MountX1ReadRoutes (gated on ScopeReadSubscribers in main.go).
func (h *StoreHandlers) MountX1BulkRoutes(r chi.Router) {
	r.Post("/api/v1/suppressions/bulk-import", h.BulkImport)
	r.Post("/api/v1/suppressions/bulk-delete", h.BulkDelete)
	r.Post("/api/v1/suppressions/bulk-action", h.BulkAction)
	r.Patch("/api/v1/suppressions/{id}", h.PatchExpiresAt)
}

// bulkImportInput is the body for POST /api/v1/suppressions/bulk-import.
//
// SUB-050. `emails` is the list (CSV/paste-expanded client-side or a JSON
// array) of addresses to suppress on the modern subscriber_suppressions
// table. `reason`/`channel`/`scope` are optional overrides; empty values
// default to manual_unsubscribe / email / marketing inside the Store.
// reason is normalised through NormalizeReason so legacy labels ("manual",
// "imported") fold onto canonical X1 reasons.
type bulkImportInput struct {
	Emails  []string `json:"emails"`
	Reason  string   `json:"reason,omitempty"`
	Channel string   `json:"channel,omitempty"`
	Scope   string   `json:"scope,omitempty"`
}

// bulkImportMaxRows caps a single bulk-import request. Matches the legacy
// /api/v1/suppressions/bulk ceiling so the modern path accepts the same
// 50k+ batch the capability calls for; the 16 MiB body cap
// (suppressionLargeJSONMaxBodyBytes) is the harder physical bound.
const bulkImportMaxRows = 50000

// BulkImport POST /api/v1/suppressions/bulk-import.
//
// SUB-050. Imports a batch of addresses into the modern
// subscriber_suppressions table (the one the send-loop converger reads),
// idempotently via ON CONFLICT DO NOTHING. Each newly-written row gets a
// suppression_audit row (best-effort). Returns {imported, skipped, errors}.
//
// Body cap is the 16 MiB X1 limit (reused from bulk-delete) so a 50k-row
// batch with per-row overhead fits. Admin-scoped at the main.go mount.
func (h *StoreHandlers) BulkImport(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in bulkImportInput
	if err := httpbody.DecodeJSON(w, r, suppressionLargeJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.Emails) > bulkImportMaxRows {
		writeJSON(w, http.StatusRequestEntityTooLarge,
			errEnv("too_many", "max 50000 emails per request"))
		return
	}
	// reason is optional; when present, normalise legacy/freeform labels
	// onto the canonical X1 reason. Empty → Store defaults to
	// manual_unsubscribe.
	var reason Reason
	if in.Reason != "" {
		reason = NormalizeReason(in.Reason)
	}
	res, err := h.Store.BulkImport(r.Context(), t.ID, in.Emails, reason,
		Channel(in.Channel), Scope(in.Scope))
	if err != nil {
		// The handler always passes a NormalizeReason-canonical reason, so
		// the only errors reaching here are infra-level (nil pool / tx /
		// commit). Their text can leak SQL/db internals; route through the
		// generic 5xx envelope with server-side logging.
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	// One audit row per newly-imported address (best-effort; a failed
	// audit write never fails the import).
	auditReason := string(reason)
	if auditReason == "" {
		auditReason = string(ReasonManualUnsubscribe)
	}
	for _, email := range res.Emails {
		h.recordAudit(r.Context(), t.ID, email, AuditActionAdd, auditReason,
			map[string]any{"source": string(SourceImport), "bulk": true, "import": true})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"imported": res.Imported,
		"skipped":  res.Skipped,
		"errors":   res.Errors,
	})
}

// bulkDeleteInput is the body for POST /api/v1/suppressions/bulk-delete.
//
// Rows can be addressed by X1 row uuid (`ids`) and/or by email
// (`emails`, case-insensitive). The email path exists because the
// desktop's converged page historically rendered legacy
// email_suppressions rows whose ids don't exist in the X1 table —
// email is the identity both surfaces share, so a selection made
// against either table resolves to the same X1 rows here (A4 id
// reconciliation).
type bulkDeleteInput struct {
	IDs    []string `json:"ids"`
	Emails []string `json:"emails,omitempty"`
	// Force opts past the per-reason reversibility gate. Reserved for
	// admin override (Klaviyo parity — admin can release a hard-bounce
	// row). DSAR-deletion rows never delete regardless of Force.
	Force bool `json:"force,omitempty"`
}

// bulkDeleteResponse mirrors the wire shape: deleted_count + a per-row
// errors[] so the dashboard can surface "47 of 50 deleted" and the 3
// that 409'd.
type bulkDeleteResponse struct {
	DeletedCount int      `json:"deleted_count"`
	Errors       []string `json:"errors"`
	Blocked      []string `json:"blocked,omitempty"`
}

// BulkDelete POST /api/v1/suppressions/bulk-delete.
//
// GAP-LS-016 + 037 / desktop audit A4. Up to bulkActionMaxIDs
// identifiers (ids + emails combined) per request. Each identifier is
// resolved to an X1 row; rows whose reason is not reversible are
// dropped from the batch and surfaced under `blocked`. The remaining
// rows go through Store.BulkRemoveSelected in one tx and each deletion
// writes a suppression_audit row.
func (h *StoreHandlers) BulkDelete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in bulkDeleteInput
	if err := httpbody.DecodeJSON(w, r, suppressionLargeJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if code, msg, status := validateBulkSelection(in.IDs, in.Emails); code != "" {
		writeJSON(w, status, errEnv(code, msg))
		return
	}
	h.bulkDeleteCore(w, r, t.ID, in)
}

// validateBulkSelection enforces the shared "at least one identifier,
// at most bulkActionMaxIDs total" contract for the bulk endpoints.
// Returns ("", "", 0) when the selection is valid.
func validateBulkSelection(ids, emails []string) (code, msg string, status int) {
	if len(ids) == 0 && len(emails) == 0 {
		return "missing_ids", "body must include ids and/or emails", http.StatusBadRequest
	}
	if len(ids)+len(emails) > bulkActionMaxIDs {
		return "too_many", "max 500 identifiers per request", http.StatusRequestEntityTooLarge
	}
	return "", "", 0
}

// resolveBulkRows resolves a mixed id+email selection to X1 rows,
// deduped by row id (the same row selected via both its id and its
// email collapses to one). Missing rows are silently dropped to match
// the single-row DELETE's not-found-is-a-no-op behaviour; lookup
// failures land in errs as "identifier: err" strings.
func (h *StoreHandlers) resolveBulkRows(r *http.Request, tenantID string, ids, emails []string) (rows []*Entry, errs []string) {
	errs = []string{}
	seen := make(map[string]bool, len(ids)+len(emails))
	add := func(row *Entry) {
		if row == nil || seen[row.ID] {
			return
		}
		seen[row.ID] = true
		rows = append(rows, row)
	}
	for _, id := range ids {
		row, err := h.Store.FetchByID(r.Context(), tenantID, id)
		if err != nil {
			errs = append(errs, id+": "+err.Error())
			continue
		}
		add(row)
	}
	for _, email := range emails {
		row, err := h.Store.FetchByEmail(r.Context(), tenantID, email)
		if err != nil {
			errs = append(errs, email+": "+err.Error())
			continue
		}
		add(row)
	}
	return rows, errs
}

// bulkActionInput is the body for POST /api/v1/suppressions/bulk-action.
// `action` is one of: delete | change_reason | export. Identifier
// semantics match bulkDeleteInput (ids and/or emails).
type bulkActionInput struct {
	IDs    []string `json:"ids"`
	Emails []string `json:"emails,omitempty"`
	Action string   `json:"action"`
	Reason Reason   `json:"reason,omitempty"`
	Force  bool     `json:"force,omitempty"`
}

// BulkAction POST /api/v1/suppressions/bulk-action.
//
// GAP-LS-017. Multiplexes onto BulkDelete + BulkChangeReason + an
// inline export descriptor. The export branch returns the URL of the
// async-export job (see Export in import_export.go for the streaming
// path; large exports go through CreateExportJob).
func (h *StoreHandlers) BulkAction(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in bulkActionInput
	if err := httpbody.DecodeJSON(w, r, suppressionLargeJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if code, msg, status := validateBulkSelection(in.IDs, in.Emails); code != "" {
		writeJSON(w, status, errEnv(code, msg))
		return
	}
	switch in.Action {
	case "delete":
		// Delegate to the bulk-delete handler with the same body shape.
		// The dashboard hits whichever endpoint matches its UX; both
		// observe the same reversibility policy.
		bdi := bulkDeleteInput{IDs: in.IDs, Emails: in.Emails, Force: in.Force}
		h.bulkDeleteCore(w, r, t.ID, bdi)
		return
	case "change_reason":
		if !ValidReasons[in.Reason] {
			writeJSON(w, http.StatusBadRequest,
				errEnv("invalid_reason", "reason must be a canonical enum"))
			return
		}
		if in.Reason == ReasonDSARDeletion {
			writeJSON(w, http.StatusConflict,
				errEnv("protected_reason", "dsar_deletion can only be recorded through the erasure workflow"))
			return
		}
		rows, errs := h.resolveBulkRows(r, t.ID, in.IDs, in.Emails)
		ids := make([]string, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.ID)
		}
		updated := 0
		if len(ids) > 0 {
			actorUserID := ""
			if user, ok := middleware.UserFromContext(r.Context()); ok {
				actorUserID = user.ID
			}
			evidence, err := h.Store.BulkChangeReason(
				r.Context(), t.ID, ids, in.Reason,
				actorUserID, middleware.APIKeyIDFromContext(r.Context()),
			)
			if err != nil {
				if errors.Is(err, ErrPermanentSuppressionReclassification) {
					writeJSON(w, http.StatusConflict,
						errEnv("protected_reason", "the reviewed scope contains a permanent DSAR deletion suppression"))
					return
				}
				if errors.Is(err, ErrSuppressionReasonChanged) {
					writeJSON(w, http.StatusConflict,
						errEnv("suppression_changed", "a reviewed suppression changed; refresh before retrying"))
					return
				}
				httperror.WriteInternal(w, h.Logger, err, r.Context())
				return
			}
			updated = len(evidence)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"updated_count": updated,
			"errors":        errs,
		})
		return
	case "export":
		// Inline-export descriptor — for selection-based exports the
		// caller asks the export endpoint with ?ids=... or the async
		// path with the selected ids. We return a small descriptor the
		// dashboard turns into a GET ?ids= request.
		writeJSON(w, http.StatusOK, map[string]any{
			"export_url": "/api/v1/suppressions/export",
			"ids":        in.IDs,
		})
		return
	}
	writeJSON(w, http.StatusBadRequest, errEnv("invalid_action",
		"action must be one of: delete, change_reason, export"))
}

// bulkDeleteCore is the shared body of BulkDelete + BulkAction's
// delete branch (factored out so BulkAction can call it without
// re-reading the request body). Resolves ids+emails, applies the
// per-reason reversibility gate, deletes in one tx, then writes one
// audit row per deleted row.
func (h *StoreHandlers) bulkDeleteCore(w http.ResponseWriter, r *http.Request, tenantID string, in bulkDeleteInput) {
	resp := bulkDeleteResponse{Errors: []string{}, Blocked: []string{}}
	rows, errs := h.resolveBulkRows(r, tenantID, in.IDs, in.Emails)
	resp.Errors = append(resp.Errors, errs...)
	allowed := make([]*Entry, 0, len(rows))
	for _, row := range rows {
		rev := ReversibilityFor(row.Reason)
		if rev == ReversibilityPermanent {
			resp.Blocked = append(resp.Blocked, row.ID+": "+string(row.Reason)+" is permanent")
			continue
		}
		if rev == ReversibilityNeedsAdmin && !in.Force {
			resp.Blocked = append(resp.Blocked, row.ID+": "+string(row.Reason)+" requires force=true")
			continue
		}
		allowed = append(allowed, row)
	}
	if len(allowed) > 0 {
		deletedIDs, errs, err := h.Store.BulkRemoveSelected(r.Context(), tenantID, allowed)
		if err != nil {
			// Partial-failure shape: the tx already rolled back so
			// nothing was deleted; the full err is logged server-side
			// (with request_id) via httperror.WriteInternal.
			resp.Errors = append(resp.Errors, errs...)
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		resp.Errors = append(resp.Errors, errs...)
		resp.DeletedCount = len(deletedIDs)
		deleted := make(map[string]struct{}, len(deletedIDs))
		for _, id := range deletedIDs {
			deleted[id] = struct{}{}
		}
		for _, row := range allowed {
			if _, ok := deleted[row.ID]; !ok {
				continue
			}
			h.recordAudit(r.Context(), tenantID, row.Email, AuditActionRemove, string(row.Reason),
				map[string]any{
					"id": row.ID, "source": string(row.Source), "bulk": true,
					"subscriber_reactivated":        false,
					"reviewed_resubscribe_required": ReversibilityFor(row.Reason) == ReversibilityNeedsAdmin,
				})
		}
	}
	writeJSON(w, http.StatusOK, resp)
}
