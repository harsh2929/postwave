// SPDX-License-Identifier: MIT

package mailchimp

import (
	"encoding/json"
	"fmt"
	"html"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

// --- Mailchimp wire types (subset; we only decode what we use) ---

type mcMember struct {
	ID                   string                 `json:"id"`
	EmailAddress         string                 `json:"email_address"`
	FullName             string                 `json:"full_name"`
	EmailType            string                 `json:"email_type"`
	Status               string                 `json:"status"`
	TimestampOpt         string                 `json:"timestamp_opt"`
	TimestampSignup      string                 `json:"timestamp_signup"`
	IPOpt                string                 `json:"ip_opt"`
	IPSignup             string                 `json:"ip_signup"`
	LastChanged          string                 `json:"last_changed"`
	UnsubscribeReason    string                 `json:"unsubscribe_reason"`
	Language             string                 `json:"language"`
	VIP                  bool                   `json:"vip"`
	MemberRating         int                    `json:"member_rating"`
	MergeFields          map[string]interface{} `json:"merge_fields"`
	MarketingPermissions []struct {
		ID      string `json:"marketing_permission_id"`
		Text    string `json:"text"`
		Enabled bool   `json:"enabled"`
	} `json:"marketing_permissions"`
	Location map[string]interface{} `json:"location"`
	Stats    map[string]interface{} `json:"stats"`
	Tags     []struct {
		Name string `json:"name"`
	} `json:"tags"`
	Interests map[string]bool `json:"interests"`
	Source    string          `json:"source"`
}

type mcSegment struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"` // saved | static | fuzzy
	Options struct {
		Match      string                   `json:"match"` // any | all
		Conditions []map[string]interface{} `json:"conditions"`
	} `json:"options"`
	Raw map[string]interface{} `json:"-"`
}

func (s *mcSegment) UnmarshalJSON(b []byte) error {
	type alias mcSegment
	var a alias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*s = mcSegment(a)
	s.Raw = raw
	return nil
}

type mcAutomation struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	CreateTime string `json:"create_time"`
	StartTime  string `json:"start_time"`
	Recipients struct {
		ListID string `json:"list_id"`
	} `json:"recipients"`
	TriggerSettings struct {
		WorkflowType  string                 `json:"workflow_type"`
		WorkflowTitle string                 `json:"workflow_title"`
		ListID        string                 `json:"list_id"`
		Runtime       map[string]interface{} `json:"runtime"`
	} `json:"trigger_settings"`
	Settings struct {
		Title string `json:"title"`
	} `json:"settings"`
	Raw map[string]interface{} `json:"-"`
}

func (a *mcAutomation) UnmarshalJSON(b []byte) error {
	type alias mcAutomation
	var decoded alias
	if err := json.Unmarshal(b, &decoded); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*a = mcAutomation(decoded)
	a.Raw = raw
	return nil
}

type mcAutomationEmail struct {
	ID    string `json:"id"`
	Delay struct {
		Amount int    `json:"amount"`
		Type   string `json:"type"` // now | day | hour | week
	} `json:"delay"`
	Settings struct {
		SubjectLine string `json:"subject_line"`
		Title       string `json:"title"`
		TemplateID  int    `json:"template_id"`
	} `json:"settings"`
	Raw map[string]interface{} `json:"-"`
}

func (e *mcAutomationEmail) UnmarshalJSON(b []byte) error {
	type alias mcAutomationEmail
	var a alias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*e = mcAutomationEmail(a)
	e.Raw = raw
	return nil
}

type mcCustomerJourney struct {
	ID     string                 `json:"id"`
	Name   string                 `json:"name"`
	Title  string                 `json:"title"`
	Status string                 `json:"status"`
	Raw    map[string]interface{} `json:"-"`
}

func (j *mcCustomerJourney) UnmarshalJSON(b []byte) error {
	var raw map[string]interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	j.Raw = raw
	j.ID = firstString(raw, "id", "journey_id", "workflow_id")
	j.Name = firstString(raw, "name")
	j.Title = firstString(raw, "title")
	j.Status = firstString(raw, "status", "state")
	if j.Name == "" {
		if settings, ok := raw["settings"].(map[string]interface{}); ok {
			j.Name = firstString(settings, "title", "name")
		}
	}
	return nil
}

type mcCampaign struct {
	ID         string `json:"id"`
	SendTime   string `json:"send_time"`
	EmailsSent int    `json:"emails_sent"`
	Recipients struct {
		ListID string `json:"list_id"`
	} `json:"recipients"`
	Settings struct {
		SubjectLine string `json:"subject_line"`
	} `json:"settings"`
}

type mcCampaignReport struct {
	Opens struct {
		UniqueOpens int `json:"unique_opens"`
	} `json:"opens"`
	Clicks struct {
		UniqueClicks int `json:"unique_clicks"`
	} `json:"clicks"`
	Raw map[string]interface{} `json:"-"`
}

func (r *mcCampaignReport) UnmarshalJSON(b []byte) error {
	type alias mcCampaignReport
	var a alias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*r = mcCampaignReport(a)
	r.Raw = raw
	return nil
}

type mcTemplate struct {
	ID          int                    `json:"id"`
	Type        string                 `json:"type"`
	Name        string                 `json:"name"`
	HTML        string                 `json:"html"`
	Subject     string                 `json:"subject"`
	PreviewText string                 `json:"preview_text"`
	Active      bool                   `json:"active"`
	Category    string                 `json:"category"`
	DateCreated string                 `json:"date_created"`
	CreatedBy   string                 `json:"created_by"`
	Raw         map[string]interface{} `json:"-"`
}

func (t *mcTemplate) UnmarshalJSON(b []byte) error {
	type alias mcTemplate
	var a alias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*t = mcTemplate(a)
	t.Raw = raw
	return nil
}

type mcTemplateDefaultContent struct {
	Sections []struct {
		Name  string      `json:"name"`
		Value interface{} `json:"value"`
	} `json:"sections"`
	Raw map[string]interface{} `json:"-"`
}

func (c *mcTemplateDefaultContent) UnmarshalJSON(b []byte) error {
	var raw map[string]interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	c.Raw = raw
	if sections, ok := raw["sections"].([]interface{}); ok {
		for _, section := range sections {
			m, ok := section.(map[string]interface{})
			if !ok {
				continue
			}
			name, _ := m["name"].(string)
			c.Sections = append(c.Sections, struct {
				Name  string      `json:"name"`
				Value interface{} `json:"value"`
			}{Name: name, Value: m["value"]})
		}
		return nil
	}
	if sections, ok := raw["sections"].(map[string]interface{}); ok {
		keys := make([]string, 0, len(sections))
		for k := range sections {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			c.Sections = append(c.Sections, struct {
				Name  string      `json:"name"`
				Value interface{} `json:"value"`
			}{Name: k, Value: sections[k]})
		}
	}
	return nil
}

// --- mappers ---

// mapMember translates a Mailchimp list member to canonical.Subscriber.
func mapMember(m mcMember, listID ...string) canonical.Subscriber {
	// Default to disabled for safety: an unknown status from the API must not
	// silently flow through to "enabled" and start receiving Moosewave mail.
	status := canonical.StatusDisabled
	switch strings.ToLower(strings.TrimSpace(m.Status)) {
	case "subscribed":
		status = canonical.StatusEnabled
	case "unsubscribed":
		status = canonical.StatusDisabled
	case "cleaned":
		status = canonical.StatusBlocklisted
	case "pending", "non_subscribed":
		status = canonical.StatusUnconfirmed
	case "transactional", "archived":
		status = canonical.StatusDisabled
	}

	custom := map[string]interface{}{}
	for k, v := range m.MergeFields {
		custom[k] = v
	}
	if len(m.MergeFields) > 0 {
		custom["postwave_mailchimp_merge_fields"] = cloneAnyMap(m.MergeFields)
	}
	if name := mailchimpMemberName(m); name != "" {
		// The Listmonk translator promotes the canonical lower-case name field
		// into subscribers.name while retaining every original merge tag.
		if _, exists := custom["name"]; !exists {
			custom["name"] = name
		}
	}
	putNonEmpty(custom, "postwave_mailchimp_status", m.Status)
	putNonEmpty(custom, "postwave_mailchimp_source", m.Source)
	putNonEmpty(custom, "postwave_mailchimp_timestamp_opt", m.TimestampOpt)
	putNonEmpty(custom, "postwave_mailchimp_timestamp_signup", m.TimestampSignup)
	putNonEmpty(custom, "postwave_mailchimp_last_changed", m.LastChanged)
	putNonEmpty(custom, "postwave_mailchimp_signup_ip", m.IPSignup)
	putNonEmpty(custom, "postwave_mailchimp_unsubscribe_reason", m.UnsubscribeReason)
	putNonEmpty(custom, "postwave_mailchimp_email_type", m.EmailType)
	putNonEmpty(custom, "postwave_mailchimp_language", m.Language)
	if m.MemberRating != 0 {
		custom["postwave_mailchimp_member_rating"] = m.MemberRating
	}
	if m.VIP {
		custom["postwave_mailchimp_vip"] = true
	}
	if len(m.Location) > 0 {
		custom["postwave_mailchimp_location"] = cloneAnyMap(m.Location)
	}
	if len(m.Stats) > 0 {
		custom["postwave_mailchimp_activity_summary"] = cloneAnyMap(m.Stats)
	}
	if groups := activeMailchimpInterests(m.Interests); len(groups) > 0 {
		custom["postwave_mailchimp_groups"] = groups
	}
	if permissions := canonicalMarketingPermissions(m); len(permissions) > 0 {
		custom["postwave_mailchimp_marketing_permissions"] = permissions
	}
	if proof := mailchimpConsentProof(m); len(proof) > 0 {
		custom["postwave_mailchimp_consent_proof"] = proof
	}

	tags := make([]string, 0, len(m.Tags)+len(m.Interests)+len(listID))
	if len(listID) > 0 && strings.TrimSpace(listID[0]) != "" {
		tags = append(tags, mailchimpListTag(listID[0]))
	}
	for _, t := range m.Tags {
		tags = append(tags, t.Name)
	}
	// Collapse interests (group memberships) into tags too — they're the
	// closest semantic match in canonical land.
	for k, v := range m.Interests {
		if v {
			tags = append(tags, "interest:"+k)
		}
	}
	tags = normalizeTags(tags)

	var consent *time.Time
	if parsed := parseMailchimpTime(m.TimestampOpt); !parsed.IsZero() {
		consent = &parsed
	}

	consentSrc := canonical.ConsentUnknown
	source := strings.ToLower(strings.TrimSpace(m.Source))
	switch {
	case strings.Contains(source, "api"):
		consentSrc = canonical.ConsentAPI
	case strings.Contains(source, "admin add"), strings.Contains(source, "import"):
		consentSrc = canonical.ConsentImport
	}
	// Mailchimp exposes the opt-in timestamp but not enough information in the
	// member response to distinguish single from double opt-in reliably. Keep
	// the source unknown unless the source itself is explicit and preserve the
	// complete proof fields above for compliance review.

	return canonical.Subscriber{
		Email:            m.EmailAddress,
		Status:           status,
		ConsentTimestamp: consent,
		ConsentSource:    consentSrc,
		CustomFields:     custom,
		Tags:             tags,
		SourceID:         mailchimpMemberSourceID(m, listID...),
		SourcePlatform:   canonical.SourceMailchimp,
	}
}

func mailchimpMemberName(m mcMember) string {
	if name := strings.TrimSpace(m.FullName); name != "" {
		return name
	}
	if name := mergeString(m.MergeFields, "NAME"); name != "" {
		return name
	}
	return strings.TrimSpace(strings.Join([]string{
		mergeString(m.MergeFields, "FNAME"),
		mergeString(m.MergeFields, "LNAME"),
	}, " "))
}

func mergeString(fields map[string]interface{}, key string) string {
	for field, value := range fields {
		if !strings.EqualFold(strings.TrimSpace(field), key) {
			continue
		}
		if text, ok := value.(string); ok {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func putNonEmpty(dst map[string]interface{}, key, value string) {
	if value = strings.TrimSpace(value); value != "" {
		dst[key] = value
	}
}

func mailchimpConsentProof(m mcMember) map[string]interface{} {
	proof := map[string]interface{}{}
	putNonEmpty(proof, "status", m.Status)
	putNonEmpty(proof, "source", m.Source)
	putNonEmpty(proof, "timestamp_opt", m.TimestampOpt)
	putNonEmpty(proof, "timestamp_signup", m.TimestampSignup)
	putNonEmpty(proof, "ip_opt", m.IPOpt)
	putNonEmpty(proof, "ip_signup", m.IPSignup)
	if permissions := canonicalMarketingPermissions(m); len(permissions) > 0 {
		proof["marketing_permissions"] = permissions
	}
	return proof
}

func canonicalMarketingPermissions(m mcMember) []map[string]interface{} {
	if len(m.MarketingPermissions) == 0 {
		return nil
	}
	permissions := make([]map[string]interface{}, 0, len(m.MarketingPermissions))
	for _, permission := range m.MarketingPermissions {
		permissions = append(permissions, map[string]interface{}{
			"marketing_permission_id": permission.ID,
			"text":                    permission.Text,
			"enabled":                 permission.Enabled,
		})
	}
	return permissions
}

func activeMailchimpInterests(interests map[string]bool) []map[string]interface{} {
	ids := make([]string, 0, len(interests))
	for id, enabled := range interests {
		if enabled && strings.TrimSpace(id) != "" {
			ids = append(ids, strings.TrimSpace(id))
		}
	}
	sort.Strings(ids)
	groups := make([]map[string]interface{}, 0, len(ids))
	for _, id := range ids {
		groups = append(groups, map[string]interface{}{
			"id":              id,
			"source_id":       id,
			"name":            id,
			"source_platform": string(canonical.SourceMailchimp),
		})
	}
	return groups
}

// translateSegment converts a Mailchimp saved/static segment into canonical
// form. Mailchimp's API usually returns flat conditions, but exports and older
// accounts can contain nested groups; we preserve any untranslatable predicate
// instead of pretending the segment is exact.
func translateSegment(s mcSegment, listID ...string) canonical.Segment {
	lid := firstListID(listID...)
	var ast canonical.SegmentNode
	var unsupported []map[string]interface{}
	if strings.EqualFold(s.Type, "static") {
		// Static segments are reconstructed from exact source membership during
		// subscriber import, so their executable predicate is always the
		// audience-scoped membership tag rather than any stale options payload.
		ast = canonical.SegmentNode{Op: "condition", Field: "tag", Comparator: "equals", Value: mailchimpSegmentTag(lid, s.ID)}
	} else {
		ast, unsupported = translateConditionGroup(s.Options.Match, s.Options.Conditions, lid)
		if len(s.Options.Conditions) == 0 {
			unsupported = append(unsupported, map[string]interface{}{
				"reason": "saved segment has no executable conditions",
			})
		}
		if len(unsupported) > 0 {
			// An AND or OR expression with dropped predicates is never equivalent
			// to the source segment. Use an intentionally unsupported AST so the
			// destination compiler refuses to persist a misleading audience.
			ast = canonical.SegmentNode{Op: "unsupported"}
		}
	}
	name := s.Name
	if lid != "" {
		name = fmt.Sprintf("%s [%s]", s.Name, lid)
	}
	seg := canonical.Segment{
		Name:     name,
		QueryAST: ast,
	}
	if len(unsupported) > 0 || len(s.Raw) > 0 {
		raw, _ := json.Marshal(map[string]interface{}{
			"id":          s.ID,
			"list_id":     lid,
			"type":        s.Type,
			"match":       s.Options.Match,
			"raw":         s.Raw,
			"unsupported": unsupported,
		})
		seg.SourceDefinition = string(raw)
		if len(unsupported) > 0 {
			seg.Description = fmt.Sprintf("%d condition(s) could not be translated; original definition preserved.", len(unsupported))
		}
	}
	return seg
}

func firstListID(listID ...string) string {
	if len(listID) == 0 {
		return ""
	}
	return strings.TrimSpace(listID[0])
}

func mailchimpListTag(listID string) string {
	listID = strings.TrimSpace(listID)
	if listID == "" {
		return ""
	}
	return "mailchimp:list:" + listID
}

func mailchimpSegmentTag(listID string, segmentID int) string {
	if strings.TrimSpace(listID) == "" {
		return fmt.Sprintf("mailchimp:segment:%d", segmentID)
	}
	return fmt.Sprintf("mailchimp:list:%s:segment:%d", strings.TrimSpace(listID), segmentID)
}

func mailchimpMemberSourceID(m mcMember, listID ...string) string {
	id := strings.TrimSpace(m.ID)
	lid := firstListID(listID...)
	if lid == "" || id == "" {
		return id
	}
	return "list:" + lid + ":member:" + id
}

func mailchimpMemberKey(m mcMember) string {
	if id := strings.TrimSpace(m.ID); id != "" {
		return "id:" + id
	}
	if email := strings.ToLower(strings.TrimSpace(m.EmailAddress)); email != "" {
		return "email:" + email
	}
	return ""
}

func normalizeTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}
	out := make([]string, 0, len(tags))
	seen := map[string]struct{}{}
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, tag)
	}
	return out
}

func translateConditionGroup(match string, conditions []map[string]interface{}, listID ...string) (canonical.SegmentNode, []map[string]interface{}) {
	op := matchOperator(match)
	children := make([]canonical.SegmentNode, 0, len(conditions))
	var unsupported []map[string]interface{}
	for _, cond := range conditions {
		nested := mapArrayFromAny(firstAny(cond, "conditions", "children"))
		if strings.EqualFold(firstString(cond, "op", "operator"), "not") && len(nested) > 0 {
			node, misses := translateConditionGroup("all", nested, listID...)
			if len(node.Children) > 0 || node.Op == "condition" {
				children = append(children, canonical.SegmentNode{Op: "not", Children: []canonical.SegmentNode{node}})
			}
			unsupported = append(unsupported, misses...)
			continue
		}
		if len(nested) > 0 {
			nestedMatch := firstNonEmpty(firstString(cond, "match", "op", "operator"), "all")
			node, misses := translateConditionGroup(nestedMatch, nested, listID...)
			if len(node.Children) > 0 || node.Op == "condition" {
				children = append(children, node)
			}
			unsupported = append(unsupported, misses...)
			continue
		}
		node, ok := translateCondition(cond, listID...)
		if !ok {
			unsupported = append(unsupported, cond)
			continue
		}
		children = append(children, node)
	}
	return canonical.SegmentNode{Op: op, Children: children}, unsupported
}

// translateCondition only emits predicates backed by fields/tags mapMember
// actually persists. Engagement, ecommerce, rating, date-window, complex
// address, and SMS predicates remain in SourceDefinition for manual review.
func translateCondition(cond map[string]interface{}, listID ...string) (canonical.SegmentNode, bool) {
	field := firstString(cond, "field", "condition_type", "type")
	conditionType := strings.ToLower(strings.TrimSpace(firstString(cond, "condition_type", "type")))
	opVal := firstString(cond, "op", "operator")
	value := firstAny(cond, "value", "field_value", "interest_id", "tag", "segment_id", "campaign_id", "product_id")
	fieldNorm := strings.ToLower(strings.TrimSpace(field))
	opNorm := strings.ToLower(strings.TrimSpace(opVal))

	canonField, canonValue := executableMailchimpSegmentField(fieldNorm, conditionType, cond, value, firstListID(listID...))
	if canonField == "" {
		return canonical.SegmentNode{}, false
	}

	cmp := executableMailchimpSegmentComparator(opNorm, canonField)
	if cmp == "" {
		return canonical.SegmentNode{}, false
	}

	return canonical.SegmentNode{
		Op:         "condition",
		Field:      canonField,
		Comparator: cmp,
		Value:      canonValue,
	}, true
}

func matchOperator(match string) string {
	switch strings.ToLower(strings.TrimSpace(match)) {
	case "any", "or":
		return "or"
	default:
		return "and"
	}
}

func executableMailchimpSegmentField(field, conditionType string, cond map[string]interface{}, value interface{}, listID string) (string, interface{}) {
	if strings.Contains(conditionType, "date") || strings.Contains(conditionType, "rating") ||
		strings.Contains(conditionType, "aim") || strings.Contains(conditionType, "ecomm") ||
		strings.Contains(conditionType, "sms") || strings.Contains(conditionType, "address") ||
		strings.Contains(conditionType, "zip") || strings.Contains(conditionType, "phone") {
		return "", nil
	}
	switch field {
	case "email", "emailaddress", "email_address":
		return "email", value
	case "status", "member_status":
		return "custom.postwave_mailchimp_status", value
	case "tag", "tags":
		return "tag", value
	case "static_segment":
		segmentID, ok := intFromSegmentValue(value)
		if !ok {
			return "", nil
		}
		return "tag", mailchimpSegmentTag(listID, segmentID)
	case "interests", "interest", "group", "groups":
		return interestTagField(value)
	}
	if strings.HasPrefix(field, "interests-") || strings.Contains(conditionType, "interest") || strings.Contains(conditionType, "group") {
		return interestTagField(value)
	}
	// Mailchimp represents text merge-field filters with the merge tag in
	// `field`. Those values are copied verbatim into Subscriber.CustomFields.
	if strings.Contains(conditionType, "merge") || conditionType == "" {
		mergeField := firstString(cond, "merge_field", "merge_tag", "field")
		if mergeField != "" {
			return "custom." + strings.ToUpper(strings.TrimSpace(mergeField)), value
		}
	}
	return "", nil
}

func interestTagField(value interface{}) (string, interface{}) {
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" || text == "<nil>" {
		return "", nil
	}
	return "tag", "interest:" + text
}

func intFromSegmentValue(value interface{}) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case float64:
		return int(typed), typed == float64(int(typed))
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return 0, false
	}
}

func executableMailchimpSegmentComparator(opVal, field string) string {
	switch opVal {
	case "is", "=", "eq", "equals", "member", "yes", "tagcontains", "interestcontains", "static_is":
		return "equals"
	case "not", "!=", "ne", "not_equals", "notmember", "no", "tagnotcontains", "interestnotcontains", "static_not":
		return "not_equals"
	case "contains":
		if field == "tag" {
			return "equals"
		}
		return "contains"
	case "notcontain", "notcontains":
		if field == "tag" {
			return "not_equals"
		}
		return "not_contains"
	case "starts", "startswith":
		if field == "tag" {
			return ""
		}
		return "starts_with"
	case "ends", "endswith":
		if field == "tag" {
			return ""
		}
		return "ends_with"
	default:
		return ""
	}
}

func mapArrayFromAny(v interface{}) []map[string]interface{} {
	items, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		if m, ok := item.(map[string]interface{}); ok {
			out = append(out, m)
		}
	}
	return out
}

// translateAutomation builds an alternating wait → send_email chain from a
// Mailchimp classic automation's email list.
func translateAutomation(au mcAutomation, emails []mcAutomationEmail) canonical.Automation {
	out := canonical.Automation{
		Name:   au.Settings.Title,
		Status: mapAutomationStatus(au.Status),
	}
	unsupportedReason := mailchimpAutomationUnsupportedReason(au, emails)
	if unsupportedReason != "" {
		out.Status = "draft"
	} else {
		t := canonical.AutomationTrigger{
			Type:   "subscriber_added_to_list",
			ListID: automationAudienceID(au),
			Metadata: map[string]interface{}{
				"source_workflow_type": au.TriggerSettings.WorkflowType,
			},
		}
		out.Triggers = append(out.Triggers, t)
	}

	prevID := ""
	for i, e := range emails {
		if unsupportedReason != "" {
			break
		}
		// Wait node (skip first email if Delay.Type == "now").
		if !(i == 0 && e.Delay.Type == "now") {
			waitID := fmt.Sprintf("wait-%d", i)
			out.Nodes = append(out.Nodes, canonical.AutomationNode{
				ID:              waitID,
				Type:            "wait",
				DurationSeconds: delayToSeconds(e.Delay.Amount, e.Delay.Type),
			})
			if prevID != "" {
				out.Edges = append(out.Edges, canonical.AutomationEdge{From: prevID, To: waitID})
			}
			prevID = waitID
		}
		sendID := fmt.Sprintf("send-%d", i)
		metadata := map[string]interface{}{
			"source_platform":            string(canonical.SourceMailchimp),
			"source_automation_id":       au.ID,
			"source_automation_email_id": e.ID,
			"source_content_id":          mailchimpAutomationEmailSourceID(au.ID, e.ID),
		}
		if e.Settings.TemplateID > 0 {
			metadata["source_template_id"] = strconv.Itoa(e.Settings.TemplateID)
		}
		// TemplateID is deliberately left empty here: Mailchimp IDs are source
		// identities, not destination template IDs. The persistence layer must
		// resolve source_template_id against imported EmailTemplate.SourceID and
		// keep the send paused/manual-review when no destination mapping exists.
		rawSource := cloneAnyMap(e.Raw)
		if rawSource == nil {
			rawSource = map[string]interface{}{}
		}
		rawSource["postwave_source_automation_id"] = au.ID
		rawSource["postwave_source_content_id"] = metadata["source_content_id"]
		out.Nodes = append(out.Nodes, canonical.AutomationNode{
			ID:        sendID,
			Type:      "send_email",
			Metadata:  metadata,
			RawSource: rawSource,
		})
		if prevID != "" {
			out.Edges = append(out.Edges, canonical.AutomationEdge{From: prevID, To: sendID})
		}
		prevID = sendID
	}

	sourceDefinition := map[string]interface{}{
		"source_id": au.ID,
		"automation": firstNonNilMap(au.Raw, map[string]interface{}{
			"id":               au.ID,
			"status":           au.Status,
			"recipients":       au.Recipients,
			"trigger_settings": au.TriggerSettings,
			"settings":         au.Settings,
		}),
		"emails": rawMailchimpAutomationEmails(emails),
	}
	if unsupportedReason != "" {
		sourceDefinition["postwave_import_status"] = "manual_review"
		sourceDefinition["postwave_unsupported_reason"] = unsupportedReason
	}
	if raw, err := json.Marshal(sourceDefinition); err == nil {
		out.SourceDefinition = string(raw)
	}
	return out
}

func mailchimpAutomationUnsupportedReason(au mcAutomation, emails []mcAutomationEmail) string {
	workflowType := strings.TrimSpace(au.TriggerSettings.WorkflowType)
	if len(au.TriggerSettings.Runtime) > 0 {
		return "Mailchimp trigger_settings.runtime send-window restrictions cannot be represented exactly in Moosewave; rebuild and verify this automation manually before activation."
	}
	if !strings.EqualFold(workflowType, "welcomeSeries") {
		if workflowType == "" {
			return "Mailchimp automation has no workflow_type; its trigger semantics cannot be translated safely and require manual review."
		}
		return fmt.Sprintf("Mailchimp workflow_type %q has no proven equivalent Moosewave trigger; rebuild and verify this automation manually before activation.", workflowType)
	}
	if automationAudienceID(au) == "" {
		return "Mailchimp welcomeSeries automation has no recipients.list_id audience identity; it cannot be translated safely."
	}
	if len(emails) == 0 {
		return "Mailchimp welcomeSeries automation has no exported email steps; review it manually before activation."
	}
	for _, email := range emails {
		unit := strings.TrimSpace(email.Delay.Type)
		if email.Delay.Amount < 0 {
			return fmt.Sprintf("Mailchimp automation email %q has a negative delay; its timing cannot be translated safely.", email.ID)
		}
		switch unit {
		case "now":
			if email.Delay.Amount != 0 {
				return fmt.Sprintf("Mailchimp automation email %q reports delay type now with amount %d; review the source timing manually.", email.ID, email.Delay.Amount)
			}
		case "hour", "day", "week":
		default:
			return fmt.Sprintf("Mailchimp automation email %q has unsupported delay type %q; its timing cannot be translated safely.", email.ID, unit)
		}
	}
	return ""
}

func rawMailchimpAutomationEmails(emails []mcAutomationEmail) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(emails))
	for _, email := range emails {
		raw := cloneAnyMap(email.Raw)
		if raw == nil {
			raw = map[string]interface{}{
				"id":       email.ID,
				"delay":    email.Delay,
				"settings": email.Settings,
			}
		}
		out = append(out, raw)
	}
	return out
}

func mailchimpAutomationEmailSourceID(automationID, emailID string) string {
	return "mailchimp:classic-automation:" + strings.TrimSpace(automationID) + ":email:" + strings.TrimSpace(emailID)
}

func firstNonNilMap(values ...map[string]interface{}) map[string]interface{} {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// translateCustomerJourney translates a caller-supplied snapshot only. The
// Mailchimp adapter never calls it because the supported Marketing API cannot
// list/export Customer Journey graphs; see listJourneyArchive's parity gap.
func translateCustomerJourney(j mcCustomerJourney) canonical.Automation {
	name := firstNonEmpty(j.Name, j.Title, "Mailchimp Customer Journey "+j.ID)
	out := canonical.Automation{
		Name:   name,
		Status: mapAutomationStatus(j.Status),
	}
	out.Triggers = journeyTriggers(j.Raw)
	out.Nodes, out.Edges = journeyNodesAndEdges(j.Raw)
	if len(out.Triggers) == 0 {
		out.Triggers = []canonical.AutomationTrigger{{
			Type:      "custom_event",
			EventName: "mailchimp.customer_journey.entered",
			Metadata:  map[string]interface{}{"source_id": j.ID},
		}}
	}
	if raw, err := json.Marshal(j.Raw); err == nil {
		out.SourceDefinition = string(raw)
	}
	return out
}

func journeyTriggers(raw map[string]interface{}) []canonical.AutomationTrigger {
	candidates := firstArray(raw, "triggers", "entry_points", "starting_points", "entrypoints")
	out := make([]canonical.AutomationTrigger, 0, len(candidates))
	for _, item := range candidates {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		typ := strings.ToLower(firstString(m, "type", "event", "trigger_type", "workflow_type"))
		t := canonical.AutomationTrigger{Metadata: cloneAnyMap(m)}
		switch {
		case strings.Contains(typ, "subscrib") || strings.Contains(typ, "list"):
			t.Type = "subscriber_added_to_list"
			t.ListID = firstString(m, "list_id", "audience_id")
		case strings.Contains(typ, "tag") && strings.Contains(typ, "add"):
			t.Type = "tag_added"
			t.Tag = firstString(m, "tag", "tag_name", "name")
		case strings.Contains(typ, "form"):
			t.Type = "custom_event"
			t.EventName = "form_submitted"
			t.FormID = firstString(m, "form_id", "id")
		case strings.Contains(typ, "email") && strings.Contains(typ, "open"):
			t.Type = "subscriber_opened_email"
			t.CampaignID = firstString(m, "campaign_id", "email_id")
		case strings.Contains(typ, "click"):
			t.Type = "subscriber_clicked_link"
			t.CampaignID = firstString(m, "campaign_id", "email_id")
			t.URLPattern = firstString(m, "url", "link_url")
		case strings.Contains(typ, "date"):
			t.Type = "date_field"
			t.Field = firstString(m, "field", "merge_field", "date_field")
		default:
			t.Type = "custom_event"
			t.EventName = firstNonEmpty(typ, firstString(m, "name"), "mailchimp.customer_journey.trigger")
		}
		out = append(out, t)
	}
	return out
}

func journeyNodesAndEdges(raw map[string]interface{}) ([]canonical.AutomationNode, []canonical.AutomationEdge) {
	items := firstArray(raw, "nodes", "steps", "actions")
	nodes := make([]canonical.AutomationNode, 0, len(items))
	for i, item := range items {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		node := journeyNodeFromMap(i, m)
		nodes = append(nodes, node)
	}
	edges := journeyEdges(raw)
	if len(edges) == 0 {
		for i := 1; i < len(nodes); i++ {
			edges = append(edges, canonical.AutomationEdge{From: nodes[i-1].ID, To: nodes[i].ID})
		}
	}
	return nodes, edges
}

func journeyNodeFromMap(i int, m map[string]interface{}) canonical.AutomationNode {
	id := firstString(m, "id", "node_id", "step_id")
	if id == "" {
		id = fmt.Sprintf("journey-node-%d", i)
	}
	kind := strings.ToLower(firstString(m, "type", "action", "action_type", "step_type"))
	node := canonical.AutomationNode{ID: id, Metadata: cloneAnyMap(m), RawSource: cloneAnyMap(m)}
	switch {
	// Specific actions before the broader contains() matches.
	case kind == "merge_field_update" || (strings.Contains(kind, "merge_field") && strings.Contains(kind, "update")):
		node.Type = "update_subscriber"
		node.Action = &canonical.AutomationAction{
			Kind:       "update_subscriber",
			Properties: extractMergeFieldProperties(m),
			Metadata:   cloneAnyMap(m),
		}
	case kind == "move_to_list" || (strings.Contains(kind, "list") && (strings.Contains(kind, "move") || strings.Contains(kind, "add") || strings.Contains(kind, "remove"))):
		node.Type = "list_membership"
		listKind := "list_add"
		switch {
		case strings.Contains(kind, "remove"):
			listKind = "list_remove"
		case kind == "move_to_list" || strings.Contains(kind, "move"):
			listKind = "move_to_list"
		}
		node.Action = &canonical.AutomationAction{
			Kind:     listKind,
			ListID:   firstString(m, "list_id", "target_list_id", "audience_id"),
			Metadata: cloneAnyMap(m),
		}
	case kind == "send_postcard" || strings.Contains(kind, "postcard"):
		node.Type = "send_postcard"
		node.Action = &canonical.AutomationAction{
			Kind:    "physical_mail",
			Message: firstString(m, "message", "body", "headline"),
			Metadata: map[string]interface{}{
				"channel":      "physical_mail",
				"postcard_id":  firstString(m, "postcard_id", "template_id", "id"),
				"front_image":  firstString(m, "front_image", "image_url"),
				"audience_id":  firstString(m, "audience_id", "list_id"),
				"return_addr":  firstString(m, "return_address"),
				"raw_settings": m["settings"],
			},
		}
	case kind == "wait_for_action" || (strings.Contains(kind, "wait") && strings.Contains(kind, "action")):
		node.Type = "wait_for_condition"
		node.TimeoutSeconds = durationFromMap(m)
		if cond := conditionFromMap(m); cond != nil {
			node.Condition = cond
		}
		if trigger := triggerFromNested(m); trigger != nil {
			node.WaitTrigger = trigger
		}
	case strings.Contains(kind, "email"):
		node.Type = "send_email"
		node.TemplateID = firstString(m, "email_id", "campaign_id", "template_id", "id")
	case strings.Contains(kind, "sms") || strings.Contains(kind, "text"):
		node.Type = "send_sms"
		node.SMSBody = firstString(m, "body", "message", "text")
	case strings.Contains(kind, "webhook"):
		node.Type = "webhook"
		node.WebhookURL = firstString(m, "url", "webhook_url")
		node.WebhookMethod = firstNonEmpty(strings.ToUpper(firstString(m, "method")), "POST")
	case strings.Contains(kind, "wait") || strings.Contains(kind, "delay"):
		node.Type = "wait"
		node.DurationSeconds = durationFromMap(m)
		if trigger := triggerFromNested(m); trigger != nil {
			node.Type = "wait_until_trigger"
			node.WaitTrigger = trigger
		}
	case strings.Contains(kind, "split") && (strings.Contains(kind, "percent") || strings.Contains(kind, "random")):
		node.Type = "percentage_split"
		node.Variants = splitVariants(m)
	case strings.Contains(kind, "split") || strings.Contains(kind, "condition") || strings.Contains(kind, "if"):
		node.Type = "branch"
		if cond := conditionFromMap(m); cond != nil {
			node.Condition = cond
		}
	case strings.Contains(kind, "goal"):
		node.Type = "goal"
		if cond := conditionFromMap(m); cond != nil {
			node.Goal = cond
		}
	default:
		node.Type = "action"
		node.Action = actionFromMap(kind, m)
	}
	if next := firstString(m, "true_next", "yes_next"); next != "" {
		node.TrueNext = &next
	}
	if next := firstString(m, "false_next", "no_next"); next != "" {
		node.FalseNext = &next
	}
	return node
}

// extractMergeFieldProperties decodes the merge-field assignment payload from a
// merge_field_update action. Mailchimp varies between a flat {field, value}
// shape and an {updates: [{tag, value}...]} list, so probe both.
func extractMergeFieldProperties(m map[string]interface{}) map[string]interface{} {
	if updates, ok := m["updates"].([]interface{}); ok && len(updates) > 0 {
		out := make(map[string]interface{}, len(updates))
		for _, u := range updates {
			row, ok := u.(map[string]interface{})
			if !ok {
				continue
			}
			tag := firstString(row, "merge_field", "merge_tag", "field", "tag", "name")
			if tag == "" {
				continue
			}
			out[strings.ToUpper(tag)] = row["value"]
		}
		if len(out) > 0 {
			return out
		}
	}
	if fields, ok := m["merge_fields"].(map[string]interface{}); ok && len(fields) > 0 {
		out := make(map[string]interface{}, len(fields))
		for k, v := range fields {
			out[strings.ToUpper(k)] = v
		}
		return out
	}
	if tag := firstString(m, "merge_field", "merge_tag", "field", "tag"); tag != "" {
		return map[string]interface{}{strings.ToUpper(tag): m["value"]}
	}
	return nil
}

func actionFromMap(kind string, m map[string]interface{}) *canonical.AutomationAction {
	action := &canonical.AutomationAction{Metadata: cloneAnyMap(m)}
	switch {
	case strings.Contains(kind, "remove") && strings.Contains(kind, "tag"):
		action.Kind = "remove_tag"
		action.Tag = firstString(m, "tag", "tag_name", "name")
	case strings.Contains(kind, "tag"):
		action.Kind = "add_tag"
		action.Tag = firstString(m, "tag", "tag_name", "name")
	case strings.Contains(kind, "group") && strings.Contains(kind, "remove"):
		action.Kind = "remove_group"
		action.GroupID = firstString(m, "group_id", "interest_id")
	case strings.Contains(kind, "group"):
		action.Kind = "add_group"
		action.GroupID = firstString(m, "group_id", "interest_id")
	case strings.Contains(kind, "unsubscribe"):
		action.Kind = "unsubscribe"
	case strings.Contains(kind, "archive"):
		action.Kind = "archive_contact"
	case strings.Contains(kind, "update"):
		action.Kind = "update_contact"
		action.Field = firstString(m, "field", "merge_field")
		action.Value = m["value"]
	case strings.Contains(kind, "notify"):
		action.Kind = "notify"
		action.Message = firstString(m, "message", "body")
	default:
		action.Kind = firstNonEmpty(kind, "mailchimp_action")
	}
	return action
}

func journeyEdges(raw map[string]interface{}) []canonical.AutomationEdge {
	items := firstArray(raw, "edges", "connections")
	edges := make([]canonical.AutomationEdge, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		from := firstString(m, "from", "source", "source_id", "from_id")
		to := firstString(m, "to", "target", "target_id", "to_id")
		if from != "" && to != "" {
			edges = append(edges, canonical.AutomationEdge{From: from, To: to})
		}
	}
	return edges
}

func splitVariants(m map[string]interface{}) []canonical.AutomationSplitVariant {
	items := firstArray(m, "variants", "paths", "branches")
	variants := make([]canonical.AutomationSplitVariant, 0, len(items))
	for i, item := range items {
		branch, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		id := firstString(branch, "id", "path_id")
		if id == "" {
			id = fmt.Sprintf("variant-%d", i+1)
		}
		variants = append(variants, canonical.AutomationSplitVariant{
			ID:         id,
			Label:      firstString(branch, "label", "name"),
			Percentage: intFromAny(branch["percentage"]),
			Next:       firstString(branch, "next", "next_id", "target_id"),
			Metadata:   cloneAnyMap(branch),
		})
	}
	return variants
}

func conditionFromMap(m map[string]interface{}) *canonical.SegmentCondition {
	if cond, ok := m["condition"].(map[string]interface{}); ok {
		m = cond
	}
	field := firstString(m, "field", "merge_field", "property")
	if field == "" {
		return nil
	}
	return &canonical.SegmentCondition{
		Op:         "condition",
		Field:      field,
		Comparator: firstNonEmpty(firstString(m, "op", "operator", "comparator"), "equals"),
		Value:      firstAny(m, "value", "expected", "match"),
	}
}

func triggerFromNested(m map[string]interface{}) *canonical.AutomationTrigger {
	raw, ok := m["trigger"].(map[string]interface{})
	if !ok {
		raw, ok = m["wait_for"].(map[string]interface{})
	}
	if !ok {
		return nil
	}
	triggers := journeyTriggers(map[string]interface{}{"triggers": []interface{}{raw}})
	if len(triggers) == 0 {
		return nil
	}
	return &triggers[0]
}

func durationFromMap(m map[string]interface{}) int64 {
	amount := intFromAny(firstAny(m, "amount", "delay_amount", "duration"))
	unit := strings.ToLower(firstString(m, "unit", "delay_type", "duration_unit"))
	if amount == 0 {
		return 0
	}
	return delayToSeconds(amount, unit)
}

func firstArray(m map[string]interface{}, keys ...string) []interface{} {
	for _, key := range keys {
		if raw, ok := m[key].([]interface{}); ok {
			return raw
		}
	}
	return nil
}

func firstAny(m map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			return v
		}
	}
	return nil
}

func firstString(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		switch v := m[key].(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return v
			}
		case float64:
			return fmt.Sprintf("%.0f", v)
		case int:
			return fmt.Sprintf("%d", v)
		case json.Number:
			return v.String()
		}
	}
	return ""
}

func intFromAny(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	case string:
		var i int
		_, _ = fmt.Sscanf(n, "%d", &i)
		return i
	default:
		return 0
	}
}

func cloneAnyMap(in map[string]interface{}) map[string]interface{} {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]interface{}, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func translateTemplate(t mcTemplate, defaultContent mcTemplateDefaultContent, warnings ...string) canonical.EmailTemplate {
	name := strings.TrimSpace(t.Name)
	if name == "" {
		name = fmt.Sprintf("Mailchimp template %d", t.ID)
	}
	sourceDef := map[string]interface{}{
		"template":        t.Raw,
		"default_content": defaultContent.Raw,
	}
	raw, _ := json.Marshal(sourceDef)
	htmlBody := strings.TrimSpace(t.HTML)
	if htmlBody == "" {
		htmlBody = templateHTMLFromDefaultContent(name, defaultContent)
		if len(defaultContent.Sections) > 0 {
			warnings = append(warnings, "template HTML was absent; generated HTML from Mailchimp default editable content")
		} else {
			warnings = append(warnings, "template HTML and default editable content were absent; generated a placeholder shell")
		}
	}
	return canonical.EmailTemplate{
		SourceID:         fmt.Sprintf("%d", t.ID),
		Name:             name,
		Subject:          t.Subject,
		PreviewText:      t.PreviewText,
		HTML:             htmlBody,
		DefaultContent:   defaultContent.Raw,
		SourceDefinition: string(raw),
		Warnings:         warnings,
		SourcePlatform:   canonical.SourceMailchimp,
	}
}

func templateHTMLFromDefaultContent(name string, content mcTemplateDefaultContent) string {
	var b strings.Builder
	b.WriteString("<!doctype html><html><body>")
	b.WriteString("<h1>")
	b.WriteString(html.EscapeString(name))
	b.WriteString("</h1>")
	for _, section := range content.Sections {
		if section.Name == "" && section.Value == nil {
			continue
		}
		b.WriteString("<section data-mailchimp-section=\"")
		b.WriteString(html.EscapeString(section.Name))
		b.WriteString("\">")
		switch v := section.Value.(type) {
		case string:
			if strings.Contains(v, "<") {
				b.WriteString(v)
			} else {
				b.WriteString("<p>")
				b.WriteString(html.EscapeString(v))
				b.WriteString("</p>")
			}
		default:
			raw, _ := json.Marshal(v)
			b.WriteString("<pre>")
			b.WriteString(html.EscapeString(string(raw)))
			b.WriteString("</pre>")
		}
		b.WriteString("</section>")
	}
	b.WriteString("</body></html>")
	return b.String()
}

func mapAutomationStatus(s string) string {
	switch s {
	case "active", "running", "sending", "started", "published":
		return "paused"
	case "paused":
		return "paused"
	case "archived", "deleted":
		return "archived"
	default:
		return "draft"
	}
}

func delayToSeconds(amount int, unit string) int64 {
	switch unit {
	case "hour":
		return int64(amount) * 3600
	case "day":
		return int64(amount) * 86400
	case "week":
		return int64(amount) * 604800
	default:
		return int64(amount) * 60
	}
}
