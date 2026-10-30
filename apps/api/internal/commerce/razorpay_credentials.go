package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type RazorpayRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type RazorpaySecretsCredentialResolver struct {
	Secrets RazorpayRuntimeSecretResolver
}

func NewRazorpaySecretsCredentialResolver(secrets RazorpayRuntimeSecretResolver) *RazorpaySecretsCredentialResolver {
	return &RazorpaySecretsCredentialResolver{Secrets: secrets}
}

func (r *RazorpaySecretsCredentialResolver) ResolveRazorpay(ctx context.Context, _ string, integration Integration) (RazorpayCredentials, error) {
	if r == nil || r.Secrets == nil {
		return RazorpayCredentials{}, fmt.Errorf("razorpay credential resolver is not configured")
	}
	ref := razorpayCredentialRef(integration)
	if ref == "" {
		return RazorpayCredentials{}, fmt.Errorf("razorpay credential_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return RazorpayCredentials{}, err
	}
	webhookRef := razorpayWebhookSecretRef(integration)
	if webhookRef != "" && webhookRef != ref {
		webhookSecret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return RazorpayCredentials{}, err
		}
		creds.WebhookSecret = webhookSecret
	}
	return creds, nil
}

func (r *RazorpaySecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (RazorpayCredentials, error) {
	var payload razorpayCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return RazorpayCredentials{}, fmt.Errorf("resolve razorpay credentials %q: %w", ref, err)
		}
		return parseRazorpayCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return RazorpayCredentials{}, fmt.Errorf("resolve razorpay credentials %q: %w", ref, err)
	}
	return parseRazorpayCredentialSecret(raw)
}

func (r *RazorpaySecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload razorpayCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve razorpay webhook secret %q: %w", ref, err)
		}
		return parseRazorpayWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve razorpay webhook secret %q: %w", ref, err)
	}
	return parseRazorpayWebhookSecret(raw)
}

type razorpayCredentialPayload struct {
	KeyID         string `json:"key_id"`
	KeySecret     string `json:"key_secret"`
	APIKey        string `json:"api_key"`
	APISecret     string `json:"api_secret"`
	ID            string `json:"id"`
	Secret        string `json:"secret"`
	WebhookSecret string `json:"webhook_secret"`
	SigningSecret string `json:"signing_secret"`
}

func (p razorpayCredentialPayload) credentials() (RazorpayCredentials, error) {
	keyID := strings.TrimSpace(firstNonEmpty(p.KeyID, p.APIKey, p.ID))
	keySecret := strings.TrimSpace(firstNonEmpty(p.KeySecret, p.APISecret, p.Secret))
	if keyID == "" || keySecret == "" {
		return RazorpayCredentials{}, fmt.Errorf("razorpay key_id and key_secret are required")
	}
	webhook, _ := p.webhookSecret()
	return RazorpayCredentials{KeyID: keyID, KeySecret: keySecret, WebhookSecret: webhook}, nil
}

func (p razorpayCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstNonEmpty(p.WebhookSecret, p.SigningSecret))
	if secret == "" {
		return "", fmt.Errorf("razorpay webhook secret is required")
	}
	return secret, nil
}

func parseRazorpayCredentialSecret(raw string) (RazorpayCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return RazorpayCredentials{}, fmt.Errorf("razorpay credentials are empty")
	}
	var payload razorpayCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return RazorpayCredentials{}, fmt.Errorf("parse razorpay credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseRazorpayKeyValueSecret(raw)
		return payload.credentials()
	}
	parts := strings.SplitN(raw, ":", 2)
	if len(parts) == 2 {
		return razorpayCredentialPayload{KeyID: strings.TrimSpace(parts[0]), KeySecret: strings.TrimSpace(parts[1])}.credentials()
	}
	return RazorpayCredentials{}, fmt.Errorf("razorpay credential secret must contain key_id and key_secret")
}

func parseRazorpayWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("razorpay webhook secret is empty")
	}
	var payload razorpayCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse razorpay webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseRazorpayKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseRazorpayKeyValueSecret(raw string) razorpayCredentialPayload {
	var payload razorpayCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "key_id", "api_key", "id":
			payload.KeyID = strings.TrimSpace(parts[1])
		case "key_secret", "api_secret", "secret":
			payload.KeySecret = strings.TrimSpace(parts[1])
		case "webhook_secret", "signing_secret":
			payload.WebhookSecret = strings.TrimSpace(parts[1])
		}
	}
	return payload
}

func razorpayCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}

func razorpayWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signing_secret_ref"),
		razorpayCredentialRef(integration),
	))
}
