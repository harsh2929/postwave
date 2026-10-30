// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	pwcrypto "github.com/postwave/postwave/apps/api/internal/crypto"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Signed-ingest secret lifecycle.
//
// The v2 signing secret is an HMAC key: whoever holds it can post conversions
// as this tenant. Until this file, the table existed, the public endpoint
// resolved keys out of it, and there was no way to obtain one except an INSERT
// by hand — so the hardened v2 path was unusable by anyone who was not a DBA.
//
// Two properties shape the API:
//
//  1. The secret is disclosed EXACTLY ONCE, at issuance. Nothing reads it back
//     afterwards. A management endpoint that echoes the key would turn every
//     read-scoped credential into a write-scoped one.
//
//  2. Rotation is overlap-first. A tenant may hold several live keys at once,
//     so the sequence is issue → move traffic → revoke, never a window where
//     their integration has no working key.

const (
	// 32 bytes: the key id is resolved BEFORE the tenant is known (the public
	// endpoint has nothing else to look up by), so it is globally unique and
	// must not be guessable. It is an identifier, not a secret, but a guessable
	// one would let an attacker probe which keys exist.
	ingestKeyIDBytes = 16
	// 32 bytes of HMAC key material, base64 for transport.
	ingestSecretBytes      = 32
	maxSecretLabel         = 128
	MaxLiveIngestKeys      = 8
	DefaultSecretListLimit = 100
	MaxSecretListLimit     = 100
	MaxSecretCursorBytes   = 512
)

var (
	// ErrSecretNotLive covers "no such key", "already revoked", and "belongs to
	// another tenant" with ONE error on purpose. Distinguishing them would let
	// a caller enumerate other tenants' key ids by watching which failure they
	// get back.
	ErrSecretNotLive = errors.New("conversions: no live signing key with that id")

	ErrSecretLabelInvalid            = errors.New("conversions: signing key label is invalid")
	ErrSecretLiveLimit               = errors.New("conversions: live signing key limit reached")
	ErrProjectionMetadataUnavailable = errors.New("conversions: signing key projection metadata unavailable")
)

// IssuedSecret is the ONLY place the secret is ever returned.
type IssuedSecret struct {
	KeyID     string    `json:"key_id"`
	Secret    string    `json:"secret"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"created_at"`
	ProjectionMetadata
}

// SecretSummary is the listable view. It deliberately has no secret field —
// the omission is enforced by the type, not by remembering to strip it.
type SecretSummary struct {
	KeyID     string     `json:"key_id"`
	Label     string     `json:"label"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
	ProjectionMetadata
}

type IngestSecretStore struct {
	Pool   *db.Pool
	Cipher EnvelopeCipher
}

const ingestSecretEnvelopeSentinel = "envelope:do-not-use"
const ingestSecretRevokedTombstone = "revoked:cryptoshredded"

type kmsKeyARNProvider interface {
	KMSKeyARN() string
}

// encodeSecretForStorage is the one write-side policy for conversion ingest
// credentials. Legacy rows may still contain plaintext for compatibility, but
// new issuance is fail-closed unless the platform envelope cipher is present;
// plaintext never reaches the legacy NOT NULL column on this write path.
func (s *IngestSecretStore) encodeSecretForStorage(
	ctx context.Context,
	secret string,
) (legacyValue string, envelope []byte, kmsKeyARN string, err error) {
	if s == nil || s.Cipher == nil {
		return "", nil, "", errors.New("conversions: signing-key envelope encryption is required")
	}
	provider, ok := s.Cipher.(kmsKeyARNProvider)
	if !ok {
		return "", nil, "", errors.New("conversions: signing-key cipher has no immutable KMS provenance")
	}
	kmsKeyARN = strings.TrimSpace(provider.KMSKeyARN())
	if err := pwcrypto.ValidateExactKMSKeyARN(kmsKeyARN, ""); err != nil {
		return "", nil, "", fmt.Errorf("conversions: signing-key KMS provenance: %w", err)
	}
	plaintext := []byte(secret)
	defer zeroSecret(plaintext)
	envelope, err = s.Cipher.Encrypt(ctx, plaintext)
	if err != nil {
		return "", nil, "", fmt.Errorf("conversions: encrypt signing key: %w", err)
	}
	if len(envelope) == 0 {
		return "", nil, "", errors.New("conversions: encrypt signing key returned empty ciphertext")
	}
	if envelope[0] != pwcrypto.VersionEnvelope {
		return "", nil, "", errors.New("conversions: encrypt signing key returned a non-KMS-envelope framing version")
	}
	return ingestSecretEnvelopeSentinel, envelope, kmsKeyARN, nil
}

func normalizeSecretLabel(label string) (string, error) {
	label = strings.TrimSpace(label)
	if utf8.RuneCountInString(label) > maxSecretLabel {
		return "", ErrSecretLabelInvalid
	}
	for _, r := range label {
		// Control characters in a label end up in logs and operator UIs.
		if r < 0x20 || r == 0x7f {
			return "", ErrSecretLabelInvalid
		}
	}
	return label, nil
}

func randomToken(byteLength int, encode func([]byte) string) (string, error) {
	buffer := make([]byte, byteLength)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("conversions: read random: %w", err)
	}
	return encode(buffer), nil
}

// Issue mints a new live signing key and returns the secret for the only time
// it will ever be readable.
func (s *IngestSecretStore) Issue(ctx context.Context, tenantID, label string) (IssuedSecret, error) {
	if s == nil || s.Pool == nil {
		return IssuedSecret{}, errors.New("conversions: ingest secret store requires a database")
	}
	label, err := normalizeSecretLabel(label)
	if err != nil {
		return IssuedSecret{}, err
	}
	keyID, err := randomToken(ingestKeyIDBytes, hex.EncodeToString)
	if err != nil {
		return IssuedSecret{}, err
	}
	secret, err := randomToken(ingestSecretBytes, base64.RawURLEncoding.EncodeToString)
	if err != nil {
		return IssuedSecret{}, err
	}
	legacyValue, envelope, kmsKeyARN, err := s.encodeSecretForStorage(ctx, secret)
	if err != nil {
		return IssuedSecret{}, err
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return IssuedSecret{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	issued := IssuedSecret{KeyID: keyID, Secret: secret, Label: label}
	if err := tx.QueryRow(ctx, `
INSERT INTO conversion_ingest_secrets
    (tenant_id, key_id, label, secret, secret_envelope, secret_kms_key_arn)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
RETURNING created_at`, tenantID, keyID, label, legacyValue, envelope, kmsKeyARN).Scan(&issued.CreatedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) &&
			pgErr.ConstraintName == "conversion_ingest_secrets_live_tenant_limit" {
			return IssuedSecret{}, ErrSecretLiveLimit
		}
		return IssuedSecret{}, fmt.Errorf("conversions: issue signing key: %w", err)
	}
	metadata, err := loadProjectionMetadata(ctx, tx, tenantID, keyID)
	if err != nil {
		return IssuedSecret{}, fmt.Errorf("conversions: load signing-key projection state: %w", err)
	}
	issued.ProjectionMetadata = metadata
	if err := tx.Commit(ctx); err != nil {
		return IssuedSecret{}, err
	}
	return issued, nil
}

type SecretSummaryPage struct {
	Items      []SecretSummary `json:"items"`
	NextCursor string          `json:"next_cursor,omitempty"`
}

// ListPage returns one bounded, stable keyset page. Revoked keys stay listed:
// the row is the lifecycle record, while its credential material has already
// been cryptoshredded.
func (s *IngestSecretStore) ListPage(
	ctx context.Context,
	tenantID string,
	cursor pagination.Cursor,
	limit int,
) (SecretSummaryPage, error) {
	if s == nil || s.Pool == nil {
		return SecretSummaryPage{}, errors.New("conversions: ingest secret store requires a database")
	}
	if limit < 1 || limit > MaxSecretListLimit {
		return SecretSummaryPage{}, pagination.ErrInvalidCursor
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SecretSummaryPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// `secret` is deliberately absent from this projection. It is not selected
	// at all, so there is no value in memory for a later change to leak.
	rows, err := tx.Query(ctx, `
SELECT secret.key_id, secret.label, secret.created_at, secret.revoked_at,
       projection.status, projection.last_error_code,
       projection.updated_at
  FROM conversion_ingest_secrets secret
  LEFT JOIN conversion_email_hmac_projection_states projection
    ON projection.tenant_id = secret.tenant_id
   AND projection.key_id = secret.key_id
 WHERE secret.tenant_id = $1::uuid
   AND ($2::text = '' OR (secret.created_at, secret.key_id) < ($3::timestamptz, $2))
 ORDER BY secret.created_at DESC, secret.key_id DESC
 LIMIT $4`, tenantID, cursor.ID, cursor.SortKey, limit+1)
	if err != nil {
		return SecretSummaryPage{}, fmt.Errorf("conversions: list signing keys: %w", err)
	}
	defer rows.Close()

	summaries := make([]SecretSummary, 0, limit+1)
	for rows.Next() {
		var summary SecretSummary
		var status *string
		var errorCode *string
		var updatedAt *time.Time
		if err := rows.Scan(&summary.KeyID, &summary.Label, &summary.CreatedAt,
			&summary.RevokedAt, &status, &errorCode, &updatedAt); err != nil {
			return SecretSummaryPage{}, fmt.Errorf("conversions: scan signing key: %w", err)
		}
		if status == nil || updatedAt == nil {
			return SecretSummaryPage{}, ErrProjectionMetadataUnavailable
		}
		summary.Status = *status
		summary.UpdatedAt = *updatedAt
		if errorCode != nil {
			summary.ErrorCode = *errorCode
		}
		if !validProjectionMetadata(summary.ProjectionMetadata) {
			return SecretSummaryPage{}, ErrProjectionMetadataUnavailable
		}
		summaries = append(summaries, summary)
	}
	if err := rows.Err(); err != nil {
		return SecretSummaryPage{}, fmt.Errorf("conversions: list signing keys: %w", err)
	}
	summaries, hasMore := pagination.HasMore(summaries, limit)
	nextCursor := ""
	if hasMore {
		last := summaries[len(summaries)-1]
		nextCursor = pagination.Encode(pagination.Cursor{
			SortKey: last.CreatedAt,
			ID:      last.KeyID,
		})
		if nextCursor == "" || len(nextCursor) > MaxSecretCursorBytes {
			return SecretSummaryPage{}, errors.New("conversions: signing-key cursor encoding failed")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return SecretSummaryPage{}, err
	}
	return SecretSummaryPage{Items: summaries, NextCursor: nextCursor}, nil
}

// List is retained for internal callers that expect one closed result. It is
// deliberately capped and fails rather than silently truncating a larger
// catalog; production HTTP callers use ListPage and expose next_cursor.
func (s *IngestSecretStore) List(ctx context.Context, tenantID string) ([]SecretSummary, error) {
	page, err := s.ListPage(ctx, tenantID, pagination.Cursor{}, MaxSecretListLimit)
	if err != nil {
		return nil, err
	}
	if page.NextCursor != "" {
		return nil, errors.New("conversions: signing-key catalog requires pagination")
	}
	return page.Items, nil
}

func loadProjectionMetadata(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, keyID string,
) (ProjectionMetadata, error) {
	var metadata ProjectionMetadata
	err := tx.QueryRow(ctx, `
SELECT status, COALESCE(last_error_code, ''), updated_at
  FROM conversion_email_hmac_projection_states
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, keyID).Scan(
		&metadata.Status, &metadata.ErrorCode, &metadata.UpdatedAt,
	)
	if err != nil {
		return ProjectionMetadata{}, err
	}
	if !validProjectionMetadata(metadata) {
		return ProjectionMetadata{}, errors.New("conversions: invalid projection metadata")
	}
	return metadata, nil
}

// Revoke stops a key resolving. It is an UPDATE, never a DELETE: the public
// resolver admits only rows with revoked_at IS NULL, so setting it is what
// actually disables a leaked credential, and keeping the row is what lets
// someone later answer when it stopped working.
func (s *IngestSecretStore) Revoke(ctx context.Context, tenantID, keyID string) error {
	if s == nil || s.Pool == nil {
		return errors.New("conversions: ingest secret store requires a database")
	}
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return ErrSecretNotLive
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
UPDATE conversion_ingest_secrets
   SET revoked_at = statement_timestamp()
	 WHERE tenant_id = $1::uuid AND key_id = $2 AND revoked_at IS NULL`, tenantID, keyID)
	if err != nil {
		return fmt.Errorf("conversions: revoke signing key: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrSecretNotLive
	}
	return tx.Commit(ctx)
}
