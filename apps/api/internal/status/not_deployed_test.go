// SPDX-License-Identifier: AGPL-3.0-only

package status

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

// An environment that does not run a sidecar sets its *_SERVICE_URL to
// "disabled", which configuration reads as no URL. The public status page used
// to list such a service as "operational", with uptime it never had.
func TestUndeployedServicesAreNeitherProbedNorListed(t *testing.T) {
	var probes atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Errorf("probe path = %q, want /health", r.URL.Path)
		}
		probes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer upstream.Close()

	// Migration, voice and deliverability are not deployed here.
	handler := NewHandler(nil, ServiceTargets{Automation: upstream.URL, Listmonk: upstream.URL})
	NewPoller(nil, handler, time.Minute).tick(context.Background())

	if got := probes.Load(); got != 2 {
		t.Fatalf("probes = %d, want one per deployed service (2)", got)
	}
	resp := handler.snapshot(context.Background())
	var listed []string
	for _, service := range resp.Services {
		listed = append(listed, service.Name)
		if service.Status != StatusOperational {
			t.Errorf("%s status = %q, want operational", service.Name, service.Status)
		}
	}
	if want := []string{"automation", "listmonk"}; !slices.Equal(listed, want) {
		t.Fatalf("listed services = %v, want %v", listed, want)
	}
	for _, service := range []string{"migration", "voice", "deliverability"} {
		if _, ok := resp.Uptime[service]; ok {
			t.Errorf("uptime reported for %s, which is not deployed", service)
		}
	}
	if resp.Overall != StatusOperational {
		t.Fatalf("overall = %q, want operational", resp.Overall)
	}
}
