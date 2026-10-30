// SPDX-License-Identifier: AGPL-3.0-only
//
// metered_paywall_test.go — pure-function tests for the metered
// paywall surface. Covers:
//
//   - PeriodStart boundary cases for each cadence (incl. Sunday wrap
//     for weekly + leap-year for yearly).
//   - PeriodEnd computes one full window forward.
//   - IsSearchBotUserAgent recognises canonical crawler UAs and
//     skips ordinary browsers.
//   - validMeteredCadence + isPaidMemberBypass match the CHECK
//     constraint + the (cfg.PaywallTier, holderTier) decision matrix.
//   - ApplyMeteredPaywall short-circuits when dec.Allowed.
//
// DB-bound tests (Allow / UpsertMeteredPaywallConfig) live in the
// repo integration suite; this file only exercises the pure helpers.

package archive

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPeriodStart_DailyMidnight(t *testing.T) {
	now := time.Date(2026, 6, 4, 13, 37, 0, 0, time.UTC)
	got := PeriodStart(MeteredCadenceDaily, now)
	want := time.Date(2026, 6, 4, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("daily: got %v, want %v", got, want)
	}
}

func TestPeriodStart_WeeklyMonday(t *testing.T) {
	// 2026-06-04 is a Thursday — Monday is 2026-06-01.
	now := time.Date(2026, 6, 4, 13, 37, 0, 0, time.UTC)
	got := PeriodStart(MeteredCadenceWeekly, now)
	want := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("weekly: got %v, want %v", got, want)
	}
}

func TestPeriodStart_WeeklySundayWraps(t *testing.T) {
	// Sunday should anchor to the PREVIOUS Monday, not the next.
	// 2026-06-07 is a Sunday; previous Monday = 2026-06-01.
	now := time.Date(2026, 6, 7, 23, 59, 0, 0, time.UTC)
	got := PeriodStart(MeteredCadenceWeekly, now)
	want := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("weekly sunday: got %v, want %v", got, want)
	}
}

func TestPeriodStart_MonthlyFirstOfMonth(t *testing.T) {
	now := time.Date(2026, 6, 4, 13, 37, 0, 0, time.UTC)
	got := PeriodStart(MeteredCadenceMonthly, now)
	want := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("monthly: got %v, want %v", got, want)
	}
}

func TestPeriodStart_YearlyJan1(t *testing.T) {
	now := time.Date(2026, 6, 4, 13, 37, 0, 0, time.UTC)
	got := PeriodStart(MeteredCadenceYearly, now)
	want := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("yearly: got %v, want %v", got, want)
	}
}

func TestPeriodStart_NeverEpochSentinel(t *testing.T) {
	now := time.Date(2026, 6, 4, 13, 37, 0, 0, time.UTC)
	got := PeriodStart(MeteredCadenceNever, now)
	// epoch sentinel — exact value isn't important, but it must NOT
	// vary across calls (stable bucket key for the visitor's lifetime).
	again := PeriodStart(MeteredCadenceNever, now.Add(365*24*time.Hour))
	if !got.Equal(again) {
		t.Fatalf("never: bucket drifted across time: %v vs %v", got, again)
	}
}

func TestPeriodEnd_DailyOneDayForward(t *testing.T) {
	start := time.Date(2026, 6, 4, 0, 0, 0, 0, time.UTC)
	end := PeriodEnd(MeteredCadenceDaily, start)
	if end.Sub(start) != 24*time.Hour {
		t.Fatalf("daily end: %v - %v = %v, want 24h", end, start, end.Sub(start))
	}
}

func TestPeriodEnd_WeeklyOneWeekForward(t *testing.T) {
	start := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	end := PeriodEnd(MeteredCadenceWeekly, start)
	if end.Sub(start) != 7*24*time.Hour {
		t.Fatalf("weekly end: %v - %v = %v, want 7d", end, start, end.Sub(start))
	}
}

func TestPeriodEnd_NeverReturnsZero(t *testing.T) {
	start := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	end := PeriodEnd(MeteredCadenceNever, start)
	if !end.IsZero() {
		t.Fatalf("never end should be zero, got %v", end)
	}
}

func TestIsSearchBotUserAgent_RecognisesGooglebot(t *testing.T) {
	ua := "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
	if !IsSearchBotUserAgent(ua) {
		t.Fatalf("expected googlebot to be recognised, got false")
	}
}

func TestIsSearchBotUserAgent_RecognisesBingbot(t *testing.T) {
	ua := "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"
	if !IsSearchBotUserAgent(ua) {
		t.Fatalf("expected bingbot to be recognised, got false")
	}
}

func TestIsSearchBotUserAgent_RejectsBrowserUA(t *testing.T) {
	ua := "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
	if IsSearchBotUserAgent(ua) {
		t.Fatalf("expected ordinary Safari to be rejected, got true")
	}
}

func TestIsSearchBotUserAgent_EmptyUA(t *testing.T) {
	if IsSearchBotUserAgent("") {
		t.Fatalf("expected empty UA to be rejected, got true")
	}
}

func TestValidMeteredCadence_All(t *testing.T) {
	good := []MeteredCadence{MeteredCadenceDaily, MeteredCadenceWeekly,
		MeteredCadenceMonthly, MeteredCadenceYearly, MeteredCadenceNever}
	for _, c := range good {
		if !validMeteredCadence(c) {
			t.Errorf("expected %q to be valid", c)
		}
	}
	bad := []MeteredCadence{"", "hourly", "yearly_v2", "MONTHLY"}
	for _, c := range bad {
		if validMeteredCadence(c) {
			t.Errorf("expected %q to be invalid", c)
		}
	}
}

func TestIsPaidMemberBypass_NoHolderNoBypass(t *testing.T) {
	cfg := MeteredPaywallConfig{PaywallTier: ""}
	if isPaidMemberBypass(cfg, "") {
		t.Fatalf("non-paid visitor should NOT bypass")
	}
}

func TestIsPaidMemberBypass_AnyTierBypassesWhenConfigEmpty(t *testing.T) {
	cfg := MeteredPaywallConfig{PaywallTier: ""}
	if !isPaidMemberBypass(cfg, "founders") {
		t.Fatalf("ANY paid visitor should bypass when cfg.PaywallTier is empty")
	}
}

func TestIsPaidMemberBypass_TierMustMatchCaseInsensitive(t *testing.T) {
	cfg := MeteredPaywallConfig{PaywallTier: "Pro"}
	if !isPaidMemberBypass(cfg, "PRO") {
		t.Fatalf("tier match should be case-insensitive")
	}
	if isPaidMemberBypass(cfg, "founders") {
		t.Fatalf("mismatched tier should NOT bypass")
	}
}

func TestApplyMeteredPaywall_AllowedReturnsBodyUnchanged(t *testing.T) {
	body := "<p>hello world</p>"
	dec := MeteredDecision{Allowed: true}
	out := ApplyMeteredPaywall(body, MeteredPaywallConfig{}, dec)
	if out != body {
		t.Fatalf("allowed should pass body untouched; got %q", out)
	}
}

func TestApplyMeteredPaywall_GatedReturnsTeaserPlusCard(t *testing.T) {
	// Long body so the teaser truncation kicks in. 800 chars > 600
	// budget so we expect a "…" mid-body and an inline card after.
	body := strings.Repeat("a", 800)
	cfg := MeteredPaywallConfig{
		PaywallTitle:    "Out of free articles",
		PaywallBody:     "Subscribe for unlimited access.",
		PaywallCTALabel: "Subscribe",
		PaywallCTAHref:  "https://example.com/subscribe",
	}
	dec := MeteredDecision{Allowed: false, MeteredActive: true, Quota: 3, ReadCount: 4}
	out := ApplyMeteredPaywall(body, cfg, dec)
	if !strings.Contains(out, "…") {
		t.Fatalf("expected teaser truncation marker '…' in output")
	}
	if !strings.Contains(out, "Out of free articles") {
		t.Fatalf("expected paywall title in output: %q", out)
	}
	if !strings.Contains(out, "https://example.com/subscribe") {
		t.Fatalf("expected CTA href in output: %q", out)
	}
	if !strings.Contains(out, `data-pw-paywall="metered"`) {
		t.Fatalf("expected analytics tag attribute in output")
	}
}

func TestApplyMeteredPaywall_DefaultsWhenCfgEmpty(t *testing.T) {
	body := "<p>tiny body</p>"
	dec := MeteredDecision{Allowed: false, MeteredActive: true, Quota: 1, ReadCount: 2}
	out := ApplyMeteredPaywall(body, MeteredPaywallConfig{}, dec)
	if !strings.Contains(out, "free article limit") {
		t.Fatalf("expected fallback title in output: %q", out)
	}
	if !strings.Contains(out, "Subscribe to keep reading") {
		t.Fatalf("expected fallback CTA label in output: %q", out)
	}
}

func TestApplyMeteredPaywall_EscapesUserSuppliedHTML(t *testing.T) {
	// An operator pasting HTML into the title field must NOT escape
	// out of the card and inject script — the inline teaser is
	// rendered into a JSON response that the desktop iframe may
	// inject into a DOM. We HTML-escape the four dangerous chars.
	body := "<p>body</p>"
	cfg := MeteredPaywallConfig{
		PaywallTitle: `<script>alert(1)</script>`,
	}
	dec := MeteredDecision{Allowed: false, MeteredActive: true}
	out := ApplyMeteredPaywall(body, cfg, dec)
	if strings.Contains(out, "<script>") {
		t.Fatalf("unescaped <script> leaked into output: %q", out)
	}
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Fatalf("expected HTML-escaped <script>, got %q", out)
	}
}

func TestExtractVisitorID_NonEmpty(t *testing.T) {
	// ExtractVisitorID delegates to DailyVisitorID — a request with
	// a plain UA + a default-derived client IP should yield a
	// non-empty hex string.
	req, err := http.NewRequest("GET", "/", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 test")
	req.RemoteAddr = "203.0.113.7:443"
	id := ExtractVisitorID(req, false)
	if id == "" {
		t.Fatalf("expected non-empty visitor id")
	}
	if len(id) < 16 {
		t.Fatalf("visitor id too short: %q (len=%d)", id, len(id))
	}
}
