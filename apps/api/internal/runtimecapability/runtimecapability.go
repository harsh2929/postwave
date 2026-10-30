// Package runtimecapability exposes a small, stable contract for product
// surfaces whose control plane is available while execution is deliberately
// fail-closed. It keeps these responses distinct from unexpected 5xx errors:
// clients can stop retrying and render an honest unavailable state without
// learning infrastructure details.
package runtimecapability

import (
	"encoding/json"
	"net/http"
)

const StatusUnavailable = "unavailable"

// Descriptor is safe to expose in catalogs and resource representations.
// Prerequisites must remain generic capability names, never secret/config
// values or internal error text.
type Descriptor struct {
	Capability       string   `json:"capability"`
	RuntimeStatus    string   `json:"runtime_status"`
	ExecutionEnabled bool     `json:"execution_enabled"`
	Code             string   `json:"code"`
	Message          string   `json:"message"`
	Prerequisites    []string `json:"prerequisites,omitempty"`
}

// Unavailable constructs the canonical descriptor for a contained runtime.
func Unavailable(capability, code, message string, prerequisites ...string) Descriptor {
	return Descriptor{
		Capability:       capability,
		RuntimeStatus:    StatusUnavailable,
		ExecutionEnabled: false,
		Code:             code,
		Message:          message,
		Prerequisites:    prerequisites,
	}
}

type unavailableEnvelope struct {
	Error unavailableError `json:"error"`
}

type unavailableError struct {
	Code          string `json:"code"`
	Message       string `json:"message"`
	Capability    string `json:"capability"`
	RuntimeStatus string `json:"runtime_status"`
	Retryable     bool   `json:"retryable"`
}

// WriteUnavailable emits a machine-readable 503 for an intentionally disabled
// execution capability. Unlike an internal-error writer, this code and message
// are static product contract data and are therefore safe to expose.
func WriteUnavailable(w http.ResponseWriter, descriptor Descriptor) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Postwave-Capability-Status", StatusUnavailable)
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(unavailableEnvelope{Error: unavailableError{
		Code:          descriptor.Code,
		Message:       descriptor.Message,
		Capability:    descriptor.Capability,
		RuntimeStatus: StatusUnavailable,
		Retryable:     false,
	}})
}
