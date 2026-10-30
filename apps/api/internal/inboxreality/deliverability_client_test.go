// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
)

// The deliverability service verifies the signature against the full path it
// received. Signing the bare contract path means every dispatch is signed over
// a different string than the one verified whenever the configured service URL
// carries a prefix — so a path-routed ingress turns every send into a 401 that
// looks like a credential problem rather than a URL-shape problem.
func TestDeliverabilityClientSignsThePathTheServiceWillVerify(t *testing.T) {
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	var received *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Clone(context.Background())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(inboxrealitycontract.ExecutionReceipt{
			ContractVersion: inboxrealitycontract.Version,
		})
	}))
	defer server.Close()

	client := &DeliverabilityClient{
		BaseURL:       server.URL + "/deliverability",
		BearerToken:   "bearer",
		SigningSecret: "internal-secret",
		Clock:         func() time.Time { return now },
	}
	request := inboxrealitycontract.DispatchRequest{
		ContractVersion: inboxrealitycontract.Version,
		CommandID:       "11111111-1111-4111-8111-111111111111",
	}
	if _, err := client.Execute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := internalsign.Verify("internal-secret", http.MethodPost,
		received.URL.EscapedPath(), body, internalsign.FromHTTP(received.Header),
		now, internalsign.DefaultTolerance); err != nil {
		t.Fatalf("signature does not cover the delivered path %q: %v", received.URL.EscapedPath(), err)
	}
}
