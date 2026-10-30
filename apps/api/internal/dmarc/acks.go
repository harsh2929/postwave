// SPDX-License-Identifier: AGPL-3.0-only
//
// acks.go — dormant persisted acknowledgements for DMARC suggestions.
//
// Acknowledgements are tenant-global, permanent state without actor/lifecycle
// governance. Native server composition therefore leaves them disabled and
// both routes fail closed with a stable 503 before reading a body or opening a
// database transaction. The guarded implementation is retained for a future,
// explicitly reviewed rollout.
//
// Wire surface:
//
//   POST   /api/v1/deliverability/dmarc-suggestions/ack    {code, note?}
//   DELETE /api/v1/deliverability/dmarc-suggestions/ack/:code

package dmarc

import (
	"net/http"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type ackReq struct {
	Code string `json:"code"`
	Note string `json:"note,omitempty"`
}

const suggestionAckDisabledCode = "suggestion_acknowledgements_disabled"

// AckSuggestion POST /api/v1/deliverability/dmarc-suggestions/ack.
//
// Idempotent — re-acking the same code refreshes the timestamp +
// note via ON CONFLICT DO UPDATE so an operator who edits their note
// doesn't need to unack first.
func (d *Deps) AckSuggestion(w http.ResponseWriter, r *http.Request) {
	setSensitiveResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !d.EnableSuggestionAcknowledgements {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			suggestionAckDisabledCode,
			"DMARC suggestion acknowledgements are not available",
		))
		return
	}
	var body ackReq
	if err := httpbody.DecodeJSONWith(w, r, 4<<10, &body, httpbody.Options{}); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	code := body.Code
	if !isAcknowledgeableSuggestionCode(code) {
		httperror.WriteValidation(w, "invalid_code", "code must identify a current DMARC suggestion")
		return
	}
	if len(body.Note) > 1000 || containsControlCharacter(body.Note) {
		httperror.WriteValidation(w, "invalid_note", "note must be at most 1000 bytes and contain no control characters")
		return
	}
	note := strings.TrimSpace(body.Note)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	_, err = tx.Exec(r.Context(), `
		INSERT INTO dmarc_suggestion_acks (tenant_id, code, note, acked_at)
		VALUES ($1::uuid, $2, $3, now())
		ON CONFLICT (tenant_id, code) DO UPDATE
		   SET note = EXCLUDED.note, acked_at = EXCLUDED.acked_at
	`, t.ID, code, note)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "code": code})
}

// UnackSuggestion DELETE /api/v1/deliverability/dmarc-suggestions/ack/{code}.
//
// Hard delete — once an operator changes their mind, we want the
// suggestion back immediately without needing a `deleted_at` predicate
// everywhere the table is read. Idempotent (0 rows affected = 200).
func (d *Deps) UnackSuggestion(w http.ResponseWriter, r *http.Request) {
	setSensitiveResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !d.EnableSuggestionAcknowledgements {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			suggestionAckDisabledCode,
			"DMARC suggestion acknowledgements are not available",
		))
		return
	}
	code := chi.URLParam(r, "code")
	if !isAcknowledgeableSuggestionCode(code) {
		httperror.WriteValidation(w, "invalid_code", "code must identify a current DMARC suggestion")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	_, err = tx.Exec(r.Context(),
		`DELETE FROM dmarc_suggestion_acks WHERE tenant_id = $1::uuid AND code = $2`,
		t.ID, code)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "code": code})
}

func isAcknowledgeableSuggestionCode(code string) bool {
	if len(code) == 0 || len(code) > 64 {
		return false
	}
	switch code {
	case "alignment_low",
		"no_observed_messages",
		"no_reports",
		"policy_action_volume_high",
		"policy_action_volume_low",
		"spf_only_alignment":
		return true
	default:
		return false
	}
}

func containsControlCharacter(value string) bool {
	for _, char := range value {
		if unicode.IsControl(char) {
			return true
		}
	}
	return false
}
