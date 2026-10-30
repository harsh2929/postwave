// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// localWithMX builds a LocalVerifier whose DNS tier is replaced by a
// deterministic lookup function, so no test touches the network.
func localWithMX(withMX map[string]bool) *LocalVerifier {
	return &LocalVerifier{
		LookupMX: func(_ context.Context, domain string) (bool, string, error) {
			host, ok := withMX[domain]
			if !ok {
				return false, "", nil
			}
			if !host {
				return false, "", nil
			}
			return true, "mx." + domain, nil
		},
	}
}

func TestLocalVerifierNeverClaimsValid(t *testing.T) {
	// The whole justification for a paid tier: MX-level checks cannot
	// confirm a mailbox exists. The best honest verdict is "unknown".
	v := localWithMX(map[string]bool{"example.com": true})

	got, err := v.Verify(context.Background(), "someone@example.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status == StatusValid {
		t.Fatalf("local verifier claimed %q; it can never confirm a mailbox", StatusValid)
	}
	if got.Status != StatusUnknown {
		t.Fatalf("Status = %q, want %q", got.Status, StatusUnknown)
	}
	if got.SubStatus != SubStatusNoMailboxProbe {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusNoMailboxProbe)
	}
	if !got.MXFound {
		t.Fatal("MXFound = false, want true")
	}
	if got.Billable {
		t.Fatal("local verification must never be billable")
	}
}

func TestLocalVerifierRejectsSyntaxInvalidWithoutDNSLookup(t *testing.T) {
	called := false
	v := &LocalVerifier{
		LookupMX: func(context.Context, string) (bool, string, error) {
			called = true
			return true, "mx", nil
		},
	}

	got, err := v.Verify(context.Background(), "not-an-email")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusInvalid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusInvalid)
	}
	if got.SubStatus != SubStatusPossibleTypo && got.SubStatus != SubStatusMailboxNotFound {
		if got.SubStatus != SubStatusSyntaxInvalid {
			t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusSyntaxInvalid)
		}
	}
	if called {
		t.Fatal("DNS was queried for a syntactically invalid address")
	}
}

func TestLocalVerifierRejectsMalformedDotAtomWithoutDNSLookup(t *testing.T) {
	tests := []string{
		".leading@example.com",
		"trailing.@example.com",
		"consecutive..dots@example.com",
		"two@@example.com",
		`"quoted"@example.com`,
		"comment()@example.com",
		`back\slash@example.com`,
		"comma,name@example.com",
		"person@-leading-hyphen.example",
		"person@trailing-hyphen-.example",
	}

	for _, email := range tests {
		t.Run(email, func(t *testing.T) {
			called := false
			v := &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
				called = true
				return true, "mx.example.com", nil
			}}
			got, err := v.Verify(context.Background(), email)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if got.Status != StatusInvalid || got.SubStatus != SubStatusSyntaxInvalid {
				t.Fatalf("result = %+v, want syntax-invalid", got)
			}
			if called {
				t.Fatal("DNS was queried for a malformed address")
			}
		})
	}
}

func TestLocalVerifierRejectsRawEdgeControlsBeforeTrimming(t *testing.T) {
	t.Parallel()
	for _, control := range []string{
		"\x00", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u009f",
	} {
		called := false
		v := &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
			called = true
			return true, "mx.example.com", nil
		}}
		got, err := v.Verify(context.Background(), "person@example.com"+control)
		if err != nil {
			t.Fatalf("Verify(%q): %v", control, err)
		}
		if got.Status != StatusInvalid || got.SubStatus != SubStatusSyntaxInvalid {
			t.Errorf("control %q result = %+v, want syntax-invalid", control, got)
		}
		if called {
			t.Errorf("control %q reached DNS", control)
		}
	}
}

func TestLocalVerifierAcceptsDocumentedASCIIDotAtomCharacters(t *testing.T) {
	v := localWithMX(map[string]bool{"example.com": true})
	for _, email := range []string{
		"first.last@example.com",
		"o'hara+campaign@example.com",
		"customer/department=shipping@example.com",
		"tag_!#$%&'*+-/=?^`{|}~@example.com",
	} {
		got, err := v.Verify(context.Background(), email)
		if err != nil {
			t.Fatalf("Verify(%q): %v", email, err)
		}
		if got.Status != StatusUnknown || got.SubStatus != SubStatusNoMailboxProbe {
			t.Fatalf("Verify(%q) = %+v, want structurally valid local result", email, got)
		}
	}
}

func TestLocalVerifierClassifiesStaticDisposableAsAdvisory(t *testing.T) {
	lookups := 0
	v := &LocalVerifier{LookupMX: func(_ context.Context, domain string) (bool, string, error) {
		lookups++
		return true, "mx." + domain, nil
	}}

	got, err := v.Verify(context.Background(), "throwaway@mailinator.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusUnknown {
		t.Fatalf("Status = %q, want %q", got.Status, StatusUnknown)
	}
	if got.SubStatus != SubStatusDisposable {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusDisposable)
	}
	if !got.Disposable {
		t.Fatal("Disposable = false, want true")
	}
	if !got.MXFound || lookups != 1 {
		t.Fatalf("static corpus hit skipped MX: result=%+v lookups=%d", got, lookups)
	}
}

func TestLocalVerifierExplicitDisposableOverrideIsTerminal(t *testing.T) {
	lookups := 0
	v := &LocalVerifier{
		ExtraDisposable: map[string]struct{}{"tenant-blocked.example": {}},
		LookupMX: func(context.Context, string) (bool, string, error) {
			lookups++
			return true, "mx.tenant-blocked.example", nil
		},
	}

	got, err := v.Verify(context.Background(), "person@tenant-blocked.example")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusDoNotMail || got.SubStatus != SubStatusDisposable || !got.Disposable {
		t.Fatalf("explicit disposable result = %+v, want terminal do-not-mail", got)
	}
	if lookups != 0 {
		t.Fatalf("explicit terminal override performed %d MX lookups", lookups)
	}
}

func TestLocalVerifierLegitimateMailDomainsReachMXInsteadOfTerminalHeuristic(t *testing.T) {
	for _, domain := range []string{
		"duck.com", "nus.edu.sg", "qq.cn", "poczta.onet.pl", "safe-mail.net", "privatemail.com",
	} {
		t.Run(domain, func(t *testing.T) {
			lookups := 0
			v := &LocalVerifier{LookupMX: func(_ context.Context, gotDomain string) (bool, string, error) {
				lookups++
				if gotDomain != domain {
					t.Fatalf("MX domain=%q, want %q", gotDomain, domain)
				}
				return true, "mx." + domain, nil
			}}

			got, err := v.Verify(context.Background(), "person@"+domain)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if lookups != 1 {
				t.Fatalf("MX lookups=%d, want 1; a static heuristic short-circuited DNS", lookups)
			}
			if got.Status != StatusUnknown || got.SubStatus != SubStatusNoMailboxProbe || !got.MXFound {
				t.Fatalf("result=%+v, want advisory unknown after a usable MX route", got)
			}
			if got.Disposable || IsDisposableDomain(domain) {
				t.Fatalf("legitimate mail domain %q remains terminally disposable", domain)
			}
		})
	}
}

func TestLocalVerifierLegacyDisposableCorpusCannotTerminallyRejectMailProviders(t *testing.T) {
	for _, domain := range []string{"mail.by", "yeah.net", "hotpop.com", "neomailbox.com", "inbox.si"} {
		t.Run(domain, func(t *testing.T) {
			if !IsDisposableDomain(domain) {
				t.Fatalf("fixture %q no longer exercises the legacy corpus", domain)
			}
			lookups := 0
			v := &LocalVerifier{LookupMX: func(_ context.Context, gotDomain string) (bool, string, error) {
				lookups++
				return true, "mx." + gotDomain, nil
			}}
			got, err := v.Verify(context.Background(), "person@"+domain)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if got.Status != StatusUnknown || got.SubStatus != SubStatusDisposable ||
				!got.Disposable || !got.MXFound || lookups != 1 {
				t.Fatalf("legacy list hit became terminal: result=%+v lookups=%d", got, lookups)
			}
		})
	}
}

func TestLocalVerifierClassifiesRoleAccountAsCautionaryUnknown(t *testing.T) {
	v := localWithMX(map[string]bool{"example.com": true})

	got, err := v.Verify(context.Background(), "support@example.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusUnknown {
		t.Fatalf("Status = %q, want %q", got.Status, StatusUnknown)
	}
	if got.SubStatus != SubStatusRoleBased {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusRoleBased)
	}
	if !got.RoleAccount {
		t.Fatal("RoleAccount = false, want true")
	}
	if !got.MXFound {
		t.Fatal("role classification skipped the domain/MX check")
	}
}

func TestLocalVerifierClassifiesAbuseLocalPart(t *testing.T) {
	v := localWithMX(map[string]bool{"example.com": true})

	got, err := v.Verify(context.Background(), "abuse@example.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusAbuse {
		t.Fatalf("Status = %q, want %q", got.Status, StatusAbuse)
	}
}

func TestLocalVerifierBroadComplaintNamesRemainAdvisoryRoleAccounts(t *testing.T) {
	for _, local := range []string{"report", "complaints", "whitelist", "antispam", "anti-spam", "blacklist"} {
		t.Run(local, func(t *testing.T) {
			lookups := 0
			v := &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
				lookups++
				return true, "mx.example.com", nil
			}}
			got, err := v.Verify(context.Background(), local+"@example.com")
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if got.Status != StatusUnknown || got.SubStatus != SubStatusRoleBased ||
				!got.RoleAccount || !got.MXFound || lookups != 1 {
				t.Fatalf("broad shared name was terminal: result=%+v lookups=%d", got, lookups)
			}
		})
	}
}

func TestLocalVerifierReportsNoMXAsInvalid(t *testing.T) {
	v := localWithMX(map[string]bool{})

	got, err := v.Verify(context.Background(), "someone@no-such-domain.example")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusInvalid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusInvalid)
	}
	if got.SubStatus != SubStatusNoDNSEntries {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusNoDNSEntries)
	}
}

func TestLocalVerifierTreatsRFC7505NullMXAsAuthoritativeNoMail(t *testing.T) {
	resolver, queriedTypes := newNullMXTestResolver(t)
	v := &LocalVerifier{Resolver: resolver}

	got, err := v.Verify(context.Background(), "person@null-mx.example")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusInvalid || got.SubStatus != SubStatusNoDNSEntries {
		t.Fatalf("null-MX result = %+v, want authoritative no-mail invalid", got)
	}
	if got.MXFound || got.MXRecord != "" {
		t.Fatalf("null MX was exposed as a usable route: %+v", got)
	}
	for _, queryType := range queriedTypes() {
		if queryType == 1 || queryType == 28 {
			t.Fatalf("null MX incorrectly fell back to address lookup (DNS type %d)", queryType)
		}
	}
}

// newNullMXTestResolver serves a minimal, fully local DNS response containing
// MX 0 . and records every query type. The address lookups are observable so
// the test proves the null declaration never reaches implicit-A fallback.
func newNullMXTestResolver(t *testing.T) (*net.Resolver, func() []uint16) {
	t.Helper()
	server, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("start DNS test server: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })

	var (
		mu      sync.Mutex
		queries []uint16
	)
	go func() {
		buf := make([]byte, 2048)
		for {
			n, peer, readErr := server.ReadFrom(buf)
			if readErr != nil {
				return
			}
			query := append([]byte(nil), buf[:n]...)
			questionEnd, queryType, ok := dnsQuestion(query)
			if !ok {
				continue
			}
			mu.Lock()
			queries = append(queries, queryType)
			mu.Unlock()

			response := make([]byte, 12, 64)
			copy(response[:2], query[:2])
			binary.BigEndian.PutUint16(response[2:4], 0x8180) // response, recursion available, no error
			binary.BigEndian.PutUint16(response[4:6], 1)
			if queryType == 15 { // MX
				binary.BigEndian.PutUint16(response[6:8], 1)
			}
			response = append(response, query[12:questionEnd]...)
			if queryType == 15 {
				// Compressed owner name, MX, IN, TTL=60, RDLENGTH=3,
				// preference=0, root exchange (the RFC 7505 null MX).
				response = append(response,
					0xc0, 0x0c, 0x00, 0x0f, 0x00, 0x01,
					0x00, 0x00, 0x00, 0x3c, 0x00, 0x03,
					0x00, 0x00, 0x00,
				)
			}
			_, _ = server.WriteTo(response, peer)
		}
	}()

	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "udp", server.LocalAddr().String())
		},
	}
	return resolver, func() []uint16 {
		mu.Lock()
		defer mu.Unlock()
		return append([]uint16(nil), queries...)
	}
}

func dnsQuestion(message []byte) (end int, queryType uint16, ok bool) {
	if len(message) < 17 || binary.BigEndian.Uint16(message[4:6]) != 1 {
		return 0, 0, false
	}
	position := 12
	for {
		if position >= len(message) {
			return 0, 0, false
		}
		labelLength := int(message[position])
		position++
		if labelLength == 0 {
			break
		}
		if labelLength > 63 || position+labelLength > len(message) {
			return 0, 0, false
		}
		position += labelLength
	}
	if position+4 > len(message) {
		return 0, 0, false
	}
	return position + 4, binary.BigEndian.Uint16(message[position : position+2]), true
}

func TestLocalVerifierSuggestsCorrectionForMistypedDomain(t *testing.T) {
	v := localWithMX(map[string]bool{})

	got, err := v.Verify(context.Background(), "someone@gmial.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.DidYouMean != "someone@gmail.com" {
		t.Fatalf("DidYouMean = %q, want %q", got.DidYouMean, "someone@gmail.com")
	}
	if got.SubStatus != SubStatusPossibleTypo {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusPossibleTypo)
	}
}

func TestLocalVerifierDoesNotSuggestAmbiguousDomainCorrection(t *testing.T) {
	for range 100 {
		if suggestion, ok := suggestDomain("xmail.com"); ok || suggestion != "" {
			t.Fatalf("ambiguous suggestion = (%q, %v), want none", suggestion, ok)
		}
	}

	v := localWithMX(map[string]bool{})
	got, err := v.Verify(context.Background(), "someone@xmail.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.DidYouMean != "" || got.SubStatus != SubStatusNoDNSEntries {
		t.Fatalf("ambiguous typo was corrected: %+v", got)
	}
}

func TestLocalVerifierMarksFreeMailProviders(t *testing.T) {
	v := localWithMX(map[string]bool{"gmail.com": true})

	got, err := v.Verify(context.Background(), "someone@gmail.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !got.FreeEmail {
		t.Fatal("FreeEmail = false, want true for gmail.com")
	}
	if got.Disposable {
		t.Fatal("gmail.com must not be classified disposable")
	}
}

func TestLocalVerifierNormalizesAddressCasingAndSpace(t *testing.T) {
	v := localWithMX(map[string]bool{"example.com": true})

	got, err := v.Verify(context.Background(), "  Someone@Example.COM  ")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Email != "someone@example.com" {
		t.Fatalf("Email = %q, want normalized lowercase", got.Email)
	}
	if got.Domain != "example.com" {
		t.Fatalf("Domain = %q, want %q", got.Domain, "example.com")
	}
}

func TestLocalVerifierNameIsStable(t *testing.T) {
	v := &LocalVerifier{}
	if v.Name() != ProviderLocal {
		t.Fatalf("Name() = %q, want %q", v.Name(), ProviderLocal)
	}
}

func TestLocalVerifierCreditsAreUnmetered(t *testing.T) {
	v := &LocalVerifier{}
	got, err := v.Credits(context.Background())
	if err != nil {
		t.Fatalf("Credits: %v", err)
	}
	if got != CreditsUnmetered {
		t.Fatalf("Credits = %d, want CreditsUnmetered (%d)", got, CreditsUnmetered)
	}
}

func TestLocalMXCacheIsBoundedAndEvictsLeastRecentlyUsed(t *testing.T) {
	var mu sync.Mutex
	lookups := map[string]int{}
	v := &LocalVerifier{
		CacheMaxEntries: 2,
		LookupMX: func(_ context.Context, domain string) (bool, string, error) {
			mu.Lock()
			lookups[domain]++
			mu.Unlock()
			return true, "mx." + domain, nil
		},
	}
	lookup := func(domain string) {
		t.Helper()
		if _, _, err := v.lookup(context.Background(), domain); err != nil {
			t.Fatalf("lookup %s: %v", domain, err)
		}
	}

	lookup("a.example")
	lookup("b.example")
	lookup("a.example") // refresh A; B is now the least-recently used entry.
	lookup("c.example")

	v.mu.Lock()
	_, hasA := v.cache["a.example"]
	_, hasB := v.cache["b.example"]
	_, hasC := v.cache["c.example"]
	cacheSize := len(v.cache)
	v.mu.Unlock()
	if cacheSize != 2 || !hasA || hasB || !hasC {
		t.Fatalf("bounded cache state: size=%d a=%t b=%t c=%t", cacheSize, hasA, hasB, hasC)
	}

	lookup("b.example")
	mu.Lock()
	got := map[string]int{
		"a.example": lookups["a.example"],
		"b.example": lookups["b.example"],
		"c.example": lookups["c.example"],
	}
	mu.Unlock()
	if got["a.example"] != 1 || got["b.example"] != 2 || got["c.example"] != 1 {
		t.Fatalf("resolver calls after eviction = %v", got)
	}
}

func TestLocalMXLookupCoalescesConcurrentRequestsForOneDomain(t *testing.T) {
	const callers = 32
	start := make(chan struct{})
	providerStarted := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var countMu sync.Mutex
	providerCalls := 0
	v := &LocalVerifier{
		LookupMX: func(context.Context, string) (bool, string, error) {
			countMu.Lock()
			providerCalls++
			countMu.Unlock()
			once.Do(func() { close(providerStarted) })
			<-release
			return true, "mx.shared.example", nil
		},
	}

	errs := make([]error, callers)
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			found, host, err := v.lookup(context.Background(), "shared.example")
			if err == nil && (!found || host != "mx.shared.example") {
				err = errors.New("coalesced lookup returned the wrong result")
			}
			errs[index] = err
		}(i)
	}
	close(start)
	<-providerStarted
	close(release)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("caller %d: %v", i, err)
		}
	}
	countMu.Lock()
	gotCalls := providerCalls
	countMu.Unlock()
	if gotCalls != 1 {
		t.Fatalf("provider calls = %d, want one coalesced lookup", gotCalls)
	}
}

func TestLocalMXLookupCanceledWaiterDoesNotCancelSharedLeader(t *testing.T) {
	providerStarted := make(chan struct{})
	release := make(chan struct{})
	v := &LocalVerifier{
		LookupMX: func(context.Context, string) (bool, string, error) {
			close(providerStarted)
			<-release
			return true, "mx.shared.example", nil
		},
	}
	leaderDone := make(chan error, 1)
	go func() {
		_, _, err := v.lookup(context.Background(), "shared.example")
		leaderDone <- err
	}()
	<-providerStarted

	waiterCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := v.lookup(waiterCtx, "shared.example"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter error = %v, want context.Canceled", err)
	}
	close(release)
	if err := <-leaderDone; err != nil {
		t.Fatalf("shared leader was canceled by waiter: %v", err)
	}
}

func TestLocalMXLookupsHaveAGlobalConcurrencyBound(t *testing.T) {
	const callers = 8
	entered := make(chan string, callers)
	permits := make(chan struct{}, callers)
	v := &LocalVerifier{
		LookupConcurrency: 2,
		LookupMX: func(_ context.Context, domain string) (bool, string, error) {
			entered <- domain
			<-permits
			return true, "mx." + domain, nil
		},
	}

	start := make(chan struct{})
	errs := make(chan error, callers)
	var ready sync.WaitGroup
	ready.Add(callers)
	for i := range callers {
		go func(index int) {
			ready.Done()
			<-start
			_, _, err := v.lookup(context.Background(), fmt.Sprintf("d%d.example", index))
			errs <- err
		}(i)
	}
	ready.Wait()
	close(start)
	<-entered
	<-entered
	select {
	case domain := <-entered:
		t.Fatalf("lookup %s exceeded the global concurrency bound", domain)
	case <-time.After(50 * time.Millisecond):
	}

	// Completing one lookup releases exactly one shared slot.
	permits <- struct{}{}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("a queued lookup did not acquire the released global slot")
	}
	for range callers {
		permits <- struct{}{}
	}
	for range callers {
		if err := <-errs; err != nil {
			t.Fatalf("bounded lookup: %v", err)
		}
	}
}

func TestLocalVerifierBatchPreservesInputOrder(t *testing.T) {
	v := localWithMX(map[string]bool{"example.com": true})
	in := []string{"a@example.com", "bad", "support@example.com"}

	got, err := v.VerifyBatch(context.Background(), in)
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	if len(got) != len(in) {
		t.Fatalf("len = %d, want %d", len(got), len(in))
	}
	if got[0].Email != "a@example.com" || got[1].Email != "bad" || got[2].Email != "support@example.com" {
		t.Fatalf("order not preserved: %v", []string{got[0].Email, got[1].Email, got[2].Email})
	}
	if got[1].Status != StatusInvalid {
		t.Fatalf("got[1].Status = %q, want %q", got[1].Status, StatusInvalid)
	}
}

func TestLocalVerifierIsDecisiveOnlyForTerminalVerdicts(t *testing.T) {
	// Decisive results are the ones the chain is allowed to short-circuit
	// on — spending no paid credit. "unknown" must never be decisive.
	cases := []struct {
		status Status
		want   bool
	}{
		{StatusInvalid, true},
		{StatusDoNotMail, true},
		{StatusAbuse, true},
		{StatusSpamtrap, true},
		{StatusUnknown, false},
		{StatusCatchAll, false},
		{StatusValid, false},
	}
	for _, tc := range cases {
		if got := tc.status.Decisive(); got != tc.want {
			t.Errorf("Status(%q).Decisive() = %v, want %v", tc.status, got, tc.want)
		}
	}
}

func TestLocalVerifierRejectsOverlongLocalPart(t *testing.T) {
	v := localWithMX(map[string]bool{"example.com": true})
	long := strings.Repeat("a", 65) + "@example.com"

	got, err := v.Verify(context.Background(), long)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusInvalid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusInvalid)
	}
}
