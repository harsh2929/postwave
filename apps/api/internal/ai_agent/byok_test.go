// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeStore struct {
	cfg *LLMConfig
	err error
}

func (f fakeStore) Get(context.Context, string) (*LLMConfig, error) { return f.cfg, f.err }

func TestNewBYOKResolver(t *testing.T) {
	withTenant := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})

	cases := []struct {
		name    string
		store   LLMConfigStore
		ctx     context.Context
		wantLLM bool
		wantErr bool
	}{
		{"configured -> per-tenant client", fakeStore{cfg: &LLMConfig{Provider: "anthropic", Model: "m", APIKey: "sk-x"}}, withTenant, true, false},
		{"default provider -> anthropic client", fakeStore{cfg: &LLMConfig{APIKey: "sk-x"}}, withTenant, true, false},
		{"no config -> platform fallback", fakeStore{cfg: nil}, withTenant, false, false},
		{"empty configured key -> fail closed", fakeStore{cfg: &LLMConfig{APIKey: "   "}}, withTenant, false, true},
		{"store/decrypt error -> fail closed", fakeStore{err: errors.New("db down")}, withTenant, false, true},
		{"unsupported provider -> fail closed", fakeStore{cfg: &LLMConfig{Provider: "openai", APIKey: "sk-x"}}, withTenant, false, true},
		{"no tenant -> fail closed", fakeStore{cfg: &LLMConfig{APIKey: "sk-x"}}, context.Background(), false, true},
		{"nil store -> fail closed", nil, withTenant, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := NewBYOKResolver(c.store)(c.ctx)
			if (got != nil) != c.wantLLM {
				t.Fatalf("resolver returned llm=%v, want %v", got != nil, c.wantLLM)
			}
			if (err != nil) != c.wantErr {
				t.Fatalf("resolver error=%v, wantErr=%v", err, c.wantErr)
			}
			if err != nil && !errors.Is(err, ErrBYOKResolution) {
				t.Fatalf("resolver error %v does not mark BYOK resolution failure", err)
			}
		})
	}
}

func TestNormalizeLLMProvider(t *testing.T) {
	for _, in := range []string{"", "anthropic", " ANTHROPIC "} {
		if got, err := normalizeLLMProvider(in); err != nil || got != "anthropic" {
			t.Fatalf("normalizeLLMProvider(%q) = %q, %v", in, got, err)
		}
	}
	if _, err := normalizeLLMProvider("openai"); !errors.Is(err, ErrUnsupportedLLMProvider) {
		t.Fatalf("openai must be rejected, got %v", err)
	}
}
