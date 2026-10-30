// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/url"
	"strconv"
	"strings"
)

const schemaContext = "http://schema.org"

func (s *compileState) compileStructuredData(policy StructuredPolicy) ([]json.RawMessage, []StructuredDataStatus) {
	var payloads []json.RawMessage
	var statuses []StructuredDataStatus
	for _, resolved := range s.nodes {
		if resolved.node.Type != NodeStructuredData || resolved.content.StructuredData == nil {
			continue
		}
		declaration := resolved.content.StructuredData
		status := StructuredDataStatus{
			NodeID:              resolved.node.ID,
			Provider:            declaration.Provider,
			RegistryVersion:     declaration.RegistryVersion,
			Kind:                declaration.Kind,
			Valid:               true,
			ObservedDisplay:     "unknown",
			ComprehensionEffect: "unproven",
		}
		if !declaration.Enabled {
			status.Eligibility = EligibilityDisabled
			status.EligibilityReason = "declaration disabled by author"
			statuses = append(statuses, status)
			continue
		}
		eligible, reason := gmailEligibility(*declaration, policy.Gmail, policy.DeclaredSendSurface)
		if !eligible {
			status.Eligibility = EligibilityUnverified
			status.EligibilityReason = reason
			statuses = append(statuses, status)
			path := s.nodePath(resolved.node.ID) + "/content/structured_data"
			s.diagnostics.warning(path, resolved.node.ID, CodeStructuredDataUnverified, reason+"; valid markup was not emitted")
			continue
		}
		status.Eligibility = EligibilityEligible
		payload, ok := s.buildStructuredPayload(resolved)
		if ok {
			status.Emitted = true
			payloads = append(payloads, payload)
		}
		statuses = append(statuses, status)
	}
	return payloads, statuses
}

func gmailEligibility(
	declaration StructuredDataContent,
	policy GmailPolicy,
	declaredSurface string,
) (bool, string) {
	if !policy.RegisteredSender {
		return false, "Gmail sender registration is not verified"
	}
	if !policy.Authenticated {
		return false, "SPF or DKIM authentication evidence is not verified"
	}
	switch declaration.UseCase {
	case UseCaseGmailPromotion:
		if !policy.Promotions {
			return false, "Gmail Promotions annotation use case is not enabled"
		}
	case UseCaseGmailTransaction:
		if !policy.Transactions {
			return false, "Gmail transactional markup use case is not enabled"
		}
	default:
		return false, "Gmail use case is not enabled"
	}
	// Whether the TENANT may use this annotation is answered above. This asks
	// whether THIS SEND is the kind of send it applies to. Emitting markup for
	// the wrong surface produces structured data Gmail ignores — worse than
	// omitting it, because the receipt then records it as emitted.
	if useCase, ok := useCaseForDeclaredSurface(declaredSurface); ok {
		if declaration.UseCase != useCase {
			return false, "the sender declared a " + declaredSurface +
				" send, which does not use this markup"
		}
	} else if strings.TrimSpace(declaredSurface) != "" {
		// Unrecognised, not absent. Falling through here would make any invented
		// surface string a way past this check.
		return false, "the declared send surface is not a registered provider surface"
	}
	return true, ""
}

func (s *compileState) buildStructuredPayload(owner resolvedNode) (json.RawMessage, bool) {
	structured := owner.content.StructuredData
	var value any
	var ok bool
	switch structured.Kind {
	case StructuredDiscountOffer:
		value, ok = s.buildDiscountOffer(owner, structured.Declaration.DiscountOffer)
	case StructuredPromotionCard:
		value, ok = s.buildPromotionCard(owner, structured.Declaration.PromotionCard)
	case StructuredEventReservation:
		value, ok = s.buildEventReservation(owner, structured.Declaration.EventReservation)
	case StructuredOrder:
		value, ok = s.buildOrder(owner, structured.Declaration.Order)
	}
	if !ok {
		return nil, false
	}
	payload, err := json.Marshal(value)
	if err != nil {
		s.diagnostics.error(s.nodePath(owner.node.ID)+"/content/structured_data", owner.node.ID, CodeInvalidText, "structured payload could not be canonically encoded")
		return nil, false
	}
	return payload, true
}

func (s *compileState) buildDiscountOffer(owner resolvedNode, declaration *DiscountOfferDeclaration) (any, bool) {
	if declaration == nil {
		return nil, false
	}
	offerNode, ok := s.requireStructuredSource(owner, "declaration/discount_offer/offer_node_id", declaration.OfferNodeID)
	if !ok {
		return nil, false
	}
	offer := offerNode.content.Offer
	value := map[string]any{
		"@context":    schemaContext,
		"@type":       "DiscountOffer",
		"description": renderTextRichText(offer.Description),
	}
	if offer.Code != "" {
		value["discountCode"] = offer.Code
	}
	if offer.AvailabilityStarts != nil {
		value["availabilityStarts"] = offer.AvailabilityStarts.RFC3339
	}
	if offer.AvailabilityEnds != nil {
		value["availabilityEnds"] = offer.AvailabilityEnds.RFC3339
	}
	return value, true
}

func (s *compileState) buildPromotionCard(owner resolvedNode, declaration *PromotionCardDeclaration) (any, bool) {
	if declaration == nil {
		return nil, false
	}
	imageNode, imageOK := s.requireStructuredSource(owner, "declaration/promotion_card/image_node_id", declaration.ImageNodeID)
	actionNode, actionOK := s.requireStructuredSource(owner, "declaration/promotion_card/action_node_id", declaration.ActionNodeID)
	if !imageOK || !actionOK {
		return nil, false
	}
	image := imageNode.content.Image
	if image.Width <= 0 || image.Height <= 0 || !supportedPromotionAspectRatio(image.Width, image.Height) {
		s.diagnostics.error(s.nodePath(owner.node.ID)+"/content/structured_data/declaration/promotion_card/image_node_id", owner.node.ID, CodeNumberOutOfRange, "resolved promotion card image must have a 4:5, 1:1, or 1.91:1 ratio")
		return nil, false
	}
	value := map[string]any{
		"@context": schemaContext,
		"@type":    "PromotionCard",
		"image":    image.URL,
		"url":      actionNode.content.Action.CanonicalURL,
	}
	if declaration.HeadlineNodeID != "" {
		headline, ok := s.requireStructuredSource(owner, "declaration/promotion_card/headline_node_id", declaration.HeadlineNodeID)
		if !ok {
			return nil, false
		}
		value["headline"] = visibleNodeValue(headline)
	}
	var priceCurrency string
	if declaration.PriceNodeID != "" {
		priceNode, ok := s.requireStructuredSource(owner, "declaration/promotion_card/price_node_id", declaration.PriceNodeID)
		if !ok {
			return nil, false
		}
		value["price"] = priceNode.content.Money.Amount
		value["priceCurrency"] = priceNode.content.Money.Currency
		priceCurrency = priceNode.content.Money.Currency
	}
	if declaration.DiscountValueNodeID != "" {
		discountNode, ok := s.requireStructuredSource(owner, "declaration/promotion_card/discount_value_node_id", declaration.DiscountValueNodeID)
		if !ok {
			return nil, false
		}
		if priceCurrency == "" {
			s.diagnostics.error(s.nodePath(owner.node.ID)+"/content/structured_data/declaration/promotion_card/discount_value_node_id", owner.node.ID, CodeRequired, "discountValue requires a referenced price and currency")
			return nil, false
		}
		if discountNode.content.Money.Currency != priceCurrency {
			s.diagnostics.error(s.nodePath(owner.node.ID)+"/content/structured_data/declaration/promotion_card/discount_value_node_id", owner.node.ID, CodeInvalidCurrency, "discount value currency must match promotion price currency")
			return nil, false
		}
		value["discountValue"] = discountNode.content.Money.Amount
	}
	if declaration.Position > 0 {
		value["position"] = strconv.Itoa(declaration.Position)
	}
	return value, true
}

func (s *compileState) buildEventReservation(owner resolvedNode, declaration *EventReservationDeclaration) (any, bool) {
	if declaration == nil {
		return nil, false
	}
	reservationNumber, numberOK := s.requireStructuredSource(owner, "declaration/event_reservation/reservation_number_node_id", declaration.ReservationNumberNodeID)
	underName, nameOK := s.requireStructuredSource(owner, "declaration/event_reservation/under_name_node_id", declaration.UnderNameNodeID)
	eventName, eventOK := s.requireStructuredSource(owner, "declaration/event_reservation/event_name_node_id", declaration.EventNameNodeID)
	startNode, startOK := s.requireStructuredSource(owner, "declaration/event_reservation/start_datetime_node_id", declaration.StartDateTimeNodeID)
	locationNode, locationOK := s.requireStructuredSource(owner, "declaration/event_reservation/location_node_id", declaration.LocationNodeID)
	statusNode, statusOK := s.requireStructuredSource(owner, "declaration/event_reservation/status_node_id", declaration.StatusNodeID)
	if !numberOK || !nameOK || !eventOK || !startOK || !locationOK || !statusOK {
		return nil, false
	}
	if !strings.EqualFold(statusNode.content.Fact.Value, string(declaration.Status)) {
		s.diagnostics.error(s.nodePath(owner.node.ID)+"/content/structured_data/declaration/event_reservation/status_node_id", owner.node.ID, CodeStructuredKindMismatch, "resolved visible reservation status must match the typed schema status")
		return nil, false
	}
	location := locationNode.content.Location
	value := map[string]any{
		"@context":          schemaContext,
		"@type":             "EventReservation",
		"reservationNumber": visibleNodeValue(reservationNumber),
		"reservationStatus": reservationStatusURI(declaration.Status),
		"underName": map[string]any{
			"@type": "Person",
			"name":  visibleNodeValue(underName),
		},
		"reservationFor": map[string]any{
			"@type":     "Event",
			"name":      visibleNodeValue(eventName),
			"startDate": startNode.content.DateTime.RFC3339,
			"location": map[string]any{
				"@type": "Place",
				"name":  location.Name,
				"address": map[string]any{
					"@type":           "PostalAddress",
					"streetAddress":   location.Address.StreetAddress,
					"addressLocality": location.Address.AddressLocality,
					"addressCountry":  location.Address.AddressCountry,
				},
			},
		},
	}
	address := value["reservationFor"].(map[string]any)["location"].(map[string]any)["address"].(map[string]any)
	if location.Address.AddressRegion != "" {
		address["addressRegion"] = location.Address.AddressRegion
	}
	if location.Address.PostalCode != "" {
		address["postalCode"] = location.Address.PostalCode
	}
	if declaration.ActionNodeID != "" {
		actionNode, ok := s.requireStructuredSource(owner, "declaration/event_reservation/action_node_id", declaration.ActionNodeID)
		if !ok {
			return nil, false
		}
		value["url"] = actionNode.content.Action.CanonicalURL
	}
	return value, true
}

func (s *compileState) buildOrder(owner resolvedNode, declaration *OrderDeclaration) (any, bool) {
	if declaration == nil {
		return nil, false
	}
	merchantNode, merchantOK := s.requireStructuredSource(owner, "declaration/order/merchant_node_id", declaration.MerchantNodeID)
	orderNumberNode, numberOK := s.requireStructuredSource(owner, "declaration/order/order_number_node_id", declaration.OrderNumberNodeID)
	totalNode, totalOK := s.requireStructuredSource(owner, "declaration/order/total_node_id", declaration.TotalNodeID)
	if !merchantOK || !numberOK || !totalOK {
		return nil, false
	}
	total := totalNode.content.Money
	offers := make([]any, 0, len(declaration.Items))
	for i, item := range declaration.Items {
		productNode, productOK := s.requireStructuredSource(owner, fmt.Sprintf("declaration/order/items/%d/product_node_id", i), item.ProductNodeID)
		priceNode, priceOK := s.requireStructuredSource(owner, fmt.Sprintf("declaration/order/items/%d/price_node_id", i), item.PriceNodeID)
		quantityNode, quantityOK := s.requireStructuredSource(owner, fmt.Sprintf("declaration/order/items/%d/quantity_node_id", i), item.QuantityNodeID)
		if !productOK || !priceOK || !quantityOK {
			return nil, false
		}
		quantityValue := quantityNode.content.Fact.Value
		canonicalQuantity, validQuantity := normalizeDecimal(quantityValue)
		quantity, parsedQuantity := new(big.Rat).SetString(quantityValue)
		if !validQuantity || canonicalQuantity != quantityValue || !parsedQuantity || quantity.Sign() <= 0 {
			s.diagnostics.error(s.nodePath(owner.node.ID)+fmt.Sprintf("/content/structured_data/declaration/order/items/%d/quantity_node_id", i), owner.node.ID, CodeInvalidDecimal, "resolved order quantity must be a canonical decimal greater than zero")
			return nil, false
		}
		price := priceNode.content.Money
		if price.Currency != total.Currency {
			s.diagnostics.error(s.nodePath(owner.node.ID)+fmt.Sprintf("/content/structured_data/declaration/order/items/%d/price_node_id", i), owner.node.ID, CodeInvalidCurrency, "order item currency must match order total currency")
			return nil, false
		}
		product := productNode.content.Product
		productValue := map[string]any{"@type": "Product", "name": product.Name}
		if product.SKU != "" {
			productValue["sku"] = product.SKU
		}
		if product.CanonicalURL != "" {
			productValue["url"] = product.CanonicalURL
		}
		if product.ImageURL != "" {
			productValue["image"] = product.ImageURL
		}
		offers = append(offers, map[string]any{
			"@type":         "Offer",
			"itemOffered":   productValue,
			"price":         price.Amount,
			"priceCurrency": price.Currency,
			"eligibleQuantity": map[string]any{
				"@type": "QuantitativeValue",
				"value": quantityValue,
			},
		})
	}
	var acceptedOffer any = offers
	if len(offers) == 1 {
		acceptedOffer = offers[0]
	}
	value := map[string]any{
		"@context": schemaContext,
		"@type":    "Order",
		"merchant": map[string]any{
			"@type": "Organization",
			"name":  visibleNodeValue(merchantNode),
		},
		"orderNumber":   visibleNodeValue(orderNumberNode),
		"priceCurrency": total.Currency,
		"price":         total.Amount,
		"acceptedOffer": acceptedOffer,
	}
	if declaration.ActionNodeID != "" {
		actionNode, ok := s.requireStructuredSource(owner, "declaration/order/action_node_id", declaration.ActionNodeID)
		if !ok {
			return nil, false
		}
		url := actionNode.content.Action.CanonicalURL
		value["url"] = url
		value["potentialAction"] = map[string]any{"@type": "ViewAction", "url": url}
	}
	return value, true
}

func (s *compileState) requireStructuredSource(owner resolvedNode, referencePath string, nodeID NodeID) (resolvedNode, bool) {
	resolved, ok := s.nodeByID[nodeID]
	if ok {
		if resolved.node.Type == NodeAction && resolved.content.Action != nil {
			parsed, err := url.Parse(resolved.content.Action.CanonicalURL)
			if err != nil || parsed.Scheme != "https" {
				path := s.nodePath(owner.node.ID) + "/content/structured_data/" + referencePath
				s.diagnostics.error(path, owner.node.ID, CodeHTTPSRequired, "resolved structured-data action requires an HTTPS canonical URL")
				return resolvedNode{}, false
			}
		}
		return resolved, true
	}
	path := s.nodePath(owner.node.ID) + "/content/structured_data/" + referencePath
	s.diagnostics.error(path, owner.node.ID, CodeStructuredSourceAbsent, "referenced semantic source is absent from this compiled scenario")
	return resolvedNode{}, false
}

func (s *compileState) nodePath(nodeID NodeID) string {
	for i, node := range s.document.Nodes {
		if node.ID == nodeID {
			return fmt.Sprintf("/nodes/%d", i)
		}
	}
	return "/nodes"
}

func visibleNodeValue(node resolvedNode) string {
	switch node.node.Type {
	case NodeHeading:
		return renderTextRichText(node.content.Heading.Text)
	case NodeParagraph:
		return renderTextRichText(node.content.Paragraph.Text)
	case NodeFact:
		return node.content.Fact.Value
	case NodePersonalization:
		return node.content.Personalization.Slot.Fallback
	case NodeProduct:
		return node.content.Product.Name
	default:
		return renderTextNode(node)
	}
}

func reservationStatusURI(status ReservationStatus) string {
	switch status {
	case ReservationConfirmed:
		return schemaContext + "/Confirmed"
	case ReservationPending:
		return schemaContext + "/Pending"
	case ReservationCancelled:
		return schemaContext + "/Cancelled"
	default:
		return ""
	}
}
