package events

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestSubscribeHandlerReturnsStreamResourceURI(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events/subscriptions", strings.NewReader(`{
		"event_types": ["campaign.opened", "campaign.clicked", "campaign.opened"],
		"campaign_id": "cmp_123",
		"subscriber_email": "FOUNDER@EXAMPLE.COM"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_1", Slug: "acme"}))
	rec := httptest.NewRecorder()

	SubscribeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out struct {
		SubscriptionID string `json:"subscription_id"`
		ResourceURI    string `json:"resource_uri"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !strings.HasPrefix(out.SubscriptionID, "evt_sub_") {
		t.Fatalf("subscription_id = %q", out.SubscriptionID)
	}
	for _, want := range []string{
		"/api/v1/events/stream?",
		"event_type=campaign.opened%2Ccampaign.clicked",
		"campaign=cmp_123",
		"subscriber_email=founder%40example.com",
	} {
		if !strings.Contains(out.ResourceURI, want) {
			t.Fatalf("resource_uri %q missing %q", out.ResourceURI, want)
		}
	}
}

func TestSubscribeHandlerRejectsInvalidEventType(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events/subscriptions", strings.NewReader(`{
		"event_types": ["campaign opened"]
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_1"}))
	rec := httptest.NewRecorder()

	SubscribeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestEventWirePayloadMatchesSDKShape(t *testing.T) {
	at := time.Date(2026, 5, 12, 10, 30, 0, 0, time.UTC)
	payload := eventWirePayload(Event{
		Topic:    "campaign.opened",
		TenantID: "tenant_1",
		At:       at,
		Payload: map[string]any{
			"event_type":       "opened",
			"campaign_id":      "cmp_123",
			"subscriber_email": "founder@example.com",
		},
	})

	if payload["event_type"] != "opened" {
		t.Fatalf("event_type = %#v", payload["event_type"])
	}
	if payload["topic"] != "campaign.opened" {
		t.Fatalf("topic = %#v", payload["topic"])
	}
	if payload["ts"] != at.Format(time.RFC3339Nano) {
		t.Fatalf("ts = %#v", payload["ts"])
	}
	if payload["campaign_id"] != "cmp_123" || payload["subscriber_email"] != "founder@example.com" {
		t.Fatalf("expected flattened SDK fields: %#v", payload)
	}
}

func TestEventMatchesFilters(t *testing.T) {
	evt := Event{
		Topic:    "campaign.clicked",
		TenantID: "tenant_1",
		Payload: map[string]any{
			"event_type":       "clicked",
			"campaign_id":      "cmp_123",
			"subscriber_email": "founder@example.com",
		},
	}

	if !eventMatchesFilters(evt, streamFilters{
		EventTypes:      []string{"clicked"},
		CampaignID:      "cmp_123",
		SubscriberEmail: "founder@example.com",
	}) {
		t.Fatal("expected event to match exact filters")
	}
	if eventMatchesFilters(evt, streamFilters{CampaignID: "cmp_other"}) {
		t.Fatal("expected campaign mismatch to be filtered")
	}
}

func TestParseTopicsNormalizesAndBoundsInput(t *testing.T) {
	got := parseTopics(" campaign.* ,campaign.*,audit.created,Campaign.Bad,../x ")
	want := []string{"campaign.*", "audit.created"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("parseTopics = %#v, want %#v", got, want)
	}

	many := make([]string, 0, maxStreamTopicCount+10)
	for i := 0; i < maxStreamTopicCount+10; i++ {
		many = append(many, "topic"+strconv.Itoa(i)+".created")
	}
	if got := parseTopics(strings.Join(many, ",")); len(got) != maxStreamTopicCount {
		t.Fatalf("bounded parseTopics len = %d, want %d", len(got), maxStreamTopicCount)
	}

	if got := parseTopics(strings.Repeat("a", maxStreamTopicCSVBytes+1)); len(got) != 1 || got[0] != noMatchTopic() {
		t.Fatalf("oversized parseTopics = %#v, want no-match sentinel", got)
	}
	if got := parseTopics("Campaign.Bad,../x"); len(got) != 1 || got[0] != noMatchTopic() {
		t.Fatalf("invalid parseTopics = %#v, want no-match sentinel", got)
	}
}

// Topic segments may contain underscores. `list_health.degraded` is a real,
// live-published bus topic (deliverability_hub.emitDegraded) and it is also in
// the public outbound-webhook catalog, so it cannot be renamed. The stream
// grammar previously allowed only [a-z0-9-], which silently DROPPED both the
// concrete topic and the `list_health.*` glob from a subscriber's filter list —
// a client could ask for the event and never be told its request was discarded.
func TestParseTopicsAcceptsUnderscoreSegments(t *testing.T) {
	got := parseTopics("list_health.*,list_health.degraded,subscriber.engagement_updated")
	want := []string{"list_health.*", "list_health.degraded", "subscriber.engagement_updated"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("parseTopics = %#v, want %#v", got, want)
	}
	if got := normalizePatterns([]string{"list_health.*"}); len(got) != 1 || got[0] != "list_health.*" {
		t.Fatalf("normalizePatterns dropped an underscore glob: %#v", got)
	}
}

// The `list_health.*` glob must not capture `list.*` topics and vice versa —
// they share a textual prefix but matchOne compares against the trimmed
// "list_health." / "list." including the dot, so the boundary holds.
func TestUnderscoreGlobDoesNotCollideWithSharedPrefix(t *testing.T) {
	cases := []struct {
		pattern string
		topic   string
		want    bool
	}{
		{"list_health.*", "list_health.degraded", true},
		{"list_health.*", "list.subscriber.added", false},
		{"list.*", "list_health.degraded", false},
		{"list.*", "list.subscriber.added", true},
	}
	for _, c := range cases {
		if got := matchOne(c.pattern, c.topic); got != c.want {
			t.Fatalf("matchOne(%q, %q) = %v, want %v", c.pattern, c.topic, got, c.want)
		}
	}
}

// Every topic the gateway actually publishes must be expressible as a stream
// filter. Without this, a new topic can be published that no client is able to
// subscribe to — the failure mode that made `list_health.degraded` inert.
func TestPublishedTopicsAreSubscribable(t *testing.T) {
	published := []string{
		// campaigns/handlers.go, subscribers/handlers.go + repo.go
		"campaign.created", "campaign.updated", "campaign.sent",
		"subscriber.added", "subscriber.removed", "subscriber.archived",
		"subscriber.unarchived", "subscriber.merged", "subscriber.account_linked",
		"subscriber.jurisdiction_reconfirmed", "subscriber.engagement_updated",
		"subscriber.lifecycle_stage_changed", "subscriber.pii_detected",
		"subscriber.pii_scan_truncated", "subscriber.bounced",
		"subscriber.complained", "subscriber.unsubscribed", "subscriber.delivered",
		// subscribers/bulk_operations.go via outbound_webhooks.EventListSubscriberAdded
		"list.subscriber.added",
		// approvals/handlers.go
		"approval.requested", "approval.decided",
		// main.go audit bridge + notifyfanout
		"audit.created", "notification.created",
		// deliverability_hub/hub.go
		"list_health.degraded",
		"account.compliance_suspend", "account.deactivate", "account.reactivate",
		// referrals/events.go via the main.go EventEmitter
		"referral.milestone.unlocked", "referral.payout.pending",
		// events/presence.go
		"presence.update", "presence.entity",
	}
	for _, topic := range published {
		if !streamTopicRE.MatchString(topic) {
			t.Errorf("published topic %q does not match streamTopicRE — no client can subscribe to it", topic)
		}
		if got := parseTopics(topic); len(got) != 1 || got[0] != topic {
			t.Errorf("parseTopics(%q) = %#v, want the topic preserved", topic, got)
		}
		domain := topic
		if i := strings.Index(topic, "."); i > 0 {
			domain = topic[:i]
		}
		glob := domain + ".*"
		if got := parseTopics(glob); len(got) != 1 || got[0] != glob {
			t.Errorf("parseTopics(%q) = %#v, want the glob preserved", glob, got)
		}
		if !matchOne(glob, topic) {
			t.Errorf("matchOne(%q, %q) = false, want the domain glob to match", glob, topic)
		}
	}
}

func TestNormalizePatternsRejectsInvalidInternalPatterns(t *testing.T) {
	got := normalizePatterns([]string{" campaign.* ", "campaign.*", "audit.created", "Campaign.Bad", "../x"})
	want := []string{"campaign.*", "audit.created"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("normalizePatterns = %#v, want %#v", got, want)
	}

	if got := normalizePatterns([]string{"Campaign.Bad", "../x"}); len(got) != 1 || got[0] != noMatchTopic() {
		t.Fatalf("invalid normalizePatterns = %#v, want no-match sentinel", got)
	}
	if got := normalizePatterns(nil); len(got) != 1 || got[0] != "*" {
		t.Fatalf("empty normalizePatterns = %#v, want wildcard", got)
	}

	many := make([]string, 0, maxStreamTopicCount+10)
	for i := 0; i < maxStreamTopicCount+10; i++ {
		many = append(many, "topic"+strconv.Itoa(i)+".created")
	}
	if got := normalizePatterns(many); len(got) != maxStreamTopicCount {
		t.Fatalf("bounded normalizePatterns len = %d, want %d", len(got), maxStreamTopicCount)
	}
}

func TestPublishRejectsTenantContextWithoutSessionUser(t *testing.T) {
	t.Parallel()
	bus := NewBus()
	subscriber := bus.Subscribe("tenant_publish_no_user", []string{"cursor.move"})
	defer bus.Unsubscribe(subscriber)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/events/publish",
		strings.NewReader(`{"topic":"cursor.move","payload":{"user_id":"spoofed","user_label":"spoofed"}}`))
	request.Header.Set("Content-Type", "application/json")
	request = request.WithContext(middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant_publish_no_user"}))
	response := httptest.NewRecorder()

	PublishHandler(bus).ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusUnauthorized, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"code":"no_user"`) {
		t.Fatalf("body = %s, want no_user", response.Body.String())
	}
	select {
	case event := <-subscriber.Ch:
		t.Fatalf("unauthenticated publisher emitted event: %+v", event)
	default:
	}
}

func TestPublishStampsSessionIdentityOverClientPayload(t *testing.T) {
	t.Parallel()
	bus := NewBus()
	subscriber := bus.Subscribe("tenant_publish_session", []string{"cursor.move"})
	defer bus.Unsubscribe(subscriber)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/events/publish",
		strings.NewReader(`{"topic":"cursor.move","payload":{"user_id":"spoofed","user_label":"spoofed"}}`))
	request.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant_publish_session"})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID:       "real-user-id",
		TenantID: "tenant_publish_session",
		Email:    "alice@example.com",
		Role:     "viewer",
	})
	response := httptest.NewRecorder()

	PublishHandler(bus).ServeHTTP(response, request.WithContext(ctx))

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusAccepted, response.Body.String())
	}
	select {
	case event := <-subscriber.Ch:
		if event.Payload["user_id"] != "real-user-id" || event.Payload["user_label"] != "alice" {
			t.Fatalf("published identity = %#v, want server-resolved values", event.Payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for published event")
	}
}

func TestPublishNormalizesJSONDecoderErrors(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		body    string
		code    string
		message string
	}{
		{name: "malformed JSON", body: `{"topic":`, code: "bad_json", message: "Request body is not valid JSON."},
		{name: "unknown field", body: `{"topic":"cursor.move","unexpected":true}`, code: "unknown_field", message: "Request body contains an unknown field."},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodPost, "/api/v1/events/publish", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant_decoder_" + test.name})
			ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-decoder", TenantID: "tenant_decoder", Role: "viewer"})
			response := httptest.NewRecorder()

			PublishHandler(NewBus()).ServeHTTP(response, request.WithContext(ctx))

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
			}
			var body struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if body.Error.Code != test.code || body.Error.Message != test.message {
				t.Fatalf("error = %+v, want code=%q message=%q", body.Error, test.code, test.message)
			}
			for _, leaked := range []string{"offset", "unexpected end", "unknown field"} {
				if leaked != "unknown field" || test.code != "unknown_field" {
					if strings.Contains(strings.ToLower(body.Error.Message), leaked) {
						t.Fatalf("message leaked decoder detail %q: %q", leaked, body.Error.Message)
					}
				}
			}
		})
	}
}

// --- replay wire shape -----------------------------------------------------

// A recovered gap is useless if it arrives in a shape the recovery path cannot
// read. Replay used to return {sequence_id, topic, payload, at} while the live
// stream emits {topic, event_type, tenant_id, at, ts, payload, …hoisted ids},
// so anything reading `event_type` or a hoisted `campaign_id` — which is most
// of the invalidation layer — saw undefined on every replayed event.
func TestReplayWireEventsMatchTheLiveStreamShape(t *testing.T) {
	at := time.Date(2026, 8, 4, 9, 0, 0, 0, time.UTC)
	payload := map[string]any{"campaign_id": "cam_1", "event_type": "campaign.sent"}

	live := eventWirePayload(Event{
		Topic: "campaign.sent", TenantID: "t1", At: at, Payload: payload,
	})
	replayed := replayWireEvents("t1", []ReplayEvent{
		{SequenceID: 42, Topic: "campaign.sent", At: at, Payload: payload},
	})
	if len(replayed) != 1 {
		t.Fatalf("replayWireEvents returned %d rows", len(replayed))
	}
	got := replayed[0]

	for _, key := range []string{"topic", "event_type", "tenant_id", "ts", "campaign_id"} {
		if fmt.Sprint(got[key]) != fmt.Sprint(live[key]) {
			t.Errorf("replay %s = %v, live = %v — the two shapes must agree",
				key, got[key], live[key])
		}
	}
	if got["sequence_id"] != int64(42) {
		t.Errorf("sequence_id = %v, want 42 — replay adds the cursor the stream cannot carry", got["sequence_id"])
	}
}

func TestReplayTimeStringIsEmptyForZero(t *testing.T) {
	if got := replayTimeString(time.Time{}); got != "" {
		t.Fatalf("replayTimeString(zero) = %q, want empty so a client can tell 'no cursor' from 'epoch'", got)
	}
	at := time.Date(2026, 8, 4, 9, 0, 0, 0, time.UTC)
	if got := replayTimeString(at); got != "2026-08-04T09:00:00Z" {
		t.Fatalf("replayTimeString = %q", got)
	}
}

// A page that scanned nothing must NOT answer with a zero sequence cursor.
//
// `next_cursor` is clamped to the caller's own cursor so an idle poller cannot
// reset itself to the start of the log — but in TIME mode the caller's cursor
// is 0, so the clamp produced `next_cursor: 0`. A client that folds that in
// asks for `sequence_id > 0` next time: the oldest page of the whole retained
// log, on every reconnect, forever. An adversarial review reproduced it end to
// end against the real web client.
func TestReplayResponseOmitsZeroCursorInTimeMode(t *testing.T) {
	at := time.Date(2026, 8, 4, 9, 0, 0, 0, time.UTC)
	body := replayResponseBody(ReplayPage{}, 0, at, nil)
	if got, ok := body["next_cursor"]; !ok || got != nil {
		t.Fatalf("next_cursor = %#v, want an explicit nil", got)
	}
	if body["next_since_at"] != "2026-08-04T09:00:00Z" {
		t.Fatalf("next_since_at = %#v, want the caller's own cursor back", body["next_since_at"])
	}
}

func TestReplayResponseKeepsARealCursor(t *testing.T) {
	body := replayResponseBody(ReplayPage{NextCursor: 940}, 900, time.Time{}, nil)
	if body["next_cursor"] != int64(940) {
		t.Fatalf("next_cursor = %#v, want 940", body["next_cursor"])
	}
}

func TestReplayResponseNeverMovesTheCursorBackwards(t *testing.T) {
	body := replayResponseBody(ReplayPage{NextCursor: 10}, 900, time.Time{}, nil)
	if body["next_cursor"] != int64(900) {
		t.Fatalf("next_cursor = %#v, want the caller's 900", body["next_cursor"])
	}
}

// `?since=abc` parsed to 0 with the error discarded, which in sequence mode
// means "the whole log" — a typo silently became the most expensive query the
// endpoint can serve.
func TestParseReplaySinceRejectsGarbage(t *testing.T) {
	for _, raw := range []string{"abc", "1.5", "9e9x", "--3"} {
		if _, err := parseReplaySince(raw); err == nil {
			t.Fatalf("parseReplaySince(%q) accepted it", raw)
		}
	}
	for _, tc := range []struct {
		raw  string
		want int64
	}{{"", 0}, {"0", 0}, {"940", 940}, {"-4", 0}} {
		got, err := parseReplaySince(tc.raw)
		if err != nil || got != tc.want {
			t.Fatalf("parseReplaySince(%q) = %d, %v; want %d", tc.raw, got, err, tc.want)
		}
	}
}
