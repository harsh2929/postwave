// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestPollContentNegotiationPreservesJSONUnlessHTMLIsPreferred(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		accept string
		html   bool
	}{
		{name: "empty keeps API default", accept: "", html: false},
		{name: "wildcard keeps API default", accept: "*/*", html: false},
		{name: "explicit JSON", accept: "application/json", html: false},
		{name: "browser", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", html: true},
		{name: "HTML only", accept: "text/html", html: true},
		{name: "HTML listed first", accept: "text/html,application/json", html: true},
		{name: "JSON listed first", accept: "application/json,text/html", html: false},
		{name: "JSON higher quality", accept: "text/html;q=0.5,application/json;q=0.9", html: false},
		{name: "HTML higher quality", accept: "application/json;q=0.4,text/html;q=0.9", html: true},
		{name: "HTML explicitly refused", accept: "text/html;q=0,*/*;q=0.8", html: false},
		{name: "wildcard outranks HTML", accept: "text/html;q=0.5,*/*;q=0.8", html: false},
		{name: "HTML outranks wildcard", accept: "text/html,*/*;q=0.8", html: true},
		{name: "invalid quality ignored", accept: "text/html;q=not-a-number,application/json", html: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := pollWantsHTML(test.accept); got != test.html {
				t.Fatalf("pollWantsHTML(%q) = %v, want %v", test.accept, got, test.html)
			}
		})
	}
}

func TestPollConfirmationPageIsAccessibleEscapedAndIdentifierFree(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	setBearerResponseHeaders(recorder)
	writePollPage(recorder, http.StatusOK, pollPageData{
		Title:             "Confirm your response · Moosewave",
		Eyebrow:           "Poll response",
		Heading:           "Confirm your response",
		Message:           "Review the selection below before submitting it.",
		Question:          `Where should we meet <script>alert("question")</script>?`,
		OptionLabel:       `North & "west" hall`,
		FormAction:        "?r=opaque-recipient&t=option-token",
		ConfirmationToken: "one-time-challenge",
		ButtonLabel:       "Confirm response",
		Footnote:          "Opening this page did not record a response.",
		Tone:              "preview",
		ShowForm:          true,
	})

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.Contains(contentType, "text/html") {
		t.Fatalf("Content-Type = %q, want HTML", contentType)
	}
	page := recorder.Body.String()
	for _, required := range []string{
		`<html lang="en">`, `aria-labelledby="page-title"`,
		`<form method="post"`, `type="hidden" name="c" value="one-time-challenge"`,
		`<button type="submit">Confirm response</button>`,
		`North &amp; &#34;west&#34; hall`,
	} {
		if !strings.Contains(page, required) {
			t.Errorf("confirmation page omitted %q", required)
		}
	}
	if strings.Contains(page, `<script>`) || strings.Contains(page, `alert("question")`) {
		t.Fatalf("author-controlled markup reached the page unescaped: %s", page)
	}
	for _, forbidden := range []string{
		"reader@example.test",
		"11111111-1111-1111-1111-111111111111",
	} {
		if strings.Contains(page, forbidden) {
			t.Errorf("confirmation page exposed forbidden identifier %q", forbidden)
		}
	}
	for header, required := range map[string]string{
		"Cache-Control":           "no-store",
		"Referrer-Policy":         "no-referrer",
		"Content-Security-Policy": "default-src 'none'",
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"Vary":                    "Accept",
	} {
		if value := recorder.Header().Get(header); !strings.Contains(value, required) {
			t.Errorf("%s = %q, want it to contain %q", header, value, required)
		}
	}
	csp := recorder.Header().Get("Content-Security-Policy")
	for _, directive := range []string{"form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, directive) {
			t.Errorf("CSP %q omitted %q", csp, directive)
		}
	}
}

func TestConfirmationTokenAcceptsExistingQueryAndBoundedBrowserForm(t *testing.T) {
	t.Parallel()
	t.Run("existing query contract", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/poll?c=query-token", nil)
		token, err := confirmationTokenFromRequest(httptest.NewRecorder(), req)
		if err != nil || token != "query-token" {
			t.Fatalf("token=%q err=%v", token, err)
		}
	})
	t.Run("browser form body", func(t *testing.T) {
		body := url.Values{"c": {"form-token"}}.Encode()
		req := httptest.NewRequest(http.MethodPost, "/poll", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		token, err := confirmationTokenFromRequest(httptest.NewRecorder(), req)
		if err != nil || token != "form-token" {
			t.Fatalf("token=%q err=%v", token, err)
		}
	})
	t.Run("query remains authoritative", func(t *testing.T) {
		body := url.Values{"c": {"form-token"}}.Encode()
		req := httptest.NewRequest(http.MethodPost, "/poll?c=query-token", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		token, err := confirmationTokenFromRequest(httptest.NewRecorder(), req)
		if err != nil || token != "query-token" {
			t.Fatalf("token=%q err=%v", token, err)
		}
	})
	t.Run("oversized form fails before repository access", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/poll",
			strings.NewReader("c="+strings.Repeat("x", int(maxConfirmationFormBytes))))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		_, err := confirmationTokenFromRequest(httptest.NewRecorder(), req)
		if !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("oversized form err=%v, want ErrInvalidInput", err)
		}
	})
}

func TestPollResultAndErrorPagesStateExactlyWhatWasCounted(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		state      string
		want       string
		mustNotSay string
	}{
		{state: StateCounted, want: "Your response has been counted."},
		{state: StateMachineExcluded, want: "classified as automated", mustNotSay: "has been counted"},
		{state: StateUnclassifiedExcluded, want: "could not verify", mustNotSay: "has been counted"},
		{state: StateVoidedMultiOption, want: "none of those responses were included", mustNotSay: "has been counted"},
	} {
		t.Run(test.state, func(t *testing.T) {
			page := confirmationResultPage(&ConfirmResult{State: test.state})
			joined := page.Heading + " " + page.Message + " " + page.Detail
			if !strings.Contains(joined, test.want) {
				t.Fatalf("result copy %q omitted %q", joined, test.want)
			}
			if test.mustNotSay != "" && strings.Contains(joined, test.mustNotSay) {
				t.Fatalf("excluded result falsely claimed it was counted: %q", joined)
			}
		})
	}

	status, challenge := publicPollErrorPage(ErrConfirmationRequired)
	if status != http.StatusPreconditionRequired ||
		!strings.Contains(challenge.Heading, "expired or was already used") ||
		!strings.Contains(challenge.Message, "No additional response was recorded") {
		t.Fatalf("challenge error = status %d page %+v", status, challenge)
	}
	status, invalid := publicPollErrorPage(ErrUnknownToken)
	if status != http.StatusNotFound || strings.Contains(invalid.Message+invalid.Detail, "token") {
		t.Fatalf("unknown-token page discloses token state: status %d page %+v", status, invalid)
	}
	status, closed := publicPollErrorPage(ErrPollClosed)
	if status != http.StatusGone || !strings.Contains(closed.Heading, "closed") {
		t.Fatalf("closed page = status %d page %+v", status, closed)
	}
}
