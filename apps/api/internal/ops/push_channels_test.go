// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// --- formatText -------------------------------------------------------------

func TestFormatText(t *testing.T) {
	cases := []struct {
		name string
		m    PushMessage
		want string
	}{
		{
			name: "alert critical is red",
			m:    PushMessage{Kind: PushAlert, Severity: SevCritical, Title: "DLQ backing up", Body: "3 dead-lettered"},
			want: "🔴 *DLQ backing up*\n3 dead-lettered",
		},
		{
			name: "alert high is orange",
			m:    PushMessage{Kind: PushAlert, Severity: SevHigh, Title: "Bounce rate", Body: "4.2% last hour"},
			want: "🟠 *Bounce rate*\n4.2% last hour",
		},
		{
			name: "resolved",
			m:    PushMessage{Kind: PushResolved, Severity: SevCritical, Title: "DLQ backing up", Body: "recovered"},
			want: "✅ *DLQ backing up*\nrecovered",
		},
		{
			name: "repush",
			m:    PushMessage{Kind: PushRepush, Severity: SevHigh, Title: "Still red", Body: "4h and counting"},
			want: "⏰ *Still red*\n4h and counting",
		},
		{
			name: "digest has zero severity",
			m:    PushMessage{Kind: PushDigest, Title: "Morning digest", Body: "all green"},
			want: "🗞️ *Morning digest*\nall green",
		},
		{
			name: "canary has zero severity",
			m:    PushMessage{Kind: PushCanary, Title: "Canary", Body: "push path alive"},
			want: "🪶 *Canary*\npush path alive",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatText(tc.m); got != tc.want {
				t.Errorf("formatText() = %q, want %q", got, tc.want)
			}
		})
	}
}

// --- Slack channel ----------------------------------------------------------

// slackSink is an httptest handler that records the last request and replies
// with a fixed status + body, the way Slack's incoming-webhook endpoint does.
type slackSink struct {
	status int
	body   string

	method      string
	contentType string
	gotBody     []byte
}

func (s *slackSink) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.method = r.Method
		s.contentType = r.Header.Get("Content-Type")
		s.gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(s.status)
		_, _ = fmt.Fprint(w, s.body)
	}
}

func TestSlackWebhookChannel_SendOK(t *testing.T) {
	sink := &slackSink{status: http.StatusOK, body: "ok"}
	srv := httptest.NewServer(sink.handler())
	defer srv.Close()

	ch := NewSlackWebhookChannel(srv.URL, srv.Client())
	if got := ch.Name(); got != "slack" {
		t.Errorf("Name() = %q, want %q", got, "slack")
	}

	m := PushMessage{Kind: PushAlert, CheckID: "billing.dlq-depth", Severity: SevCritical,
		Title: "DLQ backing up", Body: "3 dead-lettered, oldest 7d ago"}
	if err := ch.Send(context.Background(), m); err != nil {
		t.Fatalf("Send() = %v, want nil", err)
	}

	if sink.method != http.MethodPost {
		t.Errorf("method = %q, want POST", sink.method)
	}
	if !strings.HasPrefix(sink.contentType, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", sink.contentType)
	}

	var payload struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(sink.gotBody, &payload); err != nil {
		t.Fatalf("body is not JSON: %v (body=%q)", err, sink.gotBody)
	}
	if !strings.Contains(payload.Text, "DLQ backing up") {
		t.Errorf("text %q does not contain the title", payload.Text)
	}
	if payload.Text != formatText(m) {
		t.Errorf("text = %q, want formatText output %q", payload.Text, formatText(m))
	}
	// The payload must be exactly {"text": ...} — no Block Kit.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(sink.gotBody, &raw); err != nil {
		t.Fatalf("body is not a JSON object: %v", err)
	}
	if len(raw) != 1 {
		t.Errorf("payload has keys beyond \"text\": %v", raw)
	}
}

func TestSlackWebhookChannel_OKWithWhitespace(t *testing.T) {
	// Success check trims the body: "ok\n" is still success.
	sink := &slackSink{status: http.StatusOK, body: "ok\n"}
	srv := httptest.NewServer(sink.handler())
	defer srv.Close()

	ch := NewSlackWebhookChannel(srv.URL, srv.Client())
	if err := ch.Send(context.Background(), PushMessage{Kind: PushCanary, Title: "Canary"}); err != nil {
		t.Fatalf("Send() with body \"ok\\n\" = %v, want nil", err)
	}
}

func TestSlackWebhookChannel_200WithErrorBody(t *testing.T) {
	// Slack can answer 200 with an error string; that is NOT success.
	sink := &slackSink{status: http.StatusOK, body: "no_service"}
	srv := httptest.NewServer(sink.handler())
	defer srv.Close()

	ch := NewSlackWebhookChannel(srv.URL, srv.Client())
	err := ch.Send(context.Background(), PushMessage{Kind: PushAlert, Severity: SevHigh, Title: "T", Body: "B"})
	if err == nil {
		t.Fatal("Send() = nil, want error for 200 + non-ok body")
	}
	if !strings.Contains(err.Error(), "no_service") {
		t.Errorf("error %q does not carry the body snippet", err)
	}
	if !strings.Contains(err.Error(), "200") {
		t.Errorf("error %q does not carry the status", err)
	}
}

func TestSlackWebhookChannel_HTTPError(t *testing.T) {
	sink := &slackSink{status: http.StatusNotFound, body: "no_team"}
	srv := httptest.NewServer(sink.handler())
	defer srv.Close()

	ch := NewSlackWebhookChannel(srv.URL, srv.Client())
	err := ch.Send(context.Background(), PushMessage{Kind: PushAlert, Severity: SevCritical, Title: "T", Body: "B"})
	if err == nil {
		t.Fatal("Send() = nil, want error for 404")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error %q does not carry the status", err)
	}
	if !strings.Contains(err.Error(), "no_team") {
		t.Errorf("error %q does not carry the body snippet", err)
	}
}

func TestSlackWebhookChannel_ContextTimeout(t *testing.T) {
	// Server hangs until the client gives up: Send must honor the context
	// deadline, not the sleep.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
		_, _ = fmt.Fprint(w, "ok")
	}))
	defer srv.Close()

	ch := NewSlackWebhookChannel(srv.URL, srv.Client())
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := ch.Send(ctx, PushMessage{Kind: PushCanary, Title: "Canary"})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("Send() = nil, want context deadline error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Send() = %v, want errors.Is(err, context.DeadlineExceeded)", err)
	}
	if elapsed > time.Second {
		t.Errorf("Send() took %v; the context deadline was not honored", elapsed)
	}
}

// --- Email channel ----------------------------------------------------------

// fakeEmailSender records what it was asked to send.
type fakeEmailSender struct {
	to, subject, body string
	calls             int
	err               error
}

func (f *fakeEmailSender) Send(_ context.Context, to, subject, body string) error {
	f.calls++
	f.to, f.subject, f.body = to, subject, body
	return f.err
}

func TestEmailChannel_Send(t *testing.T) {
	fake := &fakeEmailSender{}
	ch := NewEmailChannel(fake, "ops@postwave.dev")
	if got := ch.Name(); got != "email" {
		t.Errorf("Name() = %q, want %q", got, "email")
	}

	m := PushMessage{Kind: PushAlert, CheckID: "billing.dlq-depth", Severity: SevCritical,
		Title: "DLQ backing up", Body: "3 dead-lettered, oldest 7d ago"}
	if err := ch.Send(context.Background(), m); err != nil {
		t.Fatalf("Send() = %v, want nil", err)
	}

	if fake.calls != 1 {
		t.Fatalf("sender called %d times, want 1", fake.calls)
	}
	if fake.to != "ops@postwave.dev" {
		t.Errorf("to = %q, want ops@postwave.dev", fake.to)
	}
	if want := "[postwave-ops] 🔴 DLQ backing up"; fake.subject != want {
		t.Errorf("subject = %q, want %q", fake.subject, want)
	}
	if fake.body != m.Body {
		t.Errorf("body = %q, want %q (as-is)", fake.body, m.Body)
	}
}

func TestEmailChannel_SubjectEmojiFollowsKind(t *testing.T) {
	fake := &fakeEmailSender{}
	ch := NewEmailChannel(fake, "ops@postwave.dev")

	if err := ch.Send(context.Background(),
		PushMessage{Kind: PushDigest, Title: "Morning digest", Body: "all green"}); err != nil {
		t.Fatalf("Send() = %v", err)
	}
	if want := "[postwave-ops] 🗞️ Morning digest"; fake.subject != want {
		t.Errorf("subject = %q, want %q", fake.subject, want)
	}
}

func TestEmailChannel_PropagatesError(t *testing.T) {
	sentinel := errors.New("ses down")
	fake := &fakeEmailSender{err: sentinel}
	ch := NewEmailChannel(fake, "ops@postwave.dev")

	err := ch.Send(context.Background(), PushMessage{Kind: PushResolved, Title: "T", Body: "B"})
	if !errors.Is(err, sentinel) {
		t.Errorf("Send() = %v, want the sender's error", err)
	}
}
