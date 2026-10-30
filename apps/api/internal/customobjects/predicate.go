// SPDX-License-Identifier: AGPL-3.0-only
//
// predicate.go — segment predicate plug-in. The segments compiler
// asks this package for the SQL fragment that lets a segment
// predicate of the form
//
//   {category: "custom_object",
//    object_type: "order",
//    property: "total",
//    comparator: "gte",
//    value: 100}
//
// resolve to a SELECT against custom_object_records. The fragment is
// always parameterised — we never inline customer values into SQL.
//
// Why a separate file: this is the only place that knows the JSON
// path syntax (`properties->>$N`) we use to extract a record
// property. Keeping it here avoids the segments package importing
// custom-object internals; the segments package can stay schema-
// agnostic and ask this package for a fragment.

package customobjects

import (
	"errors"
	"fmt"
	"strings"
)

// PredicateSpec is the input shape — what a segment editor or the
// segments compiler hands to BuildSegmentPredicate.
type PredicateSpec struct {
	// ObjectTypeKey is the type's `key` field (e.g. "order").
	ObjectTypeKey string
	// Property is the property name inside the record's properties
	// jsonb. Dotted paths (e.g. "address.country") expand to the
	// jsonb #>> operator with the path-array form.
	Property string
	// Comparator is one of: eq, neq, gt, gte, lt, lte, contains,
	// not_contains, in, not_in, exists, not_exists.
	Comparator string
	// Value is the raw value the comparator operates against. For
	// "in"/"not_in" the value is a comma-separated list. For
	// "exists"/"not_exists" the value is ignored.
	Value string
	// LinkedToProfile scopes the EXISTS subquery to records that are
	// linked to the subscriber being evaluated, via profile_object_links
	// (SUB-011). When false (the default, preserving the historic
	// behaviour) the predicate matches any record of the type in the
	// tenant. When true the predicate additionally joins
	// profile_object_links so a segment like "subscribers linked to an
	// order with total >= 100" resolves against the subscriber's own
	// linked records — making profile object links queryable in
	// segmentation. The join keys on the outer `subscribers.id` row the
	// segments compiler scans, so the fragment must be embedded in a
	// query that exposes a `subscribers` row (it always is — segment
	// predicates compile to a WHERE over subscribers).
	LinkedToProfile bool
}

// PredicateFragment is the compiler-friendly result. SQL is a
// parameterised fragment using $1, $2, ... placeholders relative to
// the supplied Args slice. The segments compiler concatenates
// fragments with AND/OR and renumbers placeholders before submit.
type PredicateFragment struct {
	SQL  string
	Args []any
}

// validComparators is the closed set we accept. Unknown operators
// produce a build error rather than a malformed SQL fragment.
var validComparators = map[string]struct{}{
	"eq":           {},
	"neq":          {},
	"gt":           {},
	"gte":          {},
	"lt":           {},
	"lte":          {},
	"contains":     {},
	"not_contains": {},
	"in":           {},
	"not_in":       {},
	"exists":       {},
	"not_exists":   {},
}

// BuildSegmentPredicate produces the SQL the segments compiler
// embeds. The fragment selects subscribers (or, when called from a
// "have a custom object" predicate, returns a 1/0 EXISTS test) whose
// tenant has at least one custom_object_record matching the spec.
//
// The fragment is a complete `EXISTS(...)` subquery so callers can
// AND it directly into a WHERE clause without bracketing.
//
// Example output for {ObjectTypeKey: "order", Property: "total",
// Comparator: "gte", Value: "100"}:
//
//	EXISTS (
//	  SELECT 1 FROM custom_object_records r
//	    JOIN custom_object_types t ON t.id = r.object_type_id
//	   WHERE r.tenant_id = subscribers.tenant_id
//	     AND t.key = $1
//	     AND (r.properties->>$2)::numeric >= $3::numeric
//	)
//
// Args: ["order", "total", "100"].
func BuildSegmentPredicate(spec PredicateSpec) (PredicateFragment, error) {
	if spec.ObjectTypeKey == "" {
		return PredicateFragment{}, errors.New("customobjects: object_type_key required")
	}
	if _, ok := validComparators[spec.Comparator]; !ok {
		return PredicateFragment{}, fmt.Errorf("customobjects: unknown comparator %q", spec.Comparator)
	}
	if spec.Property == "" && spec.Comparator != "exists" && spec.Comparator != "not_exists" {
		return PredicateFragment{}, errors.New("customobjects: property required unless comparator is exists/not_exists")
	}

	args := []any{spec.ObjectTypeKey}
	var clause string
	switch spec.Comparator {
	case "exists":
		clause = ""
	case "not_exists":
		// "There is NO record of this type for the subscriber". The
		// caller wraps in NOT EXISTS instead of EXISTS; we emit the
		// inner SELECT and let the wrapper invert.
		return PredicateFragment{
			SQL:  existsTemplate("", "NOT EXISTS", spec.LinkedToProfile),
			Args: args,
		}, nil
	case "eq":
		args = append(args, spec.Property, spec.Value)
		clause = fmt.Sprintf("AND %s = $%d", propertyAccessor("r", spec.Property, 2), len(args))
	case "neq":
		args = append(args, spec.Property, spec.Value)
		clause = fmt.Sprintf("AND %s <> $%d", propertyAccessor("r", spec.Property, 2), len(args))
	case "gt", "gte", "lt", "lte":
		op := comparatorToSQL(spec.Comparator)
		args = append(args, spec.Property, spec.Value)
		clause = fmt.Sprintf("AND (%s)::numeric %s $%d::numeric",
			propertyAccessor("r", spec.Property, 2), op, len(args))
	case "contains":
		args = append(args, spec.Property, "%"+spec.Value+"%")
		clause = fmt.Sprintf("AND %s ILIKE $%d", propertyAccessor("r", spec.Property, 2), len(args))
	case "not_contains":
		args = append(args, spec.Property, "%"+spec.Value+"%")
		clause = fmt.Sprintf("AND %s NOT ILIKE $%d", propertyAccessor("r", spec.Property, 2), len(args))
	case "in":
		values := strings.Split(spec.Value, ",")
		args = append(args, spec.Property)
		placeholders := make([]string, 0, len(values))
		for _, v := range values {
			args = append(args, strings.TrimSpace(v))
			placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
		}
		clause = fmt.Sprintf("AND %s IN (%s)", propertyAccessor("r", spec.Property, 2), strings.Join(placeholders, ","))
	case "not_in":
		values := strings.Split(spec.Value, ",")
		args = append(args, spec.Property)
		placeholders := make([]string, 0, len(values))
		for _, v := range values {
			args = append(args, strings.TrimSpace(v))
			placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
		}
		clause = fmt.Sprintf("AND %s NOT IN (%s)", propertyAccessor("r", spec.Property, 2), strings.Join(placeholders, ","))
	}

	return PredicateFragment{
		SQL:  existsTemplate(clause, "EXISTS", spec.LinkedToProfile),
		Args: args,
	}, nil
}

// existsTemplate returns the parameterised EXISTS subquery. The
// caller-provided clause is appended inside the WHERE — empty when
// the predicate only tests for record presence.
//
// linkedToProfile (SUB-011) adds a join through profile_object_links so the
// subquery only matches records linked to the subscriber row the segments
// compiler is scanning (subscribers.id). Without it the subquery matches any
// record of the type in the tenant (the historic, tenant-wide behaviour).
func existsTemplate(extraClause, existsKeyword string, linkedToProfile bool) string {
	if linkedToProfile {
		return fmt.Sprintf(`%s (
  SELECT 1
    FROM profile_object_links pol
    JOIN custom_object_records r ON r.id = pol.object_record_id
    JOIN custom_object_types t ON t.id = r.object_type_id
   WHERE pol.tenant_id = subscribers.tenant_id
     AND pol.subscriber_id = subscribers.id
     AND t.key = $1
     %s
)`, existsKeyword, extraClause)
	}
	return fmt.Sprintf(`%s (
  SELECT 1
    FROM custom_object_records r
    JOIN custom_object_types t ON t.id = r.object_type_id
   WHERE r.tenant_id = subscribers.tenant_id
     AND t.key = $1
     %s
)`, existsKeyword, extraClause)
}

// propertyAccessor returns the SQL fragment that extracts a property
// from r.properties. Dotted paths use #>> with a placeholder text[]
// array; single-property paths use ->> with a placeholder text.
// argIndex is the 1-based placeholder ordinal where the property
// name lands.
func propertyAccessor(table, property string, argIndex int) string {
	if strings.Contains(property, ".") {
		// jsonb path access: properties #>> ARRAY[$N::text, $N+1::text]
		// We emit a parameterised ARRAY using string_to_array so the
		// caller passes the dotted string and we split server-side.
		return fmt.Sprintf("%s.properties #>> string_to_array($%d, '.')", table, argIndex)
	}
	return fmt.Sprintf("%s.properties ->> $%d", table, argIndex)
}

func comparatorToSQL(c string) string {
	switch c {
	case "gt":
		return ">"
	case "gte":
		return ">="
	case "lt":
		return "<"
	case "lte":
		return "<="
	}
	return "="
}
