package readiness

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/config"
)

type Check struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Status      string `json:"status"`
	Severity    string `json:"severity"`
	Remediation string `json:"remediation,omitempty"`
}

type Group struct {
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	Checks []Check `json:"checks"`
}

type Report struct {
	Status      string  `json:"status"`
	Environment string  `json:"environment"`
	Groups      []Group `json:"groups"`
}

type Deps struct {
	Config config.Config
	Env    func(string) string
	DB     Pinger
	// ProbeTimeout is test-only/custom deployment tuning. Values above the
	// hard ceiling are ignored so readiness can never tie up an edge request.
	ProbeTimeout time.Duration
}

type Pinger interface {
	Ping(context.Context) error
}

const (
	defaultProbeTimeout = 2 * time.Second
	maxProbeTimeout     = 3 * time.Second
)

type publicStatus struct {
	Status string `json:"status"`
}

// Ready is the unauthenticated load-balancer readiness probe. Unlike the
// liveness handler, it verifies the database and the production configuration
// contract. Its response intentionally contains no check IDs, configuration,
// dependency names, or errors; operators use the authenticated Production
// report for that detail.
func (d *Deps) Ready(w http.ResponseWriter, r *http.Request) {
	ready := d != nil && d.DB != nil
	if ready {
		timeout := d.ProbeTimeout
		if timeout <= 0 || timeout > maxProbeTimeout {
			timeout = defaultProbeTimeout
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		ready = d.DB.Ping(ctx) == nil
	}

	if d == nil {
		ready = false
	} else if report := EvaluateRuntime(d.Config, d.env); report.Status == "blocked" {
		ready = false
	}

	w.Header().Set("Cache-Control", "no-store")
	if !ready {
		writeJSON(w, http.StatusServiceUnavailable, publicStatus{Status: "unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, publicStatus{Status: "ready"})
}

// Production serves the wiring report. It is mounted at
// /api/internal/ops/readiness behind RequirePlatformOperator — it used to
// live at /api/v1/readiness/production behind tenant ScopeAdmin, which let
// any customer's admin key read the platform's production wiring report.
func (d *Deps) Production(w http.ResponseWriter, r *http.Request) {
	report := Evaluate(d.Config, d.env)
	status := http.StatusOK
	if report.Status == "blocked" {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, report)
}

func (d *Deps) env(key string) string {
	if d != nil && d.Env != nil {
		return d.Env(key)
	}
	return os.Getenv(key)
}

func Evaluate(cfg config.Config, env func(string) string) Report {
	if env == nil {
		env = os.Getenv
	}
	environment := runtimeEnvironment(env)
	prod := strings.EqualFold(environment, "production") || strings.EqualFold(environment, "prod")
	billingProvider := strings.ToLower(strings.TrimSpace(env("BILLING_PROVIDER")))
	dodoEnvironment := strings.ToLower(strings.TrimSpace(env("DODO_PAYMENTS_ENVIRONMENT")))
	dodoAPIKey := strings.TrimSpace(env("DODO_PAYMENTS_API_KEY"))
	dodoWebhookSecret := strings.TrimSpace(env("DODO_PAYMENTS_WEBHOOK_KEY"))
	dodoProductLaunch := strings.TrimSpace(env("DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY"))
	dodoProductGrowth := strings.TrimSpace(env("DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY"))
	dodoProductScale := strings.TrimSpace(env("DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY"))
	billingApproval := strings.TrimSpace(env("MOOSEWAVE_BILLING_LAUNCH_APPROVAL"))
	if billingApproval == "" {
		// Compatibility for environments created before the public rename.
		billingApproval = strings.TrimSpace(env("POSTWAVE_BILLING_LAUNCH_APPROVAL"))
	}
	groups := append([]Group{}, EvaluateRuntime(cfg, env).Groups...)
	groups = append(groups, []Group{
		{
			ID:    "auth_providers",
			Label: "Authentication Providers",
			Checks: []Check{
				optional("google_oauth", "Google OAuth client configured", strings.TrimSpace(env("POSTWAVE_OAUTH_GOOGLE_CLIENT_ID")) != "" && strings.TrimSpace(env("POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET")) != "" && strings.TrimSpace(env("POSTWAVE_OAUTH_REDIRECT_BASE")) != "", "Set POSTWAVE_OAUTH_GOOGLE_CLIENT_ID, POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET, and POSTWAVE_OAUTH_REDIRECT_BASE if Google sign-in will be offered."),
			},
		},
		{
			ID:    "billing",
			Label: "Billing",
			Checks: []Check{
				required("billing_launch_approval", "Billing launch approval record configured", !prod || (strings.HasPrefix(billingApproval, "approved:") && len(strings.TrimPrefix(billingApproval, "approved:")) >= 6), "After pricing, tax, refund, capacity enforcement, and a live rehearsal are approved, set MOOSEWAVE_BILLING_LAUNCH_APPROVAL=approved:<release-record-id>."),
				required("billing_provider", "Dodo Payments selected as Moosewave billing provider", !prod || billingProvider == "dodo", "Set BILLING_PROVIDER=dodo in production."),
				required("dodo_environment", "Dodo Payments live mode selected", !prod || dodoEnvironment == "live_mode", "Set DODO_PAYMENTS_ENVIRONMENT=live_mode in production; test mode is blocked by this report."),
				required("dodo_api_key", "Dodo Payments API key configured for Checkout and Customer Portal", dodoAPIKey != "", "Set DODO_PAYMENTS_API_KEY to the live business API key."),
				required("dodo_webhook_key", "Dodo Payments webhook signing key configured", strings.HasPrefix(dodoWebhookSecret, "whsec_"), "Set DODO_PAYMENTS_WEBHOOK_KEY from the live webhook endpoint."),
				required("dodo_product_launch_monthly", "Launch monthly Dodo Payments product configured", strings.HasPrefix(dodoProductLaunch, "pdt_"), "Set DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY to the approved $39/month recurring product ID."),
				required("dodo_product_growth_monthly", "Growth monthly Dodo Payments product configured", strings.HasPrefix(dodoProductGrowth, "pdt_"), "Set DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY to the approved $99/month recurring product ID."),
				required("dodo_product_scale_monthly", "Scale monthly Dodo Payments product configured", strings.HasPrefix(dodoProductScale, "pdt_"), "Set DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY to the approved $349/month recurring product ID."),
				required("dodo_product_ids_distinct", "Dodo Payments product IDs are distinct", allDistinctNonEmpty(dodoProductLaunch, dodoProductGrowth, dodoProductScale), "Use three distinct approved monthly product IDs; duplicate IDs make fulfilment ambiguous."),
			},
		},
		{
			ID:    "migration",
			Label: "Migration And Imports",
			Checks: []Check{
				required("migration_service_url", "Migration service URL configured", strings.TrimSpace(cfg.MigrationServiceURL) != "", "Set MIGRATION_SERVICE_URL to the internal migration service origin."),
				conditional("migration_service_url_not_localhost", "Migration service is not localhost in production", !prod || !isLocalhostURL(cfg.MigrationServiceURL), "required", "Point MIGRATION_SERVICE_URL at the deployed migration sidecar, not the local development default."),
				conditional("migration_service_url_private_or_https", "Migration service URL is private or HTTPS", !prod || isPrivateOrHTTPSURL(cfg.MigrationServiceURL), "required", "Use HTTPS or a private service DNS name for MIGRATION_SERVICE_URL in production."),
			},
		},
		{
			ID:    "commerce",
			Label: "Commerce",
			Checks: []Check{
				required("shopify_client_id", "Shopify client ID configured", cfg.ShopifyClientID != "", "Create a Shopify app and set SHOPIFY_CLIENT_ID."),
				required("shopify_client_secret", "Shopify client secret configured", cfg.ShopifyClientSecret != "", "Set SHOPIFY_CLIENT_SECRET from the Shopify app."),
				required("shopify_state_secret", "Shopify OAuth state secret configured", cfg.ShopifyStateSecret != "", "Set SHOPIFY_STATE_SECRET to a random HMAC secret."),
				required("shopify_webhook_secret", "Shopify webhook secret configured", cfg.ShopifyWebhookSecret != "", "Set SHOPIFY_WEBHOOK_SECRET and subscribe to customer/product/order/app webhooks."),
				required("shopify_redirect_url", "Shopify redirect URL configured", cfg.ShopifyOAuthRedirectURL != "", "Set SHOPIFY_OAUTH_REDIRECT_URL to the public OAuth callback."),
			},
		},
		{
			ID:    "sending",
			Label: "Sending And Deliverability",
			Checks: []Check{
				conditional("sender_provider", "Sender provider configured", cfg.PostmarkAccountToken != "" || env("AWS_SES_REGION") != "", "required", "Set POSTMARK_ACCOUNT_TOKEN or AWS_SES_REGION plus SES sender credentials."),
				required("dkim_root", "DKIM root domain configured", cfg.DKIMRootDomain != "", "Set DKIM_ROOT_DOMAIN to the sending subdomain root."),
				conditional("forms_public_https", "Forms public host is HTTPS", !prod || strings.HasPrefix(cfg.FormsPublicHost, "https://"), "required", "Set FORMS_PUBLIC_HOST to an HTTPS origin in production."),
				required("deliverability_service_url", "Deliverability service URL configured", strings.TrimSpace(cfg.DeliverabilityServiceURL) != "", "Set DELIVERABILITY_SERVICE_URL to the internal deliverability sidecar origin."),
				conditional("deliverability_service_url_not_localhost", "Deliverability service is not localhost in production", !prod || !isLocalhostURL(cfg.DeliverabilityServiceURL), "required", "Point DELIVERABILITY_SERVICE_URL at the deployed sidecar, not the local development default."),
				conditional("deliverability_service_url_private_or_https", "Deliverability service URL is private or HTTPS", !prod || isPrivateOrHTTPSURL(cfg.DeliverabilityServiceURL), "required", "Use HTTPS or a private service DNS name for DELIVERABILITY_SERVICE_URL in production."),
				optional("recaptcha", "reCAPTCHA configured for public forms", cfg.RecaptchaSecret != "", "Set RECAPTCHA_SECRET before opening public forms to the internet."),
			},
		},
	}...)
	status := "ok"
	for _, g := range groups {
		for _, c := range g.Checks {
			if c.Status == "fail" && c.Severity == "required" {
				status = "blocked"
			} else if c.Status == "fail" && status == "ok" {
				status = "warning"
			}
		}
	}
	return Report{Status: status, Environment: environment, Groups: groups}
}

// EvaluateRuntime is deliberately narrower than Evaluate. It contains only
// configuration required for this API task to accept production traffic.
// Provider certification, billing configuration, sidecar deployment contracts
// and other launch-wide checks remain outside this runtime gate; an
// optional provider must never make the ALB recycle an otherwise healthy API.
func EvaluateRuntime(cfg config.Config, env func(string) string) Report {
	if env == nil {
		env = os.Getenv
	}
	environment := runtimeEnvironment(env)
	prod := isProduction(environment)
	protected := hasProtectedEnvironment(env)
	hasKMS := strings.TrimSpace(env("AWS_REGION")) != "" && strings.TrimSpace(env("POSTWAVE_KMS_KEY_ID")) != ""
	hasAlertChannel := strings.TrimSpace(env("OPS_SLACK_WEBHOOK_URL")) != "" || strings.TrimSpace(env("OPS_ALERT_EMAIL")) != ""
	groups := []Group{
		{
			ID:    "runtime",
			Label: "Runtime",
			Checks: []Check{
				conditional("database_url", "Database URL configured", !prod || cfg.DatabaseURL != "", "required", "Set DATABASE_URL."),
				conditional("internal_api_token", "Internal service token configured", !prod || cfg.InternalAPIToken != "", "required", "Set POSTWAVE_INTERNAL_API_TOKEN."),
				conditional("public_base_url", "Public HTTPS base URL configured", !prod || strings.HasPrefix(env("PUBLIC_BASE_URL"), "https://"), "required", "Set PUBLIC_BASE_URL to the production HTTPS app origin."),
				conditional("redis_url", "Distributed rate-limit store configured", !prod || strings.TrimSpace(env("REDIS_URL")) != "", "required", "Set REDIS_URL to the private production Redis service."),
				conditional("ops_database_url", "Restricted ops database configured", !prod || strings.TrimSpace(env("OPS_DATABASE_URL")) != "", "required", "Set OPS_DATABASE_URL to the restricted postwave_ops DSN."),
			},
		},
		{
			ID:    "runtime_security",
			Label: "Runtime Security",
			Checks: []Check{
				conditional("no_privileged_db_role_override", "Privileged database role override disabled", !protected || strings.TrimSpace(env("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE")) == "", "required", "Unset POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE; protected runtimes must use the unprivileged application database role."),
				conditional("no_dev_tenant_header", "Dev tenant header bypass disabled", !prod || !cfg.AllowDevTenantSlugHeader, "required", "Unset POSTWAVE_DEV_TENANT_SLUG_HEADER."),
				conditional("no_dev_admin_header", "Dev admin role bypass disabled", !prod || !cfg.AllowDevAdminRoleHeader, "required", "Unset POSTWAVE_DEV_ADMIN_ROLE_HEADER."),
				conditional("no_unsigned_shopify", "Unsigned Shopify webhooks disabled", !prod || !cfg.AllowUnsignedShopifyWebhooks, "required", "Unset POSTWAVE_DEV_SHOPIFY_WEBHOOK_BYPASS."),
				conditional("no_unsigned_listmonk", "Unsigned Listmonk webhooks disabled", !prod || !cfg.AllowDevListmonkWebhookBypass, "required", "Unset POSTWAVE_DEV_LISTMONK_WEBHOOK_BYPASS."),
				conditional("no_unsigned_sms_provider_webhooks", "Unsigned SMS provider webhooks disabled", !protected || strings.TrimSpace(env("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS")) == "", "required", "Unset POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS; the bypass is local-development only."),
				conditional("cors_no_wildcard", "CORS origins are explicit", !prod || !hasWildcard(cfg.CORSAllowedOrigins), "required", "Set exact production CORS origins."),
				conditional("api_key_pepper", "API key pepper configured", !prod || len(cfg.APIKeyPepper) >= 32, "required", "Set POSTWAVE_API_KEY_PEPPER to at least 32 bytes."),
				conditional("consent_cursor_signing_key", "Privacy cursor signing key configured", !prod || len(cfg.ConsentCursorSigningKey) >= 32, "required", "Set POSTWAVE_CONSENT_CURSOR_SIGNING_KEY to a dedicated secret of at least 32 bytes for domain-separated consent and push-authority cursors."),
				conditional("sms_inbox_cursor_key", "SMS inbox cursor encryption key configured", !prod || len(cfg.SMSInboxCursorKey) >= 32, "required", "Set POSTWAVE_SMS_INBOX_CURSOR_KEY to a dedicated secret of at least 32 bytes."),
				conditional("helpdesk_cursor_key", "Helpdesk cursor encryption key configured", !prod || len(cfg.HelpdeskCursorKey) >= 32, "required", "Set POSTWAVE_HELPDESK_CURSOR_KEY to a dedicated secret of at least 32 bytes."),
				conditional("sms_inbox_previous_cursor_key", "SMS inbox previous cursor key valid when configured", len(cfg.SMSInboxCursorPreviousKey) == 0 || len(cfg.SMSInboxCursorPreviousKey) >= 32, "required", "Unset POSTWAVE_SMS_INBOX_CURSOR_PREVIOUS_KEY or provide at least 32 bytes during rotation."),
				conditional("sms_provider_callback_base", "SMS providers use the direct HTTPS API callback origin", !prod || strings.HasPrefix(strings.TrimSpace(cfg.SMSProviderCallbackBaseURL), "https://"), "required", "Set POSTWAVE_SMS_PROVIDER_CALLBACK_BASE_URL to the direct public API origin, not the dashboard proxy."),
				conditional("at_rest_encryption", "At-rest encryption configured", !prod || hasKMS || len(cfg.SendingKEK) >= 32, "required", "Configure AWS KMS or a 32-byte POSTWAVE_SENDING_KEK."),
				conditional("deployment_region", "Deployment region declared", !prod || strings.TrimSpace(env("POSTWAVE_DEPLOYMENT_REGION")) != "", "required", "Set POSTWAVE_DEPLOYMENT_REGION."),
				conditional("form_upload_malware_scanner", "Form-upload malware scanner configured", !prod || strings.TrimSpace(env("POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR")) != "", "required", "Deploy a private ClamAV service and set POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR; uploads remain quarantined without it."),
			},
		},
		{
			ID:    "runtime_auth_ops",
			Label: "Authentication And Operations",
			Checks: []Check{
				conditional("auth_hmac_pepper", "Auth HMAC pepper configured", !prod || len(env("POSTWAVE_AUTH_HMAC_PEPPER")) >= 32, "required", "Set POSTWAVE_AUTH_HMAC_PEPPER to at least 32 bytes."),
				conditional("auth_mailer", "Production auth mailer configured", !prod || strings.EqualFold(env("POSTWAVE_MAILER"), "ses"), "required", "Set POSTWAVE_MAILER=ses."),
				conditional("auth_from_address", "Verified auth sender configured", !prod || strings.TrimSpace(env("POSTWAVE_AUTH_FROM_ADDRESS")) != "", "required", "Set POSTWAVE_AUTH_FROM_ADDRESS."),
				conditional("listmonk_webhook_secret", "Listmonk webhook verification configured", !prod || cfg.ListmonkWebhookSecret != "", "required", "Set LISTMONK_WEBHOOK_SECRET."),
				conditional("ops_alert_channel", "Ops alert delivery configured", !prod || hasAlertChannel, "required", "Set OPS_SLACK_WEBHOOK_URL or OPS_ALERT_EMAIL."),
				conditional("portal_origin", "Audit portal origin configured", !prod || strings.HasPrefix(env("POSTWAVE_PORTAL_ORIGIN"), "https://"), "required", "Set POSTWAVE_PORTAL_ORIGIN to an exact HTTPS origin."),
				conditional("portal_secret", "Audit portal secret configured", !prod || len(env("POSTWAVE_PORTAL_JWT_SECRET")) >= 32, "required", "Set POSTWAVE_PORTAL_JWT_SECRET to at least 32 bytes."),
				conditional("portal_assets", "Audit portal assets configured", !prod || strings.TrimSpace(env("POSTWAVE_PORTAL_SPA_DIR")) != "", "required", "Set POSTWAVE_PORTAL_SPA_DIR."),
			},
		},
	}
	status := "ok"
	for _, group := range groups {
		for _, check := range group.Checks {
			if check.Status == "fail" && check.Severity == "required" {
				status = "blocked"
			}
		}
	}
	return Report{Status: status, Environment: environment, Groups: groups}
}

func required(id, label string, ok bool, remediation string) Check {
	return conditional(id, label, ok, "required", remediation)
}

func optional(id, label string, ok bool, remediation string) Check {
	return conditional(id, label, ok, "optional", remediation)
}

func conditional(id, label string, ok bool, severity, remediation string) Check {
	status := "pass"
	if !ok {
		status = "fail"
	}
	return Check{ID: id, Label: label, Status: status, Severity: severity, Remediation: remediation}
}

func hasWildcard(origins []string) bool {
	for _, origin := range origins {
		if strings.TrimSpace(origin) == "*" {
			return true
		}
	}
	return false
}

func allDistinctNonEmpty(values ...string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			return false
		}
		if _, exists := seen[value]; exists {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func isLocalhostURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isPrivateOrHTTPSURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Hostname() == "" {
		return false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme == "https" {
		return true
	}
	if scheme != "http" {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsPrivate() && !ip.IsLoopback()
	}
	return !strings.Contains(host, ".") ||
		strings.HasSuffix(host, ".internal") ||
		strings.HasSuffix(host, ".svc") ||
		strings.HasSuffix(host, ".cluster.local")
}

func first(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func runtimeEnvironment(env func(string) string) string {
	return first(
		env("POSTWAVE_ENV"),
		env("APP_ENV"),
		env("GO_ENV"),
		env("ENVIRONMENT"),
		env("NODE_ENV"),
		"development",
	)
}

func isProduction(environment string) bool {
	return strings.EqualFold(environment, "production") || strings.EqualFold(environment, "prod")
}

func isProtectedEnvironment(environment string) bool {
	return isProduction(environment) || strings.EqualFold(environment, "staging") || strings.EqualFold(environment, "stage")
}

func hasProtectedEnvironment(env func(string) string) bool {
	for _, key := range []string{"POSTWAVE_ENV", "APP_ENV", "GO_ENV", "ENVIRONMENT", "NODE_ENV"} {
		if isProtectedEnvironment(strings.TrimSpace(env(key))) {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
