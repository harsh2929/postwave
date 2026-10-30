// SPDX-License-Identifier: MIT

package activecampaign

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

// ErrNonEmailContact identifies an ActiveCampaign contact that cannot be
// represented by the email-address-keyed canonical subscriber model.
var ErrNonEmailContact = errors.New("activecampaign: contact has no email address")

// NonEmailContactError is returned for phone-only and otherwise email-less
// ActiveCampaign contacts. Callers must account for these contacts explicitly;
// they must never manufacture an email address from a phone number or silently
// treat an SMS subscription as email permission.
type NonEmailContactError struct {
	SourceID string
	HasPhone bool
}

func (e *NonEmailContactError) Error() string {
	contactID := strings.TrimSpace(e.SourceID)
	if contactID == "" {
		contactID = "unknown"
	}
	if e.HasPhone {
		return fmt.Sprintf("activecampaign: contact %s missing email (phone-only contact)", contactID)
	}
	return fmt.Sprintf("activecampaign: contact %s missing email", contactID)
}

func (e *NonEmailContactError) Unwrap() error { return ErrNonEmailContact }

type activeCampaignMarketingChannel string

const (
	activeCampaignChannelUnknown activeCampaignMarketingChannel = "unknown"
	activeCampaignChannelEmail   activeCampaignMarketingChannel = "email"
	activeCampaignChannelSMS     activeCampaignMarketingChannel = "sms"
)

// activeCampaignEmailExclusionEvidence is normalized evidence that a contact's
// email address matched an ActiveCampaign exclusion. ActiveCampaign exclusions
// may apply account-wide or only to selected lists. Source and Reference are
// provenance labels supplied by the integration; they are not assumed API
// response fields.
type activeCampaignEmailExclusionEvidence struct {
	AllLists  bool
	ListIDs   []string
	Source    string
	Reference string
}

// activeCampaignSubscriberSafetyEvidence contains the out-of-band evidence
// needed to interpret ActiveCampaign's channel-ambiguous contact-list rows.
//
// ListChannelInventoryComplete must only be true after every list referenced by
// the contact was classified using complete provider inventories (including
// the documented /sms/lists inventory). EmailExclusionInventoryComplete must
// only be true after exclusions applicable to this contact were authoritatively
// evaluated. An empty but incomplete inventory is not negative evidence.
type activeCampaignSubscriberSafetyEvidence struct {
	ListChannels                    map[string]activeCampaignMarketingChannel
	ListChannelInventoryComplete    bool
	EmailExclusionInventoryComplete bool
	EmailExclusions                 []activeCampaignEmailExclusionEvidence
}

type activeCampaignSubscriberSafetyDecision struct {
	Status                       canonical.SubscriberStatus
	ConsentSource                canonical.ConsentSource
	ActiveEmailMembershipListIDs map[string]struct{}
	EligibleEmailListIDs         map[string]struct{}
	ListChannels                 map[string]activeCampaignMarketingChannel
	Audit                        map[string]interface{}
}

type activeCampaignListState struct {
	active       bool
	unsubscribed bool
	bounced      bool
	inactive     bool
	unknown      bool
}

func (s activeCampaignListState) eligibleActive() bool {
	return s.active && !s.unsubscribed && !s.bounced && !s.inactive && !s.unknown
}

func evaluateActiveCampaignSubscriberSafety(
	contact acContact,
	lists []acContactList,
	evidence activeCampaignSubscriberSafetyEvidence,
) activeCampaignSubscriberSafetyDecision {
	decision := activeCampaignSubscriberSafetyDecision{
		Status:                       canonical.StatusUnconfirmed,
		ConsentSource:                canonical.ConsentUnknown,
		ActiveEmailMembershipListIDs: map[string]struct{}{},
		EligibleEmailListIDs:         map[string]struct{}{},
		ListChannels:                 map[string]activeCampaignMarketingChannel{},
	}

	emailStates := map[string]activeCampaignListState{}
	smsListIDs := map[string]struct{}{}
	unknownChannelListIDs := map[string]struct{}{}
	missingListID := false
	unknownEmailStatus := false
	classificationComplete := evidence.ListChannelInventoryComplete

	for _, membership := range lists {
		listID := strings.TrimSpace(membership.List)
		if listID == "" {
			missingListID = true
			classificationComplete = false
			continue
		}

		channel := normalizedActiveCampaignMarketingChannel(evidence.ListChannels[listID])
		decision.ListChannels[listID] = channel
		switch channel {
		case activeCampaignChannelEmail:
			state := emailStates[listID]
			switch activeCampaignListStatusClass(membership.Status) {
			case "active":
				state.active = true
			case "unsubscribed":
				state.unsubscribed = true
			case "bounced":
				state.bounced = true
			case "inactive":
				state.inactive = true
			default:
				state.unknown = true
				unknownEmailStatus = true
			}
			emailStates[listID] = state
		case activeCampaignChannelSMS:
			smsListIDs[listID] = struct{}{}
		default:
			unknownChannelListIDs[listID] = struct{}{}
			classificationComplete = false
		}
	}

	globalExcluded := false
	excludedListIDs := map[string]struct{}{}
	normalizedExclusions := normalizeActiveCampaignExclusionEvidence(evidence.EmailExclusions)
	for _, exclusion := range normalizedExclusions {
		if exclusion.AllLists {
			globalExcluded = true
		}
		for _, listID := range exclusion.ListIDs {
			excludedListIDs[listID] = struct{}{}
		}
	}

	activeEmailListIDs := make([]string, 0)
	unsubscribedEmailListIDs := make([]string, 0)
	bouncedEmailListIDs := make([]string, 0)
	inactiveEmailListIDs := make([]string, 0)
	conflictingEmailListIDs := make([]string, 0)
	for listID, state := range emailStates {
		if state.bounced {
			bouncedEmailListIDs = append(bouncedEmailListIDs, listID)
		}
		if state.unsubscribed {
			unsubscribedEmailListIDs = append(unsubscribedEmailListIDs, listID)
		}
		if state.inactive {
			inactiveEmailListIDs = append(inactiveEmailListIDs, listID)
		}
		if state.eligibleActive() {
			activeEmailListIDs = append(activeEmailListIDs, listID)
			continue
		}
		if state.active {
			conflictingEmailListIDs = append(conflictingEmailListIDs, listID)
		}
	}
	sort.Strings(activeEmailListIDs)
	sort.Strings(unsubscribedEmailListIDs)
	sort.Strings(bouncedEmailListIDs)
	sort.Strings(inactiveEmailListIDs)
	sort.Strings(conflictingEmailListIDs)
	segmentEmailListIDs := make([]string, 0, len(activeEmailListIDs))
	for _, listID := range activeEmailListIDs {
		// Segment membership and sendability are deliberately separate. An
		// active membership in a list classified as email is safe to preserve
		// as targeting structure even when exclusion evidence is incomplete;
		// the subscriber remains unconfirmed/disabled/blocklisted until the
		// independent sendability checks below pass. A known exclusion still
		// suppresses its targeting tag so a contact enabled through another
		// list cannot be selected through an excluded list.
		if globalExcluded {
			continue
		}
		if _, excluded := excludedListIDs[listID]; excluded {
			continue
		}
		decision.ActiveEmailMembershipListIDs[listID] = struct{}{}
		segmentEmailListIDs = append(segmentEmailListIDs, listID)
	}

	eligibleEmailListIDs := make([]string, 0, len(activeEmailListIDs))
	for _, listID := range activeEmailListIDs {
		if _, excluded := excludedListIDs[listID]; excluded {
			continue
		}
		eligibleEmailListIDs = append(eligibleEmailListIDs, listID)
	}

	reason := "no_email_list_membership"
	switch {
	case truthy(contact.BouncedHard) || len(bouncedEmailListIDs) > 0:
		decision.Status = canonical.StatusBlocklisted
		reason = "email_bounce_evidence"
	case globalExcluded:
		decision.Status = canonical.StatusBlocklisted
		reason = "account_wide_email_exclusion"
	case truthy(contact.Deleted):
		decision.Status = canonical.StatusDisabled
		reason = "deleted_contact"
	case len(activeEmailListIDs) > 0 && (!classificationComplete || missingListID):
		reason = "incomplete_list_channel_evidence"
	case len(activeEmailListIDs) > 0 && unknownEmailStatus:
		reason = "unknown_email_list_status"
	case len(activeEmailListIDs) > 0 && !evidence.EmailExclusionInventoryComplete:
		reason = "incomplete_email_exclusion_evidence"
	case len(activeEmailListIDs) > 0 && len(eligibleEmailListIDs) == 0:
		decision.Status = canonical.StatusDisabled
		reason = "all_active_email_lists_excluded"
	case len(activeEmailListIDs) > 0:
		decision.Status = canonical.StatusEnabled
		reason = "active_email_list_and_complete_exclusion_check"
		for _, listID := range eligibleEmailListIDs {
			decision.EligibleEmailListIDs[listID] = struct{}{}
		}
	case len(conflictingEmailListIDs) > 0:
		reason = "conflicting_email_list_status"
	case len(unsubscribedEmailListIDs) > 0:
		decision.Status = canonical.StatusDisabled
		reason = "email_list_unsubscribed"
	case len(inactiveEmailListIDs) > 0:
		reason = "email_list_not_active"
	case len(smsListIDs) > 0 && len(unknownChannelListIDs) == 0:
		reason = "sms_only_membership"
	case len(unknownChannelListIDs) > 0:
		reason = "unknown_list_channel"
	}

	decision.Audit = map[string]interface{}{
		"decision":                 string(decision.Status),
		"reason":                   reason,
		"canonical_consent_source": string(canonical.ConsentUnknown),
		"list_subscription_date_is_consent_proof": false,
		"list_channel_inventory_complete":         evidence.ListChannelInventoryComplete,
		"list_channel_evidence_complete":          classificationComplete && !missingListID,
		"email_exclusion_inventory_complete":      evidence.EmailExclusionInventoryComplete,
	}
	setActiveCampaignAuditStrings(decision.Audit, "active_email_list_ids", activeEmailListIDs)
	setActiveCampaignAuditStrings(decision.Audit, "segment_email_list_ids", segmentEmailListIDs)
	setActiveCampaignAuditStrings(decision.Audit, "eligible_email_list_ids", eligibleEmailListIDs)
	setActiveCampaignAuditStrings(decision.Audit, "unsubscribed_email_list_ids", unsubscribedEmailListIDs)
	setActiveCampaignAuditStrings(decision.Audit, "bounced_email_list_ids", bouncedEmailListIDs)
	setActiveCampaignAuditStrings(decision.Audit, "inactive_email_list_ids", inactiveEmailListIDs)
	setActiveCampaignAuditStrings(decision.Audit, "conflicting_email_list_ids", conflictingEmailListIDs)
	setActiveCampaignAuditStrings(decision.Audit, "sms_list_ids", sortedActiveCampaignSet(smsListIDs))
	setActiveCampaignAuditStrings(decision.Audit, "unknown_channel_list_ids", sortedActiveCampaignSet(unknownChannelListIDs))
	setActiveCampaignAuditStrings(decision.Audit, "excluded_email_list_ids", sortedActiveCampaignSet(excludedListIDs))
	if missingListID {
		decision.Audit["membership_missing_list_id"] = true
	}
	if globalExcluded {
		decision.Audit["account_wide_email_exclusion"] = true
	}
	if len(normalizedExclusions) > 0 {
		decision.Audit["email_exclusions"] = activeCampaignExclusionAuditEntries(normalizedExclusions)
	}
	if channels := activeCampaignChannelAuditEntries(decision.ListChannels); len(channels) > 0 {
		decision.Audit["list_channels"] = channels
	}
	if subscribedAt := earliestActiveCampaignEmailSubscription(lists, decision.ListChannels); subscribedAt != nil {
		decision.Audit["earliest_active_email_subscription_at"] = subscribedAt.UTC().Format("2006-01-02T15:04:05Z")
	}

	return decision
}

func normalizedActiveCampaignMarketingChannel(channel activeCampaignMarketingChannel) activeCampaignMarketingChannel {
	switch activeCampaignMarketingChannel(strings.ToLower(strings.TrimSpace(string(channel)))) {
	case activeCampaignChannelEmail:
		return activeCampaignChannelEmail
	case activeCampaignChannelSMS:
		return activeCampaignChannelSMS
	default:
		return activeCampaignChannelUnknown
	}
}

func normalizeActiveCampaignExclusionEvidence(in []activeCampaignEmailExclusionEvidence) []activeCampaignEmailExclusionEvidence {
	out := make([]activeCampaignEmailExclusionEvidence, 0, len(in))
	for _, item := range in {
		item.Source = strings.TrimSpace(item.Source)
		item.Reference = strings.TrimSpace(item.Reference)
		item.ListIDs = dedupeStrings(item.ListIDs)
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return activeCampaignExclusionSortKey(out[i]) < activeCampaignExclusionSortKey(out[j])
	})
	return out
}

func activeCampaignExclusionSortKey(item activeCampaignEmailExclusionEvidence) string {
	return strings.Join([]string{
		fmt.Sprint(item.AllLists),
		strings.Join(item.ListIDs, ","),
		item.Source,
		item.Reference,
	}, "\x00")
}

func activeCampaignExclusionAuditEntries(in []activeCampaignEmailExclusionEvidence) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(in))
	for _, item := range in {
		entry := map[string]interface{}{
			"scope": "selected_lists",
		}
		if item.AllLists {
			entry["scope"] = "all_lists"
		}
		if len(item.ListIDs) > 0 {
			entry["list_ids"] = append([]string(nil), item.ListIDs...)
		}
		if item.Source != "" {
			entry["source"] = item.Source
		}
		if item.Reference != "" {
			entry["reference"] = item.Reference
		}
		out = append(out, entry)
	}
	return out
}

func activeCampaignChannelAuditEntries(channels map[string]activeCampaignMarketingChannel) []map[string]interface{} {
	listIDs := make([]string, 0, len(channels))
	for listID := range channels {
		listIDs = append(listIDs, listID)
	}
	sort.Strings(listIDs)
	out := make([]map[string]interface{}, 0, len(listIDs))
	for _, listID := range listIDs {
		out = append(out, map[string]interface{}{
			"list_id": listID,
			"channel": string(channels[listID]),
		})
	}
	return out
}

func earliestActiveCampaignEmailSubscription(lists []acContactList, channels map[string]activeCampaignMarketingChannel) *time.Time {
	var earliest *time.Time
	for _, membership := range lists {
		listID := strings.TrimSpace(membership.List)
		if normalizedActiveCampaignMarketingChannel(channels[listID]) != activeCampaignChannelEmail ||
			!isActiveListStatus(membership.Status) {
			continue
		}
		subscribedAt := firstParsedTime(membership.SubscribeDate)
		if subscribedAt == nil || (earliest != nil && !subscribedAt.Before(*earliest)) {
			continue
		}
		copy := *subscribedAt
		earliest = &copy
	}
	return earliest
}

func setActiveCampaignAuditStrings(audit map[string]interface{}, key string, values []string) {
	if len(values) > 0 {
		audit[key] = append([]string(nil), values...)
	}
}

func sortedActiveCampaignSet(values map[string]struct{}) []string {
	out := make([]string, 0, len(values))
	for value := range values {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}
