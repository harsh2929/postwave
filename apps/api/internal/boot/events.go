// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"log/slog"
	"os"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/events"
)

// EventBusDependencies is the event transport boundary consumed by the API
// composition root. Bus always remains usable: Redis activation upgrades it
// to cross-replica fan-out, while every optional-dependency failure retains
// the default in-process backend.
type EventBusDependencies struct {
	Bus         *events.Bus
	RedisActive bool
}

type redisEventBackendFactory func(string, *events.Bus, *slog.Logger) (events.Backend, error)

type eventBusStartupDependencies struct {
	redisURL        string
	logger          *slog.Logger
	newRedisBackend redisEventBackendFactory
}

// InitializeEventBus builds the process event bus, presence tracker, and
// optional Redis relay from the runtime environment.
func InitializeEventBus(logger *slog.Logger) EventBusDependencies {
	return initializeEventBus(eventBusStartupDependencies{
		redisURL:        os.Getenv("REDIS_URL"),
		logger:          logger,
		newRedisBackend: newRedisEventBackend,
	})
}

func initializeEventBus(dependencies eventBusStartupDependencies) EventBusDependencies {
	bus := events.NewBus()
	_ = events.NewPresence(bus)
	result := EventBusDependencies{Bus: bus}

	redisURL := strings.TrimSpace(dependencies.redisURL)
	if redisURL == "" {
		dependencies.logger.Info("events: no REDIS_URL set, using in-process MemBackend (single-replica mode)")
		return result
	}

	backend, err := dependencies.newRedisBackend(redisURL, bus, dependencies.logger)
	if err != nil {
		dependencies.logger.Warn("events: REDIS_URL set but dial failed; using in-process backend",
			"err", err.Error())
		return result
	}
	if err := backend.Start(); err != nil {
		dependencies.logger.Warn("events: REDIS_URL set but subscribe failed; using in-process backend",
			"err", err.Error())
		return result
	}

	bus.SetBackend(backend)
	result.RedisActive = true
	dependencies.logger.Info("events: REDIS_URL set, RedisBackend active for cross-replica fan-out")
	return result
}

func newRedisEventBackend(redisURL string, bus *events.Bus, logger *slog.Logger) (events.Backend, error) {
	return events.NewRedisBackend(redisURL, bus, logger)
}
