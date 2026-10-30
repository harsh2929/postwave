// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Provider runtime wiring for the CRM handlers: backfillers, credential
// resolvers and deleters, Pipedrive managed webhooks and OAuth revocation on
// disconnect.

func (d *Deps) hubSpotBackfiller() HubSpotBackfiller {
	if d == nil {
		return nil
	}
	if d.HubSpotBackfiller != nil {
		return d.HubSpotBackfiller
	}
	if d.HubSpotCredentials == nil {
		return nil
	}
	return HubSpotRESTBackfiller{Credentials: d.HubSpotCredentials}
}

func (d *Deps) salesforceBackfiller() SalesforceBackfiller {
	if d == nil {
		return nil
	}
	if d.SalesforceBackfiller != nil {
		return d.SalesforceBackfiller
	}
	if d.SalesforceCredentials == nil {
		return nil
	}
	return SalesforceRESTBackfiller{Credentials: d.SalesforceCredentials}
}

func (d *Deps) pipedriveBackfiller() PipedriveBackfiller {
	if d == nil {
		return nil
	}
	if d.PipedriveBackfiller != nil {
		return d.PipedriveBackfiller
	}
	if d.PipedriveCredentials == nil {
		return nil
	}
	return PipedriveRESTBackfiller{Credentials: d.PipedriveCredentials}
}

func (d *Deps) pipedriveCredentialResolver() PipedriveCredentialResolver {
	if d == nil {
		return nil
	}
	return d.PipedriveCredentials
}

func (d *Deps) pipedriveCredentialDeleter() PipedriveCredentialDeleter {
	if d == nil || d.Repo == nil {
		return nil
	}
	deleter, ok := d.Repo.(PipedriveCredentialDeleter)
	if !ok {
		return nil
	}
	return deleter
}

func (d *Deps) deletePipedriveManagedCredentialSecret(ctx context.Context, tenantID string, integration Integration) error {
	if integration.Provider != ProviderPipedrive || !pipedriveIsStoredCredentialRef(pipedriveCredentialRef(integration)) {
		return nil
	}
	deleter := d.pipedriveCredentialDeleter()
	if deleter == nil {
		return nil
	}
	return deleter.DeletePipedriveCredentialSecret(ctx, tenantID, pipedriveCredentialRef(integration))
}

func (d *Deps) reconcilePipedriveWebhooks(ctx context.Context, integration Integration, appBaseURL string) (PipedriveWebhookReconcileSummary, error) {
	registrar := d.PipedriveWebhooks
	if registrar == nil {
		registrar = PipedriveRESTWebhookRegistrar{Credentials: d.pipedriveCredentialResolver()}
	}
	return registrar.ReconcileWebhooks(ctx, integration, appBaseURL)
}

func (d *Deps) preparePipedriveManagedWebhooks(ctx context.Context, tenantID string, normalized IntegrationInput, appBaseURL string) (IntegrationInput, error) {
	if normalized.Provider != ProviderPipedrive || !pipedriveManageWebhooks(normalized.Settings) || (d.pipedriveCredentialResolver() == nil && d.PipedriveWebhooks == nil) {
		return normalized, nil
	}
	existing := d.existingIntegrationByProviderName(ctx, tenantID, normalized.Provider, normalized.Name)
	if existing != nil {
		merged := copySettings(existing.Settings)
		for key, value := range normalized.Settings {
			merged[key] = value
		}
		stripCRMProviderRuntimeSettings(merged)
		normalized.Settings = merged
	}
	summary, err := d.reconcilePipedriveWebhooks(ctx, Integration{
		TenantID:       tenantID,
		Provider:       ProviderPipedrive,
		Name:           normalized.Name,
		Status:         normalized.Status,
		Scopes:         normalized.Scopes,
		CredentialsRef: normalized.CredentialsRef,
		Settings:       normalized.Settings,
	}, appBaseURL)
	if err != nil {
		return IntegrationInput{}, err
	}
	ids := make([]string, 0, len(summary.Subscriptions))
	topics := make([]string, 0, len(summary.Subscriptions))
	for _, sub := range summary.Subscriptions {
		if sub.ID != "" {
			ids = append(ids, sub.ID)
		}
		topics = append(topics, sub.EventAction+"."+sub.EventObject)
	}
	if len(ids) > 0 {
		normalized.Settings["pipedrive_webhook_id"] = ids[0]
		normalized.Settings["pipedrive_webhook_ids"] = ids
	}
	normalized.Settings["pipedrive_webhook_endpoint"] = summary.Endpoint
	normalized.Settings["pipedrive_webhook_topics"] = uniqueCRMStrings(topics)
	normalized.Settings["pipedrive_webhook_registered_at"] = summary.RegisteredAt.Format(time.RFC3339)
	normalized.Settings["pipedrive_webhooks_managed_by_postwave"] = true
	stripCRMProviderRuntimeSettings(normalized.Settings)
	return normalized, nil
}

func (d *Deps) cleanupPipedriveWebhooks(ctx context.Context, integration Integration, appBaseURL string) (PipedriveWebhookCleanupSummary, error) {
	registrar := d.PipedriveWebhooks
	if registrar == nil {
		registrar = PipedriveRESTWebhookRegistrar{Credentials: d.pipedriveCredentialResolver()}
	}
	return registrar.CleanupWebhooks(ctx, integration, appBaseURL)
}

func (d *Deps) revokeHubSpotOAuthOnDisconnect(ctx context.Context, tenantID string, integration Integration) (HubSpotOAuthRevocationSummary, error) {
	if integration.Provider != ProviderHubSpot {
		return HubSpotOAuthRevocationSummary{}, nil
	}
	creds, ok, reason, err := d.hubSpotOAuthRevocationCredentials(ctx, tenantID, integration)
	if err != nil {
		return HubSpotOAuthRevocationSummary{}, err
	}
	if !ok {
		return HubSpotOAuthRevocationSummary{Skipped: true, Reason: reason}, nil
	}
	client := d.HubSpotOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	cfg := d.HubSpotOAuth
	if client.OAuthBaseURL == "" {
		client.OAuthBaseURL = firstString(cfg.OAuthBaseURL, creds.OAuthBaseURL)
	}
	if client.UserAgent == "" {
		client.UserAgent = hubSpotDefaultUserAgent
	}
	if err := client.RevokeRefreshToken(ctx, creds); err != nil {
		return HubSpotOAuthRevocationSummary{}, err
	}
	return HubSpotOAuthRevocationSummary{
		Revoked:   true,
		TokenType: "refresh_token",
		RevokedAt: d.now().Format(time.RFC3339),
	}, nil
}

func (d *Deps) hubSpotOAuthRevocationCredentials(ctx context.Context, tenantID string, integration Integration) (HubSpotCredentials, bool, string, error) {
	ref := hubSpotCredentialRef(integration)
	if ref == "" {
		return HubSpotCredentials{}, false, "credentials_ref_missing", nil
	}
	var creds HubSpotCredentials
	var err error
	if store := d.hubSpotCredentialStore(); store != nil && hubSpotIsStoredCredentialRef(ref) {
		var raw string
		raw, err = store.GetHubSpotCredentialSecret(ctx, tenantID, ref)
		if errors.Is(err, ErrNotFound) {
			return HubSpotCredentials{}, false, "stored_credential_missing", nil
		}
		if err != nil {
			return HubSpotCredentials{}, false, "", err
		}
		creds, err = parseHubSpotCredentialSecret(raw)
	} else if resolver := d.HubSpotCredentials; resolver != nil {
		creds, err = resolver.ResolveHubSpot(ctx, tenantID, integration)
	} else {
		return HubSpotCredentials{}, false, "credential_resolver_missing", nil
	}
	if err != nil {
		return HubSpotCredentials{}, false, "", err
	}
	if strings.TrimSpace(creds.RefreshToken) == "" {
		return HubSpotCredentials{}, false, "refresh_token_missing", nil
	}
	cfg := d.HubSpotOAuth
	if creds.ClientID == "" {
		creds.ClientID = cfg.ClientID
	}
	if creds.ClientSecret == "" {
		creds.ClientSecret = cfg.ClientSecret
	}
	if creds.OAuthBaseURL == "" {
		creds.OAuthBaseURL = cfg.OAuthBaseURL
	}
	return creds, true, "", nil
}

type SalesforceOAuthRevocationSummary struct {
	Revoked   bool   `json:"revoked,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
	Reason    string `json:"reason,omitempty"`
	TokenType string `json:"token_type,omitempty"`
	RevokedAt string `json:"revoked_at,omitempty"`
}

func (d *Deps) revokeSalesforceOAuthOnDisconnect(ctx context.Context, tenantID string, integration Integration) (SalesforceOAuthRevocationSummary, error) {
	if integration.Provider != ProviderSalesforce {
		return SalesforceOAuthRevocationSummary{}, nil
	}
	creds, ok, reason, err := d.salesforceOAuthRevocationCredentials(ctx, tenantID, integration)
	if err != nil {
		return SalesforceOAuthRevocationSummary{}, err
	}
	if !ok {
		return SalesforceOAuthRevocationSummary{Skipped: true, Reason: reason}, nil
	}
	client := d.SalesforceOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	cfg := d.SalesforceOAuth
	if client.LoginURL == "" {
		client.LoginURL = firstString(cfg.LoginURL, creds.LoginURL)
	}
	if client.UserAgent == "" {
		client.UserAgent = salesforceDefaultOAuthUserAgentStr
	}
	if err := client.RevokeRefreshToken(ctx, creds); err != nil {
		return SalesforceOAuthRevocationSummary{}, err
	}
	return SalesforceOAuthRevocationSummary{
		Revoked:   true,
		TokenType: "refresh_token",
		RevokedAt: d.now().Format(time.RFC3339),
	}, nil
}

func (d *Deps) salesforceOAuthRevocationCredentials(ctx context.Context, tenantID string, integration Integration) (SalesforceCredentials, bool, string, error) {
	ref := salesforceCredentialRef(integration)
	if ref == "" {
		return SalesforceCredentials{}, false, "credentials_ref_missing", nil
	}
	var creds SalesforceCredentials
	var err error
	if store := d.salesforceCredentialStore(); store != nil && salesforceIsStoredCredentialRef(ref) {
		var raw string
		raw, err = store.GetSalesforceCredentialSecret(ctx, tenantID, ref)
		if errors.Is(err, ErrNotFound) {
			return SalesforceCredentials{}, false, "stored_credential_missing", nil
		}
		if err != nil {
			return SalesforceCredentials{}, false, "", err
		}
		creds, err = parseSalesforceCredentialSecret(raw)
	} else if resolver := d.SalesforceCredentials; resolver != nil {
		creds, err = resolver.ResolveSalesforce(ctx, tenantID, integration)
	} else {
		return SalesforceCredentials{}, false, "credential_resolver_missing", nil
	}
	if err != nil {
		return SalesforceCredentials{}, false, "", err
	}
	if strings.TrimSpace(creds.RefreshToken) == "" {
		return SalesforceCredentials{}, false, "refresh_token_missing", nil
	}
	cfg := d.SalesforceOAuth
	if creds.ClientID == "" {
		creds.ClientID = cfg.ClientID
	}
	if creds.ClientSecret == "" {
		creds.ClientSecret = cfg.ClientSecret
	}
	if creds.LoginURL == "" {
		creds.LoginURL = cfg.LoginURL
	}
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return SalesforceCredentials{}, false, "", fmt.Errorf("salesforce OAuth client_id and client_secret are required to revoke refresh_token")
	}
	return creds, true, "", nil
}

func (d *Deps) revokePipedriveOAuthOnDisconnect(ctx context.Context, tenantID string, integration Integration) (PipedriveOAuthRevocationSummary, error) {
	if integration.Provider != ProviderPipedrive {
		return PipedriveOAuthRevocationSummary{}, nil
	}
	creds, ok, reason, err := d.pipedriveOAuthRevocationCredentials(ctx, tenantID, integration)
	if err != nil {
		return PipedriveOAuthRevocationSummary{}, err
	}
	if !ok {
		return PipedriveOAuthRevocationSummary{Skipped: true, Reason: reason}, nil
	}
	client := d.PipedriveOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	cfg := d.PipedriveOAuth
	if client.OAuthBaseURL == "" {
		client.OAuthBaseURL = firstString(cfg.OAuthBaseURL, creds.OAuthBaseURL)
	}
	if client.UserAgent == "" {
		client.UserAgent = pipedriveDefaultUserAgent
	}
	if err := client.RevokeRefreshToken(ctx, creds); err != nil {
		return PipedriveOAuthRevocationSummary{}, err
	}
	return PipedriveOAuthRevocationSummary{
		Revoked:   true,
		TokenType: "refresh_token",
		RevokedAt: d.now().Format(time.RFC3339),
	}, nil
}

func (d *Deps) pipedriveOAuthRevocationCredentials(ctx context.Context, tenantID string, integration Integration) (PipedriveCredentials, bool, string, error) {
	ref := pipedriveCredentialRef(integration)
	if ref == "" {
		return PipedriveCredentials{}, false, "credentials_ref_missing", nil
	}
	var creds PipedriveCredentials
	var err error
	if store := d.pipedriveCredentialStore(); store != nil && pipedriveIsStoredCredentialRef(ref) {
		var raw string
		raw, err = store.GetPipedriveCredentialSecret(ctx, tenantID, ref)
		if errors.Is(err, ErrNotFound) {
			return PipedriveCredentials{}, false, "stored_credential_missing", nil
		}
		if err != nil {
			return PipedriveCredentials{}, false, "", err
		}
		creds, err = parsePipedriveCredentialSecret(raw)
	} else if resolver := d.pipedriveCredentialResolver(); resolver != nil {
		creds, err = resolver.ResolvePipedrive(ctx, tenantID, integration)
	} else {
		return PipedriveCredentials{}, false, "credential_resolver_missing", nil
	}
	if err != nil {
		return PipedriveCredentials{}, false, "", err
	}
	if strings.TrimSpace(creds.RefreshToken) == "" {
		return PipedriveCredentials{}, false, "refresh_token_missing", nil
	}
	cfg := d.PipedriveOAuth
	if creds.ClientID == "" {
		creds.ClientID = cfg.ClientID
	}
	if creds.ClientSecret == "" {
		creds.ClientSecret = cfg.ClientSecret
	}
	if creds.OAuthBaseURL == "" {
		creds.OAuthBaseURL = cfg.OAuthBaseURL
	}
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return PipedriveCredentials{}, false, "", fmt.Errorf("pipedrive OAuth client_id and client_secret are required to revoke refresh_token")
	}
	return creds, true, "", nil
}

type ZohoOAuthRevocationSummary struct {
	Revoked   bool   `json:"revoked,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
	Reason    string `json:"reason,omitempty"`
	TokenType string `json:"token_type,omitempty"`
	RevokedAt string `json:"revoked_at,omitempty"`
}

func (d *Deps) revokeZohoOAuthOnDisconnect(ctx context.Context, tenantID string, integration Integration) (ZohoOAuthRevocationSummary, error) {
	if integration.Provider != ProviderZohoCRM {
		return ZohoOAuthRevocationSummary{}, nil
	}
	creds, ok, reason, err := d.zohoOAuthRevocationCredentials(ctx, tenantID, integration)
	if err != nil {
		return ZohoOAuthRevocationSummary{}, err
	}
	if !ok {
		return ZohoOAuthRevocationSummary{Skipped: true, Reason: reason, TokenType: "refresh_token"}, nil
	}
	client := d.ZohoOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	cfg := d.ZohoOAuth
	if client.AccountsURL == "" {
		client.AccountsURL = firstString(cfg.AccountsURL, creds.AccountsURL)
	}
	if client.UserAgent == "" {
		client.UserAgent = zohoDefaultUserAgent
	}
	if err := client.RevokeRefreshToken(ctx, creds); err != nil {
		return ZohoOAuthRevocationSummary{}, err
	}
	return ZohoOAuthRevocationSummary{
		Revoked:   true,
		TokenType: "refresh_token",
		RevokedAt: d.now().Format(time.RFC3339),
	}, nil
}

func (d *Deps) zohoOAuthRevocationCredentials(ctx context.Context, tenantID string, integration Integration) (ZohoCredentials, bool, string, error) {
	ref := zohoCredentialRef(integration)
	if ref == "" {
		return ZohoCredentials{}, false, "credentials_ref_missing", nil
	}
	var creds ZohoCredentials
	var err error
	if store := d.zohoCredentialStore(); store != nil && zohoIsStoredCredentialRef(ref) {
		var raw string
		raw, err = store.GetZohoCredentialSecret(ctx, tenantID, ref)
		if errors.Is(err, ErrNotFound) {
			return ZohoCredentials{}, false, "stored_credential_missing", nil
		}
		if err != nil {
			return ZohoCredentials{}, false, "", err
		}
		creds, err = parseZohoCredentialSecret(raw)
	} else if resolver := d.ZohoCredentials; resolver != nil {
		creds, err = resolver.ResolveZoho(ctx, tenantID, integration)
	} else {
		return ZohoCredentials{}, false, "credential_resolver_missing", nil
	}
	if err != nil {
		return ZohoCredentials{}, false, "", err
	}
	if strings.TrimSpace(creds.RefreshToken) == "" {
		return ZohoCredentials{}, false, "refresh_token_missing", nil
	}
	cfg := d.ZohoOAuth
	if creds.ClientID == "" {
		creds.ClientID = cfg.ClientID
	}
	if creds.ClientSecret == "" {
		creds.ClientSecret = cfg.ClientSecret
	}
	if creds.AccountsURL == "" {
		creds.AccountsURL = cfg.AccountsURL
	}
	return creds, true, "", nil
}

func (d *Deps) deleteZohoManagedCredentialSecret(ctx context.Context, tenantID string, integration Integration) error {
	ref := zohoCredentialRef(integration)
	if !zohoIsStoredCredentialRef(ref) {
		return nil
	}
	deleter := d.zohoCredentialDeleter()
	if deleter == nil {
		return fmt.Errorf("zoho credential deleter is required to delete managed credential secret")
	}
	if err := deleter.DeleteZohoCredentialSecret(ctx, tenantID, ref); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

func (d *Deps) deleteDynamics365ManagedCredentialSecret(ctx context.Context, tenantID string, integration Integration) error {
	ref := dynamics365CredentialRef(integration)
	if !dynamics365IsStoredCredentialRef(ref) {
		return nil
	}
	deleter := d.dynamics365CredentialDeleter()
	if deleter == nil {
		return fmt.Errorf("dynamics 365 credential deleter is required to delete managed credential secret")
	}
	if err := deleter.DeleteDynamics365CredentialSecret(ctx, tenantID, ref); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

func (d *Deps) deleteKeapManagedCredentialSecret(ctx context.Context, tenantID string, integration Integration) error {
	ref := keapCredentialRef(integration)
	if !keapIsStoredCredentialRef(ref) {
		return nil
	}
	deleter := d.keapCredentialDeleter()
	if deleter == nil {
		return fmt.Errorf("keap credential deleter is required to delete managed credential secret")
	}
	if err := deleter.DeleteKeapCredentialSecret(ctx, tenantID, ref); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

func (d *Deps) deleteHighLevelManagedCredentialSecret(ctx context.Context, tenantID string, integration Integration) error {
	ref := highLevelCredentialRef(integration)
	if !highLevelIsStoredCredentialRef(ref) {
		return nil
	}
	deleter := d.highLevelCredentialDeleter()
	if deleter == nil {
		return fmt.Errorf("highLevel credential deleter is required to delete managed credential secret")
	}
	if err := deleter.DeleteHighLevelCredentialSecret(ctx, tenantID, ref); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

func (d *Deps) zohoCredentialDeleter() ZohoCredentialDeleter {
	if d == nil {
		return nil
	}
	if resolver, ok := d.ZohoCredentials.(*ZohoSecretsCredentialResolver); ok && resolver.Store != nil {
		if deleter, ok := resolver.Store.(ZohoCredentialDeleter); ok {
			return deleter
		}
	}
	if deleter, ok := d.Repo.(ZohoCredentialDeleter); ok {
		return deleter
	}
	return nil
}

func (d *Deps) dynamics365CredentialDeleter() Dynamics365CredentialDeleter {
	if d == nil {
		return nil
	}
	if resolver, ok := d.Dynamics365Credentials.(*Dynamics365SecretsCredentialResolver); ok && resolver.Store != nil {
		if deleter, ok := resolver.Store.(Dynamics365CredentialDeleter); ok {
			return deleter
		}
	}
	if deleter, ok := d.Repo.(Dynamics365CredentialDeleter); ok {
		return deleter
	}
	return nil
}

func (d *Deps) keapCredentialDeleter() KeapCredentialDeleter {
	if d == nil {
		return nil
	}
	if resolver, ok := d.KeapCredentials.(*KeapSecretsCredentialResolver); ok && resolver.Store != nil {
		if deleter, ok := resolver.Store.(KeapCredentialDeleter); ok {
			return deleter
		}
	}
	if deleter, ok := d.Repo.(KeapCredentialDeleter); ok {
		return deleter
	}
	return nil
}

func (d *Deps) highLevelCredentialDeleter() HighLevelCredentialDeleter {
	if d == nil {
		return nil
	}
	if resolver, ok := d.HighLevelCredentials.(*HighLevelSecretsCredentialResolver); ok && resolver.Store != nil {
		if deleter, ok := resolver.Store.(HighLevelCredentialDeleter); ok {
			return deleter
		}
	}
	if deleter, ok := d.Repo.(HighLevelCredentialDeleter); ok {
		return deleter
	}
	return nil
}

func (d *Deps) zohoBackfiller() ZohoBackfiller {
	if d == nil {
		return nil
	}
	if d.ZohoBackfiller != nil {
		return d.ZohoBackfiller
	}
	if d.ZohoCredentials == nil {
		return nil
	}
	return ZohoRESTBackfiller{Credentials: d.ZohoCredentials}
}

func (d *Deps) dynamics365Backfiller() Dynamics365Backfiller {
	if d == nil {
		return nil
	}
	if d.Dynamics365Backfiller != nil {
		return d.Dynamics365Backfiller
	}
	if d.Dynamics365Credentials == nil {
		return nil
	}
	return Dynamics365RESTBackfiller{Credentials: d.Dynamics365Credentials}
}

func (d *Deps) keapBackfiller() KeapBackfiller {
	if d == nil {
		return nil
	}
	if d.KeapBackfiller != nil {
		return d.KeapBackfiller
	}
	if d.KeapCredentials == nil {
		return nil
	}
	return KeapRESTBackfiller{Credentials: d.KeapCredentials}
}

func (d *Deps) highLevelBackfiller() HighLevelBackfiller {
	if d == nil {
		return nil
	}
	if d.HighLevelBackfiller != nil {
		return d.HighLevelBackfiller
	}
	if d.HighLevelCredentials == nil {
		return nil
	}
	return HighLevelRESTBackfiller{Credentials: d.HighLevelCredentials}
}

func (d *Deps) closeBackfiller() CloseBackfiller {
	if d == nil {
		return nil
	}
	if d.CloseBackfiller != nil {
		return d.CloseBackfiller
	}
	if d.CloseCredentials == nil {
		return nil
	}
	return CloseRESTBackfiller{Credentials: d.CloseCredentials}
}

func (d *Deps) copperBackfiller() CopperBackfiller {
	if d == nil {
		return nil
	}
	if d.CopperBackfiller != nil {
		return d.CopperBackfiller
	}
	if d.CopperCredentials == nil {
		return nil
	}
	return CopperRESTBackfiller{Credentials: d.CopperCredentials}
}

func (d *Deps) freshsalesBackfiller() FreshsalesBackfiller {
	if d == nil {
		return nil
	}
	if d.FreshsalesBackfiller != nil {
		return d.FreshsalesBackfiller
	}
	if d.FreshsalesCredentials == nil {
		return nil
	}
	return FreshsalesRESTBackfiller{Credentials: d.FreshsalesCredentials}
}

func (d *Deps) postscriptBackfiller() PostscriptBackfiller {
	if d == nil {
		return nil
	}
	if d.PostscriptBackfiller != nil {
		return d.PostscriptBackfiller
	}
	if d.PostscriptCredentials == nil {
		return nil
	}
	return PostscriptRESTBackfiller{Credentials: d.PostscriptCredentials}
}

func (d *Deps) attentiveBackfiller() AttentiveBackfiller {
	if d == nil {
		return nil
	}
	if d.AttentiveBackfiller != nil {
		return d.AttentiveBackfiller
	}
	if d.AttentiveCredentials == nil {
		return nil
	}
	return AttentiveRESTBackfiller{Credentials: d.AttentiveCredentials}
}
