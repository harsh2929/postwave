// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"html"
	"strconv"
	"strings"
)

func renderHTML(_ string, direction Direction, locale string, nodes []resolvedNode, jsonLD []byte, decoys []string) string {
	var out strings.Builder
	out.WriteString("<!doctype html>\n<html lang=\"")
	out.WriteString(html.EscapeString(locale))
	out.WriteString("\" dir=\"")
	out.WriteString(html.EscapeString(string(direction)))
	out.WriteString("\">\n<head>\n<meta charset=\"utf-8\">\n")
	if len(jsonLD) != 0 {
		out.WriteString("<script type=\"application/ld+json\">")
		out.Write(jsonLD)
		out.WriteString("</script>\n")
	}
	out.WriteString("</head>\n<body>\n<main>\n")
	for _, resolved := range nodes {
		renderHTMLNode(&out, resolved)
	}
	out.WriteString("</main>\n")
	// Outside <main> on purpose: a decoy is not content, and inside it would
	// join the document outline and the reading order of anything walking the
	// content tree. Written verbatim — the markup is produced by
	// engagementhoneypot, which is the single place that decides how a decoy is
	// hidden and whether that hiding can certify a machine label.
	for _, decoy := range decoys {
		if strings.TrimSpace(decoy) == "" {
			continue
		}
		out.WriteString(decoy)
		out.WriteString("\n")
	}
	out.WriteString("</body>\n</html>\n")
	return out.String()
}

func renderHTMLNode(out *strings.Builder, resolved resolvedNode) {
	node, content := resolved.node, resolved.content
	if node.Type == NodeStructuredData {
		return
	}
	attributes := ` data-postwave-node="` + html.EscapeString(string(node.ID)) + `" data-postwave-role="` + html.EscapeString(string(node.Role)) + `"`
	switch node.Type {
	case NodeHeading:
		tag := "h" + strconv.Itoa(content.Heading.Level)
		out.WriteByte('<')
		out.WriteString(tag)
		out.WriteString(attributes)
		out.WriteByte('>')
		renderHTMLRichText(out, content.Heading.Text)
		out.WriteString("</")
		out.WriteString(tag)
		out.WriteString(">\n")
	case NodeParagraph:
		out.WriteString("<p")
		out.WriteString(attributes)
		out.WriteByte('>')
		renderHTMLRichText(out, content.Paragraph.Text)
		out.WriteString("</p>\n")
	case NodeList:
		tag := "ul"
		if content.List.Ordered {
			tag = "ol"
		}
		out.WriteByte('<')
		out.WriteString(tag)
		out.WriteString(attributes)
		out.WriteString(">\n")
		for _, item := range content.List.Items {
			out.WriteString("<li>")
			renderHTMLRichText(out, item)
			out.WriteString("</li>\n")
		}
		out.WriteString("</")
		out.WriteString(tag)
		out.WriteString(">\n")
	case NodeAnswer:
		out.WriteString("<section")
		out.WriteString(attributes)
		out.WriteString("><h2>")
		renderHTMLRichText(out, content.Answer.Question)
		out.WriteString("</h2><p>")
		renderHTMLRichText(out, content.Answer.Answer)
		out.WriteString("</p></section>\n")
	case NodeLegal:
		out.WriteString("<footer")
		out.WriteString(attributes)
		out.WriteString("><p>")
		renderHTMLRichText(out, content.Legal.Text)
		out.WriteString("</p></footer>\n")
	case NodeAction:
		action := content.Action
		out.WriteString("<p")
		out.WriteString(attributes)
		out.WriteString("><a data-postwave-action-id=\"")
		out.WriteString(html.EscapeString(string(action.ActionID)))
		out.WriteString("\" href=\"")
		out.WriteString(html.EscapeString(action.CanonicalURL))
		out.WriteByte('"')
		if action.AccessibleDescription != "" {
			out.WriteString(" aria-label=\"")
			out.WriteString(html.EscapeString(action.AccessibleDescription))
			out.WriteByte('"')
		}
		out.WriteByte('>')
		out.WriteString(html.EscapeString(action.Label))
		out.WriteString("</a></p>\n")
	case NodeImage:
		image := content.Image
		out.WriteString("<figure")
		out.WriteString(attributes)
		out.WriteString("><img src=\"")
		out.WriteString(html.EscapeString(image.URL))
		out.WriteString("\" alt=\"")
		out.WriteString(html.EscapeString(image.Alt))
		out.WriteByte('"')
		if node.Role == RoleDecorativeImage {
			out.WriteString(" role=\"presentation\"")
		}
		if image.Width > 0 {
			out.WriteString(" width=\"")
			out.WriteString(strconv.Itoa(image.Width))
			out.WriteString("\" height=\"")
			out.WriteString(strconv.Itoa(image.Height))
			out.WriteByte('"')
		}
		out.WriteString("></figure>\n")
	case NodeDateTime:
		renderHTMLTime(out, attributes, content.DateTime)
	case NodeDeadline:
		renderHTMLTime(out, attributes, content.Deadline)
	case NodeMoney:
		money := content.Money
		out.WriteString("<p")
		out.WriteString(attributes)
		out.WriteString("><data value=\"")
		out.WriteString(html.EscapeString(money.Amount))
		out.WriteString("\" data-currency=\"")
		out.WriteString(html.EscapeString(money.Currency))
		out.WriteString("\">")
		out.WriteString(html.EscapeString(money.DisplayValue))
		out.WriteString("</data></p>\n")
	case NodeOffer:
		offer := content.Offer
		out.WriteString("<section")
		out.WriteString(attributes)
		if offer.CanonicalOfferID != "" {
			// The bridge is projected as a NAME, not as resolved values. An agent
			// reading the message can look the entity up and get the current
			// price, window and stock; printing them here would freeze one answer
			// into a document that is shared by every recipient and re-read long
			// after it was compiled.
			out.WriteString(` data-postwave-offer="`)
			out.WriteString(html.EscapeString(offer.CanonicalOfferID))
			out.WriteByte('"')
		}
		out.WriteString("><p>")
		renderHTMLRichText(out, offer.Description)
		out.WriteString("</p>")
		if offer.Code != "" {
			out.WriteString("<p>Code: <code>")
			out.WriteString(html.EscapeString(offer.Code))
			out.WriteString("</code></p>")
		}
		if len(offer.Terms.Runs) != 0 {
			out.WriteString("<p>Terms: ")
			renderHTMLRichText(out, offer.Terms)
			out.WriteString("</p>")
		}
		if offer.AvailabilityStarts != nil {
			out.WriteString("<p>Starts: ")
			renderInlineTime(out, offer.AvailabilityStarts)
			out.WriteString("</p>")
		}
		if offer.AvailabilityEnds != nil {
			out.WriteString("<p>Ends: ")
			renderInlineTime(out, offer.AvailabilityEnds)
			out.WriteString("</p>")
		}
		out.WriteString("</section>\n")
	case NodeLocation:
		location := content.Location
		out.WriteString("<address")
		out.WriteString(attributes)
		out.WriteString("><strong>")
		out.WriteString(html.EscapeString(location.Name))
		out.WriteString("</strong><br>")
		out.WriteString(html.EscapeString(formatAddress(location.Address)))
		out.WriteString("</address>\n")
	case NodeProduct:
		product := content.Product
		out.WriteString("<article")
		out.WriteString(attributes)
		out.WriteByte('>')
		if product.ImageURL != "" {
			out.WriteString("<img src=\"")
			out.WriteString(html.EscapeString(product.ImageURL))
			out.WriteString("\" alt=\"")
			out.WriteString(html.EscapeString("Product image: " + product.Name))
			out.WriteString("\">")
		}
		out.WriteString("<p><strong>")
		if product.CanonicalURL != "" {
			out.WriteString("<a href=\"")
			out.WriteString(html.EscapeString(product.CanonicalURL))
			out.WriteString("\">")
		}
		out.WriteString(html.EscapeString(product.Name))
		if product.CanonicalURL != "" {
			out.WriteString("</a>")
		}
		out.WriteString("</strong>")
		if product.SKU != "" {
			out.WriteString(" <span>SKU: ")
			out.WriteString(html.EscapeString(product.SKU))
			out.WriteString("</span>")
		}
		out.WriteString("</p></article>\n")
	case NodeFact:
		out.WriteString("<p")
		out.WriteString(attributes)
		out.WriteString("><strong>")
		out.WriteString(html.EscapeString(content.Fact.Label))
		out.WriteString(":</strong> ")
		out.WriteString(html.EscapeString(content.Fact.Value))
		out.WriteString("</p>\n")
	case NodePersonalization:
		out.WriteString("<p")
		out.WriteString(attributes)
		out.WriteByte('>')
		if content.Personalization.Label != "" {
			out.WriteString("<strong>")
			out.WriteString(html.EscapeString(content.Personalization.Label))
			out.WriteString(":</strong> ")
		}
		out.WriteString(html.EscapeString(content.Personalization.Slot.Fallback))
		out.WriteString("</p>\n")
	case NodeDivider:
		// role="presentation" so a screen reader skips it, matching what the
		// plain-text and JSON-LD projections do by omitting it entirely.
		out.WriteString("<hr")
		out.WriteString(attributes)
		out.WriteString(" role=\"presentation\">\n")
	case NodePoll:
		out.WriteString("<section")
		out.WriteString(attributes)
		out.WriteString("><p>")
		renderHTMLRichText(out, content.Poll.Question)
		out.WriteString("</p>\n<ul>\n")
		for _, option := range content.Poll.Options {
			out.WriteString("<li>")
			if link := resolved.pollLinks[option.OptionID]; link != "" {
				out.WriteString("<a href=\"")
				out.WriteString(html.EscapeString(link))
				out.WriteString("\" data-postwave-poll-option=\"")
				out.WriteString(html.EscapeString(option.OptionID))
				out.WriteString("\">")
				renderHTMLRichText(out, option.Label)
				out.WriteString("</a>")
			} else {
				renderHTMLRichText(out, option.Label)
			}
			out.WriteString("</li>\n")
		}
		out.WriteString("</ul>\n</section>\n")
	}
}

func renderHTMLRichText(out *strings.Builder, rich RichText) {
	for _, run := range rich.Runs {
		switch run.Kind {
		case InlineText:
			out.WriteString(html.EscapeString(run.Text))
		case InlineStrong:
			out.WriteString("<strong>")
			out.WriteString(html.EscapeString(run.Text))
			out.WriteString("</strong>")
		case InlineEmphasis:
			out.WriteString("<em>")
			out.WriteString(html.EscapeString(run.Text))
			out.WriteString("</em>")
		case InlineLink:
			out.WriteString("<a href=\"")
			out.WriteString(html.EscapeString(run.URL))
			out.WriteByte('"')
			if run.AccessibleLabel != "" {
				out.WriteString(" aria-label=\"")
				out.WriteString(html.EscapeString(run.AccessibleLabel))
				out.WriteByte('"')
			}
			out.WriteByte('>')
			out.WriteString(html.EscapeString(run.Text))
			out.WriteString("</a>")
		case InlineLineBreak:
			out.WriteString("<br>")
		}
	}
}

func renderHTMLTime(out *strings.Builder, attributes string, value *DateTimeContent) {
	out.WriteString("<p")
	out.WriteString(attributes)
	out.WriteString("><time datetime=\"")
	out.WriteString(html.EscapeString(value.RFC3339))
	out.WriteString("\" data-timezone=\"")
	out.WriteString(html.EscapeString(value.Timezone))
	out.WriteString("\">")
	out.WriteString(html.EscapeString(value.DisplayValue))
	out.WriteString("</time></p>\n")
}

func renderInlineTime(out *strings.Builder, value *DateTimeContent) {
	out.WriteString("<time datetime=\"")
	out.WriteString(html.EscapeString(value.RFC3339))
	out.WriteString("\" data-timezone=\"")
	out.WriteString(html.EscapeString(value.Timezone))
	out.WriteString("\">")
	out.WriteString(html.EscapeString(value.DisplayValue))
	out.WriteString("</time>")
}

// primaryActionMarker prefixes the one action the message is asking for.
//
// A stable literal rather than punctuation art: it has to survive a plain-text
// diff, be greppable in a support ticket, and mean the same thing to a parser
// and a person.
const primaryActionMarker = "==>"

func renderText(nodes []resolvedNode) string {
	blocks := make([]string, 0, len(nodes))
	for _, resolved := range nodes {
		if block := renderTextNode(resolved); strings.TrimSpace(block) != "" {
			blocks = append(blocks, strings.TrimSpace(block))
		}
	}
	return strings.Join(blocks, "\n\n") + "\n"
}

func renderTextNode(resolved resolvedNode) string {
	node, content := resolved.node, resolved.content
	switch node.Type {
	case NodeHeading:
		return renderTextRichText(content.Heading.Text)
	case NodeParagraph:
		return renderTextRichText(content.Paragraph.Text)
	case NodeList:
		lines := make([]string, 0, len(content.List.Items))
		for i, item := range content.List.Items {
			prefix := "- "
			if content.List.Ordered {
				prefix = strconv.Itoa(i+1) + ". "
			}
			lines = append(lines, prefix+renderTextRichText(item))
		}
		return strings.Join(lines, "\n")
	case NodeAnswer:
		return renderTextRichText(content.Answer.Question) + "\n" + renderTextRichText(content.Answer.Answer)
	case NodeLegal:
		return renderTextRichText(content.Legal.Text)
	case NodeAction:
		// The primary call to action gets a marker and a line of its own.
		//
		// Every action previously rendered as "Label: URL", so the one thing the
		// message is asking for was typographically identical to the unsubscribe
		// link — in the representation that AI summarisers prefer. The node model
		// carries the role; the projection was throwing it away.
		if node.Role == RolePrimaryAction {
			return primaryActionMarker + " " + content.Action.Label + ": " + content.Action.CanonicalURL
		}
		return content.Action.Label + ": " + content.Action.CanonicalURL
	case NodeDivider:
		// A divider is decoration. The plain-text part is what parsers and
		// summarisers read, and a row of dashes there is noise that competes
		// with the content for a summariser's attention budget.
		return ""
	case NodePoll:
		lines := []string{renderTextRichText(content.Poll.Question)}
		for _, option := range content.Poll.Options {
			line := "- " + renderTextRichText(option.Label)
			if link := resolved.pollLinks[option.OptionID]; link != "" {
				line += ": " + link
			}
			lines = append(lines, line)
		}
		return strings.Join(lines, "\n")
	case NodeImage:
		if node.Role == RoleDecorativeImage {
			return ""
		}
		// Alt text alone. A synthetic "Image: " prefix is the same mistake as
		// "[image]" that the PRD names: it spends the reader's attention telling
		// them a rendering detail instead of the content, and an extractor reads
		// it as part of the alt text.
		return content.Image.Alt
	case NodeDateTime:
		return content.DateTime.DisplayValue
	case NodeDeadline:
		return content.Deadline.DisplayValue
	case NodeMoney:
		return content.Money.DisplayValue
	case NodeOffer:
		lines := []string{renderTextRichText(content.Offer.Description)}
		if content.Offer.Code != "" {
			lines = append(lines, "Code: "+content.Offer.Code)
		}
		if len(content.Offer.Terms.Runs) != 0 {
			lines = append(lines, "Terms: "+renderTextRichText(content.Offer.Terms))
		}
		if content.Offer.AvailabilityStarts != nil {
			lines = append(lines, "Starts: "+content.Offer.AvailabilityStarts.DisplayValue)
		}
		if content.Offer.AvailabilityEnds != nil {
			lines = append(lines, "Ends: "+content.Offer.AvailabilityEnds.DisplayValue)
		}
		return strings.Join(lines, "\n")
	case NodeLocation:
		return content.Location.Name + "\n" + formatAddress(content.Location.Address)
	case NodeProduct:
		// No synthetic image line. This previously emitted
		// "Image: <name>\n<name>", printing the product name twice — the reader
		// learns nothing from the first line and an extractor sees a duplicated
		// entity. The product's image means the product, which the next line
		// already says.
		line := content.Product.Name
		if content.Product.SKU != "" {
			line += " (SKU: " + content.Product.SKU + ")"
		}
		if content.Product.CanonicalURL != "" {
			line += "\n" + content.Product.CanonicalURL
		}
		return line
	case NodeFact:
		return content.Fact.Label + ": " + content.Fact.Value
	case NodePersonalization:
		if content.Personalization.Label != "" {
			return content.Personalization.Label + ": " + content.Personalization.Slot.Fallback
		}
		return content.Personalization.Slot.Fallback
	default:
		return ""
	}
}

func renderTextRichText(rich RichText) string {
	var out strings.Builder
	for _, run := range rich.Runs {
		switch run.Kind {
		case InlineText, InlineStrong, InlineEmphasis:
			out.WriteString(run.Text)
		case InlineLink:
			// "link text (https://url)" — the PRD's literal format.
			//
			// Angle brackets were close but not the same thing: several mail
			// clients auto-linkify <...> and some parsers treat it as a header
			// fold, so the URL a reader sees and the URL a parser extracts could
			// differ. Parentheses are inert in both.
			out.WriteString(run.Text)
			if run.URL != run.Text {
				out.WriteString(" (")
				out.WriteString(run.URL)
				out.WriteByte(')')
			}
		case InlineLineBreak:
			out.WriteByte('\n')
		}
	}
	return out.String()
}

func formatAddress(address PostalAddress) string {
	return joinNonEmpty(
		address.StreetAddress,
		address.AddressLocality,
		address.AddressRegion,
		address.PostalCode,
		address.AddressCountry,
	)
}
