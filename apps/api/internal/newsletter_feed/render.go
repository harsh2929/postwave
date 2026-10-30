// SPDX-License-Identifier: AGPL-3.0-only
package newsletter_feed

import (
	"encoding/binary"
	"encoding/xml"
	"hash"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"

	"github.com/postwave/postwave/apps/api/internal/archive"
)

const (
	atomNamespace    = "http://www.w3.org/2005/Atom"
	dcNamespace      = "http://purl.org/dc/elements/1.1/"
	contentNamespace = "http://purl.org/rss/1.0/modules/content/"
	itunesNamespace  = "http://www.itunes.com/dtds/podcast-1.0.dtd"
	mediaNamespace   = "http://search.yahoo.com/mrss/"
)

// feedHTMLPolicy is intentionally stricter than the email renderer. Feed
// clients interpret content:encoded outside Moosewave's CSP, so active content,
// forms, event handlers, data URLs, styles, and unparseable/relative URLs must
// be removed before the body leaves our trust boundary. UGCPolicy retains the
// useful article, table, link, and image markup while applying a parser-backed
// allowlist. It is immutable after package initialization and safe to reuse.
var feedHTMLPolicy = func() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	publicHTTPURL := func(u *url.URL) bool {
		return u != nil && archive.IsPublicImageURL(u.String())
	}
	// UGCPolicy allows arbitrary absolute http(s) URLs by default. Replace
	// those permissive entries with the same credential/control/private-host
	// checks applied to top-level feed images so unsafe URLs cannot hide inside
	// content_html or content:encoded attributes.
	p.AllowURLSchemeWithCustomPolicy("http", publicHTTPURL)
	p.AllowURLSchemeWithCustomPolicy("https", publicHTTPURL)
	p.AllowURLSchemes("tel")
	p.AllowRelativeURLs(false)
	p.RequireNoFollowOnFullyQualifiedLinks(true)
	p.RequireNoReferrerOnFullyQualifiedLinks(true)
	return p
}()

type rssRenderOptions struct {
	Title       string
	Description string
	HomeURL     string
	FeedURL     string
	ItemBaseURL string
}

func buildRSS(opts rssRenderOptions, items []archive.FeedIssue) rssFeed {
	rss := rssFeed{
		Version:  "2.0",
		NSAtom:   atomNamespace,
		NSDC:     dcNamespace,
		NSCont:   contentNamespace,
		NSITunes: itunesNamespace,
		NSMedia:  mediaNamespace,
		Channel: rssChannel{
			Title:       xmlSafeString(opts.Title),
			Link:        opts.HomeURL,
			Description: xmlSafeString(opts.Description),
			Lang:        "en",
			Generator:   "Moosewave",
			AtomLink: &atomLink{
				Href: opts.FeedURL,
				Rel:  "self",
				Type: "application/rss+xml",
			},
		},
	}

	for _, item := range items {
		permalink := opts.ItemBaseURL + url.PathEscape(item.Slug)
		ri := rssItem{
			Title:       xmlSafeString(item.Subject),
			Link:        permalink,
			GUID:        &rssGUID{Value: permalink, IsPermaLink: "true"},
			Description: xmlSafeString(item.Excerpt),
			PubDate:     item.PublishedAt.UTC().Format(time.RFC1123Z),
		}
		if author := strings.TrimSpace(item.AuthorName); author != "" {
			ri.Creator = xmlSafeString(author)
		}
		if body := sanitizeFeedHTML(item.HTMLBody); body != "" {
			ri.ContentEncoded = newCDATA(body)
		}
		if hero := safeFeedImageURL(item.HeroImage); hero != "" {
			imageType := mimeFromURL(hero)
			ri.Enclosure = &rssEnclosure{URL: hero, Type: imageType, Length: "0"}
			ri.ITunesImage = &itunesImage{Href: hero}
			ri.MediaContent = &mediaContent{URL: hero, Medium: "image", Type: imageType}
		}
		rss.Channel.Items = append(rss.Channel.Items, ri)
	}

	return rss
}

func buildJSONFeedItem(itemBaseURL string, item archive.FeedIssue) map[string]any {
	permalink := itemBaseURL + url.PathEscape(item.Slug)
	out := map[string]any{
		"id":             permalink,
		"url":            permalink,
		"title":          item.Subject,
		"summary":        item.Excerpt,
		"date_published": item.PublishedAt.UTC().Format(time.RFC3339),
	}
	if body := sanitizeFeedHTML(item.HTMLBody); body != "" {
		out["content_html"] = body
	}
	if author := strings.TrimSpace(item.AuthorName); author != "" {
		authorValue := map[string]any{"name": author}
		// JSON Feed 1.1 uses authors[]. The singular author member keeps older
		// 1.0 readers interoperable without weakening the 1.1 representation.
		out["author"] = authorValue
		out["authors"] = []map[string]any{authorValue}
	}
	if hero := safeFeedImageURL(item.HeroImage); hero != "" {
		out["image"] = hero
		out["banner_image"] = hero
	}
	if len(item.Tags) > 0 {
		out["tags"] = item.Tags
	}
	return out
}

func archiveItemBaseURL(baseURL, tenantSlug string) string {
	return strings.TrimRight(baseURL, "/") + "/archive/" + url.PathEscape(tenantSlug) + "/"
}

type feedPublicURLs struct {
	HomeURL     string
	FeedURL     string
	ItemBaseURL string
}

// resolveFeedPublicURLs keeps the configured hosted-archive origin canonical
// for ordinary API requests. When (and only when) CustomDomainMiddleware has
// supplied a database-verified vanity host, the links use that HTTPS origin
// and its friendly, pre-rewrite paths. The archive root is the home URL for
// scoped feeds too: tag/author HTML landing pages do not exist today.
func resolveFeedPublicURLs(configuredBaseURL, tenantSlug, subPath, feedFile, requestEscapedPath, verifiedCustomHost string) feedPublicURLs {
	baseURL := strings.TrimRight(configuredBaseURL, "/")
	if verifiedCustomHost != "" && archive.ValidateArchiveDomain(verifiedCustomHost) == nil {
		origin := "https://" + strings.ToLower(verifiedCustomHost)
		feedPath := escapedFeedScopePath(subPath) + "/" + feedFile
		if subPath == "" {
			feedPath = "/" + feedFile
		}
		return feedPublicURLs{
			HomeURL:     origin,
			FeedURL:     origin + feedPath,
			ItemBaseURL: origin + "/",
		}
	}
	return feedPublicURLs{
		HomeURL:     baseURL + "/archive/" + url.PathEscape(tenantSlug),
		FeedURL:     baseURL + requestEscapedPath,
		ItemBaseURL: archiveItemBaseURL(baseURL, tenantSlug),
	}
}

func escapedFeedScopePath(subPath string) string {
	if subPath == "" {
		return ""
	}
	parts := strings.Split(subPath, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return "/" + strings.Join(parts, "/")
}

func sanitizeFeedHTML(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return ""
	}
	return xmlSafeString(feedHTMLPolicy.Sanitize(body))
}

// safeFeedImageURL revalidates persisted archive data at the public render
// boundary. That protects readers from legacy rows written before publish-time
// URL validation existed. The XML encoder still escapes the accepted URL as an
// attribute, so quotes and ampersands cannot break out of the element.
func safeFeedImageURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || !archive.IsPublicImageURL(raw) {
		return ""
	}
	return raw
}

func mimeFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "application/octet-stream"
	}
	switch strings.ToLower(path.Ext(u.Path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".svg":
		return "image/svg+xml"
	case ".bmp":
		return "image/bmp"
	case ".tif", ".tiff":
		return "image/tiff"
	default:
		return "application/octet-stream"
	}
}

type rssFeed struct {
	XMLName  xml.Name   `xml:"rss"`
	Version  string     `xml:"version,attr"`
	NSAtom   string     `xml:"xmlns:atom,attr"`
	NSDC     string     `xml:"xmlns:dc,attr"`
	NSCont   string     `xml:"xmlns:content,attr"`
	NSITunes string     `xml:"xmlns:itunes,attr"`
	NSMedia  string     `xml:"xmlns:media,attr"`
	Channel  rssChannel `xml:"channel"`
}

type rssChannel struct {
	Title       string    `xml:"title"`
	Link        string    `xml:"link"`
	Description string    `xml:"description"`
	Lang        string    `xml:"language"`
	Generator   string    `xml:"generator,omitempty"`
	AtomLink    *atomLink `xml:"atom:link,omitempty"`
	Items       []rssItem `xml:"item"`
}

type atomLink struct {
	XMLName xml.Name `xml:"atom:link"`
	Href    string   `xml:"href,attr"`
	Rel     string   `xml:"rel,attr"`
	Type    string   `xml:"type,attr"`
}

type rssItem struct {
	Title          string        `xml:"title"`
	Link           string        `xml:"link"`
	GUID           *rssGUID      `xml:"guid"`
	Description    string        `xml:"description"`
	PubDate        string        `xml:"pubDate"`
	Creator        string        `xml:"dc:creator,omitempty"`
	ContentEncoded *cdataContent `xml:"content:encoded,omitempty"`
	Enclosure      *rssEnclosure `xml:"enclosure,omitempty"`
	ITunesImage    *itunesImage  `xml:"itunes:image,omitempty"`
	MediaContent   *mediaContent `xml:"media:content,omitempty"`
}

type rssGUID struct {
	Value       string `xml:",chardata"`
	IsPermaLink string `xml:"isPermaLink,attr,omitempty"`
}

type cdataContent struct {
	XMLName xml.Name `xml:"content:encoded"`
	Raw     string   `xml:",innerxml"`
}

func newCDATA(body string) *cdataContent {
	body = xmlSafeString(body)
	body = strings.ReplaceAll(body, "]]>", "]]]]><![CDATA[>")
	return &cdataContent{Raw: "<![CDATA[" + body + "]]>"}
}

// XML 1.0 rejects most C0 controls. innerxml deliberately bypasses
// encoding/xml's escaping so CDATA can contain HTML; filter invalid runes here
// rather than risking a malformed feed document from legacy campaign data.
func xmlSafeString(value string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\t', r == '\n', r == '\r':
			return r
		case r >= 0x20 && r <= 0xD7FF:
			return r
		case r >= 0xE000 && r <= 0xFFFD:
			return r
		case r >= 0x10000 && r <= 0x10FFFF:
			return r
		default:
			return -1
		}
	}, value)
}

type rssEnclosure struct {
	URL    string `xml:"url,attr"`
	Type   string `xml:"type,attr"`
	Length string `xml:"length,attr"`
}

type itunesImage struct {
	XMLName xml.Name `xml:"itunes:image"`
	Href    string   `xml:"href,attr"`
}

type mediaContent struct {
	XMLName xml.Name `xml:"media:content"`
	URL     string   `xml:"url,attr"`
	Medium  string   `xml:"medium,attr"`
	Type    string   `xml:"type,attr"`
}

// writeFeedHashField length-prefixes each field so distinct visible feed
// states cannot collide through delimiter ambiguity (for example, ["ab",
// "c"] versus ["a", "bc"]).
func writeFeedHashField(h hash.Hash, value string) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = h.Write(size[:])
	_, _ = h.Write([]byte(value))
}

func writeFeedHashCount(h hash.Hash, count int) {
	var value [8]byte
	binary.BigEndian.PutUint64(value[:], uint64(count))
	_, _ = h.Write(value[:])
}
