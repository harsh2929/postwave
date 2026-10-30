package sending

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakePostmark mounts a routed fake server.
func fakePostmark(t *testing.T) (*PostmarkClient, *httptest.Server) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/servers", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(Server{ID: 7, APITokens: []string{"sek-token"}})
	})
	mux.HandleFunc("/servers/7", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/servers/7/message-streams", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(MessageStream{ID: "broadcasts", ServerID: 7})
	})
	mux.HandleFunc("/dedicated-ips", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(DedicatedIP{IP: "9.9.9.9", ServerID: 7, Status: "Provisioning"})
	})
	srv := httptest.NewServer(mux)
	return NewPostmarkClient(PostmarkConfig{BaseURL: srv.URL, AccountToken: "tok"}), srv
}

func TestProvisionTenant_Sending(t *testing.T) {
	pc, srv := fakePostmark(t)
	defer srv.Close()

	repo := NewMemoryStateRepo()
	wt := NewMemoryWarmupTracker()
	p := &Provisioner{
		Postmark: pc, Repo: repo, Warmup: wt,
		DedicatedIP:    &DedicatedIPProvisioner{Postmark: pc},
		EncryptionKey:  bytes32(),
		DKIMRootDomain: "mail.postwave.io",
		DefaultRegion:  "us-east-1",
	}

	st, err := p.provisionTenantUnlocked(context.Background(), Tenant{
		ID: "tnt-1", Slug: "acme", Name: "Acme", Tier: "sending",
	})
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if st.PostmarkServerID != "7" || !strings.HasPrefix(st.DKIMDomain, "acme.") {
		t.Fatalf("bad state: %+v", st)
	}
	if st.DedicatedIP != "" {
		t.Fatalf("sending tier should not have dedicated IP, got %q", st.DedicatedIP)
	}

	// Verify token was encrypted + can be decrypted back.
	_, ct, _ := repo.Get(context.Background(), "tnt-1")
	tok, err := DecryptToken(bytes32(), ct)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if tok != "sek-token" {
		t.Fatalf("bad token roundtrip: %q", tok)
	}
}

func TestProvisionTenant_Pro(t *testing.T) {
	pc, srv := fakePostmark(t)
	defer srv.Close()

	repo := NewMemoryStateRepo()
	wt := NewMemoryWarmupTracker()
	p := &Provisioner{
		Postmark: pc, Repo: repo, Warmup: wt,
		DedicatedIP:    &DedicatedIPProvisioner{Postmark: pc},
		EncryptionKey:  bytes32(),
		DKIMRootDomain: "mail.postwave.io",
		DefaultRegion:  "us-east-1",
	}

	st, err := p.provisionTenantUnlocked(context.Background(), Tenant{
		ID: "tnt-2", Slug: "acme-pro", Tier: "pro",
	})
	if err != nil {
		t.Fatalf("provision pro: %v", err)
	}
	if st.DedicatedIP != "9.9.9.9" || st.WarmupDay != 1 {
		t.Fatalf("pro state wrong: %+v", st)
	}
	// Warmup tracker should know about the tenant.
	ws, _ := wt.Get(context.Background(), "tnt-2")
	if ws == nil || ws.WarmupDay != 1 {
		t.Fatalf("warmup not started: %+v", ws)
	}
}

func TestStrategyForTier(t *testing.T) {
	if StrategyForTier("pro") != PoolDedicated {
		t.Fatal("pro should be dedicated")
	}
	if StrategyForTier("sending") != PoolShared {
		t.Fatal("sending should be shared")
	}
}

func TestProvisionTenantReleaseHoldPrecedesEveryEffect(t *testing.T) {
	var providerCalls atomic.Int32
	pc, srv := newTestPostmark(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerCalls.Add(1)
		http.Error(w, "provider must remain unreachable", http.StatusInternalServerError)
	}))
	defer srv.Close()

	for _, tier := range []string{"sending", "pro"} {
		t.Run(tier, func(t *testing.T) {
			repo := NewMemoryStateRepo()
			p := &Provisioner{
				Postmark: pc, Repo: repo,
				DedicatedIP: &DedicatedIPProvisioner{Postmark: pc},
			}
			state, err := p.ProvisionTenant(context.Background(), Tenant{
				ID: "held-" + tier, Slug: "held", Tier: tier,
			})
			if !errors.Is(err, ErrManagedPostmarkProvisioningHeld) {
				t.Fatalf("error = %v, want release hold", err)
			}
			if state != nil {
				t.Fatalf("release-held provisioning returned success-shaped state: %+v", state)
			}
			persisted, token, repoErr := repo.Get(context.Background(), "held-"+tier)
			if repoErr != nil || persisted != nil || token != nil {
				t.Fatalf("release hold mutated repository: state=%+v token=%x err=%v", persisted, token, repoErr)
			}
		})
	}
	if got := providerCalls.Load(); got != 0 {
		t.Fatalf("release-held provisioning made %d provider call(s), want zero", got)
	}
}

func TestDeprovisionTenant(t *testing.T) {
	repo := NewMemoryStateRepo()
	repo.rows["t1"] = &State{TenantID: "t1", Tier: "sending", PostmarkServerID: "7", PostmarkStreamID: "broadcasts"}
	p := &Provisioner{Repo: repo}
	if err := p.DeprovisionTenant(context.Background(), "t1"); err != nil {
		t.Fatal(err)
	}
	if _, _, _ = repo.Get(context.Background(), "t1"); repo.rows["t1"] != nil {
		t.Fatalf("row not deleted")
	}
	if len(repo.jobs) != 1 {
		t.Fatalf("deprovision job not scheduled: %+v", repo.jobs)
	}
}

func TestRunDueDeprovisionJobs(t *testing.T) {
	pc, srv := fakePostmark(t)
	defer srv.Close()
	repo := NewMemoryStateRepo()
	repo.jobs["t1:7"] = DeprovisionJob{
		ID: "t1:7", TenantID: "t1", PostmarkServerID: "7", ScheduledAt: time.Now().Add(-time.Minute),
	}
	p := &Provisioner{Repo: repo, Postmark: pc}
	done, err := p.RunDueDeprovisionJobs(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if done != 1 {
		t.Fatalf("done=%d want 1", done)
	}
	if len(repo.jobs) != 0 {
		t.Fatalf("job not cleared: %+v", repo.jobs)
	}
}

func bytes32() []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(i + 1)
	}
	return b
}

// countingPostmark wraps a real PostmarkClient + httptest server and
// counts how many times each endpoint is hit. Used to assert that a
// duplicate ProvisionTenant call does NOT make duplicate Postmark calls.
type countingPostmark struct {
	createServer int
	createStream int
	createDIP    int
	srv          *httptest.Server
	client       *PostmarkClient
}

func newCountingPostmark(t *testing.T) *countingPostmark {
	t.Helper()
	c := &countingPostmark{}
	mux := http.NewServeMux()
	mux.HandleFunc("/servers", func(w http.ResponseWriter, r *http.Request) {
		c.createServer++
		_ = json.NewEncoder(w).Encode(Server{ID: 7, APITokens: []string{"sek-token"}})
	})
	mux.HandleFunc("/servers/7/message-streams", func(w http.ResponseWriter, r *http.Request) {
		c.createStream++
		_ = json.NewEncoder(w).Encode(MessageStream{ID: "broadcasts", ServerID: 7})
	})
	mux.HandleFunc("/dedicated-ips", func(w http.ResponseWriter, r *http.Request) {
		c.createDIP++
		_ = json.NewEncoder(w).Encode(DedicatedIP{IP: "9.9.9.9", ServerID: 7, Status: "Provisioning"})
	})
	c.srv = httptest.NewServer(mux)
	c.client = NewPostmarkClient(PostmarkConfig{BaseURL: c.srv.URL, AccountToken: "tok"})
	return c
}

// TestProvisionTenant_IsIdempotentForExistingTenant locks the audit's
// money-leak fix: a second ProvisionTenant call for a tenant that already
// has sending_state must NOT create another Postmark server, message
// stream, or dedicated IP. Stripe redelivers webhooks freely; without
// this guard, every redelivery rented an extra dedicated IP on Pro tier.
func TestProvisionTenant_IsIdempotentForExistingTenant(t *testing.T) {
	cp := newCountingPostmark(t)
	defer cp.srv.Close()

	repo := NewMemoryStateRepo()
	wt := NewMemoryWarmupTracker()
	p := &Provisioner{
		Postmark: cp.client, Repo: repo, Warmup: wt,
		DedicatedIP:    &DedicatedIPProvisioner{Postmark: cp.client},
		EncryptionKey:  bytes32(),
		DKIMRootDomain: "mail.postwave.io",
		DefaultRegion:  "us-east-1",
	}

	// First call provisions Pro tier (server + stream + dedicated IP).
	if _, err := p.provisionTenantUnlocked(context.Background(), Tenant{
		ID: "tnt-redeliver", Slug: "acme-redeliver", Tier: "pro",
	}); err != nil {
		t.Fatalf("first provision: %v", err)
	}

	// Snapshot counts after the first successful call.
	firstServer, firstStream, firstDIP := cp.createServer, cp.createStream, cp.createDIP

	// Simulate a Stripe redelivery — same Tenant struct, same tier.
	state, err := p.provisionTenantUnlocked(context.Background(), Tenant{
		ID: "tnt-redeliver", Slug: "acme-redeliver", Tier: "pro",
	})
	if err != nil {
		t.Fatalf("redelivery provision: %v", err)
	}
	if state == nil || state.PostmarkServerID == "" {
		t.Fatalf("redelivery should return existing state, got %+v", state)
	}

	if cp.createServer != firstServer {
		t.Errorf("CreateServer hit %d times, want %d (Stripe redelivery created a duplicate Postmark server)",
			cp.createServer, firstServer)
	}
	if cp.createStream != firstStream {
		t.Errorf("CreateMessageStream hit %d times, want %d", cp.createStream, firstStream)
	}
	if cp.createDIP != firstDIP {
		t.Errorf("ProvisionDedicatedIP hit %d times, want %d (Pro-tier redelivery rented a SECOND dedicated IP)",
			cp.createDIP, firstDIP)
	}
}

// erroringStateRepo always returns the configured err on Get, so we can
// drive the "DB error during idempotency lookup" path without a real DB.
type erroringStateRepo struct {
	getErr error
}

func (e *erroringStateRepo) Get(_ context.Context, _ string) (*State, []byte, error) {
	return nil, nil, e.getErr
}

func (e *erroringStateRepo) Upsert(_ context.Context, _ *State, _ []byte) error {
	return nil
}

func (e *erroringStateRepo) Delete(_ context.Context, _ string) error {
	return nil
}

// TestProvisionTenant_FailsLoudOnRepoGetError locks in the regression-
// review fix: the idempotency guard MUST NOT fall through to creating
// new Postmark resources when Repo.Get returns a real error. A transient
// DB blip during a Stripe webhook redelivery would otherwise rent a
// duplicate dedicated IP every retry until the DB recovered.
func TestProvisionTenant_FailsLoudOnRepoGetError(t *testing.T) {
	cp := newCountingPostmark(t)
	defer cp.srv.Close()

	repo := &erroringStateRepo{
		getErr: errors.New("connection refused: postgres unavailable"),
	}
	p := &Provisioner{
		Postmark: cp.client, Repo: repo, Warmup: NewMemoryWarmupTracker(),
		DedicatedIP:    &DedicatedIPProvisioner{Postmark: cp.client},
		EncryptionKey:  bytes32(),
		DKIMRootDomain: "mail.postwave.io",
		DefaultRegion:  "us-east-1",
	}

	state, err := p.provisionTenantUnlocked(context.Background(), Tenant{
		ID: "tnt-db-error", Slug: "acme-db-error", Tier: "pro",
	})
	if err == nil {
		t.Fatalf("Provision should have failed loud on DB error; got state=%+v", state)
	}
	if !strings.Contains(err.Error(), "idempotency lookup") {
		t.Errorf("error should reference idempotency lookup, got: %v", err)
	}
	if cp.createServer != 0 || cp.createStream != 0 || cp.createDIP != 0 {
		t.Errorf("Postmark should NOT have been called when idempotency lookup failed; "+
			"createServer=%d createStream=%d createDIP=%d",
			cp.createServer, cp.createStream, cp.createDIP)
	}
}

// TestProvisionTenant_TierUpgradeReusesExistingServer verifies that
// upgrading an existing Sending tenant to Pro does NOT call CreateServer
// or CreateMessageStream again — it must reuse the existing Postmark
// server and only provision the Pro-tier additions (dedicated IP +
// warmup). The previous version of this test asserted the OPPOSITE
// (that upgrade re-creates the server) — but that was the bug: every
// upgrade leaked a Postmark server and (on Pro) double-rented an IP.
func TestProvisionTenant_TierUpgradeReusesExistingServer(t *testing.T) {
	cp := newCountingPostmark(t)
	defer cp.srv.Close()

	repo := NewMemoryStateRepo()
	// Pre-seed an existing Sending row with a real server id.
	_ = repo.Upsert(context.Background(), &State{
		TenantID:         "tnt-upgrade",
		Tier:             "sending",
		PostmarkServerID: "7",
		PostmarkStreamID: "broadcasts",
		DKIMDomain:       "acme-upgrade.mail.postwave.io",
	}, nil)

	wt := NewMemoryWarmupTracker()
	p := &Provisioner{
		Postmark: cp.client, Repo: repo, Warmup: wt,
		DedicatedIP:    &DedicatedIPProvisioner{Postmark: cp.client},
		EncryptionKey:  bytes32(),
		DKIMRootDomain: "mail.postwave.io",
		DefaultRegion:  "us-east-1",
	}

	st, err := p.provisionTenantUnlocked(context.Background(), Tenant{
		ID: "tnt-upgrade", Slug: "acme-upgrade", Tier: "pro",
	})
	if err != nil {
		t.Fatalf("upgrade provision: %v", err)
	}

	// The existing server MUST be preserved — no new CreateServer call.
	if cp.createServer != 0 {
		t.Errorf("CreateServer was called %d times during tier upgrade; expected 0 — the existing server should be reused",
			cp.createServer)
	}
	if cp.createStream != 0 {
		t.Errorf("CreateMessageStream was called %d times during tier upgrade; expected 0", cp.createStream)
	}
	// Pro-tier additions SHOULD have been provisioned.
	if cp.createDIP != 1 {
		t.Errorf("ProvisionDedicatedIP was called %d times during Sending→Pro upgrade; expected 1", cp.createDIP)
	}
	if st.PostmarkServerID != "7" {
		t.Errorf("upgraded state PostmarkServerID = %q, want preserved %q", st.PostmarkServerID, "7")
	}
	if st.Tier != "pro" {
		t.Errorf("upgraded tier = %q, want pro", st.Tier)
	}
	if st.DedicatedIP == "" {
		t.Errorf("upgraded state should have a DedicatedIP; got empty")
	}
	// Warmup tracker should have been started for the new dedicated IP.
	if ws, _ := wt.Get(context.Background(), "tnt-upgrade"); ws == nil || ws.WarmupDay != 1 {
		t.Errorf("warmup tracker not started on upgrade; got %+v", ws)
	}
}

// TestProvisionTenant_LegacyEmptyTierIsTreatedAsAlreadyProvisioned locks
// in the regression fix for the catalog finding: pre-migration-0026 rows
// have State.Tier == "" because the column didn't exist when they were
// written. The idempotency guard MUST treat such rows as "already
// provisioned" and NOT fall through to create a duplicate Postmark
// server. Real money was leaking on every Stripe redelivery for legacy
// tenants until this fix.
func TestProvisionTenant_LegacyEmptyTierIsTreatedAsAlreadyProvisioned(t *testing.T) {
	cp := newCountingPostmark(t)
	defer cp.srv.Close()

	repo := NewMemoryStateRepo()
	// Pre-seed a legacy row with empty tier (pre-migration-0026).
	_ = repo.Upsert(context.Background(), &State{
		TenantID:         "tnt-legacy",
		Tier:             "", // legacy: tier column didn't exist
		PostmarkServerID: "42",
	}, nil)

	p := &Provisioner{
		Postmark: cp.client, Repo: repo, Warmup: NewMemoryWarmupTracker(),
		DedicatedIP:    &DedicatedIPProvisioner{Postmark: cp.client},
		EncryptionKey:  bytes32(),
		DKIMRootDomain: "mail.postwave.io",
		DefaultRegion:  "us-east-1",
	}

	st, err := p.provisionTenantUnlocked(context.Background(), Tenant{
		ID: "tnt-legacy", Slug: "acme-legacy", Tier: "sending",
	})
	if err != nil {
		t.Fatalf("provision legacy tenant: %v", err)
	}
	if cp.createServer != 0 {
		t.Errorf("CreateServer was called %d times for legacy tenant; expected 0 — empty-tier row must short-circuit",
			cp.createServer)
	}
	if st.PostmarkServerID != "42" {
		t.Errorf("PostmarkServerID = %q, want preserved %q", st.PostmarkServerID, "42")
	}
}
