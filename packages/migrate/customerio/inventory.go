// SPDX-License-Identifier: MIT

package customerio

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	customerSearchPageSize    = 1000
	segmentMembershipPageSize = 1000
	newsletterPageSize        = 100
	designEmailPageSize       = 1000
	suppressionPageSize       = 1000
	optoutPageSize            = 1000
	archivePageSize           = 100
	templateOutputPageSize    = 100
	sourceArchivePageSize     = 100
)

var espSuppressionTypes = []string{"blocks", "bounces", "spam_reports", "invalid_emails"}

type customerIOSnapshot struct {
	Subscribers                        []canonical.Subscriber
	ProfilesWithoutEmail               int
	ProfilesWithoutEmailIdentityDigest string
	Segments                           []cioSegment
	Topics                             []cioSubscriptionTopic
	Channels                           []cioSubscriptionChannel
	MembershipCounts                   map[string]int
	Campaigns                          []cioWorkflowEvidence
	Broadcasts                         []cioWorkflowEvidence
	Newsletters                        []cioNewsletterEvidence
	Transactional                      []cioTransactionalEvidence
	DesignEmails                       []cioDesignEmailEvidence
	Suppressions                       []cioSuppression
	Optouts                            []cioChannelOptout
	ObjectTypes                        []cioResource
	CampaignArchive                    []canonical.CampaignArchive
	Templates                          []canonical.EmailTemplate
	SourceArchive                      []canonical.SourceArchiveItem
	CustomFields                       []string
	Warnings                           []string
	SMSNewsletters                     int
	PushNewsletters                    int
	Fingerprint                        string
}

type profileSnapshotInput struct {
	Detail      cioCustomerDetail
	Preferences cioProfilePreferenceEvidence
	Tags        []string
}

func (a *Adapter) ensureSnapshot(ctx context.Context, sess adapter.Session) (*customerIOSnapshot, error) {
	if err := validateSession(sess); err != nil {
		return nil, err
	}
	key := AccountFingerprint(sess)
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	if snapshot := a.snapshots[key]; snapshot != nil {
		return snapshot, nil
	}
	snapshot, err := a.buildSnapshot(ctx, sess)
	if err != nil {
		return nil, err
	}
	a.snapshots[key] = snapshot
	return snapshot, nil
}

func (a *Adapter) buildSnapshot(ctx context.Context, sess adapter.Session) (*customerIOSnapshot, error) {
	snapshot := &customerIOSnapshot{MembershipCounts: make(map[string]int)}
	var err error
	if snapshot.Segments, err = a.listSegments(ctx, sess); err != nil {
		return nil, err
	}
	if snapshot.Topics, err = a.listTopics(ctx, sess); err != nil {
		return nil, err
	}
	if snapshot.Channels, err = a.listSubscriptionChannels(ctx, sess); err != nil {
		return nil, err
	}

	emailIDs, err := a.listCustomerIdentifiers(ctx, sess, true)
	if err != nil {
		return nil, fmt.Errorf("customerio discover email-addressable profiles: %w", err)
	}
	nonEmailIDs, err := a.listCustomerIdentifiers(ctx, sess, false)
	if err != nil {
		return nil, fmt.Errorf("customerio discover profiles without email: %w", err)
	}
	if len(emailIDs)+len(nonEmailIDs) > maxSnapshotProfiles {
		return nil, fmt.Errorf("customerio profile snapshot exceeds the %d-profile safety bound: %w", maxSnapshotProfiles, adapter.ErrSourceUnavailable)
	}
	allProfileIDs := make(map[string]struct{}, len(emailIDs)+len(nonEmailIDs))
	excludedProfileIDs := make(map[string]struct{}, len(nonEmailIDs))
	for id := range emailIDs {
		allProfileIDs[id] = struct{}{}
	}
	for id := range nonEmailIDs {
		if _, overlap := allProfileIDs[id]; overlap {
			return nil, fmt.Errorf("customerio profile %q appeared in both email and non-email searches: %w", id, adapter.ErrSourceUnavailable)
		}
		allProfileIDs[id] = struct{}{}
		excludedProfileIDs[id] = struct{}{}
	}

	snapshot.Suppressions, err = a.listSuppressions(ctx, sess)
	if err != nil {
		return nil, err
	}
	suppressionsByEmail := make(map[string][]cioSuppression)
	for _, suppression := range snapshot.Suppressions {
		email := strings.ToLower(strings.TrimSpace(suppression.Email))
		if !validEmail(strings.TrimSpace(suppression.Email)) {
			return nil, fmt.Errorf("customerio ESP suppression returned an invalid email address: %w", adapter.ErrSourceUnavailable)
		}
		suppressionsByEmail[email] = append(suppressionsByEmail[email], suppression)
	}

	candidateProfileIDs := sortedMapKeys(emailIDs)
	profiles := make(map[string]*profileSnapshotInput, len(candidateProfileIDs))
	addressableIDs := make(map[string]cioIdentifiers, len(candidateProfileIDs))
	for _, cioID := range candidateProfileIDs {
		detail, detailErr := a.getCustomerDetail(ctx, sess, cioID)
		if detailErr != nil {
			return nil, detailErr
		}
		if strings.TrimSpace(string(detail.Identifiers.CIOID)) != cioID {
			return nil, fmt.Errorf("customerio profile %q attributes returned mismatched cio_id %q: %w", cioID, detail.Identifiers.CIOID, adapter.ErrSourceUnavailable)
		}
		if email := customerDetailEmail(detail); !validEmail(email) {
			// The `email exists` filter can include an arbitrary or empty email
			// attribute when email is not configured as a workspace identifier.
			// Such a profile is not safely addressable as an email subscriber.
			excludedProfileIDs[cioID] = struct{}{}
			continue
		}
		var appPreferences *cioCustomerPreferencesResponse
		if len(snapshot.Topics) > 0 || len(snapshot.Channels) > 0 {
			preferences, preferenceErr := a.getCustomerPreferences(ctx, sess, cioID)
			if preferenceErr != nil {
				return nil, preferenceErr
			}
			if strings.TrimSpace(string(preferences.Customer.Identifiers.CIOID)) != cioID {
				return nil, fmt.Errorf("customerio profile %q preferences returned mismatched cio_id: %w", cioID, adapter.ErrSourceUnavailable)
			}
			if preferences.Customer.Unsubscribed != nil {
				if detail.Unsubscribed != nil && *detail.Unsubscribed != *preferences.Customer.Unsubscribed {
					return nil, fmt.Errorf("customerio profile %q returned conflicting global unsubscribe state: %w", cioID, adapter.ErrSourceUnavailable)
				}
				detail.Unsubscribed = preferences.Customer.Unsubscribed
			}
			appPreferences = &preferences
		}
		preferenceEvidence, preferenceErr := reconcileProfilePreferences(detail, snapshot.Topics, snapshot.Channels, appPreferences)
		if preferenceErr != nil {
			return nil, fmt.Errorf("customerio profile %q subscription preferences: %w", cioID, preferenceErr)
		}
		profiles[cioID] = &profileSnapshotInput{Detail: detail, Preferences: preferenceEvidence}
		addressableIDs[cioID] = emailIDs[cioID]
	}
	profileIDs := sortedMapKeys(profiles)
	snapshot.ProfilesWithoutEmail = len(excludedProfileIDs)
	snapshot.ProfilesWithoutEmailIdentityDigest = nonEmailProfileIdentityDigest(excludedProfileIDs)

	membershipEvidence := 0
	for _, segment := range snapshot.Segments {
		tag := segmentMembershipTag(string(segment.ID))
		count, memberErr := a.snapshotSegmentMembership(ctx, sess, segment, addressableIDs, allProfileIDs, profiles, &membershipEvidence)
		if memberErr != nil {
			return nil, memberErr
		}
		snapshot.MembershipCounts[tag] = count
	}
	for _, topic := range snapshot.Topics {
		tag := topicMembershipTag(topic.Identifier)
		count := 0
		for _, profile := range profiles {
			if profile.Preferences.TopicStates[topic.Identifier] {
				profile.Tags = append(profile.Tags, tag)
				count++
			}
		}
		snapshot.MembershipCounts[tag] = count
	}

	emailGroups := make(map[string][]string)
	unconfirmed := 0
	customFields := map[string]struct{}{}
	for _, cioID := range profileIDs {
		profile := profiles[cioID]
		email := customerDetailEmail(profile.Detail)
		subscriber, mapErr := mapCustomer(profile.Detail, profile.Preferences, snapshot.Topics, profile.Tags, suppressionsByEmail[strings.ToLower(email)])
		if mapErr != nil {
			return nil, mapErr
		}
		if subscriber.Status == canonical.StatusUnconfirmed {
			unconfirmed++
		}
		snapshot.Subscribers = append(snapshot.Subscribers, subscriber)
		emailGroups[strings.ToLower(subscriber.Email)] = append(emailGroups[strings.ToLower(subscriber.Email)], cioID)
		for key := range subscriber.CustomFields {
			customFields[key] = struct{}{}
		}
	}
	sort.Slice(snapshot.Subscribers, func(i, j int) bool { return snapshot.Subscribers[i].SourceID < snapshot.Subscribers[j].SourceID })
	for key := range customFields {
		snapshot.CustomFields = append(snapshot.CustomFields, key)
	}
	sort.Strings(snapshot.CustomFields)

	duplicateValues, duplicateProfiles := 0, 0
	for _, ids := range emailGroups {
		if len(ids) > 1 {
			duplicateValues++
			duplicateProfiles += len(ids)
		}
	}
	if snapshot.ProfilesWithoutEmail > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("%d Customer.io profiles have no usable email attribute and are excluded from the email-subscriber import; their immutable cio_id identities are counted separately.", snapshot.ProfilesWithoutEmail))
	}
	if duplicateValues > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("%d Customer.io profiles share %d email values. Each profile is traversed by immutable cio_id; destination email deduplication must retain the resulting merge conflicts.", duplicateProfiles, duplicateValues))
	}
	if unconfirmed > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("%d Customer.io profiles lacked complete global, topic, or email-channel subscription evidence and are imported unconfirmed rather than enabled.", unconfirmed))
	}
	if len(snapshot.Subscribers) > 0 {
		snapshot.Warnings = append(snapshot.Warnings, "Customer.io profile creation/email timestamps are provenance, not opt-in proof; imported consent timestamps remain unknown.")
	}
	if len(snapshot.Segments) > 0 {
		snapshot.Warnings = append(snapshot.Warnings, "Customer.io segment rules are not exposed by the App API; exact memberships are frozen into synthetic tags and the dynamic rules require manual rebuild.")
	}

	if snapshot.Campaigns, err = a.listCampaigns(ctx, sess); err != nil {
		return nil, err
	}
	if snapshot.Broadcasts, err = a.listBroadcasts(ctx, sess); err != nil {
		return nil, err
	}
	if snapshot.Newsletters, err = a.listNewsletters(ctx, sess); err != nil {
		return nil, err
	}
	if snapshot.Transactional, err = a.listTransactional(ctx, sess); err != nil {
		return nil, err
	}
	if snapshot.DesignEmails, err = a.listDesignEmails(ctx, sess); err != nil {
		return nil, err
	}
	if snapshot.ObjectTypes, err = a.listObjectTypes(ctx, sess); err != nil {
		return nil, err
	}
	if snapshot.Optouts, err = a.listOptouts(ctx, sess); err != nil {
		return nil, err
	}

	for i := range snapshot.Newsletters {
		newsletter := &snapshot.Newsletters[i]
		switch newsletter.Resource.Type {
		case "twilio", "sms":
			snapshot.SMSNewsletters++
		case "push":
			snapshot.PushNewsletters++
		}
		if newsletter.Resource.SentAt > 0 && newsletter.Resource.Type == "email" {
			archive, materialized, sourceOnlyReason, archiveErr := mapNewsletterArchive(*newsletter)
			if archiveErr != nil {
				return nil, archiveErr
			}
			if materialized {
				snapshot.CampaignArchive = append(snapshot.CampaignArchive, archive)
			} else {
				newsletter.ArchiveSourceOnlyReason = sourceOnlyReason
				snapshot.Warnings = append(snapshot.Warnings, sourceOnlyReason)
			}
		}
	}
	for _, designEmail := range snapshot.DesignEmails {
		template, editable, templateErr := mapDesignEmailTemplate(designEmail)
		if templateErr != nil {
			return nil, templateErr
		}
		if editable {
			snapshot.Templates = append(snapshot.Templates, template)
		}
	}
	sort.Slice(snapshot.CampaignArchive, func(i, j int) bool {
		return snapshot.CampaignArchive[i].SourceID < snapshot.CampaignArchive[j].SourceID
	})
	sort.Slice(snapshot.Templates, func(i, j int) bool { return snapshot.Templates[i].SourceID < snapshot.Templates[j].SourceID })

	snapshot.SourceArchive = buildSourceArchive(snapshot)
	if len(snapshot.Campaigns)+len(snapshot.Broadcasts) > 0 {
		snapshot.Warnings = append(snapshot.Warnings, "Customer.io campaign and API-broadcast actions are partial rebuild evidence, not executable workflow graphs; they are emitted as draft rebuild-review automations and preserved in the source archive. API-broadcast trigger evidence retains only trigger IDs plus created/processed timestamps; original trigger payloads, audiences, and per-user data are not returned and require manual reconciliation.")
	}
	if snapshot.SMSNewsletters+snapshot.PushNewsletters > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("%d SMS and %d push newsletters are preserved as non-email source evidence and are not imported as executable email campaigns.", snapshot.SMSNewsletters, snapshot.PushNewsletters))
	}
	snapshot.Warnings = append(snapshot.Warnings,
		"Only sent email newsletters with at least one explicit language=\"\" default and provably composable source HTML become campaign archive records. The lowest stable content ID represents a multi-default/A-B set with an explicit warning, all variants remain source evidence, and translations are never silently selected. A missing or empty layout uses the exact non-empty source body with a fidelity warning; a non-empty layout must contain exactly one documented {{content}} slot. Newsletter and Design Studio HTML are exact source content/composition, not provider-rendered output. Ongoing campaigns and API broadcasts are workflow definitions, not single sent campaigns.",
		"Customer.io delivery/report endpoints are time-windowed and do not provide an unbounded account-history export; historical per-recipient delivery and event continuity requires a provider export or data-out integration.",
	)

	fingerprint, err := snapshotFingerprint(snapshot)
	if err != nil {
		return nil, err
	}
	snapshot.Fingerprint = fingerprint
	return snapshot, nil
}

func (a *Adapter) listCustomerIdentifiers(ctx context.Context, sess adapter.Session, withEmail bool) (map[string]cioIdentifiers, error) {
	filter := map[string]interface{}{"attribute": map[string]interface{}{"field": "email", "operator": "exists"}}
	if !withEmail {
		filter = map[string]interface{}{"not": filter}
	}
	body, err := json.Marshal(map[string]interface{}{"filter": filter})
	if err != nil {
		return nil, err
	}
	out := make(map[string]cioIdentifiers)
	cursor := ""
	seenCursors := map[string]struct{}{}
	for page := 0; page < maxTraversalPages; page++ {
		query := url.Values{"limit": {strconv.Itoa(customerSearchPageSize)}}
		if cursor != "" {
			query.Set("start", cursor)
		}
		var response cioCustomerSearchPage
		if err := a.do(ctx, sess, http.MethodPost, "/v1/customers?"+query.Encode(), bytes.NewReader(body), &response); err != nil {
			return nil, err
		}
		identifiers, collectionErr := requireCollection(response.Identifiers, "customer search identifiers")
		if collectionErr != nil {
			return nil, collectionErr
		}
		if len(identifiers) > customerSearchPageSize {
			return nil, fmt.Errorf("customerio customer search returned more than %d identities: %w", customerSearchPageSize, adapter.ErrSourceUnavailable)
		}
		for _, identity := range identifiers {
			cioID := strings.TrimSpace(string(identity.CIOID))
			if !validProviderID(cioID) {
				return nil, fmt.Errorf("customerio customer search returned an invalid cio_id: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := out[cioID]; duplicate {
				return nil, fmt.Errorf("customerio customer search returned duplicate cio_id %q across pages: %w", cioID, adapter.ErrSourceUnavailable)
			}
			out[cioID] = identity
			if len(out) > maxSnapshotProfiles {
				return nil, fmt.Errorf("customerio customer search exceeds the %d-profile safety bound: %w", maxSnapshotProfiles, adapter.ErrSourceUnavailable)
			}
		}
		next, nextErr := validateProviderCursor(response.Next, cursor, seenCursors, "customer search")
		if nextErr != nil {
			return nil, nextErr
		}
		if next == "" {
			return out, nil
		}
		if len(identifiers) == 0 {
			return nil, fmt.Errorf("customerio customer search returned an empty non-terminal page: %w", adapter.ErrSourceUnavailable)
		}
		cursor = next
	}
	return nil, fmt.Errorf("customerio customer search exceeded %d pages: %w", maxTraversalPages, adapter.ErrSourceUnavailable)
}

func (a *Adapter) getCustomerDetail(ctx context.Context, sess adapter.Session, cioID string) (cioCustomerDetail, error) {
	query := url.Values{"id_type": {"cio_id"}}
	var response cioCustomerDetailResponse
	path := "/v1/customers/" + url.PathEscape(cioID) + "/attributes?" + query.Encode()
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return cioCustomerDetail{}, fmt.Errorf("customerio hydrate profile %q attributes: %w", cioID, err)
	}
	return response.Customer, nil
}

func (a *Adapter) getCustomerPreferences(ctx context.Context, sess adapter.Session, cioID string) (cioCustomerPreferencesResponse, error) {
	query := url.Values{"id_type": {"cio_id"}}
	var response cioCustomerPreferencesResponse
	path := "/v1/customers/" + url.PathEscape(cioID) + "/subscription_preferences?" + query.Encode()
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return cioCustomerPreferencesResponse{}, fmt.Errorf("customerio hydrate profile %q subscription preferences: %w", cioID, err)
	}
	return response, nil
}

func (a *Adapter) listSegments(ctx context.Context, sess adapter.Session) ([]cioSegment, error) {
	var response struct {
		Segments *[]cioSegment `json:"segments"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/v1/segments", nil, &response); err != nil {
		return nil, fmt.Errorf("customerio list segments: %w", err)
	}
	segments, err := requireCollection(response.Segments, "segments")
	if err != nil {
		return nil, err
	}
	if len(segments) > maxUnpagedResources {
		return nil, fmt.Errorf("customerio segments exceed the %d-resource safety bound: %w", maxUnpagedResources, adapter.ErrSourceUnavailable)
	}
	seen := map[string]struct{}{}
	for _, segment := range segments {
		id := strings.TrimSpace(string(segment.ID))
		if !validProviderID(id) {
			return nil, fmt.Errorf("customerio segments returned an invalid identity: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, fmt.Errorf("customerio segments returned duplicate identity %q: %w", id, adapter.ErrSourceUnavailable)
		}
		seen[id] = struct{}{}
	}
	sort.Slice(segments, func(i, j int) bool { return string(segments[i].ID) < string(segments[j].ID) })
	return segments, nil
}

func (a *Adapter) listTopics(ctx context.Context, sess adapter.Session) ([]cioSubscriptionTopic, error) {
	var response struct {
		Topics *[]cioSubscriptionTopic `json:"topics"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/v1/subscription_topics", nil, &response); err != nil {
		return nil, fmt.Errorf("customerio list subscription topics: %w", err)
	}
	topics, err := requireCollection(response.Topics, "subscription topics")
	if err != nil {
		return nil, err
	}
	if len(topics) > maxUnpagedResources {
		return nil, fmt.Errorf("customerio subscription topics exceed the safety bound: %w", adapter.ErrSourceUnavailable)
	}
	seenIDs, seenIdentifiers := map[string]struct{}{}, map[string]struct{}{}
	for index := range topics {
		topic := &topics[index]
		id := strings.TrimSpace(string(topic.ID))
		identifier := strings.TrimSpace(topic.Identifier)
		if !validProviderID(id) || identifier == "" || len(identifier) > 256 {
			return nil, fmt.Errorf("customerio subscription topics returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenIDs[id]; duplicate {
			return nil, fmt.Errorf("customerio subscription topics returned duplicate ID %q: %w", id, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenIdentifiers[identifier]; duplicate {
			return nil, fmt.Errorf("customerio subscription topics returned duplicate identifier %q: %w", identifier, adapter.ErrSourceUnavailable)
		}
		seenIDs[id], seenIdentifiers[identifier] = struct{}{}, struct{}{}
		topic.Identifier = identifier
	}
	sort.Slice(topics, func(i, j int) bool { return topics[i].Identifier < topics[j].Identifier })
	return topics, nil
}

func (a *Adapter) listSubscriptionChannels(ctx context.Context, sess adapter.Session) ([]cioSubscriptionChannel, error) {
	var response struct {
		Channels *[]cioSubscriptionChannel `json:"channels"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/v1/subscription_channels", nil, &response); err != nil {
		return nil, fmt.Errorf("customerio list subscription channels: %w", err)
	}
	channels, err := requireCollection(response.Channels, "subscription channels")
	if err != nil {
		return nil, err
	}
	if len(channels) > maxUnpagedResources {
		return nil, fmt.Errorf("customerio subscription channels exceed the safety bound: %w", adapter.ErrSourceUnavailable)
	}
	seenIDs, seenTypes, seenPreferenceKeys := map[string]struct{}{}, map[string]struct{}{}, map[string]struct{}{}
	for index := range channels {
		channel := &channels[index]
		id := strings.TrimSpace(string(channel.ID))
		channelType := strings.ToLower(strings.TrimSpace(channel.Type))
		preferenceKey, validType := customerIOChannelPreferenceKey(channelType)
		if !validPositiveIntegerID(id) || !isCustomerIOSubscriptionChannelType(channelType) || !validType || channel.SubscribedByDefault == nil {
			return nil, fmt.Errorf("customerio subscription channels returned an incomplete or invalid definition: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenIDs[id]; duplicate {
			return nil, fmt.Errorf("customerio subscription channels returned duplicate ID %q: %w", id, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenTypes[channelType]; duplicate {
			return nil, fmt.Errorf("customerio subscription channels returned duplicate type %q: %w", channelType, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenPreferenceKeys[preferenceKey]; duplicate {
			return nil, fmt.Errorf("customerio subscription channels returned ambiguous preference key %q: %w", preferenceKey, adapter.ErrSourceUnavailable)
		}
		seenIDs[id], seenTypes[channelType], seenPreferenceKeys[preferenceKey] = struct{}{}, struct{}{}, struct{}{}
		channel.Type = channelType
	}
	sort.Slice(channels, func(i, j int) bool {
		left, _ := customerIOChannelPreferenceKey(channels[i].Type)
		right, _ := customerIOChannelPreferenceKey(channels[j].Type)
		if left == right {
			return string(channels[i].ID) < string(channels[j].ID)
		}
		return left < right
	})
	return channels, nil
}

func validateTopicPreferences(topics []cioSubscriptionTopic, preferences []cioCustomerTopicPreference) (map[string]bool, error) {
	byID := make(map[string]cioSubscriptionTopic, len(topics))
	for _, topic := range topics {
		byID[strings.TrimSpace(string(topic.ID))] = topic
	}
	out := make(map[string]bool, len(preferences))
	for _, preference := range preferences {
		id := strings.TrimSpace(string(preference.ID))
		topic, known := byID[id]
		if !known || preference.Subscribed == nil {
			return nil, fmt.Errorf("unknown or incomplete topic %q: %w", id, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := out[topic.Identifier]; duplicate {
			return nil, fmt.Errorf("duplicate topic %q: %w", id, adapter.ErrSourceUnavailable)
		}
		out[topic.Identifier] = *preference.Subscribed
	}
	if len(out) != len(topics) {
		return nil, fmt.Errorf("returned %d of %d configured topics: %w", len(out), len(topics), adapter.ErrSourceUnavailable)
	}
	return out, nil
}

func (a *Adapter) snapshotSegmentMembership(ctx context.Context, sess adapter.Session, segment cioSegment, emailIDs map[string]cioIdentifiers, allProfileIDs map[string]struct{}, profiles map[string]*profileSnapshotInput, evidence *int) (int, error) {
	segmentID := strings.TrimSpace(string(segment.ID))
	var countResponse struct {
		SegmentID flexibleString `json:"segment_id"`
		Count     *int           `json:"count"`
	}
	countPath := "/v1/segments/" + url.PathEscape(segmentID) + "/customer_count"
	if err := a.do(ctx, sess, http.MethodGet, countPath, nil, &countResponse); err != nil {
		return 0, fmt.Errorf("customerio count segment %q membership: %w", segmentID, err)
	}
	if strings.TrimSpace(string(countResponse.SegmentID)) != segmentID || countResponse.Count == nil || *countResponse.Count < 0 || *countResponse.Count > maxMembershipEvidence {
		return 0, fmt.Errorf("customerio segment %q returned an invalid membership count: %w", segmentID, adapter.ErrSourceUnavailable)
	}
	expectedMembers := *countResponse.Count
	cursor := ""
	seenCursors := map[string]struct{}{}
	seenMembers := map[string]struct{}{}
	count := 0
	for page := 0; page < maxTraversalPages; page++ {
		query := url.Values{"limit": {strconv.Itoa(segmentMembershipPageSize)}}
		if cursor != "" {
			query.Set("start", cursor)
		}
		var response struct {
			SegmentID   flexibleString    `json:"segment_id"`
			Identifiers *[]cioIdentifiers `json:"identifiers"`
			Next        string            `json:"next"`
		}
		path := "/v1/segments/" + url.PathEscape(segmentID) + "/membership?" + query.Encode()
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return 0, fmt.Errorf("customerio list segment %q membership: %w", segmentID, err)
		}
		identifiers, collectionErr := requireCollection(response.Identifiers, "segment membership identifiers")
		if collectionErr != nil {
			return 0, collectionErr
		}
		if response.SegmentID != "" && strings.TrimSpace(string(response.SegmentID)) != segmentID {
			return 0, fmt.Errorf("customerio segment %q membership returned mismatched segment_id: %w", segmentID, adapter.ErrSourceUnavailable)
		}
		if len(identifiers) > segmentMembershipPageSize {
			return 0, fmt.Errorf("customerio segment %q membership exceeded the requested page size: %w", segmentID, adapter.ErrSourceUnavailable)
		}
		for _, identity := range identifiers {
			cioID := strings.TrimSpace(string(identity.CIOID))
			if !validProviderID(cioID) {
				return 0, fmt.Errorf("customerio segment %q membership returned an invalid cio_id: %w", segmentID, adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenMembers[cioID]; duplicate {
				return 0, fmt.Errorf("customerio segment %q membership returned duplicate cio_id %q: %w", segmentID, cioID, adapter.ErrSourceUnavailable)
			}
			seenMembers[cioID] = struct{}{}
			if len(seenMembers) > expectedMembers {
				return 0, fmt.Errorf("customerio segment %q returned more members than its count: %w", segmentID, adapter.ErrSourceUnavailable)
			}
			*evidence++
			if *evidence > maxMembershipEvidence {
				return 0, fmt.Errorf("customerio segment memberships exceed the %d-row safety bound: %w", maxMembershipEvidence, adapter.ErrSourceUnavailable)
			}
			if _, discovered := allProfileIDs[cioID]; !discovered {
				return 0, fmt.Errorf("customerio segment %q contains profile %q absent from the profile snapshot: %w", segmentID, cioID, adapter.ErrSourceUnavailable)
			}
			if _, addressable := emailIDs[cioID]; addressable {
				profiles[cioID].Tags = append(profiles[cioID].Tags, segmentMembershipTag(segmentID))
				count++
			}
		}
		next, nextErr := validateProviderCursor(response.Next, cursor, seenCursors, "segment membership")
		if nextErr != nil {
			return 0, nextErr
		}
		if next == "" {
			if len(seenMembers) != expectedMembers {
				return 0, fmt.Errorf("customerio segment %q returned %d of %d members: %w", segmentID, len(seenMembers), expectedMembers, adapter.ErrSourceUnavailable)
			}
			return count, nil
		}
		if len(identifiers) == 0 {
			return 0, fmt.Errorf("customerio segment %q returned an empty non-terminal membership page: %w", segmentID, adapter.ErrSourceUnavailable)
		}
		cursor = next
	}
	return 0, fmt.Errorf("customerio segment %q membership exceeded %d pages: %w", segmentID, maxTraversalPages, adapter.ErrSourceUnavailable)
}

func (a *Adapter) listSuppressions(ctx context.Context, sess adapter.Session) ([]cioSuppression, error) {
	var out []cioSuppression
	seen := map[string]struct{}{}
	for _, suppressionType := range espSuppressionTypes {
		offset := 0
		for page := 0; page < maxTraversalPages; page++ {
			query := url.Values{"limit": {strconv.Itoa(suppressionPageSize)}, "offset": {strconv.Itoa(offset)}}
			var response cioSuppressionPage
			path := "/v1/esp/suppression/" + url.PathEscape(suppressionType) + "?" + query.Encode()
			if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
				return nil, fmt.Errorf("customerio list %s ESP suppressions: %w", suppressionType, err)
			}
			suppressions, collectionErr := requireCollection(response.Suppressions, suppressionType+" ESP suppressions")
			if collectionErr != nil {
				return nil, collectionErr
			}
			if len(suppressions) > suppressionPageSize {
				return nil, fmt.Errorf("customerio %s ESP suppressions exceeded the requested page size: %w", suppressionType, adapter.ErrSourceUnavailable)
			}
			for index := range suppressions {
				suppression := &suppressions[index]
				suppression.Type = suppressionType
				if !validEmail(strings.TrimSpace(suppression.Email)) {
					return nil, fmt.Errorf("customerio %s ESP suppressions returned an invalid email address: %w", suppressionType, adapter.ErrSourceUnavailable)
				}
				identity := suppressionType + "\x00" + strings.ToLower(strings.TrimSpace(suppression.Email)) + "\x00" + strconv.FormatInt(suppression.Created, 10) + "\x00" + suppression.Reason + "\x00" + suppression.Status
				if _, duplicate := seen[identity]; duplicate {
					return nil, fmt.Errorf("customerio %s ESP suppressions returned a duplicate record: %w", suppressionType, adapter.ErrSourceUnavailable)
				}
				seen[identity] = struct{}{}
				out = append(out, *suppression)
			}
			if len(out) > maxMembershipEvidence {
				return nil, fmt.Errorf("customerio ESP suppressions exceed the safety bound: %w", adapter.ErrSourceUnavailable)
			}
			if len(suppressions) < suppressionPageSize {
				break
			}
			offset += len(suppressions)
			if page == maxTraversalPages-1 {
				return nil, fmt.Errorf("customerio %s ESP suppressions exceeded %d pages: %w", suppressionType, maxTraversalPages, adapter.ErrSourceUnavailable)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		left := out[i].Type + "\x00" + strings.ToLower(out[i].Email) + "\x00" + strconv.FormatInt(out[i].Created, 10)
		right := out[j].Type + "\x00" + strings.ToLower(out[j].Email) + "\x00" + strconv.FormatInt(out[j].Created, 10)
		return left < right
	})
	return out, nil
}

func (a *Adapter) listCampaigns(ctx context.Context, sess adapter.Session) ([]cioWorkflowEvidence, error) {
	resources, err := a.listRawCollection(ctx, sess, "/v1/campaigns", "campaigns", "campaign")
	if err != nil {
		return nil, err
	}
	out := make([]cioWorkflowEvidence, 0, len(resources))
	for _, resource := range resources {
		actions, actionErr := a.listCampaignActions(ctx, sess, resource.ID)
		if actionErr != nil {
			return nil, actionErr
		}
		out = append(out, cioWorkflowEvidence{Resource: resource, Actions: actions})
	}
	return out, nil
}

func (a *Adapter) listCampaignActions(ctx context.Context, sess adapter.Session, campaignID string) ([]cioResource, error) {
	cursor := ""
	seenCursors, seenIDs := map[string]struct{}{}, map[string]struct{}{}
	var out []cioResource
	for page := 0; page < maxTraversalPages; page++ {
		query := url.Values{}
		if cursor != "" {
			query.Set("start", cursor)
		}
		path := "/v1/campaigns/" + url.PathEscape(campaignID) + "/actions"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		var response struct {
			Actions *[]json.RawMessage `json:"actions"`
			Next    string             `json:"next"`
		}
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, fmt.Errorf("customerio list campaign %q actions: %w", campaignID, err)
		}
		actionsPage, collectionErr := requireCollection(response.Actions, "campaign actions")
		if collectionErr != nil {
			return nil, collectionErr
		}
		if len(actionsPage) > 100 {
			return nil, fmt.Errorf("customerio campaign %q returned an implausibly large action page: %w", campaignID, adapter.ErrSourceUnavailable)
		}
		for _, raw := range actionsPage {
			action, err := parseResource(raw, "campaign action")
			if err != nil {
				return nil, err
			}
			if parent := sourceScalarString(action.Raw["campaign_id"]); parent != "" && parent != campaignID {
				return nil, fmt.Errorf("customerio campaign %q action %q returned mismatched campaign_id: %w", campaignID, action.ID, adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenIDs[action.ID]; duplicate {
				return nil, fmt.Errorf("customerio campaign %q returned duplicate action %q: %w", campaignID, action.ID, adapter.ErrSourceUnavailable)
			}
			seenIDs[action.ID] = struct{}{}
			out = append(out, action)
		}
		next, nextErr := validateProviderCursor(response.Next, cursor, seenCursors, "campaign actions")
		if nextErr != nil {
			return nil, nextErr
		}
		if next == "" {
			sortResources(out)
			return out, nil
		}
		if len(actionsPage) == 0 {
			return nil, fmt.Errorf("customerio campaign %q returned an empty non-terminal action page: %w", campaignID, adapter.ErrSourceUnavailable)
		}
		cursor = next
	}
	return nil, fmt.Errorf("customerio campaign %q actions exceeded %d pages: %w", campaignID, maxTraversalPages, adapter.ErrSourceUnavailable)
}

func (a *Adapter) listBroadcasts(ctx context.Context, sess adapter.Session) ([]cioWorkflowEvidence, error) {
	resources, err := a.listRawCollection(ctx, sess, "/v1/broadcasts", "broadcasts", "broadcast")
	if err != nil {
		return nil, err
	}
	out := make([]cioWorkflowEvidence, 0, len(resources))
	for _, resource := range resources {
		var response struct {
			Actions *[]json.RawMessage `json:"actions"`
		}
		path := "/v1/broadcasts/" + url.PathEscape(resource.ID) + "/actions"
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, fmt.Errorf("customerio list broadcast %q actions: %w", resource.ID, err)
		}
		actionRows, collectionErr := requireCollection(response.Actions, "broadcast actions")
		if collectionErr != nil {
			return nil, collectionErr
		}
		if len(actionRows) > maxUnpagedResources {
			return nil, fmt.Errorf("customerio broadcast %q actions exceed the safety bound: %w", resource.ID, adapter.ErrSourceUnavailable)
		}
		actions := make([]cioResource, 0, len(actionRows))
		seen := map[string]struct{}{}
		for _, raw := range actionRows {
			action, parseErr := parseResource(raw, "broadcast action")
			if parseErr != nil {
				return nil, parseErr
			}
			if parent := sourceScalarString(action.Raw["broadcast_id"]); parent != "" && parent != resource.ID {
				return nil, fmt.Errorf("customerio broadcast %q action %q returned mismatched broadcast_id: %w", resource.ID, action.ID, adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seen[action.ID]; duplicate {
				return nil, fmt.Errorf("customerio broadcast %q returned duplicate action %q: %w", resource.ID, action.ID, adapter.ErrSourceUnavailable)
			}
			seen[action.ID] = struct{}{}
			actions = append(actions, action)
		}
		sortResources(actions)
		triggers, triggerErr := a.listBroadcastTriggers(ctx, sess, resource.ID)
		if triggerErr != nil {
			return nil, triggerErr
		}
		out = append(out, cioWorkflowEvidence{Resource: resource, Actions: actions, Triggers: triggers})
	}
	return out, nil
}

func (a *Adapter) listBroadcastTriggers(ctx context.Context, sess adapter.Session, broadcastID string) ([]cioResource, error) {
	var response struct {
		Triggers *[]json.RawMessage `json:"triggers"`
	}
	path := "/v1/broadcasts/" + url.PathEscape(broadcastID) + "/triggers"
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, fmt.Errorf("customerio list broadcast %q triggers: %w", broadcastID, err)
	}
	triggerRows, err := requireCollection(response.Triggers, "broadcast triggers")
	if err != nil {
		return nil, err
	}
	triggers, err := parseChildResources(triggerRows, "broadcast trigger", "broadcast_id", broadcastID)
	if err != nil {
		return nil, err
	}
	return triggers, nil
}

func (a *Adapter) listNewsletters(ctx context.Context, sess adapter.Session) ([]cioNewsletterEvidence, error) {
	queryBase := url.Values{"limit": {strconv.Itoa(newsletterPageSize)}, "sort": {"asc"}}
	resources, err := a.listCursorRawCollection(ctx, sess, "/v1/newsletters", "newsletters", "newsletter", queryBase, newsletterPageSize)
	if err != nil {
		return nil, err
	}
	out := make([]cioNewsletterEvidence, 0, len(resources))
	for _, resource := range resources {
		if err := validateNewsletterResource(resource, "newsletter"); err != nil {
			return nil, err
		}
		var response struct {
			Contents *[]json.RawMessage `json:"contents"`
		}
		path := "/v1/newsletters/" + url.PathEscape(resource.ID) + "/contents"
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, fmt.Errorf("customerio list newsletter %q variants: %w", resource.ID, err)
		}
		contentRows, collectionErr := requireCollection(response.Contents, "newsletter contents")
		if collectionErr != nil {
			return nil, collectionErr
		}
		if len(contentRows) > maxUnpagedResources {
			return nil, fmt.Errorf("customerio newsletter %q variants exceed the safety bound: %w", resource.ID, adapter.ErrSourceUnavailable)
		}
		contents, parseErr := parseChildResources(contentRows, "newsletter content", "newsletter_id", resource.ID)
		if parseErr != nil {
			return nil, parseErr
		}
		for _, content := range contents {
			if err := validateNewsletterContentResource(content, resource.ID); err != nil {
				return nil, err
			}
		}
		out = append(out, cioNewsletterEvidence{Resource: resource, Contents: contents})
	}
	return out, nil
}

func validateNewsletterResource(resource cioResource, label string) error {
	if err := validateNewsletterChannelType(resource, label); err != nil {
		return err
	}
	rawSentAt, present := resource.Raw["sent_at"]
	if !present {
		return fmt.Errorf("customerio %s %q omitted sent_at: %w", label, resource.ID, adapter.ErrSourceUnavailable)
	}
	if rawSentAt == nil {
		if resource.SentAt != 0 {
			return fmt.Errorf("customerio %s %q returned contradictory sent_at metadata: %w", label, resource.ID, adapter.ErrSourceUnavailable)
		}
		return nil
	}
	number, ok := rawSentAt.(json.Number)
	if !ok {
		return fmt.Errorf("customerio %s %q returned non-integer sent_at: %w", label, resource.ID, adapter.ErrSourceUnavailable)
	}
	sentAt, err := number.Int64()
	if err != nil || sentAt <= 0 || resource.SentAt != sentAt {
		return fmt.Errorf("customerio %s %q returned invalid sent_at: %w", label, resource.ID, adapter.ErrSourceUnavailable)
	}
	return nil
}

func validateNewsletterContentResource(resource cioResource, newsletterID string) error {
	return validateNewsletterChannelType(resource, "newsletter "+newsletterID+" content")
}

func validateNewsletterChannelType(resource cioResource, label string) error {
	rawType, present := resource.Raw["type"]
	channelType, ok := rawType.(string)
	if !present || !ok || channelType == "" || strings.TrimSpace(channelType) != channelType || resource.Type != channelType {
		return fmt.Errorf("customerio %s %q returned invalid channel type: %w", label, resource.ID, adapter.ErrSourceUnavailable)
	}
	switch channelType {
	case "email", "webhook", "twilio", "push", "in_app", "inbox":
		return nil
	default:
		return fmt.Errorf("customerio %s %q returned unsupported channel type %q: %w", label, resource.ID, channelType, adapter.ErrSourceUnavailable)
	}
}

func (a *Adapter) listTransactional(ctx context.Context, sess adapter.Session) ([]cioTransactionalEvidence, error) {
	resources, err := a.listRawCollection(ctx, sess, "/v1/transactional", "messages", "transactional message")
	if err != nil {
		return nil, err
	}
	out := make([]cioTransactionalEvidence, 0, len(resources))
	for _, resource := range resources {
		var response struct {
			Contents *[]json.RawMessage `json:"contents"`
		}
		path := "/v1/transactional/" + url.PathEscape(resource.ID) + "/contents"
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, fmt.Errorf("customerio list transactional message %q variants: %w", resource.ID, err)
		}
		contentRows, collectionErr := requireCollection(response.Contents, "transactional contents")
		if collectionErr != nil {
			return nil, collectionErr
		}
		contents, parseErr := parseChildResources(contentRows, "transactional content", "transactional_id", resource.ID)
		if parseErr != nil {
			return nil, parseErr
		}
		out = append(out, cioTransactionalEvidence{Resource: resource, Contents: contents})
	}
	return out, nil
}

func (a *Adapter) listDesignEmails(ctx context.Context, sess adapter.Session) ([]cioDesignEmailEvidence, error) {
	var summaries []cioResource
	seen := map[string]struct{}{}
	expectedTotal := -1
	for page := 1; page <= maxTraversalPages; page++ {
		query := url.Values{
			"page":        {strconv.Itoa(page)},
			"limit":       {strconv.Itoa(designEmailPageSize)},
			"is_template": {"true"},
			"sort_by":     {"created"},
			"sort_order":  {"asc"},
		}
		var response struct {
			Emails *[]json.RawMessage `json:"emails"`
			Meta   struct {
				Pagination struct {
					Page  int `json:"page"`
					Limit int `json:"limit"`
					Total int `json:"total"`
				} `json:"pagination"`
			} `json:"meta"`
		}
		if err := a.do(ctx, sess, http.MethodGet, "/v1/design_studio/emails?"+query.Encode(), nil, &response); err != nil {
			return nil, fmt.Errorf("customerio list Design Studio templates: %w", err)
		}
		emailRows, collectionErr := requireCollection(response.Emails, "Design Studio emails")
		if collectionErr != nil {
			return nil, collectionErr
		}
		if response.Meta.Pagination.Page != page || response.Meta.Pagination.Limit != designEmailPageSize || response.Meta.Pagination.Total < 0 {
			return nil, fmt.Errorf("customerio Design Studio returned invalid pagination metadata: %w", adapter.ErrSourceUnavailable)
		}
		if expectedTotal < 0 {
			expectedTotal = response.Meta.Pagination.Total
		} else if response.Meta.Pagination.Total != expectedTotal {
			return nil, fmt.Errorf("customerio Design Studio template total changed during pagination: %w", adapter.ErrSourceUnavailable)
		}
		if response.Meta.Pagination.Total > maxUnpagedResources || len(emailRows) > designEmailPageSize {
			return nil, fmt.Errorf("customerio Design Studio templates exceed the safety bound: %w", adapter.ErrSourceUnavailable)
		}
		for _, raw := range emailRows {
			resource, err := parseResource(raw, "Design Studio email")
			if err != nil {
				return nil, err
			}
			isTemplate, present := sourceBool(resource.Raw, "is_template")
			if !present || !isTemplate {
				return nil, fmt.Errorf("customerio Design Studio template filter returned a non-template %q: %w", resource.ID, adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seen[resource.ID]; duplicate {
				return nil, fmt.Errorf("customerio Design Studio returned duplicate template %q: %w", resource.ID, adapter.ErrSourceUnavailable)
			}
			seen[resource.ID] = struct{}{}
			summaries = append(summaries, resource)
		}
		if len(summaries) > response.Meta.Pagination.Total {
			return nil, fmt.Errorf("customerio Design Studio returned more templates than its total: %w", adapter.ErrSourceUnavailable)
		}
		if len(summaries) == response.Meta.Pagination.Total {
			break
		}
		if len(emailRows) == 0 {
			return nil, fmt.Errorf("customerio Design Studio returned an empty non-terminal page: %w", adapter.ErrSourceUnavailable)
		}
		if page == maxTraversalPages {
			return nil, fmt.Errorf("customerio Design Studio exceeded %d pages: %w", maxTraversalPages, adapter.ErrSourceUnavailable)
		}
	}
	sortResources(summaries)
	out := make([]cioDesignEmailEvidence, 0, len(summaries))
	for _, summary := range summaries {
		var response struct {
			Email json.RawMessage `json:"email"`
		}
		path := "/v1/design_studio/emails/" + url.PathEscape(summary.ID)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, fmt.Errorf("customerio hydrate Design Studio template %q: %w", summary.ID, err)
		}
		detail, err := parseResource(response.Email, "Design Studio email detail")
		if err != nil {
			return nil, err
		}
		if detail.ID != summary.ID {
			return nil, fmt.Errorf("customerio Design Studio template %q returned mismatched detail identity: %w", summary.ID, adapter.ErrSourceUnavailable)
		}
		isTemplate, present := sourceBool(detail.Raw, "is_template")
		if !present || !isTemplate {
			return nil, fmt.Errorf("customerio Design Studio detail %q is not a reusable template: %w", summary.ID, adapter.ErrSourceUnavailable)
		}
		languages, err := parseDesignEmailLanguages(detail.Raw)
		if err != nil {
			return nil, fmt.Errorf("customerio Design Studio template %q returned invalid language metadata: %w", summary.ID, err)
		}
		var translations []map[string]interface{}
		for _, language := range languages {
			var translation map[string]interface{}
			translationPath := "/v1/design_studio/emails/" + url.PathEscape(summary.ID) + "/languages/" + url.PathEscape(language)
			if err := a.do(ctx, sess, http.MethodGet, translationPath, nil, &translation); err != nil {
				return nil, fmt.Errorf("customerio hydrate Design Studio template %q language %q: %w", summary.ID, language, err)
			}
			if err := validateDesignEmailTranslation(translation, summary.ID, language); err != nil {
				return nil, fmt.Errorf("customerio Design Studio template %q language %q returned invalid translation evidence: %w", summary.ID, language, err)
			}
			translations = append(translations, map[string]interface{}{"language": language, "response": translation})
		}
		out = append(out, cioDesignEmailEvidence{Summary: summary, Detail: detail, Translations: translations})
	}
	return out, nil
}

func parseDesignEmailLanguages(payload map[string]interface{}) ([]string, error) {
	raw, exists := payload["available_languages"]
	if !exists {
		return nil, fmt.Errorf("available_languages is missing: %w", adapter.ErrSourceUnavailable)
	}
	values, ok := raw.([]interface{})
	if !ok {
		return nil, fmt.Errorf("available_languages is not an array: %w", adapter.ErrSourceUnavailable)
	}
	languages := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		language, ok := value.(string)
		if !ok || language == "" || strings.TrimSpace(language) != language || len(language) > 64 {
			return nil, fmt.Errorf("available_languages contains an invalid language code: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[language]; duplicate {
			return nil, fmt.Errorf("available_languages contains duplicate language %q: %w", language, adapter.ErrSourceUnavailable)
		}
		seen[language] = struct{}{}
		languages = append(languages, language)
	}
	sort.Strings(languages)
	return languages, nil
}

func validateDesignEmailTranslation(response map[string]interface{}, expectedID, expectedLanguage string) error {
	translation, ok := response["email_translation"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("email_translation envelope is missing: %w", adapter.ErrSourceUnavailable)
	}
	if parentID := sourceString(translation, "language_group_id"); parentID != expectedID {
		return fmt.Errorf("language_group_id %q does not match parent %q: %w", parentID, expectedID, adapter.ErrSourceUnavailable)
	}
	if language := sourceString(translation, "language"); language != expectedLanguage {
		return fmt.Errorf("language %q does not match requested language %q: %w", language, expectedLanguage, adapter.ErrSourceUnavailable)
	}
	if isTemplate, present := sourceBool(translation, "is_template"); !present || !isTemplate {
		return fmt.Errorf("translation is not identified as reusable template content: %w", adapter.ErrSourceUnavailable)
	}
	if _, ok := translation["content"].(map[string]interface{}); !ok {
		return fmt.Errorf("translation content is missing: %w", adapter.ErrSourceUnavailable)
	}
	return nil
}

func (a *Adapter) listObjectTypes(ctx context.Context, sess adapter.Session) ([]cioResource, error) {
	return a.listRawCollection(ctx, sess, "/v1/object_types", "types", "object type")
}

func (a *Adapter) listOptouts(ctx context.Context, sess adapter.Session) ([]cioChannelOptout, error) {
	cursor := ""
	seenCursors, seenProfiles := map[string]struct{}{}, map[string]struct{}{}
	var out []cioChannelOptout
	for page := 0; page < maxTraversalPages; page++ {
		query := url.Values{"limit": {strconv.Itoa(optoutPageSize)}}
		if cursor != "" {
			query.Set("start", cursor)
		}
		var response cioOptoutPage
		if err := a.do(ctx, sess, http.MethodGet, "/v1/optouts?"+query.Encode(), nil, &response); err != nil {
			return nil, fmt.Errorf("customerio list SMS/WhatsApp opt-outs: %w", err)
		}
		optouts, collectionErr := requireCollection(response.Optouts, "channel opt-outs")
		if collectionErr != nil {
			return nil, collectionErr
		}
		if len(optouts) > optoutPageSize {
			return nil, fmt.Errorf("customerio channel opt-outs exceeded the requested page size: %w", adapter.ErrSourceUnavailable)
		}
		for _, item := range optouts {
			cioID := strings.TrimSpace(string(item.CIOID))
			if !validProviderID(cioID) || len(item.Optouts) == 0 {
				return nil, fmt.Errorf("customerio channel opt-outs returned an incomplete record: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenProfiles[cioID]; duplicate {
				return nil, fmt.Errorf("customerio channel opt-outs returned duplicate cio_id %q: %w", cioID, adapter.ErrSourceUnavailable)
			}
			seenProfiles[cioID] = struct{}{}
			item.CIOID = flexibleString(cioID)
			item.CustomerID = flexibleString(strings.TrimSpace(string(item.CustomerID)))
			seenSenders := map[string]struct{}{}
			for index := range item.Optouts {
				optout := &item.Optouts[index]
				channel := strings.ToLower(strings.TrimSpace(optout.Channel))
				from := strings.TrimSpace(optout.From)
				if (channel != "sms" && channel != "whatsapp") || from == "" || len(from) > 256 {
					return nil, fmt.Errorf("customerio channel opt-outs returned an invalid sender record for cio_id %q: %w", cioID, adapter.ErrSourceUnavailable)
				}
				identity := channel + "\x00" + from
				if _, duplicate := seenSenders[identity]; duplicate {
					return nil, fmt.Errorf("customerio channel opt-outs returned duplicate sender state for cio_id %q: %w", cioID, adapter.ErrSourceUnavailable)
				}
				seenSenders[identity] = struct{}{}
				optout.Channel = channel
				optout.From = from
			}
			sort.Slice(item.Optouts, func(i, j int) bool {
				left := item.Optouts[i].Channel + "\x00" + item.Optouts[i].From
				right := item.Optouts[j].Channel + "\x00" + item.Optouts[j].From
				return left < right
			})
			out = append(out, item)
		}
		if len(out) > maxMembershipEvidence {
			return nil, fmt.Errorf("customerio channel opt-outs exceed the safety bound: %w", adapter.ErrSourceUnavailable)
		}
		next, nextErr := validateProviderCursor(response.Next, cursor, seenCursors, "channel opt-outs")
		if nextErr != nil {
			return nil, nextErr
		}
		if next == "" {
			sort.Slice(out, func(i, j int) bool {
				return string(out[i].CIOID) < string(out[j].CIOID)
			})
			return out, nil
		}
		if len(optouts) == 0 {
			return nil, fmt.Errorf("customerio channel opt-outs returned an empty non-terminal page: %w", adapter.ErrSourceUnavailable)
		}
		cursor = next
	}
	return nil, fmt.Errorf("customerio channel opt-outs exceeded %d pages: %w", maxTraversalPages, adapter.ErrSourceUnavailable)
}

func (a *Adapter) listRawCollection(ctx context.Context, sess adapter.Session, path, key, label string) ([]cioResource, error) {
	var response map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, fmt.Errorf("customerio list %s: %w", label, err)
	}
	rows, err := decodeRequiredRawCollection(response, key, label)
	if err != nil {
		return nil, err
	}
	return parseUniqueResources(rows, label)
}

func (a *Adapter) listCursorRawCollection(ctx context.Context, sess adapter.Session, path, key, label string, baseQuery url.Values, pageSize int) ([]cioResource, error) {
	cursor := ""
	seenCursors, seenIDs := map[string]struct{}{}, map[string]struct{}{}
	var out []cioResource
	for page := 0; page < maxTraversalPages; page++ {
		query := cloneValues(baseQuery)
		if cursor != "" {
			query.Set("start", cursor)
		}
		var response map[string]json.RawMessage
		if err := a.do(ctx, sess, http.MethodGet, path+"?"+query.Encode(), nil, &response); err != nil {
			return nil, fmt.Errorf("customerio list %s: %w", label, err)
		}
		rows, collectionErr := decodeRequiredRawCollection(response, key, label)
		if collectionErr != nil {
			return nil, collectionErr
		}
		if len(rows) > pageSize {
			return nil, fmt.Errorf("customerio %s exceeded the requested page size: %w", label, adapter.ErrSourceUnavailable)
		}
		for _, raw := range rows {
			resource, err := parseResource(raw, label)
			if err != nil {
				return nil, err
			}
			if _, duplicate := seenIDs[resource.ID]; duplicate {
				return nil, fmt.Errorf("customerio %s returned duplicate identity %q across pages: %w", label, resource.ID, adapter.ErrSourceUnavailable)
			}
			seenIDs[resource.ID] = struct{}{}
			out = append(out, resource)
			if len(out) > maxUnpagedResources {
				return nil, fmt.Errorf("customerio %s exceed the safety bound: %w", label, adapter.ErrSourceUnavailable)
			}
		}
		next, cursorErr := decodeOptionalProviderCursor(response, "next", label)
		if cursorErr != nil {
			return nil, cursorErr
		}
		next, nextErr := validateProviderCursor(next, cursor, seenCursors, label)
		if nextErr != nil {
			return nil, nextErr
		}
		if next == "" {
			sortResources(out)
			return out, nil
		}
		if len(rows) == 0 {
			return nil, fmt.Errorf("customerio %s returned an empty non-terminal page: %w", label, adapter.ErrSourceUnavailable)
		}
		cursor = next
	}
	return nil, fmt.Errorf("customerio %s exceeded %d pages: %w", label, maxTraversalPages, adapter.ErrSourceUnavailable)
}

func decodeRequiredRawCollection(response map[string]json.RawMessage, key, label string) ([]json.RawMessage, error) {
	raw, present := response[key]
	if !present || len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("customerio %s response omitted or nullified required %s collection: %w", label, key, adapter.ErrSourceUnavailable)
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("customerio list %s returned an invalid %s collection: %w", label, key, adapter.ErrSourceUnavailable)
	}
	return rows, nil
}

func decodeOptionalProviderCursor(response map[string]json.RawMessage, key, label string) (string, error) {
	raw, present := response[key]
	if !present {
		return "", nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", fmt.Errorf("customerio %s returned an invalid %s cursor: %w", label, key, adapter.ErrSourceUnavailable)
	}
	var cursor string
	if err := json.Unmarshal(trimmed, &cursor); err != nil {
		return "", fmt.Errorf("customerio %s returned a non-string %s cursor: %w", label, key, adapter.ErrSourceUnavailable)
	}
	return cursor, nil
}

func parseUniqueResources(rows []json.RawMessage, label string) ([]cioResource, error) {
	if len(rows) > maxUnpagedResources {
		return nil, fmt.Errorf("customerio %s exceed the %d-resource safety bound: %w", label, maxUnpagedResources, adapter.ErrSourceUnavailable)
	}
	out := make([]cioResource, 0, len(rows))
	seen := map[string]struct{}{}
	for _, raw := range rows {
		resource, err := parseResource(raw, label)
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[resource.ID]; duplicate {
			return nil, fmt.Errorf("customerio %s returned duplicate identity %q: %w", label, resource.ID, adapter.ErrSourceUnavailable)
		}
		seen[resource.ID] = struct{}{}
		out = append(out, resource)
	}
	sortResources(out)
	return out, nil
}

func parseChildResources(rows []json.RawMessage, label, parentKey, parentID string) ([]cioResource, error) {
	resources, err := parseUniqueResources(rows, label)
	if err != nil {
		return nil, err
	}
	for _, resource := range resources {
		if parent := sourceScalarString(resource.Raw[parentKey]); parent != "" && parent != parentID {
			return nil, fmt.Errorf("customerio %s %q returned mismatched %s: %w", label, resource.ID, parentKey, adapter.ErrSourceUnavailable)
		}
	}
	return resources, nil
}

func validateProviderCursor(next, current string, seen map[string]struct{}, label string) (string, error) {
	next = strings.TrimSpace(next)
	if len(next) > maxProviderCursorBytes {
		return "", fmt.Errorf("customerio %s cursor exceeds %d bytes: %w", label, maxProviderCursorBytes, adapter.ErrSourceUnavailable)
	}
	if next == "" {
		return "", nil
	}
	if next == current {
		return "", fmt.Errorf("customerio %s returned a repeated cursor: %w", label, adapter.ErrSourceUnavailable)
	}
	if _, duplicate := seen[next]; duplicate {
		return "", fmt.Errorf("customerio %s returned a cursor cycle: %w", label, adapter.ErrSourceUnavailable)
	}
	seen[next] = struct{}{}
	return next, nil
}

func snapshotFingerprint(snapshot *customerIOSnapshot) (string, error) {
	evidence := struct {
		Subscribers                        []canonical.Subscriber
		ProfilesWithoutEmail               int
		ProfilesWithoutEmailIdentityDigest string
		Segments                           []cioSegment
		Topics                             []cioSubscriptionTopic
		Memberships                        map[string]int
		CampaignArchive                    []canonical.CampaignArchive
		Templates                          []canonical.EmailTemplate
		SourceArchive                      []canonical.SourceArchiveItem
		SMSNewsletters                     int
		PushNewsletters                    int
	}{
		Subscribers:                        snapshot.Subscribers,
		ProfilesWithoutEmail:               snapshot.ProfilesWithoutEmail,
		ProfilesWithoutEmailIdentityDigest: snapshot.ProfilesWithoutEmailIdentityDigest,
		Segments:                           snapshot.Segments,
		Topics:                             snapshot.Topics,
		Memberships:                        snapshot.MembershipCounts,
		CampaignArchive:                    snapshot.CampaignArchive,
		Templates:                          snapshot.Templates,
		SourceArchive:                      snapshot.SourceArchive,
		SMSNewsletters:                     snapshot.SMSNewsletters,
		PushNewsletters:                    snapshot.PushNewsletters,
	}
	raw, err := json.Marshal(evidence)
	if err != nil {
		return "", fmt.Errorf("customerio snapshot fingerprint: %w", err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func nonEmailProfileIdentityDigest(ids map[string]struct{}) string {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte("postwave-customerio-non-email-identities-v1\x00"))
	for _, id := range sortedMapKeys(ids) {
		record := sha256.Sum256([]byte("cio_id\x00" + id))
		_, _ = hasher.Write(record[:])
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func encodeSnapshotCursor(fingerprint, resource string, offset int) string {
	return "v1." + resource + "." + fingerprint + "." + strconv.Itoa(offset)
}

func decodeSnapshotCursor(cursor, fingerprint, resource string, total, pageSize int) (int, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return 0, nil
	}
	if len(cursor) > maxProviderCursorBytes {
		return 0, fmt.Errorf("customerio %s cursor is too large: %w", resource, adapter.ErrSourceUnavailable)
	}
	parts := strings.Split(cursor, ".")
	if len(parts) != 4 || parts[0] != "v1" || parts[1] != resource || parts[2] != fingerprint {
		return 0, fmt.Errorf("customerio %s cursor does not match the discovery snapshot: %w", resource, adapter.ErrSourceUnavailable)
	}
	offset, err := strconv.Atoi(parts[3])
	if err != nil || pageSize <= 0 || offset <= 0 || offset >= total || offset%pageSize != 0 {
		return 0, fmt.Errorf("customerio %s cursor has an invalid offset: %w", resource, adapter.ErrSourceUnavailable)
	}
	return offset, nil
}

func sortedMapKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortResources(resources []cioResource) {
	sort.Slice(resources, func(i, j int) bool { return resources[i].ID < resources[j].ID })
}

func customerDetailEmail(detail cioCustomerDetail) string {
	if detail.Identifiers.Email != nil && strings.TrimSpace(*detail.Identifiers.Email) != "" {
		return strings.TrimSpace(*detail.Identifiers.Email)
	}
	return strings.TrimSpace(rawAttributeString(detail.Attributes["email"]))
}

func cloneValues(in url.Values) url.Values {
	out := make(url.Values, len(in))
	for key, values := range in {
		out[key] = append([]string(nil), values...)
	}
	return out
}
