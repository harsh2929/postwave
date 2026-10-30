package profile_summary

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestExtractDriversIncludesLastEngagementAndTags(t *testing.T) {
	last := time.Now().Add(-2 * 24 * time.Hour)
	sig := Signals{
		Email:            "alice@example.com",
		Status:           "enabled",
		SubscribedAt:     time.Now().Add(-90 * 24 * time.Hour),
		LastEngagementAt: &last,
		Sent30d:          12,
		Opens30d:         7,
		Clicks30d:        3,
		Replies30d:       1,
		TopTags:          []string{"vip", "us"},
		ConsentState:     "double_optin",
		ChurnScore:       0.42,
		CLVCents:         12500,
		CurrentLifecycle: "active",
	}
	sig.EngagementScore = computeEngagement(sig)
	drivers := ExtractDrivers(sig)

	keys := map[string]string{}
	for _, d := range drivers {
		keys[d.Key] = d.Value
	}
	for _, want := range []string{"last_engagement_at", "events_30d", "top_tags", "consent", "churn_score", "lifecycle"} {
		if _, ok := keys[want]; !ok {
			t.Fatalf("expected driver key %q in result, got %#v", want, keys)
		}
	}
	if !strings.Contains(keys["events_30d"], "12 sent") {
		t.Fatalf("expected events_30d driver to encode counts; got %q", keys["events_30d"])
	}
	if keys["consent"] != "double_optin" {
		t.Fatalf("consent driver should reflect raw state; got %q", keys["consent"])
	}
}

func TestBuildPromptIncludesStructuredSignals(t *testing.T) {
	last := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	sig := Signals{
		Email:            "bob@example.com",
		Status:           "enabled",
		SubscribedAt:     time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		LastEngagementAt: &last,
		Sent30d:          10,
		Opens30d:         4,
		Clicks30d:        2,
		TopTags:          []string{"newsletter"},
		ConsentState:     "single_optin",
		ChurnScore:       0.55,
		CLVCents:         9900,
		CurrentLifecycle: "lapsing",
	}
	drivers := ExtractDrivers(sig)
	p := BuildPrompt(sig, drivers)

	for _, want := range []string{
		"bob@example.com",
		"Status: enabled",
		"Subscribed: 2025-01-01",
		"Last engagement: 2026-05-01",
		"Lifecycle: lapsing",
		"Consent: single_optin",
		"sent=10",
		"opens=4",
		"Top tags: newsletter",
		"Churn risk: 0.55",
		"Historic CLV (USD): 99.00",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("expected prompt to contain %q\nprompt: %s", want, p)
		}
	}
}

func TestTokenizePromptRoundTripsEmail(t *testing.T) {
	prompt := "Subject: alice@example.com\nWrite about alice@example.com."
	tokenized, detok := tokenizePrompt(prompt, "alice@example.com")

	if strings.Contains(tokenized, "alice@example.com") {
		t.Fatalf("tokenized prompt still contains raw email: %s", tokenized)
	}
	if !strings.Contains(tokenized, "@example.invalid") {
		t.Fatalf("tokenized prompt missing placeholder: %s", tokenized)
	}

	llmOut := strings.ReplaceAll(tokenized, "Subject: ", "Summary for ")
	got := detok(llmOut)
	if !strings.Contains(got, "alice@example.com") {
		t.Fatalf("detok should restore real email in LLM output; got %q", got)
	}
}

func TestHashDriversStableUnderReorder(t *testing.T) {
	a := []Driver{
		{Key: "lifecycle", Value: "active"},
		{Key: "consent", Value: "double_optin"},
		{Key: "events_30d", Value: "10 sent"},
	}
	b := []Driver{
		{Key: "consent", Value: "double_optin"},
		{Key: "events_30d", Value: "10 sent"},
		{Key: "lifecycle", Value: "active"},
	}
	if hashDrivers(a) != hashDrivers(b) {
		t.Fatalf("hashDrivers should be order-independent")
	}

	c := []Driver{
		{Key: "lifecycle", Value: "dormant"},
		{Key: "consent", Value: "double_optin"},
		{Key: "events_30d", Value: "10 sent"},
	}
	if hashDrivers(a) == hashDrivers(c) {
		t.Fatalf("hashDrivers should change when a driver value changes")
	}
}

func TestRenderDeterministicProducesNonEmptySummary(t *testing.T) {
	sig := Signals{
		Email:            "carol@example.com",
		Status:           "enabled",
		SubscribedAt:     time.Now().Add(-60 * 24 * time.Hour),
		Sent30d:          5,
		Opens30d:         2,
		Clicks30d:        1,
		TopTags:          []string{"vip"},
		ChurnScore:       0.8,
		CurrentLifecycle: "dormant",
	}
	out := renderDeterministic(sig, ExtractDrivers(sig))
	if out == "" {
		t.Fatal("deterministic renderer returned empty string")
	}
	if !strings.Contains(out, "carol@example.com") {
		t.Fatalf("deterministic summary should reference subject email; got %q", out)
	}
	if !strings.Contains(out, "Churn risk is elevated") {
		t.Fatalf("expected high churn advisory; got %q", out)
	}
}

// stubGen satisfies the Generator interface; tests use it to verify
// the contract without booting the voice service.
type stubGen struct {
	text, model string
	err         error
}

func (s stubGen) Generate(_ context.Context, _, _ string) (string, string, error) {
	return s.text, s.model, s.err
}

func TestGeneratorContract(t *testing.T) {
	var _ Generator = stubGen{}

	g := stubGen{text: "ok", model: "test-model"}
	out, model, err := g.Generate(context.Background(), "tenant", "prompt")
	if err != nil {
		t.Fatal(err)
	}
	if out != "ok" || model != "test-model" {
		t.Fatalf("stub roundtrip failed: %q / %q", out, model)
	}

	gFail := stubGen{err: errors.New("upstream down")}
	if _, _, err := gFail.Generate(context.Background(), "t", "p"); err == nil {
		t.Fatal("expected error from failing stub")
	}
}
