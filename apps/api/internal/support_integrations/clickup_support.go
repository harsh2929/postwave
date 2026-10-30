// SPDX-License-Identifier: AGPL-3.0-only
//
// clickup_support.go — native ClickUp Support provider runtime.
//
// ClickUp support workflows are task/list based. This runtime pages tasks from
// a configured list or workspace/team endpoint, hydrates task comments, and maps
// requester evidence into canonical support tickets/messages.
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
	clickUpDefaultAPIBaseURL   = "https://api.clickup.com/api/v2"
	clickUpDefaultUserAgent    = "Moosewave ClickUp Support Integration"
	clickUpResponseMaxBytes    = 16 << 20
	clickUpCursorPrefix        = "clickup-support:"
	clickUpCursorComplete      = "clickup-support:complete"
	clickUpDefaultPageSize     = 100
	clickUpDefaultCommentLimit = 25
)

var clickUpEmailRE = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)

type ClickUpSupportCredentials struct {
	Token      string
	UseBearer  bool
	APIBaseURL string
	UserAgent  string
}

type ClickUpSupportCredentialResolver interface {
	ResolveClickUpSupport(ctx context.Context, tenantID string, integration Integration) (ClickUpSupportCredentials, error)
}

type clickUpCredentialPayload struct {
	AccessToken   string `json:"access_token"`
	BearerToken   string `json:"bearer_token"`
	Token         string `json:"token"`
	PersonalToken string `json:"personal_token"`
	APIKey        string `json:"api_key"`
	APIBaseURL    string `json:"api_base_url"`
	UserAgent     string `json:"user_agent"`
}

func (p clickUpCredentialPayload) credentials() (ClickUpSupportCredentials, error) {
	raw := strings.TrimSpace(firstString(p.PersonalToken, p.APIKey, p.Token, p.AccessToken, p.BearerToken))
	if raw == "" {
		return ClickUpSupportCredentials{}, fmt.Errorf("clickup support access token is required")
	}
	useBearer := false
	if strings.HasPrefix(strings.ToLower(raw), "bearer ") {
		raw = strings.TrimSpace(raw[7:])
		useBearer = true
	} else if strings.TrimSpace(firstString(p.AccessToken, p.BearerToken)) != "" && strings.TrimSpace(firstString(p.PersonalToken, p.APIKey, p.Token)) == "" {
		useBearer = true
	}
	return ClickUpSupportCredentials{
		Token:      raw,
		UseBearer:  useBearer,
		APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:  strings.TrimSpace(p.UserAgent),
	}, nil
}

type ClickUpSupportSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r ClickUpSupportSecretsCredentialResolver) ResolveClickUpSupport(ctx context.Context, _ string, integration Integration) (ClickUpSupportCredentials, error) {
	if r.Secrets == nil {
		return ClickUpSupportCredentials{}, fmt.Errorf("clickup support credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return ClickUpSupportCredentials{}, fmt.Errorf("clickup support credentials_ref is required")
	}
	var payload clickUpCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withClickUpSupportSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ClickUpSupportCredentials{}, fmt.Errorf("resolve clickup support credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withClickUpSupportSettings(creds, integration), nil
			}
		}
	}
	creds, err := (clickUpCredentialPayload{Token: raw}).credentials()
	if err != nil {
		return ClickUpSupportCredentials{}, err
	}
	return withClickUpSupportSettings(creds, integration), nil
}

func withClickUpSupportSettings(creds ClickUpSupportCredentials, integration Integration) ClickUpSupportCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type ClickUpSupportBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type ClickUpSupportTaskRefresher interface {
	RefreshTask(ctx context.Context, tenantID string, integration Integration, taskID string) (SyncRequest, error)
}

type ClickUpSupportRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ClickUpSupportCredentialResolver
	APIBaseURL  string
	UserAgent   string
}

type clickUpTasksResponse struct {
	Tasks    []clickUpTask `json:"tasks"`
	LastPage bool          `json:"last_page"`
}

type clickUpTaskResponse struct {
	clickUpTask
}

type clickUpCommentsResponse struct {
	Comments []clickUpComment `json:"comments"`
}

type clickUpTask struct {
	ID           string               `json:"id"`
	Name         string               `json:"name"`
	TextContent  string               `json:"text_content"`
	Description  string               `json:"description"`
	URL          string               `json:"url"`
	DateCreated  string               `json:"date_created"`
	DateUpdated  string               `json:"date_updated"`
	Status       clickUpStatus        `json:"status"`
	Priority     clickUpPriority      `json:"priority"`
	Creator      clickUpUser          `json:"creator"`
	Assignees    []clickUpUser        `json:"assignees"`
	CustomFields []clickUpCustomField `json:"custom_fields"`
}

type clickUpComment struct {
	ID          string      `json:"id"`
	CommentText string      `json:"comment_text"`
	Comment     []any       `json:"comment"`
	Date        string      `json:"date"`
	User        clickUpUser `json:"user"`
}

type clickUpStatus struct {
	Status string `json:"status"`
	Type   string `json:"type"`
}

type clickUpPriority struct {
	ID       string `json:"id"`
	Priority string `json:"priority"`
	Color    string `json:"color"`
}

type clickUpUser struct {
	ID       any    `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email"`
}

type clickUpCustomField struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value any    `json:"value"`
}

func (b ClickUpSupportRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderClickUpSupport {
		return SyncRequest{}, fmt.Errorf("clickup support backfill requires a ClickUp Support integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("clickup support credential resolver is not configured")
	}
	page, done := clickUpPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: clickUpCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveClickUpSupport(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), clickUpDefaultAPIBaseURL)
	path := "/team/" + url.PathEscape(settingString(integration.Settings, "workspace_id")) + "/task"
	if listID := strings.TrimSpace(settingString(integration.Settings, "list_id")); listID != "" {
		path = "/list/" + url.PathEscape(listID) + "/task"
	}
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("include_closed", "true")
	query.Set("subtasks", "true")
	query.Set("order_by", firstString(settingString(integration.Settings, "order_by"), "updated"))
	if updatedGT := strings.TrimSpace(settingString(integration.Settings, "date_updated_gt")); updatedGT != "" {
		query.Set("date_updated_gt", updatedGT)
	}
	var out clickUpTasksResponse
	if err := clickUpDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := []TicketInput{}
	messages := []MessageInput{}
	for _, task := range out.Tasks {
		ticket, ok := mapClickUpTask(task, integration)
		if !ok {
			continue
		}
		tickets = append(tickets, ticket)
		comments, err := b.fetchClickUpComments(ctx, client, baseURL, creds, ticket.ConversationID, ticket)
		if err != nil {
			return SyncRequest{}, err
		}
		messages = append(messages, comments...)
	}
	cursorOut := clickUpCursorComplete
	if !out.LastPage && len(out.Tasks) >= clickUpDefaultPageSize {
		cursorOut = clickUpCursorPrefix + strconv.Itoa(page+1)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: cursorOut}), nil
}

func (b ClickUpSupportRESTBackfiller) RefreshTask(ctx context.Context, tenantID string, integration Integration, taskID string) (SyncRequest, error) {
	if integration.Provider != ProviderClickUpSupport {
		return SyncRequest{}, fmt.Errorf("clickup support refresh requires a ClickUp Support integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("clickup support credential resolver is not configured")
	}
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveClickUpSupport(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), clickUpDefaultAPIBaseURL)
	var task clickUpTaskResponse
	if err := clickUpDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/task/"+url.PathEscape(taskID), nil, &task); err != nil {
		return SyncRequest{}, err
	}
	ticket, ok := mapClickUpTask(task.clickUpTask, integration)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: "clickup-support-task-" + taskID}, nil
	}
	messages, err := b.fetchClickUpComments(ctx, client, baseURL, creds, ticket.ConversationID, ticket)
	if err != nil {
		return SyncRequest{}, err
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "clickup-support-task-" + taskID}), nil
}

func (b ClickUpSupportRESTBackfiller) fetchClickUpComments(ctx context.Context, client *http.Client, baseURL string, creds ClickUpSupportCredentials, taskID string, ticket TicketInput) ([]MessageInput, error) {
	var out clickUpCommentsResponse
	if err := clickUpDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/task/"+url.PathEscape(taskID)+"/comment", nil, &out); err != nil {
		return nil, err
	}
	return mapClickUpComments(out.Comments, ticket), nil
}

func (b ClickUpSupportRESTBackfiller) client() *http.Client {
	return supportEgressClient(b.HTTPClient, ProviderClickUpSupport, 30*time.Second)
}

func mapClickUpTask(task clickUpTask, integration Integration) (TicketInput, bool) {
	id := strings.TrimSpace(task.ID)
	email := strings.ToLower(strings.TrimSpace(firstString(
		task.Creator.Email,
		clickUpEmailFromCustomFields(task.CustomFields),
		clickUpEmailRE.FindString(firstString(task.TextContent, task.Description)),
		clickUpAssigneeEmail(task.Assignees),
		settingString(integration.Settings, "default_email"),
	)))
	if id == "" || email == "" {
		return TicketInput{}, false
	}
	return TicketInput{
		SourceID:       "clickup-support://task/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  task.Creator.Username,
		Subject:        firstString(task.Name, "ClickUp task "+id),
		Status:         firstString(task.Status.Status, task.Status.Type),
		Priority:       task.Priority.Priority,
		Assignee:       clickUpAssigneeEmail(task.Assignees),
		Properties: map[string]any{
			"clickup_task_id":        id,
			"clickup_task_url":       task.URL,
			"clickup_status_type":    task.Status.Type,
			"clickup_priority_id":    task.Priority.ID,
			"clickup_priority_color": task.Priority.Color,
		},
		UpdatedAt: firstTime(clickUpTime(task.DateUpdated), clickUpTime(task.DateCreated)),
	}, true
}

func mapClickUpComments(comments []clickUpComment, ticket TicketInput) []MessageInput {
	out := []MessageInput{}
	for _, comment := range comments {
		if mapped, ok := mapClickUpComment(comment, ticket); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapClickUpComment(comment clickUpComment, ticket TicketInput) (MessageInput, bool) {
	body := strings.TrimSpace(comment.CommentText)
	if body == "" && len(comment.Comment) > 0 {
		body = strings.TrimSpace(fmt.Sprint(comment.Comment))
	}
	if comment.ID == "" && body == "" {
		return MessageInput{}, false
	}
	direction, senderType := "outbound", "agent"
	if strings.EqualFold(comment.User.Email, ticket.Email) {
		direction, senderType = "inbound", "customer"
	}
	return MessageInput{
		SourceID:       "clickup-support://task/" + ticket.ConversationID + "/comment/" + firstString(comment.ID, clickUpLocalHash([]byte(body))),
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         firstString(comment.User.Email, comment.User.Username),
		BodyText:       body,
		Properties: map[string]any{
			"clickup_comment_id": comment.ID,
		},
		OccurredAt: clickUpTime(comment.Date),
	}, true
}

func clickUpDoJSON(ctx context.Context, client *http.Client, baseURL string, creds ClickUpSupportCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := helpCrunchBuildURL(baseURL, path, query)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	auth := strings.TrimSpace(creds.Token)
	if creds.UseBearer {
		auth = "Bearer " + auth
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, clickUpDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, clickUpResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return ClickUpSupportRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseClickUpRetryAfter(resp.Header), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("decode clickup support response %s: %w", path, err)
		}
	}
	return nil
}

type ClickUpSupportRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e ClickUpSupportRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("clickup support REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("clickup support REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func parseClickUpRetryAfter(header http.Header) time.Duration {
	if retry := parseZendeskRetryAfter(header.Get("Retry-After")); retry > 0 {
		return retry
	}
	if reset := strings.TrimSpace(header.Get("X-RateLimit-Reset")); reset != "" {
		if unix, err := strconv.ParseInt(reset, 10, 64); err == nil {
			delay := time.Until(time.Unix(unix, 0))
			if delay > 0 {
				return delay
			}
		}
	}
	return 0
}

func clickUpPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == clickUpCursorComplete {
		return 0, true
	}
	cursor = strings.TrimPrefix(cursor, clickUpCursorPrefix)
	if cursor == "" {
		return 0, false
	}
	page, err := strconv.Atoi(cursor)
	if err != nil || page < 0 {
		return 0, false
	}
	return page, false
}

func decodeClickUpSupportCursor(cursor string) string {
	if _, done := clickUpPageCursor(cursor); done {
		return clickUpCursorComplete
	}
	return strings.TrimPrefix(strings.TrimSpace(cursor), clickUpCursorPrefix)
}

func clickUpTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if ms, err := strconv.ParseInt(raw, 10, 64); err == nil {
		utc := time.UnixMilli(ms).UTC()
		return &utc
	}
	return parseZendeskTime(raw)
}

func clickUpAssigneeEmail(users []clickUpUser) string {
	for _, user := range users {
		if strings.TrimSpace(user.Email) != "" {
			return strings.ToLower(strings.TrimSpace(user.Email))
		}
	}
	return ""
}

func clickUpEmailFromCustomFields(fields []clickUpCustomField) string {
	for _, field := range fields {
		if strings.Contains(strings.ToLower(field.Name), "email") || strings.Contains(strings.ToLower(field.Type), "email") {
			if email := clickUpEmailRE.FindString(fmt.Sprint(field.Value)); email != "" {
				return strings.ToLower(email)
			}
		}
	}
	for _, field := range fields {
		if email := clickUpEmailRE.FindString(fmt.Sprint(field.Value)); email != "" {
			return strings.ToLower(email)
		}
	}
	return ""
}
