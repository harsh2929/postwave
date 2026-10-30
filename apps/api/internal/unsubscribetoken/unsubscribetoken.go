// SPDX-License-Identifier: AGPL-3.0-only

// Package unsubscribetoken is the single definition of the in-body
// unsubscribe placeholder that the send loop replaces with each recipient's
// own preference-centre URL.
//
// Three consumers must agree on exactly which spellings count, and before
// this package each kept its own list:
//
//   - the send loop renders the placeholder (sending.RenderUnsubscribePlaceholder);
//   - the compliance gate and pre-send checklist refuse a body that has no
//     placeholder (campaigns.bodyHasUnsubscribe);
//   - template workflows must never bake a sample value into it when a
//     campaign draft is created (campaigntemplates).
//
// When the three drifted, a draft could carry a hard-coded link to a foreign
// host, pass the checklist because the word "unsubscribe" appeared in it, and
// reach recipients with no working unsubscribe at all.
package unsubscribetoken

import "regexp"

// names are the placeholder spellings the send loop renders. The first is the
// canonical form every built-in footer uses; the other two are the Listmonk
// template-function spellings that imported and hand-written bodies carry.
var names = map[string]struct{}{
	"unsubscribe_url": {},
	"Unsubscribe.URL": {},
	"UnsubscribeURL":  {},
}

// placeholderRE matches any of the names above between double braces, with
// any amount of surrounding whitespace, and nothing else inside the braces.
var placeholderRE = regexp.MustCompile(`\{\{\s*(?:unsubscribe_url|Unsubscribe\.URL|UnsubscribeURL)\s*\}\}`)

// Canonical is the placeholder new content should use.
const Canonical = "{{ unsubscribe_url }}"

// IsName reports whether a bare merge-tag name (the text between the braces,
// already trimmed) is the send-time unsubscribe placeholder.
func IsName(name string) bool {
	_, ok := names[name]
	return ok
}

// Contains reports whether body carries a placeholder the send loop will
// replace with the recipient's unsubscribe URL. A link that merely mentions
// "unsubscribe", or points at a fixed URL, does not count: nothing would make
// it unsubscribe the person who clicks it.
func Contains(body string) bool {
	return placeholderRE.MatchString(body)
}

// Render replaces every placeholder in body with url. An empty url leaves the
// body unchanged, so the compliance gate still sees the unrendered token and
// can refuse the send instead of shipping an empty href.
func Render(body, url string) string {
	if body == "" || url == "" {
		return body
	}
	return placeholderRE.ReplaceAllLiteralString(body, url)
}
