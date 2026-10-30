// SPDX-License-Identifier: MIT

package customerio

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/mail"
	"sort"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// flexibleString accepts the string identifiers documented by Customer.io as
// well as the integer-shaped identifiers present in some official examples.
// Fractions, exponents, booleans, objects, and arrays are rejected.
type flexibleString string

func (value *flexibleString) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		*value = ""
		return nil
	}
	if len(data) > 0 && data[0] == '"' {
		var decoded string
		if err := json.Unmarshal(data, &decoded); err != nil {
			return err
		}
		*value = flexibleString(decoded)
		return nil
	}
	text := string(data)
	if text == "" || strings.ContainsAny(text, ".eE+-") {
		return fmt.Errorf("expected a string or unsigned integer identifier")
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return fmt.Errorf("expected a string or unsigned integer identifier")
		}
	}
	*value = flexibleString(text)
	return nil
}

type cioWorkspace struct {
	ID     flexibleString `json:"id"`
	Name   string         `json:"name"`
	People int            `json:"people"`
}

type cioIdentifiers struct {
	Email *string        `json:"email"`
	ID    flexibleString `json:"id"`
	CIOID flexibleString `json:"cio_id"`
}

type cioCustomerSearchPage struct {
	Identifiers *[]cioIdentifiers `json:"identifiers"`
	Next        string            `json:"next"`
}

type cioCustomerDetail struct {
	ID           flexibleString             `json:"id"`
	Identifiers  cioIdentifiers             `json:"identifiers"`
	Attributes   map[string]json.RawMessage `json:"attributes"`
	Timestamps   map[string]int64           `json:"timestamps"`
	Unsubscribed *bool                      `json:"unsubscribed"`
	Devices      []map[string]interface{}   `json:"devices"`
}

type cioCustomerDetailResponse struct {
	Customer cioCustomerDetail `json:"customer"`
}

type cioCustomerTopicPreference struct {
	ID          flexibleString `json:"id"`
	Subscribed  *bool          `json:"subscribed"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
}

type cioCustomerPreferencesResponse struct {
	Customer struct {
		ID           flexibleString                `json:"id"`
		Identifiers  cioIdentifiers                `json:"identifiers"`
		Topics       *[]cioCustomerTopicPreference `json:"topics"`
		Channels     json.RawMessage               `json:"channels"`
		Unsubscribed *bool                         `json:"unsubscribed"`
	} `json:"customer"`
}

type cioSubscriptionChannel struct {
	ID                  flexibleString `json:"id"`
	Type                string         `json:"type"`
	Name                string         `json:"name"`
	Description         string         `json:"description"`
	SubscribedByDefault *bool          `json:"subscribed_by_default"`
}

type cioSegment struct {
	ID            flexibleString `json:"id"`
	DeduplicateID string         `json:"deduplicate_id"`
	Name          string         `json:"name"`
	Description   string         `json:"description"`
	Type          string         `json:"type"`
	State         string         `json:"state"`
	Progress      *int           `json:"progress"`
	Tags          []string       `json:"tags"`
	CreatedAt     int64          `json:"created_at"`
	UpdatedAt     int64          `json:"updated_at"`
}

type cioSubscriptionTopic struct {
	ID                  flexibleString `json:"id"`
	Identifier          string         `json:"identifier"`
	Name                string         `json:"name"`
	Description         string         `json:"description"`
	SubscribedByDefault *bool          `json:"subscribed_by_default"`
}

type cioSuppression struct {
	Created int64  `json:"created"`
	Email   string `json:"email"`
	Reason  string `json:"reason"`
	Status  string `json:"status"`
	Type    string `json:"-"`
}

type cioSuppressionPage struct {
	Category     string            `json:"category"`
	Suppressions *[]cioSuppression `json:"suppressions"`
}

type cioChannelOptout struct {
	CustomerID flexibleString `json:"customer_id"`
	CIOID      flexibleString `json:"cio_id"`
	Optouts    []struct {
		Channel string `json:"channel"`
		From    string `json:"from"`
	} `json:"optouts"`
}

type cioOptoutPage struct {
	Optouts *[]cioChannelOptout `json:"optouts"`
	Next    string              `json:"next"`
}

type cioResource struct {
	ID        string
	Name      string
	Type      string
	State     string
	CreatedAt int64
	UpdatedAt int64
	SentAt    int64
	Raw       map[string]interface{}
}

type cioWorkflowEvidence struct {
	Resource cioResource
	Actions  []cioResource
	Triggers []cioResource
}

type cioNewsletterEvidence struct {
	Resource                cioResource
	Contents                []cioResource
	ArchiveSourceOnlyReason string
}

type cioTransactionalEvidence struct {
	Resource cioResource
	Contents []cioResource
}

type cioDesignEmailEvidence struct {
	Summary      cioResource
	Detail       cioResource
	Translations []map[string]interface{}
}

func parseResource(raw json.RawMessage, resource string) (cioResource, error) {
	payload, err := decodeJSONObject(raw)
	if err != nil {
		return cioResource{}, fmt.Errorf("customerio %s decode resource: %v: %w", resource, err, adapter.ErrSourceUnavailable)
	}
	id, err := requiredSourceID(payload["id"])
	if err != nil {
		return cioResource{}, fmt.Errorf("customerio %s returned an invalid identity: %w", resource, adapter.ErrSourceUnavailable)
	}
	return cioResource{
		ID:        id,
		Name:      sourceString(payload, "name"),
		Type:      strings.ToLower(sourceString(payload, "type")),
		State:     strings.ToLower(sourceString(payload, "state")),
		CreatedAt: firstSourceInt64(payload, "created", "created_at"),
		UpdatedAt: firstSourceInt64(payload, "updated", "updated_at"),
		SentAt:    sourceInt64(payload, "sent_at"),
		Raw:       payload,
	}, nil
}

func mapCustomer(detail cioCustomerDetail, preferences cioProfilePreferenceEvidence, topics []cioSubscriptionTopic, tags []string, suppressions []cioSuppression) (canonical.Subscriber, error) {
	cioID := strings.TrimSpace(string(detail.Identifiers.CIOID))
	if !validProviderID(cioID) {
		return canonical.Subscriber{}, fmt.Errorf("customerio customer attributes returned an invalid cio_id: %w", adapter.ErrSourceUnavailable)
	}
	email := ""
	if detail.Identifiers.Email != nil {
		email = strings.TrimSpace(*detail.Identifiers.Email)
	}
	if email == "" {
		email = strings.TrimSpace(rawAttributeString(detail.Attributes["email"]))
	}
	if !validEmail(email) {
		return canonical.Subscriber{}, fmt.Errorf("customerio profile %q returned an invalid email address: %w", cioID, adapter.ErrSourceUnavailable)
	}

	status := customerIOEmailStatus(detail.Unsubscribed, preferences, topics, len(suppressions) > 0)

	custom := make(map[string]interface{})
	for key, raw := range detail.Attributes {
		if isCustomerIOSystemAttribute(key) {
			continue
		}
		var value interface{}
		if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			continue
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return canonical.Subscriber{}, fmt.Errorf("customerio profile %q attribute %q: %w", cioID, key, adapter.ErrSourceUnavailable)
		}
		custom[key] = value
	}

	metadata := map[string]interface{}{
		"cio_id":                             cioID,
		"global_unsubscribed":                detail.Unsubscribed,
		"topic_preferences":                  cloneBoolMap(preferences.TopicStates),
		"channel_preferences":                cloneBoolMap(preferences.ChannelStates),
		"topic_preference_evidence_complete": preferences.TopicEvidenceComplete,
		"email_channel_configured":           preferences.EmailChannelConfigured,
		"email_channel_evidence_complete":    preferences.EmailChannelEvidenceComplete,
		"preference_evidence_source":         preferences.EvidenceSource,
	}
	if publisherID := strings.TrimSpace(string(detail.Identifiers.ID)); publisherID != "" {
		metadata["publisher_id"] = publisherID
	}
	if timestamp := detail.Timestamps["created_at"]; timestamp > 0 {
		metadata["created_at"] = timestamp
	} else if timestamp = rawAttributeInt64(detail.Attributes["created_at"]); timestamp > 0 {
		metadata["created_at"] = timestamp
	}
	if timestamp := detail.Timestamps["email"]; timestamp > 0 {
		metadata["email_added_at"] = timestamp
	}
	if timestamp := detail.Timestamps["unsubscribed"]; timestamp > 0 {
		metadata["unsubscribed_at"] = timestamp
	}
	if timestamp := detail.Timestamps["cio_subscription_preferences"]; timestamp > 0 {
		metadata["subscription_preferences_updated_at"] = timestamp
	}
	if len(detail.Devices) > 0 {
		platformCounts := map[string]int{}
		for _, device := range detail.Devices {
			platform := strings.ToLower(sourceString(device, "platform"))
			if platform == "" {
				platform = "unknown"
			}
			platformCounts[platform]++
		}
		metadata["device_count"] = len(detail.Devices)
		metadata["device_platform_counts"] = platformCounts
	}
	if len(suppressions) > 0 {
		rows := make([]map[string]interface{}, 0, len(suppressions))
		for _, suppression := range suppressions {
			rows = append(rows, map[string]interface{}{
				"type":       suppression.Type,
				"created_at": suppression.Created,
				"reason":     suppression.Reason,
				"status":     suppression.Status,
			})
		}
		metadata["esp_suppressions"] = rows
	}
	custom["customerio_source"] = metadata

	tags = uniqueStrings(tags)
	return canonical.Subscriber{
		Email:            email,
		Status:           status,
		ConsentTimestamp: nil,
		ConsentSource:    canonical.ConsentUnknown,
		CustomFields:     custom,
		Tags:             tags,
		SourceID:         cioID,
		SourcePlatform:   canonical.SourceCustomerIO,
	}, nil
}

func mapSegment(segment cioSegment) canonical.Segment {
	tag := segmentMembershipTag(string(segment.ID))
	definition := map[string]interface{}{
		"migration_mode": "static_membership_snapshot",
		"source_id":      tag,
		"source":         segment,
		"warning":        "Customer.io does not expose this segment's complete dynamic rule definition through the App API.",
	}
	raw, _ := json.Marshal(definition)
	return canonical.Segment{
		Name:        segmentDisplayName(segment),
		Description: "Frozen Customer.io membership snapshot; rebuild the dynamic segment rules before cutover.",
		QueryAST: canonical.SegmentNode{
			Op:         "condition",
			Field:      "tag",
			Comparator: "equals",
			Value:      tag,
		},
		SourceDefinition: string(raw),
	}
}

func mapTopic(topic cioSubscriptionTopic) canonical.Segment {
	tag := topicMembershipTag(topic.Identifier)
	definition := map[string]interface{}{
		"migration_mode": "subscription_topic_membership",
		"source_id":      tag,
		"source":         topic,
	}
	raw, _ := json.Marshal(definition)
	description := strings.TrimSpace(topic.Description)
	if description != "" {
		description += " "
	}
	description += "Customer.io subscription-topic membership snapshot; only opted-in profiles carry this tag."
	return canonical.Segment{
		Name:        topicDisplayName(topic),
		Description: description,
		QueryAST: canonical.SegmentNode{
			Op:         "condition",
			Field:      "tag",
			Comparator: "equals",
			Value:      tag,
		},
		SourceDefinition: string(raw),
	}
}

func decodeJSONObject(raw json.RawMessage) (map[string]interface{}, error) {
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var payload map[string]interface{}
	if err := decoder.Decode(&payload); err != nil {
		return nil, err
	}
	if payload == nil {
		return nil, fmt.Errorf("expected an object")
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("unexpected trailing JSON")
		}
		return nil, err
	}
	return payload, nil
}

func requireCollection[T any](collection *[]T, label string) ([]T, error) {
	if collection == nil {
		return nil, fmt.Errorf("customerio response omitted or nullified required %s collection: %w", label, adapter.ErrSourceUnavailable)
	}
	return *collection, nil
}

func requiredSourceID(value interface{}) (string, error) {
	id := strings.TrimSpace(sourceScalarString(value))
	if !validProviderID(id) {
		return "", fmt.Errorf("invalid source identity")
	}
	return id, nil
}

func sourceScalarString(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		text := typed.String()
		if strings.ContainsAny(text, ".eE+-") {
			return ""
		}
		for _, r := range text {
			if r < '0' || r > '9' {
				return ""
			}
		}
		return text
	case float64:
		if typed < 0 || typed != float64(int64(typed)) {
			return ""
		}
		return strconv.FormatInt(int64(typed), 10)
	default:
		return ""
	}
}

func sourceString(payload map[string]interface{}, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}

func sourceInt64(payload map[string]interface{}, key string) int64 {
	value := payload[key]
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case float64:
		if typed == float64(int64(typed)) {
			return int64(typed)
		}
	case int64:
		return typed
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	}
	return 0
}

func firstSourceInt64(payload map[string]interface{}, keys ...string) int64 {
	for _, key := range keys {
		if value := sourceInt64(payload, key); value != 0 {
			return value
		}
	}
	return 0
}

func sourceBool(payload map[string]interface{}, key string) (bool, bool) {
	value, ok := payload[key].(bool)
	return value, ok
}

func sourceStringSlice(payload map[string]interface{}, key string) []string {
	values, ok := payload[key].([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if text := strings.TrimSpace(sourceScalarString(value)); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func rawAttributeString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return value
}

func rawAttributeInt64(raw json.RawMessage) int64 {
	text := strings.TrimSpace(rawAttributeString(raw))
	value, _ := strconv.ParseInt(text, 10, 64)
	return value
}

func validProviderID(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 512 {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validEmail(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 320 {
		return false
	}
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && strings.Contains(value, "@")
}

func isCustomerIOSystemAttribute(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "id", "email", "cio_id", "created_at", "unsubscribed", "_last_emailed", "cio_subscription_preferences", "_cio_subscription_preferences_computed":
		return true
	default:
		return false
	}
}

func segmentMembershipTag(id string) string {
	return "customerio:segment:" + strings.TrimSpace(id)
}

func topicMembershipTag(identifier string) string {
	return "customerio:topic:" + strings.TrimSpace(identifier)
}

func segmentDisplayName(segment cioSegment) string {
	if name := strings.TrimSpace(segment.Name); name != "" {
		return "Customer.io segment: " + name
	}
	return "Customer.io segment " + strings.TrimSpace(string(segment.ID))
}

func topicDisplayName(topic cioSubscriptionTopic) string {
	if name := strings.TrimSpace(topic.Name); name != "" {
		return "Customer.io topic: " + name
	}
	return "Customer.io topic " + strings.TrimSpace(topic.Identifier)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func cloneBoolMap(in map[string]bool) map[string]bool {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]bool, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func unixTime(value int64) *time.Time {
	if value <= 0 {
		return nil
	}
	timestamp := time.Unix(value, 0).UTC()
	return &timestamp
}
