// SPDX-License-Identifier: MIT

package customerio

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

var newsletterContentSlotPattern = regexp.MustCompile(`\{\{\s*content\s*\}\}`)

const (
	resourceCampaignWorkflow     = "customerio_campaign_workflow"
	resourceBroadcastWorkflow    = "customerio_broadcast_workflow"
	resourceNewsletter           = "customerio_newsletter"
	resourceTransactionalMessage = "customerio_transactional_message"
	resourceDesignEmailRebuild   = "customerio_design_email_rebuild"
	resourceSubscriptionTopic    = "customerio_subscription_topic"
	resourceSubscriptionChannel  = "customerio_subscription_channel"
	resourceESPSuppression       = "customerio_esp_suppression"
	resourceChannelOptout        = "customerio_channel_optout"
	resourceObjectType           = "customerio_object_type"
	resourceMigrationChecklist   = "customerio_migration_checklist"
)

func mapNewsletterArchive(newsletter cioNewsletterEvidence) (canonical.CampaignArchive, bool, string, error) {
	if newsletter.Resource.Type != "email" || newsletter.Resource.SentAt <= 0 {
		return canonical.CampaignArchive{}, false, "", fmt.Errorf("customerio newsletter %q is not a sent email: %w", newsletter.Resource.ID, adapter.ErrSourceUnavailable)
	}
	sentAt := time.Unix(newsletter.Resource.SentAt, 0).UTC()
	if sentAt.After(time.Now().UTC().Add(5 * time.Minute)) {
		return canonical.CampaignArchive{}, false, "", fmt.Errorf("customerio newsletter %q has a future sent_at timestamp: %w", newsletter.Resource.ID, adapter.ErrSourceUnavailable)
	}
	variants := make([]cioResource, 0, len(newsletter.Contents))
	defaults := make([]cioResource, 0, 1)
	for _, content := range newsletter.Contents {
		if content.Type != "email" {
			continue
		}
		variants = append(variants, content)
		language, exists := content.Raw["language"]
		if !exists {
			continue
		}
		languageCode, valid := language.(string)
		if !valid {
			return canonical.CampaignArchive{}, false, "", fmt.Errorf("customerio sent email newsletter %q content %q has invalid language metadata: %w", newsletter.Resource.ID, content.ID, adapter.ErrSourceUnavailable)
		}
		if languageCode == "" {
			defaults = append(defaults, content)
		}
	}
	if len(variants) == 0 {
		return canonical.CampaignArchive{}, false, "", fmt.Errorf("customerio sent email newsletter %q has no email content variant: %w", newsletter.Resource.ID, adapter.ErrSourceUnavailable)
	}
	sortNewsletterContents(variants)
	sortNewsletterContents(defaults)
	if len(defaults) == 0 {
		return canonical.CampaignArchive{}, false, "", fmt.Errorf("customerio sent email newsletter %q has no default content with language=\"\"; refusing to materialize a translation as campaign history: %w", newsletter.Resource.ID, adapter.ErrSourceUnavailable)
	}
	primary := defaults[0]
	subject := sourceString(primary.Raw, "subject")
	if subject == "" {
		subject = firstNonEmpty(newsletter.Resource.Name, "Customer.io newsletter "+newsletter.Resource.ID)
	}
	variantPayloads := make([]map[string]interface{}, 0, len(variants))
	for _, variant := range variants {
		variantPayloads = append(variantPayloads, cloneJSONMap(variant.Raw))
	}
	html, materialized, fidelityWarning := composeNewsletterHTML(primary.Raw)
	if !materialized {
		reason := fmt.Sprintf("Customer.io sent email newsletter %s default content %s is retained as source evidence only: %s", newsletter.Resource.ID, primary.ID, fidelityWarning)
		return canonical.CampaignArchive{}, false, reason, nil
	}
	warnings := []string{
		"Customer.io does not expose an unbounded lifetime delivery-count report for this newsletter; recipient/open/click totals remain unset.",
		fidelityWarning,
	}
	if len(defaults) > 1 {
		warnings = append(warnings, fmt.Sprintf("This newsletter has %d empty-language default/A/B contents. Content %s, the lowest stable content ID in that set, is materialized as the representative archive; every variant is retained in report evidence and the source archive.", len(defaults), primary.ID))
	} else if len(variants) > 1 {
		warnings = append(warnings, fmt.Sprintf("This newsletter has %d language or A/B variants. Its explicit default-language content (language=\"\") is materialized; every variant is retained in report evidence and the source archive.", len(variants)))
	}
	defaultContentIDs := make([]string, 0, len(defaults))
	for _, content := range defaults {
		defaultContentIDs = append(defaultContentIDs, content.ID)
	}
	return canonical.CampaignArchive{
		SourceID: "customerio:newsletter:" + newsletter.Resource.ID,
		Subject:  subject,
		HTML:     html,
		Text:     sourceString(primary.Raw, "body_plain"),
		SentAt:   sentAt,
		Report: map[string]interface{}{
			"customerio_newsletter": cloneJSONMap(newsletter.Resource.Raw),
			"content_variants":      variantPayloads,
			"default_content_ids":   defaultContentIDs,
			"selected_content_id":   primary.ID,
		},
		Warnings:       warnings,
		SourcePlatform: canonical.SourceCustomerIO,
	}, true, "", nil
}

func sortNewsletterContents(contents []cioResource) {
	sort.Slice(contents, func(i, j int) bool {
		left, leftErr := strconv.ParseUint(contents[i].ID, 10, 64)
		right, rightErr := strconv.ParseUint(contents[j].ID, 10, 64)
		if leftErr == nil && rightErr == nil && left != right {
			return left < right
		}
		return contents[i].ID < contents[j].ID
	})
}

func composeNewsletterHTML(payload map[string]interface{}) (string, bool, string) {
	body, bodyIsString := payload["body"].(string)
	if !bodyIsString || strings.TrimSpace(body) == "" {
		return "", false, "the default content has no non-empty string body, so no campaign HTML was synthesized"
	}

	layoutValue, hasLayout := payload["layout"]
	if !hasLayout || layoutValue == nil {
		return body, true, "Campaign HTML is the exact Customer.io source body because no layout was returned; it is not provider-rendered output. Resolve Liquid and validate destination rendering before reuse."
	}
	layout, layoutIsString := layoutValue.(string)
	if !layoutIsString {
		return "", false, "the returned layout is not a string, so layout/body composition cannot be proven safe"
	}
	if strings.TrimSpace(layout) == "" {
		return body, true, "Campaign HTML is the exact Customer.io source body because the returned layout was empty; it is not provider-rendered output. Resolve Liquid and validate destination rendering before reuse."
	}

	slots := newsletterContentSlotPattern.FindAllStringIndex(layout, -1)
	if len(slots) != 1 {
		return "", false, fmt.Sprintf("the layout contains %d documented {{content}} slots; exactly one is required for deterministic source composition", len(slots))
	}
	start, end := slots[0][0], slots[0][1]
	return layout[:start] + body + layout[end:], true, "Campaign HTML is a deterministic composition of the exact Customer.io source layout and body at its single documented {{content}} slot; it is not provider-rendered output. Liquid, CSS preprocessing, assets, and per-recipient rendering were not executed and require destination validation."
}

func mapDesignEmailTemplate(email cioDesignEmailEvidence) (canonical.EmailTemplate, bool, error) {
	content, ok := email.Detail.Raw["content"].(map[string]interface{})
	if !ok {
		return canonical.EmailTemplate{}, false, fmt.Errorf("customerio Design Studio template %q omitted content: %w", email.Detail.ID, adapter.ErrSourceUnavailable)
	}
	htmlValue, hasHTML := content["html"]
	if !hasHTML || htmlValue == nil {
		return canonical.EmailTemplate{}, false, nil
	}
	html, htmlIsString := htmlValue.(string)
	if !htmlIsString {
		return canonical.EmailTemplate{}, false, fmt.Errorf("customerio Design Studio template %q returned non-string HTML: %w", email.Detail.ID, adapter.ErrSourceUnavailable)
	}
	if strings.TrimSpace(html) == "" {
		return canonical.EmailTemplate{}, false, nil
	}
	definition := map[string]interface{}{
		"email":        cloneJSONMap(email.Detail.Raw),
		"translations": cloneJSONValue(email.Translations),
	}
	raw, err := json.Marshal(definition)
	if err != nil {
		return canonical.EmailTemplate{}, false, fmt.Errorf("customerio Design Studio template %q source definition: %w", email.Detail.ID, err)
	}
	warnings := []string{"Customer.io Design Studio HTML is exact source content, not provider-rendered output. Resolve Customer.io components, Liquid, global styles/assets, and transformers, then validate destination rendering before reuse."}
	if len(email.Translations) > 0 {
		warnings = append(warnings, fmt.Sprintf("%d localized Design Studio variants are preserved in source_definition and require destination localization review.", len(email.Translations)))
	}
	defaultContent := map[string]interface{}{}
	if text := sourceString(content, "text"); text != "" {
		defaultContent["text"] = text
	}
	if amp := sourceString(content, "amp"); amp != "" {
		defaultContent["amp"] = amp
	}
	return canonical.EmailTemplate{
		SourceID:         email.Detail.ID,
		Name:             firstNonEmpty(email.Detail.Name, email.Summary.Name, "Customer.io Design Studio template "+email.Detail.ID),
		Subject:          sourceString(content, "subject"),
		PreviewText:      sourceString(content, "preheader_text"),
		HTML:             html,
		DefaultContent:   defaultContent,
		SourceDefinition: string(raw),
		Warnings:         warnings,
		SourcePlatform:   canonical.SourceCustomerIO,
	}, true, nil
}

func buildSourceArchive(snapshot *customerIOSnapshot) []canonical.SourceArchiveItem {
	items := make([]canonical.SourceArchiveItem, 0,
		len(snapshot.Campaigns)+len(snapshot.Broadcasts)+len(snapshot.Newsletters)+
			len(snapshot.Transactional)+len(snapshot.DesignEmails)+len(snapshot.Topics)+len(snapshot.Channels)+
			len(snapshot.Suppressions)+len(snapshot.Optouts)+len(snapshot.ObjectTypes)+8)

	for _, campaign := range snapshot.Campaigns {
		items = append(items, workflowArchiveItem(campaign, resourceCampaignWorkflow, "customerio:campaign:"))
	}
	for _, broadcast := range snapshot.Broadcasts {
		items = append(items, workflowArchiveItem(broadcast, resourceBroadcastWorkflow, "customerio:broadcast:"))
	}
	for _, newsletter := range snapshot.Newsletters {
		contents := make([]map[string]interface{}, 0, len(newsletter.Contents))
		for _, content := range newsletter.Contents {
			contents = append(contents, cloneJSONMap(content.Raw))
		}
		warnings := []string{"Newsletter definition and all returned variants are preserved for audit/rebuild."}
		if newsletter.Resource.SentAt <= 0 {
			warnings = append(warnings, "This newsletter is unsent; it is not materialized as campaign history.")
		} else if newsletter.Resource.Type != "email" {
			warnings = append(warnings, "This sent non-email newsletter is source evidence only; channel sender/runtime continuity is not imported.")
		}
		if newsletter.ArchiveSourceOnlyReason != "" {
			warnings = append(warnings, newsletter.ArchiveSourceOnlyReason)
		}
		items = append(items, canonical.SourceArchiveItem{
			SourceID:     "customerio:newsletter:" + newsletter.Resource.ID,
			ResourceType: resourceNewsletter,
			Name:         firstNonEmpty(newsletter.Resource.Name, "Customer.io newsletter "+newsletter.Resource.ID),
			Status:       newsletterStatus(newsletter.Resource),
			OccurredAt:   resourceOccurredAt(newsletter.Resource),
			Payload: map[string]interface{}{
				"newsletter": cloneJSONMap(newsletter.Resource.Raw),
				"contents":   contents,
			},
			Warnings:       warnings,
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}
	for _, transactional := range snapshot.Transactional {
		contents := make([]map[string]interface{}, 0, len(transactional.Contents))
		for _, content := range transactional.Contents {
			contents = append(contents, cloneJSONMap(content.Raw))
		}
		items = append(items, canonical.SourceArchiveItem{
			SourceID:     "customerio:transactional:" + transactional.Resource.ID,
			ResourceType: resourceTransactionalMessage,
			Name:         firstNonEmpty(transactional.Resource.Name, "Customer.io transactional message "+transactional.Resource.ID),
			Status:       transactional.Resource.State,
			OccurredAt:   resourceOccurredAt(transactional.Resource),
			Payload: map[string]interface{}{
				"message":  cloneJSONMap(transactional.Resource.Raw),
				"contents": contents,
			},
			Warnings:       []string{"Transactional definition is preserved for manual rebuild; delivery history and trigger-name/runtime continuity are not imported."},
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}
	for _, email := range snapshot.DesignEmails {
		content, _ := email.Detail.Raw["content"].(map[string]interface{})
		if sourceString(content, "html") != "" {
			continue
		}
		items = append(items, canonical.SourceArchiveItem{
			SourceID:     "customerio:design_email:" + email.Detail.ID,
			ResourceType: resourceDesignEmailRebuild,
			Name:         firstNonEmpty(email.Detail.Name, email.Summary.Name, "Customer.io Design Studio template "+email.Detail.ID),
			OccurredAt:   resourceOccurredAt(email.Detail),
			Payload: map[string]interface{}{
				"email":        cloneJSONMap(email.Detail.Raw),
				"translations": cloneJSONValue(email.Translations),
			},
			Warnings:       []string{"The reusable Design Studio email has no HTML default body and cannot become an editable destination template; it is preserved for rebuild."},
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}
	for _, topic := range snapshot.Topics {
		payload := map[string]interface{}{
			"id":                    strings.TrimSpace(string(topic.ID)),
			"identifier":            topic.Identifier,
			"name":                  topic.Name,
			"description":           topic.Description,
			"subscribed_by_default": topic.SubscribedByDefault,
			"membership_tag":        topicMembershipTag(topic.Identifier),
		}
		items = append(items, canonical.SourceArchiveItem{
			SourceID:       "customerio:subscription_topic:" + topic.Identifier,
			ResourceType:   resourceSubscriptionTopic,
			Name:           topicDisplayName(topic),
			Payload:        payload,
			Warnings:       []string{"Subscription-topic metadata and exact opted-in membership tags are preserved; verify destination send scoping before cutover."},
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}
	for _, channel := range snapshot.Channels {
		preferenceKey, _ := customerIOChannelPreferenceKey(channel.Type)
		payload := map[string]interface{}{
			"id":                    strings.TrimSpace(string(channel.ID)),
			"type":                  channel.Type,
			"preference_key":        preferenceKey,
			"name":                  channel.Name,
			"description":           channel.Description,
			"subscribed_by_default": channel.SubscribedByDefault,
		}
		items = append(items, canonical.SourceArchiveItem{
			SourceID:       "customerio:subscription_channel:" + preferenceKey,
			ResourceType:   resourceSubscriptionChannel,
			Name:           firstNonEmpty(strings.TrimSpace(channel.Name), "Customer.io subscription channel: "+preferenceKey),
			Payload:        payload,
			Warnings:       []string{"Subscription-channel definition and profile-level computed preference evidence are preserved; email delivery eligibility requires both applicable topic and email-channel consent."},
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}
	for _, suppression := range snapshot.Suppressions {
		identity := suppression.Type + "|" + strings.ToLower(strings.TrimSpace(suppression.Email)) + "|" + strconv.FormatInt(suppression.Created, 10) + "|" + suppression.Reason + "|" + suppression.Status
		items = append(items, canonical.SourceArchiveItem{
			SourceID:     "customerio:esp_suppression:" + stableDigest(identity),
			ResourceType: resourceESPSuppression,
			Name:         "Customer.io ESP suppression: " + suppression.Email,
			Status:       suppression.Type,
			OccurredAt:   unixTime(suppression.Created),
			Payload: map[string]interface{}{
				"email":  suppression.Email,
				"type":   suppression.Type,
				"reason": suppression.Reason,
				"status": suppression.Status,
			},
			Warnings:       []string{"This address is imported blocklisted; review ESP/domain-specific suppression portability before any re-enable."},
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}
	for _, optout := range snapshot.Optouts {
		payload := map[string]interface{}{
			"cio_id":       strings.TrimSpace(string(optout.CIOID)),
			"publisher_id": strings.TrimSpace(string(optout.CustomerID)),
			"optouts":      cloneJSONValue(optout.Optouts),
		}
		raw, _ := json.Marshal(payload)
		items = append(items, canonical.SourceArchiveItem{
			SourceID:        "customerio:channel_optout:" + stableDigest(string(raw)),
			ResourceType:    resourceChannelOptout,
			Name:            "Customer.io SMS/WhatsApp opt-out",
			LinkedContactID: strings.TrimSpace(string(optout.CIOID)),
			Payload:         payload,
			Warnings:        []string{"SMS/WhatsApp sender-specific opt-out evidence is preserved, but channel identity and sender continuity are not imported."},
			SourcePlatform:  canonical.SourceCustomerIO,
		})
	}
	for _, objectType := range snapshot.ObjectTypes {
		items = append(items, canonical.SourceArchiveItem{
			SourceID:       "customerio:object_type:" + objectType.ID,
			ResourceType:   resourceObjectType,
			Name:           firstNonEmpty(objectType.Name, sourceString(objectType.Raw, "singular_name"), "Customer.io object type "+objectType.ID),
			Status:         enabledStatus(objectType.Raw),
			Payload:        cloneJSONMap(objectType.Raw),
			Warnings:       []string{"Object-type metadata is preserved. The App API requires attribute filters and warns that object searches can duplicate rows; use Customer.io's UI export for complete object profiles and relationships."},
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}

	checklists := []struct {
		ID      string
		Name    string
		Warning string
	}{
		{"historical_profile_events", "Historical profile and behavioral events", "The Activities endpoint has no documented lower-bound timestamp or immutable complete-export guarantee; use Customer.io data-out/warehouse exports for historical event continuity."},
		{"delivery_history", "Per-recipient delivery and report history", "Campaign, broadcast, newsletter, and transactional delivery endpoints are time-windowed (typically one, six, or twelve months); they cannot certify complete lifetime delivery history."},
		{"broadcast_trigger_payloads", "API-broadcast trigger payloads and audiences", "Customer.io trigger IDs and created/processed timestamps are preserved with each API broadcast. The App API trigger list/detail does not return the original trigger payload, audience, or per-user data; reconcile that send context separately."},
		{"custom_object_profiles", "Custom object profiles and relationships", "Object search requires an attribute filter and may duplicate entries across pages; Customer.io recommends its export feature for complete objects and relationships."},
		{"connected_forms", "Connected forms", "No read/list Connected Forms endpoint is present in the documented App API; export and rebuild forms and form-trigger wiring manually."},
		{"commerce_data", "Commerce data", "Customer.io has no dedicated read-side commerce catalog/order export in the App API; reconcile event/object-backed commerce data through provider exports."},
		{"collections_snippets_assets", "Collections, snippets, assets, and design components", "These auxiliary content libraries are not materialized by the destination import; review and transfer referenced content before rebuilding workflows."},
		{"sender_channel_settings", "Sender identities, domains, channels, and deliverability settings", "Sender verification, domains, IP pools, link tracking, channel credentials, and device tokens are not portable and require explicit destination configuration."},
	}
	for _, checklist := range checklists {
		items = append(items, canonical.SourceArchiveItem{
			SourceID:     "customerio:checklist:" + checklist.ID,
			ResourceType: resourceMigrationChecklist,
			Name:         checklist.Name,
			Status:       "manual_review_required",
			Payload: map[string]interface{}{
				"inventory_kind":       "static_review_task",
				"source_api_inventory": false,
				"provider":             "customerio",
				"checklist_id":         checklist.ID,
			},
			Warnings:       []string{checklist.Warning},
			SourcePlatform: canonical.SourceCustomerIO,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		left := items[i].ResourceType + "\x00" + items[i].SourceID
		right := items[j].ResourceType + "\x00" + items[j].SourceID
		return left < right
	})
	return items
}

func workflowArchiveItem(workflow cioWorkflowEvidence, resourceType, prefix string) canonical.SourceArchiveItem {
	actions := make([]map[string]interface{}, 0, len(workflow.Actions))
	for _, action := range workflow.Actions {
		actions = append(actions, cloneJSONMap(action.Raw))
	}
	triggers := make([]map[string]interface{}, 0, len(workflow.Triggers))
	for _, trigger := range workflow.Triggers {
		triggers = append(triggers, cloneJSONMap(trigger.Raw))
	}
	return canonical.SourceArchiveItem{
		SourceID:     prefix + workflow.Resource.ID,
		ResourceType: resourceType,
		Name:         firstNonEmpty(workflow.Resource.Name, "Customer.io workflow "+workflow.Resource.ID),
		Status:       workflow.Resource.State,
		OccurredAt:   resourceOccurredAt(workflow.Resource),
		Payload: map[string]interface{}{
			"definition": cloneJSONMap(workflow.Resource.Raw),
			"actions":    actions,
			"triggers":   triggers,
		},
		Warnings:       []string{"Customer.io exposes workflow metadata and message/action definitions but not a complete executable graph; preserve as rebuild-only evidence and never activate without a manual rebuild and test."},
		SourcePlatform: canonical.SourceCustomerIO,
	}
}

func mapWorkflowAutomation(workflow cioWorkflowEvidence, resourceType, prefix string) (canonical.Automation, error) {
	actions := make([]map[string]interface{}, 0, len(workflow.Actions))
	for _, action := range workflow.Actions {
		actions = append(actions, cloneJSONMap(action.Raw))
	}
	triggers := make([]map[string]interface{}, 0, len(workflow.Triggers))
	for _, trigger := range workflow.Triggers {
		triggers = append(triggers, cloneJSONMap(trigger.Raw))
	}
	definition := map[string]interface{}{
		"migration_mode": "rebuild_review",
		"source_id":      prefix + workflow.Resource.ID,
		"resource_type":  resourceType,
		"definition":     cloneJSONMap(workflow.Resource.Raw),
		"actions":        actions,
		"triggers":       triggers,
		"limitation":     "Customer.io exposes workflow metadata and message/action definitions but not a complete executable graph. Rebuild and test this workflow manually before activation.",
	}
	raw, err := json.Marshal(definition)
	if err != nil {
		return canonical.Automation{}, fmt.Errorf("customerio workflow %q source definition: %w", workflow.Resource.ID, err)
	}
	return canonical.Automation{
		Name:             firstNonEmpty(workflow.Resource.Name, "Customer.io workflow "+workflow.Resource.ID),
		Status:           "draft",
		Triggers:         nil,
		Nodes:            nil,
		Edges:            nil,
		SourceDefinition: string(raw),
	}, nil
}

func resourceOccurredAt(resource cioResource) *time.Time {
	if resource.UpdatedAt > 0 {
		return unixTime(resource.UpdatedAt)
	}
	return unixTime(resource.CreatedAt)
}

func newsletterStatus(resource cioResource) string {
	if resource.SentAt > 0 {
		return "sent"
	}
	if resource.State != "" {
		return resource.State
	}
	return "unsent"
}

func enabledStatus(payload map[string]interface{}) string {
	if enabled, present := sourceBool(payload, "enabled"); present {
		if enabled {
			return "enabled"
		}
		return "disabled"
	}
	return ""
}

func stableDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func cloneJSONMap(in map[string]interface{}) map[string]interface{} {
	if in == nil {
		return nil
	}
	cloned, _ := cloneJSON(in)
	return cloned
}

func cloneJSONValue[T any](in T) T {
	cloned, _ := cloneJSON(in)
	return cloned
}

func cloneJSON[T any](in T) (T, error) {
	var out T
	raw, err := json.Marshal(in)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, err
	}
	return out, nil
}

func cloneSubscribers(in []canonical.Subscriber) []canonical.Subscriber {
	return cloneJSONValue(in)
}

func cloneCampaignArchive(in []canonical.CampaignArchive) []canonical.CampaignArchive {
	return cloneJSONValue(in)
}

func cloneTemplates(in []canonical.EmailTemplate) []canonical.EmailTemplate {
	return cloneJSONValue(in)
}

func cloneSourceArchive(in []canonical.SourceArchiveItem) []canonical.SourceArchiveItem {
	return cloneJSONValue(in)
}
