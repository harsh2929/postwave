package sms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type Store struct {
	Pool *db.Pool
	// These flags are set only by composition that supplies a dedicated
	// least-privilege database identity. The ordinary API Store leaves them
	// false; caller-settable PostgreSQL GUCs are never treated as identity.
	SMSWorkerIdentityAvailable        bool
	SMSClickResolverIdentityAvailable bool
}

var ErrInvalidConsentInput = errors.New("invalid SMS consent input")
var ErrInvalidCampaignInput = errors.New("invalid SMS campaign input")
var ErrSMSWorkerIdentityUnavailable = errors.New("dedicated SMS worker database identity is unavailable")
var ErrSMSClickResolverUnavailable = errors.New("dedicated SMS click resolver database identity is unavailable")
var ErrProviderTenantBinding = errors.New("provider webhook does not bind to exactly one tenant sender")

// ResolveProviderWebhookSender validates the provider receiver/application
// identity on one tenant row. Migration 1983 makes each phone/profile globally
// unique. When a callback supplies both dimensions, both must be non-null and
// equal on that same row; a profile-only sender must record its actual number
// assignment before number-bearing callbacks can be accepted. Query-string
// sender ids are deliberately not inputs to this decision.
func (s *Store) ResolveProviderWebhookSender(ctx context.Context, tenantID, provider, destination, providerProfileID string) (string, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	providerProfileID = strings.TrimSpace(providerProfileID)
	phone := ""
	if strings.TrimSpace(destination) != "" {
		var err error
		phone, err = NormalizePhoneUSCA(destination)
		if err != nil {
			return "", ErrProviderTenantBinding
		}
	}
	if !oneOf(provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) ||
		(phone == "" && providerProfileID == "") ||
		!validBoundedToken(providerProfileID, 256, true) {
		return "", ErrProviderTenantBinding
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM sms_sender_profiles
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND (
     ($4 <> '' AND messaging_service_sid = $4 AND ($3 = '' OR phone_number = $3))
     OR ($4 = '' AND $3 <> '' AND phone_number = $3)
   )
 ORDER BY id
 LIMIT 2`, tenantID, provider, phone, providerProfileID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(ids) != 1 {
		return "", ErrProviderTenantBinding
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return ids[0], nil
}

func (s *Store) Setup(ctx context.Context, tenantID string) (SetupStatus, error) {
	senders, err := s.ListSenders(ctx, tenantID)
	if err != nil {
		return SetupStatus{}, err
	}
	out := SetupStatus{Senders: senders}
	if len(senders) == 0 {
		out.BlockingReasons = append(out.BlockingReasons, "no_sender_profile")
		return out, nil
	}
	for _, sender := range senders {
		if sender.RegistrationStatus == RegistrationApproved && !SenderPaused(sender.Metadata) {
			out.CanSend = true
			return out, nil
		}
	}
	out.BlockingReasons = append(out.BlockingReasons, "sender_registration_not_approved_or_paused")
	return out, nil
}

func (s *Store) SMSCreditsUsed(ctx context.Context, tenantID string, start, end time.Time) (int, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var used int
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(
			GREATEST(
				1,
				CEIL(
					CASE
						WHEN cost_micros > 0 THEN cost_micros::numeric / $4::numeric
						ELSE GREATEST(1, segments)::numeric
					END
				)::int
			)
		), 0)::int
		  FROM sms_messages
		 WHERE tenant_id = $1::uuid
		   AND direction = 'outbound'
		   AND created_at >= $2
		   AND created_at < $3`, tenantID, start, end, smsCreditValueMicros).Scan(&used)
	if err != nil {
		return 0, err
	}
	return used, tx.Commit(ctx)
}

// CreditUsagePoint is one day's SMS credit consumption (SMS-045).
type CreditUsagePoint struct {
	Date string `json:"date"` // YYYY-MM-DD (UTC day bucket)
	Used int    `json:"used_credits"`
}

// SMSCreditUsageSeries returns per-day outbound credit consumption over
// [start, end), newest last — the time-series backing the usage-over-time
// analytics. Mirrors SMSCreditsUsed's per-message credit formula, grouped by
// UTC day.
func (s *Store) SMSCreditUsageSeries(ctx context.Context, tenantID string, start, end time.Time) ([]CreditUsagePoint, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT date_trunc('day', created_at)::date AS day,
		       COALESCE(SUM(
		         GREATEST(1, CEIL(
		           CASE
		             WHEN cost_micros > 0 THEN cost_micros::numeric / $4::numeric
		             ELSE GREATEST(1, segments)::numeric
		           END
		         )::int)
		       ), 0)::int AS used
		  FROM sms_messages
		 WHERE tenant_id = $1::uuid
		   AND direction = 'outbound'
		   AND created_at >= $2
		   AND created_at < $3
		 GROUP BY 1
		 ORDER BY 1`, tenantID, start, end, smsCreditValueMicros)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CreditUsagePoint{}
	for rows.Next() {
		var day time.Time
		var p CreditUsagePoint
		if err := rows.Scan(&day, &p.Used); err != nil {
			return nil, err
		}
		p.Date = day.Format("2006-01-02")
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) Compliance(ctx context.Context, tenantID string, publicBaseURL string, webhookVerification map[string]bool) (ComplianceStatus, error) {
	senders, err := s.ListSenders(ctx, tenantID)
	if err != nil {
		return ComplianceStatus{}, err
	}
	out := ComplianceStatus{Senders: senders}
	hasSender := len(senders) > 0
	approved := false
	activeApproved := false
	hasBrand := false
	hasCampaign := false
	hasMessagingService := false
	hasProviderWebhookVerification := false
	for _, sender := range senders {
		if sender.RegistrationStatus == RegistrationApproved {
			approved = true
			if !SenderPaused(sender.Metadata) {
				activeApproved = true
			}
		}
		if webhookConfiguredForProvider(webhookVerification, sender.Provider) {
			hasProviderWebhookVerification = true
		}
		if sender.BrandRegistrationSID != "" {
			hasBrand = true
		}
		if sender.CampaignRegistrationSID != "" {
			hasCampaign = true
		}
		if sender.MessagingServiceSID != "" {
			hasMessagingService = true
		}
	}
	out.Items = []ComplianceItem{
		{Key: "sender_profile", Label: "SMS sender profile", Complete: hasSender},
		{Key: "messaging_service", Label: "Messaging Service or sender number", Complete: hasMessagingService || hasSender},
		{Key: "brand_registration", Label: "A2P Brand registration recorded", Complete: hasBrand},
		{Key: "campaign_registration", Label: "A2P Campaign registration recorded", Complete: hasCampaign},
		{Key: "approved_sender", Label: "Sender registration approved", Complete: approved},
		{Key: "sender_not_paused", Label: "Sender kill switch off", Complete: activeApproved},
		{Key: "public_base_url", Label: "Public callback base URL configured", Complete: publicBaseURL != ""},
		{Key: "webhook_signature", Label: "Provider webhook verification configured", Complete: hasProviderWebhookVerification},
	}
	out.CanSend = hasSender && activeApproved && publicBaseURL != "" && hasProviderWebhookVerification
	return out, nil
}

func (s *Store) ListLists(ctx context.Context, tenantID string) ([]SMSList, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, name, description, COALESCE(keyword, ''),
		       COALESCE(sender_profile_id::text, ''), created_at, updated_at,
		       (SELECT count(*)::int FROM sms_subscriptions sub
		         WHERE sub.tenant_id = sms_lists.tenant_id
		           AND sub.list_id = sms_lists.id
		           AND public.sms_subscription_send_eligible(
		             sub.tenant_id, sub.list_id, sub.phone_e164, sub.status,
		             sub.consent_source, sub.consent_text, sub.consent_at, sub.proof))
		  FROM sms_lists
		 WHERE tenant_id = $1::uuid
		 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SMSList{}
	for rows.Next() {
		item, err := scanListWithCount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

var ErrInvalidSMSListInput = errors.New("invalid SMS list input")

func validateSMSListInput(in *SMSListInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Keyword = strings.ToUpper(strings.TrimSpace(in.Keyword))
	if in.Name == "" || !validInboxText(in.Name, 256) {
		return fmt.Errorf("%w: name must contain 1 to 256 safe Unicode code points", ErrInvalidSMSListInput)
	}
	if !validInboxText(in.Description, 2048) {
		return fmt.Errorf("%w: description must contain at most 2048 safe Unicode code points", ErrInvalidSMSListInput)
	}
	if in.Keyword != "" && !validInboxText(in.Keyword, 64) {
		return fmt.Errorf("%w: keyword must contain at most 64 safe Unicode code points", ErrInvalidSMSListInput)
	}
	if in.SenderProfileID != "" && !validCanonicalUUIDV4(in.SenderProfileID) {
		return fmt.Errorf("%w: sender_profile_id must be a canonical lowercase UUIDv4", ErrInvalidSMSListInput)
	}
	return nil
}

func (s *Store) CreateList(ctx context.Context, tenantID string, in SMSListInput) (SMSList, error) {
	if err := validateSMSListInput(&in); err != nil {
		return SMSList{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SMSList{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if in.SenderProfileID != "" {
		var owned bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sms_sender_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid)`, tenantID, in.SenderProfileID).Scan(&owned); err != nil {
			return SMSList{}, err
		}
		if !owned {
			return SMSList{}, fmt.Errorf("%w: sender_profile_id is not owned by this tenant", ErrInvalidSMSListInput)
		}
	}
	row := tx.QueryRow(ctx, `
		INSERT INTO sms_lists (
			tenant_id, name, description, keyword, sender_profile_id
		) VALUES (
			$1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, '')::uuid
		)
		ON CONFLICT (tenant_id, lower(name))
		DO UPDATE SET
			description = EXCLUDED.description,
			keyword = EXCLUDED.keyword,
			sender_profile_id = EXCLUDED.sender_profile_id,
			updated_at = now()
		RETURNING id::text, tenant_id::text, name, description, COALESCE(keyword, ''),
		          COALESCE(sender_profile_id::text, ''), created_at, updated_at`,
		tenantID, in.Name, in.Description, in.Keyword, in.SenderProfileID)
	out, err := scanList(row)
	if err != nil {
		return SMSList{}, err
	}
	return out, tx.Commit(ctx)
}

// UpdateList edits an SMS list's metadata (SMS-004). Returns "list not found"
// when the id is unknown to the tenant.
func (s *Store) UpdateList(ctx context.Context, tenantID, id string, in SMSListInput) (SMSList, error) {
	if !validCanonicalUUIDV4(id) {
		return SMSList{}, fmt.Errorf("%w: list id must be a canonical lowercase UUIDv4", ErrInvalidSMSListInput)
	}
	if err := validateSMSListInput(&in); err != nil {
		return SMSList{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SMSList{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if in.SenderProfileID != "" {
		var owned bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sms_sender_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid)`, tenantID, in.SenderProfileID).Scan(&owned); err != nil {
			return SMSList{}, err
		}
		if !owned {
			return SMSList{}, fmt.Errorf("%w: sender_profile_id is not owned by this tenant", ErrInvalidSMSListInput)
		}
	}
	row := tx.QueryRow(ctx, `
		UPDATE sms_lists SET
			name = $3,
			description = $4,
			keyword = NULLIF($5, ''),
			-- Preserve the existing sender profile when the caller omits it
			-- (the rename/edit form does not manage sender assignment), so a
			-- name change never silently unassigns the list's sender.
			sender_profile_id = COALESCE(NULLIF($6, '')::uuid, sender_profile_id),
			updated_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
		RETURNING id::text, tenant_id::text, name, description, COALESCE(keyword, ''),
		          COALESCE(sender_profile_id::text, ''), created_at, updated_at`,
		tenantID, id, in.Name, in.Description, in.Keyword, in.SenderProfileID)
	out, err := scanList(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SMSList{}, fmt.Errorf("list not found")
	}
	if err != nil {
		return SMSList{}, err
	}
	return out, tx.Commit(ctx)
}

// DeleteList removes an SMS list (SMS-004). Referencing campaigns keep their
// history — sms_campaigns.list_id is ON DELETE SET NULL — so this never orphans
// a campaign. Returns false when nothing matched the tenant + id.
func (s *Store) DeleteList(ctx context.Context, tenantID, id string) (bool, error) {
	if !validCanonicalUUIDV4(id) {
		return false, fmt.Errorf("%w: list id must be a canonical lowercase UUIDv4", ErrInvalidSMSListInput)
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM sms_lists WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ListMembers returns a list's roster (opted-in + opted-out members), newest
// consent first, bounded by limit (SMS-004).
func (s *Store) ListMembers(ctx context.Context, tenantID, listID string, limit int) ([]SMSListMember, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT phone_e164, status, COALESCE(consent_source, ''),
		       COALESCE(subscriber_email, ''), consent_at::text
		  FROM sms_subscriptions
		 WHERE tenant_id = $1::uuid AND list_id = $2::uuid
		 ORDER BY consent_at DESC NULLS LAST, phone_e164
		 LIMIT $3`, tenantID, listID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SMSListMember{}
	for rows.Next() {
		var m SMSListMember
		if err := rows.Scan(&m.PhoneE164, &m.Status, &m.Source, &m.SubscriberEmail, &m.ConsentAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) RecordConsent(ctx context.Context, tenantID string, in ConsentInput) error {
	return s.recordConsent(ctx, tenantID, in, nil)
}

// RecordConsentWithAudit is the operator/API mutation boundary. The canonical
// consent projection, suppression authority transition, evidence event and
// actor audit either commit together or all roll back. Carrier webhook and
// product integration writers use RecordConsent and retain their separately
// authenticated evidence identities.
func (s *Store) RecordConsentWithAudit(ctx context.Context, tenantID string, in ConsentInput, auditMeta db.AuditMeta) error {
	return s.recordConsent(ctx, tenantID, in, &auditMeta)
}

func (s *Store) recordConsent(ctx context.Context, tenantID string, in ConsentInput, auditMeta *db.AuditMeta) error {
	phone, err := NormalizePhoneUSCA(in.PhoneE164)
	if err != nil {
		return err
	}
	action := strings.ToLower(strings.TrimSpace(in.Action))
	source := strings.ToLower(strings.TrimSpace(in.Source))
	provider := strings.ToLower(strings.TrimSpace(in.Provider))
	if !oneOf(action, ConsentGranted, ConsentRevoked, ConsentImported, ConsentHelpRequested) ||
		!oneOf(source, "keyword", "form", "import", "api", "manual", ProviderTwilio, ProviderTelnyx, ProviderBandwidth, "product") {
		return ErrInvalidConsentInput
	}
	if oneOf(source, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) {
		if provider != source || strings.TrimSpace(in.ProviderEventID) == "" {
			return ErrInvalidConsentInput
		}
	} else {
		// Product/form/import/manual evidence is not a carrier callback. Never
		// manufacture Twilio provenance from the legacy default/caller input.
		provider = ConsentProviderProduct
		in.ProviderEventID = ""
	}
	if action == ConsentGranted && !validConsentGrantEvidence(subscriptionSource(source), in.ProofText, in.Metadata) {
		return ErrInvalidConsentInput
	}
	meta, err := json.Marshal(nilMap(in.Metadata))
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Suppression authority is one row per tenant/phone. Serialize every
	// manual/system transition on the same key so an operator hold and a
	// provider STOP/START cannot interleave around the row lock/upsert.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenantID+"|"+phone); err != nil {
		return err
	}
	if in.ListID != "" {
		if !validCanonicalUUIDV4(in.ListID) {
			return ErrInvalidConsentInput
		}
		var listOwned bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
  SELECT 1 FROM sms_lists WHERE tenant_id = $1::uuid AND id = $2::uuid
)`, tenantID, in.ListID).Scan(&listOwned); err != nil {
			return err
		}
		if !listOwned {
			return ErrInvalidConsentInput
		}
	}

	// The immutable event is written before the mutable subscription projection.
	// The database eligibility helper requires matching event evidence, so the
	// subscription trigger can never open an activation gate on a status bit
	// that has no corresponding evidence row.
	if _, err := tx.Exec(ctx, `
		INSERT INTO sms_consent_events (
			tenant_id, list_id, phone_e164, subscriber_email, action, source,
			proof_text, provider, provider_event_id, metadata
		) VALUES (
			$1::uuid, NULLIF($2, '')::uuid, $3, NULLIF($4, '')::citext, $5, $6,
			$7, $8, NULLIF($9, ''), $10::jsonb
		)
		ON CONFLICT DO NOTHING`,
		tenantID, in.ListID, phone, in.SubscriberEmail, action, consentEventSource(source),
		in.ProofText, provider, in.ProviderEventID, meta); err != nil {
		return err
	}

	if in.ListID != "" && oneOf(action, ConsentGranted, ConsentRevoked, ConsentImported) {
		status := SubscriptionPending
		if action == ConsentGranted {
			status = SubscriptionOptedIn
		}
		if action == ConsentRevoked {
			status = SubscriptionOptedOut
		}
		if action == ConsentImported {
			status = SubscriptionPending
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO sms_subscriptions (
				tenant_id, list_id, phone_e164, subscriber_email, status,
				consent_source, consent_text, consent_at, opt_out_at, proof
			) VALUES (
				$1::uuid, $2::uuid, $3, NULLIF($4, '')::citext, $5,
				$6, $7,
				CASE WHEN $5 = 'opted_in' THEN clock_timestamp() END,
				CASE WHEN $5 = 'opted_out' THEN clock_timestamp() END,
				$8::jsonb
			)
			ON CONFLICT (tenant_id, list_id, phone_e164) DO UPDATE SET
				subscriber_email = COALESCE(EXCLUDED.subscriber_email, sms_subscriptions.subscriber_email),
				status = EXCLUDED.status,
				consent_source = EXCLUDED.consent_source,
				consent_text = EXCLUDED.consent_text,
				consent_at = CASE WHEN EXCLUDED.status = 'opted_in' THEN EXCLUDED.consent_at ELSE NULL END,
				opt_out_at = CASE WHEN EXCLUDED.status = 'opted_out' THEN EXCLUDED.opt_out_at ELSE NULL END,
				proof = EXCLUDED.proof,
				updated_at = now()`,
			tenantID, in.ListID, phone, in.SubscriberEmail, status,
			subscriptionSource(source), in.ProofText, meta); err != nil {
			return err
		}
	}

	switch action {
	case ConsentRevoked:
		// reason must match the sms_suppressions_reason_check enum
		// landed in migration 0253: 'stop_keyword' is the canonical
		// value for STOP / UNSUBSCRIBE keyword revocations. The
		// legacy 'opt_out' literal is no longer in the allowed set
		// and would fail the CHECK constraint.
		if _, err := tx.Exec(ctx, `
			INSERT INTO sms_suppressions (
				tenant_id, phone_e164, reason, source, source_event_id, metadata,
				manual_overlay_state
			)
			VALUES ($1::uuid, $2, 'stop_keyword', $3, NULLIF($4, ''), $5::jsonb, 'none')
			ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET
				reason = CASE WHEN
					(sms_suppressions.manual_overlay_state <> 'legacy_unknown' AND sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()) OR
					(sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual') OR
					(sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source)
					THEN EXCLUDED.reason ELSE sms_suppressions.reason END,
				source = CASE WHEN
					(sms_suppressions.manual_overlay_state <> 'legacy_unknown' AND sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()) OR
					(sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual') OR
					(sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source)
					THEN EXCLUDED.source ELSE sms_suppressions.source END,
				source_event_id = CASE WHEN
					(sms_suppressions.manual_overlay_state <> 'legacy_unknown' AND sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()) OR
					(sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual') OR
					(sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source)
					THEN EXCLUDED.source_event_id ELSE sms_suppressions.source_event_id END,
				metadata = CASE WHEN
					(sms_suppressions.manual_overlay_state <> 'legacy_unknown' AND sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()) OR
					(sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual') OR
					(sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source)
					THEN EXCLUDED.metadata ELSE sms_suppressions.metadata END,
				manual_overlay_state = CASE
					WHEN sms_suppressions.manual_overlay_state = 'legacy_unknown'
					THEN 'legacy_unknown'
					WHEN sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual'
					THEN 'preserved'
					WHEN sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()
					THEN 'none'
					WHEN sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source
					THEN sms_suppressions.manual_overlay_state
					ELSE 'legacy_unknown'
				END,
				expires_at = NULL
			WHERE (sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= now())
			   OR sms_suppressions.reason NOT IN ('carrier_block', 'complaint')`,
			tenantID, phone, suppressionSource(source), in.ProviderEventID, meta); err != nil {
			return err
		}
	case ConsentGranted:
		// Deliberately do not clear a carrier STOP here. RecordConsent is used by
		// product/form/admin writers that do not possess authenticated inbound
		// carrier-event authority. Only recordConsentTx, called from a verified
		// provider webhook, can clear that system suppression.
	}
	if auditMeta != nil {
		if err := db.Audit(ctx, tx, *auditMeta, "sms.consent."+action, "sms_consent", "", map[string]any{
			"route_template": "/api/v1/sms/consent",
			"action":         action,
			"source":         source,
			"provider":       provider,
			"list_bound":     in.ListID != "",
		}); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// SMS consent projection lives in the DATABASE, not here.
//
// `subscribers.consent_sms_marketing_at` is the column every activation path
// reads — `segments/predicates/channel_consent.go` compiles the SMS gate to
// `IS NOT NULL`, and `omnichannel/runtime.go` routes sms, whatsapp AND rcs
// through it — while consent is RECORDED in `sms_subscriptions`. Nothing
// connected the two, so every omnichannel phone-channel send resolved zero
// recipients.
//
// The first fix projected from this function. That was wrong in a way worth
// recording: `RecordConsent` is not the only consent writer. `recordConsentTx`
// below is what the carrier webhook and Twilio handler call for an inbound
// STOP, and `AddSuppression`/`DeleteSuppression` are the admin surface. With
// the projection on one of four writers, the grant path opened the activation
// gate and the statutory opt-out path could not close it — a fail-OPEN
// regression, strictly worse than the fail-closed bug it replaced.
//
// Migration 1862 moves it to AFTER triggers on `sms_subscriptions` and
// `sms_suppressions`. A rule every writer must remember to call is one rule and
// N chances to forget; as a trigger it also covers backfills, admin scripts and
// code paths nobody has written yet.

func (s *Store) Gate(ctx context.Context, tenantID string, sender SenderProfile, listID, phone, body string, limitRemaining int) (string, GateDecision, error) {
	normalized, err := NormalizePhoneUSCA(phone)
	if err != nil {
		return "", GateDecision{Allowed: false, Reason: "invalid_phone", Segments: SegmentCount(body)}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", GateDecision{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var suppressed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM sms_suppressions
			 WHERE tenant_id = $1::uuid
			   AND phone_e164 = $2
			   AND (expires_at IS NULL OR expires_at > now())
		)`, tenantID, normalized).Scan(&suppressed); err != nil {
		return "", GateDecision{}, err
	}
	status := SubscriptionPending
	if listID != "" {
		err := tx.QueryRow(ctx, `
			SELECT CASE WHEN public.sms_subscription_send_eligible(
			         tenant_id, list_id, phone_e164, status,
			         consent_source, consent_text, consent_at, proof)
			       THEN 'opted_in' ELSE 'pending' END
			  FROM sms_subscriptions
			 WHERE tenant_id = $1::uuid
			   AND list_id = $2::uuid
			   AND phone_e164 = $3`, tenantID, listID, normalized).Scan(&status)
		if err != nil && !isNoRows(err) {
			return "", GateDecision{}, err
		}
	}
	// Tenant-level quiet-hours windows (sms_quiet_hours, GAP-LS-145)
	// gate alongside the legacy per-sender metadata blob. When a
	// tenant window is active we also know when it ends, so the
	// decision carries HoldUntil and the queue worker defers instead
	// of permanently blocking.
	quietRules, err := quietHoursRulesTx(ctx, tx, tenantID, true)
	if err != nil {
		return "", GateDecision{}, err
	}
	now := time.Now()
	tenantQuiet, quietUntil, quietPolicyErr := EvaluateQuietHoursChecked(now, quietRules)
	senderQuiet, _, senderQuietUntil, senderQuietErr := senderQuietHoursState(now, sender.Metadata)
	if quietPolicyErr != nil || senderQuietErr != nil {
		decision := GateDecision{Allowed: false, Reason: "quiet_hours_policy_invalid", Segments: SegmentCount(body)}
		return normalized, decision, tx.Commit(ctx)
	}
	// The TCPA calling-time floor needs the recipient's own timezone, which
	// subscribers carry in custom_fields.timezone (the same key
	// internal/recipient_tz_send schedules against). A miss is not an error:
	// EvaluateStatutoryFloor falls to its stricter tier when the zone is
	// unknown, so a lookup failure tightens the gate rather than opening it.
	recipientTZ, err := recipientTimezoneTx(ctx, tx, tenantID, normalized)
	if err != nil {
		return "", GateDecision{}, err
	}
	statutory := EvaluateStatutoryFloor(now, recipientTZ, quietRules)
	decision := EvaluateGate(GateSnapshot{
		RegistrationStatus:   sender.RegistrationStatus,
		SenderPaused:         SenderPaused(sender.Metadata),
		SubscriptionStatus:   status,
		Suppressed:           suppressed,
		QuietHours:           senderQuiet || tenantQuiet,
		StatutoryFloor:       statutory,
		TenantLimitRemaining: limitRemaining,
		Body:                 body,
	})
	if senderQuietUntil.After(quietUntil) {
		quietUntil = senderQuietUntil
	}
	if !decision.Allowed && decision.Reason == "quiet_hours" && !quietUntil.IsZero() {
		decision.HoldUntil = &quietUntil
	}
	return normalized, decision, tx.Commit(ctx)
}

// recipientTimezoneTx reads the recipient's IANA timezone from the subscriber
// row matching this phone number, or "" when there is no row, no phone match,
// or no timezone recorded.
//
// Returns an error only for a genuine query failure. The distinction matters:
// "no timezone on file" must reach EvaluateStatutoryFloor as the empty string
// so it takes the stricter tenant-window tier, while a database fault must
// abort the gate rather than be silently read as an absent timezone — the two
// look identical at the call site and only one of them is safe.
func recipientTimezoneTx(ctx context.Context, tx pgx.Tx, tenantID, phoneE164 string) (string, error) {
	var tz string
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(NULLIF(TRIM(custom_fields->>'timezone'), ''), '')
		  FROM subscribers
		 WHERE tenant_id = $1::uuid
		   AND phone_e164 = $2
		 ORDER BY updated_at DESC
		 LIMIT 1`, tenantID, phoneE164).Scan(&tz)
	if err != nil {
		if isNoRows(err) {
			return "", nil
		}
		return "", err
	}
	return tz, nil
}

func (s *Store) RecordOutbound(ctx context.Context, tenantID string, in SendInput, phone string, decision GateDecision, result ProviderResult) (Message, error) {
	if !validSMSInboxBody(in.Body, false) {
		return Message{}, ErrSMSBodyOutsideContract
	}
	meta := nilMap(in.Metadata)
	meta["provider_receipt"] = providerReceiptMetadata(result)["provider_receipt"]
	provider := defaulted(strings.ToLower(strings.TrimSpace(result.Provider)), ProviderTwilio)
	raw, err := json.Marshal(meta)
	if err != nil {
		return Message{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Message{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		INSERT INTO sms_messages (
			tenant_id, campaign_id, sender_profile_id, phone_e164, provider,
			provider_message_id, direction, body, media_url, segments, status,
			error_code, error_message, cost_micros, metadata, sent_at
		) VALUES (
			$1::uuid, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, $4, $5,
			NULLIF($6, ''), 'outbound', $7, NULLIF($8, ''), $9, $10,
			NULLIF($11, ''), NULLIF($12, ''), $13, $14::jsonb, now()
		)
		RETURNING id::text, tenant_id::text, COALESCE(campaign_id::text, ''),
		          COALESCE(sender_profile_id::text, ''), phone_e164, provider,
		          COALESCE(provider_message_id, ''), direction, body, COALESCE(media_url, ''),
		          segments, status, COALESCE(error_code, ''), COALESCE(error_message, ''),
		          cost_micros, metadata, sent_at, delivered_at, received_at, created_at`,
		tenantID, in.CampaignID, in.SenderProfileID, phone, provider, result.MessageID, in.Body,
		in.MediaURL, decision.Segments, defaulted(result.Status, "queued"),
		result.ErrorCode, result.ErrorMessage, result.PriceMicros, raw)
	out, err := scanMessage(row)
	if err != nil {
		return Message{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) ListDiscountCodes(ctx context.Context, tenantID, query string, limit int) ([]SMSDiscountCode, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, code, COALESCE(percent_off, 0), COALESCE(amount_off_cents, 0),
		       currency, COALESCE(max_redemptions, 0), times_redeemed, expires_at,
		       applies_to, created_at
		  FROM discounts
		 WHERE tenant_id = $1::uuid
		   AND ($2 = '' OR code ILIKE '%' || $2 || '%')
		 ORDER BY
		       CASE
		         WHEN (expires_at IS NULL OR expires_at > now())
		          AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)
		         THEN 0 ELSE 1
		       END,
		       created_at DESC
		 LIMIT $3`, tenantID, strings.TrimSpace(query), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SMSDiscountCode{}
	now := time.Now()
	for rows.Next() {
		var item SMSDiscountCode
		if err := rows.Scan(
			&item.ID,
			&item.Code,
			&item.PercentOff,
			&item.AmountOffCents,
			&item.Currency,
			&item.MaxRedemptions,
			&item.TimesRedeemed,
			&item.ExpiresAt,
			&item.AppliesTo,
			&item.CreatedAt,
		); err != nil {
			return nil, err
		}
		item.Label = smsDiscountLabel(item)
		item.CurrentlyRedeemable = (item.ExpiresAt == nil || item.ExpiresAt.After(now)) &&
			(item.MaxRedemptions == 0 || item.TimesRedeemed < item.MaxRedemptions)
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func recordConsentTx(ctx context.Context, tx pgx.Tx, tenantID string, in ConsentInput) error {
	phone, phoneErr := NormalizePhoneUSCA(in.PhoneE164)
	if phoneErr != nil {
		return phoneErr
	}
	provider := defaulted(strings.ToLower(strings.TrimSpace(in.Provider)), ProviderTwilio)
	if !oneOf(in.Action, ConsentGranted, ConsentRevoked, ConsentHelpRequested) ||
		!oneOf(provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) {
		return ErrInvalidConsentInput
	}
	meta, phoneErr := json.Marshal(nilMap(in.Metadata))
	if phoneErr != nil {
		return phoneErr
	}
	if _, phoneErr = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenantID+"|"+phone); phoneErr != nil {
		return phoneErr
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sms_consent_events (
			tenant_id, phone_e164, action, source, proof_text, provider, provider_event_id, metadata
		) VALUES ($1::uuid, $2, $3, $4, $5, $6, NULLIF($7, ''), $8::jsonb)
		ON CONFLICT DO NOTHING`,
		tenantID, phone, in.Action, consentEventSource(in.Source), in.ProofText,
		provider, in.ProviderEventID, meta); err != nil {
		return err
	}
	switch in.Action {
	case ConsentRevoked:
		// reason must match the sms_suppressions_reason_check enum
		// landed in migration 0253; 'stop_keyword' is canonical for
		// STOP-keyword revocations. See the sibling RecordConsent
		// path above for the same rationale.
		_, phoneErr = tx.Exec(ctx, `
			INSERT INTO sms_suppressions (
				tenant_id, phone_e164, reason, source, source_event_id, metadata,
				manual_overlay_state
			)
			VALUES ($1::uuid, $2, 'stop_keyword', $3, NULLIF($4, ''), $5::jsonb, 'none')
			ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET
				reason = CASE WHEN
					(sms_suppressions.manual_overlay_state <> 'legacy_unknown' AND sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()) OR
					(sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual') OR
					(sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source)
					THEN EXCLUDED.reason ELSE sms_suppressions.reason END,
				source = CASE WHEN
					(sms_suppressions.manual_overlay_state <> 'legacy_unknown' AND sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()) OR
					(sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual') OR
					(sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source)
					THEN EXCLUDED.source ELSE sms_suppressions.source END,
				source_event_id = CASE WHEN
					(sms_suppressions.manual_overlay_state <> 'legacy_unknown' AND sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()) OR
					(sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual') OR
					(sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source)
					THEN EXCLUDED.source_event_id ELSE sms_suppressions.source_event_id END,
				metadata = CASE WHEN
					(sms_suppressions.manual_overlay_state <> 'legacy_unknown' AND sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()) OR
					(sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual') OR
					(sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source)
					THEN EXCLUDED.metadata ELSE sms_suppressions.metadata END,
				manual_overlay_state = CASE
					WHEN sms_suppressions.manual_overlay_state = 'legacy_unknown'
					THEN 'legacy_unknown'
					WHEN sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual'
					THEN 'preserved'
					WHEN sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= clock_timestamp()
					THEN 'none'
					WHEN sms_suppressions.reason = EXCLUDED.reason AND sms_suppressions.source = EXCLUDED.source
					THEN sms_suppressions.manual_overlay_state
					ELSE 'legacy_unknown'
				END,
				expires_at = NULL
			WHERE (sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= now())
			   OR sms_suppressions.reason NOT IN ('carrier_block', 'complaint')`, tenantID, phone, suppressionSource(provider), in.ProviderEventID, meta)
		return phoneErr
	case ConsentGranted:
		keyword := strings.ToUpper(strings.TrimSpace(in.ProofText))
		providerClassifiedStart := provider == ProviderTwilio &&
			strings.EqualFold(providerEvidenceString(in.Metadata, "provider_opt_out_type"), "START")
		if (!oneOf(keyword, "START", "UNSTOP") && !providerClassifiedStart) ||
			strings.TrimSpace(in.Source) != provider || strings.TrimSpace(in.ProviderEventID) == "" {
			// A custom keyword, manual grant, or event without stable provider
			// evidence is never allowed to erase carrier STOP authority.
			return nil
		}
		var suppressionID, overlayState string
		phoneErr = tx.QueryRow(ctx, `
			SELECT id::text, manual_overlay_state
			  FROM sms_suppressions
			 WHERE tenant_id = $1::uuid
			   AND phone_e164 = $2
			   AND reason = 'stop_keyword'
			   AND source = $3
			 FOR UPDATE`, tenantID, phone, suppressionSource(provider)).Scan(&suppressionID, &overlayState)
		if errors.Is(phoneErr, pgx.ErrNoRows) {
			return nil
		}
		if phoneErr != nil {
			return phoneErr
		}
		switch overlayState {
		case "preserved":
			// A verified START clears only the carrier overlay. Restore the
			// exact operator hold in-place so the suppression gate never opens.
			var restoredID string
			phoneErr = tx.QueryRow(ctx, `
				UPDATE sms_suppressions
				   SET reason = 'manual', source = 'manual', source_event_id = NULL,
				       expires_at = NULL, metadata = '{}'::jsonb,
				       manual_overlay_state = 'none'
				 WHERE tenant_id = $1::uuid AND id = $2::uuid
				   AND manual_overlay_state = 'preserved'
				 RETURNING id::text`, tenantID, suppressionID).Scan(&restoredID)
			if errors.Is(phoneErr, pgx.ErrNoRows) {
				return ErrInvalidConsentInput
			}
			return phoneErr
		case "none":
			var deletedID string
			phoneErr = tx.QueryRow(ctx, `
				DELETE FROM sms_suppressions
				 WHERE tenant_id = $1::uuid AND id = $2::uuid
				   AND manual_overlay_state = 'none'
				 RETURNING id::text`, tenantID, suppressionID).Scan(&deletedID)
			if errors.Is(phoneErr, pgx.ErrNoRows) {
				return ErrInvalidConsentInput
			}
			return phoneErr
		case "legacy_unknown":
			// Rows created before overlay provenance existed may already have
			// replaced an operator hold. Their immutable history cannot be
			// reconstructed safely, so START records its consent evidence but
			// leaves the suppression active for reviewed reconciliation.
			return nil
		default:
			return ErrInvalidConsentInput
		}
	}
	return nil
}

type scanner interface{ Scan(dest ...any) error }

func scanList(row scanner) (SMSList, error) {
	var out SMSList
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Description,
		&out.Keyword, &out.SenderProfileID, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return SMSList{}, err
	}
	if !validListProjection(out) {
		return SMSList{}, errSMSProjectionOutsideContract
	}
	return out, nil
}

func scanListWithCount(row scanner) (SMSList, error) {
	var out SMSList
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Description,
		&out.Keyword, &out.SenderProfileID, &out.CreatedAt, &out.UpdatedAt,
		&out.RecipientCount); err != nil {
		return SMSList{}, err
	}
	if !validListProjection(out) {
		return SMSList{}, errSMSProjectionOutsideContract
	}
	return out, nil
}

func scanMessage(row scanner) (Message, error) {
	var out Message
	var metaRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.CampaignID, &out.SenderProfileID,
		&out.PhoneE164, &out.Provider, &out.ProviderMessageID, &out.Direction, &out.Body,
		&out.MediaURL, &out.Segments, &out.Status, &out.ErrorCode, &out.ErrorMessage,
		&out.CostMicros, &metaRaw, &out.SentAt, &out.DeliveredAt, &out.ReceivedAt,
		&out.CreatedAt); err != nil {
		return Message{}, err
	}
	out.Metadata = decodeMap(metaRaw)
	return out, nil
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}

func nilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func isNoRows(err error) bool {
	return err == pgx.ErrNoRows
}

func boolEvidence(ok bool) string {
	if ok {
		return "observed"
	}
	return "not_observed"
}

func smsDiscountLabel(item SMSDiscountCode) string {
	switch {
	case item.PercentOff > 0:
		return fmt.Sprintf("%d%% off", item.PercentOff)
	case item.AmountOffCents > 0:
		major := item.AmountOffCents / 100
		minor := item.AmountOffCents % 100
		return fmt.Sprintf("%s %d.%02d off", strings.ToUpper(defaulted(item.Currency, "usd")), major, minor)
	default:
		return "discount"
	}
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

func subscriptionSource(source string) string {
	switch source {
	case "keyword", "form", "import", "api", "manual":
		return source
	default:
		return "unknown"
	}
}

func consentEventSource(source string) string {
	switch source {
	case "keyword", "form", "import", "api", "manual", "twilio", "telnyx", "bandwidth", "product":
		return source
	default:
		return "product"
	}
}

func suppressionSource(source string) string {
	switch source {
	case "twilio", "telnyx", "bandwidth", "manual", "api", "import":
		return source
	default:
		return "api"
	}
}
