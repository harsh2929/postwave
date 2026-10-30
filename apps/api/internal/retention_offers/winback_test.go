// SPDX-License-Identifier: AGPL-3.0-only
//
// winback_test.go — pure tests for the win-back threshold helpers.
// The enrolment SQL path shares LogEvent's DB coverage (DB-skip suite).

package retention_offers

import (
	"context"
	"errors"
	"testing"
)

func TestWinbackDispatchIsReleaseHeldBeforeAnyDependencyAccess(t *testing.T) {
	if WinbackDispatchAvailable {
		t.Fatal("winback dispatch became available without release certification")
	}
	if err := (&WinbackWorker{}).Run(context.Background()); !errors.Is(err, ErrWinbackDispatchUnavailable) {
		t.Fatalf("held worker error = %v", err)
	}
}

func TestNormalizeWinbackThreshold(t *testing.T) {
	t.Parallel()
	if v, err := normalizeWinbackThreshold(0); err != nil || v != defaultWinbackThreshold {
		t.Errorf("zero: got (%v, %v), want default", v, err)
	}
	if v, err := normalizeWinbackThreshold(0.5); err != nil || v != 0.5 {
		t.Errorf("0.5: got (%v, %v)", v, err)
	}
	if v, err := normalizeWinbackThreshold(1); err != nil || v != 1 {
		t.Errorf("1: got (%v, %v)", v, err)
	}
	if _, err := normalizeWinbackThreshold(1.5); err == nil {
		t.Error("1.5: want error")
	}
	if _, err := normalizeWinbackThreshold(-0.1); err == nil {
		t.Error("-0.1: want error")
	}
}

func TestParseWinbackThreshold(t *testing.T) {
	t.Parallel()
	cases := map[string]float64{
		"":     defaultWinbackThreshold,
		"0.5":  0.5,
		"1":    1,
		"0":    defaultWinbackThreshold,
		"2":    defaultWinbackThreshold,
		"-1":   defaultWinbackThreshold,
		"oops": defaultWinbackThreshold,
	}
	for in, want := range cases {
		if got := parseWinbackThreshold(in); got != want {
			t.Errorf("parseWinbackThreshold(%q) = %v, want %v", in, got, want)
		}
	}
}
