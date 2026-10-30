// SPDX-License-Identifier: AGPL-3.0-only
//
// broadcasts_test.go — DB-free tests for the SMS broadcast surface:
// upsert normalization/validation, audience exclusivity, the env-capped
// audience size, and handler-level validation (tenant guard, decode
// errors, provider guard) that fails before any store/DB access.
// DB-backed coverage (audience resolution, send idempotency, quiet-hours
// held counting) lives in broadcasts_db_test.go.

package sms

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func str(s string) *string { return &s }

func asBroadcastErr(t *testing.T, err error) *BroadcastError {
	t.Helper()
	var be *BroadcastError
	if !errors.As(err, &be) {
		t.Fatalf("expected *BroadcastError, got %T: %v", err, err)
	}
	return be
}

func TestNormalizeBroadcastUpsertValidation(t *testing.T) {
	t.Run("rejects non-uuid sender", func(t *testing.T) {
		in := BroadcastUpsert{SenderProfileID: str("not-a-uuid")}
		be := asBroadcastErr(t, normalizeBroadcastUpsert(&in))
		if be.Code != "invalid_sender" || be.Status != http.StatusUnprocessableEntity {
			t.Fatalf("got code=%q status=%d, want invalid_sender/422", be.Code, be.Status)
		}
	})
	t.Run("rejects non-uuid segment", func(t *testing.T) {
		in := BroadcastUpsert{SegmentID: str("nope")}
		be := asBroadcastErr(t, normalizeBroadcastUpsert(&in))
		if be.Code != "invalid_audience" {
			t.Fatalf("got code=%q, want invalid_audience", be.Code)
		}
	})
	t.Run("rejects non-uuid list ids", func(t *testing.T) {
		lists := []string{"11111111-1111-4111-8111-111111111111", "bogus"}
		in := BroadcastUpsert{ListIDs: &lists}
		be := asBroadcastErr(t, normalizeBroadcastUpsert(&in))
		if be.Code != "invalid_audience" {
			t.Fatalf("got code=%q, want invalid_audience", be.Code)
		}
	})
	t.Run("rejects empty list ids instead of silently changing audience", func(t *testing.T) {
		lists := []string{"11111111-1111-4111-8111-111111111111", ""}
		in := BroadcastUpsert{ListIDs: &lists, Name: str("  hi  "), Tag: str(" vip ")}
		be := asBroadcastErr(t, normalizeBroadcastUpsert(&in))
		if be.Code != "invalid_audience" {
			t.Fatalf("got code=%q, want invalid_audience", be.Code)
		}
	})
	t.Run("rejects body over 10 segments", func(t *testing.T) {
		in := BroadcastUpsert{Body: str(strings.Repeat("a", 160*11))}
		be := asBroadcastErr(t, normalizeBroadcastUpsert(&in))
		if be.Code != "too_many_segments" {
			t.Fatalf("got code=%q, want too_many_segments", be.Code)
		}
	})
}

func TestValidateBroadcastAudienceExclusive(t *testing.T) {
	seg := "11111111-1111-1111-1111-111111111111"
	list := "22222222-2222-2222-2222-222222222222"
	cases := []struct {
		name string
		b    Broadcast
		ok   bool
	}{
		{"none is fine (drafts)", Broadcast{}, true},
		{"list only", Broadcast{ListIDs: []string{list}}, true},
		{"segment only", Broadcast{SegmentID: seg}, true},
		{"tag only", Broadcast{Tag: "vip"}, true},
		{"list+segment", Broadcast{ListIDs: []string{list}, SegmentID: seg}, false},
		{"segment+tag", Broadcast{SegmentID: seg, Tag: "vip"}, false},
		{"all three", Broadcast{ListIDs: []string{list}, SegmentID: seg, Tag: "vip"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateBroadcastAudience(tc.b)
			if tc.ok && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.ok {
				be := asBroadcastErr(t, err)
				if be.Code != "invalid_audience" {
					t.Fatalf("got code=%q, want invalid_audience", be.Code)
				}
			}
		})
	}
}

func TestBroadcastMaxRecipientsEnv(t *testing.T) {
	t.Setenv(EnvBroadcastMaxRecipients, "")
	if got := BroadcastMaxRecipients(); got != DefaultBroadcastMaxRecipients {
		t.Fatalf("default cap = %d, want %d", got, DefaultBroadcastMaxRecipients)
	}
	t.Setenv(EnvBroadcastMaxRecipients, "250")
	if got := BroadcastMaxRecipients(); got != 250 {
		t.Fatalf("cap = %d, want 250", got)
	}
	for _, bad := range []string{"0", "-5", "many"} {
		t.Setenv(EnvBroadcastMaxRecipients, bad)
		if got := BroadcastMaxRecipients(); got != DefaultBroadcastMaxRecipients {
			t.Fatalf("cap(%q) = %d, want default %d", bad, got, DefaultBroadcastMaxRecipients)
		}
	}
}

func TestErrAudienceTooLargeShape(t *testing.T) {
	be := ErrAudienceTooLarge(123)
	if be.Code != "audience_too_large" || be.Status != http.StatusUnprocessableEntity {
		t.Fatalf("got code=%q status=%d", be.Code, be.Status)
	}
	if !strings.Contains(be.Message, "123") || !strings.Contains(be.Message, EnvBroadcastMaxRecipients) {
		t.Fatalf("message should name the cap and the env knob: %q", be.Message)
	}
}

func TestBroadcastJSONExposesSegmentEstimate(t *testing.T) {
	b := Broadcast{Body: strings.Repeat("a", 161)}
	b.SegmentsPerMessage = SegmentCount(b.Body)
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got, ok := out["segments_per_message"].(float64); !ok || got != 2 {
		t.Fatalf("segments_per_message = %v, want 2", out["segments_per_message"])
	}
	for _, key := range []string{"status", "sent_count", "failed_count", "held_count", "list_ids"} {
		if _, ok := out[key]; !ok {
			t.Fatalf("broadcast JSON missing %q: %s", key, raw)
		}
	}
}

func TestBroadcastProgressJSONShape(t *testing.T) {
	raw, err := json.Marshal(BroadcastProgress{Status: "sending", Sent: 1, Failed: 2, Held: 3, Total: 6})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"status":"sending","sent":1,"failed":2,"held":3,"total":6}`
	if strings.TrimSpace(string(raw)) != want {
		t.Fatalf("progress JSON = %s, want %s", raw, want)
	}
}

// --- handler validation (fails before any store/DB access) ---

func broadcastTestRequest(method, target, body string, withTenant bool) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	if withTenant {
		tenant := &middleware.Tenant{ID: "33333333-3333-3333-3333-333333333333", Slug: "t"}
		r = r.WithContext(middleware.WithTenant(r.Context(), tenant))
	}
	return r
}

func TestBroadcastHandlersRequireTenant(t *testing.T) {
	d := &Deps{}
	handlers := map[string]http.HandlerFunc{
		"list":     d.ListBroadcasts,
		"create":   d.CreateBroadcast,
		"get":      d.GetBroadcast,
		"update":   d.UpdateBroadcast,
		"delete":   d.DeleteBroadcast,
		"send":     d.SendBroadcast,
		"cancel":   d.CancelBroadcast,
		"progress": d.BroadcastProgress,
	}
	for name, h := range handlers {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			h(w, broadcastTestRequest(http.MethodPost, "/api/v1/sms/broadcasts", "", false))
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", w.Code)
			}
			if !strings.Contains(w.Body.String(), "no_tenant") {
				t.Fatalf("body = %s, want no_tenant envelope", w.Body.String())
			}
		})
	}
}

func TestCreateBroadcastRejectsMalformedJSON(t *testing.T) {
	d := &Deps{}
	w := httptest.NewRecorder()
	d.CreateBroadcast(w, broadcastTestRequest(http.MethodPost, "/api/v1/sms/broadcasts", "{not json", true))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestUpdateBroadcastRejectsMalformedJSON(t *testing.T) {
	d := &Deps{}
	w := httptest.NewRecorder()
	d.UpdateBroadcast(w, broadcastTestRequest(http.MethodPatch, "/api/v1/sms/broadcasts/x", `{"name": 7}`, true))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestSendBroadcastRequiresProvider(t *testing.T) {
	d := &Deps{} // Provider nil → 503 before any store access.
	w := httptest.NewRecorder()
	d.SendBroadcast(w, broadcastTestRequest(http.MethodPost, "/api/v1/sms/broadcasts/x/send", "", true))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	wantCode := "sms_provider_unconfigured"
	if !smsDispatchSagaReleaseReady {
		wantCode = "sms_broadcast_dispatch_release_held"
	}
	if !strings.Contains(w.Body.String(), wantCode) {
		t.Fatalf("body = %s, want %s", w.Body.String(), wantCode)
	}
}

func TestSafeSendScheduledBroadcastRecoversPanic(t *testing.T) {
	w := &Worker{Store: &Store{SMSWorkerIdentityAvailable: true}} // nil pool → panic inside sendBroadcast
	deps := &Deps{Store: w.Store}
	_, err := w.safeSendScheduledBroadcast(t.Context(), deps,
		broadcastRef{ID: "44444444-4444-4444-4444-444444444444", TenantID: "55555555-5555-5555-5555-555555555555"})
	if !smsDispatchSagaReleaseReady {
		be := asBroadcastErr(t, err)
		if be.Code != "sms_broadcast_dispatch_release_held" || be.Status != http.StatusServiceUnavailable {
			t.Fatalf("release hold error = %#v", be)
		}
		return
	}
	if err == nil || !strings.Contains(err.Error(), "panic") {
		t.Fatalf("expected recovered panic error, got %v", err)
	}
}
