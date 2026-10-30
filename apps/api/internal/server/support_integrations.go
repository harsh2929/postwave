// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/service_suite"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/support_integrations"
	"github.com/postwave/postwave/apps/api/internal/track"
)

// SupportIntegrationsDeps carries the process-wide identities that cannot be
// reconstructed solely from the shared pool. Optional secret integrations stay
// nilable, preserving the provider handlers' existing fail-closed behavior.
type SupportIntegrationsDeps struct {
	SubscriberProfiles        *subscribers.Repo
	Secrets                   support_integrations.SupportRuntimeSecretResolver
	SalesforceCredentialStore support_integrations.SalesforceServiceCloudCredentialStore
	PublicBaseURL             string
	HubSpotClientSecret       string
	SalesforceOAuthLoginURL   string
	HelpdeskCursorKey         []byte
}

// SupportIntegrationBackfill pins one provider worker to the same dependency
// graph used by its HTTP sync and webhook routes.
type SupportIntegrationBackfill struct {
	Name       string
	Provider   string
	Backfiller support_integrations.SupportProviderBackfiller
}

// SupportIntegrationsSurface is the mounted customer-support graph. Workers
// must consume Repository, Dependencies, and Backfills from this value rather
// than constructing a second provider graph.
type SupportIntegrationsSurface struct {
	ServiceSuite *service_suite.Deps
	Repository   *support_integrations.Repo
	Dependencies *support_integrations.Deps
	Backfills    []SupportIntegrationBackfill
}

// MountSupportIntegrationsSurface mounts only authenticated Helpdesk/control
// routes. Route41 mounts the provider-family release hold on the root router so
// callbacks cannot accidentally inherit session/API-key middleware.
func MountSupportIntegrationsSurface(deps Deps) SupportIntegrationsSurface {
	if deps.Router == nil || deps.Pool == nil || deps.SupportIntegrations == nil {
		return SupportIntegrationsSurface{}
	}

	surface := newSupportIntegrationsSurface(deps)
	service_suite.MountRoutes(deps.Router, surface.ServiceSuite)
	support_integrations.MountRoutes(deps.Router, surface.Dependencies)
	return surface
}

func newSupportIntegrationsSurface(deps Deps) SupportIntegrationsSurface {
	graph := deps.SupportIntegrations
	serviceSuiteRepo := &service_suite.Repo{Pool: deps.Pool}
	serviceSuiteDeps := &service_suite.Deps{Repo: serviceSuiteRepo, Logger: deps.Log(), CursorKey: append([]byte(nil), graph.HelpdeskCursorKey...)}
	repository := &support_integrations.Repo{Pool: deps.Pool}
	dependencies := &support_integrations.Deps{
		Repo:                       repository,
		Suite:                      support_integrations.ServiceSuiteSink{Repo: serviceSuiteRepo, Pool: deps.Pool},
		Profiles:                   support_integrations.SubscriberSupportSink{Repo: graph.SubscriberProfiles},
		Events:                     support_integrations.TrackEventSink{Repo: &track.Repo{Pool: deps.Pool, FlowRuns: &flowbuilder.Repo{Pool: deps.Pool}}},
		Logger:                     deps.Log(),
		CursorKey:                  append([]byte(nil), graph.HelpdeskCursorKey...),
		PublicBaseURL:              graph.PublicBaseURL,
		HubSpotWebhookClientSecret: graph.HubSpotClientSecret,
		WebhookSecrets:             graph.Secrets,
		ZendeskBackfiller: support_integrations.ZendeskRESTBackfiller{
			Credentials: support_integrations.ZendeskSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		IntercomBackfiller: support_integrations.IntercomRESTBackfiller{
			Credentials: support_integrations.IntercomSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		GorgiasBackfiller: support_integrations.GorgiasRESTBackfiller{
			Credentials: support_integrations.GorgiasSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		FreshdeskBackfiller: support_integrations.FreshdeskRESTBackfiller{
			Credentials: support_integrations.FreshdeskSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		FreshchatBackfiller: support_integrations.FreshchatRESTBackfiller{
			Credentials: support_integrations.FreshchatSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		TidioBackfiller: support_integrations.TidioRESTBackfiller{
			Credentials: support_integrations.TidioSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		AdaBackfiller: support_integrations.AdaRESTBackfiller{
			Credentials: support_integrations.AdaSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		GladlyBackfiller: support_integrations.GladlyRESTBackfiller{
			Credentials: support_integrations.GladlySecretsCredentialResolver{Secrets: graph.Secrets},
		},
		GrooveBackfiller: support_integrations.GrooveRESTBackfiller{
			Credentials: support_integrations.GrooveSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		HelpCrunchBackfiller: support_integrations.HelpCrunchRESTBackfiller{
			Credentials: support_integrations.HelpCrunchSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		JiraServiceManagementBackfiller: support_integrations.JiraServiceManagementRESTBackfiller{
			Credentials: support_integrations.JiraServiceManagementSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		LinearBackfiller: support_integrations.LinearGraphQLBackfiller{
			Credentials: support_integrations.LinearSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		AsanaSupportBackfiller: support_integrations.AsanaSupportRESTBackfiller{
			Credentials: support_integrations.AsanaSupportSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		ClickUpSupportBackfiller: support_integrations.ClickUpSupportRESTBackfiller{
			Credentials: support_integrations.ClickUpSupportSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		HelpScoutBackfiller: support_integrations.HelpScoutRESTBackfiller{
			Credentials: support_integrations.HelpScoutSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		ReamazeBackfiller: support_integrations.ReamazeRESTBackfiller{
			Credentials: support_integrations.ReamazeSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		FrontBackfiller: support_integrations.FrontRESTBackfiller{
			Credentials: support_integrations.FrontSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		CrispBackfiller: support_integrations.CrispRESTBackfiller{
			Credentials: support_integrations.CrispSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		KustomerBackfiller: support_integrations.KustomerRESTBackfiller{
			Credentials: support_integrations.KustomerSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		DriftBackfiller: support_integrations.DriftRESTBackfiller{
			Credentials: support_integrations.DriftSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		LiveChatBackfiller: support_integrations.LiveChatRESTBackfiller{
			Credentials: support_integrations.LiveChatSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		ZohoDeskBackfiller: support_integrations.ZohoDeskRESTBackfiller{
			Credentials: support_integrations.ZohoDeskSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		OlarkBackfiller: support_integrations.OlarkRESTBackfiller{
			Credentials: support_integrations.OlarkSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		HubSpotServiceHubBackfiller: support_integrations.HubSpotServiceHubRESTBackfiller{
			Credentials: support_integrations.HubSpotServiceHubSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		SalesforceServiceCloudBackfiller: support_integrations.SalesforceServiceCloudRESTBackfiller{
			Credentials: support_integrations.SalesforceServiceCloudSecretsCredentialResolver{
				Secrets: graph.Secrets,
				Store:   graph.SalesforceCredentialStore,
				OAuthClient: support_integrations.SalesforceServiceCloudOAuthClient{
					LoginURL:  graph.SalesforceOAuthLoginURL,
					UserAgent: "Moosewave Salesforce Service Cloud Integration",
				},
			},
		},
		KayakoBackfiller: support_integrations.KayakoRESTBackfiller{
			Credentials: support_integrations.KayakoSecretsCredentialResolver{Secrets: graph.Secrets},
		},
	}

	return SupportIntegrationsSurface{
		ServiceSuite: serviceSuiteDeps,
		Repository:   repository,
		Dependencies: dependencies,
		Backfills:    supportIntegrationBackfills(dependencies),
	}
}

func supportIntegrationBackfills(deps *support_integrations.Deps) []SupportIntegrationBackfill {
	return []SupportIntegrationBackfill{
		{Name: "zendesk", Provider: support_integrations.ProviderZendesk, Backfiller: deps.ZendeskBackfiller},
		{Name: "intercom", Provider: support_integrations.ProviderIntercom, Backfiller: deps.IntercomBackfiller},
		{Name: "helpscout", Provider: support_integrations.ProviderHelpScout, Backfiller: deps.HelpScoutBackfiller},
		{Name: "freshdesk", Provider: support_integrations.ProviderFreshdesk, Backfiller: deps.FreshdeskBackfiller},
		{Name: "freshchat", Provider: support_integrations.ProviderFreshchat, Backfiller: deps.FreshchatBackfiller},
		{Name: "tidio", Provider: support_integrations.ProviderTidio, Backfiller: deps.TidioBackfiller},
		{Name: "ada", Provider: support_integrations.ProviderAda, Backfiller: deps.AdaBackfiller},
		{Name: "gladly", Provider: support_integrations.ProviderGladly, Backfiller: deps.GladlyBackfiller},
		{Name: "groove", Provider: support_integrations.ProviderGroove, Backfiller: deps.GrooveBackfiller},
		{Name: "helpcrunch", Provider: support_integrations.ProviderHelpCrunch, Backfiller: deps.HelpCrunchBackfiller},
		{Name: "jira-service-management", Provider: support_integrations.ProviderJiraServiceManagement, Backfiller: deps.JiraServiceManagementBackfiller},
		{Name: "linear", Provider: support_integrations.ProviderLinear, Backfiller: deps.LinearBackfiller},
		{Name: "asana-support", Provider: support_integrations.ProviderAsanaSupport, Backfiller: deps.AsanaSupportBackfiller},
		{Name: "clickup-support", Provider: support_integrations.ProviderClickUpSupport, Backfiller: deps.ClickUpSupportBackfiller},
		{Name: "gorgias", Provider: support_integrations.ProviderGorgias, Backfiller: deps.GorgiasBackfiller},
		{Name: "front", Provider: support_integrations.ProviderFront, Backfiller: deps.FrontBackfiller},
		{Name: "reamaze", Provider: support_integrations.ProviderReamaze, Backfiller: deps.ReamazeBackfiller},
		{Name: "crisp", Provider: support_integrations.ProviderCrisp, Backfiller: deps.CrispBackfiller},
		{Name: "kustomer", Provider: support_integrations.ProviderKustomer, Backfiller: deps.KustomerBackfiller},
		{Name: "drift", Provider: support_integrations.ProviderDrift, Backfiller: deps.DriftBackfiller},
		{Name: "livechat", Provider: support_integrations.ProviderLiveChat, Backfiller: deps.LiveChatBackfiller},
		{Name: "zoho-desk", Provider: support_integrations.ProviderZohoDesk, Backfiller: deps.ZohoDeskBackfiller},
		{Name: "olark", Provider: support_integrations.ProviderOlark, Backfiller: deps.OlarkBackfiller},
		{Name: "kayako", Provider: support_integrations.ProviderKayako, Backfiller: deps.KayakoBackfiller},
		{Name: "hubspot-service-hub", Provider: support_integrations.ProviderHubSpotServiceHub, Backfiller: deps.HubSpotServiceHubBackfiller},
		{Name: "salesforce-service-cloud", Provider: support_integrations.ProviderSalesforceServiceCloud, Backfiller: deps.SalesforceServiceCloudBackfiller},
	}
}
