// SPDX-License-Identifier: MIT

package hubspot

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

type hsObjectPage struct {
	Results []hsObject `json:"results"`
	Total   int        `json:"total"`
	Paging  struct {
		Next *struct {
			After string `json:"after"`
			Link  string `json:"link"`
		} `json:"next"`
	} `json:"paging"`
}

type hsObject struct {
	ID         string            `json:"id"`
	Properties map[string]string `json:"properties"`
	CreatedAt  string            `json:"createdAt"`
	UpdatedAt  string            `json:"updatedAt"`
	Archived   bool              `json:"archived"`
}

type hsPropertiesResponse struct {
	Results []hsProperty `json:"results"`
}

type hsProperty struct {
	Name                 string             `json:"name"`
	Label                string             `json:"label"`
	Description          string             `json:"description"`
	Type                 string             `json:"type"`
	FieldType            string             `json:"fieldType"`
	GroupName            string             `json:"groupName"`
	Hidden               bool               `json:"hidden"`
	Calculated           bool               `json:"calculated"`
	Archived             bool               `json:"archived"`
	FormField            bool               `json:"formField"`
	HasUniqueValue       bool               `json:"hasUniqueValue"`
	HubSpotDefined       bool               `json:"hubspotDefined"`
	DataSensitivity      string             `json:"dataSensitivity,omitempty"`
	Options              []hsPropertyOption `json:"options"`
	ModificationMetadata struct {
		ReadOnlyValue      bool `json:"readOnlyValue"`
		ReadOnlyDefinition bool `json:"readOnlyDefinition"`
		ReadOnlyOptions    bool `json:"readOnlyOptions"`
		Archivable         bool `json:"archivable"`
	} `json:"modificationMetadata"`
}

type hsPropertyOption struct {
	Hidden       bool   `json:"hidden"`
	Label        string `json:"label"`
	Value        string `json:"value"`
	Description  string `json:"description"`
	DisplayOrder int    `json:"displayOrder"`
}

type hsMembershipBatchResponse struct {
	Results []hsRecordMemberships `json:"results"`
}

type hsRecordMemberships struct {
	ObjectTypeID          string         `json:"objectTypeId"`
	RecordID              string         `json:"recordId"`
	RecordListMemberships []hsMembership `json:"recordListMemberships"`
}

type hsMembership struct {
	ListID              any    `json:"listId"`
	ListVersion         int    `json:"listVersion"`
	IsPublicList        bool   `json:"isPublicList"`
	FirstAddedTimestamp string `json:"firstAddedTimestamp"`
	LastAddedTimestamp  string `json:"lastAddedTimestamp"`
}

type hsList struct {
	ID                   string                 `json:"listId"`
	ListID               string                 `json:"id"`
	ILSListID            string                 `json:"ilsListId"`
	ListVersion          int                    `json:"listVersion"`
	Name                 string                 `json:"name"`
	ObjectTypeID         string                 `json:"objectTypeId"`
	ProcessingType       string                 `json:"processingType"`
	ProcessingStatus     string                 `json:"processingStatus"`
	AdditionalProperties map[string]interface{} `json:"additionalProperties"`
	FilterBranch         map[string]interface{} `json:"filterBranch"`
	CreatedAt            string                 `json:"createdAt"`
	CreatedByID          string                 `json:"createdById"`
	DeletedAt            string                 `json:"deletedAt"`
	FiltersUpdatedAt     string                 `json:"filtersUpdatedAt"`
	ListPermissions      map[string]interface{} `json:"listPermissions"`
	MembershipSettings   map[string]interface{} `json:"membershipSettings"`
	Size                 int                    `json:"size"`
	UpdatedAt            string                 `json:"updatedAt"`
	UpdatedByID          string                 `json:"updatedById"`
}

func (l hsList) sourceID() string {
	return firstNonEmpty(l.ID, l.ListID, l.ILSListID)
}

func mapContactToCanonical(c hsObject, props map[string]hsProperty) canonical.Subscriber {
	p := c.Properties
	sourceID := firstNonEmpty(c.ID, p["hs_object_id"])
	custom := map[string]interface{}{}
	for key, value := range p {
		value = strings.TrimSpace(value)
		if value == "" || isInternalContactField(key) {
			continue
		}
		custom[contactCustomFieldKey(key, props)] = value
	}
	if v := strings.TrimSpace(p["firstname"]); v != "" {
		custom["first_name"] = v
	}
	if v := strings.TrimSpace(p["lastname"]); v != "" {
		custom["last_name"] = v
	}
	if v := strings.TrimSpace(firstNonEmpty(p["phone"], p["mobilephone"])); v != "" {
		custom["phone"] = v
	}
	if v := strings.TrimSpace(p["lifecyclestage"]); v != "" {
		custom["hubspot_lifecycle_stage"] = v
	}
	if aliases, normalized := hubspotAdditionalEmails(p["hs_additional_emails"], p["email"]); len(aliases) > 0 {
		// HubSpot treats additional emails as unique identifiers for a contact,
		// but Moosewave's canonical subscriber remains keyed by the current
		// primary email. Preserve the aliases explicitly for identity review
		// rather than silently discarding them or fabricating subscribers.
		custom["hubspot_additional_emails"] = aliases
		custom["hubspot_additional_emails_normalized"] = normalized
	}
	status, restrictions := hubspotEmailEligibility(p, props)
	if len(restrictions) > 0 {
		custom["hubspot_email_eligibility_restrictions"] = restrictions
	}

	return canonical.Subscriber{
		Email:            strings.ToLower(strings.TrimSpace(p["email"])),
		Status:           status,
		ConsentTimestamp: nil,
		ConsentSource:    canonical.ConsentUnknown,
		CustomFields:     custom,
		Tags:             hubspotContactTags(p),
		// Preserve HubSpot's stable contact ID as the migration identity. Existing
		// migration ledgers use this raw value, and changing its namespace would
		// turn retries into a different-source write.
		SourceID:       sourceID,
		SourcePlatform: canonical.SourceHubSpot,
	}
}

func hubspotContactStatus(props map[string]string) canonical.SubscriberStatus {
	status, _ := hubspotEmailEligibility(props, nil)
	return status
}

func hubspotEmailEligibility(values map[string]string, definitions map[string]hsProperty) (canonical.SubscriberStatus, []string) {
	var restrictions []string
	// hs_email_bounce is an aggregate delivery-bounce count and can include
	// soft bounces. Preserve it as raw evidence, but only current hard-bounce
	// evidence (reason/invalid-address) blocks the address.
	if strings.TrimSpace(values["hs_email_hard_bounce_reason_enum"]) != "" ||
		strings.TrimSpace(values["hs_email_bounce_reason"]) != "" {
		restrictions = append(restrictions, "hard_bounce")
	}
	if hubspotRestrictiveBoolean(values["hs_email_quarantined"]) {
		restrictions = append(restrictions, "quarantined")
	}
	if hubspotRestrictiveBoolean(values["hs_email_bad_address"]) {
		restrictions = append(restrictions, "invalid_address")
	}
	if len(restrictions) > 0 {
		return canonical.StatusBlocklisted, restrictions
	}

	for key, value := range values {
		if strings.HasPrefix(strings.ToLower(key), "hs_email_optout") && hubspotRestrictiveBoolean(value) {
			return canonical.StatusDisabled, []string{"legacy_email_opt_out"}
		}
	}

	marketableDefinition, marketableDefinitionExists := definitions["hs_marketable_status"]
	if raw := strings.TrimSpace(values["hs_marketable_status"]); raw != "" {
		semantic := hubspotPropertyOptionSemantic(marketableDefinition, raw)
		switch {
		case hubspotSemanticIsFalse(semantic), strings.Contains(normalizeHubSpotSemantic(semantic), "NON_MARKETING"):
			restrictions = append(restrictions, "non_marketing_contact")
		case hubspotSemanticIsTrue(semantic), normalizeHubSpotSemantic(semantic) == "MARKETING":
		default:
			restrictions = append(restrictions, "unknown_marketing_contact_status")
		}
	} else if marketableDefinitionExists {
		restrictions = append(restrictions, "unknown_marketing_contact_status")
	}
	confirmationDefinition, confirmationDefinitionExists := definitions["hs_emailconfirmationstatus"]
	if raw := strings.TrimSpace(values["hs_emailconfirmationstatus"]); raw != "" {
		semantic := hubspotPropertyOptionSemantic(confirmationDefinition, raw)
		if !hubspotDoubleOptInConfirmed(semantic) {
			restrictions = append(restrictions, "double_opt_in_pending_or_unconfirmed")
		}
	} else if confirmationDefinitionExists {
		restrictions = append(restrictions, "double_opt_in_pending_or_unconfirmed")
	}
	if len(restrictions) > 0 {
		return canonical.StatusUnconfirmed, dedupeStrings(restrictions)
	}

	// Contact presence and an unset legacy opt-out property are not affirmative
	// subscription evidence. HubSpot stores explicit per-type and brand-wide
	// states in Communication Preferences, so callers must promote a contact
	// only after reconciling that evidence.
	return canonical.StatusUnconfirmed, nil
}

func hubspotRestrictiveBoolean(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "false", "0", "no", "n":
		return false
	default:
		return true
	}
}

func hubspotPropertyOptionSemantic(property hsProperty, raw string) string {
	for _, option := range property.Options {
		if strings.EqualFold(strings.TrimSpace(option.Value), strings.TrimSpace(raw)) {
			return strings.TrimSpace(option.Value) + " " + strings.TrimSpace(option.Label)
		}
	}
	return strings.TrimSpace(raw)
}

func normalizeHubSpotSemantic(raw string) string {
	raw = strings.ToUpper(strings.TrimSpace(raw))
	return strings.Join(strings.FieldsFunc(raw, func(r rune) bool {
		return (r < 'A' || r > 'Z') && (r < '0' || r > '9')
	}), "_")
}

func hubspotSemanticIsFalse(raw string) bool {
	for _, token := range strings.Split(normalizeHubSpotSemantic(raw), "_") {
		switch token {
		case "FALSE", "0", "NO":
			return true
		}
	}
	return false
}

func hubspotSemanticIsTrue(raw string) bool {
	for _, token := range strings.Split(normalizeHubSpotSemantic(raw), "_") {
		switch token {
		case "TRUE", "1", "YES":
			return true
		}
	}
	return false
}

func hubspotDoubleOptInConfirmed(raw string) bool {
	semantic := normalizeHubSpotSemantic(raw)
	if semantic == "" || strings.Contains(semantic, "PENDING") ||
		(strings.Contains(semantic, "CONFIRMATION") && strings.Contains(semantic, "EMAIL") && strings.Contains(semantic, "SENT")) {
		return false
	}
	return strings.Contains(semantic, "CONFIRMED") ||
		(strings.Contains(semantic, "CLICKED") && strings.Contains(semantic, "CONFIRM"))
}

func hubspotContactTags(props map[string]string) []string {
	stage := strings.TrimSpace(props["lifecyclestage"])
	if stage == "" {
		return nil
	}
	return []string{"hubspot:lifecycle:" + normalizeTagValue(stage)}
}

func addHubSpotListTags(sub canonical.Subscriber, memberships []hsMembership) canonical.Subscriber {
	for _, membership := range memberships {
		id := strings.TrimSpace(stringFromAny(membership.ListID))
		if id == "" {
			continue
		}
		sub.Tags = append(sub.Tags, "hubspot:list:"+id)
	}
	sub.Tags = dedupeStrings(sub.Tags)
	sort.Strings(sub.Tags)
	return sub
}

func mapListToSegment(l hsList) canonical.Segment {
	id := l.sourceID()
	name := strings.TrimSpace(l.Name)
	if name == "" {
		name = "HubSpot list " + id
	}
	sourceDefinition := map[string]interface{}{
		// Targeting uses exact membership tags. HubSpot list predicates are not
		// translated, requested, or persisted: filter operations can contain
		// literal sensitive property and integration-event values. Keep only an
		// allowlisted structural envelope for identity and operator review.
		"migration_mode":     "static_membership_snapshot",
		"source_id":          "hubspot:list:" + id,
		"predicate_fidelity": "not_accessed_or_persisted",
		"source": map[string]interface{}{
			"listId":           id,
			"listVersion":      l.ListVersion,
			"objectTypeId":     strings.TrimSpace(l.ObjectTypeID),
			"processingType":   strings.ToUpper(strings.TrimSpace(l.ProcessingType)),
			"processingStatus": strings.ToUpper(strings.TrimSpace(l.ProcessingStatus)),
		},
	}
	return canonical.Segment{
		Name:        "HubSpot: " + name,
		Description: "HubSpot list/segment backed by imported exact membership tags. Source predicates are not retained or continuously evaluated; keep HubSpot as CRM system of record.",
		QueryAST: canonical.SegmentNode{
			Op:         "condition",
			Field:      "tag",
			Comparator: "equals",
			Value:      "hubspot:list:" + id,
		},
		SourceDefinition: marshalString(sourceDefinition),
	}
}

func mapContactToSourceEvent(c hsObject, props map[string]hsProperty) canonical.SourceEvent {
	occurred := contactUpdatedAt(c)
	sub := mapContactToCanonical(c, props)
	sourceID := firstNonEmpty(c.ID, c.Properties["hs_object_id"])
	return canonical.SourceEvent{
		SourceID:       "hubspot:contact:" + sourceID + ":" + occurred.UTC().Format(time.RFC3339Nano),
		ResourceType:   "subscriber",
		Action:         "upsert",
		OccurredAt:     occurred.UTC(),
		Subscriber:     &sub,
		Payload:        map[string]interface{}{"contact_id": sourceID, "email": c.Properties["email"]},
		SourcePlatform: canonical.SourceHubSpot,
	}
}

func contactUpdatedAt(c hsObject) time.Time {
	if t := firstParsedTime(c.Properties["lastmodifieddate"], c.UpdatedAt, c.Properties["createdate"], c.CreatedAt); t != nil {
		return *t
	}
	return time.Time{}
}

func isInternalContactField(key string) bool {
	switch key {
	case "email", "hs_additional_emails", "firstname", "lastname", "phone", "mobilephone", "createdate", "lastmodifieddate", "hs_object_id":
		return true
	default:
		return false
	}
}

func contactCustomFieldKey(key string, _ map[string]hsProperty) string {
	// HubSpot labels are mutable and not unique. Basing canonical keys on a
	// normalized label allowed two distinct source properties to overwrite one
	// another nondeterministically while iterating the properties map. HubSpot
	// internal names are the stable source identifiers, so preserve them
	// verbatim behind a provider namespace. Canonical aliases such as
	// first_name and phone are projected separately above.
	return "hubspot_property_" + strings.TrimSpace(key)
}

func selectedContactPropertyNames(props map[string]hsProperty) []string {
	names := []string{"email", "hs_additional_emails", "firstname", "lastname", "phone", "mobilephone", "lifecyclestage", "createdate", "lastmodifieddate", "hs_object_id", "hs_email_optout", "hs_email_bounce", "hs_email_hard_bounce_reason_enum", "hs_email_bounce_reason", "hs_email_quarantined", "hs_email_bad_address", "hs_marketable_status", "hs_emailconfirmationstatus"}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(props)+len(names))
	for _, name := range names {
		addPropertyName(&out, seen, name)
	}
	customNames := make([]string, 0, len(props))
	for name, prop := range props {
		if prop.Name == "" {
			continue
		}
		// HubSpot hides properties when a subscription type is archived. Their
		// current values remain material consent evidence and must not disappear
		// from a migration merely because the definition is hidden.
		if prop.Hidden && !strings.HasPrefix(strings.ToLower(name), "hs_email_optout") {
			continue
		}
		customNames = append(customNames, name)
	}
	sort.Strings(customNames)
	for _, name := range customNames {
		addPropertyName(&out, seen, name)
		if len(out) >= maxContactProperties {
			break
		}
	}
	return out
}

func hubspotAdditionalEmails(raw, primary string) ([]string, []string) {
	primary = strings.ToLower(strings.TrimSpace(primary))
	seen := map[string]struct{}{}
	var exact, normalized []string
	for _, value := range strings.Split(raw, ";") {
		value = strings.TrimSpace(value)
		email := strings.ToLower(value)
		if value == "" || email == primary {
			continue
		}
		if _, duplicate := seen[email]; duplicate {
			continue
		}
		seen[email] = struct{}{}
		exact = append(exact, value)
		normalized = append(normalized, email)
	}
	sort.SliceStable(exact, func(i, j int) bool {
		return strings.ToLower(exact[i]) < strings.ToLower(exact[j])
	})
	sort.Strings(normalized)
	return exact, normalized
}

func addPropertyName(out *[]string, seen map[string]struct{}, name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	if _, ok := seen[name]; ok {
		return
	}
	seen[name] = struct{}{}
	*out = append(*out, name)
}

func totalFromRaw(raw map[string]json.RawMessage) int {
	for _, key := range []string{"total", "count", "offset"} {
		if len(raw[key]) == 0 {
			continue
		}
		var v interface{}
		if json.Unmarshal(raw[key], &v) == nil {
			if n := intFromAny(v); n > 0 {
				return n
			}
		}
	}
	if len(raw["results"]) > 0 {
		var arr []json.RawMessage
		if json.Unmarshal(raw["results"], &arr) == nil {
			return len(arr)
		}
	}
	if len(raw["lists"]) > 0 {
		var arr []json.RawMessage
		if json.Unmarshal(raw["lists"], &arr) == nil {
			return len(arr)
		}
	}
	return 0
}

func intFromAny(v interface{}) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case json.Number:
		n, _ := strconv.Atoi(t.String())
		return n
	case string:
		n, _ := strconv.Atoi(t)
		return n
	default:
		return 0
	}
}

func stringFromAny(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case json.Number:
		return t.String()
	default:
		return fmt.Sprint(t)
	}
}

func dedupeStrings(values []string) []string {
	if len(values) <= 1 {
		return values
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func firstParsedTime(values ...string) *time.Time {
	for _, value := range values {
		raw := strings.TrimSpace(value)
		if raw == "" {
			continue
		}
		for _, layout := range []string{
			time.RFC3339Nano,
			time.RFC3339,
			"2006-01-02T15:04:05.000Z",
			"2006-01-02",
		} {
			if t, err := time.Parse(layout, raw); err == nil {
				return &t
			}
		}
	}
	return nil
}

func normalizeFieldKey(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	v = strings.NewReplacer(" ", "_", "-", "_", ".", "_", "/", "_", ":", "_").Replace(v)
	v = strings.Trim(v, "_")
	if v == "" {
		return "hubspot_field"
	}
	return v
}

func normalizeTagValue(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	v = strings.NewReplacer(" ", "_", "-", "_", ".", "_", "/", "_", ":", "_").Replace(v)
	return strings.Trim(v, "_")
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func cloneMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func marshalString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func sleepCtx(ctxDone interface {
	Done() <-chan struct{}
	Err() error
}, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctxDone.Done():
		return ctxDone.Err()
	case <-t.C:
		return nil
	}
}

func parseRetryAfter(v string) time.Duration {
	if v == "" {
		return 5 * time.Second
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 5 * time.Second
}

func requirePositiveLimit(limit int) int {
	if limit <= 0 || limit > contactSearchPageSize {
		return contactSearchPageSize
	}
	return limit
}

func hubspotErr(status int) error {
	return fmt.Errorf("hubspot provider request status %d: %w", status, adapter.ErrSourceUnavailable)
}
