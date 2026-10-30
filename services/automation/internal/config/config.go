// Package config loads runtime configuration for the automation runtime.
package config

import (
	"os"
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
	// RedisURL backs Asynq-style scheduling for wait nodes.
	RedisURL string
	// ListmonkAdminUser / ListmonkAdminPassword are sent as basic-auth on every
	// request to the Listmonk admin/transactional API.
	ListmonkAdminUser     string
	ListmonkAdminPassword string
	// AsynqQueueName is the queue name shared by client + server.
	AsynqQueueName string
	// WorkerConcurrency controls the Asynq server's worker count.
	WorkerConcurrency int
	// AllowMemoryFallback permits in-memory state if configured Postgres is
	// unavailable. Keep disabled outside local development.
	AllowMemoryFallback bool
	// CampaignLiveDispatchEnabled and CampaignSchedulerEnabled are runtime
	// intent only. Shared compile-time qualification must also pass before this
	// service may materialize recurring campaign children.
	CampaignLiveDispatchEnabled bool
	CampaignSchedulerEnabled    bool
}

// Load reads configuration from the process environment.
func Load() Config {
	return Config{
		Port:                        env("PORT", "8084"),
		LogLevel:                    env("LOG_LEVEL", "info"),
		ListmonkURL:                 env("LISTMONK_URL", "http://localhost:9000"),
		DatabaseURL:                 env("DATABASE_URL", "postgres://postwave_app:postwave_app_dev@localhost:5432/postwave?sslmode=disable"),
		InternalAPIToken:            env("POSTWAVE_INTERNAL_API_TOKEN", ""),
		RedisURL:                    env("REDIS_URL", "redis://localhost:6379/0"),
		ListmonkAdminUser:           env("LISTMONK_ADMIN_USER", "listmonk"),
		ListmonkAdminPassword:       env("LISTMONK_ADMIN_PASSWORD", ""),
		AsynqQueueName:              env("AUTOMATION_QUEUE", "automation_default"),
		WorkerConcurrency:           10,
		AllowMemoryFallback:         env("POSTWAVE_ALLOW_MEMORY_FALLBACK", "") == "1",
		CampaignLiveDispatchEnabled: envBool("POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH"),
		CampaignSchedulerEnabled:    envBool("POSTWAVE_ENABLE_CAMPAIGN_SCHEDULER"),
	}
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
