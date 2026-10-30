// Package secrets resolves named runtime secrets from a backend chosen at
// startup: AWS Secrets Manager in production, or process environment
// variables in dev/local.
//
// This package lives at packages/secrets so it can be imported by every
// Moosewave Go module (apps/api and services/migration today, more soon).
// Earlier it lived at apps/api/internal/secrets, which Go's `internal`
// rule made unimportable from sibling modules and forced a duplicate
// implementation in services/migration. Lifting it to a sibling
// top-level module collapses that duplication.
//
// Resolver is the unified surface; consumers (services/migration's
// Listmonk client today, more soon) only see the interface and stay
// portable across backends.
//
// AWS values are cached in-process for 5 minutes to avoid hammering the
// Secrets Manager API on every request — we typically resolve the same
// few secret names thousands of times per minute. Refresh(name) lets a
// caller force-flush a single entry after a rotation.
package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

// Resolver is the consumer-facing surface. Implementations must be safe
// for concurrent use.
type Resolver interface {
	// Get returns the raw string value of `name`. Returns ErrNotFound
	// when the secret does not exist; callers can fall back to env.
	Get(ctx context.Context, name string) (string, error)

	// GetJSON unmarshals the secret's JSON payload into dst.
	GetJSON(ctx context.Context, name string, dst any) error

	// Refresh invalidates any cached value for `name`. No-op for
	// resolvers that don't cache.
	Refresh(name string)
}

// ErrNotFound signals "the backend does not have this secret". Callers
// can errors.Is() this to know it's safe to fall back to env vars.
var ErrNotFound = errors.New("secrets: not found")

// DefaultCacheTTL is the in-process TTL for AwsSecretsResolver. Five
// minutes balances freshness (so rotations propagate within a short
// window) against API quota (Secrets Manager rate-limits aggressively
// at ~5K req/sec/account).
const DefaultCacheTTL = 5 * time.Minute

// DefaultGetTimeout caps a single Secrets Manager round trip.
const DefaultGetTimeout = 5 * time.Second

// --- env-backed resolver -----------------------------------------------

// EnvResolver reads secret values from the process environment. Names
// containing '/' or '-' are upcased and substituted into shell-style
// identifiers (e.g. `postwave/listmonk` → `POSTWAVE_LISTMONK`).
type EnvResolver struct{}

// NewEnvResolver constructs the env-backed resolver.
func NewEnvResolver() *EnvResolver { return &EnvResolver{} }

// Get returns os.Getenv(envName(name)) with ErrNotFound semantics.
func (e *EnvResolver) Get(_ context.Context, name string) (string, error) {
	v := os.Getenv(envName(name))
	if v == "" {
		return "", ErrNotFound
	}
	return v, nil
}

// GetJSON unmarshals the env value as JSON.
func (e *EnvResolver) GetJSON(ctx context.Context, name string, dst any) error {
	raw, err := e.Get(ctx, name)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), dst)
}

// Refresh is a no-op (no cache).
func (e *EnvResolver) Refresh(_ string) {}

func envName(name string) string {
	r := strings.NewReplacer("/", "_", "-", "_", ".", "_")
	return strings.ToUpper(r.Replace(name))
}

// --- AWS Secrets Manager resolver --------------------------------------

// smAPI is the narrow surface we consume. *secretsmanager.Client satisfies
// it; tests inject a fake.
type smAPI interface {
	GetSecretValue(ctx context.Context, in *secretsmanager.GetSecretValueInput, optFns ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error)
}

type smCacheEntry struct {
	value     string
	expiresAt time.Time
}

// AwsSecretsResolver resolves names against AWS Secrets Manager with an
// in-process TTL cache.
type AwsSecretsResolver struct {
	Client  smAPI
	TTL     time.Duration
	Timeout time.Duration

	mu    sync.Mutex
	cache map[string]smCacheEntry

	// now is overridable in tests for cache-expiry assertions.
	now func() time.Time
}

// NewAwsResolver constructs an AwsSecretsResolver.
func NewAwsResolver(client *secretsmanager.Client, ttl time.Duration) *AwsSecretsResolver {
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	return &AwsSecretsResolver{
		Client:  client,
		TTL:     ttl,
		Timeout: DefaultGetTimeout,
		cache:   map[string]smCacheEntry{},
	}
}

// Get resolves `name` against Secrets Manager, with cache.
func (r *AwsSecretsResolver) Get(ctx context.Context, name string) (string, error) {
	if v, ok := r.cacheLookup(name); ok {
		return v, nil
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = DefaultGetTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	out, err := r.Client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId: aws.String(name),
	})
	if err != nil {
		if isResourceNotFound(err) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("secretsmanager %q: %w", name, err)
	}
	val := ""
	if out.SecretString != nil {
		val = *out.SecretString
	} else if len(out.SecretBinary) > 0 {
		val = string(out.SecretBinary)
	}
	if val == "" {
		return "", ErrNotFound
	}
	r.cacheStore(name, val)
	return val, nil
}

// GetJSON unmarshals the secret payload as JSON. The cache stores the
// raw string; we re-decode each call so callers can pass differently
// shaped dst values without poisoning the cache.
func (r *AwsSecretsResolver) GetJSON(ctx context.Context, name string, dst any) error {
	raw, err := r.Get(ctx, name)
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(raw), dst); err != nil {
		return fmt.Errorf("secretsmanager %q: parse json: %w", name, err)
	}
	return nil
}

// Refresh evicts a single name from the cache.
func (r *AwsSecretsResolver) Refresh(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cache, name)
}

func (r *AwsSecretsResolver) cacheLookup(name string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.cache[name]
	if !ok {
		return "", false
	}
	if r.timeNow().After(entry.expiresAt) {
		delete(r.cache, name)
		return "", false
	}
	return entry.value, true
}

func (r *AwsSecretsResolver) cacheStore(name, value string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cache == nil {
		r.cache = map[string]smCacheEntry{}
	}
	r.cache[name] = smCacheEntry{value: value, expiresAt: r.timeNow().Add(r.TTL)}
}

func (r *AwsSecretsResolver) timeNow() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// isResourceNotFound matches the typed and untyped variants Secrets
// Manager can return for a missing secret.
func isResourceNotFound(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "ResourceNotFoundException") ||
		strings.Contains(msg, "secret not found")
}

// --- chained resolver --------------------------------------------------

// ChainResolver tries each Resolver in order and returns the first hit.
// Useful for "Secrets Manager first, env fallback" patterns where the
// caller wants a single Resolver to hand around.
type ChainResolver struct {
	Resolvers []Resolver
}

// NewChain constructs a ChainResolver. Order matters: first hit wins.
func NewChain(resolvers ...Resolver) *ChainResolver {
	return &ChainResolver{Resolvers: resolvers}
}

// Get returns the first hit. A backend that fails HARD (network, permissions)
// does not stop the chain — env fallback should still work when Secrets Manager
// is unreachable — but its error outranks a later ErrNotFound.
//
// That precedence is the whole point, and it was inverted. Both arms of the old
// loop did the same thing (`lastErr = err; continue`), so the
// `if !errors.Is(err, ErrNotFound)` branch read like precedence handling while
// changing nothing, and the LAST error won. With the production order —
// NewChain(Aws, Env), which is what apps/api/internal/boot/aws.go and
// services/migration/main.go both construct — a Secrets Manager outage followed
// by an env miss returned ErrNotFound.
//
// ErrNotFound is not a neutral answer here. This package documents it as the
// signal that "the backend does not have this secret", and callers errors.Is()
// it to decide it is safe to proceed without one. So a total outage was
// reported as a definitive absence, and a caller would carry on with a default
// instead of failing loudly. Reversing the two resolvers surfaced the error
// correctly, which is how a real outage could look fine in staging and swallow
// itself in production.
func (c *ChainResolver) Get(ctx context.Context, name string) (string, error) {
	var hardErr error
	for _, r := range c.Resolvers {
		v, err := r.Get(ctx, name)
		if err == nil {
			return v, nil
		}
		if errors.Is(err, ErrNotFound) {
			continue
		}
		// Keep the FIRST hard error: it is the one closest to the backend the
		// caller configured first, and therefore the most informative.
		if hardErr == nil {
			hardErr = err
		}
	}
	if hardErr != nil {
		return "", hardErr
	}
	// Every resolver said "not here" — including the empty-chain case, where
	// nothing has it because nothing was asked.
	return "", ErrNotFound
}

func (c *ChainResolver) GetJSON(ctx context.Context, name string, dst any) error {
	raw, err := c.Get(ctx, name)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), dst)
}

func (c *ChainResolver) Refresh(name string) {
	for _, r := range c.Resolvers {
		r.Refresh(name)
	}
}
