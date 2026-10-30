package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type BigCommerceRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type BigCommerceSecretsCredentialResolver struct {
	Secrets BigCommerceRuntimeSecretResolver
}

func NewBigCommerceSecretsCredentialResolver(secrets BigCommerceRuntimeSecretResolver) *BigCommerceSecretsCredentialResolver {
	return &BigCommerceSecretsCredentialResolver{Secrets: secrets}
}

func (r *BigCommerceSecretsCredentialResolver) ResolveBigCommerce(ctx context.Context, _ string, integration Integration) (BigCommerceCredentials, error) {
	if r == nil || r.Secrets == nil {
		return BigCommerceCredentials{}, fmt.Errorf("bigcommerce credential resolver is not configured")
	}
	ref := bigCommerceCredentialRef(integration)
	if ref == "" {
		return BigCommerceCredentials{}, fmt.Errorf("bigcommerce credential_ref is required")
	}
	var payload bigCommerceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return BigCommerceCredentials{}, fmt.Errorf("resolve bigcommerce credentials %q: %w", ref, err)
		}
		creds, parseErr := parseBigCommerceCredentialSecret(raw)
		if parseErr != nil {
			return BigCommerceCredentials{}, parseErr
		}
		return creds, nil
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return BigCommerceCredentials{}, fmt.Errorf("resolve bigcommerce credentials %q: %w", ref, err)
	}
	return parseBigCommerceCredentialSecret(raw)
}

type bigCommerceCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	XAuthToken  string `json:"x_auth_token"`
}

func (p bigCommerceCredentialPayload) credentials() (BigCommerceCredentials, error) {
	token := strings.TrimSpace(firstNonEmpty(p.AccessToken, p.Token, p.APIKey, p.XAuthToken))
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	if token == "" {
		return BigCommerceCredentials{}, fmt.Errorf("bigcommerce access token is required")
	}
	return BigCommerceCredentials{AccessToken: token}, nil
}

func parseBigCommerceCredentialSecret(raw string) (BigCommerceCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return BigCommerceCredentials{}, fmt.Errorf("bigcommerce credentials are empty")
	}
	var payload bigCommerceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return BigCommerceCredentials{}, fmt.Errorf("parse bigcommerce credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "\n") {
		for _, line := range strings.Split(raw, "\n") {
			parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
			if len(parts) != 2 {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(parts[0])) {
			case "access_token", "token", "api_key", "x_auth_token":
				payload.AccessToken = strings.TrimSpace(parts[1])
			}
		}
		return payload.credentials()
	}
	return bigCommerceCredentialPayload{AccessToken: raw}.credentials()
}

func bigCommerceCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}
