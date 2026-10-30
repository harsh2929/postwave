// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

func text(value string) RichText {
	return RichText{Runs: []InlineRun{{Kind: InlineText, Text: value}}}
}

func validDocumentV2() DocumentV2 {
	provenance := Provenance{Source: SourceUser}
	return DocumentV2{
		SchemaVersion: SchemaVersionV2,
		Language:      "en-IN",
		Direction:     DirectionLTR,
		Nodes: []Node{
			{
				ID: "blk_event_name", Type: NodeHeading, Role: RoleHeading, Version: NodeVersionV2,
				Content:    NodeContent{Heading: &HeadingContent{Level: 1, Text: text("Workflow Automation Live")}},
				Provenance: provenance,
			},
			{
				ID: "blk_intro", Type: NodeParagraph, Role: RoleBody, Version: NodeVersionV2,
				Content: NodeContent{Paragraph: &ParagraphContent{Text: RichText{Runs: []InlineRun{
					{Kind: InlineText, Text: "Hello "},
					{Kind: InlineSlot, Slot: &SlotReference{ID: "first_name", SemanticClass: SlotName, Required: true}},
					{Kind: InlineText, Text: ", see our "},
					{Kind: InlineStrong, Text: "new workflow"},
					{Kind: InlineText, Text: " in action."},
				}}}},
				Conditions: []Condition{{ID: "cond_pro", SlotID: "segment", Operator: ConditionEquals, Value: "pro"}},
				Provenance: provenance,
			},
			{
				ID: "blk_list", Type: NodeList, Role: RoleBody, Version: NodeVersionV2,
				Content:    NodeContent{List: &ListContent{Items: []RichText{text("Live demonstration"), text("Question and answer session")}}},
				Provenance: provenance,
			},
			{
				ID: "blk_answer", Type: NodeAnswer, Role: RoleAnswer, Version: NodeVersionV2,
				Content:    NodeContent{Answer: &AnswerContent{Question: text("When is it?"), Answer: text("14 August at 4:00 PM IST.")}},
				Provenance: provenance,
			},
			{
				ID: "blk_register", Type: NodeAction, Role: RolePrimaryAction, Version: NodeVersionV2,
				Content:    NodeContent{Action: &ActionContent{ActionID: "act_register", Label: "Reserve my seat", CanonicalURL: "https://example.test/events/launch", AccessibleDescription: "Reserve a seat for Workflow Automation Live"}},
				Provenance: provenance,
			},
			{
				ID: "blk_promo_image", Type: NodeImage, Role: RoleInformativeImage, Version: NodeVersionV2,
				Content:    NodeContent{Image: &ImageContent{URL: "https://cdn.example.test/promo.jpg", Alt: "Workflow Automation Live speakers", Width: 1910, Height: 1000}},
				Provenance: provenance,
			},
			{
				ID: "blk_event_start", Type: NodeDateTime, Role: RoleEventDateTime, Version: NodeVersionV2,
				Content:    NodeContent{DateTime: &DateTimeContent{DisplayValue: "14 August 2026, 4:00 PM IST", RFC3339: "2026-08-14T16:00:00+05:30", Timezone: "Asia/Kolkata"}},
				Provenance: provenance,
			},
			{
				ID: "blk_price", Type: NodeMoney, Role: RolePrice, Version: NodeVersionV2,
				Content:    NodeContent{Money: &MoneyContent{DisplayValue: "₹1,499", Amount: "1499", Currency: "INR"}},
				Provenance: provenance,
			},
			{
				ID: "blk_discount", Type: NodeMoney, Role: RolePrice, Version: NodeVersionV2,
				Content:    NodeContent{Money: &MoneyContent{DisplayValue: "₹200", Amount: "200", Currency: "INR"}},
				Provenance: provenance,
			},
			{
				ID: "blk_deadline", Type: NodeDeadline, Role: RoleDeadline, Version: NodeVersionV2,
				Content:    NodeContent{Deadline: &DateTimeContent{DisplayValue: "Offer ends 13 August 2026, 11:59 PM IST", RFC3339: "2026-08-13T23:59:00+05:30", Timezone: "Asia/Kolkata"}},
				Provenance: provenance,
			},
			{
				ID: "blk_offer", Type: NodeOffer, Role: RoleOffer, Version: NodeVersionV2,
				Content: NodeContent{Offer: &OfferContent{
					Description:        text("Save ₹200 on your reservation"),
					Code:               "LIVE200",
					Terms:              text("Valid for Pro customers in India"),
					AvailabilityStarts: &DateTimeContent{DisplayValue: "9 August 2026, 9:00 AM IST", RFC3339: "2026-08-09T09:00:00+05:30", Timezone: "Asia/Kolkata"},
					AvailabilityEnds:   &DateTimeContent{DisplayValue: "13 August 2026, 11:59 PM IST", RFC3339: "2026-08-13T23:59:00+05:30", Timezone: "Asia/Kolkata"},
				}},
				Provenance: provenance,
			},
			{
				ID: "blk_location", Type: NodeLocation, Role: RoleLocation, Version: NodeVersionV2,
				Content:    NodeContent{Location: &LocationContent{Name: "Moosewave Studio", Address: PostalAddress{StreetAddress: "12 Residency Road", AddressLocality: "Bengaluru", AddressRegion: "KA", PostalCode: "560025", AddressCountry: "IN"}}},
				Provenance: provenance,
			},
			{
				ID: "blk_product", Type: NodeProduct, Role: RoleProduct, Version: NodeVersionV2,
				Content:    NodeContent{Product: &ProductContent{Name: "Workflow Automation Workshop", SKU: "WAW-2026", CanonicalURL: "https://example.test/products/workshop", ImageURL: "https://cdn.example.test/workshop.jpg"}},
				Provenance: provenance,
			},
			{
				ID: "blk_reservation_number", Type: NodeFact, Role: RoleProductFact, Version: NodeVersionV2,
				Content:    NodeContent{Fact: &FactContent{Label: "Reservation number", Value: "R-12345"}},
				Provenance: provenance,
			},
			{
				ID: "blk_under_name", Type: NodePersonalization, Role: RolePersonalizationSlot, Version: NodeVersionV2,
				Content:    NodeContent{Personalization: &PersonalizationContent{Label: "Attendee", Slot: SlotReference{ID: "full_name", SemanticClass: SlotName, Required: true}}},
				Provenance: provenance,
			},
			{
				ID: "blk_merchant", Type: NodeFact, Role: RoleProductFact, Version: NodeVersionV2,
				Content:    NodeContent{Fact: &FactContent{Label: "Merchant", Value: "Moosewave"}},
				Provenance: provenance,
			},
			{
				ID: "blk_order_number", Type: NodeFact, Role: RoleProductFact, Version: NodeVersionV2,
				Content:    NodeContent{Fact: &FactContent{Label: "Order number", Value: "O-12345"}},
				Provenance: provenance,
			},
			{
				ID: "blk_quantity", Type: NodeFact, Role: RoleProductFact, Version: NodeVersionV2,
				Content:    NodeContent{Fact: &FactContent{Label: "Quantity", Value: "1"}},
				Provenance: provenance,
			},
			{
				ID: "blk_legal", Type: NodeLegal, Role: RoleFooter, Version: NodeVersionV2,
				Content: NodeContent{Legal: &LegalContent{Text: RichText{Runs: []InlineRun{
					{Kind: InlineText, Text: "You can "},
					{Kind: InlineLink, Text: "manage preferences", URL: "https://example.test/preferences", AccessibleLabel: "Manage email preferences"},
					{Kind: InlineText, Text: " at any time."},
				}}}},
				Provenance: provenance,
			},
			{
				ID: "blk_reservation_status", Type: NodeFact, Role: RoleProductFact, Version: NodeVersionV2,
				Content:    NodeContent{Fact: &FactContent{Label: "Reservation status", Value: "Confirmed"}},
				Provenance: provenance,
			},
			structuredNode("blk_schema_offer", StructuredDiscountOffer, UseCaseGmailPromotion, StructuredDeclaration{DiscountOffer: &DiscountOfferDeclaration{OfferNodeID: "blk_offer"}}),
			structuredNode("blk_schema_card", StructuredPromotionCard, UseCaseGmailPromotion, StructuredDeclaration{PromotionCard: &PromotionCardDeclaration{ImageNodeID: "blk_promo_image", ActionNodeID: "blk_register", HeadlineNodeID: "blk_event_name", PriceNodeID: "blk_price", DiscountValueNodeID: "blk_discount", Position: 1}}),
			structuredNode("blk_schema_event", StructuredEventReservation, UseCaseGmailTransaction, StructuredDeclaration{EventReservation: &EventReservationDeclaration{ReservationNumberNodeID: "blk_reservation_number", UnderNameNodeID: "blk_under_name", EventNameNodeID: "blk_event_name", StartDateTimeNodeID: "blk_event_start", LocationNodeID: "blk_location", StatusNodeID: "blk_reservation_status", Status: ReservationConfirmed, ActionNodeID: "blk_register"}}),
			structuredNode("blk_schema_order", StructuredOrder, UseCaseGmailTransaction, StructuredDeclaration{Order: &OrderDeclaration{MerchantNodeID: "blk_merchant", OrderNumberNodeID: "blk_order_number", TotalNodeID: "blk_price", Items: []OrderItemRef{{ProductNodeID: "blk_product", PriceNodeID: "blk_price", QuantityNodeID: "blk_quantity"}}, ActionNodeID: "blk_register"}}),
		},
	}
}

func structuredNode(id NodeID, kind StructuredDataKind, useCase StructuredDataUseCase, declaration StructuredDeclaration) Node {
	return Node{
		ID: id, Type: NodeStructuredData, Role: RoleStructuredData, Version: NodeVersionV2,
		Content: NodeContent{StructuredData: &StructuredDataContent{
			Enabled: true, Provider: ProviderGmail, RegistryVersion: GmailRegistryVersion,
			UseCase: useCase, Kind: kind, Declaration: declaration,
		}},
		Provenance: Provenance{Source: SourceUser},
	}
}

func validCompileOptions() CompileOptions {
	return CompileOptions{
		Slots: map[SlotID]string{"first_name": "Asha", "full_name": "Asha Rao", "segment": "pro"},
		StructuredPolicy: StructuredPolicy{Gmail: GmailPolicy{
			RegisteredSender: true,
			Authenticated:    true,
			Promotions:       true,
			Transactions:     true,
		}},
	}
}
