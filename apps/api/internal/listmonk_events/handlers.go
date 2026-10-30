package listmonk_events

// GAP-LS-044: populate path for native Listmonk subscribe/unsubscribe
// webhooks. Contacts added through Listmonk form/API/CSV ingest must update
// the same list_subscribers source of truth as Moosewave-native list writes.
//
// The helper here is intentionally narrow:
//   - It decodes the envelope just enough to extract the subscriber
//     email + Listmonk bigint list_id + the wire type.
//   - It resolves the Listmonk bigint to the Moosewave list uuid via
//     list_id_map (populated at list-create time, see lists/id_map.go).
//   - It upserts list_subscribers under RLS.
//
// HandleWithMemberships composes this mirror with the established authenticated
// handler without weakening its HMAC/replay gate.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

type membershipBufferedResponse struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func newMembershipBufferedResponse() *membershipBufferedResponse {
	return &membershipBufferedResponse{header: make(http.Header)}
}

func (w *membershipBufferedResponse) Header() http.Header {
	return w.header
}

func (w *membershipBufferedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *membershipBufferedResponse) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(body)
}

func (w *membershipBufferedResponse) flushTo(dst http.ResponseWriter) {
	for key, values := range w.header {
		for _, value := range values {
			dst.Header().Add(key, value)
		}
	}
	status := w.status
	if status == 0 {
		status = http.StatusOK
	}
	dst.WriteHeader(status)
	_, _ = dst.Write(w.body.Bytes())
}

// HandleWithMemberships composes the established authenticated engagement
// ingester with the Listmonk membership mirror. The base handler runs into a
// buffer first, so membership writes are attempted only after HMAC/replay
// validation succeeds. Each membership and its canonical customer-delivery
// intent then commit in the same tenant transaction.
//
// This wrapper deliberately leaves Handle unchanged: its bounce/engagement
// transaction remains independently auditable, while native membership wires
// that Translate does not consume are no longer silently dropped.
func (d *Deps) HandleWithMemberships(
	resolver ListUUIDResolver,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := httpbody.ReadAtMost(r.Body, listmonkEventMaxBodyBytes)
		if err != nil {
			if errors.Is(err, httpbody.ErrTooLarge) {
				writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Listmonk event payload exceeds 1 MiB")
				return
			}
			writeErr(w, http.StatusBadRequest, "bad_body", "request body could not be read")
			return
		}
		_ = r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(raw))

		buffered := newMembershipBufferedResponse()
		d.Handle(buffered, r)
		if buffered.status < http.StatusOK ||
			buffered.status >= http.StatusMultipleChoices {
			buffered.flushTo(w)
			return
		}

		envelopes, err := decodeEnvelopes(raw)
		if err != nil {
			// Handle already returned a validation response for malformed JSON.
			buffered.flushTo(w)
			return
		}
		addAccepted := 0
		for _, envelope := range envelopes {
			event, err := DecodeMembershipEvent(envelope)
			if err != nil {
				writeErr(w, http.StatusBadRequest, "bad_membership_event",
					"Listmonk membership event payload is invalid")
				return
			}
			if event == nil {
				continue
			}
			if _, translateErr := Translate(envelope); translateErr != nil {
				// The base engagement handler intentionally ignores native
				// add/remove wires; include them in the accepted count here.
				addAccepted++
			}
			if _, err := PopulateListMembership(
				r.Context(),
				d.Pool,
				resolver,
				event,
				d.CanonicalWebhooks,
			); err != nil {
				d.log().Error("listmonk_events: membership persistence failed",
					"err", err.Error(), "tenant_id", event.TenantID,
					"type", event.Type)
				writeErr(w, http.StatusInternalServerError, "membership_persist_failed",
					"Listmonk membership event could not be persisted")
				return
			}
		}
		if addAccepted > 0 {
			rewriteMembershipAcceptedCount(buffered, addAccepted)
		}
		buffered.flushTo(w)
	}
}

func rewriteMembershipAcceptedCount(
	response *membershipBufferedResponse,
	delta int,
) {
	if response == nil || delta <= 0 {
		return
	}
	var body map[string]any
	if json.Unmarshal(response.body.Bytes(), &body) != nil {
		return
	}
	accepted, ok := body["accepted"].(float64)
	if !ok {
		return
	}
	body["accepted"] = int(accepted) + delta
	encoded, err := json.Marshal(body)
	if err != nil {
		return
	}
	response.body.Reset()
	_, _ = response.body.Write(encoded)
	response.header.Del("Content-Length")
}

// Listmonk emits these wire types for native subscribe-state changes.
// Constants stay narrow to the populate path so a renamed unrelated
// event doesn't accidentally route into the mirror.
const (
	WireSubscriberSubscribed   = "subscriber.subscribed"
	WireSubscriberUnsubscribed = "subscriber.unsubscribed"
	WireSubscriberRemoved      = "subscriber.removed"
	WireSubscriberAdded        = "subscriber.added"
)

// MembershipEvent is the minimal projection PopulateListMembership reads.
// It mirrors the shape Listmonk attaches to subscribe/remove webhooks
// — see https://listmonk.app/docs/apis/apis/ for the canonical schema.
type MembershipEvent struct {
	Type       string `json:"type"`
	TenantID   string `json:"tenant_id"`
	At         time.Time
	Subscriber struct {
		ID    int64  `json:"id"`
		Email string `json:"email"`
	} `json:"subscriber"`
	List struct {
		ID int64 `json:"id"`
	} `json:"list"`
	SourceEventID string `json:"event_id,omitempty"`
}

// DecodeMembershipEvent extracts a MembershipEvent from a raw
// WebhookEnvelope. Returns (nil, nil) for envelopes whose type isn't a
// membership-relevant one — callers should treat that as "skip", not
// as a failure mode.
func DecodeMembershipEvent(env WebhookEnvelope) (*MembershipEvent, error) {
	switch env.Type {
	case WireSubscriberSubscribed,
		WireSubscriberUnsubscribed,
		WireSubscriberRemoved,
		WireSubscriberAdded:
		// fall through
	default:
		return nil, nil
	}
	out := &MembershipEvent{
		Type:     env.Type,
		TenantID: strings.TrimSpace(env.TenantID),
		At:       env.At,
	}
	if out.At.IsZero() {
		out.At = time.Now().UTC()
	}
	if len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, &out); err != nil {
			return nil, fmt.Errorf("decode membership data: %w", err)
		}
	}
	if envelopeEventID := strings.TrimSpace(
		providerEventIdentifier(env.ProviderEventMetadata),
	); envelopeEventID != "" {
		out.SourceEventID = envelopeEventID
	} else {
		out.SourceEventID = strings.TrimSpace(out.SourceEventID)
	}
	if out.TenantID == "" {
		return nil, ErrInvalidPayload
	}
	if out.List.ID == 0 {
		return nil, ErrInvalidPayload
	}
	out.Subscriber.Email = strings.ToLower(strings.TrimSpace(out.Subscriber.Email))
	if out.Subscriber.Email == "" {
		return nil, ErrInvalidPayload
	}
	return out, nil
}

// ListUUIDResolver maps a Listmonk bigint list id to a Moosewave uuid.
// The lists package satisfies this with GetListUUIDByBigintID. The
// indirection keeps the listmonk_events package free of an import on
// lists — which avoids the package-cycle risk (lists already imports
// db + middleware that this package can pull in transitively).
type ListUUIDResolver interface {
	GetListUUIDByBigintID(ctx context.Context, tenantID string, bigintID int64) (string, error)
}

// PopulateListMembership writes a row into list_subscribers based on a
// decoded native subscribe/remove event. The (tenant, source, source_id)
// unique index (migration 0249) absorbs replayed webhooks; the soft-
// delete column (removed_at) is set for remove/unsubscribe wires so the
// "active members" query naturally drops them.
//
// Returns (true, nil) on a write that mutated state, (false, nil) on a
// no-op skip (resolver miss, subscriber not yet mirrored, etc.).
// Errors are reserved for actual store failures so the webhook handler
// can keep going on a single bad row.
func PopulateListMembership(
	ctx context.Context,
	pool *db.Pool,
	resolver ListUUIDResolver,
	ev *MembershipEvent,
	webhooks TransactionalWebhookFanout,
) (bool, error) {
	if ev == nil {
		return false, nil
	}
	if pool == nil {
		return false, fmt.Errorf("listmonk_events: membership pool unavailable")
	}
	if resolver == nil {
		return false, fmt.Errorf("listmonk_events: nil resolver")
	}

	listUUID, err := resolver.GetListUUIDByBigintID(ctx, ev.TenantID, ev.List.ID)
	if err != nil {
		// Unmapped list id = no Moosewave-side list to mirror against.
		// Bail quietly so the webhook handler still reports `accepted`.
		if errIsNotMapped(err) {
			return false, nil
		}
		return false, err
	}

	tx, err := db.WithTenant(ctx, pool, ev.TenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Look up the Moosewave subscriber row by email (lower-cased; the
	// citext column compares case-insensitively but we keep the lower
	// here so the index plan stays tight).
	var subscriberID string
	err = tx.QueryRow(ctx,
		`SELECT id::text FROM subscribers
		  WHERE tenant_id = $1::uuid AND email = $2`,
		ev.TenantID, ev.Subscriber.Email).Scan(&subscriberID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Subscriber hasn't been mirrored yet. The bulk-mirror path
		// will pick this row up on its next pass; nothing to do here.
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("lookup subscriber: %w", err)
	}

	switch ev.Type {
	case WireSubscriberSubscribed, WireSubscriberAdded:
		if webhooks == nil {
			return false, fmt.Errorf(
				"listmonk_events: canonical membership webhook fanout unavailable",
			)
		}
		// INSERT or revive. Active-member provider retries may refresh mirror
		// metadata but do not create a second membership event. A revival
		// persists a new added_at revision so its source identity differs from
		// the original membership while exact retries converge.
		var (
			persistedSubscriberID string
			persistedEmail        string
			persistedListID       string
			persistedSource       string
			persistedAddedAt      time.Time
			wasAdded              bool
		)
		err = tx.QueryRow(ctx, `
WITH prior_membership AS MATERIALIZED (
    SELECT removed_at
      FROM list_subscribers
     WHERE tenant_id = $1::uuid
       AND list_id = $2::uuid
       AND subscriber_id = $3::uuid
     FOR UPDATE
),
prior_state AS MATERIALIZED (
    SELECT count(*) > 0 AS existed,
           COALESCE(bool_or(removed_at IS NOT NULL), false) AS was_removed
      FROM prior_membership
),
membership AS (
    INSERT INTO list_subscribers (
        tenant_id, list_id, subscriber_id, listmonk_list_id, email,
        source, source_id, added_at, removed_at
    )
    SELECT
        $1::uuid, $2::uuid, $3::uuid, $4, $5,
        'listmonk_event', NULLIF($6, ''), $7, NULL
      FROM prior_state
    ON CONFLICT (list_id, subscriber_id) DO UPDATE
       SET listmonk_list_id = EXCLUDED.listmonk_list_id,
           email            = COALESCE(EXCLUDED.email, list_subscribers.email),
           source_id        = COALESCE(EXCLUDED.source_id, list_subscribers.source_id),
           source           = CASE
               WHEN list_subscribers.removed_at IS NOT NULL THEN EXCLUDED.source
               ELSE list_subscribers.source
           END,
           added_at         = CASE
               WHEN list_subscribers.removed_at IS NOT NULL THEN EXCLUDED.added_at
               ELSE list_subscribers.added_at
           END,
           removed_at       = NULL
    RETURNING subscriber_id::text, email::text, list_id::text, source, added_at
)
SELECT membership.subscriber_id,
       membership.email,
       membership.list_id,
       membership.source,
       membership.added_at,
       (NOT prior_state.existed OR prior_state.was_removed)
  FROM membership
 CROSS JOIN prior_state`,
			ev.TenantID, listUUID, subscriberID, ev.List.ID, ev.Subscriber.Email,
			ev.SourceEventID, ev.At).Scan(
			&persistedSubscriberID,
			&persistedEmail,
			&persistedListID,
			&persistedSource,
			&persistedAddedAt,
			&wasAdded,
		)
		if err != nil {
			return false, fmt.Errorf("upsert membership: %w", err)
		}
		if wasAdded {
			sourceKey := strings.Join([]string{
				"list-membership-added",
				persistedListID,
				persistedSubscriberID,
				persistedAddedAt.UTC().Format(time.RFC3339Nano),
			}, "\x00")
			if _, err := webhooks(ctx, tx, TransactionalWebhookEvent{
				TenantID:      ev.TenantID,
				EventType:     "list.subscriber.added",
				SourceEventID: sourceKey,
				OccurredAt:    persistedAddedAt,
				Body: map[string]any{
					"subscriber_id": persistedSubscriberID,
					"email":         persistedEmail,
					"list_id":       persistedListID,
					"source":        persistedSource,
				},
			}); err != nil {
				return false, fmt.Errorf("persist list subscriber added intent: %w", err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return false, err
		}
		return wasAdded, nil
	case WireSubscriberUnsubscribed, WireSubscriberRemoved:
		var tag pgconn.CommandTag
		tag, err = tx.Exec(ctx, `
UPDATE list_subscribers
   SET removed_at = $4,
       source_id  = COALESCE(NULLIF($5, ''), source_id)
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND subscriber_id = $3::uuid
   AND (removed_at IS NULL OR removed_at < $4)`,
			ev.TenantID, listUUID, subscriberID, ev.At, ev.SourceEventID)
		if err != nil {
			return false, fmt.Errorf("soft-delete membership: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return false, err
		}
		return tag.RowsAffected() > 0, nil
	default:
		return false, nil
	}
}

// errIsNotMapped is a sentinel-bridge so this package doesn't have to
// import lists just to recognise the unmapped-id case. We compare by
// error message because the typed sentinel lives in the lists package
// and importing it would introduce a cycle (lists -> db -> ...).
func errIsNotMapped(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "id not present in list_id_map")
}
