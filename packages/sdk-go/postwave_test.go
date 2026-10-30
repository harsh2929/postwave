package postwave

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestEmailsSend(t *testing.T) {
	var gotAuth, gotIdem, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotIdem = r.Header.Get("Idempotency-Key")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(202)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "em_1", "status": "sent"})
	}))
	defer srv.Close()

	c := New("pw_test", WithBaseURL(srv.URL))
	res, err := c.Emails.Send(context.Background(), &SendEmailInput{
		From: "a@b.com", To: []string{"c@d.com"}, Subject: "Hi", HTML: "<b>x</b>",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != "em_1" || res.Status != "sent" {
		t.Fatalf("result: %+v", res)
	}
	if gotAuth != "Bearer pw_test" {
		t.Errorf("auth: %q", gotAuth)
	}
	if gotIdem == "" {
		t.Error("expected an Idempotency-Key on POST")
	}
	if gotBody == "" || gotBody[0] != '{' {
		t.Errorf("body: %q", gotBody)
	}
}

func TestErrorMapping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": "invalid_request", "message": "bad", "request_id": "req_1"}})
	}))
	defer srv.Close()
	c := New("pw_test", WithBaseURL(srv.URL), WithMaxRetries(0))
	_, err := c.Emails.Send(context.Background(), &SendEmailInput{To: []string{"x@y.com"}, Subject: "s", Text: "t"})
	apiErr, ok := err.(*Error)
	if !ok || apiErr.Status != 422 || apiErr.Code != "invalid_request" || apiErr.RequestID != "req_1" {
		t.Fatalf("error mapping: %v", err)
	}
}

func TestVerifyWebhook(t *testing.T) {
	secret, body := "owhsec_x", []byte(`{"event":"email.delivered"}`)
	now := time.Unix(1784764800, 0)
	sig := ComputeWebhookSignatureHeader(secret, now.Unix(), body)
	if !VerifyWebhookAt(sig, secret, body, now, 5*time.Minute) {
		t.Fatal("valid signature rejected")
	}
	if VerifyWebhookAt(sig, "wrong", body, now, 5*time.Minute) {
		t.Fatal("wrong secret accepted")
	}
	if VerifyWebhookAt("garbage", secret, body, now, 5*time.Minute) {
		t.Fatal("malformed header accepted")
	}
	if VerifyWebhookAt(sig, secret, body, now.Add(301*time.Second), 5*time.Minute) {
		t.Fatal("stale signature accepted")
	}
	rotating := "t=" + strconv.FormatInt(now.Unix(), 10) +
		",v1=" + strings.Repeat("0", 64) +
		",v1=" + ComputeWebhookSignature(secret, now.Unix(), body)
	if !VerifyWebhookAt(rotating, secret, body, now, 5*time.Minute) {
		t.Fatal("valid overlapping rotation signature rejected")
	}
	if VerifyWebhookAt(sig+",t="+strconv.FormatInt(now.Unix(), 10), secret, body, now, 5*time.Minute) {
		t.Fatal("ambiguous duplicate timestamp accepted")
	}
}
