package subscribers

// SUB-055 — jurisdiction-change consent re-confirmation.
//
// Re-confirmation is a compliance write, not a banner-dismiss action. The
// consent receipt, canonical consent event, channel projection, subscriber
// state, jurisdiction flag, downstream sync intent, and audit row therefore
// commit in one tenant-scoped transaction. Any failed write leaves the flag in
// place and the subscriber's consent state unchanged.

import (
	"context"
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

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	maxJurisdictionPolicyVersionBytes = 100
	maxJurisdictionPolicyVersionRunes = 100
	maxJurisdictionCapturedTextBytes  = 16 << 10
	maxJurisdictionCapturedTextRunes  = 8 << 10
)

var (
	// ErrJurisdictionReconfirmationNotRequired means another writer already
	// completed this drift, or no stricter-regime drift is pending. Treating it
	// as a conflict prevents a generic PATCH from manufacturing consent.
	ErrJurisdictionReconfirmationNotRequired = errors.New("jurisdiction re-confirmation is not required")
	// ErrJurisdictionReconfirmationStale is the compare-and-swap failure for a
	// client whose reviewed subscriber revision or jurisdiction_changed_at no
	// longer matches the locked row.
	ErrJurisdictionReconfirmationStale = errors.New("jurisdiction re-confirmation is stale")
	// ErrJurisdictionReconfirmationStateInvalid means the persisted drift cannot
	// be mapped to a server-owned strict regime. No evidence is written.
	ErrJurisdictionReconfirmationStateInvalid = errors.New("jurisdiction re-confirmation state is invalid")
	// ErrJurisdictionReconfirmationRegimeMismatch prevents a client-provided
	// regime label from disagreeing with the server's canonical classifier.
	ErrJurisdictionReconfirmationRegimeMismatch = errors.New("jurisdiction re-confirmation regime does not match the detected jurisdiction")
	// ErrJurisdictionReconfirmationInfrastructureUnavailable prevents a
	// send-eligibility mutation when its canonical webhook and engine-sync
	// intents cannot be durably appended in the same transaction.
	ErrJurisdictionReconfirmationInfrastructureUnavailable = errors.New("jurisdiction re-confirmation delivery infrastructure is unavailable")
)

var jurisdictionReconfirmRegimes = map[string]struct{}{
	"gdpr":  {},
	"casl":  {},
	"law25": {},
}

var exactSubscriberVersionPattern = regexp.MustCompile(`^"subscriber:[A-Za-z0-9._~-]+:v[0-9]+"$`)

// JurisdictionReconfirmInput is the complete evidence envelope required by
// PATCH /api/v1/subscribers/{id}/jurisdiction-reconfirm. The expected drift
// timestamp and strong subscriber version form a one-time compare-and-swap
// pair sourced from the same subscriber detail response.
type JurisdictionReconfirmInput struct {
	Decision                      string    `json:"decision"`
	Regime                        string    `json:"regime"`
	PrivacyPolicyVersion          string    `json:"privacy_policy_version"`
	CapturedText                  string    `json:"captured_text"`
	ExpectedJurisdictionChangedAt time.Time `json:"expected_jurisdiction_changed_at"`
	ExpectedSubscriberVersion     string    `json:"expected_subscriber_version"`
}

// normalizeJurisdictionReconfirmInput validates and canonicalizes the
// evidence envelope before any database lookup. CapturedText deliberately
// keeps its exact whitespace: it is the literal copy the subject reviewed.
func normalizeJurisdictionReconfirmInput(in *JurisdictionReconfirmInput, now time.Time) error {
	if in == nil {
		return errors.New("re-confirmation evidence is required")
	}
	in.Decision = strings.ToLower(strings.TrimSpace(in.Decision))
	if in.Decision != "accepted" && in.Decision != "declined" {
		return errors.New("decision must be 'accepted' or 'declined'")
	}
	in.Regime = strings.ToLower(strings.TrimSpace(in.Regime))
	if _, ok := jurisdictionReconfirmRegimes[in.Regime]; !ok {
		return errors.New("regime must be one of gdpr, casl, or law25")
	}
	in.PrivacyPolicyVersion = strings.TrimSpace(in.PrivacyPolicyVersion)
	if err := validateJurisdictionEvidenceText(
		"privacy_policy_version",
		in.PrivacyPolicyVersion,
		maxJurisdictionPolicyVersionBytes,
		maxJurisdictionPolicyVersionRunes,
		false,
	); err != nil {
		return err
	}
	if strings.TrimSpace(in.CapturedText) == "" {
		return errors.New("captured_text is required")
	}
	if err := validateJurisdictionEvidenceText(
		"captured_text",
		in.CapturedText,
		maxJurisdictionCapturedTextBytes,
		maxJurisdictionCapturedTextRunes,
		true,
	); err != nil {
		return err
	}
	if in.ExpectedJurisdictionChangedAt.IsZero() {
		return errors.New("expected_jurisdiction_changed_at is required")
	}
	if in.ExpectedJurisdictionChangedAt.After(now.UTC().Add(5 * time.Minute)) {
		return errors.New("expected_jurisdiction_changed_at cannot be in the future")
	}
	in.ExpectedJurisdictionChangedAt = in.ExpectedJurisdictionChangedAt.UTC()
	in.ExpectedSubscriberVersion = strings.TrimSpace(in.ExpectedSubscriberVersion)
	if len(in.ExpectedSubscriberVersion) > 256 ||
		!exactSubscriberVersionPattern.MatchString(in.ExpectedSubscriberVersion) {
		return errors.New("expected_subscriber_version must be the exact strong subscriber version from the reviewed response")
	}
	return nil
}

func validateJurisdictionEvidenceText(label, value string, maxBytes, maxRunes int, allowLayoutControls bool) error {
	if value == "" {
		return fmt.Errorf("%s is required", label)
	}
	if !utf8.ValidString(value) {
		return fmt.Errorf("%s must be valid UTF-8", label)
	}
	if len(value) > maxBytes || utf8.RuneCountInString(value) > maxRunes {
		return fmt.Errorf("%s exceeds its size limit", label)
	}
	for _, r := range value {
		if allowLayoutControls && (r == '\n' || r == '\r' || r == '\t') {
			continue
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return fmt.Errorf("%s must not contain control or format characters", label)
		}
	}
	return nil
}

// MountJurisdictionRoutes registers the SUB-055 re-confirmation route. The
// write-subscribers scope is required because this records a consent decision
// and can change the subscriber's send eligibility.
func MountJurisdictionRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/jurisdiction-reconfirm", d.JurisdictionReconfirm)
}

// JurisdictionReconfirm PATCH /api/v1/subscribers/{id}/jurisdiction-reconfirm.
func (d *Deps) JurisdictionReconfirm(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in JurisdictionReconfirmInput
	raw, err := httpbody.DecodeJSONBytes(r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true})
	if err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// encoding/json replaces malformed UTF-8 with U+FFFD. Consent evidence is
	// literal legal copy, so inspect the bounded original bytes and reject that
	// lossy normalization before persisting anything.
	if !utf8.Valid(raw) {
		httperror.WriteValidation(w, "invalid_jurisdiction_reconfirmation", "request body must be valid UTF-8")
		return
	}
	if err := normalizeJurisdictionReconfirmInput(&in, time.Now()); err != nil {
		httperror.WriteValidation(w, "invalid_jurisdiction_reconfirmation", err.Error())
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "jurisdiction_reconfirmation_unavailable", "jurisdiction re-confirmation is unavailable")
		return
	}

	meta := middleware.AuditMetaFromRequest(r)
	updated, applied, err := d.Repo.ReconfirmJurisdiction(r.Context(), t.ID, chi.URLParam(r, "id"), in, meta)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
		case errors.Is(err, ErrJurisdictionReconfirmationNotRequired):
			httperror.Write(w, http.StatusConflict, "jurisdiction_reconfirmation_not_required", "no jurisdiction re-confirmation is pending; refresh the subscriber")
		case errors.Is(err, ErrJurisdictionReconfirmationStale):
			httperror.Write(w, http.StatusConflict, "jurisdiction_reconfirmation_stale", "the subscriber's jurisdiction changed; refresh and review the current evidence")
		case errors.Is(err, ErrJurisdictionReconfirmationRegimeMismatch):
			httperror.Write(w, http.StatusConflict, "jurisdiction_reconfirmation_regime_mismatch", "the selected regime does not match the subscriber's detected jurisdiction; refresh and review")
		case errors.Is(err, ErrJurisdictionReconfirmationStateInvalid):
			httperror.Write(w, http.StatusConflict, "jurisdiction_reconfirmation_state_invalid", "the pending jurisdiction cannot be safely re-confirmed; refresh or contact support")
		case errors.Is(err, ErrConcurrentConsentDecision):
			httperror.Write(w, http.StatusConflict, "jurisdiction_reconfirmation_busy", "another consent decision is in progress; refresh the subscriber and retry")
		case errors.Is(err, ErrProtectedEmailSuppression):
			httperror.Write(w, http.StatusConflict, "protected_suppression", "this address has an active complaint, bounce, erasure, or unreviewed hold; resolve it before re-confirming consent")
		case errors.Is(err, ErrJurisdictionReconfirmationInfrastructureUnavailable):
			httperror.Write(w, http.StatusServiceUnavailable, "jurisdiction_reconfirmation_unavailable", "jurisdiction re-confirmation is temporarily unavailable")
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}

	if applied {
		d.emit(t.ID, "subscriber.jurisdiction_reconfirmed", map[string]any{
			"id":       updated.ID,
			"decision": in.Decision,
			"regime":   in.Regime,
		})
	}
	if updated != nil && strings.TrimSpace(updated.Version) != "" {
		w.Header().Set("ETag", updated.Version)
	}
	writeJSON(w, http.StatusOK, updated)
}

// ReconfirmJurisdiction records a complete, one-time jurisdiction decision.
// The row lock serializes concurrent attempts; the expected drift timestamp
// prevents an operator from applying evidence reviewed for an older drift.
// The boolean is true only for the writer that committed new evidence; an
// exact semantic retry returns the current subscriber with false.
func (r *Repo) ReconfirmJurisdiction(
	ctx context.Context,
	tenantID, id string,
	in JurisdictionReconfirmInput,
	meta db.AuditMeta,
) (*Subscriber, bool, error) {
	if r == nil || r.Pool == nil {
		return nil, false, errors.New("jurisdiction re-confirmation repository is unavailable")
	}
	if r.Webhooks == nil || r.EngineSyncOutbox == nil {
		return nil, false, ErrJurisdictionReconfirmationInfrastructureUnavailable
	}
	if err := normalizeJurisdictionReconfirmInput(&in, time.Now()); err != nil {
		return nil, false, fmt.Errorf("invalid jurisdiction re-confirmation: %w", err)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, subscriberSelectSQL+`
WHERE tenant_id = $1::uuid
  AND (id::text = $2 OR lower(email::text) = lower($2))
LIMIT 1
FOR UPDATE`, tenantID, id)
	before, err := scanSubscriber(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	// While the drift is still pending, bind the reviewed evidence to the
	// complete subscriber revision. jurisdiction_changed_at alone does not
	// advance when the canonical email rotates, so it cannot prevent consent
	// reviewed for address A from being applied to address B. Once the flag is
	// clear, an exact semantic retry is verified against the immutable receipt,
	// event, proof, and audit chain below rather than the now-advanced revision.
	if before.JurisdictionReconfirmRequired && before.Version != in.ExpectedSubscriberVersion {
		return nil, false, ErrJurisdictionReconfirmationStale
	}
	if before.JurisdictionChangedAt == nil || !before.JurisdictionChangedAt.Equal(in.ExpectedJurisdictionChangedAt) {
		return nil, false, ErrJurisdictionReconfirmationStale
	}
	if r.Jurisdiction == nil || before.DetectedJurisdiction == nil {
		return nil, false, ErrJurisdictionReconfirmationStateInvalid
	}
	expectedRegime := strings.ToLower(strings.TrimSpace(r.Jurisdiction.ConsentRegime(
		*before.DetectedJurisdiction,
		derefOrEmpty(before.Region),
	)))
	if _, ok := jurisdictionReconfirmRegimes[expectedRegime]; !ok {
		return nil, false, ErrJurisdictionReconfirmationStateInvalid
	}
	if in.Regime != expectedRegime {
		return nil, false, ErrJurisdictionReconfirmationRegimeMismatch
	}
	// A jurisdiction review is not a substitute for the dedicated reviewed
	// resubscribe workflow. Preserve complaint/manual-unsubscribe lineage and
	// require that separate operation before a blocklisted profile can become
	// sendable again.
	if in.Decision == "accepted" && before.Status == StatusBlocklisted {
		return nil, false, fmt.Errorf("%w: blocklisted subscribers require the reviewed resubscribe workflow", ErrJurisdictionReconfirmationStateInvalid)
	}

	// Resolve the canonical address through migration 1766's privileged,
	// tenant-bound repair surface before writing any positive evidence. A
	// retained grant may be hidden from ordinary app-role SELECTs while the
	// release gate is blocked or its proof is expired. The resolver both sees
	// that row and acquires the bounded exact-address mutex shared by consent,
	// suppression, channel, and subscriber projections.
	address, err := ensureCanonicalChannelConsentAddress(ctx, tx, tenantID, before)
	if errors.Is(err, ErrEmailTaken) {
		return nil, false, fmt.Errorf("%w: canonical email address is owned by another subscriber", ErrJurisdictionReconfirmationStateInvalid)
	}
	if err != nil {
		return nil, false, fmt.Errorf("resolve jurisdiction consent address: %w", err)
	}
	if err := validateJurisdictionConsentAddress(before, address); err != nil {
		return nil, false, err
	}

	decisionAt := time.Now().UTC()
	newReceiptState := "subscribed"
	newChannelState := "opted_in"
	if in.Decision == "declined" {
		newReceiptState = "unsubscribed"
		newChannelState = "opted_out"
	}
	prevReceiptState := strings.TrimSpace(before.MailchimpStatus)
	if prevReceiptState == "" {
		prevReceiptState = mailchimpStatusFromListmonk(before.Status)
	}
	detailRaw, err := json.Marshal(map[string]any{
		"regime":                  in.Regime,
		"decision":                in.Decision,
		"detected_jurisdiction":   derefOrEmpty(before.DetectedJurisdiction),
		"jurisdiction_changed_at": before.JurisdictionChangedAt.UTC().Format(time.RFC3339Nano),
		"subscriber_version":      in.ExpectedSubscriberVersion,
	})
	if err != nil {
		return nil, false, fmt.Errorf("encode jurisdiction receipt detail: %w", err)
	}
	if !before.JurisdictionReconfirmRequired {
		replayed, err := jurisdictionReconfirmationReplayMatches(
			ctx, tx, tenantID, before.ID, address.ID, before.Email, in,
			newReceiptState, string(detailRaw),
		)
		if err != nil {
			return nil, false, fmt.Errorf("verify jurisdiction re-confirmation replay: %w", err)
		}
		if !replayed {
			return nil, false, ErrJurisdictionReconfirmationNotRequired
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return before, false, nil
	}
	var ipArg any
	if parsed := net.ParseIP(strings.TrimSpace(meta.IP)); parsed != nil {
		ipArg = parsed.String()
	}
	var receiptID int64
	if err := tx.QueryRow(ctx, `
INSERT INTO consent_receipts
       (tenant_id, subscriber_id, subscriber_email, prev_state, new_state,
        source, source_detail, ip, user_agent, privacy_policy_version,
        captured_text, at)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5,
        'jurisdiction_reconfirm', $6, $7::inet, NULLIF($8, ''), $9, $10, $11)
RETURNING id`,
		tenantID, before.ID, strings.ToLower(strings.TrimSpace(before.Email)),
		prevReceiptState, newReceiptState, string(detailRaw), ipArg,
		meta.UserAgent, in.PrivacyPolicyVersion, in.CapturedText, decisionAt,
	).Scan(&receiptID); err != nil {
		return nil, false, fmt.Errorf("record jurisdiction consent receipt: %w", err)
	}

	consentEventID, consentRecordID, provenance, err := recordJurisdictionConsentEvidence(
		ctx, tx, tenantID, before, address, receiptID, in, decisionAt, meta,
	)
	if err != nil {
		return nil, false, err
	}
	projectedAddress, reconciliationState, err := lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, before.ID, before.Email,
	)
	if err != nil {
		return nil, false, fmt.Errorf("verify jurisdiction consent projection: %w", err)
	}
	if err := validateJurisdictionConsentProjection(
		before, address, projectedAddress, reconciliationState, in.Decision,
	); err != nil {
		return nil, false, err
	}
	if err := applyJurisdictionEmailDecision(
		ctx, tx, tenantID, before, projectedAddress, in.Decision, provenance,
	); err != nil {
		return nil, false, err
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_channel_consents
       (tenant_id, subscriber_id, channel, status, consent_timestamp,
        consent_source, email)
VALUES ($1::uuid, $2::uuid, 'email', $3, $4,
        'jurisdiction_reconfirm', $5)
ON CONFLICT (tenant_id, subscriber_id, channel) DO UPDATE SET
       status = EXCLUDED.status,
       consent_timestamp = EXCLUDED.consent_timestamp,
       consent_source = EXCLUDED.consent_source,
       email = EXCLUDED.email,
       updated_at = now()`,
		tenantID, before.ID, newChannelState, decisionAt, before.Email,
	); err != nil {
		return nil, false, fmt.Errorf("project jurisdiction channel consent: %w", err)
	}

	updatedRow := tx.QueryRow(ctx, `
UPDATE subscribers
   SET jurisdiction_reconfirm_required = false,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND jurisdiction_reconfirm_required
   AND jurisdiction_changed_at = $3
RETURNING `+subscriberColumns,
		tenantID, before.ID, in.ExpectedJurisdictionChangedAt)
	updated, err := scanSubscriber(updatedRow)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrJurisdictionReconfirmationStale
	}
	if err != nil {
		return nil, false, err
	}

	if err := r.fireJurisdictionReconfirmWebhooksInTx(ctx, tx, tenantID, before, updated, in.Decision); err != nil {
		return nil, false, err
	}
	if r.ConsentSyncLedger != nil {
		syncEvent := ConsentSyncEventConsentGranted
		if in.Decision == "declined" {
			syncEvent = ConsentSyncEventUnsubscribe
		}
		if err := r.ConsentSyncLedger.RecordEvent(ctx, tx, tenantID, updated.ID, syncEvent); err != nil {
			return nil, false, fmt.Errorf("record jurisdiction consent sync ledger: %w", err)
		}
	}
	if err := fireEmailConsentWebhook(
		ctx, r, tx, tenantID, updated, projectedAddress, consentEventID,
	); err != nil {
		return nil, false, err
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, updated.ID, ""); err != nil {
		return nil, false, err
	}

	meta.TenantID = tenantID
	if err := db.Audit(ctx, tx, meta,
		"subscriber.jurisdiction_reconfirmed", "subscriber", updated.ID,
		map[string]any{
			"decision":                    in.Decision,
			"regime":                      in.Regime,
			"privacy_policy_version":      in.PrivacyPolicyVersion,
			"detected_jurisdiction":       derefOrEmpty(before.DetectedJurisdiction),
			"jurisdiction_changed_at":     before.JurisdictionChangedAt.UTC().Format(time.RFC3339Nano),
			"reviewed_subscriber_version": in.ExpectedSubscriberVersion,
			"consent_receipt_id":          receiptID,
			"email_address_id":            address.ID,
			"canonical_consent_event_id":  consentEventID,
			"canonical_consent_record_id": consentRecordID,
		},
	); err != nil {
		return nil, false, fmt.Errorf("audit jurisdiction re-confirmation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return updated, true, nil
}

// fireJurisdictionReconfirmWebhooksInTx emits the subscriber lifecycle
// webhooks for a committed-in-tx jurisdiction decision: always .updated, plus
// .status_changed when the status moved and .unsubscribed when the subject
// declined. nil-safe when no webhook dispatcher is wired.
func (r *Repo) fireJurisdictionReconfirmWebhooksInTx(ctx context.Context, tx pgx.Tx, tenantID string, before, updated *Subscriber, decision string) error {
	if r.Webhooks == nil {
		return nil
	}
	if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
		TenantID: tenantID, EventType: EventSubscriberUpdated, Body: updated,
	}); err != nil {
		return fmt.Errorf("dispatch jurisdiction subscriber webhook: %w", err)
	}
	if before.Status != updated.Status {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID: tenantID, EventType: EventSubscriberStatusChanged, Body: updated,
		}); err != nil {
			return fmt.Errorf("dispatch jurisdiction status webhook: %w", err)
		}
	}
	if decision == "declined" {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID: tenantID, EventType: EventSubscriberUnsubscribed, Body: updated,
			IdempotencyKey: "subscriber-unsubscribed:" + updated.ID + ":" + updated.Version,
		}); err != nil {
			return fmt.Errorf("dispatch jurisdiction unsubscribe webhook: %w", err)
		}
	}
	return nil
}

const jurisdictionReconfirmationOperation = "jurisdiction_reconfirmation"

func normalizedJurisdictionEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func validateJurisdictionConsentAddress(subscriber *Subscriber, address *SubscriberEmail) error {
	if subscriber == nil || address == nil || strings.TrimSpace(address.ID) == "" ||
		address.SubscriberID != subscriber.ID ||
		normalizedJurisdictionEmail(address.Email) != normalizedJurisdictionEmail(subscriber.Email) {
		return fmt.Errorf("%w: canonical email address identity is missing or mismatched", ErrJurisdictionReconfirmationStateInvalid)
	}
	return nil
}

// recordJurisdictionConsentEvidence keeps the full legal copy in the durable
// jurisdiction receipt while recording migration 1766's canonical
// exact-address event/consent-record pair. The pair uses the reviewed
// direct-request vocabulary understood by the database proof validator and a
// short immutable receipt reference; large legal copy is never duplicated
// into the 2 KiB terminal proof field.
func recordJurisdictionConsentEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	subscriber *Subscriber,
	address *SubscriberEmail,
	receiptID int64,
	in JurisdictionReconfirmInput,
	decisionAt time.Time,
	meta db.AuditMeta,
) (eventID, recordID string, provenance ConsentProvenanceInput, err error) {
	if err := validateJurisdictionConsentAddress(subscriber, address); err != nil {
		return "", "", provenance, err
	}
	if receiptID <= 0 {
		return "", "", provenance, fmt.Errorf("%w: jurisdiction receipt identity is missing", ErrJurisdictionReconfirmationStateInvalid)
	}
	status := "subscribed"
	if in.Decision == "declined" {
		status = "unsubscribed"
	}
	when := decisionAt.UTC()
	provenance = ConsentProvenanceInput{
		Source:        "direct_request",
		Channel:       "api",
		LegalBasis:    "consent",
		OccurredAt:    &when,
		Jurisdiction:  derefOrEmpty(subscriber.DetectedJurisdiction),
		Evidence:      fmt.Sprintf("jurisdiction_reconfirm:consent_receipt:%d", receiptID),
		Reason:        fmt.Sprintf("subscriber %s jurisdiction re-confirmation under %s", in.Decision, in.Regime),
		PolicyVersion: in.PrivacyPolicyVersion,
	}
	if err := normalizeConsentProvenance(&provenance, true); err != nil {
		return "", "", provenance, fmt.Errorf("%w: canonical jurisdiction evidence is invalid: %v", ErrJurisdictionReconfirmationStateInvalid, err)
	}
	eventID, err = recordEmailConsentEvidence(
		ctx, tx, tenantID, subscriber, address, status, provenance,
		jurisdictionReconfirmationOperation, meta,
	)
	if err != nil {
		return "", "", provenance, fmt.Errorf("record canonical jurisdiction consent evidence: %w", err)
	}
	proofStatus := emailConsentProofStatus(status)
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM consent_records
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)
   AND channel = 'email'
   AND consent_status = $4
   AND evidence ->> 'event_id' = $5
   AND evidence ->> 'address_id' = $6
   AND evidence ->> 'operation' = $7
 ORDER BY recorded_at DESC NULLS LAST, created_at DESC, id DESC
 LIMIT 1`, tenantID, subscriber.ID, address.Email, proofStatus, eventID,
		address.ID, jurisdictionReconfirmationOperation).Scan(&recordID); err != nil {
		return "", "", provenance, fmt.Errorf("resolve canonical jurisdiction consent proof: %w", err)
	}
	return eventID, recordID, provenance, nil
}

func validateJurisdictionConsentProjection(
	subscriber *Subscriber,
	expectedAddress, projectedAddress *SubscriberEmail,
	reconciliationState, decision string,
) error {
	if err := validateJurisdictionConsentAddress(subscriber, projectedAddress); err != nil {
		return err
	}
	if expectedAddress == nil || projectedAddress.ID != expectedAddress.ID {
		return fmt.Errorf("%w: consent evidence projected to a different address", ErrJurisdictionReconfirmationStateInvalid)
	}
	if decision == "accepted" {
		if projectedAddress.ConsentStatus != "subscribed" || reconciliationState != "proven" {
			return fmt.Errorf("%w: accepted evidence did not reach a proven exact-address grant", ErrJurisdictionReconfirmationStateInvalid)
		}
		return nil
	}
	if projectedAddress.ConsentStatus != "unsubscribed" || reconciliationState != "failed_closed" {
		return fmt.Errorf("%w: declined evidence did not reach a terminal exact-address revocation", ErrJurisdictionReconfirmationStateInvalid)
	}
	return nil
}

// applyJurisdictionEmailDecision is the send-eligibility boundary. An
// accepted legal decision may clear only reversible unsubscribe holds captured
// under row locks; complaints, bounces, erasure holds, or an unattributed
// address-level hold abort the complete evidence transaction. A decline
// creates a durable exact-address safety hold.
func applyJurisdictionEmailDecision(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	subscriber *Subscriber,
	address *SubscriberEmail,
	decision string,
	provenance ConsentProvenanceInput,
) error {
	if err := validateJurisdictionConsentAddress(subscriber, address); err != nil {
		return err
	}
	if provenance.OccurredAt == nil {
		return fmt.Errorf("%w: canonical consent chronology is missing", ErrJurisdictionReconfirmationStateInvalid)
	}
	if decision == "accepted" {
		captured, err := captureReversibleSuppressionIDs(
			ctx, tx, tenantID, []string{normalizedJurisdictionEmail(address.Email)},
		)
		if err != nil {
			return err
		}
		capturedCount := len(captured.Subscriber) + len(captured.Email) + len(captured.Legacy)
		if err := deleteCapturedSuppressions(ctx, tx, tenantID, captured); err != nil {
			return err
		}
		var held bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM v_suppressions_unified
     WHERE tenant_id = $1::uuid AND lower(email) = lower($2)
       AND (expires_at IS NULL OR expires_at > now())
)`, tenantID, address.Email).Scan(&held); err != nil {
			return fmt.Errorf("recheck jurisdiction consent suppressions: %w", err)
		}
		if held || (address.Suppressed && capturedCount == 0) {
			return ErrProtectedEmailSuppression
		}
		tag, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET consent_status = 'subscribed', suppressed = false,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND id = $3::uuid`,
			tenantID, subscriber.ID, address.ID)
		if err != nil {
			return fmt.Errorf("project jurisdiction exact-address grant: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("%w: exact-address grant target disappeared", ErrJurisdictionReconfirmationStateInvalid)
		}
		tag, err = tx.Exec(ctx, `
UPDATE subscribers
   SET status = CASE
           WHEN status IN ('disabled', 'unconfirmed') THEN 'enabled'
           ELSE status
       END,
	       mailchimp_status = 'subscribed',
       consent_timestamp = $3,
       consent_source = 'api',
       consent_email_marketing_at = $3,
	       unsubscribe_reason = NULL,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, subscriber.ID, *provenance.OccurredAt)
		if err != nil {
			return fmt.Errorf("project jurisdiction subscriber grant: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("%w: jurisdiction subscriber grant target disappeared", ErrJurisdictionReconfirmationStateInvalid)
		}
		return nil
	}

	tag, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET consent_status = 'unsubscribed', suppressed = true,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND id = $3::uuid`,
		tenantID, subscriber.ID, address.ID)
	if err != nil {
		return fmt.Errorf("project jurisdiction exact-address revocation: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("%w: exact-address revocation target disappeared", ErrJurisdictionReconfirmationStateInvalid)
	}
	if err := ensureEmailSafetySuppression(
		ctx, tx, tenantID, address, jurisdictionReconfirmationOperation,
		provenance.Reason, provenance.Evidence,
	); err != nil {
		return err
	}
	tag, err = tx.Exec(ctx, `
UPDATE subscribers
   SET status = CASE WHEN status <> 'blocklisted' THEN 'disabled' ELSE status END,
	       mailchimp_status = 'unsubscribed',
       consent_timestamp = $3,
       consent_source = 'api',
       consent_email_marketing_at = NULL,
       unsubscribe_reason = CASE
           WHEN status <> 'blocklisted' THEN 'jurisdiction_reconfirmation_declined'
           ELSE unsubscribe_reason
       END,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, subscriber.ID, *provenance.OccurredAt)
	if err != nil {
		return fmt.Errorf("project jurisdiction subscriber revocation: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("%w: jurisdiction subscriber revocation target disappeared", ErrJurisdictionReconfirmationStateInvalid)
	}
	return nil
}

// jurisdictionReconfirmationReplayMatches makes an exact retry idempotent
// without weakening the one-receipt-per-drift invariant. The full evidence
// envelope and drift timestamp are the semantic idempotency key. A different
// decision or copy after the flag cleared remains a 409 conflict.
func jurisdictionReconfirmationReplayMatches(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, addressID, subscriberEmail string,
	in JurisdictionReconfirmInput,
	newReceiptState, sourceDetail string,
) (bool, error) {
	var receiptID int64
	err := tx.QueryRow(ctx, `
SELECT id
  FROM consent_receipts
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND source = 'jurisdiction_reconfirm'
   AND new_state = $3
   AND privacy_policy_version = $4
   AND captured_text = $5
   AND source_detail = $6
 ORDER BY at DESC, id DESC
 LIMIT 1`,
		tenantID, subscriberID, newReceiptState, in.PrivacyPolicyVersion,
		in.CapturedText, sourceDetail,
	).Scan(&receiptID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	eventAction := "granted"
	recordStatus := "granted"
	if in.Decision == "declined" {
		eventAction = "revoked"
		recordStatus = "withdrawn"
	}
	var consentEventID string
	err = tx.QueryRow(ctx, `
SELECT id::text
  FROM consent_events
 WHERE tenant_id = $1::uuid
   AND subject_id = $2
   AND lower(subject_email::text) = lower($3)
   AND source = 'direct_request'
   AND channel = 'api'
   AND category = 'email_marketing'
   AND action = $4
   AND policy_version = $5
   AND proof_text = $6
   AND preferences ->> 'operation' = 'jurisdiction_reconfirmation'
   AND preferences ->> 'subscriber_id' = $7
   AND preferences ->> 'address_id' = $2
 ORDER BY created_at DESC, id DESC
 LIMIT 1`,
		tenantID, addressID, subscriberEmail, eventAction,
		in.PrivacyPolicyVersion,
		fmt.Sprintf("jurisdiction_reconfirm:consent_receipt:%d", receiptID),
		subscriberID,
	).Scan(&consentEventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var consentRecordID string
	err = tx.QueryRow(ctx, `
SELECT id::text
  FROM consent_records
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)
   AND channel = 'email'
   AND consent_status = $4
   AND evidence ->> 'event_id' = $5
   AND evidence ->> 'address_id' = $6
   AND evidence ->> 'operation' = 'jurisdiction_reconfirmation'
 ORDER BY recorded_at DESC NULLS LAST, created_at DESC, id DESC
 LIMIT 1`, tenantID, subscriberID, subscriberEmail, recordStatus,
		consentEventID, addressID).Scan(&consentRecordID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	var audited bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM audit_log
     WHERE tenant_id = $1::uuid
       AND resource_id = $2
       AND action = 'subscriber.jurisdiction_reconfirmed'
       AND metadata ->> 'consent_receipt_id' = $3
       AND metadata ->> 'canonical_consent_event_id' = $4
       AND metadata ->> 'canonical_consent_record_id' = $5
)`, tenantID, subscriberID, fmt.Sprint(receiptID), consentEventID,
		consentRecordID).Scan(&audited); err != nil {
		return false, err
	}
	return audited, nil
}
