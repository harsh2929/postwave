// SPDX-License-Identifier: AGPL-3.0-only
//
// asana_support.go — native Asana Support provider runtime.
//
// Asana exposes task-based support workflows through REST tasks and task
// stories. This runtime pages tasks from a configured support project (or
// workspace-level task listing), hydrates task stories, and maps comments into
// canonical support messages.
package support_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	asanaDefaultAPIBaseURL = "https://app.asana.com/api/1.0"
	asanaDefaultUserAgent  = "Moosewave Asana Support Integration"
	asanaResponseMaxBytes  = 16 << 20
	asanaCursorPrefix      = "asana-support:"
	asanaCursorComplete    = "asana-support:complete"
	asanaDefaultPageSize   = 100
	asanaMaxPageSize       = 100
	asanaMaxStoryPageLoops = 100
	asanaTaskOptFields     = "gid,name,notes,completed,completed_at,created_at,modified_at,permalink_url,assignee.name,assignee.email,created_by.name,created_by.email,custom_fields.name,custom_fields.display_value,custom_fields.text_value,custom_fields.enum_value.name"
	asanaStoryOptFields    = "gid,text,html_text,type,created_at,created_by.name,created_by.email"
)

var asanaEmailRE = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)

type AsanaSupportCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type AsanaSupportCredentialResolver interface {
	ResolveAsanaSupport(ctx context.Context, tenantID string, integration Integration) (AsanaSupportCredentials, error)
}

type asanaCredentialPayload struct {
	AccessToken string `json:"access_token"`
	BearerToken string `json:"bearer_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p asanaCredentialPayload) credentials() (AsanaSupportCredentials, error) {
	token := strings.TrimPrefix(strings.TrimSpace(firstString(p.AccessToken, p.BearerToken, p.Token, p.APIKey)), "Bearer ")
	if token == "" {
		return AsanaSupportCredentials{}, fmt.Errorf("asana support access_token is required")
	}
	return AsanaSupportCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

type AsanaSupportSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r AsanaSupportSecretsCredentialResolver) ResolveAsanaSupport(ctx context.Context, _ string, integration Integration) (AsanaSupportCredentials, error) {
	if r.Secrets == nil {
		return AsanaSupportCredentials{}, fmt.Errorf("asana support credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return AsanaSupportCredentials{}, fmt.Errorf("asana support credentials_ref is required")
	}
	var payload asanaCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withAsanaSupportSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return AsanaSupportCredentials{}, fmt.Errorf("resolve asana support credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withAsanaSupportSettings(creds, integration), nil
			}
		}
	}
	creds, err := (asanaCredentialPayload{AccessToken: raw}).credentials()
	if err != nil {
		return AsanaSupportCredentials{}, err
	}
	return withAsanaSupportSettings(creds, integration), nil
}

func withAsanaSupportSettings(creds AsanaSupportCredentials, integration Integration) AsanaSupportCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type AsanaSupportBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type AsanaSupportTaskRefresher interface {
	RefreshTask(ctx context.Context, tenantID string, integration Integration, taskID string) (SyncRequest, error)
}

type AsanaSupportRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials AsanaSupportCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type asanaTasksResponse struct {
	Data     []asanaTask   `json:"data"`
	NextPage asanaNextPage `json:"next_page"`
}

type asanaTaskResponse struct {
	Data asanaTask `json:"data"`
}

type asanaStoriesResponse struct {
	Data     []asanaStory  `json:"data"`
	NextPage asanaNextPage `json:"next_page"`
}

type asanaNextPage struct {
	Offset string `json:"offset"`
	Path   string `json:"path"`
	URI    string `json:"uri"`
}

type asanaTask struct {
	GID          string             `json:"gid"`
	Name         string             `json:"name"`
	Notes        string             `json:"notes"`
	Completed    bool               `json:"completed"`
	CompletedAt  string             `json:"completed_at"`
	CreatedAt    string             `json:"created_at"`
	ModifiedAt   string             `json:"modified_at"`
	PermalinkURL string             `json:"permalink_url"`
	Assignee     asanaUser          `json:"assignee"`
	CreatedBy    asanaUser          `json:"created_by"`
	CustomFields []asanaCustomField `json:"custom_fields"`
}

type asanaStory struct {
	GID       string    `json:"gid"`
	Text      string    `json:"text"`
	HTMLText  string    `json:"html_text"`
	Type      string    `json:"type"`
	CreatedAt string    `json:"created_at"`
	CreatedBy asanaUser `json:"created_by"`
}

type asanaUser struct {
	GID   string `json:"gid"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type asanaCustomField struct {
	Name         string `json:"name"`
	DisplayValue string `json:"display_value"`
	TextValue    string `json:"text_value"`
	EnumValue    struct {
		Name string `json:"name"`
	} `json:"enum_value"`
}

func (b AsanaSupportRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderAsanaSupport {
		return SyncRequest{}, fmt.Errorf("asana support backfill requires an Asana Support integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("asana support credential resolver is not configured")
	}
	offset, done := asanaOffsetCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: asanaCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveAsanaSupport(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), asanaDefaultAPIBaseURL)
	path := "/tasks"
	query := url.Values{}
	if projectID := strings.TrimSpace(settingString(integration.Settings, "project_id")); projectID != "" {
		path = "/projects/" + url.PathEscape(projectID) + "/tasks"
	} else {
		query.Set("workspace", settingString(integration.Settings, "workspace_id"))
	}
	query.Set("limit", strconv.Itoa(asanaPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	query.Set("opt_fields", asanaTaskOptFields)
	if offset != "" {
		query.Set("offset", offset)
	}
	var page asanaTasksResponse
	if err := asanaDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, query, &page); err != nil {
		return SyncRequest{}, err
	}
	tickets := []TicketInput{}
	messages := []MessageInput{}
	for _, task := range page.Data {
		ticket, ok := mapAsanaTask(task, integration)
		if !ok {
			continue
		}
		tickets = append(tickets, ticket)
		stories, err := b.fetchAsanaStories(ctx, client, baseURL, creds, ticket.ConversationID, ticket)
		if err != nil {
			return SyncRequest{}, err
		}
		messages = append(messages, stories...)
	}
	cursorOut := asanaCursorComplete
	if page.NextPage.Offset != "" {
		cursorOut = asanaCursorPrefix + page.NextPage.Offset
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: cursorOut}), nil
}

func (b AsanaSupportRESTBackfiller) RefreshTask(ctx context.Context, tenantID string, integration Integration, taskID string) (SyncRequest, error) {
	if integration.Provider != ProviderAsanaSupport {
		return SyncRequest{}, fmt.Errorf("asana support refresh requires an Asana Support integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("asana support credential resolver is not configured")
	}
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveAsanaSupport(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), asanaDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("opt_fields", asanaTaskOptFields)
	var out asanaTaskResponse
	if err := asanaDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/tasks/"+url.PathEscape(taskID), query, &out); err != nil {
		return SyncRequest{}, err
	}
	ticket, ok := mapAsanaTask(out.Data, integration)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: "asana-support-task-" + taskID}, nil
	}
	messages, err := b.fetchAsanaStories(ctx, client, baseURL, creds, ticket.ConversationID, ticket)
	if err != nil {
		return SyncRequest{}, err
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "asana-support-task-" + taskID}), nil
}

func (b AsanaSupportRESTBackfiller) fetchAsanaStories(ctx context.Context, client *http.Client, baseURL string, creds AsanaSupportCredentials, taskID string, ticket TicketInput) ([]MessageInput, error) {
	out := []MessageInput{}
	offset := ""
	for loops := 0; loops < asanaMaxStoryPageLoops; loops++ {
		query := url.Values{}
		query.Set("limit", strconv.Itoa(asanaDefaultPageSize))
		query.Set("opt_fields", asanaStoryOptFields)
		if offset != "" {
			query.Set("offset", offset)
		}
		var page asanaStoriesResponse
		if err := asanaDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/tasks/"+url.PathEscape(taskID)+"/stories", query, &page); err != nil {
			return nil, err
		}
		out = append(out, mapAsanaStories(page.Data, ticket)...)
		if page.NextPage.Offset == "" {
			return out, nil
		}
		offset = page.NextPage.Offset
	}
	return out, nil
}

func (b AsanaSupportRESTBackfiller) client() *http.Client {
	return supportEgressClient(b.HTTPClient, ProviderAsanaSupport, 30*time.Second)
}

func mapAsanaTask(task asanaTask, integration Integration) (TicketInput, bool) {
	id := strings.TrimSpace(task.GID)
	email := strings.ToLower(strings.TrimSpace(firstString(
		task.CreatedBy.Email,
		asanaEmailFromCustomFields(task.CustomFields),
		asanaEmailRE.FindString(task.Notes),
		task.Assignee.Email,
		settingString(integration.Settings, "default_email"),
	)))
	if id == "" || email == "" {
		return TicketInput{}, false
	}
	status := "open"
	if task.Completed {
		status = "closed"
	}
	return TicketInput{
		SourceID:       "asana-support://task/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  firstString(task.CreatedBy.Name, task.Assignee.Name),
		Subject:        firstString(task.Name, "Asana task "+id),
		Status:         status,
		Assignee:       firstString(task.Assignee.Email, task.Assignee.Name),
		Properties: map[string]any{
			"asana_task_gid":     id,
			"asana_permalink":    task.PermalinkURL,
			"asana_completed_at": task.CompletedAt,
		},
		UpdatedAt: firstTime(parseZendeskTime(task.ModifiedAt), parseZendeskTime(task.CreatedAt)),
	}, true
}

func mapAsanaStories(stories []asanaStory, ticket TicketInput) []MessageInput {
	out := []MessageInput{}
	for _, story := range stories {
		if mapped, ok := mapAsanaStory(story, ticket); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapAsanaStory(story asanaStory, ticket TicketInput) (MessageInput, bool) {
	body := strings.TrimSpace(story.Text)
	if body == "" {
		body = strings.TrimSpace(story.HTMLText)
	}
	if story.GID == "" && body == "" {
		return MessageInput{}, false
	}
	direction, senderType := "outbound", "agent"
	if strings.EqualFold(story.CreatedBy.Email, ticket.Email) {
		direction, senderType = "inbound", "customer"
	}
	if strings.EqualFold(story.Type, "system") {
		direction, senderType = "internal", "system"
	}
	return MessageInput{
		SourceID:       "asana-support://task/" + ticket.ConversationID + "/story/" + firstString(story.GID, asanaLocalHash([]byte(body))),
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         firstString(story.CreatedBy.Email, story.CreatedBy.Name),
		BodyText:       body,
		BodyHTML:       story.HTMLText,
		Properties: map[string]any{
			"asana_story_gid":  story.GID,
			"asana_story_type": story.Type,
		},
		OccurredAt: parseZendeskTime(story.CreatedAt),
	}, true
}

func asanaDoJSON(ctx context.Context, client *http.Client, baseURL string, creds AsanaSupportCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := helpCrunchBuildURL(baseURL, path, query)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, asanaDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, asanaResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return AsanaSupportRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("decode asana support response %s: %w", path, err)
		}
	}
	return nil
}

type AsanaSupportRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e AsanaSupportRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("asana support REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("asana support REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func asanaOffsetCursor(cursor string) (string, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == asanaCursorComplete {
		return "", true
	}
	return strings.TrimPrefix(cursor, asanaCursorPrefix), false
}

func decodeAsanaSupportCursor(cursor string) string {
	if _, done := asanaOffsetCursor(cursor); done {
		return asanaCursorComplete
	}
	return strings.TrimPrefix(strings.TrimSpace(cursor), asanaCursorPrefix)
}

func asanaPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return asanaDefaultPageSize
	}
	if n > asanaMaxPageSize {
		return asanaMaxPageSize
	}
	return n
}

func asanaEmailFromCustomFields(fields []asanaCustomField) string {
	for _, field := range fields {
		if strings.Contains(strings.ToLower(field.Name), "email") {
			if email := strings.TrimSpace(firstString(field.DisplayValue, field.TextValue, field.EnumValue.Name)); email != "" {
				return strings.ToLower(asanaEmailRE.FindString(email))
			}
		}
	}
	for _, field := range fields {
		if email := asanaEmailRE.FindString(firstString(field.DisplayValue, field.TextValue, field.EnumValue.Name)); email != "" {
			return strings.ToLower(email)
		}
	}
	return ""
}
