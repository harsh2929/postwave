package profile

import (
	"regexp"
	"strings"
)

// SentenceSegmenter splits prose into sentences while protecting common
// abbreviations, URLs, decimals, and ellipses that would otherwise be
// false-positive boundaries for the naive `[.!?]\s+[A-Z]` regex.
//
// Approach (intentionally non-statistical — pure stdlib, no model):
//
//  1. Pre-pass: replace terminal periods inside protected patterns with a
//     unicode sentinel rune (U+E000, in the Private Use Area) so the
//     boundary regex cannot fire on them.
//  2. Boundary detection: split on `[.!?]+\s+[A-Za-z0-9\"'(\[]` — terminal
//     punctuation, whitespace, then a likely next sentence start.
//  3. Restore sentinels.
//  4. Trim each sentence and drop empties.
//
// Limitations honestly documented:
//   - Doesn't handle non-Latin scripts or sentences ending without terminal
//     punctuation.
//   - Mid-sentence quotations with their own terminal punctuation
//     ("She said 'Stop.' and walked off.") may split at the inner period
//     when the trailing fragment starts with a capital.

// abbreviations is a curated list of ~50 common abbreviations whose
// internal periods should NOT be treated as sentence boundaries.
//
// We split into two tiers because an abbreviation's "is this period a
// boundary?" answer depends on what follows:
//
//   - hardAbbreviations: titles + initialisms that are basically never
//     sentence-final ("Dr.", "U.S.", "St."). We mask these unconditionally.
//
//   - softAbbreviations: things like "Inc.", "etc.", "e.g.", month names —
//     these are mid-sentence about 70% of the time but legitimately end
//     a sentence the rest. We only mask their period when the NEXT
//     character is NOT a sentence boundary signal (whitespace + uppercase).
//     This way "Dr. Smith" is preserved but "Inc. Last" can split.
//     Latin connectors "e.g." / "i.e." are an exception we hardcode as
//     hardAbbreviations because they're almost never sentence-final.
//
// Sources (for honesty):
//   - Common English titles from Chicago Manual of Style §10
//   - Common Latin abbreviations from Merriam-Webster
//   - U.S. state two-letter forms are NOT included (they don't end in ".")
var hardAbbreviations = []string{
	// Personal titles + clergy/military
	"Mr.", "Mrs.", "Ms.", "Mx.", "Dr.", "Prof.", "Sr.", "Jr.", "St.",
	"Hon.", "Rev.", "Fr.", "Capt.", "Cmdr.", "Lt.", "Sgt.", "Gen.", "Col.", "Maj.",
	// Latin connectors that introduce an example or expansion (almost
	// never sentence-final).
	"e.g.", "i.e.", "viz.", "cf.", "et al.", "ibid.",
	// Geographic initialisms (multiple internal periods).
	"U.S.", "U.K.", "U.S.A.", "E.U.", "U.N.", "D.C.", "N.Y.", "L.A.",
	// Common headline abbreviations.
	"No.", "Vol.", "pp.", "p.", "Fig.", "Eq.", "Sec.", "Ch.",
}

var softAbbreviations = []string{
	// Corporate suffixes — sometimes end the sentence ("...acquired Acme Inc.").
	"Inc.", "Ltd.", "Co.", "Corp.", "LLC.", "LLP.", "PLC.", "GmbH.",
	// "etc." / "vs." commonly end clauses.
	"etc.", "vs.",
	// Time markers — common at sentence end ("at 6 a.m.").
	"a.m.", "p.m.", "A.M.", "P.M.",
	// Months / weekdays — common at sentence end ("...we met in Jan.").
	"Jan.", "Feb.", "Mar.", "Apr.", "Jun.", "Jul.", "Aug.", "Sep.", "Sept.", "Oct.", "Nov.", "Dec.",
	"Mon.", "Tue.", "Wed.", "Thu.", "Fri.", "Sat.", "Sun.",
	// Units — usually mid-sentence but occasionally at end.
	"ft.", "in.", "ml.", "kg.", "lb.", "oz.",
}

// sentinel is a Private-Use-Area rune used to stand in for a protected
// period during segmentation. We pick U+E000 because it never occurs in
// natural prose — if it does, it survives the round-trip unchanged.
const sentinel rune = ''

var sentinelStr = string(sentinel)

// urlRe matches http(s)://... or www.... up to the first whitespace or
// closing bracket. The trailing sentence-terminal punctuation (".!?,;:")
// is intentionally NOT consumed so a sentence-ending period after a URL
// can still serve as a boundary.
//
// We do this by character-class — URL body characters are alphanumerics
// + a fixed set of URL-safe punctuation EXCEPT the terminators above.
// "." IS allowed (e.g. "example.com") so we strip a trailing "." in a
// post-pass below.
var urlRe = regexp.MustCompile(`(?i)\b(?:https?://|www\.)[\w\-./?#&=%~+:!$'*@]+`)

// decimalRe matches digit.digit (e.g. "3.14", "1,234.56") so the inner
// period is preserved.
var decimalRe = regexp.MustCompile(`\d+\.\d+`)

// ellipsisRe matches three or more consecutive dots (with optional internal
// whitespace) as a single unit. We mask all but the LAST period — the
// final period is preserved so an ellipsis followed by " <Capital>" can
// still serve as a sentence boundary ("...he hesitated... Then he spoke.").
var ellipsisRe = regexp.MustCompile(`\.{2,}|\.\s\.\s\.`)

// maskEllipsis masks all leading periods of the matched ellipsis run but
// keeps the final period unmasked, so it can still act as a sentence
// boundary when followed by whitespace + capital.
func maskEllipsis(match string) string {
	// Find the last '.' index; mask everything before it.
	last := strings.LastIndex(match, ".")
	if last < 0 {
		return match
	}
	prefix := strings.ReplaceAll(match[:last], ".", sentinelStr)
	return prefix + match[last:]
}

// initialRe matches single-letter initials like "J. R. R." — a single
// capital letter, a period, whitespace, then another capital letter
// (likely a name, not a sentence boundary). RE2 doesn't have lookaheads,
// so we capture the trailing capital and re-emit it.
var initialRe = regexp.MustCompile(`\b([A-Z])\.(\s)([A-Z])`)

var compactInitialismBoundaryRe = regexp.MustCompile(`\b(?:[A-Z]\.)+[A-Z]` + regexp.QuoteMeta(sentinelStr) + `\s+[A-Z0-9"'(\[]`)

// hardAbbrevRe matches abbreviations that should ALWAYS be protected from
// sentence segmentation. Built from the hardAbbreviations list at init.
var hardAbbrevRe = func() *regexp.Regexp {
	parts := make([]string, 0, len(hardAbbreviations))
	for _, a := range hardAbbreviations {
		parts = append(parts, regexp.QuoteMeta(a))
	}
	return regexp.MustCompile(`(?i)\b(?:` + strings.Join(parts, "|") + `)`)
}()

// softAbbrevRe matches abbreviations that are protected ONLY when followed
// by something other than a sentence-boundary signal (whitespace + uppercase).
// We protect the abbreviation when the next char is a comma, semicolon,
// colon, close-paren/bracket, or whitespace + lowercase letter — leaving
// the genuine sentence-end uses ("Inc. Last quarter...") to fall through.
//
// IMPORTANT: we cannot use the `(?i)` flag because RE2 applies it
// globally and `[a-z]` would silently become `[a-zA-Z]`, defeating the
// whole disambiguation. Instead, we expand each abbreviation into a
// hand-built case-insensitive alternation for letters only.
var softAbbrevRe = func() *regexp.Regexp {
	parts := make([]string, 0, len(softAbbreviations))
	for _, a := range softAbbreviations {
		var b strings.Builder
		for i := 0; i < len(a); i++ {
			c := a[i]
			switch {
			case c >= 'a' && c <= 'z':
				b.WriteByte('[')
				b.WriteByte(c)
				b.WriteByte(c - 'a' + 'A')
				b.WriteByte(']')
			case c >= 'A' && c <= 'Z':
				b.WriteByte('[')
				b.WriteByte(c - 'A' + 'a')
				b.WriteByte(c)
				b.WriteByte(']')
			default:
				b.WriteString(regexp.QuoteMeta(string(c)))
			}
		}
		parts = append(parts, b.String())
	}
	return regexp.MustCompile(`\b(?:` + strings.Join(parts, "|") + `)(?:[,;:)\]]|\s+[a-z])`)
}()

// boundaryRe finds true sentence boundaries: terminal punctuation +
// whitespace + likely next sentence start. Lowercase starts are accepted
// because newsletter/social prose often uses casual sentence casing.
var boundaryRe = regexp.MustCompile(`([.!?]+)(\s+)([A-Za-z0-9"'(\[])`)

var initialismBoundaryMaskedRe = regexp.MustCompile(`\b(?:[A-Z]` + regexp.QuoteMeta(sentinelStr) + `){2,}\s+[A-Z0-9"'(\[]`)

// softAbbrevReplacer mirrors softAbbrevRe but strips the abbreviation's
// internal periods to sentinels. The capture group $2 (trailing context)
// is re-emitted unchanged.
func softAbbrevReplacer(match string) string {
	// Find where the abbreviation ends — softAbbrevRe captures the
	// abbreviation as group 1. Since ReplaceAllStringFunc gives us the
	// raw match, we re-find the boundary by stripping back from the end
	// to the last alpha or '.' char.
	// Simpler approach: just mask all periods in the matched span. The
	// trailing context never contains '.', so this is safe.
	return strings.ReplaceAll(match, ".", sentinelStr)
}

// SegmentSentences splits `text` into sentences. Empty input yields nil.
//
// The function is pure (no I/O) and safe for concurrent use.
func SegmentSentences(text string) []string {
	if strings.TrimSpace(text) == "" {
		return nil
	}

	// Step 1: protect known patterns by replacing their internal periods
	// with the sentinel rune.
	masked := text
	masked = urlRe.ReplaceAllStringFunc(masked, maskURL)
	masked = decimalRe.ReplaceAllStringFunc(masked, maskPeriods)
	masked = ellipsisRe.ReplaceAllStringFunc(masked, maskEllipsis)
	// RE2 has no lookahead, so we must consume the trailing capital and
	// re-emit it. We loop because consecutive initials ("J. R. R.")
	// overlap on each capital — one pass would only catch every other
	// pair. A second pass picks up the remainder.
	for i := 0; i < 3; i++ {
		next := initialRe.ReplaceAllString(masked, "$1"+sentinelStr+"$2$3")
		if next == masked {
			break
		}
		masked = next
	}
	masked = restoreCompactInitialismBoundary(masked)
	// Hard abbreviations: always mask their periods (Mr., Dr., U.S., etc.).
	masked = hardAbbrevRe.ReplaceAllStringFunc(masked, maskPeriods)
	// Restore the final period of initialisms that appear sentence-final:
	// "D.C. The next..." should split, while "U.S. to Canada" remains masked.
	masked = restoreInitialismSentenceBoundaries(masked)
	// Soft abbreviations: only mask when followed by a non-boundary signal
	// (lowercase continuation, comma, semicolon, etc.). When followed by
	// "<space><uppercase>", we leave the period as-is so it can split.
	masked = softAbbrevRe.ReplaceAllStringFunc(masked, softAbbrevReplacer)

	// Step 2: insert a record-separator at every detected boundary.
	// We use \x1f (ASCII US) — distinct from the sentinel rune.
	withBoundaries := boundaryRe.ReplaceAllString(masked, "$1\x1f$3")

	// Step 3: split, restore sentinels, trim.
	parts := strings.Split(withBoundaries, "\x1f")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.ReplaceAll(p, sentinelStr, ".")
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func restoreInitialismSentenceBoundaries(s string) string {
	return initialismBoundaryMaskedRe.ReplaceAllStringFunc(s, func(match string) string {
		idx := strings.LastIndex(match, sentinelStr)
		if idx < 0 {
			return match
		}
		return match[:idx] + "." + match[idx+len(sentinelStr):]
	})
}

func restoreCompactInitialismBoundary(s string) string {
	return compactInitialismBoundaryRe.ReplaceAllStringFunc(s, func(match string) string {
		idx := strings.LastIndex(match, sentinelStr)
		if idx < 0 {
			return match
		}
		return match[:idx] + "." + match[idx+len(sentinelStr):]
	})
}

// maskPeriods replaces every '.' in s with the sentinel rune.
func maskPeriods(s string) string {
	return strings.ReplaceAll(s, ".", sentinelStr)
}

// maskURL is like maskPeriods but preserves any trailing terminal
// punctuation. Without this, the URL regex eats the sentence-ending
// period AFTER a URL ("Visit https://x.com. Then..." would lose its
// boundary period).
func maskURL(match string) string {
	// Slice off any trailing terminator characters so they keep their
	// boundary semantics. We accept ".,!?;:)" as terminators — `)` is
	// included for parenthetical URLs.
	tail := ""
	for len(match) > 0 {
		c := match[len(match)-1]
		if c == '.' || c == ',' || c == '!' || c == '?' || c == ';' || c == ':' || c == ')' {
			tail = string(c) + tail
			match = match[:len(match)-1]
			continue
		}
		break
	}
	return strings.ReplaceAll(match, ".", sentinelStr) + tail
}
