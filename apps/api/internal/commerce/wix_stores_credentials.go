package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type WixStoresRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type WixStoresSecretsCredentialResolver struct {
	Secrets WixStoresRuntimeSecretResolver
}

func NewWixStoresSecretsCredentialResolver(secrets WixStoresRuntimeSecretResolver) *WixStoresSecretsCredentialResolver {
	return &WixStoresSecretsCredentialResolver{Secrets: secrets}
}

func (r *WixStoresSecretsCredentialResolver) ResolveWixStores(ctx context.Context, _ string, integration Integration) (WixStoresCredentials, error) {
	if r == nil || r.Secrets == nil {
		return WixStoresCredentials{}, fmt.Errorf("wix stores credential resolver is not configured")
	}
	ref := wixStoresCredentialRef(integration)
	if ref == "" {
		return WixStoresCredentials{}, fmt.Errorf("wix stores credential_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return WixStoresCredentials{}, err
	}
	if creds.InstanceID == "" {
		creds.InstanceID = strings.TrimSpace(settingString(integration.Settings, "instance_id"))
	}
	webhookRef := wixStoresWebhookSecretRef(integration)
	if webhookRef != "" && webhookRef != ref {
		webhookSecret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return WixStoresCredentials{}, err
		}
		creds.WebhookSecret = webhookSecret
	}
	publicKeyRef := wixStoresWebhookPublicKeyRef(integration)
	if publicKeyRef != "" && publicKeyRef != ref {
		publicKey, err := r.resolveWebhookPublicKey(ctx, publicKeyRef)
		if err != nil {
			return WixStoresCredentials{}, err
		}
		creds.WebhookPublicKey = publicKey
	}
	return creds, nil
}

func (r *WixStoresSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (WixStoresCredentials, error) {
	var payload wixStoresCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return WixStoresCredentials{}, fmt.Errorf("resolve wix stores credentials %q: %w", ref, err)
		}
		return parseWixStoresCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return WixStoresCredentials{}, fmt.Errorf("resolve wix stores credentials %q: %w", ref, err)
	}
	return parseWixStoresCredentialSecret(raw)
}

func (r *WixStoresSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload wixStoresCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve wix stores webhook secret %q: %w", ref, err)
		}
		return parseWixStoresWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve wix stores webhook secret %q: %w", ref, err)
	}
	return parseWixStoresWebhookSecret(raw)
}

func (r *WixStoresSecretsCredentialResolver) resolveWebhookPublicKey(ctx context.Context, ref string) (string, error) {
	var payload wixStoresCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookPublicKey()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve wix stores webhook public key %q: %w", ref, err)
		}
		return parseWixStoresWebhookPublicKey(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve wix stores webhook public key %q: %w", ref, err)
	}
	return parseWixStoresWebhookPublicKey(raw)
}

type wixStoresCredentialPayload struct {
	AccessToken         string `json:"access_token"`
	Token               string `json:"token"`
	BearerToken         string `json:"bearer_token"`
	ClientID            string `json:"client_id"`
	AppID               string `json:"app_id"`
	ClientSecret        string `json:"client_secret"`
	AppSecret           string `json:"app_secret"`
	InstanceID          string `json:"instance_id"`
	WebhookSecret       string `json:"webhook_secret"`
	SigningSecret       string `json:"signing_secret"`
	Secret              string `json:"secret"`
	WebhookPublicKey    string `json:"webhook_public_key"`
	WebhookPublicKeyPEM string `json:"webhook_public_key_pem"`
	PublicKey           string `json:"public_key"`
	APIBaseURL          string `json:"api_base_url"`
	TokenURL            string `json:"token_url"`
}

func (p wixStoresCredentialPayload) credentials() (WixStoresCredentials, error) {
	token := normalizeWixBearerToken(firstNonEmpty(p.AccessToken, p.Token, p.BearerToken))
	clientID := strings.TrimSpace(firstNonEmpty(p.ClientID, p.AppID))
	clientSecret := strings.TrimSpace(firstNonEmpty(p.ClientSecret, p.AppSecret))
	if token == "" && (clientID == "" || clientSecret == "" || strings.TrimSpace(p.InstanceID) == "") {
		return WixStoresCredentials{}, fmt.Errorf("wix stores access_token or client_id/client_secret/instance_id are required")
	}
	webhook, _ := p.webhookSecret()
	publicKey, _ := p.webhookPublicKey()
	return WixStoresCredentials{
		AccessToken:      token,
		ClientID:         clientID,
		ClientSecret:     clientSecret,
		InstanceID:       strings.TrimSpace(p.InstanceID),
		WebhookSecret:    webhook,
		WebhookPublicKey: publicKey,
		AppID:            strings.TrimSpace(p.AppID),
		APIBaseURL:       strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		TokenURL:         strings.TrimSpace(p.TokenURL),
	}, nil
}

func (p wixStoresCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstNonEmpty(p.WebhookSecret, p.SigningSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("wix stores webhook secret is required")
	}
	return secret, nil
}

func (p wixStoresCredentialPayload) webhookPublicKey() (string, error) {
	publicKey := strings.TrimSpace(firstNonEmpty(p.WebhookPublicKey, p.WebhookPublicKeyPEM, p.PublicKey))
	if publicKey == "" {
		return "", fmt.Errorf("wix stores webhook public key is required")
	}
	return publicKey, nil
}

func parseWixStoresCredentialSecret(raw string) (WixStoresCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return WixStoresCredentials{}, fmt.Errorf("wix stores credentials are empty")
	}
	var payload wixStoresCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return WixStoresCredentials{}, fmt.Errorf("parse wix stores credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseWixStoresKeyValueSecret(raw)
		return payload.credentials()
	}
	return wixStoresCredentialPayload{AccessToken: normalizeWixBearerToken(raw)}.credentials()
}

func parseWixStoresWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("wix stores webhook secret is empty")
	}
	var payload wixStoresCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse wix stores webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseWixStoresKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseWixStoresWebhookPublicKey(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("wix stores webhook public key is empty")
	}
	var payload wixStoresCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse wix stores webhook public key JSON: %w", err)
		}
		return payload.webhookPublicKey()
	}
	if strings.Contains(raw, "=") {
		return parseWixStoresKeyValueSecret(raw).webhookPublicKey()
	}
	return raw, nil
}

func parseWixStoresKeyValueSecret(raw string) wixStoresCredentialPayload {
	var payload wixStoresCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token", "token", "bearer_token":
			payload.AccessToken = value
		case "client_id", "app_id":
			payload.ClientID = value
		case "client_secret", "app_secret":
			payload.ClientSecret = value
		case "instance_id":
			payload.InstanceID = value
		case "webhook_secret", "signing_secret":
			payload.WebhookSecret = value
		case "secret":
			payload.Secret = value
		case "webhook_public_key", "webhook_public_key_pem", "public_key":
			payload.WebhookPublicKey = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "token_url":
			payload.TokenURL = value
		}
	}
	return payload
}

func normalizeWixBearerToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "bearer ") {
		return strings.TrimSpace(raw[len("bearer "):])
	}
	return raw
}

func wixStoresCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}

func wixStoresWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signing_secret_ref"),
		wixStoresCredentialRef(integration),
	))
}

func wixStoresWebhookPublicKeyRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "webhook_public_key_ref"),
		settingString(integration.Settings, "wix_public_key_ref"),
		wixStoresCredentialRef(integration),
	))
}
