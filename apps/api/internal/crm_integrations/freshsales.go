// SPDX-License-Identifier: AGPL-3.0-only
//
// freshsales.go — native Freshsales (Freshworks CRM) provider runtime.
//
// Freshsales authenticates with a static API key ("Authorization: Token
// token=<key>"). Listing contacts is GET /crm/sales/api/contacts/view/{view_id}
// with page-number paging (Freshsales lists run against a saved view). Static
// token, so no OAuth/refresh/worker — dispatched via providerManagedSyncRequest.
package crm_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	freshsalesDefaultUserAgent     = "Moosewave Freshsales Integration"
	freshsalesDefaultPageSize      = 100
	freshsalesMaxPageSize          = 100
	freshsalesCursorPrefix         = "freshsales:"
	freshsalesAccountCursorPrefix  = "freshsales:accounts:"
	freshsalesDealCursorPrefix     = "freshsales:deals:"
	freshsalesActivityCursorPrefix = "freshsales:activities:"
	freshsalesTaskCursorPrefix     = "freshsales:tasks:"
	freshsalesCursorComplete       = "freshsales:complete"
)

type FreshsalesCredentials struct {
	APIKey     string
	Domain     string
	APIBaseURL string
	UserAgent  string
}

type FreshsalesCredentialResolver interface {
	ResolveFreshsales(context.Context, string, Integration) (FreshsalesCredentials, error)
}

type freshsalesCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	Domain     string `json:"domain"`
	Bundle     string `json:"bundle_alias"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p freshsalesCredentialPayload) credentials() (FreshsalesCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return FreshsalesCredentials{}, fmt.Errorf("freshsales api_key is required")
	}
	return FreshsalesCredentials{APIKey: key, Domain: strings.TrimSpace(firstString(p.Domain, p.Bundle)), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type FreshsalesSecretsCredentialResolver struct {
	Secrets CRMStaticSecretResolver
}

func NewFreshsalesSecretsCredentialResolver(secrets CRMStaticSecretResolver) *FreshsalesSecretsCredentialResolver {
	return &FreshsalesSecretsCredentialResolver{Secrets: secrets}
}

func (r *FreshsalesSecretsCredentialResolver) ResolveFreshsales(ctx context.Context, _ string, integration Integration) (FreshsalesCredentials, error) {
	if r == nil || r.Secrets == nil {
		return FreshsalesCredentials{}, fmt.Errorf("freshsales credential resolver is not configured")
	}
	ref := crmStaticCredentialRef(integration)
	if ref == "" {
		return FreshsalesCredentials{}, fmt.Errorf("freshsales credentials_ref is required")
	}
	var payload freshsalesCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withFreshsalesDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FreshsalesCredentials{}, fmt.Errorf("resolve freshsales credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withFreshsalesDefaults(creds, integration), nil
			}
		}
	}
	creds, err := freshsalesCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return FreshsalesCredentials{}, err
	}
	return withFreshsalesDefaults(creds, integration), nil
}

func withFreshsalesDefaults(creds FreshsalesCredentials, integration Integration) FreshsalesCredentials {
	if creds.Domain == "" {
		creds.Domain = strings.TrimSpace(firstString(settingString(integration.Settings, "domain"), settingString(integration.Settings, "bundle_alias")))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type FreshsalesBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FreshsalesRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FreshsalesCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type freshsalesContact struct {
	ID           json.Number `json:"id"`
	Email        string      `json:"email"`
	FirstName    string      `json:"first_name"`
	LastName     string      `json:"last_name"`
	MobileNumber string      `json:"mobile_number"`
	WorkNumber   string      `json:"work_number"`
	JobTitle     string      `json:"job_title"`
	UpdatedAt    string      `json:"updated_at"`
}

type freshsalesContactsResponse struct {
	Contacts []freshsalesContact `json:"contacts"`
	Meta     struct {
		TotalPages int `json:"total_pages"`
	} `json:"meta"`
}

type freshsalesDealsResponse struct {
	Deals []map[string]any `json:"deals"`
	Meta  struct {
		TotalPages int `json:"total_pages"`
	} `json:"meta"`
}

type freshsalesAccountsResponse struct {
	SalesAccounts []map[string]any `json:"sales_accounts"`
	Meta          struct {
		TotalPages int `json:"total_pages"`
	} `json:"meta"`
}

type freshsalesSalesActivitiesResponse struct {
	SalesActivities []map[string]any `json:"sales_activities"`
	Meta            struct {
		TotalPages int `json:"total_pages"`
	} `json:"meta"`
}

type freshsalesTasksResponse struct {
	Tasks []map[string]any `json:"tasks"`
	Meta  struct {
		TotalPages int `json:"total_pages"`
	} `json:"meta"`
}

func (b FreshsalesRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFreshsales {
		return SyncRequest{}, fmt.Errorf("freshsales backfill requires a Freshsales integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("freshsales credential resolver is not configured")
	}
	if strings.HasPrefix(strings.TrimSpace(cursor), freshsalesTaskCursorPrefix) {
		return b.backfillTasksPage(ctx, tenantID, integration, cursor)
	}
	if strings.HasPrefix(strings.TrimSpace(cursor), freshsalesActivityCursorPrefix) {
		return b.backfillSalesActivitiesPage(ctx, tenantID, integration, cursor)
	}
	if strings.HasPrefix(strings.TrimSpace(cursor), freshsalesDealCursorPrefix) {
		return b.backfillDealsPage(ctx, tenantID, integration, cursor)
	}
	if strings.HasPrefix(strings.TrimSpace(cursor), freshsalesAccountCursorPrefix) {
		return b.backfillAccountsPage(ctx, tenantID, integration, cursor)
	}
	page, done := crmPageCursor(cursor, freshsalesCursorPrefix, freshsalesCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: freshsalesCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFreshsales(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := freshsalesBaseURL(firstString(b.APIBaseURL, settingString(integration.Settings, "api_base_url")), creds)
	if err != nil {
		return SyncRequest{}, err
	}
	viewID := strings.TrimSpace(settingString(integration.Settings, "view_id"))
	if viewID == "" {
		return SyncRequest{}, fmt.Errorf("freshsales view_id is required")
	}
	client := crmHTTPClient(b.HTTPClient, ProviderFreshsales)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(crmPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), freshsalesDefaultPageSize, freshsalesMaxPageSize)))
	headers := freshsalesAuthHeaders(creds)

	var out freshsalesContactsResponse
	path := "/crm/sales/api/contacts/view/" + url.PathEscape(viewID)
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, path, query, headers, nil, firstString(b.UserAgent, creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(out.Contacts))
	for _, c := range out.Contacts {
		if mapped, ok := mapFreshsalesContact(c, integration); ok {
			contacts = append(contacts, mapped)
		}
	}
	nextCursor := freshsalesCursorComplete
	if out.Meta.TotalPages > page && len(out.Contacts) > 0 {
		nextCursor = freshsalesCursorPrefix + strconv.Itoa(page+1)
	} else if freshsalesAccountViewID(integration) != "" {
		nextCursor = freshsalesAccountCursorPrefix + "1"
	} else if freshsalesDealViewID(integration) != "" {
		nextCursor = freshsalesDealCursorPrefix + "1"
	} else if freshsalesSyncSalesActivities(integration) {
		nextCursor = freshsalesActivityCursorPrefix + "1"
	} else if freshsalesSyncTasks(integration) {
		nextCursor = freshsalesInitialTaskCursor(integration)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Contacts: contacts, Cursor: nextCursor}), nil
}

func (b FreshsalesRESTBackfiller) backfillAccountsPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	page, done := crmPageCursor(cursor, freshsalesAccountCursorPrefix, freshsalesCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: freshsalesCursorComplete}, nil
	}
	accountViewID := freshsalesAccountViewID(integration)
	if accountViewID == "" {
		return SyncRequest{RunMode: "backfill", Cursor: freshsalesCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFreshsales(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := freshsalesBaseURL(firstString(b.APIBaseURL, settingString(integration.Settings, "api_base_url")), creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := crmHTTPClient(b.HTTPClient, ProviderFreshsales)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(crmPageSize(firstString(settingString(integration.Settings, "account_page_size"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), freshsalesDefaultPageSize, freshsalesMaxPageSize)))
	headers := freshsalesAuthHeaders(creds)
	var out freshsalesAccountsResponse
	path := "/crm/sales/api/sales_accounts/view/" + url.PathEscape(accountViewID)
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, path, query, headers, nil, firstString(b.UserAgent, creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(out.SalesAccounts))
	for _, account := range out.SalesAccounts {
		detail := account
		if id := freshsalesRecordString(account, "id"); id != "" {
			if hydrated, err := b.fetchAccountDetail(ctx, client, baseURL, creds, id); err == nil && len(hydrated) > 0 {
				detail = mergeFreshsalesMaps(account, hydrated)
			} else if err != nil {
				return SyncRequest{}, err
			}
		}
		detail, err = b.hydrateFreshsalesAccountContacts(ctx, client, baseURL, creds, detail)
		if err != nil {
			return SyncRequest{}, err
		}
		contacts = append(contacts, mapFreshsalesAccountContacts(detail, integration)...)
	}
	nextCursor := freshsalesCursorComplete
	if out.Meta.TotalPages > page && len(out.SalesAccounts) > 0 {
		nextCursor = freshsalesAccountCursorPrefix + strconv.Itoa(page+1)
	} else if freshsalesDealViewID(integration) != "" {
		nextCursor = freshsalesDealCursorPrefix + "1"
	} else if freshsalesSyncSalesActivities(integration) {
		nextCursor = freshsalesActivityCursorPrefix + "1"
	} else if freshsalesSyncTasks(integration) {
		nextCursor = freshsalesInitialTaskCursor(integration)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Contacts: contacts, Cursor: nextCursor}), nil
}

func (b FreshsalesRESTBackfiller) backfillDealsPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	page, done := crmPageCursor(cursor, freshsalesDealCursorPrefix, freshsalesCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: freshsalesCursorComplete}, nil
	}
	dealViewID := freshsalesDealViewID(integration)
	if dealViewID == "" {
		return SyncRequest{RunMode: "backfill", Cursor: freshsalesCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFreshsales(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := freshsalesBaseURL(firstString(b.APIBaseURL, settingString(integration.Settings, "api_base_url")), creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := crmHTTPClient(b.HTTPClient, ProviderFreshsales)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(crmPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), freshsalesDefaultPageSize, freshsalesMaxPageSize)))
	headers := freshsalesAuthHeaders(creds)
	var out freshsalesDealsResponse
	path := "/crm/sales/api/deals/view/" + url.PathEscape(dealViewID)
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, path, query, headers, nil, firstString(b.UserAgent, creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(out.Deals))
	for _, deal := range out.Deals {
		detail := deal
		if id := freshsalesRecordString(deal, "id"); id != "" {
			if hydrated, err := b.fetchDealDetail(ctx, client, baseURL, creds, integration, id); err == nil && len(hydrated) > 0 {
				detail = mergeFreshsalesMaps(deal, hydrated)
			} else if err != nil {
				return SyncRequest{}, err
			}
		}
		events = append(events, mapFreshsalesDealEvents(detail, integration)...)
	}
	nextCursor := freshsalesCursorComplete
	if out.Meta.TotalPages > page && len(out.Deals) > 0 {
		nextCursor = freshsalesDealCursorPrefix + strconv.Itoa(page+1)
	} else if freshsalesSyncSalesActivities(integration) {
		nextCursor = freshsalesActivityCursorPrefix + "1"
	} else if freshsalesSyncTasks(integration) {
		nextCursor = freshsalesInitialTaskCursor(integration)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: nextCursor}), nil
}

func (b FreshsalesRESTBackfiller) backfillSalesActivitiesPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	page, done := crmPageCursor(cursor, freshsalesActivityCursorPrefix, freshsalesCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: freshsalesCursorComplete}, nil
	}
	if !freshsalesSyncSalesActivities(integration) {
		return SyncRequest{RunMode: "backfill", Cursor: freshsalesCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFreshsales(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := freshsalesBaseURL(firstString(b.APIBaseURL, settingString(integration.Settings, "api_base_url")), creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := crmHTTPClient(b.HTTPClient, ProviderFreshsales)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(crmPageSize(firstString(settingString(integration.Settings, "activity_page_size"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), freshsalesDefaultPageSize, freshsalesMaxPageSize)))
	if ownerID := strings.TrimSpace(settingString(integration.Settings, "activity_owner_id")); ownerID != "" {
		query.Set("owner_id", ownerID)
	}
	var out freshsalesSalesActivitiesResponse
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, "/crm/sales/api/sales_activities", query, freshsalesAuthHeaders(creds), nil, firstString(b.UserAgent, creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(out.SalesActivities))
	contacts := map[string]freshsalesContact{}
	deals := map[string]map[string]any{}
	accounts := map[string]map[string]any{}
	for _, activity := range out.SalesActivities {
		contactID := freshsalesSalesActivityContactID(activity)
		if contactID != "" {
			contact, ok := contacts[contactID]
			if !ok {
				hydrated, err := b.fetchContactDetail(ctx, client, baseURL, creds, contactID)
				if err != nil {
					return SyncRequest{}, err
				}
				contact = hydrated
				contacts[contactID] = contact
			}
			if event, ok := mapFreshsalesSalesActivityEvent(activity, contact, integration); ok {
				events = append(events, event)
			}
			continue
		}
		dealID := freshsalesSalesActivityDealID(activity)
		if dealID != "" {
			deal, ok := deals[dealID]
			if !ok {
				hydrated, err := b.fetchDealDetail(ctx, client, baseURL, creds, integration, dealID)
				if err != nil {
					return SyncRequest{}, err
				}
				deal = hydrated
				deals[dealID] = deal
			}
			events = append(events, mapFreshsalesSalesActivityDealEvents(activity, deal, integration)...)
			continue
		}
		accountID := freshsalesSalesActivityAccountID(activity)
		if accountID != "" {
			account, ok := accounts[accountID]
			if !ok {
				hydrated, err := b.fetchAccountDetail(ctx, client, baseURL, creds, accountID)
				if err != nil {
					return SyncRequest{}, err
				}
				hydrated, err = b.hydrateFreshsalesAccountContacts(ctx, client, baseURL, creds, hydrated)
				if err != nil {
					return SyncRequest{}, err
				}
				account = hydrated
				accounts[accountID] = account
			}
			events = append(events, mapFreshsalesSalesActivityAccountEvents(activity, account, integration)...)
		}
	}
	nextCursor := freshsalesCursorComplete
	if out.Meta.TotalPages > page && len(out.SalesActivities) > 0 {
		nextCursor = freshsalesActivityCursorPrefix + strconv.Itoa(page+1)
	} else if freshsalesSyncTasks(integration) {
		nextCursor = freshsalesInitialTaskCursor(integration)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: nextCursor}), nil
}

func (b FreshsalesRESTBackfiller) backfillTasksPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	filter, page := freshsalesTaskCursorState(cursor, integration)
	if !freshsalesSyncTasks(integration) {
		return SyncRequest{RunMode: "backfill", Cursor: freshsalesCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFreshsales(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := freshsalesBaseURL(firstString(b.APIBaseURL, settingString(integration.Settings, "api_base_url")), creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := crmHTTPClient(b.HTTPClient, ProviderFreshsales)
	query := url.Values{}
	query.Set("filter", filter)
	query.Set("include", "targetable,owner")
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(crmPageSize(firstString(settingString(integration.Settings, "task_page_size"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), freshsalesDefaultPageSize, freshsalesMaxPageSize)))
	var out freshsalesTasksResponse
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, "/crm/sales/api/tasks", query, freshsalesAuthHeaders(creds), nil, firstString(b.UserAgent, creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(out.Tasks))
	contacts := map[string]freshsalesContact{}
	deals := map[string]map[string]any{}
	accounts := map[string]map[string]any{}
	for _, task := range out.Tasks {
		contactID := freshsalesTaskContactID(task)
		if contactID != "" {
			contact, ok := contacts[contactID]
			if !ok {
				hydrated, err := b.fetchContactDetail(ctx, client, baseURL, creds, contactID)
				if err != nil {
					return SyncRequest{}, err
				}
				contact = hydrated
				contacts[contactID] = contact
			}
			if event, ok := mapFreshsalesTaskEvent(task, contact, filter, integration); ok {
				events = append(events, event)
			}
			continue
		}
		dealID := freshsalesTaskDealID(task)
		if dealID != "" {
			deal, ok := deals[dealID]
			if !ok {
				hydrated, err := b.fetchDealDetail(ctx, client, baseURL, creds, integration, dealID)
				if err != nil {
					return SyncRequest{}, err
				}
				deal = hydrated
				deals[dealID] = deal
			}
			events = append(events, mapFreshsalesTaskDealEvents(task, deal, filter, integration)...)
			continue
		}
		accountID := freshsalesTaskAccountID(task)
		if accountID != "" {
			account, ok := accounts[accountID]
			if !ok {
				hydrated, err := b.fetchAccountDetail(ctx, client, baseURL, creds, accountID)
				if err != nil {
					return SyncRequest{}, err
				}
				hydrated, err = b.hydrateFreshsalesAccountContacts(ctx, client, baseURL, creds, hydrated)
				if err != nil {
					return SyncRequest{}, err
				}
				account = hydrated
				accounts[accountID] = account
			}
			events = append(events, mapFreshsalesTaskAccountEvents(task, account, filter, integration)...)
		}
	}
	nextCursor := freshsalesCursorComplete
	if out.Meta.TotalPages > page && len(out.Tasks) > 0 {
		nextCursor = freshsalesTaskCursor(filter, page+1)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: nextCursor}), nil
}

func (b FreshsalesRESTBackfiller) fetchDealDetail(ctx context.Context, client *http.Client, baseURL string, creds FreshsalesCredentials, integration Integration, id string) (map[string]any, error) {
	query := url.Values{}
	query.Set("include", "contacts,sales_account,deal_stage")
	var out map[string]any
	path := "/crm/sales/api/deals/" + url.PathEscape(strings.TrimSpace(id))
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, path, query, freshsalesAuthHeaders(creds), nil, firstString(b.UserAgent, creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return nil, err
	}
	if deal, ok := freshsalesMapValue(out["deal"]); ok {
		return deal, nil
	}
	return out, nil
}

func (b FreshsalesRESTBackfiller) fetchAccountDetail(ctx context.Context, client *http.Client, baseURL string, creds FreshsalesCredentials, id string) (map[string]any, error) {
	query := url.Values{}
	query.Set("include", "contacts,owner,territory,business_type")
	var out map[string]any
	path := "/crm/sales/api/sales_accounts/" + url.PathEscape(strings.TrimSpace(id))
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, path, query, freshsalesAuthHeaders(creds), nil, firstString(b.UserAgent, creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return nil, err
	}
	if account, ok := freshsalesMapValue(out["sales_account"]); ok {
		return account, nil
	}
	return out, nil
}

func (b FreshsalesRESTBackfiller) fetchContactDetail(ctx context.Context, client *http.Client, baseURL string, creds FreshsalesCredentials, id string) (freshsalesContact, error) {
	var out map[string]any
	path := "/crm/sales/api/contacts/" + url.PathEscape(strings.TrimSpace(id))
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, path, nil, freshsalesAuthHeaders(creds), nil, firstString(b.UserAgent, creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return freshsalesContact{}, err
	}
	if contact, ok := freshsalesMapValue(out["contact"]); ok {
		mapped, ok := freshsalesContactFromMap(contact)
		if !ok {
			return freshsalesContact{}, fmt.Errorf("freshsales contact %q response is empty", id)
		}
		return mapped, nil
	}
	mapped, ok := freshsalesContactFromMap(out)
	if !ok {
		return freshsalesContact{}, fmt.Errorf("freshsales contact %q response is empty", id)
	}
	return mapped, nil
}

func (b FreshsalesRESTBackfiller) hydrateFreshsalesAccountContacts(ctx context.Context, client *http.Client, baseURL string, creds FreshsalesCredentials, account map[string]any) (map[string]any, error) {
	contacts := freshsalesAccountContacts(account)
	if len(contacts) == 0 {
		return account, nil
	}
	out := mergeFreshsalesMaps(account, nil)
	hydratedContacts := make([]map[string]any, 0, len(contacts))
	for _, contact := range contacts {
		detail := contact
		if freshsalesDealContactEmail(contact) == "" {
			if id := freshsalesRecordString(contact, "id", "contact_id"); id != "" {
				hydrated, err := b.fetchContactDetail(ctx, client, baseURL, creds, id)
				if err != nil {
					return nil, err
				}
				detail = mergeFreshsalesMaps(contact, freshsalesContactMap(hydrated))
			}
		}
		hydratedContacts = append(hydratedContacts, detail)
	}
	out["contacts"] = hydratedContacts
	return out, nil
}

func freshsalesBaseURL(override string, creds FreshsalesCredentials) (string, error) {
	if v := strings.TrimRight(strings.TrimSpace(override), "/"); v != "" {
		return v, nil
	}
	if v := strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"); v != "" {
		return v, nil
	}
	if d := strings.TrimSpace(creds.Domain); d != "" {
		if strings.Contains(d, ".") {
			return "https://" + d, nil
		}
		return "https://" + d + ".myfreshworks.com", nil
	}
	return "", fmt.Errorf("freshsales domain or api_base_url is required")
}

func freshsalesAuthHeaders(creds FreshsalesCredentials) map[string]string {
	return map[string]string{"Authorization": "Token token=" + strings.TrimSpace(creds.APIKey)}
}

func freshsalesAccountViewID(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "account_view_id"),
		settingString(integration.Settings, "sales_account_view_id"),
		settingString(integration.Settings, "freshsales_account_view_id"),
	))
}

func freshsalesDealViewID(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "deal_view_id"),
		settingString(integration.Settings, "deals_view_id"),
		settingString(integration.Settings, "freshsales_deal_view_id"),
	))
}

func freshsalesSyncSalesActivities(integration Integration) bool {
	raw := strings.ToLower(strings.TrimSpace(firstString(
		settingString(integration.Settings, "sync_sales_activities"),
		settingString(integration.Settings, "sync_activities"),
		settingString(integration.Settings, "freshsales_sync_sales_activities"),
	)))
	return raw == "true" || raw == "1" || raw == "yes" || raw == "on"
}

func freshsalesSyncTasks(integration Integration) bool {
	raw := strings.ToLower(strings.TrimSpace(firstString(
		settingString(integration.Settings, "sync_tasks"),
		settingString(integration.Settings, "freshsales_sync_tasks"),
	)))
	return raw == "true" || raw == "1" || raw == "yes" || raw == "on"
}

func freshsalesTaskFilter(integration Integration) string {
	filter := strings.ToLower(strings.TrimSpace(firstString(
		settingString(integration.Settings, "task_filter"),
		settingString(integration.Settings, "freshsales_task_filter"),
		"open",
	)))
	filter = strings.ReplaceAll(filter, " ", "_")
	switch filter {
	case "open", "completed", "complete", "overdue", "due_today", "due_tomorrow":
		if filter == "complete" {
			return "completed"
		}
		return filter
	default:
		return "open"
	}
}

func freshsalesInitialTaskCursor(integration Integration) string {
	return freshsalesTaskCursor(freshsalesTaskFilter(integration), 1)
}

func freshsalesTaskCursor(filter string, page int) string {
	if page <= 0 {
		page = 1
	}
	return freshsalesTaskCursorPrefix + url.PathEscape(strings.TrimSpace(firstString(filter, "open"))) + ":" + strconv.Itoa(page)
}

func freshsalesTaskCursorState(cursor string, integration Integration) (string, int) {
	raw := strings.TrimPrefix(strings.TrimSpace(cursor), freshsalesTaskCursorPrefix)
	parts := strings.Split(raw, ":")
	if len(parts) != 2 {
		return freshsalesTaskFilter(integration), 1
	}
	filter, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(filter) == "" {
		filter = freshsalesTaskFilter(integration)
	}
	page, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || page <= 0 {
		page = 1
	}
	return strings.ToLower(strings.TrimSpace(filter)), page
}

func mapFreshsalesContact(c freshsalesContact, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Email))
	if email == "" {
		return ContactInput{}, false
	}
	id := firstString(strings.TrimSpace(c.ID.String()), email)
	out := ContactInput{
		SourceID:       "freshsales://contact/" + id,
		Email:          email,
		FirstName:      strings.TrimSpace(c.FirstName),
		LastName:       strings.TrimSpace(c.LastName),
		FullName:       strings.TrimSpace(strings.TrimSpace(c.FirstName + " " + c.LastName)),
		Phone:          firstString(strings.TrimSpace(c.MobileNumber), strings.TrimSpace(c.WorkNumber)),
		LifecycleStage: strings.TrimSpace(c.JobTitle),
		ListIDs:        crmListIDs(integration),
		Tags:           crmDefaultTags(integration, "freshsales"),
		Properties:     map[string]any{"freshsales_id": id, "freshsales_raw": c},
	}
	if t := firstParsedHubSpotTime(c.UpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func freshsalesContactMap(c freshsalesContact) map[string]any {
	return map[string]any{
		"id":            strings.TrimSpace(c.ID.String()),
		"email":         strings.TrimSpace(c.Email),
		"first_name":    strings.TrimSpace(c.FirstName),
		"last_name":     strings.TrimSpace(c.LastName),
		"mobile_number": strings.TrimSpace(c.MobileNumber),
		"work_number":   strings.TrimSpace(c.WorkNumber),
		"job_title":     strings.TrimSpace(c.JobTitle),
		"updated_at":    strings.TrimSpace(c.UpdatedAt),
	}
}

func mapFreshsalesAccountContacts(account map[string]any, integration Integration) []ContactInput {
	accountID := freshsalesRecordString(account, "id")
	if accountID == "" {
		return nil
	}
	contacts := freshsalesAccountContacts(account)
	out := make([]ContactInput, 0, len(contacts))
	for _, contact := range contacts {
		if mapped, ok := mapFreshsalesAccountContact(account, contact, integration); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapFreshsalesAccountContact(account, contact map[string]any, integration Integration) (ContactInput, bool) {
	email := freshsalesDealContactEmail(contact)
	if email == "" {
		return ContactInput{}, false
	}
	contactID := freshsalesRecordString(contact, "id", "contact_id")
	sourceContact := firstString(contactID, email)
	firstName := freshsalesRecordString(contact, "first_name")
	lastName := freshsalesRecordString(contact, "last_name")
	fullName := strings.TrimSpace(firstString(
		freshsalesRecordString(contact, "display_name", "name"),
		strings.TrimSpace(firstName+" "+lastName),
	))
	props := freshsalesAccountContextProperties(account)
	props["freshsales_object"] = "sales_account_contact"
	props["freshsales_contact_id"] = contactID
	props["freshsales_contact_raw"] = contact
	out := ContactInput{
		SourceID:       "freshsales://contact/" + sourceContact,
		Email:          email,
		FirstName:      firstName,
		LastName:       lastName,
		FullName:       fullName,
		Phone:          firstString(freshsalesRecordString(contact, "mobile_number", "mobile", "phone_mobile"), freshsalesRecordString(contact, "work_number", "phone", "phone_number", "work_phone")),
		Company:        freshsalesRecordString(account, "name"),
		LifecycleStage: freshsalesRecordString(contact, "job_title", "title"),
		ListIDs:        crmListIDs(integration),
		Tags:           crmDefaultTags(integration, "freshsales"),
		Properties:     props,
		UpdatedAt:      firstParsedHubSpotTime(freshsalesRecordString(contact, "updated_at"), freshsalesRecordString(account, "updated_at")),
	}
	return out, true
}

func mapFreshsalesDealEvents(deal map[string]any, integration Integration) []EventInput {
	dealID := freshsalesRecordString(deal, "id")
	if dealID == "" {
		return nil
	}
	contacts := freshsalesDealContacts(deal)
	events := make([]EventInput, 0, len(contacts))
	for _, contact := range contacts {
		email := strings.ToLower(strings.TrimSpace(firstString(
			freshsalesRecordString(contact, "email", "email_address"),
			freshsalesEmailFromValue(contact["emails"]),
		)))
		if email == "" {
			continue
		}
		contactID := freshsalesRecordString(contact, "id", "contact_id")
		sourceContact := firstString(contactID, email)
		props := map[string]any{
			"freshsales_object":         "deal",
			"freshsales_deal_id":        dealID,
			"freshsales_contact_id":     contactID,
			"freshsales_deal_name":      freshsalesRecordString(deal, "name"),
			"freshsales_amount":         freshsalesRecordString(deal, "amount"),
			"freshsales_base_amount":    freshsalesRecordString(deal, "base_currency_amount"),
			"freshsales_expected_close": freshsalesRecordString(deal, "expected_close"),
			"freshsales_closed_date":    freshsalesRecordString(deal, "closed_date"),
			"freshsales_probability":    freshsalesRecordString(deal, "probability"),
			"freshsales_deal_stage":     freshsalesRecordNestedSummary(deal, "deal_stage"),
			"freshsales_sales_account":  freshsalesRecordNestedSummary(deal, "sales_account"),
			"freshsales_raw":            deal,
		}
		if configured := crmListIDs(integration); len(configured) > 0 {
			props["crm_list_ids"] = configured
		}
		events = append(events, EventInput{
			SourceID:   "freshsales://deal/" + dealID + "/contact/" + sourceContact,
			Email:      email,
			EventName:  freshsalesDealEventName(deal),
			Properties: props,
			OccurredAt: firstParsedHubSpotTime(freshsalesRecordString(deal, "updated_at"), freshsalesRecordString(deal, "stage_updated_time"), freshsalesRecordString(deal, "closed_date"), freshsalesRecordString(deal, "created_at")),
		})
	}
	return events
}

func freshsalesDealEventName(deal map[string]any) string {
	stage := strings.ToLower(strings.TrimSpace(firstString(
		freshsalesRecordNestedString(deal, "deal_stage", "name"),
		freshsalesRecordString(deal, "stage"),
		freshsalesRecordString(deal, "deal_stage"),
	)))
	switch {
	case strings.Contains(stage, "won"):
		return "crm.deal.won"
	case strings.Contains(stage, "lost"):
		return "crm.deal.lost"
	case strings.TrimSpace(freshsalesRecordString(deal, "closed_date")) != "":
		return "crm.deal.closed"
	default:
		return "crm.deal.updated"
	}
}

func freshsalesDealContacts(deal map[string]any) []map[string]any {
	for _, key := range []string{"contacts", "contact"} {
		if contacts := freshsalesMapSliceValue(deal[key]); len(contacts) > 0 {
			return contacts
		}
		if contact, ok := freshsalesMapValue(deal[key]); ok {
			return []map[string]any{contact}
		}
	}
	return nil
}

func freshsalesAccountContacts(account map[string]any) []map[string]any {
	for _, key := range []string{"contacts", "contact"} {
		if contacts := freshsalesMapSliceValue(account[key]); len(contacts) > 0 {
			return contacts
		}
		if contact, ok := freshsalesMapValue(account[key]); ok {
			return []map[string]any{contact}
		}
	}
	return nil
}

func freshsalesDealContactEmail(contact map[string]any) string {
	return strings.ToLower(strings.TrimSpace(firstString(
		freshsalesRecordString(contact, "email", "email_address"),
		freshsalesEmailFromValue(contact["emails"]),
	)))
}

func freshsalesAccountContextProperties(account map[string]any) map[string]any {
	return map[string]any{
		"freshsales_sales_account_id":            freshsalesRecordString(account, "id"),
		"freshsales_sales_account_name":          freshsalesRecordString(account, "name"),
		"freshsales_sales_account_website":       freshsalesRecordString(account, "website", "website_url"),
		"freshsales_sales_account_phone":         freshsalesRecordString(account, "phone", "phone_number"),
		"freshsales_sales_account_industry":      freshsalesRecordNestedSummary(account, "industry"),
		"freshsales_sales_account_business_type": freshsalesRecordNestedSummary(account, "business_type"),
		"freshsales_sales_account_territory":     freshsalesRecordNestedSummary(account, "territory"),
		"freshsales_sales_account_owner":         freshsalesRecordNestedSummary(account, "owner"),
		"freshsales_sales_account_raw":           account,
	}
}

func freshsalesDealContextProperties(deal map[string]any) map[string]any {
	return map[string]any{
		"freshsales_deal_id":        freshsalesRecordString(deal, "id"),
		"freshsales_deal_name":      freshsalesRecordString(deal, "name"),
		"freshsales_amount":         freshsalesRecordString(deal, "amount"),
		"freshsales_base_amount":    freshsalesRecordString(deal, "base_currency_amount"),
		"freshsales_expected_close": freshsalesRecordString(deal, "expected_close"),
		"freshsales_closed_date":    freshsalesRecordString(deal, "closed_date"),
		"freshsales_probability":    freshsalesRecordString(deal, "probability"),
		"freshsales_deal_stage":     freshsalesRecordNestedSummary(deal, "deal_stage"),
		"freshsales_sales_account":  freshsalesRecordNestedSummary(deal, "sales_account"),
		"freshsales_deal_raw":       deal,
	}
}

func mapFreshsalesSalesActivityEvent(activity map[string]any, contact freshsalesContact, integration Integration) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(contact.Email))
	activityID := freshsalesRecordString(activity, "id", "sales_activity_id")
	contactID := firstString(strings.TrimSpace(contact.ID.String()), freshsalesSalesActivityContactID(activity), email)
	if email == "" || activityID == "" {
		return EventInput{}, false
	}
	props := freshsalesSalesActivityProperties(activity, integration)
	props["freshsales_contact_id"] = contactID
	return EventInput{
		SourceID:   "freshsales://sales_activity/" + activityID + "/contact/" + contactID,
		Email:      email,
		EventName:  "crm.activity.completed",
		Properties: props,
		OccurredAt: firstParsedHubSpotTime(freshsalesRecordString(activity, "conversation_time"), freshsalesRecordString(activity, "end_date"), freshsalesRecordString(activity, "start_date"), freshsalesRecordString(activity, "updated_at"), freshsalesRecordString(activity, "created_at")),
	}, true
}

func mapFreshsalesSalesActivityDealEvents(activity, deal map[string]any, integration Integration) []EventInput {
	activityID := freshsalesRecordString(activity, "id", "sales_activity_id")
	dealID := freshsalesRecordString(deal, "id")
	if activityID == "" || dealID == "" {
		return nil
	}
	contacts := freshsalesDealContacts(deal)
	events := make([]EventInput, 0, len(contacts))
	for _, contact := range contacts {
		email := freshsalesDealContactEmail(contact)
		if email == "" {
			continue
		}
		contactID := freshsalesRecordString(contact, "id", "contact_id")
		sourceContact := firstString(contactID, email)
		props := freshsalesSalesActivityProperties(activity, integration)
		props["freshsales_contact_id"] = contactID
		for key, value := range freshsalesDealContextProperties(deal) {
			props[key] = value
		}
		events = append(events, EventInput{
			SourceID:   "freshsales://sales_activity/" + activityID + "/deal/" + dealID + "/contact/" + sourceContact,
			Email:      email,
			EventName:  "crm.activity.completed",
			Properties: props,
			OccurredAt: firstParsedHubSpotTime(freshsalesRecordString(activity, "conversation_time"), freshsalesRecordString(activity, "end_date"), freshsalesRecordString(activity, "start_date"), freshsalesRecordString(activity, "updated_at"), freshsalesRecordString(activity, "created_at")),
		})
	}
	return events
}

func mapFreshsalesSalesActivityAccountEvents(activity, account map[string]any, integration Integration) []EventInput {
	activityID := freshsalesRecordString(activity, "id", "sales_activity_id")
	accountID := freshsalesRecordString(account, "id")
	if activityID == "" || accountID == "" {
		return nil
	}
	contacts := freshsalesAccountContacts(account)
	events := make([]EventInput, 0, len(contacts))
	for _, contact := range contacts {
		email := freshsalesDealContactEmail(contact)
		if email == "" {
			continue
		}
		contactID := freshsalesRecordString(contact, "id", "contact_id")
		sourceContact := firstString(contactID, email)
		props := freshsalesSalesActivityProperties(activity, integration)
		props["freshsales_contact_id"] = contactID
		for key, value := range freshsalesAccountContextProperties(account) {
			props[key] = value
		}
		events = append(events, EventInput{
			SourceID:   "freshsales://sales_activity/" + activityID + "/sales_account/" + accountID + "/contact/" + sourceContact,
			Email:      email,
			EventName:  "crm.activity.completed",
			Properties: props,
			OccurredAt: firstParsedHubSpotTime(freshsalesRecordString(activity, "conversation_time"), freshsalesRecordString(activity, "end_date"), freshsalesRecordString(activity, "start_date"), freshsalesRecordString(activity, "updated_at"), freshsalesRecordString(activity, "created_at")),
		})
	}
	return events
}

func freshsalesSalesActivityProperties(activity map[string]any, integration Integration) map[string]any {
	props := map[string]any{
		"freshsales_object":                    "sales_activity",
		"freshsales_sales_activity_id":         freshsalesRecordString(activity, "id", "sales_activity_id"),
		"freshsales_sales_activity_title":      freshsalesRecordString(activity, "title"),
		"freshsales_sales_activity_type_id":    freshsalesRecordString(activity, "sales_activity_type_id"),
		"freshsales_sales_activity_outcome_id": freshsalesRecordString(activity, "sales_activity_outcome_id"),
		"freshsales_start_date":                freshsalesRecordString(activity, "start_date"),
		"freshsales_end_date":                  freshsalesRecordString(activity, "end_date"),
		"freshsales_conversation_time":         freshsalesRecordString(activity, "conversation_time"),
		"freshsales_targetable_type":           freshsalesRecordString(activity, "targetable_type"),
		"freshsales_targetable_id":             freshsalesRecordString(activity, "targetable_id"),
		"freshsales_owner_id":                  freshsalesRecordString(activity, "owner_id"),
		"freshsales_raw":                       activity,
	}
	if configured := crmListIDs(integration); len(configured) > 0 {
		props["crm_list_ids"] = configured
	}
	return props
}

func freshsalesSalesActivityContactID(activity map[string]any) string {
	targetType := strings.ToLower(strings.TrimSpace(freshsalesRecordString(activity, "targetable_type")))
	if targetType != "" && targetType != "contact" && targetType != "contacts" {
		return ""
	}
	return freshsalesRecordString(activity, "targetable_id", "contact_id")
}

func freshsalesSalesActivityDealID(activity map[string]any) string {
	return freshsalesTargetableDealID(activity)
}

func freshsalesSalesActivityAccountID(activity map[string]any) string {
	return freshsalesTargetableAccountID(activity)
}

func mapFreshsalesTaskEvent(task map[string]any, contact freshsalesContact, filter string, integration Integration) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(contact.Email))
	taskID := freshsalesRecordString(task, "id", "task_id")
	contactID := firstString(strings.TrimSpace(contact.ID.String()), freshsalesTaskContactID(task), email)
	if email == "" || taskID == "" {
		return EventInput{}, false
	}
	props := freshsalesTaskProperties(task, filter, integration)
	props["freshsales_contact_id"] = contactID
	return EventInput{
		SourceID:   "freshsales://task/" + taskID + "/contact/" + contactID,
		Email:      email,
		EventName:  "crm.task.updated",
		Properties: props,
		OccurredAt: firstParsedHubSpotTime(freshsalesRecordString(task, "updated_at"), freshsalesRecordString(task, "due_date"), freshsalesRecordString(task, "created_at")),
	}, true
}

func mapFreshsalesTaskDealEvents(task, deal map[string]any, filter string, integration Integration) []EventInput {
	taskID := freshsalesRecordString(task, "id", "task_id")
	dealID := freshsalesRecordString(deal, "id")
	if taskID == "" || dealID == "" {
		return nil
	}
	contacts := freshsalesDealContacts(deal)
	events := make([]EventInput, 0, len(contacts))
	for _, contact := range contacts {
		email := freshsalesDealContactEmail(contact)
		if email == "" {
			continue
		}
		contactID := freshsalesRecordString(contact, "id", "contact_id")
		sourceContact := firstString(contactID, email)
		props := freshsalesTaskProperties(task, filter, integration)
		props["freshsales_contact_id"] = contactID
		for key, value := range freshsalesDealContextProperties(deal) {
			props[key] = value
		}
		events = append(events, EventInput{
			SourceID:   "freshsales://task/" + taskID + "/deal/" + dealID + "/contact/" + sourceContact,
			Email:      email,
			EventName:  "crm.task.updated",
			Properties: props,
			OccurredAt: firstParsedHubSpotTime(freshsalesRecordString(task, "updated_at"), freshsalesRecordString(task, "due_date"), freshsalesRecordString(task, "created_at")),
		})
	}
	return events
}

func mapFreshsalesTaskAccountEvents(task, account map[string]any, filter string, integration Integration) []EventInput {
	taskID := freshsalesRecordString(task, "id", "task_id")
	accountID := freshsalesRecordString(account, "id")
	if taskID == "" || accountID == "" {
		return nil
	}
	contacts := freshsalesAccountContacts(account)
	events := make([]EventInput, 0, len(contacts))
	for _, contact := range contacts {
		email := freshsalesDealContactEmail(contact)
		if email == "" {
			continue
		}
		contactID := freshsalesRecordString(contact, "id", "contact_id")
		sourceContact := firstString(contactID, email)
		props := freshsalesTaskProperties(task, filter, integration)
		props["freshsales_contact_id"] = contactID
		for key, value := range freshsalesAccountContextProperties(account) {
			props[key] = value
		}
		events = append(events, EventInput{
			SourceID:   "freshsales://task/" + taskID + "/sales_account/" + accountID + "/contact/" + sourceContact,
			Email:      email,
			EventName:  "crm.task.updated",
			Properties: props,
			OccurredAt: firstParsedHubSpotTime(freshsalesRecordString(task, "updated_at"), freshsalesRecordString(task, "due_date"), freshsalesRecordString(task, "created_at")),
		})
	}
	return events
}

func freshsalesTaskProperties(task map[string]any, filter string, integration Integration) map[string]any {
	props := map[string]any{
		"freshsales_object":          "task",
		"freshsales_task_id":         freshsalesRecordString(task, "id", "task_id"),
		"freshsales_task_title":      freshsalesRecordString(task, "title"),
		"freshsales_task_status":     freshsalesRecordString(task, "status"),
		"freshsales_task_filter":     strings.TrimSpace(filter),
		"freshsales_task_due_date":   freshsalesRecordString(task, "due_date"),
		"freshsales_task_owner_id":   freshsalesRecordString(task, "owner_id"),
		"freshsales_targetable_type": freshsalesRecordString(task, "targetable_type"),
		"freshsales_targetable_id":   firstString(freshsalesRecordString(task, "targetable_id"), freshsalesRecordNestedString(task, "targetable", "id")),
		"freshsales_raw":             task,
	}
	if configured := crmListIDs(integration); len(configured) > 0 {
		props["crm_list_ids"] = configured
	}
	return props
}

func freshsalesTaskContactID(task map[string]any) string {
	if target, ok := freshsalesMapValue(task["targetable"]); ok {
		targetType := strings.ToLower(strings.TrimSpace(firstString(freshsalesRecordString(target, "type"), freshsalesRecordString(task, "targetable_type"))))
		if targetType != "" && targetType != "contact" && targetType != "contacts" {
			return ""
		}
		if id := freshsalesRecordString(target, "id"); id != "" {
			return id
		}
	}
	targetType := strings.ToLower(strings.TrimSpace(freshsalesRecordString(task, "targetable_type")))
	if targetType != "" && targetType != "contact" && targetType != "contacts" {
		return ""
	}
	return freshsalesRecordString(task, "targetable_id", "contact_id")
}

func freshsalesTaskDealID(task map[string]any) string {
	return freshsalesTargetableDealID(task)
}

func freshsalesTaskAccountID(task map[string]any) string {
	return freshsalesTargetableAccountID(task)
}

func freshsalesTargetableDealID(record map[string]any) string {
	if target, ok := freshsalesMapValue(record["targetable"]); ok {
		targetType := freshsalesNormalizeTargetType(firstString(freshsalesRecordString(target, "type", "targetable_type"), freshsalesRecordString(record, "targetable_type")))
		if freshsalesIsDealTargetType(targetType) {
			return firstString(freshsalesRecordString(target, "id", "targetable_id", "deal_id"), freshsalesRecordString(record, "targetable_id", "deal_id"))
		}
		if targetType != "" {
			return ""
		}
	}
	targetType := freshsalesNormalizeTargetType(freshsalesRecordString(record, "targetable_type"))
	if freshsalesIsDealTargetType(targetType) {
		return freshsalesRecordString(record, "targetable_id", "deal_id")
	}
	if targetType != "" {
		return ""
	}
	return freshsalesRecordString(record, "deal_id")
}

func freshsalesTargetableAccountID(record map[string]any) string {
	if target, ok := freshsalesMapValue(record["targetable"]); ok {
		targetType := freshsalesNormalizeTargetType(firstString(freshsalesRecordString(target, "type", "targetable_type"), freshsalesRecordString(record, "targetable_type")))
		if freshsalesIsAccountTargetType(targetType) {
			return firstString(freshsalesRecordString(target, "id", "targetable_id", "sales_account_id", "account_id"), freshsalesRecordString(record, "targetable_id", "sales_account_id", "account_id"))
		}
		if targetType != "" {
			return ""
		}
	}
	targetType := freshsalesNormalizeTargetType(freshsalesRecordString(record, "targetable_type"))
	if freshsalesIsAccountTargetType(targetType) {
		return freshsalesRecordString(record, "targetable_id", "sales_account_id", "account_id")
	}
	if targetType != "" {
		return ""
	}
	return freshsalesRecordString(record, "sales_account_id", "account_id")
}

func freshsalesNormalizeTargetType(raw string) string {
	out := strings.ToLower(strings.TrimSpace(raw))
	out = strings.ReplaceAll(out, "-", "_")
	out = strings.ReplaceAll(out, " ", "_")
	return out
}

func freshsalesIsDealTargetType(targetType string) bool {
	switch freshsalesNormalizeTargetType(targetType) {
	case "deal", "deals", "sales_deal", "sales_deals", "salesdeal":
		return true
	default:
		return false
	}
}

func freshsalesIsAccountTargetType(targetType string) bool {
	switch freshsalesNormalizeTargetType(targetType) {
	case "account", "accounts", "sales_account", "sales_accounts", "salesaccount":
		return true
	default:
		return false
	}
}

func freshsalesRecordString(record map[string]any, keys ...string) string {
	if len(record) == 0 {
		return ""
	}
	for _, key := range keys {
		if value, ok := record[key]; ok {
			if out := freshsalesStringValue(value); out != "" {
				return out
			}
		}
	}
	return ""
}

func freshsalesRecordNestedString(record map[string]any, parent string, keys ...string) string {
	if nested, ok := freshsalesMapValue(record[parent]); ok {
		return freshsalesRecordString(nested, keys...)
	}
	return ""
}

func freshsalesRecordNestedSummary(record map[string]any, key string) map[string]any {
	nested, ok := freshsalesMapValue(record[key])
	if !ok {
		return nil
	}
	return map[string]any{
		"id":   freshsalesRecordString(nested, "id"),
		"name": firstString(freshsalesRecordString(nested, "name"), freshsalesRecordString(nested, "display_name")),
	}
}

func freshsalesMapValue(value any) (map[string]any, bool) {
	typed, ok := value.(map[string]any)
	return typed, ok && len(typed) > 0
}

func freshsalesMapSliceValue(value any) []map[string]any {
	switch typed := value.(type) {
	case []map[string]any:
		return typed
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if mapped, ok := freshsalesMapValue(item); ok {
				out = append(out, mapped)
			}
		}
		return out
	}
	return nil
}

func mergeFreshsalesMaps(base, overlay map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(overlay))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range overlay {
		out[k] = v
	}
	return out
}
