// SPDX-License-Identifier: AGPL-3.0-only
//
// SAMLJITProvision has no callers, and that is allowed — but only while SSO is
// still refused.
//
// The function is the JIT half of a SAML sign-in this deployment cannot do:
// there is no ACS route, and `PUT /api/v1/security/settings` refuses to store
// an SSO provider precisely because storing one would leave the workspace as
// unprotected as before while the settings screen showed SSO as configured.
//
// Two futures make that arrangement a lie, and nothing detected either:
//
//  1. Someone adds an ACS route and forgets to call SAMLJITProvision — SAML
//     users sign in and no account is provisioned or role-mapped.
//  2. Someone removes the refusal (it looks like an odd restriction) without
//     an ACS route existing — the operator sees SSO saved and mandated, and
//     everyone still signs in with a password.
//
// This couples them, so the dead function can stay dead honestly and cannot
// quietly become either of those.

package scim

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// routeLiteral matches a route registration whose first argument is a PATH.
//
// The path requirement is not decoration. The first version of this matched any
// quoted string containing "acs" and immediately flagged
// `r.Header.Get("x-square-hmacsha256-signature")` — hm-ACS-ha256 — as a SAML
// assertion consumer, and reported that SAML users were signing in unprovisioned.
// A guard whose first run produces a confident false accusation is worse than no
// guard, because the next person spends their afternoon on it.
var routeLiteral = regexp.MustCompile(`(?i)(Post|Get|Handle|HandleFunc)\(\s*"(/[^"]*)"`)

// acsPathSegment matches a path SEGMENT named saml or acs, so a substring
// inside an unrelated word cannot match.
var acsPathSegment = regexp.MustCompile(`(?i)(^|/)(saml|acs)($|/)`)

// findACSRoute returns the path of a registered SAML assertion-consumer route.
func findACSRoute(body string) string {
	for _, m := range routeLiteral.FindAllStringSubmatch(body, -1) {
		if acsPathSegment.MatchString(m[2]) {
			return m[2]
		}
	}
	return ""
}

func repoGoSources(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if info.Name() == "node_modules" || info.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		out[path] = string(body)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return out
}

func TestSAMLJITAndTheSSORefusalStayInStep(t *testing.T) {
	// "../.." is apps/api, NOT apps/api/internal. Rooting at internal/ made this
	// guard blind to main.go — where a route is most likely to be registered —
	// and it passed a mutation that added an ACS route there.
	sources := repoGoSources(t, "../..")
	// Guard the guard: an empty walk would satisfy every branch below.
	if len(sources) < 100 {
		t.Fatalf("walked %d go files; the assertions below would be vacuous", len(sources))
	}

	acsRoute := ""
	jitCalled := false
	refusalPresent := false
	for path, body := range sources {
		if route := findACSRoute(body); route != "" {
			acsRoute = path + " (" + route + ")"
		}
		// The definition itself is not a call.
		if strings.Contains(body, "SAMLJITProvision(") &&
			!strings.Contains(body, "func SAMLJITProvision(") {
			jitCalled = true
		}
		if strings.Contains(body, `Code:    "sso_not_available"`) {
			refusalPresent = true
		}
	}

	switch {
	case acsRoute == "" && !refusalPresent:
		t.Fatal("there is no SAML ACS route AND nothing refuses SSO configuration. " +
			"An operator can now save a provider and believe federated sign-in is " +
			"mandated while everyone still signs in with a password.")
	case acsRoute != "" && !jitCalled:
		t.Fatalf("a SAML ACS route exists (%s) but nothing calls SAMLJITProvision. "+
			"SAML users would sign in with no account provisioned and no role "+
			"mapped from their groups.", acsRoute)
	case acsRoute != "" && refusalPresent:
		t.Fatalf("a SAML ACS route exists (%s) but SSO configuration is still "+
			"refused — the capability is built and unreachable.", acsRoute)
	}
}
