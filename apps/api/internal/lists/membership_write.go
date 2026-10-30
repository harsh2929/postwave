package lists

// AUDIT-DESKTOP-2026-06-10 §A1: list membership WRITE endpoints. The
// desktop Members tab could read membership (members.go) but the
// Add/Remove buttons were disabled because no write surface existed.
//
//	POST   /api/v1/lists/{id}/subscribers           body {"subscriber_ids": [...]}
//	DELETE /api/v1/lists/{id}/subscribers/{sub_id}
//
// Membership lives in the Moosewave-side `list_subscribers` join table
// (migrations 0222 + 0249) — NOT in the Listmonk engine. The lists CRUD
// surface proxies upstream, but membership is gateway-owned (see the
// Repo doc comment in lists.go), so these handlers write Postgres
// directly under RLS via db.WithTenant.
//
// ID semantics (consistent with GetSubscribers in members.go):
//   - {id} (the list) accepts either the Moosewave uuid or the Listmonk
//     bigint; both resolve through list_id_map and 404 unless they name a
//     live list of this tenant (resolveListUUID).
//   - subscriber ids: the subscribers table is uuid-keyed and — unlike
//     lists — has NO bigint<->uuid map (Listmonk-native subscriber ids
//     are never mirrored; the events pipeline correlates by email). A
//     bigint-shaped subscriber id is therefore accepted but can never
//     resolve: POST counts it in "skipped", DELETE no-ops. Anything
//     that is neither a uuid nor an integer is a 400.
//
// Idempotency (documented contract):
//   - POST: adding an existing active member is a no-op success counted
//     in "skipped". Adding a previously removed member revives the row
//     (clears removed_at) and counts in "added" — same semantics as the
//     listmonk_events mirror writer. Response: 200 {"added": n, "skipped": n}.
//   - DELETE: soft-delete (sets removed_at), matching every other
//     membership writer in the gateway. Removing a non-member is a
//     silent no-op — the engine-side mirror (listmonk_events
//     handlers.go) treats unsubscribe-of-non-member exactly that way —
//     so DELETE always returns 204 No Content once the list id
//     resolves. 404 is reserved for a list id that names no live list.

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// operatorMembershipOwnerKeys are the membership-ledger owners an operator
// creates by hand: an add through this API, a bulk add-to-list from the
// subscribers table and a CSV import that named a target list, plus the
// 'legacy:' owners migration 1658 backfilled from memberships those writers
// made before the ledger existed. RemoveMember retires all of them.
//
// An import belongs here because it is a one-shot operator action, like the
// other two: nothing re-runs it, so its owner row must not outlive the
// operator's later decision to remove the member. A live sync's owner
// (an integration, a form) is deliberately NOT in this set — that one keeps the
// membership alive because it would only put it back.
var operatorMembershipOwnerKeys = []string{
	"source:api", "legacy:api",
	"source:admin", "legacy:admin",
	"source:csv",
}

// MembershipOrigin is who asked for an add: it decides the
// list_subscribers.source the growth and source-mix analytics count, and the
// membership-ledger owner that keeps the membership alive.
//
// The add endpoint serves two different callers. A dashboard session has a
// person behind it — the Members tab's Add button — and that is an operator's
// manual add, the same act as the bulk add-to-list from the subscribers table
// ('admin'). A personal-access or stream token is a program ('api'). Both used
// to be written as 'api', so every membership an operator created by hand was
// attributed to the API in list growth, and the Members tab showed them
// "api" — which reads as "something integrated did this".
//
// The distinction comes from the request's auth method (server-side truth), not
// from anything the caller can claim.
type MembershipOrigin struct {
	// Source is a list_subscribers.source value (migration 0249's CHECK).
	Source string
	// OwnerKey is the ledger owner. Every value here must appear in
	// operatorMembershipOwnerKeys, or RemoveMember would answer 204 and leave
	// the membership alive.
	OwnerKey string
	// Owner labels the ledger row's metadata, naming the writer.
	Owner string
}

var (
	// MembershipOriginOperator — a person, in the dashboard.
	MembershipOriginOperator = MembershipOrigin{Source: "admin", OwnerKey: "source:admin", Owner: "list_console"}
	// MembershipOriginAPI — a credentialed program.
	MembershipOriginAPI = MembershipOrigin{Source: "api", OwnerKey: "source:api", Owner: "list_api"}
)

// membershipOriginFor reads the origin off the request's auth method. An
// unauthenticated request cannot reach these handlers; if one ever did, the
// narrower attribution is the API one.
func membershipOriginFor(ctx context.Context) MembershipOrigin {
	if apikeys.AuthMethodFromContext(ctx) == apikeys.AuthMethodSession {
		return MembershipOriginOperator
	}
	return MembershipOriginAPI
}

// maxMembershipBatch caps a single POST. 1000 uuids is ~37 KiB of
// body, comfortably inside listJSONMaxBodyBytes; larger audiences
// should go through the bulk move-to-list path in the subscribers
// package which streams by segment.
const maxMembershipBatch = 1000

var membershipUUIDPattern = regexp.MustCompile(
	`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type addMembersInput struct {
	SubscriberIDs []string `json:"subscriber_ids"`
}

// addMembersResult is the POST response. added = rows newly inserted
// OR revived from a soft-delete; skipped = ids that were already
// active members, didn't resolve to a subscriber in this tenant, or
// were bigint-shaped (unresolvable — see file header).
type addMembersResult struct {
	Added   int `json:"added"`
	Skipped int `json:"skipped"`
}

// classifySubscriberIDs splits the deduped input into uuid-shaped ids
// (resolvable) and bigint-shaped ids (accepted, never resolvable). The
// third return holds anything that is neither — callers 400 on those.
func classifySubscriberIDs(raw []string) (uuids []string, bigints int, bad []string) {
	seen := make(map[string]struct{}, len(raw))
	for _, id := range raw {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		key := strings.ToLower(id)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		switch {
		case membershipUUIDPattern.MatchString(id):
			uuids = append(uuids, id)
		default:
			if _, ok := parseInt64Strict(id); ok {
				bigints++
			} else {
				bad = append(bad, id)
			}
		}
	}
	return uuids, bigints, bad
}

// AddSubscribers handles POST /api/v1/lists/{id}/subscribers.
//
// Body validation runs BEFORE the repo gate so request-shape failures
// surface as 400s even when the Postgres sidecar isn't wired (matches
// how Create validates before touching the upstream).
func (d *Deps) AddSubscribers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}

	var in addMembersInput
	if err := httpbody.DecodeJSON(w, r, listJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	uuids, bigints, bad := classifySubscriberIDs(in.SubscriberIDs)
	if len(bad) > 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_subscriber_ids",
			"subscriber ids must be uuids (or integers, which never match — subscribers have no bigint id map); offending id: "+bad[0]))
		return
	}
	total := len(uuids) + bigints
	if total == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_subscriber_ids", "subscriber_ids required"))
		return
	}
	if total > maxMembershipBatch {
		writeJSON(w, http.StatusBadRequest, errEnv("too_many_subscriber_ids",
			fmt.Sprintf("at most %d subscriber_ids per request", maxMembershipBatch)))
		return
	}

	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	rawID := strings.TrimSpace(chi.URLParam(r, "id"))
	listUUID, err := d.Repo.resolveListUUID(r.Context(), t.ID, rawID)
	if err != nil {
		d.writeListIdentityError(w, r, err)
		return
	}

	added := 0
	origin := membershipOriginFor(r.Context())
	if len(uuids) > 0 {
		added, err = d.Repo.AddMembersAs(r.Context(), t.ID, listUUID, uuids, origin)
		if err != nil {
			// Includes a list deleted after it was resolved above: a 404.
			d.writeListIdentityError(w, r, err)
			return
		}
	}
	out := addMembersResult{Added: added, Skipped: total - added}

	audit.EmitOrLog(r.Context(), d.auditPool(), "list.members_add", "list", rawID,
		nil, map[string]any{
			"subscriber_ids": in.SubscriberIDs,
			"added":          out.Added,
			"skipped":        out.Skipped,
			"source":         origin.Source,
		}, nil)
	writeJSON(w, http.StatusOK, out)
}

// RemoveSubscriber handles DELETE /api/v1/lists/{id}/subscribers/{sub_id}.
// Always 204 once the list id resolves — see file header for the
// no-op-on-non-member decision.
func (d *Deps) RemoveSubscriber(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}

	subID := strings.TrimSpace(chi.URLParam(r, "sub_id"))
	isUUIDShaped := membershipUUIDPattern.MatchString(subID)
	if !isUUIDShaped {
		if _, ok := parseInt64Strict(subID); !ok {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_subscriber_id",
				"sub_id must be a uuid (or an integer, which never matches — subscribers have no bigint id map)"))
			return
		}
	}

	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	rawID := strings.TrimSpace(chi.URLParam(r, "id"))
	listUUID, err := d.Repo.resolveListUUID(r.Context(), t.ID, rawID)
	if err != nil {
		d.writeListIdentityError(w, r, err)
		return
	}

	removed := false
	if isUUIDShaped {
		// Bigint-shaped sub ids skip the UPDATE entirely: they can
		// never match a uuid column, and casting would error.
		removed, err = d.Repo.RemoveMember(r.Context(), t.ID, listUUID, subID)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	if removed {
		audit.EmitOrLog(r.Context(), d.auditPool(), "list.members_remove", "list", rawID,
			nil, map[string]any{"subscriber_id": subID}, nil)
	}
	w.WriteHeader(http.StatusNoContent)
}

// AddMembers upserts memberships for the given subscriber uuids.
// Returns the number of rows newly inserted or revived (added);
// already-active members and ids that don't resolve to a subscriber
// row in this tenant contribute nothing to the count.
//
// The INSERT..SELECT joins through subscribers under RLS, so unknown
// or cross-tenant ids are naturally filtered rather than tripping the
// FK. ON CONFLICT revives soft-deleted rows (removed_at = NULL) but
// leaves active rows untouched (the WHERE on the DO UPDATE), which is
// what lets RETURNING count "added" exactly.
//
// ErrListIDNotMapped means listUUID is not, or is no longer, a live list of
// this tenant; nothing was written.
func (r *Repo) AddMembers(ctx context.Context, tenantID, listUUID string, subscriberIDs []string) (int, error) {
	return r.AddMembersAs(ctx, tenantID, listUUID, subscriberIDs, MembershipOriginAPI)
}

// AddMembersAs is AddMembers with the origin stated: what the membership's
// source and ledger owner record about who added it.
func (r *Repo) AddMembersAs(
	ctx context.Context,
	tenantID, listUUID string,
	subscriberIDs []string,
	origin MembershipOrigin,
) (int, error) {
	if r == nil || r.Pool == nil {
		return 0, fmt.Errorf("lists: repo not configured")
	}
	if len(subscriberIDs) == 0 {
		return 0, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The list is verified in the writing transaction, FOR KEY SHARE: a list
	// deleted since the handler resolved it is ErrListIDNotMapped (a 404),
	// and a deletion that starts now waits and then removes these rows with
	// the rest of the list (retire.go). The engine id is denormalised onto
	// every row, so the subscriber's Lists panel can name the list.
	list, err := ResolveListIdentityTx(ctx, tx, tenantID, listUUID)
	if err != nil {
		return 0, err
	}

	rows, err := tx.Query(ctx, `
WITH input AS (
    SELECT DISTINCT sid FROM unnest($3::uuid[]) AS sid
),
resolved AS (
    SELECT s.id, s.email
      FROM subscribers s
      JOIN input i ON i.sid = s.id
     WHERE s.tenant_id = $1::uuid
),
ins AS (
    INSERT INTO list_subscribers
        (tenant_id, list_id, subscriber_id, listmonk_list_id, email, source, added_at, removed_at)
    SELECT $1::uuid, $2::uuid, r.id, $4, r.email, $5, now(), NULL
      FROM resolved r
    ON CONFLICT (tenant_id, list_id, subscriber_id) DO UPDATE
       SET removed_at       = NULL,
           added_at         = now(),
           source           = EXCLUDED.source,
           email            = COALESCE(EXCLUDED.email, list_subscribers.email),
           listmonk_list_id = COALESCE(EXCLUDED.listmonk_list_id, list_subscribers.listmonk_list_id)
     WHERE list_subscribers.removed_at IS NOT NULL
    RETURNING subscriber_id::text, email::text, list_id::text, source, added_at
),
owners AS (
    INSERT INTO list_subscriber_sources (
        tenant_id, list_id, subscriber_id, email, source, owner_key,
        first_seen_at, last_seen_at, removed_at, metadata
    )
    SELECT $1::uuid, $2::uuid, r.id, r.email, $5, $6,
           now(), now(), NULL, jsonb_build_object('owner', $7::text)
      FROM resolved r
    ON CONFLICT (tenant_id, list_id, subscriber_id, owner_key) DO UPDATE
       SET email = EXCLUDED.email,
           last_seen_at = now(),
           removed_at = NULL
    RETURNING subscriber_id
)
SELECT subscriber_id, email, list_id, source, added_at
  FROM ins`, tenantID, list.UUID, subscriberIDs, list.EngineID,
		origin.Source, origin.OwnerKey, origin.Owner)
	if err != nil {
		return 0, fmt.Errorf("add members: %w", err)
	}
	addedEvents := make([]SubscriberAddedMembership, 0, len(subscriberIDs))
	for rows.Next() {
		var event SubscriberAddedMembership
		if err := rows.Scan(
			&event.SubscriberID,
			&event.Email,
			&event.ListID,
			&event.Source,
			&event.AddedAt,
		); err != nil {
			rows.Close()
			return 0, fmt.Errorf("add members: scan inserted membership: %w", err)
		}
		addedEvents = append(addedEvents, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("add members: read inserted memberships: %w", err)
	}
	if err := r.fireListSubscriberAddedBatch(
		ctx, tx, tenantID, addedEvents,
	); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(addedEvents), nil
}

// RemoveMember soft-deletes one membership row (sets removed_at).
// Returns whether an active row was actually removed; false means the
// subscriber wasn't an active member, which callers treat as a no-op.
//
// The operator's removal retires every OPERATOR owner of the membership —
// operatorMembershipOwnerKeys: an add through this API ('source:api') or a
// bulk add-to-list from the subscribers table ('source:admin'), and their
// pre-ledger 'legacy:' twins. The membership row itself is removed only when no
// other owner (a CRM sync, a form) still claims it. An operator owner left out
// of that set would keep the row alive behind this handler's 204.
func (r *Repo) RemoveMember(ctx context.Context, tenantID, listUUID, subscriberUUID string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, fmt.Errorf("lists: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var removed bool
	err = tx.QueryRow(ctx, `
WITH target AS (
    SELECT ls.list_id, ls.subscriber_id
      FROM list_subscribers ls
     WHERE ls.tenant_id = $1::uuid
       AND ls.list_id = $2::uuid
       AND ls.subscriber_id = $3::uuid
       AND ls.removed_at IS NULL
     FOR UPDATE
),
owner_update AS (
    UPDATE list_subscriber_sources lss
       SET removed_at = now()
      FROM target
     WHERE lss.tenant_id = $1::uuid
       AND lss.list_id = target.list_id
       AND lss.subscriber_id = target.subscriber_id
       AND lss.owner_key = ANY($4::text[])
       AND lss.removed_at IS NULL
    RETURNING 1
),
native_update AS (
    UPDATE list_subscribers ls
       SET removed_at = now()
      FROM target
     WHERE ls.tenant_id = $1::uuid
       AND ls.list_id = target.list_id
       AND ls.subscriber_id = target.subscriber_id
       AND ls.removed_at IS NULL
       AND NOT EXISTS (
           SELECT 1
             FROM list_subscriber_sources active
            WHERE active.tenant_id = ls.tenant_id
              AND active.list_id = ls.list_id
              AND active.subscriber_id = ls.subscriber_id
              AND active.removed_at IS NULL
              AND NOT (active.owner_key = ANY($4::text[]))
       )
    RETURNING 1
)
SELECT EXISTS(SELECT 1 FROM target)`, tenantID, listUUID, subscriberUUID, operatorMembershipOwnerKeys).Scan(&removed)
	if err != nil {
		return false, fmt.Errorf("remove member: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return removed, nil
}
