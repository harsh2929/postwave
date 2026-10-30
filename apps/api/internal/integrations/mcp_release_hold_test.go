// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"net/http"
	"strings"
	"testing"
)

func TestMCPIntegrationCatalogIsReleaseHeldSourceOnly(t *testing.T) {
	t.Parallel()

	item, ok := CatalogItemBySlug("mcp")
	if !ok {
		t.Fatal("mcp catalog item is missing")
	}
	if item.Badge != BadgePlanned || item.RuntimeStatus != RuntimePlanned || item.Native {
		t.Fatalf("mcp availability = badge:%q runtime:%q native:%v, want planned/planned/false", item.Badge, item.RuntimeStatus, item.Native)
	}
	if item.SetupPath != "" || len(item.Capabilities) != 0 {
		t.Fatalf("mcp advertises setup/capabilities: setup=%q capabilities=%v", item.SetupPath, item.Capabilities)
	}
	lower := strings.ToLower(item.Summary)
	for _, required := range []string{"release-held", "private evaluation", "no public distribution", "no", "governed-write"} {
		if !strings.Contains(lower, required) {
			t.Fatalf("mcp summary %q is missing %q", item.Summary, required)
		}
	}
	for _, forbidden := range []string{"expose postwave tools safely", "available to agent clients"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("mcp summary retains availability claim %q: %s", forbidden, item.Summary)
		}
	}

	response, status := lifecycleAction(item, "connect/start")
	if status != http.StatusConflict || response.Status != "unavailable" {
		t.Fatalf("lifecycle status = %d/%q, want 409/unavailable", status, response.Status)
	}
	if response.ManagePath != "" || response.DelegatedTo != "" {
		t.Fatalf("held lifecycle advertised action path: manage=%q delegated=%q", response.ManagePath, response.DelegatedTo)
	}
	if endpoint := delegatedEndpoint(item, "connect/start"); endpoint != "" {
		t.Fatalf("held MCP delegated endpoint = %q, want empty", endpoint)
	}
	if steps := SetupGuide(item); len(steps) != 0 {
		t.Fatalf("held MCP emitted setup steps: %+v", steps)
	}
	if modes := ContractFor(item).AuthModes; len(modes) != 0 {
		t.Fatalf("held MCP emitted auth modes: %v", modes)
	}
	for _, stack := range StackCoverage().Stacks {
		for _, component := range stack.Components {
			if component.Slug == "mcp" {
				t.Fatalf("held MCP remains an active stack component in %q: %+v", stack.Key, component)
			}
		}
	}
}
