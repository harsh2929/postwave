// SPDX-License-Identifier: AGPL-3.0-only

package transactional

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

const (
	emailJSONMaxBodyBytes int64 = 35 << 20 // single send (attachments inflate base64)
	batchJSONMaxBodyBytes int64 = 40 << 20
)

// MountSendRoutes registers the mutating send routes. The caller MUST wrap
// these in the idempotency middleware + a ScopeSendTransactional gate (mirrors
// campaigns.MountSend — see main.go).
func MountSendRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil || d.Mailer == nil {
		return
	}
	r.Post("/api/v1/emails", d.handleSend)
	r.Post("/api/v1/emails/batch", d.handleBatch)
}

// MountReadRoutes registers the read-only status routes. The caller wraps these
// in a read scope (e.g. ScopeReadReports).
func MountReadRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/api/v1/emails/{id}", d.handleGet)
	r.Get("/api/v1/emails", d.handleList)
}

func (d *Deps) handleSend(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var req SendRequest
	if err := httpbody.DecodeJSONWith(w, r, emailJSONMaxBodyBytes, &req, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// The caller's Idempotency-Key IS the intent identity: only the client
	// knows that two requests are the same attempt. The idempotency middleware
	// replays a cached RESPONSE for 24h; this binds the same key to the send
	// LEDGER, which outlives that window — so a retry after the cache expires
	// still returns the original message instead of sending a second one.
	res, err := d.SendWithIntent(r.Context(), t.ID, "api", &req,
		strings.TrimSpace(r.Header.Get("Idempotency-Key")), time.Now().UTC())
	if err != nil {
		if errors.Is(err, ErrValidation) {
			httperror.WriteValidation(w, "invalid_request", err.Error())
			return
		}
		if errors.Is(err, ErrIntentConflict) {
			// 409, never 5xx. This is a caller mistake — the same
			// Idempotency-Key carrying different content — and answering 5xx
			// would make the idempotency middleware treat it as transient and
			// DROP the claim, so the retry would be free to send. It must also
			// not be a 2xx: returning the first message's id would silently
			// discard the second message.
			httperror.Write(w, http.StatusConflict, "idempotency_key_reused",
				"This Idempotency-Key was already used for a different message. Use a new key, or resend the original content.")
			return
		}
		if errors.Is(err, sendallowance.ErrExhausted) {
			var exhausted *sendallowance.ExhaustedError
			if errors.As(err, &exhausted) {
				limit, current := int64(exhausted.Limit), int64(exhausted.Current)
				entitlement.Write(w, entitlement.Denial{
					Subject: "transactional.send", Reason: entitlement.ReasonPlan,
					Code:     "managed_send_allowance_exhausted",
					Message:  "The workspace has reached its monthly accepted-recipient allowance.",
					Resource: string(limits.ResourceMonthlySends), Limit: &limit, Current: &current,
				})
				return
			}
			httperror.Write(w, http.StatusServiceUnavailable, "managed_send_allowance_unavailable",
				"Email admission is temporarily unavailable. No recipient was submitted.")
			return
		}
		if errors.Is(err, sendallowance.ErrUnavailable) {
			httperror.Write(w, http.StatusServiceUnavailable, "managed_send_allowance_unavailable",
				"Email admission is temporarily unavailable. No recipient was submitted.")
			return
		}
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Provider dispatch failures return 202 and are reported in
	// res.Status/res.Error. Pre-provider allowance decisions return above as
	// 402/503: they cannot double-send because no provider call occurred.
	writeJSON(w, http.StatusAccepted, res)
}

// BatchRequest is the body of POST /api/v1/emails/batch. Accepts either a bare
// array or {emails:[...]} / {data:[...]} for flexibility.
type BatchRequest struct {
	Emails []SendRequest `json:"emails"`
}

func (d *Deps) handleBatch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Read the raw body once so we can accept a bare array OR {emails:[...]}.
	raw, err := httpbody.ReadJSONAtMost(r, batchJSONMaxBodyBytes, httpbody.Options{})
	if err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	var emails []SendRequest
	trimmed := firstNonSpace(raw)
	if trimmed == '[' {
		if err := httpbody.DecodeJSONValue(raw, &emails, httpbody.Options{}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	} else {
		var wrap BatchRequest
		if err := httpbody.DecodeJSONValue(raw, &wrap, httpbody.Options{}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
		emails = wrap.Emails
	}
	if len(emails) == 0 {
		httperror.WriteValidation(w, "empty_batch", "no emails in batch")
		return
	}
	if len(emails) > MaxBatchSize {
		httperror.WriteValidation(w, "batch_too_large", "batch exceeds the "+strconv.Itoa(MaxBatchSize)+"-email limit")
		return
	}
	now := time.Now().UTC()
	results := make([]SendResult, 0, len(emails))
	for i := range emails {
		// Batch members each get their own intent, keyed by POSITION: one key
		// for the whole batch would make the second message a "replay" of the
		// first and silently drop it.
		//
		// Positional keying means a retry that REORDERS the batch will find
		// each position holding a different message — which surfaces below as
		// an explicit conflict rather than a send. That is the correct outcome:
		// the client asserted "this is the same attempt" and then changed what
		// it was.
		batchKey := ""
		if k := strings.TrimSpace(r.Header.Get("Idempotency-Key")); k != "" {
			batchKey = fmt.Sprintf("%s:%d", k, i)
		}
		res, err := d.SendWithIntent(r.Context(), t.ID, "batch", &emails[i], batchKey, now)
		if err != nil {
			if errors.Is(err, ErrIntentConflict) {
				// A distinct per-member status. This used to render as
				// `{"id":"","status":"failed","error":"send failed"}`, which a
				// caller cannot tell apart from a provider failure — and it
				// carried no id, so there was nothing to look up either.
				results = append(results, SendResult{
					Status: "conflict",
					Error: "This Idempotency-Key position was already used for a different message. " +
						"Retry the batch unchanged, or use a new key.",
				})
				continue
			}
			// Per-item validation/infra error → record as a failed result so
			// the batch returns 200 with the full per-item breakdown.
			results = append(results, SendResult{Status: "failed", Error: validationMsg(err)})
			continue
		}
		results = append(results, res)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

func (d *Deps) handleGet(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	rec, err := d.Repo.Get(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "email not found")
			return
		}
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (d *Deps) handleList(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	// `?attempt_state=unknown` is the triage surface for sends whose provider
	// outcome could not be established. Without a way to LIST them, "surfaced
	// for a human rather than guessed at" is a claim about a log line.
	attemptState := strings.TrimSpace(r.URL.Query().Get("attempt_state"))
	switch attemptState {
	case "", "prepared", "submitted", "acknowledged", "rejected", "unknown":
	default:
		httperror.WriteValidation(w, "invalid_attempt_state",
			"attempt_state must be one of prepared, submitted, acknowledged, rejected, unknown")
		return
	}
	recs, err := d.Repo.ListRecent(r.Context(), t.ID, limit, attemptState)
	if err != nil {
		httperror.WriteInternal(w, d.log(), err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": recs})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func firstNonSpace(b []byte) byte {
	for _, c := range b {
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			continue
		}
		return c
	}
	return 0
}

func validationMsg(err error) string {
	if errors.Is(err, ErrValidation) {
		return truncate(err.Error(), 300)
	}
	return "send failed"
}
