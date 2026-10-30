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
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	googleFormsCursorPrefix      = "google-forms:"
	googleFormsCursorComplete    = "google-forms:complete"
	googleFormsDefaultAPIBaseURL = "https://forms.googleapis.com"
	googleFormsResponseMaxBytes  = 8 << 20
	googleFormsDefaultPageSize   = 500
	googleFormsMaxPageSize       = 5000
	googleFormsDefaultUserAgent  = "Moosewave Google Forms Integration"
)

type GoogleFormsCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type GoogleFormsCredentialResolver interface {
	ResolveGoogleForms(context.Context, string, Integration) (GoogleFormsCredentials, error)
}

type GoogleFormsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type GoogleFormsRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials GoogleFormsCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
	Now         func() time.Time
}

type GoogleFormsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type GoogleFormsSecretsCredentialResolver struct {
	Secrets GoogleFormsRuntimeSecretResolver
}

func NewGoogleFormsSecretsCredentialResolver(secrets GoogleFormsRuntimeSecretResolver) *GoogleFormsSecretsCredentialResolver {
	return &GoogleFormsSecretsCredentialResolver{Secrets: secrets}
}

func (r *GoogleFormsSecretsCredentialResolver) ResolveGoogleForms(ctx context.Context, _ string, integration Integration) (GoogleFormsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return GoogleFormsCredentials{}, fmt.Errorf("google forms credential resolver is not configured")
	}
	ref := googleFormsCredentialRef(integration)
	if ref == "" {
		return GoogleFormsCredentials{}, fmt.Errorf("google forms credentials_ref is required")
	}
	var payload googleFormsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return GoogleFormsCredentials{}, fmt.Errorf("resolve google forms credentials %q: %w", ref, err)
		}
		return parseGoogleFormsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return GoogleFormsCredentials{}, fmt.Errorf("resolve google forms credentials %q: %w", ref, err)
	}
	return parseGoogleFormsCredentialSecret(raw)
}

type googleFormsCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	BearerToken string `json:"bearer_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p googleFormsCredentialPayload) credentials() (GoogleFormsCredentials, error) {
	token := normalizeGoogleFormsBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken))
	if token == "" {
		return GoogleFormsCredentials{}, fmt.Errorf("google forms access_token is required")
	}
	return GoogleFormsCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseGoogleFormsCredentialSecret(raw string) (GoogleFormsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return GoogleFormsCredentials{}, fmt.Errorf("google forms credentials are empty")
	}
	var payload googleFormsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return GoogleFormsCredentials{}, fmt.Errorf("parse google forms credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseGoogleFormsKeyValueSecret(raw).credentials()
	}
	return googleFormsCredentialPayload{AccessToken: raw}.credentials()
}

func parseGoogleFormsKeyValueSecret(raw string) googleFormsCredentialPayload {
	var payload googleFormsCredentialPayload
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

func normalizeGoogleFormsBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func googleFormsCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b GoogleFormsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderGoogleForms {
		return SyncRequest{}, fmt.Errorf("google forms backfill requires a Google Forms integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("google forms credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("google forms form_id is required")
	}
	creds, err := b.Credentials.ResolveGoogleForms(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("google forms access token is required")
	}
	state, err := decodeGoogleFormsCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: googleFormsCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderGoogleForms, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), googleFormsDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), googleFormsDefaultUserAgent)
	pageSize := googleFormsPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	form, err := fetchGoogleForm(ctx, client, baseURL, creds.AccessToken, userAgent, formID)
	if err != nil {
		return SyncRequest{}, err
	}
	since := firstString(state.Since, settingString(integration.Settings, "after_time"), settingString(integration.Settings, "after_date"))
	pageOut, err := fetchGoogleFormResponses(ctx, client, baseURL, creds.AccessToken, userAgent, formID, state.PageToken, since, pageSize)
	if err != nil {
		return SyncRequest{}, err
	}
	labels := form.questionLabels()
	items := pageOut.Responses
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	latest := state.Since
	for _, item := range items {
		submission := mapGoogleFormResponse(item, form, labels, integration, formID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
		latest = laterGoogleFormsTimestamp(latest, firstString(item.LastSubmittedTime, item.CreateTime))
	}
	if strings.TrimSpace(pageOut.NextPageToken) != "" {
		req.Cursor = encodeGoogleFormsCursor(googleFormsCursorState{PageToken: pageOut.NextPageToken, Since: firstString(state.Since, since)})
	} else if strings.TrimSpace(latest) != "" {
		req.Cursor = encodeGoogleFormsCursor(googleFormsCursorState{Since: latest})
	} else if strings.TrimSpace(state.Since) != "" {
		req.Cursor = encodeGoogleFormsCursor(googleFormsCursorState{Since: state.Since})
	} else {
		req.Cursor = encodeGoogleFormsCursor(googleFormsCursorState{Since: googleFormsNow(b.Now).Format(time.RFC3339Nano)})
	}
	return req, nil
}

type googleFormsCursorState struct {
	PageToken string `json:"page_token,omitempty"`
	Since     string `json:"since,omitempty"`
	Complete  bool   `json:"complete,omitempty"`
}

func decodeGoogleFormsCursor(cursor string) (googleFormsCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return googleFormsCursorState{}, nil
	}
	if cursor == googleFormsCursorComplete {
		return googleFormsCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, googleFormsCursorPrefix) {
		return googleFormsCursorState{}, fmt.Errorf("invalid Google Forms cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, googleFormsCursorPrefix))
	if raw == "" {
		return googleFormsCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return googleFormsCursorState{}, fmt.Errorf("invalid Google Forms cursor")
	}
	var out googleFormsCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return googleFormsCursorState{}, fmt.Errorf("invalid Google Forms cursor")
	}
	out.PageToken = strings.TrimSpace(out.PageToken)
	out.Since = strings.TrimSpace(out.Since)
	return out, nil
}

func encodeGoogleFormsCursor(state googleFormsCursorState) string {
	if state.Complete {
		return googleFormsCursorComplete
	}
	state.PageToken = strings.TrimSpace(state.PageToken)
	state.Since = strings.TrimSpace(state.Since)
	raw, _ := json.Marshal(state)
	return googleFormsCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type googleForm struct {
	FormID string           `json:"formId"`
	Info   googleFormInfo   `json:"info"`
	Items  []googleFormItem `json:"items"`
	Raw    map[string]any   `json:"-"`
}

type googleFormInfo struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

type googleFormItem struct {
	ItemID            string                   `json:"itemId"`
	Title             string                   `json:"title"`
	QuestionItem      *googleFormQuestionItem  `json:"questionItem"`
	QuestionGroupItem *googleFormQuestionGroup `json:"questionGroupItem"`
}

type googleFormQuestionItem struct {
	Question googleFormQuestion `json:"question"`
}

type googleFormQuestionGroup struct {
	Questions []googleFormQuestion `json:"questions"`
}

type googleFormQuestion struct {
	QuestionID  string                 `json:"questionId"`
	Required    bool                   `json:"required"`
	RowQuestion map[string]any         `json:"rowQuestion"`
	Raw         map[string]interface{} `json:"-"`
}

func (f *googleForm) UnmarshalJSON(raw []byte) error {
	type alias googleForm
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*f = googleForm(out)
	f.Raw = nonNilMap(rawMap)
	return nil
}

func (f googleForm) questionLabels() map[string]string {
	out := map[string]string{}
	for _, item := range f.Items {
		title := strings.TrimSpace(item.Title)
		if item.QuestionItem != nil {
			qid := strings.TrimSpace(item.QuestionItem.Question.QuestionID)
			if qid != "" {
				out[qid] = title
			}
		}
		if item.QuestionGroupItem != nil {
			for _, q := range item.QuestionGroupItem.Questions {
				qid := strings.TrimSpace(q.QuestionID)
				if qid == "" {
					continue
				}
				rowTitle := strings.TrimSpace(mapString(q.RowQuestion, "title"))
				out[qid] = firstString(rowTitle, title, qid)
			}
		}
	}
	return out
}

type googleFormsResponsesResponse struct {
	Responses     []googleFormResponse `json:"responses"`
	NextPageToken string               `json:"nextPageToken"`
	Raw           map[string]any       `json:"-"`
}

type googleFormResponse struct {
	ResponseID        string                      `json:"responseId"`
	FormID            string                      `json:"formId"`
	CreateTime        string                      `json:"createTime"`
	LastSubmittedTime string                      `json:"lastSubmittedTime"`
	RespondentEmail   string                      `json:"respondentEmail"`
	TotalScore        any                         `json:"totalScore"`
	Answers           map[string]googleFormAnswer `json:"answers"`
	Raw               map[string]any              `json:"-"`
}

type googleFormAnswer struct {
	QuestionID        string                      `json:"questionId"`
	TextAnswers       googleFormTextAnswers       `json:"textAnswers"`
	FileUploadAnswers googleFormFileUploadAnswers `json:"fileUploadAnswers"`
	Grade             map[string]any              `json:"grade"`
	Raw               map[string]any              `json:"-"`
}

type googleFormTextAnswers struct {
	Answers []googleFormTextAnswer `json:"answers"`
}

type googleFormTextAnswer struct {
	Value string `json:"value"`
}

type googleFormFileUploadAnswers struct {
	Answers []map[string]any `json:"answers"`
}

func (r *googleFormsResponsesResponse) UnmarshalJSON(raw []byte) error {
	type alias googleFormsResponsesResponse
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*r = googleFormsResponsesResponse(out)
	r.Raw = nonNilMap(rawMap)
	return nil
}

func (r *googleFormResponse) UnmarshalJSON(raw []byte) error {
	type alias googleFormResponse
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*r = googleFormResponse(out)
	r.Raw = nonNilMap(rawMap)
	return nil
}

func (a *googleFormAnswer) UnmarshalJSON(raw []byte) error {
	type alias googleFormAnswer
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*a = googleFormAnswer(out)
	a.Raw = nonNilMap(rawMap)
	return nil
}

func fetchGoogleForm(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID string) (googleForm, error) {
	raw, err := googleFormsDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/v1/forms/"+url.PathEscape(formID), nil, nil)
	if err != nil {
		return googleForm{}, err
	}
	var out googleForm
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return googleForm{}, fmt.Errorf("decode google forms form response: %w", err)
	}
	return out, nil
}

func fetchGoogleFormResponses(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID, pageToken, since string, pageSize int) (googleFormsResponsesResponse, error) {
	query := url.Values{}
	query.Set("pageSize", strconv.Itoa(googleFormsPageSize(pageSize)))
	if strings.TrimSpace(pageToken) != "" {
		query.Set("pageToken", strings.TrimSpace(pageToken))
	}
	if strings.TrimSpace(since) != "" && strings.TrimSpace(pageToken) == "" {
		query.Set("filter", `timestamp > `+strings.TrimSpace(since))
	}
	raw, err := googleFormsDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/v1/forms/"+url.PathEscape(formID)+"/responses", query, nil)
	if err != nil {
		return googleFormsResponsesResponse{}, err
	}
	var out googleFormsResponsesResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return googleFormsResponsesResponse{}, fmt.Errorf("decode google forms responses response: %w", err)
	}
	return out, nil
}

func googleFormsDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return nil, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, googleFormsDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, googleFormsResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, GoogleFormsProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: googleFormsResponseSnippet(raw)}
	}
	return raw, nil
}

type GoogleFormsProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e GoogleFormsProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("google forms REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("google forms REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapGoogleFormResponse(item googleFormResponse, form googleForm, labels map[string]string, integration Integration, fallbackFormID string) SubmissionInput {
	formID := firstString(item.FormID, fallbackFormID, form.FormID, settingString(integration.Settings, "form_id"))
	formName := firstString(settingString(integration.Settings, "form_name"), form.Info.Title)
	fields := map[string]any{
		"google_forms_response_id":         item.ResponseID,
		"google_forms_form_id":             formID,
		"google_forms_form_title":          form.Info.Title,
		"google_forms_create_time":         item.CreateTime,
		"google_forms_last_submitted_time": item.LastSubmittedTime,
		"google_forms_respondent_email":    item.RespondentEmail,
		"google_forms_total_score":         item.TotalScore,
		"google_forms_provider_raw":        item.Raw,
	}
	identity := typeformIdentity{Email: item.RespondentEmail}
	for key, answer := range item.Answers {
		qid := firstString(answer.QuestionID, key)
		if strings.TrimSpace(qid) == "" {
			continue
		}
		label := firstString(labels[qid], qid)
		value := googleFormsAnswerValue(answer)
		normalizedKey := normalizeTypeformIdentityKey(firstString(label, qid))
		fields["google_forms_answer."+normalizedKey] = value
		fields["google_forms_question_id."+normalizedKey] = qid
		applyGoogleFormsIdentity(&identity, qid, label, value, integration)
	}
	submittedAt := parseFilloutTime(firstString(item.LastSubmittedTime, item.CreateTime))
	return SubmissionInput{
		SourceID:    googleFormsSourceID(formID, item.ResponseID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        googleFormsTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func googleFormsAnswerValue(answer googleFormAnswer) any {
	if len(answer.TextAnswers.Answers) == 1 {
		return answer.TextAnswers.Answers[0].Value
	}
	if len(answer.TextAnswers.Answers) > 1 {
		out := make([]string, 0, len(answer.TextAnswers.Answers))
		for _, item := range answer.TextAnswers.Answers {
			out = append(out, item.Value)
		}
		return out
	}
	if len(answer.FileUploadAnswers.Answers) > 0 {
		return normalizeGoogleFormsValue(answer.FileUploadAnswers.Answers)
	}
	return normalizeGoogleFormsValue(answer.Raw)
}

func applyGoogleFormsIdentity(identity *typeformIdentity, questionID, label string, value any, integration Integration) {
	if identity == nil {
		return
	}
	applyFilloutStructuredIdentity(identity, value)
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" || text == "<nil>" {
		return
	}
	switch {
	case settingMatchesGoogleFormsQuestion(integration, questionID, "email_question_id"):
		identity.Email = text
	case settingMatchesGoogleFormsQuestion(integration, questionID, "first_name_question_id"):
		identity.FirstName = text
	case settingMatchesGoogleFormsQuestion(integration, questionID, "last_name_question_id"):
		identity.LastName = text
	case settingMatchesGoogleFormsQuestion(integration, questionID, "full_name_question_id"):
		identity.FullName = text
	case settingMatchesGoogleFormsQuestion(integration, questionID, "phone_question_id"):
		identity.Phone = text
	case settingMatchesGoogleFormsQuestion(integration, questionID, "company_question_id"):
		identity.Company = text
	default:
		key := normalizeTypeformIdentityKey(label)
		if identity.Email == "" && (strings.Contains(key, "email") || strings.Contains(text, "@")) {
			identity.Email = text
		}
		identity.apply(label, text)
	}
}

func settingMatchesGoogleFormsQuestion(integration Integration, id, key string) bool {
	for _, part := range strings.Split(settingString(integration.Settings, key), ",") {
		if strings.TrimSpace(part) == id {
			return true
		}
	}
	return false
}

func normalizeGoogleFormsValue(value any) any {
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
			out = append(out, normalizeGoogleFormsValue(item))
		}
		return out
	case []map[string]any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, normalizeGoogleFormsValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeGoogleFormsValue(item)
		}
		return out
	default:
		return typed
	}
}

func googleFormsPageSize(size int) int {
	if size <= 0 {
		return googleFormsDefaultPageSize
	}
	if size > googleFormsMaxPageSize {
		return googleFormsMaxPageSize
	}
	return size
}

func googleFormsNow(now func() time.Time) time.Time {
	if now != nil {
		return now().UTC()
	}
	return time.Now().UTC()
}

func laterGoogleFormsTimestamp(current, candidate string) string {
	current = strings.TrimSpace(current)
	candidate = strings.TrimSpace(candidate)
	if current == "" {
		return candidate
	}
	if candidate == "" {
		return current
	}
	currentAt, currentErr := time.Parse(time.RFC3339Nano, current)
	candidateAt, candidateErr := time.Parse(time.RFC3339Nano, candidate)
	if currentErr != nil || candidateErr != nil {
		if candidate > current {
			return candidate
		}
		return current
	}
	if candidateAt.After(currentAt) {
		return candidate
	}
	return current
}

func googleFormsSourceID(formID, id string) string {
	formID = strings.TrimSpace(formID)
	id = strings.TrimSpace(id)
	if formID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "google-forms://response/" + formID + "/" + id
}

func googleFormsTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"google-forms", "google-forms:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func googleFormsResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
