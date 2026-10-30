package segments

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestCompileASTRejectsMalformedCanonicalShapes(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr string
	}{
		{
			name:    "unknown property",
			raw:     `{"op":"condition","field":"email","comparator":"equals","value":"a@example.com","surprise":true}`,
			wantErr: "unknown field",
		},
		{
			name:    "nested unknown property",
			raw:     `{"op":"and","children":[{"op":"condition","field":"email","comparator":"equals","value":"a@example.com","surprise":true}]}`,
			wantErr: "unknown field",
		},
		{
			name:    "trailing json",
			raw:     `{"op":"condition","field":"email","comparator":"is_not_null"} {"op":"condition"}`,
			wantErr: "trailing JSON",
		},
		{
			name:    "empty and",
			raw:     `{"op":"and","children":[]}`,
			wantErr: "requires non-empty children",
		},
		{
			name:    "empty or",
			raw:     `{"op":"or","children":[]}`,
			wantErr: "requires non-empty children",
		},
		{
			name:    "ambiguous not",
			raw:     `{"op":"not","child":{"op":"condition","field":"email","comparator":"is_not_null"},"children":[{"op":"condition","field":"email","comparator":"is_null"}]}`,
			wantErr: "exactly one child representation",
		},
		{
			name:    "not has no child",
			raw:     `{"op":"not"}`,
			wantErr: "exactly one child representation",
		},
		{
			name:    "legacy not has multiple children",
			raw:     `{"op":"not","children":[{"op":"condition","field":"email","comparator":"is_null"},{"op":"condition","field":"email","comparator":"is_not_null"}]}`,
			wantErr: "exactly one child",
		},
		{
			name:    "condition has children",
			raw:     `{"op":"condition","field":"email","comparator":"is_null","children":[]}`,
			wantErr: `property "children" is not allowed`,
		},
		{
			name:    "boolean has condition property",
			raw:     `{"op":"and","children":[{"op":"condition","field":"email","comparator":"is_null"}],"field":"email"}`,
			wantErr: `property "field" is not allowed`,
		},
		{
			name:    "condition missing field",
			raw:     `{"op":"condition","comparator":"is_null"}`,
			wantErr: "requires field",
		},
		{
			name:    "condition missing comparator",
			raw:     `{"op":"condition","field":"email"}`,
			wantErr: "requires comparator",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := CompileAST(json.RawMessage(tt.raw))
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("CompileAST error = %v, want substring %q", err, tt.wantErr)
			}
		})
	}
}

func TestCompileASTEnforcesStructuralBudgets(t *testing.T) {
	t.Run("depth accepts twelve and rejects thirteen", func(t *testing.T) {
		atLimit := nestedNotAST(maxSegmentASTDepth)
		if _, _, err := CompileAST(mustMarshalAST(t, atLimit)); err != nil {
			t.Fatalf("depth at limit rejected: %v", err)
		}

		tooDeep := nestedNotAST(maxSegmentASTDepth + 1)
		if _, _, err := CompileAST(mustMarshalAST(t, tooDeep)); err == nil || !strings.Contains(err.Error(), "maximum depth") {
			t.Fatalf("over-depth error = %v", err)
		}
	})

	t.Run("fanout", func(t *testing.T) {
		children := make([]any, 0, maxSegmentASTFanout+1)
		for range maxSegmentASTFanout + 1 {
			children = append(children, normalASTLeaf())
		}
		raw := mustMarshalAST(t, map[string]any{"op": "and", "children": children})
		if _, _, err := CompileAST(raw); err == nil || !strings.Contains(err.Error(), "maximum fanout") {
			t.Fatalf("over-fanout error = %v", err)
		}
	})

	t.Run("total nodes", func(t *testing.T) {
		// Root + four groups + 124 leaves = 129 nodes. Every individual
		// group stays within the 32-child fanout limit.
		groupSizes := []int{32, 32, 32, 28}
		groups := make([]any, 0, len(groupSizes))
		for _, size := range groupSizes {
			children := make([]any, 0, size)
			for range size {
				children = append(children, normalASTLeaf())
			}
			groups = append(groups, map[string]any{"op": "or", "children": children})
		}
		raw := mustMarshalAST(t, map[string]any{"op": "and", "children": groups})
		if _, _, err := CompileAST(raw); err == nil || !strings.Contains(err.Error(), "maximum node count") {
			t.Fatalf("over-node-count error = %v", err)
		}
	})

	t.Run("raw bytes", func(t *testing.T) {
		raw := json.RawMessage(bytes.Repeat([]byte{' '}, maxSegmentASTBytes+1))
		if _, _, err := CompileAST(raw); err == nil || !strings.Contains(err.Error(), "byte limit") {
			t.Fatalf("over-raw-byte error = %v", err)
		}
	})
}

func TestCompileASTEnforcesConditionPropertyBudgets(t *testing.T) {
	tests := []struct {
		name    string
		field   string
		compare string
		value   any
		wantErr string
	}{
		{
			name:    "field",
			field:   strings.Repeat("f", maxSegmentASTFieldBytes+1),
			compare: "equals",
			value:   "x",
			wantErr: "field exceeds",
		},
		{
			name:    "comparator",
			field:   "email",
			compare: strings.Repeat("c", maxSegmentASTComparatorBytes+1),
			value:   "x",
			wantErr: "comparator exceeds",
		},
		{
			name:    "value",
			field:   "email",
			compare: "equals",
			value:   strings.Repeat("v", maxSegmentASTValueBytes+1),
			wantErr: "condition value exceeds",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := mustMarshalAST(t, map[string]any{
				"op":         "condition",
				"field":      tt.field,
				"comparator": tt.compare,
				"value":      tt.value,
			})
			_, _, err := CompileAST(raw)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("CompileAST error = %v, want substring %q", err, tt.wantErr)
			}
		})
	}
}

func TestCompileASTAcceptsNormalCanonicalTreesAndValuelessComparators(t *testing.T) {
	raw := json.RawMessage(`{
		"op":"and",
		"children":[
			{"op":"condition","field":"last_opened_at","comparator":"never","value":null},
			{"op":"not","child":{"op":"condition","field":"last_clicked_at","comparator":"ever"}},
			{"op":"not","children":[{"op":"condition","field":"email","comparator":"is_null"}]}
		]
	}`)
	fragment, args, err := CompileAST(raw)
	if err != nil {
		t.Fatalf("CompileAST normal tree: %v", err)
	}
	if !strings.Contains(fragment, "last_opened_at") && !strings.Contains(fragment, "subscriber_events") {
		t.Fatalf("normal engagement tree did not compile: %s", fragment)
	}
	if len(args) != 0 {
		t.Fatalf("valueless comparators emitted args: %#v", args)
	}

	if _, _, err := CompileAST(nil); err != nil {
		t.Fatalf("legacy empty raw match-all sentinel rejected: %v", err)
	}
}

func TestCompileASTWithResolverUsesSameStructuralValidator(t *testing.T) {
	invalidRoot := json.RawMessage(`{"op":"condition","field":"email","comparator":"is_null","unknown":true}`)
	if _, _, err := CompileASTWithResolver(context.Background(), invalidRoot, "tenant-1", nil); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("resolver compiler accepted invalid root: %v", err)
	}

	resolver := &fakeSegmentResolver{asts: map[string]string{
		"seg-invalid": `{"op":"and","children":[]}`,
	}}
	outer := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-invalid"}`)
	if _, _, err := CompileASTWithResolver(context.Background(), outer, "tenant-1", resolver); err == nil || !strings.Contains(err.Error(), "non-empty children") {
		t.Fatalf("resolver compiler accepted invalid referenced AST: %v", err)
	}
}

func TestCompileASTWithResolverSharesExpandedNodeBudget(t *testing.T) {
	// The referenced tree is valid in isolation at exactly 128 nodes, but the
	// outer segment_id condition makes the expanded compilation 129 nodes.
	groupSizes := []int{32, 32, 32, 27}
	groups := make([]any, 0, len(groupSizes))
	for _, size := range groupSizes {
		children := make([]any, 0, size)
		for range size {
			children = append(children, normalASTLeaf())
		}
		groups = append(groups, map[string]any{"op": "or", "children": children})
	}
	referenced := mustMarshalAST(t, map[string]any{"op": "and", "children": groups})
	if _, _, err := CompileAST(referenced); err != nil {
		t.Fatalf("referenced tree should be valid in isolation: %v", err)
	}

	resolver := &fakeSegmentResolver{asts: map[string]string{"seg-large": string(referenced)}}
	outer := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-large"}`)
	if _, _, err := CompileASTWithResolver(context.Background(), outer, "tenant-1", resolver); err == nil || !strings.Contains(err.Error(), "maximum node count") {
		t.Fatalf("expanded-node-budget error = %v", err)
	}
}

func nestedNotAST(depth int) any {
	var node any = normalASTLeaf()
	for currentDepth := 1; currentDepth < depth; currentDepth++ {
		node = map[string]any{"op": "not", "child": node}
	}
	return node
}

func normalASTLeaf() map[string]any {
	return map[string]any{
		"op":         "condition",
		"field":      "email",
		"comparator": "is_not_null",
	}
}

func mustMarshalAST(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal AST: %v", err)
	}
	return raw
}
