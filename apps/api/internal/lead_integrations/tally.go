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
	tallyCursorPrefix      = "tally:"
	tallyCursorComplete    = "tally:complete"
	tallyDefaultAPIBaseURL = "https://api.tally.so"
	tallyResponseMaxBytes  = 8 << 20
	tallyDefaultPageSize   = 100
	tallyMaxPageSize       = 500
	tallyDefaultUserAgent  = "Moosewave Tally Integration"
)

type TallyCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type TallyCredentialResolver interface {
	ResolveTally(context.Context, string, Integration) (TallyCredentials, error)
}

type TallyBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type TallyRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials TallyCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type TallyRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type TallySecretsCredentialResolver struct {
	Secrets TallyRuntimeSecretResolver
}

func NewTallySecretsCredentialResolver(secrets TallyRuntimeSecretResolver) *TallySecretsCredentialResolver {
	return &TallySecretsCredentialResolver{Secrets: secrets}
}

func (r *TallySecretsCredentialResolver) ResolveTally(ctx context.Context, _ string, integration Integration) (TallyCredentials, error) {
	if r == nil || r.Secrets == nil {
		return TallyCredentials{}, fmt.Errorf("tally credential resolver is not configured")
	}
	ref := tallyCredentialRef(integration)
	if ref == "" {
		return TallyCredentials{}, fmt.Errorf("tally credentials_ref is required")
	}
	var payload tallyCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return TallyCredentials{}, fmt.Errorf("resolve tally credentials %q: %w", ref, err)
		}
		return parseTallyCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return TallyCredentials{}, fmt.Errorf("resolve tally credentials %q: %w", ref, err)
	}
	return parseTallyCredentialSecret(raw)
}

type tallyCredentialPayload struct {
	AccessToken string `json:"access_token"`
	APIKey      string `json:"api_key"`
	Token       string `json:"token"`
	BearerToken string `json:"bearer_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p tallyCredentialPayload) credentials() (TallyCredentials, error) {
	token := normalizeTallyBearerToken(firstString(p.AccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return TallyCredentials{}, fmt.Errorf("tally api_key or access_token is required")
	}
	return TallyCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseTallyCredentialSecret(raw string) (TallyCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return TallyCredentials{}, fmt.Errorf("tally credentials are empty")
	}
	var payload tallyCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return TallyCredentials{}, fmt.Errorf("parse tally credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseTallyKeyValueSecret(raw).credentials()
	}
	return tallyCredentialPayload{AccessToken: raw}.credentials()
}

func parseTallyKeyValueSecret(raw string) tallyCredentialPayload {
	var payload tallyCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token":
			payload.AccessToken = value
		case "api_key":
			payload.APIKey = value
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

func normalizeTallyBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func tallyCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b TallyRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderTally {
		return SyncRequest{}, fmt.Errorf("tally backfill requires a Tally integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("tally credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("tally form_id is required")
	}
	creds, err := b.Credentials.ResolveTally(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("tally access token is required")
	}
	state, err := decodeTallyCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: tallyCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderTally, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), tallyDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), tallyDefaultUserAgent)
	pageSize := tallyPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	page := state.Page
	if page <= 0 {
		page = 1
	}
	pageOut, err := fetchTallySubmissions(ctx, client, baseURL, creds.AccessToken, userAgent, formID, page, pageSize)
	if err != nil {
		return SyncRequest{}, err
	}
	items := pageOut.Submissions
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	for _, item := range items {
		submission := mapTallySubmission(item, pageOut.Questions, integration, formID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	if !pageOut.HasMore || len(items) == 0 {
		req.Cursor = tallyCursorComplete
	} else {
		req.Cursor = encodeTallyCursor(tallyCursorState{Page: page + 1})
	}
	return req, nil
}

type tallyCursorState struct {
	Page     int  `json:"page,omitempty"`
	Complete bool `json:"complete,omitempty"`
}

func decodeTallyCursor(cursor string) (tallyCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return tallyCursorState{Page: 1}, nil
	}
	if cursor == tallyCursorComplete {
		return tallyCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, tallyCursorPrefix) {
		return tallyCursorState{}, fmt.Errorf("invalid Tally cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, tallyCursorPrefix))
	if raw == "" {
		return tallyCursorState{Page: 1}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return tallyCursorState{}, fmt.Errorf("invalid Tally cursor")
	}
	var out tallyCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return tallyCursorState{}, fmt.Errorf("invalid Tally cursor")
	}
	if out.Page <= 0 {
		out.Page = 1
	}
	return out, nil
}

func encodeTallyCursor(state tallyCursorState) string {
	if state.Complete {
		return tallyCursorComplete
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	raw, _ := json.Marshal(state)
	return tallyCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type tallySubmissionsResponse struct {
	Submissions []tallySubmission `json:"submissions"`
	Questions   []tallyQuestion   `json:"questions"`
	HasMore     bool              `json:"hasMore"`
	Page        int               `json:"page"`
	Limit       int               `json:"limit"`
}

type tallyQuestion struct {
	ID     string               `json:"id"`
	Title  string               `json:"title"`
	Type   string               `json:"type"`
	Fields []tallyQuestionField `json:"fields"`
}

type tallyQuestionField struct {
	UUID         string `json:"uuid"`
	Title        string `json:"title"`
	Type         string `json:"type"`
	QuestionType string `json:"questionType"`
}

type tallySubmission struct {
	ID           string          `json:"id"`
	FormID       string          `json:"formId"`
	FormName     string          `json:"formName"`
	RespondentID string          `json:"respondentId"`
	IsCompleted  bool            `json:"isCompleted"`
	CreatedAt    string          `json:"createdAt"`
	SubmittedAt  string          `json:"submittedAt"`
	PreviewURL   string          `json:"previewUrl"`
	PDFURL       string          `json:"pdfUrl"`
	Responses    []tallyResponse `json:"responses"`
	Fields       []tallyField    `json:"fields"`
	Raw          map[string]any  `json:"-"`
}

func (s *tallySubmission) UnmarshalJSON(raw []byte) error {
	type alias tallySubmission
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*s = tallySubmission(out)
	s.Raw = nonNilMap(rawMap)
	return nil
}

type tallyField struct {
	ID    string `json:"id"`
	Key   string `json:"key"`
	Label string `json:"label"`
	Title string `json:"title"`
	Type  string `json:"type"`
	Value any    `json:"value"`
}

type tallyResponse struct {
	ID              string `json:"id"`
	FormID          string `json:"formId"`
	QuestionID      string `json:"questionId"`
	RespondentID    string `json:"respondentId"`
	SessionUUID     string `json:"sessionUuid"`
	Answer          any    `json:"answer"`
	FormattedAnswer any    `json:"formattedAnswer"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	SubmissionID    string `json:"submissionId"`
}

func fetchTallySubmissions(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID string, page, limit int) (tallySubmissionsResponse, error) {
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("limit", strconv.Itoa(tallyPageSize(limit)))
	raw, err := tallyDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/forms/"+url.PathEscape(formID)+"/submissions", query, nil)
	if err != nil {
		return tallySubmissionsResponse{}, err
	}
	var out tallySubmissionsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return tallySubmissionsResponse{}, fmt.Errorf("decode tally submissions response: %w", err)
	}
	return out, nil
}

func tallyDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
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
	req.Header.Set("User-Agent", firstString(userAgent, tallyDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, tallyResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, TallyProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: tallyResponseSnippet(raw)}
	}
	return raw, nil
}

type TallyProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e TallyProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("tally REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("tally REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapTallySubmission(item tallySubmission, questions []tallyQuestion, integration Integration, fallbackFormID string) SubmissionInput {
	formID := firstString(item.FormID, fallbackFormID, settingString(integration.Settings, "form_id"))
	fields := map[string]any{
		"tally_submission_id": item.ID,
		"tally_form_id":       formID,
		"tally_respondent_id": item.RespondentID,
		"tally_is_completed":  item.IsCompleted,
		"tally_created_at":    item.CreatedAt,
		"tally_submitted_at":  item.SubmittedAt,
		"tally_preview_url":   item.PreviewURL,
		"tally_pdf_url":       item.PDFURL,
		"tally_provider_raw":  item.Raw,
	}
	identity := typeformIdentity{}
	questionLookup := tallyQuestionLookup(questions)
	for _, response := range item.Responses {
		question := questionLookup[strings.TrimSpace(response.QuestionID)]
		key := firstString(question.Title, response.QuestionID, response.ID)
		if key == "" {
			continue
		}
		value := normalizeTallyValue(firstAny(response.FormattedAnswer, response.Answer))
		normalizedKey := normalizeTypeformIdentityKey(key)
		fields["tally_response."+normalizedKey] = value
		fields["tally_response_id."+normalizedKey] = response.ID
		applyTallyIdentity(&identity, tallyField{
			ID:    response.QuestionID,
			Key:   response.QuestionID,
			Label: question.Title,
			Title: question.Title,
			Type:  firstString(question.Type, tallyQuestionFieldType(question)),
			Value: value,
		}, value)
	}
	for _, field := range item.Fields {
		key := firstString(field.Key, field.Label, field.Title, field.ID)
		if key == "" {
			continue
		}
		value := normalizeTallyValue(field.Value)
		fields["tally_field."+normalizeTypeformIdentityKey(key)] = value
		applyTallyIdentity(&identity, field, value)
	}
	submittedAt := parseFilloutTime(firstString(item.SubmittedAt, item.CreatedAt))
	return SubmissionInput{
		SourceID:    tallySourceID(formID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(item.FormName, settingString(integration.Settings, "form_name")),
		EventName:   "lead.submitted",
		Tags:        tallyTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func tallyQuestionLookup(questions []tallyQuestion) map[string]tallyQuestion {
	out := map[string]tallyQuestion{}
	for _, question := range questions {
		if key := strings.TrimSpace(question.ID); key != "" {
			out[key] = question
		}
		for _, field := range question.Fields {
			if key := strings.TrimSpace(field.UUID); key != "" {
				out[key] = question
			}
		}
	}
	return out
}

func tallyQuestionFieldType(question tallyQuestion) string {
	for _, field := range question.Fields {
		if field.QuestionType != "" {
			return field.QuestionType
		}
		if field.Type != "" {
			return field.Type
		}
	}
	return ""
}

func firstAny(values ...any) any {
	for _, value := range values {
		switch typed := value.(type) {
		case nil:
			continue
		case string:
			if strings.TrimSpace(typed) == "" {
				continue
			}
			return typed
		default:
			return value
		}
	}
	return nil
}

func applyTallyIdentity(identity *typeformIdentity, field tallyField, value any) {
	if identity == nil {
		return
	}
	label := firstString(field.Label, field.Title, field.Key, field.ID)
	text := strings.TrimSpace(fmt.Sprint(value))
	typ := strings.ToLower(field.Type)
	if strings.Contains(typ, "email") && identity.Email == "" {
		identity.Email = text
	}
	if strings.Contains(typ, "phone") && identity.Phone == "" {
		identity.Phone = text
	}
	applyFilloutStructuredIdentity(identity, value)
	identity.apply(label, text)
}

func normalizeTallyValue(value any) any {
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
			out = append(out, normalizeTallyValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeTallyValue(item)
		}
		return out
	default:
		return typed
	}
}

func tallyPageSize(size int) int {
	if size <= 0 {
		return tallyDefaultPageSize
	}
	if size > tallyMaxPageSize {
		return tallyMaxPageSize
	}
	return size
}

func tallySourceID(formID, id string) string {
	formID = strings.TrimSpace(formID)
	id = strings.TrimSpace(id)
	if formID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "tally://submission/" + formID + "/" + id
}

func tallyTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"tally", "tally:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func tallyResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
