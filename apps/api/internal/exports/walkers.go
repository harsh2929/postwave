// SPDX-License-Identifier: AGPL-3.0-only
//
// walkers.go — per-resource JSONL streamers. Each writes one file
// into the zip and returns the row count.
//
// Convention:
//   * One file per resource, named `<resource>.jsonl`.
//   * One JSON object per line; pretty-printed JSON would balloon
//     the bundle 3-5x for no benefit (the consumer parses it line by
//     line either way).
//   * The query is bounded per resource so we don't accidentally
//     dump 50M subscriber_events rows. The bounds match what an
//     auditor or porting customer actually needs.

package exports

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// rowQuerier is the read surface walkRows needs. Both *pgxpool.Conn and pgx.Tx
// satisfy it, so the walkers run against either a pooled connection or a
// worker-scope transaction.
type rowQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func (w *Worker) walkResource(ctx context.Context, conn rowQuerier, tenantID, resource string, zw *zip.Writer) (int64, error) {
	switch resource {
	case "subscribers":
		return walkRows(ctx, conn, zw, "subscribers.jsonl", `
SELECT id::text, email::text, status,
       COALESCE(name, ''), COALESCE(custom_fields, '{}'::jsonb),
       created_at::text, updated_at::text
  FROM subscribers
 WHERE tenant_id = $1::uuid`, tenantID)
	case "campaigns":
		return walkRows(ctx, conn, zw, "campaigns.jsonl", `
SELECT id::text, name, COALESCE(subject, ''), status,
       COALESCE(scheduled_at::text, ''), created_at::text
  FROM campaigns
 WHERE tenant_id = $1::uuid`, tenantID)
	case "automations":
		return walkRows(ctx, conn, zw, "automations.jsonl", `
SELECT id::text, name, COALESCE(status, ''), created_at::text
  FROM automations
 WHERE tenant_id = $1::uuid`, tenantID)
	case "audit_log":
		return walkRows(ctx, conn, zw, "audit_log.jsonl", `
SELECT id, action,
       COALESCE(resource_type, ''), COALESCE(resource_id, ''),
       COALESCE(actor_type, ''), COALESCE(actor_label, ''),
       COALESCE(host(ip), ''), COALESCE(metadata, '{}'::jsonb),
       at::text
  FROM audit_log
 WHERE tenant_id = $1::uuid AND at > now() - INTERVAL '365 days'`, tenantID)
	case "lists":
		return walkRows(ctx, conn, zw, "lists.jsonl", `
SELECT id::text, name, COALESCE(description, ''),
       created_at::text
  FROM lists
 WHERE tenant_id = $1::uuid`, tenantID)
	case "tags":
		return walkRows(ctx, conn, zw, "tags.jsonl", `
SELECT id::text, name, COALESCE(color, ''), created_at::text
  FROM tags
 WHERE tenant_id = $1::uuid`, tenantID)
	case "events":
		return walkRows(ctx, conn, zw, "subscriber_events.jsonl", `
SELECT id, COALESCE(subscriber_email, ''), event_type,
       COALESCE(campaign_id::text, ''),
       COALESCE(metadata, '{}'::jsonb), at::text
  FROM subscriber_events
 WHERE tenant_id = $1::uuid AND at > now() - INTERVAL '90 days'`, tenantID)
	case "templates":
		// campaign_templates is the tenant's saved template library.
		// We export ONLY tenant-owned rows (tenant_id = $1) — the shared
		// platform/gallery templates (tenant_id IS NULL) are Moosewave's,
		// not the tenant's data, so they stay out of the portability
		// bundle. No secret columns exist on this table.
		return walkRows(ctx, conn, zw, "templates.jsonl", `
SELECT id::text, slug, name, COALESCE(description, ''),
       COALESCE(category, ''), COALESCE(subject, ''),
       COALESCE(preview_text, ''), COALESCE(body_html, ''),
       COALESCE(body_mjml, ''), COALESCE(variables, '[]'::jsonb),
       COALESCE(tags, '{}'::text[]), created_at::text, updated_at::text
  FROM campaign_templates
 WHERE tenant_id = $1::uuid`, tenantID)
	case "segments":
		// query_ast is the segment definition (filter logic), not a
		// secret — it's the customer's own targeting rules.
		return walkRows(ctx, conn, zw, "segments.jsonl", `
SELECT id::text, name, COALESCE(description, ''),
       COALESCE(query_ast, '{}'::jsonb),
       COALESCE(last_count, 0),
       COALESCE(last_evaluated_at::text, ''),
       created_at::text, updated_at::text
  FROM segments
 WHERE tenant_id = $1::uuid`, tenantID)
	case "forms":
		// Popup / landing opt-in forms. structure + settings are the
		// form's own config (fields, opt-in copy), not credentials.
		return walkRows(ctx, conn, zw, "forms.jsonl", `
SELECT id::text, slug::text, name, opt_in_mode,
       COALESCE(structure, '{}'::jsonb), COALESCE(settings, '{}'::jsonb),
       status, created_at::text, updated_at::text
  FROM forms
 WHERE tenant_id = $1::uuid`, tenantID)
	case "suppressions":
		// Suppression list — emails the tenant must keep suppressed when
		// they leave. Critical for no-lock-in compliance portability.
		return walkRows(ctx, conn, zw, "suppressions.jsonl", `
SELECT id::text, email::text, COALESCE(reason, ''), created_at::text
  FROM suppressions
 WHERE tenant_id = $1::uuid`, tenantID)
	case "consent":
		// GDPR consent ledger — the proof of permission a tenant needs to
		// carry with them. IP/UA are part of the consent evidence (same
		// as the audit_log export) and are intentionally included; there
		// are no API keys / tokens / provider secrets on this table.
		return walkRows(ctx, conn, zw, "consent_records.jsonl", `
SELECT id::text, COALESCE(subscriber_id::text, ''), email::text,
       channel, consent_status, source, COALESCE(source_url, ''),
       COALESCE(form_id::text, ''), COALESCE(host(ip_addr), ''),
       COALESCE(user_agent, ''), captured_at::text,
       COALESCE(expires_at::text, ''), COALESCE(evidence, '{}'::jsonb),
       created_at::text
  FROM consent_records
 WHERE tenant_id = $1::uuid`, tenantID)
	}
	return 0, fmt.Errorf("unsupported resource: %s", resource)
}

// walkRows streams rows from the supplied SELECT into a JSONL file
// inside the zip. The SELECT MUST take a single $1::uuid tenant
// parameter; column order doesn't matter (we map all columns by
// name via Values()).
func walkRows(ctx context.Context, conn rowQuerier, zw *zip.Writer, filename, sql, tenantID string) (int64, error) {
	f, err := zw.Create(filename)
	if err != nil {
		return 0, err
	}
	rows, err := conn.Query(ctx, sql, tenantID)
	if err != nil {
		// Missing table (schema variance across deployments) is
		// non-fatal — write a placeholder note + return 0 rows so
		// the export still succeeds for the resources that exist.
		_, _ = f.Write([]byte(`{"_note":"resource unavailable in this deployment","error":` +
			jsonString(err.Error()) + "}\n"))
		return 0, nil
	}
	defer rows.Close()
	fieldDescs := rows.FieldDescriptions()
	colNames := make([]string, len(fieldDescs))
	for i, fd := range fieldDescs {
		colNames[i] = string(fd.Name)
	}
	var count int64
	enc := json.NewEncoder(f)
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return count, err
		}
		obj := make(map[string]any, len(colNames))
		for i, name := range colNames {
			obj[name] = vals[i]
		}
		if err := enc.Encode(obj); err != nil {
			return count, err
		}
		count++
	}
	return count, rows.Err()
}

// jsonString is a tiny helper that returns a JSON-quoted string,
// used by the missing-table fallback path.
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
