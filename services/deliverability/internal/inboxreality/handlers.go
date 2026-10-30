// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

const maxDispatchBodyBytes = 48 << 20

// Handler authenticates the exact request body before handing it to the
// durable dispatcher. The surrounding service router must additionally apply
// its bearer-token middleware; this body signature is the replay/fencing
// boundary, not a replacement for service authentication.
type Handler struct {
	Dispatcher *Dispatcher
	// Seeds is the live controlled-mailbox registry. The catalog endpoint
	// projects it; this service remains the only component holding the
	// credentials that read those mailboxes.
	Seeds          *seedlist.Registry
	SigningSecrets string
	Clock          func() time.Time
}

func (h *Handler) MountInternal(r chi.Router) {
	r.Post(inboxrealitycontract.DispatchPath, h.Dispatch)
	r.Get(inboxrealitycontract.SeedlistPath, h.Seedlist)
}

// Seedlist serves the active controlled-mailbox catalog to the API gateway.
//
// This is signed with the same internal secret as Dispatch, and for a stronger
// reason than it might appear: the response enumerates every seed address we
// own. Anyone holding that list can allowlist it, at which point every
// placement result we report becomes a measurement of a special case rather
// than of ordinary mail.
func (h *Handler) Seedlist(w http.ResponseWriter, r *http.Request) {
	if err := internalsign.Verify(h.SigningSecrets, r.Method, r.URL.EscapedPath(), nil,
		internalsign.FromHTTP(r.Header), h.now(), internalsign.DefaultTolerance); err != nil {
		writeServiceJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_internal_signature"})
		return
	}
	// Fail closed rather than returning an empty catalog. "We own no seeds" and
	// "the registry did not load" are different facts, and only the second one
	// should stop the gateway from offering a manual test.
	if h == nil || h.Seeds == nil {
		writeServiceJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "seed_registry_unavailable"})
		return
	}
	writeServiceJSON(w, http.StatusOK, seedlist.Catalog(h.Seeds))
}

func (h *Handler) Dispatch(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Dispatcher == nil {
		writeServiceJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "dispatcher_unavailable"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDispatchBodyBytes))
	if err != nil {
		writeServiceJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "request_too_large"})
		return
	}
	if err := internalsign.Verify(h.SigningSecrets, r.Method, r.URL.EscapedPath(), body,
		internalsign.FromHTTP(r.Header), h.now(), internalsign.DefaultTolerance); err != nil {
		writeServiceJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_internal_signature"})
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var request inboxrealitycontract.DispatchRequest
	if err := decoder.Decode(&request); err != nil {
		writeServiceJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeServiceJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	if internalsign.FromHTTP(r.Header).RequestID != request.CommandID {
		writeServiceJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_internal_request_id"})
		return
	}
	receipt, err := h.Dispatcher.Execute(r.Context(), request)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidRequest):
			writeServiceJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		case errors.Is(err, ErrCommandConflict), errors.Is(err, ErrExecutionLeaseLost):
			writeServiceJSON(w, http.StatusConflict, map[string]any{"error": "command_conflict"})
		case errors.Is(err, ErrCapabilityUnavailable):
			writeServiceJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "required_capability_unavailable"})
		case errors.Is(err, ErrNoActiveSeeds):
			writeServiceJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "no_active_controlled_seeds"})
		default:
			writeServiceJSON(w, http.StatusInternalServerError, map[string]any{"error": "dispatch_failed"})
		}
		return
	}
	writeServiceJSON(w, http.StatusOK, receipt)
}

func (h *Handler) now() time.Time {
	if h != nil && h.Clock != nil {
		return h.Clock().UTC()
	}
	return time.Now().UTC()
}

func writeServiceJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
