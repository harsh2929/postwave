// SPDX-License-Identifier: AGPL-3.0-only
//
// jira_service_management.go — native Jira Service Management provider runtime.
//
// Jira Service Management Cloud exposes support requests through the
// servicedeskapi surface and comments through request-scoped comment pages. This
// runtime supports OAuth Bearer credentials against api.atlassian.com cloudId
// routes or direct site URLs, plus API-token Basic auth for operator/internal
// installs.
package support_integrations

import (
	"context"
	"encoding/base64"
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
	jiraServiceDefaultAPIBaseURL       = "https://api.atlassian.com/ex/jira"
	jiraServiceDefaultUserAgent        = "Moosewave Jira Service Management Integration"
	jiraServiceResponseMaxBytes        = 16 << 20
	jiraServiceCursorPrefix            = "jira-service-management:"
	jiraServiceCursorComplete          = "jira-service-management:complete"
	jiraServiceDefaultLimit            = 50
	jiraServiceMaxLimit                = 100
	jiraServiceMaxCommentPageLoops     = 100
	jiraServiceDefaultCommentPageLimit = 100
)

var jiraServiceEmailRE = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)

type JiraServiceManagementCredentials struct {
	AccessToken string
	Email       string
	APIToken    string
	APIBaseURL  string
	SiteURL     string
	CloudID     string
	UserAgent   string
}

type JiraServiceManagementCredentialResolver interface {
	ResolveJiraServiceManagement(ctx context.Context, tenantID string, integration Integration) (JiraServiceManagementCredentials, error)
}

type jiraServiceCredentialPayload struct {
	AccessToken string `json:"access_token"`
	BearerToken string `json:"bearer_token"`
	Token       string `json:"token"`
	Email       string `json:"email"`
	APIToken    string `json:"api_token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	SiteURL     string `json:"site_url"`
	CloudID     string `json:"cloud_id"`
	SiteID      string `json:"site_id"`
	UserAgent   string `json:"user_agent"`
}

func (p jiraServiceCredentialPayload) credentials() (JiraServiceManagementCredentials, error) {
	accessToken := strings.TrimPrefix(strings.TrimSpace(firstString(p.AccessToken, p.BearerToken, p.Token)), "Bearer ")
	apiToken := strings.TrimSpace(firstString(p.APIToken, p.APIKey))
	if accessToken == "" && apiToken == "" {
		return JiraServiceManagementCredentials{}, fmt.Errorf("jira service management access_token or api_token is required")
	}
	if accessToken == "" && strings.TrimSpace(p.Email) == "" {
		return JiraServiceManagementCredentials{}, fmt.Errorf("jira service management email is required when using api_token")
	}
	return JiraServiceManagementCredentials{
		AccessToken: accessToken,
		Email:       strings.TrimSpace(p.Email),
		APIToken:    apiToken,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		SiteURL:     strings.TrimRight(strings.TrimSpace(p.SiteURL), "/"),
		CloudID:     strings.TrimSpace(firstString(p.CloudID, p.SiteID)),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

type JiraServiceManagementSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r JiraServiceManagementSecretsCredentialResolver) ResolveJiraServiceManagement(ctx context.Context, _ string, integration Integration) (JiraServiceManagementCredentials, error) {
	if r.Secrets == nil {
		return JiraServiceManagementCredentials{}, fmt.Errorf("jira service management credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return JiraServiceManagementCredentials{}, fmt.Errorf("jira service management credentials_ref is required")
	}
	var payload jiraServiceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withJiraServiceSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return JiraServiceManagementCredentials{}, fmt.Errorf("resolve jira service management credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withJiraServiceSettings(creds, integration), nil
			}
		}
	}
	creds, err := (jiraServiceCredentialPayload{AccessToken: raw}).credentials()
	if err != nil {
		return JiraServiceManagementCredentials{}, err
	}
	return withJiraServiceSettings(creds, integration), nil
}

func withJiraServiceSettings(creds JiraServiceManagementCredentials, integration Integration) JiraServiceManagementCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	if creds.SiteURL == "" {
		creds.SiteURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "site_url")), "/")
	}
	if creds.CloudID == "" {
		creds.CloudID = strings.TrimSpace(firstString(settingString(integration.Settings, "cloud_id"), settingString(integration.Settings, "site_id")))
	}
	return creds
}

type JiraServiceManagementBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type JiraServiceManagementRequestRefresher interface {
	RefreshRequest(ctx context.Context, tenantID string, integration Integration, issueIDOrKey string) (SyncRequest, error)
}

type JiraServiceManagementRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials JiraServiceManagementCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Limit       int
}

type jiraServiceRequestPage struct {
	Values     []jiraServiceRequest `json:"values"`
	Start      int                  `json:"start"`
	Limit      int                  `json:"limit"`
	Size       int                  `json:"size"`
	IsLastPage bool                 `json:"isLastPage"`
	Links      struct {
		Next string `json:"next"`
	} `json:"_links"`
}

type jiraServiceRequestResponse struct {
	JiraServiceRequest jiraServiceRequest `json:"request"`
	jiraServiceRequest
}

type jiraServiceCommentPage struct {
	Values     []jiraServiceComment `json:"values"`
	Start      int                  `json:"start"`
	Limit      int                  `json:"limit"`
	Size       int                  `json:"size"`
	IsLastPage bool                 `json:"isLastPage"`
	Links      struct {
		Next string `json:"next"`
	} `json:"_links"`
}

type jiraServiceRequest struct {
	IssueID            string                  `json:"issueId"`
	IssueKey           string                  `json:"issueKey"`
	ServiceDeskID      string                  `json:"serviceDeskId"`
	RequestTypeID      string                  `json:"requestTypeId"`
	Summary            string                  `json:"summary"`
	Description        string                  `json:"description"`
	RequestFieldValues []jiraServiceFieldValue `json:"requestFieldValues"`
	Reporter           jiraServiceUser         `json:"reporter"`
	CreatedDate        jiraServiceDate         `json:"createdDate"`
	CurrentStatus      struct {
		Status     string          `json:"status"`
		StatusDate jiraServiceDate `json:"statusDate"`
	} `json:"currentStatus"`
	Links struct {
		Web string `json:"web"`
	} `json:"_links"`
	Fields map[string]any `json:"fields,omitempty"`
}

type jiraServiceFieldValue struct {
	FieldID string `json:"fieldId"`
	Label   string `json:"label"`
	Value   any    `json:"value"`
}

type jiraServiceComment struct {
	ID      string          `json:"id"`
	Body    any             `json:"body"`
	Public  bool            `json:"public"`
	Author  jiraServiceUser `json:"author"`
	Created jiraServiceDate `json:"created"`
	Updated jiraServiceDate `json:"updated"`
}

type jiraServiceUser struct {
	AccountID    string `json:"accountId"`
	DisplayName  string `json:"displayName"`
	EmailAddress string `json:"emailAddress"`
	Name         string `json:"name"`
}

type jiraServiceDate struct {
	ISO8601 string `json:"iso8601"`
	Jira    string `json:"jira"`
}

func (b JiraServiceManagementRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderJiraServiceManagement {
		return SyncRequest{}, fmt.Errorf("jira service management backfill requires a Jira Service Management integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("jira service management credential resolver is not configured")
	}
	start, done := jiraServiceOffsetCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: jiraServiceCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveJiraServiceManagement(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := b.baseURL(creds, integration)
	limit := jiraServiceLimit(firstString(settingString(integration.Settings, "limit"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.Limit)))
	query := url.Values{}
	query.Set("serviceDeskId", settingString(integration.Settings, "service_desk_id"))
	query.Set("start", strconv.Itoa(start))
	query.Set("limit", strconv.Itoa(limit))
	if status := strings.TrimSpace(settingString(integration.Settings, "request_status")); status != "" {
		query.Set("requestStatus", status)
	}
	if orgID := strings.TrimSpace(settingString(integration.Settings, "organization_id")); orgID != "" {
		query.Set("organizationId", orgID)
	}
	var page jiraServiceRequestPage
	if err := jiraServiceDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/rest/servicedeskapi/request", query, &page); err != nil {
		return SyncRequest{}, err
	}
	tickets := []TicketInput{}
	messages := []MessageInput{}
	for _, request := range page.Values {
		if !jiraServiceRequestAllowed(integration, request) {
			continue
		}
		ticket, ok := mapJiraServiceRequest(request, integration)
		if !ok {
			continue
		}
		tickets = append(tickets, ticket)
		thread, err := b.fetchJiraServiceComments(ctx, client, baseURL, creds, ticket.ConversationID, ticket)
		if err != nil {
			return SyncRequest{}, err
		}
		messages = append(messages, thread...)
	}
	next := start + firstPositive(page.Size, len(page.Values), limit)
	cursorOut := jiraServiceCursorComplete
	if !page.IsLastPage && (page.Links.Next != "" || len(page.Values) >= limit) {
		cursorOut = jiraServiceCursorPrefix + strconv.Itoa(next)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: cursorOut}), nil
}

func (b JiraServiceManagementRESTBackfiller) RefreshRequest(ctx context.Context, tenantID string, integration Integration, issueIDOrKey string) (SyncRequest, error) {
	if integration.Provider != ProviderJiraServiceManagement {
		return SyncRequest{}, fmt.Errorf("jira service management refresh requires a Jira Service Management integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("jira service management credential resolver is not configured")
	}
	issueIDOrKey = strings.TrimSpace(issueIDOrKey)
	if issueIDOrKey == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveJiraServiceManagement(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := b.baseURL(creds, integration)
	var out jiraServiceRequestResponse
	if err := jiraServiceDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/rest/servicedeskapi/request/"+url.PathEscape(issueIDOrKey), nil, &out); err != nil {
		return SyncRequest{}, err
	}
	request := out.jiraServiceRequest
	if request.IssueID == "" && request.IssueKey == "" {
		request = out.JiraServiceRequest
	}
	ticket, ok := mapJiraServiceRequest(request, integration)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: "jira-service-management-request-" + issueIDOrKey}, nil
	}
	messages, err := b.fetchJiraServiceComments(ctx, client, baseURL, creds, ticket.ConversationID, ticket)
	if err != nil {
		return SyncRequest{}, err
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "jira-service-management-request-" + issueIDOrKey}), nil
}

func (b JiraServiceManagementRESTBackfiller) fetchJiraServiceComments(ctx context.Context, client *http.Client, baseURL string, creds JiraServiceManagementCredentials, issueIDOrKey string, ticket TicketInput) ([]MessageInput, error) {
	limit := jiraServiceLimit(firstString(settingString(ticket.Properties, "jira_service_management_comment_page_size"), strconv.Itoa(jiraServiceDefaultCommentPageLimit)))
	out := []MessageInput{}
	for start, loops := 0, 0; loops < jiraServiceMaxCommentPageLoops; loops++ {
		query := url.Values{}
		query.Set("start", strconv.Itoa(start))
		query.Set("limit", strconv.Itoa(limit))
		query.Set("public", "false")
		var page jiraServiceCommentPage
		if err := jiraServiceDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/rest/servicedeskapi/request/"+url.PathEscape(issueIDOrKey)+"/comment", query, &page); err != nil {
			return nil, err
		}
		out = append(out, mapJiraServiceComments(page.Values, ticket)...)
		if page.IsLastPage || (page.Links.Next == "" && len(page.Values) < limit) {
			return out, nil
		}
		start += firstPositive(page.Size, len(page.Values), limit)
	}
	return out, nil
}

func (b JiraServiceManagementRESTBackfiller) client() *http.Client {
	return supportEgressClient(b.HTTPClient, ProviderJiraServiceManagement, 30*time.Second)
}

func (b JiraServiceManagementRESTBackfiller) baseURL(creds JiraServiceManagementCredentials, integration Integration) string {
	if base := strings.TrimRight(strings.TrimSpace(firstString(b.APIBaseURL, creds.APIBaseURL)), "/"); base != "" {
		return base
	}
	if siteURL := strings.TrimRight(strings.TrimSpace(creds.SiteURL), "/"); siteURL != "" {
		return siteURL
	}
	if siteURL := strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "site_url")), "/"); siteURL != "" {
		return siteURL
	}
	cloudID := strings.TrimSpace(firstString(creds.CloudID, settingString(integration.Settings, "cloud_id"), settingString(integration.Settings, "site_id")))
	if strings.HasPrefix(cloudID, "http://") || strings.HasPrefix(cloudID, "https://") {
		return strings.TrimRight(cloudID, "/")
	}
	return strings.TrimRight(jiraServiceDefaultAPIBaseURL+"/"+url.PathEscape(cloudID), "/")
}

func mapJiraServiceRequest(request jiraServiceRequest, integration Integration) (TicketInput, bool) {
	id := firstString(request.IssueKey, request.IssueID)
	email := strings.ToLower(strings.TrimSpace(firstString(
		request.Reporter.EmailAddress,
		jiraServiceEmailFromFields(request.RequestFieldValues),
		jiraServiceEmailFromAny(request.Fields),
		settingString(integration.Settings, "default_email"),
	)))
	if id == "" || email == "" {
		return TicketInput{}, false
	}
	updatedAt := firstTime(jiraServiceDateTime(request.CurrentStatus.StatusDate), jiraServiceDateTime(request.CreatedDate))
	return TicketInput{
		SourceID:       "jira-service-management://request/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  firstString(request.Reporter.DisplayName, request.Reporter.Name),
		Subject:        firstString(request.Summary, "Jira Service Management request "+id),
		Status:         request.CurrentStatus.Status,
		Properties: map[string]any{
			"jira_service_management_issue_id":        request.IssueID,
			"jira_service_management_issue_key":       request.IssueKey,
			"jira_service_management_service_desk_id": request.ServiceDeskID,
			"jira_service_management_request_type_id": request.RequestTypeID,
			"jira_service_management_web_url":         request.Links.Web,
		},
		UpdatedAt: updatedAt,
	}, true
}

func mapJiraServiceComments(comments []jiraServiceComment, ticket TicketInput) []MessageInput {
	out := []MessageInput{}
	for _, comment := range comments {
		if mapped, ok := mapJiraServiceComment(comment, ticket); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapJiraServiceComment(comment jiraServiceComment, ticket TicketInput) (MessageInput, bool) {
	id := strings.TrimSpace(comment.ID)
	body := jiraServiceBodyText(comment.Body)
	if id == "" && body == "" {
		return MessageInput{}, false
	}
	direction, senderType := "outbound", "agent"
	if strings.EqualFold(comment.Author.EmailAddress, ticket.Email) {
		direction, senderType = "inbound", "customer"
	}
	if !comment.Public {
		direction, senderType = "internal", "agent"
	}
	return MessageInput{
		SourceID:       "jira-service-management://request/" + ticket.ConversationID + "/comment/" + firstString(id, jiraServiceLocalHash([]byte(body))),
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         firstString(comment.Author.EmailAddress, comment.Author.DisplayName),
		BodyText:       body,
		Properties: map[string]any{
			"jira_service_management_comment_id": id,
			"jira_service_management_public":     comment.Public,
		},
		OccurredAt: firstTime(jiraServiceDateTime(comment.Created), jiraServiceDateTime(comment.Updated)),
	}, true
}

func jiraServiceDoJSON(ctx context.Context, client *http.Client, baseURL string, creds JiraServiceManagementCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := jiraServiceBuildURL(baseURL, path, query)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	if creds.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	} else {
		token := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.Email) + ":" + strings.TrimSpace(creds.APIToken)))
		req.Header.Set("Authorization", "Basic "+token)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-ExperimentalApi", "opt-in")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, jiraServiceDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, jiraServiceResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return JiraServiceManagementRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("decode jira service management response %s: %w", path, err)
		}
	}
	return nil
}

type JiraServiceManagementRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e JiraServiceManagementRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("jira service management REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("jira service management REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func jiraServiceBuildURL(baseURL, path string, query url.Values) (*url.URL, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil {
		return nil, fmt.Errorf("parse jira service management API base URL: %w", err)
	}
	rel, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("parse jira service management request path: %w", err)
	}
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		base = rel
	} else {
		base.Path = strings.TrimRight(base.Path, "/") + "/" + strings.TrimLeft(rel.Path, "/")
	}
	if query != nil {
		base.RawQuery = query.Encode()
	} else if rel.RawQuery != "" {
		base.RawQuery = rel.RawQuery
	}
	return base, nil
}

func jiraServiceOffsetCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == jiraServiceCursorComplete {
		return 0, true
	}
	cursor = strings.TrimPrefix(cursor, jiraServiceCursorPrefix)
	if cursor == "" {
		return 0, false
	}
	offset, err := strconv.Atoi(cursor)
	if err != nil || offset < 0 {
		return 0, false
	}
	return offset, false
}

func decodeJiraServiceManagementCursor(cursor string) string {
	if _, done := jiraServiceOffsetCursor(cursor); done {
		return jiraServiceCursorComplete
	}
	return strings.TrimPrefix(strings.TrimSpace(cursor), jiraServiceCursorPrefix)
}

func jiraServiceLimit(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return jiraServiceDefaultLimit
	}
	if n > jiraServiceMaxLimit {
		return jiraServiceMaxLimit
	}
	return n
}

func jiraServiceRequestAllowed(integration Integration, request jiraServiceRequest) bool {
	if projectKey := strings.TrimSpace(settingString(integration.Settings, "project_key")); projectKey != "" {
		if !strings.HasPrefix(strings.ToUpper(request.IssueKey), strings.ToUpper(projectKey)+"-") {
			return false
		}
	}
	return true
}

func jiraServiceEmailFromFields(fields []jiraServiceFieldValue) string {
	for _, field := range fields {
		key := strings.ToLower(firstString(field.FieldID, field.Label))
		if strings.Contains(key, "email") {
			if email := jiraServiceEmailFromAny(field.Value); email != "" {
				return email
			}
		}
	}
	for _, field := range fields {
		if email := jiraServiceEmailFromAny(field.Value); email != "" {
			return email
		}
	}
	return ""
}

func jiraServiceEmailFromAny(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.ToLower(strings.TrimSpace(jiraServiceEmailRE.FindString(typed)))
	case map[string]any:
		for _, key := range []string{"emailAddress", "email", "value", "displayName", "name"} {
			if email := jiraServiceEmailFromAny(typed[key]); email != "" {
				return email
			}
		}
	case []any:
		for _, item := range typed {
			if email := jiraServiceEmailFromAny(item); email != "" {
				return email
			}
		}
	default:
		return strings.ToLower(strings.TrimSpace(jiraServiceEmailRE.FindString(fmt.Sprint(typed))))
	}
	return ""
}

func jiraServiceBodyText(body any) string {
	switch typed := body.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		if text := strings.TrimSpace(firstString(fmt.Sprint(typed["text"]), fmt.Sprint(typed["value"]))); text != "" && text != "<nil>" {
			return text
		}
		if content, ok := typed["content"].([]any); ok {
			parts := []string{}
			for _, item := range content {
				if text := jiraServiceBodyText(item); text != "" {
					parts = append(parts, text)
				}
			}
			return strings.TrimSpace(strings.Join(parts, "\n"))
		}
	case []any:
		parts := []string{}
		for _, item := range typed {
			if text := jiraServiceBodyText(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	}
	return ""
}

func jiraServiceDateTime(value jiraServiceDate) *time.Time {
	for _, raw := range []string{value.ISO8601, value.Jira} {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			utc := t.UTC()
			return &utc
		}
		if t, err := time.Parse("2006-01-02T15:04:05.000-0700", raw); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}
