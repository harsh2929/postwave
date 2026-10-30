package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type SquareRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type SquareSecretsCredentialResolver struct {
	Secrets SquareRuntimeSecretResolver
}

func NewSquareSecretsCredentialResolver(secrets SquareRuntimeSecretResolver) *SquareSecretsCredentialResolver {
	return &SquareSecretsCredentialResolver{Secrets: secrets}
}

func (r *SquareSecretsCredentialResolver) ResolveSquare(ctx context.Context, _ string, integration Integration) (SquareCredentials, error) {
	if r == nil || r.Secrets == nil {
		return SquareCredentials{}, fmt.Errorf("square credential resolver is not configured")
	}
	ref := squareCredentialRef(integration)
	if ref == "" {
		return SquareCredentials{}, fmt.Errorf("square credential_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return SquareCredentials{}, err
	}
	signatureRef := squareWebhookSignatureRef(integration)
	if signatureRef != "" && signatureRef != ref {
		signatureKey, err := r.resolveSignatureSecret(ctx, signatureRef)
		if err != nil {
			return SquareCredentials{}, err
		}
		creds.WebhookSignatureKey = signatureKey
	}
	return creds, nil
}

func (r *SquareSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (SquareCredentials, error) {
	var payload squareCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return SquareCredentials{}, fmt.Errorf("resolve square credentials %q: %w", ref, err)
		}
		return parseSquareCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SquareCredentials{}, fmt.Errorf("resolve square credentials %q: %w", ref, err)
	}
	return parseSquareCredentialSecret(raw)
}

func (r *SquareSecretsCredentialResolver) resolveSignatureSecret(ctx context.Context, ref string) (string, error) {
	var payload squareCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.signatureKey()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve square webhook signature %q: %w", ref, err)
		}
		return parseSquareWebhookSignatureSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve square webhook signature %q: %w", ref, err)
	}
	return parseSquareWebhookSignatureSecret(raw)
}

type squareCredentialPayload struct {
	AccessToken         string `json:"access_token"`
	OAuthToken          string `json:"oauth_token"`
	AppToken            string `json:"app_token"`
	Token               string `json:"token"`
	BearerToken         string `json:"bearer_token"`
	WebhookSignatureKey string `json:"webhook_signature_key"`
	SignatureKey        string `json:"signature_key"`
}

func (p squareCredentialPayload) credentials() (SquareCredentials, error) {
	token := strings.TrimSpace(firstNonEmpty(p.AccessToken, p.OAuthToken, p.AppToken, p.Token, p.BearerToken))
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	if token == "" {
		return SquareCredentials{}, fmt.Errorf("square access token is required")
	}
	signature, _ := p.signatureKey()
	return SquareCredentials{AccessToken: token, WebhookSignatureKey: signature}, nil
}

func (p squareCredentialPayload) signatureKey() (string, error) {
	secret := strings.TrimSpace(firstNonEmpty(p.WebhookSignatureKey, p.SignatureKey))
	if secret == "" {
		return "", fmt.Errorf("square webhook signature key is required")
	}
	return secret, nil
}

func parseSquareCredentialSecret(raw string) (SquareCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return SquareCredentials{}, fmt.Errorf("square credentials are empty")
	}
	var payload squareCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return SquareCredentials{}, fmt.Errorf("parse square credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseSquareKeyValueSecret(raw)
		return payload.credentials()
	}
	return squareCredentialPayload{AccessToken: raw}.credentials()
}

func parseSquareWebhookSignatureSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("square webhook signature key is empty")
	}
	var payload squareCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse square webhook signature JSON: %w", err)
		}
		return payload.signatureKey()
	}
	if strings.Contains(raw, "=") {
		return parseSquareKeyValueSecret(raw).signatureKey()
	}
	return raw, nil
}

func parseSquareKeyValueSecret(raw string) squareCredentialPayload {
	var payload squareCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token", "oauth_token", "app_token", "token", "bearer_token":
			payload.AccessToken = strings.TrimSpace(parts[1])
		case "webhook_signature_key", "signature_key":
			payload.WebhookSignatureKey = strings.TrimSpace(parts[1])
		}
	}
	return payload
}

func squareCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}

func squareWebhookSignatureRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "signature_key_ref"),
		squareCredentialRef(integration),
	))
}
