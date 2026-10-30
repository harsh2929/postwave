// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeStore struct {
	integration  Integration
	runs         []SyncRun
	lastInput    IntegrationInput
	provisionErr error
	webhooks     map[string]WebhookClaim
	recordErr    error
}

type fakeZendeskBackfiller struct {
	req             SyncRequest
	err             error
	refreshReq      SyncRequest
	refreshErr      error
	refreshTicketID string
	refreshCalls    int
	deleteResult    ZendeskWebhookCleanupResult
	deleteErr       error
	deleteWebhookID string
	deleteCalls     int
}

func (f fakeZendeskBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeZendeskBackfiller) RefreshTicket(_ context.Context, _ string, _ Integration, ticketID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshTicketID = strings.TrimSpace(ticketID)
	return f.refreshReq, f.refreshErr
}

func (f *fakeZendeskBackfiller) DeleteZendeskWebhook(_ context.Context, _ string, _ Integration, webhookID string) (ZendeskWebhookCleanupResult, error) {
	f.deleteCalls++
	f.deleteWebhookID = strings.TrimSpace(webhookID)
	if f.deleteErr != nil {
		return ZendeskWebhookCleanupResult{}, f.deleteErr
	}
	if f.deleteResult.Status == "" {
		f.deleteResult = ZendeskWebhookCleanupResult{WebhookID: webhookID, Status: "deleted"}
	}
	return f.deleteResult, nil
}

type fakeIntercomBackfiller struct {
	req                   SyncRequest
	err                   error
	refreshReq            SyncRequest
	refreshErr            error
	refreshConversationID string
	refreshCalls          int
}

func (f fakeIntercomBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeIntercomBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, conversationID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshConversationID = strings.TrimSpace(conversationID)
	return f.refreshReq, f.refreshErr
}

type fakeGorgiasBackfiller struct {
	req                 SyncRequest
	err                 error
	refreshReq          SyncRequest
	refreshErr          error
	refreshTicketID     string
	refreshCalls        int
	deleteResult        GorgiasHTTPIntegrationCleanupResult
	deleteErr           error
	deleteIntegrationID string
	deleteCalls         int
}

func (f fakeGorgiasBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeGorgiasBackfiller) RefreshTicket(_ context.Context, _ string, _ Integration, ticketID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshTicketID = strings.TrimSpace(ticketID)
	return f.refreshReq, f.refreshErr
}

func (f *fakeGorgiasBackfiller) DeleteGorgiasHTTPIntegration(_ context.Context, _ string, _ Integration, integrationID string) (GorgiasHTTPIntegrationCleanupResult, error) {
	f.deleteCalls++
	f.deleteIntegrationID = strings.TrimSpace(integrationID)
	if f.deleteErr != nil {
		return GorgiasHTTPIntegrationCleanupResult{}, f.deleteErr
	}
	if f.deleteResult.Status == "" {
		f.deleteResult = GorgiasHTTPIntegrationCleanupResult{IntegrationID: integrationID, Status: "deleted"}
	}
	return f.deleteResult, nil
}

type fakeGorgiasCommerceResolver struct {
	calls       int
	tenantID    string
	email       string
	integration Integration
	props       map[string]any
	err         error
}

func (f *fakeGorgiasCommerceResolver) ResolveGorgiasCommerceContext(_ context.Context, tenantID string, integration Integration, email string, properties map[string]any) (map[string]any, error) {
	f.calls++
	f.tenantID = tenantID
	f.email = email
	f.integration = integration
	f.props = properties
	if f.err != nil {
		return properties, f.err
	}
	out := map[string]any{}
	for k, v := range properties {
		out[k] = v
	}
	out["commerce_resolution_target_integration_id"] = settingString(integration.Settings, "commerce_integration_id")
	out["resolved_order_id"] = "order_uuid_1"
	out["order_resolution"] = "commerce_orders"
	out["resolved_customer_id"] = "customer_uuid_1"
	out["customer_resolution"] = "commerce_customers"
	out["resolved_product_id"] = "product_uuid_1"
	out["product_resolution"] = "commerce_products"
	return out, nil
}

type fakeFreshdeskBackfiller struct {
	req             SyncRequest
	err             error
	refreshReq      SyncRequest
	refreshErr      error
	refreshTicketID string
	refreshCalls    int
}

func (f fakeFreshdeskBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeFreshdeskBackfiller) RefreshTicket(_ context.Context, _ string, _ Integration, ticketID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshTicketID = strings.TrimSpace(ticketID)
	return f.refreshReq, f.refreshErr
}

type fakeHelpScoutBackfiller struct {
	req                   SyncRequest
	err                   error
	refreshReq            SyncRequest
	refreshErr            error
	refreshConversationID string
	refreshCalls          int
}

func (f fakeHelpScoutBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeHelpScoutBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, conversationID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshConversationID = strings.TrimSpace(conversationID)
	return f.refreshReq, f.refreshErr
}

type fakeFrontBackfiller struct {
	req                   SyncRequest
	err                   error
	refreshReq            SyncRequest
	refreshErr            error
	refreshConversationID string
	refreshCalls          int
}

func (f fakeFrontBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeFrontBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, conversationID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshConversationID = strings.TrimSpace(conversationID)
	return f.refreshReq, f.refreshErr
}

type fakeCrispBackfiller struct {
	req              SyncRequest
	err              error
	refreshReq       SyncRequest
	refreshErr       error
	refreshSessionID string
	refreshCalls     int
}

func (f fakeCrispBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeCrispBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, sessionID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshSessionID = strings.TrimSpace(sessionID)
	return f.refreshReq, f.refreshErr
}

type fakeKustomerBackfiller struct {
	req                   SyncRequest
	err                   error
	refreshReq            SyncRequest
	refreshErr            error
	refreshConversationID string
	refreshCalls          int
}

func (f fakeKustomerBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeKustomerBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, conversationID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshConversationID = strings.TrimSpace(conversationID)
	return f.refreshReq, f.refreshErr
}

type fakeDriftBackfiller struct {
	req                   SyncRequest
	err                   error
	refreshReq            SyncRequest
	refreshErr            error
	refreshConversationID string
	refreshCalls          int
}

func (f fakeDriftBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeDriftBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, conversationID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshConversationID = strings.TrimSpace(conversationID)
	return f.refreshReq, f.refreshErr
}

type fakeLiveChatBackfiller struct {
	req                SyncRequest
	err                error
	registerResults    []LiveChatWebhookRegistrationResult
	registerErr        error
	registerCalls      []LiveChatWebhookRegistrationInput
	unregisterResults  []LiveChatWebhookCleanupResult
	unregisterErr      error
	unregisterCalls    []string
	unregisterOwnerIDs []string
}

func (f fakeLiveChatBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeLiveChatBackfiller) RegisterLiveChatWebhook(_ context.Context, _ string, _ Integration, input LiveChatWebhookRegistrationInput) (LiveChatWebhookRegistrationResult, error) {
	f.registerCalls = append(f.registerCalls, input)
	if f.registerErr != nil {
		return LiveChatWebhookRegistrationResult{}, f.registerErr
	}
	if len(f.registerResults) >= len(f.registerCalls) {
		result := f.registerResults[len(f.registerCalls)-1]
		if result.Action == "" {
			result.Action = input.Action
		}
		return result, nil
	}
	return LiveChatWebhookRegistrationResult{ProviderWebhookID: "livechat_provider_wh_" + strconv.Itoa(len(f.registerCalls)), Action: input.Action}, nil
}

func (f *fakeLiveChatBackfiller) UnregisterLiveChatWebhook(_ context.Context, _ string, _ Integration, providerWebhookID, ownerClientID string) (LiveChatWebhookCleanupResult, error) {
	f.unregisterCalls = append(f.unregisterCalls, strings.TrimSpace(providerWebhookID))
	f.unregisterOwnerIDs = append(f.unregisterOwnerIDs, strings.TrimSpace(ownerClientID))
	if f.unregisterErr != nil {
		return LiveChatWebhookCleanupResult{}, f.unregisterErr
	}
	if len(f.unregisterResults) >= len(f.unregisterCalls) {
		result := f.unregisterResults[len(f.unregisterCalls)-1]
		if result.ProviderWebhookID == "" {
			result.ProviderWebhookID = strings.TrimSpace(providerWebhookID)
		}
		if result.Status == "" {
			result.Status = "deleted"
		}
		return result, nil
	}
	return LiveChatWebhookCleanupResult{ProviderWebhookID: strings.TrimSpace(providerWebhookID), Status: "deleted"}, nil
}

type fakeZohoDeskBackfiller struct {
	req             SyncRequest
	err             error
	refreshReq      SyncRequest
	refreshErr      error
	refreshTicketID string
	refreshCalls    int
	HTTPClient      *http.Client
}

func (f fakeZohoDeskBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeZohoDeskBackfiller) RefreshTicket(_ context.Context, _ string, _ Integration, ticketID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshTicketID = strings.TrimSpace(ticketID)
	return f.refreshReq, f.refreshErr
}

type fakeKayakoBackfiller struct {
	req           SyncRequest
	err           error
	refreshReq    SyncRequest
	refreshErr    error
	refreshCaseID string
	refreshCalls  int
}

func (f fakeKayakoBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeKayakoBackfiller) RefreshCase(_ context.Context, _ string, _ Integration, caseID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshCaseID = strings.TrimSpace(caseID)
	return f.refreshReq, f.refreshErr
}

type fakeHubSpotServiceHubBackfiller struct {
	req             SyncRequest
	err             error
	refreshReq      SyncRequest
	refreshErr      error
	refreshTicketID string
	refreshCalls    int
}

func (f fakeHubSpotServiceHubBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeHubSpotServiceHubBackfiller) RefreshTicket(_ context.Context, _ string, _ Integration, ticketID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshTicketID = strings.TrimSpace(ticketID)
	return f.refreshReq, f.refreshErr
}

type fakeSalesforceServiceCloudBackfiller struct {
	req           SyncRequest
	err           error
	refreshReq    SyncRequest
	refreshErr    error
	refreshCaseID string
	refreshCalls  int
}

func (f fakeSalesforceServiceCloudBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeSalesforceServiceCloudBackfiller) RefreshCase(_ context.Context, _ string, _ Integration, caseID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshCaseID = strings.TrimSpace(caseID)
	return f.refreshReq, f.refreshErr
}

type fakeJiraServiceManagementBackfiller struct {
	req            SyncRequest
	err            error
	refreshReq     SyncRequest
	refreshErr     error
	refreshIssueID string
	refreshCalls   int
}

func (f fakeJiraServiceManagementBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeJiraServiceManagementBackfiller) RefreshRequest(_ context.Context, _ string, _ Integration, issueIDOrKey string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshIssueID = strings.TrimSpace(issueIDOrKey)
	return f.refreshReq, f.refreshErr
}

type fakeLinearBackfiller struct {
	req            SyncRequest
	err            error
	refreshReq     SyncRequest
	refreshErr     error
	refreshIssueID string
	refreshCalls   int
}

func (f fakeLinearBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeLinearBackfiller) RefreshIssue(_ context.Context, _ string, _ Integration, issueID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshIssueID = strings.TrimSpace(issueID)
	return f.refreshReq, f.refreshErr
}

type fakeAsanaSupportBackfiller struct {
	req           SyncRequest
	err           error
	refreshReq    SyncRequest
	refreshErr    error
	refreshTaskID string
	refreshCalls  int
}

func (f fakeAsanaSupportBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeAsanaSupportBackfiller) RefreshTask(_ context.Context, _ string, _ Integration, taskID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshTaskID = strings.TrimSpace(taskID)
	return f.refreshReq, f.refreshErr
}

type fakeClickUpSupportBackfiller struct {
	req           SyncRequest
	err           error
	refreshReq    SyncRequest
	refreshErr    error
	refreshTaskID string
	refreshCalls  int
}

func (f fakeClickUpSupportBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeClickUpSupportBackfiller) RefreshTask(_ context.Context, _ string, _ Integration, taskID string) (SyncRequest, error) {
	f.refreshCalls++
	f.refreshTaskID = strings.TrimSpace(taskID)
	return f.refreshReq, f.refreshErr
}

type recordingSupportBackfiller struct {
	req         SyncRequest
	err         error
	calls       int
	cursor      string
	tenantID    string
	integration Integration
}

func (f *recordingSupportBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.calls++
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	return f.req, nil
}

type supportProviderTestCase struct {
	name       string
	provider   string
	settings   map[string]any
	cursor     string
	nextCursor string
	assign     func(*Deps, *recordingSupportBackfiller)
}

func supportProviderTestCases() []supportProviderTestCase {
	return []supportProviderTestCase{
		{
			name:       "zendesk",
			provider:   ProviderZendesk,
			settings:   map[string]any{"subdomain": "acme", "credentials_ref": "cred_zendesk_1"},
			cursor:     zendeskCursorPrefix + "cur_1",
			nextCursor: zendeskCursorPrefix + "cur_2",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.ZendeskBackfiller = b
			},
		},
		{
			name:       "intercom",
			provider:   ProviderIntercom,
			settings:   map[string]any{"workspace_id": "workspace_123", "credentials_ref": "cred_intercom_1"},
			cursor:     intercomCursorPrefix + "cur_1",
			nextCursor: intercomCursorPrefix + "cur_2",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.IntercomBackfiller = b
			},
		},
		{
			name:       "gorgias",
			provider:   ProviderGorgias,
			settings:   map[string]any{"account_domain": "acme.gorgias.com", "credentials_ref": "cred_gorgias_1"},
			cursor:     gorgiasCursorPrefix + "cur_1",
			nextCursor: gorgiasCursorPrefix + "cur_2",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.GorgiasBackfiller = b
			},
		},
		{
			name:       "help_scout",
			provider:   ProviderHelpScout,
			settings:   map[string]any{"mailbox_id": "mailbox_123", "credentials_ref": "cred_helpscout_1"},
			cursor:     helpScoutCursorPrefix + "2",
			nextCursor: helpScoutCursorPrefix + "3",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.HelpScoutBackfiller = b
			},
		},
		{
			name:       "freshdesk",
			provider:   ProviderFreshdesk,
			settings:   map[string]any{"account_domain": "acme.freshdesk.com", "credentials_ref": "cred_freshdesk_1"},
			cursor:     freshdeskCursorPrefix + "2",
			nextCursor: freshdeskCursorPrefix + "3",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.FreshdeskBackfiller = b
			},
		},
		{
			name:       "front",
			provider:   ProviderFront,
			settings:   map[string]any{"inbox_id": "inb_123", "credentials_ref": "cred_front_1"},
			cursor:     frontCursorPrefix + "https://api2.frontapp.com/conversations?page_token=one",
			nextCursor: frontCursorPrefix + "https://api2.frontapp.com/conversations?page_token=two",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.FrontBackfiller = b
			},
		},
		{
			name:       "reamaze",
			provider:   ProviderReamaze,
			settings:   map[string]any{"account_domain": "acme.reamaze.com", "credentials_ref": "cred_reamaze_1"},
			cursor:     reamazeCursorPrefix + "2",
			nextCursor: reamazeCursorPrefix + "3",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.ReamazeBackfiller = b
			},
		},
		{
			name:       "crisp",
			provider:   ProviderCrisp,
			settings:   map[string]any{"website_id": "website_123", "credentials_ref": "cred_crisp_1"},
			cursor:     crispCursorPrefix + "2",
			nextCursor: crispCursorPrefix + "3",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.CrispBackfiller = b
			},
		},
		{
			name:       "kustomer",
			provider:   ProviderKustomer,
			settings:   map[string]any{"organization_id": "org_123", "credentials_ref": "cred_kustomer_1"},
			cursor:     kustomerCursorPrefix + "2",
			nextCursor: kustomerCursorPrefix + "3",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.KustomerBackfiller = b
			},
		},
		{
			name:       "drift",
			provider:   ProviderDrift,
			settings:   map[string]any{"workspace_id": "workspace_123", "credentials_ref": "cred_drift_1"},
			cursor:     driftCursorPrefix + "2",
			nextCursor: driftCursorPrefix + "3",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.DriftBackfiller = b
			},
		},
		{
			name:       "livechat",
			provider:   ProviderLiveChat,
			settings:   map[string]any{"account_id": "account_123", "credentials_ref": "cred_livechat_1"},
			cursor:     liveChatCursorPrefix + "page_1",
			nextCursor: liveChatCursorPrefix + "page_2",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.LiveChatBackfiller = b
			},
		},
		{
			name:       "zoho_desk",
			provider:   ProviderZohoDesk,
			settings:   map[string]any{"organization_id": "org_123", "credentials_ref": "cred_zohodesk_1"},
			cursor:     zohoDeskCursorPrefix + "100",
			nextCursor: zohoDeskCursorPrefix + "200",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.ZohoDeskBackfiller = b
			},
		},
		{
			name:       "olark",
			provider:   ProviderOlark,
			settings:   map[string]any{"site_id": "site_123", "credentials_ref": "cred_olark_1"},
			cursor:     olarkCursorPrefix + "100",
			nextCursor: olarkCursorPrefix + "200",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.OlarkBackfiller = b
			},
		},
		{
			name:       "kayako",
			provider:   ProviderKayako,
			settings:   map[string]any{"account_domain": "acme.kayako.com", "credentials_ref": "cred_kayako_1"},
			cursor:     kayakoCursorPrefix + "100",
			nextCursor: kayakoCursorPrefix + "200",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.KayakoBackfiller = b
			},
		},
		{
			name:       "hubspot_service_hub",
			provider:   ProviderHubSpotServiceHub,
			settings:   map[string]any{"portal_id": "123456", "credentials_ref": "cred_hubspot_service_1"},
			cursor:     hubSpotServiceCursorPrefix + "after_1",
			nextCursor: hubSpotServiceCursorPrefix + "after_2",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.HubSpotServiceHubBackfiller = b
			},
		},
		{
			name:       "salesforce_service_cloud",
			provider:   ProviderSalesforceServiceCloud,
			settings:   map[string]any{"instance_url": "https://acme.my.salesforce.com", "credentials_ref": "cred_salesforce_service_1"},
			cursor:     salesforceServiceCursorPrefix + "/services/data/v59.0/query/01g-1000",
			nextCursor: salesforceServiceCursorPrefix + "/services/data/v59.0/query/01g-2000",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.SalesforceServiceCloudBackfiller = b
			},
		},
		{
			name:       "jira_service_management",
			provider:   ProviderJiraServiceManagement,
			settings:   map[string]any{"site_id": "site_123", "service_desk_id": "desk_456", "credentials_ref": "cred_jira_service_1"},
			cursor:     jiraServiceCursorPrefix + "100",
			nextCursor: jiraServiceCursorPrefix + "200",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.JiraServiceManagementBackfiller = b
			},
		},
		{
			name:       "linear",
			provider:   ProviderLinear,
			settings:   map[string]any{"workspace_id": "workspace_123", "team_id": "team_456", "credentials_ref": "cred_linear_1"},
			cursor:     linearCursorPrefix + "cursor_1",
			nextCursor: linearCursorPrefix + "cursor_2",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.LinearBackfiller = b
			},
		},
		{
			name:       "asana_support",
			provider:   ProviderAsanaSupport,
			settings:   map[string]any{"workspace_id": "workspace_123", "project_id": "project_456", "credentials_ref": "cred_asana_support_1"},
			cursor:     asanaCursorPrefix + "offset_1",
			nextCursor: asanaCursorPrefix + "offset_2",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.AsanaSupportBackfiller = b
			},
		},
		{
			name:       "clickup_support",
			provider:   ProviderClickUpSupport,
			settings:   map[string]any{"workspace_id": "workspace_123", "list_id": "list_456", "credentials_ref": "cred_clickup_support_1"},
			cursor:     clickUpCursorPrefix + "1",
			nextCursor: clickUpCursorPrefix + "2",
			assign: func(d *Deps, b *recordingSupportBackfiller) {
				d.ClickUpSupportBackfiller = b
			},
		},
	}
}

func newFakeStore() *fakeStore {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	return &fakeStore{integration: Integration{
		ID:             "support_1",
		TenantID:       "tenant-1",
		Provider:       ProviderZendesk,
		Name:           "Zendesk support",
		Status:         "connected",
		Scopes:         []string{"tickets.read"},
		CredentialsRef: "cred_zendesk_1",
		Settings:       map[string]any{"subdomain": "acme"},
		CreatedAt:      now,
		UpdatedAt:      now,
	}}
}

func (f *fakeStore) FindSupportIntegrationByIngestToken(_ context.Context, token string) (*Integration, error) {
	if settingString(f.integration.Settings, supportIngestTokenSetting) != strings.TrimSpace(token) ||
		f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindZendeskIntegrationBySubdomain(_ context.Context, subdomain, webhookID string) (*Integration, error) {
	subdomain = strings.ToLower(strings.TrimSpace(subdomain))
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderZendesk || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	if subdomain == "" || subdomain != strings.ToLower(strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "subdomain"),
		settingString(f.integration.Settings, "zendesk_subdomain"),
		settingString(f.integration.Settings, "provider_subdomain"),
	))) {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "zendesk_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindIntercomIntegrationByWorkspace(_ context.Context, workspaceID string) (*Integration, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if f.integration.Provider != ProviderIntercom || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredWorkspaceID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "workspace_id"),
		settingString(f.integration.Settings, "intercom_workspace_id"),
		settingString(f.integration.Settings, "app_id"),
	))
	if workspaceID == "" || workspaceID != configuredWorkspaceID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindGorgiasIntegrationByDomain(_ context.Context, accountDomain, integrationID string) (*Integration, error) {
	accountDomain = normalizeGorgiasWebhookDomain(accountDomain)
	integrationID = strings.TrimSpace(integrationID)
	if f.integration.Provider != ProviderGorgias || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredDomain := normalizeGorgiasWebhookDomain(firstString(
		settingString(f.integration.Settings, "account_domain"),
		settingString(f.integration.Settings, "domain"),
		settingString(f.integration.Settings, "subdomain"),
	))
	configuredBare := strings.TrimSuffix(configuredDomain, ".gorgias.com")
	requestBare := strings.TrimSuffix(accountDomain, ".gorgias.com")
	if accountDomain == "" || (accountDomain != configuredDomain && requestBare != configuredBare) {
		return nil, ErrNotFound
	}
	configuredIntegrationID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "gorgias_http_integration_id"),
		settingString(f.integration.Settings, "gorgias_integration_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if integrationID != "" {
		if configuredIntegrationID != integrationID {
			return nil, ErrNotFound
		}
	} else if configuredIntegrationID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindFreshdeskIntegrationByDomain(_ context.Context, accountDomain, webhookID string) (*Integration, error) {
	accountDomain = normalizeFreshdeskWebhookDomain(accountDomain)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderFreshdesk || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredDomain := normalizeFreshdeskWebhookDomain(firstString(
		settingString(f.integration.Settings, "account_domain"),
		settingString(f.integration.Settings, "domain"),
		settingString(f.integration.Settings, "subdomain"),
	))
	if accountDomain == "" || accountDomain != configuredDomain {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "freshdesk_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" && configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindFreshchatIntegrationByDomain(_ context.Context, accountDomain, webhookID string) (*Integration, error) {
	accountDomain = normalizeFreshchatWebhookDomain(accountDomain)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderFreshchat || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredDomain := normalizeFreshchatWebhookDomain(firstString(
		settingString(f.integration.Settings, "account_domain"),
		settingString(f.integration.Settings, "domain"),
		settingString(f.integration.Settings, "workspace_url"),
	))
	if accountDomain == "" || accountDomain != configuredDomain {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "freshchat_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" && configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	if webhookID == "" && configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindTidioIntegrationByProject(_ context.Context, projectPublicKey, webhookID string) (*Integration, error) {
	projectPublicKey = normalizeTidioProjectPublicKey(projectPublicKey)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderTidio || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredProjectKey := normalizeTidioProjectPublicKey(firstString(
		settingString(f.integration.Settings, "project_public_key"),
		settingString(f.integration.Settings, "tidio_project_public_key"),
		settingString(f.integration.Settings, "provider_project_public_key"),
	))
	if projectPublicKey == "" || projectPublicKey != configuredProjectKey {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "tidio_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindAdaIntegrationByAgent(_ context.Context, aiAgentDomain, webhookID string) (*Integration, error) {
	aiAgentDomain = normalizeAdaAgentDomain(aiAgentDomain)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderAda || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredAgentDomain := normalizeAdaAgentDomain(firstString(
		settingString(f.integration.Settings, "ai_agent_domain"),
		settingString(f.integration.Settings, "ada_ai_agent_domain"),
		settingString(f.integration.Settings, "bot_id"),
		settingString(f.integration.Settings, "provider_ai_agent_domain"),
		settingString(f.integration.Settings, "provider_domain"),
	))
	if aiAgentDomain == "" || aiAgentDomain != configuredAgentDomain {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "ada_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindHelpScoutIntegrationByMailbox(_ context.Context, mailboxID, webhookID string) (*Integration, error) {
	mailboxID = strings.TrimSpace(mailboxID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderHelpScout || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredMailboxID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "mailbox_id"),
		settingString(f.integration.Settings, "help_scout_mailbox_id"),
		settingString(f.integration.Settings, "provider_mailbox_id"),
	))
	if mailboxID == "" || mailboxID != configuredMailboxID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "help_scout_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" && configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindGladlyIntegrationByOrganization(_ context.Context, organizationDomain, webhookID string) (*Integration, error) {
	organizationDomain = normalizeGladlyOrganizationDomain(organizationDomain)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderGladly || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredOrganization := normalizeGladlyOrganizationDomain(firstString(
		settingString(f.integration.Settings, "organization_domain"),
		settingString(f.integration.Settings, "organization_id"),
		settingString(f.integration.Settings, "gladly_organization_domain"),
		settingString(f.integration.Settings, "account_domain"),
		settingString(f.integration.Settings, "domain"),
		settingString(f.integration.Settings, "subdomain"),
	))
	if organizationDomain == "" || organizationDomain != configuredOrganization {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "gladly_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	if webhookID == "" && configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindGrooveIntegrationByMailbox(_ context.Context, mailboxID, webhookID string) (*Integration, error) {
	mailboxID = strings.TrimSpace(mailboxID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderGroove || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredMailboxID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "mailbox_id"),
		settingString(f.integration.Settings, "provider_mailbox_id"),
		settingString(f.integration.Settings, "groove_mailbox_id"),
	))
	if mailboxID == "" || mailboxID != configuredMailboxID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "groove_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID == "" || webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindReamazeIntegrationByDomain(_ context.Context, accountDomain, webhookID string) (*Integration, error) {
	accountDomain = normalizeReamazeAccountDomain(accountDomain)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderReamaze || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredDomain := normalizeReamazeAccountDomain(firstString(
		settingString(f.integration.Settings, "account_domain"),
		settingString(f.integration.Settings, "brand"),
		settingString(f.integration.Settings, "subdomain"),
		settingString(f.integration.Settings, "domain"),
	))
	if accountDomain == "" || accountDomain != configuredDomain {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "reamaze_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID == "" || webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindHelpCrunchIntegrationByOrganization(_ context.Context, organizationID, webhookID string) (*Integration, error) {
	organizationID = strings.TrimSpace(organizationID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderHelpCrunch || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredOrganizationID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "organization_id"),
		settingString(f.integration.Settings, "helpcrunch_organization_id"),
		settingString(f.integration.Settings, "provider_organization_id"),
	))
	if organizationID == "" || organizationID != configuredOrganizationID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "helpcrunch_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" && configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindJiraServiceManagementIntegrationBySite(_ context.Context, siteID, webhookID string) (*Integration, error) {
	siteID = normalizeJiraServiceManagementSiteLookup(siteID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderJiraServiceManagement || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredSiteID := normalizeJiraServiceManagementSiteLookup(firstString(
		settingString(f.integration.Settings, "site_id"),
		settingString(f.integration.Settings, "cloud_id"),
		settingString(f.integration.Settings, "site_url"),
		settingString(f.integration.Settings, "atlassian_site_id"),
	))
	if siteID == "" || siteID != configuredSiteID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "jira_service_management_webhook_id"),
		settingString(f.integration.Settings, "jira_service_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID == "" || webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindLinearIntegrationByWorkspace(_ context.Context, workspaceID, webhookID string) (*Integration, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderLinear || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredWorkspaceID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "workspace_id"),
		settingString(f.integration.Settings, "organization_id"),
		settingString(f.integration.Settings, "linear_workspace_id"),
		settingString(f.integration.Settings, "provider_workspace_id"),
	))
	if workspaceID == "" || workspaceID != configuredWorkspaceID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "linear_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" && configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindAsanaSupportIntegrationByWorkspace(_ context.Context, workspaceID, webhookID string) (*Integration, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderAsanaSupport || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredWorkspaceID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "workspace_id"),
		settingString(f.integration.Settings, "organization_id"),
		settingString(f.integration.Settings, "asana_workspace_id"),
		settingString(f.integration.Settings, "provider_workspace_id"),
	))
	if workspaceID == "" || workspaceID != configuredWorkspaceID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "asana_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" && configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindClickUpSupportIntegrationByWorkspace(_ context.Context, workspaceID, webhookID string) (*Integration, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderClickUpSupport || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredWorkspaceID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "workspace_id"),
		settingString(f.integration.Settings, "team_id"),
		settingString(f.integration.Settings, "clickup_workspace_id"),
		settingString(f.integration.Settings, "provider_workspace_id"),
	))
	if workspaceID == "" || workspaceID != configuredWorkspaceID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "clickup_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" && configuredWebhookID != "" && webhookID != configuredWebhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindFrontIntegrationByInbox(_ context.Context, inboxID, webhookID string) (*Integration, error) {
	inboxID = strings.TrimSpace(inboxID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderFront || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredInboxID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "inbox_id"),
		settingString(f.integration.Settings, "front_inbox_id"),
		settingString(f.integration.Settings, "provider_inbox_id"),
	))
	if inboxID == "" || inboxID != configuredInboxID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "front_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindCrispIntegrationByWebsite(_ context.Context, websiteID, webhookID string) (*Integration, error) {
	websiteID = strings.TrimSpace(websiteID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderCrisp || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredWebsiteID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "website_id"),
		settingString(f.integration.Settings, "crisp_website_id"),
		settingString(f.integration.Settings, "provider_website_id"),
	))
	if websiteID == "" || websiteID != configuredWebsiteID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "crisp_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindKustomerIntegrationByOrganization(_ context.Context, organizationID, webhookID string) (*Integration, error) {
	organizationID = strings.TrimSpace(organizationID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderKustomer || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredOrganizationID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "organization_id"),
		settingString(f.integration.Settings, "org_id"),
		settingString(f.integration.Settings, "kustomer_organization_id"),
		settingString(f.integration.Settings, "provider_organization_id"),
	))
	if organizationID == "" || organizationID != configuredOrganizationID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "kustomer_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindDriftIntegrationByWorkspace(_ context.Context, workspaceID, webhookID string) (*Integration, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderDrift || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredWorkspaceID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "workspace_id"),
		settingString(f.integration.Settings, "drift_workspace_id"),
		settingString(f.integration.Settings, "organization_id"),
		settingString(f.integration.Settings, "org_id"),
		settingString(f.integration.Settings, "drift_organization_id"),
		settingString(f.integration.Settings, "provider_workspace_id"),
		settingString(f.integration.Settings, "provider_organization_id"),
	))
	if workspaceID == "" || workspaceID != configuredWorkspaceID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "drift_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindLiveChatIntegrationByAccount(_ context.Context, accountID, webhookID string) (*Integration, error) {
	accountID = strings.TrimSpace(accountID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderLiveChat || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredAccountID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "account_id"),
		settingString(f.integration.Settings, "livechat_account_id"),
		settingString(f.integration.Settings, "organization_id"),
		settingString(f.integration.Settings, "livechat_organization_id"),
		settingString(f.integration.Settings, "provider_account_id"),
		settingString(f.integration.Settings, "provider_organization_id"),
	))
	if accountID == "" || accountID != configuredAccountID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "livechat_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}

func (f *fakeStore) FindOlarkIntegrationBySite(_ context.Context, siteID, webhookID string) (*Integration, error) {
	siteID = strings.TrimSpace(siteID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderOlark || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredSiteID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "site_id"),
		settingString(f.integration.Settings, "olark_site_id"),
		settingString(f.integration.Settings, "provider_site_id"),
	))
	if siteID == "" || siteID != configuredSiteID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "olark_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID == "" || configuredWebhookID != webhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}

func (f *fakeStore) FindKayakoIntegrationByDomain(_ context.Context, accountDomain, webhookID string) (*Integration, error) {
	accountDomain = normalizeKayakoWebhookDomain(accountDomain)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderKayako || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredDomain := normalizeKayakoWebhookDomain(firstString(
		settingString(f.integration.Settings, "account_domain"),
		settingString(f.integration.Settings, "domain"),
		settingString(f.integration.Settings, "subdomain"),
	))
	if accountDomain == "" || accountDomain != configuredDomain {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "kayako_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID == "" || configuredWebhookID != webhookID {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}

func (f *fakeStore) FindHubSpotServiceHubIntegrationByPortal(_ context.Context, portalID, webhookID string) (*Integration, error) {
	portalID = strings.TrimSpace(portalID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderHubSpotServiceHub || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredPortalID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "portal_id"),
		settingString(f.integration.Settings, "hubspot_portal_id"),
		settingString(f.integration.Settings, "hubspot_service_hub_portal_id"),
		settingString(f.integration.Settings, "provider_portal_id"),
	))
	if portalID == "" || portalID != configuredPortalID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "hubspot_service_hub_webhook_id"),
		settingString(f.integration.Settings, "hubspot_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindSalesforceServiceCloudIntegrationByInstance(_ context.Context, instanceURL, webhookID string) (*Integration, error) {
	instanceURL = normalizeSalesforceServiceCloudInstanceLookup(instanceURL)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderSalesforceServiceCloud || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredInstanceURL := normalizeSalesforceServiceCloudInstanceLookup(firstString(
		settingString(f.integration.Settings, "instance_url"),
		settingString(f.integration.Settings, "api_base_url"),
		settingString(f.integration.Settings, "salesforce_instance_url"),
		settingString(f.integration.Settings, "provider_instance_url"),
	))
	if instanceURL == "" || instanceURL != configuredInstanceURL {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "salesforce_service_cloud_webhook_id"),
		settingString(f.integration.Settings, "salesforce_webhook_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) FindZohoDeskIntegrationByOrganization(_ context.Context, organizationID, webhookID string) (*Integration, error) {
	organizationID = strings.TrimSpace(organizationID)
	webhookID = strings.TrimSpace(webhookID)
	if f.integration.Provider != ProviderZohoDesk || f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	configuredOrganizationID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "organization_id"),
		settingString(f.integration.Settings, "org_id"),
		settingString(f.integration.Settings, "orgId"),
		settingString(f.integration.Settings, "zoho_desk_organization_id"),
		settingString(f.integration.Settings, "provider_organization_id"),
	))
	if organizationID == "" || organizationID != configuredOrganizationID {
		return nil, ErrNotFound
	}
	configuredWebhookID := strings.TrimSpace(firstString(
		settingString(f.integration.Settings, "zoho_desk_webhook_id"),
		settingString(f.integration.Settings, "notification_channel_id"),
		settingString(f.integration.Settings, "provider_webhook_id"),
		settingString(f.integration.Settings, "webhook_id"),
	))
	if webhookID != "" {
		if configuredWebhookID != webhookID {
			return nil, ErrNotFound
		}
	} else if configuredWebhookID != "" {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) ListIntegrations(context.Context, string) ([]Integration, error) {
	return []Integration{f.integration}, nil
}
func (f *fakeStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return &f.integration, nil
}
func (f *fakeStore) UpsertIntegration(_ context.Context, tenantID string, in IntegrationInput) (*Integration, error) {
	f.lastInput = in
	f.integration.TenantID = tenantID
	f.integration.Provider = in.Provider
	f.integration.Name = in.Name
	f.integration.Status = in.Status
	f.integration.Scopes = in.Scopes
	f.integration.CredentialsRef = in.CredentialsRef
	f.integration.Settings = in.Settings
	return &f.integration, nil
}
func (f *fakeStore) ProvisionIngestIntegration(_ context.Context, tenantID string, in IngestProvisionInput, token string) (*Integration, error) {
	if f.provisionErr != nil {
		return nil, f.provisionErr
	}
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	name := in.Name
	if name == "" {
		name = in.Provider + " (webhook ingest)"
	}
	f.integration = Integration{
		ID:        "support_ingest_1",
		TenantID:  tenantID,
		Provider:  in.Provider,
		Name:      name,
		Status:    "connected",
		Settings:  map[string]any{"support_ingest_token": token, "ingest_mode": "webhook"},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if strings.TrimSpace(in.WebhookSecretRef) != "" {
		f.integration.Settings["webhook_secret_ref"] = strings.TrimSpace(in.WebhookSecretRef)
	}
	return &f.integration, nil
}
func (f *fakeStore) RotateIngestToken(_ context.Context, _ string, _ string, token string) (*Integration, error) {
	// Model the repo's WHERE guard: a disconnected or non-ingest row → no match
	// → ErrNotFound (404). (Wrong-id matching is exercised by the router test.)
	if f.integration.Status == "disconnected" ||
		settingString(f.integration.Settings, "support_ingest_token") == "" {
		return nil, ErrNotFound
	}
	f.integration.Settings["support_ingest_token"] = token
	return &f.integration, nil
}
func (f *fakeStore) PauseIntegration(context.Context, string, string) (*Integration, error) {
	if f.integration.Status == "disconnected" {
		return nil, ErrNotFound
	}
	f.integration.Status = "paused"
	return &f.integration, nil
}
func (f *fakeStore) DisconnectIntegration(context.Context, string, string) error {
	f.integration.Status = "disconnected"
	return nil
}
func (f *fakeStore) DisconnectIntegrationWithProviderCleanup(_ context.Context, _ string, _ string, cleanup *DisconnectCleanupEvidence) error {
	if err := f.DisconnectIntegration(context.Background(), "", ""); err != nil {
		return err
	}
	if cleanup != nil {
		if f.integration.Settings == nil {
			f.integration.Settings = map[string]any{}
		}
		raw, _ := json.Marshal(cleanup)
		var stored map[string]any
		_ = json.Unmarshal(raw, &stored)
		f.integration.Settings["provider_cleanup"] = stored
	}
	return nil
}
func (f *fakeStore) RecordSyncRun(_ context.Context, _ string, _ string, summary SyncSummary, req SyncRequest, started, completed time.Time) (*SyncRun, error) {
	if f.recordErr != nil {
		return nil, f.recordErr
	}
	run := SyncRun{
		ID:               "run_1",
		IntegrationID:    summary.IntegrationID,
		RunMode:          req.RunMode,
		Status:           summary.Status,
		CursorTo:         summary.Cursor,
		TicketsSeen:      summary.TicketsSeen,
		TicketsUpserted:  summary.TicketsUpserted,
		MessagesSeen:     summary.MessagesSeen,
		MessagesUpserted: summary.MessagesUpserted,
		ProfilesUpserted: summary.ProfilesUpserted,
		EventsSeen:       summary.EventsSeen,
		EventsTracked:    summary.EventsTracked,
		RowsFailed:       summary.RowsFailed,
		ErrorMessage:     summary.ErrorMessage,
		StartedAt:        started,
		CompletedAt:      &completed,
		CreatedAt:        completed,
	}
	f.runs = append(f.runs, run)
	if f.integration.Status != "disconnected" {
		f.integration.SyncCursor = run.CursorTo
		f.integration.ErrorMessage = summary.ErrorMessage
	}
	return &run, nil
}
func (f *fakeStore) ListRuns(context.Context, string, string, int) ([]SyncRun, error) {
	return f.runs, nil
}
func (f *fakeStore) ClaimSupportWebhook(_ context.Context, _ string, _ string, provider, webhookID, _ string, _ []byte) (WebhookClaim, error) {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	key := provider + ":" + webhookID
	switch f.webhooks[key] {
	case WebhookProcessed:
		return WebhookProcessed, nil
	case WebhookInProgress:
		return WebhookInProgress, nil
	default:
		f.webhooks[key] = WebhookInProgress
		return WebhookClaimed, nil
	}
}
func (f *fakeStore) MarkSupportWebhookProcessed(_ context.Context, _ string, provider, webhookID string) error {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	f.webhooks[provider+":"+webhookID] = WebhookProcessed
	return nil
}
func (f *fakeStore) MarkSupportWebhookFailed(_ context.Context, _ string, provider, webhookID string, _ error) error {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	f.webhooks[provider+":"+webhookID] = ""
	return nil
}

type fakeSuiteSink struct {
	tickets  []TicketInput
	messages []MessageInput
}

func (f *fakeSuiteSink) UpsertSupportTicket(_ context.Context, _ string, _ string, ticket TicketInput) (string, string, error) {
	f.tickets = append(f.tickets, ticket)
	return "conv_1", "ticket_1", nil
}

func (f *fakeSuiteSink) RecordSupportMessage(_ context.Context, _ string, _ string, message MessageInput) (string, error) {
	f.messages = append(f.messages, message)
	return "conv_1", nil
}

type fakeProfileSink struct {
	tickets []TicketInput
}

func (f *fakeProfileSink) UpsertSupportProfile(_ context.Context, _ string, _ string, ticket TicketInput) (string, error) {
	f.tickets = append(f.tickets, ticket)
	return "sub_1", nil
}

type fakeEventSink struct {
	events []SupportEventInput
}

func (f *fakeEventSink) TrackSupportEvent(_ context.Context, _ string, _ string, event SupportEventInput) (int64, error) {
	f.events = append(f.events, event)
	return int64(len(f.events)), nil
}

type fakeSupportSecretResolver struct {
	values map[string]string
}

func (f fakeSupportSecretResolver) Get(_ context.Context, ref string) (string, error) {
	value, ok := f.values[ref]
	if !ok {
		return "", errors.New("missing secret")
	}
	return value, nil
}

func (f fakeSupportSecretResolver) GetJSON(context.Context, string, any) error {
	return errors.New("not implemented")
}

func supportReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})
	ctx = context.WithValue(ctx, archivedSupportRuntimeFixtureKey{}, true)
	return req.WithContext(ctx)
}

func signZendeskWebhookTest(secret string, body []byte, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func signIntercomWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	return "sha1=" + hex.EncodeToString(mac.Sum(nil))
}

func signFrontWebhookTest(secret string, body []byte, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte(":"))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func signCrispWebhookTest(secret string, body []byte, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("["))
	mac.Write([]byte(timestamp))
	mac.Write([]byte(";"))
	mac.Write(body)
	mac.Write([]byte("]"))
	return hex.EncodeToString(mac.Sum(nil))
}

func signKustomerWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func signHubSpotServiceHubWebhookTest(secret, method, requestURI string, body []byte, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(method))
	mac.Write([]byte(requestURI))
	mac.Write(body)
	mac.Write([]byte(timestamp))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func signZohoDeskWebhookJWTTest(t *testing.T, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	header := map[string]any{"alg": "RS256", "typ": "JWT", "kid": kid}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func zohoDeskJWKSForTest(key *rsa.PrivateKey, kid string) map[string]any {
	n := base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes())
	eBytes := big.NewInt(int64(key.PublicKey.E)).Bytes()
	return map[string]any{"keys": []map[string]any{{"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig", "n": n, "e": base64.RawURLEncoding.EncodeToString(eBytes)}}}
}

func signHelpScoutWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func providerFieldByKey(fields []ProviderField, key string) (ProviderField, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field, true
		}
	}
	return ProviderField{}, false
}

func hasString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func hasStringContaining(values []string, needle string) bool {
	for _, value := range values {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func fieldKeys(fields []ProviderField) []string {
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		out = append(out, field.Key)
	}
	return out
}

func unsupportedNativeSupportFilterKeys(provider string) []string {
	switch provider {
	case ProviderCrisp:
		return []string{"operator_id"}
	case ProviderKustomer:
		return []string{"team_id"}
	case ProviderDrift:
		return []string{"inbox_id"}
	case ProviderGroove:
		return []string{"team_id"}
	case ProviderOlark:
		return []string{"group_id"}
	case ProviderReamaze, ProviderKayako:
		return []string{"brand_id"}
	default:
		return nil
	}
}

func TestVerifyZendeskWebhookSignature(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	body := []byte(`{"ticket":{"id":123}}`)
	timestamp := "2026-06-20T12:00:00Z"
	signature := signZendeskWebhookTest("secret", body, timestamp)

	if err := VerifyZendeskWebhookSignature("secret", body, timestamp, signature, now); err != nil {
		t.Fatalf("valid signature failed: %v", err)
	}
	if err := VerifyZendeskWebhookSignature("secret", body, timestamp, "wrong", now); !errors.Is(err, ErrInvalidZendeskWebhookSignature) {
		t.Fatalf("invalid signature error=%v", err)
	}
	if err := VerifyZendeskWebhookSignature("secret", body, "2026-06-20T11:00:00Z", signZendeskWebhookTest("secret", body, "2026-06-20T11:00:00Z"), now); !errors.Is(err, ErrStaleZendeskWebhookSignature) {
		t.Fatalf("stale signature error=%v", err)
	}
}

func TestVerifyIntercomWebhookSignature(t *testing.T) {
	body := []byte(`{"topic":"conversation.user.created"}`)
	signature := signIntercomWebhookTest("secret", body)

	if err := VerifyIntercomWebhookSignature("secret", body, signature); err != nil {
		t.Fatalf("valid signature failed: %v", err)
	}
	if err := VerifyIntercomWebhookSignature("secret", body, strings.TrimPrefix(signature, "sha1=")); err != nil {
		t.Fatalf("valid bare hex signature failed: %v", err)
	}
	if err := VerifyIntercomWebhookSignature("secret", body, signIntercomWebhookTest("wrong", body)); !errors.Is(err, ErrInvalidIntercomWebhookSignature) {
		t.Fatalf("invalid signature error=%v", err)
	}
	if err := VerifyIntercomWebhookSignature("secret", body, ""); !errors.Is(err, ErrMissingIntercomWebhookSignature) {
		t.Fatalf("missing signature error=%v", err)
	}
}

func TestVerifyHelpScoutWebhookSignature(t *testing.T) {
	body := []byte(`{"id":91}`)
	signature := signHelpScoutWebhookTest("secret", body)

	if err := VerifyHelpScoutWebhookSignature("secret", body, signature); err != nil {
		t.Fatalf("valid signature failed: %v", err)
	}
	if err := VerifyHelpScoutWebhookSignature("secret", body, signHelpScoutWebhookTest("wrong", body)); !errors.Is(err, ErrInvalidHelpScoutWebhookSignature) {
		t.Fatalf("invalid signature error=%v", err)
	}
	if err := VerifyHelpScoutWebhookSignature("secret", body, ""); !errors.Is(err, ErrMissingHelpScoutWebhookSignature) {
		t.Fatalf("missing signature error=%v", err)
	}
}

func TestVerifyFreshdeskWebhookAuth(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("X-Freshdesk-Webhook-Secret", "secret")
	if err := VerifyFreshdeskWebhookAuth("secret", req); err != nil {
		t.Fatalf("valid shared secret failed: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Authorization", "Bearer secret")
	if err := VerifyFreshdeskWebhookAuth("secret", req); err != nil {
		t.Fatalf("valid bearer secret failed: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.SetBasicAuth("freshdesk", "secret")
	if err := VerifyFreshdeskWebhookAuth("secret", req); err != nil {
		t.Fatalf("valid basic secret failed: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("X-Freshdesk-Webhook-Secret", "wrong")
	if err := VerifyFreshdeskWebhookAuth("secret", req); !errors.Is(err, ErrInvalidFreshdeskWebhookAuth) {
		t.Fatalf("invalid auth error=%v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	if err := VerifyFreshdeskWebhookAuth("secret", req); !errors.Is(err, ErrMissingFreshdeskWebhookAuth) {
		t.Fatalf("missing auth error=%v", err)
	}
}

func TestListProvidersIncludesSupportNatives(t *testing.T) {
	res := struct{ Items []ProviderSpec }{Items: ProviderSpecs()}
	seen := map[string]bool{}
	for _, item := range res.Items {
		seen[item.Provider] = item.Managed
	}
	for _, provider := range []string{
		ProviderZendesk,
		ProviderIntercom,
		ProviderGorgias,
		ProviderFreshdesk,
		ProviderHelpScout,
		ProviderFront,
		ProviderZohoDesk,
		ProviderKustomer,
		ProviderFreshchat,
		ProviderLiveChat,
		ProviderCrisp,
		ProviderTidio,
		ProviderOlark,
		ProviderDrift,
		ProviderAda,
		ProviderGladly,
		ProviderReamaze,
		ProviderGroove,
		ProviderKayako,
		ProviderHelpCrunch,
		ProviderHubSpotServiceHub,
		ProviderSalesforceServiceCloud,
		ProviderJiraServiceManagement,
		ProviderLinear,
		ProviderAsanaSupport,
		ProviderClickUpSupport,
	} {
		if !seen[provider] {
			t.Fatalf("provider %q missing or unmanaged: %+v", provider, res.Items)
		}
	}
}

func TestSupportProviderMetadataDescribesPostwaveIngestFoundationAndZendeskNativePuller(t *testing.T) {
	res := struct{ Items []ProviderSpec }{Items: ProviderSpecs()}
	seen := map[string]ProviderSpec{}
	for _, item := range res.Items {
		seen[item.Provider] = item
		if item.Provider == ProviderZendesk {
			if item.SyncModel != zendeskSyncModelNative {
				t.Fatalf("Zendesk sync model = %q, want %q", item.SyncModel, zendeskSyncModelNative)
			}
			if item.VerificationMode != "zendesk_oauth_or_api_token_tickets_rest_incremental_export_signed_webhooks_pending_live_certification" {
				t.Fatalf("Zendesk verification mode = %q", item.VerificationMode)
			}
			for _, scope := range []string{"tickets:read", "users:read"} {
				if !hasString(item.Scopes, scope) {
					t.Fatalf("Zendesk scopes missing %q: %+v", scope, item.Scopes)
				}
			}
			if !hasString(item.WebhookTopics, "ticket.updated") {
				t.Fatalf("Zendesk webhook topics should advertise signed ticket callbacks: %+v", item.WebhookTopics)
			}
			for _, object := range []string{"tickets", "comments", "users", "profiles", "events"} {
				if !hasString(item.SyncObjects, object) {
					t.Fatalf("Zendesk sync objects missing %q: %+v", object, item.SyncObjects)
				}
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); !ok {
				t.Fatalf("Zendesk should advertise webhook_secret_ref for signed webhooks: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "zendesk_webhook_id"); !ok {
				t.Fatalf("Zendesk should advertise zendesk_webhook_id for signed route narrowing: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "page_size"); !ok {
				t.Fatalf("Zendesk should advertise page_size for Tickets API cursor pulls: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "incremental_export_enabled"); !ok {
				t.Fatalf("Zendesk should advertise incremental_export_enabled for Incremental Export pulls: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "incremental_start_time"); !ok {
				t.Fatalf("Zendesk should advertise incremental_start_time for Incremental Export pulls: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "incremental_page_size"); !ok {
				t.Fatalf("Zendesk should advertise incremental_page_size for Incremental Export pulls: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderGorgias {
			if item.SyncModel != gorgiasSyncModelNative {
				t.Fatalf("Gorgias sync model = %q, want %q", item.SyncModel, gorgiasSyncModelNative)
			}
			if item.VerificationMode != "gorgias_api_key_tickets_rest_cursor_authenticated_http_callbacks_pending_hmac_live_certification" {
				t.Fatalf("Gorgias verification mode = %q", item.VerificationMode)
			}
			if len(item.Scopes) != 0 {
				t.Fatalf("Gorgias should not claim OAuth scopes for API-key HTTP integration callbacks: %+v", item)
			}
			if !hasString(item.WebhookTopics, "ticket-message-created") {
				t.Fatalf("Gorgias should advertise authenticated HTTP integration triggers: %+v", item.WebhookTopics)
			}
			for _, object := range []string{"tickets", "messages", "customers", "profiles", "events"} {
				if !hasString(item.SyncObjects, object) {
					t.Fatalf("Gorgias sync objects missing %q: %+v", object, item.SyncObjects)
				}
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); !ok {
				t.Fatalf("Gorgias should advertise webhook_secret_ref for authenticated HTTP callbacks: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "gorgias_http_integration_id"); !ok {
				t.Fatalf("Gorgias should advertise gorgias_http_integration_id for route narrowing: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "page_size"); !ok {
				t.Fatalf("Gorgias should advertise page_size for Tickets API cursor pulls: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderFreshdesk {
			if item.SyncModel != freshdeskSyncModelNative {
				t.Fatalf("Freshdesk sync model = %q, want %q", item.SyncModel, freshdeskSyncModelNative)
			}
			if item.VerificationMode != "freshdesk_api_key_tickets_rest_requester_product_filter_authenticated_webhooks_pending_cleanup_live_certification" {
				t.Fatalf("Freshdesk verification mode = %q", item.VerificationMode)
			}
			if len(item.Scopes) != 0 {
				t.Fatalf("Freshdesk should not expose OAuth scopes for API-key automation callbacks: %+v", item)
			}
			if !hasString(item.WebhookTopics, "ticket.updated") {
				t.Fatalf("Freshdesk should advertise authenticated automation webhook topics: %+v", item.WebhookTopics)
			}
			for _, object := range []string{"tickets", "profiles", "events"} {
				if !hasString(item.SyncObjects, object) {
					t.Fatalf("Freshdesk sync objects missing %q: %+v", object, item.SyncObjects)
				}
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "api_base_url"); !ok {
				t.Fatalf("Freshdesk should advertise api_base_url for test routing: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "page_size"); !ok {
				t.Fatalf("Freshdesk should advertise page_size for Tickets API page pulls: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "product_id"); !ok {
				t.Fatalf("Freshdesk should advertise implemented local product_id filtering: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); !ok {
				t.Fatalf("Freshdesk should advertise webhook_secret_ref for authenticated automation callbacks: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "freshdesk_webhook_id"); !ok {
				t.Fatalf("Freshdesk should advertise freshdesk_webhook_id for route narrowing: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderIntercom {
			if item.SyncModel != intercomSyncModelNative {
				t.Fatalf("Intercom sync model = %q, want %q", item.SyncModel, intercomSyncModelNative)
			}
			if item.VerificationMode != "intercom_oauth_conversations_rest_contact_lookup_signed_webhooks_pending_cleanup_live_certification" {
				t.Fatalf("Intercom verification mode = %q", item.VerificationMode)
			}
			if !hasString(item.Scopes, "conversations.read") {
				t.Fatalf("Intercom scopes should advertise implemented conversation pulls: %+v", item.Scopes)
			}
			if !hasString(item.Scopes, "contacts.read") {
				t.Fatalf("Intercom scopes should advertise contact lookup fallback: %+v", item.Scopes)
			}
			if !hasString(item.WebhookTopics, "conversation.user.created") || !hasString(item.WebhookTopics, "conversation.admin.replied") {
				t.Fatalf("Intercom should advertise signed webhook topics: %+v", item.WebhookTopics)
			}
			for _, object := range []string{"conversations", "profiles", "events"} {
				if !hasString(item.SyncObjects, object) {
					t.Fatalf("Intercom sync objects missing %q: %+v", object, item.SyncObjects)
				}
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "page_size"); !ok {
				t.Fatalf("Intercom should advertise page_size for Conversations API cursor pulls: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "api_base_url"); !ok {
				t.Fatalf("Intercom should advertise api_base_url for test routing: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "inbox_id"); ok {
				t.Fatalf("Intercom should not advertise unused inbox_id filtering: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); !ok {
				t.Fatalf("Intercom should advertise webhook_secret_ref for signed webhooks: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderHelpScout {
			if item.SyncModel != helpScoutSyncModelNative {
				t.Fatalf("Help Scout sync model = %q, want %q", item.SyncModel, helpScoutSyncModelNative)
			}
			if item.VerificationMode != "helpscout_oauth_conversations_threads_signed_webhooks_pending_cleanup_live_certification" {
				t.Fatalf("Help Scout verification mode = %q", item.VerificationMode)
			}
			if !hasString(item.Scopes, "conversations.read") {
				t.Fatalf("Help Scout should advertise implemented conversation reads: %+v", item.Scopes)
			}
			if !hasString(item.WebhookTopics, "convo.created") || !hasString(item.WebhookTopics, "convo.status") {
				t.Fatalf("Help Scout should advertise signed app webhook topics: %+v", item.WebhookTopics)
			}
			for _, object := range []string{"conversations", "threads", "messages", "profiles", "events"} {
				if !hasString(item.SyncObjects, object) {
					t.Fatalf("Help Scout sync objects missing %q: %+v", object, item.SyncObjects)
				}
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "status"); !ok {
				t.Fatalf("Help Scout should advertise status filter: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "api_base_url"); !ok {
				t.Fatalf("Help Scout should advertise api_base_url for test routing: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "team_id"); ok {
				t.Fatalf("Help Scout should not advertise unused team_id filtering: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); !ok {
				t.Fatalf("Help Scout should advertise webhook_secret_ref for signed webhooks: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "help_scout_webhook_id"); !ok {
				t.Fatalf("Help Scout should advertise help_scout_webhook_id for route narrowing: %+v", item.OptionalSettings)
			}
			continue
		}
		if isNativeSupportPullerProvider(item.Provider) {
			if item.SyncModel != nativeSupportPullerSyncModel(item.Provider) {
				t.Fatalf("%s sync model = %q, want %q", item.Provider, item.SyncModel, nativeSupportPullerSyncModel(item.Provider))
			}
			if item.VerificationMode == "" || item.VerificationMode == "postwave_support_ingest_pending_provider_adapter" {
				t.Fatalf("%s should advertise provider-native verification posture, got %q", item.Provider, item.VerificationMode)
			}
			if len(item.Scopes) == 0 {
				t.Fatalf("%s should advertise implemented provider read scopes: %+v", item.Provider, item.Scopes)
			}
			for _, object := range []string{"profiles", "events"} {
				if !hasString(item.SyncObjects, object) {
					t.Fatalf("%s sync objects missing %q: %+v", item.Provider, object, item.SyncObjects)
				}
			}
			for _, key := range unsupportedNativeSupportFilterKeys(item.Provider) {
				if _, ok := providerFieldByKey(item.OptionalSettings, key); ok {
					t.Fatalf("%s should not advertise unsupported %s filtering: %+v", item.Provider, key, item.OptionalSettings)
				}
			}
			if item.Provider == ProviderFront {
				for _, topic := range []string{"inbound", "outbound", "comment", "archive"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Front webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"front_webhook_secret_ref", "front_webhook_id", "webhook_secret_ref"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Front should advertise %s for signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderCrisp {
				for _, topic := range []string{"message:send", "message:received", "session:set_email", "session:set_state", "session:set_subject"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Crisp webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"crisp_webhook_secret_ref", "crisp_webhook_id", "webhook_secret_ref"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Crisp should advertise %s for signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderKustomer {
				for _, topic := range []string{"conversation.created", "conversation.updated", "message.created"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Kustomer webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"kustomer_webhook_secret_ref", "kustomer_webhook_id", "webhook_secret_ref"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Kustomer should advertise %s for signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderDrift {
				for _, topic := range []string{"new_message", "new_command_message", "new_conversation", "conversation_status_updated", "conversation_inactive", "conversation_manual_push", "conversation_push"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Drift webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"drift_webhook_secret_ref", "drift_webhook_id", "webhook_secret_ref"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Drift should advertise %s for webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderLiveChat {
				for _, topic := range []string{"incoming_chat", "incoming_event", "chat_deactivated", "chat_started", "chat_ended"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("LiveChat webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"livechat_webhook_secret_ref", "livechat_webhook_id", "webhook_secret_ref"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("LiveChat should advertise %s for webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderHubSpotServiceHub {
				for _, topic := range []string{"ticket.creation", "ticket.propertyChange"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("HubSpot Service Hub webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				if hasString(item.WebhookTopics, "ticket.deletion") {
					t.Fatalf("HubSpot Service Hub should not advertise ticket.deletion until support tombstones are implemented: %+v", item.WebhookTopics)
				}
				for _, key := range []string{"hubspot_service_hub_webhook_secret_ref", "hubspot_webhook_id", "webhook_secret_ref"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("HubSpot Service Hub should advertise %s for signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderSalesforceServiceCloud {
				for _, topic := range []string{"CaseChangeEvent"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Salesforce Service Cloud CDC topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				if hasString(item.WebhookTopics, "case.deleted") {
					t.Fatalf("Salesforce Service Cloud should not advertise case.deleted until support tombstones are implemented: %+v", item.WebhookTopics)
				}
				for _, key := range []string{"salesforce_service_cloud_webhook_secret_ref", "salesforce_service_cloud_webhook_id", "webhook_secret_ref"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Salesforce Service Cloud should advertise %s for CDC relay routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderZohoDesk {
				for _, topic := range []string{"ticket.add", "ticket.update", "thread.add"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Zoho Desk webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				if _, ok := providerFieldByKey(item.OptionalSettings, "zoho_desk_webhook_id"); !ok {
					t.Fatalf("Zoho Desk should advertise zoho_desk_webhook_id for signed webhook routing: %+v", item.OptionalSettings)
				}
				continue
			}
			if item.Provider == ProviderOlark {
				if !hasString(item.WebhookTopics, "transcript.created") {
					t.Fatalf("Olark webhook topics missing transcript.created: %+v", item.WebhookTopics)
				}
				for _, key := range []string{"olark_webhook_id", "api_base_url", "page_size"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Olark should advertise %s for route-token transcript webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderFreshchat {
				for _, topic := range []string{"message_create", "conversation_assignment", "conversation_resolution", "conversation_reopen"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Freshchat webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"freshchat_webhook_public_key_ref", "freshchat_webhook_id", "api_base_url", "page_size", "channel_id"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Freshchat should advertise %s for REST/webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderTidio {
				for _, topic := range []string{"contact.created", "conversation.operator_replied", "ticket.created", "ticket.replied"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Tidio webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"project_public_key", "tidio_webhook_secret_ref", "tidio_webhook_id", "webhook_secret_ref", "api_base_url"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Tidio should advertise %s for OpenAPI/signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderAda {
				if item.SyncModel != adaSyncModelNative {
					t.Fatalf("Ada sync model = %q, want %q", item.SyncModel, adaSyncModelNative)
				}
				for _, topic := range []string{"v1.conversation.created", "v1.conversation.message", "v1.conversation.handoff.ended"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Ada webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"bot_id", "ada_webhook_secret_ref", "ada_webhook_id", "webhook_secret_ref", "api_base_url", "page_size", "created_since"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Ada should advertise %s for Data Export/Svix webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				if _, ok := providerFieldByKey(item.RequiredSettings, "ai_agent_domain"); !ok {
					t.Fatalf("Ada should require ai_agent_domain for API/webhook routing: %+v", item.RequiredSettings)
				}
				continue
			}
			if item.Provider == ProviderGladly {
				if item.SyncModel != gladlySyncModelNative {
					t.Fatalf("Gladly sync model = %q, want %q", item.SyncModel, gladlySyncModelNative)
				}
				for _, topic := range []string{"CONVERSATION", "CUSTOMER_PROFILE", "TASK", "PING"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Gladly webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, object := range []string{"customer_profiles", "customer_conversations", "conversation_items", "tasks", "events"} {
					if !hasString(item.SyncObjects, object) {
						t.Fatalf("Gladly sync objects missing %q: %+v", object, item.SyncObjects)
					}
				}
				for _, key := range []string{"organization_id", "customer_id", "customer_ids", "gladly_webhook_token_ref", "gladly_webhook_id", "webhook_auth_ref", "api_base_url", "event_window_minutes"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Gladly should advertise %s for customer-scoped REST/events/webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				if _, ok := providerFieldByKey(item.RequiredSettings, "organization_domain"); !ok {
					t.Fatalf("Gladly should require organization_domain for API/webhook routing: %+v", item.RequiredSettings)
				}
				continue
			}
			if item.Provider == ProviderGroove {
				if item.SyncModel != grooveSyncModelNative {
					t.Fatalf("Groove sync model = %q, want %q", item.SyncModel, grooveSyncModelNative)
				}
				for _, topic := range []string{"ticket_started", "ticket_opened", "ticket_closed", "agent_replied", "customer_replied"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Groove webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, object := range []string{"tickets", "ticket_messages", "customers", "mailboxes", "profiles", "events"} {
					if !hasString(item.SyncObjects, object) {
						t.Fatalf("Groove sync objects missing %q: %+v", object, item.SyncObjects)
					}
				}
				for _, key := range []string{"folder_id", "state", "customer", "groove_webhook_id", "api_base_url", "page_size", "message_page_size"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Groove should advertise %s for REST/route-token webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				if _, ok := providerFieldByKey(item.OptionalSettings, "team_id"); ok {
					t.Fatalf("Groove should not advertise unsupported team_id filtering: %+v", item.OptionalSettings)
				}
				continue
			}
			if item.Provider == ProviderHelpCrunch {
				if item.SyncModel != helpCrunchSyncModelNative {
					t.Fatalf("HelpCrunch sync model = %q, want %q", item.SyncModel, helpCrunchSyncModelNative)
				}
				for _, topic := range []string{"chat.new", "chat.closed", "message.customer", "message.agent", "customer.created"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("HelpCrunch webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, object := range []string{"chats", "chat_messages", "customers", "agents", "applications", "profiles", "events"} {
					if !hasString(item.SyncObjects, object) {
						t.Fatalf("HelpCrunch sync objects missing %q: %+v", object, item.SyncObjects)
					}
				}
				for _, key := range []string{"widget_id", "application_id", "status", "helpcrunch_webhook_signing_key_ref", "helpcrunch_webhook_id", "webhook_secret_ref", "api_base_url", "limit", "message_limit"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("HelpCrunch should advertise %s for REST/signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderKayako {
				for _, topic := range []string{"case.created", "case.updated", "conversation.message.created"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Kayako webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"kayako_webhook_id", "api_base_url", "page_size"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Kayako should advertise %s for route-token case webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderJiraServiceManagement {
				for _, topic := range []string{"jira:issue_created", "jira:issue_updated", "comment_created"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Jira Service Management webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"project_key", "cloud_id", "site_url", "jira_service_management_webhook_id", "api_base_url", "page_size"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Jira Service Management should advertise %s for request/comment REST and route-token webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderLinear {
				for _, topic := range []string{"Issue", "Comment", "CustomerNeed"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Linear webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"team_id", "linear_webhook_secret_ref", "linear_webhook_id", "graphql_url", "page_size"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Linear should advertise %s for GraphQL/signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderAsanaSupport {
				for _, topic := range []string{"task.added", "task.changed", "story.added"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("Asana Support webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"project_id", "asana_webhook_secret_ref", "asana_webhook_id", "api_base_url", "page_size"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("Asana Support should advertise %s for REST/signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if item.Provider == ProviderClickUpSupport {
				for _, topic := range []string{"taskCreated", "taskUpdated", "taskCommentPosted"} {
					if !hasString(item.WebhookTopics, topic) {
						t.Fatalf("ClickUp Support webhook topics missing %q: %+v", topic, item.WebhookTopics)
					}
				}
				for _, key := range []string{"list_id", "clickup_webhook_secret_ref", "clickup_webhook_id", "api_base_url", "date_updated_gt"} {
					if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
						t.Fatalf("ClickUp Support should advertise %s for REST/signed webhook routing: %+v", key, item.OptionalSettings)
					}
				}
				continue
			}
			if len(item.WebhookTopics) != 0 {
				t.Fatalf("%s should not advertise provider callbacks before webhook adapters are certified: %+v", item.Provider, item.WebhookTopics)
			}
			for _, key := range []string{"webhook_auth_ref", "webhook_secret_ref", "webhook_signature_ref", "notification_channel_id", "notification_token_ref"} {
				if _, ok := providerFieldByKey(item.OptionalSettings, key); ok {
					t.Fatalf("%s should not expose %s until provider callbacks are certified: %+v", item.Provider, key, item.OptionalSettings)
				}
			}
			continue
		}
		if item.SyncModel != supportSyncModelIngest {
			t.Fatalf("%s sync model = %q, want %q", item.Provider, item.SyncModel, supportSyncModelIngest)
		}
		if item.VerificationMode == "" {
			t.Fatalf("%s missing verification mode", item.Provider)
		}
		if len(item.Scopes) != 0 || len(item.WebhookTopics) != 0 {
			t.Fatalf("%s should not expose provider scopes/topics before provider webhook workers land: %+v", item.Provider, item)
		}
		if len(item.SyncObjects) != 3 || !hasString(item.SyncObjects, "tickets") || !hasString(item.SyncObjects, "messages") || !hasString(item.SyncObjects, "events") {
			t.Fatalf("%s should expose only canonical support ingest objects before provider workers land: %+v", item.Provider, item.SyncObjects)
		}
		for _, key := range []string{"webhook_auth_ref", "webhook_secret_ref", "webhook_signature_ref", "notification_channel_id", "notification_token_ref"} {
			if _, ok := providerFieldByKey(item.OptionalSettings, key); ok {
				t.Fatalf("%s should not expose %s until raw provider callbacks are verified: %+v", item.Provider, key, item.OptionalSettings)
			}
		}
	}
	zendesk := seen[ProviderZendesk]
	if zendesk.AuthMode != "oauth_or_api_token_ref" || !hasString(fieldKeys(zendesk.RequiredSettings), "subdomain") {
		t.Fatalf("Zendesk should still model OAuth refs and subdomain setup, got %+v", zendesk)
	}
	gorgias := seen[ProviderGorgias]
	if gorgias.AuthMode != "api_key_ref" || !hasString(fieldKeys(gorgias.RequiredSettings), "account_domain") {
		t.Fatalf("Gorgias should still model API-key refs and account domain setup, got %+v", gorgias)
	}
	freshdesk := seen[ProviderFreshdesk]
	if freshdesk.AuthMode != "api_key_ref" || !hasString(fieldKeys(freshdesk.RequiredSettings), "account_domain") {
		t.Fatalf("Freshdesk should still model API-key refs and account domain setup, got %+v", freshdesk)
	}
}

func TestCreateProjectSupportProviderIntegrations(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		assertKey      string
		assertValue    string
	}{
		{
			name:           "hubspot service hub",
			provider:       ProviderHubSpotServiceHub,
			credentialsRef: "cred_hubspot_service_1",
			settings:       `"portal_id":"123456","pipeline_id":"pipeline_789","credentials_ref":"cred_hubspot_service_1"`,
			assertKey:      "portal_id",
			assertValue:    "123456",
		},
		{
			name:           "salesforce service cloud",
			provider:       ProviderSalesforceServiceCloud,
			credentialsRef: "cred_salesforce_service_1",
			settings:       `"instance_url":"https://acme.my.salesforce.com","case_record_type_id":"012xx0000000001","credentials_ref":"cred_salesforce_service_1"`,
			assertKey:      "instance_url",
			assertValue:    "https://acme.my.salesforce.com",
		},
		{
			name:           "jira service management",
			provider:       ProviderJiraServiceManagement,
			credentialsRef: "cred_jira_service_1",
			settings:       `"site_id":"site_123","service_desk_id":"desk_456","project_key":"SUP","credentials_ref":"cred_jira_service_1"`,
			assertKey:      "service_desk_id",
			assertValue:    "desk_456",
		},
		{
			name:           "linear",
			provider:       ProviderLinear,
			credentialsRef: "cred_linear_1",
			settings:       `"workspace_id":"workspace_123","team_id":"team_456","credentials_ref":"cred_linear_1"`,
			assertKey:      "workspace_id",
			assertValue:    "workspace_123",
		},
		{
			name:           "asana support",
			provider:       ProviderAsanaSupport,
			credentialsRef: "cred_asana_support_1",
			settings:       `"workspace_id":"workspace_123","project_id":"project_456","credentials_ref":"cred_asana_support_1"`,
			assertKey:      "project_id",
			assertValue:    "project_456",
		},
		{
			name:           "clickup support",
			provider:       ProviderClickUpSupport,
			credentialsRef: "cred_clickup_support_1",
			settings:       `"workspace_id":"workspace_123","list_id":"list_456","credentials_ref":"cred_clickup_support_1"`,
			assertKey:      "list_id",
			assertValue:    "list_456",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
				"provider":"`+tt.provider+`",
				"settings":{`+tt.settings+`}
			}`))
			if rec.Code != http.StatusCreated {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if store.lastInput.Provider != tt.provider || store.lastInput.CredentialsRef != tt.credentialsRef {
				t.Fatalf("input=%+v", store.lastInput)
			}
			if store.lastInput.Settings[tt.assertKey] != tt.assertValue ||
				store.lastInput.Settings["setup_surface"] != "support_integrations" ||
				store.lastInput.Settings["managed_by_postwave"] != true {
				t.Fatalf("settings=%+v", store.lastInput.Settings)
			}
		})
	}
}

func TestCreateIntercomIntegrationStoresNativeRuntimeSettings(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"intercom",
		"settings":{
			"workspace_id":"workspace_123",
			"credentials_ref":"cred_intercom_1",
			"api_base_url":"https://api.intercom.test",
			"page_size":125,
			"inbox_id":"inbox_123",
			"webhook_secret_ref":"cred_intercom_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderIntercom || store.lastInput.CredentialsRef != "cred_intercom_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["workspace_id"] != "workspace_123" ||
		store.lastInput.Settings["api_base_url"] != "https://api.intercom.test" ||
		store.lastInput.Settings["sync_model"] != intercomSyncModelNative ||
		store.lastInput.Settings["verification_mode"] != "intercom_oauth_conversations_rest_contact_lookup_signed_webhooks_pending_cleanup_live_certification" ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_intercom_webhook_1" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["inbox_id"] != nil {
		t.Fatalf("Intercom inbox_id should stay stripped until filtering lands: settings=%+v", store.lastInput.Settings)
	}
	if !hasString(store.lastInput.Scopes, "conversations.read") {
		t.Fatalf("Intercom native scopes should default from provider metadata: %+v", store.lastInput.Scopes)
	}
}

func TestCreateSupportChatProviderIntegrations(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		assertKey      string
		assertValue    string
	}{
		{
			name:           "kustomer",
			provider:       ProviderKustomer,
			credentialsRef: "cred_kustomer_1",
			settings:       `"organization_id":"org_123","team_id":"team_456","credentials_ref":"cred_kustomer_1"`,
			assertKey:      "organization_id",
			assertValue:    "org_123",
		},
		{
			name:           "freshchat",
			provider:       ProviderFreshchat,
			credentialsRef: "cred_freshchat_1",
			settings:       `"account_domain":"acme.freshchat.com","channel_id":"channel_123","credentials_ref":"cred_freshchat_1"`,
			assertKey:      "account_domain",
			assertValue:    "acme.freshchat.com",
		},
		{
			name:           "livechat",
			provider:       ProviderLiveChat,
			credentialsRef: "cred_livechat_1",
			settings:       `"account_id":"account_123","group_id":"group_456","credentials_ref":"cred_livechat_1"`,
			assertKey:      "account_id",
			assertValue:    "account_123",
		},
		{
			name:           "crisp",
			provider:       ProviderCrisp,
			credentialsRef: "cred_crisp_1",
			settings:       `"website_id":"website_123","operator_id":"operator_456","credentials_ref":"cred_crisp_1"`,
			assertKey:      "website_id",
			assertValue:    "website_123",
		},
		{
			name:           "tidio",
			provider:       ProviderTidio,
			credentialsRef: "cred_tidio_1",
			settings:       `"project_id":"project_123","channel_id":"channel_456","credentials_ref":"cred_tidio_1"`,
			assertKey:      "project_id",
			assertValue:    "project_123",
		},
		{
			name:           "olark",
			provider:       ProviderOlark,
			credentialsRef: "cred_olark_1",
			settings:       `"site_id":"site_123","group_id":"group_456","credentials_ref":"cred_olark_1"`,
			assertKey:      "site_id",
			assertValue:    "site_123",
		},
		{
			name:           "drift",
			provider:       ProviderDrift,
			credentialsRef: "cred_drift_1",
			settings:       `"workspace_id":"workspace_123","inbox_id":"inbox_456","credentials_ref":"cred_drift_1"`,
			assertKey:      "workspace_id",
			assertValue:    "workspace_123",
		},
		{
			name:           "ada",
			provider:       ProviderAda,
			credentialsRef: "cred_ada_1",
			settings:       `"ai_agent_domain":"example.ada.support","language":"en","credentials_ref":"cred_ada_1"`,
			assertKey:      "ai_agent_domain",
			assertValue:    "example.ada.support",
		},
		{
			name:           "gladly",
			provider:       ProviderGladly,
			credentialsRef: "cred_gladly_1",
			settings:       `"organization_domain":"acme.gladly.com","customer_ids":"cust-1,cust-2","credentials_ref":"cred_gladly_1"`,
			assertKey:      "organization_domain",
			assertValue:    "acme.gladly.com",
		},
		{
			name:           "reamaze",
			provider:       ProviderReamaze,
			credentialsRef: "cred_reamaze_1",
			settings:       `"account_domain":"acme.reamaze.com","brand_id":"brand_456","credentials_ref":"cred_reamaze_1"`,
			assertKey:      "account_domain",
			assertValue:    "acme.reamaze.com",
		},
		{
			name:           "groove",
			provider:       ProviderGroove,
			credentialsRef: "cred_groove_1",
			settings:       `"mailbox_id":"mailbox_123","folder_id":"folder_456","credentials_ref":"cred_groove_1"`,
			assertKey:      "mailbox_id",
			assertValue:    "mailbox_123",
		},
		{
			name:           "kayako",
			provider:       ProviderKayako,
			credentialsRef: "cred_kayako_1",
			settings:       `"account_domain":"acme.kayako.com","brand_id":"brand_456","credentials_ref":"cred_kayako_1"`,
			assertKey:      "account_domain",
			assertValue:    "acme.kayako.com",
		},
		{
			name:           "helpcrunch",
			provider:       ProviderHelpCrunch,
			credentialsRef: "cred_helpcrunch_1",
			settings:       `"organization_id":"org_123","widget_id":"widget_456","credentials_ref":"cred_helpcrunch_1"`,
			assertKey:      "organization_id",
			assertValue:    "org_123",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
				"provider":"`+tt.provider+`",
				"settings":{`+tt.settings+`}
			}`))
			if rec.Code != http.StatusCreated {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if store.lastInput.Provider != tt.provider || store.lastInput.CredentialsRef != tt.credentialsRef {
				t.Fatalf("input=%+v", store.lastInput)
			}
			if store.lastInput.Settings[tt.assertKey] != tt.assertValue ||
				store.lastInput.Settings["setup_surface"] != "support_integrations" ||
				store.lastInput.Settings["managed_by_postwave"] != true {
				t.Fatalf("settings=%+v", store.lastInput.Settings)
			}
		})
	}
}

func TestCreateSupportNativeProviderStripsUnsupportedFilters(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		strippedKey    string
	}{
		{
			name:           "crisp operator filter",
			provider:       ProviderCrisp,
			credentialsRef: "cred_crisp_1",
			settings:       `"website_id":"website_123","operator_id":"operator_456","credentials_ref":"cred_crisp_1"`,
			strippedKey:    "operator_id",
		},
		{
			name:           "kustomer team filter",
			provider:       ProviderKustomer,
			credentialsRef: "cred_kustomer_1",
			settings:       `"organization_id":"org_123","team_id":"team_456","credentials_ref":"cred_kustomer_1"`,
			strippedKey:    "team_id",
		},
		{
			name:           "drift inbox filter",
			provider:       ProviderDrift,
			credentialsRef: "cred_drift_1",
			settings:       `"workspace_id":"workspace_123","inbox_id":"inbox_456","credentials_ref":"cred_drift_1"`,
			strippedKey:    "inbox_id",
		},
		{
			name:           "olark group filter",
			provider:       ProviderOlark,
			credentialsRef: "cred_olark_1",
			settings:       `"site_id":"site_123","group_id":"group_456","credentials_ref":"cred_olark_1"`,
			strippedKey:    "group_id",
		},
		{
			name:           "reamaze brand filter",
			provider:       ProviderReamaze,
			credentialsRef: "cred_reamaze_1",
			settings:       `"account_domain":"acme.reamaze.com","brand_id":"brand_456","credentials_ref":"cred_reamaze_1"`,
			strippedKey:    "brand_id",
		},
		{
			name:           "kayako brand filter",
			provider:       ProviderKayako,
			credentialsRef: "cred_kayako_1",
			settings:       `"account_domain":"acme.kayako.com","brand_id":"brand_456","credentials_ref":"cred_kayako_1"`,
			strippedKey:    "brand_id",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
				"provider":"`+tt.provider+`",
				"settings":{`+tt.settings+`}
			}`))
			if rec.Code != http.StatusCreated {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if store.lastInput.Provider != tt.provider || store.lastInput.CredentialsRef != tt.credentialsRef {
				t.Fatalf("input=%+v", store.lastInput)
			}
			if _, ok := store.lastInput.Settings[tt.strippedKey]; ok {
				t.Fatalf("%s should strip unsupported %s, settings=%+v", tt.provider, tt.strippedKey, store.lastInput.Settings)
			}
		})
	}
}

func TestCreateLiveChatIntegrationRegistersManagedWebhooks(t *testing.T) {
	store := newFakeStore()
	manager := &fakeLiveChatBackfiller{
		registerResults: []LiveChatWebhookRegistrationResult{
			{ProviderWebhookID: "provider_wh_1"},
			{ProviderWebhookID: "provider_wh_2"},
		},
	}
	deps := &Deps{
		Repo:               store,
		LiveChatBackfiller: manager,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"vault://livechat/webhook": "secret-value",
		}},
		PublicBaseURL:  "https://app.postwave.test",
		NewIngestToken: func() (string, error) { return "route_token_1", nil },
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"livechat",
		"settings":{
			"account_id":"account_123",
			"credentials_ref":"cred_livechat_1",
			"livechat_webhook_secret_ref":"vault://livechat/webhook",
			"livechat_manage_webhook":true,
			"livechat_owner_client_id":"owner_client_1",
			"livechat_webhook_actions":"incoming_chat,incoming_event",
			"livechat_provider_webhook_ids":"spoofed_should_not_persist",
			"livechat_webhook_managed_by_postwave":true
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(manager.registerCalls) != 2 {
		t.Fatalf("register calls=%+v", manager.registerCalls)
	}
	if manager.registerCalls[0].Action != "incoming_chat" || manager.registerCalls[1].Action != "incoming_event" {
		t.Fatalf("actions=%+v", manager.registerCalls)
	}
	for _, call := range manager.registerCalls {
		if call.SecretKey != "secret-value" ||
			call.OwnerClientID != "owner_client_1" ||
			call.URL != "https://app.postwave.test/api/public/support-integrations/livechat/account_123/webhooks?webhook_id=route_token_1" {
			t.Fatalf("call=%+v", call)
		}
	}
	settings := store.lastInput.Settings
	if settings["livechat_webhook_id"] != "route_token_1" ||
		settings["livechat_provider_webhook_ids"] != "provider_wh_1,provider_wh_2" ||
		settings["livechat_provider_webhook_id"] != "provider_wh_1" ||
		settings["livechat_webhook_managed_by_postwave"] != true ||
		settings["livechat_owner_client_id"] != "owner_client_1" {
		t.Fatalf("settings=%+v", settings)
	}
	if strings.Contains(rec.Body.String(), "secret-value") || strings.Contains(rec.Body.String(), "spoofed_should_not_persist") {
		t.Fatalf("response leaked secret or spoofed provider id: %s", rec.Body.String())
	}
}

func TestCreateFreshdeskIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"freshdesk",
		"settings":{
			"account_domain":"acme.freshdesk.com",
			"api_base_url":"https://acme.freshdesk.test",
			"page_size":"250",
			"product_id":"123",
			"credentials_ref":"cred_freshdesk_1",
			"webhook_secret_ref":"cred_freshdesk_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderFreshdesk || store.lastInput.CredentialsRef != "cred_freshdesk_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["account_domain"] != "acme.freshdesk.com" ||
		store.lastInput.Settings["api_base_url"] != "https://acme.freshdesk.test" ||
		store.lastInput.Settings["page_size"] != "250" ||
		store.lastInput.Settings["product_id"] != "123" ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_freshdesk_webhook_1" ||
		store.lastInput.Settings["setup_surface"] != "support_integrations" ||
		store.lastInput.Settings["sync_model"] != freshdeskSyncModelNative ||
		store.lastInput.Settings["verification_mode"] != "freshdesk_api_key_tickets_rest_requester_product_filter_authenticated_webhooks_pending_cleanup_live_certification" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if len(store.lastInput.Scopes) != 0 {
		t.Fatalf("Freshdesk should not store OAuth scopes: input=%+v settings=%+v", store.lastInput, store.lastInput.Settings)
	}
}

func TestCreateFreshdeskIntegrationRejectsInvalidProductID(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"freshdesk",
		"settings":{
			"account_domain":"acme.freshdesk.com",
			"credentials_ref":"cred_freshdesk_1",
			"product_id":"product_123"
		}
	}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "product_id") {
		t.Fatalf("body=%s", rec.Body.String())
	}
}

func TestCreateHelpScoutIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"help-scout",
		"settings":{
			"mailbox_id":"mailbox_123",
			"status":"active",
			"api_base_url":"https://api.helpscout.test",
			"team_id":"team_123",
			"credentials_ref":"cred_helpscout_1",
			"webhook_secret_ref":"cred_helpscout_webhook_1",
			"help_scout_webhook_id":"wh_helpscout_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderHelpScout || store.lastInput.CredentialsRef != "cred_helpscout_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["mailbox_id"] != "mailbox_123" ||
		store.lastInput.Settings["status"] != "active" ||
		store.lastInput.Settings["api_base_url"] != "https://api.helpscout.test" ||
		store.lastInput.Settings["setup_surface"] != "support_integrations" ||
		store.lastInput.Settings["sync_model"] != helpScoutSyncModelNative ||
		store.lastInput.Settings["verification_mode"] != "helpscout_oauth_conversations_threads_signed_webhooks_pending_cleanup_live_certification" ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_helpscout_webhook_1" ||
		store.lastInput.Settings["help_scout_webhook_id"] != "wh_helpscout_1" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["team_id"] != nil || !hasString(store.lastInput.Scopes, "conversations.read") {
		t.Fatalf("unsupported settings should be stripped and native scopes retained: input=%+v settings=%+v", store.lastInput, store.lastInput.Settings)
	}
}

func TestCreateIntegrationRequiresCredentialRefAndRejectsRawToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"zendesk",
		"settings":{"subdomain":"acme","api_key":"secret"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw token status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"zendesk",
		"settings":{"subdomain":"acme","credentials_ref":"xoxb-1234567890-abcdef1234567890abcdef"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw-looking credential ref status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"zendesk",
		"settings":{
			"subdomain":"acme",
			"credentials_ref":"cred_zendesk_1",
			"page_size":500,
			"webhook_secret_ref":"cred_zendesk_webhook_1",
			"provider_cleanup":{"status":"spoofed","webhook_secret_ref":"vault://ignore"}
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderZendesk || store.lastInput.CredentialsRef != "cred_zendesk_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["api_key"] != nil ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_zendesk_webhook_1" ||
		store.lastInput.Settings["managed_by_postwave"] != true ||
		store.lastInput.Settings["sync_model"] != zendeskSyncModelNative ||
		store.lastInput.Settings["provider_cleanup"] != nil ||
		store.lastInput.Settings["verification_mode"] != "zendesk_oauth_or_api_token_tickets_rest_incremental_export_signed_webhooks_pending_live_certification" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if !hasString(store.lastInput.Scopes, "tickets:read") || !hasString(store.lastInput.Scopes, "users:read") {
		t.Fatalf("Zendesk native scopes should default from provider metadata: %+v", store.lastInput.Scopes)
	}
	if store.lastInput.Settings["page_size"] != float64(500) {
		t.Fatalf("page_size should remain a provider pull setting, settings=%+v", store.lastInput.Settings)
	}
}

func TestDisconnectElevatedSupportIntegrationsReturnsAndPersistsProviderCleanupEvidence(t *testing.T) {
	recordedAt := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name          string
		provider      string
		scopeType     string
		scopeKey      string
		scopeID       string
		webhookKey    string
		webhookID     string
		actionSnippet string
	}{
		{
			name:          "Zendesk",
			provider:      ProviderZendesk,
			scopeType:     "zendesk_subdomain",
			scopeKey:      "subdomain",
			scopeID:       "acme",
			webhookKey:    "zendesk_webhook_id",
			webhookID:     "zendesk_wh_1",
			actionSnippet: "Zendesk webhook",
		},
		{
			name:          "Intercom",
			provider:      ProviderIntercom,
			scopeType:     "intercom_workspace_id",
			scopeKey:      "workspace_id",
			scopeID:       "workspace_123",
			webhookKey:    "intercom_webhook_id",
			webhookID:     "intercom_wh_1",
			actionSnippet: "Intercom app webhook",
		},
		{
			name:          "Help Scout",
			provider:      ProviderHelpScout,
			scopeType:     "help_scout_mailbox_id",
			scopeKey:      "mailbox_id",
			scopeID:       "mailbox_123",
			webhookKey:    "help_scout_webhook_id",
			webhookID:     "helpscout_wh_1",
			actionSnippet: "Help Scout app webhook",
		},
		{
			name:          "Freshdesk",
			provider:      ProviderFreshdesk,
			scopeType:     "freshdesk_account_domain",
			scopeKey:      "account_domain",
			scopeID:       "acme.freshdesk.com",
			webhookKey:    "freshdesk_webhook_id",
			webhookID:     "freshdesk_wh_1",
			actionSnippet: "Freshdesk automation webhook",
		},
		{
			name:          "Gorgias",
			provider:      ProviderGorgias,
			scopeType:     "gorgias_account_domain",
			scopeKey:      "account_domain",
			scopeID:       "acme.gorgias.com",
			webhookKey:    "gorgias_http_integration_id",
			webhookID:     "gorgias_http_1",
			actionSnippet: "Gorgias HTTP integration",
		},
		{
			name:          "Front",
			provider:      ProviderFront,
			scopeType:     "front_inbox_id",
			scopeKey:      "inbox_id",
			scopeID:       "inb_123",
			webhookKey:    "front_webhook_id",
			webhookID:     "front_wh_1",
			actionSnippet: "Front rule",
		},
		{
			name:          "Reamaze",
			provider:      ProviderReamaze,
			scopeType:     "reamaze_account_domain",
			scopeKey:      "account_domain",
			scopeID:       "acme.reamaze.com",
			webhookKey:    "reamaze_webhook_id",
			webhookID:     "reamaze_wh_1",
			actionSnippet: "Reamaze webhook",
		},
		{
			name:          "Crisp",
			provider:      ProviderCrisp,
			scopeType:     "crisp_website_id",
			scopeKey:      "website_id",
			scopeID:       "website_123",
			webhookKey:    "crisp_webhook_id",
			webhookID:     "crisp_wh_1",
			actionSnippet: "Crisp webhook",
		},
		{
			name:          "Kustomer",
			provider:      ProviderKustomer,
			scopeType:     "kustomer_organization_id",
			scopeKey:      "organization_id",
			scopeID:       "org_123",
			webhookKey:    "kustomer_webhook_id",
			webhookID:     "kustomer_wh_1",
			actionSnippet: "Kustomer webhook",
		},
		{
			name:          "Drift",
			provider:      ProviderDrift,
			scopeType:     "drift_workspace_id",
			scopeKey:      "workspace_id",
			scopeID:       "workspace_123",
			webhookKey:    "drift_webhook_id",
			webhookID:     "drift_wh_1",
			actionSnippet: "Drift webhook",
		},
		{
			name:          "LiveChat",
			provider:      ProviderLiveChat,
			scopeType:     "livechat_account_id",
			scopeKey:      "account_id",
			scopeID:       "account_123",
			webhookKey:    "livechat_webhook_id",
			webhookID:     "livechat_wh_1",
			actionSnippet: "LiveChat webhook",
		},
		{
			name:          "Zoho Desk",
			provider:      ProviderZohoDesk,
			scopeType:     "zoho_desk_organization_id",
			scopeKey:      "organization_id",
			scopeID:       "org_123",
			webhookKey:    "zoho_desk_webhook_id",
			webhookID:     "zoho_wh_1",
			actionSnippet: "Zoho Desk notification channel",
		},
		{
			name:          "Olark",
			provider:      ProviderOlark,
			scopeType:     "olark_site_id",
			scopeKey:      "site_id",
			scopeID:       "site_123",
			webhookKey:    "olark_webhook_id",
			webhookID:     "olark_wh_1",
			actionSnippet: "Olark webhook",
		},
		{
			name:          "Kayako",
			provider:      ProviderKayako,
			scopeType:     "kayako_account_domain",
			scopeKey:      "account_domain",
			scopeID:       "acme.kayako.com",
			webhookKey:    "kayako_webhook_id",
			webhookID:     "kayako_wh_1",
			actionSnippet: "Kayako webhook",
		},
		{
			name:          "HubSpot Service Hub",
			provider:      ProviderHubSpotServiceHub,
			scopeType:     "hubspot_portal_id",
			scopeKey:      "portal_id",
			scopeID:       "123456",
			webhookKey:    "hubspot_webhook_id",
			webhookID:     "hubspot_wh_1",
			actionSnippet: "HubSpot Service Hub webhook",
		},
		{
			name:          "Salesforce Service Cloud",
			provider:      ProviderSalesforceServiceCloud,
			scopeType:     "salesforce_service_cloud_instance_url",
			scopeKey:      "instance_url",
			scopeID:       "https://acme.my.salesforce.com",
			webhookKey:    "salesforce_service_cloud_webhook_id",
			webhookID:     "sf_service_wh_1",
			actionSnippet: "Salesforce Service Cloud webhook",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.CredentialsRef = "cred_" + strings.ReplaceAll(tc.provider, "-", "_")
			store.integration.Settings = map[string]any{
				tc.scopeKey:           tc.scopeID,
				tc.webhookKey:         tc.webhookID,
				"webhook_secret_ref":  "vault://support/webhook-secret",
				"provider_cleanup":    map[string]any{"status": "stale"},
				"zendesk_secret_leak": "do-not-copy",
			}
			if tc.provider == ProviderFront {
				delete(store.integration.Settings, "webhook_secret_ref")
				store.integration.Settings["front_webhook_secret_ref"] = "vault://support/front-webhook-secret"
			}
			if tc.provider == ProviderCrisp {
				delete(store.integration.Settings, "webhook_secret_ref")
				store.integration.Settings["crisp_webhook_secret_ref"] = "vault://support/crisp-webhook-secret"
			}
			if tc.provider == ProviderKustomer {
				delete(store.integration.Settings, "webhook_secret_ref")
				store.integration.Settings["kustomer_webhook_secret_ref"] = "vault://support/kustomer-webhook-secret"
			}
			if tc.provider == ProviderDrift {
				delete(store.integration.Settings, "webhook_secret_ref")
				store.integration.Settings["drift_webhook_secret_ref"] = "vault://support/drift-webhook-secret"
			}
			if tc.provider == ProviderLiveChat {
				delete(store.integration.Settings, "webhook_secret_ref")
				store.integration.Settings["livechat_webhook_secret_ref"] = "vault://support/livechat-webhook-secret"
			}
			if tc.provider == ProviderHubSpotServiceHub {
				delete(store.integration.Settings, "webhook_secret_ref")
				store.integration.Settings["hubspot_service_hub_webhook_secret_ref"] = "vault://support/hubspot-service-hub-webhook-secret"
			}
			deps := &Deps{
				Repo: store,
				Now:  func() time.Time { return recordedAt },
			}

			rec := httptest.NewRecorder()
			deps.DisconnectIntegration(rec, supportReq(http.MethodDelete, "/api/v1/support-integrations/support_1", ``))

			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			body := rec.Body.String()
			if strings.Contains(body, "vault://") || strings.Contains(body, "do-not-copy") {
				t.Fatalf("disconnect response leaked secret-like settings: %s", body)
			}
			var out struct {
				OK              bool                      `json:"ok"`
				ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
			}
			if err := json.Unmarshal([]byte(body), &out); err != nil {
				t.Fatal(err)
			}
			cleanup := out.ProviderCleanup
			if !out.OK ||
				cleanup.Provider != tc.provider ||
				cleanup.Status != "operator_action_required" ||
				cleanup.RecordedAt != "2026-06-29T12:00:00Z" ||
				cleanup.PostwaveStatus != "disconnected" ||
				cleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
				cleanup.ManagedProviderCleanup ||
				cleanup.ProviderScopeType != tc.scopeType ||
				cleanup.ProviderScopeID != tc.scopeID ||
				cleanup.ProviderWebhookID != tc.webhookID ||
				!cleanup.CredentialRefPresent ||
				!cleanup.WebhookSecretRefPresent ||
				cleanup.WebhookCleanupStatus != "operator_cleanup_required" ||
				cleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_if_no_longer_used" {
				t.Fatalf("cleanup=%+v", cleanup)
			}
			if !hasString(cleanup.PostwaveEffects, "provider-routed support webhooks no longer resolve this row") {
				t.Fatalf("cleanup should disclose local webhook stop effect: %+v", cleanup.PostwaveEffects)
			}
			if !hasStringContaining(cleanup.ProviderConsoleActions, tc.actionSnippet) {
				t.Fatalf("cleanup should disclose provider console action %q: %+v", tc.actionSnippet, cleanup.ProviderConsoleActions)
			}
			if !hasStringContaining(cleanup.ProviderCleanupEvidence, "does not call") {
				t.Fatalf("cleanup should disclose non-managed provider cleanup posture: %+v", cleanup.ProviderCleanupEvidence)
			}
			if store.integration.Status != "disconnected" {
				t.Fatalf("status=%s", store.integration.Status)
			}
			stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
			if !ok {
				t.Fatalf("stored cleanup missing: %+v", store.integration.Settings)
			}
			if stored["status"] != "operator_action_required" ||
				stored["provider"] != tc.provider ||
				stored["provider_scope_id"] != tc.scopeID ||
				stored["provider_webhook_id"] != tc.webhookID ||
				stored["managed_provider_cleanup"] != false ||
				stored["credential_ref_present"] != true ||
				stored["webhook_secret_ref_present"] != true {
				t.Fatalf("stored cleanup=%+v", stored)
			}
			if stored["webhook_secret_ref"] != nil {
				t.Fatalf("stored cleanup should not include raw secret refs: %+v", stored)
			}
		})
	}
}

func TestDisconnectZendeskDeletesManagedWebhookAndPersistsCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderZendesk
	store.integration.CredentialsRef = "cred_zendesk"
	store.integration.Settings = map[string]any{
		"subdomain":           "acme",
		"zendesk_webhook_id":  "zendesk_wh_1",
		"webhook_secret_ref":  "vault://support/zendesk-secret",
		"provider_cleanup":    map[string]any{"status": "stale"},
		"zendesk_secret_leak": "do-not-copy",
	}
	backfiller := &fakeZendeskBackfiller{deleteResult: ZendeskWebhookCleanupResult{
		WebhookID:          "zendesk_wh_1",
		Status:             "deleted",
		ProviderStatusCode: http.StatusNoContent,
	}}
	deps := &Deps{
		Repo:              store,
		ZendeskBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 30, 14, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, supportReq(http.MethodDelete, "/api/v1/support-integrations/support_1", ``))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.deleteCalls != 1 || backfiller.deleteWebhookID != "zendesk_wh_1" {
		t.Fatalf("delete calls=%d webhook=%q", backfiller.deleteCalls, backfiller.deleteWebhookID)
	}
	body := rec.Body.String()
	if strings.Contains(body, "vault://") || strings.Contains(body, "do-not-copy") {
		t.Fatalf("disconnect response leaked secret-like settings: %s", body)
	}
	var out struct {
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	cleanup := out.ProviderCleanup
	if cleanup.Provider != ProviderZendesk ||
		cleanup.ProviderCleanupPosture != "partial_managed_webhook_cleanup_operator_credentials" ||
		!cleanup.ManagedProviderCleanup ||
		cleanup.WebhookCleanupStatus != "deleted" ||
		cleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_if_no_longer_used" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	if !hasStringContaining(cleanup.ProviderCleanupEvidence, "Webhooks API DELETE") ||
		hasStringContaining(cleanup.ProviderCleanupEvidence, "does not call") {
		t.Fatalf("cleanup evidence should describe managed Zendesk webhook deletion only: %+v", cleanup.ProviderCleanupEvidence)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("stored cleanup missing: %+v", store.integration.Settings)
	}
	if stored["provider_cleanup_posture"] != "partial_managed_webhook_cleanup_operator_credentials" ||
		stored["managed_provider_cleanup"] != true ||
		stored["webhook_cleanup_status"] != "deleted" ||
		stored["provider_webhook_id"] != "zendesk_wh_1" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
	if stored["webhook_secret_ref"] != nil || stored["zendesk_secret_leak"] != nil {
		t.Fatalf("stored cleanup should not include raw secret refs: %+v", stored)
	}
}

func TestDisconnectZendeskWebhookCleanupFailurePreservesLocalDisconnect(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderZendesk
	store.integration.CredentialsRef = "cred_zendesk"
	store.integration.Settings = map[string]any{
		"subdomain":          "acme",
		"zendesk_webhook_id": "zendesk_wh_1",
	}
	backfiller := &fakeZendeskBackfiller{deleteErr: ZendeskRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: time.Minute, Snippet: "rate limited"}}
	deps := &Deps{Repo: store, ZendeskBackfiller: backfiller}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, supportReq(http.MethodDelete, "/api/v1/support-integrations/support_1", ``))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.integration.Status != "disconnected" {
		t.Fatalf("local disconnect should still proceed, status=%s", store.integration.Status)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("stored cleanup missing: %+v", store.integration.Settings)
	}
	if stored["webhook_cleanup_status"] != "failed_operator_cleanup_required" ||
		stored["managed_provider_cleanup"] != false {
		t.Fatalf("stored cleanup=%+v", stored)
	}
	evidence, _ := stored["provider_cleanup_evidence"].([]any)
	if len(evidence) == 0 || !strings.Contains(rec.Body.String(), "provider HTTP 429") {
		t.Fatalf("cleanup should preserve non-secret provider failure evidence: body=%s stored=%+v", rec.Body.String(), stored)
	}
}

func TestDisconnectGorgiasDeletesManagedHTTPIntegrationAndPersistsCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.CredentialsRef = "cred_gorgias"
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"gorgias_http_integration_id": "gorgias_http_1",
		"webhook_secret_ref":          "vault://support/gorgias-secret",
		"provider_cleanup":            map[string]any{"status": "stale"},
		"gorgias_secret_leak":         "do-not-copy",
	}
	backfiller := &fakeGorgiasBackfiller{deleteResult: GorgiasHTTPIntegrationCleanupResult{
		IntegrationID:      "gorgias_http_1",
		Status:             "deleted",
		ProviderStatusCode: http.StatusNoContent,
	}}
	deps := &Deps{
		Repo:              store,
		GorgiasBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 30, 15, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, supportReq(http.MethodDelete, "/api/v1/support-integrations/support_1", ``))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.deleteCalls != 1 || backfiller.deleteIntegrationID != "gorgias_http_1" {
		t.Fatalf("delete calls=%d integration=%q", backfiller.deleteCalls, backfiller.deleteIntegrationID)
	}
	body := rec.Body.String()
	if strings.Contains(body, "vault://") || strings.Contains(body, "do-not-copy") {
		t.Fatalf("disconnect response leaked secret-like settings: %s", body)
	}
	var out struct {
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	cleanup := out.ProviderCleanup
	if cleanup.Provider != ProviderGorgias ||
		cleanup.ProviderCleanupPosture != "partial_managed_http_integration_cleanup_operator_credentials" ||
		!cleanup.ManagedProviderCleanup ||
		cleanup.WebhookCleanupStatus != "deleted" ||
		cleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_if_no_longer_used" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	if !hasStringContaining(cleanup.ProviderCleanupEvidence, "Integrations API DELETE") ||
		hasStringContaining(cleanup.ProviderCleanupEvidence, "does not call") {
		t.Fatalf("cleanup evidence should describe managed Gorgias HTTP integration deletion only: %+v", cleanup.ProviderCleanupEvidence)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("stored cleanup missing: %+v", store.integration.Settings)
	}
	if stored["provider_cleanup_posture"] != "partial_managed_http_integration_cleanup_operator_credentials" ||
		stored["managed_provider_cleanup"] != true ||
		stored["webhook_cleanup_status"] != "deleted" ||
		stored["provider_webhook_id"] != "gorgias_http_1" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
	if stored["webhook_secret_ref"] != nil || stored["gorgias_secret_leak"] != nil {
		t.Fatalf("stored cleanup should not include raw secret refs: %+v", stored)
	}
}

func TestDisconnectGorgiasHTTPIntegrationCleanupFailurePreservesLocalDisconnect(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.CredentialsRef = "cred_gorgias"
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"gorgias_http_integration_id": "gorgias_http_1",
	}
	backfiller := &fakeGorgiasBackfiller{deleteErr: GorgiasRESTError{StatusCode: http.StatusBadRequest, RetryAfter: 30 * time.Second, Snippet: "rules still reference integration"}}
	deps := &Deps{Repo: store, GorgiasBackfiller: backfiller}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, supportReq(http.MethodDelete, "/api/v1/support-integrations/support_1", ``))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.integration.Status != "disconnected" {
		t.Fatalf("local disconnect should still proceed, status=%s", store.integration.Status)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("stored cleanup missing: %+v", store.integration.Settings)
	}
	if stored["webhook_cleanup_status"] != "failed_operator_cleanup_required" ||
		stored["managed_provider_cleanup"] != false {
		t.Fatalf("stored cleanup=%+v", stored)
	}
	evidence, _ := stored["provider_cleanup_evidence"].([]any)
	if len(evidence) == 0 || !strings.Contains(rec.Body.String(), "provider HTTP 400") {
		t.Fatalf("cleanup should preserve non-secret provider failure evidence: body=%s stored=%+v", rec.Body.String(), stored)
	}
}

func TestDisconnectLiveChatManagedWebhooksUnregistersProviderIDs(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderLiveChat
	store.integration.CredentialsRef = "cred_livechat"
	store.integration.Settings = map[string]any{
		"account_id":                           "account_123",
		"livechat_webhook_id":                  "route_token_1",
		"livechat_provider_webhook_ids":        "provider_wh_1,provider_wh_2",
		"livechat_owner_client_id":             "owner_client_1",
		"livechat_webhook_managed_by_postwave": true,
		"livechat_webhook_secret_ref":          "vault://support/livechat-secret",
		"livechat_provider_secret_leak":        "do-not-copy",
	}
	manager := &fakeLiveChatBackfiller{}
	deps := &Deps{
		Repo:               store,
		LiveChatBackfiller: manager,
		Now:                func() time.Time { return time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, supportReq(http.MethodDelete, "/api/v1/support-integrations/support_1", ``))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(manager.unregisterCalls) != 2 ||
		manager.unregisterCalls[0] != "provider_wh_1" ||
		manager.unregisterCalls[1] != "provider_wh_2" ||
		manager.unregisterOwnerIDs[0] != "owner_client_1" ||
		manager.unregisterOwnerIDs[1] != "owner_client_1" {
		t.Fatalf("unregister calls=%+v owner=%+v", manager.unregisterCalls, manager.unregisterOwnerIDs)
	}
	body := rec.Body.String()
	if strings.Contains(body, "vault://") || strings.Contains(body, "do-not-copy") {
		t.Fatalf("disconnect response leaked secret-like settings: %s", body)
	}
	var out struct {
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	cleanup := out.ProviderCleanup
	if cleanup.Provider != ProviderLiveChat ||
		cleanup.ProviderCleanupPosture != "partial_managed_webhook_cleanup_operator_credentials" ||
		!cleanup.ManagedProviderCleanup ||
		cleanup.WebhookCleanupStatus != "deleted" ||
		cleanup.ProviderWebhookID != "provider_wh_1,provider_wh_2" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("stored cleanup missing: %+v", store.integration.Settings)
	}
	if stored["provider_cleanup_posture"] != "partial_managed_webhook_cleanup_operator_credentials" ||
		stored["managed_provider_cleanup"] != true ||
		stored["webhook_cleanup_status"] != "deleted" ||
		stored["provider_webhook_id"] != "provider_wh_1,provider_wh_2" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
	if stored["livechat_webhook_secret_ref"] != nil || stored["livechat_provider_secret_leak"] != nil {
		t.Fatalf("stored cleanup should not include raw secret refs: %+v", stored)
	}
}

func TestDisconnectNonElevatedSupportIntegrationDoesNotReturnProviderCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTidio
	store.integration.Settings = map[string]any{
		"webhook_secret_ref": "vault://support/tidio",
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, supportReq(http.MethodDelete, "/api/v1/support-integrations/support_1", ``))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "provider_cleanup") {
		t.Fatalf("non-elevated provider should not return cleanup evidence: %s", rec.Body.String())
	}
	if store.integration.Status != "disconnected" || store.integration.Settings["provider_cleanup"] != nil {
		t.Fatalf("state=%s settings=%+v", store.integration.Status, store.integration.Settings)
	}
}

func TestDisconnectGorgiasProviderCleanupDetectsProviderSpecificWebhookSecretRef(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":                "acme.gorgias.com",
		"gorgias_http_integration_id":   "http_123",
		"gorgias_webhook_secret_ref":    "vault://support/gorgias-secret",
		"provider_cleanup":              map[string]any{"status": "stale"},
		"gorgias_webhook_secret_leak":   "do-not-copy",
		"gorgias_api_key_possible_leak": "do-not-copy",
	}
	deps := &Deps{Repo: store, Now: func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) }}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, supportReq(http.MethodDelete, "/api/v1/support-integrations/support_1", ``))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "vault://") || strings.Contains(rec.Body.String(), "do-not-copy") {
		t.Fatalf("disconnect response leaked secret-like settings: %s", rec.Body.String())
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("stored cleanup missing: %+v", store.integration.Settings)
	}
	if stored["webhook_secret_ref_present"] != true || stored["webhook_cleanup_status"] != "operator_cleanup_required" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
	if stored["gorgias_webhook_secret_ref"] != nil {
		t.Fatalf("stored cleanup should not include raw secret refs: %+v", stored)
	}
}

func TestCreateGorgiasIntegrationKeepsNativePullSettingsAndStripsWebhookRefs(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations", `{
		"provider":"gorgias",
		"settings":{
			"account_domain":"acme.gorgias.com",
			"credentials_ref":"cred_gorgias_1",
			"page_size":250,
			"webhook_secret_ref":"cred_gorgias_webhook_1",
			"gorgias_http_integration_id":"http_123"
		},
		"scopes":["tickets:read"]
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderGorgias || store.lastInput.CredentialsRef != "cred_gorgias_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["account_domain"] != "acme.gorgias.com" ||
		store.lastInput.Settings["page_size"] != float64(250) ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_gorgias_webhook_1" ||
		store.lastInput.Settings["gorgias_http_integration_id"] != "http_123" ||
		store.lastInput.Settings["sync_model"] != gorgiasSyncModelNative ||
		store.lastInput.Settings["verification_mode"] != "gorgias_api_key_tickets_rest_cursor_authenticated_http_callbacks_pending_hmac_live_certification" ||
		len(store.lastInput.Scopes) != 0 {
		t.Fatalf("settings=%+v scopes=%+v", store.lastInput.Settings, store.lastInput.Scopes)
	}
}

func TestSyncIntegrationMirrorsTicketsMessagesProfilesAndEvents(t *testing.T) {
	store := newFakeStore()
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		Now:      func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/sync", `{
		"cursor":"after-123",
		"tickets":[{"source_id":"t1","conversation_id":"c1","email":"VIP@Example.com","subject":"Where is my order?","status":"solved","priority":"high"}],
		"messages":[{"source_id":"m1","conversation_id":"c1","email":"vip@example.com","body_text":"Thanks!"}],
		"events":[{"source_id":"e1","email":"vip@example.com","event_name":"support.csat_received","status":"resolved"}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.TicketsUpserted != 1 || out.MessagesUpserted != 1 || out.ProfilesUpserted != 1 || out.EventsTracked != 3 || out.RunID == "" {
		t.Fatalf("summary=%+v", out)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].Status != "resolved" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(suite.messages) != 1 || suite.messages[0].Email != "vip@example.com" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || profiles.tickets[0].Email != "vip@example.com" {
		t.Fatalf("profiles=%+v", profiles.tickets)
	}
	if len(events.events) != 3 || events.events[2].EventName != "support.csat_received" {
		t.Fatalf("events=%+v", events.events)
	}
}

func TestSyncIntegrationRequiresCanonicalSupportRows(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/sync", `{"cursor":"after-123"}`))

	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "payload_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("empty support sync should not record a provider-pull-like run: %+v", store.runs)
	}
}

func TestSyncIntegrationPullsZendeskProviderOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		ZendeskBackfiller: fakeZendeskBackfiller{req: SyncRequest{
			RunMode: "backfill",
			Cursor:  "zendesk:next",
			Tickets: []TicketInput{{
				SourceID:       "zendesk://ticket/42",
				ConversationID: "42",
				Email:          "vip@example.com",
				Subject:        "Order help",
				Status:         "open",
			}},
		}},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "zendesk://ticket/42" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != "zendesk:next" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
}

func TestSyncIntegrationPullsGorgiasProviderOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{"account_domain": "acme.gorgias.com", "credentials_ref": "cred_gorgias_1", "commerce_integration_id": "commerce_1"}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	commerce := &fakeGorgiasCommerceResolver{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		Commerce: commerce,
		GorgiasBackfiller: fakeGorgiasBackfiller{req: SyncRequest{
			RunMode: "backfill",
			Cursor:  gorgiasCursorPrefix + "next",
			Tickets: []TicketInput{{
				SourceID:       "gorgias://ticket/42",
				ConversationID: "42",
				Email:          "buyer@example.com",
				Subject:        "Shipping help",
				Status:         "open",
				Properties: map[string]any{
					"gorgias_commerce_context_present": true,
					"shopify_order_id":                 "gid://shopify/Order/1001",
					"shopify_customer_id":              "gid://shopify/Customer/88",
					"product_source_candidates":        []string{"gid://shopify/Product/77"},
				},
			}},
		}},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "gorgias://ticket/42" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if commerce.calls != 1 || commerce.tenantID != "tenant-1" || commerce.email != "buyer@example.com" || settingString(commerce.integration.Settings, "commerce_integration_id") != "commerce_1" {
		t.Fatalf("commerce resolver call=%d tenant=%q email=%q integration=%+v", commerce.calls, commerce.tenantID, commerce.email, commerce.integration)
	}
	if suite.tickets[0].Properties["resolved_order_id"] != "order_uuid_1" ||
		profiles.tickets[0].Properties["resolved_customer_id"] != "customer_uuid_1" ||
		events.events[0].Properties["resolved_product_id"] != "product_uuid_1" {
		t.Fatalf("commerce resolution did not propagate: tickets=%+v profiles=%+v events=%+v", suite.tickets, profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != gorgiasCursorPrefix+"next" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationPullsIntercomProviderOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderIntercom
	store.integration.Settings = map[string]any{"workspace_id": "workspace_123", "credentials_ref": "cred_intercom_1"}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		IntercomBackfiller: fakeZendeskBackfiller{req: SyncRequest{
			RunMode: "backfill",
			Cursor:  intercomCursorPrefix + "next",
			Tickets: []TicketInput{{
				SourceID:       "intercom://conversation/c1",
				ConversationID: "c1",
				Email:          "buyer@example.com",
				Subject:        "Need help",
				Status:         "open",
			}},
		}},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "intercom://conversation/c1" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != intercomCursorPrefix+"next" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
}

func TestSyncIntegrationPullsHelpScoutProviderOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderHelpScout
	store.integration.Settings = map[string]any{"mailbox_id": "mailbox_123", "credentials_ref": "cred_helpscout_1"}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		HelpScoutBackfiller: fakeZendeskBackfiller{req: SyncRequest{
			RunMode: "backfill",
			Cursor:  helpScoutCursorPrefix + "2",
			Tickets: []TicketInput{{
				SourceID:       "help-scout://conversation/88",
				ConversationID: "88",
				Email:          "buyer@example.com",
				Subject:        "Need help",
				Status:         "active",
			}},
		}},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "help-scout://conversation/88" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != helpScoutCursorPrefix+"2" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
}

func TestSyncIntegrationPullsFreshdeskProviderOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFreshdesk
	store.integration.Settings = map[string]any{"account_domain": "acme.freshdesk.com", "credentials_ref": "cred_freshdesk_1"}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		FreshdeskBackfiller: fakeZendeskBackfiller{req: SyncRequest{
			RunMode: "backfill",
			Cursor:  freshdeskCursorPrefix + "2",
			Tickets: []TicketInput{{
				SourceID:       "freshdesk://ticket/77",
				ConversationID: "77",
				Email:          "buyer@example.com",
				Subject:        "Need help",
				Status:         "open",
			}},
		}},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "freshdesk://ticket/77" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != freshdeskCursorPrefix+"2" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
}

func TestSyncIntegrationUsesStoredSupportCursorOnEmptyRequest(t *testing.T) {
	for _, tc := range supportProviderTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Settings = tc.settings
			store.integration.SyncCursor = tc.cursor
			backfiller := &recordingSupportBackfiller{req: SyncRequest{
				RunMode: "backfill",
				Cursor:  tc.nextCursor,
				Tickets: []TicketInput{{
					SourceID:       tc.provider + "://ticket/42",
					ConversationID: "42",
					Email:          "buyer@example.com",
					Subject:        "Need help",
					Status:         "open",
				}},
			}}
			deps := &Deps{
				Repo:     store,
				Suite:    &fakeSuiteSink{},
				Profiles: &fakeProfileSink{},
				Events:   &fakeEventSink{},
			}
			tc.assign(deps, backfiller)
			rec := httptest.NewRecorder()

			deps.BackfillIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/backfill", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.calls != 1 || backfiller.cursor != tc.cursor {
				t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, tc.cursor)
			}
			if len(store.runs) != 1 || store.runs[0].CursorTo != tc.nextCursor {
				t.Fatalf("runs=%+v", store.runs)
			}
		})
	}
}

func TestSyncIntegrationSkipsSupportRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range supportProviderTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := supportBackfillConfig(tc.provider)
			if err != nil {
				t.Fatal(err)
			}
			retryCursor := encodeSupportRetryCursor(cfg, supportRetryState{
				Cursor:        tc.cursor,
				Attempts:      1,
				LastStatus:    "BACKFILL_FAILED",
				LastError:     "provider throttled",
				NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
			})
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Settings = tc.settings
			store.integration.SyncCursor = retryCursor
			backfiller := &recordingSupportBackfiller{}
			deps := &Deps{Repo: store, Now: func() time.Time { return now }}
			tc.assign(deps, backfiller)
			rec := httptest.NewRecorder()

			deps.BackfillIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/backfill", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.calls != 0 || len(store.runs) != 0 {
				t.Fatalf("calls=%d runs=%+v", backfiller.calls, store.runs)
			}
			var out SyncSummary
			if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
				t.Fatal(err)
			}
			if out.Cursor != retryCursor {
				t.Fatalf("cursor=%q want %q", out.Cursor, retryCursor)
			}
		})
	}
}

func TestSyncIntegrationResumesSupportRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range supportProviderTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := supportBackfillConfig(tc.provider)
			if err != nil {
				t.Fatal(err)
			}
			retryCursor := encodeSupportRetryCursor(cfg, supportRetryState{
				Cursor:        tc.cursor,
				Attempts:      1,
				LastStatus:    "BACKFILL_FAILED",
				LastError:     "provider throttled",
				NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
			})
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Settings = tc.settings
			store.integration.SyncCursor = retryCursor
			backfiller := &recordingSupportBackfiller{req: SyncRequest{
				RunMode: "backfill",
				Cursor:  tc.nextCursor,
				Tickets: []TicketInput{{SourceID: tc.provider + "://ticket/42", Email: "buyer@example.com", Subject: "Need help"}},
			}}
			deps := &Deps{
				Repo:     store,
				Suite:    &fakeSuiteSink{},
				Profiles: &fakeProfileSink{},
				Events:   &fakeEventSink{},
				Now:      func() time.Time { return now },
			}
			tc.assign(deps, backfiller)
			rec := httptest.NewRecorder()

			deps.BackfillIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/backfill", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.calls != 1 || backfiller.cursor != tc.cursor {
				t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, tc.cursor)
			}
			if len(store.runs) != 1 || store.runs[0].CursorTo != tc.nextCursor {
				t.Fatalf("runs=%+v", store.runs)
			}
		})
	}
}

func TestSyncIntegrationStoresSupportRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range supportProviderTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := supportBackfillConfig(tc.provider)
			if err != nil {
				t.Fatal(err)
			}
			retryCursor := encodeSupportRetryCursor(cfg, supportRetryState{
				Cursor:        tc.cursor,
				Attempts:      1,
				LastStatus:    "BACKFILL_FAILED",
				LastError:     "provider throttled",
				NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
			})
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Settings = tc.settings
			store.integration.SyncCursor = retryCursor
			backfiller := &recordingSupportBackfiller{err: errors.New("provider still throttled")}
			deps := &Deps{Repo: store, Now: func() time.Time { return now }}
			tc.assign(deps, backfiller)
			rec := httptest.NewRecorder()

			deps.BackfillIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/backfill", `{}`))

			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.calls != 1 || backfiller.cursor != tc.cursor {
				t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, tc.cursor)
			}
			if len(store.runs) != 1 || store.runs[0].Status != "failed" {
				t.Fatalf("runs=%+v", store.runs)
			}
			retry, ok, err := decodeSupportRetryCursor(cfg, store.runs[0].CursorTo)
			if err != nil || !ok {
				t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
			}
			if retry.Cursor != tc.cursor || retry.Attempts != 2 || retry.LastStatus != "BACKFILL_FAILED" {
				t.Fatalf("retry=%+v", retry)
			}
		})
	}
}

func TestSyncIntegrationRejectsDisconnectedSupportIntegration(t *testing.T) {
	for _, path := range []struct {
		name   string
		handle func(*Deps, http.ResponseWriter, *http.Request)
		url    string
	}{
		{name: "sync", handle: (*Deps).SyncIntegration, url: "/api/v1/support-integrations/support_1/sync"},
		{name: "backfill", handle: (*Deps).BackfillIntegration, url: "/api/v1/support-integrations/support_1/backfill"},
	} {
		t.Run(path.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Status = "disconnected"
			backfiller := &recordingSupportBackfiller{req: SyncRequest{Tickets: []TicketInput{{SourceID: "zendesk://ticket/42", Email: "buyer@example.com", Subject: "Need help"}}}}
			deps := &Deps{Repo: store, ZendeskBackfiller: backfiller}
			rec := httptest.NewRecorder()

			path.handle(deps, rec, supportReq(http.MethodPost, path.url, `{}`))

			if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.calls != 0 || len(store.runs) != 0 {
				t.Fatalf("calls=%d runs=%+v", backfiller.calls, store.runs)
			}
		})
	}
}

func TestIngestEventRejectsDisconnectedSupportIntegration(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	events := &fakeEventSink{}
	deps := &Deps{Repo: store, Events: events}
	rec := httptest.NewRecorder()

	deps.IngestEvent(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/ingest", `{
		"source_id":"zendesk://event/42",
		"email":"buyer@example.com",
		"event_name":"support.ticket.updated"
	}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(events.events) != 0 {
		t.Fatalf("runs=%+v events=%+v", store.runs, events.events)
	}
}

func TestPauseIntegrationRejectsDisconnectedSupportIntegration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Status = "disconnected"
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()

	deps.PauseIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/pause", `{}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.integration.Status != "disconnected" {
		t.Fatalf("pause resurrected disconnected row: %s", store.integration.Status)
	}
}

func TestFrontWebhookVerifiesSignatureAndIngestsTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderFront
	store.integration.Settings = map[string]any{
		"inbox_id":                 "inb_123",
		"front_webhook_secret_ref": "cred_front_webhook_1",
		"front_webhook_id":         "front_wh_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_front_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_front_1","type":"inbound","emitted_at":1781956800,"conversation":{"id":"cnv_123","subject":"Where is my order?","status":"open","recipient":{"handle":"Buyer@Example.com","name":"Ada Buyer"}},"message":{"id":"msg_1","text":"Can you help?"}}`)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/front/inb_123/webhooks?webhook_id=front_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Front-Request-Timestamp", timestamp)
	req.Header.Set("X-Front-Signature", signFrontWebhookTest("secret", body, timestamp))
	req.Header.Set("X-Front-Event-Id", "evt_header_1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "front://conversation/cnv_123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["front_webhook_id"] != "front_wh_1" || suite.tickets[0].Properties["front_webhook_event"] != "inbound" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "front://message/msg_1" || suite.messages[0].BodyText != "Can you help?" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "front-webhook-evt_front_1" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderFront+":"+frontWebhookDeliveryID(req, "inb_123", "front_wh_1", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestFrontWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderFront
	store.integration.Settings = map[string]any{
		"inbox_id":                 "inb_123",
		"front_webhook_secret_ref": "cred_front_webhook_1",
		"front_webhook_id":         "front_wh_1",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_front_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"id":"evt_front_replay","type":"inbound","conversation":{"id":"cnv_123","recipient":{"handle":"buyer@example.com"}}}`)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/front/inb_123/webhooks?webhook_id=front_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Front-Request-Timestamp", timestamp)
		req.Header.Set("X-Front-Signature", signFrontWebhookTest("secret", body, timestamp))
		req.Header.Set("X-Front-Event-Id", "evt_front_replay")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestFrontWebhookSparseConversationRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderFront
	store.integration.Settings = map[string]any{
		"inbox_id":                 "inb_123",
		"front_webhook_secret_ref": "cred_front_webhook_1",
		"front_webhook_id":         "front_wh_1",
	}
	backfiller := &fakeFrontBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "front://conversation/cnv_123",
			ConversationID: "cnv_123",
			Email:          "buyer@example.com",
			Subject:        "Where is my order?",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:            store,
		Suite:           suite,
		Profiles:        profiles,
		Events:          events,
		FrontBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_front_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_front_sparse","type":"inbound","conversation":{"id":"cnv_123"}}`)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/front/inb_123/webhooks?webhook_id=front_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Front-Request-Timestamp", timestamp)
		req.Header.Set("X-Front-Signature", signFrontWebhookTest("secret", body, timestamp))
		req.Header.Set("X-Front-Event-Id", "evt_front_sparse")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshConversationID != "cnv_123" {
		t.Fatalf("refresh calls=%d conversationID=%q", backfiller.refreshCalls, backfiller.refreshConversationID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "front://conversation/cnv_123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["front_refresh_source"] != "webhook_sparse_conversation" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 || store.runs[0].CursorTo != "front-webhook-cnv_123" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestFrontWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderFront
	store.integration.Settings = map[string]any{
		"inbox_id":                 "inb_123",
		"front_webhook_secret_ref": "cred_front_webhook_1",
		"front_webhook_id":         "front_wh_1",
	}
	backfiller := &fakeFrontBackfiller{refreshErr: FrontRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 25 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:            store,
		Suite:           &fakeSuiteSink{},
		FrontBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_front_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_front_retry","type":"inbound","conversation":{"id":"cnv_123"}}`)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/front/inb_123/webhooks?webhook_id=front_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Front-Request-Timestamp", timestamp)
	req.Header.Set("X-Front-Signature", signFrontWebhookTest("secret", body, timestamp))
	req.Header.Set("X-Front-Event-Id", "evt_front_retry")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "25" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderFront+":"+frontWebhookDeliveryID(req, "inb_123", "front_wh_1", body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestFrontWebhookRejectsInvalidSignature(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderFront
	store.integration.Settings = map[string]any{
		"inbox_id":                 "inb_123",
		"front_webhook_secret_ref": "cred_front_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_front_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_front_bad","type":"inbound","conversation":{"id":"cnv_123","recipient":{"handle":"buyer@example.com"}}}`)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/front/inb_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Front-Request-Timestamp", timestamp)
	req.Header.Set("X-Front-Signature", signFrontWebhookTest("wrong", body, timestamp))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid signature should not claim webhook: %+v", store.webhooks)
	}
}

func TestCrispWebhookVerifiesSignatureAndIngestsTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderCrisp
	store.integration.Settings = map[string]any{
		"website_id":               "site_123",
		"crisp_webhook_secret_ref": "cred_crisp_webhook_1",
		"crisp_webhook_id":         "crisp_wh_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_crisp_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_crisp_1","event":"message:received","timestamp":1781956800000,"data":{"website_id":"site_123","session_id":"sess_123","email":"Buyer@Example.com","nickname":"Ada Buyer","subject":"Order help","state":"unresolved","segments":["vip"],"fingerprint":"fp_1","from":"user","content":"Hello from chat"}}`)
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/crisp/site_123/webhooks?webhook_id=crisp_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Crisp-Request-Timestamp", timestamp)
	req.Header.Set("X-Crisp-Signature", signCrispWebhookTest("secret", body, timestamp))
	req.Header.Set("X-Crisp-Event-Id", "evt_header_1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "crisp://conversation/sess_123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["crisp_webhook_id"] != "crisp_wh_1" || suite.tickets[0].Properties["crisp_webhook_event"] != "message:received" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "crisp://message/fp_1" || suite.messages[0].BodyText != "Hello from chat" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "crisp-webhook-evt_crisp_1" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderCrisp+":"+crispWebhookDeliveryID(req, "site_123", "crisp_wh_1", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestCrispWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderCrisp
	store.integration.Settings = map[string]any{
		"website_id":               "site_123",
		"crisp_webhook_secret_ref": "cred_crisp_webhook_1",
		"crisp_webhook_id":         "crisp_wh_1",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_crisp_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"id":"evt_crisp_replay","event":"session:set_email","data":{"website_id":"site_123","session_id":"sess_123","email":"buyer@example.com"}}`)
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/crisp/site_123/webhooks?webhook_id=crisp_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Crisp-Request-Timestamp", timestamp)
		req.Header.Set("X-Crisp-Signature", signCrispWebhookTest("secret", body, timestamp))
		req.Header.Set("X-Crisp-Event-Id", "evt_crisp_replay")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestCrispWebhookSparseSessionRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderCrisp
	store.integration.Settings = map[string]any{
		"website_id":               "site_123",
		"crisp_webhook_secret_ref": "cred_crisp_webhook_1",
		"crisp_webhook_id":         "crisp_wh_1",
	}
	backfiller := &fakeCrispBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "crisp://conversation/sess_123",
			ConversationID: "sess_123",
			Email:          "buyer@example.com",
			Subject:        "Order help",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:            store,
		Suite:           suite,
		Profiles:        profiles,
		Events:          events,
		CrispBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_crisp_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_crisp_sparse","event":"message:received","data":{"website_id":"site_123","session_id":"sess_123"}}`)
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/crisp/site_123/webhooks?webhook_id=crisp_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Crisp-Request-Timestamp", timestamp)
		req.Header.Set("X-Crisp-Signature", signCrispWebhookTest("secret", body, timestamp))
		req.Header.Set("X-Crisp-Event-Id", "evt_crisp_sparse")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshSessionID != "sess_123" {
		t.Fatalf("refresh calls=%d sessionID=%q", backfiller.refreshCalls, backfiller.refreshSessionID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "crisp://conversation/sess_123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["crisp_refresh_source"] != "webhook_sparse_session" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 || store.runs[0].CursorTo != "crisp-webhook-sess_123" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestCrispWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderCrisp
	store.integration.Settings = map[string]any{
		"website_id":               "site_123",
		"crisp_webhook_secret_ref": "cred_crisp_webhook_1",
		"crisp_webhook_id":         "crisp_wh_1",
	}
	backfiller := &fakeCrispBackfiller{refreshErr: CrispRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 45 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:            store,
		Suite:           &fakeSuiteSink{},
		CrispBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_crisp_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_crisp_retry","event":"message:received","data":{"website_id":"site_123","session_id":"sess_123"}}`)
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/crisp/site_123/webhooks?webhook_id=crisp_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Crisp-Request-Timestamp", timestamp)
	req.Header.Set("X-Crisp-Signature", signCrispWebhookTest("secret", body, timestamp))
	req.Header.Set("X-Crisp-Event-Id", "evt_crisp_retry")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "45" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderCrisp+":"+crispWebhookDeliveryID(req, "site_123", "crisp_wh_1", body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestCrispWebhookRejectsInvalidSignature(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderCrisp
	store.integration.Settings = map[string]any{
		"website_id":               "site_123",
		"crisp_webhook_secret_ref": "cred_crisp_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_crisp_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_crisp_bad","event":"session:set_email","data":{"website_id":"site_123","session_id":"sess_123","email":"buyer@example.com"}}`)
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/crisp/site_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Crisp-Request-Timestamp", timestamp)
	req.Header.Set("X-Crisp-Signature", signCrispWebhookTest("wrong", body, timestamp))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid signature should not claim webhook: %+v", store.webhooks)
	}
}

func TestKustomerWebhookVerifiesSignatureAndIngestsTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderKustomer
	store.integration.Settings = map[string]any{
		"organization_id":             "org_123",
		"kustomer_webhook_secret_ref": "cred_kustomer_webhook_1",
		"kustomer_webhook_id":         "kustomer_wh_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_kustomer_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_kustomer_1","event":"message.created","createdAt":"2026-06-20T12:00:00Z","conversation":{"id":"conv_123","name":"Where is my order?","status":"open"},"customer":{"email":"Buyer@Example.com","name":"Ada Buyer"},"message":{"id":"msg_1","body":"Can you help?"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/kustomer/org_123/webhooks?webhook_id=kustomer_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kustomer-Webhook-Signature", signKustomerWebhookTest("secret", body))
	req.Header.Set("X-Kustomer-Event-Id", "evt_header_1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "kustomer://conversation/conv_123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["kustomer_webhook_id"] != "kustomer_wh_1" || suite.tickets[0].Properties["kustomer_webhook_event"] != "message.created" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "kustomer://message/msg_1" || suite.messages[0].BodyText != "Can you help?" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "kustomer-webhook-evt_kustomer_1" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderKustomer+":"+kustomerWebhookDeliveryID(req, "org_123", "kustomer_wh_1", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestKustomerWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderKustomer
	store.integration.Settings = map[string]any{
		"organization_id":             "org_123",
		"kustomer_webhook_secret_ref": "cred_kustomer_webhook_1",
		"kustomer_webhook_id":         "kustomer_wh_1",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_kustomer_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"id":"evt_kustomer_replay","event":"conversation.updated","conversation":{"id":"conv_123"},"customer":{"email":"buyer@example.com"}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/kustomer/org_123/webhooks?webhook_id=kustomer_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Kustomer-Webhook-Signature", signKustomerWebhookTest("secret", body))
		req.Header.Set("X-Kustomer-Event-Id", "evt_kustomer_replay")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestKustomerWebhookSparseConversationRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderKustomer
	store.integration.Settings = map[string]any{
		"organization_id":             "org_123",
		"kustomer_webhook_secret_ref": "cred_kustomer_webhook_1",
		"kustomer_webhook_id":         "kustomer_wh_1",
	}
	backfiller := &fakeKustomerBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "kustomer://conversation/conv_123",
			ConversationID: "conv_123",
			Email:          "buyer@example.com",
			Subject:        "Where is my order?",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:               store,
		Suite:              suite,
		Profiles:           profiles,
		Events:             events,
		KustomerBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_kustomer_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_kustomer_sparse","event":"conversation.updated","conversation":{"id":"conv_123"}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/kustomer/org_123/webhooks?webhook_id=kustomer_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Kustomer-Webhook-Signature", signKustomerWebhookTest("secret", body))
		req.Header.Set("X-Kustomer-Event-Id", "evt_kustomer_sparse")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshConversationID != "conv_123" {
		t.Fatalf("refresh calls=%d conversationID=%q", backfiller.refreshCalls, backfiller.refreshConversationID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "kustomer://conversation/conv_123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["kustomer_refresh_source"] != "webhook_sparse_conversation" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 || store.runs[0].CursorTo != "kustomer-webhook-conv_123" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestKustomerWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderKustomer
	store.integration.Settings = map[string]any{
		"organization_id":             "org_123",
		"kustomer_webhook_secret_ref": "cred_kustomer_webhook_1",
		"kustomer_webhook_id":         "kustomer_wh_1",
	}
	backfiller := &fakeKustomerBackfiller{refreshErr: KustomerRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 35 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:               store,
		Suite:              &fakeSuiteSink{},
		KustomerBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_kustomer_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_kustomer_retry","event":"conversation.updated","conversation":{"id":"conv_123"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/kustomer/org_123/webhooks?webhook_id=kustomer_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kustomer-Webhook-Signature", signKustomerWebhookTest("secret", body))
	req.Header.Set("X-Kustomer-Event-Id", "evt_kustomer_retry")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "35" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderKustomer+":"+kustomerWebhookDeliveryID(req, "org_123", "kustomer_wh_1", body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestKustomerWebhookRejectsInvalidSignature(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderKustomer
	store.integration.Settings = map[string]any{
		"organization_id":             "org_123",
		"kustomer_webhook_secret_ref": "cred_kustomer_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_kustomer_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt_kustomer_bad","event":"conversation.updated","conversation":{"id":"conv_123"},"customer":{"email":"buyer@example.com"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/kustomer/org_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kustomer-Webhook-Signature", signKustomerWebhookTest("wrong", body))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid signature should not claim webhook: %+v", store.webhooks)
	}
}

func TestDriftWebhookVerifiesTokenAndIngestsTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderDrift
	store.integration.Settings = map[string]any{
		"workspace_id":             "12345",
		"drift_webhook_secret_ref": "cred_drift_webhook_1",
		"drift_webhook_id":         "drift_wh_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_drift_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"eventId":"evt_drift_1","type":"new_message","token":"secret","orgId":12345,"data":{"id":987,"conversationId":456,"body":"Can you help?","createdAt":1781956800000,"status":"open","contact":{"email":"Buyer@Example.com","name":"Ada Buyer"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/drift/12345/webhooks?webhook_id=drift_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Verification-Token", "secret")
	req.Header.Set("X-Drift-Event-Id", "evt_header_1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "drift://conversation/456" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["drift_webhook_id"] != "drift_wh_1" || suite.tickets[0].Properties["drift_webhook_event"] != "new_message" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	rawEvidence, _ := json.Marshal(suite.tickets[0].Properties["drift_raw"])
	if strings.Contains(string(rawEvidence), "secret") {
		t.Fatalf("drift raw evidence leaked token: %s", string(rawEvidence))
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "drift://message/987" || suite.messages[0].BodyText != "Can you help?" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "drift-webhook-evt_drift_1" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderDrift+":"+driftWebhookDeliveryID(req, "12345", "drift_wh_1", driftWebhookRaw(body), body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestDriftWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderDrift
	store.integration.Settings = map[string]any{
		"workspace_id":             "12345",
		"drift_webhook_secret_ref": "cred_drift_webhook_1",
		"drift_webhook_id":         "drift_wh_1",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_drift_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"eventId":"evt_drift_replay","type":"new_conversation","token":"secret","orgId":12345,"data":{"id":456,"contact":{"email":"buyer@example.com","name":"Ada"}}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/drift/12345/webhooks?webhook_id=drift_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Verification-Token", "secret")
		req.Header.Set("X-Drift-Event-Id", "evt_drift_replay")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestDriftWebhookSparseConversationRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderDrift
	store.integration.Settings = map[string]any{
		"workspace_id":             "12345",
		"drift_webhook_secret_ref": "cred_drift_webhook_1",
		"drift_webhook_id":         "drift_wh_1",
	}
	backfiller := &fakeDriftBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "drift://conversation/456",
			ConversationID: "456",
			Email:          "buyer@example.com",
			Subject:        "Where is my order?",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:            store,
		Suite:           suite,
		Profiles:        profiles,
		Events:          events,
		DriftBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_drift_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"eventId":"evt_drift_sparse","type":"conversation_push","token":"secret","orgId":12345,"data":{"conversationId":456,"pushedAt":1781956800000}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/drift/12345/webhooks?webhook_id=drift_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Verification-Token", "secret")
		req.Header.Set("X-Drift-Event-Id", "evt_drift_sparse")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshConversationID != "456" {
		t.Fatalf("refresh calls=%d conversationID=%q", backfiller.refreshCalls, backfiller.refreshConversationID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "drift://conversation/456" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["drift_refresh_source"] != "webhook_sparse_conversation" ||
		suite.tickets[0].Properties["drift_webhook_event"] != "conversation_push" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 || store.runs[0].CursorTo != "drift-webhook-456" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestDriftWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderDrift
	store.integration.Settings = map[string]any{
		"workspace_id":             "12345",
		"drift_webhook_secret_ref": "cred_drift_webhook_1",
		"drift_webhook_id":         "drift_wh_1",
	}
	backfiller := &fakeDriftBackfiller{refreshErr: DriftRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 30 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:            store,
		Suite:           &fakeSuiteSink{},
		DriftBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_drift_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"eventId":"evt_drift_retry","type":"conversation_manual_push","token":"secret","orgId":12345,"data":{"conversationId":456,"pushedAt":1781956800000}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/drift/12345/webhooks?webhook_id=drift_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Verification-Token", "secret")
	req.Header.Set("X-Drift-Event-Id", "evt_drift_retry")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "30" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderDrift+":"+driftWebhookDeliveryID(req, "12345", "drift_wh_1", driftWebhookRaw(body), body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestDriftWebhookRejectsInvalidToken(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderDrift
	store.integration.Settings = map[string]any{
		"workspace_id":             "12345",
		"drift_webhook_secret_ref": "cred_drift_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_drift_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"eventId":"evt_drift_bad","type":"new_conversation","token":"wrong","orgId":12345,"data":{"id":456,"contact":{"email":"buyer@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/drift/12345/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Verification-Token", "wrong")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_webhook_token") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid token should not claim webhook: %+v", store.webhooks)
	}
}

func TestDriftWebhookRejectsWorkspaceMismatch(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderDrift
	store.integration.Settings = map[string]any{
		"workspace_id":             "12345",
		"drift_webhook_secret_ref": "cred_drift_webhook_1",
	}
	deps := &Deps{
		Repo:            store,
		Suite:           &fakeSuiteSink{},
		DriftBackfiller: &fakeDriftBackfiller{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_drift_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"eventId":"evt_drift_mismatch","type":"conversation_push","token":"secret","orgId":99999,"data":{"conversationId":456,"pushedAt":1781956800000}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/drift/12345/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Verification-Token", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "workspace_mismatch") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("mismatched workspace should not process, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestLiveChatWebhookVerifiesSecretAndIngestsTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderLiveChat
	store.integration.Settings = map[string]any{
		"account_id":                  "account_123",
		"livechat_webhook_secret_ref": "cred_livechat_webhook_1",
		"livechat_webhook_id":         "livechat_wh_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_livechat_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"webhook_id":"livechat_wh_1","secret_key":"secret","action":"incoming_event","organization_id":"account_123","payload":{"chat":{"id":"chat_123","users":[{"id":"agent_1","type":"agent","email":"agent@example.com","name":"Agent Ada"},{"id":"customer_1","type":"customer","email":"Buyer@Example.com","name":"Ada Buyer"}],"thread":{"id":"thread_1","created_at":"2026-06-20T12:00:00Z","events":[{"id":"event_msg_1","type":"message","text":"Can you help?","author_id":"customer_1","created_at":"2026-06-20T12:00:01Z"}]}}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/livechat/account_123/webhooks?webhook_id=livechat_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveChat-Event-Id", "delivery_1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "livechat://chat/chat_123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["livechat_webhook_id"] != "livechat_wh_1" || suite.tickets[0].Properties["livechat_webhook_event"] != "incoming_event" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	rawEvidence, _ := json.Marshal(suite.tickets[0].Properties["livechat_raw"])
	if strings.Contains(string(rawEvidence), "secret") {
		t.Fatalf("livechat raw evidence leaked secret: %s", string(rawEvidence))
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "livechat://event/event_msg_1" || suite.messages[0].BodyText != "Can you help?" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "livechat-webhook-chat_123" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderLiveChat+":"+liveChatWebhookDeliveryID(req, "account_123", "livechat_wh_1", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestLiveChatWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderLiveChat
	store.integration.Settings = map[string]any{
		"account_id":                  "account_123",
		"livechat_webhook_secret_ref": "cred_livechat_webhook_1",
		"livechat_webhook_id":         "livechat_wh_1",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_livechat_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"webhook_id":"livechat_wh_1","secret_key":"secret","action":"incoming_chat","organization_id":"account_123","payload":{"chat":{"id":"chat_replay","users":[{"id":"customer_1","type":"customer","email":"buyer@example.com","name":"Ada"}],"thread":{"id":"thread_1"}}}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/livechat/account_123/webhooks?webhook_id=livechat_wh_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-LiveChat-Event-Id", "delivery_replay")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestLiveChatWebhookRejectsInvalidSecret(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderLiveChat
	store.integration.Settings = map[string]any{
		"account_id":                  "account_123",
		"livechat_webhook_secret_ref": "cred_livechat_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_livechat_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"secret_key":"wrong","action":"incoming_chat","organization_id":"account_123","payload":{"chat":{"id":"chat_bad","users":[{"id":"customer_1","type":"customer","email":"buyer@example.com"}]}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/livechat/account_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_webhook_secret") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid secret should not claim webhook: %+v", store.webhooks)
	}
}

func TestLiveChatWebhookRejectsAccountMismatch(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderLiveChat
	store.integration.Settings = map[string]any{
		"account_id":                  "account_123",
		"livechat_webhook_secret_ref": "cred_livechat_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_livechat_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"secret_key":"secret","action":"incoming_chat","organization_id":"other_account","payload":{"chat":{"id":"chat_bad","users":[{"id":"customer_1","type":"customer","email":"buyer@example.com"}]}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/livechat/account_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "account_mismatch") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("mismatched webhook should not process, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestOlarkWebhookFormDataIngestsTranscript(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderOlark
	store.integration.Settings = map[string]any{
		"site_id":          "site_123",
		"olark_webhook_id": "olark_wh_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		Now:      func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	payload := `{"id":"tr_123","kind":"ChatTranscript","topic":"Order help","timestamp":"2026-06-20T12:00:00Z","tags":["vip"],"visitor":{"emailAddress":"Buyer@Example.com","fullName":"Ada Buyer","phoneNumber":"+15551230000"},"items":[{"kind":"MessageToOperator","body":"Where is my order?","nickname":"Ada","timestamp":"2026-06-20T12:01:00Z"},{"kind":"MessageToVisitor","body":"Checking that now","nickname":"Ops","timestamp":"2026-06-20T12:02:00Z"}]}`
	form := url.Values{}
	form.Set("event", "transcript.created")
	form.Set("data", payload)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/olark/site_123/webhooks/olark_wh_1", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "olark://transcript/tr_123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["olark_webhook_id"] != "olark_wh_1" || suite.tickets[0].Properties["olark_webhook_event"] != "transcript.created" {
		t.Fatalf("ticket properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 2 || suite.messages[0].BodyText != "Where is my order?" || suite.messages[1].Direction != "outbound" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 3 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "olark-webhook:tr_123" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderOlark+":"+olarkWebhookDeliveryID(req, "site_123", "olark_wh_1", "transcript.created", []byte(payload))] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestOlarkWebhookRequiresRouteToken(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderOlark
	store.integration.Settings = map[string]any{
		"site_id":          "site_123",
		"olark_webhook_id": "olark_wh_1",
	}
	deps := &Deps{Repo: store, Suite: &fakeSuiteSink{}}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/olark/site_123/webhooks", strings.NewReader(`{"id":"tr_123"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "missing_webhook_token") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("missing token should not record work: runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestOlarkWebhookReplayUsesDurableClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderOlark
	store.integration.Settings = map[string]any{
		"site_id":          "site_123",
		"olark_webhook_id": "olark_wh_1",
	}
	suite := &fakeSuiteSink{}
	deps := &Deps{Repo: store, Suite: suite, Events: &fakeEventSink{}}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := `{"id":"tr_replay","visitor":{"emailAddress":"buyer@example.com"},"items":[{"kind":"MessageToOperator","body":"Hello"}]}`
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/olark/site_123/webhooks?webhook_id=olark_wh_1", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d runs=%d", len(suite.tickets), len(store.runs))
	}
}

func TestKayakoWebhookRefreshesCase(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderKayako
	store.integration.Settings = map[string]any{
		"account_domain":    "acme.kayako.com",
		"kayako_webhook_id": "kayako_wh_1",
	}
	backfiller := &fakeKayakoBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "kayako://case/301",
			ConversationID: "301",
			Email:          "buyer@example.com",
			Subject:        "Kayako help",
		}},
		Messages: []MessageInput{{
			SourceID:       "kayako://case/301/post/701",
			ConversationID: "301",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:             store,
		Suite:            suite,
		Profiles:         profiles,
		Events:           events,
		KayakoBackfiller: backfiller,
		Now:              func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"case.updated","case":{"id":301}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/kayako/acme.kayako.com/webhooks/kayako_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Webhook-Delivery", "delivery_1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshCaseID != "301" {
		t.Fatalf("refresh calls=%d case=%q", backfiller.refreshCalls, backfiller.refreshCaseID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "kayako://case/301" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["kayako_webhook_id"] != "kayako_wh_1" || suite.tickets[0].Properties["kayako_webhook_event"] != "case.updated" {
		t.Fatalf("ticket properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 1 || suite.messages[0].Properties["kayako_webhook_id"] != "kayako_wh_1" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "kayako-webhook-301" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderKayako+":"+kayakoWebhookDeliveryID(req, "acme", "kayako_wh_1", "301", "case.updated", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestKayakoWebhookRequiresRouteToken(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderKayako
	store.integration.Settings = map[string]any{
		"account_domain":    "acme.kayako.com",
		"kayako_webhook_id": "kayako_wh_1",
	}
	deps := &Deps{Repo: store, Suite: &fakeSuiteSink{}, KayakoBackfiller: &fakeKayakoBackfiller{}}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/kayako/acme.kayako.com/webhooks", strings.NewReader(`{"case_id":301}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "missing_webhook_token") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("missing token should not record work: runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestKayakoWebhookReplayUsesDurableClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderKayako
	store.integration.Settings = map[string]any{
		"account_domain":    "acme.kayako.com",
		"kayako_webhook_id": "kayako_wh_1",
	}
	backfiller := &fakeKayakoBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "kayako://case/301",
			ConversationID: "301",
			Email:          "buyer@example.com",
		}},
	}}
	suite := &fakeSuiteSink{}
	deps := &Deps{Repo: store, Suite: suite, Events: &fakeEventSink{}, KayakoBackfiller: backfiller}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := `{"event":"case.updated","case_id":301}`
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/kayako/acme/webhooks?webhook_id=kayako_wh_1", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(store.runs) != 1 || backfiller.refreshCalls != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d runs=%d refresh=%d", len(suite.tickets), len(store.runs), backfiller.refreshCalls)
	}
}

func TestZohoDeskWebhookVerifiesJWTAndRefreshesTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := zohoDeskJWKSForTest(key, "zoho-key-1")
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	defer jwksServer.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderZohoDesk
	store.integration.Settings = map[string]any{
		"organization_id":      "org123",
		"zoho_desk_webhook_id": "zoho_wh_1",
		"api_base_url":         jwksServer.URL,
	}
	backfiller := &fakeZohoDeskBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "zoho-desk://ticket/7001",
			ConversationID: "7001",
			Email:          "buyer@example.com",
			Subject:        "Zoho Desk help",
		}},
		Messages: []MessageInput{{
			SourceID:       "zoho-desk://thread/9001",
			ConversationID: "7001",
			Email:          "buyer@example.com",
			BodyText:       "Thread body",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:               store,
		Suite:              suite,
		Profiles:           profiles,
		Events:             events,
		ZohoDeskBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"eventId":"evt_zoho_1","event":"ticket.update","ticket":{"id":"7001"}}`)
	token := signZohoDeskWebhookJWTTest(t, key, "zoho-key-1", map[string]any{
		"iss": "orgId:org123",
		"aud": "webhookId:zoho_wh_1",
		"jti": "jwt_zoho_1",
		"iat": now.Unix(),
		"exp": now.Add(time.Hour).Unix(),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zoho-desk/org123/webhooks?webhook_id=zoho_wh_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ZDesk-JWT", token)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var summary ZohoDeskWebhookSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Received != 1 || summary.Processed != 1 || summary.Ignored != 0 || summary.Duplicate != 0 {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshTicketID != "7001" {
		t.Fatalf("refresh calls=%d ticket=%q", backfiller.refreshCalls, backfiller.refreshTicketID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "zoho-desk://ticket/7001" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["zoho_desk_refresh_source"] != "webhook_sparse_ticket" ||
		suite.tickets[0].Properties["zoho_desk_webhook_event"] != "ticket.update" ||
		suite.tickets[0].Properties["zoho_desk_webhook_id"] != "zoho_wh_1" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "zoho-desk://thread/9001" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "zoho-desk-webhook-evt_zoho_1" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderZohoDesk+":zoho-desk:evt_zoho_1"] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}

	replayReq := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zoho-desk/org123/webhooks?webhook_id=zoho_wh_1", strings.NewReader(string(body)))
	replayReq.Header.Set("Content-Type", "application/json")
	replayReq.Header.Set("X-ZDesk-JWT", token)
	replayRec := httptest.NewRecorder()
	router.ServeHTTP(replayRec, replayReq)
	if replayRec.Code != http.StatusOK {
		t.Fatalf("replay status=%d body=%s", replayRec.Code, replayRec.Body.String())
	}
	var replaySummary ZohoDeskWebhookSummary
	if err := json.Unmarshal(replayRec.Body.Bytes(), &replaySummary); err != nil {
		t.Fatal(err)
	}
	if replaySummary.Received != 1 || replaySummary.Processed != 0 || replaySummary.Duplicate != 1 {
		t.Fatalf("replay summary=%+v", replaySummary)
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not refresh or record a run, calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
}

func TestZohoDeskWebhookRejectsInvalidJWT(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	wrongKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(zohoDeskJWKSForTest(key, "zoho-key-1"))
	}))
	defer jwksServer.Close()
	store := newFakeStore()
	store.integration.Provider = ProviderZohoDesk
	store.integration.Settings = map[string]any{
		"organization_id": "org123",
		"api_base_url":    jwksServer.URL,
	}
	deps := &Deps{
		Repo:               store,
		Suite:              &fakeSuiteSink{},
		ZohoDeskBackfiller: &fakeZohoDeskBackfiller{},
		Now:                func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"eventId":"evt_bad","event":"ticket.update","ticket":{"id":"7001"}}`)
	token := signZohoDeskWebhookJWTTest(t, wrongKey, "zoho-key-1", map[string]any{
		"iss": "orgId:org123",
		"iat": now.Unix(),
		"exp": now.Add(time.Hour).Unix(),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zoho-desk/org123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ZDesk-JWT", token)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("invalid JWT should not process, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestSalesforceServiceCloudWebhookVerifiesRelaySecretAndRefreshesCase(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforceServiceCloud
	store.integration.Settings = map[string]any{
		"instance_url":                                "https://acme.my.salesforce.com",
		"salesforce_service_cloud_webhook_id":         "sf_relay_1",
		"salesforce_service_cloud_webhook_secret_ref": "cred_sf_service_webhook_1",
	}
	backfiller := &fakeSalesforceServiceCloudBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "salesforce-service-cloud://case/500xx000001",
			ConversationID: "500xx000001",
			Email:          "buyer@example.com",
			Subject:        "Need Service Cloud help",
		}},
		Messages: []MessageInput{{
			SourceID:       "salesforce-service-cloud://case-comment/00a1",
			ConversationID: "500xx000001",
			Email:          "buyer@example.com",
			BodyText:       "Can you help?",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                             store,
		Suite:                            suite,
		Profiles:                         profiles,
		Events:                           events,
		SalesforceServiceCloudBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_sf_service_webhook_1": "relay-secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"eventId":"replay-42","payload":{"ChangeEventHeader":{"entityName":"Case","changeType":"UPDATE","recordIds":["500xx000001"],"commitNumber":12345},"Status":"Working"}}`)
	path := "/api/public/support-integrations/salesforce-service-cloud/" + url.PathEscape("acme.my.salesforce.com") + "/webhooks?webhook_id=sf_relay_1"
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer relay-secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var summary SalesforceServiceCloudCDCSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Received != 1 || summary.Processed != 1 || summary.Ignored != 0 || summary.Duplicate != 0 {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshCaseID != "500xx000001" {
		t.Fatalf("refresh calls=%d case=%q", backfiller.refreshCalls, backfiller.refreshCaseID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "salesforce-service-cloud://case/500xx000001" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["salesforce_refresh_source"] != "cdc_sparse_case" ||
		suite.tickets[0].Properties["salesforce_cdc_change_type"] != "UPDATE" ||
		suite.tickets[0].Properties["salesforce_service_cloud_webhook_id"] != "sf_relay_1" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "salesforce-service-cloud://case-comment/00a1" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "salesforce-service-cloud-cdc-replay-42" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderSalesforceServiceCloud+":salesforce-service-cloud:replay-42"] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}

	replayReq := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	replayReq.Header.Set("Content-Type", "application/json")
	replayReq.Header.Set("Authorization", "Bearer relay-secret")
	replayRec := httptest.NewRecorder()
	router.ServeHTTP(replayRec, replayReq)
	if replayRec.Code != http.StatusOK {
		t.Fatalf("replay status=%d body=%s", replayRec.Code, replayRec.Body.String())
	}
	var replaySummary SalesforceServiceCloudCDCSummary
	if err := json.Unmarshal(replayRec.Body.Bytes(), &replaySummary); err != nil {
		t.Fatal(err)
	}
	if replaySummary.Received != 1 || replaySummary.Processed != 0 || replaySummary.Duplicate != 1 {
		t.Fatalf("replay summary=%+v", replaySummary)
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not refresh or record a run, calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
}

func TestSalesforceServiceCloudWebhookRejectsInvalidRelaySecret(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforceServiceCloud
	store.integration.Settings = map[string]any{
		"instance_url": "https://acme.my.salesforce.com",
		"salesforce_service_cloud_webhook_secret_ref": "cred_sf_service_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_sf_service_webhook_1": "relay-secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"payload":{"ChangeEventHeader":{"entityName":"Case","changeType":"UPDATE","recordIds":["500xx000001"]}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/salesforce-service-cloud/acme.my.salesforce.com/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_webhook_secret") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("invalid secret should not process, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestHubSpotServiceHubWebhookVerifiesSignatureAndRefreshesTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderHubSpotServiceHub
	store.integration.Settings = map[string]any{
		"portal_id":          "123456",
		"hubspot_webhook_id": "hubspot_wh_1",
	}
	backfiller := &fakeHubSpotServiceHubBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "hubspot-service-hub://ticket/9001",
			ConversationID: "9001",
			Email:          "buyer@example.com",
			Subject:        "Help with order",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                        store,
		Suite:                       suite,
		Profiles:                    profiles,
		Events:                      events,
		HubSpotServiceHubBackfiller: backfiller,
		HubSpotWebhookClientSecret:  "secret",
		PublicBaseURL:               "https://app.postwave.test",
		Now:                         func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`[{"eventId":1001,"subscriptionType":"ticket.propertyChange","portalId":123456,"objectId":9001,"occurredAt":1781956800000,"propertyName":"hs_pipeline_stage"}]`)
	path := "/api/public/support-integrations/hubspot-service-hub/123456/webhooks?webhook_id=hubspot_wh_1"
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Request-Timestamp", timestamp)
	req.Header.Set("X-HubSpot-Signature-v3", signHubSpotServiceHubWebhookTest("secret", http.MethodPost, deps.PublicBaseURL+path, body, timestamp))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var summary HubSpotServiceHubWebhookSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Received != 1 || summary.Processed != 1 || summary.Ignored != 0 || summary.Duplicate != 0 {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshTicketID != "9001" {
		t.Fatalf("refresh calls=%d ticket=%q", backfiller.refreshCalls, backfiller.refreshTicketID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "hubspot-service-hub://ticket/9001" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["hubspot_refresh_source"] != "webhook_sparse_ticket" ||
		suite.tickets[0].Properties["hubspot_webhook_event"] != "ticket.propertyChange" ||
		suite.tickets[0].Properties["hubspot_webhook_property"] != "hs_pipeline_stage" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "hubspot-service-hub-webhook-1001" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderHubSpotServiceHub+":hubspot-service-hub:1001"] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestHubSpotServiceHubWebhookAppLevelRouteUsesPayloadPortal(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderHubSpotServiceHub
	store.integration.Settings = map[string]any{
		"portal_id":          "123456",
		"hubspot_webhook_id": "hubspot_wh_1",
	}
	backfiller := &fakeHubSpotServiceHubBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "hubspot-service-hub://ticket/9002",
			ConversationID: "9002",
			Email:          "buyer@example.com",
			Subject:        "App-level route",
		}},
	}}
	suite := &fakeSuiteSink{}
	deps := &Deps{
		Repo:                        store,
		Suite:                       suite,
		HubSpotServiceHubBackfiller: backfiller,
		HubSpotWebhookClientSecret:  "secret",
		PublicBaseURL:               "https://app.postwave.test",
		Now:                         func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`[{"eventId":1011,"subscriptionType":"ticket.creation","portalId":123456,"objectId":9002,"occurredAt":1781956800000}]`)
	path := "/api/public/support-integrations/hubspot-service-hub/webhooks?webhook_id=hubspot_wh_1"
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Request-Timestamp", timestamp)
	req.Header.Set("X-HubSpot-Signature-v3", signHubSpotServiceHubWebhookTest("secret", http.MethodPost, deps.PublicBaseURL+path, body, timestamp))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshTicketID != "9002" {
		t.Fatalf("refresh calls=%d ticket=%q", backfiller.refreshCalls, backfiller.refreshTicketID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].Properties["hubspot_webhook_event"] != "ticket.creation" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if store.webhooks[ProviderHubSpotServiceHub+":hubspot-service-hub:1011"] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestHubSpotServiceHubWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderHubSpotServiceHub
	store.integration.Settings = map[string]any{
		"portal_id":          "123456",
		"hubspot_webhook_id": "hubspot_wh_1",
	}
	backfiller := &fakeHubSpotServiceHubBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "hubspot-service-hub://ticket/9001",
			ConversationID: "9001",
			Email:          "buyer@example.com",
		}},
	}}
	suite := &fakeSuiteSink{}
	deps := &Deps{
		Repo:                        store,
		Suite:                       suite,
		HubSpotServiceHubBackfiller: backfiller,
		HubSpotWebhookClientSecret:  "secret",
		PublicBaseURL:               "https://app.postwave.test",
		Now:                         func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`[{"eventId":1002,"subscriptionType":"ticket.creation","portalId":123456,"objectId":9001,"occurredAt":1781956800000}]`)
	path := "/api/public/support-integrations/hubspot-service-hub/123456/webhooks?webhook_id=hubspot_wh_1"
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-HubSpot-Request-Timestamp", timestamp)
		req.Header.Set("X-HubSpot-Signature-v3", signHubSpotServiceHubWebhookTest("secret", http.MethodPost, deps.PublicBaseURL+path, body, timestamp))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || len(suite.tickets) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, refresh=%d tickets=%d runs=%d", backfiller.refreshCalls, len(suite.tickets), len(store.runs))
	}
}

func TestHubSpotServiceHubWebhookAppLevelRouteRejectsAmbiguousPortals(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderHubSpotServiceHub
	store.integration.Settings = map[string]any{"portal_id": "123456"}
	deps := &Deps{
		Repo:                        store,
		Suite:                       &fakeSuiteSink{},
		HubSpotServiceHubBackfiller: &fakeHubSpotServiceHubBackfiller{},
		HubSpotWebhookClientSecret:  "secret",
		PublicBaseURL:               "https://app.postwave.test",
		Now:                         func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`[
		{"eventId":1012,"subscriptionType":"ticket.creation","portalId":123456,"objectId":9001,"occurredAt":1781956800000},
		{"eventId":1013,"subscriptionType":"ticket.creation","portalId":654321,"objectId":9002,"occurredAt":1781956800000}
	]`)
	path := "/api/public/support-integrations/hubspot-service-hub/webhooks"
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Request-Timestamp", timestamp)
	req.Header.Set("X-HubSpot-Signature-v3", signHubSpotServiceHubWebhookTest("secret", http.MethodPost, deps.PublicBaseURL+path, body, timestamp))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "missing_portal_id") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("ambiguous portals should not process, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestHubSpotServiceHubWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderHubSpotServiceHub
	store.integration.Settings = map[string]any{
		"portal_id":          "123456",
		"hubspot_webhook_id": "hubspot_wh_1",
	}
	backfiller := &fakeHubSpotServiceHubBackfiller{refreshErr: HubSpotServiceHubRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 37 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:                        store,
		Suite:                       &fakeSuiteSink{},
		HubSpotServiceHubBackfiller: backfiller,
		HubSpotWebhookClientSecret:  "secret",
		PublicBaseURL:               "https://app.postwave.test",
		Now:                         func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`[{"eventId":1003,"subscriptionType":"ticket.propertyChange","portalId":123456,"objectId":9001,"occurredAt":1781956800000}]`)
	path := "/api/public/support-integrations/hubspot-service-hub/123456/webhooks?webhook_id=hubspot_wh_1"
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Request-Timestamp", timestamp)
	req.Header.Set("X-HubSpot-Signature-v3", signHubSpotServiceHubWebhookTest("secret", http.MethodPost, deps.PublicBaseURL+path, body, timestamp))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "37" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderHubSpotServiceHub+":hubspot-service-hub:1003"]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestHubSpotServiceHubWebhookRejectsInvalidSignature(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderHubSpotServiceHub
	store.integration.Settings = map[string]any{
		"portal_id": "123456",
	}
	deps := &Deps{
		Repo:                        store,
		Suite:                       &fakeSuiteSink{},
		HubSpotWebhookClientSecret:  "secret",
		PublicBaseURL:               "https://app.postwave.test",
		HubSpotServiceHubBackfiller: &fakeHubSpotServiceHubBackfiller{},
		Now:                         func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`[{"eventId":1004,"subscriptionType":"ticket.creation","portalId":123456,"objectId":9001,"occurredAt":1781956800000}]`)
	path := "/api/public/support-integrations/hubspot-service-hub/123456/webhooks"
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Request-Timestamp", timestamp)
	req.Header.Set("X-HubSpot-Signature-v3", signHubSpotServiceHubWebhookTest("wrong", http.MethodPost, deps.PublicBaseURL+path, body, timestamp))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("invalid signature should not process, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestHubSpotServiceHubWebhookRejectsPortalMismatch(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderHubSpotServiceHub
	store.integration.Settings = map[string]any{
		"portal_id": "123456",
	}
	deps := &Deps{
		Repo:                        store,
		Suite:                       &fakeSuiteSink{},
		HubSpotWebhookClientSecret:  "secret",
		PublicBaseURL:               "https://app.postwave.test",
		HubSpotServiceHubBackfiller: &fakeHubSpotServiceHubBackfiller{},
		Now:                         func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`[{"eventId":1005,"subscriptionType":"ticket.creation","portalId":654321,"objectId":9001,"occurredAt":1781956800000}]`)
	path := "/api/public/support-integrations/hubspot-service-hub/123456/webhooks"
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Request-Timestamp", timestamp)
	req.Header.Set("X-HubSpot-Signature-v3", signHubSpotServiceHubWebhookTest("secret", http.MethodPost, deps.PublicBaseURL+path, body, timestamp))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "portal_mismatch") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("mismatched portal should not process, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestFreshdeskWebhookAuthenticatesAndIngestsTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderFreshdesk
	store.integration.Settings = map[string]any{
		"account_domain":       "acme.freshdesk.com",
		"webhook_secret_ref":   "cred_freshdesk_webhook_1",
		"freshdesk_webhook_id": "auto_123",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_freshdesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket.updated","ticket":{"id":77,"subject":"Need help","status":2,"priority":3,"tags":["vip"],"requester_id":9,"product_id":12,"updated_at":"2026-06-20T12:00:00Z","requester":{"id":9,"name":"Ada Buyer","email":"Buyer@Example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/freshdesk/acme.freshdesk.com/webhooks?webhook_id=auto_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Freshdesk-Webhook-Secret", "secret")
	req.Header.Set("X-Freshdesk-Event-Id", "evt_123")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "freshdesk://ticket/77" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["freshdesk_webhook_id"] != "auto_123" || suite.tickets[0].Properties["freshdesk_webhook_event"] != "ticket.updated" {
		t.Fatalf("properties=%+v", suite.tickets[0].Properties)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "freshdesk-webhook-77" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderFreshdesk+":"+freshdeskWebhookDeliveryID(req, "acme", "auto_123", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestFreshdeskWebhookReplayUsesDurableClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFreshdesk
	store.integration.Settings = map[string]any{
		"account_domain":       "acme.freshdesk.com",
		"webhook_secret_ref":   "cred_freshdesk_webhook_1",
		"freshdesk_webhook_id": "auto_123",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_freshdesk_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"event":"ticket.updated","ticket":{"id":77,"subject":"Need help","status":2,"requester":{"email":"buyer@example.com"}}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/freshdesk/acme/webhooks?webhook_id=auto_123", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer secret")
		req.Header.Set("X-Freshdesk-Event-Id", "evt_replay")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestFreshdeskWebhookSparseTicketRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFreshdesk
	store.integration.Settings = map[string]any{
		"account_domain":       "acme.freshdesk.com",
		"webhook_secret_ref":   "cred_freshdesk_webhook_1",
		"freshdesk_webhook_id": "auto_123",
	}
	backfiller := &fakeFreshdeskBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "freshdesk://ticket/77",
			ConversationID: "77",
			Email:          "buyer@example.com",
			Subject:        "Need help",
			Status:         "open",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                store,
		Suite:               suite,
		Profiles:            profiles,
		Events:              events,
		FreshdeskBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_freshdesk_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket.updated","ticket_id":77}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/freshdesk/acme/webhooks?webhook_id=auto_123", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Freshdesk-Webhook-Secret", "secret")
		req.Header.Set("X-Freshdesk-Event-Id", "evt_sparse")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshTicketID != "77" {
		t.Fatalf("refresh calls=%d ticketID=%q", backfiller.refreshCalls, backfiller.refreshTicketID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "freshdesk://ticket/77" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 || store.runs[0].CursorTo != "freshdesk-webhook-77" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestFreshdeskWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFreshdesk
	store.integration.Settings = map[string]any{
		"account_domain":       "acme.freshdesk.com",
		"webhook_secret_ref":   "cred_freshdesk_webhook_1",
		"freshdesk_webhook_id": "auto_123",
	}
	backfiller := &fakeFreshdeskBackfiller{refreshErr: FreshdeskRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 35 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:                store,
		Suite:               &fakeSuiteSink{},
		FreshdeskBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_freshdesk_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket.updated","ticket_id":77}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/freshdesk/acme/webhooks?webhook_id=auto_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Freshdesk-Webhook-Secret", "secret")
	req.Header.Set("X-Freshdesk-Event-Id", "evt_retry")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "35" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderFreshdesk+":"+freshdeskWebhookDeliveryID(req, "acme", "auto_123", body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestFreshdeskWebhookRejectsInvalidAuth(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFreshdesk
	store.integration.Settings = map[string]any{
		"account_domain":     "acme.freshdesk.com",
		"webhook_secret_ref": "cred_freshdesk_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_freshdesk_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket.updated","ticket":{"id":77,"requester":{"email":"buyer@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/freshdesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Freshdesk-Webhook-Secret", "wrong")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid auth should not claim webhook: %+v", store.webhooks)
	}
}

func TestZendeskWebhookVerifiesSignatureAndIngestsTicket(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket.updated","ticket":{"id":123,"subject":"Shipping help","status":"open","priority":"high","tags":["vip"],"updated_at":"2026-06-20T12:00:00Z","requester":{"email":"Buyer@Example.com","name":"Ada Buyer"}},"comment":{"id":456,"body":"Need help","author":{"name":"Ada Buyer","role":"end-user"},"created_at":"2026-06-20T12:00:01Z"},"trigger":{"id":"tr_1","title":"Ticket updated"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
	req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
	req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_123")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "zendesk://ticket/123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "zendesk://comment/456" || suite.messages[0].BodyText != "Need help" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "zendesk-webhook-wh_123" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderZendesk+":"+zendeskWebhookDeliveryID(req, "acme", "wh_123", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestZendeskWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"event":"ticket.updated","ticket":{"id":123,"subject":"Shipping help","status":"open","requester":{"email":"buyer@example.com"}}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
		req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
		req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
		req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_replay")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestZendeskWebhookSparseTicketRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	backfiller := &fakeZendeskBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "zendesk://ticket/123",
			ConversationID: "123",
			Email:          "buyer@example.com",
			Subject:        "Shipping help",
			Status:         "open",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:              store,
		Suite:             suite,
		Profiles:          profiles,
		Events:            events,
		ZendeskBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket.updated","ticket":{"id":123},"comment":{"id":456,"body":"Need help","author":{"name":"Ada Buyer","role":"end-user"},"created_at":"2026-06-20T12:00:01Z"}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
		req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
		req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
		req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_sparse")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshTicketID != "123" {
		t.Fatalf("refresh calls=%d ticketID=%q", backfiller.refreshCalls, backfiller.refreshTicketID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "zendesk://ticket/123" || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "zendesk://comment/456" || suite.messages[0].BodyText != "Need help" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 || len(store.runs) != 1 || store.runs[0].CursorTo != "zendesk-webhook-wh_123" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestZendeskWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	backfiller := &fakeZendeskBackfiller{refreshErr: ZendeskRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 30 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:              store,
		Suite:             &fakeSuiteSink{},
		ZendeskBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket.updated","ticket":{"id":123}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
	req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
	req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_sparse_retry")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "30" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderZendesk+":"+zendeskWebhookDeliveryID(req, "acme", "wh_123", body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestZendeskWebhookSparseRefreshNotFoundMarksProcessed(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	backfiller := &fakeZendeskBackfiller{refreshErr: ZendeskRESTError{StatusCode: http.StatusNotFound, Snippet: "not found"}}
	deps := &Deps{
		Repo:              store,
		Suite:             &fakeSuiteSink{},
		ZendeskBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket.deleted","ticket_id":123}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
	req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
	req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_sparse_missing")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ticket_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderZendesk+":"+zendeskWebhookDeliveryID(req, "acme", "wh_123", body)]; got != WebhookProcessed {
		t.Fatalf("webhook should be processed, state=%+v", store.webhooks)
	}
}

func TestZendeskWebhookInProgressClaimReturnsRetry(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	body := []byte(`{"event":"ticket.updated","ticket":{"id":123,"requester":{"email":"buyer@example.com"}}}`)
	presetReq := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	presetReq.Header.Set("Content-Type", "application/json")
	presetReq.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_busy")
	store.webhooks = map[string]WebhookClaim{ProviderZendesk + ":" + zendeskWebhookDeliveryID(presetReq, "acme", "wh_123", body): WebhookInProgress}
	suite := &fakeSuiteSink{}
	deps := &Deps{
		Repo:  store,
		Suite: suite,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
	req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
	req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_busy")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if len(suite.tickets) != 0 || len(store.runs) != 0 {
		t.Fatalf("in-progress replay should not ingest, tickets=%+v runs=%+v", suite.tickets, store.runs)
	}
}

func TestZendeskWebhookRecordRunFailureMarksWebhookFailed(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	store.recordErr = errors.New("record run failed")
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"event":"ticket.updated","ticket":{"id":123,"requester":{"email":"buyer@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
	req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
	req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_record")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got, ok := store.webhooks[ProviderZendesk+":"+zendeskWebhookDeliveryID(req, "acme", "wh_123", body)]; !ok || got != "" {
		t.Fatalf("webhook should be marked retryable failed, state=%+v", store.webhooks)
	}
}

func TestZendeskWebhookIgnoredPayloadMarksProcessed(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"event":"ticket.updated","ticket":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
	req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
	req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_ignored")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("ignored payload should not record run: %+v", store.runs)
	}
	if store.webhooks[ProviderZendesk+":"+zendeskWebhookDeliveryID(req, "acme", "wh_123", body)] != WebhookProcessed {
		t.Fatalf("ignored payload should be marked processed, state=%+v", store.webhooks)
	}
}

func TestZendeskWebhookDeliveryIDPrefersInvocationID(t *testing.T) {
	body := []byte(`{"ticket":{"id":123}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Invocation-Id", "inv_123")

	got := zendeskWebhookDeliveryID(req, "acme", "wh_123", body)
	if got != "subdomain:acme:webhook:wh_123:delivery:inv_123" {
		t.Fatalf("delivery id=%q", got)
	}
	fallback := zendeskWebhookDeliveryID(nil, "acme", "wh_123", body)
	if !strings.HasPrefix(fallback, "subdomain:acme:webhook:wh_123:delivery:body:") || fallback == got {
		t.Fatalf("fallback delivery id=%q", fallback)
	}
}

func TestZendeskWebhookRejectsInvalidSignature(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"ticket":{"id":123,"requester":{"email":"buyer@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("wrong-secret", body, "2026-06-20T12:00:00Z"))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid signature should not claim webhook: %+v", store.webhooks)
	}
}

func TestZendeskWebhookRejectsMissingWebhookIDForScopedIntegration(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	store.integration.Settings["zendesk_webhook_id"] = "wh_123"
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"ticket":{"id":123,"requester":{"email":"buyer@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("missing webhook id should not ingest or claim, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestZendeskWebhookRejectsSuppliedWebhookIDForUnscopedIntegration(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_zendesk_webhook_1"
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_zendesk_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"ticket":{"id":123,"requester":{"email":"buyer@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/zendesk/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zendesk-Webhook-ID", "wh_123")
	req.Header.Set("X-Zendesk-Webhook-Signature-Timestamp", "2026-06-20T12:00:00Z")
	req.Header.Set("X-Zendesk-Webhook-Signature", signZendeskWebhookTest("secret", body, "2026-06-20T12:00:00Z"))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("unexpected work for mismatched webhook id, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestIntercomWebhookVerifiesSignatureAndIngestsConversation(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderIntercom
	store.integration.Settings = map[string]any{
		"workspace_id":       "workspace_123",
		"webhook_secret_ref": "cred_intercom_webhook_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_intercom_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"notif_123","topic":"conversation.user.created","data":{"item":{"id":"conv_123","state":"open","priority":"priority","title":"Need help","created_at":1718877500,"updated_at":1718877600,"source":{"body":"<p>Hello support</p>","author":{"type":"user","email":"User@Example.com","name":"User One"}},"conversation_parts":{"conversation_parts":[{"id":"part_123","part_type":"comment","body":"<p>Agent reply</p>","created_at":1718877700,"author":{"type":"admin","id":"admin_1","name":"Agent One"}}]}}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/intercom/workspace_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Signature", signIntercomWebhookTest("secret", body))
	req.Header.Set("X-Intercom-Request-Id", "req_123")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "intercom://conversation/conv_123" || suite.tickets[0].Email != "user@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(suite.messages) != 2 {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if suite.messages[0].SourceID != "intercom://conversation/conv_123/source" || suite.messages[0].BodyText != "Hello support" || suite.messages[0].Direction != "inbound" {
		t.Fatalf("source message=%+v", suite.messages[0])
	}
	if suite.messages[1].SourceID != "intercom://conversation_part/part_123" || suite.messages[1].BodyText != "Agent reply" || suite.messages[1].Direction != "outbound" || suite.messages[1].Properties["intercom_webhook_event"] != "conversation.user.created" {
		t.Fatalf("part message=%+v", suite.messages[1])
	}
	if len(profiles.tickets) != 1 || len(events.events) != 3 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "intercom-webhook-notif_123" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderIntercom+":"+intercomWebhookDeliveryID(req, "workspace_123", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestIntercomWebhookReplayUsesDurableClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderIntercom
	store.integration.Settings = map[string]any{
		"workspace_id":       "workspace_123",
		"webhook_secret_ref": "cred_intercom_webhook_1",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_intercom_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"id":"notif_replay","topic":"conversation.user.created","data":{"item":{"id":"conv_123","state":"open","source":{"author":{"type":"user","email":"user@example.com"}}}}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/intercom/workspace_123/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Hub-Signature", signIntercomWebhookTest("secret", body))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestIntercomWebhookSparseConversationRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderIntercom
	store.integration.Settings = map[string]any{
		"workspace_id":       "workspace_123",
		"webhook_secret_ref": "cred_intercom_webhook_1",
	}
	backfiller := &fakeIntercomBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "intercom://conversation/conv_123",
			ConversationID: "conv_123",
			Email:          "user@example.com",
			Subject:        "Need help",
			Status:         "open",
		}},
		Messages: []MessageInput{{
			SourceID:       "intercom://conversation_part/part_sparse",
			ConversationID: "conv_123",
			Email:          "user@example.com",
			Subject:        "Need help",
			Direction:      "outbound",
			SenderType:     "agent",
			BodyText:       "Sparse reply",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:               store,
		Suite:              suite,
		Profiles:           profiles,
		Events:             events,
		IntercomBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_intercom_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"notif_sparse","topic":"conversation.admin.replied","data":{"item":{"id":"conv_123"}}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/intercom/workspace_123/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Hub-Signature", signIntercomWebhookTest("secret", body))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshConversationID != "conv_123" {
		t.Fatalf("refresh calls=%d conversationID=%q", backfiller.refreshCalls, backfiller.refreshConversationID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "intercom://conversation/conv_123" || suite.tickets[0].Email != "user@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "intercom://conversation_part/part_sparse" || suite.messages[0].Properties["intercom_refresh_source"] != "webhook_sparse_conversation" || suite.messages[0].Properties["intercom_notification_id"] != "notif_sparse" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 || len(store.runs) != 1 || store.runs[0].CursorTo != "intercom-webhook-conv_123" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestIntercomWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderIntercom
	store.integration.Settings = map[string]any{
		"workspace_id":       "workspace_123",
		"webhook_secret_ref": "cred_intercom_webhook_1",
	}
	backfiller := &fakeIntercomBackfiller{refreshErr: IntercomRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 40 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:               store,
		Suite:              &fakeSuiteSink{},
		IntercomBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_intercom_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"notif_sparse_retry","topic":"conversation.admin.replied","data":{"item":{"id":"conv_123"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/intercom/workspace_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Signature", signIntercomWebhookTest("secret", body))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "40" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderIntercom+":"+intercomWebhookDeliveryID(req, "workspace_123", body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestIntercomWebhookRejectsInvalidSignature(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderIntercom
	store.integration.Settings = map[string]any{
		"workspace_id":       "workspace_123",
		"webhook_secret_ref": "cred_intercom_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_intercom_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"notif_123","topic":"conversation.user.created","data":{"item":{"id":"conv_123","source":{"author":{"type":"user","email":"user@example.com"}}}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/intercom/workspace_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Signature", signIntercomWebhookTest("wrong-secret", body))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid signature should not claim webhook: %+v", store.webhooks)
	}
}

func TestHelpScoutWebhookVerifiesSignatureAndIngestsConversationMessage(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderHelpScout
	store.integration.Settings = map[string]any{
		"mailbox_id":            "7",
		"webhook_secret_ref":    "cred_helpscout_webhook_1",
		"help_scout_webhook_id": "wh_hs_1",
		"help_scout_mailbox_id": "7",
		"provider_mailbox_id":   "7",
		"provider_webhook_id":   "wh_hs_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_helpscout_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":91,"number":1209,"mailboxId":7,"subject":"Where is it?","status":"active","primaryCustomer":{"id":501,"email":"Thread@Example.com","first":"Thread","last":"Customer"},"_embedded":{"threads":[{"id":1001,"type":"customer","body":"Customer question","createdAt":"2026-06-20T10:00:00Z","customer":{"id":501,"type":"customer","email":"Thread@Example.com","first":"Thread","last":"Customer"},"createdBy":{"id":501,"type":"customer","email":"Thread@Example.com","first":"Thread","last":"Customer"},"source":{"type":"email","via":"customer"}}]}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/help-scout/7/webhooks?webhook_id=wh_hs_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HelpScout-Signature", signHelpScoutWebhookTest("secret", body))
	req.Header.Set("X-HelpScout-Event", "convo.customer.reply.created")
	req.Header.Set("X-HelpScout-Webhook-Id", "wh_hs_1")
	req.Header.Set("X-HelpScout-Delivery-Id", "delivery_1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "help-scout://conversation/91" || suite.tickets[0].Email != "thread@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "help-scout://thread/1001" || suite.messages[0].BodyText != "Customer question" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "help-scout-webhook-wh_hs_1" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderHelpScout+":"+helpScoutWebhookDeliveryID(req, "7", "wh_hs_1", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestHelpScoutWebhookReplayUsesDurableClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderHelpScout
	store.integration.Settings = map[string]any{
		"mailbox_id":            "7",
		"webhook_secret_ref":    "cred_helpscout_webhook_1",
		"help_scout_webhook_id": "wh_hs_1",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_helpscout_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"id":91,"subject":"Where is it?","status":"active","primaryCustomer":{"email":"thread@example.com"}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/help-scout/7/webhooks?webhook_id=wh_hs_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-HelpScout-Signature", signHelpScoutWebhookTest("secret", body))
		req.Header.Set("X-HelpScout-Event", "convo.status")
		req.Header.Set("X-HelpScout-Delivery-Id", "delivery_replay")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestHelpScoutWebhookSparseConversationRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderHelpScout
	store.integration.Settings = map[string]any{
		"mailbox_id":            "7",
		"webhook_secret_ref":    "cred_helpscout_webhook_1",
		"help_scout_webhook_id": "wh_hs_1",
	}
	backfiller := &fakeHelpScoutBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "help-scout://conversation/91",
			ConversationID: "91",
			Email:          "thread@example.com",
			RequesterName:  "Thread Customer",
			Subject:        "Where is it?",
			Status:         "active",
		}},
		Messages: []MessageInput{{
			SourceID:       "help-scout://thread/1001",
			ConversationID: "91",
			Email:          "thread@example.com",
			BodyText:       "Customer question",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                store,
		Suite:               suite,
		Profiles:            profiles,
		Events:              events,
		HelpScoutBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_helpscout_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"convo.status","conversation":{"id":91}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/help-scout/7/webhooks?webhook_id=wh_hs_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-HelpScout-Signature", signHelpScoutWebhookTest("secret", body))
		req.Header.Set("X-HelpScout-Event", "convo.status")
		req.Header.Set("X-HelpScout-Delivery-Id", "delivery_sparse")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshConversationID != "91" {
		t.Fatalf("refresh calls=%d conversationID=%q", backfiller.refreshCalls, backfiller.refreshConversationID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "help-scout://conversation/91" || suite.tickets[0].Email != "thread@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "help-scout://thread/1001" || suite.messages[0].BodyText != "Customer question" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 || len(store.runs) != 1 || store.runs[0].CursorTo != "help-scout-webhook-wh_hs_1" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestHelpScoutWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderHelpScout
	store.integration.Settings = map[string]any{
		"mailbox_id":            "7",
		"webhook_secret_ref":    "cred_helpscout_webhook_1",
		"help_scout_webhook_id": "wh_hs_1",
	}
	backfiller := &fakeHelpScoutBackfiller{refreshErr: HelpScoutRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 75 * time.Second, Snippet: "rate limited"}}
	deps := &Deps{
		Repo:                store,
		Suite:               &fakeSuiteSink{},
		HelpScoutBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_helpscout_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"convo.status","conversation":{"id":91}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/help-scout/7/webhooks?webhook_id=wh_hs_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HelpScout-Signature", signHelpScoutWebhookTest("secret", body))
	req.Header.Set("X-HelpScout-Event", "convo.status")
	req.Header.Set("X-HelpScout-Delivery-Id", "delivery_sparse_retry")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "75" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderHelpScout+":"+helpScoutWebhookDeliveryID(req, "7", "wh_hs_1", body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
}

func TestHelpScoutWebhookRejectsInvalidSignature(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderHelpScout
	store.integration.Settings = map[string]any{
		"mailbox_id":         "7",
		"webhook_secret_ref": "cred_helpscout_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_helpscout_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":91,"primaryCustomer":{"email":"thread@example.com"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/help-scout/7/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HelpScout-Signature", signHelpScoutWebhookTest("wrong-secret", body))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
	if len(store.webhooks) != 0 {
		t.Fatalf("invalid signature should not claim webhook: %+v", store.webhooks)
	}
}

func TestVerifyGorgiasWebhookAuthAcceptsHMAC(t *testing.T) {
	body := []byte(`{"ticket":{"id":501}}`)
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write(body)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Hmac-Sha256", hex.EncodeToString(mac.Sum(nil)))

	if err := VerifyGorgiasWebhookAuth("secret", body, req); err != nil {
		t.Fatalf("valid HMAC failed: %v", err)
	}
	req.Header.Set("X-Gorgias-Hmac-Sha256", "bad")
	if err := VerifyGorgiasWebhookAuth("secret", body, req); !errors.Is(err, ErrInvalidGorgiasWebhookSignature) {
		t.Fatalf("invalid HMAC error=%v", err)
	}
}

func TestGorgiasWebhookVerifiesSecretAndIngestsTicketMessage(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
		"commerce_integration_id":     "commerce_1",
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	commerce := &fakeGorgiasCommerceResolver{}
	deps := &Deps{
		Repo:     store,
		Suite:    suite,
		Profiles: profiles,
		Events:   events,
		Commerce: commerce,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket-message-created","ticket":{"id":501,"subject":"Where is my order","status":"open","priority":"normal","tags":[{"name":"shipping"}],"updated_datetime":"2026-06-20T12:00:00Z","customer":{"email":"Ada@Example.com","name":"Ada L","integrations":{"shopify":{"customer":{"id":"gid://shopify/Customer/88"},"orders":[{"id":"gid://shopify/Order/1001","name":"#1001","financial_status":"paid","fulfillment_status":"fulfilled","total_price":"125.50","currency":"USD"}]},"recharge":{"subscriptions":[{"id":"sub_123","status":"active"}]}}}},"message":{"id":900,"body_text":"Need help","from_agent":false,"sender":{"name":"Ada L"},"created_datetime":"2026-06-20T12:00:01Z"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "gorgias://ticket/501" || suite.tickets[0].Email != "ada@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["shopify_order_id"] != "gid://shopify/Order/1001" ||
		suite.tickets[0].Properties["order_number"] != "#1001" ||
		suite.tickets[0].Properties["order_total"] != "125.50" ||
		suite.tickets[0].Properties["recharge_subscription_id"] != "sub_123" {
		t.Fatalf("ticket commerce properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "gorgias://message/900" || suite.messages[0].BodyText != "Need help" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if suite.messages[0].Properties["shopify_order_id"] != "gid://shopify/Order/1001" ||
		suite.messages[0].Properties["recharge_subscription_id"] != "sub_123" {
		t.Fatalf("message commerce properties=%+v", suite.messages[0].Properties)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 {
		t.Fatalf("profiles=%+v events=%+v", profiles.tickets, events.events)
	}
	if commerce.calls != 2 || settingString(commerce.integration.Settings, "commerce_integration_id") != "commerce_1" {
		t.Fatalf("commerce resolver calls=%d integration=%+v", commerce.calls, commerce.integration)
	}
	if events.events[0].Properties["resolved_order_id"] != "order_uuid_1" ||
		events.events[1].Properties["resolved_customer_id"] != "customer_uuid_1" ||
		suite.messages[0].Properties["resolved_product_id"] != "product_uuid_1" {
		t.Fatalf("event commerce properties=%+v", events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "gorgias-webhook-http_123" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderGorgias+":"+gorgiasWebhookDeliveryID("acme.gorgias.com", "http_123", body)] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestGorgiasWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	suite := &fakeSuiteSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Suite:  suite,
		Events: events,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"event":"ticket-updated","ticket":{"id":501,"status":"open","customer":{"email":"ada@example.com"}}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(suite.tickets) != 1 || len(events.events) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, tickets=%d events=%d runs=%d", len(suite.tickets), len(events.events), len(store.runs))
	}
}

func TestGorgiasWebhookSparseTicketRefreshesAndReplaysWithoutRefetch(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	backfiller := &fakeGorgiasBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "gorgias://ticket/501",
			ConversationID: "501",
			Email:          "ada@example.com",
			RequesterName:  "Ada L",
			Subject:        "Where is my order",
			Status:         "open",
		}},
	}}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:              store,
		Suite:             suite,
		Profiles:          profiles,
		Events:            events,
		GorgiasBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
		Now: func() time.Time { return now },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket-message-created","ticket":{"id":501,"customer":{"integrations":{"shopify":{"orders":[{"id":"gid://shopify/Order/900","order_number":"900","status":"open","total_price":"42.00","currency":"USD"}]}}}},"message":{"id":900,"body_text":"Need help","from_agent":false,"sender":{"name":"Ada L"},"created_datetime":"2026-06-20T12:00:01Z"}}`)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshTicketID != "501" {
		t.Fatalf("refresh calls=%d ticketID=%q", backfiller.refreshCalls, backfiller.refreshTicketID)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "gorgias://ticket/501" || suite.tickets[0].Email != "ada@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if suite.tickets[0].Properties["shopify_order_id"] != "gid://shopify/Order/900" ||
		suite.tickets[0].Properties["order_total"] != "42.00" {
		t.Fatalf("sparse refresh ticket commerce properties=%+v", suite.tickets[0].Properties)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "gorgias://message/900" || suite.messages[0].BodyText != "Need help" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if suite.messages[0].Properties["shopify_order_id"] != "gid://shopify/Order/900" {
		t.Fatalf("sparse refresh message commerce properties=%+v", suite.messages[0].Properties)
	}
	if len(profiles.tickets) != 1 || len(events.events) != 2 || len(store.runs) != 1 || store.runs[0].CursorTo != "gorgias-webhook-http_123" {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.tickets, events.events, store.runs)
	}
}

func TestGorgiasWebhookSparseTicketRefreshPreservesLargeNumericTicketID(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	const ticketID = "9007199254740993"
	backfiller := &fakeGorgiasBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Tickets: []TicketInput{{
			SourceID:       "gorgias://ticket/" + ticketID,
			ConversationID: ticketID,
			Email:          "ada@example.com",
			Status:         "open",
		}},
	}}
	deps := &Deps{
		Repo:              store,
		Suite:             &fakeSuiteSink{},
		GorgiasBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket-updated","ticket":{"id":9007199254740993}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || backfiller.refreshTicketID != ticketID {
		t.Fatalf("refresh calls=%d ticketID=%q", backfiller.refreshCalls, backfiller.refreshTicketID)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != "gorgias-webhook-http_123" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestGorgiasWebhookSparseRefreshFailureMarksRetryable(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	backfiller := &fakeGorgiasBackfiller{refreshErr: GorgiasRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 45 * time.Second, Snippet: "rate limited"}}
	suite := &fakeSuiteSink{}
	deps := &Deps{
		Repo:              store,
		Suite:             suite,
		GorgiasBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket-updated","ticket":{"id":501}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "45" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if got := store.webhooks[ProviderGorgias+":"+gorgiasWebhookDeliveryID("acme.gorgias.com", "http_123", body)]; got != "" {
		t.Fatalf("webhook should be retryable failed, state=%+v", store.webhooks)
	}
	backfiller.refreshErr = nil
	backfiller.refreshReq = SyncRequest{Tickets: []TicketInput{{
		SourceID:       "gorgias://ticket/501",
		ConversationID: "501",
		Email:          "ada@example.com",
		Status:         "open",
	}}}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshCalls != 2 || len(suite.tickets) != 1 || len(store.runs) != 1 {
		t.Fatalf("refresh calls=%d tickets=%+v runs=%+v", backfiller.refreshCalls, suite.tickets, store.runs)
	}
}

func TestGorgiasWebhookSparseRefreshNotFoundMarksProcessed(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	backfiller := &fakeGorgiasBackfiller{refreshErr: GorgiasRESTError{StatusCode: http.StatusNotFound, Snippet: "not found"}}
	deps := &Deps{
		Repo:              store,
		Suite:             &fakeSuiteSink{},
		GorgiasBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"ticket-deleted","ticket_id":501}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ticket_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshCalls != 1 || len(store.runs) != 0 {
		t.Fatalf("refresh calls=%d runs=%+v", backfiller.refreshCalls, store.runs)
	}
	if got := store.webhooks[ProviderGorgias+":"+gorgiasWebhookDeliveryID("acme.gorgias.com", "http_123", body)]; got != WebhookProcessed {
		t.Fatalf("webhook should be processed, state=%+v", store.webhooks)
	}
}

func TestGorgiasWebhookInProgressClaimReturnsRetry(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	body := []byte(`{"event":"ticket-updated","ticket":{"id":501,"customer":{"email":"ada@example.com"}}}`)
	store.webhooks = map[string]WebhookClaim{ProviderGorgias + ":" + gorgiasWebhookDeliveryID("acme.gorgias.com", "http_123", body): WebhookInProgress}
	suite := &fakeSuiteSink{}
	deps := &Deps{
		Repo:  store,
		Suite: suite,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if len(suite.tickets) != 0 || len(store.runs) != 0 {
		t.Fatalf("in-progress replay should not ingest, tickets=%+v runs=%+v", suite.tickets, store.runs)
	}
}

func TestGorgiasWebhookRecordRunFailureMarksWebhookFailed(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	store.recordErr = errors.New("record run failed")
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"event":"ticket-updated","ticket":{"id":501,"customer":{"email":"ada@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got, ok := store.webhooks[ProviderGorgias+":"+gorgiasWebhookDeliveryID("acme.gorgias.com", "http_123", body)]; !ok || got != "" {
		t.Fatalf("webhook should be marked retryable failed, state=%+v", store.webhooks)
	}
}

func TestGorgiasWebhookIgnoredPayloadMarksProcessed(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	body := []byte(`{"event":"ticket-updated","ticket":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("ignored payload should not record run: %+v", store.runs)
	}
	if store.webhooks[ProviderGorgias+":"+gorgiasWebhookDeliveryID("acme.gorgias.com", "http_123", body)] != WebhookProcessed {
		t.Fatalf("ignored payload should be marked processed, state=%+v", store.webhooks)
	}
}

func TestGorgiasWebhookRejectsInvalidSecret(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":     "acme",
		"webhook_secret_ref": "cred_gorgias_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"ticket":{"id":501,"customer":{"email":"ada@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "wrong")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_signature") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("invalid webhook should not record runs: %+v", store.runs)
	}
}

func TestGorgiasWebhookRejectsMissingIntegrationIDForScopedIntegration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":              "acme.gorgias.com",
		"webhook_secret_ref":          "cred_gorgias_webhook_1",
		"gorgias_http_integration_id": "http_123",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"ticket":{"id":501,"customer":{"email":"ada@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("missing integration id should not ingest or claim, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestGorgiasWebhookRejectsSuppliedIntegrationIDForUnscopedIntegration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGorgias
	store.integration.Settings = map[string]any{
		"account_domain":     "acme.gorgias.com",
		"webhook_secret_ref": "cred_gorgias_webhook_1",
	}
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gorgias_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"ticket":{"id":501,"customer":{"email":"ada@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gorgias/acme.gorgias.com/webhooks?integration_id=http_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gorgias-Webhook-Secret", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("unexpected work for mismatched integration id, runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}

func TestSupportWebhookIngestRejectsProviderTokenMismatch(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTidio
	store.integration.Settings = map[string]any{supportIngestTokenSetting: "swhk_tidio_1"}
	deps := &Deps{Repo: store, Suite: &fakeSuiteSink{}}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/freshchat/ingest/swhk_tidio_1", strings.NewReader(`{"email":"buyer@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("mismatched provider should not record runs: %+v", store.runs)
	}
}

func TestSupportWebhookIngestFailsClosedWhenConfiguredSecretIsMissing(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTidio
	store.integration.Settings = map[string]any{
		supportIngestTokenSetting: "swhk_tidio_1",
		"webhook_secret_ref":      "cred_tidio_webhook_1",
	}
	deps := &Deps{Repo: store, Suite: &fakeSuiteSink{}}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/tidio/ingest/swhk_tidio_1", strings.NewReader(`{"email":"buyer@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "request authentication failed") || strings.Contains(rec.Body.String(), "support webhook secret is required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("missing configured secret should not record runs: %+v", store.runs)
	}
}

func TestBackfillForcesRunMode(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:  store,
		Suite: &fakeSuiteSink{},
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/support_1/backfill", `{
		"run_mode":"manual",
		"tickets":[{"email":"one@example.com","subject":"Hello"}]
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
}
