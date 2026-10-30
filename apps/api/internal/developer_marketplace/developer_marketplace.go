package developer_marketplace

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

type Deps struct {
	Repo *Repo
	// ReviewSecret gates marketplace reviewer-only transitions such as
	// approving public app/listing distribution. Tenant admins can draft and
	// submit; this secret separates Moosewave review authority from tenant
	// admin authority.
	ReviewSecret string
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller
	// after construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

type Repo struct {
	Pool *db.Pool
}

type App struct {
	ID            string         `json:"id,omitempty"`
	TenantID      string         `json:"tenant_id,omitempty"`
	Name          string         `json:"name"`
	Slug          string         `json:"slug,omitempty"`
	AppType       string         `json:"app_type"`
	Distribution  string         `json:"distribution"`
	Status        string         `json:"status"`
	OwnerEmail    string         `json:"owner_email,omitempty"`
	SupportEmail  string         `json:"support_email,omitempty"`
	HomepageURL   string         `json:"homepage_url,omitempty"`
	PrivacyURL    string         `json:"privacy_url,omitempty"`
	TermsURL      string         `json:"terms_url,omitempty"`
	Description   string         `json:"description,omitempty"`
	Scopes        []string       `json:"scopes"`
	RedirectURIs  []string       `json:"redirect_uris"`
	APIRevisions  []string       `json:"api_revisions"`
	WebhookTopics []string       `json:"webhook_topics"`
	TestMode      bool           `json:"test_mode"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	ReviewNotes   string         `json:"review_notes,omitempty"`
	SubmittedAt   *time.Time     `json:"submitted_at,omitempty"`
	ApprovedAt    *time.Time     `json:"approved_at,omitempty"`
	CreatedAt     time.Time      `json:"created_at,omitempty"`
	UpdatedAt     time.Time      `json:"updated_at,omitempty"`
	Checklist     []ReviewItem   `json:"review_checklist,omitempty"`
}

type OAuthClient struct {
	ID          string     `json:"id,omitempty"`
	TenantID    string     `json:"tenant_id,omitempty"`
	AppID       string     `json:"app_id,omitempty"`
	ClientID    string     `json:"client_id,omitempty"`
	Status      string     `json:"status"`
	RedirectURI []string   `json:"redirect_uris"`
	Scopes      []string   `json:"scopes"`
	CreatedAt   time.Time  `json:"created_at,omitempty"`
	UpdatedAt   time.Time  `json:"updated_at,omitempty"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
}

type OAuthClientResponse struct {
	Client       OAuthClient `json:"client"`
	ClientSecret string      `json:"client_secret,omitempty"`
}

type Installation struct {
	ID            string         `json:"id,omitempty"`
	TenantID      string         `json:"tenant_id,omitempty"`
	AppID         string         `json:"app_id"`
	InstalledBy   string         `json:"installed_by,omitempty"`
	Status        string         `json:"status"`
	GrantedScopes []string       `json:"granted_scopes"`
	Config        map[string]any `json:"config,omitempty"`
	InstalledAt   time.Time      `json:"installed_at,omitempty"`
	UpdatedAt     time.Time      `json:"updated_at,omitempty"`
	RevokedAt     *time.Time     `json:"revoked_at,omitempty"`
}

type Listing struct {
	ID           string         `json:"id,omitempty"`
	TenantID     string         `json:"tenant_id,omitempty"`
	AppID        string         `json:"app_id,omitempty"`
	Slug         string         `json:"slug,omitempty"`
	Name         string         `json:"name"`
	Category     string         `json:"category"`
	Summary      string         `json:"summary,omitempty"`
	DocsURL      string         `json:"docs_url,omitempty"`
	SupportURL   string         `json:"support_url,omitempty"`
	IconURL      string         `json:"icon_url,omitempty"`
	Status       string         `json:"status"`
	ReviewState  string         `json:"review_state"`
	PartnerLevel string         `json:"partner_level,omitempty"`
	Tags         []string       `json:"tags,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	CreatedAt    time.Time      `json:"created_at,omitempty"`
	UpdatedAt    time.Time      `json:"updated_at,omitempty"`
}

type WebhookSubscription struct {
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	AppID            string         `json:"app_id,omitempty"`
	InstallationID   string         `json:"installation_id,omitempty"`
	EndpointURL      string         `json:"endpoint_url"`
	Topics           []string       `json:"topics"`
	SigningSecretRef string         `json:"signing_secret_ref,omitempty"`
	Status           string         `json:"status"`
	FailureCount     int            `json:"failure_count,omitempty"`
	LastDeliveryAt   *time.Time     `json:"last_delivery_at,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
	UpdatedAt        time.Time      `json:"updated_at,omitempty"`
}

type PartnerProfile struct {
	ID                 string         `json:"id,omitempty"`
	TenantID           string         `json:"tenant_id,omitempty"`
	OrganizationName   string         `json:"organization_name"`
	ProfileType        string         `json:"profile_type"`
	Status             string         `json:"status"`
	CertificationLevel string         `json:"certification_level"`
	Regions            []string       `json:"regions,omitempty"`
	Verticals          []string       `json:"verticals,omitempty"`
	Services           []string       `json:"services,omitempty"`
	ListingURL         string         `json:"listing_url,omitempty"`
	ContactEmail       string         `json:"contact_email,omitempty"`
	Metadata           map[string]any `json:"metadata,omitempty"`
	ReviewNotes        string         `json:"review_notes,omitempty"`
	CreatedAt          time.Time      `json:"created_at,omitempty"`
	UpdatedAt          time.Time      `json:"updated_at,omitempty"`
}

type TestAccount struct {
	ID              string         `json:"id,omitempty"`
	TenantID        string         `json:"tenant_id,omitempty"`
	AppID           string         `json:"app_id,omitempty"`
	Name            string         `json:"name"`
	Status          string         `json:"status"`
	SandboxTenantID string         `json:"sandbox_tenant_id,omitempty"`
	SeededResources map[string]any `json:"seeded_resources,omitempty"`
	ExpiresAt       *time.Time     `json:"expires_at,omitempty"`
	CreatedAt       time.Time      `json:"created_at,omitempty"`
	UpdatedAt       time.Time      `json:"updated_at,omitempty"`
}

type AuditLog struct {
	ID        int64          `json:"id"`
	TenantID  string         `json:"tenant_id,omitempty"`
	AppID     string         `json:"app_id,omitempty"`
	Actor     string         `json:"actor,omitempty"`
	Action    string         `json:"action"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
}

type ReviewItem struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Complete bool   `json:"complete"`
	Required bool   `json:"required"`
}

type ValidationResult struct {
	Valid     bool         `json:"valid"`
	Errors    []string     `json:"errors,omitempty"`
	Warnings  []string     `json:"warnings,omitempty"`
	Checklist []ReviewItem `json:"review_checklist,omitempty"`
}

type ReviewDecisionInput struct {
	TenantID     string `json:"tenant_id"`
	Decision     string `json:"decision"`
	Notes        string `json:"notes,omitempty"`
	PartnerLevel string `json:"partner_level,omitempty"`
}

type ReviewQueueFilter struct {
	Kind  string `json:"kind"`
	State string `json:"state"`
	Limit int    `json:"limit"`
}

type ReviewQueueCounts struct {
	Total    int `json:"total"`
	Apps     int `json:"apps"`
	Listings int `json:"listings"`
	Profiles int `json:"profiles"`
	Pending  int `json:"pending"`
	Resolved int `json:"resolved"`
}

type ReviewQueueItem struct {
	Kind          string     `json:"kind"`
	TenantID      string     `json:"tenant_id"`
	AppID         string     `json:"app_id"`
	ListingID     string     `json:"listing_id,omitempty"`
	ProfileID     string     `json:"profile_id,omitempty"`
	Name          string     `json:"name"`
	Slug          string     `json:"slug"`
	AppType       string     `json:"app_type"`
	Distribution  string     `json:"distribution"`
	AppStatus     string     `json:"app_status"`
	ListingStatus string     `json:"listing_status,omitempty"`
	ReviewState   string     `json:"review_state,omitempty"`
	Category      string     `json:"category,omitempty"`
	ProfileType   string     `json:"profile_type,omitempty"`
	ProfileStatus string     `json:"profile_status,omitempty"`
	SupportEmail  string     `json:"support_email,omitempty"`
	PrivacyURL    string     `json:"privacy_url,omitempty"`
	DocsURL       string     `json:"docs_url,omitempty"`
	SupportURL    string     `json:"support_url,omitempty"`
	PartnerLevel  string     `json:"partner_level,omitempty"`
	ListingURL    string     `json:"listing_url,omitempty"`
	ContactEmail  string     `json:"contact_email,omitempty"`
	SubmittedAt   *time.Time `json:"submitted_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type ReviewQueueResponse struct {
	SchemaVersion string            `json:"schema_version"`
	GeneratedAt   time.Time         `json:"generated_at"`
	Filter        ReviewQueueFilter `json:"filter"`
	Counts        ReviewQueueCounts `json:"counts"`
	Items         []ReviewQueueItem `json:"items"`
}

type MonitoringStatusCounts struct {
	Total     int `json:"total"`
	Active    int `json:"active,omitempty"`
	Installed int `json:"installed,omitempty"`
	Published int `json:"published,omitempty"`
	Submitted int `json:"submitted,omitempty"`
	Paused    int `json:"paused,omitempty"`
	Suspended int `json:"suspended,omitempty"`
	Revoked   int `json:"revoked,omitempty"`
	Expired   int `json:"expired,omitempty"`
}

type AppMonitoringCounts struct {
	OAuthClients         MonitoringStatusCounts `json:"oauth_clients"`
	Installations        MonitoringStatusCounts `json:"installations"`
	WebhookSubscriptions MonitoringStatusCounts `json:"webhook_subscriptions"`
	TestAccounts         MonitoringStatusCounts `json:"test_accounts"`
	AccessTokens         MonitoringStatusCounts `json:"access_tokens"`
	WebhookFailures      int                    `json:"webhook_failures"`
	LastDeliveryAt       *time.Time             `json:"last_delivery_at,omitempty"`
	LastTokenUsedAt      *time.Time             `json:"last_token_used_at,omitempty"`
}

type MonitoringCheck struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Status   string `json:"status"`
	Severity string `json:"severity"`
	Message  string `json:"message,omitempty"`
}

type APIRevisionWarning struct {
	Revision string `json:"revision"`
	Status   string `json:"status"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	SunsetAt string `json:"sunset_at,omitempty"`
}

type AppMonitoringReport struct {
	SchemaVersion       string               `json:"schema_version"`
	GeneratedAt         time.Time            `json:"generated_at"`
	Ready               bool                 `json:"ready"`
	Status              string               `json:"status"`
	App                 App                  `json:"app"`
	Listing             *Listing             `json:"listing,omitempty"`
	Counts              AppMonitoringCounts  `json:"counts"`
	Checks              []MonitoringCheck    `json:"checks"`
	Blockers            []string             `json:"blockers,omitempty"`
	Warnings            []string             `json:"warnings,omitempty"`
	APIRevisionWarnings []APIRevisionWarning `json:"api_revision_warnings,omitempty"`
}

var (
	ErrNotFound = errors.New("developer_marketplace: not found")
	slugRE      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`)
	uuidRE      = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/developer-marketplace/catalog", d.Catalog)
	r.With(admin).Post("/api/v1/developer-marketplace/apps/validate", d.ValidateApp)
	r.With(read).Get("/api/v1/developer-marketplace/apps", d.ListApps)
	r.With(admin).Post("/api/v1/developer-marketplace/apps", d.CreateApp)
	r.With(read).Get("/api/v1/developer-marketplace/apps/{id}", d.GetApp)
	r.With(admin).Get("/api/v1/developer-marketplace/review/queue", d.ReviewQueue)
	r.With(admin).Post("/api/v1/developer-marketplace/review/apps/{id}/decision", d.ReviewAppDecision)
	r.With(admin).Post("/api/v1/developer-marketplace/review/apps/{id}/listing/decision", d.ReviewListingDecision)
	r.With(admin).Post("/api/v1/developer-marketplace/review/partner-profiles/{tenant_id}/decision", d.ReviewPartnerProfileDecision)
	r.With(read).Get("/api/v1/developer-marketplace/apps/{id}/monitoring", d.GetAppMonitoring)
	r.With(admin).Patch("/api/v1/developer-marketplace/apps/{id}", d.UpdateApp)
	r.With(admin).Post("/api/v1/developer-marketplace/apps/{id}/submit-review", d.SubmitAppReview)
	r.With(read).Get("/api/v1/developer-marketplace/apps/{id}/oauth-clients", d.ListOAuthClients)
	r.With(admin).Post("/api/v1/developer-marketplace/apps/{id}/oauth-clients", d.CreateOAuthClient)
	r.With(admin).Delete("/api/v1/developer-marketplace/apps/{id}/oauth-clients/{client_id}", d.RevokeOAuthClient)
	r.With(admin).Post("/api/v1/developer-marketplace/oauth/authorize", d.AuthorizeOAuthApp)
	r.Post("/api/v1/developer-marketplace/oauth/token", d.ExchangeOAuthToken)
	r.Post("/api/v1/developer-marketplace/oauth/revoke", d.RevokeOAuthToken)
	r.With(read).Get("/api/v1/developer-marketplace/apps/{id}/test-accounts", d.ListTestAccounts)
	r.With(admin).Post("/api/v1/developer-marketplace/apps/{id}/test-accounts", d.CreateTestAccount)
	r.With(read).Get("/api/v1/developer-marketplace/listings", d.ListListings)
	r.With(admin).Put("/api/v1/developer-marketplace/apps/{id}/listing", d.UpsertListing)
	r.With(admin).Post("/api/v1/developer-marketplace/apps/{id}/listing/submit-review", d.SubmitListingReview)
	r.With(read).Get("/api/v1/developer-marketplace/installations", d.ListInstallations)
	r.With(admin).Post("/api/v1/developer-marketplace/apps/{id}/installations", d.InstallApp)
	r.With(admin).Delete("/api/v1/developer-marketplace/installations/{installation_id}", d.RevokeInstallation)
	r.With(read).Get("/api/v1/developer-marketplace/apps/{id}/webhook-subscriptions", d.ListWebhookSubscriptions)
	r.With(admin).Post("/api/v1/developer-marketplace/apps/{id}/webhook-subscriptions", d.CreateWebhookSubscription)
	r.With(read).Get("/api/v1/developer-marketplace/partner-profiles", d.ListPartnerProfiles)
	r.With(admin).Put("/api/v1/developer-marketplace/partner-profile", d.UpsertPartnerProfile)
	r.With(admin).Post("/api/v1/developer-marketplace/partner-profile/submit-review", d.SubmitPartnerProfileReview)
	r.With(read).Get("/api/v1/developer-marketplace/audit-logs", d.ListAuditLogs)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version":   "klv13.developer_marketplace.v1",
		"api_revisions":    APIRevisionPolicy(),
		"app_types":        AppTypeCatalog(),
		"distributions":    DistributionCatalog(),
		"scopes":           scopeStrings(apikeys.AllScopes),
		"webhook_topics":   WebhookTopicNames(),
		"webhook_catalog":  WebhookTopicCatalog(),
		"sdk_policy":       SDKPolicy(),
		"oauth_runtime":    OAuthRuntimeCatalog(),
		"listing_review":   ListingReviewCatalog(),
		"partner_levels":   []string{"registered", "certified", "premier", "elite"},
		"revocation_paths": RevocationPaths(),
	})
}

// APIRevisionPolicy lists supported API revisions and the support tier
// each one gets. Klaviyo-style: the latest is `current`, the prior is
// `supported` for a year, anything older is `deprecated` with a sunset
// date so partners can plan. Wired here (not just OpenAPI) so the SDKs
// can pin a revision at request time and the marketplace can warn
// installers that an app pins a stale revision.
func APIRevisionPolicy() []map[string]string {
	return []map[string]string{
		{"key": "2026-05-29", "label": "Klaviyo-parity foundation", "status": "current"},
	}
}

// AppTypeCatalog distinguishes the install/auth flow per app type.
// `private` apps use API keys bound to the owning tenant; `public`
// OAuth apps need /oauth/authorize + /oauth/token plus this revocation
// flow; `native` are Moosewave-built integrations that ship with the
// platform; `catalog_only` are non-installable listings (e.g., expert
// services). The runtime_status column reflects which flows currently
// have executable wiring vs. just data-plane modeling.
func AppTypeCatalog() []map[string]string {
	return []map[string]string{
		{"key": "private", "label": "Private app", "runtime_status": "supported", "install_flow": "api_key"},
		{"key": "public", "label": "Public OAuth app", "runtime_status": "supported", "install_flow": "oauth_authorization_code"},
		{"key": "native", "label": "Native integration", "runtime_status": "foundation", "install_flow": "platform_managed"},
		{"key": "catalog_only", "label": "Catalog-only listing", "runtime_status": "foundation", "install_flow": "none"},
	}
}

// DistributionCatalog mirrors Klaviyo's "Built by Klaviyo / partner /
// catalog-only / private" taxonomy with explicit certified/non-certified
// state so the marketplace UI can sort and filter coherently.
func DistributionCatalog() []map[string]string {
	return []map[string]string{
		{"key": "private", "label": "Private to this tenant", "review": "not_required"},
		{"key": "marketplace", "label": "Public marketplace listing", "review": "required"},
		{"key": "partner_catalog", "label": "Partner-built integration", "review": "required"},
		{"key": "native_postwave", "label": "Native Moosewave integration", "review": "internal"},
		{"key": "catalog_only", "label": "Catalog-only listing (no install flow)", "review": "required"},
	}
}

// WebhookTopicCatalog maps each topic to its source product so partner
// apps know which dependencies they're picking up. Topics whose source
// is still in another initiative (e.g. reviews → KLV-11) carry a
// `runtime_status` of "planned" — same blocked-product pattern as the
// reporting catalog.
func WebhookTopicCatalog() []map[string]string {
	return []map[string]string{
		{"key": "campaign.sent", "source": "campaign", "runtime_status": "supported"},
		{"key": "campaign.conversion", "source": "campaign", "runtime_status": "supported"},
		{"key": "profile.created", "source": "subscribers", "runtime_status": "supported"},
		{"key": "profile.updated", "source": "subscribers", "runtime_status": "supported"},
		{"key": "event.created", "source": "track", "runtime_status": "supported"},
		{"key": "segment.membership_changed", "source": "segments", "runtime_status": "supported"},
		{"key": "form.submitted", "source": "forms", "runtime_status": "supported"},
		{"key": "review.created", "source": "reviews", "runtime_status": "planned"},
		{"key": "support.ticket_updated", "source": "service_suite", "runtime_status": "planned"},
	}
}

// WebhookTopicNames flattens WebhookTopicCatalog into the simple string
// list that ValidateAppInput / repo writes use. Kept as a separate fn so
// the catalog can carry richer metadata without breaking older clients.
func WebhookTopicNames() []string {
	cat := WebhookTopicCatalog()
	out := make([]string, 0, len(cat))
	for _, item := range cat {
		out = append(out, item["key"])
	}
	return out
}

func SDKPolicy() map[string]any {
	return map[string]any{
		"maintained": []string{"typescript", "python", "php"},
		"planned":    []string{"ruby", "postman_collection", "sample_apps"},
	}
}

// RevocationPaths advertises the canonical DELETE endpoints partners use
// to terminate access — surfacing them in the catalog means SDKs and
// the developer docs site can render them without hand-maintained tables.
func RevocationPaths() map[string]string {
	return map[string]string{
		"oauth_client": "DELETE /api/v1/developer-marketplace/apps/{id}/oauth-clients/{client_id}",
		"installation": "DELETE /api/v1/developer-marketplace/installations/{installation_id}",
		"access_token": "POST /api/v1/developer-marketplace/oauth/revoke",
	}
}

func OAuthRuntimeCatalog() map[string]any {
	return map[string]any{
		"grant_types":              []string{"authorization_code"},
		"code_challenge_methods":   []string{"S256"},
		"authorization_endpoint":   "POST /api/v1/developer-marketplace/oauth/authorize",
		"token_endpoint":           "POST /api/v1/developer-marketplace/oauth/token",
		"revocation_endpoint":      "POST /api/v1/developer-marketplace/oauth/revoke",
		"authorization_code_ttl_s": int(oauthAuthorizationCodeTTL.Seconds()),
		"access_token_ttl_s":       int(oauthAccessTokenTTL.Seconds()),
		"secret_storage":           "client secrets, authorization codes, and access tokens are stored as SHA-256 hashes only",
		"token_usage":              "send as Authorization: Bearer pw_at_... on regular scoped Moosewave API routes",
	}
}

func ListingReviewCatalog() map[string]string {
	return map[string]string{
		"draft_endpoint":          "PUT /api/v1/developer-marketplace/apps/{id}/listing",
		"submit_endpoint":         "POST /api/v1/developer-marketplace/apps/{id}/listing/submit-review",
		"queue_endpoint":          "GET /api/v1/developer-marketplace/review/queue",
		"review_app_endpoint":     "POST /api/v1/developer-marketplace/review/apps/{id}/decision",
		"review_listing_endpoint": "POST /api/v1/developer-marketplace/review/apps/{id}/listing/decision",
		"submit_profile_endpoint": "POST /api/v1/developer-marketplace/partner-profile/submit-review",
		"review_profile_endpoint": "POST /api/v1/developer-marketplace/review/partner-profiles/{tenant_id}/decision",
		"review_secret_header":    "X-Postwave-Review-Secret",
		"public_criteria":         "app.status in (approved, active), listing.status=published, listing.review_state=approved, and partner profiles require status=certified",
		"partner_controls":        "partners can save drafts and submit for review; approval and publication are review-owned states",
	}
}

func (d *Deps) ValidateApp(w http.ResponseWriter, r *http.Request) {
	var in App
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ValidateAppInput(in))
}

func (d *Deps) ListApps(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.Repo.ListApps(r.Context(), tenantID, r.URL.Query().Get("status"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Envelope serializes as {"items":[...], "nextCursor"?} — additive over
	// the prior {"items":[...]} shape (nextCursor omitted on the last page).
	writeJSON(w, http.StatusOK, pagination.Envelope[App]{Items: out, NextCursor: next})
}

func (d *Deps) CreateApp(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in App
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if validation := ValidateAppInput(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.CreateApp(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetApp(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetApp(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetAppMonitoring(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetAppMonitoring(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateApp(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in App
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if validation := ValidateAppInput(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.UpdateApp(r.Context(), tenantID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SubmitAppReview(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.SubmitAppReview(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ReviewQueue(w http.ResponseWriter, r *http.Request) {
	if !d.requireReviewOperator(w, r) {
		return
	}
	filter, err := reviewQueueFilterFromRequest(r)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.ListReviewQueue(r.Context(), filter)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ReviewAppDecision(w http.ResponseWriter, r *http.Request) {
	if !d.requireReviewOperator(w, r) {
		return
	}
	in, ok := decodeReviewDecision(w, r)
	if !ok {
		return
	}
	out, err := d.Repo.ReviewAppDecision(r.Context(), in.TenantID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ReviewListingDecision(w http.ResponseWriter, r *http.Request) {
	if !d.requireReviewOperator(w, r) {
		return
	}
	in, ok := decodeReviewDecision(w, r)
	if !ok {
		return
	}
	out, err := d.Repo.ReviewListingDecision(r.Context(), in.TenantID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ReviewPartnerProfileDecision(w http.ResponseWriter, r *http.Request) {
	if !d.requireReviewOperator(w, r) {
		return
	}
	in, ok := decodeReviewDecisionForTenant(w, r, chi.URLParam(r, "tenant_id"))
	if !ok {
		return
	}
	out, err := d.Repo.ReviewPartnerProfileDecision(r.Context(), in.TenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListOAuthClients(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListOAuthClients(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateOAuthClient(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in OAuthClient
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.AppID = chi.URLParam(r, "id")
	if err := validateOAuthClient(in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	created, secret, err := d.Repo.CreateOAuthClient(r.Context(), tenantID, in.AppID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, OAuthClientResponse{Client: *created, ClientSecret: secret})
}

func (d *Deps) RevokeOAuthClient(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.RevokeOAuthClient(r.Context(), tenantID, chi.URLParam(r, "id"), chi.URLParam(r, "client_id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RevokeInstallation(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.RevokeInstallation(r.Context(), tenantID, chi.URLParam(r, "installation_id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertListing(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Listing
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.AppID = chi.URLParam(r, "id")
	if err := validateListing(in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.UpsertListing(r.Context(), tenantID, in.AppID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SubmitListingReview(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.SubmitListingReview(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListListings(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.Repo.ListListings(r.Context(), tenantID, r.URL.Query().Get("category"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, pagination.Envelope[Listing]{Items: out, NextCursor: next})
}

func (d *Deps) InstallApp(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Installation
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.AppID = chi.URLParam(r, "id")
	out, err := d.Repo.InstallApp(r.Context(), tenantID, in.AppID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListInstallations(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.Repo.ListInstallations(r.Context(), tenantID, r.URL.Query().Get("status"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, pagination.Envelope[Installation]{Items: out, NextCursor: next})
}

func (d *Deps) ListWebhookSubscriptions(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListWebhookSubscriptions(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateWebhookSubscription(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in WebhookSubscription
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.AppID = chi.URLParam(r, "id")
	if err := validateWebhookSubscription(in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.CreateWebhookSubscription(r.Context(), tenantID, in.AppID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) UpsertPartnerProfile(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in PartnerProfile
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if err := validatePartnerProfile(in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.UpsertPartnerProfile(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SubmitPartnerProfileReview(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.SubmitPartnerProfileReview(r.Context(), tenantID)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListPartnerProfiles(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.Repo.ListPartnerProfiles(r.Context(), tenantID, r.URL.Query().Get("profile_type"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, pagination.Envelope[PartnerProfile]{Items: out, NextCursor: next})
}

func (d *Deps) CreateTestAccount(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in TestAccount
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.AppID = chi.URLParam(r, "id")
	out, err := d.Repo.CreateTestAccount(r.Context(), tenantID, in.AppID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListTestAccounts(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListTestAccounts(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) ListAuditLogs(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.Repo.ListAuditLogs(r.Context(), tenantID, r.URL.Query().Get("app_id"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, pagination.Envelope[AuditLog]{Items: out, NextCursor: next})
}

func ValidateAppInput(in App) ValidationResult {
	normalizeApp(&in)
	out := ValidationResult{Valid: true, Checklist: ReviewChecklist(in)}
	if in.Name == "" {
		out.Errors = append(out.Errors, "name is required")
	}
	if !slugRE.MatchString(in.Slug) {
		out.Errors = append(out.Errors, "slug must be lowercase letters, numbers, and hyphens")
	}
	if !allowed(in.AppType, []string{"private", "public", "native", "catalog_only"}) {
		out.Errors = append(out.Errors, "app_type is invalid")
	}
	if !allowed(in.Distribution, []string{"private", "marketplace", "partner_catalog", "native_postwave", "catalog_only"}) {
		out.Errors = append(out.Errors, "distribution is invalid")
	}
	if !allowed(in.Status, []string{"draft", "submitted", "in_review", "approved", "active", "suspended", "rejected", "archived"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	topicAllow := map[string]bool{}
	for _, name := range WebhookTopicNames() {
		topicAllow[name] = true
	}
	for _, topic := range in.WebhookTopics {
		if !topicAllow[topic] {
			out.Errors = append(out.Errors, "unsupported webhook topic: "+topic)
		}
	}
	for _, scope := range in.Scopes {
		if !apikeys.IsValidScope(scope) {
			out.Errors = append(out.Errors, "unsupported scope: "+scope)
		}
	}
	for _, uri := range in.RedirectURIs {
		if !validURL(uri, true) {
			out.Errors = append(out.Errors, "redirect_uris must be valid http(s) URLs")
			break
		}
	}
	if in.Distribution != "private" {
		if in.SupportEmail == "" {
			out.Errors = append(out.Errors, "support_email is required for distributed apps")
		}
		if !validURL(in.PrivacyURL, true) {
			out.Errors = append(out.Errors, "privacy_url is required for distributed apps")
		}
		if in.Description == "" {
			out.Errors = append(out.Errors, "description is required for distributed apps")
		}
	}
	if in.AppType == "public" && len(in.RedirectURIs) == 0 {
		out.Errors = append(out.Errors, "public apps require at least one redirect_uri")
	}
	if len(in.Scopes) == 0 {
		out.Warnings = append(out.Warnings, "app has no scopes; installs will not receive API access until scopes are granted")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func (d *Deps) requireReviewOperator(w http.ResponseWriter, r *http.Request) bool {
	secret := strings.TrimSpace(d.ReviewSecret)
	if secret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "review_operator_not_configured", "marketplace review approvals are not configured")
		return false
	}
	got := strings.TrimSpace(r.Header.Get("X-Postwave-Review-Secret"))
	if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(secret)) != 1 {
		writeReviewOperatorRequiredDenial(w)
		return false
	}
	return true
}

func decodeReviewDecision(w http.ResponseWriter, r *http.Request) (ReviewDecisionInput, bool) {
	var in ReviewDecisionInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return ReviewDecisionInput{}, false
	}
	if err := validateReviewDecision(in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return ReviewDecisionInput{}, false
	}
	return normalizeReviewDecision(in), true
}

func decodeReviewDecisionForTenant(w http.ResponseWriter, r *http.Request, tenantID string) (ReviewDecisionInput, bool) {
	var in ReviewDecisionInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return ReviewDecisionInput{}, false
	}
	in.TenantID = tenantID
	if err := validateReviewDecision(in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return ReviewDecisionInput{}, false
	}
	return normalizeReviewDecision(in), true
}

func reviewQueueFilterFromRequest(r *http.Request) (ReviewQueueFilter, error) {
	q := r.URL.Query()
	limit := 100
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			return ReviewQueueFilter{}, fmt.Errorf("limit must be an integer")
		}
		limit = n
	}
	return normalizeReviewQueueFilter(ReviewQueueFilter{
		Kind:  q.Get("kind"),
		State: q.Get("state"),
		Limit: limit,
	})
}

func normalizeReviewQueueFilter(in ReviewQueueFilter) (ReviewQueueFilter, error) {
	kind := strings.ToLower(strings.TrimSpace(in.Kind))
	if kind == "" {
		kind = "all"
	}
	if !allowed(kind, []string{"all", "app", "listing", "partner_profile"}) {
		return ReviewQueueFilter{}, fmt.Errorf("kind must be all, app, listing, or partner_profile")
	}
	state := strings.ToLower(strings.TrimSpace(in.State))
	if state == "" {
		state = "pending"
	}
	if !allowed(state, []string{"pending", "resolved", "all"}) {
		return ReviewQueueFilter{}, fmt.Errorf("state must be pending, resolved, or all")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	return ReviewQueueFilter{Kind: kind, State: state, Limit: limit}, nil
}

func BuildAppMonitoringReport(app App, listing *Listing, counts AppMonitoringCounts, now time.Time) AppMonitoringReport {
	normalizeApp(&app)
	out := AppMonitoringReport{
		SchemaVersion: "developer_marketplace.monitoring.v1",
		GeneratedAt:   now.UTC(),
		App:           app,
		Listing:       listing,
		Counts:        counts,
	}
	addCheck := func(key, label string, ok bool, severity, okMessage, failMessage string) {
		status := "pass"
		message := okMessage
		if !ok {
			status = "fail"
			message = failMessage
			if severity == "blocker" {
				out.Blockers = append(out.Blockers, failMessage)
			} else {
				out.Warnings = append(out.Warnings, failMessage)
			}
		}
		out.Checks = append(out.Checks, MonitoringCheck{
			Key:      key,
			Label:    label,
			Status:   status,
			Severity: severity,
			Message:  message,
		})
	}

	validation := ValidateAppInput(app)
	for _, msg := range validation.Errors {
		out.Blockers = append(out.Blockers, msg)
	}
	for _, msg := range validation.Warnings {
		out.Warnings = append(out.Warnings, msg)
	}
	addCheck("app_validation", "App configuration validates", validation.Valid, "blocker", "App metadata passes validation.", "App metadata has validation errors.")

	for _, item := range validation.Checklist {
		if item.Required {
			addCheck("checklist_"+item.Key, item.Label, item.Complete, "blocker", "Required review item is complete.", item.Label+" is incomplete.")
			continue
		}
		if !item.Complete {
			addCheck("checklist_"+item.Key, item.Label, false, "warning", "", item.Label+" is not complete.")
		}
	}

	distributed := app.Distribution != "private"
	if distributed {
		addCheck("listing_exists", "Marketplace listing exists", listing != nil, "blocker", "Marketplace listing is present.", "Distributed apps require a marketplace listing.")
		if listing != nil {
			addCheck("listing_review", "Listing is reviewed and publishable", listing.Status == "published" && listing.ReviewState == "approved", "blocker", "Listing is published and approved.", "Listing must be published and approved before public distribution.")
			addCheck("listing_docs", "Listing has docs or support URL", strings.TrimSpace(listing.DocsURL) != "" || strings.TrimSpace(listing.SupportURL) != "", "warning", "Listing includes a docs/support URL.", "Listing should include docs or support URL.")
		}
	}

	if app.AppType == "public" {
		addCheck("oauth_client", "Active OAuth client exists", counts.OAuthClients.Active > 0, "blocker", "At least one active OAuth client can issue installs.", "Public apps require at least one active OAuth client.")
	}
	if app.AppType == "catalog_only" {
		addCheck("catalog_only_install_surface", "Catalog-only apps avoid install surfaces", counts.OAuthClients.Active == 0 && counts.Installations.Total == 0, "warning", "Catalog-only app has no install surface.", "Catalog-only apps should not expose OAuth clients or installations.")
	}
	if len(app.WebhookTopics) > 0 {
		addCheck("webhook_subscriptions", "Declared webhook topics have a delivery endpoint", counts.WebhookSubscriptions.Active > 0, "warning", "At least one active app webhook subscription is configured.", "Apps declaring webhook topics should configure an active app webhook subscription.")
	}
	if counts.WebhookFailures > 0 {
		severity := "warning"
		if counts.WebhookFailures >= 10 {
			severity = "blocker"
		}
		addCheck("webhook_failures", "Webhook delivery failures are under control", false, severity, "", fmt.Sprintf("App webhooks have %d recorded delivery failures.", counts.WebhookFailures))
	}
	if distributed || app.TestMode {
		addCheck("test_accounts", "Test account is available", counts.TestAccounts.Active > 0, "warning", "At least one active test account is available.", "Partner review should include an active test account.")
	}

	out.APIRevisionWarnings = APIRevisionWarnings(app.APIRevisions)
	for _, warning := range out.APIRevisionWarnings {
		if warning.Severity == "blocker" {
			out.Blockers = append(out.Blockers, warning.Message)
		} else {
			out.Warnings = append(out.Warnings, warning.Message)
		}
		out.Checks = append(out.Checks, MonitoringCheck{
			Key:      "api_revision_" + warning.Revision,
			Label:    "API revision " + warning.Revision,
			Status:   "fail",
			Severity: warning.Severity,
			Message:  warning.Message,
		})
	}
	if len(out.APIRevisionWarnings) == 0 {
		out.Checks = append(out.Checks, MonitoringCheck{
			Key:      "api_revisions",
			Label:    "API revisions are current",
			Status:   "pass",
			Severity: "blocker",
			Message:  "App pins a supported API revision.",
		})
	}

	out.Ready = len(out.Blockers) == 0
	switch {
	case len(out.Blockers) > 0:
		out.Status = "blocked"
	case len(out.Warnings) > 0:
		out.Status = "warning"
	default:
		out.Status = "ready"
	}
	return out
}

func APIRevisionWarnings(revisions []string) []APIRevisionWarning {
	policyByKey := map[string]map[string]string{}
	for _, item := range APIRevisionPolicy() {
		policyByKey[item["key"]] = item
	}
	revisions = cleanStrings(revisions)
	if len(revisions) == 0 {
		revisions = []string{"2026-05-29"}
	}
	out := []APIRevisionWarning{}
	for _, revision := range revisions {
		policy, ok := policyByKey[revision]
		if !ok {
			out = append(out, APIRevisionWarning{
				Revision: revision,
				Status:   "unknown",
				Severity: "blocker",
				Message:  "Unknown API revision pinned: " + revision,
			})
			continue
		}
		switch policy["status"] {
		case "current":
			continue
		case "supported":
			out = append(out, APIRevisionWarning{
				Revision: revision,
				Status:   "supported",
				Severity: "warning",
				Message:  "API revision is supported but not current: " + revision,
				SunsetAt: policy["sunset_at"],
			})
		case "deprecated":
			out = append(out, APIRevisionWarning{
				Revision: revision,
				Status:   "deprecated",
				Severity: "blocker",
				Message:  "Deprecated API revision must be upgraded before review: " + revision,
				SunsetAt: policy["sunset_at"],
			})
		default:
			out = append(out, APIRevisionWarning{
				Revision: revision,
				Status:   policy["status"],
				Severity: "warning",
				Message:  "API revision has a non-current status: " + revision,
				SunsetAt: policy["sunset_at"],
			})
		}
	}
	return out
}

func ReviewChecklist(in App) []ReviewItem {
	normalizeApp(&in)
	return []ReviewItem{
		{Key: "scopes", Label: "Scopes selected", Complete: len(in.Scopes) > 0, Required: true},
		{Key: "redirects", Label: "OAuth redirect URIs configured", Complete: in.AppType != "public" || len(in.RedirectURIs) > 0, Required: in.AppType == "public"},
		{Key: "support", Label: "Support email configured", Complete: in.SupportEmail != "", Required: in.Distribution != "private"},
		{Key: "privacy", Label: "Privacy policy URL configured", Complete: validURL(in.PrivacyURL, true), Required: in.Distribution != "private"},
		{Key: "webhooks", Label: "Webhook topics declared when needed", Complete: true, Required: false},
		{Key: "test_mode", Label: "Test account workflow available", Complete: in.TestMode || in.Distribution == "private", Required: false},
	}
}

func normalizeApp(in *App) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	in.Slug = strings.Trim(strings.ToLower(strings.TrimSpace(in.Slug)), "-")
	in.AppType = defaulted(strings.TrimSpace(in.AppType), "private")
	in.Distribution = defaulted(strings.TrimSpace(in.Distribution), "private")
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.OwnerEmail = strings.TrimSpace(strings.ToLower(in.OwnerEmail))
	in.SupportEmail = strings.TrimSpace(strings.ToLower(in.SupportEmail))
	in.Scopes = cleanStrings(in.Scopes)
	in.RedirectURIs = cleanStrings(in.RedirectURIs)
	in.APIRevisions = cleanStrings(in.APIRevisions)
	if len(in.APIRevisions) == 0 {
		in.APIRevisions = []string{"2026-05-29"}
	}
	in.WebhookTopics = cleanStrings(in.WebhookTopics)
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	in.Checklist = ReviewChecklistNoNormalize(*in)
}

func ReviewChecklistNoNormalize(in App) []ReviewItem {
	return []ReviewItem{
		{Key: "scopes", Label: "Scopes selected", Complete: len(in.Scopes) > 0, Required: true},
		{Key: "redirects", Label: "OAuth redirect URIs configured", Complete: in.AppType != "public" || len(in.RedirectURIs) > 0, Required: in.AppType == "public"},
		{Key: "support", Label: "Support email configured", Complete: in.SupportEmail != "", Required: in.Distribution != "private"},
		{Key: "privacy", Label: "Privacy policy URL configured", Complete: validURL(in.PrivacyURL, true), Required: in.Distribution != "private"},
		{Key: "webhooks", Label: "Webhook topics declared when needed", Complete: true, Required: false},
		{Key: "test_mode", Label: "Test account workflow available", Complete: in.TestMode || in.Distribution == "private", Required: false},
	}
}

func validateOAuthClient(in OAuthClient) error {
	if len(cleanStrings(in.RedirectURI)) == 0 {
		return fmt.Errorf("redirect_uris is required")
	}
	for _, uri := range in.RedirectURI {
		if !validURL(uri, true) {
			return fmt.Errorf("redirect_uris must be valid http(s) URLs")
		}
	}
	for _, scope := range cleanStrings(in.Scopes) {
		if !apikeys.IsValidScope(scope) {
			return fmt.Errorf("unsupported scope: %s", scope)
		}
	}
	return nil
}

func validateListing(in Listing) error {
	if strings.TrimSpace(in.Name) == "" {
		return fmt.Errorf("name is required")
	}
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	if !slugRE.MatchString(strings.TrimSpace(strings.ToLower(in.Slug))) {
		return fmt.Errorf("slug must be lowercase letters, numbers, and hyphens")
	}
	if strings.TrimSpace(in.Category) == "" {
		return fmt.Errorf("category is required")
	}
	if in.Status != "" && !allowed(in.Status, []string{"draft", "published", "unlisted", "archived"}) {
		return fmt.Errorf("status is invalid")
	}
	if in.ReviewState != "" && !allowed(in.ReviewState, []string{"draft", "submitted", "approved", "rejected"}) {
		return fmt.Errorf("review_state is invalid")
	}
	return nil
}

func validateReviewDecision(in ReviewDecisionInput) error {
	if strings.TrimSpace(in.TenantID) == "" {
		return fmt.Errorf("tenant_id is required")
	}
	if !uuidRE.MatchString(strings.TrimSpace(in.TenantID)) {
		return fmt.Errorf("tenant_id must be a UUID")
	}
	decision := strings.ToLower(strings.TrimSpace(in.Decision))
	if !allowed(decision, []string{"approve", "reject"}) {
		return fmt.Errorf("decision must be approve or reject")
	}
	level := strings.TrimSpace(in.PartnerLevel)
	if level != "" && !allowed(level, []string{"registered", "certified", "premier", "elite"}) {
		return fmt.Errorf("partner_level is invalid")
	}
	return nil
}

func normalizeReviewDecision(in ReviewDecisionInput) ReviewDecisionInput {
	in.TenantID = strings.TrimSpace(in.TenantID)
	in.Decision = strings.ToLower(strings.TrimSpace(in.Decision))
	in.Notes = strings.TrimSpace(in.Notes)
	in.PartnerLevel = strings.TrimSpace(in.PartnerLevel)
	return in
}

func validateWebhookSubscription(in WebhookSubscription) error {
	if !validURL(in.EndpointURL, true) {
		return fmt.Errorf("endpoint_url must be a valid http(s) URL")
	}
	if len(cleanStrings(in.Topics)) == 0 {
		return fmt.Errorf("at least one topic is required")
	}
	if in.Status != "" && !allowed(in.Status, []string{"active", "paused", "revoked"}) {
		return fmt.Errorf("status is invalid")
	}
	return nil
}

func validatePartnerProfile(in PartnerProfile) error {
	if strings.TrimSpace(in.OrganizationName) == "" {
		return fmt.Errorf("organization_name is required")
	}
	if in.ProfileType != "" && !allowed(in.ProfileType, []string{"technology", "agency", "consultant", "affiliate"}) {
		return fmt.Errorf("profile_type is invalid")
	}
	if in.Status != "" && !allowed(in.Status, []string{"draft", "submitted", "certified", "suspended", "archived"}) {
		return fmt.Errorf("status is invalid")
	}
	if in.CertificationLevel != "" && !allowed(in.CertificationLevel, []string{"registered", "certified", "premier", "elite"}) {
		return fmt.Errorf("certification_level is invalid")
	}
	return nil
}

func NewOAuthCredentials() (clientID, secret, secretHash string, err error) {
	var idb [12]byte
	var sb [32]byte
	if _, err = rand.Read(idb[:]); err != nil {
		return "", "", "", err
	}
	if _, err = rand.Read(sb[:]); err != nil {
		return "", "", "", err
	}
	clientID = "pw_app_" + hex.EncodeToString(idb[:])
	secret = "pw_secret_" + hex.EncodeToString(sb[:])
	sum := sha256.Sum256([]byte(secret))
	secretHash = hex.EncodeToString(sum[:])
	return clientID, secret, secretHash, nil
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 64 {
		out = strings.Trim(out[:64], "-")
	}
	if out == "" {
		return "app"
	}
	return out
}

func validURL(raw string, required bool) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return !required
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

func cleanStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

func scopeStrings(in []apikeys.Scope) []string {
	out := make([]string, 0, len(in))
	for _, sc := range in {
		out = append(out, string(sc))
	}
	return out
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

// writeRepoError maps a repo-layer error to an HTTP response. ErrNotFound
// returns a stable 404; any other error is treated as a 5xx and routed
// through httperror.WriteInternal so err.Error() stays in server logs
// (with tenant_id + request_id) instead of being echoed to the caller.
func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "resource not found")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errEnv(code, message string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": message}}
}

func allowed(v string, allowed []string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func defaulted(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// writeReviewOperatorRequiredDenial refuses a marketplace review approval
// without the operator secret.
//
// ReasonPolicy: this is a Moosewave-side control, not a tenant entitlement. No
// role in the caller's workspace grants it — the approver is us — so a remedy
// pointing anywhere in their settings would be a dead end.
func writeReviewOperatorRequiredDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "marketplace_review",
		Reason:  entitlement.ReasonPolicy,
		Code:    "review_operator_required",
		Message: "marketplace review approval requires a review operator secret",
	})
}
