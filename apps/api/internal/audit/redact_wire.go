// SPDX-License-Identifier: AGPL-3.0-only
//
// redact_wire.go — glue that makes the redactor reachable from db.Audit
// without creating an import cycle. The db package exposes a function-
// valued hook (db.SetAuditRedactor); we install an implementation that
// loads the tenant's policy from audit_redaction_policies and applies
// it. main.go wires this up at startup.
//
// pii-redaction (Compliance, P0).

package audit

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// PolicyLoader is the read-side surface the wiring needs: fetch one
// tenant's redaction policy from postgres. Kept as an interface so
// tests can inject a stub and main.go's startup wiring can hand in a
// pgxpool-backed implementation.
type PolicyLoader interface {
	LoadPolicy(ctx context.Context, tenantID string) (Policy, error)
}

// policyCacheEntry holds one tenant's policy with the wall-clock time
// it was last refreshed. Cached entries expire after policyCacheTTL —
// short enough that a policy update propagates within a minute, long
// enough that the audit hot path doesn't hit the database every write.
type policyCacheEntry struct {
	policy Policy
	loaded time.Time
}

const policyCacheTTL = 60 * time.Second

// WireDB installs the audit redactor hook on db.Audit so every audit
// write applies the per-tenant policy + writes the encrypted side-blob.
//
// loader resolves the policy from postgres. cipher does the envelope
// encryption (nil-safe — ActionEncrypt rules degrade to ActionMask).
//
// Returns a function that uninstalls the hook (for tests).
func WireDB(loader PolicyLoader, cipher Cipher) func() {
	cache := sync.Map{} // tenantID -> *policyCacheEntry
	getPolicy := func(ctx context.Context, tenantID string) (Policy, error) {
		if v, ok := cache.Load(tenantID); ok {
			if e, ok := v.(*policyCacheEntry); ok && time.Since(e.loaded) < policyCacheTTL {
				return e.policy, nil
			}
		}
		p, err := loader.LoadPolicy(ctx, tenantID)
		if err != nil {
			// A failed custom-policy read is not evidence that the tenant has
			// no policy. Do not cache or silently downgrade it.
			return Policy{}, err
		}
		cache.Store(tenantID, &policyCacheEntry{policy: p, loaded: time.Now()})
		return p, nil
	}
	hook := db.AuditRedactor(func(
		ctx context.Context,
		tenantID string,
		metadata map[string]any,
	) (map[string]any, []byte, map[string]string, error) {
		p, err := getPolicy(ctx, tenantID)
		if err != nil {
			return nil, nil, nil, err
		}
		r := NewRedactor(p, cipher)
		res, err := r.Redact(ctx, metadata)
		if err != nil {
			return nil, nil, nil, err
		}
		var blob []byte
		if len(res.Encrypted) > 0 {
			b, encErr := r.EncryptSideBlob(ctx, res.Encrypted)
			if encErr == nil {
				blob = b
			}
			// On encrypt error: the in-place values have already been
			// masked by Redact, so the audit_log row is still safe;
			// we just lose the recoverable side-blob. Better than
			// failing the audit write.
		}
		return res.Redacted, blob, res.Hashes, nil
	})
	db.SetAuditRedactor(hook)
	return func() { db.SetAuditRedactor(nil) }
}

// InMemoryPolicyLoader is a deterministic loader for tests. Tenant id
// keys map to canned policies. Callers add entries before installing
// the redactor.
type InMemoryPolicyLoader struct {
	mu       sync.RWMutex
	policies map[string]Policy
}

// policyLoaderFunc is intentionally package-private; it keeps fail-closed
// wiring tests small without expanding the production interface surface.
type policyLoaderFunc func(context.Context, string) (Policy, error)

func (f policyLoaderFunc) LoadPolicy(ctx context.Context, tenantID string) (Policy, error) {
	return f(ctx, tenantID)
}

// NewInMemoryPolicyLoader builds an empty loader.
func NewInMemoryPolicyLoader() *InMemoryPolicyLoader {
	return &InMemoryPolicyLoader{policies: map[string]Policy{}}
}

// Set associates tenantID with policy.
func (l *InMemoryPolicyLoader) Set(tenantID string, p Policy) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.policies[tenantID] = p
}

// LoadPolicy returns the stored policy or the zero Policy if absent.
func (l *InMemoryPolicyLoader) LoadPolicy(_ context.Context, tenantID string) (Policy, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	p, ok := l.policies[tenantID]
	if !ok {
		return Policy{}, nil
	}
	return p, nil
}

// SQLPolicyLoader reads audit_redaction_policies via the supplied
// pool. The actual query is held behind a callback to keep this file
// free of pgxpool imports — main.go injects the query closure when it
// wires up the redactor.
type SQLPolicyLoader struct {
	Query func(ctx context.Context, tenantID string) (defaultsCSV string, rulesJSON []byte, err error)
}

// LoadPolicy materialises one tenant's policy from postgres.
func (l *SQLPolicyLoader) LoadPolicy(ctx context.Context, tenantID string) (Policy, error) {
	if l == nil || l.Query == nil {
		return Policy{}, nil
	}
	defaultsCSV, rulesJSON, err := l.Query(ctx, tenantID)
	if err != nil {
		return Policy{}, err
	}
	p := Policy{}
	for _, f := range strings.Split(defaultsCSV, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		p.DefaultRedactedFields = append(p.DefaultRedactedFields, f)
	}
	if len(rulesJSON) > 0 {
		_ = json.Unmarshal(rulesJSON, &p.JSONPathRules)
	}
	return p, nil
}
