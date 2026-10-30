package sms

// Tests for keyword auto-responses (A8 / GAP-LS-146/147): reserved
// carrier keywords can never become tenant rows (422 with a dedicated
// code), keyword normalization, and the consent-action mapping that
// makes an opt_out keyword write the same suppression STOP writes.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestKeywordListAggregatesConsentLedgerOnce(t *testing.T) {
	source, err := os.ReadFile("keyword_responses.go")
	if err != nil {
		t.Fatalf("read keyword response store: %v", err)
	}
	text := string(source)
	start := strings.Index(text, "func (s *Store) ListKeywordResponses")
	if start < 0 {
		t.Fatal("could not find ListKeywordResponses source")
	}
	end := strings.Index(text[start:], "// CreateKeywordResponse is create-only")
	if end < 0 {
		t.Fatal("could not isolate ListKeywordResponses source")
	}
	list := text[start : start+end]
	if strings.Count(list, "FROM sms_consent_events") != 1 ||
		!strings.Contains(list, "WITH grant_counts AS MATERIALIZED") ||
		strings.Contains(list, "ce.tenant_id = kr.tenant_id") {
		t.Fatalf("keyword list must aggregate one tenant ledger scan, not one correlated scan per row:\n%s", list)
	}
	if !strings.Contains(list, "optInCount > 1<<31-1") {
		t.Fatal("keyword list lost fail-closed int32 count projection guard")
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestReservedSMSKeyword(t *testing.T) {
	for _, kw := range []string{
		"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END",
		"START", "UNSTOP", "HELP",
		// any case / padding
		"stop", " Help ", "unsubscribe",
	} {
		if !ReservedSMSKeyword(kw) {
			t.Errorf("ReservedSMSKeyword(%q) = false, want true", kw)
		}
	}
	for _, kw := range []string{"SAVE10", "JOIN", "", "STOPP"} {
		if ReservedSMSKeyword(kw) {
			t.Errorf("ReservedSMSKeyword(%q) = true, want false", kw)
		}
	}
	// The reserved set must cover everything phone.go's hardcoded
	// switch classifies, so the two layers can never disagree about
	// who owns a keyword.
	for kw := range optOutKeywords {
		if !ReservedSMSKeyword(kw) {
			t.Errorf("opt-out keyword %q missing from reserved set", kw)
		}
	}
}

func TestApplyKeywordResponseInput_RejectsReservedKeywords(t *testing.T) {
	str := func(s string) *string { return &s }
	for _, kw := range []string{"STOP", "stop", " Help ", "UNSUBSCRIBE"} {
		row := KeywordResponse{Action: KeywordActionReplyOnly, Enabled: true}
		err := applyKeywordResponseInput(&row, KeywordResponseInput{
			Keyword:      str(kw),
			ResponseBody: str("hi"),
		})
		if err == nil {
			t.Fatalf("keyword %q: expected reserved-keyword error", kw)
		}
		if _, ok := err.(errReservedKeyword); !ok {
			t.Fatalf("keyword %q: error %T, want errReservedKeyword", kw, err)
		}
	}
}

func TestApplyKeywordResponseInput_Validation(t *testing.T) {
	str := func(s string) *string { return &s }

	// Happy path: keyword upper-normalized, 'custom' action mapped to
	// reply_only, response_text honored as alias.
	row := KeywordResponse{Enabled: true}
	if err := applyKeywordResponseInput(&row, KeywordResponseInput{
		Keyword:      str("  save10 "),
		ResponseText: str("Use code SAVE10!"),
		Action:       str("custom"),
	}); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	if row.Keyword != "SAVE10" {
		t.Fatalf("keyword not normalized: %q", row.Keyword)
	}
	if row.Action != KeywordActionReplyOnly {
		t.Fatalf("custom action not mapped: %q", row.Action)
	}
	if row.ResponseBody != "Use code SAVE10!" || row.ResponseText != row.ResponseBody {
		t.Fatalf("response body alias broken: %q / %q", row.ResponseBody, row.ResponseText)
	}

	// Alias pairs are rejected instead of silently choosing one value from an
	// ambiguous or stale client payload.
	row = KeywordResponse{Enabled: true}
	if err := applyKeywordResponseInput(&row, KeywordResponseInput{
		Keyword:      str("JOIN"),
		ResponseBody: str("canonical"),
		ResponseText: str("legacy"),
	}); err == nil {
		t.Fatal("ambiguous response_body/response_text pair was accepted")
	}

	// opt_out copy is deliberately scoped to SMS marketing from this sender;
	// it must never promise that every possible message/effect has ceased.
	row = KeywordResponse{Enabled: true}
	if err := applyKeywordResponseInput(&row, KeywordResponseInput{
		Keyword:      str("LEAVE"),
		ResponseBody: str("caller copy must not widen the promise"),
		Action:       str(KeywordActionOptOut),
	}); err != nil {
		t.Fatalf("valid opt-out input rejected: %v", err)
	}
	const scopedOptOutCopy = "You are unsubscribed from SMS marketing messages from this sender."
	if row.ResponseBody != scopedOptOutCopy || row.ResponseText != scopedOptOutCopy || optOutConfirmationBody != scopedOptOutCopy {
		t.Fatalf("opt-out copy drifted: body=%q alias=%q canonical=%q", row.ResponseBody, row.ResponseText, optOutConfirmationBody)
	}

	bad := []KeywordResponseInput{
		{ResponseBody: str("x")},                                               // no keyword
		{Keyword: str("TWO WORDS"), ResponseBody: str("x")},                    // whitespace
		{Keyword: str("JOIN")},                                                 // no body
		{Keyword: str("JOIN"), ResponseBody: str("x"), Action: str("explode")}, // bad action
	}
	for i, in := range bad {
		r := KeywordResponse{Enabled: true}
		if err := applyKeywordResponseInput(&r, in); err == nil {
			t.Errorf("case %d: expected validation error", i)
		}
	}
}

func TestKeywordConsentAction(t *testing.T) {
	if got := keywordConsentAction(KeywordActionOptOut); got != ConsentRevoked {
		t.Fatalf("opt_out -> %q, want %q (STOP parity)", got, ConsentRevoked)
	}
	if got := keywordConsentAction(legacyKeywordActionOptIn); got != "" {
		t.Fatalf("custom opt_in must not grant consent, got %q", got)
	}
	if got := keywordConsentAction(KeywordActionReplyOnly); got != "" {
		t.Fatalf("reply_only -> %q, want no consent action", got)
	}
}

func TestInboundKeyword(t *testing.T) {
	cases := map[string]string{
		"save10":           "SAVE10",
		"  Join the club ": "JOIN",
		"":                 "",
		"   ":              "",
		"stop":             "STOP", // extracted, then filtered by the reserved check
	}
	for body, want := range cases {
		if got := inboundKeyword(body); got != want {
			t.Errorf("inboundKeyword(%q) = %q, want %q", body, got, want)
		}
	}
}

// CreateKeywordResponse validates before touching the store, so the
// reserved-keyword 422 contract is testable with an empty Deps.
func TestCreateKeywordResponse_Reserved422(t *testing.T) {
	d := &Deps{}
	body := `{"keyword":"STOP","response_body":"` + optOutConfirmationBody + `","action":"opt_out"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sms/keyword-responses",
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "33333333-3333-4333-8333-333333333333"}))
	rec := httptest.NewRecorder()
	d.CreateKeywordResponse(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "reserved_keyword") {
		t.Fatalf("expected code reserved_keyword, body = %s", rec.Body.String())
	}
}

func TestCreateKeywordResponseRequiresExplicitReleasedOptOutContract(t *testing.T) {
	d := &Deps{}
	cases := []string{
		fmt.Sprintf(`{"keyword":"LEAVE","response_body":%q}`, optOutConfirmationBody),
		fmt.Sprintf(`{"keyword":"LEAVE","response_body":%q,"action":"reply_only"}`, optOutConfirmationBody),
		fmt.Sprintf(`{"keyword":"LEAVE","response_body":%q,"action":"custom"}`, optOutConfirmationBody),
		fmt.Sprintf(`{"keyword":"LEAVE","response_body":%q,"action":" opt_out"}`, optOutConfirmationBody),
		`{"keyword":"LEAVE","response_body":"You will never receive another message.","action":"opt_out"}`,
		`{"keyword":"LEAVE","action":"opt_out"}`,
	}
	for _, body := range cases {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/sms/keyword-responses", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
		rec := httptest.NewRecorder()
		d.CreateKeywordResponse(rec, req)
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "keyword_action_release_held") {
			t.Fatalf("body %s status/response = %d %s", body, rec.Code, rec.Body.String())
		}
	}
}

func TestKeywordReplyOnlyLegacyMutationRequiresExplicitCanonicalConversion(t *testing.T) {
	legacy := KeywordResponse{Action: KeywordActionReplyOnly, ResponseBody: "legacy reply", Enabled: true}
	disable := false
	optOut := KeywordActionOptOut
	replyOnly := KeywordActionReplyOnly
	canonical := optOutConfirmationBody
	nonCanonical := "legacy reply"

	for name, in := range map[string]KeywordResponseInput{
		"toggle only":          {Enabled: &disable},
		"action only":          {Action: &optOut},
		"body only":            {ResponseBody: &canonical},
		"reply only retained":  {Action: &replyOnly, ResponseBody: &canonical},
		"noncanonical convert": {Action: &optOut, ResponseBody: &nonCanonical},
	} {
		if err := validateKeywordResponsePatchMutation(legacy, in); !errors.Is(err, errSMSKeywordActionReleaseHeld) {
			t.Errorf("%s error = %v, want release hold", name, err)
		}
	}
	if err := validateKeywordResponsePatchMutation(legacy, KeywordResponseInput{
		Action: &optOut, ResponseBody: &canonical, Enabled: &disable,
	}); err != nil {
		t.Fatalf("explicit atomic legacy conversion rejected: %v", err)
	}

	current := KeywordResponse{Action: KeywordActionOptOut, ResponseBody: canonical, Enabled: true}
	if err := validateKeywordResponsePatchMutation(current, KeywordResponseInput{Enabled: &disable}); err != nil {
		t.Fatalf("ordinary opt-out toggle rejected: %v", err)
	}
	if err := validateKeywordResponsePatchMutation(current, KeywordResponseInput{Action: &replyOnly}); !errors.Is(err, errSMSKeywordActionReleaseHeld) {
		t.Fatalf("opt-out downgrade error = %v, want release hold", err)
	}
}

func TestKeywordPolicyHandlersRejectAmbiguousRequestShapesBeforeDatabase(t *testing.T) {
	d := &Deps{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sms/keyword-responses?x=1", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	rec := httptest.NewRecorder()
	d.ListKeywordResponses(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_query") {
		t.Fatalf("list query status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/sms/keyword-responses", strings.NewReader(`{"keyword":"SAVE","response_body":"ok","surprise":true}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	rec = httptest.NewRecorder()
	d.CreateKeywordResponse(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "unknown_field") {
		t.Fatalf("unknown body status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/sms/keyword-responses", strings.NewReader(`{"keyword":"SAVE","response_body":"one","response_text":"two"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	rec = httptest.NewRecorder()
	d.CreateKeywordResponse(rec, req)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "validation_failed") {
		t.Fatalf("ambiguous alias status/body = %d %s", rec.Code, rec.Body.String())
	}

	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/sms/keyword-responses/"+id, strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	req = withSMSRouteParam(req, "id", id)
	rec = httptest.NewRecorder()
	d.UpdateKeywordResponse(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_expected_updated_at") {
		t.Fatalf("missing PATCH version status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/v1/sms/keyword-responses/"+id, strings.NewReader(`{"expected_updated_at":"2026-08-28T00:00:00Z"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	req = withSMSRouteParam(req, "id", id)
	rec = httptest.NewRecorder()
	d.UpdateKeywordResponse(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "empty_patch") {
		t.Fatalf("empty PATCH status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/sms/keyword-responses/"+id, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	req = withSMSRouteParam(req, "id", id)
	rec = httptest.NewRecorder()
	d.DeleteKeywordResponse(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_expected_updated_at") {
		t.Fatalf("missing DELETE version status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/sms/keyword-responses/not-a-uuid", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	req = withSMSRouteParam(req, "id", "not-a-uuid")
	rec = httptest.NewRecorder()
	d.DeleteKeywordResponse(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_keyword_response_id") {
		t.Fatalf("invalid id status/body = %d %s", rec.Code, rec.Body.String())
	}
}

func TestKeywordResponse_JSONShape(t *testing.T) {
	row := KeywordResponse{
		ID:           "k1",
		Keyword:      "SAVE10",
		ResponseBody: "Use SAVE10",
		ResponseText: "Use SAVE10",
		Action:       KeywordActionReplyOnly,
		Enabled:      true,
	}
	b := mustJSON(t, row)
	for _, w := range []string{
		`"keyword":"SAVE10"`, `"response_body":"Use SAVE10"`,
		`"response_text":"Use SAVE10"`, `"action":"reply_only"`, `"enabled":true`,
	} {
		if !strings.Contains(b, w) {
			t.Errorf("missing %s in %s", w, b)
		}
	}
}

// The gate's quiet-hours decision carries hold_until on the wire so
// the worker (and operators reading the block reason) can see when
// sending resumes; absent for non-temporal blocks.
func TestGateDecision_HoldUntilJSON(t *testing.T) {
	d := GateDecision{Allowed: false, Reason: "quiet_hours", Segments: 1}
	if s := mustJSON(t, d); strings.Contains(s, "hold_until") {
		t.Fatalf("hold_until must be omitted when unset: %s", s)
	}
	at := utc(11, 9, 0)
	d.HoldUntil = &at
	if s := mustJSON(t, d); !strings.Contains(s, fmt.Sprintf(`"hold_until":%q`, at.Format("2006-01-02T15:04:05Z"))) {
		t.Fatalf("hold_until missing or misformatted: %s", s)
	}
}
