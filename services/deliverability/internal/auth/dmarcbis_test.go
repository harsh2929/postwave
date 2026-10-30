package auth

import "testing"

// DMARC became IETF Standards Track in May 2026 (RFC 9989/9990/9991, obsoleting
// RFC 7489). DMARCbis adds two policy tags the parser silently dropped:
//
//	np=  — the policy for NON-EXISTENT subdomains (distinct from sp=)
//	psd= — marks a public-suffix-domain record
//
// Dropping np= means a domain that publishes np=reject (a strong anti-spoofing
// signal for unused subdomains) was graded as if it had not.
func TestParseDMARC_ParsesNpAndPsd(t *testing.T) {
	p := parseDMARC("v=DMARC1; p=reject; sp=quarantine; np=reject; psd=y; adkim=s; aspf=s")
	if p.Policy != "reject" {
		t.Errorf("p = %q", p.Policy)
	}
	if p.SubPolicy != "quarantine" {
		t.Errorf("sp = %q", p.SubPolicy)
	}
	if p.NonExistentPolicy != "reject" {
		t.Errorf("np = %q, want reject (DMARCbis)", p.NonExistentPolicy)
	}
	if p.PSD != "y" {
		t.Errorf("psd = %q, want y", p.PSD)
	}
}

// A pre-DMARCbis record without np= must leave NonExistentPolicy empty (the
// resolver falls back to sp= then p= per the RFC), not crash or mislabel.
func TestParseDMARC_NpAbsentIsEmpty(t *testing.T) {
	p := parseDMARC("v=DMARC1; p=none")
	if p.NonExistentPolicy != "" || p.PSD != "" {
		t.Fatalf("absent np/psd must stay empty, got np=%q psd=%q", p.NonExistentPolicy, p.PSD)
	}
}
