package subscribers

// Tests for the SUB-056 portable consent receipt export. The DB-backed
// handlers are covered by the no-tenant 401 short-circuit (mirroring the
// data-export test pattern); the pure-Go buildConsentReceipt assembler and the
// zip wrapper are tested directly so the ISO 27560 / Kantara CR v1.1
// schema-compliance + consent-state-mapping contract is locked.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestConsentReceiptJSON_NoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscribers/abc/consent-receipt.json", nil)
	w := httptest.NewRecorder()
	d.ConsentReceiptJSON(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
	if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestConsentReceiptZIP_NoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscribers/abc/consent-receipt.zip", nil)
	w := httptest.NewRecorder()
	d.ConsentReceiptZIP(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
	if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestConsentReceiptExportsAreAuthFirstReleaseHeld(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, test := range []struct {
		name string
		path string
		call func(http.ResponseWriter, *http.Request)
	}{
		{name: "json", path: "/api/v1/subscribers/abc/consent-receipt.json", call: d.ConsentReceiptJSON},
		{name: "zip", path: "/api/v1/subscribers/abc/consent-receipt.zip", call: d.ConsentReceiptZIP},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", test.path, nil)
			r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "tenant-test"}))
			w := httptest.NewRecorder()
			test.call(w, r)
			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), "consent_receipt_export_unavailable") {
				t.Fatalf("body = %s", w.Body.String())
			}
			if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q", got)
			}
			vary := strings.ToLower(strings.Join(w.Header().Values("Vary"), ","))
			if !strings.Contains(vary, "authorization") || !strings.Contains(vary, "cookie") {
				t.Fatalf("Vary = %q", vary)
			}
		})
	}
}

// TestBuildConsentReceipt_ISO27560Shape locks the top-level schema fields and
// the consent-state mapping: each of the five vector columns maps to one
// service entry whose Active flag mirrors whether the column is granted.
func TestBuildConsentReceipt_ISO27560Shape(t *testing.T) {
	emailGrant := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	aiGrant := time.Date(2026, 2, 2, 3, 4, 5, 0, time.UTC)
	sub := &Subscriber{
		ID:                      "11111111-1111-1111-1111-111111111111",
		ProfileID:               "prof_abc",
		Email:                   "Alice@Example.com",
		ConsentEmailMarketingAt: &emailGrant,
		ConsentAIProcessingAt:   &aiGrant,
		// sms / profiling / targeted_ads left nil → not active.
	}
	org := consentReceiptOrgContext{
		ControllerName:    "Acme Corp",
		ControllerContact: "dpo@acme.example",
		PrivacyPolicyURI:  "https://acme.example/privacy",
	}
	history := []ConsentReceiptHistoryEntry{
		{NewState: "subscribed", Source: "form:welcome", At: emailGrant},
	}
	gen := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)
	rec := buildConsentReceipt(sub, org, history, gen)

	if rec.Version != consentReceiptVersion {
		t.Errorf("version = %q, want %q", rec.Version, consentReceiptVersion)
	}
	if rec.JurisdictionSpec != consentReceiptJurisdiction {
		t.Errorf("jurisdiction = %q, want %q", rec.JurisdictionSpec, consentReceiptJurisdiction)
	}
	// Receipt id prefers the profile id.
	if rec.ConsentReceiptID != "prof_abc" {
		t.Errorf("consentReceiptID = %q, want prof_abc", rec.ConsentReceiptID)
	}
	// Email is lowercased into the principal id.
	if rec.PIIPrincipalID != "alice@example.com" {
		t.Errorf("piiPrincipalId = %q, want alice@example.com", rec.PIIPrincipalID)
	}
	if rec.PIIController.PIIControllerName != "Acme Corp" {
		t.Errorf("controller name = %q, want Acme Corp", rec.PIIController.PIIControllerName)
	}
	if rec.PIIController.Contact != "dpo@acme.example" {
		t.Errorf("controller contact = %q", rec.PIIController.Contact)
	}
	if rec.PolicyURI != "https://acme.example/privacy" {
		t.Errorf("policyUri = %q", rec.PolicyURI)
	}
	if !rec.ConsentTimestamp.Equal(gen) {
		t.Errorf("consentTimestamp = %v, want %v", rec.ConsentTimestamp, gen)
	}

	// Five services, in the fixed purpose order.
	wantPurposes := []string{"email_marketing", "sms_marketing", "profiling", "targeted_ads", "ai_processing"}
	if len(rec.Services) != len(wantPurposes) {
		t.Fatalf("services len = %d, want %d", len(rec.Services), len(wantPurposes))
	}
	wantActive := map[string]bool{
		"email_marketing": true,
		"sms_marketing":   false,
		"profiling":       false,
		"targeted_ads":    false,
		"ai_processing":   true,
	}
	for i, svc := range rec.Services {
		if svc.Purpose != wantPurposes[i] {
			t.Errorf("services[%d].purpose = %q, want %q", i, svc.Purpose, wantPurposes[i])
		}
		if svc.ConsentType != "EXPLICIT" {
			t.Errorf("services[%d].consentType = %q, want EXPLICIT", i, svc.ConsentType)
		}
		if svc.Active != wantActive[svc.Purpose] {
			t.Errorf("services[%q].active = %v, want %v", svc.Purpose, svc.Active, wantActive[svc.Purpose])
		}
		// GrantedAt is set iff active.
		if svc.Active && svc.GrantedAt == nil {
			t.Errorf("services[%q] active but grantedAt nil", svc.Purpose)
		}
		if !svc.Active && svc.GrantedAt != nil {
			t.Errorf("services[%q] inactive but grantedAt set", svc.Purpose)
		}
	}

	if len(rec.History) != 1 || rec.History[0].NewState != "subscribed" {
		t.Errorf("history = %+v, want one subscribed entry", rec.History)
	}

	// The receipt round-trips through JSON with the Kantara camelCase keys.
	raw, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{`"consentReceiptID"`, `"piiPrincipalId"`, `"piiController"`, `"policyUri"`, `"services"`} {
		if !bytes.Contains(raw, []byte(key)) {
			t.Errorf("receipt JSON missing key %s; body=%s", key, raw)
		}
	}
}

// TestBuildConsentReceipt_FallbacksAndOmits covers the no-org-settings path:
// the controller name falls back, the policy URI + contact are omitted, the
// receipt id falls back to the row id, and a nil history serialises as [].
func TestBuildConsentReceipt_FallbacksAndOmits(t *testing.T) {
	sub := &Subscriber{
		ID:    "22222222-2222-2222-2222-222222222222",
		Email: "bob@example.com",
		// no profile id, no consent grants
	}
	rec := buildConsentReceipt(sub, consentReceiptOrgContext{}, nil, time.Now().UTC())

	if rec.ConsentReceiptID != sub.ID {
		t.Errorf("receipt id = %q, want row id %q", rec.ConsentReceiptID, sub.ID)
	}
	if rec.PIIController.PIIControllerName == "" {
		t.Error("controller name fallback should be non-empty")
	}
	if rec.SubjectProfileID != "" {
		t.Errorf("subjectProfileId = %q, want empty (omitted)", rec.SubjectProfileID)
	}
	if rec.History == nil {
		t.Error("history should be [] not nil")
	}
	for _, svc := range rec.Services {
		if svc.Active || svc.GrantedAt != nil {
			t.Errorf("no-consent receipt should have no active services: %+v", svc)
		}
	}

	// policyUri + contact are omitempty: a marshalled empty-org receipt
	// must not carry them.
	raw, _ := json.Marshal(rec)
	if bytes.Contains(raw, []byte(`"policyUri"`)) {
		t.Errorf("empty policyUri should be omitted; body=%s", raw)
	}
	if bytes.Contains(raw, []byte(`"contact"`)) {
		t.Errorf("empty contact should be omitted; body=%s", raw)
	}
	if bytes.Contains(raw, []byte(`"subjectProfileId"`)) {
		t.Errorf("empty subjectProfileId should be omitted; body=%s", raw)
	}
}

// TestBuildConsentReceiptZip_HasEntries — the ZIP wrapper carries the README +
// the consent-receipt.json, which parses back into a receipt.
func TestBuildConsentReceiptZip_HasEntries(t *testing.T) {
	sub := &Subscriber{ID: "id-1", ProfileID: "prof_z", Email: "z@y.co"}
	rec := buildConsentReceipt(sub, consentReceiptOrgContext{ControllerName: "Z"}, nil, time.Now().UTC())
	zipBytes, err := buildConsentReceiptZip(rec, time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("buildConsentReceiptZip: %v", err)
	}
	rdr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	got := map[string][]byte{}
	for _, f := range rdr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		got[f.Name] = b
	}
	for _, name := range []string{"README.txt", "consent-receipt.json"} {
		if _, ok := got[name]; !ok {
			t.Errorf("missing %q in zip", name)
		}
	}
	var parsed ConsentReceiptJSON
	if err := json.Unmarshal(got["consent-receipt.json"], &parsed); err != nil {
		t.Fatalf("consent-receipt.json not valid: %v", err)
	}
	if parsed.ConsentReceiptID != "prof_z" {
		t.Errorf("round-tripped receipt id = %q, want prof_z", parsed.ConsentReceiptID)
	}
}
