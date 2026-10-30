// SPDX-License-Identifier: AGPL-3.0-only
//
// Package firewall_attack_mode implements Buttondown-style "attack mode"
// for the public signup endpoints: every submission is scored
// 0..100 against four bot signals, and (when the tenant has opted into
// attack mode) submissions above the threshold are rejected outright.
// A background sweep detects signup-rate surges and can auto-enable
// the kill switch.
//
// # The four signals
//
//   - browser_fp_present (40 weight)
//       Did the embedded form post a fingerprint token (collected by
//       the host-page JS via Canvas/WebGL/AudioContext)? Iframe-based
//       mass-signup bots can't produce one because the cross-origin
//       iframe doesn't have access to the host's fingerprinting JS,
//       and the bot's own browser headlessly stripped these surfaces.
//   - ua_quality        (20 weight)
//       Plausible User-Agent? Empty UA, curl/Go-http-client, or
//       outdated Mozilla versions get penalized.
//   - referer_quality   (20 weight)
//       Did the request carry a Referer? Mass-signup bots fire
//       directly at /api/public/forms/{slug}/submit without one.
//   - rate              (20 weight)
//       How many signups in the last 5 minutes from this IP? 1 is
//       fine, 50 is not.
//
// Score = sum of penalties; signups with score >= threshold are
// rejected when attack_mode_enabled.
//
// # Opt-in fingerprinting
//
// The fingerprint token field is *opt-in* because:
//
//   1. Adding a fingerprint script changes the integration story for
//      tenants with CSP restrictions or strict iframe sandboxing.
//   2. Some tenants serve the form on an inline iframe (third-party
//      partner sites) where they can't drop a host-page script.
//
// Default behavior: browser_fp_present absent contributes 0 to the
// score (no penalty). Tenants who flip `fingerprint_required=true`
// get the 40-point penalty applied to every signup missing a token —
// effectively a kill switch for iframe-mass-signup attacks.
//
// # Surfaces
//
//   GET  /api/v1/firewall/settings           tenant config + last-flip stamps
//   PUT  /api/v1/firewall/settings           operator updates the knobs
//   GET  /api/v1/firewall/events             recent signup events (paginated)
//   GET  /api/v1/firewall/stats              per-action counts last 24h/7d
//   POST /api/v1/firewall/detect             run the surge detector now (admin)
//
// The Score function is exported so the forms package can call it
// from the public submit handler. RecordEvent is exported for the
// same reason; the public path uses
// app.public_form_tenant_id GUC (see the migration's
// public_form_insert RLS policy).

package firewall_attack_mode

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
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

const settingsJSONMaxBodyBytes int64 = 8 << 10 // 8 KiB

// Default scoring knobs. Live as package vars (not consts) so the
// surge detector worker test can override them deterministically.
var (
	defaultThreshold       = 50
	defaultSurgeMultiplier = 5
	defaultSurgeMin        = 50
)

// Signal weights — sum to 100.
const (
	weightFingerprint = 40
	weightUA          = 20
	weightReferer     = 20
	weightRate        = 20
)

// Settings is the per-tenant firewall config.
type Settings struct {
	TenantID                    string     `json:"tenant_id"`
	AttackModeEnabled           bool       `json:"attack_mode_enabled"`
	AutoAttackMode              bool       `json:"auto_attack_mode"`
	FingerprintRequired         bool       `json:"fingerprint_required"`
	AttackModeThreshold         int        `json:"attack_mode_threshold"`
	SurgeMultiplier             int        `json:"surge_multiplier"`
	SurgeMinPerHour             int        `json:"surge_min_per_hour"`
	AttackModeAutoEnabledAt     *time.Time `json:"attack_mode_auto_enabled_at,omitempty"`
	AttackModeAutoCooldownUntil *time.Time `json:"attack_mode_auto_cooldown_until,omitempty"`
	UpdatedAt                   time.Time  `json:"updated_at"`
}

// SignupInput is the bundle the public submit handler hands the
// scorer. Every field is best-effort — we don't fail open or shut
// based on missing inputs, we just score them.
type SignupInput struct {
	BrowserFPPresent bool
	UserAgent        string
	Referer          string
	IP               string
	Rate5m           int
	// FingerprintRequired comes from tenant Settings; passed in so the
	// scorer is a pure function of inputs (callers don't have to plumb
	// settings twice).
	FingerprintRequired bool
}

// ScoreResult is what the scorer returns. Persisted to
// firewall_signup_events.
type ScoreResult struct {
	BrowserFPPresent bool
	UAQuality        int
	RefererQuality   int
	Rate5m           int
	RiskScore        int
}

// Score is a pure function: no DB, no time, no randomness. The four
// signal qualities are 0..100 (higher = more browser-like); the final
// risk_score is the inverse — higher = more suspicious.
func Score(in SignupInput) ScoreResult {
	res := ScoreResult{
		BrowserFPPresent: in.BrowserFPPresent,
		Rate5m:           in.Rate5m,
	}

	res.UAQuality = scoreUA(in.UserAgent)
	res.RefererQuality = scoreReferer(in.Referer)

	// Risk addends (higher = worse). Each component is the inverse
	// of its "quality" (a 0-quality UA contributes the full weight).
	var risk int

	// Fingerprint: only counts when the tenant opted into the
	// requirement. Absent fingerprint without opt-in => 0 contribution.
	if in.FingerprintRequired && !in.BrowserFPPresent {
		risk += weightFingerprint
	} else if !in.BrowserFPPresent {
		// Soft signal even when not required: half-weight so the
		// observation-only audit log still surfaces patterns.
		risk += weightFingerprint / 4 // 10 points
	}

	risk += weightUA * (100 - res.UAQuality) / 100
	risk += weightReferer * (100 - res.RefererQuality) / 100

	// Rate component is a clamped log-scale: 0 hits = 0 risk;
	// 5 = ~5; 25 = ~15; 100+ = full weight.
	risk += rateRiskAddend(in.Rate5m)

	if risk < 0 {
		risk = 0
	}
	if risk > 100 {
		risk = 100
	}
	res.RiskScore = risk
	return res
}

// scoreUA maps a User-Agent to a 0..100 browser-likeness score. We
// keep this simple-and-defensible because a sophisticated UA parser
// would invite a maintenance burden for marginal accuracy gains —
// the rate + fingerprint signals carry the real load.
func scoreUA(ua string) int {
	u := strings.TrimSpace(ua)
	if u == "" {
		return 0
	}
	lower := strings.ToLower(u)
	// Obvious non-browsers.
	for _, bad := range []string{
		"curl/", "wget/", "go-http-client", "python-requests",
		"libwww-perl", "scrapy", "httpie", "java/", "okhttp", "axios/",
	} {
		if strings.Contains(lower, bad) {
			return 5
		}
	}
	// Real browsers start with "Mozilla/" and identify a rendering
	// engine. We accept Mozilla + (Chrome|Safari|Firefox|Edge|Edg).
	if !strings.HasPrefix(u, "Mozilla/") {
		return 30
	}
	hasEngine := false
	for _, engine := range []string{"Chrome/", "Safari/", "Firefox/", "Edge/", "Edg/"} {
		if strings.Contains(u, engine) {
			hasEngine = true
			break
		}
	}
	if !hasEngine {
		return 40
	}
	// Headless markers — penalize but don't zero-out (some legitimate
	// QA traffic uses these).
	for _, marker := range []string{"HeadlessChrome", "PhantomJS", "Puppeteer"} {
		if strings.Contains(u, marker) {
			return 25
		}
	}
	return 95
}

// scoreReferer maps a Referer header to a 0..100 quality score.
// Present + same-scheme http(s) = 100; present but http when site is
// https = 60; absent = 0. We don't enforce origin-allowlist here —
// the form ID is already bound by URL slug, and the tenant's settings
// page can configure allowed origins separately if needed.
func scoreReferer(ref string) int {
	r := strings.TrimSpace(ref)
	if r == "" {
		return 0
	}
	lr := strings.ToLower(r)
	if strings.HasPrefix(lr, "https://") {
		return 100
	}
	if strings.HasPrefix(lr, "http://") {
		return 60
	}
	return 30
}

// rateRiskAddend is the per-IP rate-limit signal. Buckets:
//
//	0-2    : 0  (one-off submit, normal)
//	3-9    : 4
//	10-24  : 10
//	25-49  : 15
//	50-99  : 18
//	100+   : 20 (full weight)
func rateRiskAddend(rate int) int {
	switch {
	case rate <= 2:
		return 0
	case rate <= 9:
		return 4
	case rate <= 24:
		return 10
	case rate <= 49:
		return 15
	case rate <= 99:
		return 18
	default:
		return weightRate
	}
}

// --- DB layer ---

// Deps wires the HTTP surface.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// GetOrCreateSettings returns the tenant's settings row, creating it
// with defaults on first read. Called by both the read handler and
// the public submit path (which needs FingerprintRequired before
// scoring).
func GetOrCreateSettings(ctx context.Context, pool *db.Pool, tenantID string) (*Settings, error) {
	if pool == nil || tenantID == "" {
		return nil, errors.New("firewall: pool + tenant required")
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	s, err := readSettings(ctx, tx, tenantID)
	if err == nil {
		_ = tx.Commit(ctx)
		return s, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	// Lazy-create with platform defaults.
	if _, err := tx.Exec(ctx, `
INSERT INTO firewall_settings (tenant_id)
VALUES ($1::uuid)
ON CONFLICT (tenant_id) DO NOTHING`, tenantID); err != nil {
		return nil, err
	}
	s, err = readSettings(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

func readSettings(ctx context.Context, tx pgx.Tx, tenantID string) (*Settings, error) {
	var s Settings
	err := tx.QueryRow(ctx, `
SELECT tenant_id::text, attack_mode_enabled, auto_attack_mode,
       fingerprint_required, attack_mode_threshold, surge_multiplier,
       surge_min_per_hour, attack_mode_auto_enabled_at,
       attack_mode_auto_cooldown_until, updated_at
  FROM firewall_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&s.TenantID, &s.AttackModeEnabled, &s.AutoAttackMode,
		&s.FingerprintRequired, &s.AttackModeThreshold, &s.SurgeMultiplier,
		&s.SurgeMinPerHour, &s.AttackModeAutoEnabledAt,
		&s.AttackModeAutoCooldownUntil, &s.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// ValidationError carries an operator-safe message that PutSettings can
// echo back to the caller via httperror.WriteValidation. Any error
// returned by UpdateSettings that is NOT a *ValidationError is an
// infrastructure failure (db connection, RLS denial, ...) whose text
// must NOT leak into the HTTP response body.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// UpdateSettingsInput is the body of PUT /api/v1/firewall/settings.
// Pointers so unset fields preserve existing values (partial update).
type UpdateSettingsInput struct {
	AttackModeEnabled   *bool `json:"attack_mode_enabled,omitempty"`
	AutoAttackMode      *bool `json:"auto_attack_mode,omitempty"`
	FingerprintRequired *bool `json:"fingerprint_required,omitempty"`
	AttackModeThreshold *int  `json:"attack_mode_threshold,omitempty"`
	SurgeMultiplier     *int  `json:"surge_multiplier,omitempty"`
	SurgeMinPerHour     *int  `json:"surge_min_per_hour,omitempty"`
}

// UpdateSettings applies a partial patch. When attack_mode_enabled is
// explicitly flipped from true to false, we set
// attack_mode_auto_cooldown_until to now()+24h so the auto-detector
// doesn't immediately flip it back on (operator override stickiness).
func UpdateSettings(ctx context.Context, pool *db.Pool, tenantID string, in UpdateSettingsInput) (*Settings, error) {
	if _, err := GetOrCreateSettings(ctx, pool, tenantID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cur, err := readSettings(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}

	if in.AttackModeThreshold != nil {
		if *in.AttackModeThreshold < 0 || *in.AttackModeThreshold > 100 {
			return nil, &ValidationError{Msg: "attack_mode_threshold must be 0..100"}
		}
	}
	if in.SurgeMultiplier != nil {
		if *in.SurgeMultiplier < 2 || *in.SurgeMultiplier > 100 {
			return nil, &ValidationError{Msg: "surge_multiplier must be 2..100"}
		}
	}
	if in.SurgeMinPerHour != nil {
		if *in.SurgeMinPerHour < 1 || *in.SurgeMinPerHour > 100000 {
			return nil, &ValidationError{Msg: "surge_min_per_hour must be 1..100000"}
		}
	}

	// Cooldown trigger: operator flipping attack_mode_enabled true->false.
	manualOff := in.AttackModeEnabled != nil && !*in.AttackModeEnabled && cur.AttackModeEnabled
	cooldownSQL := ""
	if manualOff {
		cooldownSQL = ", attack_mode_auto_cooldown_until = now() + INTERVAL '24 hours'"
	}

	if _, err := tx.Exec(ctx, `
UPDATE firewall_settings SET
  attack_mode_enabled    = COALESCE($2, attack_mode_enabled),
  auto_attack_mode       = COALESCE($3, auto_attack_mode),
  fingerprint_required   = COALESCE($4, fingerprint_required),
  attack_mode_threshold  = COALESCE($5, attack_mode_threshold),
  surge_multiplier       = COALESCE($6, surge_multiplier),
  surge_min_per_hour     = COALESCE($7, surge_min_per_hour),
  updated_at             = now()
  `+cooldownSQL+`
WHERE tenant_id = $1::uuid`,
		tenantID, in.AttackModeEnabled, in.AutoAttackMode,
		in.FingerprintRequired, in.AttackModeThreshold,
		in.SurgeMultiplier, in.SurgeMinPerHour); err != nil {
		return nil, err
	}
	out, err := readSettings(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RecordEvent persists one signup attempt + its score for audit and
// the surge detector. tenantID is required; formID may be empty if
// the slug didn't resolve. The public submit handler calls this with
// app.public_form_tenant_id GUC bound — the RLS policy
// `public_form_insert` accepts that GUC explicitly.
func RecordEvent(ctx context.Context, pool *db.Pool, tenantID, formID string, in SignupInput, res ScoreResult, action string) error {
	if pool == nil || tenantID == "" {
		return errors.New("firewall: pool + tenant required")
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// We accept either GUC name (admin sweep vs public submit).
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_form_tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	var ipArg any = nil
	if in.IP != "" {
		ipArg = in.IP
	}
	var fidArg any = nil
	if formID != "" {
		fidArg = formID
	}
	var emailArg any = nil
	// Email is whatever the caller embedded into the UA slot — we
	// don't reach back into SignupInput because that struct stays
	// PII-free. The public path passes "" today; future callers can
	// extend. (Deliberately conservative: minimal PII at rest.)
	_ = emailArg
	if _, err := tx.Exec(ctx, `
INSERT INTO firewall_signup_events
  (tenant_id, form_id, browser_fp_present, ua_quality, referer_quality,
   rate_5m, risk_score, action, ip, user_agent, email)
VALUES
  ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::inet, $10, $11)`,
		tenantID, fidArg, res.BrowserFPPresent, res.UAQuality,
		res.RefererQuality, res.Rate5m, res.RiskScore, action, ipArg,
		in.UserAgent, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RateForIP returns recent signup attempts for (tenant, ip) in the
// last 5 minutes. Best-effort: callers treat error as rate=0 so a
// flaky DB never blocks the public submit path.
func RateForIP(ctx context.Context, pool *db.Pool, tenantID, ip string) (int, error) {
	if pool == nil || tenantID == "" || ip == "" {
		return 0, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM firewall_signup_events
 WHERE tenant_id = $1::uuid
   AND ip = $2::inet
   AND at > now() - INTERVAL '5 minutes'`, tenantID, ip).Scan(&n); err != nil {
		return 0, err
	}
	_ = tx.Commit(ctx)
	return n, nil
}

// DetectSurgeForTenant compares last-hour signup volume against the
// rolling 7-day baseline. When the multiplier and floor thresholds
// are both crossed, and we're outside the cooldown window, flip
// attack_mode_enabled ON. Returns true iff a flip occurred.
func DetectSurgeForTenant(ctx context.Context, pool *db.Pool, tenantID string) (bool, error) {
	s, err := GetOrCreateSettings(ctx, pool, tenantID)
	if err != nil {
		return false, err
	}
	if !s.AutoAttackMode || s.AttackModeEnabled {
		return false, nil
	}
	now := time.Now().UTC()
	if s.AttackModeAutoCooldownUntil != nil && s.AttackModeAutoCooldownUntil.After(now) {
		return false, nil
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lastHour, last7d int
	if err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE at > now() - INTERVAL '1 hour'),
  count(*) FILTER (WHERE at > now() - INTERVAL '7 days')
FROM firewall_signup_events
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&lastHour, &last7d); err != nil {
		return false, err
	}
	// Baseline = avg per-hour over 7 days. Use a half-day floor of 1
	// so a quiet tenant doesn't trigger off 1 vs 0.
	baseline := float64(last7d) / (24.0 * 7.0)
	if baseline < 1.0 {
		baseline = 1.0
	}
	if lastHour < s.SurgeMinPerHour {
		_ = tx.Commit(ctx)
		return false, nil
	}
	if float64(lastHour) < baseline*float64(s.SurgeMultiplier) {
		_ = tx.Commit(ctx)
		return false, nil
	}
	// Surge — flip the switch.
	if _, err := tx.Exec(ctx, `
UPDATE firewall_settings
   SET attack_mode_enabled         = true,
       attack_mode_auto_enabled_at = now(),
       updated_at                  = now()
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// --- HTTP surface ---

// MountRoutes wires the admin endpoints onto chi.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/firewall/settings", d.GetSettings)
	r.With(admin).Put("/api/v1/firewall/settings", d.PutSettings)
	r.With(read).Get("/api/v1/firewall/events", d.ListEvents)
	r.With(read).Get("/api/v1/firewall/stats", d.Stats)
	r.With(admin).Post("/api/v1/firewall/detect", d.RunDetect)
}

// GetSettings GET /api/v1/firewall/settings
func (d *Deps) GetSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	s, err := GetOrCreateSettings(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// PutSettings PUT /api/v1/firewall/settings
func (d *Deps) PutSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	var in UpdateSettingsInput
	if err := httpbody.DecodeJSON(w, r, settingsJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	s, err := UpdateSettings(r.Context(), d.Pool, t.ID, in)
	if err != nil {
		// Only operator-safe *ValidationError messages get echoed; everything
		// else (db, RLS, etc.) routes through WriteInternal so the err lands
		// in the structured log, not the response body.
		var ve *ValidationError
		if errors.As(err, &ve) {
			httperror.WriteValidation(w, "validation_failed", ve.Msg)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// Event mirrors firewall_signup_events on the wire.
type Event struct {
	ID               string    `json:"id"`
	FormID           string    `json:"form_id,omitempty"`
	BrowserFPPresent bool      `json:"browser_fp_present"`
	UAQuality        int       `json:"ua_quality"`
	RefererQuality   int       `json:"referer_quality"`
	Rate5m           int       `json:"rate_5m"`
	RiskScore        int       `json:"risk_score"`
	Action           string    `json:"action"`
	IP               string    `json:"ip,omitempty"`
	UserAgent        string    `json:"user_agent,omitempty"`
	At               time.Time `json:"at"`
}

// ListEvents GET /api/v1/firewall/events?action=&limit=
func (d *Deps) ListEvents(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 500 {
			limit = n
		}
	}
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, COALESCE(form_id::text, ''), browser_fp_present,
       ua_quality, referer_quality, rate_5m, risk_score, action,
       COALESCE(host(ip), ''), COALESCE(user_agent, ''), at
  FROM firewall_signup_events
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR action = $2)
 ORDER BY at DESC
 LIMIT $3`, t.ID, action, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.FormID, &e.BrowserFPPresent,
			&e.UAQuality, &e.RefererQuality, &e.Rate5m, &e.RiskScore,
			&e.Action, &e.IP, &e.UserAgent, &e.At); err == nil {
			out = append(out, e)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"events": out,
		"count":  len(out),
	})
}

// Stats GET /api/v1/firewall/stats
func (d *Deps) Stats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var (
		accepted24h, rejected24h, observed24h int
		accepted7d, rejected7d, observed7d    int
	)
	_ = tx.QueryRow(r.Context(), `
SELECT
  count(*) FILTER (WHERE action='accepted' AND at > now() - INTERVAL '24 hours'),
  count(*) FILTER (WHERE action='rejected' AND at > now() - INTERVAL '24 hours'),
  count(*) FILTER (WHERE action='observed' AND at > now() - INTERVAL '24 hours'),
  count(*) FILTER (WHERE action='accepted' AND at > now() - INTERVAL '7 days'),
  count(*) FILTER (WHERE action='rejected' AND at > now() - INTERVAL '7 days'),
  count(*) FILTER (WHERE action='observed' AND at > now() - INTERVAL '7 days')
FROM firewall_signup_events
 WHERE tenant_id = $1::uuid`, t.ID).Scan(
		&accepted24h, &rejected24h, &observed24h,
		&accepted7d, &rejected7d, &observed7d)
	writeJSON(w, http.StatusOK, map[string]any{
		"last_24h": map[string]int{
			"accepted": accepted24h,
			"rejected": rejected24h,
			"observed": observed24h,
		},
		"last_7d": map[string]int{
			"accepted": accepted7d,
			"rejected": rejected7d,
			"observed": observed7d,
		},
	})
}

// RunDetect POST /api/v1/firewall/detect — operator-triggered surge sweep.
func (d *Deps) RunDetect(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	flipped, err := DetectSurgeForTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"flipped": flipped})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
