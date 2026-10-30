// SPDX-License-Identifier: AGPL-3.0-only

package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestAuditPortalLifecycleAndTenantIsolation_DB is the B-16 acceptance test.
// It deliberately requires a fully migrated database reached as the
// non-superuser, non-BYPASSRLS postwave_app role. The test covers the public
// HTTP contract and the durable authorization state together rather than
// mocking the replay store.
func TestAuditPortalLifecycleAndTenantIsolation_DB(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a fully migrated database using the unprivileged postwave_app role")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, poolErr := pgxpool.New(ctx, dsn)
	if poolErr != nil {
		t.Fatalf("connect: %v", poolErr)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}

	var (
		role              string
		superuser, bypass bool
	)
	if err := pool.QueryRow(ctx, `
SELECT current_user, r.rolsuper, r.rolbypassrls
  FROM pg_roles r
 WHERE r.rolname = current_user`).Scan(&role, &superuser, &bypass); err != nil {
		t.Fatalf("inspect DB role: %v", err)
	}
	if role != "postwave_app" || superuser || bypass {
		t.Fatalf("integration test must exercise postwave_app without RLS bypass; role=%q super=%v bypass=%v", role, superuser, bypass)
	}

	tenantA := testPortalUUID(t)
	tenantB := testPortalUUID(t)
	insertPortalTenantFixture(t, ctx, pool, tenantA, "a")
	insertPortalTenantFixture(t, ctx, pool, tenantB, "b")
	h := &AuditPortalHandlers{
		Pool:           pool,
		HMACSecret:     []byte("b16-integration-secret-is-at-least-thirty-two-bytes"),
		PortalOrigin:   "https://portal.example",
		FrameAncestors: "https://customer.example",
	}

	minted := mintPortalViaHTTP(t, h, tenantA)
	parsedURL, poolErr := url.Parse(minted.PortalURL)
	if poolErr != nil {
		t.Fatalf("parse portal URL: %v", poolErr)
	}
	if parsedURL.Path != "/portal/audit" || parsedURL.RawQuery != "" {
		t.Fatalf("credential reached an HTTP-visible URL component: %s", minted.PortalURL)
	}
	bootstrap, poolErr := url.ParseQuery(parsedURL.Fragment)
	if poolErr != nil || bootstrap.Get("bootstrap") == "" {
		t.Fatalf("portal URL lacks fragment bootstrap: %s (%v)", minted.PortalURL, poolErr)
	}
	rawBootstrap := bootstrap.Get("bootstrap")

	// Two simultaneous exchanges race the same row. Exactly one succeeds;
	// the losing request gets the deliberately non-oracular 401 response.
	type exchangeResult struct {
		status int
		cookie *http.Cookie
		body   string
	}
	results := make(chan exchangeResult, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "https://portal.example/api/v1/audit/portal/exchange", strings.NewReader(`{"bootstrap":`+strconvQuote(rawBootstrap)+`}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "https://portal.example")
			rr := httptest.NewRecorder()
			h.Exchange(rr, req)
			var cookie *http.Cookie
			for _, candidate := range rr.Result().Cookies() {
				if candidate.Name == portalCookieName {
					cookie = candidate
				}
			}
			results <- exchangeResult{status: rr.Code, cookie: cookie, body: rr.Body.String()}
		}()
	}
	wg.Wait()
	close(results)
	var sessionCookie *http.Cookie
	statusCounts := map[int]int{}
	for result := range results {
		statusCounts[result.status]++
		if strings.Contains(result.body, rawBootstrap) {
			t.Fatal("exchange response reflected the bootstrap credential")
		}
		if result.status == http.StatusNoContent {
			sessionCookie = result.cookie
		}
	}
	if statusCounts[http.StatusNoContent] != 1 || statusCounts[http.StatusUnauthorized] != 1 || sessionCookie == nil {
		t.Fatalf("one-time exchange results=%v cookie=%v", statusCounts, sessionCookie != nil)
	}
	if sessionCookie.Value == rawBootstrap {
		t.Fatal("bootstrap bearer was reused as the browser cookie")
	}

	// A valid, durably exchanged cookie reaches the release-held evidence
	// boundary, but neither raw events nor proof bundles are exposed. The
	// handler has no datastore dependency, so this also prevents field-level
	// evidence from escaping while the external-auditor projection is reviewed.
	browse := h.RequirePortalSession(http.HandlerFunc(h.EvidenceReleaseHold))
	assertPortalEvidenceReleaseHeld(t, browse, sessionCookie, "/api/v1/audit/portal/events?action=b16.portal")
	assertPortalEvidenceReleaseHeld(t, browse, sessionCookie, "/api/v1/audit/portal/ai-session/b16.portal/aivs-bundle")

	// Disabled branding never exposes draft values. Even when branding is
	// enabled, the audit endpoint does not return an operator-supplied logo URL;
	// doing so would make an auditor's browser contact an arbitrary origin.
	setPortalBrandingFixture(t, ctx, pool, tenantA, false,
		"Secret Draft Brand", "https://tracker.example/pixel.svg", "#000000", "private@example.com")
	assertPortalBranding(t, h, sessionCookie, "Audit Portal", "#1d4ed8", "")
	setPortalBrandingFixture(t, ctx, pool, tenantA, true,
		"Customer Audit", "https://tracker.example/pixel.svg", "#1D4ED8", "audit@customer.example")
	assertPortalBranding(t, h, sessionCookie, "Customer Audit", "#1D4ED8", "audit@customer.example")

	// The admin session inventory is scoped too: A cannot enumerate a session
	// minted for B, even though both use the same runtime connection pool.
	_ = mintPortalViaHTTP(t, h, tenantB)
	listReq := httptest.NewRequest(http.MethodGet, "https://api.example/api/v1/audit/portal/sessions", nil)
	listReq = listReq.WithContext(middleware.WithTenant(listReq.Context(), &middleware.Tenant{ID: tenantA}))
	listRR := httptest.NewRecorder()
	h.ListSessions(listRR, listReq)
	if listRR.Code != http.StatusOK {
		t.Fatalf("list sessions status=%d body=%s", listRR.Code, listRR.Body.String())
	}
	var listed struct {
		Sessions []struct {
			ID string `json:"id"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(listRR.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listed.Sessions) != 1 || listed.Sessions[0].ID != minted.SessionID {
		t.Fatalf("cross-tenant session inventory leak: %#v", listed.Sessions)
	}

	// Revoking A's session while scoped as B is a no-op. Correct-tenant
	// revocation takes effect on the very next cookie validation.
	revokePortalViaHTTP(t, h, tenantB, minted.SessionID)
	assertPortalEvidenceReleaseHeld(t, browse, sessionCookie, "/api/v1/audit/portal/events")
	revokePortalViaHTTP(t, h, tenantA, minted.SessionID)
	req := httptest.NewRequest(http.MethodGet, "https://portal.example/api/v1/audit/portal/events", nil)
	req.AddCookie(sessionCookie)
	rr := httptest.NewRecorder()
	browse.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("revoked cookie status=%d body=%s", rr.Code, rr.Body.String())
	}

	// Expiry is checked against durable state on every browse, not just the
	// JWT timestamp. This also proves immediate invalidation without waiting.
	expiring := mintPortalViaHTTP(t, h, tenantA)
	expURL, _ := url.Parse(expiring.PortalURL)
	expBootstrap, _ := url.ParseQuery(expURL.Fragment)
	expCookie := exchangePortalViaHTTP(t, h, expBootstrap.Get("bootstrap"))
	tx, poolErr := db.WithTenant(ctx, pool, tenantA)
	if poolErr != nil {
		t.Fatalf("scope expiry update: %v", poolErr)
	}
	if _, err := tx.Exec(ctx, `UPDATE audit_portal_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`, expiring.SessionID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("expire session: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit expiry: %v", err)
	}
	if _, err := audit.ValidatePortalCookie(ctx, h.deps(nil), expCookie.Value); !errors.Is(err, audit.ErrSessionRevoked) {
		t.Fatalf("expected durable expiry rejection, got %v", err)
	}
}

type mintedPortalView struct {
	SessionID string    `json:"session_id"`
	PortalURL string    `json:"portal_url"`
	ExpiresAt time.Time `json:"expires_at"`
}

func mintPortalViaHTTP(t *testing.T, h *AuditPortalHandlers, tenantID string) mintedPortalView {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "https://api.example/api/v1/audit/portal/sessions", strings.NewReader(`{"ttl_seconds":300}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rr := httptest.NewRecorder()
	h.CreateSession(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("mint status=%d body=%s", rr.Code, rr.Body.String())
	}
	var out mintedPortalView
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil || out.SessionID == "" || out.PortalURL == "" {
		t.Fatalf("decode mint: out=%#v err=%v", out, err)
	}
	return out
}

func exchangePortalViaHTTP(t *testing.T, h *AuditPortalHandlers, bootstrap string) *http.Cookie {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "https://portal.example/api/v1/audit/portal/exchange", strings.NewReader(`{"bootstrap":`+strconvQuote(bootstrap)+`}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://portal.example")
	rr := httptest.NewRecorder()
	h.Exchange(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("exchange status=%d body=%s", rr.Code, rr.Body.String())
	}
	for _, cookie := range rr.Result().Cookies() {
		if cookie.Name == portalCookieName {
			return cookie
		}
	}
	t.Fatal("exchange omitted portal cookie")
	return nil
}

func assertPortalEvidenceReleaseHeld(t *testing.T, browse http.Handler, cookie *http.Cookie, path string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "https://portal.example"+path, nil)
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	browse.ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("browse status=%d body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-store, private, max-age=0" {
		t.Fatalf("browse Cache-Control=%q", got)
	}
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode browse: %v", err)
	}
	if out.Error.Code != "service_unavailable" {
		t.Fatalf("unexpected browse response: %s", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "b16.portal") || strings.Contains(rr.Body.String(), `"rows"`) || strings.Contains(rr.Body.String(), `"bundle"`) {
		t.Fatalf("release hold returned evidence: %s", rr.Body.String())
	}
}

func assertPortalBranding(
	t *testing.T,
	h *AuditPortalHandlers,
	cookie *http.Cookie,
	wantBrand, wantColor, wantSupport string,
) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "https://portal.example/api/v1/audit/portal/branding", nil)
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	h.RequirePortalSession(http.HandlerFunc(h.Branding)).ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("branding status=%d body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-store, private, max-age=0" {
		t.Fatalf("branding Cache-Control=%q", got)
	}
	if got := rr.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("branding Referrer-Policy=%q", got)
	}
	var out struct {
		BrandName    string `json:"brand_name"`
		LogoURL      string `json:"logo_url"`
		PrimaryColor string `json:"primary_color"`
		SupportEmail string `json:"support_email"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode branding: %v", err)
	}
	if out.BrandName != wantBrand || out.LogoURL != "" ||
		out.PrimaryColor != wantColor || out.SupportEmail != wantSupport {
		t.Fatalf("branding projection=%+v", out)
	}
	if strings.Contains(rr.Body.String(), "tracker.example") {
		t.Fatalf("branding leaked external logo origin: %s", rr.Body.String())
	}
}

func revokePortalViaHTTP(t *testing.T, h *AuditPortalHandlers, tenantID, sessionID string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "https://api.example/api/v1/audit/portal/sessions/"+sessionID, nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", sessionID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	req = req.WithContext(ctx)
	rr := httptest.NewRecorder()
	h.RevokeSession(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("revoke status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func insertPortalAuditFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID, action string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("scope audit fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := db.Audit(ctx, tx, db.AuditMeta{TenantID: tenantID, ActorType: "system"}, action, "b16_test", tenantID, map[string]any{"safe": true}); err != nil {
		t.Fatalf("insert audit fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit audit fixture: %v", err)
	}
}

func insertPortalTenantFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID, suffix string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("scope tenant fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	slug := "b16-portal-" + suffix + "-" + strings.ReplaceAll(tenantID, "-", "")
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $3, 'studio')`, tenantID, slug, "B16 portal tenant "+suffix); err != nil {
		t.Fatalf("insert tenant fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant fixture: %v", err)
	}
}

func setPortalBrandingFixture(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	enabled bool,
	brandName, logoURL, primaryColor, supportEmail string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("scope branding fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE tenants
   SET whitelabel_enabled = $2,
       whitelabel_brand_name = $3,
       whitelabel_logo_url = $4,
       whitelabel_primary_color = $5,
       whitelabel_support_email = $6
 WHERE id = $1::uuid`, tenantID, enabled, brandName, logoURL, primaryColor, supportEmail); err != nil {
		t.Fatalf("update branding fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit branding fixture: %v", err)
	}
}

func testPortalUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("random UUID: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func strconvQuote(v string) string {
	b, _ := json.Marshal(v)
	return string(b)
}
