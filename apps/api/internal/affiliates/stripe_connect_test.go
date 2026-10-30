// SPDX-License-Identifier: AGPL-3.0-only
package affiliates

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStripeConnect_ExecuteTransfer_HappyPath(t *testing.T) {
	var sawIdempotency, sawAuth, sawBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawIdempotency = r.Header.Get("Idempotency-Key")
		sawAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		sawBody = string(body)
		_, _ = w.Write([]byte(`{
			"id":"tr_123","amount":12345,"currency":"usd",
			"destination":"acct_aff","created":1700000000,
			"balance_transaction":"txn_999"
		}`))
	}))
	defer srv.Close()
	origBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = origBase }()

	c := &StripeConnectClient{Secret: "sk_test_abc", HTTP: srv.Client()}
	out, err := c.ExecuteTransfer(context.Background(),
		"acct_aff", 12345, "USD", "Affiliate Q1 payout", "payout_abc")
	require.NoError(t, err)
	require.Equal(t, "tr_123", out.ID)
	require.Equal(t, "payout_abc", sawIdempotency)
	require.Equal(t, "Bearer sk_test_abc", sawAuth)
	require.Contains(t, sawBody, "amount=12345")
	require.Contains(t, sawBody, "destination=acct_aff")
	require.Contains(t, sawBody, "metadata%5Bpostwave_payout_id%5D=payout_abc")
}

func TestStripeConnect_ExecuteTransfer_StripeErrorBubblesUp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"type":"invalid_request_error","code":"account_invalid","message":"Account is no longer active."}}`))
	}))
	defer srv.Close()
	origBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = origBase }()

	c := &StripeConnectClient{Secret: "sk_test", HTTP: srv.Client()}
	_, err := c.ExecuteTransfer(context.Background(), "acct_x", 100, "usd", "", "p1")
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "account_invalid"))
}

func TestStripeConnect_NoSecretRefuses(t *testing.T) {
	var c *StripeConnectClient
	_, err := c.ExecuteTransfer(context.Background(), "acct", 100, "usd", "", "p1")
	require.ErrorIs(t, err, ErrStripeNotConfigured)
}

func TestStripeConnect_RejectsZeroAmount(t *testing.T) {
	c := &StripeConnectClient{Secret: "sk_test"}
	_, err := c.ExecuteTransfer(context.Background(), "acct", 0, "usd", "", "p1")
	require.Error(t, err)
}

// Race-protection: two concurrent payout aggregations of the same
// conversion set must produce the SAME Stripe idempotency key. The
// previous design used the local payout-row id, which differed
// between race losers and let Stripe issue two transfers — confirmed
// fix derives the key from the affiliate id + sorted conversion ids.
func TestDeterministicPayoutIdempotencyKey_StableAcrossOrdering(t *testing.T) {
	affID := "aff-abc"
	a := deterministicPayoutIdempotencyKey(affID, []int64{3, 1, 2})
	b := deterministicPayoutIdempotencyKey(affID, []int64{1, 2, 3})
	c := deterministicPayoutIdempotencyKey(affID, []int64{2, 1, 3})
	require.Equal(t, a, b)
	require.Equal(t, b, c)
}

func TestDeterministicPayoutIdempotencyKey_DifferentSets(t *testing.T) {
	a := deterministicPayoutIdempotencyKey("aff-abc", []int64{1, 2})
	b := deterministicPayoutIdempotencyKey("aff-abc", []int64{1, 2, 3})
	c := deterministicPayoutIdempotencyKey("aff-xyz", []int64{1, 2})
	require.NotEqual(t, a, b)
	require.NotEqual(t, a, c)
}

func TestSanitizeSlugForDesc(t *testing.T) {
	require.Equal(t, "alice-2025", sanitizeSlugForDesc("alice-2025"))
	require.Equal(t, "aliceevil", sanitizeSlugForDesc("alice\n\r evil"))
	require.Equal(t, "abc", sanitizeSlugForDesc("a!b@c#"))
}
