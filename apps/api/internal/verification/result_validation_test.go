// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPersistableResultRejectsSemanticContradictionsAndUnsafeEnrichment(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result Result
	}{
		{
			name: "valid disposable",
			result: Result{Email: "a@b.com", Status: StatusValid,
				SubStatus: SubStatusDisposable, Disposable: true, Provider: ProviderZeroBounce},
		},
		{
			name: "valid terminal reason",
			result: Result{Email: "a@b.com", Status: StatusValid,
				SubStatus: SubStatusGlobalSuppression, Provider: ProviderZeroBounce},
		},
		{
			name: "catch all terminal reason",
			result: Result{Email: "a@b.com", Status: StatusCatchAll,
				SubStatus: SubStatusPossibleTrap, Provider: ProviderZeroBounce},
		},
		{
			name: "control in enrichment",
			result: Result{Email: "a@b.com", Status: StatusValid,
				FirstName: "safe\nforged", Provider: ProviderZeroBounce},
		},
		{
			name: "oversized enrichment",
			result: Result{Email: "a@b.com", Status: StatusValid,
				City: strings.Repeat("x", maxVerificationCityBytes+1), Provider: ProviderZeroBounce},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validatePersistableResult(tc.result); !errors.Is(err, ErrProviderPartialOutcome) {
				t.Fatalf("validatePersistableResult error=%v, want ErrProviderPartialOutcome", err)
			}
		})
	}
}

func TestPersistableResultRejectsImpossibleLocalAffirmativeVerdicts(t *testing.T) {
	for _, status := range []Status{StatusValid, StatusCatchAll, StatusSpamtrap} {
		result := Result{Email: "a@b.com", Status: status, Provider: ProviderLocal}
		if status == StatusCatchAll {
			result.SubStatus = SubStatusAcceptAll
		}
		if err := validatePersistableResult(result); !errors.Is(err, ErrProviderPartialOutcome) {
			t.Errorf("local %s error=%v, want canonical rejection", status, err)
		}
	}
	for _, result := range []Result{
		{Email: "a@b.com", Status: StatusUnknown, SubStatus: SubStatusNoMailboxProbe, Provider: ProviderLocal},
		{Email: "a@mailinator.com", Status: StatusUnknown, SubStatus: SubStatusDisposable,
			Disposable: true, Provider: ProviderLocal},
		{Email: "bad", Status: StatusInvalid, SubStatus: SubStatusSyntaxInvalid, Provider: ProviderLocal},
		{Email: "abuse@b.com", Status: StatusAbuse, SubStatus: SubStatusRoleBased, Provider: ProviderLocal},
	} {
		if err := validatePersistableResult(result); err != nil {
			t.Errorf("legitimate local result rejected: %+v error=%v", result, err)
		}
	}
}

func TestStoredJobItemValidationAllowsInternalAmbiguityButRejectsMalformedOutput(t *testing.T) {
	now := time.Now().UTC()
	valid := JobItem{
		Email: "a@b.com", Processed: true, Status: string(StatusValid),
		Provider: ProviderZeroBounce, CheckedAt: &now, AttemptState: "succeeded",
	}
	if err := validateStoredJobItem(valid); err != nil {
		t.Fatalf("valid succeeded item rejected: %v", err)
	}
	ambiguous := JobItem{
		Email: "a@b.com", Status: string(StatusUnknown),
		SubStatus: "provider_response_ambiguous", AttemptState: "ambiguous",
	}
	if err := validateStoredJobItem(ambiguous); err != nil {
		t.Fatalf("internal ambiguity receipt rejected: %v", err)
	}
	for _, malformed := range []JobItem{
		{Email: " A@b.com", Status: string(StatusUnknown), AttemptState: "pending"},
		{Email: "a@b.com\u202e", Status: string(StatusUnknown), AttemptState: "pending"},
		{Email: "a@b.com\ue000", Status: string(StatusUnknown), AttemptState: "pending"},
		{Email: "a@b.com", Status: string(StatusValid), SubStatus: string(SubStatusDisposable),
			Provider: ProviderZeroBounce, Processed: true, CheckedAt: &now, AttemptState: "succeeded"},
		{Email: "a@b.com", Status: string(StatusValid), Provider: ProviderZeroBounce,
			DidYouMean: "safe\u202eforged@example.com", Processed: true, CheckedAt: &now, AttemptState: "succeeded"},
		{Email: "a@b.com", Status: string(StatusValid), Provider: ProviderZeroBounce,
			DidYouMean: "safe\ue000forged@example.com", Processed: true, CheckedAt: &now, AttemptState: "succeeded"},
		{Email: "a@b.com", Status: string(StatusValid), Provider: "foreign_provider",
			Processed: true, CheckedAt: &now, AttemptState: "succeeded"},
		{Email: "a@b.com", Status: string(StatusUnknown),
			SubStatus: "provider_response_ambiguous\nforged", AttemptState: "ambiguous"},
	} {
		if err := validateStoredJobItem(malformed); err == nil {
			t.Errorf("malformed item accepted: %+v", malformed)
		}
	}
}

func TestDurableJobWriteValidatesBeforeOpeningDatabaseTransaction(t *testing.T) {
	store := &Store{}
	err := store.applyBatch(context.Background(), jobBatchClaim{}, ProviderZeroBounce, []Result{{
		Email: "a@b.com", Status: StatusValid, SubStatus: SubStatusDisposable,
		Disposable: true, Provider: ProviderZeroBounce,
	}}, ChainStats{})
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("applyBatch error=%v, want canonical validation failure", err)
	}
}
