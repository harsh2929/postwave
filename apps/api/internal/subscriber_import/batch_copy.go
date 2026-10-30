// SPDX-License-Identifier: AGPL-3.0-only
//
// batch_copy.go — SUB-110 COPY-based / batched-INSERT import path.
//
// The original applyChunk (worker.go) walks a chunk row-at-a-time wrapping
// every INSERT in `SAVEPOINT row_sp` / `RELEASE`. At 100k+ rows that is
// three statements per row (savepoint, insert, release) — the savepoint
// churn dominates wall-clock and connection time once a CSV gets large.
//
// This file replaces the per-row loop with a batched path that mirrors the
// proven pattern in segments/decay.go (DecayRepo.InsertMembershipLogBatch
// uses pgx.CopyFrom):
//
//   - on_existing = skip  (ON CONFLICT DO NOTHING): COPY the whole batch
//     straight into `subscribers`. Postgres drops conflicting rows itself,
//     so there is nothing to savepoint.
//   - on_existing = update (ON CONFLICT DO UPDATE) and `error`:
//     COPY the batch into a per-tx TEMP staging table, then run ONE
//     INSERT … SELECT … ON CONFLICT DO UPDATE (or DO NOTHING / plain) from
//     the staging table into `subscribers`. One round-trip per batch, not
//     three per row.
//
// Validation, file-level dedupe, tag-merging and custom-field shaping stay
// in pure functions (prepareBatchRows / buildRowFields / mergeTags) so they
// are table-tested with no DB. The DB-touching executeBatchedUpsert takes a
// batchTx interface (pgx.Tx in prod, a fake in tests) so the COPY → MERGE
// plumbing is unit-testable.

package subscriber_import

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	migratecsv "github.com/postwave/migrate/csv"
)

// BatchCopySize is the number of accepted rows COPY'd per round-trip on the
// batched path. 1000 keeps each COPY frame comfortably under pgx's buffer
// while still amortising the per-row overhead the SAVEPOINT path paid.
const BatchCopySize = 1000

// preparedRow is one validated, shaped row ready for COPY. email is the
// lower-cased conflict key; tags is the row+job merged tag list;
// customJSON is the pre-marshalled custom_fields jsonb.
type preparedRow struct {
	RowNumber int64
	Email     string
	// Name is the full/display name the row writes (mapped, or derived from
	// first + last by buildRowFields).
	Name           string
	FirstName      string
	LastName       string
	Tags           []string
	CustomJSON     []byte
	RowFingerprint string
}

// preparedBatch is the pure result of validating + shaping a raw chunk.
// Accepted rows are ready for COPY; Errors and Skipped account for every
// row that did not make it so the progress counters stay exact.
type preparedBatch struct {
	Accepted []preparedRow
	Errors   []rowError
	Skipped  int64
}

type numberedRow struct {
	Number int64
	Values []string
}

// prepareBatchRows validates and shapes a raw CSV chunk for the batched
// COPY path. It performs the same gates the per-row loop did — empty/no-@
// email → error, file-level duplicate (already in `seen`) → skip — and
// records every dropped row so processResult stays exact. `seen` is mutated
// so dedupe spans chunks exactly like applyChunk's map.
//
// Pure: no DB, no I/O. The COPY/MERGE step consumes preparedBatch.Accepted.
func prepareBatchRows(rows [][]string, mapping migratecsv.Mapping, opts importOptions, seen map[string]struct{}) preparedBatch {
	numbered := make([]numberedRow, len(rows))
	for i, row := range rows {
		numbered[i] = numberedRow{Number: int64(i + 1), Values: row}
	}
	return prepareNumberedBatchRows(numbered, mapping, opts, seen)
}

func prepareNumberedBatchRows(rows []numberedRow, mapping migratecsv.Mapping, opts importOptions, seen map[string]struct{}) preparedBatch {
	emailCol := emailColumnIndex(mapping)
	out := preparedBatch{Accepted: make([]preparedRow, 0, len(rows))}
	for _, numbered := range rows {
		row := numbered.Values
		email := extractEmail(row, emailCol)
		if email == "" {
			out.Errors = append(out.Errors, rowError{RowNumber: numbered.Number, Code: "invalid_email", Message: "Email is not a valid mailbox address"})
			continue
		}
		if _, dup := seen[email]; dup {
			out.Skipped++
			continue
		}
		seen[email] = struct{}{}
		fields, shapeErr := buildRowFields(row, mapping)
		if shapeErr != nil {
			out.Errors = append(out.Errors, rowError{RowNumber: numbered.Number, Code: "row_shape_invalid", Message: shapeErr.Error()})
			continue
		}
		tags, shapeErr := mergeTags(fields.Tags, opts.Tags)
		if shapeErr != nil {
			out.Errors = append(out.Errors, rowError{RowNumber: numbered.Number, Code: "tag_budget_exceeded", Message: shapeErr.Error()})
			continue
		}
		customJSON, marshalErr := json.Marshal(fields.Custom)
		if marshalErr != nil {
			out.Errors = append(out.Errors, rowError{RowNumber: numbered.Number, Code: "custom_fields_invalid", Message: "Custom fields could not be encoded"})
			continue
		}
		out.Accepted = append(out.Accepted, preparedRow{
			RowNumber:  numbered.Number,
			Email:      email,
			Name:       fields.FullName,
			FirstName:  fields.FirstName,
			LastName:   fields.LastName,
			Tags:       tags,
			CustomJSON: customJSON,
		})
	}
	return out
}

// copyColumns is the column order COPY'd into both `subscribers` (skip
// path) and the staging table (update/error path). Kept as a single
// source of truth so the COPY and the staged INSERT … SELECT never drift.
var copyColumns = []string{
	"tenant_id", "email", "status", "consent_source", "consent_timestamp",
	"consent_email_marketing_at", "tags", "custom_fields", "row_fingerprint",
	"full_name", "display_name", "first_name", "last_name",
}

// copyFromRows converts accepted rows into the COPY column order. Missing or
// partial proof is deliberately unconfirmed/unknown/non-sendable; only a
// complete source + evidence URL + captured-at tuple enables a row.
func copyFromRows(tenantID string, accepted []preparedRow, opts importOptions) [][]interface{} {
	status, source, capturedAt := opts.subscriberStatusAndConsent()
	var emailMarketingAt *time.Time
	if opts.hasConsent() {
		emailMarketingAt = capturedAt
	}
	vals := make([][]interface{}, 0, len(accepted))
	for _, r := range accepted {
		vals = append(vals, []interface{}{
			tenantID, r.Email, status, source, capturedAt, emailMarketingAt,
			r.Tags, string(r.CustomJSON), r.RowFingerprint, r.Name, r.Name,
			r.FirstName, r.LastName,
		})
	}
	return vals
}

// stagingTableName is the per-tx TEMP table the update/error path
// COPYs into before the single staged MERGE. ON COMMIT DROP ties its
// lifetime to the chunk tx so concurrent chunks never collide.
const stagingTableName = "subscriber_import_stage"

// createStagingSQL returns the DDL for the per-tx staging table. It mirrors
// the COPY column set; tags/custom_fields use the same types as subscribers
// so the staged INSERT … SELECT casts cleanly.
func createStagingSQL() string {
	return `CREATE TEMP TABLE ` + stagingTableName + ` (
	tenant_id uuid,
	email text,
	status text,
	consent_source text,
	consent_timestamp timestamptz,
	consent_email_marketing_at timestamptz,
	tags text[],
	custom_fields jsonb,
	row_fingerprint text NOT NULL,
	full_name text NOT NULL,
	display_name text NOT NULL,
	first_name text NOT NULL,
	last_name text NOT NULL
) ON COMMIT DROP`
}

// stagedMergeSQL returns the single INSERT … SELECT … ON CONFLICT statement
// that moves the staging rows into `subscribers`, honouring on_existing with
// the exact same conflict semantics as upsertSQL:
//
//   - update           : DO UPDATE (case-insensitive tag union, jsonb
//     concat, COALESCE consent_timestamp, updated_at = now()).
//   - error            : no conflict clause — a dup raises so the chunk tx
//     aborts (matches the per-row 'error' behaviour).
//   - skip / default   : DO NOTHING (though the skip path normally goes
//     through the direct-COPY route and never reaches here).
//
// The SELECT DISTINCT ON (email) guards against an in-batch duplicate that
// slipped past `seen` (defence in depth) so ON CONFLICT only ever fires
// against pre-existing rows, never two staging rows in the same statement.
func stagedMergeSQL(onExisting string) string {
	base := `INSERT INTO subscribers (tenant_id, email, status, consent_source, consent_timestamp, consent_email_marketing_at, tags, custom_fields, full_name, display_name, first_name, last_name)
SELECT DISTINCT ON (email) tenant_id, email, status, consent_source, consent_timestamp, consent_email_marketing_at, tags, custom_fields, full_name, display_name, first_name, last_name
  FROM ` + stagingTableName + `
 ORDER BY email `
	switch onExisting {
	case "update":
		return base + `ON CONFLICT (tenant_id, email) DO UPDATE SET
	    tags = ARRAY(
	        SELECT tag FROM (
	            SELECT DISTINCT ON (lower(tag)) tag, ord
	              FROM unnest(subscribers.tags || EXCLUDED.tags) WITH ORDINALITY AS u(tag, ord)
	             ORDER BY lower(tag), ord
	        ) dedup ORDER BY ord
	    ),
	    custom_fields = subscribers.custom_fields || EXCLUDED.custom_fields,
	    full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), subscribers.full_name),
	    display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), subscribers.display_name),
	    first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), subscribers.first_name),
	    last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), subscribers.last_name),
	    updated_at = now()`
	case "error":
		return base
	default:
		return base + `ON CONFLICT (tenant_id, email) DO NOTHING`
	}
}

// usesDirectCopy reports whether a chunk can take the fast COPY-straight-
// into-subscribers path that skips the staging table entirely.
//
// A bare COPY cannot express an ON CONFLICT clause, so it raises on the
// first pre-existing (tenant_id, email) — it is ONLY safe when the caller
// can guarantee no row in the batch collides with an existing subscriber.
// Today no import path can make that guarantee, so every strategy (skip,
// update, error) takes the staged-merge route below. The flag is
// kept as a single, documented decision point: a future "fresh-tenant"
// fast path can flip this without touching executeBatchedUpsert's body.
func usesDirectCopy(onExisting string) bool {
	return false
}

// batchTx is the slice of pgx.Tx executeBatchedUpsert needs. The method
// signatures match pgx.Tx exactly so a real tenant tx (db.WithTenant)
// satisfies it directly, while a fake (see batch_copy_test.go) lets the
// COPY → MERGE plumbing be unit-tested without a live Postgres.
type batchTx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	CopyFrom(ctx context.Context, table pgx.Identifier, cols []string, src pgx.CopyFromSource) (int64, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Compile-time guard: the tenant tx db.WithTenant returns (a pgx.Tx) must
// satisfy batchTx so applyChunk can pass it straight into
// executeBatchedUpsert. A pgx bump that changes Exec/CopyFrom breaks here.
var _ batchTx = (pgx.Tx)(nil)

// batchUpsertResult is the per-batch counter split executeBatchedUpsert
// hands back so the chunk loop keeps processResult exact. Imported is the
// merge's RowsAffected (rows inserted, plus updated on the update strategy);
// Skipped is the accepted rows the DB dropped on conflict (skip strategy only
// — update touches every accepted row).
type batchUpsertResult struct {
	Imported int64
	Skipped  int64
	Applied  []appliedSubscriber
}

type appliedSubscriber struct {
	ID             string
	Email          string
	RowFingerprint string
	Operation      string
	StatusBefore   string
	StatusAfter    string
	SendableBefore bool
	SendableAfter  bool
}

func stagedMergeReturningSQL(onExisting string) string {
	conflict := `ON CONFLICT (tenant_id, email) DO NOTHING`
	switch onExisting {
	case "update":
		conflict = `ON CONFLICT (tenant_id, email) DO UPDATE SET
    tags = ARRAY(
        SELECT tag FROM (
            SELECT DISTINCT ON (lower(tag)) tag, ord
              FROM unnest(subscribers.tags || EXCLUDED.tags) WITH ORDINALITY AS u(tag, ord)
             ORDER BY lower(tag), ord
        ) dedup ORDER BY ord
    ),
    custom_fields = subscribers.custom_fields || EXCLUDED.custom_fields,
    full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), subscribers.full_name),
    display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), subscribers.display_name),
    first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), subscribers.first_name),
    last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), subscribers.last_name),
    updated_at = now()`
	case "error":
		conflict = ""
	}
	return `
WITH classified AS MATERIALIZED (
    SELECT st.*,
           s.id AS existing_id,
           s.status AS status_before,
           COALESCE(
               s.status = 'enabled'
               AND s.consent_email_marketing_at IS NOT NULL
               AND s.archived_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM v_suppressions_unified v
                    WHERE v.tenant_id = st.tenant_id
                      AND lower(v.email) = lower(st.email::text)
                      AND (v.expires_at IS NULL OR v.expires_at > now())
               ), false
           ) AS sendable_before
      FROM subscriber_import_stage st
      LEFT JOIN subscribers s
        ON s.tenant_id = st.tenant_id AND s.email = st.email
), applied AS (
    INSERT INTO subscribers (
        tenant_id, email, status, consent_source, consent_timestamp,
		consent_email_marketing_at, tags, custom_fields, full_name, display_name,
		first_name, last_name
    )
    SELECT tenant_id, email, status, consent_source, consent_timestamp,
		   consent_email_marketing_at, tags, custom_fields, full_name, display_name,
		   first_name, last_name
      FROM classified
     ORDER BY email
    ` + conflict + `
    RETURNING id, tenant_id, email, status, consent_email_marketing_at, archived_at
)
SELECT a.id::text,
       a.email::text,
       c.row_fingerprint,
       CASE WHEN c.existing_id IS NULL THEN 'created' ELSE 'updated' END,
       COALESCE(c.status_before, ''),
       a.status,
       c.sendable_before,
       (
           a.status = 'enabled'
           AND a.consent_email_marketing_at IS NOT NULL
           AND a.archived_at IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM v_suppressions_unified v
                WHERE v.tenant_id = a.tenant_id
                  AND lower(v.email) = lower(a.email::text)
                  AND (v.expires_at IS NULL OR v.expires_at > now())
           )
       ) AS sendable_after
  FROM applied a
  JOIN classified c ON c.tenant_id = a.tenant_id AND c.email = a.email
 ORDER BY a.email`
}

// executeBatchedUpsert pushes one prepared batch into `subscribers` inside
// the caller's tenant-scoped tx using the staged-merge route:
//
//	CREATE TEMP … ON COMMIT DROP  →  pgx.CopyFrom into it  →  one
//	INSERT … SELECT … ON CONFLICT  honouring on_existing (stagedMergeSQL).
//
// This replaces the per-row SAVEPOINT loop: three statements per batch
// instead of three per row. The merge's RowsAffected gives the exact
// inserted/updated count, from which the skip count is derived for the
// DO-NOTHING strategy.
//
// It does NOT commit — the caller owns the tx so consent proofs + chunk
// progress attach to the same lifecycle applyChunk always used.
func executeBatchedUpsert(ctx context.Context, tx batchTx, tenantID, onExisting string, accepted []preparedRow, opts importOptions) (batchUpsertResult, error) {
	var res batchUpsertResult
	if len(accepted) == 0 {
		return res, nil
	}
	rows := copyFromRows(tenantID, accepted, opts)

	// Staged-merge path: TEMP table → COPY → single MERGE.
	if _, err := tx.Exec(ctx, createStagingSQL()); err != nil {
		return res, fmt.Errorf("create staging table: %w", err)
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{stagingTableName}, copyColumns, pgx.CopyFromRows(rows)); err != nil {
		return res, fmt.Errorf("copy staging: %w", err)
	}
	// Freeze every currently-existing target before classifying its before
	// state. The caller runs this transaction at SERIALIZABLE isolation, so a
	// concurrent insert into a previously-missing unique key aborts/retries the
	// chunk instead of turning a would-be create into a mislabeled update.
	lockedRows, err := tx.Query(ctx, `
SELECT s.id
  FROM subscriber_import_stage st
  JOIN subscribers s
    ON s.tenant_id = st.tenant_id AND s.email = st.email
 ORDER BY s.tenant_id, s.email
 FOR UPDATE OF s`)
	if err != nil {
		return res, fmt.Errorf("lock existing subscribers: %w", err)
	}
	for lockedRows.Next() {
		// Drain rows so pgx releases the connection for the merge query.
	}
	if err := lockedRows.Err(); err != nil {
		lockedRows.Close()
		return res, fmt.Errorf("lock existing subscriber rows: %w", err)
	}
	lockedRows.Close()
	resultRows, err := tx.Query(ctx, stagedMergeReturningSQL(onExisting))
	if err != nil {
		return res, fmt.Errorf("staged merge: %w", err)
	}
	defer resultRows.Close()
	for resultRows.Next() {
		var applied appliedSubscriber
		if err := resultRows.Scan(&applied.ID, &applied.Email, &applied.RowFingerprint,
			&applied.Operation, &applied.StatusBefore, &applied.StatusAfter,
			&applied.SendableBefore, &applied.SendableAfter); err != nil {
			return res, fmt.Errorf("scan staged merge result: %w", err)
		}
		res.Applied = append(res.Applied, applied)
	}
	if err := resultRows.Err(); err != nil {
		return res, fmt.Errorf("staged merge rows: %w", err)
	}
	res.Imported = int64(len(res.Applied))
	// Rows the DB dropped on a pre-existing-email conflict. Only the
	// DO-NOTHING (skip / default) strategy drops rows; update touches every
	// accepted row, so there is nothing to count as skipped.
	if res.Imported < int64(len(accepted)) && !mergeTouchesEveryRow(onExisting) {
		res.Skipped = int64(len(accepted)) - res.Imported
	}
	return res, nil
}

// mergeTouchesEveryRow reports whether stagedMergeSQL's ON CONFLICT clause
// affects every accepted row (so none are silent skips). DO UPDATE
// (update) and the no-conflict 'error' form touch all rows; the
// DO-NOTHING default drops conflicts.
func mergeTouchesEveryRow(onExisting string) bool {
	switch onExisting {
	case "update", "error":
		return true
	default:
		return false
	}
}
