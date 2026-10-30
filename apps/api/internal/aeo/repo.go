// SPDX-License-Identifier: AGPL-3.0-only
//
// Repo wraps the SQL surface for the aeo_* tables. All reads / writes
// go through db.WithTenant so the NULLIF GUC RLS idiom from 0079 stays
// in force.

package aeo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a single-row lookup misses.
var ErrNotFound = errors.New("aeo: not found")

// ErrCompetitorCap is returned by UpsertCompetitor when the tenant
// has already hit MaxCompetitors and is trying to insert a new row
// (updates to existing rows are unaffected).
var ErrCompetitorCap = errors.New("aeo: competitor cap reached")

// Repo is the data-access layer.
type Repo struct {
	Pool *db.Pool
}

// GetSettings returns the tenant's settings row, or defaults +
// ErrNotFound when no row exists yet. Default-on-miss means render-time
// callers never have to special-case "tenant has never opened the AEO
// settings panel".
func (r *Repo) GetSettings(ctx context.Context, tenantID string) (Settings, error) {
	def := DefaultSettings()
	def.TenantID = tenantID

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return def, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		s             Settings
		brandTermsRaw []byte
		enginesRaw    []byte
		credStatus    string
		promptPack    string
	)
	s.TenantID = tenantID
	err = tx.QueryRow(ctx, `
SELECT enabled, brand_terms, brand_domain, probe_prompt_pack,
       probe_interval_hours, engines, volatility_window_days,
       credentials_status, last_probe_run_at, created_at, updated_at
  FROM aeo_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&s.Enabled, &brandTermsRaw, &s.BrandDomain, &promptPack,
		&s.ProbeIntervalHours, &enginesRaw, &s.VolatilityWindowDays,
		&credStatus, &s.LastProbeRunAt, &s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		return def, ErrNotFound
	}
	s.ProbePromptPack = PromptPack(promptPack)
	s.CredentialsStatus = CredentialsStatus(credStatus)
	_ = json.Unmarshal(brandTermsRaw, &s.BrandTerms)
	_ = json.Unmarshal(enginesRaw, &s.Engines)
	if s.BrandTerms == nil {
		s.BrandTerms = []string{}
	}
	if s.Engines == nil {
		s.Engines = DefaultSettings().Engines
	}
	return s, tx.Commit(ctx)
}

// UpsertSettings creates or updates the tenant's aeo_settings row.
// Validates ranges so a malformed admin POST can't smuggle in an
// out-of-bounds value that the CHECK constraints would later reject.
func (r *Repo) UpsertSettings(ctx context.Context, tenantID string, s Settings) (Settings, error) {
	if tenantID == "" {
		return Settings{}, errors.New("aeo: tenant_id required")
	}
	// Clamp + normalise.
	if s.ProbeIntervalHours < 6 {
		s.ProbeIntervalHours = 6
	}
	if s.ProbeIntervalHours > 168 {
		s.ProbeIntervalHours = 168
	}
	if s.VolatilityWindowDays < 3 {
		s.VolatilityWindowDays = 3
	}
	if s.VolatilityWindowDays > 60 {
		s.VolatilityWindowDays = 60
	}
	switch s.ProbePromptPack {
	case PromptPackStarter, PromptPackCustom, PromptPackStarterPlusCustom:
		// ok
	default:
		s.ProbePromptPack = PromptPackStarter
	}
	switch s.CredentialsStatus {
	case CredentialsMissing, CredentialsPartial, CredentialsReady:
		// ok
	default:
		s.CredentialsStatus = CredentialsMissing
	}
	if len(s.BrandTerms) > 8 {
		s.BrandTerms = s.BrandTerms[:8]
	}
	if s.BrandTerms == nil {
		s.BrandTerms = []string{}
	}
	if len(s.BrandDomain) > 253 {
		s.BrandDomain = s.BrandDomain[:253]
	}
	if len(s.Engines) == 0 {
		s.Engines = DefaultSettings().Engines
	}

	brandTermsJSON, _ := json.Marshal(s.BrandTerms)
	enginesJSON, _ := json.Marshal(s.Engines)

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return s, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		out           Settings
		brandTermsRaw []byte
		enginesRaw    []byte
		credStatus    string
		promptPack    string
	)
	out.TenantID = tenantID
	err = tx.QueryRow(ctx, `
INSERT INTO aeo_settings(
    tenant_id, enabled, brand_terms, brand_domain, probe_prompt_pack,
    probe_interval_hours, engines, volatility_window_days,
    credentials_status)
VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8, $9)
ON CONFLICT (tenant_id) DO UPDATE SET
    enabled                = EXCLUDED.enabled,
    brand_terms            = EXCLUDED.brand_terms,
    brand_domain           = EXCLUDED.brand_domain,
    probe_prompt_pack      = EXCLUDED.probe_prompt_pack,
    probe_interval_hours   = EXCLUDED.probe_interval_hours,
    engines                = EXCLUDED.engines,
    volatility_window_days = EXCLUDED.volatility_window_days,
    credentials_status     = EXCLUDED.credentials_status,
    updated_at             = now()
RETURNING enabled, brand_terms, brand_domain, probe_prompt_pack,
          probe_interval_hours, engines, volatility_window_days,
          credentials_status, last_probe_run_at, created_at, updated_at`,
		tenantID, s.Enabled, string(brandTermsJSON), s.BrandDomain, string(s.ProbePromptPack),
		s.ProbeIntervalHours, string(enginesJSON), s.VolatilityWindowDays,
		string(s.CredentialsStatus),
	).Scan(
		&out.Enabled, &brandTermsRaw, &out.BrandDomain, &promptPack,
		&out.ProbeIntervalHours, &enginesRaw, &out.VolatilityWindowDays,
		&credStatus, &out.LastProbeRunAt, &out.CreatedAt, &out.UpdatedAt,
	)
	if err != nil {
		return s, err
	}
	out.ProbePromptPack = PromptPack(promptPack)
	out.CredentialsStatus = CredentialsStatus(credStatus)
	_ = json.Unmarshal(brandTermsRaw, &out.BrandTerms)
	_ = json.Unmarshal(enginesRaw, &out.Engines)
	return out, tx.Commit(ctx)
}

// ListPrompts returns the prompt rotation library for the tenant. The
// caller can filter by enabled-only when running the probe worker.
func (r *Repo) ListPrompts(ctx context.Context, tenantID string, enabledOnly bool) ([]Prompt, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `
SELECT id::text, category, prompt_text, enabled, source, created_at, updated_at
  FROM aeo_prompts
 WHERE tenant_id = $1::uuid`
	if enabledOnly {
		q += " AND enabled = true"
	}
	q += " ORDER BY category, created_at"
	rows, err := tx.Query(ctx, q, tenantID)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()
	out := []Prompt{}
	for rows.Next() {
		var p Prompt
		p.TenantID = tenantID
		var cat string
		if err := rows.Scan(&p.ID, &cat, &p.PromptText, &p.Enabled, &p.Source, &p.CreatedAt, &p.UpdatedAt); err != nil {
			continue
		}
		p.Category = PromptCategory(cat)
		out = append(out, p)
	}
	return out, tx.Commit(ctx)
}

// CreatePrompt inserts a new tenant-authored prompt. Source is always
// 'custom' (the starter pack is seeded by the migration / installer
// scripts).
func (r *Repo) CreatePrompt(ctx context.Context, tenantID string, p Prompt) (Prompt, error) {
	if tenantID == "" {
		return Prompt{}, errors.New("aeo: tenant_id required")
	}
	p.PromptText = strings.TrimSpace(p.PromptText)
	if len(p.PromptText) < 4 || len(p.PromptText) > 2000 {
		return Prompt{}, errors.New("aeo: prompt_text must be 4..2000 chars")
	}
	if p.Category == "" {
		p.Category = CategoryDiscovery
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Prompt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out Prompt
	out.TenantID = tenantID
	var cat string
	err = tx.QueryRow(ctx, `
INSERT INTO aeo_prompts(tenant_id, category, prompt_text, enabled, source)
VALUES ($1::uuid, $2, $3, true, 'custom')
RETURNING id::text, category, prompt_text, enabled, source, created_at, updated_at`,
		tenantID, string(p.Category), p.PromptText,
	).Scan(&out.ID, &cat, &out.PromptText, &out.Enabled, &out.Source, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return Prompt{}, err
	}
	out.Category = PromptCategory(cat)
	return out, tx.Commit(ctx)
}

// TogglePrompt flips the enabled flag on a prompt. Used by the
// settings UI's per-row checkbox.
func (r *Repo) TogglePrompt(ctx context.Context, tenantID, promptID string, enabled bool) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE aeo_prompts SET enabled = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, promptID, enabled,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeletePrompt removes a prompt. Cascades drop dependent probes.
func (r *Repo) DeletePrompt(ctx context.Context, tenantID, promptID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM aeo_prompts WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, promptID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordProbe appends one probe row. Best-effort: callers retry on
// transient failures but don't block the runner on a single failed
// insert.
func (r *Repo) RecordProbe(ctx context.Context, tenantID string, p Probe) error {
	if tenantID == "" {
		return errors.New("aeo: tenant_id required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hitsJSON, err := json.Marshal(p.CompetitorHits)
	if err != nil {
		hitsJSON = []byte("{}")
	}
	// Truncate response text at 16KB to bound row size.
	rt := p.ResponseText
	if len(rt) > 16*1024 {
		rt = rt[:16*1024]
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO aeo_probes(
    tenant_id, prompt_id, engine, response_text, mentioned, cited,
    competitor_hits, latency_ms, token_count, status, probed_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, COALESCE($11, now()))`,
		tenantID, p.PromptID, string(p.Engine), rt, p.Mentioned, p.Cited,
		string(hitsJSON), p.LatencyMS, p.TokenCount, string(p.Status),
		nullIfZero(p.ProbedAt),
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListProbes returns recent probes for the tenant, optionally filtered
// by engine and prompt. Used by the audit pane.
func (r *Repo) ListProbes(ctx context.Context, tenantID string, engine Engine, promptID string, limit int) ([]Probe, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, prompt_id::text, engine, response_text, mentioned, cited,
       competitor_hits, latency_ms, token_count, status, probed_at
  FROM aeo_probes
 WHERE tenant_id = $1::uuid
   AND ($2::text = '' OR engine = $2)
   AND ($3::text = '' OR prompt_id = $3::uuid)
 ORDER BY probed_at DESC
 LIMIT $4`, tenantID, string(engine), promptID, limit)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()
	out := []Probe{}
	for rows.Next() {
		var p Probe
		p.TenantID = tenantID
		var (
			eng     string
			status  string
			hitsRaw []byte
		)
		if err := rows.Scan(&p.ID, &p.PromptID, &eng, &p.ResponseText, &p.Mentioned, &p.Cited,
			&hitsRaw, &p.LatencyMS, &p.TokenCount, &status, &p.ProbedAt); err != nil {
			continue
		}
		p.Engine = Engine(eng)
		p.Status = ProbeStatus(status)
		_ = json.Unmarshal(hitsRaw, &p.CompetitorHits)
		out = append(out, p)
	}
	return out, tx.Commit(ctx)
}

// UpsertDailyRollup writes one rollup row, replacing any existing
// (tenant_id, engine, day) row.
func (r *Repo) UpsertDailyRollup(ctx context.Context, rollup DailyRollup) error {
	if rollup.TenantID == "" {
		return errors.New("aeo: tenant_id required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, rollup.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO aeo_daily_rollup(
    tenant_id, engine, day, mention_rate, citation_rate, volatility_score,
    ai_referral_pct, sample_size)
VALUES ($1::uuid, $2, $3::date, $4, $5, $6, $7, $8)
ON CONFLICT (tenant_id, engine, day) DO UPDATE SET
    mention_rate     = EXCLUDED.mention_rate,
    citation_rate    = EXCLUDED.citation_rate,
    volatility_score = EXCLUDED.volatility_score,
    ai_referral_pct  = EXCLUDED.ai_referral_pct,
    sample_size      = EXCLUDED.sample_size,
    computed_at      = now()`,
		rollup.TenantID, string(rollup.Engine), rollup.Day,
		rollup.MentionRate, rollup.CitationRate, rollup.VolatilityScore,
		rollup.AIReferralPct, rollup.SampleSize,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListRollups returns the last `days` of rollups for the tenant,
// optionally scoped to a single engine. Used by the dashboard's
// fever-chart.
func (r *Repo) ListRollups(ctx context.Context, tenantID string, engine Engine, days int) ([]DailyRollup, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT engine, day, mention_rate, citation_rate, volatility_score,
       ai_referral_pct, sample_size, computed_at
  FROM aeo_daily_rollup
 WHERE tenant_id = $1::uuid
   AND ($2::text = '' OR engine = $2)
   AND day >= (now() AT TIME ZONE 'utc')::date - $3::integer
 ORDER BY day DESC, engine`, tenantID, string(engine), days)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()
	out := []DailyRollup{}
	for rows.Next() {
		var r DailyRollup
		r.TenantID = tenantID
		var eng string
		if err := rows.Scan(&eng, &r.Day, &r.MentionRate, &r.CitationRate,
			&r.VolatilityScore, &r.AIReferralPct, &r.SampleSize, &r.ComputedAt); err != nil {
			continue
		}
		r.Engine = Engine(eng)
		out = append(out, r)
	}
	return out, tx.Commit(ctx)
}

// ListCompetitors returns all competitor rows for the tenant.
func (r *Repo) ListCompetitors(ctx context.Context, tenantID string) ([]Competitor, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, competitor_key, display_name, terms, domain, created_at, updated_at
  FROM aeo_competitors
 WHERE tenant_id = $1::uuid
 ORDER BY created_at`, tenantID)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()
	out := []Competitor{}
	for rows.Next() {
		var c Competitor
		c.TenantID = tenantID
		var termsRaw []byte
		if err := rows.Scan(&c.ID, &c.CompetitorKey, &c.DisplayName, &termsRaw, &c.Domain, &c.CreatedAt, &c.UpdatedAt); err != nil {
			continue
		}
		_ = json.Unmarshal(termsRaw, &c.Terms)
		if c.Terms == nil {
			c.Terms = []string{}
		}
		out = append(out, c)
	}
	return out, tx.Commit(ctx)
}

// UpsertCompetitor inserts or updates a competitor row. Enforces the
// MaxCompetitors cap on inserts.
func (r *Repo) UpsertCompetitor(ctx context.Context, tenantID string, c Competitor) (Competitor, error) {
	if tenantID == "" {
		return Competitor{}, errors.New("aeo: tenant_id required")
	}
	c.CompetitorKey = strings.ToLower(strings.TrimSpace(c.CompetitorKey))
	c.DisplayName = strings.TrimSpace(c.DisplayName)
	if c.CompetitorKey == "" || c.DisplayName == "" {
		return Competitor{}, errors.New("aeo: competitor_key and display_name are required")
	}
	if len(c.Terms) > 6 {
		c.Terms = c.Terms[:6]
	}
	if c.Terms == nil {
		c.Terms = []string{}
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Competitor{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Cap enforcement: only block on insert paths. Use SELECT-FOR-UPDATE
	// to keep concurrent inserts from racing past the cap.
	if c.ID == "" {
		var count int
		if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM aeo_competitors WHERE tenant_id = $1::uuid`, tenantID,
		).Scan(&count); err != nil {
			return Competitor{}, err
		}
		if count >= MaxCompetitors {
			// Allow upsert by key if the row already exists. Check that.
			var exists bool
			_ = tx.QueryRow(ctx, `
SELECT EXISTS(SELECT 1 FROM aeo_competitors WHERE tenant_id = $1::uuid AND competitor_key = $2)`,
				tenantID, c.CompetitorKey,
			).Scan(&exists)
			if !exists {
				return Competitor{}, ErrCompetitorCap
			}
		}
	}

	termsJSON, _ := json.Marshal(c.Terms)
	var out Competitor
	out.TenantID = tenantID
	var termsRaw []byte
	err = tx.QueryRow(ctx, `
INSERT INTO aeo_competitors(tenant_id, competitor_key, display_name, terms, domain)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
ON CONFLICT (tenant_id, competitor_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    terms        = EXCLUDED.terms,
    domain       = EXCLUDED.domain,
    updated_at   = now()
RETURNING id::text, competitor_key, display_name, terms, domain, created_at, updated_at`,
		tenantID, c.CompetitorKey, c.DisplayName, string(termsJSON), c.Domain,
	).Scan(&out.ID, &out.CompetitorKey, &out.DisplayName, &termsRaw, &out.Domain, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return Competitor{}, err
	}
	_ = json.Unmarshal(termsRaw, &out.Terms)
	return out, tx.Commit(ctx)
}

// DeleteCompetitor removes a competitor row by key.
func (r *Repo) DeleteCompetitor(ctx context.Context, tenantID, competitorKey string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM aeo_competitors
 WHERE tenant_id = $1::uuid AND competitor_key = $2`, tenantID, competitorKey,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TouchLastProbeRun stamps aeo_settings.last_probe_run_at = now(). The
// daily worker calls this after a successful pass so the dashboard can
// render the "last run X minutes ago" badge.
func (r *Repo) TouchLastProbeRun(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE aeo_settings SET last_probe_run_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid`, tenantID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func nullIfZero(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
