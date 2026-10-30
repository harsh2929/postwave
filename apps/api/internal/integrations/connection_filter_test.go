// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"net/http/httptest"
	"testing"
)

func filterWith(t *testing.T, query string, items []Connection) []Connection {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/v1/integrations/connections?"+query, nil)
	return filterConnections(items, r)
}

func slugsOf(items []Connection) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Slug)
	}
	return out
}

func sampleConnections() []Connection {
	return []Connection{
		// Connected and clean.
		{Slug: "shopify", Name: "Shopify", Category: "commerce", Connected: true, Count: 2, HealthState: "healthy", RuntimeStatus: RuntimeStatus("connected")},
		// Not connected, but broken loudly — the row an operator opens the
		// screen to find, and the reason `footprint` is not just `connected`.
		{Slug: "hubspot", Name: "HubSpot", Category: "crm", Connected: false, Count: 0, LastError: "401 from provider", HealthState: "action_required", RuntimeStatus: RuntimeStatus("error")},
		// Rows exist but the connected flag is off.
		{Slug: "pipedrive", Name: "Pipedrive", Category: "crm", Connected: false, Count: 1, HealthState: "needs_attention", RuntimeStatus: RuntimeStatus("degraded")},
		// Pure catalog filler: the ~99% this endpoint used to ship anyway.
		{Slug: "ebay", Name: "eBay", Category: "commerce", Connected: false, Count: 0, HealthState: "not_configured", RuntimeStatus: RuntimeStatus("available")},
		{Slug: "zendesk", Name: "Zendesk", Category: "support", Connected: false, Count: 0, HealthState: "planned", RuntimeStatus: RuntimeStatus("planned")},
	}
}

func TestFilterConnectionsNoParamsIsIdentity(t *testing.T) {
	items := sampleConnections()
	got := filterWith(t, "", items)
	if len(got) != len(items) {
		t.Fatalf("no-parameter call must be byte-for-byte the old behaviour: got %d rows, want %d", len(got), len(items))
	}
	for i := range got {
		if got[i].Slug != items[i].Slug {
			t.Fatalf("order changed at %d: got %q want %q", i, got[i].Slug, items[i].Slug)
		}
	}
}

func TestFilterConnectionsFootprint(t *testing.T) {
	got := slugsOf(filterWith(t, "footprint=1", sampleConnections()))
	want := []string{"shopify", "hubspot", "pipedrive"}
	if len(got) != len(want) {
		t.Fatalf("footprint=1 got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("footprint=1 got %v, want %v", got, want)
		}
	}
}

// The mobile health screen's local predicate and the server's must agree, or
// the payload shrinks by more than the client expected and rows vanish.
func TestFootprintMatchesClientPredicate(t *testing.T) {
	for _, c := range sampleConnections() {
		clientKeeps := c.Connected || c.Count > 0 || c.LastError != ""
		if hasTenantFootprint(c) != clientKeeps {
			t.Fatalf("%s: server footprint=%v, client predicate=%v", c.Slug, hasTenantFootprint(c), clientKeeps)
		}
	}
}

func TestFilterConnectionsConnectedIsTriState(t *testing.T) {
	items := sampleConnections()
	if got := len(filterWith(t, "connected=true", items)); got != 1 {
		t.Fatalf("connected=true got %d, want 1", got)
	}
	if got := len(filterWith(t, "connected=false", items)); got != 4 {
		t.Fatalf("connected=false got %d, want 4", got)
	}
	// An EMPTY parameter must not read as false — that would hide every
	// connected row for a caller who merely built the URL loosely.
	if got := len(filterWith(t, "connected=", items)); got != len(items) {
		t.Fatalf("connected= (empty) got %d, want the full %d", got, len(items))
	}
}

func TestFilterConnectionsQueryAndCategory(t *testing.T) {
	items := sampleConnections()
	// Case-insensitive, and matches the catalog's own casing of "eBay".
	if got := slugsOf(filterWith(t, "q=EBAY", items)); len(got) != 1 || got[0] != "ebay" {
		t.Fatalf("q=EBAY got %v, want [ebay]", got)
	}
	// Category is one of the searchable fields too.
	if got := len(filterWith(t, "q=crm", items)); got != 2 {
		t.Fatalf("q=crm got %d, want 2", got)
	}
	if got := len(filterWith(t, "category=CRM", items)); got != 2 {
		t.Fatalf("category=CRM got %d, want 2", got)
	}
}

func TestFilterConnectionsHealthAndStatusSets(t *testing.T) {
	items := sampleConnections()
	if got := len(filterWith(t, "health=action_required,needs_attention", items)); got != 2 {
		t.Fatalf("health set got %d, want 2", got)
	}
	if got := len(filterWith(t, "status=error", items)); got != 1 {
		t.Fatalf("status=error got %d, want 1", got)
	}
	// A parameter of nothing but separators is "no filter", not "match none".
	if got := len(filterWith(t, "health=,,", items)); got != len(items) {
		t.Fatalf("health=,, got %d, want the full %d", got, len(items))
	}
}

func TestFilterConnectionsCombinesWithAnd(t *testing.T) {
	got := slugsOf(filterWith(t, "footprint=1&category=crm", sampleConnections()))
	if len(got) != 2 || got[0] != "hubspot" || got[1] != "pipedrive" {
		t.Fatalf("footprint+category got %v, want [hubspot pipedrive]", got)
	}
	if got := len(filterWith(t, "footprint=1&connected=true", sampleConnections())); got != 1 {
		t.Fatalf("footprint+connected got %d, want 1", got)
	}
}

func TestFilterConnectionsUnmatchedFilterReturnsEmptyNotAll(t *testing.T) {
	// ABSENCE IS NOT EVERYTHING: a filter nothing matches must return zero
	// rows, never fall through to the unfiltered list.
	if got := filterWith(t, "category=nonexistent", sampleConnections()); len(got) != 0 {
		t.Fatalf("unmatched category returned %d rows, want 0", len(got))
	}
}

func TestParseBoolParam(t *testing.T) {
	cases := map[string]struct {
		value   bool
		present bool
	}{
		"1": {true, true}, "true": {true, true}, "TRUE": {true, true},
		"yes": {true, true}, "on": {true, true},
		"0": {false, true}, "false": {false, true}, "no": {false, true}, "off": {false, true},
		"": {false, false}, "maybe": {false, false}, " ": {false, false},
	}
	for raw, want := range cases {
		value, present := parseBoolParam(raw)
		if value != want.value || present != want.present {
			t.Fatalf("parseBoolParam(%q) = (%v,%v), want (%v,%v)", raw, value, present, want.value, want.present)
		}
	}
}
