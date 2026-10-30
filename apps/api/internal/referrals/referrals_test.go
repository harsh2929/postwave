package referrals

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestGenerateCode_LengthAndAlphabet(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		c, err := GenerateCode()
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if len(c) != 8 {
			t.Fatalf("want 8 chars got %d (%q)", len(c), c)
		}
		for _, r := range c {
			if r == 'l' || r == 'o' || r == '0' || r == '1' {
				t.Fatalf("ambiguous char %q in %q", r, c)
			}
		}
		if seen[c] {
			t.Fatalf("duplicate code %q in 50 draws", c)
		}
		seen[c] = true
	}
}

func TestMilestonesUnlocked(t *testing.T) {
	ms := []Milestone{
		{Count: 1, RewardLabel: "sticker"},
		{Count: 5, RewardLabel: "tote"},
		{Count: 25, RewardLabel: "swag bag"},
	}
	cases := []struct {
		count int
		want  int
	}{
		{0, 0}, {1, 1}, {4, 1}, {5, 2}, {24, 2}, {25, 3}, {100, 3},
	}
	for _, c := range cases {
		got := MilestonesUnlocked(ms, c.count)
		if len(got) != c.want {
			t.Fatalf("count=%d want %d unlocked got %d (%v)", c.count, c.want, len(got), got)
		}
	}
}

// The referral release gate, asserted in whichever direction it is set.
//
// This began as a one-way tripwire: it t.Fatal'd whenever the gate was OPEN, so
// nobody could flip the constant without deleting the test. That was the right
// shape while the runtime was unqualified. Now that the gate is open by an explicit
// owner decision, the same test earns its keep by pinning the exact route set on
// BOTH sides of the boundary — which is the part that actually protects anything.
// Deleting it to open the gate would have thrown away the route pinning along with
// the tripwire.
func TestReferralRuntimeMountsExactlyWhatTheGateAllows(t *testing.T) {

	adminRouter := chi.NewRouter()
	(&Deps{}).MountAdminRoutes(adminRouter)
	got := map[string]bool{}
	if err := chi.Walk(
		adminRouter,
		func(
			method string,
			route string,
			_ http.Handler,
			_ ...func(http.Handler) http.Handler,
		) error {
			got[method+" "+route] = true
			return nil
		},
	); err != nil {
		t.Fatalf("walk admin routes: %v", err)
	}
	want := map[string]bool{
		"GET /api/v1/referral-programs/current": true,
		"GET /api/v1/referrals/stats":           true,
		"GET /api/v1/referrals/leaderboard":     true,
	}
	// Every route the gate governs, named individually. A blanket count would
	// pass if a route were renamed or silently dropped. The set is mounted in
	// BOTH release states: released routes reach their handlers, held routes
	// answer the stable 503 hold (the route-authorization startup validator
	// requires every manifest route to be mounted, and the manifest classifies
	// these as release-held while the gate is closed).
	gated := []string{
		"POST /api/v1/referral-programs",
		"GET /api/v1/subscribers/{id}/referral",
		"POST /api/v1/referrals/credit",
		"POST /api/v1/subscribers/{id}/referral/code",
		"GET /api/v1/referrals/payouts",
		"GET /api/v1/referrals/payouts/export",
		"PATCH /api/v1/referrals/payouts/{id}",
		"GET /api/v1/referrals/variants",
		"POST /api/v1/referrals/variants",
		"DELETE /api/v1/referrals/variants/{key}",
	}
	for _, route := range gated {
		want[route] = true
	}
	if len(got) != len(want) {
		t.Fatalf("mounted admin routes = %#v, want %#v", got, want)
	}
	for route := range want {
		if !got[route] {
			t.Fatalf("missing route %q from %#v", route, got)
		}
	}
	if !OperationalRuntimeAvailable {
		for _, route := range gated {
			method, path, _ := strings.Cut(route, " ")
			rec := httptest.NewRecorder()
			adminRouter.ServeHTTP(rec, httptest.NewRequest(method, strings.NewReplacer("{id}", "sub-1", "{key}", "k").Replace(path), nil))
			if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), OperationalRuntimeHoldCode) {
				t.Fatalf("held route %s status=%d body=%q, want 503 carrying %q", route, rec.Code, rec.Body.String(), OperationalRuntimeHoldCode)
			}
		}
	}

	publicRouter := chi.NewRouter()
	(&Deps{}).MountPublicRoutes(publicRouter)
	publicRouteCount := 0
	if err := chi.Walk(
		publicRouter,
		func(
			_ string,
			_ string,
			_ http.Handler,
			_ ...func(http.Handler) http.Handler,
		) error {
			publicRouteCount++
			return nil
		},
	); err != nil {
		t.Fatalf("walk public routes: %v", err)
	}
	// The public pair is the attribution surface: a redirect that sets a signed
	// cookie, and the widget that reads it. Both are always mounted; while the
	// gate is closed both answer the stable 503 hold instead of their handlers.
	const wantPublic = 2
	if publicRouteCount != wantPublic {
		t.Fatalf("public referral routes mounted = %d, want %d (gate open: %v)",
			publicRouteCount, wantPublic, OperationalRuntimeAvailable)
	}
	if !OperationalRuntimeAvailable {
		rec := httptest.NewRecorder()
		publicRouter.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/public/r/ABC123", nil))
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), OperationalRuntimeHoldCode) {
			t.Fatalf("held public redirect status=%d body=%q, want 503 carrying %q", rec.Code, rec.Body.String(), OperationalRuntimeHoldCode)
		}
	}
}

func TestSetProgramRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"milestones":[{"count":1,"reward_label":"` + strings.Repeat("a", int(referralJSONMaxBodyBytes)+1) + `"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/referral-programs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	rec := httptest.NewRecorder()
	d.SetProgram(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestSetProgramRejectsInvalidMilestones(t *testing.T) {
	tooMany := make([]Milestone, maxReferralProgramMilestones+1)
	for index := range tooMany {
		tooMany[index] = Milestone{Count: index + 1, RewardLabel: "reward"}
	}
	tooManyBody, err := json.Marshal(map[string]any{"milestones": tooMany})
	if err != nil {
		t.Fatalf("marshal oversized milestone list: %v", err)
	}

	tests := []struct {
		name    string
		body    string
		code    string
		message string
	}{
		{name: "empty list", body: `{"milestones":[]}`, message: "at least one milestone is required"},
		{name: "zero count", body: `{"milestones":[{"count":0,"reward_label":"reward"}]}`, message: "milestone count must be between"},
		{name: "negative count", body: `{"milestones":[{"count":-1,"reward_label":"reward"}]}`, message: "milestone count must be between"},
		{name: "unbounded count", body: fmt.Sprintf(`{"milestones":[{"count":%d,"reward_label":"reward"}]}`, maxReferralMilestoneCount+1), message: "milestone count must be between"},
		{name: "duplicate counts", body: `{"milestones":[{"count":1,"reward_label":"one"},{"count":1,"reward_label":"another"}]}`, message: "milestone counts must be unique"},
		{name: "blank label", body: `{"milestones":[{"count":1,"reward_label":"  "}]}`, message: "milestone reward_label is required"},
		{name: "oversized label", body: `{"milestones":[{"count":1,"reward_label":"` + strings.Repeat("界", maxReferralRewardLabelRunes+1) + `"}]}`, message: "milestone reward_label must be at most"},
		{name: "unsupported milestone reward kind", body: `{"milestones":[{"count":1,"reward_label":"reward","reward_kind":"crypto"}]}`, message: "milestone reward_kind must be one of"},
		{name: "unsupported referee reward kind", body: `{"milestones":[{"count":1,"reward_label":"reward"}],"referee_reward_kind":"crypto"}`, code: "invalid_referee_reward_kind", message: "referee_reward_kind must be one of"},
		{name: "too many milestones", body: string(tooManyBody), message: "milestones must contain at most"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/referral-programs", strings.NewReader(test.body))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
			rec := httptest.NewRecorder()

			(&Deps{}).SetProgram(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			wantCode := test.code
			if wantCode == "" {
				wantCode = "invalid_milestones"
			}
			if !strings.Contains(rec.Body.String(), `"code":"`+wantCode+`"`) ||
				!strings.Contains(rec.Body.String(), test.message) {
				t.Fatalf("body = %s, want stable code and %q", rec.Body.String(), test.message)
			}
		})
	}
}

func TestSetProgramRejectsAmbiguousReplacementPreconditions(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/referral-programs",
		strings.NewReader(`{
			"milestones":[{"count":3,"reward_label":"Tote","reward_kind":"swag"}],
			"expected_program_id":"program-1",
			"expect_no_active_program":true
		}`),
	)
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(
		middleware.WithTenant(
			req.Context(),
			&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"},
		),
	)
	rec := httptest.NewRecorder()

	(&Deps{}).SetProgram(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"invalid_program_precondition"`) {
		t.Fatalf("body = %s, want stable precondition code", rec.Body.String())
	}
}

func TestProgramMilestoneValidationAcceptsBoundariesAndRepoRejectsInvalidInput(t *testing.T) {
	milestones := make([]Milestone, maxReferralProgramMilestones)
	for index := range milestones {
		milestones[index] = Milestone{Count: index + 1, RewardLabel: "reward"}
	}
	milestones[len(milestones)-1].Count = maxReferralMilestoneCount
	milestones[len(milestones)-1].RewardLabel = strings.Repeat("界", maxReferralRewardLabelRunes)
	if err := validateProgramMilestones(milestones); err != nil {
		t.Fatalf("valid boundary milestones rejected: %v", err)
	}

	_, err := (&Repo{}).SetProgramWithOptions(context.Background(), "t1", SetProgramOptions{
		Milestones: []Milestone{{Count: -1, RewardLabel: "reward"}},
	})
	if err == nil || !strings.Contains(err.Error(), "milestone count must be between") {
		t.Fatalf("repository validation error = %v, want invalid count rejection before persistence", err)
	}
}

func TestSafePublicRedirectBase(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"", ""},
		{"https://forms.example.com/base/?token=x#frag", "https://forms.example.com/base"},
		{"http://127.0.0.1:3000/forms/", "http://127.0.0.1:3000/forms"},
		{"http://forms.example.com", ""},
		{"https://user:pass@forms.example.com", ""},
		{"https://forms.example.com/%0d%0aLocation:https://evil.example", ""},
		{"javascript:alert(1)", ""},
	}
	for _, tc := range cases {
		if got := safePublicRedirectBase(tc.raw); got != tc.want {
			t.Fatalf("safePublicRedirectBase(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestAppendPathSegmentEscapesReferralSlug(t *testing.T) {
	got := appendPathSegment("https://forms.example.com/base", "team/a?b")
	want := "https://forms.example.com/base/team%2Fa%3Fb"
	if got != want {
		t.Fatalf("appendPathSegment = %q, want %q", got, want)
	}
}

func TestWritePublicReferralNotFoundUsesJSONNoStore(t *testing.T) {
	rec := httptest.NewRecorder()

	writePublicReferralNotFound(rec)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q, want JSON", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control = %q, want no-store", got)
	}
	if !strings.Contains(rec.Body.String(), "not_found") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
