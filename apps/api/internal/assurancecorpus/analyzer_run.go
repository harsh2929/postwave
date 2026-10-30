// SPDX-License-Identifier: AGPL-3.0-only

// analyzer_run.go — runs the detectors over the corpus so a false-positive
// rate has a real numerator.
//
// The corpus stores messages; campaignchecks.Analyze checks a COMPILATION
// against its artifact receipts. Bridging the two means synthesising a
// compilation whose projections are the message's own MIME parts, which is
// faithful for everything the message actually contains.
//
// What that synthesis cannot supply is the compiler's receipts, manifest and
// source hashes — a corpus fixture was never produced by a compiler run. So
// every case also reports the artifact-level findings that say exactly that
// (ARTIFACT_RECEIPT_MISMATCH, REPRESENTATION_MANIFEST_INVALID, and so on).
// Those are CORRECT findings about a synthetic input, not false positives, and
// they are excluded from the measurement rather than suppressed: no corpus case
// forbids them, so they never enter a denominator, and contentDimensionCode
// makes the boundary explicit rather than leaving a reader to infer it.

package assurancecorpus

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"

	nethtml "golang.org/x/net/html"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
)

// contentDimensionCode reports whether a finding is decidable from the MESSAGE
// ALONE — which is all a corpus fixture is.
//
// Hidden-content and accessibility checks read the HTML directly. Structured
// data joined them once the runner began extracting the message's own ld+json
// script, which is genuinely part of the message rather than something the
// harness invents.
//
// Image-meaning and primary-action findings are still excluded: they depend on
// the sender's Fact Contract, which a raw .eml does not carry. The run confirms
// that rather than assuming it — it reports FACT_CONTRACT_UNAVAILABLE and never
// produces those codes — and measuring them here would score the detector on
// evidence the harness never gave it.
func contentDimensionCode(code string) bool {
	if requiresFactContract(code) {
		return false
	}
	switch dimensionOf(code) {
	case campaignchecks.DimensionHiddenContent,
		campaignchecks.DimensionAccessibility,
		campaignchecks.DimensionStructuredData:
		return true
	default:
		return false
	}
}

// requiresFactContract names the codes that compare a representation against
// the sender's frozen Fact Contract.
//
// Listed by name rather than filtered by dimension because the dimension is the
// wrong axis: STRUCTURED_DATA_TYPE_UNSUPPORTED and
// FACT_STRUCTURED_DATA_CONTRADICTION share a dimension, but the first is a
// judgement about the payload the message carries and the second needs a
// document the message does not contain. Widening by dimension alone pulled
// these two in and the corpus control test caught it immediately.
//
// Supplying a synthetic contract would make them fire, but it would be a
// contract this harness authored — the detector would be scored against an
// expectation invented for it, which measures nothing.
func requiresFactContract(code string) bool {
	switch code {
	case "FACT_STRUCTURED_DATA_CONTRADICTION",
		"PRIMARY_ACTION_SCHEMA_CONTRADICTION",
		"STRUCTURED_STATUS_EVIDENCE_OVERCLAIM":
		return true
	}
	return false
}

// dimensionOf reads the published catalog rather than keeping a second list of
// which codes are content checks — the same reason KnownAction reads the
// notification catalog instead of restating it.
func dimensionOf(code string) campaignchecks.Dimension {
	for _, definition := range campaignchecks.FindingDefinitions() {
		if definition.Code == code {
			return definition.Dimension
		}
	}
	return ""
}

func containsCode(codes []string, code string) bool {
	for _, candidate := range codes {
		if candidate == code {
			return true
		}
	}
	return false
}

func digestHex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

// alternativesOf extracts the text/plain and text/html parts so the synthesised
// compilation matches the message byte-for-byte. A non-multipart or
// intentionally malformed fixture yields ok=false and is skipped rather than
// analysed against projections it does not have.
func alternativesOf(raw []byte) (plain string, html string, ok bool) {
	message, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		return "", "", false
	}
	mediaType, parameters, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		return "", "", false
	}
	reader := multipart.NewReader(message.Body, parameters["boundary"])
	for {
		part, err := reader.NextPart()
		if err != nil {
			break
		}
		body, err := io.ReadAll(part)
		if err != nil {
			return "", "", false
		}
		partType, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
		switch partType {
		case "text/plain":
			plain = string(body)
		case "text/html":
			html = string(body)
		}
	}
	return plain, html, plain != "" && html != ""
}

// embeddedStructuredData returns the exact text of the message's
// application/ld+json script, or nil when it carries none.
//
// The EXACT text matters. campaignchecks compares the compiled projection
// byte-for-byte against the embedded script, so a projection this harness
// re-serialised — even to identical JSON — would fire
// STRUCTURED_DATA_EMBEDDING_MISMATCH, a parity failure the harness invented
// rather than one the message contains. Taking the script's own bytes keeps the
// synthesised compilation faithful to the fixture.
//
// Returning nil for a message with no script is equally deliberate: inventing
// an empty payload would paper over UNDECLARED_STRUCTURED_DATA, which is a real
// finding about HTML carrying JSON-LD the compiler never certified.
func embeddedStructuredData(source string) []byte {
	document, err := nethtml.Parse(strings.NewReader(source))
	if err != nil {
		return nil
	}
	var found []byte
	var walk func(*nethtml.Node)
	walk = func(node *nethtml.Node) {
		if found != nil {
			return
		}
		if node.Type == nethtml.ElementNode && strings.EqualFold(node.Data, "script") {
			for _, attribute := range node.Attr {
				if !strings.EqualFold(attribute.Key, "type") ||
					!strings.EqualFold(strings.TrimSpace(attribute.Val), "application/ld+json") {
					continue
				}
				var text strings.Builder
				for child := node.FirstChild; child != nil; child = child.NextSibling {
					if child.Type == nethtml.TextNode {
						text.WriteString(child.Data)
					}
				}
				found = []byte(text.String())
				return
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(document)
	return found
}

// RunDetectors analyses every multipart case and returns what fired, alongside
// the number of cases skipped because they carry no two-part projection.
func RunDetectors(corpus Corpus) (outcomes []CaseOutcome, skipped int) {
	for _, loaded := range corpus.Cases {
		// A case whose assertions depend on a compiler receipt cannot be judged
		// here: without the receipt the compiler's own preheader is
		// indistinguishable from unknown hidden content, and the detector is
		// RIGHT to say so. Scoring that as a false positive would blame it for
		// evidence this harness cannot produce.
		if loaded.Definition.RequiresCompilerReceipt {
			skipped++
			continue
		}
		plain, html, ok := alternativesOf(loaded.Raw)
		if !ok {
			skipped++
			continue
		}
		report := campaignchecks.Analyze(campaignchecks.Input{
			Compilation: campaigncompiler.Result{
				HTML: html, Text: plain, RFC822: loaded.Raw,
				StructuredData: embeddedStructuredData(html),
				Artifact: campaignartifact.ArtifactInput{
					OutboundMIMEHash: digestHex(loaded.Raw),
					HTMLHash:         digestHex([]byte(html)),
					TextHash:         digestHex([]byte(plain)),
				},
			},
		})
		fired := make([]string, 0, len(report.Findings))
		for _, finding := range report.Findings {
			if !containsCode(fired, finding.Code) {
				fired = append(fired, finding.Code)
			}
		}
		outcomes = append(outcomes, CaseOutcome{
			CaseID:         loaded.Definition.ID,
			ForbiddenCodes: loaded.Definition.Findings.ForbiddenCodes,
			FiredCodes:     fired,
		})
	}
	return outcomes, skipped
}
