// Package zerocopy_triggers implements Braze's "Zero-Copy Canvas Triggers"
// parity (gap: sto-zero-copy-warehouse-triggers, P3, XL).
//
// What it does
// ============
// An operator points us at a warehouse query (Snowflake / BigQuery /
// Redshift / Postgres) and a target journey. The worker polls the query
// at the configured interval and, for every new row (cursor-advanced),
// enqueues a flow_run targeting that journey. No ETL into our event
// stream is required — the warehouse stays the source of truth.
//
// Status
// ======
// Production composition registers concrete Snowflake, BigQuery, Redshift,
// and Postgres drivers. A missing driver returns an error and records a failed
// poll; it never degrades to a successful empty result.
//
// Why the seam looks like this
// ============================
// The existing warehouse package (apps/api/internal/warehouse) owns
// connection rows (credentials_ref, config, provider). We re-use those
// rows by foreign key — adding native drivers later means filling in
// the Driver implementations, not duplicating credentials storage.
package zerocopy_triggers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
	"github.com/postwave/postwave/apps/api/internal/runtimecapability"
)

// defaultMaxRowsPerTick is the driver row bound applied when a trigger does not
// set one. Named rather than inlined because the watermark has to recognise a
// batch that came back FULL — a truncated batch may have cut a cursor-value
// group in half, and publishing that group would skip its remainder.
const defaultMaxRowsPerTick = 500

// executionEnabled is the runtime gate. Default OFF.
//
// It used to be `const zeroCopyRuntimeQualified = false`, whose two named
// prerequisites — `distributed_trigger_leasing` and
// `durable_execution_receipts` — did not exist. Both do now:
//
//   - leasing: the tick runs under `leader.Run` on a Postgres advisory lock, so
//     one instance polls per tick instead of every replica billing the
//     warehouse for the same scan;
//   - receipts: `Repo.ClaimFire` durably reserves each warehouse row before it
//     is enqueued (migration 1859), so an interrupted batch cannot re-enrol
//     subscribers it already enrolled.
//
// The gate stays closed anyway, and that is deliberate. Built is not certified:
// this subsystem's purpose is to enqueue journey runs, which send mail, and the
// remaining prerequisite is a release decision backed by evidence rather than
// another line of code — exactly the distinction §11's promotion machinery
// exists to make. What CHANGED is that "unavailable" is now a decision someone
// can reverse, rather than a constant asserting that infrastructure is missing
// when it is not.
//
// For the avoidance of doubt: no duplicate enrolment has ever occurred here.
// This subsystem has never executed — beyond this gate, main.go never starts
// the worker (a contract test forbids it), PollNow is unconditionally 503, and
// flowbuilder's own gate means no flow_runs row can be created at all. The
// receipt work is a precondition for opening this gate, not a repair.
var executionEnabled atomic.Bool

// SetExecutionEnabled turns zero-copy trigger EXECUTION on or off at
// composition time. Returns the previous value.
//
// Scope, precisely: it unlocks the poll path — `Worker.tick`, `PollOnce`, and
// the repo mutations they depend on. It does NOT unlock the contained
// handlers (Create/Update with an active trigger, PollNow, PutAlerts,
// RetryDLQ), which answer 503 on their own terms via
// zeroCopyControlPlaneDescriptor, and it does not start the worker — main.go
// never calls Run, and a contract test forbids adding it. Turning this on
// alone therefore changes nothing observable; it is the gate a release
// decision opens, not the release.
//
// Deliberately a function and not an exported variable: a call site is
// greppable in a way an assignment to a package var is not.
func SetExecutionEnabled(enabled bool) bool {
	previous := executionEnabled.Swap(enabled)
	if previous != enabled {
		slog.Warn("zerocopy_triggers: execution gate changed",
			"enabled", enabled,
			"note", "enabling starts warehouse polling and journey enrolment")
	}
	return previous
}

// ExecutionEnabled reports whether execution is currently permitted.
func ExecutionEnabled() bool { return executionEnabled.Load() }

// zeroCopyRuntimeQualified keeps the original call-site spelling. There are
// eighteen of them across this package and every one is a fail-closed guard;
// renaming them all would have made this change unreviewable.
func zeroCopyRuntimeQualified() bool { return executionEnabled.Load() }

// zeroCopyControlPlaneDescriptor is what the CONTAINED handlers answer with.
//
// Five handlers — Create/Update with an active trigger, PollNow, PutAlerts and
// RetryDLQ — are 503 regardless of the execution gate, because their own
// behaviour was never built out. Handing them the execution descriptor produced
// a self-contradictory response the moment the gate was opened: HTTP 503 and
// `runtime_status: "unavailable"` (which WriteUnavailable hardcodes) alongside
// `code: "zero_copy_runtime_available"` and "execution is enabled". A handler
// should describe its own containment, not borrow a neighbouring one's.
func zeroCopyControlPlaneDescriptor() runtimecapability.Descriptor {
	return runtimecapability.Unavailable(
		"zero_copy_trigger_execution",
		"zero_copy_runtime_unavailable",
		"Zero-copy trigger execution is unavailable; no warehouse query was polled or journey run queued.",
		"release_certification",
	)
}

// zeroCopyRuntimeDescriptor is the client-facing capability record. Computed
// per call rather than once at init, because the gate is now settable and a
// cached descriptor would keep reporting the boot-time answer.
func zeroCopyRuntimeDescriptor() runtimecapability.Descriptor {
	if executionEnabled.Load() {
		return runtimecapability.Descriptor{
			Capability:       "zero_copy_trigger_execution",
			RuntimeStatus:    "available",
			ExecutionEnabled: true,
			Code:             "zero_copy_runtime_available",
			Message:          "Zero-copy trigger execution is enabled.",
		}
	}
	return runtimecapability.Unavailable(
		"zero_copy_trigger_execution",
		"zero_copy_runtime_unavailable",
		"Zero-copy trigger execution is unavailable; no warehouse query was polled or journey run queued.",
		// Leasing and durable receipts are built. What is outstanding is the
		// release decision, and naming it as a prerequisite is more honest than
		// listing infrastructure that already exists.
		"release_certification",
	)
}

// Trigger is the API/JSON shape of an external_warehouse_triggers row.
type Trigger struct {
	ID                     string                        `json:"id,omitempty"`
	TenantID               string                        `json:"tenant_id,omitempty"`
	ConnectionID           string                        `json:"connection_id,omitempty"`
	JourneyID              string                        `json:"journey_id,omitempty"`
	Name                   string                        `json:"name"`
	Description            string                        `json:"description,omitempty"`
	Status                 string                        `json:"status"`
	Provider               string                        `json:"provider"`
	Query                  string                        `json:"query"`
	CursorColumn           string                        `json:"cursor_column"`
	ProfileKeyColumn       string                        `json:"profile_key_column"`
	LastSeenCursor         string                        `json:"last_seen_cursor,omitempty"`
	PollingIntervalSeconds int                           `json:"polling_interval_seconds"`
	MaxRowsPerTick         int                           `json:"max_rows_per_tick"`
	LastPolledAt           *time.Time                    `json:"last_polled_at,omitempty"`
	LastSuccessAt          *time.Time                    `json:"last_success_at,omitempty"`
	LastError              string                        `json:"last_error,omitempty"`
	ConsecutiveFailures    int                           `json:"consecutive_failures"`
	RowsFiredTotal         int64                         `json:"rows_fired_total"`
	Config                 map[string]any                `json:"config,omitempty"`
	CreatedAt              time.Time                     `json:"created_at,omitempty"`
	UpdatedAt              time.Time                     `json:"updated_at,omitempty"`
	Runtime                *runtimecapability.Descriptor `json:"runtime,omitempty"`
}

// Fire is the JSON shape of an external_warehouse_trigger_fires row.
type Fire struct {
	ID           int64          `json:"id"`
	TenantID     string         `json:"tenant_id,omitempty"`
	TriggerID    string         `json:"trigger_id"`
	FlowRunID    string         `json:"flow_run_id,omitempty"`
	CursorValue  string         `json:"cursor_value,omitempty"`
	ProfileKey   string         `json:"profile_key,omitempty"`
	SubscriberID string         `json:"subscriber_id,omitempty"`
	Payload      map[string]any `json:"payload,omitempty"`
	Status       string         `json:"status"`
	Error        string         `json:"error,omitempty"`
	FiredAt      time.Time      `json:"fired_at"`
}

// FireView is the read-safe execution-history shape. Raw warehouse cursor and
// profile values, payloads, subscriber/run identifiers, and error strings can
// contain customer data or provider internals and never cross the reports API.
type FireView struct {
	ID            int64     `json:"id"`
	TriggerID     string    `json:"trigger_id"`
	Status        string    `json:"status"`
	FiredAt       time.Time `json:"fired_at"`
	HasCursor     bool      `json:"has_cursor"`
	HasProfileKey bool      `json:"has_profile_key"`
	HasSubscriber bool      `json:"has_subscriber"`
	HasPayload    bool      `json:"has_payload"`
	HasFlowRun    bool      `json:"has_flow_run"`
	ErrorCategory string    `json:"error_category,omitempty"`
}

// ValidationResult is the canonical /validate response shape used
// across other Moosewave control planes (warehouse, segments, …).
type ValidationResult struct {
	Valid    bool                         `json:"valid"`
	Errors   []string                     `json:"errors,omitempty"`
	Warnings []string                     `json:"warnings,omitempty"`
	Runtime  runtimecapability.Descriptor `json:"runtime"`
}

// ErrNotFound is the package-level not-found sentinel.
var ErrNotFound = errors.New("zerocopy_triggers: not found")

// ErrZeroCopyRuntimeUnavailable is returned by non-HTTP execution seams while
// the runtime is release-contained. Callers must not translate it into a
// successful no-op or a retryable queue acknowledgment.
var ErrZeroCopyRuntimeUnavailable = errors.New("zerocopy_triggers: runtime unavailable")

// Repo persists triggers + fires. The pool is shared with the
// rest of the API; tenant binding is done via db.WithTenant.
type Repo struct {
	Pool *db.Pool
	// Alerts + Notifier, when set, make RecordTick evaluate the trigger's
	// alert thresholds after each tick and fire when breached. nil disables
	// alerting (the thresholds were previously stored but never evaluated).
	Alerts   *AlertRepo
	Notifier AlertNotifier
}

// Deps is the public HTTP entrypoint. Enqueuer is the seam the worker
// uses to enroll subscribers; production wiring passes flowbuilder.Repo.
//
// AlertRepo / DLQRepo back the alerts + dead-letter controls added in
// migration 0345. Read handlers return 503 when either store is absent,
// so incomplete wiring cannot look like a healthy empty result.
type Deps struct {
	Repo      *Repo
	Enqueuer  FlowRunEnqueuer
	AlertRepo *AlertRepo
	DLQRepo   *DLQRepo
	// ConsentGate is required by production composition for both the worker
	// and the synchronous Poll-now path. Sharing the gate prevents an admin
	// test poll from bypassing the activation firewall.
	ConsentGate ConsentGate
	// Logger is used by httperror.WriteInternal to record server-side
	// detail for 5xx responses without echoing err.Error() back to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes wires the control-plane HTTP API.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	// Trigger definitions contain warehouse SQL, connection references, and
	// provider configuration. Inspection is therefore an admin control-plane
	// operation, not a general reports read.
	r.With(admin).Get("/api/v1/zero-copy-triggers", d.List)
	r.With(admin).Post("/api/v1/zero-copy-triggers", d.Create)
	r.With(admin).Get("/api/v1/zero-copy-triggers/{id}", d.Get)
	r.With(admin).Put("/api/v1/zero-copy-triggers/{id}", d.Update)
	r.With(admin).Delete("/api/v1/zero-copy-triggers/{id}", d.Delete)
	r.With(admin).Post("/api/v1/zero-copy-triggers/{id}/poll", d.PollNow)
	r.With(read).Get("/api/v1/zero-copy-triggers/{id}/fires", d.ListFires)
	r.With(admin).Post("/api/v1/zero-copy-triggers/validate", d.Validate)
	// Alerts + DLQ surfaces (migration 0345 scaffold).
	r.With(read).Get("/api/v1/zero-copy-triggers/{id}/alerts", d.GetAlerts)
	r.With(admin).Put("/api/v1/zero-copy-triggers/{id}/alerts", d.PutAlerts)
	r.With(read).Get("/api/v1/zero-copy-triggers/{id}/dlq", d.ListDLQ)
	r.With(admin).Post("/api/v1/zero-copy-triggers/{id}/dlq/{entry_id}/retry", d.RetryDLQ)
}

func (d *Deps) Validate(w http.ResponseWriter, r *http.Request) {
	var in Trigger
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	writeJSON(w, http.StatusOK, ValidateTrigger(in))
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 500
	// so omitting ?limit= returns the same count as before (no regression).
	// PRIOR_CAP (500) > MaxLimit so it is also the ceiling — the default
	// must not be clamped below the pre-pagination behavior.
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 500, 500)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.Repo.List(r.Context(), tenantID, r.URL.Query().Get("status"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for i := range out {
		annotateRuntime(&out[i])
	}
	// Envelope serializes as {"items":[...], "nextCursor"?} — additive over
	// the prior {"items":[...]} shape (nextCursor omitted on the last page).
	writeJSON(w, http.StatusOK, pagination.Envelope[Trigger]{Items: out, NextCursor: next})
}

func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Trigger
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if requestsActiveRuntime(in) {
		runtimecapability.WriteUnavailable(w, zeroCopyControlPlaneDescriptor())
		return
	}
	if v := ValidateTrigger(in); !v.Valid {
		writeJSON(w, http.StatusBadRequest, v)
		return
	}
	out, err := d.Repo.Create(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	annotateRuntime(out)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	// A path segment that is not a UUID is a CLIENT mistake. Unguarded it
	// reaches Postgres, returns `invalid input syntax for type uuid`, and is
	// mapped to 500 — presenting a bad request as a server fault. It also
	// hides route shadowing: GET /api/v1/zero-copy-triggers/validate lands here with
	// id="validate" and reports a 500 for what is really "you wanted POST".
	if _, err := uuid.Parse(id); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "id must be a UUID"))
		return
	}
	out, err := d.Repo.Get(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	annotateRuntime(out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Trigger
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.ID = chi.URLParam(r, "id")
	if requestsActiveRuntime(in) {
		runtimecapability.WriteUnavailable(w, zeroCopyControlPlaneDescriptor())
		return
	}
	if v := ValidateTrigger(in); !v.Valid {
		writeJSON(w, http.StatusBadRequest, v)
		return
	}
	out, err := d.Repo.Update(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	annotateRuntime(out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if err := d.Repo.Delete(r.Context(), tenantID, chi.URLParam(r, "id")); err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PollNow is retained as an authenticated compatibility boundary. It is
// deliberately unavailable until polling has distributed ownership; it must
// not query a warehouse or advance a cursor in the contained state.
func (d *Deps) PollNow(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantID(r); !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	runtimecapability.WriteUnavailable(w, zeroCopyControlPlaneDescriptor())
}

func (d *Deps) ListFires(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// `?indeterminate=1` narrows to receipts whose enqueue outcome could not be
	// established — a poller stopped between EnqueueRun and its receipt, and
	// flow_runs has no idempotency key, so neither retry nor discard is safe
	// without checking the journey. They already appear in the unfiltered
	// ledger, but "go read every fire row and grep the error column" is not a
	// triage surface, and without one "escalated for a human" is a claim about
	// a log line. Added to the EXISTING route rather than a new one: route
	// registration here is manifest-gated, and a query parameter is the smaller
	// contract change.
	var (
		out []Fire
		err error
	)
	if r.URL.Query().Get("indeterminate") == "1" {
		out, err = d.Repo.ListIndeterminate(r.Context(), tenantID, 100)
	} else {
		out, err = d.Repo.ListFires(r.Context(), tenantID, chi.URLParam(r, "id"), 100)
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	items := make([]FireView, 0, len(out))
	for _, fire := range out {
		items = append(items, fireView(fire))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func fireView(in Fire) FireView {
	category := ""
	if strings.TrimSpace(in.Error) != "" {
		category = "execution_error"
	}
	return FireView{
		ID:            in.ID,
		TriggerID:     in.TriggerID,
		Status:        in.Status,
		FiredAt:       in.FiredAt,
		HasCursor:     strings.TrimSpace(in.CursorValue) != "",
		HasProfileKey: strings.TrimSpace(in.ProfileKey) != "",
		HasSubscriber: strings.TrimSpace(in.SubscriberID) != "",
		HasPayload:    len(in.Payload) > 0,
		HasFlowRun:    strings.TrimSpace(in.FlowRunID) != "",
		ErrorCategory: category,
	}
}

// ValidateTrigger enforces shape + business rules before insert/update.
func ValidateTrigger(in Trigger) ValidationResult {
	normalizeTrigger(&in)
	out := ValidationResult{Valid: true, Runtime: zeroCopyRuntimeDescriptor()}
	if in.Name == "" {
		out.Errors = append(out.Errors, "name is required")
	}
	if !isOptionalCanonicalUUID(in.ConnectionID) {
		out.Errors = append(out.Errors, "connection_id must be a canonical UUID when provided")
	}
	if !isOptionalCanonicalUUID(in.JourneyID) {
		out.Errors = append(out.Errors, "journey_id must be a canonical UUID when provided")
	}
	if !allowed(in.Provider, []string{"snowflake", "bigquery", "redshift", "postgres"}) {
		out.Errors = append(out.Errors, "provider must be snowflake, bigquery, redshift, or postgres")
	}
	if !allowed(in.Status, []string{"draft", "active", "paused", "error"}) {
		out.Errors = append(out.Errors, "status must be draft, active, paused, or error")
	}
	if in.PollingIntervalSeconds < 15 || in.PollingIntervalSeconds > 86400 {
		out.Errors = append(out.Errors, "polling_interval_seconds must be between 15 and 86400")
	}
	if in.MaxRowsPerTick < 1 || in.MaxRowsPerTick > hardMaxRowsPerPoll {
		out.Errors = append(out.Errors, "max_rows_per_tick must be between 1 and 1000")
	}
	if in.Status == "active" && strings.TrimSpace(in.Query) == "" {
		out.Errors = append(out.Errors, "query is required for active triggers")
	}
	if strings.TrimSpace(in.Query) != "" {
		if err := validateReadOnlyQuery(in.Query); err != nil {
			out.Errors = append(out.Errors, "query must be one supported read-only SELECT/CTE statement: "+err.Error())
		}
	}
	if in.Status == "active" && strings.TrimSpace(in.CursorColumn) == "" {
		out.Errors = append(out.Errors, "cursor_column is required for active triggers")
	}
	if in.Status == "active" && in.JourneyID == "" {
		out.Errors = append(out.Errors, "journey_id is required for active triggers")
	} else if in.JourneyID == "" {
		out.Warnings = append(out.Warnings, "journey_id is empty — draft poll results will not enqueue a journey")
	}
	if in.Status == "active" {
		out.Warnings = append(out.Warnings, "active trigger execution is currently unavailable; save the trigger as draft or paused")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func requestsActiveRuntime(in Trigger) bool {
	normalizeTrigger(&in)
	return in.Status == "active"
}

func annotateRuntime(in *Trigger) {
	if in == nil {
		return
	}
	runtime := zeroCopyRuntimeDescriptor()
	in.Runtime = &runtime
}

func normalizeTrigger(in *Trigger) {
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.Provider = defaulted(strings.TrimSpace(strings.ToLower(in.Provider)), "snowflake")
	in.Query = strings.TrimSpace(in.Query)
	in.CursorColumn = defaulted(strings.TrimSpace(in.CursorColumn), "updated_at")
	in.ProfileKeyColumn = defaulted(strings.TrimSpace(in.ProfileKeyColumn), "email")
	in.LastSeenCursor = strings.TrimSpace(in.LastSeenCursor)
	if in.PollingIntervalSeconds == 0 {
		in.PollingIntervalSeconds = 60
	}
	if in.MaxRowsPerTick == 0 {
		in.MaxRowsPerTick = defaultMaxRowsPerTick
	}
	if in.Config == nil {
		in.Config = map[string]any{}
	}
}

func allowed(value string, candidates []string) bool {
	for _, c := range candidates {
		if value == c {
			return true
		}
	}
	return false
}

func isOptionalCanonicalUUID(value string) bool {
	if value == "" {
		return true
	}
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func defaulted(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
