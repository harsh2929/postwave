// SPDX-License-Identifier: AGPL-3.0-only
//
// kayako.go — native Kayako provider runtime.
//
// Kayako (new/Nucleus) cases. HTTP Basic auth (agent email + API key/password),
// per-subdomain host. GET /api/v1/cases.json?include=requester with offset/limit
// paging; the case requester is a {id, resource_type:user} reference whose email
// is resolved from the flat `resources.user` map in the same response (no extra
// request). Maps to canonical TicketInput via the support providerPull.
package support_integrations

import (
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
)

const (
	kayakoDefaultUserAgent = "Moosewave Kayako Integration"
	kayakoResponseMaxBytes = 16 << 20
	kayakoDefaultPageSize  = 100
	kayakoMaxPageSize      = 100
	kayakoPostPageMaxLoops = 100
	kayakoCursorPrefix     = "kayako:"
	kayakoCursorComplete   = "kayako:complete"
)

type KayakoCredentials struct {
	Email      string
	APIKey     string
	Subdomain  string
	APIBaseURL string
	UserAgent  string
}

type KayakoCredentialResolver interface {
	ResolveKayako(ctx context.Context, tenantID string, integration Integration) (KayakoCredentials, error)
}

type kayakoCredentialPayload struct {
	Email      string `json:"email"`
	APIKey     string `json:"api_key"`
	Password   string `json:"password"`
	Token      string `json:"token"`
	Subdomain  string `json:"subdomain"`
	Domain     string `json:"domain"`
	Account    string `json:"account_domain"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p kayakoCredentialPayload) credentials() (KayakoCredentials, error) {
	email := strings.TrimSpace(p.Email)
	key := strings.TrimSpace(firstString(p.APIKey, p.Password, p.Token))
	if email == "" || key == "" {
		return KayakoCredentials{}, fmt.Errorf("kayako email and api_key are required")
	}
	return KayakoCredentials{Email: email, APIKey: key, Subdomain: strings.TrimSpace(firstString(p.Subdomain, p.Domain, p.Account)), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type KayakoSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r KayakoSecretsCredentialResolver) ResolveKayako(ctx context.Context, _ string, integration Integration) (KayakoCredentials, error) {
	if r.Secrets == nil {
		return KayakoCredentials{}, fmt.Errorf("kayako credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return KayakoCredentials{}, fmt.Errorf("kayako credentials_ref is required")
	}
	var payload kayakoCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withKayakoDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return KayakoCredentials{}, fmt.Errorf("resolve kayako credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withKayakoDefaults(creds, integration), nil
			}
		}
	}
	return KayakoCredentials{}, fmt.Errorf("kayako requires a JSON {email, api_key} secret")
}

func withKayakoDefaults(creds KayakoCredentials, integration Integration) KayakoCredentials {
	if creds.Subdomain == "" {
		creds.Subdomain = strings.TrimSpace(firstString(
			settingString(integration.Settings, "subdomain"),
			settingString(integration.Settings, "domain"),
			settingString(integration.Settings, "account_domain"),
		))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type KayakoBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type KayakoCaseRefresher interface {
	RefreshCase(ctx context.Context, tenantID string, integration Integration, caseID string) (SyncRequest, error)
}

type KayakoRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials KayakoCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type kayakoCase struct {
	ID        json.Number `json:"id"`
	Subject   string      `json:"subject"`
	PostCount int         `json:"post_count"`
	CreatedAt string      `json:"created_at"`
	UpdatedAt string      `json:"updated_at"`
	Requester struct {
		ID json.Number `json:"id"`
	} `json:"requester"`
}

type kayakoUser struct {
	ID       json.Number `json:"id"`
	FullName string      `json:"full_name"`
	Emails   []struct {
		Email     string `json:"email"`
		IsPrimary bool   `json:"is_primary"`
	} `json:"emails"`
}

type kayakoPost struct {
	ID            json.Number    `json:"id"`
	UUID          string         `json:"uuid"`
	ClientID      string         `json:"client_id"`
	Subject       string         `json:"subject"`
	Contents      string         `json:"contents"`
	Creator       kayakoResource `json:"creator"`
	Identity      kayakoResource `json:"identity"`
	SourceChannel string         `json:"source_channel"`
	Destination   string         `json:"destination_medium"`
	Source        string         `json:"source"`
	PostStatus    string         `json:"post_status"`
	RejectType    string         `json:"post_status_reject_type"`
	RejectReason  string         `json:"post_status_reject_reason"`
	Attachments   []any          `json:"attachments"`
	CreatedAt     string         `json:"created_at"`
	UpdatedAt     string         `json:"updated_at"`
	ResourceType  string         `json:"resource_type"`
}

type kayakoResource struct {
	ID           json.Number `json:"id"`
	ResourceType string      `json:"resource_type"`
}

type kayakoCasesResponse struct {
	Data      []kayakoCase `json:"data"`
	Resources struct {
		User map[string]kayakoUser `json:"user"`
	} `json:"resources"`
	TotalCount int `json:"total_count"`
	Offset     int `json:"offset"`
	Limit      int `json:"limit"`
}

type kayakoCaseResponse struct {
	Data      kayakoCase `json:"data"`
	Resources struct {
		User map[string]kayakoUser `json:"user"`
	} `json:"resources"`
}

type kayakoPostsResponse struct {
	Data      []kayakoPost `json:"data"`
	Resources struct {
		User map[string]kayakoUser `json:"user"`
	} `json:"resources"`
	TotalCount int `json:"total_count"`
	Limit      int `json:"limit"`
}

func (b KayakoRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderKayako {
		return SyncRequest{}, fmt.Errorf("kayako backfill requires a Kayako integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("kayako credential resolver is not configured")
	}
	offset, done := kayakoCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: kayakoCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveKayako(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := kayakoBaseURL(b.APIBaseURL, creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderKayako, 30*time.Second)
	limit := kayakoPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("include", "requester")
	query.Set("offset", strconv.Itoa(offset))
	query.Set("limit", strconv.Itoa(limit))

	var out kayakoCasesResponse
	if err := kayakoDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/cases.json", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Data))
	messages := []MessageInput{}
	for _, c := range out.Data {
		if mapped, ok := mapKayakoCase(c, out.Resources.User); ok {
			tickets = append(tickets, mapped)
			posts, users, err := fetchKayakoCasePosts(ctx, client, baseURL, creds, b.UserAgent, strings.TrimSpace(c.ID.String()))
			if err != nil {
				return SyncRequest{}, err
			}
			messages = append(messages, mapKayakoCasePosts(c, posts, mapped, mergeKayakoUsers(out.Resources.User, users))...)
		}
	}
	nextCursor := kayakoCursorComplete
	if out.TotalCount > offset+limit && len(out.Data) > 0 {
		nextCursor = kayakoCursorPrefix + strconv.Itoa(offset+limit)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}, nil
}

func (b KayakoRESTBackfiller) RefreshCase(ctx context.Context, tenantID string, integration Integration, caseID string) (SyncRequest, error) {
	if integration.Provider != ProviderKayako {
		return SyncRequest{}, fmt.Errorf("kayako refresh requires a Kayako integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("kayako credential resolver is not configured")
	}
	caseID = strings.TrimSpace(caseID)
	if caseID == "" {
		return SyncRequest{}, fmt.Errorf("kayako case id is required")
	}
	creds, err := b.Credentials.ResolveKayako(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := kayakoBaseURL(b.APIBaseURL, creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderKayako, 30*time.Second)
	query := url.Values{}
	query.Set("include", "requester")
	path := "/api/v1/cases/" + url.PathEscape(caseID) + ".json"
	var out kayakoCaseResponse
	if err := kayakoDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, query, &out); err != nil {
		return SyncRequest{}, err
	}
	ticket, ok := mapKayakoCase(out.Data, out.Resources.User)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: "kayako-webhook-" + caseID}, nil
	}
	posts, users, err := fetchKayakoCasePosts(ctx, client, baseURL, creds, b.UserAgent, caseID)
	if err != nil {
		return SyncRequest{}, err
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "webhook",
		Tickets:  []TicketInput{ticket},
		Messages: mapKayakoCasePosts(out.Data, posts, ticket, mergeKayakoUsers(out.Resources.User, users)),
		Cursor:   "kayako-webhook-" + caseID,
	}), nil
}

func mapKayakoCase(c kayakoCase, users map[string]kayakoUser) (TicketInput, bool) {
	requesterID := strings.TrimSpace(c.Requester.ID.String())
	user, ok := users[requesterID]
	if !ok {
		return TicketInput{}, false
	}
	email := ""
	for _, e := range user.Emails {
		if e.IsPrimary && strings.TrimSpace(e.Email) != "" {
			email = strings.ToLower(strings.TrimSpace(e.Email))
			break
		}
	}
	if email == "" {
		for _, e := range user.Emails {
			if v := strings.ToLower(strings.TrimSpace(e.Email)); v != "" {
				email = v
				break
			}
		}
	}
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(c.ID.String())
	if id == "" {
		return TicketInput{}, false
	}
	out := TicketInput{
		SourceID:       "kayako://case/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  strings.TrimSpace(user.FullName),
		Subject:        strings.TrimSpace(c.Subject),
		Properties: map[string]any{
			"kayako_case_id":      id,
			"kayako_requester_id": requesterID,
			"kayako_post_count":   c.PostCount,
		},
	}
	if t := parseZendeskTime(firstString(c.UpdatedAt, c.CreatedAt)); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func fetchKayakoCasePosts(ctx context.Context, client *http.Client, baseURL string, creds KayakoCredentials, userAgent, caseID string) ([]kayakoPost, map[string]kayakoUser, error) {
	caseID = strings.TrimSpace(caseID)
	if caseID == "" {
		return nil, nil, nil
	}
	path := "/api/v1/cases/" + url.PathEscape(caseID) + "/posts.json"
	posts := []kayakoPost{}
	users := map[string]kayakoUser{}
	beforeID := ""
	for i := 0; i < kayakoPostPageMaxLoops; i++ {
		query := url.Values{}
		query.Set("filters", "MESSAGES")
		if beforeID != "" {
			query.Set("before_id", beforeID)
		}
		var out kayakoPostsResponse
		if err := kayakoDoJSON(ctx, client, baseURL, creds, userAgent, path, query, &out); err != nil {
			var restErr KayakoRESTError
			if errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound {
				return posts, users, nil
			}
			return nil, nil, err
		}
		for id, user := range out.Resources.User {
			users[id] = user
		}
		if len(out.Data) == 0 {
			break
		}
		posts = append(posts, out.Data...)
		if out.TotalCount > 0 && len(posts) >= out.TotalCount {
			break
		}
		if out.Limit > 0 && len(out.Data) < out.Limit {
			break
		}
		nextBefore := kayakoSmallestPostID(out.Data)
		if nextBefore == "" || nextBefore == beforeID {
			break
		}
		beforeID = nextBefore
	}
	return posts, users, nil
}

func kayakoSmallestPostID(posts []kayakoPost) string {
	smallest := 0
	raw := ""
	for _, post := range posts {
		n, err := strconv.Atoi(strings.TrimSpace(post.ID.String()))
		if err != nil || n <= 0 {
			continue
		}
		if smallest == 0 || n < smallest {
			smallest = n
			raw = strconv.Itoa(n)
		}
	}
	return raw
}

func mapKayakoCasePosts(c kayakoCase, posts []kayakoPost, ticket TicketInput, users map[string]kayakoUser) []MessageInput {
	if len(posts) == 0 {
		return nil
	}
	out := make([]MessageInput, 0, len(posts))
	for _, post := range posts {
		if mapped, ok := mapKayakoCasePost(c, post, ticket, users); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapKayakoCasePost(c kayakoCase, post kayakoPost, ticket TicketInput, users map[string]kayakoUser) (MessageInput, bool) {
	postID := strings.TrimSpace(post.ID.String())
	if postID == "" {
		return MessageInput{}, false
	}
	bodyHTML := strings.TrimSpace(post.Contents)
	bodyText := strings.TrimSpace(intercomPartBodyText(bodyHTML))
	if bodyText == "" {
		bodyText = bodyHTML
	}
	if bodyText == "" && bodyHTML == "" {
		return MessageInput{}, false
	}
	direction, senderType := kayakoPostDirection(c, post)
	creatorID := strings.TrimSpace(post.Creator.ID.String())
	creator := users[creatorID]
	out := MessageInput{
		SourceID:       "kayako://case/" + ticket.ConversationID + "/post/" + postID,
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		Subject:        strings.TrimSpace(firstString(post.Subject, ticket.Subject)),
		Direction:      direction,
		SenderType:     senderType,
		Sender:         strings.TrimSpace(creator.FullName),
		BodyText:       bodyText,
		BodyHTML:       bodyHTML,
		Properties: map[string]any{
			"kayako_case_id":               ticket.ConversationID,
			"kayako_post_id":               postID,
			"kayako_post_uuid":             strings.TrimSpace(post.UUID),
			"kayako_post_client_id":        strings.TrimSpace(post.ClientID),
			"kayako_post_creator_id":       creatorID,
			"kayako_post_creator_type":     strings.TrimSpace(post.Creator.ResourceType),
			"kayako_post_source_channel":   strings.TrimSpace(post.SourceChannel),
			"kayako_post_destination":      strings.TrimSpace(post.Destination),
			"kayako_post_source":           strings.TrimSpace(post.Source),
			"kayako_post_status":           strings.TrimSpace(post.PostStatus),
			"kayako_post_reject_type":      strings.TrimSpace(post.RejectType),
			"kayako_post_reject_reason":    strings.TrimSpace(post.RejectReason),
			"kayako_post_attachment_count": len(post.Attachments),
			"kayako_post_resource_type":    strings.TrimSpace(post.ResourceType),
		},
	}
	if out.Sender == "" && direction == "inbound" {
		out.Sender = ticket.RequesterName
	}
	if t := parseZendeskTime(firstString(post.CreatedAt, post.UpdatedAt)); t != nil {
		out.OccurredAt = t
	}
	return out, true
}

func kayakoPostDirection(c kayakoCase, post kayakoPost) (string, string) {
	requesterID := strings.TrimSpace(c.Requester.ID.String())
	creatorID := strings.TrimSpace(post.Creator.ID.String())
	if creatorID != "" && requesterID != "" && creatorID == requesterID {
		return "inbound", "customer"
	}
	switch strings.ToUpper(strings.TrimSpace(firstString(post.SourceChannel, post.Source, post.Destination))) {
	case "NOTE":
		return "internal", "agent"
	case "AGENT", "API":
		return "outbound", "agent"
	case "MAIL", "MESSENGER", "MOBILE", "HELPCENTER", "TWITTER", "FACEBOOK":
		if strings.TrimSpace(post.Destination) != "" {
			return "outbound", "agent"
		}
	}
	if strings.TrimSpace(post.Destination) != "" {
		return "outbound", "agent"
	}
	return "inbound", "customer"
}

func mergeKayakoUsers(primary, secondary map[string]kayakoUser) map[string]kayakoUser {
	if len(secondary) == 0 {
		return primary
	}
	out := make(map[string]kayakoUser, len(primary)+len(secondary))
	for id, user := range primary {
		out[id] = user
	}
	for id, user := range secondary {
		out[id] = user
	}
	return out
}

type KayakoRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e KayakoRESTError) Error() string {
	return fmt.Sprintf("kayako REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func kayakoBaseURL(override string, creds KayakoCredentials) (string, error) {
	if v := strings.TrimRight(strings.TrimSpace(override), "/"); v != "" {
		return v, nil
	}
	if v := strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"); v != "" {
		return v, nil
	}
	if sub := strings.TrimSpace(creds.Subdomain); sub != "" {
		return kayakoAccountBaseURL(sub), nil
	}
	return "", fmt.Errorf("kayako subdomain or api_base_url is required")
}

func kayakoAccountBaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(raw), "http://") || strings.HasPrefix(strings.ToLower(raw), "https://") {
		return strings.TrimRight(raw, "/")
	}
	host := strings.Trim(strings.TrimPrefix(strings.TrimPrefix(raw, "http://"), "https://"), "/")
	if strings.Contains(host, ".") {
		return "https://" + host
	}
	return "https://" + host + ".kayako.com"
}

func kayakoDoJSON(ctx context.Context, client *http.Client, baseURL string, creds KayakoCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse kayako API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.Email)+":"+strings.TrimSpace(creds.APIKey))))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, kayakoDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, kayakoResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return KayakoRESTError{
			Path:       path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    zendeskTruncate(string(body), 500),
		}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode kayako response %s: %w", path, err)
	}
	return nil
}

func kayakoCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == kayakoCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, kayakoCursorPrefix))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, false
}

func kayakoPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return kayakoDefaultPageSize
	}
	if n > kayakoMaxPageSize {
		return kayakoMaxPageSize
	}
	return n
}
