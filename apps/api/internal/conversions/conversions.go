// SPDX-License-Identifier: AGPL-3.0-only
//
// Package conversions: conversion + revenue-attribution tracking.
//
// Two surfaces:
//
//  1. POST /api/public/track/conversion — public, no-auth, gated by
//     a per-tenant tracking key the tenant ships in their site's JS.
//     Records a conversion fact + (best-effort) attributes to a
//     campaign via campaign_id query param or pw_campaign cookie.
//
//  2. GET /api/v1/conversions — admin read of conversion facts for
//     a tenant. Read-only; mutations only happen via the public
//     ingestion path or backend integrations like Stripe webhooks.
//
// Pixel + JSON: the public endpoint accepts both `image/gif` (1×1
// transparent pixel for `<img src=...>` placement) and a JSON body
// for fetch()-driven uploads. The JSON form carries amount_cents +
// properties; the pixel form is event-name-only ("conversion happened
// for this email at this time").
//
// Attribution: when the conversion request includes a `campaign_id`
// query param OR the request cookies include `pw_campaign`, we
// attribute the conversion to that campaign — both stored on the
// conversion row AND mirrored into campaign_report_events so the
// existing analytics pipeline (digest cron, /campaigns/{id}/report,
// SSE stream) picks it up.
package conversions

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// conversionsMirrorWriteFailures counts mirror-into-campaign_report_events
// failures. The conversion row is the source of truth — the mirror is
// best-effort for the existing analytics pipeline. A non-zero counter
// is the operator's signal that analytics is drifting from reality;
// alert when the rate exceeds the conversions ingestion rate × 1%.
var conversionsMirrorWriteFailures = promauto.NewCounter(prometheus.CounterOpts{
	Name: "conversions_mirror_write_failures_total",
	Help: "Total times Repo.Insert failed to mirror a conversion into campaign_report_events. The conversion row is still written; the analytics pipeline is best-effort.",
})

// 1×1 transparent GIF — sent as the response body when the request
// is an image-tag pixel hit. 43 bytes, GIF89a.
var transparentPixel = []byte{
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
	0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
	0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
	0x44, 0x01, 0x00, 0x3b,
}

const (
	conversionTrackMaxBodyBytes int64 = 64 << 10 // 64 KiB
	maxConversionEventRunes           = 128
	maxTrackingKeyLabelRunes          = 120
	maxConversionEmailBytes           = 320
	maxJavaScriptSafeInteger    int64 = 1<<53 - 1
)

const (
	attributionLookupSavepoint = "conversion_attribution_lookup"
	reportMirrorSavepoint      = "conversion_report_mirror"
)

type savepointExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// runBestEffortInSavepoint makes "best effort" true under PostgreSQL's
// transaction semantics. Any statement error aborts the current transaction
// until ROLLBACK TO SAVEPOINT; merely logging the error and continuing would
// make the final Commit fail and lose the conversion fact.
//
// operationErr is the isolated operation's error and may be safely degraded.
// savepointErr means transaction recovery itself failed, so the caller must
// abort rather than claim the source fact survived.
func runBestEffortInSavepoint(
	ctx context.Context,
	tx savepointExecutor,
	name string,
	operation func() error,
) (operationErr, savepointErr error) {
	if _, err := tx.Exec(ctx, "SAVEPOINT "+name); err != nil {
		return nil, fmt.Errorf("create %s savepoint: %w", name, err)
	}
	operationErr = operation()
	if operationErr != nil {
		if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+name); err != nil {
			return operationErr, fmt.Errorf("rollback %s savepoint: %w", name, err)
		}
	}
	if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT "+name); err != nil {
		return operationErr, fmt.Errorf("release %s savepoint: %w", name, err)
	}
	return operationErr, nil
}

// Conversion is the persisted fact + the JSON shape returned by reads.
type Conversion struct {
	ID              int64  `json:"id"`
	TenantID        string `json:"tenant_id"`
	SubscriberEmail string `json:"subscriber_email,omitempty"`
	EventName       string `json:"event_name"`
	AmountCents     *int64 `json:"amount_cents,omitempty"`
	Currency        string `json:"currency,omitempty"`
	CampaignID      string `json:"campaign_id,omitempty"`
	// AttributedVia records HOW campaign_id was set — honest
	// provenance the desktop surfaces so last-touch is never presented
	// as certain. One of AttributedVia{Explicit,LastTouch,None}; empty
	// only for pre-0397 rows the backfill hasn't classified yet.
	AttributedVia string                 `json:"attributed_via,omitempty"`
	Properties    map[string]interface{} `json:"properties"`
	OccurredAt    time.Time              `json:"occurred_at"`
}

// TrackingKey is the public-facing "site key" tenants ship in JS.
type TrackingKey struct {
	ID        string     `json:"id"`
	TenantID  string     `json:"tenant_id"`
	Label     string     `json:"label"`
	Prefix    string     `json:"prefix"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

// CreateTrackingKeyResponse includes plaintext in the creation result.
// The ordinary key register returns only the prefix; an authenticated outer
// idempotency layer may replay the exact creation result within its TTL.
type CreateTrackingKeyResponse struct {
	Key       TrackingKey `json:"key"`
	Plaintext string      `json:"plaintext"`
}

// IngestInput is the JSON body of POST /api/public/track/conversion.
// The pixel-shaped variant uses query params instead.
type IngestInput struct {
	Email       string                 `json:"email,omitempty"`
	EventName   string                 `json:"event_name"`
	AmountCents *int64                 `json:"amount_cents,omitempty"`
	Currency    string                 `json:"currency,omitempty"`
	Properties  map[string]interface{} `json:"properties,omitempty"`
	// CampaignID, when set, attributes this conversion to a campaign.
	// Auto-populated from the `pw_campaign` cookie or `?c=` query
	// param when the body doesn't include it.
	CampaignID string `json:"campaign_id,omitempty"`
}

// Errors.
//
// Sentinels are split into "operator-safe validation" (echoed to clients
// verbatim via httperror.WriteValidation) and "infrastructure / not-found"
// (routed through httperror.WriteInternal or a static 404 message). Adding
// a new sentinel here requires picking a side intentionally — never echo
// raw pgx error text to the client.
var (
	ErrInvalidKey = errors.New("conversions: invalid tracking key")
	ErrEventName  = errors.New(
		"event_name must be 1 to 128 characters after trimming and contain no control characters",
	)
	ErrInvalidEmail = errors.New(
		"email must be a single exact address of at most 320 bytes",
	)
	ErrInvalidCurrency = errors.New(
		"currency must be exactly 3 ASCII letters when amount_cents is present",
	)
	ErrCurrencyWithoutAmount = errors.New(
		"currency must be omitted when amount_cents is omitted",
	)
	ErrAmountOutOfRange = errors.New(
		"amount_cents must be a JavaScript-safe integer between -9007199254740991 and 9007199254740991",
	)
	ErrTrackingKeyLabel = errors.New(
		"label must be at most 120 characters after trimming and contain no control characters",
	)
	ErrInvalidCursor = errors.New("conversions: invalid cursor")
	// ErrTrackingKeyNotFound is returned by RevokeTrackingKey when no row
	// matches the (tenant_id, id, revoked_at IS NULL) predicate. Distinct
	// sentinel so the handler can map it to a 404 with a static message
	// without confusing it with a pgx infrastructure failure.
	ErrTrackingKeyNotFound = errors.New("conversions: tracking key not found")
)

// normalizeIngestInput applies the conversion wire contract at the repository
// boundary so every caller (public JSON, pixel query parameters, and trusted
// backend integrations) gets the same limits. Event and label limits count
// Unicode code points for tenant naming compatibility; email's published
// maximum is byte-based.
func normalizeIngestInput(in IngestInput) (IngestInput, error) {
	eventName := strings.TrimSpace(in.EventName)
	if !utf8.ValidString(eventName) ||
		utf8.RuneCountInString(eventName) < 1 ||
		utf8.RuneCountInString(eventName) > maxConversionEventRunes ||
		containsControlCharacter(eventName) {
		return IngestInput{}, ErrEventName
	}

	email := strings.TrimSpace(in.Email)
	if email != "" {
		if !utf8.ValidString(email) || len(email) > maxConversionEmailBytes {
			return IngestInput{}, ErrInvalidEmail
		}
		parsed, err := mail.ParseAddress(email)
		at := strings.LastIndexByte(email, '@')
		if err != nil ||
			parsed == nil ||
			at <= 0 ||
			at == len(email)-1 ||
			parsed.Name != "" ||
			parsed.Address != email {
			return IngestInput{}, ErrInvalidEmail
		}
	}

	currency := strings.ToUpper(strings.TrimSpace(in.Currency))
	if in.AmountCents == nil {
		if currency != "" {
			return IngestInput{}, ErrCurrencyWithoutAmount
		}
	} else {
		if *in.AmountCents < -maxJavaScriptSafeInteger ||
			*in.AmountCents > maxJavaScriptSafeInteger {
			return IngestInput{}, ErrAmountOutOfRange
		}
		if len(currency) != 3 ||
			currency[0] < 'A' || currency[0] > 'Z' ||
			currency[1] < 'A' || currency[1] > 'Z' ||
			currency[2] < 'A' || currency[2] > 'Z' {
			return IngestInput{}, ErrInvalidCurrency
		}
	}

	in.EventName = eventName
	in.Email = email
	in.Currency = currency
	return in, nil
}

// normalizePublicIngestInput preserves the public tracker's documented
// default while keeping the repository invariant strict: a missing or
// whitespace-only public event becomes "conversion"; direct Repo.Insert
// callers must provide a non-empty event name.
func normalizePublicIngestInput(in IngestInput) (IngestInput, error) {
	if strings.TrimSpace(in.EventName) == "" {
		in.EventName = "conversion"
	}
	return normalizeIngestInput(in)
}

func normalizeTrackingKeyLabel(label string) (string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "web", nil
	}
	if !utf8.ValidString(label) ||
		utf8.RuneCountInString(label) > maxTrackingKeyLabelRunes ||
		containsControlCharacter(label) {
		return "", ErrTrackingKeyLabel
	}
	return label, nil
}

func containsControlCharacter(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func isIngestValidationError(err error) bool {
	return errors.Is(err, ErrEventName) ||
		errors.Is(err, ErrInvalidEmail) ||
		errors.Is(err, ErrInvalidCurrency) ||
		errors.Is(err, ErrCurrencyWithoutAmount) ||
		errors.Is(err, ErrAmountOutOfRange)
}

// Repo wraps the pgx pool with conversion CRUD + key resolution.
type Repo struct {
	// Cipher decrypts secret_envelope at signed-ingest read time. A nil cipher
	// can read only pre-envelope legacy rows; new issuance is always
	// envelope-encrypted and fails closed without a cipher.
	Cipher    EnvelopeCipher
	LegacyKEK []byte
	Pool      *db.Pool
}

// NewTrackingKey returns a fresh plaintext key prefixed with `pwk_`
// so it can be visually distinguished from API keys (`pw_live_…`)
// in logs.
func NewTrackingKey() (plaintext, prefix string, err error) {
	var buf [24]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", "", fmt.Errorf("rand: %w", err)
	}
	plaintext = "pwk_" + hex.EncodeToString(buf[:])
	prefix = plaintext[:12]
	return plaintext, prefix, nil
}

// HashTrackingKey hashes the plaintext for storage. Same algorithm
// as api_keys (SHA-256) — they share a threat model + pepper isn't
// strictly required because tracking keys are intended to be public.
func HashTrackingKey(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// ListTrackingKeys returns the tenant's keys (no plaintext).
func (r *Repo) ListTrackingKeys(ctx context.Context, tenantID string) ([]TrackingKey, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, label, prefix, revoked_at, created_at
  FROM conversion_tracking_keys
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TrackingKey{}
	for rows.Next() {
		var k TrackingKey
		if err := rows.Scan(&k.ID, &k.TenantID, &k.Label, &k.Prefix, &k.RevokedAt, &k.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateTrackingKey mints a new key and includes its plaintext in the
// creation response. The ordinary key register never returns plaintext.
func (r *Repo) CreateTrackingKey(ctx context.Context, tenantID, label string) (*CreateTrackingKeyResponse, error) {
	label, err := normalizeTrackingKeyLabel(label)
	if err != nil {
		return nil, err
	}
	plaintext, prefix, err := NewTrackingKey()
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var k TrackingKey
	row := tx.QueryRow(ctx, `
INSERT INTO conversion_tracking_keys (tenant_id, label, prefix, key_hash)
VALUES ($1::uuid, $2, $3, $4)
RETURNING id::text, tenant_id::text, label, prefix, revoked_at, created_at`,
		tenantID, label, prefix, HashTrackingKey(plaintext))
	if err := row.Scan(&k.ID, &k.TenantID, &k.Label, &k.Prefix, &k.RevokedAt, &k.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CreateTrackingKeyResponse{Key: k, Plaintext: plaintext}, nil
}

// RevokeTrackingKey marks revoked_at; the public-track handler
// rejects (404) thereafter. Returns ErrTrackingKeyNotFound when no
// row matches the (tenant_id, id, not-yet-revoked) predicate so the
// handler can disambiguate from infrastructure failures.
func (r *Repo) RevokeTrackingKey(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`UPDATE conversion_tracking_keys SET revoked_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND revoked_at IS NULL`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrTrackingKeyNotFound
	}
	return tx.Commit(ctx)
}

// resolveTenantByKey runs without a tenant context (the public
// path doesn't know the tenant yet). Uses the permissive RLS
// policy gated on app.conversion_track_hash.
func (r *Repo) resolveTenantByKey(ctx context.Context, plaintext string) (string, error) {
	hash := HashTrackingKey(plaintext)
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.conversion_track_hash', $1, true)`, hash); err != nil {
		return "", err
	}
	var tenantID string
	if err := tx.QueryRow(ctx, `
SELECT tenant_id::text FROM conversion_tracking_keys
 WHERE key_hash = $1 AND revoked_at IS NULL
 LIMIT 1`, hash).Scan(&tenantID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrInvalidKey
		}
		return "", err
	}
	return tenantID, tx.Commit(ctx)
}

// ResolveTenantByKey exposes the public-key tenant binding to other public
// ingestion surfaces (for example consent) without duplicating the RLS/GUC
// handshake. Public site keys are identifiers, not API credentials; callers
// must still constrain which data the anonymous endpoint may assert.
func (r *Repo) ResolveTenantByKey(ctx context.Context, plaintext string) (string, error) {
	return r.resolveTenantByKey(ctx, plaintext)
}

// Insert persists a conversion. Mirrors into campaign_report_events
// when campaign_id is present so the existing analytics pipeline
// sees it. tenantID is required; this is called from BOTH the
// authenticated admin path AND the public ingestion path (which
// resolves tenantID from the tracking key first).
func (r *Repo) Insert(ctx context.Context, tenantID string, in IngestInput) (*Conversion, error) {
	normalized, err := normalizeIngestInput(in)
	if err != nil {
		return nil, err
	}
	in = normalized
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Public ingestion uses the conversions_public_insert policy.
	// Authenticated admin paths bind app.tenant_id via db.WithTenant
	// pattern and use the regular tenant_isolation policy. We honour
	// both by binding both GUCs — Postgres applies whichever policy
	// matches first (PERMISSIVE policies are OR-combined). Rather than
	// duplicate two paths.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_conversion_tenant', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	props := in.Properties
	if props == nil {
		props = map[string]interface{}{}
	}
	propsJSON, _ := json.Marshal(props)

	var amount *int64
	if in.AmountCents != nil {
		amount = in.AmountCents
	}

	// Resolve attribution + its honest provenance BEFORE the insert so
	// the row is stored already attributed.
	//
	//   1. Explicit caller-supplied campaign_id always wins — last-touch
	//      never overrides it.
	//   2. Otherwise auto-join the subscriber's most recent in-window
	//      email click (lastTouchAttributionWindow, default 7d).
	//   3. Otherwise the conversion is genuinely unattributed.
	//
	// The lookup runs on this tx (tenant scope already bound above) so
	// it sees only this tenant's clicks.
	email := strings.ToLower(in.Email)
	campaign := strings.TrimSpace(in.CampaignID)
	attributedVia := AttributedViaExplicit
	if campaign == "" {
		var lastTouch string
		// An anonymous conversion cannot match an email click. Avoid three
		// needless round trips (SAVEPOINT/query/RELEASE) on that common path.
		if email != "" {
			// time.Now() anchors the window; the row's occurred_at defaults
			// to now() so they coincide within sub-second skew (window is 7d).
			lookupErr, savepointErr := runBestEffortInSavepoint(
				ctx,
				tx,
				attributionLookupSavepoint,
				func() error {
					var err error
					lastTouch, err = lookupLastTouchCampaign(ctx, tx, tenantID, email, time.Now().UTC())
					return err
				},
			)
			if savepointErr != nil {
				return nil, savepointErr
			}
			if lookupErr != nil {
				// Don't fail ingestion on an attribution-lookup error — the
				// conversion fact is the source of truth. Degrade to
				// unattributed and surface the failure for operators. The
				// savepoint rollback above is what keeps this tx committable.
				slog.Error("conversions: last-touch lookup failed",
					"tenant_id", tenantID, "err", lookupErr.Error())
				lastTouch = ""
			}
		}
		if lastTouch != "" {
			campaign, attributedVia = lastTouch, AttributedViaLastTouch
		} else {
			attributedVia = AttributedViaNone
		}
	}
	// campaign_id is an untrusted attribution hint. Never let an invalid UUID
	// reach a ::uuid cast (which would turn a stale cookie into a 500), and
	// never treat a syntactically valid UUID as attributable until the INSERT's
	// tenant-scoped campaign lookup proves ownership. Invalid, stale, missing,
	// and foreign-tenant hints intentionally converge on the same
	// non-disclosing unattributed outcome.
	if campaign != "" && !isUUID(campaign) {
		campaign = ""
		attributedVia = AttributedViaNone
	}

	// Structural edges — the four non-campaign paths to this purchase.
	//
	// Best-effort in its own savepoint, exactly like the campaign lookup above
	// and for the same reason: the conversion fact is the source of truth, and
	// a failed join must degrade the GRAPH, not lose the money. Losing a
	// revenue row because a referral probe timed out would be a far worse
	// outcome than a conversion with no flow edge on it.
	var edges structuralEdges
	if email != "" {
		lookupErr, savepointErr := runBestEffortInSavepoint(
			ctx,
			tx,
			structuralEdgeLookupSavepoint,
			func() error {
				var err error
				edges, err = lookupStructuralEdges(ctx, tx, tenantID, email, time.Now().UTC())
				return err
			},
		)
		if savepointErr != nil {
			return nil, savepointErr
		}
		if lookupErr != nil {
			slog.Error("conversions: structural edge lookup failed",
				"tenant_id", tenantID, "err", lookupErr.Error())
			edges = structuralEdges{}
		}
	}

	var c Conversion
	row := tx.QueryRow(ctx, `
WITH requested_campaign AS (
    SELECT id
      FROM campaigns
     WHERE tenant_id = $1::uuid
       AND id = NULLIF($6, '')::uuid
)
INSERT INTO conversions
    (tenant_id, subscriber_email, event_name, amount_cents, currency,
     campaign_id, attributed_via, properties,
     flow_id, form_id, discount_id, referrer_subscriber_id, experiment_variant_id)
SELECT
    $1::uuid, NULLIF($2, ''), $3, $4, NULLIF($5, ''),
    requested_campaign.id,
    CASE WHEN requested_campaign.id IS NULL THEN $8 ELSE $7 END,
    $9::jsonb,
    NULLIF($10, '')::uuid, NULLIF($11, '')::uuid, NULLIF($12, '')::uuid,
    NULLIF($13, ''), NULLIF($14, '')
  FROM (VALUES (1)) AS anchor(_)
  LEFT JOIN requested_campaign ON TRUE
RETURNING id, tenant_id::text, COALESCE(subscriber_email::text, ''),
          event_name, amount_cents, COALESCE(currency, ''),
          COALESCE(campaign_id::text, ''), COALESCE(attributed_via, ''),
          properties, occurred_at`,
		tenantID, email, in.EventName, amount,
		in.Currency, campaign, attributedVia, AttributedViaNone, string(propsJSON),
		edges.FlowID, edges.FormID, edges.DiscountID,
		edges.ReferrerSubscriberID, edges.ExperimentVariantID)
	var subEmail, currency, campaignID string
	var propsRaw []byte
	if err := row.Scan(&c.ID, &c.TenantID, &subEmail, &c.EventName,
		&c.AmountCents, &currency, &campaignID, &c.AttributedVia, &propsRaw, &c.OccurredAt); err != nil {
		return nil, fmt.Errorf("insert conversion: %w", err)
	}
	c.SubscriberEmail = subEmail
	c.Currency = currency
	c.CampaignID = campaignID
	if len(propsRaw) > 0 {
		_ = json.Unmarshal(propsRaw, &c.Properties)
	}

	// Mirror into campaign_report_events for the analytics pipeline.
	// Only when a campaign attribution is known — otherwise nothing
	// to attribute.
	if c.CampaignID != "" {
		mirrorErr, savepointErr := runBestEffortInSavepoint(
			ctx,
			tx,
			reportMirrorSavepoint,
			func() error {
				_, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events
    (tenant_id, campaign_id, subscriber_email, event_type, link_url, at)
VALUES ($1::uuid, $2::uuid, NULLIF($3, ''), 'conversion', NULL, $4)`,
					tenantID, c.CampaignID, c.SubscriberEmail, c.OccurredAt,
				)
				return err
			},
		)
		if savepointErr != nil {
			return nil, savepointErr
		}
		if mirrorErr != nil {
			// Non-fatal — the conversion row is the source of truth;
			// the mirror is just for analytics convenience. Surface
			// the failure via slog + a counter so the analytics drift is
			// visible. The savepoint rollback keeps the outer tx usable.
			slog.Error("conversions: mirror write failed",
				"tenant_id", tenantID,
				"campaign_id", c.CampaignID,
				"err", mirrorErr.Error())
			conversionsMirrorWriteFailures.Inc()
		}
	}

	// Sequence conversion-goal: when the converting subscriber is enrolled in a
	// sequence whose goal kind is 'conversion', stamp the enrollment's
	// completed_goal (earliest-wins). The voice service derives only open/click
	// goals (handlers.goalKindOf returns "" for conversion), so without this a
	// conversion-goal sequence could never be marked met. Best-effort, isolated
	// in a SAVEPOINT so a stamp failure never aborts the conversion fact (the
	// source of truth). Runs under the same app.tenant_id GUC set above.
	if c.SubscriberEmail != "" {
		if _, sperr := tx.Exec(ctx, "SAVEPOINT seq_goal"); sperr == nil {
			if _, uerr := tx.Exec(ctx, `
UPDATE sequence_enrollments e
   SET completed_goal_at = now(), completed_goal_kind = 'conversion'
 WHERE e.tenant_id = $1::uuid
   AND e.subscriber_email = $2
   AND e.completed_goal_at IS NULL
   AND EXISTS (
       SELECT 1 FROM voice_sequences s
        WHERE s.id = e.sequence_id AND s.tenant_id = e.tenant_id
          AND s.goal->>'kind' = 'conversion')`,
				tenantID, c.SubscriberEmail); uerr != nil {
				_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT seq_goal")
				slog.Error("conversions: sequence conversion-goal stamp failed",
					"tenant_id", tenantID, "err", uerr.Error())
			} else {
				_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT seq_goal")
			}
		}
	}
	return &c, tx.Commit(ctx)
}

// List returns the tenant's recent conversions, newest-first. New clients
// supply both before and beforeID, yielding a strict keyset cursor over
// (occurred_at, id). A zero beforeID retains the legacy timestamp-only
// contract for callers that have not upgraded yet.
func (r *Repo) List(ctx context.Context, tenantID string, before time.Time, beforeID int64, limit int) ([]Conversion, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, limit}
	whereClause := ""
	if !before.IsZero() {
		args = append(args, before)
		if beforeID > 0 {
			whereClause = " AND (occurred_at < $3 OR (occurred_at = $3 AND id < $4))"
			args = append(args, beforeID)
		} else {
			whereClause = " AND occurred_at < $3"
		}
	}
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, COALESCE(subscriber_email::text, ''),
       event_name, amount_cents, COALESCE(currency, ''),
       COALESCE(campaign_id::text, ''), COALESCE(attributed_via, ''),
       properties, occurred_at
  FROM conversions
 WHERE tenant_id = $1::uuid`+whereClause+`
 ORDER BY occurred_at DESC, id DESC LIMIT $2`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Conversion{}
	for rows.Next() {
		var c Conversion
		var subEmail, currency, campaignID string
		var propsRaw []byte
		if err := rows.Scan(&c.ID, &c.TenantID, &subEmail, &c.EventName,
			&c.AmountCents, &currency, &campaignID, &c.AttributedVia, &propsRaw, &c.OccurredAt); err != nil {
			return nil, err
		}
		c.SubscriberEmail = subEmail
		c.Currency = currency
		c.CampaignID = campaignID
		if len(propsRaw) > 0 {
			_ = json.Unmarshal(propsRaw, &c.Properties)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ----------------------------------------------------------------------
// HTTP handlers
// ----------------------------------------------------------------------

// Deps bundles the dependencies handlers need.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

// PublicTrack POST /api/public/track/conversion — main ingestion path.
//
// Auth: tenant tracking key in `Authorization: Bearer <key>` OR
// `?key=` query param (some browsers strip Authorization on
// cross-origin XHR — query-param fallback covers them).
//
// Returns:
//   - When Accept header matches image/* → 200 + transparent GIF
//     body (so a `<img src="…/track/conversion?...">` tag works).
//   - Otherwise → 200 + JSON body with the persisted conversion.
//
// Best-effort attribution: campaign_id pulled from JSON body first,
// then `?c=` query, then `pw_campaign` cookie. The first hit wins.
func (d *Deps) PublicTrack(w http.ResponseWriter, r *http.Request) {
	key := extractTrackingKey(r)
	if key == "" {
		// Be quiet — pixel callers can't see the body anyway. Return
		// the pixel + 401 so XHR callers do see the failure.
		writePublicTrackError(w, r, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}
	if d == nil || d.Repo == nil {
		writePublicTrackError(w, r, http.StatusServiceUnavailable, "tracker_unavailable", "conversion tracker unavailable")
		return
	}
	tenantID, err := d.Repo.resolveTenantByKey(r.Context(), key)
	if err != nil {
		writePublicTrackError(w, r, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}
	in, err := parseIngestInput(r)
	if err != nil {
		// Never echo encoding/json offsets, values, or I/O details. The
		// shared body contract maps every parser failure to a stable,
		// operator-authored 4xx code and message.
		writePublicTrackBodyError(w, r, err)
		return
	}
	in, err = normalizePublicIngestInput(in)
	if err != nil {
		writePublicTrackError(w, r, http.StatusUnprocessableEntity, "conversion_rejected", err.Error())
		return
	}
	conversion, err := d.Repo.Insert(r.Context(), tenantID, in)
	if err != nil {
		// Repo.Insert distinguishes its operator-safe validation sentinels
		// from raw pgx infrastructure errors. Echo the former verbatim to
		// the caller; route the latter through WriteInternal so we don't
		// leak db/RLS text into the response body.
		switch {
		case isIngestValidationError(err):
			writePublicTrackError(w, r, http.StatusUnprocessableEntity, "conversion_rejected", err.Error())
		default:
			writePublicTrackInternal(w, r, d.Logger, err)
		}
		return
	}
	if isPixelRequest(r) {
		w.Header().Set("Content-Type", "image/gif")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(transparentPixel)
		return
	}
	writeJSON(w, http.StatusOK, conversion)
}

func writePublicTrackBodyError(w http.ResponseWriter, r *http.Request, err error) {
	writePublicTrackError(
		w,
		r,
		httpbody.StatusCode(err),
		httpbody.ErrorCode(err),
		httpbody.PublicMessage(err),
	)
}

// writePublicTrackError emits a non-5xx error response. Pixel callers get
// a transparent GIF + the requested status (their <img> tag won't render
// the body anyway); JSON callers get the standard httperror envelope so
// the response shape matches the rest of the API.
func writePublicTrackError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	if isPixelRequest(r) {
		w.Header().Set("Content-Type", "image/gif")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.WriteHeader(status)
		_, _ = w.Write(transparentPixel)
		return
	}
	httperror.Write(w, status, code, message)
}

// writePublicTrackInternal is the 5xx counterpart to writePublicTrackError.
// Pixel callers still get the transparent GIF (with a 500 status they can't
// observe anyway) so a broken endpoint doesn't render as a broken image on
// customer sites. JSON/XHR callers get the generic httperror envelope —
// crucially WITHOUT err.Error() in the body — and err.Error() is logged
// server-side via the supplied slog logger.
func writePublicTrackInternal(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	if isPixelRequest(r) {
		w.Header().Set("Content-Type", "image/gif")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write(transparentPixel)
		return
	}
	httperror.WriteInternal(w, logger, err, r.Context())
}

// AdminList GET /api/v1/conversions — authenticated read.
func (d *Deps) AdminList(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	before, beforeID, err := parseConversionCursor(r.URL.Query())
	if err != nil {
		httperror.Write(
			w,
			http.StatusBadRequest,
			"invalid_cursor",
			"before must be an RFC3339 timestamp and before_id, when supplied, must be a positive integer",
		)
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID, before, beforeID, 50)
	if err != nil {
		// Repo.List only fails on db/RLS/pgx infrastructure paths —
		// every err.Error() here would leak Postgres internals. Route
		// through WriteInternal so the client gets the generic envelope
		// and the operator sees the detail in logs.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// parseConversionCursor validates the query pair before any database work.
// Explicit empty values, duplicates, before_id without before, malformed
// timestamps, and non-positive IDs are rejected rather than silently
// returning page one. `before` by itself remains valid for older clients.
func parseConversionCursor(values url.Values) (time.Time, int64, error) {
	beforeValues, hasBefore := values["before"]
	idValues, hasBeforeID := values["before_id"]
	if !hasBefore && !hasBeforeID {
		return time.Time{}, 0, nil
	}
	if !hasBefore || len(beforeValues) != 1 || strings.TrimSpace(beforeValues[0]) == "" {
		return time.Time{}, 0, ErrInvalidCursor
	}
	if hasBeforeID && (len(idValues) != 1 || strings.TrimSpace(idValues[0]) == "") {
		return time.Time{}, 0, ErrInvalidCursor
	}
	before, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(beforeValues[0]))
	if err != nil {
		return time.Time{}, 0, ErrInvalidCursor
	}
	if !hasBeforeID {
		return before, 0, nil
	}
	beforeID, err := strconv.ParseInt(strings.TrimSpace(idValues[0]), 10, 64)
	if err != nil || beforeID <= 0 {
		return time.Time{}, 0, ErrInvalidCursor
	}
	return before, beforeID, nil
}

// AdminListKeys GET /api/v1/conversions/keys
func (d *Deps) AdminListKeys(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	out, err := d.Repo.ListTrackingKeys(r.Context(), t.ID)
	if err != nil {
		// ListTrackingKeys only returns pgx infrastructure errors — never
		// safe-to-echo validation. WriteInternal logs detail server-side
		// and returns the generic envelope to the client.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminCreateKey POST /api/v1/conversions/keys
func (d *Deps) AdminCreateKey(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	var body struct {
		Label string `json:"label"`
	}
	if err := httpbody.DecodeJSONWith(w, r, conversionTrackMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		// httpbody guarantees operator-safe error text + a stable code via
		// ErrorCode/StatusCode. The code is in httperror.IsValidationCode's
		// allowlist (bad_json, payload_too_large, …) so echoing err.Error()
		// is intentional here.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	resp, err := d.Repo.CreateTrackingKey(r.Context(), t.ID, body.Label)
	if err != nil {
		if errors.Is(err, ErrTrackingKeyLabel) {
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_label", err.Error())
			return
		}
		// Remaining errors are pgx/infrastructure failures and are never
		// safe to echo. Generic envelope only.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

// AdminRevokeKey DELETE /api/v1/conversions/keys/{id}
func (d *Deps) AdminRevokeKey(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	// Use chi's URLParam pattern via the request context — we accept
	// the id via path param.
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/conversions/keys/")
	if err := d.Repo.RevokeTrackingKey(r.Context(), t.ID, id); err != nil {
		// Distinguish the "row didn't exist" case (safe to return a static
		// 404 message) from pgx infrastructure failures (must go through
		// WriteInternal so we don't leak raw db text in a 404 envelope).
		if errors.Is(err, ErrTrackingKeyNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "tracking key not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// extractTrackingKey pulls a tracking key from the request. Same
// precedence Stripe uses for their public keys: Authorization
// Bearer first, then ?key= query.
func extractTrackingKey(r *http.Request) string {
	if v := r.Header.Get("Authorization"); strings.HasPrefix(v, "Bearer ") {
		return strings.TrimPrefix(v, "Bearer ")
	}
	if v := r.URL.Query().Get("key"); v != "" {
		return v
	}
	return ""
}

// parseIngestInput accepts either JSON body or query-param-only.
// Query-only path is the pixel-tag use case (a <img src> can only
// pass query params).
func parseIngestInput(r *http.Request) (IngestInput, error) {
	in := IngestInput{Properties: map[string]interface{}{}}
	if r.Body != nil {
		body, err := httpbody.ReadAtMost(r.Body, conversionTrackMaxBodyBytes)
		if err != nil {
			return in, err
		}
		// A genuinely empty body is the documented query-only pixel
		// contract. Do not use ContentLength to decide whether a body is
		// present: HTTP/2 and chunked requests legitimately report -1, and
		// middleware/tests can supply a stream while leaving it at zero.
		if len(body) > 0 {
			if err := validateConversionJSONMediaType(r.Header.Get("Content-Type")); err != nil {
				return in, err
			}
			if err := json.Unmarshal(body, &in); err != nil {
				return in, fmt.Errorf("bad JSON: %w", err)
			}
		}
	}
	q := r.URL.Query()
	if in.Email == "" {
		in.Email = q.Get("email")
	}
	if in.EventName == "" {
		in.EventName = q.Get("event")
	}
	if in.CampaignID == "" {
		// Body wins, then ?c= query, then pw_campaign cookie.
		if c := q.Get("c"); c != "" {
			in.CampaignID = c
		} else if cookie, err := r.Cookie("pw_campaign"); err == nil {
			in.CampaignID = cookie.Value
		}
	}
	return in, nil
}

// validateConversionJSONMediaType applies the same JSON media-type boundary
// as the shared httpbody decoder while parseIngestInput retains the exact
// empty-body compatibility needed by conversion pixels.
func validateConversionJSONMediaType(raw string) error {
	mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(raw))
	if err != nil {
		return httpbody.ErrUnsupportedMediaType
	}
	mediaType = strings.ToLower(mediaType)
	if mediaType != "application/json" &&
		!(strings.HasPrefix(mediaType, "application/") && strings.HasSuffix(mediaType, "+json")) {
		return httpbody.ErrUnsupportedMediaType
	}
	for key, value := range params {
		if !strings.EqualFold(key, "charset") || !strings.EqualFold(strings.TrimSpace(value), "utf-8") {
			return httpbody.ErrUnsupportedMediaType
		}
	}
	return nil
}

// isPixelRequest reports whether the caller wants a GIF response.
// We check the Accept header AND the request method (image tags
// always use GET; XHR can use either).
func isPixelRequest(r *http.Request) bool {
	if r.Method == http.MethodGet {
		return true
	}
	accept := r.Header.Get("Accept")
	return strings.HasPrefix(accept, "image/")
}

// writeJSON emits a success-shaped body. Error envelopes go through
// httperror.{Write,WriteInternal,WriteValidation}; this helper is kept
// only for 2xx payloads + the rare ok:true acknowledgements.
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
