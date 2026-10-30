// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — the board.
//
// BuildBoard is a PURE function of (now, checks, results): no DB, no clock,
// no registry read. Every lane assignment — including staleness, which is
// derived via Result.Effective — is therefore testable with three literals.
// The handler is the thin part: load, build, encode.

package ops

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"
)

// clocksHorizon bounds the CLOCKS lane: a chore due further out than this is
// not yet a calendar concern.
const clocksHorizon = 30 * 24 * time.Hour

// Card is one check as rendered on the board. Status is the EFFECTIVE status
// (staleness derived at read time), never the raw persisted one.
type Card struct {
	ID          string     `json:"id"`
	Group       string     `json:"group,omitempty"`
	Title       string     `json:"title,omitempty"`
	Why         string     `json:"why"`
	Kind        string     `json:"kind"`
	Severity    string     `json:"severity"`
	Status      string     `json:"status"`
	Detail      string     `json:"detail,omitempty"`
	Remediation string     `json:"remediation"`
	Runbook     string     `json:"runbook,omitempty"`
	Domain      string     `json:"domain,omitempty"`
	Owner       string     `json:"owner,omitempty"`
	LastOKAt    *time.Time `json:"last_ok_at,omitempty"`
	FirstRedAt  *time.Time `json:"first_red_at,omitempty"`
	DueAt       *time.Time `json:"due_at,omitempty"`
	AckedUntil  *time.Time `json:"acked_until,omitempty"`
	AckReason   string     `json:"ack_reason,omitempty"`

	// Action is the check's button, verbatim from the registry. The board
	// renders it; POST /checks/{id}/action executes it.
	Action *ActionMeta `json:"action,omitempty"`

	// Blocked is the external blocker, verbatim from the registry, when this
	// card is in the BLOCKED lane.
	Blocked *BlockedMeta `json:"blocked,omitempty"`
}

// Lane is one column of the board. Card lanes carry Cards; AUTOMATIONS is an
// alive/stale summary plus the stale IDs; GREEN is a count plus IDs.
type Lane struct {
	Name  string `json:"name"`
	Cards []Card `json:"cards,omitempty"`
	Count int    `json:"count"`

	// AUTOMATIONS only.
	Alive    int      `json:"alive,omitempty"`
	Stale    int      `json:"stale,omitempty"`
	StaleIDs []string `json:"stale_ids,omitempty"`

	// GREEN only.
	IDs []string `json:"ids,omitempty"`

	// UNWATCHED only: the declared coverage surfaces nothing can report on.
	Domains []UnwatchedDomain `json:"domains,omitempty"`
}

type BoardResponse struct {
	GeneratedAt time.Time `json:"generated_at"`
	Lanes       []Lane    `json:"lanes"`

	// Coverage qualifies every other number in Lanes. See ops.Coverage.
	Coverage Coverage `json:"coverage"`
}

// BuildBoard assigns every check to its lane. Lanes, in fixed order:
//
//	ON FIRE     — effective red AND critical
//	NEEDS YOU   — effective red, non-critical; plus everything due
//	BLOCKED     — checks that cannot run for a reason no engineer can fix
//	UNWATCHED   — declared coverage surfaces nothing can report on
//	CLOCKS      — Releases/Vendors chores due inside 30d, sorted by date
//	AUTOMATIONS — all heartbeats, as an alive/stale count plus stale IDs
//	SNOOZED     — AckedUntil in the future, with reason and expiry
//	GREEN       — everything else, as a count plus IDs
//
// A snoozed check is EXCLUDED from ON FIRE / NEEDS YOU but still appears in
// SNOOZED with its reason. Snoozed is not gone.
//
// BLOCKED and UNWATCHED are the two lanes that make the board a source of
// TRUTH rather than a source of signals. Without them the board can only speak
// about what it happens to watch, and silence about everything else is
// indistinguishable from health. BLOCKED says "this is known-unwatchable and
// here is who can change that"; UNWATCHED says "this surface is declared and
// nothing is looking at it".
//
// A check with no result row gets the zero Result, whose zero LastReportedAt
// derives to stale/due — correct: a check that has never reported is not a
// check that is fine.
func BuildBoard(now time.Time, checks []Check, results map[string]Result) BoardResponse {
	return buildBoardWith(now, checks, results, AllDomains())
}

func buildBoardWith(now time.Time, checks []Check, results map[string]Result, domains []Domain) BoardResponse {
	var (
		onFire, needsYou, clocks, snoozed, blocked []Card

		alive, stale int
		staleIDs     []string
		greenIDs     []string
	)

	for _, c := range checks {
		res := results[c.ID]
		eff := res.Effective(now, c)
		isSnoozed := res.AckedUntil != nil && res.AckedUntil.After(now)
		card := buildCard(c, res, eff)

		// Blocked is terminal. A blocked check is not probed, so counting it
		// as a live heartbeat or a due chore would fabricate coverage it does
		// not provide; it belongs in exactly one lane, addressed to the person
		// who can clear the blocker.
		if c.Blocked != nil {
			blocked = append(blocked, card)
			continue
		}

		// AUTOMATIONS summarizes every heartbeat regardless of the other
		// lanes: "stale" is about the beat (silence), not the reported
		// status — a heartbeat that reports red is alive AND on fire.
		if c.Kind == KindHeartbeat {
			if eff == StatusStale {
				stale++
				staleIDs = append(staleIDs, c.ID)
			} else {
				alive++
			}
		}

		// CLOCKS is a calendar overlay, independent of health lanes.
		//
		// The membership test used to be Group in {Releases, Vendors} — two
		// groups no check has ever used — so the lane was dead by
		// construction while rendering a confident 0 under a "time-based"
		// label. What makes something a calendar item is its KIND: a manual
		// chore has a Cadence and therefore a next date. The two legacy
		// groups are kept so an evaluated vendor/release check still shows
		// its next run here.
		if c.Kind == KindManual || ((c.Group == "Releases" || c.Group == "Vendors") && c.Kind != KindHeartbeat) {
			if due := nextDueAt(c, res); due != nil && due.Sub(now) <= clocksHorizon {
				dc := card
				dc.DueAt = due
				clocks = append(clocks, dc)
			}
		}

		switch {
		case isSnoozed:
			snoozed = append(snoozed, card)
		case eff.IsRed() && c.Severity == SevCritical:
			onFire = append(onFire, card)
		case eff.IsRed() || eff == StatusDue:
			needsYou = append(needsYou, card)
		case c.Kind != KindHeartbeat:
			// Heartbeats are already accounted for in AUTOMATIONS.
			greenIDs = append(greenIDs, c.ID)
		}
	}

	sort.SliceStable(clocks, func(i, j int) bool {
		return clocks[i].DueAt.Before(*clocks[j].DueAt)
	})

	sort.SliceStable(blocked, func(i, j int) bool { return blocked[i].ID < blocked[j].ID })
	unwatched := unwatchedDomains(checks, domains)

	return BoardResponse{
		GeneratedAt: now,
		Coverage:    coverageOf(checks, domains),
		Lanes: []Lane{
			{Name: "ON FIRE", Cards: onFire, Count: len(onFire)},
			{Name: "NEEDS YOU", Cards: needsYou, Count: len(needsYou)},
			{Name: "BLOCKED", Cards: blocked, Count: len(blocked)},
			{Name: "UNWATCHED", Count: len(unwatched), Domains: unwatched},
			{Name: "CLOCKS", Cards: clocks, Count: len(clocks)},
			{Name: "AUTOMATIONS", Count: alive + stale, Alive: alive, Stale: stale, StaleIDs: staleIDs},
			{Name: "SNOOZED", Cards: snoozed, Count: len(snoozed)},
			{Name: "GREEN", Count: len(greenIDs), IDs: greenIDs},
		},
	}
}

func buildCard(c Check, r Result, eff Status) Card {
	card := Card{
		ID:          c.ID,
		Group:       c.Group,
		Title:       c.Title,
		Why:         c.Why,
		Kind:        string(c.Kind),
		Severity:    string(c.Severity),
		Status:      string(eff),
		Detail:      r.Detail,
		Remediation: c.Remediation,
		Runbook:     c.Runbook,
		Domain:      c.Domain,
		Owner:       c.Owner,
		Blocked:     c.Blocked,
		LastOKAt:    r.LastOKAt,
		FirstRedAt:  r.FirstRedAt,
		AckedUntil:  r.AckedUntil,
		AckReason:   r.AckReason,
		Action:      c.Action,
	}
	if c.Kind == KindManual {
		card.DueAt = nextDueAt(c, r)
	}
	return card
}

// nextDueAt is when the check next wants attention: a manual chore re-arms
// Cadence after the last tick; an evaluated check is due a run Interval after
// its last report. Heartbeats have no due date — they either beat or they
// don't.
func nextDueAt(c Check, r Result) *time.Time {
	var d time.Time
	switch c.Kind {
	case KindManual:
		d = r.LastReportedAt.Add(c.Cadence)
	case KindEvaluated:
		d = r.LastReportedAt.Add(c.Interval)
	default:
		return nil
	}
	return &d
}

// BoardHandler serves GET /api/internal/ops/board: load, build, encode.
func BoardHandler(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		results, err := store.LoadAll(r.Context())
		if err != nil {
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"board_load_failed", "could not load check results")
			return
		}
		board := BuildBoard(time.Now().UTC(), All(), results)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(board)
	}
}
