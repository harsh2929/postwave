// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TMPL-B2. A draft made from a built-in template carried
// href="https://moosewave.com/unsubscribe" as its only unsubscribe link, and
// both the pre-send checklist and the send-time compliance gate passed it
// because the body contained the word "unsubscribe". These tests drive the
// real handler and the real gate against campaign rows in Postgres (as the
// RLS-bound application role) and pin the only thing that makes a body
// compliant: the placeholder the send loop renders per recipient.

const fixedForeignUnsubscribeBody = `<table role="presentation"><tr><td>` +
	`<p>Hi Friend, your Starter seat is active.</p>` +
	`<a href="https://moosewave.com/unsubscribe">one-click unsubscribe</a>, always honored.` +
	`</td></tr></table>`

func insertCampaignWithBody(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name, body string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html)
VALUES ($1::uuid, $2, 'subject', 'draft', $3)
RETURNING id::text`, tenantID, name, body).Scan(&id); err != nil {
		t.Fatalf("insert campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return id
}

func getChecklistThroughRouter(t *testing.T, ctx context.Context, d *Deps, tenantID, campaignID string) ChecklistResponse {
	t.Helper()
	router := chi.NewRouter()
	MountChecklist(router, d)
	reqCtx := middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	reqCtx = middleware.WithUser(reqCtx, &middleware.User{ID: "checklist-owner", TenantID: tenantID, Role: "owner"})
	req := httptest.NewRequestWithContext(reqCtx, http.MethodGet,
		"/api/v1/campaigns/"+campaignID+"/checklist", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET checklist status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out ChecklistResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode checklist: %v; body=%s", err, rec.Body.String())
	}
	return out
}

func unsubscribeCheck(t *testing.T, resp ChecklistResponse) CheckItem {
	t.Helper()
	for _, item := range resp.Checks {
		if item.Key == "unsubscribe_link_present" {
			return item
		}
	}
	t.Fatalf("checklist has no unsubscribe_link_present row: %#v", resp.Checks)
	return CheckItem{}
}

func TestChecklistFailsAFixedUnsubscribeLinkAndPassesTheSendTimeTokenDB(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := setupTenantQ(t, pool, ctx, "checklist-unsub")
	d := &Deps{Repo: &Repo{Pool: pool}}

	cases := []struct {
		name string
		body string
		want ChecklistStatus
	}{
		{"hard-coded foreign unsubscribe link", fixedForeignUnsubscribeBody, CheckFail},
		{"static preference page link", `<a href="https://app.example.com/preferences/">Manage preferences</a>`, CheckFail},
		{"send-time token", `<a href="{{ unsubscribe_url }}">Unsubscribe</a>`, CheckPass},
		{"send-time token without spaces", `<a href="{{unsubscribe_url}}">Unsubscribe</a>`, CheckPass},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id := insertCampaignWithBody(t, pool, ctx, tenantID, "checklist "+tc.name, tc.body)
			got := unsubscribeCheck(t, getChecklistThroughRouter(t, ctx, d, tenantID, id))
			if got.Status != tc.want {
				t.Fatalf("unsubscribe_link_present = %s (%q), want %s for body %q",
					got.Status, got.Detail, tc.want, tc.body)
			}
		})
	}
}

func TestComplianceGateBlocksAFixedUnsubscribeLinkDB(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := setupTenantQ(t, pool, ctx, "compliance-unsub")
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	// A complete profile, so the gate reaches the body check instead of
	// returning early on the missing-profile blocker.
	if _, err := tx.Exec(ctx, `
INSERT INTO email_compliance_profiles
    (tenant_id, legal_sender_name, physical_address_line1, physical_address_city,
     physical_address_country, compliance_contact_email)
VALUES ($1::uuid, 'Ember & Oak Coffee', '1 Roastery Lane', 'Portland', 'US', 'legal@ember.example')`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed compliance profile: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit profile: %v", err)
	}
	repo := &Repo{Pool: pool}

	blockedID := insertCampaignWithBody(t, pool, ctx, tenantID, "fixed link", fixedForeignUnsubscribeBody)
	allowedID := insertCampaignWithBody(t, pool, ctx, tenantID, "token",
		`<p>Hi {{ first_name }}</p><a href="{{ unsubscribe_url }}">Unsubscribe</a>`)

	for _, tc := range []struct {
		id          string
		wantBlocked bool
	}{{blockedID, true}, {allowedID, false}} {
		campaign, err := repo.Get(ctx, tenantID, tc.id)
		if err != nil {
			t.Fatalf("load campaign: %v", err)
		}
		report, err := repo.CheckEmailCompliance(ctx, tenantID, campaign)
		if err != nil {
			t.Fatalf("CheckEmailCompliance: %v", err)
		}
		blocked := false
		for _, blocker := range report.Blockers {
			if strings.Contains(blocker, "{{ unsubscribe_url }}") {
				blocked = true
			}
		}
		if blocked != tc.wantBlocked {
			t.Fatalf("body %q: unsubscribe blocker present = %v, want %v; blockers=%q",
				campaign.BodyHTML, blocked, tc.wantBlocked, report.Blockers)
		}
	}
}
