// SPDX-License-Identifier: AGPL-3.0-only
package verification

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Status codes for provider errors, held in place because nothing else does.
//
// `openapi.json` documents only 200 for the verify endpoint, so the spec cannot
// hold these, and a review confirmed the 502→412 change could be reverted with
// the package still green.
func TestProviderErrorStatuses(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want int
		why  string
	}{
		{
			"no credits is a billing state, not a server fault", ErrNoCredits,
			http.StatusPaymentRequired,
			"Returning 5xx would page an on-call engineer for an actionable billing state.",
		},
		{
			"a rejected API key is customer-fixable configuration", ErrUnauthorized,
			http.StatusPreconditionFailed,
			"The provider rejected the workspace's OWN configured key. 5xx pages " +
				"an engineer for a credential only the tenant can rotate, and marks " +
				"the request retryable when retrying cannot help.",
		},
		{
			"a conflated account rejection does not guess auth or quota", ErrProviderAccountRejected,
			http.StatusPreconditionFailed,
			"The provider explicitly rejected the account before work but did not distinguish credential from balance state.",
		},
		{
			"no provider configured is also configuration", ErrNotConfigured,
			http.StatusPreconditionFailed, "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			(&Deps{}).writeProviderError(rec, httptest.NewRequest(http.MethodPost, "/v", nil), tc.err)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d. %s", rec.Code, tc.want, tc.why)
			}
			var body struct {
				Error map[string]any `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error["code"] == nil {
				t.Fatalf("no machine-readable code in the body: %s", rec.Body.String())
			}
		})
	}
}
