// SPDX-License-Identifier: AGPL-3.0-only
package consent

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestValidateEventInputRejectsMissingTenant(t *testing.T) {
	err := validateEventInput(EventInput{
		SubjectType: "visitor",
		Channel:     "web",
		Category:    "analytics",
		Action:      "granted",
		SubjectID:   "v1",
	})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "tenant_id") {
		t.Fatalf("expected tenant_id hint, got %q", err.Error())
	}
}

func TestValidateEventInputRejectsBadEnum(t *testing.T) {
	cases := []struct {
		name string
		in   EventInput
		want string
	}{
		{"subject_type", EventInput{TenantID: "t1", SubjectType: "alien", Channel: "web", Category: "analytics", Action: "granted", SubjectID: "v1"}, "subject_type"},
		{"channel", EventInput{TenantID: "t1", SubjectType: "visitor", Channel: "carrier-pigeon", Category: "analytics", Action: "granted", SubjectID: "v1"}, "channel"},
		{"category", EventInput{TenantID: "t1", SubjectType: "visitor", Channel: "web", Category: "telepathy", Action: "granted", SubjectID: "v1"}, "category"},
		{"action", EventInput{TenantID: "t1", SubjectType: "visitor", Channel: "web", Category: "analytics", Action: "vibed", SubjectID: "v1"}, "action"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateEventInput(tc.in)
			if err == nil {
				t.Fatalf("expected error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q in %q", tc.want, err.Error())
			}
		})
	}
}

func TestValidateEventInputRequiresSubject(t *testing.T) {
	err := validateEventInput(EventInput{
		TenantID:    "t1",
		SubjectType: "visitor",
		Channel:     "web",
		Category:    "analytics",
		Action:      "granted",
	})
	if err == nil || !strings.Contains(err.Error(), "subject_id or subject_email") {
		t.Fatalf("expected subject hint, got %v", err)
	}
}

func TestValidateEventInputAcceptsHappyPath(t *testing.T) {
	if err := validateEventInput(EventInput{
		TenantID:    "11111111-1111-1111-1111-111111111111",
		SubjectType: "visitor",
		SubjectID:   "v-abc",
		Channel:     "web",
		Category:    "analytics",
		Action:      "granted",
	}); err != nil {
		t.Fatalf("happy path rejected: %v", err)
	}
}

func TestValidateEventInputRequiresPairedDecisionIdentity(t *testing.T) {
	base := EventInput{
		TenantID:    "11111111-1111-1111-1111-111111111111",
		SubjectType: "visitor",
		SubjectID:   "visitor-0123456789",
		Channel:     "web",
		Category:    "analytics",
		Action:      "granted",
	}

	onlyID := base
	onlyID.DecisionID = "22222222-2222-8222-8222-222222222222"
	if err := validateEventInput(onlyID); err == nil || !strings.Contains(err.Error(), "supplied together") {
		t.Fatalf("expected paired decision validation, got %v", err)
	}

	paired := base
	paired.DecisionID = "22222222-2222-8222-8222-222222222222"
	paired.RequestFingerprint = strings.Repeat("a", 64)
	if err := validateEventInput(paired); err != nil {
		t.Fatalf("valid decision identity rejected: %v", err)
	}

	badDigest := paired
	badDigest.RequestFingerprint = strings.Repeat("A", 64)
	if err := validateEventInput(badDigest); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("expected lowercase digest rejection, got %v", err)
	}
}

func TestValidateEventInputMatchesEvidenceReadBounds(t *testing.T) {
	t.Parallel()
	base := EventInput{
		TenantID:    "11111111-1111-1111-1111-111111111111",
		SubjectType: "visitor",
		SubjectID:   "visitor-0123456789",
		Channel:     "web",
		Category:    "analytics",
		Action:      "granted",
		Source:      "cookie_banner",
	}
	tests := []struct {
		name string
		edit func(*EventInput)
	}{
		{name: "subject id bytes", edit: func(in *EventInput) { in.SubjectID = strings.Repeat("x", maxConsentSubjectIDBytes+1) }},
		{name: "subject email", edit: func(in *EventInput) { in.SubjectID = ""; in.SubjectEmail = "not-an-email" }},
		{name: "source bidi", edit: func(in *EventInput) { in.Source = "cookie\u202Ebanner" }},
		{name: "policy bytes", edit: func(in *EventInput) { in.PolicyVersion = strings.Repeat("p", maxConsentPolicyVersionBytes+1) }},
		{name: "user agent control", edit: func(in *EventInput) { in.UserAgent = "agent\nforged" }},
		{name: "user agent bytes", edit: func(in *EventInput) { in.UserAgent = strings.Repeat("a", maxConsentUserAgentBytes+1) }},
		{name: "proof bidi", edit: func(in *EventInput) { in.ProofText = "proof\u2066hidden" }},
		{name: "preferences bytes", edit: func(in *EventInput) {
			in.Preferences = map[string]any{"value": strings.Repeat("x", maxConsentPreferencesBytes)}
		}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			in := base
			test.edit(&in)
			if err := validateEventInput(in); !errors.Is(err, ErrInvalidEvent) {
				t.Fatalf("validation error=%v, want ErrInvalidEvent", err)
			}
		})
	}
}

func TestConsentWritersFailClosedWithoutStore(t *testing.T) {
	t.Parallel()
	if _, err := RecordEvent(context.Background(), nil, EventInput{}); !errors.Is(err, ErrConsentStoreUnavailable) {
		t.Fatalf("RecordEvent nil store error=%v", err)
	}
	if _, err := Record(context.Background(), nil, RecordInput{
		TenantID: "11111111-1111-4111-8111-111111111111", SubscriberEmail: "person@example.test",
		NewState: "subscribed", Source: "api",
	}); !errors.Is(err, ErrConsentStoreUnavailable) {
		t.Fatalf("Record nil store error=%v", err)
	}
	if _, err := RecordProof(context.Background(), nil, ProofInput{
		TenantID: "11111111-1111-4111-8111-111111111111", Email: "person@example.test",
		ConsentStatus: "granted", Source: "api",
	}); !errors.Is(err, ErrConsentStoreUnavailable) {
		t.Fatalf("RecordProof nil store error=%v", err)
	}
}

func TestValidateEventInputBoundsOccurredAt(t *testing.T) {
	validInput := func(occurredAt time.Time) EventInput {
		return EventInput{
			TenantID:    "11111111-1111-1111-1111-111111111111",
			SubjectType: "subscriber",
			SubjectID:   "22222222-2222-2222-2222-222222222222",
			Channel:     "email",
			Category:    "email_marketing",
			Action:      "granted",
			OccurredAt:  &occurredAt,
		}
	}

	valid := time.Now().Add(-24 * time.Hour)
	if err := validateEventInput(validInput(valid)); err != nil {
		t.Fatalf("valid reviewed occurrence rejected: %v", err)
	}

	tooOld := earliestConsentEventTime.Add(-time.Nanosecond)
	if err := validateEventInput(validInput(tooOld)); err == nil || !strings.Contains(err.Error(), "occurred_at") {
		t.Fatalf("expected pre-epoch occurrence rejection, got %v", err)
	}

	tooFarFuture := time.Now().Add(consentEventFutureSkew + time.Minute)
	if err := validateEventInput(validInput(tooFarFuture)); err == nil || !strings.Contains(err.Error(), "occurred_at") {
		t.Fatalf("expected future occurrence rejection, got %v", err)
	}
}

func TestReadGPCParsesSecGPCHeader(t *testing.T) {
	cases := map[string]bool{
		"":      false,
		"0":     false,
		"false": false,
		"1":     true,
		"true":  false,
		"yes":   false,
	}
	for v, want := range cases {
		r := httptest.NewRequest(http.MethodPost, "/x", nil)
		if v != "" {
			r.Header.Set("Sec-GPC", v)
		}
		if got := ReadGPC(r); got != want {
			t.Fatalf("Sec-GPC=%q: got %v, want %v", v, got, want)
		}
	}
}

func TestReadStrictGPCRejectsUnknownAndDuplicateValues(t *testing.T) {
	t.Run("absent", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/x", nil)
		got, err := readStrictGPC(r)
		if err != nil || got {
			t.Fatalf("got enabled=%v err=%v, want absent signal", got, err)
		}
	})

	t.Run("one affirmative value", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/x", nil)
		r.Header.Set("Sec-GPC", "1")
		got, err := readStrictGPC(r)
		if err != nil || !got {
			t.Fatalf("got enabled=%v err=%v, want enabled", got, err)
		}
	})

	for _, value := range []string{"", "0", "true", "yes", " 1", "1 "} {
		t.Run("invalid_"+strings.ReplaceAll(value, " ", "space"), func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/x", nil)
			r.Header["Sec-Gpc"] = []string{value}
			if _, err := readStrictGPC(r); err == nil {
				t.Fatalf("Sec-GPC=%q unexpectedly accepted", value)
			}
		})
	}

	t.Run("duplicate", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/x", nil)
		r.Header.Add("Sec-GPC", "1")
		r.Header.Add("Sec-GPC", "1")
		if _, err := readStrictGPC(r); err == nil {
			t.Fatal("duplicate Sec-GPC unexpectedly accepted")
		}
	})
}

func TestPublicConsentIdempotencyKeyValidation(t *testing.T) {
	request := func(values ...string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/x", nil)
		for _, value := range values {
			r.Header.Add("Idempotency-Key", value)
		}
		return r
	}

	if key, keyed, err := publicConsentIdempotencyKey(request()); err != nil || keyed || key != "" {
		t.Fatalf("keyless legacy request: key=%q keyed=%v err=%v", key, keyed, err)
	}
	if key, keyed, err := publicConsentIdempotencyKey(request("decision-1")); err != nil || !keyed || key != "decision-1" {
		t.Fatalf("valid key: key=%q keyed=%v err=%v", key, keyed, err)
	}
	for name, values := range map[string][]string{
		"empty":      {""},
		"surrounded": {" decision-1 "},
		"control":    {"decision\n1"},
		"format":     {"decision\u200e1"},
		"too_long":   {strings.Repeat("x", 256)},
		"duplicate":  {"decision-1", "decision-1"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := publicConsentIdempotencyKey(request(values...)); err == nil {
				t.Fatal("invalid key unexpectedly accepted")
			}
		})
	}
}

func TestPublicConsentDecisionIdentityAndFingerprintAreDeterministic(t *testing.T) {
	semantics := publicConsentSemantics{
		VisitorID: "0123456789abcdef",
		Choice:    "custom",
		Analytics: true,
		Marketing: false,
		GPC:       false,
	}
	fingerprint := fingerprintPublicConsent(semantics)
	if len(fingerprint) != 64 || fingerprint != fingerprintPublicConsent(semantics) {
		t.Fatalf("fingerprint is not a deterministic SHA-256 digest: %q", fingerprint)
	}
	changed := semantics
	changed.Marketing = true
	if fingerprint == fingerprintPublicConsent(changed) {
		t.Fatal("different normalized decision reused request fingerprint")
	}

	tenantA := "11111111-1111-1111-1111-111111111111"
	tenantB := "22222222-2222-2222-2222-222222222222"
	id := keyedPublicConsentDecisionID(tenantA, "client-decision-1")
	if _, err := uuid.Parse(id); err != nil {
		t.Fatalf("decision id is not UUID-shaped: %q: %v", id, err)
	}
	if id != keyedPublicConsentDecisionID(tenantA, "client-decision-1") {
		t.Fatal("same tenant/key did not produce the same decision id")
	}
	if id != keyedPublicConsentDecisionID(strings.ToUpper(tenantA), "client-decision-1") {
		t.Fatal("UUID text formatting changed the decision id")
	}
	if id == keyedPublicConsentDecisionID(tenantA, "client-decision-2") ||
		id == keyedPublicConsentDecisionID(tenantB, "client-decision-1") {
		t.Fatal("decision id was not scoped by both tenant and client key")
	}
}

func TestPublicConsentResponseReconstruction(t *testing.T) {
	decisionID := "22222222-2222-8222-8222-222222222222"
	fingerprint := strings.Repeat("a", 64)
	rows := []publicConsentStoredRow{
		{ID: "33333333-3333-4333-8333-333333333333", Category: "essential", Source: "cookie_banner", Fingerprint: fingerprint},
		{ID: "44444444-4444-4444-8444-444444444444", Category: "analytics", Source: "cookie_banner", Fingerprint: fingerprint},
		{ID: "55555555-5555-4555-8555-555555555555", Category: "marketing", Source: "cookie_banner", Fingerprint: fingerprint},
	}
	response, found, err := publicConsentResponseFromRows(decisionID, fingerprint, rows)
	if err != nil || !found {
		t.Fatalf("reconstruct: found=%v err=%v", found, err)
	}
	if response.DecisionID != decisionID || response.EventIDs.Essential != rows[0].ID ||
		response.EventIDs.Analytics != rows[1].ID || response.EventIDs.Marketing != rows[2].ID ||
		response.LastID != rows[2].ID || !response.Idempotent || response.Written != 3 {
		t.Fatalf("unexpected replay response: %+v", response)
	}

	if _, found, err := publicConsentResponseFromRows(decisionID, strings.Repeat("b", 64), rows); !found || !errors.Is(err, errPublicConsentConflict) {
		t.Fatalf("expected keyed conflict, found=%v err=%v", found, err)
	}
	if _, found, err := publicConsentResponseFromRows(decisionID, fingerprint, rows[:2]); !found || !errors.Is(err, errPublicConsentCorrupt) {
		t.Fatalf("expected incomplete batch to fail closed, found=%v err=%v", found, err)
	}
}

func TestClientIPIgnoresForwardedForByDefault(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/x", nil)
	r.Header.Set("X-Forwarded-For", "203.0.113.5, 198.51.100.1")
	r.RemoteAddr = "10.0.0.1:51234"
	if got := ClientIP(r); got != "10.0.0.1" {
		t.Fatalf("want verified peer 10.0.0.1, got %q", got)
	}
}

func TestClientIPFallsBackToRemoteAddrPortStripped(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/x", nil)
	r.RemoteAddr = "192.0.2.7:443"
	if got := ClientIP(r); got != "192.0.2.7" {
		t.Fatalf("want 192.0.2.7, got %q", got)
	}
}

func TestClassifyChoice(t *testing.T) {
	cases := []struct {
		choice string
		action string
		source string
	}{
		{"accept", "granted", "cookie_banner"},
		{"reject", "denied", "cookie_banner"},
		{"custom", "granted", "cookie_banner"},
		{"gpc", "denied", "gpc"},
		{"bogus", "", ""},
	}
	for _, tc := range cases {
		a, s := classifyChoice(tc.choice)
		if a != tc.action || s != tc.source {
			t.Fatalf("choice %q: got (%q,%q), want (%q,%q)",
				tc.choice, a, s, tc.action, tc.source)
		}
	}
}

func TestGlobalPrivacyControlOverridesBannerGrant(t *testing.T) {
	original := map[string]any{"analytics": true, "marketing": true}
	choice, prefs, gpc := applyGlobalPrivacyControl("accept", original, true)
	if choice != "gpc" || !gpc || boolPref(prefs, "analytics") || boolPref(prefs, "marketing") {
		t.Fatalf("choice=%q prefs=%v gpc=%v, want GPC denial", choice, prefs, gpc)
	}
	if !boolPref(original, "analytics") || !boolPref(original, "marketing") {
		t.Fatalf("input preferences were mutated: %v", original)
	}
}

func TestBoolPref(t *testing.T) {
	if boolPref(nil, "x") {
		t.Fatal("nil map should be false")
	}
	if boolPref(map[string]any{}, "x") {
		t.Fatal("missing key should be false")
	}
	if boolPref(map[string]any{"x": "true"}, "x") {
		t.Fatal("string value should not coerce to true")
	}
	if !boolPref(map[string]any{"x": true}, "x") {
		t.Fatal("true should pass through")
	}
}

func TestPublicConsentPreferenceSemantics(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		choice string
		prefs  map[string]any
		shape  bool
		match  bool
	}{
		{name: "accept exact", choice: "accept", prefs: map[string]any{"essential": true, "analytics": true, "marketing": true}, shape: true, match: true},
		{name: "accept missing", choice: "accept", prefs: nil, shape: true, match: false},
		{name: "reject omitted", choice: "reject", prefs: nil, shape: true, match: true},
		{name: "reject contradictory", choice: "reject", prefs: map[string]any{"analytics": true, "marketing": false}, shape: true, match: false},
		{name: "gpc contradictory", choice: "gpc", prefs: map[string]any{"analytics": false, "marketing": true}, shape: true, match: false},
		{name: "custom mixed", choice: "custom", prefs: map[string]any{"analytics": true, "marketing": false}, shape: true, match: true},
		{name: "essential false", choice: "reject", prefs: map[string]any{"essential": false}, shape: false, match: true},
		{name: "non boolean category", choice: "reject", prefs: map[string]any{"analytics": "false"}, shape: false, match: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := validPublicConsentPreferenceShape(test.prefs); got != test.shape {
				t.Fatalf("shape=%v, want %v", got, test.shape)
			}
			if got := publicConsentChoiceMatchesPreferences(test.choice, test.prefs); got != test.match {
				t.Fatalf("match=%v, want %v", got, test.match)
			}
		})
	}
}

func TestPublicRecordRejectsOversizedBody(t *testing.T) {
	deps := &Deps{} // nil pool
	body := `{"tenant_id":"t1","visitor_id":"v","choice":"accept","prefs":{"x":"` +
		strings.Repeat("y", int(publicConsentJSONMaxBodyBytes)) + `"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/consent",
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	deps.PublicRecord(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPublicRecordRejectsMissingSiteKey(t *testing.T) {
	deps := &Deps{ResolveSiteKey: func(context.Context, string) (string, string, error) {
		return "tenant-1", "v2", nil
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/public/consent",
		strings.NewReader(`{"visitor_id":"0123456789abcdef","choice":"accept"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	deps.PublicRecord(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_site_key") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicRecordRejectsMalformedPrivacyAndReplayHeaders(t *testing.T) {
	deps := &Deps{ResolveSiteKey: func(context.Context, string) (string, string, error) {
		return "11111111-1111-1111-1111-111111111111", "v1", nil
	}}
	body := `{"site_key":"pwk_test","visitor_id":"0123456789abcdef","choice":"accept"}`

	t.Run("unknown Sec-GPC", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-GPC", "true")
		rec := httptest.NewRecorder()
		deps.PublicRecord(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_sec_gpc") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
			t.Fatalf("malformed privacy response is cacheable: %q", got)
		}
	})

	t.Run("duplicate Sec-GPC", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Add("Sec-GPC", "1")
		req.Header.Add("Sec-GPC", "1")
		rec := httptest.NewRecorder()
		deps.PublicRecord(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_sec_gpc") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("duplicate idempotency key", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Add("Idempotency-Key", "decision-1")
		req.Header.Add("Idempotency-Key", "decision-1")
		rec := httptest.NewRecorder()
		deps.PublicRecord(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_idempotency_key") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})
}

func TestPublicRecordRejectsMissingSubject(t *testing.T) {
	deps := &Deps{ResolveSiteKey: func(context.Context, string) (string, string, error) {
		return "t1", "v1", nil
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/public/consent",
		strings.NewReader(`{"site_key":"pwk_test","tenant_id":"t1","choice":"accept"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	deps.PublicRecord(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_visitor_id") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicRecordRejectsInvalidChoice(t *testing.T) {
	deps := &Deps{ResolveSiteKey: func(context.Context, string) (string, string, error) {
		return "t1", "v1", nil
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/public/consent",
		strings.NewReader(`{"site_key":"pwk_test","tenant_id":"t1","visitor_id":"0123456789abcdef","choice":"vibed"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	deps.PublicRecord(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_choice") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicConsentOptionalUserAgentSanitization(t *testing.T) {
	t.Parallel()
	if got := sanitizePublicConsentUserAgent("  reviewed-agent/1.0  "); got != "reviewed-agent/1.0" {
		t.Fatalf("normalized user agent = %q", got)
	}
	for _, unsafe := range []string{
		strings.Repeat("a", maxConsentUserAgentBytes+1),
		"agent\u202Ehidden",
		"agent\nforged",
	} {
		if got := sanitizePublicConsentUserAgent(unsafe); got != "" {
			t.Fatalf("unsafe public user agent retained: %q", got)
		}
	}
}

func TestPublicRecordTreatsInvalidResolvedPolicyAsUnavailable(t *testing.T) {
	deps := &Deps{ResolveSiteKey: func(context.Context, string) (string, string, error) {
		return "11111111-1111-4111-8111-111111111111", "policy\u202Ehidden", nil
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/public/consent",
		strings.NewReader(`{"site_key":"pwk_test","visitor_id":"0123456789abcdef","choice":"accept","prefs":{"essential":true,"analytics":true,"marketing":true}}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	deps.PublicRecord(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "consent_unavailable") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "policy") && strings.Contains(rec.Body.String(), "hidden") {
		t.Fatalf("resolver policy leaked in response: %s", rec.Body.String())
	}
}

func TestPublicRecordRejectsTenantMismatchAndForgedProof(t *testing.T) {
	deps := &Deps{ResolveSiteKey: func(context.Context, string) (string, string, error) {
		return "owned-tenant", "legal-v3", nil
	}}

	t.Run("tenant mismatch", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(
			`{"site_key":"pwk_test","tenant_id":"victim-tenant","visitor_id":"0123456789abcdef","choice":"accept"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		deps.PublicRecord(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "tenant_mismatch") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("subscriber identity and proof", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(
			`{"site_key":"pwk_test","visitor_id":"0123456789abcdef","subject_email":"victim@example.com","proof_text":"I consented","choice":"accept"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		deps.PublicRecord(rec, req)
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "untrusted_identity_fields") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})
}

func TestIsTrackingOptedOutNilSafe(t *testing.T) {
	if IsOpenTrackingOptedOut(nil) {
		t.Fatal("nil prefs should not be opted out")
	}
	if IsClickTrackingOptedOut(nil) {
		t.Fatal("nil prefs should not be opted out")
	}
}
