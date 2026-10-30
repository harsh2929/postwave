// SPDX-License-Identifier: AGPL-3.0-only
//
// rewriter.go — URL rewriting helpers for vanity click + open-pixel
// hosts. The sending pipeline calls Rewrite() during MJML/HTML
// rendering: every <a href> gets click-tracked through the tenant's
// PurposeLinks domain (or the platform default), and every email gets
// a 1x1 open pixel pointing at the tenant's PurposeTracking domain
// (or platform default).

package custom_domains

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// HostResolver looks up the tenant's verified custom domain for a
// given purpose. Returns "" when no verified domain exists, signaling
// the caller to fall back to the platform default host.
//
// The lookup runs once per send (cached at the per-campaign level),
// not once per link — so a small Postgres roundtrip is fine.
type HostResolver struct {
	Pool *db.Pool
	// PlatformLinkHost is the default click-tracking host (e.g.
	// "track.moosewave.com") used when the tenant hasn't configured
	// a PurposeLinks domain.
	PlatformLinkHost string
	// PlatformPixelHost is the default open-pixel host (e.g.
	// "pixel.moosewave.com").
	PlatformPixelHost string
}

// VerifiedHost returns the tenant's verified domain for a given
// purpose, or "" when none exists.
func (r *HostResolver) VerifiedHost(ctx context.Context, tenantID string, p Purpose) (string, error) {
	if r == nil || r.Pool == nil {
		return "", errors.New("host resolver: nil pool")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var domain string
	row := tx.QueryRow(ctx, `
SELECT domain FROM custom_domains
 WHERE tenant_id = $1::uuid AND purpose = $2 AND verified = true
 LIMIT 1`, tenantID, string(p))
	if err := row.Scan(&domain); err != nil {
		// pgx.ErrNoRows ↔ no verified domain; treated as "use default".
		return "", nil
	}
	return domain, nil
}

// LinkHost returns the host to use for click-tracking. Falls back to
// PlatformLinkHost when the tenant has no verified `links` domain.
func (r *HostResolver) LinkHost(ctx context.Context, tenantID string) string {
	host, _ := r.VerifiedHost(ctx, tenantID, PurposeLinks)
	if host == "" {
		return r.PlatformLinkHost
	}
	return host
}

// PixelHost returns the host for the open pixel. Falls back to
// PlatformPixelHost.
func (r *HostResolver) PixelHost(ctx context.Context, tenantID string) string {
	host, _ := r.VerifiedHost(ctx, tenantID, PurposeTracking)
	if host == "" {
		return r.PlatformPixelHost
	}
	return host
}

// RewriteClick replaces the host of a click-tracking URL with the
// tenant's vanity host. Used during email render: the link rewriter
// produces tracking URLs against the platform default; we then swap
// in the tenant's domain when present.
//
// originalURL: a fully-qualified URL whose host the caller wants
// replaced (e.g. "https://track.moosewave.com/c/abc?u=...").
// trackingHost: the verified host (e.g. "go.acme.com").
//
// Falls back to originalURL on parse failure — the rendered email
// always has working links even if rewriting goes sideways.
func RewriteClick(originalURL, trackingHost string) string {
	if trackingHost == "" || originalURL == "" {
		return originalURL
	}
	u, err := url.Parse(originalURL)
	if err != nil {
		return originalURL
	}
	u.Host = trackingHost
	// Scheme stays as it was (https in production).
	return u.String()
}

// BuildPixelURL composes the absolute URL for the open pixel.
// pixelHost should be a hostname (no scheme); we default to https.
// pixelPath is the platform path (e.g. "/pixel.gif?m=<message-id>").
func BuildPixelURL(pixelHost, pixelPath string) string {
	if pixelHost == "" {
		return ""
	}
	scheme := "https"
	if !strings.HasPrefix(pixelPath, "/") {
		pixelPath = "/" + pixelPath
	}
	return scheme + "://" + pixelHost + pixelPath
}
