// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"fmt"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/currency"
	"golang.org/x/text/language"
)

const (
	maxNodes             = 512
	maxLocalizations     = 32
	maxConditionsPerNode = 32
	maxRuns              = 512
	maxListItems         = 100
	// A poll needs at least two options to be a question, and a cap so one node
	// cannot mint an unbounded number of per-recipient URLs at send time.
	minPollOptions      = 2
	maxPollOptions      = 10
	maxOrderItems       = 100
	maxTextRunes        = 16_384
	maxShortTextRunes   = 512
	maxURLBytes         = 4096
	maxReferenceBytes   = 128
	maxLanguageTagBytes = 255
	maxTimezoneBytes    = 255
	maxDecimalDigits    = 38
	maxDecimalScale     = 9
	maxImageDimension   = 16_384
)

var stableReferencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var canonicalOfferIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var languageTagSyntax = regexp.MustCompile(`^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$`)

var validDirections = set(DirectionLTR, DirectionRTL, DirectionAuto)
var validNodeTypes = set(
	NodeHeading, NodeParagraph, NodeList, NodeAnswer, NodeLegal, NodeAction,
	NodeImage, NodeDateTime, NodeMoney, NodeDeadline, NodeOffer, NodeLocation,
	NodeProduct, NodeFact, NodePersonalization, NodeStructuredData,
	NodeDivider, NodePoll,
)
var validSources = set(SourceUser, SourceTemplate, SourceGenerated, SourceMigration)
var validInlineKinds = set(InlineText, InlineStrong, InlineEmphasis, InlineLink, InlineSlot, InlineLineBreak)
var validSlotClasses = set(SlotName, SlotIdentifier, SlotText, SlotCode)
var validConditionOperators = set(ConditionPresent, ConditionAbsent, ConditionEquals, ConditionNotEquals)
var validReservationStatuses = set(ReservationConfirmed, ReservationPending, ReservationCancelled)

var rolesByType = map[NodeType]map[NodeRole]struct{}{
	NodeHeading:         set(RoleHeading),
	NodeParagraph:       set(RoleBody),
	NodeList:            set(RoleBody),
	NodeAnswer:          set(RoleAnswer),
	NodeLegal:           set(RoleLegal, RoleFooter),
	NodeAction:          set(RolePrimaryAction, RoleSecondaryAction, RoleUnsubscribe, RolePreferences, RoleViewInBrowser, RoleSocial, RoleContact),
	NodeImage:           set(RoleInformativeImage, RoleDecorativeImage),
	NodeDateTime:        set(RoleEventDateTime),
	NodeMoney:           set(RolePrice),
	NodeDeadline:        set(RoleDeadline),
	NodeOffer:           set(RoleOffer),
	NodeLocation:        set(RoleLocation),
	NodeProduct:         set(RoleProduct),
	NodeFact:            set(RoleProductFact),
	NodePersonalization: set(RolePersonalizationSlot),
	NodeStructuredData:  set(RoleStructuredData),
	NodeDivider:         set(RoleDivider),
	NodePoll:            set(RolePoll),
}

func set[T comparable](values ...T) map[T]struct{} {
	out := make(map[T]struct{}, len(values))
	for _, value := range values {
		out[value] = struct{}{}
	}
	return out
}

func validateNormalizedV2(document DocumentV2) Diagnostics {
	diagnostics := Diagnostics{}
	if document.SchemaVersion != SchemaVersionV2 {
		diagnostics.error("/schema_version", "", CodeUnsupportedSchemaVersion, "schema_version must be 2")
	}
	validateLanguage(&diagnostics, "/language", "", document.Language)
	if _, ok := validDirections[document.Direction]; !ok {
		diagnostics.error("/direction", "", CodeInvalidEnum, "direction must be ltr, rtl, or auto")
	}
	if len(document.Nodes) == 0 {
		diagnostics.error("/nodes", "", CodeRequired, "at least one semantic node is required")
	}
	if len(document.Nodes) > maxNodes {
		diagnostics.error("/nodes", "", CodeLimitExceeded, fmt.Sprintf("at most %d nodes are permitted", maxNodes))
	}

	validator := documentValidator{
		diagnostics:  &diagnostics,
		nodeByID:     make(map[NodeID]nodeLocation, len(document.Nodes)),
		actionByID:   make(map[ActionID]int),
		conditionIDs: make(map[ConditionID]string),
		pollIDs:      make(map[string]string),
	}
	for i, node := range document.Nodes {
		base := fmt.Sprintf("/nodes/%d", i)
		validator.validateNodeIdentity(base, i, node)
	}
	for i, node := range document.Nodes {
		validator.validateNode(fmt.Sprintf("/nodes/%d", i), i, node)
	}
	return diagnostics
}

type nodeLocation struct {
	index int
	node  Node
}

type documentValidator struct {
	diagnostics       *Diagnostics
	nodeByID          map[NodeID]nodeLocation
	actionByID        map[ActionID]int
	conditionIDs      map[ConditionID]string
	pollIDs           map[string]string
	primaryActionPath string
	lastHeadingLevel  int
	firstH1Path       string
}

func (v *documentValidator) validateNodeIdentity(base string, index int, node Node) {
	validateReference(v.diagnostics, base+"/id", node.ID, string(node.ID))
	if first, exists := v.nodeByID[node.ID]; node.ID != "" && exists {
		v.diagnostics.error(base+"/id", node.ID, CodeDuplicate, fmt.Sprintf("node id duplicates /nodes/%d/id", first.index))
	} else if node.ID != "" {
		v.nodeByID[node.ID] = nodeLocation{index: index, node: node}
	}
}

func (v *documentValidator) validateNode(base string, index int, node Node) {
	if _, ok := validNodeTypes[node.Type]; !ok {
		v.diagnostics.error(base+"/type", node.ID, CodeInvalidEnum, "type is not supported by semantic document v2")
	}
	if node.Version != NodeVersionV2 {
		v.diagnostics.error(base+"/version", node.ID, CodeUnsupportedNodeVersion, "node version must be 2")
	}
	if roles, known := rolesByType[node.Type]; known {
		if _, ok := roles[node.Role]; !ok {
			v.diagnostics.error(base+"/role", node.ID, CodeRoleTypeMismatch, "role is not valid for this node type")
		}
	} else if node.Role == "" {
		v.diagnostics.error(base+"/role", node.ID, CodeRequired, "role is required")
	}
	if _, ok := validSources[node.Provenance.Source]; !ok {
		v.diagnostics.error(base+"/provenance/source", node.ID, CodeInvalidEnum, "provenance source is not supported")
	}
	if node.Type == NodeHeading && node.Content.Heading != nil {
		level := node.Content.Heading.Level
		if level == 1 {
			if v.firstH1Path != "" {
				v.diagnostics.warning(base+"/content/heading/level", node.ID, CodeMultipleTopLevelHeadings, "document contains more than one level-one heading; first is "+v.firstH1Path)
			} else {
				v.firstH1Path = base + "/content/heading/level"
			}
		}
		if level > 1 && (v.lastHeadingLevel == 0 || level > v.lastHeadingLevel+1) {
			v.diagnostics.warning(base+"/content/heading/level", node.ID, CodeHeadingLevelSkipped, "heading hierarchy skips a level")
		}
		if level >= 1 && level <= 6 {
			v.lastHeadingLevel = level
		}
	}
	if node.Type == NodeAction && node.Role == RolePrimaryAction && len(node.Conditions) == 0 {
		path := base + "/role"
		if v.primaryActionPath != "" {
			v.diagnostics.error(path, node.ID, CodeMultiplePrimaryActions, "semantic document has another primary action at "+v.primaryActionPath)
		} else {
			v.primaryActionPath = path
		}
	}
	if node.Provenance.SourceID != "" {
		validateReference(v.diagnostics, base+"/provenance/source_id", node.ID, node.Provenance.SourceID)
	}
	if len(node.Conditions) > maxConditionsPerNode {
		v.diagnostics.error(base+"/conditions", node.ID, CodeLimitExceeded, fmt.Sprintf("at most %d conditions are permitted per node", maxConditionsPerNode))
	}
	for i, condition := range node.Conditions {
		v.validateCondition(fmt.Sprintf("%s/conditions/%d", base, i), node.ID, condition)
	}
	v.validateContent(base+"/content", node, node.Content)
	if node.Type == NodePoll && node.Content.Poll != nil {
		pollID := node.Content.Poll.PollID
		if firstPath, exists := v.pollIDs[pollID]; pollID != "" && exists {
			v.diagnostics.error(base+"/content/poll/poll_id", node.ID, CodeDuplicate,
				"poll id duplicates "+firstPath)
		} else if pollID != "" {
			v.pollIDs[pollID] = base + "/content/poll/poll_id"
		}
	}

	if len(node.Localizations) > maxLocalizations {
		v.diagnostics.error(base+"/localizations", node.ID, CodeLimitExceeded, fmt.Sprintf("at most %d localizations are permitted per node", maxLocalizations))
	}
	locales := make([]string, 0, len(node.Localizations))
	for locale := range node.Localizations {
		locales = append(locales, locale)
	}
	sort.Strings(locales)
	for _, locale := range locales {
		pathLocale := escapeJSONPointer(locale)
		validateLanguage(v.diagnostics, base+"/localizations/"+pathLocale, node.ID, locale)
		v.validateContent(base+"/localizations/"+pathLocale, node, node.Localizations[locale])
		v.validateLocalizedIdentity(base+"/localizations/"+pathLocale, node, node.Localizations[locale])
	}

	if node.Type == NodeStructuredData && node.Content.StructuredData != nil {
		v.validateStructuredReferences(base+"/content/structured_data", node.ID, *node.Content.StructuredData)
	}
	_ = index
}

func (v *documentValidator) validateLocalizedPollIdentity(path string, node Node, base, localized *PollContent) {
	if localized.PollID != base.PollID {
		v.diagnostics.error(path+"/poll_id", node.ID, CodeInvalidStableReference,
			"localized poll id must match the base poll id")
	}
	if len(localized.Options) != len(base.Options) {
		v.diagnostics.error(path+"/options", node.ID, CodeContentTypeMismatch,
			"localized poll must preserve the base option identity set")
		return
	}
	for index := range base.Options {
		if localized.Options[index].OptionID != base.Options[index].OptionID {
			v.diagnostics.error(fmt.Sprintf("%s/options/%d/option_id", path, index), node.ID,
				CodeInvalidStableReference,
				"localized poll options must preserve base option ids and order")
		}
	}
}

// validateLocalizedIdentity states one rule once: a localization may translate
// WORDS, and may never change IDENTITY.
//
// Localizations override Content wholesale, and several Content members carry
// identity alongside their words — a poll's option ids, an offer's canonical
// entity, an action's action id, a product's SKU. A localization that changes
// one of those is not a translation; it silently substitutes a different thing
// for one audience, and every tally, entity resolution, click attribution or
// catalogue lookup downstream becomes locale-dependent with nothing anywhere
// saying so.
//
// VALUES are deliberately NOT pinned. A localized action may point at a
// localized landing page, a localized price may be a different amount in a
// different currency, and localized terms may read completely differently.
// Those are real translations. Only identity is fixed.
func (v *documentValidator) validateLocalizedIdentity(path string, node Node, localized NodeContent) {
	switch node.Type {
	case NodePoll:
		if node.Content.Poll != nil && localized.Poll != nil {
			v.validateLocalizedPollIdentity(path+"/poll", node, node.Content.Poll, localized.Poll)
		}
	case NodeOffer:
		if node.Content.Offer != nil && localized.Offer != nil &&
			localized.Offer.CanonicalOfferID != node.Content.Offer.CanonicalOfferID {
			v.diagnostics.error(path+"/offer/canonical_offer_id", node.ID, CodeInvalidCanonicalOfferReference,
				"a localization may translate an offer's words but must name the same canonical offer entity as the base content")
		}
	case NodeAction:
		if node.Content.Action != nil && localized.Action != nil &&
			localized.Action.ActionID != node.Content.Action.ActionID {
			v.diagnostics.error(path+"/action/action_id", node.ID, CodeInvalidStableReference,
				"a localization may translate an action's label and destination but must keep the base action id; a locale-dependent action id makes click attribution locale-dependent")
		}
	case NodeProduct:
		if node.Content.Product != nil && localized.Product != nil &&
			localized.Product.SKU != node.Content.Product.SKU {
			v.diagnostics.error(path+"/product/sku", node.ID, CodeInvalidStableReference,
				"a localization may translate a product's name but must keep the base SKU; a locale-dependent SKU names a different product")
		}
	case NodePersonalization:
		// The most consequential member of this rule, and the one it was missing.
		//
		// The compiler resolves the LOCALIZED slot (selectLocalizedContent
		// returns the localization, and resolveContent then resolves
		// content.Personalization.Slot from it), so a localization that
		// re-points slot.id makes the same node substitute a DIFFERENT
		// SUBSCRIBER ATTRIBUTE per locale.
		//
		// The four rules above protect identity: a locale-dependent action id
		// misattributes a click, a locale-dependent SKU names another product.
		// This one protects PERSONAL DATA. A base slot of first_name and a
		// localized slot of, say, an internal note or a phone number would send
		// different recipients different fields of their own record, decided by
		// which language they read — with nothing in the rendered message to show
		// it happened.
		if node.Content.Personalization != nil && localized.Personalization != nil &&
			localized.Personalization.Slot.ID != node.Content.Personalization.Slot.ID {
			v.diagnostics.error(path+"/personalization/slot/id", node.ID, CodeInvalidStableReference,
				"a localization may translate a personalization's label but must name the same slot as the base content; a locale-dependent slot id substitutes a different subscriber attribute per locale")
		}
	}
}

func (v *documentValidator) validateCondition(path string, nodeID NodeID, condition Condition) {
	validateReference(v.diagnostics, path+"/id", nodeID, string(condition.ID))
	if firstPath, exists := v.conditionIDs[condition.ID]; condition.ID != "" && exists {
		v.diagnostics.error(path+"/id", nodeID, CodeDuplicate, "condition id duplicates "+firstPath)
	} else if condition.ID != "" {
		v.conditionIDs[condition.ID] = path + "/id"
	}
	validateReference(v.diagnostics, path+"/slot_id", nodeID, string(condition.SlotID))
	if _, ok := validConditionOperators[condition.Operator]; !ok {
		v.diagnostics.error(path+"/operator", nodeID, CodeInvalidEnum, "condition operator is not supported")
	}
	switch condition.Operator {
	case ConditionPresent, ConditionAbsent:
		if condition.Value != "" {
			v.diagnostics.error(path+"/value", nodeID, CodeConditionValueForbidden, "present and absent conditions must not declare value")
		}
	case ConditionEquals, ConditionNotEquals:
		if condition.Value == "" {
			v.diagnostics.error(path+"/value", nodeID, CodeConditionValueRequired, "equality conditions require value")
		} else {
			validateText(v.diagnostics, path+"/value", nodeID, condition.Value, maxShortTextRunes, true)
		}
	}
}

func (v *documentValidator) validateContent(path string, node Node, content NodeContent) {
	count, actual := contentCardinality(content)
	if count != 1 {
		v.diagnostics.error(path, node.ID, CodeContentCardinality, "exactly one typed content member is required")
		return
	}
	if actual != node.Type {
		v.diagnostics.error(path, node.ID, CodeContentTypeMismatch, fmt.Sprintf("content %q does not match node type %q", actual, node.Type))
		return
	}

	switch node.Type {
	case NodeHeading:
		if content.Heading.Level < 1 || content.Heading.Level > 6 {
			v.diagnostics.error(path+"/heading/level", node.ID, CodeNumberOutOfRange, "heading level must be between 1 and 6")
		}
		v.validateRichText(path+"/heading/text", node.ID, content.Heading.Text, true)
	case NodeParagraph:
		v.validateRichText(path+"/paragraph/text", node.ID, content.Paragraph.Text, true)
	case NodeList:
		if len(content.List.Items) == 0 {
			v.diagnostics.error(path+"/list/items", node.ID, CodeRequired, "list requires at least one item")
		}
		if len(content.List.Items) > maxListItems {
			v.diagnostics.error(path+"/list/items", node.ID, CodeLimitExceeded, fmt.Sprintf("list permits at most %d items", maxListItems))
		}
		for i, item := range content.List.Items {
			v.validateRichText(fmt.Sprintf("%s/list/items/%d", path, i), node.ID, item, true)
		}
	case NodeAnswer:
		v.validateRichText(path+"/answer/question", node.ID, content.Answer.Question, true)
		v.validateRichText(path+"/answer/answer", node.ID, content.Answer.Answer, true)
	case NodeLegal:
		v.validateRichText(path+"/legal/text", node.ID, content.Legal.Text, true)
	case NodeAction:
		v.validateAction(path+"/action", node.ID, content.Action)
	case NodeImage:
		v.validateImage(path+"/image", node, content.Image)
	case NodeDateTime:
		validateDateTime(v.diagnostics, path+"/datetime", node.ID, *content.DateTime)
	case NodeMoney:
		validateMoney(v.diagnostics, path+"/money", node.ID, *content.Money)
	case NodeDeadline:
		validateDateTime(v.diagnostics, path+"/deadline", node.ID, *content.Deadline)
	case NodeOffer:
		v.validateOffer(path+"/offer", node.ID, content.Offer)
	case NodeLocation:
		v.validateLocation(path+"/location", node.ID, content.Location)
	case NodeProduct:
		v.validateProduct(path+"/product", node.ID, content.Product)
	case NodeFact:
		validateRequiredText(v.diagnostics, path+"/fact/label", node.ID, content.Fact.Label, maxShortTextRunes)
		validateRequiredText(v.diagnostics, path+"/fact/value", node.ID, content.Fact.Value, maxTextRunes)
	case NodePersonalization:
		if content.Personalization.Label != "" {
			validateText(v.diagnostics, path+"/personalization/label", node.ID, content.Personalization.Label, maxShortTextRunes, false)
		}
		v.validateSlot(path+"/personalization/slot", node.ID, content.Personalization.Slot)
	case NodeStructuredData:
		v.validateStructured(path+"/structured_data", node.ID, content.StructuredData)
	case NodeDivider:
		// Nothing to validate. Presence of the (empty) content member is the
		// whole of a divider, and contentCardinality above has already proved it.
	case NodePoll:
		v.validatePoll(path+"/poll", node.ID, content.Poll)
	}
}

func contentCardinality(content NodeContent) (int, NodeType) {
	count := 0
	actual := NodeType("")
	entries := []struct {
		present bool
		typeID  NodeType
	}{
		{content.Heading != nil, NodeHeading}, {content.Paragraph != nil, NodeParagraph},
		{content.List != nil, NodeList}, {content.Answer != nil, NodeAnswer},
		{content.Legal != nil, NodeLegal}, {content.Action != nil, NodeAction},
		{content.Image != nil, NodeImage}, {content.DateTime != nil, NodeDateTime},
		{content.Money != nil, NodeMoney}, {content.Deadline != nil, NodeDeadline},
		{content.Offer != nil, NodeOffer}, {content.Location != nil, NodeLocation},
		{content.Product != nil, NodeProduct}, {content.Fact != nil, NodeFact},
		{content.Personalization != nil, NodePersonalization}, {content.StructuredData != nil, NodeStructuredData},
		{content.Divider != nil, NodeDivider}, {content.Poll != nil, NodePoll},
	}
	for _, entry := range entries {
		if entry.present {
			count++
			actual = entry.typeID
		}
	}
	return count, actual
}

func (v *documentValidator) validateRichText(path string, nodeID NodeID, rich RichText, required bool) {
	if required && len(rich.Runs) == 0 {
		v.diagnostics.error(path+"/runs", nodeID, CodeRequired, "at least one inline run is required")
	}
	if len(rich.Runs) > maxRuns {
		v.diagnostics.error(path+"/runs", nodeID, CodeLimitExceeded, fmt.Sprintf("rich text permits at most %d runs", maxRuns))
	}
	for i, run := range rich.Runs {
		base := fmt.Sprintf("%s/runs/%d", path, i)
		if _, ok := validInlineKinds[run.Kind]; !ok {
			v.diagnostics.error(base+"/kind", nodeID, CodeInvalidEnum, "inline kind is not supported")
		}
		textPresent := run.Text != ""
		urlPresent := run.URL != ""
		labelPresent := run.AccessibleLabel != ""
		slotPresent := run.Slot != nil
		switch run.Kind {
		case InlineText, InlineStrong, InlineEmphasis:
			if !textPresent || urlPresent || labelPresent || slotPresent {
				v.diagnostics.error(base, nodeID, CodeInlineCardinality, "text, strong, and emphasis runs require only text")
			}
			validateRequiredText(v.diagnostics, base+"/text", nodeID, run.Text, maxTextRunes)
		case InlineLink:
			if !textPresent || !urlPresent || slotPresent {
				v.diagnostics.error(base, nodeID, CodeInlineCardinality, "link runs require text and URL, and must not contain a slot")
			}
			validateRequiredText(v.diagnostics, base+"/text", nodeID, run.Text, maxTextRunes)
			validateHTTPURL(v.diagnostics, base+"/url", nodeID, run.URL, false)
			if labelPresent {
				validateText(v.diagnostics, base+"/accessible_label", nodeID, run.AccessibleLabel, maxShortTextRunes, false)
			}
		case InlineSlot:
			if textPresent || urlPresent || labelPresent || !slotPresent {
				v.diagnostics.error(base, nodeID, CodeInlineCardinality, "slot runs require only a slot declaration")
			}
			if run.Slot != nil {
				v.validateSlot(base+"/slot", nodeID, *run.Slot)
			}
		case InlineLineBreak:
			if textPresent || urlPresent || labelPresent || slotPresent {
				v.diagnostics.error(base, nodeID, CodeInlineCardinality, "line_break runs must not contain payload fields")
			}
		}
	}
}

func (v *documentValidator) validateSlot(path string, nodeID NodeID, slot SlotReference) {
	validateReference(v.diagnostics, path+"/id", nodeID, string(slot.ID))
	if _, ok := validSlotClasses[slot.SemanticClass]; !ok {
		v.diagnostics.error(path+"/semantic_class", nodeID, CodeInvalidEnum, "slot semantic class is not supported")
	}
	if slot.Fallback != "" {
		validateText(v.diagnostics, path+"/fallback", nodeID, slot.Fallback, maxTextRunes, false)
	}
}

func (v *documentValidator) validateAction(path string, nodeID NodeID, action *ActionContent) {
	validateReference(v.diagnostics, path+"/action_id", nodeID, string(action.ActionID))
	currentIndex := -1
	if location, ok := v.nodeByID[nodeID]; ok {
		currentIndex = location.index
	}
	if first, exists := v.actionByID[action.ActionID]; action.ActionID != "" && exists {
		if first != currentIndex {
			v.diagnostics.error(path+"/action_id", nodeID, CodeDuplicate, fmt.Sprintf("action id duplicates /nodes/%d/content/action/action_id", first))
		}
	} else if action.ActionID != "" {
		v.actionByID[action.ActionID] = currentIndex
	}
	validateRequiredText(v.diagnostics, path+"/label", nodeID, action.Label, maxShortTextRunes)
	validateHTTPURL(v.diagnostics, path+"/canonical_url", nodeID, action.CanonicalURL, false)
	if action.AccessibleDescription != "" {
		validateText(v.diagnostics, path+"/accessible_description", nodeID, action.AccessibleDescription, maxShortTextRunes, false)
	}
}

func (v *documentValidator) validateImage(path string, node Node, image *ImageContent) {
	validateHTTPURL(v.diagnostics, path+"/url", node.ID, image.URL, true)
	if (image.Width == 0) != (image.Height == 0) {
		v.diagnostics.error(path, node.ID, CodeImageDimensionsIncomplete, "width and height must be provided together")
	}
	if image.Width < 0 || image.Height < 0 || image.Width > maxImageDimension || image.Height > maxImageDimension {
		v.diagnostics.error(path, node.ID, CodeNumberOutOfRange, fmt.Sprintf("image dimensions must be between 1 and %d when present", maxImageDimension))
	}
	if node.Role == RoleInformativeImage {
		validateRequiredText(v.diagnostics, path+"/alt", node.ID, image.Alt, maxShortTextRunes)
	}
	if node.Role == RoleDecorativeImage && image.Alt != "" {
		v.diagnostics.error(path+"/alt", node.ID, CodeDecorativeAltForbidden, "decorative images must use empty alt text")
	}
}

func (v *documentValidator) validateOffer(path string, nodeID NodeID, offer *OfferContent) {
	v.validateRichText(path+"/description", nodeID, offer.Description, true)
	if offer.CanonicalOfferID != "" && !canonicalOfferIDPattern.MatchString(offer.CanonicalOfferID) {
		// A canonical, lowercase UUID and nothing else. The bridge is only
		// useful if it resolves; a reference that does not name a real entity
		// shape is a claim that cannot be checked.
		v.diagnostics.error(path+"/canonical_offer_id", nodeID, CodeInvalidCanonicalOfferReference,
			"canonical_offer_id must be a canonical lowercase UUID naming the offer entity")
	}
	if offer.Code != "" {
		validateText(v.diagnostics, path+"/code", nodeID, offer.Code, maxShortTextRunes, false)
	}
	if len(offer.Terms.Runs) != 0 {
		v.validateRichText(path+"/terms", nodeID, offer.Terms, false)
	}
	if offer.AvailabilityStarts != nil {
		validateDateTime(v.diagnostics, path+"/availability_starts", nodeID, *offer.AvailabilityStarts)
	}
	if offer.AvailabilityEnds != nil {
		validateDateTime(v.diagnostics, path+"/availability_ends", nodeID, *offer.AvailabilityEnds)
	}
	if offer.AvailabilityStarts != nil && offer.AvailabilityEnds != nil {
		start, startErr := time.Parse(time.RFC3339Nano, offer.AvailabilityStarts.RFC3339)
		end, endErr := time.Parse(time.RFC3339Nano, offer.AvailabilityEnds.RFC3339)
		if startErr == nil && endErr == nil && !end.After(start) {
			v.diagnostics.error(path+"/availability_ends/rfc3339", nodeID, CodeNumberOutOfRange, "offer availability end must be after start")
		}
	}
}

func (v *documentValidator) validateLocation(path string, nodeID NodeID, location *LocationContent) {
	validateRequiredText(v.diagnostics, path+"/name", nodeID, location.Name, maxShortTextRunes)
	validateRequiredText(v.diagnostics, path+"/address/street_address", nodeID, location.Address.StreetAddress, maxTextRunes)
	validateRequiredText(v.diagnostics, path+"/address/address_locality", nodeID, location.Address.AddressLocality, maxShortTextRunes)
	if location.Address.AddressRegion != "" {
		validateText(v.diagnostics, path+"/address/address_region", nodeID, location.Address.AddressRegion, maxShortTextRunes, false)
	}
	if location.Address.PostalCode != "" {
		validateText(v.diagnostics, path+"/address/postal_code", nodeID, location.Address.PostalCode, maxShortTextRunes, false)
	}
	country := location.Address.AddressCountry
	if len(country) != 2 {
		v.diagnostics.error(path+"/address/address_country", nodeID, CodeInvalidCountry, "address_country must be an uppercase ISO 3166-1 alpha-2 code")
	} else if region, err := language.ParseRegion(country); err != nil || region.String() != country || country == "ZZ" {
		v.diagnostics.error(path+"/address/address_country", nodeID, CodeInvalidCountry, "address_country must be an uppercase ISO 3166-1 alpha-2 code")
	}
}

func (v *documentValidator) validateProduct(path string, nodeID NodeID, product *ProductContent) {
	validateRequiredText(v.diagnostics, path+"/name", nodeID, product.Name, maxShortTextRunes)
	if product.SKU != "" {
		validateText(v.diagnostics, path+"/sku", nodeID, product.SKU, maxShortTextRunes, false)
	}
	if product.CanonicalURL != "" {
		validateHTTPURL(v.diagnostics, path+"/canonical_url", nodeID, product.CanonicalURL, false)
	}
	if product.ImageURL != "" {
		validateHTTPURL(v.diagnostics, path+"/image_url", nodeID, product.ImageURL, true)
	}
}

func (v *documentValidator) validateStructured(path string, nodeID NodeID, structured *StructuredDataContent) {
	if structured.Provider != ProviderGmail {
		v.diagnostics.error(path+"/provider", nodeID, CodeInvalidEnum, "only the pinned Gmail registry is supported")
	}
	if structured.RegistryVersion != GmailRegistryVersion {
		v.diagnostics.error(path+"/registry_version", nodeID, CodeRegistryVersionUnsupported, "registry version is not supported by this compiler")
	}
	validUseCase := structured.UseCase == UseCaseGmailPromotion || structured.UseCase == UseCaseGmailTransaction
	if !validUseCase {
		v.diagnostics.error(path+"/use_case", nodeID, CodeInvalidEnum, "structured-data use case is not supported")
	}
	declarationCount, actualKind := structuredDeclarationCardinality(structured.Declaration)
	if declarationCount != 1 {
		v.diagnostics.error(path+"/declaration", nodeID, CodeContentCardinality, "exactly one structured declaration is required")
		return
	}
	if actualKind != structured.Kind {
		v.diagnostics.error(path+"/declaration", nodeID, CodeStructuredKindMismatch, "declaration does not match structured-data kind")
	}
	// Derived from the provider registry rather than restated here. This rule
	// and structuredregistry's surface mapping are the same fact — which type
	// belongs to which Gmail surface — and writing it twice lets the authoring
	// validator and the artifact validator drift apart.
	expectedUseCase, known := expectedUseCaseForKind(structured.Kind)
	if !known {
		v.diagnostics.error(path+"/use_case", nodeID, CodeStructuredKindMismatch,
			"structured-data kind has no registered provider surface")
		return
	}
	if structured.UseCase != expectedUseCase {
		v.diagnostics.error(path+"/use_case", nodeID, CodeStructuredKindMismatch, "structured-data kind is not valid for this use case")
	}
}

func structuredDeclarationCardinality(declaration StructuredDeclaration) (int, StructuredDataKind) {
	count := 0
	actual := StructuredDataKind("")
	entries := []struct {
		present bool
		kind    StructuredDataKind
	}{
		{declaration.DiscountOffer != nil, StructuredDiscountOffer},
		{declaration.PromotionCard != nil, StructuredPromotionCard},
		{declaration.EventReservation != nil, StructuredEventReservation},
		{declaration.Order != nil, StructuredOrder},
	}
	for _, entry := range entries {
		if entry.present {
			count++
			actual = entry.kind
		}
	}
	return count, actual
}

func (v *documentValidator) validateStructuredReferences(path string, nodeID NodeID, structured StructuredDataContent) {
	switch structured.Kind {
	case StructuredDiscountOffer:
		if structured.Declaration.DiscountOffer != nil {
			v.validateNodeReference(path+"/declaration/discount_offer/offer_node_id", nodeID, structured.Declaration.DiscountOffer.OfferNodeID, set(NodeOffer), true)
		}
	case StructuredPromotionCard:
		if declaration := structured.Declaration.PromotionCard; declaration != nil {
			v.validateNodeReference(path+"/declaration/promotion_card/image_node_id", nodeID, declaration.ImageNodeID, set(NodeImage), true)
			v.validateNodeReference(path+"/declaration/promotion_card/action_node_id", nodeID, declaration.ActionNodeID, set(NodeAction), true)
			v.validateNodeReference(path+"/declaration/promotion_card/headline_node_id", nodeID, declaration.HeadlineNodeID, set(NodeHeading, NodeParagraph, NodeFact, NodeProduct), false)
			v.validateNodeReference(path+"/declaration/promotion_card/price_node_id", nodeID, declaration.PriceNodeID, set(NodeMoney), false)
			v.validateNodeReference(path+"/declaration/promotion_card/discount_value_node_id", nodeID, declaration.DiscountValueNodeID, set(NodeMoney), false)
			if declaration.Position < 0 || declaration.Position > 10 {
				v.diagnostics.error(path+"/declaration/promotion_card/position", nodeID, CodeNumberOutOfRange, "promotion card position must be between 0 and 10")
			}
			if location, ok := v.nodeByID[declaration.ImageNodeID]; ok && location.node.Content.Image != nil {
				image := location.node.Content.Image
				if image.Width <= 0 || image.Height <= 0 {
					v.diagnostics.error(path+"/declaration/promotion_card/image_node_id", nodeID, CodeImageDimensionsIncomplete, "promotion cards require known image dimensions")
				} else if !supportedPromotionAspectRatio(image.Width, image.Height) {
					v.diagnostics.error(path+"/declaration/promotion_card/image_node_id", nodeID, CodeNumberOutOfRange, "promotion card image ratio must be 4:5, 1:1, or 1.91:1")
				}
			}
		}
	case StructuredEventReservation:
		if declaration := structured.Declaration.EventReservation; declaration != nil {
			v.validateNodeReference(path+"/declaration/event_reservation/reservation_number_node_id", nodeID, declaration.ReservationNumberNodeID, set(NodeFact, NodePersonalization), true)
			v.validateNodeReference(path+"/declaration/event_reservation/under_name_node_id", nodeID, declaration.UnderNameNodeID, set(NodeFact, NodePersonalization), true)
			v.validateNodeReference(path+"/declaration/event_reservation/event_name_node_id", nodeID, declaration.EventNameNodeID, set(NodeHeading, NodeFact, NodeProduct), true)
			v.validateNodeReference(path+"/declaration/event_reservation/start_datetime_node_id", nodeID, declaration.StartDateTimeNodeID, set(NodeDateTime), true)
			v.validateNodeReference(path+"/declaration/event_reservation/location_node_id", nodeID, declaration.LocationNodeID, set(NodeLocation), true)
			v.validateNodeReference(path+"/declaration/event_reservation/status_node_id", nodeID, declaration.StatusNodeID, set(NodeFact), true)
			v.validateNodeReference(path+"/declaration/event_reservation/action_node_id", nodeID, declaration.ActionNodeID, set(NodeAction), false)
			if _, ok := validReservationStatuses[declaration.Status]; !ok {
				v.diagnostics.error(path+"/declaration/event_reservation/status", nodeID, CodeInvalidEnum, "reservation status is not supported")
			}
			if location, ok := v.nodeByID[declaration.StatusNodeID]; ok && location.node.Content.Fact != nil && !strings.EqualFold(location.node.Content.Fact.Value, string(declaration.Status)) {
				v.diagnostics.error(path+"/declaration/event_reservation/status_node_id", nodeID, CodeStructuredKindMismatch, "visible reservation status fact must match the typed schema status")
			}
		}
	case StructuredOrder:
		if declaration := structured.Declaration.Order; declaration != nil {
			v.validateNodeReference(path+"/declaration/order/merchant_node_id", nodeID, declaration.MerchantNodeID, set(NodeFact, NodeProduct), true)
			v.validateNodeReference(path+"/declaration/order/order_number_node_id", nodeID, declaration.OrderNumberNodeID, set(NodeFact, NodePersonalization), true)
			v.validateNodeReference(path+"/declaration/order/total_node_id", nodeID, declaration.TotalNodeID, set(NodeMoney), true)
			v.validateNodeReference(path+"/declaration/order/action_node_id", nodeID, declaration.ActionNodeID, set(NodeAction), false)
			if len(declaration.Items) == 0 {
				v.diagnostics.error(path+"/declaration/order/items", nodeID, CodeRequired, "order requires at least one accepted item")
			}
			if len(declaration.Items) > maxOrderItems {
				v.diagnostics.error(path+"/declaration/order/items", nodeID, CodeLimitExceeded, fmt.Sprintf("order permits at most %d items", maxOrderItems))
			}
			for i, item := range declaration.Items {
				base := fmt.Sprintf("%s/declaration/order/items/%d", path, i)
				v.validateNodeReference(base+"/product_node_id", nodeID, item.ProductNodeID, set(NodeProduct), true)
				v.validateNodeReference(base+"/price_node_id", nodeID, item.PriceNodeID, set(NodeMoney), true)
				v.validateNodeReference(base+"/quantity_node_id", nodeID, item.QuantityNodeID, set(NodeFact), true)
				if location, ok := v.nodeByID[item.QuantityNodeID]; ok && location.node.Content.Fact != nil {
					value := location.node.Content.Fact.Value
					if canonical, valid := normalizeDecimal(value); !valid || canonical != value {
						v.diagnostics.error(base+"/quantity_node_id", nodeID, CodeInvalidDecimal, "referenced quantity fact must be a canonical decimal")
					} else if quantity, _ := new(big.Rat).SetString(value); quantity.Sign() <= 0 {
						v.diagnostics.error(base+"/quantity_node_id", nodeID, CodeNumberOutOfRange, "referenced quantity must be greater than zero")
					}
				}
			}
		}
	}
}

func (v *documentValidator) validateNodeReference(path string, ownerID, targetID NodeID, allowed map[NodeType]struct{}, required bool) {
	if targetID == "" {
		if required {
			v.diagnostics.error(path, ownerID, CodeRequired, "node reference is required")
		}
		return
	}
	validateReference(v.diagnostics, path, ownerID, string(targetID))
	location, ok := v.nodeByID[targetID]
	if !ok {
		v.diagnostics.error(path, ownerID, CodeNodeReferenceMissing, "referenced semantic node does not exist")
		return
	}
	if _, ok := allowed[location.node.Type]; !ok {
		v.diagnostics.error(path, ownerID, CodeNodeReferenceTypeMismatch, fmt.Sprintf("referenced node type %q is not permitted here", location.node.Type))
		return
	}
	if location.node.Type == NodeAction && location.node.Content.Action != nil {
		parsed, _ := url.Parse(location.node.Content.Action.CanonicalURL)
		if parsed == nil || parsed.Scheme != "https" {
			v.diagnostics.error(path, ownerID, CodeHTTPSRequired, "structured-data action references require an HTTPS canonical URL")
		}
	}
}

func supportedPromotionAspectRatio(width, height int) bool {
	if width <= 0 || height <= 0 {
		return false
	}
	ratio := float64(width) / float64(height)
	for _, supported := range []float64{0.8, 1, 1.91} {
		if math.Abs(ratio-supported) <= 0.015 {
			return true
		}
	}
	return false
}

func validateDateTime(diagnostics *Diagnostics, path string, nodeID NodeID, value DateTimeContent) {
	validateRequiredText(diagnostics, path+"/display_value", nodeID, value.DisplayValue, maxShortTextRunes)
	if value.RFC3339 == "" {
		diagnostics.error(path+"/rfc3339", nodeID, CodeRequired, "rfc3339 is required")
	}
	parsed, parseErr := time.Parse(time.RFC3339Nano, value.RFC3339)
	if value.RFC3339 != "" && parseErr != nil {
		diagnostics.error(path+"/rfc3339", nodeID, CodeInvalidDateTime, "rfc3339 must be a timestamp with an explicit numeric offset")
	}
	if value.Timezone == "" {
		diagnostics.error(path+"/timezone", nodeID, CodeRequired, "timezone is required")
		return
	}
	if value.Timezone == "Local" || len(value.Timezone) > maxTimezoneBytes {
		diagnostics.error(path+"/timezone", nodeID, CodeTimezoneUnknown, "timezone must be an environment-independent IANA zone")
		return
	}
	location, err := time.LoadLocation(value.Timezone)
	if err != nil {
		diagnostics.error(path+"/timezone", nodeID, CodeTimezoneUnknown, "timezone is not a recognized IANA zone")
		return
	}
	if parseErr == nil {
		_, encodedOffset := parsed.Zone()
		_, zoneOffset := parsed.In(location).Zone()
		if encodedOffset != zoneOffset {
			diagnostics.error(path+"/rfc3339", nodeID, CodeTimezoneOffsetMismatch, "timestamp offset does not match timezone at that instant")
		}
	}
}

func validateMoney(diagnostics *Diagnostics, path string, nodeID NodeID, value MoneyContent) {
	validateRequiredText(diagnostics, path+"/display_value", nodeID, value.DisplayValue, maxShortTextRunes)
	validateDecimal(diagnostics, path+"/amount", nodeID, value.Amount)
	if value.Currency == "" {
		diagnostics.error(path+"/currency", nodeID, CodeRequired, "currency is required")
		return
	}
	unit, err := currency.ParseISO(value.Currency)
	if err != nil || unit.String() != value.Currency || value.Currency == "XXX" || value.Currency == "XTS" {
		diagnostics.error(path+"/currency", nodeID, CodeInvalidCurrency, "currency must be a canonical uppercase ISO 4217 designator")
	}
}

func validateDecimal(diagnostics *Diagnostics, path string, nodeID NodeID, value string) bool {
	if value == "" {
		diagnostics.error(path, nodeID, CodeRequired, "decimal value is required")
		return false
	}
	canonical, ok := normalizeDecimal(value)
	if !ok || canonical != value {
		diagnostics.error(path, nodeID, CodeInvalidDecimal, "value must be a canonical base-10 decimal without exponent notation")
		return false
	}
	raw := strings.TrimPrefix(value, "-")
	parts := strings.SplitN(raw, ".", 2)
	digits := len(parts[0])
	scale := 0
	if len(parts) == 2 {
		digits += len(parts[1])
		scale = len(parts[1])
	}
	if digits > maxDecimalDigits || scale > maxDecimalScale {
		diagnostics.error(path, nodeID, CodeDecimalPrecisionExceeded, fmt.Sprintf("decimal permits at most %d digits and %d fractional digits", maxDecimalDigits, maxDecimalScale))
		return false
	}
	return true
}

func validateLanguage(diagnostics *Diagnostics, path string, nodeID NodeID, value string) {
	if value == "" {
		diagnostics.error(path, nodeID, CodeRequired, "language is required")
		return
	}
	parsed, err := language.Parse(value)
	if len(value) > maxLanguageTagBytes || !languageTagSyntax.MatchString(value) || err != nil || languageBaseIsUnd(parsed) || parsed.String() != value {
		diagnostics.error(path, nodeID, CodeInvalidLanguage, "language must be a canonical, specific BCP 47 tag")
	}
}

func validateReference(diagnostics *Diagnostics, path string, nodeID NodeID, value string) {
	if value == "" {
		diagnostics.error(path, nodeID, CodeRequired, "stable reference is required")
		return
	}
	if len(value) > maxReferenceBytes || !stableReferencePattern.MatchString(value) {
		diagnostics.error(path, nodeID, CodeInvalidStableReference, "stable reference must be 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen")
	}
}

func validateRequiredText(diagnostics *Diagnostics, path string, nodeID NodeID, value string, maxRunes int) {
	if value == "" || strings.TrimSpace(value) == "" {
		diagnostics.error(path, nodeID, CodeRequired, "value is required")
		return
	}
	validateText(diagnostics, path, nodeID, value, maxRunes, false)
}

func validateText(diagnostics *Diagnostics, path string, nodeID NodeID, value string, maxRunes int, allowEmpty bool) {
	if !allowEmpty && value == "" {
		return
	}
	if !utf8.ValidString(value) {
		diagnostics.error(path, nodeID, CodeInvalidText, "value must be valid UTF-8")
		return
	}
	if utf8.RuneCountInString(value) > maxRunes {
		diagnostics.error(path, nodeID, CodeTextTooLong, fmt.Sprintf("value must contain at most %d Unicode characters", maxRunes))
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			diagnostics.error(path, nodeID, CodeInvalidText, "value must not contain control characters")
			return
		}
	}
}

func validateHTTPURL(diagnostics *Diagnostics, path string, nodeID NodeID, value string, requireHTTPS bool) {
	if value == "" {
		diagnostics.error(path, nodeID, CodeRequired, "URL is required")
		return
	}
	if !utf8.ValidString(value) || len(value) > maxURLBytes {
		diagnostics.error(path, nodeID, CodeInvalidURL, "URL must be valid UTF-8 and at most 4096 bytes")
		return
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			diagnostics.error(path, nodeID, CodeInvalidURL, "URL must not contain control characters")
			return
		}
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		diagnostics.error(path, nodeID, CodeInvalidURL, "URL must be an absolute http or https URL with a host")
		return
	}
	if requireHTTPS && parsed.Scheme != "https" {
		diagnostics.error(path, nodeID, CodeHTTPSRequired, "URL must use HTTPS")
	}
	if parsed.User != nil {
		diagnostics.error(path, nodeID, CodeURLCredentialsForbidden, "URL must not contain user credentials")
	}
	if parsed.Fragment != "" {
		diagnostics.error(path, nodeID, CodeURLFragmentForbidden, "canonical URL must not contain a fragment")
	}
}

func escapeJSONPointer(value string) string {
	value = strings.ReplaceAll(value, "~", "~0")
	return strings.ReplaceAll(value, "/", "~1")
}

// validatePoll enforces the two properties a tally depends on.
//
// A poll with one option is not a question, and duplicate option ids silently
// merge two choices into one count — the kind of defect that produces a
// confident wrong answer rather than an error.
func (v *documentValidator) validatePoll(path string, nodeID NodeID, poll *PollContent) {
	// Poll and option ids cross the authoring/runtime boundary and become URL
	// path components. Keep them in the same stable-reference vocabulary as
	// node/action ids instead of accepting arbitrary display text.
	validateReference(v.diagnostics, path+"/poll_id", nodeID, poll.PollID)
	v.validateRichText(path+"/question", nodeID, poll.Question, true)

	if len(poll.Options) < minPollOptions {
		v.diagnostics.error(path+"/options", nodeID, CodeRequired,
			fmt.Sprintf("a poll requires at least %d options", minPollOptions))
		return
	}
	if len(poll.Options) > maxPollOptions {
		v.diagnostics.error(path+"/options", nodeID, CodeLimitExceeded,
			fmt.Sprintf("a poll permits at most %d options", maxPollOptions))
		return
	}
	seen := make(map[string]struct{}, len(poll.Options))
	for i, option := range poll.Options {
		optionPath := fmt.Sprintf("%s/options/%d", path, i)
		validateReference(v.diagnostics, optionPath+"/option_id", nodeID, option.OptionID)
		v.validateRichText(optionPath+"/label", nodeID, option.Label, true)
		if option.OptionID == "" {
			continue
		}
		if _, duplicate := seen[option.OptionID]; duplicate {
			v.diagnostics.error(optionPath+"/option_id", nodeID, CodeDuplicate,
				"option ids must be unique within a poll; duplicates merge two choices into one tally")
			continue
		}
		seen[option.OptionID] = struct{}{}
	}
}
