// SPDX-License-Identifier: AGPL-3.0-only
//
// PostgreSQL-backed proofs for tracking-consent identity, concurrency, RLS,
// and transaction atomicity. They skip cleanly when DATABASE_URL is absent.

package consent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func newTrackingTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed tracking-consent tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedTrackingTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'tracking-consent-test', 'tracking-consent-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})
}

func seedTrackingSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("subscriber seed scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers
       (tenant_id, email, status, mailchimp_status, consent_source)
VALUES ($1::uuid, $2::citext, 'enabled', 'subscribed', 'api')
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

func trackingTestRouter(pool *pgxpool.Pool) http.Handler {
	deps := &Deps{Pool: pool, Outbox: &outbox.Repo{Pool: pool}}
	router := chi.NewRouter()
	router.Get("/api/v1/subscribers/{id}/tracking-consent", deps.GetTrackingByID)
	router.Patch("/api/v1/subscribers/{id}/tracking-consent", deps.PatchTrackingByID)
	router.Get("/api/v1/consent/subscribers/{email}/tracking", deps.GetTracking)
	router.Patch("/api/v1/consent/subscribers/{email}/tracking", deps.PatchTracking)
	return router
}

func TestTrackingBodyRevisionSurvivesSensitiveBoundary(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	subscriberID := seedTrackingSubscriber(t, pool, tenantID, "privacy-boundary@example.test")
	handler := ProtectSensitiveResponses(trackingTestRouter(pool))
	path := "/api/v1/subscribers/" + subscriberID + "/tracking-consent"
	read := doTrackingRequest(t, handler, tenantID, http.MethodGet, path, "", "")
	if read.Code != http.StatusOK {
		t.Fatalf("read: %d %s", read.Code, read.Body.String())
	}
	before := decodeTrackingResponse(t, read)
	if before.Version == "" || !strings.HasPrefix(before.Version, `"`) {
		t.Fatalf("missing exact body revision: %+v", before)
	}
	if read.Header().Get("ETag") != "" || read.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("privacy boundary changed: %v", read.Header())
	}
	write := doTrackingRequest(t, handler, tenantID, http.MethodPatch, path, `{"open_opt_out":true}`, before.Version)
	if write.Code != http.StatusOK {
		t.Fatalf("write: %d %s", write.Code, write.Body.String())
	}
	after := decodeTrackingResponse(t, write)
	if !after.EffectiveOpenOptOut || after.Version == before.Version {
		t.Fatalf("committed state/revision: %+v", after)
	}
	stale := doTrackingRequest(t, handler, tenantID, http.MethodPatch, path, `{"open_opt_out":false}`, before.Version)
	if stale.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale write: %d %s", stale.Code, stale.Body.String())
	}
	if write.Header().Get("ETag") != "" {
		t.Fatal("write leaked a cache validator")
	}
}

func doTrackingRequest(
	t *testing.T,
	handler http.Handler,
	tenantID, method, path, body, etag string,
) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if etag != "" {
		req.Header.Set("If-Match", etag)
	}
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func decodeTrackingResponse(t *testing.T, rec *httptest.ResponseRecorder) TrackingPrefs {
	t.Helper()
	var prefs TrackingPrefs
	if err := json.Unmarshal(rec.Body.Bytes(), &prefs); err != nil {
		t.Fatalf("decode tracking response (%d %s): %v", rec.Code, rec.Body.String(), err)
	}
	return prefs
}

type trackingEvidenceCount struct {
	Prefs, Events, Audits, Outbox int
}

func trackingEvidenceCounts(t *testing.T, pool *pgxpool.Pool, tenantID, subscriberID string) trackingEvidenceCount {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var counts trackingEvidenceCount
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_tracking_prefs p
  JOIN subscribers s ON s.tenant_id = p.tenant_id AND s.email = p.subscriber_email
 WHERE s.id = $1::uuid`, subscriberID).Scan(&counts.Prefs); err != nil {
		t.Fatalf("count prefs: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_events
 WHERE subject_id = $1 AND category = 'email_tracking'`, subscriberID).Scan(&counts.Events); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE resource_id = $1 AND action = 'subscriber.tracking_consent.updated'`, subscriberID).Scan(&counts.Audits); err != nil {
		t.Fatalf("count audits: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM outbox_events
 WHERE kind = 'webhook.fanout' AND payload #>> '{body,id}' = $1`, subscriberID).Scan(&counts.Outbox); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	return counts
}

func TestTrackingConsentCanonicalEventPreservesOccurredAt(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	occurredAt := time.Now().UTC().Add(-72 * time.Hour).Truncate(time.Microsecond)

	eventID, err := RecordEvent(context.Background(), pool, EventInput{
		TenantID:      tenantID,
		SubjectType:   "subscriber",
		SubjectID:     uuid.NewString(),
		SubjectEmail:  "reviewed-occurrence@example.test",
		Channel:       "import",
		Category:      "email_marketing",
		Action:        "imported",
		Source:        "reviewed_import",
		PolicyVersion: "privacy-2026-07",
		OccurredAt:    &occurredAt,
	})
	if err != nil {
		t.Fatalf("record canonical event: %v", err)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var stored time.Time
	if err := tx.QueryRow(ctx, `SELECT created_at FROM consent_events WHERE id = $1::uuid`, eventID).Scan(&stored); err != nil {
		t.Fatalf("read canonical event: %v", err)
	}
	if !stored.Equal(occurredAt) {
		t.Fatalf("canonical chronology changed: got %s want %s", stored, occurredAt)
	}
}

func TestTrackingConsentStableIdentityGPCAndTenantIsolation(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	email := "tracking-gpc-" + uuid.NewString() + "@example.test"
	subscriberID := seedTrackingSubscriber(t, pool, tenantID, email)
	handler := trackingTestRouter(pool)

	get := doTrackingRequest(t, handler, tenantID, http.MethodGet,
		"/api/v1/subscribers/"+subscriberID+"/tracking-consent", "", "")
	if get.Code != http.StatusOK || get.Header().Get("ETag") == "" {
		t.Fatalf("initial GET = %d etag=%q body=%s", get.Code, get.Header().Get("ETag"), get.Body.String())
	}
	initial := decodeTrackingResponse(t, get)
	if initial.SubscriberID != subscriberID || initial.SubscriberEmail != email || initial.GPC || initial.EffectiveOpenOptOut || initial.EffectiveClickOptOut {
		t.Fatalf("initial representation = %+v", initial)
	}

	patch := doTrackingRequest(t, handler, tenantID, http.MethodPatch,
		"/api/v1/subscribers/"+subscriberID+"/tracking-consent",
		`{"gpc":true,"source":"preference_center","policy_version":"privacy-2026-07"}`,
		get.Header().Get("ETag"))
	if patch.Code != http.StatusOK {
		t.Fatalf("GPC PATCH = %d body=%s", patch.Code, patch.Body.String())
	}
	updated := decodeTrackingResponse(t, patch)
	if !updated.GPC || !updated.EffectiveOpenOptOut || !updated.EffectiveClickOptOut || updated.OpenOptOutAt != nil || updated.ClickOptOutAt != nil {
		t.Fatalf("GPC representation is ambiguous: %+v", updated)
	}
	if got := trackingEvidenceCounts(t, pool, tenantID, subscriberID); got != (trackingEvidenceCount{Prefs: 1, Events: 1, Audits: 1, Outbox: 1}) {
		t.Fatalf("atomic evidence counts = %+v", got)
	}

	filter := &SendTrackingFilter{Pool: pool}
	open, click, err := filter.Lookup(context.Background(), tenantID, email)
	if err != nil || !open || !click {
		t.Fatalf("send-time GPC decision = open:%v click:%v err:%v", open, click, err)
	}
	batch, err := filter.LookupBatch(context.Background(), tenantID, []string{strings.ToUpper(email)})
	if err != nil || !batch[email].SkipOpen || !batch[email].SkipClick {
		t.Fatalf("batched GPC decision = %+v err=%v", batch[email], err)
	}

	otherTenant := uuid.NewString()
	otherGet := doTrackingRequest(t, handler, otherTenant, http.MethodGet,
		"/api/v1/subscribers/"+subscriberID+"/tracking-consent", "", "")
	if otherGet.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant GET = %d body=%s", otherGet.Code, otherGet.Body.String())
	}
	otherPatch := doTrackingRequest(t, handler, otherTenant, http.MethodPatch,
		"/api/v1/subscribers/"+subscriberID+"/tracking-consent", `{"gpc":false}`, get.Header().Get("ETag"))
	if otherPatch.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant PATCH = %d body=%s", otherPatch.Code, otherPatch.Body.String())
	}
	if got := trackingEvidenceCounts(t, pool, tenantID, subscriberID); got != (trackingEvidenceCount{Prefs: 1, Events: 1, Audits: 1, Outbox: 1}) {
		t.Fatalf("cross-tenant attempt changed evidence = %+v", got)
	}
}

func TestTrackingConsentExactRetryStaleCASAndConcurrentWriter(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	handler := trackingTestRouter(pool)

	t.Run("exact retry succeeds but conflicting stale write fails", func(t *testing.T) {
		email := "tracking-retry-" + uuid.NewString() + "@example.test"
		id := seedTrackingSubscriber(t, pool, tenantID, email)
		path := "/api/v1/subscribers/" + id + "/tracking-consent"
		get := doTrackingRequest(t, handler, tenantID, http.MethodGet, path, "", "")
		initialETag := get.Header().Get("ETag")
		body := `{"open_opt_out":true,"source":"preference_center","policy_version":"privacy-2026-07"}`
		first := doTrackingRequest(t, handler, tenantID, http.MethodPatch, path, body, initialETag)
		if first.Code != http.StatusOK {
			t.Fatalf("first PATCH = %d body=%s", first.Code, first.Body.String())
		}
		firstPrefs := decodeTrackingResponse(t, first)
		retry := doTrackingRequest(t, handler, tenantID, http.MethodPatch, path, body, initialETag)
		if retry.Code != http.StatusOK {
			t.Fatalf("exact stale retry = %d body=%s", retry.Code, retry.Body.String())
		}
		retryPrefs := decodeTrackingResponse(t, retry)
		if !retryPrefs.UpdatedAt.Equal(firstPrefs.UpdatedAt) || retry.Header().Get("ETag") != first.Header().Get("ETag") {
			t.Fatalf("retry advanced version: first=%s/%q retry=%s/%q", firstPrefs.UpdatedAt, first.Header().Get("ETag"), retryPrefs.UpdatedAt, retry.Header().Get("ETag"))
		}
		conflict := doTrackingRequest(t, handler, tenantID, http.MethodPatch, path,
			`{"click_opt_out":true,"source":"preference_center","policy_version":"privacy-2026-07"}`, initialETag)
		if conflict.Code != http.StatusPreconditionFailed || !strings.Contains(conflict.Body.String(), "precondition_failed") {
			t.Fatalf("conflicting stale PATCH = %d body=%s", conflict.Code, conflict.Body.String())
		}
		if got := trackingEvidenceCounts(t, pool, tenantID, id); got != (trackingEvidenceCount{Prefs: 1, Events: 1, Audits: 1, Outbox: 1}) {
			t.Fatalf("retry/CAS evidence counts = %+v", got)
		}
	})

	t.Run("two exact writers append evidence once", func(t *testing.T) {
		email := "tracking-race-" + uuid.NewString() + "@example.test"
		id := seedTrackingSubscriber(t, pool, tenantID, email)
		path := "/api/v1/subscribers/" + id + "/tracking-consent"
		get := doTrackingRequest(t, handler, tenantID, http.MethodGet, path, "", "")
		initialETag := get.Header().Get("ETag")
		if get.Code != http.StatusOK || initialETag == "" {
			t.Fatalf("pre-race GET = %d etag=%q body=%s", get.Code, initialETag, get.Body.String())
		}
		start := make(chan struct{})
		responses := make(chan *httptest.ResponseRecorder, 2)
		var wait sync.WaitGroup
		for range 2 {
			wait.Add(1)
			go func() {
				defer wait.Done()
				<-start
				responses <- doTrackingRequest(t, handler, tenantID, http.MethodPatch, path,
					`{"click_opt_out":true}`, initialETag)
			}()
		}
		close(start)
		wait.Wait()
		close(responses)
		for response := range responses {
			if response.Code != http.StatusOK {
				t.Fatalf("concurrent PATCH = %d body=%s", response.Code, response.Body.String())
			}
		}
		if got := trackingEvidenceCounts(t, pool, tenantID, id); got != (trackingEvidenceCount{Prefs: 1, Events: 1, Audits: 1, Outbox: 1}) {
			t.Fatalf("concurrent exact-once evidence = %+v", got)
		}
	})
}

func TestLegacyEmailTrackingCASCannotMutateRenamedReusedAddress(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	oldEmail := "tracking-renamed-" + uuid.NewString() + "@example.test"
	newEmail := "tracking-current-" + uuid.NewString() + "@example.test"
	originalID := seedTrackingSubscriber(t, pool, tenantID, oldEmail)
	handler := trackingTestRouter(pool)

	legacyPath := "/api/v1/consent/subscribers/" + oldEmail + "/tracking"
	get := doTrackingRequest(t, handler, tenantID, http.MethodGet, legacyPath, "", "")
	if get.Code != http.StatusOK || get.Header().Get("Deprecation") != "true" {
		t.Fatalf("legacy GET = %d headers=%v body=%s", get.Code, get.Header(), get.Body.String())
	}
	staleETag := get.Header().Get("ETag")

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE subscribers SET email=$3::citext, updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, originalID, newEmail); err != nil {
		t.Fatalf("rename subscriber: %v", err)
	}
	var reusedID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, mailchimp_status, consent_source)
VALUES ($1::uuid, $2::citext, 'enabled', 'subscribed', 'api')
RETURNING id::text`, tenantID, oldEmail).Scan(&reusedID); err != nil {
		t.Fatalf("reuse email: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	stale := doTrackingRequest(t, handler, tenantID, http.MethodPatch, legacyPath,
		`{"open_opt_out":true}`, staleETag)
	if stale.Code != http.StatusPreconditionFailed {
		t.Fatalf("legacy renamed/reused PATCH = %d body=%s", stale.Code, stale.Body.String())
	}
	withoutETag := doTrackingRequest(t, handler, tenantID, http.MethodPatch, legacyPath,
		`{"open_opt_out":true}`, "")
	if withoutETag.Code != http.StatusPreconditionRequired {
		t.Fatalf("legacy PATCH without ETag = %d body=%s", withoutETag.Code, withoutETag.Body.String())
	}
	if original := trackingEvidenceCounts(t, pool, tenantID, originalID); original != (trackingEvidenceCount{}) {
		t.Fatalf("original renamed subscriber was mutated: %+v", original)
	}
	if reused := trackingEvidenceCounts(t, pool, tenantID, reusedID); reused != (trackingEvidenceCount{}) {
		t.Fatalf("reused-address subscriber was mutated: %+v", reused)
	}

	stablePath := "/api/v1/subscribers/" + originalID + "/tracking-consent"
	stableGet := doTrackingRequest(t, handler, tenantID, http.MethodGet, stablePath, "", "")
	if stableGet.Code != http.StatusOK || stableGet.Header().Get("ETag") == "" {
		t.Fatalf("stable GET after rename = %d body=%s", stableGet.Code, stableGet.Body.String())
	}
	stable := doTrackingRequest(t, handler, tenantID, http.MethodPatch,
		stablePath, `{"open_opt_out":true}`, stableGet.Header().Get("ETag"))
	if stable.Code != http.StatusOK {
		t.Fatalf("stable route after rename = %d body=%s", stable.Code, stable.Body.String())
	}
	stablePrefs := decodeTrackingResponse(t, stable)
	if stablePrefs.SubscriberEmail != newEmail || !stablePrefs.EffectiveOpenOptOut {
		t.Fatalf("stable route resolved wrong identity: %+v", stablePrefs)
	}
}

func TestTrackingConsentLedgerFailuresRollBackProjectionEventAuditAndOutbox(t *testing.T) {
	pool := newTrackingTestPool(t)
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set; skipping forced tracking-ledger failures")
	}
	admin, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	t.Cleanup(admin.Close)
	var appDB, adminDB string
	if err := pool.QueryRow(context.Background(), `SELECT current_database()`).Scan(&appDB); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(context.Background(), `SELECT current_database()`).Scan(&adminDB); err != nil {
		t.Fatal(err)
	}
	if appDB != adminDB {
		t.Skipf("admin database %q does not match app database %q", adminDB, appDB)
	}

	for _, table := range []string{"consent_events", "outbox_events", "audit_log"} {
		t.Run(table, func(t *testing.T) {
			tenantID := uuid.NewString()
			seedTrackingTenant(t, pool, tenantID)
			id := seedTrackingSubscriber(t, pool, tenantID,
				"tracking-rollback-"+uuid.NewString()+"@example.test")
			installTrackingFailureTrigger(t, admin, table, tenantID)
			handler := trackingTestRouter(pool)
			path := "/api/v1/subscribers/" + id + "/tracking-consent"
			get := doTrackingRequest(t, handler, tenantID, http.MethodGet, path, "", "")
			if get.Code != http.StatusOK || get.Header().Get("ETag") == "" {
				t.Fatalf("pre-failure GET = %d body=%s", get.Code, get.Body.String())
			}
			response := doTrackingRequest(t, handler, tenantID, http.MethodPatch,
				path, `{"open_opt_out":true}`, get.Header().Get("ETag"))
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("forced %s failure = %d body=%s", table, response.Code, response.Body.String())
			}
			if got := trackingEvidenceCounts(t, pool, tenantID, id); got != (trackingEvidenceCount{}) {
				t.Fatalf("forced %s failure leaked transaction state: %+v", table, got)
			}
		})
	}
}

func installTrackingFailureTrigger(t *testing.T, admin *pgxpool.Pool, table, tenantID string) {
	t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	functionName := "tracking_consent_fail_" + suffix
	triggerName := "tracking_consent_fail_" + suffix
	functionIdent := pgx.Identifier{"public", functionName}.Sanitize()
	triggerIdent := pgx.Identifier{triggerName}.Sanitize()
	tableIdent := pgx.Identifier{table}.Sanitize()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := admin.Exec(ctx, fmt.Sprintf(`
CREATE FUNCTION %s() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.tenant_id = '%s'::uuid THEN
        RAISE EXCEPTION 'forced tracking consent %s failure';
    END IF;
    RETURN NEW;
END
$fn$`, functionIdent, tenantID, table)); err != nil {
		t.Fatalf("create %s failure function: %v", table, err)
	}
	if err := execSharedTableDDL(ctx, admin, fmt.Sprintf(`
CREATE TRIGGER %s
BEFORE INSERT ON %s
FOR EACH ROW EXECUTE FUNCTION %s()`, triggerIdent, tableIdent, functionIdent)); err != nil {
		_, _ = admin.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, functionIdent))
		t.Fatalf("create %s failure trigger: %v", table, err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		// A trigger or function left behind stays on a table every other
		// package writes to, so a failed drop is reported, not discarded.
		if err := execSharedTableDDL(cleanupCtx, admin,
			fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON %s`, triggerIdent, tableIdent)); err != nil {
			t.Errorf("drop %s failure trigger: %v", table, err)
			return
		}
		if _, err := admin.Exec(cleanupCtx, fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, functionIdent)); err != nil {
			t.Errorf("drop %s failure function: %v", table, err)
		}
	})
}

// execSharedTableDDL runs one CREATE or DROP TRIGGER on a table that every
// other package in the shared test database is writing to at the same time
// (audit_log and outbox_events above all).
//
// Each attempt runs under a 100 ms lock_timeout and is retried until it gets
// its locks at once. Without that bound the statement queued for its
// ShareRowExclusive or AccessExclusive lock (on audit_log that means every
// partition, one at a time), and while it waited every other session's
// INSERT or DELETE on the table queued behind it. That convoy is what made
// concurrent tenant deletes, which cascade into audit_log, deadlock with this
// test's DROP TRIGGER (SQLSTATE 40P01) and time out in other packages'
// cleanups. Now it is the DDL that gives way: a lock it cannot take within
// 100 ms (55P03) or a deadlock it is picked for (40P01) rolls the attempt back
// and it tries again.
func execSharedTableDDL(ctx context.Context, admin *pgxpool.Pool, statement string) error {
	for wait := 20 * time.Millisecond; ; wait = min(2*wait, 500*time.Millisecond) {
		err := execSharedTableDDLOnce(ctx, admin, statement)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "55P03" || pgErr.Code == "40P01") && ctx.Err() == nil {
			select {
			case <-ctx.Done():
				return err
			case <-time.After(wait):
			}
			continue
		}
		return err
	}
}

func execSharedTableDDLOnce(ctx context.Context, admin *pgxpool.Pool, statement string) error {
	tx, err := admin.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '100ms'`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, statement); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
