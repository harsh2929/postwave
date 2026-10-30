package listmonk

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/postwave/migrate/canonical"
)

// ValidateSegmentQuery asks Postgres to plan the tenant-scoped compiled
// predicate before persistence. This catches schema/operator/cast drift that
// a string-only compiler cannot detect, without executing the segment.
func ValidateSegmentQuery(ctx context.Context, db *sql.DB, tenantID string, node canonical.SegmentNode) (err error) {
	if db == nil || strings.TrimSpace(tenantID) == "" {
		return fmt.Errorf("segment SQL validation requires DB and tenant")
	}
	fragment, args, err := CompileSegment(node)
	if err != nil {
		return err
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	rows, err := tx.QueryContext(ctx, "EXPLAIN SELECT id FROM subscribers WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AND ("+fragment+")", args...)
	if err != nil {
		return fmt.Errorf("Postgres rejected compiled segment predicate: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return err
		}
	}
	return rows.Err()
}

// CompileSegment turns a canonical segment AST into a parameterised SQL
// fragment Listmonk can use as a campaign query (against the `subscribers`
// table). The returned args slice carries positional placeholders ($1, $2…)
// in declaration order.
//
// The compiled SQL is intended to be slotted in like:
//
//	SELECT id FROM subscribers WHERE <fragment>;
//
// Field encoding:
//
//	"email"           -> subscribers.email
//	"status"          -> subscribers.status
//	"tag" / "tags"    -> membership against subscribers.tags
//	"custom.<k>"      -> subscribers.custom_fields->>'<k>'
//	anything else     -> subscribers.custom_fields->>'<field>' (defensive default)
func CompileSegment(node canonical.SegmentNode) (string, []interface{}, error) {
	c := &compiler{}
	frag, err := c.walk(node)
	if err != nil {
		return "", nil, err
	}
	return frag, c.args, nil
}

type compiler struct {
	args []interface{}
}

func (c *compiler) placeholder(v interface{}) string {
	c.args = append(c.args, v)
	return fmt.Sprintf("$%d", len(c.args))
}

func (c *compiler) walk(n canonical.SegmentNode) (string, error) {
	switch strings.ToLower(n.Op) {
	case "and", "or":
		if len(n.Children) == 0 {
			return "", fmt.Errorf("listmonk segment compiler: %s group has no children", strings.ToLower(n.Op))
		}
		parts := make([]string, 0, len(n.Children))
		for _, ch := range n.Children {
			sub, err := c.walk(ch)
			if err != nil {
				return "", err
			}
			parts = append(parts, "("+sub+")")
		}
		joiner := " AND "
		if strings.EqualFold(n.Op, "or") {
			joiner = " OR "
		}
		return strings.Join(parts, joiner), nil
	case "not":
		if len(n.Children) != 1 {
			return "", fmt.Errorf("listmonk segment compiler: not group requires exactly one child")
		}
		sub, err := c.walk(n.Children[0])
		if err != nil {
			return "", err
		}
		return "NOT (" + sub + ")", nil
	case "condition":
		return c.condition(n)
	default:
		return "", fmt.Errorf("listmonk segment compiler: unknown op %q", n.Op)
	}
}

func (c *compiler) condition(n canonical.SegmentNode) (string, error) {
	if isTagField(n.Field) {
		return c.tagCondition(n)
	}
	col, isJSON := compileField(n.Field)

	switch strings.ToLower(n.Comparator) {
	case "equals", "=":
		return fmt.Sprintf("%s = %s", col, c.placeholder(jsonText(n.Value, isJSON))), nil
	case "not_equals", "!=":
		return fmt.Sprintf("%s <> %s", col, c.placeholder(jsonText(n.Value, isJSON))), nil
	case "contains":
		return fmt.Sprintf("%s ILIKE %s", col, c.placeholder("%"+toString(n.Value)+"%")), nil
	case "not_contains":
		return fmt.Sprintf("%s NOT ILIKE %s", col, c.placeholder("%"+toString(n.Value)+"%")), nil
	case "starts_with":
		return fmt.Sprintf("%s ILIKE %s", col, c.placeholder(toString(n.Value)+"%")), nil
	case "ends_with":
		return fmt.Sprintf("%s ILIKE %s", col, c.placeholder("%"+toString(n.Value))), nil
	case "gt", ">":
		col = orderedJSONOperand(col, isJSON, n.Value)
		return fmt.Sprintf("%s > %s", col, c.placeholder(n.Value)), nil
	case "gte", ">=":
		col = orderedJSONOperand(col, isJSON, n.Value)
		return fmt.Sprintf("%s >= %s", col, c.placeholder(n.Value)), nil
	case "lt", "<":
		col = orderedJSONOperand(col, isJSON, n.Value)
		return fmt.Sprintf("%s < %s", col, c.placeholder(n.Value)), nil
	case "lte", "<=":
		col = orderedJSONOperand(col, isJSON, n.Value)
		return fmt.Sprintf("%s <= %s", col, c.placeholder(n.Value)), nil
	case "in", "not_in":
		// Empty-list edge case: SQL's `IN ()` is illegal; we degrade to a
		// constant expression that always evaluates the right way.
		list, err := toSlice(n.Value)
		if err != nil {
			return "", err
		}
		if len(list) == 0 {
			if strings.ToLower(n.Comparator) == "in" {
				return "FALSE", nil
			}
			return "TRUE", nil
		}
		placeholders := make([]string, 0, len(list))
		for _, v := range list {
			placeholders = append(placeholders, c.placeholder(v))
		}
		op := "IN"
		if strings.ToLower(n.Comparator) == "not_in" {
			op = "NOT IN"
		}
		return fmt.Sprintf("%s %s (%s)", col, op, strings.Join(placeholders, ", ")), nil
	default:
		return "", fmt.Errorf("listmonk segment compiler: unknown comparator %q", n.Comparator)
	}
}

func (c *compiler) tagCondition(n canonical.SegmentNode) (string, error) {
	switch strings.ToLower(n.Comparator) {
	case "equals", "=":
		return fmt.Sprintf("%s = ANY(subscribers.tags)", c.placeholder(toString(n.Value))), nil
	case "not_equals", "!=":
		return fmt.Sprintf("NOT (%s = ANY(subscribers.tags))", c.placeholder(toString(n.Value))), nil
	case "contains":
		return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(subscribers.tags) AS tag WHERE tag ILIKE %s)", c.placeholder("%"+toString(n.Value)+"%")), nil
	case "not_contains":
		return fmt.Sprintf("NOT EXISTS (SELECT 1 FROM unnest(subscribers.tags) AS tag WHERE tag ILIKE %s)", c.placeholder("%"+toString(n.Value)+"%")), nil
	case "starts_with":
		return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(subscribers.tags) AS tag WHERE tag ILIKE %s)", c.placeholder(toString(n.Value)+"%")), nil
	case "ends_with":
		return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(subscribers.tags) AS tag WHERE tag ILIKE %s)", c.placeholder("%"+toString(n.Value))), nil
	case "in", "not_in":
		list, err := toSlice(n.Value)
		if err != nil {
			return "", err
		}
		if len(list) == 0 {
			if strings.ToLower(n.Comparator) == "in" {
				return "FALSE", nil
			}
			return "TRUE", nil
		}
		placeholders := make([]string, 0, len(list))
		for _, v := range list {
			placeholders = append(placeholders, c.placeholder(toString(v)))
		}
		expr := fmt.Sprintf("subscribers.tags && ARRAY[%s]::text[]", strings.Join(placeholders, ", "))
		if strings.ToLower(n.Comparator) == "not_in" {
			return "NOT (" + expr + ")", nil
		}
		return expr, nil
	default:
		return "", fmt.Errorf("listmonk segment compiler: unsupported comparator %q for tags", n.Comparator)
	}
}

// compileField returns the SQL column expression and whether the value should
// be coerced to text (true for JSONB extraction).
func compileField(f string) (col string, isJSONExtract bool) {
	switch strings.ToLower(f) {
	case "email":
		return "subscribers.email", false
	case "status":
		return "subscribers.status", false
	case "name":
		return "subscribers.custom_fields->>'name'", true
	case "consent_source":
		return "subscribers.consent_source", false
	case "consent_timestamp":
		return "subscribers.consent_timestamp", false
	}
	if strings.HasPrefix(strings.ToLower(f), "custom.") {
		key := f[len("custom."):]
		return fmt.Sprintf("subscribers.custom_fields->>'%s'", sqlEscape(key)), true
	}
	// Defensive default: treat unknown fields as custom-fields lookup.
	return fmt.Sprintf("subscribers.custom_fields->>'%s'", sqlEscape(f)), true
}

// JSONB ->> produces text. Mirror the runtime compiler's guarded numeric
// projection so numeric predicates do not compare lexically or fail with a
// text-vs-number operator error on dirty legacy values.
func orderedJSONOperand(col string, isJSON bool, value interface{}) string {
	if !isJSON {
		return col
	}
	switch value.(type) {
	case float64, float32, int, int32, int64, uint, uint32, uint64:
		return fmt.Sprintf("(CASE WHEN %s ~ '^-?[0-9]+([.][0-9]+)?$' THEN (%s)::numeric END)", col, col)
	default:
		return col
	}
}

func isTagField(f string) bool {
	switch strings.ToLower(f) {
	case "tag", "tags":
		return true
	default:
		return false
	}
}

func sqlEscape(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

func toString(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case fmt.Stringer:
		return t.String()
	default:
		return fmt.Sprintf("%v", v)
	}
}

func jsonText(v interface{}, isJSONExtract bool) interface{} {
	if !isJSONExtract {
		return v
	}
	// JSONB ->> always returns text, so coerce non-strings to their text rep.
	switch t := v.(type) {
	case string:
		return t
	default:
		return fmt.Sprintf("%v", t)
	}
}

func toSlice(v interface{}) ([]interface{}, error) {
	switch t := v.(type) {
	case []interface{}:
		return t, nil
	case []string:
		out := make([]interface{}, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out, nil
	case nil:
		return nil, nil
	default:
		return nil, fmt.Errorf("listmonk segment compiler: in/not_in expects array, got %T", v)
	}
}
