package db

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// auditEventNamespace is the deterministic UUIDv5 namespace used to
// derive audit_log.event_id. Must match auditsink.auditNamespace byte-
// for-byte so the worker's DeriveEventID falls back consistently for
// pre-migration rows that have NULL event_id.
//
// Value: hex of "postwave.audit.event_id.v1" sha1-truncated to 16 bytes
// then stamped with UUIDv5 version + variant bits.
var auditEventNamespace = [16]byte{
	0x6d, 0xf5, 0x69, 0xae, 0xc2, 0x8b, 0x4e, 0x52,
	0x9a, 0x0e, 0x21, 0x3d, 0x4c, 0x77, 0x65, 0xb1,
}

// deriveAuditEventID computes the stable event_id used by Standard
// Webhooks signing as the `webhook-id` header. UUIDv5 over the row's
// identity tuple so retries + DLQ replays carry the same idempotency
// key downstream.
func deriveAuditEventID(tenantID, action, resourceType, resourceID, actorLabel string, at time.Time) string {
	h := sha1.New()
	h.Write(auditEventNamespace[:])
	h.Write([]byte(tenantID))
	h.Write([]byte{0x00})
	h.Write([]byte(action))
	h.Write([]byte{0x00})
	h.Write([]byte(resourceType))
	h.Write([]byte{0x00})
	h.Write([]byte(resourceID))
	h.Write([]byte{0x00})
	h.Write([]byte(actorLabel))
	h.Write([]byte{0x00})
	h.Write([]byte(strconv.FormatInt(at.Unix(), 10)))
	sum := h.Sum(nil)
	sum[6] = (sum[6] & 0x0F) | 0x50
	sum[8] = (sum[8] & 0x3F) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		sum[0:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
}

// AuditEventEmitter is a best-effort realtime hook fired synchronously after
// every successful Audit insert and transactional emitter invocation.
//
// The caller still owns the transaction at this point, so this is not a
// post-commit notification: consumers must tolerate notifications for a
// transaction that is later rolled back. main.go installs an implementation
// that publishes audit.created onto the realtime events bus. Kept as a
// function value (rather than an interface) so the db package stays free of
// the events-package import cycle (events imports db indirectly via
// middleware).
type AuditEventEmitter func(tenantID, action, resourceType, resourceID string)

// auditEmitter holds the hook installed by SetAuditEventEmitter. atomic
// pointer so reads from concurrent Audit() calls are race-free.
var auditEmitter atomic.Pointer[AuditEventEmitter]

// AuditTransactionalEmitter is a fail-closed hook for work that must commit
// atomically with the audit row. It receives the caller's transaction, the
// stable audit event ID, and the exact UTC occurrence time used to derive that
// ID. Returning an error makes Audit return an error so the caller can roll
// back the parent transaction.
//
// The hook must use the supplied tx and must not commit or roll it back.
type AuditTransactionalEmitter func(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	action string,
	resourceType string,
	resourceID string,
	eventID string,
	occurredAt time.Time,
) error

// auditTransactionalEmitter holds the hook installed by
// SetAuditTransactionalEmitter. An atomic pointer keeps concurrent Audit()
// calls and startup-time installation race-free.
var auditTransactionalEmitter atomic.Pointer[AuditTransactionalEmitter]

// AuditRedactor is the redaction hook fired BEFORE every audit_log
// insert. Implementations walk metadata applying the tenant's policy
// and return (redactedMetadata, encryptedSideBlob, redactedFieldHashes).
//
// pii-redaction (Compliance, P0): main.go installs an implementation
// that reads audit_redaction_policies + uses the envelope cipher. When
// no redactor is installed (e.g. tests) the audit write degrades to
// the historic behaviour (metadata stored as-is).
//
// Kept as a function value to avoid the import cycle: the redactor
// implementation lives in the audit package, which imports db.
type AuditRedactor func(
	ctx context.Context,
	tenantID string,
	metadata map[string]any,
) (redacted map[string]any, encryptedBlob []byte, hashes map[string]string, err error)

var auditRedactor atomic.Pointer[AuditRedactor]

// SetAuditRedactor installs the pre-insert redaction hook. Pass nil
// to clear (tests). The hook runs synchronously inside Audit(); if it
// returns an error the audit row is still written with the original
// metadata — fail-soft so a redaction misconfig never drops audit
// rows on the floor. (The chain integrity guarantee is the priority.)
func SetAuditRedactor(fn AuditRedactor) {
	if fn == nil {
		auditRedactor.Store(nil)
		return
	}
	auditRedactor.Store(&fn)
}

// SetAuditEventEmitter installs the best-effort realtime hook fired after
// every audit_log insert and successful transactional emitter invocation.
// Pass nil to clear (tests). The hook runs synchronously before the caller
// commits; implementations must NOT block.
func SetAuditEventEmitter(fn AuditEventEmitter) {
	if fn == nil {
		auditEmitter.Store(nil)
		return
	}
	auditEmitter.Store(&fn)
}

// SetAuditTransactionalEmitter installs the fail-closed, in-transaction hook
// fired after every successful audit_log insert. Pass nil to clear (tests).
// Implementations must use the supplied transaction and return any error so
// the caller can roll back all related writes atomically.
func SetAuditTransactionalEmitter(fn AuditTransactionalEmitter) {
	if fn == nil {
		auditTransactionalEmitter.Store(nil)
		return
	}
	auditTransactionalEmitter.Store(&fn)
}

// AuditMeta is the request-scoped metadata that every audit log row needs.
// Callers build this from request context (typically via the middleware
// helpers in apps/api/internal/middleware) and hand it to Audit.
//
// We deliberately do NOT depend on the middleware package here — that would
// create an import cycle because the middleware needs the pool.
type AuditMeta struct {
	TenantID   string  // required; must match the tx's app.tenant_id
	UserID     *string // nullable — system actions have no user
	IP         string  // empty string => NULL
	UserAgent  string  // empty string => NULL
	ActorType  string  // "human" | "agent" | "system" | "platform_operator"; "" => column default
	ActorLabel string  // free-form, e.g. "claude-code"; "" => NULL
	// SessionID is the cookie-derived browser session identifier (audit-2026
	// session-replay-deeplink). Empty string => NULL — system / agent
	// actors have no session.
	SessionID string
	// ClientEventSeq is the monotonic counter the SPA increments per UI
	// action and forwards in the X-Postwave-Event-Seq header. Zero =>
	// NULL.
	ClientEventSeq int64
	// RequestID correlates every audit row produced by ONE request.
	//
	// A single campaign send writes rows across several of the 35 audit tables —
	// the campaign mutation, an approval decision, an entitlement check, an
	// outbox dispatch. Read individually they are 35 answers to questions nobody
	// asked; the question actually asked during an incident is "what happened
	// when I clicked send". chi already generates this id per request and the
	// logger already prints it — it simply never reached an audit row.
	//
	// Empty for a worker with no request context, which must NOT write an empty
	// correlation_id: that would group every unrelated background row into one
	// chain.
	RequestID string
}

// Audit appends a row to audit_log within an existing tenant-scoped tx. The
// caller is expected to have already opened the tx with WithTenant so RLS
// policies are satisfied.
//
//	action        e.g. "subscriber.create", "migration.start"
//	resourceType  free-form, e.g. "subscriber", "migration_job"; "" -> NULL
//	resourceID    domain id of the resource; "" -> NULL
//	metadata      arbitrary JSON-encodable map; nil -> '{}'
func Audit(
	ctx context.Context,
	tx pgx.Tx,
	meta AuditMeta,
	action string,
	resourceType string,
	resourceID string,
	metadata map[string]any,
) error {
	return writeAudit(ctx, tx, meta, action, resourceType, resourceID, metadata, true)
}

// AuditRecordOnly appends a canonical audit_log row without invoking either
// audit event emitter. It is reserved for operations whose defining contract
// permits exactly one external effect: emitting audit.created for the audit
// row would enqueue another outbound webhook and make that operation
// recursive. Redaction and the audit_log insert remain fail-closed and use the
// caller's transaction exactly as Audit does.
func AuditRecordOnly(
	ctx context.Context,
	tx pgx.Tx,
	meta AuditMeta,
	action string,
	resourceType string,
	resourceID string,
	metadata map[string]any,
) error {
	return writeAudit(ctx, tx, meta, action, resourceType, resourceID, metadata, false)
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	meta AuditMeta,
	action string,
	resourceType string,
	resourceID string,
	metadata map[string]any,
	emitEvents bool,
) error {
	if action == "" {
		return fmt.Errorf("db.Audit: action is required")
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	// Persist the request correlation inside the canonical metadata context.
	// The field has been part of AuditMeta for years; failing to merge it here
	// made the request-chain endpoint omit every caller that used db.Audit
	// directly. Preserve any sibling context keys, but the server-generated
	// request id is authoritative for correlation_id.
	if meta.RequestID != "" {
		contextMetadata := map[string]any{}
		if existing, ok := metadata["context"].(map[string]any); ok {
			for key, value := range existing {
				contextMetadata[key] = value
			}
		}
		contextMetadata["correlation_id"] = meta.RequestID
		metadata["context"] = contextMetadata
	}

	var (
		userID      any = nil
		resourceTyp any = nil
		resourceIDv any = nil
		ip          any = nil
		userAgent   any = nil
		actorType   any = "human"
		actorLabel  any = nil
		sessionID   any = nil
		clientSeq   any = nil
	)
	if meta.UserID != nil && *meta.UserID != "" {
		userID = *meta.UserID
	}
	if resourceType != "" {
		resourceTyp = resourceType
	}
	if resourceID != "" {
		resourceIDv = resourceID
	}
	if meta.IP != "" {
		ip = meta.IP
	}
	if meta.UserAgent != "" {
		userAgent = meta.UserAgent
	}
	if meta.ActorType != "" {
		actorType = meta.ActorType
	}
	if meta.ActorLabel != "" {
		actorLabel = meta.ActorLabel
	}
	if meta.SessionID != "" {
		sessionID = meta.SessionID
	}
	if meta.ClientEventSeq > 0 {
		clientSeq = meta.ClientEventSeq
	}

	// Stable webhook idempotency key for this persisted audit row. A fresh UUID
	// is required here: the former second-granularity UUIDv5 identity collapsed
	// two legitimate, identical actions on the same resource within one second
	// into one outbound webhook event. The value is stored on audit_log, so all
	// delivery retries and DLQ replays of this row still reuse it end-to-end.
	//
	// deriveAuditEventID remains below for pre-event_id audit rows consumed by
	// the legacy audit-sink worker; new rows must never use that lossy identity.
	occurredAt := time.Now().UTC()
	eventID := uuid.NewString()

	// pii-redaction (Compliance, P0): apply the tenant's redaction
	// policy before insert. The redactor returns a sanitized metadata
	// map, an encrypted side-blob holding fields with ActionEncrypt
	// rules, and a path -> hash map for fields with ActionHash rules.
	//
	// IMPORTANT: actions starting with "audit.pii_unmask" are the
	// canonical "who decrypted what" trail. We deliberately skip the
	// redactor on those rows — redacting the unmask log itself would
	// defeat the whole purpose of the trail.
	var encryptedBlob []byte
	var hashesJSON []byte
	if h := auditRedactor.Load(); h != nil && *h != nil && action != "audit.pii_unmask" {
		red, enc, hashes, err := (*h)(ctx, meta.TenantID, metadata)
		if err != nil {
			// A configured redaction failure is not permission to store the
			// original payload. Fail the surrounding transaction closed.
			return fmt.Errorf("db: redact audit metadata: %w", err)
		}
		if red != nil {
			metadata = red
		}
		encryptedBlob = enc
		if len(hashes) > 0 {
			hashesJSON, _ = json.Marshal(hashes)
		}
	}

	const q = `
        INSERT INTO audit_log
            (tenant_id, user_id, action, resource_type, resource_id, metadata,
             ip, user_agent, actor_type, actor_label, event_id,
             session_id, client_event_seq,
             metadata_encrypted, redacted_field_hashes)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13,
             $14, COALESCE($15::jsonb, '{}'::jsonb))
    `
	if _, err := tx.Exec(ctx, q,
		meta.TenantID,
		userID,
		action,
		resourceTyp,
		resourceIDv,
		metadata,
		ip,
		userAgent,
		actorType,
		actorLabel,
		eventID,
		sessionID,
		clientSeq,
		encryptedBlob,
		hashesJSON,
	); err != nil {
		return fmt.Errorf("db: write audit_log: %w", err)
	}
	if emitEvents {
		if h := auditTransactionalEmitter.Load(); h != nil && *h != nil {
			if err := (*h)(
				ctx,
				tx,
				meta.TenantID,
				action,
				resourceType,
				resourceID,
				eventID,
				occurredAt,
			); err != nil {
				return fmt.Errorf("db: emit audit event transactionally: %w", err)
			}
		}
		if h := auditEmitter.Load(); h != nil && *h != nil {
			// This remains an in-transaction, best-effort realtime
			// notification. Durable consumers belong in the transactional
			// emitter above.
			(*h)(meta.TenantID, action, resourceType, resourceID)
		}
	}
	return nil
}
