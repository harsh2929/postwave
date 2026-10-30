// SPDX-License-Identifier: AGPL-3.0-only
//
// Package sto_content_optimizer scaffolds the Phase 3 XL feature
// `sto-content-optimizer-combinatorial-bandit` — a combinatorial
// multi-armed bandit over (subject × header × body × CTA) components
// for a campaign.
//
// Vendor parity targets:
//
//   - Braze Content Optimizer: tests up to 125 email combinations using
//     a non-contextual MAB adapted for combinatorial messaging.
//     Component-level learning shares evidence between combinations
//     that reuse a winning subject (or body, or CTA).
//
//   - MoEngage Dynamic Multivariate Experiment: a Bayesian bandit
//     replacing fixed-split A/B; supports a "warm-up" period and an
//     epsilon-exploration floor.
//
// Moosewave's existing `abtests` package is a fixed-split z-test design.
// It cannot search a combinatorial space: a 5x5x5 grid (125 arms) needs
// ~500k recipients per arm to reach significance under fixed-split. The
// Thompson-sampling decomposition reuses each subject's evidence
// across every arm that includes it, dropping the data requirement by
// roughly the size of the per-component pool.
//
// SHIP STATUS: scaffold only. The HTTP surface, repo, and worker
// skeleton compile and return sensible placeholders. The actual
// posterior update and traffic-allocation math live in
// MIGRATION.md as deferred work — see that file for the multi-week
// breakdown.
//
// Surfaces (mounted by Deps.MountRoutes):
//
//	POST /api/v1/campaigns/{id}/optimizer/runs        (scope: write_campaigns)
//	  body: { name, objective, components, min_impressions_per_arm,
//	          exploration_floor }
//	  -> { run: OptimizerRun }   // 201
//
//	GET  /api/v1/campaigns/{id}/optimizer/runs        (scope: read_campaigns)
//	  -> { runs: [OptimizerRun] }
//
//	GET  /api/v1/optimizer/runs/{run_id}              (scope: read_campaigns)
//	  -> { run: OptimizerRun, arms: [OptimizerArm] }
//
//	POST /api/v1/optimizer/runs/{run_id}/start        (scope: write_campaigns)
//	  -> { run: OptimizerRun }   // transitions status draft -> exploring
//
//	POST /api/v1/optimizer/runs/{run_id}/complete     (scope: write_campaigns)
//	  -> { run: OptimizerRun }   // transitions to completed and freezes allocation
package sto_content_optimizer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MaxArms caps the cartesian product of components per run. Matches the
// 125-combination ceiling Braze documents (5 components × 5 variants
// each, roughly). The handler rejects manifests whose product exceeds
// this value with `arms_overflow`.
const MaxArms = 125

// MaxComponentVariants caps any single component slot at 5 variants —
// keeps the cartesian product bounded even when an operator submits a
// lopsided manifest (e.g. 25 subjects × 1 body × 1 CTA).
const MaxComponentVariants = 5

// optimizerJSONMaxBodyBytes bounds inbound run manifests. Subject + body
// MJML can be a few KiB each; 256 KiB is comfortably above realistic
// payloads without being open-ended.
const optimizerJSONMaxBodyBytes int64 = 256 << 10

// Objective is the bandit's optimization signal. We support the same
// three signals the existing A/B picker exposes plus an explicit
// conversion-rate path; the trainer treats them identically as a
// Bernoulli reward.
type Objective string

const (
	ObjectiveOpenRate       Objective = "open_rate"
	ObjectiveClickRate      Objective = "click_rate"
	ObjectiveConversionRate Objective = "conversion_rate"
)

// Valid reports whether o is a known Objective.
func (o Objective) Valid() bool {
	switch o {
	case ObjectiveOpenRate, ObjectiveClickRate, ObjectiveConversionRate:
		return true
	}
	return false
}

// Status is the run's lifecycle phase.
type Status string

const (
	StatusDraft      Status = "draft"
	StatusExploring  Status = "exploring"
	StatusExploiting Status = "exploiting"
	StatusCompleted  Status = "completed"
	StatusAborted    Status = "aborted"
)

// ComponentName enumerates the four component slots a run decomposes
// into. The schema is open-ended (jsonb) so a future slot (preheader,
// from-name, sender) is additive — but v1 ships with this fixed set
// because the parity vendors test exactly these four.
type ComponentName string

const (
	ComponentSubject ComponentName = "subject"
	ComponentHeader  ComponentName = "header"
	ComponentBody    ComponentName = "body"
	ComponentCTA     ComponentName = "cta"
)

// ComponentVariant is one variant of one component slot. The payload is
// shape-dependent: a subject has `text`, a header/body has `mjml`, a
// CTA has `label`+`url`. We keep it as a single struct with optional
// fields so the operator-facing JSON is uniform.
type ComponentVariant struct {
	ID    string `json:"id"`
	Text  string `json:"text,omitempty"`
	MJML  string `json:"mjml,omitempty"`
	Label string `json:"label,omitempty"`
	URL   string `json:"url,omitempty"`
}

// ComponentsManifest is the operator-submitted manifest of variants
// per component. Persisted as jsonb in `email_optimizer_runs.components`.
type ComponentsManifest struct {
	Subject []ComponentVariant `json:"subject,omitempty"`
	Header  []ComponentVariant `json:"header,omitempty"`
	Body    []ComponentVariant `json:"body,omitempty"`
	CTA     []ComponentVariant `json:"cta,omitempty"`
}

// OptimizerRun is one optimizer-run row.
type OptimizerRun struct {
	ID                   string             `json:"id"`
	TenantID             string             `json:"tenant_id"`
	CampaignID           string             `json:"campaign_id"`
	Name                 string             `json:"name,omitempty"`
	Objective            Objective          `json:"objective"`
	Status               Status             `json:"status"`
	Components           ComponentsManifest `json:"components"`
	TrafficAllocation    map[string]float64 `json:"traffic_allocation"`
	ModelState           json.RawMessage    `json:"model_state,omitempty"`
	MinImpressionsPerArm int                `json:"min_impressions_per_arm"`
	ExplorationFloor     float64            `json:"exploration_floor"`
	CreatedAt            time.Time          `json:"created_at"`
	UpdatedAt            time.Time          `json:"updated_at"`
	CompletedAt          *time.Time         `json:"completed_at,omitempty"`
}

// OptimizerArm is one materialised cartesian arm.
type OptimizerArm struct {
	ID             string            `json:"id"`
	RunID          string            `json:"run_id"`
	TenantID       string            `json:"tenant_id"`
	ComponentIDs   map[string]string `json:"component_ids"`
	Impressions    int64             `json:"impressions"`
	Conversions    int64             `json:"conversions"`
	PosteriorAlpha float64           `json:"posterior_alpha"`
	PosteriorBeta  float64           `json:"posterior_beta"`
	LastAssignedAt *time.Time        `json:"last_assigned_at,omitempty"`
	CreatedAt      time.Time         `json:"created_at"`
}

// Deps wires the handlers + worker to their dependencies.
type Deps struct {
	Pool   *db.Pool
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes wires the operator-facing routes. Mounts under the
// per-tenant middleware stack (parent caller already runs the
// `tenant` resolver + `apikeys` claims).
func (d *Deps) MountRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/optimizer/runs", d.CreateRun)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaigns/{id}/optimizer/runs", d.ListRuns)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/optimizer/runs/{run_id}", d.GetRun)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/optimizer/runs/{run_id}/start", d.StartRun)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/optimizer/runs/{run_id}/complete", d.CompleteRun)
}

/* ---------- CreateRun --------------------------------------------- */

// CreateRunInput is the POST /campaigns/{id}/optimizer/runs body.
type CreateRunInput struct {
	Name                 string             `json:"name,omitempty"`
	Objective            Objective          `json:"objective,omitempty"`
	Components           ComponentsManifest `json:"components"`
	MinImpressionsPerArm int                `json:"min_impressions_per_arm,omitempty"`
	ExplorationFloor     float64            `json:"exploration_floor,omitempty"`
}

// CreateRun handles POST /api/v1/campaigns/{id}/optimizer/runs.
//
// Validates the manifest, materialises the cartesian arms (capped at
// MaxArms), seeds each arm's posterior at Beta(1,1) (uniform prior),
// and persists everything in a single tenant-scoped transaction.
//
// Returns 201 with the freshly created OptimizerRun.
func (d *Deps) CreateRun(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")
	if campaignID == "" {
		writeErr(w, http.StatusBadRequest, "bad_campaign", "campaign id required")
		return
	}

	var in CreateRunInput
	if err := httpbody.DecodeJSON(w, r, optimizerJSONMaxBodyBytes, &in); err != nil {
		httperror.WriteValidation(w, httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Objective == "" {
		in.Objective = ObjectiveClickRate
	}
	if !in.Objective.Valid() {
		writeErr(w, http.StatusBadRequest, "bad_objective",
			"objective must be open_rate, click_rate, or conversion_rate")
		return
	}
	if err := validateManifest(in.Components); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	armCount := cartesianCount(in.Components)
	if armCount == 0 {
		writeErr(w, http.StatusBadRequest, "no_arms",
			"manifest produced 0 arms — every named component slot must have at least one variant")
		return
	}
	if armCount > MaxArms {
		writeErr(w, http.StatusBadRequest, "arms_overflow",
			fmt.Sprintf("manifest produced %d arms, max is %d", armCount, MaxArms))
		return
	}
	if in.MinImpressionsPerArm <= 0 {
		in.MinImpressionsPerArm = 100
	}
	if in.ExplorationFloor < 0 {
		in.ExplorationFloor = 0
	}
	if in.ExplorationFloor > 1 {
		in.ExplorationFloor = 1
	}

	run := OptimizerRun{
		TenantID:             t.ID,
		CampaignID:           campaignID,
		Name:                 strings.TrimSpace(in.Name),
		Objective:            in.Objective,
		Status:               StatusDraft,
		Components:           in.Components,
		TrafficAllocation:    uniformAllocation(in.Components),
		MinImpressionsPerArm: in.MinImpressionsPerArm,
		ExplorationFloor:     in.ExplorationFloor,
	}

	saved, err := d.Repo.CreateRun(r.Context(), &run)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"run": saved})
}

/* ---------- ListRuns ---------------------------------------------- */

// ListRuns handles GET /api/v1/campaigns/{id}/optimizer/runs.
func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")
	runs, err := d.Repo.ListRunsForCampaign(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}

/* ---------- GetRun ------------------------------------------------ */

// GetRun handles GET /api/v1/optimizer/runs/{run_id}.
func (d *Deps) GetRun(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runID := chi.URLParam(r, "run_id")
	run, arms, err := d.Repo.GetRunWithArms(r.Context(), t.ID, runID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "run not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"run":  run,
		"arms": arms,
	})
}

/* ---------- StartRun --------------------------------------------- */

// StartRun handles POST /api/v1/optimizer/runs/{run_id}/start.
//
// Transitions the run from `draft` to `exploring`. The actual
// traffic-assignment hook into the sending pipeline is deferred —
// today this only flips the status and stamps started_at so the
// desktop reflects the user's intent.
func (d *Deps) StartRun(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runID := chi.URLParam(r, "run_id")
	run, err := d.Repo.UpdateStatus(r.Context(), t.ID, runID, StatusDraft, StatusExploring)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "not_found", "run not found")
		case errors.Is(err, ErrBadTransition):
			writeErr(w, http.StatusConflict, "bad_transition",
				"run must be in draft to start")
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run": run})
}

/* ---------- CompleteRun ------------------------------------------ */

// CompleteRun handles POST /api/v1/optimizer/runs/{run_id}/complete.
//
// Freezes the bandit at its current posterior. The remaining traffic
// goes to the arm with the highest mean estimate — a simple
// "exploit-only" terminal phase. Full ship will run a winner-significance
// check first; that math is deferred.
func (d *Deps) CompleteRun(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runID := chi.URLParam(r, "run_id")
	run, err := d.Repo.MarkCompleted(r.Context(), t.ID, runID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "run not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run": run})
}

/* ---------- Worker stub ------------------------------------------ */

// Worker is the background trainer skeleton.
//
// Lifecycle (deferred — see MIGRATION.md):
//
//  1. Tick every `interval` (default 1m).
//  2. For each tenant with an `exploring` or `exploiting` run, acquire
//     the worker scope (db.WithWorkerScope) and:
//     a. Pull recent campaign_report_events scoped to the run's
//     campaign + (open|click|conversion) signal matching the
//     objective.
//     b. Join to email_optimizer_assignments by (run_id, subscriber_email)
//     to attribute the signal to an arm. Stamp converted_at.
//     c. Increment per-arm `impressions` (from assigned rows seen for
//     the first time) and `conversions` (from newly-stamped
//     converted_at rows).
//     d. Recompute per-component Beta(α,β) posteriors from the arm
//     counters (sum over arms that include each component variant).
//     e. Recompute per-arm `posterior_alpha`/`posterior_beta` from the
//     component posteriors (the combinatorial decomposition step).
//     f. Resample with Thompson to produce the next
//     `traffic_allocation` map.
//  3. When an arm satisfies the warm-up + significance criteria,
//     transition the run from `exploring` to `exploiting` (allocation
//     shifts towards the leader but keeps an `exploration_floor`).
//  4. When the operator (or a schedule) calls /complete, terminal-stamp.
//
// The current implementation only ticks and logs the count of
// outstanding runs — the Bayesian update lives behind a feature flag
// that's still off.
type Worker struct {
	Repo     *Repo
	Pool     *db.Pool
	Interval time.Duration
}

// Run runs the trainer loop until ctx is cancelled.
//
// SCAFFOLD: the loop is wired but the only real work is a count query
// so the operator can see "yes, the worker is alive". The math is
// deferred — see MIGRATION.md "Trainer math" section.
func (wkr *Worker) Run(ctx context.Context) error {
	if wkr.Interval <= 0 {
		wkr.Interval = time.Minute
	}
	t := time.NewTicker(wkr.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			// Placeholder: future work iterates active runs here.
			// For the scaffold we deliberately do nothing so the
			// worker is safe to enable in production without surprise.
			_ = wkr.tickStub(ctx)
		}
	}
}

// tickStub is a no-op placeholder for the trainer body. Kept as a
// separate method so the deferred work can drop into one file without
// touching Worker.Run.
func (wkr *Worker) tickStub(ctx context.Context) error {
	// Trainer math now lives in trainer.go: recompute Beta posteriors +
	// Thompson-resample traffic for every running run.
	if wkr == nil || wkr.Repo == nil {
		return nil
	}
	return wkr.trainAll(ctx)
}

/* ---------- helpers ----------------------------------------------- */

// validateManifest enforces the per-component caps and that at least
// one component slot is populated.
func validateManifest(m ComponentsManifest) error {
	total := 0
	for name, vs := range allSlots(m) {
		if len(vs) > MaxComponentVariants {
			return fmt.Errorf("component %q has %d variants, max is %d",
				name, len(vs), MaxComponentVariants)
		}
		seen := map[string]struct{}{}
		for _, v := range vs {
			if strings.TrimSpace(v.ID) == "" {
				return fmt.Errorf("component %q has a variant with empty id", name)
			}
			if _, dup := seen[v.ID]; dup {
				return fmt.Errorf("component %q has duplicate variant id %q", name, v.ID)
			}
			seen[v.ID] = struct{}{}
		}
		total += len(vs)
	}
	if total == 0 {
		return errors.New("manifest must contain at least one component variant")
	}
	return nil
}

// allSlots returns a name->slice view over the manifest. Stable order
// is not required because the cartesian product is commutative.
func allSlots(m ComponentsManifest) map[ComponentName][]ComponentVariant {
	return map[ComponentName][]ComponentVariant{
		ComponentSubject: m.Subject,
		ComponentHeader:  m.Header,
		ComponentBody:    m.Body,
		ComponentCTA:     m.CTA,
	}
}

// cartesianCount returns the product of populated component slot sizes.
// Empty slots are skipped — a manifest with only subject + cta produces
// |subject| * |cta| arms, not zero.
func cartesianCount(m ComponentsManifest) int {
	product := 1
	any := false
	for _, vs := range allSlots(m) {
		if len(vs) == 0 {
			continue
		}
		any = true
		product *= len(vs)
		if product > MaxArms*10 {
			// Saturate so we don't overflow when the operator
			// sends an absurd payload — the handler still rejects
			// at the MaxArms gate.
			return product
		}
	}
	if !any {
		return 0
	}
	return product
}

// uniformAllocation is the initial traffic-allocation map: every arm
// gets 1/N. The trainer overwrites this once the posterior shifts.
//
// The map is keyed by the canonical component-id tuple
// (`subject=s1;header=h1;...`) so a downstream worker can look up an
// arm without having to round-trip through Repo.
func uniformAllocation(m ComponentsManifest) map[string]float64 {
	keys := cartesianKeys(m)
	if len(keys) == 0 {
		return map[string]float64{}
	}
	w := 1.0 / float64(len(keys))
	out := make(map[string]float64, len(keys))
	for _, k := range keys {
		out[k] = w
	}
	return out
}

// cartesianKeys enumerates every (subject,header,body,cta) tuple as a
// canonical string key. Slots with no variants are represented by the
// empty string in the key so the order is stable.
func cartesianKeys(m ComponentsManifest) []string {
	slots := []struct {
		name ComponentName
		vs   []ComponentVariant
	}{
		{ComponentSubject, m.Subject},
		{ComponentHeader, m.Header},
		{ComponentBody, m.Body},
		{ComponentCTA, m.CTA},
	}
	// Build the cartesian product iteratively.
	type pick struct {
		name ComponentName
		id   string
	}
	frontier := [][]pick{{}}
	for _, s := range slots {
		if len(s.vs) == 0 {
			continue
		}
		next := make([][]pick, 0, len(frontier)*len(s.vs))
		for _, base := range frontier {
			for _, v := range s.vs {
				clone := make([]pick, len(base), len(base)+1)
				copy(clone, base)
				clone = append(clone, pick{name: s.name, id: v.ID})
				next = append(next, clone)
			}
		}
		frontier = next
	}
	out := make([]string, 0, len(frontier))
	for _, picks := range frontier {
		var sb strings.Builder
		for i, p := range picks {
			if i > 0 {
				sb.WriteByte(';')
			}
			sb.WriteString(string(p.name))
			sb.WriteByte('=')
			sb.WriteString(p.id)
		}
		out = append(out, sb.String())
	}
	return out
}

// armComponentIDsFromKey decodes a canonical "subject=s1;header=h1" key
// back into the {name->id} map persisted in email_optimizer_arms.
func armComponentIDsFromKey(key string) map[string]string {
	out := map[string]string{}
	if key == "" {
		return out
	}
	for _, part := range strings.Split(key, ";") {
		eq := strings.IndexByte(part, '=')
		if eq <= 0 {
			continue
		}
		out[part[:eq]] = part[eq+1:]
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
