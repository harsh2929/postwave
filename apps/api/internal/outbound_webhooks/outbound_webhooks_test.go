// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestSignBody_VerifyRoundTrip(t *testing.T) {
	secret := "owhsec_test_secret"
	body := []byte(`{"event":{"type":"campaign.sent"}}`)
	now := time.Unix(1700000000, 0).UTC()
	header := SignBody(secret, now, body)
	if !strings.HasPrefix(header, "t=1700000000,v1=") {
		t.Fatalf("unexpected header shape: %s", header)
	}
	if err := VerifySignature(header, body, secret, now, time.Minute); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestVerifySignature_RejectsTamper(t *testing.T) {
	secret := "owhsec_test"
	body := []byte(`{"event":"hello"}`)
	now := time.Unix(1700000000, 0).UTC()
	header := SignBody(secret, now, body)

	// Body tampered.
	if err := VerifySignature(header, []byte(`{"event":"goodbye"}`), secret, now, time.Minute); err == nil {
		t.Fatal("tampered body accepted")
	}
	// Wrong secret.
	if err := VerifySignature(header, body, "wrong", now, time.Minute); err == nil {
		t.Fatal("wrong secret accepted")
	}
}

func TestVerifySignature_RespectsTolerance(t *testing.T) {
	secret := "owhsec_test"
	body := []byte(`x`)
	signedAt := time.Unix(1700000000, 0).UTC()
	header := SignBody(secret, signedAt, body)
	verifyAt := signedAt.Add(2 * time.Minute)
	if err := VerifySignature(header, body, secret, verifyAt, time.Minute); err == nil {
		t.Fatal("stale timestamp accepted")
	}
	if err := VerifySignature(header, body, secret, verifyAt, 10*time.Minute); err != nil {
		t.Fatalf("within-tolerance rejected: %v", err)
	}
}

func TestValidateURL(t *testing.T) {
	cases := []struct {
		raw          string
		requireHTTPS bool
		want         bool
	}{
		{"https://example.com/hook", true, true},
		{"HTTPS://EXAMPLE.COM/hook", true, true},
		{"http://example.com/hook", true, false},
		{"http://example.com/hook", false, true},
		{"ftp://example.com/hook", false, false},
		{"https://user:pass@example.com/hook", true, false},
		{"https://localhost/hook", true, false},
		{"https://127.0.0.1/hook", true, false},
		{"https://10.0.0.1/hook", true, false},
		{"https://[::1]/hook", true, false},
		{"https://[64:ff9b::7f00:1]/hook", true, false}, // NAT64-wrapped 127.0.0.1
		{"https://[64:ff9b::a00:1]/hook", true, false},  // NAT64-wrapped 10.0.0.1
		{"https://[2002:a00:1::1]/hook", true, false},   // 6to4-wrapped 10.0.0.1
		{"https://[3fff::1]/hook", true, false},         // documentation, not globally reachable
		{"https://[5f00::1]/hook", true, false},         // segment-routing SID space
		{"https://[fec0::1]/hook", true, false},         // deprecated site-local
		{"https://[fe80::1%25eth0]/hook", true, false},
		{"https://[::1%25lo0]/hook", true, false},
		{"https://example.com/…?…", true, false},
		{"https://example.com/%E2%80%A6", true, false},
		{"https://example.com/hook#not-sent", true, false},
		{"https://localhost/hook", false, true},
		{"", false, false},
		{"not a url", false, false},
		{"https://", false, false},
		{"https://" + strings.Repeat("a", 4096), false, false},
	}
	for _, tc := range cases {
		err := validateURL(tc.raw, tc.requireHTTPS)
		got := err == nil
		if got != tc.want {
			t.Errorf("validateURL(%q, requireHTTPS=%v) = %v, want %v",
				tc.raw, tc.requireHTTPS, got, tc.want)
		}
	}
}

func TestValidateURLClassifiesDisplayOnlyDestination(t *testing.T) {
	err := ValidateURL("https://receiver.example.test/…?…", true)
	if !errors.Is(err, ErrRedactedDestination) || !errors.Is(err, ErrInvalidURL) {
		t.Fatalf("redacted destination error = %v", err)
	}
}

type staticIPResolver struct {
	addrs []net.IPAddr
	err   error
}

func (r staticIPResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return r.addrs, r.err
}

func TestSecureDialContextRejectsPrivateResolvedAddresses(t *testing.T) {
	dial := secureDialContext(staticIPResolver{addrs: []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}})
	_, err := dial(context.Background(), "tcp", "example.com:443")
	if err == nil {
		t.Fatal("private resolved address accepted")
	}
	if !strings.Contains(err.Error(), "private or reserved") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSecureDialContextRejectsDNSRebindingAtDialTime(t *testing.T) {
	// Configuration-time validation intentionally does not pin a DNS answer.
	// A fresh private answer at dial time must still be rejected.
	if err := ValidateURL("https://rebind.example/webhook", true); err != nil {
		t.Fatalf("public hostname shape rejected before dial: %v", err)
	}
	dial := secureDialContext(staticIPResolver{addrs: []net.IPAddr{{IP: net.ParseIP("169.254.169.254")}}})
	if _, err := dial(context.Background(), "tcp", "rebind.example:443"); err == nil {
		t.Fatal("DNS-rebound metadata address accepted")
	}
}

func TestSecureDialContextRejectsReservedIPv6AnswersAtDialTime(t *testing.T) {
	for _, rawIP := range []string{"3fff::1", "5f00::1", "fec0::1"} {
		rawIP := rawIP
		t.Run(rawIP, func(t *testing.T) {
			dial := secureDialContext(staticIPResolver{addrs: []net.IPAddr{{
				IP: net.ParseIP(rawIP),
			}}})
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			_, err := dial(ctx, "tcp", "reserved-v6.example:443")
			if err == nil || !strings.Contains(err.Error(), "private or reserved") {
				t.Fatalf("reserved IPv6 answer %s was not rejected by policy: %v", rawIP, err)
			}
		})
	}
}

func TestSecureDialContextRejectsScopedResolvedAddresses(t *testing.T) {
	dial := secureDialContext(staticIPResolver{addrs: []net.IPAddr{{
		IP:   net.ParseIP("fe80::1"),
		Zone: "en0",
	}}})
	if _, err := dial(context.Background(), "tcp", "scoped.example:443"); err == nil {
		t.Fatal("scoped link-local destination accepted")
	} else if !strings.Contains(err.Error(), "scoped address") {
		t.Fatalf("unexpected error: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestSecureHTTPClientNeverForwardsCredentialBearingRedirect(t *testing.T) {
	var calls int
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if calls > 1 {
			if got := req.Header.Get("X-API-Key"); got != "" {
				t.Fatalf("custom credential was forwarded to redirected origin: %q", got)
			}
			t.Fatal("redirect target was contacted")
		}
		return &http.Response{
			StatusCode: http.StatusFound,
			Header:     http.Header{"Location": []string{"https://attacker.example/collect"}},
			Body:       io.NopCloser(strings.NewReader("redirect")),
			Request:    req,
		}, nil
	})
	client := NewSecureHTTPClient(transport)
	req, err := http.NewRequest(http.MethodPost, "https://hooks.example/start", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-API-Key", "receiver-secret")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("redirect response: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusFound)
	}
	if calls != 1 {
		t.Fatalf("round trips = %d, want 1", calls)
	}
}

func TestSecureTransportDisablesAmbientProxy(t *testing.T) {
	if proxy := NewSecureTransport().Proxy; proxy != nil {
		t.Fatal("secure transport must not consult an ambient proxy")
	}
}

func TestPermanentFailureStatus(t *testing.T) {
	for _, status := range []int{
		http.StatusMultipleChoices,
		http.StatusFound,
		http.StatusPermanentRedirect,
		http.StatusBadRequest,
		http.StatusUnauthorized,
	} {
		if !permanentFailureStatus(status) {
			t.Errorf("status %d should be permanent", status)
		}
	}
	for _, status := range []int{
		0,
		http.StatusOK,
		http.StatusTooManyRequests,
		http.StatusInternalServerError,
	} {
		if permanentFailureStatus(status) {
			t.Errorf("status %d should be retryable/non-failure", status)
		}
	}
}

func TestValidateEvents(t *testing.T) {
	out, err := validateEvents([]string{"campaign.sent", "campaign.sent", "subscriber.added"})
	if err != nil {
		t.Fatalf("validateEvents: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("expected dedup, got %v", out)
	}

	if _, err := validateEvents([]string{}); err == nil {
		t.Fatal("empty events accepted")
	}
	if _, err := validateEvents([]string{"made.up.event"}); err == nil {
		t.Fatal("unknown event accepted")
	}
}

func TestBackoffSchedule_LengthMatchesMaxAttempts(t *testing.T) {
	// MaxAttempts is the number of total attempts (initial + retries).
	// BackoffSchedule has one entry per *retry*, so we expect
	// len(schedule) == MaxAttempts (the schedule is consulted with
	// 0-based index = nextAttempt - 1).
	if len(BackoffSchedule) != MaxAttempts {
		t.Errorf("expected len(BackoffSchedule)=%d to equal MaxAttempts=%d",
			len(BackoffSchedule), MaxAttempts)
	}
}

func TestNewSecret_FormatStable(t *testing.T) {
	s, err := newSecret()
	if err != nil {
		t.Fatalf("newSecret: %v", err)
	}
	if !strings.HasPrefix(s, "owhsec_") {
		t.Errorf("expected owhsec_ prefix, got %q", s)
	}
	if len(s) < 60 {
		t.Errorf("secret too short: %q", s)
	}
}

func TestIsAllowedEvent(t *testing.T) {
	for _, e := range AllowedEvents {
		if !IsAllowedEvent(e) {
			t.Errorf("AllowedEvents[%q] not recognised", e)
		}
	}
	if IsAllowedEvent("not.an.event") {
		t.Error("unknown event accepted")
	}
	for _, phantom := range []string{
		"list.subscriber.removed",
		"list.subscriber.unsubscribed",
		"referral.payout.pending",
		"referral.milestone.unlocked",
		// Opens/clicks are raw engagement observations until the classifier
		// labels them human, machine, or unknown. Exposing these topics here
		// would let a provider callback bypass that authority.
		"email.opened",
		"email.clicked",
	} {
		if IsAllowedEvent(phantom) {
			t.Errorf("producerless event %q is still exposed", phantom)
		}
	}
}

func TestNormalizeDescription(t *testing.T) {
	t.Parallel()
	got, err := normalizeDescription("  Customer lifecycle receiver  ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "Customer lifecycle receiver" {
		t.Fatalf("normalized description = %q", got)
	}
	if _, err := normalizeDescription(strings.Repeat("x", maxWebhookDescriptionRunes+1)); !errors.Is(err, ErrInvalidDescription) {
		t.Fatalf("oversized description error = %v, want ErrInvalidDescription", err)
	}
	if _, err := normalizeDescription(string([]byte{0xff})); !errors.Is(err, ErrInvalidDescription) {
		t.Fatalf("invalid UTF-8 description error = %v, want ErrInvalidDescription", err)
	}
}

func TestCreateRejectsMalformedListScopeBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()
	store := &Store{}
	if _, err := store.Create(
		context.Background(),
		"00000000-0000-4000-8000-000000000001",
		"",
		CreateInput{
			URL:    "https://receiver.example.test/webhook",
			Events: []string{"campaign.sent"},
			ListID: "not-a-uuid",
		},
		true,
	); !errors.Is(err, ErrInvalidListID) {
		t.Fatalf("malformed list scope error = %v, want ErrInvalidListID", err)
	}
}

func TestTruncateSanitizesDatabaseUnsafeReceiverText(t *testing.T) {
	t.Parallel()

	got := truncate("ok\xff\x00done", 128)
	if !utf8.ValidString(got) {
		t.Fatalf("truncate returned malformed UTF-8: %q", got)
	}
	if strings.ContainsRune(got, '\x00') {
		t.Fatalf("truncate retained a PostgreSQL-unsafe NUL: %q", got)
	}
	if got != "ok\uFFFDdone" {
		t.Fatalf("sanitized text = %q, want %q", got, "ok\uFFFDdone")
	}

	if got := truncate("ab😀cd", 4); got != "ab" {
		t.Fatalf("partial-rune truncation = %q, want %q", got, "ab")
	}
	if got := truncate("ab😀cd", 6); got != "ab😀" {
		t.Fatalf("whole-rune truncation = %q, want %q", got, "ab😀")
	}
}

func TestStrconvFormatI64_RoundTrip(t *testing.T) {
	cases := []int64{0, 1, -1, 1700000000, -1700000000, 9223372036854775807}
	for _, c := range cases {
		s := strconvFormatI64(c)
		got, err := strconvParseI64(s)
		if err != nil {
			t.Fatalf("parse %q: %v", s, err)
		}
		if got != c {
			t.Errorf("round-trip: got %d, want %d", got, c)
		}
	}
}
