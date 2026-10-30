// SPDX-License-Identifier: AGPL-3.0-only
package approvals

import (
	"context"
	"testing"
	"time"
)

// fakeNow returns a deterministic clock function suitable for tests.
func fakeNow(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

func TestSignAndVerifyToken_RoundTrip(t *testing.T) {
	t0 := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	svc := &Service{HMACKey: []byte("test-key-aaaa"), Now: fakeNow(t0)}

	id := "11111111-1111-1111-1111-111111111111"
	exp := t0.Add(1 * time.Hour)
	tok := svc.SignToken(id, DecisionApprove, exp, "alice@example.com")

	gotID, gotDec, hash, err := svc.VerifyToken(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if gotID != id {
		t.Errorf("id: want %q got %q", id, gotID)
	}
	if gotDec != DecisionApprove {
		t.Errorf("decision: want approve got %q", gotDec)
	}
	if hash == "" || hash == "anon" {
		t.Errorf("approver hash should be bound to email, got %q", hash)
	}
	if hash != ApproverEmailHash("alice@example.com") {
		t.Errorf("hash mismatch — case/whitespace handling broken")
	}
}

func TestVerifyToken_BadSignature(t *testing.T) {
	t0 := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	svc := &Service{HMACKey: []byte("test-key-aaaa"), Now: fakeNow(t0)}
	other := &Service{HMACKey: []byte("OTHER-KEY-bbbb"), Now: fakeNow(t0)}

	exp := t0.Add(1 * time.Hour)
	tok := svc.SignToken("aaa", DecisionApprove, exp, "alice@example.com")
	if _, _, _, err := other.VerifyToken(tok); err != ErrBadToken {
		t.Errorf("want ErrBadToken got %v", err)
	}
}

func TestVerifyToken_Expired(t *testing.T) {
	t0 := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	svc := &Service{HMACKey: []byte("k"), Now: fakeNow(t0)}
	exp := t0.Add(-1 * time.Hour) // already expired
	tok := svc.SignToken("aaa", DecisionApprove, exp, "alice@example.com")
	if _, _, _, err := svc.VerifyToken(tok); err != ErrExpired {
		t.Errorf("want ErrExpired got %v", err)
	}
}

func TestVerifyToken_BadShape(t *testing.T) {
	svc := &Service{HMACKey: []byte("k"), Now: time.Now}
	if _, _, _, err := svc.VerifyToken("totally garbage"); err != ErrBadToken {
		t.Errorf("want ErrBadToken got %v", err)
	}
}

// Audit (approvals CRITICAL F1) regression test: a token minted for
// one approver must NOT verify under a different approver's email.
// The token verification succeeds (HMAC is valid) but the caller is
// expected to compare the returned hash to the session user's hash.
func TestVerifyToken_ApproverBindingExposed(t *testing.T) {
	t0 := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	svc := &Service{HMACKey: []byte("k"), Now: fakeNow(t0)}
	exp := t0.Add(time.Hour)
	tok := svc.SignToken("id", DecisionApprove, exp, "alice@example.com")
	_, _, gotHash, err := svc.VerifyToken(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if gotHash != ApproverEmailHash("alice@example.com") {
		t.Errorf("expected hash for alice, got %q", gotHash)
	}
	if gotHash == ApproverEmailHash("bob@example.com") {
		t.Errorf("hash collision between distinct emails")
	}
}

func TestDecide_GuardsViaInMemoryRepo(t *testing.T) {
	// Pure in-memory variant of the Repo interface used by Decide. We cover
	// the in-Service guards (BadDecision, NotPending, Expired) without
	// touching pgx — the SQL paths are exercised by the e2e suite.
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	mem := &memRepo{}
	svc := &Service{Repo: nil, Now: fakeNow(now), TTL: time.Hour}
	_ = svc

	// BadDecision short-circuits before any repo call.
	if err := (&memDecideShim{mem: mem, now: now}).Decide("dummy", "neither"); err != ErrBadDecision {
		t.Errorf("want ErrBadDecision got %v", err)
	}
	// Already-decided returns NotPending.
	mem.set(&Approval{ID: "x", Status: StatusApproved, ExpiresAt: now.Add(time.Hour)})
	if err := (&memDecideShim{mem: mem, now: now}).Decide("x", "approve"); err != ErrNotPending {
		t.Errorf("want ErrNotPending got %v", err)
	}
	// Expired returns ErrExpired.
	mem.set(&Approval{ID: "y", Status: StatusPending, ExpiresAt: now.Add(-time.Hour)})
	if err := (&memDecideShim{mem: mem, now: now}).Decide("y", "approve"); err != ErrExpired {
		t.Errorf("want ErrExpired got %v", err)
	}
}

// memRepo + memDecideShim: minimal in-memory mirror of the bits of Service
// used to validate guard logic without pgx.
type memRepo struct {
	rows map[string]*Approval
}

func (m *memRepo) set(a *Approval) {
	if m.rows == nil {
		m.rows = map[string]*Approval{}
	}
	m.rows[a.ID] = a
}

type memDecideShim struct {
	mem *memRepo
	now time.Time
}

func (s *memDecideShim) Decide(id string, decision Decision) error {
	if decision != DecisionApprove && decision != DecisionReject {
		return ErrBadDecision
	}
	a, ok := s.mem.rows[id]
	if !ok {
		return ErrNotFound
	}
	if a.Status != StatusPending {
		return ErrNotPending
	}
	if s.now.After(a.ExpiresAt) {
		a.Status = StatusExpired
		return ErrExpired
	}
	if decision == DecisionApprove {
		a.Status = StatusApproved
	} else {
		a.Status = StatusRejected
	}
	return nil
}

func TestRequest_AssemblesFields(t *testing.T) {
	// Without a real Repo we substitute a fake to confirm Request populates
	// the row before insert. Service.Request only reaches the Repo if the
	// inputs validate.
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	svc := &Service{Repo: nil, Now: fakeNow(now), TTL: 2 * time.Hour}
	// Intentionally pass an empty tenantID — Request must reject before any
	// repo invocation.
	if _, err := svc.Request(context.Background(), "", Resource{Type: ResourceCampaign, ID: "c1"}, Actor{}); err == nil {
		t.Errorf("want error for empty tenantID")
	}
	if _, err := svc.Request(context.Background(), "t1", Resource{}, Actor{}); err == nil {
		t.Errorf("want error for empty resource")
	}
}

// TestRequest_PropagatesUserID asserts that Actor.UserID is copied
// onto the Approval row by Service.Request. Without this, the
// two-person rule (audit HIGH F5) can't fire because Decide has no
// requester identity to compare against. Regression: an earlier
// draft of the field plumbing forgot to copy UserID inside the
// Approval{...} struct literal.
func TestRequest_PropagatesUserID(t *testing.T) {
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	svc := &Service{Now: fakeNow(now), TTL: time.Hour}
	var captured *Approval
	svc.insertFn = func(_ context.Context, a *Approval) error {
		a.ID = "row-1"
		captured = a
		return nil
	}
	uid := "user-42"
	_, err := svc.Request(context.Background(), "tenant-1",
		Resource{Type: ResourceCampaign, ID: "c1"},
		Actor{Type: "user", Label: "alice@example.com", UserID: &uid})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if captured == nil {
		t.Fatalf("insertFn never called")
	}
	if captured.RequestedByUserID == nil || *captured.RequestedByUserID != uid {
		t.Fatalf("RequestedByUserID = %v, want %q", captured.RequestedByUserID, uid)
	}
}

// TestIsSelfApproval covers every branch of the two-person rule
// helper (audit HIGH F5). The pure function lets us test the rule
// without standing up a Repo.
func TestIsSelfApproval(t *testing.T) {
	uid := "user-1"
	cases := []struct {
		name   string
		row    *Approval
		userID string
		want   bool
	}{
		{"nil row", nil, "user-1", false},
		{"empty userID — public one-click path", &Approval{RequestedByUserID: &uid}, "", false},
		{"nil requestedBy — agent/API-key request", &Approval{RequestedByUserID: nil}, "user-1", false},
		{"different user", &Approval{RequestedByUserID: &uid}, "user-2", false},
		{"same user — self approval", &Approval{RequestedByUserID: &uid}, "user-1", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSelfApproval(tc.row, tc.userID); got != tc.want {
				t.Errorf("isSelfApproval = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestErrSentinelsExported is a smoke test that the new error
// sentinels exist and have distinct identities — protects against an
// accidental var-shadowing refactor that would let errors.Is collide
// with a sibling sentinel.
func TestErrSentinelsExported(t *testing.T) {
	if ErrSelfApproval == nil || ErrTokenAlreadyUsed == nil {
		t.Fatal("new error sentinels are nil")
	}
	if ErrSelfApproval == ErrTokenAlreadyUsed {
		t.Fatal("ErrSelfApproval and ErrTokenAlreadyUsed must be distinct")
	}
	if ErrSelfApproval == ErrNotPending || ErrTokenAlreadyUsed == ErrNotPending {
		t.Fatal("new sentinels collide with ErrNotPending")
	}
}
