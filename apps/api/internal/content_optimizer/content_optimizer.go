// SPDX-License-Identifier: AGPL-3.0-only
//
// Package content_optimizer provides a campaign-level combinatorial optimizer
// backbone: operators can preview deterministic allocations across content
// arms, then persist a run that future send workers can read when selecting
// subject/body combinations.
package content_optimizer

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const optimizerJSONMaxBodyBytes int64 = 256 << 10

type Repo struct {
	Pool *db.Pool
}

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

type ArmInput struct {
	Key         string         `json:"key,omitempty"`
	Subject     string         `json:"subject,omitempty"`
	PreviewText string         `json:"preview_text,omitempty"`
	BodyHTML    string         `json:"body_html,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type PreviewInput struct {
	Arms             []ArmInput `json:"arms,omitempty"`
	ExplorationRate  float64    `json:"exploration_rate,omitempty"`
	MaxActiveArms    int        `json:"max_active_arms,omitempty"`
	PrimaryMetric    string     `json:"primary_metric,omitempty"`
	MinSamplePerArm  int        `json:"min_sample_per_arm,omitempty"`
	PersistAsRun     bool       `json:"persist_as_run,omitempty"`
	ActivationStatus string     `json:"activation_status,omitempty"`
}

type ArmAllocation struct {
	Key                 string         `json:"key"`
	Subject             string         `json:"subject,omitempty"`
	PreviewText         string         `json:"preview_text,omitempty"`
	AllocationPercent   float64        `json:"allocation_percent"`
	ExplorationPercent  float64        `json:"exploration_percent"`
	ExploitationPercent float64        `json:"exploitation_percent"`
	Score               float64        `json:"score"`
	Reason              string         `json:"reason"`
	Metadata            map[string]any `json:"metadata,omitempty"`
}

type PreviewResponse struct {
	CampaignID      string          `json:"campaign_id"`
	Method          string          `json:"method"`
	PrimaryMetric   string          `json:"primary_metric"`
	ExplorationRate float64         `json:"exploration_rate"`
	MinSamplePerArm int             `json:"min_sample_per_arm"`
	RecommendedArms []ArmAllocation `json:"recommended_arms"`
	GeneratedAt     time.Time       `json:"generated_at"`
	RunID           string          `json:"run_id,omitempty"`
}

type Run struct {
	ID         string          `json:"id"`
	CampaignID string          `json:"campaign_id"`
	Status     string          `json:"status"`
	Config     map[string]any  `json:"config"`
	Preview    PreviewResponse `json:"preview"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns, apikeys.ScopeReadReports)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns, apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/campaigns/{id}/content-optimizer", d.get)
	r.With(read).Post("/api/v1/campaigns/{id}/content-optimizer/preview", d.preview)
	r.With(write).Post("/api/v1/campaigns/{id}/content-optimizer", d.createRun)
}

func (d *Deps) get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.GetLatestRun(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "optimizer run not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) preview(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PreviewInput
	if err := httpbody.DecodeJSON(w, r, optimizerJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.Preview(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "campaign_not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) createRun(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PreviewInput
	if err := httpbody.DecodeJSON(w, r, optimizerJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.CreateRun(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "campaign_not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (r *Repo) Preview(ctx context.Context, tenantID, campaignID string, in PreviewInput) (*PreviewResponse, error) {
	arms, err := r.loadArms(ctx, tenantID, campaignID, in.Arms)
	if err != nil {
		return nil, err
	}
	if len(arms) == 0 {
		arms = []ArmInput{{Key: "control"}}
	}
	if in.ExplorationRate <= 0 || in.ExplorationRate > 0.8 {
		in.ExplorationRate = 0.2
	}
	if in.MaxActiveArms <= 0 || in.MaxActiveArms > 12 {
		in.MaxActiveArms = 6
	}
	if in.MinSamplePerArm <= 0 {
		in.MinSamplePerArm = 250
	}
	if strings.TrimSpace(in.PrimaryMetric) == "" {
		in.PrimaryMetric = "click_rate"
	}
	scored := make([]ArmAllocation, 0, len(arms))
	for _, arm := range arms {
		score := deterministicScore(campaignID, arm)
		scored = append(scored, ArmAllocation{
			Key:         stableArmKey(arm),
			Subject:     strings.TrimSpace(arm.Subject),
			PreviewText: strings.TrimSpace(arm.PreviewText),
			Score:       score,
			Reason:      "Deterministic bootstrap score until live performance data is available.",
			Metadata:    arm.Metadata,
		})
	}
	sort.Slice(scored, func(i, j int) bool { return scored[i].Score > scored[j].Score })
	if len(scored) > in.MaxActiveArms {
		scored = scored[:in.MaxActiveArms]
	}
	totalScore := 0.0
	for _, arm := range scored {
		totalScore += arm.Score
	}
	if totalScore <= 0 {
		totalScore = float64(len(scored))
	}
	exploreEach := in.ExplorationRate / float64(len(scored))
	for i := range scored {
		exploit := (1 - in.ExplorationRate) * (scored[i].Score / totalScore)
		scored[i].ExplorationPercent = roundPct(exploreEach * 100)
		scored[i].ExploitationPercent = roundPct(exploit * 100)
		scored[i].AllocationPercent = roundPct((exploreEach + exploit) * 100)
	}
	return &PreviewResponse{
		CampaignID:      campaignID,
		Method:          "deterministic_ucb_bootstrap",
		PrimaryMetric:   strings.TrimSpace(in.PrimaryMetric),
		ExplorationRate: in.ExplorationRate,
		MinSamplePerArm: in.MinSamplePerArm,
		RecommendedArms: scored,
		GeneratedAt:     time.Now().UTC(),
	}, nil
}

func (r *Repo) CreateRun(ctx context.Context, tenantID, campaignID string, in PreviewInput) (*Run, error) {
	preview, err := r.Preview(ctx, tenantID, campaignID, in)
	if err != nil {
		return nil, err
	}
	status := strings.ToLower(strings.TrimSpace(in.ActivationStatus))
	if status == "" {
		status = "draft"
	}
	if status != "draft" && status != "active" && status != "paused" {
		status = "draft"
	}
	config := map[string]any{
		"arms":               in.Arms,
		"exploration_rate":   preview.ExplorationRate,
		"primary_metric":     preview.PrimaryMetric,
		"min_sample_per_arm": preview.MinSamplePerArm,
		"method":             preview.Method,
	}
	configRaw, _ := json.Marshal(config)
	previewRaw, _ := json.Marshal(preview)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out Run
	var configBytes, previewBytes []byte
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_content_optimizer_runs
    (tenant_id, campaign_id, status, config, preview, updated_at)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, now())
RETURNING id::text, campaign_id::text, status, config, preview, created_at, updated_at`,
		tenantID, campaignID, status, string(configRaw), string(previewRaw)).
		Scan(&out.ID, &out.CampaignID, &out.Status, &configBytes, &previewBytes, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(configBytes, &out.Config)
	_ = json.Unmarshal(previewBytes, &out.Preview)
	out.Preview.RunID = out.ID
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *Repo) GetLatestRun(ctx context.Context, tenantID, campaignID string) (*Run, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out Run
	var configBytes, previewBytes []byte
	err = tx.QueryRow(ctx, `
SELECT id::text, campaign_id::text, status, config, preview, created_at, updated_at
  FROM campaign_content_optimizer_runs
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2
 ORDER BY created_at DESC
 LIMIT 1`, tenantID, campaignID).
		Scan(&out.ID, &out.CampaignID, &out.Status, &configBytes, &previewBytes, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(configBytes, &out.Config)
	_ = json.Unmarshal(previewBytes, &out.Preview)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *Repo) loadArms(ctx context.Context, tenantID, campaignID string, extra []ArmInput) ([]ArmInput, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subject, preview, body string
	var variantsRaw []byte
	err = tx.QueryRow(ctx, `
SELECT COALESCE(subject, ''), COALESCE(preview_text, ''), COALESCE(body_html, ''), variants
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, campaignID).
		Scan(&subject, &preview, &body, &variantsRaw)
	if err != nil {
		return nil, err
	}
	arms := []ArmInput{{
		Key:         "control",
		Subject:     subject,
		PreviewText: preview,
		BodyHTML:    body,
		Metadata:    map[string]any{"source": "campaign"},
	}}
	var variants []map[string]any
	_ = json.Unmarshal(variantsRaw, &variants)
	for i, v := range variants {
		arms = append(arms, ArmInput{
			Key:         stringFromMap(v, "key", "id", "variant_id", "name"),
			Subject:     stringFromMap(v, "subject", "subject_line"),
			PreviewText: stringFromMap(v, "preview_text", "preview"),
			BodyHTML:    stringFromMap(v, "body_html", "html"),
			Metadata: map[string]any{
				"source":        "campaign_variant",
				"variant_index": i,
			},
		})
	}
	for _, arm := range extra {
		arm.Key = strings.TrimSpace(arm.Key)
		if arm.Metadata == nil {
			arm.Metadata = map[string]any{"source": "request"}
		}
		arms = append(arms, arm)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return arms, nil
}

func deterministicScore(campaignID string, arm ArmInput) float64 {
	h := sha1.Sum([]byte(campaignID + "\x00" + stableArmKey(arm) + "\x00" + arm.Subject + "\x00" + arm.PreviewText))
	n := int(h[0])<<8 + int(h[1])
	jitter := float64(n%1000) / 1000.0
	subjectBonus := math.Min(float64(len(strings.TrimSpace(arm.Subject)))/120.0, 0.35)
	previewBonus := math.Min(float64(len(strings.TrimSpace(arm.PreviewText)))/180.0, 0.2)
	return 1 + jitter + subjectBonus + previewBonus
}

func stableArmKey(arm ArmInput) string {
	if key := strings.TrimSpace(arm.Key); key != "" {
		return key
	}
	h := sha1.Sum([]byte(arm.Subject + "\x00" + arm.PreviewText + "\x00" + arm.BodyHTML))
	return "arm_" + hex.EncodeToString(h[:4])
}

func roundPct(v float64) float64 {
	return math.Round(v*100) / 100
}

func stringFromMap(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if v, ok := m[key].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
