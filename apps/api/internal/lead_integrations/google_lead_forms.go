// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	googleLeadFormsCursorPrefix        = "google-lead-form-extensions:"
	googleLeadFormsCursorComplete      = "google-lead-form-extensions:complete"
	googleLeadFormsDefaultAPIBaseURL   = "https://googleads.googleapis.com/v24"
	googleLeadFormsResponseMaxBytes    = 8 << 20
	googleLeadFormsDefaultBatchLimit   = 1000
	googleLeadFormsMaxBatchLimit       = 1000
	googleLeadFormsDefaultUserAgent    = "Moosewave Google Lead Form Extensions Integration"
	googleLeadFormsSearchPathSuffix    = "/googleAds:search"
	googleLeadFormsSourceIDPrefix      = "google-lead-form-extensions://lead/"
	googleLeadFormsResourceFieldPrefix = "lead_form_submission_data."
)

var googleLeadFormsSearchFields = []string{
	"resource_name",
	"id",
	"asset",
	"campaign",
	"ad_group",
	"ad_group_ad",
	"gclid",
	"lead_form_submission_fields",
	"custom_lead_form_submission_fields",
	"submission_date_time",
}

type GoogleLeadFormsCredentials struct {
	AccessToken     string
	DeveloperToken  string
	LoginCustomerID string
	APIBaseURL      string
	UserAgent       string
}

type GoogleLeadFormsCredentialResolver interface {
	ResolveGoogleLeadForms(context.Context, string, Integration) (GoogleLeadFormsCredentials, error)
}

type GoogleLeadFormsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type GoogleLeadFormsRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials GoogleLeadFormsCredentialResolver
	APIBaseURL  string
	UserAgent   string
	BatchLimit  int
}

type GoogleLeadFormsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type GoogleLeadFormsSecretsCredentialResolver struct {
	Secrets GoogleLeadFormsRuntimeSecretResolver
}

func NewGoogleLeadFormsSecretsCredentialResolver(secrets GoogleLeadFormsRuntimeSecretResolver) *GoogleLeadFormsSecretsCredentialResolver {
	return &GoogleLeadFormsSecretsCredentialResolver{Secrets: secrets}
}

func (r *GoogleLeadFormsSecretsCredentialResolver) ResolveGoogleLeadForms(ctx context.Context, _ string, integration Integration) (GoogleLeadFormsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return GoogleLeadFormsCredentials{}, fmt.Errorf("google lead form extensions credential resolver is not configured")
	}
	ref := googleLeadFormsCredentialRef(integration)
	if ref == "" {
		return GoogleLeadFormsCredentials{}, fmt.Errorf("google lead form extensions credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return GoogleLeadFormsCredentials{}, err
	}
	return creds, nil
}

func (r *GoogleLeadFormsSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (GoogleLeadFormsCredentials, error) {
	var payload googleLeadFormsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return GoogleLeadFormsCredentials{}, fmt.Errorf("resolve google lead form extensions credentials %q: %w", ref, err)
		}
		return parseGoogleLeadFormsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return GoogleLeadFormsCredentials{}, fmt.Errorf("resolve google lead form extensions credentials %q: %w", ref, err)
	}
	return parseGoogleLeadFormsCredentialSecret(raw)
}

type googleLeadFormsCredentialPayload struct {
	AccessToken       string `json:"access_token"`
	Token             string `json:"token"`
	BearerToken       string `json:"bearer_token"`
	DeveloperToken    string `json:"developer_token"`
	LoginCustomerID   string `json:"login_customer_id"`
	ManagerCustomerID string `json:"manager_customer_id"`
	MCCCustomerID     string `json:"mcc_customer_id"`
	APIBaseURL        string `json:"api_base_url"`
	UserAgent         string `json:"user_agent"`
}

func (p googleLeadFormsCredentialPayload) credentials() (GoogleLeadFormsCredentials, error) {
	token := normalizeGoogleLeadFormsBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken))
	if token == "" {
		return GoogleLeadFormsCredentials{}, fmt.Errorf("google lead form extensions access_token is required")
	}
	developerToken := strings.TrimSpace(p.DeveloperToken)
	if developerToken == "" {
		return GoogleLeadFormsCredentials{}, fmt.Errorf("google lead form extensions developer_token is required")
	}
	return GoogleLeadFormsCredentials{
		AccessToken:     token,
		DeveloperToken:  developerToken,
		LoginCustomerID: normalizeGoogleLeadFormsCustomerID(firstString(p.LoginCustomerID, p.ManagerCustomerID, p.MCCCustomerID)),
		APIBaseURL:      strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:       strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseGoogleLeadFormsCredentialSecret(raw string) (GoogleLeadFormsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return GoogleLeadFormsCredentials{}, fmt.Errorf("google lead form extensions credentials are empty")
	}
	var payload googleLeadFormsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return GoogleLeadFormsCredentials{}, fmt.Errorf("parse google lead form extensions credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseGoogleLeadFormsKeyValueSecret(raw).credentials()
	}
	return googleLeadFormsCredentialPayload{AccessToken: normalizeGoogleLeadFormsBearerToken(raw)}.credentials()
}

func parseGoogleLeadFormsKeyValueSecret(raw string) googleLeadFormsCredentialPayload {
	var payload googleLeadFormsCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token":
			payload.AccessToken = value
		case "token":
			payload.Token = value
		case "bearer_token":
			payload.BearerToken = value
		case "developer_token":
			payload.DeveloperToken = value
		case "login_customer_id":
			payload.LoginCustomerID = value
		case "manager_customer_id":
			payload.ManagerCustomerID = value
		case "mcc_customer_id":
			payload.MCCCustomerID = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeGoogleLeadFormsBearerToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "bearer ") {
		return strings.TrimSpace(raw[len("bearer "):])
	}
	return raw
}

func googleLeadFormsCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b GoogleLeadFormsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderGoogleLeadForms {
		return SyncRequest{}, fmt.Errorf("google lead form extensions backfill requires a Google Lead Form Extensions integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("google lead form extensions credential resolver is not configured")
	}
	customerID := normalizeGoogleLeadFormsCustomerID(settingString(integration.Settings, "customer_id"))
	if customerID == "" {
		return SyncRequest{}, fmt.Errorf("google lead form extensions customer_id is required")
	}
	assetID := googleLeadFormsResourceID(settingString(integration.Settings, "lead_form_asset_id"))
	if assetID == "" {
		return SyncRequest{}, fmt.Errorf("google lead form extensions lead_form_asset_id is required")
	}
	creds, err := b.Credentials.ResolveGoogleLeadForms(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("google lead form extensions access token is required")
	}
	if strings.TrimSpace(creds.DeveloperToken) == "" {
		return SyncRequest{}, fmt.Errorf("google lead form extensions developer token is required")
	}
	state, err := decodeGoogleLeadFormsCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: googleLeadFormsCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderGoogleLeadForms, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, googleLeadFormsDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, googleLeadFormsDefaultUserAgent)
	loginCustomerID := normalizeGoogleLeadFormsCustomerID(firstString(
		creds.LoginCustomerID,
		settingString(integration.Settings, "login_customer_id"),
		settingString(integration.Settings, "manager_customer_id"),
		settingString(integration.Settings, "mcc_customer_id"),
	))
	batchLimit := googleLeadFormsBatchLimit(b.BatchLimit)
	campaignID := googleLeadFormsResourceID(settingString(integration.Settings, "campaign_id"))
	page, err := fetchGoogleLeadFormsSubmissions(ctx, client, baseURL, creds.AccessToken, creds.DeveloperToken, loginCustomerID, userAgent, customerID, assetID, campaignID, state, batchLimit)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(page.Results))}
	for _, result := range page.Results {
		item := result.LeadFormSubmissionData
		if !googleLeadFormsMatchesConfiguredForm(item, assetID, campaignID) {
			continue
		}
		submission := mapGoogleLeadFormsSubmission(item, integration, customerID, assetID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	req.Cursor = nextGoogleLeadFormsCursor(page, batchLimit)
	return req, nil
}

type googleLeadFormsCursorState struct {
	PageToken          string `json:"page_token,omitempty"`
	LastSubmissionTime string `json:"last_submission_time,omitempty"`
	LastID             string `json:"last_id,omitempty"`
	Complete           bool   `json:"complete,omitempty"`
}

func decodeGoogleLeadFormsCursor(cursor string) (googleLeadFormsCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return googleLeadFormsCursorState{}, nil
	}
	if cursor == googleLeadFormsCursorComplete {
		return googleLeadFormsCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, googleLeadFormsCursorPrefix) {
		return googleLeadFormsCursorState{}, fmt.Errorf("invalid Google Lead Form Extensions cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, googleLeadFormsCursorPrefix))
	if raw == "" {
		return googleLeadFormsCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return googleLeadFormsCursorState{}, fmt.Errorf("invalid Google Lead Form Extensions cursor")
	}
	var state googleLeadFormsCursorState
	if err := json.Unmarshal(decoded, &state); err != nil {
		state.PageToken = strings.TrimSpace(string(decoded))
	}
	return state, nil
}

func encodeGoogleLeadFormsPageCursor(pageToken string) string {
	pageToken = strings.TrimSpace(pageToken)
	if pageToken == "" {
		return googleLeadFormsCursorComplete
	}
	raw, _ := json.Marshal(googleLeadFormsCursorState{PageToken: pageToken})
	return googleLeadFormsCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func encodeGoogleLeadFormsWatermarkCursor(submissionTime, id string) string {
	submissionTime = strings.TrimSpace(submissionTime)
	id = strings.TrimSpace(id)
	if submissionTime == "" || id == "" {
		return googleLeadFormsCursorComplete
	}
	raw, _ := json.Marshal(googleLeadFormsCursorState{LastSubmissionTime: submissionTime, LastID: id})
	return googleLeadFormsCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func nextGoogleLeadFormsCursor(page googleLeadFormsSearchResponse, batchLimit int) string {
	if strings.TrimSpace(page.NextPageToken) != "" {
		return encodeGoogleLeadFormsPageCursor(page.NextPageToken)
	}
	if len(page.Results) == 0 || len(page.Results) < googleLeadFormsBatchLimit(batchLimit) {
		return googleLeadFormsCursorComplete
	}
	last := page.Results[len(page.Results)-1].LeadFormSubmissionData
	return encodeGoogleLeadFormsWatermarkCursor(last.SubmissionDateTime, last.ID)
}

type googleLeadFormsSearchRequest struct {
	Query     string `json:"query"`
	PageToken string `json:"pageToken,omitempty"`
}

type googleLeadFormsSearchResponse struct {
	Results       []googleLeadFormsSearchResult `json:"results"`
	NextPageToken string                        `json:"nextPageToken"`
}

type googleLeadFormsSearchResult struct {
	LeadFormSubmissionData googleLeadFormsSubmissionData `json:"leadFormSubmissionData"`
}

type googleLeadFormsSubmissionData struct {
	ResourceName                   string                                 `json:"resourceName"`
	ID                             string                                 `json:"id"`
	Asset                          string                                 `json:"asset"`
	Campaign                       string                                 `json:"campaign"`
	AdGroup                        string                                 `json:"adGroup"`
	AdGroupAd                      string                                 `json:"adGroupAd"`
	Gclid                          string                                 `json:"gclid"`
	LeadFormSubmissionFields       []googleLeadFormsSubmissionField       `json:"leadFormSubmissionFields"`
	CustomLeadFormSubmissionFields []googleLeadFormsCustomSubmissionField `json:"customLeadFormSubmissionFields"`
	SubmissionDateTime             string                                 `json:"submissionDateTime"`
}

type googleLeadFormsSubmissionField struct {
	FieldType  string `json:"fieldType"`
	FieldValue string `json:"fieldValue"`
}

type googleLeadFormsCustomSubmissionField struct {
	QuestionText string `json:"questionText"`
	FieldValue   string `json:"fieldValue"`
}

func fetchGoogleLeadFormsSubmissions(ctx context.Context, client *http.Client, baseURL, accessToken, developerToken, loginCustomerID, userAgent, customerID, assetID, campaignID string, state googleLeadFormsCursorState, batchLimit int) (googleLeadFormsSearchResponse, error) {
	rawURL, err := googleLeadFormsSearchURL(baseURL, customerID)
	if err != nil {
		return googleLeadFormsSearchResponse{}, err
	}
	body := googleLeadFormsSearchRequest{
		Query:     googleLeadFormsSearchQuery(customerID, assetID, campaignID, state, batchLimit),
		PageToken: strings.TrimSpace(state.PageToken),
	}
	raw, err := googleLeadFormsDoRaw(ctx, client, rawURL, accessToken, developerToken, loginCustomerID, userAgent, body)
	if err != nil {
		return googleLeadFormsSearchResponse{}, err
	}
	var out googleLeadFormsSearchResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return googleLeadFormsSearchResponse{}, fmt.Errorf("decode google lead form extensions search response: %w", err)
	}
	return out, nil
}

func googleLeadFormsSearchURL(baseURL, customerID string) (string, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/") + "/customers/" + url.PathEscape(normalizeGoogleLeadFormsCustomerID(customerID)) + googleLeadFormsSearchPathSuffix)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func googleLeadFormsSearchQuery(customerID, assetID, campaignID string, state googleLeadFormsCursorState, batchLimit int) string {
	fields := make([]string, 0, len(googleLeadFormsSearchFields))
	for _, field := range googleLeadFormsSearchFields {
		fields = append(fields, googleLeadFormsResourceFieldPrefix+field)
	}
	query := "SELECT " + strings.Join(fields, ", ") + " FROM lead_form_submission_data"
	where := make([]string, 0, 3)
	customerID = normalizeGoogleLeadFormsCustomerID(customerID)
	if assetID = googleLeadFormsResourceID(assetID); assetID != "" {
		where = append(where, "lead_form_submission_data.asset = "+googleLeadFormsGAQLString("customers/"+customerID+"/assets/"+assetID))
	}
	if campaignID = googleLeadFormsResourceID(campaignID); campaignID != "" {
		where = append(where, "lead_form_submission_data.campaign = "+googleLeadFormsGAQLString("customers/"+customerID+"/campaigns/"+campaignID))
	}
	if state.PageToken == "" && strings.TrimSpace(state.LastSubmissionTime) != "" && strings.TrimSpace(state.LastID) != "" {
		watermark := "(lead_form_submission_data.submission_date_time > " + googleLeadFormsGAQLString(state.LastSubmissionTime) +
			" OR (lead_form_submission_data.submission_date_time = " + googleLeadFormsGAQLString(state.LastSubmissionTime) +
			" AND lead_form_submission_data.id > " + googleLeadFormsGAQLString(state.LastID) + "))"
		where = append(where, watermark)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	return query + " ORDER BY lead_form_submission_data.submission_date_time ASC, lead_form_submission_data.id ASC LIMIT " + fmt.Sprint(googleLeadFormsBatchLimit(batchLimit))
}

func googleLeadFormsGAQLString(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `'`, `\'`)
	return "'" + value + "'"
}

func googleLeadFormsDoRaw(ctx context.Context, client *http.Client, rawURL, accessToken, developerToken, loginCustomerID, userAgent string, body googleLeadFormsSearchRequest) ([]byte, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("developer-token", strings.TrimSpace(developerToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, googleLeadFormsDefaultUserAgent))
	if loginCustomerID = normalizeGoogleLeadFormsCustomerID(loginCustomerID); loginCustomerID != "" {
		req.Header.Set("login-customer-id", loginCustomerID)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, googleLeadFormsResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return nil, GoogleLeadFormsProviderError{Path: req.URL.Path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: googleLeadFormsResponseSnippet(raw)}
		}
		return nil, fmt.Errorf("google lead form extensions Google Ads %s failed %d: %s", req.URL.Path, resp.StatusCode, googleLeadFormsResponseSnippet(raw))
	}
	return raw, nil
}

type GoogleLeadFormsProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e GoogleLeadFormsProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("google lead form extensions Google Ads %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("google lead form extensions Google Ads %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func googleLeadFormsMatchesConfiguredForm(item googleLeadFormsSubmissionData, assetID, campaignID string) bool {
	if assetID = strings.TrimSpace(assetID); assetID != "" && googleLeadFormsResourceID(item.Asset) != assetID {
		return false
	}
	if campaignID = strings.TrimSpace(campaignID); campaignID != "" && googleLeadFormsResourceID(item.Campaign) != campaignID {
		return false
	}
	return true
}

func mapGoogleLeadFormsSubmission(item googleLeadFormsSubmissionData, integration Integration, customerID, assetID string) SubmissionInput {
	itemAssetID := firstString(googleLeadFormsResourceID(item.Asset), assetID)
	fields := map[string]any{
		"google_lead_forms_submission_id": item.ID,
		"google_lead_forms_resource_name": item.ResourceName,
		"google_lead_forms_customer_id":   customerID,
		"google_lead_forms_asset":         item.Asset,
		"google_lead_forms_asset_id":      itemAssetID,
		"google_lead_forms_campaign":      item.Campaign,
		"google_lead_forms_campaign_id":   googleLeadFormsResourceID(item.Campaign),
		"google_lead_forms_ad_group":      item.AdGroup,
		"google_lead_forms_ad_group_id":   googleLeadFormsResourceID(item.AdGroup),
		"google_lead_forms_ad_group_ad":   item.AdGroupAd,
		"google_lead_forms_gclid":         item.Gclid,
	}
	identity := typeformIdentity{}
	for _, field := range item.LeadFormSubmissionFields {
		key := googleLeadFormsFieldKey(field.FieldType)
		value := strings.TrimSpace(field.FieldValue)
		if key == "" || value == "" {
			continue
		}
		setGoogleLeadFormsField(fields, "google_lead_forms_field."+key, value)
		identity.apply(field.FieldType, value)
	}
	for i, field := range item.CustomLeadFormSubmissionFields {
		key := googleLeadFormsFieldKey(firstString(field.QuestionText, fmt.Sprintf("custom_%d", i+1)))
		value := strings.TrimSpace(field.FieldValue)
		if key == "" || value == "" {
			continue
		}
		setGoogleLeadFormsField(fields, "google_lead_forms_custom_field."+key, value)
		identity.apply(field.QuestionText, value)
	}
	submittedAt := parseGoogleLeadFormsTime(item.SubmissionDateTime)
	return SubmissionInput{
		SourceID:    googleLeadFormsSourceID(item),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      itemAssetID,
		FormName:    settingString(integration.Settings, "form_name"),
		EventName:   "lead.submitted",
		Tags:        googleLeadFormsTags(integration, itemAssetID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func setGoogleLeadFormsField(fields map[string]any, key string, value any) {
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	if _, exists := fields[key]; !exists {
		fields[key] = value
		return
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s_%d", key, i)
		if _, exists := fields[candidate]; !exists {
			fields[candidate] = value
			return
		}
	}
}

func googleLeadFormsFieldKey(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			if b.Len() > 0 {
				b.WriteByte('_')
			}
		}
	}
	return strings.Trim(b.String(), "_")
}

func googleLeadFormsSourceID(item googleLeadFormsSubmissionData) string {
	id := firstString(item.ID, item.ResourceName)
	if id == "" || id == "<nil>" {
		return ""
	}
	return googleLeadFormsSourceIDPrefix + id
}

func googleLeadFormsTags(integration Integration, assetID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"google-lead-form-extensions", "google-lead-form-extensions:" + strings.TrimSpace(assetID)} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func parseGoogleLeadFormsTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05-07:00", "2006-01-02 15:04:05-0700"} {
		if t, err := time.Parse(layout, raw); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	if t, err := time.ParseInLocation("2006-01-02 15:04:05", raw, time.UTC); err == nil {
		utc := t.UTC()
		return &utc
	}
	return nil
}

func googleLeadFormsBatchLimit(size int) int {
	if size <= 0 {
		return googleLeadFormsDefaultBatchLimit
	}
	if size > googleLeadFormsMaxBatchLimit {
		return googleLeadFormsMaxBatchLimit
	}
	return size
}

func normalizeGoogleLeadFormsCustomerID(raw string) string {
	raw = googleLeadFormsResourceID(raw)
	raw = strings.ReplaceAll(raw, "-", "")
	raw = strings.ReplaceAll(raw, " ", "")
	return strings.TrimSpace(raw)
}

func googleLeadFormsResourceID(raw string) string {
	raw = strings.Trim(strings.TrimSpace(raw), "/")
	if raw == "" {
		return ""
	}
	if idx := strings.LastIndex(raw, "/"); idx >= 0 && idx+1 < len(raw) {
		raw = raw[idx+1:]
	}
	return strings.TrimSpace(raw)
}

func googleLeadFormsResponseSnippet(raw []byte) string {
	value := strings.TrimSpace(string(raw))
	if len(value) > 500 {
		return value[:500]
	}
	return value
}
