package warehouse

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Storage interface {
	Put(ctx context.Context, tenantID, rest, contentType string, body io.Reader) (string, error)
	Get(ctx context.Context, tenantID, rest string) (io.ReadCloser, string, error)
	List(ctx context.Context, tenantID, prefix, cursor string, limit int) ([]string, string, error)
	PresignGet(ctx context.Context, tenantID, rest string, ttl time.Duration) (string, error)
}

type Deps struct {
	Repo    *Repo
	Storage Storage
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

type Repo struct {
	Pool              *db.Pool
	SnowflakeExecutor SnowflakeJobExecutor
}

type Connection struct {
	ID                   string         `json:"id,omitempty"`
	TenantID             string         `json:"tenant_id,omitempty"`
	Name                 string         `json:"name"`
	Provider             string         `json:"provider"`
	Direction            string         `json:"direction"`
	Status               string         `json:"status"`
	CredentialsRef       string         `json:"credentials_ref,omitempty"`
	CredentialRefPresent bool           `json:"credential_ref_present"`
	Config               map[string]any `json:"config,omitempty"`
	ObjectSelection      []string       `json:"object_selection"`
	Cadence              string         `json:"cadence"`
	BackfillDays         int            `json:"backfill_days"`
	LastCursor           string         `json:"last_cursor,omitempty"`
	Error                string         `json:"error,omitempty"`
	IssuePresent         bool           `json:"issue_present"`
	Version              int64          `json:"version"`
	CreatedAt            time.Time      `json:"created_at,omitempty"`
	UpdatedAt            time.Time      `json:"updated_at,omitempty"`
}

type SyncRun struct {
	ID              string         `json:"id"`
	TenantID        string         `json:"tenant_id,omitempty"`
	ConnectionID    string         `json:"connection_id,omitempty"`
	Direction       string         `json:"direction"`
	RunMode         string         `json:"run_mode"`
	Status          string         `json:"status"`
	ObjectSelection []string       `json:"object_selection"`
	InputURI        string         `json:"input_uri,omitempty"`
	OutputURI       string         `json:"output_uri,omitempty"`
	CursorFrom      string         `json:"cursor_from,omitempty"`
	CursorTo        string         `json:"cursor_to,omitempty"`
	RowsScanned     int64          `json:"rows_scanned"`
	RowsExported    int64          `json:"rows_exported"`
	RowsImported    int64          `json:"rows_imported"`
	RowsFailed      int64          `json:"rows_failed"`
	SchemaErrors    int64          `json:"schema_errors"`
	RetryCount      int            `json:"retry_count"`
	Metrics         map[string]any `json:"metrics,omitempty"`
	Error           string         `json:"error,omitempty"`
	IssuePresent    bool           `json:"issue_present"`
	StartedAt       *time.Time     `json:"started_at,omitempty"`
	CompletedAt     *time.Time     `json:"completed_at,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

type ImportMapping struct {
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	ConnectionID     string         `json:"connection_id,omitempty"`
	SourceObject     string         `json:"source_object"`
	TargetEventName  string         `json:"target_event_name"`
	ProfileKeyColumn string         `json:"profile_key_column"`
	OccurredAtColumn string         `json:"occurred_at_column"`
	PropertyMap      map[string]any `json:"property_map,omitempty"`
	ValidationRules  map[string]any `json:"validation_rules,omitempty"`
	Status           string         `json:"status"`
	Version          int64          `json:"version"`
	ExpectedVersion  int64          `json:"expected_version,omitempty"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
	UpdatedAt        time.Time      `json:"updated_at,omitempty"`
}

type ImportRow struct {
	SourceObject string         `json:"source_object,omitempty"`
	SubscriberID string         `json:"subscriber_id,omitempty"`
	Email        string         `json:"email,omitempty"`
	EventName    string         `json:"event_name,omitempty"`
	OccurredAt   *time.Time     `json:"occurred_at,omitempty"`
	Properties   map[string]any `json:"properties,omitempty"`
	Raw          map[string]any `json:"raw,omitempty"`
}

type RunInput struct {
	Direction                 string      `json:"direction,omitempty"`
	RunMode                   string      `json:"run_mode,omitempty"`
	ObjectSelection           []string    `json:"object_selection,omitempty"`
	InputURI                  string      `json:"input_uri,omitempty"`
	ImportRows                []ImportRow `json:"import_rows,omitempty"`
	ExpectedConnectionVersion int64       `json:"expected_connection_version"`
}

type RowError struct {
	ID           int64          `json:"id"`
	RunID        string         `json:"run_id"`
	SourceObject string         `json:"source_object"`
	RowNumber    int64          `json:"row_number"`
	ErrorCode    string         `json:"error_code"`
	ErrorMessage string         `json:"error_message"`
	RawRow       map[string]any `json:"raw_row,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
}

type RowErrorEvidence struct {
	ID             int64     `json:"id"`
	RunID          string    `json:"run_id"`
	SourceObject   string    `json:"source_object"`
	RowNumber      int64     `json:"row_number"`
	ErrorCode      string    `json:"error_code"`
	MessagePresent bool      `json:"message_present"`
	CreatedAt      time.Time `json:"created_at"`
}

type ValidationResult struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

type ConnectionHealth struct {
	ConnectionID             string               `json:"connection_id"`
	Provider                 string               `json:"provider"`
	Status                   string               `json:"status"`
	Health                   string               `json:"health"`
	LastRunStatus            string               `json:"last_run_status,omitempty"`
	LastRunAt                *time.Time           `json:"last_run_at,omitempty"`
	Error                    string               `json:"error,omitempty"`
	IssuePresent             bool                 `json:"issue_present"`
	MissingRequiredSettings  []string             `json:"missing_required_settings,omitempty"`
	Warnings                 []string             `json:"warnings,omitempty"`
	WarningCount             int                  `json:"warning_count"`
	ProviderRuntimeStatus    string               `json:"provider_runtime_status,omitempty"`
	ProviderDriverAttachment string               `json:"provider_driver_attachment,omitempty"`
	ProviderHealth           *ProviderHealthCheck `json:"provider_health,omitempty"`
}

type ProviderHealthCheck struct {
	Provider                string                          `json:"provider"`
	State                   string                          `json:"state"`
	LiveState               string                          `json:"live_state,omitempty"`
	ExecutionMode           string                          `json:"execution_mode,omitempty"`
	Message                 string                          `json:"message,omitempty"`
	Executable              bool                            `json:"executable"`
	MissingRequiredSettings []string                        `json:"missing_required_settings,omitempty"`
	Statements              []SnowflakeProviderJobStatement `json:"statements,omitempty"`
	StatementsExecuted      int                             `json:"statements_executed,omitempty"`
	Warnings                []string                        `json:"warnings,omitempty"`
	WarningCount            int                             `json:"warning_count"`
	Error                   string                          `json:"error,omitempty"`
	IssuePresent            bool                            `json:"issue_present"`
}

const warehouseLifecycleJSONMaxBodyBytes int64 = 16 << 10

var ErrNotFound = errors.New("warehouse: not found")
var ErrStale = errors.New("warehouse: stale version")
var ErrProviderCleanupMissing = errors.New("warehouse: provider cleanup evidence missing")

type ConnectionMutationInput struct {
	ExpectedVersion int64 `json:"expected_version"`
}

type ConnectionDeleteInput struct {
	ExpectedVersion  int64  `json:"expected_version"`
	ConfirmationName string `json:"confirmation_name"`
}

type ConnectionDeleteReceipt struct {
	OK              bool   `json:"ok"`
	ID              string `json:"id"`
	PreviousVersion int64  `json:"previous_version"`
	Version         int64  `json:"version"`
	Status          string `json:"status"`
}

type ProviderCleanupAcknowledgementInput struct {
	CompletedActions []string `json:"completed_actions,omitempty"`
	Notes            string   `json:"notes,omitempty"`
	AcknowledgedBy   string   `json:"acknowledged_by,omitempty"`
	ExpectedVersion  int64    `json:"expected_version"`
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/warehouse/catalog", d.Catalog)
	r.With(read).Get("/api/v1/warehouse/providers", d.ListProviders)
	r.With(admin).Post("/api/v1/warehouse/validate", d.Validate)
	r.With(read).Get("/api/v1/warehouse/connections", d.ListConnections)
	r.With(admin).Post("/api/v1/warehouse/connections", d.CreateConnection)
	r.With(read).Get("/api/v1/warehouse/connections/{id}", d.GetConnection)
	r.With(read).Get("/api/v1/warehouse/connections/{id}/health", d.ConnectionHealth)
	r.With(read).Get("/api/v1/warehouse/connections/{id}/runs", d.ListConnectionRuns)
	r.With(read).Get("/api/v1/warehouse/connections/{id}/mappings", d.ListMappings)
	r.With(admin).Put("/api/v1/warehouse/connections/{id}/mappings/{source_object}", d.PutMapping)
	r.With(admin).Post("/api/v1/warehouse/connections/{id}/runs", d.RunConnection)
	r.With(admin).Post("/api/v1/warehouse/connections/{id}/pause", d.PauseConnection)
	r.With(admin).Delete("/api/v1/warehouse/connections/{id}", d.DeleteConnection)
	r.With(admin).Post("/api/v1/warehouse/connections/{id}/provider-cleanup/acknowledge", d.AcknowledgeProviderCleanup)
	r.With(admin).Post("/api/v1/warehouse/runs/due", d.RunDueConnections)
	r.With(read).Get("/api/v1/warehouse/runs", d.ListRuns)
	r.With(read).Get("/api/v1/warehouse/runs/{id}", d.GetRun)
	r.With(admin).Get("/api/v1/warehouse/runs/{id}/errors", d.ListRunErrors)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": "klv08.warehouse.v1",
		"providers":      catalogProviders(),
		"directions":     []string{"export", "import", "bidirectional"},
		"cadences":       []string{"manual", "hourly", "daily", "weekly"},
		"objects": []map[string]string{
			{"key": "profiles", "label": "Profiles", "runtime_status": "supported"},
			{"key": "events", "label": "Events", "runtime_status": "supported"},
			{"key": "metrics", "label": "Metric aggregates", "runtime_status": "supported"},
			{"key": "campaigns", "label": "Campaigns", "runtime_status": "supported"},
			{"key": "flows", "label": "Flows / automations", "runtime_status": "partial"},
			{"key": "forms", "label": "Forms", "runtime_status": "supported"},
			{"key": "catalog", "label": "Commerce catalog", "runtime_status": "partial"},
			{"key": "custom_objects", "label": "Custom objects", "runtime_status": "partial"},
			{"key": "reviews", "label": "Reviews", "runtime_status": "planned"},
		},
		"import_targets": []map[string]string{
			{"key": "product_events", "label": "Product/event stream", "runtime_status": "supported"},
			{"key": "profiles", "label": "Profile properties", "runtime_status": "planned"},
			{"key": "custom_objects", "label": "Custom objects", "runtime_status": "planned"},
		},
		"workers": []map[string]string{
			{"key": "scheduled_s3_export", "label": "Scheduled S3 export worker", "runtime_status": "supported"},
			{"key": "warehouse_import_polling", "label": "Warehouse import polling", "runtime_status": "supported"},
		},
	})
}

func (d *Deps) ListProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": ProviderSpecs()})
}

func (d *Deps) Validate(w http.ResponseWriter, r *http.Request) {
	var in Connection
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	writeJSON(w, http.StatusOK, ValidateConnection(in))
}

func (d *Deps) ListConnections(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListConnections(r.Context(), tenantID, r.URL.Query().Get("status"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": sanitizeConnections(out)})
}

func (d *Deps) CreateConnection(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Connection
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if validation := ValidateConnection(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.CreateConnection(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, sanitizeConnection(out))
}

func (d *Deps) GetConnection(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	out, err := d.Repo.GetConnection(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sanitizeConnection(out))
}

func (d *Deps) ConnectionHealth(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	conn, err := d.Repo.GetConnection(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	runs, err := d.Repo.ListRuns(r.Context(), tenantID, conn.ID, 1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	health := healthForConnection(*conn, runs)
	if conn.Provider == ProviderSnowflake {
		health.ProviderHealth = snowflakeConnectionHealthCheck(r.Context(), *conn, d.Repo.SnowflakeExecutor, queryBool(r, "provider_check"))
	}
	writeJSON(w, http.StatusOK, sanitizeConnectionHealth(health))
}

func (d *Deps) ListMappings(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	out, err := d.Repo.ListMappings(r.Context(), tenantID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) PutMapping(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var in ImportMapping
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.SourceObject = chi.URLParam(r, "source_object")
	out, err := d.Repo.UpsertMapping(r.Context(), tenantID, id, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RunConnection(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var in RunInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, httpbody.DefaultJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return

		}
	}
	out, err := d.Repo.RunConnection(r.Context(), tenantID, id, in, d.Storage)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, sanitizeSyncRun(out))
}

func (d *Deps) RunDueConnections(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.RunDueConnections(r.Context(), tenantID, time.Now().UTC(), queryInt(r, "limit", 10), d.Storage)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"items": sanitizeSyncRuns(out), "count": len(out)})
}

func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListRuns(r.Context(), tenantID, chi.URLParam(r, "id"), queryLimit(r, "limit", 25, 500))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": sanitizeSyncRuns(out)})
}

func (d *Deps) ListConnectionRuns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	connectionID, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	if _, err := d.Repo.GetConnection(r.Context(), tenantID, connectionID); err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	out, err := d.Repo.ListRuns(r.Context(), tenantID, connectionID, queryLimit(r, "limit", 25, 500))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": sanitizeSyncRuns(out)})
}

func (d *Deps) GetRun(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	// A path segment that is not a UUID is a CLIENT mistake. Unguarded it
	// reaches Postgres, returns `invalid input syntax for type uuid`, and is
	// mapped to 500 — presenting a bad request as a server fault. It also
	// hides route shadowing: GET /api/v1/warehouse/runs/due lands here with
	// id="due" and reports a 500 for what is really "you wanted POST".
	if !ok {
		return
	}
	out, err := d.Repo.GetRun(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sanitizeSyncRun(out))
}

func (d *Deps) ListRunErrors(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	out, err := d.Repo.ListRunErrors(r.Context(), tenantID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	evidence := make([]RowErrorEvidence, 0, len(out))
	for _, item := range out {
		evidence = append(evidence, RowErrorEvidence{
			ID: item.ID, RunID: item.RunID, SourceObject: item.SourceObject,
			RowNumber: item.RowNumber, ErrorCode: item.ErrorCode,
			MessagePresent: strings.TrimSpace(item.ErrorMessage) != "", CreatedAt: item.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": evidence})
}

func (d *Deps) PauseConnection(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var in ConnectionMutationInput
	if err := httpbody.DecodeJSON(w, r, warehouseLifecycleJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	out, err := d.Repo.SetConnectionStatus(r.Context(), tenantID, id, "paused", in.ExpectedVersion)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sanitizeConnection(out))
}

func (d *Deps) DeleteConnection(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var in ConnectionDeleteInput
	if err := httpbody.DecodeJSON(w, r, warehouseLifecycleJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	receipt, err := d.Repo.DeleteConnection(r.Context(), tenantID, id, in.ExpectedVersion, in.ConfirmationName)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, receipt)
}

func (d *Deps) AcknowledgeProviderCleanup(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := warehouseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var in ProviderCleanupAcknowledgementInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.AcknowledgedBy = warehouseProviderCleanupAcknowledgedBy(r.Context(), in.AcknowledgedBy)
	normalized, err := normalizeWarehouseProviderCleanupAcknowledgementInput(in)
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.AcknowledgeProviderCleanup(r.Context(), tenantID, id, normalized, time.Now().UTC())
	if err != nil {
		if errors.Is(err, ErrProviderCleanupMissing) {
			httperror.Write(w, http.StatusConflict, "provider_cleanup_missing", "provider cleanup evidence has not been recorded for this warehouse connection")
			return
		}
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"id":               out.ID,
		"previous_version": in.ExpectedVersion,
		"version":          out.Version,
	})
}

func ValidateConnection(in Connection) ValidationResult {
	normalizeConnection(&in)
	out := ValidationResult{Valid: true}
	if in.Name == "" {
		out.Errors = append(out.Errors, "name is required")
	}
	if !allowed(in.Provider, allWarehouseProviders()) {
		out.Errors = append(out.Errors, "provider must be s3, r2, redshift, bigquery, databricks, azure_blob, snowflake, postgres, or streaming_export")
	}
	if !allowed(in.Direction, []string{"export", "import", "bidirectional"}) {
		out.Errors = append(out.Errors, "direction must be export, import, or bidirectional")
	}
	if !allowed(in.Status, []string{"draft", "active", "paused", "error"}) {
		out.Errors = append(out.Errors, "status must be draft, active, paused, or error")
	}
	if !allowed(in.Cadence, []string{"manual", "hourly", "daily", "weekly"}) {
		out.Errors = append(out.Errors, "cadence must be manual, hourly, daily, or weekly")
	}
	if in.BackfillDays < 1 || in.BackfillDays > 3650 {
		out.Errors = append(out.Errors, "backfill_days must be between 1 and 3650")
	}
	for _, object := range in.ObjectSelection {
		if !supportedObject(object) {
			out.Errors = append(out.Errors, "unsupported object: "+object)
		}
	}
	if raw := rawCredentialConfigKey(in.Config); raw != "" {
		out.Errors = append(out.Errors, "raw credential config is not accepted: "+raw)
	}
	if in.CredentialsRef != "" && looksLikeRawCredentialRef(in.CredentialsRef) {
		out.Errors = append(out.Errors, "credentials_ref looks like raw credential material")
	}
	if key := disallowedEndpointOverrideKey(in); key != "" {
		out.Errors = append(out.Errors, key+" is not accepted in public warehouse config; provider endpoints are derived by trusted drivers")
	}
	if err := providerAddressConfigError(in); err != "" {
		out.Errors = append(out.Errors, err)
	}
	missing := missingRequiredSettings(in)
	if spec, ok := ProviderSpecByKey(in.Provider); ok {
		if in.Status == "active" && len(missing) > 0 {
			out.Errors = append(out.Errors, "missing required provider settings: "+strings.Join(missing, ", "))
		}
		if spec.RuntimeStatus == "planned" && in.Status == "active" {
			out.Errors = append(out.Errors, in.Provider+" is planned and cannot be activated until its provider driver ships")
		}
		if objectStorageProvider(in.Provider) {
			out.Warnings = append(out.Warnings, "object-storage runs use Moosewave's configured storage adapter; per-connection bucket fields are readiness metadata until a tenant bucket driver attaches")
		}
		if spec.RuntimeStatus == "planned" {
			out.Warnings = append(out.Warnings, in.Provider+" remains catalog-visible but is not executable yet")
		}
	}
	if managedSQLWarehouseProvider(in.Provider) {
		out.Warnings = append(out.Warnings, "managed SQL warehouse runs record auditable manifests until the provider driver worker is attached")
	}
	if in.Provider == ProviderAzureBlob {
		out.Warnings = append(out.Warnings, "azure_blob remains catalog-visible; S3/R2 use the workspace storage adapter and SQL warehouse providers use the manifest worker until dedicated drivers attach")
	}
	if in.Provider == ProviderStreamingExport {
		out.Errors = append(out.Errors, validateStreamingWarehouseConnection(in)...)
		out.Warnings = append(out.Warnings, "streaming exports use the tenant-bound Moosewave object store; external bucket overrides and raw destination credentials are not accepted")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func validateStreamingWarehouseConnection(in Connection) []string {
	errorsOut := []string{}
	if in.Direction != "export" {
		errorsOut = append(errorsOut, "streaming_export direction must be export")
	}
	if in.Cadence != "hourly" {
		errorsOut = append(errorsOut, "streaming_export cadence must be hourly")
	}
	if in.CredentialsRef != "" {
		errorsOut = append(errorsOut, "streaming_export uses workspace storage and does not accept credentials_ref")
	}
	allowedConfig := map[string]bool{
		"format": true, "compression": true, "batch_size": true,
		"prefix": true, "field_filters": true, "managed_by_postwave": true,
		"provider_status": true, "setup_surface": true,
	}
	for key := range in.Config {
		if !allowedConfig[key] {
			errorsOut = append(errorsOut, "unsupported streaming config field: "+key)
		}
	}
	format := strings.ToLower(configString(in.Config, "format"))
	if format != "" && !allowed(format, []string{"parquet", "avro"}) {
		errorsOut = append(errorsOut, "streaming format must be parquet or avro")
	}
	compression := strings.ToLower(configString(in.Config, "compression"))
	if compression != "" && !allowed(compression, []string{"none", "snappy", "gzip", "zstd"}) {
		errorsOut = append(errorsOut, "streaming compression must be none, snappy, gzip, or zstd")
	}
	if raw, ok := in.Config["batch_size"]; ok {
		valid := false
		switch value := raw.(type) {
		case float64:
			valid = value == float64(int(value)) && value >= 100 && value <= 1_000_000
		case int:
			valid = value >= 100 && value <= 1_000_000
		case int64:
			valid = value >= 100 && value <= 1_000_000
		}
		if !valid {
			errorsOut = append(errorsOut, "streaming batch_size must be an integer between 100 and 1000000")
		}
	}
	if prefix, ok := in.Config["prefix"].(string); ok {
		prefix = strings.Trim(strings.TrimSpace(prefix), "/")
		if len(prefix) > 256 || strings.Contains(prefix, "..") || strings.ContainsAny(prefix, "\\\x00\r\n") {
			errorsOut = append(errorsOut, "streaming prefix must be a relative, control-free object prefix of at most 256 characters")
		}
	} else if _, present := in.Config["prefix"]; present {
		errorsOut = append(errorsOut, "streaming prefix must be a string")
	}
	for _, object := range in.ObjectSelection {
		if !allowed(object, []string{"events", "profiles"}) {
			errorsOut = append(errorsOut, "streaming_export supports only events and profiles")
			break
		}
	}
	return errorsOut
}

func normalizeConnection(in *Connection) {
	in.Name = strings.TrimSpace(in.Name)
	in.Provider = defaulted(strings.ToLower(strings.TrimSpace(in.Provider)), "s3")
	in.Direction = defaulted(strings.TrimSpace(in.Direction), "export")
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.CredentialsRef = strings.TrimSpace(in.CredentialsRef)
	in.Cadence = defaulted(strings.TrimSpace(in.Cadence), "manual")
	if in.BackfillDays == 0 {
		in.BackfillDays = 90
	}
	if len(in.ObjectSelection) == 0 {
		in.ObjectSelection = []string{"profiles", "events", "campaigns"}
	}
	in.ObjectSelection = normalizeObjects(in.ObjectSelection)
	if in.Config == nil {
		in.Config = map[string]any{}
	}
	if in.CredentialsRef == "" {
		in.CredentialsRef = firstNonEmpty(configString(in.Config, "credentials_ref"), configString(in.Config, "credential_ref"))
	}
	if in.CredentialsRef != "" {
		in.Config["credentials_ref"] = in.CredentialsRef
		delete(in.Config, "credential_ref")
	}
	delete(in.Config, "provider_cleanup")
	if _, ok := in.Config["managed_by_postwave"]; !ok {
		in.Config["managed_by_postwave"] = true
	}
	if spec, ok := ProviderSpecByKey(in.Provider); ok {
		in.Config["provider_status"] = spec.RuntimeStatus
	}
	in.Config["setup_surface"] = "warehouse"
}

func normalizeMapping(in *ImportMapping) {
	in.SourceObject = strings.TrimSpace(in.SourceObject)
	in.TargetEventName = strings.TrimSpace(in.TargetEventName)
	in.ProfileKeyColumn = defaulted(strings.TrimSpace(in.ProfileKeyColumn), "email")
	in.OccurredAtColumn = defaulted(strings.TrimSpace(in.OccurredAtColumn), "occurred_at")
	in.Status = defaulted(strings.TrimSpace(in.Status), "active")
	if in.PropertyMap == nil {
		in.PropertyMap = map[string]any{}
	}
	if in.ValidationRules == nil {
		in.ValidationRules = map[string]any{}
	}
}

func normalizeRunInput(in *RunInput, conn Connection) {
	in.Direction = strings.TrimSpace(in.Direction)
	if in.Direction == "" {
		if conn.Direction == "import" {
			in.Direction = "import"
		} else {
			in.Direction = "export"
		}
	}
	in.RunMode = strings.ToLower(defaulted(strings.TrimSpace(in.RunMode), "manual"))
	if in.RunMode == "sync" {
		in.RunMode = "manual"
	}
	in.ObjectSelection = normalizeObjects(in.ObjectSelection)
	if len(in.ObjectSelection) == 0 {
		in.ObjectSelection = normalizeObjects(conn.ObjectSelection)
	}
	in.InputURI = strings.TrimSpace(in.InputURI)
}

func warehouseDisconnectCleanupEvidence(conn Connection, recordedAt time.Time) map[string]any {
	scopeType, scopeID := warehouseProviderScope(conn)
	return map[string]any{
		"provider":                 conn.Provider,
		"status":                   "operator_action_required",
		"recorded_at":              recordedAt.UTC(),
		"postwave_status":          "disconnected",
		"provider_cleanup_posture": "operator_managed_provider_console",
		"managed_provider_cleanup": false,
		"provider_scope_type":      scopeType,
		"provider_scope_id":        scopeID,
		"credential_ref_present":   conn.CredentialsRef != "",
		"postwave_effects": []string{
			"local warehouse connection is marked disconnected",
			"ordinary warehouse connection lists exclude disconnected rows unless explicitly filtered",
			"scheduled warehouse runs exclude disconnected rows",
			"manual warehouse runs require active status and reject disconnected rows",
			"warehouse connection, run, mapping, and row-error audit history is retained",
		},
		"provider_console_actions": warehouseProviderConsoleActions(conn),
		"provider_cleanup_evidence": []string{
			"Moosewave recorded row-preserving disconnect cleanup evidence for this warehouse connection",
			"No provider-side warehouse users, roles, grants, stages, tasks, streams, tables, or keys were deleted by this API call",
		},
	}
}

func normalizeWarehouseProviderCleanupAcknowledgementInput(in ProviderCleanupAcknowledgementInput) (ProviderCleanupAcknowledgementInput, error) {
	out := ProviderCleanupAcknowledgementInput{
		Notes:           truncateWarehouseCleanupString(strings.TrimSpace(in.Notes), 2000),
		AcknowledgedBy:  truncateWarehouseCleanupString(strings.TrimSpace(in.AcknowledgedBy), 200),
		ExpectedVersion: in.ExpectedVersion,
	}
	if out.ExpectedVersion < 1 {
		return ProviderCleanupAcknowledgementInput{}, errors.New("expected_version must be a positive integer")
	}
	seen := map[string]bool{}
	for _, action := range in.CompletedActions {
		action = truncateWarehouseCleanupString(strings.ToLower(strings.TrimSpace(action)), 200)
		if action == "" {
			continue
		}
		if !snowflakeProviderCleanupActionKeys[action] {
			return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions contains unsupported Snowflake cleanup action key")
		}
		if seen[action] {
			continue
		}
		seen[action] = true
		out.CompletedActions = append(out.CompletedActions, action)
		if len(out.CompletedActions) >= 20 {
			break
		}
	}
	if len(out.CompletedActions) == 0 && out.Notes == "" {
		return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions or notes is required")
	}
	return out, nil
}

var snowflakeProviderCleanupActionKeys = map[string]bool{
	"snowflake_user_or_key_removed_or_rotated":        true,
	"snowflake_roles_or_grants_removed":               true,
	"snowflake_stage_or_external_integration_removed": true,
	"snowflake_tasks_streams_or_pipes_removed":        true,
	"snowflake_tables_or_import_views_reviewed":       true,
	"provider_console_cleanup_reviewed_no_action_due": true,
}

func warehouseProviderCleanupAcknowledgedBy(ctx context.Context, fallback string) string {
	if u, ok := middleware.UserFromContext(ctx); ok && u != nil {
		if strings.TrimSpace(u.Email) != "" {
			return strings.TrimSpace(u.Email)
		}
		if strings.TrimSpace(u.ID) != "" {
			return strings.TrimSpace(u.ID)
		}
	}
	return strings.TrimSpace(fallback)
}

func truncateWarehouseCleanupString(value string, max int) string {
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[:max]
}

func warehouseProviderScope(conn Connection) (string, string) {
	switch conn.Provider {
	case ProviderSnowflake:
		return "snowflake_account", configString(conn.Config, "account")
	case ProviderBigQuery:
		return "bigquery_project", configString(conn.Config, "project_id")
	case ProviderRedshift:
		return "redshift_cluster_or_workgroup", configString(conn.Config, "cluster_or_workgroup")
	case ProviderDatabricks:
		return "databricks_workspace", firstNonEmpty(configString(conn.Config, "workspace_url"), configString(conn.Config, "host"))
	case ProviderPostgres:
		return "postgres_host", configString(conn.Config, "host")
	case ProviderS3:
		return "s3_bucket", configString(conn.Config, "bucket")
	case ProviderR2:
		return "r2_account_or_bucket", firstNonEmpty(configString(conn.Config, "account_id"), configString(conn.Config, "bucket"))
	default:
		return "warehouse_provider_account", ""
	}
}

func warehouseProviderConsoleActions(conn Connection) []string {
	switch conn.Provider {
	case ProviderSnowflake:
		return []string{
			"review Snowflake users, roles, grants, stages, tasks, streams, tables, and key material created for this Moosewave connection",
			"rotate or revoke the credential referenced by credentials_ref if it is no longer used",
			"remove duplicate or manually created Snowflake stages/tasks that still point at Moosewave export artifacts",
			"record provider-side cleanup evidence in the customer change ticket before considering the warehouse disconnect complete",
		}
	case ProviderBigQuery:
		return []string{
			"review BigQuery service accounts, dataset permissions, scheduled queries, transfer configs, and tables created for this Moosewave connection",
			"rotate or revoke the credential referenced by credentials_ref if it is no longer used",
			"record provider-side cleanup evidence in the customer change ticket before considering the warehouse disconnect complete",
		}
	case ProviderRedshift:
		return []string{
			"review Redshift users, roles, grants, IAM roles, COPY/UNLOAD paths, and tables created for this Moosewave connection",
			"rotate or revoke the credential referenced by credentials_ref if it is no longer used",
			"record provider-side cleanup evidence in the customer change ticket before considering the warehouse disconnect complete",
		}
	default:
		return []string{
			"review provider-side credentials, users, roles, grants, buckets, stages, tables, and scheduled jobs created for this Moosewave warehouse connection",
			"rotate or revoke the credential referenced by credentials_ref if it is no longer used",
			"record provider-side cleanup evidence in the customer change ticket before considering the warehouse disconnect complete",
		}
	}
}

func normalizeObjects(items []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, item := range items {
		item = strings.TrimSpace(strings.ToLower(item))
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func supportedObject(value string) bool {
	return allowed(value, []string{"profiles", "events", "metrics", "campaigns", "flows", "forms", "catalog", "custom_objects", "reviews"})
}

func allowed(value string, candidates []string) bool {
	for _, candidate := range candidates {
		if value == candidate {
			return true
		}
	}
	return false
}

func defaulted(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func queryInt(r *http.Request, key string, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	out := 0
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return fallback
		}
		out = out*10 + int(ch-'0')
		if out > 1000 {
			return fallback
		}
	}
	if out <= 0 {
		return fallback
	}
	return out
}

func queryLimit(r *http.Request, key string, fallback, max int) int {
	out := queryInt(r, key, fallback)
	if max > 0 && out > max {
		return max
	}
	return out
}

func queryBool(r *http.Request, key string) bool {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get(key))) {
	case "1", "true", "t", "yes", "y", "on":
		return true
	default:
		return false
	}
}

func catalogProviders() []map[string]any {
	out := []map[string]any{}
	for _, spec := range ProviderSpecs() {
		out = append(out, map[string]any{
			"key":            spec.Provider,
			"label":          spec.Name,
			"runtime_status": spec.RuntimeStatus,
			"auth_mode":      spec.AuthMode,
			"managed":        spec.Managed,
			"capabilities":   spec.Capabilities,
			"docs_url":       spec.DocsURL,
		})
	}
	return out
}

func healthForConnection(conn Connection, runs []SyncRun) ConnectionHealth {
	health := "healthy"
	if conn.Status == "paused" {
		health = "paused"
	}
	if conn.Status == "disconnected" {
		health = "disconnected"
	}
	if conn.Status == "error" || (conn.Error != "" && conn.Status != "disconnected") {
		health = "error"
	}
	missing := missingRequiredSettings(conn)
	spec, hasSpec := ProviderSpecByKey(conn.Provider)
	if !hasSpec || !spec.Managed || conn.Status != "active" {
		missing = nil
	}
	if len(missing) > 0 {
		health = "needs_attention"
	}
	warnings := ValidateConnection(conn).Warnings
	connectionError := conn.Error
	if conn.Status == "disconnected" {
		connectionError = ""
	}
	out := ConnectionHealth{
		ConnectionID:             conn.ID,
		Provider:                 conn.Provider,
		Status:                   conn.Status,
		Health:                   health,
		Error:                    connectionError,
		MissingRequiredSettings:  missing,
		Warnings:                 warnings,
		ProviderDriverAttachment: "inline",
	}
	if hasSpec {
		out.ProviderRuntimeStatus = spec.RuntimeStatus
		switch spec.RuntimeStatus {
		case "partial":
			out.ProviderDriverAttachment = "manifest_worker"
		case "delegated":
			out.ProviderDriverAttachment = "workspace_storage"
		case "planned":
			out.ProviderDriverAttachment = "planned"
		}
	}
	if len(runs) > 0 {
		latest := runs[0]
		out.LastRunStatus = latest.Status
		out.LastRunAt = &latest.CreatedAt
		if latest.Status == "failed" && conn.Status != "disconnected" {
			out.Health = "error"
			if out.Error == "" {
				out.Error = latest.Error
			}
		}
	}
	return out
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
	if errors.Is(err, ErrDisconnected) {
		httperror.Write(w, http.StatusConflict, "connection_disconnected", "warehouse connection is disconnected; reconnect it before mutating or running it")
		return
	}
	if errors.Is(err, ErrStale) {
		httperror.Write(w, http.StatusPreconditionFailed, "stale_version", "the warehouse resource changed; reload it before retrying")
		return
	}
	if strings.Contains(err.Error(), "validation:") {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

func sanitizeConnections(items []Connection) []Connection {
	out := make([]Connection, 0, len(items))
	for i := range items {
		item := items[i]
		out = append(out, *sanitizeConnection(&item))
	}
	return out
}

// sanitizeSyncRun is the public control-plane projection. Provider targets,
// signed object URLs, cursor payloads, internal execution metrics, and raw
// failure strings remain server-side; operators receive counts plus a stable
// issue flag and can inspect separately redacted row-error evidence.
func sanitizeSyncRun(in *SyncRun) *SyncRun {
	if in == nil {
		return nil
	}
	out := *in
	out.IssuePresent = strings.TrimSpace(in.Error) != ""
	out.InputURI = ""
	out.OutputURI = ""
	out.CursorFrom = ""
	out.CursorTo = ""
	out.Metrics = nil
	out.Error = ""
	return &out
}

func sanitizeSyncRuns(items []SyncRun) []SyncRun {
	out := make([]SyncRun, 0, len(items))
	for i := range items {
		out = append(out, *sanitizeSyncRun(&items[i]))
	}
	return out
}

func sanitizeConnection(in *Connection) *Connection {
	if in == nil {
		return nil
	}
	out := *in
	out.CredentialRefPresent = strings.TrimSpace(in.CredentialsRef) != "" ||
		configString(in.Config, "credentials_ref") != "" || configString(in.Config, "credential_ref") != ""
	out.CredentialsRef = ""
	out.LastCursor = ""
	out.IssuePresent = strings.TrimSpace(in.Error) != ""
	out.Error = ""
	out.Config = make(map[string]any, len(in.Config))
	for key, value := range in.Config {
		normalized := normalizeConfigKey(key)
		switch {
		case normalized == "credentialsref", normalized == "credentialref", normalized == "providercleanup", isRawCredentialKey(key):
			continue
		default:
			out.Config[key] = sanitizeWarehousePublicConfigValue(value, 0)
		}
	}
	return &out
}

func sanitizeWarehousePublicConfigValue(value any, depth int) any {
	if depth > 24 {
		return nil
	}
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, nested := range typed {
			normalized := normalizeConfigKey(key)
			if normalized == "credentialsref" || normalized == "credentialref" || normalized == "providercleanup" || isRawCredentialKey(key) {
				continue
			}
			out[key] = sanitizeWarehousePublicConfigValue(nested, depth+1)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i := range typed {
			out[i] = sanitizeWarehousePublicConfigValue(typed[i], depth+1)
		}
		return out
	default:
		return value
	}
}

func sanitizeConnectionHealth(in ConnectionHealth) ConnectionHealth {
	in.IssuePresent = strings.TrimSpace(in.Error) != ""
	in.Error = ""
	in.WarningCount = len(in.Warnings)
	in.Warnings = nil
	if in.ProviderHealth != nil {
		provider := *in.ProviderHealth
		provider.IssuePresent = strings.TrimSpace(provider.Error) != ""
		provider.Error = ""
		provider.Message = ""
		provider.WarningCount = len(provider.Warnings)
		provider.Warnings = nil
		provider.Statements = nil
		in.ProviderHealth = &provider
	}
	return in
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func warehouseUUIDParam(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, name))
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed.String() != strings.ToLower(raw) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", name+" must be a canonical UUID"))
		return "", false
	}
	return parsed.String(), true
}
