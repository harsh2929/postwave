// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
)

// The gateway verifies the callback signature against the full path it
// received. Signing the bare contract path means the observation callback
// silently 401s whenever the gateway URL carries a prefix — and this callback
// is what turns a completed dispatch into a visible placement result, so the
// failure surfaces as "tests never complete" rather than as an auth error.
func TestObservationCallbackSignsThePathTheGatewayWillVerify(t *testing.T) {
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	var received *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Clone(context.Background())
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	receipt := inboxrealitycontract.ObservationReceipt{
		ObservationKey: strings.Repeat("a", 64),
		TestID:         "11111111-1111-4111-8111-111111111111",
	}
	client := &ObservationCallbackClient{
		GatewayBaseURL: server.URL + "/gateway",
		BearerToken:    "bearer",
		SigningSecret:  "internal-secret",
		Clock:          func() time.Time { return now },
	}
	if err := client.NotifyObservation(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := internalsign.Verify("internal-secret", http.MethodPost,
		received.URL.EscapedPath(), body, internalsign.FromHTTP(received.Header),
		now, internalsign.DefaultTolerance); err != nil {
		t.Fatalf("signature does not cover the delivered path %q: %v", received.URL.EscapedPath(), err)
	}
}
