package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type SquarespaceRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type SquarespaceSecretsCredentialResolver struct {
	Secrets SquarespaceRuntimeSecretResolver
}

func NewSquarespaceSecretsCredentialResolver(secrets SquarespaceRuntimeSecretResolver) *SquarespaceSecretsCredentialResolver {
	return &SquarespaceSecretsCredentialResolver{Secrets: secrets}
}

func (r *SquarespaceSecretsCredentialResolver) ResolveSquarespace(ctx context.Context, _ string, integration Integration) (SquarespaceCredentials, error) {
	if r == nil || r.Secrets == nil {
		return SquarespaceCredentials{}, fmt.Errorf("squarespace credential resolver is not configured")
	}
	ref := squarespaceCredentialRef(integration)
	if ref == "" {
		return SquarespaceCredentials{}, fmt.Errorf("squarespace credential_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return SquarespaceCredentials{}, err
	}
	webhookRef := squarespaceWebhookSecretRef(integration)
	if webhookRef != "" && webhookRef != ref {
		webhookSecret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return SquarespaceCredentials{}, err
		}
		creds.WebhookSecret = webhookSecret
	}
	return creds, nil
}

func (r *SquarespaceSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (SquarespaceCredentials, error) {
	var payload squarespaceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return SquarespaceCredentials{}, fmt.Errorf("resolve squarespace credentials %q: %w", ref, err)
		}
		return parseSquarespaceCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SquarespaceCredentials{}, fmt.Errorf("resolve squarespace credentials %q: %w", ref, err)
	}
	return parseSquarespaceCredentialSecret(raw)
}

func (r *SquarespaceSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload squarespaceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve squarespace webhook secret %q: %w", ref, err)
		}
		return parseSquarespaceWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve squarespace webhook secret %q: %w", ref, err)
	}
	return parseSquarespaceWebhookSecret(raw)
}

type squarespaceCredentialPayload struct {
	AccessToken   string `json:"access_token"`
	APIKey        string `json:"api_key"`
	Token         string `json:"token"`
	BearerToken   string `json:"bearer_token"`
	WebhookSecret string `json:"webhook_secret"`
	SigningSecret string `json:"signing_secret"`
	Secret        string `json:"secret"`
	APIBaseURL    string `json:"api_base_url"`
	UserAgent     string `json:"user_agent"`
}

func (p squarespaceCredentialPayload) credentials() (SquarespaceCredentials, error) {
	token := normalizeSquarespaceBearerToken(firstNonEmpty(p.AccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return SquarespaceCredentials{}, fmt.Errorf("squarespace access_token or api_key is required")
	}
	webhook, _ := p.webhookSecret()
	return SquarespaceCredentials{
		AccessToken:   token,
		WebhookSecret: webhook,
		APIBaseURL:    strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:     strings.TrimSpace(p.UserAgent),
	}, nil
}

func (p squarespaceCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstNonEmpty(p.WebhookSecret, p.SigningSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("squarespace webhook secret is required")
	}
	return secret, nil
}

func parseSquarespaceCredentialSecret(raw string) (SquarespaceCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return SquarespaceCredentials{}, fmt.Errorf("squarespace credentials are empty")
	}
	var payload squarespaceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return SquarespaceCredentials{}, fmt.Errorf("parse squarespace credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseSquarespaceKeyValueSecret(raw)
		return payload.credentials()
	}
	return squarespaceCredentialPayload{AccessToken: normalizeSquarespaceBearerToken(raw)}.credentials()
}

func parseSquarespaceWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("squarespace webhook secret is empty")
	}
	var payload squarespaceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse squarespace webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseSquarespaceKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseSquarespaceKeyValueSecret(raw string) squarespaceCredentialPayload {
	var payload squarespaceCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token":
			payload.AccessToken = value
		case "api_key":
			payload.APIKey = value
		case "token":
			payload.Token = value
		case "bearer_token":
			payload.BearerToken = value
		case "webhook_secret", "webhook_signing_secret":
			payload.WebhookSecret = value
		case "signing_secret":
			payload.SigningSecret = value
		case "secret":
			payload.Secret = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeSquarespaceBearerToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "bearer ") {
		return strings.TrimSpace(raw[len("bearer "):])
	}
	return raw
}

func squarespaceCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}

func squarespaceWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signing_secret_ref"),
		squarespaceCredentialRef(integration),
	))
}
