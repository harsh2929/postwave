package ops

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// wellFormed is a check that Register accepts. Each required-field test
// removes exactly ONE field from it, so the resulting panic can only be about
// that field.
//
// The message assertion is load-bearing. A bare "did it panic?" test passes on
// ANY panic, so once Register grew Domain and Owner requirements, a fixture
// missing all three would still have satisfied a Why test that no longer
// checked anything. Asserting the message keeps each test falsifiable: delete
// the Why branch from Register and only the Why test goes red.
func wellFormed() Check {
	return Check{
		ID: "t.wellformed", Domain: "billing", Owner: "founder",
		Why: "things break", Remediation: "do a thing",
		Kind: KindEvaluated, Interval: time.Hour,
		Probe: func(context.Context, *Env) (Status, string, error) { return StatusOK, "", nil },
	}
}

func mustPanicContaining(t *testing.T, want string, why string, fn func()) {
	t.Helper()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatalf("%s: no panic", why)
		}
		got := fmt.Sprint(r)
		if !strings.Contains(got, want) {
			t.Fatalf("%s: panic must mention %q, got %q", why, want, got)
		}
	}()
	fn()
}

func TestRegister_RejectsMissingWhy(t *testing.T) {
	c := wellFormed()
	c.ID, c.Why = "t.no-why", ""
	mustPanicContaining(t, "has no Why",
		"a consequence nobody can state is a check nobody will action",
		func() { Register(c) })
}

func TestRegister_RejectsMissingRemediation(t *testing.T) {
	c := wellFormed()
	c.ID, c.Remediation = "t.no-rem", ""
	mustPanicContaining(t, "has no Remediation",
		"a red row you cannot act on is a nag, not a control",
		func() { Register(c) })
}

func TestRegister_RejectsMissingDomain(t *testing.T) {
	c := wellFormed()
	c.ID, c.Domain = "t.no-domain", ""
	mustPanicContaining(t, "has no Domain",
		"a check that counts toward no coverage surface leaves that surface reading as unwatched while something really does watch it",
		func() { Register(c) })
}

func TestRegister_RejectsMissingOwner(t *testing.T) {
	c := wellFormed()
	c.ID, c.Owner = "t.no-owner", ""
	mustPanicContaining(t, "has no Owner",
		"a red row addressed to everyone is addressed to no one",
		func() { Register(c) })
}

func TestRegister_RejectsDuplicateID(t *testing.T) {
	c := Check{
		ID:          "t.dup",
		Domain:      "billing",
		Owner:       "founder",
		Kind:        KindEvaluated,
		Interval:    time.Hour,
		Why:         "w",
		Remediation: "r",
		// A valid KindEvaluated check needs a Probe (Register panics without
		// one); this test targets the DUPLICATE-ID panic, so the fixture
		// must otherwise be well-formed or the first Register call panics
		// for the wrong reason before the defer/recover is even armed.
		Probe: func(context.Context, *Env) (Status, string, error) { return StatusOK, "", nil },
	}
	Register(c)
	defer func() {
		if recover() == nil {
			t.Fatal("a duplicate check ID must panic")
		}
		delete(registry, "t.dup")
	}()
	Register(c)
}

func TestAll_IsSortedByID(t *testing.T) {
	all := All()
	for i := 1; i < len(all); i++ {
		if all[i-1].ID > all[i].ID {
			t.Fatalf("All() must be sorted by ID; %q came before %q", all[i-1].ID, all[i].ID)
		}
	}
}
