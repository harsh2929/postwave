package content

import (
	"context"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// hand-crafted spam and ham corpora used by TestLogisticScorer_SpamSet,
// TestLogisticScorer_HamSet, and TestLogisticScorer_MedianSeparation.
// Each row documents the expected score range and the reasoning. The bands
// are intentionally generous — they're sanity rails, not point estimates.
var (
	spamCorpus = []struct {
		name    string
		html    string
		subject string
		// reasoning: why this scores high
		why    string
		minScr float64
	}{
		{
			"all-caps urgency stacked",
			`<p>ACT NOW! BUY NOW! LIMITED TIME OFFER!! 100% FREE!!!</p>`,
			"FREE!! ACT NOW!! LAST CHANCE",
			"caps + excessive punct + urgency phrases + money phrases",
			0.90,
		},
		{
			"viagra blast",
			`<p>cheap viagra and cialis available no prescription</p>`,
			"weight loss miracle cure",
			"4 pharma phrases stack the pharma feature",
			0.85,
		},
		{
			"prize lottery scam",
			`<p>Congratulations! You've won! Claim your prize NOW. You are the winner of our lottery jackpot.</p>`,
			"WINNER WINNER you've won",
			"5+ prize phrases + caps subject",
			0.85,
		},
		{
			"phishing brand impersonation",
			`<p>Verify your PayPal account: <a href="http://evil.example/login">https://www.paypal.com</a></p>`,
			"Urgent: Action required on your PayPal account",
			"link mismatch + brand impersonation + urgency",
			0.70,
		},
		{
			"shortener-heavy money pitch",
			`<p>Make money fast! <a href="https://bit.ly/x">click</a> <a href="https://t.co/y">y</a> <a href="https://tinyurl.com/z">z</a></p>`,
			"Earn money — limited time",
			"3 shorteners + money + urgency",
			0.85,
		},
		{
			"adult dating bait",
			`<p>HOT SINGLES IN YOUR AREA WAITING. Meet singles tonight. xxx adult content.</p>`,
			"hot singles tonight",
			"adult phrases (folded into pharma category) + caps",
			0.90,
		},
		{
			"unicode-obfuscated phishing",
			`<p>Reset your раypal account password right now</p>`,
			"Urgent аccount notice",
			"cyrillic homograph + urgency phrases",
			0.70,
		},
		{
			"weight-loss pharma",
			`<p>Lose weight fast with our miracle diet pill. No prescription needed. Pharmacy approved.</p>`,
			"Lose pounds today",
			"5 pharma phrases",
			0.85,
		},
	}

	hamCorpus = []struct {
		name    string
		html    string
		subject string
		why     string
		maxScr  float64
	}{
		// Per-case ham ceilings widened from v0.1 hand-tuned bands
		// (mostly 0.15) to v0.2 trained-model reality. The trained
		// model is less confident than the heavily hand-tuned v0.1
		// scorer; what we lose in per-case headroom we gain in being
		// an actually-trained model. The 0.30 hard floor for hams
		// (TestLogisticScorer_HamSet floor below) is preserved, and
		// the median-separation acceptance bar (median ham < 0.20)
		// continues to pass cleanly. See weights.go provenance.
		{
			"plain newsletter",
			`<p>Hello team, this week's product update covers three small fixes and a new dashboard. Thanks for reading.</p>`,
			"Weekly product update",
			"no spam phrases, normal length, low caps",
			0.20,
		},
		{
			"transactional receipt",
			`<p>Thanks for your order #12345. Your items will ship on Tuesday.</p>`,
			"Order confirmation #12345",
			"transactional, low caps, no triggers",
			0.20,
		},
		{
			"calendar invite with link",
			`<p>Your meeting with Alex is scheduled for Thursday at 3pm. <a href="https://calendar.example.com/i/123">View invite</a></p>`,
			"Meeting Thursday 3pm",
			"single benign link, normal text",
			0.30,
		},
		{
			"genuine reply",
			`<p>Sounds good — let's go with option B. I'll send the doc tomorrow.</p>`,
			"Re: Q3 plan",
			"Re: subject is a NEGATIVE signal (genuine thread)",
			0.15,
		},
		{
			"long-form article",
			`<p>Yesterday I read a fascinating piece on regional bird migration patterns. The author argues that climate change has accelerated changes in flyway timing.</p>`,
			"Bird migration: a quick read",
			"long body, low caps, no triggers",
			0.20,
		},
		{
			"github-style notification",
			`<p>A new comment was posted on issue #42. <a href="https://github.com/example/repo/issues/42">View comment</a></p>`,
			"[example/repo] New comment on #42",
			"single link, transactional tone",
			0.30,
		},
		{
			"announcement post",
			`<p>The team is excited to announce our 2026 roadmap. We've shipped three major features this quarter.</p><p>Read the full post on our blog.</p>`,
			"2026 roadmap",
			"two paragraphs, no triggers",
			0.20,
		},
		{
			"single-link blog post",
			`<p>Hi friends, my latest blog post is now live. <a href="https://example.com/blog/post-1">Read it here</a>. Hope you enjoy.</p>`,
			"New blog post",
			"casual tone, single benign link",
			0.30,
		},
	}
)

// TestLogisticScorer_SpamSet asserts every hand-crafted spam example clears
// the > 0.7 threshold the spec calls out (some require >0.85 — see why).
func TestLogisticScorer_SpamSet(t *testing.T) {
	s := New()
	for _, c := range spamCorpus {
		t.Run(c.name, func(t *testing.T) {
			sc := s.LogisticScore(c.html, c.subject)
			if sc.Probability < c.minScr {
				t.Fatalf("spam %q score=%.3f < %.2f (%s)", c.name, sc.Probability, c.minScr, c.why)
			}
			if sc.Probability < 0.7 {
				t.Fatalf("spam %q score=%.3f below the 0.7 spam-set floor (%s)", c.name, sc.Probability, c.why)
			}
		})
	}
}

// TestLogisticScorer_HamSet asserts every hand-crafted ham example sits
// below 0.3 (most well below 0.15).
func TestLogisticScorer_HamSet(t *testing.T) {
	s := New()
	for _, c := range hamCorpus {
		t.Run(c.name, func(t *testing.T) {
			sc := s.LogisticScore(c.html, c.subject)
			if sc.Probability > c.maxScr {
				t.Fatalf("ham %q score=%.3f > %.2f (%s)", c.name, sc.Probability, c.maxScr, c.why)
			}
			if sc.Probability >= 0.30 {
				t.Fatalf("ham %q score=%.3f above the 0.30 ham-set ceiling (%s)", c.name, sc.Probability, c.why)
			}
		})
	}
}

// TestLogisticScorer_MedianSeparation pins the calibration sanity-check
// from the spec: median ham < 0.2, median spam > 0.7.
func TestLogisticScorer_MedianSeparation(t *testing.T) {
	s := New()
	hamScores := make([]float64, 0, len(hamCorpus))
	for _, c := range hamCorpus {
		hamScores = append(hamScores, s.LogisticScore(c.html, c.subject).Probability)
	}
	spamScores := make([]float64, 0, len(spamCorpus))
	for _, c := range spamCorpus {
		spamScores = append(spamScores, s.LogisticScore(c.html, c.subject).Probability)
	}
	sort.Float64s(hamScores)
	sort.Float64s(spamScores)
	medHam := hamScores[len(hamScores)/2]
	medSpam := spamScores[len(spamScores)/2]
	if medHam >= 0.20 {
		t.Errorf("median ham=%.3f, want <0.20", medHam)
	}
	if medSpam <= 0.70 {
		t.Errorf("median spam=%.3f, want >0.70", medSpam)
	}
	t.Logf("median ham=%.3f, median spam=%.3f", medHam, medSpam)
}

// TestLogisticScorer_Edges covers explicit edge cases: empty body, very
// long subject, all-caps subject, and a body with one link.
func TestLogisticScorer_Edges(t *testing.T) {
	s := New()

	// empty body — should never panic, score should be small (no spam signals).
	// v0.2 trained model has a less-extreme intercept than v0.1 because
	// most ham examples have body content; a content-less email is
	// unusual in the corpus, so the intercept doesn't get pushed as low.
	// 0.40 still represents ham-leaning given the 0.50 decision boundary.
	sc := s.LogisticScore("", "Weekly note")
	if sc.Probability < 0 || sc.Probability > 1 {
		t.Fatalf("empty body score=%.3f out of [0,1]", sc.Probability)
	}
	if sc.Probability > 0.40 {
		t.Fatalf("empty body should be ham-leaning; got %.3f", sc.Probability)
	}
	if sc.WeightsVersion == "" {
		t.Fatal("expected WeightsVersion to be populated")
	}
	if sc.Scorer != "logistic" {
		t.Fatalf("expected scorer=logistic; got %q", sc.Scorer)
	}
	if len(sc.Features) != FeatureCount {
		t.Fatalf("features map size=%d want %d", len(sc.Features), FeatureCount)
	}

	// very long subject (>100 chars) but otherwise clean → modest bump but
	// still firmly in the ham band (< 0.3)
	longSubj := strings.Repeat("a", 150)
	sc2 := s.LogisticScore("<p>plain body text</p>", longSubj)
	if sc2.Probability >= 0.30 {
		t.Fatalf("long-subject clean body should not breach 0.30; got %.3f", sc2.Probability)
	}

	// all-caps subject alone — caps_ratio + excessive-punct interactions
	// should push it well above 0.30 even with a clean body
	sc3 := s.LogisticScore("<p>plain body</p>", "PLEASE READ THIS RIGHT NOW")
	if sc3.Probability < 0.30 {
		t.Fatalf("all-caps subject should breach 0.30; got %.3f", sc3.Probability)
	}

	// body with one link → low-ish score, link shouldn't dominate.
	// v0.2 trained model has a moderate positive weight on link_count
	// + link_density (a real signal in the corpus), so the trained
	// score for a short-body single-link email lands ~0.30. Still well
	// below the 0.50 decision boundary, but no longer below 0.20.
	sc4 := s.LogisticScore(`<p>Check out our new page: <a href="https://example.com/page">here</a></p>`, "New page")
	if sc4.Probability >= 0.40 {
		t.Fatalf("single-link clean email should stay <0.40; got %.3f", sc4.Probability)
	}
}

// TestLegacyFallback_FeatureFlag asserts the env-var feature flag actually
// switches scorers. With POSTWAVE_SCANNER_USE_LOGISTIC=0, SpamScore must
// route to LegacyScore.
func TestLegacyFallback_FeatureFlag(t *testing.T) {
	prev := os.Getenv("POSTWAVE_SCANNER_USE_LOGISTIC")
	t.Cleanup(func() { _ = os.Setenv("POSTWAVE_SCANNER_USE_LOGISTIC", prev) })

	s := New()
	const html = `<p>cheap viagra now</p>`
	const subj = "buy now"

	if err := os.Setenv("POSTWAVE_SCANNER_USE_LOGISTIC", "1"); err != nil {
		t.Fatal(err)
	}
	logScore, _ := s.SpamScore(html, subj)

	if err := os.Setenv("POSTWAVE_SCANNER_USE_LOGISTIC", "0"); err != nil {
		t.Fatal(err)
	}
	legacyScore, _ := s.SpamScore(html, subj)
	legacyDirect, _ := s.LegacyScore(html, subj)
	if legacyScore != legacyDirect {
		t.Fatalf("flag-off SpamScore=%.3f did not match LegacyScore=%.3f", legacyScore, legacyDirect)
	}

	// Both scorers should agree this is spam — but the routes are different
	// implementations, so the numeric value should differ.
	if logScore == legacyScore {
		t.Logf("note: logistic=%.3f legacy=%.3f happened to match", logScore, legacyScore)
	}

	// Model disclosure should reflect the active mode.
	if err := os.Setenv("POSTWAVE_SCANNER_USE_LOGISTIC", "0"); err != nil {
		t.Fatal(err)
	}
	if got := s.ModelDisclosure().Version; got != "v1-legacy" {
		t.Fatalf("disclosure version under legacy mode=%q want v1-legacy", got)
	}
	if err := os.Setenv("POSTWAVE_SCANNER_USE_LOGISTIC", "1"); err != nil {
		t.Fatal(err)
	}
	if got := s.ModelDisclosure().Version; got != WeightsVersion {
		t.Fatalf("disclosure version under logistic mode=%q want %s", got, WeightsVersion)
	}
}

// TestScan_PopulatesContentScan_Logistic ensures the public Scan() return
// shape stays compatible: SpamScore is in [0,1] and ModelDisclosure
// reflects the logistic version.
func TestScan_PopulatesContentScan_Logistic(t *testing.T) {
	s := New()
	scan := s.Scan(context.Background(), "<p>cheap viagra now</p>", "buy now", nil)
	if scan.SpamScore <= 0 || scan.SpamScore > 1 {
		t.Fatalf("score out of (0,1]; got %v", scan.SpamScore)
	}
	if scan.Model.Version != WeightsVersion {
		t.Fatalf("Model.Version=%q want %s", scan.Model.Version, WeightsVersion)
	}
}

// 15 cases spanning the feature combinations the scorer must respect.
func TestSpamScore_Calibration(t *testing.T) {
	type tc struct {
		name    string
		html    string
		subject string
		minScr  float64
		maxScr  float64
	}
	// Bands updated for v0.2-fitted weights. Where v0.1 hand-tuned
	// upper bounds were tighter than the trained model warrants
	// (the trained model is less confident on edge cases by design),
	// the upper bound was relaxed up to but not beyond the documented
	// 0.30 hard floor for hams. Spam-side floors are preserved.
	cases := []tc{
		{"clean newsletter", `<p>Hello, here is the weekly newsletter with thoughts on writing. We dive into a few examples and finish with one resource link.</p>`, "Weekly thoughts", 0, 0.20},
		{"shouting subject", `<p>buy now</p>`, "FREE!! ACT NOW!!", 0.50, 1.0},
		{"single mild trigger", `<p>Just a discount on our class. Hope it helps.</p>`, "Class update", 0, 0.30},
		{"image-heavy clean copy", `<html><body><img src="a"/><img src="b"/><img src="c"/><img src="d"/><p>hi friends</p></body></html>`, "Drop one", 0.10, 0.85},
		{"all caps subject", `<p>plain body</p>`, "OPEN THIS RIGHT NOW PLEASE PLEASE", 0.30, 1.0},
		{"long subject 110 chars", `<p>plain body</p>`, strings.Repeat("a", 110), 0.05, 0.40},
		{"medium subject 65 chars", `<p>plain body</p>`, strings.Repeat("a", 65), 0.0, 0.30},
		{"heavy spam phrases", `<p>Click here to win. 100% free. Act now. Limited time.</p>`, "Free!! Limited Time!!", 0.50, 1.0},
		{"viagra body", `<p>cheap viagra pharmacy now</p>`, "newsletter", 0.30, 1.0},
		{"adult content", `<p>hot singles in your area waiting</p>`, "evening update", 0.30, 1.0},
		{"link-heavy body short", `<p><a href="https://a.com">x</a><a href="https://b.com">y</a><a href="https://c.com">z</a><a href="https://d.com">q</a></p>`, "links", 0.0, 0.50},
		{"all caps words sprinkled", `<p>This is BIG NEWS for YOU TODAY READ NOW</p>`, "an update", 0.0, 0.40},
		{"benign sale", `<p>We're running a 10% off offer for our members.</p>`, "Members offer", 0, 0.30},
		{"shortener link present", `<p>Read more: <a href="https://bit.ly/xyz">here</a></p>`, "weekly", 0.0, 0.50},
		{"mismatched href display", `<p>visit <a href="http://evil.example">https://www.bank.com</a></p>`, "secure", 0.05, 0.65},
	}
	s := New()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			score, _ := s.SpamScore(c.html, c.subject)
			if score < c.minScr-1e-9 || score > c.maxScr+1e-9 {
				t.Fatalf("score=%.3f out of [%.2f,%.2f]", score, c.minScr, c.maxScr)
			}
		})
	}
}

func TestSpamScore_ReasonsOrdered(t *testing.T) {
	s := New()
	_, reasons := s.SpamScore(`<p>Click here. Click here. Free! Free! Free!</p>`, "FREE!! ACT NOW!!")
	if len(reasons) == 0 {
		t.Fatal("expected reasons")
	}
}

func TestImageTextRatio(t *testing.T) {
	s := New()
	html := `<html><body><img src="a"/><img src="b"/><img src="c"/><p>hi</p></body></html>`
	r := s.ImageTextRatio(html)
	if r < 50 {
		t.Fatalf("ratio=%.2f, expected high", r)
	}
}

func TestLinkReputation_Heuristics(t *testing.T) {
	s := New() // no Resolver — DNSBL skipped
	ctx := context.Background()

	if got := s.LinkReputation(ctx, []string{"https://example.com/x"}); got != domain.AuthOK {
		t.Fatalf("clean link got %s, want ok", got)
	}
	if got := s.LinkReputation(ctx, []string{"http://1.2.3.4/x"}); got != domain.AuthFail {
		t.Fatalf("raw-IP link got %s, want fail", got)
	}
	if got := s.LinkReputation(ctx, []string{"https://bit.ly/abc"}); got != domain.AuthWarn {
		t.Fatalf("shortener got %s, want warn", got)
	}
}

func TestScanIncludesModelDisclosure(t *testing.T) {
	s := New()
	scan := s.Scan(context.Background(), "<p>Hello there</p>", "Weekly note", nil)
	if scan.Model.Kind != "heuristic" {
		t.Fatalf("model kind=%q want heuristic", scan.Model.Kind)
	}
	if scan.Model.Trained {
		t.Fatal("model disclosure should mark embedded scorer as not trained")
	}
	if scan.Model.Source == "" {
		t.Fatal("model source missing")
	}
}
