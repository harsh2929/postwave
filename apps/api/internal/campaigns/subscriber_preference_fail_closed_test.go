package campaigns

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestSubscriberPreferenceQueueFilterFailsClosed(t *testing.T) {
	sentinel := errors.New("subscriber preference database unavailable")
	d := &Deps{SubscriberPreference: func(context.Context, string, []string) ([]string, int, error) {
		return []string{"a@example.test"}, 0, sentinel
	}}
	kept, skipped, qerr := d.filterSubscriberPreferenceAudience(
		context.Background(), "tenant-1", []string{"a@example.test"},
	)
	if kept != nil || skipped != 0 {
		t.Fatalf("failed filter leaked result: kept=%v skipped=%d", kept, skipped)
	}
	if qerr == nil || qerr.Status != http.StatusServiceUnavailable || qerr.Code != "frequency_cap_unavailable" || !errors.Is(qerr.Err, sentinel) {
		t.Fatalf("queue error=%#v, want typed fail-closed 503", qerr)
	}
}

func TestSubscriberPreferenceQueueFilterFailsClosedWhenUnconfigured(t *testing.T) {
	kept, skipped, qerr := (&Deps{}).filterSubscriberPreferenceAudience(
		context.Background(), "tenant-1", []string{"a@example.test"},
	)
	if kept != nil || skipped != 0 {
		t.Fatalf("missing filter leaked result: kept=%v skipped=%d", kept, skipped)
	}
	if qerr == nil || qerr.Status != http.StatusServiceUnavailable || qerr.Code != "frequency_cap_unavailable" {
		t.Fatalf("queue error=%#v, want typed fail-closed 503", qerr)
	}
}

func TestSubscriberPreferenceQueueFilterRejectsInconsistentResults(t *testing.T) {
	candidates := []string{"a@example.test", "b@example.test"}
	for _, tc := range []struct {
		name    string
		kept    []string
		skipped int
	}{
		{name: "injected recipient", kept: []string{"attacker@example.test"}, skipped: 1},
		{name: "reordered recipients", kept: []string{"b@example.test", "a@example.test"}},
		{name: "unaccounted removal", kept: []string{"a@example.test"}},
		{name: "negative count", kept: candidates, skipped: -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{SubscriberPreference: func(context.Context, string, []string) ([]string, int, error) {
				return tc.kept, tc.skipped, nil
			}}
			_, _, qerr := d.filterSubscriberPreferenceAudience(context.Background(), "tenant-1", candidates)
			if qerr == nil || qerr.Status != http.StatusServiceUnavailable || qerr.Code != "frequency_cap_unavailable" {
				t.Fatalf("queue error=%#v, want invalid-result refusal", qerr)
			}
		})
	}
}

func TestSubscriberPreferenceQueueFilterAcceptsOrderPreservingSubset(t *testing.T) {
	candidates := []string{"a@example.test", "b@example.test", "c@example.test"}
	want := []string{"a@example.test", "c@example.test"}
	d := &Deps{SubscriberPreference: func(context.Context, string, []string) ([]string, int, error) {
		return want, 1, nil
	}}
	kept, skipped, qerr := d.filterSubscriberPreferenceAudience(context.Background(), "tenant-1", candidates)
	if qerr != nil || !equalStringSlice(kept, want) || skipped != 1 {
		t.Fatalf("filter result kept=%v skipped=%d err=%v", kept, skipped, qerr)
	}
}

func TestSubscriberPreferenceTransactionAuthorityCountsFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		staged, authority, eligible int64
		wantErr                     bool
	}{
		{name: "all still eligible", staged: 2, authority: 2, eligible: 2},
		{name: "subscriber disappeared", staged: 2, authority: 1, eligible: 1, wantErr: true},
		{name: "subscriber newly paused", staged: 2, authority: 2, eligible: 1, wantErr: true},
		{name: "invalid negative count", staged: -1, authority: -1, eligible: -1, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateSubscriberPreferenceAuthorityCounts(tc.staged, tc.authority, tc.eligible)
			if errors.Is(err, errSubscriberPreferenceAuthorityChanged) != tc.wantErr {
				t.Fatalf("authority validation error=%v, wantErr=%v", err, tc.wantErr)
			}
		})
	}
}
