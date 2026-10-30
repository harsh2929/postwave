// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"math"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

// Text concealed by colour rather than by a display property.
//
// The visibility classifier caught `display:none`, `visibility:hidden`,
// `opacity:0`, zero font-size, off-screen offsets and literal `transparent`.
// It did not compute colour at all, so the oldest trick in the list —
// #ffffff text on a #ffffff background — passed clean, and so did every
// near-match chosen to survive a naive equality test (#fffffe on #ffffff).
//
// This is not a styling nit. Text a parser reads and a human cannot see is the
// delivery mechanism for the prompt injection F11 exists to block; concealment
// and injection are the same attack in two halves, and blocking only the words
// while leaving the hiding place open catches nothing that matters.
//
// BACKGROUND IS INHERITED. A colour check that reads only the element's own
// declarations misses the ordinary case, because the text carries `color` and
// an ancestor table cell carries `background-color`. This walks up for the
// nearest declared background and falls back to white — the default canvas an
// email client paints, and the assumption an attacker relies on.

// concealmentContrastThreshold is the ratio at or below which text is treated
// as concealed.
//
// Deliberately far below the WCAG 4.5:1 legibility floor. This is not an
// accessibility check and must not fire on low-contrast design — grey-on-white
// body text is a readability opinion, while 1.2:1 is not a colour choice anyone
// makes for text they intend to be read.
const concealmentContrastThreshold = 1.25

// namedCSSColors are the names that appear in real email HTML.
//
// Not the full CSS list: the long tail (`papayawhip`, `gainsboro`) never shows
// up in a concealment attempt, and every name added here is a name the parser
// must agree with the renderer about. White and its spellings matter most.
var namedCSSColors = map[string][3]float64{
	"white":       {1, 1, 1},
	"black":       {0, 0, 0},
	"transparent": {1, 1, 1}, // resolves to whatever is behind it; white is the email default
	"red":         {1, 0, 0},
	"green":       {0, 0.5019, 0},
	"blue":        {0, 0, 1},
	"yellow":      {1, 1, 0},
	"gray":        {0.5019, 0.5019, 0.5019},
	"grey":        {0.5019, 0.5019, 0.5019},
	"silver":      {0.7529, 0.7529, 0.7529},
	"whitesmoke":  {0.9607, 0.9607, 0.9607},
	"ivory":       {1, 1, 0.9411},
	"snow":        {1, 0.9803, 0.9803},
	"ghostwhite":  {0.9725, 0.9725, 1},
	"floralwhite": {1, 0.9803, 0.9411},
}

// parseCSSColor resolves a CSS colour to linear RGB in [0,1].
//
// Handles the three forms concealment actually uses: hex (3, 4, 6 or 8 digit),
// rgb()/rgba(), and the named colours above. Returns ok=false for anything else
// — a colour this cannot parse must not be silently treated as black, which
// would manufacture high contrast and hide the very case being looked for.
func parseCSSColor(raw string) (r, g, b float64, ok bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.ReplaceAll(value, " ", "")
	if value == "" {
		return 0, 0, 0, false
	}
	if rgb, found := namedCSSColors[value]; found {
		return rgb[0], rgb[1], rgb[2], true
	}
	if strings.HasPrefix(value, "#") {
		return parseHexColor(value[1:])
	}
	if strings.HasPrefix(value, "rgb(") || strings.HasPrefix(value, "rgba(") {
		inner := value[strings.Index(value, "(")+1:]
		inner = strings.TrimSuffix(inner, ")")
		parts := strings.Split(inner, ",")
		if len(parts) < 3 {
			return 0, 0, 0, false
		}
		channel := func(s string) (float64, bool) {
			if strings.HasSuffix(s, "%") {
				n, err := strconv.ParseFloat(strings.TrimSuffix(s, "%"), 64)
				if err != nil {
					return 0, false
				}
				return n / 100, true
			}
			n, err := strconv.ParseFloat(s, 64)
			if err != nil {
				return 0, false
			}
			return n / 255, true
		}
		var okAll bool
		if r, okAll = channel(parts[0]); !okAll {
			return 0, 0, 0, false
		}
		if g, okAll = channel(parts[1]); !okAll {
			return 0, 0, 0, false
		}
		if b, okAll = channel(parts[2]); !okAll {
			return 0, 0, 0, false
		}
		return r, g, b, true
	}
	return 0, 0, 0, false
}

func parseHexColor(s string) (r, g, b float64, ok bool) {
	switch len(s) {
	case 3, 4:
		s = string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]})
	case 6, 8:
		s = s[:6]
	default:
		return 0, 0, 0, false
	}
	component := func(part string) (float64, bool) {
		n, err := strconv.ParseInt(part, 16, 64)
		if err != nil {
			return 0, false
		}
		return float64(n) / 255, true
	}
	var okAll bool
	if r, okAll = component(s[0:2]); !okAll {
		return 0, 0, 0, false
	}
	if g, okAll = component(s[2:4]); !okAll {
		return 0, 0, 0, false
	}
	if b, okAll = component(s[4:6]); !okAll {
		return 0, 0, 0, false
	}
	return r, g, b, true
}

// relativeLuminance implements WCAG 2.x relative luminance.
func relativeLuminance(r, g, b float64) float64 {
	channel := func(c float64) float64 {
		if c <= 0.03928 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	return 0.2126*channel(r) + 0.7152*channel(g) + 0.0722*channel(b)
}

// colorContrastRatio returns the WCAG contrast ratio between two colours.
func colorContrastRatio(fr, fg, fb, br, bg, bb float64) float64 {
	l1 := relativeLuminance(fr, fg, fb)
	l2 := relativeLuminance(br, bg, bb)
	lighter, darker := l1, l2
	if l2 > l1 {
		lighter, darker = l2, l1
	}
	return (lighter + 0.05) / (darker + 0.05)
}

// resolveBackground walks ancestors for the nearest declared background colour.
//
// Falls back to white, which is what an email client paints when nothing says
// otherwise — and therefore the canvas a concealment attempt is written
// against. Returning "unknown" here instead would make the common case
// unanalysable, which is the same as not checking.
func resolveBackground(node *html.Node, styleFor func(*html.Node) map[string]string) (r, g, b float64) {
	for current := node; current != nil; current = current.Parent {
		if current.Type != html.ElementNode {
			continue
		}
		style := styleFor(current)
		for _, property := range []string{"background-color", "background"} {
			raw, exists := style[property]
			if !exists {
				continue
			}
			// `background` is shorthand and may carry more than a colour; the
			// first token is the colour when one is present.
			candidate := strings.Fields(strings.TrimSpace(raw))
			if len(candidate) == 0 {
				continue
			}
			if cr, cg, cb, ok := parseCSSColor(candidate[0]); ok {
				if strings.EqualFold(strings.TrimSpace(candidate[0]), "transparent") {
					continue
				}
				return cr, cg, cb
			}
		}
		if bgcolor, exists := attribute(current, "bgcolor"); exists {
			if cr, cg, cb, ok := parseCSSColor(bgcolor); ok {
				return cr, cg, cb
			}
		}
	}
	return 1, 1, 1
}

// concealedByContrast reports whether this element's text is hidden by colour.
//
// Returns the ratio so the finding can name it: "1.0:1" tells an author exactly
// what happened, where "hidden text" invites an argument.
func concealedByContrast(
	node *html.Node,
	style map[string]string,
	styleFor func(*html.Node) map[string]string,
) (float64, bool) {
	raw, exists := style["color"]
	if !exists {
		return 0, false
	}
	fr, fg, fb, ok := parseCSSColor(raw)
	if !ok {
		return 0, false
	}
	br, bg, bb := resolveBackground(node, styleFor)
	ratio := colorContrastRatio(fr, fg, fb, br, bg, bb)
	return ratio, ratio <= concealmentContrastThreshold
}

// formatContrastRatio renders a ratio for a finding reason, e.g. "1.00".
//
// Fixed two decimals so the reason string is stable across runs and diffable in
// a golden test; a bare float would vary in the last digit between platforms.
func formatContrastRatio(ratio float64) string {
	return strconv.FormatFloat(ratio, 'f', 2, 64)
}
