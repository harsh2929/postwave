package compat

import (
	"encoding/json"
	"errors"
	"log/slog"
	mathrandv2 "math/rand/v2"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

type Deps struct {
	Repo        *Repo
	Subscribers *subscribers.Repo
	Limits      *limits.Enforcer
	Logger      *slog.Logger
	// LandingVariantSignKey signs the A/B attribution token (LAND-037). When
	// empty, variant conversions are recorded unattributed rather than trusting
	// a client-supplied id — views stay attributed, so the split is still
	// visible; conversion attribution activates once the key is wired.
	LandingVariantSignKey []byte
}

const compatJSONMaxBodyBytes int64 = 4 << 20 // 4 MiB

func Mount(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/mailchimp-compat/summary", d.Summary)

	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/mailchimp-compat/groups", d.ListGroups)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/mailchimp-compat/groups", d.CreateGroup)

	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/mailchimp-compat/assets", d.ListAssets)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/mailchimp-compat/assets", d.CreateAsset)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/mailchimp-compat/sections", d.ListSections)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/mailchimp-compat/sections", d.CreateSection)

	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/mailchimp-compat/campaigns/{id}/report", d.CampaignReport)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/mailchimp-compat/campaigns/{id}/events", d.RecordCampaignEvent)

	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/mailchimp-compat/automations", d.ListJourneys)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/mailchimp-compat/automations", d.CreateJourney)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/mailchimp-compat/automations/{id}/pause", d.PauseJourney)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/mailchimp-compat/automations/{id}/resume", d.ResumeJourney)

	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/mailchimp-compat/landing-pages", d.ListLandingPages)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/mailchimp-compat/landing-pages", d.CreateLandingPage)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/mailchimp-compat/popups", d.ListPopups)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/mailchimp-compat/popups", d.CreatePopup)

	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/mailchimp-compat/ecommerce/integrations", d.ListCommerceIntegrations)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/mailchimp-compat/ecommerce/integrations", d.CreateCommerceIntegration)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/mailchimp-compat/ecommerce/shopify/oauth/start", d.StartShopifyOAuth)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/mailchimp-compat/ecommerce/shopify/oauth/callback", d.ShopifyOAuthCallback)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/mailchimp-compat/ecommerce/integrations/{id}/sync-demo", d.SyncDemoCommerce)

}

func MountPublic(r chi.Router, d *Deps) {
	r.Get("/api/public/landing-pages/{slug}", d.PublicLandingPage)
	r.Post("/api/public/landing-pages/{slug}/convert", d.PublicLandingConvert)
	r.Options("/api/public/popups/{key}", d.PublicPopupOptions)
	r.Get("/api/public/popups/{key}", d.PublicPopup)
	r.Options("/api/public/popups/{key}/convert", d.PublicPopupOptions)
	r.Post("/api/public/popups/{key}/convert", d.PublicPopupConvert)
	r.Options("/api/public/popups/{key}/submit", d.PublicPopupOptions)
	r.Post("/api/public/popups/{key}/submit", d.PublicPopupSubmit)
	r.Post("/api/public/ecommerce/shopify/webhook", d.ShopifyWebhook)
}

func (d *Deps) Summary(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.Summary(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListGroups(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListGroups(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateGroup(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in GroupInput
	if !decode(w, r, &in) {
		return
	}
	in.Category = strings.TrimSpace(in.Category)
	in.Name = strings.TrimSpace(in.Name)
	in.Type = defaulted(strings.ToLower(strings.TrimSpace(in.Type)), "checkbox")
	if in.Category == "" || in.Name == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "category and name are required"))
		return
	}
	if !oneOf(in.Type, "checkbox", "radio", "dropdown", "hidden") {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "type must be checkbox, radio, dropdown, or hidden"))
		return
	}
	out, err := d.Repo.CreateGroup(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListAssets(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListAssets(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateAsset(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in AssetInput
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.AssetType = defaulted(strings.ToLower(strings.TrimSpace(in.AssetType)), "image")
	in.URL = strings.TrimSpace(in.URL)
	if in.Name == "" || in.URL == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "name and url are required"))
		return
	}
	if _, err := url.ParseRequestURI(in.URL); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "url must be valid"))
		return
	}
	if !oneOf(in.AssetType, "image", "file", "video", "product") {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "invalid asset_type"))
		return
	}
	out, err := d.Repo.CreateAsset(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListSections(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListSections(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateSection(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SectionInput
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Category = defaulted(strings.TrimSpace(in.Category), "general")
	if in.Name == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "name is required"))
		return
	}
	if len(in.Blocks) == 0 && strings.TrimSpace(in.HTML) == "" && strings.TrimSpace(in.MJML) == "" {
		in.Blocks = []map[string]any{{"type": "text", "content": "Reusable content section"}}
	}
	out, err := d.Repo.CreateSection(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) CampaignReport(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.CampaignReport(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RecordCampaignEvent(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ReportEventInput
	if !decode(w, r, &in) {
		return
	}
	in.EventType = strings.ToLower(strings.TrimSpace(in.EventType))
	if !oneOf(in.EventType, "sent", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "conversion") {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "invalid event_type"))
		return
	}
	in.SubscriberEmail = strings.TrimSpace(strings.ToLower(in.SubscriberEmail))
	if in.SubscriberEmail != "" {
		if _, err := mail.ParseAddress(in.SubscriberEmail); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "subscriber_email must be valid"))
			return
		}
	}
	in.IP = strings.TrimSpace(in.IP)
	if in.IP != "" && net.ParseIP(in.IP) == nil {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "ip must be valid"))
		return
	}
	if err := d.Repo.RecordCampaignEvent(r.Context(), tenant.ID, chi.URLParam(r, "id"), in); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (d *Deps) ListJourneys(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListJourneys(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateJourney(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in JourneyInput
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Status = defaulted(strings.ToLower(strings.TrimSpace(in.Status)), "draft")
	if in.Name == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "name is required"))
		return
	}
	if !oneOf(in.Status, "draft", "active", "paused", "archived") {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "invalid status"))
		return
	}
	if len(in.Triggers) == 0 {
		in.Triggers = []map[string]any{{"type": "tag_added", "tag": "welcome"}}
	}
	if len(in.Nodes) == 0 {
		in.Nodes = []map[string]any{
			{"id": "entry", "type": "trigger"},
			{"id": "wait-1d", "type": "wait", "duration_seconds": 86400},
			{"id": "send-welcome", "type": "send_email", "subject": "Welcome"},
		}
	}
	if len(in.Edges) == 0 {
		in.Edges = []map[string]any{{"from": "entry", "to": "wait-1d"}, {"from": "wait-1d", "to": "send-welcome"}}
	}
	if !d.checkLimit(w, r, tenant.ID, limits.ResourceAutomations) {
		return
	}
	out, err := d.Repo.CreateJourney(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) PauseJourney(w http.ResponseWriter, r *http.Request) {
	d.setJourneyStatus(w, r, "paused")
}
func (d *Deps) ResumeJourney(w http.ResponseWriter, r *http.Request) {
	d.setJourneyStatus(w, r, "active")
}

func (d *Deps) setJourneyStatus(w http.ResponseWriter, r *http.Request, status string) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.SetJourneyStatus(r.Context(), tenant.ID, chi.URLParam(r, "id"), status)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "journey not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListLandingPages(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListLandingPages(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateLandingPage(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in LandingPageInput
	if !decode(w, r, &in) {
		return
	}
	in.Slug = slugify(in.Slug)
	in.Name = strings.TrimSpace(in.Name)
	in.Status = defaulted(strings.ToLower(strings.TrimSpace(in.Status)), "draft")
	in.Template = defaulted(strings.TrimSpace(in.Template), "signup")
	if in.Slug == "" || in.Name == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "slug and name are required"))
		return
	}
	if !oneOf(in.Status, "draft", "published", "archived") {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "invalid status"))
		return
	}
	if len(in.Blocks) == 0 {
		in.Blocks = []map[string]any{
			{"type": "hero", "heading": in.Name, "body": "Join the list for updates."},
			{"type": "signup_form", "button": "Subscribe"},
		}
	}
	if d.Limits != nil {
		exists, err := d.Repo.LandingPageExists(r.Context(), tenant.ID, in.Slug)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if !exists && !d.checkLimit(w, r, tenant.ID, limits.ResourceLandingPages) {
			return
		}
	}
	out, err := d.Repo.CreateLandingPage(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) PublicLandingPage(w http.ResponseWriter, r *http.Request) {
	out, err := d.Repo.PublicLandingPage(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "landing page not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// LAND-037: A/B variant selection. Pick a weighted variant for this page;
	// when one is chosen, serve ITS blocks and stamp variant_id so the renderer
	// can echo it back on conversion. No variants → serve the control (the page
	// itself) exactly as before. Best-effort: a pick failure never blocks serve.
	variantID := ""
	if pick, perr := d.Repo.PickLandingVariant(r.Context(), chi.URLParam(r, "slug"), out.ID, mathrandv2.Int()); perr == nil && pick != nil {
		out.Blocks = pick.Blocks
		variantID = pick.VariantID
		// Expose only a signed, page-bound token — never the raw arm id — so a
		// client cannot harvest arm ids or forge/re-point a conversion.
		out.VariantToken = signVariantToken(d.LandingVariantSignKey, out.ID, variantID, time.Now())
	}
	_ = d.Repo.RecordLandingEvent(r.Context(), tenantIDFromLanding(out), out.ID, "view", "", variantID, map[string]any{"user_agent": r.UserAgent()})
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PublicLandingConvert(w http.ResponseWriter, r *http.Request) {
	out, err := d.Repo.PublicLandingPage(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "landing page not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var body struct {
		Email    string         `json:"email"`
		Metadata map[string]any `json:"metadata"`
		// VariantToken is the opaque signed token the serve response handed the
		// renderer (LAND-037); echoing it attributes the conversion to the arm
		// actually served. A missing/invalid/expired token → unattributed
		// (never an error), so a malformed echo can't poison or 500 the endpoint.
		VariantToken string `json:"variant_token"`
		// Website is the honeypot, named and handled exactly as the public form
		// surface names and handles it (internal/forms). This endpoint had no
		// bot friction at all, so every probe of it wrote a real unconfirmed
		// subscriber row plus a conversion event.
		Website string `json:"website"`
	}
	if !decode(w, r, &body) {
		return
	}
	// Honeypot — silent success. A real visitor never sees the field, so a
	// filled one is automation; answering with the ordinary acceptance envelope
	// tells the script nothing while writing nothing.
	if strings.TrimSpace(body.Website) != "" {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
		return
	}
	body.Email = strings.TrimSpace(strings.ToLower(body.Email))
	if body.Email == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "email is required"))
		return
	}
	if _, err := mail.ParseAddress(body.Email); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "email must be valid"))
		return
	}
	tenantID := tenantIDFromLanding(out)
	if d.Subscribers == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("subscriber_store_unavailable", "subscription service unavailable"))
		return
	}
	if _, err := d.Subscribers.Upsert(r.Context(), tenantID, subscribers.CreateInput{
		Email:                body.Email,
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		SourcePlatform:       "postwave",
		SignupSource:         subscribers.SignupSourceLandingPage,
	}); err != nil {
		if errors.Is(err, subscribers.ErrErasureBlocked) {
			// Answer exactly as a successful conversion does. A distinct 409
			// `erasure_blocked` told an anonymous caller that this specific
			// address had exercised a right-to-erasure against this specific
			// brand — a privacy fact the tenant is obliged to protect, readable
			// at one probe per address from any published landing-page slug.
			// The refusal is recorded for the operator instead; no conversion
			// event is written, because no conversion happened.
			if d.Logger != nil {
				d.Logger.Info("landing conversion refused for an erased address",
					"tenant_id", tenantID, "landing_page_id", out.ID)
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	// Recover the served arm from the signed token (page-bound + TTL). An
	// absent/forged/expired token yields "" → an honest unattributed conversion.
	convVariantID, _ := verifyVariantToken(d.LandingVariantSignKey, body.VariantToken, out.ID, time.Now())
	if err := d.Repo.RecordLandingEvent(r.Context(), tenantID, out.ID, "conversion", body.Email, convVariantID, body.Metadata); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

func (d *Deps) PublicPopupOptions(w http.ResponseWriter, r *http.Request) {
	setPublicPopupCORS(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListPopups(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListPopups(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreatePopup(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in PopupInput
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Status = defaulted(strings.ToLower(strings.TrimSpace(in.Status)), "draft")
	if in.Name == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "name is required"))
		return
	}
	if !oneOf(in.Status, "draft", "published", "paused", "archived") {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "invalid status"))
		return
	}
	if len(in.Blocks) == 0 {
		in.Blocks = []map[string]any{{"type": "email_capture", "headline": "Stay in the loop"}}
	}
	if !d.checkLimit(w, r, tenant.ID, limits.ResourcePopupForms) {
		return
	}
	out, err := d.Repo.CreatePopup(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListCommerceIntegrations(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListCommerceIntegrations(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateCommerceIntegration(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CommerceIntegrationInput
	if !decode(w, r, &in) {
		return
	}
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	in.ShopDomain = strings.TrimSpace(strings.ToLower(in.ShopDomain))
	in.Status = defaulted(strings.ToLower(strings.TrimSpace(in.Status)), "connected")
	if !oneOf(in.Provider, "shopify", "woocommerce", "stripe", "square") {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "provider must be shopify, woocommerce, stripe, or square"))
		return
	}
	if !oneOf(in.Status, "connected", "needs_auth", "syncing", "paused", "error") {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "invalid status"))
		return
	}
	if in.Scopes == nil {
		in.Scopes = []string{}
	}
	in.Settings = nonNilMap(in.Settings)
	if d.Limits != nil {
		exists, err := d.Repo.CommerceIntegrationExists(r.Context(), tenant.ID, in.Provider, in.ShopDomain)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if !exists && !d.checkLimit(w, r, tenant.ID, limits.ResourceEcommerceIntegrations) {
			return
		}
	}
	out, err := d.Repo.CreateCommerceIntegration(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) SyncDemoCommerce(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.SyncDemoCommerce(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "integration not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

func tenant(r *http.Request) (*middleware.Tenant, bool) {
	return middleware.TenantFromContext(r.Context())
}

func (d *Deps) checkLimit(w http.ResponseWriter, r *http.Request, tenantID string, resource limits.Resource) bool {
	if d == nil || d.Limits == nil {
		return true
	}
	if err := d.Limits.Check(r.Context(), tenantID, resource, 1); err != nil {
		if limits.WriteExceeded(w, err) {
			return false
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return false
	}
	return true
}

func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	if err := httpbody.DecodeJSON(w, r, compatJSONMaxBodyBytes, out); err != nil {
		code := httpbody.ErrorCode(err)
		writeJSON(w, httpbody.StatusCode(err), errEnv(code, httpbody.PublicMessage(err)))
		return false
	}
	return true
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func oneOf(value string, allowed ...string) bool {
	for _, item := range allowed {
		if value == item {
			return true
		}
	}
	return false
}

func slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	lastDash := false
	for _, r := range value {
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
	return strings.Trim(b.String(), "-")
}

func tenantIDFromLanding(lp *LandingPage) string {
	if lp == nil {
		return ""
	}
	return lp.TenantID
}

func publicTenantSlug(r *http.Request) string {
	for _, value := range []string{
		r.URL.Query().Get("tenant"),
		r.URL.Query().Get("tenant_slug"),
		r.Header.Get("X-Tenant-Slug"),
	} {
		if slug := strings.TrimSpace(value); slug != "" {
			return slug
		}
	}
	return ""
}

func publicRequestMetadata(r *http.Request) map[string]any {
	return map[string]any{
		"user_agent": r.UserAgent(),
		"referrer":   r.Header.Get("Referer"),
	}
}

func setPublicPopupCORS(w http.ResponseWriter, r *http.Request) {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
