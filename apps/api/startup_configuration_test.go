package main

import (
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/referrals"
)

func TestProductionStartupConfigurationReportsAllUnsafeValues(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "true")
	t.Setenv("POSTWAVE_DEV_TRANSACTIONAL_SINK", "true")
	t.Setenv("POSTWAVE_DEV_OPS_OPERATOR_EMAIL", "operator@example.com")
	t.Setenv("POSTWAVE_REFERRAL_COOKIE_SECRET", "short")
	t.Setenv("AWS_REGION", "")
	t.Setenv("POSTWAVE_KMS_KEY_ID", "")
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "")

	err := validateProductionStartupConfiguration(config.Config{
		AllowDevTenantSlugHeader:             true,
		AllowDevAdminRoleHeader:              true,
		AllowDevListmonkWebhookBypass:        true,
		AllowUnsignedShopifyWebhooks:         true,
		AllowLegacyInboundWebhookSignatureV1: true,
		ShopifyClientID:                      "shopify-client",
	})
	if err == nil {
		t.Fatal("unsafe production configuration was accepted")
	}
	for _, want := range []string{
		"POSTWAVE_DEV_TENANT_SLUG_HEADER",
		"POSTWAVE_DEV_ADMIN_ROLE_HEADER",
		"POSTWAVE_DEV_LISTMONK_WEBHOOK_BYPASS",
		"POSTWAVE_DEV_SHOPIFY_WEBHOOK_BYPASS",
		"POSTWAVE_LEGACY_INBOUND_SIGNATURE_V1_EXPIRES_AT",
		"POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS",
		"POSTWAVE_SMS_PROVIDER_CALLBACK_BASE_URL",
		"POSTWAVE_DEV_TRANSACTIONAL_SINK",
		"POSTWAVE_DEV_OPS_OPERATOR_EMAIL",
		"SHOPIFY_STATE_SECRET",
		"SHOPIFY_WEBHOOK_SECRET",
		"POSTWAVE_API_KEY_PEPPER",
		"POSTWAVE_CONSENT_CURSOR_SIGNING_KEY",
		"POSTWAVE_HELPDESK_CURSOR_KEY",
		"POSTWAVE_INTERNAL_API_TOKEN",
		"at-rest encryption is unconfigured",
		"POSTWAVE_DEPLOYMENT_REGION",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("startup error omitted %q: %v", want, err)
		}
	}
	// Referral secret: the expectation FOLLOWS THE GATE rather than restating
	// one side of it. referrals.go documents the coupling as a deploy
	// precondition -- "Opening this makes POSTWAVE_REFERRAL_COOKIE_SECRET
	// mandatory in production ... an unsigned referral cookie is forgeable
	// attribution" -- so the requirement must appear exactly when the runtime
	// is available and never when it is not.
	//
	// Written this way because the previous form asserted only the CLOSED case.
	// When the gate was opened, this test began failing and stayed failing:
	// nothing else in the suite covers the startup gate, and running individual
	// packages never reaches it.
	referralRequired := strings.Contains(err.Error(), "POSTWAVE_REFERRAL_COOKIE_SECRET")
	if referrals.OperationalRuntimeAvailable && !referralRequired {
		t.Errorf(
			"referral runtime is available, so production startup MUST demand "+
				"POSTWAVE_REFERRAL_COOKIE_SECRET (unsigned referral cookies are forgeable "+
				"attribution): %v",
			err,
		)
	}
	if !referrals.OperationalRuntimeAvailable && referralRequired {
		t.Errorf(
			"startup required a referral cookie secret while the referral runtime is compile-time disabled: %v",
			err,
		)
	}
}

func TestSMSProviderCallbackBaseRequiresDirectHTTPSOrigin(t *testing.T) {
	for _, invalid := range []string{"", "http://api.moosewave.com", "https://user@api.moosewave.com", "https://api.moosewave.com/path", "https://api.moosewave.com?token=secret"} {
		if validSMSProviderCallbackBase(invalid) {
			t.Fatalf("accepted invalid callback base %q", invalid)
		}
	}
	if !validSMSProviderCallbackBase("https://api.moosewave.com") {
		t.Fatal("rejected canonical direct API callback origin")
	}
}

func TestLegacyInboundSignatureV1WindowIsExplicitAndBounded(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 23, 12, 0, 0, 0, time.UTC)
	base := config.Config{AllowLegacyInboundWebhookSignatureV1: true}
	if err := validateLegacyInboundSignatureV1Window(base, now); err == nil {
		t.Fatal("legacy v1 without deadline was accepted")
	}
	base.LegacyInboundWebhookSignatureV1ExpiresAt = now.Add(8 * 24 * time.Hour)
	if err := validateLegacyInboundSignatureV1Window(base, now); err == nil {
		t.Fatal("legacy v1 window longer than seven days was accepted")
	}
	base.LegacyInboundWebhookSignatureV1ExpiresAt = now.Add(48 * time.Hour)
	if err := validateLegacyInboundSignatureV1Window(base, now); err != nil {
		t.Fatalf("bounded legacy migration window was rejected: %v", err)
	}
	base.LegacyInboundWebhookSignatureV1ExpiresAt = now.Add(-time.Second)
	if err := validateLegacyInboundSignatureV1Window(base, now); err == nil {
		t.Fatal("elapsed legacy migration window was accepted")
	}
}

func TestDevelopmentStartupConfigurationDoesNotApplyProductionGate(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "development")
	if err := validateProductionStartupConfiguration(config.Config{
		AllowDevTenantSlugHeader: true,
	}); err != nil {
		t.Fatalf("development configuration rejected: %v", err)
	}
}

func TestConsentCursorSigningKeyCannotCrossTrustDomains(t *testing.T) {
	shared := []byte("01234567890123456789012345678901")
	t.Setenv("POSTWAVE_AUTH_HMAC_PEPPER", string(shared))
	cfg := config.Config{
		ConsentCursorSigningKey: shared,
		APIKeyPepper:            append([]byte(nil), shared...),
		PIIFingerprintPepper:    append([]byte(nil), shared...),
		InternalAPIToken:        string(shared),
		SendingKEK:              append([]byte(nil), shared...),
	}
	want := []string{
		"POSTWAVE_API_KEY_PEPPER",
		"POSTWAVE_PII_FINGERPRINT_PEPPER",
		"POSTWAVE_AUTH_HMAC_PEPPER",
		"POSTWAVE_INTERNAL_API_TOKEN",
		"POSTWAVE_SENDING_KEK",
	}
	got := consentCursorSecretReuse(cfg)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("reuse domains = %v, want %v", got, want)
	}

	t.Setenv("POSTWAVE_AUTH_HMAC_PEPPER", "auth-auth-auth-auth-auth-auth-auth-01")
	cfg.APIKeyPepper = []byte("api-api-api-api-api-api-api-api-0001")
	cfg.PIIFingerprintPepper = []byte("pii-pii-pii-pii-pii-pii-pii-pii-0001")
	cfg.InternalAPIToken = "internal-internal-internal-internal-01"
	cfg.SendingKEK = []byte("kek-kek-kek-kek-kek-kek-kek-kek-0001")
	if got := consentCursorSecretReuse(cfg); len(got) != 0 {
		t.Fatalf("independent secrets reported as reused: %v", got)
	}
}

func TestHelpdeskCursorKeyCannotCrossTrustDomains(t *testing.T) {
	shared := []byte("01234567890123456789012345678901")
	t.Setenv("POSTWAVE_AUTH_HMAC_PEPPER", string(shared))
	cfg := config.Config{
		HelpdeskCursorKey:       shared,
		APIKeyPepper:            append([]byte(nil), shared...),
		ConsentCursorSigningKey: append([]byte(nil), shared...),
		SMSInboxCursorKey:       append([]byte(nil), shared...),
		PIIFingerprintPepper:    append([]byte(nil), shared...),
		InternalAPIToken:        string(shared),
		SendingKEK:              append([]byte(nil), shared...),
	}
	want := []string{
		"POSTWAVE_API_KEY_PEPPER",
		"POSTWAVE_CONSENT_CURSOR_SIGNING_KEY",
		"POSTWAVE_SMS_INBOX_CURSOR_KEY",
		"POSTWAVE_PII_FINGERPRINT_PEPPER",
		"POSTWAVE_AUTH_HMAC_PEPPER",
		"POSTWAVE_INTERNAL_API_TOKEN",
		"POSTWAVE_SENDING_KEK",
	}
	got := helpdeskCursorSecretReuse(cfg)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("reuse domains = %v, want %v", got, want)
	}

	t.Setenv("POSTWAVE_AUTH_HMAC_PEPPER", "auth-auth-auth-auth-auth-auth-auth-01")
	cfg.APIKeyPepper = []byte("api-api-api-api-api-api-api-api-0001")
	cfg.ConsentCursorSigningKey = []byte("consent-consent-consent-consent-0001")
	cfg.SMSInboxCursorKey = []byte("sms-sms-sms-sms-sms-sms-sms-sms-0001")
	cfg.PIIFingerprintPepper = []byte("pii-pii-pii-pii-pii-pii-pii-pii-0001")
	cfg.InternalAPIToken = "internal-internal-internal-internal-01"
	cfg.SendingKEK = []byte("kek-kek-kek-kek-kek-kek-kek-kek-0001")
	if got := helpdeskCursorSecretReuse(cfg); len(got) != 0 {
		t.Fatalf("independent secrets reported as reused: %v", got)
	}
}

func TestCampaignAssuranceSendGateRequiresDurableRuntime(t *testing.T) {
	t.Parallel()
	if err := validateCampaignAssuranceStartupConfiguration(config.Config{
		CampaignAssuranceSendGateEnabled: true,
	}); err == nil || !strings.Contains(err.Error(), "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME") {
		t.Fatalf("gate without runtime err=%v", err)
	}
	if err := validateCampaignAssuranceStartupConfiguration(config.Config{
		CampaignAssuranceSendGateEnabled: true,
		CampaignAssuranceRuntimeEnabled:  true,
	}); err != nil {
		t.Fatalf("fully enabled runtime rejected: %v", err)
	}
	if err := validateCampaignAssuranceStartupConfiguration(config.Config{}); err != nil {
		t.Fatalf("default-off runtime rejected: %v", err)
	}
	if err := validateCampaignAssuranceStartupConfiguration(config.Config{
		CampaignAssuranceGateRolloutMode: "shadow",
	}); err == nil || !strings.Contains(err.Error(), "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME") {
		t.Fatalf("shadow rollout without runtime err=%v", err)
	}
	if err := validateCampaignAssuranceStartupConfiguration(config.Config{
		CampaignAssuranceGateRolloutMode: "warn",
		CampaignAssuranceRuntimeEnabled:  true,
	}); err != nil {
		t.Fatalf("warn rollout with runtime rejected: %v", err)
	}
	if err := validateCampaignAssuranceStartupConfiguration(config.Config{
		CampaignAssuranceGateRolloutMode: "warn",
		CampaignAssuranceSendGateEnabled: true,
		CampaignAssuranceRuntimeEnabled:  true,
	}); err == nil || !strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("conflicting gate controls err=%v", err)
	}
}

func TestCampaignAssuranceControlPlaneRejectsExecutionCapabilities(t *testing.T) {
	for _, key := range []string{
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY",
		"GEMINI_API_KEY",
		"POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET",
		"POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER",
	} {
		t.Run(key, func(t *testing.T) {
			for _, clear := range []string{
				"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY",
				"GEMINI_API_KEY",
				"POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET",
				"POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER",
			} {
				t.Setenv(clear, "")
			}
			value := "present"
			if key == "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER" {
				value = "true"
			}
			t.Setenv(key, value)
			err := validateCampaignAssuranceStartupConfiguration(config.Config{
				CampaignAssuranceRuntimeEnabled: true,
			})
			if err == nil || !strings.Contains(err.Error(), key) {
				t.Fatalf("execution capability %s was accepted: %v", key, err)
			}
		})
	}
}
