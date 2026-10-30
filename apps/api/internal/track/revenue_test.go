// SPDX-License-Identifier: AGPL-3.0-only
package track

import "testing"

func TestExtractOrderConversion(t *testing.T) {
	cases := []struct {
		name      string
		eventName string
		props     map[string]interface{}
		wantOK    bool
		wantCents int64
		wantCurr  string
	}{
		{
			name:      "Placed Order with float value in dollars",
			eventName: "Placed Order",
			props:     map[string]interface{}{"value": 49.99, "currency": "usd"},
			wantOK:    true, wantCents: 4999, wantCurr: "USD",
		},
		{
			name:      "Segment-style Order Completed with revenue",
			eventName: "order_completed",
			props:     map[string]interface{}{"revenue": 120.0},
			wantOK:    true, wantCents: 12000, wantCurr: "USD", // default currency
		},
		{
			name:      "explicit amount_cents wins over dollar fields",
			eventName: "Placed Order",
			props:     map[string]interface{}{"amount_cents": 3200.0, "value": 999.0},
			wantOK:    true, wantCents: 3200, wantCurr: "USD",
		},
		{
			name:      "stringified amount is parsed",
			eventName: "purchase",
			props:     map[string]interface{}{"total": "15.50", "currency": "eur"},
			wantOK:    true, wantCents: 1550, wantCurr: "EUR",
		},
		{
			name:      "non-order event with a price is NOT revenue",
			eventName: "Viewed Product",
			props:     map[string]interface{}{"price": 49.99},
			wantOK:    false,
		},
		{
			name:      "order event with no monetary value is skipped",
			eventName: "Placed Order",
			props:     map[string]interface{}{"item_count": 3.0},
			wantOK:    false,
		},
		{
			name:      "zero value is skipped (cannot attribute $0)",
			eventName: "Placed Order",
			props:     map[string]interface{}{"value": 0.0},
			wantOK:    false,
		},
		{
			name:      "negative value is skipped (refund is not revenue here)",
			eventName: "Placed Order",
			props:     map[string]interface{}{"value": -10.0},
			wantOK:    false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := extractOrderConversion(tc.eventName, "shopper@example.com", tc.props)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if got.AmountCents != tc.wantCents {
				t.Errorf("AmountCents = %d, want %d", got.AmountCents, tc.wantCents)
			}
			if got.Currency != tc.wantCurr {
				t.Errorf("Currency = %q, want %q", got.Currency, tc.wantCurr)
			}
			if got.EventName != tc.eventName {
				t.Errorf("EventName = %q, want %q", got.EventName, tc.eventName)
			}
			if got.Email != "shopper@example.com" {
				t.Errorf("Email = %q, want shopper@example.com", got.Email)
			}
		})
	}
}
