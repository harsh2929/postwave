// SPDX-License-Identifier: AGPL-3.0-only
package service_suite

import "testing"

func TestScoreSpam_ObviousSpamUnknownSender(t *testing.T) {
	msg := Message{
		BodyText: "ACT NOW!!! YOU HAVE WON A CRYPTO GIVEAWAY — CLAIM YOUR PRIZE NOW! " +
			"https://x.test https://y.test https://z.test https://a.test https://b.test " +
			"https://c.test https://d.test https://e.test https://f.test https://g.test https://h.test",
	}
	got := ScoreSpam(msg, false)
	if got.Verdict != "spam" {
		t.Fatalf("verdict = %q (score %d), want spam; signals=%v", got.Verdict, got.Score, got.Signals)
	}
	if got.AssessedBy != "rule" {
		t.Errorf("assessed_by = %q, want rule", got.AssessedBy)
	}
}

func TestScoreSpam_KnownSubscriberNormalMessageIsHam(t *testing.T) {
	msg := Message{BodyText: "Hi, I had a question about my recent order. Could you help? Thanks!"}
	got := ScoreSpam(msg, true)
	if got.Verdict != "ham" {
		t.Fatalf("verdict = %q (score %d), want ham; signals=%v", got.Verdict, got.Score, got.Signals)
	}
}

func TestScoreSpam_KnownSubscriberDampensScore(t *testing.T) {
	// Same borderline body: an unknown sender should score higher than a known
	// subscriber, and the known-subscriber damping should pull it down.
	msg := Message{BodyText: "FREE casino jackpot https://x.test https://y.test https://z.test https://a.test https://b.test"}
	unknown := ScoreSpam(msg, false)
	known := ScoreSpam(msg, true)
	if known.Score >= unknown.Score {
		t.Fatalf("known-subscriber score (%d) should be lower than unknown (%d)", known.Score, unknown.Score)
	}
}

func TestScoreSpam_LinkOnlyShortBody(t *testing.T) {
	msg := Message{BodyText: "click here https://evil.test"}
	got := ScoreSpam(msg, false)
	if _, ok := got.Signals["link_only"]; !ok {
		t.Errorf("expected link_only signal for a short link-only body; signals=%v", got.Signals)
	}
}
