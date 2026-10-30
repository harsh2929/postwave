// SPDX-License-Identifier: AGPL-3.0-only
//
// Package flowabtests is the operator-facing surface for in-flow A/B tests.
// The CONFIG lives in automation_flow_ab_tests (migration 0202); the automation
// engine deterministically buckets subscribers at an `ab_test` node and records
// per-variant outcomes into flow_ab_test_results (migration 1631). This package
// lets an operator define a test, read its live results, and evaluate a winner
// via a two-proportion z-test (apps/api/internal/abtests).

package flowabtests

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// winnerSignificanceAlpha is the two-tailed p-value threshold a challenger must
// beat (and beat the control's rate) to be declared a significant winner.
const winnerSignificanceAlpha = 0.05

var errNotFound = errors.New("flowabtests: not found")

// Variant mirrors the canonical AutomationSplitVariant the engine buckets on.
type Variant struct {
	ID         string `json:"id"`
	Label      string `json:"label,omitempty"`
	Percentage int    `json:"percentage,omitempty"`
	Next       string `json:"next,omitempty"`
}

// ABTest is one automation_flow_ab_tests row.
type ABTest struct {
	ID           string          `json:"id"`
	AutomationID string          `json:"automation_id,omitempty"`
	NodeID       string          `json:"node_id"`
	Status       string          `json:"status"`
	Variants     []Variant       `json:"variants"`
	Winner       json.RawMessage `json:"winner,omitempty"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

// VariantResult is one variant's live aggregate plus its derived stats.
type VariantResult struct {
	VariantID      string  `json:"variant_id"`
	Assigned       int     `json:"assigned"`
	Converted      int     `json:"converted"`
	ConversionRate float64 `json:"conversion_rate"`
}

// Repo is the data layer.
type Repo struct{ Pool *db.Pool }

const cols = `id::text, COALESCE(automation_id::text,''), node_id, status, variants, winner, created_at, updated_at`

func (r *Repo) List(ctx context.Context, tenantID, automationID string) ([]ABTest, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+cols+` FROM automation_flow_ab_tests
 WHERE tenant_id = $1::uuid AND ($2 = '' OR automation_id = NULLIF($2,'')::uuid)
 ORDER BY created_at DESC`, tenantID, automationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ABTest{}
	for rows.Next() {
		t, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func (r *Repo) Get(ctx context.Context, tenantID, id string) (*ABTest, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	t, err := scan(tx.QueryRow(ctx, `SELECT `+cols+` FROM automation_flow_ab_tests
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	return t, tx.Commit(ctx)
}

func (r *Repo) Create(ctx context.Context, tenantID, automationID, nodeID string, variants []Variant) (*ABTest, error) {
	vraw, _ := json.Marshal(variants)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	t, err := scan(tx.QueryRow(ctx, `
INSERT INTO automation_flow_ab_tests (tenant_id, automation_id, node_id, status, variants)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, 'draft', $4::jsonb)
RETURNING `+cols, tenantID, automationID, nodeID, string(vraw)))
	if err != nil {
		return nil, err
	}
	return t, tx.Commit(ctx)
}

func (r *Repo) Update(ctx context.Context, tenantID, id, status string, variants []Variant) (*ABTest, error) {
	vraw, _ := json.Marshal(variants)
	hasVariants := variants != nil
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	t, err := scan(tx.QueryRow(ctx, `
UPDATE automation_flow_ab_tests
   SET status   = COALESCE(NULLIF($3,''), status),
       variants = CASE WHEN $4 THEN $5::jsonb ELSE variants END,
       started_at = CASE WHEN $3 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
       ended_at   = CASE WHEN $3 IN ('completed','archived') THEN now() ELSE ended_at END,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING `+cols, tenantID, id, status, hasVariants, string(vraw)))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	return t, tx.Commit(ctx)
}

func (r *Repo) Delete(ctx context.Context, tenantID, id string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM automation_flow_ab_tests WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, tx.Commit(ctx)
}

// Results aggregates the live per-variant counters for a test's node.
func (r *Repo) Results(ctx context.Context, tenantID, automationID, nodeID string) ([]VariantResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT variant_id, assigned, converted
  FROM flow_ab_test_results
 WHERE tenant_id = $1::uuid AND automation_id = $2::uuid AND node_id = $3
 ORDER BY variant_id`, tenantID, automationID, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []VariantResult{}
	for rows.Next() {
		var v VariantResult
		if err := rows.Scan(&v.VariantID, &v.Assigned, &v.Converted); err != nil {
			return nil, err
		}
		if v.Assigned > 0 {
			v.ConversionRate = float64(v.Converted) / float64(v.Assigned)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (r *Repo) setWinner(ctx context.Context, tenantID, id string, winner []byte) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE automation_flow_ab_tests
   SET winner = $3::jsonb, status = 'completed', ended_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id, string(winner))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return tx.Commit(ctx)
}

func scan(row pgx.Row) (*ABTest, error) {
	var t ABTest
	var vraw, wraw []byte
	if err := row.Scan(&t.ID, &t.AutomationID, &t.NodeID, &t.Status, &vraw, &wraw, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(vraw, &t.Variants)
	if len(wraw) > 0 && string(wraw) != "{}" {
		t.Winner = json.RawMessage(wraw)
	}
	return &t, nil
}

// WinnerVerdict is what an evaluation writes into the test's winner column.
type WinnerVerdict struct {
	VariantID      string          `json:"variant_id"`
	ConversionRate float64         `json:"conversion_rate"`
	PValue         float64         `json:"p_value"`
	Significant    bool            `json:"significant"`
	Method         string          `json:"method"`
	Results        []VariantResult `json:"results"`
	EvaluatedAt    time.Time       `json:"evaluated_at"`
	Inconclusive   bool            `json:"inconclusive,omitempty"`
}

// evaluateWinner runs the z-test against the CONFIGURED control (controlID =
// the test's Variants[0].ID), not a positional results[0] — Results returns
// rows ordered by variant_id, so the control must be selected by identity. The
// challenger with the best conversion rate that is significantly better than
// the control (two-proportion z, p < alpha, and both legs have data) wins; else
// the best-rate variant, marked inconclusive.
func evaluateWinner(results []VariantResult, controlID string, now time.Time) WinnerVerdict {
	v := WinnerVerdict{Method: "two_proportion_z", Results: results, EvaluatedAt: now}
	if len(results) == 0 {
		v.Inconclusive = true
		return v
	}
	// Locate the configured control by id; fall back to the first row only if
	// the configured control produced no results yet.
	controlIdx := 0
	for i, r := range results {
		if r.VariantID == controlID {
			controlIdx = i
			break
		}
	}
	control := results[controlIdx]
	best := control
	var bestP float64 = 1
	bestSignificant := false
	for i := range results {
		if i == controlIdx {
			continue
		}
		ch := results[i]
		test := abtests.TwoProportionTest(
			abtests.VariantCounts{Sent: control.Assigned, Hits: control.Converted},
			abtests.VariantCounts{Sent: ch.Assigned, Hits: ch.Converted},
		)
		// Both legs must have data for the comparison to be meaningful (a
		// 0-assignment control would otherwise make every challenger "win").
		significant := control.Assigned > 0 && ch.Assigned > 0 &&
			test.PValue < winnerSignificanceAlpha && ch.ConversionRate > control.ConversionRate
		if significant && (!bestSignificant || ch.ConversionRate > best.ConversionRate) {
			best, bestP, bestSignificant = ch, test.PValue, true
		} else if !bestSignificant && ch.ConversionRate > best.ConversionRate {
			best, bestP = ch, test.PValue
		}
	}
	v.VariantID = best.VariantID
	v.ConversionRate = best.ConversionRate
	v.PValue = bestP
	v.Significant = bestSignificant
	v.Inconclusive = !bestSignificant
	return v
}

// controlVariantID returns the configured control's id (Variants[0].ID), or ""
// when the test has no variants.
func controlVariantID(t *ABTest) string {
	if t == nil || len(t.Variants) == 0 {
		return ""
	}
	return t.Variants[0].ID
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
	now    func() time.Time
}

func (d *Deps) clock() time.Time {
	if d.now != nil {
		return d.now()
	}
	return time.Now().UTC()
}

func (d *Deps) MountRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/flow-builder/ab-tests", d.List)
	r.With(write).Post("/api/v1/flow-builder/ab-tests", d.Create)
	r.With(read).Get("/api/v1/flow-builder/ab-tests/{id}", d.Get)
	r.With(write).Patch("/api/v1/flow-builder/ab-tests/{id}", d.Update)
	r.With(write).Delete("/api/v1/flow-builder/ab-tests/{id}", d.Delete)
	r.With(read).Get("/api/v1/flow-builder/ab-tests/{id}/results", d.Results)
	r.With(write).Post("/api/v1/flow-builder/ab-tests/{id}/evaluate", d.Evaluate)
}

func (d *Deps) tenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return "", false
	}
	return t.ID, true
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Repo.List(r.Context(), tid, r.URL.Query().Get("automation_id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

type createInput struct {
	AutomationID string    `json:"automation_id"`
	NodeID       string    `json:"node_id"`
	Variants     []Variant `json:"variants"`
}

func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	var in createInput
	if err := httpbody.DecodeJSON(w, r, 64<<10, &in); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_body", "request body must be valid JSON")
		return
	}
	if in.NodeID == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "node_id is required")
		return
	}
	if len(in.Variants) < 2 {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "an A/B test needs at least 2 variants")
		return
	}
	t, err := d.Repo.Create(r.Context(), tid, in.AutomationID, in.NodeID, in.Variants)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	t, err := d.Repo.Get(r.Context(), tid, chi.URLParam(r, "id"))
	if d.notFound(w, err, tid, r) {
		return
	}
	writeJSON(w, http.StatusOK, t)
}

type updateInput struct {
	Status   string    `json:"status"`
	Variants []Variant `json:"variants"`
}

func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	var in updateInput
	if err := httpbody.DecodeJSON(w, r, 64<<10, &in); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_body", "request body must be valid JSON")
		return
	}
	if in.Variants != nil && len(in.Variants) < 2 {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "an A/B test needs at least 2 variants")
		return
	}
	t, err := d.Repo.Update(r.Context(), tid, chi.URLParam(r, "id"), in.Status, in.Variants)
	if d.notFound(w, err, tid, r) {
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	deleted, err := d.Repo.Delete(r.Context(), tid, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	if !deleted {
		httperror.Write(w, http.StatusNotFound, "not_found", "ab test not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) Results(w http.ResponseWriter, r *http.Request) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	t, err := d.Repo.Get(r.Context(), tid, chi.URLParam(r, "id"))
	if d.notFound(w, err, tid, r) {
		return
	}
	res, err := d.Repo.Results(r.Context(), tid, t.AutomationID, t.NodeID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": res})
}

func (d *Deps) Evaluate(w http.ResponseWriter, r *http.Request) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	t, err := d.Repo.Get(r.Context(), tid, chi.URLParam(r, "id"))
	if d.notFound(w, err, tid, r) {
		return
	}
	res, err := d.Repo.Results(r.Context(), tid, t.AutomationID, t.NodeID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	verdict := evaluateWinner(res, controlVariantID(t), d.clock())
	raw, _ := json.Marshal(verdict)
	if err := d.Repo.setWinner(r.Context(), tid, t.ID, raw); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusOK, verdict)
}

func (d *Deps) notFound(w http.ResponseWriter, err error, tid string, r *http.Request) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "ab test not found")
		return true
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
	return true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
