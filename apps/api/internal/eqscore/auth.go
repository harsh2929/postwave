// SPDX-License-Identifier: AGPL-3.0-only
//
// auth.go — the auth sub-score. The dispatcher pre-populates
// Input.{SPFVerified,DKIMVerified,DMARCAligned} from its sending-domain
// cache; this file just maps those flags into a score + reasons.
// Score-only logic; no DNS, no DB.

package eqscore

import "strings"

func scoreAuth(in Input) SubScore {
	score := 100
	reasons := []Reason{}

	domain := stableDomain(in.From)

	// From: empty.
	if strings.TrimSpace(in.From) == "" {
		score -= 50
		reasons = append(reasons, Reason{
			Code: "from_empty", Severity: "fail", Bucket: "auth",
			Message: "From address is empty; cannot evaluate sender authentication.",
		})
		return SubScore{Score: clamp(score), Reasons: reasons}
	}
	if domain == "" {
		score -= 50
		reasons = append(reasons, Reason{
			Code: "from_malformed", Severity: "fail", Bucket: "auth",
			Message: "From address is missing the '@domain' part.",
		})
		return SubScore{Score: clamp(score), Reasons: reasons}
	}

	// Verified-domains: the From domain must be in the tenant's
	// verified set. This is the precondition for any SPF/DKIM/DMARC
	// signal to count.
	verified := false
	for _, d := range in.VerifiedDomains {
		if strings.EqualFold(strings.TrimSpace(d), domain) {
			verified = true
			break
		}
	}
	if !verified {
		// Heavy deduction — sending from an unverified domain is the
		// single highest cause of spam-folder placement. We don't
		// outright fail (score=0) because the dispatcher may use the
		// reason list to surface a one-click verify CTA, and we want
		// the rest of the auth signals to still influence the grade.
		score -= 40
		reasons = append(reasons, Reason{
			Code: "domain_not_verified", Severity: "fail", Bucket: "auth",
			Message: "The From domain (" + domain + ") is not verified for this workspace. Verify the domain to send under your own SPF/DKIM/DMARC.",
		})
	}

	// SPF.
	if !in.SPFVerified {
		score -= 15
		reasons = append(reasons, Reason{
			Code: "spf_missing", Severity: "warning", Bucket: "auth",
			Message: "SPF is not aligned for " + domain + ". Add the SPF include shown in Domains → Verify to your domain's SPF record.",
		})
	}
	// DKIM.
	if !in.DKIMVerified {
		score -= 20
		reasons = append(reasons, Reason{
			Code: "dkim_missing", Severity: "warning", Bucket: "auth",
			Message: "DKIM is not aligned for " + domain + ". Publish the DKIM selector records shown in Domains → Verify.",
		})
	}
	// DMARC.
	if !in.DMARCAligned {
		score -= 10
		reasons = append(reasons, Reason{
			Code: "dmarc_missing", Severity: "warning", Bucket: "auth",
			Message: "DMARC is not aligned for " + domain + ". Publish a _dmarc TXT record at policy p=none (or higher) to receive aggregate reports.",
		})
	}

	return SubScore{Score: clamp(score), Reasons: reasons}
}
