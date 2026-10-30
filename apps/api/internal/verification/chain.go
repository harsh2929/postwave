// SPDX-License-Identifier: AGPL-3.0-only
//
// chain.go — the tiered verifier.
//
// Chain is the thing that makes paid verification affordable. It runs
// three tiers in increasing order of cost and stops at the first one
// that can answer:
//
//	1. cache   — free, instant. A verdict already paid for.
//	2. local   — free. Can DISPROVE structural no-mail cases and narrow
//	             abuse desks; list/role heuristics remain advisory.
//	3. vendor  — one credit per address. The only tier that can
//	             confirm a mailbox.
//
// The ordering is not just an optimisation. Running the local tier first also
// means structurally invalid addresses never leave our network, reducing
// unnecessary third-party disclosure.
//
// Everything the chain reports about its own savings (ChainStats) is
// measured, not estimated, so the operator-facing number is auditable.

package verification

import (
	"context"
	"fmt"
)

// ResultCache is the persistence hook for verdicts already paid for.
// Implemented by the Postgres store in store.go; the chain only needs
// these two operations.
type ResultCache interface {
	// Get returns the subset of emails that have a live cached
	// verdict, keyed by the address as supplied.
	Get(ctx context.Context, emails []string) (map[string]Result, error)
	// Put persists verdicts worth reusing.
	Put(ctx context.Context, results []Result) error
}

// ChainStats is the measured accounting for one batch.
type ChainStats struct {
	Total          int `json:"total"`
	CacheHits      int `json:"cache_hits"`
	LocalFiltered  int `json:"local_filtered"`
	VendorVerified int `json:"vendor_verified"`
	CreditsSpent   int `json:"credits_spent"`
	// Duplicates counts repeated addresses collapsed within the batch.
	Duplicates int `json:"duplicates"`
}

// SavedCredits is how many vendor calls the free tiers avoided.
func (s ChainStats) SavedCredits() int {
	saved := s.Total - s.CreditsSpent
	if saved < 0 {
		return 0
	}
	return saved
}

// SavingsRatio is SavedCredits as a fraction of Total. Zero for an
// empty batch rather than NaN, because this value is rendered
// directly in the dashboard and serialised to JSON, where NaN is not
// representable and would corrupt the response.
func (s ChainStats) SavingsRatio() float64 {
	if s.Total <= 0 {
		return 0
	}
	return float64(s.SavedCredits()) / float64(s.Total)
}

// Chain composes the tiers. Local and Vendor are both optional, but at
// least one must be set.
type Chain struct {
	// Local is the free tier. Normally a *LocalVerifier.
	Local Verifier
	// Vendor is the metered tier. nil means free-tier-only, which is
	// a supported configuration.
	Vendor Verifier
	// Cache is optional; nil disables caching entirely.
	Cache ResultCache

	// DegradeOnVendorFailure controls what happens when the vendor is
	// unreachable. Default (false) returns the error, so an outage
	// surfaces as an outage. Setting it true returns the local
	// verdict tagged SubStatusProviderUnavailable. This is only appropriate for
	// explicitly advisory callers that accept uncertainty. Billable HTTP
	// requests, durable jobs/imports, and signup enforcement clone the chain into
	// strict mode so a possibly charged request is never hidden as local-only.
	//
	// Credit exhaustion and auth failures are NEVER degraded: both are
	// operator-actionable and both would otherwise repeat silently for
	// every remaining address.
	DegradeOnVendorFailure bool
}

// Name implements Verifier.
func (c *Chain) Name() string {
	if c.Vendor != nil {
		return c.Vendor.Name()
	}
	if c.Local != nil {
		return c.Local.Name()
	}
	return "unconfigured"
}

// Credits implements Verifier, reporting the metered tier's balance.
func (c *Chain) Credits(ctx context.Context) (int, error) {
	if c.Vendor == nil {
		return CreditsUnmetered, nil
	}
	return c.Vendor.Credits(ctx)
}

// Verify implements Verifier for a single address.
func (c *Chain) Verify(ctx context.Context, email string) (Result, error) {
	results, _, err := c.VerifyBatch(ctx, []string{email})
	if err != nil {
		return Result{}, err
	}
	if len(results) == 0 {
		// Errors flow into durable signup/job receipts and logs. Never attach the
		// raw address to an invariant failure.
		return Result{}, fmt.Errorf("verification: chain returned no result")
	}
	return results[0], nil
}

// VerifyBatch runs the tiers and returns one Result per input, in
// input order, plus the measured accounting.
func (c *Chain) VerifyBatch(ctx context.Context, emails []string) ([]Result, ChainStats, error) {
	return c.verifyBatch(ctx, emails, nil)
}

// VerifyBatchWithDispatchHook is the durable-worker variant of VerifyBatch.
// beforeVendor is called after cache/local filtering and immediately before
// the first metered-provider call. A job worker uses it to commit an exact
// request-start receipt before any call that may consume credits. Ordinary
// synchronous callers should use VerifyBatch.
func (c *Chain) VerifyBatchWithDispatchHook(
	ctx context.Context,
	emails []string,
	beforeVendor func(context.Context, []string) error,
) ([]Result, ChainStats, error) {
	return c.verifyBatch(ctx, emails, beforeVendor)
}

func (c *Chain) verifyBatch(
	ctx context.Context,
	emails []string,
	beforeVendor func(context.Context, []string) error,
) ([]Result, ChainStats, error) {
	stats := ChainStats{Total: len(emails)}

	if c.Local == nil && c.Vendor == nil {
		return nil, stats, fmt.Errorf("verification: chain has no tiers: %w", ErrNotConfigured)
	}
	if len(emails) > MaxBatch {
		return nil, stats, ErrBatchTooLarge
	}
	if len(emails) == 0 {
		return []Result{}, stats, nil
	}

	// Canonicalize and collapse duplicates up front. Email identity in every
	// persistence surface is NormalizeEmail(raw); using the raw spelling here
	// would let "Person@Example.com" and " person@example.com " consume two
	// provider credits while later colliding in the cache. Providers also only
	// receive the bounded canonical spelling, never incidental CSV whitespace.
	unique := make([]string, 0, len(emails))
	canonical := make([]string, len(emails))
	seen := make(map[string]struct{}, len(emails))
	for i, raw := range emails {
		e := NormalizeEmail(raw)
		canonical[i] = e
		if _, dup := seen[e]; dup {
			stats.Duplicates++
			continue
		}
		seen[e] = struct{}{}
		unique = append(unique, e)
	}

	verdicts := make(map[string]Result, len(unique))

	// --- tier 1: cache ---
	pending := unique
	cacheReadFailed := false
	if c.Cache != nil {
		hits, err := c.Cache.Get(ctx, unique)
		if err != nil {
			// Do not trust a partial result alongside an error. We can still run
			// the free local tier, but any address left for the vendor below must
			// stop: without a successful cache read we cannot prove that another
			// request has not already paid for it.
			cacheReadFailed = true
			hits = nil
		}
		if len(hits) > 0 {
			remaining := make([]string, 0, len(unique))
			for _, e := range unique {
				if r, ok := hits[e]; ok {
					r.Cached = true
					// The credit was spent when this verdict was
					// first obtained. Re-reporting it as billable
					// would double-count in every downstream total.
					r.Billable = false
					verdicts[e] = r
					stats.CacheHits++
					continue
				}
				remaining = append(remaining, e)
			}
			pending = remaining
		}
	}

	// --- tier 2: local ---
	var freshlyDecided []Result
	if c.Local != nil && len(pending) > 0 {
		localResults, err := c.Local.VerifyBatch(ctx, pending)
		if err != nil {
			return nil, stats, fmt.Errorf("verification: local tier: %w", err)
		}
		remaining := make([]string, 0, len(pending))
		for i, e := range pending {
			if i >= len(localResults) {
				remaining = append(remaining, e)
				continue
			}
			r := localResults[i]
			r.Billable = false
			if r.Status.Decisive() {
				verdicts[e] = r
				stats.LocalFiltered++
				freshlyDecided = append(freshlyDecided, r)
				continue
			}
			// Hold the local verdict as the fallback if the vendor
			// tier is absent or degrades.
			verdicts[e] = r
			remaining = append(remaining, e)
		}
		pending = remaining
	}

	// --- tier 3: vendor ---
	if c.Vendor != nil && len(pending) > 0 {
		if cacheReadFailed {
			// Never include the underlying cache error: database errors may carry
			// tenant identifiers, addresses, SQL detail, or infrastructure names.
			return nil, stats, fmt.Errorf(
				"verification: cannot safely dispatch while prior paid results are unavailable: %w",
				ErrCacheUnavailable,
			)
		}
		var vendorResults []Result
		var err error
		if hooked, ok := c.Vendor.(batchDispatchHookVerifier); ok {
			vendorResults, err = hooked.verifyBatchWithDispatchHook(ctx, pending, beforeVendor)
		} else {
			if beforeVendor != nil {
				// Do not expose the chain's mutable working slice to a callback.
				dispatched := append([]string(nil), pending...)
				if hookErr := beforeVendor(ctx, dispatched); hookErr != nil {
					return nil, stats, fmt.Errorf("verification: persist vendor dispatch receipt: %w", hookErr)
				}
			}
			vendorResults, err = c.Vendor.VerifyBatch(ctx, pending)
		}
		if err == nil && len(vendorResults) != len(pending) {
			// The request crossed a metered boundary, but the provider adapter did
			// not produce the promised receipt for every address. Treat the whole
			// operation as ambiguous so durable callers never retry it blindly.
			err = fmt.Errorf("verification: provider returned %d results for %d addresses: %w",
				len(vendorResults), len(pending), ErrProviderPartialOutcome)
			vendorResults = nil
		}
		if err == nil {
			for i := range vendorResults {
				if NormalizeEmail(vendorResults[i].Email) != pending[i] {
					err = fmt.Errorf("verification: provider returned a mismatched result identity: %w",
						ErrProviderPartialOutcome)
					break
				}
				vendorResults[i].Email = pending[i]
				if validationErr := validatePersistableResult(vendorResults[i]); validationErr != nil {
					err = fmt.Errorf("verification: provider returned a result outside the canonical contract: %w",
						ErrProviderPartialOutcome)
					break
				}
			}
			if err != nil {
				vendorResults = nil
			}
		}
		observeVerificationProviderBatch(c.Vendor.Name(), len(pending), vendorResults, err)
		switch {
		case err == nil:
			for i, e := range pending {
				if i >= len(vendorResults) {
					continue
				}
				r := vendorResults[i]
				r.Email = e
				verdicts[e] = r
				stats.VendorVerified++
				if r.Billable {
					stats.CreditsSpent++
				}
				freshlyDecided = append(freshlyDecided, r)
			}
		case isFatalProviderError(err):
			// Billing/auth problems are never degraded — they are
			// actionable and they would otherwise recur silently.
			return nil, stats, err
		case c.DegradeOnVendorFailure:
			for _, e := range pending {
				r, ok := verdicts[e]
				if !ok {
					r = Result{Email: e, Status: StatusUnknown, Provider: ProviderLocal}
				}
				// Mark the degradation so a caller reading the result
				// can tell "the vendor said unknown" from "we never
				// managed to ask".
				r.SubStatus = SubStatusProviderUnavailable
				r.Billable = false
				verdicts[e] = r
			}
		default:
			return nil, stats, err
		}
	}

	// Persist only verdicts that are both new and worth reusing.
	if c.Cache != nil && len(freshlyDecided) > 0 {
		cacheable := make([]Result, 0, len(freshlyDecided))
		for _, r := range freshlyDecided {
			if cacheableResult(r) {
				cacheable = append(cacheable, r)
			}
		}
		if len(cacheable) > 0 {
			if err := c.Cache.Put(ctx, cacheable); err != nil {
				// A decisive result that was not durably retained must not look like a
				// normal success. Besides repeat vendor spend, local terminal evidence
				// is part of the send-time health fact; returning it without retention
				// could make the same recipient look send-eligible later. The caller's
				// dispatch receipt determines whether a paid attempt also becomes a
				// replayable conflict.
				// Do not wrap the raw cache error for the same privacy reason as the
				// read failure above.
				return nil, stats, fmt.Errorf(
					"verification: decisive result could not be durably cached: %w",
					ErrCacheUnavailable,
				)
			}
		}
	}

	out := make([]Result, 0, len(emails))
	for _, e := range canonical {
		r, ok := verdicts[e]
		if !ok {
			r = Result{Email: e, Status: StatusUnknown, SubStatus: SubStatusProviderUnavailable}
		}
		if r.Email == "" {
			r.Email = e
		}
		out = append(out, r)
	}
	return out, stats, nil
}

// cacheableResult reports whether a verdict is worth persisting.
//
// Two exclusions matter:
//
//   - SubStatusProviderUnavailable — caching a transient outage would
//     pin a perfectly good address to "unknown" for the whole TTL.
//   - a bare local "unknown" — it carries no information, and storing
//     it would suppress the very vendor call it exists to trigger.
func cacheableResult(r Result) bool {
	if r.SubStatus == SubStatusProviderUnavailable {
		return false
	}
	if r.Status == StatusUnknown && r.Provider == ProviderLocal {
		return false
	}
	if r.Status == StatusUnknown && r.SubStatus == SubStatusNoMailboxProbe {
		return false
	}
	return r.Status.Valid() && r.Status != ""
}
