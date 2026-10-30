// Package config loads runtime configuration for the voice service.
package config

import (
	"log/slog"
	"os"
)

// Config holds env-derived runtime settings.
type Config struct {
	Port        string
	LogLevel    string
	ListmonkURL string
	DatabaseURL string
	// InternalAPIToken protects sidecar-only HTTP routes when set.
	InternalAPIToken string
	// GeminiAPIKey powers profile generation and template generation
	// (Gemini 3 Flash). Migrated from the legacy ANTHROPIC_API_KEY env
	// var — see envOrLegacy below for the one-deploy migration window.
	GeminiAPIKey string
	// OpenAIAPIKey powers voice-fidelity embeddings (text-embedding-3-small).
	OpenAIAPIKey string
	// TwitterBearerToken supports public-post ingestion (no private account access).
	TwitterBearerToken string
	// AllowMemoryFallback permits in-memory stores if configured Postgres is
	// unavailable. Keep disabled outside local development.
	AllowMemoryFallback bool
}

// Load reads configuration from the process environment.
func Load() Config {
	return Config{
		Port:                env("PORT", "8083"),
		LogLevel:            env("LOG_LEVEL", "info"),
		ListmonkURL:         env("LISTMONK_URL", "http://localhost:9000"),
		DatabaseURL:         env("DATABASE_URL", "postgres://postwave_app:postwave_app_dev@localhost:5432/postwave?sslmode=disable"),
		InternalAPIToken:    env("POSTWAVE_INTERNAL_API_TOKEN", ""),
		GeminiAPIKey:        envOrLegacy("GEMINI_API_KEY", "ANTHROPIC_API_KEY"),
		OpenAIAPIKey:        env("OPENAI_API_KEY", ""),
		TwitterBearerToken:  env("TWITTER_BEARER_TOKEN", ""),
		AllowMemoryFallback: env("POSTWAVE_ALLOW_MEMORY_FALLBACK", "") == "1",
	}
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

// envOrLegacy returns the canonical env var if set; otherwise falls
// back to the legacy name with a one-shot deprecation warning. This
// gives operators a one-deploy migration window — they can leave the
// legacy ANTHROPIC_API_KEY set during cutover to GEMINI_API_KEY.
func envOrLegacy(canonical, legacy string) string {
	if v, ok := os.LookupEnv(canonical); ok && v != "" {
		return v
	}
	if v, ok := os.LookupEnv(legacy); ok && v != "" {
		slog.Warn("voice: legacy env var in use; migrate to canonical name",
			"legacy", legacy,
			"canonical", canonical)
		return v
	}
	return ""
}
