// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"testing"

	"github.com/go-chi/chi/v5"
)

// randSuffix returns a short hex string for use in test-time slugs so
// parallel test runs don't collide on UNIQUE(tenants.slug).
func randSuffix(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

// withChildIDParam attaches a chi route-param "id" → childID to the
// context so handlers that read chi.URLParam(r, "id") see the value
// without needing a full chi mux to run them.
func withChildIDParam(ctx context.Context, childID string) context.Context {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", childID)
	return context.WithValue(ctx, chi.RouteCtxKey, rctx)
}
