// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestReportRowsPopulatesLifecycleTimestampsAndHidesForeignCampaignsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "csv truth", "csv truth")
	foreignCampaignID := followupCampaign(t, pool, ctx, otherTenantID, "foreign", "foreign")
	email := "csv-" + tenantID[:8] + "@example.test"
	sentAt := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
	deliveredAt := sentAt.Add(time.Minute)
	openedAt := deliveredAt.Add(time.Minute)

	followupExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_recipients
       (tenant_id, campaign_id, subscriber_email, status, sent_at)
VALUES ($1::uuid, $2::uuid, $3, 'sent', $4)`,
		tenantID, campaignID, email, sentAt)
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO subscriber_events
       (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, $3, 'delivered', $4),
       ($1::uuid, $2::uuid, $3, 'opened', $5),
       ($1::uuid, $2::uuid, $3, 'clicked', $5)`,
		tenantID, campaignID, email, deliveredAt, openedAt)

	rows, total, err := NewService(pool).ReportRows(ctx, tenantID, campaignID, 100, 0)
	if err != nil {
		t.Fatalf("ReportRows: %v", err)
	}
	if total != 1 || len(rows) != 1 {
		t.Fatalf("total=%d rows=%d, want 1/1", total, len(rows))
	}
	row := rows[0]
	if row.SubscriberEmail != email ||
		!row.SentAt.Equal(sentAt) ||
		!row.DeliveredAt.Equal(deliveredAt) ||
		!row.OpenedAt.Equal(openedAt) ||
		!row.FirstClickAt.Equal(openedAt) ||
		row.ClickCount != 1 {
		t.Fatalf("lifecycle row is not truthful: %+v", row)
	}

	router := chi.NewRouter()
	(&ExtendedDeps{Service: NewService(pool)}).MountRoutes(router)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/campaigns/"+campaignID+"/report.csv?limit=100", nil)
	requestCtx := middleware.WithAPIKeyAuth(req.Context())
	requestCtx = middleware.WithTenant(requestCtx, &middleware.Tenant{ID: tenantID})
	requestCtx = apikeys.WithScopes(requestCtx, []apikeys.Scope{
		apikeys.ScopeReadCampaigns,
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(requestCtx))
	if rec.Code != http.StatusOK ||
		rec.Header().Get("Cache-Control") != "private, no-store" ||
		rec.Header().Get("X-Postwave-Total-Rows") != "1" ||
		rec.Header().Get("X-Postwave-Returned-Rows") != "1" ||
		rec.Header().Get("X-Postwave-Truncated") != "false" {
		t.Fatalf("CSV response metadata: status=%d headers=%v body=%q",
			rec.Code, rec.Header(), rec.Body.String())
	}

	for label, id := range map[string]string{
		"missing": followupUUID(t),
		"foreign": foreignCampaignID,
	} {
		if _, _, err := NewService(pool).ReportRows(ctx, tenantID, id, 100, 0); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("%s campaign error=%v, want nondisclosing pgx.ErrNoRows", label, err)
		}
	}
}

func TestCampaignTimeseriesReturnsNewestWindowAndExcludesFutureFactsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "timeseries truth", "timeseries truth")
	foreignCampaignID := followupCampaign(t, pool, ctx, otherTenantID, "foreign", "foreign")
	asOf := time.Now().UTC().Truncate(time.Hour).Add(30 * time.Minute)
	latest := asOf.Add(-30 * time.Minute)
	older := latest.Add(-800 * time.Hour)
	future := asOf.Add(15 * time.Minute)

	followupExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_report_events
       (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, 'old@example.test', 'opened', $3),
       ($1::uuid, $2::uuid, 'latest@example.test', 'opened', $4),
       ($1::uuid, $2::uuid, 'future@example.test', 'clicked', $5)`,
		tenantID, campaignID, older, latest, future)

	repo := &Repo{Pool: pool}
	got, err := repo.campaignTimeseriesAt(ctx, tenantID, campaignID, asOf)
	if err != nil {
		t.Fatalf("campaignTimeseriesAt: %v", err)
	}
	if !got.Truncated || len(got.Buckets) != campaignTimeseriesMaxHours {
		t.Fatalf("truncated=%v buckets=%d, want true/%d",
			got.Truncated, len(got.Buckets), campaignTimeseriesMaxHours)
	}
	if got.From == nil || got.To == nil || got.TimeZone != "UTC" ||
		got.Granularity != "hour" || !got.AsOf.Equal(asOf) {
		t.Fatalf("missing/incorrect response context: %+v", got)
	}
	last := got.Buckets[len(got.Buckets)-1]
	if !last.Hour.Equal(latest) || last.Opens != 1 || last.Clicks != 0 {
		t.Fatalf("newest/future boundary wrong: %+v", last)
	}

	for label, id := range map[string]string{
		"missing": followupUUID(t),
		"foreign": foreignCampaignID,
	} {
		if _, err := repo.campaignTimeseriesAt(ctx, tenantID, id, asOf); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("%s campaign error=%v, want nondisclosing pgx.ErrNoRows", label, err)
		}
	}
}

func TestCampaignAggregateReadsRejectMissingMalformedAndForeignCampaignsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	foreignCampaignID := followupCampaign(
		t,
		pool,
		ctx,
		otherTenantID,
		"foreign aggregate",
		"foreign aggregate",
	)
	service := NewService(pool)

	reads := map[string]func(string) error{
		"link report": func(id string) error {
			_, err := service.LinkReport(ctx, tenantID, id, ClassificationAll)
			return err
		},
		"geography": func(id string) error {
			_, err := service.Geography(ctx, tenantID, id, ClassificationAll)
			return err
		},
		"devices": func(id string) error {
			_, err := service.Devices(ctx, tenantID, id, ClassificationAll)
			return err
		},
		"bounces": func(id string) error {
			_, err := service.Bounces(ctx, tenantID, id)
			return err
		},
		"engagement": func(id string) error {
			_, err := service.EngagementPanel(ctx, tenantID, id, false, ClassificationAll)
			return err
		},
		"legacy revenue": func(id string) error {
			_, err := service.Revenue(ctx, tenantID, id)
			return err
		},
	}
	identifiers := map[string]string{
		"missing":   followupUUID(t),
		"foreign":   foreignCampaignID,
		"malformed": "not-a-campaign-uuid",
	}

	for readName, read := range reads {
		for identifierName, id := range identifiers {
			t.Run(readName+"/"+identifierName, func(t *testing.T) {
				if err := read(id); !errors.Is(err, pgx.ErrNoRows) {
					t.Fatalf("error=%v, want nondisclosing pgx.ErrNoRows", err)
				}
			})
		}
	}
}

func TestCampaignAnomalyGETDoesNotMutateDetectedHistoryDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "anomaly read", "anomaly read")
	start := time.Now().UTC().Truncate(time.Hour).Add(-8 * time.Hour)

	// Seven calm hours and one pronounced spike guarantee at least one
	// detected anomaly, making this a meaningful non-mutation assertion.
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_report_events
       (tenant_id, campaign_id, subscriber_email, event_type, at)
SELECT $1::uuid, $2::uuid,
       format('calm-%s-%s@example.test', h, n),
       'opened',
       $3::timestamptz + h * interval '1 hour'
  FROM generate_series(0, 6) AS h
 CROSS JOIN generate_series(1, 10) AS n
UNION ALL
SELECT $1::uuid, $2::uuid,
       format('spike-%s@example.test', n),
       'opened',
       $3::timestamptz + interval '7 hours'
  FROM generate_series(1, 300) AS n`,
		tenantID, campaignID, start)

	before := campaignAnomalyCount(t, pool, ctx, tenantID, campaignID)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/campaigns/"+campaignID+"/anomalies", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	router := chi.NewRouter()
	router.Get("/api/v1/campaigns/{id}/anomalies",
		(&Deps{Repo: &Repo{Pool: pool}}).CampaignAnomalies)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	after := campaignAnomalyCount(t, pool, ctx, tenantID, campaignID)
	if after != before {
		t.Fatalf("GET mutated campaign_anomalies: before=%d after=%d", before, after)
	}
}

func campaignAnomalyCount(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	campaignID string,
) int {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM campaign_anomalies
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid`, tenantID, campaignID).Scan(&count); err != nil {
		t.Fatalf("count campaign anomalies: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit count: %v", err)
	}
	return count
}
