// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var errSMSProjectionOutsideContract = errors.New("sms row is outside the private projection contract")

var (
	projectionTimeMin = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	projectionTimeMax = time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC)
)

func validProjectionTime(value time.Time) bool {
	return !value.IsZero() && !value.Before(projectionTimeMin) && value.Before(projectionTimeMax)
}

func validOptionalProjectionTime(value *time.Time) bool {
	return value == nil || validProjectionTime(*value)
}

func validBoundedToken(value string, maxBytes int, allowEmpty bool) bool {
	if value == "" {
		return allowEmpty
	}
	if strings.TrimSpace(value) != value || len(value) > maxBytes || !validInboxText(value, maxBytes) {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') &&
			!(r >= '0' && r <= '9') && !strings.ContainsRune("_.:-", r) {
			return false
		}
	}
	return true
}

func decodeProjectionObject(raw []byte) (map[string]any, error) {
	if len(raw) == 0 || len(raw) > 8192 {
		return nil, errSMSProjectionOutsideContract
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return nil, errSMSProjectionOutsideContract
	}
	return out, nil
}

func validConsentGrantEvidence(source, proofText string, proof map[string]any) bool {
	if !oneOf(source, "keyword", "form", "import", "api", "manual") ||
		strings.TrimSpace(proofText) != proofText || proofText == "" || !validInboxText(proofText, 512) {
		return false
	}
	raw, err := json.Marshal(proof)
	if err != nil || len(raw) > 8192 {
		return false
	}
	evidenceType := strings.TrimSpace(stringFromAny(proof["evidence_type"]))
	evidenceID := strings.TrimSpace(stringFromAny(proof["evidence_id"]))
	if evidenceType == "" && stringFromAny(proof["source"]) == "tap_to_text" {
		evidenceType = "tap_to_text"
		evidenceID = strings.TrimSpace(stringFromAny(proof["tap_to_text_id"]))
	}
	return oneOf(evidenceType, "carrier_keyword", "tap_to_text", "web_form", "signed_import", "operator_attestation") &&
		validBoundedToken(evidenceID, 256, false)
}

func validSenderProjection(out SenderProfile) bool {
	if !validCanonicalUUIDV4(out.ID) || !validCanonicalUUIDV4(out.TenantID) ||
		!oneOf(out.Provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) ||
		!oneOf(out.Country, "US", "CA") ||
		!oneOf(out.SenderType, "10dlc", "toll_free", "short_code") ||
		!oneOf(out.RegistrationStatus, "not_started", RegistrationDraft, RegistrationPending,
			RegistrationApproved, RegistrationRejected, RegistrationSuspended) ||
		!validProjectionTime(out.CreatedAt) || !validProjectionTime(out.UpdatedAt) || out.UpdatedAt.Before(out.CreatedAt) {
		return false
	}
	if out.PhoneNumber != "" {
		phone, err := NormalizePhoneUSCA(out.PhoneNumber)
		if err != nil || phone != out.PhoneNumber {
			return false
		}
	}
	if out.PhoneNumber == "" && out.MessagingServiceSID == "" {
		return false
	}
	metadataCopy := make(map[string]any, len(out.Metadata))
	for key, value := range out.Metadata {
		metadataCopy[key] = value
	}
	return validateSenderMetadata(metadataCopy) == nil &&
		validBoundedToken(out.MessagingServiceSID, 256, true) &&
		validBoundedToken(out.BrandRegistrationSID, 256, true) &&
		validBoundedToken(out.CampaignRegistrationSID, 256, true)
}

func validListProjection(out SMSList) bool {
	if !validCanonicalUUIDV4(out.ID) || !validCanonicalUUIDV4(out.TenantID) ||
		strings.TrimSpace(out.Name) != out.Name || out.Name == "" || !validInboxText(out.Name, 256) ||
		!validInboxText(out.Description, 2048) || out.RecipientCount < 0 ||
		!validProjectionTime(out.CreatedAt) || !validProjectionTime(out.UpdatedAt) || out.UpdatedAt.Before(out.CreatedAt) {
		return false
	}
	if out.Keyword != "" && (strings.TrimSpace(out.Keyword) != out.Keyword || !validInboxText(out.Keyword, 64)) {
		return false
	}
	return out.SenderProfileID == "" || validCanonicalUUIDV4(out.SenderProfileID)
}

func validBroadcastProjection(out Broadcast) bool {
	if !validCanonicalUUIDV4(out.ID) || !validCanonicalUUIDV4(out.TenantID) ||
		(out.SenderProfileID != "" && !validCanonicalUUIDV4(out.SenderProfileID)) ||
		(out.CampaignID != "" && !validCanonicalUUIDV4(out.CampaignID)) ||
		(out.SegmentID != "" && !validCanonicalUUIDV4(out.SegmentID)) ||
		strings.TrimSpace(out.Name) != out.Name || out.Name == "" || !validInboxText(out.Name, 256) ||
		!validSMSInboxBody(out.Body, true) ||
		!oneOf(out.Status, BroadcastStatusDraft, BroadcastStatusScheduled, BroadcastStatusSending,
			BroadcastStatusSent, BroadcastStatusCancelled) ||
		out.SentCount < 0 || out.FailedCount < 0 || out.HeldCount < 0 ||
		!validProjectionTime(out.CreatedAt) || !validProjectionTime(out.UpdatedAt) || out.UpdatedAt.Before(out.CreatedAt) ||
		!validOptionalProjectionTime(out.ScheduledAt) {
		return false
	}
	if out.Tag != "" && (strings.TrimSpace(out.Tag) != out.Tag || !validInboxText(out.Tag, 64)) {
		return false
	}
	if len(out.ListIDs) > 100 {
		return false
	}
	audienceSelectors := 0
	if len(out.ListIDs) > 0 {
		audienceSelectors++
	}
	if out.SegmentID != "" {
		audienceSelectors++
	}
	if out.Tag != "" {
		audienceSelectors++
	}
	if audienceSelectors > 1 {
		return false
	}
	seen := make(map[string]struct{}, len(out.ListIDs))
	for _, id := range out.ListIDs {
		if !validCanonicalUUIDV4(id) {
			return false
		}
		if _, exists := seen[id]; exists {
			return false
		}
		seen[id] = struct{}{}
	}
	return true
}

func validSuppressionProjection(out SuppressionRow) bool {
	if !validCanonicalUUIDV4(out.ID) || !validSuppressionReasons[out.Reason] ||
		!oneOf(out.Source, ProviderTwilio, ProviderTelnyx, ProviderBandwidth, "manual", "api", "import") ||
		!validProjectionTime(out.CreatedAt) {
		return false
	}
	phone, err := NormalizePhoneUSCA(out.PhoneE164)
	return err == nil && phone == out.PhoneE164
}

func validQuietHoursProjection(out QuietHoursRule) bool {
	if !validCanonicalUUIDV4(out.ID) || !validCanonicalTenantUUID(out.TenantID) ||
		!validInboxText(out.Label, 512) || len([]rune(out.Label)) > 128 ||
		(out.CountryCode != "" && !oneOf(out.CountryCode, "US", "CA")) ||
		out.StartMinute < 0 || out.StartMinute >= minutesPerDay ||
		out.EndMinute < 0 || out.EndMinute >= minutesPerDay ||
		len(out.Days) == 0 || len(out.Days) > 7 ||
		strings.TrimSpace(out.Timezone) != out.Timezone || out.Timezone == "" ||
		!validInboxText(out.Timezone, 512) || len([]rune(out.Timezone)) > 128 ||
		!validProjectionTime(out.CreatedAt) || !validProjectionTime(out.UpdatedAt) || out.UpdatedAt.Before(out.CreatedAt) {
		return false
	}
	if _, err := time.LoadLocation(out.Timezone); err != nil {
		return false
	}
	previous := -1
	for _, day := range out.Days {
		if day < 0 || day > 6 || day <= previous {
			return false
		}
		previous = day
	}
	return true
}

func validKeywordResponseProjection(out KeywordResponse) bool {
	return validCanonicalUUIDV4(out.ID) && validCanonicalTenantUUID(out.TenantID) &&
		strings.TrimSpace(out.Keyword) == out.Keyword && out.Keyword == strings.ToUpper(out.Keyword) &&
		validBoundedToken(out.Keyword, 320, false) && len([]rune(out.Keyword)) <= 80 &&
		!ReservedSMSKeyword(out.Keyword) && validSMSInboxBody(out.ResponseBody, false) &&
		oneOf(out.Action, KeywordActionReplyOnly, KeywordActionOptOut) &&
		out.OptInCount >= 0 && validProjectionTime(out.CreatedAt) &&
		validProjectionTime(out.UpdatedAt) && !out.UpdatedAt.Before(out.CreatedAt)
}

func validCampaignProjection(out Campaign) bool {
	if !validCanonicalUUIDV4(out.ID) || !validCanonicalUUIDV4(out.TenantID) ||
		(out.SenderProfileID != "" && !validCanonicalUUIDV4(out.SenderProfileID)) ||
		(out.ListID != "" && !validCanonicalUUIDV4(out.ListID)) ||
		strings.TrimSpace(out.Name) != out.Name || out.Name == "" ||
		!validInboxText(out.Name, 1024) || len([]rune(out.Name)) > 256 ||
		!validSMSInboxBody(out.Body, false) ||
		(out.MediaURL != "" && !validReplyMediaURL(out.MediaURL)) ||
		!oneOf(out.Status, "draft", "scheduled", "sending", "sent", "paused", "failed", "cancelled") ||
		!validOptionalProjectionTime(out.ScheduledAt) || !validOptionalProjectionTime(out.SentAt) ||
		!validProjectionTime(out.CreatedAt) || !validProjectionTime(out.UpdatedAt) || out.UpdatedAt.Before(out.CreatedAt) {
		return false
	}
	if out.ScheduledAt != nil && out.ScheduledAt.Before(out.CreatedAt) ||
		out.SentAt != nil && out.SentAt.Before(out.CreatedAt) ||
		out.Status == "scheduled" && out.ScheduledAt == nil ||
		out.Status == "sent" && out.SentAt == nil {
		return false
	}
	statsRaw, statsErr := json.Marshal(out.Stats)
	metadataRaw, metadataErr := json.Marshal(out.Metadata)
	return statsErr == nil && metadataErr == nil && len(statsRaw) <= 8192 && len(metadataRaw) <= 8192
}

func validConversationSummaryProjection(out ConversationSummary) bool {
	phone, err := NormalizePhoneUSCA(out.PhoneE164)
	if err != nil || phone != out.PhoneE164 || !validProjectionTime(out.LastMessageAt) ||
		!oneOf(out.LastDirection, "inbound", "outbound") || out.MessageCount < 1 ||
		out.UnreadCount < 0 || out.UnreadCount > out.MessageCount ||
		!validOptionalProjectionTime(out.OldestUnreadAt) || !validOptionalProjectionTime(out.SnoozeUntil) ||
		!validOptionalProjectionTime(out.ArchivedAt) || !validOptionalProjectionTime(out.StateUpdatedAt) {
		return false
	}
	if out.UnreadCount == 0 && out.OldestUnreadAt != nil || out.UnreadCount > 0 && out.OldestUnreadAt == nil {
		return false
	}
	if out.AssigneeUserID != nil && !validCanonicalUUIDV4(*out.AssigneeUserID) {
		return false
	}
	if (out.SnoozeUntil != nil || out.ArchivedAt != nil || out.AssigneeUserID != nil) && out.StateUpdatedAt == nil {
		return false
	}
	if out.IdentityAmbiguous && out.SubscriberEmail != "" {
		return false
	}
	if out.SubscriberEmail != "" && (strings.TrimSpace(out.SubscriberEmail) != out.SubscriberEmail ||
		len([]rune(out.SubscriberEmail)) > 320 || !validInboxText(out.SubscriberEmail, 1280)) {
		return false
	}
	if out.LastMessagePreviewOmittedReason != "" {
		return out.LastMessagePreview == "" && oneOf(out.LastMessagePreviewOmittedReason,
			"body_exceeds_inbox_limit", "legacy_body_unavailable")
	}
	return validSMSInboxBody(out.LastMessagePreview, false)
}

func validConversationContextProjection(out ConversationContext) bool {
	phone, err := NormalizePhoneUSCA(out.PhoneE164)
	if err != nil || phone != out.PhoneE164 || !validCanonicalUUIDV4(out.TenantID) ||
		!oneOf(out.ConsentStatus, "none", "pending", "opted_in", "opted_out") ||
		!validOptionalProjectionTime(out.ConsentAt) || !validOptionalProjectionTime(out.OptOutAt) ||
		!validOptionalProjectionTime(out.FirstSeenAt) || !validOptionalProjectionTime(out.LastReadAt) ||
		out.SubscribedLists < 0 || out.TotalMessages < 0 || out.SubscribedLists != len(out.EligibleLists) {
		return false
	}
	if out.IdentityAmbiguous && out.SubscriberEmail != "" {
		return false
	}
	if out.SubscriberEmail != "" && (strings.TrimSpace(out.SubscriberEmail) != out.SubscriberEmail ||
		len([]rune(out.SubscriberEmail)) > 320 || !validInboxText(out.SubscriberEmail, 1280)) {
		return false
	}
	if out.ConsentSource != "" && !oneOf(out.ConsentSource, "unknown", "keyword", "form", "import", "api", "manual") {
		return false
	}
	if out.ConsentEvidenceSufficient != (out.SubscribedLists > 0) ||
		(out.ConsentStatus == "opted_in") != out.ConsentEvidenceSufficient {
		return false
	}
	if out.Suppressed {
		if !validSuppressionReasons[out.SuppressionReason] {
			return false
		}
	} else if out.SuppressionReason != "" || out.SuppressionReversible {
		return false
	}
	return true
}

func validMessageProjection(out Message) bool {
	phone, err := NormalizePhoneUSCA(out.PhoneE164)
	if err != nil || phone != out.PhoneE164 || !validCanonicalUUIDV4(out.ID) ||
		!validCanonicalUUIDV4(out.TenantID) ||
		(out.CampaignID != "" && !validCanonicalUUIDV4(out.CampaignID)) ||
		(out.SenderProfileID != "" && !validCanonicalUUIDV4(out.SenderProfileID)) ||
		!oneOf(out.Provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) ||
		!validBoundedToken(out.ProviderMessageID, 256, true) ||
		!oneOf(out.Direction, "inbound", "outbound") || out.Segments < 1 || out.Segments > 1000 ||
		!oneOf(out.Status, "accepted", "scheduled", "queued", "sent", "delivered", "failed",
			"undelivered", "received", "read", "partially_delivered", "canceled") ||
		out.CostMicros < 0 || !validProjectionTime(out.CreatedAt) ||
		!validOptionalProjectionTime(out.SentAt) || !validOptionalProjectionTime(out.DeliveredAt) ||
		!validOptionalProjectionTime(out.ReceivedAt) {
		return false
	}
	if out.BodyOmittedReason == "" {
		if !validSMSInboxBody(out.Body, false) {
			return false
		}
	} else if out.Body != "" || !oneOf(out.BodyOmittedReason, "body_exceeds_inbox_limit", "legacy_body_unavailable") {
		return false
	}
	if out.MediaURL != "" && !validReplyMediaURL(out.MediaURL) ||
		out.ErrorCode != "" && !validBoundedToken(out.ErrorCode, 64, false) ||
		out.ErrorMessage != "" && (len([]rune(out.ErrorMessage)) > 512 || !validInboxText(out.ErrorMessage, 2048)) {
		return false
	}
	if out.SentAt != nil && out.SentAt.Before(out.CreatedAt) ||
		out.ReceivedAt != nil && out.ReceivedAt.Before(out.CreatedAt) ||
		out.DeliveredAt != nil && out.DeliveredAt.Before(out.CreatedAt) ||
		out.DeliveredAt != nil && out.SentAt != nil && out.DeliveredAt.Before(*out.SentAt) {
		return false
	}
	if out.DispatchState != "" {
		if !oneOf(out.DispatchState, "reserved", "reconciliation_required", "persisted", "provider_failed") ||
			out.Direction != "outbound" || out.SenderProfileID == "" ||
			out.DispatchState == "persisted" && out.ProviderMessageID == "" {
			return false
		}
	}
	return true
}
