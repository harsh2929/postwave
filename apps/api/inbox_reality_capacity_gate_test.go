// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/inboxreality"
)

type capacityGateRegistry struct {
	err    error
	called int
}

func (*capacityGateRegistry) Seeds(context.Context) ([]inboxreality.SeedAddress, error) {
	return nil, nil
}

func (*capacityGateRegistry) ProviderInfo(context.Context) ([]inboxreality.ProviderInfo, error) {
	return nil, nil
}

func (r *capacityGateRegistry) VerifyProductionCapacity(context.Context) error {
	r.called++
	return r.err
}

func TestProductionInboxRealityRequiresVerifiedSeedCapacity(t *testing.T) {
	registry := &capacityGateRegistry{err: errors.New("too few active mailboxes")}
	err := verifyInboxRealityProductionCapacity(context.Background(), true, true, registry)
	if err == nil || !strings.Contains(err.Error(), "too few active mailboxes") {
		t.Fatalf("production capacity error = %v", err)
	}
	if registry.called != 1 {
		t.Fatalf("capacity verifier called %d times, want 1", registry.called)
	}
}

func TestProductionInboxRealityRejectsAnUnverifiableRegistry(t *testing.T) {
	err := verifyInboxRealityProductionCapacity(
		context.Background(), true, true, inboxreality.StaticSeedRegistry{},
	)
	if err == nil || !strings.Contains(err.Error(), "verifiable live seed registry") {
		t.Fatalf("unverifiable registry error = %v", err)
	}
}

func TestSeedCapacityGateDoesNotTurnOnTheFeature(t *testing.T) {
	registry := &capacityGateRegistry{err: errors.New("must not be called")}
	for _, tc := range []struct {
		name       string
		enabled    bool
		production bool
	}{
		{name: "feature disabled in production", enabled: false, production: true},
		{name: "enabled only in development", enabled: true, production: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := verifyInboxRealityProductionCapacity(context.Background(), tc.enabled, tc.production, registry); err != nil {
				t.Fatalf("gate = %v, want no production certification attempt", err)
			}
		})
	}
	if registry.called != 0 {
		t.Fatalf("capacity verifier called %d times outside enabled production", registry.called)
	}
}
