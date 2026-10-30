package main

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/referrals"
	"github.com/postwave/postwave/apps/api/internal/regions"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/sms"
	runtimeobs "github.com/postwave/postwave/packages/runtime/observability"
)

func configureClientIPTrust(cfg config.Config) error {
	if cfg.TrustForwardedIPHeaders {
		if len(cfg.TrustedProxyCIDRs) == 0 {
			return fmt.Errorf("POSTWAVE_TRUSTED_PROXY_CIDRS is required when POSTWAVE_TRUST_FORWARDED_IP_HEADERS is enabled")
		}
		if err := middleware.SetTrustedProxyCIDRs(cfg.TrustedProxyCIDRs); err != nil {
			return fmt.Errorf("configure trusted proxy CIDRs: %w", err)
		}
	} else if err := middleware.SetTrustedProxyCIDRs(nil); err != nil {
		return fmt.Errorf("clear trusted proxy CIDRs: %w", err)
	}
	// The audit trail resolves client IPs through the same trust model as every
	// other consumer, but AuditMetaFromRequest has no options struct to plumb
	// the flag through — so the posture is recorded here alongside the CIDRs it
	// depends on. Set unconditionally so a false value is asserted too.
	middleware.SetAuditTrustForwardedIPHeaders(cfg.TrustForwardedIPHeaders)
	directClientConnections := cfg.DirectClientConnections || !isProductionEnv()
	return middleware.ValidateAdminAllowlistMount(cfg.TrustForwardedIPHeaders, directClientConnections)
}

// campaignSchedulerStartupEnabled combines operator intent with the scheduler's
// compile-time release qualification. The env flags are deliberately
// insufficient while durable claim recovery is unfinished: setting both can
// never arm the worker until code review changes the campaigns-owned constant.
// Keeping this helper free of direct os.Getenv reads makes the contract
// unit-testable and prevents hidden startup bypasses.
func campaignSchedulerStartupEnabled(cfg config.Config) bool {
	return campaigns.LegacySchedulerDurableClaimRecoveryQualified &&
		cfg.CampaignSchedulerEnabled && cfg.CampaignLiveDispatchEnabled
}

// validateCampaignAssuranceStartupConfiguration prevents an operator from
// arming the send gate while the only route that can produce its exact evidence
// remains disabled. Runtime-specific database and object-store readiness is
// checked later, after those dependencies are constructed.
func validateCampaignAssuranceStartupConfiguration(cfg config.Config) error {
	mode, err := resolveCampaignAssuranceGateRollout(cfg)
	if err != nil {
		return err
	}
	if mode != "off" && !cfg.CampaignAssuranceRuntimeEnabled {
		return fmt.Errorf("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME=true is required when Campaign Assurance gate rollout is active")
	}
	if cfg.CampaignAssuranceRuntimeEnabled {
		// This binary is the HTTP/control plane. Model provider credentials,
		// network-capable image acquisition, and the model-sandbox socket belong
		// to distinct workloads. Refuse a deployment that accidentally gives the
		// API one of those capabilities even though current code would not use it.
		for _, key := range []string{
			"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY",
			"GEMINI_API_KEY",
			"POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET",
		} {
			if strings.TrimSpace(os.Getenv(key)) != "" {
				return fmt.Errorf("%s must not be present in the Campaign Assurance API/control-plane process", key)
			}
		}
		if strings.TrimSpace(os.Getenv("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER")) == "true" {
			return fmt.Errorf("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER must be set only on the dedicated image-broker process")
		}
	}
	return nil
}

// installWorkerDrain makes every safego worker participate in the process-wide
// shutdown wait. The returned cleanup restores package state for tests and for
// any future in-process server restart.
func installWorkerDrain() func() {
	var workers sync.WaitGroup
	safego.SetWaitGroup(&workers)
	return func() { safego.SetWaitGroup(nil) }
}

// initializeAPITracing keeps tracing context alive through provider shutdown,
// then cancels it. The returned closure preserves the original defer order.
func initializeAPITracing(logger *slog.Logger) func() {
	ctx, cancel := context.WithCancel(context.Background())
	shutdown := runtimeobs.InitTracing(ctx, "postwave-api", sentryEnvironment())
	return func() {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := shutdown(shutdownCtx); err != nil {
			logger.Warn("tracing: shutdown error", "err", err.Error())
		}
		cancel()
	}
}

// validateProductionStartupConfiguration collects every unsafe startup value
// so one failed deployment reports the complete correction list.
func validateProductionStartupConfiguration(cfg config.Config) error {
	if !isProductionEnv() {
		return nil
	}
	var failures []string
	if cfg.AllowDevTenantSlugHeader {
		failures = append(failures, "POSTWAVE_DEV_TENANT_SLUG_HEADER must not be set in production (lets clients impersonate any tenant by slug)")
	}
	if cfg.AllowDevAdminRoleHeader {
		failures = append(failures, "POSTWAVE_DEV_ADMIN_ROLE_HEADER must not be set in production (trusts client-supplied X-Postwave-Role)")
	}
	if cfg.AllowDevListmonkWebhookBypass {
		failures = append(failures, "POSTWAVE_DEV_LISTMONK_WEBHOOK_BYPASS must not be set in production (skips HMAC verification on inbound Listmonk events)")
	}
	if cfg.AllowUnsignedShopifyWebhooks {
		failures = append(failures, "POSTWAVE_DEV_SHOPIFY_WEBHOOK_BYPASS must not be set in production (skips HMAC verification on inbound Shopify webhooks)")
	}
	if err := validateLegacyInboundSignatureV1Window(cfg, time.Now().UTC()); err != nil {
		failures = append(failures, err.Error())
	}
	if err := validateProductionSMSProviderWebhookConfig(); err != nil {
		failures = append(failures, err.Error())
	}
	if !validSMSProviderCallbackBase(cfg.SMSProviderCallbackBaseURL) {
		failures = append(failures, "POSTWAVE_SMS_PROVIDER_CALLBACK_BASE_URL must be a direct HTTPS API origin without path, query, fragment, or credentials")
	}
	if envTruthy("POSTWAVE_DEV_TRANSACTIONAL_SINK") {
		failures = append(failures, "POSTWAVE_DEV_TRANSACTIONAL_SINK must not be set in production (turns campaign test sends into a local no-op)")
	}
	if strings.TrimSpace(os.Getenv("POSTWAVE_DEV_OPS_OPERATOR_EMAIL")) != "" {
		failures = append(failures, "POSTWAVE_DEV_OPS_OPERATOR_EMAIL must not be set in production (short-circuits ops-console operator identity to a fixed email with TOTP treated as satisfied)")
	}
	if cfg.ShopifyClientID != "" && cfg.ShopifyStateSecret == "" {
		failures = append(failures, "SHOPIFY_STATE_SECRET is required in production when SHOPIFY_CLIENT_ID is set (OAuth state would otherwise be unsigned)")
	}
	if cfg.ShopifyClientID != "" && cfg.ShopifyWebhookSecret == "" {
		failures = append(failures, "SHOPIFY_WEBHOOK_SECRET is required in production when Shopify integration is mounted")
	}
	if len(cfg.APIKeyPepper) == 0 {
		failures = append(failures, "POSTWAVE_API_KEY_PEPPER is required in production (api_keys must be HMAC-peppered; bare SHA-256 is brute-forceable on DB leak)")
	}
	if len(cfg.APIKeyPepper) > 0 && len(cfg.APIKeyPepper) < 32 {
		failures = append(failures, "POSTWAVE_API_KEY_PEPPER must be at least 32 bytes (got fewer)")
	}
	if len(cfg.ConsentCursorSigningKey) < 32 {
		failures = append(failures, "POSTWAVE_CONSENT_CURSOR_SIGNING_KEY must be an explicit dedicated production secret of at least 32 bytes (consent cursors and subject-filter bindings must be authenticated)")
	}
	if reused := consentCursorSecretReuse(cfg); len(reused) > 0 {
		failures = append(failures, "POSTWAVE_CONSENT_CURSOR_SIGNING_KEY must be dedicated and must not reuse: "+strings.Join(reused, ", "))
	}
	if len(cfg.HelpdeskCursorKey) < 32 {
		failures = append(failures, "POSTWAVE_HELPDESK_CURSOR_KEY must be an explicit dedicated production secret of at least 32 bytes (Helpdesk cursors must be encrypted and authenticated)")
	}
	if reused := helpdeskCursorSecretReuse(cfg); len(reused) > 0 {
		failures = append(failures, "POSTWAVE_HELPDESK_CURSOR_KEY must be dedicated and must not reuse: "+strings.Join(reused, ", "))
	}
	if referrals.OperationalRuntimeAvailable &&
		len(strings.TrimSpace(os.Getenv("POSTWAVE_REFERRAL_COOKIE_SECRET"))) < 32 {
		failures = append(failures, "POSTWAVE_REFERRAL_COOKIE_SECRET must be an explicit secret of at least 32 bytes in production (unsigned referral cookies are rejected; do not reuse the internal API token)")
	}
	internalToken := strings.TrimSpace(cfg.InternalAPIToken)
	if len(internalToken) < 32 ||
		strings.EqualFold(internalToken, "REPLACE_ME") ||
		strings.Contains(strings.ToLower(internalToken), "dev-internal-token") {
		failures = append(failures, "POSTWAVE_INTERNAL_API_TOKEN must be an explicit production secret of at least 32 bytes (durable inbound automation actions authenticate with it)")
	}
	hasKMS := os.Getenv("AWS_REGION") != "" && os.Getenv("POSTWAVE_KMS_KEY_ID") != ""
	hasStaticKEK := len(cfg.SendingKEK) >= 32
	if !hasKMS && !hasStaticKEK {
		failures = append(failures, "at-rest encryption is unconfigured: set POSTWAVE_KMS_KEY_ID + AWS_REGION (preferred) or POSTWAVE_SENDING_KEK (32 bytes)")
	}
	if deploymentRegion := os.Getenv("POSTWAVE_DEPLOYMENT_REGION"); deploymentRegion == "" {
		failures = append(failures, "POSTWAVE_DEPLOYMENT_REGION is required in production (replicas must declare their region; silent us-east-1 default breaks data residency)")
	} else if err := regions.Validate(deploymentRegion); err != nil {
		failures = append(failures, fmt.Sprintf("POSTWAVE_DEPLOYMENT_REGION=%q is invalid: %v", deploymentRegion, err))
	}
	if len(failures) != 0 {
		return fmt.Errorf("production startup gate failed:\n  - %s", strings.Join(failures, "\n  - "))
	}
	return nil
}

func validSMSProviderCallbackBase(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil &&
		(parsed.Path == "" || parsed.Path == "/") && parsed.RawQuery == "" && parsed.Fragment == ""
}

func consentCursorSecretReuse(cfg config.Config) []string {
	key := cfg.ConsentCursorSigningKey
	if len(key) < 32 {
		return nil
	}
	candidates := []struct {
		name  string
		value []byte
	}{
		{name: "POSTWAVE_API_KEY_PEPPER", value: cfg.APIKeyPepper},
		{name: "POSTWAVE_PII_FINGERPRINT_PEPPER", value: cfg.PIIFingerprintPepper},
		{name: "POSTWAVE_AUTH_HMAC_PEPPER", value: []byte(os.Getenv("POSTWAVE_AUTH_HMAC_PEPPER"))},
		{name: "POSTWAVE_INTERNAL_API_TOKEN", value: []byte(cfg.InternalAPIToken)},
		{name: "POSTWAVE_SENDING_KEK", value: cfg.SendingKEK},
	}
	var reused []string
	for _, candidate := range candidates {
		if len(candidate.value) > 0 && bytes.Equal(key, candidate.value) {
			reused = append(reused, candidate.name)
		}
	}
	return reused
}

func helpdeskCursorSecretReuse(cfg config.Config) []string {
	key := cfg.HelpdeskCursorKey
	if len(key) < 32 {
		return nil
	}
	candidates := []struct {
		name  string
		value []byte
	}{
		{name: "POSTWAVE_API_KEY_PEPPER", value: cfg.APIKeyPepper},
		{name: "POSTWAVE_CONSENT_CURSOR_SIGNING_KEY", value: cfg.ConsentCursorSigningKey},
		{name: "POSTWAVE_SMS_INBOX_CURSOR_KEY", value: cfg.SMSInboxCursorKey},
		{name: "POSTWAVE_PII_FINGERPRINT_PEPPER", value: cfg.PIIFingerprintPepper},
		{name: "POSTWAVE_AUTH_HMAC_PEPPER", value: []byte(os.Getenv("POSTWAVE_AUTH_HMAC_PEPPER"))},
		{name: "POSTWAVE_INTERNAL_API_TOKEN", value: []byte(cfg.InternalAPIToken)},
		{name: "POSTWAVE_SENDING_KEK", value: cfg.SendingKEK},
	}
	var reused []string
	for _, candidate := range candidates {
		if len(candidate.value) > 0 && bytes.Equal(key, candidate.value) {
			reused = append(reused, candidate.name)
		}
	}
	return reused
}

func validateLegacyInboundSignatureV1Window(
	cfg config.Config,
	now time.Time,
) error {
	if !cfg.AllowLegacyInboundWebhookSignatureV1 {
		return nil
	}
	deadline := cfg.LegacyInboundWebhookSignatureV1ExpiresAt
	if deadline.IsZero() {
		return fmt.Errorf(
			"POSTWAVE_LEGACY_INBOUND_SIGNATURE_V1_EXPIRES_AT must be a valid RFC3339 deadline when legacy inbound signature v1 is enabled",
		)
	}
	if !deadline.After(now) {
		return fmt.Errorf(
			"POSTWAVE_LEGACY_INBOUND_SIGNATURE_V1_EXPIRES_AT has elapsed; disable legacy v1 or complete the sender upgrade",
		)
	}
	if deadline.After(now.Add(7 * 24 * time.Hour)) {
		return fmt.Errorf(
			"POSTWAVE_LEGACY_INBOUND_SIGNATURE_V1_EXPIRES_AT must be within 7 days; legacy v1 does not authenticate the replay identity",
		)
	}
	return nil
}

func validateProductionSMSProviderWebhookConfig() error {
	if !isProductionEnv() {
		return nil
	}
	return sms.ValidateProviderWebhookSecurityConfig(os.Getenv)
}

// mountRegionRoutes exposes public SDK discovery and keeps the operator-only
// cutover endpoint outside tenant-region routing because it may target a
// remote tenant. The cutover handler authenticates the internal bearer and
// writes metadata/audit state atomically under a transaction-local scope.
func mountRegionRoutes(r chi.Router, pool *pgxpool.Pool, internalAPIToken string) {
	regions.MountPublicRoutes(r)
	(&regions.MigrationDeps{
		Pool:             pool,
		InternalAPIToken: internalAPIToken,
	}).MountInternalMigrationRoute(r)
}
