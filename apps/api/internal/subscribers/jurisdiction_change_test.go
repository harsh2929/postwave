package subscribers

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/geolocation"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// fakeJurisdictionDetector lets the unit tests assert the Repo.Jurisdiction
// wiring contract without a live geo database.
type fakeJurisdictionDetector struct {
	inferred  string
	changed   bool
	reconfirm bool
	gotIP     string
}

func (f *fakeJurisdictionDetector) DetectDrift(storedCountry, storedRegion, ip string) (string, bool, bool) {
	f.gotIP = ip
	return f.inferred, f.changed, f.reconfirm
}

func (f *fakeJurisdictionDetector) ConsentRegime(country, region string) string {
	if country == "CA" && (region == "QC" || region == "Quebec") {
		return "law25"
	}
	if country == "CA" {
		return "casl"
	}
	return "gdpr"
}

// TestDriftAdapter_DetectDrift exercises the geolocation adapter that satisfies
// the subscribers.JurisdictionDetector interface end-to-end (IP → regime
// drift), which is the concrete detector main.go wires.
func TestDriftAdapter_DetectDrift(t *testing.T) {
	adapter := geolocation.DriftAdapter{Detector: geolocation.NewStaticDetector()}

	// 80.x is a DE (GDPR) range; a US-stored subject seen there drifts and
	// must re-confirm.
	inferred, changed, reconfirm := adapter.DetectDrift("US", "", "80.1.2.3")
	if inferred != "DE" || !changed || !reconfirm {
		t.Errorf("US→DE = (%q,%v,%v), want (DE,true,true)", inferred, changed, reconfirm)
	}

	// Same country: no change.
	if _, changed, _ := adapter.DetectDrift("DE", "", "80.1.2.3"); changed {
		t.Error("same-country must not report a change")
	}

	// Undetectable IP: no change.
	if inferred, changed, _ := adapter.DetectDrift("US", "", "127.0.0.1"); changed || inferred != "" {
		t.Errorf("loopback should be undetectable, got (%q,%v)", inferred, changed)
	}
}

// TestDriftAdapter_NilDetector — a nil detector is a safe no-op.
func TestDriftAdapter_NilDetector(t *testing.T) {
	var adapter geolocation.DriftAdapter
	if inferred, changed, reconfirm := adapter.DetectDrift("US", "", "80.1.2.3"); changed || reconfirm || inferred != "" {
		t.Errorf("nil detector should no-op, got (%q,%v,%v)", inferred, changed, reconfirm)
	}
}

// TestJurisdictionReconfirm_NoTenantGate locks the 401 short-circuit.
func TestJurisdictionReconfirm_NoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PATCH", "/api/v1/subscribers/abc/jurisdiction-reconfirm", nil)
	w := httptest.NewRecorder()
	d.JurisdictionReconfirm(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

// TestRepoJurisdictionDetectorContract asserts the package-local interface is
// satisfiable by a fake (compile-time + behavioural), so the Upsert wiring has
// a stable contract independent of the geolocation package.
func TestRepoJurisdictionDetectorContract(t *testing.T) {
	var _ JurisdictionDetector = &fakeJurisdictionDetector{}
	f := &fakeJurisdictionDetector{inferred: "GB", changed: true, reconfirm: true}
	inferred, changed, reconfirm := f.DetectDrift("US", "", "1.2.3.4")
	if inferred != "GB" || !changed || !reconfirm || f.gotIP != "1.2.3.4" {
		t.Errorf("fake detector contract mismatch: %+v", f)
	}
}

func validJurisdictionReconfirmInput() JurisdictionReconfirmInput {
	return JurisdictionReconfirmInput{
		Decision:                      "accepted",
		Regime:                        "gdpr",
		PrivacyPolicyVersion:          "privacy-2026-07-19",
		CapturedText:                  "I agree to receive email marketing.\nYou may withdraw at any time.",
		ExpectedJurisdictionChangedAt: time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond),
		ExpectedSubscriberVersion:     `"subscriber:00000000-0000-4000-8000-000000000001:v1770000000000000"`,
	}
}

func TestNormalizeJurisdictionReconfirmInput(t *testing.T) {
	in := validJurisdictionReconfirmInput()
	in.Decision = " ACCEPTED "
	in.Regime = " GDPR "
	in.PrivacyPolicyVersion = " privacy-2026-07-19 "
	in.CapturedText = "  exact displayed copy\n"
	if err := normalizeJurisdictionReconfirmInput(&in, time.Now()); err != nil {
		t.Fatalf("normalize valid input: %v", err)
	}
	if in.Decision != "accepted" || in.Regime != "gdpr" || in.PrivacyPolicyVersion != "privacy-2026-07-19" {
		t.Fatalf("normalized vocabulary = %+v", in)
	}
	if in.CapturedText != "  exact displayed copy\n" {
		t.Fatalf("captured text lost literal whitespace: %q", in.CapturedText)
	}
}

func TestNormalizeJurisdictionReconfirmInputRejectsIncompleteOrHostileEvidence(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name   string
		mutate func(*JurisdictionReconfirmInput)
		want   string
	}{
		{"missing decision", func(in *JurisdictionReconfirmInput) { in.Decision = "" }, "decision"},
		{"unknown decision", func(in *JurisdictionReconfirmInput) { in.Decision = "dismissed" }, "decision"},
		{"missing regime", func(in *JurisdictionReconfirmInput) { in.Regime = "" }, "regime"},
		{"unknown regime", func(in *JurisdictionReconfirmInput) { in.Regime = "ccpa" }, "regime"},
		{"missing policy", func(in *JurisdictionReconfirmInput) { in.PrivacyPolicyVersion = " \t" }, "privacy_policy_version"},
		{"policy bytes", func(in *JurisdictionReconfirmInput) {
			in.PrivacyPolicyVersion = strings.Repeat("a", maxJurisdictionPolicyVersionBytes+1)
		}, "privacy_policy_version"},
		{"policy control", func(in *JurisdictionReconfirmInput) { in.PrivacyPolicyVersion = "v1\nforged" }, "control"},
		{"policy format", func(in *JurisdictionReconfirmInput) { in.PrivacyPolicyVersion = "v1\u200b" }, "format"},
		{"policy invalid utf8", func(in *JurisdictionReconfirmInput) { in.PrivacyPolicyVersion = string([]byte{'v', 0xff}) }, "UTF-8"},
		{"missing copy", func(in *JurisdictionReconfirmInput) { in.CapturedText = " \n\t" }, "captured_text"},
		{"copy bytes", func(in *JurisdictionReconfirmInput) {
			in.CapturedText = strings.Repeat("a", maxJurisdictionCapturedTextBytes+1)
		}, "captured_text"},
		{"copy rune cap", func(in *JurisdictionReconfirmInput) {
			in.CapturedText = strings.Repeat("é", maxJurisdictionCapturedTextRunes+1)
		}, "captured_text"},
		{"copy control", func(in *JurisdictionReconfirmInput) { in.CapturedText = "shown\x00forged" }, "control"},
		{"copy format", func(in *JurisdictionReconfirmInput) { in.CapturedText = "shown\u202eforged" }, "format"},
		{"missing cas", func(in *JurisdictionReconfirmInput) { in.ExpectedJurisdictionChangedAt = time.Time{} }, "expected_jurisdiction_changed_at"},
		{"future cas", func(in *JurisdictionReconfirmInput) { in.ExpectedJurisdictionChangedAt = now.Add(6 * time.Minute) }, "future"},
		{"missing version", func(in *JurisdictionReconfirmInput) { in.ExpectedSubscriberVersion = "" }, "expected_subscriber_version"},
		{"wildcard version", func(in *JurisdictionReconfirmInput) { in.ExpectedSubscriberVersion = "*" }, "expected_subscriber_version"},
		{"weak version", func(in *JurisdictionReconfirmInput) { in.ExpectedSubscriberVersion = `W/"subscriber:id:v1"` }, "expected_subscriber_version"},
		{"wrong resource version", func(in *JurisdictionReconfirmInput) { in.ExpectedSubscriberVersion = `"campaign:id:v1"` }, "expected_subscriber_version"},
		{"malformed version", func(in *JurisdictionReconfirmInput) { in.ExpectedSubscriberVersion = `"subscriber:id:not-a-version"` }, "expected_subscriber_version"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validJurisdictionReconfirmInput()
			tc.mutate(&in)
			err := normalizeJurisdictionReconfirmInput(&in, now)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestJurisdictionConsentAddressValidationFailsClosed(t *testing.T) {
	subscriber := &Subscriber{
		ID:    "00000000-0000-4000-8000-000000000001",
		Email: "Subject@Example.test",
	}
	valid := &SubscriberEmail{
		ID:           "00000000-0000-4000-8000-000000000002",
		SubscriberID: subscriber.ID,
		Email:        " subject@example.test ",
	}
	if err := validateJurisdictionConsentAddress(subscriber, valid); err != nil {
		t.Fatalf("valid exact address: %v", err)
	}
	for _, tc := range []struct {
		name       string
		subscriber *Subscriber
		address    *SubscriberEmail
	}{
		{name: "nil subscriber", address: valid},
		{name: "nil address", subscriber: subscriber},
		{name: "missing address id", subscriber: subscriber, address: &SubscriberEmail{SubscriberID: subscriber.ID, Email: subscriber.Email}},
		{name: "wrong subscriber", subscriber: subscriber, address: &SubscriberEmail{ID: valid.ID, SubscriberID: "00000000-0000-4000-8000-000000000099", Email: subscriber.Email}},
		{name: "wrong address", subscriber: subscriber, address: &SubscriberEmail{ID: valid.ID, SubscriberID: subscriber.ID, Email: "other@example.test"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateJurisdictionConsentAddress(tc.subscriber, tc.address)
			if !errors.Is(err, ErrJurisdictionReconfirmationStateInvalid) {
				t.Fatalf("error = %v, want state invalid", err)
			}
		})
	}
}

func TestJurisdictionConsentProjectionRequiresExactTerminalState(t *testing.T) {
	subscriber := &Subscriber{
		ID:    "00000000-0000-4000-8000-000000000001",
		Email: "subject@example.test",
	}
	expected := &SubscriberEmail{
		ID:           "00000000-0000-4000-8000-000000000002",
		SubscriberID: subscriber.ID,
		Email:        subscriber.Email,
	}
	accepted := *expected
	accepted.ConsentStatus = "subscribed"
	if err := validateJurisdictionConsentProjection(
		subscriber, expected, &accepted, "proven", "accepted",
	); err != nil {
		t.Fatalf("valid accepted projection: %v", err)
	}
	declined := *expected
	declined.ConsentStatus = "unsubscribed"
	if err := validateJurisdictionConsentProjection(
		subscriber, expected, &declined, "failed_closed", "declined",
	); err != nil {
		t.Fatalf("valid declined projection: %v", err)
	}
	for _, tc := range []struct {
		name, decision, status, reconciliation string
		addressID                              string
	}{
		{name: "accepted without proof", decision: "accepted", status: "subscribed", reconciliation: "failed_closed", addressID: expected.ID},
		{name: "accepted wrong state", decision: "accepted", status: "unsubscribed", reconciliation: "proven", addressID: expected.ID},
		{name: "declined not terminal", decision: "declined", status: "unsubscribed", reconciliation: "proven", addressID: expected.ID},
		{name: "different immutable address", decision: "accepted", status: "subscribed", reconciliation: "proven", addressID: "00000000-0000-4000-8000-000000000099"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			projected := *expected
			projected.ID = tc.addressID
			projected.ConsentStatus = tc.status
			err := validateJurisdictionConsentProjection(
				subscriber, expected, &projected, tc.reconciliation, tc.decision,
			)
			if !errors.Is(err, ErrJurisdictionReconfirmationStateInvalid) {
				t.Fatalf("error = %v, want state invalid", err)
			}
		})
	}
}

func TestJurisdictionReconfirmHandlerRejectsWeakContractsBeforeDatabase(t *testing.T) {
	valid := validJurisdictionReconfirmInput()
	validRaw, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	wildcardVersion := valid
	wildcardVersion.ExpectedSubscriberVersion = "*"
	wildcardVersionRaw, err := json.Marshal(wildcardVersion)
	if err != nil {
		t.Fatal(err)
	}
	invalidUTF8Raw := bytes.Replace(validRaw, []byte("I agree"), []byte{'I', ' ', 0xff}, 1)
	for _, tc := range []struct {
		name string
		body []byte
		code int
		want string
	}{
		{"empty body", nil, http.StatusBadRequest, "bad_json"},
		{"unknown field", append(validRaw[:len(validRaw)-1], []byte(`,"dismiss_banner":true}`)...), http.StatusBadRequest, "unknown_field"},
		{"invalid UTF-8", invalidUTF8Raw, http.StatusBadRequest, "valid UTF-8"},
		{"incomplete body", []byte(`{"decision":"accepted","regime":"gdpr"}`), http.StatusBadRequest, "invalid_jurisdiction_reconfirmation"},
		{"wildcard subscriber version", wildcardVersionRaw, http.StatusBadRequest, "expected_subscriber_version"},
		{"valid but unwired", validRaw, http.StatusServiceUnavailable, "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "/api/v1/subscribers/id/jurisdiction-reconfirm", bytes.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
			rec := httptest.NewRecorder()
			(&Deps{Repo: &Repo{}}).JurisdictionReconfirm(rec, req)
			if rec.Code != tc.code || !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("status/body = %d %s, want %d containing %q", rec.Code, rec.Body.String(), tc.code, tc.want)
			}
		})
	}
}
