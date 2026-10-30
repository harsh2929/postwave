// SPDX-License-Identifier: AGPL-3.0-only

// Package sendallowance owns the hard monthly boundary for Moosewave-funded
// email delivery. It is intentionally separate from rate limits and billing:
// it authorizes a provider attempt, never creates an overage charge.
package sendallowance

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/limits"
)

var (
	ErrExhausted   = errors.New("managed send allowance exhausted")
	ErrUnavailable = errors.New("managed send allowance unavailable")
)

// ManagedSendAllowanceReleased records that production provider boundaries are
// wired to this gate. Keep the release-lock registry's mechanical coverage
// check in sync before changing it.
const ManagedSendAllowanceReleased = true

type Request struct {
	TenantID     string
	Key          string
	Source       string
	SourceRef    string
	RecipientIDs []string
	Now          time.Time
}

type Reservation struct {
	ID          string
	TenantID    string
	PeriodStart time.Time
	Units       int
	Limit       int
	Current     int
	Managed     bool
	Replayed    bool
	State       string
}

type ExhaustedError struct {
	Limit     int
	Current   int
	Requested int
}

func (e *ExhaustedError) Error() string {
	return fmt.Sprintf("%v: %d used or reserved of %d, %d requested", ErrExhausted, e.Current, e.Limit, e.Requested)
}

func (e *ExhaustedError) Unwrap() error { return ErrExhausted }

// Gate is the deliberately small interface used at provider boundaries.
// Commit is called immediately before the provider attempt. Release is only
// valid when the caller can prove that no external effect occurred.
type Gate interface {
	Reserve(context.Context, Request) (Reservation, error)
	Commit(context.Context, Reservation) error
	Release(context.Context, Reservation, string) error
}

type Service struct {
	Pool *db.Pool
	// Resolve is a test seam and an optional self-host entitlement adapter.
	// Production leaves it nil and uses limits.ManagedMonthlySendAllowance.
	Resolve func(string) (bool, int)
}

func New(pool *db.Pool) *Service { return &Service{Pool: pool} }

func unavailable(operation string, err error) error {
	return fmt.Errorf("%w: %s: %v", ErrUnavailable, operation, err)
}

func monthStart(now time.Time) time.Time {
	if now.IsZero() {
		now = time.Now()
	}
	now = now.UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

func normalizeRequest(in Request) (Request, error) {
	if _, err := uuid.Parse(strings.TrimSpace(in.TenantID)); err != nil {
		return Request{}, fmt.Errorf("%w: tenant id is invalid", ErrUnavailable)
	}
	in.TenantID = strings.TrimSpace(in.TenantID)
	in.Key = strings.TrimSpace(in.Key)
	in.Source = strings.TrimSpace(in.Source)
	in.SourceRef = strings.TrimSpace(in.SourceRef)
	if in.Key == "" || len(in.Key) > 255 || in.Source == "" || len(in.Source) > 64 || len(in.SourceRef) > 255 {
		return Request{}, fmt.Errorf("%w: reservation identity is invalid", ErrUnavailable)
	}
	if len(in.RecipientIDs) == 0 {
		return Request{}, fmt.Errorf("%w: at least one recipient identity is required", ErrUnavailable)
	}
	for i := range in.RecipientIDs {
		in.RecipientIDs[i] = strings.ToLower(strings.TrimSpace(in.RecipientIDs[i]))
		if in.RecipientIDs[i] == "" {
			return Request{}, fmt.Errorf("%w: recipient identity is empty", ErrUnavailable)
		}
	}
	return in, nil
}

// Reserve atomically serializes one tenant's current-month managed allowance.
// Reusing a key returns the existing reservation instead of charging twice.
func (s *Service) Reserve(ctx context.Context, raw Request) (Reservation, error) {
	if s == nil || s.Pool == nil {
		return Reservation{}, fmt.Errorf("%w: database is not configured", ErrUnavailable)
	}
	in, err := normalizeRequest(raw)
	if err != nil {
		return Reservation{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, in.TenantID)
	if err != nil {
		return Reservation{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var tier string
	if err := tx.QueryRow(ctx, `
SELECT lower(COALESCE(NULLIF(bs.tier, ''), NULLIF(t.tier, ''), 'sandbox'))
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, in.TenantID).Scan(&tier); err != nil {
		return Reservation{}, fmt.Errorf("%w: resolve plan: %v", ErrUnavailable, err)
	}
	resolve := limits.ManagedMonthlySendAllowance
	if s.Resolve != nil {
		resolve = s.Resolve
	}
	managed, allowance := resolve(tier)
	if !managed {
		if err := tx.Commit(ctx); err != nil {
			return Reservation{}, unavailable("commit BYO decision", err)
		}
		return Reservation{TenantID: in.TenantID, Units: len(in.RecipientIDs), Managed: false, State: "bypassed"}, nil
	}
	if allowance <= 0 {
		return Reservation{}, fmt.Errorf("%w: managed plan has no positive allowance", ErrUnavailable)
	}
	period := monthStart(in.Now)
	if _, err := tx.Exec(ctx, `
INSERT INTO managed_send_allowance_buckets
  (tenant_id, period_start, allowance_units, reserved_units, committed_units)
VALUES ($1::uuid, $2::date, $3, 0, 0)
ON CONFLICT (tenant_id, period_start) DO UPDATE
	SET allowance_units = GREATEST(
		managed_send_allowance_buckets.reserved_units + managed_send_allowance_buckets.committed_units,
		EXCLUDED.allowance_units
	), updated_at = now()`, in.TenantID, period, allowance); err != nil {
		return Reservation{}, fmt.Errorf("%w: initialize bucket: %v", ErrUnavailable, err)
	}
	var reserved, committed int
	if err := tx.QueryRow(ctx, `
SELECT reserved_units, committed_units
  FROM managed_send_allowance_buckets
 WHERE tenant_id=$1::uuid AND period_start=$2::date
 FOR UPDATE`, in.TenantID, period).Scan(&reserved, &committed); err != nil {
		return Reservation{}, fmt.Errorf("%w: lock bucket: %v", ErrUnavailable, err)
	}

	var existing Reservation
	var existingSource, existingSourceRef string
	err = tx.QueryRow(ctx, `
SELECT id::text, units, state, source, COALESCE(source_ref, '')
  FROM managed_send_allowance_reservations
 WHERE tenant_id=$1::uuid AND reservation_key=$2
   AND period_start=$3::date
 FOR UPDATE`, in.TenantID, in.Key, period).Scan(
		&existing.ID, &existing.Units, &existing.State, &existingSource, &existingSourceRef,
	)
	if err == nil {
		existing.TenantID, existing.PeriodStart, existing.Limit = in.TenantID, period, allowance
		existing.Managed, existing.Replayed, existing.Current = true, true, reserved+committed
		if existingSource != in.Source || existingSourceRef != in.SourceRef || existing.Units != len(in.RecipientIDs) {
			return Reservation{}, fmt.Errorf("%w: reservation identity changed", ErrUnavailable)
		}
		rows, err := tx.Query(ctx, `
SELECT recipient_fingerprint
  FROM managed_send_allowance_recipients
 WHERE tenant_id=$1::uuid AND reservation_id=$2::uuid
 ORDER BY ordinal`, in.TenantID, existing.ID)
		if err != nil {
			return Reservation{}, fmt.Errorf("%w: read recipient ledger: %v", ErrUnavailable, err)
		}
		fingerprints, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return Reservation{}, fmt.Errorf("%w: read recipient ledger: %v", ErrUnavailable, err)
		}
		if len(fingerprints) != len(in.RecipientIDs) {
			return Reservation{}, fmt.Errorf("%w: reservation recipient identity changed", ErrUnavailable)
		}
		for index, recipientID := range in.RecipientIDs {
			if fingerprints[index] != recipientFingerprint(recipientID) {
				return Reservation{}, fmt.Errorf("%w: reservation recipient identity changed", ErrUnavailable)
			}
		}
		// A definitely-not-sent attempt may safely reclaim its stable identity.
		if existing.State == "released" {
			if existing.Current+existing.Units > allowance {
				return Reservation{}, &ExhaustedError{Limit: allowance, Current: existing.Current, Requested: existing.Units}
			}
			if _, err := tx.Exec(ctx, `UPDATE managed_send_allowance_reservations SET state='reserved', committed_at=NULL, released_at=NULL, release_reason=NULL WHERE id=$1::uuid`, existing.ID); err != nil {
				return Reservation{}, unavailable("reopen reservation", err)
			}
			if _, err := tx.Exec(ctx, `UPDATE managed_send_allowance_buckets SET reserved_units=reserved_units+$3, updated_at=now() WHERE tenant_id=$1::uuid AND period_start=$2::date`, in.TenantID, period, existing.Units); err != nil {
				return Reservation{}, unavailable("reopen bucket units", err)
			}
			if err := appendEvent(ctx, tx, existing.ID, in.TenantID, "reserved", existing.Units, "retry_after_release"); err != nil {
				return Reservation{}, unavailable("record reservation reopen", err)
			}
			existing.State = "reserved"
		}
		if err := tx.Commit(ctx); err != nil {
			return Reservation{}, unavailable("commit reservation replay", err)
		}
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Reservation{}, fmt.Errorf("%w: read reservation: %v", ErrUnavailable, err)
	}
	current := reserved + committed
	units := len(in.RecipientIDs)
	if current+units > allowance {
		return Reservation{}, &ExhaustedError{Limit: allowance, Current: current, Requested: units}
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO managed_send_allowance_reservations
  (tenant_id, period_start, reservation_key, source, source_ref, units, state)
VALUES ($1::uuid, $2::date, $3, $4, NULLIF($5,''), $6, 'reserved')
RETURNING id::text`, in.TenantID, period, in.Key, in.Source, in.SourceRef, units).Scan(&id); err != nil {
		return Reservation{}, fmt.Errorf("%w: insert reservation: %v", ErrUnavailable, err)
	}
	for ordinal, recipientID := range in.RecipientIDs {
		if _, err := tx.Exec(ctx, `
INSERT INTO managed_send_allowance_recipients
  (reservation_id, tenant_id, ordinal, recipient_fingerprint)
VALUES ($1::uuid, $2::uuid, $3, $4)`, id, in.TenantID, ordinal, recipientFingerprint(recipientID)); err != nil {
			return Reservation{}, fmt.Errorf("%w: insert recipient ledger: %v", ErrUnavailable, err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE managed_send_allowance_buckets SET reserved_units=reserved_units+$3, updated_at=now() WHERE tenant_id=$1::uuid AND period_start=$2::date`, in.TenantID, period, units); err != nil {
		return Reservation{}, unavailable("reserve bucket units", err)
	}
	if err := appendEvent(ctx, tx, id, in.TenantID, "reserved", units, ""); err != nil {
		return Reservation{}, unavailable("record reservation", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Reservation{}, unavailable("commit reservation", err)
	}
	return Reservation{ID: id, TenantID: in.TenantID, PeriodStart: period, Units: units, Limit: allowance, Current: current, Managed: true, State: "reserved"}, nil
}

func (s *Service) Commit(ctx context.Context, reservation Reservation) error {
	return s.transition(ctx, reservation, "committed", "")
}

func (s *Service) Release(ctx context.Context, reservation Reservation, reason string) error {
	return s.transition(ctx, reservation, "released", strings.TrimSpace(reason))
}

func (s *Service) transition(ctx context.Context, reservation Reservation, next, reason string) error {
	if !reservation.Managed {
		return nil
	}
	if s == nil || s.Pool == nil || reservation.ID == "" || reservation.TenantID == "" {
		return fmt.Errorf("%w: invalid reservation transition", ErrUnavailable)
	}
	tx, err := db.WithTenant(ctx, s.Pool, reservation.TenantID)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var state string
	var units int
	var period time.Time
	if err := tx.QueryRow(ctx, `
SELECT state, units, period_start
  FROM managed_send_allowance_reservations
 WHERE tenant_id=$1::uuid AND id=$2::uuid
 FOR UPDATE`, reservation.TenantID, reservation.ID).Scan(&state, &units, &period); err != nil {
		return fmt.Errorf("%w: load reservation: %v", ErrUnavailable, err)
	}
	if state == next || (next == "released" && state == "released") {
		if err := tx.Commit(ctx); err != nil {
			return unavailable("commit idempotent transition", err)
		}
		return nil
	}
	if next == "committed" && state != "reserved" {
		return fmt.Errorf("%w: cannot commit reservation in %s", ErrUnavailable, state)
	}
	if next == "released" && state != "reserved" && state != "committed" {
		return fmt.Errorf("%w: cannot release reservation in %s", ErrUnavailable, state)
	}
	if next == "committed" {
		tag, err := tx.Exec(ctx, `UPDATE managed_send_allowance_buckets SET reserved_units=reserved_units-$3, committed_units=committed_units+$3, updated_at=now() WHERE tenant_id=$1::uuid AND period_start=$2::date AND reserved_units >= $3`, reservation.TenantID, period, units)
		if err != nil {
			return unavailable("move reserved units to committed", err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("%w: committed counter transition was not applied", ErrUnavailable)
		}
		_, err = tx.Exec(ctx, `UPDATE managed_send_allowance_reservations SET state='committed', committed_at=now() WHERE id=$1::uuid`, reservation.ID)
	} else {
		column := "reserved_units"
		if state == "committed" {
			column = "committed_units"
		}
		query := `UPDATE managed_send_allowance_buckets SET ` + column + `=` + column + `-$3, updated_at=now() WHERE tenant_id=$1::uuid AND period_start=$2::date AND ` + column + ` >= $3`
		tag, err := tx.Exec(ctx, query, reservation.TenantID, period, units)
		if err != nil {
			return unavailable("release bucket units", err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("%w: released counter transition was not applied", ErrUnavailable)
		}
		_, err = tx.Exec(ctx, `UPDATE managed_send_allowance_reservations SET state='released', released_at=now(), release_reason=NULLIF($2,'') WHERE id=$1::uuid`, reservation.ID, reason)
	}
	if err != nil {
		return unavailable("update reservation state", err)
	}
	if err := appendEvent(ctx, tx, reservation.ID, reservation.TenantID, next, units, reason); err != nil {
		return unavailable("record reservation transition", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return unavailable("commit reservation transition", err)
	}
	return nil
}

func recipientFingerprint(recipientID string) string {
	digest := sha256.Sum256([]byte(recipientID))
	return hex.EncodeToString(digest[:])
}

func appendEvent(ctx context.Context, tx pgx.Tx, reservationID, tenantID, event string, units int, reason string) error {
	_, err := tx.Exec(ctx, `
INSERT INTO managed_send_allowance_events
  (reservation_id, tenant_id, event_type, units, reason)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5,''))`, reservationID, tenantID, event, units, reason)
	return err
}
