package privacy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

func TestNormalizeSeverity(t *testing.T) {
	cases := map[string]string{
		"":              "investigating",
		"investigating": "investigating",
		"LOW":           "low",
		"  medium  ":    "medium",
		"high":          "high",
		"CRITICAL":      "critical",
		"bogus":         "",
	}
	for in, want := range cases {
		if got := normalizeSeverity(in); got != want {
			t.Fatalf("normalizeSeverity(%q) = %q want %q", in, got, want)
		}
	}
}

func TestValidIncidentTransitionsForwardOnly(t *testing.T) {
	// open can move forward to any later state.
	if !validIncidentTransitions["open"]["contained"] {
		t.Fatalf("open->contained should be allowed")
	}
	if !validIncidentTransitions["open"]["closed"] {
		t.Fatalf("open->closed should remain structurally represented (runtime closure is release-held)")
	}
	// closed is terminal — no further transitions.
	if len(validIncidentTransitions["closed"]) != 0 {
		t.Fatalf("closed should be terminal, got %v", validIncidentTransitions["closed"])
	}
	// Cannot rewind from contained back to open.
	if validIncidentTransitions["contained"]["open"] {
		t.Fatalf("contained->open should be rejected (forward-only)")
	}
	// Notifications_pending may step back to contained (mid-review hold)
	// but never back to open.
	if !validIncidentTransitions["notifications_pending"]["contained"] {
		t.Fatalf("notifications_pending->contained should be allowed")
	}
	if validIncidentTransitions["notifications_pending"]["open"] {
		t.Fatalf("notifications_pending->open should be rejected")
	}
}

func TestSanitizeStringSliceDedupesAndTrims(t *testing.T) {
	got := sanitizeStringSlice([]string{"GDPR", " GDPR ", "  ", "CA", "CA", "FL"})
	want := []string{"GDPR", "CA", "FL"}
	if len(got) != len(want) {
		t.Fatalf("len = %d want %d (%v)", len(got), len(want), got)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("at %d: got %q want %q", i, got[i], want[i])
		}
	}
}

func TestPtrTimeAndDeref(t *testing.T) {
	if ptrTime(time.Time{}) != nil {
		t.Fatalf("ptrTime(zero) should be nil")
	}
	now := time.Now()
	p := ptrTime(now)
	if p == nil || !p.Equal(now.UTC()) {
		t.Fatalf("ptrTime round-trip mismatch")
	}
	if !derefTime(nil).IsZero() {
		t.Fatalf("derefTime(nil) should be zero")
	}
	if got := derefTime(p); !got.Equal(now.UTC()) {
		t.Fatalf("derefTime mismatch")
	}
}

func TestIncidentActorLabelUsesAuditIdentityWithoutBearerSecrets(t *testing.T) {
	newRequest := func() *http.Request {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/incidents", nil)
		request.Header.Set("Authorization", "Bearer pw_live_super_secret_material")
		return request
	}

	request := newRequest()
	ctx := middleware.WithUser(request.Context(), &middleware.User{Email: "session@example.test"})
	ctx = middleware.WithAPIKeyID(ctx, "key-public-id")
	ctx = middleware.WithActor(ctx, "agent", "  Incident responder bot  ")
	request = request.WithContext(ctx)
	if got := incidentActorLabel(request); got != "Incident responder bot" {
		t.Fatalf("configured actor label = %q, want trimmed label", got)
	}

	request = newRequest()
	ctx = middleware.WithUser(request.Context(), &middleware.User{Email: "session@example.test"})
	ctx = middleware.WithAPIKeyID(ctx, "key-public-id")
	request = request.WithContext(ctx)
	if got := incidentActorLabel(request); got != "apikey:key-public-id" {
		t.Fatalf("API-key fallback = %q, want namespaced non-secret id", got)
	}
	if strings.Contains(incidentActorLabel(request), "pw_live_super_secret_material") {
		t.Fatal("domain actor attribution copied bearer credential material")
	}

	request = newRequest()
	request = request.WithContext(middleware.WithUser(request.Context(), &middleware.User{
		Email: " session@example.test ",
	}))
	if got := incidentActorLabel(request); got != "session@example.test" {
		t.Fatalf("session fallback = %q, want trimmed email", got)
	}
	if got := incidentActorLabel(nil); got != "" {
		t.Fatalf("nil request actor = %q, want empty", got)
	}
}

func TestResolveJurisdictionsIsExplicitlyReleaseHeldAndNonActionable(t *testing.T) {
	res := ResolveJurisdictions([]string{"XX", "TX", "GDPR", " tx "}, []string{"email"}, 500, time.Now())
	if res.Status != jurisdictionResolutionStatus || res.ReleaseHoldCode != jurisdictionRulesReleaseHold {
		t.Fatalf("resolution did not fail closed: %#v", res)
	}
	if len(res.UnknownJurisdictions) != 1 || res.UnknownJurisdictions[0] != "XX" {
		t.Fatalf("expected XX in unknown, got %v", res.UnknownJurisdictions)
	}
	if len(res.Recognized) != 2 || res.Recognized[0].Code != "GDPR" || res.Recognized[1].Code != "TX" {
		t.Fatalf("recognized selection metadata is not sorted/deduplicated: %#v", res.Recognized)
	}
	payload, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal resolution: %v", err)
	}
	for _, forbidden := range []string{
		"deadline", "notify_authorities", "notify_consumer_reporting_agencies",
		"content_requirements", "threshold", "matched",
	} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("release-held resolution leaked obligation field %q: %s", forbidden, payload)
		}
	}
}

func TestResolveJurisdictionsUsesNonNullEmptyRecognizedArray(t *testing.T) {
	payload, err := json.Marshal(ResolveJurisdictions(nil, nil, 0, time.Time{}))
	if err != nil {
		t.Fatalf("marshal empty resolution: %v", err)
	}
	if !strings.Contains(string(payload), `"recognized":[]`) || strings.Contains(string(payload), "unknown_jurisdictions") {
		t.Fatalf("empty release-held resolution shape is unstable: %s", payload)
	}
}

func TestKnownJurisdictionsSorted(t *testing.T) {
	out := KnownJurisdictions()
	if len(out) == 0 {
		t.Fatalf("expected non-empty jurisdiction selector catalog")
	}
	for i := 1; i < len(out); i++ {
		if out[i-1].Code > out[i].Code {
			t.Fatalf("not sorted: %s came before %s", out[i-1].Code, out[i].Code)
		}
	}
	for _, reference := range out {
		if reference.Code == "" || reference.Name == "" {
			t.Fatalf("catalog contains empty selection metadata: %#v", reference)
		}
	}
	payload, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal catalog: %v", err)
	}
	for _, forbidden := range []string{"Deadline", "deadline", "Notify", "threshold", "content"} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("selector catalog leaked obligation field %q: %s", forbidden, payload)
		}
	}
}

func TestIncidentListProjectionOmitsJurisdictionResolution(t *testing.T) {
	payload, err := json.Marshal(incidentRow{ID: "00000000-0000-0000-0000-000000000001"})
	if err != nil {
		t.Fatalf("marshal list projection: %v", err)
	}
	if strings.Contains(string(payload), "jurisdiction_resolution") {
		t.Fatalf("list projection emitted an empty resolution object: %s", payload)
	}
}

func TestValidAudience(t *testing.T) {
	for _, a := range []string{"authority", "customer", "data_subject"} {
		if !ValidAudience(a) {
			t.Fatalf("ValidAudience(%q) = false", a)
		}
	}
	for _, a := range []string{"", "operator", "regulator", "press"} {
		if ValidAudience(a) {
			t.Fatalf("ValidAudience(%q) should be false", a)
		}
	}
}

func TestRenderPacketIsReleaseHeldForEveryRecognizedAudience(t *testing.T) {
	for _, a := range []PacketAudience{
		PacketAudienceAuthority,
		PacketAudienceCustomer,
		PacketAudienceDataSubject,
	} {
		body, sum, err := RenderPacket(a, IncidentSnapshot{})
		if !errors.Is(err, ErrIncidentPacketReleaseHeld) {
			t.Fatalf("RenderPacket(%s) error=%v, want release hold", a, err)
		}
		if body != "" || sum != "" {
			t.Fatalf("RenderPacket(%s) generated held artifact: body=%q hash=%q", a, body, sum)
		}
	}
}

func TestRenderPacketRejectsUnknownAudience(t *testing.T) {
	_, _, err := RenderPacket(PacketAudience("regulator"), IncidentSnapshot{})
	if err == nil {
		t.Fatalf("expected error for unknown audience")
	}
}

func TestPacketFilenameStable(t *testing.T) {
	got := PacketFilename(PacketAudienceAuthority, "INCIDENT 123")
	if got != "postwave-incident-incident-123-authority.md" {
		t.Fatalf("unexpected filename: %q", got)
	}
	if PacketFilename(PacketAudienceCustomer, "") != "postwave-incident-incident-customer.md" {
		t.Fatalf("empty id should fall back to 'incident'")
	}
}

func TestTemplateVersionExported(t *testing.T) {
	if TemplateVersion() == "" {
		t.Fatalf("TemplateVersion should not be empty")
	}
}

func TestSnapshotFromRowFormatting(t *testing.T) {
	clock := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	deadline := clock.Add(72 * time.Hour)
	subjects := 500
	row := incidentRow{
		ID:                     "abc",
		Severity:               "high",
		Status:                 "contained",
		DetectedAt:             clock,
		ClockStartedAt:         &clock,
		GDPR72hDeadline:        &deadline,
		AffectedRegions:        []string{"GDPR", "CA"},
		AffectedDataCategories: []string{"email", "name"},
		AffectedSubjectCount:   &subjects,
		Jurisdictions:          []string{"GDPR", "CA"},
		Summary:                "Test breach",
		TemplateVersion:        "2026-06",
		UpdatedAt:              clock.Add(6 * time.Hour),
	}
	snap := snapshotFromRow(row, "Acme")
	if snap.AffectedRegions != "GDPR, CA" {
		t.Fatalf("regions joined wrong: %q", snap.AffectedRegions)
	}
	if snap.AffectedSubjectCount != "500" {
		t.Fatalf("subjects = %q", snap.AffectedSubjectCount)
	}
	if snap.DeadlineAt != deadline.Format(time.RFC3339) {
		t.Fatalf("deadline format: %q", snap.DeadlineAt)
	}
	if snap.ContainmentAt == "" {
		t.Fatalf("contained status should expose containment timestamp")
	}
}

func TestSnapshotFromRowOpenSuppressesContainment(t *testing.T) {
	clock := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	row := incidentRow{
		ID:        "abc",
		Status:    "open",
		UpdatedAt: clock.Add(time.Hour),
	}
	snap := snapshotFromRow(row, "Acme")
	if snap.ContainmentAt != "" {
		t.Fatalf("open status should not expose containment timestamp, got %q", snap.ContainmentAt)
	}
}

func incidentHandlerRequest(method, target, body, incidentID, audience string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "11111111-1111-1111-1111-111111111111",
	})
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("incident_id", incidentID)
	if audience != "" {
		routeCtx.URLParams.Add("audience", audience)
	}
	ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
	return req.WithContext(ctx)
}

func incidentTenantRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "11111111-1111-1111-1111-111111111111",
	})
	return req.WithContext(ctx)
}

func TestTransitionStateRejectsMissingAndOversizedReasonBeforeDatabaseAccess(t *testing.T) {
	deps := &IncidentsDeps{} // nil Pool proves validation happens before persistence.
	for name, body := range map[string]string{
		"missing":   `{"to":"contained","reason":"   "}`,
		"oversized": `{"to":"contained","reason":"` + strings.Repeat("x", incidentTransitionReasonMaxRunes+1) + `"}`,
		"nul":       `{"to":"contained","reason":"unsafe\u0000reason"}`,
		"bidi":      `{"to":"contained","reason":"safe\u202eevil"}`,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			deps.TransitionState(recorder, incidentHandlerRequest(
				http.MethodPost,
				"/api/v1/privacy/incidents/incident-1/transition",
				body,
				"00000000-0000-0000-0000-000000000001",
				"",
			))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
			}
			wantCode := "missing_reason"
			if name == "oversized" {
				wantCode = "reason_too_long"
			} else if name == "nul" || name == "bidi" {
				wantCode = "invalid_reason"
			}
			if !strings.Contains(recorder.Body.String(), wantCode) {
				t.Fatalf("body = %s, want code %q", recorder.Body.String(), wantCode)
			}
		})
	}
}

func TestTransitionStateRequiresExpectedFromBeforeDatabaseAccess(t *testing.T) {
	request := incidentHandlerRequest(
		http.MethodPost,
		"/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/transition",
		`{"to":"contained","reason":"containment complete"}`,
		"00000000-0000-0000-0000-000000000001",
		"",
	)
	recorder := httptest.NewRecorder()
	(&IncidentsDeps{}).TransitionState(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_expected_from") {
		t.Fatalf("status=%d body=%s, want typed expected-state validation", recorder.Code, recorder.Body.String())
	}
}

func TestIncidentHandlersRejectMalformedIncidentIDBeforeDatabaseOrReleaseHold(t *testing.T) {
	deps := &IncidentsDeps{}
	tests := []struct {
		name    string
		request *http.Request
		handler func(http.ResponseWriter, *http.Request)
	}{
		{"get", incidentHandlerRequest(http.MethodGet, "/api/v1/privacy/incidents/not-a-uuid", "", "not-a-uuid", ""), deps.Get},
		{"transition", incidentHandlerRequest(http.MethodPost, "/api/v1/privacy/incidents/not-a-uuid/transition", `{"to":"contained","expected_from":"open","reason":"x"}`, "not-a-uuid", ""), deps.TransitionState},
		{"signoff", incidentHandlerRequest(http.MethodPost, "/api/v1/privacy/incidents/not-a-uuid/signoff", `{}`, "not-a-uuid", ""), deps.CounselSignoff},
		{"notification", incidentHandlerRequest(http.MethodPost, "/api/v1/privacy/incidents/not-a-uuid/notifications", `{}`, "not-a-uuid", ""), deps.RecordNotification},
		{"packet", incidentHandlerRequest(http.MethodGet, "/api/v1/privacy/incidents/not-a-uuid/packet/authority", "", "not-a-uuid", "authority"), deps.DownloadPacket},
		{"events", incidentHandlerRequest(http.MethodGet, "/api/v1/privacy/incidents/not-a-uuid/events", "", "not-a-uuid", ""), deps.ListEvents},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			test.handler(recorder, test.request)
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_incident_id") {
				t.Fatalf("status=%d body=%s, want typed UUID validation", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestIncidentCreateRequiresIdempotencyAndBoundsInputsBeforeDatabase(t *testing.T) {
	clock := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	deps := &IncidentsDeps{Now: func() time.Time { return clock }}
	tests := []struct {
		name string
		body string
		key  string
		code string
	}{
		{"missing idempotency", `{"summary":"test"}`, "", "idempotency_key_required"},
		{"negative subjects", `{"summary":"test","affected_subject_count":-1}`, "create-negative", "invalid_affected_subject_count"},
		{"summary bound", `{"summary":"` + strings.Repeat("x", incidentSummaryMaxRunes+1) + `"}`, "create-summary", "summary_too_long"},
		{"summary NUL", `{"summary":"unsafe\u0000text"}`, "create-summary-nul", "invalid_summary"},
		{"summary bidi", `{"summary":"safe\u2066spoof\u2069"}`, "create-summary-bidi", "invalid_summary"},
		{"array count bound", `{"summary":"test","affected_regions":["` + strings.Join(make([]string, incidentArrayMaxItems+1), `","`) + `"]}`, "create-array", "invalid_affected_regions"},
		{"array token bound", `{"summary":"test","jurisdictions":["` + strings.Repeat("x", incidentArrayTokenMaxRunes+1) + `"]}`, "create-token", "invalid_jurisdictions"},
		{"affected region bidi", `{"summary":"test","affected_regions":["US\u202eEU"]}`, "create-region-bidi", "invalid_affected_regions"},
		{"data category bidi", `{"summary":"test","affected_data_categories":["email\u2066name\u2069"]}`, "create-category-bidi", "invalid_affected_data_categories"},
		{"jurisdiction bidi", `{"summary":"test","jurisdictions":["G\u200fDPR"]}`, "create-jurisdiction-bidi", "invalid_jurisdictions"},
		{"future timestamp", `{"summary":"test","detected_at":"2026-08-19T12:06:00Z"}`, "create-future", "invalid_incident_timestamp"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := incidentTenantRequest(http.MethodPost, "/api/v1/privacy/incidents", test.body)
			if test.key != "" {
				request.Header.Set("Idempotency-Key", test.key)
			}
			recorder := httptest.NewRecorder()
			deps.Create(recorder, request)
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), test.code) {
				t.Fatalf("status=%d body=%s, want %s", recorder.Code, recorder.Body.String(), test.code)
			}
		})
	}
}

func TestIncidentTokenValidationRejectsBidiButPreservesZeroWidthJoiner(t *testing.T) {
	for _, value := range []string{
		"unsafe\u061cvalue",
		"unsafe\u200evalue",
		"unsafe\u202evalue",
		"unsafe\u2067value\u2069",
	} {
		if _, err := boundedIncidentStringSlice("tokens", []string{value}); err == nil {
			t.Fatalf("token %q passed bidirectional-format validation", value)
		}
	}
	const joined = "incident-👩\u200d💻"
	got, err := boundedIncidentStringSlice("tokens", []string{joined})
	if err != nil {
		t.Fatalf("zero-width joiner was rejected: %v", err)
	}
	if len(got) != 1 || got[0] != joined {
		t.Fatalf("normalized token=%q, want %q", got, joined)
	}
}

func TestIncidentIdempotencyKeyRequiresOneBoundedPrintableValue(t *testing.T) {
	tests := []struct {
		name   string
		values []string
		wantOK bool
		code   string
	}{
		{"valid", []string{" attempt-1 "}, true, ""},
		{"missing", nil, false, "idempotency_key_required"},
		{"blank", []string{"   "}, false, "idempotency_key_required"},
		{"repeated", []string{"one", "two"}, false, "invalid_idempotency_key"},
		{"too long", []string{strings.Repeat("x", 256)}, false, "invalid_idempotency_key"},
		{"control", []string{"unsafe\nkey"}, false, "invalid_idempotency_key"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := incidentTenantRequest(http.MethodPost, "/api/v1/privacy/incidents", `{}`)
			for _, value := range test.values {
				request.Header.Add("Idempotency-Key", value)
			}
			recorder := httptest.NewRecorder()
			if got := requireIncidentIdempotencyKey(recorder, request); got != test.wantOK {
				t.Fatalf("valid=%v want %v", got, test.wantOK)
			}
			if !test.wantOK && !strings.Contains(recorder.Body.String(), test.code) {
				t.Fatalf("body=%s, want %s", recorder.Body.String(), test.code)
			}
		})
	}
}

func TestAffectedSubjectCountDistinguishesUnknownFromConfirmedZero(t *testing.T) {
	var omitted, zero createIncidentRequest
	if err := json.Unmarshal([]byte(`{"summary":"test"}`), &omitted); err != nil {
		t.Fatalf("decode omitted count: %v", err)
	}
	if err := json.Unmarshal([]byte(`{"summary":"test","affected_subject_count":0}`), &zero); err != nil {
		t.Fatalf("decode zero count: %v", err)
	}
	if omitted.AffectedSubjectCount != nil {
		t.Fatalf("omitted count = %#v, want unknown nil", omitted.AffectedSubjectCount)
	}
	if zero.AffectedSubjectCount == nil || *zero.AffectedSubjectCount != 0 {
		t.Fatalf("explicit zero was not preserved: %#v", zero.AffectedSubjectCount)
	}
	if strings.Contains(strings.ToUpper(incidentInsertSQL), "NULLIF") {
		t.Fatal("incident insert still collapses explicit zero to SQL NULL")
	}
	returningIndex := strings.Index(incidentInsertSQL, "RETURNING id")
	if returningIndex < 0 {
		t.Fatalf("incident insert does not return its stored representation: %s", incidentInsertSQL)
	}
	returning := incidentInsertSQL[returningIndex:]
	for _, column := range []string{"detected_at", "discovered_at", "clock_started_at", "gdpr_72h_deadline", "created_at", "updated_at"} {
		if !strings.Contains(returning, column) {
			t.Fatalf("incident 201 cannot use stored %s: %s", column, incidentInsertSQL)
		}
	}
}

func TestDiscoveredAtDistinguishesUnknownFromExplicitTimestamp(t *testing.T) {
	const explicitJSON = "2026-08-19T10:11:12Z"
	var omitted, explicit createIncidentRequest
	if err := json.Unmarshal([]byte(`{"summary":"test"}`), &omitted); err != nil {
		t.Fatalf("decode omitted discovery time: %v", err)
	}
	if err := json.Unmarshal([]byte(`{"summary":"test","discovered_at":"`+explicitJSON+`"}`), &explicit); err != nil {
		t.Fatalf("decode explicit discovery time: %v", err)
	}
	if omitted.DiscoveredAt != nil {
		t.Fatalf("omitted discovered_at = %v, want unknown nil", omitted.DiscoveredAt)
	}
	if explicit.DiscoveredAt == nil || explicit.DiscoveredAt.UTC().Format(time.RFC3339) != explicitJSON {
		t.Fatalf("explicit discovered_at was not preserved: %v", explicit.DiscoveredAt)
	}

	omittedPayload, err := json.Marshal(incidentRow{ID: "00000000-0000-0000-0000-000000000001"})
	if err != nil {
		t.Fatalf("marshal incident with unknown discovery time: %v", err)
	}
	if strings.Contains(string(omittedPayload), "discovered_at") {
		t.Fatalf("unknown discovery time was fabricated in response: %s", omittedPayload)
	}
	explicitPayload, err := json.Marshal(incidentRow{
		ID:           "00000000-0000-0000-0000-000000000001",
		DiscoveredAt: ptrUTCTime(explicit.DiscoveredAt),
	})
	if err != nil {
		t.Fatalf("marshal incident with explicit discovery time: %v", err)
	}
	if !strings.Contains(string(explicitPayload), `"discovered_at":"`+explicitJSON+`"`) {
		t.Fatalf("explicit discovery time did not round-trip: %s", explicitPayload)
	}
	if strings.Contains(strings.ToUpper(incidentInsertSQL), "COALESCE($4") {
		t.Fatal("incident insert still manufactures a discovery timestamp for SQL NULL")
	}
}

func TestAffectedRegionsDoNotPopulateUnknownJurisdictions(t *testing.T) {
	regions, _, jurisdictions, issue := normalizeIncidentScope(createIncidentRequest{
		AffectedRegions: []string{"EU", "CA"},
	})
	if issue != nil {
		t.Fatalf("normalize scope: %#v", issue)
	}
	if len(regions) != 2 {
		t.Fatalf("affected regions were lost: %#v", regions)
	}
	if len(jurisdictions) != 0 {
		t.Fatalf("regions were silently treated as jurisdictions: %#v", jurisdictions)
	}
}

func TestRecordTabletopRequiresIdempotencyAndBoundsInputsBeforeDatabase(t *testing.T) {
	clock := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	deps := &IncidentsDeps{Now: func() time.Time { return clock }}
	tests := []struct {
		name string
		body string
		key  string
		code string
	}{
		{"missing idempotency", `{"scenario":"exercise","participants":["owner"]}`, "", "idempotency_key_required"},
		{"scenario bound", `{"scenario":"` + strings.Repeat("x", tabletopScenarioMaxRunes+1) + `","participants":["owner"]}`, "tabletop-scenario", "scenario_too_long"},
		{"scenario NUL", `{"scenario":"unsafe\u0000scenario","participants":["owner"]}`, "tabletop-scenario-nul", "invalid_scenario"},
		{"scenario bidi", `{"scenario":"safe\u202escenario","participants":["owner"]}`, "tabletop-scenario-bidi", "invalid_scenario"},
		{"missing participants", `{"scenario":"exercise"}`, "tabletop-participants", "missing_participants"},
		{"participant bidi", `{"scenario":"exercise","participants":["owner\u202eadmin"]}`, "tabletop-participant-bidi", "invalid_participants"},
		{"future ran_at", `{"scenario":"exercise","participants":["owner"],"ran_at":"2026-08-19T12:06:00Z"}`, "tabletop-future", "invalid_ran_at"},
		{"findings bound", `{"scenario":"exercise","participants":["owner"],"findings":"` + strings.Repeat("x", tabletopFindingsMaxRunes+1) + `"}`, "tabletop-findings", "findings_too_long"},
		{"findings NUL", `{"scenario":"exercise","participants":["owner"],"findings":"unsafe\u0000text"}`, "tabletop-findings-nul", "invalid_findings"},
		{"findings bidi", `{"scenario":"exercise","participants":["owner"],"findings":"safe\u2067text\u2069"}`, "tabletop-findings-bidi", "invalid_findings"},
		{"evidence path bound", `{"scenario":"exercise","participants":["owner"],"evidence_path":"` + strings.Repeat("x", tabletopEvidencePathMaxRunes+1) + `"}`, "tabletop-evidence", "invalid_evidence_path"},
		{"evidence path bidi", `{"scenario":"exercise","participants":["owner"],"evidence_path":"evidence/\u202ereport"}`, "tabletop-evidence-bidi", "invalid_evidence_path"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := incidentTenantRequest(http.MethodPost, "/api/v1/privacy/incidents/tabletops", test.body)
			if test.key != "" {
				request.Header.Set("Idempotency-Key", test.key)
			}
			recorder := httptest.NewRecorder()
			deps.RecordTabletop(recorder, request)
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), test.code) {
				t.Fatalf("status=%d body=%s, want %s", recorder.Code, recorder.Body.String(), test.code)
			}
		})
	}
}

func TestTabletopInsertReturnsStoredTimestamps(t *testing.T) {
	returningIndex := strings.Index(tabletopInsertSQL, "RETURNING id")
	if returningIndex < 0 {
		t.Fatalf("tabletop insert does not return its stored representation: %s", tabletopInsertSQL)
	}
	returning := tabletopInsertSQL[returningIndex:]
	for _, column := range []string{"ran_at", "created_at"} {
		if !strings.Contains(returning, column) {
			t.Fatalf("tabletop 201 cannot use stored %s: %s", column, tabletopInsertSQL)
		}
	}
}

func TestIncidentListsRejectOversizedAndNonUUIDCursorsBeforeDatabase(t *testing.T) {
	badUUIDCursor := pagination.Encode(pagination.Cursor{
		SortKey: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		ID:      "not-a-uuid",
	})
	tests := []struct {
		name    string
		cursor  string
		handler func(http.ResponseWriter, *http.Request)
		path    string
	}{
		{"incidents non-UUID", badUUIDCursor, (&IncidentsDeps{}).List, "/api/v1/privacy/incidents"},
		{"tabletops non-UUID", badUUIDCursor, (&IncidentsDeps{}).ListTabletops, "/api/v1/privacy/incidents/tabletops"},
		{"incidents oversized", strings.Repeat("x", incidentCursorMaxBytes+1), (&IncidentsDeps{}).List, "/api/v1/privacy/incidents"},
		{"tabletops oversized", strings.Repeat("x", incidentCursorMaxBytes+1), (&IncidentsDeps{}).ListTabletops, "/api/v1/privacy/incidents/tabletops"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := incidentTenantRequest(http.MethodGet, test.path+"?cursor="+test.cursor, "")
			recorder := httptest.NewRecorder()
			test.handler(recorder, request)
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_cursor") {
				t.Fatalf("status=%d body=%s, want cursor validation before nil pool", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestIncidentAuditMetadataNeverDuplicatesSensitiveNarrativeOrScopeValues(t *testing.T) {
	canaries := []string{
		"eu-west-secret-region",
		"health-diagnosis-category",
		"operator narrative with customer identity",
		"quarterly executive compromise exercise",
		"s3://private-evidence/customer-name/report.pdf",
		"sensitive-person@example.test",
	}
	metadata := []map[string]any{
		incidentOpenedAuditMetadata(
			[]string{canaries[0]},
			[]string{canaries[1]},
			[]string{"GDPR"},
			func() *int { value := 42; return &value }(),
		),
		incidentTransitionAuditMetadata("open", "contained", canaries[2]),
		tabletopAuditMetadata([]string{canaries[5]}, canaries[3], canaries[4]),
	}
	for index, item := range metadata {
		payload, err := json.Marshal(item)
		if err != nil {
			t.Fatalf("marshal audit metadata[%d]: %v", index, err)
		}
		for _, canary := range canaries {
			if strings.Contains(string(payload), canary) {
				t.Fatalf("audit metadata[%d] duplicated sensitive value %q: %s", index, canary, payload)
			}
		}
	}
}

func TestIncidentLegalEvidenceActionsAreReleaseHeldBeforePersistence(t *testing.T) {
	deps := &IncidentsDeps{} // nil Pool proves every hold precedes DB access.
	tests := []struct {
		name    string
		code    string
		request *http.Request
		handler func(http.ResponseWriter, *http.Request)
	}{
		{
			name: "closure",
			code: "incident_closure_release_hold",
			request: incidentHandlerRequest(http.MethodPost,
				"/api/v1/privacy/incidents/incident-1/transition",
				`{"to":"closed"}`,
				"00000000-0000-0000-0000-000000000001", ""),
			handler: deps.TransitionState,
		},
		{
			name: "counsel sign-off",
			code: "counsel_signoff_release_hold",
			request: incidentHandlerRequest(http.MethodPost,
				"/api/v1/privacy/incidents/incident-1/signoff", `{}`,
				"00000000-0000-0000-0000-000000000001", ""),
			handler: deps.CounselSignoff,
		},
		{
			name: "manual notification assertion",
			code: "incident_notification_release_hold",
			request: incidentHandlerRequest(http.MethodPost,
				"/api/v1/privacy/incidents/incident-1/notifications", `{}`,
				"00000000-0000-0000-0000-000000000001", ""),
			handler: deps.RecordNotification,
		},
		{
			name: "legal packet",
			code: "incident_packet_release_hold",
			request: incidentHandlerRequest(http.MethodGet,
				"/api/v1/privacy/incidents/incident-1/packet/authority", "",
				"00000000-0000-0000-0000-000000000001", "authority"),
			handler: deps.DownloadPacket,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			test.handler(recorder, test.request)
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503; body=%s", recorder.Code, recorder.Body.String())
			}
			if recorder.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("Cache-Control = %q, want private, no-store", recorder.Header().Get("Cache-Control"))
			}
			vary := strings.Join(recorder.Header().Values("Vary"), ",")
			if !strings.Contains(vary, "Authorization") || !strings.Contains(vary, "Cookie") {
				t.Fatalf("Vary = %q, want credential dimensions", vary)
			}
			if !strings.Contains(recorder.Body.String(), test.code) ||
				(!strings.Contains(recorder.Body.String(), "no change was committed") && test.name != "legal packet") {
				t.Fatalf("unexpected release-hold body: %s", recorder.Body.String())
			}
		})
	}
}

func TestIncidentReleaseHoldsBypassOnlyMatchingHistoricalReplays(t *testing.T) {
	tests := []struct {
		method string
		path   string
		body   string
		want   bool
	}{
		{http.MethodPost, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/signoff", `{}`, true},
		{http.MethodPost, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/notifications", `{}`, true},
		{http.MethodGet, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/packet/authority", "", true},
		{http.MethodGet, "/api/v1/privacy/incidents", "", true},
		{http.MethodGet, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001", "", true},
		{http.MethodGet, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/events", "", true},
		{http.MethodGet, "/api/v1/privacy/incidents/tabletops", "", true},
		{http.MethodPost, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/transition", `{"to":"closed"}`, true},
		{http.MethodPost, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/transition", `{"to":"contained"}`, false},
		{http.MethodPost, "/api/v1/privacy/incidents/tabletops", `{"scenario":"exercise"}`, false},
		{http.MethodPost, "/api/v1/privacy/incidents", `{"summary":"new"}`, false},
		{http.MethodPost, "/api/v1/campaigns", `{"name":"normal write"}`, false},
	}
	for _, test := range tests {
		request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
		if got := BypassIncidentReleaseHoldReplay(request, []byte(test.body)); got != test.want {
			t.Errorf("%s %s bypass=%v want %v", test.method, test.path, got, test.want)
		}
	}
}

func TestIncidentGlobalReplayBypassDelegatesCompleteIncidentFamily(t *testing.T) {
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodPost, "/api/v1/privacy/incidents", strings.NewReader(`{"summary":"new"}`)),
		httptest.NewRequest(http.MethodPost, "/api/v1/privacy/incidents/tabletops", strings.NewReader(`{"scenario":"drill"}`)),
		httptest.NewRequest(http.MethodPost, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/transition", strings.NewReader(`{"to":"contained"}`)),
		httptest.NewRequest(http.MethodGet, "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001", http.NoBody),
	} {
		if !BypassIncidentGlobalReplay(request, nil) {
			t.Errorf("%s %s was not delegated to the route-local replay boundary", request.Method, request.URL.Path)
		}
	}
	for _, request := range []*http.Request{
		nil,
		httptest.NewRequest(http.MethodPost, "/api/v1/privacy/requests", http.NoBody),
		httptest.NewRequest(http.MethodPost, "/api/v1/campaigns", http.NoBody),
	} {
		if BypassIncidentGlobalReplay(request, nil) {
			t.Errorf("unrelated request %#v was delegated", request)
		}
	}
}

func TestIncidentSensitiveHeadersPreserveExistingVaryDimensions(t *testing.T) {
	recorder := httptest.NewRecorder()
	recorder.Header().Add("Vary", "Accept-Encoding, Authorization")
	prepareIncidentResponse(recorder)
	if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
	vary := strings.Join(recorder.Header().Values("Vary"), ",")
	for _, value := range []string{"Accept-Encoding", "Authorization", "Cookie"} {
		if !strings.Contains(vary, value) {
			t.Fatalf("Vary = %q, missing %s", vary, value)
		}
	}
	if strings.Count(vary, "Authorization") != 1 {
		t.Fatalf("Vary duplicated Authorization: %q", vary)
	}
}

func TestProtectIncidentResponsesIsStrictlyRouteScoped(t *testing.T) {
	handler := ProtectIncidentResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	tests := []struct {
		path      string
		protected bool
	}{
		{path: "/api/v1/privacy/incidents", protected: true},
		{path: "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001", protected: true},
		{path: "/api/v1/privacy/incidents/tabletops/", protected: true},
		{path: "/api/v1/privacy/requests", protected: false},
		{path: "/api/v1/privacy/incidents-export", protected: false},
		{path: "/api/v1/campaigns", protected: false},
	}

	for _, test := range tests {
		test := test
		t.Run(test.path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, test.path, http.NoBody))
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", recorder.Code)
			}
			if !test.protected {
				if got := recorder.Header().Get("Cache-Control"); got != "" {
					t.Fatalf("unrelated route Cache-Control = %q, want untouched", got)
				}
				if got := recorder.Header().Values("Vary"); len(got) != 0 {
					t.Fatalf("unrelated route Vary = %v, want untouched", got)
				}
				return
			}
			if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q, want private, no-store", got)
			}
			vary := strings.Join(recorder.Header().Values("Vary"), ",")
			for _, dimension := range []string{"Authorization", "Cookie"} {
				if !strings.Contains(vary, dimension) {
					t.Fatalf("Vary = %q, missing %s", vary, dimension)
				}
			}
		})
	}
}

func TestIncidentNoStoreOverridesAuthenticatedReadCachePolicy(t *testing.T) {
	handler := httpcache.WithPolicy(httpcache.AuthRead())(
		http.HandlerFunc((&IncidentsDeps{}).DownloadPacket),
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, incidentHandlerRequest(
		http.MethodGet,
		"/api/v1/privacy/incidents/incident-1/packet/authority",
		"",
		"00000000-0000-0000-0000-000000000001",
		"authority",
	))
	if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want handler no-store to override AuthRead", got)
	}
	vary := strings.Join(recorder.Header().Values("Vary"), ",")
	for _, value := range []string{"Authorization", "Cookie", "Accept-Encoding"} {
		if !strings.Contains(vary, value) {
			t.Fatalf("Vary = %q, missing %s", vary, value)
		}
	}
}

func TestIncidentReleaseHoldsRemainTenantAuthFirst(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/privacy/incidents/incident-1/signoff",
		strings.NewReader(`{"signoff_by":"self-asserted@example.com"}`),
	)
	(&IncidentsDeps{}).CounselSignoff(recorder, request)
	if recorder.Code != http.StatusUnauthorized || !strings.Contains(recorder.Body.String(), "no_tenant") {
		t.Fatalf("release hold bypassed tenant authentication: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestIncidentStateAndEventSQLIntegrityContracts(t *testing.T) {
	if !strings.Contains(incidentTransitionLockSQL, "FOR UPDATE") {
		t.Fatal("state transition lookup must serialize concurrent writers")
	}
	if !strings.Contains(incidentEventParentLockSQL, "FOR SHARE") {
		t.Fatal("event existence check must keep the parent stable through the ledger read")
	}
	for _, required := range []string{
		"UNION ALL",
		"ORDER BY at ASC, source_order ASC, event_id ASC",
		"event_id::text",
		"source",
		"schema_version",
		"incident_state_transitions",
		"incident_notifications",
	} {
		if !strings.Contains(incidentEventsSQL, required) {
			t.Fatalf("event ledger query missing %q", required)
		}
	}
	payload, err := json.Marshal(incidentEventRow{
		EventID:       "00000000-0000-0000-0000-000000000001",
		Source:        "incident_state_transitions",
		SchemaVersion: 1,
		Kind:          "transition",
	})
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	for _, required := range []string{"event_id", "source", "schema_version"} {
		if !strings.Contains(string(payload), `"`+required+`"`) {
			t.Fatalf("event wire missing %q: %s", required, payload)
		}
	}
	responsePayload, err := json.Marshal(listEventsResponse{
		IncidentID: "00000000-0000-0000-0000-000000000009",
		Events:     []incidentEventRow{},
	})
	if err != nil {
		t.Fatalf("marshal event response: %v", err)
	}
	if !strings.Contains(string(responsePayload), `"incident_id":"00000000-0000-0000-0000-000000000009"`) {
		t.Fatalf("event response is not bound to the requested incident: %s", responsePayload)
	}
}

func TestDecodeStoredNotificationDecisionsFailsClosed(t *testing.T) {
	t.Parallel()

	valid, err := decodeStoredNotificationDecisions([]byte(`{"authority":"pending"}`))
	if err != nil || valid["authority"] != "pending" {
		t.Fatalf("valid decisions=%v err=%v", valid, err)
	}

	for name, raw := range map[string][]byte{
		"empty":     nil,
		"malformed": []byte(`{"authority"`),
		"array":     []byte(`[]`),
		"null":      []byte(`null`),
		"oversized": []byte(`{"value":"` + strings.Repeat("x", incidentNotificationMaxBytes) + `"}`),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got, err := decodeStoredNotificationDecisions(raw); err == nil {
				t.Fatalf("decisions=%v, want a contract error", got)
			}
		})
	}
}
