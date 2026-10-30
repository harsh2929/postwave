// SPDX-License-Identifier: AGPL-3.0-only
//
// projection.go — the import-preflight estimate.
//
// The subscriber-import wizard already runs a dry run that tells an
// operator what a file WOULD do before they commit it. This adds the
// verification half of that answer: how much of the list the free tier
// can already adjudicate, how many rows are recoverable typos, and what
// the paid tier would cost if they ran it.
//
// THE INVARIANT: a projection never spends a credit.
//
// That is not a performance choice, it is the whole point. An operator
// clicks "preview" to find out what something will cost; a preview that
// itself charges them is worse than useless. So this runs the local
// tier plus CACHE READS only, and reports the vendor cost as an
// estimate. It never resolves a vendor credential, so it cannot even
// accidentally make a billable call.

package verification

import (
	"context"
	"strings"
)

// maxProjectionSuggestions caps the recoverable-typo list. A 250k-row
// import of garbage must not embed a 250k-entry array in the dry-run
// JSON blob.
const maxProjectionSuggestions = 100

// TypoSuggestion is one recoverable address.
type TypoSuggestion struct {
	Email      string `json:"email"`
	DidYouMean string `json:"did_you_mean"`
}

// ImportProjection is the preflight estimate.
type ImportProjection struct {
	// Mode is the enforcement mode this projection assumed.
	Mode string `json:"mode"`
	// Total is the deduplicated address count.
	Total int64 `json:"total"`
	// Duplicates collapsed within the file.
	Duplicates int64 `json:"duplicates"`
	// LocallyDecided is how many the free tier settled outright.
	LocallyDecided int64 `json:"locally_decided"`
	// CacheHits were already verified and paid for previously.
	CacheHits int64 `json:"cache_hits"`
	// NeedsMailboxProbe is how many addresses the free tier could not
	// settle. This is the HYPOTHETICAL full-mode cost and is reported
	// regardless of the current mode, because the operator deciding
	// whether to turn full mode ON needs exactly this number.
	NeedsMailboxProbe int64 `json:"needs_mailbox_probe"`
	// WouldCostCredits is the spend under the CURRENT mode: equal to
	// NeedsMailboxProbe in full mode, zero otherwise, because in
	// off/local mode the vendor is never reached. Kept separate from
	// NeedsMailboxProbe so a UI cannot accidentally show a bill for a
	// mode the tenant is not in.
	WouldCostCredits int64 `json:"would_cost_credits"`
	// CreditsSpent is always zero. Present so a reader of the payload
	// can see that stated rather than having to trust a comment.
	CreditsSpent int64 `json:"credits_spent"`

	ByStatus map[string]int64 `json:"by_status"`

	// Suggestions are recoverable typos — the most actionable thing a
	// preflight can surface, because these rows can be fixed rather
	// than dropped.
	Suggestions       []TypoSuggestion `json:"suggestions,omitempty"`
	SuggestionsCapped bool             `json:"suggestions_capped,omitempty"`
}

// ProjectImport estimates verification for a set of addresses without
// spending anything.
func (s *Store) ProjectImport(ctx context.Context, tenantID string, emails []string) (ImportProjection, error) {
	policy, err := s.Policy(ctx, tenantID)
	if err != nil {
		return ImportProjection{}, err
	}
	return s.projectWithPolicy(ctx, tenantID, policy, emails)
}

// projectWithPolicy is the shared implementation.
//
// The policy is a PARAMETER rather than something read from the Store,
// because the Store is a single instance shared by every concurrent
// request. An earlier version of this stashed an override on the Store
// and restored it in a defer, which is a data race: two requests
// projecting different modes at the same time would read each other's
// override.
func (s *Store) projectWithPolicy(ctx context.Context, tenantID string, policy Policy, emails []string) (ImportProjection, error) {
	out := ImportProjection{
		Mode:     policy.ImportMode,
		ByStatus: map[string]int64{},
	}
	if len(emails) == 0 {
		return out, nil
	}

	// Deduplicate first so the cost estimate reflects what would
	// actually be billed, not the raw row count.
	unique := make([]string, 0, len(emails))
	seen := make(map[string]struct{}, len(emails))
	for _, e := range emails {
		n := NormalizeEmail(e)
		if n == "" {
			continue
		}
		if _, dup := seen[n]; dup {
			out.Duplicates++
			continue
		}
		seen[n] = struct{}{}
		unique = append(unique, n)
	}
	out.Total = int64(len(unique))

	// Cache reads are free and represent credits already spent.
	cached := map[string]Result{}
	if s.Pool != nil {
		cache := &TenantCache{Store: s, TenantID: tenantID, TTL: DefaultCacheTTL}
		if hits, err := cache.Get(ctx, unique); err == nil {
			cached = hits
		}
	}

	local := s.localVerifier()
	for _, e := range unique {
		if hit, ok := cached[e]; ok {
			out.CacheHits++
			out.ByStatus[string(hit.Status)]++
			continue
		}

		r, err := local.Verify(ctx, e)
		if err != nil {
			out.ByStatus[string(StatusUnknown)]++
			continue
		}
		out.ByStatus[string(r.Status)]++

		if r.DidYouMean != "" {
			if len(out.Suggestions) < maxProjectionSuggestions {
				out.Suggestions = append(out.Suggestions, TypoSuggestion{
					Email: r.Email, DidYouMean: r.DidYouMean,
				})
			} else {
				out.SuggestionsCapped = true
			}
		}

		if r.Status.Decisive() {
			out.LocallyDecided++
			continue
		}
		// Everything the free tier could not settle is what a vendor
		// run would be billed for.
		out.NeedsMailboxProbe++
		// ...but only full mode actually reaches a vendor.
		if policy.ImportMode == ModeFull {
			out.WouldCostCredits++
		}
	}
	return out, nil
}

// ProjectImportForMode is ProjectImport with the mode forced, for the
// settings UI's "what would full mode cost me?" preview. Still spends
// nothing.
func (s *Store) ProjectImportForMode(ctx context.Context, tenantID, mode string, emails []string) (ImportProjection, error) {
	if err := ValidateMode(mode); err != nil {
		return ImportProjection{}, err
	}
	saved, err := s.Policy(ctx, tenantID)
	if err != nil {
		return ImportProjection{}, err
	}
	// A preview must never write the policy it is previewing, so this
	// is a local copy handed straight to the shared implementation.
	forced := saved
	forced.ImportMode = strings.TrimSpace(mode)
	return s.projectWithPolicy(ctx, tenantID, forced, emails)
}
