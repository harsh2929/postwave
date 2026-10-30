// SPDX-License-Identifier: AGPL-3.0-only
//
// Package consent implements the consent-receipt log.
//
// Two surfaces:
//
//   1. Record(): callers (form ingest, subscribe API, unsubscribe
//      handler, CSV import) insert one row per consent change.
//   2. Read endpoints: per-subscriber history + per-tenant range
//      lookups for the auditor flow.
//
// The package is intentionally narrow — it does NOT try to be a
// general "events" system. It's a compliance audit trail. Every
// caller passes (tenantID, subscriberEmail, prev, new, source,
// metadata) and we just append.

package consent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var (
	ErrConsentStoreUnavailable = errors.New("consent: evidence store unavailable")
	ErrInvalidReceipt          = errors.New("consent: invalid receipt")
)

// Receipt is one row of consent history.
type Receipt struct {
	// ID is text because the ledger now UNIONs two tables with different
	// PK types (D05#6): consent_receipts (bigint) + consent_records (uuid).
	ID                   string    `json:"id"`
	SubscriberEmail      string    `json:"subscriber_email"`
	PrevState            string    `json:"prev_state,omitempty"`
	NewState             string    `json:"new_state"`
	Source               string    `json:"source"`
	SourceDetail         string    `json:"source_detail,omitempty"`
	IP                   string    `json:"ip,omitempty"`
	UserAgent            string    `json:"user_agent,omitempty"`
	PrivacyPolicyVersion string    `json:"privacy_policy_version,omitempty"`
	CapturedText         string    `json:"captured_text,omitempty"`
	At                   time.Time `json:"at"`
	// RecordedAt is the database-owned recording chronology. At remains the
	// asserted occurrence time and can legitimately be backdated by reviewed
	// jurisdiction/import flows.
	RecordedAt time.Time `json:"recorded_at"`
	// Kind distinguishes the two ledgers: "receipt" = consent_receipts
	// state-change stream, "proof" = consent_records structured proof
	// (form/import/API captures the auditor needs). Lets the UI label them.
	Kind string `json:"kind"`
}

// RecordInput is the shape every caller (form, API, CSV, etc.)
// uses to log a consent change. The package-level Record func is
// the canonical entry point — keeps the SQL in one place + makes
// future evolution (e.g. dual-writing to an external audit log)
// trivial.
type RecordInput struct {
	TenantID             string
	SubscriberID         string // optional; empty if not yet resolved
	SubscriberEmail      string
	PrevState            string
	NewState             string
	Source               string // 'form:<id>' | 'api:/v1/...' | 'csv_import' | 'unsubscribe_link' | 'admin' | 'migration:<source>'
	SourceDetail         string
	IP                   string
	UserAgent            string
	PrivacyPolicyVersion string
	CapturedText         string
}

// Record appends a consent-receipt row. Missing storage or malformed evidence
// fails closed; the function never reports a successful no-op or silently
// weakens a supplied network-identity field.
func Record(ctx context.Context, pool *db.Pool, in RecordInput) (int64, error) {
	if err := validateRecordInput(in); err != nil {
		return 0, err
	}
	if pool == nil {
		return 0, ErrConsentStoreUnavailable
	}
	tx, err := db.WithTenant(ctx, pool, in.TenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	var ipArg any
	if parsed := net.ParseIP(strings.TrimSpace(in.IP)); parsed != nil {
		ipArg = parsed.String()
	}
	var subID any
	if in.SubscriberID != "" {
		subID = in.SubscriberID
	}
	err = tx.QueryRow(ctx, `
INSERT INTO consent_receipts
  (tenant_id, subscriber_id, subscriber_email,
   prev_state, new_state, source, source_detail,
   ip, user_agent, privacy_policy_version, captured_text)
VALUES ($1::uuid, $2::uuid, $3,
        NULLIF($4, ''), $5, $6, NULLIF($7, ''),
        $8::inet, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''))
RETURNING id`,
		in.TenantID, subID, strings.ToLower(strings.TrimSpace(in.SubscriberEmail)),
		in.PrevState, in.NewState, in.Source, in.SourceDetail,
		ipArg, in.UserAgent, in.PrivacyPolicyVersion, in.CapturedText).Scan(&id)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return id, nil
}

func validateRecordInput(in RecordInput) error {
	if _, err := uuid.Parse(strings.TrimSpace(in.TenantID)); err != nil {
		return fmt.Errorf("%w: tenant_id must be a UUID", ErrInvalidReceipt)
	}
	if in.SubscriberID != "" {
		if _, err := uuid.Parse(strings.TrimSpace(in.SubscriberID)); err != nil {
			return fmt.Errorf("%w: subscriber_id must be a UUID", ErrInvalidReceipt)
		}
	}
	if in.IP != "" && net.ParseIP(strings.TrimSpace(in.IP)) == nil {
		return fmt.Errorf("%w: ip must be a valid address", ErrInvalidReceipt)
	}
	if !validConsentEmailShape(in.SubscriberEmail) {
		return fmt.Errorf("%w: subscriber_email violates evidence bounds", ErrInvalidReceipt)
	}
	switch in.NewState {
	case "subscribed", "unsubscribed", "bounced", "complained", "pending":
	default:
		return fmt.Errorf("%w: new_state is unsupported", ErrInvalidReceipt)
	}
	if !optionalConsentToken(in.PrevState, maxConsentStateBytes) ||
		!boundedConsentToken(in.Source, maxConsentSourceBytes) ||
		!optionalConsentNarrative(in.SourceDetail, maxConsentSourceDetailBytes) ||
		!optionalConsentToken(in.UserAgent, maxConsentUserAgentBytes) ||
		!optionalConsentToken(in.PrivacyPolicyVersion, maxConsentPolicyVersionBytes) ||
		!optionalConsentNarrative(in.CapturedText, maxConsentNarrativeBytes) {
		return fmt.Errorf("%w: text field violates evidence bounds", ErrInvalidReceipt)
	}
	return nil
}

// --- HTTP read surface ---

// Deps wires the read endpoints.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
	// CursorSigningKey authenticates the full consent evidence cursor and its
	// filter binding. It must be a dedicated, independently rotated secret of at
	// least 32 bytes; reusing API-key/auth peppers would couple unrelated trust
	// domains. Evidence reads fail closed when it is unavailable.
	CursorSigningKey []byte
	// Outbox is mandatory for tracking-consent mutations: the preference
	// projection, canonical event, audit evidence, and subscriber consent
	// webhook intent must share one transaction.
	Outbox TrackingOutboxAppender
	// ResolveSiteKey binds an anonymous browser request to the tenant that
	// owns the public site key. The policy version is server-selected so a
	// caller cannot manufacture which legal copy it supposedly accepted.
	ResolveSiteKey func(ctx context.Context, siteKey string) (tenantID, policyVersion string, err error)
	// TrustForwardedIPHeaders is safe only after middleware.SetTrustedProxyCIDRs
	// has been configured. The canonical resolver still verifies the TCP peer.
	TrustForwardedIPHeaders bool
}

// MountRoutes registers the auditor-facing reads.
//
//	GET /api/v1/consent/receipts                         tenant range
//	GET /api/v1/consent/receipts/by-email/{email}        per-subscriber
//
// admin scope — consent history is sensitive (regulators ask for
// it during audits, internal access should be intentional).
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(protectAdminConsentRead).Get("/api/v1/consent/receipts", d.List)
	r.With(protectAdminConsentRead).Get("/api/v1/consent/receipts/by-email/{email}", d.ByEmail)
	// consent_events (0094 schema) — broader ledger covering visitors,
	// users, subscribers, workspaces. Same admin scope as the receipts
	// surface since the data sensitivity is identical.
	r.With(protectAdminConsentRead).Get("/api/v1/consent/events", d.ListEvents)
	// Recipient-level tracking eligibility. Write scope mirrors the
	// rest of the subscriber surface.
	writeSubs := apikeys.RequireScope(apikeys.ScopeWriteSubscribers)
	readSubs := apikeys.RequireScope(apikeys.ScopeReadSubscribers)
	// Stable subscriber identity is the primary tracking-consent surface.
	r.With(ProtectSensitiveResponses, readSubs).Get("/api/v1/subscribers/{id}/tracking-consent", d.GetTrackingByID)
	r.With(ProtectSensitiveResponses, writeSubs).Patch("/api/v1/subscribers/{id}/tracking-consent", d.PatchTrackingByID)
	// Email-keyed compatibility is deprecated. GET remains available; PATCH
	// requires If-Match so rename/reuse cannot redirect a stale mutation.
	r.With(ProtectSensitiveResponses, readSubs).Get("/api/v1/consent/subscribers/{email}/tracking", d.GetTracking)
	r.With(ProtectSensitiveResponses, writeSubs).Patch("/api/v1/consent/subscribers/{email}/tracking", d.PatchTracking)
}

// protectAdminConsentRead is deliberately stricter than a generic admin-scope
// gate. API-key callers must hold the exact admin scope; dashboard callers must
// be durable/effective owner or admin even if a custom role was accidentally
// granted an admin-shaped stored permission. Keeping the response protector
// outermost also covers every denial status.
func protectAdminConsentRead(next http.Handler) http.Handler {
	return ProtectSensitiveResponses(
		apikeys.RequireAPIKeyScope(apikeys.ScopeAdmin)(
			requireExactAdminConsentSessionRole(next),
		),
	)
}

// requireExactAdminConsentSessionRole is intentionally route-specific: stored
// custom-role grants may satisfy the outer generic ScopeAdmin gate, but they do
// not authorize raw consent evidence. API-key callers already passed the exact
// scope check and bypass this session-only role floor.
func requireExactAdminConsentSessionRole(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if middleware.IsAPIKeyAuth(r.Context()) {
			next.ServeHTTP(w, r)
			return
		}
		user, ok := middleware.UserFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusUnauthorized, "missing_principal", "an authenticated API key or dashboard user is required")
			return
		}
		switch strings.ToLower(strings.TrimSpace(user.EffectiveRoleOrDurable())) {
		case "owner", "admin":
			next.ServeHTTP(w, r)
		default:
			entitlement.Write(w, entitlement.Denial{
				Subject:      "consent_evidence",
				Reason:       entitlement.ReasonRole,
				Code:         "insufficient_role",
				Message:      "this route requires an effective owner or admin role",
				RequiredRole: "admin",
				Remedy:       entitlement.RemedyContactWorkspaceAdmin,
			})
		}
	})
}

// MountPublicRoutes wires the no-auth public consent surface.
// Callers MUST place the returned routes inside an IP rate-limited
// group (e.g. the publicRateLimit chain used by /api/public/forms).
func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(ProtectSensitiveResponses).Post("/api/public/consent", d.PublicRecord)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
