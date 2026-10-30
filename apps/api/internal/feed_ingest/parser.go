// SPDX-License-Identifier: AGPL-3.0-only
//
// parser.go — RSS 2.0 + Atom parsing on stdlib encoding/xml (no new
// deps; same stance as the marshal-side XML in internal/newsletter_feed
// and internal/podcast). The stdlib decoder does not resolve external
// entities, so a hostile feed can't make us fetch attacker URLs at
// parse time; size is capped by the fetcher before bytes reach here.
package feed_ingest

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
	"time"
)

// Item is one normalized feed entry, in document order (RSS/Atom
// convention: newest first).
type Item struct {
	// GUID is the dedupe key: <guid> (RSS) / <id> (Atom), falling back
	// to the item link when absent.
	GUID      string
	Title     string
	Link      string
	Summary   string
	Published time.Time // zero when the feed omits/garbles the date
}

// Feed is a parsed feed document.
type Feed struct {
	Title string
	Items []Item
}

// ---- RSS 2.0 ----

type rssDoc struct {
	XMLName xml.Name `xml:"rss"`
	Channel struct {
		Title string    `xml:"title"`
		Items []rssItem `xml:"item"`
	} `xml:"channel"`
}

type rssItem struct {
	GUID        string `xml:"guid"`
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	Description string `xml:"description"`
	PubDate     string `xml:"pubDate"`
}

// ---- Atom ----

type atomDoc struct {
	XMLName xml.Name    `xml:"feed"`
	Title   string      `xml:"title"`
	Entries []atomEntry `xml:"entry"`
}

type atomEntry struct {
	ID        string     `xml:"id"`
	Title     string     `xml:"title"`
	Links     []atomLink `xml:"link"`
	Summary   string     `xml:"summary"`
	Content   string     `xml:"content"`
	Updated   string     `xml:"updated"`
	Published string     `xml:"published"`
}

type atomLink struct {
	Rel  string `xml:"rel,attr"`
	Href string `xml:"href,attr"`
}

// ParseFeed sniffs the root element and parses RSS 2.0 ("rss") or Atom
// ("feed"). Anything else (RSS 1.0 RDF, HTML error pages, ...) is an
// error the run ledger surfaces verbatim.
func ParseFeed(data []byte) (*Feed, error) {
	root, err := rootElement(data)
	if err != nil {
		return nil, fmt.Errorf("feed_ingest: not valid XML: %w", err)
	}
	switch root {
	case "rss":
		return parseRSS(data)
	case "feed":
		return parseAtom(data)
	}
	return nil, fmt.Errorf("feed_ingest: unsupported feed format (root element <%s>; only RSS 2.0 and Atom are supported)", root)
}

// rootElement returns the local name of the document's first start
// element.
func rootElement(data []byte) (string, error) {
	dec := newDecoder(data)
	for {
		tok, err := dec.Token()
		if err != nil {
			if err == io.EOF {
				return "", fmt.Errorf("no root element")
			}
			return "", err
		}
		if se, ok := tok.(xml.StartElement); ok {
			return se.Name.Local, nil
		}
	}
}

// newDecoder builds a decoder tolerant of the charset declarations and
// minor entity sloppiness real-world feeds carry. External entities
// are never resolved (stdlib behavior).
func newDecoder(data []byte) *xml.Decoder {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	dec.CharsetReader = func(charset string, input io.Reader) (io.Reader, error) {
		// Pass UTF-8-compatible charsets through; reject the rest
		// rather than mis-decode.
		switch strings.ToLower(charset) {
		case "utf-8", "us-ascii", "ascii", "iso-8859-1", "latin1", "windows-1252":
			return input, nil
		}
		return nil, fmt.Errorf("unsupported charset %q", charset)
	}
	return dec
}

func parseRSS(data []byte) (*Feed, error) {
	var doc rssDoc
	if err := newDecoder(data).Decode(&doc); err != nil {
		return nil, fmt.Errorf("feed_ingest: parse RSS: %w", err)
	}
	f := &Feed{Title: strings.TrimSpace(doc.Channel.Title)}
	for _, it := range doc.Channel.Items {
		item := Item{
			GUID:      strings.TrimSpace(it.GUID),
			Title:     strings.TrimSpace(it.Title),
			Link:      strings.TrimSpace(it.Link),
			Summary:   strings.TrimSpace(it.Description),
			Published: parseFeedTime(it.PubDate),
		}
		if item.GUID == "" {
			item.GUID = item.Link
		}
		if item.GUID == "" {
			continue // nothing to dedupe on; skip
		}
		f.Items = append(f.Items, item)
	}
	return f, nil
}

func parseAtom(data []byte) (*Feed, error) {
	var doc atomDoc
	if err := newDecoder(data).Decode(&doc); err != nil {
		return nil, fmt.Errorf("feed_ingest: parse Atom: %w", err)
	}
	f := &Feed{Title: strings.TrimSpace(doc.Title)}
	for _, e := range doc.Entries {
		summary := strings.TrimSpace(e.Summary)
		if summary == "" {
			summary = strings.TrimSpace(e.Content)
		}
		when := e.Published
		if strings.TrimSpace(when) == "" {
			when = e.Updated
		}
		item := Item{
			GUID:      strings.TrimSpace(e.ID),
			Title:     strings.TrimSpace(e.Title),
			Link:      atomEntryLink(e.Links),
			Summary:   summary,
			Published: parseFeedTime(when),
		}
		if item.GUID == "" {
			item.GUID = item.Link
		}
		if item.GUID == "" {
			continue
		}
		f.Items = append(f.Items, item)
	}
	return f, nil
}

// atomEntryLink prefers rel="alternate" (or no rel), the conventional
// "view this entry" link.
func atomEntryLink(links []atomLink) string {
	var fallback string
	for _, l := range links {
		href := strings.TrimSpace(l.Href)
		if href == "" {
			continue
		}
		switch l.Rel {
		case "", "alternate":
			return href
		}
		if fallback == "" {
			fallback = href
		}
	}
	return fallback
}

// feedTimeLayouts covers the date shapes seen in real feeds: RFC1123
// variants for RSS pubDate, RFC3339 for Atom.
var feedTimeLayouts = []string{
	time.RFC1123Z,
	time.RFC1123,
	time.RFC3339,
	time.RFC3339Nano,
	"Mon, 2 Jan 2006 15:04:05 -0700",
	"Mon, 2 Jan 2006 15:04:05 MST",
	"2006-01-02T15:04:05Z0700",
	"2006-01-02 15:04:05",
}

func parseFeedTime(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	for _, layout := range feedTimeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// ItemsAfterGUID returns the items that appear BEFORE lastGUID in
// document order — i.e. the entries published since we last polled,
// assuming the standard newest-first feed ordering. An empty lastGUID
// (first poll) or a cursor that vanished from the window (feed moved
// on faster than the poll cadence) returns every item.
func ItemsAfterGUID(items []Item, lastGUID string) []Item {
	if lastGUID == "" {
		return items
	}
	for i, it := range items {
		if it.GUID == lastGUID {
			return items[:i]
		}
	}
	return items
}
