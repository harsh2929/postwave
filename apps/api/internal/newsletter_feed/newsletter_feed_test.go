// SPDX-License-Identifier: AGPL-3.0-only
package newsletter_feed

import (
	"encoding/xml"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/archive"
)

func renderRSSForTest(t *testing.T, items []archive.FeedIssue) string {
	t.Helper()
	rss := buildRSS(rssRenderOptions{
		Title:       "acme newsletter archive",
		Description: "Published issues from acme.",
		HomeURL:     "https://archive.moosewave.com/archive/acme",
		FeedURL:     "https://archive.moosewave.com/api/public/archive/acme/feed.xml",
		ItemBaseURL: "https://archive.moosewave.com/archive/acme/",
	}, items)
	out, err := xml.MarshalIndent(rss, "", "  ")
	if err != nil {
		t.Fatalf("marshal RSS: %v", err)
	}
	return xml.Header + string(out)
}

func TestRSSWithAllFields(t *testing.T) {
	got := renderRSSForTest(t, []archive.FeedIssue{{
		Slug:        "issue-42",
		Subject:     "Hello & welcome",
		Excerpt:     "First issue summary.",
		HTMLBody:    `<p>Full <strong>HTML</strong> body with <a href="https://example.test/read">links</a>.</p>`,
		HeroImage:   "https://cdn.example.com/hero.png",
		AuthorName:  "Moosewave Team",
		PublishedAt: time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC),
	}})

	for label, needle := range map[string]string{
		"rss root":          `<rss version="2.0"`,
		"atom namespace":    `xmlns:atom="http://www.w3.org/2005/Atom"`,
		"dc namespace":      `xmlns:dc="http://purl.org/dc/elements/1.1/"`,
		"content namespace": `xmlns:content="http://purl.org/rss/1.0/modules/content/"`,
		"itunes namespace":  `xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"`,
		"media namespace":   `xmlns:media="http://search.yahoo.com/mrss/"`,
		"self link":         `<atom:link href="https://archive.moosewave.com/api/public/archive/acme/feed.xml" rel="self" type="application/rss+xml"></atom:link>`,
		"escaped title":     `<title>Hello &amp; welcome</title>`,
		"permalink guid":    `<guid isPermaLink="true">https://archive.moosewave.com/archive/acme/issue-42</guid>`,
		"author":            `<dc:creator>Moosewave Team</dc:creator>`,
		"full HTML":         `<content:encoded><![CDATA[<p>Full <strong>HTML</strong> body with <a href="https://example.test/read" rel="nofollow noreferrer">links</a>.</p>]]></content:encoded>`,
		"enclosure":         `<enclosure url="https://cdn.example.com/hero.png" type="image/png" length="0"></enclosure>`,
		"itunes image":      `<itunes:image href="https://cdn.example.com/hero.png"></itunes:image>`,
		"media image":       `<media:content url="https://cdn.example.com/hero.png" medium="image" type="image/png"></media:content>`,
	} {
		mustContain(t, got, needle, label)
	}
}

func TestRSSOmitsOptionalElementsWhenMissing(t *testing.T) {
	got := renderRSSForTest(t, []archive.FeedIssue{{
		Slug:        "minimal",
		Subject:     "Bare item",
		Excerpt:     "summary",
		PublishedAt: time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC),
	}})

	for _, forbidden := range []string{
		"<dc:creator>",
		"<content:encoded>",
		"<enclosure ",
		"<itunes:image ",
		"<media:content ",
	} {
		if strings.Contains(got, forbidden) {
			t.Errorf("optional element %q should be absent:\n%s", forbidden, got)
		}
	}
	mustContain(t, got, `<atom:link `, "channel self link remains present")
}

func TestRSSCDATAEscapesNestedTerminatorAndInvalidXMLControls(t *testing.T) {
	content := newCDATA("before\x00]]>after")
	rss := rssFeed{
		Version: "2.0",
		Channel: rssChannel{
			Title:       "safe",
			Link:        "https://example.test",
			Description: "safe",
			Items: []rssItem{{
				Title:          "edge",
				ContentEncoded: content,
			}},
		},
	}
	out, err := xml.Marshal(rss)
	if err != nil {
		t.Fatalf("marshal RSS: %v", err)
	}
	got := string(out)
	mustContain(t, got, `<![CDATA[before]]]]><![CDATA[>after]]>`, "embedded CDATA terminator split")
	if strings.ContainsRune(got, '\x00') {
		t.Fatalf("invalid XML control leaked into RSS: %q", got)
	}
	assertWellFormedXML(t, got)
}

func TestFeedHTMLSanitizerRemovesActiveContentAndUnsafeURLs(t *testing.T) {
	unsafe := `<div style="background:url(javascript:alert(1))" onclick="alert(1)">` +
		`<script>alert(1)</script><form action="https://evil.test"><input value="secret"></form>` +
		`<a href="javascript:alert(1)">unsafe</a>` +
		`<a href="https://user:pass@cdn.example.com/private">credential-link</a>` +
		`<img src="http://127.0.0.1/private.png" alt="private">` +
		`<img src="https://cdn.example.com/image.png?name=%0aInjected" alt="control">` +
		`<a href="https://example.test/read">safe</a>` +
		`<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="bad">` +
		`<strong>kept</strong></div>`
	got := sanitizeFeedHTML(unsafe)

	for _, forbidden := range []string{
		"<script", "alert(1)", "<form", "<input", "onclick", "style=", "javascript:", "data:image",
		"user:pass@", "127.0.0.1", "%0ainjected",
	} {
		if strings.Contains(strings.ToLower(got), forbidden) {
			t.Errorf("sanitized feed HTML retained %q: %s", forbidden, got)
		}
	}
	for _, required := range []string{
		`<a href="https://example.test/read" rel="nofollow noreferrer">safe</a>`,
		`<strong>kept</strong>`,
	} {
		mustContain(t, got, required, "safe HTML retained")
	}
}

func TestRSSRejectsLegacyUnsafeHeroImageAtRenderBoundary(t *testing.T) {
	for _, hero := range []string{
		"javascript:alert(1)",
		"data:image/png;base64,AAAA",
		"https://user:pass@cdn.example.com/private.png",
		"https://cdn.example.com:65536/private.png",
		"https://cdn..example.com/private.png",
		"https://cdn.example.com/image.png?name=%0aInjected",
		"http://127.0.0.1/private.png",
		"http://169.254.169.254/latest/meta-data/iam.png",
	} {
		t.Run(hero, func(t *testing.T) {
			got := renderRSSForTest(t, []archive.FeedIssue{{
				Slug:        "issue",
				Subject:     "Issue",
				HeroImage:   hero,
				PublishedAt: time.Unix(1, 0).UTC(),
			}})
			for _, forbidden := range []string{"<enclosure ", "<itunes:image ", "<media:content "} {
				if strings.Contains(got, forbidden) {
					t.Fatalf("unsafe hero %q produced %s:\n%s", hero, forbidden, got)
				}
			}
		})
	}
}

func TestResolveFeedPublicURLsUsesCanonicalHostedOrigin(t *testing.T) {
	got := resolveFeedPublicURLs(
		"https://archive.moosewave.com/",
		"acme",
		"tag/release-notes",
		"feed.xml",
		"/api/public/archive/acme/tag/release-notes/feed.xml",
		"",
	)
	want := feedPublicURLs{
		HomeURL:     "https://archive.moosewave.com/archive/acme",
		FeedURL:     "https://archive.moosewave.com/api/public/archive/acme/tag/release-notes/feed.xml",
		ItemBaseURL: "https://archive.moosewave.com/archive/acme/",
	}
	if got != want {
		t.Fatalf("canonical feed URLs = %+v, want %+v", got, want)
	}
}

func TestResolveFeedPublicURLsUsesOnlyVerifiedCustomHostInput(t *testing.T) {
	tests := []struct {
		name       string
		subPath    string
		feedFile   string
		customHost string
		want       feedPublicURLs
	}{
		{
			name:       "root RSS",
			feedFile:   "feed.xml",
			customHost: "News.Example.com",
			want: feedPublicURLs{
				HomeURL:     "https://news.example.com",
				FeedURL:     "https://news.example.com/feed.xml",
				ItemBaseURL: "https://news.example.com/",
			},
		},
		{
			name:       "tag JSON",
			subPath:    "tag/release-notes",
			feedFile:   "feed.json",
			customHost: "news.example.com",
			want: feedPublicURLs{
				HomeURL:     "https://news.example.com",
				FeedURL:     "https://news.example.com/tag/release-notes/feed.json",
				ItemBaseURL: "https://news.example.com/",
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveFeedPublicURLs(
				"https://archive.moosewave.com",
				"acme",
				tc.subPath,
				tc.feedFile,
				"/api/public/archive/acme/feed.xml",
				tc.customHost,
			)
			if got != tc.want {
				t.Fatalf("custom-domain feed URLs = %+v, want %+v", got, tc.want)
			}
		})
	}

	// Even if an untrusted caller reaches this pure helper, malformed host
	// material cannot become a public URL. The handler only supplies the
	// middleware's private verified context value.
	got := resolveFeedPublicURLs(
		"https://archive.moosewave.com", "acme", "", "feed.xml",
		"/api/public/archive/acme/feed.xml", "user:pass@evil.example",
	)
	if got.FeedURL != "https://archive.moosewave.com/api/public/archive/acme/feed.xml" {
		t.Fatalf("invalid custom host escaped canonical fallback: %+v", got)
	}
}

func TestRSSImageURLIsXMLAttributeEscaped(t *testing.T) {
	got := renderRSSForTest(t, []archive.FeedIssue{{
		Slug:        "issue",
		Subject:     "Issue",
		HeroImage:   "https://cdn.example.com/hero.png?width=600&quality=80",
		PublishedAt: time.Unix(1, 0).UTC(),
	}})
	mustContain(t, got, `url="https://cdn.example.com/hero.png?width=600&amp;quality=80"`, "image URL escaped")
	assertWellFormedXML(t, got)
}

func TestMimeFromURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://cdn.example.com/a.png", "image/png"},
		{"https://cdn.example.com/a.PNG", "image/png"},
		{"https://cdn.example.com/photo.jpg", "image/jpeg"},
		{"https://cdn.example.com/photo.jpeg", "image/jpeg"},
		{"https://cdn.example.com/anim.gif", "image/gif"},
		{"https://cdn.example.com/modern.webp", "image/webp"},
		{"https://cdn.example.com/next.avif", "image/avif"},
		{"https://cdn.example.com/logo.svg", "image/svg+xml"},
		{"https://cdn.example.com/scan.bmp", "image/bmp"},
		{"https://cdn.example.com/scan.tif", "image/tiff"},
		{"https://cdn.example.com/scan.tiff", "image/tiff"},
		{"https://cdn.example.com/hero.jpg?v=42&w=600", "image/jpeg"},
		{"https://cdn.example.com/hero.png#frag", "image/png"},
		{"https://cdn.example.com/unknown", "application/octet-stream"},
		{"https://cdn.example.com/unknown.xyz", "application/octet-stream"},
	}
	for _, tc := range cases {
		if got := mimeFromURL(tc.in); got != tc.want {
			t.Errorf("mimeFromURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestRSSParsesBackAsXML(t *testing.T) {
	got := renderRSSForTest(t, []archive.FeedIssue{
		{
			Slug:        "issue-1",
			Subject:     "First",
			Excerpt:     "summary",
			HTMLBody:    "<p>hello</p>",
			HeroImage:   "https://cdn.example.com/h.jpg",
			AuthorName:  "Alice",
			PublishedAt: time.Date(2026, 6, 3, 9, 30, 0, 0, time.UTC),
		},
		{
			Slug:        "issue-2",
			Subject:     "Second",
			Excerpt:     "summary 2",
			PublishedAt: time.Date(2026, 6, 2, 9, 30, 0, 0, time.UTC),
		},
	})
	assertWellFormedXML(t, got)
}

func TestJSONFeedV11Fields(t *testing.T) {
	item := buildJSONFeedItem("https://archive.moosewave.com/archive/acme/", archive.FeedIssue{
		Slug:        "issue-1",
		Subject:     "First",
		Excerpt:     "Summary",
		HTMLBody:    "<p>body</p>",
		HeroImage:   "https://cdn.example.com/h.jpg",
		AuthorName:  "Alice",
		PublishedAt: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC),
	})

	if item["content_html"] != "<p>body</p>" {
		t.Errorf("content_html missing or wrong: %v", item["content_html"])
	}
	if item["image"] != "https://cdn.example.com/h.jpg" || item["banner_image"] != item["image"] {
		t.Errorf("image fields missing or divergent: image=%v banner=%v", item["image"], item["banner_image"])
	}
	authors, ok := item["authors"].([]map[string]any)
	if !ok || len(authors) != 1 || authors[0]["name"] != "Alice" {
		t.Errorf("authors[].name missing or wrong: %v", item["authors"])
	}
	author, ok := item["author"].(map[string]any)
	if !ok || author["name"] != "Alice" {
		t.Errorf("legacy author.name missing or wrong: %v", item["author"])
	}
}

func TestJSONFeedOmitsOptionalAndUnsafeFields(t *testing.T) {
	item := buildJSONFeedItem("https://archive.moosewave.com/archive/acme/", archive.FeedIssue{
		Slug:        "minimal",
		Subject:     "Bare",
		HTMLBody:    `<script>alert(1)</script>`,
		HeroImage:   "file:///etc/passwd",
		PublishedAt: time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC),
	})
	for _, key := range []string{"content_html", "author", "authors", "image", "banner_image"} {
		if _, present := item[key]; present {
			t.Errorf("JSON feed should omit unsafe/empty %q; got: %v", key, item[key])
		}
	}
}

func TestETagChangesForEveryVisibleRichFeedField(t *testing.T) {
	base := archive.FeedIssue{
		Slug:        "issue",
		Subject:     "Subject",
		Excerpt:     "Excerpt",
		HTMLBody:    "<p>Body</p>",
		HeroImage:   "https://cdn.example.com/hero.png",
		PublishedAt: time.Unix(1, 0).UTC(),
		AuthorName:  "Alice",
		Tags:        []string{"news"},
	}
	wantDifferent := []archive.FeedIssue{
		func() archive.FeedIssue { v := base; v.Subject = "Changed"; return v }(),
		func() archive.FeedIssue { v := base; v.Excerpt = "Changed"; return v }(),
		func() archive.FeedIssue { v := base; v.HTMLBody = "<p>Changed</p>"; return v }(),
		func() archive.FeedIssue { v := base; v.HeroImage = "https://cdn.example.com/other.png"; return v }(),
		func() archive.FeedIssue { v := base; v.AuthorName = "Bob"; return v }(),
		func() archive.FeedIssue { v := base; v.Tags = []string{"product"}; return v }(),
	}
	baseETag := etagFor([]archive.FeedIssue{base})
	for _, changed := range wantDifferent {
		if got := etagFor([]archive.FeedIssue{changed}); got == baseETag {
			t.Errorf("visible field change retained stale ETag %s: %+v", got, changed)
		}
	}
}

func assertWellFormedXML(t *testing.T, document string) {
	t.Helper()
	decoder := xml.NewDecoder(strings.NewReader(document))
	for {
		if _, err := decoder.Token(); err != nil {
			if err == io.EOF {
				return
			}
			t.Fatalf("RSS is not well-formed XML: %v\n--- payload ---\n%s", err, document)
		}
	}
}

func mustContain(t *testing.T, haystack, needle, label string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("%s: expected %q\n--- got ---\n%s", label, needle, haystack)
	}
}
