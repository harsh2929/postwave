// SPDX-License-Identifier: AGPL-3.0-only
package notification_feed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ECO-05. Four writers recorded what happened to a notification and nothing
// read any of it back, so "a suppression or a failure is observable" was false:
// a native push withheld by quiet hours, a browser push the vendor rate-limited,
// an in-app notification the person's own preferences turned off, and a Slack
// destination that had been failing for a week were all durably recorded and
// invisible to every query in the product.
//
// These tests hold the two properties that make the read path worth having:
// a SUPPRESSED delivery is distinguishable from a FAILED one (with the reason
// attached), and the whole surface is confined by RLS to one tenant.

const (
	deliveryTenantA = "00000000-0000-4000-8000-00d1e0000001"
	deliveryTenantB = "00000000-0000-4000-8000-00d1e0000002"
	deliveryUserA   = "00000000-0000-4000-8000-00d1e000000a"
	deliveryUserB   = "00000000-0000-4000-8000-00d1e000000b"
)

// slackWebhookWithSecret is the shape net/http puts into a *url.Error message
// when a Slack Incoming Webhook post fails at the transport: the PATH is the
// credential.
const slackWebhookWithSecret = `Post "https://hooks.slack.com/services/T0A1B2C3/B9Z8Y7X6/S3cr3tT0k3nValue": dial tcp: lookup failed`

func TestListDeliveries_SuppressedIsDistinguishableFromFailed_DB(t *testing.T) {
	pool := feedTestPool(t)
	ctx := context.Background()
	requireDeliveryReadSchema(t, pool)

	seedDeliveryTenantUser(t, pool, deliveryTenantA, deliveryUserA, "dlv-a")
	t.Cleanup(func() { deleteFeedFixture(t, pool, deliveryTenantA) })

	repo := &Repo{Pool: pool}

	// One logical notification that reached the feed and then went wrong on
	// every other channel in a DIFFERENT way.
	visible, created, err := repo.NotifyDeduped(ctx, deliveryTenantA, deliveryUserA,
		NewNotification{Kind: "approval.requested", Title: "Approve the Spring Sale", DeepLink: "/app"},
		"approval.requested", "dlv:visible")
	if err != nil || !created {
		t.Fatalf("seed visible notification: created=%v err=%v", created, err)
	}
	// A second notification the person's own preferences withheld from the bell.
	hidden, created, err := repo.NotifyDeduped(ctx, deliveryTenantA, deliveryUserA,
		NewNotification{Kind: "subscriber.bounced", Title: "Bounce spike", DeepLink: "/app", Suppressed: true},
		"subscriber.bounced", "dlv:hidden")
	if err != nil || !created {
		t.Fatalf("seed suppressed notification: created=%v err=%v", created, err)
	}

	deviceID := seedMobileDevice(t, pool, deliveryTenantA, deliveryUserA, 1)
	seedWebPushDelivery(t, pool, deliveryTenantA, deliveryUserA,
		"https://fcm.googleapis.com/fcm/send/cREDENTIALpath123", visible,
		"failed", "Too Many Requests")
	seedMobilePushDelivery(t, pool, deliveryTenantA, deliveryUserA, deviceID, visible,
		"suppressed", "quiet_hours")
	seedWebhookDelivery(t, pool, deliveryTenantA, deliveryUserA, visible,
		"failed", slackWebhookWithSecret)

	// --- "what happened to THIS notification" -------------------------------
	page, err := repo.ListDeliveries(ctx, deliveryTenantA, deliveryUserA,
		DeliveryOptions{NotificationID: visible})
	if err != nil {
		t.Fatalf("ListDeliveries(one): %v", err)
	}
	byChannel := map[string]ChannelDelivery{}
	for _, it := range page.Items {
		if _, dup := byChannel[it.Channel]; dup {
			t.Fatalf("channel %q appeared twice for one notification", it.Channel)
		}
		byChannel[it.Channel] = it
	}
	if len(byChannel) != 4 {
		t.Fatalf("want a record from all four channels, got %d: %+v", len(byChannel), page.Items)
	}

	// The whole point: suppressed and failed are not the same answer.
	mobile := byChannel[ChannelMobilePush]
	if mobile.Outcome != OutcomeSuppressed {
		t.Errorf("mobile push outcome = %q, want %q (a withheld push is not a failed one)",
			mobile.Outcome, OutcomeSuppressed)
	}
	if mobile.Reason != "quiet_hours" {
		t.Errorf("mobile push reason = %q, want quiet_hours — the read path must "+
			"carry WHY it was withheld, not just that nothing arrived", mobile.Reason)
	}
	web := byChannel[ChannelWebPush]
	if web.Outcome != OutcomeFailed {
		t.Errorf("web push outcome = %q, want %q", web.Outcome, OutcomeFailed)
	}
	if web.Reason != "Too Many Requests" {
		t.Errorf("web push reason = %q, want the provider's rejection", web.Reason)
	}
	hook := byChannel[ChannelWebhook]
	if hook.Outcome != OutcomeFailed {
		t.Errorf("webhook outcome = %q, want %q", hook.Outcome, OutcomeFailed)
	}
	inApp := byChannel[ChannelInApp]
	if inApp.Outcome != OutcomeDelivered || inApp.Reason != "" {
		t.Errorf("in-app outcome = %q reason = %q, want delivered with no reason",
			inApp.Outcome, inApp.Reason)
	}

	// The endpoint URL authorises pushing to that browser; it must not be echoed.
	if web.Target == "" || len(web.Target) != 12 {
		t.Errorf("web push target = %q, want a 12-char endpoint digest", web.Target)
	}
	if got := web.Target; got == "https://fcm.googleapis.com/fcm/send/cREDENTIALpath123" {
		t.Error("web push target must not be the endpoint itself")
	}
	// Neither must the Slack webhook secret, which net/http embeds in its error.
	if containsAny(hook.Reason, "S3cr3tT0k3nValue", "/services/") {
		t.Errorf("webhook reason leaked the destination secret: %q", hook.Reason)
	}
	if !containsAny(hook.Reason, "hooks.slack.com") {
		t.Errorf("webhook reason = %q, want the host kept (it is the useful half "+
			"and carries no secret)", hook.Reason)
	}

	// --- the filters agree with the records ---------------------------------
	sup, err := repo.ListDeliveries(ctx, deliveryTenantA, deliveryUserA,
		DeliveryOptions{NotificationID: visible, Outcome: OutcomeSuppressed})
	if err != nil {
		t.Fatalf("ListDeliveries(suppressed): %v", err)
	}
	if len(sup.Items) != 1 || sup.Items[0].Channel != ChannelMobilePush {
		t.Fatalf("outcome=suppressed must return only the withheld push, got %+v", sup.Items)
	}
	fail, err := repo.ListDeliveries(ctx, deliveryTenantA, deliveryUserA,
		DeliveryOptions{NotificationID: visible, Outcome: OutcomeFailed})
	if err != nil {
		t.Fatalf("ListDeliveries(failed): %v", err)
	}
	if len(fail.Items) != 2 {
		t.Fatalf("outcome=failed must return web push + webhook, got %+v", fail.Items)
	}

	// --- preference suppression of the in-app channel is now readable -------
	hiddenPage, err := repo.ListDeliveries(ctx, deliveryTenantA, deliveryUserA,
		DeliveryOptions{NotificationID: hidden})
	if err != nil {
		t.Fatalf("ListDeliveries(hidden): %v", err)
	}
	if len(hiddenPage.Items) != 1 {
		t.Fatalf("want one in-app record for the suppressed notification, got %+v", hiddenPage.Items)
	}
	if got := hiddenPage.Items[0]; got.Outcome != OutcomeSuppressed ||
		got.Reason != "preference_in_app_off" {
		t.Errorf("suppressed feed row = outcome %q reason %q, want suppressed/preference_in_app_off — "+
			"a notification the person's own settings withheld must say so",
			got.Outcome, got.Reason)
	}
}

// A cross-tenant read must find nothing, and it must find nothing because of
// RLS rather than because the Go query remembered a tenant predicate.
func TestListDeliveries_TenantIsolationUnderRLS_DB(t *testing.T) {
	pool := feedTestPool(t)
	ctx := context.Background()
	requireDeliveryReadSchema(t, pool)

	seedDeliveryTenantUser(t, pool, deliveryTenantA, deliveryUserA, "dlv-iso-a")
	t.Cleanup(func() { deleteFeedFixture(t, pool, deliveryTenantA) })
	seedDeliveryTenantUser(t, pool, deliveryTenantB, deliveryUserB, "dlv-iso-b")
	t.Cleanup(func() { deleteFeedFixture(t, pool, deliveryTenantB) })

	repo := &Repo{Pool: pool}
	notificationID, created, err := repo.NotifyDeduped(ctx, deliveryTenantA, deliveryUserA,
		NewNotification{Kind: "approval.requested", Title: "Tenant A only", DeepLink: "/app"},
		"approval.requested", "dlv:iso")
	if err != nil || !created {
		t.Fatalf("seed tenant A notification: created=%v err=%v", created, err)
	}
	deviceID := seedMobileDevice(t, pool, deliveryTenantA, deliveryUserA, 2)
	seedWebPushDelivery(t, pool, deliveryTenantA, deliveryUserA,
		"https://updates.push.services.mozilla.com/wpush/v2/isoTOKEN", notificationID,
		"failed", "Gone")
	seedMobilePushDelivery(t, pool, deliveryTenantA, deliveryUserA, deviceID, notificationID,
		"suppressed", "quiet_hours")
	seedWebhookDelivery(t, pool, deliveryTenantA, deliveryUserA, notificationID,
		"failed", "notification webhook returned status 500")

	// Tenant A sees its own.
	own, err := repo.ListDeliveries(ctx, deliveryTenantA, deliveryUserA, DeliveryOptions{})
	if err != nil {
		t.Fatalf("ListDeliveries(tenant A): %v", err)
	}
	if len(own.Items) != 4 {
		t.Fatalf("tenant A must see its own four records, got %d: %+v", len(own.Items), own.Items)
	}

	// Tenant B, asking with tenant A's user id and tenant A's notification id —
	// the worst-case caller, holding every identifier it should not have.
	leaked, err := repo.ListDeliveries(ctx, deliveryTenantB, deliveryUserA,
		DeliveryOptions{NotificationID: notificationID})
	if err != nil {
		t.Fatalf("ListDeliveries(tenant B): %v", err)
	}
	if len(leaked.Items) != 0 {
		t.Fatalf("tenant B read tenant A's delivery records: %+v", leaked.Items)
	}

	// And prove it is the DATABASE refusing, not the WHERE clause. These queries
	// carry no tenant predicate at all: under tenant B's scope RLS must hide the
	// rows, and under tenant A's scope the same query must find them (otherwise
	// the assertion above would pass on an empty table).
	for _, table := range []string{
		"notification_feed", "web_push_deliveries",
		"mobile_push_deliveries", "notification_webhook_deliveries",
	} {
		if n := countByUserUnscoped(t, pool, deliveryTenantB, table, deliveryUserA); n != 0 {
			t.Errorf("RLS did not hide %s from tenant B: %d row(s) visible", table, n)
		}
		if n := countByUserUnscoped(t, pool, deliveryTenantA, table, deliveryUserA); n == 0 {
			t.Errorf("%s: tenant A sees none of its own rows — the isolation check above "+
				"would pass vacuously", table)
		}
	}
}

// The HTTP contract, end to end through the router, because the OpenAPI entry
// for these two operations promises specific response shapes and a 404 rule.
func TestDeliveryHandlers_HTTPContract_DB(t *testing.T) {
	pool := feedTestPool(t)
	ctx := context.Background()
	requireDeliveryReadSchema(t, pool)

	seedDeliveryTenantUser(t, pool, deliveryTenantA, deliveryUserA, "dlv-http")
	t.Cleanup(func() { deleteFeedFixture(t, pool, deliveryTenantA) })

	repo := &Repo{Pool: pool}
	notificationID, created, err := repo.NotifyDeduped(ctx, deliveryTenantA, deliveryUserA,
		NewNotification{Kind: "approval.requested", Title: "HTTP contract", DeepLink: "/app"},
		"approval.requested", "dlv:http")
	if err != nil || !created {
		t.Fatalf("seed notification: created=%v err=%v", created, err)
	}
	seedWebhookDelivery(t, pool, deliveryTenantA, deliveryUserA, notificationID,
		"failed", "notification webhook returned status 500")

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: deliveryTenantA})
			c = middleware.WithUser(c, &middleware.User{ID: deliveryUserA, TenantID: deliveryTenantA})
			next.ServeHTTP(w, r.WithContext(c))
		})
	})
	(&Deps{Repo: repo}).MountRoutes(router)

	// Per-notification: {notification_id, items}.
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/v1/notifications/"+notificationID+"/deliveries", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("per-notification status = %d, body %s", rec.Code, rec.Body.String())
	}
	var one struct {
		NotificationID string            `json:"notification_id"`
		Items          []ChannelDelivery `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &one); err != nil {
		t.Fatalf("decode per-notification body: %v (%s)", err, rec.Body.String())
	}
	if one.NotificationID != notificationID || len(one.Items) != 2 {
		t.Fatalf("body = %+v, want the id echoed and in_app + webhook records", one)
	}

	// A notification with no feed row and no ledger row is a 404, not an empty 200.
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/v1/notifications/00000000-0000-4000-8000-0000000000ff/deliveries", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown notification status = %d, want 404 (body %s)", rec.Code, rec.Body.String())
	}

	// List: {items, has_more} with next_cursor only when there is more.
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/v1/notifications/deliveries?channel=webhook", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, body %s", rec.Code, rec.Body.String())
	}
	var page struct {
		Items      []ChannelDelivery `json:"items"`
		HasMore    bool              `json:"has_more"`
		NextCursor string            `json:"next_cursor"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode list body: %v (%s)", err, rec.Body.String())
	}
	if len(page.Items) != 1 || page.Items[0].Channel != ChannelWebhook {
		t.Fatalf("channel=webhook page = %+v, want just the webhook record", page.Items)
	}
	if page.HasMore || page.NextCursor != "" {
		t.Errorf("single-record page must not advertise more (has_more=%v cursor=%q)",
			page.HasMore, page.NextCursor)
	}
}

// ---------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------

// requireDeliveryReadSchema fails loudly rather than skipping: a delivery test
// that quietly passes on a DB without migration 1919 reports coverage it does
// not have.
func requireDeliveryReadSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, table := range []string{
		"web_push_deliveries", "mobile_push_deliveries", "notification_webhook_deliveries",
	} {
		var present bool
		if err := pool.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = $1)`, table).Scan(&present); err != nil || !present {
			t.Fatalf("%s is required before the notification delivery read-path tests (present=%v err=%v)",
				table, present, err)
		}
	}
}

func seedDeliveryTenantUser(t *testing.T, pool *pgxpool.Pool, tenantID, userID, slug string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Delivery read path test', 'studio')`,
		tenantID, slug+"-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`,
		userID, tenantID, slug+"-user-"+userID[:8], slug+"-"+userID[:8]+"@example.test"); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
}

func seedMobileDevice(t *testing.T, pool *pgxpool.Pool, tenantID, userID string, salt byte) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The digests are opaque 32-byte columns with unique constraints; distinct
	// salts keep two fixtures from colliding.
	keyDigest := make([]byte, 32)
	tokenDigest := make([]byte, 32)
	for i := range keyDigest {
		keyDigest[i] = salt
		tokenDigest[i] = salt + 128
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO mobile_push_devices
    (tenant_id, user_id, device_key_digest, token_digest, token_envelope, platform, status)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'ios', 'active')
RETURNING id::text`,
		tenantID, userID, keyDigest, tokenDigest, []byte{salt}).Scan(&id); err != nil {
		t.Fatalf("seed device: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit device: %v", err)
	}
	return id
}

func seedWebPushDelivery(
	t *testing.T, pool *pgxpool.Pool, tenantID, userID, endpoint, notificationID, status, errCode string,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// entity_id is where webpush.recordAttempt puts the cross-channel id.
	if _, err := tx.Exec(ctx, `
INSERT INTO web_push_deliveries
    (tenant_id, user_id, endpoint, event_type, entity_id, idempotency_key, status, error_code, attempts)
VALUES ($1::uuid, $2::uuid, $3, 'approval.requested', $4, $5, $6, $7, 1)`,
		tenantID, userID, endpoint, notificationID, notificationID, status, errCode); err != nil {
		t.Fatalf("seed web push delivery: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit web push delivery: %v", err)
	}
}

func seedMobilePushDelivery(
	t *testing.T, pool *pgxpool.Pool, tenantID, userID, deviceID, notificationID, status, errCode string,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_deliveries
    (tenant_id, user_id, device_id, event_type, idempotency_key, notification_id,
     status, error_code, attempts, terminal_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'approval.requested', $4, $5::uuid, $6, $7, 1, now())`,
		tenantID, userID, deviceID, "idem-"+notificationID, notificationID, status, errCode); err != nil {
		t.Fatalf("seed mobile push delivery: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit mobile push delivery: %v", err)
	}
}

func seedWebhookDelivery(
	t *testing.T, pool *pgxpool.Pool, tenantID, userID, notificationID, status, errText string,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO notification_webhook_deliveries
    (tenant_id, user_id, notification_id, event_type, kind, status, error, attempts)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'approval.requested', 'slack', $4, $5, 1)`,
		tenantID, userID, notificationID, status, errText); err != nil {
		t.Fatalf("seed webhook delivery: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit webhook delivery: %v", err)
	}
}

// countByUserUnscoped runs a query with NO tenant predicate under a given
// tenant's scope, so the only thing that can hide a row is RLS.
func countByUserUnscoped(t *testing.T, pool *pgxpool.Pool, scopeTenantID, table, userID string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, scopeTenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	// table is a fixed internal literal from the caller's list, never user input.
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE user_id = $1::uuid`, userID).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func containsAny(haystack string, needles ...string) bool {
	for _, n := range needles {
		if n != "" && strings.Contains(haystack, n) {
			return true
		}
	}
	return false
}
