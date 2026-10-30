// SPDX-License-Identifier: AGPL-3.0-only

package httperror

import (
	"encoding/json"
	"net/http"
	"regexp"
)

// capabilityCode is the shape a stable capability code must have to be worth
// a client's switch statement: lower snake case, 3-64 characters.
var capabilityCode = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

// WriteUnavailable answers 503 for a capability this deployment cannot serve:
// a feature that is switched off, or a service that is not deployed here.
//
// Write replaces the code and message of every 5xx with internal_error, which
// is right for failures — their text is not the caller's business — and wrong
// for this. "This feature is not enabled" is not a fault, and dressed as one a
// client shows a red error with a Retry button that can never succeed, while
// an operator goes looking for a crash that never happened. So the code and
// message survive here, and retryable tells the client whether asking again
// can ever help. The message must be a fixed, operator-authored sentence.
//
// The answer describes the deployment, not the request, and changes only when
// the deployment does, so it is never cached. A code that is not a stable
// capability code falls back to Write's sanitized envelope.
func WriteUnavailable(w http.ResponseWriter, code, message string, retryable bool) {
	if !capabilityCode.MatchString(code) {
		Write(w, http.StatusServiceUnavailable, code, message)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", ContentTypeJSON)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(unavailableEnvelope{Err: unavailableBody{
		Code:      code,
		Message:   message,
		Retryable: retryable,
		RequestID: requestIDFromWriter(w),
	}})
}

type unavailableEnvelope struct {
	Err unavailableBody `json:"error"`
}

type unavailableBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	RequestID string `json:"request_id,omitempty"`
}
