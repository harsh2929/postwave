// SPDX-License-Identifier: AGPL-3.0-only
//
// gladly.go — native Gladly provider runtime.
//
// Gladly's public REST API is customer-scoped: conversations are listed under a
// customer, conversation items are hydrated separately, and the Events API is a
// recent JSONL stream rather than a historical export. This adapter therefore
// treats configured customer IDs as the deterministic backfill path and uses
// recent events/webhooks for sparse ID refresh.
package support_integrations

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	gladlyDefaultUserAgent       = "Moosewave Gladly Integration"
	gladlyResponseMaxBytes       = 16 << 20
	gladlyCursorPrefix           = "gladly:"
	gladlyCursorComplete         = "gladly:complete"
	gladlyDefaultEventWindowMins = 60
)

type GladlyCredentials struct {
	Email              string
	APIToken           string
	OrganizationDomain string
	APIBaseURL         string
	UserAgent          string
}

type GladlyCredentialResolver interface {
	ResolveGladly(ctx context.Context, tenantID string, integration Integration) (GladlyCredentials, error)
}

type gladlyCredentialPayload struct {
	Email              string `json:"email"`
	AgentEmail         string `json:"agent_email"`
	Username           string `json:"username"`
	APIToken           string `json:"api_token"`
	Token              string `json:"token"`
	APIKey             string `json:"api_key"`
	Organization       string `json:"organization"`
	OrganizationID     string `json:"organization_id"`
	OrganizationDomain string `json:"organization_domain"`
	Domain             string `json:"domain"`
	Subdomain          string `json:"subdomain"`
	APIBaseURL         string `json:"api_base_url"`
	UserAgent          string `json:"user_agent"`
}

func (p gladlyCredentialPayload) credentials() (GladlyCredentials, error) {
	creds := GladlyCredentials{
		Email:              strings.TrimSpace(firstString(p.Email, p.AgentEmail, p.Username)),
		APIToken:           strings.TrimSpace(firstString(p.APIToken, p.Token, p.APIKey)),
		OrganizationDomain: normalizeGladlyOrganizationDomain(firstString(p.OrganizationDomain, p.Organization, p.OrganizationID, p.Domain, p.Subdomain)),
		APIBaseURL:         strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:          strings.TrimSpace(p.UserAgent),
	}
	if creds.Email == "" || creds.APIToken == "" {
		return GladlyCredentials{}, fmt.Errorf("gladly email and api_token are required")
	}
	return creds, nil
}

type GladlySecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r GladlySecretsCredentialResolver) ResolveGladly(ctx context.Context, _ string, integration Integration) (GladlyCredentials, error) {
	if r.Secrets == nil {
		return GladlyCredentials{}, fmt.Errorf("gladly credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return GladlyCredentials{}, fmt.Errorf("gladly credentials_ref is required")
	}
	var payload gladlyCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withGladlySettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return GladlyCredentials{}, fmt.Errorf("resolve gladly credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withGladlySettings(creds, integration), nil
			}
		}
	}
	if email, token, ok := strings.Cut(raw, ":"); ok {
		creds, err := (gladlyCredentialPayload{Email: email, APIToken: token}).credentials()
		if err != nil {
			return GladlyCredentials{}, err
		}
		return withGladlySettings(creds, integration), nil
	}
	return GladlyCredentials{}, fmt.Errorf("gladly requires a JSON {email, api_token} secret")
}

func withGladlySettings(creds GladlyCredentials, integration Integration) GladlyCredentials {
	if creds.OrganizationDomain == "" {
		creds.OrganizationDomain = normalizeGladlyOrganizationDomain(gladlyIntegrationOrganization(integration))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type GladlyBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type GladlyConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error)
	RefreshCustomer(ctx context.Context, tenantID string, integration Integration, customerID string) (SyncRequest, error)
	RefreshTask(ctx context.Context, tenantID string, integration Integration, taskID string) (SyncRequest, error)
}

type GladlyRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials GladlyCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Now         func() time.Time
}

type gladlyCursorState struct {
	Stage         string   `json:"stage,omitempty"`
	CustomerIDs   []string `json:"customer_ids,omitempty"`
	CustomerIndex int      `json:"customer_index,omitempty"`
	StartAt       string   `json:"start_at,omitempty"`
	EndAt         string   `json:"end_at,omitempty"`
}

func (b GladlyRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderGladly {
		return SyncRequest{}, fmt.Errorf("gladly backfill requires a Gladly integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("gladly credential resolver is not configured")
	}
	state, done, err := gladlyBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	customerIDs := gladlyConfiguredCustomerIDs(integration)
	if done && len(customerIDs) > 0 {
		return SyncRequest{RunMode: "backfill", Cursor: gladlyCursorComplete}, nil
	}
	if done && len(customerIDs) == 0 {
		state = gladlyCursorState{Stage: "events"}
	}
	if len(customerIDs) > 0 {
		state.Stage = "customers"
		state.CustomerIDs = customerIDs
	}
	creds, err := b.Credentials.ResolveGladly(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := gladlyBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL), creds, integration)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("gladly organization_domain or api_base_url is required")
	}
	if state.Stage == "" {
		state.Stage = "events"
	}
	switch state.Stage {
	case "customers":
		if len(state.CustomerIDs) == 0 {
			state.CustomerIDs = customerIDs
		}
		if state.CustomerIndex >= len(state.CustomerIDs) {
			return SyncRequest{RunMode: "backfill", Cursor: gladlyCursorComplete}, nil
		}
		req, err := b.refreshGladlyCustomer(ctx, client, baseURL, creds, integration, state.CustomerIDs[state.CustomerIndex], "backfill")
		if err != nil {
			return SyncRequest{}, err
		}
		state.CustomerIndex++
		if state.CustomerIndex >= len(state.CustomerIDs) {
			req.Cursor = gladlyCursorComplete
		} else {
			req.Cursor = gladlyEncodeCursor(state)
		}
		req.RunMode = "backfill"
		return normalizeSyncRequest(req), nil
	case "events":
		if state.StartAt == "" || state.EndAt == "" {
			state.StartAt, state.EndAt = gladlyEventWindow(integration, b.now())
		}
		req, err := b.backfillGladlyEvents(ctx, client, baseURL, creds, integration, state.StartAt, state.EndAt)
		if err != nil {
			return SyncRequest{}, err
		}
		req.RunMode = "backfill"
		req.Cursor = gladlyCursorComplete
		return normalizeSyncRequest(req), nil
	default:
		return SyncRequest{}, fmt.Errorf("gladly cursor has unknown stage %q", state.Stage)
	}
}

func (b GladlyRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error) {
	if integration.Provider != ProviderGladly {
		return SyncRequest{}, fmt.Errorf("gladly refresh requires a Gladly integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("gladly credential resolver is not configured")
	}
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveGladly(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := gladlyBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL), creds, integration)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("gladly organization_domain or api_base_url is required")
	}
	return b.refreshGladlyConversation(ctx, client, baseURL, creds, integration, conversationID, "webhook")
}

func (b GladlyRESTBackfiller) RefreshCustomer(ctx context.Context, tenantID string, integration Integration, customerID string) (SyncRequest, error) {
	if integration.Provider != ProviderGladly {
		return SyncRequest{}, fmt.Errorf("gladly refresh requires a Gladly integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("gladly credential resolver is not configured")
	}
	customerID = strings.TrimSpace(customerID)
	if customerID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveGladly(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := gladlyBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL), creds, integration)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("gladly organization_domain or api_base_url is required")
	}
	return b.refreshGladlyCustomer(ctx, client, baseURL, creds, integration, customerID, "webhook")
}

func (b GladlyRESTBackfiller) RefreshTask(ctx context.Context, tenantID string, integration Integration, taskID string) (SyncRequest, error) {
	if integration.Provider != ProviderGladly {
		return SyncRequest{}, fmt.Errorf("gladly refresh requires a Gladly integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("gladly credential resolver is not configured")
	}
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveGladly(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := gladlyBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL), creds, integration)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("gladly organization_domain or api_base_url is required")
	}
	task := map[string]any{}
	if err := gladlyDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/tasks/"+url.PathEscape(taskID), nil, &task); err != nil {
		return SyncRequest{}, err
	}
	customer := map[string]any(nil)
	if customerID := gladlyTaskCustomerID(task); customerID != "" {
		fetched, err := b.fetchGladlyCustomer(ctx, client, baseURL, creds, customerID)
		if err != nil {
			return SyncRequest{}, err
		}
		customer = fetched
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Events: mapGladlyTasks([]map[string]any{task}, customer), Cursor: "gladly-task-" + taskID}), nil
}

func (b GladlyRESTBackfiller) refreshGladlyCustomer(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, integration Integration, customerID, runMode string) (SyncRequest, error) {
	customerID = strings.TrimSpace(customerID)
	if customerID == "" {
		return SyncRequest{RunMode: runMode}, nil
	}
	customer, err := b.fetchGladlyCustomer(ctx, client, baseURL, creds, customerID)
	if err != nil {
		return SyncRequest{}, err
	}
	conversations, err := b.fetchGladlyCustomerConversations(ctx, client, baseURL, creds, customerID)
	if err != nil {
		return SyncRequest{}, err
	}
	tickets := []TicketInput{}
	messages := []MessageInput{}
	for _, conv := range conversations {
		ticket, ok := mapGladlyConversation(conv, customer)
		if !ok {
			continue
		}
		items, limited, err := b.fetchGladlyConversationItems(ctx, client, baseURL, creds, ticket.ConversationID)
		if err != nil {
			return SyncRequest{}, err
		}
		if limited && ticket.Properties != nil {
			ticket.Properties["gladly_limited_items"] = true
		}
		tickets = append(tickets, ticket)
		messages = append(messages, mapGladlyItems(items, ticket)...)
	}
	events := []SupportEventInput{}
	if gladlySettingBool(integration.Settings, "include_tasks") || gladlySettingBool(integration.Settings, "tasks_enabled") {
		tasks, err := b.fetchGladlyCustomerTasks(ctx, client, baseURL, creds, customerID)
		if err != nil {
			return SyncRequest{}, err
		}
		events = append(events, mapGladlyTasks(tasks, customer)...)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: runMode, Tickets: tickets, Messages: messages, Events: events, Cursor: "gladly-customer-" + customerID}), nil
}

func (b GladlyRESTBackfiller) refreshGladlyConversation(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, integration Integration, conversationID, runMode string) (SyncRequest, error) {
	conversation := map[string]any{}
	if err := gladlyDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/conversations/"+url.PathEscape(conversationID), nil, &conversation); err != nil {
		return SyncRequest{}, err
	}
	customer := map[string]any(nil)
	if customerID := gladlyConversationCustomerID(conversation); customerID != "" {
		fetched, err := b.fetchGladlyCustomer(ctx, client, baseURL, creds, customerID)
		if err != nil {
			return SyncRequest{}, err
		}
		customer = fetched
	}
	ticket, ok := mapGladlyConversation(conversation, customer)
	if !ok {
		return SyncRequest{RunMode: runMode, Cursor: "gladly-conversation-" + conversationID}, nil
	}
	items, limited, err := b.fetchGladlyConversationItems(ctx, client, baseURL, creds, ticket.ConversationID)
	if err != nil {
		return SyncRequest{}, err
	}
	if limited && ticket.Properties != nil {
		ticket.Properties["gladly_limited_items"] = true
	}
	return normalizeSyncRequest(SyncRequest{RunMode: runMode, Tickets: []TicketInput{ticket}, Messages: mapGladlyItems(items, ticket), Cursor: "gladly-conversation-" + conversationID}), nil
}

func (b GladlyRESTBackfiller) backfillGladlyEvents(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, integration Integration, startAt, endAt string) (SyncRequest, error) {
	query := url.Values{}
	query.Set("startAt", startAt)
	if strings.TrimSpace(endAt) != "" {
		query.Set("endAt", endAt)
	}
	for _, entity := range gladlyEventEntities(integration) {
		query.Add("entities", entity)
	}
	events, err := gladlyDoJSONLines(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/events", query)
	if err != nil {
		return SyncRequest{}, err
	}
	out := SyncRequest{RunMode: "backfill", Cursor: gladlyCursorComplete}
	seenConversations := map[string]bool{}
	seenCustomers := map[string]bool{}
	seenTasks := map[string]bool{}
	for _, event := range events {
		if conversationID := gladlyWebhookConversationID(event); conversationID != "" && !seenConversations[conversationID] {
			seenConversations[conversationID] = true
			req, err := b.refreshGladlyConversation(ctx, client, baseURL, creds, integration, conversationID, "backfill")
			if err != nil {
				return SyncRequest{}, err
			}
			out.Tickets = append(out.Tickets, req.Tickets...)
			out.Messages = append(out.Messages, req.Messages...)
			out.Events = append(out.Events, req.Events...)
			continue
		}
		if taskID := gladlyWebhookTaskID(event); taskID != "" && !seenTasks[taskID] {
			seenTasks[taskID] = true
			taskReq, err := b.refreshGladlyTaskWithClient(ctx, client, baseURL, creds, taskID)
			if err != nil {
				return SyncRequest{}, err
			}
			out.Events = append(out.Events, taskReq.Events...)
			continue
		}
		if customerID := gladlyWebhookCustomerID(event); customerID != "" && !seenCustomers[customerID] {
			seenCustomers[customerID] = true
			req, err := b.refreshGladlyCustomer(ctx, client, baseURL, creds, integration, customerID, "backfill")
			if err != nil {
				return SyncRequest{}, err
			}
			out.Tickets = append(out.Tickets, req.Tickets...)
			out.Messages = append(out.Messages, req.Messages...)
			out.Events = append(out.Events, req.Events...)
		}
	}
	return normalizeSyncRequest(out), nil
}

func (b GladlyRESTBackfiller) refreshGladlyTaskWithClient(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, taskID string) (SyncRequest, error) {
	task := map[string]any{}
	if err := gladlyDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/tasks/"+url.PathEscape(taskID), nil, &task); err != nil {
		return SyncRequest{}, err
	}
	customer := map[string]any(nil)
	if customerID := gladlyTaskCustomerID(task); customerID != "" {
		fetched, err := b.fetchGladlyCustomer(ctx, client, baseURL, creds, customerID)
		if err != nil {
			return SyncRequest{}, err
		}
		customer = fetched
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: mapGladlyTasks([]map[string]any{task}, customer), Cursor: "gladly-task-" + taskID}), nil
}

func (b GladlyRESTBackfiller) fetchGladlyCustomer(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, customerID string) (map[string]any, error) {
	out := map[string]any{}
	err := gladlyDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/customer-profiles/"+url.PathEscape(customerID), nil, &out)
	return out, err
}

func (b GladlyRESTBackfiller) fetchGladlyCustomerConversations(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, customerID string) ([]map[string]any, error) {
	var out []map[string]any
	if err := gladlyDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/customers/"+url.PathEscape(customerID)+"/conversations", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (b GladlyRESTBackfiller) fetchGladlyConversationItems(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, conversationID string) ([]map[string]any, bool, error) {
	var out []map[string]any
	header, err := gladlyDoJSONWithHeader(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/conversations/"+url.PathEscape(conversationID)+"/items", nil, &out)
	if err != nil {
		return nil, false, err
	}
	return out, strings.TrimSpace(header.Get("Gladly-Limited-Data")) != "", nil
}

func (b GladlyRESTBackfiller) fetchGladlyCustomerTasks(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, customerID string) ([]map[string]any, error) {
	out := []map[string]any{}
	for _, status := range []string{"OPEN", "CLOSED"} {
		query := url.Values{}
		query.Set("status", status)
		var page []map[string]any
		err := gladlyDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/customers/"+url.PathEscape(customerID)+"/tasks", query, &page)
		if err != nil {
			return nil, err
		}
		out = append(out, page...)
	}
	return out, nil
}

func (b GladlyRESTBackfiller) client() *http.Client {
	return supportEgressClient(b.HTTPClient, ProviderGladly, 30*time.Second)
}

func (b GladlyRESTBackfiller) now() time.Time {
	if b.Now != nil {
		return b.Now().UTC()
	}
	return time.Now().UTC()
}

func mapGladlyConversation(conv, customer map[string]any) (TicketInput, bool) {
	conversationID := gladlyConversationID(conv)
	email := gladlyCustomerEmail(firstMap(gladlyMap(conv, "customer"), customer))
	if email == "" {
		email = strings.ToLower(strings.TrimSpace(firstString(gladlyString(conv, "customerEmail"), gladlyString(conv, "customer_email"), gladlyString(conv, "email"))))
	}
	if conversationID == "" || email == "" {
		return TicketInput{}, false
	}
	updatedAt := firstTime(gladlyTime(conv, "updatedAt"), gladlyTime(conv, "updated_at"), gladlyTime(conv, "lastUpdatedAt"), gladlyTime(conv, "createdAt"), gladlyTime(conv, "created_at"))
	out := TicketInput{
		SourceID:       "gladly://conversation/" + conversationID,
		ConversationID: conversationID,
		Email:          email,
		RequesterName:  gladlyCustomerName(firstMap(gladlyMap(conv, "customer"), customer)),
		Subject:        firstString(gladlyString(conv, "subject"), gladlyString(conv, "title"), "Gladly conversation "+conversationID),
		Status:         gladlyConversationStatus(conv),
		Priority:       gladlyString(conv, "priority"),
		Assignee:       firstString(gladlyString(conv, "assignee", "name"), gladlyString(conv, "assignedAgent", "name"), gladlyString(conv, "assigned_agent", "name")),
		Tags:           gladlyTags(conv),
		Properties: map[string]any{
			"gladly_conversation_id": conversationID,
			"gladly_customer_id":     gladlyConversationCustomerID(conv),
			"gladly_raw":             conv,
		},
		UpdatedAt: updatedAt,
	}
	if out.Properties["gladly_customer_id"] == "" {
		out.Properties["gladly_customer_id"] = gladlyCustomerID(customer)
	}
	return out, true
}

func mapGladlyItems(items []map[string]any, ticket TicketInput) []MessageInput {
	out := []MessageInput{}
	for i, item := range items {
		if msg, ok := mapGladlyItem(item, ticket, i); ok {
			out = append(out, msg)
		}
	}
	return out
}

func mapGladlyItem(item map[string]any, ticket TicketInput, index int) (MessageInput, bool) {
	body := gladlyMessageBody(item)
	itemID := firstString(gladlyString(item, "id"), gladlyString(item, "itemId"), gladlyString(item, "item_id"), strconv.Itoa(index))
	if body == "" && itemID == "" {
		return MessageInput{}, false
	}
	direction, senderType := gladlyMessageDirection(firstString(
		gladlyString(item, "initiator", "type"),
		gladlyString(item, "createdBy", "type"),
		gladlyString(item, "created_by", "type"),
		gladlyString(item, "sender", "type"),
		gladlyString(item, "type"),
	))
	return MessageInput{
		SourceID:       "gladly://conversation/" + ticket.ConversationID + "/item/" + itemID,
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender: firstString(
			gladlyString(item, "initiator", "name"),
			gladlyString(item, "createdBy", "name"),
			gladlyString(item, "created_by", "name"),
			gladlyString(item, "sender", "name"),
			gladlyString(item, "agent", "name"),
		),
		BodyText:   body,
		BodyHTML:   firstString(gladlyString(item, "content", "html"), gladlyString(item, "bodyHtml"), gladlyString(item, "body_html")),
		Properties: map[string]any{"gladly_item_id": itemID, "gladly_item_type": firstString(gladlyString(item, "type"), gladlyString(item, "content", "type")), "gladly_raw": item},
		OccurredAt: firstTime(gladlyTime(item, "timestamp"), gladlyTime(item, "createdAt"), gladlyTime(item, "created_at")),
	}, true
}

func mapGladlyTasks(tasks []map[string]any, customer map[string]any) []SupportEventInput {
	out := []SupportEventInput{}
	email := gladlyCustomerEmail(customer)
	name := gladlyCustomerName(customer)
	for _, task := range tasks {
		if email == "" {
			email = strings.ToLower(strings.TrimSpace(firstString(gladlyString(task, "customerEmail"), gladlyString(task, "customer_email"), gladlyString(task, "customer", "email"))))
		}
		if email == "" {
			continue
		}
		taskID := firstString(gladlyString(task, "id"), gladlyString(task, "taskId"), gladlyString(task, "task_id"))
		if taskID == "" {
			continue
		}
		body := firstString(gladlyString(task, "body"), gladlyString(task, "title"), "Gladly task "+taskID)
		out = append(out, SupportEventInput{
			SourceID:   "gladly://task/" + taskID,
			Email:      email,
			EventName:  "gladly.task." + strings.ToLower(firstString(gladlyString(task, "status"), "updated")),
			TicketID:   taskID,
			Status:     gladlyString(task, "status"),
			Properties: map[string]any{"gladly_task_id": taskID, "gladly_customer_id": gladlyTaskCustomerID(task), "gladly_requester_name": name, "gladly_body": body, "gladly_raw": task},
			OccurredAt: firstTime(gladlyTime(task, "timestamp"), gladlyTime(task, "updatedAt"), gladlyTime(task, "createdAt")),
		})
	}
	return out
}

func gladlyDoJSON(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, userAgent, path string, query url.Values, out any) error {
	_, err := gladlyDoJSONWithHeader(ctx, client, baseURL, creds, userAgent, path, query, out)
	return err
}

func gladlyDoJSONWithHeader(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, userAgent, path string, query url.Values, out any) (http.Header, error) {
	u, err := gladlyBuildURL(baseURL, path, query)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(strings.TrimSpace(creds.Email), strings.TrimSpace(creds.APIToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, gladlyDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, gladlyResponseMaxBytes))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, GladlyRESTError{
			Path:       path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    zendeskTruncate(string(body), 500),
		}
	}
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return nil, fmt.Errorf("decode gladly response %s: %w", path, err)
		}
	}
	return resp.Header.Clone(), nil
}

func gladlyDoJSONLines(ctx context.Context, client *http.Client, baseURL string, creds GladlyCredentials, userAgent, path string, query url.Values) ([]map[string]any, error) {
	u, err := gladlyBuildURL(baseURL, path, query)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(strings.TrimSpace(creds.Email), strings.TrimSpace(creds.APIToken))
	req.Header.Set("Accept", "application/x-ndjson, application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, gladlyDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, gladlyResponseMaxBytes))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, GladlyRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(raw), 500)}
	}
	out := []map[string]any{}
	scanner := bufio.NewScanner(strings.NewReader(string(raw)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return nil, fmt.Errorf("decode gladly event line: %w", err)
		}
		out = append(out, event)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 && len(strings.TrimSpace(string(raw))) > 0 {
		var single map[string]any
		if err := json.Unmarshal(raw, &single); err == nil {
			out = append(out, single)
		}
	}
	return out, nil
}

type GladlyRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e GladlyRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("gladly REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("gladly REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func gladlyBuildURL(baseURL, path string, query url.Values) (*url.URL, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("gladly request path is required")
	}
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil {
		return nil, fmt.Errorf("parse gladly API base URL: %w", err)
	}
	rel, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("parse gladly request path: %w", err)
	}
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		base = rel
	} else if strings.HasPrefix(rel.Path, "/api/") {
		base.Path = rel.Path
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

func gladlyBaseURL(override string, creds GladlyCredentials, integration Integration) string {
	if base := strings.TrimRight(strings.TrimSpace(override), "/"); base != "" {
		return base
	}
	domain := firstString(creds.OrganizationDomain, normalizeGladlyOrganizationDomain(gladlyIntegrationOrganization(integration)))
	if domain == "" {
		return ""
	}
	if strings.HasPrefix(domain, "http://") || strings.HasPrefix(domain, "https://") {
		return strings.TrimRight(domain, "/")
	}
	return "https://" + domain
}

func normalizeGladlyOrganizationDomain(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "https://")
	value = strings.TrimPrefix(value, "http://")
	value = strings.Trim(value, "/")
	if idx := strings.Index(value, "/"); idx >= 0 {
		value = value[:idx]
	}
	if value == "" {
		return ""
	}
	if strings.Contains(value, ".") {
		return value
	}
	return value + ".gladly.com"
}

func gladlyIntegrationOrganization(integration Integration) string {
	return firstString(
		settingString(integration.Settings, "organization_domain"),
		settingString(integration.Settings, "organization_id"),
		settingString(integration.Settings, "gladly_organization_domain"),
		settingString(integration.Settings, "account_domain"),
		settingString(integration.Settings, "domain"),
		settingString(integration.Settings, "subdomain"),
	)
}

func gladlyConfiguredCustomerIDs(integration Integration) []string {
	out := []string{}
	for _, key := range []string{"customer_id", "customer_ids", "gladly_customer_id", "gladly_customer_ids"} {
		for _, value := range strings.FieldsFunc(settingString(integration.Settings, key), func(r rune) bool { return r == ',' || r == '\n' || r == ' ' || r == '\t' }) {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				out = append(out, trimmed)
			}
		}
	}
	return cleanStrings(out)
}

func gladlyBackfillCursor(cursor string) (gladlyCursorState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || cursor == "gladly" {
		return gladlyCursorState{}, false, nil
	}
	if cursor == gladlyCursorComplete {
		return gladlyCursorState{}, true, nil
	}
	if !strings.HasPrefix(cursor, gladlyCursorPrefix) {
		return gladlyCursorState{Stage: "events", StartAt: cursor}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, gladlyCursorPrefix))
	if err != nil {
		return gladlyCursorState{}, false, fmt.Errorf("decode gladly cursor: %w", err)
	}
	var state gladlyCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return gladlyCursorState{}, false, fmt.Errorf("parse gladly cursor: %w", err)
	}
	return state, false, nil
}

func gladlyEncodeCursor(state gladlyCursorState) string {
	body, _ := json.Marshal(state)
	return gladlyCursorPrefix + base64.RawURLEncoding.EncodeToString(body)
}

func decodeGladlyCursor(cursor string) string {
	state, done, err := gladlyBackfillCursor(cursor)
	if err != nil {
		return strings.TrimSpace(cursor)
	}
	if done {
		return gladlyCursorComplete
	}
	parts := []string{state.Stage}
	if len(state.CustomerIDs) > 0 {
		parts = append(parts, strconv.Itoa(state.CustomerIndex), strings.Join(state.CustomerIDs, ","))
	}
	if state.StartAt != "" {
		parts = append(parts, state.StartAt)
	}
	if state.EndAt != "" {
		parts = append(parts, state.EndAt)
	}
	return strings.Join(cleanStrings(parts), ":")
}

func gladlyEventWindow(integration Integration, now time.Time) (string, string) {
	start := strings.TrimSpace(firstString(settingString(integration.Settings, "start_at"), settingString(integration.Settings, "events_start_at"), settingString(integration.Settings, "backfill_since")))
	end := strings.TrimSpace(firstString(settingString(integration.Settings, "end_at"), settingString(integration.Settings, "events_end_at"), settingString(integration.Settings, "backfill_to")))
	if start == "" {
		minutes := gladlyIntSetting(integration.Settings, "event_window_minutes", gladlyDefaultEventWindowMins)
		if minutes <= 0 || minutes > 24*60 {
			minutes = gladlyDefaultEventWindowMins
		}
		start = now.Add(-time.Duration(minutes) * time.Minute).UTC().Format(time.RFC3339)
	}
	if end == "" {
		end = now.UTC().Format(time.RFC3339)
	}
	return start, end
}

func gladlyEventEntities(integration Integration) []string {
	raw := firstString(settingString(integration.Settings, "event_entities"), settingString(integration.Settings, "entities"))
	if raw == "" {
		return []string{"CUSTOMER_PROFILE", "CONVERSATION", "TASK"}
	}
	out := []string{}
	for _, value := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' }) {
		if trimmed := strings.ToUpper(strings.TrimSpace(value)); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return cleanStrings(out)
}

func gladlyIntSetting(settings map[string]any, key string, fallback int) int {
	n, err := strconv.Atoi(settingString(settings, key))
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func gladlySettingBool(settings map[string]any, key string) bool {
	switch strings.ToLower(settingString(settings, key)) {
	case "1", "t", "true", "yes", "y", "on", "enabled":
		return true
	default:
		return false
	}
}

func gladlyConversationID(raw map[string]any) string {
	return firstString(gladlyString(raw, "id"), gladlyString(raw, "conversationId"), gladlyString(raw, "conversation_id"))
}

func gladlyConversationCustomerID(raw map[string]any) string {
	return firstString(gladlyString(raw, "customerId"), gladlyString(raw, "customer_id"), gladlyString(raw, "customer", "id"))
}

func gladlyCustomerID(raw map[string]any) string {
	return firstString(gladlyString(raw, "id"), gladlyString(raw, "customerId"), gladlyString(raw, "customer_id"))
}

func gladlyTaskCustomerID(raw map[string]any) string {
	return firstString(gladlyString(raw, "customerId"), gladlyString(raw, "customer_id"), gladlyString(raw, "customer", "id"))
}

func gladlyCustomerEmail(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	email := firstString(gladlyString(raw, "email"), gladlyString(raw, "emailAddress"), gladlyString(raw, "email_address"), gladlyString(raw, "primaryEmail"), gladlyString(raw, "primary_email"))
	if email != "" {
		return strings.ToLower(strings.TrimSpace(email))
	}
	for _, key := range []string{"emails", "emailAddresses", "email_addresses"} {
		for _, item := range gladlyArray(raw, key) {
			if m, ok := item.(map[string]any); ok {
				email = firstString(gladlyString(m, "email"), gladlyString(m, "original"), gladlyString(m, "normalized"), gladlyString(m, "value"))
				if email != "" {
					return strings.ToLower(strings.TrimSpace(email))
				}
			}
		}
	}
	return ""
}

func gladlyCustomerName(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	if name := firstString(gladlyString(raw, "name"), gladlyString(raw, "fullName"), gladlyString(raw, "full_name")); name != "" {
		return name
	}
	return strings.TrimSpace(strings.Join(cleanStrings([]string{gladlyString(raw, "firstName"), gladlyString(raw, "first_name"), gladlyString(raw, "lastName"), gladlyString(raw, "last_name")}), " "))
}

func gladlyConversationStatus(raw map[string]any) string {
	if status := firstString(gladlyString(raw, "status"), gladlyString(raw, "state")); status != "" {
		return strings.ToLower(status)
	}
	if firstString(gladlyString(raw, "closedAt"), gladlyString(raw, "closed_at"), gladlyString(raw, "endedAt"), gladlyString(raw, "ended_at")) != "" {
		return "closed"
	}
	return "open"
}

func gladlyMessageBody(raw map[string]any) string {
	return firstString(
		gladlyString(raw, "body"),
		gladlyString(raw, "text"),
		gladlyString(raw, "message"),
		gladlyString(raw, "content", "body"),
		gladlyString(raw, "content", "text"),
		gladlyString(raw, "content", "content"),
		gladlyString(raw, "content", "message"),
		gladlyString(raw, "content", "value"),
	)
}

func gladlyMessageDirection(actorType string) (string, string) {
	switch strings.ToLower(strings.TrimSpace(actorType)) {
	case "customer", "customer_profile", "end_user", "user", "visitor":
		return "inbound", "customer"
	case "agent", "admin", "teammate", "user_profile":
		return "outbound", "agent"
	case "system", "automation", "rule", "bot":
		return "outbound", "system"
	default:
		return "inbound", "customer"
	}
}

func gladlyTags(raw map[string]any) []string {
	out := []string{}
	for _, item := range gladlyArray(raw, "tags") {
		switch typed := item.(type) {
		case string:
			out = append(out, typed)
		case map[string]any:
			out = append(out, firstString(gladlyString(typed, "name"), gladlyString(typed, "label"), gladlyString(typed, "id")))
		}
	}
	return cleanStrings(out)
}

func gladlyString(raw map[string]any, path ...string) string {
	if raw == nil {
		return ""
	}
	var cur any = raw
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		var found any
		for k, v := range m {
			if strings.EqualFold(k, key) {
				found = v
				break
			}
		}
		if found == nil {
			return ""
		}
		cur = found
	}
	switch typed := cur.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strings.TrimSpace(fmt.Sprint(typed))
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func gladlyMap(raw map[string]any, path ...string) map[string]any {
	if raw == nil {
		return nil
	}
	var cur any = raw
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		var found any
		for k, v := range m {
			if strings.EqualFold(k, key) {
				found = v
				break
			}
		}
		cur = found
	}
	out, _ := cur.(map[string]any)
	return out
}

func gladlyArray(raw map[string]any, path ...string) []any {
	var cur any = raw
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		var found any
		for k, v := range m {
			if strings.EqualFold(k, key) {
				found = v
				break
			}
		}
		cur = found
	}
	if out, ok := cur.([]any); ok {
		return out
	}
	return nil
}

func firstMap(values ...map[string]any) map[string]any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func gladlyTime(raw map[string]any, path ...string) *time.Time {
	if parsed := parseZendeskTime(gladlyString(raw, path...)); parsed != nil {
		return parsed
	}
	return nil
}

func firstTime(values ...*time.Time) *time.Time {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
