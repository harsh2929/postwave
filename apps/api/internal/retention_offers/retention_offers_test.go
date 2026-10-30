// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-Go validation + formatting tests for retention_offers. Tests
// that need a live Postgres are gated behind the integration build tag
// elsewhere; these run as part of `go test ./internal/retention_offers`.

package retention_offers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOfferInputValidate(t *testing.T) {
	t.Parallel()
	pct := 20
	fixed := 500
	bad := 0
	tooHigh := 101
	cases := []struct {
		name string
		in   OfferInput
		want error
	}{
		{"missing tier", OfferInput{PercentOff: &pct}, ErrTierRequired},
		{"both amounts", OfferInput{PaywallTierID: "abc", PercentOff: &pct, FixedOffCents: &fixed}, ErrAmountInvalid},
		{"neither amount", OfferInput{PaywallTierID: "abc"}, ErrAmountInvalid},
		{"pct zero", OfferInput{PaywallTierID: "abc", PercentOff: &bad}, ErrAmountInvalid},
		{"pct too high", OfferInput{PaywallTierID: "abc", PercentOff: &tooHigh}, ErrAmountInvalid},
		{"fixed zero", OfferInput{PaywallTierID: "abc", FixedOffCents: &bad}, ErrAmountInvalid},
		{"duration too long", OfferInput{PaywallTierID: "abc", PercentOff: &pct, DurationMonths: 100}, ErrDurationRange},
		{"happy pct", OfferInput{PaywallTierID: "abc", PercentOff: &pct}, nil},
		{"happy fixed", OfferInput{PaywallTierID: "abc", FixedOffCents: &fixed}, nil},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			in := c.in
			err := in.validate()
			if err != c.want {
				t.Fatalf("validate: got %v want %v", err, c.want)
			}
			// Default duration_months should be 1 on happy paths.
			if err == nil && in.DurationMonths != 1 {
				t.Fatalf("duration_months default: got %d want 1", in.DurationMonths)
			}
		})
	}
}

func TestFormatAmount(t *testing.T) {
	t.Parallel()
	pct := 25
	fixed := 1200
	cases := []struct {
		name string
		o    Offer
		want string
	}{
		{"percent", Offer{PercentOff: &pct}, "25% off"},
		{"fixed amount without currency is not labelled", Offer{FixedOffCents: &fixed}, ""},
		{"empty", Offer{}, ""},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			got := c.o.FormatAmount()
			if got != c.want {
				t.Fatalf("FormatAmount: got %q want %q", got, c.want)
			}
		})
	}
}

func TestPaidRetentionMutationsFailClosedWithoutStripeBridge(t *testing.T) {
	t.Parallel()
	pct := 20
	repo := &Repo{}
	_, err := repo.UpsertOffer(context.Background(), "tenant", OfferInput{
		PaywallTierID: "tier", PercentOff: &pct,
	})
	if !errors.Is(err, ErrStripeBridgeUnavailable) {
		t.Fatalf("UpsertOffer error = %v, want ErrStripeBridgeUnavailable", err)
	}
	_, err = repo.AcceptOffer(context.Background(), "tenant", "offer", "sub", EventInput{})
	if !errors.Is(err, ErrStripeBridgeUnavailable) {
		t.Fatalf("AcceptOffer error = %v, want ErrStripeBridgeUnavailable", err)
	}
}

func TestEventTypeConstants(t *testing.T) {
	// Match the CHECK constraint in migration 0306 — these MUST stay
	// in lockstep, or inserts will fail at runtime.
	got := []EventType{EventShown, EventAccepted, EventDeclined, EventExpired}
	want := []string{"shown", "accepted", "declined", "expired"}
	for i, e := range got {
		if string(e) != want[i] {
			t.Fatalf("event[%d]: got %q want %q", i, e, want[i])
		}
	}
}

func TestReadSetTooLargeErrorContract(t *testing.T) {
	t.Parallel()
	err := &ReadSetTooLargeError{Resource: "offers", Limit: MaxReadRows}
	if !errors.Is(err, ErrReadSetTooLarge) {
		t.Fatalf("errors.Is(%v, ErrReadSetTooLarge) = false", err)
	}
	var typed *ReadSetTooLargeError
	if !errors.As(err, &typed) {
		t.Fatalf("errors.As(%v, *ReadSetTooLargeError) = false", err)
	}
	if typed.Resource != "offers" || typed.Limit != 1000 {
		t.Fatalf("typed error = %+v, want offers/1000", typed)
	}
}

func TestOfferStringBoundsMatchClientContract(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name     string
		field    string
		value    string
		maxBytes int
		wantErr  bool
	}{
		{name: "headline exact ASCII", field: "headline", value: strings.Repeat("h", MaxHeadlineBytes), maxBytes: MaxHeadlineBytes},
		{name: "headline exact multibyte", field: "headline", value: strings.Repeat("🙂", MaxHeadlineBytes/4), maxBytes: MaxHeadlineBytes},
		{name: "headline one multibyte over", field: "headline", value: strings.Repeat("🙂", MaxHeadlineBytes/4+1), maxBytes: MaxHeadlineBytes, wantErr: true},
		{name: "body exact", field: "body", value: strings.Repeat("b", MaxBodyBytes), maxBytes: MaxBodyBytes},
		{name: "body over", field: "body", value: strings.Repeat("b", MaxBodyBytes+1), maxBytes: MaxBodyBytes, wantErr: true},
		{name: "provider exact", field: "stripe_coupon_id", value: strings.Repeat("p", MaxProviderReferenceBytes), maxBytes: MaxProviderReferenceBytes},
		{name: "provider over", field: "stripe_coupon_id", value: strings.Repeat("p", MaxProviderReferenceBytes+1), maxBytes: MaxProviderReferenceBytes, wantErr: true},
		{name: "leading whitespace", field: "headline", value: " unsafe", maxBytes: MaxHeadlineBytes, wantErr: true},
		{name: "control", field: "body", value: "safe\x00unsafe", maxBytes: MaxBodyBytes, wantErr: true},
		{name: "bidi isolate", field: "headline", value: "safe\u2066unsafe", maxBytes: MaxHeadlineBytes, wantErr: true},
		{name: "paragraph whitespace remains safe", field: "body", value: "line one\n\tline two", maxBytes: MaxBodyBytes},
	} {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := validateOfferString(tc.field, tc.value, tc.maxBytes)
			if tc.wantErr {
				if !errors.Is(err, ErrOfferFieldInvalid) {
					t.Fatalf("error = %v, want ErrOfferFieldInvalid", err)
				}
				var typed *OfferFieldError
				if !errors.As(err, &typed) || typed.Field != tc.field || typed.MaxBytes != tc.maxBytes {
					t.Fatalf("typed error = %+v, want field=%s max=%d", typed, tc.field, tc.maxBytes)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestOfferInputAndStoredProjectionEnforceFieldBounds(t *testing.T) {
	t.Parallel()
	pct := 20
	in := OfferInput{
		PaywallTierID: "tier", PercentOff: &pct,
		Headline: strings.Repeat("h", MaxHeadlineBytes+1),
	}
	if err := in.validate(); !errors.Is(err, ErrOfferFieldInvalid) {
		t.Fatalf("oversized input headline error = %v, want ErrOfferFieldInvalid", err)
	}

	in = OfferInput{
		PaywallTierID: "tier", PercentOff: &pct,
		Headline: "  canonical headline  ", Body: "  canonical body  ",
	}
	if err := in.validate(); err != nil {
		t.Fatalf("canonicalizable input: %v", err)
	}
	if in.Headline != "canonical headline" || in.Body != "canonical body" {
		t.Fatalf("normalized input = (%q, %q)", in.Headline, in.Body)
	}

	offer := Offer{StripeCouponID: strings.Repeat("p", MaxProviderReferenceBytes+1)}
	if err := offer.validateReadProjection(); !errors.Is(err, ErrOfferFieldInvalid) {
		t.Fatalf("oversized stored provider reference error = %v, want ErrOfferFieldInvalid", err)
	}
}

func TestFunnelProjectionMatchesAllPlatformNumericContract(t *testing.T) {
	t.Parallel()
	valid := FunnelTile{
		Shown: MaxFunnelEventCount, Accepted: 1,
		Declined: MaxFunnelEventCount, Expired: MaxFunnelEventCount,
	}
	if err := valid.validateReadProjection(); err != nil {
		t.Fatalf("valid bounded funnel: %v", err)
	}
	for _, tile := range []FunnelTile{
		{Shown: MaxFunnelEventCount + 1},
		{Shown: 4, Accepted: 5},
		{Shown: 4, Accepted: 1, Declined: -1},
	} {
		err := tile.validateReadProjection()
		if !errors.Is(err, ErrFunnelProjectionInvalid) {
			t.Fatalf("projection error = %v, want ErrFunnelProjectionInvalid", err)
		}
		var typed *FunnelProjectionError
		if !errors.As(err, &typed) || typed.Field == "" {
			t.Fatalf("typed projection error = %+v", typed)
		}
	}
}

func TestWriteReadSetTooLargeReturnsStableNon5xxEnvelope(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	if !writeReadSetTooLarge(rec, &ReadSetTooLargeError{Resource: "funnel", Limit: MaxReadRows}) {
		t.Fatal("writeReadSetTooLarge returned false for typed limit error")
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if envelope.Error.Code != readSetTooLargeCode {
		t.Fatalf("error code = %q, want %q", envelope.Error.Code, readSetTooLargeCode)
	}
	if envelope.Error.Message != readSetTooLargeMessage {
		t.Fatalf("error message = %q, want %q", envelope.Error.Message, readSetTooLargeMessage)
	}

	unknown := httptest.NewRecorder()
	if writeReadSetTooLarge(unknown, errors.New("database unavailable")) {
		t.Fatal("unknown errors must fall through to the internal-error path")
	}
	if unknown.Body.Len() != 0 {
		t.Fatalf("fall-through helper wrote a response: %q", unknown.Body.String())
	}
}

func TestWriteStoredOfferInvalidReturnsStableNon5xxEnvelope(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	err := &OfferFieldError{Field: "body", MaxBytes: MaxBodyBytes}
	if !writeStoredOfferInvalid(rec, err) {
		t.Fatal("writeStoredOfferInvalid returned false for typed field error")
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if envelope.Error.Code != storedOfferInvalidCode || envelope.Error.Message != storedOfferInvalidMessage {
		t.Fatalf("error envelope = %+v", envelope.Error)
	}
}

func TestWriteStoredFunnelInvalidReturnsStableNon5xxEnvelope(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	if !writeStoredFunnelInvalid(rec, &FunnelProjectionError{Field: "shown"}) {
		t.Fatal("writeStoredFunnelInvalid returned false for typed projection error")
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if envelope.Error.Code != storedFunnelInvalidCode || envelope.Error.Message != storedFunnelInvalidMessage {
		t.Fatalf("error envelope = %+v", envelope.Error)
	}
}
