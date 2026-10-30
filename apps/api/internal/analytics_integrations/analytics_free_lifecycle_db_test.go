// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

type analyticsLifecycleSecrets struct{ value string }

func (s *analyticsLifecycleSecrets) Get(context.Context, string) (string, error) {
	return s.value, nil
}

func (s *analyticsLifecycleSecrets) GetJSON(_ context.Context, _ string, dst any) error {
	return json.Unmarshal([]byte(s.value), dst)
}

type analyticsLifecyclePuller struct {
	native analyticsLiveBackfiller
	calls  int
	fault  bool
}

func (p *analyticsLifecyclePuller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	p.calls++
	if p.fault {
		p.fault = false
		// Deliberate fault injection; this is NOT a real provider rate limit.
		return SyncRequest{}, AnalyticsRESTError{StatusCode: 429, RetryAfter: 2 * time.Second}
	}
	return p.native.BackfillPage(ctx, tenantID, integration, cursor)
}

func analyticsLifecycleDatabaseAllowed(databaseURL string) bool {
	if strings.TrimSpace(databaseURL) == "" {
		return false
	}
	// Validate the driver's resolved configuration: query parameters and
	// environment defaults can override the host/database in a URL's path.
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil || !strings.HasPrefix(cfg.ConnConfig.Database, "postwave_local_qa_") {
		return false
	}
	localHost := func(host string) bool {
		if host == "localhost" || strings.HasPrefix(host, "/") {
			return true
		}
		address, err := netip.ParseAddr(host)
		return err == nil && address.IsLoopback()
	}
	if !localHost(cfg.ConnConfig.Host) {
		return false
	}
	for _, fallback := range cfg.ConnConfig.Fallbacks {
		if !localHost(fallback.Host) {
			return false
		}
	}
	return true
}

func TestAnalyticsLifecycleDatabaseGuard(t *testing.T) {
	for _, databaseURL := range []string{
		"postgres://localhost/postwave_local_qa_test?host=remote.example.com",
		"postgres://localhost/postwave_local_qa_test?dbname=production",
		"postgres://localhost,remote.example.com/postwave_local_qa_test",
		"postgres://127.0.0.1/production",
		"",
	} {
		if analyticsLifecycleDatabaseAllowed(databaseURL) {
			t.Fatal("lifecycle guard allowed a remote host or non-QA database")
		}
	}
	for _, databaseURL := range []string{
		"postgres://127.0.0.1/postwave_local_qa_test",
		"postgres:///postwave_local_qa_test?host=/tmp",
	} {
		if !analyticsLifecycleDatabaseAllowed(databaseURL) {
			t.Fatal("lifecycle guard rejected an explicit local QA database")
		}
	}
}

// This opt-in test uses the real repository, handlers, profile sink and provider
// APIs, with disposable tenants in a loopback-only local QA database. Its
// automated_* evidence is deliberately separate from the manual certification
// report: it does not claim human observation, provider-side credential
// revocation, or a genuine provider-generated 429.
func TestAnalyticsFreeLifecycle_DB(t *testing.T) {
	if !livecert.Bool("ANALYTICS_LIVE_LIFECYCLE") {
		t.Skip("ANALYTICS_LIVE_LIFECYCLE=1 not set")
	}
	databaseURL := strings.TrimSpace(os.Getenv("ANALYTICS_LIVE_LIFECYCLE_DATABASE_URL"))
	if !analyticsLifecycleDatabaseAllowed(databaseURL) {
		t.Fatal("lifecycle proof requires an explicitly selected loopback postwave_local_qa_* database")
	}
	t.Setenv("DATABASE_MAX_CONNS", "4")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var databaseName string
	if err := pool.QueryRow(ctx, "SELECT current_database()").Scan(&databaseName); err != nil || !strings.HasPrefix(databaseName, "postwave_local_qa_") {
		t.Fatal("connected database is not a local QA database")
	}

	for _, provider := range analyticsLiveProviders() {
		t.Run(provider.provider, func(t *testing.T) {
			credentialJSON := livecert.Env(provider.envKey)
			if credentialJSON == "" {
				t.Skipf("%s is unavailable", provider.envKey)
			}
			tenantID := uuid.NewString()
			tx, err := db.WithTenant(ctx, pool, tenantID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'Disposable analytics lifecycle QA', 'analytics-live-' || $1::text, 'studio')`, tenantID); err != nil {
				_ = tx.Rollback(ctx)
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cleanupCancel()
				tx, err := db.WithTenant(cleanupCtx, pool, tenantID)
				if err != nil {
					t.Error(err)
					return
				}
				defer func() { _ = tx.Rollback(cleanupCtx) }()
				if _, err := tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
					t.Errorf("remove disposable lifecycle tenant: %v", err)
					return
				}
				if err := tx.Commit(cleanupCtx); err != nil {
					t.Error(err)
				}
			})
			settings := map[string]any{"backfill_on_connect": false}
			if pageSize := livecert.Env(provider.envKey + "_PAGE_SIZE"); pageSize != "" {
				settings["page_size"] = pageSize
			}
			var payload map[string]any
			if err := json.Unmarshal([]byte(credentialJSON), &payload); err != nil {
				t.Fatal("provider credentials must be JSON")
			}
			if provider.settingsKey != "" {
				value := livecert.Env(provider.envKey + "_SETTING")
				if value == "" {
					value, _ = payload[provider.settingsKey].(string)
				}
				settings[provider.settingsKey] = value
			}
			if provider.provider == ProviderTripleWhale {
				settings["shop_id"] = payload["shop_id"]
			}
			secrets := &analyticsLifecycleSecrets{value: credentialJSON}
			puller := &analyticsLifecyclePuller{native: provider.make(secrets), fault: true}
			repo := &Repo{Pool: pool}
			now := time.Now().UTC()
			deps := &Deps{Repo: repo, Now: func() time.Time { return now }, Profiles: SubscriberProfileSink{Repo: &subscribers.Repo{Pool: pool, CustomFields: &customfields.Validator{Repo: &customfields.Repo{Pool: pool}, Mode: customfields.ModeAuto}}}}
			switch provider.provider {
			case ProviderPostHog:
				deps.PostHogBackfiller = puller
			case ProviderTripleWhale:
				deps.TripleWhaleBackfiller = puller
			case ProviderMixpanel:
				deps.MixpanelBackfiller = puller
			case ProviderAmplitude:
				deps.AmplitudeBackfiller = puller
			}
			in := IntegrationInput{Provider: provider.provider, Name: "Disposable live lifecycle", Status: "connected", CredentialsRef: "local-live-proof", Settings: settings}
			integration, err := repo.UpsertIntegration(ctx, tenantID, in)
			if err != nil {
				t.Fatal(err)
			}
			invoke := func(handler http.HandlerFunc, method string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "/api/v1/analytics-integrations/"+integration.ID, strings.NewReader(`{}`))
				r.Header.Set("Content-Type", "application/json")
				route := chi.NewRouteContext()
				route.URLParams.Add("id", integration.ID)
				requestCtx := middleware.WithTenant(context.WithValue(ctx, chi.RouteCtxKey, route), &middleware.Tenant{ID: tenantID})
				response := httptest.NewRecorder()
				handler(response, r.WithContext(requestCtx))
				return response
			}
			recorder := &livecert.Recorder{Provider: provider.provider, ReportPath: livecert.Env("ANALYTICS_LIVE_LIFECYCLE_REPORT")}
			record := func(check string, details map[string]any) {
				if err := recorder.Record(check, details); err != nil {
					t.Fatal(err)
				}
			}
			if response := invoke(deps.BackfillIntegration, http.MethodPost); response.Code != http.StatusBadGateway {
				t.Fatalf("injected 429 response=%d", response.Code)
			}
			retry, err := repo.GetIntegration(ctx, tenantID, integration.ID)
			if err != nil || retry.SyncCursor == "" || retry.Status != "error" {
				t.Fatalf("429 checkpoint was not persisted: err=%v", err)
			}
			before := puller.calls
			if response := invoke(deps.BackfillIntegration, http.MethodPost); response.Code != http.StatusAccepted || puller.calls != before {
				t.Fatal("retry before Retry-After made an upstream call")
			}
			now = now.Add(3 * time.Second)
			if response := invoke(deps.BackfillIntegration, http.MethodPost); response.Code != http.StatusAccepted || puller.calls != before+1 {
				t.Fatalf("real provider recovery failed: status=%d", response.Code)
			}
			checkpoint, err := repo.GetIntegration(ctx, tenantID, integration.ID)
			if err != nil || checkpoint.Status != "connected" || checkpoint.SyncCursor == "" {
				t.Fatalf("provider recovery did not persist a connected checkpoint: err=%v", err)
			}
			record("automated_retry_after_real_recovery", map[string]any{"rate_limit_origin": "controlled_fault_injection", "real_provider_recovery": true, "retry_deferred_before_due": true, "provider_generated_429": false})

			before = puller.calls
			if response := invoke(deps.DisconnectIntegration, http.MethodDelete); response.Code != http.StatusOK {
				t.Fatalf("disconnect failed: status=%d", response.Code)
			}
			disconnected, err := repo.GetIntegration(ctx, tenantID, integration.ID)
			if err != nil || disconnected.Status != "disconnected" || disconnected.SyncCursor != checkpoint.SyncCursor || disconnected.Settings["provider_cleanup"] == nil {
				t.Fatal("disconnect lost persisted cleanup/checkpoint evidence")
			}
			if response := invoke(deps.BackfillIntegration, http.MethodPost); response.Code != http.StatusConflict || puller.calls != before {
				t.Fatalf("disconnected backfill was not blocked: status=%d", response.Code)
			}
			targets, err := repo.ListAnalyticsBackfillTargets(ctx, provider.provider, 1000, now.Add(time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			for _, target := range targets {
				if target.IntegrationID == integration.ID {
					t.Fatal("disconnected integration remained eligible for scheduled sync")
				}
			}
			record("automated_disconnect_local_safety", map[string]any{"database_persisted": true, "manual_sync_blocked": true, "scheduled_sync_excluded": true, "checkpoint_preserved": true, "provider_console_cleanup_performed": false})
			reconnected, err := repo.UpsertIntegration(ctx, tenantID, in)
			if err != nil || reconnected.ID != integration.ID || reconnected.SyncCursor != checkpoint.SyncCursor {
				t.Fatal("reconnect did not preserve the integration and checkpoint")
			}
			if response := invoke(deps.BackfillIntegration, http.MethodPost); response.Code != http.StatusAccepted {
				t.Fatalf("reconnect backfill failed: status=%d", response.Code)
			}
			record("automated_reconnect_checkpoint_resume", map[string]any{"integration_id_preserved": true, "checkpoint_preserved": true, "backfill_accepted": true})
			if minPages, _ := strconv.Atoi(livecert.Env(provider.envKey + "_EXPECT_MIN_PAGES")); minPages > 1 {
				if provider.provider != ProviderPostHog || minPages > 10 || checkpoint.SyncCursor == postHogCursorComplete {
					t.Fatal("pagination proof requires PostHog and a nonterminal persisted checkpoint (2–10 pages)")
				}
				// One real page preceded disconnect; the first reconnect call used
				// its persisted cursor. Bound every additional continuation.
				pages := 2
				for {
					current, err := repo.GetIntegration(ctx, tenantID, integration.ID)
					if err != nil {
						t.Fatal(err)
					}
					if current.SyncCursor == postHogCursorComplete {
						break
					}
					if pages >= 10 {
						t.Fatal("real pagination exceeded the ten-page QA ceiling")
					}
					if response := invoke(deps.BackfillIntegration, http.MethodPost); response.Code != http.StatusAccepted {
						t.Fatalf("real pagination failed: status=%d", response.Code)
					}
					pages++
				}
				if pages < minPages {
					t.Fatal("real pagination ended before the expected number of pages")
				}
				tx, err := db.WithTenant(ctx, pool, tenantID)
				if err != nil {
					t.Fatal(err)
				}
				var count, distinctEmails int
				err = tx.QueryRow(ctx, `SELECT count(*), count(DISTINCT email) FROM subscribers WHERE tenant_id=$1::uuid`, tenantID).Scan(&count, &distinctEmails)
				_ = tx.Rollback(ctx)
				expectedCount, _ := strconv.Atoi(livecert.Env(provider.envKey + "_EXPECT_PROFILE_COUNT"))
				if err != nil || expectedCount < 2 || count != expectedCount || distinctEmails != expectedCount {
					t.Fatalf("paginated profile persistence: count=%d distinct=%d expected=%d error=%v", count, distinctEmails, expectedCount, err)
				}
				record("automated_real_pagination_checkpoint_resume", map[string]any{"real_provider_pages": pages, "persisted_profiles": count, "unique_emails": distinctEmails, "disconnect_between_pages": true, "terminal_cursor_persisted": true})
			}
			if expectedEmail := strings.TrimSpace(livecert.Env(provider.envKey + "_EXPECT_EMAIL")); expectedEmail != "" {
				if !strings.HasSuffix(expectedEmail, ".example") && !strings.HasSuffix(expectedEmail, "@example.com") {
					t.Fatal("expected profile must be a synthetic example-domain fixture")
				}
				tx, err := db.WithTenant(ctx, pool, tenantID)
				if err != nil {
					t.Fatal(err)
				}
				var status, source, firstName, lastName string
				var rawTraits []byte
				err = tx.QueryRow(ctx, `SELECT status, source_platform, first_name, last_name, custom_fields FROM subscribers WHERE tenant_id=$1::uuid AND email=$2`, tenantID, expectedEmail).Scan(&status, &source, &firstName, &lastName, &rawTraits)
				_ = tx.Rollback(ctx)
				if err != nil {
					t.Fatalf("expected real provider fixture was not persisted: %v", err)
				}
				var traits map[string]any
				if err := json.Unmarshal(rawTraits, &traits); err != nil {
					t.Fatal(err)
				}
				if status != subscribers.StatusUnconfirmed || source != provider.provider || traits["analytics_provider"] != provider.provider || traits["qa_fixture"] != true || !strings.HasPrefix(analyticsPropString(traits, "analytics_source_id"), strings.ReplaceAll(provider.provider, "-", "")+"://") {
					t.Fatal("import did not preserve fixture traits, provenance, or unconfirmed status")
				}
				if expected := livecert.Env(provider.envKey + "_EXPECT_USER_ID"); expected != "" && traits["analytics_user_id"] != expected {
					t.Fatal("import lost the provider's distinct user ID")
				}
				if firstName != livecert.Env(provider.envKey+"_EXPECT_FIRST_NAME") || lastName != livecert.Env(provider.envKey+"_EXPECT_LAST_NAME") {
					t.Fatal("import did not preserve fixture names")
				}
				record("automated_real_profile_mapping", map[string]any{"fixture_found_in_database": true, "names_preserved": true, "traits_preserved": true, "provider_identity_preserved": true, "canonical_status": status})
			}
			invalid := map[string]any{}
			for key, value := range payload {
				invalid[key] = value
			}
			for _, key := range []string{"api_key", "token", "api_secret", "secret", "secret_key"} {
				if _, present := invalid[key]; present {
					invalid[key] = "invalid-local-qa-" + uuid.NewString()
				}
			}
			badJSON, _ := json.Marshal(invalid)
			secrets.value = string(badJSON)
			if _, err := puller.native.BackfillPage(ctx, tenantID, *reconnected, ""); err == nil {
				t.Fatal("real provider accepted deliberately invalid test authentication")
			}
			secrets.value = credentialJSON
			if _, err := puller.native.BackfillPage(ctx, tenantID, *reconnected, ""); err != nil {
				t.Fatalf("restored authentication did not recover: %v", err)
			}
			record("automated_local_authentication_replacement", map[string]any{"invalid_authentication_rejected_by_real_provider": true, "restored_authentication_succeeds": true, "provider_key_rotated_or_revoked": false})
			t.Logf("%s: real-API/local-DB disconnect, resume, controlled retry and authentication recovery passed; manual certification unchanged", provider.provider)
		})
	}
}
