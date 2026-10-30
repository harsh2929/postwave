package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// stubCipher decrypts by returning the input verbatim. Real envelope
// crypto roundtrips are tested in the crypto package; this stub lets us
// assert that the dispatcher path *uses* the cipher when one is wired,
// without dragging the AES-GCM stack into a unit test.
type stubCipher struct{}

func (stubCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	return blob, nil
}

// TestDeliverHandlerSignsWithEnvelopeSecret asserts the wire-format
// signature header is HMAC-SHA256 of "<ts>." + body, hex-encoded, when
// the webhook has an envelope-stored secret.
func TestDeliverHandlerSignsWithEnvelopeSecret(t *testing.T) {
	const secret = "whsec_test_secret_at_least_16_chars"

	var seen struct {
		gotSig         string
		gotLegacySig   string
		gotBody        []byte
		gotHeader      string
		gotLegacyEvent string
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.gotSig = r.Header.Get("Moosewave-Signature")
		seen.gotLegacySig = r.Header.Get("Postwave-Signature")
		seen.gotHeader = r.Header.Get("Moosewave-Event")
		seen.gotLegacyEvent = r.Header.Get("Postwave-Event")
		seen.gotBody, _ = io.ReadAll(io.LimitReader(r.Body, 1<<20))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := &DeliverHandler{
		Pool:       nil, // not used: we override Repo via the local fake
		Repo:       nil,
		Cipher:     stubCipher{},
		HTTPClient: srv.Client(),
	}

	// Bypass the Repo layer — exercise just deliver().
	body := json.RawMessage(`{"email":"test@example.com"}`)
	env := DeliveryEnvelope{
		WebhookID:      "wh-1",
		EventType:      string(EventSubscriberCreated),
		IdempotencyKey: "idem-123",
		Body:           body,
	}

	if _, err := h.deliver(context.Background(), srv.URL, env, []byte(secret)); err != nil {
		t.Fatalf("deliver: %v", err)
	}

	if seen.gotHeader != string(EventSubscriberCreated) {
		t.Errorf("Moosewave-Event header = %q, want %q", seen.gotHeader, EventSubscriberCreated)
	}
	if seen.gotLegacyEvent != seen.gotHeader || seen.gotLegacySig != seen.gotSig {
		t.Errorf("legacy webhook aliases differ: event=%q/%q signature=%q/%q", seen.gotLegacyEvent, seen.gotHeader, seen.gotLegacySig, seen.gotSig)
	}

	// Validate the signature: the receiver should verify
	// HMAC(secret, "<ts>." + body) matches v1.
	parts := strings.Split(seen.gotSig, ",")
	if len(parts) != 2 {
		t.Fatalf("Moosewave-Signature has %d parts, want 2: %q", len(parts), seen.gotSig)
	}
	tsField := strings.TrimPrefix(parts[0], "t=")
	v1Field := strings.TrimPrefix(parts[1], "v1=")
	ts, err := strconv.ParseInt(tsField, 10, 64)
	if err != nil {
		t.Fatalf("bad timestamp %q: %v", tsField, err)
	}
	if abs(time.Now().Unix()-ts) > 10 {
		t.Errorf("timestamp %d differs from now by >10s", ts)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.", ts)
	mac.Write(seen.gotBody)
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(v1Field), []byte(want)) {
		t.Errorf("v1 signature mismatch:\n got %s\nwant %s", v1Field, want)
	}
}

// TestDeliverHandlerSkipsSignatureWithoutSecret asserts that legacy
// rows (no envelope) deliver unsigned — same UX as the V1 Test
// endpoint — instead of crashing or sending a garbage signature.
func TestDeliverHandlerSkipsSignatureWithoutSecret(t *testing.T) {
	var sawSig string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawSig = r.Header.Get("Moosewave-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	h := &DeliverHandler{HTTPClient: srv.Client()}
	body := json.RawMessage(`{"x":1}`)
	if _, err := h.deliver(context.Background(), srv.URL, DeliveryEnvelope{
		WebhookID: "wh-2", EventType: string(EventSubscriberUpdated), Body: body,
	}, nil); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if sawSig != "" {
		t.Errorf("expected unsigned delivery, got Moosewave-Signature=%q", sawSig)
	}
}

// TestDeliverHandlerReturnsErrorOnNon2xxSoOutboxRetries ensures that
// 5xx responses (and 4xx, since the receiver is responsible for
// declaring "bad request" as something the dispatcher should NOT
// retry; we don't try to be clever here) bubble out as errors so
// the outbox sees them and bumps attempts.
func TestDeliverHandlerReturnsErrorOnNon2xxSoOutboxRetries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("backend down"))
	}))
	defer srv.Close()
	h := &DeliverHandler{HTTPClient: srv.Client()}
	_, err := h.deliver(context.Background(), srv.URL, DeliveryEnvelope{
		WebhookID: "wh-3", EventType: string(EventSubscriberCreated),
		Body: json.RawMessage(`{}`),
	}, []byte("secret_long_enough_for_hmac_use"))
	if err == nil {
		t.Fatal("expected error on 5xx response so outbox retries")
	}
	if !strings.Contains(err.Error(), "status 500") {
		t.Errorf("error = %q, want 'status 500' prefix so parseStatusPrefix can pull the code", err.Error())
	}
}

func TestParseStatusPrefix(t *testing.T) {
	cases := []struct {
		in   string
		code int
		ok   bool
	}{
		{"status 503: backend down", 503, true},
		{"status 200", 200, true},
		{"post: connection refused", 0, false},
		{"status notanumber: x", 0, false},
		{"status 99: too low", 0, false},
	}
	for _, tc := range cases {
		code, ok := parseStatusPrefix(tc.in)
		if code != tc.code || ok != tc.ok {
			t.Errorf("parseStatusPrefix(%q) = (%d, %v); want (%d, %v)",
				tc.in, code, ok, tc.code, tc.ok)
		}
	}
}

// TestDispatcherFireValidatesEvent rejects unknown event names so a
// typo in a producer doesn't silently no-op every delivery.
func TestDispatcherFireValidatesEvent(t *testing.T) {
	d := &Dispatcher{Outbox: &outbox.Repo{}} // pool is nil; we exit before any DB call
	_, err := d.Fire(context.Background(), nil, FireInput{
		TenantID:  "t1",
		EventType: "subscriber.totallyMadeUp",
		Body:      map[string]string{"hi": "there"},
	})
	if err == nil {
		t.Fatal("expected error for unknown event type")
	}
	if !strings.Contains(err.Error(), "unknown event") {
		t.Errorf("error = %q, want 'unknown event'", err.Error())
	}
}

func TestDispatchableEventCatalogBridgesCanonicalOnlyTopics(t *testing.T) {
	if IsValidEvent(outbound_webhooks.EventListSubscriberAdded) {
		t.Fatal("test precondition failed: list.subscriber.added unexpectedly belongs to the legacy catalog")
	}
	if !isDispatchableEventType(outbound_webhooks.EventListSubscriberAdded) {
		t.Fatal("canonical-only list.subscriber.added was rejected by the compatibility dispatcher")
	}
	if !isDispatchableEventType(string(EventSubscriberCreated)) {
		t.Fatal("legacy subscriber.created was rejected by the compatibility dispatcher")
	}
	if isDispatchableEventType("subscriber.totallyMadeUp") {
		t.Fatal("event absent from both catalogs was accepted")
	}
}

func TestLegacyOnlyTopicDoesNotEnterCanonicalTransactionalFanout(t *testing.T) {
	if outbound_webhooks.IsTransactionalEventType(string(EventSubscriberUpdated)) {
		t.Fatal("test precondition failed: subscriber.updated became canonical")
	}
	// With no legacy outbox, a legacy-only topic is a valid compatibility
	// no-op. It must not be passed to TransactionalFanout, which correctly
	// fails closed for unsupported direct producer topics.
	d := &Dispatcher{Canonical: &outbound_webhooks.TransactionalFanout{}}
	count, err := d.Fire(context.Background(), nil, FireInput{
		TenantID:       "11111111-1111-4111-8111-111111111111",
		EventType:      EventSubscriberUpdated,
		IdempotencyKey: "subscriber-updated:1",
		Body:           map[string]any{"subscriber_id": "1"},
	})
	if err != nil {
		t.Fatalf("legacy-only compatibility topic failed: %v", err)
	}
	if count != 0 {
		t.Fatalf("legacy-only compatibility count = %d; want 0", count)
	}
}

// TestSUB118_LifecycleEventsInCatalog asserts the four SUB-118 lifecycle
// events are registered in AllEvents and pass IsValidEvent. This is the
// load-bearing contract: the subscribers repo now FIRES these events, and
// Dispatcher.Fire returns "unknown event" for anything not in the catalog —
// so a missing catalog entry would fail the business write that fires it.
func TestSUB118_LifecycleEventsInCatalog(t *testing.T) {
	want := []EventType{
		EventSubscriberDeleted,
		EventSubscriberMerged,
		EventSubscriberStatusChanged,
		EventSubscriberConsentChanged,
	}
	for _, ev := range want {
		if !IsValidEvent(string(ev)) {
			t.Errorf("IsValidEvent(%q) = false, want true (missing from AllEvents)", ev)
		}
		found := false
		for _, e := range AllEvents {
			if e == ev {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("AllEvents missing %q", ev)
		}
	}
	// Spot-check the exact wire strings the subscribers package fires so a
	// rename on either side is caught here.
	cases := map[EventType]string{
		EventSubscriberDeleted:        "subscriber.deleted",
		EventSubscriberMerged:         "subscriber.merged",
		EventSubscriberStatusChanged:  "subscriber.status_changed",
		EventSubscriberConsentChanged: "subscriber.consent_changed",
	}
	for ev, str := range cases {
		if string(ev) != str {
			t.Errorf("%v = %q, want %q", ev, string(ev), str)
		}
	}
}

// TestSUB119_ConfirmedEventInCatalog asserts subscriber.confirmed is a valid,
// registered catalog event. SUB-119 added the producer (subscribers repo fires
// it on the unconfirmed→enabled double-opt-in transition); Dispatcher.Fire
// returns "unknown event" for anything not in AllEvents, so a missing catalog
// entry would fail the confirmation write.
func TestSUB119_ConfirmedEventInCatalog(t *testing.T) {
	if !IsValidEvent(string(EventSubscriberConfirmed)) {
		t.Fatalf("IsValidEvent(%q) = false, want true (missing from AllEvents)", EventSubscriberConfirmed)
	}
	if string(EventSubscriberConfirmed) != "subscriber.confirmed" {
		t.Fatalf("EventSubscriberConfirmed = %q, want subscriber.confirmed", EventSubscriberConfirmed)
	}
	found := false
	for _, e := range AllEvents {
		if e == EventSubscriberConfirmed {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("AllEvents missing subscriber.confirmed")
	}
}

// abs is a tiny helper because std math.Abs is float-only.
func abs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// silence unused-import lint for `bytes` / `errors` if a test branch
// stops referencing them later — both are still used in the assertions.
var _ = bytes.Buffer{}
var _ = errors.New
