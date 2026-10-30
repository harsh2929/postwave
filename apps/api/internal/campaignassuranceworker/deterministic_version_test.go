// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

const (
	staleDeterministicConfigurationID = "deterministic.campaignchecks.v1"
	staleDeterministicAnalyzerVersion = "postwave.campaign-checks.deterministic.v1"
)

func TestWorkerRejectsStaleDeterministicV1Identity(t *testing.T) {
	if DeterministicConfigurationID == staleDeterministicConfigurationID {
		t.Fatal("current deterministic configuration identity still aliases stale v1")
	}

	tests := []struct {
		name   string
		mutate func(*testing.T, *fixture)
	}{
		{
			name: "configuration id",
			mutate: func(_ *testing.T, fixture *fixture) {
				fixture.assurance.claimed.Configurations[0].ID = staleDeterministicConfigurationID
				fixture.assurance.claimed.Targets[0].ConfigurationID = staleDeterministicConfigurationID
			},
		},
		{
			name: "analyzer version",
			mutate: func(t *testing.T, fixture *fixture) {
				raw, err := json.Marshal(DeterministicConfiguration{
					AnalyzerVersion: staleDeterministicAnalyzerVersion,
					PolicyVersion:   fixture.assurance.claimed.Run.GatePolicyVersion,
				})
				if err != nil {
					t.Fatal(err)
				}
				if err := validateDeterministicConfiguration(raw, fixture.assurance.claimed.Run.GatePolicyVersion); !errors.Is(err, ErrUnsupportedAnalyzer) {
					t.Fatalf("stale v1 analyzer validation error = %v, want %v", err, ErrUnsupportedAnalyzer)
				}
				hash, err := canonicalConfigurationHash(raw)
				if err != nil {
					t.Fatal(err)
				}
				fixture.assurance.claimed.Configurations[0].Configuration = raw
				fixture.assurance.claimed.Configurations[0].ConfigurationHash = hash
				fixture.assurance.claimed.Targets[0].ConfigurationHash = hash
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newFixture(t, campaignassurance.SourceDeterministic)
			test.mutate(t, &fixture)

			result, err := fixture.worker.Process(context.Background(), Command{
				TenantID: testTenantID,
				RunID:    testRunID,
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.Outcome != OutcomeIncomplete || result.Run == nil || result.Run.GateDecision != campaignassurance.GateUnavailable {
				t.Fatalf("stale v1 identity result = %+v", result)
			}
			fixture.assurance.mu.Lock()
			defer fixture.assurance.mu.Unlock()
			if len(fixture.assurance.extractions) != 1 ||
				fixture.assurance.extractions[0].Status != campaignassurance.ExtractionUnavailable ||
				!hasFindingCode(fixture.assurance.findings, "DETERMINISTIC_ANALYZER_UNAVAILABLE", true) {
				t.Fatalf("stale v1 identity was not durably rejected: extractions=%+v findings=%+v",
					fixture.assurance.extractions, fixture.assurance.findings)
			}
			if fixture.objects.calls != 0 || fixture.artifacts.artifactCalls != 0 || fixture.artifacts.planCalls != 0 {
				t.Fatalf("stale v1 identity performed artifact work: object=%d artifact=%d plan=%d",
					fixture.objects.calls, fixture.artifacts.artifactCalls, fixture.artifacts.planCalls)
			}
		})
	}
}
