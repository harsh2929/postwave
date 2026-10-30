// Package config loads runtime configuration for the API gateway from
// environment variables. All fields have sensible local-development defaults
// so `go run ./...` works out of the box.
package config

import (
	"encoding/base64"
	"encoding/hex"
	"os"
	"strings"
	"time"
)

// Config holds environment-derived runtime settings for the API gateway.
type Config struct {
	Port                     string
	LogLevel                 string
	ListmonkURL              string
	DatabaseURL              string
	MigrationServiceURL      string
	DeliverabilityServiceURL string
	VoiceServiceURL          string
	AutomationServiceURL     string
	InternalAPIToken         string
	// InboxRealityLifecycleEnabled activates exact-artifact dispatch through
	// controlled seed mailboxes. SigningSecrets is a CSV rotation set; the
	// first value signs outbound calls and all values verify inbound callbacks.
	InboxRealityLifecycleEnabled bool
	InboxRealitySigningSecrets   string
	// EngagementHoneypotSigningSecret signs the decoy URLs that produce the
	// only non-seed machine ground truth this platform can collect. It is
	// separate from every other secret on purpose: the decoy endpoint is
	// unauthenticated and world-reachable, so a leak there must not also forge
	// seed callbacks or action tickets.
	//
	// Empty disables honeypot issuance entirely. That is the correct default —
	// a deployment that has not decided to embed decoys in customer mail should
	// not start doing so because a binary was upgraded.
	EngagementHoneypotSigningSecret string
	// EngagementHoneypotBaseURL is the public origin decoys point at, including
	// any path prefix the ingress adds. Must be https.
	EngagementHoneypotBaseURL string
	// PostmarkAccountToken is the X-Postmark-Account-Token used for the
	// account-level provisioning API.
	PostmarkAccountToken string
	// PostmarkBaseURL allows overriding the API base in tests/staging.
	PostmarkBaseURL string
	// SendingKEK is the legacy 32-byte AES key used to encrypt per-tenant
	// Postmark server tokens at rest before AWS KMS was wired in. New
	// writes prefer KMS envelope encryption (see crypto.NewKMSEnvelope
	// in apps/api/main.go); SendingKEK is kept solely as the fallback
	// EnvelopeKey and to decrypt v=0x01 rows during the lazy migration.
	// May be empty when AWS_REGION + POSTWAVE_KMS_KEY_ID are set.
	SendingKEK []byte
	// DKIMRootDomain is suffixed to per-tenant slugs to form DKIM signing
	// subdomains (e.g. "<slug>.mail.postwave.io").
	DKIMRootDomain string
	// DedicatedIPRegion is where Pro-tier dedicated IPs are rented from.
	DedicatedIPRegion string

	// Listmonk admin credentials for the gateway-side HTTP client.
	ListmonkUser     string
	ListmonkPassword string

	// Forms config.
	FormsPublicHost string // e.g. https://forms.moosewave.com
	// FormsConfirmationFrom is the standard sender of form double opt-in
	// emails (FORMS_CONFIRMATION_FROM) for a form without a verified sender
	// of its own. Keep it apart from the account-mail sender. Empty: only a
	// verified workspace sender sends confirmations.
	FormsConfirmationFrom string
	RecaptchaSecret       string // optional; empty disables captcha verification
	RecaptchaSiteKey      string // public reCAPTCHA v2 checkbox site key; required with secret

	// Affiliate program config.
	AffiliateCookieDomain string // e.g. ".moosewave.com"; empty for host-only (local dev)
	AffiliateCookieSecure bool   // false in local dev
	MarketingHomeURL      string // /track default redirect
	AffiliateNotifyEmail  string // admin notify on new signup; empty disables

	// Shopify commerce integration. Empty client credentials intentionally
	// enable local-dev OAuth URLs that round-trip without talking to Shopify.
	ShopifyClientID              string
	ShopifyClientSecret          string
	ShopifyScopes                []string
	ShopifyOAuthRedirectURL      string
	ShopifyStateSecret           string
	ShopifyWebhookSecret         string
	AllowUnsignedShopifyWebhooks bool

	// Meta + Google Ads provider credentials for Mailchimp-parity social
	// publishing and remarketing surfaces. Leave empty to keep those channels
	// visible but fail-closed until an operator connects real provider creds.
	MetaGraphBaseURL               string
	MetaGraphVersion               string
	MetaPageID                     string
	MetaPageAccessToken            string
	MetaInstagramBusinessAccountID string
	MetaAdAccountID                string
	MetaAdsAccessToken             string
	GoogleAdsAPIBaseURL            string
	GoogleAdsAPIVersion            string
	GoogleAdsDeveloperToken        string
	GoogleAdsClientID              string
	GoogleAdsClientSecret          string
	GoogleAdsRefreshToken          string
	GoogleAdsLoginCustomerID       string
	GoogleAdsCustomerID            string
	GoogleOAuthTokenURL            string

	// Runtime security knobs. All dev bypasses default closed.
	AllowDevTenantSlugHeader bool
	AllowDevAdminRoleHeader  bool
	// SessionCookieInsecure drops the Secure attribute from the session
	// cookie. It exists because "am I served over plaintext http?" and "do I
	// accept a client-supplied dev tenant-slug header?" are different
	// questions that used to share one switch, and the only way to get a
	// working local login was to also open the tenant-slug bypass.
	//
	// This matters ONLY off loopback. http://localhost and http://127.0.0.1
	// are "potentially trustworthy" origins, so clients return a Secure
	// cookie over plaintext there and local web dev never noticed. A phone or
	// simulator pointed at a LAN IP (EXPO_PUBLIC_API_URL=http://172.20.10.2:8080)
	// gets no such exemption: the client discards the cookie, the next request
	// carries no session, and the app reports a 401 that never mentions
	// cookies. Defaults closed — unset means Secure stays on.
	SessionCookieInsecure         bool
	TrustForwardedIPHeaders       bool
	TrustedProxyCIDRs             []string
	DirectClientConnections       bool
	ListmonkWebhookSecret         string
	AllowDevListmonkWebhookBypass bool
	// AllowLegacyInboundWebhookSignatureV1 temporarily admits pre-v2 senders
	// whose HMAC does not bind the stable event identity. Defaults closed.
	AllowLegacyInboundWebhookSignatureV1     bool
	LegacyInboundWebhookSignatureV1ExpiresAt time.Time
	CORSAllowedOrigins                       []string

	// MinClientVersions maps a first-party client (X-Postwave-Client:
	// web|desktop|mobile) to the minimum acceptable X-Postwave-Version. A stale
	// build below its floor gets a 426 upgrade-required (see
	// middleware.ClientVersion). Empty (the default) disables all enforcement;
	// set POSTWAVE_MIN_CLIENT_VERSIONS="web:1.2.0,mobile:1.1.0" to opt in.
	//
	// OPERATIONAL CONTRACT: the gate is a GLOBAL middleware, so a floor set
	// ABOVE the currently-deployed build for a surface would 426 it on every
	// route (incl. login) — a self-inflicted lockout. Only ever set a floor
	// <= the oldest still-supported deployed build of that client.
	MinClientVersions map[string]string

	// FeatureReplyLoop (G3 follow-up) gates auto-classification of
	// inbound campaign replies on ingest. Defaults ON; set
	// POSTWAVE_DISABLE_REPLY_LOOP to turn it into the operator-triggered
	// classify-only behaviour (kill switch).
	FeatureReplyLoop bool

	// CampaignLiveDispatchEnabled is the process-wide operational interlock
	// for campaign queueing, schedule activation, resends, recurrence, resume,
	// and scheduler dispatch. It defaults false. Operators must explicitly set
	// POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH=true after validating the delivery
	// pipeline before any non-sandbox campaign can enter a live send lifecycle.
	CampaignLiveDispatchEnabled bool
	// CampaignAssuranceSendGateEnabled activates the exact-revision
	// deterministic Campaign Assurance queue gate. It defaults false for the
	// documented shadow/warning rollout and remains as the compatibility alias
	// for rollout_mode=block. New deployments should use
	// POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT so queue, pre-send, and provider
	// reauthorization share one explicit staged policy.
	CampaignAssuranceSendGateEnabled bool
	// CampaignAssuranceGateRolloutMode is one of off, shadow, warn, or block.
	// Empty preserves the legacy boolean behavior above. Invalid or conflicting
	// values are rejected by the API startup gate before any worker starts.
	CampaignAssuranceGateRolloutMode string
	// CampaignAssuranceRuntimeEnabled mounts the durable Predicted Agent
	// Comprehension service behind its public API and starts the leased
	// deterministic worker. It defaults false; routes remain fail-closed with a
	// stable 503 until POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME=true and
	// migration/object-store prerequisites validate at startup.
	CampaignAssuranceRuntimeEnabled bool
	// CampaignSchedulerEnabled records reserved operator intent for the legacy
	// polling scheduler. It defaults false and cannot start the worker while its
	// compile-time durable-claim-recovery qualification remains false. A future
	// qualified release will additionally require this flag AND the live-
	// dispatch flag: POSTWAVE_ENABLE_CAMPAIGN_SCHEDULER=true.
	CampaignSchedulerEnabled bool

	// APIKeyPepper is a server-side secret mixed into the api_keys hash via
	// HMAC-SHA256, so a database leak alone is insufficient to verify keys.
	// Required in production. Empty in dev falls back to plain SHA-256 for
	// backward compatibility with existing rows; rotating the pepper
	// requires re-issuing every key.
	APIKeyPepper []byte
	// ConsentCursorSigningKey authenticates privacy-sensitive pagination and
	// keyed subject-filter bindings, including domain-separated consent and
	// push-authority cursors. It is a dedicated trust domain: do not
	// reuse API-key, session, encryption, or PII-fingerprint secrets.
	ConsentCursorSigningKey []byte
	// SMSInboxCursorKey encrypts and authenticates tenant/query-bound inbox
	// pagination cursors. Previous permits one rolling-rotation overlap window.
	SMSInboxCursorKey         []byte
	SMSInboxCursorPreviousKey []byte
	// HelpdeskCursorKey encrypts and authenticates short-lived tenant/query-
	// bound service-suite page cursors. It is a separate trust domain.
	HelpdeskCursorKey []byte
	// SMSProviderCallbackBaseURL is the direct public API origin providers use
	// for inbound and delivery callbacks. It must not be the browser/dashboard
	// proxy origin, which strips provider Authorization headers.
	SMSProviderCallbackBaseURL string

	// PIIFingerprintPepper is a dedicated master key for tenant-separated,
	// domain-separated HMAC fingerprints of shadow-PII matches. It must contain
	// at least 32 bytes and must not reuse auth/API-key secrets. Production keeps
	// the scanner unavailable when it is absent or invalid.
	PIIFingerprintPepper     []byte
	PIIFingerprintKeyVersion string
}

// Load reads configuration from the process environment, applying defaults
// suitable for local development.
func Load() Config {
	return Config{
		Port:                            env("PORT", "8080"),
		LogLevel:                        env("LOG_LEVEL", "info"),
		ListmonkURL:                     env("LISTMONK_URL", "http://localhost:9000"),
		DatabaseURL:                     env("DATABASE_URL", "postgres://postwave_app:postwave_app_dev@localhost:5432/postwave?sslmode=disable"),
		MigrationServiceURL:             sidecarURL("MIGRATION_SERVICE_URL", "http://localhost:8081"),
		DeliverabilityServiceURL:        sidecarURL("DELIVERABILITY_SERVICE_URL", "http://localhost:8082"),
		VoiceServiceURL:                 sidecarURL("VOICE_SERVICE_URL", "http://localhost:8083"),
		AutomationServiceURL:            sidecarURL("AUTOMATION_SERVICE_URL", "http://localhost:8084"),
		InternalAPIToken:                env("POSTWAVE_INTERNAL_API_TOKEN", ""),
		InboxRealityLifecycleEnabled:    envBool("POSTWAVE_ENABLE_INBOX_REALITY_LIFECYCLE"),
		InboxRealitySigningSecrets:      env("POSTWAVE_INBOX_REALITY_SIGNING_SECRETS", ""),
		EngagementHoneypotSigningSecret: env("POSTWAVE_ENGAGEMENT_HONEYPOT_SIGNING_SECRET", ""),
		EngagementHoneypotBaseURL:       env("POSTWAVE_ENGAGEMENT_HONEYPOT_BASE_URL", ""),
		PostmarkAccountToken:            env("POSTMARK_ACCOUNT_TOKEN", ""),
		PostmarkBaseURL:                 env("POSTMARK_BASE_URL", "https://api.postmarkapp.com"),
		SendingKEK:                      decodeKEK(env("POSTWAVE_SENDING_KEK", "")),
		DKIMRootDomain:                  env("DKIM_ROOT_DOMAIN", "mail.postwave.io"),
		DedicatedIPRegion:               env("DEDICATED_IP_REGION", "us-east-1"),
		ListmonkUser:                    env("LISTMONK_USER", ""),
		ListmonkPassword:                env("LISTMONK_PASSWORD", ""),
		FormsPublicHost:                 env("FORMS_PUBLIC_HOST", "http://localhost:3000"),
		FormsConfirmationFrom:           strings.TrimSpace(os.Getenv("FORMS_CONFIRMATION_FROM")),
		RecaptchaSecret:                 env("RECAPTCHA_SECRET", ""),
		RecaptchaSiteKey:                env("RECAPTCHA_SITE_KEY", ""),
		AffiliateCookieDomain:           env("AFFILIATE_COOKIE_DOMAIN", ""),
		AffiliateCookieSecure:           env("AFFILIATE_COOKIE_SECURE", "") == "1",
		MarketingHomeURL:                env("MARKETING_HOME_URL", "https://moosewave.com"),
		AffiliateNotifyEmail:            env("AFFILIATE_NOTIFY_EMAIL", ""),
		ShopifyClientID:                 env("SHOPIFY_CLIENT_ID", ""),
		ShopifyClientSecret:             env("SHOPIFY_CLIENT_SECRET", ""),
		ShopifyScopes:                   envCSV("SHOPIFY_SCOPES", []string{"read_customers", "read_products", "read_orders"}),
		ShopifyOAuthRedirectURL:         env("SHOPIFY_OAUTH_REDIRECT_URL", ""),
		ShopifyStateSecret:              env("SHOPIFY_STATE_SECRET", ""),
		ShopifyWebhookSecret:            env("SHOPIFY_WEBHOOK_SECRET", ""),
		AllowUnsignedShopifyWebhooks:    envBool("POSTWAVE_DEV_SHOPIFY_WEBHOOK_BYPASS"),
		MetaGraphBaseURL:                env("META_GRAPH_BASE_URL", "https://graph.facebook.com"),
		MetaGraphVersion:                env("META_GRAPH_VERSION", "v24.0"),
		MetaPageID:                      env("META_PAGE_ID", ""),
		MetaPageAccessToken:             env("META_PAGE_ACCESS_TOKEN", ""),
		MetaInstagramBusinessAccountID:  env("META_INSTAGRAM_BUSINESS_ACCOUNT_ID", ""),
		MetaAdAccountID:                 env("META_AD_ACCOUNT_ID", ""),
		MetaAdsAccessToken:              env("META_ADS_ACCESS_TOKEN", ""),
		GoogleAdsAPIBaseURL:             env("GOOGLE_ADS_API_BASE_URL", "https://googleads.googleapis.com"),
		GoogleAdsAPIVersion:             env("GOOGLE_ADS_API_VERSION", "v24"),
		GoogleAdsDeveloperToken:         env("GOOGLE_ADS_DEVELOPER_TOKEN", ""),
		GoogleAdsClientID:               env("GOOGLE_ADS_CLIENT_ID", ""),
		GoogleAdsClientSecret:           env("GOOGLE_ADS_CLIENT_SECRET", ""),
		GoogleAdsRefreshToken:           env("GOOGLE_ADS_REFRESH_TOKEN", ""),
		GoogleAdsLoginCustomerID:        env("GOOGLE_ADS_LOGIN_CUSTOMER_ID", ""),
		GoogleAdsCustomerID:             env("GOOGLE_ADS_CUSTOMER_ID", ""),
		GoogleOAuthTokenURL:             env("GOOGLE_OAUTH_TOKEN_URL", "https://www.googleapis.com/oauth2/v3/token"),
		AllowDevTenantSlugHeader:        envBool("POSTWAVE_DEV_TENANT_SLUG_HEADER"),
		SessionCookieInsecure:           envBool("POSTWAVE_SESSION_COOKIE_INSECURE"),
		AllowDevAdminRoleHeader:         envBool("POSTWAVE_DEV_ADMIN_ROLE_HEADER"),
		TrustForwardedIPHeaders:         envBool("POSTWAVE_TRUST_FORWARDED_IP_HEADERS"),
		TrustedProxyCIDRs:               envCSV("POSTWAVE_TRUSTED_PROXY_CIDRS", nil),
		DirectClientConnections:         envBool("POSTWAVE_DIRECT_CLIENT_CONNECTIONS"),
		ListmonkWebhookSecret:           env("LISTMONK_WEBHOOK_SECRET", ""),
		AllowDevListmonkWebhookBypass:   envBool("POSTWAVE_DEV_LISTMONK_WEBHOOK_BYPASS"),
		AllowLegacyInboundWebhookSignatureV1: envBool(
			"POSTWAVE_ALLOW_LEGACY_INBOUND_SIGNATURE_V1",
		),
		LegacyInboundWebhookSignatureV1ExpiresAt: envTime(
			"POSTWAVE_LEGACY_INBOUND_SIGNATURE_V1_EXPIRES_AT",
		),
		FeatureReplyLoop:            !envBool("POSTWAVE_DISABLE_REPLY_LOOP"),
		CampaignLiveDispatchEnabled: envBool("POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH"),
		CampaignAssuranceSendGateEnabled: envBool(
			"POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_SEND_GATE",
		),
		CampaignAssuranceGateRolloutMode: env(
			"POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT", "",
		),
		CampaignAssuranceRuntimeEnabled: envBool(
			"POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME",
		),
		CampaignSchedulerEnabled: envBool("POSTWAVE_ENABLE_CAMPAIGN_SCHEDULER"),
		// Defaults cover the three local dev surfaces: Next.js web
		// (:3000), one-off vite previews / Storybook (:5173), and the
		// Tauri desktop dev shell (:1420). Without :1420 here, the
		// desktop's state-changing PUT/POST/PATCH/DELETE requests hit
		// the AllowedOriginsCSRF gate and 403 with "forbidden_origin"
		// — surfacing as e.g. "Layout save failed" on the dashboard.
		// Production deploys override this via CORS_ALLOWED_ORIGINS.
		//
		// Both spellings of loopback, because they are DIFFERENT ORIGINS to a
		// browser. A developer who opens http://127.0.0.1:3000 reaches exactly
		// the same dev server as http://localhost:3000, but every
		// state-changing request 403s with "forbidden_origin" — and the app
		// looks broken rather than misaddressed. Measured on 2026-08-21: a
		// PUT /api/v1/onboarding/steps from 127.0.0.1 was refused while the
		// identical request from localhost succeeded.
		CORSAllowedOrigins: envCSV("CORS_ALLOWED_ORIGINS", []string{
			"http://localhost:3000",
			"http://127.0.0.1:3000",
			"http://localhost:5173",
			"http://127.0.0.1:5173",
			"http://localhost:1420",
			"http://127.0.0.1:1420",
		}),
		APIKeyPepper:               []byte(env("POSTWAVE_API_KEY_PEPPER", "")),
		ConsentCursorSigningKey:    []byte(env("POSTWAVE_CONSENT_CURSOR_SIGNING_KEY", "")),
		SMSInboxCursorKey:          []byte(env("POSTWAVE_SMS_INBOX_CURSOR_KEY", "")),
		SMSInboxCursorPreviousKey:  []byte(env("POSTWAVE_SMS_INBOX_CURSOR_PREVIOUS_KEY", "")),
		HelpdeskCursorKey:          []byte(env("POSTWAVE_HELPDESK_CURSOR_KEY", "")),
		SMSProviderCallbackBaseURL: env("POSTWAVE_SMS_PROVIDER_CALLBACK_BASE_URL", ""),
		PIIFingerprintPepper:       []byte(env("POSTWAVE_PII_FINGERPRINT_PEPPER", "")),
		PIIFingerprintKeyVersion:   env("POSTWAVE_PII_FINGERPRINT_KEY_VERSION", "v1"),
		MinClientVersions:          envClientVersions("POSTWAVE_MIN_CLIENT_VERSIONS"),
	}
}

// envClientVersions parses a "client:version,client:version" env var into a
// map (e.g. "web:1.2.0,mobile:1.1.0"). Malformed entries are skipped so a typo
// disables that floor rather than crashing boot. Returns nil when unset/empty.
func envClientVersions(key string) map[string]string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}
	out := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		client, version, ok := strings.Cut(strings.TrimSpace(pair), ":")
		client = strings.ToLower(strings.TrimSpace(client))
		version = strings.TrimSpace(version)
		if !ok || client == "" || version == "" {
			continue
		}
		out[client] = version
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// decodeKEK normalizes the POSTWAVE_SENDING_KEK env var into raw
// bytes regardless of which common encoding the operator pasted in:
//   - 16/24/32 raw bytes → returned as-is (assumes printable ASCII
//     key, fine for legacy values that worked before this helper)
//   - 64-char hex → decoded to 32 bytes
//   - 44-char base64 (`openssl rand -base64 32`) → decoded to 32 bytes
//
// AES-GCM requires 16/24/32 bytes; any other length is left as-is and
// the envelope-cipher init will reject it loudly (preserves the boot
// gate). Empty string → empty slice (no envelope cipher; legacy
// fallback).
func decodeKEK(raw string) []byte {
	if raw == "" {
		return nil
	}
	switch len(raw) {
	case 16, 24, 32:
		return []byte(raw)
	case 64:
		if dec, err := hex.DecodeString(raw); err == nil && len(dec) == 32 {
			return dec
		}
	case 44, 43, 64 + 4: // base64 std (with/without padding) for 32 bytes
		if dec, err := base64.StdEncoding.DecodeString(raw); err == nil {
			if len(dec) == 16 || len(dec) == 24 || len(dec) == 32 {
				return dec
			}
		}
		if dec, err := base64.RawStdEncoding.DecodeString(raw); err == nil {
			if len(dec) == 16 || len(dec) == 24 || len(dec) == 32 {
				return dec
			}
		}
	}
	// Unknown encoding — pass through; the cipher constructor will
	// reject and produce a clear error in logs.
	return []byte(raw)
}

// ServiceNotDeployed is the value a *_SERVICE_URL variable (migration,
// deliverability, voice, automation) takes on an environment that does not run
// that sidecar. It loads as an empty URL, and each consumer wired to it reads
// that as "not here": proxied routes and /api/v1/predict answer 503
// service_not_deployed, AI chat says it is not available, the lifecycle and
// billing automation forwarders acknowledge events without sending them, and
// the status page leaves the service out. A consumer added later must make
// the same choice explicitly: an empty URL alone is also what a forgotten
// wiring looks like. An unset variable still defaults to the local
// development port.
const ServiceNotDeployed = "disabled"

// sidecarURL reads a sidecar's base URL. Without it an environment that does
// not deploy a sidecar could not say so: an unset or empty variable falls back
// to localhost, and pointing it at a name that does not resolve turns every
// request into a DNS failure answered as a 502 "did not respond".
func sidecarURL(key, fallback string) string {
	value := env(key, fallback)
	if strings.EqualFold(strings.TrimSpace(value), ServiceNotDeployed) {
		return ""
	}
	return value
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func envTime(key string) time.Time {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return parsed.UTC()
}

func envCSV(key string, fallback []string) []string {
	raw, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(raw) == "" {
		return append([]string(nil), fallback...)
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
