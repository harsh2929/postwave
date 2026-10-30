// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"
)

// TestOutboundWebhookReplayInheritsGlobalIdempotency pins the composition
// boundary that makes a desktop replay safe when the first 202 response is
// lost in transit. requestInternal mints one Idempotency-Key per logical
// ordinary mutation and reuses it for wire retries; reviewed read-only POSTs
// may explicitly opt out. This ordering ensures the replay handler is wrapped
// before it can clone a second delivery row.
func TestOutboundWebhookReplayInheritsGlobalIdempotency(t *testing.T) {
	t.Parallel()

	mainBytes, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	mainSource := string(mainBytes)
	assertMainMarkersInOrder(t, mainSource, []string{
		"// Authenticated group 1/2:",
		// The guarantee is that idempotency is installed as router middleware
		// BEFORE the replay route mounts, which is what the ordering of these
		// three markers asserts. The argument list is deliberately not pinned:
		// it grew a third resolver (resolveIdempotencyReplayScope) and gofmt
		// split the call across lines, so a marker naming the exact arguments
		// broke on a change that did not touch the ordering it exists to
		// protect. Argument correctness is the compiler's job; position is this
		// test's job.
		"r.Use(idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(",
		"outboundWebhooksDeps.MountRoutes(r, apikeys.ScopeAdmin)",
	})

	handlersBytes, err := os.ReadFile("internal/outbound_webhooks/handlers.go")
	if err != nil {
		t.Fatalf("read outbound webhook handlers: %v", err)
	}
	handlersSource := string(handlersBytes)
	for _, marker := range []string{
		`Post("/api/v1/outbound-webhooks/deliveries/{id}/replay", d.ReplayDelivery)`,
		"func (d *Deps) ReplayDelivery(",
	} {
		if !strings.Contains(handlersSource, marker) {
			t.Fatalf("outbound replay contract is missing %q", marker)
		}
	}

	clientBytes, err := os.ReadFile("../desktop/src/lib/api-client.ts")
	if err != nil {
		t.Fatalf("read desktop API client: %v", err)
	}
	clientSource := string(clientBytes)
	for _, marker := range []string{
		"const mintedIdempotencyKey =",
		"isMutationMethod(method) && opts.idempotencyKey !== null",
		"stepUpRetry.idempotencyKey ?? opts.idempotencyKey ?? newUUIDv7()",
		`headers["Idempotency-Key"] = mintedIdempotencyKey`,
	} {
		if !strings.Contains(clientSource, marker) {
			t.Fatalf("desktop mutation idempotency contract is missing %q", marker)
		}
	}
}
