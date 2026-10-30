// SPDX-License-Identifier: AGPL-3.0-only
//
// tenant_settings.go — admin GET/PUT for the per-tenant public-archive
// configuration row (`tenant_public_settings`). Without these endpoints
// the column `tenant_archive_slug` could only be populated via raw SQL,
// so every newly-provisioned tenant 404'd every public archive URL until
// an operator ran an UPDATE by hand. (Gap feature
// `archive-tenant-slug-write`.)
//
// Surface — both routes are tenant-scoped and gated by
// `apikeys.RequireScope(apikeys.ScopeAdmin)`:
//
//	GET  /api/v1/admin/archive/tenant-settings
//	PUT  /api/v1/admin/archive/tenant-settings
//
// Wire shape mirrors the audit ticket:
//
//	{
//	  "tenant_archive_slug": "postwave-weekly",
//	  "archive_domain":      "archive.example.com",
//	  "archive_title":       "Moosewave Weekly",
//	  "archive_tagline":     "Notes on email infrastructure"
//	}
//
// All four fields are optional; an explicit empty string clears the
// column (so the operator can revert to defaults). Slug validation is
// enforced server-side — kebab-case, 1-64 chars, [a-z0-9-] only — so a
// client bug can't write a value that breaks public URL routing.
//
// Compare-to: Substack `/publication/settings`, beehiiv "Publication
// settings", Ghost `/settings/general`, Buttondown
// `/settings/basics`. Every one of those exposes a slug + title +
// tagline form post-create; we were the outlier in requiring DB
// access.

package archive

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TenantSettings is the wire shape for the admin tenant-settings
// endpoints. All four branding fields are optional on input; output
// fills any missing column with "" so the frontend can render a plain
// text input without a null-guard.
//
// The Tips* block is the per-tenant "Tips & Donations" config (gap
// feature `archive-tips-donations`, P3, inspired by Ghost). All five
// fields are stored on the same `tenant_public_settings` row so they
// move with the rest of the publication config.
type TenantSettings struct {
	TenantArchiveSlug string `json:"tenant_archive_slug"`
	ArchiveDomain     string `json:"archive_domain"`
	ArchiveTitle      string `json:"archive_title"`
	ArchiveTagline    string `json:"archive_tagline"`

	// TipsEnabled gates the public tip-jar button on archive pages.
	// false (the default) is "tips off": the public archive read path
	// strips the Tips* fields and the public-checkout POST returns 404.
	TipsEnabled bool `json:"tips_enabled"`
	// TipsCurrency — ISO 4217 lowercase 3-letter code. Defaults 'usd'.
	TipsCurrency string `json:"tips_currency"`
	// TipsSuggestedAmounts in minor units (cents). The renderer shows
	// one quick-pick button per entry; an empty list collapses to a
	// single custom-amount input. Bounded to 8 entries server-side.
	TipsSuggestedAmounts []int `json:"tips_suggested_amounts"`
	// TipsMinAmount is the hard floor (minor units, default 100 = $1.00).
	// Below this the public-checkout POST returns 400 invalid_amount.
	TipsMinAmount int `json:"tips_min_amount"`
	// TipsMessage is the short blurb rendered above the picker
	// ("Enjoying the newsletter? Tip the author."). Optional; empty
	// string falls back to a generic translated default in the page.
	TipsMessage string `json:"tips_message"`

	// ArchiveBarDefaultEnabled is the tenant-level default for whether
	// the Mailchimp-parity Archive Bar (gap feature
	// `archive-mailchimpv3-archive-bar`) renders in campaign email
	// bodies. Default true on a fresh row. Per-campaign override lives
	// in campaigns.delivery_settings.archive_bar_enabled.
	ArchiveBarDefaultEnabled bool `json:"archive_bar_default_enabled"`
	// ArchiveBarDefaultText is the optional CTA copy for the Archive
	// Bar. Empty falls back to the package default
	// ("View this email in your browser | View past issues"). Free
	// text; HTML-escaped at render-time.
	ArchiveBarDefaultText string `json:"archive_bar_default_text"`
	// ViewInBrowserDefaultEnabled is the tenant-level default for the
	// standalone `{{ view_in_browser_url }}` link rendered next to the
	// unsubscribe link in the default footer.
	ViewInBrowserDefaultEnabled bool `json:"view_in_browser_default_enabled"`
}

// TenantSettingsInput is the PUT body. Pointer fields distinguish
// "field omitted, leave column untouched" from "field present, clear
// the column" (empty string). This is the same PATCH-style convention
// `PublishInput` uses for SEO knobs.
type TenantSettingsInput struct {
	TenantArchiveSlug *string `json:"tenant_archive_slug,omitempty"`
	ArchiveDomain     *string `json:"archive_domain,omitempty"`
	ArchiveTitle      *string `json:"archive_title,omitempty"`
	ArchiveTagline    *string `json:"archive_tagline,omitempty"`

	// Tips* PATCH-style pointers. nil = leave column alone; non-nil =
	// overwrite. An empty slice in TipsSuggestedAmounts is a valid
	// "clear all quick-picks" instruction.
	TipsEnabled          *bool   `json:"tips_enabled,omitempty"`
	TipsCurrency         *string `json:"tips_currency,omitempty"`
	TipsSuggestedAmounts *[]int  `json:"tips_suggested_amounts,omitempty"`
	TipsMinAmount        *int    `json:"tips_min_amount,omitempty"`
	TipsMessage          *string `json:"tips_message,omitempty"`

	// Archive-bar PATCH-style pointers (migration 0297; gap feature
	// `archive-mailchimpv3-archive-bar`). nil = leave column alone;
	// non-nil = overwrite. ArchiveBarDefaultText accepts the empty
	// string to clear the column back to the package default copy.
	ArchiveBarDefaultEnabled    *bool   `json:"archive_bar_default_enabled,omitempty"`
	ArchiveBarDefaultText       *string `json:"archive_bar_default_text,omitempty"`
	ViewInBrowserDefaultEnabled *bool   `json:"view_in_browser_default_enabled,omitempty"`
}

// tipsCurrencyRe enforces the same ISO 4217 lowercase-letters shape as
// the DB CHECK constraint. Mirrors the API surface Ghost / Substack /
// Buttondown expose on their analogous endpoints.
var tipsCurrencyRe = regexp.MustCompile(`^[a-z]{3}$`)

const (
	// tipsMinAmountFloor matches the DB CHECK constraint
	// (`tips_min_amount_ge_50`) — Stripe rejects checkout sessions
	// below the local equivalent of US$0.50 with `amount_too_small`,
	// so 50 minor units is the absolute lower bound regardless of
	// currency. Operators can set a higher floor; lower is rejected.
	tipsMinAmountFloor = 50
	// tipsSuggestedMaxEntries caps the picker length so a typoed
	// operator-side input (e.g. paste of a 1k-element array) can't
	// blow up the public JSON response.
	tipsSuggestedMaxEntries = 8
	// tipsMessageMaxLen — short blurb above the picker. Long enough
	// for a sentence + emoji, short enough that it can't be used as
	// a free-text storage column.
	tipsMessageMaxLen = 240
)

var (
	errTipsCurrencyShape = errors.New(
		"archive: tips_currency must be a 3-letter lowercase ISO 4217 code (e.g. 'usd', 'eur')")
	errTipsMinAmountTooLow = errors.New(
		"archive: tips_min_amount must be at least 50 minor units (Stripe rejects smaller amounts)")
	errTipsSuggestedAmount = errors.New(
		"archive: every tips_suggested_amounts entry must be ≥ tips_min_amount and ≤ $1,000,000")
	errTipsTooManySuggested = errors.New(
		"archive: tips_suggested_amounts is capped at 8 quick-pick entries")
	errTipsMessageTooLong = errors.New(
		"archive: tips_message must be 240 characters or fewer")
)

// validateTipsInput enforces the shape rules the public-checkout +
// webhook paths rely on (currency, min amount, suggested-amount
// bounds). Pure function so the test suite can cover the rules without
// spinning up a DB. Returns nil if every supplied (non-nil) field is
// within bounds.
//
// Notes on the suggested-amount range:
//   - Lower bound is tips_min_amount (or current TipsMinAmount if
//     the caller didn't include one). A picker quick-pick below the
//     floor would create a Stripe session that 400s on submission;
//     better to reject at the config write.
//   - Upper bound is 100_000_000 (US$1,000,000 in cents). Stripe's
//     hard ceiling is US$999,999.99; we round-up at the API boundary.
func validateTipsInput(in TenantSettingsInput, currentMin int) error {
	if in.TipsCurrency != nil {
		c := strings.ToLower(strings.TrimSpace(*in.TipsCurrency))
		if !tipsCurrencyRe.MatchString(c) {
			return errTipsCurrencyShape
		}
	}
	floor := currentMin
	if in.TipsMinAmount != nil {
		if *in.TipsMinAmount < tipsMinAmountFloor {
			return errTipsMinAmountTooLow
		}
		floor = *in.TipsMinAmount
	}
	if floor < tipsMinAmountFloor {
		floor = tipsMinAmountFloor
	}
	if in.TipsSuggestedAmounts != nil {
		amts := *in.TipsSuggestedAmounts
		if len(amts) > tipsSuggestedMaxEntries {
			return errTipsTooManySuggested
		}
		for _, a := range amts {
			if a < floor || a > 100_000_000 {
				return errTipsSuggestedAmount
			}
		}
	}
	if in.TipsMessage != nil && len(*in.TipsMessage) > tipsMessageMaxLen {
		return errTipsMessageTooLong
	}
	return nil
}

// archiveSlugRe enforces kebab-case lowercase-alphanumeric. URL-safe by
// construction (no escaping needed), no leading/trailing hyphens, and
// the 64-char cap matches Postgres' realistic citext index width while
// staying well under the 2 KB URL cap modern browsers enforce.
//
// Note: the empty string is allowed by the handler (it clears the
// slug); the regex is only checked when the caller supplies a non-empty
// value.
var archiveSlugRe = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

const archiveSlugMaxLen = 64

// ValidateArchiveSlug returns nil for the empty string (clears the
// column) or a non-empty kebab-case slug ≤64 chars. Anything else
// returns a stable, user-facing error code.
func ValidateArchiveSlug(slug string) error {
	if slug == "" {
		return nil
	}
	if len(slug) > archiveSlugMaxLen {
		return errSlugTooLong
	}
	if !archiveSlugRe.MatchString(slug) {
		return errSlugShape
	}
	return nil
}

var (
	// ErrSlugTaken is returned when the chosen tenant_archive_slug is
	// already in use by another tenant. The DB unique constraint is the
	// source of truth; we surface a structured error so the desktop can
	// render a friendly "slug already taken" message without a JSON
	// inspect.
	ErrSlugTaken = errors.New("archive: slug already taken")

	errSlugTooLong = errors.New("archive: slug must be 64 characters or fewer")
	errSlugShape   = errors.New("archive: slug must be lowercase letters, digits, and dashes (kebab-case)")
)

// GetTenantSettings reads the row for the supplied tenant, returning a
// zero-valued struct (all "") when none exists yet. Runs inside a
// `db.WithTenant` transaction so the RLS-isolated row is visible.
func (r *Repo) GetTenantSettings(ctx context.Context, tenantID string) (TenantSettings, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return TenantSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		slug, domain, title, tagline *string
		tipsEnabled                  bool
		tipsCurrency                 string
		tipsSuggested                []int32
		tipsMinAmount                int
		tipsMessage                  *string
		archiveBarEnabled            bool
		archiveBarText               *string
		viewInBrowserEnabled         bool
	)
	err = tx.QueryRow(ctx, `
SELECT tenant_archive_slug::text,
       archive_domain::text,
       archive_title,
       archive_tagline,
       COALESCE(tips_enabled, false),
       COALESCE(tips_currency, 'usd'),
       COALESCE(tips_suggested_amounts, '{}'::integer[]),
       COALESCE(tips_min_amount, 100),
       tips_message,
       COALESCE(archive_bar_default_enabled, true),
       archive_bar_default_text,
       COALESCE(view_in_browser_default_enabled, true)
  FROM tenant_public_settings
 WHERE tenant_id = $1::uuid
 LIMIT 1`, tenantID).Scan(
		&slug, &domain, &title, &tagline,
		&tipsEnabled, &tipsCurrency, &tipsSuggested, &tipsMinAmount, &tipsMessage,
		&archiveBarEnabled, &archiveBarText, &viewInBrowserEnabled,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// First read for a newly-provisioned tenant: return an empty
		// envelope so the frontend can render the form without a
		// special-case "not configured" branch. The Tips defaults
		// mirror the DB column defaults so the frontend shows the
		// pre-baked picker amounts on a brand-new tenant. The
		// archive-bar defaults mirror migration 0297's column DEFAULTs
		// (both toggles ON) so the form pre-fills consistently
		// whether or not a row exists.
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return TenantSettings{}, commitErr
		}
		return TenantSettings{
			TipsCurrency:                "usd",
			TipsSuggestedAmounts:        []int{300, 500, 1000, 2500},
			TipsMinAmount:               100,
			ArchiveBarDefaultEnabled:    true,
			ViewInBrowserDefaultEnabled: true,
		}, nil
	}
	if err != nil {
		return TenantSettings{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TenantSettings{}, err
	}
	suggested := make([]int, len(tipsSuggested))
	for i, v := range tipsSuggested {
		suggested[i] = int(v)
	}
	return TenantSettings{
		TenantArchiveSlug:           derefOrEmpty(slug),
		ArchiveDomain:               derefOrEmpty(domain),
		ArchiveTitle:                derefOrEmpty(title),
		ArchiveTagline:              derefOrEmpty(tagline),
		TipsEnabled:                 tipsEnabled,
		TipsCurrency:                tipsCurrency,
		TipsSuggestedAmounts:        suggested,
		TipsMinAmount:               tipsMinAmount,
		TipsMessage:                 derefOrEmpty(tipsMessage),
		ArchiveBarDefaultEnabled:    archiveBarEnabled,
		ArchiveBarDefaultText:       derefOrEmpty(archiveBarText),
		ViewInBrowserDefaultEnabled: viewInBrowserEnabled,
	}, nil
}

// PublicTipsConfig is the slimmer projection of TenantSettings the
// unauthenticated public-archive page needs to render the tip jar.
// Distinct from TenantSettings so we never accidentally leak slug /
// domain to a public response.
type PublicTipsConfig struct {
	Enabled          bool   `json:"enabled"`
	Currency         string `json:"currency"`
	SuggestedAmounts []int  `json:"suggestedAmounts"`
	MinAmount        int    `json:"minAmount"`
	Message          string `json:"message,omitempty"`
}

// GetPublicTipsConfig returns the public-side tip-jar config for the
// supplied tenant. Returns Enabled=false when the row is missing OR
// tips_enabled is false; the public handler treats both cases the same
// (no tip button rendered) but the call still succeeds so the frontend
// can probe without a 404 special case.
//
// Runs WITHOUT db.WithTenant — the lookup is by tenant_id (already
// resolved from the public slug) and the PERMISSIVE
// tenant_public_settings_public_lookup policy gates by
// tenant_archive_slug IS NOT NULL. Same access pattern as TenantBySlug.
func (r *Repo) GetPublicTipsConfig(ctx context.Context, tenantID string) (PublicTipsConfig, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return PublicTipsConfig{}, err
	}
	defer conn.Release()
	var (
		enabled   bool
		currency  string
		suggested []int32
		minAmount int
		message   *string
	)
	err = conn.QueryRow(ctx, `
SELECT COALESCE(tips_enabled, false),
       COALESCE(tips_currency, 'usd'),
       COALESCE(tips_suggested_amounts, '{}'::integer[]),
       COALESCE(tips_min_amount, 100),
       tips_message
  FROM tenant_public_settings
 WHERE tenant_id = $1::uuid
 LIMIT 1`, tenantID).Scan(&enabled, &currency, &suggested, &minAmount, &message)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicTipsConfig{}, nil
	}
	if err != nil {
		return PublicTipsConfig{}, err
	}
	out := PublicTipsConfig{
		Enabled:   enabled,
		Currency:  currency,
		MinAmount: minAmount,
		Message:   derefOrEmpty(message),
	}
	out.SuggestedAmounts = make([]int, len(suggested))
	for i, v := range suggested {
		out.SuggestedAmounts[i] = int(v)
	}
	return out, nil
}

// UpsertTenantSettings writes the supplied (partial) input into
// `tenant_public_settings`, creating the row if it doesn't exist yet.
// Pointer-nil fields in the input are preserved from any existing row
// via COALESCE; explicit empty strings clear the column.
//
// Uniqueness on `tenant_archive_slug` is enforced by the citext UNIQUE
// constraint from migration 0071; we map the pgx 23505 unique-violation
// to ErrSlugTaken so the handler can return a structured 409.
func (r *Repo) UpsertTenantSettings(ctx context.Context, tenantID string, in TenantSettingsInput) (TenantSettings, error) {
	// Validate slug up front — cheaper than a DB round-trip, and avoids
	// burning a transaction on a guaranteed-rejected write.
	if in.TenantArchiveSlug != nil {
		if err := ValidateArchiveSlug(strings.TrimSpace(*in.TenantArchiveSlug)); err != nil {
			return TenantSettings{}, err
		}
	}
	// Validate custom-domain shape so the host-header resolver never
	// has to handle malformed citext values. Empty string is allowed
	// (clears the column). See `ValidateArchiveDomain` in custom_domain.go.
	if in.ArchiveDomain != nil {
		if err := ValidateArchiveDomain(strings.TrimSpace(*in.ArchiveDomain)); err != nil {
			return TenantSettings{}, err
		}
	}
	// Validate the Tips block. We pre-fetch the current min so a PATCH
	// that updates SuggestedAmounts but not MinAmount still validates
	// against the right floor.
	if in.TipsCurrency != nil || in.TipsMinAmount != nil ||
		in.TipsSuggestedAmounts != nil || in.TipsMessage != nil {
		currentMin := 100
		if cur, err := r.GetTenantSettings(ctx, tenantID); err == nil && cur.TipsMinAmount > 0 {
			currentMin = cur.TipsMinAmount
		}
		if err := validateTipsInput(in, currentMin); err != nil {
			return TenantSettings{}, err
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return TenantSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The UPSERT relies on `tenant_id` PK. For each pointer-nil field we
	// pass `present=false` and the SQL falls back to the EXCLUDED row's
	// COALESCE, which on the INSERT branch is `''` and on the UPDATE
	// branch keeps the existing column.
	//
	// Slug is stored as citext, so we cast `''` -> NULL via NULLIF so
	// multiple tenants with no slug configured don't collide on the
	// UNIQUE index. (Storing '' would also break TenantBySlug.)
	slugPresent := in.TenantArchiveSlug != nil
	domainPresent := in.ArchiveDomain != nil
	titlePresent := in.ArchiveTitle != nil
	taglinePresent := in.ArchiveTagline != nil
	tipsEnabledPresent := in.TipsEnabled != nil
	tipsCurrencyPresent := in.TipsCurrency != nil
	tipsSuggestedPresent := in.TipsSuggestedAmounts != nil
	tipsMinPresent := in.TipsMinAmount != nil
	tipsMessagePresent := in.TipsMessage != nil
	// Archive-bar pointer presence flags. nil = leave column alone,
	// non-nil = overwrite (boolean true/false or text empty/non-empty).
	archiveBarEnabledPresent := in.ArchiveBarDefaultEnabled != nil
	archiveBarTextPresent := in.ArchiveBarDefaultText != nil
	viewInBrowserEnabledPresent := in.ViewInBrowserDefaultEnabled != nil

	slugVal := ""
	if slugPresent {
		slugVal = strings.TrimSpace(*in.TenantArchiveSlug)
	}
	domainVal := ""
	if domainPresent {
		domainVal = strings.TrimSpace(*in.ArchiveDomain)
	}
	titleVal := ""
	if titlePresent {
		titleVal = strings.TrimSpace(*in.ArchiveTitle)
	}
	taglineVal := ""
	if taglinePresent {
		taglineVal = strings.TrimSpace(*in.ArchiveTagline)
	}
	tipsEnabledVal := false
	if tipsEnabledPresent {
		tipsEnabledVal = *in.TipsEnabled
	}
	tipsCurrencyVal := "usd"
	if tipsCurrencyPresent {
		tipsCurrencyVal = strings.ToLower(strings.TrimSpace(*in.TipsCurrency))
	}
	// pgx maps []int → integer[] natively; we keep int32 for clarity.
	tipsSuggestedVal := []int32{}
	if tipsSuggestedPresent {
		for _, v := range *in.TipsSuggestedAmounts {
			tipsSuggestedVal = append(tipsSuggestedVal, int32(v))
		}
	}
	tipsMinVal := 100
	if tipsMinPresent {
		tipsMinVal = *in.TipsMinAmount
	}
	tipsMessageVal := ""
	if tipsMessagePresent {
		tipsMessageVal = strings.TrimSpace(*in.TipsMessage)
	}
	// Archive-bar values. Boolean PATCH-style — when present-flag is
	// false the value is ignored and the existing column is preserved
	// by the UPSERT's CASE branch. The text column accepts empty-string
	// as "clear the column"; NULLIF handles the convert-to-NULL.
	archiveBarEnabledVal := true
	if archiveBarEnabledPresent {
		archiveBarEnabledVal = *in.ArchiveBarDefaultEnabled
	}
	archiveBarTextVal := ""
	if archiveBarTextPresent {
		archiveBarTextVal = strings.TrimSpace(*in.ArchiveBarDefaultText)
	}
	viewInBrowserEnabledVal := true
	if viewInBrowserEnabledPresent {
		viewInBrowserEnabledVal = *in.ViewInBrowserDefaultEnabled
	}

	const q = `
INSERT INTO tenant_public_settings (
    tenant_id,
    tenant_archive_slug,
    archive_domain,
    archive_title,
    archive_tagline,
    tips_enabled,
    tips_currency,
    tips_suggested_amounts,
    tips_min_amount,
    tips_message,
    archive_bar_default_enabled,
    archive_bar_default_text,
    view_in_browser_default_enabled,
    updated_at
) VALUES (
    $1::uuid,
    NULLIF($3, ''),
    NULLIF($5, ''),
    NULLIF($7, ''),
    NULLIF($9, ''),
    COALESCE($11::boolean, false),
    COALESCE(NULLIF($13, ''), 'usd'),
    COALESCE($15::integer[], '{}'::integer[]),
    COALESCE($17::integer, 100),
    NULLIF($19, ''),
    COALESCE($21::boolean, true),
    NULLIF($23, ''),
    COALESCE($25::boolean, true),
    now()
)
ON CONFLICT (tenant_id) DO UPDATE
   SET tenant_archive_slug = CASE WHEN $2::boolean
                                  THEN NULLIF(EXCLUDED.tenant_archive_slug::text, '')::citext
                                  ELSE tenant_public_settings.tenant_archive_slug END,
       archive_domain      = CASE WHEN $4::boolean
                                  THEN NULLIF(EXCLUDED.archive_domain::text, '')::citext
                                  ELSE tenant_public_settings.archive_domain END,
       archive_title       = CASE WHEN $6::boolean
                                  THEN NULLIF(EXCLUDED.archive_title, '')
                                  ELSE tenant_public_settings.archive_title END,
       archive_tagline     = CASE WHEN $8::boolean
                                  THEN NULLIF(EXCLUDED.archive_tagline, '')
                                  ELSE tenant_public_settings.archive_tagline END,
       tips_enabled        = CASE WHEN $10::boolean
                                  THEN EXCLUDED.tips_enabled
                                  ELSE tenant_public_settings.tips_enabled END,
       tips_currency       = CASE WHEN $12::boolean
                                  THEN EXCLUDED.tips_currency
                                  ELSE tenant_public_settings.tips_currency END,
       tips_suggested_amounts = CASE WHEN $14::boolean
                                  THEN EXCLUDED.tips_suggested_amounts
                                  ELSE tenant_public_settings.tips_suggested_amounts END,
       tips_min_amount     = CASE WHEN $16::boolean
                                  THEN EXCLUDED.tips_min_amount
                                  ELSE tenant_public_settings.tips_min_amount END,
       tips_message        = CASE WHEN $18::boolean
                                  THEN NULLIF(EXCLUDED.tips_message, '')
                                  ELSE tenant_public_settings.tips_message END,
       archive_bar_default_enabled = CASE WHEN $20::boolean
                                  THEN EXCLUDED.archive_bar_default_enabled
                                  ELSE tenant_public_settings.archive_bar_default_enabled END,
       archive_bar_default_text    = CASE WHEN $22::boolean
                                  THEN NULLIF(EXCLUDED.archive_bar_default_text, '')
                                  ELSE tenant_public_settings.archive_bar_default_text END,
       view_in_browser_default_enabled = CASE WHEN $24::boolean
                                  THEN EXCLUDED.view_in_browser_default_enabled
                                  ELSE tenant_public_settings.view_in_browser_default_enabled END,
       updated_at          = now()`
	if _, err := tx.Exec(ctx, q,
		tenantID,
		slugPresent, slugVal,
		domainPresent, domainVal,
		titlePresent, titleVal,
		taglinePresent, taglineVal,
		tipsEnabledPresent, tipsEnabledVal,
		tipsCurrencyPresent, tipsCurrencyVal,
		tipsSuggestedPresent, tipsSuggestedVal,
		tipsMinPresent, tipsMinVal,
		tipsMessagePresent, tipsMessageVal,
		archiveBarEnabledPresent, archiveBarEnabledVal,
		archiveBarTextPresent, archiveBarTextVal,
		viewInBrowserEnabledPresent, viewInBrowserEnabledVal,
	); err != nil {
		// Map the unique-violation on tenant_archive_slug to a
		// structured error. Postgres SQLSTATE 23505 fires whether the
		// conflict happened on INSERT or UPDATE.
		if isUniqueViolation(err) {
			return TenantSettings{}, ErrSlugTaken
		}
		return TenantSettings{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TenantSettings{}, err
	}
	// Re-read so the response reflects the post-merge state (matters
	// when the caller PATCH'd a single field and wants the rest back).
	return r.GetTenantSettings(ctx, tenantID)
}

// AdminGetTenantSettings handles GET /api/v1/admin/archive/tenant-settings.
func (d *Deps) AdminGetTenantSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	out, err := d.Repo.GetTenantSettings(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminPutTenantSettings handles PUT /api/v1/admin/archive/tenant-settings.
func (d *Deps) AdminPutTenantSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in TenantSettingsInput
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.UpsertTenantSettings(r.Context(), t.ID, in)
	if err != nil {
		switch {
		case errors.Is(err, errSlugShape), errors.Is(err, errSlugTooLong):
			httperror.WriteValidation(w, "invalid_slug", err.Error())
			return
		case errors.Is(err, ErrInvalidDomain), errors.Is(err, ErrReservedDomain):
			httperror.WriteValidation(w, "invalid_domain", err.Error())
			return
		case errors.Is(err, ErrSlugTaken):
			httperror.Write(w, http.StatusConflict, "slug_taken",
				"that archive slug is already in use by another publication")
			return
		case errors.Is(err, errTipsCurrencyShape),
			errors.Is(err, errTipsMinAmountTooLow),
			errors.Is(err, errTipsSuggestedAmount),
			errors.Is(err, errTipsTooManySuggested),
			errors.Is(err, errTipsMessageTooLong):
			httperror.WriteValidation(w, "invalid_tips_config", err.Error())
			return
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// MountTenantSettingsRoutes registers the GET + PUT admin endpoints on
// the supplied router. Kept as a separate Mount* function so the caller
// (apps/api/main.go) can decide where to wedge it into the
// already-authenticated route group.
//
// Both routes are gated by apikeys.RequireScope(apikeys.ScopeAdmin) so
// API-key callers need the `admin` scope and dashboard callers need
// the `owner` / `admin` session role.
func (d *Deps) MountTenantSettingsRoutes(r chi.Router) {
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	admin.Get("/api/v1/admin/archive/tenant-settings", d.AdminGetTenantSettings)
	admin.Put("/api/v1/admin/archive/tenant-settings", d.AdminPutTenantSettings)
}

// derefOrEmpty unwraps an optional string column.
func derefOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// isUniqueViolation reports whether the supplied error is a Postgres
// 23505 unique-constraint violation. Implemented via errors.As so it
// keeps working when pgx wraps the underlying PgError (which it does
// inside transactions).
func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23505"
	}
	return false
}
