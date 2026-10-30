// SPDX-License-Identifier: AGPL-3.0-only

package offers

// The in-email offer node -> canonical offer entity bridge (PRD F15),
// resolution half.
//
// # Why a reference and not a copy
//
// The semantic tree names the offer; it does not carry it. Two independent
// reasons, and either alone is sufficient.
//
// A semantic tree is shared by EVERY recipient of a message. That is a
// structural property of the model, not a convention — it is why per-recipient
// poll links are compiler input rather than tree content. Inlining a price, a
// validity window or an inventory state would mean one frozen answer is handed
// to everybody, with no way for the tree to say when it was taken or for a
// reader to know it has moved on.
//
// And a copy goes stale SILENTLY. The canonical entity changes when the price
// changes, when the last unit sells, when the window is extended. A copy in the
// tree does not change; it simply stops being true, and nothing about it looks
// different afterwards. An agent that resolved the copy and an agent that
// resolved the entity would then disagree, both confidently, and neither could
// tell which was current. A name can be re-resolved. A copy cannot be un-staled.
//
// So the bridge resolves at READ time, every time, and it reports the
// disagreements between what the message printed and what the entity says —
// because the message is a copy too, and the only honest thing to do about a
// copy that has drifted is to name the drift.

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

// CanonicalBinding is one in-email offer block resolved against the canonical
// entity, as of a moment.
//
// It deliberately carries the whole *Offer rather than a selection of fields.
// A binding that copied "the price and the expiry" would reintroduce, one layer
// up, exactly the snapshot the tree refuses to hold.
type CanonicalBinding struct {
	NodeID           string `json:"node_id"`
	CanonicalOfferID string `json:"canonical_offer_id"`

	// Offer is the canonical entity as it exists right now. Nil when Missing.
	Offer *Offer `json:"offer,omitempty"`
	// Missing means the message names an entity that does not exist for this
	// tenant. It is a first-class outcome: a message pointing at a deleted offer
	// is a real production state and must not read as "no problem found".
	Missing bool `json:"missing"`

	// Disagreements is where what the MESSAGE says differs from what the ENTITY
	// says. Empty when they agree.
	Disagreements []Disagreement `json:"disagreements,omitempty"`
}

// Disagreement is one concrete divergence between the message and the entity.
type Disagreement struct {
	// Field is a stable machine-readable name. Clients switch on this.
	Field string `json:"field"`
	// InMessage is what the recipient was told, empty when the message is silent.
	InMessage string `json:"in_message"`
	// Canonical is what the entity says, empty when the entity is silent.
	Canonical string `json:"canonical"`
	// Detail is prose for a human and must not be parsed.
	Detail string `json:"detail"`
}

// Disagreement field names.
const (
	DisagreementAvailabilityStarts = "availability_starts"
	DisagreementAvailabilityEnds   = "availability_ends"
	DisagreementInventoryState     = "inventory_state"
	DisagreementExpired            = "expired"
	DisagreementCode               = "code"
)

// ResolveSemanticOffers resolves every bridge a message declares.
//
// It is a READ, performed now, against the canonical rows — never a lookup in
// anything the tree carried. Calling it twice across a change to the entity
// returns two different answers, which is the entire point.
func (r *Repo) ResolveSemanticOffers(ctx context.Context, tenantID string, references []semanticemail.CanonicalOfferReference) ([]CanonicalBinding, error) {
	if len(references) == 0 {
		return nil, nil
	}
	now := r.now()

	wanted := make([]string, 0, len(references))
	seen := make(map[string]struct{}, len(references))
	for _, reference := range references {
		if !canonicalOfferIDShape(reference.CanonicalOfferID) {
			continue
		}
		if _, duplicate := seen[reference.CanonicalOfferID]; duplicate {
			continue
		}
		seen[reference.CanonicalOfferID] = struct{}{}
		wanted = append(wanted, reference.CanonicalOfferID)
	}

	resolved := map[string]*Offer{}
	if len(wanted) > 0 {
		found, err := r.getMany(ctx, tenantID, wanted)
		if err != nil {
			return nil, err
		}
		resolved = found
	}

	bindings := make([]CanonicalBinding, 0, len(references))
	for _, reference := range references {
		binding := CanonicalBinding{
			NodeID:           string(reference.NodeID),
			CanonicalOfferID: reference.CanonicalOfferID,
		}
		offer, ok := resolved[reference.CanonicalOfferID]
		if !ok || offer == nil {
			binding.Missing = true
			bindings = append(bindings, binding)
			continue
		}
		binding.Offer = offer
		binding.Disagreements = CompareMessageToCanonical(reference, offer, now)
		bindings = append(bindings, binding)
	}
	return bindings, nil
}

// getMany reads the named offers in one tenant-scoped statement.
//
// Row-level security filters rather than refuses, so a cross-tenant id simply
// does not come back and the binding reports Missing — which is the correct and
// non-leaking answer to "this message names an offer you cannot see".
func (r *Repo) getMany(ctx context.Context, tenantID string, ids []string) (map[string]*Offer, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `SELECT `+offerColumns+`
  FROM offers WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`, tenantID, ids)
	if err != nil {
		return nil, fmt.Errorf("offers: resolve semantic bridges: %w", err)
	}
	defer rows.Close()

	out := make(map[string]*Offer, len(ids))
	now := r.now()
	for rows.Next() {
		var offer Offer
		var currency *string
		var metadata []byte
		if err := rows.Scan(&offer.ID, &offer.CampaignID, &offer.Type, &offer.Title, &offer.Description,
			&offer.PriceCents, &currency, &offer.DiscountPct,
			&offer.ValidFrom, &offer.ValidUntil, &offer.TermsURL, &offer.ActionURL,
			&offer.InventoryState, &metadata); err != nil {
			return nil, fmt.Errorf("offers: scan semantic bridge row: %w", err)
		}
		if currency != nil {
			offer.Currency = *currency
		}
		if !validOptionalOfferHTTPSURL(offer.ActionURL) || !validOptionalOfferHTTPSURL(offer.TermsURL) {
			// Same fail-closed rule as the public read: an unsafe URL must not
			// become an actionable projection just because it arrived by a
			// different code path.
			return nil, errUnsafeProjection
		}
		offer.Metadata = decodeMetadata(metadata)
		offer.Expired = offer.ValidUntil != nil && !now.Before(*offer.ValidUntil)
		stored := offer
		out[offer.ID] = &stored
	}
	if err := rows.Err(); err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("offers: read semantic bridge rows: %w", err)
	}
	return out, nil
}

// CompareMessageToCanonical reports where the message and the entity disagree.
//
// Pure, so the comparison can be exercised without a database, and exported so
// an assurance check can run it over a frozen artifact.
//
// The asymmetric cases matter as much as the mismatches. A message that states
// no end date for an offer that HAS one told the reader the offer is open-ended;
// a message that states an end for an offer with none invented a deadline.
// Neither reads as an error anywhere else.
func CompareMessageToCanonical(reference semanticemail.CanonicalOfferReference, offer *Offer, now time.Time) []Disagreement {
	if offer == nil {
		return nil
	}
	var out []Disagreement

	out = appendInstantDisagreement(out, DisagreementAvailabilityStarts,
		reference.AuthoredAvailabilityStarts, offer.ValidFrom,
		"the message and the canonical offer disagree about when the offer starts",
		"the message states a start the canonical offer does not have",
		"the canonical offer starts later than the message says it is available")

	out = appendInstantDisagreement(out, DisagreementAvailabilityEnds,
		reference.AuthoredAvailabilityEnds, offer.ValidUntil,
		"the message and the canonical offer disagree about when the offer ends",
		"the message states an end the canonical offer does not have",
		"the canonical offer expires and the message does not say so")

	if offer.InventoryState != "in_stock" && offer.InventoryState != "limited" {
		out = append(out, Disagreement{
			Field:     DisagreementInventoryState,
			InMessage: "presented as available",
			Canonical: offer.InventoryState,
			Detail:    "the message presents an offer whose canonical inventory state is not actionable",
		})
	}

	if offer.ValidUntil != nil && !now.Before(*offer.ValidUntil) {
		out = append(out, Disagreement{
			Field:     DisagreementExpired,
			InMessage: "presented as available",
			Canonical: offer.ValidUntil.UTC().Format(time.RFC3339),
			Detail:    "the message presents an offer that has already ended",
		})
	}

	if canonicalCode, ok := offer.Metadata["code"].(string); ok && canonicalCode != "" &&
		reference.AuthoredCode != "" && canonicalCode != reference.AuthoredCode {
		out = append(out, Disagreement{
			Field:     DisagreementCode,
			InMessage: reference.AuthoredCode,
			Canonical: canonicalCode,
			Detail:    "the discount code printed in the message is not the canonical offer's code",
		})
	}

	return out
}

func appendInstantDisagreement(out []Disagreement, field, authored string, canonical *time.Time,
	mismatchDetail, messageOnlyDetail, canonicalOnlyDetail string) []Disagreement {
	switch {
	case authored == "" && canonical == nil:
		return out
	case authored == "" && canonical != nil:
		return append(out, Disagreement{
			Field: field, InMessage: "", Canonical: canonical.UTC().Format(time.RFC3339),
			Detail: canonicalOnlyDetail,
		})
	case authored != "" && canonical == nil:
		return append(out, Disagreement{
			Field: field, InMessage: authored, Canonical: "", Detail: messageOnlyDetail,
		})
	}
	parsed, err := time.Parse(time.RFC3339Nano, authored)
	if err != nil {
		// The semantic layer already rejects an unparseable instant, so this is
		// defence in depth rather than a path a valid tree can reach.
		return append(out, Disagreement{
			Field: field, InMessage: authored, Canonical: canonical.UTC().Format(time.RFC3339),
			Detail: mismatchDetail,
		})
	}
	if parsed.Equal(*canonical) {
		return out
	}
	return append(out, Disagreement{
		Field: field, InMessage: parsed.UTC().Format(time.RFC3339),
		Canonical: canonical.UTC().Format(time.RFC3339), Detail: mismatchDetail,
	})
}

// canonicalOfferIDShape keeps a malformed reference out of a ::uuid[] cast,
// where it would fail the whole statement and turn one bad node into a total
// resolution outage.
func canonicalOfferIDShape(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index := range len(value) {
		character := value[index]
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		isDigit := character >= '0' && character <= '9'
		isLowerHex := character >= 'a' && character <= 'f'
		if !isDigit && !isLowerHex {
			return false
		}
	}
	return true
}
