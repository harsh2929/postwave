// SPDX-License-Identifier: AGPL-3.0-only
//
// Package apikeycalls implements per-call observability for API-key-
// authenticated traffic. It writes one row to api_key_calls (migration
// 0174) for every request the API-key auth chain admits, and serves
// the dashboard's MCP guide page from that data.
//
// Why a dedicated table when audit_log exists:
//
//   - audit_log models "human did X to Y" events. Embedding tens of
//     thousands of agent calls per day in the same table pollutes
//     the human-facing audit view + slows the GC sweep.
//   - api_key_calls is narrow (tool name, status, latency) so the
//     per-row cost is cheap and stat aggregations stay cheap.
//
// The "MCP" filter is a UA-based projection on top — there is no
// MCP-specific code path. Any API-key client that wants to show up
// in the MCP dashboard tab can set User-Agent to
// `postwave-mcp-server/<version>`. Forging the UA gets you a row in
// the dashboard but doesn't grant access — the request still passes
// the same API-key + scope + tenant gates as every other call.
package apikeycalls

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// McpUserAgentPrefix is the User-Agent prefix the @postwave/mcp-server
// npm package sets on every API call. The dashboard's MCP page
// filters api_key_calls rows by this prefix.
const McpUserAgentPrefix = "postwave-mcp-server/"

// mcpUserAgentSQLPattern is the PostgreSQL equivalent of
// mcpUserAgentPattern below. MCP-only queries and response normalization must
// use the same closed-cardinality source classifier so a forged prefix cannot
// inject an `other` row that poisons a strictly validated MCP page/stream.
const mcpUserAgentSQLPattern = `^(postwave|moosewave)-mcp-server/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(-[a-z0-9.-]{1,20})?([[:space:](]|$)`

// McpToolHeader is the optional header MCP servers set to record the
// logical tool name (e.g. `subscribers_list`, `campaign_send`). When
// absent, the recorder falls back to deriving a coarse name from the
// request method + first URL path segment.
const McpToolHeader = "X-Postwave-MCP-Tool"

// DryRunHeader signals "execute this in dry-run mode" to mutating
// endpoints that honour it. The recorder always captures the header
// value into api_key_calls.dry_run so the dashboard can render a
// "dry-run" badge even when the called endpoint doesn't actually
// honour the flag.
const DryRunHeader = "X-Postwave-Dry-Run"

// MaxRequestBodyCapture is the upper bound on bytes the recorder
// will mirror into api_key_calls.request_body. Larger payloads are
// truncated with a `_truncated: true` marker so the dashboard's
// replay surface can't try to reconstruct an authentic command from
// half a body.
const MaxRequestBodyCapture = 4 * 1024

// Call is the in-memory shape of an api_key_calls row.
type Call struct {
	ID           int64   `json:"id"`
	TenantID     string  `json:"tenantId"`
	APIKeyID     *string `json:"apiKeyId,omitempty"`
	APIKeyPrefix string  `json:"apiKeyPrefix,omitempty"`
	Method       string  `json:"method"`
	Path         string  `json:"path"`
	QueryString  string  `json:"queryString,omitempty"`
	ToolName     string  `json:"toolName,omitempty"`
	StatusCode   int     `json:"statusCode"`
	LatencyMs    int     `json:"latencyMs"`
	UserAgent    string  `json:"userAgent,omitempty"`
	RemoteIP     string  `json:"remoteIp,omitempty"`
	ErrorCode    string  `json:"errorCode,omitempty"`
	// RequestBody contains shape-only JSON metadata (type + key count), never
	// caller-supplied values or arbitrary property names. Historical rows may
	// predate this minimization and are projected through the same policy by
	// the HTTP handlers before they leave the service.
	RequestBody json.RawMessage `json:"requestBody,omitempty"`
	// DryRun is a caller assertion copied from X-Postwave-Dry-Run. It is not
	// evidence that a target endpoint recognized or enforced dry-run mode.
	DryRun bool `json:"dryRun,omitempty"`
	// DryRunAsserted is the unambiguous additive name for new clients. DryRun
	// remains on the wire for compatibility with existing history consumers.
	DryRunAsserted bool `json:"dryRunAsserted,omitempty"`
	// CostMicros is the operator-billable cost of this call in
	// micros (1e-6 USD). Zero for free calls (subscribers_list);
	// non-zero for tools that fan out to LLM / KMS / per-message
	// charges. The recorder accepts the value via the
	// X-Postwave-Cost-Micros response header so handlers don't have
	// to thread cost through the middleware boundary.
	CostMicros int64     `json:"costMicros"`
	CalledAt   time.Time `json:"calledAt"`
}

// ExecutionListResponse is tenant-bound even when Rows is empty, allowing a
// client to reject a well-formed response from the wrong active workspace.
type ExecutionListResponse struct {
	TenantID      string `json:"tenantId"`
	Rows          []Call `json:"rows"`
	DetailPolicy  string `json:"detailPolicy"`
	EvidenceClass string `json:"evidenceClass"`
	NextBeforeID  *int64 `json:"nextBeforeId,omitempty"`
}

// CostHeader is the response header handlers SET to communicate the
// per-call cost back to the recorder middleware. Format: decimal
// integer of micros. Absent = 0.
const CostHeader = "X-Postwave-Cost-Micros"

// ToolQuota mirrors one mcp_tool_quotas row.
type ToolQuota struct {
	ToolName            string `json:"toolName"`
	DailyLimit          *int   `json:"dailyLimit,omitempty"`
	EstimatedCostMicros int64  `json:"estimatedCostMicros"`
	// UsedToday is the runtime tally (set by GetQuotas when it loads
	// today's count). Not persisted.
	UsedToday int `json:"usedToday"`
}

// IsMCP returns true when the call's User-Agent identifies it as
// originating from the official MCP server. Centralised so the
// dashboard, the recorder, and any future report use the same rule.
func IsMCP(userAgent string) bool {
	return userAgentProduct(userAgent) != "other"
}

// Repo wraps the pgx pool. All inserts/reads go through WithTenant
// so RLS pins per-tenant isolation.
type Repo struct {
	Pool *db.Pool
}

// Insert writes a single api_key_calls row. Errors are logged but
// never fail the parent request — this is observability, not
// load-bearing.
func (r *Repo) Insert(ctx context.Context, c *Call) error {
	if r == nil || r.Pool == nil || c == nil || c.TenantID == "" {
		return errors.New("apikeycalls: insert requires tenant id")
	}
	tx, err := db.WithTenant(ctx, r.Pool, c.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var apiKeyID any
	if c.APIKeyID != nil && *c.APIKeyID != "" {
		apiKeyID = *c.APIKeyID
	}
	var bodyArg any
	if len(c.RequestBody) > 0 {
		bodyArg = string(c.RequestBody)
	}
	// Serialize recorder inserts per tenant across workers and replicas. A
	// sequence value is allocated by INSERT before commit; without this lock,
	// a higher id can commit first and an id-based SSE cursor permanently skips
	// the later-committing lower id. Hash collisions only reduce telemetry
	// concurrency; they cannot cross tenant data or correctness boundaries.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, c.TenantID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO api_key_calls (
    tenant_id, api_key_id, api_key_prefix, method, path, tool_name,
    status_code, latency_ms, user_agent, remote_ip, error_code,
    query_string, request_body, dry_run, cost_micros
)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, NULLIF($13,'')::jsonb, $14, $15)`,
		c.TenantID, ifNilEmpty(apiKeyID), c.APIKeyPrefix, c.Method, c.Path, c.ToolName,
		c.StatusCode, c.LatencyMs, c.UserAgent, c.RemoteIP, c.ErrorCode,
		c.QueryString, ifNilEmpty(bodyArg), c.DryRun, c.CostMicros)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListFilter narrows a List query. All fields are optional; zero
// values mean "any".
type ListFilter struct {
	TenantID string
	MCPOnly  bool
	Tool     string
	APIKeyID string
	Since    *time.Time
	Until    *time.Time
	Limit    int
	BeforeID int64 // cursor: rows with id < BeforeID
}

// List returns calls in reverse-chronological order subject to filter. Public
// handlers admit at most 500 rows and request one extra row to prove whether a
// next page exists, so the internal ceiling is 501.
func (r *Repo) List(ctx context.Context, f ListFilter) ([]Call, error) {
	if f.TenantID == "" {
		return nil, errors.New("apikeycalls: tenant id required")
	}
	limit := f.Limit
	if limit <= 0 || limit > 501 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, f.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// LEFT JOIN api_keys so the response carries the live prefix.
	// COALESCE falls back to the frozen api_key_calls.api_key_prefix
	// (empty in the steady-state path; populated only for legacy
	// recorder versions that wrote it explicitly).
	q := `
SELECT c.id, c.tenant_id::text, c.api_key_id::text,
       COALESCE(NULLIF(c.api_key_prefix,''), k.prefix, '') AS api_key_prefix,
       c.method, c.path,
       COALESCE(c.query_string, '') AS query_string,
       c.tool_name, c.status_code, c.latency_ms,
       c.user_agent, c.remote_ip, c.error_code,
       c.request_body, COALESCE(c.dry_run, false),
       COALESCE(c.cost_micros, 0), c.called_at
  FROM api_key_calls c
  LEFT JOIN api_keys k ON k.id = c.api_key_id
 WHERE c.tenant_id = $1::uuid`
	args := []any{f.TenantID}
	idx := 2
	if f.MCPOnly {
		q += " AND c.user_agent ~* $" + itoa(idx)
		args = append(args, mcpUserAgentSQLPattern)
		idx++
	}
	if f.Tool != "" {
		q += " AND c.tool_name = $" + itoa(idx)
		args = append(args, f.Tool)
		idx++
	}
	if f.APIKeyID != "" {
		q += " AND c.api_key_id = $" + itoa(idx) + "::uuid"
		args = append(args, f.APIKeyID)
		idx++
	}
	if f.Since != nil {
		q += " AND c.called_at >= $" + itoa(idx)
		args = append(args, *f.Since)
		idx++
	}
	if f.Until != nil {
		q += " AND c.called_at <= $" + itoa(idx)
		args = append(args, *f.Until)
		idx++
	}
	if f.BeforeID > 0 {
		q += " AND c.id < $" + itoa(idx)
		args = append(args, f.BeforeID)
		idx++
	}
	q += " ORDER BY c.id DESC LIMIT $" + itoa(idx)
	args = append(args, limit)

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Call{}
	for rows.Next() {
		var c Call
		var apiKeyID *string
		var bodyRaw []byte
		if err := rows.Scan(&c.ID, &c.TenantID, &apiKeyID, &c.APIKeyPrefix,
			&c.Method, &c.Path, &c.QueryString, &c.ToolName, &c.StatusCode, &c.LatencyMs,
			&c.UserAgent, &c.RemoteIP, &c.ErrorCode,
			&bodyRaw, &c.DryRun, &c.CostMicros, &c.CalledAt); err != nil {
			return nil, err
		}
		if apiKeyID != nil && *apiKeyID != "" {
			c.APIKeyID = apiKeyID
		}
		if len(bodyRaw) > 0 {
			c.RequestBody = json.RawMessage(bodyRaw)
		}
		c.DryRunAsserted = c.DryRun
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Stats is the aggregated payload the dashboard renders above the
// execution log. Computed in a single multi-aggregate SQL call so
// the page load is one round-trip.
type Stats struct {
	// TenantID binds this aggregate envelope to the active workspace so a
	// client can reject a well-formed response delivered after tenant switch.
	TenantID         string          `json:"tenantId"`
	WindowHours      int             `json:"windowHours"`
	TotalCalls       int             `json:"totalCalls"`
	SuccessfulCalls  int             `json:"successfulCalls"`
	SuccessRate      float64         `json:"successRate"`
	AverageLatencyMs float64         `json:"averageLatencyMs"`
	P95LatencyMs     int             `json:"p95LatencyMs"`
	LastCallAt       *time.Time      `json:"lastCallAt,omitempty"`
	TopTools         []ToolFrequency `json:"topTools"`
	TopAPIKeys       []KeyFrequency  `json:"topApiKeys"`
	// StatusBreakdown groups calls by HTTP status class (2xx, 3xx,
	// 4xx, 5xx). Each class is omitted when count==0.
	StatusBreakdown []StatusFrequency `json:"statusBreakdown"`
	// TotalCostMicros is the sum of api_key_calls.cost_micros across
	// the window. The dashboard renders this as a dollar figure
	// (micros / 1_000_000) in the headline stat strip.
	TotalCostMicros int64 `json:"totalCostMicros"`
}

// StatusFrequency is one row in Stats.StatusBreakdown.
type StatusFrequency struct {
	// Class is the leading digit of the HTTP status (2|3|4|5).
	Class int `json:"class"`
	Calls int `json:"calls"`
}

// TrendPoint is one bucket in a calls-over-time chart. Buckets are
// aligned to hour boundaries in UTC. Empty buckets are explicit in
// the response so the dashboard's sparkline doesn't have to fill
// gaps client-side.
type TrendPoint struct {
	Bucket time.Time `json:"bucket"`
	Calls  int       `json:"calls"`
}

// TrendResponse binds the aggregate to the active tenant/workspace. Clients
// must verify TenantID before admitting the points into tenant-scoped state.
type TrendResponse struct {
	TenantID    string       `json:"tenantId"`
	Points      []TrendPoint `json:"points"`
	WindowHours int          `json:"windowHours"`
}

// QuotaResponse is advisory observability, not an enforcement receipt. The
// tenant binding protects clients from accepting a same-shape response after a
// workspace switch.
type QuotaResponse struct {
	TenantID        string      `json:"tenantId"`
	Quotas          []ToolQuota `json:"quotas"`
	EnforcementMode string      `json:"enforcementMode"`
	Authoritative   bool        `json:"authoritative"`
	ReleaseHold     string      `json:"releaseHold"`
}

// ToolFrequency is one row in Stats.TopTools.
type ToolFrequency struct {
	ToolName string `json:"toolName"`
	Calls    int    `json:"calls"`
}

// KeyFrequency is one row in Stats.TopAPIKeys.
type KeyFrequency struct {
	APIKeyID     *string `json:"apiKeyId,omitempty"`
	APIKeyPrefix string  `json:"apiKeyPrefix"`
	Calls        int     `json:"calls"`
}

// GetStats computes aggregations over the last `window` for the
// tenant. mcpOnly narrows to MCP-tagged calls.
func (r *Repo) GetStats(ctx context.Context, tenantID string, mcpOnly bool, window time.Duration) (*Stats, error) {
	if tenantID == "" {
		return nil, errors.New("apikeycalls: tenant id required")
	}
	if window <= 0 {
		window = 7 * 24 * time.Hour
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	since := time.Now().UTC().Add(-window)

	mcpFilter := ""
	if mcpOnly {
		mcpFilter = " AND user_agent ~* '" + mcpUserAgentSQLPattern + "'"
	}

	// Headline aggregates in one shot.
	row := tx.QueryRow(ctx, `
SELECT
    COUNT(*)                                                          AS total_calls,
    COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 400)  AS successful_calls,
    COALESCE(AVG(latency_ms), 0)                                      AS avg_latency,
    COALESCE(PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY latency_ms), 0) AS p95_latency,
    MAX(called_at)                                                    AS last_called_at,
    COALESCE(SUM(cost_micros), 0)                                     AS total_cost_micros
  FROM api_key_calls
 WHERE tenant_id = $1::uuid AND called_at >= $2`+mcpFilter,
		tenantID, since)

	s := &Stats{WindowHours: int(window / time.Hour)}
	var lastCalledAt *time.Time
	var p95 float64
	if err := row.Scan(&s.TotalCalls, &s.SuccessfulCalls, &s.AverageLatencyMs,
		&p95, &lastCalledAt, &s.TotalCostMicros); err != nil {
		return nil, err
	}
	s.P95LatencyMs = int(p95)
	s.LastCallAt = lastCalledAt
	if s.TotalCalls > 0 {
		s.SuccessRate = float64(s.SuccessfulCalls) / float64(s.TotalCalls)
	}

	// Top tools (top 5).
	rows, err := tx.Query(ctx, `
SELECT tool_name, COUNT(*) AS cnt
  FROM api_key_calls
 WHERE tenant_id = $1::uuid AND called_at >= $2 AND tool_name <> ''`+mcpFilter+`
   AND tool_name ~ '^[A-Za-z][A-Za-z0-9._:-]{0,95}$'
   AND tool_name !~* '^[0-9a-f]{8}-[0-9a-f-]{27,}$'
   AND length(regexp_replace(tool_name, '[^0-9]', '', 'g')) <= length(tool_name) / 2
 GROUP BY tool_name
 ORDER BY cnt DESC
 LIMIT 5`, tenantID, since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var t ToolFrequency
		if err := rows.Scan(&t.ToolName, &t.Calls); err != nil {
			rows.Close()
			return nil, err
		}
		// Defense in depth for historical rows if the SQL projection changes.
		if safeToolLabel(t.ToolName) == t.ToolName {
			s.TopTools = append(s.TopTools, t)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if s.TopTools == nil {
		s.TopTools = []ToolFrequency{}
	}

	// Top API keys (top 5). Current recorder rows deliberately retain no
	// prefix, so derive the display-safe prefix from the live key exactly as
	// List/listAfterID do. The frozen call-row value remains first for legacy
	// rows whose key was later removed (ON DELETE SET NULL).
	topKeyMCPFilter := ""
	if mcpOnly {
		topKeyMCPFilter = " AND c.user_agent ~* '" + mcpUserAgentSQLPattern + "'"
	}
	rows, err = tx.Query(ctx, `
SELECT c.api_key_id::text,
       COALESCE(NULLIF(c.api_key_prefix,''), k.prefix, '') AS api_key_prefix,
       COUNT(*) AS cnt
  FROM api_key_calls c
  LEFT JOIN api_keys k ON k.id = c.api_key_id AND k.tenant_id = c.tenant_id
 WHERE c.tenant_id = $1::uuid AND c.called_at >= $2`+topKeyMCPFilter+`
 GROUP BY c.api_key_id, COALESCE(NULLIF(c.api_key_prefix,''), k.prefix, '')
 ORDER BY cnt DESC
 LIMIT 5`, tenantID, since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var calls int
		var prefix string
		var keyID *string
		if err := rows.Scan(&keyID, &prefix, &calls); err != nil {
			rows.Close()
			return nil, err
		}
		if k, ok := normalizedKeyFrequency(keyID, prefix, calls); ok {
			s.TopAPIKeys = append(s.TopAPIKeys, k)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if s.TopAPIKeys == nil {
		s.TopAPIKeys = []KeyFrequency{}
	}

	// Status-class breakdown (2xx / 3xx / 4xx / 5xx). Floor-divide
	// avoids per-status cardinality blow-up; the dashboard renders
	// four bars so summing is fine.
	rows, err = tx.Query(ctx, `
SELECT (status_code / 100) AS class, COUNT(*) AS cnt
  FROM api_key_calls
 WHERE tenant_id = $1::uuid AND called_at >= $2`+mcpFilter+`
 GROUP BY class
 ORDER BY class ASC`, tenantID, since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sf StatusFrequency
		if err := rows.Scan(&sf.Class, &sf.Calls); err != nil {
			rows.Close()
			return nil, err
		}
		s.StatusBreakdown = append(s.StatusBreakdown, sf)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if s.StatusBreakdown == nil {
		s.StatusBreakdown = []StatusFrequency{}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// normalizedKeyFrequency is the response-boundary projection for a top-key
// aggregate. The public contract requires a safe prefix, so an ID-only anomaly
// is omitted rather than serialized with an empty/unsafe required field.
// Removed legacy keys remain labelable through their frozen call-row prefix.
func normalizedKeyFrequency(keyID *string, prefix string, calls int) (KeyFrequency, bool) {
	k := KeyFrequency{APIKeyPrefix: safeAPIKeyPrefix(prefix), Calls: calls}
	if keyID != nil && *keyID != "" {
		id := *keyID
		k.APIKeyID = &id
	}
	return k, k.APIKeyPrefix != ""
}

// Trend returns one TrendPoint per hour bucket across the window.
// Empty hours are returned with calls=0 so the dashboard sparkline
// doesn't have to gap-fill. The window is clamped to [1h, 30d] —
// longer windows are aggregated at coarser granularity in v2.
func (r *Repo) Trend(ctx context.Context, tenantID string, mcpOnly bool, window time.Duration) ([]TrendPoint, error) {
	if tenantID == "" {
		return nil, errors.New("apikeycalls: tenant id required")
	}
	if window <= 0 {
		window = 24 * time.Hour
	}
	if window > 30*24*time.Hour {
		window = 30 * 24 * time.Hour
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	mcpFilter := ""
	if mcpOnly {
		mcpFilter = " AND user_agent ~* '" + mcpUserAgentSQLPattern + "'"
	}

	// Derive both boundaries from one PostgreSQL statement timestamp. Mixing an
	// app clock for the start with a DB clock for the end could cross an hour
	// boundary (or drift) and return window+2 buckets. The inclusive series is
	// therefore exactly windowHours+1 points, including the current partial
	// hour, on every call.
	rows, err := tx.Query(ctx, `
WITH bounds AS (
  SELECT statement_timestamp() AS as_of,
         date_trunc('hour', statement_timestamp()) AS end_bucket,
         date_trunc('hour', statement_timestamp()) - ($2::bigint * interval '1 hour') AS start_bucket
), counts AS (
  SELECT date_trunc('hour', called_at) AS bucket, COUNT(*) AS cnt
    FROM api_key_calls, bounds
   WHERE tenant_id = $1::uuid
     AND called_at >= bounds.start_bucket
     AND called_at <= bounds.as_of`+mcpFilter+`
   GROUP BY bucket
)
SELECT b AS bucket, COALESCE(c.cnt, 0) AS calls
  FROM bounds
  CROSS JOIN LATERAL generate_series(bounds.start_bucket, bounds.end_bucket, '1 hour'::interval) AS b
  LEFT JOIN counts c ON c.bucket = b
 ORDER BY bucket ASC`,
		tenantID, int64(window/time.Hour))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TrendPoint{}
	for rows.Next() {
		var p TrendPoint
		if err := rows.Scan(&p.Bucket, &p.Calls); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// PurgeOlderThan deletes api_key_calls rows older than `cutoff`, in every
// tenant. Used by the retention sweeper. Returns the number of rows deleted.
//
// Runs tenant-agnostic (no WithTenant) because the sweeper is a
// platform job, not a tenant request. The query is bounded by a
// LIMIT so a single tick never holds long locks even when a backlog
// has accumulated.
//
// With no tenant bound, row-level security lets this transaction read and
// delete call records only as the retention capability: app.outbox_worker and
// app.retention_worker together (migration 2048's SELECT policy, 1725's worker
// DELETE policy and 2048's RESTRICTIVE delete gate). The SELECT policy is what
// lets the subquery find expired rows at all: a DELETE whose WHERE reads
// columns sees only rows a SELECT policy admits, so without it every tick
// deleted nothing. Both settings are transaction-local and end with the
// transaction.
func (r *Repo) PurgeOlderThan(ctx context.Context, cutoff time.Time, batchSize int) (int, error) {
	if batchSize <= 0 {
		batchSize = 10000
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx,
		`SELECT set_config('app.retention_worker', 'true', true)`); err != nil {
		return 0, fmt.Errorf("apikeycalls purge: set retention scope: %w", err)
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM api_key_calls
 WHERE id IN (
   SELECT id FROM api_key_calls
    WHERE called_at < $1
    ORDER BY id
    LIMIT $2
 )`, cutoff, batchSize)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// DeriveToolName picks a logical tool label for a request when the
// caller doesn't supply X-Postwave-MCP-Tool. We collapse the path
// to its first non-version segment so noise is bounded: every call
// against /api/v1/subscribers/123 maps to "subscribers".
func DeriveToolName(method, path string) string {
	p := strings.Trim(path, "/")
	for _, prefix := range []string{"api/v1/", "api/public/", "api/"} {
		p = strings.TrimPrefix(p, prefix)
	}
	if p == "" {
		return ""
	}
	first := p
	if i := strings.IndexByte(p, '/'); i >= 0 {
		first = p[:i]
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		return first
	}
	return strings.ToLower(method) + ":" + first
}

// itoa returns base-10 ASCII of i without allocating via strconv. The
// SQL builder above calls it once per filter, so a hand-rolled int
// formatter would be silly — just delegate.
func itoa(i int) string {
	// 12 covers Int31 range; List clamps limit to 500 anyway.
	var b [12]byte
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		b[pos] = '-'
	}
	return string(b[pos:])
}

// ifNilEmpty returns "" when v is nil so the SQL NULLIF($2,”)::uuid
// coercion lands NULL into the column rather than choking on a typed
// nil interface.
func ifNilEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// RecorderMiddleware returns a chi-style middleware that records one
// api_key_calls row per request iff the request is API-key
// authenticated AND the tenant context resolved.
//
// Design:
//
//   - Wraps the response writer to capture status code + body size
//     without buffering the body itself.
//   - Hands off the insert to a bounded buffered channel drained by
//     a fixed pool of safego.Go workers (see recorder.go). This
//     replaces the original per-request `go func()` fan-out, which
//     was a DoS amplifier: a slow Postgres pinned one goroutine +
//     one connection per inbound request with no upper bound.
//   - Silently no-ops on session-cookie auth (those calls show up in
//     audit_log instead).
//   - Hard-caps tool_name / user_agent / path length so a pathological
//     client can't blow up the row size.
//
// The Recorder is constructed once at boot via NewRecorder and shared
// across requests. Callers MUST invoke recorder.Close() during
// graceful shutdown to drain the in-flight buffer.
// LegacyHTTPQuotaEnforcementReleased is false until an authenticated endpoint
// invocation can reserve its server-owned tool/key/tenant quota atomically with
// durable usage evidence. Historical configured rows remain visible as
// advisory telemetry but can never 429 traffic or create cross-key availability
// failures while this structural hold is active.
const LegacyHTTPQuotaEnforcementReleased = false

type quotaChecker interface {
	CheckQuota(context.Context, string, string) (bool, int, int, error)
}

// QuotaMiddleware is observation-only while the legacy quota boundary is held.
// The old gate trusted a caller-selected tool header and asynchronously counted
// tenant-wide rows, allowing one key to exhaust another key's label. Keeping the
// middleware mounted but structurally inert prevents stale DB rows from
// reactivating that availability/security defect.
func QuotaMiddleware(repo quotaChecker) func(http.Handler) http.Handler {
	if repo == nil {
		return func(next http.Handler) http.Handler { return next }
	}
	if !LegacyHTTPQuotaEnforcementReleased {
		return func(next http.Handler) http.Handler { return next }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !middleware.IsAPIKeyAuth(r.Context()) {
				next.ServeHTTP(w, r)
				return
			}
			tenant, ok := middleware.TenantFromContext(r.Context())
			if !ok || tenant == nil || tenant.ID == "" {
				next.ServeHTTP(w, r)
				return
			}
			tool := safeCallerToolLabel(r.Header.Get(McpToolHeader))
			if tool == "" {
				tool = DeriveToolName(r.Method, r.URL.Path)
			}
			if tool == "" {
				next.ServeHTTP(w, r)
				return
			}
			cctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			exceeded, dailyLimit, usedToday, err := repo.CheckQuota(cctx, tenant.ID, tool)
			cancel()
			if err == nil && exceeded {
				limit, current := int64(dailyLimit), int64(usedToday)
				entitlement.Write(w, entitlement.Denial{
					Subject:           "api_tool",
					Reason:            entitlement.ReasonQuota,
					Code:              "tool_quota_exceeded",
					Message:           fmt.Sprintf("per-tool daily quota reached for %q (%d/%d)", tool, usedToday, dailyLimit),
					Resource:          tool,
					Limit:             &limit,
					Current:           &current,
					RetryAfterSeconds: 3600,
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func RecorderMiddleware(rec *Recorder) func(http.Handler) http.Handler {
	if rec == nil {
		return func(next http.Handler) http.Handler { return next }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			// Capture only JSON shape metadata as the handler reads it. Caller
			// values are never retained by this observability path.
			bodyCapture := attachJSONBodyCapture(r)
			dryRun := isTruthyHeader(r.Header.Get(DryRunHeader))

			sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(sw, r)
			var capturedBody json.RawMessage
			if bodyCapture != nil {
				capturedBody = bodyCapture.Result()
			}
			// Only record API-key calls. Session-cookie traffic is
			// already covered by audit_log + per-handler tracking.
			if !middleware.IsAPIKeyAuth(r.Context()) {
				return
			}
			tenant, ok := middleware.TenantFromContext(r.Context())
			if !ok || tenant == nil || tenant.ID == "" {
				return
			}
			keyID := middleware.APIKeyIDFromContext(r.Context())
			var keyIDPtr *string
			if keyID != "" {
				keyIDPtr = &keyID
			}
			tool := safeCallerToolLabel(r.Header.Get(McpToolHeader))
			if tool == "" {
				tool = DeriveToolName(r.Method, r.URL.Path)
			}
			// api_key_prefix is intentionally left empty at insert
			// time. The List query LEFT JOINs api_keys to pull the
			// live prefix; the frozen column on this table is the
			// fallback for the rare case where the operator revokes
			// (FK cascades to NULL) the key after it was used.
			// Cost: handlers that know their per-call cost set the
			// X-Postwave-Cost-Micros response header (a decimal int).
			// We parse defensively — invalid values default to 0
			// rather than failing the recorder.
			var costMicros int64
			if raw := sw.Header().Get(CostHeader); raw != "" {
				if v, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil && v > 0 {
					costMicros = v
				}
			}
			call := Call{
				TenantID:     tenant.ID,
				APIKeyID:     keyIDPtr,
				APIKeyPrefix: "",
				Method:       r.Method,
				Path:         capLen(recordedRoutePattern(r), 256),
				QueryString:  queryKeySummary(r),
				ToolName:     capLen(tool, 96),
				StatusCode:   sw.status,
				LatencyMs:    int(time.Since(start) / time.Millisecond),
				UserAgent:    userAgentProduct(r.UserAgent()),
				// IP addresses are not required for Route39 product telemetry and
				// are deliberately omitted rather than retained for 90 days.
				RemoteIP:       "",
				RequestBody:    capturedBody,
				DryRun:         dryRun,
				DryRunAsserted: dryRun,
				CostMicros:     costMicros,
			}
			// Bounded enqueue. Return value intentionally ignored:
			// a full buffer drops the row + bumps
			// apikey_calls_recorder_dropped_total{reason=buffer_full},
			// which is the SLO signal. The HTTP response is already
			// flushed at this point — observability never blocks it.
			_ = rec.Enqueue(call)
		})
	}
}

// jsonBodyCapture is a transparent streaming request-body wrapper. It mirrors
// only the first MaxRequestBodyCapture bytes while the downstream handler
// reads normally; it never pre-reads or drains the request.
type jsonBodyCapture struct {
	source        io.ReadCloser
	buf           bytes.Buffer
	contentLength int64
	totalRead     int64
	complete      bool
	truncated     bool
}

func attachJSONBodyCapture(r *http.Request) *jsonBodyCapture {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	mediaType = strings.ToLower(mediaType)
	if err != nil || (mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json")) {
		return nil
	}
	capture := &jsonBodyCapture{
		source:        r.Body,
		contentLength: r.ContentLength,
		truncated:     r.ContentLength > MaxRequestBodyCapture,
	}
	r.Body = capture
	return capture
}

func (c *jsonBodyCapture) Read(p []byte) (int, error) {
	n, err := c.source.Read(p)
	if n > 0 {
		c.totalRead += int64(n)
		remaining := MaxRequestBodyCapture - c.buf.Len()
		if remaining > 0 {
			copied := n
			if copied > remaining {
				copied = remaining
			}
			_, _ = c.buf.Write(p[:copied])
		}
		if c.totalRead > MaxRequestBodyCapture {
			c.truncated = true
		}
	}
	if errors.Is(err, io.EOF) || (c.contentLength >= 0 && c.totalRead >= c.contentLength) {
		c.complete = true
	}
	return n, err
}

func (c *jsonBodyCapture) Close() error {
	return c.source.Close()
}

// Result returns shape-only metadata after the handler consumed the complete
// body. It deliberately never persists values: secret-like data can appear
// under arbitrary business keys, and root arrays/scalars have no key to redact.
func (c *jsonBodyCapture) Result() json.RawMessage {
	if c == nil || !c.complete {
		return nil
	}
	if c.truncated {
		out, _ := json.Marshal(map[string]any{"_summary": true, "_truncated": true})
		return out
	}
	full := c.buf.Bytes()
	if len(full) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(full, &value); err != nil {
		return nil
	}
	summary := map[string]any{"_summary": true, "type": jsonValueType(value)}
	if asObj, ok := value.(map[string]any); ok {
		summary["key_count"] = len(asObj)
	}
	out, err := json.Marshal(summary)
	if err != nil {
		return nil
	}
	return out
}

func jsonValueType(v any) string {
	switch v.(type) {
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case nil:
		return "null"
	default:
		return "unknown"
	}
}

// secretKeyMatches is retained for migration/scrubbing helpers and tests.
// New recorder rows never retain values at all.
var secretKeyMatches = []string{
	"password", "token", "secret", "api_key", "apikey",
	"auth", "credential", "signing_key", "private_key",
}

// redactSecretKeys walks a JSON object and replaces any value whose
// key matches the secretKeyMatches list with the literal string
// "***redacted***". Recurses into nested objects + arrays. Operates
// in-place to avoid extra allocations.
func redactSecretKeys(m map[string]any) {
	for k, v := range m {
		lk := strings.ToLower(k)
		redact := false
		for _, p := range secretKeyMatches {
			if strings.Contains(lk, p) {
				redact = true
				break
			}
		}
		if redact {
			m[k] = "***redacted***"
			continue
		}
		switch vv := v.(type) {
		case map[string]any:
			redactSecretKeys(vv)
		case []any:
			for _, item := range vv {
				if subm, ok := item.(map[string]any); ok {
					redactSecretKeys(subm)
				}
			}
		}
	}
}

func recordedRoutePattern(r *http.Request) string {
	if r == nil {
		return "/unmatched"
	}
	if routeCtx := chi.RouteContext(r.Context()); routeCtx != nil {
		if pattern := strings.TrimSpace(routeCtx.RoutePattern()); pattern != "" {
			return pattern
		}
	}
	// Never fall back to the concrete URL: it may contain email addresses,
	// tokens, slugs, or opaque resource identifiers.
	return "/unmatched"
}

func queryKeySummary(r *http.Request) string {
	if r == nil || r.URL == nil || r.URL.RawQuery == "" {
		return ""
	}
	values := r.URL.Query()
	return "key_count=" + strconv.Itoa(len(values))
}

var (
	knownCatalogToolsOnce sync.Once
	knownCatalogTools     map[string]struct{}
	toolLabelPattern      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._:-]{0,95}$`)
	uuidLikeToolPattern   = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f-]{27,}$`)
	mcpUserAgentPattern   = regexp.MustCompile(`(?i)^(postwave|moosewave)-mcp-server/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(-[a-z0-9.-]{1,20})?([ \t(]|$)`)
)

func safeCallerToolLabel(tool string) string {
	tool = safeToolLabel(tool)
	if tool == "" {
		return ""
	}
	knownCatalogToolsOnce.Do(func() {
		knownCatalogTools = make(map[string]struct{})
		var entries []struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(CatalogJSON, &entries) != nil {
			return
		}
		for _, entry := range entries {
			if normalized := safeToolLabel(entry.Name); normalized != "" {
				knownCatalogTools[normalized] = struct{}{}
			}
		}
	})
	if _, known := knownCatalogTools[tool]; !known {
		return ""
	}
	return tool
}

func safeToolLabel(tool string) string {
	tool = strings.TrimSpace(tool)
	if !toolLabelPattern.MatchString(tool) || uuidLikeToolPattern.MatchString(tool) {
		return ""
	}
	digits := 0
	for _, char := range tool {
		if char >= '0' && char <= '9' {
			digits++
		}
	}
	if digits > len(tool)/2 {
		return ""
	}
	return tool
}

func userAgentProduct(userAgent string) string {
	match := mcpUserAgentPattern.FindString(strings.TrimSpace(userAgent))
	if match == "" {
		return "other"
	}
	// The classifier permits an optional product separator after the exact
	// version token; never return that caller-controlled suffix.
	product := strings.TrimRight(match, " \t(")
	return strings.ToLower(product)
}

// isTruthyHeader returns true for "1", "true", "yes", "on" (case
// insensitive). Mirrors the convention the rest of the codebase
// uses for boolean-ish env vars; the dry-run header reuses it.
func isTruthyHeader(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// statusWriter sniffs the response status without buffering the body.
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wrote {
		s.status = code
		s.wrote = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if !s.wrote {
		s.status = http.StatusOK
		s.wrote = true
	}
	return s.ResponseWriter.Write(b)
}

// Flush forwards through the writer chain (SSE streams). Every authenticated
// request passes this recorder, so a flush dropped here would stall every
// stream behind it.
func (s *statusWriter) Flush() {
	if !s.wrote {
		s.status = http.StatusOK
		s.wrote = true
	}
	_ = http.NewResponseController(s.ResponseWriter).Flush()
}

// Unwrap exposes the wrapped writer to http.ResponseController.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func capLen(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// clientIP delegates to the process-wide trusted-proxy resolver. Forwarded
// headers are accepted only when the TCP peer belongs to an explicitly
// configured trusted proxy network.
func clientIP(r *http.Request) string {
	return middleware.ResolveClientIPString(r, true)
}

// asUUID is a small helper for code paths that scan UUID columns
// into *string via pgx.
var _ = pgx.ErrNoRows
