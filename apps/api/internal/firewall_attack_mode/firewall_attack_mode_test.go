package firewall_attack_mode

import "testing"

func TestScore_LegitimateBrowserNoAttackMode(t *testing.T) {
	in := SignupInput{
		BrowserFPPresent:    true,
		UserAgent:           "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Referer:             "https://example.com/newsletter",
		IP:                  "203.0.113.5",
		Rate5m:              1,
		FingerprintRequired: false,
	}
	got := Score(in)
	if got.RiskScore > 10 {
		t.Fatalf("expected low risk for legitimate browser, got %d", got.RiskScore)
	}
}

func TestScore_IframeBotNoFingerprintRequired(t *testing.T) {
	in := SignupInput{
		BrowserFPPresent:    false,
		UserAgent:           "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		Referer:             "",
		IP:                  "203.0.113.6",
		Rate5m:              30,
		FingerprintRequired: false,
	}
	got := Score(in)
	// Even without fingerprint_required, missing referer + high rate
	// should produce a notable score (>= 30).
	if got.RiskScore < 30 {
		t.Fatalf("expected moderate risk, got %d", got.RiskScore)
	}
}

func TestScore_IframeBotFingerprintRequired(t *testing.T) {
	in := SignupInput{
		BrowserFPPresent:    false,
		UserAgent:           "Mozilla/5.0",
		Referer:             "",
		IP:                  "203.0.113.7",
		Rate5m:              100,
		FingerprintRequired: true,
	}
	got := Score(in)
	if got.RiskScore < 80 {
		t.Fatalf("expected very high risk, got %d", got.RiskScore)
	}
}

func TestScore_CurlBotDirect(t *testing.T) {
	in := SignupInput{
		BrowserFPPresent: false,
		UserAgent:        "curl/7.88.0",
		Referer:          "",
		IP:               "203.0.113.8",
		Rate5m:           5,
	}
	got := Score(in)
	if got.RiskScore < 40 {
		t.Fatalf("expected high risk for curl bot, got %d", got.RiskScore)
	}
}

func TestScore_HeadlessBrowser(t *testing.T) {
	in := SignupInput{
		BrowserFPPresent: false,
		UserAgent:        "Mozilla/5.0 (X11) HeadlessChrome/120.0.0.0",
		Referer:          "",
		Rate5m:           0,
	}
	got := Score(in)
	if got.UAQuality > 30 {
		t.Fatalf("expected low UA quality for headless, got %d", got.UAQuality)
	}
}

func TestScore_RangeClamps(t *testing.T) {
	// Worst-possible inputs should clamp at 100.
	in := SignupInput{
		BrowserFPPresent:    false,
		UserAgent:           "",
		Referer:             "",
		Rate5m:              1000,
		FingerprintRequired: true,
	}
	got := Score(in)
	if got.RiskScore < 90 || got.RiskScore > 100 {
		t.Fatalf("expected score near 100, got %d", got.RiskScore)
	}
}

func TestRateRiskAddend_Monotone(t *testing.T) {
	prev := -1
	for _, r := range []int{0, 1, 2, 3, 9, 10, 24, 25, 49, 50, 99, 100, 1000} {
		got := rateRiskAddend(r)
		if got < prev {
			t.Fatalf("rateRiskAddend non-monotonic at rate=%d (got %d, prev %d)", r, got, prev)
		}
		prev = got
	}
}

func TestScoreUA_Buckets(t *testing.T) {
	cases := []struct {
		ua    string
		min   int
		max   int
		descr string
	}{
		{"", 0, 0, "empty"},
		{"curl/7.88.0", 0, 10, "curl"},
		{"Go-http-client/1.1", 0, 10, "go"},
		{"random", 20, 40, "garbage"},
		{"Mozilla/5.0 (X11) Chrome/120.0.0.0 Safari/537.36", 80, 100, "real chrome"},
		{"Mozilla/5.0 X11 HeadlessChrome/120.0.0.0 Safari/537.36", 15, 35, "headless chrome"},
	}
	for _, c := range cases {
		t.Run(c.descr, func(t *testing.T) {
			got := scoreUA(c.ua)
			if got < c.min || got > c.max {
				t.Fatalf("ua=%q got %d, want %d..%d", c.ua, got, c.min, c.max)
			}
		})
	}
}

func TestScoreReferer_Buckets(t *testing.T) {
	cases := []struct {
		ref  string
		want int
	}{
		{"", 0},
		{"https://example.com/page", 100},
		{"http://example.com/page", 60},
		{"weird://thing", 30},
	}
	for _, c := range cases {
		got := scoreReferer(c.ref)
		if got != c.want {
			t.Fatalf("ref=%q got %d, want %d", c.ref, got, c.want)
		}
	}
}
