// SPDX-License-Identifier: AGPL-3.0-only
//
// mentions.go — SUB-097: @-mention parsing for the markdown notes pane.
//
// Mentions are stored INLINE in the note's markdown_body as tokens of the
// shape:
//
//	@[Display Name](user:11111111-1111-1111-1111-111111111111)
//
// This is a self-contained, link-style token (it renders to nothing harmful
// in a plain markdown viewer and round-trips through the rich composer). At
// write time we extract the set of mentioned user ids into the
// mentions_json column so the "notify mentioned teammates" and "notes that
// mention me" surfaces can query by containment without re-parsing markdown.
//
// Everything here is pure (no DB, no HTTP) so it is exhaustively unit
// tested.

package subscriber_notes

import (
	"regexp"
	"strings"
)

// mentionToken matches @[Display](user:<uuid>). The display group is
// non-greedy and forbids a literal ']' so adjacent tokens don't merge; the
// id group is a canonical lowercase/uppercase UUID. Anything that doesn't
// match the full shape is treated as ordinary markdown text, not a mention.
var mentionToken = regexp.MustCompile(
	`@\[([^\]]{1,200})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)`,
)

// Mention is one extracted @-mention: the mentioned user's id and the
// display text the author typed. Persisted as an element of mentions_json.
type Mention struct {
	UserID  string `json:"user_id"`
	Display string `json:"display"`
}

// extractMentions returns the de-duplicated, order-preserving set of
// mentions found in a markdown body. UUIDs are lower-cased so containment
// queries are stable regardless of how the client cased them; the first
// display text seen for a given id wins. Returns a non-nil empty slice when
// there are no mentions so it JSON-encodes as [] (matching the column
// default) rather than null.
func extractMentions(markdown string) []Mention {
	out := []Mention{}
	if markdown == "" {
		return out
	}
	seen := map[string]bool{}
	for _, m := range mentionToken.FindAllStringSubmatch(markdown, -1) {
		display := strings.TrimSpace(m[1])
		id := strings.ToLower(m[2])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, Mention{UserID: id, Display: display})
	}
	return out
}

// stripMentionTokens renders a markdown body down to a plain-text
// projection: each @[Name](user:id) token collapses to "@Name". Used to
// derive the legacy `body` column (plain text, search-friendly) from the
// rich markdown_body so old clients and full-text search keep working.
func stripMentionTokens(markdown string) string {
	return mentionToken.ReplaceAllString(markdown, "@$1")
}
