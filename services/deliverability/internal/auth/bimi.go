package auth

import (
	"context"
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// CheckBIMI fetches `default._bimi.<domain>`, validates v=BIMI1, and reports
// whether a mark certificate (a= URL) is present. As of 2024+ there are TWO
// certificate tiers: a VMC (requires a registered trademark → logo PLUS Gmail's
// blue verified checkmark) and a CMC / Common Mark Certificate (no trademark →
// logo WITHOUT the checkmark, Gmail-only). Yahoo/Fastmail render a self-asserted
// (certificate-less) logo; Apple Mail is VMC-only; consumer Outlook.com renders
// no BIMI logo at all. The a= tag alone cannot tell VMC from CMC (that is in the
// certificate), so the guidance reflects both.
func CheckBIMI(ctx context.Context, r Resolver, dom string) domain.AuthRecord {
	host := "default._bimi." + dom
	txts, err := r.LookupTXT(ctx, host)
	if err != nil {
		return warn("BIMI lookup failed (BIMI is optional): " + err.Error())
	}
	var rec string
	for _, t := range txts {
		if strings.HasPrefix(t, "v=BIMI1") {
			rec = t
			break
		}
	}
	if rec == "" {
		return warn("no BIMI record. Optional, but without one no brand logo renders in Gmail, Yahoo or Apple.")
	}
	hasL, hasA := false, false
	for _, part := range strings.Split(rec, ";") {
		p := strings.TrimSpace(part)
		if strings.HasPrefix(p, "l=") {
			hasL = true
		}
		if strings.HasPrefix(p, "a=") {
			hasA = true
		}
	}
	if !hasL {
		return fail("BIMI record present but missing l= (logo URL)")
	}
	if !hasA {
		// A certificate-less (self-asserted) BIMI record still renders in
		// Yahoo/Fastmail, but not Gmail or Apple. This is a valid low-cost tier,
		// not a failure.
		return warn("BIMI record has a logo but no mark certificate (a=). It will render in Yahoo/Fastmail, but Gmail and Apple need a VMC or CMC.")
	}
	return ok("BIMI valid with a mark certificate (a=). A VMC shows Gmail's verified checkmark; a CMC shows the logo without it.")
}
