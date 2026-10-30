package subscribers

import (
	"strings"
	"unicode"
)

// SearchQuery is the parsed form of an operator-typed search box
// query. The free-text remainder becomes the websearch_to_tsquery
// payload; structured terms become AND-anded SQL predicates. Each
// term carries Negated so the SQL builder can flip it into a NOT.
type SearchQuery struct {
	// FreeText is everything left over after operators are extracted.
	// Passed to websearch_to_tsquery — so quoting, OR, and -word
	// behave the way users expect from Gmail / Linear / GitHub.
	FreeText string
	// Tags AND-anded; each carries Negated so `-tag:beta` excludes.
	Tags []Term
	// Domains match the substring after '@' in email (case-insensitive).
	Domains []Term
	// Emails match against email column (substring, case-insensitive).
	Emails []Term
	// Names match against merge_fields/custom_fields FNAME/LNAME.
	Names []Term
	// Statuses map to mailchimp_status (subscribed/unsubscribed/…)
	// or status (enabled/disabled/…). The repo normalises which column.
	Statuses []Term
	// SignupSources map to subscribers.signup_source. Operator typed
	// `source:embedded_form` / `-source:import` is parsed here; the
	// repo translates each term into a tenant-scoped predicate.
	SignupSources []Term
	// Topics match an explicit opt-in in subscriber_topics by topic slug.
	// Operator `topic:newsletter` / `-topic:promos` (SETA-055); the repo
	// emits a tenant-scoped EXISTS/NOT EXISTS against subscriber_topics.
	Topics []Term
}

type Term struct {
	Value   string
	Negated bool
}

// HasStructured reports whether the parser found any operator at all.
// Lets callers decide between the FTS fast path (free-text only) and
// the structured-builder path.
func (q SearchQuery) HasStructured() bool {
	return len(q.Tags)+len(q.Domains)+len(q.Emails)+len(q.Names)+len(q.Statuses)+len(q.SignupSources)+len(q.Topics) > 0
}

// IsEmpty reports whether there are no terms at all (free-text or
// operator). Caller can short-circuit to a plain List() call.
func (q SearchQuery) IsEmpty() bool {
	return strings.TrimSpace(q.FreeText) == "" && !q.HasStructured()
}

// ParseSearch tokenises the box. Supported operators:
//
//	tag:<v>      — has tag v
//	-tag:<v>     — does NOT have tag v
//	email:<v>    — email contains v
//	name:<v>     — name contains v
//	status:<v>   — status equals v
//	@<domain>    — email contains @<domain>
//
// Anything that isn't an operator becomes free text — multiple words
// are space-joined and handed to websearch_to_tsquery downstream so
// quoting, OR, and per-word negation Just Work.
//
// Quoted values keep their spaces: `name:"jane doe"` → one Name term.
func ParseSearch(raw string) SearchQuery {
	var q SearchQuery
	var free []string
	tokens := tokenize(raw)
	for _, tok := range tokens {
		if tok == "" {
			continue
		}
		negated := false
		t := tok
		if strings.HasPrefix(t, "-") && len(t) > 1 {
			negated = true
			t = t[1:]
		}
		// @domain → shorthand for email-domain
		if strings.HasPrefix(t, "@") && len(t) > 1 {
			q.Domains = append(q.Domains, Term{Value: strings.ToLower(t[1:]), Negated: negated})
			continue
		}
		// field:value — an empty value (e.g. `tag:`) is dropped silently
		// for known fields so the user isn't punished for a half-typed
		// operator with a junk free-text token.
		if colon := strings.IndexByte(t, ':'); colon > 0 {
			field := strings.ToLower(t[:colon])
			val := strings.Trim(t[colon+1:], "\"")
			if isKnownField(field) && val == "" {
				continue
			}
			switch field {
			case "tag", "tags":
				q.Tags = append(q.Tags, Term{Value: val, Negated: negated})
				continue
			case "email":
				q.Emails = append(q.Emails, Term{Value: strings.ToLower(val), Negated: negated})
				continue
			case "name":
				q.Names = append(q.Names, Term{Value: val, Negated: negated})
				continue
			case "status":
				q.Statuses = append(q.Statuses, Term{Value: strings.ToLower(val), Negated: negated})
				continue
			case "source", "signup_source":
				// Normalise here so the repo doesn't need to know the
				// CHECK-constrained vocabulary; unknown values land as
				// 'unknown' which matches a real bucket of subscribers
				// rather than silently producing zero results.
				q.SignupSources = append(q.SignupSources, Term{Value: NormalizeSignupSource(val), Negated: negated})
				continue
			case "topic", "topics":
				q.Topics = append(q.Topics, Term{Value: strings.ToLower(val), Negated: negated})
				continue
			}
		}
		// Anything else falls into free-text. Preserve negation prefix
		// so websearch_to_tsquery sees `-spam` and excludes it.
		if negated {
			free = append(free, "-"+t)
		} else {
			free = append(free, t)
		}
	}
	q.FreeText = strings.Join(free, " ")
	return q
}

// isKnownField gates the "drop empty value" behaviour so `tag:` becomes
// a no-op while `foo:bar` (no known operator) still falls through to
// free text in case it's literally a search term.
func isKnownField(f string) bool {
	switch f {
	case "tag", "tags", "email", "name", "status", "source", "signup_source", "topic", "topics":
		return true
	}
	return false
}

// tokenize splits on whitespace but respects double-quoted runs so
// `name:"jane doe"` survives as one token. Quotes are kept in the
// token; the field-parse path strips them.
func tokenize(s string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	for _, r := range s {
		switch {
		case r == '"':
			inQuote = !inQuote
			cur.WriteRune(r)
		case unicode.IsSpace(r) && !inQuote:
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}
