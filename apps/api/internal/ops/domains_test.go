// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"encoding/json"
	"testing"
	"time"
)

// The lying-portfolio problem: a domain nobody wrote a check for contributes
// nothing to the red lanes, so it is indistinguishable from a healthy one.
// The board must be able to say "I am not watching this".
func TestBoard_DomainWithNoCheckIsUnwatched(t *testing.T) {
	now := time.Now()
	domains := []Domain{
		{ID: "sending", Label: "Sending", Why: "mail stops", Owner: "platform"},
		{ID: "billing", Label: "Billing", Why: "money stops", Owner: "founder"},
	}
	checks := []Check{{
		ID: "billing.thing", Domain: "billing", Owner: "founder",
		Kind: KindEvaluated, Interval: time.Hour,
		Severity: SevRoutine, Why: "w", Remediation: "r",
	}}
	results := map[string]Result{
		"billing.thing": {Status: StatusOK, LastReportedAt: now},
	}

	board := buildBoardWith(now, checks, results, domains)

	lane := findLane(board, "UNWATCHED")
	if lane == nil {
		t.Fatal("the board must carry an UNWATCHED lane")
	}
	if lane.Count != 1 {
		b, _ := json.Marshal(board)
		t.Fatalf("sending has no check, so exactly one domain is unwatched; got count=%d %s", lane.Count, b)
	}
	if len(lane.Domains) != 1 || lane.Domains[0].ID != "sending" {
		t.Fatalf("the unwatched domain must be 'sending', got %+v", lane.Domains)
	}
	if lane.Domains[0].Reason != UnwatchedNoCheck {
		t.Fatalf("reason must be %q, got %q", UnwatchedNoCheck, lane.Domains[0].Reason)
	}
}

// A domain covered only by checks that cannot run is not covered. Reporting it
// as watched would be the same lie in a different costume.
func TestBoard_DomainCoveredOnlyByBlockedChecksIsUnwatched(t *testing.T) {
	now := time.Now()
	domains := []Domain{{ID: "sms", Label: "SMS", Why: "texts stop", Owner: "ops"}}
	checks := []Check{{
		ID: "sms.a2p", Domain: "sms", Owner: "ops",
		Kind: KindEvaluated, Interval: time.Hour,
		Severity: SevHigh, Why: "w", Remediation: "r",
		Blocked: &BlockedMeta{Reason: "A2P/10DLC registration not filed", Owner: "ops"},
	}}

	board := buildBoardWith(now, checks, map[string]Result{}, domains)

	lane := findLane(board, "UNWATCHED")
	if lane == nil || lane.Count != 1 {
		b, _ := json.Marshal(board)
		t.Fatalf("a domain whose only check is blocked is unwatched; got %s", b)
	}
	if lane.Domains[0].Reason != UnwatchedAllBlocked {
		t.Fatalf("reason must be %q, got %q", UnwatchedAllBlocked, lane.Domains[0].Reason)
	}
}

// Blocked is not broken. A check waiting on a purchase order must never sit in
// ON FIRE, or the team learns to snooze the fire lane.
func TestBoard_BlockedCheckIsNotOnFire(t *testing.T) {
	now := time.Now()
	checks := []Check{{
		ID: "ses.production-access", Domain: "sending", Owner: "founder",
		Kind: KindEvaluated, Interval: time.Hour,
		Severity: SevCritical, Why: "w", Remediation: "r",
		Blocked: &BlockedMeta{Reason: "SES production access denied in eu-north-1", Owner: "founder"},
	}}
	results := map[string]Result{
		"ses.production-access": {Status: StatusRed, LastReportedAt: now},
	}

	board := buildBoardWith(now, checks, results,
		[]Domain{{ID: "sending", Label: "Sending", Why: "w", Owner: "platform"}})

	b, _ := json.Marshal(board)
	if containsLane(board, "ON FIRE", "ses.production-access") {
		t.Fatalf("a blocked check has no engineering fix; it must not be in ON FIRE: %s", b)
	}
	if !containsLane(board, "BLOCKED", "ses.production-access") {
		t.Fatalf("a blocked check must be visible in BLOCKED: %s", b)
	}
	if containsLane(board, "GREEN", "ses.production-access") {
		t.Fatalf("blocked is not green: %s", b)
	}
}

// Effective must be a pure function of the check and the clock, and Blocked is
// declared on the check — so a blocked check reads blocked even if a stale row
// would otherwise derive to red.
func TestEffective_BlockedOverridesStaleness(t *testing.T) {
	c := Check{
		ID: "x", Kind: KindEvaluated, Interval: time.Minute,
		Blocked: &BlockedMeta{Reason: "no vendor account", Owner: "ops"},
	}
	r := Result{Status: StatusOK, LastReportedAt: time.Now().Add(-10 * time.Hour)}

	if got := r.Effective(time.Now(), c); got != StatusBlocked {
		t.Fatalf("a blocked check derives to %q, got %q", StatusBlocked, got)
	}
}

func TestStatusBlocked_IsNotRed(t *testing.T) {
	if StatusBlocked.IsRed() {
		t.Fatal("blocked must not count as red: it has no engineering remediation")
	}
}

// A check pointing at a domain nobody declared is a typo that would silently
// stop counting toward coverage.
func TestValidateRegistry_RejectsUnknownDomain(t *testing.T) {
	err := validateRegistry(
		[]Check{{ID: "a.b", Domain: "nope", Owner: "o", Kind: KindEvaluated, Interval: time.Hour, Why: "w", Remediation: "r"}},
		[]Domain{{ID: "real", Label: "Real", Why: "w", Owner: "o"}},
		true,
	)
	if err == nil {
		t.Fatal("a check naming an unregistered domain must fail validation")
	}
}

func TestRegisterDomain_RejectsIncomplete(t *testing.T) {
	for _, d := range []Domain{
		{Label: "L", Why: "w", Owner: "o"},
		{ID: "i", Why: "w", Owner: "o"},
		{ID: "i", Label: "L", Owner: "o"},
		{ID: "i", Label: "L", Why: "w"},
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("an incomplete domain must panic at registration: %+v", d)
				}
			}()
			RegisterDomain(d)
		}()
	}
}

// findLane returns the named lane, or nil. Tests assert on lane CONTENT, so a
// missing lane must be distinguishable from an empty one.
func findLane(b BoardResponse, name string) *Lane {
	for i := range b.Lanes {
		if b.Lanes[i].Name == name {
			return &b.Lanes[i]
		}
	}
	return nil
}

// Coverage must be counted by the API, not derived by the console. The GREEN
// lane carries IDs rather than cards, so a domain watched ONLY by a passing
// check is invisible to any client-side scan of card domains — it would be
// silently counted as unwatched, understating coverage and, worse, teaching
// the team the number is approximate.
func TestBoard_CoverageCountsDomainsWatchedOnlyByGreenChecks(t *testing.T) {
	now := time.Now()
	domains := []Domain{
		{ID: "sending", Label: "Sending", Why: "w", Owner: "platform"},
		{ID: "billing", Label: "Billing", Why: "w", Owner: "founder"},
		{ID: "growth", Label: "Growth", Why: "w", Owner: "growth"},
	}
	checks := []Check{
		{ID: "sending.ok", Domain: "sending", Owner: "platform", Kind: KindEvaluated,
			Interval: time.Hour, Severity: SevRoutine, Why: "w", Remediation: "r"},
		{ID: "billing.bad", Domain: "billing", Owner: "founder", Kind: KindEvaluated,
			Interval: time.Hour, Severity: SevCritical, Why: "w", Remediation: "r"},
	}
	results := map[string]Result{
		"sending.ok":  {Status: StatusOK, LastReportedAt: now},
		"billing.bad": {Status: StatusRed, LastReportedAt: now},
	}

	board := buildBoardWith(now, checks, results, domains)

	if board.Coverage.Declared != 3 {
		t.Fatalf("three domains are declared, got %d", board.Coverage.Declared)
	}
	// sending is green (its check only appears as an ID), billing is on fire.
	if board.Coverage.Watched != 2 {
		t.Fatalf("sending and billing are both watched; got watched=%d", board.Coverage.Watched)
	}
	if got := findLane(board, "GREEN"); got == nil || len(got.IDs) != 1 || got.IDs[0] != "sending.ok" {
		t.Fatalf("precondition: sending.ok must be a bare ID in GREEN, got %+v", got)
	}
}

// A blocked check does not make its domain watched, and the coverage numbers
// must agree with the UNWATCHED lane rather than telling a second story.
func TestBoard_CoverageAgreesWithUnwatchedLane(t *testing.T) {
	now := time.Now()
	domains := []Domain{
		{ID: "sms", Label: "SMS", Why: "w", Owner: "ops"},
		{ID: "billing", Label: "Billing", Why: "w", Owner: "founder"},
	}
	checks := []Check{
		{ID: "sms.a2p", Domain: "sms", Owner: "ops", Kind: KindEvaluated,
			Interval: time.Hour, Severity: SevHigh, Why: "w", Remediation: "r",
			Blocked: &BlockedMeta{Reason: "10DLC not filed", Owner: "ops"}},
	}

	board := buildBoardWith(now, checks, map[string]Result{}, domains)

	lane := findLane(board, "UNWATCHED")
	if lane == nil {
		t.Fatal("UNWATCHED lane missing")
	}
	if board.Coverage.Declared-board.Coverage.Watched != lane.Count {
		t.Fatalf("coverage and the UNWATCHED lane must be the same arithmetic: declared=%d watched=%d lane=%d",
			board.Coverage.Declared, board.Coverage.Watched, lane.Count)
	}
	if board.Coverage.Watched != 0 {
		t.Fatalf("a blocked check watches nothing; got watched=%d", board.Coverage.Watched)
	}
}

// CLOCKS was gated on Group being "Releases" or "Vendors" — two groups no
// check has ever used — so the lane was dead by construction and rendered 0
// next to a "time-based" label. A recurring obligation is a recurring
// obligation whatever group it files under; the KIND is what makes it a
// calendar item.
func TestBoard_ManualChoreAppearsInClocksRegardlessOfGroup(t *testing.T) {
	now := time.Now()
	domains := []Domain{{ID: "compliance", Label: "Compliance", Why: "w", Owner: "legal"}}
	checks := []Check{{
		ID: "compliance.register-review", Domain: "compliance", Owner: "legal",
		Group: "Legal", Kind: KindManual, Cadence: 90 * 24 * time.Hour,
		Severity: SevHigh, Why: "w", Remediation: "r",
	}}
	results := map[string]Result{
		"compliance.register-review": {Status: StatusOK, LastReportedAt: now.Add(-80 * 24 * time.Hour)},
	}

	board := buildBoardWith(now, checks, results, domains)

	if !containsLane(board, "CLOCKS", "compliance.register-review") {
		b, _ := json.Marshal(board)
		t.Fatalf("a manual chore due inside the horizon belongs in CLOCKS: %s", b)
	}
	lane := findLane(board, "CLOCKS")
	if lane.Cards[0].DueAt == nil {
		t.Fatal("a CLOCKS card must carry the date it is due")
	}
}

// The horizon still bounds the lane: a chore due in a year is not this
// quarter's problem and would crowd out the ones that are.
func TestBoard_ChoreBeyondTheHorizonStaysOutOfClocks(t *testing.T) {
	now := time.Now()
	checks := []Check{{
		ID: "legal.counsel-review", Domain: "compliance", Owner: "legal",
		Kind: KindManual, Cadence: 365 * 24 * time.Hour,
		Severity: SevRoutine, Why: "w", Remediation: "r",
	}}
	results := map[string]Result{
		"legal.counsel-review": {Status: StatusOK, LastReportedAt: now},
	}

	board := buildBoardWith(now, checks, results,
		[]Domain{{ID: "compliance", Label: "C", Why: "w", Owner: "legal"}})

	if containsLane(board, "CLOCKS", "legal.counsel-review") {
		t.Fatal("a chore due in a year must not crowd this month's calendar")
	}
}

// A blocked chore has no meaningful due date — nobody can do it — so it must
// not appear on the calendar competing with work that can actually be done.
func TestBoard_BlockedChoreIsNotOnTheCalendar(t *testing.T) {
	now := time.Now()
	checks := []Check{{
		ID: "compliance.art27-representative", Domain: "compliance", Owner: "legal",
		Kind: KindManual, Cadence: 30 * 24 * time.Hour,
		Severity: SevCritical, Why: "w", Remediation: "r",
		Blocked: &BlockedMeta{Reason: "no Art. 27 representative appointed", Owner: "founder/counsel"},
	}}

	board := buildBoardWith(now, checks, map[string]Result{},
		[]Domain{{ID: "compliance", Label: "C", Why: "w", Owner: "legal"}})

	if containsLane(board, "CLOCKS", "compliance.art27-representative") {
		t.Fatal("a blocked chore is not a calendar item; it is a BLOCKED row")
	}
	if !containsLane(board, "BLOCKED", "compliance.art27-representative") {
		t.Fatal("the blocked chore must still be visible in BLOCKED")
	}
}
