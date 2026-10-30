// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP handlers for the MCP guide page. Routes mounted under
// /api/v1/mcp/* by main.go's tenant-authenticated group:
//
//   GET /api/v1/mcp/executions  → recent api_key_calls rows
//   GET /api/v1/mcp/stats       → aggregated stats over a rolling window
//   GET /api/v1/mcp/catalog     → static tool catalogue (bundled, no DB)
//
// All routes require an authenticated session AND owner/admin role.
// MCP execution data is operator-grade observability — exposing it
// to viewer-tier members would leak per-API-key cadence info.

package apikeycalls

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// CatalogJSON is a candidate catalogue snapshot bundled into this API build.
// It is not publication-bound: no equality is guaranteed with an installed
// @postwave/mcp-server registry artifact, a running proxy, or the independent
// native Go registry. Consumers must treat provenance/digest headers as build
// evidence, not as proof of deployed tool availability.
//
//go:embed tool-catalog.json
var CatalogJSON []byte

// Deps wires handlers to the Repo.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// Mount registers the routes on a chi.Router. Caller is expected to
// have applied tenant middleware + admin/owner gate upstream.
func (d *Deps) Mount(mux interface {
	Get(string, http.HandlerFunc)
}) {
	mux.Get("/api/v1/mcp/executions", d.ListExecutions)
	mux.Get("/api/v1/mcp/stats", d.GetStats)
	mux.Get("/api/v1/mcp/trend", d.GetTrend)
	mux.Get("/api/v1/mcp/catalog", d.GetCatalog)
	mux.Get("/api/v1/mcp/executions.csv", d.ExportExecutionsCSV)
}

// ListExecutions handles GET /api/v1/mcp/executions. Default behaviour
// is MCP-only (UA filter applied). Pass ?include=all to widen to every
// API-key call.
func (d *Deps) ListExecutions(w http.ResponseWriter, r *http.Request) {
	setPrivateNoStore(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	filter, pageLimit, err := parseExecutionListFilter(tenant.ID, r.URL.Query())
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	rows, err := d.Repo.List(ctx, filter)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	hasMore := len(rows) > pageLimit
	if hasMore {
		rows = rows[:pageLimit]
	}
	for i := range rows {
		minimizeCallForResponse(&rows[i])
	}
	resp := ExecutionListResponse{
		TenantID:      tenant.ID,
		Rows:          rows,
		DetailPolicy:  "minimized_v1",
		EvidenceClass: "best_effort_observability",
	}
	if hasMore && len(rows) > 0 {
		next := rows[len(rows)-1].ID
		resp.NextBeforeID = &next
	}
	writeJSON(w, http.StatusOK, resp)
}

// GetStats handles GET /api/v1/mcp/stats. Defaults to a 7d window over
// MCP-only traffic. Pass ?window=24h or ?window=30d to override;
// ?include=all to widen to every API-key call.
func (d *Deps) GetStats(w http.ResponseWriter, r *http.Request) {
	setPrivateNoStore(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	q := r.URL.Query()
	if err := validateQueryKeys(q, "include", "window"); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	if include := q.Get("include"); include != "" && include != "all" {
		writeErr(w, http.StatusBadRequest, "invalid_query", "include must be omitted or all")
		return
	}
	mcpOnly := q.Get("include") != "all"
	window, err := parseWindowStrict(q.Get("window"), 7*24*time.Hour, 90*24*time.Hour)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	stats, err := d.Repo.GetStats(ctx, tenant.ID, mcpOnly, window)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	stats.TenantID = tenant.ID
	writeJSON(w, http.StatusOK, stats)
}

// GetTrend handles GET /api/v1/mcp/trend. Returns one TrendPoint per
// hour bucket. Default window is 24h (sparkline at top of the
// History tab); pass ?window=7d for the wider view.
func (d *Deps) GetTrend(w http.ResponseWriter, r *http.Request) {
	setPrivateNoStore(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	q := r.URL.Query()
	if err := validateQueryKeys(q, "include", "window"); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	if include := q.Get("include"); include != "" && include != "all" {
		writeErr(w, http.StatusBadRequest, "invalid_query", "include must be omitted or all")
		return
	}
	mcpOnly := q.Get("include") != "all"
	window, err := parseWindowStrict(q.Get("window"), 24*time.Hour, 30*24*time.Hour)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	points, err := d.Repo.Trend(ctx, tenant.ID, mcpOnly, window)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, TrendResponse{
		TenantID:    tenant.ID,
		Points:      points,
		WindowHours: int(window / time.Hour),
	})
}

// ExportExecutionsCSV handles GET /api/v1/mcp/executions.csv. Streams
// the executions matching the supplied filter as CSV. Cap'd at 10k
// rows per export to keep the response bounded; an operator who
// wants a full archive uses the audit-log export instead. Filter
// parameters mirror ListExecutions.
func (d *Deps) ExportExecutionsCSV(w http.ResponseWriter, r *http.Request) {
	setPrivateNoStore(w)
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	// The previous exporter silently returned 100 rows despite claiming a
	// 10,000-row cap and emitted spreadsheet-active cells. Keep the route
	// fail-closed until a complete, bounded, formula-safe export contract is
	// implemented and proven against pagination races.
	writeErr(w, http.StatusServiceUnavailable, "mcp_execution_export_release_held",
		"execution CSV export is release-held pending complete and spreadsheet-safe export semantics")
}

// GetCatalog serves the bundled MCP tool catalogue. Stateless,
// tenant-agnostic, but still tenant-gated upstream so the dashboard
// only renders it for logged-in users.
func (d *Deps) GetCatalog(w http.ResponseWriter, _ *http.Request) {
	setPrivateNoStore(w)
	if len(CatalogJSON) == 0 {
		writeErr(w, http.StatusInternalServerError, "catalog_missing",
			"tool catalog was not bundled into this build")
		return
	}
	digest := sha256.Sum256(CatalogJSON)
	var entries []json.RawMessage
	if err := json.Unmarshal(CatalogJSON, &entries); err != nil {
		writeErr(w, http.StatusInternalServerError, "catalog_invalid",
			"tool catalog bundled into this API build is invalid")
		return
	}
	w.Header().Set("X-Postwave-Catalog-Provenance", "api-build-candidate")
	w.Header().Set("X-Postwave-Catalog-Digest", "sha256:"+hex.EncodeToString(digest[:]))
	w.Header().Set("X-Postwave-Catalog-Tool-Count", strconv.Itoa(len(entries)))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(CatalogJSON)
}

func parseExecutionListFilter(tenantID string, q url.Values) (ListFilter, int, error) {
	if err := validateQueryKeys(q, "include", "tool", "api_key_id", "limit", "before_id", "since", "until"); err != nil {
		return ListFilter{}, 0, err
	}
	if include := q.Get("include"); include != "" && include != "all" {
		return ListFilter{}, 0, errors.New("include must be omitted or all")
	}
	filter := ListFilter{
		TenantID: tenantID,
		MCPOnly:  q.Get("include") != "all",
		Tool:     strings.TrimSpace(q.Get("tool")),
		APIKeyID: strings.TrimSpace(q.Get("api_key_id")),
	}
	if filter.Tool != "" && safeToolLabel(filter.Tool) != filter.Tool {
		return ListFilter{}, 0, errors.New("tool must be a bounded canonical tool token")
	}
	if filter.APIKeyID != "" {
		if _, err := uuid.Parse(filter.APIKeyID); err != nil {
			return ListFilter{}, 0, errors.New("api_key_id must be a UUID")
		}
	}
	pageLimit := 100
	if raw := q.Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 500 {
			return ListFilter{}, 0, errors.New("limit must be an integer from 1 to 500")
		}
		pageLimit = value
	}
	filter.Limit = pageLimit + 1
	if raw := q.Get("before_id"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			return ListFilter{}, 0, errors.New("before_id must be a positive integer")
		}
		filter.BeforeID = value
	}
	if raw := q.Get("since"); raw != "" {
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return ListFilter{}, 0, errors.New("since must be RFC3339")
		}
		filter.Since = &value
	}
	if raw := q.Get("until"); raw != "" {
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return ListFilter{}, 0, errors.New("until must be RFC3339")
		}
		filter.Until = &value
	}
	if filter.Since != nil && filter.Until != nil && filter.Since.After(*filter.Until) {
		return ListFilter{}, 0, errors.New("since must be at or before until")
	}
	return filter, pageLimit, nil
}

func validateQueryKeys(q url.Values, allowed ...string) error {
	allow := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allow[key] = struct{}{}
	}
	for key, values := range q {
		if _, ok := allow[key]; !ok {
			return errors.New("unknown query parameter: " + key)
		}
		if len(values) != 1 {
			return errors.New("query parameter must appear once: " + key)
		}
	}
	return nil
}

func parseWindowStrict(raw string, fallback, maximum time.Duration) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	var (
		window time.Duration
		err    error
	)
	if strings.HasSuffix(raw, "d") {
		var days int
		days, err = strconv.Atoi(strings.TrimSuffix(raw, "d"))
		maxDays := int(maximum / (24 * time.Hour))
		if err == nil && days >= 1 && days <= maxDays {
			window = time.Duration(days) * 24 * time.Hour
		} else if err == nil {
			err = errors.New("days outside supported range")
		}
	} else {
		window, err = time.ParseDuration(raw)
	}
	if err != nil || window < time.Hour || window > maximum {
		return 0, fmt.Errorf("window must be between 1h and %s", maximum)
	}
	return window, nil
}

func setPrivateNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
}

func minimizeCallForResponse(c *Call) {
	if c == nil {
		return
	}
	c.Path = minimizeStoredPath(c.Path)
	c.QueryString = queryKeysFromRaw(c.QueryString)
	c.RequestBody = summarizeStoredJSON(c.RequestBody)
	c.RemoteIP = ""
	c.UserAgent = userAgentProduct(c.UserAgent)
	c.ToolName = safeToolLabel(c.ToolName)
	c.APIKeyPrefix = safeAPIKeyPrefix(c.APIKeyPrefix)
	c.ErrorCode = safeDiagnosticCode(c.ErrorCode)
	c.DryRunAsserted = c.DryRun
}

func minimizeStoredPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" || path == "/unmatched" {
		return "/unmatched"
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	keep := 1
	if len(parts) >= 3 && parts[0] == "api" {
		if staticPathSegmentPattern.MatchString(parts[2]) {
			keep = 3
		} else {
			// The resource segment itself is not a reviewed static route token
			// (e.g. a historical `{person@example.test}` pseudo-template).
			return "/api/" + safeAPINamespace(parts[1]) + "/*"
		}
	} else if len(parts) >= 2 {
		// Historical non-template paths may carry UUIDs, slugs, tokens, or
		// subscriber identifiers in their second segment. Only the reviewed
		// leading resource name is safe to project.
		keep = 1
	}
	if keep > len(parts) {
		keep = len(parts)
	}
	out := "/" + strings.Join(parts[:keep], "/")
	if len(parts) > keep {
		out += "/*"
	}
	return out
}

var (
	staticPathSegmentPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
	diagnosticCodePattern    = regexp.MustCompile(`^[a-z][a-z0-9._:-]{0,63}$`)
	apiKeyPrefixPattern      = regexp.MustCompile(`^pw_live_[0-9a-f]{4}$`)
)

func safeAPINamespace(namespace string) string {
	if staticPathSegmentPattern.MatchString(namespace) {
		return namespace
	}
	return "unknown"
}

func safeDiagnosticCode(code string) string {
	code = strings.TrimSpace(code)
	if !diagnosticCodePattern.MatchString(code) {
		return ""
	}
	lower := strings.ToLower(code)
	for _, sensitive := range []string{"password", "secret", "bearer", "credential", "email", "pw_"} {
		if strings.Contains(lower, sensitive) {
			return ""
		}
	}
	return code
}

func safeAPIKeyPrefix(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	if !apiKeyPrefixPattern.MatchString(prefix) {
		return ""
	}
	return prefix
}

func queryKeysFromRaw(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	if strings.HasPrefix(raw, "key_count=") {
		count, err := strconv.Atoi(strings.TrimPrefix(raw, "key_count="))
		if err == nil && count >= 0 && count <= 1024 {
			return "key_count=" + strconv.Itoa(count)
		}
		return ""
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return ""
	}
	request := &http.Request{URL: &url.URL{RawQuery: values.Encode()}}
	return queryKeySummary(request)
}

func summarizeStoredJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	summary := map[string]any{"_summary": true, "type": jsonValueType(value)}
	if object, ok := value.(map[string]any); ok {
		if existing, isSummary := object["_summary"].(bool); isSummary && existing {
			// New minimized rows preserve only a bounded count, never arbitrary
			// property text. Legacy `keys` arrays are collapsed to their count.
			if keyCount, ok := numericJSONCount(object["key_count"]); ok {
				summary["key_count"] = keyCount
			} else if keys, ok := object["keys"].([]any); ok {
				summary["key_count"] = len(keys)
			}
			if truncated, ok := object["_truncated"].(bool); ok && truncated {
				summary["_truncated"] = true
			}
		} else {
			summary["key_count"] = len(object)
		}
	}
	out, err := json.Marshal(summary)
	if err != nil {
		return nil
	}
	return out
}

func numericJSONCount(value any) (int, bool) {
	switch count := value.(type) {
	case float64:
		if count >= 0 && count <= 1024 && count == float64(int(count)) {
			return int(count), true
		}
	case int:
		if count >= 0 && count <= 1024 {
			return count, true
		}
	}
	return 0, false
}

// parseWindow accepts shorthand window strings ("24h", "7d", "30d")
// and falls back to fallback on parse failure or empty input.
// Clamps to [1h, 90d] so a malformed ?window= can't burn DB time on
// a million-day scan.
func parseWindow(raw string, fallback time.Duration) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	// Stdlib time.ParseDuration handles "24h" but not "7d".
	if strings.HasSuffix(raw, "d") {
		if days, err := strconv.Atoi(strings.TrimSuffix(raw, "d")); err == nil {
			d := time.Duration(days) * 24 * time.Hour
			return clampDuration(d, time.Hour, 90*24*time.Hour, fallback)
		}
	}
	if d, err := time.ParseDuration(raw); err == nil {
		return clampDuration(d, time.Hour, 90*24*time.Hour, fallback)
	}
	return fallback
}

func clampDuration(d, lo, hi, fallback time.Duration) time.Duration {
	if d < lo {
		return fallback
	}
	if d > hi {
		return hi
	}
	return d
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	setPrivateNoStore(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{"code": errCode, "message": msg},
	})
}
