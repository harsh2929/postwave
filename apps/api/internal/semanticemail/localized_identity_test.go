// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"strings"
	"testing"
)

// A localization may translate WORDS. It may never change IDENTITY.
//
// The rule existed for polls, offers, actions and products and was missing for
// personalization — the member where getting it wrong costs the most. The
// compiler resolves the LOCALIZED slot, so a localization that re-points slot.id
// makes one node substitute a DIFFERENT SUBSCRIBER ATTRIBUTE per locale. The
// other four change which thing was named; this one changes which of the
// recipient's own data they are shown, with nothing in the rendered message to
// indicate it happened.
//
// Written as a table over the whole class, not as a case for the one that was
// missing, because the way this defect arose was that four members were
// enumerated by hand and the fifth was forgotten. A new content type with an
// identity field belongs in this table on the day it is added.
func TestALocalizationMayTranslateWordsButNeverIdentity(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mutate  func(node *Node)
		wantsIn string
	}{
		{
			name: "personalization slot",
			mutate: func(node *Node) {
				node.Type = NodePersonalization
				node.Role = RolePersonalizationSlot
				node.Content = NodeContent{Personalization: &PersonalizationContent{
					Label: "First name", Slot: SlotReference{ID: "first_name", Fallback: "there"},
				}}
				node.Localizations = map[string]NodeContent{
					"fr-FR": {Personalization: &PersonalizationContent{
						// A DIFFERENT attribute of the same person.
						Label: "Prénom", Slot: SlotReference{ID: "internal_note", Fallback: "là"},
					}},
				}
			},
			wantsIn: "/personalization/slot/id",
		},
		{
			name: "action id",
			mutate: func(node *Node) {
				node.Type = NodeAction
				node.Role = RolePrimaryAction
				node.Content = NodeContent{Action: &ActionContent{
					ActionID: "act_shop", Label: "Shop", CanonicalURL: "https://example.test/a",
				}}
				node.Localizations = map[string]NodeContent{
					"fr-FR": {Action: &ActionContent{
						ActionID: "act_acheter", Label: "Acheter", CanonicalURL: "https://example.test/a",
					}},
				}
			},
			wantsIn: "/action/action_id",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			document := validDocumentV2()
			node := document.Nodes[0]
			tc.mutate(&node)
			document.Nodes[0] = node

			diagnostics := ValidateV2(document)
			found := false
			for _, d := range diagnostics {
				if d.Severity == SeverityError && strings.Contains(d.Path, tc.wantsIn) {
					found = true
				}
			}
			if !found {
				t.Fatalf("a localization re-pointed identity at %s and validation "+
					"accepted it: %v", tc.wantsIn, diagnostics)
			}
		})
	}
}

// Guard the guard: a localization that translates only the WORDS must remain
// valid, or the rule above would pass against a validator that rejected every
// localization and quietly made the feature unusable.
func TestALocalizationThatOnlyTranslatesWordsIsAccepted(t *testing.T) {
	document := validDocumentV2()
	node := document.Nodes[0]
	node.Type = NodePersonalization
	node.Role = RolePersonalizationSlot
	node.Content = NodeContent{Personalization: &PersonalizationContent{
		Label: "First name", Slot: SlotReference{ID: "first_name", Fallback: "there"},
	}}
	node.Localizations = map[string]NodeContent{
		"fr-FR": {Personalization: &PersonalizationContent{
			Label: "Prénom", Slot: SlotReference{ID: "first_name", Fallback: "là"},
		}},
	}
	document.Nodes[0] = node

	for _, d := range ValidateV2(document) {
		if d.Severity == SeverityError && strings.Contains(d.Path, "/personalization/slot/id") {
			t.Fatalf("a translation-only localization was rejected: %v", d)
		}
	}
}
