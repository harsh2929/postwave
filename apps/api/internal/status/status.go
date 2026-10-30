// Package status powers status.moosewave.com. It exposes
// GET /api/v1/status/public (no auth, cached 60s) and runs a background
// poller that every minute pings each downstream service's /health endpoint
// and rolls daily aggregates into the service_health table.
package status

import (
	"strings"
	"time"
)

// OverallStatus is the top-level state shown above the fold.
type OverallStatus string

const (
	StatusOperational OverallStatus = "operational"
	StatusDegraded    OverallStatus = "degraded"
	StatusOutage      OverallStatus = "outage"
)

// ServiceStatus is one row of the per-service grid.
type ServiceStatus struct {
	Name        string        `json:"name"`
	Status      OverallStatus `json:"status"`
	LatencyMS   int64         `json:"latency_ms"`
	LastChecked time.Time     `json:"last_checked"`
}

// UptimeDay represents one cell in the 90-day uptime grid.
type UptimeDay struct {
	Day             string  `json:"day"` // YYYY-MM-DD
	UptimePct       float64 `json:"uptime_pct"`
	DegradedMinutes int     `json:"degraded_minutes"`
	OutageMinutes   int     `json:"outage_minutes"`
}

// Incident is one published row from the incidents table.
type Incident struct {
	ID               string     `json:"id"`
	Title            string     `json:"title"`
	Status           string     `json:"status"`   // investigating|identified|monitoring|resolved
	Severity         string     `json:"severity"` // minor|major|critical
	StartedAt        time.Time  `json:"started_at"`
	ResolvedAt       *time.Time `json:"resolved_at,omitempty"`
	Description      string     `json:"description,omitempty"`
	AffectedServices []string   `json:"affected_services"`
}

// PublicResponse is the JSON shape served at /api/v1/status/public.
type PublicResponse struct {
	Overall     OverallStatus          `json:"overall"`
	Services    []ServiceStatus        `json:"services"`
	Uptime      map[string][]UptimeDay `json:"uptime"`
	Incidents   []Incident             `json:"incidents"`
	GeneratedAt time.Time              `json:"generated_at"`
}

// ServiceTargets enumerates the URLs the poller probes. Each is expected to
// expose a JSON `/health` returning `{"status":"ok"}` quickly.
type ServiceTargets struct {
	Migration      string
	Voice          string
	Automation     string
	Deliverability string
	Listmonk       string
}

// names returns the services this deployment runs, in a fixed order. A service
// with no URL is not deployed here (its *_SERVICE_URL is "disabled"): it is
// neither probed nor listed, rather than shown as "operational" with uptime it
// never had.
func (t ServiceTargets) names() []string {
	names := make([]string, 0, 5)
	for _, name := range []string{"migration", "voice", "automation", "deliverability", "listmonk"} {
		if strings.TrimSpace(t.urlFor(name)) != "" {
			names = append(names, name)
		}
	}
	return names
}

// urlFor maps a name back to the URL.
func (t ServiceTargets) urlFor(name string) string {
	switch name {
	case "migration":
		return t.Migration
	case "voice":
		return t.Voice
	case "automation":
		return t.Automation
	case "deliverability":
		return t.Deliverability
	case "listmonk":
		return t.Listmonk
	}
	return ""
}

// healthPath is the canonical health-check sub-path.
const healthPath = "/health"
