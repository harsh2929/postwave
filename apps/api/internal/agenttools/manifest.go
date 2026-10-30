// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"encoding/json"
	"sort"
)

// ManifestEntry is the JSON-serializable projection of a ToolSpec (its
// Handler is a func and cannot be marshaled). The manifest is the
// machine-readable catalog that codegen emits and the audit:tools drift
// gate diffs — the single inspectable answer to "what tools exist, with
// what scopes, annotations, and schemas".
type ManifestEntry struct {
	Name           string          `json:"name"`
	Category       Category        `json:"category"`
	Description    string          `json:"description"`
	Surfaces       []Surface       `json:"surfaces"`
	RequiredScopes []string        `json:"required_scopes"`
	WriteTier      bool            `json:"write_tier"`
	LLMOutputSafe  bool            `json:"llm_output_safe"`
	ChargesSend    bool            `json:"charges_send,omitempty"`
	Annotations    Annotations     `json:"annotations"`
	InputSchema    json.RawMessage `json:"input_schema"`
	OutputSchema   json.RawMessage `json:"output_schema,omitempty"`
}

// Manifest returns every registered tool as a stable, name-sorted slice
// of ManifestEntry. Deterministic output (sorted names, normalized
// fields) is what makes the drift gate a clean diff.
func (r *Registry) Manifest() []ManifestEntry {
	out := make([]ManifestEntry, 0, len(r.order))
	for _, name := range r.order {
		t := r.byName[name]
		scopes := make([]string, 0, len(t.RequiredScopes))
		for _, s := range t.RequiredScopes {
			scopes = append(scopes, string(s))
		}
		out = append(out, ManifestEntry{
			Name:           t.Name,
			Category:       t.Category,
			Description:    t.Description,
			Surfaces:       effectiveSurfaces(t),
			RequiredScopes: scopes,
			WriteTier:      t.WriteTier,
			LLMOutputSafe:  t.LLMOutputSafe,
			ChargesSend:    t.ChargesSend,
			Annotations:    t.Annotations,
			InputSchema:    t.InputSchema,
			OutputSchema:   t.OutputSchema,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ManifestJSON returns the manifest as indented JSON with a trailing
// newline, suitable for writing to a golden file and diffing.
func (r *Registry) ManifestJSON() ([]byte, error) {
	b, err := json.MarshalIndent(r.Manifest(), "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// effectiveSurfaces resolves the implicit "empty == executable surfaces"
// rule into the concrete list, so the manifest is unambiguous.
func effectiveSurfaces(t *ToolSpec) []Surface {
	if len(t.Surfaces) > 0 {
		out := append([]Surface(nil), t.Surfaces...)
		sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
		return out
	}
	return []Surface{SurfaceAgent, SurfaceMCP}
}
