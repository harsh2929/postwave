package lists

// identity.go — the resolver for a list id that arrives from outside.
//
// A list has two identities. Listmonk mints the engine bigint: it is what the
// catalogue (GET /api/v1/lists) keys every row on, so it is the only id the
// web, desktop and mobile pickers hold. Moosewave mints the uuid that
// list_subscribers, list-scoped webhooks and analytics are keyed on.
// list_id_map pairs the two per tenant.
//
// Every surface that takes a list id must accept either form and convert it
// here, inside the caller's own tenant transaction. Binding the raw input
// straight into a `$1::uuid` cast is how the bulk add-to-list verb turned every
// first-party click into a 500 (22P02 on "10") while quietly accepting any
// made-up uuid and writing a membership to a list that did not exist.

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// ListIdentity is one list's pair of identities, resolved for one tenant.
type ListIdentity struct {
	// UUID is the canonical (lower-case, hyphenated) Moosewave list id.
	UUID string
	// EngineID is the Listmonk bigint the catalogue and every client use.
	EngineID int64
}

// ParseListID validates the SHAPE of a public list id without touching the
// database. Exactly one of the results is set: a positive canonical decimal
// engine id, or a canonical uuid. Surrounding whitespace, signs, leading
// zeros and uuid aliases (braces, URNs, raw hex) are rejected rather than
// guessed at, matching the /api/v1/lists/{id}/* routes.
func ParseListID(raw string) (engineID int64, listUUID string, err error) {
	if id, ok := parseInt64Strict(raw); ok {
		return id, "", nil
	}
	listUUID, err = normalizeListUUID(raw)
	if err != nil {
		return 0, "", ErrInvalidListID
	}
	return 0, listUUID, nil
}

// ResolveListIdentityTx resolves a public list id (engine bigint or Moosewave
// uuid) to both identities inside the caller's tenant transaction.
//
// The mapping row is read FOR KEY SHARE. That lock conflicts with the FOR
// UPDATE a list deletion takes before it retires the identity, so a writer
// that resolves the list in the transaction that writes its membership rows
// cannot interleave them with that list's deletion: it either finishes first
// (and the deletion soft-removes what it wrote) or waits, re-reads the retired
// row, and gets ErrListIDNotMapped. The guarantee ends with the transaction:
// a writer must resolve here in its own writing transaction, not rely on a
// resolution made in an earlier one.
//
// Errors: ErrInvalidListID for a malformed id (a 400), ErrListIDNotMapped when
// this tenant has no live list with that id (a 404). A list is never created,
// adopted or guessed at here.
func ResolveListIdentityTx(ctx context.Context, tx pgx.Tx, tenantID, raw string) (ListIdentity, error) {
	engineID, listUUID, err := ParseListID(raw)
	if err != nil {
		return ListIdentity{}, err
	}
	if tx == nil {
		return ListIdentity{}, ErrListsRepoUnavailable
	}
	var out ListIdentity
	if engineID > 0 {
		err = tx.QueryRow(ctx, `
SELECT postwave_uuid::text, listmonk_bigint_id
  FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND listmonk_bigint_id = $2
   FOR KEY SHARE`, tenantID, engineID).Scan(&out.UUID, &out.EngineID)
	} else {
		err = tx.QueryRow(ctx, `
SELECT postwave_uuid::text, listmonk_bigint_id
  FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND postwave_uuid = $2::uuid
   FOR KEY SHARE`, tenantID, listUUID).Scan(&out.UUID, &out.EngineID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ListIdentity{}, ErrListIDNotMapped
	}
	if err != nil {
		return ListIdentity{}, fmt.Errorf("lists: resolve list identity: %w", err)
	}
	return out, nil
}

// listsUnavailableMessage is the copy of every 503 repo_unavailable a lists
// route answers: the list store cannot be reached. It tells the caller what to
// do and nothing about the deployment. A 503 is always answered before any
// change, here or upstream, is made.
const listsUnavailableMessage = "Lists are temporarily unavailable. Try again shortly."

// writeListIdentityError answers a failed list-id resolution the same way on
// every list-scoped route: an unknown or deleted list is a 404, a malformed id
// a 400, and only a genuine infrastructure failure a 5xx. Several handlers used
// to send everything but the 404 to WriteInternal, so /lists/abc/subscribers was
// a 500 and an unmapped list on the CSV routes was a 500 too.
func (d *Deps) writeListIdentityError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrListIDNotMapped):
		writeJSON(w, http.StatusNotFound, errEnv("list_not_found", "list not found"))
	case errors.Is(err, ErrInvalidListID):
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "id must be a positive integer or UUID"))
	case errors.Is(err, ErrListsRepoUnavailable):
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}
