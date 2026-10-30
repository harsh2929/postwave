package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type StripeRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type StripeSecretsCredentialResolver struct {
	Secrets StripeRuntimeSecretResolver
}

func NewStripeSecretsCredentialResolver(secrets StripeRuntimeSecretResolver) *StripeSecretsCredentialResolver {
	return &StripeSecretsCredentialResolver{Secrets: secrets}
}

func (r *StripeSecretsCredentialResolver) ResolveStripe(ctx context.Context, _ string, integration Integration) (StripeCredentials, error) {
	if r == nil || r.Secrets == nil {
		return StripeCredentials{}, fmt.Errorf("stripe credential resolver is not configured")
	}
	ref := stripeCredentialRef(integration)
	if ref == "" {
		return StripeCredentials{}, fmt.Errorf("stripe credential_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return StripeCredentials{}, err
	}
	webhookRef := stripeWebhookSecretRef(integration)
	if webhookRef != "" && webhookRef != ref {
		webhook, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return StripeCredentials{}, err
		}
		creds.WebhookSecret = webhook
	}
	return creds, nil
}

func (r *StripeSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (StripeCredentials, error) {
	var payload stripeCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return StripeCredentials{}, fmt.Errorf("resolve stripe credentials %q: %w", ref, err)
		}
		return parseStripeCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return StripeCredentials{}, fmt.Errorf("resolve stripe credentials %q: %w", ref, err)
	}
	return parseStripeCredentialSecret(raw)
}

func (r *StripeSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload stripeCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve stripe webhook secret %q: %w", ref, err)
		}
		return parseStripeWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve stripe webhook secret %q: %w", ref, err)
	}
	return parseStripeWebhookSecret(raw)
}

type stripeCredentialPayload struct {
	SecretKey      string `json:"secret_key"`
	RestrictedKey  string `json:"restricted_key"`
	APIKey         string `json:"api_key"`
	Token          string `json:"token"`
	Key            string `json:"key"`
	WebhookSecret  string `json:"webhook_secret"`
	EndpointSecret string `json:"endpoint_secret"`
	SigningSecret  string `json:"signing_secret"`
}

func (p stripeCredentialPayload) credentials() (StripeCredentials, error) {
	apiKey := strings.TrimSpace(firstNonEmpty(p.RestrictedKey, p.SecretKey, p.APIKey, p.Token, p.Key))
	apiKey = strings.TrimPrefix(apiKey, "Bearer ")
	apiKey = strings.TrimPrefix(apiKey, "bearer ")
	if apiKey == "" {
		return StripeCredentials{}, fmt.Errorf("stripe restricted key is required")
	}
	webhook, _ := p.webhookSecret()
	return StripeCredentials{APIKey: apiKey, WebhookSecret: webhook}, nil
}

func (p stripeCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstNonEmpty(p.WebhookSecret, p.EndpointSecret, p.SigningSecret))
	if secret == "" {
		return "", fmt.Errorf("stripe webhook secret is required")
	}
	return secret, nil
}

func parseStripeCredentialSecret(raw string) (StripeCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return StripeCredentials{}, fmt.Errorf("stripe credentials are empty")
	}
	var payload stripeCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return StripeCredentials{}, fmt.Errorf("parse stripe credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseStripeKeyValueSecret(raw)
		return payload.credentials()
	}
	return stripeCredentialPayload{APIKey: raw}.credentials()
}

func parseStripeWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("stripe webhook secret is empty")
	}
	var payload stripeCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse stripe webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseStripeKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseStripeKeyValueSecret(raw string) stripeCredentialPayload {
	var payload stripeCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "secret_key", "restricted_key", "api_key", "token", "key":
			payload.APIKey = strings.TrimSpace(parts[1])
		case "webhook_secret", "endpoint_secret", "signing_secret":
			payload.WebhookSecret = strings.TrimSpace(parts[1])
		}
	}
	return payload
}

func stripeCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}

func stripeWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_endpoint_secret_ref"),
		stripeCredentialRef(integration),
	))
}
