package mailchimpv3

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var mailchimpCompatLongTailState = struct {
	sync.Mutex
	items map[string]compatStateRecord
}{items: map[string]compatStateRecord{}}

type compatStateRecord struct {
	TenantID string
	Kind     string
	ItemID   string
	Payload  map[string]any
}

func (d *Deps) ListSegments(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	items := filterCompatItems(d.listCompatItems(r, t, "list_segment"), "list_id", listID)
	writeJSON(w, http.StatusOK, map[string]any{"segments": items, "list_id": listID, "total_items": len(items)})
}

func (d *Deps) CreateSegment(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	name := strings.TrimSpace(firstNonEmpty(stringValue(in, "name"), "Mailchimp segment"))
	now := time.Now().UTC()
	id := firstNonEmpty(stringValue(in, "id"), stableID(fmt.Sprintf("segment:%s:%s:%d", listID, name, now.UnixNano())))
	out := map[string]any{
		"id":             id,
		"list_id":        listID,
		"name":           name,
		"type":           firstNonEmpty(stringValue(in, "type"), segmentTypeFromInput(in)),
		"options":        nonNilMap(anyMap(in["options"])),
		"member_count":   0,
		"static_members": []string{},
		"created_at":     now,
		"updated_at":     now,
	}
	mergeMaps(out, in)
	d.saveCompatItem(r.Context(), t, "list_segment", segmentItemID(listID, id), out)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetSegment(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	item, found := d.getCompatItem(r.Context(), t, "list_segment", segmentItemID(listID, chi.URLParam(r, "segment_id")))
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested segment could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (d *Deps) UpdateSegment(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	itemID := segmentItemID(listID, chi.URLParam(r, "segment_id"))
	item, found := d.getCompatItem(r.Context(), t, "list_segment", itemID)
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested segment could not be found.")
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	mergeMaps(item, in)
	item["updated_at"] = time.Now().UTC()
	d.saveCompatItem(r.Context(), t, "list_segment", itemID, item)
	writeJSON(w, http.StatusOK, item)
}

func (d *Deps) DeleteSegment(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	d.deleteCompatItem(r.Context(), t, "list_segment", segmentItemID(listID, chi.URLParam(r, "segment_id")))
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListSegmentMembers(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	item, found := d.getCompatItem(r.Context(), t, "list_segment", segmentItemID(listID, chi.URLParam(r, "segment_id")))
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested segment could not be found.")
		return
	}
	members := segmentMemberRows(stringSliceFromAny(item["static_members"]))
	writeJSON(w, http.StatusOK, map[string]any{"members": members, "list_id": listID, "segment_id": item["id"], "total_items": len(members)})
}

func (d *Deps) AddSegmentMember(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	email := firstNonEmpty(stringValue(in, "email_address"), stringValue(in, "email"), stringValue(in, "subscriber_hash"))
	item, status, ok := d.addSegmentMembers(r.Context(), t, listID, chi.URLParam(r, "segment_id"), []string{email}, nil)
	if !ok {
		writeProblem(w, status, "Resource Not Found", "The requested segment could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"segment": item, "email_address": email, "status": "added"})
}

func (d *Deps) RemoveSegmentMember(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	_, status, ok := d.addSegmentMembers(r.Context(), t, listID, chi.URLParam(r, "segment_id"), nil, []string{chi.URLParam(r, "subscriber_hash")})
	if !ok {
		writeProblem(w, status, "Resource Not Found", "The requested segment could not be found.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) BatchUpdateSegmentMembers(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	item, status, ok := d.addSegmentMembers(r.Context(), t, listID, chi.URLParam(r, "segment_id"), stringSliceFromAny(in["members_to_add"]), stringSliceFromAny(in["members_to_remove"]))
	if !ok {
		writeProblem(w, status, "Resource Not Found", "The requested segment could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (d *Deps) ListListWebhooks(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	items := filterCompatItems(d.listCompatItems(r, t, "list_webhook"), "list_id", listID)
	writeJSON(w, http.StatusOK, map[string]any{"webhooks": items, "list_id": listID, "total_items": len(items)})
}

func (d *Deps) CreateListWebhook(w http.ResponseWriter, r *http.Request) {
	d.upsertListWebhook(w, r, "")
}

func (d *Deps) GetListWebhook(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	item, found := d.getCompatItem(r.Context(), t, "list_webhook", listWebhookItemID(listID, chi.URLParam(r, "webhook_id")))
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested webhook could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (d *Deps) UpdateListWebhook(w http.ResponseWriter, r *http.Request) {
	d.upsertListWebhook(w, r, chi.URLParam(r, "webhook_id"))
}

func (d *Deps) DeleteListWebhook(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	d.deleteCompatItem(r.Context(), t, "list_webhook", listWebhookItemID(listID, chi.URLParam(r, "webhook_id")))
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListCampaignFolders(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	items := d.listCompatItems(r, t, "campaign_folder")
	writeJSON(w, http.StatusOK, map[string]any{"folders": items, "total_items": len(items)})
}

func (d *Deps) CreateCampaignFolder(w http.ResponseWriter, r *http.Request) {
	d.upsertCampaignFolder(w, r, "")
}

func (d *Deps) GetCampaignFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	item, found := d.getCompatItem(r.Context(), t, "campaign_folder", chi.URLParam(r, "folder_id"))
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested campaign folder could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (d *Deps) UpdateCampaignFolder(w http.ResponseWriter, r *http.Request) {
	d.upsertCampaignFolder(w, r, chi.URLParam(r, "folder_id"))
}

func (d *Deps) DeleteCampaignFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	d.deleteCompatItem(r.Context(), t, "campaign_folder", chi.URLParam(r, "folder_id"))
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListCampaignFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	campaignID := chi.URLParam(r, "campaign_id")
	items := filterCompatItems(d.listCompatItems(r, t, "campaign_feedback"), "campaign_id", campaignID)
	writeJSON(w, http.StatusOK, map[string]any{"feedback": items, "campaign_id": campaignID, "total_items": len(items)})
}

func (d *Deps) CreateCampaignFeedback(w http.ResponseWriter, r *http.Request) {
	d.upsertCampaignFeedback(w, r, "")
}

func (d *Deps) GetCampaignFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	item, found := d.getCompatItem(r.Context(), t, "campaign_feedback", campaignFeedbackItemID(chi.URLParam(r, "campaign_id"), chi.URLParam(r, "feedback_id")))
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested campaign feedback could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (d *Deps) UpdateCampaignFeedback(w http.ResponseWriter, r *http.Request) {
	d.upsertCampaignFeedback(w, r, chi.URLParam(r, "feedback_id"))
}

func (d *Deps) DeleteCampaignFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	d.deleteCompatItem(r.Context(), t, "campaign_feedback", campaignFeedbackItemID(chi.URLParam(r, "campaign_id"), chi.URLParam(r, "feedback_id")))
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) CampaignSendChecklist(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	campaignID := chi.URLParam(r, "campaign_id")
	campaign, err := d.Store.GetCampaign(r.Context(), t, campaignID)
	if err != nil {
		writeStoreError(w, err, "campaign")
		return
	}
	content, _ := d.Store.CampaignContent(r.Context(), t, campaignID)
	contentHTML := ""
	contentText := ""
	blockCount := 0
	if content != nil {
		contentHTML = firstNonEmpty(content.HTML, content.ArchiveHTML)
		contentText = content.PlainText
		blockCount = len(content.Blocks)
	}
	items := []map[string]any{
		checklistItem("subject", "Subject line", strings.TrimSpace(stringValue(campaign.Settings, "subject_line")) != "" || strings.TrimSpace(stringValue(campaign.Settings, "title")) != "", "Campaign has a subject or title source."),
		checklistItem("from", "From and reply-to", strings.TrimSpace(stringValue(campaign.Settings, "from_name")) != "" && strings.TrimSpace(stringValue(campaign.Settings, "reply_to")) != "", "From name and reply-to are present on the campaign or tenant defaults."),
		checklistItem("recipients", "Recipients", campaignHasRecipients(campaign), "Recipients use list, saved segment, static segment, or Moosewave campaign audience selection."),
		checklistItem("content", "Content", strings.TrimSpace(contentHTML) != "" || strings.TrimSpace(contentText) != "" || blockCount > 0, "Campaign has HTML, plain text, or block content."),
		checklistItem("links", "Links", contentHasUsableLink(contentHTML) || blockCount > 0, "At least one CTA/link or block-level link exists for click tracking."),
		checklistItem("compliance_footer", "Compliance footer", contentHasComplianceFooter(contentHTML, contentText), "Unsubscribe/archive footer merge tag or Moosewave compliance footer marker is present."),
		checklistItem("merge_tags", "Merge tags", mailchimpMergeTagsBalanced(contentHTML+" "+contentText), "Mailchimp-style merge tags appear syntactically balanced."),
		checklistItem("dynamic_blocks", "Dynamic blocks", campaignDynamicBlocksReady(content), "Dynamic, RSS, product, survey, and video blocks have fallback data or are renderable locally."),
		checklistItem("tracking", "Tracking", campaignTrackingReady(campaign.Tracking), "Open, click, ecommerce, and UTM tracking are normalized into campaign_report_events."),
		checklistItem("schedule_state", "Schedule/send state", campaign.Status != "sending", "Campaign is not already mid-send; schedule/send/cancel actions can be rehearsed safely."),
	}
	ready := true
	for _, item := range items {
		if item["status"] != "ok" {
			ready = false
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"campaign_id": campaignID,
		"is_ready":    ready,
		"items":       items,
		"summary": map[string]any{
			"warnings":     checklistWarningCount(items),
			"block_count":  blockCount,
			"has_html":     strings.TrimSpace(contentHTML) != "",
			"has_plain":    strings.TrimSpace(contentText) != "",
			"status":       campaign.Status,
			"mailchimp_v3": true,
		},
		"generated_at": time.Now().UTC(),
	})
}

func (d *Deps) TriggerCustomerJourneyStep(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	email := strings.TrimSpace(firstNonEmpty(stringValue(in, "email_address"), stringValue(in, "email")))
	if email == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "email_address is required.")
		return
	}
	now := time.Now().UTC()
	id := stableID(fmt.Sprintf("journey-trigger:%s:%s:%s:%d", chi.URLParam(r, "journey_id"), chi.URLParam(r, "step_id"), email, now.UnixNano()))
	out := map[string]any{
		"id":            id,
		"journey_id":    chi.URLParam(r, "journey_id"),
		"step_id":       chi.URLParam(r, "step_id"),
		"email_address": email,
		"status":        "triggered",
		"payload":       nonNilMap(in),
		"triggered_at":  now,
		"execution":     "recorded_for_postwave_automation_handoff",
	}
	d.saveCompatItem(r.Context(), t, "journey_trigger", id, out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListEcommerceCustomers(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	storeID := chi.URLParam(r, "store_id")
	items := filterCompatItems(d.listCompatItems(r, t, "ecommerce_customer"), "store_id", storeID)
	writeJSON(w, http.StatusOK, map[string]any{"customers": items, "store_id": storeID, "total_items": len(items)})
}

func (d *Deps) UpsertEcommerceCustomer(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	storeID := chi.URLParam(r, "store_id")
	customerID := firstNonEmpty(chi.URLParam(r, "customer_id"), stringValue(in, "id"), stringValue(in, "email_address"), stringValue(in, "email"))
	if customerID == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Customer id or email_address is required.")
		return
	}
	now := time.Now().UTC()
	out := map[string]any{"id": customerID, "store_id": storeID, "created_at": now, "updated_at": now}
	if existing, found := d.getCompatItem(r.Context(), t, "ecommerce_customer", ecommerceCustomerItemID(storeID, customerID)); found {
		out = existing
		out["updated_at"] = now
	}
	mergeMaps(out, in)
	out["id"] = customerID
	out["store_id"] = storeID
	d.saveCompatItem(r.Context(), t, "ecommerce_customer", ecommerceCustomerItemID(storeID, customerID), out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetEcommerceCustomer(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	item, found := d.getCompatItem(r.Context(), t, "ecommerce_customer", ecommerceCustomerItemID(chi.URLParam(r, "store_id"), chi.URLParam(r, "customer_id")))
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested ecommerce customer could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (d *Deps) DeleteEcommerceCustomer(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	d.deleteCompatItem(r.Context(), t, "ecommerce_customer", ecommerceCustomerItemID(chi.URLParam(r, "store_id"), chi.URLParam(r, "customer_id")))
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListAuthorizedApps(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	items := d.listCompatItems(r, t, "authorized_app")
	if len(items) == 0 {
		items = []map[string]any{defaultAuthorizedApp(t)}
	}
	writeJSON(w, http.StatusOK, map[string]any{"apps": items, "total_items": len(items)})
}

func (d *Deps) GetAuthorizedApp(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	appID := chi.URLParam(r, "app_id")
	if appID == "postwave-mailchimp-compat" {
		writeJSON(w, http.StatusOK, defaultAuthorizedApp(t))
		return
	}
	item, found := d.getCompatItem(r.Context(), t, "authorized_app", appID)
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested authorized app could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (d *Deps) TransactionalCatalog(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "foundation_ready_fail_closed",
		"product": "mailchimp_transactional_compat",
		"capabilities": []map[string]any{
			{"feature": "transactional_templates", "status": "available_metadata"},
			{"feature": "send_template", "status": "recorded_requires_provider"},
			{"feature": "smtp_relay", "status": "external_provider_required"},
			{"feature": "transactional_sms", "status": "external_provider_required"},
		},
		"provider_contract": map[string]any{
			"mailchimp_transactional": "external Mandrill-style API; Moosewave records intent and template metadata until a provider is configured",
			"recommended_native":      []string{"postmark", "ses", "resend", "mailchimp_transactional"},
		},
	})
}

func (d *Deps) ListTransactionalTemplates(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	items := d.listCompatItems(r, t, "transactional_template")
	writeJSON(w, http.StatusOK, map[string]any{"templates": items, "total_items": len(items)})
}

func (d *Deps) UpsertTransactionalTemplate(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	name := strings.TrimSpace(firstNonEmpty(stringValue(in, "name"), stringValue(in, "slug"), "transactional-template"))
	now := time.Now().UTC()
	out := map[string]any{"id": stableID("transactional-template:" + name), "name": name, "status": "stored", "created_at": now, "updated_at": now}
	mergeMaps(out, in)
	d.saveCompatItem(r.Context(), t, "transactional_template", fmt.Sprint(out["id"]), out)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) SendTransactionalTemplate(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	now := time.Now().UTC()
	id := stableID(fmt.Sprintf("transactional-message:%s:%d", t.ID, now.UnixNano()))
	out := map[string]any{
		"id":            id,
		"status":        "accepted_provider_required",
		"template_name": firstNonEmpty(stringValue(in, "template_name"), stringValue(in, "template_slug")),
		"to":            in["to"],
		"merge_vars":    in["merge_vars"],
		"queued_at":     now,
		"messages": []map[string]any{{
			"_id":           id,
			"status":        "queued",
			"reject_reason": nil,
		}},
		"warning": "No transactional provider is invoked by the compatibility facade until credentials and policy gates are configured.",
	}
	d.saveCompatItem(r.Context(), t, "transactional_message", id, out)
	writeJSON(w, http.StatusAccepted, out)
}

func (d *Deps) upsertListWebhook(w http.ResponseWriter, r *http.Request, webhookID string) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	url := strings.TrimSpace(firstNonEmpty(stringValue(in, "url"), stringValue(in, "callback_url")))
	if url == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Webhook URL is required.")
		return
	}
	now := time.Now().UTC()
	id := firstNonEmpty(webhookID, stringValue(in, "id"), stableID(fmt.Sprintf("list-webhook:%s:%s:%d", listID, url, now.UnixNano())))
	out := map[string]any{
		"id":         id,
		"list_id":    listID,
		"url":        url,
		"events":     defaultedMap(in["events"], map[string]any{"subscribe": true, "unsubscribe": true, "profile": true, "cleaned": true, "upemail": true, "campaign": true}),
		"sources":    defaultedMap(in["sources"], map[string]any{"user": true, "admin": true, "api": true}),
		"created_at": now,
		"updated_at": now,
	}
	if existing, found := d.getCompatItem(r.Context(), t, "list_webhook", listWebhookItemID(listID, id)); found {
		out = existing
		out["updated_at"] = now
	}
	mergeMaps(out, in)
	out["id"] = id
	out["list_id"] = listID
	d.saveCompatItem(r.Context(), t, "list_webhook", listWebhookItemID(listID, id), out)
	status := http.StatusCreated
	if webhookID != "" {
		status = http.StatusOK
	}
	writeJSON(w, status, out)
}

func (d *Deps) upsertCampaignFolder(w http.ResponseWriter, r *http.Request, folderID string) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	name := strings.TrimSpace(firstNonEmpty(stringValue(in, "name"), "Campaign folder"))
	now := time.Now().UTC()
	id := firstNonEmpty(folderID, stringValue(in, "id"), stableID(fmt.Sprintf("campaign-folder:%s:%s:%d", t.ID, name, now.UnixNano())))
	out := map[string]any{"id": id, "name": name, "count": 0, "created_at": now, "updated_at": now}
	if existing, found := d.getCompatItem(r.Context(), t, "campaign_folder", id); found {
		out = existing
		out["updated_at"] = now
	}
	mergeMaps(out, in)
	out["id"] = id
	d.saveCompatItem(r.Context(), t, "campaign_folder", id, out)
	status := http.StatusCreated
	if folderID != "" {
		status = http.StatusOK
	}
	writeJSON(w, status, out)
}

func (d *Deps) upsertCampaignFeedback(w http.ResponseWriter, r *http.Request, feedbackID string) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	campaignID := chi.URLParam(r, "campaign_id")
	message := strings.TrimSpace(firstNonEmpty(stringValue(in, "message"), stringValue(in, "note")))
	if message == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Feedback message is required.")
		return
	}
	now := time.Now().UTC()
	id := firstNonEmpty(feedbackID, stringValue(in, "id"), stableID(fmt.Sprintf("feedback:%s:%s:%d", campaignID, message, now.UnixNano())))
	out := map[string]any{
		"id":          id,
		"campaign_id": campaignID,
		"message":     message,
		"is_complete": boolFromAny(in["is_complete"]),
		"block_id":    stringValue(in, "block_id"),
		"created_at":  now,
		"updated_at":  now,
	}
	if existing, found := d.getCompatItem(r.Context(), t, "campaign_feedback", campaignFeedbackItemID(campaignID, id)); found {
		out = existing
		out["updated_at"] = now
	}
	mergeMaps(out, in)
	out["id"] = id
	out["campaign_id"] = campaignID
	d.saveCompatItem(r.Context(), t, "campaign_feedback", campaignFeedbackItemID(campaignID, id), out)
	status := http.StatusCreated
	if feedbackID != "" {
		status = http.StatusOK
	}
	writeJSON(w, status, out)
}

func (d *Deps) addSegmentMembers(ctx context.Context, t *middleware.Tenant, listID, segmentID string, add, remove []string) (map[string]any, int, bool) {
	itemID := segmentItemID(listID, segmentID)
	item, found := d.getCompatItem(ctx, t, "list_segment", itemID)
	if !found {
		return nil, http.StatusNotFound, false
	}
	members := map[string]bool{}
	for _, email := range stringSliceFromAny(item["static_members"]) {
		if email = strings.TrimSpace(strings.ToLower(email)); email != "" {
			members[email] = true
		}
	}
	for _, email := range add {
		email = strings.TrimSpace(strings.ToLower(email))
		if email == "" {
			continue
		}
		if _, err := mail.ParseAddress(email); err == nil || !strings.Contains(email, "@") {
			members[email] = true
		}
	}
	for _, email := range remove {
		delete(members, strings.TrimSpace(strings.ToLower(email)))
	}
	next := make([]string, 0, len(members))
	for email := range members {
		next = append(next, email)
	}
	sort.Strings(next)
	item["static_members"] = next
	item["member_count"] = len(next)
	item["updated_at"] = time.Now().UTC()
	d.saveCompatItem(ctx, t, "list_segment", itemID, item)
	return item, http.StatusOK, true
}

func (d *Deps) listCompatItems(r *http.Request, t *middleware.Tenant, kind string) []map[string]any {
	if items, ok := listPlatformStateItems[map[string]any](r.Context(), d, t, kind); ok {
		sortCompatMaps(items)
		return items
	}
	mailchimpCompatLongTailState.Lock()
	defer mailchimpCompatLongTailState.Unlock()
	out := []map[string]any{}
	for _, rec := range mailchimpCompatLongTailState.items {
		if rec.TenantID == t.ID && rec.Kind == kind {
			out = append(out, copyCompatMap(rec.Payload))
		}
	}
	sortCompatMaps(out)
	return out
}

func (d *Deps) saveCompatItem(ctx context.Context, t *middleware.Tenant, kind, itemID string, payload map[string]any) {
	if payload == nil {
		payload = map[string]any{}
	}
	if rawID := strings.TrimSpace(fmt.Sprint(payload["id"])); rawID == "" || rawID == "<nil>" {
		payload["id"] = itemID
	}
	payload["kind"] = kind
	payload["updated_at"] = time.Now().UTC()
	if _, ok := payload["created_at"]; !ok {
		payload["created_at"] = payload["updated_at"]
	}
	_ = d.savePlatformStateItem(ctx, t, kind, itemID, payload)
	mailchimpCompatLongTailState.Lock()
	mailchimpCompatLongTailState.items[compatStateKey(t.ID, kind, itemID)] = compatStateRecord{TenantID: t.ID, Kind: kind, ItemID: itemID, Payload: copyCompatMap(payload)}
	mailchimpCompatLongTailState.Unlock()
}

func (d *Deps) getCompatItem(ctx context.Context, t *middleware.Tenant, kind, itemID string) (map[string]any, bool) {
	var out map[string]any
	if d.getPlatformStateItem(ctx, t, kind, itemID, &out) {
		return out, true
	}
	mailchimpCompatLongTailState.Lock()
	defer mailchimpCompatLongTailState.Unlock()
	rec, ok := mailchimpCompatLongTailState.items[compatStateKey(t.ID, kind, itemID)]
	if !ok {
		return nil, false
	}
	return copyCompatMap(rec.Payload), true
}

func (d *Deps) deleteCompatItem(ctx context.Context, t *middleware.Tenant, kind, itemID string) {
	_ = d.deletePlatformStateItem(ctx, t, kind, itemID)
	mailchimpCompatLongTailState.Lock()
	delete(mailchimpCompatLongTailState.items, compatStateKey(t.ID, kind, itemID))
	mailchimpCompatLongTailState.Unlock()
}

func tenantAndList(w http.ResponseWriter, r *http.Request) (*middleware.Tenant, string, bool) {
	t, ok := tenant(w, r)
	if !ok {
		return nil, "", false
	}
	listID := chi.URLParam(r, "list_id")
	if !listMatchesTenant(t, listID) {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested list could not be found.")
		return nil, "", false
	}
	if listID == "" || listID == "default" {
		listID = t.Slug
	}
	return t, listID, true
}

func segmentMemberRows(emails []string) []map[string]any {
	out := make([]map[string]any, 0, len(emails))
	for _, email := range emails {
		out = append(out, map[string]any{
			"id":            stableID(strings.ToLower(email)),
			"email_address": email,
			"status":        "subscribed",
		})
	}
	return out
}

func defaultAuthorizedApp(t *middleware.Tenant) map[string]any {
	now := time.Now().UTC()
	return map[string]any{
		"id":          "postwave-mailchimp-compat",
		"name":        "Moosewave Mailchimp compatibility facade",
		"description": "First-party compatibility surface for Mailchimp-style API clients and migration rehearsals.",
		"tenant_id":   t.ID,
		"scope":       []string{"audiences", "campaigns", "reports", "ecommerce", "automations", "content", "platform"},
		"created_at":  now,
	}
}

func checklistItem(key, label string, ok bool, detail string) map[string]any {
	status := "ok"
	if !ok {
		status = "warning"
	}
	return map[string]any{"key": key, "label": label, "status": status, "detail": detail}
}

func campaignHasRecipients(c *Campaign) bool {
	if c == nil {
		return false
	}
	if len(c.Recipients) == 0 {
		return false
	}
	if strings.TrimSpace(stringValue(c.Recipients, "list_id")) != "" {
		return true
	}
	if seg, ok := c.Recipients["segment_opts"].(map[string]any); ok && strings.TrimSpace(stringValue(seg, "saved_segment_id")) != "" {
		return true
	}
	if static, ok := c.Recipients["static_segment"].([]any); ok && len(static) > 0 {
		return true
	}
	return len(c.Recipients) > 0
}

func contentHasUsableLink(html string) bool {
	lower := strings.ToLower(html)
	return strings.Contains(lower, "href=\"http") ||
		strings.Contains(lower, "href='http") ||
		strings.Contains(lower, "*|archive|*") ||
		strings.Contains(lower, "*|unsub|*")
}

func contentHasComplianceFooter(html, text string) bool {
	lower := strings.ToLower(html + " " + text)
	for _, marker := range []string{"*|unsub|*", "*|unsubscribe|*", "*|archive|*", "{{unsubscribe_url}}", "data-postwave-compliance", "unsubscribe"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func mailchimpMergeTagsBalanced(s string) bool {
	return strings.Count(s, "*|")%2 == 0
}

func campaignDynamicBlocksReady(content *CampaignContent) bool {
	if content == nil || len(content.Blocks) == 0 {
		return true
	}
	for _, block := range content.Blocks {
		kind := strings.ToLower(firstNonEmpty(stringValue(block, "type"), stringValue(block, "id"), stringValue(block, "block_type")))
		switch kind {
		case "dynamic_content", "conditional_content":
			if strings.TrimSpace(stringValue(block, "fallback")) == "" && strings.TrimSpace(stringValue(block, "content")) == "" {
				return false
			}
		case "rss":
			if strings.TrimSpace(stringValue(block, "feed_url")) == "" && sliceLenFromAny(block["items"]) == 0 {
				return false
			}
		case "product_recommendations", "product", "products":
			if sliceLenFromAny(block["products"]) == 0 && strings.TrimSpace(stringValue(block, "recommendation_source")) == "" {
				return false
			}
		case "survey":
			if strings.TrimSpace(stringValue(block, "survey_id")) == "" && strings.TrimSpace(stringValue(block, "question")) == "" {
				return false
			}
		case "video":
			if strings.TrimSpace(stringValue(block, "video_url")) == "" && strings.TrimSpace(stringValue(block, "url")) == "" {
				return false
			}
		}
	}
	return true
}

func sliceLenFromAny(v any) int {
	switch items := v.(type) {
	case []any:
		return len(items)
	case []map[string]any:
		return len(items)
	case []string:
		return len(items)
	default:
		return 0
	}
}

func campaignTrackingReady(tracking map[string]any) bool {
	if len(tracking) == 0 {
		return true
	}
	for _, key := range []string{"opens", "html_clicks", "text_clicks", "goal_tracking", "ecomm360", "utm"} {
		if _, ok := tracking[key]; ok {
			return true
		}
	}
	return true
}

func checklistWarningCount(items []map[string]any) int {
	total := 0
	for _, item := range items {
		if fmt.Sprint(item["status"]) != "ok" {
			total++
		}
	}
	return total
}

func filterCompatItems(items []map[string]any, key, value string) []map[string]any {
	out := []map[string]any{}
	for _, item := range items {
		if fmt.Sprint(item[key]) == value {
			out = append(out, item)
		}
	}
	return out
}

func sortCompatMaps(items []map[string]any) {
	sort.Slice(items, func(i, j int) bool {
		return fmt.Sprint(items[i]["updated_at"]) > fmt.Sprint(items[j]["updated_at"])
	})
}

func compatStateKey(tenantID, kind, itemID string) string {
	return tenantID + ":" + kind + ":" + itemID
}

func mergeFieldItemID(listID, tag string) string {
	return listID + ":" + strings.ToLower(normalizeMergeTag(tag))
}

func segmentItemID(listID, segmentID string) string {
	return listID + ":" + segmentID
}

func listWebhookItemID(listID, webhookID string) string {
	return listID + ":" + webhookID
}

func campaignFeedbackItemID(campaignID, feedbackID string) string {
	return campaignID + ":" + feedbackID
}

func ecommerceCustomerItemID(storeID, customerID string) string {
	return storeID + ":" + customerID
}

func normalizeMergeTag(raw string) string {
	raw = strings.ToUpper(strings.TrimSpace(raw))
	raw = strings.ReplaceAll(raw, " ", "_")
	raw = strings.Trim(raw, "*|")
	if len(raw) > 10 {
		raw = raw[:10]
	}
	return raw
}

func stableNumber(raw string) int {
	id := stableID(raw)
	total := 0
	for _, r := range id {
		if r >= '0' && r <= '9' {
			total = total*10 + int(r-'0')
		} else if r >= 'a' && r <= 'f' {
			total = total*10 + int(r-'a') + 10
		}
		if total > 1000000 {
			total %= 1000000
		}
	}
	if total == 0 {
		total = 1
	}
	return total
}

func segmentTypeFromInput(in map[string]any) string {
	if _, ok := in["static_members"]; ok {
		return "static"
	}
	if _, ok := in["options"]; ok {
		return "saved"
	}
	return "static"
}

func mergeMaps(dst, src map[string]any) {
	for k, v := range src {
		if v != nil {
			dst[k] = v
		}
	}
}

func anyMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func defaultedMap(v any, fallback map[string]any) map[string]any {
	if m := anyMap(v); len(m) > 0 {
		return m
	}
	return fallback
}

// stringSliceFromAny never returns nil. Its results are placed directly into
// JSON responses (workbench provider_gates, among others), and a nil slice
// marshals to null where clients expect an array -- so the ORDINARY case, a task
// with no provider gates, was the one that produced an unusable payload.
//
// No caller distinguishes nil from empty; all six test length.
func stringSliceFromAny(v any) []string {
	switch vals := v.(type) {
	case []string:
		if vals == nil {
			return []string{}
		}
		return vals
	case []any:
		out := make([]string, 0, len(vals))
		for _, val := range vals {
			if s := strings.TrimSpace(fmt.Sprint(val)); s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return []string{}
	}
}

func intFromAny(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return 0
	}
}

func boolFromAny(v any) bool {
	b, _ := v.(bool)
	return b
}

func copyCompatMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	raw, _ := json.Marshal(in)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return out
}
