// SPDX-License-Identifier: AGPL-3.0-only
//
// posthog.go — native PostHog outbound puller.
//
// PostHog is a high-demand product-analytics tool; pulling persons complements
// the Segment/RudderStack inbound CDP ingest. This is the FIRST outbound puller
// in this package, so it brings a small shared helper set (errAnalyticsNotJSONSecret,
// analyticsDoJSON). Personal API key (bearer), /api/projects/{id}/persons with a
// next-URL cursor; maps persons -> canonical ProfileInput via providerPull.
package analytics_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	postHogDefaultAPIBaseURL  = "https://app.posthog.com"
	analyticsDefaultUserAgent = "Moosewave Analytics Integration"
	analyticsResponseMaxBytes = 16 << 20
	analyticsDefaultPageSize  = 100
	postHogCursorPrefix       = "posthog:"
	postHogCursorComplete     = "posthog:complete"
)

var errAnalyticsNotJSONSecret = errors.New("analytics_integrations: secret is not JSON")

// AnalyticsPullerSecretResolver is the trusted secrets backend for outbound
// analytics pullers (PostHog, Triple Whale).
type AnalyticsPullerSecretResolver interface {
	Get(ctx context.Context, ref string) (string, error)
	GetJSON(ctx context.Context, ref string, out any) error
}

type PostHogCredentials struct {
	APIKey     string
	ProjectID  string
	APIBaseURL string
	UserAgent  string
}

type PostHogCredentialResolver interface {
	ResolvePostHog(ctx context.Context, tenantID string, integration Integration) (PostHogCredentials, error)
}

type postHogCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	ProjectID  string `json:"project_id"`
	APIBaseURL string `json:"api_base_url"`
	Host       string `json:"host"`
	UserAgent  string `json:"user_agent"`
}

func (p postHogCredentialPayload) credentials() (PostHogCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return PostHogCredentials{}, fmt.Errorf("posthog api_key (personal API key) is required")
	}
	return PostHogCredentials{APIKey: key, ProjectID: strings.TrimSpace(p.ProjectID), APIBaseURL: strings.TrimRight(strings.TrimSpace(firstString(p.APIBaseURL, p.Host)), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type PostHogSecretsCredentialResolver struct {
	Secrets AnalyticsPullerSecretResolver
}

func (r PostHogSecretsCredentialResolver) ResolvePostHog(ctx context.Context, _ string, integration Integration) (PostHogCredentials, error) {
	if r.Secrets == nil {
		return PostHogCredentials{}, fmt.Errorf("posthog credential resolver is not configured")
	}
	ref := analyticsCredentialRef(integration)
	if ref == "" {
		return PostHogCredentials{}, fmt.Errorf("posthog credentials_ref is required")
	}
	var payload postHogCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withPostHogDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return PostHogCredentials{}, fmt.Errorf("resolve posthog credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withPostHogDefaults(creds, integration), nil
			}
		}
	}
	creds, err := postHogCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return PostHogCredentials{}, err
	}
	return withPostHogDefaults(creds, integration), nil
}

func withPostHogDefaults(creds PostHogCredentials, integration Integration) PostHogCredentials {
	if creds.ProjectID == "" {
		creds.ProjectID = strings.TrimSpace(settingString(integration.Settings, "project_id"))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(firstString(settingString(integration.Settings, "api_base_url"), settingString(integration.Settings, "host"))), "/")
	}
	return creds
}

type PostHogRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials PostHogCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type postHogPerson struct {
	// Current cloud responses use UUID strings; older responses may use an
	// integer PK. Prefer the explicit stable uuid when it is present.
	ID          analyticsProfileID `json:"id"`
	UUID        string             `json:"uuid"`
	DistinctIDs []string           `json:"distinct_ids"`
	Properties  map[string]any     `json:"properties"`
}

type postHogPersonsResponse struct {
	Results []postHogPerson `json:"results"`
	Next    string          `json:"next"`
}

type AnalyticsRESTError struct {
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e AnalyticsRESTError) Error() string {
	msg := fmt.Sprintf("analytics REST failed %d", e.StatusCode)
	if e.RetryAfter > 0 {
		msg += "; retry after " + e.RetryAfter.String()
	}
	if strings.TrimSpace(e.Snippet) != "" {
		msg += ": " + strings.TrimSpace(e.Snippet)
	}
	return msg
}

func (b PostHogRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderPostHog {
		return SyncRequest{}, fmt.Errorf("posthog backfill requires a PostHog integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("posthog credential resolver is not configured")
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == postHogCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: postHogCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolvePostHog(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.ProjectID == "" {
		return SyncRequest{}, fmt.Errorf("posthog project_id is required")
	}
	client := analyticsEgressClient(b.HTTPClient, ProviderPostHog, 30*time.Second)
	// A cursor carries the full next-page URL PostHog returned; otherwise build
	// the first page URL from the host + project.
	var requestURL string
	if strings.HasPrefix(cursor, postHogCursorPrefix) {
		requestURL = strings.TrimPrefix(cursor, postHogCursorPrefix)
	} else {
		baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), postHogDefaultAPIBaseURL)
		q := url.Values{}
		q.Set("limit", strconv.Itoa(analyticsPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
		requestURL = strings.TrimRight(baseURL, "/") + "/api/projects/" + url.PathEscape(creds.ProjectID) + "/persons/?" + q.Encode()
	}

	var out postHogPersonsResponse
	headers := map[string]string{"Authorization": "Bearer " + strings.TrimSpace(creds.APIKey)}
	if err := analyticsDoJSON(ctx, client, http.MethodGet, requestURL, headers, nil, firstString(b.UserAgent, creds.UserAgent, analyticsDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	profiles := make([]ProfileInput, 0, len(out.Results))
	for _, person := range out.Results {
		if mapped, ok := mapPostHogPerson(person); ok {
			profiles = append(profiles, mapped)
		}
	}
	nextCursor := postHogCursorComplete
	if strings.TrimSpace(out.Next) != "" {
		nextCursor = postHogCursorPrefix + strings.TrimSpace(out.Next)
	}
	return SyncRequest{RunMode: "backfill", Profiles: profiles, Cursor: nextCursor}, nil
}

func mapPostHogPerson(person postHogPerson) (ProfileInput, bool) {
	email := strings.ToLower(strings.TrimSpace(analyticsPropString(person.Properties, "email")))
	if email == "" {
		return ProfileInput{}, false
	}
	userID := ""
	if len(person.DistinctIDs) > 0 {
		userID = strings.TrimSpace(person.DistinctIDs[0])
	}
	sourceKey := strings.TrimSpace(person.UUID)
	if sourceKey == "" {
		sourceKey = strings.TrimSpace(person.ID.String())
	}
	return ProfileInput{
		SourceID:  "posthog://person/" + sourceKey,
		Email:     email,
		UserID:    userID,
		FirstName: analyticsPropString(person.Properties, "first_name"),
		LastName:  analyticsPropString(person.Properties, "last_name"),
		FullName:  analyticsPropString(person.Properties, "name"),
		Phone:     analyticsPropString(person.Properties, "phone"),
		Traits:    person.Properties,
	}, true
}

// ---- shared analytics-puller helpers ----

func analyticsCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
}

func analyticsPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return analyticsDefaultPageSize
	}
	if n > 500 {
		return 500
	}
	return n
}

func analyticsPropString(props map[string]any, key string) string {
	if props == nil {
		return ""
	}
	if v, ok := props[key]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

func analyticsDoJSON(ctx context.Context, client *http.Client, method, fullURL string, headers map[string]string, body io.Reader, userAgent string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, analyticsResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return AnalyticsRESTError{
			StatusCode: resp.StatusCode,
			RetryAfter: analyticsRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    analyticsTruncate(string(raw), 500),
		}
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode analytics response: %w", err)
	}
	return nil
}

func analyticsRetryAfter(raw string) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(raw); err == nil {
		delay := time.Until(at)
		if delay > 0 {
			return delay
		}
	}
	return 0
}

func analyticsTruncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
