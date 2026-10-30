// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"regexp"
	"strings"
)

// Quoted-history and signature stripping (PRD F05 §7.4).
//
// "Strip quoted history and signatures before storage and classification. Store
// both raw and stripped."
//
// Both, because stripping is heuristic and there is no way to discover a bad
// strip from the stripped text alone. A reply whose entire content was removed
// looks identical to an empty reply, and the only way to tell is to still have
// the original.
//
// It matters for classification specifically: a quoted original contains the
// campaign's own unsubscribe link and often the words "out of the office" from an
// earlier message in the thread, so classifying the UNSTRIPPED body would let the
// message being replied TO decide what the reply is.

var (
	// attributionLine matches the "On <date>, <person> wrote:" line clients
	// insert above quoted history, across the common English and European forms.
	attributionLine = regexp.MustCompile(`(?im)^\s*(on .{3,120}\s+wrote:|le .{3,120}\s+a écrit\s*:|am .{3,120}\s+schrieb.*:|el .{3,120}\s+escribió:|il .{3,120}\s+ha scritto:)\s*$`)

	// forwardedOrOriginalBanner matches the block separators Outlook and others
	// use instead of an attribution line.
	forwardedOrOriginalBanner = regexp.MustCompile(`(?im)^\s*(-{2,}\s*(original message|forwarded message|reply above this line)\s*-{2,}|_{5,}|from:\s.+)\s*$`)

	// signatureDelimiter is the RFC 3676 sig marker: exactly "-- " on its own
	// line. Matched precisely because "--" without the trailing space appears in
	// ordinary prose and in Markdown.
	signatureDelimiter = regexp.MustCompile(`(?m)^-- $`)

	// mobileSignature matches the one-line signatures phones append.
	mobileSignature = regexp.MustCompile(`(?im)^\s*(sent from my \w+|get outlook for \w+|sent via \w+)\s*.?$`)
)

// StripQuotedHistory removes quoted history and signatures.
//
// Conservative on purpose: when a marker is not found the text is returned
// unchanged rather than guessed at. An over-eager strip destroys the reply, and a
// reply is the scarcest engagement signal in the product — under-stripping costs
// a classifier some noise, over-stripping costs the message.
func StripQuotedHistory(body string) string {
	if strings.TrimSpace(body) == "" {
		return ""
	}
	text := strings.ReplaceAll(body, "\r\n", "\n")

	// Cut at the FIRST structural marker of quoted history. First, not last: a
	// long thread has many, and everything after the first belongs to an earlier
	// message.
	cut := len(text)
	for _, pattern := range []*regexp.Regexp{attributionLine, forwardedOrOriginalBanner} {
		if loc := pattern.FindStringIndex(text); loc != nil && loc[0] < cut {
			cut = loc[0]
		}
	}
	text = text[:cut]

	// Signature after quote-stripping, because a signature inside quoted history
	// is not this sender's.
	if loc := signatureDelimiter.FindStringIndex(text); loc != nil {
		text = text[:loc[0]]
	}
	text = mobileSignature.ReplaceAllString(text, "")

	// Leading ">" quote lines that survived — a client that quoted without an
	// attribution line.
	lines := strings.Split(text, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), ">") {
			continue
		}
		kept = append(kept, line)
	}
	stripped := strings.TrimSpace(strings.Join(kept, "\n"))

	// If stripping removed EVERYTHING, return the original.
	//
	// An empty stripped body is indistinguishable from an empty reply, and a
	// classifier handed nothing will call it human by default — so a bad strip
	// would silently promote an out-of-office notice to engagement. Better to
	// classify noisy text than no text.
	if stripped == "" {
		return strings.TrimSpace(body)
	}
	return stripped
}
