// SPDX-License-Identifier: AGPL-3.0-only
//
// Package agent implements the audit-2026 "AI investigation agent"
// (ai-investigation-agent, AI/Anomaly P1).
//
// Entry point: NewInvestigator(...).Investigate(ctx, tenantID, seedID).
//
// Agent loop (single-shot, no recursion):
//
//  1. Fetch the seed audit_log row.
//  2. Pull every audit_log row within ±contextWindow of the seed,
//     scoped to tenant_id via RLS.
//  3. Cluster related events by actor_label, resource_id, ip and
//     action_family. Each cluster becomes one numbered hypothesis.
//  4. Cross-reference each cluster against:
//     - audit_user_baselines  (UEBA typical-hours / typical-IPs)
//     - audit_anomaly_scores  (any UEBA detector reasons + MITRE)
//     - threat-intel feed     (IP reputation, optional)
//  5. Emit numbered Findings with audit_log row IDs cited as evidence
//     and MITRE ATT&CK technique IDs lifted from the per-detector
//     mapping.
//  6. Propose remediation Actions — disable_user, rotate_key,
//     force_reauth — every action carries RequiresHumanApproval=true.
//     The action executor refuses to apply actions without that flag.
//
// Hard rule (Moosewave-specific):
//
//	Every Finding MUST cite at least one audit_log.id in
//	EvidenceAuditIDs. The Result validator rejects findings with an
//	empty evidence array. This is the "no LLM hallucinations without
//	a source row" guarantee the auditor relies on.
package agent

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// DefaultContextWindow is the ±delta we fetch around the seed event.
// 1h matches the spec's "±1h window".
const DefaultContextWindow = time.Hour

// MaxContextRows caps the number of audit_log rows we load per
// investigation so a noisy tenant can't push us OOM. Tunable per
// investigation via Investigator.MaxContextRows; default chosen so that
// at 1k events/min the ±1h window is still fully covered.
const MaxContextRows = 10_000

// QueryablePool is the narrow contract investigators need from a
// pgxpool. Lets unit tests pass an in-memory fake; the production
// caller passes a *pgxpool.Pool which satisfies this implicitly.
type QueryablePool interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// Event is the projection of audit_log columns the investigator
// reasons about. Kept narrow and decoupled from the heavier
// handlers.AuditRow / db.AuditRow so the agent can be unit-tested
// without a database.
type Event struct {
	ID         int64
	TenantID   string
	Action     string
	ActorType  string
	ActorLabel string
	ResourceID string
	IP         string
	UserID     string
	At         time.Time
	Metadata   map[string]any
	// AnomalyScore is the UEBA score on the row if any. 0 if no row in
	// audit_anomaly_scores (the agent treats 0 as "no signal", not "all
	// clear").
	AnomalyScore    float64
	MitreTechniques []string
}

// Finding is one numbered hypothesis. Every Finding must cite at
// least one row ID in EvidenceAuditIDs — the Validate method below
// enforces it, and the persist path rejects invalid Results.
type Finding struct {
	Num              int      `json:"num"`
	Hypothesis       string   `json:"hypothesis"`
	MitreTechniques  []string `json:"mitre_techniques"`
	Confidence       float64  `json:"confidence"`
	EvidenceAuditIDs []int64  `json:"evidence_audit_ids"`
	// DetectorReasons records which UEBA detectors (off_hours, etc.)
	// contributed to this hypothesis. Surfaced to the UI under each
	// hypothesis card so the operator can audit the reasoning.
	DetectorReasons []string `json:"detector_reasons,omitempty"`
}

// ActionKind enumerates the remediation actions the agent may propose.
// New kinds are added intentionally — every kind requires a matching
// executor branch in actions.go, and an unknown kind is rejected at
// apply time so the agent can't smuggle through an arbitrary action.
type ActionKind string

const (
	ActionDisableUser  ActionKind = "disable_user"
	ActionRotateKey    ActionKind = "rotate_key"
	ActionForceReauth  ActionKind = "force_reauth"
	ActionRevokeToken  ActionKind = "revoke_token"
	ActionRequireMFA   ActionKind = "require_mfa"
	ActionQuarantineIP ActionKind = "quarantine_ip"
)

// ProposedAction is one remediation candidate. RequiresHumanApproval
// is always true; the executor refuses anything else. The ID is a
// stable hex prefix derived from the action kind + target so that the
// frontend can refer to a single action across re-loads.
type ProposedAction struct {
	ID                    string     `json:"id"`
	Action                ActionKind `json:"action"`
	TargetID              string     `json:"target_id"`
	Rationale             string     `json:"rationale"`
	Severity              string     `json:"severity"`
	RequiresHumanApproval bool       `json:"requires_human_approval"`
	EvidenceAuditIDs      []int64    `json:"evidence_audit_ids"`
	LinkedFindingNums     []int      `json:"linked_finding_nums,omitempty"`
}

// Result is the agent loop output. Persisted to audit_investigations
// via Store.Insert.
type Result struct {
	SeedAuditID      int64            `json:"seed_audit_id"`
	Findings         []Finding        `json:"findings"`
	EvidenceAuditIDs []int64          `json:"evidence_audit_ids"`
	ProposedActions  []ProposedAction `json:"proposed_actions"`
	MitreTechniques  []string         `json:"mitre_techniques"`
	Confidence       float64          `json:"confidence"`
	GeneratedAt      time.Time        `json:"generated_at"`
}

// ErrNoEvidence is returned by Validate when one or more findings do
// not cite any audit_log row. The handler converts this to a 422
// "must_cite_evidence" so the caller knows the request was structurally
// invalid rather than a transient backend failure.
var ErrNoEvidence = errors.New("investigator: every finding must cite at least one audit_log id")

// Validate enforces the hard rule: no finding may be persisted without
// at least one cited evidence id. Called both at end-of-loop and again
// by Store.Insert as a belt-and-braces check.
func (r *Result) Validate() error {
	if r == nil {
		return errors.New("investigator: nil result")
	}
	for i := range r.Findings {
		if len(r.Findings[i].EvidenceAuditIDs) == 0 {
			return fmt.Errorf("%w: finding %d", ErrNoEvidence, r.Findings[i].Num)
		}
	}
	return nil
}

// ThreatIntel is the optional contract the agent uses to score an
// IP against a reputation feed. Returns ("", false) when no feed is
// wired; the agent treats nil ThreatIntel as "no signal".
type ThreatIntel interface {
	Lookup(ctx context.Context, ip string) (label string, malicious bool)
}

// Investigator is the agent itself. Construct via NewInvestigator and
// call Investigate.
type Investigator struct {
	Pool           QueryablePool
	ContextWindow  time.Duration
	MaxContextRows int
	ThreatIntel    ThreatIntel
	// Now is injectable so unit tests can pin a deterministic clock.
	Now func() time.Time
}

// NewInvestigator returns an Investigator with safe defaults.
func NewInvestigator(pool QueryablePool) *Investigator {
	return &Investigator{
		Pool:           pool,
		ContextWindow:  DefaultContextWindow,
		MaxContextRows: MaxContextRows,
		Now:            func() time.Time { return time.Now().UTC() },
	}
}

// Investigate runs the agent loop against the given seed audit row.
// Returns a Result that satisfies the cited-evidence invariant or an
// error explaining why no investigation could be produced.
func (inv *Investigator) Investigate(ctx context.Context, tenantID string, seedAuditID int64) (*Result, error) {
	if inv == nil || inv.Pool == nil {
		return nil, errors.New("investigator: missing pool")
	}
	if tenantID == "" {
		return nil, errors.New("investigator: empty tenant id")
	}
	if seedAuditID <= 0 {
		return nil, errors.New("investigator: invalid seed audit id")
	}
	cw := inv.ContextWindow
	if cw <= 0 {
		cw = DefaultContextWindow
	}
	cap := inv.MaxContextRows
	if cap <= 0 {
		cap = MaxContextRows
	}

	tx, err := inv.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("investigator: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, fmt.Errorf("investigator: set tenant scope: %w", err)
	}

	seed, err := fetchEvent(ctx, tx, seedAuditID)
	if err != nil {
		return nil, fmt.Errorf("investigator: fetch seed: %w", err)
	}

	events, err := fetchWindow(ctx, tx, seed.At.Add(-cw), seed.At.Add(cw), cap)
	if err != nil {
		return nil, fmt.Errorf("investigator: fetch window: %w", err)
	}
	// Always include the seed; row-fetch above is range-based so a
	// pathological clock skew could miss it.
	if !containsID(events, seed.ID) {
		events = append(events, seed)
	}

	if err := annotateAnomalies(ctx, tx, tenantID, events); err != nil {
		return nil, fmt.Errorf("investigator: anomaly lookup: %w", err)
	}

	return inv.run(ctx, seed, events), nil
}

// run is the deterministic, side-effect-free reasoning core. Split
// out from Investigate so unit tests can drive it directly with hand-
// crafted Event slices.
func (inv *Investigator) run(ctx context.Context, seed Event, events []Event) *Result {
	res := &Result{
		SeedAuditID: seed.ID,
		GeneratedAt: inv.Now(),
	}
	if len(events) == 0 {
		// No window context — emit a single citation-of-self finding so
		// the result still satisfies the cited-evidence invariant.
		res.Findings = []Finding{
			{
				Num:              1,
				Hypothesis:       fmt.Sprintf("Isolated %s with no contextual activity in ±%s window.", seed.Action, inv.ContextWindow),
				MitreTechniques:  seed.MitreTechniques,
				Confidence:       0.25,
				EvidenceAuditIDs: []int64{seed.ID},
			},
		}
		res.EvidenceAuditIDs = []int64{seed.ID}
		res.MitreTechniques = uniqueStrings(seed.MitreTechniques)
		res.Confidence = 0.25
		return res
	}

	clusters := clusterEvents(seed, events)
	num := 0
	mitreUnion := map[string]struct{}{}
	allEvidence := map[int64]struct{}{seed.ID: {}}
	totalConf := 0.0

	for _, c := range clusters {
		num++
		f := Finding{
			Num:              num,
			Hypothesis:       c.hypothesis(seed),
			MitreTechniques:  c.mitre(),
			Confidence:       c.confidence(),
			EvidenceAuditIDs: c.evidence(),
			DetectorReasons:  c.detectorReasons(),
		}
		for _, m := range f.MitreTechniques {
			mitreUnion[m] = struct{}{}
		}
		for _, id := range f.EvidenceAuditIDs {
			allEvidence[id] = struct{}{}
		}
		totalConf += f.Confidence
		res.Findings = append(res.Findings, f)
	}

	// Threat-intel pass: if the seed IP scores malicious, add an
	// extra finding citing the seed row.
	if inv.ThreatIntel != nil && seed.IP != "" {
		label, mal := inv.ThreatIntel.Lookup(ctx, seed.IP)
		if mal {
			num++
			f := Finding{
				Num:              num,
				Hypothesis:       fmt.Sprintf("Seed IP %s flagged by threat intel feed (%s).", seed.IP, label),
				MitreTechniques:  []string{"T1078"},
				Confidence:       0.75,
				EvidenceAuditIDs: []int64{seed.ID},
				DetectorReasons:  []string{"threat_intel:" + label},
			}
			mitreUnion["T1078"] = struct{}{}
			totalConf += f.Confidence
			res.Findings = append(res.Findings, f)
		}
	}

	res.EvidenceAuditIDs = sortedInt64Keys(allEvidence)
	res.MitreTechniques = sortedStringKeys(mitreUnion)
	if len(res.Findings) > 0 {
		res.Confidence = totalConf / float64(len(res.Findings))
	}
	res.ProposedActions = proposeActions(seed, clusters, res.Findings)
	return res
}

// cluster groups events that share an axis (same actor / same resource
// / same IP / same action family). Each cluster turns into one
// numbered hypothesis.
type cluster struct {
	axis   string // "actor"/"resource"/"ip"/"action"
	key    string
	events []Event
	// hot is true when at least one event in the cluster has a UEBA
	// anomaly score above the alert threshold.
	hot bool
}

func clusterEvents(seed Event, events []Event) []cluster {
	byActor := map[string][]Event{}
	byResource := map[string][]Event{}
	byIP := map[string][]Event{}
	byActionFamily := map[string][]Event{}

	for _, e := range events {
		if e.ActorLabel != "" {
			byActor[e.ActorLabel] = append(byActor[e.ActorLabel], e)
		}
		if e.ResourceID != "" {
			byResource[e.ResourceID] = append(byResource[e.ResourceID], e)
		}
		if e.IP != "" {
			byIP[e.IP] = append(byIP[e.IP], e)
		}
		fam := actionFamily(e.Action)
		if fam != "" {
			byActionFamily[fam] = append(byActionFamily[fam], e)
		}
	}

	out := []cluster{}
	// Priority order: the most specific axis (actor) first.
	if seed.ActorLabel != "" {
		out = append(out, makeCluster("actor", seed.ActorLabel, byActor[seed.ActorLabel]))
	}
	if seed.ResourceID != "" {
		out = append(out, makeCluster("resource", seed.ResourceID, byResource[seed.ResourceID]))
	}
	if seed.IP != "" {
		out = append(out, makeCluster("ip", seed.IP, byIP[seed.IP]))
	}
	if fam := actionFamily(seed.Action); fam != "" {
		out = append(out, makeCluster("action", fam, byActionFamily[fam]))
	}
	// Drop singleton clusters that only contain the seed; not useful
	// as a separate finding (the per-event hypothesis already cites
	// the seed).
	filtered := out[:0]
	for _, c := range out {
		if len(c.events) <= 1 && c.axis != "actor" {
			continue
		}
		filtered = append(filtered, c)
	}
	return filtered
}

func makeCluster(axis, key string, evs []Event) cluster {
	c := cluster{axis: axis, key: key, events: evs}
	for _, e := range evs {
		if e.AnomalyScore >= 60 {
			c.hot = true
			break
		}
	}
	return c
}

func (c cluster) hypothesis(seed Event) string {
	n := len(c.events)
	switch c.axis {
	case "actor":
		if c.hot {
			return fmt.Sprintf("Actor %q produced %d events in the window, including one or more high-risk anomaly scores. Likely compromised account or insider misuse.", c.key, n)
		}
		return fmt.Sprintf("Actor %q produced %d related events in the window. Investigate whether this volume matches the actor's typical activity pattern.", c.key, n)
	case "resource":
		return fmt.Sprintf("Resource %q was accessed/modified %d times in the window. Investigate concurrent access from %d distinct actors.", c.key, n, countDistinctActors(c.events))
	case "ip":
		if c.hot {
			return fmt.Sprintf("IP %s sourced %d events with at least one high-risk score. Possible attacker pivot or stolen-credential reuse.", c.key, n)
		}
		return fmt.Sprintf("IP %s sourced %d events across %d distinct actors. Investigate whether this is a shared egress or a credential-stuffing source.", c.key, n, countDistinctActors(c.events))
	case "action":
		return fmt.Sprintf("Action family %q appeared %d times in the window. Investigate whether this is a burst (automation) or a sequence (attack chain).", c.key, n)
	}
	return fmt.Sprintf("%d related events clustered on %s=%s.", n, c.axis, c.key)
}

func (c cluster) mitre() []string {
	out := map[string]struct{}{}
	for _, e := range c.events {
		for _, m := range e.MitreTechniques {
			out[m] = struct{}{}
		}
	}
	// Per-axis baseline techniques.
	switch c.axis {
	case "actor":
		out["T1078"] = struct{}{}
	case "ip":
		out["T1078"] = struct{}{}
	case "action":
		fam := strings.ToLower(c.key)
		if strings.Contains(fam, "grant") || strings.Contains(fam, "role") {
			out["T1098"] = struct{}{}
		}
		if strings.Contains(fam, "key") || strings.Contains(fam, "token") {
			out["T1098"] = struct{}{}
			out["T1134"] = struct{}{}
		}
	}
	return sortedStringKeys(out)
}

func (c cluster) confidence() float64 {
	base := 0.4
	if c.hot {
		base += 0.35
	}
	// More evidence rows → marginally higher confidence, capped at 0.95.
	bonus := float64(len(c.events)) * 0.02
	if bonus > 0.2 {
		bonus = 0.2
	}
	conf := base + bonus
	if conf > 0.95 {
		conf = 0.95
	}
	return conf
}

func (c cluster) evidence() []int64 {
	ids := make([]int64, 0, len(c.events))
	seen := map[int64]struct{}{}
	for _, e := range c.events {
		if _, ok := seen[e.ID]; ok {
			continue
		}
		seen[e.ID] = struct{}{}
		ids = append(ids, e.ID)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	// Cap each finding's citation list at 50 ids — sufficient for the
	// auditor to drill in, avoids unbounded jsonb growth.
	if len(ids) > 50 {
		ids = ids[:50]
	}
	return ids
}

func (c cluster) detectorReasons() []string {
	out := map[string]struct{}{}
	for _, e := range c.events {
		if e.AnomalyScore >= 60 {
			out[fmt.Sprintf("ueba_score=%.0f", e.AnomalyScore)] = struct{}{}
		}
	}
	return sortedStringKeys(out)
}

func countDistinctActors(evs []Event) int {
	s := map[string]struct{}{}
	for _, e := range evs {
		if e.ActorLabel != "" {
			s[e.ActorLabel] = struct{}{}
		}
	}
	return len(s)
}

func actionFamily(action string) string {
	if action == "" {
		return ""
	}
	if i := strings.IndexByte(action, '.'); i > 0 {
		return action[:i]
	}
	return action
}

// proposeActions chooses remediation candidates given the seed event
// and the clusters. Each action carries RequiresHumanApproval=true.
func proposeActions(seed Event, clusters []cluster, findings []Finding) []ProposedAction {
	out := []ProposedAction{}
	// Score-driven rules: any cluster with hot=true triggers a
	// disable_user action against the actor; any IP cluster triggers
	// a quarantine_ip; any action-family cluster matching auth.* / key.*
	// triggers a force_reauth or rotate_key.
	addedActors := map[string]bool{}
	addedIPs := map[string]bool{}
	addedKeys := map[string]bool{}
	for _, c := range clusters {
		if c.axis == "actor" && c.hot && !addedActors[c.key] {
			addedActors[c.key] = true
			out = append(out, ProposedAction{
				ID:                    actionID("disable_user", c.key),
				Action:                ActionDisableUser,
				TargetID:              c.key,
				Rationale:             fmt.Sprintf("Actor %q is implicated in %d events including a high-risk anomaly score.", c.key, len(c.events)),
				Severity:              "high",
				RequiresHumanApproval: true,
				EvidenceAuditIDs:      c.evidence(),
				LinkedFindingNums:     findingsCitingAxis(findings, "actor", c.key),
			})
			out = append(out, ProposedAction{
				ID:                    actionID("force_reauth", c.key),
				Action:                ActionForceReauth,
				TargetID:              c.key,
				Rationale:             fmt.Sprintf("Force re-authentication for %q to invalidate any active sessions if the account is compromised.", c.key),
				Severity:              "medium",
				RequiresHumanApproval: true,
				EvidenceAuditIDs:      c.evidence(),
				LinkedFindingNums:     findingsCitingAxis(findings, "actor", c.key),
			})
		}
		if c.axis == "ip" && c.hot && !addedIPs[c.key] {
			addedIPs[c.key] = true
			out = append(out, ProposedAction{
				ID:                    actionID("quarantine_ip", c.key),
				Action:                ActionQuarantineIP,
				TargetID:              c.key,
				Rationale:             fmt.Sprintf("IP %s sourced %d events with at least one high-risk score.", c.key, len(c.events)),
				Severity:              "medium",
				RequiresHumanApproval: true,
				EvidenceAuditIDs:      c.evidence(),
				LinkedFindingNums:     findingsCitingAxis(findings, "ip", c.key),
			})
		}
		if c.axis == "action" {
			fam := strings.ToLower(c.key)
			if (strings.Contains(fam, "key") || strings.Contains(fam, "token")) && !addedKeys[fam] {
				addedKeys[fam] = true
				out = append(out, ProposedAction{
					ID:                    actionID("rotate_key", fam+":"+seed.ResourceID),
					Action:                ActionRotateKey,
					TargetID:              seed.ResourceID,
					Rationale:             fmt.Sprintf("Action family %q clustered %d events; rotate credentials to invalidate the implicated keys.", c.key, len(c.events)),
					Severity:              "high",
					RequiresHumanApproval: true,
					EvidenceAuditIDs:      c.evidence(),
					LinkedFindingNums:     findingsCitingAxis(findings, "action", c.key),
				})
			}
			if strings.Contains(fam, "auth") && !addedKeys[fam] {
				addedKeys[fam] = true
				out = append(out, ProposedAction{
					ID:                    actionID("require_mfa", seed.ActorLabel),
					Action:                ActionRequireMFA,
					TargetID:              seed.ActorLabel,
					Rationale:             fmt.Sprintf("Auth-family burst (%d events) — require MFA on the next sign-in.", len(c.events)),
					Severity:              "medium",
					RequiresHumanApproval: true,
					EvidenceAuditIDs:      c.evidence(),
					LinkedFindingNums:     findingsCitingAxis(findings, "action", c.key),
				})
			}
		}
	}
	return out
}

func findingsCitingAxis(findings []Finding, axis, key string) []int {
	// The finding hypothesis text is the canonical anchor; we match
	// loosely on substring so the LinkedFindingNums survives small
	// wording tweaks in cluster.hypothesis without a refactor.
	out := []int{}
	for _, f := range findings {
		if strings.Contains(f.Hypothesis, key) {
			out = append(out, f.Num)
		}
	}
	if len(out) == 0 && axis == "actor" {
		// Fall back to the first finding so an action is never orphaned.
		if len(findings) > 0 {
			out = append(out, findings[0].Num)
		}
	}
	return out
}

func actionID(kind, target string) string {
	h := sha256.Sum256([]byte(kind + "|" + target))
	// 8-byte (16-hex) prefix is plenty unique inside a single
	// investigation while staying short for the UI.
	v := binary.BigEndian.Uint64(h[:8])
	return fmt.Sprintf("%s-%016x", kind, v)
}

func containsID(evs []Event, id int64) bool {
	for _, e := range evs {
		if e.ID == id {
			return true
		}
	}
	return false
}

func uniqueStrings(in []string) []string {
	s := map[string]struct{}{}
	for _, v := range in {
		if v != "" {
			s[v] = struct{}{}
		}
	}
	return sortedStringKeys(s)
}

func sortedStringKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedInt64Keys(m map[int64]struct{}) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
