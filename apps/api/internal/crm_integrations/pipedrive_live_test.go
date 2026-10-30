// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	pipedriveLiveCertificationEnv  = "PIPEDRIVE_LIVE_CERTIFICATION"
	pipedriveLiveValidateReportEnv = "PIPEDRIVE_LIVE_CERTIFICATION_VALIDATE_REPORT"
	pipedriveLiveTenantID          = "pipedrive-live-certification"
	pipedriveLiveCredentialRef     = "pipedrive-live-env"
	pipedriveLiveUserAgent         = "Moosewave Pipedrive Live Certification"
)

var pipedriveLiveEvidenceMu sync.Mutex

type pipedriveLiveCredentialResolver struct {
	creds PipedriveCredentials
}

type pipedriveLiveEvidence struct {
	Provider   string         `json:"provider"`
	Check      string         `json:"check"`
	Status     string         `json:"status"`
	RecordedAt string         `json:"recorded_at"`
	Details    map[string]any `json:"details,omitempty"`
}

func (r pipedriveLiveCredentialResolver) ResolvePipedrive(context.Context, string, Integration) (PipedriveCredentials, error) {
	return r.creds, nil
}

func TestPipedriveLiveCertificationReportWritesSanitizedJSONL(t *testing.T) {
	reportPath := filepath.Join(t.TempDir(), "pipedrive-live-certification.jsonl")
	t.Setenv("PIPEDRIVE_LIVE_CERTIFICATION_REPORT", reportPath)

	pipedriveLiveRecordEvidence(t, "unit_report_check", map[string]any{
		"user_id_present":    true,
		"company_id_present": true,
		"access_token":       "raw-token",
		"client_secret":      "raw-secret",
	})

	raw, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	for _, want := range []string{
		`"provider":"pipedrive"`,
		`"check":"unit_report_check"`,
		`"status":"passed"`,
		`"user_id_present":true`,
		`"company_id_present":true`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("report missing %q in %s", want, body)
		}
	}
	if strings.Contains(body, "raw-token") || strings.Contains(body, "raw-secret") || strings.Contains(body, "client_secret") || strings.Contains(body, "access_token") {
		t.Fatalf("report should not include raw secret material: %s", body)
	}
}

func TestPipedriveLiveCertificationReportCompleteness(t *testing.T) {
	if !pipedriveLiveBool(pipedriveLiveValidateReportEnv) {
		t.Skip(pipedriveLiveValidateReportEnv + "=1 not set; skipping Pipedrive live certification report completeness check")
	}
	reportPath := pipedriveLiveEnv("PIPEDRIVE_LIVE_CERTIFICATION_REPORT")
	if reportPath == "" {
		t.Fatal("PIPEDRIVE_LIVE_CERTIFICATION_REPORT is required when validating Pipedrive live certification evidence")
	}
	entries, err := pipedriveLiveReadEvidenceReport(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := pipedriveLiveValidateEvidenceCompleteness(entries); err != nil {
		t.Fatal(err)
	}
}

func TestPipedriveLiveCertificationReportCompletenessValidator(t *testing.T) {
	entries := make([]pipedriveLiveEvidence, 0, len(pipedriveLiveRequiredEvidenceChecks()))
	for _, check := range pipedriveLiveRequiredEvidenceChecks() {
		entries = append(entries, pipedriveLiveEvidence{
			Provider:   ProviderPipedrive,
			Check:      check,
			Status:     "passed",
			RecordedAt: "2026-06-19T00:00:00Z",
		})
	}
	if err := pipedriveLiveValidateEvidenceCompleteness(entries); err != nil {
		t.Fatalf("complete evidence should validate: %v", err)
	}
	entries = entries[:len(entries)-1]
	if err := pipedriveLiveValidateEvidenceCompleteness(entries); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("incomplete evidence should fail with missing check, got %v", err)
	}
}

func TestPipedriveLiveCertificationBackfillReadPaths(t *testing.T) {
	pipedriveRequireLiveCertification(t)
	creds, integration := pipedriveLiveReadConfig(t)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	backfiller := PipedriveRESTBackfiller{
		HTTPClient: &http.Client{Timeout: 20 * time.Second},
		Credentials: pipedriveLiveCredentialResolver{
			creds: creds,
		},
		UserAgent: pipedriveLiveUserAgent,
		Limit:     1,
	}
	for _, object := range pipedriveLiveObjects() {
		t.Run(object, func(t *testing.T) {
			req, err := backfiller.BackfillPage(ctx, pipedriveLiveTenantID, integration, encodePipedriveCursor(pipedriveCursorState{Object: object}))
			if err != nil {
				t.Fatalf("live Pipedrive %s page failed: %v", object, err)
			}
			if req.RunMode != "backfill" {
				t.Fatalf("live Pipedrive %s returned run_mode=%q", object, req.RunMode)
			}
			pipedriveLiveRecordEvidence(t, pipedriveLiveBackfillEvidenceCheck(object, creds), map[string]any{
				"object":                  object,
				"contacts":                len(req.Contacts),
				"events":                  len(req.Events),
				"cursor_present":          strings.TrimSpace(req.Cursor) != "",
				"api_token_auth":          creds.APIToken != "",
				"oauth_access_token_auth": creds.AccessToken != "",
				"company_domain_present":  companyDomainPresent(integration),
				"api_base_url_present":    settingString(integration.Settings, "api_base_url") != "",
			})
			t.Logf("live Pipedrive %s page ok: contacts=%d events=%d cursor_present=%t", object, len(req.Contacts), len(req.Events), strings.TrimSpace(req.Cursor) != "")
		})
	}
}

func TestPipedriveLiveCertificationOAuthIdentityAndRefresh(t *testing.T) {
	pipedriveRequireLiveCertification(t)
	if !pipedriveLiveBool("PIPEDRIVE_LIVE_OAUTH") {
		t.Skip("PIPEDRIVE_LIVE_OAUTH=1 not set; skipping OAuth identity/refresh live certification")
	}
	creds := pipedriveLiveCredentials()
	if creds.ClientID == "" || creds.ClientSecret == "" {
		t.Skip("PIPEDRIVE_CLIENT_ID and PIPEDRIVE_CLIENT_SECRET are required for OAuth live certification")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	client := PipedriveOAuthClient{
		HTTPClient:   &http.Client{Timeout: 20 * time.Second},
		OAuthBaseURL: creds.OAuthBaseURL,
		UserAgent:    pipedriveLiveUserAgent,
	}
	ran := false
	if creds.AccessToken != "" && creds.APIBaseURL != "" {
		user, err := client.CurrentUser(ctx, creds)
		if err != nil {
			t.Fatalf("live Pipedrive /users/me failed: %v", err)
		}
		ran = true
		pipedriveLiveRecordEvidence(t, "oauth_users_me", map[string]any{
			"user_id_present":         user.ID != "",
			"company_id_present":      user.CompanyID != "",
			"company_domain_present":  user.CompanyDomain != "",
			"company_country_present": user.CompanyCountry != "",
		})
		t.Logf("live Pipedrive /users/me ok: user_id_present=%t company_id_present=%t company_domain_present=%t", user.ID != "", user.CompanyID != "", user.CompanyDomain != "")
	}

	if creds.RefreshToken != "" {
		token, err := client.RefreshAccessToken(ctx, creds)
		if err != nil {
			t.Fatalf("live Pipedrive OAuth refresh failed: %v", err)
		}
		ran = true
		refreshed := creds
		refreshed.AccessToken = token.AccessToken
		if token.RefreshToken != "" {
			refreshed.RefreshToken = token.RefreshToken
		}
		if token.APIBaseURL != "" {
			refreshed.APIBaseURL = token.APIBaseURL
		}
		pipedriveLiveRecordEvidence(t, "oauth_refresh", map[string]any{
			"access_token_present":  token.AccessToken != "",
			"rotated_refresh_token": token.RefreshToken != "",
			"api_domain_present":    token.APIBaseURL != "",
			"expires_in":            token.ExpiresIn,
		})
		t.Logf("live Pipedrive OAuth refresh ok: access_token_present=%t rotated_refresh_token=%t api_domain_present=%t", token.AccessToken != "", token.RefreshToken != "", token.APIBaseURL != "")
		if refreshed.APIBaseURL != "" {
			user, err := client.CurrentUser(ctx, refreshed)
			if err != nil {
				t.Fatalf("live Pipedrive /users/me after refresh failed: %v", err)
			}
			pipedriveLiveRecordEvidence(t, "oauth_users_me_after_refresh", map[string]any{
				"user_id_present":    user.ID != "",
				"company_id_present": user.CompanyID != "",
			})
			t.Logf("live Pipedrive refreshed /users/me ok: user_id_present=%t company_id_present=%t", user.ID != "", user.CompanyID != "")
		}
	}

	if !ran {
		t.Skip("PIPEDRIVE_ACCESS_TOKEN with PIPEDRIVE_API_BASE_URL/API_DOMAIN or PIPEDRIVE_REFRESH_TOKEN is required for OAuth live certification")
	}
}

func TestPipedriveLiveCertificationOAuthRevocation(t *testing.T) {
	pipedriveRequireLiveCertification(t)
	if !pipedriveLiveBool("PIPEDRIVE_LIVE_REVOKE") {
		t.Skip("PIPEDRIVE_LIVE_REVOKE=1 not set; skipping OAuth revocation live certification")
	}
	creds := pipedriveLiveCredentials()
	if creds.ClientID == "" || creds.ClientSecret == "" {
		t.Fatal("PIPEDRIVE_CLIENT_ID and PIPEDRIVE_CLIENT_SECRET are required for OAuth revocation live certification")
	}
	revokeToken := pipedriveLiveEnv("PIPEDRIVE_LIVE_REVOKE_REFRESH_TOKEN")
	if revokeToken == "" {
		t.Fatal("PIPEDRIVE_LIVE_REVOKE_REFRESH_TOKEN must be a disposable refresh token; PIPEDRIVE_REFRESH_TOKEN is intentionally never revoked by this test")
	}
	creds.RefreshToken = revokeToken

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	client := PipedriveOAuthClient{
		HTTPClient:   &http.Client{Timeout: 20 * time.Second},
		OAuthBaseURL: creds.OAuthBaseURL,
		UserAgent:    pipedriveLiveUserAgent,
	}
	if err := client.RevokeRefreshToken(ctx, creds); err != nil {
		t.Fatalf("live Pipedrive OAuth refresh-token revocation failed: %v", err)
	}
	pipedriveLiveRecordEvidence(t, "oauth_refresh_token_revocation", map[string]any{
		"revoked": true,
	})
	t.Log("live Pipedrive OAuth refresh-token revocation ok")
}

func TestPipedriveLiveCertificationManagedWebhooks(t *testing.T) {
	pipedriveRequireLiveCertification(t)
	if !pipedriveLiveBool("PIPEDRIVE_LIVE_WEBHOOKS") {
		t.Skip("PIPEDRIVE_LIVE_WEBHOOKS=1 not set; skipping managed webhook live certification")
	}
	creds, integration := pipedriveLiveReadConfig(t)
	if creds.WebhookUsername == "" || creds.WebhookPassword == "" {
		t.Fatal("PIPEDRIVE_WEBHOOK_USERNAME and PIPEDRIVE_WEBHOOK_PASSWORD are required for managed webhook live certification")
	}
	appBaseURL := pipedriveLiveEnv("PIPEDRIVE_LIVE_WEBHOOK_BASE_URL")
	if appBaseURL == "" {
		t.Fatal("PIPEDRIVE_LIVE_WEBHOOK_BASE_URL is required and should point at a disposable public test endpoint")
	}
	topics := pipedriveLiveWebhookTopics()
	integration.Settings["webhook_events"] = topics

	registrar := PipedriveRESTWebhookRegistrar{
		HTTPClient: &http.Client{Timeout: 20 * time.Second},
		Credentials: pipedriveLiveCredentialResolver{
			creds: creds,
		},
		UserAgent: pipedriveLiveUserAgent,
		Topics:    topics,
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		cleanup, err := registrar.CleanupWebhooks(ctx, integration, appBaseURL)
		if err != nil {
			t.Errorf("live Pipedrive managed webhook cleanup failed: %v", err)
			return
		}
		pipedriveLiveRecordEvidence(t, "managed_webhook_cleanup", map[string]any{
			"endpoint_present": true,
			"deleted":          len(cleanup.Subscriptions),
			"topics":           len(topics),
		})
		t.Logf("live Pipedrive managed webhook cleanup ok: deleted=%d", len(cleanup.Subscriptions))
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	summary, err := registrar.ReconcileWebhooks(ctx, integration, appBaseURL)
	if err != nil {
		t.Fatalf("live Pipedrive managed webhook reconciliation failed: %v", err)
	}
	if len(summary.Subscriptions) == 0 {
		t.Fatal("live Pipedrive managed webhook reconciliation returned no subscriptions")
	}
	pipedriveLiveRecordEvidence(t, "managed_webhook_reconcile", map[string]any{
		"endpoint_present":  summary.Endpoint != "",
		"subscriptions":     len(summary.Subscriptions),
		"configured_topics": len(topics),
	})
	t.Logf("live Pipedrive managed webhook reconciliation ok: endpoint_present=%t subscriptions=%d", summary.Endpoint != "", len(summary.Subscriptions))
}

func pipedriveRequireLiveCertification(t *testing.T) {
	t.Helper()
	if !pipedriveLiveBool(pipedriveLiveCertificationEnv) {
		t.Skip(pipedriveLiveCertificationEnv + "=1 not set; skipping Pipedrive live certification test")
	}
}

func pipedriveLiveReadConfig(t *testing.T) (PipedriveCredentials, Integration) {
	t.Helper()
	creds := pipedriveLiveCredentials()
	if creds.APIToken == "" && creds.AccessToken == "" {
		t.Skip("PIPEDRIVE_API_TOKEN or PIPEDRIVE_ACCESS_TOKEN is required for live Pipedrive read certification")
	}
	companyDomain := pipedriveLiveEnv("PIPEDRIVE_COMPANY_DOMAIN")
	if creds.APIBaseURL == "" && companyDomain == "" {
		t.Skip("PIPEDRIVE_API_BASE_URL/PIPEDRIVE_API_DOMAIN or PIPEDRIVE_COMPANY_DOMAIN is required for live Pipedrive read certification")
	}
	return creds, pipedriveLiveIntegration(creds, companyDomain)
}

func pipedriveLiveCredentials() PipedriveCredentials {
	expiresAt := parsePipedriveCredentialExpiry(pipedriveLiveEnv("PIPEDRIVE_TOKEN_EXPIRES_AT"), 0)
	return PipedriveCredentials{
		APIToken:        pipedriveLiveEnv("PIPEDRIVE_API_TOKEN"),
		AccessToken:     normalizePipedriveBearerToken(pipedriveLiveEnv("PIPEDRIVE_ACCESS_TOKEN")),
		RefreshToken:    pipedriveLiveEnv("PIPEDRIVE_REFRESH_TOKEN"),
		ClientID:        pipedriveLiveEnv("PIPEDRIVE_CLIENT_ID"),
		ClientSecret:    pipedriveLiveEnv("PIPEDRIVE_CLIENT_SECRET"),
		APIBaseURL:      strings.TrimRight(firstString(pipedriveLiveEnv("PIPEDRIVE_API_BASE_URL"), pipedriveLiveEnv("PIPEDRIVE_API_DOMAIN")), "/"),
		OAuthBaseURL:    strings.TrimRight(pipedriveLiveEnv("PIPEDRIVE_OAUTH_BASE_URL"), "/"),
		UserAgent:       pipedriveLiveUserAgent,
		Scope:           pipedriveLiveEnv("PIPEDRIVE_SCOPE"),
		TokenExpiresAt:  expiresAt,
		WebhookUsername: pipedriveLiveEnv("PIPEDRIVE_WEBHOOK_USERNAME"),
		WebhookPassword: pipedriveLiveEnv("PIPEDRIVE_WEBHOOK_PASSWORD"),
	}
}

func pipedriveLiveIntegration(creds PipedriveCredentials, companyDomain string) Integration {
	settings := map[string]any{
		"company_domain":     companyDomain,
		"api_base_url":       creds.APIBaseURL,
		"limit":              "1",
		"sync_deals":         "true",
		"sync_organizations": "true",
		"sync_activities":    "true",
		"default_tags":       []string{"pipedrive-live-certification"},
	}
	return Integration{
		ID:             "pipedrive-live-certification",
		TenantID:       pipedriveLiveTenantID,
		Provider:       ProviderPipedrive,
		Name:           "Pipedrive live certification",
		Status:         "connected",
		CredentialsRef: pipedriveLiveCredentialRef,
		Settings:       settings,
	}
}

func companyDomainPresent(integration Integration) bool {
	return strings.TrimSpace(settingString(integration.Settings, "company_domain")) != ""
}

func pipedriveLiveBackfillEvidenceCheck(object string, creds PipedriveCredentials) string {
	auth := "api_token"
	if strings.TrimSpace(creds.AccessToken) != "" {
		auth = "oauth"
	}
	return auth + "_backfill_" + strings.ToLower(strings.TrimSpace(object))
}

func pipedriveLiveObjects() []string {
	if objects := pipedriveLiveCSV(pipedriveLiveEnv("PIPEDRIVE_LIVE_OBJECTS")); len(objects) > 0 {
		return objects
	}
	return []string{"persons", "deals", "organizations", "activities"}
}

func pipedriveLiveWebhookTopics() []string {
	if topics := pipedriveLiveCSV(pipedriveLiveEnv("PIPEDRIVE_LIVE_WEBHOOK_TOPICS")); len(topics) > 0 {
		return topics
	}
	return []string{
		"create.person",
		"change.person",
		"delete.person",
		"create.deal",
		"change.deal",
		"delete.deal",
		"create.organization",
		"change.organization",
		"delete.organization",
		"create.activity",
		"change.activity",
		"delete.activity",
	}
}

func pipedriveLiveCSV(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\t' || r == ' '
	})
	out := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" || seen[field] {
			continue
		}
		seen[field] = true
		out = append(out, field)
	}
	return out
}

func pipedriveLiveBool(key string) bool {
	switch strings.ToLower(pipedriveLiveEnv(key)) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

func pipedriveLiveEnv(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}

func pipedriveLiveRecordEvidence(t *testing.T, check string, details map[string]any) {
	t.Helper()
	reportPath := pipedriveLiveEnv("PIPEDRIVE_LIVE_CERTIFICATION_REPORT")
	if reportPath == "" {
		return
	}
	evidence := pipedriveLiveEvidence{
		Provider:   ProviderPipedrive,
		Check:      strings.TrimSpace(check),
		Status:     "passed",
		RecordedAt: time.Now().UTC().Format(time.RFC3339),
		Details:    pipedriveLiveSanitizedEvidenceDetails(details),
	}
	raw, err := json.Marshal(evidence)
	if err != nil {
		t.Fatalf("marshal Pipedrive live certification evidence: %v", err)
	}

	pipedriveLiveEvidenceMu.Lock()
	defer pipedriveLiveEvidenceMu.Unlock()

	if dir := filepath.Dir(reportPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create Pipedrive live certification evidence directory: %v", err)
		}
	}
	f, err := os.OpenFile(reportPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open Pipedrive live certification evidence report: %v", err)
	}
	defer func() { _ = f.Close() }()
	if _, err := f.Write(append(raw, '\n')); err != nil {
		t.Fatalf("write Pipedrive live certification evidence report: %v", err)
	}
}

func pipedriveLiveSanitizedEvidenceDetails(details map[string]any) map[string]any {
	if len(details) == 0 {
		return nil
	}
	out := make(map[string]any, len(details))
	for key, value := range details {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if normalized == "" || strings.Contains(normalized, "token") || strings.Contains(normalized, "secret") || strings.Contains(normalized, "password") {
			continue
		}
		out[key] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func pipedriveLiveReadEvidenceReport(path string) ([]pipedriveLiveEvidence, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open Pipedrive live certification evidence report: %w", err)
	}
	defer func() { _ = f.Close() }()

	var entries []pipedriveLiveEvidence
	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry pipedriveLiveEvidence
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			return nil, fmt.Errorf("decode Pipedrive live certification evidence line %d: %w", lineNo, err)
		}
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read Pipedrive live certification evidence report: %w", err)
	}
	return entries, nil
}

func pipedriveLiveValidateEvidenceCompleteness(entries []pipedriveLiveEvidence) error {
	found := map[string]pipedriveLiveEvidence{}
	for _, entry := range entries {
		if strings.TrimSpace(entry.Provider) != ProviderPipedrive || strings.TrimSpace(entry.Status) != "passed" {
			continue
		}
		check := strings.TrimSpace(entry.Check)
		if check == "" {
			continue
		}
		found[check] = entry
	}

	missing := []string{}
	for _, check := range pipedriveLiveRequiredEvidenceChecks() {
		entry, ok := found[check]
		if !ok {
			missing = append(missing, check)
			continue
		}
		if strings.TrimSpace(entry.RecordedAt) == "" {
			return fmt.Errorf("Pipedrive live certification evidence check %q is missing recorded_at", check)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("Pipedrive live certification evidence is missing required checks: %s", strings.Join(missing, ", "))
	}
	return nil
}

func pipedriveLiveRequiredEvidenceChecks() []string {
	return []string{
		"api_token_backfill_persons",
		"api_token_backfill_deals",
		"api_token_backfill_organizations",
		"api_token_backfill_activities",
		"oauth_backfill_persons",
		"oauth_backfill_deals",
		"oauth_backfill_organizations",
		"oauth_backfill_activities",
		"oauth_users_me",
		"oauth_refresh",
		"oauth_refresh_token_revocation",
		"managed_webhook_reconcile",
		"managed_webhook_cleanup",
		"manual_webhook_basic_auth_delivery",
		"manual_custom_fields_mapping",
		"manual_rate_limit_retry_after",
		"manual_oauth_uninstall_callback",
		"manual_postwave_disconnect_cleanup",
		"manual_reconnect_resume",
		"manual_data_delete_behavior",
	}
}
