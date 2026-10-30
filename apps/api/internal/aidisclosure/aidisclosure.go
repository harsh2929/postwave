// Package aidisclosure implements the machine-readable marking of AI-generated
// content required by EU AI Act Article 50(2), in force 2 August 2026.
//
// Article 50 has two obligations relevant to Moosewave:
//
//	50(1) — a system that interacts with a natural person must disclose that
//	        the person is interacting with AI (the in-app agent). See Disclosure.
//	50(2) — generative-AI output (including TEXT) must be marked in a
//	        machine-readable way as artificially generated. See MarkHTML /
//	        MarkText / Provenance.
//
// There is no C2PA-equivalent standard for plain text yet, so the machine-
// readable marker here is a conservative, self-describing one: an HTML metadata
// comment for rendered email bodies, and a Provenance record for storage and
// for an X-header on delivery. The EXACT marker format a customer's counsel
// will accept is a legal decision — this package centralises it so that
// decision changes one constant, not fifty call sites.
package aidisclosure

import (
	"strings"
)

// Marker is the machine-readable token embedded in AI-generated content. It is
// deliberately greppable and namespaced. If counsel requires a different token
// (or a full C2PA manifest once a text profile exists), change it here.
const Marker = "ai-generated:postwave"

// DisclosureText is the Article 50(1) notice shown when a user interacts with
// the in-app AI agent. Clients render this before the first agent turn.
const DisclosureText = "You are chatting with an AI assistant. Responses are generated automatically and may be inaccurate."

// Provenance is the storable record that a piece of content was AI-generated.
// Persist it alongside the content (a boolean column + these fields in
// metadata) so the marking survives independently of the rendered output.
type Provenance struct {
	Generated bool   `json:"ai_generated"`
	Marker    string `json:"ai_marker,omitempty"`
	// Model is the generating model id, for the audit trail. Optional.
	Model string `json:"ai_model,omitempty"`
}

// NewProvenance builds a Provenance for AI-generated content.
func NewProvenance(model string) Provenance {
	return Provenance{Generated: true, Marker: Marker, Model: strings.TrimSpace(model)}
}

// MarkHTML embeds the machine-readable marker into an HTML body as a metadata
// comment. Idempotent: marking already-marked HTML does not double-stamp, so it
// is safe to call on a re-render. The marker is a comment, so it never affects
// how the email displays.
func MarkHTML(html string) string {
	if strings.Contains(html, Marker) {
		return html
	}
	tag := "<!-- " + Marker + " -->"
	// Prefer just-inside <body>; fall back to prepending so even a fragment is
	// marked.
	if idx := bodyOpenIndex(html); idx >= 0 {
		return html[:idx] + "\n" + tag + html[idx:]
	}
	return tag + "\n" + html
}

// MarkText marks a plain-text field (a subject line, an SMS body) by recording
// provenance rather than mutating the visible text — you cannot hide a comment
// in a subject line. Callers persist the returned Provenance; IsMarkedText
// reports whether a stored marker is present.
func MarkText(text, model string) (string, Provenance) {
	return text, NewProvenance(model)
}

// IsMarkedHTML reports whether an HTML body already carries the marker.
func IsMarkedHTML(html string) bool { return strings.Contains(html, Marker) }

// HeaderName is the delivery header that flags a message as containing
// AI-generated content, so downstream systems (and auditors) can detect it
// without parsing the body.
const HeaderName = "X-Postwave-AI-Generated"

// bodyOpenIndex returns the index just after the first <body ...> tag, or -1.
func bodyOpenIndex(html string) int {
	lower := strings.ToLower(html)
	i := strings.Index(lower, "<body")
	if i < 0 {
		return -1
	}
	close := strings.IndexByte(lower[i:], '>')
	if close < 0 {
		return -1
	}
	return i + close + 1
}
