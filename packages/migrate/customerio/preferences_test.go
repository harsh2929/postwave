// SPDX-License-Identifier: MIT

package customerio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func computedPreferenceAttribute(t *testing.T, value string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	return raw
}

func customerIOPreferenceFixture() ([]cioSubscriptionTopic, []cioSubscriptionChannel) {
	return []cioSubscriptionTopic{{ID: "1", Identifier: "topic_1"}}, []cioSubscriptionChannel{{
		ID:                  "10",
		Type:                "email",
		SubscribedByDefault: boolPointer(true),
	}}
}

func appPreferenceFixture(topic, email bool, includeChannels bool) *cioCustomerPreferencesResponse {
	response := &cioCustomerPreferencesResponse{}
	responseTopics := []cioCustomerTopicPreference{{ID: "1", Subscribed: boolPointer(topic)}}
	response.Customer.Topics = &responseTopics
	if includeChannels {
		response.Customer.Channels = json.RawMessage(`{"email":` + map[bool]string{true: "true", false: "false"}[email] + `}`)
	}
	return response
}

func TestReconcileProfilePreferencesEmailChannelProjection(t *testing.T) {
	topics, channels := customerIOPreferenceFixture()
	for _, test := range []struct {
		name         string
		computed     string
		app          *cioCustomerPreferencesResponse
		wantChannel  map[string]bool
		wantComplete bool
		wantStatus   canonical.SubscriberStatus
	}{
		{
			name:         "computed email false disables",
			computed:     `{"topics":{"topic_1":true},"channels":{"email":false}}`,
			app:          appPreferenceFixture(true, false, false),
			wantChannel:  map[string]bool{"email": false},
			wantComplete: true,
			wantStatus:   canonical.StatusDisabled,
		},
		{
			name:         "computed email true enables",
			computed:     `{"topics":{"topic_1":true},"channels":{"email":true}}`,
			app:          appPreferenceFixture(true, true, false),
			wantChannel:  map[string]bool{"email": true},
			wantComplete: true,
			wantStatus:   canonical.StatusEnabled,
		},
		{
			name:         "App API email fallback enables",
			app:          appPreferenceFixture(true, true, true),
			wantChannel:  map[string]bool{"email": true},
			wantComplete: true,
			wantStatus:   canonical.StatusEnabled,
		},
		{
			name:         "absent channel evidence remains unconfirmed",
			app:          appPreferenceFixture(true, false, false),
			wantChannel:  nil,
			wantComplete: false,
			wantStatus:   canonical.StatusUnconfirmed,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			detail := cioCustomerDetail{Attributes: map[string]json.RawMessage{}}
			if test.computed != "" {
				detail.Attributes[computedSubscriptionPreferencesAttribute] = computedPreferenceAttribute(t, test.computed)
			}
			evidence, err := reconcileProfilePreferences(detail, topics, channels, test.app)
			require.NoError(t, err)
			require.Equal(t, test.wantChannel, evidence.ChannelStates)
			require.Equal(t, test.wantComplete, evidence.EmailChannelEvidenceComplete)
			require.Equal(t, test.wantStatus, customerIOEmailStatus(boolPointer(false), evidence, topics, false))
		})
	}
}

func TestComputedSubscriptionPreferencesRejectMalformedAndContradictoryEvidence(t *testing.T) {
	topics, channels := customerIOPreferenceFixture()
	validApp := appPreferenceFixture(true, true, true)
	for _, test := range []struct {
		name string
		raw  json.RawMessage
		app  *cioCustomerPreferencesResponse
	}{
		{name: "not stringified", raw: json.RawMessage(`{"topics":{"topic_1":true},"channels":{"email":true}}`), app: validApp},
		{name: "malformed JSON", raw: computedPreferenceAttribute(t, `{"topics":`), app: validApp},
		{name: "non-boolean email", raw: computedPreferenceAttribute(t, `{"topics":{"topic_1":true},"channels":{"email":"false"}}`), app: validApp},
		{name: "duplicate email", raw: computedPreferenceAttribute(t, `{"topics":{"topic_1":true},"channels":{"email":true,"email":false}}`), app: validApp},
		{name: "missing configured email", raw: computedPreferenceAttribute(t, `{"topics":{"topic_1":true},"channels":{}}`), app: validApp},
		{name: "unexpected channel", raw: computedPreferenceAttribute(t, `{"topics":{"topic_1":true},"channels":{"email":true,"sms":true}}`), app: validApp},
		{name: "topic mismatch", raw: computedPreferenceAttribute(t, `{"topics":{"topic_1":false},"channels":{"email":true}}`), app: validApp},
		{name: "channel mismatch", raw: computedPreferenceAttribute(t, `{"topics":{"topic_1":true},"channels":{"email":false}}`), app: validApp},
	} {
		t.Run(test.name, func(t *testing.T) {
			detail := cioCustomerDetail{Attributes: map[string]json.RawMessage{computedSubscriptionPreferencesAttribute: test.raw}}
			_, err := reconcileProfilePreferences(detail, topics, channels, test.app)
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		})
	}
}

func TestReconcileProfilePreferencesSupportsChannelOnlyWorkspace(t *testing.T) {
	channels := []cioSubscriptionChannel{{ID: "10", Type: "email", SubscribedByDefault: boolPointer(false)}}
	detail := cioCustomerDetail{Attributes: map[string]json.RawMessage{
		computedSubscriptionPreferencesAttribute: computedPreferenceAttribute(t, `{"topics":{},"channels":{"email":true}}`),
	}}
	app := &cioCustomerPreferencesResponse{}
	emptyTopics := []cioCustomerTopicPreference{}
	app.Customer.Topics = &emptyTopics
	evidence, err := reconcileProfilePreferences(detail, nil, channels, app)
	require.NoError(t, err)
	require.True(t, evidence.TopicEvidenceComplete)
	require.True(t, evidence.EmailChannelEvidenceComplete)
	require.Equal(t, map[string]bool{"email": true}, evidence.ChannelStates)
	require.Equal(t, canonical.StatusEnabled, customerIOEmailStatus(boolPointer(false), evidence, nil, false))
}

func TestChannelOnlyWorkspaceHydratesProfilePreferences(t *testing.T) {
	preferenceRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/segments":
			writeJSON(t, w, `{"segments":[]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_topics":
			writeJSON(t, w, `{"topics":[]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_channels":
			writeJSON(t, w, `{"channels":[{"id":10,"type":"email","name":"Email","subscribed_by_default":false}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/customers":
			var body struct {
				Filter map[string]interface{} `json:"filter"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			if _, withoutEmail := body.Filter["not"]; withoutEmail {
				writeJSON(t, w, `{"identifiers":[],"next":""}`)
				return
			}
			writeJSON(t, w, `{"identifiers":[{"id":"publisher-1","email":"person@example.com","cio_id":"cio-1"}],"next":""}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/customers/cio-1/attributes":
			writeJSON(t, w, `{"customer":{"id":"publisher-1","identifiers":{"id":"publisher-1","email":"person@example.com","cio_id":"cio-1"},"attributes":{"email":"person@example.com","_cio_subscription_preferences_computed":"{\"topics\":{},\"channels\":{\"email\":true}}"},"timestamps":{},"unsubscribed":false,"devices":[]}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/customers/cio-1/subscription_preferences":
			preferenceRequests++
			writeJSON(t, w, `{"customer":{"id":"publisher-1","identifiers":{"id":"publisher-1","email":"person@example.com","cio_id":"cio-1"},"topics":[],"unsubscribed":false}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/design_studio/emails":
			writeJSON(t, w, `{"emails":[],"meta":{"pagination":{"page":1,"limit":1000,"total":0}}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/newsletters":
			writeJSON(t, w, `{"newsletters":[],"next":""}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/optouts":
			writeJSON(t, w, `{"optouts":[],"next":""}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/campaigns":
			writeJSON(t, w, `{"campaigns":[]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/broadcasts":
			writeJSON(t, w, `{"broadcasts":[]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/transactional":
			writeJSON(t, w, `{"messages":[]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/object_types":
			writeJSON(t, w, `{"types":[]}`)
		case r.Method == http.MethodGet && len(r.URL.Path) > len("/v1/esp/suppression/") && r.URL.Path[:len("/v1/esp/suppression/")] == "/v1/esp/suppression/":
			writeJSON(t, w, `{"suppressions":[]}`)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()

	a := fastAdapter(server)
	report, err := a.Discover(context.Background(), testSession())
	require.NoError(t, err)
	require.Equal(t, 1, preferenceRequests, "channel inventory must trigger per-profile preference hydration even with zero topics")
	require.Equal(t, 1, report.SubscriptionChannelsTotal)
	require.Equal(t, 9, report.SourceArchiveTotal, "one channel definition plus eight static review tasks")
	subscribers, _, err := a.ListSubscribers(context.Background(), testSession(), "")
	require.NoError(t, err)
	require.Len(t, subscribers, 1)
	require.Equal(t, canonical.StatusEnabled, subscribers[0].Status)
}

func TestSubscriptionChannelInventoryIsValidated(t *testing.T) {
	t.Run("valid legacy provider types normalize to preference keys", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, `{"channels":[{"id":1,"type":"email","subscribed_by_default":true},{"id":2,"type":"twilio","subscribed_by_default":false},{"id":3,"type":"urban_airship","subscribed_by_default":true}]}`)
		}))
		defer server.Close()
		channels, err := fastAdapter(server).listSubscriptionChannels(context.Background(), testSession())
		require.NoError(t, err)
		require.Len(t, channels, 3)
		keys, _, err := configuredChannelPreferenceKeys(channels)
		require.NoError(t, err)
		require.Equal(t, map[string]struct{}{"email": {}, "sms": {}, "push": {}}, keys)
	})

	for _, payload := range []string{
		`{"channels":[{"id":1,"type":"email","subscribed_by_default":true},{"id":1,"type":"push","subscribed_by_default":true}]}`,
		`{"channels":[{"id":1,"type":"email","subscribed_by_default":true},{"id":2,"type":"email","subscribed_by_default":true}]}`,
		`{"channels":[{"id":1,"type":"push","subscribed_by_default":true},{"id":2,"type":"urban_airship","subscribed_by_default":true}]}`,
		`{"channels":[{"id":"email","type":"email","subscribed_by_default":true}]}`,
		`{"channels":[{"id":1,"type":"fax","subscribed_by_default":true}]}`,
		`{"channels":[{"id":1,"type":"email"}]}`,
	} {
		t.Run(payload, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, payload) }))
			defer server.Close()
			_, err := fastAdapter(server).listSubscriptionChannels(context.Background(), testSession())
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		})
	}
}

func TestChannelPreferencesParticipateInSnapshotFingerprint(t *testing.T) {
	makeSnapshot := func(emailSubscribed bool) *customerIOSnapshot {
		return &customerIOSnapshot{Subscribers: []canonical.Subscriber{{
			Email:          "person@example.com",
			Status:         canonical.StatusEnabled,
			SourceID:       "cio-1",
			SourcePlatform: canonical.SourceCustomerIO,
			CustomFields: map[string]interface{}{
				"customerio_source": map[string]interface{}{"channel_preferences": map[string]bool{"email": emailSubscribed}},
			},
		}}}
	}
	first, err := snapshotFingerprint(makeSnapshot(true))
	require.NoError(t, err)
	second, err := snapshotFingerprint(makeSnapshot(false))
	require.NoError(t, err)
	require.NotEqual(t, first, second)
}
