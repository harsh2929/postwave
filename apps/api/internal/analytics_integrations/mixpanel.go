// SPDX-License-Identifier: AGPL-3.0-only
//
// mixpanel.go — native Mixpanel outbound puller (Engage / user profiles).
//
// Mixpanel profiles enrich Moosewave subscribers with product-analytics traits.
// POST /api/query/engage, HTTP Basic (service-account user:secret or project API
// secret) + project_id query param, session_id/page pagination. Maps profiles ->
// canonical ProfileInput via providerPull. Mirrors the PostHog/Triple Whale
// outbound pattern added to this package.
package analytics_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	mixpanelDefaultAPIBaseURL = "https://mixpanel.com"
	mixpanelCursorPrefix      = "mixpanel:"
	mixpanelCursorComplete    = "mixpanel:complete"
)

type MixpanelCredentials struct {
	Username   string
	Secret     string
	APISecret  string
	ProjectID  string
	APIBaseURL string
	UserAgent  string
}

type MixpanelCredentialResolver interface {
	ResolveMixpanel(ctx context.Context, tenantID string, integration Integration) (MixpanelCredentials, error)
}

type mixpanelCredentialPayload struct {
	Username   string `json:"username"`
	Secret     string `json:"secret"`
	APISecret  string `json:"api_secret"`
	ProjectID  string `json:"project_id"`
	Region     string `json:"region"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p mixpanelCredentialPayload) credentials() (MixpanelCredentials, error) {
	creds := MixpanelCredentials{
		Username:   strings.TrimSpace(p.Username),
		Secret:     strings.TrimSpace(p.Secret),
		APISecret:  strings.TrimSpace(p.APISecret),
		ProjectID:  strings.TrimSpace(p.ProjectID),
		APIBaseURL: strings.TrimRight(strings.TrimSpace(firstString(p.APIBaseURL, mixpanelRegionURL(p.Region))), "/"),
		UserAgent:  strings.TrimSpace(p.UserAgent),
	}
	if creds.APISecret == "" && (creds.Username == "" || creds.Secret == "") {
		return MixpanelCredentials{}, fmt.Errorf("mixpanel profile reads require a service-account username+secret or an api_secret; public project tokens cannot read profiles")
	}
	return creds, nil
}

func mixpanelRegionURL(region string) string {
	switch strings.ToLower(strings.TrimSpace(region)) {
	case "eu":
		return "https://eu.mixpanel.com"
	case "in":
		return "https://in.mixpanel.com"
	default:
		return ""
	}
}

type MixpanelSecretsCredentialResolver struct {
	Secrets AnalyticsPullerSecretResolver
}

func (r MixpanelSecretsCredentialResolver) ResolveMixpanel(ctx context.Context, _ string, integration Integration) (MixpanelCredentials, error) {
	if r.Secrets == nil {
		return MixpanelCredentials{}, fmt.Errorf("mixpanel credential resolver is not configured")
	}
	ref := analyticsCredentialRef(integration)
	if ref == "" {
		return MixpanelCredentials{}, fmt.Errorf("mixpanel credentials_ref is required")
	}
	var payload mixpanelCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withMixpanelDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return MixpanelCredentials{}, fmt.Errorf("resolve mixpanel credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withMixpanelDefaults(creds, integration), nil
			}
		}
	}
	return MixpanelCredentials{}, fmt.Errorf("mixpanel requires a JSON secret with service-account or api_secret credentials")
}

func withMixpanelDefaults(creds MixpanelCredentials, integration Integration) MixpanelCredentials {
	if creds.ProjectID == "" {
		creds.ProjectID = strings.TrimSpace(settingString(integration.Settings, "project_id"))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(firstString(settingString(integration.Settings, "api_base_url"), mixpanelRegionURL(settingString(integration.Settings, "region")))), "/")
	}
	return creds
}

type MixpanelRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials MixpanelCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type mixpanelProfile struct {
	DistinctID analyticsProfileID `json:"$distinct_id"`
	Properties map[string]any     `json:"$properties"`
}

type mixpanelEngageResponse struct {
	Results   []mixpanelProfile `json:"results"`
	SessionID string            `json:"session_id"`
	Page      int               `json:"page"`
	PageSize  int               `json:"page_size"`
	Total     int               `json:"total"`
	Status    string            `json:"status"`
	Error     string            `json:"error"`
}

func (b MixpanelRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderMixpanel {
		return SyncRequest{}, fmt.Errorf("mixpanel backfill requires a Mixpanel integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("mixpanel credential resolver is not configured")
	}
	session, page, done := mixpanelDecodeCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: mixpanelCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveMixpanel(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.ProjectID == "" {
		return SyncRequest{}, fmt.Errorf("mixpanel project_id is required")
	}
	client := analyticsEgressClient(b.HTTPClient, ProviderMixpanel, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), mixpanelDefaultAPIBaseURL)
	q := url.Values{}
	q.Set("project_id", creds.ProjectID)
	form := url.Values{}
	form.Set("page", strconv.Itoa(page))
	if session != "" {
		form.Set("session_id", session)
	}
	fullURL := strings.TrimRight(baseURL, "/") + "/api/query/engage?" + q.Encode()
	headers := map[string]string{
		"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(mixpanelBasicUser(creds))),
		"Content-Type":  "application/x-www-form-urlencoded",
	}

	var out mixpanelEngageResponse
	if err := analyticsDoJSON(ctx, client, http.MethodPost, fullURL, headers, strings.NewReader(form.Encode()), firstString(b.UserAgent, creds.UserAgent, analyticsDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	if out.Error != "" || (out.Status != "" && out.Status != "ok") {
		return SyncRequest{}, fmt.Errorf("mixpanel profile query was rejected")
	}
	if out.Results == nil || (len(out.Results) > 0 && out.PageSize <= 0) {
		return SyncRequest{}, fmt.Errorf("mixpanel profile query returned incomplete result metadata")
	}
	if out.Page != page {
		return SyncRequest{}, fmt.Errorf("mixpanel profile query returned a different page than requested")
	}
	profiles := make([]ProfileInput, 0, len(out.Results))
	for _, prof := range out.Results {
		if mapped, ok := mapMixpanelProfile(prof); ok {
			profiles = append(profiles, mapped)
		}
	}
	nextCursor := mixpanelCursorComplete
	// The documented continuation rule is a full result page, not `total`,
	// which may describe only the current payload or be omitted.
	if out.PageSize > 0 && len(out.Results) >= out.PageSize {
		nextSession := firstString(out.SessionID, session)
		if nextSession == "" || page == int(^uint(0)>>1) {
			return SyncRequest{}, fmt.Errorf("mixpanel full result page has no usable continuation")
		}
		nextCursor = mixpanelEncodeCursor(nextSession, page+1)
	}
	return SyncRequest{RunMode: "backfill", Profiles: profiles, Cursor: nextCursor}, nil
}

func mixpanelBasicUser(creds MixpanelCredentials) string {
	if creds.Username != "" && creds.Secret != "" {
		return creds.Username + ":" + creds.Secret
	}
	// Project API secret: secret as username, blank password.
	return creds.APISecret + ":"
}

func mapMixpanelProfile(p mixpanelProfile) (ProfileInput, bool) {
	email := strings.ToLower(strings.TrimSpace(analyticsPropString(p.Properties, "$email")))
	if email == "" {
		return ProfileInput{}, false
	}
	return ProfileInput{
		SourceID:  "mixpanel://profile/" + strings.TrimSpace(string(p.DistinctID)),
		Email:     email,
		UserID:    strings.TrimSpace(string(p.DistinctID)),
		FirstName: analyticsPropString(p.Properties, "$first_name"),
		LastName:  analyticsPropString(p.Properties, "$last_name"),
		FullName:  analyticsPropString(p.Properties, "$name"),
		Phone:     analyticsPropString(p.Properties, "$phone"),
		Traits:    p.Properties,
	}, true
}

func mixpanelDecodeCursor(cursor string) (session string, page int, done bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == mixpanelCursorComplete {
		return "", 0, true
	}
	if cursor == "" {
		return "", 0, false
	}
	body := strings.TrimPrefix(cursor, mixpanelCursorPrefix)
	sess, pageStr, ok := strings.Cut(body, "|")
	if !ok {
		return "", 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(pageStr))
	if err != nil || n < 0 {
		n = 0
	}
	return strings.TrimSpace(sess), n, false
}

func mixpanelEncodeCursor(session string, page int) string {
	return mixpanelCursorPrefix + strings.TrimSpace(session) + "|" + strconv.Itoa(page)
}
