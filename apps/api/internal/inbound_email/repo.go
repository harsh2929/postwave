// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	ErrNotFound                        = errors.New("inbound_email: not found")
	ErrSecretUnavailable               = errors.New("inbound_email: signing secret unavailable")
	ErrReplayConflict                  = errors.New("inbound_email: event id was reused with different payload")
	ErrInvalidMessageID                = errors.New("inbound_email: invalid outbound message id")
	ErrCanonicalReplyWriterUnavailable = errors.New("inbound_email: canonical reply writer unavailable")
	// ErrAmbiguousMessageID is deliberately retryable at the HTTP boundary. A
	// provider-signed inbound message must not be attached to an arbitrary
	// campaign when two differently formatted outbound Message-IDs resolve to
	// different sends.
	ErrAmbiguousMessageID = errors.New("inbound_email: outbound message id is ambiguous")
)

// Endpoint is the tenant-visible endpoint projection. Secret is populated only
// by RotateSecret's one-shot create/rotation response; reads never decrypt or
// return signing material.
type Endpoint struct {
	ID               string     `json:"id"`
	TenantID         string     `json:"tenantId"`
	Slug             string     `json:"slug"`
	SecretConfigured bool       `json:"secretConfigured"`
	RotationRequired bool       `json:"rotationRequired"`
	SecretRotatedAt  *time.Time `json:"secretRotatedAt,omitempty"`
	Secret           string     `json:"secret,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
}

// Email is one parsed inbound email.
type Email struct {
	ID           int64     `json:"id"`
	TenantID     string    `json:"tenantId"`
	SubscriberID string    `json:"subscriberId,omitempty"`
	CampaignID   string    `json:"campaignId,omitempty"`
	From         string    `json:"from"`
	To           string    `json:"to"`
	Subject      string    `json:"subject"`
	MessageID    string    `json:"messageId,omitempty"`
	InReplyTo    string    `json:"inReplyTo,omitempty"`
	BodyText     string    `json:"bodyText"`
	BodyHTML     string    `json:"bodyHtml"`
	ReceivedAt   time.Time `json:"receivedAt"`

	// ReplyHeaders is the bounded header-first classifier input collected from
	// the authenticated provider envelope. It is transient and must never be
	// serialized through the generic inbound-email API.
	ReplyHeaders map[string]string `json:"-"`
}

// CanonicalReplyWriter is the transaction-owned convergence seam. A campaign-
// linked inbound row is not allowed to commit unless its campaign_replies peer
// and immutable link commit in the same transaction.
type CanonicalReplyWriter interface {
	RequiresWorkerScope() bool
	PersistInboundEmail(
		context.Context,
		pgx.Tx,
		string,
		Email,
		int64,
		string,
		time.Time,
	) (canonicalReplyID string, duplicate bool, err error)
}

// EnvelopeCipher is the narrow platform envelope-encryption boundary used for
// inbound-email signing material. The production implementation is backed by
// AWS KMS; local development uses the configured static envelope key.
type EnvelopeCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// Repo wraps pgx with endpoint + email CRUD. Cipher is mandatory for every
// signing-secret operation; there is intentionally no plaintext fallback.
type Repo struct {
	Pool                 *db.Pool
	Cipher               EnvelopeCipher
	LegacyKEK            []byte
	CanonicalReplyWriter CanonicalReplyWriter
}

func newSlug() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("inbound_email: generate endpoint slug: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

func newSecret() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("inbound_email: generate signing secret: %w", err)
	}
	return "iem_" + hex.EncodeToString(b[:]), nil
}

// GetEndpoint returns metadata for the tenant's endpoint. It never creates an
// endpoint and never loads or decrypts secret_envelope.
func (r *Repo) GetEndpoint(ctx context.Context, tenantID string) (*Endpoint, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ep Endpoint
	row := tx.QueryRow(ctx, `
SELECT id::text,
       tenant_id::text,
       slug,
       COALESCE(octet_length(secret_envelope), 0) > 0,
       COALESCE(octet_length(secret_envelope), 0) = 0,
       secret_rotated_at,
       created_at
FROM inbound_email_endpoints
WHERE tenant_id = $1::uuid LIMIT 1`, tenantID)
	if err := row.Scan(
		&ep.ID,
		&ep.TenantID,
		&ep.Slug,
		&ep.SecretConfigured,
		&ep.RotationRequired,
		&ep.SecretRotatedAt,
		&ep.CreatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ep, nil
}

// RotateSecret creates or rotates the per-tenant signing secret. The plaintext
// is returned once after the encrypted write commits; subsequent GetEndpoint
// calls are metadata-only. A missing or failing cipher aborts before any row is
// changed, so there is no plaintext-at-rest or fail-open mode.
func (r *Repo) RotateSecret(ctx context.Context, tenantID string) (*Endpoint, error) {
	if r == nil || r.Cipher == nil {
		return nil, ErrSecretUnavailable
	}
	slug, err := newSlug()
	if err != nil {
		return nil, err
	}
	secret, err := newSecret()
	if err != nil {
		return nil, err
	}
	envelope, err := r.Cipher.Encrypt(ctx, []byte(secret))
	if err != nil {
		return nil, fmt.Errorf("%w: envelope encryption failed: %v", ErrSecretUnavailable, err)
	}
	if len(envelope) == 0 {
		return nil, fmt.Errorf("%w: envelope encryption returned empty ciphertext", ErrSecretUnavailable)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ep Endpoint
	row := tx.QueryRow(ctx, `
INSERT INTO inbound_email_endpoints
    (tenant_id, slug, secret, secret_envelope, secret_rotated_at)
VALUES
    ($1::uuid, $2, 'rotation-required', $3, now())
ON CONFLICT (tenant_id) DO UPDATE
SET secret = 'rotation-required',
    secret_envelope = EXCLUDED.secret_envelope,
    secret_rotated_at = now()
RETURNING id::text,
          tenant_id::text,
          slug,
          true,
          false,
          secret_rotated_at,
          created_at`, tenantID, slug, envelope)
	if err := row.Scan(
		&ep.ID,
		&ep.TenantID,
		&ep.Slug,
		&ep.SecretConfigured,
		&ep.RotationRequired,
		&ep.SecretRotatedAt,
		&ep.CreatedAt,
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	ep.Secret = secret
	return &ep, nil
}

// LookupBySlug bypasses RLS via the narrow SECURITY DEFINER helper, then
// unwraps the envelope in application memory. Missing envelopes and cipher
// failures are distinguished from unknown slugs so ingest can return 503
// rather than disguising a key-management incident as a 404.
func (r *Repo) LookupBySlug(ctx context.Context, slug string) (id, tenantID string, secret []byte, resultErr error) {
	if strings.TrimSpace(slug) == "" {
		return "", "", nil, ErrNotFound
	}
	if r == nil || r.Cipher == nil {
		return "", "", nil, ErrSecretUnavailable
	}
	var envelope []byte
	row := r.Pool.QueryRow(ctx,
		`SELECT id::text, tenant_id::text, secret_envelope
         FROM inbound_email_endpoint_lookup($1)`, slug)
	if err := row.Scan(&id, &tenantID, &envelope); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", nil, ErrNotFound
		}
		return "", "", nil, err
	}
	if len(envelope) == 0 {
		return "", "", nil, ErrSecretUnavailable
	}
	secret, resultErr = r.Cipher.Decrypt(ctx, envelope, r.LegacyKEK)
	if resultErr != nil {
		return "", "", nil, fmt.Errorf("%w: envelope decryption failed: %v", ErrSecretUnavailable, resultErr)
	}
	if len(secret) == 0 {
		return "", "", nil, fmt.Errorf("%w: envelope decryption returned an empty secret", ErrSecretUnavailable)
	}
	return id, tenantID, secret, nil
}

// SubscriberByEmail returns the subscriber id for from-address, or "".
func (r *Repo) SubscriberByEmail(ctx context.Context, tenantID, email string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	row := tx.QueryRow(ctx, `SELECT id::text FROM subscribers WHERE email = $1::citext LIMIT 1`, email)
	if err := row.Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Commit(ctx)
			return "", nil
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// CampaignByMessageID resolves an RFC Message-ID against the authoritative
// per-recipient delivery ledger. The previous implementation compared the
// Message-ID to subscriber_events.link_url; a URL and an RFC Message-ID are
// unrelated namespaces, so that branch could only match by accident.
//
// Providers inconsistently retain the surrounding angle brackets. We try the
// exact trimmed form and its single bracket-normalized counterpart. If both
// forms exist for different campaigns, attribution fails closed instead of
// choosing whichever row PostgreSQL happens to return first.
func (r *Repo) CampaignByMessageID(ctx context.Context, tenantID, messageID string) (string, error) {
	candidates, err := outboundMessageIDCandidates(messageID)
	if err != nil {
		return "", err
	}
	if len(candidates) == 0 {
		return "", nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ids, err := campaignsByMessageID(ctx, tx, tenantID, candidates)
	if err != nil {
		return "", err
	}
	if len(ids) > 1 {
		return "", ErrAmbiguousMessageID
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	if len(ids) == 0 {
		return "", nil
	}
	return ids[0], nil
}

type messageIDQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func campaignsByMessageID(
	ctx context.Context,
	querier messageIDQuerier,
	tenantID string,
	candidates []string,
) ([]string, error) {
	rows, err := querier.Query(ctx, `
SELECT DISTINCT campaign_id::text
  FROM campaign_send_deliveries
 WHERE tenant_id = $1::uuid
   AND message_id = ANY($2::text[])
 ORDER BY campaign_id::text
	LIMIT 2`, tenantID, candidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, 2)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func outboundMessageIDCandidates(raw string) ([]string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, nil
	}
	if len(value) > 998 || strings.ContainsAny(value, "\r\n\x00") {
		return nil, ErrInvalidMessageID
	}
	bare := value
	if strings.HasPrefix(value, "<") || strings.HasSuffix(value, ">") {
		if len(value) < 3 || value[0] != '<' || value[len(value)-1] != '>' {
			return nil, ErrInvalidMessageID
		}
		bare = strings.TrimSpace(value[1 : len(value)-1])
		if bare == "" || strings.ContainsAny(bare, "<> \t\r\n\x00") || strings.Count(bare, "@") != 1 {
			return nil, ErrInvalidMessageID
		}
	}
	if strings.ContainsAny(bare, "<> \t\r\n\x00") || strings.Count(bare, "@") != 1 {
		return nil, ErrInvalidMessageID
	}
	bracketed := "<" + bare + ">"
	if value == bracketed {
		return []string{value, bare}, nil
	}
	if value == bare {
		return []string{value, bracketed}, nil
	}
	return nil, ErrInvalidMessageID
}

// Insert writes a new inbound_emails row.
func (r *Repo) Insert(ctx context.Context, tenantID string, e Email) (int64, error) {
	id, _, err := r.InsertIdempotent(ctx, tenantID, e, "", "")
	return id, err
}

// InsertIdempotent atomically claims a signed inbound event before any route,
// automation, classifier, or mirror action runs. A duplicate with the same
// payload returns the original row id; reusing an event id for different bytes
// fails closed with ErrReplayConflict.
func (r *Repo) InsertIdempotent(ctx context.Context, tenantID string, e Email, ingestKey, bodyHash string) (int64, bool, error) {
	ingestKey = strings.TrimSpace(ingestKey)
	bodyHash = strings.TrimSpace(bodyHash)
	if ingestKey != "" {
		if !strings.HasPrefix(ingestKey, "event:v1:") || len(ingestKey) != len("event:v1:")+sha256HexLength {
			return 0, false, fmt.Errorf("inbound_email: invalid replay key")
		}
		decoded, err := hex.DecodeString(bodyHash)
		if err != nil || len(decoded) != sha256HexLength/2 {
			return 0, false, fmt.Errorf("inbound_email: invalid replay body hash")
		}
	} else if bodyHash != "" {
		return 0, false, fmt.Errorf("inbound_email: replay body hash requires replay key")
	}
	if e.CampaignID != "" && r.CanonicalReplyWriter == nil {
		return 0, false, ErrCanonicalReplyWriterUnavailable
	}
	var tx pgx.Tx
	var err error
	if r.CanonicalReplyWriter != nil && r.CanonicalReplyWriter.RequiresWorkerScope() {
		tx, err = db.WithTenantWorker(ctx, r.Pool, tenantID)
	} else {
		tx, err = db.WithTenant(ctx, r.Pool, tenantID)
	}
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	var receivedAt time.Time
	isDuplicate := false
	var subID, campID interface{}
	if e.SubscriberID != "" {
		subID = e.SubscriberID
	}
	if e.CampaignID != "" {
		campID = e.CampaignID
	}
	row := tx.QueryRow(ctx, `
INSERT INTO inbound_emails (tenant_id, subscriber_id, campaign_id, from_email,
                             to_email, subject, message_id, in_reply_to,
                             body_text, body_html, ingest_key, ingest_body_sha256)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
        NULLIF($11, ''), NULLIF($12, ''))
ON CONFLICT (tenant_id, ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
RETURNING id, received_at`, tenantID, subID, campID, e.From, e.To, e.Subject,
		e.MessageID, e.InReplyTo, e.BodyText, e.BodyHTML, ingestKey, bodyHash)
	switch scanErr := row.Scan(&id, &receivedAt); {
	case scanErr == nil:
	case errors.Is(scanErr, pgx.ErrNoRows) && ingestKey != "":
		var existingHash string
		if err := tx.QueryRow(ctx, `
SELECT id, COALESCE(ingest_body_sha256, ''), received_at
  FROM inbound_emails
 WHERE tenant_id = $1::uuid AND ingest_key = $2
 LIMIT 1`, tenantID, ingestKey).Scan(&id, &existingHash, &receivedAt); err != nil {
			return 0, false, err
		}
		if !hmac.Equal([]byte(existingHash), []byte(bodyHash)) {
			return 0, false, ErrReplayConflict
		}
		isDuplicate = true
	default:
		return 0, false, scanErr
	}
	if e.CampaignID != "" {
		canonicalID, _, err := r.CanonicalReplyWriter.PersistInboundEmail(
			ctx, tx, tenantID, e, id, ingestKey, receivedAt,
		)
		if err != nil {
			return 0, false, fmt.Errorf("inbound_email: persist canonical reply: %w", err)
		}
		if strings.TrimSpace(canonicalID) == "" {
			return 0, false, errors.New("inbound_email: canonical reply writer returned empty id")
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO inbound_email_campaign_reply_links (
    tenant_id, inbound_email_id, campaign_reply_id, link_method
)
VALUES ($1::uuid, $2, $3::uuid, 'transactional_projection')
ON CONFLICT (tenant_id, inbound_email_id) DO NOTHING`,
			tenantID, id, canonicalID); err != nil {
			return 0, false, fmt.Errorf("inbound_email: link canonical reply: %w", err)
		}
		var linkedID string
		if err := tx.QueryRow(ctx, `
SELECT campaign_reply_id::text
  FROM inbound_email_campaign_reply_links
 WHERE tenant_id = $1::uuid
   AND inbound_email_id = $2`, tenantID, id).Scan(&linkedID); err != nil {
			return 0, false, fmt.Errorf("inbound_email: verify canonical reply link: %w", err)
		}
		if linkedID != canonicalID {
			return 0, false, ErrReplayConflict
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, false, err
	}
	return id, isDuplicate, nil
}

// List returns inbound emails filtered by subscriber/campaign id.
func (r *Repo) List(ctx context.Context, tenantID, subscriberID, campaignID string, limit int) ([]Email, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `SELECT id, tenant_id::text,
              COALESCE(subscriber_id::text, ''),
              COALESCE(campaign_id::text, ''),
              from_email, to_email, subject,
              COALESCE(message_id, ''), COALESCE(in_reply_to, ''),
              body_text, body_html, received_at
         FROM inbound_emails WHERE 1=1`
	args := []any{}
	if subscriberID != "" {
		args = append(args, subscriberID)
		q += ` AND subscriber_id::text = $1`
	}
	if campaignID != "" {
		args = append(args, campaignID)
		q += ` AND campaign_id::text = $` + itoa(len(args))
	}
	q += ` ORDER BY received_at DESC LIMIT ` + itoa(limit)
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Email{}
	for rows.Next() {
		var em Email
		if err := rows.Scan(&em.ID, &em.TenantID, &em.SubscriberID, &em.CampaignID,
			&em.From, &em.To, &em.Subject, &em.MessageID, &em.InReplyTo,
			&em.BodyText, &em.BodyHTML, &em.ReceivedAt); err != nil {
			return nil, err
		}
		out = append(out, em)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
