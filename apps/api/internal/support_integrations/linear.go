// SPDX-License-Identifier: AGPL-3.0-only
//
// linear.go — native Linear support provider runtime.
//
// Linear's public resource API is GraphQL. This native partial runtime pages
// issues (optionally team-scoped), embeds a bounded page of issue comments, and
// maps customer/support evidence to canonical support tickets/messages.
package support_integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	linearDefaultGraphQLURL  = "https://api.linear.app/graphql"
	linearDefaultUserAgent   = "Moosewave Linear Integration"
	linearResponseMaxBytes   = 16 << 20
	linearCursorPrefix       = "linear:"
	linearCursorComplete     = "linear:complete"
	linearDefaultPageSize    = 50
	linearMaxPageSize        = 100
	linearDefaultCommentSize = 25
)

var linearEmailRE = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)

type LinearCredentials struct {
	AccessToken string
	GraphQLURL  string
	UserAgent   string
}

type LinearCredentialResolver interface {
	ResolveLinear(ctx context.Context, tenantID string, integration Integration) (LinearCredentials, error)
}

type linearCredentialPayload struct {
	AccessToken string `json:"access_token"`
	BearerToken string `json:"bearer_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	GraphQLURL  string `json:"graphql_url"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p linearCredentialPayload) credentials() (LinearCredentials, error) {
	token := strings.TrimPrefix(strings.TrimSpace(firstString(p.AccessToken, p.BearerToken, p.Token, p.APIKey)), "Bearer ")
	if token == "" {
		return LinearCredentials{}, fmt.Errorf("linear access_token is required")
	}
	return LinearCredentials{
		AccessToken: token,
		GraphQLURL:  strings.TrimRight(strings.TrimSpace(firstString(p.GraphQLURL, p.APIBaseURL)), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

type LinearSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r LinearSecretsCredentialResolver) ResolveLinear(ctx context.Context, _ string, integration Integration) (LinearCredentials, error) {
	if r.Secrets == nil {
		return LinearCredentials{}, fmt.Errorf("linear credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return LinearCredentials{}, fmt.Errorf("linear credentials_ref is required")
	}
	var payload linearCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withLinearSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return LinearCredentials{}, fmt.Errorf("resolve linear credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withLinearSettings(creds, integration), nil
			}
		}
	}
	creds, err := (linearCredentialPayload{AccessToken: raw}).credentials()
	if err != nil {
		return LinearCredentials{}, err
	}
	return withLinearSettings(creds, integration), nil
}

func withLinearSettings(creds LinearCredentials, integration Integration) LinearCredentials {
	if creds.GraphQLURL == "" {
		creds.GraphQLURL = strings.TrimRight(strings.TrimSpace(firstString(settingString(integration.Settings, "graphql_url"), settingString(integration.Settings, "api_base_url"))), "/")
	}
	return creds
}

type LinearBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type LinearIssueRefresher interface {
	RefreshIssue(ctx context.Context, tenantID string, integration Integration, issueID string) (SyncRequest, error)
}

type LinearGraphQLBackfiller struct {
	HTTPClient  *http.Client
	Credentials LinearCredentialResolver
	GraphQLURL  string
	UserAgent   string
	PageSize    int
}

type linearGraphQLRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables,omitempty"`
}

type linearGraphQLResponse struct {
	Data   linearGraphQLData    `json:"data"`
	Errors []linearGraphQLError `json:"errors"`
}

type linearGraphQLData struct {
	Issues linearIssueConnection `json:"issues"`
	Issue  linearIssue           `json:"issue"`
}

type linearGraphQLError struct {
	Message    string         `json:"message"`
	Extensions map[string]any `json:"extensions"`
}

type linearIssueConnection struct {
	Nodes    []linearIssue  `json:"nodes"`
	PageInfo linearPageInfo `json:"pageInfo"`
}

type linearCommentConnection struct {
	Nodes    []linearComment `json:"nodes"`
	PageInfo linearPageInfo  `json:"pageInfo"`
}

type linearCustomerNeedConnection struct {
	Nodes []linearCustomerNeed `json:"nodes"`
}

type linearLabelConnection struct {
	Nodes []linearNamedRef `json:"nodes"`
}

type linearPageInfo struct {
	HasNextPage bool   `json:"hasNextPage"`
	EndCursor   string `json:"endCursor"`
}

type linearIssue struct {
	ID            string                       `json:"id"`
	Identifier    string                       `json:"identifier"`
	Number        int                          `json:"number"`
	Title         string                       `json:"title"`
	Description   string                       `json:"description"`
	URL           string                       `json:"url"`
	Priority      int                          `json:"priority"`
	PriorityLabel string                       `json:"priorityLabel"`
	CreatedAt     string                       `json:"createdAt"`
	UpdatedAt     string                       `json:"updatedAt"`
	Team          linearNamedRef               `json:"team"`
	State         linearNamedRef               `json:"state"`
	Project       linearNamedRef               `json:"project"`
	Assignee      linearUser                   `json:"assignee"`
	Creator       linearUser                   `json:"creator"`
	Comments      linearCommentConnection      `json:"comments"`
	CustomerNeeds linearCustomerNeedConnection `json:"customerNeeds"`
	Labels        linearLabelConnection        `json:"labels"`
}

type linearComment struct {
	ID        string     `json:"id"`
	Body      string     `json:"body"`
	URL       string     `json:"url"`
	CreatedAt string     `json:"createdAt"`
	UpdatedAt string     `json:"updatedAt"`
	User      linearUser `json:"user"`
}

type linearCustomerNeed struct {
	ID       string         `json:"id"`
	Body     string         `json:"body"`
	Customer linearCustomer `json:"customer"`
}

type linearCustomer struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	ExternalID string   `json:"externalId"`
	Domains    []string `json:"domains"`
}

type linearUser struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
}

type linearNamedRef struct {
	ID   string `json:"id"`
	Key  string `json:"key"`
	Name string `json:"name"`
	Type string `json:"type"`
}

func (b LinearGraphQLBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderLinear {
		return SyncRequest{}, fmt.Errorf("linear backfill requires a Linear integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("linear credential resolver is not configured")
	}
	after, done := linearCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: linearCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveLinear(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	variables := map[string]any{"first": linearPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))}
	if after != "" {
		variables["after"] = after
	}
	if teamID := strings.TrimSpace(settingString(integration.Settings, "team_id")); teamID != "" {
		variables["filter"] = map[string]any{"team": map[string]any{"id": map[string]any{"eq": teamID}}}
	}
	var resp linearGraphQLResponse
	if err := linearDoGraphQL(ctx, b.client(), b.graphQLURL(creds), creds, b.UserAgent, linearIssuesQuery, variables, &resp); err != nil {
		return SyncRequest{}, err
	}
	tickets, messages := mapLinearIssues(resp.Data.Issues.Nodes, integration)
	cursorOut := linearCursorComplete
	if resp.Data.Issues.PageInfo.HasNextPage && strings.TrimSpace(resp.Data.Issues.PageInfo.EndCursor) != "" {
		cursorOut = linearCursorPrefix + strings.TrimSpace(resp.Data.Issues.PageInfo.EndCursor)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: cursorOut}), nil
}

func (b LinearGraphQLBackfiller) RefreshIssue(ctx context.Context, tenantID string, integration Integration, issueID string) (SyncRequest, error) {
	if integration.Provider != ProviderLinear {
		return SyncRequest{}, fmt.Errorf("linear refresh requires a Linear integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("linear credential resolver is not configured")
	}
	issueID = strings.TrimSpace(issueID)
	if issueID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveLinear(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	var resp linearGraphQLResponse
	if err := linearDoGraphQL(ctx, b.client(), b.graphQLURL(creds), creds, b.UserAgent, linearIssueQuery, map[string]any{"id": issueID}, &resp); err != nil {
		return SyncRequest{}, err
	}
	tickets, messages := mapLinearIssues([]linearIssue{resp.Data.Issue}, integration)
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: tickets, Messages: messages, Cursor: "linear-issue-" + issueID}), nil
}

func (b LinearGraphQLBackfiller) client() *http.Client {
	return supportEgressClient(b.HTTPClient, ProviderLinear, 30*time.Second)
}

func (b LinearGraphQLBackfiller) graphQLURL(creds LinearCredentials) string {
	return firstString(strings.TrimRight(b.GraphQLURL, "/"), strings.TrimRight(creds.GraphQLURL, "/"), linearDefaultGraphQLURL)
}

func mapLinearIssues(issues []linearIssue, integration Integration) ([]TicketInput, []MessageInput) {
	tickets := []TicketInput{}
	messages := []MessageInput{}
	for _, issue := range issues {
		ticket, ok := mapLinearIssue(issue, integration)
		if !ok {
			continue
		}
		tickets = append(tickets, ticket)
		messages = append(messages, mapLinearComments(issue.Comments.Nodes, ticket)...)
	}
	return tickets, messages
}

func mapLinearIssue(issue linearIssue, integration Integration) (TicketInput, bool) {
	id := firstString(issue.Identifier, issue.ID)
	email := strings.ToLower(strings.TrimSpace(firstString(
		issue.Creator.Email,
		linearEmailFromCustomerNeeds(issue.CustomerNeeds.Nodes),
		linearEmailRE.FindString(issue.Description),
		issue.Assignee.Email,
		settingString(integration.Settings, "default_email"),
	)))
	if id == "" || email == "" {
		return TicketInput{}, false
	}
	tags := []string{}
	for _, label := range issue.Labels.Nodes {
		if label.Name != "" {
			tags = append(tags, label.Name)
		}
	}
	return TicketInput{
		SourceID:       "linear://issue/" + issue.ID,
		ConversationID: id,
		Email:          email,
		RequesterName:  firstString(issue.Creator.Name, issue.Creator.DisplayName, issue.Assignee.Name, issue.Assignee.DisplayName),
		Subject:        firstString(issue.Title, "Linear issue "+id),
		Status:         firstString(issue.State.Name, issue.State.Type),
		Priority:       firstString(issue.PriorityLabel, strconv.Itoa(issue.Priority)),
		Tags:           tags,
		Properties: map[string]any{
			"linear_issue_id":         issue.ID,
			"linear_issue_identifier": issue.Identifier,
			"linear_issue_url":        issue.URL,
			"linear_team_id":          issue.Team.ID,
			"linear_team_key":         issue.Team.Key,
			"linear_project_id":       issue.Project.ID,
			"linear_state_id":         issue.State.ID,
		},
		UpdatedAt: firstTime(parseZendeskTime(issue.UpdatedAt), parseZendeskTime(issue.CreatedAt)),
	}, true
}

func mapLinearComments(comments []linearComment, ticket TicketInput) []MessageInput {
	out := []MessageInput{}
	for _, comment := range comments {
		if mapped, ok := mapLinearComment(comment, ticket); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapLinearComment(comment linearComment, ticket TicketInput) (MessageInput, bool) {
	id := strings.TrimSpace(comment.ID)
	body := strings.TrimSpace(comment.Body)
	if id == "" && body == "" {
		return MessageInput{}, false
	}
	direction, senderType := "outbound", "agent"
	if strings.EqualFold(comment.User.Email, ticket.Email) {
		direction, senderType = "inbound", "customer"
	}
	return MessageInput{
		SourceID:       "linear://issue/" + ticket.ConversationID + "/comment/" + firstString(id, linearLocalHash([]byte(body))),
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         firstString(comment.User.Email, comment.User.Name, comment.User.DisplayName),
		BodyText:       body,
		Properties: map[string]any{
			"linear_comment_id":  id,
			"linear_comment_url": comment.URL,
		},
		OccurredAt: firstTime(parseZendeskTime(comment.CreatedAt), parseZendeskTime(comment.UpdatedAt)),
	}, true
}

func linearEmailFromCustomerNeeds(needs []linearCustomerNeed) string {
	for _, need := range needs {
		if email := strings.TrimSpace(linearEmailRE.FindString(need.Customer.ExternalID)); email != "" {
			return email
		}
		if email := strings.TrimSpace(linearEmailRE.FindString(need.Body)); email != "" {
			return email
		}
		for _, domain := range need.Customer.Domains {
			if strings.Contains(domain, "@") {
				if email := strings.TrimSpace(linearEmailRE.FindString(domain)); email != "" {
					return email
				}
			}
		}
	}
	return ""
}

func linearDoGraphQL(ctx context.Context, client *http.Client, endpoint string, creds LinearCredentials, userAgent, query string, variables map[string]any, out *linearGraphQLResponse) error {
	payload, _ := json.Marshal(linearGraphQLRequest{Query: query, Variables: variables})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, linearDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, linearResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return LinearRESTError{StatusCode: resp.StatusCode, RetryAfter: parseLinearRetryAfter(resp.Header), Snippet: zendeskTruncate(string(body), 500)}
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("decode linear GraphQL response: %w", err)
		}
	}
	if len(out.Errors) > 0 {
		err := out.Errors[0]
		code := strings.ToUpper(strings.TrimSpace(fmt.Sprint(err.Extensions["code"])))
		status := http.StatusBadGateway
		if code == "RATELIMITED" {
			status = http.StatusTooManyRequests
		}
		return LinearRESTError{StatusCode: status, RetryAfter: parseLinearRetryAfter(resp.Header), ErrorCode: code, Snippet: zendeskTruncate(err.Message, 500)}
	}
	return nil
}

type LinearRESTError struct {
	StatusCode int
	RetryAfter time.Duration
	ErrorCode  string
	Snippet    string
}

func (e LinearRESTError) Error() string {
	code := ""
	if e.ErrorCode != "" {
		code = " " + e.ErrorCode
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("linear API failed %d%s; retry after %s: %s", e.StatusCode, code, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("linear API failed %d%s: %s", e.StatusCode, code, e.Snippet)
}

func parseLinearRetryAfter(header http.Header) time.Duration {
	if retry := parseZendeskRetryAfter(header.Get("Retry-After")); retry > 0 {
		return retry
	}
	reset := strings.TrimSpace(header.Get("X-RateLimit-Requests-Reset"))
	if reset == "" {
		reset = strings.TrimSpace(header.Get("X-RateLimit-Reset"))
	}
	if reset == "" {
		return 0
	}
	if unix, err := strconv.ParseInt(reset, 10, 64); err == nil {
		delay := time.Until(time.Unix(unix, 0))
		if delay > 0 {
			return delay
		}
	}
	return 0
}

func linearCursor(cursor string) (string, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == linearCursorComplete {
		return "", true
	}
	return strings.TrimPrefix(cursor, linearCursorPrefix), false
}

func decodeLinearCursor(cursor string) string {
	if _, done := linearCursor(cursor); done {
		return linearCursorComplete
	}
	return strings.TrimPrefix(strings.TrimSpace(cursor), linearCursorPrefix)
}

func linearPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return linearDefaultPageSize
	}
	if n > linearMaxPageSize {
		return linearMaxPageSize
	}
	return n
}

const linearIssueFields = `
id
identifier
number
title
description
url
priority
priorityLabel
createdAt
updatedAt
team { id key name }
state { id name type }
project { id name }
assignee { id name displayName email }
creator { id name displayName email }
labels(first: 20) { nodes { id name } }
customerNeeds(first: 20) { nodes { id body customer { id name externalId domains } } }
comments(first: 25) { nodes { id body url createdAt updatedAt user { id name displayName email } } pageInfo { hasNextPage endCursor } }
`

const linearIssuesQuery = `query PostwaveLinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, includeArchived: true, orderBy: updatedAt) {
    nodes { ` + linearIssueFields + ` }
    pageInfo { hasNextPage endCursor }
  }
}`

const linearIssueQuery = `query PostwaveLinearIssue($id: String!) {
  issue(id: $id) { ` + linearIssueFields + ` }
}`
