package warehouse

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/track"
)

// pollResult is what the object-storage poll path hands back to RunConnection
// so the run's totals, cursor advance, and per-object metrics are wired uniformly.
type pollResult struct {
	rows           []ImportRow
	objectsRead    []string
	advancedCursor string
	parseErrors    []parseError
}

type parseError struct {
	key  string
	line int
	err  error
}

// importPollLimit reads how many object-storage entries a single import run will
// fetch. Defaults small (25) so a backlog never produces a single multi-
// hundred-MB transaction; operators dial it up via config.import_limit
// when they're confident the run window can absorb more.
func importPollLimit(conn Connection) int {
	if conn.Config != nil {
		if raw, ok := conn.Config["import_limit"]; ok {
			switch v := raw.(type) {
			case float64:
				if v > 0 && v <= 1000 {
					return int(v)
				}
			case int:
				if v > 0 && v <= 1000 {
					return v
				}
			}
		}
	}
	return 25
}

// importPrefixFor returns the tenant-relative object-storage prefix that the poller
// scans for new import objects. The prefix is configurable on the
// connection via config.import_prefix; the default mirrors the export
// path so a single bucket round-trips both directions:
//
//	warehouse/imports/<connection_id>/
func importPrefixFor(conn Connection) string {
	if conn.Config != nil {
		if raw, ok := conn.Config["import_prefix"].(string); ok {
			if trimmed := strings.TrimSpace(raw); trimmed != "" {
				return strings.Trim(trimmed, "/") + "/"
			}
		}
	}
	if conn.ID == "" {
		return "warehouse/imports/"
	}
	return "warehouse/imports/" + conn.ID + "/"
}

// pollImportObjects lists new objects under the connection's import prefix
// past `cursor`, fetches each, parses JSONL, and returns the merged rows.
// It is a pure function over the Storage interface so tests can drive it
// with an in-memory store without a database. Each parse failure is
// recorded as a parseError to be persisted as a warehouse_row_errors row
// by the caller — that way one malformed file does not silently swallow
// good rows in the same batch.
func pollImportObjects(ctx context.Context, storage Storage, tenantID string, conn Connection, limit int) (pollResult, error) {
	if storage == nil {
		return pollResult{}, errors.New("storage not configured for object-storage import")
	}
	prefix := importPrefixFor(conn)
	if limit <= 0 {
		limit = 25
	}
	keys, nextCursor, err := storage.List(ctx, tenantID, prefix, conn.LastCursor, limit)
	if err != nil {
		return pollResult{}, err
	}
	out := pollResult{advancedCursor: conn.LastCursor}
	for _, key := range keys {
		body, _, err := storage.Get(ctx, tenantID, key)
		if err != nil {
			out.parseErrors = append(out.parseErrors, parseError{key: key, err: err})
			continue
		}
		rows, parseErrs := parseJSONLObject(body, key)
		_ = body.Close()
		out.rows = append(out.rows, rows...)
		out.parseErrors = append(out.parseErrors, parseErrs...)
		out.objectsRead = append(out.objectsRead, key)
		out.advancedCursor = key
	}
	if nextCursor != "" && nextCursor > out.advancedCursor {
		out.advancedCursor = nextCursor
	}
	return out, nil
}

// parseJSONLObject reads a single JSONL stream into ImportRow records.
// Lines that fail JSON decoding produce a parseError but DO NOT abort the
// scan — partial files are common at the warehouse boundary and the
// alternative (drop everything on one bad row) is exactly the silent
// failure mode the acceptance criterion rules out.
func parseJSONLObject(r io.Reader, sourceKey string) ([]ImportRow, []parseError) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	var rows []ImportRow
	var errs []parseError
	line := 0
	for scanner.Scan() {
		line++
		raw := strings.TrimSpace(scanner.Text())
		if raw == "" {
			continue
		}
		var row ImportRow
		if err := json.Unmarshal([]byte(raw), &row); err != nil {
			errs = append(errs, parseError{key: sourceKey, line: line, err: err})
			continue
		}
		if row.SourceObject == "" {
			row.SourceObject = sourceObjectFromKey(sourceKey)
		}
		rows = append(rows, row)
	}
	if err := scanner.Err(); err != nil {
		errs = append(errs, parseError{key: sourceKey, line: line, err: err})
	}
	return rows, errs
}

// sourceObjectFromKey derives a mapping lookup key from an S3 object key.
// `warehouse/imports/<conn>/orders/2026-06-02.jsonl` → `orders`. The
// fallback (basename without extension) lets ad-hoc uploads work without
// imposing a directory schema; mappings still resolve by source_object.
func sourceObjectFromKey(key string) string {
	key = strings.TrimSuffix(key, ".jsonl")
	key = strings.TrimSuffix(key, ".json")
	key = strings.Trim(key, "/")
	if key == "" {
		return ""
	}
	parts := strings.Split(key, "/")
	// Canonical warehouse/imports/<conn>/<object>/... shape (≥4 parts):
	// the object name is the directory under the connection scope.
	if len(parts) >= 4 && parts[0] == "warehouse" && parts[1] == "imports" {
		return parts[3]
	}
	return parts[len(parts)-1]
}

func materializeImportRows(ctx context.Context, tx pgx.Tx, tenantID, runID string, rows []ImportRow, mappings []ImportMapping) (imported, failed int64, err error) {
	mappingBySource := map[string]ImportMapping{}
	for _, mapping := range mappings {
		if mapping.Status == "active" {
			mappingBySource[mapping.SourceObject] = mapping
		}
	}
	for i, row := range rows {
		source := strings.TrimSpace(row.SourceObject)
		mapping := mappingBySource[source]
		eventName := strings.TrimSpace(row.EventName)
		if eventName == "" {
			eventName = mapping.TargetEventName
		}
		if eventName == "" {
			failed++
			if err := insertRowError(ctx, tx, tenantID, runID, source, i+1, "missing_event_name", "event_name or active mapping target_event_name is required", row); err != nil {
				return imported, failed, err
			}
			continue
		}

		subscriberID := strings.TrimSpace(row.SubscriberID)
		if subscriberID == "" && strings.TrimSpace(row.Email) != "" {
			resolved, err := resolveSubscriberID(ctx, tx, tenantID, row.Email)
			if err != nil {
				return imported, failed, err
			}
			subscriberID = resolved
		}
		if subscriberID == "" {
			failed++
			if err := insertRowError(ctx, tx, tenantID, runID, source, i+1, "subscriber_not_found", "subscriber_id or known email is required", row); err != nil {
				return imported, failed, err
			}
			continue
		}

		// The SAME contract `POST /api/v1/track` enforces.
		//
		// This importer wrote whatever the source object contained. A customer
		// warehouse column holding `Purchase` or `purchase completed` produced a
		// product_events row the track API would have refused — and then the
		// name is unaddressable: a flow trigger on `purchase` never fires for it,
		// a segment condition never matches it, and the event catalog gains a
		// row that looks like a real, separate event.
		//
		// Refused per row rather than normalised. Lower-casing `Purchase` into
		// `purchase` would silently merge two source events on a guess, and the
		// merge is unrecoverable once written. A row error is visible in the run
		// and the operator can fix the mapping.
		if !track.ValidEventName(eventName) {
			failed++
			if rowErr := insertRowError(ctx, tx, tenantID, runID, source, i+1,
				"invalid_event_name",
				fmt.Sprintf("event_name %q must be at most %d characters of lowercase "+
					"snake_case segments separated by dots, matching POST /api/v1/track",
					truncate(eventName, 128), track.MaxEventNameLength),
				row); rowErr != nil {
				return imported, failed, rowErr
			}
			continue
		}

		occurredAt := time.Now().UTC()
		if row.OccurredAt != nil {
			occurredAt = row.OccurredAt.UTC()
		}
		props := map[string]any{}
		for k, v := range row.Raw {
			props[k] = v
		}
		for k, v := range row.Properties {
			props[k] = v
		}
		if source != "" {
			props["_warehouse_source_object"] = source
		}
		propsRaw, _ := json.Marshal(props)
		if _, err := tx.Exec(ctx, `
INSERT INTO product_events (tenant_id, subscriber_id, event_name, properties, occurred_at)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)`,
			tenantID, subscriberID, eventName, string(propsRaw), occurredAt); err != nil {
			failed++
			if rowErr := insertRowError(ctx, tx, tenantID, runID, source, i+1, "insert_failed", err.Error(), row); rowErr != nil {
				return imported, failed, rowErr
			}
			continue
		}
		// The SHAPE contract, from the same place the track API calls it.
		//
		// The naming rule above had one enforcer and one bypass until this
		// importer was made to call it; the property-type rule is written with
		// both callers from the start so it cannot repeat that. A warehouse
		// column whose type changed — an amount stored as text after a schema
		// change upstream — is exactly the drift the report exists to name, and
		// it is MORE likely here than on the API, where a client library
		// usually settles the type.
		types, typeErr := track.PropertyTypes(propsRaw)
		if typeErr == nil {
			typeErr = track.RecordPropertyTypes(ctx, tx, tenantID, eventName, types)
		}
		// The declared check runs on this path too, and must: an importer is
		// exactly where a shape drifts unnoticed, because no client library sits
		// in front of it to settle the types first.
		if typeErr == nil {
			typeErr = track.CheckDeclared(ctx, tx, tenantID, eventName, types)
		}
		// Imported events are reportable too. An importer is the likeliest
		// source of an event name the product has never otherwise seen, so
		// skipping discovery here would make bulk-loaded history unreportable
		// while the same event sent live was fine.
		if typeErr == nil {
			typeErr = track.RecordMetricDiscovery(ctx, tx, tenantID, eventName)
		}
		if typeErr != nil {
			failed++
			if rowErr := insertRowError(ctx, tx, tenantID, runID, source, i+1,
				"property_type_record_failed", typeErr.Error(), row); rowErr != nil {
				return imported, failed, rowErr
			}
			continue
		}
		imported++
	}
	return imported, failed, nil
}

func resolveSubscriberID(ctx context.Context, tx pgx.Tx, tenantID, email string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `
SELECT id::text
FROM subscribers
WHERE tenant_id = $1::uuid AND email = $2::citext
LIMIT 1`, tenantID, strings.TrimSpace(email)).Scan(&id)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", nil
		}
		return "", err
	}
	return id, nil
}

func insertRowError(ctx context.Context, tx pgx.Tx, tenantID, runID, source string, rowNumber int, code, message string, row ImportRow) error {
	raw, _ := json.Marshal(row)
	_, err := tx.Exec(ctx, `
INSERT INTO warehouse_row_errors
    (tenant_id, run_id, source_object, row_number, error_code, error_message, raw_row)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
		tenantID, runID, source, rowNumber, code, truncate(message, 2000), string(raw))
	return err
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return fmt.Sprintf("%s...", s[:n])
}
