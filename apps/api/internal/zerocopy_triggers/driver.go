package zerocopy_triggers

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// DriverRow is what a Driver returns for each new warehouse row.
// CursorValue is the per-row value of the trigger's cursor_column —
// the worker takes the max() of these to advance the trigger's
// last_seen_cursor.
type DriverRow struct {
	CursorValue string
	ProfileKey  string
	Payload     map[string]any
}

// Driver is the seam every warehouse implementation plugs into. The
// interface is intentionally narrow: one function returning rows. The
// worker handles cursoring + journey fan-out so each driver stays a
// "pure read".
type Driver interface {
	// Poll runs the configured query once, substituting :last_seen_cursor
	// with the trigger's current cursor. Returns at most max rows.
	Poll(ctx context.Context, t Trigger, max int) ([]DriverRow, error)
}

// registry maps a provider key ("snowflake", "bigquery", …) to a
// Driver instance. Production composition registers concrete drivers.
var (
	driverMu sync.RWMutex
	drivers  = map[string]Driver{}
)

// RegisterDriver lets future overlays attach native drivers. Returning
// false-on-conflict would be safer, but our internal callers know what
// they're doing — we overwrite to keep the wiring minimal.
func RegisterDriver(provider string, d Driver) {
	if provider == "" || d == nil {
		return
	}
	driverMu.Lock()
	defer driverMu.Unlock()
	drivers[strings.ToLower(strings.TrimSpace(provider))] = d
}

// resolveDriver looks up the driver for a provider. Missing registrations
// return an erroring driver so polling cannot report a successful empty run.
func resolveDriver(provider string) Driver {
	driverMu.RLock()
	defer driverMu.RUnlock()
	key := strings.ToLower(strings.TrimSpace(provider))
	if d, ok := drivers[key]; ok {
		return d
	}
	return unavailableDriver{provider: key}
}

type unavailableDriver struct {
	provider string
}

func (d unavailableDriver) Poll(_ context.Context, _ Trigger, _ int) ([]DriverRow, error) {
	if d.provider == "" {
		return nil, fmt.Errorf("zero-copy driver is not registered")
	}
	return nil, fmt.Errorf("zero-copy driver %q is not registered", d.provider)
}
