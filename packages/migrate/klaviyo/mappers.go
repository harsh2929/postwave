// SPDX-License-Identifier: MIT

package klaviyo

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// --- Klaviyo wire types (JSON:API) ---

// kvResource is the minimal JSON:API resource — used for discovery counts and
// list/segment id-name lookups.
type kvResource struct {
	Type          string                     `json:"type"`
	ID            string                     `json:"id"`
	Attributes    json.RawMessage            `json:"attributes"`
	Relationships map[string]json.RawMessage `json:"relationships,omitempty"`
}

type kvLinks struct {
	Next string `json:"next"`
	Prev string `json:"prev"`
	Self string `json:"self"`
}

type kvProfile struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Attributes struct {
		Email         string                 `json:"email"`
		ExternalID    string                 `json:"external_id"`
		FirstName     string                 `json:"first_name"`
		LastName      string                 `json:"last_name"`
		Phone         string                 `json:"phone_number"`
		Organization  string                 `json:"organization"`
		Title         string                 `json:"title"`
		Locale        string                 `json:"locale"`
		Image         string                 `json:"image"`
		Created       string                 `json:"created"`
		Updated       string                 `json:"updated"`
		LastEventDate string                 `json:"last_event_date"`
		Location      map[string]interface{} `json:"location"`
		Properties    map[string]interface{} `json:"properties"`
		Subscriptions json.RawMessage        `json:"subscriptions"`
		Predictive    map[string]interface{} `json:"predictive_analytics"`
	} `json:"attributes"`
}

type kvSubscriptions struct {
	Email *struct {
		Marketing *kvEmailMarketing `json:"marketing"`
	} `json:"email"`
	SMS        json.RawMessage `json:"sms"`
	MobilePush json.RawMessage `json:"mobile_push"`
	WhatsApp   json.RawMessage `json:"whatsapp"`
}

type kvEmailMarketing struct {
	CanReceive         *bool                    `json:"can_receive_email_marketing"`
	Consent            string                   `json:"consent"`
	ConsentTimestamp   string                   `json:"consent_timestamp"`
	LastUpdated        string                   `json:"last_updated"`
	Method             string                   `json:"method"`
	MethodDetail       string                   `json:"method_detail"`
	CustomMethodDetail string                   `json:"custom_method_detail"`
	DoubleOptIn        *bool                    `json:"double_optin"`
	Suppression        []kvEmailSuppression     `json:"suppression"`
	ListSuppressions   []kvEmailListSuppression `json:"list_suppressions"`
}

type kvEmailSuppression struct {
	Reason    string `json:"reason"`
	Timestamp string `json:"timestamp"`
}

type kvEmailListSuppression struct {
	ListID    string `json:"list_id"`
	Reason    string `json:"reason"`
	Timestamp string `json:"timestamp"`
}

type kvCampaign struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Attributes struct {
		Name            string                 `json:"name"`
		Status          string                 `json:"status"`
		Channel         string                 `json:"channel"`
		CreatedAt       string                 `json:"created_at"`
		UpdatedAt       string                 `json:"updated_at"`
		ScheduledAt     string                 `json:"scheduled_at"`
		SendTime        string                 `json:"send_time"`
		Archived        bool                   `json:"archived"`
		Audiences       map[string]interface{} `json:"audiences"`
		SendOptions     map[string]interface{} `json:"send_options"`
		SendStrategy    map[string]interface{} `json:"send_strategy"`
		TrackingOptions map[string]interface{} `json:"tracking_options"`
	} `json:"attributes"`
	Relationships struct {
		Messages struct {
			Data []kvResourceIdentifier `json:"data"`
		} `json:"campaign-messages"`
		Tags struct {
			Data []kvResourceIdentifier `json:"data"`
		} `json:"tags"`
	} `json:"relationships"`
}

type kvResourceIdentifier struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type kvMessageDefinition struct {
	Label   string                 `json:"label"`
	Channel string                 `json:"channel"`
	Content map[string]interface{} `json:"content"`
	Raw     json.RawMessage        `json:"-"`
}

func (d *kvMessageDefinition) UnmarshalJSON(raw []byte) error {
	type wire kvMessageDefinition
	var decoded wire
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	*d = kvMessageDefinition(decoded)
	d.Raw = append(d.Raw[:0], raw...)
	return nil
}

func (d kvMessageDefinition) MarshalJSON() ([]byte, error) {
	if len(d.Raw) > 0 {
		return append([]byte(nil), d.Raw...), nil
	}
	type wire kvMessageDefinition
	return json.Marshal(wire(d))
}

type kvMessage struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Attributes struct {
		Definition *kvMessageDefinition `json:"definition"`
		CreatedAt  string               `json:"created_at"`
		UpdatedAt  string               `json:"updated_at"`
		SendTimes  []struct {
			Datetime string `json:"datetime"`
			IsLocal  *bool  `json:"is_local"`
		} `json:"send_times"`
	} `json:"attributes"`
	Relationships struct {
		Template struct {
			Data *kvResourceIdentifier `json:"data"`
		} `json:"template"`
		Campaign struct {
			Data *kvResourceIdentifier `json:"data"`
		} `json:"campaign"`
		Image struct {
			Data *kvResourceIdentifier `json:"data"`
		} `json:"image"`
	} `json:"relationships"`
}

type kvTemplate struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Attributes struct {
		Name       string          `json:"name"`
		HTML       string          `json:"html"`
		Text       string          `json:"text"`
		AMP        string          `json:"amp"`
		EditorType string          `json:"editor_type"`
		Created    string          `json:"created"`
		Updated    string          `json:"updated"`
		Definition json.RawMessage `json:"definition"`
	} `json:"attributes"`
}

// --- mappers ---

func mapProfile(p kvProfile, membershipTags []string) (canonical.Subscriber, error) {
	attrs := p.Attributes
	if p.Type != "profile" || !validProviderID(p.ID) || !validEmail(attrs.Email) {
		return canonical.Subscriber{}, fmt.Errorf("klaviyo profile returned an invalid email identity: %w", adapter.ErrSourceUnavailable)
	}
	var subscriptions kvSubscriptions
	if len(attrs.Subscriptions) > 0 && string(attrs.Subscriptions) != "null" {
		if err := json.Unmarshal(attrs.Subscriptions, &subscriptions); err != nil {
			return canonical.Subscriber{}, fmt.Errorf("klaviyo profile %q subscriptions: %w", p.ID, adapter.ErrSourceUnavailable)
		}
	}
	var marketing *kvEmailMarketing
	if subscriptions.Email != nil {
		marketing = subscriptions.Email.Marketing
	}

	status := canonical.StatusUnconfirmed
	consentSource := canonical.ConsentUnknown
	var ts *time.Time
	if marketing != nil {
		if marketing.CanReceive == nil || strings.TrimSpace(marketing.Consent) == "" {
			return canonical.Subscriber{}, fmt.Errorf("klaviyo profile %q omitted required email-marketing consent fields: %w", p.ID, adapter.ErrSourceUnavailable)
		}
		if marketing.ConsentTimestamp != "" {
			parsed, err := parseRequiredKlaviyoTime(marketing.ConsentTimestamp)
			if err != nil {
				return canonical.Subscriber{}, fmt.Errorf("klaviyo profile %q consent timestamp: %w", p.ID, err)
			}
			ts = &parsed
		}
		if marketing.DoubleOptIn != nil {
			if *marketing.DoubleOptIn {
				consentSource = canonical.ConsentDoubleOptIn
			} else {
				consentSource = canonical.ConsentSingleOptIn
			}
		}
		switch strings.ToUpper(strings.TrimSpace(marketing.Consent)) {
		case "SUBSCRIBED":
			if *marketing.CanReceive && len(marketing.Suppression) == 0 && ts != nil {
				status = canonical.StatusEnabled
			} else {
				status = canonical.StatusDisabled
			}
		case "UNSUBSCRIBED":
			status = canonical.StatusDisabled
		case "NEVER_SUBSCRIBED":
			status = canonical.StatusUnconfirmed
		default:
			return canonical.Subscriber{}, fmt.Errorf("klaviyo profile %q returned unknown email consent %q: %w", p.ID, marketing.Consent, adapter.ErrSourceUnavailable)
		}
		for _, suppression := range marketing.Suppression {
			if strings.TrimSpace(suppression.Timestamp) == "" || strings.TrimSpace(suppression.Reason) == "" {
				return canonical.Subscriber{}, fmt.Errorf("klaviyo profile %q returned incomplete global suppression evidence: %w", p.ID, adapter.ErrSourceUnavailable)
			}
			if _, err := parseRequiredKlaviyoTime(suppression.Timestamp); err != nil {
				return canonical.Subscriber{}, fmt.Errorf("klaviyo profile %q suppression timestamp: %w", p.ID, err)
			}
			switch strings.ToUpper(strings.TrimSpace(suppression.Reason)) {
			case "HARD_BOUNCE", "INVALID_EMAIL", "SPAM_COMPLAINT":
				status = canonical.StatusBlocklisted
			case "UNSUBSCRIBE", "USER_SUPPRESSED":
				if status != canonical.StatusBlocklisted {
					status = canonical.StatusDisabled
				}
			default:
				return canonical.Subscriber{}, fmt.Errorf("klaviyo profile %q returned unknown suppression reason %q: %w", p.ID, suppression.Reason, adapter.ErrSourceUnavailable)
			}
		}
	}

	tags := append([]string(nil), membershipTags...)
	suppressedLists, err := profileSuppressedListTags(p)
	if err != nil {
		return canonical.Subscriber{}, err
	}
	if len(suppressedLists) > 0 {
		filtered := tags[:0]
		for _, tag := range tags {
			if _, suppressed := suppressedLists[tag]; !suppressed {
				filtered = append(filtered, tag)
			}
		}
		tags = filtered
	}
	tags = uniqueStrings(tags)

	var subscriptionEvidence interface{}
	if len(attrs.Subscriptions) > 0 && string(attrs.Subscriptions) != "null" {
		if err := json.Unmarshal(attrs.Subscriptions, &subscriptionEvidence); err != nil {
			return canonical.Subscriber{}, fmt.Errorf("klaviyo profile %q preserve subscriptions: %w", p.ID, err)
		}
	}
	custom := map[string]interface{}{
		"klaviyo": map[string]interface{}{
			"profile_id":           p.ID,
			"external_id":          attrs.ExternalID,
			"created":              attrs.Created,
			"updated":              attrs.Updated,
			"last_event_date":      attrs.LastEventDate,
			"locale":               attrs.Locale,
			"title":                attrs.Title,
			"image":                attrs.Image,
			"location":             attrs.Location,
			"properties":           attrs.Properties,
			"subscriptions":        subscriptionEvidence,
			"predictive_analytics": attrs.Predictive,
		},
	}
	if attrs.FirstName != "" {
		custom["first_name"] = attrs.FirstName
	}
	if attrs.LastName != "" {
		custom["last_name"] = attrs.LastName
	}
	if attrs.Phone != "" {
		custom["phone"] = attrs.Phone
	}
	if attrs.Organization != "" {
		custom["organization"] = attrs.Organization
	}
	name := strings.TrimSpace(strings.TrimSpace(attrs.FirstName) + " " + strings.TrimSpace(attrs.LastName))
	if name != "" {
		custom["name"] = name
	}

	return canonical.Subscriber{
		Email:            strings.TrimSpace(attrs.Email),
		Status:           status,
		ConsentTimestamp: ts,
		ConsentSource:    consentSource,
		CustomFields:     custom,
		Tags:             tags,
		SourceID:         p.ID,
		SourcePlatform:   canonical.SourceKlaviyo,
	}, nil
}

// profileSuppressedListTags returns only validated list-level email
// suppressions. Discovery uses the same send-targetable projection as
// subscriber mapping, so its post-suppression membership totals cannot count
// a tag that the subscriber importer is required to remove. These are not raw
// provider membership totals.
func profileSuppressedListTags(p kvProfile) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	if len(p.Attributes.Subscriptions) == 0 || string(p.Attributes.Subscriptions) == "null" {
		return out, nil
	}
	var subscriptions kvSubscriptions
	if err := json.Unmarshal(p.Attributes.Subscriptions, &subscriptions); err != nil {
		return nil, fmt.Errorf("klaviyo profile %q subscriptions: %w", p.ID, adapter.ErrSourceUnavailable)
	}
	if subscriptions.Email == nil || subscriptions.Email.Marketing == nil {
		return out, nil
	}
	for _, suppression := range subscriptions.Email.Marketing.ListSuppressions {
		if !validProviderID(suppression.ListID) || strings.TrimSpace(suppression.Reason) == "" || strings.TrimSpace(suppression.Timestamp) == "" {
			return nil, fmt.Errorf("klaviyo profile %q returned incomplete list suppression evidence: %w", p.ID, adapter.ErrSourceUnavailable)
		}
		if _, err := parseRequiredKlaviyoTime(suppression.Timestamp); err != nil {
			return nil, fmt.Errorf("klaviyo profile %q list suppression timestamp: %w", p.ID, err)
		}
		out[listMembershipTag(suppression.ListID)] = struct{}{}
	}
	return out, nil
}

// translateListAsSegment maps a Klaviyo list to a canonical segment defined as
// membership in the list (we project lists onto our segment-of-tag model).
func translateListAsSegment(r kvResource) canonical.Segment {
	tag := listMembershipTag(r.ID)
	name := resourceName(r)
	if name == "" {
		name = listDisplayName(r)
	} else {
		name = "List: " + name
	}
	raw, _ := json.Marshal(map[string]interface{}{
		"migration_mode": "static_membership_snapshot",
		"source_id":      tag,
		"source":         resourceSource(r),
	})
	return canonical.Segment{
		Name:        name,
		Description: "Frozen Klaviyo list membership mapped to a tag-backed Moosewave segment.",
		QueryAST: canonical.SegmentNode{
			Op:         "condition",
			Field:      "tag",
			Comparator: "equals",
			Value:      tag,
		},
		SourceDefinition: string(raw),
	}
}

func translateSegment(r kvResource) canonical.Segment {
	tag := segmentMembershipTag(r.ID)
	raw, _ := json.Marshal(map[string]interface{}{
		"migration_mode": "static_membership_snapshot",
		"source_id":      tag,
		"source":         resourceSource(r),
		"limitation":     "The exact cutover membership is executable. Klaviyo's dynamic predicate is preserved but not translated, so future membership changes require a native Moosewave rebuild.",
	})
	return canonical.Segment{
		Name:             segmentDisplayName(r),
		Description:      "Frozen Klaviyo dynamic-segment membership; rebuild the source predicate before expecting live reevaluation.",
		QueryAST:         canonical.SegmentNode{Op: "condition", Field: "tag", Comparator: "equals", Value: tag},
		SourceDefinition: string(raw),
	}
}

func translateFlow(r kvResource) canonical.Automation {
	return translateFlowWithActions(r, nil)
}

func translateFlowWithActions(r kvResource, actions []kvResource) canonical.Automation {
	limitation := "Klaviyo flow definitions, graph links, branches, filters, and action/message metadata are preserved for rebuild. They are never activated as a Moosewave runtime graph automatically."
	if !flowDefinitionAvailable(r) {
		limitation = "Klaviyo returned a null encoded definition for this flow. Available metadata is preserved, but the graph is not rebuild-complete; recover it from a provider export or explicitly retire the flow during review."
	}
	raw, _ := json.Marshal(map[string]interface{}{
		"migration_mode":   "rebuild_review",
		"source_id":        "klaviyo:flow:" + strings.TrimSpace(r.ID),
		"source":           resourceSource(r),
		"included_actions": resourcesToSource(actions),
		"limitation":       limitation,
	})
	return canonical.Automation{
		Name:             firstNonEmpty(resourceName(r), "Klaviyo flow "+strings.TrimSpace(r.ID)),
		Status:           "draft",
		Triggers:         nil,
		Nodes:            nil,
		Edges:            nil,
		SourceDefinition: string(raw),
	}
}

func mapTriggerType(t string) string {
	switch strings.ToLower(t) {
	case "list", "added-to-list":
		return "subscriber_added_to_list"
	case "metric", "event":
		return "custom_event"
	case "date-based", "date":
		return "date_field"
	default:
		return t
	}
}

func translateSegmentDefinition(raw json.RawMessage) canonical.SegmentNode {
	var def map[string]interface{}
	if len(raw) == 0 || json.Unmarshal(raw, &def) != nil {
		return canonical.SegmentNode{Op: "and"}
	}
	if groups := firstArray(def, "condition_groups", "groups"); len(groups) > 0 {
		children := make([]canonical.SegmentNode, 0, len(groups))
		for _, item := range groups {
			group, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			if node := segmentGroupNode(group); node.Op != "" {
				children = append(children, node)
			}
		}
		return combineSegmentChildren(segmentOperator(def, "AND"), children)
	}
	if conditions := firstArray(def, "conditions", "rules", "filters"); len(conditions) > 0 {
		children := make([]canonical.SegmentNode, 0, len(conditions))
		for _, item := range conditions {
			if condition, ok := item.(map[string]interface{}); ok {
				if node := segmentConditionNode(condition); node.Op != "" {
					children = append(children, node)
				}
			}
		}
		return combineSegmentChildren(segmentOperator(def, "AND"), children)
	}
	if node := segmentConditionNode(def); node.Op != "" {
		return node
	}
	return canonical.SegmentNode{Op: "and"}
}

func segmentGroupNode(group map[string]interface{}) canonical.SegmentNode {
	children := []canonical.SegmentNode{}
	for _, item := range firstArray(group, "conditions", "rules", "filters") {
		condition, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if node := segmentConditionNode(condition); node.Op != "" {
			children = append(children, node)
		}
	}
	return combineSegmentChildren(segmentOperator(group, "AND"), children)
}

func segmentConditionNode(condition map[string]interface{}) canonical.SegmentNode {
	typ := strings.ToLower(firstString(condition, "type", "condition_type", "resource_type"))
	field := firstString(condition, "field", "property", "dimension", "attribute", "key")
	switch {
	case strings.Contains(typ, "list"):
		field = "list"
	case strings.Contains(typ, "segment"):
		field = "segment"
	case strings.Contains(typ, "metric") || strings.Contains(typ, "event"):
		field = firstNonEmpty(firstString(condition, "metric", "metric_name", "event_name", "name"), "event")
	case strings.Contains(typ, "profile") && field == "":
		field = "profile"
	}
	if field == "" {
		return canonical.SegmentNode{}
	}
	return canonical.SegmentNode{
		Op:         "condition",
		Field:      field,
		Comparator: mapComparator(firstString(condition, "operator", "comparator", "comparison", "predicate")),
		Value:      firstValue(condition, "value", "values", "list_id", "segment_id", "metric_id"),
	}
}

func combineSegmentChildren(op string, children []canonical.SegmentNode) canonical.SegmentNode {
	if len(children) == 0 {
		return canonical.SegmentNode{Op: strings.ToLower(op)}
	}
	if len(children) == 1 {
		return children[0]
	}
	return canonical.SegmentNode{Op: strings.ToLower(op), Children: children}
}

func segmentOperator(in map[string]interface{}, fallback string) string {
	raw := strings.ToUpper(firstString(in, "operator", "group_operator", "condition_group_operator", "connector", "match"))
	switch raw {
	case "OR", "ANY":
		return "or"
	case "AND", "ALL":
		return "and"
	default:
		return strings.ToLower(fallback)
	}
}

func mapComparator(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "equals", "equal", "eq", "is":
		return "equals"
	case "not_equals", "not equal", "neq", "is_not":
		return "not_equals"
	case "contains", "includes":
		return "contains"
	case "does_not_contain", "not_contains":
		return "not_contains"
	case "greater_than", "gt", "after":
		return "greater_than"
	case "greater_or_equal", "gte":
		return "greater_or_equal"
	case "less_than", "lt", "before":
		return "less_than"
	case "less_or_equal", "lte":
		return "less_or_equal"
	case "in", "one_of":
		return "in"
	default:
		return strings.ToLower(strings.TrimSpace(raw))
	}
}

func triggerFromKlaviyoMap(in map[string]interface{}) canonical.AutomationTrigger {
	if in == nil {
		return canonical.AutomationTrigger{}
	}
	typ := strings.ToLower(firstString(in, "type", "trigger_type", "kind"))
	trigger := canonical.AutomationTrigger{Type: mapTriggerType(typ), Metadata: cloneMapAny(in)}
	switch trigger.Type {
	case "subscriber_added_to_list":
		trigger.ListID = firstString(in, "list_id", "list", "id")
	case "custom_event":
		trigger.EventName = firstNonEmpty(firstString(in, "metric", "metric_name", "event_name", "name"), "klaviyo.metric")
	case "date_field":
		trigger.Field = firstString(in, "field", "property", "date_field")
	}
	return trigger
}

func flowNodesAndEdges(actions []kvResource) ([]canonical.AutomationNode, []canonical.AutomationEdge) {
	if len(actions) == 0 {
		return nil, nil
	}
	ordered := append([]kvResource(nil), actions...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return actionOrder(ordered[i]) < actionOrder(ordered[j])
	})
	nodes := make([]canonical.AutomationNode, 0, len(ordered))
	for i, action := range ordered {
		nodes = append(nodes, flowNodeFromAction(i, action))
	}
	edges := make([]canonical.AutomationEdge, 0, len(nodes)-1)
	for i := 1; i < len(nodes); i++ {
		edges = append(edges, canonical.AutomationEdge{From: nodes[i-1].ID, To: nodes[i].ID})
	}
	return nodes, edges
}

func flowNodeFromAction(i int, action kvResource) canonical.AutomationNode {
	attrs := rawMap(action.Attributes)
	id := action.ID
	if id == "" {
		id = fmt.Sprintf("klaviyo-action-%d", i)
	}
	kind := strings.ToLower(firstString(attrs, "action_type", "type", "kind", "name"))
	node := canonical.AutomationNode{ID: id, Metadata: cloneMapAny(attrs), RawSource: cloneMapAny(attrs)}
	switch {
	// Order matters: more-specific cases first so e.g. "wait-until-condition"
	// doesn't fall through to a plain wait.
	case kind == "wait-until-condition" || (strings.Contains(kind, "wait") && strings.Contains(kind, "condition")):
		node.Type = "wait_for_condition"
		node.TimeoutSeconds = durationSeconds(attrs)
		if cond := conditionFromKlaviyoMap(attrs); cond != nil {
			node.Condition = cond
		}
	case strings.Contains(kind, "delay") || strings.Contains(kind, "wait"):
		node.Type = "wait"
		node.DurationSeconds = durationSeconds(attrs)
	case strings.Contains(kind, "email"):
		node.Type = "send_email"
		node.TemplateID = firstString(attrs, "template_id", "message_id", "email_template_id")
		if node.TemplateID == "" {
			node.TemplateID = action.ID
		}
	case strings.Contains(kind, "sms") || strings.Contains(kind, "text"):
		node.Type = "send_sms"
		node.SMSBody = firstString(attrs, "body", "message", "text")
	case kind == "update-profile" || (strings.Contains(kind, "update") && strings.Contains(kind, "profile")):
		node.Type = "update_subscriber"
		node.Action = &canonical.AutomationAction{
			Kind:       "update_subscriber",
			Properties: extractProfileProperties(attrs),
			Metadata:   cloneMapAny(attrs),
		}
	case kind == "add-to-list" || kind == "remove-from-list" ||
		(strings.Contains(kind, "list") && (strings.Contains(kind, "add") || strings.Contains(kind, "remove"))):
		node.Type = "list_membership"
		listAction := "list_add"
		if strings.Contains(kind, "remove") {
			listAction = "list_remove"
		}
		node.Action = &canonical.AutomationAction{
			Kind:     listAction,
			ListID:   firstString(attrs, "list_id", "list", "id"),
			Metadata: cloneMapAny(attrs),
		}
	case kind == "set-conversion-goal" || strings.Contains(kind, "conversion-goal") || strings.Contains(kind, "set-goal"):
		node.Type = "set_goal"
		if cond := conditionFromKlaviyoMap(attrs); cond != nil {
			node.Goal = cond
		} else {
			node.Goal = &canonical.SegmentCondition{
				Op:         "condition",
				Field:      firstNonEmpty(firstString(attrs, "metric", "metric_name", "event_name", "name"), "goal"),
				Comparator: "equals",
				Value:      firstValue(attrs, "value", "metric_id"),
			}
		}
	case kind == "notify-team" || (strings.Contains(kind, "notify") && strings.Contains(kind, "team")):
		url := firstString(attrs, "url", "webhook_url", "slack_url")
		node.Type = "webhook_emit"
		node.WebhookURL = url
		node.WebhookMethod = firstNonEmpty(strings.ToUpper(firstString(attrs, "method", "webhook_method")), "POST")
		target := "generic"
		if strings.Contains(strings.ToLower(url), "slack") {
			target = "slack"
		}
		node.WebhookTarget = target
		node.Action = &canonical.AutomationAction{
			Kind:    "webhook_emit",
			URL:     url,
			Message: firstString(attrs, "message", "label", "name"),
			Metadata: map[string]interface{}{
				"target": target,
			},
		}
	case strings.Contains(kind, "webhook"):
		node.Type = "webhook"
		node.WebhookURL = firstString(attrs, "url", "webhook_url")
		node.WebhookMethod = firstNonEmpty(strings.ToUpper(firstString(attrs, "method", "webhook_method")), "POST")
	case strings.Contains(kind, "split") || strings.Contains(kind, "branch") || strings.Contains(kind, "conditional"):
		node.Type = "branch"
		if cond := conditionFromKlaviyoMap(attrs); cond != nil {
			node.Condition = cond
		}
	default:
		node.Type = "action"
		node.Action = actionFromKlaviyoMap(kind, attrs)
	}
	return node
}

// extractProfileProperties pulls the assignment map out of an update-profile
// Klaviyo action. Klaviyo encodes the changes a few different ways across
// account vintages, so check the common shapes before falling back to a single
// field/value pair.
func extractProfileProperties(attrs map[string]interface{}) map[string]interface{} {
	if props, ok := attrs["properties"].(map[string]interface{}); ok && len(props) > 0 {
		return cloneMapAny(props)
	}
	if props, ok := attrs["profile_properties"].(map[string]interface{}); ok && len(props) > 0 {
		return cloneMapAny(props)
	}
	if assigns, ok := attrs["assignments"].([]interface{}); ok && len(assigns) > 0 {
		out := make(map[string]interface{}, len(assigns))
		for _, a := range assigns {
			m, ok := a.(map[string]interface{})
			if !ok {
				continue
			}
			field := firstString(m, "field", "property", "key", "name")
			if field == "" {
				continue
			}
			out[field] = firstValue(m, "value")
		}
		if len(out) > 0 {
			return out
		}
	}
	if field := firstString(attrs, "field", "property", "key"); field != "" {
		return map[string]interface{}{field: firstValue(attrs, "value")}
	}
	return nil
}

func actionFromKlaviyoMap(kind string, attrs map[string]interface{}) *canonical.AutomationAction {
	action := &canonical.AutomationAction{Metadata: cloneMapAny(attrs)}
	switch {
	case strings.Contains(kind, "unsubscribe"):
		action.Kind = "unsubscribe"
	case strings.Contains(kind, "remove") && strings.Contains(kind, "tag"):
		action.Kind = "remove_tag"
		action.Tag = firstString(attrs, "tag", "tag_name")
	case strings.Contains(kind, "tag"):
		action.Kind = "add_tag"
		action.Tag = firstString(attrs, "tag", "tag_name")
	case strings.Contains(kind, "list"):
		action.Kind = "move_to_list"
		action.ListID = firstString(attrs, "list_id", "list")
	case strings.Contains(kind, "profile") || strings.Contains(kind, "property"):
		action.Kind = "update_contact"
		action.Field = firstString(attrs, "field", "property", "key")
		action.Value = firstValue(attrs, "value")
	default:
		action.Kind = "notify"
		action.Message = firstString(attrs, "name", "label", "message")
	}
	return action
}

func conditionFromKlaviyoMap(attrs map[string]interface{}) *canonical.SegmentCondition {
	node := segmentConditionNode(attrs)
	if node.Op != "condition" {
		return nil
	}
	return &canonical.SegmentCondition{
		Op:         "condition",
		Field:      node.Field,
		Comparator: node.Comparator,
		Value:      node.Value,
	}
}

func flowSourceDefinition(flow kvResource, actions []kvResource) string {
	if len(actions) == 0 {
		return string(flow.Attributes)
	}
	raw, _ := json.Marshal(map[string]interface{}{
		"flow":    rawMap(flow.Attributes),
		"actions": resourcesToSource(actions),
	})
	return string(raw)
}

func resourcesToSource(items []kvResource) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		out = append(out, map[string]interface{}{
			"id":            item.ID,
			"type":          item.Type,
			"attributes":    rawMap(item.Attributes),
			"relationships": item.Relationships,
		})
	}
	return out
}

func rawMap(raw json.RawMessage) map[string]interface{} {
	out := map[string]interface{}{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}

func firstArray(m map[string]interface{}, keys ...string) []interface{} {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			switch typed := v.(type) {
			case []interface{}:
				return typed
			case []map[string]interface{}:
				out := make([]interface{}, 0, len(typed))
				for _, item := range typed {
					out = append(out, item)
				}
				return out
			}
		}
	}
	return nil
}

func firstString(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			switch typed := v.(type) {
			case string:
				if strings.TrimSpace(typed) != "" {
					return strings.TrimSpace(typed)
				}
			case fmt.Stringer:
				if strings.TrimSpace(typed.String()) != "" {
					return strings.TrimSpace(typed.String())
				}
			}
		}
	}
	return ""
}

func firstValue(m map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			return v
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func cloneMapAny(in map[string]interface{}) map[string]interface{} {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]interface{}, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func actionOrder(action kvResource) float64 {
	attrs := rawMap(action.Attributes)
	for _, key := range []string{"position", "sort_order", "order", "sequence", "index"} {
		if n, ok := numericValue(attrs[key]); ok {
			return n
		}
	}
	return 0
}

func durationSeconds(attrs map[string]interface{}) int64 {
	for _, key := range []string{"duration_seconds", "delay_seconds", "seconds"} {
		if n, ok := numericValue(attrs[key]); ok {
			return int64(n)
		}
	}
	for _, key := range []string{"minutes", "delay_minutes"} {
		if n, ok := numericValue(attrs[key]); ok {
			return int64(n * 60)
		}
	}
	for _, key := range []string{"hours", "delay_hours"} {
		if n, ok := numericValue(attrs[key]); ok {
			return int64(n * 3600)
		}
	}
	for _, key := range []string{"days", "delay_days"} {
		if n, ok := numericValue(attrs[key]); ok {
			return int64(n * 86400)
		}
	}
	if delay, ok := attrs["delay"].(map[string]interface{}); ok {
		return durationSeconds(delay)
	}
	return 0
}

func numericValue(v interface{}) (float64, bool) {
	switch typed := v.(type) {
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case json.Number:
		n, err := typed.Float64()
		return n, err == nil
	default:
		return 0, false
	}
}

func mapTemplate(t kvTemplate) (canonical.EmailTemplate, error) {
	name := t.Attributes.Name
	if name == "" {
		name = "Klaviyo template " + t.ID
	}
	if t.Type != "template" || !validProviderID(t.ID) || strings.TrimSpace(t.Attributes.HTML) == "" {
		return canonical.EmailTemplate{}, fmt.Errorf("klaviyo template %q has no editable rendered HTML: %w", t.ID, adapter.ErrSourceUnavailable)
	}
	var definition interface{}
	if len(t.Attributes.Definition) > 0 && string(t.Attributes.Definition) != "null" {
		if err := json.Unmarshal(t.Attributes.Definition, &definition); err != nil {
			return canonical.EmailTemplate{}, fmt.Errorf("klaviyo template %q definition: %w", t.ID, adapter.ErrSourceUnavailable)
		}
	}
	source, _ := json.Marshal(map[string]interface{}{
		"source_id":   "klaviyo:template:" + t.ID,
		"id":          t.ID,
		"type":        t.Type,
		"name":        t.Attributes.Name,
		"editor_type": t.Attributes.EditorType,
		"text":        t.Attributes.Text,
		"amp":         t.Attributes.AMP,
		"definition":  definition,
		"created":     t.Attributes.Created,
		"updated":     t.Attributes.Updated,
	})
	return canonical.EmailTemplate{
		SourceID:         t.ID,
		Name:             name,
		HTML:             t.Attributes.HTML,
		DefaultContent:   map[string]interface{}{"text": t.Attributes.Text, "amp": t.Attributes.AMP},
		SourceDefinition: string(source),
		SourcePlatform:   canonical.SourceKlaviyo,
	}, nil
}

func resourceSource(resource kvResource) map[string]interface{} {
	return map[string]interface{}{
		"id":            resource.ID,
		"type":          resource.Type,
		"attributes":    rawMap(resource.Attributes),
		"relationships": resource.Relationships,
	}
}

func parseRequiredKlaviyoTime(raw string) (time.Time, error) {
	parsed := parseKlaviyoTime(raw)
	if parsed.IsZero() {
		return time.Time{}, fmt.Errorf("invalid timestamp %q: %w", raw, adapter.ErrSourceUnavailable)
	}
	return parsed, nil
}

func campaignIsSent(campaign kvCampaign) bool {
	status := strings.ToLower(strings.TrimSpace(campaign.Attributes.Status))
	return status == "sent" || status == "variations sent"
}

func cloneIntMap(in map[string]int) map[string]int {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]int, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
