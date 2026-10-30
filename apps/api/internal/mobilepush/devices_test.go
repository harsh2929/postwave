package mobilepush

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type testCipher struct{ plaintext []byte }

func (c testCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	return append([]byte("encrypted:"), plaintext...), nil
}

func (c testCipher) Decrypt(_ context.Context, _ []byte, _ []byte) ([]byte, error) {
	return append([]byte(nil), c.plaintext...), nil
}

func TestParseDeviceKeyRequiresRandomLowercaseHexShape(t *testing.T) {
	valid := strings.Repeat("ab", 32)
	got, ok := parseDeviceKey(valid)
	if !ok || got == ([32]byte{}) {
		t.Fatal("valid device key was rejected")
	}
	for _, bad := range []string{"", strings.Repeat("a", 63), strings.ToUpper(valid), strings.Repeat("zz", 32)} {
		if _, ok := parseDeviceKey(bad); ok {
			t.Fatalf("invalid key %q was accepted", bad)
		}
	}
}

func TestNormalizeDeviceEventsDefaultsAndRejectsUnknown(t *testing.T) {
	defaults, ok := normalizeDeviceEvents(nil)
	if !ok || len(defaults) == 0 {
		t.Fatal("default events missing")
	}
	if !sortIsStable(defaults) {
		t.Fatalf("defaults are not sorted: %v", defaults)
	}
	got, ok := normalizeDeviceEvents([]string{"campaign.sent", "approval.requested", "campaign.sent"})
	if !ok || !reflect.DeepEqual(got, []string{"approval.requested", "campaign.sent"}) {
		t.Fatalf("normalized events = %v, ok=%v", got, ok)
	}
	if _, ok := normalizeDeviceEvents([]string{"tenant.secret.dumped"}); ok {
		t.Fatal("unknown event was accepted")
	}
}

func TestExplicitLegacyEventListDoesNotAcquireNewSecurityEvent(t *testing.T) {
	events, ok := normalizeDeviceEvents([]string{"approval.requested", "campaign.sent"})
	if !ok {
		t.Fatal("legacy explicit event list was rejected")
	}
	for _, event := range events {
		if event == "auth.new_device_sign_in" {
			t.Fatal("an explicit old-client registration was silently subscribed to a new security event")
		}
	}
	defaults, ok := normalizeDeviceEvents(nil)
	if !ok || !containsEvent(defaults, "auth.new_device_sign_in") {
		t.Fatal("new registrations do not default the security alert on")
	}
}

func containsEvent(events []string, want string) bool {
	for _, event := range events {
		if event == want {
			return true
		}
	}
	return false
}

func TestSendOneUsesAuthenticatedBodyAndMinimalData(t *testing.T) {
	var gotPath, gotQuery, gotAuth string
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery, gotAuth = r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"ticket-1"}}`))
	}))
	defer server.Close()

	d := &Deps{
		Cipher:          testCipher{plaintext: []byte("ExpoPushToken[device-secret-token]")},
		HTTPClient:      server.Client(),
		ExpoURL:         server.URL + "/--/api/v2/push/send",
		ExpoAccessToken: "server-access-token",
	}
	ticket, err := d.sendOne(context.Background(), storedDevice{ID: "device-1", Envelope: []byte("ciphertext")}, Notification{
		EventType: "approval.requested", EntityID: "approval-1",
		Title: "Approval needed", Body: "A pending request is waiting for your decision.",
		CategoryID: pushCategoryApproval,
	})
	if err != nil {
		t.Fatalf("sendOne: %v", err)
	}
	if ticket.ID != "ticket-1" || ticket.Status != "ok" {
		t.Fatalf("ticket = %#v", ticket)
	}
	if gotPath != "/--/api/v2/push/send" || gotQuery != "" {
		t.Fatalf("request target = %s?%s", gotPath, gotQuery)
	}
	if gotAuth != "Bearer server-access-token" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if got["to"] != "ExpoPushToken[device-secret-token]" {
		t.Fatalf("token was not sent in JSON body: %#v", got["to"])
	}
	data, ok := got["data"].(map[string]any)
	if !ok {
		t.Fatalf("data = %#v", got["data"])
	}
	wantData := map[string]any{"event_type": "approval.requested", "entity_id": "approval-1"}
	if !reflect.DeepEqual(data, wantData) {
		t.Fatalf("data = %#v, want minimal %#v", data, wantData)
	}
	if _, leaked := data["body"]; leaked {
		t.Fatal("customer event body leaked into push data")
	}
}

func TestSendOneNewDeviceAlertCarriesOnlyExactReviewIdentifiers(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"ticket-security"}}`))
	}))
	defer server.Close()

	d := &Deps{
		Cipher:     testCipher{plaintext: []byte("ExpoPushToken[security-device]")},
		HTTPClient: server.Client(),
		ExpoURL:    server.URL,
	}
	notice := Notification{
		EventType:      "auth.new_device_sign_in",
		EntityID:       "MDEyMzQ1Njc4OWFiY2RlZg",
		IdempotencyKey: "auth.new_device_sign_in:MDEyMzQ1Njc4OWFiY2RlZg",
		NotificationID: "feed-notification-id",
	}
	if err := normalizeNotification(&notice); err != nil {
		t.Fatalf("normalizeNotification: %v", err)
	}
	if _, err := d.sendOne(context.Background(), storedDevice{ID: "device-1", Envelope: []byte("ciphertext")}, notice); err != nil {
		t.Fatalf("sendOne: %v", err)
	}

	if got["categoryId"] != pushCategorySecurity || got["channelId"] != "security" {
		t.Fatalf("security presentation mapping = category %#v channel %#v", got["categoryId"], got["channelId"])
	}
	if got["interruptionLevel"] != interruptionTimeSensitive || got["priority"] != "high" {
		t.Fatalf("security priority = %#v / %#v", got["interruptionLevel"], got["priority"])
	}
	data, ok := got["data"].(map[string]any)
	if !ok {
		t.Fatalf("data = %#v", got["data"])
	}
	want := map[string]any{
		"event_type":      "auth.new_device_sign_in",
		"entity_id":       "MDEyMzQ1Njc4OWFiY2RlZg",
		"notification_id": "feed-notification-id",
	}
	if !reflect.DeepEqual(data, want) {
		t.Fatalf("security data = %#v, want %#v", data, want)
	}
	for _, forbidden := range []string{"cookie", "verifier", "device_code", "user_agent", "ip"} {
		if _, leaked := data[forbidden]; leaked {
			t.Fatalf("security data leaked %q", forbidden)
		}
	}
}

func TestParseExpoTicketHandlesSingleAndRejectsAmbiguousBatch(t *testing.T) {
	ticket, err := parseExpoTicket([]byte(`{"data":{"status":"error","details":{"error":"DeviceNotRegistered"}}}`))
	if err != nil || ticket.Details.Error != "DeviceNotRegistered" {
		t.Fatalf("ticket=%#v err=%v", ticket, err)
	}
	if _, err := parseExpoTicket([]byte(`{"data":[{"status":"ok"},{"status":"ok"}]}`)); err == nil {
		t.Fatal("ambiguous ticket batch was accepted")
	}
}

func sortIsStable(values []string) bool {
	for i := 1; i < len(values); i++ {
		if values[i-1] > values[i] {
			return false
		}
	}
	return true
}
