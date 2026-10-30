// Package sendingsettings owns the per-tenant sending throttle and quiet
// hours surface. The send loop guard in apps/api/internal/campaigns
// consults these values before each batch.
package sendingsettings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
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
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// Settings is the per-tenant row.
type Settings struct {
	TenantID               string `json:"tenant_id"`
	MaxSendsPerHour        *int   `json:"max_sends_per_hour,omitempty"`
	QuietHoursStart        string `json:"quiet_hours_start,omitempty"`
	QuietHoursEnd          string `json:"quiet_hours_end,omitempty"`
	QuietHoursTZ           string `json:"quiet_hours_tz,omitempty"`
	QuietHoursPerRecipient bool   `json:"quiet_hours_per_recipient"`
	// Deprecated: FallbackHourUTC is a legacy compatibility value. The active
	// send-time-optimization runtime reads tenant_send_settings, not this table,
	// so this value is non-operational. PUT preserves it when the JSON field is
	// omitted and clears it only when the caller sends an explicit null.
	FallbackHourUTC *int `json:"fallback_hour_utc,omitempty"`
	// UpdatedByUserID identifies the user responsible for the latest canonical
	// mutation when one exists. System-owned automatic throttle changes set it
	// to nil rather than retaining a stale human attribution.
	UpdatedByUserID *string   `json:"updated_by_user_id,omitempty"`
	UpdatedAt       time.Time `json:"updated_at"`
	// IPPool is a read-only projection of the tenant's sending-IP
	// pool, derived from dedicated_ip_assignments (migration 0114).
	// Populated on GET only; PUT ignores it (the pool is provisioned
	// by the platform, not edited through this surface). Omitted when
	// the resolver is unavailable so the UI keeps an honest "unknown"
	// state instead of a fabricated "shared".
	IPPool *IPPool `json:"ip_pool,omitempty"`
}

// IPPool is the wire shape of the tenant's sending-IP pool (desktop
// gap A25). Name is the pool label ("shared" for the platform pool,
// otherwise the dedicated_ip_assignments.pool value).
type IPPool struct {
	Name      string `json:"name"`
	Dedicated bool   `json:"dedicated"`
}

// IPAssignmentLister is the narrow slice of
// sending.DedicatedIPRepo this package consumes to derive the pool
// projection. Interface so tests can fake without a DB.
type IPAssignmentLister interface {
	ListActiveForTenant(ctx context.Context, tenantID string) ([]sending.Assignment, error)
}

// settingsStore keeps HTTP tests independent of Postgres and makes the route's
// read/write contract explicit.
type settingsStore interface {
	Get(ctx context.Context, tenantID string) (*Settings, error)
	Upsert(ctx context.Context, settings Settings, opts UpsertOptions) (*Settings, sending.CapChangeLease, error)
	CapMutationCommitted(ctx context.Context, tenantID, token string) (bool, error)
}

// CapChangeCoordinator brackets the durable settings transaction with the
// shared sending-cap mutation fence. A local cache eviction is insufficient:
// every replica must observe a conservative cap before the commit and the
// canonical cap afterward.
type CapChangeCoordinator interface {
	BeginCapChangeLocked(ctx context.Context, tx pgx.Tx, tenantID string, durable, target *int) (sending.CapChangeLease, error)
	CommitCapChange(ctx context.Context, lease sending.CapChangeLease, committed *int) error
	AbortCapChange(ctx context.Context, lease sending.CapChangeLease) error
	InspectCapCoordination(ctx context.Context, tenantID string) (sending.CapCoordinationStatus, error)
}

var _ CapChangeCoordinator = (*sending.TieredRateLimiter)(nil)

// Repo wraps tenant_sending_settings.
type Repo struct {
	Pool *db.Pool
}

const MaxSendsPerHour = 1_000_000

var (
	// ErrNotFound is returned when a tenant has no row yet.
	ErrNotFound = errors.New("sendingsettings: not found")
	// ErrRevisionConflict is returned when the optional expected_updated_at
	// compare-and-set precondition no longer matches the durable row.
	ErrRevisionConflict = errors.New("sendingsettings: revision conflict")
	// ErrCommitAmbiguous means PostgreSQL returned an error from COMMIT after
	// the mutation was sent. The caller must reconcile the exact candidate and
	// prior revisions before making any committed/not-committed claim.
	ErrCommitAmbiguous = errors.New("sendingsettings: commit outcome ambiguous")
	// ErrDeliverabilityThrottleActive prevents a settings write from replacing
	// the cap owned by an open Deliverability Hub repair episode. Quiet-hours
	// updates that preserve the exact installed cap remain valid.
	ErrDeliverabilityThrottleActive = errors.New("sendingsettings: sending cap is managed by an active deliverability repair")
	// ErrInvalidMaxSends prevents non-HTTP callers from bypassing the same
	// guardrail enforced at the route boundary.
	ErrInvalidMaxSends = errors.New("sendingsettings: max_sends_per_hour must be between 1 and 1000000")
)

// Get returns the row for tenant; ErrNotFound if absent.
func (r *Repo) Get(ctx context.Context, tenantID string) (*Settings, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const q = `
SELECT tenant_id::text, max_sends_per_hour,
       COALESCE(quiet_hours_start,''), COALESCE(quiet_hours_end,''),
       COALESCE(quiet_hours_tz,''), COALESCE(quiet_hours_per_recipient, true),
       fallback_hour_utc,
       updated_by_user_id::text,
       updated_at
FROM tenant_sending_settings WHERE tenant_id = $1::uuid`
	var s Settings
	err = tx.QueryRow(ctx, q, tenantID).Scan(&s.TenantID, &s.MaxSendsPerHour,
		&s.QuietHoursStart, &s.QuietHoursEnd, &s.QuietHoursTZ,
		&s.QuietHoursPerRecipient, &s.FallbackHourUTC, &s.UpdatedByUserID,
		&s.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// writePrecondition is the repository form of expected_updated_at. Supplied
// with Expected=nil means "the row must not exist"; a non-nil timestamp means
// "the row must still have exactly this revision". The zero value keeps the
// backward-compatible unconditional-upsert behavior for older API clients.
type writePrecondition struct {
	Supplied bool
	Expected *time.Time
}

// UpsertOptions carries mutation facts that must not be accepted from the
// public Settings object itself.
type UpsertOptions struct {
	UpdatedByUserID        string
	FallbackHourUTCPresent bool
	Precondition           writePrecondition
	// AuditMeta makes the typed settings audit part of the same transaction as
	// the row mutation. nil is reserved for trusted internal callers/tests.
	AuditMeta *db.AuditMeta
	// CapCoordinator installs the shared fence only after this transaction owns
	// the tenant mutation lock. This lock-before-Begin ordering prevents a lost
	// Redis key from being rehydrated with an old cap ahead of a waiting writer.
	CapCoordinator CapChangeCoordinator
}

type commitAmbiguousError struct {
	Before    *Settings
	Candidate *Settings
	Cause     error
}

func (e *commitAmbiguousError) Error() string {
	return fmt.Sprintf("%v: %v", ErrCommitAmbiguous, e.Cause)
}

func (e *commitAmbiguousError) Unwrap() error { return e.Cause }

func (e *commitAmbiguousError) Is(target error) bool { return target == ErrCommitAmbiguous }

// Upsert writes settings for tenant. The per-tenant advisory transaction lock
// serializes first-write races (there is no row to SELECT FOR UPDATE yet), and
// the row lock makes the revision check + audit before/after snapshot atomic.
func (r *Repo) Upsert(ctx context.Context, s Settings, opts UpsertOptions) (*Settings, sending.CapChangeLease, error) {
	var lease sending.CapChangeLease
	if s.MaxSendsPerHour != nil &&
		(*s.MaxSendsPerHour < 1 || *s.MaxSendsPerHour > MaxSendsPerHour) {
		return nil, lease, ErrInvalidMaxSends
	}
	tx, err := db.WithTenantOptions(ctx, r.Pool, s.TenantID, sending.CapMutationTxOptions())
	if err != nil {
		return nil, lease, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := sending.LockCapMutation(ctx, tx, s.TenantID); err != nil {
		return nil, lease, fmt.Errorf("sendingsettings: acquire write lock: %w", err)
	}

	const selectForUpdate = `
SELECT tenant_id::text, max_sends_per_hour,
       COALESCE(quiet_hours_start,''), COALESCE(quiet_hours_end,''),
       COALESCE(quiet_hours_tz,''), COALESCE(quiet_hours_per_recipient, true),
       fallback_hour_utc,
       updated_by_user_id::text,
       updated_at
  FROM tenant_sending_settings
 WHERE tenant_id = $1::uuid
 FOR UPDATE`
	var before *Settings
	var current Settings
	err = tx.QueryRow(ctx, selectForUpdate, s.TenantID).Scan(
		&current.TenantID, &current.MaxSendsPerHour,
		&current.QuietHoursStart, &current.QuietHoursEnd, &current.QuietHoursTZ,
		&current.QuietHoursPerRecipient, &current.FallbackHourUTC,
		&current.UpdatedByUserID, &current.UpdatedAt,
	)
	switch {
	case err == nil:
		before = &current
	case errors.Is(err, pgx.ErrNoRows):
		before = nil
	default:
		return nil, lease, err
	}

	if err := checkWritePrecondition(before, opts.Precondition); err != nil {
		return nil, lease, err
	}
	// An automatic Deliverability Hub override owns the exact cap until its
	// clear transaction restores the captured baseline and closes the linked
	// remediation episode. Letting this endpoint replace that cap strands the
	// active override: clear correctly refuses to overwrite the newer value,
	// while the one-open-override invariant prevents a future repair. The cap
	// advisory lock serializes this check with Hub apply/clear before any Redis
	// fence is opened or durable settings write occurs.
	if before == nil || !sameSendingCap(before, s.MaxSendsPerHour) {
		var activeRepair bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM deliverability_repair_overrides
     WHERE tenant_id = $1::uuid
       AND cleared_at IS NULL
)`, s.TenantID).Scan(&activeRepair); err != nil {
			return nil, lease, fmt.Errorf("sendingsettings: inspect active deliverability repair: %w", err)
		}
		if activeRepair {
			return nil, lease, ErrDeliverabilityThrottleActive
		}
	}
	if opts.CapCoordinator == nil {
		return nil, lease, sending.ErrCapCoordinationUnavailable
	}
	var durableCap *int
	if before != nil {
		durableCap = before.MaxSendsPerHour
	}
	lease, err = opts.CapCoordinator.BeginCapChangeLocked(
		ctx, tx, s.TenantID, durableCap, s.MaxSendsPerHour,
	)
	if err != nil {
		return nil, lease, err
	}

	// A missing legacy field must not clear a value created by an older client.
	// Explicit JSON null arrives as Present=true, Value=nil and does clear it.
	s.FallbackHourUTC = legacyFallbackForWrite(
		s.FallbackHourUTC, before, opts.FallbackHourUTCPresent,
	)

	const insertQ = `
INSERT INTO tenant_sending_settings
  (tenant_id, max_sends_per_hour, quiet_hours_start, quiet_hours_end,
   quiet_hours_tz, quiet_hours_per_recipient, fallback_hour_utc,
   updated_by_user_id, updated_at)
VALUES
  ($1::uuid, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6, $7,
   NULLIF($8,'')::uuid, clock_timestamp())
RETURNING tenant_id::text, max_sends_per_hour,
          COALESCE(quiet_hours_start,''), COALESCE(quiet_hours_end,''),
          COALESCE(quiet_hours_tz,''), COALESCE(quiet_hours_per_recipient, true),
          fallback_hour_utc, updated_by_user_id::text, updated_at`
	const updateQ = `
UPDATE tenant_sending_settings
   SET max_sends_per_hour        = $2,
       quiet_hours_start         = NULLIF($3,''),
       quiet_hours_end           = NULLIF($4,''),
       quiet_hours_tz            = NULLIF($5,''),
       quiet_hours_per_recipient = $6,
       fallback_hour_utc         = $7,
       updated_by_user_id        = COALESCE(NULLIF($8,'')::uuid, updated_by_user_id),
       updated_at                = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE tenant_id = $1::uuid
RETURNING tenant_id::text, max_sends_per_hour,
          COALESCE(quiet_hours_start,''), COALESCE(quiet_hours_end,''),
          COALESCE(quiet_hours_tz,''), COALESCE(quiet_hours_per_recipient, true),
          fallback_hour_utc, updated_by_user_id::text, updated_at`
	var out Settings
	query := insertQ
	if before != nil {
		query = updateQ
	}
	err = tx.QueryRow(ctx, query, s.TenantID, s.MaxSendsPerHour,
		s.QuietHoursStart, s.QuietHoursEnd, s.QuietHoursTZ,
		s.QuietHoursPerRecipient, s.FallbackHourUTC, opts.UpdatedByUserID).Scan(
		&out.TenantID, &out.MaxSendsPerHour,
		&out.QuietHoursStart, &out.QuietHoursEnd, &out.QuietHoursTZ,
		&out.QuietHoursPerRecipient, &out.FallbackHourUTC,
		&out.UpdatedByUserID, &out.UpdatedAt)
	if err != nil {
		return nil, lease, err
	}
	if opts.AuditMeta != nil {
		meta := *opts.AuditMeta
		if meta.TenantID == "" {
			meta.TenantID = s.TenantID
		}
		if meta.TenantID != s.TenantID {
			return nil, lease, errors.New("sendingsettings: audit tenant mismatch")
		}
		if err := db.Audit(ctx, tx, meta,
			"settings.sending.updated", "tenant_sending_settings", s.TenantID,
			map[string]any{
				"before":                       before,
				"after":                        &out,
				"expected_updated_at_supplied": opts.Precondition.Supplied,
				"legacy_fallback_field_sent":   opts.FallbackHourUTCPresent,
			}); err != nil {
			return nil, lease, fmt.Errorf("sendingsettings: write audit: %w", err)
		}
	}
	if err := sending.RecordCapMutationReceipt(ctx, tx, lease, out.MaxSendsPerHour, out.UpdatedAt); err != nil {
		return nil, lease, err
	}
	if err := tx.Commit(ctx); err != nil {
		return &out, lease, &commitAmbiguousError{Before: before, Candidate: &out, Cause: err}
	}
	return &out, lease, nil
}

func sameSendingCap(before *Settings, candidate *int) bool {
	if before == nil {
		return candidate == nil
	}
	if before.MaxSendsPerHour == nil || candidate == nil {
		return before.MaxSendsPerHour == nil && candidate == nil
	}
	return *before.MaxSendsPerHour == *candidate
}

// CapMutationCommitted reads the dedicated exact receipt written in the same
// transaction as the settings row. It is the authority for classifying a
// network/error return from COMMIT; inferring from a later row snapshot would
// be vulnerable to a subsequent writer.
func (r *Repo) CapMutationCommitted(ctx context.Context, tenantID, token string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, errors.New("sendingsettings: cap mutation receipt lookup is unavailable")
	}
	return sending.CapMutationCommitted(ctx, r.Pool, tenantID, token)
}

func checkWritePrecondition(before *Settings, precondition writePrecondition) error {
	if !precondition.Supplied {
		return nil
	}
	if precondition.Expected == nil {
		if before != nil {
			return ErrRevisionConflict
		}
		return nil
	}
	if before == nil || !before.UpdatedAt.Equal(*precondition.Expected) {
		return ErrRevisionConflict
	}
	return nil
}

func legacyFallbackForWrite(input *int, before *Settings, present bool) *int {
	if present || before == nil {
		return input
	}
	return before.FallbackHourUTC
}

// CapResolver bridges the repo to the rate limiter's CapResolver shape.
func (r *Repo) CapResolver(ctx context.Context, tenantID string) (int, bool, error) {
	s, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return 0, false, nil
		}
		return 0, false, err
	}
	if s.MaxSendsPerHour == nil || *s.MaxSendsPerHour <= 0 {
		return 0, false, nil
	}
	return *s.MaxSendsPerHour, true, nil
}

// Deps mounts the settings HTTP surface.
type Deps struct {
	Repo settingsStore
	// IPs resolves the tenant's dedicated-IP assignments for the
	// read-only ip_pool projection on GET (desktop gap A25). Wire
	// &sending.DedicatedIPRepo{Pool: pool} in main.go. Optional: nil
	// omits ip_pool from the response (honest "unknown" instead of a
	// fabricated "shared").
	IPs IPAssignmentLister
	// CapCache is the production TieredRateLimiter's shared mutation
	// coordinator. The historical field name is retained for composition
	// compatibility; this is no longer a process-local cache invalidator.
	CapCache CapChangeCoordinator
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// ipPoolFromAssignments derives the wire-shape pool projection from
// the tenant's ACTIVE dedicated-IP assignments. No assignments → the
// platform shared pool. One or more → dedicated, labeled with the
// first assignment's pool value ("dedicated" when the row predates
// pool labels). Pure function so tests cover it without a DB.
func ipPoolFromAssignments(assignments []sending.Assignment) *IPPool {
	if len(assignments) == 0 {
		return &IPPool{Name: "shared", Dedicated: false}
	}
	name := assignments[0].Pool
	if name == "" {
		name = "dedicated"
	}
	return &IPPool{Name: name, Dedicated: true}
}

// resolveIPPool runs the lister and folds failures into nil (omit the
// field) so a dedicated-IP read problem never breaks the core
// sending-settings GET. The error is logged — silently eating it would
// hide a real outage behind a permanently "unknown" pool.
func (d *Deps) resolveIPPool(ctx context.Context, tenantID string) *IPPool {
	if d.IPs == nil {
		return nil
	}
	assignments, err := d.IPs.ListActiveForTenant(ctx, tenantID)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("sendingsettings: ip-pool resolve failed",
				"tenant_id", tenantID, "err", err)
		}
		return nil
	}
	return ipPoolFromAssignments(assignments)
}

const (
	sendingSettingsJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB
	maxSendingTimeZoneLength              = 128
)

// MountRoutes wires GET/PUT /api/v1/settings/sending plus the live
// status endpoint used by the admin UI to render the rate-limit meter
// and quiet-hours indicator. The complete surface is admin-only: reads expose
// tenant-wide delivery policy and infrastructure context, while writes can
// silently halt all outbound mail (audit gap pre-v2).
func (d *Deps) MountRoutes(r chi.Router) {
	admin := apikeys.RequireExactTenantAdmin
	r.With(ProtectResponses, admin).Get("/api/v1/settings/sending", d.Get)
	r.With(ProtectResponses, admin).
		Put("/api/v1/settings/sending", d.Put)
	r.With(ProtectResponses, admin).
		Get("/api/v1/settings/sending/status", d.Status)
}

// ProtectResponses stamps the sending-settings path family before
// authorization, route matching, or handler execution. Mount it at the root
// router as well as the package routes so auth refusals and 404/405 responses
// cannot escape with weaker cache policy.
func ProtectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const base = "/api/v1/settings/sending"
		if r.URL.Path == base || strings.HasPrefix(r.URL.Path, base+"/") {
			protected := &sendingSettingsProtectedResponseWriter{ResponseWriter: w}
			protected.apply()
			next.ServeHTTP(protected, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// MutationGlobalReplayBypass keeps the sending-settings PUT completely out of
// the generalized Idempotency-Key ledger. A 503 can mean the database commit
// succeeded while Redis convergence remains conservatively fenced, or that
// the database commit outcome is still unknown. Caching either response in a
// middleware-owned replay record would let a later automatic retry erase the
// live control outcome. The handler rejects every supplied key explicitly.
// This selector is deliberately path-only and body-independent so bypassing
// happens before the replay middleware reads the request body or store.
func MutationGlobalReplayBypass(r *http.Request, _ []byte) bool {
	return r != nil && r.URL != nil && r.URL.EscapedPath() == "/api/v1/settings/sending"
}

// sendingSettingsProtectedResponseWriter reapplies the tenant-private cache
// boundary at the actual write point. Authentication/authorization middleware
// also writes Cache-Control on refusals; without this wrapper its later header
// mutation can weaken "private, no-store" to merely "no-store".
type sendingSettingsProtectedResponseWriter struct {
	http.ResponseWriter
}

func (w *sendingSettingsProtectedResponseWriter) apply() {
	setNoStore(w.ResponseWriter)
	w.Header().Set("Expires", "0")
}

func (w *sendingSettingsProtectedResponseWriter) WriteHeader(status int) {
	w.apply()
	w.ResponseWriter.WriteHeader(status)
}

func (w *sendingSettingsProtectedResponseWriter) Write(body []byte) (int, error) {
	w.apply()
	return w.ResponseWriter.Write(body)
}

// FlushError is what http.ResponseController calls to flush. A flush commits
// the headers, so the private boundary is stamped first: a flush that reached
// net/http through Unwrap alone would skip it. The underlying writer's answer
// is returned as-is, so this claims no streaming capability it lacks.
func (w *sendingSettingsProtectedResponseWriter) FlushError() error {
	w.apply()
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *sendingSettingsProtectedResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

const (
	sendingCapOutcomeHeader              = "X-Postwave-Sending-Cap-Outcome"
	sendingCapOutcomeNotCommitted        = "not-committed"
	sendingCapOutcomeCommitted           = "committed"
	sendingCapOutcomeCommittedFenced     = "committed-conservatively-fenced"
	sendingCapOutcomeCommitUnknownFenced = "commit-outcome-unknown-conservatively-fenced"
)

func setSendingCapOutcome(w http.ResponseWriter, outcome string) {
	w.Header().Set(sendingCapOutcomeHeader, outcome)
}

// Status is the wire shape for the sending-status endpoint. Counter fields are
// optional and may be presented as live only when CounterAuthoritative is true.
type Status struct {
	/* Cap config (copied from Settings for convenience). */
	TenantID               string `json:"tenant_id"`
	MaxSendsPerHour        *int   `json:"max_sends_per_hour,omitempty"`
	QuietHoursStart        string `json:"quiet_hours_start,omitempty"`
	QuietHoursEnd          string `json:"quiet_hours_end,omitempty"`
	QuietHoursTZ           string `json:"quiet_hours_tz,omitempty"`
	QuietHoursPerRecipient bool   `json:"quiet_hours_per_recipient"`

	// The active counter path does not expose a tenant-safe inspection
	// primitive, so these stay absent instead of relabeling the dormant
	// Postgres bucket as live. Cap authority is inspected separately below.
	BucketCount    *int       `json:"bucket_count,omitempty"`
	WindowStart    *time.Time `json:"window_start,omitempty"`
	WindowResetsAt *time.Time `json:"window_resets_at,omitempty"`
	// CounterAuthoritative gates every counter claim in clients.
	CounterAuthoritative bool   `json:"counter_authoritative"`
	CounterSource        string `json:"counter_source"`
	CounterScope         string `json:"counter_scope"`

	// CapCoordination* is the recovery proof for an outcome-ambiguous PUT.
	// Ready says Redis holds an explicit ready state; MatchesSettings separately
	// proves its explicit capped/uncapped value equals this durable row. Clients
	// must require both before clearing an ambiguous mutation receipt.
	CapCoordinationState           string     `json:"cap_coordination_state"`
	CapCoordinationReady           bool       `json:"cap_coordination_ready"`
	CapCoordinationCap             *int       `json:"cap_coordination_cap,omitempty"`
	CapCoordinationMatchesSettings bool       `json:"cap_coordination_matches_settings"`
	CapCoordinationFenceStartedAt  *time.Time `json:"cap_coordination_fence_started_at,omitempty"`

	/* Computed quiet-hours signal. Empty tz → both fields null. */
	InQuietHours   *bool      `json:"in_quiet_hours,omitempty"`
	QuietChangesAt *time.Time `json:"quiet_changes_at,omitempty"`
}

// Status GET /api/v1/settings/sending/status.
//
// Reads configured settings, computes quiet hours locally, and explicitly
// reports the active counter as unavailable. tenant_send_rate_buckets is the
// legacy limiter's store and is not authoritative for the production
// Redis/LRU TieredRateLimiter.
func (d *Deps) Status(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	s, err := d.Repo.Get(r.Context(), t.ID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if errors.Is(err, ErrNotFound) {
		s = &Settings{TenantID: t.ID, QuietHoursPerRecipient: true}
	}
	status := statusFromSettings(s, time.Now())
	// Bind the wire proof to the authenticated request tenant even if a broken
	// repository implementation returns a malformed tenant field.
	status.TenantID = t.ID
	if d.CapCache != nil {
		inspection, inspectErr := d.CapCache.InspectCapCoordination(r.Context(), t.ID)
		if inspectErr != nil {
			if d.Logger != nil {
				d.Logger.WarnContext(r.Context(), "sending settings cap authority inspection unavailable",
					"tenant_id", t.ID, "err", inspectErr.Error())
			}
		} else {
			applyCapCoordinationStatus(&status, s.MaxSendsPerHour, inspection)
		}
	}
	writeJSON(w, http.StatusOK, status)
}

func statusFromSettings(s *Settings, now time.Time) Status {
	out := Status{
		QuietHoursPerRecipient: true,
		CounterAuthoritative:   false,
		CounterSource:          "unavailable",
		CounterScope:           "unavailable",
		CapCoordinationState:   sending.CapCoordinationStateDown,
	}
	if s == nil {
		return out
	}
	out.TenantID = s.TenantID
	out.MaxSendsPerHour = s.MaxSendsPerHour
	out.QuietHoursStart = s.QuietHoursStart
	out.QuietHoursEnd = s.QuietHoursEnd
	out.QuietHoursTZ = s.QuietHoursTZ
	out.QuietHoursPerRecipient = s.QuietHoursPerRecipient

	// Only a complete legacy row can yield a quiet-hours projection.
	if out.QuietHoursStart != "" && out.QuietHoursEnd != "" && out.QuietHoursTZ != "" {
		inQuiet, changesAt, ok := computeQuietHoursWindow(
			out.QuietHoursStart, out.QuietHoursEnd, out.QuietHoursTZ, now,
		)
		if ok {
			b := inQuiet
			ca := changesAt
			out.InQuietHours = &b
			out.QuietChangesAt = &ca
		}
	}
	return out
}

func applyCapCoordinationStatus(out *Status, durableCap *int, shared sending.CapCoordinationStatus) {
	if out == nil {
		return
	}
	validCapShape := (shared.HasCap && shared.Cap >= 1) || (!shared.HasCap && shared.Cap == 0)
	switch shared.State {
	case sending.CapCoordinationStateReady:
		if !validCapShape || shared.FenceStartedAt != nil {
			shared = sending.CapCoordinationStatus{State: sending.CapCoordinationStateDown}
		}
	case sending.CapCoordinationStateFenced:
		if !validCapShape || shared.FenceStartedAt == nil {
			shared = sending.CapCoordinationStatus{State: sending.CapCoordinationStateDown}
		}
	case sending.CapCoordinationStateDown:
		shared = sending.CapCoordinationStatus{State: sending.CapCoordinationStateDown}
	default:
		shared = sending.CapCoordinationStatus{State: sending.CapCoordinationStateDown}
	}
	out.CapCoordinationState = shared.State
	out.CapCoordinationReady = shared.State == sending.CapCoordinationStateReady
	out.CapCoordinationMatchesSettings = false
	out.CapCoordinationFenceStartedAt = shared.FenceStartedAt
	if shared.HasCap {
		cap := shared.Cap
		out.CapCoordinationCap = &cap
	} else {
		out.CapCoordinationCap = nil
	}
	if !out.CapCoordinationReady {
		return
	}
	if durableCap == nil {
		out.CapCoordinationMatchesSettings = !shared.HasCap
		return
	}
	out.CapCoordinationMatchesSettings = shared.HasCap && *durableCap == shared.Cap
}

// computeQuietHoursWindow returns (in_quiet_hours, next_change_at, ok)
// for the supplied (HH:MM start, HH:MM end, IANA tz) triple at the
// given reference time. ok=false means the inputs are malformed (the
// HH:MM/tz validators should have caught these on PUT, but we guard
// here too so a bad row from a legacy import doesn't 500 the status
// endpoint).
//
// Window semantics:
//
//   - start < end (same-day): quiet hours are [start, end). Outside →
//     change_at is today's start (or tomorrow's start if past today's
//     end).
//   - start > end (overnight, e.g. 22:00–07:00): quiet hours wrap
//     midnight. The window is [start, midnight) ∪ [00:00, end).
//   - start == end is malformed, matching the PUT validator.
//
// Membership intentionally matches sending.decideAllowed: compare the current
// local wall-clock minute with the configured minute range. The next change is
// found by walking real, absolute minutes rather than constructing a possibly
// nonexistent or ambiguous local time with time.Date. This makes spring gaps
// and fall folds deterministic and keeps status aligned with send admission.
func computeQuietHoursWindow(start, end, tz string, now time.Time) (bool, time.Time, bool) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return false, time.Time{}, false
	}
	sh, sm, ok1 := parseHHMM(start)
	eh, em, ok2 := parseHHMM(end)
	if !ok1 || !ok2 {
		return false, time.Time{}, false
	}
	startMinute := sh*60 + sm
	endMinute := eh*60 + em
	if startMinute == endMinute {
		// PUT rejects this shape. Treat a legacy/imported equal-endpoint row as
		// malformed rather than inventing either a zero-length or 24-hour window.
		return false, time.Time{}, false
	}

	contains := func(at time.Time) bool {
		local := at.In(loc)
		minute := local.Hour()*60 + local.Minute()
		if startMinute < endMinute {
			return minute >= startMinute && minute < endMinute
		}
		return minute >= startMinute || minute < endMinute
	}

	inQuiet := contains(now)
	// Search actual elapsed minutes. Eight days comfortably covers ordinary DST
	// gaps/folds, half-hour transitions, and historical whole-date skips while
	// remaining strictly bounded for a malformed timezone database.
	const transitionSearchMinutes = 8 * 24 * 60
	next := now.Truncate(time.Minute).Add(time.Minute)
	for range transitionSearchMinutes {
		if contains(next) != inQuiet {
			return inQuiet, next, true
		}
		next = next.Add(time.Minute)
	}
	return inQuiet, time.Time{}, false
}

var hhmmPattern = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)

// parseHHMM is a strict, anchored HH:MM parser. Returns (hour, minute, ok).
func parseHHMM(s string) (int, int, bool) {
	if !hhmmPattern.MatchString(s) {
		return 0, 0, false
	}
	h := int(s[0]-'0')*10 + int(s[1]-'0')
	m := int(s[3]-'0')*10 + int(s[4]-'0')
	return h, m, true
}

type putInput struct {
	MaxSendsPerHour *int `json:"max_sends_per_hour"`
	// These replacement fields may be omitted for their documented defaults,
	// but JSON null is not a string/boolean and must not silently collapse to
	// the same Go zero value as omission.
	QuietHoursStart        optionalNonNullString `json:"quiet_hours_start"`
	QuietHoursEnd          optionalNonNullString `json:"quiet_hours_end"`
	QuietHoursTZ           optionalNonNullString `json:"quiet_hours_tz"`
	QuietHoursPerRecipient optionalNonNullBool   `json:"quiet_hours_per_recipient"`
	// Deprecated legacy field. Omitted preserves the durable value; explicit
	// null clears it. It is not read by the active STO runtime.
	FallbackHourUTC optionalNullableInt `json:"fallback_hour_utc"`
	// expected_updated_at is an optional compare-and-set token. Empty string
	// asserts first write/no row; RFC3339 asserts the exact current revision.
	ExpectedUpdatedAt optionalNonNullString `json:"expected_updated_at"`
}

// optionalNonNullString distinguishes an omitted property from explicit JSON
// null while still preserving the endpoint's documented omission defaults.
// Null is recorded rather than rejected in UnmarshalJSON so the handler can
// return the field-specific stable error code.
type optionalNonNullString struct {
	Present bool
	Null    bool
	Value   string
}

func (v *optionalNonNullString) UnmarshalJSON(data []byte) error {
	v.Present = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		v.Null = true
		return nil
	}
	return json.Unmarshal(data, &v.Value)
}

type optionalNonNullBool struct {
	Present bool
	Null    bool
	Value   bool
}

func (v *optionalNonNullBool) UnmarshalJSON(data []byte) error {
	v.Present = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		v.Null = true
		return nil
	}
	return json.Unmarshal(data, &v.Value)
}

// optionalNullableInt distinguishes an omitted field from explicit JSON null.
type optionalNullableInt struct {
	Present bool
	Value   *int
}

func (v *optionalNullableInt) UnmarshalJSON(data []byte) error {
	v.Present = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		v.Value = nil
		return nil
	}
	var value int
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	v.Value = &value
	return nil
}

// rejectDuplicateSendingSettingsFields closes the first-key/last-key
// ambiguity left by encoding/json. Intermediaries do not agree which duplicate
// member wins, so accepting one for a compare-and-set token can turn the exact
// revision seen by the API into a different value than the caller signed off.
func rejectDuplicateSendingSettingsFields(body []byte) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	token, err := dec.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return errors.New("sending settings body must be a JSON object")
	}
	seen := make(map[string]struct{}, 7)
	for dec.More() {
		nameToken, err := dec.Token()
		if err != nil {
			return err
		}
		name, ok := nameToken.(string)
		if !ok {
			return errors.New("sending settings field name must be a string")
		}
		if _, exists := seen[name]; exists {
			return errors.New("sending settings body contains a duplicate field")
		}
		seen[name] = struct{}{}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return err
		}
	}
	_, err = dec.Token()
	return err
}

func parseWritePrecondition(raw *string) (writePrecondition, error) {
	if raw == nil {
		return writePrecondition{}, nil
	}
	if *raw == "" {
		return writePrecondition{Supplied: true}, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *raw)
	if err != nil || parsed.IsZero() {
		return writePrecondition{}, errors.New(
			"expected_updated_at must be empty for a first write or an exact non-zero RFC3339 timestamp",
		)
	}
	parsed = parsed.UTC()
	return writePrecondition{Supplied: true, Expected: &parsed}, nil
}

// Get GET /api/v1/settings/sending
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	s, err := d.Repo.Get(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusOK, Settings{
				TenantID:               t.ID,
				QuietHoursPerRecipient: true,
				IPPool:                 d.resolveIPPool(r.Context(), t.ID),
			})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	s.IPPool = d.resolveIPPool(r.Context(), t.ID)
	writeJSON(w, http.StatusOK, s)
}

// rejectPutFieldShape writes the not-committed receipt and a 400 for the first
// shape or range violation in the decoded body (explicit nulls on string/bool
// fields, then the two numeric ranges) and reports whether it did so. Check
// order is part of the API contract and is pinned by tests.
func rejectPutFieldShape(w http.ResponseWriter, in putInput) bool {
	if in.ExpectedUpdatedAt.Null {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.WriteValidation(w, "bad_expected_updated_at",
			"expected_updated_at must be omitted, an empty string, or an exact non-zero RFC3339 timestamp")
		return true
	}
	if in.QuietHoursStart.Null {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.WriteValidation(w, "bad_start", "quiet_hours_start must be a string, not null")
		return true
	}
	if in.QuietHoursEnd.Null {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.WriteValidation(w, "bad_end", "quiet_hours_end must be a string, not null")
		return true
	}
	if in.QuietHoursTZ.Null {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.WriteValidation(w, "bad_tz", "quiet_hours_tz must be a string, not null")
		return true
	}
	if in.QuietHoursPerRecipient.Null {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.WriteValidation(w, "bad_json", "quiet_hours_per_recipient must be a boolean, not null")
		return true
	}
	// Lower-bound + sentinel handling for max_sends_per_hour. Audit
	// found 0 and negative values were silently accepted and stored;
	// 0 then read as no workspace-specific hourly cap by the cap resolver, which is the
	// opposite of operator intent. nil = "no throttle"; >= 1 = a real
	// cap; values outside the exact supported range are rejected.
	if in.MaxSendsPerHour != nil &&
		(*in.MaxSendsPerHour <= 0 || *in.MaxSendsPerHour > MaxSendsPerHour) {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		writeJSON(w, http.StatusBadRequest, errEnv("bad_max_sends",
			"max_sends_per_hour must be between 1 and 1000000, or null for no workspace-specific hourly cap"))
		return true
	}
	// The legacy field remains range-checked for compatibility even though the
	// active STO runtime does not consume it.
	if in.FallbackHourUTC.Value != nil &&
		(*in.FallbackHourUTC.Value < 0 || *in.FallbackHourUTC.Value > 23) {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		writeJSON(w, http.StatusBadRequest, errEnv("bad_fallback_hour",
			"fallback_hour_utc must be between 0 and 23, null, or omitted"))
		return true
	}
	return false
}

// rejectPutQuietHours writes the not-committed receipt and a 400 for the first
// quiet-hours violation (time zone, then start/end format, then window
// coherence) and reports whether it did so.
func rejectPutQuietHours(w http.ResponseWriter, quietHoursStart, quietHoursEnd, quietHoursTZ string) bool {
	if quietHoursTZ != "" {
		// time.LoadLocation accepts "Local" as a process-specific alias, while
		// browser Intl.DateTimeFormat rejects it. Keep the API and desktop on the
		// same portable IANA/UTC contract, and apply the desktop decoder's bound
		// before consulting the host's timezone database.
		if quietHoursTZ == "Local" ||
			utf8.RuneCountInString(quietHoursTZ) > maxSendingTimeZoneLength {
			setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
			httperror.WriteValidation(w, "bad_tz",
				"quiet_hours_tz must be UTC or a valid IANA time zone no longer than 128 characters")
			return true
		}
		if _, err := time.LoadLocation(quietHoursTZ); err != nil {
			// Stdlib time.LoadLocation error text is not in our typed
			// sentinel set — substitute a fixed operator-authored
			// message that quotes the user input so the caller can
			// correct it without leaking stdlib internals.
			setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
			httperror.WriteValidation(w, "bad_tz",
				fmt.Sprintf("unknown IANA time zone %q", quietHoursTZ))
			return true
		}
	}
	if quietHoursStart != "" {
		if err := validateHHMM(quietHoursStart); err != nil {
			// validateHHMM is our own validator with deterministic,
			// operator-safe message text — safe to echo per
			// httperror.WriteValidation contract.
			setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
			httperror.WriteValidation(w, "bad_start", err.Error())
			return true
		}
	}
	if quietHoursEnd != "" {
		if err := validateHHMM(quietHoursEnd); err != nil {
			// Same provenance guarantee as bad_start above.
			setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
			httperror.WriteValidation(w, "bad_end", err.Error())
			return true
		}
	}
	// Quiet-hours coherence: either all three (start/end/tz) are set,
	// or none. A half-configured window silently never fires and is
	// an operator footgun.
	startSet := quietHoursStart != ""
	endSet := quietHoursEnd != ""
	tzSet := quietHoursTZ != ""
	if startSet || endSet || tzSet {
		if !(startSet && endSet && tzSet) {
			setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
			writeJSON(w, http.StatusBadRequest, errEnv("incomplete_quiet_hours",
				"quiet_hours_start, quiet_hours_end, and quiet_hours_tz must all be set, or all be omitted"))
			return true
		}
		if quietHoursStart == quietHoursEnd {
			setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
			writeJSON(w, http.StatusBadRequest, errEnv("equal_quiet_hours",
				"quiet_hours_start and quiet_hours_end must differ"))
			return true
		}
	}
	return false
}

// Put PUT /api/v1/settings/sending
func (d *Deps) Put(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	if len(r.Header.Values("Idempotency-Key")) != 0 {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.Write(
			w,
			http.StatusBadRequest,
			"idempotency_forbidden",
			"Idempotency-Key is forbidden for this cap-control operation; inspect the live outcome before retrying",
		)
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in putInput
	body, err := httpbody.DecodeJSONBytes(
		r, sendingSettingsJSONMaxBodyBytes, &in, httpbody.Options{},
	)
	if err != nil {
		// httpbody returns typed sentinel errors whose text is safe to
		// echo (size limits, malformed JSON markers, etc.) — established
		// codebase pattern.
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := rejectDuplicateSendingSettingsFields(body); err != nil {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.WriteValidation(w, "bad_json", "request body must not contain duplicate fields")
		return
	}
	if rejectPutFieldShape(w, in) {
		return
	}
	quietHoursStart := in.QuietHoursStart.Value
	quietHoursEnd := in.QuietHoursEnd.Value
	quietHoursTZ := in.QuietHoursTZ.Value
	var expectedUpdatedAt *string
	if in.ExpectedUpdatedAt.Present {
		expectedUpdatedAt = &in.ExpectedUpdatedAt.Value
	}
	precondition, err := parseWritePrecondition(expectedUpdatedAt)
	if err != nil {
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		httperror.WriteValidation(w, "bad_expected_updated_at", err.Error())
		return
	}
	if rejectPutQuietHours(w, quietHoursStart, quietHoursEnd, quietHoursTZ) {
		return
	}
	perRecipient := true
	if in.QuietHoursPerRecipient.Present {
		perRecipient = in.QuietHoursPerRecipient.Value
	}
	userID := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		userID = u.ID
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	if d.CapCache == nil {
		w.Header().Set("Retry-After", "1")
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		writeSendingCapControlError(w, "sending_cap_coordination_unavailable",
			"sending-cap coordination is unavailable; settings were not changed")
		return
	}
	mutationCtx, mutationCancel := sending.WithCapMutationDeadline(r.Context())
	defer mutationCancel()
	s, lease, err := d.Repo.Upsert(mutationCtx, Settings{
		TenantID:               t.ID,
		MaxSendsPerHour:        in.MaxSendsPerHour,
		QuietHoursStart:        quietHoursStart,
		QuietHoursEnd:          quietHoursEnd,
		QuietHoursTZ:           quietHoursTZ,
		QuietHoursPerRecipient: perRecipient,
		FallbackHourUTC:        in.FallbackHourUTC.Value,
	}, UpsertOptions{
		UpdatedByUserID:        userID,
		FallbackHourUTCPresent: in.FallbackHourUTC.Present,
		Precondition:           precondition,
		AuditMeta:              &auditMeta,
		CapCoordinator:         d.CapCache,
	})
	if err != nil {
		var ambiguous *commitAmbiguousError
		if errors.As(err, &ambiguous) {
			// The transaction may have committed and BeginCapChangeLocked installed
			// a conservative shared fence. Stamp the unknown outcome before any
			// receipt lookup that can itself fail or panic.
			setSendingCapOutcome(w, sendingCapOutcomeCommitUnknownFenced)
			receiptCtx, receiptCancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
			committed, receiptErr := d.Repo.CapMutationCommitted(receiptCtx, t.ID, lease.Token)
			receiptCancel()
			if receiptErr != nil {
				w.Header().Set("Retry-After", "1")
				setSendingCapOutcome(w, sendingCapOutcomeCommitUnknownFenced)
				writeSendingCapControlError(w, "sending_cap_commit_outcome_unknown",
					"the database commit outcome could not be proven; sends remain conservatively fenced")
				return
			}
			if committed {
				s = ambiguous.Candidate
				// The durable receipt proves commit, but cap convergence is not yet
				// proven. Set the conservative committed receipt before invoking
				// post-commit dependencies so a panic can never become a false
				// not-committed response.
				setSendingCapOutcome(w, sendingCapOutcomeCommittedFenced)
				finishCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
				finishErr := d.CapCache.CommitCapChange(finishCtx, lease, s.MaxSendsPerHour)
				cancel()
				if finishErr == nil {
					setSendingCapOutcome(w, sendingCapOutcomeCommitted)
					s.IPPool = d.resolveIPPool(r.Context(), t.ID)
					writeJSON(w, http.StatusOK, s)
					return
				}
				w.Header().Set("Retry-After", "1")
				setSendingCapOutcome(w, sendingCapOutcomeCommittedFenced)
				writeSendingCapControlError(w, "sending_cap_convergence_pending",
					"settings were committed, but sending-cap convergence could not be confirmed; sends remain conservatively fenced")
				return
			}
			// A readable absent receipt proves the transaction, including its
			// settings row and audit evidence, did not commit.
			setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			abortErr := d.CapCache.AbortCapChange(cleanupCtx, lease)
			cancel()
			if abortErr != nil && d.Logger != nil {
				d.Logger.ErrorContext(r.Context(), "sending settings cap fence abort failed",
					"tenant_id", t.ID, "err", abortErr.Error())
			}
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}

		// Every non-ambiguous repository error returns before COMMIT or from a
		// branch whose transaction is rolled back. This is the first point where
		// a definite negative receipt is justified.
		setSendingCapOutcome(w, sendingCapOutcomeNotCommitted)
		if errors.Is(err, ErrRevisionConflict) {
			httperror.Write(w, http.StatusConflict, "settings_revision_conflict",
				"sending settings changed after this view loaded; reload before saving")
			return
		}
		if errors.Is(err, ErrDeliverabilityThrottleActive) {
			httperror.Write(w, http.StatusConflict, "deliverability_throttle_active",
				"the sending cap is managed by an active deliverability repair; clear the repair override before changing max_sends_per_hour")
			return
		}
		if errors.Is(err, sending.ErrCapChangeInProgress) {
			w.Header().Set("Retry-After", "1")
			httperror.Write(w, http.StatusConflict, "sending_cap_change_in_progress",
				"another sending-cap change is in progress; retry after it completes")
			return
		}
		if lease.Token != "" {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			abortErr := d.CapCache.AbortCapChange(cleanupCtx, lease)
			cancel()
			if abortErr != nil && d.Logger != nil {
				d.Logger.ErrorContext(r.Context(), "sending settings cap fence abort failed",
					"tenant_id", t.ID, "err", abortErr.Error())
			}
		}
		if errors.Is(err, sending.ErrCapCoordinationUnavailable) && lease.Token == "" {
			w.Header().Set("Retry-After", "1")
			writeSendingCapControlError(w, "sending_cap_coordination_unavailable",
				"sending-cap coordination is unavailable; settings were not changed")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Repo.Upsert returning success proves the database commit, while the shared
	// cap still needs its post-commit convergence step. Establish that receipt
	// before invoking any dependency that can panic or fail.
	setSendingCapOutcome(w, sendingCapOutcomeCommittedFenced)
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	finishErr := d.CapCache.CommitCapChange(finishCtx, lease, s.MaxSendsPerHour)
	cancel()
	if finishErr != nil {
		if d.Logger != nil {
			d.Logger.ErrorContext(r.Context(), "sending settings cap convergence unconfirmed",
				"tenant_id", t.ID, "err", finishErr.Error())
		}
		w.Header().Set("Retry-After", "1")
		setSendingCapOutcome(w, sendingCapOutcomeCommittedFenced)
		writeSendingCapControlError(w, "sending_cap_convergence_pending",
			"settings were committed, but sending-cap convergence could not be confirmed; sends remain conservatively fenced")
		return
	}
	setSendingCapOutcome(w, sendingCapOutcomeCommitted)
	s.IPPool = d.resolveIPPool(r.Context(), t.ID)
	writeJSON(w, http.StatusOK, s)
}

func validateHHMM(s string) error {
	if !hhmmPattern.MatchString(s) {
		return fmt.Errorf("expected HH:MM from 00:00 through 23:59, got %q", s)
	}
	return nil
}

func setNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]interface{} {
	return map[string]interface{}{"error": map[string]string{"code": code, "message": msg}}
}

// writeSendingCapControlError emits only fixed operator-authored 503 contracts.
// httperror intentionally rewrites generic 5xx detail to internal_error, which
// is correct for unexpected failures but would erase the request-bound outcome
// proof clients need for these three conservative control states.
func writeSendingCapControlError(w http.ResponseWriter, code, message string) {
	writeJSON(w, http.StatusServiceUnavailable, errEnv(code, message))
}
