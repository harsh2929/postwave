// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"strings"
	"testing"
)

// splitTopLevelColumns splits a SELECT list on commas that are not inside
// parentheses, so COALESCE(x, ”) counts as one column.
func splitTopLevelColumns(list string) []string {
	var out []string
	depth := 0
	cur := strings.Builder{}
	for _, ch := range list {
		switch ch {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				out = append(out, strings.Join(strings.Fields(cur.String()), " "))
				cur.Reset()
				continue
			}
		}
		cur.WriteRune(ch)
	}
	out = append(out, strings.Join(strings.Fields(cur.String()), " "))
	return out
}

// The campaigns index requests CampaignListMaxRows (500) rows and renders no
// message body. While the list shared Get's projection it shipped body_html,
// body_mjml, plain_text, content_blocks, variants, template_variables and
// fact_contract for all 500 — tens of megabytes of JSON before the first row
// paints.
//
// The list projection has to stay position-aligned with the full one because
// both feed the single scanCampaign scanner: a column inserted into one and
// not the other would scan a value into the wrong field, which is far worse
// than the payload it was meant to trim. Assert the alignment, and assert the
// heavy columns really are gone.
func TestCampaignListProjectionOmitsBodiesAndStaysColumnAligned(t *testing.T) {
	t.Parallel()

	full := splitTopLevelColumns(campaignColumns)
	list := splitTopLevelColumns(campaignListColumns)
	if len(full) != len(list) {
		t.Fatalf("projection width: full=%d list=%d — scanCampaign scans both, so they must match",
			len(full), len(list))
	}

	// Positions the list is allowed to differ at, keyed by the source column.
	blanked := map[string]string{
		"COALESCE(body_html, '')":  "''::text",
		"COALESCE(body_mjml, '')":  "''::text",
		"COALESCE(plain_text, '')": "''::text",
		"content_blocks":           "'[]'::jsonb",
		"variants":                 "'[]'::jsonb",
		"template_variables":       "'{}'::jsonb",
		"fact_contract":            "'{}'::jsonb",
	}
	seen := map[string]bool{}
	for i := range full {
		if full[i] == list[i] {
			continue
		}
		want, ok := blanked[full[i]]
		if !ok {
			t.Fatalf("column %d diverged unexpectedly: full=%q list=%q", i, full[i], list[i])
		}
		if list[i] != want {
			t.Fatalf("column %d (%s): list=%q, want %q", i, full[i], list[i], want)
		}
		seen[full[i]] = true
	}
	for col := range blanked {
		if !seen[col] {
			t.Fatalf("list projection still reads %s — the heavy column is back on the list path", col)
		}
	}
}

// And the list query must actually use it. A projection nothing selects is a
// comment.
func TestCampaignListQueryUsesTheListProjection(t *testing.T) {
	t.Parallel()
	if !strings.Contains(campaignListSelectSQL, campaignListColumns) {
		t.Fatal("campaignListSelectSQL does not select campaignListColumns")
	}
	if strings.Contains(campaignListSelectSQL, "body_html") {
		t.Fatalf("list SELECT still reads body_html: %s", campaignListSelectSQL)
	}
}
