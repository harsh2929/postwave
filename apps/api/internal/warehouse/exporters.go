package warehouse

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

func buildExportBundle(ctx context.Context, tx pgx.Tx, tenantID string, objects []string, backfillDays int) ([]byte, int64, map[string]any, error) {
	if backfillDays <= 0 {
		backfillDays = 90
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	totalRows := int64(0)
	perObject := map[string]int64{}
	for _, object := range normalizeObjects(objects) {
		count, err := exportObject(ctx, tx, tenantID, object, backfillDays, zw)
		if err != nil {
			_ = zw.Close()
			return nil, totalRows, nil, err
		}
		perObject[object] = count
		totalRows += count
	}
	manifest, _ := zw.Create("manifest.json")
	_ = json.NewEncoder(manifest).Encode(map[string]any{
		"schema_version": "klv08.warehouse.export.v1",
		"tenant_id":      tenantID,
		"objects":        objects,
		"rows":           perObject,
		"backfill_days":  backfillDays,
	})
	if err := zw.Close(); err != nil {
		return nil, totalRows, nil, err
	}
	return buf.Bytes(), totalRows, map[string]any{
		"rows_by_object": perObject,
		"backfill_days":  backfillDays,
	}, nil
}

func exportObject(ctx context.Context, tx pgx.Tx, tenantID, object string, backfillDays int, zw *zip.Writer) (int64, error) {
	switch object {
	case "profiles":
		return writeJSONL(ctx, tx, zw, "profiles.jsonl", `
SELECT id::text, email::text, status,
       COALESCE(NULLIF(display_name, ''), NULLIF(full_name, ''), '') AS name,
       COALESCE(tags, '{}'::text[]) AS tags,
       COALESCE(custom_fields, '{}'::jsonb) AS custom_fields,
       created_at::text, updated_at::text
FROM subscribers
WHERE tenant_id = $1::uuid`, tenantID)
	case "events":
		return writeJSONL(ctx, tx, zw, "events/subscriber_events.jsonl", `
SELECT id, subscriber_email::text, event_type, COALESCE(campaign_id::text, '') AS campaign_id,
       COALESCE(link_url, '') AS link_url, COALESCE(user_agent, '') AS user_agent,
       COALESCE(host(ip), '') AS ip, at::text
FROM subscriber_events
WHERE tenant_id = $1::uuid AND at >= now() - ($2::int * interval '1 day')`, tenantID, backfillDays)
	case "metrics":
		return writeJSONL(ctx, tx, zw, "metrics/subscriber_event_daily.jsonl", `
SELECT event_type, date_trunc('day', at)::date::text AS day, count(*)::int AS count
FROM subscriber_events
WHERE tenant_id = $1::uuid AND at >= now() - ($2::int * interval '1 day')
GROUP BY event_type, date_trunc('day', at)::date
ORDER BY day, event_type`, tenantID, backfillDays)
	case "campaigns":
		return writeJSONL(ctx, tx, zw, "campaigns.jsonl", `
SELECT id::text, name, COALESCE(subject, '') AS subject, status,
       COALESCE(scheduled_at::text, '') AS scheduled_at, created_at::text
FROM campaigns
WHERE tenant_id = $1::uuid`, tenantID)
	case "flows":
		return writeJSONL(ctx, tx, zw, "flows/automations.jsonl", `
SELECT id::text, name, COALESCE(status, '') AS status, created_at::text
FROM automations
WHERE tenant_id = $1::uuid`, tenantID)
	case "forms":
		return writeJSONL(ctx, tx, zw, "forms.jsonl", `
SELECT id::text, name, slug::text, status, opt_in_mode,
       COALESCE(structure, '{}'::jsonb) AS structure,
       COALESCE(settings, '{}'::jsonb) AS settings,
       created_at::text, updated_at::text
FROM forms
WHERE tenant_id = $1::uuid`, tenantID)
	case "catalog":
		return writeJSONL(ctx, tx, zw, "catalog/products.jsonl", `
SELECT p.id::text, p.integration_id::text, p.source_id, p.title,
       COALESCE(p.url, '') AS url, COALESCE(p.image_url, '') AS image_url,
       p.price_cents, p.currency, COALESCE(p.raw, '{}'::jsonb) AS raw,
       p.created_at::text, p.updated_at::text
FROM commerce_products p
WHERE p.tenant_id = $1::uuid`, tenantID)
	case "custom_objects":
		return writeJSONL(ctx, tx, zw, "custom_objects/records.jsonl", `
SELECT r.id::text, t.key AS object_type, r.external_id,
       COALESCE(r.properties, '{}'::jsonb) AS properties,
       r.created_at::text, r.updated_at::text
FROM custom_object_records r
JOIN custom_object_types t ON t.id = r.object_type_id AND t.tenant_id = r.tenant_id
WHERE r.tenant_id = $1::uuid`, tenantID)
	case "reviews":
		return writeUnavailable(zw, "reviews/unavailable.jsonl", "reviews tables are owned by KLV-11 and not available yet")
	default:
		return 0, fmt.Errorf("unsupported export object: %s", object)
	}
}

func writeJSONL(ctx context.Context, tx pgx.Tx, zw *zip.Writer, filename, query string, args ...any) (int64, error) {
	f, err := zw.Create(filename)
	if err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("query %s: %w", filename, err)
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	names := make([]string, len(fields))
	for i, fd := range fields {
		names[i] = string(fd.Name)
	}
	enc := json.NewEncoder(f)
	var count int64
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return count, err
		}
		row := map[string]any{}
		for i, name := range names {
			row[name] = values[i]
		}
		if err := enc.Encode(row); err != nil {
			return count, err
		}
		count++
	}
	return count, rows.Err()
}

func writeUnavailable(zw *zip.Writer, filename, note string) (int64, error) {
	f, err := zw.Create(filename)
	if err != nil {
		return 0, err
	}
	_, err = f.Write([]byte(`{"_note":` + jsonString(note) + "}\n"))
	return 0, err
}

func jsonString(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}
