// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type endpointLimitStore struct {
	mu     sync.Mutex
	counts map[string]int
	err    error
}

func (s *endpointLimitStore) Reserve(
	_ context.Context,
	key string,
	_ int,
	window time.Duration,
	now time.Time,
) (int, time.Time, error) {
	if s.err != nil {
		return 0, time.Time{}, s.err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.counts == nil {
		s.counts = map[string]int{}
	}
	s.counts[key]++
	return s.counts[key], now.Add(window), nil
}

func TestAuthenticatedEndpointRateLimitIsolatedByEndpoint(t *testing.T) {
	t.Parallel()
	store := &endpointLimitStore{}
	deps := &Deps{
		EndpointRateLimitStore: store,
		EndpointRateLimit:      1,
		EndpointRateWindow:     time.Minute,
	}
	now := time.Unix(1_800_000_000, 0)
	if limited, _, err := deps.reserveAuthenticatedEndpoint(t.Context(), "endpoint-a", now); err != nil || limited {
		t.Fatalf("first endpoint-a reservation = limited %v err %v", limited, err)
	}
	if limited, _, err := deps.reserveAuthenticatedEndpoint(t.Context(), "endpoint-a", now); err != nil || !limited {
		t.Fatalf("second endpoint-a reservation = limited %v err %v", limited, err)
	}
	if limited, _, err := deps.reserveAuthenticatedEndpoint(t.Context(), "endpoint-b", now); err != nil || limited {
		t.Fatalf("endpoint-b was starved by endpoint-a: limited %v err %v", limited, err)
	}
}

func TestAuthenticatedEndpointRateLimitFailsClosedOnStoreError(t *testing.T) {
	t.Parallel()
	want := errors.New("redis unavailable")
	deps := &Deps{EndpointRateLimitStore: &endpointLimitStore{err: want}}
	if _, _, err := deps.reserveAuthenticatedEndpoint(t.Context(), "endpoint", time.Now()); !errors.Is(err, want) {
		t.Fatalf("reserve error = %v, want %v", err, want)
	}
}

func TestEndpointBudgetRunsAfterSignatureAndBeforePersistence(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("handlers.go")
	if err != nil {
		t.Fatalf("read handlers: %v", err)
	}
	source := string(raw)
	signatureAccepted := strings.Index(source, "if !valid {")
	reserve := strings.Index(source, "d.reserveAuthenticatedEndpoint(")
	persist := strings.Index(source, "d.Repo.RecordEventWithActions(")
	if signatureAccepted < 0 || reserve < 0 || persist < 0 ||
		!(signatureAccepted < reserve && reserve < persist) {
		t.Fatalf(
			"authenticated endpoint limiter order invalid: signature=%d reserve=%d persistence=%d",
			signatureAccepted,
			reserve,
			persist,
		)
	}

	root := readAPICompositionRoot(t)
	for _, contract := range []string{
		"EndpointRateLimitStore:     distributedRateLimitStore",
		"EndpointRateLimit:          600",
	} {
		if !strings.Contains(root.main, contract) {
			t.Errorf("main endpoint rate-limit wiring missing %q", contract)
		}
	}
	// The route-level inbound-webhook IP bucket moved out of run() into
	// buildPublicRouteLimits (e8d23a62d). Pin it in that helper, and the
	// helper's call in run().
	inboundBucket := regexp.MustCompile(
		`inboundWebhookRateLimit := middleware\.NewRateLimitWithOptions\(\s*10_000,\s*60\s*\*\s*time\.Second,`)
	if !inboundBucket.MatchString(root.function(t, "buildPublicRouteLimits")) {
		t.Errorf("buildPublicRouteLimits no longer builds the 10,000 per minute inbound-webhook IP bucket (%s)",
			inboundBucket)
	}
	if !strings.Contains(root.run, "buildPublicRouteLimits(rateLimitOptions)") {
		t.Error("run() no longer builds the public route limiters through buildPublicRouteLimits")
	}
}
