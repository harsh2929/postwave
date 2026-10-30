// SPDX-License-Identifier: AGPL-3.0-only
package publictrack

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// fakeAnonRecorder captures the last RecordAnonymousEvent call and returns a
// scripted result, mirroring fakeRecorder in publictrack_test.go.
type fakeAnonRecorder struct {
	gotTenant string
	gotInput  AnonymousEventInput
	calls     int
	out       *AnonymousEvent
	err       error
}

func (f *fakeAnonRecorder) RecordAnonymousEvent(_ context.Context, tenantID string, in AnonymousEventInput) (*AnonymousEvent, error) {
	f.calls++
	f.gotTenant = tenantID
	f.gotInput = in
	if f.err != nil {
		return nil, f.err
	}
	if f.out != nil {
		return f.out, nil
	}
	return &AnonymousEvent{ID: 1, AnonymousID: in.AnonymousID, EventType: in.EventType, OccurredAt: time.Now()}, nil
}

func doAnonRequest(t *testing.T, d *AnonDeps, host, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "http://"+host+"/api/public/track/anonymous", strings.NewReader(body))
	req.Host = host
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PublicTrackAnonymousEvent(rec, req)
	return rec
}

func TestPublicTrackAnonymousEvent_TrackerUnavailable(t *testing.T) {
	d := &AnonDeps{ResolveTenant: staticResolver("t1", nil)} // Recorder nil
	rec := doAnonRequest(t, d, "shop.example.com", `{"anonymous_id":"anon-1","event_name":"viewed"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", rec.Code)
	}
}

// TestPublicTrackAnonymousEvent_HostResolution confirms that the anonymous
// handler resolves only a validated canonical authority: unknown hosts stop
// before recording, and the resolved tenant id reaches the recorder intact.
func TestPublicTrackAnonymousEvent_HostResolution(t *testing.T) {
	t.Run("unknown host rejected before recording", func(t *testing.T) {
		fr := &fakeAnonRecorder{}
		d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("", errUnknownHost)}
		rec := doAnonRequest(t, d, "evil.example.com", `{"anonymous_id":"anon-1"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("code = %d, want 401", rec.Code)
		}
		if fr.calls != 0 {
			t.Fatalf("recorder called %d times on unknown host, want 0", fr.calls)
		}
	})

	t.Run("known host resolves tenant into recorder call", func(t *testing.T) {
		fr := &fakeAnonRecorder{}
		d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("tenant-abc", nil)}
		rec := doAnonRequest(t, d, "Shop.Example.com:8443", `{"anonymous_id":"anon-1","event_name":"viewed"}`)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("code = %d, want 202; body=%s", rec.Code, rec.Body.String())
		}
		if fr.gotTenant != "tenant-abc" {
			t.Errorf("tenant = %q, want tenant-abc", fr.gotTenant)
		}
	})

	t.Run("spoofed forwarded host is ignored by default", func(t *testing.T) {
		fr := &fakeAnonRecorder{}
		d := &AnonDeps{Recorder: fr, ResolveTenant: func(_ context.Context, host string) (string, error) {
			if host != "edge.moosewave.test" {
				t.Fatalf("resolver saw host %q, want canonical request Host", host)
			}
			return "tenant-origin", nil
		}}
		req := httptest.NewRequest(http.MethodPost, "http://edge.postwave.test/api/public/track/anonymous",
			strings.NewReader(`{"anonymous_id":"anon-1"}`))
		req.Host = "Edge.Moosewave.Test:443"
		req.Header.Set("X-Forwarded-Host", "victim.example.com, edge-proxy")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		d.PublicTrackAnonymousEvent(rec, req)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("code = %d, want 202; body=%s", rec.Code, rec.Body.String())
		}
		if fr.gotTenant != "tenant-origin" {
			t.Fatalf("recorder tenant = %q, want tenant-origin", fr.gotTenant)
		}
	})

	t.Run("trusted edge accepts one canonical forwarded host", func(t *testing.T) {
		fr := &fakeAnonRecorder{}
		d := &AnonDeps{
			Recorder: fr,
			ResolveTenant: func(_ context.Context, host string) (string, error) {
				if host != "shop.example.com" {
					t.Fatalf("resolver saw host %q, want canonical forwarded host", host)
				}
				return "tenant-forwarded", nil
			},
			TrustForwardedHost: true,
		}
		req := httptest.NewRequest(http.MethodPost, "http://internal-lb/api/public/track/anonymous",
			strings.NewReader(`{"anonymous_id":"anon-1"}`))
		req.Host = "internal-lb"
		req.Header.Set("X-Forwarded-Host", "Shop.Example.com:8443")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		d.PublicTrackAnonymousEvent(rec, req)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("code = %d, want 202; body=%s", rec.Code, rec.Body.String())
		}
		if fr.gotTenant != "tenant-forwarded" {
			t.Fatalf("recorder tenant = %q, want tenant-forwarded", fr.gotTenant)
		}
	})
}

func TestPublicTrackAnonymousEvent_InvalidAuthorityStopsBeforeDependencies(t *testing.T) {
	const body = `{"anonymous_id":"anon-1"}`
	tests := []struct {
		name                string
		trustForwardedHost  bool
		host                string
		forwardedHostValues []string
		wantMessage         string
	}{
		{
			name:                "default mode requires canonical Host even when a forwarded value exists",
			host:                "",
			forwardedHostValues: []string{"shop.example.com"},
			wantMessage:         "missing host",
		},
		{
			name:                "default mode rejects a chained canonical Host",
			host:                "edge.postwave.test, victim.example.com",
			forwardedHostValues: []string{"valid-but-untrusted.example.com"},
			wantMessage:         "invalid host",
		},
		{
			name:        "default mode rejects a malformed canonical Host",
			host:        "shop.example.com:abc",
			wantMessage: "invalid host",
		},
		{
			name:               "trusted mode requires a forwarded Host",
			trustForwardedHost: true,
			host:               "internal-lb",
			wantMessage:        "missing host",
		},
		{
			name:                "trusted mode rejects a forwarded chain",
			trustForwardedHost:  true,
			host:                "internal-lb",
			forwardedHostValues: []string{"shop.example.com, edge-proxy"},
			wantMessage:         "invalid host",
		},
		{
			name:                "trusted mode rejects repeated forwarded headers",
			trustForwardedHost:  true,
			host:                "internal-lb",
			forwardedHostValues: []string{"shop.example.com", "other.example.com"},
			wantMessage:         "invalid host",
		},
		{
			name:                "trusted mode rejects a malformed forwarded Host",
			trustForwardedHost:  true,
			host:                "internal-lb",
			forwardedHostValues: []string{"https://shop.example.com"},
			wantMessage:         "invalid host",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fr := &fakeAnonRecorder{}
			resolveCalls := 0
			d := &AnonDeps{
				Recorder: fr,
				ResolveTenant: func(_ context.Context, _ string) (string, error) {
					resolveCalls++
					return "unexpected", nil
				},
				TrustForwardedHost: tt.trustForwardedHost,
			}
			req := httptest.NewRequest(http.MethodPost, "http://request.invalid/api/public/track/anonymous",
				strings.NewReader(body))
			req.Host = tt.host
			if len(tt.forwardedHostValues) > 0 {
				req.Header["X-Forwarded-Host"] = tt.forwardedHostValues
			}
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			d.PublicTrackAnonymousEvent(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tt.wantMessage) {
				t.Fatalf("body = %q, want public message %q", rec.Body.String(), tt.wantMessage)
			}
			if resolveCalls != 0 || fr.calls != 0 {
				t.Fatalf("invalid authority reached dependencies: resolve=%d record=%d", resolveCalls, fr.calls)
			}
		})
	}
}

func TestPublicTrackAnonymousEvent_MissingAnonymousID(t *testing.T) {
	fr := &fakeAnonRecorder{}
	d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doAnonRequest(t, d, "shop.example.com", `{"event_name":"viewed"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
	if fr.calls != 0 {
		t.Fatalf("recorder called without anonymous_id, want 0 calls")
	}
	var resp struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Error.Code != "missing_anonymous_id" {
		t.Errorf("error.code = %q, want missing_anonymous_id", resp.Error.Code)
	}
}

func TestPublicTrackAnonymousEvent_BlankAnonymousIDRejected(t *testing.T) {
	fr := &fakeAnonRecorder{}
	d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doAnonRequest(t, d, "shop.example.com", `{"anonymous_id":"   ","event_name":"viewed"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400 for whitespace-only anonymous_id", rec.Code)
	}
	if fr.calls != 0 {
		t.Fatalf("recorder called with blank anonymous_id, want 0 calls")
	}
}

func TestPublicTrackAnonymousEvent_InsertPath(t *testing.T) {
	fr := &fakeAnonRecorder{out: &AnonymousEvent{ID: 42, AnonymousID: "anon-42", EventType: "custom", Deduped: false}}
	d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("tenant-123", nil)}
	rec := doAnonRequest(t, d, "shop.example.com",
		`{"anonymous_id":"anon-42","event_name":"product_viewed","event_type":"custom","source_event_id":"evt-1","properties":{"sku":"ABC"}}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	if fr.calls != 1 {
		t.Fatalf("recorder called %d times, want 1", fr.calls)
	}
	if fr.gotTenant != "tenant-123" {
		t.Errorf("tenant = %q, want tenant-123", fr.gotTenant)
	}
	if fr.gotInput.AnonymousID != "anon-42" {
		t.Errorf("anonymous_id = %q, want anon-42", fr.gotInput.AnonymousID)
	}
	if fr.gotInput.SourceEventID != "evt-1" {
		t.Errorf("source_event_id = %q, want evt-1", fr.gotInput.SourceEventID)
	}
	if fr.gotInput.Properties["sku"] != "ABC" {
		t.Errorf("properties not threaded through: %+v", fr.gotInput.Properties)
	}

	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["accepted"] != true {
		t.Errorf("accepted = %v, want true", resp["accepted"])
	}
	// Must NEVER create/reference a subscriber: no email or subscriber
	// field should ever appear in the accepted-event input or response.
	if _, ok := resp["email"]; ok {
		t.Errorf("response unexpectedly carries an email field: %+v", resp)
	}
}

func TestPublicTrackAnonymousEvent_Dedup(t *testing.T) {
	fr := &fakeAnonRecorder{out: &AnonymousEvent{ID: 7, AnonymousID: "anon-7", Deduped: true}}
	d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doAnonRequest(t, d, "shop.example.com", `{"anonymous_id":"anon-7","source_event_id":"dup-1"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202", rec.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["deduped"] != true {
		t.Errorf("deduped = %v, want true", resp["deduped"])
	}
}

func TestPublicTrackAnonymousEvent_RecorderError(t *testing.T) {
	fr := &fakeAnonRecorder{err: context.DeadlineExceeded}
	d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doAnonRequest(t, d, "shop.example.com", `{"anonymous_id":"anon-1"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500", rec.Code)
	}
}

func TestPublicTrackAnonymousEvent_BadJSON(t *testing.T) {
	fr := &fakeAnonRecorder{}
	d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("t1", nil)}
	rec := doAnonRequest(t, d, "shop.example.com", `{not json`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
	if fr.calls != 0 {
		t.Fatalf("recorder called on bad JSON, want 0 calls")
	}
}

func TestPublicTrackAnonymousEvent_AnonymousIDTooLong(t *testing.T) {
	fr := &fakeAnonRecorder{}
	d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("t1", nil)}
	longID := strings.Repeat("a", 513)
	rec := doAnonRequest(t, d, "shop.example.com", `{"anonymous_id":"`+longID+`"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422", rec.Code)
	}
	if fr.calls != 0 {
		t.Fatalf("recorder called with oversized anonymous_id, want 0 calls")
	}
}

func TestMountPublicTrackAnonymousRoutes_RegistersRoute(t *testing.T) {
	fr := &fakeAnonRecorder{}
	d := &AnonDeps{Recorder: fr, ResolveTenant: staticResolver("t1", nil)}
	r := chi.NewRouter()
	MountPublicTrackAnonymousRoutes(r, d)

	req := httptest.NewRequest(http.MethodPost, "http://shop.example.com/api/public/track/anonymous",
		strings.NewReader(`{"anonymous_id":"anon-1"}`))
	req.Host = "shop.example.com"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("routed code = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	if fr.calls != 1 {
		t.Fatalf("recorder called %d times via routed request, want 1", fr.calls)
	}
}
