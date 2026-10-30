package auth

import (
	"context"
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// CheckPTR validates that the sending IP has a reverse-DNS entry and that
// the PTR matches the supplied helo/sending domain (forward-confirmed
// reverse DNS — FCrDNS). Failing PTR is a leading cause of Outlook spam
// folder placement.
func CheckPTR(ctx context.Context, r Resolver, ip, expectedSuffix string) domain.AuthRecord {
	if ip == "" {
		return warn("no sending IP supplied; PTR check skipped")
	}
	names, err := r.LookupAddr(ctx, ip)
	if err != nil {
		return fail("PTR lookup failed: " + err.Error())
	}
	if len(names) == 0 {
		return fail("no PTR record for " + ip)
	}
	if expectedSuffix != "" {
		for _, n := range names {
			if strings.HasSuffix(strings.TrimSuffix(n, "."), expectedSuffix) {
				return ok("PTR " + n + " matches sending domain.")
			}
		}
		return warn("PTR " + names[0] + " present but does not match expected suffix " + expectedSuffix)
	}
	return ok("PTR " + names[0])
}
