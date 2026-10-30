// SPDX-License-Identifier: MIT

package klaviyo

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	adapter "github.com/postwave/migrate/adapter"
)

const (
	klaviyoLimiterIdleTTL    = 15 * time.Minute
	klaviyoLimiterMaxEntries = 4096
)

type klaviyoLimiterSet struct {
	accounts   *adapter.TokenBucket
	slow       *adapter.TokenBucket
	medium     *adapter.TokenBucket
	profiles   *adapter.TokenBucket
	defaultAPI *adapter.TokenBucket
}

func newKlaviyoLimiterSet() *klaviyoLimiterSet {
	return &klaviyoLimiterSet{
		// The account endpoint is XS (1/s, 15/m).
		accounts: adapter.NewTokenBucket(14, time.Minute, 1),
		// Flows and forms are S (3/s, 60/m).
		slow: adapter.NewTokenBucket(55, time.Minute, 2),
		// Campaign and campaign-message reads are capped at 150/m.
		medium: adapter.NewTokenBucket(140, time.Minute, 5),
		// Every profile read requests predictive_analytics. Klaviyo applies that
		// additional field's stricter 10/s, 150/m endpoint limit, so keep the
		// profile traversal below that cap rather than the base 75/s, 750/m cap.
		profiles: adapter.NewTokenBucket(140, time.Minute, 9),
		// Lists, segments, templates, and membership reads permit 750/m.
		defaultAPI: adapter.NewTokenBucket(700, time.Minute, 20),
	}
}

type klaviyoLimiterEntry struct {
	set      *klaviyoLimiterSet
	lastUsed time.Time
}

// klaviyoLimiterRegistry coordinates Klaviyo's per-account endpoint quotas
// across adapter instances. Rejected credentials share one bounded admission
// bucket, so rotating secrets cannot allocate unbounded process state.
type klaviyoLimiterRegistry struct {
	mu              sync.Mutex
	entries         map[string]klaviyoLimiterEntry
	idleTTL         time.Duration
	maxEntries      int
	now             func() time.Time
	unauthenticated *klaviyoLimiterSet
	overflow        *klaviyoLimiterSet
}

func newKlaviyoLimiterRegistry(maxEntries int, idleTTL time.Duration) *klaviyoLimiterRegistry {
	return &klaviyoLimiterRegistry{
		entries:         make(map[string]klaviyoLimiterEntry),
		idleTTL:         idleTTL,
		maxEntries:      maxEntries,
		now:             time.Now,
		unauthenticated: newKlaviyoLimiterSet(),
		overflow:        newKlaviyoLimiterSet(),
	}
}

var klaviyoRequestLimiters = newKlaviyoLimiterRegistry(klaviyoLimiterMaxEntries, klaviyoLimiterIdleTTL)

func (r *klaviyoLimiterRegistry) forRequest(sess adapter.Session, path string) *adapter.TokenBucket {
	set := r.forSession(sess)
	path = strings.ToLower(path)
	switch {
	case strings.HasPrefix(path, "/accounts"):
		return set.accounts
	case strings.HasPrefix(path, "/flows"), strings.HasPrefix(path, "/forms"):
		return set.slow
	case strings.HasPrefix(path, "/campaigns"), strings.HasPrefix(path, "/campaign-messages"):
		return set.medium
	case strings.HasPrefix(path, "/profiles"):
		return set.profiles
	default:
		return set.defaultAPI
	}
}

func (r *klaviyoLimiterRegistry) forSession(sess adapter.Session) *klaviyoLimiterSet {
	accountID := strings.TrimSpace(sess.AccountID)
	if accountID == "" {
		return r.unauthenticated
	}
	key := hashKlaviyoLimiterIdentity(accountID)
	now := r.now().UTC()
	r.mu.Lock()
	defer r.mu.Unlock()
	if entry, ok := r.entries[key]; ok {
		entry.lastUsed = now
		r.entries[key] = entry
		return entry.set
	}
	for candidate, entry := range r.entries {
		if r.idleTTL <= 0 || now.Sub(entry.lastUsed) >= r.idleTTL {
			delete(r.entries, candidate)
		}
	}
	if r.maxEntries <= 0 || len(r.entries) >= r.maxEntries {
		return r.overflow
	}
	set := newKlaviyoLimiterSet()
	r.entries[key] = klaviyoLimiterEntry{set: set, lastUsed: now}
	return set
}

// chargeIdentifiedAccount charges the successful /accounts request to the
// newly identified account's XS quota before another account request can run.
func (r *klaviyoLimiterRegistry) chargeIdentifiedAccount(accountID string) error {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return adapter.ErrAuth
	}
	r.forSession(adapter.Session{AccountID: accountID}).accounts.Debit()
	return nil
}

func hashKlaviyoLimiterIdentity(accountID string) string {
	digest := sha256.Sum256([]byte("klaviyo-account-rate-v1\x00" + strings.TrimSpace(accountID)))
	return hex.EncodeToString(digest[:])
}
