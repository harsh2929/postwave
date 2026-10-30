package analytics

import (
	"strings"
	"testing"
	"time"
)

func TestClassifyClient(t *testing.T) {
	cases := []struct {
		ua   string
		want string
	}{
		{"", "Other"},
		{"Mozilla/5.0 GoogleImageProxy", "Gmail"},
		{"Outlook/16.0", "Outlook"},
		{"Microsoft Office/16.0 (Windows NT 10.0)", "Outlook"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Mobile", "Apple Mail"},
		{"Mail/16.0 (Macintosh; Intel Mac OS X)", "Apple Mail"},
		{"YahooMailProxy/1.0", "Yahoo"},
		{"curl/8.4", "Other"},
	}
	for _, c := range cases {
		got := ClassifyClient(c.ua)
		if got != c.want {
			t.Errorf("ClassifyClient(%q) = %q, want %q", c.ua, got, c.want)
		}
	}
}

func TestCSVCellEscapesSpreadsheetFormulaCells(t *testing.T) {
	for _, in := range []string{"=cmd|evil", "+SUM(1,2)", "-1", "@vip"} {
		got := csvCell(in)
		if !strings.HasPrefix(got, "'") {
			t.Fatalf("csvCell(%q) = %q, want leading apostrophe", in, got)
		}
	}
	if got := csvCell("normal"); got != "normal" {
		t.Fatalf("csvCell normal = %q", got)
	}
}

func TestCategorizeBounce(t *testing.T) {
	cases := map[string]string{
		"":            "",
		"hard":        "hard",
		"soft":        "soft",
		"5.1.1":       "hard",
		"4.2.0":       "soft",
		"spam_trap":   "spam_trap",
		"spamtrap":    "spam_trap",
		"trap":        "spam_trap",
		"Hard":        "hard",
		"weird-value": "",
	}
	for in, want := range cases {
		if got := CategorizeBounce(in); got != want {
			t.Errorf("CategorizeBounce(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMetricEventFilter(t *testing.T) {
	retention, err := metricEventFilter("")
	if err != nil {
		t.Fatalf("empty metric should be allowed: %v", err)
	}
	for _, eventType := range []string{"opened", "clicked", "replied"} {
		if !contains(retention, eventType) {
			t.Errorf("retention filter %q omits positive engagement %q", retention, eventType)
		}
	}
	for _, eventType := range []string{"delivered", "bounced", "complained", "unsubscribed"} {
		if contains(retention, eventType) {
			t.Errorf("retention filter %q includes non-engagement %q", retention, eventType)
		}
	}
	if got, _ := metricEventFilter("open_rate"); got == "" || !contains(got, "opened") {
		t.Errorf("open_rate filter wrong: %q", got)
	}
	if got, _ := metricEventFilter("click_rate"); got == "" || !contains(got, "clicked") {
		t.Errorf("click_rate filter wrong: %q", got)
	}
	if _, err := metricEventFilter("nope"); err == nil {
		t.Errorf("expected error for unknown metric")
	}
}

func TestMatureCohortWeekCount(t *testing.T) {
	asOf := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name           string
		latestSignup   time.Time
		requestedWeeks int
		want           int
	}{
		{name: "future signup", latestSignup: asOf.Add(time.Hour), requestedWeeks: 8, want: 0},
		{name: "first week incomplete", latestSignup: asOf.Add(-7*time.Hour*24 + time.Second), requestedWeeks: 8, want: 0},
		{name: "first week exact boundary", latestSignup: asOf.Add(-7 * 24 * time.Hour), requestedWeeks: 8, want: 1},
		{name: "two complete weeks", latestSignup: asOf.Add(-17 * 24 * time.Hour), requestedWeeks: 8, want: 2},
		{name: "requested horizon cap", latestSignup: asOf.Add(-120 * 24 * time.Hour), requestedWeeks: 8, want: 8},
		{name: "non-positive request", latestSignup: asOf.Add(-120 * 24 * time.Hour), requestedWeeks: 0, want: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := matureCohortWeekCount(asOf, tc.latestSignup, tc.requestedWeeks); got != tc.want {
				t.Fatalf("matureCohortWeekCount()=%d, want %d", got, tc.want)
			}
		})
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func TestAttributedAt(t *testing.T) {
	paid := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		opens   []time.Time
		want    time.Time
		matched bool
	}{
		{
			name:    "no opens",
			opens:   nil,
			matched: false,
		},
		{
			name: "open inside window picks most recent",
			opens: []time.Time{
				paid.Add(-6 * 24 * time.Hour),
				paid.Add(-2 * 24 * time.Hour),
				paid.Add(-3 * 24 * time.Hour),
			},
			want:    paid.Add(-2 * 24 * time.Hour),
			matched: true,
		},
		{
			name: "open older than window is ignored",
			opens: []time.Time{
				paid.Add(-30 * 24 * time.Hour),
			},
			matched: false,
		},
		{
			name: "open after payment is ignored",
			opens: []time.Time{
				paid.Add(2 * time.Hour),
			},
			matched: false,
		},
		{
			name: "boundary: exactly 7 days before counts",
			opens: []time.Time{
				paid.Add(-7 * 24 * time.Hour),
			},
			want:    paid.Add(-7 * 24 * time.Hour),
			matched: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := AttributedAt(c.opens, paid, AttributionWindowDays)
			if ok != c.matched {
				t.Fatalf("matched: got %v want %v", ok, c.matched)
			}
			if ok && !got.Equal(c.want) {
				t.Errorf("got %v want %v", got, c.want)
			}
		})
	}
}
