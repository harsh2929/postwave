package mobilepush

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

type fakeDeliveryLifecycleStore struct {
	sendClaims    []claimedSendRetry
	receiptClaims []claimedReceipt
	accepted      []struct {
		id, ticket string
		next       time.Time
	}
	sendFailed []struct {
		id, code string
		next     time.Time
		terminal bool
	}
	delivered      []string
	receiptRetries []struct {
		id, code string
		next     time.Time
		terminal bool
	}
	sendRetries []struct {
		id, code string
		next     time.Time
		terminal bool
	}
	revoked []struct{ tenant, user, device, delivery, code string }
}

func (f *fakeDeliveryLifecycleStore) ClaimSendRetries(context.Context, time.Time, time.Time, int) ([]claimedSendRetry, error) {
	return append([]claimedSendRetry(nil), f.sendClaims...), nil
}

func (f *fakeDeliveryLifecycleStore) ClaimReceipts(context.Context, time.Time, time.Time, int) ([]claimedReceipt, error) {
	return append([]claimedReceipt(nil), f.receiptClaims...), nil
}

func (f *fakeDeliveryLifecycleStore) MarkAccepted(_ context.Context, item claimedSendRetry, ticket string, next time.Time) error {
	f.accepted = append(f.accepted, struct {
		id, ticket string
		next       time.Time
	}{item.ID, ticket, next})
	return nil
}

func (f *fakeDeliveryLifecycleStore) MarkSendFailed(_ context.Context, item claimedSendRetry, code string, next time.Time, terminal bool) error {
	f.sendFailed = append(f.sendFailed, struct {
		id, code string
		next     time.Time
		terminal bool
	}{item.ID, code, next, terminal})
	return nil
}

func (f *fakeDeliveryLifecycleStore) MarkDelivered(_ context.Context, item claimedReceipt) error {
	f.delivered = append(f.delivered, item.ID)
	return nil
}

func (f *fakeDeliveryLifecycleStore) ScheduleReceiptRetry(_ context.Context, item claimedReceipt, code string, next time.Time, terminal bool) error {
	f.receiptRetries = append(f.receiptRetries, struct {
		id, code string
		next     time.Time
		terminal bool
	}{item.ID, code, next, terminal})
	return nil
}

func (f *fakeDeliveryLifecycleStore) ScheduleSendRetry(_ context.Context, item claimedReceipt, code string, next time.Time, terminal bool) error {
	f.sendRetries = append(f.sendRetries, struct {
		id, code string
		next     time.Time
		terminal bool
	}{item.ID, code, next, terminal})
	return nil
}

func (f *fakeDeliveryLifecycleStore) RevokeDevice(_ context.Context, tenant, user, device, delivery, code string) error {
	f.revoked = append(f.revoked, struct{ tenant, user, device, delivery, code string }{tenant, user, device, delivery, code})
	return nil
}

func TestFetchExpoReceiptsUsesAuthenticatedBoundedBody(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody []byte
	d := &Deps{
		ExpoReceiptURL:  "https://expo.invalid/--/api/v2/push/getReceipts",
		ExpoAccessToken: "access-secret",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotAuth = req.Header.Get("Authorization")
			gotPath = req.URL.Path
			gotBody, _ = io.ReadAll(req.Body)
			return jsonResponse(http.StatusOK, `{"data":{"ticket-a":{"status":"ok"},"ticket-b":{"status":"error","details":{"error":"DeviceNotRegistered"}}}}`), nil
		})},
	}
	got, err := d.fetchExpoReceipts(context.Background(), []string{"ticket-b", "ticket-a"})
	if err != nil {
		t.Fatalf("fetchExpoReceipts: %v", err)
	}
	if gotAuth != "Bearer access-secret" || gotPath != "/--/api/v2/push/getReceipts" {
		t.Fatalf("auth/path = %q %q", gotAuth, gotPath)
	}
	if string(gotBody) != `{"ids":["ticket-a","ticket-b"]}` {
		t.Fatalf("body = %s", gotBody)
	}
	if got["ticket-b"].Details.Error != "DeviceNotRegistered" {
		t.Fatalf("receipts = %#v", got)
	}
	if _, err := d.fetchExpoReceipts(context.Background(), make([]string, maxReceiptBatchSize+1)); err == nil {
		t.Fatal("oversized receipt batch was accepted")
	}
}

func TestReceiptWorkerPersistsDeliveredAndRevokesExactDevice(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	store := &fakeDeliveryLifecycleStore{receiptClaims: []claimedReceipt{
		{ID: "delivery-ok", TenantID: "tenant-a", UserID: "user-a", DeviceID: "device-a", TicketID: "ticket-ok", ReceiptAttempts: 1},
		{ID: "delivery-revoked", TenantID: "tenant-b", UserID: "user-b", DeviceID: "device-b", TicketID: "ticket-revoked", ReceiptAttempts: 1},
	}}
	d := &Deps{
		Cipher:         testCipher{},
		ExpoReceiptURL: "https://expo.invalid/receipts",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusOK, `{"data":{"ticket-ok":{"status":"ok"},"ticket-revoked":{"status":"error","details":{"error":"DeviceNotRegistered"}}}}`), nil
		})},
	}
	w := &ReceiptWorker{Deps: d, Store: store, Now: func() time.Time { return now }}
	if err := w.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if !reflect.DeepEqual(store.delivered, []string{"delivery-ok"}) {
		t.Fatalf("delivered = %v", store.delivered)
	}
	if len(store.revoked) != 1 || store.revoked[0].tenant != "tenant-b" || store.revoked[0].device != "device-b" || store.revoked[0].delivery != "delivery-revoked" {
		t.Fatalf("revoked = %#v", store.revoked)
	}
}

func TestReceiptWorkerBoundsMissingAndTransientRetries(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	store := &fakeDeliveryLifecycleStore{receiptClaims: []claimedReceipt{
		{ID: "missing-retry", TicketID: "ticket-missing-1", ReceiptAttempts: 2},
		{ID: "missing-terminal", TicketID: "ticket-missing-2", ReceiptAttempts: maxReceiptAttempts},
		{ID: "rate-retry", TicketID: "ticket-rate-1", ReceiptAttempts: 1, SendAttempts: 2},
		{ID: "rate-terminal", TicketID: "ticket-rate-2", ReceiptAttempts: 1, SendAttempts: maxSendAttempts},
	}}
	d := configuredFakeDeps(t, `{"data":{"ticket-rate-1":{"status":"error","details":{"error":"MessageRateExceeded"}},"ticket-rate-2":{"status":"error","details":{"error":"MessageRateExceeded"}}}}`)
	w := &ReceiptWorker{Deps: d, Store: store, Now: func() time.Time { return now }}
	if err := w.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if len(store.receiptRetries) != 2 {
		t.Fatalf("receipt retries = %#v", store.receiptRetries)
	}
	if store.receiptRetries[0].terminal || !store.receiptRetries[0].next.Equal(now.Add(10*time.Minute)) {
		t.Fatalf("missing retry = %#v", store.receiptRetries[0])
	}
	if !store.receiptRetries[1].terminal || !store.receiptRetries[1].next.IsZero() {
		t.Fatalf("missing terminal = %#v", store.receiptRetries[1])
	}
	if len(store.sendRetries) != 2 || store.sendRetries[0].terminal || !store.sendRetries[0].next.Equal(now.Add(time.Minute)) {
		t.Fatalf("send retries = %#v", store.sendRetries)
	}
	if !store.sendRetries[1].terminal || !store.sendRetries[1].next.IsZero() {
		t.Fatalf("terminal send retry = %#v", store.sendRetries[1])
	}
}

func TestReceiptWorkerRetriesDurableSendAndStoresTicket(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	store := &fakeDeliveryLifecycleStore{sendClaims: []claimedSendRetry{{
		ID: "delivery-1", TenantID: "tenant-1", UserID: "user-1", Attempts: 2,
		Device: storedDevice{ID: "device-1", Envelope: []byte("encrypted")},
		Notice: Notification{EventType: "campaign.sent", IdempotencyKey: "campaign.sent:1", Title: "Campaign sent", Body: "A campaign finished sending.", CategoryID: pushCategoryEntity},
	}}}
	d := configuredFakeDeps(t, `{"data":{}}`)
	d.ExpoURL = "https://expo.invalid/send"
	d.Cipher = testCipher{plaintext: []byte("ExpoPushToken[rotated-device]")}
	d.HTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/send" {
			return jsonResponse(http.StatusOK, `{"data":{"status":"ok","id":"ticket-1"}}`), nil
		}
		return jsonResponse(http.StatusOK, `{"data":{}}`), nil
	})}
	w := &ReceiptWorker{Deps: d, Store: store, Now: func() time.Time { return now }}
	if err := w.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if len(store.accepted) != 1 || store.accepted[0].ticket != "ticket-1" || !store.accepted[0].next.Equal(now.Add(initialReceiptDelay)) {
		t.Fatalf("accepted = %#v", store.accepted)
	}
}

func TestReceiptWorkerMakesPermanentHTTPFailureTerminal(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	store := &fakeDeliveryLifecycleStore{sendClaims: []claimedSendRetry{{
		ID: "delivery-1", Attempts: 1,
		Device: storedDevice{ID: "device-1", Envelope: []byte("encrypted")},
		Notice: Notification{EventType: "campaign.sent", IdempotencyKey: "campaign.sent:1", Title: "Campaign sent", Body: "A campaign finished sending.", CategoryID: pushCategoryEntity},
	}}}
	d := configuredFakeDeps(t, `{"data":{}}`)
	d.ExpoURL = "https://expo.invalid/send"
	d.Cipher = testCipher{plaintext: []byte("ExpoPushToken[device]")}
	d.HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusBadRequest, `{"errors":[{"message":"do not persist this body"}]}`), nil
	})}
	w := &ReceiptWorker{Deps: d, Store: store, Now: func() time.Time { return now }}
	if err := w.Tick(context.Background()); err == nil {
		t.Fatal("Tick unexpectedly hid permanent upstream failure")
	}
	if len(store.sendFailed) != 1 || !store.sendFailed[0].terminal || !store.sendFailed[0].next.IsZero() {
		t.Fatalf("send failures = %#v", store.sendFailed)
	}
}

func TestReceiptWorkerRetriesTransientSendHTTPFailure(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	store := &fakeDeliveryLifecycleStore{sendClaims: []claimedSendRetry{{
		ID: "delivery-1", Attempts: 2,
		Device: storedDevice{ID: "device-1", Envelope: []byte("encrypted")},
		Notice: Notification{EventType: "campaign.sent", IdempotencyKey: "campaign.sent:1", Title: "Campaign sent", Body: "A campaign finished sending.", CategoryID: pushCategoryEntity},
	}}}
	d := configuredFakeDeps(t, `{"data":{}}`)
	d.ExpoURL = "https://expo.invalid/send"
	d.Cipher = testCipher{plaintext: []byte("ExpoPushToken[device]")}
	d.HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusServiceUnavailable, `{}`), nil
	})}
	w := &ReceiptWorker{Deps: d, Store: store, Now: func() time.Time { return now }}
	if err := w.Tick(context.Background()); err == nil {
		t.Fatal("Tick unexpectedly hid transient upstream failure")
	}
	if len(store.sendFailed) != 1 || store.sendFailed[0].terminal || !store.sendFailed[0].next.Equal(now.Add(time.Minute)) {
		t.Fatalf("send failures = %#v", store.sendFailed)
	}
}

func TestReceiptWorkerRetriesTransientReceiptHTTPFailure(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	store := &fakeDeliveryLifecycleStore{receiptClaims: []claimedReceipt{{
		ID: "delivery-1", TicketID: "ticket-1", ReceiptAttempts: 2,
	}}}
	d := configuredFakeDeps(t, `{}`)
	d.HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusServiceUnavailable, `{}`), nil
	})}
	w := &ReceiptWorker{Deps: d, Store: store, Now: func() time.Time { return now }}
	if err := w.Tick(context.Background()); err == nil {
		t.Fatal("Tick unexpectedly hid transient receipt failure")
	}
	if len(store.receiptRetries) != 1 || store.receiptRetries[0].terminal || !store.receiptRetries[0].next.Equal(now.Add(10*time.Minute)) {
		t.Fatalf("receipt retries = %#v", store.receiptRetries)
	}
}

func TestExpoRequestHasIndependentTimeoutAndResponseLimit(t *testing.T) {
	d := &Deps{HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		deadline, ok := req.Context().Deadline()
		if !ok || time.Until(deadline) > expoRequestTimeout+time.Second {
			t.Fatalf("missing/broad request deadline: %v %v", deadline, ok)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(make([]byte, maxExpoResponseBytes+1)))}, nil
	})}}
	if _, err := d.postExpoJSON(context.Background(), "https://expo.invalid", []byte(`{}`)); err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("oversized response error = %v", err)
	}
}

func TestParseExpoTicketRequiresTicketIDAfterAcceptance(t *testing.T) {
	if _, err := parseExpoTicket([]byte(`{"data":{"status":"ok"}}`)); err == nil {
		t.Fatal("accepted response without ticket id was accepted")
	}
}

func configuredFakeDeps(t *testing.T, receiptBody string) *Deps {
	t.Helper()
	// ReceiptWorker's injected store means Pool is never dereferenced. Use a
	// test-only registration cipher and an HTTP transport with no real network.
	return &Deps{
		Cipher:             testCipher{plaintext: []byte("ExpoPushToken[test]")},
		ExpoReceiptURL:     "https://expo.invalid/receipts",
		ExpoAccessToken:    "test-access",
		RequireAccessToken: true,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Header.Get("Authorization") != "Bearer test-access" {
				return nil, errors.New("missing authenticated Expo access token")
			}
			return jsonResponse(http.StatusOK, receiptBody), nil
		})},
	}
}
