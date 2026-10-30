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

func TestNewInboundWebhookActionWorkerFailsClosedWithoutPool(t *testing.T) {
	if got := NewInboundWebhookActionWorker(InboundWebhookActionWorkerDeps{}); got != nil {
		t.Fatal("worker constructed without a repository")
	}
	if got := NewInboundWebhookActionWorker(InboundWebhookActionWorkerDeps{
		Repo: &inbound_webhooks.Repo{},
	}); got != nil {
		t.Fatal("worker constructed without a pool")
	}
}

func TestMainStartsInboundWebhookActionWorkerOnSharedLifecycle(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	mainPath := filepath.Clean(filepath.Join(
		filepath.Dir(source), "..", "..", "main.go",
	))
	raw, err := os.ReadFile(mainPath)
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	text := string(raw)
	if !strings.Contains(text,
		"apiworkers.StartInboundWebhookActionWorker(outboxCtx,") {
		t.Fatal("main.go does not start inbound action worker on outboxCtx")
	}
}
