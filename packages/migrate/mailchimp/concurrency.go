// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	adapter "github.com/postwave/migrate/adapter"
)

const (
	mailchimpMaxConcurrentRequests = 10
	mailchimpLimiterKeyPrefix      = "mailchimp-concurrency-v1:"
	mailchimpLimiterIdleTTL        = 15 * time.Minute
)

// requestLimiterRegistry owns process-wide, identity-scoped request groups.
// refs counts both holders and waiters. A verified account identity can bind a
// credential/data-center fallback group into the account group while requests
// are live; active counts are merged, so the handoff cannot create a second
// ten-request allowance.
//
// Idle aliases are retained briefly so a concurrent/repeated authentication
// can join the verified account group, then safely expired. The map contains
// only fixed-size hashes, never access tokens or other raw credentials.
type requestLimiterRegistry struct {
	mu      sync.Mutex
	entries map[string]*requestLimiterGroup
	idleTTL time.Duration
}

type requestLimiterGroup struct {
	parent       *requestLimiterGroup
	active       int
	refs         int
	keys         map[string]struct{}
	changed      chan struct{}
	cleanupTimer *time.Timer
}

var mailchimpRequestLimiters = requestLimiterRegistry{
	entries: make(map[string]*requestLimiterGroup),
	idleTTL: mailchimpLimiterIdleTTL,
}

func (r *requestLimiterRegistry) acquire(ctx context.Context, key string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	r.mu.Lock()
	group := r.groupForKeyLocked(key)
	r.cancelCleanupLocked(group)
	group.refs++
	for {
		group = r.rootLocked(group)
		if err := ctx.Err(); err != nil {
			group.refs--
			r.scheduleIdleCleanupLocked(group)
			r.mu.Unlock()
			return nil, err
		}
		if group.active < mailchimpMaxConcurrentRequests {
			group.active++
			r.mu.Unlock()
			break
		}

		changed := group.changed
		r.mu.Unlock()
		select {
		case <-changed:
			r.mu.Lock()
		case <-ctx.Done():
			r.mu.Lock()
			group = r.rootLocked(group)
			group.refs--
			r.scheduleIdleCleanupLocked(group)
			r.mu.Unlock()
			return nil, ctx.Err()
		}
	}

	// Cancellation may race the slot transition. Do not start an HTTP request
	// once the caller's context is already done.
	if err := ctx.Err(); err != nil {
		r.release(group)
		return nil, err
	}

	var once sync.Once
	return func() {
		once.Do(func() { r.release(group) })
	}, nil
}

func (r *requestLimiterRegistry) release(group *requestLimiterGroup) {
	r.mu.Lock()
	defer r.mu.Unlock()

	group = r.rootLocked(group)
	group.active--
	group.refs--
	r.signalLocked(group)
	r.scheduleIdleCleanupLocked(group)
}

// bind merges fallbackKey into the authenticated accountKey. accountKey is
// deliberately the surviving root so every alias converges on the conservative
// account-wide allowance. Existing holders cannot be revoked, but their active
// counts are combined and no new request starts until the total falls below 10.
func (r *requestLimiterRegistry) bind(fallbackKey, accountKey string) {
	if fallbackKey == accountKey {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	fallback := r.rootLocked(r.groupForKeyLocked(fallbackKey))
	account := r.rootLocked(r.groupForKeyLocked(accountKey))
	if fallback == account {
		return
	}

	r.cancelCleanupLocked(fallback)
	r.cancelCleanupLocked(account)
	account.active += fallback.active
	account.refs += fallback.refs
	fallback.active = 0
	fallback.refs = 0
	fallback.parent = account

	for key := range fallback.keys {
		account.keys[key] = struct{}{}
		r.entries[key] = account
	}
	fallback.keys = nil
	r.signalLocked(fallback)
	r.signalLocked(account)
	r.scheduleIdleCleanupLocked(account)
}

func (r *requestLimiterRegistry) groupForKeyLocked(key string) *requestLimiterGroup {
	if r.entries == nil {
		r.entries = make(map[string]*requestLimiterGroup)
	}
	if group := r.entries[key]; group != nil {
		root := r.rootLocked(group)
		if root.keys == nil {
			root.keys = make(map[string]struct{})
		}
		root.keys[key] = struct{}{}
		r.entries[key] = root
		return root
	}

	group := &requestLimiterGroup{
		keys:    map[string]struct{}{key: {}},
		changed: make(chan struct{}),
	}
	r.entries[key] = group
	return group
}

func (r *requestLimiterRegistry) rootLocked(group *requestLimiterGroup) *requestLimiterGroup {
	root := group
	for root.parent != nil {
		root = root.parent
	}
	for group.parent != nil && group.parent != root {
		next := group.parent
		group.parent = root
		group = next
	}
	return root
}

func (r *requestLimiterRegistry) signalLocked(group *requestLimiterGroup) {
	if group.changed != nil {
		close(group.changed)
	}
	group.changed = make(chan struct{})
}

func (r *requestLimiterRegistry) scheduleIdleCleanupLocked(group *requestLimiterGroup) {
	group = r.rootLocked(group)
	if group.refs != 0 || group.cleanupTimer != nil {
		return
	}
	if r.idleTTL <= 0 {
		r.cleanupGroupLocked(group)
		return
	}

	var timer *time.Timer
	timer = time.AfterFunc(r.idleTTL, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if group.cleanupTimer != timer {
			return
		}
		group.cleanupTimer = nil
		if group.parent == nil && group.refs == 0 {
			r.cleanupGroupLocked(group)
		}
	})
	group.cleanupTimer = timer
}

func (r *requestLimiterRegistry) cancelCleanupLocked(group *requestLimiterGroup) {
	if group.cleanupTimer == nil {
		return
	}
	group.cleanupTimer.Stop()
	group.cleanupTimer = nil
}

func (r *requestLimiterRegistry) cleanupGroupLocked(group *requestLimiterGroup) {
	if group.parent != nil || group.refs != 0 {
		return
	}
	for key := range group.keys {
		if r.entries[key] == group {
			delete(r.entries, key)
		}
	}
	group.keys = nil
}

// mailchimpRequestLimiterKey prefers the authenticated account fingerprint,
// allowing rotated/different credentials for one Mailchimp account to share a
// conservative ceiling. During the identity lookup, it falls back to a hash of
// the credential and data center. Both branches return only a one-way hash.
func mailchimpRequestLimiterKey(sess adapter.Session) string {
	if fingerprint := normalizedAccountFingerprint(sess); fingerprint != "" {
		return mailchimpAccountLimiterKey(fingerprint)
	}
	fallback := sess.AccessToken + "\x00" + strings.ToLower(strings.TrimSpace(sess.AccountID))
	return hashMailchimpLimiterIdentity("credential-dc", fallback)
}

func mailchimpAccountLimiterKey(fingerprint string) string {
	return hashMailchimpLimiterIdentity("account", strings.ToLower(strings.TrimSpace(fingerprint)))
}

func bindVerifiedMailchimpAccount(sess adapter.Session, fingerprint string) {
	if strings.TrimSpace(fingerprint) == "" {
		return
	}
	mailchimpRequestLimiters.bind(mailchimpRequestLimiterKey(sess), mailchimpAccountLimiterKey(fingerprint))
}

func normalizedAccountFingerprint(sess adapter.Session) string {
	if sess.Extra == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(sess.Extra[AccountFingerprintExtraKey]))
}

func hashMailchimpLimiterIdentity(kind, identity string) string {
	sum := sha256.Sum256([]byte(mailchimpLimiterKeyPrefix + kind + "\x00" + identity))
	return hex.EncodeToString(sum[:])
}
