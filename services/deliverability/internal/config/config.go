// Package config loads runtime configuration for the deliverability service.
package config

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
)

// Config holds env-derived runtime settings.
type Config struct {
	Port        string
	LogLevel    string
	ListmonkURL string
	DatabaseURL string
	// InternalAPIToken protects sidecar-only HTTP routes when set.
	InternalAPIToken string
	// The exact-artifact Inbox Reality lifecycle is independently gated. The
	// signing set supports overlap rotation; the first secret signs callbacks.
	InboxRealityLifecycleEnabled    bool
	InboxRealitySigningSecrets      string
	InboxRealityGatewayURL          string
	InboxRealitySESRegion           string
	InboxRealitySESConfigurationSet string
	// DurableControlledSeedRegistryEnabled publishes the existing secret-backed
	// seed registry as immutable database revisions before polling/dispatch.
	DurableControlledSeedRegistryEnabled bool
	// GeminiAPIKey powers the AI Diagnostician (Gemini 3 Pro) and the
	// optional Pre-Send Predictor blend (Gemini 3 Flash).
	GeminiAPIKey string
	// PostmasterCredentials and MicrosoftSNDSKey feed the reputation layer.
	PostmasterCredentials string
	MicrosoftSNDSKey      string
	// HTMLCSStoImageKey drives in-editor cross-client preview.
	HTMLCSStoImageKey string
	// SeedlistConfigPath points to a YAML or JSON seed inbox registry.
	SeedlistConfigPath string
	// SeedMIMECaptureEnabled gates durable full-message acquisition during the
	// staged rollout. When true, S3 bucket/KMS/region configuration is required.
	SeedMIMECaptureEnabled     bool
	SeedObservationS3Bucket    string
	SeedObservationS3Prefix    string
	SeedObservationKMSKeyID    string
	SeedObservationAWSRegion   string
	SeedObservationBucketOwner string
}

// Load reads configuration from the process environment.
//
// GEMINI_API_KEY is the canonical name; ANTHROPIC_API_KEY is accepted
// for one deploy cycle with a deprecation warn so operators have a
// migration window after the Anthropic -> Gemini cutover.
func Load() Config {
	return Config{
		Port:                                 env("PORT", "8082"),
		LogLevel:                             env("LOG_LEVEL", "info"),
		ListmonkURL:                          env("LISTMONK_URL", "http://localhost:9000"),
		DatabaseURL:                          env("DATABASE_URL", "postgres://postwave_app:postwave_app_dev@localhost:5432/postwave?sslmode=disable"),
		InternalAPIToken:                     env("POSTWAVE_INTERNAL_API_TOKEN", ""),
		InboxRealityLifecycleEnabled:         envBool("POSTWAVE_ENABLE_INBOX_REALITY_LIFECYCLE", false),
		InboxRealitySigningSecrets:           env("POSTWAVE_INBOX_REALITY_SIGNING_SECRETS", ""),
		InboxRealityGatewayURL:               env("POSTWAVE_API_BASE_URL", ""),
		InboxRealitySESRegion:                env("INBOX_REALITY_SES_REGION", env("AWS_REGION", "")),
		InboxRealitySESConfigurationSet:      env("INBOX_REALITY_SES_CONFIGURATION_SET", ""),
		DurableControlledSeedRegistryEnabled: envBool("POSTWAVE_ENABLE_DURABLE_SEED_REGISTRY", false),
		GeminiAPIKey:                         geminiKey(),
		PostmasterCredentials:                env("GOOGLE_POSTMASTER_CREDENTIALS", ""),
		MicrosoftSNDSKey:                     env("MICROSOFT_SNDS_KEY", ""),
		HTMLCSStoImageKey:                    env("HTMLCSSTOIMAGE_KEY", ""),
		SeedlistConfigPath:                   env("SEEDLIST_CONFIG_PATH", ""),
		SeedMIMECaptureEnabled:               envBool("SEED_MIME_CAPTURE_ENABLED", false),
		SeedObservationS3Bucket:              env("SEED_OBSERVATION_S3_BUCKET", ""),
		SeedObservationS3Prefix:              env("SEED_OBSERVATION_S3_PREFIX", "seed-observations"),
		SeedObservationKMSKeyID:              env("SEED_OBSERVATION_KMS_KEY_ID", env("POSTWAVE_KMS_KEY_ID", "")),
		SeedObservationAWSRegion:             env("SEED_OBSERVATION_AWS_REGION", env("AWS_REGION", "")),
		SeedObservationBucketOwner:           env("SEED_OBSERVATION_BUCKET_OWNER", ""),
	}
}

// geminiKey reads GEMINI_API_KEY, falling back to the legacy
// ANTHROPIC_API_KEY with a one-shot deprecation warn.
func geminiKey() string {
	if v, ok := os.LookupEnv("GEMINI_API_KEY"); ok && v != "" {
		return v
	}
	if v, ok := os.LookupEnv("ANTHROPIC_API_KEY"); ok && v != "" {
		slog.Warn("config: ANTHROPIC_API_KEY is deprecated; rename to GEMINI_API_KEY")
		return v
	}
	return ""
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	raw, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback
	}
	value, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		slog.Warn("config: invalid boolean; using fallback", "key", key)
		return fallback
	}
	return value
}
