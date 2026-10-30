// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"bytes"
	"context"
	"encoding/json"
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type staticRequestClassifier string

var browserConfirmationTokenPattern = regexp.MustCompile(
	`<input type="hidden" name="c" value="([A-Za-z0-9._-]+)">`,
)

func (classification staticRequestClassifier) ClassifyRequest(*http.Request) ClassificationDecision {
	value := string(classification)
	return ClassificationDecision{
		Classification:         value,
		UpstreamClassification: value,
		StableReason:           "R_TEST_CLASSIFICATION",
		ClassifierVersion:      "test-v1",
		MethodologyVersion:     "test-v1",
		RegistryVersion:        "test-v1",
		ConfigurationHash:      strings.Repeat("a", 64),
		ClassifierStatus:       classificationStatusReady,
	}
}

func TestCampaignScopedAuthoringListAndTallyRoutes(t *testing.T) {
	pool := pollsDB(t)
	f := seedSemanticPollCampaign(t, pool)
	repo := testRepo(pool)
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: f.TenantID})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	if err := MountAdminRoutes(AdminRouters{
		ReadCampaigns: router, WriteCampaigns: router, ReadReports: router,
	}, &Deps{Repo: repo}); err != nil {
		t.Fatalf("MountAdminRoutes: %v", err)
	}

	body, _ := json.Marshal(CreateInput{ContentRevisionID: f.RevisionID, PollKey: "venue"})
	create := httptest.NewRecorder()
	router.ServeHTTP(create, httptest.NewRequest(http.MethodPost,
		"/api/v1/campaigns/"+f.CampaignID+"/polls", bytes.NewReader(body)))
	if create.Code != http.StatusCreated {
		t.Fatalf("create=%d body=%s", create.Code, create.Body.String())
	}
	list := httptest.NewRecorder()
	router.ServeHTTP(list, httptest.NewRequest(http.MethodGet,
		"/api/v1/campaigns/"+f.CampaignID+"/polls", nil))
	if list.Code != http.StatusOK || !bytes.Contains(list.Body.Bytes(), []byte(`"poll_key":"venue"`)) {
		t.Fatalf("list=%d body=%s", list.Code, list.Body.String())
	}
	tally := httptest.NewRecorder()
	router.ServeHTTP(tally, httptest.NewRequest(http.MethodGet,
		"/api/v1/campaigns/"+f.CampaignID+"/polls/venue/tally", nil))
	if tally.Code != http.StatusOK || !bytes.Contains(tally.Body.Bytes(), []byte(`"counted":0`)) {
		t.Fatalf("tally=%d body=%s", tally.Code, tally.Body.String())
	}
}

func previewConfirmationURL(t *testing.T, router http.Handler, previewURL string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, previewURL, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET preview = %d, body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Confirm struct {
			URL string `json:"url"`
		} `json:"confirm"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if body.Confirm.URL == "" {
		t.Fatal("preview omitted one-time confirmation URL")
	}
	return body.Confirm.URL
}

func browserConfirmationToken(t *testing.T, body string) string {
	t.Helper()
	match := browserConfirmationTokenPattern.FindStringSubmatch(body)
	if len(match) != 2 {
		t.Fatalf("HTML preview omitted one-time confirmation form token: %s", body)
	}
	return html.UnescapeString(match[1])
}

// The browser representation exercises the same scanner-safe HTTP boundary as
// JSON: navigation is GET-only preview evidence, and the no-JS form is the
// explicit POST that can record a response.
func TestBrowserGETPreviewsAndNoJSPOSTConfirms(t *testing.T) {
	pool := pollsDB(t)
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "opaque-browser-recipient"
	router := chi.NewRouter()
	if err := MountPublicRoutes(router, &Deps{
		Repo: repo, Classifier: staticRequestClassifier("human"),
	}); err != nil {
		t.Fatalf("MountPublicRoutes: %v", err)
	}

	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "north", recipient)
	publicURL := "/api/public/polls/" + f.TenantID + "/" + f.PollKey + "/north" +
		"?r=" + url.QueryEscape(recipient) + "&t=" + url.QueryEscape(token)
	previewRequest := httptest.NewRequest(http.MethodGet, publicURL, nil)
	previewRequest.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
	preview := httptest.NewRecorder()
	router.ServeHTTP(preview, previewRequest)
	if preview.Code != http.StatusOK {
		t.Fatalf("HTML GET = %d, body %s", preview.Code, preview.Body.String())
	}
	if contentType := preview.Header().Get("Content-Type"); !strings.Contains(contentType, "text/html") {
		t.Fatalf("HTML GET Content-Type = %q", contentType)
	}
	page := preview.Body.String()
	for _, required := range []string{
		"Confirm your response", "Which venue?", "north",
		"Opening this page did not record a response", `<form method="post"`,
	} {
		if !strings.Contains(page, required) {
			t.Errorf("HTML GET omitted %q: %s", required, page)
		}
	}
	if strings.Contains(page, f.TenantID) || strings.Contains(page, "reader@example.test") {
		t.Fatalf("HTML body exposed a tenant id or raw email: %s", page)
	}

	tally, err := repo.TallyFor(t.Context(), f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor after HTML GET: %v", err)
	}
	if tally.PreviewedOnly != 0 || tally.SubmissionReceipts != 0 {
		t.Fatalf("side-effect-free HTML GET changed state: %+v", tally)
	}
	for _, option := range tally.Options {
		if option.Counted != 0 {
			t.Fatalf("HTML GET counted %d responses for %s", option.Counted, option.OptionKey)
		}
	}

	challenge := browserConfirmationToken(t, page)
	formBody := url.Values{"c": {challenge}}.Encode()
	confirmRequest := httptest.NewRequest(http.MethodPost, publicURL, strings.NewReader(formBody))
	confirmRequest.Header.Set("Accept", "text/html")
	confirmRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	confirmation := httptest.NewRecorder()
	router.ServeHTTP(confirmation, confirmRequest)
	if confirmation.Code != http.StatusOK {
		t.Fatalf("HTML POST = %d, body %s", confirmation.Code, confirmation.Body.String())
	}
	if body := confirmation.Body.String(); !strings.Contains(body, "Your response has been counted") || strings.Contains(body, `<form`) {
		t.Fatalf("HTML success page did not truthfully finish the flow: %s", body)
	}

	tally, err = repo.TallyFor(t.Context(), f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor after HTML POST: %v", err)
	}
	for _, option := range tally.Options {
		want := 0
		if option.OptionKey == "north" {
			want = 1
		}
		if option.Counted != want {
			t.Errorf("option %s counted %d, want %d", option.OptionKey, option.Counted, want)
		}
	}

	// Replaying the consumed browser form is an idempotent success: it returns
	// the committed outcome and does not create a second immutable receipt.
	replayRequest := httptest.NewRequest(http.MethodPost, publicURL, strings.NewReader(formBody))
	replayRequest.Header.Set("Accept", "text/html")
	replayRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	replay := httptest.NewRecorder()
	router.ServeHTTP(replay, replayRequest)
	if replay.Code != http.StatusOK {
		t.Fatalf("replayed HTML POST = %d, body %s", replay.Code, replay.Body.String())
	}
	if body := replay.Body.String(); !strings.Contains(body, "Your response has been counted") ||
		!strings.Contains(body, "No additional response was created") {
		t.Fatalf("replayed confirmation page is not truthful/idempotent: %s", body)
	}
	tally, err = repo.TallyFor(t.Context(), f.TenantID, f.PollKey)
	if err != nil || tally.SubmissionReceipts != 1 {
		t.Fatalf("idempotent browser replay tally=%+v err=%v", tally, err)
	}
}

// A scanner walking every option URL with GET produces zero votes, THROUGH HTTP.
//
// The repo-level test proved the store behaves; this proves the ROUTE does. The
// two-step mitigation lives entirely at this layer — it is the difference between
// GET and POST — so a correct store behind a route that recorded on GET would be
// no mitigation at all, and the store test could not tell.
func TestAGETOnEveryOptionRecordsNoVotesThroughHTTP(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-reader"

	router := chi.NewRouter()
	if err := MountPublicRoutes(router, &Deps{Repo: repo}); err != nil {
		t.Fatalf("MountPublicRoutes: %v", err)
	}

	for _, option := range f.Options {
		token := mustMintToken(t, repo, f.TenantID, f.PollKey, option, recipient)
		url := "/api/public/polls/" + f.TenantID + "/" + f.PollKey + "/" + option +
			"?r=" + recipient + "&t=" + token
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, body %s", option, rec.Code, rec.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode preview: %v", err)
		}
		if recorded, _ := body["recorded"].(bool); recorded {
			t.Fatalf("the preview response claims a response was recorded for %s", option)
		}
	}

	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	for _, option := range tally.Options {
		if option.Counted != 0 {
			t.Errorf("option %s counted %d votes from a GET; the route records on "+
				"preview and every scanned message produces a tie",
				option.OptionKey, option.Counted)
		}
	}
	if tally.PreviewedOnly != 0 || tally.SubmissionReceipts != 0 {
		t.Errorf("scanner GETs created durable state: %+v", tally)
	}
}

// A POST from the preview page records the vote.
func TestAPOSTRecordsTheVoteThroughHTTP(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-voter"

	router := chi.NewRouter()
	if err := MountPublicRoutes(router, &Deps{
		Repo: repo, Classifier: staticRequestClassifier("human"),
	}); err != nil {
		t.Fatalf("MountPublicRoutes: %v", err)
	}

	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "south", recipient)
	url := "/api/public/polls/" + f.TenantID + "/" + f.PollKey + "/south" +
		"?r=" + recipient + "&t=" + token
	confirmURL := previewConfirmationURL(t, router, url)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, confirmURL, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST = %d, body %s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if counted, _ := body["counted"].(bool); !counted {
		t.Fatalf("a confirmed response was not counted: %s", rec.Body.String())
	}

	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	for _, option := range tally.Options {
		want := 0
		if option.OptionKey == "south" {
			want = 1
		}
		if option.Counted != want {
			t.Errorf("option %s counted %d, want %d", option.OptionKey, option.Counted, want)
		}
	}
}

func TestATwoStepDirectPOSTReturnsPreconditionRequired(t *testing.T) {
	pool := pollsDB(t)
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-direct-post"
	router := chi.NewRouter()
	if err := MountPublicRoutes(router, &Deps{
		Repo: repo, Classifier: staticRequestClassifier("human"),
	}); err != nil {
		t.Fatalf("MountPublicRoutes: %v", err)
	}
	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "south", recipient)
	url := "/api/public/polls/" + f.TenantID + "/" + f.PollKey + "/south" +
		"?r=" + recipient + "&t=" + token
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, url, nil))
	if rec.Code != http.StatusPreconditionRequired {
		t.Fatalf("direct POST=%d body=%s, want 428", rec.Code, rec.Body.String())
	}
}

// An unknown token is a 404, not a 403.
//
// A 403 confirms the poll and option exist, which lets a caller enumerate them. An
// unknown token and an unknown poll are deliberately indistinguishable.
func TestAnUnknownTokenIsNotFoundRatherThanForbidden(t *testing.T) {
	pool := pollsDB(t)
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)

	router := chi.NewRouter()
	if err := MountPublicRoutes(router, &Deps{Repo: repo}); err != nil {
		t.Fatalf("MountPublicRoutes: %v", err)
	}

	url := "/api/public/polls/" + f.TenantID + "/" + f.PollKey + "/north" +
		"?r=recipient-unknown&t=not-a-real-token"
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(method, url, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s with a bad token = %d, want 404 (a 403 would confirm the "+
				"poll exists and let a caller enumerate options)", method, rec.Code)
		}
	}
}

// The multi-option void is reported to the caller, not silently applied.
//
// A recipient whose answers were all discarded deserves to be told. A caller given
// only "ok" cannot distinguish a counted response from one the guard threw away.
func TestTheVoidIsReportedToTheCaller(t *testing.T) {
	pool := pollsDB(t)
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-scanner"

	router := chi.NewRouter()
	if err := MountPublicRoutes(router, &Deps{
		Repo: repo, Classifier: staticRequestClassifier("human"),
	}); err != nil {
		t.Fatalf("MountPublicRoutes: %v", err)
	}

	var last map[string]any
	for _, option := range f.Options {
		token := mustMintToken(t, repo, f.TenantID, f.PollKey, option, recipient)
		url := "/api/public/polls/" + f.TenantID + "/" + f.PollKey + "/" + option +
			"?r=" + recipient + "&t=" + token
		confirmURL := previewConfirmationURL(t, router, url)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, confirmURL, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("POST %s = %d", option, rec.Code)
		}
		last = nil
		if err := json.Unmarshal(rec.Body.Bytes(), &last); err != nil {
			t.Fatalf("decode: %v", err)
		}
	}

	if state, _ := last["state"].(string); state != StateVoidedMultiOption {
		t.Fatalf("final state = %q, want %q — the caller is not told their "+
			"answers were discarded", state, StateVoidedMultiOption)
	}
	if counted, _ := last["counted"].(bool); counted {
		t.Error("a voided response reports counted=true")
	}
}
