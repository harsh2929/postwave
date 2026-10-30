// SPDX-License-Identifier: AGPL-3.0-only
//
// admin.go — operator-facing CRUD over audit_sinks rows.
//
// Mounted by main.go inside the tenant-resolved + admin-scoped
// router. The worker (auditsink.go) consumes these rows as a
// task queue; operators wire up sinks via these endpoints.
//
// Credential handling: the operator submits credentials as a
// plain map[string]string body (e.g. {"api_key": "xxx"}). This
// handler encodes them with the Cipher and stores the envelope in
// audit_sinks.encrypted_credentials. The worker decrypts lazily on
// each delivery.

package auditsink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// Encrypter is the narrow surface the admin handler needs from the
// platform cipher. Distinct from auditsink.Cipher (which is the
// decrypt-side surface) so this file's signature stays compatible
// with a no-op Cipher in tests.
type Encrypter interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
}

// AdminDeps wires the admin endpoints.
//
//   - Encrypt is used by Create + Patch (credential rotation). When
//     nil the credentials are stored raw (dev-mode only — main.go
//     wires a non-nil BYOK-backed encrypter for production).
//   - Cipher is used by ReplayDLQ + Test (existing-sink probe) to
//     decrypt the stored credentials envelope. When nil, replay/test
//     paths fall back to assuming the envelope is raw JSON, matching
//     the dev-mode contract above. Production wires the same BYOK
//     cipher the worker uses.
type AdminDeps struct {
	Pool    *db.Pool
	Encrypt Encrypter
	Cipher  Cipher
	// Logger receives structured server-side context for 5xx error
	// responses emitted via httperror.WriteInternal. May be nil in
	// tests; nil-safe inside httperror.
	Logger *slog.Logger
}

// MountAdminRoutes attaches the audit-sink admin endpoints to r.
//
//	GET    /api/v1/audit-sinks
//	POST   /api/v1/audit-sinks
//	PATCH  /api/v1/audit-sinks/{id}
//	DELETE /api/v1/audit-sinks/{id}
//	POST   /api/v1/audit-sinks/{id}/replay
//	GET    /api/v1/audit-sinks/{id}/replay-jobs
//	GET    /api/v1/audit-sinks/{id}/replay-jobs/{job_id}
//	POST   /api/v1/audit-sinks/{id}/replay-jobs/{job_id}/cancel
func (a *AdminDeps) MountAdminRoutes(r chi.Router) {
	if a == nil || a.Pool == nil {
		return
	}
	// RBAC-meta-audit: list is a read; mutations require the
	// configure-sinks scope. ScopeAdmin still grants both as a
	// wildcard.
	readGate := apikeys.RequireScope(apikeys.ScopeAuditRead)
	cfgGate := apikeys.RequireScope(apikeys.ScopeAuditConfigureSinks)
	execGate := apikeys.RequireScope(apikeys.ScopeAuditExecuteActions)
	// LIST is a read of CONFIGURATION, not of audit events: the response
	// carries each sink's raw `config` blob — webhook destination URL, S3
	// bucket and region, Splunk host. audit:read is in readOnlyScopes, so
	// RequireScope performs no role check for it and every non-admin session
	// is handed that scope by default; the egress topology of the whole
	// workspace was therefore readable by any viewer. Reading the destinations
	// belongs with configuring them. (The sibling card on the same settings
	// screen, GET /api/v1/audit/export-schedules, already required
	// audit:read + audit:read_pii — its 403 for viewers was the tell that
	// these two reads were never held to one standard.)
	r.With(cfgGate).Get("/api/v1/audit-sinks", a.List)
	// p4d-recordsurface-wire-others: every mutating audit-sink admin
	// op gets a pw_auditsink_<action>_total + pw_auditsink_duration_seconds
	// pair so dashboards can track configure-rotation drills + replay
	// throughput from a single Grafana row.
	r.With(cfgGate).Post("/api/v1/audit-sinks", observability.RecordSurfaceFunc("auditsink", "create", a.Create))
	r.With(cfgGate).Patch("/api/v1/audit-sinks/{id}", observability.RecordSurfaceFunc("auditsink", "patch", a.Patch))
	r.With(cfgGate).Delete("/api/v1/audit-sinks/{id}", observability.RecordSurfaceFunc("auditsink", "delete", a.Delete))
	// signed-export-replay (Compliance, P0): replay surface. Create +
	// cancel are destructive (re-shipping rows to the sink) so they
	// require execute_actions; list/get are read-only.
	r.With(execGate).Post("/api/v1/audit-sinks/{id}/replay", observability.RecordSurfaceFunc("auditsink", "replay_create", a.Replay))
	r.With(readGate).Get("/api/v1/audit-sinks/{id}/replay-jobs", a.ListReplayJobs)
	r.With(readGate).Get("/api/v1/audit-sinks/{id}/replay-jobs/{job_id}", a.GetReplayJob)
	r.With(execGate).Post("/api/v1/audit-sinks/{id}/replay-jobs/{job_id}/cancel", observability.RecordSurfaceFunc("auditsink", "replay_cancel", a.CancelReplayJob))
}

// sinkRow is the wire shape. Excludes the encrypted blob — operators
// can't recover credentials from the UI, by design.
//
// circuit_state ∈ {closed, open, half_open}; cooldown_until is set
// while state=open and tells the UI when the worker will next probe.
// Together they let the table show a meaningful health badge instead
// of just "enabled / disabled".
type sinkRow struct {
	ID      string         `json:"id"`
	Kind    string         `json:"kind"`
	Name    string         `json:"name"`
	Enabled bool           `json:"enabled"`
	Config  map[string]any `json:"config"`
	// OutputFormat is "postwave_native" or "ocsf_1_8". Drives the
	// on-the-wire shape the worker emits to the destination.
	OutputFormat string `json:"output_format"`
	// WebhookFormat is "postwave_v1" or "standard_webhooks". Drives
	// the signature shape on kind=http sinks (RFC 9499 vs legacy).
	WebhookFormat       string  `json:"webhook_format"`
	ConsecutiveFailures int     `json:"consecutive_failures"`
	AutoDisableAfter    int     `json:"auto_disable_after"`
	CircuitState        string  `json:"circuit_state"`
	CooldownUntil       *string `json:"cooldown_until,omitempty"`
	LastSuccessAt       *string `json:"last_success_at,omitempty"`
	LastFailureAt       *string `json:"last_failure_at,omitempty"`
	LastError           *string `json:"last_error,omitempty"`
}

// validOutputFormat is the package-private allow-list for the
// output_format column. Mirrored in migration 0275.
func validOutputFormat(s string) bool {
	switch s {
	case FormatNative, FormatOCSF18:
		return true
	}
	return false
}

// List GET /api/v1/audit-sinks.
func (a *AdminDeps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, kind, name, enabled,
       COALESCE(config, '{}'::jsonb),
       COALESCE(output_format, 'postwave_native'),
       COALESCE(webhook_format, 'postwave_v1'),
       COALESCE(consecutive_failures, 0),
       COALESCE(circuit_state, 'closed'),
       cooldown_until::text,
       last_success_at::text, last_failure_at::text, last_failure_reason
  FROM audit_sinks
 WHERE tenant_id = $1::uuid
 ORDER BY created_at ASC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []sinkRow{}
	for rows.Next() {
		var s sinkRow
		var rawConfig []byte
		if err := rows.Scan(&s.ID, &s.Kind, &s.Name, &s.Enabled,
			&rawConfig, &s.OutputFormat, &s.WebhookFormat,
			&s.ConsecutiveFailures,
			&s.CircuitState, &s.CooldownUntil,
			&s.LastSuccessAt, &s.LastFailureAt, &s.LastError); err != nil {
			httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		_ = json.Unmarshal(rawConfig, &s.Config)
		// AutoDisableAfter mirrors the worker default. Sending it on
		// the wire lets the UI render "82 / 100 — auto-disable
		// approaching" without hardcoding the threshold.
		s.AutoDisableAfter = 100
		out = append(out, s)
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"sinks": out})
}

// createInput is the request body for POST /api/v1/audit-sinks.
type createInput struct {
	Kind          string            `json:"kind"`
	Name          string            `json:"name"`
	Enabled       *bool             `json:"enabled"`
	Config        map[string]any    `json:"config"`
	Credentials   map[string]string `json:"credentials"`
	OutputFormat  string            `json:"output_format"`
	WebhookFormat string            `json:"webhook_format"`
}

// Create POST /api/v1/audit-sinks.
func (a *AdminDeps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in createInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.Kind = strings.ToLower(strings.TrimSpace(in.Kind))
	switch in.Kind {
	case "s3", "datadog", "splunk", "http", "archive",
		"snowflake_shareback", "otlp_logs":
	default:
		writeAdminErr(w, http.StatusBadRequest, "invalid_kind",
			"kind must be one of s3|datadog|splunk|http|archive|snowflake_shareback|otlp_logs")
		return
	}
	// retention-trail-archive (Compliance, P1): when kind=archive,
	// validate the parquet_config shape up-front so the operator
	// gets a 400 rather than a worker-side failure on first tick.
	if in.Kind == "archive" {
		if _, err := parseArchiveConfig(in.Config); err != nil {
			writeAdminErr(w, http.StatusBadRequest, "invalid_archive_config",
				err.Error())
			return
		}
	}
	// snowflake-shareback (SIEM/Sink, P2): validate shareback config
	// up-front for the same fail-fast reason.
	if in.Kind == "snowflake_shareback" {
		if _, err := parseSnowflakeSharebackConfig(in.Config); err != nil {
			writeAdminErr(w, http.StatusBadRequest, "invalid_snowflake_shareback_config",
				err.Error())
			return
		}
	}
	if in.Kind == "otlp_logs" {
		ep, _ := in.Config["endpoint"].(string)
		if strings.TrimSpace(ep) == "" {
			writeAdminErr(w, http.StatusBadRequest, "invalid_otlp_logs_config",
				"otlp_logs: config.endpoint required")
			return
		}
	}
	if strings.TrimSpace(in.Name) == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_name", "name required")
		return
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	outFmt := strings.TrimSpace(in.OutputFormat)
	if outFmt == "" {
		outFmt = FormatNative
	}
	if !validOutputFormat(outFmt) {
		writeAdminErr(w, http.StatusBadRequest, "invalid_output_format",
			"output_format must be one of postwave_native|ocsf_1_8")
		return
	}
	whFmt := strings.TrimSpace(in.WebhookFormat)
	if whFmt == "" {
		whFmt = WebhookFormatPostwaveV1
	}
	if !validWebhookFormat(whFmt) {
		writeAdminErr(w, http.StatusBadRequest, "invalid_webhook_format",
			"webhook_format must be one of postwave_v1|standard_webhooks")
		return
	}
	configJSON, _ := json.Marshal(in.Config)
	if len(configJSON) == 0 {
		configJSON = []byte("{}")
	}
	// Encrypt the credentials map. The Encrypter is optional in dev;
	// when nil we store the credentials JSON raw. PRODUCTION MUST
	// wire a non-nil Encrypter — main.go enforces this via the BYOK
	// composite cipher.
	var credEnvelope []byte
	if len(in.Credentials) > 0 {
		credJSON, _ := json.Marshal(in.Credentials)
		if a.Encrypt != nil {
			enc, err := a.Encrypt.Encrypt(r.Context(), credJSON)
			if err != nil {
				httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
				return
			}
			credEnvelope = enc
		} else {
			credEnvelope = credJSON
		}
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO audit_sinks
  (tenant_id, kind, name, enabled, config, credentials_envelope,
   output_format, webhook_format)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::bytea, $7, $8)
RETURNING id::text`,
		t.ID, in.Kind, strings.TrimSpace(in.Name), enabled,
		string(configJSON), credEnvelope, outFmt, whFmt).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.create", "audit_sink", id, nil,
		map[string]any{
			"kind":           in.Kind,
			"name":           strings.TrimSpace(in.Name),
			"enabled":        enabled,
			"output_format":  outFmt,
			"webhook_format": whFmt,
		}, nil)
	writeAdminJSON(w, http.StatusCreated, map[string]any{
		"id":             id,
		"kind":           in.Kind,
		"name":           in.Name,
		"enabled":        enabled,
		"output_format":  outFmt,
		"webhook_format": whFmt,
	})
}

// patchInput is the request body for PATCH /api/v1/audit-sinks/{id}.
//
// All fields are pointers / optional. Any subset is valid; only the
// supplied fields are written. Notable cases:
//
//   - Credentials, if non-nil, REPLACES the stored envelope. Pass an
//     empty map to clear credentials. Field-level merge isn't supported
//     because we don't keep the plaintext envelope around to merge into.
//     UI should always re-collect the full credential set during rotation.
//   - Kind is intentionally NOT patchable — switching kinds invalidates
//     the cursor + DLQ history. Delete-and-recreate instead.
type patchInput struct {
	Enabled       *bool              `json:"enabled,omitempty"`
	Name          *string            `json:"name,omitempty"`
	Config        *map[string]any    `json:"config,omitempty"`
	Credentials   *map[string]string `json:"credentials,omitempty"`
	OutputFormat  *string            `json:"output_format,omitempty"`
	WebhookFormat *string            `json:"webhook_format,omitempty"`
}

// Patch PATCH /api/v1/audit-sinks/{id}. Supports:
//
//   - enabled toggle  — pause / resume without losing config
//   - rename          — update name
//   - config edit     — e.g. switch Datadog site, update S3 prefix
//   - credential rotate — replace the encrypted envelope
//
// Credential rotation preserves DLQ + circuit state. Operators rotating
// quarterly should hit this endpoint, not delete-and-recreate.
func (a *AdminDeps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	var in patchInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Enabled == nil && in.Name == nil && in.Config == nil &&
		in.Credentials == nil && in.OutputFormat == nil && in.WebhookFormat == nil {
		writeAdminErr(w, http.StatusBadRequest, "no_changes",
			"at least one of enabled, name, config, credentials, output_format, webhook_format must be supplied")
		return
	}
	if in.OutputFormat != nil && !validOutputFormat(strings.TrimSpace(*in.OutputFormat)) {
		writeAdminErr(w, http.StatusBadRequest, "invalid_output_format",
			"output_format must be one of postwave_native|ocsf_1_8")
		return
	}
	if in.WebhookFormat != nil && !validWebhookFormat(strings.TrimSpace(*in.WebhookFormat)) {
		writeAdminErr(w, http.StatusBadRequest, "invalid_webhook_format",
			"webhook_format must be one of postwave_v1|standard_webhooks")
		return
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		writeAdminErr(w, http.StatusBadRequest, "invalid_name", "name must not be blank")
		return
	}
	// Encrypt the new credentials map if supplied. Mirrors Create.
	var newEnvelope []byte
	if in.Credentials != nil {
		credJSON, _ := json.Marshal(*in.Credentials)
		if a.Encrypt != nil {
			enc, err := a.Encrypt.Encrypt(r.Context(), credJSON)
			if err != nil {
				httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
				return
			}
			newEnvelope = enc
		} else {
			newEnvelope = credJSON
		}
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// Build the UPDATE dynamically so we only touch supplied columns.
	// COALESCE-on-null would work too, but a typed value list is easier
	// to audit and keeps NULL semantics for legitimately-unset values
	// like last_failure_reason untouched.
	sets := []string{"updated_at = now()"}
	args := []any{t.ID, id}
	next := 3
	if in.Enabled != nil {
		sets = append(sets, fmt.Sprintf("enabled = $%d", next))
		args = append(args, *in.Enabled)
		next++
	}
	if in.Name != nil {
		sets = append(sets, fmt.Sprintf("name = $%d", next))
		args = append(args, strings.TrimSpace(*in.Name))
		next++
	}
	if in.Config != nil {
		cfgJSON, _ := json.Marshal(*in.Config)
		if len(cfgJSON) == 0 {
			cfgJSON = []byte("{}")
		}
		sets = append(sets, fmt.Sprintf("config = $%d::jsonb", next))
		args = append(args, string(cfgJSON))
		next++
	}
	if in.Credentials != nil {
		sets = append(sets, fmt.Sprintf("credentials_envelope = $%d::bytea", next))
		args = append(args, newEnvelope)
		next++
	}
	if in.OutputFormat != nil {
		sets = append(sets, fmt.Sprintf("output_format = $%d", next))
		args = append(args, strings.TrimSpace(*in.OutputFormat))
		next++
	}
	if in.WebhookFormat != nil {
		sets = append(sets, fmt.Sprintf("webhook_format = $%d", next))
		args = append(args, strings.TrimSpace(*in.WebhookFormat))
	}
	q := fmt.Sprintf(`UPDATE audit_sinks SET %s
	   WHERE tenant_id = $1::uuid AND id = $2::uuid`, strings.Join(sets, ", "))
	tag, err := tx.Exec(r.Context(), q, args...)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		writeAdminErr(w, http.StatusNotFound, "not_found", "sink not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	resp := map[string]any{"id": id}
	auditAfter := map[string]any{}
	if in.Enabled != nil {
		resp["enabled"] = *in.Enabled
		auditAfter["enabled"] = *in.Enabled
	}
	if in.Name != nil {
		resp["name"] = strings.TrimSpace(*in.Name)
		auditAfter["name"] = strings.TrimSpace(*in.Name)
	}
	if in.Credentials != nil {
		resp["credentials_rotated"] = true
		auditAfter["credentials_rotated"] = true
	}
	if in.OutputFormat != nil {
		resp["output_format"] = strings.TrimSpace(*in.OutputFormat)
		auditAfter["output_format"] = strings.TrimSpace(*in.OutputFormat)
	}
	if in.WebhookFormat != nil {
		resp["webhook_format"] = strings.TrimSpace(*in.WebhookFormat)
		auditAfter["webhook_format"] = strings.TrimSpace(*in.WebhookFormat)
	}
	if in.Config != nil {
		auditAfter["config_changed"] = true
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.update", "audit_sink", id, nil, auditAfter, nil)
	writeAdminJSON(w, http.StatusOK, resp)
}

// Delete DELETE /api/v1/audit-sinks/{id}. Hard delete — losing the
// row also drops the encrypted credentials, which is exactly what
// the operator wants when revoking an integration.
func (a *AdminDeps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM audit_sinks
		   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		writeAdminErr(w, http.StatusNotFound, "not_found", "sink not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.delete", "audit_sink", id,
		map[string]any{"id": id}, nil, nil)
	writeAdminJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// --- helpers (kept package-local to avoid drifting against the
// worker's logging conventions). ---

func writeAdminJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeAdminErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

// keep errors import alive in case future patch handlers grow
// typed-error sentinels.
var _ = errors.New

// ReplayInput is the request body for POST /api/v1/audit-sinks/{id}/replay.
type ReplayInput struct {
	FromID int64 `json:"from_id"`
	ToID   int64 `json:"to_id"`
}

// Replay POST /api/v1/audit-sinks/{id}/replay. Creates a new replay
// job in audit_sink_replay_jobs; the worker picks it up on the next
// tick. Returns 202 Accepted so the UI can poll for completion without
// blocking on a 100k-row backfill.
func (a *AdminDeps) Replay(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	sinkID := strings.TrimSpace(chi.URLParam(r, "id"))
	if sinkID == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	var in ReplayInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.FromID < 0 || in.ToID < 0 {
		writeAdminErr(w, http.StatusBadRequest, "invalid_range",
			"from_id and to_id must be non-negative")
		return
	}
	if in.FromID > in.ToID {
		writeAdminErr(w, http.StatusBadRequest, "invalid_range",
			"from_id must be <= to_id")
		return
	}
	if in.ToID-in.FromID+1 > MaxReplayRowsPerJob {
		writeAdminErr(w, http.StatusBadRequest, "range_too_large",
			fmt.Sprintf("range exceeds %d-row cap; split into multiple jobs", MaxReplayRowsPerJob))
		return
	}
	actor := actorLabelFromContext(r.Context())
	mgr := &ReplayJobManager{Pool: a.Pool}
	job, err := mgr.CreateReplayJob(r.Context(), t.ID, sinkID, in.FromID, in.ToID, actor)
	if err != nil {
		if err.Error() == "sink not found" {
			writeAdminErr(w, http.StatusNotFound, "not_found", "sink not found")
			return
		}
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.replay", "audit_sink", sinkID, nil,
		map[string]any{
			"job_id":  job.ID,
			"from_id": job.FromAuditID,
			"to_id":   job.ToAuditID,
		}, nil)
	writeAdminJSON(w, http.StatusAccepted, map[string]any{
		"job_id":     job.ID,
		"status":     job.Status,
		"created_at": job.CreatedAt,
		"from_id":    job.FromAuditID,
		"to_id":      job.ToAuditID,
	})
}

// ListReplayJobs GET /api/v1/audit-sinks/{id}/replay-jobs?cursor=&limit=.
func (a *AdminDeps) ListReplayJobs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	sinkID := strings.TrimSpace(chi.URLParam(r, "id"))
	if sinkID == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	q := r.URL.Query()
	cursor := strings.TrimSpace(q.Get("cursor"))
	limit := 25
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	mgr := &ReplayJobManager{Pool: a.Pool}
	jobs, nextCursor, err := mgr.ListReplayJobs(r.Context(), t.ID, sinkID, cursor, limit)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	resp := map[string]any{
		"jobs":  jobs,
		"count": len(jobs),
	}
	if nextCursor != "" {
		resp["nextCursor"] = nextCursor
	}
	writeAdminJSON(w, http.StatusOK, resp)
}

// GetReplayJob GET /api/v1/audit-sinks/{id}/replay-jobs/{job_id}.
func (a *AdminDeps) GetReplayJob(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	jobID := strings.TrimSpace(chi.URLParam(r, "job_id"))
	if jobID == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_job_id", "job_id required")
		return
	}
	mgr := &ReplayJobManager{Pool: a.Pool}
	job, err := mgr.GetReplayJob(r.Context(), t.ID, jobID)
	if err != nil {
		if err.Error() == "job not found" {
			writeAdminErr(w, http.StatusNotFound, "not_found", "job not found")
			return
		}
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeAdminJSON(w, http.StatusOK, job)
}

// CancelReplayJob POST /api/v1/audit-sinks/{id}/replay-jobs/{job_id}/cancel.
func (a *AdminDeps) CancelReplayJob(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	jobID := strings.TrimSpace(chi.URLParam(r, "job_id"))
	if jobID == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_job_id", "job_id required")
		return
	}
	mgr := &ReplayJobManager{Pool: a.Pool}
	if err := mgr.CancelReplayJob(r.Context(), t.ID, jobID); err != nil {
		writeAdminErr(w, http.StatusConflict, "cancel_failed", err.Error())
		return
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.replay_cancel", "audit_sink_replay_job", jobID, nil,
		map[string]any{"job_id": jobID}, nil)
	writeAdminJSON(w, http.StatusOK, map[string]any{"cancelled": true, "job_id": jobID})
}

// actorLabelFromContext extracts an audit-friendly actor label from
// the request context. Falls back through ActorFromContext (set by
// the audit middleware) → User.Email → API key id. Best-effort —
// returns "" when no signal exists.
func actorLabelFromContext(ctx context.Context) string {
	if _, label := middleware.ActorFromContext(ctx); label != "" {
		return label
	}
	if u, ok := middleware.UserFromContext(ctx); ok && u != nil {
		if u.Email != "" {
			return u.Email
		}
		if u.ID != "" {
			return u.ID
		}
	}
	if id := middleware.APIKeyIDFromContext(ctx); id != "" {
		return "apikey:" + id
	}
	return ""
}
