// SPDX-License-Identifier: AGPL-3.0-only
//
// local.go — the free tier.
//
// LocalVerifier runs every check that can be made without touching a
// receiving mail server: syntax, advisory domain lists, and DNS. It
// is deliberately incapable of returning StatusValid, because nothing
// short of an SMTP conversation can establish that a mailbox exists,
// and Moosewave does not have that conversation (see the package doc).
//
// It terminally rejects only structural no-mail evidence and narrowly
// defined abuse desks. Heuristic list hits remain advisory so the metered
// tier can establish a mailbox verdict without sacrificing coverage.

package verification

import (
	"container/list"
	"context"
	"net"
	"strings"
	"sync"
	"time"
)

const localBatchConcurrency = 8

// DefaultDNSTimeout bounds a single MX lookup. Chosen to match the
// existing email_validator budget so batch latency is unchanged.
const DefaultDNSTimeout = 3 * time.Second

// DefaultMXCacheTTL is how long a per-domain MX answer is reused. A
// batch of 10k addresses is typically a few hundred distinct domains;
// without memoisation the resolver would see 10k queries.
const DefaultMXCacheTTL = time.Hour

// DefaultMXCacheMaxEntries bounds the shared process cache. Public forms can
// submit attacker-chosen domains, including endless unique NXDOMAINs, so a TTL
// alone is not a memory bound.
const DefaultMXCacheMaxEntries = 4096

// DefaultMXLookupConcurrency bounds resolver work across every request using a
// LocalVerifier. The per-batch worker pool is not sufficient on its own because
// many anonymous form requests can run concurrently.
const DefaultMXLookupConcurrency = 32

// MXLookupFunc resolves whether a domain accepts mail. It returns
// (found, primaryHost, err). Injectable so tests are hermetic.
type MXLookupFunc func(ctx context.Context, domain string) (bool, string, error)

// LocalVerifier implements Verifier without any paid dependency.
//
// The zero value is usable: it resolves via net.DefaultResolver and
// memoises answers in a process-local cache.
type LocalVerifier struct {
	// LookupMX overrides DNS resolution. nil uses the built-in
	// resolver-backed implementation.
	LookupMX MXLookupFunc
	// Resolver is used by the built-in lookup when LookupMX is nil.
	Resolver *net.Resolver
	// CacheTTL overrides DefaultMXCacheTTL.
	CacheTTL time.Duration
	// CacheMaxEntries overrides DefaultMXCacheMaxEntries when positive. Set it
	// before first use; production leaves it at the bounded default.
	CacheMaxEntries int
	// LookupConcurrency overrides DefaultMXLookupConcurrency when positive. Set
	// it before first use; production leaves it at the bounded default.
	LookupConcurrency int
	// Now overrides the clock, for tests.
	Now func() time.Time

	// ExtraDisposable is an explicit constructor-level terminal override for
	// tests or specialized compositions. Production currently shares a
	// LocalVerifier and does not populate this field from tenant settings.
	ExtraDisposable map[string]struct{}

	mu          sync.Mutex
	cache       map[string]*mxCacheEntry
	cacheOrder  *list.List
	inflight    map[string]*mxLookupFlight
	lookupSlots chan struct{}
}

type mxCacheEntry struct {
	found     bool
	host      string
	expiresAt time.Time
	element   *list.Element
}

type mxLookupFlight struct {
	done  chan struct{}
	found bool
	host  string
	err   error
}

// Name implements Verifier.
func (v *LocalVerifier) Name() string { return ProviderLocal }

// Credits implements Verifier. The local tier is free.
func (v *LocalVerifier) Credits(context.Context) (int, error) {
	return CreditsUnmetered, nil
}

// VerifyBatch implements Verifier, preserving input order.
func (v *LocalVerifier) VerifyBatch(ctx context.Context, emails []string) ([]Result, error) {
	if len(emails) > MaxBatch {
		return nil, ErrBatchTooLarge
	}
	if len(emails) == 0 {
		return []Result{}, nil
	}

	// MX lookups are independent and individually bounded by
	// DefaultDNSTimeout. A small worker pool prevents a valid synchronous batch
	// from paying that timeout serially while keeping resolver/socket fan-out
	// flat for durable 100-address job chunks.
	out := make([]Result, len(emails))
	jobs := make(chan int, len(emails))
	for i := range emails {
		jobs <- i
	}
	close(jobs)

	workers := localBatchConcurrency
	if len(emails) < workers {
		workers = len(emails)
	}
	var wg sync.WaitGroup
	var errOnce sync.Once
	var firstErr error
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				result, err := v.Verify(ctx, emails[i])
				if err != nil {
					errOnce.Do(func() { firstErr = err })
					continue
				}
				out[i] = result
			}
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

// Verify implements Verifier.
//
// Checks are ordered cheapest-first and each terminal verdict returns
// immediately, so a malformed address never costs a DNS query.
func (v *LocalVerifier) Verify(ctx context.Context, email string) (Result, error) {
	if hasUnsafeControlText(email) {
		return Result{
			Email:     email,
			Status:    StatusInvalid,
			SubStatus: SubStatusSyntaxInvalid,
			Provider:  ProviderLocal,
			Billable:  false,
			CheckedAt: v.now(),
		}, nil
	}
	raw := strings.TrimSpace(email)
	normalized := strings.ToLower(raw)

	res := Result{
		Email:     normalized,
		Provider:  ProviderLocal,
		Billable:  false,
		CheckedAt: v.now(),
	}

	local, domain, ok := splitAddress(normalized)
	if !ok {
		// Preserve the caller's original string on a syntax failure —
		// lowercasing "Not An Email" would misrepresent what was
		// submitted in the results the operator reviews.
		res.Email = raw
		res.Status = StatusInvalid
		res.SubStatus = SubStatusSyntaxInvalid
		return res, nil
	}
	res.Domain = domain

	// The shipped corpus is a legacy heuristic, not authoritative evidence that
	// a domain cannot receive legitimate mail. Preserve it as an advisory signal
	// and let a configured mailbox provider decide. Explicit constructor-level
	// overrides retain their terminal semantics.
	res.Disposable = IsDisposableDomain(domain)
	if v.isExplicitDisposable(domain) {
		res.Disposable = true
		res.Status = StatusDoNotMail
		res.SubStatus = SubStatusDisposable
		return res, nil
	}

	res.FreeEmail = isFreeMailDomain(domain)

	// Narrowly recognizable abuse/security desks are terminal. Broader shared
	// inbox names stay in the advisory role set below.
	if _, hit := abuseLocals[local]; hit {
		res.RoleAccount = true
		res.Status = StatusAbuse
		res.SubStatus = SubStatusRoleBased
		return res, nil
	}

	if _, hit := roleAccountLocals[local]; hit {
		res.RoleAccount = true
		// Functional B2B mailboxes are not proof of non-deliverability. Preserve
		// the risk flag, but continue through MX (and, in full mode, the paid
		// mailbox probe) instead of terminally filtering sales@/support@.
	}

	found, host, err := v.lookup(ctx, domain)
	if err != nil {
		// A resolver failure is not evidence the domain is bad.
		res.Status = StatusUnknown
		res.SubStatus = SubStatusServerDidNotRespond
		return res, nil
	}
	res.MXFound = found
	res.MXRecord = host

	if !found {
		res.Status = StatusInvalid
		res.SubStatus = SubStatusNoDNSEntries
		// A non-resolving domain one edit away from a high-volume
		// provider is overwhelmingly a typo, and saying so converts a
		// dead signup into a recoverable one.
		if suggestion, hit := suggestDomain(domain); hit {
			res.DidYouMean = local + "@" + suggestion
			res.SubStatus = SubStatusPossibleTypo
		}
		return res, nil
	}

	// The honest ceiling. Everything structural passed; mailbox
	// existence is simply not knowable from here.
	res.Status = StatusUnknown
	if res.Disposable {
		res.SubStatus = SubStatusDisposable
	} else if res.RoleAccount {
		res.SubStatus = SubStatusRoleBased
	} else {
		res.SubStatus = SubStatusNoMailboxProbe
	}
	return res, nil
}

func (v *LocalVerifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now().UTC()
}

func (v *LocalVerifier) isExplicitDisposable(domain string) bool {
	if v.ExtraDisposable != nil {
		if _, hit := v.ExtraDisposable[domain]; hit {
			return true
		}
	}
	return false
}

// lookup resolves the domain through the injected function or the
// built-in resolver, memoising either way.
func (v *LocalVerifier) lookup(ctx context.Context, domain string) (bool, string, error) {
	ttl := v.CacheTTL
	if ttl <= 0 {
		ttl = DefaultMXCacheTTL
	}
	now := v.now()

	v.mu.Lock()
	if entry, hit := v.cache[domain]; hit {
		if now.Before(entry.expiresAt) {
			v.cacheOrder.MoveToFront(entry.element)
			found, host := entry.found, entry.host
			v.mu.Unlock()
			return found, host, nil
		}
		v.removeMXCacheEntryLocked(domain, entry)
	}
	if flight, hit := v.inflight[domain]; hit {
		v.mu.Unlock()
		select {
		case <-ctx.Done():
			return false, "", ctx.Err()
		case <-flight.done:
			return flight.found, flight.host, flight.err
		}
	}
	if v.inflight == nil {
		v.inflight = make(map[string]*mxLookupFlight)
	}
	flight := &mxLookupFlight{done: make(chan struct{})}
	v.inflight[domain] = flight
	if v.lookupSlots == nil {
		concurrency := v.LookupConcurrency
		if concurrency <= 0 {
			concurrency = DefaultMXLookupConcurrency
		}
		v.lookupSlots = make(chan struct{}, concurrency)
	}
	lookupSlots := v.lookupSlots
	v.mu.Unlock()

	select {
	case lookupSlots <- struct{}{}:
	case <-ctx.Done():
		v.finishMXLookup(domain, flight, false, "", ctx.Err(), now, ttl)
		return false, "", ctx.Err()
	}

	fn := v.LookupMX
	if fn == nil {
		fn = v.resolveMX
	}
	found, host, err := fn(ctx, domain)
	<-lookupSlots
	v.finishMXLookup(domain, flight, found, host, err, v.now(), ttl)
	return found, host, err
}

func (v *LocalVerifier) finishMXLookup(
	domain string,
	flight *mxLookupFlight,
	found bool,
	host string,
	err error,
	observedAt time.Time,
	ttl time.Duration,
) {
	v.mu.Lock()
	flight.found, flight.host, flight.err = found, host, err
	if err == nil {
		v.putMXCacheEntryLocked(domain, found, host, observedAt.Add(ttl))
	}
	delete(v.inflight, domain)
	close(flight.done)
	v.mu.Unlock()
}

func (v *LocalVerifier) putMXCacheEntryLocked(
	domain string,
	found bool,
	host string,
	expiresAt time.Time,
) {
	if v.cache == nil {
		v.cache = make(map[string]*mxCacheEntry)
	}
	if v.cacheOrder == nil {
		v.cacheOrder = list.New()
	}
	if existing, ok := v.cache[domain]; ok {
		existing.found, existing.host, existing.expiresAt = found, host, expiresAt
		v.cacheOrder.MoveToFront(existing.element)
		return
	}
	maxEntries := v.CacheMaxEntries
	if maxEntries <= 0 {
		maxEntries = DefaultMXCacheMaxEntries
	}
	for len(v.cache) >= maxEntries {
		oldest := v.cacheOrder.Back()
		if oldest == nil {
			break
		}
		oldestDomain, _ := oldest.Value.(string)
		if entry, ok := v.cache[oldestDomain]; ok {
			v.removeMXCacheEntryLocked(oldestDomain, entry)
		} else {
			v.cacheOrder.Remove(oldest)
		}
	}
	element := v.cacheOrder.PushFront(domain)
	v.cache[domain] = &mxCacheEntry{
		found: found, host: host, expiresAt: expiresAt, element: element,
	}
}

func (v *LocalVerifier) removeMXCacheEntryLocked(domain string, entry *mxCacheEntry) {
	delete(v.cache, domain)
	if v.cacheOrder != nil && entry != nil && entry.element != nil {
		v.cacheOrder.Remove(entry.element)
	}
}

// resolveMX is the built-in DNS implementation.
func (v *LocalVerifier) resolveMX(ctx context.Context, domain string) (bool, string, error) {
	resolver := v.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	lookupCtx, cancel := context.WithTimeout(ctx, DefaultDNSTimeout)
	defer cancel()

	mxs, err := resolver.LookupMX(lookupCtx, domain)
	if err == nil && len(mxs) > 0 {
		for _, mx := range mxs {
			// RFC 7505's null MX (preference 0, exchange ".") is an
			// affirmative declaration that this domain accepts no email. It is
			// not equivalent to an absent MX record and must never reach the
			// implicit-A fallback below.
			if strings.TrimSpace(mx.Host) == "." {
				return false, "", nil
			}
		}
		return true, strings.TrimSuffix(mxs[0].Host, "."), nil
	}

	// RFC 5321 §5.1: a domain with an address record but no MX is a
	// legitimate implicit mail destination. Treating it as invalid
	// would reject a real slice of small self-hosted domains.
	addrs, aerr := resolver.LookupHost(lookupCtx, domain)
	if aerr == nil && len(addrs) > 0 {
		return true, domain, nil
	}

	// Distinguish "this domain has no mail" (authoritative NXDOMAIN /
	// no records) from "the resolver broke". Only the latter is an
	// error; the former is a legitimate negative answer.
	var dnsErr *net.DNSError
	if errorsAs(aerr, &dnsErr) && (dnsErr.IsNotFound || !dnsErr.IsTemporary) {
		return false, "", nil
	}
	if aerr != nil {
		return false, "", aerr
	}
	return false, "", nil
}

// errorsAs is a tiny shim so this file does not need the errors import
// solely for one call site.
func errorsAs(err error, target **net.DNSError) bool {
	if err == nil {
		return false
	}
	if e, ok := err.(*net.DNSError); ok {
		*target = e
		return true
	}
	return false
}

// splitAddress validates syntax and returns (local, domain, ok).
//
// This is intentionally tighter than RFC 5322 permits — quoted local
// parts, IP literals, and un-punycoded IDNs are rejected — because the
// addresses an ESP actually receives are a much smaller set than the
// grammar allows, and accepting exotic forms means accepting garbage.
func splitAddress(e string) (string, string, bool) {
	if len(e) < 3 || len(e) > 254 {
		return "", "", false
	}
	if strings.ContainsAny(e, " \t\r\n") {
		return "", "", false
	}
	at := strings.LastIndex(e, "@")
	if at <= 0 || at == len(e)-1 {
		return "", "", false
	}
	local, domain := e[:at], e[at+1:]
	if len(local) == 0 || len(local) > 64 {
		return "", "", false
	}
	if local[0] == '.' || local[len(local)-1] == '.' || strings.Contains(local, "..") {
		return "", "", false
	}
	if len(domain) > 253 {
		return "", "", false
	}
	if !strings.Contains(domain, ".") {
		return "", "", false
	}
	if strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") ||
		strings.HasPrefix(domain, "-") || strings.Contains(domain, "..") {
		return "", "", false
	}
	for _, r := range local {
		if !asciiDotAtomCharacter(r) {
			return "", "", false
		}
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", "", false
		}
		for _, r := range label {
			if !(r == '-' || (r >= '0' && r <= '9') ||
				(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')) {
				return "", "", false
			}
		}
	}
	return local, domain, true
}

func asciiDotAtomCharacter(r rune) bool {
	if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') || r == '.' {
		return true
	}
	return strings.ContainsRune("!#$%&'*+-/=?^_`{|}~", r)
}

// --- typo correction ---

// suggestDomain returns a likely-intended domain when the input is
// within one edit of a high-volume provider. The distance threshold is
// 1 rather than 2 deliberately: at 2 the corpus starts colliding
// (aol.com/eol.com), and a wrong suggestion is worse than none.
func suggestDomain(domain string) (string, bool) {
	if _, exact := popularDomains[domain]; exact {
		return "", false
	}
	match := ""
	for candidate := range popularDomains {
		// Cheap length gate before the O(n*m) distance computation.
		if abs(len(candidate)-len(domain)) > 1 {
			continue
		}
		if withinOneEdit(domain, candidate) {
			// Map iteration order is deliberately undefined. Returning the first
			// match would make replayed requests disagree across processes and can
			// steer a user to the wrong provider. An ambiguous correction is no
			// correction.
			if match != "" && match != candidate {
				return "", false
			}
			match = candidate
		}
	}
	return match, match != ""
}

// withinOneEdit reports whether a and b differ by a single
// insertion, deletion, substitution, or adjacent transposition —
// i.e. Damerau-Levenshtein distance 1.
//
// Transposition has to be in here rather than being approximated by
// two substitutions: swapped adjacent keys ("gmial", "yahooo" ->
// "yahoo", "hotmial") are the single most common way a real person
// mistypes a mail domain, and under plain Levenshtein a transposition
// scores 2, which would put every one of them out of reach.
//
// Trimming the common prefix and suffix first localises the edit to a
// short middle window, so this stays O(n) and allocation-free rather
// than building a full distance matrix per candidate domain.
func withinOneEdit(a, b string) bool {
	la, lb := len(a), len(b)
	if abs(la-lb) > 1 {
		return false
	}
	if a == b {
		return false // identical is not a correction
	}

	// Longest common prefix.
	i := 0
	for i < la && i < lb && a[i] == b[i] {
		i++
	}
	// Longest common suffix, not crossing the prefix.
	ja, jb := la-1, lb-1
	for ja >= i && jb >= i && a[ja] == b[jb] {
		ja--
		jb--
	}

	// Width of the differing window on each side.
	wa, wb := ja-i+1, jb-i+1

	switch {
	case wa <= 1 && wb <= 1:
		// One substitution (1/1), or one insertion/deletion (0/1).
		return true
	case wa == 2 && wb == 2:
		// Adjacent transposition: the two remaining characters are
		// each other's swap.
		return a[i] == b[i+1] && a[i+1] == b[i]
	default:
		return false
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
