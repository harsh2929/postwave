package subscribers

// SUB-012 — contact → account link.
//
// PATCH /api/v1/subscribers/{id}/account sets (or clears) the canonical
// many-to-one subscribers.account_id FK to the first-class accounts table
// (migration 0438). Passing account_id:null (or omitting it) unlinks the
// contact. The denormalised merge_fields.COMPANY pointer is left untouched
// so the human-readable label survives independently of the join key.
//
// Kept in its own file + route group (not folded into the core
// Create/Update path) so the heavy subscriber upsert SQL is not disturbed
// — assigning an account is a narrow, single-column write.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ErrAccountNotFound is returned by SetAccount when the target account_id
// does not resolve to a tenant-visible account row. Maps to 422 in the
// handler so the caller can tell "no such contact" (404) apart from "no
// such account" (422).
var ErrAccountNotFound = errors.New("account not found")

// AccountLinkInput is the body of PATCH /api/v1/subscribers/{id}/account.
// AccountID nil (or JSON null / omitted) clears the link; a non-empty
// value sets it.
type AccountLinkInput struct {
	AccountID *string `json:"account_id"`
}

// SetAccount sets or clears subscribers.account_id for the tenant-scoped
// subscriber id. accountID == nil clears the link. A non-nil accountID is
// validated against the accounts table inside the same tx so a dangling
// link cannot land (returns ErrAccountNotFound). Returns ErrNotFound when
// the subscriber itself does not exist.
func (r *Repo) SetAccount(
	ctx context.Context,
	tenantID, subscriberID string,
	accountID *string,
	ifMatchToken string,
	auditMeta db.AuditMeta,
) (*Subscriber, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := scanSubscriber(tx.QueryRow(ctx, `
SELECT `+subscriberColumns+`
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 FOR UPDATE`, tenantID, subscriberID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(ifMatchToken) == "" || ifMatchToken != current.Version {
		return nil, ErrPreconditionFailed
	}

	var acctArg any
	targetAccountID := ""
	if accountID != nil && strings.TrimSpace(*accountID) != "" {
		id := strings.TrimSpace(*accountID)
		// Validate the account exists + is tenant-visible before linking.
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM accounts WHERE tenant_id = $1::uuid AND id = $2::uuid)`,
			tenantID, id).Scan(&exists); err != nil {
			if isInvalidUUID(err) {
				return nil, ErrAccountNotFound
			}
			return nil, err
		}
		if !exists {
			return nil, ErrAccountNotFound
		}
		acctArg = id
		targetAccountID = id
	}
	currentAccountID := ""
	if current.AccountID != nil {
		currentAccountID = strings.TrimSpace(*current.AccountID)
	}
	if currentAccountID == targetAccountID {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return current, nil
	}

	row := tx.QueryRow(ctx, `
UPDATE subscribers
   SET account_id = $3::uuid,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
RETURNING `+subscriberColumns, tenantID, current.ID, acctArg)
	sub, err := scanSubscriber(row)
	if err != nil {
		return nil, err
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, sub.ID, ""); err != nil {
		return nil, err
	}
	if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:       tenantID,
			EventType:      EventSubscriberUpdated,
			Body:           sub,
			IdempotencyKey: "subscriber-account-link:" + sub.ID + ":" + sub.Version,
		}); err != nil {
			return nil, fmt.Errorf("dispatch subscriber account-link webhook: %w", err)
		}
	}
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.account_link_changed", "subscriber", sub.ID, map[string]any{
		"previous_account_id": nilIfEmpty(currentAccountID),
		"account_id":          nilIfEmpty(targetAccountID),
		"previous_version":    current.Version,
		"new_version":         sub.Version,
	}); err != nil {
		return nil, fmt.Errorf("audit subscriber account link: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return sub, nil
}

// isInvalidUUID reports whether err is the pg invalid-text-representation
// error (22P02), used to map a malformed account id to not-found rather
// than a 500.
func isInvalidUUID(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}

// MountAccountLinkRoutes registers the contact → account link endpoint.
// Write-subscribers scoped (it mutates the subscriber row).
func MountAccountLinkRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/account", d.SetAccount)
}

// SetAccount PATCH /api/v1/subscribers/{id}/account
func (d *Deps) SetAccount(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if rawIfMatch == "" || rawIfMatch == "*" || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httpcache.WritePreconditionRequired(w)
		return
	}
	token, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard || strings.TrimSpace(token) == "" {
		httpcache.WritePreconditionRequired(w)
		return
	}
	id := chi.URLParam(r, "id")
	var in AccountLinkInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	sub, err := d.Repo.SetAccount(r.Context(), t.ID, id, in.AccountID, token, middleware.AuditMetaFromRequest(r))
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
		case errors.Is(err, ErrAccountNotFound):
			httperror.WriteValidation(w, "account_not_found", "account_id does not resolve to a known account")
		case errors.Is(err, ErrPreconditionFailed):
			httpcache.WritePreconditionFailed(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	d.emit(t.ID, "subscriber.account_linked", map[string]any{"id": sub.ID, "account_id": sub.AccountID})
	w.Header().Set("ETag", sub.Version)
	writeJSON(w, http.StatusOK, sub)
}
