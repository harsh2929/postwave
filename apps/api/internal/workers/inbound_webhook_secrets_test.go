// SPDX-License-Identifier: AGPL-3.0-only
package workers

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/inbound_webhooks"
)

func TestNewInboundWebhookSecretMaintenanceWorkerFailsClosed(t *testing.T) {
	if got := NewInboundWebhookSecretMaintenanceWorker(nil, nil); got != nil {
		t.Fatal("worker constructed without a repository")
	}
	if got := NewInboundWebhookSecretMaintenanceWorker(&inbound_webhooks.Repo{}, nil); got != nil {
		t.Fatal("worker constructed without a pool and cipher")
	}
}

func TestMainStartsInboundWebhookSecretMaintenanceWorker(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	mainPath := filepath.Clean(filepath.Join(filepath.Dir(source), "..", "..", "main.go"))
	raw, err := os.ReadFile(mainPath)
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	if !strings.Contains(string(raw), "apiworkers.StartInboundWebhookSecretMaintenanceWorker(") {
		t.Fatal("main.go does not start inbound secret maintenance on the shared lifecycle")
	}
}
