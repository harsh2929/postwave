package frequency

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestSubscriberPreferenceFilterPropagatesTenantScopeFailure(t *testing.T) {
	sentinel := errors.New("tenant scope unavailable")
	result, err := filterBySubscriberPreferenceWithTenant(
		context.Background(), "tenant-1", []string{"paused@example.test"},
		func(_ context.Context, tenantID string) (pgx.Tx, error) {
			if tenantID != "tenant-1" {
				t.Fatalf("tenant=%q, want tenant-1", tenantID)
			}
			return nil, sentinel
		},
	)
	assertSubscriberPreferenceFailure(t, result, err, sentinel)
}

func TestSubscriberPreferenceFilterPropagatesStorageReadFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		tx   *fakeFrequencyTx
	}{
		{
			name: "query",
			tx: &fakeFrequencyTx{
				queryErr: errors.New("query failed"),
			},
		},
		{
			name: "scan",
			tx: &fakeFrequencyTx{
				queryRows: &fakeEmailRows{
					emails:     []string{"paused@example.test"},
					scanErrors: []error{errors.New("scan failed")},
				},
			},
		},
		{
			name: "row stream",
			tx: &fakeFrequencyTx{
				queryRows: &fakeEmailRows{rowErr: errors.New("rows failed")},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := filterBySubscriberPreferenceWithTenant(
				context.Background(), "tenant-1", []string{"paused@example.test"},
				func(context.Context, string) (pgx.Tx, error) { return tc.tx, nil },
			)
			if err == nil {
				t.Fatalf("%s failure passed recipients through", tc.name)
			}
			if result.Kept != nil || result.Skipped != 0 || result.Breakdown != nil {
				t.Fatalf("%s failure leaked result: %+v", tc.name, result)
			}
			if tc.tx.rollbacks != 1 {
				t.Fatalf("%s failure rollbacks=%d, want 1", tc.name, tc.tx.rollbacks)
			}
		})
	}
}

func TestSubscriberPreferenceFilterPreservesCandidateIdentityAndOrder(t *testing.T) {
	tx := &fakeFrequencyTx{queryRows: &fakeEmailRows{emails: []string{"PAUSED@example.test"}}}
	candidates := []string{"Paused@Example.Test", "kept@example.test"}
	result, err := filterBySubscriberPreferenceWithTenant(
		context.Background(), "tenant-1", candidates,
		func(context.Context, string) (pgx.Tx, error) { return tx, nil },
	)
	if err != nil {
		t.Fatalf("filter subscriber preference: %v", err)
	}
	if result.Skipped != 1 || len(result.Kept) != 1 || result.Kept[0] != candidates[1] {
		t.Fatalf("result=%+v, want one exact ordered survivor", result)
	}
	if len(result.Breakdown) != 1 || result.Breakdown[0].RuleID != SubscriberPreferenceSkipRule || result.Breakdown[0].Skipped != 1 {
		t.Fatalf("breakdown=%+v, want one subscriber-preference skip", result.Breakdown)
	}
	if tx.rollbacks != 1 {
		t.Fatalf("successful read rollbacks=%d, want 1", tx.rollbacks)
	}
}

func assertSubscriberPreferenceFailure(t *testing.T, result FilterResult, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error=%v, want wrapped %v", err, want)
	}
	if result.Kept != nil || result.Skipped != 0 || result.Breakdown != nil {
		t.Fatalf("failure leaked result: %+v", result)
	}
}
