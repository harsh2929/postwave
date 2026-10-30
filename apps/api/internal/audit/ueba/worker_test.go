// SPDX-License-Identifier: AGPL-3.0-only

package ueba

import (
	"context"
	"testing"
	"time"
)

func evAt(action, ip string, h int) AuditEvent {
	return AuditEvent{
		ID:         int64(h),
		TenantID:   "00000000-0000-0000-0000-000000000001",
		Action:     action,
		ActorType:  "user",
		ActorLabel: "alice@example.com",
		IP:         ip,
		At:         time.Date(2026, 6, 4, h, 0, 0, 0, time.UTC),
	}
}

// TestComputeBaselinesDaily walks a fixture set of events and asserts
// the per-actor projection contains expected counts.
func TestComputeBaselinesDaily(t *testing.T) {
	events := []AuditEvent{
		evAt("campaign.send", "10.0.0.1", 9),
		evAt("campaign.send", "10.0.0.2", 10),
		evAt("subscriber.delete", "10.0.0.3", 14),
		evAt("subscriber.list", "192.168.1.1", 16),
		evAt("subscriber.list", "192.168.1.2", 17),
	}
	bs := computeBaselines(events, time.Date(2026, 6, 4, 0, 0, 0, 0, time.UTC), 30)
	if len(bs) != 1 {
		t.Fatalf("expected 1 baseline, got %d", len(bs))
	}
	b := bs[0]
	if b.TypicalActions["campaign.send"] != 2 {
		t.Errorf("expected campaign.send=2, got %d", b.TypicalActions["campaign.send"])
	}
	if b.TypicalActions["subscriber.list"] != 2 {
		t.Errorf("expected subscriber.list=2, got %d", b.TypicalActions["subscriber.list"])
	}
	if len(b.TypicalIPs) == 0 {
		t.Errorf("expected at least one typical_ip prefix")
	}
	if b.MeanActionsPerDay <= 0 {
		t.Errorf("expected non-zero mean_actions_per_day")
	}
}

// TestDetectImpossibleTravel: same actor on 3.5 (Ashburn) → 35.190
// (Tokyo) within 15 minutes must fire.
func TestDetectImpossibleTravel(t *testing.T) {
	d := &ImpossibleTravelDetector{}
	prev := AuditEvent{IP: "3.5.0.1", At: time.Now()}
	now := prev.At.Add(15 * time.Minute)
	cur := AuditEvent{IP: "35.190.0.1", At: now}
	r := d.Detect(context.Background(), cur, nil, &prev)
	if len(r) == 0 {
		t.Fatalf("expected impossible_travel reason, got none")
	}
	if r[0].Type != "impossible_travel" {
		t.Errorf("wrong detector type: %s", r[0].Type)
	}
	if len(r[0].Mitre) == 0 {
		t.Errorf("expected mitre techniques")
	}
}

// TestDetectImpossibleTravelSuppressedSameSlash16: rapid jump inside
// same /16 (corporate VPN, carrier-NAT) must NOT fire.
func TestDetectImpossibleTravelSuppressedSameSlash16(t *testing.T) {
	d := &ImpossibleTravelDetector{}
	prev := AuditEvent{IP: "192.168.1.1", At: time.Now()}
	cur := AuditEvent{IP: "192.168.1.99", At: prev.At.Add(time.Minute)}
	if r := d.Detect(context.Background(), cur, nil, &prev); len(r) != 0 {
		t.Errorf("expected suppression, got reason: %+v", r)
	}
}

// TestDetectOffHours: actor with 09..17 baseline accessing at 03 UTC
// must fire.
func TestDetectOffHours(t *testing.T) {
	base := &Baseline{
		TypicalHours: map[int]int{
			9: 50, 10: 60, 11: 70, 12: 65, 13: 60, 14: 55, 15: 50, 16: 40, 17: 30,
		},
	}
	d := &OffHoursDetector{}
	ev := AuditEvent{
		Action: "subscriber.delete",
		At:     time.Date(2026, 6, 4, 3, 45, 0, 0, time.UTC),
	}
	r := d.Detect(context.Background(), ev, base, nil)
	if len(r) == 0 {
		t.Fatalf("expected off_hours reason, got none")
	}
	if r[0].Confidence < 0.3 {
		t.Errorf("destructive off-hours should have confidence>=0.3, got %f", r[0].Confidence)
	}
}

// TestDetectOffHoursWithinWindow: same baseline, access at 10:00 UTC
// is inside the window and must NOT fire.
func TestDetectOffHoursWithinWindow(t *testing.T) {
	base := &Baseline{
		TypicalHours: map[int]int{
			9: 50, 10: 60, 11: 70, 12: 65, 13: 60, 14: 55, 15: 50, 16: 40, 17: 30,
		},
	}
	d := &OffHoursDetector{}
	ev := AuditEvent{Action: "subscriber.list", At: time.Date(2026, 6, 4, 10, 0, 0, 0, time.UTC)}
	if r := d.Detect(context.Background(), ev, base, nil); len(r) != 0 {
		t.Errorf("expected no reason for within-window, got %+v", r)
	}
}

// TestDetectEscalationChain: assume_role → permission_grant within
// 1 minute must fire.
func TestDetectEscalationChain(t *testing.T) {
	d := &EscalationChainDetector{}
	prev := AuditEvent{Action: "role.assume", At: time.Now()}
	cur := AuditEvent{Action: "permission.grant", At: prev.At.Add(time.Minute)}
	r := d.Detect(context.Background(), cur, nil, &prev)
	if len(r) == 0 {
		t.Fatalf("expected escalation_chain reason, got none")
	}
	if r[0].Type != "escalation_chain" {
		t.Errorf("wrong detector type: %s", r[0].Type)
	}
}

// TestEscalationChainStaleSuppressed: same transitions but with prev
// 30 minutes earlier must NOT fire (outside MaxWindow).
func TestEscalationChainStaleSuppressed(t *testing.T) {
	d := &EscalationChainDetector{}
	prev := AuditEvent{Action: "role.assume", At: time.Now()}
	cur := AuditEvent{Action: "permission.grant", At: prev.At.Add(30 * time.Minute)}
	if r := d.Detect(context.Background(), cur, nil, &prev); len(r) != 0 {
		t.Errorf("expected stale suppression, got %+v", r)
	}
}

// TestDetectPeerGroupAnomaly: actor whose historical actions never
// include "purge" suddenly issues a "subscriber.purge" → fire.
func TestDetectPeerGroupAnomaly(t *testing.T) {
	cid := 0
	base := &Baseline{
		TypicalActions: map[string]int{
			"campaign.send":   500,
			"subscriber.list": 300,
		},
		ClusterID: &cid,
	}
	d := &PeerGroupDetector{}
	ev := AuditEvent{Action: "subscriber.purge"}
	r := d.Detect(context.Background(), ev, base, nil)
	if len(r) == 0 {
		t.Fatalf("expected peer_group reason, got none")
	}
}

// TestIdentifyChainStep covers the action → step classifier.
func TestIdentifyChainStep(t *testing.T) {
	cases := []struct {
		action string
		want   ChainStep
	}{
		{"role.assume", ChainStepAssumeRole},
		{"session.assume_role", ChainStepAssumeRole},
		{"permission.grant", ChainStepPermissionGrant},
		{"policy.attach", ChainStepPermissionGrant},
		{"subscriber.list", ChainStepResourceAccess},
		{"campaign.get", ChainStepResourceAccess},
		{"subscriber.delete", ChainStepDestructive},
		{"campaign.send", ChainStepNone},
	}
	for _, c := range cases {
		if got := IdentifyChainStep(c.action); got != c.want {
			t.Errorf("%s: got %v want %v", c.action, got, c.want)
		}
	}
}

// TestAggregateScore: stacking detectors should sum but cap at 100.
func TestAggregateScore(t *testing.T) {
	r := []DetectorReason{
		{Type: "impossible_travel", Confidence: 1.0},
		{Type: "off_hours", Confidence: 1.0},
		{Type: "escalation_chain", Confidence: 1.0},
		{Type: "peer_group", Confidence: 1.0},
	}
	got := AggregateScore(r)
	if got != 100 {
		t.Errorf("expected score capped to 100, got %f", got)
	}
}

// TestKMeansDeterminism: same seedKey + inputs must always produce the
// same cluster assignments.
func TestKMeansDeterminism(t *testing.T) {
	vectors := [][]float64{
		{1, 0, 0},
		{1, 0, 0.1},
		{0, 1, 0},
		{0, 1, 0.1},
		{0, 0, 1},
		{0, 0.1, 1},
	}
	a := KMeansClustering(vectors, 3, "tenant-2026-06-04")
	b := KMeansClustering(vectors, 3, "tenant-2026-06-04")
	if len(a) != len(b) {
		t.Fatalf("len mismatch: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Errorf("nondeterministic assignment at %d: %d vs %d", i, a[i], b[i])
		}
	}
}

// TestBuildVocabulary verifies top-N selection is lexicographically
// stable for ties.
func TestBuildVocabulary(t *testing.T) {
	cohort := []Baseline{
		{TypicalActions: map[string]int{"a.do": 10, "b.do": 5}},
		{TypicalActions: map[string]int{"c.do": 5, "b.do": 5}},
	}
	v := BuildVocabulary(cohort, 2)
	if len(v) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(v))
	}
	if v[0] != "a.do" {
		t.Errorf("expected a.do first, got %s", v[0])
	}
}

// TestMitreFor returns expected technique IDs and never returns nil.
func TestMitreFor(t *testing.T) {
	if ids := MitreFor("impossible_travel"); len(ids) == 0 {
		t.Errorf("expected technique ids for impossible_travel")
	}
	if ids := MitreFor("unknown_detector"); ids == nil {
		t.Errorf("expected non-nil empty slice for unknown detector")
	}
}

// TestComputeHourlyWindow returns a sane peak window.
func TestComputeHourlyWindow(t *testing.T) {
	hours := map[int]int{9: 5, 10: 50, 11: 60, 12: 55, 13: 20, 14: 5}
	start, end := computeHourlyWindow(hours)
	if start < 9 || start > 12 {
		t.Errorf("expected peak in 9..12, got start=%d end=%d", start, end)
	}
}

// TestPgTextArray serialises Go slice into Postgres array literal.
func TestPgTextArray(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{nil, "{}"},
		{[]string{"T1078"}, `{"T1078"}`},
		{[]string{"T1078", "T1098"}, `{"T1078","T1098"}`},
	}
	for _, c := range cases {
		got := pgTextArray(c.in)
		if got != c.want {
			t.Errorf("input=%v got=%s want=%s", c.in, got, c.want)
		}
	}
}
