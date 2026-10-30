// SPDX-License-Identifier: AGPL-3.0-only

package inbound_email

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestGlobMatch_NoWildcard(t *testing.T) {
	cases := []struct {
		pat, cand string
		want      bool
	}{
		{"support@acme.com", "support@acme.com", true},
		{"support@acme.com", "SUPPORT@ACME.COM", true}, // case-insensitive
		{"support@acme.com", "sales@acme.com", false},
		{"", "", true}, // empty pattern, empty candidate
		{"", "anything", false},
	}
	for _, c := range cases {
		if got := globMatch(c.pat, c.cand); got != c.want {
			t.Errorf("globMatch(%q,%q)=%v want %v", c.pat, c.cand, got, c.want)
		}
	}
}

func TestGlobMatch_BareSplat(t *testing.T) {
	// "*" alone matches anything (including empty).
	if !globMatch("*", "anything") {
		t.Error("'*' did not match 'anything'")
	}
	if !globMatch("*", "") {
		t.Error("'*' did not match empty string")
	}
}

func TestGlobMatch_PrefixSplat(t *testing.T) {
	cases := []struct {
		pat, cand string
		want      bool
	}{
		// "*@acme.com" — any local-part at acme.com.
		{"*@acme.com", "support@acme.com", true},
		{"*@acme.com", "sales@acme.com", true},
		{"*@acme.com", "support@other.com", false},
		// Case-insensitive suffix.
		{"*@acme.com", "Support@ACME.com", true},
	}
	for _, c := range cases {
		if got := globMatch(c.pat, c.cand); got != c.want {
			t.Errorf("globMatch(%q,%q)=%v want %v", c.pat, c.cand, got, c.want)
		}
	}
}

func TestGlobMatch_SuffixSplat(t *testing.T) {
	cases := []struct {
		pat, cand string
		want      bool
	}{
		// "support@*" — support@anything.
		{"support@*", "support@acme.com", true},
		{"support@*", "support@other.org", true},
		{"support@*", "sales@acme.com", false},
		{"support@*", "support", false}, // no '@' → no match for the literal prefix
	}
	for _, c := range cases {
		if got := globMatch(c.pat, c.cand); got != c.want {
			t.Errorf("globMatch(%q,%q)=%v want %v", c.pat, c.cand, got, c.want)
		}
	}
}

func TestGlobMatch_MiddleSplat(t *testing.T) {
	cases := []struct {
		pat, cand string
		want      bool
	}{
		// "*@*.com" — anything-at-anything.com (two splats).
		{"*@*.com", "support@acme.com", true},
		{"*@*.com", "sales@sub.acme.com", true},
		{"*@*.com", "support@acme.org", false},
		// Order matters — "ab*cd" requires ab before cd.
		{"ab*cd", "abxxcd", true},
		{"ab*cd", "cdab", false},
	}
	for _, c := range cases {
		if got := globMatch(c.pat, c.cand); got != c.want {
			t.Errorf("globMatch(%q,%q)=%v want %v", c.pat, c.cand, got, c.want)
		}
	}
}

func TestDomainOf(t *testing.T) {
	cases := []struct{ in, want string }{
		{"alice@example.com", "example.com"},
		{"alice@SUB.example.com", "sub.example.com"},
		{"no-at-sign", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := domainOf(c.in); got != c.want {
			t.Errorf("domainOf(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

// matchesRoute is the predicate MatchRoutes uses per-row. Tests
// confirm the three match dimensions (recipient glob, subject prefix,
// from-domain) compose correctly with each "specified" being AND.
func TestMatchesRoute_AllDimensions(t *testing.T) {
	r := Route{
		MatchRecipient:     "support@*",
		MatchSubjectPrefix: "[urgent]",
		MatchFromDomain:    "acme.com",
	}
	// Note: the public MatchRoutes pre-resolves the from-email's
	// domain via domainOf() before calling routeMatches — so this
	// predicate takes the DOMAIN, not the full email.
	if !routeMatches(r, "support@us.io", "[urgent] downtime", "acme.com") {
		t.Error("expected match on full happy path")
	}
	if routeMatches(r, "sales@us.io", "[urgent] downtime", "acme.com") {
		t.Error("recipient mismatch should fail")
	}
	if routeMatches(r, "support@us.io", "fyi", "acme.com") {
		t.Error("subject mismatch should fail")
	}
	if routeMatches(r, "support@us.io", "[urgent] downtime", "other.com") {
		t.Error("from-domain mismatch should fail")
	}
}

func TestMatchesRoute_OmittedFieldsAreWildcards(t *testing.T) {
	// All-empty route matches everything.
	r := Route{}
	if !routeMatches(r, "anything@x.com", "anything", "y.com") {
		t.Error("empty route should match anything")
	}
	// Only one dimension constrained.
	r2 := Route{MatchSubjectPrefix: "[urgent]"}
	if !routeMatches(r2, "x@y.com", "[urgent] hi", "b.com") {
		t.Error("subject-only constrained route did not match")
	}
	if routeMatches(r2, "x@y.com", "fyi", "b.com") {
		t.Error("subject-only constrained route falsely matched non-prefix")
	}
}

func TestRedactRouteActionSecretsWithholdsPlaintext(t *testing.T) {
	original := []RouteAction{{
		Kind:  "webhook",
		URL:   "https://hooks.example.test/inbound",
		Extra: map[string]any{"hmac_secret": "server-only", "custom": "safe"},
	}}
	projected := redactRouteActionSecrets(original)
	if len(projected) != 1 || !projected[0].HasStoredHMACSecret {
		t.Fatalf("redacted action = %#v, want stored-secret marker", projected)
	}
	if _, exposed := projected[0].Extra["hmac_secret"]; exposed {
		t.Fatal("redacted action exposed hmac_secret")
	}
	if projected[0].Extra["custom"] != "safe" {
		t.Fatalf("redacted action lost safe extra: %#v", projected[0].Extra)
	}
	if original[0].Extra["hmac_secret"] != "server-only" {
		t.Fatal("redaction mutated the executor's stored action")
	}
	wire, err := json.Marshal(projected)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}
	if strings.Contains(string(wire), "server-only") || strings.Contains(string(wire), "\"hmac_secret\"") {
		t.Fatalf("redacted wire leaked signing material: %s", wire)
	}
}

func TestMergeUpdatedRouteActionSecretsPreserveReplaceAndRemove(t *testing.T) {
	revision := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	existing := []RouteAction{{
		Kind:  "webhook",
		URL:   "https://old.example.test",
		Extra: map[string]any{"hmac_secret": "stored-secret", "old": true},
	}}
	source := 0
	preserved, err := mergeUpdatedRouteActionSecrets([]RouteAction{{
		Kind:                  "webhook",
		URL:                   "https://new.example.test",
		Extra:                 map[string]any{"custom": "safe"},
		PreserveHMACFromIndex: &source,
	}}, existing, &revision, revision)
	if err != nil {
		t.Fatalf("preserve: %v", err)
	}
	if preserved[0].Extra["hmac_secret"] != "stored-secret" || preserved[0].PreserveHMACFromIndex != nil {
		t.Fatalf("preserved action = %#v", preserved[0])
	}

	replaced, err := mergeUpdatedRouteActionSecrets([]RouteAction{{
		Kind:  "webhook",
		URL:   "https://new.example.test",
		Extra: map[string]any{"hmac_secret": "replacement"},
	}}, existing, &revision, revision)
	if err != nil || replaced[0].Extra["hmac_secret"] != "replacement" {
		t.Fatalf("replacement = %#v, err=%v", replaced, err)
	}

	removed, err := mergeUpdatedRouteActionSecrets([]RouteAction{{
		Kind:             "webhook",
		URL:              "https://new.example.test",
		Extra:            map[string]any{"custom": "safe"},
		RemoveStoredHMAC: true,
	}}, existing, &revision, revision)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, present := removed[0].Extra["hmac_secret"]; present || removed[0].RemoveStoredHMAC {
		t.Fatalf("removed action retained secret/control: %#v", removed[0])
	}
}

func TestMergeUpdatedRouteActionSecretsRejectsInvalidSource(t *testing.T) {
	revision := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	missing := 2
	_, err := mergeUpdatedRouteActionSecrets([]RouteAction{{
		Kind:                  "webhook",
		URL:                   "https://hooks.example.test",
		PreserveHMACFromIndex: &missing,
	}}, []RouteAction{{Kind: "store_only"}}, &revision, revision)
	if err == nil || !strings.Contains(err.Error(), "source") {
		t.Fatalf("invalid source error = %v", err)
	}
}

func TestMergeUpdatedRouteActionSecretsRejectsStaleIndexRevision(t *testing.T) {
	reviewedAt := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	currentAt := reviewedAt.Add(time.Second)
	source := 0
	// Another administrator reordered two webhook actions after the stale
	// caller reviewed index zero. Without the revision fence, the preservation
	// marker would silently attach beta-secret to the alpha action.
	current := []RouteAction{
		{Kind: "webhook", URL: "https://beta.example.test", Extra: map[string]any{"hmac_secret": "beta-secret"}},
		{Kind: "webhook", URL: "https://alpha.example.test", Extra: map[string]any{"hmac_secret": "alpha-secret"}},
	}
	merged, err := mergeUpdatedRouteActionSecrets([]RouteAction{{
		Kind:                  "webhook",
		URL:                   "https://alpha.example.test",
		PreserveHMACFromIndex: &source,
	}}, current, &reviewedAt, currentAt)
	if !errors.Is(err, errRouteConfigurationChanged) || merged != nil {
		t.Fatalf("stale merge = %#v, err=%v; want route configuration conflict", merged, err)
	}
}
