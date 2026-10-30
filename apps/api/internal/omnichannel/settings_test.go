// SPDX-License-Identifier: AGPL-3.0-only
package omnichannel

import (
	"context"
	"errors"
	"testing"
)

// Validation guards run before any DB access, so a nil-pool Repo exercises them
// without a database.
func TestUpsertSenderProfile_Validation(t *testing.T) {
	r := &Repo{}
	if _, err := r.UpsertSenderProfile(context.Background(), "t1", SenderProfile{Channel: "telegram"}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("bad channel should be invalid, got %v", err)
	}
	if _, err := r.UpsertSenderProfile(context.Background(), "t1", SenderProfile{Channel: "sms", Status: "bogus"}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("bad status should be invalid, got %v", err)
	}
}

func TestUpsertSmartSendingPolicy_Validation(t *testing.T) {
	r := &Repo{}
	for _, tc := range []struct {
		name string
		in   SmartSendingPolicy
	}{
		{"no name", SmartSendingPolicy{Channel: "sms"}},
		{"bad channel", SmartSendingPolicy{Name: "n", Channel: "telegram"}},
		{"bad scope", SmartSendingPolicy{Name: "n", Channel: "sms", Scope: "nope"}},
		{"negative window", SmartSendingPolicy{Name: "n", Channel: "sms", WindowSeconds: -1}},
	} {
		if _, err := r.UpsertSmartSendingPolicy(context.Background(), "t1", tc.in); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s should be invalid, got %v", tc.name, err)
		}
	}
}
