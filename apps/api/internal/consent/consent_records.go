// SPDX-License-Identifier: AGPL-3.0-only
//
// consent_records is the structured, immutable consent-proof ledger
// landed in migration 0248 to answer the question every GDPR /
// CCPA / LGPD regulator asks during a complaint: "show me when and
// how this person agreed to be emailed." The legacy consent_receipts
// table (this file's older cousin) is a plain-English event stream
// keyed on email; consent_records adds the structured form_id, IP,
// user-agent and source-URL columns the auditor needs for first-
// party evidence.
//
// Callers (form ingest, CSV import, public subscribe API) hit
// RecordProof to append. No deletes — the ledger is append-only,
// with the 0248 schema enforcing that at the GRANT level.

package consent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Sentinel errors the caller can branch on.
var (
	ErrConsentMissingRequired = errors.New("consent: tenant_id + email + consent_status required")
	ErrConsentInvalidStatus   = errors.New("consent: consent_status must be one of granted|withdrawn|pending|expired")
	ErrConsentInvalidSource   = errors.New("consent: source must be one of form|double_optin|single_optin|api|import|admin|preference_center|one_click|webhook|unknown")
	ErrConsentInvalidEvidence = errors.New("consent: proof evidence is invalid")
)

// validProofStatus mirrors the CHECK constraint on consent_records.consent_status.
var validProofStatus = map[string]struct{}{
	"granted":   {},
	"withdrawn": {},
	"pending":   {},
	"expired":   {},
}

// validProofSource mirrors the CHECK constraint on consent_records.source.
var validProofSource = map[string]struct{}{
	"form":              {},
	"double_optin":      {},
	"single_optin":      {},
	"api":               {},
	"import":            {},
	"admin":             {},
	"preference_center": {},
	"one_click":         {},
	"webhook":           {},
	"unknown":           {},
}

// ProofInput is the wire shape callers pass to RecordProof. SubscriberID
// is optional — import / form-ingest paths may not yet have resolved
// the row by the time they capture proof.
type ProofInput struct {
	TenantID      string
	SubscriberID  string // optional
	Email         string
	Channel       string // email|sms|push|all (default email)
	ConsentStatus string // granted|withdrawn|pending|expired
	Source        string // form|import|api|...
	SourceURL     string
	FormID        string // optional uuid
	IP            string
	UserAgent     string
	CapturedAt    time.Time // zero => now()
	ExpiresAt     *time.Time
	Evidence      map[string]any
}

// Proof is the row shape returned from reads + the receipt the
// auditor sees.
type Proof struct {
	ID            string         `json:"id"`
	SubscriberID  string         `json:"subscriber_id,omitempty"`
	Email         string         `json:"email"`
	Channel       string         `json:"channel"`
	ConsentStatus string         `json:"consent_status"`
	Source        string         `json:"source"`
	SourceURL     string         `json:"source_url,omitempty"`
	FormID        string         `json:"form_id,omitempty"`
	IP            string         `json:"ip,omitempty"`
	UserAgent     string         `json:"user_agent,omitempty"`
	CapturedAt    time.Time      `json:"captured_at"`
	ExpiresAt     *time.Time     `json:"expires_at,omitempty"`
	Evidence      map[string]any `json:"evidence"`
}

// RecordProof appends a single consent_records row. Missing storage or
// malformed evidence fails closed; it never reports a successful no-op or
// retries inside a transaction PostgreSQL has already aborted.
func RecordProof(ctx context.Context, pool *db.Pool, in ProofInput) (string, error) {
	if in.TenantID == "" || in.Email == "" || in.ConsentStatus == "" {
		return "", ErrConsentMissingRequired
	}
	if _, ok := validProofStatus[in.ConsentStatus]; !ok {
		return "", ErrConsentInvalidStatus
	}
	if in.Source == "" {
		in.Source = "unknown"
	}
	if _, ok := validProofSource[in.Source]; !ok {
		return "", ErrConsentInvalidSource
	}
	if in.Channel == "" {
		in.Channel = "email"
	}
	if _, err := uuid.Parse(strings.TrimSpace(in.TenantID)); err != nil {
		return "", fmt.Errorf("%w: tenant_id must be a UUID", ErrConsentInvalidEvidence)
	}
	if in.SubscriberID != "" {
		if _, err := uuid.Parse(strings.TrimSpace(in.SubscriberID)); err != nil {
			return "", fmt.Errorf("%w: subscriber_id must be a UUID", ErrConsentInvalidEvidence)
		}
	}
	if in.FormID != "" {
		if _, err := uuid.Parse(strings.TrimSpace(in.FormID)); err != nil {
			return "", fmt.Errorf("%w: form_id must be a UUID", ErrConsentInvalidEvidence)
		}
	}
	if in.IP != "" && net.ParseIP(strings.TrimSpace(in.IP)) == nil {
		return "", fmt.Errorf("%w: ip must be a valid address", ErrConsentInvalidEvidence)
	}
	if !validConsentEmailShape(in.Email) ||
		!optionalConsentNarrative(in.SourceURL, maxConsentSourceDetailBytes) ||
		!optionalConsentToken(in.UserAgent, maxConsentUserAgentBytes) {
		return "", fmt.Errorf("%w: proof text violates evidence bounds", ErrConsentInvalidEvidence)
	}
	evidenceRaw, marshalErr := json.Marshal(nonNil(in.Evidence))
	if marshalErr != nil {
		return "", fmt.Errorf("consent: marshal proof evidence: %w", marshalErr)
	}
	if len(evidenceRaw) > maxConsentPreferencesBytes {
		return "", fmt.Errorf("%w: proof evidence exceeds storage bounds", ErrConsentInvalidEvidence)
	}
	if pool == nil {
		return "", ErrConsentStoreUnavailable
	}
	captured := in.CapturedAt
	if captured.IsZero() {
		captured = time.Now().UTC()
	}
	tx, err := db.WithTenant(ctx, pool, in.TenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ipArg any
	if parsed := net.ParseIP(strings.TrimSpace(in.IP)); parsed != nil {
		ipArg = parsed.String()
	}
	var subID any
	if in.SubscriberID != "" {
		subID = in.SubscriberID
	}
	var formID any
	if in.FormID != "" {
		formID = in.FormID
	}
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO consent_records
  (tenant_id, subscriber_id, email, channel, consent_status,
   source, source_url, form_id, ip_addr, user_agent,
   captured_at, expires_at, evidence)
VALUES ($1::uuid, $2::uuid, $3, $4, $5,
        $6, NULLIF($7, ''), $8::uuid, $9::inet, NULLIF($10, ''),
        $11, $12, $13::jsonb)
RETURNING id::text`,
		in.TenantID, subID, strings.ToLower(strings.TrimSpace(in.Email)),
		in.Channel, in.ConsentStatus,
		in.Source, in.SourceURL, formID, ipArg, in.UserAgent,
		captured, in.ExpiresAt, evidenceRaw).Scan(&id)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func nonNil(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

// PrivacyFlagInput is the upsert payload for subscriber_privacy_flags.
// Optional fields use *bool so callers can patch (e.g. only GPC) without
// clobbering the do_not_sell value the operator set elsewhere.
type PrivacyFlagInput struct {
	TenantID               string
	SubscriberID           string
	GPCSignaled            *bool
	DoNotSell              *bool
	MarketingConsentStatus string // granted|withdrawn|pending|unknown — empty = leave as-is
}

// UpsertPrivacyFlags writes / patches the per-subscriber privacy flag
// row landed by migration 0254. Each non-nil field is updated; nil
// fields preserve the existing value, so the form-ingest path can call
// this with just GPCSignaled = &true without erasing a previously-set
// do_not_sell flag.
//
// Called from the public form-submit handler when Sec-GPC: 1 is
// present, and from the preference-center "do not sell or share my
// info" toggle.
func UpsertPrivacyFlags(ctx context.Context, pool *db.Pool, in PrivacyFlagInput) error {
	if pool == nil || in.TenantID == "" || in.SubscriberID == "" {
		return ErrConsentMissingRequired
	}
	tx, err := db.WithTenant(ctx, pool, in.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Use NULL semantics on the bind args + COALESCE on the SET so
	// nil inputs preserve existing column values. status is text so
	// we use NULLIF.
	var gpc, dns any
	if in.GPCSignaled != nil {
		gpc = *in.GPCSignaled
	}
	if in.DoNotSell != nil {
		dns = *in.DoNotSell
	}
	_, err = tx.Exec(ctx, `
INSERT INTO subscriber_privacy_flags
  (subscriber_id, tenant_id, gpc_signaled, do_not_sell,
   marketing_consent_status, last_updated)
VALUES ($1::uuid, $2::uuid,
        COALESCE($3::boolean, false),
        COALESCE($4::boolean, false),
        COALESCE(NULLIF($5, ''), 'unknown'),
        now())
ON CONFLICT (subscriber_id) DO UPDATE
   SET gpc_signaled = COALESCE($3::boolean, subscriber_privacy_flags.gpc_signaled),
       do_not_sell = COALESCE($4::boolean, subscriber_privacy_flags.do_not_sell),
       marketing_consent_status = COALESCE(NULLIF($5, ''), subscriber_privacy_flags.marketing_consent_status),
       last_updated = now()`,
		in.SubscriberID, in.TenantID, gpc, dns, in.MarketingConsentStatus)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// HonorGPCFromRequest is the convenience the public form-submit
// handler calls. When Sec-GPC: 1 is present AND the tenant has a
// privacy_regions row marking the subscriber's region as
// gpc_honored=true, this flips the GPC flag + downgrades the
// marketing consent to "withdrawn" or "pending" per region policy.
//
// Region is matched by region_code which the caller should pre-
// resolve from the subscriber's country (e.g. via a GeoIP lookup) —
// passing "" defaults to "withdraw on GPC" which is the safe choice
// every CCPA-equivalent regime requires.
func HonorGPCFromRequest(ctx context.Context, pool *db.Pool, tenantID, subscriberID, regionCode string) error {
	if pool == nil || tenantID == "" || subscriberID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Per-region policy lookup: honour=false → skip the write entirely.
	// requires_explicit_consent=true → downgrade to "pending" (a fresh
	// consent action is needed). Else withdrawn.
	var honored bool
	var requiresExplicit bool
	if regionCode != "" {
		err = tx.QueryRow(ctx, `
SELECT gpc_honored, requires_explicit_consent
  FROM privacy_regions
 WHERE region_code = $1`,
			regionCode).Scan(&honored, &requiresExplicit)
		if err != nil {
			// No region row → fall back to "honour" (safe default).
			honored = true
			requiresExplicit = false
		}
	} else {
		honored = true
	}
	if !honored {
		return tx.Commit(ctx)
	}
	status := "withdrawn"
	if requiresExplicit {
		status = "pending"
	}
	_, err = tx.Exec(ctx, `
INSERT INTO subscriber_privacy_flags
  (subscriber_id, tenant_id, gpc_signaled, do_not_sell, marketing_consent_status, last_updated)
VALUES ($1::uuid, $2::uuid, true, false, $3, now())
ON CONFLICT (subscriber_id) DO UPDATE
   SET gpc_signaled = true,
       marketing_consent_status = $3,
       last_updated = now()`,
		subscriberID, tenantID, status)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DoNotSellSubscriberIDs returns the set of subscriber UUIDs whose
// do_not_sell flag is true. Audience-destination sync code (Meta /
// Google Customer Match — Wave 3) MUST filter these out before
// pushing the audience to a third-party platform. Callers pass the
// upstream candidate set and receive the subset that's safe to ship.
//
// Returned as map[string]struct{} so callers can probe in O(1) while
// iterating the candidate list.
func DoNotSellSubscriberIDs(ctx context.Context, pool *db.Pool, tenantID string, candidates []string) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	if pool == nil || tenantID == "" || len(candidates) == 0 {
		return out, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subscriber_id::text
  FROM subscriber_privacy_flags
 WHERE subscriber_id = ANY($1::uuid[])
   AND do_not_sell = true`, candidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
