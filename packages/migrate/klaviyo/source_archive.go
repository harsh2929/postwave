// SPDX-License-Identifier: MIT

package klaviyo

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const klaviyoStaticArchiveTaskCount = 8

var klaviyoSourceArchivePhases = []klaviyoArchivePhase{
	{
		resourceType:  "klaviyo_commerce",
		sourceID:      "klaviyo:commerce",
		name:          "Catalogs, products, orders, coupons, recommendations",
		status:        "rebuild_task",
		productArea:   "commerce",
		targetSurface: "commerce.catalogs",
		lossReason:    "Commerce foundations exist, but connector-specific catalog, order, coupon, price-drop, back-in-stock, and recommendation state needs native translation before cutover.",
	},
	{
		resourceType:  "klaviyo_reviews",
		sourceID:      "klaviyo:reviews",
		name:          "Reviews, widgets, Q&A, media, review requests",
		status:        "rebuild_task",
		productArea:   "reviews",
		targetSurface: "reviews.product_reviews",
		lossReason:    "Reviews foundations exist; review request flows, media upload links, moderation settings, widget styling, Q&A, and approved public projections need migration-specific materialization.",
	},
	{
		resourceType:  "klaviyo_service",
		sourceID:      "klaviyo:service",
		name:          "Customer Hub, Helpdesk, Customer Agent",
		status:        "rebuild_task",
		productArea:   "service",
		targetSurface: "service_suite.support_conversations",
		lossReason:    "Service Suite foundations exist; conversations, hub layout, web chat, macros, spam assessment, agent knowledge, and handoff rules require source-specific rebuild tasks.",
	},
	{
		resourceType:  "klaviyo_cdp",
		sourceID:      "klaviyo:cdp",
		name:          "Custom objects, transformations, warehouse sync/import",
		status:        "rebuild_task",
		productArea:   "cdp",
		targetSurface: "predicate_registry.custom_objects.warehouse",
		lossReason:    "CDP foundations exist for predicates, custom objects, predictive scores, and warehouse syncs; object schemas, transforms, sync connections, and row mappings need explicit migration records.",
	},
	{
		resourceType:  "klaviyo_multi_email_profiles",
		sourceID:      "klaviyo:multi_email_profiles",
		name:          "Multi-Email Profile identities and per-address consent",
		status:        "manual_review",
		productArea:   "audience",
		targetSurface: "subscribers.subscriber_emails",
		lossReason:    "Klaviyo's stable Get Profiles response does not expose secondary profile email identifiers or their independent consent/suppression state. Use a provider export or retained Klaviyo access to inventory, reconcile, and explicitly approve every secondary address before cutover.",
	},
	{
		resourceType:  "klaviyo_omni_channel",
		sourceID:      "klaviyo:omni_channels",
		name:          "WhatsApp, RCS, push, SMS channel state",
		status:        "rebuild_task",
		productArea:   "channels",
		targetSurface: "omnichannel.channel_sender_profiles",
		lossReason:    "Omnichannel foundations exist, but provider credentials, template approvals, sender registrations, quiet hours, and channel-specific consent require operator review.",
	},
	{
		resourceType:  "klaviyo_deliverability",
		sourceID:      "klaviyo:deliverability",
		name:          "Domains, click tracking, IP routing, inbox/render entitlements",
		status:        "manual_review",
		productArea:   "deliverability",
		targetSurface: "deliverability_control",
		lossReason:    "Deliverability-control foundations exist, but DNS ownership, SSL, delegated routing, dedicated IP warmup, and plan entitlements cannot be migrated blindly.",
	},
	{
		resourceType:  "klaviyo_marketplace",
		sourceID:      "klaviyo:marketplace",
		name:          "Apps, partner integrations, OAuth installs",
		status:        "rebuild_task",
		productArea:   "developer_platform",
		targetSurface: "developer_marketplace.apps",
		lossReason:    "Developer marketplace foundations exist; app listings, OAuth installs, partner profiles, app webhooks, and credentials need explicit recreation or partner reauthorization.",
	},
}

type klaviyoArchivePhase struct {
	resourceType  string
	sourceID      string
	name          string
	status        string
	productArea   string
	targetSurface string
	lossReason    string
}

func (a *Adapter) ListSourceArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	idx, err := parseKlaviyoArchiveCursor(cursor)
	if err != nil {
		return nil, "", err
	}
	total := klaviyoStaticArchiveTaskCount + len(snapshot.Flows) + len(snapshot.Forms) + len(snapshot.NonEmailSentCampaigns) + len(snapshot.NonSentCampaigns) + len(snapshot.RebuildTemplates)
	if idx >= total {
		return nil, "", nil
	}
	var item canonical.SourceArchiveItem
	switch {
	case idx < len(klaviyoSourceArchivePhases):
		item = klaviyoArchiveItem(klaviyoSourceArchivePhases[idx])
	case idx < len(klaviyoSourceArchivePhases)+len(snapshot.Flows):
		item = klaviyoFlowArchiveItem(snapshot.Flows[idx-len(klaviyoSourceArchivePhases)])
	case idx < len(klaviyoSourceArchivePhases)+len(snapshot.Flows)+len(snapshot.Forms):
		offset := idx - len(klaviyoSourceArchivePhases) - len(snapshot.Flows)
		item = klaviyoFormArchiveItem(snapshot.Forms[offset])
	case idx < len(klaviyoSourceArchivePhases)+len(snapshot.Flows)+len(snapshot.Forms)+len(snapshot.NonEmailSentCampaigns):
		offset := idx - len(klaviyoSourceArchivePhases) - len(snapshot.Flows) - len(snapshot.Forms)
		item = klaviyoNonEmailCampaignArchiveItem(snapshot.NonEmailSentCampaigns[offset])
	case idx < len(klaviyoSourceArchivePhases)+len(snapshot.Flows)+len(snapshot.Forms)+len(snapshot.NonEmailSentCampaigns)+len(snapshot.NonSentCampaigns):
		offset := idx - len(klaviyoSourceArchivePhases) - len(snapshot.Flows) - len(snapshot.Forms) - len(snapshot.NonEmailSentCampaigns)
		item = klaviyoCampaignRebuildItem(snapshot.NonSentCampaigns[offset])
	default:
		offset := idx - len(klaviyoSourceArchivePhases) - len(snapshot.Flows) - len(snapshot.Forms) - len(snapshot.NonEmailSentCampaigns) - len(snapshot.NonSentCampaigns)
		item = klaviyoTemplateRebuildItem(snapshot.RebuildTemplates[offset])
	}
	next := ""
	if idx+1 < total {
		next = klaviyoArchiveCursor(idx + 1)
	}
	return []canonical.SourceArchiveItem{item}, next, nil
}

func klaviyoNonEmailCampaignArchiveItem(evidence campaignRebuildEvidence) canonical.SourceArchiveItem {
	campaign := evidence.Campaign
	return canonical.SourceArchiveItem{
		SourceID:       "klaviyo:non-email-campaign:" + campaign.ID,
		ResourceType:   "klaviyo_non_email_campaign_archive",
		Name:           campaign.Attributes.Name,
		Status:         "archived_evidence",
		SourcePlatform: canonical.SourceKlaviyo,
		Payload: map[string]interface{}{
			"source":         structToMap(campaign),
			"channel":        evidence.Channel,
			"messages":       campaignMessagePayloads(evidence.Messages),
			"api_revision":   apiRevision,
			"product_area":   "omnichannel",
			"target_surface": "migration.source_archive",
			"loss_reason":    "Sent non-email campaign content is retained as immutable source evidence only; it is never materialized as a Moosewave email campaign or executable SMS/push runtime.",
			"limitations":    campaignRebuildLimitations(campaign, evidence.Messages),
			"review_task":    map[string]interface{}{"status": "not_started", "owner": "", "test_evidence": ""},
		},
	}
}

func klaviyoFlowArchiveItem(flow kvResource) canonical.SourceArchiveItem {
	name := firstNonEmpty(resourceName(flow), "Klaviyo flow "+strings.TrimSpace(flow.ID))
	definitionAvailable := flowDefinitionAvailable(flow)
	lossReason := "The complete encoded Klaviyo flow definition is retained for manual rebuild, testing, or explicit retirement; it is never activated as a Moosewave runtime graph automatically."
	if !definitionAvailable {
		lossReason = "Klaviyo returned a null encoded definition for this flow. Available metadata is retained, but the graph is not rebuild-complete; recover it from a provider export or explicitly retire the flow during review."
	}
	return canonical.SourceArchiveItem{
		SourceID:       "klaviyo:flow:" + flow.ID,
		ResourceType:   "klaviyo_flow_rebuild",
		Name:           name,
		Status:         "rebuild_task",
		SourcePlatform: canonical.SourceKlaviyo,
		Payload: map[string]interface{}{
			"source":               resourceSource(flow),
			"api_revision":         apiRevision,
			"product_area":         "automations",
			"target_surface":       "automations.flows",
			"definition_available": definitionAvailable,
			"loss_reason":          lossReason,
			"rebuild_task":         map[string]interface{}{"status": "not_started", "owner": "", "test_evidence": ""},
		},
	}
}

func flowDefinitionAvailable(flow kvResource) bool {
	definition, present := rawMap(flow.Attributes)["definition"]
	return present && definition != nil
}

func klaviyoFormArchiveItem(form kvResource) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:       "klaviyo:form:" + form.ID,
		ResourceType:   "klaviyo_form",
		Name:           resourceName(form),
		Status:         "rebuild_task",
		SourcePlatform: canonical.SourceKlaviyo,
		Payload: map[string]interface{}{
			"source":         resourceSource(form),
			"api_revision":   apiRevision,
			"product_area":   "onsite_growth",
			"target_surface": "onsite_growth.forms",
			"loss_reason":    "Form inventory and provider metadata are preserved, but layout, versions, targeting, A/B state, rewards, and coupon behavior require a reviewed native rebuild.",
			"rebuild_task":   map[string]interface{}{"status": "not_started", "owner": "", "test_evidence": ""},
		},
	}
}

func klaviyoCampaignRebuildItem(evidence campaignRebuildEvidence) canonical.SourceArchiveItem {
	campaign := evidence.Campaign
	return canonical.SourceArchiveItem{
		SourceID:       "klaviyo:campaign-rebuild:" + campaign.ID,
		ResourceType:   "klaviyo_campaign_rebuild",
		Name:           campaign.Attributes.Name,
		Status:         strings.ToLower(strings.TrimSpace(campaign.Attributes.Status)),
		SourcePlatform: canonical.SourceKlaviyo,
		Payload: map[string]interface{}{
			"source":         structToMap(campaign),
			"channel":        evidence.Channel,
			"messages":       campaignMessagePayloads(evidence.Messages),
			"api_revision":   apiRevision,
			"product_area":   "campaigns",
			"target_surface": "campaigns.drafts",
			"loss_reason":    "Only sent campaigns become immutable campaign history; non-sent campaign state must be reviewed and recreated deliberately.",
			"limitations":    campaignRebuildLimitations(campaign, evidence.Messages),
			"rebuild_task":   map[string]interface{}{"status": "not_started", "owner": "", "test_evidence": ""},
		},
	}
}

func klaviyoTemplateRebuildItem(template kvTemplate) canonical.SourceArchiveItem {
	definitionAvailable := len(template.Attributes.Definition) > 0 && string(template.Attributes.Definition) != "null"
	lossReason := "This Klaviyo template exposes a structured editor definition without rendered HTML and cannot be imported as an editable Moosewave template automatically."
	if !definitionAvailable {
		lossReason = "This Klaviyo template has no rendered HTML and Klaviyo returned no structured definition. Metadata is retained, but template content requires provider export recovery, manual recreation, or explicit retirement."
	}
	return canonical.SourceArchiveItem{
		SourceID:       "klaviyo:template-rebuild:" + template.ID,
		ResourceType:   "klaviyo_template_rebuild",
		Name:           template.Attributes.Name,
		Status:         "rebuild_task",
		SourcePlatform: canonical.SourceKlaviyo,
		Payload: map[string]interface{}{
			"source":               structToMap(template),
			"api_revision":         apiRevision,
			"product_area":         "templates",
			"target_surface":       "email_templates",
			"definition_available": definitionAvailable,
			"loss_reason":          lossReason,
			"rebuild_task":         map[string]interface{}{"status": "not_started", "owner": "", "test_evidence": ""},
		},
	}
}

func klaviyoArchiveItem(phase klaviyoArchivePhase) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:       phase.sourceID,
		ResourceType:   phase.resourceType,
		Name:           phase.name,
		Status:         phase.status,
		SourcePlatform: canonical.SourceKlaviyo,
		Payload: map[string]interface{}{
			"product_area":   phase.productArea,
			"target_surface": phase.targetSurface,
			"loss_reason":    phase.lossReason,
			"rebuild_task": map[string]interface{}{
				"status":            "not_started",
				"owner":             "",
				"test_evidence":     "",
				"native_foundation": true,
			},
		},
	}
}

func parseKlaviyoArchiveCursor(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	if !strings.HasPrefix(raw, "klv18:") {
		return 0, fmt.Errorf("klaviyo: bad source archive cursor %q", raw)
	}
	idx, err := strconv.Atoi(strings.TrimPrefix(raw, "klv18:"))
	if err != nil || idx < 0 {
		return 0, fmt.Errorf("klaviyo: bad source archive cursor %q", raw)
	}
	return idx, nil
}

func klaviyoArchiveCursor(idx int) string {
	return fmt.Sprintf("klv18:%d", idx)
}
