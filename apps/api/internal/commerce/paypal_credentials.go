package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type PayPalRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type PayPalSecretsCredentialResolver struct {
	Secrets PayPalRuntimeSecretResolver
}

func NewPayPalSecretsCredentialResolver(secrets PayPalRuntimeSecretResolver) *PayPalSecretsCredentialResolver {
	return &PayPalSecretsCredentialResolver{Secrets: secrets}
}

func (r *PayPalSecretsCredentialResolver) ResolvePayPal(ctx context.Context, _ string, integration Integration) (PayPalCredentials, error) {
	if r == nil || r.Secrets == nil {
		return PayPalCredentials{}, fmt.Errorf("paypal credential resolver is not configured")
	}
	ref := payPalCredentialRef(integration)
	if ref == "" {
		return PayPalCredentials{}, fmt.Errorf("paypal credential_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return PayPalCredentials{}, err
	}
	creds.Environment = normalizePayPalEnvironment(firstNonEmpty(settingString(integration.Settings, "environment"), creds.Environment))
	if creds.WebhookID == "" {
		creds.WebhookID = settingString(integration.Settings, "webhook_id")
	}
	return creds, nil
}

func (r *PayPalSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (PayPalCredentials, error) {
	var payload payPalCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return PayPalCredentials{}, fmt.Errorf("resolve paypal credentials %q: %w", ref, err)
		}
		return parsePayPalCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return PayPalCredentials{}, fmt.Errorf("resolve paypal credentials %q: %w", ref, err)
	}
	return parsePayPalCredentialSecret(raw)
}

type payPalCredentialPayload struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	ID           string `json:"id"`
	Secret       string `json:"secret"`
	WebhookID    string `json:"webhook_id"`
	Environment  string `json:"environment"`
}

func (p payPalCredentialPayload) credentials() (PayPalCredentials, error) {
	clientID := strings.TrimSpace(firstNonEmpty(p.ClientID, p.ID))
	clientSecret := strings.TrimSpace(firstNonEmpty(p.ClientSecret, p.Secret))
	if clientID == "" || clientSecret == "" {
		return PayPalCredentials{}, fmt.Errorf("paypal client_id and client_secret are required")
	}
	return PayPalCredentials{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		WebhookID:    strings.TrimSpace(p.WebhookID),
		Environment:  normalizePayPalEnvironment(p.Environment),
	}, nil
}

func parsePayPalCredentialSecret(raw string) (PayPalCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return PayPalCredentials{}, fmt.Errorf("paypal credentials are empty")
	}
	var payload payPalCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return PayPalCredentials{}, fmt.Errorf("parse paypal credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parsePayPalKeyValueSecret(raw).credentials()
	}
	parts := strings.SplitN(raw, ":", 2)
	if len(parts) == 2 {
		return payPalCredentialPayload{ClientID: strings.TrimSpace(parts[0]), ClientSecret: strings.TrimSpace(parts[1])}.credentials()
	}
	return PayPalCredentials{}, fmt.Errorf("paypal credential secret must contain client_id and client_secret")
}

func parsePayPalKeyValueSecret(raw string) payPalCredentialPayload {
	var payload payPalCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "client_id", "id":
			payload.ClientID = strings.TrimSpace(parts[1])
		case "client_secret", "secret":
			payload.ClientSecret = strings.TrimSpace(parts[1])
		case "webhook_id":
			payload.WebhookID = strings.TrimSpace(parts[1])
		case "environment":
			payload.Environment = strings.TrimSpace(parts[1])
		}
	}
	return payload
}

func payPalCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}
