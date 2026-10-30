package sms

import (
	"strconv"
	"strings"
)

// inboundProviderEvidence is the complete metadata contract for ordinary
// sms_messages rows created from provider webhooks. Provider payloads can
// contain the message body, both phone numbers, account identifiers, tokens,
// and arbitrary future fields, so callers may not persist the raw envelope.
// Canonical columns already retain provider/message identity, phone and body;
// this map keeps only bounded, non-duplicative receipt/classification facts.
func inboundProviderEvidence(_ string, metadata map[string]any) map[string]any {
	out := map[string]any{}
	if eventID := safeProviderIdentifier(providerEvidenceString(metadata, "provider_event_id"), 256); eventID != "" {
		out["provider_event_id"] = eventID
	}
	if eventType := safeProviderIdentifier(strings.ToLower(providerEvidenceString(metadata, "provider_event_type")), 64); eventType != "" {
		out["provider_event_type"] = eventType
	}
	optOutType := strings.ToUpper(strings.TrimSpace(defaulted(
		providerEvidenceString(metadata, "provider_opt_out_type"),
		providerEvidenceString(metadata, "OptOutType"),
	)))
	if oneOf(optOutType, "STOP", "START", "HELP") {
		out["provider_opt_out_type"] = optOutType
	}
	if count, ok := boundedProviderMediaCount(defaulted(
		providerEvidenceString(metadata, "provider_media_count"),
		providerEvidenceString(metadata, "NumMedia"),
	)); ok {
		out["provider_media_count"] = count
	}
	return out
}

func providerEvidenceString(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	return strings.TrimSpace(stringFromAny(values[key]))
}

func boundedProviderMediaCount(raw string) (int, bool) {
	if strings.TrimSpace(raw) == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 0 || n > 10 {
		return 0, false
	}
	return n, true
}
