// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func seedPreviewAggregateFixture(t *testing.T, pool *pgxpool.Pool) (tenantID, emailMarker string) {
	t.Helper()
	tenantID = uuid.NewString()
	emailMarker = uuid.NewString()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantSetup, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant setup scope: %v", err)
	}
	defer func() { _ = tenantSetup.Rollback(ctx) }()
	if _, err := tenantSetup.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, tenantID, "segment-preview-"+emailMarker, "segment-preview-"+emailMarker); err != nil {
		t.Fatalf("seed preview tenant: %v", err)
	}
	if err := tenantSetup.Commit(ctx); err != nil {
		t.Fatalf("commit preview tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})

	tenantTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tenantTx.Rollback(ctx) }()
	type subscriberFixture struct {
		email    string
		granted  bool
		archived bool
	}
	fixtures := []subscriberFixture{
		{email: "consented-" + emailMarker + "@example.test", granted: true},
		{email: "unconsented-" + emailMarker + "@example.test"},
		{email: "archived-" + emailMarker + "@example.test", granted: true, archived: true},
	}
	for _, fixture := range fixtures {
		var subscriberID string
		if err := tenantTx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::citext, 'enabled', 'api')
RETURNING id::text`, tenantID, fixture.email).Scan(&subscriberID); err != nil {
			t.Fatalf("seed preview subscriber %s: %v", fixture.email, err)
		}
		seedCanonicalEmailFixture(t, ctx, tenantTx, tenantID, subscriberID, fixture.email, fixture.granted)
		if fixture.archived {
			if _, err := tenantTx.Exec(ctx, `
UPDATE subscribers
   SET archived_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
				t.Fatalf("archive preview subscriber %s: %v", fixture.email, err)
			}
		}
	}
	if err := tenantTx.Commit(ctx); err != nil {
		t.Fatalf("commit preview subscribers: %v", err)
	}

	return tenantID, emailMarker
}

func requestAggregatePreview(t *testing.T, deps *Deps, tenantID, body string) (*httptest.ResponseRecorder, PreviewResponse) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segments/preview", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	deps.Preview(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", rec.Code, rec.Body.String())
	}
	var response PreviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode preview: %v; body=%s", err, rec.Body.String())
	}
	return rec, response
}

func TestPreviewAggregateScopeAndConsent_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	deps := &Deps{Repo: &Repo{Pool: pool}}
	ast := `{"op":"condition","field":"email","comparator":"contains","value":"` + marker + `"}`

	rec, active := requestAggregatePreview(t, deps, tenantID, `{"queryAst":`+ast+`}`)
	if active.Count != 2 || active.WorkspaceTotal != 2 || active.WorkspacePercentage != 100 || active.ArchiveScope != "active_only" {
		t.Fatalf("active preview = %+v", active)
	}
	if len(active.AppliedExclusions) != 1 || active.AppliedExclusions[0] != "archived_subscribers" {
		t.Fatalf("active exclusions = %#v", active.AppliedExclusions)
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), `"sql"`) || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("privacy/cache contract headers=%v body=%s", rec.Header(), rec.Body.String())
	}

	_, consented := requestAggregatePreview(t, deps, tenantID,
		`{"queryAst":`+ast+`,"target_channel":"email"}`)
	if consented.Count != 1 || consented.WorkspaceTotal != 2 || len(consented.AppliedExclusions) != 3 ||
		consented.AppliedExclusions[1] != "non_enabled_subscribers" ||
		consented.AppliedExclusions[2] != "missing_email_marketing_consent" {
		t.Fatalf("consent-gated preview = %+v", consented)
	}

	_, expanded := requestAggregatePreview(t, deps, tenantID,
		`{"queryAst":`+ast+`,"include_archived":true}`)
	if expanded.Count != 3 || expanded.WorkspaceTotal != 3 || expanded.WorkspacePercentage != 100 ||
		expanded.ArchiveScope != "including_archived" || len(expanded.AppliedExclusions) != 0 {
		t.Fatalf("including-archived preview = %+v", expanded)
	}
}

func TestPreviewExecutesRollingEngagementAndCreatedWindows_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	recentEmail := "consented-" + marker + "@example.test"
	oldEmail := "unconsented-" + marker + "@example.test"
	neverEmail := "never-" + marker + "@example.test"
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
SET created_at = CASE email
    WHEN $2 THEN now() - interval '1 day'
    WHEN $3 THEN now() - interval '20 days'
    ELSE created_at
END
WHERE tenant_id = $1::uuid AND email IN ($2, $3)`,
		tenantID, recentEmail, oldEmail); err != nil {
		t.Fatalf("seed rolling-window subscriber dates: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, created_at)
VALUES ($1::uuid, $2, 'enabled', 'api', now() - interval '40 days')`,
		tenantID, neverEmail); err != nil {
		t.Fatalf("seed never-engaged subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES
    ($1::uuid, $2, 'opened', now() - interval '1 day'),
    ($1::uuid, $3, 'opened', now() - interval '20 days'),
    ($1::uuid, $2, 'clicked', now() - interval '1 day'),
    ($1::uuid, $3, 'clicked', now() - interval '20 days')`,
		tenantID, recentEmail, oldEmail); err != nil {
		t.Fatalf("seed rolling-window events: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit rolling-window fixture: %v", err)
	}

	deps := &Deps{Repo: &Repo{Pool: pool}}
	markerLeaf := `{"op":"condition","field":"email","comparator":"contains","value":"` + marker + `"}`
	previewCount := func(rule string) int {
		t.Helper()
		ast := `{"op":"and","children":[` + markerLeaf + `,` + rule + `]}`
		_, response := requestAggregatePreview(t, deps, tenantID, `{"queryAst":`+ast+`}`)
		return response.Count
	}

	if got := previewCount(`{"op":"condition","field":"last_opened_at","comparator":"in_last_days","value":7}`); got != 1 {
		t.Fatalf("opened in last 7 days count = %d, want 1", got)
	}
	if got := previewCount(`{"op":"condition","field":"last_clicked_at","comparator":"more_than_days_ago","value":7}`); got != 2 {
		t.Fatalf("not clicked in last 7 days count = %d, want old + never = 2", got)
	}
	if got := previewCount(`{"op":"condition","field":"created_at","comparator":"gte","value":"now-7d"}`); got != 1 {
		t.Fatalf("created in last 7 days count = %d, want 1", got)
	}
}
