// SPDX-License-Identifier: AGPL-3.0-only

package stepup_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// This package WAS a complete, well-tested security control that executed
// nowhere. It is now mounted, and this test pins that in the other direction.
//
// Ten tests passed for a long time over a middleware nothing imported: they
// verified the freshness tiers, the route templates and the challenge body, and
// not one line ran against a real request. A blueprint audit found it by asking
// the question a test suite cannot — who imports this? — and the answer was
// nobody. That is why the mount state is asserted at all: a green suite over an
// unmounted middleware is indistinguishable from a green suite over a mounted
// one.
//
// WHAT CHANGED. The blocker was real and is now handled rather than accepted.
// `mfa_satisfied` is written true only by TOTP verification, so an un-enrolled
// user has it false permanently and an unexempted gate would 401 them out of
// workspace invites, role changes, subscriber export, security settings and
// API-key create/rotate — forever, with the prompt's own re-proof endpoint
// answering `not_enrolled`.
//
// The recorded objection to exempting those users was that it "weakens the
// control". That compares the exemption to the ideal. Compared to the state it
// replaced — unmounted — it is strictly stronger: nobody on these routes was
// being asked to re-prove anything, and now everybody who CAN be asked is. A
// user with no second factor is exactly as protected as before; a user with one
// is meaningfully more.
//
// The other three recorded blockers were closed first, and by evidence rather
// than by decree:
//
//  1. All three clients render AND mount the prompt — web
//     `dashboard-shell.tsx`, desktop `App.tsx`, mobile `app/_layout.tsx` — and
//     `packages/step-up/src/mounted.test.ts` now fails if one stops. Mobile's
//     prompt existed unmounted for a while, which is exactly the failure this
//     file is about, one layer up.
//  2. `X-Postwave-Step-Up` is in `browserExposedResponseHeaders`, so the desktop
//     shell can read the hint instead of parsing the body.
//  3. ORDERING: the middleware is mounted BEFORE `idempotency.Process`, which
//     caches 4xx against the Idempotency-Key. Mounted after it, a challenge
//     would be replayed to the client even once the user had proven themselves.
//
// STILL OPEN, and worth stating because mounting did not resolve it: a
// device-trusted session is marked `mfa_satisfied` with no `mfa_satisfied_at`,
// which the lookup coalesces to epoch — so such a session presents a 1970 proof
// and is challenged on its first protected request. The user CAN answer (device
// trust implies enrolment), so it is friction rather than a lockout, and
// arguably correct: device trust is not live possession. It should still be
// decided rather than discovered.

func TestTheGateIsMountedAndThatIsRecorded(t *testing.T) {
	t.Parallel()

	repoRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}

	// The import path, not the bare word: "stepup" appears in comments and in
	// unrelated identifiers across the tree, and counting those would make this
	// test fail for reasons that have nothing to do with mounting.
	importPattern := regexp.MustCompile(`"github\.com/postwave/postwave/apps/api/internal/stepup"`)

	var importers []string
	scanned := 0
	for _, dir := range []string{"apps", "services", "packages"} {
		root := filepath.Join(repoRoot, dir)
		if _, statErr := os.Stat(root); statErr != nil {
			continue
		}
		walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if info.IsDir() {
				name := info.Name()
				if name == "node_modules" || name == ".git" || name == "vendor" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") {
				return nil
			}
			// The package importing itself is not a mount.
			if strings.Contains(path, filepath.Join("internal", "stepup")) {
				return nil
			}
			scanned++
			source, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			if importPattern.Match(source) {
				rel, relErr := filepath.Rel(repoRoot, path)
				if relErr != nil {
					rel = path
				}
				importers = append(importers, rel)
			}
			return nil
		})
		if walkErr != nil {
			t.Fatalf("walk %s: %v", dir, walkErr)
		}
	}

	// A floor, because a walk that read nothing would report "no importers" — the
	// same answer as a correctly-unmounted gate. Without this the test passes
	// hardest exactly when it is broken.
	const minGoFilesScanned = 500
	if scanned < minGoFilesScanned {
		t.Fatalf("scanned only %d Go files, expected at least %d: this test cannot "+
			"distinguish 'nothing imports stepup' from 'the walk failed', so it refuses "+
			"to report the reassuring answer over a tree it did not read",
			scanned, minGoFilesScanned)
	}

	// The assertion is now INVERTED: the gate must stay mounted.
	//
	// Kept rather than deleted, because the failure it was written for has not
	// gone away — it has only changed direction. An unmounted middleware and a
	// mounted one look identical from inside this package's other ten tests, so
	// something has to hold the composition root to its word. Deleting this on
	// the day it went green would remove the only check that notices if a
	// refactor drops the `r.Use` line.
	if len(importers) == 0 {
		t.Fatalf("nothing imports stepup: the gate is not mounted anywhere.\n\n"+
			"Every one of this package's other tests still passes in that state, "+
			"which is precisely why this one exists. If the mount was removed "+
			"deliberately, say so here and invert this assertion in the same "+
			"change — a recorded expectation that no longer describes reality is "+
			"worse than none.\n\nScanned %d Go files.", scanned)
	}
	// And it must be the composition root, not some incidental importer: a test
	// helper or a doc example importing the package would satisfy a bare
	// "somebody imports it" check while no request ever passes through the gate.
	mountedInMain := false
	for _, f := range importers {
		if strings.HasSuffix(f, "apps/api/main.go") {
			mountedInMain = true
			break
		}
	}
	if !mountedInMain {
		t.Fatalf("stepup is imported by %s but not by apps/api/main.go — nothing "+
			"in the serving path mounts it, so no request is gated.",
			strings.Join(importers, ", "))
	}

	// AND THE MOUNT ITSELF, not merely the import.
	//
	// The first version of this check stopped at "main.go imports stepup", and a
	// mutation that deleted the `r.Use(...)` line PASSED it: the import line was
	// still in the file text, and this test reads source rather than compiling.
	// An import with no call is the same inert state the whole file exists to
	// catch, one step further in.
	mainSource, err := os.ReadFile(filepath.Join(repoRoot, "apps", "api", "main.go"))
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	if !strings.Contains(string(mainSource), "stepup.Middleware(") {
		t.Fatalf("apps/api/main.go imports stepup but never calls " +
			"stepup.Middleware(...). The package is linked and no request passes " +
			"through the gate, which is indistinguishable from not having it.")
	}
}
