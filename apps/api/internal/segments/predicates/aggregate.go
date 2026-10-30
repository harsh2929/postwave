// aggregate.go — GAP-LS-072: aggregate predicates over event
// properties. Klaviyo and Braze Segment Extensions both support
// "sum of property X over last N days" style queries; we mirror
// the Klaviyo shape since the rest of the registry tracks KLV-06.
//
// Supported aggregations: count, sum, avg, min, max.
//
// The fragment scopes to subscribers via subscriber_email + the
// tenant_id GUC; RLS still applies. The window is days-back from
// now(); zero or negative windowDays falls back to "all time".

package predicates

import (
	"fmt"
	"strings"
)

// AggregateInput is the call shape: which event, which property
// path to aggregate, which aggregator, over how many days, against
// what comparator + value.
type AggregateInput struct {
	// EventName matches events with exactly this name.
	EventName string
	// EventSlug, used when EventName is empty, matches every event whose
	// name has this slug (see EventSlug). Metric predicate keys carry only
	// the slug ("metric.track.placed_order.count"), so a rule that names no
	// event has to find "Placed Order" through it; comparing the slug with
	// event_name directly matched nobody.
	EventSlug    string
	Aggregation  string // count | sum | avg | min | max
	PropertyPath string // empty for count
	WindowDays   int
	Comparator   string // equals|not_equals|gt|gte|lt|lte
	Value        any
	// PlaceholderOffset is the $ index the first bound arg in this
	// fragment should use. Pass len(existingArgs)+1 from the
	// caller so the splice composes cleanly.
	PlaceholderOffset int
}

// Compile returns the WHERE-clause fragment + bound args for the
// aggregate predicate.
func CompileAggregate(in AggregateInput) (Fragment, error) {
	agg := strings.ToLower(strings.TrimSpace(in.Aggregation))
	switch agg {
	case "count", "sum", "avg", "min", "max":
	default:
		return Fragment{}, fmt.Errorf("predicates: unsupported aggregation %q", in.Aggregation)
	}
	cmp, ok := comparatorOp(in.Comparator)
	if !ok {
		return Fragment{}, fmt.Errorf("predicates: unsupported comparator %q", in.Comparator)
	}
	eventColumn, eventArg := "event_name", in.EventName
	if strings.TrimSpace(in.EventName) == "" {
		if strings.TrimSpace(in.EventSlug) == "" {
			return Fragment{}, fmt.Errorf("predicates: aggregate requires event_name")
		}
		eventColumn, eventArg = eventSlugSQL("event_name"), EventSlug(in.EventSlug)
	}

	args := []any{eventArg}
	if in.WindowDays > 0 {
		args = append(args, in.WindowDays)
	}
	args = append(args, in.Value)

	// Build the inner SELECT. Aggregation expression depends on
	// whether we're folding the count of rows or a property
	// extract. Properties come from product_events.properties
	// (jsonb) via the dotted property_path.
	var aggExpr string
	if agg == "count" {
		aggExpr = "count(*)"
	} else {
		path := sanitizeJSONPath(in.PropertyPath)
		// numeric coercion so sum/avg/min/max work on jsonb text.
		aggExpr = fmt.Sprintf("%s(NULLIF(properties#>>'%s','')::numeric)", agg, path)
	}

	off := in.PlaceholderOffset
	if off <= 0 {
		off = 1
	}
	eventPH := fmt.Sprintf("$%d", off)
	valuePH := fmt.Sprintf("$%d", off+len(args)-1)
	whereWindow := ""
	if in.WindowDays > 0 {
		// product_events.occurred_at >= now() - $X * interval '1 day'
		windowPH := fmt.Sprintf("$%d", off+1)
		whereWindow = fmt.Sprintf(" AND occurred_at >= now() - %s::int * interval '1 day'", windowPH)
	}

	// product_events is keyed by subscriber_id (FK → subscribers.id);
	// there is NO subscriber_email column on product_events. Scope the
	// correlated subquery by subscriber_id = subscribers.id (and the
	// tenant) so RLS + the join both resolve. (Pre-existing bug fix —
	// the old subscriber_email reference would have failed at runtime.)
	sql := fmt.Sprintf(`COALESCE((SELECT %s
   FROM product_events
  WHERE tenant_id = subscribers.tenant_id
    AND subscriber_id = subscribers.id
    AND %s = %s%s),0) %s %s`,
		aggExpr, eventColumn, eventPH, whereWindow, cmp, valuePH)

	return Fragment{SQL: sql, Args: args}, nil
}

// EventSlug is the key form of a tracked event name: lower-case ASCII letters
// and digits, every other run of characters folded to one underscore, none at
// either end ("Placed Order" and "placed-order" are both placed_order), and
// "event" when nothing is left. The predicate registry keys event metrics by
// it; eventSlugSQL computes the same thing in SQL.
func EventSlug(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "_") {
				b.WriteByte('_')
			}
		}
	}
	if out := strings.Trim(b.String(), "_"); out != "" {
		return out
	}
	return "event"
}

// eventSlugSQL is EventSlug as a SQL expression over column.
func eventSlugSQL(column string) string {
	return "COALESCE(NULLIF(btrim(regexp_replace(lower(" + column + "), '[^a-z0-9]+', '_', 'g'), '_'), ''), 'event')"
}

func comparatorOp(s string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "equals", "=":
		return "=", true
	case "not_equals", "!=", "<>":
		return "<>", true
	case "gt", ">":
		return ">", true
	case "gte", ">=":
		return ">=", true
	case "lt", "<":
		return "<", true
	case "lte", "<=":
		return "<=", true
	}
	return "", false
}

// sanitizeJSONPath turns a dotted path like "properties.total" or
// "total" into a postgres jsonb path "{total}" suitable for the
// #>> operator. Quote-injection is blocked by stripping non
// alnum/underscore chars.
func sanitizeJSONPath(s string) string {
	parts := strings.Split(strings.TrimSpace(s), ".")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		clean := strings.Builder{}
		for _, r := range p {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
				clean.WriteRune(r)
			}
		}
		if clean.Len() > 0 {
			out = append(out, clean.String())
		}
	}
	return "{" + strings.Join(out, ",") + "}"
}
