package auth

import (
	"context"
	"fmt"
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// CheckSPF resolves the SPF TXT record for `domain`, validates that exactly
// one v=spf1 record exists, and counts DNS-querying mechanisms (a, mx,
// include, exists, redirect, ptr) against RFC 7208 §4.6.4's 10-lookup limit.
//
// Includes are recursively expanded; the recursion is cycle-guarded.
func CheckSPF(ctx context.Context, r Resolver, dom string) domain.AuthRecord {
	txts, err := r.LookupTXT(ctx, dom)
	if err != nil {
		return fail("spf lookup failed: " + err.Error())
	}
	var spf string
	count := 0
	for _, t := range txts {
		if strings.HasPrefix(t, "v=spf1") {
			spf = t
			count++
		}
	}
	if count == 0 {
		return fail("no SPF record found")
	}
	if count > 1 {
		return fail(fmt.Sprintf("multiple SPF records (%d) — RFC 7208 violation", count))
	}

	seen := map[string]bool{dom: true}
	lookups, err := countLookups(ctx, r, spf, seen, 0)
	if err != nil {
		return warn("SPF parsed but include expansion failed: " + err.Error())
	}
	if lookups > 10 {
		return fail(fmt.Sprintf("SPF exceeds 10-lookup limit (%d). Inbound MTAs will permerror.", lookups))
	}
	if lookups > 8 {
		return warn(fmt.Sprintf("SPF near 10-lookup limit (%d). Flatten includes proactively.", lookups))
	}
	return ok(fmt.Sprintf("SPF valid, %d DNS-querying mechanisms.", lookups))
}

// countLookups returns the number of DNS-querying mechanisms an SPF record
// uses (recursive across includes). Caps at depth 10 for safety.
func countLookups(ctx context.Context, r Resolver, record string, seen map[string]bool, depth int) (int, error) {
	if depth > 10 {
		return 0, fmt.Errorf("include depth exceeded")
	}
	count := 0
	for _, tok := range strings.Fields(record) {
		switch {
		case strings.HasPrefix(tok, "include:"):
			count++
			d := strings.TrimPrefix(tok, "include:")
			if seen[d] {
				continue
			}
			seen[d] = true
			txts, err := r.LookupTXT(ctx, d)
			if err != nil {
				continue
			}
			for _, t := range txts {
				if strings.HasPrefix(t, "v=spf1") {
					sub, err := countLookups(ctx, r, t, seen, depth+1)
					if err != nil {
						return count, err
					}
					count += sub
					break
				}
			}
		case tok == "a", tok == "mx", strings.HasPrefix(tok, "a:"),
			strings.HasPrefix(tok, "mx:"), strings.HasPrefix(tok, "exists:"),
			strings.HasPrefix(tok, "redirect="), tok == "ptr",
			strings.HasPrefix(tok, "ptr:"):
			count++
		}
	}
	return count, nil
}
