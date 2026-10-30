// SPDX-License-Identifier: AGPL-3.0-only
//
// classifier.go — best-effort SQL read/write classification (G-33).
//
// IsReadOnlyQuery is deliberately conservative: it only returns true when it
// can positively identify a statement as safe to serve from a lagging
// replica. Anything it cannot confidently classify — an unrecognized leading
// keyword, a WITH whose final statement isn't a SELECT, a row-locking clause,
// a sequence mutation — is treated as a write and routed to the primary.
// Sending an unrecognized statement to a replica is the dangerous failure
// mode; sending a genuinely read-only statement to the primary merely costs
// a little of the capacity this package exists to relieve.
//
// This is a lightweight classifier, not a SQL parser: it strips comments and
// string/dollar-quoted literals, then reasons about paren-nesting depth to
// separate CTE bodies from the top-level statement shape. It is not a
// defense against adversarial SQL — callers control the query text (this
// package routes internally-generated queries, not user input).
package dbrouter

import (
	"regexp"
	"strings"
)

var (
	blockCommentRe = regexp.MustCompile(`(?s)/\*.*?\*/`)
	lineCommentRe  = regexp.MustCompile(`--[^\n]*`)
	// dollarQuoteRe matches $$...$$ and $tag$...$tag$ bodies (used for
	// function bodies / large literals). It is intentionally non-greedy
	// and does not handle nested distinct dollar-tags inside one another;
	// that combination is rare enough in generated SQL to accept the risk.
	dollarQuoteRe = regexp.MustCompile(`(?s)\$([A-Za-z_][A-Za-z0-9_]*)?\$.*?\$[A-Za-z_]*\$`)
	singleQuoteRe = regexp.MustCompile(`'(?:[^'\\]|\\.|'')*'`)

	// sequenceMutationRe: nextval()/setval() change committed sequence state
	// even when called from inside a SELECT list, so they must never be
	// routed to a replica.
	sequenceMutationRe = regexp.MustCompile(`(?i)\b(NEXTVAL|SETVAL)\s*\(`)

	// rowLockRe: an explicit row-locking clause takes locks against live
	// data on whichever connection runs it — unsafe on a replica (and
	// meaningless there, since replicas don't accept locking reads anyway).
	rowLockRe = regexp.MustCompile(`(?i)\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b`)

	// cteWriteBodyRe catches a CTE whose body opens with a data-modifying
	// statement, e.g. `x AS (UPDATE ... )` — the classic "write disguised
	// as a WITH" case.
	cteWriteBodyRe = regexp.MustCompile(`(?i)\bAS\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(\s*(INSERT|UPDATE|DELETE|MERGE)\b`)

	// cteHeaderRe matches one collapsed CTE header — `name [(cols)] AS
	// [[NOT] MATERIALIZED] (...)` — after paren interiors have been
	// collapsed to a bare "()" by topLevelSkeleton.
	cteHeaderRe = regexp.MustCompile(`(?i)^"?[A-Za-z_][A-Za-z0-9_$]*"?\s*(?:\(\)\s*)?AS\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(\)`)

	leadingWordRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*`)
)

// IsReadOnlyQuery reports whether sql is safe to route to a read replica.
//
// Read-only: SELECT / TABLE / VALUES, and WITH (optionally RECURSIVE) ...
// SELECT where no CTE body is itself INSERT/UPDATE/DELETE/MERGE, and the
// statement carries no row-locking clause (FOR UPDATE/SHARE/...) and no
// sequence mutation (nextval/setval).
//
// Everything else is a write: INSERT/UPDATE/DELETE/MERGE, DDL (CREATE/
// ALTER/DROP/TRUNCATE), CALL/DO/COPY/VACUUM, malformed/empty input, or a
// WITH whose final statement is not itself a SELECT.
func IsReadOnlyQuery(sql string) bool {
	norm := strings.TrimSpace(normalizeSQL(sql))
	if norm == "" {
		return false
	}

	// Global write signals: unsafe wherever in the statement they occur.
	if sequenceMutationRe.MatchString(norm) || rowLockRe.MatchString(norm) {
		return false
	}

	lead := strings.ToUpper(leadingWordRe.FindString(norm))
	switch lead {
	case "SELECT", "TABLE", "VALUES":
		return true
	case "WITH":
		return isReadOnlyWith(norm)
	default:
		return false
	}
}

// normalizeSQL strips comments and string/dollar-quoted literal content so
// keyword scanning doesn't trip over text inside them (e.g. a literal
// containing the word "update").
func normalizeSQL(sql string) string {
	s := blockCommentRe.ReplaceAllString(sql, " ")
	s = lineCommentRe.ReplaceAllString(s, " ")
	s = dollarQuoteRe.ReplaceAllString(s, "''")
	s = singleQuoteRe.ReplaceAllString(s, "''")
	return s
}

// isReadOnlyWith handles a statement whose leading keyword is WITH: it must
// carry no data-modifying CTE body, and its final (main) statement must
// itself be a SELECT/TABLE/VALUES.
func isReadOnlyWith(norm string) bool {
	if cteWriteBodyRe.MatchString(norm) {
		return false
	}

	rest := strings.TrimSpace(topLevelSkeleton(norm))
	rest = trimLeadingKeyword(rest, "WITH")
	rest = trimLeadingKeyword(rest, "RECURSIVE")

	for {
		rest = strings.TrimSpace(rest)
		loc := cteHeaderRe.FindStringIndex(rest)
		if loc == nil || loc[0] != 0 {
			break
		}
		rest = strings.TrimSpace(rest[loc[1]:])
		if strings.HasPrefix(rest, ",") {
			rest = strings.TrimSpace(rest[1:])
			continue
		}
		break
	}

	mainLead := strings.ToUpper(leadingWordRe.FindString(rest))
	return mainLead == "SELECT" || mainLead == "TABLE" || mainLead == "VALUES"
}

// topLevelSkeleton collapses the interior of every parenthesised group in
// norm, keeping only the outermost paren markers. This exposes the
// top-level statement shape — CTE headers followed by the main statement —
// while hiding CTE-body keywords that would otherwise be mistaken for the
// main statement's leading keyword.
func topLevelSkeleton(norm string) string {
	var sb strings.Builder
	depth := 0
	for _, r := range norm {
		switch r {
		case '(':
			if depth == 0 {
				sb.WriteRune('(')
			}
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
			if depth == 0 {
				sb.WriteRune(')')
			}
		default:
			if depth == 0 {
				sb.WriteRune(r)
			}
		}
	}
	return sb.String()
}

// trimLeadingKeyword strips kw (case-insensitively) from the front of s, if
// present as a whole leading word, along with any following whitespace.
func trimLeadingKeyword(s, kw string) string {
	s = strings.TrimSpace(s)
	w := leadingWordRe.FindString(s)
	if w != "" && strings.EqualFold(w, kw) {
		return strings.TrimSpace(s[len(w):])
	}
	return s
}
