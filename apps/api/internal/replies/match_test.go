package replies

import (
	"context"
	"strings"
	"testing"
)

// Canonical lowercase UUIDs — the only identifier shape the token accepts,
// because they are the shape campaign_replies.{campaign_id,subscriber_id}
// store and the shape every other match branch resolves to.
const (
	verpTestTenant     = "11111111-aaaa-4111-8111-1111111111ab"
	verpTestCampaign   = "22222222-bbbb-4222-8222-2222222222cd"
	verpTestSubscriber = "33333333-cccc-4333-8333-3333333333ef"
	verpTestOtherID    = "44444444-dddd-4444-8444-4444444444ab"
	verpTestNilUUID    = "00000000-0000-0000-0000-000000000000"
)

// TestEncodeDecodeVERPRoundTrip exercises the happy path: encode under a
// secret, decode under the same secret, get every original identifier back
// byte-for-byte. decode(encode(x)) == x is the property the store depends on.
func TestEncodeDecodeVERPRoundTrip(t *testing.T) {
	secret := []byte("test-verp-secret-32-bytes-padding")
	cases := []struct {
		name                             string
		tenantID, campaignID, subscriber string
	}{
		{"all present", verpTestTenant, verpTestCampaign, verpTestSubscriber},
		{"absent subscriber", verpTestTenant, verpTestCampaign, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tok, err := EncodeVERP(secret, tc.tenantID, tc.campaignID, tc.subscriber)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if tok == "" {
				t.Fatal("encode returned empty token")
			}
			tid, cid, sid, ok := DecodeVERP(secret, tok)
			if !ok {
				t.Fatalf("decode failed for %q", tok)
			}
			if tid != tc.tenantID || cid != tc.campaignID || sid != tc.subscriber {
				t.Errorf("roundtrip mismatch: tid=%q cid=%q sid=%q (want %q/%q/%q)",
					tid, cid, sid, tc.tenantID, tc.campaignID, tc.subscriber)
			}
		})
	}
}

// TestEncodeVERPRefusesNonCanonicalIdentifiers is the "encode and decode agree
// by construction" guard. Anything the encoder would let through that the
// decoder cannot reproduce exactly — or that campaign_replies' uuid columns
// could not store — must be refused at mint time, not discovered at persist
// time when the reply is already lost.
//
// The colon case is the specific historical defect: the previous layout was
// `mac || ':' || campaign || ':' || subscriber` decoded with SplitN(":", 2),
// so `a:b` / `sub` and `a` / `b:sub` produced an IDENTICAL MAC. A valid
// signature over a different campaign is authoritative-looking misattribution.
func TestEncodeVERPRefusesNonCanonicalIdentifiers(t *testing.T) {
	secret := []byte("test-verp-secret-32-bytes-padding")
	cases := []struct {
		name                             string
		tenantID, campaignID, subscriber string
	}{
		{"colon in campaign id", verpTestTenant, "camp:1", verpTestSubscriber},
		{"colon in tenant id", "tenant:1", verpTestCampaign, verpTestSubscriber},
		{"colon in subscriber id", verpTestTenant, verpTestCampaign, "sub:1"},
		{"opaque campaign id", verpTestTenant, "camp-abc123", verpTestSubscriber},
		{"uppercase campaign id", verpTestTenant, strings.ToUpper(verpTestCampaign), ""},
		{"braced campaign id", verpTestTenant, "{" + verpTestCampaign + "}", ""},
		{"undashed campaign id", verpTestTenant, strings.ReplaceAll(verpTestCampaign, "-", ""), ""},
		{"urn campaign id", verpTestTenant, "urn:uuid:" + verpTestCampaign, ""},
		{"empty tenant", "", verpTestCampaign, verpTestSubscriber},
		{"empty campaign", verpTestTenant, "", verpTestSubscriber},
		{"nil-uuid tenant", verpTestNilUUID, verpTestCampaign, ""},
		{"nil-uuid campaign", verpTestTenant, verpTestNilUUID, ""},
		// The nil UUID is this layout's encoding of "no subscriber". A caller
		// spelling it out is confused about which is which, so it is refused
		// rather than silently reinterpreted as absence.
		{"nil-uuid subscriber", verpTestTenant, verpTestCampaign, verpTestNilUUID},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tok, err := EncodeVERP(secret, tc.tenantID, tc.campaignID, tc.subscriber)
			if err == nil {
				t.Fatalf("encode accepted %q/%q/%q and produced %q",
					tc.tenantID, tc.campaignID, tc.subscriber, tok)
			}
			if tok != "" {
				t.Fatalf("encode returned a token alongside an error: %q", tok)
			}
		})
	}
}

// TestDecodeVERPRejectsForgery checks that a token signed with secret A
// doesn't decode under secret B, plus the degenerate inputs.
func TestDecodeVERPRejectsForgery(t *testing.T) {
	secretA := []byte("secret-A-pk-zoom-zoom-32-bytes-x")
	secretB := []byte("secret-B-pk-zoom-zoom-32-bytes-x")
	tok, err := EncodeVERP(secretA, verpTestTenant, verpTestCampaign, verpTestSubscriber)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if _, _, _, ok := DecodeVERP(secretB, tok); ok {
		t.Errorf("decode under wrong secret unexpectedly succeeded")
	}
	if _, _, _, ok := DecodeVERP(secretA, "not-a-real-token"); ok {
		t.Errorf("decode of garbage unexpectedly succeeded")
	}
	if _, _, _, ok := DecodeVERP(secretA, ""); ok {
		t.Errorf("decode of empty token unexpectedly succeeded")
	}
	if _, _, _, ok := DecodeVERP(nil, tok); ok {
		t.Errorf("decode with empty secret unexpectedly succeeded")
	}
	// Truncated and extended tokens are shape violations, not near-misses.
	if _, _, _, ok := DecodeVERP(secretA, tok[:len(tok)-8]); ok {
		t.Errorf("decode of truncated token unexpectedly succeeded")
	}
	if _, _, _, ok := DecodeVERP(secretA, tok+"aaaaaaaa"); ok {
		t.Errorf("decode of over-long token unexpectedly succeeded")
	}
}

// TestDecodeVERPRejectsEveryTamperedByte flips one bit in every byte of the
// decoded token — MAC bytes, the version byte, and each of the three
// identifier fields — and requires each mutant to be rejected.
//
// This is the guard that a signature covering only SOME of the payload cannot
// survive: a field the decoder reads but the MAC does not cover is
// attacker-controlled, and flipping a bit in it here would decode cleanly to a
// different (tenant, campaign, subscriber).
func TestDecodeVERPRejectsEveryTamperedByte(t *testing.T) {
	secret := []byte("tamper-secret-pk-zoom-32-bytes-x")
	tok, err := EncodeVERP(secret, verpTestTenant, verpTestCampaign, verpTestSubscriber)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	raw, err := verpEnc.DecodeString(strings.ToUpper(tok))
	if err != nil {
		t.Fatalf("decode own token: %v", err)
	}
	if len(raw) != verpTokenBytes {
		t.Fatalf("token is %d bytes, want %d", len(raw), verpTokenBytes)
	}
	for index := range raw {
		mutated := append([]byte(nil), raw...)
		mutated[index] ^= 0x01
		mutantToken := strings.ToLower(verpEnc.EncodeToString(mutated))
		if mutantToken == tok {
			t.Fatalf("byte %d mutation produced an identical token", index)
		}
		if tid, cid, sid, ok := DecodeVERP(secret, mutantToken); ok {
			t.Fatalf("byte %d mutation decoded to %q/%q/%q instead of being rejected",
				index, tid, cid, sid)
		}
	}
}

// TestDecodeVERPRejectsFieldTransposition swaps the campaign and subscriber
// fields while keeping the original MAC. A MAC computed over a concatenation
// with no framing would still verify; one computed over fixed-offset fields
// cannot.
func TestDecodeVERPRejectsFieldTransposition(t *testing.T) {
	secret := []byte("transpose-secret-zoom-32-bytes-x")
	tok, err := EncodeVERP(secret, verpTestTenant, verpTestCampaign, verpTestSubscriber)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	raw, err := verpEnc.DecodeString(strings.ToUpper(tok))
	if err != nil {
		t.Fatalf("decode own token: %v", err)
	}
	fields := raw[VERPMACBytes+1:]
	campaign := append([]byte(nil), fields[verpUUIDBytes:2*verpUUIDBytes]...)
	subscriber := append([]byte(nil), fields[2*verpUUIDBytes:3*verpUUIDBytes]...)
	copy(fields[verpUUIDBytes:2*verpUUIDBytes], subscriber)
	copy(fields[2*verpUUIDBytes:3*verpUUIDBytes], campaign)
	transposed := strings.ToLower(verpEnc.EncodeToString(raw))
	if tid, cid, sid, ok := DecodeVERP(secret, transposed); ok {
		t.Fatalf("transposed fields decoded to %q/%q/%q instead of being rejected", tid, cid, sid)
	}
}

// TestFormatVERPRecipient builds the full reply+<token>@domain string
// and verifies it round-trips through Matcher.matchByVERP.
func TestFormatVERPRecipient(t *testing.T) {
	secret := []byte("verp-secret-blah-blah-blah-blah!!")
	addr, err := FormatVERPRecipient(secret, verpTestTenant, verpTestCampaign, verpTestSubscriber, "reply.example.com")
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	if !strings.HasPrefix(addr, VERPTokenPrefix) {
		t.Errorf("address missing VERP prefix: %q", addr)
	}
	if !strings.HasSuffix(addr, "@reply.example.com") {
		t.Errorf("address missing domain: %q", addr)
	}
	m := &Matcher{VERPSecret: secret}
	cid, sid, ok := m.matchByVERP(verpTestTenant, addr)
	if !ok {
		t.Fatalf("matchByVERP failed on freshly-built address %q", addr)
	}
	if cid != verpTestCampaign || sid != verpTestSubscriber {
		t.Errorf("matchByVERP mismatch: cid=%q sid=%q", cid, sid)
	}
}

// TestFormatVERPRecipientRefusesUnconfigured is proof (c) at the codec layer:
// a missing secret or domain yields NO address and an error, never an
// unsigned, bare, or half-formed one. An address that merely looks like VERP
// is the failure mode this mechanism exists to avoid.
func TestFormatVERPRecipientRefusesUnconfigured(t *testing.T) {
	cases := []struct {
		name   string
		secret []byte
		domain string
	}{
		{"no secret", nil, "reply.example.com"},
		{"empty secret", []byte{}, "reply.example.com"},
		{"no domain", []byte("verp-secret-blah-blah-blah-blah!!"), ""},
		{"blank domain", []byte("verp-secret-blah-blah-blah-blah!!"), "   "},
		{"domain with at sign", []byte("verp-secret-blah-blah-blah-blah!!"), "x@y.com"},
		{"domain with space", []byte("verp-secret-blah-blah-blah-blah!!"), "reply example.com"},
		{"neither", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			addr, err := FormatVERPRecipient(tc.secret, verpTestTenant, verpTestCampaign, verpTestSubscriber, tc.domain)
			if err == nil {
				t.Fatalf("unconfigured VERP produced an address: %q", addr)
			}
			if addr != "" {
				t.Fatalf("unconfigured VERP returned %q alongside an error", addr)
			}
		})
	}
}

// TestVERPLocalPartStaysWithinBudget holds the documented length claim
// honest. The previous layout's comment asserted the token "stays under
// typical SMTP local-part limits" while encoding two 36-character textual
// UUIDs — 144 base32 characters — and nothing tested it.
func TestVERPLocalPartStaysWithinBudget(t *testing.T) {
	secret := []byte("budget-secret-pk-zoom-32-bytes-x")
	addr, err := FormatVERPRecipient(secret, verpTestTenant, verpTestCampaign, verpTestSubscriber, "reply.example.com")
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	local, domain := splitLocalDomain(addr)
	if domain != "reply.example.com" {
		t.Fatalf("domain = %q", domain)
	}
	if len(local) != VERPMaxLocalPartBytes {
		t.Fatalf("local part is %d bytes, but VERPMaxLocalPartBytes claims %d; "+
			"the layout changed without the documented budget changing with it",
			len(local), VERPMaxLocalPartBytes)
	}
}

// TestMatchByVERPRefusesCrossTenantToken: a token minted for one tenant must
// never attribute a reply resolved under another. Before the tenant became
// part of the signed payload this branch returned the token's campaign id
// regardless of the resolving tenant and labelled it MatchVERP — the label
// that marks correlation strong enough to emit a canonical replied event.
func TestMatchByVERPRefusesCrossTenantToken(t *testing.T) {
	secret := []byte("cross-tenant-secret-32-bytes-xx!")
	addr, err := FormatVERPRecipient(secret, verpTestTenant, verpTestCampaign, verpTestSubscriber, "reply.example.test")
	if err != nil {
		t.Fatal(err)
	}
	m := &Matcher{VERPSecret: secret}
	if cid, sid, ok := m.matchByVERP(verpTestOtherID, addr); ok {
		t.Fatalf("cross-tenant VERP matched: cid=%q sid=%q", cid, sid)
	}
	// Same address, correct tenant, still matches — proving the refusal above
	// is the tenant check and not a broken fixture.
	if _, _, ok := m.matchByVERP(verpTestTenant, addr); !ok {
		t.Fatal("same-tenant VERP failed to match; the negative case proves nothing")
	}
	// And through the full Resolve path, where the tenant arrives as an argument.
	result, err := m.Resolve(context.Background(), verpTestOtherID, Reply{EnvelopeRecipient: addr})
	if err != nil {
		t.Fatal(err)
	}
	if result.Method != MatchNone || result.CampaignID != "" || result.SubscriberID != "" {
		t.Fatalf("Resolve under a foreign tenant = %+v, want no match", result)
	}
}

// TestMatcherResolveAttributesReplyWithNoThreadHeaders is proof (d). The reply
// carries no In-Reply-To and no References (the ingest path folds References
// into InReplyTo, so an empty InReplyTo is both), and its sender is not a
// known subscriber — every branch except VERP is dark. This is the AI-mediated
// case: the headers matching normally depends on are the ones intermediaries
// rewrite, and the signed envelope is what survives.
func TestMatcherResolveAttributesReplyWithNoThreadHeaders(t *testing.T) {
	secret := []byte("verp-envelope-secret-32-bytes-long")
	address, err := FormatVERPRecipient(secret, verpTestTenant, verpTestCampaign, verpTestSubscriber, "reply.example.test")
	if err != nil {
		t.Fatal(err)
	}
	// Store is nil: the In-Reply-To probe and the from-address fallback both
	// short-circuit, so a pass here cannot come from either of them.
	m := &Matcher{VERPSecret: secret}
	result, err := m.Resolve(context.Background(), verpTestTenant, Reply{
		InReplyTo: "",
		Subject:   "Re: [via assistant] something entirely rewritten",
		// The sender is the human who replied. It must never be decoded as the
		// route address carrying the VERP token.
		RecipientEmail:    "human@example.test",
		EnvelopeRecipient: address,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Method != MatchVERP {
		t.Fatalf("Resolve method = %q, want %q", result.Method, MatchVERP)
	}
	if result.CampaignID != verpTestCampaign || result.SubscriberID != verpTestSubscriber {
		t.Fatalf("Resolve = %+v, want campaign %q subscriber %q",
			result, verpTestCampaign, verpTestSubscriber)
	}
	if !result.Method.Strong() {
		t.Fatal("VERP correlation must be strong enough to emit a canonical replied event")
	}
}

// TestTenantFromVERPRecipient covers the branch inbound tenant resolution
// depends on. Without it a VERP-addressed reply carries no `replies-<slug>`
// tag, so it falls to a global subscriber-email guess or is dropped as
// unmapped while holding fully signed attribution.
func TestTenantFromVERPRecipient(t *testing.T) {
	secret := []byte("tenant-resolve-secret-32-bytes-x")
	addr, err := FormatVERPRecipient(secret, verpTestTenant, verpTestCampaign, "", "reply.example.test")
	if err != nil {
		t.Fatal(err)
	}
	m := &Matcher{VERPSecret: secret}
	got, ok := m.TenantFromVERPRecipient(addr)
	if !ok || got != verpTestTenant {
		t.Fatalf("TenantFromVERPRecipient = (%q,%v), want (%q,true)", got, ok, verpTestTenant)
	}
	// Unsigned lookalike, foreign secret, plain address, and an unconfigured
	// matcher must all decline rather than guess.
	if got, ok := m.TenantFromVERPRecipient("reply+notarealtoken@reply.example.test"); ok {
		t.Fatalf("unsigned lookalike resolved to %q", got)
	}
	other := &Matcher{VERPSecret: []byte("a-different-deployment-secret-32")}
	if got, ok := other.TenantFromVERPRecipient(addr); ok {
		t.Fatalf("foreign secret resolved to %q", got)
	}
	if got, ok := m.TenantFromVERPRecipient("replies-acme@reply.example.test"); ok {
		t.Fatalf("slug-tagged address resolved through VERP to %q", got)
	}
	unconfigured := &Matcher{}
	if got, ok := unconfigured.TenantFromVERPRecipient(addr); ok {
		t.Fatalf("matcher with no secret resolved to %q", got)
	}
	var nilMatcher *Matcher
	if got, ok := nilMatcher.TenantFromVERPRecipient(addr); ok {
		t.Fatalf("nil matcher resolved to %q", got)
	}
}

// TestMatcherResolveNoneFallback exercises the "all branches miss"
// path. With an empty Store + no VERP secret + empty addresses, every
// branch should return ok=false and the result Method should be
// "none".
func TestMatcherResolveNoneFallback(t *testing.T) {
	m := &Matcher{
		// Store left nil — every database-touching branch must short-
		// circuit cleanly without panicking.
		VERPSecret: nil,
	}
	res, err := m.Resolve(context.Background(), "tenant-1", Reply{
		RecipientEmail: "alice@example.com",
		InReplyTo:      "<some-id@somewhere>",
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if res.Method != "none" {
		t.Errorf("expected method=none, got %q", res.Method)
	}
	if res.CampaignID != "" || res.SubscriberID != "" {
		t.Errorf("expected empty ids, got cid=%q sid=%q", res.CampaignID, res.SubscriberID)
	}
}

// TestMatcherResolveErrorsOnEmptyTenant guards the early-return for an
// empty tenant id.
func TestMatcherResolveErrorsOnEmptyTenant(t *testing.T) {
	m := &Matcher{}
	if _, err := m.Resolve(context.Background(), "", Reply{}); err == nil {
		t.Errorf("expected error on empty tenant id, got nil")
	}
}

// TestStripAngleBrackets sanity-checks the In-Reply-To normaliser.
func TestStripAngleBrackets(t *testing.T) {
	cases := []struct{ in, want string }{
		{"<abc@host>", "abc@host"},
		{"abc@host", "abc@host"},
		{"  <abc@host>  ", "abc@host"},
		{"", ""},
		{"<>", ""},
	}
	for _, tc := range cases {
		if got := stripAngleBrackets(tc.in); got != tc.want {
			t.Errorf("stripAngleBrackets(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestSplitLocalDomain probes the email parser used by the VERP
// matcher.
func TestSplitLocalDomain(t *testing.T) {
	cases := []struct {
		in            string
		local, domain string
	}{
		{"alice@example.com", "alice", "example.com"},
		{"reply+abc@x.io", "reply+abc", "x.io"},
		{"  bob@host  ", "bob", "host"},
		{"no-at-sign", "", ""},
		{"@no-local", "", ""},
		{"trailing@", "", ""},
	}
	for _, tc := range cases {
		l, d := splitLocalDomain(tc.in)
		if l != tc.local || d != tc.domain {
			t.Errorf("splitLocalDomain(%q) = (%q,%q), want (%q,%q)",
				tc.in, l, d, tc.local, tc.domain)
		}
	}
}

// TestExtractTenantSlug exercises the inbound envelope tag parser.
func TestExtractTenantSlug(t *testing.T) {
	cases := []struct {
		in, suffix, want string
	}{
		{"replies-acme@reply.moosewave.com", "reply.moosewave.com", "acme"},
		{"REPLIES-Acme@reply.moosewave.com", "reply.moosewave.com", "acme"},
		// Wrong domain → no match.
		{"replies-acme@otherdomain.com", "reply.moosewave.com", ""},
		// Wrong prefix.
		{"foo-acme@reply.moosewave.com", "reply.moosewave.com", ""},
		// Empty suffix disables.
		{"replies-acme@reply.moosewave.com", "", ""},
	}
	for _, tc := range cases {
		if got := extractTenantSlug(tc.in, tc.suffix); got != tc.want {
			t.Errorf("extractTenantSlug(%q,%q) = %q, want %q",
				tc.in, tc.suffix, got, tc.want)
		}
	}
}
