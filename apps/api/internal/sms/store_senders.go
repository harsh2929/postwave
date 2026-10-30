// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Sender profile persistence: listing, validation, upsert, registration
// patches, pause state, pilot readiness and per-sender pilot certification.

func (s *Store) ListSenders(ctx context.Context, tenantID string) ([]SenderProfile, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, provider, country, sender_type,
		       COALESCE(phone_number, ''), COALESCE(messaging_service_sid, ''),
		       COALESCE(brand_registration_sid, ''), COALESCE(campaign_registration_sid, ''),
		       registration_status, capabilities, metadata, created_at, updated_at
		  FROM sms_sender_profiles
		 WHERE tenant_id = $1::uuid
		 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SenderProfile{}
	for rows.Next() {
		sender, err := scanSender(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sender)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) GetSender(ctx context.Context, tenantID, id string) (SenderProfile, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SenderProfile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, provider, country, sender_type,
		       COALESCE(phone_number, ''), COALESCE(messaging_service_sid, ''),
		       COALESCE(brand_registration_sid, ''), COALESCE(campaign_registration_sid, ''),
		       registration_status, capabilities, metadata, created_at, updated_at
		  FROM sms_sender_profiles
		 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanSender(row)
	if err != nil {
		return SenderProfile{}, err
	}
	return out, tx.Commit(ctx)
}

func validateSenderInput(in *SenderInput) error {
	in.Provider = defaulted(strings.ToLower(in.Provider), ProviderTwilio)
	in.Country = defaulted(strings.ToUpper(in.Country), "US")
	in.SenderType = defaulted(strings.ToLower(in.SenderType), "10dlc")
	in.RegistrationStatus = defaulted(strings.ToLower(in.RegistrationStatus), "not_started")
	in.PhoneNumber = strings.TrimSpace(in.PhoneNumber)
	in.MessagingServiceSID = strings.TrimSpace(in.MessagingServiceSID)
	in.BrandRegistrationSID = strings.TrimSpace(in.BrandRegistrationSID)
	in.CampaignRegistrationSID = strings.TrimSpace(in.CampaignRegistrationSID)

	if in.PhoneNumber != "" {
		phone, err := NormalizePhoneUSCA(in.PhoneNumber)
		if err != nil {
			return err
		}
		in.PhoneNumber = phone
	}
	if in.PhoneNumber == "" && in.MessagingServiceSID == "" {
		return fmt.Errorf("phone_number or messaging_service_sid is required")
	}
	if !oneOf(in.Provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) {
		return fmt.Errorf("unsupported sms provider")
	}
	if !oneOf(in.Country, "US", "CA") {
		return fmt.Errorf("sms launch is US/Canada only")
	}
	if !oneOf(in.SenderType, "10dlc", "toll_free", "short_code") {
		return fmt.Errorf("unsupported sender_type")
	}
	if !oneOf(in.RegistrationStatus, "not_started", RegistrationDraft, RegistrationPending, RegistrationApproved, RegistrationRejected, RegistrationSuspended) {
		return fmt.Errorf("unsupported registration_status")
	}
	if !validBoundedToken(in.MessagingServiceSID, 256, true) ||
		!validBoundedToken(in.BrandRegistrationSID, 256, true) ||
		!validBoundedToken(in.CampaignRegistrationSID, 256, true) {
		return fmt.Errorf("provider sender identifiers must be 1-256 ASCII token characters")
	}
	if len(in.Capabilities) != 0 {
		return fmt.Errorf("sender capabilities are provider-derived and unavailable for caller input")
	}
	capabilities, err := json.Marshal(nilMap(in.Capabilities))
	if err != nil || len(capabilities) > 8192 {
		return fmt.Errorf("capabilities must be a JSON object no larger than 8192 bytes")
	}
	metadata, err := json.Marshal(nilMap(in.Metadata))
	if err != nil || len(metadata) > 8192 {
		return fmt.Errorf("metadata must be a JSON object no larger than 8192 bytes")
	}
	if err := validateSenderMetadataInput(in.Metadata); err != nil {
		return err
	}
	return nil
}

func validateSenderMetadataInput(metadata map[string]any) error {
	for key := range metadata {
		if key != "quiet_hours" {
			return fmt.Errorf("unsupported sender metadata key %q", key)
		}
	}
	return validateSenderMetadata(metadata)
}

func validateSenderMetadata(metadata map[string]any) error {
	if len(metadata) == 0 {
		return nil
	}
	for key, value := range metadata {
		switch key {
		case "quiet_hours":
		case "sending":
			sending, ok := value.(map[string]any)
			if !ok {
				return fmt.Errorf("sending metadata must be an object")
			}
			for sendingKey, sendingValue := range sending {
				if !oneOf(sendingKey, "paused", "kill_switch") {
					return fmt.Errorf("unsupported sending metadata key %q", sendingKey)
				}
				if _, ok := sendingValue.(bool); !ok {
					return fmt.Errorf("sending metadata %q must be boolean", sendingKey)
				}
			}
		case "paused", "sender_paused":
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("sender pause metadata must be boolean")
			}
		default:
			return fmt.Errorf("unsupported sender projection metadata key %q", key)
		}
	}
	raw, ok := metadata["quiet_hours"]
	if !ok || raw == nil {
		return nil
	}
	qh, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("quiet_hours must be an object")
	}
	for key := range qh {
		if !oneOf(key, "start", "end", "timezone") {
			return fmt.Errorf("unsupported quiet_hours key %q", key)
		}
	}
	start := strings.TrimSpace(stringFromAny(qh["start"]))
	end := strings.TrimSpace(stringFromAny(qh["end"]))
	if start == "" || end == "" {
		return fmt.Errorf("quiet_hours start and end are required")
	}
	if _, ok := minuteOfDay(start); !ok {
		return fmt.Errorf("quiet_hours start must use HH:MM 24-hour time")
	}
	if _, ok := minuteOfDay(end); !ok {
		return fmt.Errorf("quiet_hours end must use HH:MM 24-hour time")
	}
	timezone := strings.TrimSpace(stringFromAny(qh["timezone"]))
	if timezone == "" {
		return fmt.Errorf("quiet_hours timezone is required")
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return fmt.Errorf("quiet_hours timezone is invalid")
	}
	qh["start"] = start
	qh["end"] = end
	qh["timezone"] = timezone
	metadata["quiet_hours"] = qh
	return nil
}

func (s *Store) UpsertSender(ctx context.Context, tenantID string, in SenderInput) (SenderProfile, error) {
	if err := validateSenderInput(&in); err != nil {
		return SenderProfile{}, err
	}

	caps, err := json.Marshal(nilMap(in.Capabilities))
	if err != nil {
		return SenderProfile{}, err
	}
	meta, err := json.Marshal(nilMap(in.Metadata))
	if err != nil {
		return SenderProfile{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SenderProfile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		INSERT INTO sms_sender_profiles (
			tenant_id, provider, country, sender_type, phone_number, messaging_service_sid,
			brand_registration_sid, campaign_registration_sid, registration_status,
			capabilities, metadata
		) VALUES (
			$1::uuid, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''),
			NULLIF($7, ''), NULLIF($8, ''), $9, $10::jsonb, $11::jsonb
		)
		ON CONFLICT (tenant_id, provider, COALESCE(phone_number, ''), COALESCE(messaging_service_sid, ''))
		DO UPDATE SET
			country = EXCLUDED.country,
			sender_type = EXCLUDED.sender_type,
			brand_registration_sid = EXCLUDED.brand_registration_sid,
			campaign_registration_sid = EXCLUDED.campaign_registration_sid,
			registration_status = EXCLUDED.registration_status,
			capabilities = EXCLUDED.capabilities,
			metadata = jsonb_strip_nulls(jsonb_build_object(
			  'paused', CASE WHEN jsonb_typeof(sms_sender_profiles.metadata->'paused') = 'boolean' THEN sms_sender_profiles.metadata->'paused' END,
			  'sender_paused', CASE WHEN jsonb_typeof(sms_sender_profiles.metadata->'sender_paused') = 'boolean' THEN sms_sender_profiles.metadata->'sender_paused' END,
			  'sending', jsonb_strip_nulls(jsonb_build_object(
			    'paused', CASE WHEN jsonb_typeof(sms_sender_profiles.metadata#>'{sending,paused}') = 'boolean' THEN sms_sender_profiles.metadata#>'{sending,paused}' END,
			    'kill_switch', CASE WHEN jsonb_typeof(sms_sender_profiles.metadata#>'{sending,kill_switch}') = 'boolean' THEN sms_sender_profiles.metadata#>'{sending,kill_switch}' END
			  ))
			)) || EXCLUDED.metadata,
			updated_at = now()
		RETURNING id::text, tenant_id::text, provider, country, sender_type,
		       COALESCE(phone_number, ''), COALESCE(messaging_service_sid, ''),
		       COALESCE(brand_registration_sid, ''), COALESCE(campaign_registration_sid, ''),
		       registration_status, capabilities, metadata, created_at, updated_at`,
		tenantID, in.Provider, in.Country, in.SenderType, in.PhoneNumber,
		strings.TrimSpace(in.MessagingServiceSID), strings.TrimSpace(in.BrandRegistrationSID),
		strings.TrimSpace(in.CampaignRegistrationSID), in.RegistrationStatus, caps, meta)
	out, err := scanSender(row)
	if err != nil {
		return SenderProfile{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) UpdateSenderRegistration(ctx context.Context, tenantID, id string, in SenderRegistrationPatch) (SenderProfile, error) {
	status := defaulted(strings.ToLower(in.RegistrationStatus), RegistrationPending)
	if !oneOf(status, "not_started", RegistrationDraft, RegistrationPending, RegistrationApproved, RegistrationRejected, RegistrationSuspended) {
		return SenderProfile{}, fmt.Errorf("unsupported registration_status")
	}
	meta, err := json.Marshal(nilMap(in.Metadata))
	if err != nil {
		return SenderProfile{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SenderProfile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		UPDATE sms_sender_profiles
		   SET brand_registration_sid = COALESCE(NULLIF($3, ''), brand_registration_sid),
		       campaign_registration_sid = COALESCE(NULLIF($4, ''), campaign_registration_sid),
		       registration_status = $5,
		       metadata = metadata || $6::jsonb,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
		RETURNING id::text, tenant_id::text, provider, country, sender_type,
		       COALESCE(phone_number, ''), COALESCE(messaging_service_sid, ''),
		       COALESCE(brand_registration_sid, ''), COALESCE(campaign_registration_sid, ''),
		       registration_status, capabilities, metadata, created_at, updated_at`,
		tenantID, id, strings.TrimSpace(in.BrandRegistrationSID), strings.TrimSpace(in.CampaignRegistrationSID), status, meta)
	out, err := scanSender(row)
	if err != nil {
		return SenderProfile{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) SetSenderPaused(ctx context.Context, tenantID, id string, paused bool, reason string) (SenderProfile, error) {
	reason = strings.TrimSpace(reason)
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SenderProfile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		UPDATE sms_sender_profiles
		   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
		         'sending',
		         CASE
		           WHEN jsonb_typeof(COALESCE(metadata, '{}'::jsonb)->'sending') = 'object'
		           THEN COALESCE(metadata, '{}'::jsonb)->'sending'
		           ELSE '{}'::jsonb
		         END ||
		         jsonb_build_object(
		           'paused', $3::boolean,
		           'pause_reason', NULLIF($4, ''),
		           'pause_changed_at', now()
		         )
		       ),
		       updated_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
		RETURNING id::text, tenant_id::text, provider, country, sender_type,
		       COALESCE(phone_number, ''), COALESCE(messaging_service_sid, ''),
		       COALESCE(brand_registration_sid, ''), COALESCE(campaign_registration_sid, ''),
		       registration_status, capabilities, metadata, created_at, updated_at`,
		tenantID, id, paused, reason)
	out, err := scanSender(row)
	if err != nil {
		return SenderProfile{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) PilotReadiness(ctx context.Context, tenantID, publicBaseURL string, webhookVerification map[string]bool) (SmsPilotReadiness, error) {
	compliance, err := s.Compliance(ctx, tenantID, publicBaseURL, webhookVerification)
	if err != nil {
		return SmsPilotReadiness{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SmsPilotReadiness{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	counts := map[string]int{}
	var lists int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM sms_lists WHERE tenant_id = $1::uuid`, tenantID).Scan(&lists); err != nil {
		return SmsPilotReadiness{}, err
	}
	counts["lists"] = lists
	var optedIn int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM sms_subscriptions
		 WHERE tenant_id = $1::uuid
		   AND public.sms_subscription_send_eligible(
		     tenant_id, list_id, phone_e164, status,
		     consent_source, consent_text, consent_at, proof)`, tenantID).Scan(&optedIn); err != nil {
		return SmsPilotReadiness{}, err
	}
	counts["opted_in_subscriptions"] = optedIn
	var activeSuppressions int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM sms_suppressions
		 WHERE tenant_id = $1::uuid
		   AND (expires_at IS NULL OR expires_at > now())`, tenantID).Scan(&activeSuppressions); err != nil {
		return SmsPilotReadiness{}, err
	}
	counts["active_suppressions"] = activeSuppressions
	var approvedSenders int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM sms_sender_profiles
		 WHERE tenant_id = $1::uuid
		   AND registration_status = 'approved'
		   AND COALESCE(LOWER(COALESCE(metadata #>> '{sending,paused}', metadata->>'paused')), 'false') NOT IN ('true', '1', 'yes', 'on')`, tenantID).Scan(&approvedSenders); err != nil {
		return SmsPilotReadiness{}, err
	}
	counts["approved_senders"] = approvedSenders
	var campaigns int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM sms_campaigns
		 WHERE tenant_id = $1::uuid`, tenantID).Scan(&campaigns); err != nil {
		return SmsPilotReadiness{}, err
	}
	counts["campaigns"] = campaigns

	items := []PilotReadinessItem{}
	add := func(key, label string, pass bool, detail string) {
		status := "pass"
		if !pass {
			status = "blocker"
		}
		items = append(items, PilotReadinessItem{Key: key, Label: label, Status: status, Detail: detail})
	}
	add("approved_sender", "Approved active US/Canada sender", counts["approved_senders"] > 0, "A2P/toll-free registration must be approved and the sender kill switch must be off before live SMS.")
	add("sms_list", "At least one SMS list", counts["lists"] > 0, "Create a list for pilot recipients.")
	add("recipient_consent", "Opted-in recipients available", counts["opted_in_subscriptions"] > 0, "No opted-out or unknown-consent recipient can be messaged.")
	add("public_callbacks", "Public callback base URL", strings.TrimSpace(publicBaseURL) != "", "Delivery receipts and inbound STOP/HELP replies need a public callback URL.")
	add("webhook_signature", "Webhook signature secret", anyProviderWebhookConfigured(webhookVerification), "Webhook requests must be authenticated for the provider used by the live sender.")
	add("dispatch_release", "Durable SMS dispatch lifecycle", smsLegacyDispatchReleaseReady && smsDispatchSagaReleaseReady, "Live sends remain held until budget settlement and provider reconciliation are deployed.")
	add("auto_reply_dispatch_release", "Durable HELP and custom auto-replies", smsComplianceAutoReplyReleaseReady, "HELP and tenant keyword reply effects remain held until they have durable budget and provider evidence.")
	add("a2p_registration_release", "Durable A2P registration lifecycle", smsA2PRegistrationReleaseReady, "Carrier registration remains held until it has provider idempotency, reconciliation and minimized receipts.")
	add("provider_callback_release", "Tenant-bound provider callback lifecycle", smsProviderCallbackReleaseReady, "Hosted callbacks remain held until provider credentials and account ownership resolve per tenant.")
	for _, item := range compliance.Items {
		status := "pass"
		if !item.Complete {
			status = "blocker"
		}
		items = append(items, PilotReadinessItem{
			Key:    "compliance_" + item.Key,
			Label:  item.Label,
			Status: status,
			Detail: item.Detail,
		})
	}
	canPilot := true
	for _, item := range items {
		if item.Status == "blocker" {
			canPilot = false
			break
		}
	}
	return SmsPilotReadiness{CanPilot: canPilot, Counts: counts, Items: items}, tx.Commit(ctx)
}

func (s *Store) SenderPilotCertification(ctx context.Context, tenantID, senderID, publicBaseURL string, webhookVerification map[string]bool, providerConfigured bool) (SenderPilotCertification, error) {
	sender, err := s.GetSender(ctx, tenantID, senderID)
	if err != nil {
		return SenderPilotCertification{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SenderPilotCertification{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	exists := func(query string, args ...any) (bool, error) {
		var ok bool
		if err := tx.QueryRow(ctx, query, args...).Scan(&ok); err != nil {
			return false, err
		}
		return ok, nil
	}
	inboundSeen, err := exists(`
		SELECT EXISTS (
			SELECT 1 FROM sms_messages
			 WHERE tenant_id = $1::uuid
			   AND sender_profile_id = $2::uuid
			   AND provider = $3
			   AND direction = 'inbound'
			   AND received_at >= now() - interval '14 days'
		)`, tenantID, senderID, sender.Provider)
	if err != nil {
		return SenderPilotCertification{}, err
	}
	statusSeen, err := exists(`
		SELECT EXISTS (
			SELECT 1 FROM sms_messages
			 WHERE tenant_id = $1::uuid
			   AND sender_profile_id = $2::uuid
			   AND provider = $3
			   AND direction = 'outbound'
			   AND provider_message_id IS NOT NULL
			   AND status IN ('delivered', 'failed', 'undelivered')
			   AND created_at >= now() - interval '14 days'
		)`, tenantID, senderID, sender.Provider)
	if err != nil {
		return SenderPilotCertification{}, err
	}
	consentSeen, err := exists(`
		SELECT EXISTS (
			SELECT 1 FROM sms_consent_events
			 WHERE tenant_id = $1::uuid
			   AND provider = $2
			   AND action IN ('granted', 'revoked', 'help_requested')
			   AND created_at >= now() - interval '14 days'
		)`, tenantID, sender.Provider)
	if err != nil {
		return SenderPilotCertification{}, err
	}
	clickSeen, err := exists(`
		SELECT EXISTS (
			SELECT 1
			  FROM sms_link_clicks c
			  JOIN sms_messages m
			    ON m.tenant_id = c.tenant_id
			   AND m.id = c.message_id
			 WHERE c.tenant_id = $1::uuid
			   AND m.sender_profile_id = $2::uuid
			   AND c.clicked_at >= now() - interval '14 days'
		)`, tenantID, senderID)
	if err != nil {
		return SenderPilotCertification{}, err
	}
	failureSeen, err := exists(`
		SELECT EXISTS (
			SELECT 1 FROM sms_messages
			 WHERE tenant_id = $1::uuid
			   AND sender_profile_id = $2::uuid
			   AND provider = $3
			   AND direction = 'outbound'
			   AND status IN ('failed', 'undelivered')
			   AND created_at >= now() - interval '14 days'
		)`, tenantID, senderID, sender.Provider)
	if err != nil {
		return SenderPilotCertification{}, err
	}

	callbackURL := ""
	statusURL := ""
	if strings.TrimSpace(publicBaseURL) != "" {
		base := strings.TrimRight(publicBaseURL, "/")
		callbackURL = base + "/api/public/sms/" + sender.Provider + "/" + tenantID
		statusURL = callbackURL + "/status"
	}
	out := SenderPilotCertification{
		Sender:      sender,
		GeneratedAt: time.Now().UTC(),
		CallbackURL: callbackURL,
		StatusURL:   statusURL,
	}
	add := func(key, label, status, detail, evidence string) {
		out.Items = append(out.Items, PilotReadinessItem{Key: key, Label: label, Status: status, Detail: detail, Evidence: evidence})
	}
	passBlock := func(ok bool) string {
		if ok {
			return "pass"
		}
		return "blocker"
	}
	passWarn := func(ok bool) string {
		if ok {
			return "pass"
		}
		return "warning"
	}
	add("provider_credentials", "Provider credentials configured", passBlock(providerConfigured), "The selected provider must be configured before live pilot sends.", sender.Provider)
	add("sender_identity", "Sender identity configured", passBlock(sender.PhoneNumber != "" || sender.MessagingServiceSID != ""), "A phone number, messaging service, messaging profile, or application id is required.", defaulted(sender.PhoneNumber, sender.MessagingServiceSID))
	add("sender_not_paused", "Sender kill switch off", passBlock(!SenderPaused(sender.Metadata)), "Resume this sender before pilot traffic.", boolEvidence(!SenderPaused(sender.Metadata)))
	add("sender_registration", "Sender registration approved", passBlock(sender.RegistrationStatus == RegistrationApproved), "The sender must be approved before pilot traffic.", sender.RegistrationStatus)
	add("callback_base_url", "Public callback URLs configured", passBlock(callbackURL != ""), "Provider consoles must point inbound and status callbacks to these URLs.", callbackURL)
	add("webhook_verification", "Webhook verification configured", passBlock(webhookConfiguredForProvider(webhookVerification, sender.Provider)), "Provider callbacks must be authenticated for this sender's provider.", sender.Provider)
	add("dispatch_release", "Durable SMS dispatch lifecycle", passBlock(smsLegacyDispatchReleaseReady && smsDispatchSagaReleaseReady), "Live sends remain held until budget settlement and provider reconciliation are deployed.", "sms_dispatch_release_held")
	add("auto_reply_dispatch_release", "Durable HELP and custom auto-replies", passBlock(smsComplianceAutoReplyReleaseReady), "HELP and tenant keyword reply effects remain held until they have durable budget and provider evidence.", "sms_auto_reply_dispatch_release_held")
	add("a2p_registration_release", "Durable A2P registration lifecycle", passBlock(smsA2PRegistrationReleaseReady), "Carrier registration remains held until it has provider idempotency, reconciliation and minimized receipts.", "sms_a2p_registration_release_held")
	add("provider_callback_release", "Tenant-bound provider callback lifecycle", passBlock(smsProviderCallbackReleaseReady), "Hosted callbacks remain held until provider credentials and account ownership resolve per tenant.", "sms_provider_callback_release_held")
	add("inbound_callback_observed", "Inbound callback observed", passBlock(inboundSeen), "Send a real inbound reply through the provider and confirm Moosewave records it.", boolEvidence(inboundSeen))
	add("delivery_status_observed", "Delivery/failure callback observed", passBlock(statusSeen), "Send a provider test message and confirm delivered/failed/undelivered status lands.", boolEvidence(statusSeen))
	add("consent_keyword_observed", "STOP/START/HELP keyword path observed", passBlock(consentSeen), "Exercise STOP, START/UNSTOP, and HELP before live pilot.", boolEvidence(consentSeen))
	add("tracked_click_observed", "Tracked click observed", passWarn(clickSeen), "Send one link-tracked test message and click it from a test handset.", boolEvidence(clickSeen))
	add("failure_path_observed", "Provider failure path observed", passWarn(failureSeen), "Force or record at least one failed/undelivered message before larger batches.", boolEvidence(failureSeen))
	out.CanPilot = true
	for _, item := range out.Items {
		if item.Status == "blocker" {
			out.CanPilot = false
			break
		}
	}
	return out, tx.Commit(ctx)
}

func scanSender(row scanner) (SenderProfile, error) {
	var out SenderProfile
	var capsRaw, metaRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Provider, &out.Country, &out.SenderType,
		&out.PhoneNumber, &out.MessagingServiceSID, &out.BrandRegistrationSID,
		&out.CampaignRegistrationSID, &out.RegistrationStatus, &capsRaw, &metaRaw,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return SenderProfile{}, err
	}
	var err error
	_, err = decodeProjectionObject(capsRaw)
	if err != nil {
		return SenderProfile{}, err
	}
	// Capabilities were historically caller-controlled arbitrary JSON and are
	// not authority for any released operation. Do not disclose them on
	// viewer/read-report sender projections.
	out.Capabilities = map[string]any{}
	out.Metadata, err = decodeSenderMetadataProjection(metaRaw)
	if err != nil || !validSenderProjection(out) {
		return SenderProfile{}, errSMSProjectionOutsideContract
	}
	return out, nil
}

// decodeSenderMetadataProjection tolerates the historic provider-registration
// payload ceiling only long enough to remove known raw carrier resources.
// Those resources can contain EIN/email/address data and were previously
// exposed by viewer-readable sender routes. The ordinary projection retains
// bounded operational configuration only; migration preflight still requires
// privileged remediation before the storage constraint is validated.
func decodeSenderMetadataProjection(raw []byte) (map[string]any, error) {
	if len(raw) == 0 || int64(len(raw)) > smsProviderWebhookMaxBodyBytes {
		return nil, errSMSProjectionOutsideContract
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return nil, errSMSProjectionOutsideContract
	}
	minimized := make(map[string]any, 4)
	if quiet, ok := out["quiet_hours"]; ok && quiet != nil {
		minimized["quiet_hours"] = quiet
	}
	for _, key := range []string{"paused", "sender_paused"} {
		if value, ok := out[key]; ok {
			if _, valid := value.(bool); !valid {
				return nil, errSMSProjectionOutsideContract
			}
			minimized[key] = value
		}
	}
	if rawSending, ok := out["sending"]; ok {
		sending, valid := rawSending.(map[string]any)
		if !valid {
			return nil, errSMSProjectionOutsideContract
		}
		projected := map[string]any{}
		for _, key := range []string{"paused", "kill_switch"} {
			if value, exists := sending[key]; exists {
				if _, valid := value.(bool); !valid {
					return nil, errSMSProjectionOutsideContract
				}
				projected[key] = value
			}
		}
		if len(projected) > 0 {
			minimized["sending"] = projected
		}
	}
	encoded, err := json.Marshal(minimized)
	if err != nil || len(encoded) > 8192 {
		return nil, errSMSProjectionOutsideContract
	}
	return minimized, nil
}
