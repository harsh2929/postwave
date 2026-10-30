// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

// The canonical-offer bridge as an assurance rule (PRD F15).
//
// A message rendered an offer; an agent asking "what is this offer" queries the
// canonical entity. Until this rule existed those were two unrelated records
// that could disagree about price, validity window and inventory state, with
// nothing anywhere comparing them — the resolution half of F15 was built and had
// no caller.
//
// The rule is deliberately thin. Everything hard — resolving the entity,
// deciding what counts as a divergence — happened in the caller, because it is a
// database read and this package is pure. What lives here is the judgement:
// which divergences are worth telling a sender about before the send goes out.
//
// A MISSING entity and a DISAGREEING entity are separate codes because they are
// separate problems with separate fixes: the first means the message points at
// something deleted, the second means both exist and say different things. A
// single code would make a sender guess which they had.

func (a *analysis) evaluateCanonicalOffers(bindings []CanonicalOfferBinding) {
	for _, binding := range bindings {
		if binding.Missing {
			a.add(findingSpec{
				code:      "OFFER_CANONICAL_MISSING",
				severity:  SeverityError,
				blocking:  true,
				dimension: DimensionFactContract,
				blocks:    blockRefs(binding.NodeID, "", ""),
				observed: map[string]any{
					"node_id":            binding.NodeID,
					"canonical_offer_id": binding.CanonicalOfferID,
				},
				// Blocking, unlike the disagreement below. A message naming an
				// entity that does not exist cannot be reconciled by a reader:
				// an agent asked about this offer gets nothing back, so the
				// message makes a promise the product cannot answer for.
				explanation: "This message names a canonical offer that does not exist for this workspace, so an agent asked about the offer can resolve nothing.",
				remediation: Remediation{
					Kind: RemediationAlignFact, Representation: RepresentationRevision,
					NodeID: binding.NodeID, Field: "content.offer.canonical_offer_id",
				},
			})
			continue
		}
		for _, disagreement := range binding.Disagreements {
			a.add(findingSpec{
				code:      "OFFER_CANONICAL_DISAGREEMENT",
				severity:  SeverityWarning,
				dimension: DimensionFactContract,
				blocks:    blockRefs(binding.NodeID, "", ""),
				observed: map[string]any{
					"node_id":            binding.NodeID,
					"canonical_offer_id": binding.CanonicalOfferID,
					"field":              disagreement.Field,
					"in_message":         disagreement.InMessage,
					"canonical":          disagreement.Canonical,
				},
				// A WARNING, not an error. The two records disagreeing is often
				// legitimate and transient — an entity edited after the draft was
				// written, an offer that has since sold out — and blocking the
				// send would stop a correct message going out because a field
				// moved. What matters is that the sender is TOLD, because the
				// recipient and the agent will otherwise be given two different
				// answers and neither will know.
				explanation: "The offer this message renders disagrees with the canonical entity an agent would resolve, so a recipient and an agent are told different things about the same offer.",
				remediation: Remediation{
					Kind: RemediationAlignFact, Representation: RepresentationRevision,
					NodeID: binding.NodeID, Field: "content.offer",
				},
			})
		}
	}
}
