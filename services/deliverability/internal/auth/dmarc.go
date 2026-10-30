package auth

import (
	"context"
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// DMARCPolicy is the parsed subset of a DMARC record we care about.
type DMARCPolicy struct {
	Version   string // v=DMARC1
	Policy    string // none|quarantine|reject
	SubPolicy string // sp=
	Pct       string // pct=
	RUA       string // rua= aggregate report endpoint
	RUF       string // ruf= forensic report endpoint
	ADKIM     string
	ASPF      string
	// DMARCbis (RFC 9989, May 2026) additions:
	NonExistentPolicy string // np= — policy for non-existent subdomains
	PSD               string // psd= — this record is on a public suffix domain
}

// CheckDMARC fetches `_dmarc.<domain>` and grades policy strength.
func CheckDMARC(ctx context.Context, r Resolver, dom string) (domain.AuthRecord, DMARCPolicy) {
	host := "_dmarc." + dom
	txts, err := r.LookupTXT(ctx, host)
	if err != nil {
		return fail("DMARC lookup failed: " + err.Error()), DMARCPolicy{}
	}
	var raw string
	for _, t := range txts {
		if strings.HasPrefix(t, "v=DMARC1") {
			raw = t
			break
		}
	}
	if raw == "" {
		return fail("no DMARC record at " + host + ". Recommend v=DMARC1; p=none; rua=mailto:dmarc@<domain>"), DMARCPolicy{}
	}
	pol := parseDMARC(raw)
	switch pol.Policy {
	case "":
		return fail("DMARC record missing p= tag"), pol
	case "none":
		return warn("DMARC monitoring-only (p=none). Move to p=quarantine once aggregate reports look clean."), pol
	case "quarantine":
		return ok("DMARC at p=quarantine. Consider p=reject when ready."), pol
	case "reject":
		return ok("DMARC at p=reject — strongest policy."), pol
	}
	return warn("DMARC policy unrecognized: " + pol.Policy), pol
}

func parseDMARC(rec string) DMARCPolicy {
	p := DMARCPolicy{Version: "DMARC1"}
	for _, part := range strings.Split(rec, ";") {
		part = strings.TrimSpace(part)
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "p":
			p.Policy = strings.TrimSpace(v)
		case "sp":
			p.SubPolicy = strings.TrimSpace(v)
		case "pct":
			p.Pct = strings.TrimSpace(v)
		case "rua":
			p.RUA = strings.TrimSpace(v)
		case "ruf":
			p.RUF = strings.TrimSpace(v)
		case "adkim":
			p.ADKIM = strings.TrimSpace(v)
		case "aspf":
			p.ASPF = strings.TrimSpace(v)
		case "np":
			// DMARCbis: policy for non-existent subdomains. A strong
			// anti-spoofing signal that the pre-9989 parser silently dropped.
			p.NonExistentPolicy = strings.TrimSpace(v)
		case "psd":
			p.PSD = strings.TrimSpace(v)
		}
	}
	return p
}
