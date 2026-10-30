// SPDX-License-Identifier: AGPL-3.0-only

package stepup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every protected route must be a route this API actually serves.
//
// Four of the six original entries named paths that do not exist —
// `/api/v1/team/invites` for `/api/v1/workspace/invites`,
// `/api/v1/settings/security` for `/api/v1/security/settings` (segments
// reversed), a DELETE for what is a PATCH, and a POST for what is a GET.
// Nothing failed, because a policy entry that matches no request never fires:
// two thirds of this control was decoration that read as protecting invites,
// member changes, security settings and subscriber export.
//
// That is the failure mode a step-up gate is least able to survive, because its
// success state and its inert state look identical from the outside — no
// challenge is what "you are already confirmed" looks like too.
//
// The manifest is generated from the mounted routes, so it is the honest answer
// to "does this exist". A renamed route now breaks the build instead of quietly
// unprotecting the action it was named for.
func TestEveryProtectedRouteExists(t *testing.T) {
	path := filepath.Join("..", "routeauth", "manifest.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read route manifest: %v", err)
	}
	var manifest struct {
		Routes []struct {
			Method string `json:"method"`
			Path   string `json:"path"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("decode route manifest: %v", err)
	}
	if len(manifest.Routes) < 500 {
		// A floor, so this cannot pass by reading an empty or moved manifest and
		// finding no contradictions.
		t.Fatalf("route manifest holds only %d routes; the check is measuring "+
			"almost nothing", len(manifest.Routes))
	}

	exact := map[string]bool{}
	byPath := map[string]bool{}
	for _, r := range manifest.Routes {
		exact[strings.ToUpper(r.Method)+" "+r.Path] = true
		byPath[r.Path] = true
		if strings.EqualFold(r.Method, "ANY") {
			for _, m := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
				exact[m+" "+r.Path] = true
			}
		}
	}

	routes := Routes()
	if len(routes) < 5 {
		t.Fatalf("only %d protected routes; this test is measuring almost nothing", len(routes))
	}
	for _, route := range routes {
		parts := strings.SplitN(strings.TrimSpace(route), " ", 2)
		if len(parts) != 2 {
			t.Errorf("policy key %q is not \"METHOD /path\"", route)
			continue
		}
		// Upper-case the METHOD only. Upper-casing the whole key mangles the
		// path and makes every route look absent — which is how this test first
		// reported all seven as missing, including two verified by hand.
		if exact[strings.ToUpper(parts[0])+" "+parts[1]] {
			continue
		}
		hint := ""
		if len(parts) == 2 && byPath[parts[1]] {
			hint = " — the path exists but not for this method"
		}
		t.Errorf("step-up protects %q, which this API does not serve%s. The gate "+
			"cannot fire for it, and an unfireable gate is indistinguishable from "+
			"a satisfied one.", route, hint)
	}
}

// TestEveryCredentialMintingRouteIsProtected is the REVERSE of
// TestEveryProtectedRouteExists, and it exists because that test could never
// have caught the defect this one does.
//
// The policy's own comment records that four of its six original entries named
// routes the API does not serve, so two thirds of the control was decoration.
// TestEveryProtectedRouteExists was written to stop that recurring — a policy
// entry pointing at nothing now breaks the build.
//
// The mirror-image failure is invisible to it: a REAL credential-minting route
// that no entry names. An unlisted route is not a broken entry, it is an absent
// one, and absence is exactly what a "does this entry resolve?" check cannot
// see. Three had accumulated that way — SCIM tokens, agent mandates and
// conversion ingest secrets — each shipping after the API-key rules were
// written, each handing over precisely what the policy's stated criterion
// covers: "durable, often long-lived access that outlives the session".
//
// The detector is a naming heuristic over the GENERATED manifest rather than a
// hand-kept list, so it is not self-referential: a new `POST /api/v1/x/tokens`
// is caught the moment the manifest regenerates, without anyone remembering to
// add it here. A route that legitimately matches and legitimately needs no
// step-up must be named in the exemption list below, with its reason — which
// makes the decision explicit instead of silent.
func TestEveryCredentialMintingRouteIsProtected(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "routeauth", "manifest.json"))
	if err != nil {
		t.Fatalf("read route manifest: %v", err)
	}
	var manifest struct {
		Routes []struct {
			Method string `json:"method"`
			Path   string `json:"path"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("decode route manifest: %v", err)
	}
	if len(manifest.Routes) < 500 {
		t.Fatalf("route manifest holds only %d routes; the check is measuring "+
			"almost nothing", len(manifest.Routes))
	}

	// Path suffixes that mint or re-mint a bearer credential. Kept narrow on
	// purpose: a broad pattern would sweep in reads and turn this into noise
	// that the next person silences.
	mintSuffixes := []string{
		"/api-keys",
		"/scim/tokens",
		"/agent-mandates",
		"/ingest-secrets",
	}
	// Routes that match the shape but hand over nothing durable. Each needs a
	// reason, so waiving one is a decision on the record.
	exempt := map[string]string{
		// Revocation moves in the SAFE direction: it removes access rather than
		// handing any over, which is the opposite of this policy's stated
		// criterion ("hands over durable, often long-lived access that outlives
		// the session"). Friction on the act that STOPS a leaked credential is
		// friction in the wrong place — the same reasoning that keeps a
		// type-to-confirm gate off the agent-mandate revoke on mobile.
		//
		// Note this matches the existing shape of the policy rather than
		// contradicting it: `DELETE /api/v1/api-keys/{id}` is likewise
		// unprotected. Workspace INVITE revocation is protected, and that is a
		// different act — it changes who can join, not who is locked out.
		"POST /api/v1/conversions/ingest-secrets/{keyID}/revoke": "revocation removes access; it hands over nothing",
	}

	var unprotected []string
	matched := 0
	for _, r := range manifest.Routes {
		if !strings.EqualFold(r.Method, "POST") {
			continue
		}
		hit := false
		for _, suffix := range mintSuffixes {
			if strings.HasSuffix(r.Path, suffix) || strings.Contains(r.Path, suffix+"/") {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		matched++
		key := "POST " + r.Path
		if _, ok := exempt[key]; ok {
			continue
		}
		if For("POST", r.Path) == (Requirement{}) {
			unprotected = append(unprotected, key)
		}
	}

	// Vacuity floor. If the suffixes stop matching anything — a rename, a
	// restructured manifest — this test would pass while checking nothing.
	if matched < 4 {
		t.Fatalf("only %d credential-minting routes matched; the heuristic has "+
			"stopped finding them and this test is no longer measuring anything",
			matched)
	}
	if len(unprotected) > 0 {
		t.Errorf("these routes mint a durable credential and require no step-up:\n  %s\n"+
			"Add a policy entry, or add an exemption with the reason it hands over "+
			"nothing lasting.", strings.Join(unprotected, "\n  "))
	}
}
