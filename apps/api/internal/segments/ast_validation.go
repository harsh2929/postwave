package segments

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Canonical segment AST limits are deliberately lower than the HTTP body
// limits. Segment trees are compiled into SQL and may also be recursively
// expanded by composable segments, so accepting an arbitrarily large or
// deeply nested tree would turn a small request into disproportionate parser
// and query-planner work.
const (
	maxSegmentASTBytes           = 64 << 10
	maxSegmentASTDepth           = 12
	maxSegmentASTFanout          = 32
	maxSegmentASTNodes           = 128
	maxSegmentASTFieldBytes      = 256
	maxSegmentASTComparatorBytes = 64
	maxSegmentASTValueBytes      = 16 << 10
)

// rawASTNode keeps presence information for every property. That is needed
// for exact shape validation: decoding straight into astNode cannot
// distinguish an omitted property from, for example, "children": null.
type rawASTNode struct {
	Op         json.RawMessage `json:"op"`
	Children   json.RawMessage `json:"children"`
	Child      json.RawMessage `json:"child"`
	Field      json.RawMessage `json:"field"`
	Comparator json.RawMessage `json:"comparator"`
	Value      json.RawMessage `json:"value"`
}

type segmentASTValidationState struct {
	nodes    int
	rawBytes int
}

// decodeAndValidateSegmentAST is the single structural boundary for every
// canonical segment AST before SQL compilation. Empty input remains a
// supported internal match-all sentinel for legacy callers; a present JSON
// tree must satisfy the canonical, non-empty node grammar.
func decodeAndValidateSegmentAST(raw json.RawMessage) (astNode, bool, error) {
	return decodeAndValidateSegmentASTWithState(raw, &segmentASTValidationState{})
}

// decodeAndValidateSegmentASTWithState lets composable-segment expansion
// share the same byte and node budget as its parent. Without a shared state,
// a small root containing many segment references could expand into thousands
// of individually valid nodes before reaching PostgreSQL.
func decodeAndValidateSegmentASTWithState(raw json.RawMessage, state *segmentASTValidationState) (astNode, bool, error) {
	if len(raw) == 0 {
		return astNode{}, false, nil
	}
	if len(raw) > maxSegmentASTBytes || state.rawBytes > maxSegmentASTBytes-len(raw) {
		return astNode{}, false, fmt.Errorf("segments: ast exceeds %d-byte limit", maxSegmentASTBytes)
	}
	state.rawBytes += len(raw)

	node, err := decodeAndValidateSegmentASTNode(raw, 1, state)
	if err != nil {
		return astNode{}, false, err
	}
	return node, true, nil
}

func decodeAndValidateSegmentASTNode(raw json.RawMessage, depth int, state *segmentASTValidationState) (astNode, error) {
	if depth > maxSegmentASTDepth {
		return astNode{}, fmt.Errorf("segments: ast exceeds maximum depth %d", maxSegmentASTDepth)
	}
	state.nodes++
	if state.nodes > maxSegmentASTNodes {
		return astNode{}, fmt.Errorf("segments: ast exceeds maximum node count %d", maxSegmentASTNodes)
	}

	var wire rawASTNode
	if err := decodeSingleStrictJSON(raw, &wire); err != nil {
		return astNode{}, fmt.Errorf("segments: decode ast node: %w", err)
	}
	op, err := requiredASTString("op", wire.Op, 16)
	if err != nil {
		return astNode{}, err
	}
	op = strings.ToLower(op)

	switch op {
	case "and", "or":
		if err := rejectASTProperties(wire, "child", "field", "comparator", "value"); err != nil {
			return astNode{}, fmt.Errorf("segments: %s node: %w", op, err)
		}
		if len(wire.Children) == 0 {
			return astNode{}, fmt.Errorf("segments: %s node requires non-empty children", op)
		}
		children, err := decodeASTChildren(wire.Children)
		if err != nil {
			return astNode{}, fmt.Errorf("segments: %s node children: %w", op, err)
		}
		if len(children) == 0 {
			return astNode{}, fmt.Errorf("segments: %s node requires non-empty children", op)
		}
		if len(children) > maxSegmentASTFanout {
			return astNode{}, fmt.Errorf("segments: %s node exceeds maximum fanout %d", op, maxSegmentASTFanout)
		}

		node := astNode{Op: op, Children: make([]astNode, 0, len(children))}
		for index, childRaw := range children {
			child, err := decodeAndValidateSegmentASTNode(childRaw, depth+1, state)
			if err != nil {
				return astNode{}, fmt.Errorf("segments: %s child %d: %w", op, index, err)
			}
			node.Children = append(node.Children, child)
		}
		return node, nil

	case "not":
		if err := rejectASTProperties(wire, "field", "comparator", "value"); err != nil {
			return astNode{}, fmt.Errorf("segments: not node: %w", err)
		}
		hasChild := len(wire.Child) > 0
		hasChildren := len(wire.Children) > 0
		if hasChild == hasChildren {
			return astNode{}, fmt.Errorf("segments: not node requires exactly one child representation")
		}

		childRaw := wire.Child
		legacyChildren := false
		if hasChildren {
			children, err := decodeASTChildren(wire.Children)
			if err != nil {
				return astNode{}, fmt.Errorf("segments: not node children: %w", err)
			}
			if len(children) != 1 {
				return astNode{}, fmt.Errorf("segments: not node children representation requires exactly one child")
			}
			childRaw = children[0]
			legacyChildren = true
		}
		child, err := decodeAndValidateSegmentASTNode(childRaw, depth+1, state)
		if err != nil {
			return astNode{}, fmt.Errorf("segments: not child: %w", err)
		}
		if legacyChildren {
			// Preserve the legacy one-element children representation for the
			// existing compiler path while still enforcing a single child.
			return astNode{Op: op, Children: []astNode{child}}, nil
		}
		return astNode{Op: op, Child: &child}, nil

	case "condition":
		if err := rejectASTProperties(wire, "children", "child"); err != nil {
			return astNode{}, fmt.Errorf("segments: condition node: %w", err)
		}
		field, err := requiredASTString("field", wire.Field, maxSegmentASTFieldBytes)
		if err != nil {
			return astNode{}, fmt.Errorf("segments: condition node: %w", err)
		}
		comparator, err := requiredASTString("comparator", wire.Comparator, maxSegmentASTComparatorBytes)
		if err != nil {
			return astNode{}, fmt.Errorf("segments: condition node: %w", err)
		}
		if len(wire.Value) > maxSegmentASTValueBytes {
			return astNode{}, fmt.Errorf("segments: condition value exceeds %d-byte limit", maxSegmentASTValueBytes)
		}
		return astNode{
			Op:         op,
			Field:      field,
			Comparator: comparator,
			Value:      wire.Value,
		}, nil

	default:
		return astNode{}, fmt.Errorf("segments: unknown op %q", op)
	}
}

func decodeSingleStrictJSON(raw []byte, dst any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return fmt.Errorf("trailing JSON: %w", err)
	}
	return nil
}

func requiredASTString(name string, raw json.RawMessage, maxBytes int) (string, error) {
	if len(raw) == 0 {
		return "", fmt.Errorf("segments: ast node requires %s", name)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("segments: ast node %s must be a string", name)
	}
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("segments: ast node requires non-empty %s", name)
	}
	if len(value) > maxBytes {
		return "", fmt.Errorf("segments: ast node %s exceeds %d-byte limit", name, maxBytes)
	}
	return value, nil
}

func rejectASTProperties(node rawASTNode, names ...string) error {
	for _, name := range names {
		var raw json.RawMessage
		switch name {
		case "children":
			raw = node.Children
		case "child":
			raw = node.Child
		case "field":
			raw = node.Field
		case "comparator":
			raw = node.Comparator
		case "value":
			raw = node.Value
		}
		if len(raw) > 0 {
			return fmt.Errorf("property %q is not allowed", name)
		}
	}
	return nil
}

func decodeASTChildren(raw json.RawMessage) ([]json.RawMessage, error) {
	var children []json.RawMessage
	if err := json.Unmarshal(raw, &children); err != nil {
		return nil, fmt.Errorf("must be an array: %w", err)
	}
	return children, nil
}
