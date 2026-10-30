// SPDX-License-Identifier: MIT

package klaviyo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// Only sent email campaigns belong in Moosewave's email campaign archive.
// Sent SMS and mobile-push evidence is retained by ListSourceArchive so it can
// never be materialized as a sent email campaign row.
var campaignChannels = []string{"email"}

const campaignCursorPrefix = "klv-campaign-v2:"

type campaignMessageEvidence struct {
	Message   kvMessage
	Templates []kvTemplate
}

type campaignRebuildEvidence struct {
	Campaign kvCampaign
	Channel  string
	Messages []campaignMessageEvidence
}

func (a *Adapter) listCampaignArchive(ctx context.Context, sess adapter.Session, rawCursor string) ([]canonical.CampaignArchive, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	channelIndex, providerCursor, err := decodeCampaignCursor(rawCursor)
	if err != nil {
		return nil, "", err
	}
	channel := campaignChannels[channelIndex]
	query := url.Values{
		"filter":     {"equals(messages.channel,'" + channel + "')"},
		"page[size]": {strconv.Itoa(campaignPageSize)},
		"sort":       {"id"},
	}
	if providerCursor != "" {
		query.Set("page[cursor]", providerCursor)
	}
	var response struct {
		Data  []kvCampaign `json:"data"`
		Links kvLinks      `json:"links"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/campaigns?"+query.Encode(), nil, &response); err != nil {
		return nil, "", err
	}
	if len(response.Data) > campaignPageSize {
		return nil, "", fmt.Errorf("klaviyo %s campaigns returned more than %d rows: %w", channel, campaignPageSize, adapter.ErrSourceUnavailable)
	}
	seen := map[string]struct{}{}
	out := make([]canonical.CampaignArchive, 0, len(response.Data))
	for _, campaign := range response.Data {
		if campaign.Type != "campaign" || !validProviderID(campaign.ID) || strings.TrimSpace(campaign.Attributes.Name) == "" || strings.TrimSpace(campaign.Attributes.Status) == "" {
			return nil, "", fmt.Errorf("klaviyo %s campaign returned an incomplete identity: %w", channel, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[campaign.ID]; duplicate {
			return nil, "", fmt.Errorf("klaviyo campaigns returned duplicate identity %q on one page: %w", campaign.ID, adapter.ErrSourceUnavailable)
		}
		seen[campaign.ID] = struct{}{}
		if err := validateCampaignTagRelationships(campaign); err != nil {
			return nil, "", err
		}
		if !campaignIsSent(campaign) {
			continue
		}
		if _, discovered := snapshot.SentCampaignIDs[campaign.ID]; !discovered {
			return nil, "", fmt.Errorf("klaviyo sent campaign %q appeared after discovery: %w", campaign.ID, adapter.ErrSourceUnavailable)
		}
		messages, messageErr := a.getCampaignMessages(ctx, sess, campaign, channel)
		if messageErr != nil {
			return nil, "", messageErr
		}
		mapped, mapErr := mapCampaignEvidence(campaign, channel, messages)
		if mapErr != nil {
			return nil, "", mapErr
		}
		out = append(out, mapped)
	}
	nextProvider, err := nextCursor(response.Links.Next, providerCursor, "campaigns ("+channel+")")
	if err != nil {
		return nil, "", err
	}
	if nextProvider != "" {
		return out, encodeCampaignCursor(channelIndex, nextProvider), nil
	}
	if channelIndex+1 < len(campaignChannels) {
		return out, encodeCampaignCursor(channelIndex+1, ""), nil
	}
	return out, "", nil
}

func (a *Adapter) getCampaignMessages(ctx context.Context, sess adapter.Session, campaign kvCampaign, expectedChannel string) ([]campaignMessageEvidence, error) {
	sent := campaignIsSent(campaign)
	refs := campaign.Relationships.Messages.Data
	if len(refs) == 0 {
		if !sent {
			return []campaignMessageEvidence{}, nil
		}
		return nil, fmt.Errorf("klaviyo campaign %q has no message relationship: %w", campaign.ID, adapter.ErrSourceUnavailable)
	}
	seen := map[string]struct{}{}
	out := make([]campaignMessageEvidence, 0, len(refs))
	for _, ref := range refs {
		if ref.Type != "campaign-message" || !validProviderID(ref.ID) {
			return nil, fmt.Errorf("klaviyo sent campaign %q has an invalid message relationship: %w", campaign.ID, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[ref.ID]; duplicate {
			return nil, fmt.Errorf("klaviyo sent campaign %q repeats message %q: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
		}
		seen[ref.ID] = struct{}{}
		query := url.Values{"include": {"template"}}
		var detail struct {
			Data     kvMessage    `json:"data"`
			Included []kvTemplate `json:"included"`
		}
		path := "/campaign-messages/" + url.PathEscape(ref.ID) + "?" + query.Encode()
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &detail); err != nil {
			return nil, fmt.Errorf("klaviyo preserve campaign %q message %q: %w", campaign.ID, ref.ID, err)
		}
		if detail.Data.Type != "campaign-message" || detail.Data.ID != ref.ID {
			return nil, fmt.Errorf("klaviyo campaign %q message %q returned a mismatched identity: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
		}
		definition := detail.Data.Attributes.Definition
		if definition == nil {
			if sent {
				return nil, fmt.Errorf("klaviyo sent campaign %q message %q omitted its content definition: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
			}
		} else if channel := strings.TrimSpace(definition.Channel); channel != expectedChannel {
			return nil, fmt.Errorf("klaviyo campaign %q message %q channel %q does not match inventory channel %q: %w", campaign.ID, ref.ID, channel, expectedChannel, adapter.ErrSourceUnavailable)
		}
		if parent := detail.Data.Relationships.Campaign.Data; parent != nil {
			if parent.Type != "campaign" || parent.ID != campaign.ID {
				return nil, fmt.Errorf("klaviyo campaign %q message %q returned a mismatched parent campaign: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
			}
		}
		if image := detail.Data.Relationships.Image.Data; image != nil && (image.Type != "image" || !validProviderID(image.ID)) {
			return nil, fmt.Errorf("klaviyo campaign %q message %q returned an invalid image relationship: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
		}
		seenTemplates := map[string]struct{}{}
		for _, template := range detail.Included {
			if template.Type != "template" || !validProviderID(template.ID) {
				return nil, fmt.Errorf("klaviyo campaign %q message %q returned an invalid template: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenTemplates[template.ID]; duplicate {
				return nil, fmt.Errorf("klaviyo campaign %q message %q repeated template %q: %w", campaign.ID, ref.ID, template.ID, adapter.ErrSourceUnavailable)
			}
			seenTemplates[template.ID] = struct{}{}
		}
		templateRef := detail.Data.Relationships.Template.Data
		if templateRef == nil {
			if expectedChannel == "email" && sent {
				return nil, fmt.Errorf("klaviyo campaign %q email message %q omitted its template relationship: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
			}
			if len(detail.Included) != 0 {
				return nil, fmt.Errorf("klaviyo campaign %q message %q returned unrelated included templates: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
			}
		} else if templateRef.Type != "template" || !validProviderID(templateRef.ID) || len(detail.Included) != 1 || detail.Included[0].ID != templateRef.ID {
			return nil, fmt.Errorf("klaviyo campaign %q message %q returned ambiguous or mismatched template evidence: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
		}
		out = append(out, campaignMessageEvidence{Message: detail.Data, Templates: detail.Included})
	}
	return out, nil
}

func validateCampaignTagRelationships(campaign kvCampaign) error {
	seen := map[string]struct{}{}
	for _, ref := range campaign.Relationships.Tags.Data {
		if ref.Type != "tag" || !validProviderID(ref.ID) {
			return fmt.Errorf("klaviyo campaign %q returned an invalid tag relationship: %w", campaign.ID, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[ref.ID]; duplicate {
			return fmt.Errorf("klaviyo campaign %q repeated tag relationship %q: %w", campaign.ID, ref.ID, adapter.ErrSourceUnavailable)
		}
		seen[ref.ID] = struct{}{}
	}
	return nil
}

func mapCampaignEvidence(campaign kvCampaign, channel string, messages []campaignMessageEvidence) (canonical.CampaignArchive, error) {
	if len(messages) == 0 {
		return canonical.CampaignArchive{}, fmt.Errorf("klaviyo sent campaign %q has no preserved message content: %w", campaign.ID, adapter.ErrSourceUnavailable)
	}
	sentAt, err := campaignSentAt(campaign, messages)
	if err != nil {
		return canonical.CampaignArchive{}, err
	}
	subject := strings.TrimSpace(campaign.Attributes.Name)
	html := ""
	textBody := ""
	warnings := []string{"Klaviyo Reporting API metrics and per-recipient activity are not imported; recipient, open, and click totals remain unavailable."}
	if len(campaign.Relationships.Tags.Data) > 0 {
		warnings = append(warnings, "Campaign tag relationship IDs are retained, but tag display names and groups are not hydrated.")
	}
	messagePayloads := campaignMessagePayloads(messages)
	for i, evidence := range messages {
		if evidence.Message.Attributes.Definition == nil {
			return canonical.CampaignArchive{}, fmt.Errorf("klaviyo sent campaign %q has a message without a content definition: %w", campaign.ID, adapter.ErrSourceUnavailable)
		}
		content := evidence.Message.Attributes.Definition.Content
		if i != 0 {
			continue
		}
		switch channel {
		case "email":
			if value := firstString(content, "subject"); value != "" {
				subject = value
			}
			if len(evidence.Templates) > 0 {
				html = evidence.Templates[0].Attributes.HTML
				textBody = evidence.Templates[0].Attributes.Text
			}
			if strings.TrimSpace(html) == "" {
				warnings = append(warnings, "The sent email's related template did not expose rendered HTML; message metadata is preserved in the report payload.")
			}
		case "sms":
			textBody = firstString(content, "body")
			if textBody == "" {
				warnings = append(warnings, "The sent SMS message did not expose a text body.")
			}
		case "mobile_push":
			if value := firstString(content, "title", "name"); value != "" {
				subject = value
			}
			textBody = firstString(content, "body")
			warnings = append(warnings, "Mobile-push history is preserved as non-email archive evidence and is not an executable Moosewave email campaign.")
		}
	}
	if len(messages) > 1 {
		warnings = append(warnings, fmt.Sprintf("This campaign has %d message variants; the first returned variant is rendered because Klaviyo does not document relationship order as a primary/winner signal, while every variant remains in the report payload.", len(messages)))
	}
	return canonical.CampaignArchive{
		SourceID: campaign.ID,
		Subject:  subject,
		HTML:     html,
		Text:     textBody,
		SentAt:   sentAt,
		Report: map[string]interface{}{
			"provider":               "klaviyo",
			"api_revision":           apiRevision,
			"channel":                channel,
			"campaign":               structToMap(campaign),
			"messages":               messagePayloads,
			"reporting_api_imported": false,
		},
		Warnings:       warnings,
		SourcePlatform: canonical.SourceKlaviyo,
	}, nil
}

func campaignMessagePayloads(messages []campaignMessageEvidence) []interface{} {
	out := make([]interface{}, 0, len(messages))
	for _, evidence := range messages {
		out = append(out, map[string]interface{}{
			"message":   structToMap(evidence.Message),
			"templates": structSliceToMaps(evidence.Templates),
		})
	}
	return out
}

func campaignRebuildLimitations(campaign kvCampaign, messages []campaignMessageEvidence) []string {
	limitations := []string{}
	if len(campaign.Relationships.Tags.Data) > 0 {
		limitations = append(limitations, "Campaign tag relationship IDs are retained, but tag display names and groups are not hydrated; review taxonomy against a provider export before rebuilding targeting.")
	}
	if len(messages) == 0 {
		limitations = append(limitations, "Klaviyo returned no campaign-message relationship; only campaign-level metadata is available for rebuild or retirement review.")
	}
	for _, evidence := range messages {
		if evidence.Message.Attributes.Definition == nil {
			limitations = append(limitations, "Klaviyo returned a null campaign-message definition; metadata is retained, but content and channel settings require manual recovery or deliberate retirement.")
		}
		if evidence.Message.Relationships.Template.Data == nil && evidence.Message.Attributes.Definition != nil && strings.TrimSpace(evidence.Message.Attributes.Definition.Channel) == "email" {
			limitations = append(limitations, "Klaviyo returned no template relationship for this draft email message; inline definition metadata is retained, but rendered template content requires manual recovery or recreation.")
		}
		if evidence.Message.Relationships.Image.Data != nil {
			limitations = append(limitations, "The campaign-message image relationship ID is retained, but image metadata and binary content are not hydrated by this migration.")
		}
	}
	return uniqueStrings(limitations)
}

func campaignSentAt(campaign kvCampaign, messages []campaignMessageEvidence) (time.Time, error) {
	if campaignUsesRecipientLocalSendTime(campaign) {
		return time.Time{}, fmt.Errorf("klaviyo sent campaign %q uses recipient-local send strategy and has no single universal archive timestamp: %w", campaign.ID, adapter.ErrSourceUnavailable)
	}
	if raw := strings.TrimSpace(campaign.Attributes.SendTime); raw != "" {
		parsed, err := parseRequiredKlaviyoTime(raw)
		if err != nil {
			return time.Time{}, fmt.Errorf("klaviyo campaign %q send_time: %w", campaign.ID, err)
		}
		return parsed, nil
	}
	var earliest time.Time
	for _, evidence := range messages {
		for _, sendTime := range evidence.Message.Attributes.SendTimes {
			if sendTime.IsLocal == nil {
				return time.Time{}, fmt.Errorf("klaviyo campaign %q message send_time omitted is_local: %w", campaign.ID, adapter.ErrSourceUnavailable)
			}
			if *sendTime.IsLocal {
				return time.Time{}, fmt.Errorf("klaviyo sent campaign %q exposes only recipient-local message send time without one universal archive timestamp: %w", campaign.ID, adapter.ErrSourceUnavailable)
			}
			parsed, err := parseRequiredKlaviyoTime(sendTime.Datetime)
			if err != nil {
				return time.Time{}, fmt.Errorf("klaviyo campaign %q message send_time: %w", campaign.ID, err)
			}
			if earliest.IsZero() || parsed.Before(earliest) {
				earliest = parsed
			}
		}
	}
	if earliest.IsZero() {
		return time.Time{}, fmt.Errorf("klaviyo sent campaign %q has no send timestamp: %w", campaign.ID, adapter.ErrSourceUnavailable)
	}
	return earliest, nil
}

func campaignUsesRecipientLocalSendTime(campaign kvCampaign) bool {
	options, _ := campaign.Attributes.SendStrategy["options"].(map[string]interface{})
	isLocal, _ := options["is_local"].(bool)
	return isLocal
}

func encodeCampaignCursor(channel int, providerCursor string) string {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(providerCursor))
	return campaignCursorPrefix + strconv.Itoa(channel) + ":" + encoded
}

func decodeCampaignCursor(raw string) (int, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, "", nil
	}
	if len(raw) > 2*maxProviderCursorBytes || !strings.HasPrefix(raw, campaignCursorPrefix) {
		return 0, "", fmt.Errorf("klaviyo campaign archive cursor is invalid: %w", adapter.ErrSourceUnavailable)
	}
	parts := strings.SplitN(strings.TrimPrefix(raw, campaignCursorPrefix), ":", 2)
	if len(parts) != 2 {
		return 0, "", fmt.Errorf("klaviyo campaign archive cursor is invalid: %w", adapter.ErrSourceUnavailable)
	}
	channel, err := strconv.Atoi(parts[0])
	if err != nil || channel < 0 || channel >= len(campaignChannels) {
		return 0, "", fmt.Errorf("klaviyo campaign archive channel cursor is invalid: %w", adapter.ErrSourceUnavailable)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(decoded) > maxProviderCursorBytes {
		return 0, "", fmt.Errorf("klaviyo campaign archive provider cursor is invalid: %w", adapter.ErrSourceUnavailable)
	}
	return channel, string(decoded), nil
}

func structToMap(value interface{}) map[string]interface{} {
	raw, err := json.Marshal(value)
	if err != nil {
		return map[string]interface{}{"preservation_error": err.Error()}
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]interface{}{"preservation_error": err.Error()}
	}
	return out
}

func structSliceToMaps[T any](values []T) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(values))
	for _, value := range values {
		out = append(out, structToMap(value))
	}
	return out
}
