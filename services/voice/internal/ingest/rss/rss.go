// Package rss ingests blog/newsletter posts from an RSS or Atom feed.
package rss

import (
	"context"
	"fmt"
	"iter"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"
	"github.com/mmcdole/gofeed"
	xhtml "golang.org/x/net/html"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

const defaultLimit = 50

// Source is an RSS/Atom ingestion source.
type Source struct {
	parser *gofeed.Parser
	policy *bluemonday.Policy
}

// New constructs a default Source.
//
// The gofeed parser is wired with an SSRF-safe http.Client (see
// safe_transport.go) so an operator-configured FeedURL that
// resolves to a private/loopback/link-local IP is refused at dial
// time. Without this, gofeed uses http.DefaultClient and would
// happily fetch e.g. http://169.254.169.254/ (AWS instance
// metadata) — audit finding M2, SSRF.
func New() *Source {
	parser := gofeed.NewParser()
	parser.Client = newSecureHTTPClient(10 * time.Second)
	return &Source{
		parser: parser,
		policy: bluemonday.StrictPolicy(),
	}
}

// Type implements ingest.Source.
func (s *Source) Type() ingest.SourceType { return ingest.SourceBlogRSS }

// Ingest fetches the feed and yields up to params.Limit items.
func (s *Source) Ingest(ctx context.Context, params ingest.IngestParams) (iter.Seq2[ingest.Item, error], error) {
	if params.FeedURL == "" {
		return nil, fmt.Errorf("rss: FeedURL required")
	}
	limit := params.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	feed, err := s.parser.ParseURLWithContext(params.FeedURL, ctx)
	if err != nil {
		return nil, fmt.Errorf("rss: parse %s: %w", params.FeedURL, err)
	}
	items := feed.Items
	if len(items) > limit {
		items = items[:limit]
	}

	return func(yield func(ingest.Item, error) bool) {
		for _, it := range items {
			if ctx.Err() != nil {
				yield(ingest.Item{}, ctx.Err())
				return
			}
			body := it.Content
			if body == "" {
				body = it.Description
			}
			text := htmlToText(s.policy, body)
			pub := it.PublishedParsed
			var when = it.UpdatedParsed
			if pub != nil {
				when = pub
			}
			out := ingest.Item{
				ID:         it.GUID,
				SourceType: ingest.SourceBlogRSS,
				Text:       text,
				URL:        it.Link,
				Title:      it.Title,
			}
			if when != nil {
				out.PublishedAt = *when
			}
			if !yield(out, nil) {
				return
			}
		}
	}, nil
}

// htmlToText strips HTML to plain text. We use bluemonday to sanitize then
// walk the resulting node tree and emit text content with paragraph breaks
// preserved.
func htmlToText(policy *bluemonday.Policy, raw string) string {
	if raw == "" {
		return ""
	}
	clean := policy.Sanitize(raw)
	doc, err := xhtml.Parse(strings.NewReader(clean))
	if err != nil {
		return strings.TrimSpace(clean)
	}
	var b strings.Builder
	var walk func(n *xhtml.Node)
	walk = func(n *xhtml.Node) {
		if n == nil {
			return
		}
		if n.Type == xhtml.TextNode {
			b.WriteString(n.Data)
		}
		if n.Type == xhtml.ElementNode {
			switch n.Data {
			case "p", "br", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6":
				b.WriteString("\n")
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == xhtml.ElementNode {
			switch n.Data {
			case "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6":
				b.WriteString("\n")
			}
		}
	}
	walk(doc)
	return collapseWhitespace(b.String())
}

func collapseWhitespace(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l != "" {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n\n")
}
