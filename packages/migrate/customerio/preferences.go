// SPDX-License-Identifier: MIT

package customerio

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	computedSubscriptionPreferencesAttribute = "_cio_subscription_preferences_computed"
	maxComputedSubscriptionPreferencesBytes  = 1 << 20
)

// cioProfilePreferenceEvidence is the normalized, reconciled snapshot used
// for both status projection and retained Customer.io source metadata.
type cioProfilePreferenceEvidence struct {
	TopicStates                  map[string]bool
	ChannelStates                map[string]bool
	TopicEvidenceComplete        bool
	EmailChannelConfigured       bool
	EmailChannelEvidenceComplete bool
	EvidenceSource               string
}

type cioComputedSubscriptionPreferences struct {
	Topics   map[string]bool
	Channels map[string]bool
}

type cioAppChannelPreference struct {
	ID          flexibleString `json:"id"`
	Type        string         `json:"type"`
	Identifier  string         `json:"identifier"`
	Channel     string         `json:"channel"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Subscribed  *bool          `json:"subscribed"`
}

func customerIOEmailStatus(globalUnsubscribed *bool, preferences cioProfilePreferenceEvidence, topics []cioSubscriptionTopic, suppressed bool) canonical.SubscriberStatus {
	if suppressed {
		return canonical.StatusBlocklisted
	}
	if globalUnsubscribed != nil && *globalUnsubscribed {
		return canonical.StatusDisabled
	}
	if preferences.EmailChannelConfigured {
		if subscribed, present := preferences.ChannelStates["email"]; present && !subscribed {
			return canonical.StatusDisabled
		}
	}
	if len(topics) > 0 && preferences.TopicEvidenceComplete {
		anyTopicSubscribed := false
		for _, topic := range topics {
			if preferences.TopicStates[topic.Identifier] {
				anyTopicSubscribed = true
				break
			}
		}
		if !anyTopicSubscribed {
			return canonical.StatusDisabled
		}
	}

	// Positive projection requires complete evidence for every applicable
	// layer. Explicit negative evidence above can always disable safely.
	if globalUnsubscribed == nil ||
		(len(topics) > 0 && !preferences.TopicEvidenceComplete) ||
		(preferences.EmailChannelConfigured && !preferences.EmailChannelEvidenceComplete) {
		return canonical.StatusUnconfirmed
	}
	return canonical.StatusEnabled
}

func reconcileProfilePreferences(detail cioCustomerDetail, topics []cioSubscriptionTopic, channels []cioSubscriptionChannel, appPreferences *cioCustomerPreferencesResponse) (cioProfilePreferenceEvidence, error) {
	expectedTopics := configuredTopicPreferenceKeys(topics)
	expectedChannels, channelsByID, err := configuredChannelPreferenceKeys(channels)
	if err != nil {
		return cioProfilePreferenceEvidence{}, err
	}

	computed, computedPresent, err := parseComputedSubscriptionPreferences(detail.Attributes[computedSubscriptionPreferencesAttribute], expectedTopics, expectedChannels)
	if err != nil {
		return cioProfilePreferenceEvidence{}, err
	}

	topicStates := map[string]bool{}
	topicEvidenceComplete := len(expectedTopics) == 0
	appChannels := map[string]bool{}
	appChannelsPresent := false
	sources := make([]string, 0, 3)
	if appPreferences != nil {
		appTopics, collectionErr := requireCollection(appPreferences.Customer.Topics, "customer subscription topics")
		if collectionErr != nil {
			return cioProfilePreferenceEvidence{}, collectionErr
		}
		topicStates, err = validateTopicPreferences(topics, appTopics)
		if err != nil {
			return cioProfilePreferenceEvidence{}, err
		}
		topicEvidenceComplete = true
		sources = append(sources, "app_api_topics")
		appChannels, appChannelsPresent, err = parseAppChannelPreferences(appPreferences.Customer.Channels, expectedChannels, channelsByID)
		if err != nil {
			return cioProfilePreferenceEvidence{}, err
		}
		if appChannelsPresent {
			sources = append(sources, "app_api_channels")
		}
	} else if len(expectedTopics) > 0 {
		return cioProfilePreferenceEvidence{}, fmt.Errorf("configured topics have no App API preference evidence: %w", adapter.ErrSourceUnavailable)
	}

	if computedPresent {
		sources = append(sources, "computed_attribute")
		if topicEvidenceComplete && !equalBoolMaps(topicStates, computed.Topics) {
			return cioProfilePreferenceEvidence{}, fmt.Errorf("computed topic preferences contradict the App API response: %w", adapter.ErrSourceUnavailable)
		}
		if appChannelsPresent && !equalBoolMaps(appChannels, computed.Channels) {
			return cioProfilePreferenceEvidence{}, fmt.Errorf("computed channel preferences contradict the App API response: %w", adapter.ErrSourceUnavailable)
		}
	}

	channelStates := map[string]bool{}
	channelEvidencePresent := false
	if computedPresent {
		channelStates = computed.Channels
		channelEvidencePresent = true
	} else if appChannelsPresent {
		channelStates = appChannels
		channelEvidencePresent = true
	}
	emailChannelConfigured := false
	if _, configured := expectedChannels["email"]; configured {
		emailChannelConfigured = true
	}
	emailEvidenceComplete := !emailChannelConfigured
	if emailChannelConfigured && channelEvidencePresent {
		_, emailEvidenceComplete = channelStates["email"]
	}
	if len(sources) == 0 {
		sources = append(sources, "none")
	}
	sort.Strings(sources)

	return cioProfilePreferenceEvidence{
		TopicStates:                  cloneBoolMap(topicStates),
		ChannelStates:                cloneBoolMap(channelStates),
		TopicEvidenceComplete:        topicEvidenceComplete,
		EmailChannelConfigured:       emailChannelConfigured,
		EmailChannelEvidenceComplete: emailEvidenceComplete,
		EvidenceSource:               strings.Join(sources, "+"),
	}, nil
}

func parseComputedSubscriptionPreferences(raw json.RawMessage, expectedTopics, expectedChannels map[string]struct{}) (cioComputedSubscriptionPreferences, bool, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return cioComputedSubscriptionPreferences{}, false, nil
	}
	if len(raw) > maxComputedSubscriptionPreferencesBytes {
		return cioComputedSubscriptionPreferences{}, false, fmt.Errorf("computed preference attribute exceeds %d bytes: %w", maxComputedSubscriptionPreferencesBytes, adapter.ErrSourceUnavailable)
	}
	var encoded string
	if err := decodeStrictJSON(raw, &encoded); err != nil {
		return cioComputedSubscriptionPreferences{}, false, fmt.Errorf("computed preference attribute must be a stringified JSON object: %w", adapter.ErrSourceUnavailable)
	}
	encoded = strings.TrimSpace(encoded)
	if encoded == "" || len(encoded) > maxComputedSubscriptionPreferencesBytes || encoded[0] != '{' {
		return cioComputedSubscriptionPreferences{}, false, fmt.Errorf("computed preference attribute is empty or is not an object: %w", adapter.ErrSourceUnavailable)
	}
	var envelope struct {
		Topics   json.RawMessage `json:"topics"`
		Channels json.RawMessage `json:"channels"`
	}
	if err := decodeStrictJSON([]byte(encoded), &envelope); err != nil {
		return cioComputedSubscriptionPreferences{}, false, fmt.Errorf("computed preference attribute is malformed: %w", adapter.ErrSourceUnavailable)
	}
	topicStates, err := parseCompleteBooleanPreferenceMap(envelope.Topics, expectedTopics, "computed topic preferences")
	if err != nil {
		return cioComputedSubscriptionPreferences{}, false, err
	}
	channelStates, err := parseCompleteBooleanPreferenceMap(envelope.Channels, expectedChannels, "computed channel preferences")
	if err != nil {
		return cioComputedSubscriptionPreferences{}, false, err
	}
	return cioComputedSubscriptionPreferences{Topics: topicStates, Channels: channelStates}, true, nil
}

func parseAppChannelPreferences(raw json.RawMessage, expected map[string]struct{}, channelsByID map[string]string) (map[string]bool, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return map[string]bool{}, false, nil
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, false, fmt.Errorf("App API channel preferences were null: %w", adapter.ErrSourceUnavailable)
	}
	if err := rejectDuplicateJSONKeys(trimmed); err != nil {
		return nil, false, fmt.Errorf("App API channel preferences are malformed: %w", adapter.ErrSourceUnavailable)
	}

	var states map[string]bool
	switch trimmed[0] {
	case '{':
		var entries map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &entries); err != nil {
			return nil, false, fmt.Errorf("App API channel preferences are malformed: %w", adapter.ErrSourceUnavailable)
		}
		states = make(map[string]bool, len(entries))
		for key, value := range entries {
			if key == "" || strings.TrimSpace(key) != key {
				return nil, false, fmt.Errorf("App API channel preference has an invalid key %q: %w", key, adapter.ErrSourceUnavailable)
			}
			var subscribed bool
			if err := decodeStrictJSON(value, &subscribed); err != nil {
				return nil, false, fmt.Errorf("App API channel preference %q is not boolean: %w", key, adapter.ErrSourceUnavailable)
			}
			states[key] = subscribed
		}
	case '[':
		var rows []json.RawMessage
		if err := json.Unmarshal(trimmed, &rows); err != nil {
			return nil, false, fmt.Errorf("App API channel preferences are malformed: %w", adapter.ErrSourceUnavailable)
		}
		states = make(map[string]bool, len(rows))
		for _, rowRaw := range rows {
			var row cioAppChannelPreference
			if err := decodeProviderJSON(rowRaw, &row); err != nil || row.Subscribed == nil {
				return nil, false, fmt.Errorf("App API channel preference row is incomplete: %w", adapter.ErrSourceUnavailable)
			}
			key, keyErr := appChannelPreferenceKey(row, expected, channelsByID)
			if keyErr != nil {
				return nil, false, keyErr
			}
			if _, duplicate := states[key]; duplicate {
				return nil, false, fmt.Errorf("App API returned duplicate channel preference %q: %w", key, adapter.ErrSourceUnavailable)
			}
			states[key] = *row.Subscribed
		}
	default:
		return nil, false, fmt.Errorf("App API channel preferences must be an object or array: %w", adapter.ErrSourceUnavailable)
	}
	if err := validatePreferenceCoverage(states, expected, "App API channel preferences"); err != nil {
		return nil, false, err
	}
	return states, true, nil
}

func appChannelPreferenceKey(row cioAppChannelPreference, expected map[string]struct{}, channelsByID map[string]string) (string, error) {
	candidates := make([]string, 0, 4)
	if id := strings.TrimSpace(string(row.ID)); id != "" {
		key, known := channelsByID[id]
		if !known {
			return "", fmt.Errorf("App API channel preference referenced unknown ID %q: %w", id, adapter.ErrSourceUnavailable)
		}
		candidates = append(candidates, key)
	}
	for _, value := range []string{row.Type, row.Identifier, row.Channel} {
		if strings.TrimSpace(value) == "" {
			continue
		}
		key, valid := customerIOChannelPreferenceKey(value)
		if !valid {
			return "", fmt.Errorf("App API channel preference referenced invalid type %q: %w", value, adapter.ErrSourceUnavailable)
		}
		candidates = append(candidates, key)
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("App API channel preference omitted its identity: %w", adapter.ErrSourceUnavailable)
	}
	key := candidates[0]
	if _, known := expected[key]; !known {
		return "", fmt.Errorf("App API channel preference referenced unconfigured channel %q: %w", key, adapter.ErrSourceUnavailable)
	}
	for _, candidate := range candidates[1:] {
		if candidate != key {
			return "", fmt.Errorf("App API channel preference returned contradictory identities: %w", adapter.ErrSourceUnavailable)
		}
	}
	return key, nil
}

func configuredTopicPreferenceKeys(topics []cioSubscriptionTopic) map[string]struct{} {
	keys := make(map[string]struct{}, len(topics))
	for _, topic := range topics {
		keys[topic.Identifier] = struct{}{}
	}
	return keys
}

func configuredChannelPreferenceKeys(channels []cioSubscriptionChannel) (map[string]struct{}, map[string]string, error) {
	keys := make(map[string]struct{}, len(channels))
	byID := make(map[string]string, len(channels))
	for _, channel := range channels {
		id := strings.TrimSpace(string(channel.ID))
		key, valid := customerIOChannelPreferenceKey(channel.Type)
		if !valid || !validPositiveIntegerID(id) {
			return nil, nil, fmt.Errorf("invalid configured subscription channel: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := keys[key]; duplicate {
			return nil, nil, fmt.Errorf("duplicate configured channel preference key %q: %w", key, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := byID[id]; duplicate {
			return nil, nil, fmt.Errorf("duplicate configured subscription channel ID %q: %w", id, adapter.ErrSourceUnavailable)
		}
		keys[key], byID[id] = struct{}{}, key
	}
	return keys, byID, nil
}

func parseCompleteBooleanPreferenceMap(raw json.RawMessage, expected map[string]struct{}, label string) (map[string]bool, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		if len(expected) == 0 {
			return map[string]bool{}, nil
		}
		return nil, fmt.Errorf("%s were omitted: %w", label, adapter.ErrSourceUnavailable)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s were null: %w", label, adapter.ErrSourceUnavailable)
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return nil, fmt.Errorf("%s are malformed: %w", label, adapter.ErrSourceUnavailable)
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil || entries == nil {
		return nil, fmt.Errorf("%s must be an object: %w", label, adapter.ErrSourceUnavailable)
	}
	states := make(map[string]bool, len(entries))
	for key, value := range entries {
		if key == "" || strings.TrimSpace(key) != key {
			return nil, fmt.Errorf("%s entry has an invalid key %q: %w", label, key, adapter.ErrSourceUnavailable)
		}
		var subscribed bool
		if err := decodeStrictJSON(value, &subscribed); err != nil {
			return nil, fmt.Errorf("%s entry %q is not boolean: %w", label, key, adapter.ErrSourceUnavailable)
		}
		states[key] = subscribed
	}
	if err := validatePreferenceCoverage(states, expected, label); err != nil {
		return nil, err
	}
	return states, nil
}

func validatePreferenceCoverage(states map[string]bool, expected map[string]struct{}, label string) error {
	missing := make([]string, 0)
	unexpected := make([]string, 0)
	for key := range expected {
		if _, present := states[key]; !present {
			missing = append(missing, key)
		}
	}
	for key := range states {
		if _, present := expected[key]; !present {
			unexpected = append(unexpected, key)
		}
	}
	if len(missing) == 0 && len(unexpected) == 0 {
		return nil
	}
	sort.Strings(missing)
	sort.Strings(unexpected)
	return fmt.Errorf("%s do not match configured definitions (missing=%v unexpected=%v): %w", label, missing, unexpected, adapter.ErrSourceUnavailable)
}

func equalBoolMaps(left, right map[string]bool) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if other, present := right[key]; !present || other != value {
			return false
		}
	}
	return true
}

func isCustomerIOSubscriptionChannelType(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "email", "twilio", "urban_airship", "slack", "push", "in_app", "line", "inbox", "whatsapp":
		return true
	default:
		return false
	}
}

func customerIOChannelPreferenceKey(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "email":
		return "email", true
	case "twilio", "sms":
		return "sms", true
	case "urban_airship", "push":
		return "push", true
	case "slack":
		return "slack", true
	case "in_app":
		return "in_app", true
	case "line":
		return "line", true
	case "inbox":
		return "inbox", true
	case "whatsapp":
		return "whatsapp", true
	default:
		return "", false
	}
}

func validPositiveIntegerID(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 64 {
		return false
	}
	nonzero := false
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
		if r != '0' {
			nonzero = true
		}
	}
	return nonzero
}

func decodeStrictJSON(data []byte, target interface{}) error {
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return err
	}
	return nil
}

func decodeProviderJSON(data []byte, target interface{}) error {
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var visit func() error
	visit = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, composite := token.(json.Delim)
		if !composite {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return keyErr
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("object key is not a string")
				}
				if _, duplicate := seen[key]; duplicate {
					return fmt.Errorf("duplicate object key %q", key)
				}
				seen[key] = struct{}{}
				if err := visit(); err != nil {
					return err
				}
			}
			closeToken, closeErr := decoder.Token()
			if closeErr != nil || closeToken != json.Delim('}') {
				return fmt.Errorf("unterminated object")
			}
		case '[':
			for decoder.More() {
				if err := visit(); err != nil {
					return err
				}
			}
			closeToken, closeErr := decoder.Token()
			if closeErr != nil || closeToken != json.Delim(']') {
				return fmt.Errorf("unterminated array")
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter %q", delim)
		}
		return nil
	}
	if err := visit(); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing interface{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}
