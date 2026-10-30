// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// loadSettings reads the mcp_server_settings row for the current
// tenant scope.  Returns pgx.ErrNoRows when no row exists — callers
// use that as the "lazy-insert" trigger.
func loadSettings(ctx context.Context, tx pgx.Tx, tenantID string) (*Settings, error) {
	var s Settings
	var lastHS, lastTC *time.Time
	var allowed []string
	err := tx.QueryRow(ctx, `
SELECT tenant_id::text,
       enabled,
       write_enabled,
       COALESCE(allowed_tools, ARRAY[]::text[]),
       last_handshake_at,
       last_tool_call_at
  FROM mcp_server_settings
 WHERE tenant_id = $1::uuid`, tenantID,
	).Scan(&s.TenantID, &s.Enabled, &s.WriteEnabled, &allowed, &lastHS, &lastTC)
	if err != nil {
		return nil, err
	}
	if len(allowed) > 0 {
		s.AllowedTools = allowed
	}
	if lastHS != nil {
		t := lastHS.Format(time.RFC3339)
		s.LastHandshakeAt = &t
	}
	if lastTC != nil {
		t := lastTC.Format(time.RFC3339)
		s.LastToolCallAt = &t
	}
	return &s, nil
}

// updateSettings applies a partial patch to mcp_server_settings.
// Only the non-nil fields in `in` are written. Returns the freshly-
// read row so the handler can echo the post-update state.
func updateSettings(ctx context.Context, tx pgx.Tx, tenantID string, in UpdateSettingsInput) (*Settings, error) {
	// Ensure the row exists.  ON CONFLICT keeps the default values
	// for the columns we're not touching in this call.
	if _, err := tx.Exec(ctx, `
INSERT INTO mcp_server_settings (tenant_id, enabled, write_enabled)
VALUES ($1::uuid, true, false)
ON CONFLICT (tenant_id) DO NOTHING`, tenantID); err != nil {
		return nil, err
	}
	if in.Enabled != nil {
		if _, err := tx.Exec(ctx, `
UPDATE mcp_server_settings SET enabled = $2, updated_at = now()
 WHERE tenant_id = $1::uuid`, tenantID, *in.Enabled); err != nil {
			return nil, err
		}
	}
	if in.WriteEnabled != nil {
		if _, err := tx.Exec(ctx, `
UPDATE mcp_server_settings SET write_enabled = $2, updated_at = now()
 WHERE tenant_id = $1::uuid`, tenantID, *in.WriteEnabled); err != nil {
			return nil, err
		}
	}
	if in.AllowedTools != nil {
		// NULL out when an empty array is supplied so the "all
		// tools" semantics fire on tools/list.
		arg := *in.AllowedTools
		if _, err := tx.Exec(ctx, `
UPDATE mcp_server_settings
   SET allowed_tools = CASE WHEN cardinality($2::text[]) = 0 THEN NULL ELSE $2::text[] END,
       updated_at = now()
 WHERE tenant_id = $1::uuid`, tenantID, arg); err != nil {
			return nil, err
		}
	}
	return loadSettings(ctx, tx, tenantID)
}

// CallLogEntry mirrors mcp_server_call_log for the admin "recent
// calls" panel on the desktop.
type CallLogEntry struct {
	ID        int64     `json:"id"`
	ToolName  string    `json:"tool_name"`
	APIKeyID  string    `json:"api_key_id,omitempty"`
	CalledAt  time.Time `json:"called_at"`
	LatencyMs int       `json:"latency_ms"`
	Outcome   string    `json:"outcome"`
}

// listCallLog returns the N most-recent calls for the current tenant.
func listCallLog(ctx context.Context, tx pgx.Tx, tenantID string, limit int) ([]CallLogEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := tx.Query(ctx, `
SELECT id,
       tool_name,
       COALESCE(api_key_id::text, ''),
       called_at,
       latency_ms,
       outcome
  FROM mcp_server_call_log
 WHERE tenant_id = $1::uuid
 ORDER BY id DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]CallLogEntry, 0, limit)
	for rows.Next() {
		var e CallLogEntry
		if err := rows.Scan(&e.ID, &e.ToolName, &e.APIKeyID, &e.CalledAt, &e.LatencyMs, &e.Outcome); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
