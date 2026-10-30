// SPDX-License-Identifier: AGPL-3.0-only

// Package actionticket mints and redeems single-use authorisation for one
// action on one resource.
//
// `notifications.ActionsForEvent` tells every surface what can be done about a
// notification. That works in-app, where a session exists, and does nothing for
// the surfaces most likely to reach somebody away from their desk: an email, a
// Slack message, a push tapped from a lock screen. Those can only offer a link,
// and a link into an authenticated app is a request to log in first — the exact
// friction the notification was trying to remove.
//
// A ticket is not a session and cannot become one. It authorises ONE named
// action on ONE resource, once, briefly. Redeeming it does not log anybody in.
package actionticket

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/notifications"
)

var (
	// ErrInvalid covers every rejection: unknown, expired, already used, or
	// mismatched. ONE error on purpose — telling a bearer which of those it was
	// turns the redeem endpoint into an oracle for guessing ticket secrets.
	ErrInvalid = errors.New("actionticket: ticket is not valid")
	// ErrUnknownAction is returned at MINT time, where the caller is our own
	// code and a precise error is a bug report rather than an oracle.
	ErrUnknownAction = errors.New("actionticket: action is not in the catalog")
	// ErrExecutionInProgress deliberately has the same public treatment as an
	// invalid ticket. It exists for internal telemetry and tests only: telling a
	// bearer that a guessed secret names a currently executing ticket would turn
	// the endpoint into an oracle.
	ErrExecutionInProgress = errors.New("actionticket: action execution is in progress")
)

// DefaultTTL is how long a minted ticket stays usable.
//
// One hour. Long enough to walk to a laptop, short enough that an approval link
// sitting in an inbox — forwarded, quoted in a reply chain, indexed by whatever
// scans that mailbox — is not a standing credential.
const DefaultTTL = time.Hour

// executionLease is the crash-recovery window for a claimed ticket. A handler
// claims before invoking the domain action, completes only after success, and
// releases on an ordinary error. If the process dies between those steps, a
// later request can reclaim the ticket after this interval. Every registered
// performer must therefore be idempotent for Redeemed.ID.
const executionLease = 2 * time.Minute

// secretBytes is the entropy in the link.
//
// 32 bytes. The secret IS the authorisation, so it is sized like a session
// token rather than like an id; the table stores only its SHA-256.
const secretBytes = 32

// Ticket is a minted authorisation. Secret is populated ONLY by Mint and is
// never read back from storage.
type Ticket struct {
	ID              string
	Secret          string
	Action          string
	ResourceKind    string
	ResourceID      string
	ResourceVersion string
	ExpiresAt       time.Time
}

// Redeemed is what a successful redemption proves.
type Redeemed struct {
	ID           string
	TenantID     string
	UserID       string
	Action       string
	ResourceKind string
	ResourceID   string
	// ResourceVersion binds actions whose meaning can change after minting to
	// the exact domain projection that was reviewed. It is intentionally empty
	// for resources (currently approvals) whose domain service performs its own
	// state-machine check at execution time.
	ResourceVersion string
	ExecutionID     string
}

// ResourceBinding is the immutable domain identity attached at mint time.
// ValidUntil may shorten the bearer credential but can never extend it.
type ResourceBinding struct {
	Version    string
	ValidUntil *time.Time
}

// ResourceBinder resolves mutable domain resources without teaching the
// generic ticket repository their schema. Only actions explicitly marked by
// requiresResourceBinding invoke it.
type ResourceBinder interface {
	BindActionResource(context.Context, string, string, string, string) (ResourceBinding, error)
}

type Repo struct {
	Pool   *db.Pool
	Binder ResourceBinder
}

// Mint issues a ticket for one action on one resource.
//
// The action must be one `notifications.ActionsForEvent` knows. A ticket for an
// action no surface renders is either a bug or an attempt to manufacture an
// affordance, and both should fail here rather than at redemption.
func (r *Repo) Mint(
	ctx context.Context, tenantID, userID, action, resourceKind, resourceID string, ttl time.Duration,
) (*Ticket, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("actionticket: repository unavailable")
	}
	action = strings.TrimSpace(action)
	if !KnownActionForResource(action, resourceKind) {
		return nil, ErrUnknownAction
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(userID) == "" ||
		strings.TrimSpace(resourceKind) == "" || strings.TrimSpace(resourceID) == "" {
		return nil, errors.New("actionticket: tenant, user and resource are required")
	}
	if ttl <= 0 || ttl > 24*time.Hour {
		// Capped as well as defaulted: a caller asking for a week has made a
		// mistake, and honouring it would put a standing credential in an inbox.
		ttl = DefaultTTL
	}

	raw := make([]byte, secretBytes)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	secret := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(secret))

	now := time.Now().UTC()
	resourceVersion := ""
	validUntil := now.Add(ttl)
	if requiresResourceBinding(action, resourceKind) {
		if r.Binder == nil {
			return nil, errors.New("actionticket: resource binding is unavailable")
		}
		binding, bindErr := r.Binder.BindActionResource(
			ctx, tenantID, action, resourceKind, resourceID,
		)
		if bindErr != nil {
			return nil, bindErr
		}
		resourceVersion = strings.TrimSpace(binding.Version)
		if len(resourceVersion) != 64 || strings.Trim(resourceVersion, "0123456789abcdef") != "" {
			return nil, errors.New("actionticket: resource binding is invalid")
		}
		if binding.ValidUntil != nil {
			bound := binding.ValidUntil.UTC()
			if !bound.After(now) {
				return nil, ErrInvalid
			}
			if bound.Before(validUntil) {
				validUntil = bound
			}
		}
	}
	t := &Ticket{
		Secret: secret, Action: action,
		ResourceKind: resourceKind, ResourceID: resourceID, ResourceVersion: resourceVersion,
		ExpiresAt: validUntil,
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
INSERT INTO action_tickets
    (tenant_id, user_id, action, resource_kind, resource_id,
     resource_version, secret_hash, expires_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7, $8)
RETURNING id::text`,
		tenantID, userID, action, resourceKind, resourceID,
		resourceVersion, sum[:], t.ExpiresAt).Scan(&t.ID); err != nil {
		return nil, err
	}
	return t, tx.Commit(ctx)
}

// Claim obtains the single execution lease for a ticket without consuming it.
//
// This closes the old failure ordering where used_at was committed before the
// domain action ran. A transient domain failure now releases the lease and the
// person can retry. Concurrent clicks cannot both perform because only one
// conditional UPDATE can own execution_id at a time.
func (r *Repo) Claim(ctx context.Context, secret, ip string) (*Redeemed, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("actionticket: repository unavailable")
	}
	if strings.TrimSpace(secret) == "" {
		return nil, ErrInvalid
	}
	sum := sha256.Sum256([]byte(secret))
	executionID := uuid.NewString()

	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.auth_resolver', 'true', true)`); err != nil {
		return nil, err
	}

	var out Redeemed
	err = tx.QueryRow(ctx, `
UPDATE action_tickets
   SET execution_id = $2::uuid,
       execution_started_at = now(),
       execution_attempts = execution_attempts + 1,
       used_ip = $3,
       last_execution_error_code = NULL
 WHERE secret_hash = $1
   AND used_at IS NULL
   AND expires_at > now()
   AND (
       execution_id IS NULL
       OR execution_started_at < now() - $4::interval
   )
RETURNING id::text, tenant_id::text, user_id::text, action,
          resource_kind, resource_id, COALESCE(resource_version, ''), execution_id::text`,
		sum[:], executionID, strings.TrimSpace(ip), executionLease.String()).
		Scan(&out.ID, &out.TenantID, &out.UserID, &out.Action,
			&out.ResourceKind, &out.ResourceID, &out.ResourceVersion, &out.ExecutionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	if !KnownActionForResource(out.Action, out.ResourceKind) {
		return nil, fmt.Errorf("%w: %s on %s", ErrUnknownAction, out.Action, out.ResourceKind)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// Complete consumes a successfully performed claim. It can only complete the
// exact execution lease returned by Claim, so a stale crashed worker cannot
// consume a ticket reclaimed by a newer request.
func (r *Repo) Complete(ctx context.Context, claim Redeemed) error {
	if r == nil || r.Pool == nil {
		return errors.New("actionticket: repository unavailable")
	}
	if strings.TrimSpace(claim.ID) == "" || strings.TrimSpace(claim.ExecutionID) == "" {
		return ErrInvalid
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.auth_resolver', 'true', true)`); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE action_tickets
   SET used_at = now(), execution_id = NULL, execution_started_at = NULL
 WHERE id = $1::uuid
   AND execution_id = $2::uuid
   AND used_at IS NULL`, claim.ID, claim.ExecutionID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrInvalid
	}
	return tx.Commit(ctx)
}

// Release makes a failed claim retryable. The stored value is a bounded stable
// code, never err.Error(), because provider/database errors can contain secrets
// or customer data.
func (r *Repo) Release(ctx context.Context, claim Redeemed, errorCode string) error {
	if r == nil || r.Pool == nil {
		return errors.New("actionticket: repository unavailable")
	}
	if strings.TrimSpace(claim.ID) == "" || strings.TrimSpace(claim.ExecutionID) == "" {
		return ErrInvalid
	}
	errorCode = strings.TrimSpace(errorCode)
	if errorCode == "" {
		errorCode = "action_failed"
	}
	if len(errorCode) > 64 {
		errorCode = errorCode[:64]
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.auth_resolver', 'true', true)`); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE action_tickets
   SET execution_id = NULL,
       execution_started_at = NULL,
       last_execution_error_code = $3
 WHERE id = $1::uuid
   AND execution_id = $2::uuid
   AND used_at IS NULL`, claim.ID, claim.ExecutionID, errorCode)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrInvalid
	}
	return tx.Commit(ctx)
}

// Redeem consumes a ticket and reports what it authorises.
//
// The caller states the action and resource it is about to perform, and they
// must MATCH the ticket. Without that the endpoint would accept any valid
// secret for any action — a ticket minted to approve one campaign would delete
// another, which is the whole reason the resource is on the ticket.
//
// Single use is the WHERE clause, not a read followed by a write. Two clicks on
// an emailed button race, and a lost update there approves something twice.
func (r *Repo) Redeem(
	ctx context.Context, secret, action, resourceKind, resourceID, ip string,
) (*Redeemed, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("actionticket: repository unavailable")
	}
	if strings.TrimSpace(secret) == "" {
		return nil, ErrInvalid
	}
	sum := sha256.Sum256([]byte(secret))

	// No tenant context: the bearer has no session, which is the point. The
	// resolver capability is the same one session lookup uses for pre-tenant
	// work, and the RLS policy on action_tickets admits exactly that.
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.auth_resolver', 'true', true)`); err != nil {
		return nil, err
	}

	var out Redeemed
	err = tx.QueryRow(ctx, `
UPDATE action_tickets
   SET used_at = now(), used_ip = $5
 WHERE secret_hash = $1
   AND used_at IS NULL
   AND expires_at > now()
   AND action = $2
   AND resource_kind = $3
   AND resource_id = $4
RETURNING id::text, tenant_id::text, user_id::text, action, resource_kind,
          resource_id, COALESCE(resource_version, '')`,
		sum[:], action, resourceKind, resourceID, strings.TrimSpace(ip)).
		Scan(&out.ID, &out.TenantID, &out.UserID, &out.Action, &out.ResourceKind,
			&out.ResourceID, &out.ResourceVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		// Unknown, expired, spent, or for a different action. Deliberately
		// indistinguishable — see ErrInvalid.
		return nil, ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	return &out, tx.Commit(ctx)
}

// SweepExpired deletes tickets that are past their expiry and were never used.
//
// A used ticket is KEPT: it is the audit record of who acted and from where,
// and deleting it on a timer would erase the evidence at the moment somebody
// asks who approved something.
func (r *Repo) SweepExpired(ctx context.Context, olderThan time.Duration) (int64, error) {
	if r == nil || r.Pool == nil {
		return 0, nil
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM action_tickets
 WHERE used_at IS NULL AND expires_at < now() - $1::interval`,
		olderThan.String())
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// KnownAction reports whether the catalog defines this action AND its declared
// side-effect semantics permit invoking it from a ticket.
//
// Reads `notifications.ActionsForEvent` rather than keeping a second list —
// which is the point of the catalog existing. A ticket may only authorise
// something a surface would actually render.
//
// The side-effect check is §11.1's sixth precondition, enforced at the point of
// use. Registration, authentication, HTTPS, a limited-use token and replay
// protection are all supplied by the ticket itself; none of them says anything
// about what invoking the action DOES. An action that reserves inventory or
// completes a purchase is rejected here even though its token is perfectly
// valid, because the release and refund machinery those classes imply does not
// exist — and a ticket that authorises an irreversible act the system cannot
// reverse is worse than no ticket at all.
func KnownAction(action string) bool {
	if strings.TrimSpace(action) == "" {
		return false
	}
	for _, event := range notifications.ActionEvents() {
		for _, a := range notifications.ActionsForEvent(event) {
			if a.ID == action && a.SideEffect.Ticketable() {
				return KnownActionForResource(a.ID, resourceKindForAction(a.ID))
			}
		}
	}
	return false
}

// KnownActionForResource is the executable half of §11.1's action gate.
// Declared side-effect semantics are necessary but not sufficient: production
// must also have an idempotent executor for the exact resource kind. Keep this
// deliberately small. Adding a catalog action without adding the executor here
// makes minting fail closed instead of creating a link that can never work.
func KnownActionForResource(action, resourceKind string) bool {
	if strings.TrimSpace(action) == "" || strings.TrimSpace(resourceKind) == "" {
		return false
	}
	var declared bool
	for _, event := range notifications.ActionEvents() {
		for _, candidate := range notifications.ActionsForEvent(event) {
			if candidate.ID == action && candidate.SideEffect.Ticketable() {
				declared = true
				break
			}
		}
	}
	if !declared {
		return false
	}
	switch action {
	case "approval.approve", "approval.reject":
		return resourceKind == "approval"
	case "offer.decline":
		return resourceKind == "offer"
	default:
		return false
	}
}

func resourceKindForAction(action string) string {
	switch action {
	case "approval.approve", "approval.reject":
		return "approval"
	case "offer.decline":
		return "offer"
	default:
		return ""
	}
}

func requiresResourceBinding(action, resourceKind string) bool {
	return action == "offer.decline" && resourceKind == "offer"
}

// Preview describes a ticket WITHOUT consuming it.
//
// This is the safe half of the link, and it exists because of how email
// actually works: clients, gateways and security scanners prefetch links. A GET
// that redeemed would approve things the person never clicked — silently, from
// a scanner, before the mail was even opened.
//
// So the link in a message points HERE, this returns context the person can
// read ("you are approving Spring Sale"), and the button on that page POSTs the
// redeem. A prefetch reads a description and changes nothing.
//
// It deliberately reveals nothing beyond what the ticket already authorises: an
// invalid or expired secret is ErrInvalid, the same single answer redemption
// gives, so this cannot be used to probe which tickets exist.
func (r *Repo) Preview(ctx context.Context, secret string) (*Redeemed, time.Time, error) {
	if r == nil || r.Pool == nil {
		return nil, time.Time{}, errors.New("actionticket: repository unavailable")
	}
	if strings.TrimSpace(secret) == "" {
		return nil, time.Time{}, ErrInvalid
	}
	sum := sha256.Sum256([]byte(secret))

	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.auth_resolver', 'true', true)`); err != nil {
		return nil, time.Time{}, err
	}

	var out Redeemed
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, user_id::text, action, resource_kind,
       resource_id, COALESCE(resource_version, ''), expires_at
  FROM action_tickets
 WHERE secret_hash = $1 AND used_at IS NULL AND expires_at > now()`, sum[:]).
		Scan(&out.ID, &out.TenantID, &out.UserID, &out.Action, &out.ResourceKind,
			&out.ResourceID, &out.ResourceVersion, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, time.Time{}, ErrInvalid
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	if !KnownActionForResource(out.Action, out.ResourceKind) {
		return nil, time.Time{}, ErrInvalid
	}
	return &out, expiresAt, nil
}
