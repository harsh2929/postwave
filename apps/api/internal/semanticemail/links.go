// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

// LinkURLs returns every link destination a recipient could be sent to by any
// scenario of these nodes: each href the HTML renderer emits, for the base
// content and every localization, whatever the conditions resolve to. It is
// what a pre-send link check has to reach, because a condition or a locale
// that hides a link from one recipient shows it to another.
//
// Poll option links are minted per recipient at send time and are never part
// of the tree, so they are not here. Image sources are not links. Order is
// first-seen, duplicates dropped. Kept beside render.go because the two must
// agree: TestLinkURLsCoverEveryRenderedHref compiles a document using every
// link-bearing field and fails when this walker misses an href the renderer
// writes.
func LinkURLs(nodes []Node) []string {
	links := linkCollector{seen: map[string]bool{}}
	for _, node := range nodes {
		links.content(node.Content)
		for _, localized := range node.Localizations {
			links.content(localized)
		}
	}
	return links.urls
}

type linkCollector struct {
	seen map[string]bool
	urls []string
}

func (l *linkCollector) add(url string) {
	if url == "" || l.seen[url] {
		return
	}
	l.seen[url] = true
	l.urls = append(l.urls, url)
}

func (l *linkCollector) content(content NodeContent) {
	switch {
	case content.Heading != nil:
		l.richText(content.Heading.Text)
	case content.Paragraph != nil:
		l.richText(content.Paragraph.Text)
	case content.List != nil:
		for _, item := range content.List.Items {
			l.richText(item)
		}
	case content.Answer != nil:
		l.richText(content.Answer.Question)
		l.richText(content.Answer.Answer)
	case content.Legal != nil:
		l.richText(content.Legal.Text)
	case content.Action != nil:
		l.add(content.Action.CanonicalURL)
	case content.Offer != nil:
		l.richText(content.Offer.Description)
		l.richText(content.Offer.Terms)
	case content.Product != nil:
		l.add(content.Product.CanonicalURL)
	case content.Poll != nil:
		l.richText(content.Poll.Question)
		for _, option := range content.Poll.Options {
			l.richText(option.Label)
		}
	}
}

func (l *linkCollector) richText(text RichText) {
	for _, run := range text.Runs {
		if run.Kind == InlineLink {
			l.add(run.URL)
		}
	}
}
