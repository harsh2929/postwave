package csv

import (
	"fmt"
	"strings"
	"time"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// ApplyExportProfile pins interpretation to the selected source. It is stored
// in the encrypted mapping so another worker resumes with the same rules.
func ApplyExportProfile(sess *adapter.Session, source canonical.SourcePlatform) error {
	m, err := DecodeMapping(sess.AccessToken)
	if err != nil {
		return err
	}
	switch source {
	case canonical.SourceAWeber, canonical.SourceBento, canonical.SourceCampaignMonitor, canonical.SourceConstantContact, canonical.SourceDrip, canonical.SourceFlodesk, canonical.SourceLoops, canonical.SourceOmnisend, canonical.SourceSendy:
	default:
		return fmt.Errorf("csv: unsupported export profile")
	}
	m.Profile = source
	sess.AccessToken, err = EncodeMapping(m)
	return err
}

func emailStatusHeader(profile canonical.SourcePlatform, header string) bool {
	if profile == canonical.SourceOmnisend {
		return header == "email_subscription_status" || header == "email_status"
	}
	return containsString(statusHeaders, header) || containsString([]string{"subscription_status", "subscriber_status", "email_status", "email_subscription_status", "contact_status"}, header)
}

func moreRestrictive(a, b canonical.SubscriberStatus) canonical.SubscriberStatus {
	rank := map[canonical.SubscriberStatus]int{canonical.StatusEnabled: 0, canonical.StatusUnconfirmed: 1, canonical.StatusDisabled: 2, canonical.StatusBlocklisted: 3}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

// applyProfileEvidence uses all explicit email status/suppression columns.
// Column order cannot turn an opt-out into an active subscriber. Empty or
// unfamiliar positive-status values remain unconfirmed; a false negative flag
// never supplies affirmative subscription evidence.
func applyProfileEvidence(sub *canonical.Subscriber, rec []string, m *Mapping) {
	statuses := []canonical.SubscriberStatus{}
	evidence := map[string]string{}
	for _, col := range m.Columns {
		if col.Index < 0 || col.Index >= len(rec) {
			continue
		}
		header := normalizeHeader(col.Name)
		raw := strings.TrimSpace(rec[col.Index])
		value := normalizeHeader(raw)
		// Keep original export values, including leading zeroes and numeric IDs.
		if col.Kind == KindCustom {
			key := col.CustomKey
			if key == "" {
				key = sanitizeKey(col.Name)
			}
			if raw != "" {
				sub.CustomFields[key] = raw
			}
		}
		isStatus := emailStatusHeader(m.Profile, header)
		if m.Profile != canonical.SourceOmnisend && col.Kind == KindStatus {
			isStatus = true
		}
		if isStatus {
			statuses = append(statuses, subscriptionStatus(raw))
			evidence[col.Name] = raw
		}
		negative := canonical.SubscriberStatus("")
		switch header {
		case "unsubscribed", "is_unsubscribed", "email_unsubscribed", "email_opt_out":
			negative = canonical.StatusDisabled
		case "bounced", "is_bounced", "hard_bounced", "complaint", "complained", "spam_complaint", "marked_as_spam", "suppressed", "is_suppressed", "email_blacklisted":
			negative = canonical.StatusBlocklisted
		}
		if negative != "" && raw != "" {
			evidence[col.Name] = raw
			switch value {
			case "1", "true", "yes", "y":
				statuses = append(statuses, negative)
			case "0", "false", "no", "n":
			default:
				statuses = append(statuses, canonical.StatusUnconfirmed)
			}
		}
		if containsString([]string{"unsubscribed_at", "email_optout_date", "email_opt_out_date"}, header) && raw != "" {
			statuses = append(statuses, canonical.StatusDisabled)
			evidence[col.Name] = raw
		}
		if m.Profile == canonical.SourceAWeber && header == "stop_status" && raw != "" && value != "0" {
			statuses = append(statuses, canonical.StatusDisabled)
			evidence[col.Name] = raw
		}
		if m.Profile == canonical.SourceCampaignMonitor && header == "reason" && raw != "" {
			statuses = append(statuses, moreRestrictive(canonical.StatusDisabled, subscriptionStatus(raw)))
			evidence[col.Name] = raw
		}
		// Constant Contact permission values are not generic true/false flags.
		if m.Profile == canonical.SourceConstantContact && header == "email_permission" {
			status := canonical.StatusUnconfirmed
			switch value {
			case "explicit", "implicit":
				status = canonical.StatusEnabled
			case "unsubscribed":
				status = canonical.StatusDisabled
			}
			statuses = append(statuses, status)
			evidence[col.Name] = raw
		}
		explicitDate := (m.Profile == canonical.SourceDrip && header == "confirmed_at") || (m.Profile == canonical.SourceConstantContact && header == "email_optin_date") || (m.Profile == canonical.SourceOmnisend && header == "email_opt_in_date")
		if explicitDate && raw != "" {
			if stamp := parseConsentDate(raw); stamp != nil {
				sub.ConsentTimestamp = stamp
				sub.ConsentSource = canonical.ConsentImport
			}
		}
		if m.Profile != "" && m.Profile != canonical.SourceCSV && (header == "id" || header == "subscriber_id" || header == "contact_id") && raw != "" {
			sub.SourceID = raw
		}
		if m.Profile == canonical.SourceFlodesk && header == "segments" {
			for _, v := range strings.Split(raw, ",") {
				if v = strings.TrimSpace(v); v != "" {
					sub.Tags = append(sub.Tags, v)
				}
			}
		}
	}
	sub.Status = canonical.StatusUnconfirmed
	if len(statuses) > 0 {
		sub.Status = statuses[0]
		for _, s := range statuses[1:] {
			sub.Status = moreRestrictive(sub.Status, s)
		}
	}
	if len(evidence) > 0 {
		sub.CustomFields["email_status_evidence"] = evidence
	}
	// SMS and push dates cannot become email consent even through guessed
	// mappings. Only named email evidence is recognized for Omnisend exports.
	if m.Profile == canonical.SourceOmnisend {
		sub.ConsentTimestamp = nil
		for _, col := range m.Columns {
			if normalizeHeader(col.Name) == "email_opt_in_date" && col.Index >= 0 && col.Index < len(rec) {
				sub.ConsentTimestamp = parseConsentDate(rec[col.Index])
			}
		}
	}
}

func parseConsentDate(raw string) *time.Time {
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02", "01/02/2006"} {
		if v, err := time.Parse(layout, strings.TrimSpace(raw)); err == nil && !v.IsZero() {
			return &v
		}
	}
	return nil
}
