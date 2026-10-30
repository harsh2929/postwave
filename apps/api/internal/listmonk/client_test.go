package listmonk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/testsupport/listmonkv6"
)

func TestClientSuccessResponseBodyIsCapped(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(strings.Repeat("{", int(listmonkClientMaxResponseBodyBytes)+1)))
	}))
	defer upstream.Close()

	c := New(Config{BaseURL: upstream.URL})
	_, err := c.FindSubscriberByEmail(context.Background(), "a@example.com")
	if err == nil {
		t.Fatal("expected decode error")
	}
	if !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("err = %v, want body size error", err)
	}
}

func TestDefinitelyRejectedRequiresUpstream4xx(t *testing.T) {
	if !DefinitelyRejected(fmt.Errorf("wrapped: %w", &HTTPError{StatusCode: http.StatusBadRequest})) {
		t.Fatal("wrapped 4xx should be a definite rejection")
	}
	if DefinitelyRejected(&HTTPError{StatusCode: http.StatusInternalServerError}) || DefinitelyRejected(context.DeadlineExceeded) {
		t.Fatal("5xx and transport failures must remain ambiguous")
	}
	for _, status := range []int{http.StatusRequestTimeout, http.StatusConflict, 499} {
		if DefinitelyRejected(&HTTPError{StatusCode: status}) {
			t.Fatalf("status %d must remain ambiguous", status)
		}
	}
}

func TestClientURLBuilderPreservesBasePathAndQuery(t *testing.T) {
	calls := make([]string, 0, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.String())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"results": []map[string]any{{"id": 1, "email": "a@example.com"}},
			},
		})
	}))
	defer upstream.Close()

	c := New(Config{BaseURL: upstream.URL + "/listmonk///"})
	_, err := c.FindSubscriberByEmail(context.Background(), "a@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(calls))
	}
	if !strings.HasPrefix(calls[0], "/listmonk/api/subscribers?") {
		t.Fatalf("call = %q, want base path + subscriber query", calls[0])
	}
}

func TestClientRejectsUnsafeBaseURL(t *testing.T) {
	c := New(Config{BaseURL: "https://user:pass@example.test"})
	err := c.SendTransactional(context.Background(), SendTransactionalReq{SubscriberEmail: "a@example.com"})
	if err == nil || !strings.Contains(err.Error(), "unsafe base URL") {
		t.Fatalf("err = %v, want unsafe base URL", err)
	}
}

func TestListmonkURLRejectsEncodedTraversalAndBackslashes(t *testing.T) {
	for _, path := range []string{
		"/api/%2e%2e/subscribers",
		"/api/%2E/subscribers",
		"/api\\subscribers",
	} {
		if _, err := listmonkURL("https://listmonk.example.test", path); err == nil {
			t.Fatalf("path %q should be rejected", path)
		}
	}
}

// TestSendTransactionalAttachesHeaders proves that Headers passed on
// SendTransactionalReq ride on the wire as HTTP request headers, and
// that the JSON body does NOT leak them (they're stripped via the
// json:"-" tag).
func TestSendTransactionalAttachesHeaders(t *testing.T) {
	var (
		gotHeaders http.Header
		gotBody    []byte
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeaders = r.Header.Clone()
		gotBody, _ = readAllSmall(r)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	c := New(Config{BaseURL: upstream.URL})
	err := c.SendTransactional(context.Background(), SendTransactionalReq{
		SubscriberEmail: "a@example.com",
		Subject:         "hi",
		IdempotencyKey:  "cr-42",
		Headers: map[string]string{
			"List-Unsubscribe":      "<https://hosted/u/abc>, <mailto:u@example.com>",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if got := gotHeaders.Get("Idempotency-Key"); got != "cr-42" {
		t.Fatalf("Idempotency-Key = %q, want cr-42", got)
	}
	if got := gotHeaders.Get("List-Unsubscribe"); got == "" {
		t.Fatalf("List-Unsubscribe header missing; got = %v", gotHeaders)
	}
	if got := gotHeaders.Get("List-Unsubscribe-Post"); got != "List-Unsubscribe=One-Click" {
		t.Fatalf("List-Unsubscribe-Post = %q", got)
	}
	if strings.Contains(string(gotBody), "List-Unsubscribe") {
		t.Fatalf("request body leaked headers: %s", gotBody)
	}
}

// TestSendTransactionalIdempotencyKeyAlwaysWins ensures a caller can't
// override the Idempotency-Key by jamming one into the Headers map.
func TestSendTransactionalIdempotencyKeyAlwaysWins(t *testing.T) {
	var got http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	c := New(Config{BaseURL: upstream.URL})
	err := c.SendTransactional(context.Background(), SendTransactionalReq{
		SubscriberEmail: "a@example.com",
		IdempotencyKey:  "real-key",
		Headers: map[string]string{
			"Idempotency-Key": "hacker-key",
			"X-Other":         "ok",
		},
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if k := got.Get("Idempotency-Key"); k != "real-key" {
		t.Fatalf("Idempotency-Key = %q, want real-key", k)
	}
	if k := got.Get("X-Other"); k != "ok" {
		t.Fatalf("X-Other = %q", k)
	}
}

// TestSendTransactionalEmptyHeadersIsNoOp ensures the no-headers path
// remains identical to pre-Headers behaviour.
func TestSendTransactionalEmptyHeadersIsNoOp(t *testing.T) {
	var got http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	c := New(Config{BaseURL: upstream.URL})
	err := c.SendTransactional(context.Background(), SendTransactionalReq{
		SubscriberEmail: "a@example.com",
		Headers:         map[string]string{"": "skip-me", "X-Empty": ""},
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if k := got.Get("Idempotency-Key"); k != "" {
		t.Fatalf("Idempotency-Key should be absent, got %q", k)
	}
	if k := got.Get("X-Empty"); k != "" {
		t.Fatalf("X-Empty should be dropped, got %q", k)
	}
}

// replay answers every request with one recorded Listmonk v6.1.0 body and
// captures the request, so a decode test runs against the real wire bytes.
func replay(t *testing.T, status int, recorded string) (*Client, *capturedRequest) {
	t.Helper()
	captured := &capturedRequest{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.method = r.Method
		captured.path = r.URL.Path
		captured.body, _ = readAllSmall(r)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(listmonkv6.Recorded(recorded))
	}))
	t.Cleanup(upstream.Close)
	return New(Config{BaseURL: upstream.URL}), captured
}

type capturedRequest struct {
	method string
	path   string
	body   []byte
}

// The first signup to any list-targeted form failed here: Listmonk returns a
// subscriber's lists as objects and the client decoded them into []int64,
// after Listmonk had committed the subscriber.
func TestCreateSubscriberDecodesTheRecordedV61Response(t *testing.T) {
	c, _ := replay(t, http.StatusOK, listmonkv6.RecordedCreateSubscriberWithList)
	sub, err := c.CreateSubscriber(context.Background(), CreateSubscriberReq{
		Email: "diag-1@example.com", Status: SubscriberDisabled, Lists: []int64{3},
	})
	if err != nil {
		t.Fatalf("CreateSubscriber on the recorded v6.1.0 body: %v", err)
	}
	want := []SubscriberList{{ID: 3, Name: "A", SubscriptionStatus: SubscriptionUnconfirmed}}
	if sub.ID != 3 || sub.Status != SubscriberDisabled || !reflect.DeepEqual(sub.Lists, want) {
		t.Fatalf("decoded %+v, want id 3, disabled, lists %+v", sub, want)
	}
}

func TestFindSubscriberByEmailDecodesTheRecordedV61Response(t *testing.T) {
	c, captured := replay(t, http.StatusOK, listmonkv6.RecordedQuerySubscribers)
	sub, err := c.FindSubscriberByEmail(context.Background(), "diag-1@example.com")
	if err != nil {
		t.Fatalf("FindSubscriberByEmail on the recorded v6.1.0 body: %v", err)
	}
	if sub == nil || sub.ID != 3 {
		t.Fatalf("decoded %+v, want id 3", sub)
	}
	got, ok := sub.Subscription(3)
	if !ok || got.SubscriptionStatus != SubscriptionUnconfirmed {
		t.Fatalf("Subscription(3) = %+v, %v; want unconfirmed", got, ok)
	}
	if _, ok := sub.Subscription(4); ok {
		t.Fatal("Subscription(4) found a list the subscriber is not on")
	}
	if captured.method != http.MethodGet || captured.path != "/api/subscribers" {
		t.Fatalf("request = %s %s", captured.method, captured.path)
	}
}

// PUT /api/subscribers/:id replaces every subscription with the body's lists;
// a status flip must therefore be a PATCH whose body has no lists key.
func TestUpdateSubscriberStatusIsAPatchWithoutLists(t *testing.T) {
	c, captured := replay(t, http.StatusOK, listmonkv6.RecordedPatchSubscriber)
	if err := c.UpdateSubscriberStatus(context.Background(), 3, UpdateSubscriberStatusReq{
		Email: "diag-1@example.com", Status: SubscriberEnabled,
	}); err != nil {
		t.Fatalf("UpdateSubscriberStatus: %v", err)
	}
	if captured.method != http.MethodPatch || captured.path != "/api/subscribers/3" {
		t.Fatalf("request = %s %s, want PATCH /api/subscribers/3", captured.method, captured.path)
	}
	if got, want := string(captured.body), `{"email":"diag-1@example.com","status":"enabled"}`; got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}

// The same flip against v6.1.0's subscription semantics: the subscriber must
// keep every list and every attrib it had.
func TestUpdateSubscriberStatusKeepsEverySubscriptionOnListmonkV61(t *testing.T) {
	upstream := listmonkv6.NewServer(t)
	upstream.AddList(3, "A", "single")
	upstream.AddList(4, "B", "single")
	id := upstream.SeedSubscriber("keep@example.com", "Keep", SubscriberDisabled,
		map[string]any{"city": "Oslo"},
		map[int64]string{3: SubscriptionUnconfirmed, 4: SubscriptionConfirmed})

	c := New(Config{BaseURL: upstream.URL})
	if err := c.UpdateSubscriberStatus(context.Background(), id, UpdateSubscriberStatusReq{
		Email: "keep@example.com", Status: SubscriberEnabled,
	}); err != nil {
		t.Fatalf("UpdateSubscriberStatus: %v", err)
	}
	got, _ := upstream.Subscriber("keep@example.com")
	if want := map[int64]string{3: SubscriptionUnconfirmed, 4: SubscriptionConfirmed}; !reflect.DeepEqual(got.Lists, want) {
		t.Fatalf("subscriptions after the status update = %v, want %v unchanged", got.Lists, want)
	}
	if got.Status != SubscriberEnabled || got.Attribs["city"] != "Oslo" {
		t.Fatalf("status %q attribs %v, want enabled with attribs kept", got.Status, got.Attribs)
	}
}

func TestUpdateSubscriberAttribsMergesIntoTheStoredAttribs(t *testing.T) {
	upstream := listmonkv6.NewServer(t)
	upstream.AddList(3, "A", "single")
	id := upstream.SeedSubscriber("attr@example.com", "", SubscriberEnabled,
		map[string]any{"city": "Oslo", "plan": "free"}, map[int64]string{3: SubscriptionConfirmed})

	c := New(Config{BaseURL: upstream.URL})
	if err := c.UpdateSubscriberAttribs(context.Background(), id, "attr@example.com", map[string]any{"plan": "pro"}); err != nil {
		t.Fatalf("UpdateSubscriberAttribs: %v", err)
	}
	got, _ := upstream.Subscriber("attr@example.com")
	if got.Attribs["city"] != "Oslo" || got.Attribs["plan"] != "pro" {
		t.Fatalf("attribs = %v, want city kept and plan updated", got.Attribs)
	}
	if got.Status != SubscriberEnabled || got.Lists[3] != SubscriptionConfirmed {
		t.Fatalf("status %q lists %v changed", got.Status, got.Lists)
	}
	requests := upstream.RequestsTo(http.MethodPatch, "/api/subscribers/"+strconv.FormatInt(id, 10))
	if len(requests) != 1 {
		t.Fatalf("PATCH requests = %d, want 1", len(requests))
	}
	if err := c.UpdateSubscriberAttribs(context.Background(), id, "attr@example.com", nil); err != nil {
		t.Fatalf("empty attribs: %v", err)
	}
	if n := len(upstream.Requests()); n != 1 {
		t.Fatalf("an empty attribs update reached Listmonk (%d requests)", n)
	}
}

func TestAddSubscribersToListsSendsTheManageListsBody(t *testing.T) {
	c, captured := replay(t, http.StatusOK, listmonkv6.RecordedManageSubscriberLists)
	if err := c.AddSubscribersToLists(context.Background(), []int64{3}, []int64{4}, SubscriptionUnconfirmed); err != nil {
		t.Fatalf("AddSubscribersToLists: %v", err)
	}
	if captured.method != http.MethodPut || captured.path != "/api/subscribers/lists" {
		t.Fatalf("request = %s %s", captured.method, captured.path)
	}
	if got, want := string(captured.body), `{"ids":[3],"action":"add","target_list_ids":[4],"status":"unconfirmed"}`; got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}

func TestAddSubscribersToListsRefusesAnythingButAnAddStatus(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer upstream.Close()
	c := New(Config{BaseURL: upstream.URL})
	for _, status := range []string{"", SubscriptionUnsubscribed, "blocklisted"} {
		if err := c.AddSubscribersToLists(context.Background(), []int64{1}, []int64{2}, status); err == nil {
			t.Fatalf("status %q was accepted", status)
		}
	}
	if calls != 0 {
		t.Fatalf("%d requests reached Listmonk", calls)
	}
}

// A 2xx whose body cannot be read is a committed upstream write, not an
// outage. The error must say so in its type and must not carry the address.
func TestUndecodableSuccessIsATypedDecodeErrorWithoutTheAddress(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"results":[{"id":"not-a-number"}]}}`))
	}))
	defer upstream.Close()
	_, err := New(Config{BaseURL: upstream.URL}).FindSubscriberByEmail(context.Background(), "secret.person@example.com")
	var decodeErr *DecodeError
	if !errors.As(err, &decodeErr) {
		t.Fatalf("err = %T %v, want *DecodeError", err, err)
	}
	var upstreamErr *HTTPError
	if errors.As(err, &upstreamErr) {
		t.Fatal("a decode failure also reads as an upstream HTTP failure")
	}
	if decodeErr.Path != "/api/subscribers" || strings.Contains(err.Error(), "secret.person") {
		t.Fatalf("decode error exposes the query: path %q message %q", decodeErr.Path, err.Error())
	}
}

func TestHTTPErrorMessageOmitsTheQueryString(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"message":"upstream"}`))
	}))
	defer upstream.Close()
	_, err := New(Config{BaseURL: upstream.URL}).FindSubscriberByEmail(context.Background(), "secret.person@example.com")
	var upstreamErr *HTTPError
	if !errors.As(err, &upstreamErr) || upstreamErr.StatusCode != http.StatusBadGateway {
		t.Fatalf("err = %v, want HTTPError 502", err)
	}
	if strings.Contains(err.Error(), "secret.person") || strings.Contains(err.Error(), "secret.person%40") {
		t.Fatalf("HTTPError message carries the address: %s", err.Error())
	}
}

func readAllSmall(r *http.Request) ([]byte, error) {
	const cap = 16 << 10
	buf := make([]byte, 0, cap)
	tmp := make([]byte, 1024)
	for {
		n, err := r.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if len(buf) > cap {
				return buf[:cap], nil
			}
		}
		if err != nil {
			return buf, nil
		}
	}
}
