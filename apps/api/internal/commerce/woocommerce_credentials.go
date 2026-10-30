package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type WooCommerceRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type WooCommerceSecretsCredentialResolver struct {
	Secrets WooCommerceRuntimeSecretResolver
}

func NewWooCommerceSecretsCredentialResolver(secrets WooCommerceRuntimeSecretResolver) *WooCommerceSecretsCredentialResolver {
	return &WooCommerceSecretsCredentialResolver{Secrets: secrets}
}

func (r *WooCommerceSecretsCredentialResolver) ResolveWooCommerce(ctx context.Context, _ string, integration Integration) (WooCommerceCredentials, error) {
	if r == nil || r.Secrets == nil {
		return WooCommerceCredentials{}, fmt.Errorf("woocommerce credential resolver is not configured")
	}
	ref := wooCommerceCredentialRef(integration)
	if ref == "" {
		return WooCommerceCredentials{}, fmt.Errorf("woocommerce credential_ref is required")
	}
	var payload wooCommerceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return WooCommerceCredentials{}, fmt.Errorf("resolve woocommerce credentials %q: %w", ref, err)
		}
		creds, parseErr := parseWooCommerceCredentialSecret(raw)
		if parseErr != nil {
			return WooCommerceCredentials{}, parseErr
		}
		return creds, nil
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return WooCommerceCredentials{}, fmt.Errorf("resolve woocommerce credentials %q: %w", ref, err)
	}
	return parseWooCommerceCredentialSecret(raw)
}

type wooCommerceCredentialPayload struct {
	ConsumerKey    string `json:"consumer_key"`
	ConsumerSecret string `json:"consumer_secret"`
	Key            string `json:"key"`
	Secret         string `json:"secret"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	CK             string `json:"ck"`
	CS             string `json:"cs"`
}

func (p wooCommerceCredentialPayload) credentials() (WooCommerceCredentials, error) {
	creds := WooCommerceCredentials{
		ConsumerKey: firstNonEmpty(p.ConsumerKey, p.Key, p.Username, p.CK),
		ConsumerSecret: firstNonEmpty(
			p.ConsumerSecret,
			p.Secret,
			p.Password,
			p.CS,
		),
	}
	creds.ConsumerKey = strings.TrimSpace(creds.ConsumerKey)
	creds.ConsumerSecret = strings.TrimSpace(creds.ConsumerSecret)
	if creds.ConsumerKey == "" || creds.ConsumerSecret == "" {
		return WooCommerceCredentials{}, fmt.Errorf("woocommerce credentials are incomplete")
	}
	return creds, nil
}

func parseWooCommerceCredentialSecret(raw string) (WooCommerceCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return WooCommerceCredentials{}, fmt.Errorf("woocommerce credentials are empty")
	}
	var payload wooCommerceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return WooCommerceCredentials{}, fmt.Errorf("parse woocommerce credential JSON: %w", err)
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
			case "consumer_key", "key", "username", "ck":
				payload.ConsumerKey = strings.TrimSpace(parts[1])
			case "consumer_secret", "secret", "password", "cs":
				payload.ConsumerSecret = strings.TrimSpace(parts[1])
			}
		}
		return payload.credentials()
	}
	if before, after, ok := strings.Cut(raw, ":"); ok {
		return wooCommerceCredentialPayload{ConsumerKey: before, ConsumerSecret: after}.credentials()
	}
	return WooCommerceCredentials{}, fmt.Errorf("woocommerce credentials must be JSON, key=value lines, or consumer_key:consumer_secret")
}

func wooCommerceCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "credential_ref"),
		settingString(integration.Settings, "credentials_ref"),
	))
}
