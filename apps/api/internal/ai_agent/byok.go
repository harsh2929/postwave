// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// LLMConfig is a tenant's decrypted BYOK LLM provider configuration.
type LLMConfig struct {
	Provider string
	Model    string
	APIKey   string
}

// tenantCipher is the narrow encrypt/decrypt surface the BYOK store needs —
// satisfied by *byok.Composite. Kept as an interface so the store is
// unit-testable with a fake.
type tenantCipher interface {
	EncryptForTenant(ctx context.Context, tenantID string, plaintext []byte) ([]byte, error)
	DecryptForTenant(ctx context.Context, tenantID string, blob []byte) ([]byte, error)
}

// LLMConfigStore is what the resolver needs: read a tenant's config.
type LLMConfigStore interface {
	Get(ctx context.Context, tenantID string) (*LLMConfig, error)
}

// LLMConfigRepo persists per-tenant BYOK LLM config in ai_llm_provider_config,
// with the API key encrypted at rest via the byok Composite cipher.
type LLMConfigRepo struct {
	Pool   *db.Pool
	Cipher tenantCipher
}

var _ LLMConfigStore = (*LLMConfigRepo)(nil)

var (
	// ErrUnsupportedLLMProvider prevents a credential for one provider from
	// ever being sent to another provider's endpoint. Anthropic is the only
	// provider currently implemented by the in-app agent.
	ErrUnsupportedLLMProvider = errors.New("ai_agent: unsupported LLM provider")
	// ErrBYOKResolution marks configured-key failures. Callers must fail closed
	// rather than silently routing the tenant's prompt through platform billing.
	ErrBYOKResolution = errors.New("ai_agent: tenant LLM configuration unavailable")
)

func normalizeLLMProvider(provider string) (string, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		provider = "anthropic"
	}
	if provider != "anthropic" {
		return "", fmt.Errorf("%w: %q", ErrUnsupportedLLMProvider, provider)
	}
	return provider, nil
}

// Get loads + decrypts the tenant's config. Returns (nil, nil) when no row
// exists (the caller falls back to the platform key).
func (r *LLMConfigRepo) Get(ctx context.Context, tenantID string) (*LLMConfig, error) {
	if r == nil || r.Pool == nil || r.Cipher == nil {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var provider, model string
	var ciphertext []byte
	err = tx.QueryRow(ctx, `
SELECT provider, COALESCE(model, ''), api_key_ciphertext
  FROM ai_llm_provider_config
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&provider, &model, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := r.Cipher.DecryptForTenant(ctx, tenantID, ciphertext)
	if err != nil {
		return nil, err
	}
	return &LLMConfig{Provider: provider, Model: model, APIKey: string(plain)}, nil
}

// Set encrypts + upserts the tenant's config.
func (r *LLMConfigRepo) Set(ctx context.Context, tenantID, provider, model, plaintextKey string) error {
	if r == nil || r.Pool == nil || r.Cipher == nil {
		return errors.New("ai_agent: BYOK store not configured")
	}
	provider, err := normalizeLLMProvider(provider)
	if err != nil {
		return err
	}
	if strings.TrimSpace(plaintextKey) == "" {
		return errors.New("ai_agent: API key is required")
	}
	ciphertext, err := r.Cipher.EncryptForTenant(ctx, tenantID, []byte(plaintextKey))
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO ai_llm_provider_config (tenant_id, provider, model, api_key_ciphertext)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id) DO UPDATE SET
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    api_key_ciphertext = EXCLUDED.api_key_ciphertext,
    updated_at = now()`, tenantID, provider, strings.TrimSpace(model), ciphertext); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// NewBYOKResolver returns an LLMFor function for ChatHandler. (nil, nil)
// means the tenant has no provider credential and may use the platform
// default. Any storage, decryption, malformed-row, or provider error is
// returned so the handler fails closed and never sends the prompt elsewhere.
func NewBYOKResolver(store LLMConfigStore) func(ctx context.Context) (LLMClient, error) {
	return func(ctx context.Context) (LLMClient, error) {
		if store == nil {
			return nil, fmt.Errorf("%w: store is not configured", ErrBYOKResolution)
		}
		t, ok := middleware.TenantFromContext(ctx)
		if !ok || t == nil {
			return nil, fmt.Errorf("%w: tenant is missing", ErrBYOKResolution)
		}
		cfg, err := store.Get(ctx, t.ID)
		if err != nil {
			return nil, fmt.Errorf("%w: load/decrypt: %v", ErrBYOKResolution, err)
		}
		if cfg == nil {
			return nil, nil
		}
		if strings.TrimSpace(cfg.APIKey) == "" {
			return nil, fmt.Errorf("%w: configured credential is empty", ErrBYOKResolution)
		}
		provider, err := normalizeLLMProvider(cfg.Provider)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBYOKResolution, err)
		}
		switch provider {
		case "anthropic":
			return NewAnthropicLLM(AnthropicConfig{APIKey: cfg.APIKey, Model: cfg.Model}), nil
		default:
			// normalizeLLMProvider currently makes this unreachable. Keep the
			// switch exhaustive so adding a provider requires an explicit client.
			return nil, fmt.Errorf("%w: %q", ErrBYOKResolution, provider)
		}
	}
}
