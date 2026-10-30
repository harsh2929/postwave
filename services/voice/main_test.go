package main

import (
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/config"
	"github.com/postwave/postwave/services/voice/internal/fidelity"
)

func TestFidelityEmbeddingClientDevAllowsMock(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")

	emb, err := fidelityEmbeddingClient(config.Config{})
	if err != nil {
		t.Fatalf("fidelityEmbeddingClient dev: %v", err)
	}
	if _, ok := emb.(*fidelity.MockEmbeddingClient); !ok {
		t.Fatalf("expected dev fallback mock, got %T", emb)
	}
}

func TestFidelityEmbeddingClientProductionRequiresOpenAIKey(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")

	emb, err := fidelityEmbeddingClient(config.Config{})
	if err == nil {
		t.Fatalf("expected production config error, got emb=%T", emb)
	}
	if !strings.Contains(err.Error(), "OPENAI_API_KEY") {
		t.Fatalf("expected OPENAI_API_KEY guidance, got %v", err)
	}
}

func TestFidelityEmbeddingClientProductionUsesOpenAIWhenConfigured(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")

	emb, err := fidelityEmbeddingClient(config.Config{OpenAIAPIKey: "sk_test"})
	if err != nil {
		t.Fatalf("fidelityEmbeddingClient prod with key: %v", err)
	}
	client, ok := emb.(*fidelity.OpenAIClient)
	if !ok {
		t.Fatalf("expected OpenAI client, got %T", emb)
	}
	if client.APIKey != "sk_test" {
		t.Fatalf("unexpected API key on client")
	}
}
