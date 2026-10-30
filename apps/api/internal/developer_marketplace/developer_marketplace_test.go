package developer_marketplace

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestValidateAppInputPublicMarketplace(t *testing.T) {
	out := ValidateAppInput(App{
		Name:         "Inventory Partner",
		AppType:      "public",
		Distribution: "marketplace",
		Scopes:       []string{"read:subscribers", "read:reports"},
		RedirectURIs: []string{"https://partner.example/oauth/callback"},
		SupportEmail: "support@example.com",
		PrivacyURL:   "https://partner.example/privacy",
		Description:  "Syncs inventory and profile events.",
	})
	if !out.Valid {
		t.Fatalf("expected valid app, got errors: %#v", out.Errors)
	}
	if len(out.Checklist) == 0 {
		t.Fatalf("expected review checklist")
	}
}

func TestValidateAppInputRequiresPublicAppRedirect(t *testing.T) {
	out := ValidateAppInput(App{
		Name:         "Broken Public App",
		AppType:      "public",
		Distribution: "private",
		Scopes:       []string{"read:subscribers"},
	})
	if out.Valid {
		t.Fatalf("expected invalid public app")
	}
	if !contains(out.Errors, "public apps require at least one redirect_uri") {
		t.Fatalf("missing redirect error: %#v", out.Errors)
	}
}

func TestValidateAppInputRejectsUnknownScopes(t *testing.T) {
	out := ValidateAppInput(App{
		Name:   "Scopey",
		Scopes: []string{"read:subscribers", "write:everything"},
	})
	if out.Valid {
		t.Fatalf("expected invalid app")
	}
	if !contains(out.Errors, "unsupported scope: write:everything") {
		t.Fatalf("missing scope error: %#v", out.Errors)
	}
}

func TestNewOAuthCredentials(t *testing.T) {
	clientID, secret, hash, err := NewOAuthCredentials()
	if err != nil {
		t.Fatalf("NewOAuthCredentials: %v", err)
	}
	if !strings.HasPrefix(clientID, "pw_app_") {
		t.Fatalf("unexpected client id prefix: %q", clientID)
	}
	if !strings.HasPrefix(secret, "pw_secret_") {
		t.Fatalf("unexpected secret prefix: %q", secret)
	}
	if len(hash) != 64 {
		t.Fatalf("expected sha256 hash, got %q", hash)
	}
}

func TestSlugify(t *testing.T) {
	got := slugify(" My Great App! ")
	if got != "my-great-app" {
		t.Fatalf("slugify = %q", got)
	}
}

func TestValidateAppInputAcceptsNewDistributionsAndTopicGate(t *testing.T) {
	good := ValidateAppInput(App{
		Name:          "Native Inventory",
		AppType:       "native",
		Distribution:  "native_postwave",
		Scopes:        []string{"read:subscribers"},
		WebhookTopics: []string{"profile.created", "event.created"},
		SupportEmail:  "ops@moosewave.com",
		PrivacyURL:    "https://moosewave.com/privacy",
		Description:   "Moosewave-built integration",
	})
	if !good.Valid {
		t.Fatalf("expected valid app, errors: %#v", good.Errors)
	}

	bad := ValidateAppInput(App{
		Name:          "Bad Topics",
		AppType:       "private",
		Distribution:  "private",
		Scopes:        []string{"read:subscribers"},
		WebhookTopics: []string{"profile.created", "made_up.topic"},
	})
	if bad.Valid {
		t.Fatalf("expected unsupported webhook topic to fail validation")
	}
	if !contains(bad.Errors, "unsupported webhook topic: made_up.topic") {
		t.Fatalf("missing unsupported topic error: %#v", bad.Errors)
	}
}

func TestWebhookTopicCatalogPlannedSourcesStayPlanned(t *testing.T) {
	catalog := WebhookTopicCatalog()
	byKey := map[string]map[string]string{}
	for _, item := range catalog {
		byKey[item["key"]] = item
	}
	if got := byKey["review.created"]["runtime_status"]; got != "planned" {
		t.Fatalf("review.created runtime_status = %q, want planned (gated by KLV-11)", got)
	}
	if got := byKey["support.ticket_updated"]["runtime_status"]; got != "planned" {
		t.Fatalf("support.ticket_updated runtime_status = %q, want planned (gated by KLV-10)", got)
	}
	if got := byKey["campaign.sent"]["runtime_status"]; got != "supported" {
		t.Fatalf("campaign.sent should be supported, got %q", got)
	}
}

func TestRevocationPathsAdvertiseCanonicalDeletes(t *testing.T) {
	paths := RevocationPaths()
	if got := paths["oauth_client"]; !strings.HasPrefix(got, "DELETE ") || !strings.Contains(got, "/oauth-clients/") {
		t.Fatalf("oauth_client revocation path looks wrong: %q", got)
	}
	if got := paths["installation"]; !strings.HasPrefix(got, "DELETE ") || !strings.Contains(got, "/installations/") {
		t.Fatalf("installation revocation path looks wrong: %q", got)
	}
	if got := paths["access_token"]; !strings.HasPrefix(got, "POST ") || !strings.Contains(got, "/oauth/revoke") {
		t.Fatalf("access_token revocation path looks wrong: %q", got)
	}
}

func TestDistributionCatalogIncludesNativeAndCatalogOnly(t *testing.T) {
	keys := map[string]bool{}
	for _, item := range DistributionCatalog() {
		keys[item["key"]] = true
	}
	for _, k := range []string{"private", "marketplace", "partner_catalog", "native_postwave", "catalog_only"} {
		if !keys[k] {
			t.Fatalf("distribution catalog missing %q", k)
		}
	}
}

// TestValidatorAcceptsExactlyCatalogDistributions pins the Go-side invariant:
// every distribution the marketplace catalog advertises must pass validation,
// and a non-catalog value must fail. Drift here is half of the KLV-13 bug
// (the other half — the DB CHECK — is guarded by the migration test below).
func TestValidatorAcceptsExactlyCatalogDistributions(t *testing.T) {
	base := App{Name: "X", Slug: "x", AppType: "private", Status: "draft",
		SupportEmail: "a@b.test", PrivacyURL: "https://b.test/privacy"}
	hasDistErr := func(in App) bool {
		for _, e := range ValidateAppInput(in).Errors {
			if e == "distribution is invalid" {
				return true
			}
		}
		return false
	}
	for _, item := range DistributionCatalog() {
		in := base
		in.Distribution = item["key"]
		if hasDistErr(in) {
			t.Errorf("validator rejects advertised distribution %q", item["key"])
		}
	}
	bad := base
	bad.Distribution = "not_a_real_distribution"
	if !hasDistErr(bad) {
		t.Errorf("validator accepted a bogus distribution value")
	}
}

// TestPublicDistributionsSQLCoversNonPrivateCatalog guards the public
// browse/detail query predicate (repo.go publicDistributionsSQL) against the
// drift that hid catalog_only/native_postwave listings: every advertised
// distribution except 'private' must be publicly browsable, and 'private' must
// never be exposed cross-tenant.
func TestPublicDistributionsSQLCoversNonPrivateCatalog(t *testing.T) {
	for _, item := range DistributionCatalog() {
		k := item["key"]
		if k == "private" {
			if strings.Contains(publicDistributionsSQL, "'private'") {
				t.Errorf("publicDistributionsSQL must never expose 'private' apps cross-tenant")
			}
			continue
		}
		if !strings.Contains(publicDistributionsSQL, "'"+k+"'") {
			t.Errorf("publicDistributionsSQL missing publicly-browsable distribution %q (browse/detail queries would hide it)", k)
		}
	}
}

// TestMigrationDistributionCheckCoversCatalog reads the migrations and asserts
// the EFFECTIVE developer_apps distribution CHECK (the last one defined, since
// migrations apply in filename order) allows every advertised distribution.
// This is the guard that would have caught KLV-13: ValidateApp accepted
// native_postwave/catalog_only but the DB constraint rejected them, so creating
// such an app passed validation then crashed on INSERT.
func TestMigrationDistributionCheckCoversCatalog(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "infra", "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read migrations dir: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names) // migrations apply in lexical/filename order

	re := regexp.MustCompile(`(?is)CHECK\s*\(\s*distribution\s+IN\s*\(([^)]*)\)`)
	// broad detects ANY distribution CHECK; if one isn't the IN(...) form re
	// understands (e.g. a future `CHECK (distribution = ANY(...))`), the parser
	// would silently keep the prior effective set — so fail closed instead.
	broad := regexp.MustCompile(`(?is)CHECK\s*\(\s*distribution\b`)
	var effective string // last CHECK(distribution IN (...)) wins
	for _, name := range names {
		body, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		bodyStr := string(body)
		inMatches := re.FindAllStringSubmatch(bodyStr, -1)
		for _, m := range inMatches {
			effective = m[1]
		}
		if got := len(broad.FindAllString(bodyStr, -1)); got != len(inMatches) {
			t.Fatalf("%s defines a distribution CHECK this test can't parse (got %d CHECK(distribution …) vs %d IN-form); update the test or keep the IN(...) form", name, got, len(inMatches))
		}
	}
	if effective == "" {
		t.Fatal("no developer_apps distribution CHECK constraint found in migrations")
	}
	allowed := map[string]bool{}
	for _, tok := range strings.Split(effective, ",") {
		allowed[strings.Trim(strings.TrimSpace(tok), "'")] = true
	}
	for _, item := range DistributionCatalog() {
		if !allowed[item["key"]] {
			t.Errorf("migration distribution CHECK does not allow advertised %q (effective set: %s)", item["key"], effective)
		}
	}
}

func TestPartnerEditableAppStatusCannotSelfApprove(t *testing.T) {
	now := time.Now()
	tests := map[string]string{
		"":          "draft",
		"draft":     "draft",
		"submitted": "draft",
		"in_review": "draft",
		"approved":  "draft",
		"active":    "draft",
		"rejected":  "draft",
		"suspended": "suspended",
		"archived":  "archived",
		"made_up":   "draft",
	}
	for status, want := range tests {
		in := App{
			Name:        "Partner App",
			Status:      status,
			SubmittedAt: &now,
			ApprovedAt:  &now,
		}
		normalizePartnerEditableApp(&in)
		if in.Status != want {
			t.Fatalf("status %q normalized to %q, want %q", status, in.Status, want)
		}
		if in.SubmittedAt != nil || in.ApprovedAt != nil {
			t.Fatalf("review timestamps should be cleared for partner app edits")
		}
	}
}

func TestPartnerEditableListingCannotSelfPublishOrApprove(t *testing.T) {
	tests := []struct {
		name        string
		status      string
		reviewState string
		wantStatus  string
	}{
		{name: "blank defaults", wantStatus: "draft"},
		{name: "published becomes draft", status: "published", reviewState: "approved", wantStatus: "draft"},
		{name: "submitted review becomes draft review state", status: "draft", reviewState: "submitted", wantStatus: "draft"},
		{name: "unlisted stays hidden", status: "unlisted", reviewState: "approved", wantStatus: "unlisted"},
		{name: "archived stays hidden", status: "archived", reviewState: "approved", wantStatus: "archived"},
		{name: "unknown status falls back", status: "made_up", reviewState: "approved", wantStatus: "draft"},
	}
	for _, tt := range tests {
		in := Listing{Name: "Partner Listing", Status: tt.status, ReviewState: tt.reviewState}
		normalizePartnerEditableListing(&in)
		if in.Status != tt.wantStatus {
			t.Fatalf("%s: status = %q, want %q", tt.name, in.Status, tt.wantStatus)
		}
		if in.ReviewState != "draft" {
			t.Fatalf("%s: review_state = %q, want draft", tt.name, in.ReviewState)
		}
	}
}

func TestListingReviewCatalogAdvertisesSubmitEndpoint(t *testing.T) {
	catalog := ListingReviewCatalog()
	if got := catalog["submit_endpoint"]; got != "POST /api/v1/developer-marketplace/apps/{id}/listing/submit-review" {
		t.Fatalf("submit endpoint = %q", got)
	}
	if got := catalog["queue_endpoint"]; got != "GET /api/v1/developer-marketplace/review/queue" {
		t.Fatalf("queue endpoint = %q", got)
	}
	if got := catalog["review_app_endpoint"]; got != "POST /api/v1/developer-marketplace/review/apps/{id}/decision" {
		t.Fatalf("review app endpoint = %q", got)
	}
	if got := catalog["review_listing_endpoint"]; got != "POST /api/v1/developer-marketplace/review/apps/{id}/listing/decision" {
		t.Fatalf("review listing endpoint = %q", got)
	}
	if got := catalog["submit_profile_endpoint"]; got != "POST /api/v1/developer-marketplace/partner-profile/submit-review" {
		t.Fatalf("submit profile endpoint = %q", got)
	}
	if got := catalog["review_profile_endpoint"]; got != "POST /api/v1/developer-marketplace/review/partner-profiles/{tenant_id}/decision" {
		t.Fatalf("review profile endpoint = %q", got)
	}
	if got := catalog["public_criteria"]; !strings.Contains(got, "published") || !strings.Contains(got, "approved") {
		t.Fatalf("public criteria should mention published+approved, got %q", got)
	}
}

func TestReviewQueueFilterDefaultsAndBounds(t *testing.T) {
	filter, err := normalizeReviewQueueFilter(ReviewQueueFilter{})
	if err != nil {
		t.Fatalf("default filter should be valid: %v", err)
	}
	if filter.Kind != "all" || filter.State != "pending" || filter.Limit != 100 {
		t.Fatalf("unexpected default filter: %#v", filter)
	}

	filter, err = normalizeReviewQueueFilter(ReviewQueueFilter{Kind: " Partner_Profile ", State: " ALL ", Limit: 999})
	if err != nil {
		t.Fatalf("custom filter should be valid: %v", err)
	}
	if filter.Kind != "partner_profile" || filter.State != "all" || filter.Limit != 500 {
		t.Fatalf("unexpected normalized filter: %#v", filter)
	}

	for _, in := range []ReviewQueueFilter{
		{Kind: "partner"},
		{State: "open"},
	} {
		if _, err := normalizeReviewQueueFilter(in); err == nil {
			t.Fatalf("expected invalid queue filter: %#v", in)
		}
	}
}

func TestReviewQueueItemPendingClassification(t *testing.T) {
	if !reviewQueueItemPending(ReviewQueueItem{Kind: "app", AppStatus: "submitted"}) {
		t.Fatalf("submitted apps should be pending")
	}
	if !reviewQueueItemPending(ReviewQueueItem{Kind: "listing", ReviewState: "submitted"}) {
		t.Fatalf("submitted listings should be pending")
	}
	if !reviewQueueItemPending(ReviewQueueItem{Kind: "partner_profile", ProfileStatus: "submitted"}) {
		t.Fatalf("submitted partner profiles should be pending")
	}
	if reviewQueueItemPending(ReviewQueueItem{Kind: "app", AppStatus: "approved"}) {
		t.Fatalf("approved apps should be resolved")
	}
	if reviewQueueItemPending(ReviewQueueItem{Kind: "listing", ReviewState: "rejected"}) {
		t.Fatalf("rejected listings should be resolved")
	}
}

func TestPartnerEditableProfileCannotSelfCertify(t *testing.T) {
	tests := []struct {
		name       string
		status     string
		level      string
		wantStatus string
	}{
		{name: "blank defaults", wantStatus: "draft"},
		{name: "submitted becomes draft", status: "submitted", level: "certified", wantStatus: "draft"},
		{name: "certified becomes draft", status: "certified", level: "elite", wantStatus: "draft"},
		{name: "archived stays hidden", status: "archived", level: "premier", wantStatus: "archived"},
	}
	for _, tt := range tests {
		in := PartnerProfile{
			OrganizationName:   "Partner Co",
			Status:             tt.status,
			CertificationLevel: tt.level,
		}
		normalizePartnerEditableProfile(&in)
		if in.Status != tt.wantStatus {
			t.Fatalf("%s: status = %q, want %q", tt.name, in.Status, tt.wantStatus)
		}
		if in.CertificationLevel != "registered" {
			t.Fatalf("%s: certification_level = %q, want registered", tt.name, in.CertificationLevel)
		}
	}
}

func TestReviewOperatorSecretGuard(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/review", nil)
	rec := httptest.NewRecorder()
	if (&Deps{}).requireReviewOperator(rec, req) {
		t.Fatalf("unset review secret should reject")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unset secret status = %d, want 503", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/review", nil)
	req.Header.Set("X-Postwave-Review-Secret", "wrong")
	rec = httptest.NewRecorder()
	if (&Deps{ReviewSecret: "correct"}).requireReviewOperator(rec, req) {
		t.Fatalf("wrong review secret should reject")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("wrong secret status = %d, want 403", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/review", nil)
	req.Header.Set("X-Postwave-Review-Secret", "correct")
	rec = httptest.NewRecorder()
	if !(&Deps{ReviewSecret: "correct"}).requireReviewOperator(rec, req) {
		t.Fatalf("correct review secret should pass")
	}
}

func TestReviewDecisionValidation(t *testing.T) {
	valid := ReviewDecisionInput{
		TenantID:     "00000000-0000-0000-0000-000000000000",
		Decision:     " Approve ",
		Notes:        " reviewed ",
		PartnerLevel: "certified",
	}
	if err := validateReviewDecision(valid); err != nil {
		t.Fatalf("expected valid review decision: %v", err)
	}
	normalized := normalizeReviewDecision(valid)
	if normalized.Decision != "approve" || normalized.Notes != "reviewed" {
		t.Fatalf("unexpected normalized decision: %#v", normalized)
	}

	for _, in := range []ReviewDecisionInput{
		{Decision: "approve"},
		{TenantID: "tenant-123", Decision: "approve"},
		{TenantID: "00000000-0000-0000-0000-000000000000", Decision: "maybe"},
		{TenantID: "00000000-0000-0000-0000-000000000000", Decision: "approve", PartnerLevel: "gold"},
	} {
		if err := validateReviewDecision(in); err == nil {
			t.Fatalf("expected invalid review decision: %#v", in)
		}
	}
}

func TestOAuthRuntimeCatalogAdvertisesAuthorizationCodeFlow(t *testing.T) {
	catalog := OAuthRuntimeCatalog()
	if got := catalog["authorization_endpoint"]; got != "POST /api/v1/developer-marketplace/oauth/authorize" {
		t.Fatalf("authorization endpoint = %#v", got)
	}
	if got := catalog["token_endpoint"]; got != "POST /api/v1/developer-marketplace/oauth/token" {
		t.Fatalf("token endpoint = %#v", got)
	}
	methods := catalog["code_challenge_methods"].([]string)
	if len(methods) != 1 || methods[0] != "S256" {
		t.Fatalf("expected S256-only PKCE, got %#v", methods)
	}
}

func TestResolveOAuthScopesPreventsScopeInflation(t *testing.T) {
	scopes, err := resolveOAuthScopes(
		"read:subscribers write:events",
		[]string{"read:subscribers", "write:events", "admin"},
		[]string{"read:subscribers", "write:events"},
	)
	if err != nil {
		t.Fatalf("expected scopes to resolve: %v", err)
	}
	if strings.Join(scopes, " ") != "read:subscribers write:events" {
		t.Fatalf("unexpected scopes: %#v", scopes)
	}
	if _, err := resolveOAuthScopes("admin", []string{"admin"}, []string{"read:subscribers"}); err == nil {
		t.Fatalf("expected app scope inflation to fail")
	}
	if _, err := resolveOAuthScopes("write:events", []string{"read:subscribers"}, []string{"write:events"}); err == nil {
		t.Fatalf("expected client scope inflation to fail")
	}
}

func TestOAuthRedirectURLIsExactAndStripsFragments(t *testing.T) {
	allowed := []string{"https://partner.example/callback?region=us"}
	if !exactRedirectAllowed("https://partner.example/callback?region=us", allowed) {
		t.Fatalf("expected exact redirect to be allowed")
	}
	if exactRedirectAllowed("https://partner.example/callback?region=eu", allowed) {
		t.Fatalf("expected query mismatch to be rejected")
	}
	got, err := buildOAuthRedirectURL("https://partner.example/callback?region=us#token", "code_123", "state_123")
	if err != nil {
		t.Fatalf("build redirect: %v", err)
	}
	if strings.Contains(got, "#") {
		t.Fatalf("fragment should be stripped: %q", got)
	}
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("parse redirect: %v", err)
	}
	if u.Query().Get("region") != "us" || u.Query().Get("code") != "code_123" || u.Query().Get("state") != "state_123" {
		t.Fatalf("redirect query missing values: %q", got)
	}
}

func TestPKCES256AndSecretHashVerification(t *testing.T) {
	verifier := "verifier-123"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	if !verifyPKCES256(verifier, challenge) {
		t.Fatalf("expected PKCE challenge to match")
	}
	if verifyPKCES256("wrong", challenge) {
		t.Fatalf("expected wrong verifier to fail")
	}
	if !constantTimeHashMatch("pw_secret_test", sha256Hex("pw_secret_test")) {
		t.Fatalf("expected secret hash to match")
	}
	if constantTimeHashMatch("pw_secret_bad", sha256Hex("pw_secret_test")) {
		t.Fatalf("expected wrong secret to fail")
	}
}

func TestOAuthTokenRequestParsesFormEncoding(t *testing.T) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", "pw_code_x")
	form.Set("redirect_uri", "https://partner.example/callback")
	form.Set("client_id", "pw_app_x")
	form.Set("client_secret", "pw_secret_x")
	form.Set("code_verifier", "verifier")
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	parsed, err := parseOAuthTokenRequest(req)
	if err != nil {
		t.Fatalf("parse token form: %v", err)
	}
	if parsed.GrantType != "authorization_code" || parsed.ClientID != "pw_app_x" || parsed.CodeVerifier != "verifier" {
		t.Fatalf("unexpected token request: %#v", parsed)
	}
	if err := validateOAuthTokenRequest(parsed); err != nil {
		t.Fatalf("expected token request to validate: %v", err)
	}
}

func TestOAuthBearerResolverPrefixAndScopeMapping(t *testing.T) {
	resolver := NewOAuthBearerResolver(nil)
	if !resolver.SupportsBearerToken("pw_at_abc") {
		t.Fatalf("expected pw_at_ token to be supported")
	}
	if resolver.SupportsBearerToken("pw_live_abcd_secret") {
		t.Fatalf("normal API keys should not be handled by marketplace resolver")
	}
	scopes := apiKeyScopesFromMarketplaceScopes([]string{
		"read:subscribers",
		"unknown:scope",
		"write:campaigns",
		"read:subscribers",
	})
	gotParts := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		gotParts = append(gotParts, string(scope))
	}
	if got := strings.Join(gotParts, " "); got != "read:subscribers write:campaigns" {
		t.Fatalf("unexpected mapped scopes: %#v", scopes)
	}
}

func TestOAuthBearerActorLabel(t *testing.T) {
	if got := oauthBearerActorLabel("Inventory Sync", "inventory-sync", "client_1", "install_1"); got != "developer-marketplace:inventory-sync:install_1" {
		t.Fatalf("actor label = %q", got)
	}
	if got := oauthBearerActorLabel("Inventory Sync", "", "client_1", ""); got != "developer-marketplace:Inventory Sync" {
		t.Fatalf("actor label fallback = %q", got)
	}
}

func TestBuildAppMonitoringReportBlocksPublicMarketplaceUntilRunnable(t *testing.T) {
	report := BuildAppMonitoringReport(App{
		Name:         "Inventory Partner",
		AppType:      "public",
		Distribution: "marketplace",
		Scopes:       []string{"read:subscribers"},
		RedirectURIs: []string{"https://partner.example/oauth/callback"},
		SupportEmail: "support@example.com",
		PrivacyURL:   "https://partner.example/privacy",
		Description:  "Syncs profile and purchase events.",
	}, nil, AppMonitoringCounts{}, time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC))
	if report.Ready {
		t.Fatalf("expected report to block public marketplace app without listing/oauth")
	}
	if report.Status != "blocked" {
		t.Fatalf("status = %q, want blocked", report.Status)
	}
	if !contains(report.Blockers, "Distributed apps require a marketplace listing.") {
		t.Fatalf("missing listing blocker: %#v", report.Blockers)
	}
	if !contains(report.Blockers, "Public apps require at least one active OAuth client.") {
		t.Fatalf("missing OAuth client blocker: %#v", report.Blockers)
	}
}

func TestBuildAppMonitoringReportReadyForPublishedOAuthApp(t *testing.T) {
	listing := &Listing{
		Status:      "published",
		ReviewState: "approved",
		DocsURL:     "https://partner.example/docs",
	}
	report := BuildAppMonitoringReport(App{
		Name:         "Inventory Partner",
		AppType:      "public",
		Distribution: "marketplace",
		Scopes:       []string{"read:subscribers"},
		RedirectURIs: []string{"https://partner.example/oauth/callback"},
		SupportEmail: "support@example.com",
		PrivacyURL:   "https://partner.example/privacy",
		Description:  "Syncs profile and purchase events.",
		TestMode:     true,
	}, listing, AppMonitoringCounts{
		OAuthClients: MonitoringStatusCounts{
			Total:  1,
			Active: 1,
		},
		TestAccounts: MonitoringStatusCounts{
			Total:  1,
			Active: 1,
		},
	}, time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC))
	if !report.Ready {
		t.Fatalf("expected ready report, blockers: %#v warnings: %#v", report.Blockers, report.Warnings)
	}
	if report.Status != "ready" {
		t.Fatalf("status = %q, want ready", report.Status)
	}
}

func TestAPIRevisionWarningsBlockUnknownRevisions(t *testing.T) {
	warnings := APIRevisionWarnings([]string{"2026-05-29", "2024-01-01"})
	if len(warnings) != 1 {
		t.Fatalf("warnings = %#v, want one unknown revision warning", warnings)
	}
	if warnings[0].Revision != "2024-01-01" || warnings[0].Severity != "blocker" {
		t.Fatalf("unexpected revision warning: %#v", warnings[0])
	}
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
