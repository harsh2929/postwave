// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_recover.go — SUB-099 undo redemption.
//
// Reversible bulk metadata verbs (tag / untag) each write a
// single subscriber_bulk_recovery row (migration 1300) carrying a single-use
// recovery_token and a JSON snapshot of the reverse-operation payload. This
// file redeems that token:
//
//   POST /api/v1/subscribers/bulk/recover   { "recovery_token": "..." }
//
// Redemption is idempotent-by-token: a token resolves to exactly one row; the
// handler checks recovery_until > now() AND redeemed_at IS NULL, replays the
// snapshot to restore prior state, then stamps redeemed_at so the token can
// never be redeemed twice. An expired / already-redeemed token returns 200
// with recovery_expired=true so the client can distinguish "window closed"
// from "no such token" (404).
//
// Historical delete and unsubscribe tokens are consumed fail-closed. Privacy
// erasure and consent withdrawal are irreversible; neither may reconstruct PII
// or remove a suppression, even when an older release minted an undo token.

package subscribers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type bulkRecoverInput struct {
	RecoveryToken string `json:"recovery_token"`
}

// BulkRecover POST /api/v1/subscribers/bulk/recover.
func (d *Deps) BulkRecover(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in bulkRecoverInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.RecoveryToken = strings.TrimSpace(in.RecoveryToken)
	if in.RecoveryToken == "" {
		httperror.WriteValidation(w, "missing_token", "recovery_token is required")
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Lock the recovery row FOR UPDATE so two concurrent redemptions of the
	// same token can't both replay the snapshot.
	var (
		operation   string
		snapshotRaw []byte
		affected    int
		expired     bool
	)
	err = tx.QueryRow(r.Context(), `
SELECT operation, subscriber_snapshot, affected_count,
       (recovery_until <= now() OR redeemed_at IS NOT NULL) AS expired
  FROM subscriber_bulk_recovery
 WHERE tenant_id = $1::uuid AND recovery_token = $2
 FOR UPDATE`,
		t.ID, in.RecoveryToken).Scan(&operation, &snapshotRaw, &affected, &expired)
	if err != nil {
		if err == pgx.ErrNoRows {
			httperror.Write(w, http.StatusNotFound, "unknown_token", "recovery token not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if expired {
		// Window closed (or already redeemed). Surface the distinct signal so
		// the client can drop the undo affordance rather than show "failed".
		writeJSON(w, http.StatusOK, BulkResult{
			Source:          "recovery",
			RecoveryExpired: true,
		})
		return
	}

	var snapshot map[string]any
	if err := json.Unmarshal(snapshotRaw, &snapshot); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	restored, err := d.replayRecovery(r.Context(), tx, t.ID, operation, snapshot)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	// Single-use: stamp redeemed_at so the token can never replay again.
	if _, err := tx.Exec(r.Context(), `
UPDATE subscriber_bulk_recovery
   SET redeemed_at = now()
 WHERE tenant_id = $1::uuid AND recovery_token = $2`,
		t.ID, in.RecoveryToken); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	meta := middleware.AuditMetaFromRequest(r)
	meta.TenantID = t.ID
	auditAction := "subscriber.bulk_recovered"
	outcome := "restored"
	if restored == 0 && affected > 0 {
		auditAction = "subscriber.bulk_recovery_rejected"
		outcome = "fail_closed"
	}
	if err := db.Audit(r.Context(), tx, meta, auditAction, "subscribers", "", map[string]any{
		"operation": operation,
		"restored":  restored,
		"skipped":   max(0, affected-restored),
		"outcome":   outcome,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	result := BulkResult{
		Affected: restored,
		Source:   "recovery",
	}
	if operation == "unsubscribe" {
		result.Skipped = affected
		result.Exclusions = map[string]int{"reviewed_resubscribe_required": affected}
	} else if operation == "delete" {
		result.Skipped = affected
		result.Exclusions = map[string]int{"privacy_erasure_irreversible": affected}
	} else if operation == "tag" || operation == "untag" || operation == "add_to_list" {
		// Every replayable operation must account for the difference between
		// what the receipt covered and what the replay actually changed. A row
		// is skipped when the world moved on — a newer profile revision for
		// tags, a deliberate rejoin for list membership. Leaving an operation
		// out of this branch is not a cosmetic omission: the undo reports
		// Skipped:0 and reads as complete while memberships it claimed to
		// remove are still there.
		result.Skipped = max(0, affected-restored)
		if result.Skipped > 0 {
			result.Exclusions = map[string]int{
				"changed_since_operation_or_legacy_receipt": result.Skipped,
			}
		}
	}
	writeJSON(w, http.StatusOK, result)
}

// replayRecovery reverses the recorded operation inside the supplied tenant
// tx, returning the number of rows restored. The snapshot shape is keyed on
// `operation` (see migration 1300 + the per-verb handlers).
func (d *Deps) replayRecovery(ctx context.Context, tx pgx.Tx, tenantID, operation string, snapshot map[string]any) (int, error) {
	switch operation {
	case "delete":
		// Privacy erasure is irreversible. Older releases retained full-row
		// snapshots and minted delete recovery tokens; consume those tokens
		// without replaying the snapshot or removing any suppression.
		return 0, nil
	case "tag":
		// Undo of "tag" is "untag": remove the tag from the affected ids.
		rows, tag := recoveryTagArgs(snapshot)
		return d.replayTagRemove(ctx, tx, tenantID, rows, tag)
	case "untag":
		// Undo of "untag" is "tag": re-add the tag to the affected ids.
		rows, tag := recoveryTagArgs(snapshot)
		return d.replayTagAdd(ctx, tx, tenantID, rows, tag)
	case "add_to_list":
		// Undo of "added to a list" is "remove from that list" — but only the
		// memberships this operation created, and only if they are still the
		// ones it created. See the note where the receipt is written.
		rows, listID := recoveryListArgs(snapshot)
		return d.replayListMembershipRemove(ctx, tx, tenantID, rows, listID)
	case "unsubscribe":
		// Consent withdrawal is no longer automatically reversible. Historical
		// tokens minted by older releases are consumed fail-closed; restoring
		// permission now goes through BulkResubscribe with a complete reviewed
		// evidence envelope. This eliminates stale-status resurrection when a
		// complaint or newer subscriber decision arrives during the old undo
		// window.
		return 0, nil
	default:
		return 0, nil
	}
}

func (d *Deps) replayTagAdd(ctx context.Context, tx pgx.Tx, tenantID string, rows []recoveryTagRow, tag string) (int, error) {
	ids, versions := recoveryTagVersions(rows)
	if len(ids) == 0 || tag == "" {
		return 0, nil
	}
	changedRows, err := tx.Query(ctx, `
UPDATE subscribers AS subscriber
   SET tags = (
         SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(subscriber.tags, ARRAY[]::text[]) || ARRAY[$4]::text[]))
       ),
       updated_at = clock_timestamp()
  FROM unnest($2::uuid[], $3::timestamptz[]) AS expected(id, updated_at)
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id = expected.id
   AND subscriber.updated_at = expected.updated_at
   AND NOT (COALESCE(subscriber.tags, ARRAY[]::text[]) @> ARRAY[$4]::text[])
RETURNING subscriber.id::text`, tenantID, ids, versions, tag)
	if err != nil {
		return 0, err
	}
	changed, err := scanRecoverySubscriberIDs(changedRows)
	if err != nil {
		return 0, err
	}
	if err := d.Repo.appendEngineSyncMany(ctx, tx, tenantID, changed); err != nil {
		return 0, err
	}
	return len(changed), nil
}

func (d *Deps) replayTagRemove(ctx context.Context, tx pgx.Tx, tenantID string, rows []recoveryTagRow, tag string) (int, error) {
	ids, versions := recoveryTagVersions(rows)
	if len(ids) == 0 || tag == "" {
		return 0, nil
	}
	changedRows, err := tx.Query(ctx, `
UPDATE subscribers AS subscriber
   SET tags = array_remove(COALESCE(subscriber.tags, ARRAY[]::text[]), $4),
       updated_at = clock_timestamp()
  FROM unnest($2::uuid[], $3::timestamptz[]) AS expected(id, updated_at)
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id = expected.id
   AND subscriber.updated_at = expected.updated_at
   AND COALESCE(subscriber.tags, ARRAY[]::text[]) @> ARRAY[$4]::text[]
RETURNING subscriber.id::text`, tenantID, ids, versions, tag)
	if err != nil {
		return 0, err
	}
	changed, err := scanRecoverySubscriberIDs(changedRows)
	if err != nil {
		return 0, err
	}
	if err := d.Repo.appendEngineSyncMany(ctx, tx, tenantID, changed); err != nil {
		return 0, err
	}
	return len(changed), nil
}

// recoveryTagArgs pulls the exact post-mutation revisions and tag from a
// tag/untag snapshot. Legacy id-only receipts intentionally return no rows:
// they cannot prove that later profile work would be preserved.
func recoveryTagArgs(snapshot map[string]any) ([]recoveryTagRow, string) {
	tag, _ := snapshot["tag"].(string)
	tag = strings.TrimSpace(tag)
	raw, err := json.Marshal(snapshot["rows"])
	if err != nil {
		return nil, tag
	}
	var rows []recoveryTagRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, tag
	}
	valid := rows[:0]
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		row.ID = strings.TrimSpace(row.ID)
		if row.ID == "" || row.UpdatedAt.IsZero() {
			return nil, tag
		}
		if _, ok := seen[row.ID]; ok {
			return nil, tag
		}
		seen[row.ID] = struct{}{}
		valid = append(valid, row)
	}
	return valid, tag
}

func recoveryTagVersions(rows []recoveryTagRow) ([]string, []time.Time) {
	ids := make([]string, 0, len(rows))
	versions := make([]time.Time, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		versions = append(versions, row.UpdatedAt)
	}
	return ids, versions
}

func scanRecoverySubscriberIDs(rows pgx.Rows) ([]string, error) {
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// coerceStringList normalises a snapshot value that is logically a []string
// but arrives as []any after a JSON round-trip.
func coerceStringList(v any) []string {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, e := range raw {
		if s, ok := e.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

// recoveryListRow is one membership an add-to-list operation made active: the
// subscriber and the exact `added_at` it wrote. Revived is set when the
// operation brought back a membership somebody had removed; it carries that
// tombstone so the undo can restore it.
type recoveryListRow struct {
	ID      string               `json:"id"`
	AddedAt string               `json:"added_at"`
	Revived *recoveryListRevival `json:"revived,omitempty"`
}

// recoveryListRevival is a removed membership as it stood before an
// add-to-list operation revived it.
type recoveryListRevival struct {
	RemovedAt string `json:"removed_at"`
	AddedAt   string `json:"added_at"`
	Source    string `json:"source"`
}

// recoveryListArgs pulls the membership rows and the list from an add_to_list
// snapshot. The list must be a canonical uuid: that is what every receipt the
// current handler writes carries, and a receipt naming anything else (the
// engine id, a malformed value) cannot be replayed safely, so it yields no
// list and the redemption fails closed instead of erroring on a ::uuid cast.
func recoveryListArgs(snapshot map[string]any) ([]recoveryListRow, string) {
	listID, _ := snapshot["list_id"].(string)
	parsed, err := uuid.Parse(strings.TrimSpace(listID))
	if err != nil || parsed.String() != strings.ToLower(strings.TrimSpace(listID)) {
		return nil, ""
	}
	listID = parsed.String()
	raw, err := json.Marshal(snapshot["rows"])
	if err != nil {
		return nil, listID
	}
	var rows []recoveryListRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, listID
	}
	valid := rows[:0]
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		id := strings.TrimSpace(row.ID)
		if id == "" || strings.TrimSpace(row.AddedAt) == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		if row.Revived != nil && (strings.TrimSpace(row.Revived.RemovedAt) == "" ||
			strings.TrimSpace(row.Revived.AddedAt) == "" || strings.TrimSpace(row.Revived.Source) == "") {
			// A revival without its full before-image cannot be restored
			// faithfully; skip it rather than guess.
			continue
		}
		seen[id] = struct{}{}
		valid = append(valid, recoveryListRow{ID: id, AddedAt: row.AddedAt, Revived: row.Revived})
	}
	return valid, listID
}

// replayListMembershipRemove reverses exactly the memberships the receipt names.
//
// Matched on (subscriber, list, added_at) rather than on (subscriber, list). A
// person who left the list and rejoined inside the ten-minute window has a NEW
// membership with a different timestamp, and revoking that would be the undo
// taking away something they asked for after the mistake was made. The row is
// skipped instead, which is the same "a later mutation makes it ineligible"
// rule the tag replay applies through its revision.
//
// A row the operation INSERTED is deleted; a row it REVIVED gets its tombstone
// back. See the two helpers for why each is the prior state.
func (d *Deps) replayListMembershipRemove(ctx context.Context, tx pgx.Tx, tenantID string, rows []recoveryListRow, listID string) (int, error) {
	if len(rows) == 0 || listID == "" {
		return 0, nil
	}
	inserted := make([]recoveryListRow, 0, len(rows))
	revived := make([]recoveryListRow, 0)
	for _, row := range rows {
		if row.Revived != nil {
			revived = append(revived, row)
			continue
		}
		inserted = append(inserted, row)
	}
	removed, err := d.replayListInsertRemove(ctx, tx, tenantID, listID, inserted)
	if err != nil {
		return 0, err
	}
	restored, err := replayListRevivalRestore(ctx, tx, tenantID, listID, revived)
	if err != nil {
		return 0, err
	}
	return removed + restored, nil
}

// replayListInsertRemove hard-deletes memberships the operation created where
// none existed.
//
// `removed_at IS NULL` matters for two separate reasons, and neither is
// hypothetical: every other membership-removal path in this codebase SOFT
// deletes (`lists/membership_write.go`, `lists/membership_sources.go`), so a
// row this operation added and somebody else has since removed is still
// sitting here with its original `added_at`.
//
// Without the predicate the undo hard-deletes that row: it destroys the
// removal tombstone — the record of who left this list and when — to revoke a
// membership that was already revoked, and then counts it in RowsAffected, so
// the undo over-reports what it undid. Neither is what "undo my mistake"
// should mean. Somebody else already undid it; there is nothing to do.
//
// A HARD delete is right for the rows that ARE still ours. They were written
// where no row existed, so restoring the prior state means no row — and a
// tombstone would be a claim that somebody left a list they were never meant
// to be on. The owner row the operation wrote goes with it, or it would keep
// claiming a membership that no longer exists.
func (d *Deps) replayListInsertRemove(ctx context.Context, tx pgx.Tx, tenantID, listID string, rows []recoveryListRow) (int, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	ids := make([]string, 0, len(rows))
	addedAt := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		addedAt = append(addedAt, row.AddedAt)
	}
	removed, err := tx.Query(ctx, `
DELETE FROM list_subscribers AS ls
 USING unnest($3::uuid[], $4::timestamptz[]) AS want(subscriber_id, added_at)
 WHERE ls.tenant_id = $1::uuid
   AND ls.list_id = $2::uuid
   AND ls.subscriber_id = want.subscriber_id
   AND ls.added_at = want.added_at
   AND ls.removed_at IS NULL
RETURNING ls.subscriber_id::text`, tenantID, listID, ids, addedAt)
	if err != nil {
		return 0, err
	}
	revoked, err := scanRecoverySubscriberIDs(removed)
	if err != nil {
		return 0, err
	}
	if len(revoked) == 0 {
		return 0, nil
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM list_subscriber_sources
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND subscriber_id = ANY($3::uuid[])
   AND owner_key = $4`, tenantID, listID, revoked, bulkAddToListOwnerKey); err != nil {
		return 0, err
	}
	if err := d.cancelListJoinedEnrolments(ctx, tx, tenantID, listID, revoked); err != nil {
		return 0, err
	}
	return len(revoked), nil
}

// replayListRevivalRestore puts back the tombstones of memberships the
// operation revived: the original removed_at, added_at and source, exactly as
// they were read (FOR UPDATE) before the revival. Deleting these rows instead
// would erase the record of who left the list and when, which existed before
// the mistake and must exist after its undo.
//
// No list_joined enrolment is cancelled here. A revival is an UPDATE, so the
// AFTER INSERT enrolment trigger never fired for it; any queued run for this
// person belongs to the join they made originally and is not ours to stop.
func replayListRevivalRestore(ctx context.Context, tx pgx.Tx, tenantID, listID string, rows []recoveryListRow) (int, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	ids := make([]string, 0, len(rows))
	opAddedAt := make([]string, 0, len(rows))
	priorRemovedAt := make([]string, 0, len(rows))
	priorAddedAt := make([]string, 0, len(rows))
	priorSource := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		opAddedAt = append(opAddedAt, row.AddedAt)
		priorRemovedAt = append(priorRemovedAt, row.Revived.RemovedAt)
		priorAddedAt = append(priorAddedAt, row.Revived.AddedAt)
		priorSource = append(priorSource, row.Revived.Source)
	}
	restoredRows, err := tx.Query(ctx, `
UPDATE list_subscribers AS ls
   SET removed_at = prior.removed_at,
       added_at   = prior.added_at,
       source     = prior.source
  FROM unnest($3::uuid[], $4::timestamptz[], $5::timestamptz[], $6::timestamptz[], $7::text[])
       AS prior(subscriber_id, op_added_at, removed_at, added_at, source)
 WHERE ls.tenant_id = $1::uuid
   AND ls.list_id = $2::uuid
   AND ls.subscriber_id = prior.subscriber_id
   AND ls.added_at = prior.op_added_at
   AND ls.removed_at IS NULL
RETURNING ls.subscriber_id::text`, tenantID, listID, ids, opAddedAt, priorRemovedAt, priorAddedAt, priorSource)
	if err != nil {
		return 0, err
	}
	restored, err := scanRecoverySubscriberIDs(restoredRows)
	if err != nil {
		return 0, err
	}
	if len(restored) == 0 {
		return 0, nil
	}
	if _, err := tx.Exec(ctx, `
UPDATE list_subscriber_sources
   SET removed_at = now()
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND subscriber_id = ANY($3::uuid[])
   AND owner_key = $4
   AND removed_at IS NULL`, tenantID, listID, restored, bulkAddToListOwnerKey); err != nil {
		return 0, err
	}
	return len(restored), nil
}

// cancelListJoinedEnrolments stops the automations the mistaken add started.
//
// Removing the membership is only half the undo. `list_subscribers` carries an
// AFTER INSERT trigger (`enqueue_list_joined_flow_runs`) that enrols the new
// member in every active journey with a `list_joined` trigger, so one wrong
// segment does not merely put the wrong people on a list — it queues a welcome
// series to each of them. Deleting the row afterwards does not retract that:
// the run is already sitting in `flow_runs`, and the worker will send it.
//
// Scoped to the subscribers whose membership this replay ACTUALLY revoked, not
// to everyone named in the receipt. That is what keeps it honest at the edges:
// somebody who left and deliberately rejoined is skipped above, so their
// enrolment — which belongs to the join they chose — is left alone, and so is
// the enrolment of anyone whose row somebody else had already removed.
//
// CANCELLED, not deleted, and only from `queued`. Cancelled is a real state in
// the table's vocabulary and it preserves the evidence that the enrolment
// happened, which someone asking "why did this person get the welcome email"
// needs. Restricting to `queued` means a run the worker has already picked up
// is left to finish rather than being torn out from under it — the row would be
// gone while the work continued, which is worse than a run that completes and
// is explained by the audit trail.
func (d *Deps) cancelListJoinedEnrolments(ctx context.Context, tx pgx.Tx, tenantID, listID string, subscriberIDs []string) error {
	if len(subscriberIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
UPDATE flow_runs
   SET status = 'cancelled'
 WHERE tenant_id = $1::uuid
   AND subscriber_id = ANY($2::uuid[])
   AND trigger_event_name = 'list_joined'
   AND trigger_payload ->> 'list_id' = $3
   AND status = 'queued'`, tenantID, subscriberIDs, listID)
	return err
}
