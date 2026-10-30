package auth

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// CheckDKIM looks up `<selector>._domainkey.<domain>`, parses the v=DKIM1
// TXT, and validates that the public key is at least 1024 bits (we warn at
// 1024, ok at 2048+).
func CheckDKIM(ctx context.Context, r Resolver, dom, selector string) domain.AuthRecord {
	if selector == "" {
		return fail("DKIM selector required")
	}
	host := selector + "._domainkey." + dom
	txts, err := r.LookupTXT(ctx, host)
	if err != nil {
		return fail("DKIM lookup failed: " + err.Error())
	}
	if len(txts) == 0 {
		return fail("no DKIM record at " + host)
	}
	rec := strings.Join(txts, "")
	if !strings.Contains(rec, "v=DKIM1") {
		return fail("record at " + host + " is not v=DKIM1")
	}
	// Pull p= tag (the public key).
	var pk string
	for _, part := range strings.Split(rec, ";") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "p=") {
			pk = strings.TrimPrefix(part, "p=")
		}
	}
	if pk == "" {
		return fail("DKIM record missing or empty p= (key revoked?)")
	}
	raw, err := base64.StdEncoding.DecodeString(pk)
	if err != nil {
		return warn("DKIM key not valid base64: " + err.Error())
	}
	// Rough bit-length: ASN.1 RSA public key is ~ keyBits/8 bytes plus headers.
	bits := len(raw) * 8
	switch {
	case bits < 1024:
		return fail(fmt.Sprintf("DKIM key only ~%d bits (Gmail rejects <1024).", bits))
	case bits < 2048:
		return warn(fmt.Sprintf("DKIM key ~%d bits. Consider rotating to 2048 for forward-strength.", bits))
	}
	return ok(fmt.Sprintf("DKIM valid (selector=%s, ~%d bits).", selector, bits))
}
