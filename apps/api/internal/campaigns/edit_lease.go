// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// One writer at a time on a campaign being edited.
//
// This sits alongside two mechanisms that already exist and answers a different
// question from both. The approval fingerprint DETECTS that what is about to
// send is not what was approved. `If-Match` on `campaigns.version` detects a
// collision at write time. Both fire after two people have already done the
// work, and one of them is about to lose it.
//
// A lease prevents the second person starting. Nobody spends twenty minutes
// rewriting a subject line that is going to be discarded.
//
// WHAT IS GUARDED, AND WHAT IS DELIBERATELY NOT.
//
// An omission and a decision look identical in code, so the boundary is written
// down. Guarded — every path that changes WHO receives the campaign or WHAT
// they receive: PATCH, schedule, POST variants (the delivered A/B content),
// the Mailchimp `/content` compatibility surface, freeze-audience, per-subscriber
// send-time optimisation, recurrence, and DELETE.
//
// NOT guarded, each for a reason:
//
//   - pause / resume / cancel. These act on a send already in flight, and are
//     the operator's emergency controls. A lease is an EDITING concern; blocking
//     a cancel because a colleague has the campaign open would be the worst
//     possible moment to enforce it.
//   - queue / send / test-send. Dispatch, not editing, and already covered by
//     the approval gate and its fingerprint.
//   - feedback, org-tags, folder. Comments, labels and filing. None changes what
//     anybody receives, and locking them would make the lease feel arbitrary,
//     which is how people learn to work around it.
//   - preview-as. A read.
//
// ADVISORY, AND DELIBERATELY SO. An unheld campaign is editable exactly as
// before, so no existing client breaks by not knowing about leases, and the
// enforcement is narrow: a write is refused only when someone ELSE currently
// holds one. The fingerprint and the version check still cover what slips past
// the TTL boundary, which is why this layer is allowed to be soft rather than a
// hard lock an admin has to break.

// DefaultEditLeaseTTL bounds how long a lease survives without renewal.
//
// Two minutes: long enough that ordinary typing does not lose it, short enough
// that a closed laptop frees the campaign before anyone goes looking for an
// administrator. The holder renews while actually editing.
const DefaultEditLeaseTTL = 2 * time.Minute

// EditLease is who currently holds the right to edit a campaign.
type EditLease struct {
	CampaignID  string    `json:"campaign_id"`
	HolderID    string    `json:"holder_id"`
	HolderLabel string    `json:"holder_label,omitempty"`
	AcquiredAt  time.Time `json:"acquired_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// ErrEditLeaseHeld is returned when someone else is editing.
//
// Carries the holder so trusted internal code can enforce ownership and HTTP
// code can derive privacy-safe coordination copy. Durable holder ids and
// email-address labels must not be serialized to readers or conflicting
// editors.
type ErrEditLeaseHeld struct {
	Holder EditLease
}

func (e *ErrEditLeaseHeld) Error() string {
	who := editLeaseCoordinationLabel(e.Holder.HolderLabel)
	return fmt.Sprintf("campaign is being edited by %s until %s",
		who, e.Holder.ExpiresAt.UTC().Format(time.RFC3339))
}

// editLeaseCoordinationLabel is the only holder label that may cross an HTTP
// boundary. User leases currently persist their email address as the durable
// label; that is useful inside the tenancy/audit boundary but is unnecessary
// PII for a campaign read or conflict response. Human-readable non-email labels
// (for example a named migration bot) retain the coordination value.
func editLeaseCoordinationLabel(raw string) string {
	label := strings.TrimSpace(raw)
	if label == "" || strings.Contains(label, "@") {
		return "another editor"
	}
	return label
}

// AcquireEditLease takes or renews the lease on a campaign.
//
// Succeeds when the lease is free, expired, or already held by this holder;
// returns *ErrEditLeaseHeld otherwise. Renewing your own lease is the same
// call, so a client polls one endpoint rather than choosing between two.
func (r *Repo) AcquireEditLease(
	ctx context.Context, tenantID, campaignID, holderID, holderLabel string, ttl time.Duration,
) (*EditLease, error) {
	tenantID = strings.TrimSpace(tenantID)
	campaignID = strings.TrimSpace(campaignID)
	holderID = strings.TrimSpace(holderID)
	if tenantID == "" || campaignID == "" {
		return nil, errors.New("edit lease: tenant and campaign required")
	}
	if holderID == "" {
		// An anonymous holder cannot be distinguished from any other anonymous
		// holder, so the lease would appear to be simultaneously held and
		// renewable by everyone — worse than no lease at all.
		return nil, errors.New("edit lease: holder id required")
	}
	if ttl <= 0 {
		ttl = DefaultEditLeaseTTL
	}
	if r == nil || r.Pool == nil {
		return nil, errors.New("edit lease: repository unavailable")
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The campaign must be VISIBLE TO THIS TENANT before a lease is taken.
	//
	// Without this the FK is the only thing checking the campaign id — and
	// foreign-key checks are NOT subject to row-level security. So taking a
	// lease on another tenant's campaign SUCCEEDED (the FK is satisfied, the
	// lease row is written under your own tenant_id) while a nonexistent id
	// failed, turning this route into an authenticated cross-tenant
	// campaign-existence oracle, and littering the table with leases for
	// campaigns the holder cannot see.
	var visible bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid)`,
		tenantID, campaignID).Scan(&visible); err != nil {
		return nil, err
	}
	if !visible {
		// Same answer for "not yours" and "does not exist": distinguishing them
		// is the oracle.
		return nil, ErrCampaignNotFound
	}

	// ONE conditional upsert, not read-then-write. Two clients acquiring at the
	// same instant are resolved by the database; a read-then-write would let
	// both observe "free" and both believe they hold it.
	var lease EditLease
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_edit_leases
    (tenant_id, campaign_id, holder_id, holder_label, acquired_at, expires_at)
VALUES ($1::uuid, $2::uuid, $3, $4, now(), now() + $5::interval)
ON CONFLICT (tenant_id, campaign_id) DO UPDATE
   SET holder_id    = EXCLUDED.holder_id,
       holder_label = EXCLUDED.holder_label,
       -- acquired_at only moves when the holder CHANGES, so a renewing holder
       -- keeps their original start time and "editing since" stays truthful.
       acquired_at  = CASE WHEN campaign_edit_leases.holder_id = EXCLUDED.holder_id
                           THEN campaign_edit_leases.acquired_at
                           ELSE EXCLUDED.acquired_at END,
       expires_at   = EXCLUDED.expires_at
 WHERE campaign_edit_leases.holder_id = EXCLUDED.holder_id
    OR campaign_edit_leases.expires_at <= now()
RETURNING campaign_id::text, holder_id, holder_label, acquired_at, expires_at`,
		tenantID, campaignID, holderID, strings.TrimSpace(holderLabel),
		fmt.Sprintf("%d seconds", int(ttl.Seconds())),
	).Scan(&lease.CampaignID, &lease.HolderID, &lease.HolderLabel,
		&lease.AcquiredAt, &lease.ExpiresAt)

	if errors.Is(err, pgx.ErrNoRows) {
		// The WHERE on the DO UPDATE filtered the row out: someone else holds an
		// unexpired lease. Read it so the refusal can name them.
		held, readErr := r.readEditLeaseTx(ctx, tx, tenantID, campaignID)
		if readErr != nil {
			return nil, readErr
		}
		if held == nil {
			// Raced with a release between the upsert and this read. Reporting
			// "held by nobody" would be a lie; the caller retries.
			return nil, errors.New("edit lease: contended, retry")
		}
		return nil, &ErrEditLeaseHeld{Holder: *held}
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &lease, nil
}

// ReleaseEditLease gives up a lease this holder owns.
//
// Scoped to the holder: releasing someone else's lease would make the whole
// mechanism advisory in the wrong direction, since the way to bypass it would
// be to release it first.
func (r *Repo) ReleaseEditLease(ctx context.Context, tenantID, campaignID, holderID string) error {
	if r == nil || r.Pool == nil {
		return errors.New("edit lease: repository unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, strings.TrimSpace(tenantID))
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM campaign_edit_leases
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND holder_id = $3`,
		strings.TrimSpace(tenantID), strings.TrimSpace(campaignID),
		strings.TrimSpace(holderID)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// EditLeaseHolder returns the current unexpired lease, or nil.
func (r *Repo) EditLeaseHolder(ctx context.Context, tenantID, campaignID string) (*EditLease, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("edit lease: repository unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, strings.TrimSpace(tenantID))
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lease, err := r.readEditLeaseTx(ctx, tx, strings.TrimSpace(tenantID), strings.TrimSpace(campaignID))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return lease, nil
}

func (r *Repo) readEditLeaseTx(
	ctx context.Context, tx pgx.Tx, tenantID, campaignID string,
) (*EditLease, error) {
	var lease EditLease
	err := tx.QueryRow(ctx, `
SELECT campaign_id::text, holder_id, holder_label, acquired_at, expires_at
  FROM campaign_edit_leases
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND expires_at > now()`,
		tenantID, campaignID).Scan(&lease.CampaignID, &lease.HolderID,
		&lease.HolderLabel, &lease.AcquiredAt, &lease.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &lease, nil
}

// AssertEditableBy refuses a write while someone else holds the lease.
//
// Returns nil when the campaign is unheld, when the lease has expired, or when
// the caller IS the holder. An unheld campaign staying editable is what keeps
// this backwards-compatible: a client that knows nothing about leases behaves
// exactly as it did, and only a genuine concurrent editor is stopped.
func (r *Repo) AssertEditableBy(ctx context.Context, tenantID, campaignID, holderID string) error {
	held, err := r.EditLeaseHolder(ctx, tenantID, campaignID)
	if err != nil {
		return err
	}
	if held == nil || held.HolderID == strings.TrimSpace(holderID) {
		return nil
	}
	return &ErrEditLeaseHeld{Holder: *held}
}
