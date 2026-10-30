// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestCompileV2GoldenAccessibleHTMLAndSemanticText(t *testing.T) {
	document := goldenProjectionDocument()
	result, diagnostics := CompileV2(document, CompileOptions{})
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("CompileV2() warnings = %v", diagnostics)
	}

	wantHTML := `<!doctype html>
<html lang="en-US" dir="ltr">
<head>
<meta charset="utf-8">
</head>
<body>
<main>
<h1 data-postwave-node="title" data-postwave-role="heading">Hello &amp; welcome</h1>
<p data-postwave-node="body" data-postwave-role="body">Meet <strong>Asha</strong><br><a href="https://example.test/agenda?x=1&amp;y=2" aria-label="Open the agenda">Agenda</a></p>
<p data-postwave-node="cta" data-postwave-role="primary_action"><a data-postwave-action-id="act_go" href="https://example.test/join" aria-label="Join the launch event">Join now</a></p>
<figure data-postwave-node="ornament" data-postwave-role="decorative_image"><img src="https://cdn.example.test/divider.png" alt="" role="presentation" width="1" height="1"></figure>
<footer data-postwave-node="legal" data-postwave-role="footer"><p>Terms apply.</p></footer>
</main>
</body>
</html>
`
	// Three F07 rules the projection now follows literally:
	//   links as "text (url)"  — angle brackets are auto-linkified by some
	//                            clients and fold-parsed by others
	//   the primary action carries a marker and stands alone, so the one thing
	//                            being asked for is not typographically
	//                            identical to the unsubscribe link
	//   informative images contribute alt text ONLY, with no synthetic prefix
	wantText := "Hello & welcome\n\nMeet Asha\nAgenda (https://example.test/agenda?x=1&y=2)\n\n==> Join now: https://example.test/join\n\nTerms apply.\n"
	if result.HTML != wantHTML {
		t.Fatalf("HTML golden mismatch:\n--- got ---\n%s--- want ---\n%s", result.HTML, wantHTML)
	}
	if result.Text != wantText {
		t.Fatalf("text golden mismatch:\n--- got ---\n%s--- want ---\n%s", result.Text, wantText)
	}
	if len(result.JSONLD) != 0 || len(result.StructuredPayloads) != 0 {
		t.Fatalf("unexpected structured data: %s", result.JSONLD)
	}
	if result.CompilerVersion != CompilerVersion || result.HTMLVersion != HTMLRendererVersion || result.TextVersion != TextRendererVersion {
		t.Fatalf("version receipt = %#v", result)
	}
	if got, want := result.Hashes.HTML, digestString(wantHTML); got != want {
		t.Fatalf("HTML hash = %q, want %q", got, want)
	}
	if got, want := result.Hashes.Text, digestString(wantText); got != want {
		t.Fatalf("text hash = %q, want %q", got, want)
	}
}

func TestCompileV2GoldenGmailJSONLDAndRepresentationParity(t *testing.T) {
	result, diagnostics := CompileV2(validDocumentV2(), validCompileOptions())
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("CompileV2() warnings = %v", diagnostics)
	}
	if got, want := len(result.StructuredPayloads), 4; got != want {
		t.Fatalf("structured payload count = %d, want %d", got, want)
	}
	wantPayloads := []string{
		`{"@context":"http://schema.org","@type":"DiscountOffer","availabilityEnds":"2026-08-13T23:59:00+05:30","availabilityStarts":"2026-08-09T09:00:00+05:30","description":"Save ₹200 on your reservation","discountCode":"LIVE200"}`,
		`{"@context":"http://schema.org","@type":"PromotionCard","discountValue":"200","headline":"Workflow Automation Live","image":"https://cdn.example.test/promo.jpg","position":"1","price":"1499","priceCurrency":"INR","url":"https://example.test/events/launch"}`,
		`{"@context":"http://schema.org","@type":"EventReservation","reservationFor":{"@type":"Event","location":{"@type":"Place","address":{"@type":"PostalAddress","addressCountry":"IN","addressLocality":"Bengaluru","addressRegion":"KA","postalCode":"560025","streetAddress":"12 Residency Road"},"name":"Moosewave Studio"},"name":"Workflow Automation Live","startDate":"2026-08-14T16:00:00+05:30"},"reservationNumber":"R-12345","reservationStatus":"http://schema.org/Confirmed","underName":{"@type":"Person","name":"Asha Rao"},"url":"https://example.test/events/launch"}`,
		`{"@context":"http://schema.org","@type":"Order","acceptedOffer":{"@type":"Offer","eligibleQuantity":{"@type":"QuantitativeValue","value":"1"},"itemOffered":{"@type":"Product","image":"https://cdn.example.test/workshop.jpg","name":"Workflow Automation Workshop","sku":"WAW-2026","url":"https://example.test/products/workshop"},"price":"1499","priceCurrency":"INR"},"merchant":{"@type":"Organization","name":"Moosewave"},"orderNumber":"O-12345","potentialAction":{"@type":"ViewAction","url":"https://example.test/events/launch"},"price":"1499","priceCurrency":"INR","url":"https://example.test/events/launch"}`,
	}
	for i, want := range wantPayloads {
		if got := string(result.StructuredPayloads[i]); got != want {
			t.Fatalf("structured payload %d golden mismatch:\n got %s\nwant %s", i, got, want)
		}
	}
	if !json.Valid(result.JSONLD) {
		t.Fatalf("combined JSON-LD is invalid: %s", result.JSONLD)
	}
	for _, value := range []string{
		"Asha Rao", "R-12345", "Workflow Automation Live", "2026-08-14T16:00:00+05:30",
		"Moosewave Studio", "LIVE200", "1499", "Workflow Automation Workshop",
	} {
		if !strings.Contains(string(result.JSONLD), value) {
			t.Errorf("JSON-LD missing visible semantic value %q: %s", value, result.JSONLD)
		}
	}
	for _, value := range []string{"Asha Rao", "R-12345", "Workflow Automation Live", "Moosewave Studio", "LIVE200", "₹1,499", "Confirmed"} {
		if !strings.Contains(result.HTML, value) || !strings.Contains(result.Text, value) {
			t.Errorf("value %q lacks HTML/text parity", value)
		}
	}
	for _, status := range result.StructuredStatuses {
		if !status.Valid || status.Eligibility != EligibilityEligible || !status.Emitted || status.ObservedDisplay != "unknown" || status.ComprehensionEffect != "unproven" {
			t.Errorf("structured status conflates evidence: %#v", status)
		}
	}
	if result.Hashes.JSONLD != digestBytes(result.JSONLD) {
		t.Fatalf("JSON-LD hash = %q, want exact payload hash", result.Hashes.JSONLD)
	}
}

func TestCompileV2IsDeterministicAcrossMapConstructionOrder(t *testing.T) {
	document := validDocumentV2()
	baseline, diagnostics := CompileV2(document, validCompileOptions())
	if diagnostics.HasErrors() {
		t.Fatal(diagnostics)
	}
	for i := 0; i < 50; i++ {
		options := validCompileOptions()
		if i%2 == 0 {
			options.Slots = map[SlotID]string{"segment": "pro", "full_name": "Asha Rao", "first_name": "Asha"}
		}
		result, gotDiagnostics := CompileV2(document, options)
		if !reflect.DeepEqual(gotDiagnostics, diagnostics) {
			t.Fatalf("diagnostics changed on run %d: %v", i, gotDiagnostics)
		}
		if !reflect.DeepEqual(result, baseline) {
			t.Fatalf("compile result changed on run %d\n got %#v\nwant %#v", i, result, baseline)
		}
	}
}

func TestCompileV2DoesNotEmitUnverifiedStructuredData(t *testing.T) {
	options := validCompileOptions()
	options.StructuredPolicy.Gmail = GmailPolicy{}
	result, diagnostics := CompileV2(validDocumentV2(), options)
	if diagnostics.HasErrors() {
		t.Fatalf("unverified eligibility should warn, not invalidate semantic projections: %v", diagnostics)
	}
	if got, want := len(diagnostics), 4; got != want {
		t.Fatalf("warning count = %d, want %d: %v", got, want, diagnostics)
	}
	if len(result.JSONLD) != 0 || strings.Contains(result.HTML, "application/ld+json") {
		t.Fatalf("unverified markup was emitted: JSON-LD=%s HTML=%s", result.JSONLD, result.HTML)
	}
	for _, status := range result.StructuredStatuses {
		if status.Eligibility != EligibilityUnverified || status.Emitted {
			t.Errorf("status = %#v, want unverified/non-emitted", status)
		}
	}
}

func TestCompileV2FailsClosedForUnresolvedConditionAndSlot(t *testing.T) {
	options := validCompileOptions()
	delete(options.Slots, "segment")
	_, diagnostics := CompileV2(validDocumentV2(), options)
	if !diagnostics.HasCode(CodeConditionUnresolved) || !diagnostics.HasErrors() {
		t.Fatalf("missing equality fixture diagnostics = %v", diagnostics)
	}

	options = validCompileOptions()
	delete(options.Slots, "full_name")
	_, diagnostics = CompileV2(validDocumentV2(), options)
	if !diagnostics.HasCode(CodeSlotUnresolved) || !diagnostics.HasErrors() {
		t.Fatalf("missing required slot diagnostics = %v", diagnostics)
	}
}

func TestCompileV2DoesNotResolveSlotsInsideExcludedBranch(t *testing.T) {
	options := validCompileOptions()
	options.Slots["segment"] = "basic"
	delete(options.Slots, "first_name")
	result, diagnostics := CompileV2(validDocumentV2(), options)
	if diagnostics.HasErrors() {
		t.Fatalf("excluded branch should not consume slot: %v", diagnostics)
	}
	if strings.Contains(result.Text, "see our new workflow") || containsNodeID(result.IncludedNodeIDs, "blk_intro") {
		t.Fatalf("excluded semantic branch appeared in result: %s", result.Text)
	}
}

func TestCompileV2EnforcesOnePrimaryActionPerResolvedBranch(t *testing.T) {
	document := DocumentV2{
		SchemaVersion: SchemaVersionV2, Language: "en-US", Direction: DirectionLTR,
		Nodes: []Node{
			{ID: "title", Type: NodeHeading, Role: RoleHeading, Version: NodeVersionV2, Content: NodeContent{Heading: &HeadingContent{Level: 1, Text: text("Choose")}}, Provenance: Provenance{Source: SourceUser}},
			{ID: "cta_a", Type: NodeAction, Role: RolePrimaryAction, Version: NodeVersionV2, Content: NodeContent{Action: &ActionContent{ActionID: "act_a", Label: "Choose A", CanonicalURL: "https://example.test/a"}}, Conditions: []Condition{{ID: "cond_a", SlotID: "branch", Operator: ConditionEquals, Value: "a"}}, Provenance: Provenance{Source: SourceUser}},
			{ID: "cta_b", Type: NodeAction, Role: RolePrimaryAction, Version: NodeVersionV2, Content: NodeContent{Action: &ActionContent{ActionID: "act_b", Label: "Choose B", CanonicalURL: "https://example.test/b"}}, Conditions: []Condition{{ID: "cond_b", SlotID: "branch", Operator: ConditionEquals, Value: "b"}}, Provenance: Provenance{Source: SourceUser}},
		},
	}
	if diagnostics := ValidateV2(document); diagnostics.HasErrors() {
		t.Fatalf("mutually exclusive primary actions should be a valid source tree: %v", diagnostics)
	}
	result, diagnostics := CompileV2(document, CompileOptions{Slots: map[SlotID]string{"branch": "b"}})
	if diagnostics.HasErrors() || strings.Contains(result.Text, "Choose A:") || !strings.Contains(result.Text, "Choose B:") {
		t.Fatalf("branch b result = %q, diagnostics = %v", result.Text, diagnostics)
	}

	document.Nodes[2].Conditions[0].Value = "a"
	_, diagnostics = CompileV2(document, CompileOptions{Slots: map[SlotID]string{"branch": "a"}})
	if !diagnostics.HasCode(CodeMultiplePrimaryActions) || !diagnostics.HasErrors() {
		t.Fatalf("overlapping primary action diagnostics = %v", diagnostics)
	}
}

func TestCompileV2LocaleRTLAndUnicode(t *testing.T) {
	document := goldenProjectionDocument()
	document.Direction = DirectionRTL
	for i := range document.Nodes {
		if document.Nodes[i].Type == NodeStructuredData {
			continue
		}
		document.Nodes[i].Localizations = map[string]NodeContent{"ar-SA": localizedArabicContent(document.Nodes[i])}
	}
	result, diagnostics := CompileV2(document, CompileOptions{Locale: "AR-sa"})
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	if !strings.Contains(result.HTML, `<html lang="ar-SA" dir="rtl">`) || !strings.Contains(result.HTML, "مرحبًا") {
		t.Fatalf("RTL localized HTML = %s", result.HTML)
	}
	if !strings.Contains(result.Text, "مرحبًا") || !strings.Contains(result.Text, "انضم الآن") {
		t.Fatalf("localized text = %s", result.Text)
	}

	_, diagnostics = CompileV2(goldenProjectionDocument(), CompileOptions{Locale: "ar-SA"})
	if !diagnostics.HasCode(CodeLocaleUnavailable) || !diagnostics.HasErrors() {
		t.Fatalf("missing localization diagnostics = %v", diagnostics)
	}
}

func TestCompileV2EscapesHTMLAndScriptInjection(t *testing.T) {
	document := validDocumentV2()
	document.Nodes[0].Content.Heading.Text = text(`</script><script>alert("x")</script> & title`)
	document.Nodes[10].Content.Offer.Description = text(`</script><img src=x onerror=alert(1)>`)
	result, diagnostics := CompileV2(document, validCompileOptions())
	if diagnostics.HasErrors() {
		t.Fatalf("safe text should compile: %v", diagnostics)
	}
	if strings.Contains(result.HTML, `</script><script>alert`) || strings.Contains(string(result.JSONLD), `</script>`) {
		t.Fatalf("untrusted text broke script/HTML context: %s", result.HTML)
	}
	if !strings.Contains(result.HTML, `&lt;/script&gt;&lt;script&gt;`) || !strings.Contains(string(result.JSONLD), `\u003c/script\u003e`) {
		t.Fatalf("expected escaped representation missing: HTML=%s JSON=%s", result.HTML, result.JSONLD)
	}
}

func TestCompileV2RevalidatesLocalizedStructuredSources(t *testing.T) {
	tests := []struct {
		name string
		edit func(*DocumentV2)
		code DiagnosticCode
	}{
		{
			name: "localized action downgrades HTTPS",
			edit: func(document *DocumentV2) {
				content := document.Nodes[4].Localizations["hi-IN"]
				content.Action.CanonicalURL = "http://example.test/events/launch"
				document.Nodes[4].Localizations["hi-IN"] = content
			},
			code: CodeHTTPSRequired,
		},
		{
			name: "localized promotion image changes aspect ratio",
			edit: func(document *DocumentV2) {
				content := document.Nodes[5].Localizations["hi-IN"]
				content.Image.Width = 1600
				content.Image.Height = 900
				document.Nodes[5].Localizations["hi-IN"] = content
			},
			code: CodeNumberOutOfRange,
		},
		{
			name: "localized order quantity is not numeric",
			edit: func(document *DocumentV2) {
				content := document.Nodes[17].Localizations["hi-IN"]
				content.Fact.Value = "one"
				document.Nodes[17].Localizations["hi-IN"] = content
			},
			code: CodeInvalidDecimal,
		},
		{
			name: "localized reservation status contradicts markup",
			edit: func(document *DocumentV2) {
				content := document.Nodes[19].Localizations["hi-IN"]
				content.Fact.Value = "Pending"
				document.Nodes[19].Localizations["hi-IN"] = content
			},
			code: CodeStructuredKindMismatch,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := validDocumentV2()
			for i := range document.Nodes {
				if document.Nodes[i].Type != NodeStructuredData {
					document.Nodes[i].Localizations = map[string]NodeContent{"hi-IN": normalizeContent(document.Nodes[i].Content)}
				}
			}
			test.edit(&document)
			options := validCompileOptions()
			options.Locale = "hi-IN"
			_, diagnostics := CompileV2(document, options)
			if !diagnostics.HasErrors() || !diagnostics.HasCode(test.code) {
				t.Fatalf("diagnostics = %v, want %q", diagnostics, test.code)
			}
		})
	}
}

func goldenProjectionDocument() DocumentV2 {
	provenance := Provenance{Source: SourceUser}
	return DocumentV2{
		SchemaVersion: SchemaVersionV2,
		Language:      "en-US",
		Direction:     DirectionLTR,
		Nodes: []Node{
			{ID: "title", Type: NodeHeading, Role: RoleHeading, Version: NodeVersionV2, Content: NodeContent{Heading: &HeadingContent{Level: 1, Text: text("Hello & welcome")}}, Provenance: provenance},
			{ID: "body", Type: NodeParagraph, Role: RoleBody, Version: NodeVersionV2, Content: NodeContent{Paragraph: &ParagraphContent{Text: RichText{Runs: []InlineRun{
				{Kind: InlineText, Text: "Meet "},
				{Kind: InlineStrong, Text: "Asha"},
				{Kind: InlineLineBreak},
				{Kind: InlineLink, Text: "Agenda", URL: "https://example.test/agenda?x=1&y=2", AccessibleLabel: "Open the agenda"},
			}}}}, Provenance: provenance},
			{ID: "cta", Type: NodeAction, Role: RolePrimaryAction, Version: NodeVersionV2, Content: NodeContent{Action: &ActionContent{ActionID: "act_go", Label: "Join now", CanonicalURL: "https://example.test/join", AccessibleDescription: "Join the launch event"}}, Provenance: provenance},
			{ID: "ornament", Type: NodeImage, Role: RoleDecorativeImage, Version: NodeVersionV2, Content: NodeContent{Image: &ImageContent{URL: "https://cdn.example.test/divider.png", Width: 1, Height: 1}}, Provenance: provenance},
			{ID: "legal", Type: NodeLegal, Role: RoleFooter, Version: NodeVersionV2, Content: NodeContent{Legal: &LegalContent{Text: text("Terms apply.")}}, Provenance: provenance},
		},
	}
}

func localizedArabicContent(node Node) NodeContent {
	switch node.Type {
	case NodeHeading:
		return NodeContent{Heading: &HeadingContent{Level: 1, Text: text("مرحبًا وأهلًا")}}
	case NodeParagraph:
		return NodeContent{Paragraph: &ParagraphContent{Text: text("مرحبًا بك في الحدث")}}
	case NodeAction:
		value := *node.Content.Action
		value.Label = "انضم الآن"
		value.AccessibleDescription = "انضم إلى الحدث"
		return NodeContent{Action: &value}
	case NodeImage:
		value := *node.Content.Image
		return NodeContent{Image: &value}
	case NodeLegal:
		return NodeContent{Legal: &LegalContent{Text: text("تطبق الشروط")}}
	default:
		return node.Content
	}
}

func containsNodeID(values []NodeID, want NodeID) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
