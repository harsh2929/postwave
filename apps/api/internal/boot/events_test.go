// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/events"
)

type eventBackendStub struct {
	startErr   error
	startCalls int
}

func (*eventBackendStub) Publish(events.Event) error { return nil }

func (backend *eventBackendStub) Start() error {
	backend.startCalls++
	return backend.startErr
}

func (*eventBackendStub) Stop() error { return nil }

func TestInitializeEventBusUsesMemoryBackendWithoutRedis(t *testing.T) {
	t.Setenv("REDIS_URL", "  ")
	logger, logs := eventBusTestLogger()

	dependencies := InitializeEventBus(logger)
	if dependencies.Bus == nil {
		t.Fatal("InitializeEventBus() returned a nil bus")
	}
	if dependencies.RedisActive {
		t.Fatal("InitializeEventBus() marked Redis active without REDIS_URL")
	}
	if _, ok := dependencies.Bus.Backend().(*events.MemBackend); !ok {
		t.Fatalf("backend = %T, want *events.MemBackend", dependencies.Bus.Backend())
	}
	if !strings.Contains(logs.String(), "events: no REDIS_URL set, using in-process MemBackend (single-replica mode)") {
		t.Fatalf("startup log = %s", logs.String())
	}

	// Presence is part of the boot boundary: the first subscriber should see
	// its own presence.update event through the default memory backend.
	subscriber := dependencies.Bus.Subscribe("tenant-1", []string{"presence.*"})
	defer dependencies.Bus.Unsubscribe(subscriber)
	select {
	case event := <-subscriber.Ch:
		if event.Topic != "presence.update" {
			t.Fatalf("presence event topic = %q", event.Topic)
		}
	case <-time.After(time.Second):
		t.Fatal("presence tracker was not installed")
	}
}

func TestInitializeEventBusActivatesRedisBackend(t *testing.T) {
	logger, logs := eventBusTestLogger()
	backend := &eventBackendStub{}
	var factoryURL string
	var factoryBus *events.Bus

	dependencies := initializeEventBus(eventBusStartupDependencies{
		redisURL: "  redis://redis.internal:6379/0  ",
		logger:   logger,
		newRedisBackend: func(redisURL string, bus *events.Bus, _ *slog.Logger) (events.Backend, error) {
			factoryURL = redisURL
			factoryBus = bus
			return backend, nil
		},
	})

	if factoryURL != "redis://redis.internal:6379/0" {
		t.Fatalf("factory URL = %q", factoryURL)
	}
	if factoryBus != dependencies.Bus {
		t.Fatal("factory received a different event bus")
	}
	if backend.startCalls != 1 {
		t.Fatalf("Start() calls = %d, want 1", backend.startCalls)
	}
	if !dependencies.RedisActive || dependencies.Bus.Backend() != backend {
		t.Fatalf("Redis activation = %v, backend = %T", dependencies.RedisActive, dependencies.Bus.Backend())
	}
	if !strings.Contains(logs.String(), "events: REDIS_URL set, RedisBackend active for cross-replica fan-out") {
		t.Fatalf("startup log = %s", logs.String())
	}
}

func TestInitializeEventBusDegradesOnRedisDialFailure(t *testing.T) {
	logger, logs := eventBusTestLogger()

	dependencies := initializeEventBus(eventBusStartupDependencies{
		redisURL: "redis://redis.internal:6379",
		logger:   logger,
		newRedisBackend: func(string, *events.Bus, *slog.Logger) (events.Backend, error) {
			return nil, errors.New("dial refused")
		},
	})

	assertMemoryEventBackend(t, dependencies)
	for _, want := range []string{
		"events: REDIS_URL set but dial failed; using in-process backend",
		"dial refused",
	} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("startup log %q does not contain %q", logs.String(), want)
		}
	}
}

func TestInitializeEventBusDegradesOnRedisSubscribeFailure(t *testing.T) {
	logger, logs := eventBusTestLogger()
	backend := &eventBackendStub{startErr: errors.New("subscribe refused")}

	dependencies := initializeEventBus(eventBusStartupDependencies{
		redisURL: "redis://redis.internal:6379",
		logger:   logger,
		newRedisBackend: func(string, *events.Bus, *slog.Logger) (events.Backend, error) {
			return backend, nil
		},
	})

	if backend.startCalls != 1 {
		t.Fatalf("Start() calls = %d, want 1", backend.startCalls)
	}
	assertMemoryEventBackend(t, dependencies)
	for _, want := range []string{
		"events: REDIS_URL set but subscribe failed; using in-process backend",
		"subscribe refused",
	} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("startup log %q does not contain %q", logs.String(), want)
		}
	}
}

func assertMemoryEventBackend(t *testing.T, dependencies EventBusDependencies) {
	t.Helper()
	if dependencies.RedisActive {
		t.Fatal("Redis marked active after fallback")
	}
	if _, ok := dependencies.Bus.Backend().(*events.MemBackend); !ok {
		t.Fatalf("fallback backend = %T, want *events.MemBackend", dependencies.Bus.Backend())
	}
}

func eventBusTestLogger() (*slog.Logger, *bytes.Buffer) {
	var logs bytes.Buffer
	return slog.New(slog.NewJSONHandler(&logs, nil)), &logs
}
