package handlers

import (
	"encoding/json"
	"fmt"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// The public SDK and the MCP tool send triggers as {type, config} and nodes as
// {id, type, config}. canonical.AutomationTrigger and canonical.AutomationNode
// have NO config field -- their settings are flat (template_id,
// duration_seconds, list_id, ...). Decoding the wire shape straight into the
// canonical struct therefore keeps `type` and silently drops every setting the
// caller sent, which is the hand-mirrored-contract drift the ecosystem
// blueprint warns about, at the exact boundary where an agent hands over a
// graph.
//
// This adapter lifts config's keys to the top level before decoding. A key
// present at both levels keeps the top-level value: a caller that already
// speaks the flat canonical shape must not be overridden by a stray config.

type wireEdge struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Branch string `json:"branch,omitempty"`
}

type wireCreate struct {
	Name     string            `json:"name"`
	Triggers []json.RawMessage `json:"triggers"`
	Nodes    []json.RawMessage `json:"nodes"`
	Edges    []wireEdge        `json:"edges"`
}

type wireUpdate struct {
	Name     *string            `json:"name"`
	Status   *string            `json:"status"`
	Triggers *[]json.RawMessage `json:"triggers"`
	Nodes    *[]json.RawMessage `json:"nodes"`
	Edges    *[]wireEdge        `json:"edges"`
}

func flattenConfig(raw json.RawMessage) (json.RawMessage, error) {
	var top map[string]any
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, err
	}
	if cfg, ok := top["config"].(map[string]any); ok {
		for k, v := range cfg {
			if _, exists := top[k]; !exists {
				top[k] = v
			}
		}
	}
	delete(top, "config")
	return json.Marshal(top)
}

func decodeTriggers(raw []json.RawMessage) ([]canonical.AutomationTrigger, error) {
	out := make([]canonical.AutomationTrigger, 0, len(raw))
	for i, r := range raw {
		flat, err := flattenConfig(r)
		if err != nil {
			return nil, fmt.Errorf("triggers[%d]: %w", i, err)
		}
		var t canonical.AutomationTrigger
		if err := json.Unmarshal(flat, &t); err != nil {
			return nil, fmt.Errorf("triggers[%d]: %w", i, err)
		}
		out = append(out, t)
	}
	return out, nil
}

func decodeNodes(raw []json.RawMessage) ([]canonical.AutomationNode, error) {
	out := make([]canonical.AutomationNode, 0, len(raw))
	for i, r := range raw {
		flat, err := flattenConfig(r)
		if err != nil {
			return nil, fmt.Errorf("nodes[%d]: %w", i, err)
		}
		var n canonical.AutomationNode
		if err := json.Unmarshal(flat, &n); err != nil {
			return nil, fmt.Errorf("nodes[%d]: %w", i, err)
		}
		out = append(out, n)
	}
	return out, nil
}

// applyEdges converts wire edges to canonical ones and folds a `branch` label
// onto the source node. canonical.AutomationEdge has no branch field; the
// engine reads TrueNext/FalseNext on the branch node instead. Dropping the
// label would leave a branch node with two outgoing edges and no way to tell
// which is which -- the graph would decode cleanly and route wrongly.
func applyEdges(edges []wireEdge, nodes []canonical.AutomationNode) ([]canonical.AutomationEdge, error) {
	byID := make(map[string]*canonical.AutomationNode, len(nodes))
	for i := range nodes {
		byID[nodes[i].ID] = &nodes[i]
	}
	out := make([]canonical.AutomationEdge, 0, len(edges))
	for i, e := range edges {
		out = append(out, canonical.AutomationEdge{From: e.From, To: e.To})
		if e.Branch == "" {
			continue
		}
		src, ok := byID[e.From]
		if !ok {
			// Left for ValidateAutomationGraph, which names the dangling edge.
			continue
		}
		to := e.To
		switch e.Branch {
		case "true":
			src.TrueNext = &to
		case "false":
			src.FalseNext = &to
		default:
			return nil, fmt.Errorf("edges[%d]: branch must be \"true\" or \"false\", got %q", i, e.Branch)
		}
	}
	return out, nil
}
