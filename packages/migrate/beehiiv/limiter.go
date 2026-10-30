// SPDX-License-Identifier: MIT

package beehiiv

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	adapter "github.com/postwave/migrate/adapter"
)

const (
	beehiivLimiterIdleTTL    = 15 * time.Minute
	beehiivLimiterMaxEntries = 4096
)

type beehiivLimiterEntry struct {
	bucket   *adapter.TokenBucket
	lastUsed time.Time
}

// beehiivLimiterRegistry bounds process-wide organization rate-limit state.
// Unauthenticated identify requests share one conservative bucket, so an
// attacker cannot allocate a map entry by rotating rejected credentials.
// Authenticated workspaces use fixed-size hashes, expire lazily after an idle
// TTL, and fall back to one shared overflow bucket if the hard capacity is
// reached. The overflow path may throttle unrelated excess workspaces, but it
// can never grant them an additional provider allowance or grow memory.
type beehiivLimiterRegistry struct {
	mu              sync.Mutex
	entries         map[string]beehiivLimiterEntry
	idleTTL         time.Duration
	maxEntries      int
	now             func() time.Time
	unauthenticated *adapter.TokenBucket
	overflow        *adapter.TokenBucket
}

func newBeehiivLimiterRegistry(maxEntries int, idleTTL time.Duration) *beehiivLimiterRegistry {
	return &beehiivLimiterRegistry{
		entries:         make(map[string]beehiivLimiterEntry),
		idleTTL:         idleTTL,
		maxEntries:      maxEntries,
		now:             time.Now,
		unauthenticated: adapter.NewTokenBucket(requestsPerMinute, time.Minute, requestBurst),
		overflow:        adapter.NewTokenBucket(requestsPerMinute, time.Minute, requestBurst),
	}
}

var beehiivRequestLimiters = newBeehiivLimiterRegistry(beehiivLimiterMaxEntries, beehiivLimiterIdleTTL)

func (r *beehiivLimiterRegistry) forSession(sess adapter.Session) *adapter.TokenBucket {
	workspaceID := WorkspaceID(sess)
	if workspaceID == "" {
		return r.unauthenticated
	}
	return r.forWorkspace(workspaceID)
}

func (r *beehiivLimiterRegistry) forWorkspace(workspaceID string) *adapter.TokenBucket {
	key := hashBeehiivLimiterIdentity(workspaceID)
	now := r.now().UTC()

	r.mu.Lock()
	defer r.mu.Unlock()
	if entry, ok := r.entries[key]; ok {
		entry.lastUsed = now
		r.entries[key] = entry
		return entry.bucket
	}
	for candidate, entry := range r.entries {
		if r.idleTTL <= 0 || now.Sub(entry.lastUsed) >= r.idleTTL {
			delete(r.entries, candidate)
		}
	}
	if r.maxEntries <= 0 || len(r.entries) >= r.maxEntries {
		return r.overflow
	}
	bucket := adapter.NewTokenBucket(requestsPerMinute, time.Minute, requestBurst)
	r.entries[key] = beehiivLimiterEntry{bucket: bucket, lastUsed: now}
	return bucket
}

// chargeIdentifiedWorkspace retroactively accounts for the identify request in
// the organization bucket before any second provider call is dispatched. The
// unauthenticated bucket remains an admission guard, but it must not become an
// additional allowance beside Beehiiv's per-organization quota.
func (r *beehiivLimiterRegistry) chargeIdentifiedWorkspace(workspaceID string) error {
	if strings.TrimSpace(workspaceID) == "" {
		return adapter.ErrAuth
	}
	r.forWorkspace(workspaceID).Debit()
	return nil
}

func hashBeehiivLimiterIdentity(workspaceID string) string {
	digest := sha256.Sum256([]byte("beehiiv-workspace-rate-v1\x00" + strings.TrimSpace(workspaceID)))
	return hex.EncodeToString(digest[:])
}
