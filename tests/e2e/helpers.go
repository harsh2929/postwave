// Package e2e is the harness for end-to-end Moosewave journeys.
//
// The suite drives the local Docker stack (`infra/docker-compose.yml` +
// `infra/docker-compose.full.yml`) over HTTP only. It MUST NOT import
// any code from apps/api or services/* — otherwise it stops being an
// end-to-end test and becomes a glorified unit test of types.
//
// Lifecycle (per-test):
//
//  1. WaitForStack waits for /api/health on the api container. We do
//     NOT bring the stack up inside the test process — that's the
//     responsibility of `tests/e2e/run.sh` or the CI workflow which
//     runs `docker compose up -d` once for the whole suite. Booting
//     containers per-test is too slow (~90s warmup each).
//  2. The journey functions (signup_flow_test.go etc) acquire a fresh
//     tenant slug via NewTenantSlug, run the journey through HTTP, and
//     return.
//  3. CleanupTenant deletes the tenant + cascaded rows. The dev stack
//     enables POSTWAVE_DEV_TENANT_SLUG_HEADER + a tiny test-only DELETE
//     hook (TODO: introduce when the journeys go live).
package e2e

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Config carries the resolved env for a journey. Constructed by
// NewConfig from process env vars; tests may override fields directly.
type Config struct {
	// APIBase is the base URL of the api container, default
	// http://localhost:8080. Must NOT end with a trailing slash.
	APIBase string
	// WebBase is the base URL of the Next.js web container, default
	// http://localhost:3000. Some journeys (campaign sandbox) hit
	// /forms/* on the web side.
	WebBase string
	// TenantSlug is the X-Tenant-Slug header (the dev stack opts
	// into header-based tenant routing via POSTWAVE_DEV_TENANT_SLUG_HEADER=1).
	TenantSlug string
	// AdminRole is the role header (dev stack honors
	// POSTWAVE_DEV_ADMIN_ROLE_HEADER=1 → X-Postwave-Role).
	AdminRole string
	// HTTPClient is the http.Client used for all requests. Tests may
	// substitute a custom one (e.g. with a transport that records).
	HTTPClient *http.Client
}

// NewConfig builds a Config from env, applying sensible local defaults.
//
//	POSTWAVE_E2E_API_BASE     default http://localhost:8080
//	POSTWAVE_E2E_WEB_BASE     default http://localhost:3000
//	POSTWAVE_E2E_TENANT_SLUG  default "demo" (the seed from db-migrate)
//	POSTWAVE_E2E_ADMIN_ROLE   default "admin"
func NewConfig() *Config {
	return &Config{
		APIBase:    envOrDefault("POSTWAVE_E2E_API_BASE", "http://localhost:8080"),
		WebBase:    envOrDefault("POSTWAVE_E2E_WEB_BASE", "http://localhost:3000"),
		TenantSlug: envOrDefault("POSTWAVE_E2E_TENANT_SLUG", "demo"),
		AdminRole:  envOrDefault("POSTWAVE_E2E_ADMIN_ROLE", "admin"),
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
}

func envOrDefault(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

// StrictAssertions upgrades every "environment not ready" skip/soft assertion
// into a hard failure. Release-candidate Docker runs enable this so a green
// gate cannot hide behind skipped journeys or partial Listmonk assertions.
func StrictAssertions() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POSTWAVE_E2E_STRICT_ASSERTIONS"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// E2EEnabled is an explicit ownership handshake between the journey process
// and the stack runner. Without it, a developer's unrelated or stale process
// on the default port could satisfy /api/health and receive destructive E2E
// traffic. tests/e2e/run.sh sets the flag only after it has brought up (or has
// explicitly been told to reuse) the governed compose topology.
func E2EEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POSTWAVE_E2E_RUN"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func SkipOrFatal(t *testing.T, format string, args ...any) {
	t.Helper()
	if StrictAssertions() {
		t.Fatalf("strict e2e assertion: "+format, args...)
	}
	t.Skipf(format, args...)
}

func LogOrFatal(t *testing.T, format string, args ...any) {
	t.Helper()
	if StrictAssertions() {
		t.Fatalf("strict e2e assertion: "+format, args...)
	}
	t.Logf(format, args...)
}

// NewTenantSlug returns a unique slug for a journey so concurrent runs
// don't collide. Format: e2e-<random>. The journey is responsible for
// passing this slug as X-Tenant-Slug on every request.
func NewTenantSlug(prefix string) string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("rand: %v", err))
	}
	return fmt.Sprintf("%s-%s", prefix, hex.EncodeToString(b[:]))
}

// WaitForStack polls /api/health up to `timeout` waiting for HTTP 200.
// Returns nil on success, the last error otherwise. Tests should call
// this in TestMain or at the top of each journey to fail fast when the
// docker stack is missing.
func WaitForStack(cfg *Config, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := cfg.APIBase + "/api/health"
	var lastErr error
	for time.Now().Before(deadline) {
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := cfg.HTTPClient.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("api/health returned %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(2 * time.Second)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("timeout waiting for %s", url)
	}
	return lastErr
}

// JSONRequest performs a JSON request against `cfg.APIBase + path`,
// applying the dev tenant + role headers.
//
// Returns the response body bytes and the HTTP status. Decoding into a
// typed struct is the caller's responsibility — at this stage every
// journey uses ad-hoc shapes so a generic Result interface adds
// nothing.
func JSONRequest(cfg *Config, method, path string, body any) (status int, respBody []byte, err error) {
	url := cfg.APIBase + path

	var bodyReader io.Reader
	if body != nil {
		buf, mErr := json.Marshal(body)
		if mErr != nil {
			return 0, nil, fmt.Errorf("marshal request: %w", mErr)
		}
		bodyReader = bytes.NewReader(buf)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return 0, nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cfg.TenantSlug != "" {
		req.Header.Set("X-Tenant-Slug", cfg.TenantSlug)
		req.Header.Set("X-Postwave-Tenant", cfg.TenantSlug)
	}
	if cfg.AdminRole != "" {
		req.Header.Set("X-Postwave-Role", cfg.AdminRole)
	}

	resp, err := cfg.HTTPClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()
	respBody, err = io.ReadAll(io.LimitReader(resp.Body, 8<<20)) // 8 MiB cap
	if err != nil {
		return resp.StatusCode, nil, fmt.Errorf("read body: %w", err)
	}
	return resp.StatusCode, respBody, nil
}

// CleanupTenant registers a t.Cleanup that issues
// DELETE /api/internal/tenants/{slug} so per-test rows don't pile up
// in the dev database. The endpoint is implemented by
// apps/api/internal/tenants.MountAdmin and is idempotent: 200 OK
// whether the tenant exists or not. Cleanup failures fail strict release
// runs because leftover tenant rows can poison later journeys; ad-hoc dev
// runs still log cleanup failures to keep iteration moving.
func CleanupTenant(t *testing.T, cfg *Config, tenantSlug string) {
	t.Helper()
	t.Cleanup(func() {
		if tenantSlug == "" {
			return
		}
		url := cfg.APIBase + "/api/internal/tenants/" + tenantSlug
		req, err := http.NewRequest(http.MethodDelete, url, nil)
		if err != nil {
			LogOrFatal(t, "cleanup: build request: %v", err)
			return
		}
		// POSTWAVE_INTERNAL_API_TOKEN, when set, lets us hit the
		// admin route in production-shaped configs. The dev stack
		// ignores the bearer when AllowDevTenantSlugHeader is on.
		if tok := strings.TrimSpace(os.Getenv("POSTWAVE_INTERNAL_API_TOKEN")); tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := cfg.HTTPClient.Do(req)
		if err != nil {
			LogOrFatal(t, "cleanup: do request: %v", err)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			LogOrFatal(t, "cleanup: tenant=%s status=%d body=%s", tenantSlug, resp.StatusCode, truncBody(body))
		}
	})
}

func truncBody(b []byte) string {
	s := string(b)
	if len(s) > 512 {
		return s[:512] + "...(truncated)"
	}
	return s
}

// ProvisionTenant creates a fresh workspace through the public signup route
// and then configures cfg.TenantSlug for protected-route journeys. The dev
// stack accepts X-Tenant-Slug + X-Postwave-Role after signup has inserted the
// tenant row, which keeps E2E tests isolated without sharing the seeded demo
// workspace.
func ProvisionTenant(t *testing.T, cfg *Config, prefix string) string {
	t.Helper()
	tenantSlug := NewTenantSlug(prefix)
	prevSlug := cfg.TenantSlug
	cfg.TenantSlug = ""
	status, body, err := JSONRequest(cfg, http.MethodPost, "/api/v1/auth/signup", map[string]string{
		"email":          fmt.Sprintf("e2e+%s@example.com", tenantSlug),
		"password":       "P@ssword123!",
		"workspace_name": "E2E " + tenantSlug,
		"workspace_slug": tenantSlug,
	})
	cfg.TenantSlug = tenantSlug
	if err != nil {
		cfg.TenantSlug = prevSlug
		SkipOrFatal(t, "skipping: could not provision isolated tenant %s: %v", tenantSlug, err)
	}
	if status != http.StatusCreated && status != http.StatusConflict {
		cfg.TenantSlug = prevSlug
		SkipOrFatal(t, "skipping: could not provision isolated tenant %s: status=%d body=%s", tenantSlug, status, shortBody(body))
	}
	CleanupTenant(t, cfg, tenantSlug)
	return tenantSlug
}

func shortBody(b []byte) string {
	s := string(b)
	if len(s) > 512 {
		return s[:512] + "...(truncated)"
	}
	return s
}

// AssertOK fails the test with the body in the message when the actual
// status is not 200. The body is truncated to 1 KiB so the failure
// stays readable in CI logs.
func AssertOK(t *testing.T, status int, body []byte, action string) {
	t.Helper()
	if status == http.StatusOK {
		return
	}
	snippet := string(body)
	if len(snippet) > 1024 {
		snippet = snippet[:1024] + "...(truncated)"
	}
	t.Fatalf("%s: status=%d body=%s", action, status, snippet)
}

// AssertStatus is the generalized version of AssertOK for journeys
// that expect a specific non-200 status (201 Created, 202 Accepted,
// 204 No Content, etc.).
func AssertStatus(t *testing.T, want, got int, body []byte, action string) {
	t.Helper()
	if want == got {
		return
	}
	snippet := string(body)
	if len(snippet) > 1024 {
		snippet = snippet[:1024] + "...(truncated)"
	}
	t.Fatalf("%s: want status=%d got=%d body=%s", action, want, got, snippet)
}

// WaitForCondition polls `check` every 250ms until it returns true or
// `timeout` elapses. Returns nil on success, an error containing the
// last false reason otherwise. Used by the migration journey to wait
// for an async job to settle.
func WaitForCondition(t *testing.T, timeout time.Duration, label string, check func() (bool, string)) error {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		ok, reason := check()
		if ok {
			return nil
		}
		last = reason
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("WaitForCondition timed out after %s: %s — last=%s", timeout, label, last)
}

// JSONRequestRaw is a low-level variant of JSONRequest that lets the
// caller pass a raw byte slice as the body and override request
// headers. Used by journeys that need to send pre-marshalled payloads
// or by the cleanup helpers that don't have a typed body shape.
func JSONRequestRaw(cfg *Config, method, path string, body []byte, extraHeaders map[string]string) (status int, respBody []byte, err error) {
	url := cfg.APIBase + path
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cfg.TenantSlug != "" {
		req.Header.Set("X-Tenant-Slug", cfg.TenantSlug)
		req.Header.Set("X-Postwave-Tenant", cfg.TenantSlug)
	}
	if cfg.AdminRole != "" {
		req.Header.Set("X-Postwave-Role", cfg.AdminRole)
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	resp, err := cfg.HTTPClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	respBody, err = io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, respBody, nil
}

// SkipIfNoStack runs WaitForStack with a short deadline. Ad-hoc dev runs skip
// when Docker is absent; strict release runs fail because Docker readiness is a
// release precondition.
func SkipIfNoStack(t *testing.T, cfg *Config) {
	t.Helper()
	if !E2EEnabled() {
		SkipOrFatal(t, "skipping: POSTWAVE_E2E_RUN=1 was not set by the governed stack runner")
		return
	}
	timeout := 5 * time.Second
	if v := strings.TrimSpace(os.Getenv("POSTWAVE_E2E_STACK_WAIT")); v != "" {
		// Permit longer waits in CI where the stack boots cold. We
		// cap at 5 minutes to keep run times bounded.
		if d, err := time.ParseDuration(v); err == nil && d > 0 && d < 5*time.Minute {
			timeout = d
		}
	}
	if err := WaitForStack(cfg, timeout); err != nil {
		SkipOrFatal(t, "skipping: docker stack not reachable at %s (%v)", cfg.APIBase, err)
	}
}
