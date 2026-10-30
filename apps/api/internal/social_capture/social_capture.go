package social_capture

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
	"github.com/postwave/postwave/apps/api/internal/sms"
)

type Deps struct {
	Repo       *Repo
	SMS        *sms.Store
	PublicBase string
	Logger     *slog.Logger
	// TikTokSecret is the TikTok app client secret used to verify inbound
	// webhook signatures (POSTWAVE_TIKTOK_CLIENT_SECRET). Empty disables the
	// TikTok event endpoint (it rejects every delivery as unconfigured).
	TikTokSecret string
}

type AutoReplyRule struct {
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	Name             string         `json:"name"`
	Network          string         `json:"network"`
	Status           string         `json:"status"`
	TriggerPhrases   []string       `json:"trigger_phrases"`
	Questions        []Question     `json:"questions,omitempty"`
	PropertyMappings map[string]any `json:"property_mappings,omitempty"`
	TargetListID     string         `json:"target_list_id,omitempty"`
	TargetSegmentID  string         `json:"target_segment_id,omitempty"`
	SMSListID        string         `json:"sms_list_id,omitempty"`
	SenderProfileID  string         `json:"sender_profile_id,omitempty"`
	ReplyTemplate    string         `json:"reply_template,omitempty"`
	ConsentHandoff   map[string]any `json:"consent_handoff,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
	UpdatedAt        time.Time      `json:"updated_at,omitempty"`
}

type Question struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Required bool   `json:"required"`
}

type LeadCapture struct {
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	RuleID           string         `json:"rule_id,omitempty"`
	Network          string         `json:"network"`
	ExternalUserID   string         `json:"external_user_id,omitempty"`
	ExternalThreadID string         `json:"external_thread_id,omitempty"`
	SubscriberEmail  string         `json:"subscriber_email,omitempty"`
	PhoneE164        string         `json:"phone_e164,omitempty"`
	Answers          map[string]any `json:"answers,omitempty"`
	MappedProperties map[string]any `json:"mapped_properties,omitempty"`
	Status           string         `json:"status"`
	Metadata         map[string]any `json:"metadata,omitempty"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
}

type TapToTextLink struct {
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	Slug             string         `json:"slug,omitempty"`
	Name             string         `json:"name"`
	Status           string         `json:"status"`
	SMSListID        string         `json:"sms_list_id,omitempty"`
	SenderProfileID  string         `json:"sender_profile_id,omitempty"`
	DestinationPhone string         `json:"destination_phone"`
	Keyword          string         `json:"keyword"`
	MessageBody      string         `json:"message_body"`
	ConsentText      string         `json:"consent_text,omitempty"`
	SuccessURL       string         `json:"success_url,omitempty"`
	ProofMetadata    map[string]any `json:"proof_metadata,omitempty"`
	Stats            map[string]any `json:"stats,omitempty"`
	SMSURI           string         `json:"sms_uri,omitempty"`
	PublicURL        string         `json:"public_url,omitempty"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
	UpdatedAt        time.Time      `json:"updated_at,omitempty"`
}

type EventInput struct {
	Network          string         `json:"network"`
	ExternalUserID   string         `json:"external_user_id"`
	ExternalThreadID string         `json:"external_thread_id"`
	SubscriberEmail  string         `json:"subscriber_email"`
	PhoneE164        string         `json:"phone_e164"`
	Answers          map[string]any `json:"answers"`
	Metadata         map[string]any `json:"metadata"`
}

type ConsentInput struct {
	PhoneE164       string         `json:"phone_e164"`
	SubscriberEmail string         `json:"subscriber_email"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

type ValidationResult struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

var ErrNotFound = errors.New("social_capture: not found")

// A tap redirect proves navigation, not phone possession or an affirmative
// purpose-bound consent act. The current positive-consent writer also spans
// two transactions. Keep it structurally held until verified evidence and the
// immutable tap event can commit atomically/idempotently with SMS consent.
const tapToTextConsentReleaseReady = false

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadSubscribers)
	write := apikeys.RequireScope(apikeys.ScopeWriteSubscribers)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/social-capture/catalog", d.Catalog)
	r.With(admin).Post("/api/v1/social-capture/validate", d.Validate)
	r.With(read).Get("/api/v1/social-capture/auto-replies", d.ListRules)
	r.With(admin).Post("/api/v1/social-capture/auto-replies", d.CreateRule)
	r.With(read).Get("/api/v1/social-capture/auto-replies/{id}", d.GetRule)
	r.With(write).Post("/api/v1/social-capture/auto-replies/{id}/events", d.RecordRuleEvent)
	// TikTok inbound events: raw TikTok webhook payload, signature-verified.
	r.With(write).Post("/api/v1/social-capture/auto-replies/{id}/tiktok-events", d.RecordTikTokEvent)
	r.With(read).Get("/api/v1/social-capture/leads", d.ListLeads)
	r.With(read).Get("/api/v1/social-capture/tap-to-text", d.ListTapLinks)
	r.With(admin).Post("/api/v1/social-capture/tap-to-text", d.CreateTapLink)
	r.With(read).Get("/api/v1/social-capture/tap-to-text/{id}", d.GetTapLink)
	r.With(write).Post("/api/v1/social-capture/tap-to-text/{id}/consent", d.RecordTapConsent)
}

func (d *Deps) MountPublicRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/api/public/tap-to-text/{slug}", d.PublicTapRedirect)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": "klv02.social_capture.v1",
		"networks": []map[string]string{
			{"key": "instagram", "label": "Instagram", "runtime_status": "foundation"},
			{"key": "facebook", "label": "Facebook", "runtime_status": "foundation"},
			{"key": "tiktok", "label": "TikTok", "runtime_status": "foundation"},
			{"key": "generic", "label": "Generic social webhook", "runtime_status": "foundation"},
		},
		"rule_fields": []string{"trigger_phrases", "questions", "property_mappings", "target_list_id", "target_segment_id", "sms_list_id", "consent_handoff"},
		"tap_to_text": map[string]any{
			"runtime_status": "consent_capture_release_held",
			"uri_scheme":     "sms:",
			"consent_source": "form",
		},
	})
}

func (d *Deps) Validate(w http.ResponseWriter, r *http.Request) {
	var in AutoReplyRule
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	writeJSON(w, http.StatusOK, ValidateRule(in))
}

func (d *Deps) ListRules(w http.ResponseWriter, r *http.Request) {
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
	out, next, err := d.Repo.ListRules(r.Context(), tenantID, r.URL.Query().Get("status"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, pagination.Envelope[AutoReplyRule]{Items: out, NextCursor: next})
}

func (d *Deps) CreateRule(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in AutoReplyRule
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if validation := ValidateRule(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.CreateRule(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetRule(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetRule(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err, tenantID)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RecordRuleEvent(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in EventInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.RecordLead(r.Context(), tenantID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoError(w, r, err, tenantID)
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

func (d *Deps) ListLeads(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 500 so
	// omitting ?limit= returns the same count as before (no regression). MAX
	// stays 500 so the default isn't clamped below the prior behavior.
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 500, 500)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.Repo.ListLeads(r.Context(), tenantID, r.URL.Query().Get("rule_id"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, pagination.Envelope[LeadCapture]{Items: out, NextCursor: next})
}

func (d *Deps) ListTapLinks(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	// Pagination happens in the repo (before hydration); we hydrate the
	// returned page below.
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.Repo.ListTapLinks(r.Context(), tenantID, r.URL.Query().Get("status"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	for i := range out {
		hydrateTapLink(&out[i], d.publicBase())
	}
	writeJSON(w, http.StatusOK, pagination.Envelope[TapToTextLink]{Items: out, NextCursor: next})
}

func (d *Deps) CreateTapLink(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in TapToTextLink
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.CreateTapLink(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	hydrateTapLink(out, d.publicBase())
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetTapLink(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetTapLink(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err, tenantID)
		return
	}
	hydrateTapLink(out, d.publicBase())
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RecordTapConsent(w http.ResponseWriter, r *http.Request) {
	if !tapToTextConsentReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_tap_consent_release_held", "tap-to-text consent capture is unavailable until verified possession and atomic evidence recording are deployed"))
		return
	}
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ConsentInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	link, err := d.Repo.GetTapLink(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err, tenantID)
		return
	}
	if d.SMS == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_unavailable", "sms store is not configured"))
		return
	}
	if err := d.SMS.RecordConsent(r.Context(), tenantID, sms.ConsentInput{
		ListID:          link.SMSListID,
		PhoneE164:       in.PhoneE164,
		SubscriberEmail: in.SubscriberEmail,
		Action:          sms.ConsentGranted,
		Source:          "form",
		Provider:        sms.ConsentProviderProduct,
		ProofText:       defaulted(link.ConsentText, link.MessageBody),
		Metadata: map[string]any{
			"source":         "tap_to_text",
			"tap_to_text_id": link.ID,
			"evidence_type":  "tap_to_text",
			"evidence_id":    link.ID,
		},
	}); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	if err := d.Repo.RecordTapEvent(r.Context(), tenantID, link.ID, "consent", in.PhoneE164, in.SubscriberEmail, in.Metadata); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "consent_recorded"})
}

func (d *Deps) PublicTapRedirect(w http.ResponseWriter, r *http.Request) {
	link, err := d.Repo.GetPublicTapLink(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		return
	}
	_ = d.Repo.RecordTapEvent(r.Context(), link.TenantID, link.ID, "click", "", "", map[string]any{
		"user_agent": r.UserAgent(),
		"remote_ip":  r.RemoteAddr,
	})
	http.Redirect(w, r, SMSURI(*link), http.StatusFound)
}

func ValidateRule(in AutoReplyRule) ValidationResult {
	normalizeRule(&in)
	out := ValidationResult{Valid: true}
	if in.Name == "" {
		out.Errors = append(out.Errors, "name is required")
	}
	if !allowed(in.Network, []string{"instagram", "facebook", "tiktok", "generic"}) {
		out.Errors = append(out.Errors, "network must be instagram, facebook, tiktok, or generic")
	}
	if !allowed(in.Status, []string{"draft", "active", "paused", "archived"}) {
		out.Errors = append(out.Errors, "status must be draft, active, paused, or archived")
	}
	if len(in.TriggerPhrases) == 0 {
		out.Errors = append(out.Errors, "at least one trigger phrase is required")
	}
	for _, q := range in.Questions {
		if strings.TrimSpace(q.Key) == "" {
			out.Errors = append(out.Errors, "question key is required")
		}
	}
	if in.SMSListID == "" {
		out.Warnings = append(out.Warnings, "sms_list_id is missing; social answers will be captured without SMS consent handoff")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func SMSURI(link TapToTextLink) string {
	body := strings.TrimSpace(link.MessageBody)
	if body == "" {
		body = strings.TrimSpace(link.Keyword)
	}
	if body == "" {
		body = "START"
	}
	return "sms:" + strings.TrimSpace(link.DestinationPhone) + "?&body=" + url.QueryEscape(body)
}

func normalizeRule(in *AutoReplyRule) {
	in.Name = strings.TrimSpace(in.Name)
	in.Network = defaulted(strings.TrimSpace(strings.ToLower(in.Network)), "instagram")
	in.Status = defaulted(strings.TrimSpace(strings.ToLower(in.Status)), "draft")
	in.TriggerPhrases = normalizePhrases(in.TriggerPhrases)
	if in.PropertyMappings == nil {
		in.PropertyMappings = map[string]any{}
	}
	if in.ConsentHandoff == nil {
		in.ConsentHandoff = map[string]any{}
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeTapLink(in *TapToTextLink) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Slug = slugify(defaulted(in.Slug, in.Name))
	in.Status = defaulted(strings.TrimSpace(strings.ToLower(in.Status)), "draft")
	in.Keyword = strings.ToUpper(defaulted(strings.TrimSpace(in.Keyword), "START"))
	in.MessageBody = strings.TrimSpace(in.MessageBody)
	if in.MessageBody == "" {
		in.MessageBody = in.Keyword
	}
	in.ConsentText = strings.TrimSpace(in.ConsentText)
	in.DestinationPhone = strings.TrimSpace(in.DestinationPhone)
	if in.ProofMetadata == nil {
		in.ProofMetadata = map[string]any{}
	}
	if in.Stats == nil {
		in.Stats = map[string]any{}
	}
	if in.Name == "" {
		return fmt.Errorf("name is required")
	}
	if in.Slug == "" {
		return fmt.Errorf("slug is required")
	}
	if !allowed(in.Status, []string{"draft", "active", "paused", "archived"}) {
		return fmt.Errorf("status must be draft, active, paused, or archived")
	}
	if in.SMSListID == "" {
		return fmt.Errorf("sms_list_id is required")
	}
	if in.DestinationPhone == "" {
		return fmt.Errorf("destination_phone is required")
	}
	return nil
}

func hydrateTapLink(link *TapToTextLink, base string) {
	if link == nil {
		return
	}
	link.SMSURI = SMSURI(*link)
	if base != "" && link.Slug != "" {
		link.PublicURL = strings.TrimRight(base, "/") + "/api/public/tap-to-text/" + link.Slug
	}
}

func normalizePhrases(items []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, item := range items {
		item = strings.ToLower(strings.TrimSpace(item))
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

var slugRE = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = slugRE.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	if len(value) > 80 {
		value = strings.Trim(value[:80], "-")
	}
	return value
}

func allowed(value string, candidates []string) bool {
	for _, candidate := range candidates {
		if value == candidate {
			return true
		}
	}
	return false
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func (d *Deps) publicBase() string {
	if d == nil {
		return ""
	}
	return strings.TrimRight(d.PublicBase, "/")
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, err error, tenantID string) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "resource not found")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
