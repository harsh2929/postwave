package replies

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeResolver is a TenantResolver stub for handler tests.
type fakeResolver struct {
	bySlug     map[string]string
	byEmail    map[string]string
	slugErr    error
	emailErr   error
	slugCalls  int
	emailCalls int
}

func (f *fakeResolver) LookupTenantBySlug(_ context.Context, slug string) (string, error) {
	f.slugCalls++
	if f.slugErr != nil {
		return "", f.slugErr
	}
	return f.bySlug[slug], nil
}

func (f *fakeResolver) LookupTenantBySubscriberEmail(_ context.Context, email string) (string, error) {
	f.emailCalls++
	if f.emailErr != nil {
		return "", f.emailErr
	}
	return f.byEmail[email], nil
}

// TestHandlePostmarkUnmappedDrops verifies that an inbound reply with
// no resolvable tenant (no envelope tag, no subscriber match) is
// dropped with the unmapped counter incremented and a 200 OK.
func TestHandlePostmarkUnmappedDrops(t *testing.T) {
	counter := &atomic.Int64{}
	res := &fakeResolver{
		bySlug:  map[string]string{}, // no slugs known
		byEmail: map[string]string{}, // no emails known
	}
	deps := &Deps{
		AllowUnsignedDevBypass: true,
		EnvelopeDomainSuffix:   "reply.moosewave.com",
		TenantResolver:         res,
		UnmappedCounter:        counter,
		// Store is nil — we never reach Persist on the dropped path.
	}
	body, _ := json.Marshal(map[string]any{
		"MessageID": "pm-msg-1",
		"From":      "stranger@nowhere.test",
		"To":        "noreply@nowhere.test",
		"Subject":   "Re: hello",
		"TextBody":  "thanks!",
	})
	req := httptest.NewRequest(http.MethodPost,
		"/api/internal/webhooks/inbound/postmark", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	deps.HandlePostmark(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (dropped is OK), got %d body=%s", w.Code, w.Body.String())
	}
	if counter.Load() != 1 {
		t.Errorf("expected unmapped counter == 1, got %d", counter.Load())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resp: %v", err)
	}
	if resp["dropped"] != "tenant_unmapped" {
		t.Errorf("expected dropped=tenant_unmapped, got %v", resp["dropped"])
	}
}

// TestHandlePostmarkSignatureRequired ensures that production-mode
// (no dev bypass + no secret configured) refuses the request.
func TestHandlePostmarkSignatureRequired(t *testing.T) {
	deps := &Deps{
		// AllowUnsignedDevBypass: false (default), PostmarkSecret: ""
		// → the verifier must refuse.
		TenantResolver: &fakeResolver{},
	}
	body := []byte(`{}`)
	req := httptest.NewRequest(http.MethodPost,
		"/api/internal/webhooks/inbound/postmark", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	deps.HandlePostmark(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with no secret + no bypass, got %d", w.Code)
	}
}

func TestHandleMailgunFormRejectsOversizedBody(t *testing.T) {
	deps := &Deps{AllowUnsignedDevBypass: true}
	body := "sender=a@example.com&recipient=b@example.com&body-plain=" + strings.Repeat("x", MaxBodyBytes)
	req := httptest.NewRequest(http.MethodPost, "/api/internal/webhooks/inbound/mailgun", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()

	deps.handleMailgunForm(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestReadBodyRejectsOversizedPayload(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/internal/webhooks/inbound/postmark",
		strings.NewReader(strings.Repeat("x", MaxBodyBytes+1)))

	body, err := readBody(req, MaxBodyBytes)

	if err == nil || !errors.Is(err, errReplyBodyTooLarge) {
		t.Fatalf("err = %v, want errReplyBodyTooLarge", err)
	}
	if body != nil {
		t.Fatalf("body = %d bytes, want nil", len(body))
	}
}

// TestVERPTenantResolutionWins proves the signed envelope outranks both
// weaker branches. It is not a preference: a `reply+<token>@domain` address
// carries no `replies-<slug>` tag, so without this branch every reply to a
// VERP address falls to the global subscriber-email guess (ambiguous whenever
// an address subscribes under two tenants) or is dropped as unmapped while
// holding fully signed attribution.
func TestVERPTenantResolutionWins(t *testing.T) {
	secret := []byte("handler-verp-secret-32-bytes-xx!")
	addr, err := FormatVERPRecipient(secret, verpTestTenant, verpTestCampaign, verpTestSubscriber, "reply.moosewave.com")
	if err != nil {
		t.Fatal(err)
	}
	res := &fakeResolver{
		bySlug:  map[string]string{"acme": "tenant-acme"},
		byEmail: map[string]string{"alice@example.com": "tenant-from-email"},
	}
	deps := &Deps{
		AllowUnsignedDevBypass: true,
		EnvelopeDomainSuffix:   "reply.moosewave.com",
		TenantResolver:         res,
		Matcher:                &Matcher{VERPSecret: secret},
	}
	got := deps.resolveTenant(context.Background(), addr, "alice@example.com")
	if got != verpTestTenant {
		t.Fatalf("resolveTenant = %q, want the signed tenant %q", got, verpTestTenant)
	}
	if res.slugCalls != 0 || res.emailCalls != 0 {
		t.Fatalf("weaker branches ran: slug=%d email=%d", res.slugCalls, res.emailCalls)
	}
}

// TestVERPTenantResolutionDoesNotSwallowWeakerBranches guards the guard: the
// VERP branch must decline cleanly rather than short-circuit resolution when
// the address is not a valid signed token, when the secret is unset, and when
// no matcher is wired at all.
func TestVERPTenantResolutionDoesNotSwallowWeakerBranches(t *testing.T) {
	secret := []byte("handler-verp-secret-32-bytes-xx!")
	signedElsewhere, err := FormatVERPRecipient(
		[]byte("a-completely-different-secret-32"),
		verpTestTenant, verpTestCampaign, "", "reply.moosewave.com")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		matcher *Matcher
		to      string
	}{
		{"no matcher", nil, "replies-acme@reply.moosewave.com"},
		{"matcher without secret", &Matcher{}, "replies-acme@reply.moosewave.com"},
		{"non-VERP address", &Matcher{VERPSecret: secret}, "replies-acme@reply.moosewave.com"},
		{"unsigned lookalike", &Matcher{VERPSecret: secret}, "reply+totally-made-up@reply.moosewave.com"},
		{"token signed by another deployment", &Matcher{VERPSecret: secret}, signedElsewhere},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := &fakeResolver{bySlug: map[string]string{"acme": "tenant-acme"}}
			deps := &Deps{
				EnvelopeDomainSuffix: "reply.moosewave.com",
				TenantResolver:       res,
				Matcher:              tc.matcher,
			}
			got := deps.resolveTenant(context.Background(), tc.to, "")
			if tc.to == "replies-acme@reply.moosewave.com" {
				if got != "tenant-acme" {
					t.Fatalf("resolveTenant = %q, want the slug branch to still run", got)
				}
				return
			}
			// A lookalike or foreign-signed VERP address must resolve to
			// nothing, never to a tenant guessed from a weaker signal.
			if got != "" {
				t.Fatalf("resolveTenant = %q, want no tenant", got)
			}
		})
	}
}

// TestSlugBasedTenantResolutionWins verifies that the envelope tag
// branch resolves before the subscriber-email fallback.
func TestSlugBasedTenantResolutionWins(t *testing.T) {
	res := &fakeResolver{
		bySlug:  map[string]string{"acme": "tenant-acme"},
		byEmail: map[string]string{"alice@example.com": "tenant-other"},
	}
	deps := &Deps{
		AllowUnsignedDevBypass: true,
		EnvelopeDomainSuffix:   "reply.moosewave.com",
		TenantResolver:         res,
		// No store — we'll only test the resolveTenant path through
		// the public seam.
	}
	got := deps.resolveTenant(context.Background(),
		"replies-acme@reply.moosewave.com", "alice@example.com")
	if got != "tenant-acme" {
		t.Errorf("expected slug branch to win, got %q (slug calls=%d email calls=%d)",
			got, res.slugCalls, res.emailCalls)
	}
	if res.emailCalls != 0 {
		t.Errorf("expected 0 email lookups, got %d", res.emailCalls)
	}
}

// TestEmailBasedTenantResolutionFallback verifies that when the slug
// branch misses, the subscriber-email branch is consulted.
func TestEmailBasedTenantResolutionFallback(t *testing.T) {
	res := &fakeResolver{
		bySlug:  map[string]string{}, // no slugs known
		byEmail: map[string]string{"alice@example.com": "tenant-from-email"},
	}
	deps := &Deps{
		AllowUnsignedDevBypass: true,
		EnvelopeDomainSuffix:   "reply.moosewave.com",
		TenantResolver:         res,
	}
	got := deps.resolveTenant(context.Background(),
		"unknown-tag@reply.moosewave.com", "alice@example.com")
	if got != "tenant-from-email" {
		t.Errorf("expected email fallback to win, got %q", got)
	}
}

// TestSnippetTruncation guards the snippet helper used by all three
// provider parsers.
func TestSnippetTruncation(t *testing.T) {
	long := make([]byte, BodySnippetMaxLen+200)
	for i := range long {
		long[i] = 'x'
	}
	got := snippet(string(long))
	if len(got) != BodySnippetMaxLen {
		t.Errorf("expected %d, got %d", BodySnippetMaxLen, len(got))
	}
	if got := snippet("  trim me  "); got != "trim me" {
		t.Errorf("expected trimmed, got %q", got)
	}
}

func TestProviderReceiptTimestampParsers(t *testing.T) {
	want := time.Date(2026, 8, 13, 10, 20, 30, 0, time.UTC)
	if got := parseMailDate("Thu, 13 Aug 2026 15:50:30 +0530"); !got.Equal(want) {
		t.Fatalf("mail Date = %v, want %v", got, want)
	}
	if got := parseUnixTimestamp(strconv.FormatInt(want.Unix(), 10)); !got.Equal(want) {
		t.Fatalf("signed unix = %v, want %v", got, want)
	}
	if got := parseRFC3339Timestamp("2026-08-13T10:20:30Z"); !got.Equal(want) {
		t.Fatalf("SNS timestamp = %v, want %v", got, want)
	}
	for name, got := range map[string]time.Time{
		"bad mail date": parseMailDate("not-a-date"),
		"bad unix":      parseUnixTimestamp("nope"),
		"bad RFC3339":   parseRFC3339Timestamp("yesterday"),
	} {
		if !got.IsZero() {
			t.Errorf("%s = %v, want zero fallback", name, got)
		}
	}
}

func TestProviderAdaptersKeepOnlyReplyClassificationHeaders(t *testing.T) {
	headers := postmarkClassificationHeaders([]postmarkHeader{
		{Name: "Auto-Submitted", Value: "auto-replied"},
		{Name: "From", Value: "private@example.test"},
		{Name: "Return-Path", Value: "<>"},
	})
	if headers.Get("Auto-Submitted") != "auto-replied" || headers.Get("Return-Path") != "<>" {
		t.Fatalf("classification headers = %#v", headers)
	}
	if headers.Get("From") != "" {
		t.Fatalf("PII-bearing From header survived allow-list: %#v", headers)
	}
}
