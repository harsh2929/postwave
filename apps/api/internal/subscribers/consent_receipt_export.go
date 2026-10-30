// SUB-056 — release-held consent receipt export candidate.
//
// The legacy assembler below is retained for remediation work, but the mounted
// HTTP routes fail closed with a stable 503. Its current source coverage and
// error handling have not been certified as a complete portable record, so it
// must not be represented or delivered as an ISO/Kantara-compliant export.
//
// The five consent purposes mirror the subscribers consent-vector columns:
//   consent_email_marketing_at -> email_marketing
//   consent_sms_marketing_at   -> sms_marketing
//   consent_profiling_at       -> profiling
//   consent_targeted_ads_at    -> targeted_ads
//   consent_ai_processing_at   -> ai_processing
//
// Wire surface (both admin scope):
//   GET /api/v1/subscribers/{id}/consent-receipt.json   inline JSON receipt
//   GET /api/v1/subscribers/{id}/consent-receipt.zip     ZIP-wrapped receipt
//
// The .zip wrapper reuses the data_export.go zip + filename-sanitization
// helpers so a wallet that prefers an archive (e.g. alongside a SAR bundle)
// gets the same packaging conventions.

package subscribers

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	consentledger "github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// consentReceiptVersion is the Kantara Initiative Consent Receipt schema
// version this receipt conforms to (codified by ISO/IEC 27560).
const consentReceiptVersion = "KI-CR-v1.1"

// consentReceiptJurisdiction names the receipt-format spec.
const consentReceiptJurisdiction = "ISO/IEC 27560"

// consentPurpose pairs a vector column's value with its machine purpose key.
// Kept as a small ordered list so the receipt's services block is stable
// (deterministic ordering matters for wallet diffing + the unit tests).
type consentPurpose struct {
	purpose   string
	grantedAt *time.Time
}

// consentReceiptOrgContext is the per-tenant organizational context the
// receipt's piiController + policyUri blocks need. Loaded from
// tenant_consent_receipt_settings (0548), falling back to the tenant name.
type consentReceiptOrgContext struct {
	ControllerName    string
	ControllerContact string
	PrivacyPolicyURI  string
}

// MountConsentReceiptRoutes preserves the authenticated route identities while
// the export is release-held. Both remain exact admin scope so the hold cannot
// become an existence oracle for less-privileged callers.
func MountConsentReceiptRoutes(r chi.Router, d *Deps) {
	r.With(consentledger.ProtectSensitiveResponses, apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/subscribers/{id}/consent-receipt.json", d.ConsentReceiptJSON)
	r.With(consentledger.ProtectSensitiveResponses, apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/subscribers/{id}/consent-receipt.zip", d.ConsentReceiptZIP)
}

func prepareConsentReceiptReleaseHold(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Add("Vary", "Authorization")
	w.Header().Add("Vary", "Cookie")
}

func writeConsentReceiptReleaseHold(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, errEnv(
		"consent_receipt_export_unavailable",
		"Portable consent receipt export is unavailable pending evidence-completeness certification.",
	))
}

// ConsentReceiptJSON GET /api/v1/subscribers/{id}/consent-receipt.json.
func (d *Deps) ConsentReceiptJSON(w http.ResponseWriter, r *http.Request) {
	prepareConsentReceiptReleaseHold(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	_ = t
	writeConsentReceiptReleaseHold(w)
	return
	/* Release-held legacy implementation. Do not make reachable without a
	   reviewed complete-source contract, fail-closed read audit, and conformance
	   evidence.
	receipt, sub, err := d.buildConsentReceiptForRequest(r, t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeConsentReceiptErr(w, r, t.ID, err)
		return
	}
	_ = sub
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Postwave-Consent-Receipt-ID", receipt.ConsentReceiptID)
	w.WriteHeader(http.StatusOK)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(receipt)
	*/
}

// ConsentReceiptZIP GET /api/v1/subscribers/{id}/consent-receipt.zip.
func (d *Deps) ConsentReceiptZIP(w http.ResponseWriter, r *http.Request) {
	prepareConsentReceiptReleaseHold(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	_ = t
	writeConsentReceiptReleaseHold(w)
	return
	/* Release-held legacy implementation; see ConsentReceiptJSON.
	receipt, sub, err := d.buildConsentReceiptForRequest(r, t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeConsentReceiptErr(w, r, t.ID, err)
		return
	}
	zipBytes, err := buildConsentReceiptZip(receipt, time.Now().UTC())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	filename := fmt.Sprintf("subscriber-%s-consent-receipt-%s.zip",
		sanitizeEmailForFilename(sub.Email),
		time.Now().UTC().Format("2006-01-02"))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("X-Postwave-Consent-Receipt-ID", receipt.ConsentReceiptID)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(zipBytes)
	*/
}

// buildConsentReceiptForRequest resolves the subscriber, loads the org context
// + consent history, and assembles the portable receipt. Returns the resolved
// subscriber alongside so the ZIP path can derive the filename.
func (d *Deps) buildConsentReceiptForRequest(r *http.Request, tenantID, id string) (*ConsentReceiptJSON, *Subscriber, error) {
	sub, err := d.Repo.Get(r.Context(), tenantID, id)
	if err != nil {
		return nil, nil, err
	}
	email := strings.ToLower(strings.TrimSpace(sub.Email))
	if email == "" {
		return nil, nil, ErrInvalidInput
	}
	org, history, err := d.Repo.LoadConsentReceiptContext(r.Context(), tenantID, email)
	if err != nil {
		return nil, nil, err
	}
	receipt := buildConsentReceipt(sub, org, history, time.Now().UTC())
	return receipt, sub, nil
}

// writeConsentReceiptErr maps the build errors onto HTTP statuses.
func (d *Deps) writeConsentReceiptErr(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
	case errors.Is(err, ErrInvalidInput):
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("missing_email", "subscriber has no email"))
	default:
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

// buildConsentReceipt assembles the ISO 27560 / Kantara CR v1.1 receipt from
// the resolved subscriber, the org context, and the consent history. Pure
// (no I/O) so the schema-compliance + state-mapping contract is unit-tested
// directly. generatedAt drives the receipt's consentTimestamp.
func buildConsentReceipt(sub *Subscriber, org consentReceiptOrgContext, history []ConsentReceiptHistoryEntry, generatedAt time.Time) *ConsentReceiptJSON {
	// Receipt id: prefer the stable profile id, fall back to the row id.
	receiptID := strings.TrimSpace(sub.ProfileID)
	if receiptID == "" {
		receiptID = sub.ID
	}

	purposes := []consentPurpose{
		{purpose: "email_marketing", grantedAt: sub.ConsentEmailMarketingAt},
		{purpose: "sms_marketing", grantedAt: sub.ConsentSMSMarketingAt},
		{purpose: "profiling", grantedAt: sub.ConsentProfilingAt},
		{purpose: "targeted_ads", grantedAt: sub.ConsentTargetedAdsAt},
		{purpose: "ai_processing", grantedAt: sub.ConsentAIProcessingAt},
	}
	services := make([]ConsentReceiptService, 0, len(purposes))
	for _, p := range purposes {
		services = append(services, ConsentReceiptService{
			Purpose:     p.purpose,
			ConsentType: "EXPLICIT",
			Active:      p.grantedAt != nil,
			GrantedAt:   p.grantedAt,
		})
	}

	controllerName := strings.TrimSpace(org.ControllerName)
	if controllerName == "" {
		controllerName = "Moosewave Tenant"
	}

	if history == nil {
		history = []ConsentReceiptHistoryEntry{}
	}

	return &ConsentReceiptJSON{
		Version:          consentReceiptVersion,
		JurisdictionSpec: consentReceiptJurisdiction,
		ConsentReceiptID: receiptID,
		ConsentTimestamp: generatedAt,
		PIIPrincipalID:   strings.ToLower(strings.TrimSpace(sub.Email)),
		SubjectProfileID: strings.TrimSpace(sub.ProfileID),
		PIIController: ConsentReceiptController{
			PIIControllerName: controllerName,
			Contact:           strings.TrimSpace(org.ControllerContact),
		},
		PolicyURI: strings.TrimSpace(org.PrivacyPolicyURI),
		Services:  services,
		History:   history,
	}
}

// buildConsentReceiptZip wraps the receipt in a ZIP with a README, reusing the
// data_export.go zip-entry helper. Kept structurally parallel to
// buildDataExportZip so a wallet ingesting both sees the same conventions.
func buildConsentReceiptZip(receipt *ConsentReceiptJSON, generatedAt time.Time) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	readme := fmt.Sprintf(`Moosewave portable consent receipt
=====================================

Receipt ID:        %s
Subject:           %s
Generated at:      %s
Schema:            %s (%s)

Contents:
  consent-receipt.json   ISO 27560 / Kantara CR v1.1 portable consent receipt

This receipt is a point-in-time snapshot of the subject's consent state-of-
record plus the full consent change history. It is intended for ingestion by
an identity wallet. Re-run the export to refresh it.
`, receipt.ConsentReceiptID, receipt.PIIPrincipalID, generatedAt.Format(time.RFC3339),
		receipt.Version, receipt.JurisdictionSpec)
	if err := writeZipEntry(zw, "README.txt", []byte(readme)); err != nil {
		return nil, err
	}

	raw, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeZipEntry(zw, "consent-receipt.json", raw); err != nil {
		return nil, err
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// LoadConsentReceiptContext loads the per-tenant organizational context
// (controller name/contact + privacy policy URI from tenant_consent_receipt_settings,
// falling back to the tenant name) and the consent change history from
// consent_receipts, in one tenant-scoped tx. A missing settings row is the
// common case and degrades to the tenant name + omitted URI.
func (r *Repo) LoadConsentReceiptContext(ctx context.Context, tenantID, email string) (consentReceiptOrgContext, []ConsentReceiptHistoryEntry, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return consentReceiptOrgContext{}, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var org consentReceiptOrgContext

	// Tenant name as the controller-name fallback.
	var tenantName *string
	if err := tx.QueryRow(ctx,
		`SELECT name FROM tenants WHERE id = $1::uuid`, tenantID,
	).Scan(&tenantName); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return consentReceiptOrgContext{}, nil, err
	}
	if tenantName != nil {
		org.ControllerName = *tenantName
	}

	// Per-tenant receipt settings (0548) override the controller name and
	// supply the privacy policy URI + contact. Absent row = keep fallbacks.
	var ctrlName, ctrlContact, policyURI *string
	err = tx.QueryRow(ctx, `
SELECT controller_name, controller_contact, privacy_policy_uri
  FROM tenant_consent_receipt_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&ctrlName, &ctrlContact, &policyURI)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return consentReceiptOrgContext{}, nil, err
	}
	if ctrlName != nil && strings.TrimSpace(*ctrlName) != "" {
		org.ControllerName = *ctrlName
	}
	if ctrlContact != nil {
		org.ControllerContact = *ctrlContact
	}
	if policyURI != nil {
		org.PrivacyPolicyURI = *policyURI
	}

	// Consent change history (0140), newest first.
	history, err := loadConsentReceiptHistory(ctx, tx, email)
	if err != nil {
		return consentReceiptOrgContext{}, nil, err
	}
	// SMS consent lives in its own append-only table and is merged in, because
	// the receipt asserts an `sms_marketing` grant and must be able to evidence
	// it. See loadSMSConsentReceiptHistory.
	smsHistory, err := loadSMSConsentReceiptHistory(ctx, tx, email)
	if err != nil {
		return consentReceiptOrgContext{}, nil, err
	}
	history = append(history, smsHistory...)
	// Newest first, with a deterministic tiebreak. `created_at` defaults to
	// transaction_timestamp(), so a grant and a revoke written in one transaction
	// carry the SAME instant — and a stable sort then preserves append order,
	// putting every email entry ahead of every SMS one and reporting a
	// grant→revoke pair as though the grant were current. On a tie the withdrawal
	// sorts first, because a receipt that is uncertain about the order must not
	// be the one that claims consent is live.
	sort.SliceStable(history, func(i, j int) bool {
		if !history[i].At.Equal(history[j].At) {
			return history[i].At.After(history[j].At)
		}
		return consentStateRank(history[i].NewState) < consentStateRank(history[j].NewState)
	})

	if err := tx.Commit(ctx); err != nil {
		return consentReceiptOrgContext{}, nil, err
	}
	return org, history, nil
}

// loadConsentReceiptHistory reads the append-only consent_receipts (0140) rows
// for an email and maps them into the portable receipt's camelCase history
// shape. Mirrors sar.loadConsentReceipts; a read failure (e.g. missing table)
// degrades to an empty history rather than failing the whole receipt.
func loadConsentReceiptHistory(ctx context.Context, tx pgx.Tx, email string) ([]ConsentReceiptHistoryEntry, error) {
	rows, err := tx.Query(ctx, `
SELECT COALESCE(prev_state, ''), new_state, source,
       COALESCE(source_detail, ''), COALESCE(host(ip), ''),
       COALESCE(user_agent, ''), COALESCE(privacy_policy_version, ''),
       COALESCE(captured_text, ''), at
  FROM consent_receipts
 WHERE subscriber_email = $1
 ORDER BY at DESC`, email)
	if err != nil {
		return []ConsentReceiptHistoryEntry{}, nil
	}
	defer rows.Close()
	out := []ConsentReceiptHistoryEntry{}
	for rows.Next() {
		var e ConsentReceiptHistoryEntry
		if err := rows.Scan(&e.PrevState, &e.NewState, &e.Source, &e.SourceDetail,
			&e.IP, &e.UserAgent, &e.PrivacyPolicyVersion, &e.CapturedText, &e.At); err != nil {
			continue
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// loadSMSConsentReceiptHistory reads the SMS consent trail.
//
// SMS consent is NOT recorded in `consent_receipts` (0140). It has its own
// append-only table, `sms_consent_events`, written by internal/sms. While
// `subscribers.consent_sms_marketing_at` was permanently NULL that separation
// was invisible — the receipt reported `sms_marketing active:false` and claimed
// nothing. Projecting the column (1861/1862) made the receipt assert an explicit
// SMS grant while its evidence block stayed empty, which is the one thing an
// ISO 27560 receipt must never do: assert consent it cannot substantiate.
//
// Merged into the same history rather than exposed as a second block, because a
// data subject asking "what did you record about my consent" is asking one
// question. Two lists, each complete on its own side, is the same shape of
// defect this work keeps closing.
func loadSMSConsentReceiptHistory(ctx context.Context, tx pgx.Tx, email string) ([]ConsentReceiptHistoryEntry, error) {
	// Keyed by email OR by any phone bound to this subscriber.
	//
	// Email alone is not enough, and the gap was the worst possible one:
	// `sms.recordConsentTx` — the carrier-webhook and Twilio keyword path, i.e.
	// what runs when someone texts STOP — inserts the event WITHOUT
	// `subscriber_email`. An email-keyed lookup matched the product-path grant
	// and missed every inbound opt-out, so the receipt asserted the consent and
	// omitted its withdrawal. `internal/sar` already keys this table by phone via
	// `sms_subscriptions`; doing the same here means the two exports describe the
	// same subject rather than two overlapping halves of them.
	rows, err := tx.Query(ctx, `
SELECT e.action, COALESCE(e.source, ''), COALESCE(e.phone_e164, ''),
       COALESCE(e.proof_text, ''), e.created_at
  FROM sms_consent_events e
 WHERE e.subscriber_email = $1::citext
    OR e.phone_e164 IN (
        SELECT ss.phone_e164 FROM sms_subscriptions ss
         WHERE ss.subscriber_email = $1::citext)
 ORDER BY e.created_at DESC, e.id DESC`, email)
	if err != nil {
		// Returned, not swallowed. An earlier version claimed this "degrades to
		// empty rather than failing the whole receipt" — false: the query runs in
		// the SHARED transaction, so a failure aborts it and Commit then fails
		// with `commit unexpectedly resulted in rollback` anyway. Swallowing only
		// hid which query broke. (The email-history loader above has the same
		// shape and the same problem; left alone here because changing it is a
		// behaviour change to an untouched path.)
		return nil, fmt.Errorf("load sms consent history: %w", err)
	}
	defer rows.Close()
	out := []ConsentReceiptHistoryEntry{}
	for rows.Next() {
		var action, source, phone, proof string
		var at time.Time
		if err := rows.Scan(&action, &source, &phone, &proof, &at); err != nil {
			continue
		}
		out = append(out, ConsentReceiptHistoryEntry{
			NewState: smsConsentReceiptState(action),
			// `sms:` prefixed so a reader can tell which channel an entry
			// describes; the two trails are merged and would otherwise be
			// indistinguishable.
			Source:       "sms:" + defaultedString(source, "unknown"),
			SourceDetail: redactedPhoneForReceipt(phone),
			CapturedText: proof,
			At:           at,
		})
	}
	return out, rows.Err()
}

// smsConsentReceiptState maps the SMS action vocabulary onto the receipt's
// state vocabulary. `revoked` becomes `withdrawn` because that is the word the
// receipt schema and every regulator use for the same event.
func smsConsentReceiptState(action string) string {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "granted":
		return "subscribed"
	case "revoked":
		return "withdrawn"
	case "imported":
		return "pending"
	default:
		return strings.ToLower(strings.TrimSpace(action))
	}
}

func defaultedString(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// redactedPhoneForReceipt keeps the last four digits only.
//
// The receipt is an export handed to the data subject, but it is also produced
// by tenant staff and stored wherever they put it. The full number adds nothing
// to "this is the SMS channel" that the last four digits do not, and a consent
// artifact should not be a place identifiers accumulate.
func redactedPhoneForReceipt(phone string) string {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return ""
	}
	if len(phone) <= 4 {
		return "sms ending " + phone
	}
	return "sms ending " + phone[len(phone)-4:]
}

// consentStateRank orders states within one instant. Withdrawal outranks a grant
// so an ambiguous receipt errs toward reporting consent as ended.
func consentStateRank(state string) int {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "withdrawn", "unsubscribed", "revoked":
		return 0
	default:
		return 1
	}
}
