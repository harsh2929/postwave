// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// NormalizeAndValidateV2 is the canonical entry point for decoded authoring
// input. Persist and hash the returned document, not input.
func NormalizeAndValidateV2(input DocumentV2) (DocumentV2, Diagnostics) {
	diagnostics := normalizationDiagnostics(input)
	normalized := NormalizeV2(input)
	diagnostics = append(diagnostics, validateNormalizedV2(normalized)...)
	return normalized, diagnostics
}

// ValidateV2 reports whether input can become valid after documented
// normalizations. Use NormalizeAndValidateV2 for storage or compilation.
func ValidateV2(input DocumentV2) Diagnostics {
	_, diagnostics := NormalizeAndValidateV2(input)
	return diagnostics
}

// NormalizeV2 returns a deep, deterministic copy without dropping or repairing
// semantically invalid nodes. Validation remains an explicit decision.
func NormalizeV2(input DocumentV2) DocumentV2 {
	out := DocumentV2{
		SchemaVersion: input.SchemaVersion,
		Language:      normalizeLanguage(input.Language),
		Direction:     Direction(normalizeEnum(string(input.Direction))),
	}
	if input.Nodes != nil {
		out.Nodes = make([]Node, len(input.Nodes))
		for i, node := range input.Nodes {
			out.Nodes[i] = normalizeNode(node)
		}
	}
	return out
}

func normalizeNode(input Node) Node {
	out := Node{
		ID:      NodeID(normalizeReference(string(input.ID))),
		Type:    NodeType(normalizeEnum(string(input.Type))),
		Role:    NodeRole(normalizeEnum(string(input.Role))),
		Version: input.Version,
		Content: normalizeContent(input.Content),
		Provenance: Provenance{
			Source:   SourceKind(normalizeEnum(string(input.Provenance.Source))),
			SourceID: normalizeReference(input.Provenance.SourceID),
		},
	}
	if input.Conditions != nil {
		out.Conditions = make([]Condition, len(input.Conditions))
		for i, condition := range input.Conditions {
			out.Conditions[i] = Condition{
				ID:       ConditionID(normalizeReference(string(condition.ID))),
				SlotID:   SlotID(normalizeReference(string(condition.SlotID))),
				Operator: ConditionOperator(normalizeEnum(string(condition.Operator))),
				Value:    normalizeNaturalText(condition.Value),
			}
		}
	}
	if input.Localizations != nil {
		out.Localizations = make(map[string]NodeContent, len(input.Localizations))
		locales := make([]string, 0, len(input.Localizations))
		for locale := range input.Localizations {
			locales = append(locales, locale)
		}
		sort.Strings(locales)
		for _, locale := range locales {
			content := input.Localizations[locale]
			out.Localizations[normalizeLanguage(locale)] = normalizeContent(content)
		}
	}
	return out
}

func normalizationDiagnostics(input DocumentV2) Diagnostics {
	diagnostics := Diagnostics{}
	for i, node := range input.Nodes {
		if len(node.Localizations) < 2 {
			continue
		}
		locales := make([]string, 0, len(node.Localizations))
		for locale := range node.Localizations {
			locales = append(locales, locale)
		}
		sort.Strings(locales)
		seen := make(map[string]string, len(locales))
		for _, raw := range locales {
			normalized := normalizeLanguage(raw)
			if first, exists := seen[normalized]; exists {
				diagnostics.error(fmt.Sprintf("/nodes/%d/localizations/%s", i, escapeJSONPointer(raw)), NodeID(normalizeReference(string(node.ID))), CodeDuplicate, "locale collides after normalization with "+first)
			} else {
				seen[normalized] = fmt.Sprintf("/nodes/%d/localizations/%s", i, escapeJSONPointer(raw))
			}
		}
	}
	return diagnostics
}

func normalizeContent(input NodeContent) NodeContent {
	out := NodeContent{}
	if input.Heading != nil {
		out.Heading = &HeadingContent{Level: input.Heading.Level, Text: normalizeRichText(input.Heading.Text)}
	}
	if input.Paragraph != nil {
		out.Paragraph = &ParagraphContent{Text: normalizeRichText(input.Paragraph.Text)}
	}
	if input.List != nil {
		out.List = &ListContent{Ordered: input.List.Ordered}
		if input.List.Items != nil {
			out.List.Items = make([]RichText, len(input.List.Items))
			for i, item := range input.List.Items {
				out.List.Items[i] = normalizeRichText(item)
			}
		}
	}
	if input.Answer != nil {
		out.Answer = &AnswerContent{
			Question: normalizeRichText(input.Answer.Question),
			Answer:   normalizeRichText(input.Answer.Answer),
		}
	}
	if input.Legal != nil {
		out.Legal = &LegalContent{Text: normalizeRichText(input.Legal.Text)}
	}
	if input.Action != nil {
		out.Action = &ActionContent{
			ActionID:              ActionID(normalizeReference(string(input.Action.ActionID))),
			Label:                 normalizeNaturalText(input.Action.Label),
			CanonicalURL:          normalizeURL(input.Action.CanonicalURL),
			AccessibleDescription: normalizeNaturalText(input.Action.AccessibleDescription),
		}
	}
	if input.Image != nil {
		out.Image = &ImageContent{
			URL:    normalizeURL(input.Image.URL),
			Alt:    normalizeNaturalText(input.Image.Alt),
			Width:  input.Image.Width,
			Height: input.Image.Height,
		}
	}
	if input.DateTime != nil {
		value := normalizeDateTime(*input.DateTime)
		out.DateTime = &value
	}
	if input.Money != nil {
		value := normalizeMoney(*input.Money)
		out.Money = &value
	}
	if input.Deadline != nil {
		value := normalizeDateTime(*input.Deadline)
		out.Deadline = &value
	}
	if input.Offer != nil {
		out.Offer = &OfferContent{
			Description: normalizeRichText(input.Offer.Description),
			Code:        normalizeNaturalText(input.Offer.Code),
			Terms:       normalizeRichText(input.Offer.Terms),
			// Canonical form is lowercase: the reference is a UUID, and two
			// spellings of the same UUID must not read as two offers.
			CanonicalOfferID: strings.ToLower(normalizeReference(input.Offer.CanonicalOfferID)),
		}
		if input.Offer.AvailabilityStarts != nil {
			value := normalizeDateTime(*input.Offer.AvailabilityStarts)
			out.Offer.AvailabilityStarts = &value
		}
		if input.Offer.AvailabilityEnds != nil {
			value := normalizeDateTime(*input.Offer.AvailabilityEnds)
			out.Offer.AvailabilityEnds = &value
		}
	}
	if input.Location != nil {
		out.Location = &LocationContent{
			Name: normalizeNaturalText(input.Location.Name),
			Address: PostalAddress{
				StreetAddress:   normalizeNaturalText(input.Location.Address.StreetAddress),
				AddressLocality: normalizeNaturalText(input.Location.Address.AddressLocality),
				AddressRegion:   normalizeNaturalText(input.Location.Address.AddressRegion),
				PostalCode:      normalizeNaturalText(input.Location.Address.PostalCode),
				AddressCountry:  strings.ToUpper(normalizeReference(input.Location.Address.AddressCountry)),
			},
		}
	}
	if input.Product != nil {
		out.Product = &ProductContent{
			Name:         normalizeNaturalText(input.Product.Name),
			SKU:          normalizeReference(input.Product.SKU),
			CanonicalURL: normalizeURL(input.Product.CanonicalURL),
			ImageURL:     normalizeURL(input.Product.ImageURL),
		}
	}
	if input.Fact != nil {
		out.Fact = &FactContent{
			Label: normalizeNaturalText(input.Fact.Label),
			Value: normalizeNaturalText(input.Fact.Value),
		}
	}
	if input.Personalization != nil {
		out.Personalization = &PersonalizationContent{
			Label: normalizeNaturalText(input.Personalization.Label),
			Slot:  normalizeSlot(input.Personalization.Slot),
		}
	}
	if input.StructuredData != nil {
		value := normalizeStructuredData(*input.StructuredData)
		out.StructuredData = &value
	}
	if input.Divider != nil {
		out.Divider = &DividerContent{}
	}
	if input.Poll != nil {
		out.Poll = &PollContent{
			PollID:   normalizeReference(input.Poll.PollID),
			Question: normalizeRichText(input.Poll.Question),
		}
		if input.Poll.Options != nil {
			out.Poll.Options = make([]PollOption, len(input.Poll.Options))
			for index, option := range input.Poll.Options {
				out.Poll.Options[index] = PollOption{
					OptionID: normalizeReference(option.OptionID),
					Label:    normalizeRichText(option.Label),
				}
			}
		}
	}
	return out
}

func normalizeRichText(input RichText) RichText {
	out := RichText{}
	if input.Runs == nil {
		return out
	}
	out.Runs = make([]InlineRun, len(input.Runs))
	for i, run := range input.Runs {
		out.Runs[i] = InlineRun{
			Kind:            InlineKind(normalizeEnum(string(run.Kind))),
			Text:            normalizeInlineText(run.Text),
			URL:             normalizeURL(run.URL),
			AccessibleLabel: normalizeNaturalText(run.AccessibleLabel),
		}
		if run.Slot != nil {
			value := normalizeSlot(*run.Slot)
			out.Runs[i].Slot = &value
		}
	}
	return out
}

func normalizeSlot(input SlotReference) SlotReference {
	return SlotReference{
		ID:            SlotID(normalizeReference(string(input.ID))),
		SemanticClass: SlotSemanticClass(normalizeEnum(string(input.SemanticClass))),
		Required:      input.Required,
		Fallback:      normalizeNaturalText(input.Fallback),
	}
}

func normalizeDateTime(input DateTimeContent) DateTimeContent {
	out := DateTimeContent{
		DisplayValue: normalizeNaturalText(input.DisplayValue),
		RFC3339:      strings.TrimSpace(input.RFC3339),
		Timezone:     strings.TrimSpace(input.Timezone),
	}
	if value, err := time.Parse(time.RFC3339Nano, out.RFC3339); err == nil {
		out.RFC3339 = value.Format(time.RFC3339Nano)
	}
	return out
}

func normalizeMoney(input MoneyContent) MoneyContent {
	amount := strings.TrimSpace(input.Amount)
	if normalized, ok := normalizeDecimal(amount); ok {
		amount = normalized
	}
	return MoneyContent{
		DisplayValue: normalizeNaturalText(input.DisplayValue),
		Amount:       amount,
		Currency:     strings.ToUpper(strings.TrimSpace(input.Currency)),
	}
}

func normalizeStructuredData(input StructuredDataContent) StructuredDataContent {
	out := StructuredDataContent{
		Enabled:         input.Enabled,
		Provider:        Provider(normalizeEnum(string(input.Provider))),
		RegistryVersion: normalizeReference(input.RegistryVersion),
		UseCase:         StructuredDataUseCase(normalizeEnum(string(input.UseCase))),
		Kind:            StructuredDataKind(normalizeEnum(string(input.Kind))),
	}
	if input.Declaration.DiscountOffer != nil {
		out.Declaration.DiscountOffer = &DiscountOfferDeclaration{
			OfferNodeID: NodeID(normalizeReference(string(input.Declaration.DiscountOffer.OfferNodeID))),
		}
	}
	if input.Declaration.PromotionCard != nil {
		in := input.Declaration.PromotionCard
		out.Declaration.PromotionCard = &PromotionCardDeclaration{
			ImageNodeID:         NodeID(normalizeReference(string(in.ImageNodeID))),
			ActionNodeID:        NodeID(normalizeReference(string(in.ActionNodeID))),
			HeadlineNodeID:      NodeID(normalizeReference(string(in.HeadlineNodeID))),
			PriceNodeID:         NodeID(normalizeReference(string(in.PriceNodeID))),
			DiscountValueNodeID: NodeID(normalizeReference(string(in.DiscountValueNodeID))),
			Position:            in.Position,
		}
	}
	if input.Declaration.EventReservation != nil {
		in := input.Declaration.EventReservation
		out.Declaration.EventReservation = &EventReservationDeclaration{
			ReservationNumberNodeID: NodeID(normalizeReference(string(in.ReservationNumberNodeID))),
			UnderNameNodeID:         NodeID(normalizeReference(string(in.UnderNameNodeID))),
			EventNameNodeID:         NodeID(normalizeReference(string(in.EventNameNodeID))),
			StartDateTimeNodeID:     NodeID(normalizeReference(string(in.StartDateTimeNodeID))),
			LocationNodeID:          NodeID(normalizeReference(string(in.LocationNodeID))),
			StatusNodeID:            NodeID(normalizeReference(string(in.StatusNodeID))),
			Status:                  ReservationStatus(normalizeEnum(string(in.Status))),
			ActionNodeID:            NodeID(normalizeReference(string(in.ActionNodeID))),
		}
	}
	if input.Declaration.Order != nil {
		in := input.Declaration.Order
		order := &OrderDeclaration{
			MerchantNodeID:    NodeID(normalizeReference(string(in.MerchantNodeID))),
			OrderNumberNodeID: NodeID(normalizeReference(string(in.OrderNumberNodeID))),
			TotalNodeID:       NodeID(normalizeReference(string(in.TotalNodeID))),
			ActionNodeID:      NodeID(normalizeReference(string(in.ActionNodeID))),
		}
		if in.Items != nil {
			order.Items = make([]OrderItemRef, len(in.Items))
			for i, item := range in.Items {
				order.Items[i] = OrderItemRef{
					ProductNodeID:  NodeID(normalizeReference(string(item.ProductNodeID))),
					PriceNodeID:    NodeID(normalizeReference(string(item.PriceNodeID))),
					QuantityNodeID: NodeID(normalizeReference(string(item.QuantityNodeID))),
				}
			}
		}
		out.Declaration.Order = order
	}
	return out
}

func normalizeLanguage(input string) string {
	raw := strings.TrimSpace(input)
	if raw == "" || !languageTagSyntax.MatchString(raw) {
		return raw
	}
	tag, err := language.Parse(raw)
	if err != nil || languageBaseIsUnd(tag) {
		return raw
	}
	return tag.String()
}

func normalizeURL(input string) string {
	raw := strings.TrimSpace(input)
	if raw == "" || len(raw) > maxURLBytes {
		return raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return raw
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	return parsed.String()
}

func normalizeEnum(input string) string      { return strings.ToLower(strings.TrimSpace(input)) }
func normalizeReference(input string) string { return strings.TrimSpace(input) }

func normalizeNaturalText(input string) string {
	if !utf8.ValidString(input) {
		return input
	}
	return strings.Join(strings.FieldsFunc(norm.NFKC.String(input), unicode.IsSpace), " ")
}

// normalizeInlineText collapses each whitespace run but preserves whether the
// run began or ended with whitespace so adjacent semantic spans do not join.
func normalizeInlineText(input string) string {
	if !utf8.ValidString(input) {
		return input
	}
	input = norm.NFKC.String(input)
	if input == "" {
		return ""
	}
	leading := unicode.IsSpace([]rune(input)[0])
	runes := []rune(input)
	trailing := unicode.IsSpace(runes[len(runes)-1])
	middle := strings.Join(strings.FieldsFunc(input, unicode.IsSpace), " ")
	if middle == "" {
		return " "
	}
	if leading {
		middle = " " + middle
	}
	if trailing {
		middle += " "
	}
	return middle
}

func normalizeDecimal(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	negative := false
	if raw[0] == '-' {
		negative = true
		raw = raw[1:]
	}
	if raw == "" || raw[0] == '+' || strings.Count(raw, ".") > 1 {
		return "", false
	}
	parts := strings.SplitN(raw, ".", 2)
	if parts[0] == "" || !allASCIIDigits(parts[0]) {
		return "", false
	}
	fraction := ""
	if len(parts) == 2 {
		if parts[1] == "" || !allASCIIDigits(parts[1]) {
			return "", false
		}
		fraction = strings.TrimRight(parts[1], "0")
	}
	integer := strings.TrimLeft(parts[0], "0")
	if integer == "" {
		integer = "0"
	}
	result := integer
	if fraction != "" {
		result += "." + fraction
	}
	if negative && result != "0" {
		result = "-" + result
	}
	return result, true
}

func allASCIIDigits(value string) bool {
	for i := range len(value) {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

func languageBaseIsUnd(tag language.Tag) bool {
	base, _, _ := tag.Raw()
	return base.String() == "und"
}
