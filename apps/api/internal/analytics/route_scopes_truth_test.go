// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func analyticsRouteRequest(
	t *testing.T,
	method string,
	path string,
	scopes ...apikeys.Scope,
) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	(&ExtendedDeps{Service: &Service{}}).MountRoutes(router)
	req := httptest.NewRequest(method, path, nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func analyticsSessionRequest(t *testing.T, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	(&ExtendedDeps{Service: &Service{}}).MountRoutes(router)
	req := httptest.NewRequest(method, path, nil)
	ctx := middleware.WithUser(req.Context(), &middleware.User{
		ID:       "viewer-1",
		TenantID: "tenant-1",
		Role:     "viewer",
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func TestAnalyticsAggregateRoutesExplicitlyRequireReadReports(t *testing.T) {
	paths := []string{
		"/api/v1/campaigns/campaign-1/link-report",
		"/api/v1/campaigns/campaign-1/geography",
		"/api/v1/campaigns/campaign-1/devices",
		"/api/v1/campaigns/campaign-1/bounces",
		"/api/v1/campaigns/campaign-1/revenue",
		"/api/v1/analytics/campaigns/compare?ids=campaign-1",
		"/api/v1/analytics/cohorts",
		"/api/v1/analytics/subscribers/funnel",
		"/api/v1/analytics/subscribers/timeseries",
		"/api/v1/analytics/timeseries?group_by=campaign",
		"/api/v1/analytics/template-leaderboard",
		"/api/v1/analytics/fatigue",
		"/api/v1/campaigns/campaign-1/engagement",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			rec := analyticsRouteRequest(t, http.MethodGet, path, apikeys.ScopeReadCampaigns)
			if rec.Code != http.StatusForbidden ||
				!strings.Contains(rec.Body.String(), "insufficient_scope") {
				t.Fatalf("unrelated scope: status=%d body=%q", rec.Code, rec.Body.String())
			}

			// No tenant is intentionally installed. A 401 no_tenant proves the
			// correct scope passed the production route gate without touching DB.
			rec = analyticsRouteRequest(t, http.MethodGet, path, apikeys.ScopeReadReports)
			if rec.Code != http.StatusUnauthorized ||
				!strings.Contains(rec.Body.String(), "no_tenant") {
				t.Fatalf("read:reports did not reach handler: status=%d body=%q", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestCampaignReportCSVRequiresCampaignReportAndSubscriberScopes(t *testing.T) {
	path := "/api/v1/campaigns/campaign-1/report.csv"
	partial := [][]apikeys.Scope{
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeReadReports},
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeReadCampaigns, apikeys.ScopeReadReports},
		{apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers},
		{apikeys.ScopeReadReports, apikeys.ScopeReadSubscribers},
	}
	for _, scopes := range partial {
		rec := analyticsRouteRequest(t, http.MethodGet, path, scopes...)
		if rec.Code != http.StatusForbidden ||
			!strings.Contains(rec.Body.String(), "insufficient_scope") {
			t.Fatalf("partial scopes %v: status=%d body=%q", scopes, rec.Code, rec.Body.String())
		}
	}

	rec := analyticsRouteRequest(
		t,
		http.MethodGet,
		path,
		apikeys.ScopeReadCampaigns,
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("all scopes did not reach handler: status=%d body=%q", rec.Code, rec.Body.String())
	}

	session := analyticsSessionRequest(t, http.MethodGet, path)
	if session.Code != http.StatusUnauthorized || !strings.Contains(session.Body.String(), "no_tenant") {
		t.Fatalf("viewer session did not pass read-only scope gate: status=%d body=%q",
			session.Code, session.Body.String())
	}
}

func TestCrossChannelTimelineRequiresReportAndSubscriberScopes(t *testing.T) {
	path := "/api/v1/subscribers/subscriber-1/cross-channel-timeline"
	for _, scope := range []apikeys.Scope{
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	} {
		rec := analyticsRouteRequest(t, http.MethodGet, path, scope)
		if rec.Code != http.StatusForbidden ||
			!strings.Contains(rec.Body.String(), "insufficient_scope") {
			t.Fatalf("scope %s: status=%d body=%q", scope, rec.Code, rec.Body.String())
		}
	}
	rec := analyticsRouteRequest(
		t,
		http.MethodGet,
		path,
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("both scopes did not reach handler: status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestCampaignReportCSVValidationAndEncoding(t *testing.T) {
	t.Run("invalid page values fail before repository access", func(t *testing.T) {
		router := chi.NewRouter()
		(&ExtendedDeps{Service: &Service{}}).MountRoutes(router)
		req := httptest.NewRequest(http.MethodGet,
			"/api/v1/campaigns/campaign-1/report.csv?limit=50001", nil)
		ctx := middleware.WithAPIKeyAuth(req.Context())
		ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
		ctx = apikeys.WithScopes(ctx,
			[]apikeys.Scope{
				apikeys.ScopeReadCampaigns,
				apikeys.ScopeReadReports,
				apikeys.ScopeReadSubscribers,
			},
		)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req.WithContext(ctx))
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "bad_limit") {
			t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
		}
	})

	t.Run("truthful timestamps and spreadsheet formula neutralization", func(t *testing.T) {
		sent := time.Date(2026, 7, 24, 8, 0, 0, 0, time.UTC)
		delivered := sent.Add(time.Minute)
		var body bytes.Buffer
		err := encodeCampaignReportCSV(&body, []CSVReportRow{{
			SubscriberEmail: "=IMPORTXML@example.test",
			SentAt:          sent,
			DeliveredAt:     delivered,
			ClickCount:      2,
		}})
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		csvBody := body.String()
		for _, want := range []string{
			"'=IMPORTXML@example.test",
			"2026-07-24T08:00:00Z",
			"2026-07-24T08:01:00Z",
			",2,",
		} {
			if !strings.Contains(csvBody, want) {
				t.Fatalf("CSV missing %q: %q", want, csvBody)
			}
		}
	})

	t.Run("writer errors are returned", func(t *testing.T) {
		want := errors.New("disk full")
		err := encodeCampaignReportCSV(errorWriter{err: want}, []CSVReportRow{{
			SubscriberEmail: "buyer@example.test",
		}})
		if !errors.Is(err, want) {
			t.Fatalf("error=%v, want %v", err, want)
		}
	})

	t.Run("encoded byte ceiling aborts before a response can be committed", func(t *testing.T) {
		body := &cappedCSVBuffer{limit: 128}
		err := encodeCampaignReportCSV(body, []CSVReportRow{{
			SubscriberEmail: strings.Repeat("a", 256) + "@example.test",
		}})
		if !errors.Is(err, errCampaignReportCSVTooLarge) {
			t.Fatalf("error=%v, want encoded-size sentinel", err)
		}
		if body.Len() > 128 {
			t.Fatalf("buffer grew past ceiling: %d", body.Len())
		}
	})
}

type errorWriter struct {
	err error
}

func (w errorWriter) Write([]byte) (int, error) {
	return 0, w.err
}

func TestSortDeviceRowsDeterministically(t *testing.T) {
	rows := []DeviceRow{
		{Client: "Zulu", Opens: 4, Clicks: 2},
		{Client: "Alpha", Opens: 4, Clicks: 2},
		{Client: "More clicks", Opens: 4, Clicks: 3},
		{Client: "Most opens", Opens: 5, Clicks: 0},
	}
	sortDeviceRows(rows)
	got := []string{rows[0].Client, rows[1].Client, rows[2].Client, rows[3].Client}
	want := []string{"Most opens", "More clicks", "Alpha", "Zulu"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order=%v, want %v", got, want)
		}
	}
}
