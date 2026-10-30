package campaigns

import (
	"strings"
	"testing"
)

// The mailbox-provider bar (Google sender guidelines, verified against
// support.google.com/a/answer/81126):
//
//	0.30% = the hard requirement ceiling. Breaching it makes a sender
//	        ineligible for mitigation until spam rates stay below 0.30%
//	        for 7 consecutive days.
//	0.10% = where measurable inbox-placement harm actually begins.
//
// We model the 7-consecutive-clean-days rule by blocking whenever ANY day
// in the trailing 7-day window breached the ceiling. That gives the unblock
// mechanic for free: once the bad day ages out of the window and all seven
// remaining days are clean, sending resumes on its own. No suspension table,
// no un-suspend job.
func TestEvaluateComplaintWindow(t *testing.T) {
	cases := []struct {
		name      string
		days      []ComplaintDay
		wantBlock bool
		wantWarn  bool
	}{
		{
			name:      "no send history is neither blocked nor warned",
			days:      nil,
			wantBlock: false,
			wantWarn:  false,
		},
		{
			name: "clean sender well under the harm line",
			// 3 complaints / 30000 sends = 0.01%
			days:      repeatDay(7, ComplaintDay{Sends: 5000, Complaints: 0}),
			wantBlock: false,
			wantWarn:  false,
		},
		{
			name: "aggregate above 0.10% warns but does not block",
			// 10 / 5000 = 0.20% on each day: over the 0.10% harm line,
			// under the 0.30% ceiling.
			days:      repeatDay(7, ComplaintDay{Sends: 5000, Complaints: 10}),
			wantBlock: false,
			wantWarn:  true,
		},
		{
			name: "a single day at or above 0.30% blocks the send",
			// 15 / 5000 = 0.30% exactly — the ceiling is inclusive.
			days: append(
				repeatDay(6, ComplaintDay{Sends: 5000, Complaints: 0}),
				ComplaintDay{Sends: 5000, Complaints: 15},
			),
			wantBlock: true,
			wantWarn:  true,
		},
		{
			name: "seven consecutive clean days clear a prior breach",
			// The breach has aged out of the window entirely.
			days:      repeatDay(7, ComplaintDay{Sends: 5000, Complaints: 2}),
			wantBlock: false,
			wantWarn:  false,
		},
		{
			name: "low-volume noise does not block",
			// 1 complaint / 50 sends = 2.00%, but 50 sends is below the
			// noise floor: one unhappy recipient must not gate a tenant.
			days:      []ComplaintDay{{Sends: 50, Complaints: 1}},
			wantBlock: false,
			wantWarn:  false,
		},
		{
			name: "volume above the noise floor is evaluated",
			// 3 / 500 = 0.60%, at the floor exactly.
			days:      []ComplaintDay{{Sends: 500, Complaints: 3}},
			wantBlock: true,
			wantWarn:  true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			block, warn, _ := evaluateComplaintWindow(tc.days)
			if block != tc.wantBlock {
				t.Errorf("block = %v, want %v", block, tc.wantBlock)
			}
			if warn != tc.wantWarn {
				t.Errorf("warn = %v, want %v", warn, tc.wantWarn)
			}
		})
	}
}

func TestEvaluateComplaintWindowReportsWorstDailyRate(t *testing.T) {
	days := []ComplaintDay{
		{Sends: 5000, Complaints: 5},  // 0.10%
		{Sends: 5000, Complaints: 20}, // 0.40%  <- worst
		{Sends: 5000, Complaints: 1},  // 0.02%
		{Sends: 10, Complaints: 10},   // 100%, but below the noise floor
	}
	_, _, worst := evaluateComplaintWindow(days)
	if worst != 0.004 {
		t.Fatalf("worst daily rate = %v, want 0.004 (the 0.40%% day, ignoring sub-floor volume)", worst)
	}
}

func TestApplyComplaintPolicy(t *testing.T) {
	t.Run("a breaching window blocks the send and names the rate", func(t *testing.T) {
		r := &EmailComplianceReport{Ready: true}
		applyComplaintPolicy(r, []ComplaintDay{{Sends: 5000, Complaints: 20}}) // 0.40%

		if r.Ready {
			t.Fatal("report should not be Ready when the complaint ceiling is breached")
		}
		if len(r.Blockers) != 1 {
			t.Fatalf("want exactly 1 blocker, got %d: %v", len(r.Blockers), r.Blockers)
		}
		if !strings.Contains(r.Blockers[0], "0.40%") {
			t.Errorf("blocker should quote the observed rate, got %q", r.Blockers[0])
		}
		if !strings.Contains(r.Blockers[0], "0.30%") {
			t.Errorf("blocker should quote the enforced ceiling, got %q", r.Blockers[0])
		}
	})

	t.Run("a warning window stays sendable but warns", func(t *testing.T) {
		r := &EmailComplianceReport{Ready: true}
		applyComplaintPolicy(r, []ComplaintDay{{Sends: 5000, Complaints: 10}}) // 0.20%

		if !r.Ready {
			t.Fatal("a 0.20% rate is under the ceiling and must not block the send")
		}
		if len(r.Blockers) != 0 {
			t.Fatalf("want no blockers, got %v", r.Blockers)
		}
		if len(r.Warnings) != 1 {
			t.Fatalf("want exactly 1 warning, got %d: %v", len(r.Warnings), r.Warnings)
		}
	})

	t.Run("a clean window adds nothing at all", func(t *testing.T) {
		r := &EmailComplianceReport{Ready: true}
		applyComplaintPolicy(r, []ComplaintDay{{Sends: 5000, Complaints: 1}}) // 0.02%

		if !r.Ready || len(r.Blockers) != 0 || len(r.Warnings) != 0 {
			t.Fatalf("clean sender should be untouched: ready=%v blockers=%v warnings=%v",
				r.Ready, r.Blockers, r.Warnings)
		}
	})
}

func repeatDay(n int, d ComplaintDay) []ComplaintDay {
	out := make([]ComplaintDay, n)
	for i := range out {
		out[i] = d
	}
	return out
}

func TestEmailDomainExtractsAndLowercases(t *testing.T) {
	cases := map[string]string{
		"daisy@Example.COM":                "example.com",
		"  trim@me.io  ":                   "me.io",
		"Display Name <user@brand.app>":    "brand.app",
		"already.lower@host.dev":           "host.dev",
		"no-at-sign":                       "",
		"":                                 "",
		"trailing@":                        "",
		"@no-local":                        "",
		"with.subdomain@mail.shop.example": "mail.shop.example",
	}
	for in, want := range cases {
		if got := emailDomain(in); got != want {
			t.Errorf("emailDomain(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBodyHasUnsubscribe(t *testing.T) {
	cases := []struct {
		name string
		html string
		want bool
	}{
		{"token spaced", `<a href="{{ unsubscribe_url }}">Unsubscribe</a>`, true},
		{"token compact", `<a href="{{unsubscribe_url}}">Leave</a>`, true},
		{"token wide spacing", `<a href="{{   unsubscribe_url	}}">Leave</a>`, true},
		{"listmonk dotted token", `<a href="{{ Unsubscribe.URL }}">Leave</a>`, true},
		{"listmonk function token", `<a href="{{UnsubscribeURL}}">Leave</a>`, true},
		// Every case below reaches recipients with no link that unsubscribes
		// them: the send loop renders nothing into a fixed URL.
		{"fixed link to a foreign host", `<a href="https://moosewave.com/unsubscribe">Unsubscribe</a>`, false},
		{"fixed example link", `<a href="https://example.invalid/unsubscribe">Unsubscribe</a>`, false},
		{"static preferences page", `<a href="/preferences/abc">Manage preferences</a>`, false},
		{"plain prose", `<p>You can unsubscribe any time.</p>`, false},
		{"token name without braces", `<p>unsubscribe_url</p>`, false},
		{"unrelated merge tag", `<a href="{{ unsubscribe }}">Leave</a>`, false},
		{"missing", `<p>Hello there.</p>`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := bodyHasUnsubscribe(tc.html); got != tc.want {
				t.Fatalf("bodyHasUnsubscribe() = %v, want %v", got, tc.want)
			}
		})
	}
}
