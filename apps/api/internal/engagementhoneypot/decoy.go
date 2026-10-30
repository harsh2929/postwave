// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"fmt"
	"html/template"
	"net/url"
	"strings"
)

// DecoyPath is where a fetched decoy lands. It is deliberately NOT the tracked
// click path: a honeypot fetch must never become a `clicked` engagement event.
// If it did, the decoy would inflate the click-through rate we report to the
// operator and feed a machine action into lead scoring and send-time
// optimisation — a measurement instrument corrupting the thing it measures.
const DecoyPath = "/api/public/engagement/hp"

// Decoy is one embeddable honeypot.
//
// HTMLMarkup is typed as template.HTML and named for its medium because the
// decoy must never reach the text/plain alternative. In plain text there is no
// way to hide anything: the URL would sit in the body where a human can read
// it and click it, and the first curious recipient would be certified as a
// machine.
type Decoy struct {
	Technique  Technique
	Token      string
	URL        string
	HTMLMarkup template.HTML
}

// Build returns one decoy per certifying technique for a single recipient of a
// single campaign.
//
// baseURL is the public origin plus any path prefix the ingress adds; the
// decoy path is appended to it.
func Build(minter *Minter, claim Claim, baseURL string) ([]Decoy, error) {
	if minter == nil {
		return nil, fmt.Errorf("%w: honeypot minter is required", ErrInvalidInput)
	}
	base, err := validatedBase(baseURL)
	if err != nil {
		return nil, err
	}

	techniques := CertifyingTechniques()
	decoys := make([]Decoy, 0, len(techniques))
	for _, technique := range techniques {
		scoped := claim
		scoped.Technique = technique
		token, err := minter.Mint(scoped)
		if err != nil {
			return nil, err
		}
		// The token is base64url plus one dot, so it is already free of
		// characters with meaning in HTML or in a URL query. Escaping it anyway
		// keeps that a property of this function rather than of the encoder
		// three files away.
		decoyURL := base + DecoyPath + "/" + url.PathEscape(token)
		decoys = append(decoys, Decoy{
			Technique:  technique,
			Token:      token,
			URL:        decoyURL,
			HTMLMarkup: renderMarkup(technique, decoyURL),
		})
	}
	return decoys, nil
}

func validatedBase(baseURL string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return "", fmt.Errorf("%w: honeypot base url is required", ErrInvalidInput)
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("%w: honeypot base url is not a url: %v", ErrInvalidInput, err)
	}
	if parsed.Scheme != "https" {
		// The fetch we are measuring is the one hop we do not control. Over
		// plaintext the recipient HMAC is readable by everything in between.
		return "", fmt.Errorf("%w: honeypot base url must be https", ErrInvalidInput)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("%w: honeypot base url must have a host", ErrInvalidInput)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return "", fmt.Errorf("%w: honeypot base url must be an origin and path only", ErrInvalidInput)
	}
	// Reject anything that could close an attribute or open an element. The
	// base comes from configuration rather than from a recipient, but a decoy
	// is embedded verbatim into every message of a send, so a bad value would
	// be an injection into millions of mailboxes at once.
	if strings.ContainsAny(trimmed, "<>\"'`\\ \t\r\n") {
		return "", fmt.Errorf("%w: honeypot base url contains markup or whitespace", ErrInvalidInput)
	}
	// Rebuild from the parsed parts rather than echoing the input, so anything
	// the parser normalised away cannot survive into the document.
	return parsed.Scheme + "://" + parsed.Host + strings.TrimRight(parsed.EscapedPath(), "/"), nil
}

func renderMarkup(technique Technique, decoyURL string) template.HTML {
	switch technique {
	case TechniqueHTMLComment:
		// No element, no attributes, nothing for CSS to fail to hide. The
		// double-hyphen guard is theoretical given the URL alphabet, but an
		// unterminated comment would swallow the rest of the message body.
		safe := strings.ReplaceAll(decoyURL, "--", "-")
		return template.HTML("<!-- " + template.HTMLEscapeString(safe) + " -->")
	case TechniqueDisplayNone:
		// Inline style rather than a class: <style> blocks are stripped by a
		// number of clients, and a decoy whose hiding lives in a stripped block
		// is a visible link. The anchor is deliberately empty so that even a
		// client which discards the style attribute generates no clickable box.
		return template.HTML(`<a href="` + template.HTMLEscapeString(decoyURL) +
			`" style="display:none" aria-hidden="true" tabindex="-1"></a>`)
	default:
		// Unreachable via Build, which only walks CertifyingTechniques.
		// Returning empty rather than panicking keeps a future technique from
		// taking down a send.
		return ""
	}
}
