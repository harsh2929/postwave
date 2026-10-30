// SPDX-License-Identifier: AGPL-3.0-only

// domains.go — the coverage registry, and the reason this console can claim to
// be a source of truth rather than merely a source of signals.
//
// THE LYING PORTFOLIO. Every other invariant in this package defends against a
// check that lies: staleness is derived at read time, a panicking probe is RED,
// a dead reconciler turns the board red rather than freezing it green. None of
// them defend against the board lying by OMISSION. A platform surface nobody
// wrote a check for contributes nothing to the red lanes, which makes it
// indistinguishable from a surface that is fine. Add a hundred checks and the
// hundred-and-first gap is still invisible.
//
// A Domain is therefore a declaration that a surface OUGHT to be watched,
// registered independently of whether anything watches it yet. BuildBoard joins
// domains against checks and renders the difference in the UNWATCHED lane. The
// gap becomes a row, and a row can be assigned, argued about, and closed.
//
// Like the check registry this is compiled, not configured: a domain is added
// in a PR, and `pnpm audit:ops` fails the build if a check names a domain that
// does not exist.
package ops

import (
	"fmt"
	"sort"
)

// Domain is one platform surface that must be watched. It carries an Owner for
// the same reason a Check does: an unowned gap is everybody's, which is
// nobody's.
type Domain struct {
	ID    string // stable slug: "sending", "billing", "compliance"
	Label string // human name rendered on the board
	Why   string // what it costs when this surface fails unobserved
	Owner string // the team or person accountable for coverage here
}

// UnwatchedReason distinguishes the two ways a domain ends up unwatched. They
// need different responses: one is engineering work, the other is procurement.
type UnwatchedReason string

const (
	// UnwatchedNoCheck: nobody has written a check for this surface.
	UnwatchedNoCheck UnwatchedReason = "no_check"
	// UnwatchedAllBlocked: every check covering it is blocked on something
	// outside engineering, so nothing can currently report.
	UnwatchedAllBlocked UnwatchedReason = "all_checks_blocked"
)

// UnwatchedDomain is one row of the UNWATCHED lane.
type UnwatchedDomain struct {
	ID     string          `json:"id"`
	Label  string          `json:"label"`
	Why    string          `json:"why"`
	Owner  string          `json:"owner"`
	Reason UnwatchedReason `json:"reason"`

	// BlockedBy names the external blockers when Reason is
	// UnwatchedAllBlocked, so the row is actionable without a second lookup.
	BlockedBy []string `json:"blocked_by,omitempty"`
}

var domainRegistry = map[string]Domain{}

// RegisterDomain panics on a malformed domain. Same reasoning as Register: a
// half-declared coverage target is a programmer error and should stop the
// build, not quietly weaken the coverage arithmetic.
func RegisterDomain(d Domain) {
	switch {
	case d.ID == "":
		panic("ops: domain with an empty ID")
	case d.Label == "":
		panic(fmt.Sprintf("ops: domain %q has no Label", d.ID))
	case d.Why == "":
		panic(fmt.Sprintf("ops: domain %q has no Why", d.ID))
	case d.Owner == "":
		panic(fmt.Sprintf("ops: domain %q has no Owner", d.ID))
	}
	if _, dup := domainRegistry[d.ID]; dup {
		panic(fmt.Sprintf("ops: duplicate domain ID %q", d.ID))
	}
	domainRegistry[d.ID] = d
}

// AllDomains returns every registered domain, sorted by ID for a stable board.
func AllDomains() []Domain {
	out := make([]Domain, 0, len(domainRegistry))
	for _, d := range domainRegistry {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func GetDomain(id string) (Domain, bool) {
	d, ok := domainRegistry[id]
	return d, ok
}

// ValidateRegistry checks every whole-registry invariant, including that each
// declared RuntimeProbe was actually bound. Called at BOOT from main.go, where
// the wiring has happened, so a bad deploy fails loudly rather than serving a
// board with a permanently red row caused by a missing bind.
func ValidateRegistry() error { return validateRegistry(All(), AllDomains(), true) }

// ValidateDeclarations checks only what is knowable without running main.go:
// that every check names a registered domain. cmd/genopschecks calls this,
// because a static tool has not executed the wiring and would otherwise report
// every runtime probe as unbound -- failing CI on a condition it cannot
// observe.
func ValidateDeclarations() error { return validateRegistry(All(), AllDomains(), false) }

func validateRegistry(checks []Check, domains []Domain, requireBoundProbes bool) error {
	known := make(map[string]bool, len(domains))
	for _, d := range domains {
		known[d.ID] = true
	}
	var problems []string
	for _, c := range checks {
		if c.Domain == "" {
			problems = append(problems, fmt.Sprintf("check %q has no Domain", c.ID))
			continue
		}
		if !known[c.Domain] {
			problems = append(problems, fmt.Sprintf("check %q names unregistered domain %q", c.ID, c.Domain))
		}
		// A declared-but-unbound runtime probe would report RED forever for a
		// reason that is a wiring bug rather than a platform fault -- and a
		// permanently red row gets snoozed. Refuse the boot instead.
		if requireBoundProbes && c.RuntimeProbe && probeBindings[c.ID] == nil {
			problems = append(problems, fmt.Sprintf(
				"check %q declares RuntimeProbe but no probe was bound; wire BindProbe(%q, ...) in main.go", c.ID, c.ID))
		}
	}
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("ops registry: %d problem(s): %v", len(problems), problems)
}

// unwatchedDomains is the coverage join: which declared surfaces have nothing
// that can currently report on them.
//
// "Currently report" is doing real work here. A domain whose only checks are
// Blocked is NOT covered — a check waiting on a vendor account produces no
// observation, and counting it as coverage would be the same lie as counting a
// domain with no checks at all, just better dressed.
func unwatchedDomains(checks []Check, domains []Domain) []UnwatchedDomain {
	live := map[string]bool{}
	blockers := map[string][]string{}

	for _, c := range checks {
		if c.Domain == "" {
			continue
		}
		if c.Blocked == nil {
			live[c.Domain] = true
			continue
		}
		if _, seen := live[c.Domain]; !seen {
			live[c.Domain] = false
		}
		blockers[c.Domain] = appendUnique(blockers[c.Domain], c.Blocked.Reason)
	}

	out := []UnwatchedDomain{}
	for _, d := range domains {
		covered, present := live[d.ID]
		if covered {
			continue
		}
		row := UnwatchedDomain{
			ID: d.ID, Label: d.Label, Why: d.Why, Owner: d.Owner,
			Reason: UnwatchedNoCheck,
		}
		if present {
			row.Reason = UnwatchedAllBlocked
			row.BlockedBy = blockers[d.ID]
		}
		out = append(out, row)
	}
	return out
}

// Coverage is the board's own denominator: how many surfaces we said must be
// watched, and how many actually have something that can report.
//
// It is computed HERE, server-side, and shipped on the board rather than being
// derived by the console. The GREEN lane carries bare check IDs rather than
// cards, so any client-side count of card domains would silently omit every
// domain whose only check is passing — understating coverage precisely when
// things are going well.
type Coverage struct {
	Declared int `json:"declared"`
	Watched  int `json:"watched"`
}

// coverageOf counts declared surfaces against surfaces with at least one check
// that can currently report. It shares the "can currently report" definition
// with unwatchedDomains by construction: watched = declared - unwatched, so
// the headline number and the lane can never tell two different stories.
func coverageOf(checks []Check, domains []Domain) Coverage {
	return Coverage{
		Declared: len(domains),
		Watched:  len(domains) - len(unwatchedDomains(checks, domains)),
	}
}

func appendUnique(list []string, value string) []string {
	if value == "" {
		return list
	}
	for _, existing := range list {
		if existing == value {
			return list
		}
	}
	return append(list, value)
}
