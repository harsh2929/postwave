// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"strings"
	"testing"
	"time"
)

func runtimeProbeCheck(id string) Check {
	return Check{
		ID: id, Domain: "console", Owner: "platform",
		Why: "w", Remediation: "r",
		Kind: KindEvaluated, Interval: time.Minute,
		RuntimeProbe: true,
	}
}

// A check whose probe needs a live handle (the worker Fleet, loaded config, a
// channel slice) used to be registered wholesale at runtime, which made it
// invisible to the compiled registry -- so `pnpm audit:ops` reported a
// coverage number the board disagreed with. A metric that disagrees with the
// thing it measures is worse than no metric.
func TestRegister_AcceptsADeclaredCheckWhoseProbeIsBoundLater(t *testing.T) {
	c := runtimeProbeCheck("t.runtime-probe")
	Register(c)
	t.Cleanup(func() { delete(registry, c.ID); delete(probeBindings, c.ID) })

	if _, ok := Get(c.ID); !ok {
		t.Fatal("a runtime-probe check must be in the compiled registry like any other")
	}
}

// The escape hatch must stay narrow: without RuntimeProbe, a probeless
// evaluated check is still a programmer error.
func TestRegister_StillRejectsAProbelessCheckWithoutTheFlag(t *testing.T) {
	c := runtimeProbeCheck("t.no-flag")
	c.RuntimeProbe = false
	mustPanicContaining(t, "has no Probe",
		"an evaluated check with neither a probe nor a declared runtime binding is a dead row",
		func() { Register(c) })
}

func TestBindProbe_RejectsUnknownAndDoubleBinds(t *testing.T) {
	c := runtimeProbeCheck("t.bind-probe")
	Register(c)
	t.Cleanup(func() { delete(registry, c.ID); delete(probeBindings, c.ID) })

	p := func(context.Context, *Env) (Status, string, error) { return StatusOK, "", nil }

	mustPanicContaining(t, "no such check", "binding a probe to a check that does not exist",
		func() { BindProbe("t.nonexistent", p) })
	mustPanicContaining(t, "nil probe", "binding nothing is a silently dead check",
		func() { BindProbe(c.ID, nil) })

	BindProbe(c.ID, p)
	mustPanicContaining(t, "already bound", "a second bind would silently replace the first",
		func() { BindProbe(c.ID, p) })
}

// A compiled probe must not be silently overridden at runtime: that would make
// the source of a check's behaviour unknowable from the source.
func TestBindProbe_RejectsBindingOverACompiledProbe(t *testing.T) {
	c := Check{
		ID: "t.has-compiled-probe", Domain: "console", Owner: "platform",
		Why: "w", Remediation: "r", Kind: KindEvaluated, Interval: time.Minute,
		Probe: func(context.Context, *Env) (Status, string, error) { return StatusOK, "", nil },
	}
	Register(c)
	t.Cleanup(func() { delete(registry, c.ID); delete(probeBindings, c.ID) })

	mustPanicContaining(t, "declares a compiled probe", "overriding a compiled probe hides behaviour from the source",
		func() {
			BindProbe(c.ID, func(context.Context, *Env) (Status, string, error) { return StatusOK, "", nil })
		})
}

// The failure this whole seam risks: a check declared with RuntimeProbe whose
// binding is never wired. It would report RED forever for a reason that is a
// wiring bug, not a platform fault -- so boot must refuse instead.
func TestValidateRegistry_RejectsAnUnboundRuntimeProbe(t *testing.T) {
	c := runtimeProbeCheck("t.unbound")
	Register(c)
	t.Cleanup(func() { delete(registry, c.ID); delete(probeBindings, c.ID) })

	err := validateRegistry(All(), append(AllDomains(),
		Domain{ID: "console", Label: "Console", Why: "w", Owner: "platform"}), true)
	if err == nil || !strings.Contains(err.Error(), "t.unbound") {
		t.Fatalf("an unbound runtime probe must fail validation, got %v", err)
	}

	BindProbe(c.ID, func(context.Context, *Env) (Status, string, error) { return StatusOK, "", nil })
	if err := validateRegistry(All(), append(AllDomains(),
		Domain{ID: "console", Label: "Console", Why: "w", Owner: "platform"}), true); err != nil {
		t.Fatalf("once bound it must validate, got %v", err)
	}
}

// The reconciler must run the bound probe, and must fail loud rather than
// silently skipping a check whose probe never arrived.
func TestProbeFor_ResolvesBoundAndReportsUnbound(t *testing.T) {
	c := runtimeProbeCheck("t.probe-for")
	Register(c)
	t.Cleanup(func() { delete(registry, c.ID); delete(probeBindings, c.ID) })

	if probeFor(c) != nil {
		t.Fatal("an unbound runtime probe must resolve to nil so the reconciler can report it")
	}
	BindProbe(c.ID, func(context.Context, *Env) (Status, string, error) { return StatusWarn, "hi", nil })
	got := probeFor(c)
	if got == nil {
		t.Fatal("a bound probe must resolve")
	}
	st, detail, _ := got(context.Background(), nil)
	if st != StatusWarn || detail != "hi" {
		t.Fatalf("the bound probe must be the one that runs, got %s %q", st, detail)
	}
}
