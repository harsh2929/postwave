// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

type fakeTransientPollClassifier struct {
	classification engagementclassification.Classification
	err            error
	seen           engagementclassification.TransientRequestEvidence
}

func (classifier *fakeTransientPollClassifier) ClassifyTransientRequest(
	evidence engagementclassification.TransientRequestEvidence,
) (engagementclassification.ClassificationResult, error) {
	classifier.seen = evidence
	return engagementclassification.ClassificationResult{
		Classification: classifier.classification,
	}, classifier.err
}

func explicitPollBrowserRequest() *http.Request {
	request := httptest.NewRequest(http.MethodPost,
		"https://polls.example.test/api/public/polls/t/p/o?r=r&t=t",
		strings.NewReader("c=one-time"))
	request.RemoteAddr = "203.0.113.9:44321"
	request.Header.Set("User-Agent", "Mozilla/5.0")
	request.Header.Set("Accept", "text/html,application/xhtml+xml")
	request.Header.Set("Accept-Language", "en-US,en;q=0.9")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "https://polls.example.test")
	request.Header.Set("Sec-Fetch-User", "?1")
	request.Header.Set("Sec-Fetch-Mode", "navigate")
	request.Header.Set("Sec-Fetch-Dest", "document")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	return request
}

func testPollRequestClassifier(upstream *fakeTransientPollClassifier) *pollRequestClassifier {
	return &pollRequestClassifier{
		Classifier:   upstream,
		PublicOrigin: &url.URL{Scheme: "https", Host: "polls.example.test"},
	}
}

func TestPollRequestClassifierCountsOnlyExplicitBrowserUnknownAsHuman(t *testing.T) {
	upstream := &fakeTransientPollClassifier{classification: engagementclassification.Unknown}
	classifier := testPollRequestClassifier(upstream)
	request := explicitPollBrowserRequest()
	if got := classifier.ClassifyRequest(request); got.Classification != "human" {
		t.Fatalf("classification = %q, want human", got.Classification)
	}
	if upstream.seen.IP != "203.0.113.9" || upstream.seen.UserAgent != "Mozilla/5.0" ||
		!upstream.seen.HeadersComplete {
		t.Fatalf("F01 request evidence = %+v", upstream.seen)
	}
}

func TestPollRequestClassifierMachineVerdictOverridesBrowserDecision(t *testing.T) {
	upstream := &fakeTransientPollClassifier{classification: engagementclassification.Machine}
	if got := testPollRequestClassifier(upstream).ClassifyRequest(explicitPollBrowserRequest()); got.Classification != "machine" {
		t.Fatalf("classification = %q, want machine", got.Classification)
	}
}

func TestPollRequestClassifierDoesNotPromoteProgrammaticUnknown(t *testing.T) {
	upstream := &fakeTransientPollClassifier{classification: engagementclassification.Unknown}
	request := explicitPollBrowserRequest()
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if got := testPollRequestClassifier(upstream).ClassifyRequest(request); got.Classification != "unknown" {
		t.Fatalf("classification = %q, want unknown", got.Classification)
	}
}

func TestPollRequestClassifierExplicitDecisionContractIsConjunctive(t *testing.T) {
	mutations := map[string]func(*http.Request){
		"no origin":          func(request *http.Request) { request.Header.Del("Origin") },
		"foreign origin":     func(request *http.Request) { request.Header.Set("Origin", "https://attacker.test") },
		"no user activation": func(request *http.Request) { request.Header.Del("Sec-Fetch-User") },
		"cross site":         func(request *http.Request) { request.Header.Set("Sec-Fetch-Site", "cross-site") },
		"not navigation":     func(request *http.Request) { request.Header.Set("Sec-Fetch-Mode", "cors") },
		"not document":       func(request *http.Request) { request.Header.Set("Sec-Fetch-Dest", "empty") },
		"no language":        func(request *http.Request) { request.Header.Del("Accept-Language") },
		"not form":           func(request *http.Request) { request.Header.Set("Content-Type", "application/json") },
		"not html":           func(request *http.Request) { request.Header.Set("Accept", "application/json") },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			upstream := &fakeTransientPollClassifier{classification: engagementclassification.Unknown}
			request := explicitPollBrowserRequest()
			mutate(request)
			if got := testPollRequestClassifier(upstream).ClassifyRequest(request); got.Classification != "unknown" {
				t.Fatalf("classification = %q, want unknown", got.Classification)
			}
		})
	}
}

func TestPollRequestClassifierFailsClosedOnRuntimeError(t *testing.T) {
	upstream := &fakeTransientPollClassifier{
		classification: engagementclassification.Human,
		err:            errors.New("registry unavailable"),
	}
	if got := testPollRequestClassifier(upstream).ClassifyRequest(explicitPollBrowserRequest()); got.Classification != "unknown" || got.ClassifierStatus != "unavailable" {
		t.Fatalf("decision = %+v, want fail-closed unknown/unavailable", got)
	}
}
