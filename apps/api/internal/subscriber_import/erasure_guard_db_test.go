// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// deleteContact creates a contact and deletes it through the same repository
// call the dashboard's Delete and bulk delete use, leaving exactly the
// tombstones production leaves.
func (f *importFlow) deleteContact(email string) {
	f.t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.app, f.tenantID)
	if err != nil {
		f.t.Fatal(err)
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'api')
RETURNING id::text`, f.tenantID, email).Scan(&id); err != nil {
		_ = tx.Rollback(ctx)
		f.t.Fatalf("seed contact to delete: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		f.t.Fatal(err)
	}
	if _, err := (&subscribers.Repo{Pool: f.app}).Delete(ctx, f.tenantID, id); err != nil {
		f.t.Fatalf("delete contact: %v", err)
	}
	if got := f.subscriberCount(email); got != 0 {
		f.t.Fatalf("deleted contact still present: %d", got)
	}
}

// eraseByPrivacyRequest leaves the tombstones the privacy-request worker
// writes (privacy/erasure.go): the plaintext is gone and only the SHA-256 of
// the address identifies it, in both the canonical and the oldest store.
func (f *importFlow) eraseByPrivacyRequest(email string) {
	f.t.Helper()
	digest := sha256.Sum256([]byte(strings.ToLower(email)))
	hash := hex.EncodeToString(digest[:])
	placeholder := "erased+" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16] + "@erased.invalid"
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.app, f.tenantID)
	if err != nil {
		f.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id, email, email_sha256, reason, source)
VALUES ($1::uuid, $2::citext, $3, 'dsar_deletion', 'manual')`, f.tenantID, placeholder, hash); err != nil {
		f.t.Fatalf("seed privacy tombstone: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO suppressions (tenant_id, email, email_sha256, reason)
VALUES ($1::uuid, $2::citext, $3, 'dsar_deletion')`, f.tenantID, placeholder, hash); err != nil {
		f.t.Fatalf("seed legacy privacy tombstone: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		f.t.Fatal(err)
	}
}

func TestImportRefusesErasedAddressesInPreflightAndExecutionDB(t *testing.T) {
	flow := newImportFlow(t)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	deleted := "deleted-" + suffix + "@example.com"
	fresh := "fresh-" + suffix + "@example.com"
	privacyErased := "privacy-" + suffix + "@example.com"
	flow.deleteContact(deleted)
	flow.eraseByPrivacyRequest(privacyErased)

	preview := flow.upload("contacts.csv", "email,name\n"+
		strings.ToUpper(deleted)+",Deleted\n"+
		fresh+",Fresh\n"+
		privacyErased+",Erased\n")

	results := flow.preflight(preview.ID)
	if results.RowsTotal != 3 || results.WouldCreate != 1 || results.WouldFail != 2 {
		t.Fatalf("preflight total=%d create=%d fail=%d, want 3/1/2 (rows=%+v)",
			results.RowsTotal, results.WouldCreate, results.WouldFail, results.Rows)
	}
	for _, rowNumber := range []int64{1, 3} {
		row := dryRunRowByNumber(t, results, rowNumber)
		if row.Outcome != outcomeFail || row.ErrorCode != rowCodeErasureBlocked || row.Error != rowMessageErasureBlocked {
			t.Fatalf("preflight row %d = %+v, want erasure_blocked", rowNumber, row)
		}
	}
	if row := dryRunRowByNumber(t, results, 2); row.Outcome != outcomeCreate {
		t.Fatalf("preflight row 2 = %+v, want create", row)
	}

	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)

	outcome := flow.outcome(preview.ID)
	if outcome.Status != "ready" || outcome.RowsImported != 1 || outcome.RowsFailed != 2 {
		t.Fatalf("import outcome=%+v, want ready with 1 imported and 2 failed", outcome)
	}
	if flow.subscriberCount(deleted) != 0 || flow.subscriberCount(privacyErased) != 0 {
		t.Fatal("the import brought an erased contact back")
	}
	if flow.subscriberCount(fresh) != 1 {
		t.Fatal("the import did not create the address nobody erased")
	}
	items := flow.rowErrors(preview.ID)
	if len(items) != 2 {
		t.Fatalf("row errors=%+v, want rows 1 and 3", items)
	}
	for i, rowNumber := range []int{1, 3} {
		item := items[i]
		if item.RowNumber != rowNumber || item.ErrorCode != rowCodeErasureBlocked || item.Error != rowMessageErasureBlocked {
			t.Fatalf("row error %d = %+v, want erasure_blocked for row %d", i, item, rowNumber)
		}
		if strings.Contains(item.Error, "@") {
			t.Fatalf("row error repeats an address: %q", item.Error)
		}
	}
}

// A tombstone written after the preflight never changes subscriber state, so
// the preflight still validates at Confirm and at the worker's start. The
// check inside the chunk's own transaction is what refuses the row.
func TestImportRefusesAddressErasedAfterItsPreflightDB(t *testing.T) {
	flow := newImportFlow(t)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	late := "late-" + suffix + "@example.com"
	kept := "kept-" + suffix + "@example.com"

	preview := flow.upload("contacts.csv", "email\n"+late+"\n"+kept+"\n")
	if results := flow.preflight(preview.ID); results.WouldCreate != 2 || results.WouldFail != 0 {
		t.Fatalf("clean preflight create=%d fail=%d, want 2/0", results.WouldCreate, results.WouldFail)
	}
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.eraseByPrivacyRequest(late)
	flow.execute(preview.ID)

	outcome := flow.outcome(preview.ID)
	if outcome.Status != "ready" || outcome.RowsImported != 1 || outcome.RowsFailed != 1 {
		t.Fatalf("import outcome=%+v, want ready with 1 imported and 1 failed", outcome)
	}
	if flow.subscriberCount(late) != 0 || flow.subscriberCount(kept) != 1 {
		t.Fatalf("late erasure: late=%d kept=%d, want 0/1", flow.subscriberCount(late), flow.subscriberCount(kept))
	}
	items := flow.rowErrors(preview.ID)
	if len(items) != 1 || items[0].RowNumber != 1 || items[0].ErrorCode != rowCodeErasureBlocked {
		t.Fatalf("row errors=%+v, want row 1 erasure_blocked", items)
	}
}
