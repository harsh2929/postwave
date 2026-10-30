// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"encoding/json"
	"testing"
)

func TestManifest_sortedAndComplete(t *testing.T) {
	r := NewRegistry()
	r.Register(readSpec("zebra"))
	r.Register(readSpec("alpha"))
	r.Register(ToolSpec{Name: "wproxy", InputSchema: okSchema(), Description: "d",
		Annotations: Annotations{ReadOnly: true}, Surfaces: []Surface{SurfaceProxy}})

	m := r.Manifest()
	if len(m) != 3 {
		t.Fatalf("manifest should include every tool, got %d", len(m))
	}
	if m[0].Name != "alpha" || m[1].Name != "wproxy" || m[2].Name != "zebra" {
		t.Fatalf("manifest must be name-sorted, got %s,%s,%s", m[0].Name, m[1].Name, m[2].Name)
	}
	// empty Surfaces resolves to the executable pair, explicitly.
	if got := m[0].Surfaces; len(got) != 2 || got[0] != SurfaceAgent || got[1] != SurfaceMCP {
		t.Fatalf("empty surfaces should resolve to [agent mcp], got %v", got)
	}
	if m[1].Surfaces[0] != SurfaceProxy {
		t.Fatalf("proxy-only surface not preserved: %v", m[1].Surfaces)
	}
}

func TestManifestJSON_deterministic(t *testing.T) {
	r := NewRegistry()
	r.Register(readSpec("a"))
	r.Register(readSpec("b"))
	a, err := r.ManifestJSON()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := r.ManifestJSON()
	if string(a) != string(b) {
		t.Fatal("ManifestJSON must be deterministic")
	}
	// valid JSON, trailing newline (clean golden diffs).
	var probe []ManifestEntry
	if err := json.Unmarshal(a, &probe); err != nil {
		t.Fatalf("manifest is not valid JSON: %v", err)
	}
	if a[len(a)-1] != '\n' {
		t.Fatal("manifest should end with a newline")
	}
}
