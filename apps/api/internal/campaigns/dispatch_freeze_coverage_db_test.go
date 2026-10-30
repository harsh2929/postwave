// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// A campaign that is 'sending' or 'sent' with started_at NULL must still freeze.
//
// The first round of freeze tests set started_at on every fixture, so the
// `status NOT IN ('sending','sent')` half of the predicate was never exercised —
// deleting it left the whole suite green. It is load-bearing for every row that
// reached a terminal status before the stamp existed: campaigns imported from
// Listmonk (services/migration/.../listmonk/archive.go carries status='sent'
// with no start instant), onboarding sample data, and anything dispatched by a
// path that predates this change.
func TestFreezeCoversDispatchedRowsWithNoStartedAt(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	edited := "Corrected subject"

	for _, status := range []string{StatusSending, StatusSent} {
		t.Run(status+" without started_at", func(t *testing.T) {
			tenantID := setupTenantQ(t, pool, ctx, "freeze-nostamp")
			id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "nostamp-"+status)
			setStatusDirect(t, pool, ctx, tenantID, id, status, false)

			_, err := repo.Update(ctx, tenantID, id, UpdateInput{Subject: &edited})
			if !errors.Is(err, ErrCampaignDispatching) {
				t.Fatalf("err = %v, want ErrCampaignDispatching — a legacy row that "+
					"reached %s before started_at existed is still a campaign whose "+
					"content was delivered", err, status)
			}
		})
	}
}

// Every field freezesOnceDispatched claims to freeze, actually frozen.
//
// The first round varied only Subject, so dropping Variants, TrackingSettings,
// ReusableSectionIDs or ContentBlocks from the switch left the suite green —
// and tracking_settings in particular is read per batch by the send loop, where
// it rewrites every link in the message.
func TestEveryFrozenFieldIsActuallyFrozen(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	str := func(s string) *string { return &s }
	frozen := []struct {
		field string
		in    UpdateInput
	}{
		{"subject", UpdateInput{Subject: str("new")}},
		{"body_html", UpdateInput{BodyHTML: str("<p>new</p>")}},
		{"body_mjml", UpdateInput{BodyMJML: str("<mjml/>")}},
		{"plain_text", UpdateInput{PlainText: str("new")}},
		{"preview_text", UpdateInput{PreviewText: str("new")}},
		{"from_name", UpdateInput{FromName: str("New Sender")}},
		{"reply_to", UpdateInput{ReplyTo: str("new@example.test")}},
		{"editor_mode", UpdateInput{EditorMode: str("html")}},
		{"campaign_type", UpdateInput{CampaignType: str("multivariate")}},
		{"audience_mode", UpdateInput{AudienceMode: str("static")}},
		{"content_blocks", UpdateInput{ContentBlocks: []map[string]any{{"type": "text"}}}},
		{"reusable_section_ids", UpdateInput{ReusableSectionIDs: []string{}}},
		{"variants", UpdateInput{Variants: []map[string]any{{"label": "A"}}}},
		{"tracking_settings", UpdateInput{TrackingSettings: map[string]any{"utm_source": "x"}}},
		// delivery_settings freezes only when it changes the sender — the seeded
		// campaign has no from_email, so setting one is a change.
		{"delivery_settings sender", UpdateInput{DeliverySettings: map[string]any{"from_email": "other@example.test"}}},
		// scheduled_at is lifecycle rather than content, but moving the send time
		// of a campaign that already began sending is a fiction, and clearing it
		// would leave a partial send behind an unscheduled draft.
		{"scheduled_at", UpdateInput{ScheduledAt: ptrTime(time.Now().Add(48 * time.Hour))}},
		{"clear scheduled_at", UpdateInput{ClearScheduledAt: true}},
	}

	for _, tc := range frozen {
		t.Run(tc.field, func(t *testing.T) {
			tenantID := setupTenantQ(t, pool, ctx, "freeze-fields")
			id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "field-"+tc.field)
			setStatusDirect(t, pool, ctx, tenantID, id, StatusSending, true)

			if _, err := repo.Update(ctx, tenantID, id, tc.in); !errors.Is(err, ErrCampaignDispatching) {
				t.Fatalf("editing %s on a sending campaign returned %v, want "+
					"ErrCampaignDispatching", tc.field, err)
			}
		})
	}
}

// The throttle case delivery_settings is deliberately left open for — and the
// sender-wipe it used to hide.
func TestDeliverySettingsFreezesOnlyWhenItChangesTheSender(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	seed := func(name string) (string, string) {
		tenantID := setupTenantQ(t, pool, ctx, "freeze-delivery")
		id := insertQueueableCampaignQ(t, pool, ctx, tenantID, name)
		if _, err := repo.Update(ctx, tenantID, id, UpdateInput{
			DeliverySettings: map[string]any{"from_email": "sender@example.test", "rate_limit": 10},
		}); err != nil {
			t.Fatalf("seed delivery settings: %v", err)
		}
		setStatusDirect(t, pool, ctx, tenantID, id, StatusSending, true)
		return tenantID, id
	}

	t.Run("throttling mid-send is allowed", func(t *testing.T) {
		tenantID, id := seed("throttle")
		if _, err := repo.Update(ctx, tenantID, id, UpdateInput{
			DeliverySettings: map[string]any{"from_email": "sender@example.test", "rate_limit": 2},
		}); err != nil {
			t.Fatalf("an operator could not slow a send down: %v", err)
		}
	})

	t.Run("swapping the sender is refused", func(t *testing.T) {
		tenantID, id := seed("swap")
		_, err := repo.Update(ctx, tenantID, id, UpdateInput{
			DeliverySettings: map[string]any{"from_email": "someone-else@example.test", "rate_limit": 10},
		})
		if !errors.Is(err, ErrCampaignDispatching) {
			t.Fatalf("err = %v: the From header is built from delivery_settings."+
				"from_email per batch, so this swaps the sender mid-send", err)
		}
	})

	t.Run("dropping the sender is refused", func(t *testing.T) {
		// The trap: delivery_settings REPLACES rather than merges, so a client
		// sending only a throttle removes from_email — and senderHeaders then
		// emits no From header at all for every remaining batch.
		tenantID, id := seed("drop")
		_, err := repo.Update(ctx, tenantID, id, UpdateInput{
			DeliverySettings: map[string]any{"rate_limit": 2},
		})
		if !errors.Is(err, ErrCampaignDispatching) {
			t.Fatalf("err = %v: this write erases from_email, which is a content "+
				"change even though the caller never mentioned the sender", err)
		}
	})
}

// The freeze must win over If-Match, because the web client always sends one.
//
// Two paths reach the token check, and they fail differently:
//
//   - stale token — starting a send bumps updated_at, so any token the operator
//     is holding from before the send is stale. This is the common case.
//   - fresh token — they reloaded after the send began, so the token matches and
//     only the freeze predicate rejects the UPDATE.
//
// Both must report the freeze. 412 says "reload and retry", and the reload hands
// back a campaign that still refuses the edit.
func TestFreezeIsReportedEvenWhenIfMatchIsSupplied(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	tenantID := setupTenantQ(t, pool, ctx, "freeze-ifmatch")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "ifmatch")

	cur, err := repo.Get(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	token := httpcache.ConcurrencyToken("campaign", cur.ID, cur.UpdatedAt)
	setStatusDirect(t, pool, ctx, tenantID, id, StatusSending, true)

	d := &Deps{Repo: repo}
	router := chi.NewRouter()
	router.Patch("/api/v1/campaigns/{id}", d.Update)
	req := httptest.NewRequestWithContext(
		middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}),
		http.MethodPatch, "/api/v1/campaigns/"+id,
		strings.NewReader(`{"subject":"Corrected subject"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", token)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code == http.StatusPreconditionFailed {
		t.Fatalf("status=412: the token matched at read time, so re-reading and "+
			"retrying cannot help — on the next read the campaign is still "+
			"sending. body=%s", rec.Body.String())
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}

	// ...and again with a token read AFTER the send began, which reaches the
	// zero-row UPDATE rather than the pre-check.
	fresh, err := repo.Get(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("Get after dispatch: %v", err)
	}
	req2 := httptest.NewRequestWithContext(
		middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}),
		http.MethodPatch, "/api/v1/campaigns/"+id,
		strings.NewReader(`{"subject":"Corrected subject"}`))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("If-Match", httpcache.ConcurrencyToken("campaign", fresh.ID, fresh.UpdatedAt))
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Fatalf("with a matching token: status=%d body=%s, want 409", rec2.Code, rec2.Body.String())
	}
}

func ptrTime(t time.Time) *time.Time { return &t }
