package sms

// SMS quiet hours (GAP-LS-145, desktop audit 2026-06-10 item A7).
//
// Tenant-level labeled time-of-day windows stored in sms_quiet_hours
// (0253 table, evolved by migration 0369). The outbound send gate
// (Store.Gate -> EvaluateGate) consults the enabled windows in their
// IANA timezone; while a window is active the gate blocks with the
// typed "quiet_hours" reason and carries a HoldUntil timestamp so the
// queue worker can defer the message until the window ends instead of
// permanently blocking it once provider dispatch is released. The policy
// decision itself is enforced in the gate today; Route42 does not claim the
// separately release-held provider/budget dispatch saga is available. The
// legacy per-sender metadata quiet_hours
// blob (gate.go QuietHoursActive) keeps working alongside.
//
// Window semantics (shared with migration 0369):
//   - start_minute/end_minute are minutes-of-day [0,1439] local to
//     the rule's timezone.
//   - days lists the local weekdays (0=Sunday..6=Saturday) the window
//     STARTS on; an overnight window (start > end) started on a listed
//     day stays active past midnight into the next day.
//   - start == end means the window covers the whole listed day
//     (mirrors the legacy gate.go semantics).

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	minutesPerDay           = 24 * 60
	smsQuietHoursMaxRows    = 256
	smsPolicyBodyMaxBytes   = 32 << 10
	smsKeywordPolicyMaxRows = 512
)

var (
	ErrSMSPolicyInventoryFull     = errors.New("SMS policy inventory limit reached")
	ErrSMSPolicyConcurrentChange  = errors.New("SMS policy changed concurrently")
	ErrSMSPolicyExpectedVersion   = errors.New("SMS policy expected version is required")
	ErrSMSKeywordResponseExists   = errors.New("SMS keyword response already exists")
	errSMSQuietCountryScopeHeld   = errors.New("country_code scoping is unavailable without authoritative recipient-country evidence; a historical scoped rule must be atomically disabled and cleared")
	errSMSPolicyInventoryTooLarge = errors.New("SMS policy inventory exceeds the complete-list contract")
)

// QuietHoursRule mirrors an sms_quiet_hours row.
//
// start_local/end_local ("HH:MM") are derived projections of
// start_minute/end_minute kept in the JSON for the desktop's older
// Wave-3 scaffold, which coded against the 0253 time columns.
type QuietHoursRule struct {
	ID          string    `json:"id"`
	TenantID    string    `json:"tenant_id,omitempty"`
	Label       string    `json:"label"`
	CountryCode string    `json:"country_code"`
	StartMinute int       `json:"start_minute"`
	EndMinute   int       `json:"end_minute"`
	StartLocal  string    `json:"start_local"`
	EndLocal    string    `json:"end_local"`
	Days        []int     `json:"days"`
	Timezone    string    `json:"timezone"`
	Enabled     bool      `json:"enabled"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// QuietHoursInput is the POST/PATCH body. Pointer fields distinguish
// "not sent" from zero values so PATCH only touches supplied fields.
// start/end accept either the minute-of-day ints or "HH:MM" strings
// (the latter for compatibility with the desktop scaffold).
type QuietHoursInput struct {
	Label       *string `json:"label"`
	CountryCode *string `json:"country_code"`
	StartMinute *int    `json:"start_minute"`
	EndMinute   *int    `json:"end_minute"`
	StartLocal  *string `json:"start_local"`
	EndLocal    *string `json:"end_local"`
	Days        *[]int  `json:"days"`
	Timezone    *string `json:"timezone"`
	Enabled     *bool   `json:"enabled"`
}

// QuietHoursPatchInput deliberately keeps the client-observed row version in
// the PATCH body. Fetching the current row inside the handler is necessary to
// overlay partial fields, but that fresh read must never become the write
// precondition: doing so lets a stale editor overwrite a completed update.
type QuietHoursPatchInput struct {
	QuietHoursInput
	ExpectedUpdatedAt *string `json:"expected_updated_at"`
}

// smsPolicyDeleteInput makes a destructive policy receipt conditional on the
// exact row the operator reviewed. DELETE request bodies are bounded and
// decoded with the same strict JSON rules as PATCH bodies.
type smsPolicyDeleteInput struct {
	ExpectedUpdatedAt *string `json:"expected_updated_at"`
}

func parseSMSPolicyExpectedUpdatedAt(raw *string) (time.Time, error) {
	if raw == nil || *raw == "" || len(*raw) > 64 || strings.TrimSpace(*raw) != *raw {
		return time.Time{}, ErrSMSPolicyExpectedVersion
	}
	parsed, err := time.Parse(time.RFC3339Nano, *raw)
	if err != nil || !validProjectionTime(parsed) {
		return time.Time{}, ErrSMSPolicyExpectedVersion
	}
	return parsed, nil
}

func quietHoursInputHasChanges(in QuietHoursInput) bool {
	return in.Label != nil || in.CountryCode != nil || in.StartMinute != nil ||
		in.EndMinute != nil || in.StartLocal != nil || in.EndLocal != nil ||
		in.Days != nil || in.Timezone != nil || in.Enabled != nil
}

// validateQuietHoursPatchMutation preserves the reconciliation boundary for
// historical country-scoped rows. Any transition from a scoped row to an
// enabled row would silently create an enabled tenant-global rule; the client
// must explicitly disable and clear it in the same CAS mutation.
func validateQuietHoursPatchMutation(current QuietHoursRule, in QuietHoursInput) error {
	if current.CountryCode != "" &&
		(in.CountryCode == nil || *in.CountryCode != "" || in.Enabled == nil || *in.Enabled) {
		return errSMSQuietCountryScopeHeld
	}
	return nil
}

func validateQuietHoursReleasedWrite(rule QuietHoursRule) error {
	if rule.CountryCode != "" {
		return errSMSQuietCountryScopeHeld
	}
	return nil
}

func validateQuietHoursStoreTransition(currentCountryCode string, next QuietHoursRule) error {
	if err := validateQuietHoursReleasedWrite(next); err != nil {
		return err
	}
	if currentCountryCode != "" && next.Enabled {
		return errSMSQuietCountryScopeHeld
	}
	return nil
}

func writeSMSPolicyExpectedVersionError(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, errEnv("invalid_expected_updated_at", "expected_updated_at must be the exact RFC3339 updated_at value from the row being changed"))
}

// ---------------------------------------------------------------------
// Window math (pure; unit-tested in quiet_hours_test.go)
// ---------------------------------------------------------------------

// QuietRuleActive reports whether now falls inside the rule's window
// and, when active, the UTC instant the window ends (when sending may
// resume). Malformed enabled rules fail closed; Store.Gate uses the checked
// evaluator below to return the typed quiet_hours_policy_invalid reason.
func QuietRuleActive(now time.Time, rule QuietHoursRule) (bool, time.Time) {
	if !rule.Enabled {
		return false, time.Time{}
	}
	if rule.StartMinute < 0 || rule.StartMinute >= minutesPerDay ||
		rule.EndMinute < 0 || rule.EndMinute >= minutesPerDay || rule.CountryCode != "" {
		return true, time.Time{}
	}
	loc, err := time.LoadLocation(strings.TrimSpace(rule.Timezone))
	if err != nil || strings.TrimSpace(rule.Timezone) == "" {
		return true, time.Time{}
	}
	local := now.In(loc)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	nowUTC := now.UTC()

	windowForStartDate := func(startDate time.Time, startMinute, endDayOffset, endMinute int) (bool, time.Time) {
		start := earliestLocalBoundary(startDate.Year(), startDate.Month(), startDate.Day(), startMinute, loc)
		endDate := startDate.AddDate(0, 0, endDayOffset)
		end := conservativeLocalBoundary(endDate.Year(), endDate.Month(), endDate.Day(), endMinute, loc)
		if start.IsZero() || end.IsZero() || !end.After(start) {
			// An enabled scheduled boundary that cannot be resolved safely is a
			// compliance hold, not permission to send.
			return true, time.Time{}
		}
		if !nowUTC.Before(start) && nowUTC.Before(end) {
			return true, end
		}
		return false, time.Time{}
	}

	switch {
	case rule.StartMinute == rule.EndMinute:
		// Whole-day window on listed days; ends at the next local
		// midnight (re-gated then if the next day is also listed).
		if containsDay(rule.Days, int(today.Weekday())) {
			return windowForStartDate(today, 0, 1, 0)
		}
		return false, time.Time{}
	case rule.StartMinute < rule.EndMinute:
		// Same-day window, e.g. 09:00 -> 17:00. Instant comparison is
		// essential during a fall fold: after the first start occurrence,
		// repeating an earlier wall minute must not reopen sending.
		if containsDay(rule.Days, int(today.Weekday())) {
			return windowForStartDate(today, rule.StartMinute, 0, rule.EndMinute)
		}
		return false, time.Time{}
	default:
		// Overnight window crossing midnight, e.g. 21:00 -> 09:00. Check
		// both possible local start dates as concrete instant intervals.
		for _, startDate := range []time.Time{today.AddDate(0, 0, -1), today} {
			if !containsDay(rule.Days, int(startDate.Weekday())) {
				continue
			}
			if active, end := windowForStartDate(startDate, rule.StartMinute, 1, rule.EndMinute); active {
				return true, end
			}
		}
		return false, time.Time{}
	}
}

// conservativeLocalBoundary resolves a local date/minute without relying on
// time.Date's intentionally unspecified choice around timezone transitions.
// A repeated wall minute resolves to its latest occurrence so a fall-back fold
// cannot reopen sending during the repeated interval. A nonexistent wall
// minute resolves to the first real local minute after the gap. Returning zero
// is fail-closed: callers keep the quiet-hours block without scheduling an
// unsafe early retry.
func conservativeLocalBoundary(year int, month time.Month, day, minute int, loc *time.Location) time.Time {
	return resolveLocalBoundary(year, month, day, minute, loc, true)
}

func earliestLocalBoundary(year int, month time.Month, day, minute int, loc *time.Location) time.Time {
	return resolveLocalBoundary(year, month, day, minute, loc, false)
}

func resolveLocalBoundary(year int, month time.Month, day, minute int, loc *time.Location, latest bool) time.Time {
	if loc == nil || minute < 0 || minute >= minutesPerDay {
		return time.Time{}
	}
	nominalUTC := time.Date(year, month, day, minute/60, minute%60, 0, 0, time.UTC)
	// Nearby zone offsets generate every exact candidate without a minute-wise
	// scan on the ordinary path. Sampling spans all supported UTC offsets and
	// both sides of any DST transition around this date.
	offsets := map[int]struct{}{}
	for probe := nominalUTC.Add(-36 * time.Hour); !probe.After(nominalUTC.Add(36 * time.Hour)); probe = probe.Add(30 * time.Minute) {
		_, offset := probe.In(loc).Zone()
		offsets[offset] = struct{}{}
	}
	var exact time.Time
	for offset := range offsets {
		candidate := nominalUTC.Add(-time.Duration(offset) * time.Second)
		wall := candidate.In(loc)
		if wall.Year() == year && wall.Month() == month && wall.Day() == day &&
			wall.Hour() == minute/60 && wall.Minute() == minute%60 {
			if exact.IsZero() || (latest && candidate.After(exact)) || (!latest && candidate.Before(exact)) {
				exact = candidate
			}
		}
	}
	if !exact.IsZero() {
		return exact.UTC()
	}

	// No exact candidate means the requested minute lies in a forward gap.
	// Scan real instants across every legal modern UTC offset and choose the
	// first whose local wall clock is after the missing boundary.
	for candidate := nominalUTC.Add(-18 * time.Hour); !candidate.After(nominalUTC.Add(18 * time.Hour)); candidate = candidate.Add(time.Minute) {
		if localWallAfter(candidate.In(loc), year, month, day, minute) {
			return candidate.UTC()
		}
	}
	return time.Time{}
}

func localWallAfter(value time.Time, year int, month time.Month, day, minute int) bool {
	if value.Year() != year {
		return value.Year() > year
	}
	if value.Month() != month {
		return value.Month() > month
	}
	if value.Day() != day {
		return value.Day() > day
	}
	return value.Hour()*60+value.Minute() > minute
}

// EvaluateQuietHours folds all rules: active if any window is active;
// the hold extends to the latest end among the active windows.
func EvaluateQuietHours(now time.Time, rules []QuietHoursRule) (bool, time.Time) {
	active, until, err := EvaluateQuietHoursChecked(now, rules)
	return active || err != nil, until
}

// EvaluateQuietHoursChecked distinguishes a valid active window from malformed
// configured policy so the send gate can return a stable typed block reason.
func EvaluateQuietHoursChecked(now time.Time, rules []QuietHoursRule) (bool, time.Time, error) {
	active := false
	var until time.Time
	for _, rule := range rules {
		if rule.Enabled {
			if rule.CountryCode != "" {
				return false, time.Time{}, fmt.Errorf("enabled quiet-hours rule has unsupported country scoping")
			}
			if rule.StartMinute < 0 || rule.StartMinute >= minutesPerDay ||
				rule.EndMinute < 0 || rule.EndMinute >= minutesPerDay || len(rule.Days) == 0 {
				return false, time.Time{}, fmt.Errorf("enabled quiet-hours rule is malformed")
			}
			for _, day := range rule.Days {
				if day < 0 || day > 6 {
					return false, time.Time{}, fmt.Errorf("enabled quiet-hours rule has an invalid weekday")
				}
			}
			if strings.TrimSpace(rule.Timezone) == "" {
				return false, time.Time{}, fmt.Errorf("enabled quiet-hours rule requires a timezone")
			}
			if _, err := time.LoadLocation(strings.TrimSpace(rule.Timezone)); err != nil {
				return false, time.Time{}, fmt.Errorf("enabled quiet-hours rule timezone is invalid")
			}
		}
		ok, end := QuietRuleActive(now, rule)
		if !ok {
			continue
		}
		active = true
		if end.After(until) {
			until = end
		}
	}
	return active, until, nil
}

func containsDay(days []int, day int) bool {
	for _, d := range days {
		if d == day {
			return true
		}
	}
	return false
}

func minuteLabel(minute int) string {
	return fmt.Sprintf("%02d:%02d", minute/60, minute%60)
}

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

// applyQuietHoursInput overlays in onto rule (rule carries either
// defaults for POST or the stored row for PATCH) and validates the
// result. Errors are operator-safe and rendered as 422.
func applyQuietHoursInput(rule *QuietHoursRule, in QuietHoursInput) error {
	if in.StartMinute != nil && in.StartLocal != nil {
		return fmt.Errorf("provide only one of start_minute or start_local")
	}
	if in.EndMinute != nil && in.EndLocal != nil {
		return fmt.Errorf("provide only one of end_minute or end_local")
	}
	if in.Label != nil {
		rule.Label = strings.TrimSpace(*in.Label)
	}
	if in.CountryCode != nil {
		rule.CountryCode = strings.ToUpper(strings.TrimSpace(*in.CountryCode))
	}
	if in.StartMinute != nil {
		rule.StartMinute = *in.StartMinute
	} else if in.StartLocal != nil {
		m, ok := minuteOfDay(*in.StartLocal)
		if !ok {
			return fmt.Errorf("start_local must use HH:MM 24-hour time")
		}
		rule.StartMinute = m
	}
	if in.EndMinute != nil {
		rule.EndMinute = *in.EndMinute
	} else if in.EndLocal != nil {
		m, ok := minuteOfDay(*in.EndLocal)
		if !ok {
			return fmt.Errorf("end_local must use HH:MM 24-hour time")
		}
		rule.EndMinute = m
	}
	if in.Days != nil {
		rule.Days = normalizeDays(*in.Days)
	}
	if in.Timezone != nil {
		rule.Timezone = strings.TrimSpace(*in.Timezone)
	}
	if in.Enabled != nil {
		rule.Enabled = *in.Enabled
	}

	if rule.StartMinute < 0 || rule.StartMinute >= minutesPerDay {
		return fmt.Errorf("start_minute must be between 0 and 1439")
	}
	if rule.EndMinute < 0 || rule.EndMinute >= minutesPerDay {
		return fmt.Errorf("end_minute must be between 0 and 1439")
	}
	if len(rule.Days) == 0 {
		return fmt.Errorf("days must list at least one weekday (0=Sunday..6=Saturday)")
	}
	for _, d := range rule.Days {
		if d < 0 || d > 6 {
			return fmt.Errorf("days values must be between 0 (Sunday) and 6 (Saturday)")
		}
	}
	if !validInboxText(rule.Label, 512) || len([]rune(rule.Label)) > 128 {
		return fmt.Errorf("label must be at most 128 safe Unicode characters and 512 UTF-8 bytes")
	}
	if rule.CountryCode != "" {
		return errSMSQuietCountryScopeHeld
	}
	rule.Timezone = defaulted(rule.Timezone, "UTC")
	if strings.TrimSpace(rule.Timezone) != rule.Timezone || !validInboxText(rule.Timezone, 512) || len([]rune(rule.Timezone)) > 128 {
		return fmt.Errorf("timezone must be a bounded safe IANA zone name")
	}
	if _, err := time.LoadLocation(rule.Timezone); err != nil {
		return fmt.Errorf("timezone must be a valid IANA zone name")
	}
	rule.StartLocal = minuteLabel(rule.StartMinute)
	rule.EndLocal = minuteLabel(rule.EndMinute)
	return nil
}

func normalizeDays(days []int) []int {
	seen := map[int]bool{}
	out := make([]int, 0, len(days))
	for _, d := range days {
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	sort.Ints(out)
	return out
}

func defaultQuietHoursRule() QuietHoursRule {
	return QuietHoursRule{
		// Match the 0253 column defaults: 21:00 -> 09:00, all days.
		StartMinute: 21 * 60,
		EndMinute:   9 * 60,
		Days:        []int{0, 1, 2, 3, 4, 5, 6},
		Timezone:    "UTC",
		Enabled:     true,
	}
}

// ---------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------

const quietHoursReturning = `
	RETURNING id::text, tenant_id::text, label, country_code,
	          start_minute, end_minute, days, timezone, enabled,
	          created_at, updated_at`

func (s *Store) ListQuietHours(ctx context.Context, tenantID string) ([]QuietHoursRule, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return nil, errInvalidPrivateSMSTenant
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := quietHoursRulesTx(ctx, tx, tenantID, false)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func quietHoursRulesTx(ctx context.Context, tx pgx.Tx, tenantID string, enabledOnly bool) ([]QuietHoursRule, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, label, country_code,
		       start_minute, end_minute, days, timezone, enabled,
		       created_at, updated_at
		  FROM sms_quiet_hours
		 WHERE tenant_id = $1::uuid
		   AND ($2 = false OR enabled)
		 ORDER BY created_at ASC, id ASC
		 LIMIT $3`, tenantID, enabledOnly, smsQuietHoursMaxRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QuietHoursRule{}
	for rows.Next() {
		rule, err := scanQuietHoursRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rule)
		if len(out) > smsQuietHoursMaxRows {
			return nil, errSMSPolicyInventoryTooLarge
		}
	}
	return out, rows.Err()
}

func (s *Store) CreateQuietHours(ctx context.Context, tenantID string, rule QuietHoursRule, auditMeta db.AuditMeta) (QuietHoursRule, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return QuietHoursRule{}, errInvalidPrivateSMSTenant
	}
	if err := validateQuietHoursReleasedWrite(rule); err != nil {
		return QuietHoursRule{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return QuietHoursRule{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenantID+"|sms_quiet_hours_inventory"); err != nil {
		return QuietHoursRule{}, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*)::int FROM sms_quiet_hours WHERE tenant_id = $1::uuid`, tenantID).Scan(&count); err != nil {
		return QuietHoursRule{}, err
	}
	if count >= smsQuietHoursMaxRows {
		return QuietHoursRule{}, ErrSMSPolicyInventoryFull
	}
	row := tx.QueryRow(ctx, `
		INSERT INTO sms_quiet_hours (
			tenant_id, label, country_code, start_local, end_local,
			days, timezone, enabled
		) VALUES (
			$1::uuid, $2, $3,
			make_time($4::int / 60, $4::int % 60, 0),
			make_time($5::int / 60, $5::int % 60, 0),
			$6::int[], $7, $8
		)`+quietHoursReturning,
		tenantID, rule.Label, rule.CountryCode, rule.StartMinute, rule.EndMinute,
		rule.Days, rule.Timezone, rule.Enabled)
	out, err := scanQuietHoursRule(row)
	if err != nil {
		return QuietHoursRule{}, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "sms.quiet_hours.create", "sms_quiet_hours", out.ID, map[string]any{
		"route_template": "/api/v1/sms/quiet-hours",
		"enabled":        out.Enabled,
	}); err != nil {
		return QuietHoursRule{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) GetQuietHours(ctx context.Context, tenantID, id string) (QuietHoursRule, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return QuietHoursRule{}, errInvalidPrivateSMSTenant
	}
	if !validCanonicalUUIDV4(id) {
		return QuietHoursRule{}, pgx.ErrNoRows
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return QuietHoursRule{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, label, country_code,
		       start_minute, end_minute, days, timezone, enabled,
		       created_at, updated_at
		  FROM sms_quiet_hours
		 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanQuietHoursRule(row)
	if err != nil {
		return QuietHoursRule{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) UpdateQuietHours(ctx context.Context, tenantID string, rule QuietHoursRule, expectedUpdatedAt time.Time, auditMeta db.AuditMeta) (QuietHoursRule, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return QuietHoursRule{}, errInvalidPrivateSMSTenant
	}
	if !validCanonicalUUIDV4(rule.ID) {
		return QuietHoursRule{}, pgx.ErrNoRows
	}
	if !validProjectionTime(expectedUpdatedAt) {
		return QuietHoursRule{}, ErrSMSPolicyExpectedVersion
	}
	if err := validateQuietHoursReleasedWrite(rule); err != nil {
		return QuietHoursRule{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return QuietHoursRule{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentCountryCode string
	var currentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
		SELECT country_code, updated_at
		  FROM sms_quiet_hours
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
		 FOR UPDATE`, tenantID, rule.ID).Scan(&currentCountryCode, &currentUpdatedAt); err != nil {
		return QuietHoursRule{}, err
	}
	if !currentUpdatedAt.Equal(expectedUpdatedAt) {
		return QuietHoursRule{}, ErrSMSPolicyConcurrentChange
	}
	if err := validateQuietHoursStoreTransition(currentCountryCode, rule); err != nil {
		return QuietHoursRule{}, err
	}
	row := tx.QueryRow(ctx, `
		UPDATE sms_quiet_hours
		   SET label = $3,
		       country_code = $4,
		       start_local = make_time($5::int / 60, $5::int % 60, 0),
		       end_local = make_time($6::int / 60, $6::int % 60, 0),
		       days = $7::int[],
		       timezone = $8,
		       enabled = $9,
		       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
		 WHERE tenant_id = $1::uuid AND id = $2::uuid AND updated_at = $10`+quietHoursReturning,
		tenantID, rule.ID, rule.Label, rule.CountryCode, rule.StartMinute,
		rule.EndMinute, rule.Days, rule.Timezone, rule.Enabled, expectedUpdatedAt)
	out, err := scanQuietHoursRule(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if existsErr := tx.QueryRow(ctx, `SELECT EXISTS (
				SELECT 1 FROM sms_quiet_hours WHERE tenant_id = $1::uuid AND id = $2::uuid
			)`, tenantID, rule.ID).Scan(&exists); existsErr != nil {
				return QuietHoursRule{}, existsErr
			}
			if exists {
				return QuietHoursRule{}, ErrSMSPolicyConcurrentChange
			}
		}
		return QuietHoursRule{}, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "sms.quiet_hours.update", "sms_quiet_hours", out.ID, map[string]any{
		"route_template": "/api/v1/sms/quiet-hours/{id}",
		"enabled":        out.Enabled,
	}); err != nil {
		return QuietHoursRule{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) DeleteQuietHours(ctx context.Context, tenantID, id string, expectedUpdatedAt time.Time, auditMeta db.AuditMeta) (bool, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return false, errInvalidPrivateSMSTenant
	}
	if !validCanonicalUUIDV4(id) {
		return false, nil
	}
	if !validProjectionTime(expectedUpdatedAt) {
		return false, ErrSMSPolicyExpectedVersion
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var deletedID string
	err = tx.QueryRow(ctx, `
		DELETE FROM sms_quiet_hours
		 WHERE tenant_id = $1::uuid AND id = $2::uuid AND updated_at = $3
		 RETURNING id::text`, tenantID, id, expectedUpdatedAt).Scan(&deletedID)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if existsErr := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM sms_quiet_hours WHERE tenant_id = $1::uuid AND id = $2::uuid
		)`, tenantID, id).Scan(&exists); existsErr != nil {
			return false, existsErr
		}
		if exists {
			return false, ErrSMSPolicyConcurrentChange
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return false, commitErr
		}
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "sms.quiet_hours.delete", "sms_quiet_hours", deletedID, map[string]any{
		"route_template": "/api/v1/sms/quiet-hours/{id}",
	}); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func scanQuietHoursRule(row pgx.Row) (QuietHoursRule, error) {
	var rule QuietHoursRule
	var days []int32
	if err := row.Scan(
		&rule.ID, &rule.TenantID, &rule.Label, &rule.CountryCode,
		&rule.StartMinute, &rule.EndMinute, &days, &rule.Timezone,
		&rule.Enabled, &rule.CreatedAt, &rule.UpdatedAt,
	); err != nil {
		return QuietHoursRule{}, err
	}
	rule.Days = make([]int, 0, len(days))
	for _, d := range days {
		rule.Days = append(rule.Days, int(d))
	}
	rule.StartLocal = minuteLabel(rule.StartMinute)
	rule.EndLocal = minuteLabel(rule.EndMinute)
	if !validQuietHoursProjection(rule) {
		return QuietHoursRule{}, errSMSProjectionOutsideContract
	}
	return rule, nil
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

func (d *Deps) ListQuietHours(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	out, err := d.store().ListQuietHours(r.Context(), tenant.ID)
	if err != nil {
		if errors.Is(err, errSMSPolicyInventoryTooLarge) {
			writeJSON(w, http.StatusServiceUnavailable, errEnv("policy_inventory_unavailable", "the complete quiet-hours inventory is unavailable"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.quiet_hours.list", "/api/v1/sms/quiet-hours", len(out), time.Now().UTC(), false); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenantId": tenant.ID, "items": out})
}

func (d *Deps) CreateQuietHours(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	var in QuietHoursInput
	if err := httpbody.DecodeJSON(w, r, smsPolicyBodyMaxBytes, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	rule := defaultQuietHoursRule()
	if err := applyQuietHoursInput(&rule, in); err != nil {
		if errors.Is(err, errSMSQuietCountryScopeHeld) {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("country_scope_release_held", err.Error()))
			return
		}
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	out, err := d.store().CreateQuietHours(r.Context(), tenant.ID, rule, middleware.AuditMetaFromRequest(r))
	if err != nil {
		if errors.Is(err, errSMSQuietCountryScopeHeld) {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("country_scope_release_held", err.Error()))
			return
		}
		if errors.Is(err, ErrSMSPolicyInventoryFull) {
			writeJSON(w, http.StatusConflict, errEnv("policy_inventory_full", "the quiet-hours policy limit has been reached"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) UpdateQuietHours(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUIDV4(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_quiet_hours_id", "id must be a canonical lowercase UUIDv4"))
		return
	}
	var patch QuietHoursPatchInput
	if err := httpbody.DecodeJSON(w, r, smsPolicyBodyMaxBytes, &patch); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	expectedUpdatedAt, err := parseSMSPolicyExpectedUpdatedAt(patch.ExpectedUpdatedAt)
	if err != nil {
		writeSMSPolicyExpectedVersionError(w)
		return
	}
	if !quietHoursInputHasChanges(patch.QuietHoursInput) {
		writeJSON(w, http.StatusBadRequest, errEnv("empty_patch", "PATCH must change at least one quiet-hours field"))
		return
	}
	rule, err := d.store().GetQuietHours(r.Context(), tenant.ID, id)
	if isNoRows(err) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "quiet hours window not found"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := validateQuietHoursPatchMutation(rule, patch.QuietHoursInput); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("country_scope_release_held", err.Error()))
		return
	}
	if err := applyQuietHoursInput(&rule, patch.QuietHoursInput); err != nil {
		if errors.Is(err, errSMSQuietCountryScopeHeld) {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("country_scope_release_held", err.Error()))
			return
		}
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	out, err := d.store().UpdateQuietHours(r.Context(), tenant.ID, rule, expectedUpdatedAt, middleware.AuditMetaFromRequest(r))
	if isNoRows(err) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "quiet hours window not found"))
		return
	}
	if err != nil {
		if errors.Is(err, errSMSQuietCountryScopeHeld) {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("country_scope_release_held", err.Error()))
			return
		}
		if errors.Is(err, ErrSMSPolicyConcurrentChange) {
			writeJSON(w, http.StatusConflict, errEnv("policy_changed", "the quiet-hours policy changed; reload and retry"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteQuietHours(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUIDV4(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_quiet_hours_id", "id must be a canonical lowercase UUIDv4"))
		return
	}
	var in smsPolicyDeleteInput
	if err := httpbody.DecodeJSON(w, r, smsPolicyBodyMaxBytes, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	expectedUpdatedAt, err := parseSMSPolicyExpectedUpdatedAt(in.ExpectedUpdatedAt)
	if err != nil {
		writeSMSPolicyExpectedVersionError(w)
		return
	}
	deleted, err := d.store().DeleteQuietHours(r.Context(), tenant.ID, id, expectedUpdatedAt, middleware.AuditMetaFromRequest(r))
	if err != nil {
		if errors.Is(err, ErrSMSPolicyConcurrentChange) {
			writeJSON(w, http.StatusConflict, errEnv("policy_changed", "the quiet-hours policy changed; reload and retry"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "quiet hours window not found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"tenantId": tenant.ID,
		"id":       id,
	})
}
