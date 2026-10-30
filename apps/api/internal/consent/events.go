// SPDX-License-Identifier: AGPL-3.0-only
//
// Package consent — consent_events ledger (the broader compliance
// table from 0094, distinct from the older subscriber-only
// consent_receipts table backing Record() in consent.go).
//
// Two surfaces:
//
//   1. RecordEvent(): server-side writer used by the cookie-banner
//      public ingest, the GPC honour path, the per-subscriber
//      tracking-eligibility flip, and the public preference page.
//   2. ListEvents(): admin-scoped GET /api/v1/consent/events for
//      auditors. Filters by subject_type / category / since.
//
// The package keeps RecordEvent permissive on missing fields so the
// caller surface is hard to use wrong — the SQL CHECK constraints
// in migration 0094 are the source of truth for enum values.

package consent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Allowed consent_events.subject_type values (mirrors the 0094 CHECK).
var allowedSubjectTypes = map[string]struct{}{
	"visitor":    {},
	"user":       {},
	"subscriber": {},
	"workspace":  {},
}

// Allowed consent_events.channel values.
var allowedChannels = map[string]struct{}{
	"web":     {},
	"mobile":  {},
	"desktop": {},
	"email":   {},
	"import":  {},
	"api":     {},
}

// Allowed consent_events.category values.
var allowedCategories = map[string]struct{}{
	"essential":            {},
	"analytics":            {},
	"marketing":            {},
	"email_marketing":      {},
	"email_tracking":       {},
	"sale_share":           {},
	"targeted_advertising": {},
	"ai_processing":        {},
	"sensitive_data":       {},
}

// Allowed consent_events.action values.
var allowedActions = map[string]struct{}{
	"granted":   {},
	"denied":    {},
	"revoked":   {},
	"opted_out": {},
	"imported":  {},
}

// ErrInvalidEvent is returned when RecordEvent input fails the enum / required-field gate.
var ErrInvalidEvent = errors.New("consent: invalid event")

const consentEventFutureSkew = 5 * time.Minute

var earliestConsentEventTime = time.Unix(0, 0).UTC()

// EventInput is the canonical write shape for consent_events. The
// caller normalises strings (lowercase emails, trimmed visitor ids);
// the writer enforces the enum gates against the 0094 CHECK constraints
// and produces a clearer error than a Postgres CHECK violation.
type EventInput struct {
	TenantID string
	// DecisionID and RequestFingerprint are either both empty (ordinary
	// server-side events) or both populated (the three-row public browser
	// decision batch). Their database columns are immutable and the unique
	// tenant/decision/category index makes the application-level advisory lock
	// a defence-in-depth, rather than the sole deduplication boundary.
	DecisionID         string
	RequestFingerprint string
	SubjectType        string // visitor|user|subscriber|workspace
	SubjectID          string // optional (visitor id, user id, subscriber id, workspace id)
	SubjectEmail       string // optional
	Channel            string // web|mobile|desktop|email|import|api
	Category           string // essential|analytics|marketing|email_marketing|email_tracking|sale_share|targeted_advertising|ai_processing|sensitive_data
	Action             string // granted|denied|revoked|opted_out|imported
	Source             string // e.g. "cookie_banner", "gpc", "preference_center"
	PolicyVersion      string
	GPC                bool
	IP                 string
	UserAgent          string
	ProofText          string
	Preferences        map[string]any
	// OccurredAt is the reviewed time at which the consent action occurred.
	// Leave it nil for a live action; PostgreSQL then records transaction time.
	OccurredAt *time.Time
}

// Event mirrors the consent_events row shape for read surfaces.
type Event struct {
	ID            string         `json:"id"`
	DecisionID    string         `json:"decision_id,omitempty"`
	SubjectType   string         `json:"subject_type"`
	SubjectID     string         `json:"subject_id,omitempty"`
	SubjectEmail  string         `json:"subject_email,omitempty"`
	Channel       string         `json:"channel"`
	Category      string         `json:"category"`
	Action        string         `json:"action"`
	Source        string         `json:"source"`
	PolicyVersion string         `json:"policy_version"`
	Preferences   map[string]any `json:"preferences,omitempty"`
	ProofText     string         `json:"proof_text,omitempty"`
	IP            string         `json:"ip,omitempty"`
	UserAgent     string         `json:"user_agent,omitempty"`
	CreatedAt     time.Time      `json:"created_at"`
	RecordedAt    time.Time      `json:"recorded_at"`
}

// validateEventInput enforces the enum + required-field gate.
// Returns ErrInvalidEvent wrapped with a human-readable field hint.
func validateEventInput(in EventInput) error {
	if strings.TrimSpace(in.TenantID) == "" {
		return fmt.Errorf("%w: tenant_id required", ErrInvalidEvent)
	}
	decisionID := strings.TrimSpace(in.DecisionID)
	fingerprint := strings.TrimSpace(in.RequestFingerprint)
	if (decisionID == "") != (fingerprint == "") {
		return fmt.Errorf("%w: decision_id and request_fingerprint must be supplied together", ErrInvalidEvent)
	}
	if decisionID != "" {
		if _, err := uuid.Parse(decisionID); err != nil {
			return fmt.Errorf("%w: decision_id must be a UUID", ErrInvalidEvent)
		}
		if !publicConsentFingerprintRE.MatchString(fingerprint) {
			return fmt.Errorf("%w: request_fingerprint must be a lowercase SHA-256 digest", ErrInvalidEvent)
		}
	}
	if _, ok := allowedSubjectTypes[in.SubjectType]; !ok {
		return fmt.Errorf("%w: subject_type %q", ErrInvalidEvent, in.SubjectType)
	}
	if _, ok := allowedChannels[in.Channel]; !ok {
		return fmt.Errorf("%w: channel %q", ErrInvalidEvent, in.Channel)
	}
	if _, ok := allowedCategories[in.Category]; !ok {
		return fmt.Errorf("%w: category %q", ErrInvalidEvent, in.Category)
	}
	if _, ok := allowedActions[in.Action]; !ok {
		return fmt.Errorf("%w: action %q", ErrInvalidEvent, in.Action)
	}
	if in.SubjectID == "" && in.SubjectEmail == "" {
		return fmt.Errorf("%w: subject_id or subject_email required", ErrInvalidEvent)
	}
	if !optionalConsentToken(in.SubjectID, maxConsentSubjectIDBytes) {
		return fmt.Errorf("%w: subject_id violates evidence bounds", ErrInvalidEvent)
	}
	if in.SubjectEmail != "" && !validConsentEmailShape(in.SubjectEmail) {
		return fmt.Errorf("%w: subject_email violates evidence bounds", ErrInvalidEvent)
	}
	if in.IP != "" && net.ParseIP(strings.TrimSpace(in.IP)) == nil {
		return fmt.Errorf("%w: ip must be a valid address", ErrInvalidEvent)
	}
	source := strings.TrimSpace(in.Source)
	if source == "" {
		source = "product"
	}
	policyVersion := strings.TrimSpace(in.PolicyVersion)
	if policyVersion == "" {
		policyVersion = "v1"
	}
	if !boundedConsentToken(source, maxConsentSourceBytes) ||
		!boundedConsentToken(policyVersion, maxConsentPolicyVersionBytes) ||
		!optionalConsentNarrative(in.ProofText, maxConsentNarrativeBytes) ||
		!optionalConsentToken(in.UserAgent, maxConsentUserAgentBytes) {
		return fmt.Errorf("%w: evidence text violates read-contract bounds", ErrInvalidEvent)
	}
	if _, err := marshalEventPreferences(in); err != nil {
		return err
	}
	if in.OccurredAt != nil {
		occurredAt := in.OccurredAt.UTC()
		if occurredAt.Before(earliestConsentEventTime) {
			return fmt.Errorf("%w: occurred_at must be on or after %s", ErrInvalidEvent, earliestConsentEventTime.Format(time.RFC3339))
		}
		if occurredAt.After(time.Now().UTC().Add(consentEventFutureSkew)) {
			return fmt.Errorf("%w: occurred_at cannot be more than %s in the future", ErrInvalidEvent, consentEventFutureSkew)
		}
	}
	return nil
}

// RecordEvent appends a row to consent_events. Missing storage or malformed
// evidence fails closed; it never reports a successful no-op.
func RecordEvent(ctx context.Context, pool *db.Pool, in EventInput) (string, error) {
	if pool == nil {
		return "", ErrConsentStoreUnavailable
	}
	tx, err := db.WithTenant(ctx, pool, in.TenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id, err := RecordEventInTx(ctx, tx, in)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// RecordEventInTx is the transaction-aware form of RecordEvent. Compliance
// projections that must never commit without their canonical event use this
// helper so the projection, event, audit, and outbox intent share one commit.
// The caller must already be inside a tenant-scoped transaction whose tenant
// matches in.TenantID.
//
// Per-address subscriber consent should use SubjectType="subscriber",
// SubjectID=<subscriber_emails.id>, SubjectEmail=<exact address>, and category
// "email_marketing". The stable address-row UUID prevents an email rename from
// changing evidence identity while SubjectEmail preserves the reviewed address.
func RecordEventInTx(ctx context.Context, tx pgx.Tx, in EventInput) (string, error) {
	if tx == nil {
		return "", errors.New("consent: transaction required")
	}
	if err := validateEventInput(in); err != nil {
		return "", err
	}

	// Copy the caller's map before stamping GPC. EventInput values are often
	// reused for retries and may be shared by concurrent callers; mutating the
	// supplied map here would make validation order-dependent and race-prone.
	prefJSON, err := marshalEventPreferences(in)
	if err != nil {
		return "", err
	}

	source := strings.TrimSpace(in.Source)
	if source == "" {
		source = "product"
	}
	policyVersion := strings.TrimSpace(in.PolicyVersion)
	if policyVersion == "" {
		policyVersion = "v1"
	}

	var ipArg any
	if parsed := net.ParseIP(strings.TrimSpace(in.IP)); parsed != nil {
		ipArg = parsed.String()
	}
	var occurredAt any
	if in.OccurredAt != nil {
		occurredAt = in.OccurredAt.UTC()
	}

	var id string
	row := tx.QueryRow(ctx, `
	INSERT INTO consent_events
	  (tenant_id, subject_type, subject_id, subject_email,
	   channel, category, action, source, policy_version,
	   preferences, proof_text, ip, user_agent, created_at,
	   decision_id, request_fingerprint)
	VALUES ($1::uuid, $2, NULLIF($3, ''), NULLIF(LOWER($4), '')::citext,
	        $5, $6, $7, $8, $9,
	        $10::jsonb, NULLIF($11, ''), $12::inet, NULLIF($13, ''),
	        COALESCE($14::timestamptz, now()),
	        NULLIF($15, '')::uuid, NULLIF($16, ''))
	RETURNING id::text`,
		in.TenantID, in.SubjectType, in.SubjectID, in.SubjectEmail,
		in.Channel, in.Category, in.Action, source, policyVersion,
		string(prefJSON), in.ProofText, ipArg, in.UserAgent, occurredAt,
		strings.TrimSpace(in.DecisionID), strings.TrimSpace(in.RequestFingerprint),
	)
	if err := row.Scan(&id); err != nil {
		return "", err
	}
	return id, nil
}

func marshalEventPreferences(in EventInput) ([]byte, error) {
	preferences := make(map[string]any, len(in.Preferences)+1)
	for key, value := range in.Preferences {
		preferences[key] = value
	}
	if in.GPC {
		preferences["gpc"] = true
	}
	prefJSON, err := json.Marshal(preferences)
	if err != nil {
		return nil, fmt.Errorf("consent: marshal preferences: %w", err)
	}
	if len(prefJSON) > maxConsentPreferencesBytes {
		return nil, fmt.Errorf("%w: preferences exceed evidence response bounds", ErrInvalidEvent)
	}
	return prefJSON, nil
}

// ReadGPC parses the one standardized affirmative Sec-GPC value. It remains a
// bool-only helper for internal callers; public request boundaries that need to
// distinguish an absent signal from a malformed one use readStrictGPC below.
func ReadGPC(r *http.Request) bool {
	enabled, err := readStrictGPC(r)
	return err == nil && enabled
}

// ClientIP delegates to the shared peer-aware resolver. Forwarded headers are
// considered only when explicitly enabled and the TCP peer is in the global
// trusted-proxy CIDR set.
func ClientIP(r *http.Request, trustForwarded ...bool) string {
	if r == nil {
		return ""
	}
	trust := len(trustForwarded) > 0 && trustForwarded[0]
	return middleware.ResolveClientIPString(r, trust)
}

var publicVisitorIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

func publicConsentSiteKey(r *http.Request, bodyKey string) string {
	if r != nil {
		if v := strings.TrimSpace(r.Header.Get("X-Postwave-Site-Key")); v != "" {
			return v
		}
		if fields := strings.Fields(r.Header.Get("Authorization")); len(fields) == 2 && strings.EqualFold(fields[0], "Bearer") {
			return fields[1]
		}
		if v := strings.TrimSpace(r.URL.Query().Get("site_key")); v != "" {
			return v
		}
	}
	return strings.TrimSpace(bodyKey)
}

// ---- HTTP admin read ----

// ---- HTTP public ingest ----

// PublicConsentInput is the body of POST /api/public/consent.
//
// The marketing cookie banner POSTs this on every accept/reject/custom
// transition. visitor_id is a first-party cookie or localStorage id —
// the server does not generate or set it. Tenant identity and the legal-policy
// version are resolved from a server-owned public site-key mapping; tenant_id,
// policy_version, subject_email, and proof_text are never trusted as evidence.
type PublicConsentInput struct {
	SiteKey       string         `json:"site_key,omitempty"`
	TenantID      string         `json:"tenant_id"`
	VisitorID     string         `json:"visitor_id"`
	SubjectEmail  string         `json:"subject_email,omitempty"`
	Choice        string         `json:"choice"` // accept|reject|custom|gpc
	Preferences   map[string]any `json:"prefs,omitempty"`
	PolicyVersion string         `json:"policy_version,omitempty"`
	ProofText     string         `json:"proof_text,omitempty"`
}

const publicConsentJSONMaxBodyBytes int64 = 16 << 10 // 16 KiB

const publicConsentSchemaVersion = 1

var (
	publicConsentFingerprintRE = regexp.MustCompile(`^[0-9a-f]{64}$`)
	errInvalidPublicGPC        = errors.New("consent: invalid Sec-GPC header")
	errPublicConsentConflict   = errors.New("consent: idempotency key conflict")
	errPublicConsentCorrupt    = errors.New("consent: stored public decision is incomplete or inconsistent")
)

// PublicConsentEventIDs names every row in the atomic public decision batch.
// A struct, rather than a map, keeps first-write and replay JSON byte-stable.
type PublicConsentEventIDs struct {
	Essential string `json:"essential"`
	Analytics string `json:"analytics"`
	Marketing string `json:"marketing"`
}

// PublicConsentResponse is the deterministic response for a public browser
// decision. Keyed retries reconstruct this shape solely from immutable ledger
// rows and therefore return the original event identities after a lost 202.
type PublicConsentResponse struct {
	SchemaVersion  int                   `json:"schema_version"`
	OK             bool                  `json:"ok"`
	IdempotencyKey string                `json:"idempotency_key,omitempty"`
	DecisionID     string                `json:"decision_id"`
	EventIDs       PublicConsentEventIDs `json:"event_ids"`
	Written        int                   `json:"written"`
	LastID         string                `json:"last_id"`
	GPC            bool                  `json:"gpc"`
	Source         string                `json:"source"`
	Idempotent     bool                  `json:"idempotent"`
}

type publicConsentSemantics struct {
	VisitorID string `json:"visitor_id"`
	Choice    string `json:"choice"`
	Analytics bool   `json:"analytics"`
	Marketing bool   `json:"marketing"`
	GPC       bool   `json:"gpc"`
}

type publicConsentStoredRow struct {
	ID          string
	Category    string
	Source      string
	GPC         bool
	Fingerprint string
}

// readStrictGPC accepts only the standardized affirmative signal. Sec-GPC is
// not a boolean-valued preference header: absent means no signal and exactly
// one field value of "1" means enabled. Treating "yes", "true", "0", or
// duplicated field-lines as meaningful would turn malformed intermediary or
// caller input into regulatory evidence.
func readStrictGPC(r *http.Request) (bool, error) {
	if r == nil {
		return false, nil
	}
	values := r.Header.Values("Sec-GPC")
	if len(values) == 0 {
		return false, nil
	}
	if len(values) != 1 || values[0] != "1" {
		return false, errInvalidPublicGPC
	}
	return true, nil
}

// publicConsentIdempotencyKey distinguishes the intentionally supported
// keyless legacy path from malformed keyed requests. Keys are preserved (not
// trimmed) so two byte-distinct client identities can never collapse.
func publicConsentIdempotencyKey(r *http.Request) (key string, keyed bool, err error) {
	if r == nil {
		return "", false, nil
	}
	values := r.Header.Values("Idempotency-Key")
	if len(values) == 0 {
		return "", false, nil
	}
	if len(values) != 1 {
		return "", false, errors.New("consent: Idempotency-Key must be supplied at most once")
	}
	key = values[0]
	if key == "" || len(key) > 255 || !utf8.ValidString(key) || strings.TrimSpace(key) != key {
		return "", false, errors.New("consent: invalid Idempotency-Key")
	}
	for _, r := range key {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			return "", false, errors.New("consent: invalid Idempotency-Key")
		}
	}
	return key, true, nil
}

func fingerprintPublicConsent(semantics publicConsentSemantics) string {
	// This fixed struct contains only stable client semantics. In particular,
	// do not add IP, user-agent, server-selected policy version, timestamps, or
	// resolver configuration: any of those would turn an exact client retry
	// into a false conflict after normal operational change.
	payload, _ := json.Marshal(semantics)
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func keyedPublicConsentDecisionID(tenantID, key string) string {
	// PostgreSQL UUID text is case-insensitive. Canonicalize it before hashing
	// so a resolver formatting change cannot turn an exact retry into a second
	// durable decision. Invalid resolver output still reaches the tenant-scope
	// boundary and fails closed there.
	if parsedTenant, err := uuid.Parse(strings.TrimSpace(tenantID)); err == nil {
		tenantID = parsedTenant.String()
	}
	h := sha256.New()
	_, _ = h.Write([]byte("postwave.public-consent.decision.v1\x00"))
	_, _ = h.Write([]byte(tenantID))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(key))
	sum := h.Sum(nil)
	// RFC 9562 UUIDv8: a standards-shaped identifier whose application-defined
	// payload is the first 128 bits of the domain-separated SHA-256 digest.
	sum[6] = (sum[6] & 0x0f) | 0x80
	sum[8] = (sum[8] & 0x3f) | 0x80
	decision, err := uuid.FromBytes(sum[:16])
	if err != nil { // fixed 16-byte slice; retained as a defensive invariant
		panic("consent: construct deterministic decision UUID: " + err.Error())
	}
	return decision.String()
}

func publicConsentResponseFromRows(
	decisionID, expectedFingerprint string,
	rows []publicConsentStoredRow,
) (PublicConsentResponse, bool, error) {
	if len(rows) == 0 {
		return PublicConsentResponse{}, false, nil
	}
	storedFingerprint := rows[0].Fingerprint
	if storedFingerprint != expectedFingerprint {
		return PublicConsentResponse{}, true, errPublicConsentConflict
	}
	if len(rows) != 3 || !publicConsentFingerprintRE.MatchString(storedFingerprint) {
		return PublicConsentResponse{}, true, errPublicConsentCorrupt
	}

	response := PublicConsentResponse{
		SchemaVersion: publicConsentSchemaVersion,
		OK:            true,
		DecisionID:    decisionID,
		Written:       3,
		Idempotent:    true,
		Source:        rows[0].Source,
		GPC:           rows[0].GPC,
	}
	seen := make(map[string]struct{}, 3)
	for _, row := range rows {
		if row.Fingerprint != storedFingerprint || row.Source != response.Source || row.GPC != response.GPC {
			return PublicConsentResponse{}, true, errPublicConsentCorrupt
		}
		if _, duplicate := seen[row.Category]; duplicate {
			return PublicConsentResponse{}, true, errPublicConsentCorrupt
		}
		if _, err := uuid.Parse(strings.TrimSpace(row.ID)); err != nil {
			return PublicConsentResponse{}, true, errPublicConsentCorrupt
		}
		seen[row.Category] = struct{}{}
		switch row.Category {
		case "essential":
			response.EventIDs.Essential = row.ID
		case "analytics":
			response.EventIDs.Analytics = row.ID
		case "marketing":
			response.EventIDs.Marketing = row.ID
			response.LastID = row.ID
		default:
			return PublicConsentResponse{}, true, errPublicConsentCorrupt
		}
	}
	if response.EventIDs.Essential == "" || response.EventIDs.Analytics == "" ||
		response.EventIDs.Marketing == "" ||
		(response.GPC && response.Source != "gpc") ||
		(!response.GPC && response.Source != "cookie_banner") {
		return PublicConsentResponse{}, true, errPublicConsentCorrupt
	}
	return response, true, nil
}

func loadPublicConsentDecision(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, decisionID, expectedFingerprint string,
) (PublicConsentResponse, bool, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text,
       category,
       source,
       COALESCE((preferences ->> 'gpc')::boolean, false),
       COALESCE(request_fingerprint, '')
  FROM consent_events
 WHERE tenant_id = $1::uuid
   AND decision_id = $2::uuid
 ORDER BY CASE category
            WHEN 'essential' THEN 1
            WHEN 'analytics' THEN 2
            WHEN 'marketing' THEN 3
            ELSE 4
          END,
          id`, tenantID, decisionID)
	if err != nil {
		return PublicConsentResponse{}, false, err
	}
	defer rows.Close()

	stored := make([]publicConsentStoredRow, 0, 3)
	for rows.Next() {
		var row publicConsentStoredRow
		if err := rows.Scan(&row.ID, &row.Category, &row.Source, &row.GPC, &row.Fingerprint); err != nil {
			return PublicConsentResponse{}, false, err
		}
		stored = append(stored, row)
	}
	if err := rows.Err(); err != nil {
		return PublicConsentResponse{}, false, err
	}
	return publicConsentResponseFromRows(decisionID, expectedFingerprint, stored)
}

func markLegacyPublicConsentResponse(w http.ResponseWriter) {
	w.Header().Set("Deprecation", "true")
	w.Header().Set("Warning", `299 Moosewave "Public consent writes without Idempotency-Key are deprecated"`)
}

// sanitizePublicConsentUserAgent treats browser metadata as optional
// provenance. A privacy choice must not be rejected because an intermediary
// supplied an oversized or display-unsafe User-Agent; omit that metadata while
// preserving the decision itself. Authenticated/internal writers remain
// fail-closed through validateEventInput.
func sanitizePublicConsentUserAgent(value string) string {
	value = strings.TrimSpace(value)
	if !optionalConsentToken(value, maxConsentUserAgentBytes) {
		return ""
	}
	return value
}

// PublicRecord POST /api/public/consent.
// Mounted in main.go inside the public route group (no API key, IP rate-limited).
//
// The endpoint never returns 5xx for a malformed enum — invalid choice
// or unknown tenant short-circuits to 400 so a misconfigured banner
// can't fill the logs with internal errors.
func (d *Deps) PublicRecord(w http.ResponseWriter, r *http.Request) {
	// Public consent bodies and durable evidence identifiers must never be
	// stored by a browser, CDN, or intermediary, including validation/auth
	// failures that return before a transaction begins.
	prepareSensitiveResponse(w)

	var in PublicConsentInput
	if err := httpbody.DecodeJSON(w, r, publicConsentJSONMaxBodyBytes, &in); err != nil {
		code := httpbody.ErrorCode(err)
		if httperror.IsValidationCode(code) {
			httperror.Write(w, httpbody.StatusCode(err), code, httpbody.PublicMessage(err))
		} else {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	headerGPC, err := readStrictGPC(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_sec_gpc", "Sec-GPC must be absent or supplied exactly once with value 1")
		return
	}
	idempotencyKey, keyed, err := publicConsentIdempotencyKey(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key must be one 1-255 byte UTF-8 value without surrounding whitespace or control characters")
		return
	}
	if d == nil || d.ResolveSiteKey == nil {
		writeErr(w, http.StatusServiceUnavailable, "consent_unavailable", "public consent identity resolver unavailable")
		return
	}
	siteKey := publicConsentSiteKey(r, in.SiteKey)
	if siteKey == "" {
		writeErr(w, http.StatusUnauthorized, "missing_site_key", "site key required")
		return
	}
	tenantID, policyVersion, err := d.ResolveSiteKey(r.Context(), siteKey)
	if err != nil || strings.TrimSpace(tenantID) == "" {
		writeErr(w, http.StatusUnauthorized, "invalid_site_key", "invalid site key")
		return
	}
	if supplied := strings.TrimSpace(in.TenantID); supplied != "" && supplied != tenantID {
		writeErr(w, http.StatusBadRequest, "tenant_mismatch", "tenant_id does not own the site key")
		return
	}
	visitorID := strings.TrimSpace(in.VisitorID)
	if !publicVisitorIDRE.MatchString(visitorID) {
		writeErr(w, http.StatusBadRequest, "invalid_visitor_id", "visitor_id must be a 16-128 character opaque identifier")
		return
	}
	// Anonymous browsers can attest only for their pseudonymous visitor id.
	// Subscriber email and proof text require a server-authenticated flow;
	// accepting them here would let anyone forge regulatory evidence.
	if strings.TrimSpace(in.SubjectEmail) != "" || strings.TrimSpace(in.ProofText) != "" {
		writeErr(w, http.StatusUnprocessableEntity, "untrusted_identity_fields", "subject_email and proof_text are not accepted on the public visitor endpoint")
		return
	}

	choice := strings.ToLower(strings.TrimSpace(in.Choice))
	_, source := classifyChoice(choice)
	if source == "" {
		writeErr(w, http.StatusBadRequest, "invalid_choice", "choice must be accept, reject, custom, or gpc")
		return
	}
	if !validPublicConsentPreferenceShape(in.Preferences) {
		writeErr(w, http.StatusUnprocessableEntity, "invalid_preferences", "essential, analytics, and marketing preferences must be booleans; essential cannot be false")
		return
	}
	if (!headerGPC || choice == "reject" || choice == "gpc") &&
		!publicConsentChoiceMatchesPreferences(choice, in.Preferences) {
		writeErr(w, http.StatusUnprocessableEntity, "invalid_preferences", "accept requires analytics and marketing; reject and gpc require both to be denied")
		return
	}
	prefs := in.Preferences
	choice, prefs, gpc := applyGlobalPrivacyControl(choice, prefs, headerGPC)
	_, source = classifyChoice(choice)

	// Each consent category is recorded as its own row so the auditor
	// can filter by category. Essential is always granted (the user
	// cannot turn it off — surface it for completeness).
	// Always record an essential=granted row.
	categories := []struct {
		Name    string
		Granted bool
	}{
		{"essential", true},
		{"analytics", boolPref(prefs, "analytics")},
		{"marketing", boolPref(prefs, "marketing")},
	}

	ip := ClientIP(r, d.TrustForwardedIPHeaders)
	ua := sanitizePublicConsentUserAgent(r.UserAgent())
	policyVersion = strings.TrimSpace(policyVersion)
	if policyVersion == "" {
		policyVersion = "v1"
	}
	if !boundedConsentToken(policyVersion, maxConsentPolicyVersionBytes) {
		// The policy version is selected by the trusted site-key resolver, not
		// supplied by this browser. Treat an invalid value as unavailable server
		// configuration rather than blaming the visitor with a 4xx response.
		writeErr(w, http.StatusServiceUnavailable, "consent_unavailable", "public consent policy configuration unavailable")
		return
	}
	proofText := fmt.Sprintf("server-captured visitor preference: choice=%s; essential=true; analytics=%t; marketing=%t; policy=%s",
		choice, boolPref(prefs, "analytics"), boolPref(prefs, "marketing"), policyVersion)

	semantics := publicConsentSemantics{
		VisitorID: visitorID,
		Choice:    choice,
		Analytics: boolPref(prefs, "analytics"),
		Marketing: boolPref(prefs, "marketing"),
		GPC:       gpc,
	}
	fingerprint := fingerprintPublicConsent(semantics)
	decisionID := uuid.NewString()
	if keyed {
		decisionID = keyedPublicConsentDecisionID(tenantID, idempotencyKey)
	}
	if d.Pool == nil {
		writeErr(w, http.StatusServiceUnavailable, "consent_unavailable", "public consent ledger unavailable")
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if keyed {
		// The lock is transaction-scoped and keyed by the durable decision UUID.
		// Concurrent same-key requests serialize before either checks/inserts,
		// closing the read-then-write race without holding a session-level lock.
		if _, err := tx.Exec(r.Context(), `
SELECT pg_advisory_xact_lock(
         hashtextextended($1, $2::bigint)
       )`, tenantID+":"+decisionID, int64(1979)); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		replayed, found, err := loadPublicConsentDecision(
			r.Context(), tx, tenantID, decisionID, fingerprint,
		)
		if err != nil {
			if errors.Is(err, errPublicConsentConflict) {
				writeErr(w, http.StatusConflict, "idempotency_key_conflict", "Idempotency-Key was already used for a different consent decision")
				return
			}
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if found {
			// Bind the acknowledgement to the exact client-generated request
			// identity. The key is already present in the request; echoing it in
			// this private/no-store response lets a durable browser queue reject a
			// syntactically valid response for any other in-flight decision.
			replayed.IdempotencyKey = idempotencyKey
			if err := tx.Commit(r.Context()); err != nil {
				httperror.WriteInternal(w, d.Logger, err, r.Context())
				return
			}
			w.Header().Set("Idempotent-Replayed", "true")
			writeJSON(w, http.StatusAccepted, replayed)
			return
		}
	}

	eventIDs := PublicConsentEventIDs{}
	for _, c := range categories {
		evAction := "granted"
		if !c.Granted {
			evAction = "denied"
		}
		// For an explicit reject the action stays "denied"; for GPC
		// we record the same denial but tag the source so the
		// auditor can distinguish the channel.
		if choice == "reject" && !c.Granted {
			evAction = "denied"
		}
		if gpc && !c.Granted {
			evAction = "denied"
		}
		id, err := RecordEventInTx(r.Context(), tx, EventInput{
			TenantID:           tenantID,
			DecisionID:         decisionID,
			RequestFingerprint: fingerprint,
			SubjectType:        "visitor",
			SubjectID:          visitorID,
			SubjectEmail:       "",
			Channel:            "web",
			Category:           c.Name,
			Action:             evAction,
			Source:             source,
			PolicyVersion:      policyVersion,
			GPC:                gpc,
			IP:                 ip,
			UserAgent:          ua,
			ProofText:          proofText,
			Preferences:        map[string]any{"choice": choice, "granted": c.Granted},
		})
		if err != nil {
			if errors.Is(err, ErrInvalidEvent) {
				httperror.WriteValidation(w, "invalid_input", err.Error())
				return
			}
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		switch c.Name {
		case "essential":
			eventIDs.Essential = id
		case "analytics":
			eventIDs.Analytics = id
		case "marketing":
			eventIDs.Marketing = id
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !keyed {
		markLegacyPublicConsentResponse(w)
	}
	response := PublicConsentResponse{
		SchemaVersion: publicConsentSchemaVersion,
		OK:            true,
		DecisionID:    decisionID,
		EventIDs:      eventIDs,
		Written:       3,
		LastID:        eventIDs.Marketing,
		GPC:           gpc,
		Source:        source,
		Idempotent:    keyed,
	}
	if keyed {
		response.IdempotencyKey = idempotencyKey
	}
	writeJSON(w, http.StatusAccepted, response)
}

func applyGlobalPrivacyControl(choice string, prefs map[string]any, headerGPC bool) (string, map[string]any, bool) {
	gpc := headerGPC || choice == "gpc"
	if prefs == nil {
		prefs = map[string]any{}
	}
	if !gpc {
		return choice, prefs, false
	}
	// Do not mutate the decoder-owned map: callers may reuse it when building
	// telemetry. GPC overrides non-essential grants even when the banner body
	// races with the browser-level signal and says "accept".
	overridden := make(map[string]any, len(prefs)+1)
	for key, value := range prefs {
		overridden[key] = value
	}
	overridden["analytics"] = false
	overridden["marketing"] = false
	overridden["gpc"] = true
	return "gpc", overridden, true
}

// classifyChoice maps a cookie-banner choice to (action, source) per
// the consent_events.action and consent_events.source conventions.
// Returns ("", "") on unknown input.
func classifyChoice(choice string) (action, source string) {
	switch choice {
	case "accept":
		return "granted", "cookie_banner"
	case "reject":
		return "denied", "cookie_banner"
	case "custom":
		return "granted", "cookie_banner"
	case "gpc":
		return "denied", "gpc"
	default:
		return "", ""
	}
}

func boolPref(m map[string]any, key string) bool {
	if m == nil {
		return false
	}
	if v, ok := m[key]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

func validPublicConsentPreferenceShape(prefs map[string]any) bool {
	for _, key := range []string{"essential", "analytics", "marketing"} {
		value, present := prefs[key]
		if !present {
			continue
		}
		boolean, ok := value.(bool)
		if !ok || (key == "essential" && !boolean) {
			return false
		}
	}
	return true
}

func publicConsentChoiceMatchesPreferences(choice string, prefs map[string]any) bool {
	analytics := boolPref(prefs, "analytics")
	marketing := boolPref(prefs, "marketing")
	switch choice {
	case "accept":
		return analytics && marketing
	case "reject", "gpc":
		return !analytics && !marketing
	case "custom":
		return true
	default:
		return false
	}
}
