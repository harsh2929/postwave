package subscribers

import (
	"fmt"
	"strings"
)

// normalizeSort maps an operator-supplied (sort, order) pair to a
// whitelisted (column, direction) pair safe to splice into SQL. Unknown
// columns fall back to updated_at; an unknown order falls back to DESC.
// The whitelist is also the alias layer: status→mailchimp_status,
// joined→created_at, engagement→engagement_score, churn→churn_score
// (SUB-038), rating→rating (SUB-038). Email is canonicalised to lower
// case so case differences in the column key don't bypass it.
func normalizeSort(sort, order string) (string, string) {
	col := "updated_at"
	switch strings.ToLower(strings.TrimSpace(sort)) {
	case "":
	case "email":
		col = "email"
	case "status", "mailchimp_status":
		col = "mailchimp_status"
	case "joined", "created_at":
		col = "created_at"
	case "engagement", "engagement_score":
		col = "engagement_score"
	case "first_name":
		// SUB-004 — alphabetical sort on the first-class name columns,
		// served by the (tenant_id, first_name, last_name) index (mig 0413).
		col = "first_name"
	case "last_name":
		col = "last_name"
	case "churn", "churn_score":
		// SUB-038 — churn-risk sort, served by the (tenant_id,
		// churn_score DESC, churn_score_at DESC) index (mig 0180).
		col = "churn_score"
	case "rating":
		// SUB-038 — Mailchimp-parity contact rating (1..5 stars),
		// served by the partial (tenant_id, rating) index (mig 0226).
		col = "rating"
	case "updated_at":
		col = "updated_at"
	}
	dir := "DESC"
	switch strings.ToUpper(strings.TrimSpace(order)) {
	case "ASC":
		dir = "ASC"
	case "DESC":
		dir = "DESC"
	}
	return col, dir
}

// statusFilterClause translates the desktop's status chip selection to
// a (column, value) pair. Two columns are in play: mailchimp_status
// carries the exact Mailchimp lifecycle state, while status carries the
// engine's enabled/disabled/blocklisted/unconfirmed state (migration 0003
// CHECK vocabulary). "bounced" is retained as a UI compatibility alias for
// Mailchimp's "cleaned" status. Unknown inputs (including the empty string and
// "all") return ok=false so the caller can skip the predicate entirely.
func statusFilterClause(in string) (string, string, bool) {
	v := strings.ToLower(strings.TrimSpace(in))
	switch v {
	case "", "all":
		return "", "", false
	case "bounced":
		return "mailchimp_status", "cleaned", true
	case "subscribed", "unsubscribed", "non_subscribed", "pending", "transactional", "cleaned", "archived", "deleted":
		return "mailchimp_status", v, true
	case StatusEnabled, StatusDisabled, StatusBlocklisted, StatusUnconfirmed:
		// SUB-074: all four engine statuses map directly to the status
		// column. disabled + unconfirmed were previously advertised by the
		// handler error + OpenAPI enum but never mapped here, so a valid
		// chip choice 400'd; they share the same column as enabled.
		return "status", v, true
	}
	return "", "", false
}

// subscriberFreeTextPredicate returns the parenthesised predicate every
// free-text subscriber match uses: the GIN-indexed search_tsv (migration 0242,
// which covers email, the merge_fields/custom_fields name keys and tags) OR the
// pg_trgm-indexed lower(email) substring, so a typo'd or partial address still
// surfaces. The supplied placeholder index (1-based) is spliced as $N; the
// caller binds that exact value. No user input is interpolated — only the
// integer placeholder is formatted in.
//
// It replaced a ten-column ILIKE that led with '%' on every term and cast
// custom_fields, merge_fields and groups to text per row. Nothing could index
// that: `GET /api/v1/subscribers?q=` ran two full scans of the tenant's
// subscribers — one for the count, one for the page — serialising every JSONB
// blob on the way. This is the SAME predicate buildSearchWhere emits for
// free text, so the list's ?q and the /search endpoint are now one
// implementation rather than two that were only claimed to be in lockstep.
//
// Behaviour note: matching a raw custom_fields / merge_fields / groups VALUE
// that is not one of the indexed name keys, or a mailchimp_status string, no
// longer hits. Those matches were incidental to a substring scan; the
// structured operators on /search (tag:, name:, @domain, status:) are the
// supported way to ask for them.
func subscriberFreeTextPredicate(placeholder int) string {
	return fmt.Sprintf(
		`(search_tsv @@ websearch_to_tsquery('simple', $%[1]d) OR lower(email::text) LIKE '%%' || lower($%[1]d) || '%%')`,
		placeholder,
	)
}

// buildSearchWhere assembles the WHERE clause for the structured search
// box. The seed slice is the placeholder offset — typically []any{tenantID}
// so $1 binds the tenant. New args are appended to seed; the returned
// args slice can be passed straight to pgx. Free text is matched against
// both the GENERATED search_tsv column (websearch_to_tsquery) and the
// pg_trgm LIKE index on lower(email::text); operators provide an OR
// over the two so a typo'd email surfaces and a phrase still matches.
// Unknown status values are silently dropped (no clause emitted) so a
// stale UI choice can't lock the result set to zero rows.
func buildSearchWhere(q SearchQuery, seed []any) (string, []any) {
	args := append([]any{}, seed...)
	var parts []string
	parts = append(parts, "WHERE tenant_id = $1::uuid")

	next := func(v any) int {
		args = append(args, v)
		return len(args)
	}

	if ft := strings.TrimSpace(q.FreeText); ft != "" {
		parts = append(parts, subscriberFreeTextPredicate(next(ft)))
	}

	for _, t := range q.Tags {
		i := next(t.Value)
		clause := fmt.Sprintf("tags && ARRAY[$%d]::text[]", i)
		if t.Negated {
			clause = fmt.Sprintf("NOT (tags && ARRAY[$%d]::text[])", i)
		}
		parts = append(parts, clause)
	}

	for _, t := range q.Domains {
		i := next(t.Value)
		clause := fmt.Sprintf("lower(email::text) LIKE '%%@' || lower($%d) || '%%'", i)
		if t.Negated {
			clause = fmt.Sprintf("lower(email::text) NOT LIKE '%%@' || lower($%d) || '%%'", i)
		}
		parts = append(parts, clause)
	}

	for _, t := range q.Emails {
		i := next(t.Value)
		clause := fmt.Sprintf("lower(email::text) LIKE '%%' || lower($%d) || '%%'", i)
		if t.Negated {
			clause = fmt.Sprintf("lower(email::text) NOT LIKE '%%' || lower($%d) || '%%'", i)
		}
		parts = append(parts, clause)
	}

	for _, t := range q.Names {
		i := next(t.Value)
		clause := fmt.Sprintf(
			"(lower(coalesce(merge_fields->>'FNAME','')) LIKE '%%' || lower($%d) || '%%' OR lower(coalesce(merge_fields->>'LNAME','')) LIKE '%%' || lower($%d) || '%%')",
			i, i,
		)
		if t.Negated {
			clause = "NOT " + clause
		}
		parts = append(parts, clause)
	}

	for _, t := range q.Statuses {
		col, val, ok := statusFilterClause(t.Value)
		if !ok {
			continue
		}
		i := next(val)
		clause := fmt.Sprintf("%s = $%d", col, i)
		if t.Negated {
			clause = fmt.Sprintf("%s <> $%d", col, i)
		}
		parts = append(parts, clause)
	}

	for _, t := range q.SignupSources {
		i := next(t.Value)
		clause := fmt.Sprintf("signup_source = $%d", i)
		if t.Negated {
			clause = fmt.Sprintf("(signup_source IS NULL OR signup_source <> $%d)", i)
		}
		parts = append(parts, clause)
	}

	// topic:<slug> — explicit opt-in in subscriber_topics (SETA-055). Only
	// explicit opt-in rows count; the topics.default_opt_in fallback is not
	// a deliberate choice and is deliberately excluded.
	for _, t := range q.Topics {
		i := next(t.Value)
		clause := fmt.Sprintf(
			"EXISTS (SELECT 1 FROM subscriber_topics st JOIN topics tp ON tp.id = st.topic_id WHERE st.tenant_id = subscribers.tenant_id AND lower(st.subscriber_email::text) = lower(subscribers.email::text) AND tp.slug = $%d AND st.opted_in = true)",
			i,
		)
		if t.Negated {
			clause = "NOT " + clause
		}
		parts = append(parts, clause)
	}

	sql := parts[0]
	if len(parts) > 1 {
		sql += " AND " + strings.Join(parts[1:], " AND ")
	}
	return sql, args
}

// derivedNames is the resolved set of first-class name columns (SUB-004)
// written to the subscribers row by Upsert/Update.
type derivedNames struct {
	first   string
	last    string
	full    string
	display string
}

// deriveNames resolves the four first-class name columns from a CreateInput.
// Precedence for first/last name: an explicit input field, then Mailchimp
// merge_fields FNAME/LNAME, then Klaviyo custom_fields first_name/last_name.
// full_name defaults to "first last" (trimmed); display_name defaults to
// full_name. Explicit values always win over the jsonb-derived fallbacks so
// an operator edit is never silently overwritten.
func deriveNames(in CreateInput) derivedNames {
	first := strings.TrimSpace(in.FirstName)
	last := strings.TrimSpace(in.LastName)
	if first == "" {
		first = firstStringFromMaps("FNAME", "first_name", in.MergeFields, in.CustomFields)
	}
	if last == "" {
		last = firstStringFromMaps("LNAME", "last_name", in.MergeFields, in.CustomFields)
	}
	full := strings.TrimSpace(in.FullName)
	if full == "" {
		full = strings.TrimSpace(strings.TrimSpace(first + " " + last))
	}
	display := strings.TrimSpace(in.DisplayName)
	if display == "" {
		display = full
	}
	return derivedNames{first: first, last: last, full: full, display: display}
}

// firstStringFromMaps returns the first non-empty string value found under
// mergeKey in mergeFields, then under customKey in customFields. Used to pull
// names out of the Mailchimp (merge_fields) and Klaviyo (custom_fields) blobs.
func firstStringFromMaps(mergeKey, customKey string, mergeFields, customFields map[string]any) string {
	if v := stringValue(mergeFields[mergeKey]); v != "" {
		return v
	}
	if v := stringValue(customFields[customKey]); v != "" {
		return v
	}
	return ""
}

func stringValue(raw any) string {
	s, ok := raw.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

// valueOrEmpty dereferences a *string, returning "" when nil. Used to feed
// UpdateInput pointer fields into deriveNames.
func valueOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// nilIfEmpty maps a trimmed empty string to a nil *string so a localization
// column is written as SQL NULL rather than ”. A non-empty value is trimmed
// and returned by pointer.
func nilIfEmpty(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}
