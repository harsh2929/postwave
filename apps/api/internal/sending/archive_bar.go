// Package sending — archive-bar render hook.
//
// This file wires the `archive_bar` package (gap feature
// `archive-mailchimpv3-archive-bar`) into the send-loop body cache so
// the `{{ archive_bar }}`, `{{ view_in_browser_url }}`, and
// `{{ archive_url }}` tokens get substituted once per campaign per
// batch — NOT per recipient (the tokens are campaign-scoped, not
// subscriber-scoped). The actual call site in the drain loop reads the
// pre-rendered body out of the campaignBody cache.
//
// Surface contract for callers:
//
//	g.ArchiveBar = &ArchiveBarRenderer{Repo: archive_bar.Repo{Pool: pool}, PublicBaseURL: "https://archive.moosewave.com"}
//
// Nil-safe: leaving g.ArchiveBar nil keeps the legacy behaviour
// (tokens stay in-body as literal text, which downstream readers will
// just see — matching the pre-feature behaviour).

package sending

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/archive_bar"
)

// ArchiveBarRenderer is the optional dependency the Guard consults at
// body-load time to substitute the archive-bar tokens in campaign
// bodies. Wiring happens in main.go alongside the other deliverability
// builders (ListUnsubscribe, TrackingFilter).
type ArchiveBarRenderer struct {
	// Repo is the tenant_public_settings reader. Required for default
	// resolution; a nil Repo collapses Render() to a no-op (tokens are
	// left in-body so a misconfigured wiring degrades visibly rather
	// than silently emitting the bar with bad defaults).
	Repo *archive_bar.Repo
	// PublicBaseURL is the scheme+host the archive surface is served
	// from. Required; empty disables the bar (tokens replaced with
	// empty string so the body doesn't carry dead chrome).
	PublicBaseURL string
}

// RenderForCampaign substitutes the archive-bar tokens in body using
// the supplied per-campaign metadata. Returns body unchanged on any
// soft error — the send loop must NEVER block on a render failure (the
// recipient still expects to receive their email; a missing archive
// bar is preferable to a stuck queue).
//
// Token resolution path:
//
//  1. Load tenant defaults from tenant_public_settings (one row).
//  2. Read per-campaign overrides from deliverySettings jsonb.
//  3. Compose the RenderInputs and call archive_bar.Render.
func (r *ArchiveBarRenderer) RenderForCampaign(
	ctx context.Context,
	tenantID, body, archiveSlug string,
	archivePublic bool,
	deliverySettingsRaw []byte,
) string {
	if r == nil || r.Repo == nil {
		return body
	}
	// Fast path: body carries no tokens → no work to do. Saves a DB
	// SELECT per campaign for the (common) case where the operator
	// chose a stripped-down template.
	if !archive_bar.HasArchiveBarToken(body) {
		return body
	}
	defaults, err := r.Repo.LoadDefaults(ctx, tenantID)
	if err != nil {
		// Soft fail — see commentary above. The body retains the
		// literal tokens (visible-in-text) rather than the bar HTML,
		// which is the conservative degradation.
		return body
	}
	var deliverySettings map[string]any
	if len(deliverySettingsRaw) > 0 {
		_ = json.Unmarshal(deliverySettingsRaw, &deliverySettings)
	}
	archiveBarOverride, viewInBrowserOverride := archive_bar.ResolveCampaignOverrides(deliverySettings)
	return archive_bar.Render(body, archive_bar.RenderInputs{
		Defaults:                      defaults,
		CampaignArchiveBarOverride:    archiveBarOverride,
		CampaignViewInBrowserOverride: viewInBrowserOverride,
		PublicBaseURL:                 strings.TrimSpace(r.PublicBaseURL),
		CampaignArchiveSlug:           archiveSlug,
		CampaignPublic:                archivePublic,
	})
}
