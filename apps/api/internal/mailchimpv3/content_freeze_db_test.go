// SPDX-License-Identifier: AGPL-3.0-only

package mailchimpv3

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// PUT /campaigns/{id}/content is the second door into the mid-send edit.
//
// campaigns.Repo.Update grew a dispatch freeze; this endpoint writes body_html,
// plain_text, body_mjml and content_blocks with its own SQL and had no
// predicate at all. It is a public compatibility surface, so anyone holding an
// API key could do through it exactly what the canonical surface now refuses.

func mcTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping mailchimp compat SQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedFreezeCampaign(t *testing.T, pool *db.Pool, ctx context.Context, status string, started bool) (tenantID, campaignID string) {
	t.Helper()
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	slug := "mc-freeze-" + tenantID[:8]
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, started_at)
VALUES ($1::uuid, 'compat', 'subject', $2, '<p>original</p>',
        CASE WHEN $3::bool THEN now() - interval '1 hour' ELSE NULL END)
RETURNING id::text`, tenantID, status, started).Scan(&campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM campaigns WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID, campaignID
}

func readBody(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, id string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var body string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(body_html, '') FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(&body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	return body
}

func readStatus(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, id string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	if err := tx.QueryRow(ctx, `
SELECT status FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	return status
}

func TestCompatContentEndpointRefusesADispatchedCampaign(t *testing.T) {
	pool := mcTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	for _, tc := range []struct {
		name    string
		status  string
		started bool
	}{
		{"sending", "sending", true},
		{"sent", "sent", true},
		{"paused mid-send", "paused", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tenantID, id := seedFreezeCampaign(t, pool, ctx, tc.status, tc.started)
			_, err := repo.UpdateCampaignContent(ctx, &middleware.Tenant{ID: tenantID}, id,
				CampaignContent{HTML: "<p>rewritten mid-flight</p>"})
			if !errors.Is(err, ErrCampaignDispatching) {
				t.Fatalf("err = %v, want ErrCampaignDispatching", err)
			}
			if body := readBody(t, pool, ctx, tenantID, id); body != "<p>original</p>" {
				t.Fatalf("body_html changed to %q on a %s campaign", body, tc.status)
			}
		})
	}
}

func TestCompatContentEndpointStillEditsADraft(t *testing.T) {
	pool := mcTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	tenantID, id := seedFreezeCampaign(t, pool, ctx, "draft", false)

	if _, err := repo.UpdateCampaignContent(ctx, &middleware.Tenant{ID: tenantID}, id,
		CampaignContent{HTML: "<p>edited</p>"}); err != nil {
		t.Fatalf("a draft was not editable through the compat surface: %v", err)
	}
	if body := readBody(t, pool, ctx, tenantID, id); body != "<p>edited</p>" {
		t.Fatalf("body_html = %q, want the edit to land", body)
	}
}

func TestCompatContentEndpointStillReportsNotFound(t *testing.T) {
	// The disambiguation must not swallow a genuine wrong id into the new
	// conflict error.
	pool := mcTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	tenantID, _ := seedFreezeCampaign(t, pool, ctx, "draft", false)

	_, err := repo.UpdateCampaignContent(ctx, &middleware.Tenant{ID: tenantID},
		"00000000-0000-0000-0000-00000000dead", CampaignContent{HTML: "<p>x</p>"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for an id that does not exist", err)
	}
}

// cancel-send on a partially-sent campaign must not manufacture a "draft".
//
// Both the unschedule and cancel-send actions used to set status='draft'
// unconditionally. With content frozen on started_at that produced an
// inescapable state: the campaign reads 'draft' everywhere, so the operator is
// shown a fully editable draft, and every edit then returns "this campaign has
// started sending" — contradicting the status in front of them. The remedy the
// error suggests is to duplicate, which on this same surface used to copy
// started_at forward and produce another campaign in the same dead state.
func TestCancelSendOnADispatchedCampaignIsCancelledNotDraft(t *testing.T) {
	pool := mcTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	t.Run("dispatched becomes cancelled", func(t *testing.T) {
		tenantID, id := seedFreezeCampaign(t, pool, ctx, "sending", true)
		if _, err := repo.CampaignAction(ctx, &middleware.Tenant{ID: tenantID}, id, "cancel-send", nil); err != nil {
			t.Fatalf("cancel-send: %v", err)
		}
		if got := readStatus(t, pool, ctx, tenantID, id); got != "cancelled" {
			t.Fatalf("status=%q, want cancelled: a partially-sent campaign shown "+
				"as an editable draft that refuses every edit is a dead end", got)
		}
	})

	t.Run("never-dispatched returns to draft", func(t *testing.T) {
		tenantID, id := seedFreezeCampaign(t, pool, ctx, "scheduled", false)
		if _, err := repo.CampaignAction(ctx, &middleware.Tenant{ID: tenantID}, id, "unschedule", nil); err != nil {
			t.Fatalf("unschedule: %v", err)
		}
		if got := readStatus(t, pool, ctx, tenantID, id); got != "draft" {
			t.Fatalf("status=%q, want draft — nothing was delivered, so the "+
				"campaign is still authorable", got)
		}
		if _, err := repo.UpdateCampaignContent(ctx, &middleware.Tenant{ID: tenantID}, id,
			CampaignContent{HTML: "<p>edited after unschedule</p>"}); err != nil {
			t.Fatalf("an unscheduled campaign was not editable: %v", err)
		}
	})
}

// The replica must be editable — this is the remedy the freeze recommends.
//
// cloneableCampaignColumns is the THIRD hand-maintained exclusion map in the
// codebase (after campaign_clone and resend_unopened), and it was missing
// started_at like the other two. Here the consequence is circular: the freeze's
// own error tells the operator to "duplicate it to send a revised version", and
// on this surface duplicating produced a draft carrying the parent's start
// instant — frozen forever, since the stamp is monotonic and replicating again
// copies it forward.
func TestReplicaOfADispatchedCampaignIsEditable(t *testing.T) {
	pool := mcTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	tenantID, srcID := seedFreezeCampaign(t, pool, ctx, "sent", true)

	replica, err := repo.ReplicateCampaign(ctx, &middleware.Tenant{ID: tenantID}, srcID, false)
	if err != nil {
		t.Fatalf("replicate: %v", err)
	}
	if replica.ID == "" {
		t.Fatal("replicate returned no id")
	}

	// The point of the replica: it can be edited.
	if _, err := repo.UpdateCampaignContent(ctx, &middleware.Tenant{ID: tenantID}, replica.ID,
		CampaignContent{HTML: "<p>the revised version</p>"}); err != nil {
		t.Fatalf("the replica was not editable: %v — the freeze tells operators to "+
			"duplicate, so a frozen duplicate is a closed loop with no way out", err)
	}
	if body := readBody(t, pool, ctx, tenantID, replica.ID); body != "<p>the revised version</p>" {
		t.Fatalf("replica body_html = %q, want the edit to land", body)
	}
}

// PUT /3.0/campaigns/{id}/multivariate writes the same campaign_variants rows
// the send loop reads per batch, so it needs the same freeze as the canonical
// A/B writer. It also rewrites campaigns.campaign_type, which is frozen content,
// and DELETEs the arms the client omitted — stranding every pending recipient
// already assigned to a deleted arm on "campaign body missing".
func TestMultivariateUpsertIsFrozenOnceDispatched(t *testing.T) {
	pool := mcTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	in := MultivariateTestInput{
		WinnerMetric:          "opens",
		EvaluationWindowHours: 24,
		SamplePct:             20,
		WinnerRecipientsPct:   80,
		Variations: []MultivariateVariationInput{
			{Label: "A", SubjectLine: "Rewritten mid-flight", Weight: 50},
			{Label: "B", SubjectLine: "Also rewritten", Weight: 50},
		},
	}

	t.Run("refused once dispatched", func(t *testing.T) {
		tenantID, id := seedFreezeCampaign(t, pool, ctx, "sending", true)
		if _, err := repo.UpsertMultivariateTest(ctx, &middleware.Tenant{ID: tenantID}, id, in); !errors.Is(err, ErrCampaignDispatching) {
			t.Fatalf("err = %v, want ErrCampaignDispatching", err)
		}
		tx, terr := db.WithTenant(ctx, pool, tenantID)
		if terr != nil {
			t.Fatal(terr)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var n int
		if err := tx.QueryRow(ctx, `
SELECT count(*)::int FROM campaign_variants WHERE campaign_id = $1::uuid`, id).Scan(&n); err != nil {
			t.Fatalf("count variants: %v", err)
		}
		if n != 0 {
			t.Fatalf("%d variant rows were written despite the refusal", n)
		}
	})

	t.Run("allowed on a draft", func(t *testing.T) {
		tenantID, id := seedFreezeCampaign(t, pool, ctx, "draft", false)
		if _, err := repo.UpsertMultivariateTest(ctx, &middleware.Tenant{ID: tenantID}, id, in); err != nil {
			t.Fatalf("authoring a multivariate test on a draft was refused: %v", err)
		}
	})
}
