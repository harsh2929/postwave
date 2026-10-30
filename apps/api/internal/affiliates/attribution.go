package affiliates

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

// CookieDomain is filled in at runtime by handlers.go from the
// AFFILIATE_COOKIE_DOMAIN env var. Empty string = host-only cookie (useful
// for local dev where the marketing site runs on localhost).
//
// Default in production: ".moosewave.com" so the cookie is shared across
// www.moosewave.com, app.moosewave.com, and any landing-page subdomains.
type CookieConfig struct {
	Domain string
	Secure bool
	// MaxAgeSeconds defaults to CookieMaxAgeSeconds (60 days) when zero.
	MaxAgeSeconds int
}

// NewCookieID generates a 16-byte (32 hex char) cookie id. It is not a
// cryptographic secret — anyone with the cookie value can impersonate the
// click — but high-entropy enough to avoid collision in the conversion-time
// last-touch lookup.
func NewCookieID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// ExtractOrCreateCookie returns the existing pw_ref cookie or generates a
// new id. The second return value is the value that should be set in a
// Set-Cookie header (always non-empty when err == nil).
func ExtractOrCreateCookie(r *http.Request) (id string, fresh bool, err error) {
	if c, err := r.Cookie(CookieName); err == nil && strings.TrimSpace(c.Value) != "" {
		return c.Value, false, nil
	}
	id, err = NewCookieID()
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

// BuildSetCookie returns the http.Cookie to be attached to the response.
func BuildSetCookie(id string, cfg CookieConfig) *http.Cookie {
	maxAge := cfg.MaxAgeSeconds
	if maxAge <= 0 {
		maxAge = CookieMaxAgeSeconds
	}
	return &http.Cookie{
		Name:     CookieName,
		Value:    id,
		Path:     "/",
		Domain:   cfg.Domain,
		MaxAge:   maxAge,
		Expires:  time.Now().Add(time.Duration(maxAge) * time.Second),
		HttpOnly: true,
		Secure:   cfg.Secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// LastTouchAttribute resolves a cookie id to the most recent affiliate that
// owns it within the 60-day window. Returns ErrNotFound when the cookie
// does not match any tracked click.
func (r *Repo) LastTouchAttribute(ctx context.Context, cookieID string) (string, error) {
	return r.lastTouchAffiliateID(ctx, cookieID)
}

// RecordClickFromRequest is the high-level helper called by the public
// /api/public/affiliates/track and /pixel.gif endpoints. It:
//  1. resolves the affiliate by slug (must be approved + active).
//  2. extracts/generates the pw_ref cookie id.
//  3. inserts an affiliate_clicks row capturing UTM + landing.
//  4. attaches the Set-Cookie header to `w`.
//
// Returns the affiliate id (for the caller's redirect logic) or an error.
func RecordClickFromRequest(
	ctx context.Context,
	repo *Repo,
	cfg CookieConfig,
	w http.ResponseWriter,
	r *http.Request,
	slug string,
) (string, error) {
	if !OperationallyAvailable() {
		return "", ErrProgramUnavailable
	}
	a, err := repo.GetAffiliateBySlug(ctx, slug)
	if err != nil {
		return "", err
	}
	// We still record clicks for pending affiliates — once they're
	// approved, attribution should respect any backfill cookies. But
	// terminated/suspended affiliates accrue nothing.
	if a.Status == StatusTerminated || a.Status == StatusSuspended {
		return "", ErrNotFound
	}
	cookieID, _, err := ExtractOrCreateCookie(r)
	if err != nil {
		return "", err
	}
	q := r.URL.Query()
	click := &AffiliateClick{
		AffiliateID: a.ID,
		IP:          clientIPFromRequest(r),
		UserAgent:   r.UserAgent(),
		LandingPage: q.Get("landing"),
		UTMSource:   q.Get("utm_source"),
		UTMMedium:   q.Get("utm_medium"),
		UTMCampaign: q.Get("utm_campaign"),
		UTMContent:  q.Get("utm_content"),
		UTMTerm:     q.Get("utm_term"),
		CookieID:    cookieID,
	}
	if err := repo.RecordClick(ctx, click); err != nil {
		return "", err
	}
	http.SetCookie(w, BuildSetCookie(cookieID, cfg))
	return a.ID, nil
}

func clientIPFromRequest(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if comma := strings.IndexByte(xff, ','); comma > 0 {
			return strings.TrimSpace(xff[:comma])
		}
		return strings.TrimSpace(xff)
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	// Strip :port from RemoteAddr if present.
	if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}
