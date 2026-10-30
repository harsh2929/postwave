// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// OutboxKindListmonkSync is the durable canonical-subscriber reconciliation
// event. The payload deliberately carries only the Moosewave subscriber UUID in
// the ordinary case. A previous email is present only for an address rotation
// on a legacy row that has no persisted Listmonk id, because that is the sole
// key capable of locating the pre-rotation external record.
const (
	OutboxKindListmonkSync   = "subscribers.listmonk.sync"
	OutboxKindListmonkDelete = "subscribers.listmonk.delete"
)

// ErrGlobalEngineRequiresSingleTenant is returned before any external call
// when the process-global Listmonk client cannot be proven safe for exactly
// one Moosewave tenant. It is intentionally stable and contains no tenant or
// subscriber identity because the outbox worker persists/logs handler errors.
var ErrGlobalEngineRequiresSingleTenant = errors.New("subscriber engine sync requires a tenant-scoped engine in multi-tenant deployments")

// EngineSyncOutboxAppender is the narrow transactional append surface used by
// Repo. It is locally declared so the repository remains independent of the
// concrete outbox persistence type; main.go owns the adapter.
type EngineSyncOutboxAppender interface {
	Append(ctx context.Context, tx pgx.Tx, in EngineSyncOutboxAppendInput) (string, error)
}

// EngineSyncOutboxBatchAppender is an optional high-throughput extension.
// Production implements it so segment-sized subscriber mutations append all
// reconciliation intents in one database statement. Test fakes and embedders
// that only implement EngineSyncOutboxAppender remain compatible; the helper
// below safely falls back to scalar appends.
type EngineSyncOutboxBatchAppender interface {
	AppendMany(ctx context.Context, tx pgx.Tx, inputs []EngineSyncOutboxAppendInput) error
}

// EngineSyncOutboxAppendInput mirrors the subset of outbox.Append required by
// subscriber synchronization.
type EngineSyncOutboxAppendInput struct {
	TenantID    string
	Kind        string
	Payload     any
	MaxAttempts int
}

// listmonkSyncPayload is intentionally not exported as an API contract. It is
// a private durable row shape shared only by the repository and its worker.
type listmonkSyncPayload struct {
	SubscriberID              string `json:"subscriber_id"`
	PreviousEmail             string `json:"previous_email,omitempty"`
	MergedDuplicateEmail      string `json:"merged_duplicate_email,omitempty"`
	MergedDuplicateListmonkID int64  `json:"merged_duplicate_listmonk_id,omitempty"`
}

// listmonkDeletePayload carries no address or other direct identifier. The
// permanent erasure suppression written in the same transaction is the
// authoritative lookup record for the short-lived external cleanup worker.
type listmonkDeletePayload struct {
	SubscriberID string `json:"subscriber_id"`
}

func (r *Repo) appendEngineSync(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, previousEmail string,
) error {
	if r == nil || r.EngineSyncOutbox == nil {
		return nil
	}
	payload := listmonkSyncPayload{SubscriberID: subscriberID}
	if strings.TrimSpace(previousEmail) != "" {
		payload.PreviousEmail = previousEmail
	}
	if _, err := r.EngineSyncOutbox.Append(ctx, tx, EngineSyncOutboxAppendInput{
		TenantID: tenantID,
		Kind:     OutboxKindListmonkSync,
		Payload:  payload,
	}); err != nil {
		return fmt.Errorf("append subscriber engine sync intent: %w", err)
	}
	return nil
}

// appendEngineMergeSync records external duplicate cleanup and survivor
// reconciliation as one ordered outbox operation.  Keeping the two steps in a
// single handler avoids a retry/reordering window where a duplicate-email
// delete could remove the survivor after Identify selected that address as the
// new canonical email.
func (r *Repo) appendEngineMergeSync(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, previousEmail, duplicateEmail string,
	duplicateListmonkID int64,
) error {
	if r == nil || r.EngineSyncOutbox == nil {
		return nil
	}
	payload := listmonkSyncPayload{
		SubscriberID:              subscriberID,
		PreviousEmail:             previousEmail,
		MergedDuplicateEmail:      duplicateEmail,
		MergedDuplicateListmonkID: duplicateListmonkID,
	}
	if _, err := r.EngineSyncOutbox.Append(ctx, tx, EngineSyncOutboxAppendInput{
		TenantID: tenantID,
		Kind:     OutboxKindListmonkSync,
		Payload:  payload,
	}); err != nil {
		return fmt.Errorf("append subscriber merge engine reconciliation: %w", err)
	}
	return nil
}

func (r *Repo) appendEngineDelete(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID string,
) error {
	if r == nil || r.EngineSyncOutbox == nil {
		return nil
	}
	if _, err := r.EngineSyncOutbox.Append(ctx, tx, EngineSyncOutboxAppendInput{
		TenantID: tenantID,
		Kind:     OutboxKindListmonkDelete,
		Payload:  listmonkDeletePayload{SubscriberID: subscriberID},
	}); err != nil {
		return fmt.Errorf("append subscriber engine delete intent: %w", err)
	}
	return nil
}

func (r *Repo) appendEngineSyncMany(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	subscriberIDs []string,
) error {
	if r == nil || r.EngineSyncOutbox == nil || len(subscriberIDs) == 0 {
		return nil
	}
	inputs := make([]EngineSyncOutboxAppendInput, 0, len(subscriberIDs))
	for _, subscriberID := range subscriberIDs {
		if strings.TrimSpace(subscriberID) == "" {
			continue
		}
		inputs = append(inputs, EngineSyncOutboxAppendInput{
			TenantID: tenantID,
			Kind:     OutboxKindListmonkSync,
			Payload:  listmonkSyncPayload{SubscriberID: subscriberID},
		})
	}
	if batch, ok := r.EngineSyncOutbox.(EngineSyncOutboxBatchAppender); ok {
		if err := batch.AppendMany(ctx, tx, inputs); err != nil {
			return fmt.Errorf("append subscriber engine sync intents: %w", err)
		}
		return nil
	}
	for _, in := range inputs {
		if _, err := r.EngineSyncOutbox.Append(ctx, tx, in); err != nil {
			return fmt.Errorf("append subscriber engine sync intent: %w", err)
		}
	}
	return nil
}

// DurableEngineSyncEnabled reports whether handler-side direct Listmonk calls
// must be disabled. It is exported only to keep the decision in one place for
// compatibility facades that may compose a Deps around this Repo.
func (r *Repo) DurableEngineSyncEnabled() bool {
	return r != nil && r.EngineSyncOutbox != nil
}

// ListmonkSyncHandler reconciles one committed Moosewave subscriber to
// Listmonk. It always reloads the current canonical row, so delayed or
// duplicate events converge to current state rather than replaying a stale
// snapshot from the outbox payload.
type ListmonkSyncHandler struct {
	Repo     *Repo
	Resolver EngineResolver
}

// ListmonkDeleteHandler removes a committed privacy deletion from the
// external delivery engine. It resolves the address and optional persisted
// external id from the permanent suppression created in the same transaction;
// the outbox payload itself therefore never retains erased PII.
type ListmonkDeleteHandler struct {
	Repo     *Repo
	Resolver EngineResolver
}

func (h *ListmonkDeleteHandler) Handle(ctx context.Context, ev outbox.Event) error {
	if h == nil || h.Repo == nil || h.Repo.Pool == nil || h.Resolver == nil {
		return errors.New("subscriber engine delete is not configured")
	}
	if ev.Kind != OutboxKindListmonkDelete {
		return errors.New("subscriber engine delete received an unexpected event kind")
	}
	if _, err := uuid.Parse(ev.TenantID); err != nil {
		return errors.New("subscriber engine delete has an invalid tenant identity")
	}
	var payload listmonkDeletePayload
	if err := json.Unmarshal(ev.Payload, &payload); err != nil {
		return errors.New("subscriber engine delete has an invalid payload")
	}
	if _, err := uuid.Parse(payload.SubscriberID); err != nil {
		return errors.New("subscriber engine delete has an invalid subscriber identity")
	}
	lease, err := h.Resolver.Acquire(ctx, ev.TenantID)
	if err != nil {
		if errors.Is(err, ErrGlobalEngineRequiresSingleTenant) {
			return ErrGlobalEngineRequiresSingleTenant
		}
		return errors.New("subscriber engine delete could not resolve a tenant engine")
	}
	if lease == nil || lease.Engine() == nil {
		if lease != nil {
			_ = lease.Close()
		}
		return errors.New("subscriber engine delete resolved an invalid tenant engine")
	}
	defer func() { _ = lease.Close() }()

	tx, err := db.WithTenant(ctx, h.Repo.Pool, ev.TenantID)
	if err != nil {
		return errors.New("subscriber engine delete could not open tenant state")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(
    hashtextextended('subscriber-listmonk-delete:' || $1::text || ':' || $2::text, 0)
)`, ev.TenantID, payload.SubscriberID); err != nil {
		return errors.New("subscriber engine delete could not serialize the subscriber")
	}
	var email string
	var externalID int64
	if err := tx.QueryRow(ctx, `
SELECT email::text,
       CASE
         WHEN COALESCE(metadata ->> 'listmonk_id', '') ~ '^[1-9][0-9]*$'
         THEN (metadata ->> 'listmonk_id')::bigint
         ELSE 0
       END
  FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND reason = 'dsar_deletion'
   AND metadata ->> 'deleted_subscriber_id' = $2
 ORDER BY COALESCE((metadata ->> 'is_canonical')::boolean, false) DESC,
          email::text
 LIMIT 1`, ev.TenantID, payload.SubscriberID).Scan(&email, &externalID); err != nil {
		return errors.New("subscriber engine delete could not read the erasure tombstone")
	}
	if normalized, err := normalizeEmail(email); err != nil {
		return errors.New("subscriber engine delete tombstone has an invalid address")
	} else {
		email = normalized
	}
	if externalID <= 0 {
		found, err := lease.Engine().FindSubscriberByEmail(ctx, email)
		if err != nil {
			return errors.New("subscriber engine delete could not resolve external state")
		}
		if found == nil {
			return tx.Commit(ctx)
		}
		externalID = found.ID
	}
	if externalID <= 0 {
		return errors.New("subscriber engine delete resolved an invalid external identity")
	}
	if err := lease.Engine().DeleteSubscriber(ctx, externalID); err != nil {
		var httpErr *listmonk.HTTPError
		if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusNotFound {
			return errors.New("subscriber engine delete could not remove external state")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("subscriber engine delete could not commit reconciliation")
	}
	return nil
}

// EngineResolver acquires the external subscriber namespace for one tenant.
// A real multi-tenant deployment should implement this by returning a client
// whose credentials/base URL are owned by tenantID. The current deployment has
// only one process-global Listmonk client, so main.go uses the explicitly named
// SingleTenantGlobalEngineResolver below, which fails closed unless it can hold
// proof that the database contains exactly that one tenant for the entire sync.
type EngineResolver interface {
	Acquire(ctx context.Context, tenantID string) (EngineLease, error)
}

// EngineLease pins any resolver-level tenancy guarantee until Close. A future
// per-tenant resolver can return a no-op lease; the global compatibility
// resolver holds a tenants-table lock so a second tenant cannot race in after
// the count check and before Listmonk mutation.
type EngineLease interface {
	Engine() Engine
	Close() error
}

// SingleTenantGlobalEngineResolver is a fail-closed compatibility guard for a
// process-global Listmonk client. It is not a multi-tenant engine resolver and
// has no acknowledgement/environment bypass. Every acquisition opens fresh
// worker scope, locks tenant creation, and proves there is exactly one tenant
// and that it is the event's tenant before returning the client.
type SingleTenantGlobalEngineResolver struct {
	Pool   *db.Pool
	Engine Engine
}

func (r *SingleTenantGlobalEngineResolver) Acquire(ctx context.Context, tenantID string) (EngineLease, error) {
	if r == nil || r.Pool == nil || r.Engine == nil {
		return nil, errors.New("subscriber engine resolver is not configured")
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return nil, ErrGlobalEngineRequiresSingleTenant
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, errors.New("subscriber engine tenancy proof is unavailable")
	}
	closeTx := func() { _ = tx.Rollback(context.Background()) }
	// SHARE conflicts with tenant INSERT/UPDATE/DELETE (ROW EXCLUSIVE) while
	// remaining compatible across concurrent subscriber-sync workers. This
	// closes the check-then-use race: tenant creation either commits first and
	// makes the proof fail, or waits until this external sync releases its lease.
	if _, err := tx.Exec(ctx, `LOCK TABLE tenants IN SHARE MODE`); err != nil {
		closeTx()
		return nil, errors.New("subscriber engine tenancy proof is unavailable")
	}
	var count int
	var soleTenantID string
	if err := tx.QueryRow(ctx, `
SELECT count(*), COALESCE(max(id::text), '')
  FROM (
        SELECT id
          FROM tenants
         ORDER BY id
         LIMIT 2
       ) bounded_tenants`).Scan(&count, &soleTenantID); err != nil {
		closeTx()
		return nil, errors.New("subscriber engine tenancy proof is unavailable")
	}
	if count != 1 || soleTenantID != tenantID {
		closeTx()
		return nil, ErrGlobalEngineRequiresSingleTenant
	}
	return &globalEngineLease{engine: r.Engine, tx: tx}, nil
}

type globalEngineLease struct {
	engine Engine
	tx     pgx.Tx
	once   sync.Once
	err    error
}

func (l *globalEngineLease) Engine() Engine {
	if l == nil {
		return nil
	}
	return l.engine
}

func (l *globalEngineLease) Close() error {
	if l == nil {
		return nil
	}
	l.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		l.err = l.tx.Rollback(ctx)
		if errors.Is(l.err, pgx.ErrTxClosed) {
			l.err = nil
		}
	})
	return l.err
}

// Handle implements outbox.HandlerFunc.
//
// A tenant+subscriber advisory transaction lock serializes multiple events for
// the same subscriber across worker goroutines and API replicas. The lock is
// intentionally held through the HTTP operation: without it two first-sync
// events could both observe no marker/no external row and create duplicates.
// The transaction changes only the internal marker after the external call.
func (h *ListmonkSyncHandler) Handle(ctx context.Context, ev outbox.Event) error {
	if h == nil || h.Repo == nil || h.Repo.Pool == nil || h.Resolver == nil {
		return errors.New("subscriber engine sync is not configured")
	}
	if ev.Kind != OutboxKindListmonkSync {
		return errors.New("subscriber engine sync received an unexpected event kind")
	}
	if _, err := uuid.Parse(ev.TenantID); err != nil {
		return errors.New("subscriber engine sync has an invalid tenant identity")
	}
	var payload listmonkSyncPayload
	if err := json.Unmarshal(ev.Payload, &payload); err != nil {
		return errors.New("subscriber engine sync has an invalid payload")
	}
	if _, err := uuid.Parse(payload.SubscriberID); err != nil {
		return errors.New("subscriber engine sync has an invalid subscriber identity")
	}
	if payload.PreviousEmail != "" {
		normalized, err := normalizeEmail(payload.PreviousEmail)
		if err != nil {
			return errors.New("subscriber engine sync has an invalid rotation identity")
		}
		payload.PreviousEmail = normalized
	}
	lease, err := h.Resolver.Acquire(ctx, ev.TenantID)
	if err != nil {
		if errors.Is(err, ErrGlobalEngineRequiresSingleTenant) {
			return ErrGlobalEngineRequiresSingleTenant
		}
		return errors.New("subscriber engine sync could not resolve a tenant engine")
	}
	if lease == nil || lease.Engine() == nil {
		if lease != nil {
			_ = lease.Close()
		}
		return errors.New("subscriber engine sync resolved an invalid tenant engine")
	}
	defer func() { _ = lease.Close() }()

	tx, err := db.WithTenant(ctx, h.Repo.Pool, ev.TenantID)
	if err != nil {
		return errors.New("subscriber engine sync could not open tenant state")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(
    hashtextextended('subscriber-listmonk-sync:' || $1::text || ':' || $2::text, 0)
)`, ev.TenantID, payload.SubscriberID); err != nil {
		return errors.New("subscriber engine sync could not serialize the subscriber")
	}

	sub, err := getInTx(ctx, tx, ev.TenantID, payload.SubscriberID)
	if errors.Is(err, ErrNotFound) {
		// A sync event can legitimately become stale after a privacy deletion.
		// Do not recreate an external subscriber from an outbox snapshot. Delete
		// synchronization remains the separate privacy-first handler path.
		return tx.Commit(ctx)
	}
	if err != nil {
		return errors.New("subscriber engine sync could not read canonical state")
	}

	aliases, err := listmonkLookupAliases(ctx, tx, ev.TenantID, sub.ID, sub.Email, payload.PreviousEmail)
	if err != nil {
		return errors.New("subscriber engine sync could not read legacy identities")
	}
	// A merge can leave two external rows. Remove the known duplicate before
	// reconciling the survivor, inside this one retryable handler. When no
	// durable id is known, an email lookup is safe only if that address is not
	// now the survivor's canonical address; otherwise reconcile adopts it.
	if payload.MergedDuplicateListmonkID > 0 &&
		payload.MergedDuplicateListmonkID != listmonkIDFromCustomFields(sub.CustomFields) {
		if err := lease.Engine().DeleteSubscriber(ctx, payload.MergedDuplicateListmonkID); err != nil && !isListmonkNotFound(err) {
			return errors.New("subscriber engine merge could not delete duplicate external state")
		}
	} else if duplicateEmail := strings.TrimSpace(payload.MergedDuplicateEmail); duplicateEmail != "" &&
		!strings.EqualFold(duplicateEmail, sub.Email) {
		found, err := lease.Engine().FindSubscriberByEmail(ctx, duplicateEmail)
		if err != nil {
			return errors.New("subscriber engine merge could not resolve duplicate external state")
		}
		if found != nil && found.ID > 0 && found.ID != listmonkIDFromCustomFields(sub.CustomFields) {
			if err := lease.Engine().DeleteSubscriber(ctx, found.ID); err != nil && !isListmonkNotFound(err) {
				return errors.New("subscriber engine merge could not delete duplicate external state")
			}
		}
	}
	listmonkID, err := h.reconcile(ctx, lease.Engine(), sub, aliases)
	if err != nil {
		// Never return an upstream response body, address, or credential-bearing
		// transport error: outbox errors are persisted and logged by the worker.
		return err
	}
	if listmonkID <= 0 {
		return errors.New("subscriber engine sync returned an invalid external identity")
	}

	// Persist the external identity without calling Repo.Update: that method
	// correctly enqueues ordinary business mutations and would recursively
	// create an infinite stream of sync events for this internal marker write.
	// The conditional avoids an unnecessary physical row update on retries;
	// migration 1758 also keeps this internal-only marker write from changing
	// the public updated_at/ETag version.
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET custom_fields = jsonb_set(
           COALESCE(custom_fields, '{}'::jsonb),
           '{_listmonk_id}',
           to_jsonb($3::text),
           true
       )
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND COALESCE(custom_fields ->> '_listmonk_id', '') <> $3`,
		ev.TenantID, sub.ID, strconv.FormatInt(listmonkID, 10)); err != nil {
		return errors.New("subscriber engine sync could not persist the external identity")
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("subscriber engine sync could not commit reconciliation")
	}
	return nil
}

func (h *ListmonkSyncHandler) reconcile(ctx context.Context, engine Engine, sub *Subscriber, aliases []string) (int64, error) {
	externalStatus := listmonkStatus(sub.Status)
	if sub.ArchivedAt != nil {
		// Archive must withdraw the profile from the external delivery engine
		// even though its canonical Moosewave status is retained for a possible
		// reviewed restore.
		externalStatus = StatusBlocklisted
	}
	req := listmonk.UpdateSubscriberStatusReq{
		Email:   sub.Email,
		Name:    listmonkName(sub),
		Status:  externalStatus,
		Attribs: listmonkAttribs(sub.CustomFields),
		Tags:    append([]string(nil), sub.Tags...),
	}
	if markedID := listmonkIDFromCustomFields(sub.CustomFields); markedID > 0 {
		if err := engine.UpdateSubscriberStatus(ctx, markedID, req); err == nil {
			return markedID, nil
		} else if !isListmonkNotFound(err) {
			return 0, errors.New("subscriber engine sync could not update external state")
		}
		// A legacy marker may point at an externally deleted record. Fall
		// through to email/alias discovery before recreating it.
	}

	for _, candidate := range aliases {
		found, err := engine.FindSubscriberByEmail(ctx, candidate)
		if err != nil {
			return 0, errors.New("subscriber engine sync could not resolve external state")
		}
		if found == nil || found.ID <= 0 {
			continue
		}
		if err := engine.UpdateSubscriberStatus(ctx, found.ID, req); err != nil {
			if isListmonkNotFound(err) {
				continue
			}
			return 0, errors.New("subscriber engine sync could not update external state")
		}
		return found.ID, nil
	}

	created, err := engine.CreateSubscriber(ctx, listmonk.CreateSubscriberReq{
		Email:                   sub.Email,
		Name:                    listmonkName(sub),
		Status:                  externalStatus,
		Attribs:                 listmonkAttribs(sub.CustomFields),
		Tags:                    append([]string(nil), sub.Tags...),
		PreconfirmSubscriptions: sub.Status == StatusEnabled,
	})
	if err != nil {
		return 0, errors.New("subscriber engine sync could not create external state")
	}
	if created == nil || created.ID <= 0 {
		return 0, errors.New("subscriber engine sync received an invalid create result")
	}
	return created.ID, nil
}

func isListmonkNotFound(err error) bool {
	var upstream *listmonk.HTTPError
	return errors.As(err, &upstream) && upstream.StatusCode == http.StatusNotFound
}

func listmonkName(sub *Subscriber) string {
	if sub == nil {
		return ""
	}
	for _, candidate := range []string{
		sub.DisplayName,
		sub.FullName,
		nameFromCustomFields(sub.CustomFields),
		strings.TrimSpace(sub.FirstName + " " + sub.LastName),
	} {
		if candidate = strings.TrimSpace(candidate); candidate != "" {
			return candidate
		}
	}
	return ""
}

func listmonkAttribs(fields map[string]any) map[string]any {
	out := make(map[string]any, len(fields))
	for key, value := range fields {
		if key == listmonkIDField {
			continue
		}
		out[key] = value
	}
	return out
}

// listmonkLookupAliases returns a stable, de-duplicated search order:
// canonical email first, the strictly-needed pre-rotation address second,
// then any legacy multi-email aliases. The payload never needs to carry those
// additional addresses because they are re-read under tenant RLS here.
func listmonkLookupAliases(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, canonical, previous string,
) ([]string, error) {
	out := make([]string, 0, 7)
	seen := make(map[string]struct{}, 7)
	add := func(email string) {
		email = strings.TrimSpace(email)
		if email == "" {
			return
		}
		key := strings.ToLower(email)
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		out = append(out, email)
	}
	add(canonical)
	add(previous)

	rows, err := tx.Query(ctx, `
SELECT email::text
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
 ORDER BY is_primary DESC, created_at DESC, id DESC`, tenantID, subscriberID)
	if err != nil {
		if isUndefinedTable(err) {
			return out, nil
		}
		return nil, err
	}
	defer rows.Close()
	var legacy []string
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		legacy = append(legacy, email)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Stable order is useful when historical rows have equal timestamps and
	// makes retry behaviour deterministic across PostgreSQL plans.
	sort.Strings(legacy)
	for _, email := range legacy {
		add(email)
	}
	return out, nil
}

var _ outbox.HandlerFunc = (&ListmonkSyncHandler{}).Handle
