// SPDX-License-Identifier: AGPL-3.0-only
//
// Command genopschecks emits (or, with -check, validates) the canonical ops
// check registry from internal/ops. The registry is the single source of
// truth for the platform-operator board: it is the source of the
// `audit:ops` CI gate, which fails the build on a malformed check rather
// than let a check nobody can act on reach production.
//
//	go run ./cmd/genopschecks           # print the registry as JSON
//	go run ./cmd/genopschecks -check    # CI gate: fail on a malformed check
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/postwave/postwave/apps/api/internal/ops"

	// Blank-imported so its init() functions register every check with the
	// ops registry as a side effect. This is the same registration the
	// running server performs; a malformed check panics here exactly as it
	// would in production, just earlier.
	_ "github.com/postwave/postwave/apps/api/internal/ops/checks"
)

// checkJSON is the JSON projection of ops.Check for the registry dump: enough
// for a human or a script to see what's registered without exposing Probe
// funcs or the Env plumbing.
type checkJSON struct {
	ID       string `json:"id"`
	Group    string `json:"group"`
	Domain   string `json:"domain"`
	Owner    string `json:"owner"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"`
	Interval string `json:"interval"`

	// HasAction means "this check has a BUTTON", i.e. a non-nil ActionMeta.
	//
	// It used to be derived from c.Probe != nil, which is a tautology: every
	// KindEvaluated check must have a Probe or Register panics, so the field
	// reported true for all of them and false for every heartbeat and manual
	// chore -- an answer that happened to look plausible while there were only
	// four checks, all evaluated.
	HasAction bool `json:"has_action"`
	Blocked   bool `json:"blocked,omitempty"`
}

// registryJSON is the full dump: the checks, plus the coverage arithmetic that
// gives them a denominator.
type registryJSON struct {
	Domains   []domainJSON `json:"domains"`
	Checks    []checkJSON  `json:"checks"`
	Declared  int          `json:"declared_domains"`
	Watched   int          `json:"watched_domains"`
	Unwatched []string     `json:"unwatched_domains"`
}

type domainJSON struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Owner  string `json:"owner"`
	Checks int    `json:"checks"`
}

func main() {
	check := flag.Bool("check", false, "validate the registry (exit non-zero on a malformed check)")
	flag.Parse()

	// ops.Register already panics on a malformed check (empty ID/Why/
	// Remediation, an evaluated check with no Probe, a manual check with no
	// Cadence, a non-manual check with no Interval, or a duplicate ID) as
	// part of the checks package's init(). That panic already surfaces here
	// as a non-zero exit naming the check. The explicit pass below is a
	// second, non-panicking layer over the same invariants for Why,
	// Remediation, and uniqueness, so this gate keeps working even if
	// Register's panics are ever loosened.
	all := ops.All()

	if *check {
		violations := 0
		seen := make(map[string]bool, len(all))
		for _, c := range all {
			if c.Why == "" {
				fmt.Fprintf(os.Stderr, "genopschecks: check %q has no Why\n", c.ID)
				violations++
			}
			if c.Remediation == "" {
				fmt.Fprintf(os.Stderr, "genopschecks: check %q has no Remediation\n", c.ID)
				violations++
			}
			if seen[c.ID] {
				fmt.Fprintf(os.Stderr, "genopschecks: duplicate check ID %q\n", c.ID)
				violations++
			}
			seen[c.ID] = true
		}
		// Whole-registry invariants Register cannot see from a single check:
		// every check must name a DECLARED domain. A typo here would silently
		// drop a surface out of the coverage arithmetic while the check itself
		// kept working, which is the quietest possible way to break the one
		// number the board uses to qualify all the others.
		if err := ops.ValidateDeclarations(); err != nil {
			fmt.Fprintf(os.Stderr, "genopschecks: %v\n", err)
			violations++
		}

		if violations > 0 {
			fmt.Fprintf(os.Stderr, "genopschecks: %d violation(s) found in the ops check registry\n", violations)
			os.Exit(1)
		}

		// Coverage is REPORTED, never enforced. A threshold here would be
		// gamed the first time it blocked a release -- somebody would add a
		// check that always returns OK, which is worse than the gap it hides.
		// Printing the number every build keeps it in front of people instead.
		domains := ops.AllDomains()
		covered := coveredDomains(all)
		runtimeProbes := 0
		for _, c := range all {
			if c.RuntimeProbe {
				runtimeProbes++
			}
		}
		fmt.Printf("genopschecks: registry OK (%d checks, %d with wiring-time probes, %d/%d domains watched)\n",
			len(all), runtimeProbes, len(covered), len(domains))
		for _, d := range domains {
			if !covered[d.ID] {
				fmt.Printf("genopschecks: UNWATCHED domain %q (%s) — owner %s\n", d.ID, d.Label, d.Owner)
			}
		}
		return
	}

	checksOut := make([]checkJSON, 0, len(all))
	for _, c := range all {
		checksOut = append(checksOut, checkJSON{
			ID:        c.ID,
			Group:     c.Group,
			Domain:    c.Domain,
			Owner:     c.Owner,
			Kind:      string(c.Kind),
			Severity:  string(c.Severity),
			Interval:  c.Interval.String(),
			HasAction: c.Action != nil,
			Blocked:   c.Blocked != nil,
		})
	}

	perDomain := map[string]int{}
	for _, c := range all {
		if c.Blocked == nil {
			perDomain[c.Domain]++
		}
	}
	domains := ops.AllDomains()
	domainsOut := make([]domainJSON, 0, len(domains))
	unwatched := []string{}
	for _, d := range domains {
		domainsOut = append(domainsOut, domainJSON{
			ID: d.ID, Label: d.Label, Owner: d.Owner, Checks: perDomain[d.ID],
		})
		if perDomain[d.ID] == 0 {
			unwatched = append(unwatched, d.ID)
		}
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(registryJSON{
		Domains:   domainsOut,
		Checks:    checksOut,
		Declared:  len(domains),
		Watched:   len(domains) - len(unwatched),
		Unwatched: unwatched,
	}); err != nil {
		fmt.Fprintln(os.Stderr, "genopschecks: marshal registry:", err)
		os.Exit(1)
	}
}

// coveredDomains is the same "can currently report" definition the board uses:
// a domain covered only by blocked checks is not covered.
func coveredDomains(all []ops.Check) map[string]bool {
	covered := map[string]bool{}
	for _, c := range all {
		if c.Blocked == nil && c.Domain != "" {
			covered[c.Domain] = true
		}
	}
	return covered
}
