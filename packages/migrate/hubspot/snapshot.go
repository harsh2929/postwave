// SPDX-License-Identifier: MIT

package hubspot

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	hubSpotAPIVersion          = "2026-03"
	hubSpotMaxSnapshotContacts = 1_000_000
	hubSpotMaxTraversalPages   = 10_000
	hubSpotPropertyChunkSize   = 100
	hubSpotListSearchPageSize  = 500
	hubSpotSnapshotPageSize    = 100
	hubSpotCursorVersion       = 1
	hubSpotDailyReserveFloor   = int64(1_000)
	hubSpotDailyReserveDivisor = int64(20) // five percent
)

type hubSpotSnapshot struct {
	Subscribers               []canonical.Subscriber
	ProfilesWithoutEmailIDs   []string
	ContactProperties         map[string]hsProperty
	Lists                     []hsList
	SubscriptionDefinitions   []hsSubscriptionDefinition
	Segments                  []canonical.Segment
	MembershipCounts          map[string]int
	CustomFields              []string
	Warnings                  []string
	AdditionalEmailIdentities int
	AdditionalEmailDigest     string
	NonEmailIdentityDigest    string
	ContactPropertiesDigest   string
	Fingerprint               string
}

// SourceFingerprintEvidence provides exact, non-reversible inventory
// components that cannot be reconstructed from canonical email subscribers.
// The migration service combines these with independently traversed subscriber
// and segment components.
type SourceFingerprintEvidence struct {
	ProfilesWithoutEmailCount  int
	ProfilesWithoutEmailDigest string
	ContactPropertiesCount     int
	ContactPropertiesDigest    string
	AdditionalEmailCount       int
	AdditionalEmailDigest      string
}

type hsStrictObjectPage struct {
	Results *[]hsObject `json:"results"`
	Paging  *struct {
		Next *struct {
			After string `json:"after"`
			Link  string `json:"link"`
		} `json:"next"`
	} `json:"paging"`
}

type hsStrictSearchPage struct {
	Results *[]hsObject `json:"results"`
	Total   *int        `json:"total"`
	Paging  *struct {
		Next *struct {
			After string `json:"after"`
			Link  string `json:"link"`
		} `json:"next"`
	} `json:"paging"`
}

type hsBatchObjectResponse struct {
	Status    *string     `json:"status"`
	Results   *[]hsObject `json:"results"`
	Errors    []any       `json:"errors"`
	NumErrors *int        `json:"numErrors"`
}

type hsStrictListsResponse struct {
	HasMore *bool     `json:"hasMore"`
	Lists   *[]hsList `json:"lists"`
	Offset  *int      `json:"offset"`
	Total   *int      `json:"total"`
}

type hsStrictMembershipResponse struct {
	Status    *string                `json:"status"`
	Results   *[]hsRecordMemberships `json:"results"`
	Errors    []any                  `json:"errors"`
	NumErrors *int                   `json:"numErrors"`
}

type hsSubscriptionDefinition struct {
	BusinessUnitID      int64  `json:"businessUnitId"`
	ID                  any    `json:"id"`
	Name                string `json:"name"`
	Description         string `json:"description"`
	Purpose             string `json:"purpose"`
	CommunicationMethod string `json:"communicationMethod"`
	IsActive            *bool  `json:"isActive"`
	IsDefault           *bool  `json:"isDefault"`
	IsInternal          *bool  `json:"isInternal"`
	CreatedAt           string `json:"createdAt"`
	UpdatedAt           string `json:"updatedAt"`
}

func (d hsSubscriptionDefinition) sourceID() string {
	return strings.TrimSpace(stringFromAny(d.ID))
}

func (d hsSubscriptionDefinition) key() string {
	return fmt.Sprintf("%d:%s", d.BusinessUnitID, d.sourceID())
}

type hsSubscriptionStatus struct {
	BusinessUnitID         int64  `json:"businessUnitId"`
	Channel                string `json:"channel"`
	SubscriberID           string `json:"subscriberIdString"`
	SubscriptionID         any    `json:"subscriptionId"`
	Status                 string `json:"status"`
	Source                 string `json:"source"`
	LegalBasis             any    `json:"legalBasis"`
	LegalBasisExplanation  any    `json:"legalBasisExplanation"`
	SetStatusSuccessReason any    `json:"setStatusSuccessReason"`
	Timestamp              string `json:"timestamp"`
}

func (s hsSubscriptionStatus) key() string {
	return fmt.Sprintf("%d:%s", s.BusinessUnitID, strings.TrimSpace(stringFromAny(s.SubscriptionID)))
}

type hsWideSubscriptionStatus struct {
	BusinessUnitID int64  `json:"businessUnitId"`
	WideStatusType string `json:"wideStatusType"`
	SubscriberID   string `json:"subscriberIdString"`
	Status         string `json:"status"`
	Channel        string `json:"channel"`
	Timestamp      string `json:"timestamp"`
}

type hsSubscriptionDefinitionsResponse struct {
	Status    *string                     `json:"status"`
	Results   *[]hsSubscriptionDefinition `json:"results"`
	Errors    []any                       `json:"errors"`
	NumErrors *int                        `json:"numErrors"`
}

type hsSubscriptionStatusesResponse struct {
	Status    *string                 `json:"status"`
	Results   *[]hsSubscriptionStatus `json:"results"`
	Errors    []any                   `json:"errors"`
	NumErrors *int                    `json:"numErrors"`
}

type hsWideSubscriptionStatusesResponse struct {
	Status    *string                     `json:"status"`
	Results   *[]hsWideSubscriptionStatus `json:"results"`
	Errors    []any                       `json:"errors"`
	NumErrors *int                        `json:"numErrors"`
}

type hsDailyAPIUsage struct {
	Name         string `json:"name"`
	UsageLimit   *int64 `json:"usageLimit"`
	CurrentUsage *int64 `json:"currentUsage"`
	CollectedAt  string `json:"collectedAt"`
	FetchStatus  string `json:"fetchStatus"`
	ResetsAt     string `json:"resetsAt"`
}

type hsDailyAPIUsageResponse struct {
	Results *[]hsDailyAPIUsage `json:"results"`
}

type hubSpotSnapshotCursor struct {
	Version     int    `json:"version"`
	Fingerprint string `json:"fingerprint"`
	Resource    string `json:"resource"`
	Offset      int    `json:"offset"`
}

type hubSpotSnapshotByteBudget struct {
	limit int64
	used  int64
}

func (a *Adapter) newSnapshotByteBudget() *hubSpotSnapshotByteBudget {
	limit := a.snapshotByteLimit
	if limit <= 0 {
		limit = defaultSnapshotByteLimit
	}
	return &hubSpotSnapshotByteBudget{limit: limit}
}

func (b *hubSpotSnapshotByteBudget) add(label string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("hubspot encode %s for snapshot byte budget: %w: %w", label, adapter.ErrSourceUnavailable, err)
	}
	size := int64(len(raw))
	if size > b.limit-b.used {
		return fmt.Errorf("hubspot snapshot exceeded the %d-byte aggregate memory-safety bound while retaining %s: %w", b.limit, label, adapter.ErrSourceUnavailable)
	}
	b.used += size
	return nil
}

func (a *Adapter) ensureSnapshot(ctx context.Context, sess adapter.Session) (*hubSpotSnapshot, error) {
	if AccountFingerprint(sess) == "" || strings.TrimSpace(sess.AccessToken) == "" {
		return nil, fmt.Errorf("hubspot session is not bound to a verified portal: %w", adapter.ErrAuth)
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

func (a *Adapter) buildSnapshot(ctx context.Context, sess adapter.Session) (*hubSpotSnapshot, error) {
	properties, err := a.fetchContactProperties(ctx, sess)
	if err != nil {
		return nil, fmt.Errorf("hubspot contact property inventory: %w", err)
	}
	definitions, err := a.fetchSubscriptionDefinitions(ctx, sess)
	if err != nil {
		return nil, fmt.Errorf("hubspot subscription definition inventory: %w", err)
	}
	lists, err := a.fetchContactLists(ctx, sess)
	if err != nil {
		return nil, fmt.Errorf("hubspot list inventory: %w", err)
	}
	byteBudget := a.newSnapshotByteBudget()
	if err := byteBudget.add("contact schema, subscription definitions, and list metadata", struct {
		Properties  map[string]hsProperty
		Definitions []hsSubscriptionDefinition
		Lists       []hsList
	}{properties, definitions, lists}); err != nil {
		return nil, err
	}

	snapshot := &hubSpotSnapshot{
		ContactProperties:       properties,
		Lists:                   lists,
		SubscriptionDefinitions: definitions,
		MembershipCounts:        map[string]int{},
	}
	for _, list := range lists {
		snapshot.MembershipCounts["hubspot:list:"+list.sourceID()] = 0
	}
	for _, definition := range definitions {
		if definition.IsActive != nil && *definition.IsActive && hubSpotSubscriptionDefinitionIsEmail(definition) {
			snapshot.MembershipCounts[hubSpotSubscriptionTag(definition.BusinessUnitID, definition.sourceID())] = 0
		}
	}
	contacts, memberships, err := a.fetchAllContacts(ctx, sess, properties, byteBudget)
	if err != nil {
		return nil, err
	}
	if err := validateHubSpotMembershipSnapshot(lists, memberships); err != nil {
		return nil, err
	}

	customFields := map[string]struct{}{}
	var additionalEmailEvidence []string
	addressableContacts := make([]hsObject, 0, len(contacts))
	emailIdentityOwners := map[string]string{}
	for _, contact := range contacts {
		id := strings.TrimSpace(firstNonEmpty(contact.ID, contact.Properties["hs_object_id"]))
		aliases, normalizedAliases := hubspotAdditionalEmails(contact.Properties["hs_additional_emails"], contact.Properties["email"])
		snapshot.AdditionalEmailIdentities += len(aliases)
		for index := range aliases {
			if !validHubSpotEmail(normalizedAliases[index]) {
				return nil, fmt.Errorf("hubspot contact returned an invalid additional email identity: %w", adapter.ErrSourceUnavailable)
			}
			if owner, duplicate := emailIdentityOwners[normalizedAliases[index]]; duplicate && owner != id {
				return nil, fmt.Errorf("hubspot returned the same email identity for multiple contacts: %w", adapter.ErrSourceUnavailable)
			}
			emailIdentityOwners[normalizedAliases[index]] = id
			additionalEmailEvidence = append(
				additionalEmailEvidence,
				id+"\x00"+normalizedAliases[index]+"\x00"+aliases[index],
			)
		}
		email := strings.ToLower(strings.TrimSpace(contact.Properties["email"]))
		if !validHubSpotEmail(email) {
			snapshot.ProfilesWithoutEmailIDs = append(snapshot.ProfilesWithoutEmailIDs, id)
			continue
		}
		if owner, duplicate := emailIdentityOwners[email]; duplicate && owner != id {
			return nil, fmt.Errorf("hubspot returned the same email identity for multiple contacts: %w", adapter.ErrSourceUnavailable)
		}
		emailIdentityOwners[email] = id
		addressableContacts = append(addressableContacts, contact)
	}
	if err := a.ensureDailyRequestBudget(ctx, sess, int64(2*len(addressableContacts))); err != nil {
		return nil, fmt.Errorf("hubspot communication-preference API budget: %w", err)
	}
	for _, contact := range addressableContacts {
		id := strings.TrimSpace(firstNonEmpty(contact.ID, contact.Properties["hs_object_id"]))
		email := strings.ToLower(strings.TrimSpace(contact.Properties["email"]))
		statuses, wideStatuses, preferenceErr := a.fetchContactSubscriptionPreferences(ctx, sess, email, definitions)
		if preferenceErr != nil {
			return nil, fmt.Errorf("hubspot contact communication preferences: %w", preferenceErr)
		}
		sub := mapContactToCanonical(contact, properties)
		sub, preferenceErr = applyHubSpotPreferences(sub, statuses, wideStatuses, definitions)
		if preferenceErr != nil {
			return nil, fmt.Errorf("hubspot contact communication preferences: %w", preferenceErr)
		}
		sub = addHubSpotListTags(sub, memberships[id])
		for _, membership := range memberships[id] {
			listID := strings.TrimSpace(stringFromAny(membership.ListID))
			if listID != "" {
				snapshot.MembershipCounts["hubspot:list:"+listID]++
			}
		}
		for _, status := range statuses {
			if strings.EqualFold(status.Status, "SUBSCRIBED") && activeHubSpotEmailDefinition(definitions, status.key()) {
				snapshot.MembershipCounts[hubSpotSubscriptionTag(status.BusinessUnitID, stringFromAny(status.SubscriptionID))]++
			}
		}
		for key := range sub.CustomFields {
			customFields[key] = struct{}{}
		}
		if err := byteBudget.add("canonical subscriber", sub); err != nil {
			return nil, err
		}
		snapshot.Subscribers = append(snapshot.Subscribers, sub)
	}
	sort.Strings(snapshot.ProfilesWithoutEmailIDs)
	sort.Slice(snapshot.Subscribers, func(i, j int) bool {
		return snapshot.Subscribers[i].SourceID < snapshot.Subscribers[j].SourceID
	})
	for key := range customFields {
		snapshot.CustomFields = append(snapshot.CustomFields, key)
	}
	sort.Strings(snapshot.CustomFields)
	snapshot.Segments = buildHubSpotSegments(lists, definitions, snapshot.MembershipCounts)

	// Duplicate/non-email/alias/unknown-consent states are exact first-class
	// evidence elsewhere in the report. Discovery warnings are intentionally
	// reserved for actionable provider incompleteness because HubSpot pilot
	// acceptance treats them as blocking.

	snapshot.NonEmailIdentityDigest = digestStrings("hubspot-non-email-identities-v1", snapshot.ProfilesWithoutEmailIDs)
	sort.Strings(additionalEmailEvidence)
	snapshot.AdditionalEmailDigest = digestStrings("hubspot-additional-email-identities-v1", additionalEmailEvidence)
	snapshot.ContactPropertiesDigest, err = digestContactProperties(properties)
	if err != nil {
		return nil, err
	}
	snapshot.Fingerprint, err = digestHubSpotSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	return snapshot, nil
}

// SourceFingerprintEvidence returns the exact non-email/profile-schema
// components captured by the same immutable snapshot used for traversal.
func (a *Adapter) SourceFingerprintEvidence(ctx context.Context, sess adapter.Session) (SourceFingerprintEvidence, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return SourceFingerprintEvidence{}, err
	}
	return SourceFingerprintEvidence{
		ProfilesWithoutEmailCount:  len(snapshot.ProfilesWithoutEmailIDs),
		ProfilesWithoutEmailDigest: snapshot.NonEmailIdentityDigest,
		ContactPropertiesCount:     len(snapshot.ContactProperties),
		ContactPropertiesDigest:    snapshot.ContactPropertiesDigest,
		AdditionalEmailCount:       snapshot.AdditionalEmailIdentities,
		AdditionalEmailDigest:      snapshot.AdditionalEmailDigest,
	}, nil
}

func (a *Adapter) fetchContactProperties(ctx context.Context, sess adapter.Session) (map[string]hsProperty, error) {
	var response struct {
		Results *[]hsProperty `json:"results"`
	}
	path := "/crm/properties/" + hubSpotAPIVersion + "/contacts?archived=false&dataSensitivity=non_sensitive"
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, err
	}
	if response.Results == nil {
		return nil, fmt.Errorf("property response omitted required results: %w", adapter.ErrSourceUnavailable)
	}
	out := make(map[string]hsProperty, len(*response.Results))
	for _, property := range *response.Results {
		name := strings.TrimSpace(property.Name)
		if name == "" || len(name) > 512 {
			return nil, fmt.Errorf("property response contained an invalid internal name: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := out[name]; duplicate {
			return nil, fmt.Errorf("property response contained a duplicate internal name: %w", adapter.ErrSourceUnavailable)
		}
		property.Name = name
		out[name] = property
	}
	return out, nil
}

func (a *Adapter) fetchAllContacts(ctx context.Context, sess adapter.Session, properties map[string]hsProperty, byteBudget *hubSpotSnapshotByteBudget) ([]hsObject, map[string][]hsMembership, error) {
	propertyNames := allContactPropertyNames(properties)
	seenIDs := map[string]struct{}{}
	seenCursors := map[string]struct{}{}
	var contacts []hsObject
	memberships := map[string][]hsMembership{}
	cursor := ""
	for page := 0; page < hubSpotMaxTraversalPages; page++ {
		query := url.Values{
			"limit":      {strconv.Itoa(hubSpotSnapshotPageSize)},
			"archived":   {"false"},
			"properties": {strings.Join(coreContactPropertyNames(), ",")},
		}
		if cursor != "" {
			query.Set("after", cursor)
		}
		var response hsStrictObjectPage
		path := "/crm/objects/" + hubSpotAPIVersion + "/contacts?" + query.Encode()
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, nil, fmt.Errorf("hubspot contact page: %w", err)
		}
		if response.Results == nil {
			return nil, nil, fmt.Errorf("hubspot contact page omitted required results: %w", adapter.ErrSourceUnavailable)
		}
		rows := *response.Results
		if len(rows) > hubSpotSnapshotPageSize {
			return nil, nil, fmt.Errorf("hubspot contact page exceeded limit %d: %w", hubSpotSnapshotPageSize, adapter.ErrSourceUnavailable)
		}
		for _, row := range rows {
			id := strings.TrimSpace(firstNonEmpty(row.ID, row.Properties["hs_object_id"]))
			if !validHubSpotObjectID(id) {
				return nil, nil, fmt.Errorf("hubspot contact page returned invalid contact id: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenIDs[id]; duplicate {
				return nil, nil, fmt.Errorf("hubspot contact identity repeated across pages: %w", adapter.ErrSourceUnavailable)
			}
			seenIDs[id] = struct{}{}
		}
		hydrated, hydrateErr := a.hydrateContactProperties(ctx, sess, rows, propertyNames)
		if hydrateErr != nil {
			return nil, nil, hydrateErr
		}
		pageMemberships, membershipErr := a.fetchContactMemberships(ctx, sess, hydrated)
		if membershipErr != nil {
			return nil, nil, membershipErr
		}
		if err := byteBudget.add("hydrated source contacts", hydrated); err != nil {
			return nil, nil, err
		}
		if err := byteBudget.add("source list memberships", pageMemberships); err != nil {
			return nil, nil, err
		}
		for id, rows := range pageMemberships {
			memberships[id] = rows
		}
		contacts = append(contacts, hydrated...)
		if len(contacts) > hubSpotMaxSnapshotContacts {
			return nil, nil, fmt.Errorf("hubspot contact snapshot exceeds %d contacts: %w", hubSpotMaxSnapshotContacts, adapter.ErrSourceUnavailable)
		}

		next := ""
		if response.Paging != nil && response.Paging.Next != nil {
			next = strings.TrimSpace(response.Paging.Next.After)
			if next == "" {
				return nil, nil, fmt.Errorf("hubspot contact pagination omitted its next cursor: %w", adapter.ErrSourceUnavailable)
			}
		}
		if next == "" {
			return contacts, memberships, nil
		}
		if len(rows) == 0 {
			return nil, nil, fmt.Errorf("hubspot contact page was empty but returned a next cursor: %w", adapter.ErrSourceUnavailable)
		}
		if !validHubSpotPagingCursor(next) {
			return nil, nil, fmt.Errorf("hubspot contact pagination returned an invalid cursor: %w", adapter.ErrSourceUnavailable)
		}
		if cursor != "" {
			currentValue, _ := strconv.ParseUint(cursor, 10, 64)
			nextValue, _ := strconv.ParseUint(next, 10, 64)
			if nextValue <= currentValue {
				return nil, nil, fmt.Errorf("hubspot contact pagination returned a non-progressing cursor: %w", adapter.ErrSourceUnavailable)
			}
		}
		if _, duplicate := seenCursors[next]; duplicate {
			return nil, nil, fmt.Errorf("hubspot contact pagination cycled: %w", adapter.ErrSourceUnavailable)
		}
		seenCursors[next] = struct{}{}
		cursor = next
	}
	return nil, nil, fmt.Errorf("hubspot contact pagination exceeded %d pages: %w", hubSpotMaxTraversalPages, adapter.ErrSourceUnavailable)
}

func (a *Adapter) hydrateContactProperties(ctx context.Context, sess adapter.Session, contacts []hsObject, propertyNames []string) ([]hsObject, error) {
	if len(contacts) == 0 {
		return contacts, nil
	}
	byID := make(map[string]*hsObject, len(contacts))
	inputs := make([]map[string]string, 0, len(contacts))
	for index := range contacts {
		id := strings.TrimSpace(firstNonEmpty(contacts[index].ID, contacts[index].Properties["hs_object_id"]))
		if contacts[index].Properties == nil {
			contacts[index].Properties = map[string]string{}
		}
		byID[id] = &contacts[index]
		inputs = append(inputs, map[string]string{"id": id})
	}
	for start := 0; start < len(propertyNames); start += hubSpotPropertyChunkSize {
		end := start + hubSpotPropertyChunkSize
		if end > len(propertyNames) {
			end = len(propertyNames)
		}
		var response hsBatchObjectResponse
		body := map[string]any{
			"inputs":                inputs,
			"properties":            propertyNames[start:end],
			"propertiesWithHistory": []string{},
		}
		path := "/crm/objects/" + hubSpotAPIVersion + "/contacts/batch/read"
		if err := a.do(ctx, sess, http.MethodPost, path, body, &response); err != nil {
			return nil, fmt.Errorf("hubspot hydrate contact property chunk: %w", err)
		}
		if err := validateBatchStatus(response.Status, response.Errors, response.NumErrors, "contact property batch"); err != nil {
			return nil, err
		}
		if response.Results == nil {
			return nil, fmt.Errorf("hubspot contact property batch omitted required results: %w", adapter.ErrSourceUnavailable)
		}
		if len(*response.Results) != len(contacts) {
			return nil, fmt.Errorf("hubspot contact property batch returned %d of %d contacts: %w", len(*response.Results), len(contacts), adapter.ErrSourceUnavailable)
		}
		seen := map[string]struct{}{}
		for _, row := range *response.Results {
			id := strings.TrimSpace(firstNonEmpty(row.ID, row.Properties["hs_object_id"]))
			target := byID[id]
			if target == nil {
				return nil, fmt.Errorf("hubspot contact property batch returned an unexpected contact identity: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seen[id]; duplicate {
				return nil, fmt.Errorf("hubspot contact property batch duplicated a contact identity: %w", adapter.ErrSourceUnavailable)
			}
			seen[id] = struct{}{}
			if target.UpdatedAt != "" && row.UpdatedAt != "" && target.UpdatedAt != row.UpdatedAt {
				return nil, fmt.Errorf("hubspot contact changed while its property snapshot was hydrated: %w", adapter.ErrSourceUnavailable)
			}
			if target.CreatedAt == "" {
				target.CreatedAt = row.CreatedAt
			}
			if target.UpdatedAt == "" {
				target.UpdatedAt = row.UpdatedAt
			}
			for key, value := range row.Properties {
				target.Properties[key] = value
			}
		}
	}
	return contacts, nil
}

func (a *Adapter) fetchContactLists(ctx context.Context, sess adapter.Session) ([]hsList, error) {
	// Runtime fidelity comes from the exact membership batch, not from
	// translating HubSpot predicates. Do not request includeFilters: list
	// operations can contain literal property, integration-event, and survey
	// values, including values for Sensitive Data properties.
	return a.searchContactLists(ctx, sess)
}

func (a *Adapter) searchContactLists(ctx context.Context, sess adapter.Session) ([]hsList, error) {
	seenIDs := map[string]struct{}{}
	var out []hsList
	offset := 0
	total := -1
	for page := 0; page < hubSpotMaxTraversalPages; page++ {
		body := map[string]any{
			"count":        hubSpotListSearchPageSize,
			"offset":       offset,
			"objectTypeId": "0-1",
		}
		var response hsStrictListsResponse
		path := "/crm/lists/" + hubSpotAPIVersion + "/search"
		if err := a.do(ctx, sess, http.MethodPost, path, body, &response); err != nil {
			return nil, err
		}
		if response.Lists == nil || response.HasMore == nil || response.Offset == nil || response.Total == nil {
			return nil, fmt.Errorf("hubspot list search omitted required pagination fields: %w", adapter.ErrSourceUnavailable)
		}
		if total < 0 {
			total = *response.Total
			if total < 0 || total > hubSpotMaxSnapshotContacts {
				return nil, fmt.Errorf("hubspot list search returned invalid total %d: %w", total, adapter.ErrSourceUnavailable)
			}
		} else if total != *response.Total {
			return nil, fmt.Errorf("hubspot list total changed during snapshot (%d to %d): %w", total, *response.Total, adapter.ErrSourceUnavailable)
		}
		rows := *response.Lists
		if len(rows) > hubSpotListSearchPageSize {
			return nil, fmt.Errorf("hubspot list search exceeded page size: %w", adapter.ErrSourceUnavailable)
		}
		for _, row := range rows {
			id := strings.TrimSpace(row.sourceID())
			if err := validateHubSpotContactList(row); err != nil {
				return nil, fmt.Errorf("hubspot list search: %w", err)
			}
			if _, duplicate := seenIDs[id]; duplicate {
				return nil, fmt.Errorf("hubspot list identity repeated across pages: %w", adapter.ErrSourceUnavailable)
			}
			seenIDs[id] = struct{}{}
			out = append(out, hubSpotListSnapshotMetadata(row))
		}
		if !*response.HasMore {
			if len(out) != total {
				return nil, fmt.Errorf("hubspot list search ended with %d of %d lists: %w", len(out), total, adapter.ErrSourceUnavailable)
			}
			sort.Slice(out, func(i, j int) bool { return out[i].sourceID() < out[j].sourceID() })
			return out, nil
		}
		next := *response.Offset
		if next <= offset || len(rows) == 0 {
			return nil, fmt.Errorf("hubspot list search returned a non-progressing offset %d: %w", next, adapter.ErrSourceUnavailable)
		}
		offset = next
	}
	return nil, fmt.Errorf("hubspot list search exceeded %d pages: %w", hubSpotMaxTraversalPages, adapter.ErrSourceUnavailable)
}

func hubSpotListSnapshotMetadata(row hsList) hsList {
	// Search responses should not contain filterBranch, permissions, or unknown
	// additional metadata unless requested, but discard them defensively. Only
	// fields needed to bind and validate the frozen membership snapshot survive.
	return hsList{
		ID:               strings.TrimSpace(row.sourceID()),
		ListVersion:      row.ListVersion,
		Name:             strings.TrimSpace(row.Name),
		ObjectTypeID:     strings.TrimSpace(row.ObjectTypeID),
		ProcessingType:   strings.ToUpper(strings.TrimSpace(row.ProcessingType)),
		ProcessingStatus: strings.ToUpper(strings.TrimSpace(row.ProcessingStatus)),
		UpdatedAt:        strings.TrimSpace(row.UpdatedAt),
		FiltersUpdatedAt: strings.TrimSpace(row.FiltersUpdatedAt),
	}
}

func validateHubSpotContactList(row hsList) error {
	id := strings.TrimSpace(row.sourceID())
	if !validHubSpotObjectID(id) || row.ListVersion <= 0 ||
		strings.TrimSpace(row.ObjectTypeID) != "0-1" || strings.TrimSpace(row.Name) == "" {
		return fmt.Errorf("list response returned an invalid contact-list identity: %w", adapter.ErrSourceUnavailable)
	}
	if !strings.EqualFold(strings.TrimSpace(row.ProcessingStatus), "COMPLETE") {
		return fmt.Errorf("list is not in COMPLETE processing state: %w", adapter.ErrSourceUnavailable)
	}
	processingType := strings.ToUpper(strings.TrimSpace(row.ProcessingType))
	switch processingType {
	case "MANUAL":
	case "DYNAMIC", "SNAPSHOT":
	default:
		return fmt.Errorf("list returned an unknown processing type: %w", adapter.ErrSourceUnavailable)
	}
	return nil
}

func validateHubSpotMembershipSnapshot(lists []hsList, memberships map[string][]hsMembership) error {
	listVersions := make(map[string]int, len(lists))
	for _, list := range lists {
		listVersions[list.sourceID()] = list.ListVersion
	}
	for _, contactMemberships := range memberships {
		for _, membership := range contactMemberships {
			listID := strings.TrimSpace(stringFromAny(membership.ListID))
			listVersion, known := listVersions[listID]
			if !known {
				return fmt.Errorf("hubspot contact membership referenced a list missing from the exact list inventory: %w", adapter.ErrSourceUnavailable)
			}
			if membership.ListVersion != listVersion {
				return fmt.Errorf("hubspot list changed while its contact memberships were captured: %w", adapter.ErrSourceUnavailable)
			}
		}
	}
	return nil
}

func (a *Adapter) fetchContactMemberships(ctx context.Context, sess adapter.Session, contacts []hsObject) (map[string][]hsMembership, error) {
	out := make(map[string][]hsMembership, len(contacts))
	if len(contacts) == 0 {
		return out, nil
	}
	inputs := make([]map[string]string, 0, len(contacts))
	expected := map[string]struct{}{}
	for _, contact := range contacts {
		id := strings.TrimSpace(firstNonEmpty(contact.ID, contact.Properties["hs_object_id"]))
		inputs = append(inputs, map[string]string{"objectTypeId": "0-1", "recordId": id})
		expected[id] = struct{}{}
	}
	var response hsStrictMembershipResponse
	path := "/crm/lists/" + hubSpotAPIVersion + "/records/memberships/batch/read"
	if err := a.do(ctx, sess, http.MethodPost, path, map[string]any{"inputs": inputs}, &response); err != nil {
		return nil, err
	}
	if err := validateBatchStatus(response.Status, response.Errors, response.NumErrors, "list membership batch"); err != nil {
		return nil, err
	}
	if response.Results == nil || len(*response.Results) != len(contacts) {
		got := 0
		if response.Results != nil {
			got = len(*response.Results)
		}
		return nil, fmt.Errorf("hubspot list membership batch returned %d of %d contacts: %w", got, len(contacts), adapter.ErrSourceUnavailable)
	}
	for _, row := range *response.Results {
		if strings.TrimSpace(row.ObjectTypeID) != "0-1" {
			return nil, fmt.Errorf("hubspot list membership batch returned a non-contact object type: %w", adapter.ErrSourceUnavailable)
		}
		id := strings.TrimSpace(row.RecordID)
		if _, ok := expected[id]; !ok {
			return nil, fmt.Errorf("hubspot list membership batch returned an unexpected contact identity: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := out[id]; duplicate {
			return nil, fmt.Errorf("hubspot list membership batch duplicated a contact identity: %w", adapter.ErrSourceUnavailable)
		}
		seenLists := map[string]struct{}{}
		for _, membership := range row.RecordListMemberships {
			listID := strings.TrimSpace(stringFromAny(membership.ListID))
			if !validHubSpotObjectID(listID) || membership.ListVersion <= 0 {
				return nil, fmt.Errorf("hubspot contact returned invalid list membership: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenLists[listID]; duplicate {
				return nil, fmt.Errorf("hubspot contact repeated a list membership: %w", adapter.ErrSourceUnavailable)
			}
			seenLists[listID] = struct{}{}
		}
		sort.Slice(row.RecordListMemberships, func(i, j int) bool {
			return stringFromAny(row.RecordListMemberships[i].ListID) < stringFromAny(row.RecordListMemberships[j].ListID)
		})
		out[id] = row.RecordListMemberships
	}
	return out, nil
}

func (a *Adapter) fetchSubscriptionDefinitions(ctx context.Context, sess adapter.Session) ([]hsSubscriptionDefinition, error) {
	var response hsSubscriptionDefinitionsResponse
	path := "/communication-preferences/" + hubSpotAPIVersion + "/definitions?includeTranslations=true"
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, err
	}
	if err := validateBatchStatus(response.Status, response.Errors, response.NumErrors, "subscription definitions"); err != nil {
		return nil, err
	}
	if response.Results == nil {
		return nil, fmt.Errorf("hubspot subscription definitions omitted required results: %w", adapter.ErrSourceUnavailable)
	}
	seen := map[string]struct{}{}
	out := append([]hsSubscriptionDefinition(nil), (*response.Results)...)
	for index := range out {
		definition := &out[index]
		id := definition.sourceID()
		if !validHubSpotObjectID(id) || strings.TrimSpace(definition.Name) == "" || definition.IsActive == nil || definition.IsDefault == nil || definition.IsInternal == nil {
			return nil, fmt.Errorf("hubspot subscription definition was incomplete: %w", adapter.ErrSourceUnavailable)
		}
		if !hubSpotSubscriptionDefinitionIsEmail(*definition) {
			continue
		}
		if _, duplicate := seen[definition.key()]; duplicate {
			return nil, fmt.Errorf("hubspot subscription definition was duplicated: %w", adapter.ErrSourceUnavailable)
		}
		seen[definition.key()] = struct{}{}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key() < out[j].key() })
	return out, nil
}

func (a *Adapter) fetchContactSubscriptionPreferences(ctx context.Context, sess adapter.Session, email string, definitions []hsSubscriptionDefinition) ([]hsSubscriptionStatus, []hsWideSubscriptionStatus, error) {
	escaped := url.PathEscape(email)
	var statusesResponse hsSubscriptionStatusesResponse
	statusPath := "/communication-preferences/" + hubSpotAPIVersion + "/statuses/" + escaped + "?channel=EMAIL"
	if err := a.do(ctx, sess, http.MethodGet, statusPath, nil, &statusesResponse); err != nil {
		return nil, nil, err
	}
	if err := validateBatchStatus(statusesResponse.Status, statusesResponse.Errors, statusesResponse.NumErrors, "contact subscription statuses"); err != nil {
		return nil, nil, err
	}
	if statusesResponse.Results == nil {
		return nil, nil, fmt.Errorf("hubspot contact subscription statuses omitted required results: %w", adapter.ErrSourceUnavailable)
	}
	statuses := append([]hsSubscriptionStatus(nil), (*statusesResponse.Results)...)
	knownDefinitions := map[string]hsSubscriptionDefinition{}
	expectedActiveDefinitions := map[string]hsSubscriptionDefinition{}
	for _, definition := range definitions {
		if !hubSpotSubscriptionDefinitionIsEmail(definition) {
			continue
		}
		knownDefinitions[definition.key()] = definition
		if definition.IsActive != nil && *definition.IsActive {
			expectedActiveDefinitions[definition.key()] = definition
		}
	}
	seen := map[string]struct{}{}
	for _, status := range statuses {
		key := status.key()
		if _, ok := knownDefinitions[key]; !ok {
			return nil, nil, fmt.Errorf("hubspot contact subscription response referenced an unknown email definition: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[key]; duplicate {
			return nil, nil, fmt.Errorf("hubspot contact subscription response duplicated a definition: %w", adapter.ErrSourceUnavailable)
		}
		seen[key] = struct{}{}
		if !strings.EqualFold(strings.TrimSpace(status.Channel), "EMAIL") || !strings.EqualFold(strings.TrimSpace(status.SubscriberID), email) {
			return nil, nil, fmt.Errorf("hubspot contact subscription response returned mismatched subscriber/channel: %w", adapter.ErrSourceUnavailable)
		}
		switch strings.ToUpper(strings.TrimSpace(status.Status)) {
		case "SUBSCRIBED", "UNSUBSCRIBED", "NOT_SPECIFIED":
		default:
			return nil, nil, fmt.Errorf("hubspot contact subscription response returned an unknown state: %w", adapter.ErrSourceUnavailable)
		}
		if firstParsedTime(status.Timestamp) == nil {
			return nil, nil, fmt.Errorf("hubspot contact subscription response returned invalid timestamp: %w", adapter.ErrSourceUnavailable)
		}
	}
	for key := range expectedActiveDefinitions {
		if _, present := seen[key]; !present {
			return nil, nil, fmt.Errorf("hubspot contact subscription response omitted an active email definition: %w", adapter.ErrSourceUnavailable)
		}
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].key() < statuses[j].key() })

	var wideResponse hsWideSubscriptionStatusesResponse
	widePath := "/communication-preferences/" + hubSpotAPIVersion + "/statuses/" + escaped + "/unsubscribe-all?channel=EMAIL"
	if err := a.do(ctx, sess, http.MethodGet, widePath, nil, &wideResponse); err != nil {
		return nil, nil, err
	}
	if err := validateBatchStatus(wideResponse.Status, wideResponse.Errors, wideResponse.NumErrors, "contact unsubscribe-all status"); err != nil {
		return nil, nil, err
	}
	if wideResponse.Results == nil {
		return nil, nil, fmt.Errorf("hubspot contact unsubscribe-all response omitted required results: %w", adapter.ErrSourceUnavailable)
	}
	wide := append([]hsWideSubscriptionStatus(nil), (*wideResponse.Results)...)
	wideSeen := map[int64]struct{}{}
	for _, status := range wide {
		if _, duplicate := wideSeen[status.BusinessUnitID]; duplicate {
			return nil, nil, fmt.Errorf("hubspot contact unsubscribe-all response duplicated business-unit scope: %w", adapter.ErrSourceUnavailable)
		}
		wideSeen[status.BusinessUnitID] = struct{}{}
		if !strings.EqualFold(strings.TrimSpace(status.Channel), "EMAIL") || !strings.EqualFold(strings.TrimSpace(status.SubscriberID), email) {
			return nil, nil, fmt.Errorf("hubspot contact unsubscribe-all response returned mismatched subscriber/channel: %w", adapter.ErrSourceUnavailable)
		}
		if _, ok := normalizeHubSpotWideStatus(status.Status); !ok {
			return nil, nil, fmt.Errorf("hubspot contact unsubscribe-all response returned an unexpected state: %w", adapter.ErrSourceUnavailable)
		}
		if value := strings.ToUpper(strings.TrimSpace(status.WideStatusType)); value != "" && value != "PORTAL_WIDE" && value != "BUSINESS_UNIT_WIDE" {
			return nil, nil, fmt.Errorf("hubspot contact unsubscribe-all response returned an unexpected scope type: %w", adapter.ErrSourceUnavailable)
		}
		if firstParsedTime(status.Timestamp) == nil {
			return nil, nil, fmt.Errorf("hubspot contact unsubscribe-all response returned invalid timestamp: %w", adapter.ErrSourceUnavailable)
		}
	}
	sort.Slice(wide, func(i, j int) bool {
		if wide[i].BusinessUnitID == wide[j].BusinessUnitID {
			return wide[i].WideStatusType < wide[j].WideStatusType
		}
		return wide[i].BusinessUnitID < wide[j].BusinessUnitID
	})
	return statuses, wide, nil
}

func (a *Adapter) ensureDailyRequestBudget(ctx context.Context, sess adapter.Session, requiredCalls int64) error {
	if requiredCalls <= 0 {
		return nil
	}
	var response hsDailyAPIUsageResponse
	path := "/account-info/" + hubSpotAPIVersion + "/api-usage/daily/private-apps"
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return err
	}
	if response.Results == nil {
		return fmt.Errorf("daily API usage response omitted required results: %w", adapter.ErrSourceUnavailable)
	}
	var selected *hsDailyAPIUsage
	for index := range *response.Results {
		row := &(*response.Results)[index]
		if strings.EqualFold(strings.TrimSpace(row.Name), "private-apps-api-calls-daily") {
			if selected != nil {
				return fmt.Errorf("daily API usage response duplicated private-app usage row: %w", adapter.ErrSourceUnavailable)
			}
			selected = row
		}
	}
	if selected == nil || selected.UsageLimit == nil || selected.CurrentUsage == nil {
		return fmt.Errorf("daily API usage response omitted the private-app call limit: %w", adapter.ErrSourceUnavailable)
	}
	if !strings.EqualFold(strings.TrimSpace(selected.FetchStatus), "SUCCESS") {
		return fmt.Errorf("daily API usage response was not successful: %w", adapter.ErrSourceUnavailable)
	}
	collectedAt := firstParsedTime(selected.CollectedAt)
	resetsAt := firstParsedTime(selected.ResetsAt)
	if collectedAt == nil || resetsAt == nil || !resetsAt.After(*collectedAt) {
		return fmt.Errorf("daily API usage response contained invalid collection/reset timestamps: %w", adapter.ErrSourceUnavailable)
	}
	if *selected.UsageLimit <= 0 || *selected.CurrentUsage < 0 || *selected.CurrentUsage > *selected.UsageLimit {
		return fmt.Errorf("daily API usage response contained invalid usage values: %w", adapter.ErrSourceUnavailable)
	}
	// HubSpot reports account-wide private-app usage at a collected timestamp,
	// while other apps may continue spending the shared limit. Preserve both a
	// fixed floor and five percent of the daily limit so an exact-fit check
	// cannot certify a migration against predictably stale/racing usage.
	reserve := *selected.UsageLimit / hubSpotDailyReserveDivisor
	if reserve < hubSpotDailyReserveFloor {
		reserve = hubSpotDailyReserveFloor
	}
	// One additional call covers this usage probe if HubSpot's collected
	// currentUsage value has not incorporated it yet.
	requiredWithProbeAndReserve := requiredCalls + 1 + reserve
	remaining := *selected.UsageLimit - *selected.CurrentUsage
	if remaining < requiredWithProbeAndReserve {
		retryAfter := time.Until(resetsAt.UTC())
		if retryAfter < 0 {
			retryAfter = 0
		}
		return &adapter.ErrRateLimited{RetryAfter: retryAfter}
	}
	return nil
}

func applyHubSpotPreferences(sub canonical.Subscriber, statuses []hsSubscriptionStatus, wide []hsWideSubscriptionStatus, definitions []hsSubscriptionDefinition) (canonical.Subscriber, error) {
	if sub.CustomFields == nil {
		sub.CustomFields = map[string]interface{}{}
	}
	rows := make([]map[string]interface{}, 0, len(statuses))
	definitionActive := make(map[string]bool, len(definitions))
	for _, definition := range definitions {
		if hubSpotSubscriptionDefinitionIsEmail(definition) && definition.IsActive != nil {
			definitionActive[definition.key()] = *definition.IsActive
		}
	}
	anySubscribed, anyUnsubscribed, anyNotSpecified, inactiveUnsubscribed := false, false, false, false
	subscribedConsentTimestampDefensible := true
	var completeSubscribedAt *time.Time
	for _, status := range statuses {
		state := strings.ToUpper(strings.TrimSpace(status.Status))
		active := definitionActive[status.key()]
		switch state {
		case "SUBSCRIBED":
			if active {
				anySubscribed = true
				if !hubspotStatusHasDefensibleConsent(status) {
					subscribedConsentTimestampDefensible = false
				}
				sub.Tags = append(sub.Tags, hubSpotSubscriptionTag(status.BusinessUnitID, stringFromAny(status.SubscriptionID)))
				parsed := firstParsedTime(status.Timestamp)
				if parsed != nil && (completeSubscribedAt == nil || parsed.After(*completeSubscribedAt)) {
					copy := parsed.UTC()
					completeSubscribedAt = &copy
				}
			}
		case "UNSUBSCRIBED":
			if active {
				anyUnsubscribed = true
			} else {
				inactiveUnsubscribed = true
			}
		case "NOT_SPECIFIED":
			if active {
				anyNotSpecified = true
			}
		}
		rows = append(rows, map[string]interface{}{
			"business_unit_id":        status.BusinessUnitID,
			"subscription_id":         strings.TrimSpace(stringFromAny(status.SubscriptionID)),
			"status":                  state,
			"source":                  status.Source,
			"legal_basis":             status.LegalBasis,
			"legal_basis_explanation": status.LegalBasisExplanation,
			"timestamp":               status.Timestamp,
		})
	}
	sub.CustomFields["hubspot_subscription_preferences"] = rows
	if len(wide) > 0 {
		sub.CustomFields["hubspot_unsubscribe_all"] = wide
	}
	sub.Tags = dedupeStrings(sub.Tags)
	sort.Strings(sub.Tags)

	anyWideUnsubscribed, anyWideNotSpecified := false, false
	for _, status := range wide {
		state, ok := normalizeHubSpotWideStatus(status.Status)
		if !ok {
			return canonical.Subscriber{}, fmt.Errorf("hubspot unsubscribe-all evidence returned unknown state: %w", adapter.ErrSourceUnavailable)
		}
		switch state {
		case "UNSUBSCRIBED":
			anyWideUnsubscribed = true
		case "NOT_SPECIFIED":
			anyWideNotSpecified = true
		}
	}

	switch {
	case sub.Status == canonical.StatusBlocklisted:
		return sub, nil
	case anyWideUnsubscribed || sub.Status == canonical.StatusDisabled:
		sub.Status = canonical.StatusDisabled
	case anyUnsubscribed || inactiveUnsubscribed:
		// Moosewave's canonical status is global. A scoped opt-out cannot be
		// flattened into a globally sendable subscriber even when another topic
		// or brand is explicitly subscribed.
		sub.Status = canonical.StatusDisabled
	case anyNotSpecified || anyWideNotSpecified:
		sub.Status = canonical.StatusUnconfirmed
	case hasHubSpotEmailEligibilityRestriction(sub.CustomFields):
		// Provider-side deliverability, marketing-contact, and double-opt-in
		// restrictions are independent of topic subscription preferences.
		// Complete SUBSCRIBED rows must never promote a contact HubSpot itself
		// considers ineligible.
		sub.Status = canonical.StatusUnconfirmed
	case anySubscribed && len(statuses) > 0:
		sub.Status = canonical.StatusEnabled
		if subscribedConsentTimestampDefensible {
			sub.ConsentTimestamp = completeSubscribedAt
		}
	default:
		sub.Status = canonical.StatusUnconfirmed
	}
	if sub.Status != canonical.StatusEnabled {
		sub.ConsentTimestamp = nil
	}
	sub.ConsentSource = canonical.ConsentUnknown
	return sub, nil
}

func normalizeHubSpotWideStatus(raw string) (string, bool) {
	state := strings.ToUpper(strings.TrimSpace(raw))
	if state == "" {
		// The documented positive unsubscribe-all result omits status and
		// wideStatusType entirely. Row presence in that shape means opted out.
		return "UNSUBSCRIBED", true
	}
	switch state {
	case "SUBSCRIBED", "UNSUBSCRIBED", "NOT_SPECIFIED":
		return state, true
	default:
		return "", false
	}
}

func hubspotStatusHasDefensibleConsent(status hsSubscriptionStatus) bool {
	legalBasis := strings.ToUpper(strings.TrimSpace(stringFromAny(status.LegalBasis)))
	if strings.Contains(legalBasis, "CONSENT") {
		return true
	}
	source := normalizeHubSpotSemantic(status.Source)
	return strings.Contains(source, "SELF_SERVICE") && strings.Contains(source, "RESUBSCRIPTION")
}

func hasHubSpotEmailEligibilityRestriction(custom map[string]interface{}) bool {
	value := custom["hubspot_email_eligibility_restrictions"]
	switch typed := value.(type) {
	case []string:
		return len(typed) > 0
	case []interface{}:
		return len(typed) > 0
	default:
		return value != nil
	}
}

func activeHubSpotEmailDefinition(definitions []hsSubscriptionDefinition, key string) bool {
	for _, definition := range definitions {
		if definition.key() == key && definition.IsActive != nil && *definition.IsActive &&
			hubSpotSubscriptionDefinitionIsEmail(definition) {
			return true
		}
	}
	return false
}

func buildHubSpotSegments(lists []hsList, definitions []hsSubscriptionDefinition, membershipCounts map[string]int) []canonical.Segment {
	var out []canonical.Segment
	for _, list := range lists {
		out = append(out, mapListToSegment(list))
	}
	for _, definition := range definitions {
		if definition.IsActive == nil || !*definition.IsActive || !hubSpotSubscriptionDefinitionIsEmail(definition) {
			continue
		}
		tag := hubSpotSubscriptionTag(definition.BusinessUnitID, definition.sourceID())
		raw, _ := json.Marshal(map[string]interface{}{
			"migration_mode": "subscription_preference_snapshot",
			"source_id":      tag,
			"source":         definition,
		})
		out = append(out, canonical.Segment{
			Name:        "HubSpot subscription: " + strings.TrimSpace(definition.Name),
			Description: "HubSpot brand/subscription-type opt-in snapshot. Keep this targeting boundary on every marketing send.",
			QueryAST: canonical.SegmentNode{
				Op:         "condition",
				Field:      "tag",
				Comparator: "equals",
				Value:      tag,
			},
			SourceDefinition: string(raw),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		left := fmt.Sprint(out[i].QueryAST.Value)
		right := fmt.Sprint(out[j].QueryAST.Value)
		return left < right
	})
	return out
}

func hubSpotSubscriptionTag(businessUnitID int64, subscriptionID string) string {
	return fmt.Sprintf("hubspot:subscription:%d:%s", businessUnitID, strings.TrimSpace(subscriptionID))
}

func hubSpotSubscriptionDefinitionIsEmail(definition hsSubscriptionDefinition) bool {
	method := strings.TrimSpace(definition.CommunicationMethod)
	// The 2026-03 API is currently email-only and its documented
	// includeTranslations response can omit communicationMethod for inactive
	// definitions. Preserve those archived definitions as email evidence.
	return method == "" || strings.EqualFold(method, "EMAIL")
}

func allContactPropertyNames(properties map[string]hsProperty) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, name := range coreContactPropertyNames() {
		seen[name] = struct{}{}
		out = append(out, name)
	}
	var names []string
	for name := range properties {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return append(out, names...)
}

func coreContactPropertyNames() []string {
	return []string{
		"email",
		"hs_additional_emails",
		"firstname",
		"lastname",
		"phone",
		"mobilephone",
		"lifecyclestage",
		"createdate",
		"lastmodifieddate",
		"hs_object_id",
		"hs_email_optout",
		"hs_email_bounce",
		"hs_email_hard_bounce_reason_enum",
		"hs_email_bounce_reason",
		"hs_email_quarantined",
		"hs_email_bad_address",
		"hs_marketable_status",
		"hs_emailconfirmationstatus",
	}
}

func validateBatchStatus(status *string, errors []any, numErrors *int, label string) error {
	if len(errors) > 0 || (numErrors != nil && *numErrors != 0) {
		return fmt.Errorf("hubspot %s reported partial errors: %w", label, adapter.ErrSourceUnavailable)
	}
	if status == nil {
		return fmt.Errorf("hubspot %s omitted required status: %w", label, adapter.ErrSourceUnavailable)
	}
	switch strings.ToUpper(strings.TrimSpace(*status)) {
	case "COMPLETE", "SUCCESS":
		return nil
	default:
		return fmt.Errorf("hubspot %s returned a non-terminal status: %w", label, adapter.ErrSourceUnavailable)
	}
}

func validHubSpotObjectID(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func validHubSpotPagingCursor(value string) bool {
	value = strings.TrimSpace(value)
	if !validHubSpotObjectID(value) {
		return false
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	return err == nil && parsed > 0
}

func validHubSpotEmail(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 320 {
		return false
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || !strings.EqualFold(parsed.Address, value) {
		return false
	}
	at := strings.LastIndexByte(parsed.Address, '@')
	return at > 0 && at < len(parsed.Address)-1
}

func digestStrings(domain string, values []string) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte(domain))
	_, _ = hash.Write([]byte{0})
	for _, value := range values {
		_, _ = hash.Write([]byte(value))
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func digestContactProperties(properties map[string]hsProperty) (string, error) {
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)
	hash := sha256.New()
	_, _ = hash.Write([]byte("hubspot-contact-properties-v1"))
	_, _ = hash.Write([]byte{0})
	for _, name := range names {
		raw, err := json.Marshal(properties[name])
		if err != nil {
			return "", fmt.Errorf("hubspot encode contact-property fingerprint: %w", err)
		}
		_, _ = hash.Write([]byte(name))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write(raw)
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func digestHubSpotSnapshot(snapshot *hubSpotSnapshot) (string, error) {
	payload := struct {
		Subscribers             []canonical.Subscriber `json:"subscribers"`
		Segments                []canonical.Segment    `json:"segments"`
		NonEmailIdentityDigest  string                 `json:"non_email_identity_digest"`
		ContactPropertiesDigest string                 `json:"contact_properties_digest"`
		AdditionalEmailDigest   string                 `json:"additional_email_digest"`
	}{
		Subscribers:             snapshot.Subscribers,
		Segments:                snapshot.Segments,
		NonEmailIdentityDigest:  snapshot.NonEmailIdentityDigest,
		ContactPropertiesDigest: snapshot.ContactPropertiesDigest,
		AdditionalEmailDigest:   snapshot.AdditionalEmailDigest,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("hubspot encode source snapshot fingerprint: %w", err)
	}
	sum := sha256.Sum256(append([]byte("hubspot-source-snapshot-v1\x00"), raw...))
	return hex.EncodeToString(sum[:]), nil
}

func encodeHubSpotSnapshotCursor(fingerprint, resource string, offset int) string {
	raw, _ := json.Marshal(hubSpotSnapshotCursor{
		Version:     hubSpotCursorVersion,
		Fingerprint: fingerprint,
		Resource:    resource,
		Offset:      offset,
	})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeHubSpotSnapshotCursor(cursor, fingerprint, resource string, total int) (int, error) {
	if strings.TrimSpace(cursor) == "" {
		return 0, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, fmt.Errorf("hubspot invalid %s cursor: %w", resource, adapter.ErrSourceUnavailable)
	}
	var parsed hubSpotSnapshotCursor
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return 0, fmt.Errorf("hubspot invalid %s cursor: %w", resource, adapter.ErrSourceUnavailable)
	}
	if parsed.Version != hubSpotCursorVersion || parsed.Resource != resource || parsed.Fingerprint != fingerprint || parsed.Offset <= 0 || parsed.Offset >= total {
		return 0, fmt.Errorf("hubspot stale or invalid %s cursor: %w", resource, adapter.ErrSourceUnavailable)
	}
	return parsed.Offset, nil
}
