// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"encoding/json"
	"testing"
	"time"
)

// The board is derived, not read. A check with a stale row must render in a
// red lane even though the DB says 'ok'.
func TestBoard_StaleRowRendersRed(t *testing.T) {
	now := time.Now()
	checks := []Check{{
		ID: "t.stale", Kind: KindEvaluated, Interval: time.Hour,
		Severity: SevCritical, Why: "w", Remediation: "r",
	}}
	results := map[string]Result{
		"t.stale": {Status: StatusOK, LastReportedAt: now.Add(-5 * time.Hour)},
	}

	board := BuildBoard(now, checks, results)

	b, _ := json.Marshal(board)
	if !containsLane(board, "ON FIRE", "t.stale") {
		t.Fatalf("a stale critical check must land in ON FIRE, got %s", b)
	}
}

// A late human is not a broken machine: a due manual chore lands in
// NEEDS YOU, never in ON FIRE.
func TestBoard_DueManualChoreLandsInNeedsYou(t *testing.T) {
	now := time.Now()
	checks := []Check{{
		ID: "t.chore", Kind: KindManual, Cadence: 24 * time.Hour,
		Severity: SevRoutine, Why: "w", Remediation: "r",
	}}
	results := map[string]Result{
		"t.chore": {Status: StatusOK, LastReportedAt: now.Add(-48 * time.Hour)},
	}

	board := BuildBoard(now, checks, results)

	b, _ := json.Marshal(board)
	if !containsLane(board, "NEEDS YOU", "t.chore") {
		t.Fatalf("a due manual chore must land in NEEDS YOU, got %s", b)
	}
	if containsLane(board, "ON FIRE", "t.chore") {
		t.Fatalf("due is not red; the chore must not be in ON FIRE, got %s", b)
	}
}

// Snoozed is not gone: an acked red check leaves ON FIRE / NEEDS YOU but must
// still show in SNOOZED with its reason and expiry.
func TestBoard_SnoozedAppearsOnlyInSnoozed(t *testing.T) {
	now := time.Now()
	until := now.Add(2 * time.Hour)
	checks := []Check{{
		ID: "t.snoozed", Kind: KindEvaluated, Interval: time.Hour,
		Severity: SevCritical, Why: "w", Remediation: "r",
	}}
	results := map[string]Result{
		"t.snoozed": {
			Status: StatusRed, LastReportedAt: now.Add(-10 * time.Minute),
			AckedUntil: &until, AckReason: "vendor maintenance window",
		},
	}

	board := BuildBoard(now, checks, results)

	b, _ := json.Marshal(board)
	if containsLane(board, "ON FIRE", "t.snoozed") || containsLane(board, "NEEDS YOU", "t.snoozed") {
		t.Fatalf("a snoozed check must be excluded from the red lanes, got %s", b)
	}
	if !containsLane(board, "SNOOZED", "t.snoozed") {
		t.Fatalf("a snoozed check must still appear in SNOOZED, got %s", b)
	}
	card, ok := findCard(board, "SNOOZED", "t.snoozed")
	if !ok {
		t.Fatalf("SNOOZED lane has no card for t.snoozed, got %s", b)
	}
	if card.AckReason != "vendor maintenance window" {
		t.Fatalf("SNOOZED card must carry the ack reason, got %q", card.AckReason)
	}
	if card.AckedUntil == nil || !card.AckedUntil.Equal(until) {
		t.Fatalf("SNOOZED card must carry the expiry, got %v", card.AckedUntil)
	}
}

// GREEN is a count plus IDs, and a healthy check appears in neither red lane.
func TestBoard_HealthyCheckCountsGreen(t *testing.T) {
	now := time.Now()
	checks := []Check{{
		ID: "t.fine", Kind: KindEvaluated, Interval: time.Hour,
		Severity: SevHigh, Why: "w", Remediation: "r",
	}}
	results := map[string]Result{
		"t.fine": {Status: StatusOK, LastReportedAt: now.Add(-10 * time.Minute)},
	}

	board := BuildBoard(now, checks, results)

	b, _ := json.Marshal(board)
	if !containsLane(board, "GREEN", "t.fine") {
		t.Fatalf("a healthy check must be listed in GREEN, got %s", b)
	}
	green, ok := laneByName(board, "GREEN")
	if !ok || green.Count != 1 {
		t.Fatalf("GREEN must count healthy checks, got %s", b)
	}
}

// CLOCKS is a calendar: Releases/Vendors chores due inside 30 days, sorted by
// due date. A chore due further out stays off the calendar.
func TestBoard_ClocksSortedAndBounded(t *testing.T) {
	now := time.Now()
	checks := []Check{
		{ID: "t.later", Group: "Releases", Kind: KindManual, Cadence: 20 * 24 * time.Hour,
			Severity: SevRoutine, Why: "w", Remediation: "r"},
		{ID: "t.soon", Group: "Vendors", Kind: KindManual, Cadence: 5 * 24 * time.Hour,
			Severity: SevRoutine, Why: "w", Remediation: "r"},
		{ID: "t.far", Group: "Releases", Kind: KindManual, Cadence: 90 * 24 * time.Hour,
			Severity: SevRoutine, Why: "w", Remediation: "r"},
	}
	results := map[string]Result{
		"t.later": {Status: StatusOK, LastReportedAt: now},
		"t.soon":  {Status: StatusOK, LastReportedAt: now},
		"t.far":   {Status: StatusOK, LastReportedAt: now},
	}

	board := BuildBoard(now, checks, results)

	b, _ := json.Marshal(board)
	clocks, ok := laneByName(board, "CLOCKS")
	if !ok || len(clocks.Cards) != 2 {
		t.Fatalf("CLOCKS must hold exactly the two chores due inside 30d, got %s", b)
	}
	if clocks.Cards[0].ID != "t.soon" || clocks.Cards[1].ID != "t.later" {
		t.Fatalf("CLOCKS must sort by due date, got %s", b)
	}
	if containsLane(board, "CLOCKS", "t.far") {
		t.Fatalf("a chore due in 90d must stay off CLOCKS, got %s", b)
	}
}

// containsLane reports whether the named lane lists the check, either as a
// card or (for GREEN) as a bare ID.
func containsLane(board BoardResponse, lane, checkID string) bool {
	l, ok := laneByName(board, lane)
	if !ok {
		return false
	}
	for _, c := range l.Cards {
		if c.ID == checkID {
			return true
		}
	}
	for _, id := range l.IDs {
		if id == checkID {
			return true
		}
	}
	return false
}

func laneByName(board BoardResponse, name string) (Lane, bool) {
	for _, l := range board.Lanes {
		if l.Name == name {
			return l, true
		}
	}
	return Lane{}, false
}

func findCard(board BoardResponse, lane, checkID string) (Card, bool) {
	l, ok := laneByName(board, lane)
	if !ok {
		return Card{}, false
	}
	for _, c := range l.Cards {
		if c.ID == checkID {
			return c, true
		}
	}
	return Card{}, false
}
