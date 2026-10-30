// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// What a recipient receives must stop changing once a send has started.
//
// sendloop.loadCampaignBodies reads subject and body_html from the campaigns row
// INSIDE each batch transaction, and Repo.Update had no dispatch predicate. So
// editing a campaign mid-send was accepted: batch 1 delivers version A, someone
// fixes a typo, batches 2..N deliver version B. One "send" produces two
// different emails, nothing records which recipient got which, and the archive
// shows only the last version — so a complaint about the first is unanswerable.
//
// hasDispatchState does not cover this. It rejects a request that CARRIES status
// or scheduled_at, which is about which endpoint owns the lifecycle; a PATCH
// containing only body_html passes it cleanly.

func setStatusDirect(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, id, status string, started bool) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaigns SET status = $3,
       started_at = CASE WHEN $4::bool THEN COALESCE(started_at, now()) ELSE NULL END
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id, status, started); err != nil {
		t.Fatalf("force status %s: %v", status, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func readCampaignRow(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, id string) (subject, name, status string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT subject, name, status FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(&subject, &name, &status); err != nil {
		t.Fatalf("read campaign: %v", err)
	}
	return subject, name, status
}

func TestContentIsFrozenOnceDispatchHasBegun(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	edited := "Corrected subject"

	cases := []struct {
		status  string
		started bool
		why     string
	}{
		{"sending", true, "batches are going out right now"},
		{"sent", true, "every recipient already holds the delivered version; " +
			"editing it rewrites the archive under them"},
		// The case status alone cannot catch. A campaign paused halfway through
		// a send reads 'paused', but some recipients already hold version A —
		// resuming after an edit delivers version B to the rest. This is why the
		// guard keys off started_at and not off a status list.
		{"paused", true, "paused mid-send: some recipients already have version A"},
	}

	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			tenantID := setupTenantQ(t, pool, ctx, "dispatch-freeze")
			id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "freeze-"+tc.status)
			setStatusDirect(t, pool, ctx, tenantID, id, tc.status, tc.started)

			_, err := repo.Update(ctx, tenantID, id, UpdateInput{Subject: &edited})
			if err == nil {
				t.Fatalf("editing the subject was accepted (%s)", tc.why)
			}
			if !errors.Is(err, ErrCampaignDispatching) {
				t.Fatalf("err = %v, want ErrCampaignDispatching", err)
			}
			if subject, _, _ := readCampaignRow(t, pool, ctx, tenantID, id); subject != "subject" {
				t.Fatalf("subject changed to %q despite %s", subject, tc.why)
			}
		})
	}
}

func TestADraftCampaignIsStillEditable(t *testing.T) {
	// The control for the test above. A guard that refused every edit would
	// satisfy it and break authoring entirely.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	tenantID := setupTenantQ(t, pool, ctx, "dispatch-freeze-draft")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "still-editable")
	edited := "Edited while drafting"

	if _, err := repo.Update(ctx, tenantID, id, UpdateInput{Subject: &edited}); err != nil {
		t.Fatalf("a draft campaign was not editable: %v", err)
	}
	if subject, _, _ := readCampaignRow(t, pool, ctx, tenantID, id); subject != edited {
		t.Fatalf("subject = %q, want the edit to land", subject)
	}
}

func TestLifecycleWritesStillWorkOnADispatchingCampaign(t *testing.T) {
	// The second control, and the one that decides the shape of the guard.
	//
	// Repo.Update is the lifecycle writer as well as the authoring writer: the
	// send loop pauses an incomplete campaign through it (send.go), and the
	// sandbox queue path flips to 'sending' through it. A guard drawn around
	// "is the campaign dispatching" rather than "does this input change what is
	// delivered" would deadlock the send loop against its own campaigns.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	tenantID := setupTenantQ(t, pool, ctx, "dispatch-lifecycle")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "lifecycle")
	setStatusDirect(t, pool, ctx, tenantID, id, StatusSending, true)

	if _, err := repo.Update(ctx, tenantID, id, UpdateInput{
		Status: ptrString(StatusPaused),
	}); err != nil {
		t.Fatalf("the send loop could not pause a sending campaign: %v", err)
	}
	if _, _, status := readCampaignRow(t, pool, ctx, tenantID, id); status != StatusPaused {
		t.Fatalf("status = %q, want the pause to land", status)
	}

	// A rename is an internal label, not something a recipient sees.
	renamed := "renamed mid-flight"
	if _, err := repo.Update(ctx, tenantID, id, UpdateInput{Name: &renamed}); err != nil {
		t.Fatalf("renaming a dispatched campaign was refused: %v", err)
	}
	if _, name, _ := readCampaignRow(t, pool, ctx, tenantID, id); name != renamed {
		t.Fatalf("name = %q, want the rename to land", name)
	}
}

func TestEnteringSendingStampsStartedAt(t *testing.T) {
	// started_at is what makes the paused-mid-send case above detectable. The
	// queue route stamped it; Repo.Update and SetStatus did not, so a campaign
	// that reached 'sending' through either carried no record that dispatch had
	// begun — and pausing it would have unfrozen its content.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	readStartedAt := func(tenantID, id string) *time.Time {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("WithTenant: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var at *time.Time
		if err := tx.QueryRow(ctx, `
SELECT started_at FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, id).Scan(&at); err != nil {
			t.Fatalf("read started_at: %v", err)
		}
		return at
	}

	t.Run("via Update", func(t *testing.T) {
		tenantID := setupTenantQ(t, pool, ctx, "stamp-update")
		id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "stamp-update")
		if _, err := repo.Update(ctx, tenantID, id, UpdateInput{
			Status: ptrString(StatusSending),
		}); err != nil {
			t.Fatalf("Update to sending: %v", err)
		}
		if readStartedAt(tenantID, id) == nil {
			t.Fatal("started_at is still NULL after entering sending; a later pause " +
				"would read as 'never dispatched' and unfreeze the content")
		}
	})

	t.Run("via SetStatus resume", func(t *testing.T) {
		tenantID := setupTenantQ(t, pool, ctx, "stamp-setstatus")
		id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "stamp-setstatus")
		setStatusDirect(t, pool, ctx, tenantID, id, StatusPaused, false)
		if _, err := repo.SetStatus(ctx, tenantID, id, []string{StatusPaused}, StatusSending); err != nil {
			t.Fatalf("SetStatus resume: %v", err)
		}
		if readStartedAt(tenantID, id) == nil {
			t.Fatal("started_at is still NULL after a resume into sending")
		}
	})

	t.Run("is monotonic", func(t *testing.T) {
		// A re-queue must not reset it. If it did, the second pause would
		// unfreeze content that the first send had already delivered.
		tenantID := setupTenantQ(t, pool, ctx, "stamp-monotonic")
		id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "stamp-monotonic")
		if _, err := repo.Update(ctx, tenantID, id, UpdateInput{Status: ptrString(StatusSending)}); err != nil {
			t.Fatalf("first send: %v", err)
		}
		first := readStartedAt(tenantID, id)
		if _, err := repo.Update(ctx, tenantID, id, UpdateInput{Status: ptrString(StatusPaused)}); err != nil {
			t.Fatalf("pause: %v", err)
		}
		if _, err := repo.SetStatus(ctx, tenantID, id, []string{StatusPaused}, StatusSending); err != nil {
			t.Fatalf("resume: %v", err)
		}
		if second := readStartedAt(tenantID, id); second == nil || !second.Equal(*first) {
			t.Fatalf("started_at moved from %v to %v across a pause/resume", first, second)
		}
	})
}

func TestTheRefusalIsDistinguishableFromANotFound(t *testing.T) {
	// A caller must be able to tell "this campaign has started" from "no such
	// campaign". The first is a state they can wait out or clone past; the
	// second means their id is wrong. Collapsing them into ErrNotFound would
	// send someone hunting for a record that is right there.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	tenantID := setupTenantQ(t, pool, ctx, "dispatch-errvocab")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "errvocab")
	setStatusDirect(t, pool, ctx, tenantID, id, StatusSending, true)
	edited := "x"

	_, err := repo.Update(ctx, tenantID, id, UpdateInput{Subject: &edited})
	if errors.Is(err, ErrNotFound) {
		t.Fatal("a dispatched campaign reported as not found; the caller cannot " +
			"tell a wrong id from a campaign whose content is frozen")
	}
	if !errors.Is(err, ErrCampaignDispatching) {
		t.Fatalf("err = %v, want ErrCampaignDispatching", err)
	}
}
