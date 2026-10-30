// Package dispatchcontrol owns the process-level authorization boundary for
// campaign operations that can place real recipient traffic on a delivery
// queue. The gate intentionally defaults closed when it is not wired.
package dispatchcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// ErrLiveDispatchDisabled is returned when an operator has not explicitly
// enabled live campaign dispatch for this API process.
var ErrLiveDispatchDisabled = errors.New("live campaign dispatch is disabled")

// Gate is the single policy seam shared by every campaign dispatch entry
// point. Implementations may be global or tenant-aware.
type Gate interface {
	AllowLiveDispatch(ctx context.Context, tenantID string) error
}

// GateFunc adapts a function into a Gate, primarily for focused tests and
// tenant-aware policy implementations.
type GateFunc func(ctx context.Context, tenantID string) error

func (f GateFunc) AllowLiveDispatch(ctx context.Context, tenantID string) error {
	return f(ctx, tenantID)
}

// StaticGate is the production composition used by the environment-backed
// startup configuration. Its zero value is deliberately fail-closed.
type StaticGate struct {
	Enabled bool
}

func (g StaticGate) AllowLiveDispatch(context.Context, string) error {
	if !g.Enabled {
		return ErrLiveDispatchDisabled
	}
	return nil
}

// Check applies the configured policy. A missing dependency is equivalent to
// an explicitly disabled policy so partial wiring can never enable sends.
func Check(g Gate, ctx context.Context, tenantID string) error {
	if g == nil {
		return ErrLiveDispatchDisabled
	}
	return g.AllowLiveDispatch(ctx, tenantID)
}

// HTTPError translates policy failures into the stable public contract shared
// by every campaign dispatch-capable route. Disabled is an operator lock (423);
// an indeterminate policy backend is temporarily unavailable (503).
func HTTPError(err error) (status int, code, message string) {
	if errors.Is(err, ErrLiveDispatchDisabled) {
		return http.StatusLocked, "campaign_live_dispatch_disabled",
			"live campaign dispatch is disabled by operator policy"
	}
	return http.StatusServiceUnavailable, "campaign_live_dispatch_unavailable",
		"live campaign dispatch policy is temporarily unavailable"
}

// WriteHTTPError writes only the fixed strings returned by HTTPError. It is
// intentionally separate from generic 5xx helpers, which correctly collapse
// unknown infrastructure details to internal_error; this policy response is a
// documented, non-sensitive 503 contract clients must be able to branch on.
func WriteHTTPError(w http.ResponseWriter, err error) {
	status, code, message := HTTPError(err)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
