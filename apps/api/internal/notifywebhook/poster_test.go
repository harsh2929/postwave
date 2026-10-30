// SPDX-License-Identifier: AGPL-3.0-only
package notifywebhook

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// captureRT records the outbound request and returns a canned response without
// touching the network. It lets us assert the exact wire payload the poster
// produces for a URL that PASSES ValidateURL (public hostname).
type captureRT struct {
	req  *http.Request
	body []byte
	resp *http.Response
	err  error
}

func (c *captureRT) RoundTrip(r *http.Request) (*http.Response, error) {
	c.req = r
	if r.Body != nil {
		c.body, _ = io.ReadAll(r.Body)
	}
	if c.err != nil {
		return nil, c.err
	}
	resp := c.resp
	if resp == nil {
		resp = &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(nil)), Header: make(http.Header)}
	}
	return resp, nil
}

func TestPost_SlackTextPayload(t *testing.T) {
	rt := &captureRT{}
	p := &Poster{Client: &http.Client{Transport: rt}}
	if err := p.Post(context.Background(), "https://hooks.example.com/services/x", "slack", "Bounce\nhigh bounce rate\n/app/x", "subscriber.bounced"); err != nil {
		t.Fatalf("Post: %v", err)
	}
	if rt.req == nil {
		t.Fatal("no request was sent")
	}
	if rt.req.Method != http.MethodPost {
		t.Fatalf("method = %s, want POST", rt.req.Method)
	}
	if ct := rt.req.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	var payload map[string]any
	if err := json.Unmarshal(rt.body, &payload); err != nil {
		t.Fatalf("body is not JSON (%v): %s", err, rt.body)
	}
	// Slack payload is exactly {text} — the event field is generic-only.
	if len(payload) != 1 {
		t.Fatalf("slack payload must contain only {text}, got %v", payload)
	}
	if got := payload["text"]; got != "Bounce\nhigh bounce rate\n/app/x" {
		t.Fatalf("text = %q, want the content-light line", got)
	}
}

func TestPost_GenericPayloadAddsEvent(t *testing.T) {
	rt := &captureRT{}
	p := &Poster{Client: &http.Client{Transport: rt}}
	if err := p.Post(context.Background(), "https://hooks.example.com/x", "generic", "Bounce", "subscriber.bounced"); err != nil {
		t.Fatalf("Post: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(rt.body, &payload); err != nil {
		t.Fatalf("body is not JSON (%v): %s", err, rt.body)
	}
	if payload["text"] != "Bounce" || payload["event"] != "subscriber.bounced" {
		t.Fatalf("generic payload must carry text + event, got %v", payload)
	}
}

func TestPost_Non2xxIsError(t *testing.T) {
	rt := &captureRT{resp: &http.Response{StatusCode: 404, Body: io.NopCloser(bytes.NewReader([]byte("no such hook"))), Header: make(http.Header)}}
	p := &Poster{Client: &http.Client{Transport: rt}}
	if err := p.Post(context.Background(), "https://hooks.example.com/x", "slack", "hi", ""); err == nil {
		t.Fatal("a 404 response must surface as an error")
	}
}

// The poster re-validates at delivery time; a literal private/reserved/localhost
// destination must be refused BEFORE any request leaves the process (defense in
// depth against a URL that slipped past save-time validation or a rebind).
func TestPost_RejectsSSRFDestinations(t *testing.T) {
	cases := []string{
		"https://127.0.0.1/x",                      // loopback
		"https://10.0.0.5/x",                       // private
		"https://169.254.169.254/latest/meta-data", // cloud metadata
		"http://localhost/x",                       // localhost + non-TLS
		"https://[::1]/x",                          // IPv6 loopback
	}
	for _, url := range cases {
		rt := &captureRT{}
		p := &Poster{Client: &http.Client{Transport: rt}}
		if err := p.Post(context.Background(), url, "slack", "hi", ""); err == nil {
			t.Fatalf("%s: expected rejection, got nil", url)
		}
		if rt.req != nil {
			t.Fatalf("%s: a request was sent despite validation failure", url)
		}
	}
}

func TestPost_EmptyURLAndNilPosterNoOp(t *testing.T) {
	rt := &captureRT{}
	p := &Poster{Client: &http.Client{Transport: rt}}
	if err := p.Post(context.Background(), "   ", "slack", "hi", ""); err != nil {
		t.Fatalf("empty URL must no-op, got %v", err)
	}
	if rt.req != nil {
		t.Fatal("empty URL must not send a request")
	}
	var nilPoster *Poster
	if err := nilPoster.Post(context.Background(), "https://hooks.example.com/x", "slack", "hi", ""); err != nil {
		t.Fatalf("nil poster must no-op, got %v", err)
	}
}

func TestNew_UsesSecureClient(t *testing.T) {
	p := New()
	if p == nil || p.Client == nil {
		t.Fatal("New must return a poster with a client")
	}
	if p.Client.CheckRedirect == nil {
		t.Fatal("secure client must refuse redirects")
	}
	// Sanity: a real secure client still rejects a literal private destination.
	if err := p.Post(context.Background(), "https://192.168.1.1/x", "slack", strings.Repeat("a", 4), ""); err == nil {
		t.Fatal("secure poster must reject a private destination")
	}
}
