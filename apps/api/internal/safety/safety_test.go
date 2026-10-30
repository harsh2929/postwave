// SPDX-License-Identifier: AGPL-3.0-only
package safety

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// MockLLMClient is a deterministic LLMClient for tests. It returns the
// canned JSON regardless of input — sufficient to exercise the LLM merge
// path without network.
type MockLLMClient struct {
	Response string
	Err      error
	Calls    int
}

func (m *MockLLMClient) Check(_ context.Context, _ string, _ string) (string, error) {
	m.Calls++
	if m.Err != nil {
		return "", m.Err
	}
	return m.Response, nil
}

func newSvcNoLLM() *Service {
	s := NewService(nil)
	s.LLMEnabled = false
	return s
}

func TestStaticRules_MissingUnsubscribeWarn(t *testing.T) {
	s := newSvcNoLLM()
	v, err := s.Check(context.Background(), DraftToCheck{
		Subject:  "Hello",
		BodyText: "this is a routine update with no unsub link",
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if v.Verdict != VerdictWarn {
		t.Errorf("want warn got %s", v.Verdict)
	}
	if !contains(v.Reasons, "missing_unsubscribe_link") {
		t.Errorf("missing reason: %+v", v.Reasons)
	}
}

func TestStaticRules_BannedTermFails(t *testing.T) {
	s := newSvcNoLLM()
	v, err := s.Check(context.Background(), DraftToCheck{
		Subject:                "ok",
		BodyText:               "see my unsubscribe link please. context: phish-pattern-001 example",
		HasListUnsubscribePost: true,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if v.Verdict != VerdictFail {
		t.Errorf("want fail got %s reasons=%v", v.Verdict, v.Reasons)
	}
	if !contains(v.Reasons, "banned_term_present") {
		t.Errorf("missing banned term tag: %+v", v.Reasons)
	}
}

func TestStaticRules_ImageHeavyWarn(t *testing.T) {
	s := newSvcNoLLM()
	html := `<img/><img/><img/><img/><img/><img/><img/><img/><p>unsubscribe link</p>`
	v, _ := s.Check(context.Background(), DraftToCheck{
		Subject:                "weekly",
		BodyHTML:               html,
		HasListUnsubscribePost: true,
	})
	if v.Verdict != VerdictWarn {
		t.Errorf("want warn got %s reasons=%v", v.Verdict, v.Reasons)
	}
	if !contains(v.Reasons, "image_heavy_body") {
		t.Errorf("expected image_heavy_body, got %v", v.Reasons)
	}
}

func TestStaticRules_NonTenantMailtoWarn(t *testing.T) {
	s := newSvcNoLLM()
	html := `<p>contact <a href="mailto:hi@example.org">us</a> &middot; <a href="#">unsubscribe</a></p>`
	v, _ := s.Check(context.Background(), DraftToCheck{
		Subject:                "weekly",
		BodyHTML:               html,
		TenantDomain:           "tenant.test",
		HasListUnsubscribePost: true,
	})
	if !contains(v.Reasons, "non_tenant_mailto_link") {
		t.Errorf("expected non_tenant_mailto_link, got %v", v.Reasons)
	}
}

func TestAUPRules_GamblingFails(t *testing.T) {
	s := newSvcNoLLM()
	v, _ := s.Check(context.Background(), DraftToCheck{
		Subject:                "tonight",
		BodyText:               "join the casino tonight, click unsubscribe to opt out",
		HasListUnsubscribePost: true,
	})
	if v.Verdict != VerdictFail {
		t.Errorf("want fail got %s reasons=%v", v.Verdict, v.Reasons)
	}
	if !contains(v.Reasons, "aup_gambling") {
		t.Errorf("expected aup_gambling tag: %v", v.Reasons)
	}
}

func TestAUPRules_CryptoPromoFails(t *testing.T) {
	s := newSvcNoLLM()
	v, _ := s.Check(context.Background(), DraftToCheck{
		Subject:                "presale alert",
		BodyText:               "join our token launch presale allocation now (unsubscribe)",
		HasListUnsubscribePost: true,
	})
	if !contains(v.Reasons, "aup_crypto_promo") {
		t.Errorf("expected aup_crypto_promo: %v", v.Reasons)
	}
}

func TestAUPRules_PassesNeutralContent(t *testing.T) {
	s := newSvcNoLLM()
	v, _ := s.Check(context.Background(), DraftToCheck{
		Subject:                "Sunday letter",
		BodyText:               "this week I want to share three pricing experiments. unsubscribe link below.",
		HasListUnsubscribePost: true,
	})
	if v.Verdict != VerdictPass {
		t.Errorf("want pass got %s reasons=%v", v.Verdict, v.Reasons)
	}
}

func TestLLMStage_MockUsedAndMerged(t *testing.T) {
	mock := &MockLLMClient{Response: `{"verdict":"warn","reasons":["clickbait_subject"]}`}
	s := NewService(mock)
	s.LLMEnabled = true
	v, err := s.Check(context.Background(), DraftToCheck{
		Subject:                "Sunday letter",
		BodyText:               "neutral content with unsubscribe",
		HasListUnsubscribePost: true,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if mock.Calls != 1 {
		t.Errorf("mock should be called once, got %d", mock.Calls)
	}
	if v.Verdict != VerdictWarn {
		t.Errorf("want warn (from llm), got %s", v.Verdict)
	}
	if !contains(v.Reasons, "clickbait_subject") {
		t.Errorf("expected clickbait_subject merged in: %v", v.Reasons)
	}
}

func TestLLMStage_SkippedWhenDisabled(t *testing.T) {
	mock := &MockLLMClient{Response: `{"verdict":"fail","reasons":["x"]}`}
	s := NewService(mock)
	s.LLMEnabled = false
	v, _ := s.Check(context.Background(), DraftToCheck{
		Subject:                "Sunday letter",
		BodyText:               "unsubscribe link present",
		HasListUnsubscribePost: true,
	})
	if mock.Calls != 0 {
		t.Errorf("mock should NOT be called when disabled, got %d", mock.Calls)
	}
	if v.Verdict != VerdictPass {
		t.Errorf("want pass, got %s", v.Verdict)
	}
}

func TestCache_HitsOnSecondCall(t *testing.T) {
	mock := &MockLLMClient{Response: `{"verdict":"pass","reasons":[]}`}
	s := NewService(mock)
	s.LLMEnabled = true
	d := DraftToCheck{
		Subject: "x", BodyText: "unsubscribe", HasListUnsubscribePost: true,
	}
	_, _ = s.Check(context.Background(), d)
	_, _ = s.Check(context.Background(), d)
	if mock.Calls != 1 {
		t.Errorf("expected cache hit on 2nd call, llm calls=%d", mock.Calls)
	}
}

func TestRubric_NonEmpty(t *testing.T) {
	r := Rubric()
	if len(r) < 100 || !strings.Contains(r, "verdict") {
		t.Errorf("rubric looks malformed: %d bytes", len(r))
	}
}

func TestAnthropicClientPreservesBasePath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if r.Header.Get("x-api-key") != "test-key" {
			t.Fatalf("missing api key")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content": []map[string]string{{"type": "text", "text": `{"verdict":"pass"}`}},
		})
	}))
	defer srv.Close()

	client := NewAnthropicClient("test-key", "claude-test", srv.URL+"/anthropic/")
	got, err := client.Check(context.Background(), "system", "user")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/anthropic/v1/messages" {
		t.Fatalf("path = %q", gotPath)
	}
	if got != `{"verdict":"pass"}` {
		t.Fatalf("response = %q", got)
	}
}

func TestAnthropicClientCapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(anthropicMaxResponseBodyBytes)+1)))
	}))
	defer srv.Close()

	client := NewAnthropicClient("test-key", "claude-test", srv.URL)
	_, err := client.Check(context.Background(), "system", "user")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("Check err = %v, want response body too large", err)
	}
}

func TestAnthropicURLRejectsUnsafeBase(t *testing.T) {
	for _, base := range []string{
		"https://user:pass@api.anthropic.test",
		"https://api.anthropic.test?tenant=one",
		"https://api.anthropic.test#fragment",
		"file:///tmp/anthropic",
	} {
		if _, err := anthropicURL(base, "/v1/messages"); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
	if _, err := anthropicURL("https://api.anthropic.test", "/../messages"); err == nil {
		t.Fatal("expected path traversal to fail")
	}
	for _, path := range []string{"/%2e%2e/messages", "/v1\\messages"} {
		if _, err := anthropicURL("https://api.anthropic.test", path); err == nil {
			t.Fatalf("expected unsafe path %q to fail", path)
		}
	}
}
