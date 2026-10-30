// SPDX-License-Identifier: MIT

package activecampaign

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

type acContactsResponse struct {
	Contacts []acContact            `json:"contacts"`
	Meta     map[string]interface{} `json:"meta"`
}

type acContactDetail struct {
	Contact      acContact                `json:"contact"`
	ContactLists []acContactList          `json:"contactLists"`
	ContactTags  []acContactTag           `json:"contactTags"`
	FieldValues  []acFieldValue           `json:"fieldValues"`
	Deals        []acDeal                 `json:"deals"`
	Activities   []map[string]interface{} `json:"activities"`
}

type acContact struct {
	ID                  string                 `json:"id"`
	Email               string                 `json:"email"`
	FirstName           string                 `json:"firstName"`
	LastName            string                 `json:"lastName"`
	Phone               string                 `json:"phone"`
	CreatedAt           string                 `json:"cdate"`
	UpdatedAt           string                 `json:"udate"`
	CreatedTimestamp    string                 `json:"created_timestamp"`
	CreatedUTCTimestamp string                 `json:"created_utc_timestamp"`
	UpdatedTimestamp    string                 `json:"updated_timestamp"`
	BouncedHard         any                    `json:"bounced_hard"`
	BouncedSoft         any                    `json:"bounced_soft"`
	BouncedDate         any                    `json:"bounced_date"`
	Deleted             any                    `json:"deleted"`
	Links               map[string]string      `json:"links"`
	Extra               map[string]interface{} `json:"-"`
}

func (c *acContact) UnmarshalJSON(data []byte) error {
	type rawContact acContact
	var parsed rawContact
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	*c = acContact(parsed)

	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for key := range knownActiveCampaignContactKeys {
		delete(raw, key)
	}
	if len(raw) > 0 {
		c.Extra = raw
	}
	return nil
}

var knownActiveCampaignContactKeys = map[string]struct{}{
	"id":                    {},
	"email":                 {},
	"firstName":             {},
	"lastName":              {},
	"phone":                 {},
	"cdate":                 {},
	"udate":                 {},
	"created_timestamp":     {},
	"created_utc_timestamp": {},
	"updated_timestamp":     {},
	"bounced_hard":          {},
	"bounced_soft":          {},
	"bounced_date":          {},
	"deleted":               {},
	"links":                 {},
}

type acContactList struct {
	ID            string                 `json:"id"`
	List          string                 `json:"list"`
	Status        string                 `json:"status"`
	SubscribeDate string                 `json:"sdate"`
	UnsubDate     string                 `json:"udate"`
	UnsubReason   string                 `json:"unsubreason"`
	SourceID      string                 `json:"sourceid"`
	Raw           map[string]interface{} `json:"-"`
}

func (l *acContactList) UnmarshalJSON(data []byte) error {
	type rawContactList acContactList
	var parsed rawContactList
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*l = acContactList(parsed)
	l.Raw = raw
	return nil
}

type acContactTag struct {
	ID      string                 `json:"id"`
	Contact string                 `json:"contact"`
	Tag     string                 `json:"tag"`
	Raw     map[string]interface{} `json:"-"`
}

func (t *acContactTag) UnmarshalJSON(data []byte) error {
	type rawContactTag acContactTag
	var parsed rawContactTag
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*t = acContactTag(parsed)
	t.Raw = raw
	return nil
}

type acFieldValue struct {
	ID      string                 `json:"id"`
	Contact string                 `json:"contact"`
	Field   string                 `json:"field"`
	Value   string                 `json:"value"`
	Raw     map[string]interface{} `json:"-"`
}

func (v *acFieldValue) UnmarshalJSON(data []byte) error {
	type rawFieldValue acFieldValue
	var parsed rawFieldValue
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*v = acFieldValue(parsed)
	v.Raw = raw
	return nil
}

type acDeal struct {
	ID       string                 `json:"id"`
	Title    string                 `json:"title"`
	Status   string                 `json:"status"`
	Value    string                 `json:"value"`
	Currency string                 `json:"currency"`
	Group    string                 `json:"group"`
	Stage    string                 `json:"stage"`
	Owner    string                 `json:"owner"`
	Contact  string                 `json:"contact"`
	CDate    string                 `json:"cdate"`
	UDate    string                 `json:"udate"`
	Raw      map[string]interface{} `json:"-"`
}

func (d *acDeal) UnmarshalJSON(data []byte) error {
	type rawDeal acDeal
	var parsed rawDeal
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*d = acDeal(parsed)
	d.Raw = raw
	return nil
}

type acDealsResponse struct {
	Deals []acDeal               `json:"deals"`
	Meta  map[string]interface{} `json:"meta"`
}

type acDealGroupsResponse struct {
	DealGroups []acDealGroup          `json:"dealGroups"`
	Meta       map[string]interface{} `json:"meta"`
}

type acDealGroup struct {
	ID        string                 `json:"id"`
	Title     string                 `json:"title"`
	Currency  string                 `json:"currency"`
	AllGroups string                 `json:"allgroups"`
	AllUsers  string                 `json:"allusers"`
	CDate     string                 `json:"cdate"`
	UDate     string                 `json:"udate"`
	Raw       map[string]interface{} `json:"-"`
}

func (g *acDealGroup) UnmarshalJSON(data []byte) error {
	type rawDealGroup acDealGroup
	var parsed rawDealGroup
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*g = acDealGroup(parsed)
	g.Raw = raw
	return nil
}

type acListsResponse struct {
	Lists []acList               `json:"lists"`
	Meta  map[string]interface{} `json:"meta"`
}

type acList struct {
	ID         string                 `json:"id"`
	Name       string                 `json:"name"`
	StringID   string                 `json:"stringid"`
	SenderName string                 `json:"sender_name"`
	Raw        map[string]interface{} `json:"-"`
}

func (l *acList) UnmarshalJSON(data []byte) error {
	type rawList acList
	var parsed rawList
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*l = acList(parsed)
	l.Raw = raw
	return nil
}

type acSegmentsResponse struct {
	Segments []acSegment            `json:"segments"`
	Meta     map[string]interface{} `json:"meta"`
}

type acSegment struct {
	ID         string                 `json:"id"`
	Name       string                 `json:"name"`
	Logic      string                 `json:"logic"`
	Conditions json.RawMessage        `json:"conditions"`
	Raw        map[string]interface{} `json:"-"`
}

func (s *acSegment) UnmarshalJSON(data []byte) error {
	type rawSegment acSegment
	var parsed rawSegment
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*s = acSegment(parsed)
	s.Raw = raw
	return nil
}

type acAutomationsResponse struct {
	Automations []acAutomation         `json:"automations"`
	Meta        map[string]interface{} `json:"meta"`
}

type acAutomation struct {
	ID     string                 `json:"id"`
	Name   string                 `json:"name"`
	Status string                 `json:"status"`
	Links  map[string]string      `json:"links"`
	Raw    map[string]interface{} `json:"-"`
}

func (a *acAutomation) UnmarshalJSON(data []byte) error {
	type alias acAutomation
	var parsed alias
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*a = acAutomation(parsed)
	a.Raw = raw
	return nil
}

type acCampaignsResponse struct {
	Campaigns []acCampaign           `json:"campaigns"`
	Meta      map[string]interface{} `json:"meta"`
}

type acCampaign struct {
	ID           string                 `json:"id"`
	Name         string                 `json:"name"`
	Subject      string                 `json:"subject"`
	Status       string                 `json:"status"`
	SendDate     string                 `json:"sdate"`
	LastDate     string                 `json:"ldate"`
	CreatedDate  string                 `json:"cdate"`
	Type         string                 `json:"type"`
	HTML         string                 `json:"html"`
	Text         string                 `json:"text"`
	SendAmount   string                 `json:"send_amt"`
	TotalAmt     string                 `json:"total_amt"`
	Opens        string                 `json:"opens"`
	UniqueOpens  string                 `json:"uniqueopens"`
	Clicks       string                 `json:"link_clicks"`
	LinkClicks   string                 `json:"linkclicks"`
	UniqueClicks string                 `json:"uniquelinkclicks"`
	Extra        map[string]interface{} `json:"-"`
}

func (c *acCampaign) UnmarshalJSON(data []byte) error {
	type rawCampaign acCampaign
	var parsed rawCampaign
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	*c = acCampaign(parsed)

	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for key := range knownActiveCampaignCampaignKeys {
		delete(raw, key)
	}
	if len(raw) > 0 {
		c.Extra = raw
	}
	return nil
}

var knownActiveCampaignCampaignKeys = map[string]struct{}{
	"id":               {},
	"name":             {},
	"subject":          {},
	"status":           {},
	"sdate":            {},
	"ldate":            {},
	"cdate":            {},
	"type":             {},
	"html":             {},
	"text":             {},
	"send_amt":         {},
	"total_amt":        {},
	"opens":            {},
	"uniqueopens":      {},
	"link_clicks":      {},
	"linkclicks":       {},
	"uniquelinkclicks": {},
}

type acFieldsResponse struct {
	Fields []acField              `json:"fields"`
	Meta   map[string]interface{} `json:"meta"`
}

type acField struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Perstag string `json:"perstag"`
	Type    string `json:"type"`
}

type acTagsResponse struct {
	Tags []acTag                `json:"tags"`
	Meta map[string]interface{} `json:"meta"`
}

type acTag struct {
	ID   string `json:"id"`
	Tag  string `json:"tag"`
	Name string `json:"name"`
}

func mapContactToCanonical(
	d acContactDetail,
	fieldNames, tagNames map[string]string,
	safetyEvidence ...activeCampaignSubscriberSafetyEvidence,
) (canonical.Subscriber, error) {
	c := d.Contact
	email := strings.ToLower(strings.TrimSpace(c.Email))
	if !activeCampaignEmailAddressable(email) {
		return canonical.Subscriber{}, &NonEmailContactError{
			SourceID: strings.TrimSpace(c.ID),
			HasPhone: normalizePhone(c.Phone) != "",
		}
	}
	sourceID := strings.TrimSpace(c.ID)
	if sourceID == "" {
		return canonical.Subscriber{}, fmt.Errorf("activecampaign: contact %s missing source id", email)
	}
	custom := map[string]interface{}{}
	if v := strings.TrimSpace(c.FirstName); v != "" {
		custom["first_name"] = v
	}
	if v := strings.TrimSpace(c.LastName); v != "" {
		custom["last_name"] = v
	}
	if v := normalizePhone(c.Phone); v != "" {
		custom["phone"] = v
	}
	if len(c.Extra) > 0 {
		custom["activecampaign_contact_attributes"] = cloneInterfaceMap(c.Extra)
	}
	fieldValueEvidence := make([]map[string]interface{}, 0, len(d.FieldValues))
	for _, fv := range sortedFieldValues(d.FieldValues) {
		fieldID := strings.TrimSpace(fv.Field)
		fieldName := ""
		fieldKey := ""
		if fieldID == "" {
			fieldValueEvidence = append(fieldValueEvidence, activeCampaignFieldValueEvidenceEntry(fv, "", "", "missing_custom_field_id"))
			if strings.TrimSpace(fv.ID) == "" {
				return canonical.Subscriber{}, fmt.Errorf("activecampaign: contact %s field value missing stable id and custom field id", firstNonEmpty(c.ID, c.Email))
			}
			appendActiveCampaignUnmappedFieldValue(custom, fv)
			continue
		}
		fieldName = strings.TrimSpace(fieldNames[fieldID])
		if fieldName == "" {
			fieldName = activeCampaignFieldFallbackName(fieldID)
		}
		fieldKey = normalizeFieldKey(fieldName)
		custom[fieldKey] = fv.Value
		fieldValueEvidence = append(fieldValueEvidence, activeCampaignFieldValueEvidenceEntry(fv, fieldName, fieldKey, ""))
	}
	if len(fieldValueEvidence) > 0 {
		custom["activecampaign_field_values"] = fieldValueEvidence
	}
	if len(d.Deals) > 0 {
		custom["activecampaign_deals"] = sortedDealPayloads(d.Deals)
	}
	if len(d.Activities) > 0 {
		custom["activecampaign_contact_activities"] = sortedActivityMaps(d.Activities)
	}
	evidence := activeCampaignSubscriberSafetyEvidence{}
	if len(safetyEvidence) > 0 {
		evidence = safetyEvidence[0]
	}
	emailSafety := evaluateActiveCampaignSubscriberSafety(c, d.ContactLists, evidence)
	custom["activecampaign_email_safety"] = emailSafety.Audit

	if truthy(c.BouncedHard) {
		custom["activecampaign_bounced_hard"] = true
	}
	if truthy(c.BouncedSoft) {
		custom["activecampaign_bounced_soft"] = true
	}
	if v := stringFromAny(c.BouncedDate); v != "" && v != "0000-00-00" && v != "0000-00-00 00:00:00" {
		custom["activecampaign_bounced_date"] = v
	}

	tags := make([]string, 0, len(d.ContactTags)+len(d.ContactLists))
	inactiveListIDs := make([]string, 0)
	unsubscribedListIDs := make([]string, 0)
	bouncedListIDs := make([]string, 0)
	listMemberships := make([]map[string]interface{}, 0, len(d.ContactLists))
	unknownListMemberships := make([]map[string]interface{}, 0)
	unmappedListMemberships := make([]map[string]interface{}, 0)
	contactTagEvidence := make([]map[string]interface{}, 0, len(d.ContactTags))
	for _, ct := range sortedContactTags(d.ContactTags) {
		tagID := strings.TrimSpace(ct.Tag)
		tagName := ""
		if tagID == "" {
			contactTagEvidence = append(contactTagEvidence, activeCampaignContactTagEvidenceEntry(ct, "", "missing_tag_id"))
			if strings.TrimSpace(ct.ID) == "" {
				return canonical.Subscriber{}, fmt.Errorf("activecampaign: contact %s contact tag missing stable id and tag id", firstNonEmpty(c.ID, c.Email))
			}
			appendActiveCampaignUnmappedContactTag(custom, ct)
			continue
		}
		tagName = strings.TrimSpace(tagNames[tagID])
		if tagName == "" {
			tagName = activeCampaignTagFallbackName(tagID)
		}
		tags = append(tags, tagName)
		contactTagEvidence = append(contactTagEvidence, activeCampaignContactTagEvidenceEntry(ct, tagName, ""))
	}
	if len(contactTagEvidence) > 0 {
		custom["activecampaign_contact_tags"] = contactTagEvidence
	}
	for _, cl := range sortedContactLists(d.ContactLists) {
		listID := strings.TrimSpace(cl.List)
		if listID == "" {
			membership := activeCampaignListMembershipEntry(cl, "unmapped")
			membership["reason"] = "missing_list_id"
			if strings.TrimSpace(cl.ID) == "" {
				return canonical.Subscriber{}, fmt.Errorf("activecampaign: contact %s list membership missing stable id and list id", firstNonEmpty(c.ID, c.Email))
			}
			unmappedListMemberships = append(unmappedListMemberships, membership)
			continue
		}
		statusClass := activeCampaignListStatusClass(cl.Status)
		membership := activeCampaignListMembershipEntry(cl, statusClass)
		channel := emailSafety.ListChannels[listID]
		membership["marketing_channel"] = string(normalizedActiveCampaignMarketingChannel(channel))
		_, segmentMember := emailSafety.ActiveEmailMembershipListIDs[listID]
		_, emailEligible := emailSafety.EligibleEmailListIDs[listID]
		membership["segment_member"] = segmentMember
		membership["email_eligible"] = emailEligible
		listMemberships = append(listMemberships, membership)
		switch statusClass {
		case "active":
			if segmentMember {
				tags = append(tags, "list:"+listID)
			}
		case "unsubscribed":
			unsubscribedListIDs = append(unsubscribedListIDs, listID)
		case "bounced":
			bouncedListIDs = append(bouncedListIDs, listID)
		case "unknown":
			inactiveListIDs = append(inactiveListIDs, listID)
			unknownListMemberships = append(unknownListMemberships, membership)
		default:
			inactiveListIDs = append(inactiveListIDs, listID)
		}
	}
	if len(listMemberships) > 0 {
		custom["activecampaign_list_memberships"] = listMemberships
	}
	if len(unmappedListMemberships) > 0 {
		custom["activecampaign_unmapped_list_memberships"] = unmappedListMemberships
	}
	if values := dedupeStrings(unsubscribedListIDs); len(values) > 0 {
		custom["activecampaign_unsubscribed_lists"] = values
	}
	if values := dedupeStrings(inactiveListIDs); len(values) > 0 {
		custom["activecampaign_inactive_lists"] = values
	}
	if values := dedupeStrings(bouncedListIDs); len(values) > 0 {
		custom["activecampaign_bounced_lists"] = values
	}
	if len(unknownListMemberships) > 0 {
		custom["activecampaign_unknown_list_memberships"] = unknownListMemberships
	}
	if _, ok := custom["name"]; !ok {
		if name := contactDisplayName(c); name != "" {
			custom["name"] = name
		}
	}

	return canonical.Subscriber{
		Email:            email,
		Status:           emailSafety.Status,
		ConsentTimestamp: nil,
		ConsentSource:    emailSafety.ConsentSource,
		CustomFields:     custom,
		Tags:             dedupeStrings(tags),
		SourceID:         sourceID,
		SourcePlatform:   canonical.SourceActiveCampaign,
	}, nil
}

func contactDisplayName(c acContact) string {
	return strings.TrimSpace(strings.Join(nonEmptyStrings(c.FirstName, c.LastName), " "))
}

func mergeContactFallback(primary, fallback acContact) acContact {
	if strings.TrimSpace(primary.ID) == "" {
		primary.ID = fallback.ID
	}
	if strings.TrimSpace(primary.Email) == "" {
		primary.Email = fallback.Email
	}
	if strings.TrimSpace(primary.FirstName) == "" {
		primary.FirstName = fallback.FirstName
	}
	if strings.TrimSpace(primary.LastName) == "" {
		primary.LastName = fallback.LastName
	}
	if strings.TrimSpace(primary.Phone) == "" {
		primary.Phone = fallback.Phone
	}
	if strings.TrimSpace(primary.CreatedAt) == "" {
		primary.CreatedAt = fallback.CreatedAt
	}
	if strings.TrimSpace(primary.UpdatedAt) == "" {
		primary.UpdatedAt = fallback.UpdatedAt
	}
	if strings.TrimSpace(primary.CreatedTimestamp) == "" {
		primary.CreatedTimestamp = fallback.CreatedTimestamp
	}
	if strings.TrimSpace(primary.CreatedUTCTimestamp) == "" {
		primary.CreatedUTCTimestamp = fallback.CreatedUTCTimestamp
	}
	if strings.TrimSpace(primary.UpdatedTimestamp) == "" {
		primary.UpdatedTimestamp = fallback.UpdatedTimestamp
	}
	if primary.BouncedHard == nil {
		primary.BouncedHard = fallback.BouncedHard
	}
	if primary.BouncedSoft == nil {
		primary.BouncedSoft = fallback.BouncedSoft
	}
	if primary.BouncedDate == nil {
		primary.BouncedDate = fallback.BouncedDate
	}
	if primary.Deleted == nil {
		primary.Deleted = fallback.Deleted
	}
	if len(primary.Links) == 0 {
		primary.Links = fallback.Links
	}
	primary.Extra = mergeInterfaceMaps(primary.Extra, fallback.Extra)
	return primary
}

func mergeInterfaceMaps(primary, fallback map[string]interface{}) map[string]interface{} {
	if len(primary) == 0 && len(fallback) == 0 {
		return nil
	}
	out := cloneInterfaceMap(fallback)
	if out == nil {
		out = make(map[string]interface{}, len(primary))
	}
	for key, value := range primary {
		out[key] = value
	}
	return out
}

func cloneInterfaceMap(in map[string]interface{}) map[string]interface{} {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]interface{}, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func hasContactRelationshipLink(primary, fallback acContact, key string) bool {
	key = strings.TrimSpace(key)
	if key == "" {
		return false
	}
	for _, links := range []map[string]string{primary.Links, fallback.Links} {
		if strings.TrimSpace(links[key]) != "" {
			return true
		}
	}
	return false
}

func sortedFieldValues(values []acFieldValue) []acFieldValue {
	if len(values) == 0 {
		return nil
	}
	out := append([]acFieldValue(nil), values...)
	sort.SliceStable(out, func(i, j int) bool {
		return activeCampaignFieldValueSortKey(out[i]) < activeCampaignFieldValueSortKey(out[j])
	})
	return out
}

func activeCampaignFieldValueSortKey(v acFieldValue) string {
	return strings.Join([]string{
		strings.TrimSpace(v.Field),
		strings.TrimSpace(v.ID),
		strings.TrimSpace(v.Contact),
		strings.TrimSpace(v.Value),
	}, "\x00")
}

func activeCampaignFieldValueEvidenceEntry(fv acFieldValue, fieldName, fieldKey, reason string) map[string]interface{} {
	entry := cloneInterfaceMap(fv.Raw)
	if entry == nil {
		entry = map[string]interface{}{}
	}
	if v := strings.TrimSpace(fv.ID); v != "" {
		entry["id"] = v
	}
	if v := strings.TrimSpace(fv.Contact); v != "" {
		entry["contact"] = v
	}
	if v := strings.TrimSpace(fv.Field); v != "" {
		entry["field"] = v
		entry["field_id"] = v
	}
	if v := strings.TrimSpace(fieldName); v != "" {
		entry["field_name"] = v
	}
	if v := strings.TrimSpace(fieldKey); v != "" {
		entry["field_key"] = v
	}
	entry["value"] = fv.Value
	if v := strings.TrimSpace(reason); v != "" {
		entry["reason"] = v
	}
	return entry
}

func appendActiveCampaignUnmappedFieldValue(custom map[string]interface{}, fv acFieldValue) {
	entry := activeCampaignFieldValueEvidenceEntry(fv, "", "", "missing_custom_field_id")
	custom["activecampaign_unmapped_field_values"] = appendInterfaceMapEntry(
		custom["activecampaign_unmapped_field_values"],
		entry,
	)
}

func sortedContactTags(tags []acContactTag) []acContactTag {
	if len(tags) == 0 {
		return nil
	}
	out := append([]acContactTag(nil), tags...)
	sort.SliceStable(out, func(i, j int) bool {
		return activeCampaignContactTagSortKey(out[i]) < activeCampaignContactTagSortKey(out[j])
	})
	return out
}

func activeCampaignContactTagSortKey(t acContactTag) string {
	return strings.Join([]string{
		strings.TrimSpace(t.Tag),
		strings.TrimSpace(t.ID),
		strings.TrimSpace(t.Contact),
	}, "\x00")
}

func activeCampaignContactTagEvidenceEntry(ct acContactTag, tagName, reason string) map[string]interface{} {
	entry := cloneInterfaceMap(ct.Raw)
	if entry == nil {
		entry = map[string]interface{}{}
	}
	if v := strings.TrimSpace(ct.ID); v != "" {
		entry["id"] = v
	}
	if v := strings.TrimSpace(ct.Contact); v != "" {
		entry["contact"] = v
	}
	if v := strings.TrimSpace(ct.Tag); v != "" {
		entry["tag"] = v
		entry["tag_id"] = v
	}
	if v := strings.TrimSpace(tagName); v != "" {
		entry["tag_name"] = v
	}
	if v := strings.TrimSpace(reason); v != "" {
		entry["reason"] = v
	}
	return entry
}

func appendActiveCampaignUnmappedContactTag(custom map[string]interface{}, ct acContactTag) {
	entry := activeCampaignContactTagEvidenceEntry(ct, "", "missing_tag_id")
	custom["activecampaign_unmapped_contact_tags"] = appendInterfaceMapEntry(
		custom["activecampaign_unmapped_contact_tags"],
		entry,
	)
}

func appendInterfaceMapEntry(existing interface{}, entry map[string]interface{}) []map[string]interface{} {
	if len(entry) == 0 {
		return nil
	}
	out, _ := existing.([]map[string]interface{})
	out = append(out, entry)
	return out
}

func sortedDeals(deals []acDeal) []acDeal {
	if len(deals) == 0 {
		return nil
	}
	out := append([]acDeal(nil), deals...)
	sort.SliceStable(out, func(i, j int) bool {
		return activeCampaignDealSortKey(out[i]) < activeCampaignDealSortKey(out[j])
	})
	return out
}

func sortedDealPayloads(deals []acDeal) []map[string]interface{} {
	if len(deals) == 0 {
		return nil
	}
	sorted := sortedDeals(deals)
	out := make([]map[string]interface{}, 0, len(sorted))
	for _, deal := range sorted {
		out = append(out, activeCampaignDealPayload(deal))
	}
	return out
}

func activeCampaignDealSortKey(d acDeal) string {
	return strings.Join([]string{
		strings.TrimSpace(d.ID),
		strings.TrimSpace(d.Title),
		strings.TrimSpace(d.Group),
		strings.TrimSpace(d.Stage),
		strings.TrimSpace(d.UDate),
		strings.TrimSpace(d.CDate),
	}, "\x00")
}

func sortedActivityMaps(values []map[string]interface{}) []map[string]interface{} {
	if len(values) == 0 {
		return nil
	}
	out := make([]map[string]interface{}, 0, len(values))
	for _, value := range values {
		out = append(out, cloneInterfaceMap(value))
	}
	sort.SliceStable(out, func(i, j int) bool {
		return activityMapSortKey(out[i]) < activityMapSortKey(out[j])
	})
	return out
}

func activityMapSortKey(value map[string]interface{}) string {
	return strings.Join([]string{
		sourceMapString(value, "id", "activityid", "activity_id"),
		sourceMapString(value, "contact", "contact_id"),
		sourceMapString(value, "type", "activity_type"),
		sourceMapString(value, "tstamp", "timestamp", "created_at", "cdate"),
		marshalString(value),
	}, "\x00")
}

func sortedContactLists(lists []acContactList) []acContactList {
	if len(lists) == 0 {
		return nil
	}
	out := append([]acContactList(nil), lists...)
	sort.SliceStable(out, func(i, j int) bool {
		return activeCampaignContactListSortKey(out[i]) < activeCampaignContactListSortKey(out[j])
	})
	return out
}

func activeCampaignContactListSortKey(l acContactList) string {
	return strings.Join([]string{
		strings.TrimSpace(l.List),
		strings.TrimSpace(l.ID),
		strings.TrimSpace(l.Status),
		strings.TrimSpace(l.SubscribeDate),
		strings.TrimSpace(l.UnsubDate),
		strings.TrimSpace(l.SourceID),
	}, "\x00")
}

func activeCampaignListMembershipEntry(l acContactList, statusClass string) map[string]interface{} {
	entry := cloneInterfaceMap(l.Raw)
	if entry == nil {
		entry = map[string]interface{}{}
	}
	entry["list_id"] = strings.TrimSpace(l.List)
	entry["status_class"] = statusClass
	if strings.TrimSpace(l.List) != "" {
		entry["list"] = strings.TrimSpace(l.List)
	}
	if v := strings.TrimSpace(l.ID); v != "" {
		entry["id"] = v
	}
	if v := strings.TrimSpace(l.Status); v != "" {
		entry["status"] = v
	}
	if v := strings.TrimSpace(l.SubscribeDate); v != "" {
		entry["subscribed_at"] = v
	}
	if v := strings.TrimSpace(l.UnsubDate); v != "" {
		entry["unsubscribed_at"] = v
	}
	if v := strings.TrimSpace(l.UnsubReason); v != "" {
		entry["unsubscribe_reason"] = v
	}
	if v := strings.TrimSpace(l.SourceID); v != "" {
		entry["source_id"] = v
	}
	return entry
}

func nonEmptyStrings(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func isActiveListStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "1", "active", "subscribed":
		return true
	default:
		return false
	}
}

func isUnsubscribedListStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "2", "unsubscribed", "unsubscribe":
		return true
	default:
		return false
	}
}

func isBouncedListStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "3", "bounced", "hard_bounce", "hard-bounce", "hard_bounced", "hard-bounced", "cleaned":
		return true
	default:
		return false
	}
}

func isInactiveListStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "0", "inactive", "paused", "disabled", "pending", "unconfirmed":
		return true
	default:
		return false
	}
}

func activeCampaignListStatusClass(status string) string {
	switch {
	case isActiveListStatus(status):
		return "active"
	case isUnsubscribedListStatus(status):
		return "unsubscribed"
	case isBouncedListStatus(status):
		return "bounced"
	case isInactiveListStatus(status):
		return "inactive"
	default:
		return "unknown"
	}
}

func mapListToSegment(l acList) canonical.Segment {
	name := strings.TrimSpace(l.Name)
	if name == "" {
		name = "ActiveCampaign list " + l.ID
	}
	return canonical.Segment{
		Name:        "List: " + name,
		Description: fmt.Sprintf("ActiveCampaign list #%s.", l.ID),
		QueryAST: canonical.SegmentNode{
			Op:         "condition",
			Field:      "tag",
			Comparator: "equals",
			Value:      "list:" + l.ID,
		},
		SourceDefinition: marshalActiveCampaignListSourceDefinition(l),
	}
}

func mapSavedSegmentToCanonical(s acSegment) canonical.Segment {
	name := strings.TrimSpace(s.Name)
	if name == "" {
		name = "ActiveCampaign segment " + s.ID
	}
	return canonical.Segment{
		Name: name,
		Description: "ActiveCampaign saved segment could not be translated automatically; " +
			"full filter logic is preserved as source definition for rebuild/review.",
		QueryAST:         canonical.SegmentNode{Op: "activecampaign_saved_segment_review"},
		SourceDefinition: marshalActiveCampaignSegmentSourceDefinition(s),
	}
}

func marshalActiveCampaignListSourceDefinition(l acList) string {
	if len(l.Raw) > 0 {
		return marshalString(l.Raw)
	}
	return marshalString(l)
}

func marshalActiveCampaignSegmentSourceDefinition(s acSegment) string {
	if len(s.Raw) > 0 {
		return marshalString(s.Raw)
	}
	return marshalString(s)
}

func mapAutomationToCanonical(a acAutomation) canonical.Automation {
	return canonical.Automation{
		Name:             firstNonEmpty(a.Name, "ActiveCampaign automation "+a.ID),
		Status:           "draft",
		SourceDefinition: marshalAutomationSourceDefinition(a),
	}
}

func marshalAutomationSourceDefinition(a acAutomation) string {
	if len(a.Raw) > 0 {
		return marshalString(a.Raw)
	}
	type sourceAutomation struct {
		ID     string            `json:"id"`
		Name   string            `json:"name"`
		Status string            `json:"status"`
		Links  map[string]string `json:"links,omitempty"`
	}
	return marshalString(sourceAutomation{ID: a.ID, Name: a.Name, Status: a.Status, Links: a.Links})
}

func mapCampaignToCanonical(c acCampaign) (canonical.CampaignArchive, error) {
	if strings.TrimSpace(c.ID) == "" {
		return canonical.CampaignArchive{}, fmt.Errorf("activecampaign: campaign archive item missing source id")
	}
	sent := time.Time{}
	if t := firstParsedTime(c.SendDate, c.LastDate); t != nil {
		sent = *t
	}
	warnings := []string{}
	if firstNonEmpty(c.Subject, c.Name) == "" {
		warnings = append(warnings, "campaign subject/name was absent")
	}
	if strings.TrimSpace(c.HTML) == "" && strings.TrimSpace(c.Text) == "" {
		warnings = append(warnings, "campaign body content was absent")
	}
	if sent.IsZero() {
		warnings = append(warnings, "campaign send timestamp was absent")
	}
	if !hasAnyNonBlank(c.SendAmount, c.TotalAmt) {
		warnings = append(warnings, "campaign recipient count was absent")
	}
	if !hasAnyNonBlank(c.UniqueOpens, c.Opens) {
		warnings = append(warnings, "campaign open metrics were absent")
	}
	if !hasAnyNonBlank(c.UniqueClicks, c.Clicks, c.LinkClicks) {
		warnings = append(warnings, "campaign click metrics were absent")
	}
	var report map[string]interface{}
	if len(c.Extra) > 0 {
		report = map[string]interface{}{
			"activecampaign_campaign_attributes": cloneInterfaceMap(c.Extra),
		}
	}
	return canonical.CampaignArchive{
		SourceID:        c.ID,
		Subject:         firstNonEmpty(c.Subject, c.Name),
		HTML:            c.HTML,
		Text:            c.Text,
		SentAt:          sent,
		RecipientsCount: firstPositiveInt(c.SendAmount, c.TotalAmt),
		Opens:           firstPositiveInt(c.UniqueOpens, c.Opens),
		Clicks:          firstPositiveInt(c.UniqueClicks, c.Clicks, c.LinkClicks),
		Report:          report,
		Warnings:        warnings,
		SourcePlatform:  canonical.SourceActiveCampaign,
	}, nil
}

func campaignWasSent(c acCampaign) bool {
	return strings.TrimSpace(c.Status) == "5"
}

func contactUpdatedAt(c acContact) time.Time {
	if t := firstParsedTime(c.UpdatedTimestamp, c.UpdatedAt, c.CreatedTimestamp, c.CreatedAt); t != nil {
		return *t
	}
	return time.Time{}
}

func mapDealToSourceArchive(d acDeal) canonical.SourceArchiveItem {
	payload := activeCampaignDealPayload(d)
	sourceID := strings.TrimSpace(d.ID)
	if sourceID == "" {
		sourceID = stableSourceArchiveFallbackID("crm_deal", payload)
	}
	var occurred *time.Time
	if t := firstParsedTime(d.UDate, d.CDate); t != nil {
		occurred = t
	}
	return canonical.SourceArchiveItem{
		SourceID:        sourceID,
		ResourceType:    "crm_deal",
		Name:            firstNonEmpty(d.Title, "ActiveCampaign deal "+sourceID),
		Status:          d.Status,
		LinkedContactID: d.Contact,
		OccurredAt:      occurred,
		Payload:         payload,
		SourcePlatform:  canonical.SourceActiveCampaign,
	}
}

func mapDealGroupToSourceArchive(group acDealGroup) canonical.SourceArchiveItem {
	payload := activeCampaignDealGroupPayload(group)
	sourceID := strings.TrimSpace(group.ID)
	if sourceID == "" {
		sourceID = stableSourceArchiveFallbackID("crm_pipeline", payload)
	}
	var occurred *time.Time
	if t := firstParsedTime(group.UDate, group.CDate); t != nil {
		occurred = t
	}
	return canonical.SourceArchiveItem{
		SourceID:       sourceID,
		ResourceType:   "crm_pipeline",
		Name:           firstNonEmpty(group.Title, "ActiveCampaign pipeline "+sourceID),
		Status:         "",
		OccurredAt:     occurred,
		Payload:        payload,
		SourcePlatform: canonical.SourceActiveCampaign,
	}
}

func activeCampaignDealPayload(d acDeal) map[string]interface{} {
	if len(d.Raw) > 0 {
		return cloneInterfaceMap(d.Raw)
	}
	return marshalStructMap(d)
}

func activeCampaignDealGroupPayload(group acDealGroup) map[string]interface{} {
	if len(group.Raw) > 0 {
		return cloneInterfaceMap(group.Raw)
	}
	return marshalStructMap(group)
}

func marshalStructMap(value interface{}) map[string]interface{} {
	var payload map[string]interface{}
	raw, _ := json.Marshal(value)
	_ = json.Unmarshal(raw, &payload)
	return payload
}

func mapGenericSourceArchive(payload map[string]interface{}, sourceID, resourceType string) canonical.SourceArchiveItem {
	name := firstNonEmpty(
		sourceMapString(payload, "name"),
		sourceMapString(payload, "title"),
		sourceMapString(payload, "tag"),
		sourceMapString(payload, "perstag"),
		sourceMapString(payload, "subject"),
		sourceMapString(payload, "label"),
		resourceType+" "+sourceID,
	)
	var occurred *time.Time
	if t := firstParsedTime(
		sourceMapString(payload, "udate"),
		sourceMapString(payload, "updated_at"),
		sourceMapString(payload, "updatedAt"),
		sourceMapString(payload, "updatedTimestamp"),
		sourceMapString(payload, "updatedDate"),
		sourceMapString(payload, "sdate"),
		sourceMapString(payload, "sent_date"),
		sourceMapString(payload, "sentDate"),
		sourceMapString(payload, "orderDate"),
		sourceMapString(payload, "externalCreatedDate"),
		sourceMapString(payload, "cdate"),
		sourceMapString(payload, "created_at"),
		sourceMapString(payload, "createdAt"),
		sourceMapString(payload, "createdTimestamp"),
		sourceMapString(payload, "createdDate"),
		sourceMapString(payload, "tstamp"),
	); t != nil {
		occurred = t
	}
	return canonical.SourceArchiveItem{
		SourceID:       sourceID,
		ResourceType:   resourceType,
		Name:           name,
		Status:         sourceMapString(payload, "status"),
		OccurredAt:     occurred,
		Payload:        payload,
		SourcePlatform: canonical.SourceActiveCampaign,
	}
}

func normalizeAPIURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("ActiveCampaign account API URL required")
	}
	if strings.Contains(raw, "://") && !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		return "", fmt.Errorf("unsupported account API URL scheme")
	}
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid account API URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported account API URL scheme")
	}
	if u.Scheme == "http" && !isLocalHTTPHost(u.Hostname()) {
		return "", fmt.Errorf("account API URL must use https")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("unsafe account API URL")
	}
	path, err := normalizeAPIPath(u.Path)
	if err != nil {
		return "", err
	}
	u.Path = path
	return strings.TrimRight(u.String(), "/"), nil
}

func normalizeAPIPath(path string) (string, error) {
	trimmed := strings.TrimRight(path, "/")
	if trimmed == "" {
		return "/api/3", nil
	}
	if trimmed == "/api/3" {
		return "/api/3", nil
	}
	if strings.HasPrefix(trimmed, "/api/3/") {
		return "/api/3", nil
	}
	return "", fmt.Errorf("account API URL path must be account root or /api/3")
}

func isLocalHTTPHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func parseOffset(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid offset")
	}
	return n, nil
}

const (
	contactCursorModeID     = "id"
	contactCursorModeOffset = "offset"
)

type contactCursor struct {
	Mode  string
	Value int
}

func parseContactCursor(raw string) (contactCursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return contactCursor{Mode: contactCursorModeID}, nil
	}
	for _, prefix := range []string{contactCursorModeID + ":", contactCursorModeOffset + ":"} {
		if strings.HasPrefix(raw, prefix) {
			n, err := strconv.Atoi(strings.TrimPrefix(raw, prefix))
			if err != nil || n < 0 {
				return contactCursor{}, fmt.Errorf("invalid cursor")
			}
			return contactCursor{Mode: strings.TrimSuffix(prefix, ":"), Value: n}, nil
		}
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return contactCursor{}, fmt.Errorf("invalid cursor")
	}
	return contactCursor{Mode: contactCursorModeOffset, Value: n}, nil
}

func nextContactCursor(contacts []acContact, current contactCursor) (string, error) {
	if current.Mode == contactCursorModeOffset {
		// A legacy offset request did not include orders[id]=ASC, so its last
		// row is not a safe boundary for switching to id_greater mid-stream.
		// Preserve the legacy traversal until it completes; every new import
		// starts directly in documented ascending-ID mode.
		return fmt.Sprintf("%s:%d", contactCursorModeOffset, current.Value+len(contacts)), nil
	}
	if id := lastPositiveContactID(contacts); id > 0 {
		return fmt.Sprintf("%s:%d", contactCursorModeID, id), nil
	}
	return "", fmt.Errorf("activecampaign: cannot continue contact pagination without a numeric contact id")
}

func lastPositiveContactID(contacts []acContact) int {
	for i := len(contacts) - 1; i >= 0; i-- {
		id, err := strconv.Atoi(strings.TrimSpace(contacts[i].ID))
		if err == nil && id > 0 {
			return id
		}
	}
	return 0
}

func parseSourceArchiveCursor(raw string) (string, int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "deals", 0, nil
	}
	parts := strings.SplitN(raw, ":", 2)
	if len(parts) != 2 {
		return "", 0, fmt.Errorf("activecampaign: bad source archive cursor %q", raw)
	}
	offset, err := strconv.Atoi(parts[1])
	if err != nil || offset < 0 {
		return "", 0, fmt.Errorf("activecampaign: bad source archive cursor %q", raw)
	}
	return parts[0], offset, nil
}

func nextSourceArchiveResource(resource string) string {
	if strings.TrimSpace(resource) == "" {
		return ""
	}
	return strings.TrimSpace(resource) + ":0"
}

func totalFromRaw(raw map[string]json.RawMessage) int {
	if n, ok := totalFromRawOK(raw); ok && n > 0 {
		return n
	}
	return 0
}

func totalFromRawOK(raw map[string]json.RawMessage) (int, bool) {
	if len(raw["meta"]) > 0 {
		var meta map[string]interface{}
		if json.Unmarshal(raw["meta"], &meta) == nil {
			for _, k := range []string{"total", "total_items", "count"} {
				if n, ok := intFromAnyOK(meta[k]); ok {
					return n, true
				}
			}
		}
	}
	for _, k := range []string{"count", "total", "total_items"} {
		if len(raw[k]) > 0 {
			var v interface{}
			if json.Unmarshal(raw[k], &v) == nil {
				if n, ok := intFromAnyOK(v); ok {
					return n, true
				}
			}
		}
	}
	return 0, false
}

func firstParsedTime(values ...string) *time.Time {
	for _, value := range values {
		raw := strings.TrimSpace(value)
		if raw == "" || raw == "0000-00-00 00:00:00" {
			continue
		}
		for _, layout := range []string{
			time.RFC3339,
			"2006-01-02T15:04:05-07:00",
			"2006-01-02 15:04:05",
			"2006-01-02",
		} {
			if t, err := time.Parse(layout, raw); err == nil {
				return &t
			}
		}
	}
	return nil
}

func firstPositiveInt(values ...string) int {
	for _, value := range values {
		n, _ := strconv.Atoi(strings.TrimSpace(value))
		if n > 0 {
			return n
		}
	}
	return 0
}

func hasAnyNonBlank(values ...string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

func intFromAny(v interface{}) int {
	n, _ := intFromAnyOK(v)
	return n
}

func intFromAnyOK(v interface{}) (int, bool) {
	switch t := v.(type) {
	case float64:
		n := int(t)
		return n, n >= 0
	case int:
		return t, t >= 0
	case int64:
		return int(t), t >= 0
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(t))
		return n, err == nil && n >= 0
	default:
		return 0, false
	}
}

func normalizeFieldKey(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	v = strings.NewReplacer(" ", "_", "-", "_", ".", "_", "/", "_").Replace(v)
	if v == "" {
		return "field"
	}
	return v
}

func normalizePhone(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return v
}

func sourceMapString(payload map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		value, ok := payload[key]
		if !ok {
			continue
		}
		switch t := value.(type) {
		case string:
			if strings.TrimSpace(t) != "" {
				return strings.TrimSpace(t)
			}
		case float64:
			if t != 0 {
				return strconv.FormatInt(int64(t), 10)
			}
		case json.Number:
			if strings.TrimSpace(t.String()) != "" {
				return strings.TrimSpace(t.String())
			}
		}
	}
	return ""
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		t = strings.TrimSpace(t)
		return t == "1" || strings.EqualFold(t, "true") || strings.EqualFold(t, "yes")
	case float64:
		return t != 0
	case int:
		return t != 0
	case int64:
		return t != 0
	case json.Number:
		n, err := strconv.ParseFloat(strings.TrimSpace(t.String()), 64)
		return err == nil && n != 0
	default:
		return false
	}
}

func stringFromAny(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case bool:
		return strconv.FormatBool(t)
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return strings.TrimSpace(t.String())
	default:
		return ""
	}
}

func dedupeStrings(values []string) []string {
	if len(values) == 0 {
		return nil
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
	sort.Strings(out)
	return out
}

func marshalString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
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
	v = strings.TrimSpace(v)
	if v == "" {
		return retryAfterFallback
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs <= 0 {
			return retryAfterFallback
		}
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return retryAfterFallback
}
