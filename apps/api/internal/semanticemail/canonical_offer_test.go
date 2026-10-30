// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

func offerBridgeDocument(canonicalID string) DocumentV2 {
	return DocumentV2{
		SchemaVersion: SchemaVersionV2,
		Language:      "en",
		Direction:     DirectionAuto,
		Nodes: []Node{
			{
				ID: "blk_intro", Type: NodeParagraph, Role: RoleBody, Version: NodeVersionV2,
				Content:    NodeContent{Paragraph: &ParagraphContent{Text: text("Spring sale is live.")}},
				Provenance: Provenance{Source: SourceUser},
			},
			{
				ID: "blk_offer", Type: NodeOffer, Role: RoleOffer, Version: NodeVersionV2,
				Content: NodeContent{Offer: &OfferContent{
					Description:      text("Save 20% on everything"),
					Code:             "SPRING20",
					Terms:            text("One use per customer"),
					AvailabilityEnds: &DateTimeContent{DisplayValue: "1 June 2026", RFC3339: "2026-06-01T00:00:00Z", Timezone: "UTC"},
					CanonicalOfferID: canonicalID,
				}},
				Provenance: Provenance{Source: SourceUser},
			},
		},
	}
}

// The in-email offer node must NAME the canonical entity, never inline a copy of
// it.
//
// This is a structural assertion because the failure it guards is structural: an
// engineer adding price_cents, valid_until or inventory_state to the node "so
// the renderer does not have to look it up" reintroduces a snapshot that is
// shared by every recipient of the message and that goes stale silently. There
// is no behaviour to observe at the moment such a field is added — only the
// shape changes — so the shape is what is pinned.
func TestTheOfferNodeCarriesNoSnapshotOfTheCanonicalEntity(t *testing.T) {
	permitted := []string{
		// The words the message uses. Authored copy, not the entity.
		"Description", "Code", "Terms",
		// The window the message PRINTS. Kept so a resolver can report that the
		// message and the entity disagree — which is only possible because the
		// entity is named separately and can be re-read.
		"AvailabilityStarts", "AvailabilityEnds",
		// The bridge itself.
		"CanonicalOfferID",
	}

	offerType := reflect.TypeOf(OfferContent{})
	var actual []string
	for index := range offerType.NumField() {
		field := offerType.Field(index)
		if field.IsExported() {
			actual = append(actual, field.Name)
		}
	}
	slices.Sort(actual)
	slices.Sort(permitted)
	if !slices.Equal(actual, permitted) {
		t.Fatalf("OfferContent fields = %v, want exactly %v.\n"+
			"A semantic tree is shared by every recipient and is re-read long after it was "+
			"compiled. A price, validity window or inventory state copied into the node is one "+
			"frozen answer handed to everybody, and it stops being true without changing. "+
			"Name the entity and resolve it; do not snapshot it.", actual, permitted)
	}
}

func TestCanonicalOfferReferencesNameTheEntityAndTheMessagesClaim(t *testing.T) {
	document, diagnostics := NormalizeAndValidateV2(offerBridgeDocument("6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f"))
	if diagnostics.HasErrors() {
		t.Fatalf("fixture is invalid: %s", diagnostics.Error())
	}

	references := CanonicalOfferReferences(document)
	if len(references) != 1 {
		t.Fatalf("references = %+v, want one", references)
	}
	reference := references[0]
	if reference.NodeID != "blk_offer" {
		t.Errorf("node id = %q", reference.NodeID)
	}
	if reference.CanonicalOfferID != "6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f" {
		t.Errorf("canonical offer id = %q", reference.CanonicalOfferID)
	}
	if reference.AuthoredCode != "SPRING20" {
		t.Errorf("authored code = %q", reference.AuthoredCode)
	}
	if reference.AuthoredAvailabilityEnds != "2026-06-01T00:00:00Z" {
		t.Errorf("authored availability ends = %q; the message's own claim has to travel with "+
			"the reference or nothing can notice the two records disagree",
			reference.AuthoredAvailabilityEnds)
	}

	// An offer block with no bridge is a real state and is reported as such
	// rather than appearing as a reference to the empty entity.
	unbridged, unbridgedDiagnostics := NormalizeAndValidateV2(offerBridgeDocument(""))
	if unbridgedDiagnostics.HasErrors() {
		t.Fatalf("unbridged fixture is invalid: %s", unbridgedDiagnostics.Error())
	}
	if got := CanonicalOfferReferences(unbridged); len(got) != 0 {
		t.Errorf("unbridged offer produced references %+v", got)
	}
	if got := UnbridgedOfferNodes(unbridged); len(got) != 1 || got[0] != "blk_offer" {
		t.Errorf("unbridged offer nodes = %v, want [blk_offer]", got)
	}
}

// A reference that cannot name a real entity is a claim nothing can check.
func TestCanonicalOfferReferenceMustBeAUUID(t *testing.T) {
	for _, value := range []string{
		"offer-1", "6B1F1F6C-4B0E-4F3A-9C2E-1A2B3C4D5E6F.", "6b1f1f6c4b0e4f3a9c2e1a2b3c4d5e6f",
		"6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6", "zzzzzzzz-4b0e-4f3a-9c2e-1a2b3c4d5e6f",
	} {
		_, diagnostics := NormalizeAndValidateV2(offerBridgeDocument(value))
		if !diagnostics.HasCode(CodeInvalidCanonicalOfferReference) {
			t.Errorf("canonical_offer_id %q accepted; diagnostics = %s", value, diagnostics.Error())
		}
	}

	// Guard the guard: an uppercase UUID is normalized rather than rejected, and
	// a well-formed reference must still pass.
	document, diagnostics := NormalizeAndValidateV2(offerBridgeDocument("6B1F1F6C-4B0E-4F3A-9C2E-1A2B3C4D5E6F"))
	if diagnostics.HasErrors() {
		t.Fatalf("an uppercase UUID was rejected instead of normalized: %s", diagnostics.Error())
	}
	if got := document.Nodes[1].Content.Offer.CanonicalOfferID; got != "6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f" {
		t.Fatalf("canonical offer id = %q, want the lowercase canonical form", got)
	}
}

// A localization may translate an offer's words. It may not re-point the bridge.
func TestALocalizationMayNotNameADifferentOfferEntity(t *testing.T) {
	base := offerBridgeDocument("6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f")
	localized := *base.Nodes[1].Content.Offer
	localized.Description = text("Économisez 20 %")
	localized.CanonicalOfferID = "11111111-2222-3333-4444-555555555555"
	base.Nodes[1].Localizations = map[string]NodeContent{"fr": {Offer: &localized}}

	_, diagnostics := NormalizeAndValidateV2(base)
	if !diagnostics.HasCode(CodeInvalidCanonicalOfferReference) {
		t.Fatalf("a localization re-pointed the bridge and nothing complained; diagnostics = %s",
			diagnostics.Error())
	}

	// Guard the guard: the same localization naming the SAME entity is valid.
	agreeing := offerBridgeDocument("6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f")
	sameEntity := *agreeing.Nodes[1].Content.Offer
	sameEntity.Description = text("Économisez 20 %")
	agreeing.Nodes[1].Localizations = map[string]NodeContent{"fr": {Offer: &sameEntity}}
	if _, diagnostics := NormalizeAndValidateV2(agreeing); diagnostics.HasErrors() {
		t.Fatalf("a translation that names the same entity was rejected: %s", diagnostics.Error())
	}
}

// The same rule, swept across every Content member that carries identity.
//
// The offer bridge is not the only identity a localization overrides: an
// action's id drives click attribution and a product's SKU names a catalogue
// entry. A locale-dependent value for either is the same defect wearing a
// different hat.
func TestALocalizationMayTranslateWordsButNotIdentity(t *testing.T) {
	provenance := Provenance{Source: SourceUser}
	base := DocumentV2{
		SchemaVersion: SchemaVersionV2, Language: "en", Direction: DirectionAuto,
		Nodes: []Node{
			{
				ID: "blk_action", Type: NodeAction, Role: RolePrimaryAction, Version: NodeVersionV2,
				Content: NodeContent{Action: &ActionContent{
					ActionID: "act_buy", Label: "Buy now", CanonicalURL: "https://example.test/buy",
				}},
				Provenance: provenance,
			},
			{
				ID: "blk_product", Type: NodeProduct, Role: RoleProduct, Version: NodeVersionV2,
				Content:    NodeContent{Product: &ProductContent{Name: "Workshop", SKU: "WAW-2026"}},
				Provenance: provenance,
			},
		},
	}

	// Translating words and even the destination is legitimate.
	translated := base
	translated.Nodes = append([]Node(nil), base.Nodes...)
	translated.Nodes[0].Localizations = map[string]NodeContent{"fr": {Action: &ActionContent{
		ActionID: "act_buy", Label: "Acheter", CanonicalURL: "https://example.test/fr/buy",
	}}}
	translated.Nodes[1].Localizations = map[string]NodeContent{"fr": {Product: &ProductContent{
		Name: "Atelier", SKU: "WAW-2026",
	}}}
	if _, diagnostics := NormalizeAndValidateV2(translated); diagnostics.HasErrors() {
		t.Fatalf("a genuine translation was rejected: %s", diagnostics.Error())
	}

	repointedAction := base
	repointedAction.Nodes = append([]Node(nil), base.Nodes...)
	repointedAction.Nodes[0].Localizations = map[string]NodeContent{"fr": {Action: &ActionContent{
		ActionID: "act_acheter", Label: "Acheter", CanonicalURL: "https://example.test/fr/buy",
	}}}
	if _, diagnostics := NormalizeAndValidateV2(repointedAction); !diagnostics.HasErrors() {
		t.Error("a localization changed the action id; click attribution is now locale-dependent")
	}

	repointedProduct := base
	repointedProduct.Nodes = append([]Node(nil), base.Nodes...)
	repointedProduct.Nodes[1].Localizations = map[string]NodeContent{"fr": {Product: &ProductContent{
		Name: "Atelier", SKU: "WAW-2026-FR",
	}}}
	if _, diagnostics := NormalizeAndValidateV2(repointedProduct); !diagnostics.HasErrors() {
		t.Error("a localization changed the SKU; it names a different product")
	}
}

// The compiled message NAMES the entity; it does not print resolved values.
func TestTheCompiledMessageProjectsTheOfferBridgeAsAName(t *testing.T) {
	document := offerBridgeDocument("6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f")
	compiled, diagnostics := CompileV2(document, CompileOptions{})
	if diagnostics.HasErrors() {
		t.Fatalf("compile failed: %s", diagnostics.Error())
	}
	if !strings.Contains(compiled.HTML, `data-postwave-offer="6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f"`) {
		t.Fatalf("the compiled message does not name the canonical entity:\n%s", compiled.HTML)
	}

	unbridged, unbridgedDiagnostics := CompileV2(offerBridgeDocument(""), CompileOptions{})
	if unbridgedDiagnostics.HasErrors() {
		t.Fatalf("compile failed: %s", unbridgedDiagnostics.Error())
	}
	if strings.Contains(unbridged.HTML, "data-postwave-offer") {
		t.Fatalf("an offer block with no bridge emitted an empty reference:\n%s", unbridged.HTML)
	}
}
