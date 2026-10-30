// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// The 422 named an endpoint that did not exist.
//
// PATCH /api/v1/campaigns/{id} refuses any body carrying scheduled_at with
// "status and scheduled_at are controlled by campaign lifecycle endpoints".
// pause, resume, cancel, queue and send were all built. Nothing was ever built
// for scheduled_at — so the only shipped calendar write path, the desktop
// drag-to-reschedule, failed 100% of the time, and the error told the operator
// to use a door that is not there.
//
// The guard itself is right: lifecycle belongs to lifecycle routes, which is the
// same separation the content freeze relies on. What was missing is the route.

func scheduleRouter(d *Deps) chi.Router {
	r := chi.NewRouter()
	// The unexported method: the exported handler is the release lock, pinned
	// separately by TestScheduleRouteIsClosedUntilSchedulingIsQualified.
	r.Post("/api/v1/campaigns/{id}/schedule", d.scheduleCampaign)
	r.Patch("/api/v1/campaigns/{id}", d.Update)
	return r
}

func postSchedule(t *testing.T, router chi.Router, ctx context.Context, tenantID, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(
		middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}),
		http.MethodPost, "/api/v1/campaigns/"+id+"/schedule", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func readScheduleRow(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, id string) (*time.Time, string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var at *time.Time
	var status string
	if err := tx.QueryRow(ctx, `
SELECT scheduled_at, status FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(&at, &status); err != nil {
		t.Fatalf("read schedule: %v", err)
	}
	return at, status
}

func TestScheduleEndpointRescheduleslikeTheCalendarDragExpects(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "schedule-ep")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "drag-me")

	// A draft picks up a schedule and becomes 'scheduled' — same derivation the
	// repo already applied when this arrived via PATCH.
	first := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, first.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("schedule status=%d body=%s", rec.Code, rec.Body.String())
	}
	at, status := readScheduleRow(t, pool, ctx, tenantID, id)
	if at == nil || !at.UTC().Truncate(time.Second).Equal(first) {
		t.Fatalf("scheduled_at=%v, want %v", at, first)
	}
	if status != StatusScheduled {
		t.Fatalf("status=%q, want scheduled", status)
	}

	// ...and dragging it to another day moves it again.
	second := first.Add(72 * time.Hour)
	rec = postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, second.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("reschedule status=%d body=%s", rec.Code, rec.Body.String())
	}
	if at, _ = readScheduleRow(t, pool, ctx, tenantID, id); at == nil || !at.UTC().Truncate(time.Second).Equal(second) {
		t.Fatalf("scheduled_at=%v after reschedule, want %v", at, second)
	}
}

func TestScheduleEndpointUnschedulesToDraft(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)
	tenantID := setupTenantQ(t, pool, ctx, "schedule-unset")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "unschedule-me")

	at := time.Now().UTC().Add(48 * time.Hour)
	if rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339))); rec.Code != http.StatusOK {
		t.Fatalf("schedule: %d %s", rec.Code, rec.Body.String())
	}
	rec := postSchedule(t, router, ctx, tenantID, id, `{"scheduled_at":null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("unschedule status=%d body=%s", rec.Code, rec.Body.String())
	}
	got, status := readScheduleRow(t, pool, ctx, tenantID, id)
	if got != nil {
		t.Errorf("scheduled_at=%v, want NULL after unschedule", got)
	}
	if status != StatusDraft {
		t.Errorf("status=%q, want draft — an unscheduled campaign is authorable again", status)
	}
}

func TestScheduleEndpointRefusesAPastTime(t *testing.T) {
	// Dragging to a past day would otherwise mean "fire on the next scheduler
	// tick", which is never what dropping a card on last Tuesday means.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)
	tenantID := setupTenantQ(t, pool, ctx, "schedule-past")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "past")

	past := time.Now().UTC().Add(-2 * time.Hour)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, past.Format(time.RFC3339)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s, want 422", rec.Code, rec.Body.String())
	}
	if at, _ := readScheduleRow(t, pool, ctx, tenantID, id); at != nil {
		t.Fatalf("scheduled_at=%v was written despite the refusal", at)
	}
}

func TestScheduleEndpointRefusesACampaignThatHasDispatched(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	for _, tc := range []struct{ name, status string }{
		{"sending", StatusSending},
		{"sent", StatusSent},
		{"paused mid-send", StatusPaused},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tenantID := setupTenantQ(t, pool, ctx, "schedule-dispatched")
			id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "dispatched-"+tc.status)
			setStatusDirect(t, pool, ctx, tenantID, id, tc.status, true)

			at := time.Now().UTC().Add(48 * time.Hour)
			rec := postSchedule(t, router, ctx, tenantID, id,
				fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
			if rec.Code != http.StatusConflict {
				t.Fatalf("status=%d body=%s, want 409 — recipients already hold a "+
					"message, so there is nothing left to move", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestPatchStillRefusesScheduledAt(t *testing.T) {
	// The separation the new endpoint exists to serve. If PATCH quietly started
	// accepting scheduled_at, two writers would own one field again.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)
	tenantID := setupTenantQ(t, pool, ctx, "schedule-patch")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "patch-guard")

	at := time.Now().UTC().Add(48 * time.Hour)
	req := httptest.NewRequestWithContext(
		middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}),
		http.MethodPatch, "/api/v1/campaigns/"+id,
		strings.NewReader(fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339))))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d, want 422 still", rec.Code)
	}
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	if env.Error.Code != "campaign_dispatch_state_owned" {
		t.Fatalf("code=%q, want campaign_dispatch_state_owned", env.Error.Code)
	}

	// The shape that matters most in practice: an explicit null. hasDispatchState
	// tests len(RawMessage) != 0, and JSON null decodes to the four bytes "null",
	// so a client that sends `scheduled_at: null` on every save is refused just
	// as firmly as one that sends a timestamp. apps/web's
	// buildCampaignUpdateInput did exactly that, which meant EVERY web campaign
	// save failed — not only scheduling.
	req = httptest.NewRequestWithContext(
		middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}),
		http.MethodPatch, "/api/v1/campaigns/"+id,
		strings.NewReader(`{"subject":"Edited","scheduled_at":null}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("explicit null: status=%d body=%s, want 422", rec.Code, rec.Body.String())
	}
}

// The release lock, pinned so it cannot be lifted by accident.
//
// campaigndispatch.SchedulingQualified gates Scheduler.Run. While it is false
// nothing ever dispatches a scheduled campaign, so accepting a schedule would
// produce a campaign that reads "scheduled for Tuesday" and never sends. The
// route must refuse — with a branchable reason, not a scrubbed 500.
func TestScheduleRouteIsClosedUntilSchedulingIsQualified(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := chi.NewRouter()
	router.Post("/api/v1/campaigns/{id}/schedule", d.ScheduleCampaign)

	tenantID := setupTenantQ(t, pool, ctx, "schedule-lock")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "locked")
	at := time.Now().UTC().Add(48 * time.Hour)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))

	if campaigndispatch.SchedulingQualified {
		// The lock has been lifted. That is a deliberate release decision, so
		// this test becomes an assertion that the route is now open.
		if rec.Code == http.StatusServiceUnavailable {
			t.Fatal("SchedulingQualified is true but the route still refuses")
		}
		return
	}

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s, want 503 while scheduling is unqualified",
			rec.Code, rec.Body.String())
	}
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	if env.Error.Code != campaigndispatch.SchedulingUnqualifiedCode {
		t.Fatalf("code=%q, want %q — a client must be able to tell this from a "+
			"database failure", env.Error.Code, campaigndispatch.SchedulingUnqualifiedCode)
	}
	if at, _ := readScheduleRow(t, pool, ctx, tenantID, id); at != nil {
		t.Fatalf("scheduled_at=%v was written despite the lock", at)
	}
}

// A schedule may only be placed on a campaign the scheduler will actually claim.
//
// FindDueScheduled claims `status = 'scheduled'` only. Repo.Update promotes
// draft → scheduled, and leaves every other status alone. So a cancelled,
// failed, or paused campaign accepted a scheduled_at, answered 200, and sat
// there forever: the operator reads "scheduled for Tuesday" and nothing fires.
//
// That is exactly the failure the release lock exists to prevent, arriving
// through the status machine instead of the lock.
func TestScheduleEndpointRefusesAStatusTheSchedulerWillNeverClaim(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	for _, status := range []string{StatusCancelled, StatusFailed} {
		t.Run(status, func(t *testing.T) {
			tenantID := setupTenantQ(t, pool, ctx, "schedule-unclaimable")
			id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "unclaimable-"+status)
			// started_at stays NULL: cancel is reachable from draft and scheduled,
			// neither of which stamps it, so the dispatch freeze does not apply.
			setStatusDirect(t, pool, ctx, tenantID, id, status, false)

			at := time.Now().UTC().Add(48 * time.Hour)
			rec := postSchedule(t, router, ctx, tenantID, id,
				fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
			if rec.Code != http.StatusConflict {
				t.Fatalf("status=%d body=%s, want 409 — the scheduler claims only "+
					"'scheduled' rows, so this would never fire", rec.Code, rec.Body.String())
			}
			if got, _ := readScheduleRow(t, pool, ctx, tenantID, id); got != nil {
				t.Fatalf("scheduled_at=%v was written onto a %s campaign", got, status)
			}
		})
	}
}

func TestSchedulableStatusesStaySchedulable(t *testing.T) {
	// The control. draft and scheduled are the two states a send time belongs
	// to, and both must keep working.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	for _, status := range []string{StatusDraft, StatusScheduled} {
		t.Run(status, func(t *testing.T) {
			tenantID := setupTenantQ(t, pool, ctx, "schedule-ok")
			id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "ok-"+status)
			setStatusDirect(t, pool, ctx, tenantID, id, status, false)

			at := time.Now().UTC().Add(48 * time.Hour)
			rec := postSchedule(t, router, ctx, tenantID, id,
				fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s, want 200", rec.Code, rec.Body.String())
			}
			if _, got := readScheduleRow(t, pool, ctx, tenantID, id); got != StatusScheduled {
				t.Fatalf("status=%q, want scheduled", got)
			}
		})
	}
}

func TestUnschedulingAnUnschedulableStatusIsRefused(t *testing.T) {
	// The mirror hole: ClearScheduledAt only demoted scheduled → draft, so
	// unscheduling a cancelled campaign silently stripped its time and left the
	// status untouched.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)
	tenantID := setupTenantQ(t, pool, ctx, "unschedule-cancelled")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "cancelled-clear")
	setStatusDirect(t, pool, ctx, tenantID, id, StatusCancelled, false)

	if rec := postSchedule(t, router, ctx, tenantID, id, `{"scheduled_at":null}`); rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
}

func TestScheduleEndpointRefusesAnAbsurdlyDistantTime(t *testing.T) {
	// A mis-parsed date (seconds read as milliseconds, a picker defaulting to
	// year 9999) otherwise produces a campaign that sits scheduled forever with
	// nobody the wiser — the same silent-never-fires failure the route exists to
	// stop producing.
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)
	tenantID := setupTenantQ(t, pool, ctx, "schedule-far")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "far")

	far := time.Now().UTC().AddDate(maxScheduleHorizonYears+1, 0, 0)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, far.Format(time.RFC3339)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s, want 422", rec.Code, rec.Body.String())
	}

	// The control: just inside the horizon is fine.
	near := time.Now().UTC().AddDate(maxScheduleHorizonYears, 0, -1)
	if rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, near.Format(time.RFC3339))); rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200 just inside the horizon", rec.Code, rec.Body.String())
	}
}
