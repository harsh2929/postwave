// SPDX-License-Identifier: AGPL-3.0-only

// The daily digest: once per local day, at or after Hour in TZ, the whole
// board goes out as one message on EVERY channel.
//
// The single-send guarantee is one atomic UPDATE on the ops_digest_state
// singleton row: whichever replica's claim reports RowsAffected()==1 owns
// today's digest. The claim stands even if every channel send then fails —
// a re-send storm at tick frequency is worse than one missed digest, and
// the push canary owns channel health.
//
// The digest deliberately alerts on nothing. Alerting is the Pusher's job;
// this is the once-a-day "here is everything, including what nobody paged
// you about" — routine reds, late chores, quiet automations, snoozes.

package ops

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

type Digester struct {
	Store    *Store
	State    *PushStateStore
	Channels []Channel
	Hour     int            // local hour (0-23) at/after which today's digest is due
	TZ       *time.Location // the operator's day boundary; nil means UTC
	Logger   *slog.Logger
	Now      func() time.Time // injectable for tests

	// checks overrides the registry for tests; nil means All().
	checks []Check
}

func (d *Digester) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

func (d *Digester) tz() *time.Location {
	if d.TZ != nil {
		return d.TZ
	}
	return time.UTC
}

func (d *Digester) logger() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

func (d *Digester) allChecks() []Check {
	if d.checks != nil {
		return d.checks
	}
	return All()
}

// Tick sends today's digest if it is due and unclaimed. Safe to call at any
// frequency from any number of replicas: before Hour (local) it is a no-op,
// and after it the atomic claim lets exactly one caller per local day through.
func (d *Digester) Tick(ctx context.Context) {
	now := d.now()
	local := now.In(d.tz())
	if local.Hour() < d.Hour {
		return
	}

	claimed, err := d.State.ClaimDigest(ctx, local.Format("2006-01-02"))
	if err != nil {
		d.logger().Error("ops: digest claim failed", "err", err)
		return
	}
	if !claimed {
		return // sent already today, or another replica won the claim
	}

	results, err := d.Store.LoadAll(ctx)
	if err != nil {
		// The claim is burned; today's digest is lost. Deliberate: see the
		// package comment — no re-send storms.
		d.logger().Error("ops: digest could not load results", "err", err)
		return
	}

	msg := PushMessage{
		Kind:  PushDigest,
		Title: "Daily ops digest — " + local.Format("2006-01-02"),
		Body:  BuildDigestBody(BuildBoard(now, d.allChecks(), results)),
	}
	for _, ch := range d.Channels {
		if err := ch.Send(ctx, msg); err != nil {
			d.logger().Error("ops: digest channel failed", "channel", ch.Name(), "err", err)
		}
	}
}

// ClaimDigest atomically claims the digest for day (a local 'YYYY-MM-DD'
// date). True means the caller won and must send; false means someone
// already has — today's date being <= last_sent_on. The row is a singleton
// seeded by migration 1701, so the UPDATE matches at most one row.
func (s *PushStateStore) ClaimDigest(ctx context.Context, day string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE ops_digest_state
		   SET last_sent_on = $1::date, last_sent_at = now()
		 WHERE id AND (last_sent_on IS NULL OR last_sent_on < $1::date)`, day)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// BuildDigestBody renders a board as the digest body. PURE over
// BoardResponse — no DB, no clock — so every rendering rule is testable with
// literals, exactly like BuildBoard itself.
//
// Sections, in fixed order, each listing "Title — Detail" per card; empty
// sections are omitted:
//
//	ON FIRE (n)               — effective-red criticals
//	NEEDS YOU (n)             — other reds and everything due
//	CLOCKS (30d)              — chores due inside the month
//	QUIET (stale automations) — heartbeats that stopped beating (IDs; the
//	                            AUTOMATIONS lane carries no cards)
//	SNOOZED (n)               — with each snooze's reason
//
// When ON FIRE and NEEDS YOU are both empty the digest opens with
// "✓ nothing on fire" — the one line the operator actually reads daily.
// GREEN is deliberately absent: a daily list of fine things trains people
// to skip the message.
func BuildDigestBody(b BoardResponse) string {
	lanes := map[string]Lane{}
	for _, l := range b.Lanes {
		lanes[l.Name] = l
	}
	onFire, needsYou := lanes["ON FIRE"], lanes["NEEDS YOU"]

	var sb strings.Builder
	section := func(header string, lines []string) {
		if len(lines) == 0 {
			return
		}
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString(header + "\n")
		for _, ln := range lines {
			sb.WriteString(ln + "\n")
		}
	}

	if len(onFire.Cards) == 0 && len(needsYou.Cards) == 0 {
		sb.WriteString("✓ nothing on fire\n")
	}

	section(fmt.Sprintf("ON FIRE (%d)", onFire.Count), cardLines(onFire.Cards, nil))
	section(fmt.Sprintf("NEEDS YOU (%d)", needsYou.Count), cardLines(needsYou.Cards, nil))
	section("CLOCKS (30d)", cardLines(lanes["CLOCKS"].Cards, nil))
	section("QUIET (stale automations)", lanes["AUTOMATIONS"].StaleIDs)
	section(fmt.Sprintf("SNOOZED (%d)", lanes["SNOOZED"].Count),
		cardLines(lanes["SNOOZED"].Cards, func(c Card) string {
			if c.AckReason == "" {
				return ""
			}
			return " (" + c.AckReason + ")"
		}))

	return strings.TrimRight(sb.String(), "\n")
}

// cardLines renders "Title — Detail" per card, plus an optional per-card
// suffix (the snooze reason). A card with no detail is just its title — no
// dangling dash.
func cardLines(cards []Card, suffix func(Card) string) []string {
	lines := make([]string, 0, len(cards))
	for _, c := range cards {
		ln := c.Title
		if c.Detail != "" {
			ln += " — " + c.Detail
		}
		if suffix != nil {
			ln += suffix(c)
		}
		lines = append(lines, ln)
	}
	return lines
}
