// SPDX-License-Identifier: AGPL-3.0-only
//
// Package html2text converts an HTML email body into a readable
// plain-text alternative suitable for the `text/plain` MIME part.
//
// Why this matters:
//
//   * inbox providers (Gmail, Outlook, Yahoo) include the plaintext
//     part in their spam-score calculation; absence or low quality
//     of plain-text increases the chance of inbox→promotions or
//     promotions→spam classification by ~10-15%
//   * accessibility: assistive tech that doesn't render HTML falls
//     back to the text part
//   * deliverability: some MTAs reject HTML-only multipart messages
//     outright (notably enterprise spam appliances)
//
// The conversion is intentionally minimalist — we don't try to
// reproduce table layouts or images. The output preserves:
//
//   * headings as ALL-CAPS lines surrounded by blank lines
//   * paragraphs separated by blank lines
//   * list items as "- item"
//   * link text followed by ` (url)`
//
// Surfaces:
//
//   POST /api/v1/html2text     body: {html} → {text}
//
// The actual conversion is also exported via the Convert function
// so the campaign editor / pre-send pipeline can auto-fill
// `campaigns.plain_text` when the operator hasn't.

package html2text

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/net/html"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// Deps wires the HTTP surface. No DB needed.
type Deps struct {
	Logger *slog.Logger
}

type convertReq struct {
	HTML string `json:"html"`
}

// MountRoutes registers the single endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Post("/api/v1/html2text", d.Convert)
}

// Convert POST /api/v1/html2text.
func (d *Deps) Convert(w http.ResponseWriter, r *http.Request) {
	var body convertReq
	if err := httpbody.DecodeJSONWith(w, r, 4<<20, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	text := Convert(body.HTML)
	writeJSON(w, http.StatusOK, map[string]any{"text": text})
}

// --- core converter ---

// Convert turns HTML into plain text. Idempotent on non-HTML input.
// Safe for untrusted input — never executes script, never follows
// network references.
func Convert(input string) string {
	if input == "" {
		return ""
	}
	doc, err := html.Parse(strings.NewReader(input))
	if err != nil {
		return collapseWhitespace(input)
	}
	var b strings.Builder
	walk(doc, &b, walkState{})
	return cleanup(b.String())
}

type walkState struct {
	inPre    bool
	listLvl  int
	listKind string // "ul" or "ol"
	olCount  int
	inLink   bool
	href     string
}

func walk(n *html.Node, b *strings.Builder, s walkState) {
	switch n.Type {
	case html.TextNode:
		text := n.Data
		if !s.inPre {
			text = collapseWhitespace(text)
		}
		b.WriteString(text)
		return
	case html.ElementNode:
		// Skip non-content elements outright.
		switch n.Data {
		case "script", "style", "head", "meta", "title", "noscript":
			return
		}
		// Handle block-level openings.
		switch n.Data {
		case "br":
			b.WriteString("\n")
			return
		case "hr":
			b.WriteString("\n---\n")
			return
		case "img":
			alt := attr(n, "alt")
			if alt != "" {
				b.WriteString("[image: ")
				b.WriteString(alt)
				b.WriteString("]")
			}
			return
		case "h1", "h2", "h3", "h4", "h5", "h6":
			b.WriteString("\n\n")
			var hb strings.Builder
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, &hb, s)
			}
			b.WriteString(strings.ToUpper(strings.TrimSpace(hb.String())))
			b.WriteString("\n\n")
			return
		case "p", "div":
			b.WriteString("\n\n")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, s)
			}
			b.WriteString("\n\n")
			return
		case "ul":
			ns := s
			ns.listLvl++
			ns.listKind = "ul"
			b.WriteString("\n")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, ns)
			}
			b.WriteString("\n")
			return
		case "ol":
			ns := s
			ns.listLvl++
			ns.listKind = "ol"
			ns.olCount = 0
			b.WriteString("\n")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, ns)
			}
			b.WriteString("\n")
			return
		case "li":
			b.WriteString("\n")
			b.WriteString(strings.Repeat("  ", s.listLvl-1))
			b.WriteString("- ") // ordered counter omitted for simplicity
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, s)
			}
			return
		case "a":
			href := attr(n, "href")
			ns := s
			ns.inLink = true
			ns.href = href
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, ns)
			}
			if href != "" && !strings.HasPrefix(href, "mailto:") && !strings.HasPrefix(href, "tel:") {
				b.WriteString(" (")
				b.WriteString(href)
				b.WriteString(")")
			}
			return
		case "pre":
			ns := s
			ns.inPre = true
			b.WriteString("\n")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, ns)
			}
			b.WriteString("\n")
			return
		case "strong", "b", "em", "i":
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, s)
			}
			return
		case "table", "tr":
			b.WriteString("\n")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, s)
			}
			return
		case "td", "th":
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, b, s)
			}
			b.WriteString("\t")
			return
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		walk(c, b, s)
	}
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

var whitespaceRE = regexp.MustCompile(`[ \t\f\v]+`)
var blanklineRE = regexp.MustCompile(`\n{3,}`)

func collapseWhitespace(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	return whitespaceRE.ReplaceAllString(s, " ")
}

func cleanup(s string) string {
	s = blanklineRE.ReplaceAllString(s, "\n\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, strings.TrimRight(l, " \t"))
	}
	s = strings.Join(out, "\n")
	return strings.TrimSpace(s)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
