package lists

// membership_identity.go — which contact an owned list membership is written
// for, and whether the writer may create one.
//
// A writer that collected the address itself — a CSV import, a CRM sync — may
// name an address the tenant has never seen, and gets a fail-closed identity
// shell for it. A writer acting on a contact it did not collect — a flow's
// "Move to list", whose outbox row carries only the address the run was
// enrolled with — may not: by the time the row is handled the contact can have
// been deleted or erased by a privacy request, and minting a shell would bring
// the address back as a subscriber, announce it to list.subscriber.added
// webhooks and enrol it in "Joined list" flows.

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrNoContactForAddress means the tenant has no contact with the address and
// the writer is not allowed to create one.
var ErrNoContactForAddress = errors.New("lists: no contact with that address")

// memberIdentityPolicy decides how an owned membership write finds its contact.
type memberIdentityPolicy int

const (
	// mintIdentityShell resolves the address, creating a fail-closed
	// identity shell when the tenant has no contact with it.
	mintIdentityShell memberIdentityPolicy = iota
	// requireExistingContact resolves the address to a contact that already
	// exists and whose address carries no erasure tombstone, and never
	// creates one.
	requireExistingContact
)

// AddExistingContactToListOwned adds an existing contact, found by address, to
// the list under owner. It never creates a contact. listRef is the list's
// engine id or uuid; it is resolved inside the writing transaction.
//
// Errors: ErrNoContactForAddress when the tenant has no contact with the
// address, ErrErasureBlocked when the address was erased, and the
// ResolveListIdentityTx errors for a list that is not this tenant's.
func (r *Repo) AddExistingContactToListOwned(ctx context.Context, tenantID, listRef, email string, owner ListMembershipOwner) (string, error) {
	return r.addOwnedMembership(ctx, tenantID, listRef, email, owner, requireExistingContact)
}

func (p memberIdentityPolicy) resolve(ctx context.Context, tx pgx.Tx, tenantID, email string) (subscriberID, subscriberEmail string, err error) {
	if p == requireExistingContact {
		return existingListMemberTx(ctx, tx, tenantID, email)
	}
	return mintListMemberShellTx(ctx, tx, tenantID, email)
}

// existingListMemberTx finds the tenant's contact for email and holds it FOR
// KEY SHARE until the membership commits: a contact deletion that starts now
// waits, then removes the membership with the contact.
func existingListMemberTx(ctx context.Context, tx pgx.Tx, tenantID, email string) (subscriberID, subscriberEmail string, err error) {
	err = tx.QueryRow(ctx, `
SELECT id::text, email::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND email = $2
   FOR KEY SHARE`, tenantID, email).Scan(&subscriberID, &subscriberEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNoContactForAddress
	}
	if err != nil {
		return "", "", fmt.Errorf("resolve list-member contact: %w", err)
	}
	// A contact row can outlive its address's erasure only when a writer
	// that skipped this check re-created it. Do not compound that.
	erased, err := addressErasedTx(ctx, tx, tenantID, email)
	if err != nil {
		return "", "", err
	}
	if erased {
		return "", "", ErrErasureBlocked
	}
	return subscriberID, subscriberEmail, nil
}

// addressErasedTx reports whether an erasure tombstone protects email in the
// tenant. It is the predicate the subscriber-merge guard applies (migration
// 1769): a per-reason suppression recorded by a privacy deletion or erasure,
// or a send-time suppression written by a privacy deletion. email must be
// trimmed and lower-cased.
func addressErasedTx(ctx context.Context, tx pgx.Tx, tenantID, email string) (bool, error) {
	var erased bool
	err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM email_suppressions es
     WHERE es.tenant_id = $1::uuid
       AND lower(es.email::text) = $2
       AND (lower(COALESCE(es.reason, '')) IN ('dsar_deletion', 'gdpr_erasure')
            OR COALESCE((es.metadata->>'gdpr_erasure')::boolean, false))
    UNION ALL
    SELECT 1
      FROM subscriber_suppressions ss
     WHERE ss.tenant_id = $1::uuid
       AND lower(ss.email::text) = $2
       AND (ss.reason = 'dsar_deletion'
            OR COALESCE((ss.metadata->>'gdpr_erasure')::boolean, false))
)`, tenantID, email).Scan(&erased)
	if err != nil {
		return false, fmt.Errorf("check list-member erasure: %w", err)
	}
	return erased, nil
}

// mintListMemberShellTx resolves email to the tenant's contact, creating a
// fail-closed identity shell when the address is new.
//
// List membership is routing metadata, not permission to send. Resolving an
// existing address must not update its lifecycle, purpose consent, exact
// address state, evidence, or even its user-visible revision timestamp.
//
// Keep INSERT .. DO NOTHING and the fallback SELECT as separate statements.
// PostgreSQL may wait on an uncommitted conflicting insert, but that row is not
// visible to the INSERT statement's original snapshot. The following SELECT
// gets a fresh READ COMMITTED snapshot and therefore resolves the winning
// identity safely under concurrent membership writers.
func mintListMemberShellTx(ctx context.Context, tx pgx.Tx, tenantID, email string) (subscriberID, subscriberEmail string, err error) {
	err = tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, mailchimp_status, consent_source,
    custom_fields, tags, merge_fields, groups, gdpr_permissions
)
VALUES (
    $1::uuid, $2, $2, 'unconfirmed', 'non_subscribed', 'unknown',
    '{}'::jsonb, ARRAY[]::text[], '{}'::jsonb, '[]'::jsonb, '[]'::jsonb
)
ON CONFLICT (tenant_id, email) DO NOTHING
RETURNING id::text, email::text`, tenantID, email).Scan(&subscriberID, &subscriberEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
SELECT id::text, email::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND email = $2`, tenantID, email).Scan(&subscriberID, &subscriberEmail)
	}
	if err != nil {
		return "", "", fmt.Errorf("resolve list-member identity: %w", err)
	}
	return subscriberID, subscriberEmail, nil
}
