package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/crm_integrations"
	"github.com/postwave/postwave/apps/api/internal/support_integrations"
)

type salesforceServiceCloudCredentialStoreAdapter struct {
	store crm_integrations.SalesforceCredentialStore
}

func (a salesforceServiceCloudCredentialStoreAdapter) GetSalesforceServiceCloudCredentialSecret(ctx context.Context, tenantID, ref string) (string, error) {
	if a.store == nil {
		return "", support_integrations.ErrNotFound
	}
	raw, err := a.store.GetSalesforceCredentialSecret(ctx, tenantID, ref)
	if errors.Is(err, crm_integrations.ErrNotFound) {
		return "", support_integrations.ErrNotFound
	}
	return raw, err
}

func (a salesforceServiceCloudCredentialStoreAdapter) PutSalesforceServiceCloudCredentialSecret(ctx context.Context, tenantID, ref string, creds support_integrations.SalesforceServiceCloudCredentials) error {
	if a.store == nil {
		return fmt.Errorf("salesforce service cloud credential store is not configured")
	}
	return a.store.PutSalesforceCredentialSecret(ctx, tenantID, ref, crm_integrations.SalesforceCredentials{
		AccessToken:    creds.AccessToken,
		RefreshToken:   creds.RefreshToken,
		ClientID:       creds.ClientID,
		ClientSecret:   creds.ClientSecret,
		InstanceURL:    creds.InstanceURL,
		LoginURL:       creds.LoginURL,
		IdentityURL:    creds.IdentityURL,
		APIVersion:     creds.APIVersion,
		UserAgent:      creds.UserAgent,
		Scope:          creds.Scope,
		TokenExpiresAt: creds.TokenExpiresAt,
	})
}
