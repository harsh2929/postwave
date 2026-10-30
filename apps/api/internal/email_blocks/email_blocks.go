// SPDX-License-Identifier: AGPL-3.0-only
//
// Package email_blocks is the block library + composer behind the
// visual drag-drop email editor.
//
// The editor doesn't write MJML directly. It maintains an ordered
// list of BlockInstance values — each instance is { block_id,
// config } — and the COMPOSE endpoint turns that list into a
// full MJML document. Round-trip integrity: edit → save the
// instance list (JSON, ~1 KB per email), recompose on demand.
//
// Why blocks instead of raw MJML in the editor:
//
//   * Designers can drag a "Two-column with image" without knowing
//     the MJML syntax.
//   * Brand consistency: every block emits the tenant's primary
//     color + body font via vars the editor surfaces in one place.
//   * Backwards-compatible upgrades: changing a block's MJML
//     template auto-updates every campaign that uses it on next
//     compose; no manual re-edit.
//
// V1 block catalog covers the universal set:
//
//   header_logo        logo + brand-color band
//   hero_text          large headline + subhead
//   hero_image         full-width image
//   text               paragraph with merge fields
//   button             single CTA
//   two_column         text-left / image-right (or reverse)
//   image_and_caption  image + caption
//   product_recommendations ecommerce recommendation grid
//   discount_code      promo-code callout
//   survey             hosted survey / email poll prompt
//   social_follow      follow icons/links
//   social_share       share campaign links
//   rss                RSS feed placeholder
//   video              email-friendly linked video thumbnail
//   dynamic_content    conditional content driven by merge data
//   conditional_content Mailchimp-style conditional merge tags
//   divider            horizontal rule
//   spacer             vertical whitespace
//   footer             address, unsubscribe link, social icons

package email_blocks

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Block is one entry in the catalog. Editor renders one icon +
// preview per block.
type Block struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Category    string `json:"category"`
	Description string `json:"description"`
	// Fields is the editor's config schema. Each field tells the
	// editor what input widget to render (text / textarea / image /
	// color / number / select).
	Fields []FieldSpec `json:"fields"`
	// Defaults — sensible starting values when the block is dragged
	// onto the canvas.
	Defaults map[string]any `json:"defaults"`
}

// FieldSpec describes one editor input.
type FieldSpec struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Type    string   `json:"type"` // text | textarea | image_url | color | url | number | select | bool
	Options []string `json:"options,omitempty"`
	Help    string   `json:"help,omitempty"`
}

// BlockInstance is one node in the composed email — what the
// editor's drag-drop canvas holds.
type BlockInstance struct {
	BlockID string         `json:"block_id"`
	Config  map[string]any `json:"config"`
}

type ResolvedProduct struct {
	Title      string `json:"title"`
	ImageURL   string `json:"image_url,omitempty"`
	URL        string `json:"url,omitempty"`
	PriceCents int    `json:"price_cents"`
	Currency   string `json:"currency"`
}

type ProductFeedResolveOptions struct {
	SubscriberEmail   string
	MaxItems          int
	ExcludeOutOfStock *bool
}

type ProductFeedResolver interface {
	ResolveProductFeed(context.Context, string, string, string, ProductFeedResolveOptions) ([]ResolvedProduct, error)
}

type ResolvedCoupon struct {
	Code         string     `json:"code"`
	PoolID       string     `json:"pool_id"`
	AssignmentID string     `json:"assignment_id"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
}

type CouponResolveOptions struct {
	SubscriberID          string
	SubscriberEmail       string
	ContextKey            string
	RenderKey             string
	Channel               string
	Surface               string
	ReservationTTLSeconds int
}

type CouponResolver interface {
	AssignCoupon(context.Context, string, string, CouponResolveOptions) (*ResolvedCoupon, error)
}

// Catalog is the registered set, returned by /catalog.
type Catalog struct {
	Brand  BrandDefaults `json:"brand"`
	Blocks []Block       `json:"blocks"`
}

// BrandDefaults is the tenant's brand settings the editor surfaces
// once at the top of the right-side panel.
type BrandDefaults struct {
	PrimaryColor    string `json:"primary_color"`
	BodyFont        string `json:"body_font"`
	HeadingFont     string `json:"heading_font"`
	BackgroundColor string `json:"background_color"`
}

// ComposeRequest is the POST /compose body.
type ComposeRequest struct {
	Brand  BrandDefaults   `json:"brand"`
	Blocks []BlockInstance `json:"blocks"`
	// SubscriberEmail lets send-time compose resolve behavioral commerce
	// feeds against the recipient being rendered.
	SubscriberEmail string `json:"subscriber_email,omitempty"`
	// Subject is included in the wrapper so a single compose call
	// returns everything the editor needs to preview.
	Subject string `json:"subject,omitempty"`
}

// ComposeResponse is the rendered MJML.
type ComposeResponse struct {
	MJML     string   `json:"mjml"`
	Warnings []string `json:"warnings,omitempty"`
}

// Deps wires the catalog + compose handlers.
type Deps struct {
	ProductResolver ProductFeedResolver
	CouponResolver  CouponResolver
	Logger          *slog.Logger
}

// MountRoutes registers GET /catalog + POST /compose. Both run
// without DB access — the block catalog is in-memory, and compose
// is a pure-function MJML emitter.
func MountRoutes(r chi.Router, d *Deps) {
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/email-blocks/catalog", d.Catalog)
	r.With(write).Post("/api/v1/email-blocks/compose", d.Compose)
}

// Catalog GET /api/v1/email-blocks/catalog — returns the V1 block
// set + the tenant's brand defaults (placeholder values; the editor
// loads real brand settings from workspace_settings).
func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, Catalog{
		Brand: BrandDefaults{
			PrimaryColor:    "#1d4ed8",
			BackgroundColor: "#ffffff",
			BodyFont:        "Helvetica, Arial, sans-serif",
			HeadingFont:     "Helvetica, Arial, sans-serif",
		},
		Blocks: catalogBlocks(),
	})
}

// Compose POST /api/v1/email-blocks/compose — turns the block
// instance list into a full MJML document.
func (d *Deps) Compose(w http.ResponseWriter, r *http.Request) {
	var in ComposeRequest
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	resolveWarnings := []string{}
	if d.ProductResolver != nil || d.CouponResolver != nil {
		tenantID := ""
		if t, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = t.ID
		}
		if d.ProductResolver != nil {
			warnings, err := d.resolveProductBlocks(r.Context(), tenantID, &in)
			if err != nil {
				httperror.WriteInternal(w, d.Logger, err, r.Context())
				return
			}
			resolveWarnings = append(resolveWarnings, warnings...)
		}
		if d.CouponResolver != nil {
			warnings, err := d.resolveCouponBlocks(r.Context(), tenantID, &in)
			if err != nil {
				httperror.WriteInternal(w, d.Logger, err, r.Context())
				return
			}
			resolveWarnings = append(resolveWarnings, warnings...)
		}
	}
	mjml, warnings, err := Render(in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	warnings = append(resolveWarnings, warnings...)
	writeJSON(w, http.StatusOK, ComposeResponse{MJML: mjml, Warnings: warnings})
}

func (d *Deps) resolveProductBlocks(ctx context.Context, tenantID string, req *ComposeRequest) ([]string, error) {
	warnings := []string{}
	if tenantID == "" {
		return []string{"commerce product feeds skipped: tenant context unavailable"}, nil
	}
	for i := range req.Blocks {
		if req.Blocks[i].BlockID != "product_recommendations" {
			continue
		}
		cfg := req.Blocks[i].Config
		if cfg == nil {
			cfg = map[string]any{}
		}
		feedID := strings.TrimSpace(configString(cfg, "feed_id"))
		if feedID == "" {
			continue
		}
		maxItems := configInt(cfg, "max_items", 3)
		if maxItems <= 0 || maxItems > 3 {
			maxItems = 3
		}
		var exclude *bool
		if v, ok := configBool(cfg, "exclude_out_of_stock"); ok {
			exclude = &v
		}
		subscriberEmail := strings.TrimSpace(configString(cfg, "subscriber_email"))
		if subscriberEmail == "" {
			subscriberEmail = strings.TrimSpace(req.SubscriberEmail)
		}
		products, err := d.ProductResolver.ResolveProductFeed(ctx, tenantID, configString(cfg, "catalog_id"), feedID, ProductFeedResolveOptions{
			SubscriberEmail:   subscriberEmail,
			MaxItems:          maxItems,
			ExcludeOutOfStock: exclude,
		})
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("block %d: product feed %q could not be resolved", i, feedID))
			continue
		}
		if len(products) == 0 {
			warnings = append(warnings, fmt.Sprintf("block %d: product feed %q returned no products", i, feedID))
			continue
		}
		for n, product := range products {
			if n >= 3 {
				break
			}
			slot := fmt.Sprintf("product_%d_", n+1)
			cfg[slot+"title"] = product.Title
			cfg[slot+"image"] = product.ImageURL
			cfg[slot+"url"] = product.URL
			cfg[slot+"price"] = formatPrice(product.PriceCents, product.Currency)
		}
		req.Blocks[i].Config = cfg
	}
	return warnings, nil
}

func (d *Deps) resolveCouponBlocks(ctx context.Context, tenantID string, req *ComposeRequest) ([]string, error) {
	warnings := []string{}
	if tenantID == "" {
		return []string{"coupon pools skipped: tenant context unavailable"}, nil
	}
	for i := range req.Blocks {
		if req.Blocks[i].BlockID != "discount_code" {
			continue
		}
		cfg := req.Blocks[i].Config
		if cfg == nil {
			cfg = map[string]any{}
		}
		poolID := strings.TrimSpace(firstConfigString(cfg, "coupon_pool_id", "pool_id"))
		if poolID == "" {
			continue
		}
		subscriberEmail := strings.TrimSpace(configString(cfg, "subscriber_email"))
		if subscriberEmail == "" {
			subscriberEmail = strings.TrimSpace(req.SubscriberEmail)
		}
		subscriberID := strings.TrimSpace(configString(cfg, "subscriber_id"))
		if subscriberID == "" && subscriberEmail == "" {
			warnings = append(warnings, fmt.Sprintf("block %d: coupon pool %q skipped without subscriber", i, poolID))
			continue
		}
		contextKey := strings.TrimSpace(configString(cfg, "context_key"))
		if contextKey == "" {
			contextKey = "email_block:" + poolID
		}
		coupon, err := d.CouponResolver.AssignCoupon(ctx, tenantID, poolID, CouponResolveOptions{
			SubscriberID:          subscriberID,
			SubscriberEmail:       subscriberEmail,
			ContextKey:            contextKey,
			RenderKey:             strings.TrimSpace(configString(cfg, "render_key")),
			Channel:               firstNonEmpty(strings.TrimSpace(configString(cfg, "channel")), "email"),
			Surface:               firstNonEmpty(strings.TrimSpace(configString(cfg, "surface")), "email_block"),
			ReservationTTLSeconds: configInt(cfg, "reservation_ttl_seconds", 0),
		})
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("block %d: coupon pool %q could not assign a code", i, poolID))
			continue
		}
		cfg["code"] = coupon.Code
		cfg["coupon_assignment_id"] = coupon.AssignmentID
		if coupon.ExpiresAt != nil {
			cfg["coupon_expires_at"] = coupon.ExpiresAt.UTC().Format(time.RFC3339)
		}
		req.Blocks[i].Config = cfg
	}
	return warnings, nil
}

// Render assembles the block instances into MJML. Errors only on
// genuinely malformed input (unknown block_id). Missing config
// values fall back to the block's Defaults.
func Render(req ComposeRequest) (string, []string, error) {
	var b strings.Builder
	warnings := []string{}
	brand := req.Brand
	if brand.PrimaryColor == "" {
		brand.PrimaryColor = "#1d4ed8"
	}
	if brand.BodyFont == "" {
		brand.BodyFont = "Helvetica, Arial, sans-serif"
	}
	if brand.HeadingFont == "" {
		brand.HeadingFont = brand.BodyFont
	}
	if brand.BackgroundColor == "" {
		brand.BackgroundColor = "#ffffff"
	}

	b.WriteString(`<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="` + brand.BodyFont + `" />
      <mj-text font-size="14px" line-height="1.5" color="#1f2937" />
      <mj-button background-color="` + brand.PrimaryColor + `" border-radius="4px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="` + brand.BackgroundColor + `">
`)
	byID := map[string]Block{}
	for _, blk := range V1Blocks {
		byID[blk.ID] = blk
	}
	for i, inst := range req.Blocks {
		blk, ok := byID[inst.BlockID]
		if !ok {
			warnings = append(warnings, fmt.Sprintf("block %d: unknown id %q (skipped)", i, inst.BlockID))
			continue
		}
		cfg := mergeConfig(blk.Defaults, inst.Config)
		b.WriteString(renderBlock(blk.ID, cfg, brand))
		b.WriteString("\n")
	}
	b.WriteString("  </mj-body>\n</mjml>\n")
	return b.String(), warnings, nil
}

// mergeConfig overlays the instance config on top of the block's
// defaults so partial configs still produce valid MJML.
func mergeConfig(defaults, override map[string]any) map[string]any {
	out := make(map[string]any, len(defaults)+len(override))
	for k, v := range defaults {
		out[k] = v
	}
	for k, v := range override {
		out[k] = v
	}
	return out
}

func configString(cfg map[string]any, key string) string {
	if v, ok := cfg[key]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

func firstConfigString(cfg map[string]any, keys ...string) string {
	for _, key := range keys {
		if v := configString(cfg, key); v != "" {
			return v
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func configInt(cfg map[string]any, key string, fallback int) int {
	if v, ok := cfg[key]; ok && v != nil {
		switch n := v.(type) {
		case int:
			return n
		case int64:
			return int(n)
		case float64:
			return int(n)
		case json.Number:
			if parsed, err := n.Int64(); err == nil {
				return int(parsed)
			}
		default:
			raw := strings.TrimSpace(fmt.Sprint(v))
			if raw != "" {
				var parsed int
				if _, err := fmt.Sscanf(raw, "%d", &parsed); err == nil {
					return parsed
				}
			}
		}
	}
	return fallback
}

func configBool(cfg map[string]any, key string) (bool, bool) {
	v, ok := cfg[key]
	if !ok || v == nil {
		return false, false
	}
	switch b := v.(type) {
	case bool:
		return b, true
	case string:
		switch strings.ToLower(strings.TrimSpace(b)) {
		case "1", "true", "yes":
			return true, true
		case "0", "false", "no":
			return false, true
		}
	}
	return false, false
}

func formatPrice(cents int, currency string) string {
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if currency == "" {
		currency = "USD"
	}
	return fmt.Sprintf("%s %.2f", currency, float64(cents)/100)
}

// renderBlock emits the MJML for a single block. Each block is a
// hand-written template; we don't go through a generic Go-template
// engine because MJML has too many specific attributes per
// component.
func renderBlock(blockID string, cfg map[string]any, brand BrandDefaults) string {
	str := func(k, fallback string) string {
		if v, ok := cfg[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
			if v != nil {
				return fmt.Sprint(v)
			}
		}
		return fallback
	}
	strs := func(k string, fallback []string) []string {
		switch v := cfg[k].(type) {
		case []string:
			if len(v) > 0 {
				return v
			}
		case []any:
			out := make([]string, 0, len(v))
			for _, item := range v {
				if s := strings.TrimSpace(fmt.Sprint(item)); s != "" {
					out = append(out, s)
				}
			}
			if len(out) > 0 {
				return out
			}
		case string:
			if strings.TrimSpace(v) != "" {
				return strings.Split(v, ",")
			}
		}
		return fallback
	}
	switch blockID {
	case "header_logo":
		return fmt.Sprintf(`    <mj-section background-color="%s" padding="20px 0">
      <mj-column>
        <mj-image src="%s" alt="%s" width="160px" align="center" />
      </mj-column>
    </mj-section>`,
			str("background_color", brand.PrimaryColor),
			str("logo_url", "https://via.placeholder.com/160x40?text=Logo"),
			str("alt", "Brand logo"))
	case "hero_text":
		return fmt.Sprintf(`    <mj-section padding="40px 20px 20px">
      <mj-column>
        <mj-text font-size="28px" font-weight="bold" align="center" font-family="%s">%s</mj-text>
        <mj-text font-size="16px" align="center" color="#4b5563">%s</mj-text>
      </mj-column>
    </mj-section>`, brand.HeadingFont,
			str("headline", "Welcome to our newsletter"),
			str("subhead", "We're glad to have you here."))
	case "hero_image":
		return fmt.Sprintf(`    <mj-section padding="0">
      <mj-column>
        <mj-image src="%s" alt="%s" width="600px" />
      </mj-column>
    </mj-section>`,
			str("image_url", "https://via.placeholder.com/600x300"),
			str("alt", "Hero image"))
	case "text":
		return fmt.Sprintf(`    <mj-section padding="0 20px">
      <mj-column>
        <mj-text>%s</mj-text>
      </mj-column>
    </mj-section>`, str("text", "Type your paragraph here. Use {{ first_name }} for personalization."))
	case "button":
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column>
        <mj-button href="%s" background-color="%s">%s</mj-button>
      </mj-column>
    </mj-section>`,
			str("url", "https://example.com"),
			str("background_color", brand.PrimaryColor),
			str("label", "Read more"))
	case "two_column":
		imageFirst := false
		if v, ok := cfg["image_first"].(bool); ok {
			imageFirst = v
		}
		text := str("text", "Type your paragraph here.")
		image := str("image_url", "https://via.placeholder.com/280x200")
		first := fmt.Sprintf(`      <mj-column><mj-text>%s</mj-text></mj-column>`, text)
		second := fmt.Sprintf(`      <mj-column><mj-image src="%s" width="280px" /></mj-column>`, image)
		if imageFirst {
			first, second = second, first
		}
		return fmt.Sprintf(`    <mj-section padding="20px">
%s
%s
    </mj-section>`, first, second)
	case "image_and_caption":
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column>
        <mj-image src="%s" alt="%s" width="600px" />
        <mj-text align="center" font-size="12px" color="#6b7280">%s</mj-text>
      </mj-column>
    </mj-section>`,
			str("image_url", "https://via.placeholder.com/600x300"),
			str("alt", "Image"),
			str("caption", "Caption text"))
	case "product_recommendations":
		title := str("title", "Recommended for you")
		productColumn := func(n int, imageFallback, titleFallback string) string {
			prefix := fmt.Sprintf("product_%d_", n)
			price := strings.TrimSpace(str(prefix+"price", ""))
			priceLine := ""
			if price != "" {
				priceLine = fmt.Sprintf(`
        <mj-text color="#6b7280" font-size="13px">%s</mj-text>`, price)
			}
			return fmt.Sprintf(`      <mj-column>
        <mj-image src="%s" alt="%s" />
        <mj-text font-weight="bold">%s</mj-text>%s
        <mj-button href="%s">%s</mj-button>
      </mj-column>`,
				str(prefix+"image", imageFallback), str(prefix+"title", titleFallback),
				str(prefix+"title", titleFallback), priceLine,
				str(prefix+"url", "https://example.com"), str("button_label", "Shop now"))
		}
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold" align="center">%s</mj-text>
      </mj-column>
    </mj-section>
    <mj-section padding="0 20px 20px">
%s
%s
%s
    </mj-section>`,
			title,
			productColumn(1, "https://via.placeholder.com/180x140?text=Product+1", "Product 1"),
			productColumn(2, "https://via.placeholder.com/180x140?text=Product+2", "Product 2"),
			productColumn(3, "https://via.placeholder.com/180x140?text=Product+3", "Product 3"))
	case "discount_code":
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column background-color="#f9fafb" border="1px solid #e5e7eb" padding="20px">
        <mj-text align="center" font-size="14px" color="#6b7280">%s</mj-text>
        <mj-text align="center" font-size="28px" font-weight="bold" letter-spacing="2px">%s</mj-text>
        <mj-button href="%s" background-color="%s">%s</mj-button>
      </mj-column>
    </mj-section>`,
			str("description", "Use this code at checkout."),
			str("code", "SAVE10"),
			str("url", "https://example.com"),
			str("background_color", brand.PrimaryColor),
			str("label", "Redeem offer"))
	case "survey":
		choices := strs("choices", []string{"Great", "Okay", "Not for me"})
		var choiceButtons strings.Builder
		for _, choice := range choices {
			c := strings.TrimSpace(choice)
			if c == "" {
				continue
			}
			choiceButtons.WriteString(fmt.Sprintf(`        <mj-button href="%s">%s</mj-button>
`, str("url", "https://example.com/survey"), c))
		}
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column>
        <mj-text font-size="18px" font-weight="bold" align="center">%s</mj-text>
%s      </mj-column>
    </mj-section>`, str("question", "What did you think?"), choiceButtons.String())
	case "social_follow":
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column>
        <mj-text align="center">
          <a href="%s">Facebook</a> &nbsp; <a href="%s">Instagram</a> &nbsp; <a href="%s">LinkedIn</a> &nbsp; <a href="%s">X</a>
        </mj-text>
      </mj-column>
    </mj-section>`,
			str("facebook_url", "#"), str("instagram_url", "#"), str("linkedin_url", "#"), str("x_url", "#"))
	case "social_share":
		shareURL := str("share_url", "{{ archive_url }}")
		text := str("text", "Share this")
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column>
        <mj-text align="center">%s: <a href="https://www.facebook.com/sharer/sharer.php?u=%s">Facebook</a> · <a href="https://www.linkedin.com/sharing/share-offsite/?url=%s">LinkedIn</a> · <a href="https://twitter.com/intent/tweet?url=%s">X</a></mj-text>
      </mj-column>
    </mj-section>`, text, shareURL, shareURL, shareURL)
	case "rss":
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column>
        <mj-text font-size="18px" font-weight="bold">%s</mj-text>
        <mj-text>{{#rss feed_url="%s" count="%s"}}{{ title }} — {{ url }}{{/rss}}</mj-text>
      </mj-column>
    </mj-section>`,
			str("title", "Latest posts"), str("feed_url", "https://example.com/feed.xml"), str("count", "3"))
	case "video":
		videoURL := str("video_url", "https://example.com/video")
		thumb := str("thumbnail_url", "https://via.placeholder.com/600x338?text=Video")
		title := str("title", "Watch video")
		return fmt.Sprintf(`    <mj-section padding="20px">
      <mj-column>
        <mj-image src="%s" href="%s" alt="%s" width="600px" />
        <mj-button href="%s" background-color="%s">%s</mj-button>
      </mj-column>
    </mj-section>`, thumb, videoURL, title, videoURL, brand.PrimaryColor, str("label", "Watch now"))
	case "dynamic_content":
		return fmt.Sprintf(`    {{#if %s}}
    <mj-section padding="20px"><mj-column><mj-text>%s</mj-text></mj-column></mj-section>
    {{else}}
    <mj-section padding="20px"><mj-column><mj-text>%s</mj-text></mj-column></mj-section>
    {{/if}}`, str("condition", "is_vip"), str("content", "VIP offer"), str("fallback", "General offer"))
	case "conditional_content":
		return fmt.Sprintf(`    *|IF:%s|*
    <mj-section padding="20px"><mj-column><mj-text>%s</mj-text></mj-column></mj-section>
    *|ELSE:|*
    <mj-section padding="20px"><mj-column><mj-text>%s</mj-text></mj-column></mj-section>
    *|END:IF|*`, str("condition", "FNAME"), str("content", "Hello *|FNAME|*"), str("fallback", "Hello"))
	case "divider":
		return `    <mj-section padding="0 20px">
      <mj-column>
        <mj-divider border-color="#e5e7eb" border-width="1px" />
      </mj-column>
    </mj-section>`
	case "spacer":
		height := str("height", "20px")
		return fmt.Sprintf(`    <mj-section><mj-column><mj-spacer height="%s" /></mj-column></mj-section>`, height)
	case "footer":
		return fmt.Sprintf(`    <mj-section background-color="#f9fafb" padding="20px">
      <mj-column>
        <mj-text align="center" font-size="12px" color="#6b7280">%s</mj-text>
        <mj-text align="center" font-size="12px" color="#6b7280">
          <a href="{{ unsubscribe_url }}" style="color:#6b7280">Unsubscribe</a>
        </mj-text>
      </mj-column>
    </mj-section>`, str("company_address", "Your Company · 123 Main St · City, ST 12345"))
	}
	return ""
}

// V1Blocks is the registered catalog. Order here drives the
// editor's sidebar order.
var V1Blocks = []Block{
	{
		ID:          "header_logo",
		Name:        "Header — logo",
		Category:    "header",
		Description: "Brand-color band with centered logo.",
		Fields: []FieldSpec{
			{Key: "logo_url", Label: "Logo URL", Type: "image_url"},
			{Key: "alt", Label: "Alt text", Type: "text"},
			{Key: "background_color", Label: "Background color", Type: "color"},
		},
		Defaults: map[string]any{
			"logo_url": "https://via.placeholder.com/160x40?text=Logo",
			"alt":      "Brand logo",
		},
	},
	{
		ID:          "hero_text",
		Name:        "Hero — text",
		Category:    "hero",
		Description: "Large headline + supporting subhead.",
		Fields: []FieldSpec{
			{Key: "headline", Label: "Headline", Type: "text"},
			{Key: "subhead", Label: "Subhead", Type: "text"},
		},
		Defaults: map[string]any{
			"headline": "Welcome to our newsletter",
			"subhead":  "We're glad to have you here.",
		},
	},
	{
		ID:          "hero_image",
		Name:        "Hero — image",
		Category:    "hero",
		Description: "Full-width banner image.",
		Fields: []FieldSpec{
			{Key: "image_url", Label: "Image URL", Type: "image_url"},
			{Key: "alt", Label: "Alt text", Type: "text"},
		},
		Defaults: map[string]any{
			"image_url": "https://via.placeholder.com/600x300",
			"alt":       "Hero image",
		},
	},
	{
		ID:          "text",
		Name:        "Text",
		Category:    "content",
		Description: "Paragraph with merge-field support.",
		Fields: []FieldSpec{
			{Key: "text", Label: "Body text", Type: "textarea",
				Help: "Supports {{ first_name }}-style merge fields."},
		},
		Defaults: map[string]any{
			"text": "Type your paragraph here. Use {{ first_name }} for personalization.",
		},
	},
	{
		ID:          "button",
		Name:        "Button (CTA)",
		Category:    "content",
		Description: "Single call-to-action with link.",
		Fields: []FieldSpec{
			{Key: "label", Label: "Button label", Type: "text"},
			{Key: "url", Label: "Link URL", Type: "url"},
			{Key: "background_color", Label: "Background color", Type: "color"},
		},
		Defaults: map[string]any{
			"label": "Read more",
			"url":   "https://example.com",
		},
	},
	{
		ID:          "two_column",
		Name:        "Two-column (text + image)",
		Category:    "content",
		Description: "Text on one side, image on the other.",
		Fields: []FieldSpec{
			{Key: "text", Label: "Text", Type: "textarea"},
			{Key: "image_url", Label: "Image URL", Type: "image_url"},
			{Key: "image_first", Label: "Image on the left", Type: "bool"},
		},
		Defaults: map[string]any{
			"text":      "Type your paragraph here.",
			"image_url": "https://via.placeholder.com/280x200",
		},
	},
	{
		ID:          "image_and_caption",
		Name:        "Image with caption",
		Category:    "content",
		Description: "Full-width image with centered caption beneath.",
		Fields: []FieldSpec{
			{Key: "image_url", Label: "Image URL", Type: "image_url"},
			{Key: "alt", Label: "Alt text", Type: "text"},
			{Key: "caption", Label: "Caption", Type: "text"},
		},
	},
	{
		ID:          "product_recommendations",
		Name:        "Product recommendations",
		Category:    "commerce",
		Description: "Three-product recommendation grid for ecommerce campaigns.",
		Fields: []FieldSpec{
			{Key: "title", Label: "Section title", Type: "text"},
			{Key: "catalog_id", Label: "Catalog ID", Type: "text"},
			{Key: "feed_id", Label: "Product feed ID", Type: "text"},
			{Key: "max_items", Label: "Max products", Type: "number"},
			{Key: "exclude_out_of_stock", Label: "Exclude out-of-stock", Type: "bool"},
			{Key: "product_1_title", Label: "Product 1 title", Type: "text"},
			{Key: "product_1_image", Label: "Product 1 image", Type: "image_url"},
			{Key: "product_1_url", Label: "Product 1 URL", Type: "url"},
			{Key: "product_1_price", Label: "Product 1 price", Type: "text"},
			{Key: "product_2_title", Label: "Product 2 title", Type: "text"},
			{Key: "product_2_image", Label: "Product 2 image", Type: "image_url"},
			{Key: "product_2_url", Label: "Product 2 URL", Type: "url"},
			{Key: "product_2_price", Label: "Product 2 price", Type: "text"},
			{Key: "product_3_title", Label: "Product 3 title", Type: "text"},
			{Key: "product_3_image", Label: "Product 3 image", Type: "image_url"},
			{Key: "product_3_url", Label: "Product 3 URL", Type: "url"},
			{Key: "product_3_price", Label: "Product 3 price", Type: "text"},
			{Key: "button_label", Label: "Button label", Type: "text"},
		},
		Defaults: map[string]any{"title": "Recommended for you", "button_label": "Shop now", "max_items": 3, "exclude_out_of_stock": true},
	},
	{
		ID:          "discount_code",
		Name:        "Discount code",
		Category:    "commerce",
		Description: "Promo-code callout with checkout CTA.",
		Fields: []FieldSpec{
			{Key: "description", Label: "Description", Type: "text"},
			{Key: "code", Label: "Code", Type: "text"},
			{Key: "url", Label: "Offer URL", Type: "url"},
			{Key: "label", Label: "Button label", Type: "text"},
			{Key: "background_color", Label: "Button color", Type: "color"},
		},
		Defaults: map[string]any{"description": "Use this code at checkout.", "code": "SAVE10", "label": "Redeem offer"},
	},
	{
		ID:          "survey",
		Name:        "Survey / poll",
		Category:    "engagement",
		Description: "Hosted survey prompt or quick email poll choices.",
		Fields: []FieldSpec{
			{Key: "question", Label: "Question", Type: "text"},
			{Key: "choices", Label: "Choices", Type: "textarea", Help: "Comma-separated choices are supported."},
			{Key: "url", Label: "Survey URL", Type: "url"},
		},
		Defaults: map[string]any{"question": "What did you think?", "choices": []string{"Great", "Okay", "Not for me"}},
	},
	{
		ID:          "social_follow",
		Name:        "Social follow",
		Category:    "social",
		Description: "Follow links for common social networks.",
		Fields: []FieldSpec{
			{Key: "facebook_url", Label: "Facebook URL", Type: "url"},
			{Key: "instagram_url", Label: "Instagram URL", Type: "url"},
			{Key: "linkedin_url", Label: "LinkedIn URL", Type: "url"},
			{Key: "x_url", Label: "X URL", Type: "url"},
		},
	},
	{
		ID:          "social_share",
		Name:        "Social share",
		Category:    "social",
		Description: "Campaign sharing links for social networks.",
		Fields: []FieldSpec{
			{Key: "text", Label: "Prompt", Type: "text"},
			{Key: "share_url", Label: "Share URL", Type: "url"},
		},
		Defaults: map[string]any{"text": "Share this", "share_url": "{{ archive_url }}"},
	},
	{
		ID:          "rss",
		Name:        "RSS",
		Category:    "dynamic",
		Description: "RSS feed placeholder for recurring newsletter content.",
		Fields: []FieldSpec{
			{Key: "title", Label: "Title", Type: "text"},
			{Key: "feed_url", Label: "Feed URL", Type: "url"},
			{Key: "count", Label: "Item count", Type: "number"},
		},
		Defaults: map[string]any{"title": "Latest posts", "feed_url": "https://example.com/feed.xml", "count": 3},
	},
	{
		ID:          "video",
		Name:        "Video",
		Category:    "media",
		Description: "Email-friendly linked thumbnail for embedded videos.",
		Fields: []FieldSpec{
			{Key: "video_url", Label: "Video URL", Type: "url"},
			{Key: "thumbnail_url", Label: "Thumbnail URL", Type: "image_url"},
			{Key: "title", Label: "Title / alt text", Type: "text"},
			{Key: "label", Label: "Button label", Type: "text"},
		},
		Defaults: map[string]any{"title": "Watch video", "label": "Watch now"},
	},
	{
		ID:          "dynamic_content",
		Name:        "Dynamic content",
		Category:    "dynamic",
		Description: "Conditional content for merge-data backed personalization.",
		Fields: []FieldSpec{
			{Key: "condition", Label: "Condition", Type: "text"},
			{Key: "content", Label: "Content", Type: "textarea"},
			{Key: "fallback", Label: "Fallback", Type: "textarea"},
		},
		Defaults: map[string]any{"condition": "is_vip", "content": "VIP offer", "fallback": "General offer"},
	},
	{
		ID:          "conditional_content",
		Name:        "Mailchimp conditional content",
		Category:    "dynamic",
		Description: "Mailchimp-template conditional block using *|IF:...|* syntax.",
		Fields: []FieldSpec{
			{Key: "condition", Label: "Condition", Type: "text"},
			{Key: "content", Label: "Content", Type: "textarea"},
			{Key: "fallback", Label: "Fallback", Type: "textarea"},
		},
		Defaults: map[string]any{"condition": "FNAME", "content": "Hello *|FNAME|*", "fallback": "Hello"},
	},
	{
		ID:          "divider",
		Name:        "Divider",
		Category:    "structure",
		Description: "Thin horizontal line.",
	},
	{
		ID:          "spacer",
		Name:        "Spacer",
		Category:    "structure",
		Description: "Vertical whitespace.",
		Fields: []FieldSpec{
			{Key: "height", Label: "Height (e.g. 20px)", Type: "text"},
		},
		Defaults: map[string]any{"height": "20px"},
	},
	{
		ID:          "footer",
		Name:        "Footer",
		Category:    "footer",
		Description: "Company address + unsubscribe link. Includes the {{ unsubscribe_url }} merge token automatically.",
		Fields: []FieldSpec{
			{Key: "company_address", Label: "Company address", Type: "textarea"},
		},
		Defaults: map[string]any{
			"company_address": "Your Company · 123 Main St · City, ST 12345",
		},
	},
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// catalogBlocks is V1Blocks as the catalog response promises it: every block
// carries a `fields` array and a `defaults` object. A block with nothing to
// configure (divider) declares neither, and a nil slice or map marshals to
// JSON null — which the editor clients reject as a malformed catalog
// ("blocks[16].fields must be an array").
func catalogBlocks() []Block {
	out := make([]Block, len(V1Blocks))
	for i, blk := range V1Blocks {
		if blk.Fields == nil {
			blk.Fields = []FieldSpec{}
		}
		if blk.Defaults == nil {
			blk.Defaults = map[string]any{}
		}
		out[i] = blk
	}
	return out
}

// keep strings imported for the join helpers used in renderBlock.
var _ = strings.Builder{}
