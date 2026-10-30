// SPDX-License-Identifier: MIT

package activecampaign

import (
	"fmt"
	"net/http"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
)

// validateActiveCampaignRequestAccountBinding recomputes the account identity
// from the exact request base before the Api-Token can be attached. This keeps
// a resumable session bound to the account authenticated originally even if its
// API URL or an Adapter test override is later replaced.
//
// The only production bootstrap exception is Authenticate's exact /users/me
// request, which necessarily happens before its verified fingerprint can be
// persisted. Unbound loopback sessions remain available solely to package test
// fixtures; a present-but-mismatched fingerprint is rejected everywhere.
func validateActiveCampaignRequestAccountBinding(sess adapter.Session, base, method, path string) error {
	actual, err := accountFingerprintFromAPIURL(base)
	if err != nil {
		return fmt.Errorf("activecampaign: unsafe account API URL: %w", err)
	}
	stored := AccountFingerprint(sess)
	if stored == "" {
		if method == http.MethodGet && strings.TrimSpace(path) == "/users/me" {
			return nil
		}
		if allowInsecureActiveCampaignTestLoopback && isCanonicalLoopbackHost(accountHostFromAPIURL(base)) {
			return nil
		}
		return fmt.Errorf("activecampaign: authenticated session is missing its account binding: %w", adapter.ErrAuth)
	}
	if stored != actual {
		return fmt.Errorf("activecampaign: authenticated session belongs to a different account API URL: %w", adapter.ErrAuth)
	}
	return nil
}
