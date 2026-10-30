// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// fakeThreatIntel always returns the configured response — lets us
// drive the "malicious IP" branch in the agent loop deterministically.
type fakeThreatIntel struct {
	label string
	mal   bool
}

func (f fakeThreatIntel) Lookup(_ context.Context, _ string) (string, bool) {
	return f.label, f.mal
}

func TestResult_Validate_RejectsFindingWithoutEvidence(t *testing.T) {
	tests := []struct {
		name    string
		res     *Result
		wantErr error
	}{
		{
			name: "all findings cite evidence",
			res: &Result{
				Findings: []Finding{
					{Num: 1, EvidenceAuditIDs: []int64{1, 2}},
					{Num: 2, EvidenceAuditIDs: []int64{3}},
				},
			},
			wantErr: nil,
		},
		{
			name: "one finding without evidence",
			res: &Result{
				Findings: []Finding{
					{Num: 1, EvidenceAuditIDs: []int64{1}},
					{Num: 2, EvidenceAuditIDs: nil},
				},
			},
			wantErr: ErrNoEvidence,
		},
		{
			name: "empty findings is valid",
			res: &Result{
				Findings: nil,
			},
			wantErr: nil,
		},
		{
			name:    "nil result rejected",
			res:     nil,
			wantErr: errors.New("investigator: nil result"),
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.res.Validate()
			if tc.wantErr == nil {
				if err != nil {
					t.Fatalf("Validate: unexpected err %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate: want err, got nil")
			}
			if errors.Is(tc.wantErr, ErrNoEvidence) && !errors.Is(err, ErrNoEvidence) {
				t.Fatalf("Validate: want ErrNoEvidence, got %v", err)
			}
		})
	}
}

func TestRun_EmptyWindow_EmitsIsolatedFinding(t *testing.T) {
	inv := &Investigator{
		ContextWindow:  time.Hour,
		MaxContextRows: 100,
		Now:            func() time.Time { return time.Unix(1700000000, 0).UTC() },
	}
	seed := Event{
		ID:         99,
		TenantID:   "t1",
		Action:     "user.deleted",
		ActorLabel: "alice",
		At:         time.Unix(1700000000, 0).UTC(),
	}
	res := inv.run(context.Background(), seed, nil)
	if err := res.Validate(); err != nil {
		t.Fatalf("result invalid: %v", err)
	}
	if len(res.Findings) != 1 {
		t.Fatalf("findings: want 1, got %d", len(res.Findings))
	}
	if !contains64(res.Findings[0].EvidenceAuditIDs, 99) {
		t.Fatalf("seed must self-cite, got %v", res.Findings[0].EvidenceAuditIDs)
	}
	if res.Confidence <= 0 || res.Confidence > 1 {
		t.Fatalf("confidence out of range: %f", res.Confidence)
	}
}

func TestRun_HotActorCluster_ProposesDisableUser(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	inv := &Investigator{
		ContextWindow:  time.Hour,
		MaxContextRows: 100,
		Now:            func() time.Time { return now },
	}
	seed := Event{
		ID:              1,
		Action:          "key.deleted",
		ActorLabel:      "mallory",
		ResourceID:      "key-1",
		IP:              "203.0.113.10",
		At:              now,
		AnomalyScore:    75,
		MitreTechniques: []string{"T1078"},
	}
	others := []Event{
		{ID: 2, Action: "key.created", ActorLabel: "mallory", ResourceID: "key-1", IP: "203.0.113.10", At: now.Add(-2 * time.Minute), AnomalyScore: 80},
		{ID: 3, Action: "key.rotated", ActorLabel: "mallory", ResourceID: "key-2", IP: "203.0.113.10", At: now.Add(-5 * time.Minute), AnomalyScore: 70},
		{ID: 4, Action: "user.login", ActorLabel: "mallory", IP: "203.0.113.10", At: now.Add(-30 * time.Minute)},
	}
	res := inv.run(context.Background(), seed, append([]Event{seed}, others...))
	if err := res.Validate(); err != nil {
		t.Fatalf("result invalid: %v", err)
	}
	// Must have proposed disable_user for mallory.
	gotDisable := false
	gotForceReauth := false
	gotQuarantine := false
	for _, a := range res.ProposedActions {
		if !a.RequiresHumanApproval {
			t.Fatalf("action %s missing requires_human_approval", a.ID)
		}
		switch a.Action {
		case ActionDisableUser:
			if a.TargetID == "mallory" {
				gotDisable = true
			}
		case ActionForceReauth:
			if a.TargetID == "mallory" {
				gotForceReauth = true
			}
		case ActionQuarantineIP:
			if a.TargetID == "203.0.113.10" {
				gotQuarantine = true
			}
		}
	}
	if !gotDisable {
		t.Fatalf("expected disable_user(mallory) in proposed actions, got %+v", res.ProposedActions)
	}
	if !gotForceReauth {
		t.Fatalf("expected force_reauth(mallory) in proposed actions, got %+v", res.ProposedActions)
	}
	if !gotQuarantine {
		t.Fatalf("expected quarantine_ip(203.0.113.10), got %+v", res.ProposedActions)
	}
	// MITRE must include the per-actor baseline T1078.
	if !containsStr(res.MitreTechniques, "T1078") {
		t.Fatalf("expected MITRE T1078 in result, got %v", res.MitreTechniques)
	}
	// Every finding must cite evidence.
	for _, f := range res.Findings {
		if len(f.EvidenceAuditIDs) == 0 {
			t.Fatalf("finding %d missing evidence", f.Num)
		}
	}
}

func TestRun_ThreatIntelMalicious_AddsExtraFinding(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	inv := &Investigator{
		ContextWindow:  time.Hour,
		MaxContextRows: 100,
		Now:            func() time.Time { return now },
		ThreatIntel:    fakeThreatIntel{label: "tor-exit", mal: true},
	}
	seed := Event{
		ID:         1,
		Action:     "user.login",
		ActorLabel: "alice",
		IP:         "198.51.100.7",
		At:         now,
	}
	res := inv.run(context.Background(), seed, []Event{seed})
	hit := false
	for _, f := range res.Findings {
		if strings.Contains(f.Hypothesis, "threat intel") && strings.Contains(f.Hypothesis, "tor-exit") {
			hit = true
			if len(f.EvidenceAuditIDs) == 0 {
				t.Fatalf("threat-intel finding lacks evidence")
			}
		}
	}
	if !hit {
		t.Fatalf("expected a threat-intel finding, got %+v", res.Findings)
	}
}

func TestRun_BenignWindow_NoActions(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	inv := &Investigator{
		ContextWindow:  time.Hour,
		MaxContextRows: 100,
		Now:            func() time.Time { return now },
	}
	seed := Event{
		ID:         1,
		Action:     "page.view",
		ActorLabel: "alice",
		At:         now,
	}
	others := []Event{
		{ID: 2, Action: "page.view", ActorLabel: "alice", At: now.Add(-5 * time.Minute)},
		{ID: 3, Action: "page.view", ActorLabel: "alice", At: now.Add(-7 * time.Minute)},
	}
	res := inv.run(context.Background(), seed, append([]Event{seed}, others...))
	if err := res.Validate(); err != nil {
		t.Fatalf("result invalid: %v", err)
	}
	// Without a hot cluster, we should not have proposed any disable/quarantine actions.
	for _, a := range res.ProposedActions {
		if a.Action == ActionDisableUser || a.Action == ActionQuarantineIP {
			t.Fatalf("benign window should not propose %s, got %+v", a.Action, res.ProposedActions)
		}
	}
}

func TestActionFamily(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"user.deleted", "user"},
		{"key.rotated", "key"},
		{"login", "login"},
		{"", ""},
	}
	for _, tc := range tests {
		if got := actionFamily(tc.in); got != tc.want {
			t.Errorf("actionFamily(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestActionID_StableForSameInput(t *testing.T) {
	a := actionID("disable_user", "mallory")
	b := actionID("disable_user", "mallory")
	if a != b {
		t.Fatalf("actionID not stable: %q vs %q", a, b)
	}
	c := actionID("disable_user", "alice")
	if a == c {
		t.Fatalf("actionID collision across targets")
	}
}

func TestInvestigate_MissingDeps(t *testing.T) {
	inv := &Investigator{}
	if _, err := inv.Investigate(context.Background(), "t1", 1); err == nil {
		t.Fatalf("expected err on missing pool")
	}
	inv = &Investigator{Pool: fakePool{}}
	if _, err := inv.Investigate(context.Background(), "", 1); err == nil {
		t.Fatalf("expected err on empty tenant id")
	}
	if _, err := inv.Investigate(context.Background(), "t1", 0); err == nil {
		t.Fatalf("expected err on invalid seed id")
	}
}

// fakePool implements QueryablePool just enough to test the guard
// clauses in Investigate; the BeginTx return is intentionally
// non-functional because the guards short-circuit before it's used.
type fakePool struct{}

func (fakePool) BeginTx(_ context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return nil, errors.New("not implemented")
}

func contains64(a []int64, v int64) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}

func containsStr(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}
