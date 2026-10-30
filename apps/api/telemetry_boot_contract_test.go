package main

import (
	"os"
	"strings"
	"testing"
)

// TestTelemetryBootCleanupOrdering guards the defer registration order in the
// composition root. Go executes defers in reverse order, so telemetry must be
// registered after the database and observability lifecycles to flush before
// those dependencies are torn down.
func TestDatabaseAndTelemetryBootCleanupOrdering(t *testing.T) {
	sourceBytes, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	source := string(sourceBytes)
	ordered := []string{
		`defer observability.InitSentry("api", sentryEnvironment())()`,
		`defer initializeAPITracing(logger)()`,
		`databaseDependencies, dbErr := apiboot.InitializeDatabase(cfg.DatabaseURL)`,
		`defer databaseDependencies.Close()`,
		`telemetryDependencies := apiboot.InitializeTelemetry(logger)`,
		`defer telemetryDependencies.Close()`,
	}
	last := -1
	for _, marker := range ordered {
		index := strings.Index(source, marker)
		if index < 0 {
			t.Fatalf("main.go is missing telemetry lifecycle marker %q", marker)
		}
		if index <= last {
			t.Fatalf("telemetry lifecycle marker %q is out of order", marker)
		}
		last = index
	}
}
