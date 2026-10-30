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
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	surveyMonkeyCursorPrefix      = "surveymonkey:"
	surveyMonkeyCursorComplete    = "surveymonkey:complete"
	surveyMonkeyDefaultAPIBaseURL = "https://api.surveymonkey.com"
	surveyMonkeyResponseMaxBytes  = 8 << 20
	surveyMonkeyDefaultPageSize   = 100
	surveyMonkeyMaxPageSize       = 100
	surveyMonkeyDefaultUserAgent  = "Moosewave SurveyMonkey Integration"
)

type SurveyMonkeyCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type SurveyMonkeyCredentialResolver interface {
	ResolveSurveyMonkey(context.Context, string, Integration) (SurveyMonkeyCredentials, error)
}

type SurveyMonkeyBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type SurveyMonkeyRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials SurveyMonkeyCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
	Now         func() time.Time
}

type SurveyMonkeyRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type SurveyMonkeySecretsCredentialResolver struct {
	Secrets SurveyMonkeyRuntimeSecretResolver
}

func NewSurveyMonkeySecretsCredentialResolver(secrets SurveyMonkeyRuntimeSecretResolver) *SurveyMonkeySecretsCredentialResolver {
	return &SurveyMonkeySecretsCredentialResolver{Secrets: secrets}
}

func (r *SurveyMonkeySecretsCredentialResolver) ResolveSurveyMonkey(ctx context.Context, _ string, integration Integration) (SurveyMonkeyCredentials, error) {
	if r == nil || r.Secrets == nil {
		return SurveyMonkeyCredentials{}, fmt.Errorf("surveymonkey credential resolver is not configured")
	}
	ref := surveyMonkeyCredentialRef(integration)
	if ref == "" {
		return SurveyMonkeyCredentials{}, fmt.Errorf("surveymonkey credentials_ref is required")
	}
	var payload surveyMonkeyCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return SurveyMonkeyCredentials{}, fmt.Errorf("resolve surveymonkey credentials %q: %w", ref, err)
		}
		return parseSurveyMonkeyCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SurveyMonkeyCredentials{}, fmt.Errorf("resolve surveymonkey credentials %q: %w", ref, err)
	}
	return parseSurveyMonkeyCredentialSecret(raw)
}

type surveyMonkeyCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	BearerToken string `json:"bearer_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p surveyMonkeyCredentialPayload) credentials() (SurveyMonkeyCredentials, error) {
	token := normalizeSurveyMonkeyBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken))
	if token == "" {
		return SurveyMonkeyCredentials{}, fmt.Errorf("surveymonkey access_token is required")
	}
	return SurveyMonkeyCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseSurveyMonkeyCredentialSecret(raw string) (SurveyMonkeyCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return SurveyMonkeyCredentials{}, fmt.Errorf("surveymonkey credentials are empty")
	}
	var payload surveyMonkeyCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return SurveyMonkeyCredentials{}, fmt.Errorf("parse surveymonkey credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseSurveyMonkeyKeyValueSecret(raw).credentials()
	}
	return surveyMonkeyCredentialPayload{AccessToken: raw}.credentials()
}

func parseSurveyMonkeyKeyValueSecret(raw string) surveyMonkeyCredentialPayload {
	var payload surveyMonkeyCredentialPayload
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
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeSurveyMonkeyBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func surveyMonkeyCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b SurveyMonkeyRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderSurveyMonkey {
		return SyncRequest{}, fmt.Errorf("surveymonkey backfill requires a SurveyMonkey integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("surveymonkey credential resolver is not configured")
	}
	surveyID := strings.TrimSpace(settingString(integration.Settings, "survey_id"))
	if surveyID == "" {
		return SyncRequest{}, fmt.Errorf("surveymonkey survey_id is required")
	}
	creds, err := b.Credentials.ResolveSurveyMonkey(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("surveymonkey access_token is required")
	}
	state, err := decodeSurveyMonkeyCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: surveyMonkeyCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderSurveyMonkey, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), surveyMonkeyDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), surveyMonkeyDefaultUserAgent)
	pageSize := surveyMonkeyPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	details, err := fetchSurveyMonkeySurveyDetails(ctx, client, baseURL, creds.AccessToken, userAgent, surveyID)
	if err != nil {
		return SyncRequest{}, err
	}
	labels := surveyMonkeyQuestionMetadata(details)
	since := firstString(state.Since, settingString(integration.Settings, "start_modified_at"), settingString(integration.Settings, "after_time"))
	pageOut, err := fetchSurveyMonkeyResponses(ctx, client, baseURL, creds.AccessToken, userAgent, surveyID, state.NextURL, since, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Data))}
	latest := state.Since
	for _, item := range pageOut.Data {
		submission := mapSurveyMonkeyResponse(item, integration, labels, surveyID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
		latest = laterSurveyMonkeyTimestamp(latest, firstString(item.DateModified, item.DateCreated))
	}
	if strings.TrimSpace(pageOut.Links.Next) != "" {
		req.Cursor = encodeSurveyMonkeyCursor(surveyMonkeyCursorState{NextURL: pageOut.Links.Next, Since: firstString(state.Since, since)})
	} else if strings.TrimSpace(latest) != "" {
		req.Cursor = encodeSurveyMonkeyCursor(surveyMonkeyCursorState{Since: latest})
	} else if strings.TrimSpace(state.Since) != "" {
		req.Cursor = encodeSurveyMonkeyCursor(surveyMonkeyCursorState{Since: state.Since})
	} else {
		req.Cursor = encodeSurveyMonkeyCursor(surveyMonkeyCursorState{Since: surveyMonkeyNow(b.Now).Format(time.RFC3339Nano)})
	}
	return req, nil
}

type surveyMonkeyCursorState struct {
	NextURL  string `json:"next_url,omitempty"`
	Since    string `json:"since,omitempty"`
	Complete bool   `json:"complete,omitempty"`
}

func decodeSurveyMonkeyCursor(cursor string) (surveyMonkeyCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return surveyMonkeyCursorState{}, nil
	}
	if cursor == surveyMonkeyCursorComplete {
		return surveyMonkeyCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, surveyMonkeyCursorPrefix) {
		return surveyMonkeyCursorState{}, fmt.Errorf("invalid SurveyMonkey cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, surveyMonkeyCursorPrefix))
	if raw == "" {
		return surveyMonkeyCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return surveyMonkeyCursorState{}, fmt.Errorf("invalid SurveyMonkey cursor")
	}
	var out surveyMonkeyCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return surveyMonkeyCursorState{}, fmt.Errorf("invalid SurveyMonkey cursor")
	}
	out.NextURL = strings.TrimSpace(out.NextURL)
	out.Since = strings.TrimSpace(out.Since)
	return out, nil
}

func encodeSurveyMonkeyCursor(state surveyMonkeyCursorState) string {
	if state.Complete {
		return surveyMonkeyCursorComplete
	}
	state.NextURL = strings.TrimSpace(state.NextURL)
	state.Since = strings.TrimSpace(state.Since)
	raw, _ := json.Marshal(state)
	return surveyMonkeyCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type surveyMonkeyListResponse struct {
	Page    int                    `json:"page"`
	PerPage int                    `json:"per_page"`
	Total   int                    `json:"total"`
	Links   surveyMonkeyLinks      `json:"links"`
	Data    []surveyMonkeyResponse `json:"data"`
	Raw     map[string]any         `json:"-"`
}

type surveyMonkeyLinks struct {
	Self string `json:"self"`
	Prev string `json:"prev"`
	Next string `json:"next"`
	Last string `json:"last"`
}

type surveyMonkeyResponse struct {
	ID              string             `json:"id"`
	SurveyID        string             `json:"survey_id"`
	CollectorID     string             `json:"collector_id"`
	RecipientID     string             `json:"recipient_id"`
	ResponseStatus  string             `json:"response_status"`
	CollectionMode  string             `json:"collection_mode"`
	DateCreated     string             `json:"date_created"`
	DateModified    string             `json:"date_modified"`
	IPAddress       string             `json:"ip_address"`
	Language        string             `json:"language"`
	TotalTime       int                `json:"total_time"`
	CustomValue     string             `json:"custom_value"`
	CustomVariables map[string]any     `json:"custom_variables"`
	Pages           []surveyMonkeyPage `json:"pages"`
	Raw             map[string]any     `json:"-"`
}

type surveyMonkeyPage struct {
	ID        string                 `json:"id"`
	Questions []surveyMonkeyQuestion `json:"questions"`
}

type surveyMonkeyQuestion struct {
	ID      string               `json:"id"`
	Answers []surveyMonkeyAnswer `json:"answers"`
}

type surveyMonkeyAnswer struct {
	ChoiceID string         `json:"choice_id"`
	RowID    string         `json:"row_id"`
	ColID    string         `json:"col_id"`
	OtherID  string         `json:"other_id"`
	Text     string         `json:"text"`
	Type     string         `json:"type"`
	Raw      map[string]any `json:"-"`
}

func (r *surveyMonkeyListResponse) UnmarshalJSON(raw []byte) error {
	type alias surveyMonkeyListResponse
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*r = surveyMonkeyListResponse(out)
	r.Raw = nonNilMap(rawMap)
	return nil
}

func (r *surveyMonkeyResponse) UnmarshalJSON(raw []byte) error {
	type alias surveyMonkeyResponse
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*r = surveyMonkeyResponse(out)
	r.Raw = nonNilMap(rawMap)
	r.CustomVariables = normalizeSurveyMonkeyMap(r.CustomVariables)
	return nil
}

func (a *surveyMonkeyAnswer) UnmarshalJSON(raw []byte) error {
	var rawMap map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&rawMap); err != nil {
		return err
	}
	a.ChoiceID = surveyMonkeyStringValue(rawMap["choice_id"])
	a.RowID = surveyMonkeyStringValue(rawMap["row_id"])
	a.ColID = surveyMonkeyStringValue(rawMap["col_id"])
	a.OtherID = surveyMonkeyStringValue(rawMap["other_id"])
	a.Text = surveyMonkeyStringValue(rawMap["text"])
	a.Type = surveyMonkeyStringValue(rawMap["type"])
	a.Raw = nonNilMap(rawMap)
	return nil
}

type surveyMonkeySurveyDetails struct {
	ID    string                   `json:"id"`
	Title string                   `json:"title"`
	Pages []surveyMonkeyDetailPage `json:"pages"`
	Raw   map[string]any           `json:"-"`
}

type surveyMonkeyDetailPage struct {
	ID        string                       `json:"id"`
	Questions []surveyMonkeyDetailQuestion `json:"questions"`
}

type surveyMonkeyDetailQuestion struct {
	ID       string                         `json:"id"`
	Family   string                         `json:"family"`
	Subtype  string                         `json:"subtype"`
	Headings []surveyMonkeyHeading          `json:"headings"`
	Answers  surveyMonkeyDetailAnswerGroups `json:"answers"`
}

type surveyMonkeyHeading struct {
	Heading string `json:"heading"`
}

type surveyMonkeyDetailAnswerGroups struct {
	Choices []surveyMonkeyAnswerOption `json:"choices"`
	Rows    []surveyMonkeyAnswerOption `json:"rows"`
	Cols    []surveyMonkeyAnswerOption `json:"cols"`
	Other   []surveyMonkeyAnswerOption `json:"other"`
}

type surveyMonkeyAnswerOption struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Visible bool   `json:"visible"`
}

func (d *surveyMonkeySurveyDetails) UnmarshalJSON(raw []byte) error {
	type alias surveyMonkeySurveyDetails
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*d = surveyMonkeySurveyDetails(out)
	d.Raw = nonNilMap(rawMap)
	return nil
}

type surveyMonkeyQuestionMeta struct {
	Label   string
	Family  string
	Subtype string
	Choices map[string]string
	Rows    map[string]string
	Cols    map[string]string
	Other   map[string]string
}

func surveyMonkeyQuestionMetadata(details surveyMonkeySurveyDetails) map[string]surveyMonkeyQuestionMeta {
	out := map[string]surveyMonkeyQuestionMeta{}
	for _, page := range details.Pages {
		for _, question := range page.Questions {
			label := ""
			if len(question.Headings) > 0 {
				label = strings.TrimSpace(question.Headings[0].Heading)
			}
			out[question.ID] = surveyMonkeyQuestionMeta{
				Label:   label,
				Family:  question.Family,
				Subtype: question.Subtype,
				Choices: surveyMonkeyAnswerLabels(question.Answers.Choices),
				Rows:    surveyMonkeyAnswerLabels(question.Answers.Rows),
				Cols:    surveyMonkeyAnswerLabels(question.Answers.Cols),
				Other:   surveyMonkeyAnswerLabels(question.Answers.Other),
			}
		}
	}
	return out
}

func surveyMonkeyAnswerLabels(options []surveyMonkeyAnswerOption) map[string]string {
	out := map[string]string{}
	for _, option := range options {
		if strings.TrimSpace(option.ID) != "" && strings.TrimSpace(option.Text) != "" {
			out[option.ID] = strings.TrimSpace(option.Text)
		}
	}
	return out
}

func fetchSurveyMonkeySurveyDetails(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, surveyID string) (surveyMonkeySurveyDetails, error) {
	raw, err := surveyMonkeyDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/v3/surveys/"+url.PathEscape(surveyID)+"/details", nil, "", nil)
	if err != nil {
		return surveyMonkeySurveyDetails{}, err
	}
	var out surveyMonkeySurveyDetails
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return surveyMonkeySurveyDetails{}, fmt.Errorf("decode surveymonkey survey details: %w", err)
	}
	return out, nil
}

func fetchSurveyMonkeyResponses(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, surveyID, nextURL, since string, pageSize int, integration Integration) (surveyMonkeyListResponse, error) {
	pathValue := "/v3/surveys/" + url.PathEscape(surveyID) + "/responses/bulk"
	query := url.Values{}
	if strings.TrimSpace(nextURL) == "" {
		query.Set("per_page", strconv.Itoa(surveyMonkeyPageSize(pageSize)))
		query.Set("simple", "false")
		if strings.TrimSpace(since) != "" {
			query.Set("start_modified_at", strings.TrimSpace(since))
		}
		if collectorID := settingString(integration.Settings, "collector_id"); collectorID != "" {
			query.Set("collector_ids", collectorID)
		}
		for _, key := range []string{"collector_ids", "custom_variables", "start_created_at", "end_created_at", "start_modified_at", "end_modified_at", "status", "email", "ip"} {
			if value := settingString(integration.Settings, key); value != "" {
				query.Set(key, value)
			}
		}
	}
	raw, err := surveyMonkeyDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, pathValue, query, nextURL, nil)
	if err != nil {
		return surveyMonkeyListResponse{}, err
	}
	var out surveyMonkeyListResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return surveyMonkeyListResponse{}, fmt.Errorf("decode surveymonkey responses: %w", err)
	}
	return out, nil
}

func surveyMonkeyDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, pathValue string, query url.Values, absoluteURL string, body io.Reader) ([]byte, error) {
	target := strings.TrimSpace(absoluteURL)
	if target == "" {
		target = strings.TrimRight(baseURL, "/") + path.Clean("/"+strings.TrimLeft(pathValue, "/"))
	}
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	if query != nil && len(query) > 0 {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, surveyMonkeyDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, surveyMonkeyResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, SurveyMonkeyProviderError{Path: pathValue, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: surveyMonkeyResponseSnippet(raw)}
	}
	return raw, nil
}

type SurveyMonkeyProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e SurveyMonkeyProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("surveymonkey REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("surveymonkey REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapSurveyMonkeyResponse(item surveyMonkeyResponse, integration Integration, labels map[string]surveyMonkeyQuestionMeta, surveyID string) SubmissionInput {
	effectiveSurveyID := firstString(item.SurveyID, surveyID)
	fields := map[string]any{
		"surveymonkey_response_id":     item.ID,
		"surveymonkey_survey_id":       effectiveSurveyID,
		"surveymonkey_collector_id":    item.CollectorID,
		"surveymonkey_recipient_id":    item.RecipientID,
		"surveymonkey_response_status": item.ResponseStatus,
		"surveymonkey_collection_mode": item.CollectionMode,
		"surveymonkey_date_created":    item.DateCreated,
		"surveymonkey_date_modified":   item.DateModified,
		"surveymonkey_ip_address":      item.IPAddress,
		"surveymonkey_language":        item.Language,
		"surveymonkey_total_time":      item.TotalTime,
		"surveymonkey_custom_value":    item.CustomValue,
		"surveymonkey_provider_raw":    item.Raw,
	}
	identity := typeformIdentity{}
	for key, value := range item.CustomVariables {
		normalizedKey := normalizeTypeformIdentityKey(key)
		fields["surveymonkey_custom_variable."+normalizedKey] = normalizeSurveyMonkeyValue(value)
		identity.apply(normalizedKey, fmt.Sprint(value))
	}
	for _, pageItem := range item.Pages {
		for _, question := range pageItem.Questions {
			meta := labels[question.ID]
			label := firstString(meta.Label, "question_"+question.ID)
			normalizedKey := normalizeTypeformIdentityKey(label)
			values := surveyMonkeyAnswerValues(question.Answers, meta)
			var value any
			if len(values) == 1 {
				value = values[0]
			} else {
				value = values
			}
			fields["surveymonkey_question."+normalizedKey] = value
			fields["surveymonkey_question_id."+normalizedKey] = question.ID
			fields["surveymonkey_question_family."+normalizedKey] = meta.Family
			fields["surveymonkey_question_subtype."+normalizedKey] = meta.Subtype
			applySurveyMonkeyIdentity(&identity, question.ID, label, value, integration)
		}
	}
	submittedAt := parseSurveyMonkeyTime(firstString(item.DateModified, item.DateCreated))
	return SubmissionInput{
		SourceID:    surveyMonkeySourceID(effectiveSurveyID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      effectiveSurveyID,
		FormName:    settingString(integration.Settings, "survey_name"),
		EventName:   "lead.submitted",
		Tags:        surveyMonkeyTags(integration, effectiveSurveyID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func surveyMonkeyAnswerValues(answers []surveyMonkeyAnswer, meta surveyMonkeyQuestionMeta) []any {
	values := make([]any, 0, len(answers))
	for _, answer := range answers {
		if value := surveyMonkeyAnswerValue(answer, meta); value != "" {
			values = append(values, value)
		}
	}
	return values
}

func surveyMonkeyAnswerValue(answer surveyMonkeyAnswer, meta surveyMonkeyQuestionMeta) string {
	parts := []string{}
	if strings.TrimSpace(answer.Text) != "" {
		parts = append(parts, strings.TrimSpace(answer.Text))
	}
	if label := meta.Choices[answer.ChoiceID]; label != "" {
		parts = append(parts, label)
	}
	if label := meta.Rows[answer.RowID]; label != "" {
		parts = append(parts, label)
	}
	if label := meta.Cols[answer.ColID]; label != "" {
		parts = append(parts, label)
	}
	if label := meta.Other[answer.OtherID]; label != "" {
		parts = append(parts, label)
	}
	if len(parts) == 0 {
		for _, value := range []string{answer.ChoiceID, answer.RowID, answer.ColID, answer.OtherID} {
			if strings.TrimSpace(value) != "" {
				parts = append(parts, strings.TrimSpace(value))
			}
		}
	}
	return strings.Join(uniqueSurveyMonkeyStrings(parts), " / ")
}

func applySurveyMonkeyIdentity(identity *typeformIdentity, questionID, label string, value any, integration Integration) {
	if identity == nil {
		return
	}
	applyFilloutStructuredIdentity(identity, value)
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" || text == "<nil>" || text == "[]" {
		return
	}
	switch {
	case settingMatchesSurveyMonkeyQuestion(integration, questionID, "email_question_id"):
		identity.Email = text
	case settingMatchesSurveyMonkeyQuestion(integration, questionID, "first_name_question_id"):
		identity.FirstName = text
	case settingMatchesSurveyMonkeyQuestion(integration, questionID, "last_name_question_id"):
		identity.LastName = text
	case settingMatchesSurveyMonkeyQuestion(integration, questionID, "full_name_question_id"):
		identity.FullName = text
	case settingMatchesSurveyMonkeyQuestion(integration, questionID, "phone_question_id"):
		identity.Phone = text
	case settingMatchesSurveyMonkeyQuestion(integration, questionID, "company_question_id"):
		identity.Company = text
	default:
		key := normalizeTypeformIdentityKey(label)
		if identity.Email == "" && (strings.Contains(key, "email") || strings.Contains(text, "@")) {
			identity.Email = text
		}
		identity.apply(label, text)
	}
}

func settingMatchesSurveyMonkeyQuestion(integration Integration, id, key string) bool {
	for _, part := range strings.Split(settingString(integration.Settings, key), ",") {
		if strings.TrimSpace(part) == id {
			return true
		}
	}
	return false
}

func normalizeSurveyMonkeyValue(value any) any {
	switch typed := value.(type) {
	case json.Number:
		if i, err := typed.Int64(); err == nil {
			return i
		}
		if f, err := typed.Float64(); err == nil {
			return f
		}
		return typed.String()
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, normalizeSurveyMonkeyValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeSurveyMonkeyValue(item)
		}
		return out
	default:
		return typed
	}
}

func normalizeSurveyMonkeyMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = normalizeSurveyMonkeyValue(value)
	}
	return out
}

func surveyMonkeyPageSize(size int) int {
	if size <= 0 {
		return surveyMonkeyDefaultPageSize
	}
	if size > surveyMonkeyMaxPageSize {
		return surveyMonkeyMaxPageSize
	}
	return size
}

func surveyMonkeyStringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func surveyMonkeyNow(now func() time.Time) time.Time {
	if now != nil {
		return now().UTC()
	}
	return time.Now().UTC()
}

func parseSurveyMonkeyTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.Parse(layout, raw); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}

func laterSurveyMonkeyTimestamp(current, candidate string) string {
	current = strings.TrimSpace(current)
	candidate = strings.TrimSpace(candidate)
	if current == "" {
		return candidate
	}
	if candidate == "" {
		return current
	}
	currentAt := parseSurveyMonkeyTime(current)
	candidateAt := parseSurveyMonkeyTime(candidate)
	if currentAt == nil || candidateAt == nil {
		if candidate > current {
			return candidate
		}
		return current
	}
	if candidateAt.After(*currentAt) {
		return candidate
	}
	return current
}

func surveyMonkeySourceID(surveyID, responseID string) string {
	surveyID = strings.TrimSpace(surveyID)
	responseID = strings.TrimSpace(responseID)
	if surveyID == "" || responseID == "" || responseID == "<nil>" {
		return ""
	}
	return "surveymonkey://response/" + surveyID + "/" + responseID
}

func surveyMonkeyTags(integration Integration, surveyID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"surveymonkey", "surveymonkey:" + surveyID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func surveyMonkeyResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}

func uniqueSurveyMonkeyStrings(values []string) []string {
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || containsFold(out, value) {
			continue
		}
		out = append(out, value)
	}
	return out
}
