package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type AdobeCommerceRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type AdobeCommerceSecretsCredentialResolver struct {
	Secrets AdobeCommerceRuntimeSecretResolver
}

func NewAdobeCommerceSecretsCredentialResolver(secrets AdobeCommerceRuntimeSecretResolver) *AdobeCommerceSecretsCredentialResolver {
	return &AdobeCommerceSecretsCredentialResolver{Secrets: secrets}
}

func (r *AdobeCommerceSecretsCredentialResolver) ResolveAdobeCommerce(ctx context.Context, _ string, integration Integration) (AdobeCommerceCredentials, error) {
	if r == nil || r.Secrets == nil {
		return AdobeCommerceCredentials{}, fmt.Errorf("adobe commerce credential resolver is not configured")
	}
	ref := adobeCommerceCredentialRef(integration)
	if ref == "" {
		return AdobeCommerceCredentials{}, fmt.Errorf("adobe commerce credential_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return AdobeCommerceCredentials{}, err
	}
	webhookRef := adobeCommerceEventAuthRef(integration)
	if webhookRef != "" && webhookRef != ref {
		webhookSecret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return AdobeCommerceCredentials{}, err
		}
		creds.WebhookSecret = webhookSecret
	}
	return creds, nil
}

func (r *AdobeCommerceSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (AdobeCommerceCredentials, error) {
	var payload adobeCommerceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return AdobeCommerceCredentials{}, fmt.Errorf("resolve adobe commerce credentials %q: %w", ref, err)
		}
		return parseAdobeCommerceCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return AdobeCommerceCredentials{}, fmt.Errorf("resolve adobe commerce credentials %q: %w", ref, err)
	}
	return parseAdobeCommerceCredentialSecret(raw)
}

func (r *AdobeCommerceSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload adobeCommerceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve adobe commerce webhook secret %q: %w", ref, err)
		}
		return parseAdobeCommerceWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve adobe commerce webhook secret %q: %w", ref, err)
	}
	return parseAdobeCommerceWebhookSecret(raw)
}

type adobeCommerceCredentialPayload struct {
	AccessToken      string `json:"access_token"`
	Token            string `json:"token"`
	BearerToken      string `json:"bearer_token"`
	AdminToken       string `json:"admin_token"`
	IntegrationToken string `json:"integration_token"`
	WebhookSecret    string `json:"webhook_secret"`
	SigningSecret    string `json:"signing_secret"`
	Secret           string `json:"secret"`
	APIBaseURL       string `json:"api_base_url"`
	DeploymentMode   string `json:"deployment_mode"`
}

func (p adobeCommerceCredentialPayload) credentials() (AdobeCommerceCredentials, error) {
	token := normalizeAdobeCommerceBearerToken(firstNonEmpty(p.AccessToken, p.Token, p.BearerToken, p.AdminToken, p.IntegrationToken))
	if token == "" {
		return AdobeCommerceCredentials{}, fmt.Errorf("adobe commerce access_token is required")
	}
	webhook, _ := p.webhookSecret()
	return AdobeCommerceCredentials{
		AccessToken:    token,
		WebhookSecret:  webhook,
		APIBaseURL:     strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		DeploymentMode: strings.ToLower(strings.TrimSpace(p.DeploymentMode)),
	}, nil
}

func (p adobeCommerceCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstNonEmpty(p.WebhookSecret, p.SigningSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("adobe commerce webhook secret is required")
	}
	return secret, nil
}

func parseAdobeCommerceCredentialSecret(raw string) (AdobeCommerceCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return AdobeCommerceCredentials{}, fmt.Errorf("adobe commerce credentials are empty")
	}
	var payload adobeCommerceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return AdobeCommerceCredentials{}, fmt.Errorf("parse adobe commerce credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseAdobeCommerceKeyValueSecret(raw)
		return payload.credentials()
	}
	return adobeCommerceCredentialPayload{AccessToken: normalizeAdobeCommerceBearerToken(raw)}.credentials()
}

func parseAdobeCommerceWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("adobe commerce webhook secret is empty")
	}
	var payload adobeCommerceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse adobe commerce webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseAdobeCommerceKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseAdobeCommerceKeyValueSecret(raw string) adobeCommerceCredentialPayload {
	var payload adobeCommerceCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token", "token", "bearer_token":
			payload.AccessToken = value
		case "admin_token":
			payload.AdminToken = value
		case "integration_token":
			payload.IntegrationToken = value
		case "webhook_secret", "signing_secret":
			payload.WebhookSecret = value
		case "secret":
			payload.Secret = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "deployment_mode":
			payload.DeploymentMode = value
		}
	}
	return payload
}

func normalizeAdobeCommerceBearerToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "bearer ") {
		return strings.TrimSpace(raw[len("bearer "):])
	}
	return raw
}

func adobeCommerceCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}

func adobeCommerceEventAuthRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "event_auth_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signing_secret_ref"),
		adobeCommerceCredentialRef(integration),
	))
}
