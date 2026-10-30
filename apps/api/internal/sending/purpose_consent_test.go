// SPDX-License-Identifier: AGPL-3.0-only
package sending

import (
	"context"
	"errors"
	"testing"
)

type purposeConsentLookupFunc func(context.Context, string, string, string) (bool, error)

func (f purposeConsentLookupFunc) Allowed(ctx context.Context, tenantID, email, purpose string) (bool, error) {
	return f(ctx, tenantID, email, purpose)
}

func TestLookupPurposeConsentFailsClosedOnLookupError(t *testing.T) {
	wantErr := errors.New("consent store unavailable")
	lookup := purposeConsentLookupFunc(func(context.Context, string, string, string) (bool, error) {
		// Even a buggy fail-open implementation cannot override the error.
		return true, wantErr
	})

	allowed, err := lookupPurposeConsent(context.Background(), lookup, "tenant", "person@example.com", "email_marketing")
	if !errors.Is(err, wantErr) || allowed {
		t.Fatalf("lookup error must deny: allowed=%v err=%v", allowed, err)
	}
}

func TestLookupPurposeConsentPreservesRecordedDecision(t *testing.T) {
	for _, want := range []bool{false, true} {
		lookup := purposeConsentLookupFunc(func(context.Context, string, string, string) (bool, error) {
			return want, nil
		})
		allowed, err := lookupPurposeConsent(context.Background(), lookup, "tenant", "person@example.com", "email_marketing")
		if err != nil || allowed != want {
			t.Fatalf("recorded decision %v: allowed=%v err=%v", want, allowed, err)
		}
	}
}

func TestLookupPurposeConsentWithoutLookupDenies(t *testing.T) {
	allowed, err := lookupPurposeConsent(context.Background(), nil, "tenant", "person@example.com", "email_marketing")
	if err != nil || allowed {
		t.Fatalf("missing lookup must deny: allowed=%v err=%v", allowed, err)
	}
}
