package readiness

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/config"
)

type pingerFunc func(context.Context) error

func (f pingerFunc) Ping(ctx context.Context) error { return f(ctx) }

func TestReadyReturnsOnlyNonSensitiveStatus(t *testing.T) {
	deps := &Deps{
		Env: func(key string) string {
			if key == "POSTWAVE_ENV" {
				return "development"
			}
			return ""
		},
		DB: pingerFunc(func(context.Context) error { return nil }),
	}
	recorder := httptest.NewRecorder()
	deps.Ready(recorder, httptest.NewRequest(http.MethodGet, "/api/ready", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got, want := recorder.Body.String(), "{\"status\":\"ready\"}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestReadyHidesDatabaseFailureDetails(t *testing.T) {
	deps := &Deps{
		Env: func(string) string { return "development" },
		DB:  pingerFunc(func(context.Context) error { return errors.New("postgres password secret-value") }),
	}
	recorder := httptest.NewRecorder()
	deps.Ready(recorder, httptest.NewRequest(http.MethodGet, "/api/ready", nil))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	body, err := io.ReadAll(recorder.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(body), "{\"status\":\"unavailable\"}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if strings.Contains(string(body), "postgres") || strings.Contains(string(body), "secret-value") {
		t.Fatalf("dependency detail leaked in %q", body)
	}
}

func TestReadyRejectsBlockedProductionConfiguration(t *testing.T) {
	deps := &Deps{
		Config: config.Config{},
		Env: func(key string) string {
			if key == "POSTWAVE_ENV" {
				return "production"
			}
			return ""
		},
		DB: pingerFunc(func(context.Context) error { return nil }),
	}
	recorder := httptest.NewRecorder()
	deps.Ready(recorder, httptest.NewRequest(http.MethodGet, "/api/ready", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	if strings.Contains(recorder.Body.String(), "database_url") {
		t.Fatalf("configuration detail leaked in %q", recorder.Body.String())
	}
}

func TestReadyAcceptsKMSOnlyProductionEncryption(t *testing.T) {
	env := map[string]string{
		"POSTWAVE_ENV":                     "production",
		"AWS_REGION":                       "us-west-2",
		"POSTWAVE_KMS_KEY_ID":              "arn:aws:kms:us-west-2:123456789012:key/example",
		"POSTWAVE_DEPLOYMENT_REGION":       "us-west-2",
		"PUBLIC_BASE_URL":                  "https://app.moosewave.com",
		"REDIS_URL":                        "rediss://redis.internal:6379",
		"OPS_DATABASE_URL":                 "postgres://ops@db.internal/postwave",
		"OPS_SLACK_WEBHOOK_URL":            "https://hooks.slack.invalid/example",
		"POSTWAVE_AUTH_HMAC_PEPPER":        "01234567890123456789012345678901",
		"POSTWAVE_MAILER":                  "ses",
		"POSTWAVE_AUTH_FROM_ADDRESS":       "noreply@moosewave.com",
		"POSTWAVE_PORTAL_ORIGIN":           "https://api.moosewave.com",
		"POSTWAVE_PORTAL_JWT_SECRET":       "01234567890123456789012345678901",
		"POSTWAVE_PORTAL_SPA_DIR":          "/opt/postwave/audit-portal",
		"POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR": "clamav.postwave.internal:3310",
	}
	deps := &Deps{
		Config: config.Config{
			DatabaseURL:             "postgres://app@db.internal/postwave",
			InternalAPIToken:        "internal-token",
			ListmonkWebhookSecret:   "listmonk-secret",
			CORSAllowedOrigins:      []string{"https://app.moosewave.com"},
			APIKeyPepper:            []byte("01234567890123456789012345678901"),
			ConsentCursorSigningKey: []byte("consent-cursor-signing-key-32-bytes"),
			SMSInboxCursorKey:       []byte("sms-inbox-cursor-encryption-key-32-bytes"),
			HelpdeskCursorKey:       []byte("helpdesk-cursor-encryption-key-32-bytes"),
			// Added with the sms_provider_callback_base readiness check: the
			// fixture describes a fully-configured production deployment, so it
			// must satisfy every required check, not every check but the newest.
			SMSProviderCallbackBaseURL: "https://api.moosewave.com",
		},
		Env: func(key string) string { return env[key] },
		DB:  pingerFunc(func(context.Context) error { return nil }),
	}
	recorder := httptest.NewRecorder()
	deps.Ready(recorder, httptest.NewRequest(http.MethodGet, "/api/ready", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestEvaluateRuntimeRequiresFormUploadScannerInProduction(t *testing.T) {
	report := EvaluateRuntime(config.Config{}, func(key string) string {
		if key == "POSTWAVE_ENV" {
			return "production"
		}
		return ""
	})
	if !hasCheck(report, "form_upload_malware_scanner", "fail") {
		t.Fatalf("production without malware scanner was not blocked: %+v", report.Groups)
	}
	report = EvaluateRuntime(config.Config{}, func(key string) string {
		switch key {
		case "POSTWAVE_ENV":
			return "production"
		case "POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR":
			return "clamav.postwave.internal:3310"
		default:
			return ""
		}
	})
	if !hasCheck(report, "form_upload_malware_scanner", "pass") {
		t.Fatalf("configured malware scanner failed readiness: %+v", report.Groups)
	}
}

func TestEvaluateRuntimeRequiresDedicatedConsentCursorSigningKeyInProduction(t *testing.T) {
	report := EvaluateRuntime(config.Config{}, func(key string) string {
		if key == "POSTWAVE_ENV" {
			return "production"
		}
		return ""
	})
	if !hasCheck(report, "consent_cursor_signing_key", "fail") {
		t.Fatalf("production without consent cursor signing key was not blocked: %+v", report.Groups)
	}

	report = EvaluateRuntime(config.Config{
		ConsentCursorSigningKey: []byte("consent-cursor-signing-key-32-bytes"),
	}, func(key string) string {
		if key == "POSTWAVE_ENV" {
			return "production"
		}
		return ""
	})
	if !hasCheck(report, "consent_cursor_signing_key", "pass") {
		t.Fatalf("dedicated consent cursor signing key failed readiness: %+v", report.Groups)
	}
}

func TestEvaluateRuntimeBlocksUnsignedSMSProviderWebhooksInProtectedRuntimes(t *testing.T) {
	for _, environment := range []string{"production", "prod", "staging", "stage"} {
		t.Run(environment, func(t *testing.T) {
			report := EvaluateRuntime(config.Config{}, func(key string) string {
				switch key {
				case "POSTWAVE_ENV":
					return environment
				case "POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS":
					return "true"
				default:
					return ""
				}
			})
			if !hasCheck(report, "no_unsigned_sms_provider_webhooks", "fail") {
				t.Fatalf("protected runtime %q accepted unsigned SMS callbacks: %+v", environment, report.Groups)
			}
		})
	}
}

func TestEvaluateRuntimeAllowsUnsignedSMSProviderWebhooksOnlyInDevelopment(t *testing.T) {
	report := EvaluateRuntime(config.Config{}, func(key string) string {
		switch key {
		case "POSTWAVE_ENV":
			return "development"
		case "POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS":
			return "1"
		default:
			return ""
		}
	})
	if !hasCheck(report, "no_unsigned_sms_provider_webhooks", "pass") {
		t.Fatalf("development-only bypass unexpectedly blocked readiness: %+v", report.Groups)
	}
}

func TestEvaluateRuntimeBlocksPrivilegedDBRoleOverrideInProtectedEnvironments(t *testing.T) {
	for _, environment := range []string{"production", "prod", "staging", "stage"} {
		for _, value := range []string{"1", "0", "false"} {
			t.Run(environment+"_"+value, func(t *testing.T) {
				report := EvaluateRuntime(config.Config{}, func(key string) string {
					switch key {
					case "POSTWAVE_ENV":
						return environment
					case "POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE":
						return value
					default:
						return ""
					}
				})
				if !hasCheck(report, "no_privileged_db_role_override", "fail") {
					t.Fatalf("protected environment %q accepted privileged database role setting %q: %+v", environment, value, report.Groups)
				}
			})
		}
	}
}

func TestEvaluateRuntimeAllowsPrivilegedDBRoleOverrideOnlyInDevelopment(t *testing.T) {
	report := EvaluateRuntime(config.Config{}, func(key string) string {
		switch key {
		case "POSTWAVE_ENV":
			return "development"
		case "POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE":
			return "1"
		default:
			return ""
		}
	})
	if !hasCheck(report, "no_privileged_db_role_override", "pass") {
		t.Fatalf("development override should remain available: %+v", report.Groups)
	}
}

func TestEvaluateRuntimeRecognizesProtectedEnvironmentAliases(t *testing.T) {
	for _, environmentKey := range []string{"APP_ENV", "GO_ENV", "ENVIRONMENT"} {
		t.Run(environmentKey, func(t *testing.T) {
			report := EvaluateRuntime(config.Config{}, func(key string) string {
				switch key {
				case environmentKey:
					return "staging"
				case "POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE":
					return "1"
				default:
					return ""
				}
			})
			if !hasCheck(report, "no_privileged_db_role_override", "fail") {
				t.Fatalf("protected environment alias %q was ignored: %+v", environmentKey, report.Groups)
			}
		})
	}
}

func TestEvaluateRuntimeRejectsPrivilegedOverrideWhenEnvironmentAliasesConflict(t *testing.T) {
	report := EvaluateRuntime(config.Config{}, func(key string) string {
		switch key {
		case "POSTWAVE_ENV":
			return "development"
		case "APP_ENV":
			return "production"
		case "POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE":
			return "1"
		default:
			return ""
		}
	})
	if !hasCheck(report, "no_privileged_db_role_override", "fail") {
		t.Fatalf("conflicting protected environment alias was ignored: %+v", report.Groups)
	}
}

func TestReadyBoundsDatabaseProbe(t *testing.T) {
	deadlineSeen := make(chan time.Duration, 1)
	deps := &Deps{
		Env:          func(string) string { return "development" },
		ProbeTimeout: 20 * time.Millisecond,
		DB: pingerFunc(func(ctx context.Context) error {
			deadline, ok := ctx.Deadline()
			if !ok {
				return errors.New("missing deadline")
			}
			deadlineSeen <- time.Until(deadline)
			<-ctx.Done()
			return ctx.Err()
		}),
	}
	started := time.Now()
	recorder := httptest.NewRecorder()
	deps.Ready(recorder, httptest.NewRequest(http.MethodGet, "/api/ready", nil))
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("probe took %s, expected strict short timeout", elapsed)
	}
	if seen := <-deadlineSeen; seen <= 0 || seen > 50*time.Millisecond {
		t.Fatalf("probe deadline = %s, want at most 50ms", seen)
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
}

func TestReadyFailsClosedWithoutDatabase(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Deps{Env: func(string) string { return "development" }}).Ready(
		recorder,
		httptest.NewRequest(http.MethodGet, "/api/ready", nil),
	)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
}

func TestProductionUsesServiceUnavailableForBlockedReport(t *testing.T) {
	deps := &Deps{
		Config: config.Config{},
		Env: func(key string) string {
			if key == "POSTWAVE_ENV" {
				return "production"
			}
			return ""
		},
	}
	recorder := httptest.NewRecorder()
	deps.Production(recorder, httptest.NewRequest(http.MethodGet, "/readiness", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
}

func TestEvaluateBlocksProductionWhenDevBypassesOrSecretsMissing(t *testing.T) {
	cfg := config.Config{
		DatabaseURL:                  "postgres://example",
		AllowDevTenantSlugHeader:     true,
		AllowUnsignedShopifyWebhooks: true,
		CORSAllowedOrigins:           []string{"*"},
	}
	env := map[string]string{
		"POSTWAVE_ENV":    "production",
		"PUBLIC_BASE_URL": "http://example.com",
	}
	report := Evaluate(cfg, func(k string) string { return env[k] })
	if report.Status != "blocked" {
		t.Fatalf("status = %s, want blocked", report.Status)
	}
	if !hasCheck(report, "no_dev_tenant_header", "fail") {
		t.Fatalf("expected no_dev_tenant_header failure: %+v", report.Groups)
	}
	if !hasCheck(report, "cors_no_wildcard", "fail") {
		t.Fatalf("expected cors wildcard failure: %+v", report.Groups)
	}
}

func TestEvaluatePassesWithProductionFoundationConfigured(t *testing.T) {
	cfg := config.Config{
		DatabaseURL:              "postgres://example",
		InternalAPIToken:         "token",
		MigrationServiceURL:      "http://migration:8081",
		DeliverabilityServiceURL: "http://deliverability:8082",
		ListmonkWebhookSecret:    "lm",
		CORSAllowedOrigins:       []string{"https://app.example.com"},
		APIKeyPepper:             []byte("01234567890123456789012345678901"),
		ConsentCursorSigningKey:  []byte("consent-cursor-signing-key-32-bytes"),
		SMSInboxCursorKey:        []byte("sms-inbox-cursor-encryption-key-32-bytes"),
		HelpdeskCursorKey:        []byte("helpdesk-cursor-encryption-key-32-bytes"),
		// See the note on the sibling fixture: a "fully configured production"
		// config must satisfy the sms_provider_callback_base check too.
		SMSProviderCallbackBaseURL: "https://api.moosewave.com",
		ShopifyClientID:            "id",
		ShopifyClientSecret:        "secret",
		ShopifyStateSecret:         "state",
		ShopifyWebhookSecret:       "webhook",
		ShopifyOAuthRedirectURL:    "https://app.example.com/api/public/commerce/shopify/oauth/callback",
		PostmarkAccountToken:       "postmark",
		DKIMRootDomain:             "mail.example.com",
		FormsPublicHost:            "https://forms.example.com",
		RecaptchaSecret:            "recaptcha",
	}
	env := map[string]string{
		"POSTWAVE_ENV":                            "production",
		"AWS_REGION":                              "us-west-2",
		"POSTWAVE_KMS_KEY_ID":                     "arn:aws:kms:us-west-2:123456789012:key/example",
		"POSTWAVE_DEPLOYMENT_REGION":              "us-west-2",
		"PUBLIC_BASE_URL":                         "https://app.example.com",
		"REDIS_URL":                               "rediss://redis.internal:6379",
		"OPS_DATABASE_URL":                        "postgres://ops@db.internal/postwave",
		"OPS_SLACK_WEBHOOK_URL":                   "https://hooks.slack.invalid/example",
		"POSTWAVE_AUTH_HMAC_PEPPER":               "01234567890123456789012345678901",
		"POSTWAVE_MAILER":                         "ses",
		"POSTWAVE_AUTH_FROM_ADDRESS":              "login@example.com",
		"POSTWAVE_PORTAL_ORIGIN":                  "https://api.example.com",
		"POSTWAVE_PORTAL_JWT_SECRET":              "01234567890123456789012345678901",
		"POSTWAVE_PORTAL_SPA_DIR":                 "/opt/postwave/audit-portal",
		"POSTWAVE_OAUTH_GOOGLE_CLIENT_ID":         "google_id",
		"POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET":     "google_secret",
		"POSTWAVE_OAUTH_REDIRECT_BASE":            "https://api.example.com",
		"POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR":        "clamav.postwave.internal:3310",
		"MOOSEWAVE_BILLING_LAUNCH_APPROVAL":       "approved:LAUNCH-2026-07",
		"BILLING_PROVIDER":                        "dodo",
		"DODO_PAYMENTS_ENVIRONMENT":               "live_mode",
		"DODO_PAYMENTS_WEBHOOK_KEY":               "whsec_ZXhhbXBsZQ==",
		"DODO_PAYMENTS_API_KEY":                   "live_api_key_example",
		"DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY": "pdt_live_launch",
		"DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY": "pdt_live_growth",
		"DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY":  "pdt_live_scale",
	}
	report := Evaluate(cfg, func(k string) string { return env[k] })
	if report.Status != "ok" {
		t.Fatalf("status = %s, want ok: %+v", report.Status, report.Groups)
	}
}

func TestEvaluateBillingRequiresDodoLiveMode(t *testing.T) {
	env := map[string]string{
		"POSTWAVE_ENV":                            "production",
		"BILLING_PROVIDER":                        "dodo",
		"DODO_PAYMENTS_ENVIRONMENT":               "test_mode",
		"DODO_PAYMENTS_API_KEY":                   "test_api_key",
		"DODO_PAYMENTS_WEBHOOK_KEY":               "whsec_ZXhhbXBsZQ==",
		"DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY": "pdt_live_launch",
		"DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY": "pdt_live_growth",
		"DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY":  "pdt_live_scale",
	}
	report := Evaluate(config.Config{}, func(key string) string { return env[key] })
	if !hasCheck(report, "dodo_environment", "fail") {
		t.Fatalf("production test mode should fail the Dodo Payments live-mode check: %+v", report.Groups)
	}
	for _, staleID := range []string{
		"stripe_secret_key",
		"stripe_webhook_secret",
		"stripe_price_ltd",
		"stripe_price_sending",
		"stripe_price_pro",
	} {
		if containsCheckID(report, staleID) {
			t.Errorf("stale static Stripe check %q remains", staleID)
		}
	}
}

func TestEvaluateBlocksProductionWithoutBillingLaunchApproval(t *testing.T) {
	env := map[string]string{
		"POSTWAVE_ENV":                            "production",
		"BILLING_PROVIDER":                        "dodo",
		"DODO_PAYMENTS_ENVIRONMENT":               "live_mode",
		"DODO_PAYMENTS_API_KEY":                   "live_api_key",
		"DODO_PAYMENTS_WEBHOOK_KEY":               "whsec_ZXhhbXBsZQ==",
		"DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY": "pdt_live_launch",
		"DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY": "pdt_live_growth",
		"DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY":  "pdt_live_scale",
	}
	report := Evaluate(config.Config{}, func(key string) string { return env[key] })
	if !hasCheck(report, "billing_launch_approval", "fail") {
		t.Fatalf("production without a billing launch approval was not blocked: %+v", report.Groups)
	}
}

func TestEvaluateBlocksDuplicateDodoProductIDs(t *testing.T) {
	env := map[string]string{
		"POSTWAVE_ENV":                            "production",
		"BILLING_PROVIDER":                        "dodo",
		"DODO_PAYMENTS_ENVIRONMENT":               "live_mode",
		"DODO_PAYMENTS_API_KEY":                   "live_api_key",
		"DODO_PAYMENTS_WEBHOOK_KEY":               "whsec_ZXhhbXBsZQ==",
		"DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY": "pdt_duplicate",
		"DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY": "pdt_duplicate",
		"DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY":  "pdt_live_scale",
	}
	report := Evaluate(config.Config{}, func(key string) string { return env[key] })
	if !hasCheck(report, "dodo_product_ids_distinct", "fail") {
		t.Fatalf("duplicate Dodo Payments products should fail readiness: %+v", report.Groups)
	}
}

func TestEvaluateOwnsServiceBoundariesNotSidecarEnvironment(t *testing.T) {
	report := Evaluate(config.Config{
		MigrationServiceURL:      "http://migration.postwave.internal:8081",
		DeliverabilityServiceURL: "http://deliverability.postwave.internal:8082",
	}, func(key string) string {
		if key == "POSTWAVE_ENV" {
			return "production"
		}
		return ""
	})
	for _, checkID := range []string{
		"migration_service_url",
		"migration_service_url_private_or_https",
		"deliverability_service_url",
		"deliverability_service_url_private_or_https",
	} {
		if !containsCheckID(report, checkID) {
			t.Errorf("service-boundary check %q missing", checkID)
		}
	}
	for _, sidecarCheckID := range []string{
		"migration_session_kek",
		"migration_demo_mode_off",
		"memory_fallback_off",
		"mailchimp_oauth_client",
		"convertkit_oauth_client",
		"stripe_connect_secret",
		"diagnostician_llm",
		"diagnostician_prompts",
		"diagnostician_eval_cases",
		"hcti_renderer",
		"dmarc_ingest",
		"seedlist",
		"seedlist_connector",
	} {
		if containsCheckID(report, sidecarCheckID) {
			t.Errorf("API report still claims sidecar-owned check %q", sidecarCheckID)
		}
	}
}

func TestServiceBoundaryURLValidation(t *testing.T) {
	for _, raw := range []string{
		"https://migration.example.com",
		"http://migration:8081",
		"http://migration.postwave.internal:8081",
		"http://migration.namespace.svc:8081",
		"http://migration.namespace.svc.cluster.local:8081",
		"http://10.0.4.12:8081",
	} {
		if !isPrivateOrHTTPSURL(raw) {
			t.Errorf("isPrivateOrHTTPSURL(%q) = false", raw)
		}
	}
	for _, raw := range []string{
		"http://localhost:8081",
		"http://127.0.0.1:8081",
		"http://migration.example.com",
		"http://migration.postwave.internal.evil.example",
		"ftp://migration.postwave.internal",
		"not a URL",
	} {
		if isPrivateOrHTTPSURL(raw) {
			t.Errorf("isPrivateOrHTTPSURL(%q) = true", raw)
		}
	}
}

func hasCheck(report Report, id, status string) bool {
	for _, g := range report.Groups {
		for _, c := range g.Checks {
			if c.ID == id && c.Status == status {
				return true
			}
		}
	}
	return false
}

func containsCheckID(report Report, id string) bool {
	for _, group := range report.Groups {
		for _, check := range group.Checks {
			if check.ID == id {
				return true
			}
		}
	}
	return false
}
