// SPDX-License-Identifier: AGPL-3.0-only
//
// Package control_group owns the tenant-wide control-cohort surface
// used for incremental-lift measurement across all campaigns
// (GAP-LS-138). This is distinct from internal/holdouts (per-campaign
// holdouts): a control group sits across every send until the
// operator dissolves it.
//
// Per-subscriber membership is computed deterministically as
//
//	md5(seed || subscriber_id) ranged into [0, 100)
//	in_control = bucket < percent
//
// so the same subscriber stays in/out across recomputes. Reporting
// compares the engagement (open/click/conversion event rates) of the
// control cohort against the treated cohort over a configurable window.
//
// Storage is control_groups (migration 0259).
package control_group

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Sentinel errors.
var (
	ErrNotFound     = errors.New("control_group: not found")
	ErrInvalidInput = errors.New("control_group: invalid input")
)

// Status mirrors control_groups.status CHECK.
type Status string

const (
	StatusActive    Status = "active"
	StatusPaused    Status = "paused"
	StatusDissolved Status = "dissolved"
)

// ControlGroup is one row from control_groups.
type ControlGroup struct {
	ID          string     `json:"id"`
	TenantID    string     `json:"tenant_id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Percent     float64    `json:"percent"`
	Seed        string     `json:"seed"`
	Status      Status     `json:"status"`
	StartsAt    time.Time  `json:"starts_at"`
	EndsAt      *time.Time `json:"ends_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// CreateInput is the body of POST /api/v1/control-groups.
type CreateInput struct {
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Percent     float64 `json:"percent"`
	// Seed is optional; when omitted the server generates a random
	// 128-bit hex string so callers can fire-and-forget.
	Seed   string     `json:"seed,omitempty"`
	EndsAt *time.Time `json:"ends_at,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/control-groups/{id}.
type UpdateInput struct {
	Description *string    `json:"description,omitempty"`
	Status      *string    `json:"status,omitempty"`
	EndsAt      *time.Time `json:"ends_at,omitempty"`
}

// enforcedAtSendTime reports whether control-group membership is ACTUALLY
// excluded from the send path.
//
// It is now TRUE: the queue path (campaigns/handlers_queue.go) calls
// control_group.PartitionControl before the A/B split and drops control members
// from the audience, so control subscribers receive no campaigns. The report
// (below) and the send path both hash the subscriber's EMAIL, so their
// partitions agree — the identifier-mismatch trap the previous TODO warned
// about is closed. The control-vs-treated comparison is therefore a genuine
// held-out-vs-sent measurement, and Report publishes the rates + lift.
var enforcedAtSendTime = true

// Report is the response of GET /api/v1/control-groups/{id}/report.
type Report struct {
	GroupID    string `json:"group_id"`
	WindowDays int    `json:"window_days"`

	// Enforced is false while control members still receive campaigns. When
	// false, the comparison fields below are omitted.
	Enforced bool   `json:"enforced"`
	Warning  string `json:"warning,omitempty"`

	// Cohort sizes are real regardless of enforcement — the partition is
	// deterministic. Only the comparison between them is meaningless.
	ControlSize int64 `json:"control_size"`
	TreatedSize int64 `json:"treated_size"`

	// Omitted (nil) unless Enforced. A missing number is honest; a
	// fabricated one is not.
	ControlEngagement *float64 `json:"control_engagement_rate,omitempty"`
	TreatedEngagement *float64 `json:"treated_engagement_rate,omitempty"`
	IncrementalLift   *float64 `json:"incremental_lift,omitempty"`

	GeneratedAt time.Time `json:"generated_at"`
}

// cohort is one side of the control/treated partition.
type cohort struct {
	size    int64
	engaged int64
}

func (c cohort) rate() float64 {
	if c.size == 0 {
		return 0
	}
	return float64(c.engaged) / float64(c.size)
}

// finalizeReport assembles the report, publishing the engagement comparison
// only when control membership is genuinely excluded at send time.
func finalizeReport(groupID string, windowDays int, control, treated cohort) *Report {
	rep := &Report{
		GroupID:     groupID,
		WindowDays:  windowDays,
		Enforced:    enforcedAtSendTime,
		ControlSize: control.size,
		TreatedSize: treated.size,
		GeneratedAt: time.Now().UTC(),
	}
	if !enforcedAtSendTime {
		rep.Warning = "Incremental lift is unavailable: control-group membership is not yet excluded at send time, " +
			"so the control cohort received this campaign too. Comparing the two would measure noise, not lift."
		return rep
	}
	cr, tr := control.rate(), treated.rate()
	lift := tr - cr
	rep.ControlEngagement = &cr
	rep.TreatedEngagement = &tr
	rep.IncrementalLift = &lift
	return rep
}

// Repo wraps the pgx pool.
type Repo struct {
	Pool *db.Pool
}

// Create inserts a new control_groups row.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*ControlGroup, error) {
	if in.Name == "" {
		return nil, fmt.Errorf("%w: name required", ErrInvalidInput)
	}
	if in.Percent < 0 || in.Percent > 50 {
		return nil, fmt.Errorf("%w: percent must be 0..50", ErrInvalidInput)
	}
	seed := in.Seed
	if seed == "" {
		buf := make([]byte, 16)
		if _, err := rand.Read(buf); err != nil {
			return nil, err
		}
		seed = hex.EncodeToString(buf)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO control_groups (tenant_id, name, description, percent, seed, ends_at)
VALUES ($1::uuid, $2, $3, $4::numeric, $5, $6)
RETURNING id::text`,
		tenantID, in.Name, in.Description, in.Percent, seed, in.EndsAt,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.Get(ctx, tenantID, id)
}

// List returns the tenant's control groups.
func (r *Repo) List(ctx context.Context, tenantID string) ([]ControlGroup, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, COALESCE(description,''),
       percent::float8, seed, status,
       starts_at, ends_at, created_at, updated_at
  FROM control_groups
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ControlGroup{}
	for rows.Next() {
		var g ControlGroup
		if err := rows.Scan(
			&g.ID, &g.TenantID, &g.Name, &g.Description,
			&g.Percent, &g.Seed, (*string)(&g.Status),
			&g.StartsAt, &g.EndsAt, &g.CreatedAt, &g.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Get returns one group by id.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*ControlGroup, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var g ControlGroup
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, COALESCE(description,''),
       percent::float8, seed, status,
       starts_at, ends_at, created_at, updated_at
  FROM control_groups
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(
		&g.ID, &g.TenantID, &g.Name, &g.Description,
		&g.Percent, &g.Seed, (*string)(&g.Status),
		&g.StartsAt, &g.EndsAt, &g.CreatedAt, &g.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &g, nil
}

// Update mutates a group's description / status / ends_at.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*ControlGroup, error) {
	if in.Status != nil {
		switch *in.Status {
		case string(StatusActive), string(StatusPaused), string(StatusDissolved):
		default:
			return nil, fmt.Errorf("%w: unknown status %q", ErrInvalidInput, *in.Status)
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE control_groups
   SET description = COALESCE($3, description),
       status = COALESCE($4, status),
       ends_at = COALESCE($5, ends_at),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id, in.Description, in.Status, in.EndsAt)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.Get(ctx, tenantID, id)
}

// IsInControl is the deterministic membership predicate used by the
// dispatcher (when wired) and the report query (in-process). Same
// formula as campaign_holdouts so behaviour matches operator intuition.
func IsInControl(seed, subscriberID string, percent float64) bool {
	if percent <= 0 {
		return false
	}
	sum := md5.Sum([]byte(seed + subscriberID))
	// Take the first 8 bytes -> uint64 -> bucket in [0,100).
	bucket := float64(sum[0])*1.0 + float64(sum[1])/256.0
	bucket = bucket * 100.0 / 256.0
	return bucket < percent
}

// Report computes a coarse engagement-rate comparison over the past
// windowDays. The query is heuristic — it joins subscribers with
// subscriber_events and partitions by the IsInControl predicate
// applied as an in-process filter (we can't md5 in SQL portably
// across all targets; doing it in-process keeps the SQL simple).
//
// Engagement = % of cohort with at least one (opened|clicked|form_submit)
// event in window.
func (r *Repo) Report(ctx context.Context, tenantID, id string, windowDays int) (*Report, error) {
	if windowDays <= 0 || windowDays > 365 {
		windowDays = 30
	}
	grp, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pull (subscriber_id, has_engaged) for every subscriber in the
	// tenant; in-process partition into control vs treated.
	rows, err := tx.Query(ctx, `
SELECT s.email::text,
       EXISTS (
         SELECT 1 FROM subscriber_events e
          WHERE e.tenant_id = s.tenant_id
            AND e.subscriber_email = s.email
            AND e.event_type IN ('opened','clicked','form_submit')
            AND e.at > now() - ($2::int * INTERVAL '1 day')
       ) AS engaged
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid`, tenantID, windowDays)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var controlSize, treatedSize int64
	var controlEng, treatedEng int64
	for rows.Next() {
		var email string
		var engaged bool
		if err := rows.Scan(&email, &engaged); err != nil {
			return nil, err
		}
		// Partition on EMAIL, matching the send path (control_group/send.go).
		// The old code hashed subscriber.id here while the send path (once
		// wired) carries emails; hashing different identifiers would put a
		// subscriber in "control" for the report but "treated" at send time.
		if IsInControl(grp.Seed, email, grp.Percent) {
			controlSize++
			if engaged {
				controlEng++
			}
		} else {
			treatedSize++
			if engaged {
				treatedEng++
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Incremental lift = treated - control (absolute), published ONLY when
	// control membership is actually excluded at send time. See
	// enforcedAtSendTime.
	return finalizeReport(
		grp.ID,
		windowDays,
		cohort{size: controlSize, engaged: controlEng},
		cohort{size: treatedSize, engaged: treatedEng},
	), nil
}

// Delete removes a control group entirely (cascade-safe — no child
// tables today).
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM control_groups WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// keep json imported for callers.
var _ = json.Marshal
