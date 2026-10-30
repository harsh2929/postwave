// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/telemetry"
)

type telemetryTrackerStub struct {
	enabled    bool
	closeErr   error
	closeCalls int
}

func (*telemetryTrackerStub) Track(context.Context, string, string, map[string]any) {}

func (*telemetryTrackerStub) Identify(context.Context, string, map[string]any) {}

func (tracker *telemetryTrackerStub) Close() error {
	tracker.closeCalls++
	return tracker.closeErr
}

func (tracker *telemetryTrackerStub) Enabled() bool { return tracker.enabled }

func TestInitializeTelemetryUsesEnabledTracker(t *testing.T) {
	logger, logs := telemetryTestLogger()
	tracker := &telemetryTrackerStub{enabled: true}
	var factoryLogger *slog.Logger

	dependencies := initializeTelemetry(telemetryStartupDependencies{
		logger: logger,
		newTracker: func(receivedLogger *slog.Logger) (telemetry.Tracker, error) {
			factoryLogger = receivedLogger
			return tracker, nil
		},
	})

	if factoryLogger != logger {
		t.Fatal("tracker factory received a different logger")
	}
	if dependencies.Tracker != tracker {
		t.Fatalf("tracker = %T, want injected tracker", dependencies.Tracker)
	}
	if !strings.Contains(logs.String(), "telemetry: posthog enabled") {
		t.Fatalf("startup log = %s", logs.String())
	}
}

func TestInitializeTelemetryLogsDormantNoop(t *testing.T) {
	logger, logs := telemetryTestLogger()

	dependencies := initializeTelemetry(telemetryStartupDependencies{
		logger: logger,
		newTracker: func(*slog.Logger) (telemetry.Tracker, error) {
			return telemetry.Noop(), nil
		},
	})

	if dependencies.Tracker.Enabled() {
		t.Fatal("noop tracker reported enabled")
	}
	if !strings.Contains(logs.String(), "telemetry: dormant (POSTHOG_API_KEY unset)") {
		t.Fatalf("startup log = %s", logs.String())
	}
}

func TestInitializeTelemetryFallsBackToNoopOnFailure(t *testing.T) {
	logger, logs := telemetryTestLogger()

	dependencies := initializeTelemetry(telemetryStartupDependencies{
		logger: logger,
		newTracker: func(*slog.Logger) (telemetry.Tracker, error) {
			return nil, errors.New("invalid endpoint")
		},
	})

	if dependencies.Tracker == nil || dependencies.Tracker.Enabled() {
		t.Fatalf("fallback tracker = %#v, want non-nil noop", dependencies.Tracker)
	}
	for _, want := range []string{
		"telemetry init failed; falling back to noop",
		"invalid endpoint",
		"telemetry: dormant (POSTHOG_API_KEY unset)",
	} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("startup log %q does not contain %q", logs.String(), want)
		}
	}
}

func TestTelemetryDependenciesCloseLogsFlushFailure(t *testing.T) {
	logger, logs := telemetryTestLogger()
	tracker := &telemetryTrackerStub{enabled: true, closeErr: errors.New("flush failed")}
	dependencies := TelemetryDependencies{Tracker: tracker, logger: logger}

	dependencies.Close()

	if tracker.closeCalls != 1 {
		t.Fatalf("Close() calls = %d, want 1", tracker.closeCalls)
	}
	for _, want := range []string{"telemetry close failed", "flush failed"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("close log %q does not contain %q", logs.String(), want)
		}
	}
}

func telemetryTestLogger() (*slog.Logger, *bytes.Buffer) {
	var logs bytes.Buffer
	return slog.New(slog.NewJSONHandler(&logs, nil)), &logs
}
