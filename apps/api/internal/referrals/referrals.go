// Package referrals owns the share-to-grow widget: per-tenant program
// definition, per-subscriber share codes, and a public redirect endpoint
// that drops a short-lived attribution cookie before bouncing to the
// tenant's signup form.
package referrals

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// CookieName is the attribution cookie set by /api/public/r/{code}.
const CookieName = "pw_ref"

// CookieMaxAge is how long the attribution cookie lives. 30 days mirrors
// what most newsletter referral tools default to.
const CookieMaxAge = 30 * 24 * time.Hour

const referralJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB
const referralFraudThreshold = 0.5

// OperationalRuntimeAvailable is the compile-time release boundary for
// referral mutations, subscriber links, reward processing, and public
// attribution. Historical authenticated inspection stays available while the
// runtime is closed.
//
// RELEASE REMAINS HELD. Handler existence is not operational qualification.
// Before opening, re-review the subscriber-referral authorization change, make
// congrats delivery atomic so it cannot consume congrats_sent_at while sending
// nothing, complete the public widget keyboard/focus contract, and attach
// evidence for signup crediting, expiry, immutable reward snapshots, read
// purity, privacy, and fulfillment. Production also requires a tenant-safe
// POSTWAVE_REFERRAL_COOKIE_SECRET of at least 32 bytes.
const OperationalRuntimeAvailable = false

// OperationalRuntimeHoldCode is the stable release-hold identifier every route
// behind OperationalRuntimeAvailable answers with while the boundary is closed.
// It must match the `x-postwave-release-hold` marker on the same operations in
// packages/openapi/openapi.yaml, which is what classifies them as release-held
// in the generated route-authorization manifest.
const OperationalRuntimeHoldCode = "referrals_operational_runtime_held"

// operationalRuntimeHold answers a release-held referral route with the stable
// 503 hold the routeauth manifest advertises. Held routes stay mounted (rather
// than omitted) so routeauth's startup validation can prove the manifest and
// the router agree; routeauth.Middleware answers release-held policies before
// any handler runs, and this handler gives the public group the same answer.
func operationalRuntimeHold(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{
		Error: "the referral operational runtime is release-held",
		Code:  OperationalRuntimeHoldCode,
	})
}

const (
	maxReferralProgramMilestones = 50
	maxReferralMilestoneCount    = 1_000_000
	maxReferralRewardLabelRunes  = 200
)

// ErrNotFound is returned when a lookup misses.
var ErrNotFound = errors.New("referrals: not found")

// ErrProgramConflict is returned when a caller's full-replacement
// precondition no longer matches the tenant's active program.
var ErrProgramConflict = errors.New("referrals: active program changed")

// Milestone is one tier in the program.
//
// Refined Referrals PR 1: RewardKind is the new structural enum
// ("swag" | "free" | "annual" | "custom"). For backward compat with
// existing rows that still encode the kind as a label prefix, the
// repo reads milestones_v2 first and falls back to parsing the
// legacy [kind] prefix off of RewardLabel.
type Milestone struct {
	Count            int    `json:"count"`
	RewardLabel      string `json:"reward_label"`
	RewardKind       string `json:"reward_kind,omitempty"`
	RewardValueCents int    `json:"reward_value_cents,omitempty"`
	RewardCurrency   string `json:"reward_currency,omitempty"`
	RewardSKU        string `json:"reward_sku,omitempty"`
	// PR 2: optional Library asset id for reward art. Stored inside
	// milestones_v2 jsonb — no schema change. Legacy column ignores
	// this field on the way out (the prefix encoder only sets label).
	RewardImageAssetID string `json:"reward_image_asset_id,omitempty"`
}

// Program is the wire shape for the active program.
//
// PR 4: ExpiresAt enables time-bound programs ("summer challenge
// ends Aug 31"). nil = no expiry. SubscriberView treats an expired
// program as no-program so the share UI hides gracefully.
type Program struct {
	ID                        string      `json:"id"`
	TenantID                  string      `json:"tenantId"`
	Milestones                []Milestone `json:"milestones"`
	Active                    bool        `json:"active"`
	ExpiresAt                 *time.Time  `json:"expiresAt,omitempty"`
	RefereeRewardKind         string      `json:"referee_reward_kind,omitempty"`
	RefereeRewardLabel        string      `json:"referee_reward_label,omitempty"`
	RefereeRewardImageAssetID string      `json:"referee_reward_image_asset_id,omitempty"`
	RewardValueCents          int         `json:"reward_value_cents,omitempty"`
	RewardCurrency            string      `json:"reward_currency,omitempty"`
	RewardSKU                 string      `json:"reward_sku,omitempty"`
	VerificationWindowDays    int         `json:"verification_window_days,omitempty"`
	CreatedAt                 time.Time   `json:"createdAt"`
	UpdatedAt                 time.Time   `json:"updatedAt"`
}

// SubscriberView is the per-subscriber payload.
type SubscriberView struct {
	ShareURL           string      `json:"share_url"`
	RefCode            string      `json:"ref_code"`
	ReferralsCount     int         `json:"referrals_count"`
	MilestonesUnlocked []Milestone `json:"milestones_unlocked"`
}

// Repo is the postgres surface.
type Repo struct {
	Pool *db.Pool

	// payoutDerive rate-limits the derive-on-read payout backstop
	// (payouts.go ensureAchievedPayouts) to one pass per tenant per
	// payoutDeriveTTL. Zero value is ready to use; Repo must be shared
	// by pointer (it is — main.go constructs exactly one).
	payoutDerive payoutDeriveGuard
}

// SetProgramOptions are the writeable bits of a program. expandable
// without breaking the legacy SetProgram(milestones) signature.
type SetProgramOptions struct {
	Milestones                []Milestone
	ExpiresAt                 *time.Time // PR 4: optional end date
	RefereeRewardKind         string
	RefereeRewardLabel        string
	RefereeRewardImageAssetID string
	RewardValueCents          int
	RewardCurrency            string
	RewardSKU                 string
	VerificationWindowDays    int
	// ExpectedProgramID guards a full replacement against stale editors and
	// ambiguous retries. RequireNoActiveProgram gives creates the equivalent
	// compare-and-set boundary. Legacy SDK callers can omit both for the
	// historical unconditional behavior.
	ExpectedProgramID      string
	RequireNoActiveProgram bool
}

// SetProgramWithOptions is the modern variant. Legacy SetProgram is
// kept below as a shim so SDK callers don't need to migrate.
func (r *Repo) SetProgramWithOptions(ctx context.Context, tenantID string, opts SetProgramOptions) (*Program, error) {
	return r.setProgram(ctx, tenantID, opts)
}

// SetProgram upserts the active program for the tenant.
//
// PR 1 writes BOTH columns so legacy readers (mobile, third-party SDK
// users on older versions) keep working until they migrate to v2.
// legacyMilestones encodes the kind as a label prefix; milestones_v2
// is the structural shape with reward_kind as its own field.
func (r *Repo) SetProgram(ctx context.Context, tenantID string, milestones []Milestone) (*Program, error) {
	return r.setProgram(ctx, tenantID, SetProgramOptions{Milestones: milestones})
}

func (r *Repo) setProgram(ctx context.Context, tenantID string, opts SetProgramOptions) (*Program, error) {
	if err := validateProgramMilestones(opts.Milestones); err != nil {
		return nil, err
	}
	if err := validateRefereeRewardKind(opts.RefereeRewardKind); err != nil {
		return nil, err
	}
	milestones := opts.Milestones
	opts.VerificationWindowDays = clampReferralInt(opts.VerificationWindowDays, 0, 30)
	opts.RefereeRewardKind = normalizeRewardKind(opts.RefereeRewardKind)
	// Normalise: every milestone gets a reward_kind (default "custom"
	// for legacy inputs that omit it). Legacy column gets the [kind]
	// prefix re-encoded into RewardLabel.
	for i := range milestones {
		milestones[i].RewardKind = normalizeRewardKind(milestones[i].RewardKind)
	}
	legacy := make([]Milestone, len(milestones))
	for i, m := range milestones {
		legacy[i] = Milestone{
			Count:       m.Count,
			RewardLabel: encodeLegacyLabel(m.RewardKind, m.RewardLabel),
		}
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Serialize the singleton compare-and-set boundary even when no active row
	// exists yet. Without this lock, two concurrent creates can both observe
	// an empty tenant and race into the partial unique index.
	if _, err := tx.Exec(
		ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"referral-program:"+tenantID,
	); err != nil {
		return nil, err
	}
	var activeProgramID string
	activeErr := tx.QueryRow(ctx, `
SELECT id::text
  FROM referral_programs
 WHERE tenant_id = $1::uuid
   AND active = true
 FOR UPDATE`, tenantID).Scan(&activeProgramID)
	activeExists := activeErr == nil
	if activeErr != nil && !errors.Is(activeErr, pgx.ErrNoRows) {
		return nil, activeErr
	}
	if opts.RequireNoActiveProgram && activeExists {
		return nil, ErrProgramConflict
	}
	if opts.ExpectedProgramID != "" &&
		(!activeExists || activeProgramID != opts.ExpectedProgramID) {
		return nil, ErrProgramConflict
	}
	mbLegacy, _ := json.Marshal(legacy)
	mbV2, _ := json.Marshal(milestones)
	if _, err := tx.Exec(ctx, `
UPDATE referral_programs SET active = false WHERE tenant_id = $1::uuid AND active = true`, tenantID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO referral_programs (
    tenant_id, milestones, milestones_v2, expires_at, active,
    referee_reward_kind, referee_reward_label, referee_reward_image_asset_id,
    reward_value_cents, reward_currency, reward_sku, verification_window_days
)
VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4, true,
        NULLIF($5,''), NULLIF($6,''), NULLIF($7,''),
        NULLIF($8, 0), NULLIF($9,''), NULLIF($10,''), $11)
RETURNING id::text, created_at, updated_at`,
		tenantID, mbLegacy, mbV2, opts.ExpiresAt,
		opts.RefereeRewardKind, opts.RefereeRewardLabel, opts.RefereeRewardImageAssetID,
		opts.RewardValueCents, opts.RewardCurrency, opts.RewardSKU, opts.VerificationWindowDays)
	p := &Program{
		TenantID:                  tenantID,
		Milestones:                milestones,
		Active:                    true,
		ExpiresAt:                 opts.ExpiresAt,
		RefereeRewardKind:         opts.RefereeRewardKind,
		RefereeRewardLabel:        opts.RefereeRewardLabel,
		RefereeRewardImageAssetID: opts.RefereeRewardImageAssetID,
		RewardValueCents:          opts.RewardValueCents,
		RewardCurrency:            opts.RewardCurrency,
		RewardSKU:                 opts.RewardSKU,
		VerificationWindowDays:    opts.VerificationWindowDays,
	}
	if err := row.Scan(&p.ID, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return p, nil
}

func validateProgramMilestones(milestones []Milestone) error {
	if len(milestones) == 0 {
		return errors.New("at least one milestone is required")
	}
	if len(milestones) > maxReferralProgramMilestones {
		return fmt.Errorf("milestones must contain at most %d items", maxReferralProgramMilestones)
	}
	seenCounts := make(map[int]struct{}, len(milestones))
	for _, milestone := range milestones {
		if milestone.Count < 1 || milestone.Count > maxReferralMilestoneCount {
			return fmt.Errorf("milestone count must be between 1 and %d", maxReferralMilestoneCount)
		}
		if _, duplicate := seenCounts[milestone.Count]; duplicate {
			return errors.New("milestone counts must be unique")
		}
		seenCounts[milestone.Count] = struct{}{}
		if strings.TrimSpace(milestone.RewardLabel) == "" {
			return errors.New("milestone reward_label is required")
		}
		if utf8.RuneCountInString(milestone.RewardLabel) > maxReferralRewardLabelRunes {
			return fmt.Errorf("milestone reward_label must be at most %d characters", maxReferralRewardLabelRunes)
		}
		if !isSupportedReferralRewardKind(milestone.RewardKind) {
			return errors.New("milestone reward_kind must be one of swag, free, annual, or custom")
		}
	}
	return nil
}

func validateRefereeRewardKind(kind string) error {
	if !isSupportedReferralRewardKind(kind) {
		return errors.New("referee_reward_kind must be one of swag, free, annual, or custom")
	}
	return nil
}

func isSupportedReferralRewardKind(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "", "swag", "free", "annual", "custom":
		return true
	default:
		return false
	}
}

// encodeLegacyLabel produces the "[kind] label" prefix the v1
// schema expects. Unknown kinds fall back to "[custom]" so the
// label is always self-describing.
func encodeLegacyLabel(kind, label string) string {
	return "[" + normalizeRewardKind(kind) + "] " + label
}

// decodeLegacyMilestones parses a v1 jsonb into v2 shape — used as
// the fallback when milestones_v2 is empty (rows from before PR 1).
func decodeLegacyMilestones(raw []byte) []Milestone {
	var legacy []Milestone
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, &legacy); err != nil {
		return nil
	}
	out := make([]Milestone, 0, len(legacy))
	for _, m := range legacy {
		kind, label := splitLegacyLabel(m.RewardLabel)
		out = append(out, Milestone{
			Count:       m.Count,
			RewardLabel: label,
			RewardKind:  kind,
		})
	}
	return out
}

func splitLegacyLabel(s string) (kind, label string) {
	// Cheap parse — no regex; expecting "[kind] rest" with no nesting.
	if len(s) > 2 && s[0] == '[' {
		if end := indexByte(s, ']'); end > 1 && end < len(s)-1 {
			k := s[1:end]
			rest := s[end+1:]
			// trim a single leading space if present
			if len(rest) > 0 && rest[0] == ' ' {
				rest = rest[1:]
			}
			if normalizeRewardKind(k) == k {
				return k, rest
			}
		}
	}
	return "custom", s
}

func normalizeRewardKind(kind string) string {
	k := strings.ToLower(strings.TrimSpace(kind))
	if k == "" {
		return "custom"
	}
	if len(k) > 64 {
		k = k[:64]
	}
	for _, r := range k {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			continue
		}
		return "custom"
	}
	return k
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func clampReferralInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// GetActiveProgram returns the active program or ErrNotFound.
func (r *Repo) GetActiveProgram(ctx context.Context, tenantID string) (*Program, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p Program
	var mbLegacy, mbV2 []byte
	var refereeKind, refereeLabel, refereeImage, rewardCurrency, rewardSKU *string
	var rewardValue *int
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, milestones, milestones_v2, expires_at, active,
       referee_reward_kind, referee_reward_label, referee_reward_image_asset_id,
       reward_value_cents, reward_currency, reward_sku,
       COALESCE(verification_window_days, 0),
       created_at, updated_at
  FROM referral_programs
 WHERE tenant_id = $1::uuid AND active = true
 LIMIT 1`, tenantID).Scan(&p.ID, &p.TenantID, &mbLegacy, &mbV2, &p.ExpiresAt, &p.Active,
		&refereeKind, &refereeLabel, &refereeImage, &rewardValue, &rewardCurrency, &rewardSKU,
		&p.VerificationWindowDays, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// PR 1: prefer the v2 column when non-empty; fall back to parsing
	// the legacy prefix so rows from before the migration still work.
	if len(mbV2) > 0 {
		var v2 []Milestone
		if json.Unmarshal(mbV2, &v2) == nil && len(v2) > 0 {
			p.Milestones = v2
		}
	}
	if len(p.Milestones) == 0 {
		p.Milestones = decodeLegacyMilestones(mbLegacy)
	}
	if refereeKind != nil {
		p.RefereeRewardKind = *refereeKind
	}
	if refereeLabel != nil {
		p.RefereeRewardLabel = *refereeLabel
	}
	if refereeImage != nil {
		p.RefereeRewardImageAssetID = *refereeImage
	}
	if rewardValue != nil {
		p.RewardValueCents = *rewardValue
	}
	if rewardCurrency != nil {
		p.RewardCurrency = *rewardCurrency
	}
	if rewardSKU != nil {
		p.RewardSKU = *rewardSKU
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &p, nil
}

// EnsureCode reads the existing code for (tenant, subscriber) or mints one.
func (r *Repo) EnsureCode(ctx context.Context, tenantID, subscriberID string) (string, error) {
	var lastError error
	for attempt := 0; attempt < referralCodeMintAttempts; attempt++ {
		tx, err := db.WithTenant(ctx, r.Pool, tenantID)
		if err != nil {
			return "", err
		}
		if err := setReferralCodeLockTimeout(ctx, tx); err != nil {
			_ = tx.Rollback(ctx)
			return "", err
		}

		var code string
		err = tx.QueryRow(ctx, `
SELECT code
  FROM public.referral_codes
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2`, tenantID, subscriberID).Scan(&code)
		if err == nil {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				if !isReferralCodeRetryable(commitErr) {
					return "", commitErr
				}
				lastError = commitErr
			} else {
				return code, nil
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			if !isReferralCodeRetryable(err) {
				return "", err
			}
			lastError = err
		} else {
			newCode, generateErr := GenerateCode()
			if generateErr != nil {
				_ = tx.Rollback(ctx)
				return "", generateErr
			}
			err = tx.QueryRow(ctx, `
INSERT INTO public.referral_codes (tenant_id, subscriber_id, code)
VALUES ($1::uuid, $2, $3)
ON CONFLICT (tenant_id, subscriber_id) DO NOTHING
RETURNING code`, tenantID, subscriberID, newCode).Scan(&code)
			if errors.Is(err, pgx.ErrNoRows) {
				err = tx.QueryRow(ctx, `
SELECT code
  FROM public.referral_codes
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2`, tenantID, subscriberID).Scan(&code)
			}
			if err == nil {
				err = tx.Commit(ctx)
			} else {
				_ = tx.Rollback(ctx)
			}
			if err == nil {
				return code, nil
			}
			if !isReferralCodeUniqueViolation(err) && !isReferralCodeRetryable(err) {
				return "", err
			}
			lastError = err
		}

		if waitErr := waitForReferralCodeRetry(ctx, attempt); waitErr != nil {
			return "", waitErr
		}
	}
	return "", referralCodeContentionError(lastError)
}

// CountReferrals returns how many distinct referees the subscriber has
// brought in.
func (r *Repo) CountReferrals(ctx context.Context, tenantID, subscriberID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM referral_conversions
 WHERE tenant_id = $1::uuid
   AND referrer_subscriber_id = $2
   AND COALESCE(fraud_score, 0) < $3
   AND COALESCE(credit_status, 'credited') = 'credited'`, tenantID, subscriberID, referralFraudThreshold).Scan(&n); err != nil {
		return 0, err
	}
	return n, tx.Commit(ctx)
}

// CodeOwner looks up the tenant + subscriber that owns a public ref code.
// Public; runs without a tenant context.
func (r *Repo) CodeOwner(ctx context.Context, code string) (tenantID, subscriberID string, err error) {
	return r.lookupCodeOwner(ctx, code, false)
}

// resolveMergedCodeOwner makes previously issued referral URLs survive a
// subscriber merge. referral_codes intentionally retains a second source code
// on the lineage tombstone when both profiles already had one; all new credit
// must nevertheless accrue to the final live survivor. to_jsonb keeps this
// read compatible with deployments immediately before migration 1769.
func (r *Repo) resolveMergedCodeOwner(ctx context.Context, tenantID, subscriberID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var resolved string
	if err := tx.QueryRow(ctx, `
WITH RECURSIVE resolved(id, depth) AS (
    SELECT $2::uuid, 0
    UNION ALL
    SELECT NULLIF(to_jsonb(s)->>'merged_into_subscriber_id','')::uuid, r.depth + 1
      FROM resolved r
      JOIN subscribers s ON s.tenant_id=$1::uuid AND s.id=r.id
     WHERE NULLIF(to_jsonb(s)->>'merged_into_subscriber_id','') IS NOT NULL
       AND r.depth < 32
)
SELECT id::text FROM resolved ORDER BY depth DESC LIMIT 1`, tenantID, subscriberID).Scan(&resolved); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return resolved, nil
}

// GenerateCode returns a URL-safe 8-char ref code.
func GenerateCode() (string, error) {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
	const n = 8
	out := make([]byte, n)
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i := 0; i < n; i++ {
		out[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(out), nil
}

// MilestonesUnlocked returns the subset of milestones the count satisfies.
func MilestonesUnlocked(milestones []Milestone, count int) []Milestone {
	out := []Milestone{}
	for _, m := range milestones {
		if count >= m.Count {
			out = append(out, m)
		}
	}
	return out
}

// Deps wires the handler.
type Deps struct {
	Repo                *Repo
	PublicRedirectBase  string
	ShareBaseURL        string
	CookieSecret        string
	Events              EventEmitter
	SignupFormSlugByTID func(ctx context.Context, tenantID string) string
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountAdminRoutes hooks the tenant-scoped endpoints.
func (d *Deps) MountAdminRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/referral-programs/current", d.GetProgram)
	r.With(read).Get("/api/v1/referrals/stats", d.Stats)
	r.With(read).Get("/api/v1/referrals/leaderboard", d.Leaderboard)
	if !OperationalRuntimeAvailable {
		// The route set stays mounted while the runtime is closed so the
		// route-authorization startup validator sees every manifest entry, but
		// each path answers the same stable 503 hold the manifest advertises
		// (x-postwave-release-hold: referrals_operational_runtime_held). No
		// handler below this boundary is reachable.
		r.Post("/api/v1/referral-programs", operationalRuntimeHold)
		r.Get("/api/v1/subscribers/{id}/referral", operationalRuntimeHold)
		r.Post("/api/v1/referrals/credit", operationalRuntimeHold)
		r.Post("/api/v1/subscribers/{id}/referral/code", operationalRuntimeHold)
		r.Get("/api/v1/referrals/payouts", operationalRuntimeHold)
		r.Get("/api/v1/referrals/payouts/export", operationalRuntimeHold)
		r.Patch("/api/v1/referrals/payouts/{id}", operationalRuntimeHold)
		r.Get("/api/v1/referrals/variants", operationalRuntimeHold)
		r.Post("/api/v1/referrals/variants", operationalRuntimeHold)
		r.Delete("/api/v1/referrals/variants/{key}", operationalRuntimeHold)
		return
	}

	r.With(admin).Post("/api/v1/referral-programs", d.SetProgram)
	r.With(admin).Get("/api/v1/subscribers/{id}/referral", d.SubscriberView)
	r.With(admin).Post("/api/v1/referrals/credit", d.Credit)
	// Refined Referrals PR 3-4.
	r.With(admin).Post("/api/v1/subscribers/{id}/referral/code", d.SetDesiredCode)
	r.With(read).Get("/api/v1/referrals/payouts", d.ListPayouts)
	r.With(read).Get("/api/v1/referrals/payouts/export", d.ExportPayoutsCSV)
	r.With(admin).Patch("/api/v1/referrals/payouts/{id}", d.UpdatePayout)
	r.With(read).Get("/api/v1/referrals/variants", d.ListVariants)
	r.With(admin).Post("/api/v1/referrals/variants", d.UpsertVariant)
	r.With(admin).Delete("/api/v1/referrals/variants/{key}", d.DeleteVariant)
}

// MountPublicRoutes hooks the redirect endpoint + the public widget.
func (d *Deps) MountPublicRoutes(r chi.Router) {
	if !OperationalRuntimeAvailable {
		r.Get("/api/public/r/{code}", operationalRuntimeHold)
		r.Get("/api/public/r/{code}/widget.js", operationalRuntimeHold)
		return
	}
	r.Get("/api/public/r/{code}", d.Redirect)
	r.Get("/api/public/r/{code}/widget.js", d.WidgetJS)
}

// SetProgram POST /api/v1/referral-programs
func (d *Deps) SetProgram(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in struct {
		Milestones                []Milestone `json:"milestones"`
		ExpiresAt                 *time.Time  `json:"expires_at"`
		RefereeRewardKind         string      `json:"referee_reward_kind"`
		RefereeRewardLabel        string      `json:"referee_reward_label"`
		RefereeRewardImageAssetID string      `json:"referee_reward_image_asset_id"`
		RewardValueCents          int         `json:"reward_value_cents"`
		RewardCurrency            string      `json:"reward_currency"`
		RewardSKU                 string      `json:"reward_sku"`
		VerificationWindowDays    int         `json:"verification_window_days"`
		ExpectedProgramID         string      `json:"expected_program_id"`
		ExpectNoActiveProgram     bool        `json:"expect_no_active_program"`
	}
	if err := httpbody.DecodeJSON(w, r, referralJSONMaxBodyBytes, &in); err != nil {
		// httpbody returns operator-safe codes (bad_json / payload_too_large)
		// and the error text is authored by httpbody itself — safe to echo.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := validateProgramMilestones(in.Milestones); err != nil {
		httperror.WriteValidation(w, "invalid_milestones", err.Error())
		return
	}
	if err := validateRefereeRewardKind(in.RefereeRewardKind); err != nil {
		httperror.WriteValidation(w, "invalid_referee_reward_kind", err.Error())
		return
	}
	in.ExpectedProgramID = strings.TrimSpace(in.ExpectedProgramID)
	if in.ExpectedProgramID != "" && in.ExpectNoActiveProgram {
		httperror.WriteValidation(
			w,
			"invalid_program_precondition",
			"expected_program_id and expect_no_active_program are mutually exclusive",
		)
		return
	}
	p, err := d.Repo.SetProgramWithOptions(r.Context(), t.ID, SetProgramOptions{
		Milestones:                in.Milestones,
		ExpiresAt:                 in.ExpiresAt,
		RefereeRewardKind:         normalizeRewardKind(in.RefereeRewardKind),
		RefereeRewardLabel:        in.RefereeRewardLabel,
		RefereeRewardImageAssetID: in.RefereeRewardImageAssetID,
		RewardValueCents:          in.RewardValueCents,
		RewardCurrency:            strings.ToUpper(strings.TrimSpace(in.RewardCurrency)),
		RewardSKU:                 in.RewardSKU,
		VerificationWindowDays:    in.VerificationWindowDays,
		ExpectedProgramID:         in.ExpectedProgramID,
		RequireNoActiveProgram:    in.ExpectNoActiveProgram,
	})
	if err != nil {
		if errors.Is(err, ErrProgramConflict) {
			httperror.Write(
				w,
				http.StatusConflict,
				"program_conflict",
				"The active referral program changed. Refresh before saving again.",
			)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// GetProgram GET /api/v1/referral-programs/current
func (d *Deps) GetProgram(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	p, err := d.Repo.GetActiveProgram(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no active program"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// SubscriberView GET /api/v1/subscribers/{id}/referral
func (d *Deps) SubscriberView(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	code, err := d.Repo.EnsureCode(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrCodeContention) {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusConflict, errEnv("code_contention", "code namespace is busy; retry this request"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	count, err := d.Repo.CountReferrals(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	prog, _ := d.Repo.GetActiveProgram(r.Context(), t.ID)
	var unlocked []Milestone
	if prog != nil {
		unlocked = MilestonesUnlocked(prog.Milestones, count)
	}
	base := d.publicShareBase(r)
	if base == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("share_base_missing", "referral share base URL is not configured"))
		return
	}
	writeJSON(w, http.StatusOK, SubscriberView{
		ShareURL:           strings.TrimRight(base, "/") + "/r/" + code,
		RefCode:            code,
		ReferralsCount:     count,
		MilestonesUnlocked: unlocked,
	})
}

// Redirect GET /api/public/r/{code} sets the attribution cookie and 302s
// to the tenant's signup form.
//
// PR 3: accepts either the random code OR a desired_code (branded).
func (d *Deps) Redirect(w http.ResponseWriter, r *http.Request) {
	code, valid := canonicalizeReferralLookupCode(chi.URLParam(r, "code"))
	if !valid {
		writePublicReferralNotFound(w)
		return
	}
	tid, referrerSubscriberID, err := d.Repo.CodeOwnerByAny(r.Context(), code)
	if err != nil {
		writePublicReferralNotFound(w)
		return
	}
	go d.Repo.RecordClick(context.Background(), tid, code, r)
	formSlug := ""
	if d.SignupFormSlugByTID != nil {
		formSlug = d.SignupFormSlugByTID(r.Context(), tid)
	}
	dest := safePublicRedirectBase(d.PublicRedirectBase)
	if dest == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("redirect_base_missing", "referral redirect base URL is not configured"))
		return
	}
	if formSlug != "" {
		dest = appendPathSegment(dest, formSlug)
	}
	expires := time.Now().Add(CookieMaxAge)
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    signReferralCookie(code, tid, referrerSubscriberID, expires, d.CookieSecret),
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(CookieMaxAge.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, dest, http.StatusFound)
}

func writePublicReferralNotFound(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusNotFound, errEnv("not_found", "referral code not found"))
}

func safePublicRedirectBase(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeRedirectBytes(raw) {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Host == "" || u.User != nil {
		return ""
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme == "http" {
		if !isLocalRedirectHost(u.Hostname()) {
			return ""
		}
	} else if u.Scheme != "https" {
		return ""
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return strings.TrimRight(u.String(), "/")
}

func (d *Deps) publicShareBase(r *http.Request) string {
	base := strings.TrimSpace(d.ShareBaseURL)
	if base != "" && !containsUnsafeRedirectBytes(base) {
		return strings.TrimRight(base, "/")
	}
	if r != nil && r.Host != "" {
		scheme := "https"
		if r.TLS == nil && isLocalRedirectHost(strings.Split(r.Host, ":")[0]) {
			scheme = "http"
		}
		return scheme + "://" + strings.TrimRight(r.Host, "/")
	}
	return ""
}

func appendPathSegment(base, segment string) string {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return base
	}
	segment = strings.Trim(segment, "/")
	if segment == "" {
		return base
	}
	u.RawPath = strings.TrimRight(u.EscapedPath(), "/") + "/" + url.PathEscape(segment)
	u.Path = strings.TrimRight(u.Path, "/") + "/" + segment
	return u.String()
}

func containsUnsafeRedirectBytes(raw string) bool {
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "%0d") || strings.Contains(lower, "%0a") {
		return true
	}
	return strings.ContainsAny(raw, "\x00\r\n")
}

func isLocalRedirectHost(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// CreditConversion writes a (referrer, referee) pair given the public ref
// code. Best-effort; duplicates are ignored via the unique index.
//
// Legacy signature kept for callers that don't have IP / fraud
// context. New paths should use CreditConversionWithIP so the fraud
// score gets persisted.
func (r *Repo) CreditConversion(ctx context.Context, code, refereeSubscriberID string) error {
	_, err := r.CreditConversionWithIP(ctx, code, refereeSubscriberID, "")
	return err
}

// CreditConversionWithIP records the referee IP and computes a 0..1 fraud
// score via the configurable heuristics in fraud.go. It returns true only when
// a newly inserted conversion was immediately credited (duplicates, pending
// verification, and fraud-rejected/self-referral rows return false).
func (r *Repo) CreditConversionWithIP(ctx context.Context, code, refereeSubscriberID, refereeIP string) (bool, error) {
	tid, refSubID, err := r.CodeOwnerByAny(ctx, code)
	if err != nil {
		return false, err
	}
	return r.creditConversionForResolvedTenant(ctx, tid, refSubID, refereeSubscriberID, refereeIP)
}

// CreditConversionForTenantWithIP is the authenticated HTTP-path variant. It
// binds both sides of the conversion to the request tenant before any write,
// preventing a valid referral cookie from one workspace being paired with a
// subscriber UUID supplied from another workspace.
func (r *Repo) CreditConversionForTenantWithIP(ctx context.Context, tenantID, code, refereeSubscriberID, refereeIP string) (bool, error) {
	return r.CreditConversionForTenantCookieWithIP(ctx, tenantID, code, "", refereeSubscriberID, refereeIP)
}

// CreditConversionForTenantCookieWithIP verifies every identity carried by a
// signed attribution cookie against the current referral-code owner. Passing
// an empty expectedReferrerSubscriberID is reserved for secret-less local-dev
// legacy cookies; signed v2 callers always provide it.
func (r *Repo) CreditConversionForTenantCookieWithIP(ctx context.Context, tenantID, code, expectedReferrerSubscriberID, refereeSubscriberID, refereeIP string) (bool, error) {
	tid, refSubID, err := r.CodeOwnerByAny(ctx, code)
	if err != nil {
		return false, err
	}
	if tid != strings.TrimSpace(tenantID) {
		return false, ErrNotFound
	}
	if expected := strings.TrimSpace(expectedReferrerSubscriberID); expected != "" && refSubID != expected {
		return false, ErrNotFound
	}
	return r.creditConversionForResolvedTenant(ctx, tid, refSubID, refereeSubscriberID, refereeIP)
}

func (r *Repo) creditConversionForResolvedTenant(ctx context.Context, tid, refSubID, refereeSubscriberID, refereeIP string) (bool, error) {
	score, _ := r.computeFraudScore(ctx, tid, refSubID, refereeSubscriberID, refereeIP)
	prog, _ := r.GetActiveProgram(ctx, tid)
	windowDays := 0
	if prog != nil {
		windowDays = clampReferralInt(prog.VerificationWindowDays, 0, 30)
	}
	status := "credited"
	switch {
	case score >= referralFraudThreshold:
		status = "rejected"
	case windowDays > 0:
		status = "pending"
	}
	var pendingUntil any
	var creditedAt any
	switch status {
	case "pending":
		pendingUntil = windowDays
	case "credited":
		creditedAt = time.Now().UTC()
	}
	variant := VariantKeyFor(refSubID)
	tx, txErr := db.WithTenant(ctx, r.Pool, tid)
	if txErr != nil {
		return false, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var refereeExists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM subscribers
     WHERE tenant_id = $1::uuid AND id = $2::uuid
)`, tid, refereeSubscriberID).Scan(&refereeExists); err != nil {
		return false, err
	}
	if !refereeExists {
		return false, ErrNotFound
	}
	tag, txErr := tx.Exec(ctx, `
INSERT INTO referral_conversions (
    tenant_id, referrer_subscriber_id, referee_subscriber_id, referee_ip,
    fraud_score, pending_until, credited_at, credit_status, variant_key
)
VALUES (
    $1::uuid, $2, $3, NULLIF($4, ''), $5,
    CASE WHEN $6::int IS NULL THEN NULL ELSE now() + ($6::int * interval '1 day') END,
    $7, $8, $9
)
ON CONFLICT DO NOTHING`, tid, refSubID, refereeSubscriberID, refereeIP, score,
		pendingUntil, creditedAt, status, variant)
	if txErr != nil {
		return false, txErr
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0 && status == "credited", nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}
