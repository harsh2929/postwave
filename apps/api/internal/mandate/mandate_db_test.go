// SPDX-License-Identifier: AGPL-3.0-only

package mandate

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/middleware"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A mandate must BOUND an agent, not merely describe it.
//
// The surface it replaces is a full tenant API key: every tool the scope
// allows, every resource in the tenant, for the life of the key. Each test here
// is one of the four bounds — action, resource, budget, time — plus the
// property that makes them real: the check and the spend are one statement.

func mandatePool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping mandate test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedMandateTenant(t *testing.T, pool *db.Pool) (tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	tenantID, userID = uuid.NewString(), uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'mnd', 'studio')`,
		tenantID, "mnd-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM agent_mandates WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID, userID
}

func goodGrant() Grant {
	return Grant{
		Purpose:   "Clean up bounced subscribers on the Spring list",
		Actions:   []string{"subscribers.suppress"},
		Resources: []string{"list:42"},
		Uses:      3,
		TTL:       time.Hour,
	}
}

func TestAMandateAuthorisesOnlyWhatItNames(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	m, err := repo.Mint(ctx, tenantID, userID, goodGrant())
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	got, err := repo.Authorise(ctx, m.Token, "subscribers.suppress", "list:42")
	if err != nil {
		t.Fatalf("the granted action on the granted resource was denied: %v", err)
	}
	if got.TenantID != tenantID || got.GrantedBy != userID {
		t.Fatalf("authorised as %+v", got)
	}
	if got.Purpose == "" {
		t.Error("no purpose returned; an audit cannot say what the authority was for")
	}

	for _, tc := range []struct{ name, action, resource string }{
		{"an action not granted", "subscribers.delete", "list:42"},
		{"a resource not granted", "subscribers.suppress", "list:99"},
		{"a near-miss resource id", "subscribers.suppress", "list:420"},
		{"a different resource kind", "subscribers.suppress", "campaign:42"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := repo.Authorise(ctx, m.Token, tc.action, tc.resource); err == nil {
				t.Fatalf("%s/%s was authorised; the agent holds more than it was given",
					tc.action, tc.resource)
			}
		})
	}
}

// `list:*` grants the kind. `list:4` must never grant `list:42` — a prefix match
// is the near-miss nobody notices in review.
func TestAWildcardGrantsAKindAndAPrefixDoesNot(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	g := goodGrant()
	g.Resources = []string{"list:*"}
	g.Uses = 5
	wide, err := repo.Mint(ctx, tenantID, userID, g)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	for _, res := range []string{"list:1", "list:999"} {
		if _, err := repo.Authorise(ctx, wide.Token, "subscribers.suppress", res); err != nil {
			t.Errorf("a kind-wide mandate denied %s: %v", res, err)
		}
	}
	if _, err := repo.Authorise(ctx, wide.Token, "subscribers.suppress", "campaign:1"); err == nil {
		t.Fatal("a list mandate authorised a campaign")
	}

	g.Resources = []string{"list:4"}
	narrow, err := repo.Mint(ctx, tenantID, userID, g)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := repo.Authorise(ctx, narrow.Token, "subscribers.suppress", "list:42"); err == nil {
		t.Fatal("a mandate for list:4 authorised list:42. A prefix match here is " +
			"how an agent scoped to one list reaches another.")
	}
}

// The budget is what bounds blast radius. Time alone does not: an agent with a
// five-minute window can still delete everything inside it.
func TestTheBudgetIsSpentAndThenRefuses(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	m, err := repo.Mint(ctx, tenantID, userID, goodGrant()) // Uses: 3
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	for i := 0; i < 3; i++ {
		got, err := repo.Authorise(ctx, m.Token, "subscribers.suppress", "list:42")
		if err != nil {
			t.Fatalf("use %d denied: %v", i+1, err)
		}
		if want := 2 - i; got.UsesRemaining != want {
			t.Errorf("after use %d, remaining = %d, want %d", i+1, got.UsesRemaining, want)
		}
	}
	if _, err := repo.Authorise(ctx, m.Token, "subscribers.suppress", "list:42"); err == nil {
		t.Fatal("the fourth call on a three-use mandate was authorised; the budget " +
			"is decorative")
	}
}

// The property that makes the budget a control rather than a report.
func TestParallelAgentsCannotOverspendTheBudget(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	g := goodGrant()
	g.Uses = 5
	m, err := repo.Mint(ctx, tenantID, userID, g)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	const racers = 20
	var wg sync.WaitGroup
	results := make([]error, racers)
	wg.Add(racers)
	for i := 0; i < racers; i++ {
		go func(i int) {
			defer wg.Done()
			_, results[i] = repo.Authorise(ctx, m.Token, "subscribers.suppress", "list:42")
		}(i)
	}
	wg.Wait()

	granted := 0
	for _, err := range results {
		if err == nil {
			granted++
		}
	}
	if granted != 5 {
		t.Fatalf("%d of %d parallel calls were authorised against a 5-use budget. "+
			"The check and the spend are not one statement, so two agents can both "+
			"spend the last use — and for a delete the second call is exactly the "+
			"one the budget existed to stop.", granted, racers)
	}
}

func TestAnExpiredOrRevokedMandateAuthorisesNothing(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	expired, err := repo.Mint(ctx, tenantID, userID, goodGrant())
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE agent_mandates SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1::uuid`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Authorise(ctx, expired.Token, "subscribers.suppress", "list:42"); err == nil {
		t.Fatal("an expired mandate still authorised")
	}

	live, err := repo.Mint(ctx, tenantID, userID, goodGrant())
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := repo.Authorise(ctx, live.Token, "subscribers.suppress", "list:42"); err != nil {
		t.Fatalf("a live mandate was denied: %v", err)
	}
	if err := repo.Revoke(ctx, tenantID, live.ID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, err := repo.Authorise(ctx, live.Token, "subscribers.suppress", "list:42"); err == nil {
		t.Fatal("a revoked mandate still authorised. Revocation is the control an " +
			"operator reaches for when an agent misbehaves.")
	}
}

// An unspecified grant authorises NOTHING. Reading empty as "all" would
// reproduce the full-tenant key this package replaces.
func TestAnUnspecifiedGrantIsRefusedAtMintTime(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	for _, tc := range []struct {
		name string
		g    Grant
	}{
		{"no actions", Grant{Purpose: "p", Resources: []string{"list:1"}, Uses: 1}},
		{"no resources", Grant{Purpose: "p", Actions: []string{"a"}, Uses: 1}},
		{"no purpose", Grant{Actions: []string{"a"}, Resources: []string{"list:1"}, Uses: 1}},
		{"no budget", Grant{Purpose: "p", Actions: []string{"a"}, Resources: []string{"list:1"}}},
		{"an absurd budget", Grant{Purpose: "p", Actions: []string{"a"}, Resources: []string{"list:1"}, Uses: MaxUses + 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := repo.Mint(ctx, tenantID, userID, tc.g); err == nil {
				t.Fatalf("minted a mandate with %s", tc.name)
			}
		})
	}
}

// A grant asking to outlive the day is capped, not honoured. A mandate that
// outlives its task is a standing key wearing a mandate's name.
func TestATooLongTTLIsCapped(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	g := goodGrant()
	g.TTL = 30 * 24 * time.Hour
	m, err := repo.Mint(ctx, tenantID, userID, g)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if m.ExpiresAt.After(time.Now().UTC().Add(MaxTTL + time.Minute)) {
		t.Fatalf("expires at %v, past the %v cap", m.ExpiresAt, MaxTTL)
	}
}

// Every refusal reads the same, so an agent cannot map the shape of a mandate
// it was not given.
func TestEveryRefusalIsIndistinguishable(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}
	m, err := repo.Mint(ctx, tenantID, userID, goodGrant())
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	// A mandate whose budget is fully spent, so the exhausted case is covered
	// too. It was not, and a mutation showed why that matters: the CHECK
	// constraint `uses_remaining >= 0` also stops an overspend, so removing the
	// WHERE guard still bounded the budget — but the refusal came back as a raw
	// constraint violation instead of ErrDenied, leaking database internals to
	// an agent and breaking exactly the property this test asserts.
	spent, err := repo.Mint(ctx, tenantID, userID, Grant{
		Purpose: "spend it", Actions: []string{"subscribers.suppress"},
		Resources: []string{"list:42"}, Uses: 1, TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := repo.Authorise(ctx, spent.Token, "subscribers.suppress", "list:42"); err != nil {
		t.Fatalf("the single granted use was denied: %v", err)
	}

	for _, tc := range []struct{ name, token, action, resource string }{
		{"unknown token", "not-a-token", "subscribers.suppress", "list:42"},
		{"action not granted", m.Token, "subscribers.delete", "list:42"},
		{"resource not granted", m.Token, "subscribers.suppress", "list:99"},
		{"budget exhausted", spent.Token, "subscribers.suppress", "list:42"},
	} {
		_, err := repo.Authorise(ctx, tc.token, tc.action, tc.resource)
		if err == nil {
			t.Fatalf("%s was authorised", tc.name)
		}
		if err.Error() != ErrDenied.Error() {
			t.Errorf("%s returned %q, not the single denial; an agent could map "+
				"which bound it hit", tc.name, err)
		}
	}
}

// The grant surface, driven through real handlers.
//
// A mandate that only tests can mint is a control nobody can use; the row is
// about an operator being able to bound an agent, and that needs a door.

func mandateRouter(repo *Repo) chi.Router {
	r := chi.NewRouter()
	(&Deps{Repo: repo}).MountRoutes(r)
	return r
}

func asPerson(req *http.Request, tenantID, userID string) *http.Request {
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: userID, TenantID: tenantID})
	return req.WithContext(ctx)
}

func TestAPersonCanGrantReviewAndWithdrawAMandate(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}
	router := mandateRouter(repo)

	// Grant.
	body, _ := json.Marshal(map[string]any{
		"purpose": "Clean up bounced subscribers on the Spring list",
		"actions": []string{"subscribers_suppress"}, "resources": []string{"tool:subscribers_suppress"},
		"uses": 3, "ttl_seconds": 3600,
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, asPerson(httptest.NewRequest(http.MethodPost, "/api/v1/agent-mandates", bytes.NewReader(body)), tenantID, userID))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: status %d, body %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID, Token, Notice string
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Token == "" || created.ID == "" {
		t.Fatal("no token or id returned; the operator has nothing to give the agent")
	}
	if created.Notice == "" {
		t.Error("no notice that the token is shown once; somebody closes the " +
			"dialog and mints a second mandate, leaving the first live")
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Error("the response carrying the only copy of a bearer token is cacheable")
	}

	// Review — and the token must NOT come back.
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, asPerson(httptest.NewRequest(http.MethodGet, "/api/v1/agent-mandates", nil), tenantID, userID))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: status %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), created.Token) {
		t.Fatal("the list returned the mandate TOKEN. Every reader of that page " +
			"could then act as the agent.")
	}
	if !strings.Contains(rec.Body.String(), "Clean up bounced subscribers") {
		t.Errorf("the list does not show the purpose, which is what makes a "+
			"mandate reviewable: %s", rec.Body.String())
	}

	// The mandate works...
	if _, err := repo.Authorise(ctx, created.Token, "subscribers_suppress", "tool:subscribers_suppress"); err != nil {
		t.Fatalf("the granted mandate did not authorise: %v", err)
	}
	// ...until it is withdrawn.
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, asPerson(httptest.NewRequest(http.MethodDelete, "/api/v1/agent-mandates/"+created.ID, nil), tenantID, userID))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke: status %d", rec.Code)
	}
	if _, err := repo.Authorise(ctx, created.Token, "subscribers_suppress", "tool:subscribers_suppress"); err == nil {
		t.Fatal("a withdrawn mandate still authorises; revocation is the control " +
			"an operator reaches for when an agent misbehaves")
	}
}

// An API key must not be able to mint. An agent that can grant itself authority
// is not bounded by it.
func TestAnApiKeyCannotGrantItselfAMandate(t *testing.T) {
	pool := mandatePool(t)
	tenantID, _ := seedMandateTenant(t, pool)
	router := mandateRouter(&Repo{Pool: pool})

	body, _ := json.Marshal(map[string]any{
		"purpose": "self-service", "actions": []string{"anything"},
		"resources": []string{"tool:anything"}, "uses": 100,
	})
	// Tenant on context but NO user — what an API-key request looks like.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent-mandates", bytes.NewReader(body))
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code == http.StatusCreated {
		t.Fatal("an API key minted a mandate. An agent could grant itself " +
			"authority, which makes the bound a formality.")
	}
}

// A malformed grant gets a REASON. The caller is a person filling in a form,
// and "not usable" with no explanation is a form they cannot fix — unlike a
// denial, where precision would help an attacker.
func TestAnInvalidGrantExplainsItself(t *testing.T) {
	pool := mandatePool(t)
	tenantID, userID := seedMandateTenant(t, pool)
	router := mandateRouter(&Repo{Pool: pool})

	body, _ := json.Marshal(map[string]any{"purpose": "", "uses": 0})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, asPerson(httptest.NewRequest(http.MethodPost, "/api/v1/agent-mandates", bytes.NewReader(body)), tenantID, userID))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "purpose") {
		t.Errorf("the refusal does not say what is missing: %s", rec.Body.String())
	}
}
