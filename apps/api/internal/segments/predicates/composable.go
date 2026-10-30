// composable.go — GAP-LS-070: in_segment / not_in_segment.
//
// The predicate that lets one saved segment reference another:
// "subscribers who match Segment X AND who are in the Newsletter
// segment". Customer.io ships this 1-level (designed-in to
// prevent infinite recursion); Iterable allows nesting with a
// soft warning.
//
// We compile to a correlated subquery against the parent segment's
// stored predicate AST. Because the AST may itself reference
// in_segment, the resolver carries a depth counter and bails at
// MaxComposableDepth (=2) — matching Customer.io's hard cap and
// keeping the planner cost bounded.

package predicates

import (
	"fmt"
	"strings"
)

// MaxComposableDepth caps recursion when an in_segment predicate
// itself targets a segment that contains another in_segment.
const MaxComposableDepth = 2

// ComposableInput is the call shape.
type ComposableInput struct {
	// SegmentID is the uuid of the segment we are referencing.
	SegmentID string
	// Mode: "in_segment" / "not_in_segment".
	Mode string

	// PlaceholderOffset is the number of executable arguments already bound by
	// the parent compiler. Inner placeholders are shifted past that prefix.
	PlaceholderOffset int

	// InnerSQL is the compiled WHERE fragment of the referenced
	// segment. The caller is expected to load + compile the AST
	// once and pass it in — we do not import the compiler here
	// to keep the subpackage cycle-free.
	InnerSQL  string
	InnerArgs []any
}

// CompileComposable returns the WHERE fragment.
func CompileComposable(in ComposableInput) (Fragment, error) {
	id := strings.TrimSpace(in.SegmentID)
	if id == "" {
		return Fragment{}, fmt.Errorf("predicates: composable requires segment_id")
	}
	mode := strings.ToLower(strings.TrimSpace(in.Mode))
	if mode == "" {
		mode = "in_segment"
	}
	if mode != "in_segment" && mode != "not_in_segment" {
		return Fragment{}, fmt.Errorf("predicates: composable unknown mode %q", in.Mode)
	}

	off := in.PlaceholderOffset
	if off < 0 {
		off = 0
	}

	inner := strings.TrimSpace(in.InnerSQL)
	if inner == "" {
		inner = "TRUE"
	}
	// Shift the inner fragment's placeholders past arguments already bound by
	// the parent compiler. SegmentID was tenant-validated by the resolver and is
	// deliberately not emitted as an unused SQL parameter.
	shifted := shift(inner, off)

	args := append([]any(nil), in.InnerArgs...)

	// The composed fragment: subscribers.email IN (SELECT email
	// FROM subscribers WHERE <inner>). Using EXISTS for
	// correlated efficiency on large bases.
	op := "EXISTS"
	if mode == "not_in_segment" {
		op = "NOT EXISTS"
	}
	sql := fmt.Sprintf("%s (SELECT 1 FROM subscribers s2 WHERE s2.tenant_id = subscribers.tenant_id "+
		"AND s2.id = subscribers.id AND (%s))",
		op, shifted)
	return Fragment{SQL: sql, Args: args}, nil
}
