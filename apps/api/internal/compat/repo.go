package compat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var ErrNotFound = errors.New("compatibility resource not found")

type Repo struct {
	Pool *db.Pool
}

func (r *Repo) Summary(ctx context.Context, tenantID string) (*Summary, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &Summary{
		Contacts:    ContactSummary{ByMailchimpStatus: map[string]int{}},
		Campaigns:   CampaignSummary{ByType: map[string]int{}},
		Automations: AutomationSummary{ByStatus: map[string]int{}},
	}

	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Contacts.Total); err != nil {
		return nil, err
	}
	if err := scanCounts(ctx, tx, `SELECT mailchimp_status, count(*) FROM subscribers WHERE tenant_id = $1::uuid GROUP BY mailchimp_status`, tenantID, out.Contacts.ByMailchimpStatus); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscriber_groups WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Contacts.Groups); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM contact_activity WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Contacts.ActivityEvents); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaigns WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Campaigns.Total); err != nil {
		return nil, err
	}
	if err := scanCounts(ctx, tx, `SELECT campaign_type, count(*) FROM campaigns WHERE tenant_id = $1::uuid GROUP BY campaign_type`, tenantID, out.Campaigns.ByType); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaign_assets WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Campaigns.Assets); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaign_sections WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Campaigns.ReusableSections); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Reports.Events); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(DISTINCT campaign_id) FROM campaign_report_events WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Reports.ReportableCampaigns); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `SELECT count(*) FROM automation_journeys WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Automations.Total); err != nil {
		return nil, err
	}
	if err := scanCounts(ctx, tx, `SELECT status, count(*) FROM automation_journeys WHERE tenant_id = $1::uuid GROUP BY status`, tenantID, out.Automations.ByStatus); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `SELECT count(*) FROM landing_pages WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Growth.LandingPages); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM popup_forms WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Growth.Popups); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM growth_surface_events WHERE tenant_id = $1::uuid AND event_type = 'view'`, tenantID).Scan(&out.Growth.Views); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM growth_surface_events WHERE tenant_id = $1::uuid AND event_type IN ('submit','conversion')`, tenantID).Scan(&out.Growth.Conversions); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `SELECT count(*) FROM commerce_integrations WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Ecommerce.Integrations); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM commerce_customers WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Ecommerce.Customers); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM commerce_products WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Ecommerce.Products); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*), COALESCE(sum(total_cents), 0), COALESCE(sum(total_cents) FILTER (WHERE campaign_id IS NOT NULL), 0) FROM commerce_orders WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.Ecommerce.Orders, &out.Ecommerce.RevenueCents, &out.Ecommerce.AttributedRevenue); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ListGroups(ctx context.Context, tenantID string) ([]Group, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, category, name, type, display_order, COALESCE(source_id, ''), created_at, updated_at
FROM subscriber_groups
WHERE tenant_id = $1::uuid
ORDER BY category, display_order, name`, tenantID)
	if err != nil {
		return nil, err
	}
	out := []Group{}
	defer rows.Close()
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.ID, &g.Category, &g.Name, &g.Type, &g.DisplayOrder, &g.SourceID, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateGroup(ctx context.Context, tenantID string, in GroupInput) (*Group, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO subscriber_groups (tenant_id, category, name, type, display_order, source_id)
VALUES ($1::uuid, $2, $3, $4, $5, NULLIF($6, ''))
ON CONFLICT (tenant_id, category, name) DO UPDATE SET
  type = EXCLUDED.type,
  display_order = EXCLUDED.display_order,
  source_id = EXCLUDED.source_id,
  updated_at = now()
RETURNING id::text, category, name, type, display_order, COALESCE(source_id, ''), created_at, updated_at`,
		tenantID, in.Category, in.Name, in.Type, in.DisplayOrder, in.SourceID)
	var g Group
	if err := row.Scan(&g.ID, &g.Category, &g.Name, &g.Type, &g.DisplayOrder, &g.SourceID, &g.CreatedAt, &g.UpdatedAt); err != nil {
		return nil, err
	}
	return &g, tx.Commit(ctx)
}

func (r *Repo) ListAssets(ctx context.Context, tenantID string) ([]Asset, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, asset_type, url, COALESCE(alt_text, ''), metadata, created_at, updated_at
FROM campaign_assets
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	out := []Asset{}
	defer rows.Close()
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateAsset(ctx context.Context, tenantID string, in AssetInput) (*Asset, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw, _ := json.Marshal(nonNilMap(in.Metadata))
	row := tx.QueryRow(ctx, `
INSERT INTO campaign_assets (tenant_id, name, asset_type, url, alt_text, metadata)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6::jsonb)
RETURNING id::text, name, asset_type, url, COALESCE(alt_text, ''), metadata, created_at, updated_at`,
		tenantID, in.Name, in.AssetType, in.URL, in.AltText, string(raw))
	a, err := scanAsset(row)
	if err != nil {
		return nil, err
	}
	return a, tx.Commit(ctx)
}

func (r *Repo) ListSections(ctx context.Context, tenantID string) ([]Section, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, category, blocks, COALESCE(html, ''), COALESCE(mjml, ''), created_at, updated_at
FROM campaign_sections
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	out := []Section{}
	defer rows.Close()
	for rows.Next() {
		s, err := scanSection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateSection(ctx context.Context, tenantID string, in SectionInput) (*Section, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw, _ := json.Marshal(nonNilSlice(in.Blocks))
	row := tx.QueryRow(ctx, `
INSERT INTO campaign_sections (tenant_id, name, category, blocks, html, mjml)
VALUES ($1::uuid, $2, $3, $4::jsonb, NULLIF($5, ''), NULLIF($6, ''))
ON CONFLICT (tenant_id, name) DO UPDATE SET
  category = EXCLUDED.category,
  blocks = EXCLUDED.blocks,
  html = EXCLUDED.html,
  mjml = EXCLUDED.mjml,
  updated_at = now()
RETURNING id::text, name, category, blocks, COALESCE(html, ''), COALESCE(mjml, ''), created_at, updated_at`,
		tenantID, in.Name, in.Category, string(raw), in.HTML, in.MJML)
	s, err := scanSection(row)
	if err != nil {
		return nil, err
	}
	return s, tx.Commit(ctx)
}

func (r *Repo) ListJourneys(ctx context.Context, tenantID string) ([]Journey, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, journeySelectSQL+` WHERE tenant_id = $1::uuid ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	out := []Journey{}
	defer rows.Close()
	for rows.Next() {
		j, err := scanJourney(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *j)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateJourney(ctx context.Context, tenantID string, in JourneyInput) (*Journey, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	triggers, _ := json.Marshal(nonNilSlice(in.Triggers))
	nodes, _ := json.Marshal(nonNilSlice(in.Nodes))
	edges, _ := json.Marshal(nonNilSlice(in.Edges))
	goals, _ := json.Marshal(nonNilSlice(in.Goals))
	analytics, _ := json.Marshal(nonNilMap(in.Analytics))
	row := tx.QueryRow(ctx, `
INSERT INTO automation_journeys (tenant_id, name, status, triggers, nodes, edges, goals, analytics, published_at)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
        CASE WHEN $3 = 'active' THEN now() ELSE NULL END)
RETURNING `+journeyColumns,
		tenantID, in.Name, in.Status, string(triggers), string(nodes), string(edges), string(goals), string(analytics))
	j, err := scanJourney(row)
	if err != nil {
		return nil, err
	}
	return j, tx.Commit(ctx)
}

func (r *Repo) SetJourneyStatus(ctx context.Context, tenantID, id, status string) (*Journey, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE automation_journeys
   SET status = $3,
       version = version + 1,
       published_at = CASE WHEN $3 = 'active' AND published_at IS NULL THEN now() ELSE published_at END,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING `+journeyColumns, tenantID, id, status)
	j, err := scanJourney(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return j, tx.Commit(ctx)
}

func (r *Repo) ListLandingPages(ctx context.Context, tenantID string) ([]LandingPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, landingSelectSQL+` WHERE tenant_id = $1::uuid ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	out := []LandingPage{}
	defer rows.Close()
	for rows.Next() {
		lp, err := scanLandingPage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *lp)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateLandingPage(ctx context.Context, tenantID string, in LandingPageInput) (*LandingPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	blocks, _ := json.Marshal(nonNilSlice(in.Blocks))
	seo, _ := json.Marshal(nonNilMap(in.SEO))
	tracking, _ := json.Marshal(nonNilMap(in.Tracking))
	row := tx.QueryRow(ctx, `
INSERT INTO landing_pages (tenant_id, slug, name, status, domain, template, blocks, seo, tracking)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6, $7::jsonb, $8::jsonb, $9::jsonb)
ON CONFLICT (tenant_id, slug) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  domain = EXCLUDED.domain,
  template = EXCLUDED.template,
  blocks = EXCLUDED.blocks,
  seo = EXCLUDED.seo,
  tracking = EXCLUDED.tracking,
  updated_at = now()
RETURNING `+landingColumns,
		tenantID, in.Slug, in.Name, in.Status, in.Domain, in.Template, string(blocks), string(seo), string(tracking))
	lp, err := scanLandingPage(row)
	if err != nil {
		return nil, err
	}
	return lp, tx.Commit(ctx)
}

func (r *Repo) LandingPageExists(ctx context.Context, tenantID, slug string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM landing_pages
   WHERE tenant_id = $1::uuid AND slug = $2
)`, tenantID, slug).Scan(&exists); err != nil {
		return false, err
	}
	return exists, tx.Commit(ctx)
}

func (r *Repo) PublicLandingPage(ctx context.Context, slug string) (*LandingPage, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_landing_slug', $1, true)`, slug); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, landingSelectSQL+` WHERE lower(slug::text) = lower($1) AND status = 'published'`, slug)
	lp, err := scanLandingPage(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return lp, tx.Commit(ctx)
}

func (r *Repo) RecordLandingEvent(ctx context.Context, tenantID, id, eventType, email, variantID string, metadata map[string]any) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw, _ := json.Marshal(nonNilMap(metadata))
	// Defense-in-depth: coerce a non-UUID variantID to "" so the ::uuid cast
	// can never raise (which would 500 the public convert). Callers already
	// supply either a DB id or a token-verified id, but a raw ::uuid cast on
	// untrusted input is a footgun, so guard it at the choke point.
	if variantID != "" {
		if _, perr := uuid.Parse(variantID); perr != nil {
			variantID = ""
		}
	}
	// variant_id is NULL for a control / un-varianted page (LAND-037).
	_, err = tx.Exec(ctx, `
INSERT INTO growth_surface_events (tenant_id, surface_type, surface_id, event_type, email, metadata, variant_id)
VALUES ($1::uuid, 'landing_page', $2::uuid, $3, NULLIF($4, ''), $5::jsonb, NULLIF($6, '')::uuid)`,
		tenantID, id, eventType, email, string(raw), variantID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// landingVariantCandidate is one weightable A/B arm during a serve pick.
type landingVariantCandidate struct {
	ID     string
	Blocks []map[string]any
	Weight int
}

// LandingVariantPick is the chosen arm returned to the serve handler.
type LandingVariantPick struct {
	VariantID string
	Blocks    []map[string]any
}

// pickWeightedLanding chooses a candidate by weight. randNonNeg is any
// non-negative integer (the handler supplies a random one); the result is
// deterministic given (candidates, randNonNeg) so it is unit-testable. Returns
// nil when there is nothing to serve.
func pickWeightedLanding(cands []landingVariantCandidate, randNonNeg int) *landingVariantCandidate {
	total := 0
	for i := range cands {
		if cands[i].Weight > 0 {
			total += cands[i].Weight
		}
	}
	if total <= 0 {
		return nil
	}
	if randNonNeg < 0 {
		randNonNeg = -randNonNeg
	}
	pct := randNonNeg % total
	acc := 0
	for i := range cands {
		if cands[i].Weight <= 0 {
			continue
		}
		acc += cands[i].Weight
		if pct < acc {
			return &cands[i]
		}
	}
	// Unreachable given total>0, but return the last positive-weight arm.
	for i := len(cands) - 1; i >= 0; i-- {
		if cands[i].Weight > 0 {
			return &cands[i]
		}
	}
	return nil
}

// PickLandingVariant reads the published page's variants (public-read RLS via
// app.public_landing_slug) and picks one weighted by traffic share (LAND-037).
// Returns nil (no error) when the page has no active variants — the caller then
// serves the page's own content as the control.
func (r *Repo) PickLandingVariant(ctx context.Context, slug, pageID string, randNonNeg int) (*LandingVariantPick, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_landing_slug', $1, true)`, slug); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, blocks, weight
  FROM landing_page_variants
 WHERE page_id::text = $1 AND weight > 0
 ORDER BY is_control DESC, created_at ASC`, pageID)
	if err != nil {
		return nil, err
	}
	cands := []landingVariantCandidate{}
	for rows.Next() {
		var c landingVariantCandidate
		var raw []byte
		if err := rows.Scan(&c.ID, &raw, &c.Weight); err != nil {
			rows.Close()
			return nil, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &c.Blocks)
		}
		// An empty-content variant is not a servable arm — serving it would
		// blank the page. Skip it so the page falls back to its own content
		// (the control) rather than rendering empty.
		if len(c.Blocks) == 0 {
			continue
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	picked := pickWeightedLanding(cands, randNonNeg)
	if picked == nil {
		return nil, nil
	}
	return &LandingVariantPick{VariantID: picked.ID, Blocks: picked.Blocks}, nil
}

func (r *Repo) ListPopups(ctx context.Context, tenantID string) ([]PopupForm, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, popupSelectSQL+` WHERE tenant_id = $1::uuid ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	out := []PopupForm{}
	defer rows.Close()
	for rows.Next() {
		p, err := scanPopup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreatePopup(ctx context.Context, tenantID string, in PopupInput) (*PopupForm, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	trigger, _ := json.Marshal(nonNilMap(in.Trigger))
	targeting, _ := json.Marshal(nonNilMap(in.Targeting))
	blocks, _ := json.Marshal(nonNilSlice(in.Blocks))
	row := tx.QueryRow(ctx, `
INSERT INTO popup_forms (tenant_id, name, status, trigger, targeting, blocks, form_id)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, NULLIF($7, '')::uuid)
RETURNING `+popupColumns,
		tenantID, in.Name, in.Status, string(trigger), string(targeting), string(blocks), in.FormID)
	p, err := scanPopup(row)
	if err != nil {
		return nil, err
	}
	return p, tx.Commit(ctx)
}

func (r *Repo) ListCommerceIntegrations(ctx context.Context, tenantID string) ([]CommerceIntegration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, integrationSelectSQL+` WHERE tenant_id = $1::uuid ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	out := []CommerceIntegration{}
	defer rows.Close()
	for rows.Next() {
		i, err := scanIntegration(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *i)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateCommerceIntegration(ctx context.Context, tenantID string, in CommerceIntegrationInput) (*CommerceIntegration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	settings, _ := json.Marshal(nonNilMap(in.Settings))
	row := tx.QueryRow(ctx, `
INSERT INTO commerce_integrations (tenant_id, provider, shop_domain, status, scopes, settings)
VALUES ($1::uuid, $2, NULLIF($3, ''), $4, $5, $6::jsonb)
ON CONFLICT (tenant_id, provider, shop_domain) DO UPDATE SET
  status = EXCLUDED.status,
  scopes = EXCLUDED.scopes,
  settings = EXCLUDED.settings,
  updated_at = now()
RETURNING `+integrationColumns,
		tenantID, in.Provider, in.ShopDomain, in.Status, in.Scopes, string(settings))
	i, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) CommerceIntegrationExists(ctx context.Context, tenantID, provider, shopDomain string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM commerce_integrations
   WHERE tenant_id = $1::uuid
     AND provider = $2
     AND shop_domain IS NOT DISTINCT FROM NULLIF($3, '')
)`, tenantID, provider, shopDomain).Scan(&exists); err != nil {
		return false, err
	}
	return exists, tx.Commit(ctx)
}

func (r *Repo) SyncDemoCommerce(ctx context.Context, tenantID, integrationID string) (*EcommerceSummary, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM commerce_integrations WHERE tenant_id = $1::uuid AND id::text = $2)`, tenantID, integrationID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_customers (tenant_id, integration_id, source_id, email, first_name, last_name, accepts_marketing, tags, raw)
VALUES
($1::uuid, $2::uuid, 'cust_demo_maya', 'maya@example.com', 'Maya', 'Chen', true, ARRAY['vip','newsletter'], '{"source":"demo"}'::jsonb),
($1::uuid, $2::uuid, 'cust_demo_rio', 'rio@example.com', 'Rio', 'Patel', true, ARRAY['launch'], '{"source":"demo"}'::jsonb)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  email = EXCLUDED.email,
  accepts_marketing = EXCLUDED.accepts_marketing,
  tags = EXCLUDED.tags,
  updated_at = now()`, tenantID, integrationID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_products (tenant_id, integration_id, source_id, title, url, image_url, price_cents, currency, raw)
VALUES
($1::uuid, $2::uuid, 'prod_demo_course', 'Launch Course', 'https://example.com/course', 'https://example.com/course.png', 9900, 'USD', '{"source":"demo"}'::jsonb),
($1::uuid, $2::uuid, 'prod_demo_template', 'Newsletter Template Pack', 'https://example.com/templates', 'https://example.com/templates.png', 2900, 'USD', '{"source":"demo"}'::jsonb)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  title = EXCLUDED.title,
  price_cents = EXCLUDED.price_cents,
  updated_at = now()`, tenantID, integrationID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_orders (tenant_id, integration_id, source_id, customer_email, status, subtotal_cents, total_cents, currency, attribution, line_items, ordered_at)
VALUES
($1::uuid, $2::uuid, 'order_demo_1001', 'maya@example.com', 'paid', 9900, 9900, 'USD', '{"source":"campaign_click"}'::jsonb, '[{"source_id":"prod_demo_course","title":"Launch Course","quantity":1,"price_cents":9900}]'::jsonb, $3),
($1::uuid, $2::uuid, 'order_demo_1002', 'rio@example.com', 'paid', 2900, 2900, 'USD', '{"source":"landing_page"}'::jsonb, '[{"source_id":"prod_demo_template","title":"Newsletter Template Pack","quantity":1,"price_cents":2900}]'::jsonb, $3)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  status = EXCLUDED.status,
  total_cents = EXCLUDED.total_cents,
  attribution = EXCLUDED.attribution,
  line_items = EXCLUDED.line_items,
  updated_at = now()`, tenantID, integrationID, now); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE commerce_integrations
   SET status = 'connected',
       sync_cursor = $3,
       last_sync_at = $4,
       error_message = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, integrationID, fmt.Sprintf("demo-%d", now.Unix()), now); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_events (tenant_id, integration_id, event_type, metadata)
VALUES ($1::uuid, $2::uuid, 'sync_completed', '{"mode":"demo"}'::jsonb)`, tenantID, integrationID); err != nil {
		return nil, err
	}
	var out EcommerceSummary
	if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM commerce_integrations WHERE tenant_id = $1::uuid),
  (SELECT count(*) FROM commerce_customers WHERE tenant_id = $1::uuid),
  (SELECT count(*) FROM commerce_products WHERE tenant_id = $1::uuid),
  (SELECT count(*) FROM commerce_orders WHERE tenant_id = $1::uuid),
  (SELECT COALESCE(sum(total_cents), 0) FROM commerce_orders WHERE tenant_id = $1::uuid),
  (SELECT COALESCE(sum(total_cents) FILTER (WHERE campaign_id IS NOT NULL), 0) FROM commerce_orders WHERE tenant_id = $1::uuid)`, tenantID).
		Scan(&out.Integrations, &out.Customers, &out.Products, &out.Orders, &out.RevenueCents, &out.AttributedRevenue); err != nil {
		return nil, err
	}
	return &out, tx.Commit(ctx)
}

func (r *Repo) RecordCampaignEvent(ctx context.Context, tenantID, campaignID string, in ReportEventInput) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw, _ := json.Marshal(nonNilMap(in.Metadata))
	_, err = tx.Exec(ctx, `
INSERT INTO campaign_report_events (
    tenant_id, campaign_id, subscriber_email, event_type, link_url, user_agent, ip,
    country, region, city, device, client, revenue_cents, metadata
)
VALUES (
    $1::uuid, $2::uuid, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''),
    NULLIF($7, '')::inet, NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''),
    NULLIF($11, ''), NULLIF($12, ''), $13, $14::jsonb
)`, tenantID, campaignID, in.SubscriberEmail, in.EventType, in.LinkURL, in.UserAgent,
		in.IP, in.Country, in.Region, in.City, in.Device, in.Client, in.RevenueCents, string(raw))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) CampaignReport(ctx context.Context, tenantID, campaignID string) (*CampaignReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2)`, tenantID, campaignID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	out := &CampaignReport{CampaignID: campaignID}
	if err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE event_type = 'sent'),
  count(*) FILTER (WHERE event_type = 'delivered'),
  count(*) FILTER (WHERE event_type = 'opened'),
  count(*) FILTER (WHERE event_type = 'clicked'),
  count(*) FILTER (WHERE event_type = 'bounced'),
  count(*) FILTER (WHERE event_type = 'complained'),
  count(*) FILTER (WHERE event_type = 'unsubscribed'),
  count(*) FILTER (WHERE event_type = 'conversion'),
  COALESCE(sum(revenue_cents), 0)
FROM campaign_report_events
WHERE tenant_id = $1::uuid AND campaign_id::text = $2`, tenantID, campaignID).
		Scan(&out.Sent, &out.Delivered, &out.Opened, &out.Clicked, &out.Bounced, &out.Complained, &out.Unsubscribed, &out.Conversions, &out.RevenueCents); err != nil {
		return nil, err
	}
	denominator := out.Delivered
	if denominator == 0 {
		denominator = out.Sent
	}
	if denominator > 0 {
		out.OpenRate = float64(out.Opened) / float64(denominator)
		out.ClickRate = float64(out.Clicked) / float64(denominator)
	}
	var err2 error
	out.TopLinks, err2 = reportCounts(ctx, tx, `SELECT COALESCE(link_url, ''), count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid AND campaign_id::text = $2 AND link_url IS NOT NULL GROUP BY link_url ORDER BY count(*) DESC LIMIT 10`, tenantID, campaignID)
	if err2 != nil {
		return nil, err2
	}
	out.Devices, err2 = reportCounts(ctx, tx, `SELECT COALESCE(device, 'unknown'), count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid AND campaign_id::text = $2 GROUP BY COALESCE(device, 'unknown') ORDER BY count(*) DESC LIMIT 10`, tenantID, campaignID)
	if err2 != nil {
		return nil, err2
	}
	out.Clients, err2 = reportCounts(ctx, tx, `SELECT COALESCE(client, 'unknown'), count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid AND campaign_id::text = $2 GROUP BY COALESCE(client, 'unknown') ORDER BY count(*) DESC LIMIT 10`, tenantID, campaignID)
	if err2 != nil {
		return nil, err2
	}
	out.Geography, err2 = reportCounts(ctx, tx, `SELECT COALESCE(country, 'unknown'), count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid AND campaign_id::text = $2 GROUP BY COALESCE(country, 'unknown') ORDER BY count(*) DESC LIMIT 10`, tenantID, campaignID)
	if err2 != nil {
		return nil, err2
	}
	recipients, err := tx.Query(ctx, `
SELECT COALESCE(subscriber_email::text, ''),
       count(*) FILTER (WHERE event_type = 'sent'),
       count(*) FILTER (WHERE event_type = 'opened'),
       count(*) FILTER (WHERE event_type = 'clicked'),
       count(*) FILTER (WHERE event_type = 'bounced'),
       count(*) FILTER (WHERE event_type = 'complained'),
       count(*) FILTER (WHERE event_type = 'unsubscribed'),
       COALESCE(sum(revenue_cents), 0)
FROM campaign_report_events
WHERE tenant_id = $1::uuid AND campaign_id::text = $2 AND subscriber_email IS NOT NULL
GROUP BY subscriber_email
ORDER BY subscriber_email
LIMIT 1000`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer recipients.Close()
	for recipients.Next() {
		var s RecipientStats
		if err := recipients.Scan(&s.Email, &s.Sent, &s.Opened, &s.Clicked, &s.Bounced, &s.Complained, &s.Unsubscribed, &s.RevenueCents); err != nil {
			return nil, err
		}
		out.PerRecipient = append(out.PerRecipient, s)
	}
	if err := recipients.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

const journeySelectSQL = `SELECT ` + journeyColumns + ` FROM automation_journeys`
const journeyColumns = `id::text, name, status, version, triggers, nodes, edges, goals, analytics, published_at, created_at, updated_at`

const landingSelectSQL = `SELECT ` + landingColumns + ` FROM landing_pages`
const landingColumns = `id::text, tenant_id::text, slug::text, name, status, COALESCE(domain, ''), template, blocks, seo, tracking, metrics, created_at, updated_at`

const popupSelectSQL = `SELECT ` + popupColumns + ` FROM popup_forms`
const popupColumns = `id::text, tenant_id::text, COALESCE(to_jsonb(popup_forms)->>'public_key', ''), name, status, trigger, targeting, blocks, COALESCE(form_id::text, ''), metrics, created_at, updated_at`

const integrationSelectSQL = `SELECT ` + integrationColumns + ` FROM commerce_integrations`
const integrationColumns = `id::text, provider, COALESCE(shop_domain, ''), status, scopes, settings, COALESCE(sync_cursor, ''), last_sync_at, COALESCE(error_message, ''), created_at, updated_at`

type scanner interface{ Scan(dest ...any) error }

func scanAsset(row scanner) (*Asset, error) {
	var a Asset
	var raw []byte
	if err := row.Scan(&a.ID, &a.Name, &a.AssetType, &a.URL, &a.AltText, &raw, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &a.Metadata)
	if a.Metadata == nil {
		a.Metadata = map[string]any{}
	}
	return &a, nil
}

func scanSection(row scanner) (*Section, error) {
	var s Section
	var raw []byte
	if err := row.Scan(&s.ID, &s.Name, &s.Category, &raw, &s.HTML, &s.MJML, &s.CreatedAt, &s.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &s.Blocks)
	if s.Blocks == nil {
		s.Blocks = []map[string]any{}
	}
	return &s, nil
}

func scanJourney(row scanner) (*Journey, error) {
	var j Journey
	var triggers, nodes, edges, goals, analytics []byte
	if err := row.Scan(&j.ID, &j.Name, &j.Status, &j.Version, &triggers, &nodes, &edges, &goals, &analytics, &j.PublishedAt, &j.CreatedAt, &j.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(triggers, &j.Triggers)
	_ = json.Unmarshal(nodes, &j.Nodes)
	_ = json.Unmarshal(edges, &j.Edges)
	_ = json.Unmarshal(goals, &j.Goals)
	_ = json.Unmarshal(analytics, &j.Analytics)
	j.Triggers = nonNilSlice(j.Triggers)
	j.Nodes = nonNilSlice(j.Nodes)
	j.Edges = nonNilSlice(j.Edges)
	j.Goals = nonNilSlice(j.Goals)
	j.Analytics = nonNilMap(j.Analytics)
	return &j, nil
}

func scanLandingPage(row scanner) (*LandingPage, error) {
	var lp LandingPage
	var blocks, seo, tracking, metrics []byte
	if err := row.Scan(&lp.ID, &lp.TenantID, &lp.Slug, &lp.Name, &lp.Status, &lp.Domain, &lp.Template, &blocks, &seo, &tracking, &metrics, &lp.CreatedAt, &lp.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(blocks, &lp.Blocks)
	_ = json.Unmarshal(seo, &lp.SEO)
	_ = json.Unmarshal(tracking, &lp.Tracking)
	_ = json.Unmarshal(metrics, &lp.Metrics)
	lp.Blocks = nonNilSlice(lp.Blocks)
	lp.SEO = nonNilMap(lp.SEO)
	lp.Tracking = nonNilMap(lp.Tracking)
	lp.Metrics = nonNilMap(lp.Metrics)
	return &lp, nil
}

func scanPopup(row scanner) (*PopupForm, error) {
	var p PopupForm
	var trigger, targeting, blocks, metrics []byte
	if err := row.Scan(&p.ID, &p.TenantID, &p.PublicKey, &p.Name, &p.Status, &trigger, &targeting, &blocks, &p.FormID, &metrics, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(trigger, &p.Trigger)
	_ = json.Unmarshal(targeting, &p.Targeting)
	_ = json.Unmarshal(blocks, &p.Blocks)
	_ = json.Unmarshal(metrics, &p.Metrics)
	p.Trigger = nonNilMap(p.Trigger)
	p.Targeting = nonNilMap(p.Targeting)
	p.Blocks = nonNilSlice(p.Blocks)
	p.Metrics = nonNilMap(p.Metrics)
	return &p, nil
}

func scanIntegration(row scanner) (*CommerceIntegration, error) {
	var i CommerceIntegration
	var settings []byte
	if err := row.Scan(&i.ID, &i.Provider, &i.ShopDomain, &i.Status, &i.Scopes, &settings, &i.SyncCursor, &i.LastSyncAt, &i.ErrorMessage, &i.CreatedAt, &i.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(settings, &i.Settings)
	i.Settings = nonNilMap(i.Settings)
	if i.Scopes == nil {
		i.Scopes = []string{}
	}
	return &i, nil
}

func scanCounts(ctx context.Context, tx pgx.Tx, q, tenantID string, out map[string]int) error {
	rows, err := tx.Query(ctx, q, tenantID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var count int
		if err := rows.Scan(&key, &count); err != nil {
			return err
		}
		out[key] = count
	}
	return rows.Err()
}

func reportCounts(ctx context.Context, tx pgx.Tx, q, tenantID, campaignID string) ([]ReportCount, error) {
	rows, err := tx.Query(ctx, q, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReportCount{}
	for rows.Next() {
		var rc ReportCount
		if err := rows.Scan(&rc.Key, &rc.Count); err != nil {
			return nil, err
		}
		if strings.TrimSpace(rc.Key) == "" {
			rc.Key = "unknown"
		}
		out = append(out, rc)
	}
	return out, rows.Err()
}

func nonNilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func nonNilSlice(v []map[string]any) []map[string]any {
	if v == nil {
		return []map[string]any{}
	}
	return v
}
