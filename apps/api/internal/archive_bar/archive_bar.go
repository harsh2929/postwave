// Package archive_bar renders the Mailchimp-parity "Archive Bar" — the
// optional persistent in-email strip that lets a recipient pop open the
// publication's full archive — plus the per-campaign "View this email
// in your browser" link.
//
// Gap feature: archive-mailchimpv3-archive-bar (P2, surface=archive).
// Mailchimp's Archive Bar is the canonical reference; Ghost ships the
// equivalent as the `{{ view_url }}` Handlebars helper in its default
// newsletter. Moosewave's default body previously had neither, so
// recipients with broken inline-image rendering had no fallback and the
// audience archive was invisible from the email itself.
//
// Surface contract (campaign-body tokens, mirroring the existing
// `{{ unsubscribe_url }}` convention in sending/list_unsubscribe.go):
//
//	{{ archive_bar }}            full HTML strip; injected by Render
//	                             when archive_bar_enabled is true.
//	{{ view_in_browser_url }}    bare URL; replaced inline so operators
//	                             can wrap their own anchor copy.
//	{{ archive_url }}            bare URL to the publication archive
//	                             index (no campaign-specific path).
//
// Resolution precedence (most-specific wins):
//
//  1. Per-campaign delivery_settings:
//     archive_bar_enabled       (bool)
//     view_in_browser_enabled   (bool)
//  2. Tenant defaults from tenant_public_settings:
//     archive_bar_default_enabled
//     view_in_browser_default_enabled
//
// When the resolved value is false the corresponding token is replaced
// with the empty string so the body emits no extra chrome — same
// pattern Listmonk uses for tracking-opt-out recipients.
package archive_bar

import (
	"context"
	"errors"
	"fmt"
	"html"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Default copy for the Archive Bar CTA. Matches Mailchimp's
// out-of-the-box text closely enough that operators migrating from
// Mailchimp don't need to re-author. Localisation lives in
// tenant_public_settings.archive_bar_default_text, which (when set)
// overrides this on a per-tenant basis.
const (
	defaultArchiveBarText      = "View this email in your browser"
	defaultArchiveIndexCTA     = "View past issues"
	defaultArchiveBarSeparator = " | "
)

// Tenant-level archive-bar defaults loaded from tenant_public_settings.
// Loaded once per send / preview pass, NOT per recipient — the cost is a
// single SELECT against a single-row-per-tenant table.
type TenantDefaults struct {
	// ArchiveBarEnabled is the tenant-level default for whether the
	// Archive Bar renders. Per-campaign delivery_settings overrides.
	ArchiveBarEnabled bool
	// ViewInBrowserEnabled is the tenant-level default for whether the
	// {{ view_in_browser_url }} link renders. Per-campaign
	// delivery_settings overrides.
	ViewInBrowserEnabled bool
	// ArchiveBarText is the optional override for the CTA copy. Empty
	// means "use the package default". Free-form text; HTML-escaped at
	// render-time.
	ArchiveBarText string
	// TenantArchiveSlug is the tenant's public archive slug — the same
	// column tenant_public_settings stores for the public archive
	// landing page. When empty the archive bar still renders but the
	// "View past issues" link is suppressed (the index URL would 404
	// without a slug-resolvable tenant).
	TenantArchiveSlug string
	// ArchiveDomain, when set, overrides PublicBaseURL for this
	// tenant. Matches the existing tenant_public_settings.archive_domain
	// column used by the archive package.
	ArchiveDomain string
}

// Repo is the read-only tenant_public_settings projection. The columns
// archive_bar_default_enabled / archive_bar_default_text /
// view_in_browser_default_enabled were added in migration 0297.
type Repo struct {
	Pool *db.Pool
}

// ErrNoTenant is returned when no row exists in tenant_public_settings
// for the given tenant. Callers should treat this as "use package
// defaults" — see DefaultsOrFallback below.
var ErrNoTenant = errors.New("archive_bar: no tenant_public_settings row")

// LoadDefaults reads the tenant's archive-bar configuration. Falls back
// to package defaults (both toggles on, empty slug) when the row is
// missing — keeps the Render path single-flight even for tenants that
// have never opened the Archive settings form.
//
// Public-archive access path: this lookup intentionally does NOT call
// db.WithTenant because the tenant_public_settings row is keyed by
// tenant_id directly (no RLS on the surface — see migration 0152), and
// the send loop has already validated tenantID upstream.
func (r *Repo) LoadDefaults(ctx context.Context, tenantID string) (TenantDefaults, error) {
	if r == nil || r.Pool == nil {
		return TenantDefaults{ArchiveBarEnabled: true, ViewInBrowserEnabled: true}, nil
	}
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return TenantDefaults{}, err
	}
	defer conn.Release()
	var (
		barEnabled    bool
		viewEnabled   bool
		barText       *string
		archiveSlug   *string
		archiveDomain *string
	)
	err = conn.QueryRow(ctx, `
SELECT COALESCE(archive_bar_default_enabled, true),
       COALESCE(view_in_browser_default_enabled, true),
       archive_bar_default_text,
       tenant_archive_slug,
       archive_domain
  FROM tenant_public_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&barEnabled, &viewEnabled, &barText, &archiveSlug, &archiveDomain)
	if errors.Is(err, pgx.ErrNoRows) {
		// Sane fallback: tenant has not yet opened the Archive
		// settings form. Mailchimp ships the Archive Bar on by
		// default; mirror that so the migration's intent ("default-on
		// in template scaffolds") survives newly-provisioned tenants
		// who haven't yet customised anything.
		return TenantDefaults{ArchiveBarEnabled: true, ViewInBrowserEnabled: true}, nil
	}
	if err != nil {
		return TenantDefaults{}, err
	}
	out := TenantDefaults{
		ArchiveBarEnabled:    barEnabled,
		ViewInBrowserEnabled: viewEnabled,
	}
	if barText != nil {
		out.ArchiveBarText = strings.TrimSpace(*barText)
	}
	if archiveSlug != nil {
		out.TenantArchiveSlug = strings.TrimSpace(*archiveSlug)
	}
	if archiveDomain != nil {
		out.ArchiveDomain = strings.TrimSpace(*archiveDomain)
	}
	return out, nil
}

// RenderInputs is the per-campaign / per-recipient resolution context
// the Render() function consumes. Empty zero-value is safe: every
// pointer is treated as "use the tenant default", every string as
// "missing -> suppress link".
type RenderInputs struct {
	// Defaults is the tenant_public_settings projection. Caller is
	// responsible for loading it (LoadDefaults) once per send pass.
	Defaults TenantDefaults
	// CampaignArchiveBarOverride / CampaignViewInBrowserOverride are
	// the per-campaign overrides read from campaigns.delivery_settings.
	// nil = "follow the tenant default", non-nil = "use this value
	// regardless of the tenant default". See ResolveCampaignOverrides.
	CampaignArchiveBarOverride    *bool
	CampaignViewInBrowserOverride *bool
	// PublicBaseURL is the scheme+host the public archive surface is
	// served from (e.g. https://archive.moosewave.com). Empty means the
	// archive index link is suppressed — same fallback as the send-loop
	// list-unsubscribe builder.
	PublicBaseURL string
	// CampaignArchiveSlug is the per-issue archive slug
	// (campaigns.archive_slug). When non-empty, the
	// view_in_browser_url resolves to the per-issue public URL. Empty
	// means the link is suppressed (the issue isn't published, so
	// there's nowhere to point at).
	CampaignArchiveSlug string
	// CampaignPublic indicates whether campaigns.archive_public is
	// true for this campaign. View-in-browser falls back to suppression
	// when the issue isn't published yet — the public URL would 404.
	CampaignPublic bool
}

// resolved consolidates the precedence rules so Render and the
// admin-preview path share a single source of truth.
type resolved struct {
	archiveBarEnabled    bool
	viewInBrowserEnabled bool
	barText              string
	archiveIndexURL      string
	viewInBrowserURL     string
}

func (i RenderInputs) resolve() resolved {
	out := resolved{
		archiveBarEnabled:    i.Defaults.ArchiveBarEnabled,
		viewInBrowserEnabled: i.Defaults.ViewInBrowserEnabled,
		barText:              i.Defaults.ArchiveBarText,
	}
	if i.CampaignArchiveBarOverride != nil {
		out.archiveBarEnabled = *i.CampaignArchiveBarOverride
	}
	if i.CampaignViewInBrowserOverride != nil {
		out.viewInBrowserEnabled = *i.CampaignViewInBrowserOverride
	}
	if out.barText == "" {
		out.barText = defaultArchiveBarText
	}
	base := strings.TrimRight(i.PublicBaseURL, "/")
	if i.Defaults.ArchiveDomain != "" {
		// Custom domain takes precedence over the platform host —
		// matches the archive package's behaviour for the same column.
		base = "https://" + strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(i.Defaults.ArchiveDomain, "https://"), "http://"), "/")
	}
	if base != "" && i.Defaults.TenantArchiveSlug != "" {
		out.archiveIndexURL = fmt.Sprintf("%s/%s", base, i.Defaults.TenantArchiveSlug)
		// Per-issue URL — only resolves when the campaign was published
		// to the archive. Unpublished campaigns suppress the link so
		// the body doesn't carry a dead URL recipients could click into.
		if i.CampaignPublic && i.CampaignArchiveSlug != "" {
			out.viewInBrowserURL = fmt.Sprintf("%s/%s/%s", base, i.Defaults.TenantArchiveSlug, i.CampaignArchiveSlug)
		}
	}
	return out
}

// Render substitutes the archive-bar tokens in the body. Mirrors the
// `RenderUnsubscribePlaceholder` API from sending/list_unsubscribe.go so
// callers can chain the two without ceremony.
//
// Token coverage (matches what email_template/template.go already lets
// pass through verbatim):
//
//	{{ archive_bar }}            → full HTML strip when enabled, else ""
//	{{ view_in_browser_url }}    → bare URL when enabled, else ""
//	{{ archive_url }}            → bare archive index URL, always emitted
//	                               when the tenant has a slug+base.
//	{{archive_bar}} / {{view_in_browser_url}} / {{archive_url}}
//	                             → same as above, no-space variants.
//
// Empty body returns empty.
func Render(body string, inputs RenderInputs) string {
	if body == "" {
		return body
	}
	r := inputs.resolve()
	barHTML := ""
	if r.archiveBarEnabled {
		barHTML = renderArchiveBarHTML(r)
	}
	viewURL := ""
	if r.viewInBrowserEnabled {
		viewURL = r.viewInBrowserURL
	}
	out := body
	for _, p := range []string{"{{ archive_bar }}", "{{archive_bar}}"} {
		out = strings.ReplaceAll(out, p, barHTML)
	}
	for _, p := range []string{"{{ view_in_browser_url }}", "{{view_in_browser_url}}"} {
		out = strings.ReplaceAll(out, p, viewURL)
	}
	for _, p := range []string{"{{ archive_url }}", "{{archive_url}}"} {
		out = strings.ReplaceAll(out, p, r.archiveIndexURL)
	}
	return out
}

// renderArchiveBarHTML returns the HTML strip injected for
// `{{ archive_bar }}`. Inline-styled because email clients drop <style>
// blocks; mirrors the styling conventions in email_blocks.go.
//
// Layout matches Mailchimp's documented bar: a single-row centered
// strip with the "View in browser" CTA on the left and the archive
// index link on the right, separated by a vertical bar. When either
// URL is empty (suppressed by the resolver), only the available CTA
// renders — no orphan separators.
func renderArchiveBarHTML(r resolved) string {
	if r.viewInBrowserURL == "" && r.archiveIndexURL == "" {
		// Neither URL resolves — the bar has no actionable content.
		// Returning empty keeps the body free of an empty strip.
		return ""
	}
	var parts []string
	if r.viewInBrowserURL != "" {
		parts = append(parts, fmt.Sprintf(
			`<a href="%s" style="color:#1f2937;text-decoration:underline">%s</a>`,
			html.EscapeString(r.viewInBrowserURL),
			html.EscapeString(r.barText),
		))
	}
	if r.archiveIndexURL != "" {
		parts = append(parts, fmt.Sprintf(
			`<a href="%s" style="color:#1f2937;text-decoration:underline">%s</a>`,
			html.EscapeString(r.archiveIndexURL),
			html.EscapeString(defaultArchiveIndexCTA),
		))
	}
	inner := strings.Join(parts, html.EscapeString(defaultArchiveBarSeparator))
	return fmt.Sprintf(
		`<div data-postwave-archive-bar="1" style="background:#f3f4f6;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;padding:8px 16px;text-align:center;border-bottom:1px solid #e5e7eb">%s</div>`,
		inner,
	)
}

// ResolveCampaignOverrides reads the per-campaign archive-bar /
// view-in-browser overrides out of `campaigns.delivery_settings`. The
// jsonb keys are `archive_bar_enabled` and `view_in_browser_enabled`;
// missing keys return nil pointers (i.e. "use the tenant default").
//
// Defensive: accepts both native bool and the JSON-unmarshalled
// `bool`-typed `any` (the campaigns package returns `map[string]any`,
// where booleans decode as `bool`). Unknown types silently degrade to
// nil so a malformed editor save doesn't crash the render path.
func ResolveCampaignOverrides(deliverySettings map[string]any) (archiveBar, viewInBrowser *bool) {
	if deliverySettings == nil {
		return nil, nil
	}
	if v, ok := deliverySettings["archive_bar_enabled"]; ok {
		if b, isBool := v.(bool); isBool {
			archiveBar = &b
		}
	}
	if v, ok := deliverySettings["view_in_browser_enabled"]; ok {
		if b, isBool := v.(bool); isBool {
			viewInBrowser = &b
		}
	}
	return archiveBar, viewInBrowser
}

// HasArchiveBarToken reports whether the body contains any of the
// supported archive-bar tokens. Used by the campaign template scaffold
// path to decide whether to inject the bar automatically when the
// tenant default is on — operators who explicitly opt out (by deleting
// the token from their custom template) keep that opt-out.
func HasArchiveBarToken(body string) bool {
	for _, p := range []string{"{{ archive_bar }}", "{{archive_bar}}", "{{ view_in_browser_url }}", "{{view_in_browser_url}}", "{{ archive_url }}", "{{archive_url}}"} {
		if strings.Contains(body, p) {
			return true
		}
	}
	return false
}

// DefaultScaffoldFooter returns the canonical footer snippet new
// templates ship with. Wired into campaign-template scaffolds (and the
// 2026 platform-template pack) so every new template carries the
// archive bar token + view-in-browser fallback link next to the
// existing unsubscribe link. Operators who don't want the bar can
// delete the token; the bar is suppressed when the tenant toggle is
// off OR the campaign override is false.
//
// The literal string deliberately uses the same `{{ ... }}` token
// shape the email_template / sending packages already round-trip
// verbatim, so the scaffold survives a Preview round-trip without
// substitution at compose-time.
const DefaultScaffoldFooter = `<!-- archive-mailchimpv3-archive-bar: default-on template chrome -->
{{ archive_bar }}
<p style="font-size:12px;color:#6b7280;text-align:center">
  <a href="{{ view_in_browser_url }}" style="color:#6b7280">View this email in your browser</a>
  &middot;
  <a href="{{ unsubscribe_url }}" style="color:#6b7280">Unsubscribe</a>
</p>`
