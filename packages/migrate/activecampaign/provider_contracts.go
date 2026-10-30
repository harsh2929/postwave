// SPDX-License-Identifier: MIT

package activecampaign

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
)

const activeCampaignAudiencePageSize = 100

const activeCampaignCampaignMessagePageSize = 100

const activeCampaignAutomationRelationshipPageSize = 100

// listAutomationPage retains collection metadata because ActiveCampaign
// publishes automation start/trigger relationships in meta.starts rather than
// on the automation rows themselves.
func (a *Adapter) listAutomationPage(ctx context.Context, sess adapter.Session, offset int) ([]acAutomation, int, error) {
	path := fmt.Sprintf("/automations?limit=%d&offset=%d", pageSize, offset)
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &raw); err != nil {
		return nil, 0, err
	}

	providerTotal, hasProviderTotal := totalFromRawOK(raw)
	payload := raw["automations"]
	if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		if hasProviderTotal && providerTotal == 0 {
			return nil, providerTotal, nil
		}
		return nil, providerTotal, fmt.Errorf(`response missing "automations" array and numeric zero total`)
	}
	var automations []acAutomation
	if err := json.Unmarshal(payload, &automations); err != nil {
		return nil, providerTotal, fmt.Errorf(`decode "automations" array: %w`, err)
	}

	metaPayload := raw["meta"]
	if len(metaPayload) == 0 {
		return automations, providerTotal, nil
	}
	if bytes.Equal(bytes.TrimSpace(metaPayload), []byte("null")) {
		return nil, providerTotal, fmt.Errorf(`decode "meta" object: value was null`)
	}
	var meta map[string]interface{}
	if err := json.Unmarshal(metaPayload, &meta); err != nil || meta == nil {
		if err == nil {
			err = fmt.Errorf("value was not an object")
		}
		return nil, providerTotal, fmt.Errorf(`decode "meta" object: %w`, err)
	}
	for i := range automations {
		if automations[i].Raw == nil {
			automations[i].Raw = map[string]interface{}{}
		}
		automations[i].Raw["collection_meta"] = cloneInterfaceMap(meta)
	}
	return automations, providerTotal, nil
}

// listSavedSegmentsV2 follows ActiveCampaign's current saved-audience
// contract. /audiences returns summaries only, so every result is hydrated
// through /segmentsV2 before it is exposed as rebuild evidence.
func (a *Adapter) listSavedSegmentsV2(ctx context.Context, sess adapter.Session) ([]acSegment, error) {
	out := []acSegment{}
	seen := map[string]struct{}{}
	for page := 1; ; page++ {
		values := url.Values{}
		values.Set("page", strconv.Itoa(page))
		values.Set("page_size", strconv.Itoa(activeCampaignAudiencePageSize))
		values.Set("sort", "-updated_date")
		var raw map[string]json.RawMessage
		if err := a.do(ctx, sess, http.MethodGet, "/audiences?"+values.Encode(), nil, &raw); err != nil {
			return nil, fmt.Errorf("activecampaign: list saved-segment summaries page %d: %w", page, err)
		}
		summaries, err := requiredJSONObjectArray(raw, "data")
		if err != nil {
			return nil, fmt.Errorf("activecampaign: decode saved-segment summaries page %d: %w", page, err)
		}
		if len(summaries) == 0 {
			return out, nil
		}
		for _, summary := range summaries {
			attributes := interfaceMap(summary["attributes"])
			segmentID := firstNonEmpty(stringFromAny(attributes["segment_id"]), stringFromAny(summary["id"]))
			if segmentID == "" {
				return nil, fmt.Errorf("activecampaign: saved-segment summary missing segment id")
			}
			if _, duplicate := seen[segmentID]; duplicate {
				return nil, fmt.Errorf("activecampaign: saved-segment pagination repeated segment %s", segmentID)
			}
			seen[segmentID] = struct{}{}

			definition, err := a.fetchSavedSegmentV2(ctx, sess, segmentID)
			if err != nil {
				return nil, err
			}
			definitionAttributes := interfaceMap(definition["attributes"])
			definitionID := firstNonEmpty(stringFromAny(definitionAttributes["segment_id"]), stringFromAny(definition["id"]))
			if definitionID == "" || definitionID != segmentID {
				return nil, fmt.Errorf("activecampaign: saved-segment definition identity mismatch for %s", segmentID)
			}
			out = append(out, acSegment{
				ID:   segmentID,
				Name: firstNonEmpty(stringFromAny(definitionAttributes["name"]), stringFromAny(attributes["name"])),
				Raw: map[string]interface{}{
					"contract":   "segments_v2",
					"summary":    cloneInterfaceMap(summary),
					"definition": cloneInterfaceMap(definition),
				},
			})
		}
		if len(summaries) < activeCampaignAudiencePageSize {
			return out, nil
		}
	}
}

func (a *Adapter) fetchSavedSegmentV2(ctx context.Context, sess adapter.Session, segmentID string) (map[string]interface{}, error) {
	var raw map[string]json.RawMessage
	path := "/segmentsV2/" + url.PathEscape(strings.TrimSpace(segmentID))
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &raw); err != nil {
		return nil, fmt.Errorf("activecampaign: retrieve saved-segment definition %s: %w", segmentID, err)
	}
	definition, err := requiredSingleJSONAPIObject(raw, "data")
	if err != nil {
		return nil, fmt.Errorf("activecampaign: decode saved-segment definition %s: %w", segmentID, err)
	}
	return definition, nil
}

// hydrateAutomationDefinition preserves the documented relationship surfaces
// as opaque source data. ActiveCampaign does not publish a stable, complete
// graph schema for these responses, so this must never fabricate an executable
// Moosewave trigger or node graph.
func (a *Adapter) hydrateAutomationDefinition(ctx context.Context, sess adapter.Session, automation acAutomation) (acAutomation, error) {
	id := strings.TrimSpace(automation.ID)
	if id == "" {
		return acAutomation{}, fmt.Errorf("activecampaign: automation missing source id")
	}
	relationships := map[string]interface{}{}
	for _, relationship := range []string{"blocks", "goals", "campaigns", "sms", "sitemessages"} {
		payload, err := a.fetchAutomationRelationship(ctx, sess, id, relationship)
		if err != nil {
			return acAutomation{}, err
		}
		relationships[relationship] = payload
	}
	summary := automation.Raw
	if len(summary) == 0 {
		summary = map[string]interface{}{
			"id": automation.ID, "name": automation.Name, "status": automation.Status, "links": automation.Links,
		}
	}
	automation.Raw = map[string]interface{}{
		"contract":      "automation_rebuild_v3",
		"summary":       cloneInterfaceMap(summary),
		"relationships": relationships,
	}
	return automation, nil
}

func (a *Adapter) fetchAutomationRelationship(ctx context.Context, sess adapter.Session, automationID, relationship string) (map[string]interface{}, error) {
	basePath := "/automations/" + url.PathEscape(strings.TrimSpace(automationID)) + "/" + url.PathEscape(strings.TrimSpace(relationship))
	offset := 0
	collectionKey := ""
	providerTotal := 0
	hasProviderTotal := false
	seenPages := map[string]struct{}{}
	rows := []interface{}{}
	var preserved map[string]interface{}

	for {
		values := url.Values{}
		values.Set("limit", strconv.Itoa(activeCampaignAutomationRelationshipPageSize))
		values.Set("offset", strconv.Itoa(offset))
		path := basePath + "?" + values.Encode()
		var raw map[string]json.RawMessage
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &raw); err != nil {
			return nil, fmt.Errorf("activecampaign: retrieve automation %s %s: %w", automationID, relationship, err)
		}
		if len(raw) == 0 {
			return nil, fmt.Errorf("activecampaign: automation %s %s response was empty", automationID, relationship)
		}

		pageTotal, pageHasTotal, err := activeCampaignAutomationRelationshipTotal(raw)
		if err != nil {
			return nil, fmt.Errorf("activecampaign: automation %s %s pagination: %w", automationID, relationship, err)
		}
		if offset == 0 {
			providerTotal, hasProviderTotal = pageTotal, pageHasTotal
			preserved = rawMessageMapToInterface(raw)
		} else if pageHasTotal != hasProviderTotal || (hasProviderTotal && pageTotal != providerTotal) {
			return nil, fmt.Errorf("activecampaign: automation %s %s pagination total changed or disappeared", automationID, relationship)
		}

		pageKey, pageRows, err := activeCampaignAutomationRelationshipRows(raw, relationship, collectionKey)
		if err != nil {
			if hasProviderTotal && providerTotal == 0 && offset == 0 && activeCampaignAutomationRelationshipCollectionAbsent(raw, relationship) {
				return preserved, nil
			}
			return nil, fmt.Errorf("activecampaign: automation %s %s pagination: %w", automationID, relationship, err)
		}
		if collectionKey == "" {
			collectionKey = pageKey
		}
		if len(pageRows) > activeCampaignAutomationRelationshipPageSize {
			return nil, fmt.Errorf("activecampaign: automation %s %s returned %d rows above requested limit %d", automationID, relationship, len(pageRows), activeCampaignAutomationRelationshipPageSize)
		}
		pageFingerprint := marshalString(pageRows)
		if _, duplicate := seenPages[pageFingerprint]; duplicate && len(pageRows) > 0 {
			return nil, fmt.Errorf("activecampaign: automation %s %s pagination repeated a collection page at offset %d", automationID, relationship, offset)
		}
		seenPages[pageFingerprint] = struct{}{}
		rows = append(rows, pageRows...)

		if hasProviderTotal {
			if len(rows) > providerTotal {
				return nil, fmt.Errorf("activecampaign: automation %s %s collected %d rows above provider total %d", automationID, relationship, len(rows), providerTotal)
			}
			if len(rows) == providerTotal {
				break
			}
			if len(pageRows) == 0 {
				return nil, fmt.Errorf("activecampaign: automation %s %s returned an empty page at offset %d before provider total %d", automationID, relationship, offset, providerTotal)
			}
		} else if len(pageRows) < activeCampaignAutomationRelationshipPageSize {
			break
		}
		offset += len(pageRows)
	}

	if preserved == nil {
		preserved = map[string]interface{}{}
	}
	if collectionKey != "" {
		preserved[collectionKey] = rows
	}
	return preserved, nil
}

func activeCampaignAutomationRelationshipTotal(raw map[string]json.RawMessage) (int, bool, error) {
	payload := raw["meta"]
	if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return 0, false, nil
	}
	var meta map[string]json.RawMessage
	if err := json.Unmarshal(payload, &meta); err != nil || meta == nil {
		return 0, false, fmt.Errorf("decode meta object")
	}
	totalPayload, ok := meta["total"]
	if !ok {
		return 0, false, nil
	}
	var value interface{}
	if err := json.Unmarshal(totalPayload, &value); err != nil {
		return 0, false, fmt.Errorf("decode meta.total: %w", err)
	}
	if number, ok := value.(float64); ok && number != float64(int(number)) {
		return 0, false, fmt.Errorf("meta.total must be a non-negative integer")
	}
	total, ok := intFromAnyOK(value)
	if !ok {
		return 0, false, fmt.Errorf("meta.total must be a non-negative integer")
	}
	return total, true, nil
}

func activeCampaignAutomationRelationshipCollectionAbsent(raw map[string]json.RawMessage, relationship string) bool {
	for _, key := range []string{strings.TrimSpace(relationship), "items"} {
		payload := bytes.TrimSpace(raw[key])
		if len(payload) > 0 && !bytes.Equal(payload, []byte("null")) {
			return false
		}
	}
	return true
}

func activeCampaignAutomationRelationshipRows(raw map[string]json.RawMessage, relationship, expectedKey string) (string, []interface{}, error) {
	if expectedKey != "" {
		rows, err := activeCampaignRawInterfaceArray(raw[expectedKey])
		if err != nil {
			return "", nil, fmt.Errorf("collection %q changed shape: %w", expectedKey, err)
		}
		return expectedKey, rows, nil
	}

	candidates := []string{}
	for _, key := range []string{strings.TrimSpace(relationship), "items"} {
		if key == "" || len(raw[key]) == 0 {
			continue
		}
		if _, err := activeCampaignRawInterfaceArray(raw[key]); err == nil {
			candidates = append(candidates, key)
		}
	}
	if len(candidates) == 0 {
		for key, payload := range raw {
			if key == "meta" {
				continue
			}
			if _, err := activeCampaignRawInterfaceArray(payload); err == nil {
				candidates = append(candidates, key)
			}
		}
	}
	if len(candidates) != 1 {
		return "", nil, fmt.Errorf("response contained %d candidate collection arrays; expected one", len(candidates))
	}
	rows, err := activeCampaignRawInterfaceArray(raw[candidates[0]])
	if err != nil {
		return "", nil, err
	}
	return candidates[0], rows, nil
}

func activeCampaignRawInterfaceArray(payload json.RawMessage) ([]interface{}, error) {
	if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return nil, fmt.Errorf("collection array was missing")
	}
	var rows []interface{}
	if err := json.Unmarshal(payload, &rows); err != nil {
		return nil, fmt.Errorf("decode collection array: %w", err)
	}
	return rows, nil
}

// hydrateCampaignArchiveItem resolves the campaign detail and its primary
// message. Campaign list/detail rows do not contain rendered message content.
func (a *Adapter) hydrateCampaignArchiveItem(ctx context.Context, sess adapter.Session, listed acCampaign) (acCampaign, error) {
	id := strings.TrimSpace(listed.ID)
	if id == "" {
		return acCampaign{}, fmt.Errorf("activecampaign: campaign archive item missing source id")
	}
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, "/campaigns/"+url.PathEscape(id), nil, &raw); err != nil {
		return acCampaign{}, fmt.Errorf("activecampaign: retrieve campaign %s: %w", id, err)
	}
	campaignPayload := raw["campaign"]
	if len(campaignPayload) == 0 || bytes.Equal(bytes.TrimSpace(campaignPayload), []byte("null")) {
		return acCampaign{}, fmt.Errorf(`activecampaign: retrieve campaign %s: response missing "campaign" object`, id)
	}
	var detailed acCampaign
	if err := json.Unmarshal(campaignPayload, &detailed); err != nil {
		return acCampaign{}, fmt.Errorf("activecampaign: decode campaign %s: %w", id, err)
	}
	detailed = mergeCampaignFallback(detailed, listed)
	if strings.TrimSpace(detailed.ID) != id {
		return acCampaign{}, fmt.Errorf("activecampaign: campaign identity mismatch for %s", id)
	}

	campaignRaw := map[string]interface{}{}
	if err := json.Unmarshal(campaignPayload, &campaignRaw); err != nil {
		return acCampaign{}, fmt.Errorf("activecampaign: preserve campaign %s: %w", id, err)
	}
	messageID := firstNonEmpty(stringFromAny(campaignRaw["message_id"]), stringFromAny(campaignRaw["messageid"]))
	if messageID == "" {
		return acCampaign{}, fmt.Errorf("activecampaign: sent campaign %s missing primary message id", id)
	}
	message, err := a.fetchCampaignMessage(ctx, sess, messageID)
	if err != nil {
		return acCampaign{}, fmt.Errorf("activecampaign: hydrate campaign %s: %w", id, err)
	}
	detailed.Subject = firstNonEmpty(stringFromAny(message["subject"]), detailed.Subject, detailed.Name)
	detailed.HTML = stringFromAny(message["html"])
	detailed.Text = stringFromAny(message["text"])
	if strings.TrimSpace(detailed.HTML) == "" && strings.TrimSpace(detailed.Text) == "" {
		return acCampaign{}, fmt.Errorf("activecampaign: sent campaign %s message %s has no rendered content", id, messageID)
	}

	preserved := map[string]interface{}{
		"contract": "campaign_message_v3",
		"campaign": cloneInterfaceMap(campaignRaw),
		"message":  cloneInterfaceMap(message),
	}
	if campaignHasMultipleMessageVariants(campaignRaw) {
		variants, err := a.fetchCampaignMessageVariants(ctx, sess, id, messageID)
		if err != nil {
			return acCampaign{}, err
		}
		preserved["message_variants"] = variants
	}
	detailed.Extra = preserved
	return detailed, nil
}

func (a *Adapter) fetchCampaignMessage(ctx context.Context, sess adapter.Session, messageID string) (map[string]interface{}, error) {
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, "/messages/"+url.PathEscape(strings.TrimSpace(messageID)), nil, &raw); err != nil {
		return nil, fmt.Errorf("retrieve message %s: %w", messageID, err)
	}
	payload := raw["message"]
	if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return nil, fmt.Errorf(`retrieve message %s: response missing "message" object`, messageID)
	}
	var message map[string]interface{}
	if err := json.Unmarshal(payload, &message); err != nil {
		return nil, fmt.Errorf("decode message %s: %w", messageID, err)
	}
	gotID := stringFromAny(message["id"])
	if gotID != "" && gotID != strings.TrimSpace(messageID) {
		return nil, fmt.Errorf("message identity mismatch for %s", messageID)
	}
	return message, nil
}

func (a *Adapter) fetchCampaignMessageVariants(ctx context.Context, sess adapter.Session, campaignID, primaryMessageID string) ([]map[string]interface{}, error) {
	campaignID = strings.TrimSpace(campaignID)
	primaryMessageID = strings.TrimSpace(primaryMessageID)
	out := []map[string]interface{}{}
	seenMessageIDs := map[string]struct{}{}
	seenRelationshipIDs := map[string]struct{}{}
	offset := 0
	knownTotal := -1
	totalMetadataPresent := false

	for {
		values := url.Values{}
		values.Set("limit", strconv.Itoa(activeCampaignCampaignMessagePageSize))
		values.Set("offset", strconv.Itoa(offset))
		path := "/campaigns/" + url.PathEscape(campaignID) + "/campaignMessages?" + values.Encode()
		var raw map[string]json.RawMessage
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &raw); err != nil {
			return nil, fmt.Errorf("activecampaign: retrieve campaign %s message variants at offset %d: %w", campaignID, offset, err)
		}
		rows, err := requiredJSONObjectArray(raw, "campaignMessages")
		if err != nil {
			return nil, fmt.Errorf("activecampaign: decode campaign %s message variants at offset %d: %w", campaignID, offset, err)
		}

		providerTotal, hasProviderTotal := totalFromRawOK(raw)
		if offset == 0 {
			totalMetadataPresent = hasProviderTotal
			if hasProviderTotal {
				knownTotal = providerTotal
			}
		} else if hasProviderTotal != totalMetadataPresent || (hasProviderTotal && providerTotal != knownTotal) {
			return nil, fmt.Errorf("activecampaign: campaign %s message variant pagination metadata changed at offset %d", campaignID, offset)
		}
		if hasProviderTotal && (providerTotal < 0 || offset+len(rows) > providerTotal) {
			return nil, fmt.Errorf("activecampaign: campaign %s message variant page at offset %d exceeded provider total %d", campaignID, offset, providerTotal)
		}
		if len(rows) == 0 {
			if hasProviderTotal && offset < providerTotal {
				return nil, fmt.Errorf("activecampaign: campaign %s message variant pagination ended at %d before provider total %d", campaignID, offset, providerTotal)
			}
			break
		}

		for _, row := range rows {
			relationshipID := strings.TrimSpace(stringFromAny(row["id"]))
			if relationshipID != "" {
				if _, duplicate := seenRelationshipIDs[relationshipID]; duplicate {
					return nil, fmt.Errorf("activecampaign: campaign %s message variant pagination repeated relationship %s", campaignID, relationshipID)
				}
				seenRelationshipIDs[relationshipID] = struct{}{}
			}
			rowCampaignID := strings.TrimSpace(firstNonEmpty(stringFromAny(row["campaign"]), stringFromAny(row["campaignid"]), stringFromAny(row["campaign_id"])))
			if rowCampaignID != "" && rowCampaignID != campaignID {
				return nil, fmt.Errorf("activecampaign: campaign %s message variant relationship belongs to campaign %s", campaignID, rowCampaignID)
			}
			messageID := strings.TrimSpace(firstNonEmpty(stringFromAny(row["message"]), stringFromAny(row["messageid"]), stringFromAny(row["message_id"])))
			if messageID == "" {
				return nil, fmt.Errorf("activecampaign: campaign %s variant missing message id", campaignID)
			}
			if _, duplicate := seenMessageIDs[messageID]; duplicate {
				return nil, fmt.Errorf("activecampaign: campaign %s message variant pagination repeated message %s", campaignID, messageID)
			}
			seenMessageIDs[messageID] = struct{}{}
			message, err := a.fetchCampaignMessage(ctx, sess, messageID)
			if err != nil {
				return nil, fmt.Errorf("activecampaign: hydrate campaign %s variant: %w", campaignID, err)
			}
			out = append(out, map[string]interface{}{"relationship": cloneInterfaceMap(row), "message": message})
		}

		nextOffset := offset + len(rows)
		if hasProviderTotal {
			if nextOffset == providerTotal {
				break
			}
			offset = nextOffset
			continue
		}
		if len(rows) < activeCampaignCampaignMessagePageSize {
			break
		}
		offset = nextOffset
	}

	if knownTotal >= 0 && len(out) != knownTotal {
		return nil, fmt.Errorf("activecampaign: campaign %s preserved %d message variants; provider reported %d", campaignID, len(out), knownTotal)
	}
	if _, ok := seenMessageIDs[primaryMessageID]; !ok {
		return nil, fmt.Errorf("activecampaign: campaign %s variants omitted primary message %s", campaignID, primaryMessageID)
	}
	return out, nil
}

func campaignHasMultipleMessageVariants(campaign map[string]interface{}) bool {
	typeName := strings.ToLower(strings.TrimSpace(stringFromAny(campaign["type"])))
	if strings.Contains(typeName, "split") || strings.Contains(typeName, "predict") {
		return true
	}
	return truthy(campaign["has_predictive_content"]) || firstPositiveInt(stringFromAny(campaign["split_content"])) > 0
}

func mergeCampaignFallback(primary, fallback acCampaign) acCampaign {
	if primary.ID == "" {
		primary.ID = fallback.ID
	}
	if primary.Name == "" {
		primary.Name = fallback.Name
	}
	if primary.Subject == "" {
		primary.Subject = fallback.Subject
	}
	if primary.Status == "" {
		primary.Status = fallback.Status
	}
	if primary.SendDate == "" {
		primary.SendDate = fallback.SendDate
	}
	if primary.LastDate == "" {
		primary.LastDate = fallback.LastDate
	}
	if primary.CreatedDate == "" {
		primary.CreatedDate = fallback.CreatedDate
	}
	if primary.Type == "" {
		primary.Type = fallback.Type
	}
	for target, source := range map[*string]string{
		&primary.SendAmount: fallback.SendAmount, &primary.TotalAmt: fallback.TotalAmt,
		&primary.Opens: fallback.Opens, &primary.UniqueOpens: fallback.UniqueOpens,
		&primary.Clicks: fallback.Clicks, &primary.LinkClicks: fallback.LinkClicks,
		&primary.UniqueClicks: fallback.UniqueClicks,
	} {
		if *target == "" {
			*target = source
		}
	}
	return primary
}

func requiredJSONObjectArray(raw map[string]json.RawMessage, key string) ([]map[string]interface{}, error) {
	payload := raw[key]
	if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return nil, fmt.Errorf(`response missing %q array`, key)
	}
	var rows []map[string]interface{}
	if err := json.Unmarshal(payload, &rows); err != nil {
		return nil, fmt.Errorf(`decode %q array: %w`, key, err)
	}
	return rows, nil
}

func requiredSingleJSONAPIObject(raw map[string]json.RawMessage, key string) (map[string]interface{}, error) {
	payload := raw[key]
	if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return nil, fmt.Errorf(`response missing %q object`, key)
	}
	var object map[string]interface{}
	if err := json.Unmarshal(payload, &object); err == nil && object != nil {
		return object, nil
	}
	var objects []map[string]interface{}
	if err := json.Unmarshal(payload, &objects); err != nil {
		return nil, fmt.Errorf(`decode %q object: %w`, key, err)
	}
	if len(objects) != 1 {
		return nil, fmt.Errorf(`%q contained %d objects; expected one`, key, len(objects))
	}
	return objects[0], nil
}

func rawMessageMapToInterface(raw map[string]json.RawMessage) map[string]interface{} {
	out := make(map[string]interface{}, len(raw))
	for key, value := range raw {
		var decoded interface{}
		if err := json.Unmarshal(value, &decoded); err != nil {
			out[key] = string(value)
			continue
		}
		out[key] = decoded
	}
	return out
}

func interfaceMap(value interface{}) map[string]interface{} {
	if value == nil {
		return nil
	}
	if out, ok := value.(map[string]interface{}); ok {
		return out
	}
	return nil
}
