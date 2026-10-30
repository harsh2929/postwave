// Package listsearch is a tiny helper for the cross-cutting "?query="
// substring filter the desktop UI passes to every list endpoint.
//
// All seven list endpoints (campaigns, lists, templates, tags, archive,
// forms, inbound_webhooks) want the same shape: a case-insensitive
// substring match against one or two columns, AND'd into the existing
// WHERE clause. Each endpoint already had a hand-rolled `($N = ” OR
// col ILIKE '%' || $N || '%')` snippet; this package consolidates that
// into a small builder so the next column to gain a query filter only
// has to add a one-liner.
//
// The builder is intentionally placeholder-aware: it returns a SQL
// fragment whose first placeholder index is `start`, and a slice of
// args sized to match. Callers control where in the surrounding query
// the fragment lands by choosing `start` and concatenating into their
// existing WHERE.
//
// Empty query → ("", nil), which the caller can splice in unconditionally.
package listsearch

import (
	"fmt"
	"strings"
)

// ReadQuery extracts the search query string from request URL query
// params. The desktop frontend sends `?query=...`; the legacy/api
// surface used `?q=...`. We accept BOTH so old + new clients work
// during the rollout. `query` wins if both are present.
//
// Returns the trimmed value, or "" if neither was set.
func ReadQuery(values map[string][]string) string {
	if vs, ok := values["query"]; ok {
		for _, v := range vs {
			if t := strings.TrimSpace(v); t != "" {
				return t
			}
		}
	}
	if vs, ok := values["q"]; ok {
		for _, v := range vs {
			if t := strings.TrimSpace(v); t != "" {
				return t
			}
		}
	}
	return ""
}

// BuildLikeFilter renders a SQL fragment that tests whether `field`
// case-insensitively contains `query`. When `query` is empty the
// fragment is empty + args is nil; the caller can splice the result
// unconditionally.
//
// `start` is the next free placeholder index in the surrounding query.
// E.g. if the caller has already bound $1 (tenant), pass start=2 and
// you'll get back something like ("col ILIKE '%' || $2 || '%'", []any{q}).
//
// The fragment is wrapped in parentheses so the caller can splice it
// straight into a longer AND/OR chain without ambiguity.
func BuildLikeFilter(field, query string, start int) (string, []any) {
	q := strings.TrimSpace(query)
	if q == "" || strings.TrimSpace(field) == "" {
		return "", nil
	}
	frag := fmt.Sprintf("(%s ILIKE '%%' || $%d || '%%')", field, start)
	return frag, []any{q}
}

// BuildLikeFilterMulti is the same shape but ORs the match across
// multiple columns. Useful for "match name OR subject" style filters.
// All columns share the same `query` value (one bind), so the fragment
// references $start the same number of times as len(fields).
func BuildLikeFilterMulti(fields []string, query string, start int) (string, []any) {
	q := strings.TrimSpace(query)
	if q == "" {
		return "", nil
	}
	parts := make([]string, 0, len(fields))
	for _, f := range fields {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s ILIKE '%%' || $%d || '%%'", f, start))
	}
	if len(parts) == 0 {
		return "", nil
	}
	return "(" + strings.Join(parts, " OR ") + ")", []any{q}
}
