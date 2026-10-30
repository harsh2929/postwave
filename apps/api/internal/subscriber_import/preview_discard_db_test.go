// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// An upload that is never confirmed — the operator went Back, uploaded another
// file, or left — used to sit in 'preview' for 24 hours with no way to discard
// it: cancel answered 409 not_cancellable and no other route existed.
func TestDiscardingAnUnconfirmedUploadPurgesItsFileAndReviewDataDB(t *testing.T) {
	flow := newImportFlow(t)
	suffix := uuid.NewString()[:8]
	preview := flow.upload("abandoned.csv", "email,plan\nleft-"+suffix+"@example.com,pro\n")
	flow.preflight(preview.ID)

	var objectKey string
	if err := flow.admin.QueryRow(context.Background(),
		`SELECT object_key FROM subscriber_imports WHERE id = $1::uuid`, preview.ID).Scan(&objectKey); err != nil {
		t.Fatal(err)
	}

	rec := flow.serveJSON(http.MethodPost, "/api/v1/subscriber-imports/"+preview.ID+"/cancel", discardBody)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("discard status=%d body=%s", rec.Code, rec.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["status"] != "cancelled" {
		t.Fatalf("discard response=%v, want status cancelled", response)
	}
	var status string
	var sourceDue, reviewDue *time.Time
	if err := flow.admin.QueryRow(context.Background(), `
SELECT status, source_delete_after, review_data_expires_at
  FROM subscriber_imports WHERE id = $1::uuid`, preview.ID).Scan(&status, &sourceDue, &reviewDue); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(time.Second)
	if status != "cancelled" || sourceDue == nil || sourceDue.After(now) || reviewDue == nil || reviewDue.After(now) {
		t.Fatalf("discarded row status=%q source_due=%v review_due=%v, want cancelled and both due now", status, sourceDue, reviewDue)
	}

	if err := (&Worker{Pool: flow.app, Storage: flow.storage}).purgeExpiredArtifacts(context.Background()); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if deletes := flow.storage.deleteCount(objectKey); deletes != 1 {
		t.Fatalf("uploaded file deletes=%d, want 1", deletes)
	}
	var key, filename string
	var reviewDataPurged bool
	if err := flow.admin.QueryRow(context.Background(), `
SELECT object_key, original_filename,
       sample_rows = '[]'::jsonb AND dry_run_results IS NULL
       AND mapping = '{"headers":[],"columns":[],"rows":0}'::jsonb
  FROM subscriber_imports WHERE id = $1::uuid`, preview.ID).Scan(&key, &filename, &reviewDataPurged); err != nil {
		t.Fatal(err)
	}
	if key != "" || filename != "expired-import.csv" || !reviewDataPurged {
		t.Fatalf("purged discard key=%q filename=%q review_purged=%v", key, filename, reviewDataPurged)
	}

	// A finished import has nothing left to stop or discard.
	rec = flow.serve(http.MethodPost, "/api/v1/subscriber-imports/"+preview.ID+"/cancel", "", nil)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "not_cancellable") {
		t.Fatalf("second discard status=%d body=%s, want 409 not_cancellable", rec.Code, rec.Body.String())
	}
}

// discardBody is what the wizard sends to throw an upload away: a cancel that
// only an unconfirmed upload accepts.
const discardBody = `{"expected_status":"preview"}`

// The wizard discards its draft when the person leaves, and that can race the
// Confirm they just clicked; the Unfinished uploads list can also still show a
// draft another tab confirmed. A discard must never stop the import the person
// started: it answers 409 and leaves the queued import to run.
func TestDiscardNeverCancelsAnImportThatWasConfirmedDB(t *testing.T) {
	flow := newImportFlow(t)
	address := "confirmed-" + uuid.NewString()[:8] + "@example.com"
	preview := flow.upload("confirmed.csv", "email\n"+address+"\n")
	flow.preflight(preview.ID)
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec := flow.serveJSON(http.MethodPost, "/api/v1/subscriber-imports/"+preview.ID+"/cancel", discardBody)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"not_a_preview"`) {
		t.Fatalf("discard of a queued import status=%d body=%s, want 409 not_a_preview", rec.Code, rec.Body.String())
	}
	var status string
	var cancelRequested bool
	if err := flow.admin.QueryRow(context.Background(),
		`SELECT status, cancel_requested FROM subscriber_imports WHERE id = $1::uuid`, preview.ID).
		Scan(&status, &cancelRequested); err != nil {
		t.Fatal(err)
	}
	if status != "queued" || cancelRequested {
		t.Fatalf("the refused discard touched the import: status=%q cancel_requested=%v", status, cancelRequested)
	}
	flow.execute(preview.ID)
	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" || outcome.RowsImported != 1 {
		t.Fatalf("the confirmed import did not run to completion: %+v", outcome)
	}

	// The explicit Cancel button keeps its meaning for a started import.
	running := flow.upload("to-cancel.csv", "email\nstop-"+uuid.NewString()[:8]+"@example.com\n")
	flow.preflight(running.ID)
	if rec := flow.confirm(running.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := flow.serveJSON(http.MethodPost, "/api/v1/subscriber-imports/"+running.ID+"/cancel", "{}"); rec.Code != http.StatusAccepted {
		t.Fatalf("cancel of a queued import status=%d body=%s, want 202", rec.Code, rec.Body.String())
	}

	if rec := flow.serveJSON(http.MethodPost, "/api/v1/subscriber-imports/"+running.ID+"/cancel",
		`{"expected_status":"running"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unsupported expected_status status=%d body=%s, want 400", rec.Code, rec.Body.String())
	}
}

func TestCancelStillRefusesAFinishedImportDB(t *testing.T) {
	flow := newImportFlow(t)
	preview := flow.upload("done.csv", "email\ndone-"+uuid.NewString()[:8]+"@example.com\n")
	flow.preflight(preview.ID)
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)
	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" {
		t.Fatalf("outcome=%+v", outcome)
	}
	rec := flow.serve(http.MethodPost, "/api/v1/subscriber-imports/"+preview.ID+"/cancel", "", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("cancel of a ready import status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" {
		t.Fatalf("a refused cancel changed the import: %+v", outcome)
	}
}
