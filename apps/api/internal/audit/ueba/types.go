// SPDX-License-Identifier: AGPL-3.0-only
//
// Package ueba implements per-actor User and Entity Behavior Analytics
// baselines for the audit-2026 ueba-baselines feature (AI/Anomaly P1).
//
// Four detection modules cooperate inside Worker.Run:
//
//	impossible_travel — geo-distance / time-delta violations, with
//	                    suppression for known VPN pools and carrier-NAT
//	                    ranges.
//	off_hours         — per-actor working-hours window vs row hour,
//	                    weighted by deviation magnitude and action
//	                    sensitivity.
//	peer_group        — k-means clustering on per-actor action-frequency
//	                    vectors; flags actors >2σ from cluster centroid.
//	escalation_chain  — graph-walk for role-assume → permission-grant
//	                    → resource-access within a short window.
//
// Detector output funnels through Worker.aggregateScores into the
// audit_anomaly_scores table (migration 0317_audit_ueba.sql). The
// existing audit_alerts.Worker reads from that table and fires
// channel dispatch on score >= threshold.
package ueba

import (
	"context"
	"time"
)

// Baseline is the per-actor metrics snapshot persisted to
// audit_user_baselines. One row per (tenant, actor_label, actor_type,
// day); the most recent row is the active baseline.
type Baseline struct {
	TenantID          string
	ActorLabel        string
	ActorType         string
	Day               time.Time
	TypicalHours      map[int]int    // hour-of-day → count
	TypicalIPs        []string       // /16 CIDR prefixes
	TypicalActions    map[string]int // action → count
	MeanActionsPerDay float64
	ClusterID         *int
}

// AnomalyScore is the per-audit detector output persisted to
// audit_anomaly_scores. Score is the aggregated [0..100]; Reasons is
// the per-detector array the "Why high risk?" modal renders.
type AnomalyScore struct {
	TenantID        string
	AuditID         int64
	Score           float64
	Reasons         []DetectorReason
	MitreTechniques []string
	DetectorDetail  map[string]any
	CreatedAt       time.Time
}

// DetectorReason is one item in audit_anomaly_scores.reasons.
//
// Type is the detector name (impossible_travel / off_hours / peer_group
// / escalation_chain); Confidence is in [0..1]; Mitre is the list of
// MITRE ATT&CK technique IDs this detector flagged for the row.
type DetectorReason struct {
	Type       string   `json:"type"`
	Reason     string   `json:"reason"`
	Confidence float64  `json:"confidence"`
	Mitre      []string `json:"mitre"`
}

// AuditEvent is the narrow projection of audit_log columns the
// detectors consume. Decoupled from the heavier db.AuditRow / handler
// AuditRow so the package can be unit-tested without spinning a db.
type AuditEvent struct {
	ID         int64
	TenantID   string
	Action     string
	ActorType  string
	ActorLabel string
	IP         string
	At         time.Time
	Metadata   map[string]any
}

// DetectionModule is the contract every detector implements. Detect
// runs against a single event with the actor's baseline (which may be
// nil for cold-start actors); returns 0..N reasons, each contributing
// to the aggregate score in Worker.aggregateScores.
type DetectionModule interface {
	Name() string
	// Detect emits zero or more reasons for the given event. Detectors
	// should be deterministic: the same (event, baseline) input must
	// produce the same output so unit tests are stable.
	Detect(ctx context.Context, ev AuditEvent, base *Baseline, prev *AuditEvent) []DetectorReason
}

// BaselineRepo is the persistence contract. The production
// implementation is in worker.go (Postgres-backed); tests can pass an
// in-memory fake.
type BaselineRepo interface {
	GetBaselineForActor(ctx context.Context, tenantID, actorLabel, actorType string) (*Baseline, error)
	UpsertBaseline(ctx context.Context, b Baseline) error
	SaveAnomalyScore(ctx context.Context, s AnomalyScore) error
	QueryAnomalyScore(ctx context.Context, tenantID string, auditID int64) (*AnomalyScore, error)
	RecentTopAnomalies(ctx context.Context, tenantID string, window time.Duration, limit int) ([]AnomalyScore, error)
}

// mitreAttackTechniques maps detector + sub-reason to MITRE ATT&CK
// technique IDs. Centralised here so the frontend's deep-link to the
// MITRE catalogue is a stable lookup. Lookup ID reference:
// https://attack.mitre.org/techniques/<ID>/
var mitreAttackTechniques = map[string][]string{
	// T1078 Valid Accounts — impossible travel reveals a stolen
	// credential being used from an unexpected geography.
	"impossible_travel": {"T1078"},
	// T1078.004 Valid Accounts: Cloud Accounts — same as above but
	// for off-hours we add T1098 Account Manipulation because the
	// commonly-seen pattern is admin off-hours == grant rotation.
	"off_hours": {"T1078", "T1098"},
	// T1098 Account Manipulation — peer-group anomalies often surface
	// a compromised account performing actions outside its role.
	"peer_group": {"T1098"},
	// T1134 Access Token Manipulation + T1078 Valid Accounts.
	// Escalation chains are the canonical TA0004 Privilege Escalation
	// tactic.
	"escalation_chain": {"T1078", "T1098", "T1134"},
}

// MitreFor returns the MITRE technique IDs for a detector name. Empty
// slice (not nil) so JSON encoding produces `[]` not `null` for an
// unknown detector.
func MitreFor(detector string) []string {
	if ids, ok := mitreAttackTechniques[detector]; ok {
		out := make([]string, len(ids))
		copy(out, ids)
		return out
	}
	return []string{}
}
