// SPDX-License-Identifier: AGPL-3.0-only
package publictrack

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// fakeRecorder captures the last RecordSubscriberEvent call and returns a
// scripted result.
type fakeRecorder struct {
	gotTenant string
	gotIdent  string
	gotInput  subscribers.SubscriberEventInput
	calls     int
	out       *subscribers.SubscriberEvent
	err       error
}

func (f *fakeRecorder) RecordSubscriberEvent(_ context.Context, tenantID, subscriberID string, in subscribers.SubscriberEventInput) (*subscribers.SubscriberEvent, error) {
	f.calls++
	f.gotTenant = tenantID
	f.gotIdent = subscriberID
	f.gotInput = in
	return f.out, f.err
}

func staticResolver(tenant string, err error) func(context.Context, string) (string, error) {
	return func(context.Context, string) (string, error) { return tenant, err }
}

func doRequest(t *testing.T, d *Deps, host, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "http://"+host+"/api/public/track/event", strings.NewReader(body))
	req.Host = host
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PublicTrackEvent(rec, req)
	return rec
}

func TestNormalizeHost(t *testing.T) {
	valid := map[string]string{
		"Shop.Example.com":        "shop.example.com",
		" track.acme.io:8443 ":    "track.acme.io",
		"EVENTS.brand.com:443":    "events.brand.com",
		"events.brand.com.":       "events.brand.com",
		"xn--bcher-kva.example:1": "xn--bcher-kva.example",
	}
	for in, want := range valid {
		got, err := normalizeTrackingHost(in)
		if err != nil {
			t.Errorf("normalizeTrackingHost(%q) error = %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("normalizeTrackingHost(%q) = %q, want %q", in, got, want)
		}
	}

	invalid := []string{
		"",
		"   ",
		"shop.example.com, edge-proxy",
		"shop.example.com:abc",
		"shop.example.com:+80",
		"shop.example.com:",
		"shop.example.com:0",
		"shop.example.com:65536",
		"https://shop.example.com",
		"user@shop.example.com",
		"shop.example.com/path",
		"shop..example.com",
		"-shop.example.com",
		"shop-.example.com",
		"127.0.0.1",
		"[::1]:443",
		"bücher.example",
	}
	for _, in := range invalid {
		if got, err := normalizeTrackingHost(in); err == nil {
			t.Errorf("normalizeTrackingHost(%q) = %q, want rejection", in, got)
		}
	}
}

func TestTrackingHostFromRequest_TrustBoundary(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://internal-lb/api/public/track/event", nil)
	req.Host = "Origin.Example.com:443"
	req.Header.Set("X-Forwarded-Host", "victim.example.com, edge-proxy")

	host, err := trackingHostFromRequest(req, false)
	if err != nil {
		t.Fatalf("default host error = %v", err)
	}
	if host != "origin.example.com" {
		t.Fatalf("default host = %q, want origin.example.com", host)
	}

	req.Header.Set("X-Forwarded-Host", "Shop.Example.com:8443")
	host, err = trackingHostFromRequest(req, true)
	if err != nil {
		t.Fatalf("trusted forwarded host error = %v", err)
	}
	if host != "shop.example.com" {
		t.Fatalf("trusted forwarded host = %q, want shop.example.com", host)
	}

	req.Header.Set("X-Forwarded-Host", "shop.example.com, edge-proxy")
	if host, err = trackingHostFromRequest(req, true); err == nil {
		t.Fatalf("trusted forwarded list = %q, want rejection", host)
	}
	req.Header["X-Forwarded-Host"] = []string{"shop.example.com", "other.example.com"}
	if host, err = trackingHostFromRequest(req, true); err == nil {
		t.Fatalf("repeated trusted forwarded host = %q, want rejection", host)
	}
	req.Header.Del("X-Forwarded-Host")
	if host, err = trackingHostFromRequest(req, true); err == nil {
		t.Fatalf("missing trusted forwarded host = %q, want rejection", host)
	}
}

func TestPublicTrackEvent_ForwardedHostTrustBoundary(t *testing.T) {
	const body = `{"email":"buyer@example.com","event_name":"viewed"}`

	t.Run("spoofed header cannot override canonical Host by default", func(t *testing.T) {
		fr := &fakeRecorder{out: &subscribers.SubscriberEvent{ID: 1}}
		var resolvedHost string
		d := &Deps{
			Subs: fr,
			ResolveTenant: func(_ context.Context, host string) (string, error) {
				resolvedHost = host
				return "host-tenant", nil
			},
		}
		req := httptest.NewRequest(http.MethodPost, "http://edge.postwave.test/api/public/track/event", strings.NewReader(body))
		req.Host = "edge.postwave.test"
		req.Header.Set("X-Forwarded-Host", "victim.example.com")
		rec := httptest.NewRecorder()

		d.PublicTrackEvent(rec, req)

		if rec.Code != http.StatusAccepted {
			t.Fatalf("code = %d, want 202; body=%s", rec.Code, rec.Body.String())
		}
		if resolvedHost != "edge.postwave.test" {
			t.Fatalf("resolver host = %q, want canonical request Host", resolvedHost)
		}
		if fr.gotTenant != "host-tenant" {
			t.Fatalf("recorder tenant = %q, want host-tenant", fr.gotTenant)
		}
	})

	t.Run("explicit trusted edge can supply one forwarded host", func(t *testing.T) {
		fr := &fakeRecorder{out: &subscribers.SubscriberEvent{ID: 2}}
		var resolvedHost string
		d := &Deps{
			Subs: fr,
			ResolveTenant: func(_ context.Context, host string) (string, error) {
				resolvedHost = host
				return "forwarded-tenant", nil
			},
			TrustForwardedHost: true,
		}
		req := httptest.NewRequest(http.MethodPost, "http://internal-lb/api/public/track/event", strings.NewReader(body))
		req.Host = "internal-lb"
		req.Header.Set("X-Forwarded-Host", "Shop.Example.com:443")
		rec := httptest.NewRecorder()

		d.PublicTrackEvent(rec, req)

		if rec.Code != http.StatusAccepted {
			t.Fatalf("code = %d, want 202; body=%s", rec.Code, rec.Body.String())
		}
		if resolvedHost != "shop.example.com" {
			t.Fatalf("resolver host = %q, want trusted forwarded host", resolvedHost)
		}
		if fr.gotTenant != "forwarded-tenant" {
			t.Fatalf("recorder tenant = %q, want forwarded-tenant", fr.gotTenant)
		}
	})

	t.Run("trusted mode rejects chains before tenant resolution", func(t *testing.T) {
		fr := &fakeRecorder{out: &subscribers.SubscriberEvent{ID: 3}}
		resolveCalls := 0
		d := &Deps{
			Subs: fr,
			ResolveTenant: func(_ context.Context, _ string) (string, error) {
				resolveCalls++
				return "unexpected", nil
			},
			TrustForwardedHost: true,
		}
		req := httptest.NewRequest(http.MethodPost, "http://internal-lb/api/public/track/event", strings.NewReader(body))
		req.Host = "internal-lb"
		req.Header.Set("X-Forwarded-Host", "shop.example.com, edge-proxy")
		rec := httptest.NewRecorder()

		d.PublicTrackEvent(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400; body=%s", rec.Code, rec.Body.String())
		}
		if resolveCalls != 0 || fr.calls != 0 {
			t.Fatalf("invalid forwarded chain reached dependencies: resolve=%d record=%d", resolveCalls, fr.calls)
		}
	})

	t.Run("default mode rejects malformed canonical Host before tenant resolution", func(t *testing.T) {
		fr := &fakeRecorder{out: &subscribers.SubscriberEvent{ID: 4}}
		resolveCalls := 0
		d := &Deps{
			Subs: fr,
			ResolveTenant: func(_ context.Context, _ string) (string, error) {
				resolveCalls++
				return "unexpected", nil
			},
		}
		req := httptest.NewRequest(http.MethodPost, "http://edge.postwave.test/api/public/track/event", strings.NewReader(body))
		req.Host = "edge.postwave.test, victim.example.com"
		req.Header.Set("X-Forwarded-Host", "valid-but-untrusted.example.com")
		rec := httptest.NewRecorder()

		d.PublicTrackEvent(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400; body=%s", rec.Code, rec.Body.String())
		}
		if resolveCalls != 0 || fr.calls != 0 {
			t.Fatalf("invalid canonical Host reached dependencies: resolve=%d record=%d", resolveCalls, fr.calls)
		}
	})
}

func TestPublicTrackEvent_TrackerUnavailable(t *testing.T) {
	d := &Deps{ResolveTenant: staticResolver("t1", nil)} // Subs nil
	rec := doRequest(t, d, "shop.example.com", `{"email":"a@b.com","event_name":"viewed"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", rec.Code)
	}
}

func TestPublicTrackEvent_UnknownHost(t *testing.T) {
	fr := &fakeRecorder{}
	d := &Deps{Subs: fr, ResolveTenant: staticResolver("", errUnknownHost)}
	rec := doRequest(t, d, "evil.example.com", `{"email":"a@b.com","event_name":"viewed"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
	if fr.calls != 0 {
		t.Fatalf("recorder called %d times on unknown host, want 0", fr.calls)
	}
}

func TestPublicTrackEvent_MissingEmail(t *testing.T) {
	fr := &fakeRecorder{}
	d := &Deps{Subs: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doRequest(t, d, "shop.example.com", `{"event_name":"viewed"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
	if fr.calls != 0 {
		t.Fatalf("recorder called without an email, want 0 calls")
	}
}

func TestPublicTrackEvent_Records(t *testing.T) {
	fr := &fakeRecorder{out: &subscribers.SubscriberEvent{ID: 42, Deduped: false}}
	d := &Deps{Subs: fr, ResolveTenant: staticResolver("tenant-123", nil)}
	rec := doRequest(t, d, "shop.example.com",
		`{"email":"buyer@b.com","event_name":"product_viewed","event_type":"custom","source_event_id":"evt-1","external_id":"ext-9","properties":{"sku":"ABC"}}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	if fr.gotTenant != "tenant-123" {
		t.Errorf("tenant = %q, want tenant-123", fr.gotTenant)
	}
	if fr.gotIdent != "buyer@b.com" {
		t.Errorf("identifier = %q, want buyer@b.com", fr.gotIdent)
	}
	if fr.gotInput.Source != trackSource {
		t.Errorf("source = %q, want %q", fr.gotInput.Source, trackSource)
	}
	if fr.gotInput.SourceEventID != "evt-1" {
		t.Errorf("source_event_id = %q, want evt-1", fr.gotInput.SourceEventID)
	}
	if fr.gotInput.Metadata["external_id"] != "ext-9" {
		t.Errorf("external_id not folded into metadata: %+v", fr.gotInput.Metadata)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["recorded"] != true {
		t.Errorf("recorded = %v, want true", resp["recorded"])
	}
}

func TestPublicTrackEvent_UnknownSubscriber(t *testing.T) {
	fr := &fakeRecorder{err: subscribers.ErrNotFound}
	d := &Deps{Subs: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doRequest(t, d, "shop.example.com", `{"email":"ghost@b.com","event_name":"viewed"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202 (accept-and-ignore)", rec.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["recorded"] != false {
		t.Errorf("recorded = %v, want false for unknown subscriber", resp["recorded"])
	}
}

func TestPublicTrackEvent_Dedup(t *testing.T) {
	fr := &fakeRecorder{out: &subscribers.SubscriberEvent{ID: 7, Deduped: true}}
	d := &Deps{Subs: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doRequest(t, d, "shop.example.com", `{"email":"a@b.com","event_name":"viewed","source_event_id":"dup-1"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202", rec.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["deduped"] != true {
		t.Errorf("deduped = %v, want true", resp["deduped"])
	}
}

func TestPublicTrackEvent_InvalidInput(t *testing.T) {
	fr := &fakeRecorder{err: subscribers.ErrInvalidInput}
	d := &Deps{Subs: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doRequest(t, d, "shop.example.com", `{"email":"a@b.com","event_type":"custom"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422", rec.Code)
	}
}

func TestPublicTrackEvent_BadJSON(t *testing.T) {
	fr := &fakeRecorder{}
	d := &Deps{Subs: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doRequest(t, d, "shop.example.com", `{not json`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}
