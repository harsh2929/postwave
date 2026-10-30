package secrets

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

func TestEnvResolverGet(t *testing.T) {
	t.Setenv("POSTWAVE_LISTMONK", `{"admin_user":"u","admin_password":"p","base_url":"http://x"}`)
	r := NewEnvResolver()
	v, err := r.Get(context.Background(), "postwave/listmonk")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(v, "admin_user") {
		t.Fatalf("got %q", v)
	}
}

func TestEnvResolverGetJSON(t *testing.T) {
	t.Setenv("POSTWAVE_LISTMONK", `{"admin_user":"u","admin_password":"p","base_url":"http://x"}`)
	r := NewEnvResolver()
	var creds struct {
		AdminUser     string `json:"admin_user"`
		AdminPassword string `json:"admin_password"`
		BaseURL       string `json:"base_url"`
	}
	if err := r.GetJSON(context.Background(), "postwave/listmonk", &creds); err != nil {
		t.Fatal(err)
	}
	if creds.AdminUser != "u" || creds.AdminPassword != "p" || creds.BaseURL != "http://x" {
		t.Fatalf("decoded: %+v", creds)
	}
}

func TestEnvResolverNotFound(t *testing.T) {
	_ = os.Unsetenv("POSTWAVE_DOES_NOT_EXIST")
	r := NewEnvResolver()
	if _, err := r.Get(context.Background(), "postwave/does-not-exist"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// fakeSM implements smAPI for AwsSecretsResolver tests.
type fakeSM struct {
	calls atomic.Int64
	value string
	err   error
}

func (f *fakeSM) GetSecretValue(_ context.Context, in *secretsmanager.GetSecretValueInput, _ ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error) {
	f.calls.Add(1)
	if f.err != nil {
		return nil, f.err
	}
	return &secretsmanager.GetSecretValueOutput{
		Name:         in.SecretId,
		SecretString: aws.String(f.value),
	}, nil
}

func TestAwsResolverCachesValues(t *testing.T) {
	fk := &fakeSM{value: `{"x":1}`}
	r := &AwsSecretsResolver{
		Client:  fk,
		TTL:     1 * time.Minute,
		Timeout: time.Second,
		cache:   map[string]smCacheEntry{},
	}
	for i := 0; i < 3; i++ {
		v, err := r.Get(context.Background(), "any")
		if err != nil || v != `{"x":1}` {
			t.Fatalf("iter %d: %q %v", i, v, err)
		}
	}
	if got := fk.calls.Load(); got != 1 {
		t.Fatalf("expected 1 sm call, got %d", got)
	}
}

func TestAwsResolverRefresh(t *testing.T) {
	fk := &fakeSM{value: "v1"}
	r := &AwsSecretsResolver{
		Client:  fk,
		TTL:     1 * time.Minute,
		Timeout: time.Second,
		cache:   map[string]smCacheEntry{},
	}
	if _, err := r.Get(context.Background(), "n"); err != nil {
		t.Fatal(err)
	}
	r.Refresh("n")
	if _, err := r.Get(context.Background(), "n"); err != nil {
		t.Fatal(err)
	}
	if got := fk.calls.Load(); got != 2 {
		t.Fatalf("expected 2 calls after refresh, got %d", got)
	}
}

func TestAwsResolverCacheExpires(t *testing.T) {
	fk := &fakeSM{value: "v"}
	clock := time.Now()
	r := &AwsSecretsResolver{
		Client:  fk,
		TTL:     1 * time.Minute,
		Timeout: time.Second,
		cache:   map[string]smCacheEntry{},
		now:     func() time.Time { return clock },
	}
	if _, err := r.Get(context.Background(), "n"); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(2 * time.Minute) // past TTL
	if _, err := r.Get(context.Background(), "n"); err != nil {
		t.Fatal(err)
	}
	if got := fk.calls.Load(); got != 2 {
		t.Fatalf("expected 2 calls after expiry, got %d", got)
	}
}

func TestAwsResolverNotFound(t *testing.T) {
	fk := &fakeSM{err: errors.New("ResourceNotFoundException: bla")}
	r := NewAwsResolver(nil, 0)
	r.Client = fk
	if _, err := r.Get(context.Background(), "n"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestAwsResolverGetJSON(t *testing.T) {
	fk := &fakeSM{value: `{"admin_user":"u","admin_password":"p","base_url":"http://x"}`}
	r := NewAwsResolver(nil, 0)
	r.Client = fk
	var creds struct {
		AdminUser     string `json:"admin_user"`
		AdminPassword string `json:"admin_password"`
		BaseURL       string `json:"base_url"`
	}
	if err := r.GetJSON(context.Background(), "postwave/listmonk", &creds); err != nil {
		t.Fatal(err)
	}
	if creds.AdminUser != "u" || creds.AdminPassword != "p" {
		t.Fatalf("decoded: %+v", creds)
	}
}

func TestChainResolverFallsBackToEnv(t *testing.T) {
	t.Setenv("POSTWAVE_LISTMONK", "from-env")
	primary := &AwsSecretsResolver{
		Client: &fakeSM{err: errors.New("ResourceNotFoundException: nope")},
		TTL:    time.Minute, Timeout: time.Second,
		cache: map[string]smCacheEntry{},
	}
	chain := NewChain(primary, NewEnvResolver())
	v, err := chain.Get(context.Background(), "postwave/listmonk")
	if err != nil {
		t.Fatal(err)
	}
	if v != "from-env" {
		t.Fatalf("expected from-env, got %q", v)
	}
}

func TestChainResolverPreservesPrimaryHardError(t *testing.T) {
	// Primary returns a hard (non-ErrNotFound) error and env has the
	// value: chain should still succeed via env, and not propagate the
	// primary's transient error.
	t.Setenv("POSTWAVE_LISTMONK", "from-env")
	primary := &AwsSecretsResolver{
		Client: &fakeSM{err: errors.New("transient blip")},
		TTL:    time.Minute, Timeout: time.Second,
		cache: map[string]smCacheEntry{},
	}
	chain := NewChain(primary, NewEnvResolver())
	if v, err := chain.Get(context.Background(), "postwave/listmonk"); err != nil || v != "from-env" {
		t.Fatalf("got %q %v", v, err)
	}
}

// TestAwsResolverIntegration round-trips a real secret. Skipped unless
// AWS_TEST_SECRET_NAME is set; the secret must already exist (we don't
// create one in the integration test).
func TestAwsResolverIntegration(t *testing.T) {
	name := os.Getenv("AWS_TEST_SECRET_NAME")
	if name == "" {
		t.Skip("AWS_TEST_SECRET_NAME not set; skipping integration test")
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		t.Fatalf("aws cfg: %v", err)
	}
	client := secretsmanager.NewFromConfig(cfg)
	r := NewAwsResolver(client, 1*time.Minute)
	v, err := r.Get(ctx, name)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if v == "" {
		t.Fatal("empty secret value")
	}
}

// --- chain error precedence ------------------------------------------------

type stubResolver struct {
	value string
	err   error
}

func (s stubResolver) Get(context.Context, string) (string, error) {
	if s.err != nil {
		return "", s.err
	}
	return s.value, nil
}
func (s stubResolver) GetJSON(context.Context, string, any) error { return s.err }
func (s stubResolver) Refresh(string)                             {}

// TestChainPrefersAHardErrorOverNotFound pins the distinction this package's
// own contract rests on.
//
// ErrNotFound is documented as "the backend does not have this secret", and
// callers errors.Is() it to decide it is safe to proceed without one. A network
// timeout or a permissions failure means something entirely different: nobody
// knows whether the secret exists.
//
// Both arms of the old loop did the same thing, so the LAST error won — and
// with the production order, NewChain(Aws, Env), the last error is the env
// miss. A total Secrets Manager outage was therefore reported as a definitive
// absence, and a caller would carry on with a default rather than fail.
func TestChainPrefersAHardErrorOverNotFound(t *testing.T) {
	outage := errors.New("secretsmanager: dial tcp: i/o timeout")

	// The production order: Secrets Manager first, env fallback second.
	chain := NewChain(stubResolver{err: outage}, stubResolver{err: ErrNotFound})
	_, err := chain.Get(context.Background(), "postwave/prod/db-dsn")
	if errors.Is(err, ErrNotFound) {
		t.Fatal("a Secrets Manager outage was reported as ErrNotFound; a caller would treat an unreachable backend as a missing secret and fall back to a default")
	}
	if !errors.Is(err, outage) {
		t.Fatalf("expected the backend error to survive, got %v", err)
	}
}

// TestChainKeepsTryingAfterAHardError is the other half: a hard error must not
// stop the chain, because env fallback is exactly what it is for.
func TestChainKeepsTryingAfterAHardError(t *testing.T) {
	chain := NewChain(
		stubResolver{err: errors.New("secretsmanager: dial tcp: i/o timeout")},
		stubResolver{value: "from-env"},
	)
	got, err := chain.Get(context.Background(), "postwave/prod/db-dsn")
	if err != nil {
		t.Fatalf("env fallback must still resolve during an outage: %v", err)
	}
	if got != "from-env" {
		t.Fatalf("got %q, want %q", got, "from-env")
	}
}

// TestChainReportsNotFoundWhenEveryBackendAgrees keeps the fallback contract
// usable — guard the guard: an implementation that returned a hard error for
// everything would satisfy the first test.
func TestChainReportsNotFoundWhenEveryBackendAgrees(t *testing.T) {
	chain := NewChain(stubResolver{err: ErrNotFound}, stubResolver{err: ErrNotFound})
	_, err := chain.Get(context.Background(), "postwave/prod/db-dsn")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("all-miss must stay ErrNotFound so callers can fall back, got %v", err)
	}
}

// TestChainPrecedenceDoesNotDependOnOrder is what makes the fix a fix. The old
// behaviour was correct when the env resolver happened to come first, so the
// defect was invisible to any test that used only one ordering.
func TestChainPrecedenceDoesNotDependOnOrder(t *testing.T) {
	outage := errors.New("secretsmanager: dial tcp: i/o timeout")
	for _, tc := range []struct {
		name  string
		chain *ChainResolver
	}{
		{"hard error first", NewChain(stubResolver{err: outage}, stubResolver{err: ErrNotFound})},
		{"hard error last", NewChain(stubResolver{err: ErrNotFound}, stubResolver{err: outage})},
	} {
		if _, err := tc.chain.Get(context.Background(), "n"); errors.Is(err, ErrNotFound) {
			t.Errorf("%s: outage masked as ErrNotFound", tc.name)
		}
	}
}

// TestEmptyChainIsNotFound covers the degenerate case rather than leaving it to
// whichever branch happens to fall through.
func TestEmptyChainIsNotFound(t *testing.T) {
	if _, err := NewChain().Get(context.Background(), "n"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty chain should be ErrNotFound, got %v", err)
	}
}
