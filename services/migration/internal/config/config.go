// Package config loads runtime configuration for the migration service.
package config

import "os"

// Config holds env-derived runtime settings.
type Config struct {
	Port        string
	LogLevel    string
	ListmonkURL string
	DatabaseURL string
	// InternalAPIToken protects sidecar-only HTTP routes when set.
	InternalAPIToken string
	// StripeSecretKey is used only by source adapters that explicitly support
	// the shared Stripe reader (currently Kit/ConvertKit, not Substack).
	StripeSecretKey string
	// InngestEventKey drives durable migration jobs.
	InngestEventKey string
	// MigrationSessionKEK encrypts source OAuth/API sessions persisted by the
	// migration service. Use a 32-byte random value in production.
	MigrationSessionKEK string
	// AllowMemoryFallback permits in-memory jobs if configured Postgres is
	// unavailable. Keep disabled outside local development.
	AllowMemoryFallback bool
}

// Load reads configuration from the process environment.
func Load() Config {
	return Config{
		Port:                env("PORT", "8081"),
		LogLevel:            env("LOG_LEVEL", "info"),
		ListmonkURL:         env("LISTMONK_URL", "http://localhost:9000"),
		DatabaseURL:         env("DATABASE_URL", "postgres://postwave_app:postwave_app_dev@localhost:5432/postwave?sslmode=disable"),
		InternalAPIToken:    env("POSTWAVE_INTERNAL_API_TOKEN", ""),
		StripeSecretKey:     env("STRIPE_SECRET_KEY", ""),
		InngestEventKey:     env("INNGEST_EVENT_KEY", ""),
		MigrationSessionKEK: env("POSTWAVE_MIGRATION_SESSION_KEK", ""),
		AllowMemoryFallback: env("POSTWAVE_ALLOW_MEMORY_FALLBACK", "") == "1",
	}
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
