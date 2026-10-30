// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxCompiledTextBytes = 2 << 20
	maxCompiledHTMLBytes = 8 << 20
	maxSlotValueRunes    = 16_384
)

type resolvedNode struct {
	node      Node
	content   NodeContent
	pollLinks map[string]string
}

type compileState struct {
	document    DocumentV2
	locale      string
	slots       map[SlotID]string
	nodes       []resolvedNode
	nodeByID    map[NodeID]resolvedNode
	diagnostics Diagnostics
}

// CompileV2 normalizes, validates, resolves, and projects one exact semantic
// scenario. It returns no partial result when any deterministic error exists.
func CompileV2(input DocumentV2, options CompileOptions) (Result, Diagnostics) {
	document, diagnostics := NormalizeAndValidateV2(input)
	if diagnostics.HasErrors() {
		return Result{}, diagnostics
	}
	state := compileState{
		document: document,
		locale:   normalizeLanguage(options.Locale),
		slots:    normalizeCompileSlots(options.Slots, &diagnostics),
		nodeByID: make(map[NodeID]resolvedNode, len(document.Nodes)),
	}
	pollLinks := normalizePollOptionLinks(document, options.PollOptionLinks, &diagnostics)
	if state.locale == "" {
		state.locale = document.Language
	}
	validateLanguage(&diagnostics, "/compile/locale", "", state.locale)
	state.diagnostics = diagnostics
	if state.diagnostics.HasErrors() {
		return Result{}, state.diagnostics
	}

	for index, node := range document.Nodes {
		included := state.evaluateConditions(index, node)
		if !included {
			continue
		}
		content, ok := state.selectLocalizedContent(index, node)
		if !ok {
			continue
		}
		content = state.resolveContent(index, node.ID, content)
		resolved := resolvedNode{node: node, content: content}
		if content.Poll != nil {
			resolved.pollLinks = pollLinks[content.Poll.PollID]
		}
		state.nodes = append(state.nodes, resolved)
		state.nodeByID[node.ID] = resolved
	}
	state.validateResolvedStructure()
	if state.diagnostics.HasErrors() {
		return Result{}, state.diagnostics
	}
	visible := false
	for _, node := range state.nodes {
		if node.node.Type != NodeStructuredData {
			visible = true
			break
		}
	}
	if !visible {
		state.diagnostics.error("/nodes", "", CodeNoVisibleContent, "compiled scenario contains no visible semantic content")
		return Result{}, state.diagnostics
	}

	payloads, statuses := state.compileStructuredData(options.StructuredPolicy)
	if state.diagnostics.HasErrors() {
		return Result{}, state.diagnostics
	}
	combinedJSONLD, err := combineJSONLD(payloads)
	if err != nil {
		state.diagnostics.error("/compile/json_ld", "", CodeInvalidText, "canonical JSON-LD encoding failed")
		return Result{}, state.diagnostics
	}
	htmlOutput := renderHTML(document.Language, document.Direction, state.locale, state.nodes, combinedJSONLD, options.HoneypotDecoys)
	textOutput := renderText(state.nodes)
	if strings.TrimSpace(textOutput) == "" {
		state.diagnostics.error("/compile/text", "", CodeNoVisibleContent, "compiled scenario has no semantic plain-text content")
	}
	if len(htmlOutput) > maxCompiledHTMLBytes {
		state.diagnostics.error("/compile/html", "", CodeLimitExceeded, fmt.Sprintf("compiled HTML exceeds %d bytes", maxCompiledHTMLBytes))
	}
	if len(textOutput) > maxCompiledTextBytes {
		state.diagnostics.error("/compile/text", "", CodeLimitExceeded, fmt.Sprintf("compiled text exceeds %d bytes", maxCompiledTextBytes))
	}
	if state.diagnostics.HasErrors() {
		return Result{}, state.diagnostics
	}

	included := make([]NodeID, len(state.nodes))
	for i, node := range state.nodes {
		included[i] = node.node.ID
	}
	result := Result{
		HTML:               htmlOutput,
		Text:               textOutput,
		JSONLD:             append(json.RawMessage(nil), combinedJSONLD...),
		StructuredPayloads: cloneRawMessages(payloads),
		StructuredStatuses: statuses,
		IncludedNodeIDs:    included,
		Hashes: ProjectionHashes{
			HTML: digestString(htmlOutput),
			Text: digestString(textOutput),
		},
		CompilerVersion: CompilerVersion,
		HTMLVersion:     HTMLRendererVersion,
		TextVersion:     TextRendererVersion,
		RegistryVersion: GmailRegistryVersion,
	}
	if len(combinedJSONLD) != 0 {
		result.Hashes.JSONLD = digestBytes(combinedJSONLD)
	}
	return result, state.diagnostics
}

func normalizePollOptionLinks(document DocumentV2, input PollOptionLinks, diagnostics *Diagnostics) PollOptionLinks {
	if len(input) == 0 {
		return nil
	}
	want := make(map[string]map[string]NodeID)
	for _, node := range document.Nodes {
		if node.Type != NodePoll || node.Content.Poll == nil {
			continue
		}
		options := make(map[string]NodeID, len(node.Content.Poll.Options))
		for _, option := range node.Content.Poll.Options {
			options[option.OptionID] = node.ID
		}
		want[node.Content.Poll.PollID] = options
	}
	out := make(PollOptionLinks, len(want))
	for pollID, options := range want {
		provided, ok := input[pollID]
		if !ok {
			diagnostics.error("/compile/poll_option_links/"+escapeJSONPointer(pollID), "", CodeRequired,
				"recipient-specific links are required for every poll when poll links are supplied")
			continue
		}
		copyOptions := make(map[string]string, len(options))
		for optionID, nodeID := range options {
			link, ok := provided[optionID]
			path := "/compile/poll_option_links/" + escapeJSONPointer(pollID) + "/" + escapeJSONPointer(optionID)
			if !ok {
				diagnostics.error(path, nodeID, CodeRequired, "recipient-specific poll option link is required")
				continue
			}
			validateHTTPURL(diagnostics, path, nodeID, link, true)
			copyOptions[optionID] = link
		}
		for optionID := range provided {
			if _, ok := options[optionID]; !ok {
				diagnostics.error("/compile/poll_option_links/"+escapeJSONPointer(pollID)+"/"+escapeJSONPointer(optionID), "", CodeNodeReferenceMissing,
					"poll option link references an option absent from the semantic document")
			}
		}
		out[pollID] = copyOptions
	}
	for pollID := range input {
		if _, ok := want[pollID]; !ok {
			diagnostics.error("/compile/poll_option_links/"+escapeJSONPointer(pollID), "", CodeNodeReferenceMissing,
				"poll option links reference a poll absent from the semantic document")
		}
	}
	return out
}

func (s *compileState) validateResolvedStructure() {
	lastHeadingLevel := 0
	firstH1Path := ""
	primaryActionPath := ""
	for _, resolved := range s.nodes {
		path := s.nodePath(resolved.node.ID)
		if resolved.node.Type == NodeHeading && resolved.content.Heading != nil {
			level := resolved.content.Heading.Level
			if level == 1 {
				if firstH1Path != "" {
					s.warningOnce(path+"/content/heading/level", resolved.node.ID, CodeMultipleTopLevelHeadings, "compiled scenario contains more than one level-one heading; first is "+firstH1Path)
				} else {
					firstH1Path = path + "/content/heading/level"
				}
			}
			if level > 1 && (lastHeadingLevel == 0 || level > lastHeadingLevel+1) {
				s.warningOnce(path+"/content/heading/level", resolved.node.ID, CodeHeadingLevelSkipped, "compiled heading hierarchy skips a level")
			}
			lastHeadingLevel = level
		}
		if resolved.node.Type == NodeAction && resolved.node.Role == RolePrimaryAction {
			if primaryActionPath != "" {
				s.diagnostics.error(path+"/role", resolved.node.ID, CodeMultiplePrimaryActions, "compiled scenario has another primary action at "+primaryActionPath)
			} else {
				primaryActionPath = path + "/role"
			}
		}
	}
}

func (s *compileState) warningOnce(path string, nodeID NodeID, code DiagnosticCode, message string) {
	for _, diagnostic := range s.diagnostics {
		if diagnostic.Severity == SeverityWarning && diagnostic.Path == path && diagnostic.Code == code {
			return
		}
	}
	s.diagnostics.warning(path, nodeID, code, message)
}

func normalizeCompileSlots(input map[SlotID]string, diagnostics *Diagnostics) map[SlotID]string {
	if input == nil {
		return map[SlotID]string{}
	}
	keys := make([]string, 0, len(input))
	byRaw := make(map[string]SlotID, len(input))
	for key := range input {
		raw := string(key)
		keys = append(keys, raw)
		byRaw[raw] = key
	}
	sort.Strings(keys)
	out := make(map[SlotID]string, len(input))
	for _, raw := range keys {
		normalizedID := SlotID(normalizeReference(raw))
		path := "/compile/slots/" + escapeJSONPointer(raw)
		validateReference(diagnostics, path, "", string(normalizedID))
		if _, exists := out[normalizedID]; exists {
			diagnostics.error(path, "", CodeDuplicate, "slot id collides after normalization")
			continue
		}
		value := input[byRaw[raw]]
		if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxSlotValueRunes || hasDisallowedControl(value) {
			diagnostics.error(path, "", CodeSlotValueInvalid, fmt.Sprintf("slot value must be valid UTF-8, control-free, and at most %d characters", maxSlotValueRunes))
			continue
		}
		out[normalizedID] = normalizeNaturalText(value)
	}
	return out
}

func hasDisallowedControl(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func (s *compileState) evaluateConditions(index int, node Node) bool {
	included := true
	for conditionIndex, condition := range node.Conditions {
		path := fmt.Sprintf("/nodes/%d/conditions/%d", index, conditionIndex)
		value, exists := s.slots[condition.SlotID]
		present := exists && value != ""
		switch condition.Operator {
		case ConditionPresent:
			included = included && present
		case ConditionAbsent:
			included = included && !present
		case ConditionEquals, ConditionNotEquals:
			if !exists {
				s.diagnostics.error(path+"/slot_id", node.ID, CodeConditionUnresolved, "equality condition cannot be resolved without a scenario slot value")
				included = false
				continue
			}
			matches := value == condition.Value
			if condition.Operator == ConditionNotEquals {
				matches = !matches
			}
			included = included && matches
		}
	}
	return included
}

func (s *compileState) selectLocalizedContent(index int, node Node) (NodeContent, bool) {
	if s.locale == s.document.Language || node.Type == NodeStructuredData {
		return node.Content, true
	}
	content, ok := node.Localizations[s.locale]
	if !ok {
		s.diagnostics.error(fmt.Sprintf("/nodes/%d/localizations/%s", index, escapeJSONPointer(s.locale)), node.ID, CodeLocaleUnavailable, "required scenario locale has no node localization")
		return NodeContent{}, false
	}
	return content, true
}

func (s *compileState) resolveContent(index int, nodeID NodeID, content NodeContent) NodeContent {
	base := fmt.Sprintf("/nodes/%d/content", index)
	if content.Heading != nil {
		content.Heading.Text = s.resolveRichText(base+"/heading/text", nodeID, content.Heading.Text)
	}
	if content.Paragraph != nil {
		content.Paragraph.Text = s.resolveRichText(base+"/paragraph/text", nodeID, content.Paragraph.Text)
	}
	if content.List != nil {
		for i, item := range content.List.Items {
			content.List.Items[i] = s.resolveRichText(fmt.Sprintf("%s/list/items/%d", base, i), nodeID, item)
		}
	}
	if content.Answer != nil {
		content.Answer.Question = s.resolveRichText(base+"/answer/question", nodeID, content.Answer.Question)
		content.Answer.Answer = s.resolveRichText(base+"/answer/answer", nodeID, content.Answer.Answer)
	}
	if content.Legal != nil {
		content.Legal.Text = s.resolveRichText(base+"/legal/text", nodeID, content.Legal.Text)
	}
	if content.Offer != nil {
		content.Offer.Description = s.resolveRichText(base+"/offer/description", nodeID, content.Offer.Description)
		content.Offer.Terms = s.resolveRichText(base+"/offer/terms", nodeID, content.Offer.Terms)
	}
	if content.Personalization != nil {
		value := s.resolveSlot(base+"/personalization/slot", nodeID, content.Personalization.Slot)
		content.Personalization.Slot.Required = false
		content.Personalization.Slot.Fallback = value
	}
	return content
}

func (s *compileState) resolveRichText(path string, nodeID NodeID, rich RichText) RichText {
	out := RichText{Runs: make([]InlineRun, 0, len(rich.Runs))}
	for i, run := range rich.Runs {
		if run.Kind != InlineSlot || run.Slot == nil {
			out.Runs = append(out.Runs, run)
			continue
		}
		value := s.resolveSlot(fmt.Sprintf("%s/runs/%d/slot", path, i), nodeID, *run.Slot)
		if value != "" {
			out.Runs = append(out.Runs, InlineRun{Kind: InlineText, Text: value})
		}
	}
	return out
}

func (s *compileState) resolveSlot(path string, nodeID NodeID, slot SlotReference) string {
	if value, exists := s.slots[slot.ID]; exists && value != "" {
		return value
	}
	if slot.Fallback != "" {
		return slot.Fallback
	}
	if slot.Required {
		s.diagnostics.error(path, nodeID, CodeSlotUnresolved, "required personalization slot has no scenario value or fallback")
	}
	return ""
}

func combineJSONLD(payloads []json.RawMessage) (json.RawMessage, error) {
	if len(payloads) == 0 {
		return nil, nil
	}
	if len(payloads) == 1 {
		return append(json.RawMessage(nil), payloads[0]...), nil
	}
	combined, err := json.Marshal(payloads)
	if err != nil {
		return nil, err
	}
	return combined, nil
}

func cloneRawMessages(input []json.RawMessage) []json.RawMessage {
	if input == nil {
		return nil
	}
	out := make([]json.RawMessage, len(input))
	for i, item := range input {
		out[i] = append(json.RawMessage(nil), item...)
	}
	return out
}

func digestString(value string) string { return digestBytes([]byte(value)) }

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func joinNonEmpty(values ...string) string {
	out := values[:0]
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return strings.Join(out, ", ")
}
