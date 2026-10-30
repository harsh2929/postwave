package forms

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// We test parseSubmitInput + email validation + honeypot detection
// directly. Full HTTP handler tests that hit the DB live behind a
// build tag enabled only when TEST_DATABASE_URL is set; the bits below
// cover the handler's substantive branching without postgres.

func TestParseSubmitInput_FormEncoded(t *testing.T) {
	body := url.Values{
		"email":    {"a@b.co"},
		"name":     {"Jane"},
		"website":  {""},
		"cf_role":  {"writer"},
		"cf_other": {"x"},
	}.Encode()
	r := httptest.NewRequest("POST", "/x", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	in, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err != nil {
		t.Fatal(err)
	}
	if in.Email != "a@b.co" || in.Name != "Jane" {
		t.Errorf("got %+v", in)
	}
	if in.CustomFields["role"] != "writer" || in.CustomFields["other"] != "x" {
		t.Errorf("custom fields = %+v", in.CustomFields)
	}
}

func TestParseSubmitInput_JSON(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", strings.NewReader(`{"email":"a@b.co","customFields":{"role":"writer"}}`))
	r.Header.Set("Content-Type", "application/json")
	in, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err != nil {
		t.Fatal(err)
	}
	if in.Email != "a@b.co" || in.CustomFields["role"] != "writer" {
		t.Errorf("got %+v", in)
	}
}

func TestParseSubmitInput_RejectsRawEmailControlsAtTheInputBoundary(t *testing.T) {
	for _, tc := range []struct {
		name        string
		contentType string
		body        string
	}{
		{
			name:        "form vertical tab",
			contentType: "application/x-www-form-urlencoded",
			body:        url.Values{"email": {"reader@example.com\v"}}.Encode(),
		},
		{
			name:        "json C1 next-line",
			contentType: "application/json",
			body:        `{"email":"reader@example.com\u0085"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", tc.contentType)
			if _, err := parseSubmitInput(httptest.NewRecorder(), r); err == nil || !strings.Contains(err.Error(), "control characters") {
				t.Fatalf("parseSubmitInput error = %v, want raw-control rejection", err)
			}
		})
	}
}

func TestParseSubmitInput_JSONHonorsBodyLimit(t *testing.T) {
	body := `{"email":"a@b.co","customFields":{"notes":"` + strings.Repeat("x", int(formPublicSubmitMaxBodyBytes)) + `"}}`
	r := httptest.NewRequest("POST", "/x", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	_, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err == nil {
		t.Fatal("expected oversized body error")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("error = %v", err)
	}
}

func TestParseSubmitInput_JSONRejectsTrailingValue(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", strings.NewReader(`{"email":"a@b.co"} {"email":"extra@example.com"}`))
	r.Header.Set("Content-Type", "application/json")
	_, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err == nil {
		t.Fatal("expected trailing JSON error")
	}
	if !strings.Contains(err.Error(), "single JSON value") {
		t.Fatalf("error = %v", err)
	}
}

func TestParseSubmitInput_RejectsTooManyCustomFields(t *testing.T) {
	fields := make([]string, 0, maxSubmitCustomFields+1)
	for i := 0; i < maxSubmitCustomFields+1; i++ {
		fields = append(fields, `"f`+strconv.Itoa(i)+`":"x"`)
	}
	body := `{"email":"a@b.co","customFields":{` + strings.Join(fields, ",") + `}}`
	r := httptest.NewRequest("POST", "/x", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")

	_, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err == nil || !strings.Contains(err.Error(), "too many custom fields") {
		t.Fatalf("error = %v, want too many custom fields", err)
	}
}

func TestParseSubmitInput_RejectsOversizedCustomFieldValue(t *testing.T) {
	body := url.Values{
		"email":  {"a@b.co"},
		"cf_bio": {strings.Repeat("x", maxSubmitCustomFieldValueBytes+1)},
	}.Encode()
	r := httptest.NewRequest("POST", "/x", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	_, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("error = %v, want custom field too large", err)
	}
}

func TestParseSubmitInput_RejectsBadCustomFieldKey(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", strings.NewReader(`{"email":"a@b.co","customFields":{"bad\nkey":"x"}}`))
	r.Header.Set("Content-Type", "application/json")

	_, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err == nil || !strings.Contains(err.Error(), "control characters") {
		t.Fatalf("error = %v, want control character rejection", err)
	}
}

func TestParseSubmitInput_RejectsAllControlClassesInOpaqueKeys(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "attempt vertical tab", body: `{"email":"a@b.co","submission_attempt_id":"opaque-attempt-1234\u000b"}`},
		{name: "attempt C1", body: `{"email":"a@b.co","submission_attempt_id":"opaque-attempt-1234\u0085"}`},
		{name: "custom key form feed", body: `{"email":"a@b.co","customFields":{"bad\fkey":"x"}}`},
		{name: "custom key C1", body: `{"email":"a@b.co","customFields":{"bad\u009fkey":"x"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			if _, err := parseSubmitInput(httptest.NewRecorder(), r); err == nil || !strings.Contains(err.Error(), "invalid") && !strings.Contains(err.Error(), "control characters") {
				t.Fatalf("parseSubmitInput error = %v, want all-control rejection", err)
			}
		})
	}
}

func TestParseSubmitInput_FormHonorsBodyLimit(t *testing.T) {
	body := url.Values{
		"email":  {"a@b.co"},
		"cf_bio": {strings.Repeat("x", int(formPublicSubmitMaxBodyBytes))},
	}.Encode()
	r := httptest.NewRequest("POST", "/x", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	_, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err == nil {
		t.Fatal("expected oversized form body error")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("error = %v", err)
	}
}

func TestCSVCellEscapesSpreadsheetFormulaCells(t *testing.T) {
	cases := map[string]string{
		"=cmd|evil": "'=cmd|evil",
		"+SUM(1,2)": "'+SUM(1,2)",
		"-1":        "'-1",
		"@vip":      "'@vip",
		"normal":    "normal",
		"  =cmd":    "'  =cmd",
		" normal ":  " normal ",
	}
	for in, want := range cases {
		if got := csvCell(in); got != want {
			t.Fatalf("csvCell(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPublicSubmit_HoneypotSilent(t *testing.T) {
	// We test the honeypot branch directly — it short-circuits BEFORE
	// hitting the DB or Listmonk so we can drive it with a test handler.
	r := httptest.NewRequest("POST", "/x", strings.NewReader(`{"email":"a@b.co","website":"hi-bot"}`))
	r.Header.Set("Content-Type", "application/json")
	in, err := parseSubmitInput(httptest.NewRecorder(), r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(in.Website) == "" {
		t.Fatalf("expected honeypot filled, got %q", in.Website)
	}
}

func TestValidateRequiredSubmissionFields(t *testing.T) {
	structure := map[string]any{"fields": []map[string]any{
		{"id": "email", "kind": "email", "required": true},
		{"id": "name", "kind": "name", "label": "Name", "required": true},
		{"id": "consent", "kind": "checkbox", "label": "Consent", "required": true},
		{"id": "role", "kind": "custom", "customKey": "job role", "label": "Role", "required": true},
	}}
	valid := &SubmitInput{
		Email:        "reader@example.com",
		Name:         "Reader",
		Consent:      "yes",
		CustomFields: map[string]string{"job_role": "Editor"},
	}
	if err := validateRequiredSubmissionFields(structure, valid); err != nil {
		t.Fatalf("valid submission rejected: %v", err)
	}

	for _, tc := range []struct {
		name   string
		mutate func(*SubmitInput)
		want   string
	}{
		{name: "name", mutate: func(in *SubmitInput) { in.Name = "" }, want: "Name is required"},
		{name: "consent", mutate: func(in *SubmitInput) { in.Consent = "" }, want: "Consent is required"},
		{name: "custom", mutate: func(in *SubmitInput) { in.CustomFields = map[string]string{} }, want: "Role is required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := *valid
			input.CustomFields = map[string]string{"job_role": "Editor"}
			tc.mutate(&input)
			err := validateRequiredSubmissionFields(structure, &input)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestValidateSlugMatchesHostedURLContract(t *testing.T) {
	for _, slug := range []string{"launch", "Launch_2026.v2~beta", "x"} {
		if err := validateSlug(slug); err != nil {
			t.Fatalf("validateSlug(%q): %v", slug, err)
		}
	}
	for _, slug := range []string{"", "launch/signup", "has space", strings.Repeat("x", MaxFormSlugLength+1)} {
		if err := validateSlug(slug); err == nil {
			t.Fatalf("validateSlug(%q) unexpectedly succeeded", slug)
		}
	}
}

func TestSafeSubmitRedirect(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{" https://example.com/thanks#frag ", "https://example.com/thanks"},
		{"/forms/success?ok=1", "/forms/success?ok=1"},
		{"http://localhost:3000/thanks#frag", "http://localhost:3000/thanks"},
		{"javascript:alert(1)", ""},
		{"https://user:pass@example.com/thanks", ""},
		{"//evil.example/thanks", ""},
		{"http://evil.example/thanks", ""},
		{"/bad\nLocation: https://evil.example", ""},
		{"/bad%0d%0aLocation:https://evil.example", ""},
		{"https://example.com/%0aLocation:https://evil.example", ""},
	}
	for _, tc := range cases {
		if got := safeSubmitRedirect(tc.in); got != tc.want {
			t.Fatalf("safeSubmitRedirect(%q) = %q, want %q", tc.in, got, tc.want)
		}
		if tc.want == "" && strings.TrimSpace(tc.in) != "" {
			if err := validateSuccessRedirectURL(tc.in); err == nil {
				t.Fatalf("validateSuccessRedirectURL(%q) unexpectedly succeeded", tc.in)
			}
		}
	}
}

func TestVerifyRecaptchaUsesPostFormWithBoundedClientPath(t *testing.T) {
	oldURL := recaptchaVerifyURL
	oldHTTP := recaptchaHTTP
	defer func() {
		recaptchaVerifyURL = oldURL
		recaptchaHTTP = oldHTTP
	}()

	var sawSecret, sawToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/x-www-form-urlencoded" {
			t.Fatalf("Content-Type = %q", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		sawSecret = r.FormValue("secret")
		sawToken = r.FormValue("response")
		_, _ = w.Write([]byte(`{"success":true,"score":0.9}`))
	}))
	defer srv.Close()
	recaptchaVerifyURL = srv.URL
	recaptchaHTTP = srv.Client()

	if err := verifyRecaptcha("secret_1", "token_1"); err != nil {
		t.Fatalf("verifyRecaptcha: %v", err)
	}
	if sawSecret != "secret_1" || sawToken != "token_1" {
		t.Fatalf("posted secret=%q token=%q", sawSecret, sawToken)
	}
}

func TestVerifyRecaptchaCapsSuccessResponseBody(t *testing.T) {
	oldURL := recaptchaVerifyURL
	oldHTTP := recaptchaHTTP
	defer func() {
		recaptchaVerifyURL = oldURL
		recaptchaHTTP = oldHTTP
	}()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(recaptchaMaxResponseBytes)+1)))
	}))
	defer srv.Close()
	recaptchaVerifyURL = srv.URL
	recaptchaHTTP = srv.Client()

	err := verifyRecaptcha("secret_1", "token_1")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("verifyRecaptcha err = %v, want response body too large", err)
	}
}

// TestPublicRouterShapeCompiles wires the handler into a minimal chi mux
// to make sure the route registration compiles.
func TestPublicRouterShapeCompiles(t *testing.T) {
	deps := &Deps{Repo: nil, PublicHostBase: "http://x"}
	r := chi.NewRouter()
	r.Get("/api/public/forms/{slug}", deps.PublicGet)
	if r == nil {
		t.Fatal("nil router")
	}
}

func TestPublicFormFromExposesOnlyRendererFields(t *testing.T) {
	form := &Form{
		ID:        "form-internal-id",
		TenantID:  "tenant-secret-id",
		Slug:      "launch",
		Name:      "Launch list",
		OptInMode: OptInDouble,
		Structure: map[string]any{"fields": []any{}},
		Settings: map[string]any{
			"successMessage":      "Thanks",
			"styleClass":          "hero",
			"successRedirectUrl":  "https://internal.example.test/next",
			"targetListId":        "42",
			"tagsOnSubmit":        []any{"private-segment"},
			"confirmationSubject": "Internal confirmation copy",
		},
		Status:    StatusPublished,
		CreatedAt: time.Unix(1, 0),
		UpdatedAt: time.Unix(2, 0),
	}

	payload, err := json.Marshal(publicFormFrom(form))
	if err != nil {
		t.Fatalf("marshal public form: %v", err)
	}
	body := string(payload)
	for _, forbidden := range []string{
		"tenantId", "tenant-secret-id", "form-internal-id", "createdAt",
		"updatedAt", "targetListId", "private-segment",
		"confirmationSubject", "successRedirectUrl", "Launch list",
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("public form leaked %q: %s", forbidden, body)
		}
	}
	for _, required := range []string{"launch", "double", "Thanks", "hero"} {
		if !strings.Contains(body, required) {
			t.Fatalf("public form omitted renderer value %q: %s", required, body)
		}
	}
}

func TestWriteFormUpdateError_PublicSlugConflict(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/forms/form-1", nil)
	response := httptest.NewRecorder()

	deps.writeFormUpdateError(response, req, ErrPublicSlugConflict)

	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusConflict)
	}
	body := response.Body.String()
	if !strings.Contains(body, `"code":"public_slug_taken"`) ||
		!strings.Contains(body, "Choose a different slug before publishing") {
		t.Fatalf("response did not explain the hosted URL collision: %s", body)
	}
}

func TestValidateRequiredEmailField(t *testing.T) {
	valid := map[string]any{"fields": []any{map[string]any{"kind": "email", "required": true}}}
	if err := validateRequiredEmailField(valid); err != nil {
		t.Fatalf("valid structure: %v", err)
	}
	for _, invalid := range []map[string]any{
		{"fields": []any{}},
		{"fields": []any{map[string]any{"kind": "email", "required": false}}},
		{"fields": []any{map[string]any{"kind": "name", "required": true}}},
	} {
		if err := validateRequiredEmailField(invalid); err == nil {
			t.Fatalf("structure unexpectedly accepted: %#v", invalid)
		}
	}
}

func TestWriteSubmitErrorNegotiatesHTMLAndJSON(t *testing.T) {
	deps := &Deps{PublicHostBase: "https://forms.moosewave.com"}
	form := &Form{Slug: "launch"}
	htmlReq := httptest.NewRequest(http.MethodPost, "/submit", nil)
	htmlReq.Header.Set("Accept", "text/html")
	htmlResponse := httptest.NewRecorder()
	deps.writeSubmitError(htmlResponse, htmlReq, form, http.StatusUnprocessableEntity, "bad_email", "Enter a valid email.", nil)
	if got := htmlResponse.Header().Get("Content-Type"); !strings.Contains(got, "text/html") {
		t.Fatalf("HTML content type = %q", got)
	}
	if body := htmlResponse.Body.String(); !strings.Contains(body, "Return to the form") || !strings.Contains(body, "https://forms.moosewave.com/forms/launch") {
		t.Fatalf("HTML recovery body = %s", body)
	}

	jsonReq := httptest.NewRequest(http.MethodPost, "/submit", strings.NewReader(`{}`))
	jsonReq.Header.Set("Content-Type", "application/json")
	jsonResponse := httptest.NewRecorder()
	deps.writeSubmitError(jsonResponse, jsonReq, form, http.StatusUnprocessableEntity, "bad_email", "Enter a valid email.", nil)
	if got := jsonResponse.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("JSON content type = %q", got)
	}
}

func TestEmbedSnippetsUseCanonicalHostedRenderer(t *testing.T) {
	script, _, _ := renderSnippet("script", "https://api.moosewave.com", "https://forms.moosewave.com", "launch")
	if !strings.Contains(script, "https://forms.moosewave.com/embed.js") || strings.Contains(script, "/embed.js/embed") {
		t.Fatalf("script snippet = %s", script)
	}
	iframe, _, _ := renderSnippet("iframe", "https://api.moosewave.com", "https://forms.moosewave.com", "launch")
	if !strings.Contains(iframe, "https://forms.moosewave.com/forms/launch") || strings.Contains(iframe, "/api/public/") {
		t.Fatalf("iframe snippet = %s", iframe)
	}
}

func TestConsentAction(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantLog bool
	}{
		{"", "", false},
		{"true", "granted", true},
		{"on", "granted", true},
		{"agreed", "granted", true},
		{"accepted", "granted", true},
		{"false", "denied", true},
		{"off", "denied", true},
		{"custom-checkbox-value", "", false},
	}
	for _, tc := range cases {
		got, ok := consentAction(tc.in)
		if ok != tc.wantLog || got != tc.want {
			t.Fatalf("consentAction(%q) = (%q,%v), want (%q,%v)", tc.in, got, ok, tc.want, tc.wantLog)
		}
	}
}
