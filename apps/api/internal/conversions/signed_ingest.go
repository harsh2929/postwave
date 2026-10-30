// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Server-to-server conversion ingest: signed, replay-fenced, idempotent.
//
// The existing ingest path authenticates with a `pwk_…` site key that the
// generated OpenAPI itself describes as PUBLISHABLE — it ships in browser
// JavaScript. It is a tenant router, not a credential, so anyone who has read a
// customer's page source can post conversions as that customer. That is
// tolerable for a browser beacon whose data is inherently untrusted; it is not
// tolerable for the server-side feed that revenue attribution and (once holdout
// lift reads these rows) reported incrementality are computed from.
//
// Three properties, each of which fails differently if omitted:
//
//   - SIGNATURE over the raw body. Not over parsed fields: canonicalising JSON
//     before verifying gives an attacker a second grammar to work in, and every
//     historical signature bypass in this class came from verifying something
//     other than the exact bytes that were then parsed.
//   - REPLAY FENCE on a signed timestamp. A signature alone is replayable
//     forever, so a captured request could be resent to double a conversion
//     indefinitely.
//   - IDEMPOTENCY with STORED RESPONSE REPLAY. The PRD wants a duplicate key to
//     return "the original result, never double-counts". Returning a fresh
//     acknowledgement instead of the original would satisfy the second half and
//     break the first: the client reconciling ids would conclude its first call
//     had failed.

const (
	// SignatureHeader carries the key id and the key-bound version-2 MAC:
	//   X-Postwave-Signature: keyid=abc123,v2=<hex>
	//
	// The key id travels in-band so a tenant can rotate without a flag day: two
	// secrets are live at once and the header says which one signed.
	SignatureHeader = "X-Postwave-Signature"
	// TimestampHeader is the signed unix-seconds timestamp.
	TimestampHeader = "X-Postwave-Timestamp"
	// IdempotencyHeader is REQUIRED, not optional. A conversion feed without it
	// double-counts on the first network retry, and network retries are the
	// normal case rather than the exception.
	IdempotencyHeader = "Idempotency-Key"

	// signatureSkew bounds how old a signed request may be.
	//
	// Five minutes matches internal/inbound_webhooks so an operator debugging a
	// clock problem finds the same number in both places.
	signatureSkew = 5 * time.Minute

	maxIdempotencyKeyBytes = 200
	maxSigningKeyIDBytes   = 200
	// MaxBatchConversions is the PRD's cap. Enforced rather than trusted: an
	// unbounded batch is a memory-exhaustion primitive that authenticates first.
	MaxBatchConversions = 500
)

var (
	// ErrUnsignedRequest covers every failure to prove the caller holds a secret.
	// Deliberately ONE error for missing, malformed, unknown-key and bad-MAC:
	// distinguishing them tells an attacker which half of the credential they
	// guessed correctly.
	ErrUnsignedRequest = errors.New("conversions: request signature invalid")
	// ErrStaleSignature is separate because it is genuinely actionable — a
	// customer with a skewed clock needs to be told that, and it reveals nothing
	// about the secret.
	ErrStaleSignature = errors.New("conversions: request timestamp outside the accepted window")
	// ErrIdempotencyKeyRequired is returned when the header is absent.
	ErrIdempotencyKeyRequired = errors.New("conversions: Idempotency-Key header is required")
	// ErrIdempotencyConflict is the SAME key with a DIFFERENT body. Not a retry:
	// either a client bug or an attempt to make one authorised request stand in
	// for another, and replaying the stored response would silently discard the
	// new data.
	ErrIdempotencyConflict = errors.New("conversions: idempotency key reused with a different request body")
	// ErrPlaintextEmailRejected keeps raw addresses out of the signed fact feed.
	ErrPlaintextEmailRejected = errors.New("conversions: signed ingest never accepts a plaintext address")
	// ErrUnsafeEmailSHA256Rejected closes the dictionary-attackable v1 identity
	// shape. A request signature authenticates the sender, but it does not turn an
	// unsalted digest into proof that the named person belongs to the tenant.
	ErrUnsafeEmailSHA256Rejected = errors.New("conversions: unsalted email_sha256 is not accepted as identity proof")
	// ErrSignedIngestValue is returned when the decimal value cannot be
	// represented exactly in the conversions table's integer-cent unit.
	ErrSignedIngestValue = errors.New("conversions: value must be an exact decimal amount with at most two fractional digits")
)

const (
	signatureVersionV1 = "v1"
	signatureVersionV2 = "v2"
)

// parseSignatureHeader splits the header into its key id, version and hex MAC.
// Duplicate fields and a header carrying both versions are rejected: accepting
// one based on order would let intermediaries and verifiers disagree about
// which credential was actually presented.
func parseSignatureHeader(raw string) (keyID, version, mac string, ok bool) {
	seenKeyID := false
	seenV1 := false
	seenV2 := false
	for _, part := range strings.Split(raw, ",") {
		name, value, found := strings.Cut(strings.TrimSpace(part), "=")
		if !found {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "keyid":
			if seenKeyID {
				return "", "", "", false
			}
			seenKeyID = true
			keyID = strings.TrimSpace(value)
		case "v1":
			if seenV1 {
				return "", "", "", false
			}
			seenV1 = true
			version = signatureVersionV1
			mac = strings.TrimSpace(value)
		case "v2":
			if seenV2 {
				return "", "", "", false
			}
			seenV2 = true
			version = signatureVersionV2
			mac = strings.TrimSpace(value)
		}
	}
	if keyID == "" || len(keyID) > maxSigningKeyIDBytes || mac == "" ||
		(seenV1 == seenV2) {
		return "", "", "", false
	}
	return keyID, version, mac, true
}

// ParseSignatureHeader returns the key id and MAC for callers that do not need
// to branch on the wire version. Both the current v2 and the finite-compatibility
// v1 shape parse; request verification uses parseSignatureHeader above so the
// version can never be discarded at the trust boundary.
func ParseSignatureHeader(raw string) (keyID, mac string, ok bool) {
	keyID, _, mac, ok = parseSignatureHeader(raw)
	return keyID, mac, ok
}

// signingPreimage is the version-2 byte sequence a caller must sign.
//
// Both key id and timestamp are inside it. Without the key id, two credentials
// that accidentally reuse a secret permit a valid request for workspace A to be
// rerouted to workspace B merely by replacing keyid in the unsigned header.
// Length prefixes keep the tuple unambiguous even if an old key id contains a
// delimiter.
func signingPreimage(keyID, timestamp string, body []byte) []byte {
	prefix := "postwave-conversion-v2\n" + strconv.Itoa(len(keyID)) + "\n" +
		keyID + strconv.Itoa(len(timestamp)) + "\n" + timestamp
	preimage := make([]byte, 0, len(prefix)+len(body))
	preimage = append(preimage, prefix...)
	preimage = append(preimage, body...)
	return preimage
}

// legacySigningPreimage is accepted only for credentials that existed before
// migration 1951 and only until their stored compatibility deadline.
func legacySigningPreimage(timestamp string, body []byte) []byte {
	preimage := make([]byte, 0, len(timestamp)+1+len(body))
	preimage = append(preimage, timestamp...)
	preimage = append(preimage, '.')
	preimage = append(preimage, body...)
	return preimage
}

// SignRequest produces the header value a caller sends. Exported because the
// SDKs and the tests must agree with the verifier byte for byte, and the only
// way to guarantee that is for both to call the same function.
func SignRequest(secret, keyID, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(signingPreimage(keyID, timestamp, body))
	return "keyid=" + keyID + ",v2=" + hex.EncodeToString(mac.Sum(nil))
}

// SignatureMatches verifies a version-2 key-bound MAC in constant time.
func SignatureMatches(secret, keyID, timestamp string, body []byte, providedMAC string) bool {
	return signatureMatchesBytes([]byte(strings.TrimSpace(secret)), keyID, timestamp, body, providedMAC)
}

func signatureMatchesBytes(secret []byte, keyID, timestamp string, body []byte, providedMAC string) bool {
	if len(secret) == 0 {
		return false
	}
	provided, err := hex.DecodeString(providedMAC)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(signingPreimage(keyID, timestamp, body))
	return hmac.Equal(mac.Sum(nil), provided)
}

func legacySignatureMatches(secret, timestamp string, body []byte, providedMAC string) bool {
	return legacySignatureMatchesBytes([]byte(strings.TrimSpace(secret)), timestamp, body, providedMAC)
}

func legacySignatureMatchesBytes(secret []byte, timestamp string, body []byte, providedMAC string) bool {
	if len(secret) == 0 {
		return false
	}
	provided, err := hex.DecodeString(providedMAC)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(legacySigningPreimage(timestamp, body))
	return hmac.Equal(mac.Sum(nil), provided)
}

// TimestampFresh checks the replay fence.
//
// Rejects the FUTURE as well as the past. A far-future timestamp would otherwise
// mint a signature that stays valid for as long as the attacker chose.
func TimestampFresh(raw string, now time.Time) bool {
	seconds, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return false
	}
	delta := now.UTC().Sub(time.Unix(seconds, 0).UTC())
	if delta < 0 {
		delta = -delta
	}
	return delta <= signatureSkew
}

// EnvelopeCipher is the envelope-encryption boundary, matching
// inbound_webhooks.EnvelopeCipher so one KEK configuration serves both.
type EnvelopeCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// RequestDigest fingerprints a request body for idempotency comparison.
func RequestDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// SignedIngestIdentity is the caller a signature resolved to.
type SignedIngestIdentity struct {
	TenantID string
	KeyID    string
}

// ResolveSignedCaller verifies a signed request and returns its tenant.
//
// Order matters and is deliberate: parse, then freshness, then secret lookup,
// then MAC. Checking the MAC first would make the endpoint do cryptographic work
// on arbitrary unauthenticated input.
//
// The database guarantees a live key id is globally unique. Rotation therefore
// uses two different ids; accepting one id for two tenants would make routing
// ambiguous before the MAC could establish which workspace was intended.
func (r *Repo) ResolveSignedCaller(
	ctx context.Context,
	signatureHeader, timestampHeader string,
	body []byte,
	now time.Time,
) (*SignedIngestIdentity, error) {
	keyID, version, providedMAC, ok := parseSignatureHeader(signatureHeader)
	if !ok {
		return nil, ErrUnsignedRequest
	}
	if !TimestampFresh(timestampHeader, now) {
		return nil, ErrStaleSignature
	}

	// Tenant resolution happens before app.tenant_id exists, but postwave_app no
	// longer receives a caller-controlled cross-tenant RLS policy. This fixed SQL
	// function is owned by a NOLOGIN/NOBYPASSRLS role with exact column grants,
	// and the live-key unique index guarantees one key id names at most one tenant.
	var tenantID string
	var secret []byte
	var envelope []byte
	// Newly issued credentials carry PostgreSQL's -infinity sentinel. Scanning
	// that value into *time.Time fails in pgx before a valid v2 MAC can be
	// checked, so retain the database infinity marker explicitly.
	var legacyV1Until pgtype.Timestamptz
	err := r.Pool.QueryRow(ctx, `
SELECT tenant_id::text, secret, secret_envelope, legacy_v1_until
  FROM public.resolve_conversion_ingest_secret($1)`, keyID).
		Scan(&tenantID, &secret, &envelope, &legacyV1Until)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnsignedRequest
	}
	if err != nil {
		return nil, err
	}

	secretBytes := secret
	defer func() { zeroSecret(secretBytes) }()
	if len(envelope) > 0 {
		if r.Cipher == nil {
			// An envelope with no cipher configured is a misconfiguration, not a
			// bad request. Never fall back to the sentinel plaintext column.
			return nil, ErrUnsignedRequest
		}
		plaintext, decryptErr := r.Cipher.Decrypt(ctx, envelope, r.LegacyKEK)
		if decryptErr != nil || len(plaintext) == 0 {
			zeroSecret(plaintext)
			return nil, ErrUnsignedRequest
		}
		zeroSecret(secretBytes)
		secretBytes = plaintext
	}

	matched := false
	switch version {
	case signatureVersionV2:
		matched = signatureMatchesBytes(secretBytes, keyID, timestampHeader, body, providedMAC)
	case signatureVersionV1:
		matched = legacyV1Until.Valid && legacyV1Until.InfinityModifier == pgtype.Finite &&
			!now.UTC().After(legacyV1Until.Time.UTC()) &&
			legacySignatureMatchesBytes(secretBytes, timestampHeader, body, providedMAC)
	}
	if matched {
		return &SignedIngestIdentity{
			TenantID: tenantID, KeyID: keyID,
		}, nil
	}
	// One error for unknown key AND bad MAC. Distinguishing them lets an attacker
	// enumerate valid key ids without ever holding a secret.
	return nil, ErrUnsignedRequest
}

// StoredResponse is a replayed idempotent result.
type StoredResponse struct {
	StatusCode int
	Body       []byte
	Replayed   bool
}

type signedConversionFact struct {
	eventName       string
	occurredAt      time.Time
	amount          *int64
	currency        string
	metadata        []byte
	emailHMACSHA256 string
	emailHMACKeyID  string
	clickID         string
	externalID      string
}

// EmailIdentityHMAC returns the tenant/key-scoped pseudonym accepted by signed
// ingest. The exact one-time-issued signing secret is the key; rotation is
// therefore overlap-safe and the request's signed keyid identifies which key
// produced the evidence.
func EmailIdentityHMAC(secret, email string) string {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ""
	}
	return emailIdentityHMACBytes([]byte(secret), email)
}

// emailIdentityHMACBytes is the worker-side form. Keeping key material in a
// mutable byte slice lets the projection worker zero it immediately after a
// leased page; it is never retained in a binding, receipt, response, or log.
func emailIdentityHMACBytes(secret []byte, email string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	if len(secret) == 0 || email == "" {
		return ""
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(email))
	return hex.EncodeToString(mac.Sum(nil))
}

// signedValueInCents converts the PRD's decimal major-unit value to the integer
// cent representation used by conversions. big.Rat makes this exact: binary
// floating point would occasionally turn 19.99 into 1998 cents and silently
// corrupt the revenue number this endpoint exists to make trustworthy.
func signedValueInCents(value *json.Number) (*int64, error) {
	if value == nil {
		return nil, nil
	}
	raw := strings.TrimSpace(value.String())
	rat, ok := new(big.Rat).SetString(raw)
	if !ok {
		return nil, ErrSignedIngestValue
	}
	rat.Mul(rat, big.NewRat(100, 1))
	if !rat.IsInt() || !rat.Num().IsInt64() {
		return nil, ErrSignedIngestValue
	}
	cents := rat.Num().Int64()
	if cents < -maxJavaScriptSafeInteger || cents > maxJavaScriptSafeInteger {
		return nil, ErrAmountOutOfRange
	}
	return &cents, nil
}

func normalizeSignedConversion(item signedConversion, now time.Time) (signedConversionFact, error) {
	amount, err := signedValueInCents(item.Value)
	if err != nil {
		return signedConversionFact{}, err
	}
	normalized, err := normalizeIngestInput(IngestInput{
		EventName:   item.EventName,
		AmountCents: amount,
		Currency:    item.Currency,
	})
	if err != nil {
		return signedConversionFact{}, err
	}
	metadata := item.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	encodedMetadata, err := json.Marshal(metadata)
	if err != nil {
		return signedConversionFact{}, fmt.Errorf("conversions: encode signed metadata: %w", err)
	}
	occurredAt := now.UTC()
	if item.OccurredAt != nil {
		occurredAt = item.OccurredAt.UTC()
	}
	return signedConversionFact{
		eventName:       normalized.EventName,
		occurredAt:      occurredAt,
		amount:          normalized.AmountCents,
		currency:        normalized.Currency,
		metadata:        encodedMetadata,
		emailHMACSHA256: strings.TrimSpace(item.Identity.EmailHMACSHA256),
		clickID:         strings.TrimSpace(item.Identity.ClickID),
		externalID:      strings.TrimSpace(item.Identity.ExternalID),
	}, nil
}

// RecordSignedConversions is the signed-ingest commit boundary. The conversion
// facts and their stored idempotency response are written in one tenant-scoped
// transaction: either both become visible, or neither does.
//
// The receipt is claimed first inside the transaction. A concurrent retry with
// the same key blocks on the unique index and, after this transaction commits,
// replays the final stored response without inserting another fact. If any fact
// insert or response update fails, the placeholder receipt rolls back with it,
// so a retry can safely perform the whole operation.
func (r *Repo) RecordSignedConversions(
	ctx context.Context,
	tenantID, signingKeyID, idempotencyKey, requestDigest string,
	items []signedConversion,
	now time.Time,
) (*StoredResponse, error) {
	key := strings.TrimSpace(idempotencyKey)
	if key == "" {
		return nil, ErrIdempotencyKeyRequired
	}
	if len(key) > maxIdempotencyKeyBytes {
		return nil, fmt.Errorf("conversions: idempotency key exceeds %d bytes",
			maxIdempotencyKeyBytes)
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(signingKeyID) == "" {
		return nil, ErrUnsignedRequest
	}
	if len(items) == 0 || len(items) > MaxBatchConversions {
		return nil, fmt.Errorf("conversions: signed ingest item count %d is outside 1..%d",
			len(items), MaxBatchConversions)
	}

	facts := make([]signedConversionFact, 0, len(items))
	for _, item := range items {
		fact, err := normalizeSignedConversion(item, now)
		if err != nil {
			return nil, err
		}
		fact.emailHMACKeyID = signingKeyID
		facts = append(facts, fact)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Subject erasure takes the exclusive side of this tenant fence. Holding the
	// shared side through commit makes every identity-bearing ingest wholly
	// before the erasure snapshot (and therefore scrubbed) or wholly after its
	// immutable receipt. No request can commit old identity behind that receipt.
	if _, err := tx.Exec(ctx, `
SELECT pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended($1, 2029)
)`, tenantID); err != nil {
		return nil, fmt.Errorf("conversions: fence signed ingest subject identity: %w", err)
	}

	// Linearize this already-authenticated request against permanent key
	// revocation before touching the idempotency ledger or conversion facts.
	// ResolveSignedCaller necessarily runs before the tenant is known, so a key
	// can be revoked between MAC verification and this transaction. After the
	// outer subject-erasure fence, lock the exact live row first and only then
	// take the shared side of migration 2017's tenant lifecycle fence. Revocation
	// takes those two resources in the same order (the UPDATE locks the row before
	// its BEFORE trigger takes the exclusive advisory lock), avoiding a
	// row/advisory inversion:
	//
	//   * if this FOR SHARE wins, revocation waits until the facts and receipt
	//     commit, so the request is wholly before the revocation cutover;
	//   * if revocation wins, PostgreSQL rechecks revoked_at after the wait and no
	//     row is returned, so no post-revocation idempotency/fact write occurs.
	var signingKeyLive bool
	err = tx.QueryRow(ctx, `
SELECT true
  FROM conversion_ingest_secrets
 WHERE tenant_id = $1::uuid AND key_id = $2 AND revoked_at IS NULL
 FOR SHARE`, tenantID, signingKeyID).Scan(&signingKeyLive)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnsignedRequest
	}
	if err != nil {
		return nil, fmt.Errorf("conversions: lock live signing key: %w", err)
	}
	if !signingKeyLive {
		return nil, ErrUnsignedRequest
	}
	if _, err := tx.Exec(ctx, `
SELECT pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended($1, 2017)
)`, tenantID); err != nil {
		return nil, fmt.Errorf("conversions: fence signed ingest key lifecycle: %w", err)
	}

	var claimed bool
	err = tx.QueryRow(ctx, `
INSERT INTO conversion_ingest_idempotency
    (tenant_id, idempotency_key, request_digest, status_code, response_body)
VALUES ($1::uuid, $2, $3, $4, '{}'::jsonb)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING true`, tenantID, key, requestDigest, 202).Scan(&claimed)
	if errors.Is(err, pgx.ErrNoRows) {
		var storedDigest string
		var storedStatus int
		var storedBody []byte
		if err := tx.QueryRow(ctx, `
SELECT request_digest, status_code, response_body
  FROM conversion_ingest_idempotency
 WHERE tenant_id = $1::uuid AND idempotency_key = $2`, tenantID, key).
			Scan(&storedDigest, &storedStatus, &storedBody); err != nil {
			return nil, err
		}
		if storedDigest != requestDigest {
			return nil, ErrIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &StoredResponse{
			StatusCode: storedStatus,
			Body:       storedBody,
			Replayed:   true,
		}, nil
	}
	if err != nil {
		return nil, err
	}
	if !claimed {
		return nil, errors.New("conversions: idempotency claim returned no outcome")
	}

	// Resolve the batch's tenant/key-scoped email identities only through the
	// exact indexed projection. The request verifier's plaintext secret never
	// reaches this transaction. Authenticated idempotent replays return above
	// without repeating even the bounded index lookup.
	emailHMACBindings, err := loadEmailHMACBindings(
		ctx, tx, tenantID, signingKeyID, facts,
	)
	if err != nil {
		return nil, fmt.Errorf("conversions: resolve email HMAC identities: %w", err)
	}

	conversionIDs := make([]int64, 0, len(facts))
	for _, fact := range facts {
		// Resolution runs BEFORE the insert so the row lands already attributed,
		// and inside a savepoint so it can only ever cost the graph.
		//
		// Losing the revenue because a subscriber probe timed out would be a far
		// worse outcome than a conversion with no person on it — the money is the
		// fact this endpoint exists to record, and the attribution is a claim
		// about it.
		resolved := newResolvedIdentity()
		lookupErr, savepointErr := runBestEffortInSavepoint(ctx, tx,
			identityResolutionSavepoint, func() error {
				var err error
				resolved, err = resolveSignedIdentity(
					ctx, tx, tenantID, emailHMACBindings, fact, fact.occurredAt,
				)
				return err
			})
		if savepointErr != nil {
			return nil, savepointErr
		}
		if lookupErr != nil {
			slog.Error("conversions: signed identity resolution failed",
				"tenant_id", tenantID, "err", lookupErr.Error())
			resolved = newResolvedIdentity()
		}

		// The row is written whether or not the identity resolved.
		//
		// An unresolved conversion is STORED, never dropped. The customer's money
		// moved; the only thing missing is our ability to say whose it was, and
		// discarding real revenue because we could not name the buyer would turn a
		// gap in our identity graph into a gap in their books. It lands with
		// attributed_via='none', which is the honest description of it, and a
		// later resolution pass can revisit it because every identifier it
		// presented is still on the row and in conversion_attribution_touches.
		//
		// The campaign is re-proved to exist inside the INSERT rather than
		// trusted from the lookup that produced it.
		//
		// campaign_report_events is partitioned and the campaign foreign key is
		// attached only to its legacy partition, so a click held in any monthly
		// partition can outlive the campaign it names — while
		// conversions.campaign_id DOES carry that key. Writing the id straight
		// through would let one tidied-up campaign raise a constraint violation
		// that fails the whole signed batch: up to 500 conversions of real revenue
		// lost, and a 500 that explains nothing. A stale campaign converges on
		// unattributed instead, which is exactly what the browser ingest does with
		// an unknown campaign hint.
		var conversionID int64
		if err := tx.QueryRow(ctx, `
	WITH requested_campaign AS (
	    SELECT id
	      FROM campaigns
	     WHERE tenant_id = $1::uuid
	       AND id = NULLIF($13, '')::uuid
	)
	INSERT INTO conversions
	    (tenant_id, event_name, amount_cents, currency, properties, occurred_at,
	     attributed_via, email_hmac_sha256, email_hmac_key_id, click_id, external_id,
	     subscriber_email, campaign_id,
	     flow_id, form_id, discount_id, referrer_subscriber_id, experiment_variant_id)
	SELECT
	    $1::uuid, $2, $3, NULLIF($4, ''), $5::jsonb, $6,
	    CASE WHEN requested_campaign.id IS NULL THEN $19 ELSE $11 END,
	    NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''),
	    NULLIF($12, ''), requested_campaign.id,
	    NULLIF($14, '')::uuid, NULLIF($15, '')::uuid, NULLIF($16, '')::uuid,
	    NULLIF($17, ''), NULLIF($18, '')
	  FROM (VALUES (1)) AS anchor(_)
	  LEFT JOIN requested_campaign ON TRUE
	RETURNING id`, tenantID, fact.eventName, fact.amount, fact.currency,
			string(fact.metadata), fact.occurredAt, fact.emailHMACSHA256,
			fact.emailHMACKeyID, fact.clickID, fact.externalID,
			resolved.attributedVia, resolved.email, resolved.campaignID,
			resolved.edges.FlowID, resolved.edges.FormID, resolved.edges.DiscountID,
			resolved.edges.ReferrerSubscriberID, resolved.edges.ExperimentVariantID,
			AttributedViaNone).
			Scan(&conversionID); err != nil {
			return nil, fmt.Errorf("conversions: insert signed conversion fact: %w", err)
		}
		conversionIDs = append(conversionIDs, conversionID)

		// The evidence behind the attribution, and the click-id binding this
		// payload taught us. Best effort for the same reason the lookup was: the
		// fact is committed either way — and phase-isolated inside, so one refused
		// phase costs only itself.
		writeErr, savepointErr := recordIdentityEvidence(ctx, tx, tenantID,
			conversionID, resolved, fact.occurredAt)
		if savepointErr != nil {
			return nil, savepointErr
		}
		if writeErr != nil {
			slog.Error("conversions: signed attribution touch write failed",
				"tenant_id", tenantID, "conversion_id", conversionID,
				"err", writeErr.Error())
		}
	}

	responseBody, err := json.Marshal(map[string]any{
		"accepted":       len(conversionIDs),
		"conversion_ids": conversionIDs,
		"key_id":         signingKeyID,
	})
	if err != nil {
		return nil, fmt.Errorf("conversions: encode signed ingest response: %w", err)
	}
	var storedBody []byte
	if err := tx.QueryRow(ctx, `
UPDATE conversion_ingest_idempotency
   SET status_code = $4,
       response_body = $5::jsonb
 WHERE tenant_id = $1::uuid
   AND idempotency_key = $2
   AND request_digest = $3
RETURNING response_body`, tenantID, key, requestDigest, 202, string(responseBody)).
		Scan(&storedBody); err != nil {
		return nil, fmt.Errorf("conversions: finalize signed ingest receipt: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &StoredResponse{StatusCode: 202, Body: storedBody}, nil
}

// RememberIdempotentResponse stores a response for later replay, or returns the
// one already stored for this key.
//
// Returns Replayed=true when the caller should send the stored response instead
// of doing the work again. A conflicting body returns ErrIdempotencyConflict.
func (r *Repo) RememberIdempotentResponse(
	ctx context.Context,
	tenantID, idempotencyKey, requestDigest string,
	statusCode int,
	responseBody []byte,
) (*StoredResponse, error) {
	key := strings.TrimSpace(idempotencyKey)
	if key == "" {
		return nil, ErrIdempotencyKeyRequired
	}
	if len(key) > maxIdempotencyKeyBytes {
		return nil, fmt.Errorf("conversions: idempotency key exceeds %d bytes",
			maxIdempotencyKeyBytes)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// One statement, so two concurrent retries of the same request cannot both
	// decide they are the first. The DO NOTHING loser reads the winner's row.
	var storedDigest string
	var storedStatus int
	var storedBody []byte
	var inserted bool
	err = tx.QueryRow(ctx, `
WITH attempted AS (
    INSERT INTO conversion_ingest_idempotency
        (tenant_id, idempotency_key, request_digest, status_code, response_body)
    VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING request_digest, status_code, response_body, true AS inserted
)
SELECT request_digest, status_code, response_body, inserted FROM attempted
UNION ALL
SELECT request_digest, status_code, response_body, false
  FROM conversion_ingest_idempotency
 WHERE tenant_id = $1::uuid AND idempotency_key = $2
   AND NOT EXISTS (SELECT 1 FROM attempted)
 LIMIT 1`, tenantID, key, requestDigest, statusCode, string(responseBody)).
		Scan(&storedDigest, &storedStatus, &storedBody, &inserted)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	if storedDigest != requestDigest {
		return nil, ErrIdempotencyConflict
	}
	return &StoredResponse{
		StatusCode: storedStatus,
		Body:       storedBody,
		Replayed:   !inserted,
	}, nil
}
