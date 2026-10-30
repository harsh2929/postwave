// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"fmt"
	"sort"
)

// registry is compiled, not a database table.
//
// A check that references a dropped column will not compile, and adding one
// goes through PR review. A DB-table registry would rot exactly as
// dsar_policies did: a table with zero write paths, whose flag was therefore
// permanently false and whose feature was therefore permanently off.
var registry = map[string]Check{}

// Register panics on a malformed check. These are programmer errors and they
// should stop the build, not degrade the board.
func Register(c Check) {
	switch {
	case c.ID == "":
		panic("ops: check with an empty ID")
	case c.Domain == "":
		panic(fmt.Sprintf("ops: check %q has no Domain; every check must count toward exactly one declared coverage surface", c.ID))
	case c.Owner == "":
		panic(fmt.Sprintf("ops: check %q has no Owner; a red row addressed to everyone is addressed to no one", c.ID))
	case c.Why == "":
		panic(fmt.Sprintf("ops: check %q has no Why", c.ID))
	case c.Remediation == "":
		panic(fmt.Sprintf("ops: check %q has no Remediation", c.ID))
	case c.Kind == KindEvaluated && c.Probe == nil && !c.RuntimeProbe:
		panic(fmt.Sprintf("ops: evaluated check %q has no Probe (set RuntimeProbe and call BindProbe if it needs a wiring-time handle)", c.ID))
	case c.RuntimeProbe && c.Kind != KindEvaluated:
		panic(fmt.Sprintf("ops: check %q sets RuntimeProbe but is not evaluated; only evaluated checks have probes", c.ID))
	case c.RuntimeProbe && c.Probe != nil:
		panic(fmt.Sprintf("ops: check %q declares both a compiled Probe and RuntimeProbe", c.ID))
	case c.Kind == KindManual && c.Cadence == 0:
		panic(fmt.Sprintf("ops: manual check %q has no Cadence", c.ID))
	case c.Kind != KindManual && c.Interval == 0:
		panic(fmt.Sprintf("ops: check %q has no Interval", c.ID))
	}
	if a := c.Action; a != nil {
		switch {
		case a.ID == "" || a.Label == "":
			panic(fmt.Sprintf("ops: check %q has an ActionMeta with no ID or Label", c.ID))
		case a.Danger != DangerSafe && a.Danger != DangerConfirm && a.Danger != DangerTypeToConfirm:
			panic(fmt.Sprintf("ops: check %q action %q has invalid danger tier %q", c.ID, a.ID, a.Danger))
		}
	}
	if _, dup := registry[c.ID]; dup {
		panic(fmt.Sprintf("ops: duplicate check ID %q", c.ID))
	}
	registry[c.ID] = c
}

// All returns every registered check, sorted by ID for a stable board.
func All() []Check {
	out := make([]Check, 0, len(registry))
	for _, c := range registry {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// probeBindings maps check ID -> the probe attached at wiring time. Like
// registry and bindings this is startup-only state: written during boot, read
// by the reconciler. No mutex, for the same reason.
var probeBindings = map[string]ProbeFunc{}

// BindProbe attaches the probe for a check declared with RuntimeProbe.
//
// Every failure here is a wiring bug that would otherwise present as a
// permanently red row, so all of them stop the boot rather than degrade the
// board: unknown check, nil probe, double bind, or binding over a check that
// already carries a compiled probe (which would make a check's behaviour
// unknowable from its source).
func BindProbe(checkID string, p ProbeFunc) {
	c, ok := registry[checkID]
	switch {
	case p == nil:
		panic(fmt.Sprintf("ops: BindProbe(%q) with a nil probe", checkID))
	case !ok:
		panic(fmt.Sprintf("ops: BindProbe(%q): no such check", checkID))
	case c.Probe != nil:
		panic(fmt.Sprintf("ops: BindProbe(%q): check declares a compiled probe", checkID))
	case !c.RuntimeProbe:
		panic(fmt.Sprintf("ops: BindProbe(%q): check does not declare RuntimeProbe", checkID))
	}
	if _, dup := probeBindings[checkID]; dup {
		panic(fmt.Sprintf("ops: BindProbe(%q): already bound", checkID))
	}
	probeBindings[checkID] = p
}

// probeFor resolves the probe a check should actually run: the compiled one,
// or the one bound at wiring time. nil means an unbound runtime probe, which
// the reconciler reports as RED rather than skipping -- a check that silently
// does not run is indistinguishable from a check that passes.
func probeFor(c Check) ProbeFunc {
	if c.Probe != nil {
		return c.Probe
	}
	return probeBindings[c.ID]
}

// BoundProbe returns the probe a check will actually run, compiled or bound.
// Exported so a check declared in one package and wired in another can be
// exercised end to end -- otherwise the only thing a test can reach is the
// closure it built itself, which proves nothing about what the board runs.
func BoundProbe(checkID string) ProbeFunc {
	c, ok := registry[checkID]
	if !ok {
		return nil
	}
	return probeFor(c)
}

func Get(id string) (Check, bool) {
	c, ok := registry[id]
	return c, ok
}
