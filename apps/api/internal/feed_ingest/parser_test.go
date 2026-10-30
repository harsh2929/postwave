// SPDX-License-Identifier: AGPL-3.0-only
package feed_ingest

import (
	"strings"
	"testing"
)

const rssFixture = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Moosewave Blog</title>
    <link>https://blog.example.com</link>
    <description>News &amp; updates</description>
    <item>
      <title>Third post &amp; thoughts</title>
      <link>https://blog.example.com/three</link>
      <guid isPermaLink="false">guid-3</guid>
      <description>Summary three</description>
      <pubDate>Wed, 10 Jun 2026 09:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Second post</title>
      <link>https://blog.example.com/two</link>
      <guid>guid-2</guid>
      <description>Summary two</description>
      <pubDate>Tue, 09 Jun 2026 09:00:00 +0000</pubDate>
    </item>
    <item>
      <title>First post</title>
      <link>https://blog.example.com/one</link>
      <description>Summary one</description>
    </item>
  </channel>
</rss>`

const atomFixture = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link href="https://atom.example.com"/>
  <updated>2026-06-10T12:00:00Z</updated>
  <entry>
    <id>urn:uuid:entry-2</id>
    <title>Entry two</title>
    <link rel="self" href="https://atom.example.com/two.xml"/>
    <link rel="alternate" href="https://atom.example.com/two"/>
    <summary>Atom summary two</summary>
    <published>2026-06-10T11:00:00Z</published>
  </entry>
  <entry>
    <id>urn:uuid:entry-1</id>
    <title>Entry one</title>
    <link href="https://atom.example.com/one"/>
    <content type="text">Atom content one</content>
    <updated>2026-06-09T11:00:00Z</updated>
  </entry>
</feed>`

func TestParseRSS(t *testing.T) {
	feed, err := ParseFeed([]byte(rssFixture))
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	if feed.Title != "Moosewave Blog" {
		t.Fatalf("title = %q", feed.Title)
	}
	if len(feed.Items) != 3 {
		t.Fatalf("items = %d, want 3", len(feed.Items))
	}
	first := feed.Items[0]
	if first.GUID != "guid-3" {
		t.Errorf("guid = %q, want guid-3", first.GUID)
	}
	if first.Title != "Third post & thoughts" {
		t.Errorf("title = %q (entity decoding)", first.Title)
	}
	if first.Link != "https://blog.example.com/three" {
		t.Errorf("link = %q", first.Link)
	}
	if first.Summary != "Summary three" {
		t.Errorf("summary = %q", first.Summary)
	}
	if first.Published.IsZero() {
		t.Errorf("published not parsed from RFC1123Z pubDate")
	}
	// Item without <guid> falls back to its link.
	if feed.Items[2].GUID != "https://blog.example.com/one" {
		t.Errorf("guid fallback = %q, want link", feed.Items[2].GUID)
	}
}

func TestParseAtom(t *testing.T) {
	feed, err := ParseFeed([]byte(atomFixture))
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	if feed.Title != "Atom Example" {
		t.Fatalf("title = %q", feed.Title)
	}
	if len(feed.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(feed.Items))
	}
	first := feed.Items[0]
	if first.GUID != "urn:uuid:entry-2" {
		t.Errorf("guid = %q", first.GUID)
	}
	// rel="alternate" preferred over rel="self".
	if first.Link != "https://atom.example.com/two" {
		t.Errorf("link = %q, want the alternate link", first.Link)
	}
	if first.Summary != "Atom summary two" {
		t.Errorf("summary = %q", first.Summary)
	}
	if first.Published.IsZero() {
		t.Errorf("published not parsed from RFC3339")
	}
	// summary absent → content fallback; published absent → updated.
	second := feed.Items[1]
	if second.Summary != "Atom content one" {
		t.Errorf("content fallback = %q", second.Summary)
	}
	if second.Published.IsZero() {
		t.Errorf("updated fallback not parsed")
	}
}

func TestParseFeedRejectsUnsupported(t *testing.T) {
	cases := map[string]string{
		"html page":    `<!DOCTYPE html><html><body>not a feed</body></html>`,
		"rdf rss1":     `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>`,
		"not xml":      `{"json": true}`,
		"empty string": ``,
	}
	for name, body := range cases {
		if _, err := ParseFeed([]byte(body)); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}

func TestItemsAfterGUID(t *testing.T) {
	items := []Item{{GUID: "c"}, {GUID: "b"}, {GUID: "a"}}

	if got := ItemsAfterGUID(items, ""); len(got) != 3 {
		t.Errorf("empty cursor: got %d items, want all 3", len(got))
	}
	if got := ItemsAfterGUID(items, "a"); len(got) != 2 || got[0].GUID != "c" || got[1].GUID != "b" {
		t.Errorf("cursor a: got %+v, want [c b]", got)
	}
	if got := ItemsAfterGUID(items, "c"); len(got) != 0 {
		t.Errorf("cursor at newest: got %d items, want 0", len(got))
	}
	// Cursor that fell out of the window → everything is new.
	if got := ItemsAfterGUID(items, "gone"); len(got) != 3 {
		t.Errorf("vanished cursor: got %d items, want all 3", len(got))
	}
}

func TestRenderSubject(t *testing.T) {
	items := []Item{{Title: "Newest"}, {Title: "Older"}}
	got := RenderSubject("{{name}}: {{title}} (+{{count}})", "My Feed", items)
	if got != "My Feed: Newest (+2)" {
		t.Errorf("subject = %q", got)
	}
	// Empty render falls back to the source name.
	if got := RenderSubject("{{title}}", "My Feed", []Item{{Title: ""}}); got != "My Feed" {
		t.Errorf("fallback subject = %q", got)
	}
}

func TestRenderDigestHTMLEscapesAndFiltersLinks(t *testing.T) {
	items := []Item{
		{Title: `<script>alert(1)</script>`, Link: "javascript:alert(1)", Summary: `<b>bold</b> & "quotes"`},
		{Title: "Safe", Link: "https://ok.example.com/post"},
	}
	out := RenderDigestHTML("Feed <Title>", "src", items)
	if strings.Contains(out, "<script>") {
		t.Errorf("title not escaped: %s", out)
	}
	if strings.Contains(out, "javascript:") {
		t.Errorf("javascript: link not dropped: %s", out)
	}
	if strings.Contains(out, "<b>") {
		t.Errorf("summary HTML not escaped: %s", out)
	}
	if !strings.Contains(out, `href="https://ok.example.com/post"`) {
		t.Errorf("safe link missing: %s", out)
	}
	if !strings.Contains(out, "Feed &lt;Title&gt;") {
		t.Errorf("heading not escaped: %s", out)
	}
}
