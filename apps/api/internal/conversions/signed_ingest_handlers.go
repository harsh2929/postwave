// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// The signed ingest surface (PRD F03 §5.1).
//
// Everything security-relevant here is about ORDER and about reading the RAW
// body. The body is read once, verified as bytes, and only then parsed — the
// signature covers exactly the bytes that get decoded, with no canonicalisation
// step in between where a second grammar could hide.
//
// Mounted PUBLIC because the caller is a customer's server holding a signing
// secret, not a session. The signature establishes the tenant; there is no
// session middleware in front of these routes and there must not be, because a
// tenant header a caller could set would defeat the point of signing.

// SignedIngestDeps carries the signed ingest surface.
type SignedIngestDeps struct {
	Repo   *Repo
	Logger *slog.Logger
	Now    func() time.Time
}

func (d *SignedIngestDeps) now() time.Time {
	if d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func (d *SignedIngestDeps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// maxSignedBodyBytes bounds the raw read.
//
// Sized for the 500-item batch the PRD permits, and enforced BEFORE signature
// verification: an unbounded read that authenticates afterwards is a
// memory-exhaustion primitive available to anyone, signature or not.
const maxSignedBodyBytes = 2 << 20

// MountSignedIngestRoutes registers the server-to-server conversion feed.
func MountSignedIngestRoutes(r chi.Router, d *SignedIngestDeps) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	r.Post("/api/public/conversions/ingest", d.Ingest)
	r.Post("/api/public/conversions/ingest/batch", d.IngestBatch)
}

// signedConversion is one conversion in the PRD's wire shape.
type signedConversion struct {
	EventName  string         `json:"event_name"`
	OccurredAt *time.Time     `json:"occurred_at,omitempty"`
	Identity   signedIdentity `json:"identity"`
	// json.Number preserves the caller's decimal bytes. Converting through
	// float64 would occasionally turn values such as 19.99 into the wrong number
	// of cents before the database ever sees them.
	Value    *json.Number   `json:"value,omitempty"`
	Currency string         `json:"currency,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// signedIdentity is the PRD's resolution order, as a type.
//
// Deliberately has NO plaintext email field. A struct that could hold one would
// eventually be filled by a caller reading the docs too quickly, and the rejection
// would then be a runtime check rather than an impossibility. `Email` exists only
// so the handler can REFUSE it with a specific message instead of silently
// ignoring an unknown field.
type signedIdentity struct {
	// EmailHMACSHA256 is HMAC-SHA256(signing_secret,
	// lower(trim(email))). The authenticated request's keyid is the identity key
	// id; callers cannot choose a different tenant/key scope in the body.
	EmailHMACSHA256 string `json:"email_hmac_sha256,omitempty"`
	// EmailSHA256 is retained in the closed decoder only so the obsolete,
	// dictionary-attackable identity receives an explicit refusal instead of an
	// ambiguous unknown-field error.
	EmailSHA256 string `json:"email_sha256,omitempty"`
	ClickID     string `json:"click_id,omitempty"`
	ExternalID  string `json:"external_id,omitempty"`
	// Email is accepted only to be refused. See ErrPlaintextEmailRejected.
	Email string `json:"email,omitempty"`
}

type signedBatch struct {
	Conversions []signedConversion `json:"conversions"`
}

// Ingest handles a single signed conversion.
func (d *SignedIngestDeps) Ingest(w http.ResponseWriter, r *http.Request) {
	body, identity, ok := d.authenticate(w, r)
	if !ok {
		return
	}
	var in signedConversion
	if err := decodeClosedJSON(body, &in); err != nil {
		d.writeError(w, http.StatusBadRequest, "invalid_json", "body is not valid JSON")
		return
	}
	d.record(w, r, identity, body, []signedConversion{in})
}

// IngestBatch handles up to MaxBatchConversions in one signed request.
func (d *SignedIngestDeps) IngestBatch(w http.ResponseWriter, r *http.Request) {
	body, identity, ok := d.authenticate(w, r)
	if !ok {
		return
	}
	var in signedBatch
	if err := decodeClosedJSON(body, &in); err != nil {
		d.writeError(w, http.StatusBadRequest, "invalid_json", "body is not valid JSON")
		return
	}
	if len(in.Conversions) == 0 {
		d.writeError(w, http.StatusBadRequest, "empty_batch", "conversions must not be empty")
		return
	}
	if len(in.Conversions) > MaxBatchConversions {
		// Refused rather than truncated. A silently-truncated batch reports success
		// for conversions that were never recorded, and the caller has no way to
		// discover which ones.
		d.writeError(w, http.StatusRequestEntityTooLarge, "batch_too_large",
			"a batch permits at most 500 conversions")
		return
	}
	d.record(w, r, identity, body, in.Conversions)
}

// authenticate reads the raw body and resolves the signer.
//
// Returns the RAW bytes so the caller parses exactly what was verified.
func (d *SignedIngestDeps) authenticate(
	w http.ResponseWriter, r *http.Request,
) ([]byte, *SignedIngestIdentity, bool) {
	body, err := httpbody.ReadAtMost(r.Body, maxSignedBodyBytes)
	if err != nil {
		d.writeError(w, http.StatusRequestEntityTooLarge, "body_too_large",
			"request body exceeds the permitted size")
		return nil, nil, false
	}

	// Idempotency is checked for PRESENCE before the signature, because a missing
	// header is a client bug worth naming precisely and reveals nothing: it is
	// visible in the request either way.
	idempotencyKey := r.Header.Get(IdempotencyHeader)
	if strings.TrimSpace(idempotencyKey) == "" {
		d.writeError(w, http.StatusBadRequest, "idempotency_key_required",
			"the Idempotency-Key header is required; a conversion feed without one "+
				"double-counts on the first network retry")
		return nil, nil, false
	}
	if !validSignedIdempotencyKey(idempotencyKey) {
		d.writeError(w, http.StatusBadRequest, "invalid_idempotency_key",
			"the Idempotency-Key must be 1 to 200 UTF-8 bytes, contain no control characters, and have no surrounding whitespace")
		return nil, nil, false
	}

	identity, err := d.Repo.ResolveSignedCaller(
		r.Context(), r.Header.Get(SignatureHeader), r.Header.Get(TimestampHeader),
		body, d.now())
	switch {
	case errors.Is(err, ErrStaleSignature):
		// Distinguished deliberately: a customer with a skewed clock needs to be
		// told that, and the timestamp is in the request already so saying so
		// reveals nothing about the secret.
		d.writeError(w, http.StatusUnauthorized, "stale_signature",
			"request timestamp is outside the accepted window; check the sending "+
				"system's clock")
		return nil, nil, false
	case err != nil:
		// One response for missing, malformed, unknown-key and bad-MAC. Two would
		// let a caller enumerate valid key ids without holding a secret.
		d.writeError(w, http.StatusUnauthorized, "invalid_signature",
			"request signature is invalid")
		return nil, nil, false
	}
	return body, identity, true
}

// record validates and stores, replaying a prior response for a repeated key.
func (d *SignedIngestDeps) record(
	w http.ResponseWriter,
	r *http.Request,
	identity *SignedIngestIdentity,
	body []byte,
	items []signedConversion,
) {
	for i, item := range items {
		if strings.TrimSpace(item.Identity.Email) != "" {
			d.writeError(w, http.StatusBadRequest, "plaintext_email_rejected",
				"identity.email is not accepted; send identity.email_hmac_sha256 "+
					"computed with the signing secret")
			return
		}
		if strings.TrimSpace(item.Identity.EmailSHA256) != "" {
			d.writeError(w, http.StatusBadRequest, "unsafe_email_sha256_rejected",
				"identity.email_sha256 is an unsalted, dictionary-attackable digest; "+
					"send identity.email_hmac_sha256 computed with the signing secret")
			return
		}
		if strings.TrimSpace(item.EventName) == "" {
			d.writeError(w, http.StatusBadRequest, "event_name_required",
				"event_name is required")
			return
		}
		if hash := strings.TrimSpace(item.Identity.EmailHMACSHA256); hash != "" {
			if !validSHA256Hex(hash) {
				d.writeError(w, http.StatusBadRequest, "invalid_email_hmac_sha256",
					"identity.email_hmac_sha256 must be 64 lowercase hex characters")
				return
			}
		}
		if strings.TrimSpace(item.Identity.EmailHMACSHA256) == "" &&
			strings.TrimSpace(item.Identity.ClickID) == "" &&
			strings.TrimSpace(item.Identity.ExternalID) == "" {
			d.writeError(w, http.StatusBadRequest, "identity_required",
				"one of identity.click_id, identity.email_hmac_sha256 or "+
					"identity.external_id is required")
			return
		}
		_ = i
	}

	stored, err := d.Repo.RecordSignedConversions(
		r.Context(), identity.TenantID, identity.KeyID,
		r.Header.Get(IdempotencyHeader), RequestDigest(body), items, d.now())
	switch {
	case errors.Is(err, ErrIdempotencyConflict):
		// The same key with a different body. Replaying the stored response would
		// silently discard the new data while reporting success.
		d.writeError(w, http.StatusConflict, "idempotency_conflict",
			"this Idempotency-Key was already used with a different request body")
		return
	case errors.Is(err, ErrIdempotencyKeyRequired):
		d.writeError(w, http.StatusBadRequest, "idempotency_key_required",
			"the Idempotency-Key header is required")
		return
	case errors.Is(err, ErrSignedIngestValue),
		errors.Is(err, ErrAmountOutOfRange):
		d.writeError(w, http.StatusBadRequest, "invalid_value",
			"value must be an exact decimal amount with at most two fractional digits")
		return
	case errors.Is(err, ErrInvalidCurrency),
		errors.Is(err, ErrCurrencyWithoutAmount):
		d.writeError(w, http.StatusBadRequest, "invalid_currency",
			"currency must be three ASCII letters and is required exactly when value is present")
		return
	case errors.Is(err, ErrEventName):
		d.writeError(w, http.StatusBadRequest, "invalid_event_name",
			ErrEventName.Error())
		return
	case errors.Is(err, ErrEmailIdentityProjectionNotReady):
		d.writeError(w, http.StatusServiceUnavailable,
			"email_identity_projection_not_ready",
			"email-HMAC identity for this signing key is not ready; retry after the key projection becomes ready")
		return
	case errors.Is(err, ErrUnsignedRequest):
		// The key may have been permanently revoked after the request MAC was
		// verified but before its tenant transaction reached the lifecycle fence.
		// Collapse that race with every other invalid-signature outcome so key
		// existence/revocation remains non-enumerable.
		d.writeError(w, http.StatusUnauthorized, "invalid_signature",
			"request signature is invalid")
		return
	case err != nil:
		d.log().Error("conversions: signed ingest failed", "err", err.Error())
		d.writeError(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}

	// The STORED response is returned, not the freshly-built one. A retry must see
	// what the first call returned, or a caller reconciling ids concludes its first
	// attempt failed.
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(stored.StatusCode)
	_, _ = w.Write(stored.Body)
}

func validSHA256Hex(value string) bool {
	if len(value) != 64 {
		return false
	}
	if strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validSignedIdempotencyKey(value string) bool {
	if value == "" || value != strings.TrimSpace(value) ||
		len(value) > maxIdempotencyKeyBytes || !utf8.ValidString(value) {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

// decodeClosedJSON makes the handler enforce the same closed object contract
// published in OpenAPI. Accepting an undocumented top-level or identity field
// is especially dangerous on a revenue feed: a caller can believe a value was
// honored while the server silently drops it and still returns 202.
func decodeClosedJSON(body []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("conversions: more than one JSON value")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("conversions: more than one JSON value")
		}
		return err
	}
	return nil
}

func (d *SignedIngestDeps) writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": code, "message": message})
}
