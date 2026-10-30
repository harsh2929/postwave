// SPDX-License-Identifier: AGPL-3.0-only
//
// verification_projection.go — the verification half of the import
// preflight.
//
// The dry run already answers "what would this file DO?". This answers
// the two questions an operator asks next:
//
//   - How much of this list is already junk, and can I see that before
//     I import it rather than after it bounces?
//   - If I turn on paid verification, what would this cost?
//
// It is strictly a PROJECTION. It never spends a credit and never
// resolves a vendor credential — see verification/projection.go for why
// that invariant is load-bearing rather than incidental.
//
// The interface and payload types are declared locally so this package
// takes no dependency on internal/verification, matching the way
// internal/forms declares SignupGate.

package subscriber_import

import "context"

// TypoSuggestion is one recoverable address.
type TypoSuggestion struct {
	Email      string `json:"email"`
	DidYouMean string `json:"did_you_mean"`
}

// VerificationProjection mirrors verification.ImportProjection.
type VerificationProjection struct {
	Mode              string           `json:"mode"`
	Total             int64            `json:"total"`
	Duplicates        int64            `json:"duplicates"`
	LocallyDecided    int64            `json:"locally_decided"`
	CacheHits         int64            `json:"cache_hits"`
	NeedsMailboxProbe int64            `json:"needs_mailbox_probe"`
	WouldCostCredits  int64            `json:"would_cost_credits"`
	ByStatus          map[string]int64 `json:"by_status,omitempty"`
	Suggestions       []TypoSuggestion `json:"suggestions,omitempty"`
	SuggestionsCapped bool             `json:"suggestions_capped,omitempty"`
}

// ImportProjector is the narrow contract the preflight needs.
type ImportProjector interface {
	ProjectImportPreflight(ctx context.Context, tenantID string, emails []string) (VerificationProjection, error)
}

// projectVerification runs the projection, returning nil when it is
// unavailable or fails.
//
// A nil result simply omits the section from the preview. The dry run
// is a mature, load-bearing surface and predates this entirely; a
// verification hiccup must never turn a working preview into an error
// page.
func (d *Deps) projectVerification(ctx context.Context, tenantID string, emails []string) *VerificationProjection {
	if d == nil || d.Verification == nil || len(emails) == 0 {
		return nil
	}
	projection, err := d.Verification.ProjectImportPreflight(ctx, tenantID, emails)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("subscriber_import: verification projection failed; omitting it from the preview",
				"error_class", subscriberImportLogErrorClass(err))
		}
		return nil
	}
	return &projection
}
