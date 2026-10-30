// SPDX-License-Identifier: AGPL-3.0-only

package support_integrations

import (
	"context"
	"errors"
	"testing"
)

func TestRepoArchivedPreTenantLookupsFailClosedBeforePoolAccess(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	repo := &Repo{}
	tests := []struct {
		name string
		call func() (*Integration, error)
	}{
		{"ingest token", func() (*Integration, error) {
			return repo.FindSupportIntegrationByIngestToken(ctx, "support-ingest-token")
		}},
		{"zendesk", func() (*Integration, error) {
			return repo.FindZendeskIntegrationBySubdomain(ctx, "workspace", "webhook")
		}},
		{"intercom", func() (*Integration, error) {
			return repo.FindIntercomIntegrationByWorkspace(ctx, "workspace")
		}},
		{"gorgias", func() (*Integration, error) {
			return repo.FindGorgiasIntegrationByDomain(ctx, "workspace.gorgias.com", "integration")
		}},
		{"freshdesk", func() (*Integration, error) {
			return repo.FindFreshdeskIntegrationByDomain(ctx, "workspace.freshdesk.com", "webhook")
		}},
		{"freshchat", func() (*Integration, error) {
			return repo.FindFreshchatIntegrationByDomain(ctx, "workspace.freshchat.com", "webhook")
		}},
		{"tidio", func() (*Integration, error) {
			return repo.FindTidioIntegrationByProject(ctx, "project", "webhook")
		}},
		{"ada", func() (*Integration, error) {
			return repo.FindAdaIntegrationByAgent(ctx, "agent.ada.support", "webhook")
		}},
		{"help scout", func() (*Integration, error) {
			return repo.FindHelpScoutIntegrationByMailbox(ctx, "mailbox", "webhook")
		}},
		{"gladly", func() (*Integration, error) {
			return repo.FindGladlyIntegrationByOrganization(ctx, "workspace.gladly.com", "webhook")
		}},
		{"groove", func() (*Integration, error) {
			return repo.FindGrooveIntegrationByMailbox(ctx, "mailbox", "webhook")
		}},
		{"reamaze", func() (*Integration, error) {
			return repo.FindReamazeIntegrationByDomain(ctx, "workspace.reamaze.com", "webhook")
		}},
		{"helpcrunch", func() (*Integration, error) {
			return repo.FindHelpCrunchIntegrationByOrganization(ctx, "organization", "webhook")
		}},
		{"jira service management", func() (*Integration, error) {
			return repo.FindJiraServiceManagementIntegrationBySite(ctx, "site", "webhook")
		}},
		{"linear", func() (*Integration, error) {
			return repo.FindLinearIntegrationByWorkspace(ctx, "workspace", "webhook")
		}},
		{"asana", func() (*Integration, error) {
			return repo.FindAsanaSupportIntegrationByWorkspace(ctx, "workspace", "webhook")
		}},
		{"clickup", func() (*Integration, error) {
			return repo.FindClickUpSupportIntegrationByWorkspace(ctx, "workspace", "webhook")
		}},
		{"front", func() (*Integration, error) {
			return repo.FindFrontIntegrationByInbox(ctx, "inbox", "webhook")
		}},
		{"crisp", func() (*Integration, error) {
			return repo.FindCrispIntegrationByWebsite(ctx, "website", "webhook")
		}},
		{"kustomer", func() (*Integration, error) {
			return repo.FindKustomerIntegrationByOrganization(ctx, "organization", "webhook")
		}},
		{"drift", func() (*Integration, error) {
			return repo.FindDriftIntegrationByWorkspace(ctx, "workspace", "webhook")
		}},
		{"livechat", func() (*Integration, error) {
			return repo.FindLiveChatIntegrationByAccount(ctx, "account", "webhook")
		}},
		{"olark", func() (*Integration, error) {
			return repo.FindOlarkIntegrationBySite(ctx, "site", "webhook")
		}},
		{"kayako", func() (*Integration, error) {
			return repo.FindKayakoIntegrationByDomain(ctx, "workspace.kayako.com", "webhook")
		}},
		{"hubspot service hub", func() (*Integration, error) {
			return repo.FindHubSpotServiceHubIntegrationByPortal(ctx, "portal", "webhook")
		}},
		{"salesforce service cloud", func() (*Integration, error) {
			return repo.FindSalesforceServiceCloudIntegrationByInstance(ctx, "https://workspace.my.salesforce.com", "webhook")
		}},
		{"zoho desk", func() (*Integration, error) {
			return repo.FindZohoDeskIntegrationByOrganization(ctx, "organization", "webhook")
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			integration, err := test.call()
			if integration != nil || !errors.Is(err, ErrSupportRuntimeHeld) {
				t.Fatalf("lookup = (%+v, %v), want (nil, ErrSupportRuntimeHeld)", integration, err)
			}
		})
	}
}
