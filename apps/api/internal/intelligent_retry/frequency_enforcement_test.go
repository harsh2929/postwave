package intelligent_retry

import (
	"context"
	"errors"
	"testing"
)

func TestRetryFrequencyEnforcementFailsClosed(t *testing.T) {
	ev := Event{TenantID: "tenant-1", SubscriberEmail: "person@example.test"}
	if admitted, err := (&Queue{}).frequencyAdmits(context.Background(), ev); err == nil || admitted {
		t.Fatalf("missing enforcement admitted=%v err=%v, want refusal", admitted, err)
	}

	sentinel := errors.New("frequency store unavailable")
	q := &Queue{Frequency: func(context.Context, string, string, []string) ([]string, error) {
		return nil, sentinel
	}}
	if admitted, err := q.frequencyAdmits(context.Background(), ev); !errors.Is(err, sentinel) || admitted {
		t.Fatalf("enforcement failure admitted=%v err=%v, want wrapped sentinel", admitted, err)
	}
}

func TestRetryFrequencyEnforcementValidatesRecipient(t *testing.T) {
	ev := Event{TenantID: "tenant-1", SubscriberEmail: "Person@example.test"}
	for _, tc := range []struct {
		name     string
		kept     []string
		admitted bool
		wantErr  bool
	}{
		{name: "still capped", kept: nil},
		{name: "same recipient", kept: []string{"person@example.test"}, admitted: true},
		{name: "injected recipient", kept: []string{"other@example.test"}, wantErr: true},
		{name: "multiple recipients", kept: []string{"Person@example.test", "other@example.test"}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &Queue{Frequency: func(context.Context, string, string, []string) ([]string, error) {
				return tc.kept, nil
			}}
			admitted, err := q.frequencyAdmits(context.Background(), ev)
			if admitted != tc.admitted || (err != nil) != tc.wantErr {
				t.Fatalf("admitted=%v err=%v, want admitted=%v wantErr=%v", admitted, err, tc.admitted, tc.wantErr)
			}
		})
	}
}

func TestRetrySubscriberPreferenceEnforcementFailsClosed(t *testing.T) {
	ev := Event{TenantID: "tenant-1", SubscriberEmail: "person@example.test"}
	if admitted, err := (&Queue{}).subscriberPreferenceAdmits(context.Background(), ev); err == nil || admitted {
		t.Fatalf("missing subscriber-preference enforcement admitted=%v err=%v, want refusal", admitted, err)
	}

	sentinel := errors.New("subscriber preference store unavailable")
	q := &Queue{SubscriberPreference: func(context.Context, string, []string) ([]string, error) {
		return nil, sentinel
	}}
	if admitted, err := q.subscriberPreferenceAdmits(context.Background(), ev); !errors.Is(err, sentinel) || admitted {
		t.Fatalf("subscriber-preference failure admitted=%v err=%v, want wrapped sentinel", admitted, err)
	}
}

func TestRetrySubscriberPreferenceRechecksRecipientsPausedAfterInitialQueue(t *testing.T) {
	ev := Event{TenantID: "tenant-1", SubscriberEmail: "Person@example.test"}
	for _, tc := range []struct {
		name     string
		kept     []string
		admitted bool
		wantErr  bool
	}{
		{name: "newly paused", kept: nil},
		{name: "still allowed", kept: []string{"person@example.test"}, admitted: true},
		{name: "injected recipient", kept: []string{"other@example.test"}, wantErr: true},
		{name: "multiple recipients", kept: []string{"Person@example.test", "other@example.test"}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &Queue{SubscriberPreference: func(context.Context, string, []string) ([]string, error) {
				return tc.kept, nil
			}}
			admitted, err := q.subscriberPreferenceAdmits(context.Background(), ev)
			if admitted != tc.admitted || (err != nil) != tc.wantErr {
				t.Fatalf("admitted=%v err=%v, want admitted=%v wantErr=%v", admitted, err, tc.admitted, tc.wantErr)
			}
		})
	}
}
