// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	maxPlaygroundReceiptPlaintextBytes = 1536 << 10
	maxPlaygroundReceiptEnvelopeBytes  = 2 << 20
	playgroundReceiptFormatVersion     = 1
	playgroundReceiptPhaseReserved     = "reserved"
	playgroundReceiptPhaseTerminal     = "terminal"
	maxPlaygroundReceiptSubjectEmails  = 512

	// PlaygroundPendingAmbiguityAfter is deliberately much longer than the
	// simulator's receiver and completion timeouts. Once crossed, no process
	// may safely infer that the external request did not happen.
	PlaygroundPendingAmbiguityAfter = 2 * time.Minute
)

var (
	errPlaygroundIdempotencyConflict    = errors.New("outbound_webhooks: playground idempotency conflict")
	errPlaygroundFireIDConflict         = errors.New("outbound_webhooks: playground fire id conflict")
	errPlaygroundSubjectLimit           = errors.New("outbound_webhooks: playground receipt subject-email limit exceeded")
	errPlaygroundSubjectLocatorMismatch = errors.New("outbound_webhooks: playground receipt subject locator mismatch")
)

// playgroundSubjectEmailRE deliberately recognizes the conventional mailbox
// forms accepted throughout Moosewave while scanning the exact serialized
// receipt, including JSON object keys and embedded receiver text. The locator
// is only a discovery aid: receipt content remains envelope-encrypted and the
// locator is removed with that ciphertext by retention or subject erasure.
var playgroundSubjectEmailRE = regexp.MustCompile(
	`(?i)[\p{L}\p{N}.!#$%&'*+/=?^_` + "`" + `{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}.-]{0,251}[\p{L}\p{N}])?`,
)

type playgroundFireRecord struct {
	FireID                string
	WebhookID             string
	EventType             string
	ConfigVersion         int64
	State                 string
	Outcome               string
	DeliveryID            string
	ReceiverStatusCode    int
	ResponseBodyTruncated bool
	CreatedAt             time.Time
	CompletedAt           *time.Time
	ReceiptExpiredAt      *time.Time
	RequestHash           string
	IdempotencyKeyHash    string
	Response              *playgroundFireResponse
}

type playgroundFireReservationInput struct {
	TenantID      string
	StorageKey    string
	RequestHash   string
	FireID        string
	WebhookID     string
	EventType     string
	ConfigVersion int64
	Skeleton      playgroundFireResponse
	AuditMeta     db.AuditMeta
}

type playgroundFireReservation struct {
	Record  playgroundFireRecord
	Created bool
}

type playgroundFireLedger interface {
	RecoverPlaygroundFire(
		ctx context.Context,
		tenantID, storageKey, requestHash string,
	) (*playgroundFireRecord, error)
	ReservePlaygroundFire(
		ctx context.Context,
		input playgroundFireReservationInput,
	) (*playgroundFireReservation, error)
	CompletePlaygroundFire(
		ctx context.Context,
		tenantID, fireID, outcome string,
		receiverStatusCode int,
		responseBodyTruncated bool,
		response playgroundFireResponse,
	) error
	GetPlaygroundFireRecord(
		ctx context.Context,
		tenantID, fireID string,
	) (*playgroundFireRecord, error)
}

func (d *Deps) playgroundFireRepository() playgroundFireLedger {
	if d == nil {
		return nil
	}
	if d.playgroundLedger != nil {
		return d.playgroundLedger
	}
	return d.Store
}

// RecoverPlaygroundFire intentionally needs no parsed request fields. It runs
// before JSON decoding so an exact historical replay survives catalog changes,
// while the raw request digest still rejects any same-key request mutation.
func (s *Store) RecoverPlaygroundFire(
	ctx context.Context,
	tenantID, storageKey, requestHash string,
) (*playgroundFireRecord, error) {
	if s == nil || s.Pool == nil || !validCanonicalUUID(tenantID) ||
		!validPlaygroundStorageKey(storageKey) || !validSHA256Hex(requestHash) {
		return nil, errors.New("outbound_webhooks: invalid playground fire recovery")
	}
	keyHash := playgroundStorageKeyHash(storageKey)
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := markStalePlaygroundFireAmbiguousByKey(ctx, tx, tenantID, keyHash); err != nil {
		return nil, err
	}
	record, responseDigest, responseEnvelope, err := scanPlaygroundFireRecord(
		tx.QueryRow(ctx, playgroundFireRecordSelect+`
 WHERE tenant_id=$1::uuid AND idempotency_key_sha256=$2`, tenantID, keyHash),
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if record.IdempotencyKeyHash != keyHash || record.RequestHash != requestHash {
		// A mismatched replay must not roll back an overdue pending -> ambiguous
		// transition. Persist the no-redispatch fence before returning 422.
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, errPlaygroundIdempotencyConflict
	}
	// Decryption is deliberately outside the transaction. In particular, a
	// corrupt historical envelope cannot roll an overdue ambiguity transition
	// back to pending and reopen misleading reconciliation state.
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if len(responseEnvelope) > 0 {
		response, decodeErr := s.decryptPlaygroundFireResponse(
			ctx, tenantID, record, responseDigest, responseEnvelope,
		)
		if decodeErr != nil {
			return nil, decodeErr
		}
		record.Response = response
	}
	return record, nil
}

func playgroundStorageKeyHash(storageKey string) string {
	sum := sha256.Sum256([]byte("postwave:webhook-playground:key:v1\x00" + storageKey))
	return hex.EncodeToString(sum[:])
}

func validPlaygroundStorageKey(storageKey string) bool {
	return len(storageKey) > 0 && len(storageKey) <= 512 &&
		strings.TrimSpace(storageKey) == storageKey
}

func validSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func (s *Store) ReservePlaygroundFire(
	ctx context.Context,
	input playgroundFireReservationInput,
) (*playgroundFireReservation, error) {
	if s == nil || s.Pool == nil || !validCanonicalUUID(input.TenantID) ||
		!validPlaygroundStorageKey(input.StorageKey) || !validSHA256Hex(input.RequestHash) ||
		!validCanonicalUUID(input.FireID) || !validCanonicalUUID(input.WebhookID) ||
		!IsAllowedEvent(input.EventType) || input.ConfigVersion <= 0 ||
		input.ConfigVersion > MaxWebhookConfigVersion ||
		input.AuditMeta.TenantID != input.TenantID ||
		!validReservedPlaygroundResponse(input.Skeleton, input.FireID) {
		return nil, errors.New("outbound_webhooks: invalid playground fire reservation")
	}
	keyHash := playgroundStorageKeyHash(input.StorageKey)
	binding := playgroundReceiptBinding{
		Phase:              playgroundReceiptPhaseReserved,
		TenantID:           input.TenantID,
		FireID:             input.FireID,
		WebhookID:          input.WebhookID,
		EventType:          input.EventType,
		RequestHash:        input.RequestHash,
		IdempotencyKeyHash: keyHash,
		ConfigVersion:      input.ConfigVersion,
		Response:           input.Skeleton,
	}
	envelope, digest, subjectEmailHashes, err := s.encryptPlaygroundFireResponse(ctx, binding)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, input.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// An already-reserved key owns its frozen receipt even if the endpoint has
	// changed since the concurrent caller's earlier recovery miss. Only a new
	// side-effect identity needs to linearize against the live endpoint row.
	existing, err := lockPlaygroundFireByKey(
		ctx, tx, input.TenantID, keyHash,
	)
	if err != nil {
		return nil, err
	}
	if !existing {
		current, lockErr := lockCurrentPlaygroundWebhook(
			ctx, tx, input.TenantID, input.WebhookID, input.ConfigVersion,
		)
		if lockErr != nil {
			return nil, lockErr
		}
		if !current {
			// Close the narrow race where another reservation committed after
			// our first key lookup but before an endpoint mutation won the row
			// lock. Its frozen receipt still takes precedence over live config.
			existing, lockErr = lockPlaygroundFireByKey(
				ctx, tx, input.TenantID, keyHash,
			)
			if lockErr != nil {
				return nil, lockErr
			}
			if !existing {
				return nil, errPlaygroundWebhookChanged
			}
		}
	}
	var insertedID string
	created := false
	if !existing {
		err = tx.QueryRow(ctx, `
INSERT INTO outbound_webhook_playground_fires
    (tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
     idempotency_key_sha256,request_sha256,event_type,state,
     receipt_envelope,receipt_sha256,subject_email_sha256s)
VALUES ($1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,$5,$6,$7,'pending',$8,$9,$10)
ON CONFLICT DO NOTHING
RETURNING fire_id::text`,
			input.TenantID, input.FireID, input.WebhookID, input.ConfigVersion,
			keyHash, input.RequestHash, input.EventType, envelope, digest,
			subjectEmailHashes,
		).Scan(&insertedID)
		created = err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	if _, err := markStalePlaygroundFireAmbiguousByKey(
		ctx, tx, input.TenantID, keyHash,
	); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, playgroundFireRecordSelect+`
 WHERE tenant_id=$1::uuid AND idempotency_key_sha256=$2
 FOR UPDATE`, input.TenantID, keyHash)
	record, responseDigest, responseEnvelope, err := scanPlaygroundFireRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// Composite primary-key conflict: the fire id exists for this tenant,
		// but it belongs to another logical request/key.
		return nil, errPlaygroundFireIDConflict
	}
	if err != nil {
		return nil, err
	}
	if record.IdempotencyKeyHash != keyHash || record.RequestHash != input.RequestHash ||
		record.FireID != input.FireID || record.WebhookID != input.WebhookID ||
		record.EventType != input.EventType || record.ConfigVersion != input.ConfigVersion {
		if !created {
			// Preserve any overdue ambiguity transition on the conflicting row.
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
		}
		return nil, errPlaygroundIdempotencyConflict
	}
	if created {
		// This precise audit row is in the same transaction as the permanent
		// fire fence. Any redaction or audit insert failure rolls both back
		// before the caller can contact the receiver. Record-only mode prevents
		// audit.created fanout from producing additional receiver calls.
		if err := db.AuditRecordOnly(
			ctx,
			tx,
			input.AuditMeta,
			"outbound_webhook.playground_fire",
			"outbound_webhook",
			input.WebhookID,
			map[string]any{
				"phase":          "reserved",
				"fire_id":        input.FireID,
				"event_type":     input.EventType,
				"config_version": input.ConfigVersion,
			},
		); err != nil {
			return nil, err
		}
	}
	if !created {
		// Existing identities are already durable. Commit stale reconciliation
		// before envelope validation so a damaged receipt cannot revert the row
		// to pending. The copied ciphertext remains safe to decode afterward.
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
	}
	if len(responseEnvelope) > 0 {
		response, decodeErr := s.decryptPlaygroundFireResponse(
			ctx, input.TenantID, record, responseDigest, responseEnvelope,
		)
		if decodeErr != nil {
			return nil, decodeErr
		}
		record.Response = response
	}
	if created {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
	}
	return &playgroundFireReservation{Record: *record, Created: created}, nil
}

func lockPlaygroundFireByKey(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, keyHash string,
) (bool, error) {
	var found bool
	err := tx.QueryRow(ctx, `
SELECT true
  FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND idempotency_key_sha256=$2
 FOR UPDATE`, tenantID, keyHash).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return found, err
}

func lockCurrentPlaygroundWebhook(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, webhookID string,
	configVersion int64,
) (bool, error) {
	var found bool
	err := tx.QueryRow(ctx, `
SELECT true
  FROM outbound_webhooks
 WHERE tenant_id=$1::uuid AND id=$2::uuid
   AND config_version=$3 AND active=true AND deleted_at IS NULL
 FOR SHARE`, tenantID, webhookID, configVersion).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return found, err
}

func (s *Store) CompletePlaygroundFire(
	ctx context.Context,
	tenantID, fireID, outcome string,
	receiverStatusCode int,
	responseBodyTruncated bool,
	response playgroundFireResponse,
) error {
	if s == nil || s.Pool == nil || !validCanonicalUUID(tenantID) ||
		!validCanonicalUUID(fireID) ||
		!validTerminalPlaygroundResponse(
			response, fireID, outcome, receiverStatusCode, responseBodyTruncated,
		) {
		return errors.New("outbound_webhooks: invalid playground fire completion")
	}
	state := "completed"
	if outcome == "transport_ambiguous" {
		state = "ambiguous"
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	stale, err := markStalePlaygroundFireAmbiguousByID(ctx, tx, tenantID, fireID)
	if err != nil {
		return err
	}
	record, storedDigest, _, err := scanPlaygroundFireRecord(tx.QueryRow(
		ctx,
		playgroundFireRecordSelect+`
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid
 FOR UPDATE`,
		tenantID,
		fireID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if stale {
		// A completion arriving after the safety deadline is necessarily too
		// late to disambiguate receiver execution. Persist ambiguity and never
		// replace the recoverable reserved skeleton with a late terminal claim.
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errors.New("outbound_webhooks: playground fire completion conflict")
	}
	binding := playgroundReceiptBinding{
		Phase:              playgroundReceiptPhaseTerminal,
		TenantID:           tenantID,
		FireID:             record.FireID,
		WebhookID:          record.WebhookID,
		EventType:          record.EventType,
		RequestHash:        record.RequestHash,
		IdempotencyKeyHash: record.IdempotencyKeyHash,
		ConfigVersion:      record.ConfigVersion,
		Response:           response,
	}
	envelope, digest, subjectEmailHashes, err := s.encryptPlaygroundFireResponse(ctx, binding)
	if err != nil {
		return err
	}
	if record.State != "pending" {
		if storedDigest == digest && record.State == state && record.Outcome == outcome &&
			record.ReceiverStatusCode == receiverStatusCode &&
			record.ResponseBodyTruncated == responseBodyTruncated {
			return tx.Commit(ctx)
		}
		return errors.New("outbound_webhooks: playground fire completion conflict")
	}
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET state=$3, outcome=$4, receiver_status_code=$5,
       response_body_truncated=$6, receipt_envelope=$7,
       receipt_sha256=$8,
       subject_email_sha256s=$9,
       completed_at=now()
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid AND state='pending'`,
		tenantID, fireID, state, outcome, receiverStatusCode,
		responseBodyTruncated, envelope, digest, subjectEmailHashes)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("outbound_webhooks: playground fire completion conflict")
	}
	// Terminal evidence contains no destination, headers, payload, response, or
	// idempotency material. It commits atomically with the terminal receipt; if
	// audit storage fails, the durable reservation remains pending and later
	// reconciles conservatively to ambiguous instead of claiming completion.
	if err := db.AuditRecordOnly(
		ctx,
		tx,
		db.AuditMeta{
			TenantID:   tenantID,
			ActorType:  "system",
			ActorLabel: "webhook-playground-receipt",
		},
		"outbound_webhook.playground_fire.outcome",
		"outbound_webhook_playground_fire",
		fireID,
		map[string]any{
			"phase":                   "terminal",
			"webhook_id":              record.WebhookID,
			"event_type":              record.EventType,
			"outcome":                 outcome,
			"receiver_status_code":    receiverStatusCode,
			"response_body_truncated": responseBodyTruncated,
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) GetPlaygroundFireRecord(
	ctx context.Context,
	tenantID, fireID string,
) (*playgroundFireRecord, error) {
	if s == nil || s.Pool == nil || !validCanonicalUUID(tenantID) ||
		!validCanonicalUUID(fireID) {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := markStalePlaygroundFireAmbiguousByID(ctx, tx, tenantID, fireID); err != nil {
		return nil, err
	}
	record, _, _, err := scanPlaygroundFireRecord(tx.QueryRow(ctx,
		playgroundFireRecordSelect+`
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, fireID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// Reconciliation exposes only bounded lifecycle metadata. Exact same-key
	// POST recovery owns decryption of the private inspection envelope.
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return record, nil
}

const playgroundFireRecordSelect = `
SELECT fire_id::text,webhook_id::text,event_type,config_version,state,
       COALESCE(outcome,''),'playground-' || fire_id::text,
       COALESCE(receiver_status_code,0),response_body_truncated,created_at,
       completed_at,receipt_expired_at,request_sha256,idempotency_key_sha256,
       COALESCE(receipt_sha256,''),receipt_envelope
  FROM outbound_webhook_playground_fires`

// PlaygroundSubjectReceiptExportLimit bounds one synchronous SAR bundle. The
// returned total/truncated fields make the boundary explicit; a caller must
// never translate truncation into an empty or complete disclosure claim.
const PlaygroundSubjectReceiptExportLimit = 100

// LoadPlaygroundSubjectReceipts returns the encrypted simulator receipts whose
// privacy locator contains the requested email and whose exact decrypted
// plaintext independently reproduces that locator. The lowercased SHA-256
// digest is tenant-scoped by both RLS and the explicit predicate, and is
// cleared whenever the receipt is retained only as a side-effect fence.
func (s *Store) LoadPlaygroundSubjectReceipts(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subjectEmail string,
) ([]map[string]any, int64, bool, error) {
	if s == nil || s.Cipher == nil || tx == nil || !validCanonicalUUID(tenantID) {
		return nil, 0, false, ErrCipherUnconfigured
	}
	normalized := strings.ToLower(strings.TrimSpace(subjectEmail))
	if normalized == "" {
		return []map[string]any{}, 0, false, nil
	}
	digestBytes := sha256.Sum256([]byte(normalized))
	subjectDigest := hex.EncodeToString(digestBytes[:])
	rows, err := tx.Query(ctx, `
SELECT fire_id::text,webhook_id::text,event_type,config_version,state,
       COALESCE(outcome,''),'playground-' || fire_id::text,
       COALESCE(receiver_status_code,0),response_body_truncated,created_at,
       completed_at,receipt_expired_at,request_sha256,idempotency_key_sha256,
       COALESCE(receipt_sha256,''),receipt_envelope,count(*) OVER ()
  FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid
   AND subject_email_sha256s @> ARRAY[$2]::text[]
   AND receipt_envelope IS NOT NULL
 ORDER BY created_at DESC,fire_id DESC
 LIMIT $3`, tenantID, subjectDigest, PlaygroundSubjectReceiptExportLimit+1)
	if err != nil {
		return nil, 0, false, fmt.Errorf("load playground subject receipts: %w", err)
	}
	defer rows.Close()

	exported := make([]map[string]any, 0)
	var total int64
	for rows.Next() {
		var record playgroundFireRecord
		var responseDigest string
		var responseEnvelope []byte
		var rowTotal int64
		if err := rows.Scan(
			&record.FireID, &record.WebhookID, &record.EventType, &record.ConfigVersion,
			&record.State, &record.Outcome, &record.DeliveryID,
			&record.ReceiverStatusCode, &record.ResponseBodyTruncated,
			&record.CreatedAt, &record.CompletedAt, &record.ReceiptExpiredAt,
			&record.RequestHash, &record.IdempotencyKeyHash,
			&responseDigest, &responseEnvelope, &rowTotal,
		); err != nil {
			return nil, 0, false, fmt.Errorf("scan playground subject receipt: %w", err)
		}
		if rowTotal > total {
			total = rowTotal
		}
		response, err := s.decryptPlaygroundFireResponseForSubject(
			ctx, tenantID, &record, responseDigest, responseEnvelope, subjectDigest,
		)
		if err != nil {
			return nil, 0, false, fmt.Errorf("open playground subject receipt: %w", err)
		}
		if len(exported) >= PlaygroundSubjectReceiptExportLimit {
			continue
		}
		exported = append(exported, map[string]any{
			"fire_id":      record.FireID,
			"webhook_id":   record.WebhookID,
			"event_type":   record.EventType,
			"state":        record.State,
			"created_at":   record.CreatedAt,
			"completed_at": record.CompletedAt,
			"receipt":      response,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, 0, false, fmt.Errorf("iterate playground subject receipts: %w", err)
	}
	return exported, total, total > int64(len(exported)), nil
}

func scanPlaygroundFireRecord(row pgx.Row) (
	*playgroundFireRecord, string, []byte, error,
) {
	var record playgroundFireRecord
	var responseDigest string
	var responseEnvelope []byte
	err := row.Scan(
		&record.FireID, &record.WebhookID, &record.EventType, &record.ConfigVersion,
		&record.State, &record.Outcome, &record.DeliveryID,
		&record.ReceiverStatusCode, &record.ResponseBodyTruncated,
		&record.CreatedAt, &record.CompletedAt, &record.ReceiptExpiredAt,
		&record.RequestHash, &record.IdempotencyKeyHash,
		&responseDigest, &responseEnvelope,
	)
	return &record, responseDigest, responseEnvelope, err
}

func markStalePlaygroundFireAmbiguousByKey(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, keyHash string,
) (bool, error) {
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET state='ambiguous', outcome='transport_ambiguous',
       receiver_status_code=0, completed_at=now()
 WHERE tenant_id=$1::uuid AND idempotency_key_sha256=$2
   AND state='pending'
	   AND created_at <= now() - ($3::bigint * interval '1 second')`,
		tenantID, keyHash, int64(PlaygroundPendingAmbiguityAfter/time.Second))
	return err == nil && tag.RowsAffected() == 1, err
}

func markStalePlaygroundFireAmbiguousByID(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, fireID string,
) (bool, error) {
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET state='ambiguous', outcome='transport_ambiguous',
       receiver_status_code=0, completed_at=now()
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid
   AND state='pending'
	   AND created_at <= now() - ($3::bigint * interval '1 second')`,
		tenantID, fireID, int64(PlaygroundPendingAmbiguityAfter/time.Second))
	return err == nil && tag.RowsAffected() == 1, err
}

type playgroundReceiptBinding struct {
	ReceiptFormatVersion int                    `json:"version"`
	Phase                string                 `json:"phase"`
	TenantID             string                 `json:"tenant_id"`
	FireID               string                 `json:"fire_id"`
	WebhookID            string                 `json:"webhook_id"`
	EventType            string                 `json:"event_type"`
	RequestHash          string                 `json:"request_sha256"`
	IdempotencyKeyHash   string                 `json:"idempotency_key_sha256"`
	ConfigVersion        int64                  `json:"config_version"`
	Response             playgroundFireResponse `json:"response"`
}

func (s *Store) encryptPlaygroundFireResponse(
	ctx context.Context,
	binding playgroundReceiptBinding,
) ([]byte, string, []string, error) {
	if s == nil || s.Cipher == nil {
		return nil, "", nil, ErrCipherUnconfigured
	}
	binding.ReceiptFormatVersion = playgroundReceiptFormatVersion
	if !validPlaygroundReceiptBinding(binding) {
		return nil, "", nil, errors.New("outbound_webhooks: invalid playground receipt binding")
	}
	raw, err := json.Marshal(binding)
	if err != nil {
		return nil, "", nil, err
	}
	if len(raw) == 0 || len(raw) > maxPlaygroundReceiptPlaintextBytes {
		return nil, "", nil, errors.New("encrypt playground fire receipt: invalid plaintext size")
	}
	subjectEmailHashes, err := playgroundReceiptSubjectEmailHashes(raw)
	if err != nil {
		return nil, "", nil, err
	}
	digestBytes := sha256.Sum256(raw)
	digest := hex.EncodeToString(digestBytes[:])
	envelope, err := s.Cipher.Encrypt(ctx, raw)
	if err != nil {
		return nil, "", nil, fmt.Errorf("encrypt playground fire receipt: %w", err)
	}
	if len(envelope) == 0 || len(envelope) > maxPlaygroundReceiptEnvelopeBytes {
		return nil, "", nil, errors.New("encrypt playground fire receipt: invalid ciphertext size")
	}
	return envelope, digest, subjectEmailHashes, nil
}

func playgroundReceiptSubjectEmailHashes(raw []byte) ([]string, error) {
	matches := playgroundSubjectEmailRE.FindAll(raw, -1)
	unique := make(map[string]struct{}, len(matches))
	for _, match := range matches {
		normalized := strings.ToLower(strings.TrimSpace(string(match)))
		if normalized == "" {
			continue
		}
		sum := sha256.Sum256([]byte(normalized))
		unique[hex.EncodeToString(sum[:])] = struct{}{}
		if len(unique) > maxPlaygroundReceiptSubjectEmails {
			return nil, errPlaygroundSubjectLimit
		}
	}
	hashes := make([]string, 0, len(unique))
	for digest := range unique {
		hashes = append(hashes, digest)
	}
	sort.Strings(hashes)
	return hashes, nil
}

func (s *Store) decryptPlaygroundFireResponse(
	ctx context.Context,
	tenantID string,
	record *playgroundFireRecord,
	expectedDigest string,
	envelope []byte,
) (*playgroundFireResponse, error) {
	return s.decryptPlaygroundFireResponseForSubject(
		ctx, tenantID, record, expectedDigest, envelope, "",
	)
}

func (s *Store) decryptPlaygroundFireResponseForSubject(
	ctx context.Context,
	tenantID string,
	record *playgroundFireRecord,
	expectedDigest string,
	envelope []byte,
	requiredSubjectDigest string,
) (*playgroundFireResponse, error) {
	if s == nil || s.Cipher == nil || record == nil ||
		!validCanonicalUUID(tenantID) {
		return nil, ErrCipherUnconfigured
	}
	if len(envelope) == 0 || len(envelope) > maxPlaygroundReceiptEnvelopeBytes {
		return nil, errors.New("outbound_webhooks: invalid playground receipt ciphertext")
	}
	raw, err := s.Cipher.Decrypt(ctx, envelope, s.LegacyKEK)
	if err != nil {
		return nil, fmt.Errorf("decrypt playground fire receipt: %w", err)
	}
	if len(raw) == 0 || len(raw) > maxPlaygroundReceiptPlaintextBytes {
		return nil, errors.New("outbound_webhooks: invalid playground receipt plaintext")
	}
	digestBytes := sha256.Sum256(raw)
	if !validSHA256Hex(expectedDigest) ||
		hex.EncodeToString(digestBytes[:]) != expectedDigest {
		return nil, errors.New("outbound_webhooks: playground receipt digest mismatch")
	}
	var binding playgroundReceiptBinding
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&binding); err != nil {
		return nil, errors.New("outbound_webhooks: invalid playground receipt binding")
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("outbound_webhooks: invalid playground receipt binding")
	}
	if binding.ReceiptFormatVersion != playgroundReceiptFormatVersion ||
		!validPlaygroundReceiptBinding(binding) {
		return nil, errors.New("outbound_webhooks: invalid playground receipt binding")
	}
	if binding.TenantID != tenantID || binding.FireID != record.FireID ||
		binding.WebhookID != record.WebhookID || binding.EventType != record.EventType ||
		binding.RequestHash != record.RequestHash ||
		binding.IdempotencyKeyHash != record.IdempotencyKeyHash ||
		binding.ConfigVersion != record.ConfigVersion {
		return nil, errors.New("outbound_webhooks: playground receipt binding mismatch")
	}
	response := binding.Response
	if response.FireID != record.FireID ||
		response.EventID != playgroundEventID(record.FireID) ||
		response.DeliveryID != record.DeliveryID {
		return nil, errors.New("outbound_webhooks: playground receipt row binding mismatch")
	}
	switch binding.Phase {
	case playgroundReceiptPhaseReserved:
		if record.State != "pending" && record.State != "ambiguous" {
			return nil, errors.New("outbound_webhooks: playground receipt phase mismatch")
		}
		if !validReservedPlaygroundResponse(response, record.FireID) {
			return nil, errors.New("outbound_webhooks: invalid reserved playground receipt")
		}
		if record.State == "ambiguous" {
			response.StatusCode = 0
			response.ResponseBody = ""
			response.LatencyMs = 0
			response.Error = "delivery outcome is unknown because durable completion was not recorded before the safety deadline"
			response.Filtered = false
			response.Outcome = "transport_ambiguous"
			response.Ambiguous = true
			response.ResponseBodyTruncated = false
		}
	case playgroundReceiptPhaseTerminal:
		if record.State != "completed" && record.State != "ambiguous" {
			return nil, errors.New("outbound_webhooks: playground receipt phase mismatch")
		}
		if response.Outcome != record.Outcome ||
			response.StatusCode != record.ReceiverStatusCode ||
			response.ResponseBodyTruncated != record.ResponseBodyTruncated ||
			response.Ambiguous != (record.State == "ambiguous") ||
			response.Filtered != (record.Outcome == "filtered") {
			return nil, errors.New("outbound_webhooks: playground receipt row binding mismatch")
		}
	default:
		return nil, errors.New("outbound_webhooks: playground receipt phase mismatch")
	}
	if requiredSubjectDigest != "" {
		if !validSHA256Hex(requiredSubjectDigest) {
			return nil, errPlaygroundSubjectLocatorMismatch
		}
		subjectEmailHashes, err := playgroundReceiptSubjectEmailHashes(raw)
		if err != nil {
			return nil, fmt.Errorf("validate playground receipt subject locator: %w", err)
		}
		index := sort.SearchStrings(subjectEmailHashes, requiredSubjectDigest)
		if index >= len(subjectEmailHashes) || subjectEmailHashes[index] != requiredSubjectDigest {
			return nil, errPlaygroundSubjectLocatorMismatch
		}
	}
	return &response, nil
}

func validPlaygroundReceiptBinding(binding playgroundReceiptBinding) bool {
	if binding.ReceiptFormatVersion != playgroundReceiptFormatVersion ||
		(binding.Phase != playgroundReceiptPhaseReserved &&
			binding.Phase != playgroundReceiptPhaseTerminal) ||
		!validCanonicalUUID(binding.TenantID) || !validCanonicalUUID(binding.FireID) ||
		!validCanonicalUUID(binding.WebhookID) ||
		len(binding.EventType) == 0 || len(binding.EventType) > 200 ||
		strings.TrimSpace(binding.EventType) != binding.EventType ||
		!validSHA256Hex(binding.RequestHash) || !validSHA256Hex(binding.IdempotencyKeyHash) ||
		binding.ConfigVersion <= 0 || binding.ConfigVersion > MaxWebhookConfigVersion {
		return false
	}
	if binding.Phase == playgroundReceiptPhaseReserved {
		return validReservedPlaygroundResponse(binding.Response, binding.FireID)
	}
	return validTerminalPlaygroundResponse(
		binding.Response,
		binding.FireID,
		binding.Response.Outcome,
		binding.Response.StatusCode,
		binding.Response.ResponseBodyTruncated,
	)
}

func validReservedPlaygroundResponse(response playgroundFireResponse, fireID string) bool {
	return response.FireID == fireID && response.EventID == playgroundEventID(fireID) &&
		response.DeliveryID == "playground-"+fireID && response.StatusCode == 0 &&
		response.ResponseBody == "" && response.LatencyMs == 0 && response.Error == "" &&
		!response.Filtered && response.Outcome == "" && !response.Ambiguous &&
		!response.ResponseBodyTruncated && len(response.BodyJSON) <= playgroundMaxPreparedBodyBytes
}

func validTerminalPlaygroundResponse(
	response playgroundFireResponse,
	fireID, outcome string,
	receiverStatusCode int,
	responseBodyTruncated bool,
) bool {
	if response.FireID != fireID || response.EventID != playgroundEventID(fireID) ||
		response.DeliveryID != "playground-"+fireID || response.Outcome != outcome ||
		response.StatusCode != receiverStatusCode ||
		response.ResponseBodyTruncated != responseBodyTruncated ||
		(responseBodyTruncated && response.ResponseBody != "") ||
		len(response.BodyJSON) > playgroundMaxPreparedBodyBytes ||
		len(response.ResponseBody) > MaxResponseBodyBytes || len(response.Error) > 4096 {
		return false
	}
	switch outcome {
	case "filtered":
		return receiverStatusCode == 204 && response.Filtered && !response.Ambiguous
	case "receiver_responded":
		return receiverStatusCode >= 100 && receiverStatusCode <= 599 &&
			!response.Filtered && !response.Ambiguous
	case "transport_ambiguous":
		return receiverStatusCode == 0 && !response.Filtered && response.Ambiguous
	default:
		return false
	}
}
