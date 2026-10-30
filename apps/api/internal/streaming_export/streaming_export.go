// SPDX-License-Identifier: AGPL-3.0-only
//
// Package streaming_export implements SUB-111 — a Currents-style
// real-time event streaming export. It batches subscriber.* events +
// profile context hourly into Parquet/Avro files and ships them to
// S3/Snowflake/BigQuery via the warehouse Storage interface.
//
// A streaming-export destination is modeled as a warehouse_connections
// row with provider='streaming_export' (migration 1100 extends the
// provider CHECK). Format/compression/batch_size live in the connection's
// config jsonb; each hourly shipment is recorded in streaming_export_runs.
//
// This package is intentionally a sibling of warehouse/ rather than an
// edit to it: it owns the streaming-specific config parsing, the
// Parquet/Avro encoders (encoder_parquet.go / encoder_avro.go), the
// hourly batch worker (worker.go), the runs repository (repo.go), and a
// thin HTTP surface mounted alongside the warehouse routes.
package streaming_export

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

// Storage is the subset of the warehouse Storage interface this package
// needs to ship batches. Declared here (not imported from warehouse) to
// keep the dependency one-directional and to let tests supply a fake.
type Storage interface {
	Put(ctx context.Context, tenantID, rest, contentType string, body io.Reader) (string, error)
	PresignGet(ctx context.Context, tenantID, rest string, ttl time.Duration) (string, error)
}

// ProviderStreamingExport is the warehouse_connections.provider value
// that marks a connection as a streaming-export destination.
const ProviderStreamingExport = "streaming_export"

// Supported encodings + compressions.
const (
	FormatParquet = "parquet"
	FormatAvro    = "avro"

	CompressionNone   = "none"
	CompressionSnappy = "snappy"
	CompressionGzip   = "gzip"
	CompressionZstd   = "zstd"
)

// DefaultBatchSize bounds how many event rows one hourly shipment encodes.
const (
	DefaultBatchSize = 10_000
	MinBatchSize     = 100
	MaxBatchSize     = 1_000_000
)

// Sentinel errors.
var (
	ErrNotFound     = errors.New("streaming_export: not found")
	ErrInvalidInput = errors.New("streaming_export: invalid input")
	ErrStale        = errors.New("streaming_export: stale connection version")
)

// Repo wraps the pgx pool.
type Repo struct {
	Pool *db.Pool
}

// Config is the parsed streaming-export-specific block of a
// warehouse_connections.config jsonb.
type Config struct {
	Format      string `json:"format"`
	Compression string `json:"compression"`
	BatchSize   int    `json:"batch_size"`
	// Prefix is relative to tenant-bound Moosewave workspace storage.
	Prefix string `json:"prefix,omitempty"`
	// EventTypes restricts the shipment to the listed subscriber_events
	// event_type values. Stored under config.field_filters (the UI labels
	// these "field filters"); empty means ship every event type. Applied
	// in the batch fetch (repo.go fetchEventBatch) so a connection
	// configured for, say, ["opened","clicked"] never exports other types.
	EventTypes []string `json:"field_filters,omitempty"`
}

// Run is one row from streaming_export_runs.
type Run struct {
	ID           string     `json:"id"`
	TenantID     string     `json:"tenant_id,omitempty"`
	ConnectionID string     `json:"connection_id"`
	Status       string     `json:"status"`
	Format       string     `json:"format"`
	Compression  string     `json:"compression"`
	WindowStart  time.Time  `json:"window_start"`
	WindowEnd    time.Time  `json:"window_end"`
	CursorFrom   int64      `json:"cursor_from"`
	CursorTo     int64      `json:"cursor_to"`
	HasMore      bool       `json:"has_more"`
	RowsShipped  int64      `json:"rows_shipped"`
	BytesShipped int64      `json:"bytes_shipped"`
	ObjectURI    string     `json:"object_uri,omitempty"`
	Error        string     `json:"error,omitempty"`
	IssuePresent bool       `json:"issue_present"`
	StartedAt    time.Time  `json:"started_at"`
	CompletedAt  *time.Time `json:"completed_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

type ShipInput struct {
	ExpectedConnectionVersion int64 `json:"expected_connection_version"`
}

// EventRow is the wide row written to each Parquet/Avro file: a
// subscriber event joined with profile context. Parquet tags drive the
// columnar schema (auditsink/parquet_archive.go pattern); the Avro
// encoder reads the same fields by their json/avro names.
type EventRow struct {
	EventID         int64  `parquet:"event_id,plain" avro:"event_id"`
	TenantID        string `parquet:"tenant_id,plain" avro:"tenant_id"`
	SubscriberEmail string `parquet:"subscriber_email,plain" avro:"subscriber_email"`
	EventType       string `parquet:"event_type,plain" avro:"event_type"`
	CampaignID      string `parquet:"campaign_id,plain,optional" avro:"campaign_id"`
	LinkURL         string `parquet:"link_url,plain,optional" avro:"link_url"`
	AtUnixMs        int64  `parquet:"at_unix_ms,plain" avro:"at_unix_ms"`
	// Profile context joined from subscribers.
	SubscriberStatus string `parquet:"subscriber_status,plain,optional" avro:"subscriber_status"`
	Tags             string `parquet:"tags,plain,optional" avro:"tags"`                   // JSON array
	CustomFields     string `parquet:"custom_fields,plain,optional" avro:"custom_fields"` // JSON object
}

// ParseConfig pulls the streaming-export Config out of a connection
// config map, applying defaults. It does not error on missing
// destination fields — those are surfaced by Validate.
func ParseConfig(cfg map[string]any) Config {
	out := Config{
		Format:      FormatParquet,
		Compression: CompressionSnappy,
		BatchSize:   DefaultBatchSize,
	}
	if cfg == nil {
		out.normalize()
		return out
	}
	if v, ok := cfg["format"].(string); ok && v != "" {
		out.Format = strings.ToLower(strings.TrimSpace(v))
	}
	if v, ok := cfg["compression"].(string); ok && v != "" {
		out.Compression = strings.ToLower(strings.TrimSpace(v))
	}
	if v, ok := cfg["batch_size"].(float64); ok && v > 0 {
		out.BatchSize = int(v)
	}
	if v, ok := cfg["batch_size"].(int); ok && v > 0 {
		out.BatchSize = v
	}
	if v, ok := cfg["prefix"].(string); ok {
		out.Prefix = strings.Trim(strings.TrimSpace(v), "/")
	}
	out.EventTypes = parseEventTypes(cfg["field_filters"])
	out.normalize()
	return out
}

// parseEventTypes coerces a config.field_filters value into a clean,
// deduplicated, order-preserving list of event_type strings. It accepts
// both a JSON array (the UI's shape after jsonb decode → []any) and a
// single comma/whitespace-tolerant string, and drops blanks. Returns nil
// (not an empty slice) when no usable filters are present so the batch
// query can treat "no filter" as "ship every type".
func parseEventTypes(v any) []string {
	var raw []string
	switch t := v.(type) {
	case []any:
		for _, e := range t {
			if s, ok := e.(string); ok {
				raw = append(raw, s)
			}
		}
	case []string:
		raw = t
	case string:
		raw = strings.FieldsFunc(t, func(r rune) bool { return r == ',' || r == '\n' })
	default:
		return nil
	}
	seen := make(map[string]struct{}, len(raw))
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func (c *Config) normalize() {
	if !validFormat(c.Format) {
		c.Format = FormatParquet
	}
	if !validCompression(c.Compression) {
		c.Compression = CompressionSnappy
	}
	if c.BatchSize < MinBatchSize {
		c.BatchSize = DefaultBatchSize
	}
	if c.BatchSize > MaxBatchSize {
		c.BatchSize = MaxBatchSize
	}
	if c.Prefix == "" {
		c.Prefix = "streaming-export"
	}
}

func validFormat(f string) bool {
	return f == FormatParquet || f == FormatAvro
}

func validCompression(c string) bool {
	switch c {
	case CompressionNone, CompressionSnappy, CompressionGzip, CompressionZstd:
		return true
	}
	return false
}

// ValidationResult mirrors warehouse.ValidationResult.
type ValidationResult struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

// ValidateConfig validates a streaming-export connection's config block.
// Unlike ParseConfig (which clamps to safe defaults for the worker), this
// inspects the RAW values so an operator-supplied bad format / out-of-range
// batch_size surfaces as a hard error in the UI.
func ValidateConfig(cfg map[string]any) ValidationResult {
	out := ValidationResult{Valid: true}
	if cfg == nil {
		out.Warnings = append(out.Warnings, "shipments use tenant-bound Moosewave workspace storage")
		return out
	}
	allowedKeys := map[string]bool{
		"format": true, "compression": true, "batch_size": true,
		"prefix": true, "field_filters": true,
	}
	for key := range cfg {
		if !allowedKeys[key] {
			out.Errors = append(out.Errors, "unsupported streaming config field: "+key)
		}
	}
	if v, ok := cfg["format"].(string); ok && strings.TrimSpace(v) != "" && !validFormat(strings.ToLower(strings.TrimSpace(v))) {
		out.Errors = append(out.Errors, "format must be parquet or avro")
	} else if _, present := cfg["format"]; present && !ok {
		out.Errors = append(out.Errors, "format must be a string")
	}
	if v, ok := cfg["compression"].(string); ok && strings.TrimSpace(v) != "" && !validCompression(strings.ToLower(strings.TrimSpace(v))) {
		out.Errors = append(out.Errors, "compression must be none, snappy, gzip, or zstd")
	} else if _, present := cfg["compression"]; present && !ok {
		out.Errors = append(out.Errors, "compression must be a string")
	}
	if bs, ok := rawBatchSize(cfg); ok && (bs < MinBatchSize || bs > MaxBatchSize) {
		out.Errors = append(out.Errors, "batch_size must be between 100 and 1000000")
	} else if _, present := cfg["batch_size"]; present && !ok {
		out.Errors = append(out.Errors, "batch_size must be an integer")
	}
	if prefix, ok := cfg["prefix"].(string); ok {
		prefix = strings.Trim(strings.TrimSpace(prefix), "/")
		if len(prefix) > 256 || strings.Contains(prefix, "..") || strings.ContainsAny(prefix, "\\\x00\r\n") {
			out.Errors = append(out.Errors, "prefix must be a relative, control-free object prefix of at most 256 characters")
		}
	} else if _, present := cfg["prefix"]; present && !ok {
		out.Errors = append(out.Errors, "prefix must be a string")
	}
	filters := parseEventTypes(cfg["field_filters"])
	if raw, present := cfg["field_filters"]; present {
		validShape := false
		switch value := raw.(type) {
		case string, []string:
			validShape = true
		case []any:
			validShape = true
			for _, item := range value {
				if _, ok := item.(string); !ok {
					validShape = false
					break
				}
			}
		}
		if !validShape {
			out.Errors = append(out.Errors, "field_filters must be a string or string array")
		}
		if len(filters) > 100 {
			out.Errors = append(out.Errors, "field_filters supports at most 100 event types")
		}
		for _, value := range filters {
			if len(value) > 128 || strings.ContainsAny(value, "\x00\r\n") {
				out.Errors = append(out.Errors, "field_filters contains an invalid event type")
				break
			}
		}
	}
	out.Warnings = append(out.Warnings, "shipments use the tenant-bound Moosewave object store; per-connection bucket overrides are not accepted")
	out.Valid = len(out.Errors) == 0
	return out
}

// rawBatchSize extracts a batch_size from the config without clamping.
func rawBatchSize(cfg map[string]any) (int, bool) {
	switch v := cfg["batch_size"].(type) {
	case float64:
		if v != float64(int(v)) {
			return 0, false
		}
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}

// Deps wires the HTTP surface.
type Deps struct {
	Repo    *Repo
	Storage Storage
	Worker  *Worker
	Logger  *slog.Logger
}

// MountRoutes registers the streaming-export read/validate surface. The
// connection CRUD itself reuses the warehouse connections endpoints
// (POST/GET/PATCH /api/v1/warehouse/connections with
// provider=streaming_export); this package adds the streaming-specific
// runs history + a config validator + a manual ship trigger.
//
//	GET  /api/v1/warehouse/connections/{id}/streaming/runs   → runs history
//	POST /api/v1/warehouse/connections/{id}/streaming/ship   → ship one window now
//	POST /api/v1/warehouse/streaming/validate                → validate config block
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/warehouse/connections/{id}/streaming/runs", d.ListRuns)
	r.With(admin).Post("/api/v1/warehouse/connections/{id}/streaming/ship", d.ShipNow)
	r.With(admin).Post("/api/v1/warehouse/streaming/validate", d.Validate)
}

// ListRuns GET /api/v1/warehouse/connections/{id}/streaming/runs.
func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id, ok := streamingUUIDParam(w, r, "id")
	if !ok {
		return
	}
	runs, lastShipped, err := d.Repo.ListRuns(r.Context(), t.ID, id, 50)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":           sanitizeRuns(runs),
		"last_shipped_at": lastShipped,
	})
}

// ShipNow POST /api/v1/warehouse/connections/{id}/streaming/ship —
// manually ship the next due window synchronously (operator-triggered;
// the worker handles the scheduled path).
func (d *Deps) ShipNow(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id, ok := streamingUUIDParam(w, r, "id")
	if !ok {
		return
	}
	if d.Worker == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "worker_unavailable",
			"streaming export worker not configured on this server")
		return
	}
	var in ShipInput
	if err := httpbody.DecodeJSON(w, r, 16<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if in.ExpectedConnectionVersion < 1 {
		httperror.WriteValidation(w, "validation_failed", "expected_connection_version must be a positive integer")
		return
	}
	run, err := d.Worker.ShipConnection(r.Context(), t.ID, id, time.Now().UTC(), in.ExpectedConnectionVersion)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	// ShipConnection runs synchronously and returns the COMPLETED run, so
	// 200 OK is correct — not 202 Accepted, which implies the work is still
	// in flight and would mislead a client/agent into polling for a result
	// that already exists. (A single manual window is bounded by the batch
	// cap; the scheduled bulk path is already async via the worker. If
	// per-window volume ever makes the inline upload too slow for a request,
	// promote this to an enqueue-and-poll job — the worker already has the
	// shippable unit in ShipConnection.)
	writeJSON(w, http.StatusOK, sanitizeRun(run))
}

// Validate POST /api/v1/warehouse/streaming/validate.
func (d *Deps) Validate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Config map[string]any `json:"config"`
	}
	if err := httpbody.DecodeJSONWith(w, r, 64<<10, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	writeJSON(w, http.StatusOK, ValidateConfig(body.Config))
}

func (d *Deps) writeRepoErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "invalid_input", err.Error())
	case errors.Is(err, ErrStale):
		httperror.Write(w, http.StatusPreconditionFailed, "stale_version", "the warehouse connection changed; reload it before retrying")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
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

// sanitizeRun prevents tenant storage keys and provider failure detail from
// escaping the operational API while retaining enough evidence to diagnose
// state and volume. Raw detail remains in the tenant-isolated database/logs.
func sanitizeRun(in *Run) *Run {
	if in == nil {
		return nil
	}
	out := *in
	out.IssuePresent = strings.TrimSpace(in.Error) != ""
	out.ObjectURI = ""
	out.Error = ""
	return &out
}

func sanitizeRuns(items []Run) []Run {
	out := make([]Run, 0, len(items))
	for i := range items {
		out = append(out, *sanitizeRun(&items[i]))
	}
	return out
}

func streamingUUIDParam(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, name))
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed.String() != strings.ToLower(raw) {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", name+" must be a canonical UUID")
		return "", false
	}
	return parsed.String(), true
}
