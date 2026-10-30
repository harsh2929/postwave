// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

// The in-email offer node -> canonical offer entity bridge (PRD F15), semantic
// half.
//
// internal/offers holds the canonical entity: what is offered, at what price,
// until when, how to act, and whether it is still in stock. The semantic tree
// holds an in-email OFFER BLOCK: the words the message uses to present it. Until
// these were connected they were two unrelated records that could disagree about
// price, validity window and inventory state, with nothing anywhere able to
// notice.
//
// This file carries only the semantic half — extracting the reference and the
// message's own claims about it — because compilation is deterministic and
// side-effect free by contract: no clock, no network, no persistence. Resolving
// the entity needs all three, so it lives in internal/offers.

// CanonicalOfferReference is one in-email offer block's link to the canonical
// entity, plus what the MESSAGE claims about it.
//
// The Authored* fields are not the offer. They are the sender's printed claim,
// carried here for exactly one purpose: so a resolver can compare them against
// the entity and report a disagreement. Treating them as the offer is the
// mistake this bridge exists to prevent.
type CanonicalOfferReference struct {
	// NodeID is the offer block that made the claim, so a disagreement can be
	// reported against the thing an author can edit.
	NodeID NodeID `json:"node_id"`
	// CanonicalOfferID names the entity. It is the same value for every
	// recipient, because the tree is shared by every recipient.
	CanonicalOfferID string `json:"canonical_offer_id"`

	// AuthoredCode is the discount code printed in the message, if any.
	AuthoredCode string `json:"authored_code,omitempty"`
	// AuthoredAvailabilityStarts/Ends are RFC 3339 instants printed in the
	// message, empty when the message does not state one. "The message does not
	// state an end that the entity has" is itself a disagreement worth reporting:
	// the reader was not told the offer expires.
	AuthoredAvailabilityStarts string `json:"authored_availability_starts,omitempty"`
	AuthoredAvailabilityEnds   string `json:"authored_availability_ends,omitempty"`
}

// CanonicalOfferReferences returns every bridge declared by a document, in
// document order.
//
// Base content is authoritative: a localization may translate an offer's words
// but validation forbids it from naming a different entity, so reading
// localizations here could only ever produce duplicates or a contradiction.
//
// Offer blocks with no canonical reference are omitted rather than returned with
// an empty id. An unbridged block is a real state — the message presents an
// offer nothing can resolve — and the caller that cares about it should ask the
// document, not filter a list of bridges.
func CanonicalOfferReferences(document DocumentV2) []CanonicalOfferReference {
	var out []CanonicalOfferReference
	for _, node := range document.Nodes {
		if node.Type != NodeOffer || node.Content.Offer == nil {
			continue
		}
		offer := node.Content.Offer
		if offer.CanonicalOfferID == "" {
			continue
		}
		reference := CanonicalOfferReference{
			NodeID:           node.ID,
			CanonicalOfferID: offer.CanonicalOfferID,
			AuthoredCode:     offer.Code,
		}
		if offer.AvailabilityStarts != nil {
			reference.AuthoredAvailabilityStarts = offer.AvailabilityStarts.RFC3339
		}
		if offer.AvailabilityEnds != nil {
			reference.AuthoredAvailabilityEnds = offer.AvailabilityEnds.RFC3339
		}
		out = append(out, reference)
	}
	return out
}

// UnbridgedOfferNodes returns the offer blocks that name no canonical entity.
//
// Named separately from CanonicalOfferReferences because it answers a different
// question and deserves to be asked on purpose: these are the offers a message
// presents that an agent cannot resolve, price, or check the expiry of.
func UnbridgedOfferNodes(document DocumentV2) []NodeID {
	var out []NodeID
	for _, node := range document.Nodes {
		if node.Type == NodeOffer && node.Content.Offer != nil && node.Content.Offer.CanonicalOfferID == "" {
			out = append(out, node.ID)
		}
	}
	return out
}
