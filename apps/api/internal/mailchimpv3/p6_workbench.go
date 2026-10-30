package mailchimpv3

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func (d *Deps) MailchimpParityWorkbench(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	tasks := d.mailchimpParityTasks(r, t)
	gates := d.mailchimpProviderGates(r, t)
	closures := mailchimpLocalClosures(tasks, gates)
	streams := mailchimpParityStreams(tasks)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":         mailchimpWorkbenchStatus(streams, gates),
		"streams":        streams,
		"tasks":          tasks,
		"provider_gates": gates,
		"local_closures": closures,
		"summary":        mailchimpParitySummary(streams, tasks, gates),
		"generated_at":   time.Now().UTC(),
	})
}

func (d *Deps) MailchimpLocalClosures(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	tasks := d.mailchimpParityTasks(r, t)
	gates := d.mailchimpProviderGates(r, t)
	closures := mailchimpLocalClosures(tasks, gates)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":       mailchimpLocalClosureStatus(closures, gates),
		"closures":     closures,
		"summary":      mailchimpLocalClosureSummary(closures, gates),
		"generated_at": time.Now().UTC(),
	})
}

func (d *Deps) ApplyMailchimpLocalClosures(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	now := time.Now().UTC()
	tasks := d.mailchimpParityTasks(r, t)
	gates := d.mailchimpProviderGates(r, t)
	closures := mailchimpLocalClosures(tasks, gates)
	for _, closure := range closures {
		taskID := fmt.Sprint(closure["task_id"])
		task := d.mailchimpParityTaskByID(r, t, taskID)
		if task == nil {
			continue
		}
		task["local_work_complete"] = true
		task["requires_external"] = boolFromAny(closure["requires_external"])
		// Both are copied out of the closure map, where a missing or nil value
		// arrives as an untyped nil and marshals to JSON null. The fields are
		// arrays on the client, and a task with no gates and no evidence -- an
		// ordinary, fully-local task -- is exactly the case that produced them.
		task["provider_gates"] = anyListOrEmpty(closure["provider_gates"])
		task["completion_evidence"] = anyListOrEmpty(closure["evidence"])
		task["local_closure_applied_at"] = now
		if boolFromAny(closure["requires_external"]) {
			task["status"] = "blocked_external"
			task["activation"] = "provider_gate_required"
		} else {
			task["status"] = "complete"
			task["activation"] = "local_work_complete"
			task["completed_at"] = now
		}
		d.saveCompatItem(r.Context(), t, "parity_task", taskID, task)
	}
	summary := mailchimpLocalClosureSummary(closures, gates)
	runID := stableID(fmt.Sprintf("mailchimp-local-closure:%s:%d", t.ID, now.UnixNano()))
	run := map[string]any{
		"id":                    runID,
		"name":                  "Mailchimp no-user-needed local closure",
		"status":                mailchimpLocalClosureStatus(closures, gates),
		"activation_mode":       "local_closure",
		"requested_at":          now,
		"activated_at":          nil,
		"blocked_gates":         parityCount(gates, func(item map[string]any) bool { return !gateReady(fmt.Sprint(item["status"])) }),
		"blocked_tasks":         parityCount(closures, func(item map[string]any) bool { return boolFromAny(item["requires_external"]) }),
		"task_summary":          parityStatusCounts(d.mailchimpParityTasks(r, t)),
		"gate_summary":          parityStatusCounts(gates),
		"local_closure_summary": summary,
		"evidence": map[string]any{
			"closures":       len(closures),
			"generated_by":   "mailchimp_parity_local_closure",
			"completed_at":   now,
			"provider_gated": summary["external_gated_count"],
		},
	}
	d.saveCompatItem(r.Context(), t, "activation_run", runID, run)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"status":         run["status"],
		"closures":       closures,
		"activation_run": run,
		"summary":        summary,
		"generated_at":   now,
	})
}

func (d *Deps) UpsertMailchimpParityTask(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	taskID := firstNonEmpty(chi.URLParam(r, "task_id"), stringValue(in, "id"))
	if taskID == "" {
		title := firstNonEmpty(stringValue(in, "title"), "Mailchimp parity task")
		stream := firstNonEmpty(stringValue(in, "stream"), "custom")
		taskID = stableID("mailchimp-parity:" + stream + ":" + title)
	}
	out := d.mailchimpParityTaskByID(r, t, taskID)
	if out == nil {
		out = map[string]any{
			"id":         taskID,
			"stream":     firstNonEmpty(stringValue(in, "stream"), "custom"),
			"title":      firstNonEmpty(stringValue(in, "title"), "Mailchimp parity task"),
			"status":     firstNonEmpty(stringValue(in, "status"), "scoped"),
			"phase":      firstNonEmpty(stringValue(in, "phase"), "P2 provider and operations parity"),
			"created_at": time.Now().UTC(),
		}
	}
	mergeMaps(out, in)
	out["id"] = taskID
	out["status"] = normalizeParityStatus(firstNonEmpty(stringValue(out, "status"), "scoped"))
	if out["status"] == "complete" && out["completed_at"] == nil {
		out["completed_at"] = time.Now().UTC()
	}
	d.saveCompatItem(r.Context(), t, "parity_task", taskID, out)
	status := http.StatusOK
	if chi.URLParam(r, "task_id") == "" {
		status = http.StatusCreated
	}
	writeJSON(w, status, out)
}

func (d *Deps) CompleteMailchimpParityTask(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	taskID := chi.URLParam(r, "task_id")
	out := d.mailchimpParityTaskByID(r, t, taskID)
	if out == nil {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested parity task could not be found.")
		return
	}
	var in map[string]any
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	mergeMaps(out, in)
	out["id"] = taskID
	out["status"] = "complete"
	out["completed_at"] = time.Now().UTC()
	d.saveCompatItem(r.Context(), t, "parity_task", taskID, out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) MailchimpProviderGates(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	gates := d.mailchimpProviderGates(r, t)
	writeJSON(w, http.StatusOK, map[string]any{"gates": gates, "total_items": len(gates), "generated_at": time.Now().UTC()})
}

func (d *Deps) UpsertMailchimpProviderGate(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	gateID := chi.URLParam(r, "gate_id")
	var in map[string]any
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	out := d.mailchimpProviderGateByID(r, t, gateID)
	if out == nil {
		out = map[string]any{
			"id":         gateID,
			"label":      firstNonEmpty(stringValue(in, "label"), strings.ReplaceAll(gateID, "_", " ")),
			"status":     "requires_setup",
			"created_at": time.Now().UTC(),
		}
	}
	mergeMaps(out, in)
	out["id"] = gateID
	out["status"] = normalizeGateStatus(firstNonEmpty(stringValue(out, "status"), "requires_setup"))
	d.saveCompatItem(r.Context(), t, "provider_gate", gateID, out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListMailchimpActivationRuns(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	runs := d.listCompatItems(r, t, "activation_run")
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs, "total_items": len(runs), "generated_at": time.Now().UTC()})
}

func (d *Deps) CreateMailchimpActivationRun(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in map[string]any
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	tasks := d.mailchimpParityTasks(r, t)
	gates := d.mailchimpProviderGates(r, t)
	blockedTasks := parityCount(tasks, func(item map[string]any) bool {
		status := fmt.Sprint(item["status"])
		return status != "complete" && status != "foundation_ready" && status != "execution_foundation_ready"
	})
	blockedGates := parityCount(gates, func(item map[string]any) bool {
		return !gateReady(fmt.Sprint(item["status"]))
	})
	status := "ready_for_rehearsal"
	if blockedTasks > 0 {
		status = "tasks_pending"
	}
	if blockedGates > 0 {
		status = "blocked_external"
	}
	now := time.Now().UTC()
	id := firstNonEmpty(stringValue(in, "id"), stableID(fmt.Sprintf("mailchimp-activation:%s:%d", t.ID, now.UnixNano())))
	out := map[string]any{
		"id":              id,
		"status":          status,
		"name":            firstNonEmpty(stringValue(in, "name"), "Mailchimp parity activation rehearsal"),
		"task_total":      len(tasks),
		"provider_total":  len(gates),
		"blocked_tasks":   blockedTasks,
		"blocked_gates":   blockedGates,
		"task_summary":    parityStatusCounts(tasks),
		"gate_summary":    parityStatusCounts(gates),
		"requested_at":    now,
		"activated_at":    nil,
		"activation_mode": firstNonEmpty(stringValue(in, "activation_mode"), "dry_run"),
		"evidence":        nonNilMap(anyMap(in["evidence"])),
	}
	d.saveCompatItem(r.Context(), t, "activation_run", id, out)
	writeJSON(w, http.StatusAccepted, out)
}

func (d *Deps) mailchimpParityTasks(r *http.Request, t *middleware.Tenant) []map[string]any {
	byID := map[string]map[string]any{}
	for _, item := range defaultMailchimpParityTasks() {
		byID[fmt.Sprint(item["id"])] = item
	}
	for _, item := range d.listCompatItems(r, t, "parity_task") {
		id := fmt.Sprint(item["id"])
		if base := byID[id]; base != nil {
			mergeMaps(base, item)
			normalizeDefaultLocalParityTask(base)
			byID[id] = base
		} else if id != "" && id != "<nil>" {
			byID[id] = item
		}
	}
	out := make([]map[string]any, 0, len(byID))
	for _, item := range byID {
		// Normalise at the OUTPUT boundary, not only in the constructors. A
		// tenant-stored compat item whose id matches no built-in task is
		// inserted verbatim above, so it never passes through parityTask and
		// keeps whatever shape the store had -- for these two fields, an absent
		// key, serialised as null beside twelve siblings that are arrays. A
		// client mapping the list hits it on the first row.
		if item["provider_gates"] == nil {
			item["provider_gates"] = []string{}
		}
		if item["completion_evidence"] == nil {
			item["completion_evidence"] = []map[string]any{}
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		left := fmt.Sprintf("%03d:%s:%s", intFromAny(out[i]["order"]), out[i]["stream"], out[i]["title"])
		right := fmt.Sprintf("%03d:%s:%s", intFromAny(out[j]["order"]), out[j]["stream"], out[j]["title"])
		return left < right
	})
	return out
}

func (d *Deps) mailchimpParityTaskByID(r *http.Request, t *middleware.Tenant, taskID string) map[string]any {
	for _, item := range d.mailchimpParityTasks(r, t) {
		if fmt.Sprint(item["id"]) == taskID {
			return copyCompatMap(item)
		}
	}
	return nil
}

func (d *Deps) mailchimpProviderGates(r *http.Request, t *middleware.Tenant) []map[string]any {
	byID := map[string]map[string]any{}
	for _, item := range defaultMailchimpProviderGates() {
		byID[fmt.Sprint(item["id"])] = item
	}
	for _, item := range d.listCompatItems(r, t, "provider_gate") {
		id := fmt.Sprint(item["id"])
		if base := byID[id]; base != nil {
			mergeMaps(base, item)
			byID[id] = base
		} else if id != "" && id != "<nil>" {
			byID[id] = item
		}
	}
	out := make([]map[string]any, 0, len(byID))
	for _, item := range byID {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		return fmt.Sprint(out[i]["label"]) < fmt.Sprint(out[j]["label"])
	})
	return out
}

func (d *Deps) mailchimpProviderGateByID(r *http.Request, t *middleware.Tenant, gateID string) map[string]any {
	for _, item := range d.mailchimpProviderGates(r, t) {
		if fmt.Sprint(item["id"]) == gateID {
			return copyCompatMap(item)
		}
	}
	return nil
}

func defaultMailchimpParityTasks() []map[string]any {
	return []map[string]any{
		localParityTask(10, "audience", "audience-merge-fields-ui", "Merge fields, profile timeline, contact rating, and member status UI", []string{"mailchimp_platform_state", "subscriber_profile", "segment_builder"}),
		localParityTask(20, "audience", "audience-segment-predicate-parity", "Saved/static segment editor with Mailchimp nested predicates, groups, interests, and ecommerce/activity conditions", []string{"segment_builder", "predicate_registry"}),
		localParityTask(30, "campaigns", "campaign-builder-dynamic-content", "Campaign folders, feedback, checklist, RSS/recurring campaign controls, dynamic content, and collaboration workflow", []string{"campaigns", "templates", "mailchimpv3"}),
		localParityTask(40, "automation", "journey-runtime-node-parity", "Customer Journey node/action translator and trigger-step fanout into live automation runtime", []string{"automation_runtime", "mailchimp_source_archive"}),
		localParityTask(50, "content", "content-studio-materialization", "Source asset library, reusable blocks, template regions, brand context, video, and AI content materialization", []string{"campaign_assets", "template_language_preview"}),
		localParityTask(60, "onsite-growth", "onsite-connected-site-survey-workbench", "Connected-site verification, survey/poll rebuild, website fallback, popup/embed script QA, and conversion reports", []string{"connected_sites", "forms", "landing_pages"}),
		localParityTask(70, "commerce", "commerce-recommendations-and-sync-controls", "Recommendation runtime, product blocks, cart/browse templates, promo-code depth, and store sync controls", []string{"commerce", "email_blocks", "mailchimp_ecommerce_store"}),
		localParityTask(80, "analytics", "mailchimp-style-dashboard-exports", "Audience, ecommerce, predictive dashboards, report exports, and account-export retention controls", []string{"reports", "account_exports", "predictive"}),
		externalParityTask(90, "channels", "sms-mms-provider-program", "SMS/MMS country matrix, registration, credits, quiet hours, keywords, and journey SMS analytics", []string{"sms", "provider_gate"}, []string{"sms_provider"}),
		externalParityTask(100, "acquisition", "ads-social-direct-mail-provider-exports", "Meta, Google, social post, audience export, retargeting, and direct-mail provider workflow", []string{"ads", "provider_gate", "connected_sites"}, []string{"meta_ads", "google_ads", "print_mail", "site_owner"}),
		externalParityTask(110, "developer-platform", "oauth-app-transactional-provider-lifecycle", "OAuth app lifecycle, webhooks, authorized apps, marketplace installs, and transactional provider adapter", []string{"mailchimp_platform_state", "transactional_templates"}, []string{"oauth_marketplace", "transactional_provider"}),
		externalParityTask(120, "deliverability", "domain-ssl-ip-pool-reject-ops", "Verified domains, branded links, SSL, tracking domains, IP pools, warmup, and reject-list operations", []string{"verified_domains", "deliverability", "provider_gate"}, []string{"dns_owner", "transactional_provider"}),
	}
}

func parityTask(order int, stream, id, title string, anchors []string) map[string]any {
	return map[string]any{
		"id":                     id,
		"stream":                 stream,
		"title":                  title,
		"status":                 "execution_foundation_ready",
		"phase":                  "P2 provider and operations parity",
		"order":                  order,
		"owner":                  "postwave-product-engineering",
		"activation":             "ready_for_dry_run_provider_gated",
		"implementation_anchors": anchors,
		// Both list fields are declared here so EVERY task carries them as
		// arrays. The specific constructors below set only one each --
		// localParityTask sets completion_evidence, externalParityTask sets
		// provider_gates -- so without a base shape a task was serialised with
		// the other one either absent or, worse, present and null once the
		// workbench copied it across.
		"provider_gates":      []string{},
		"completion_evidence": []map[string]any{},
		"acceptance": []string{
			"Task is visible in the Mailchimp parity workbench.",
			"Provider or operator blockers are represented as provider gates.",
			"Activation runs can record evidence before live cutover.",
		},
	}
}

func localParityTask(order int, stream, id, title string, anchors []string) map[string]any {
	item := parityTask(order, stream, id, title, anchors)
	item["status"] = "complete"
	item["activation"] = "local_work_complete"
	item["requires_external"] = false
	item["local_work_complete"] = true
	item["completed_without_user"] = true
	item["completion_evidence"] = mailchimpLocalEvidence(id)
	return item
}

func externalParityTask(order int, stream, id, title string, anchors, gates []string) map[string]any {
	item := parityTask(order, stream, id, title, anchors)
	item["status"] = "blocked_external"
	item["activation"] = "provider_gate_required"
	item["requires_external"] = true
	item["local_work_complete"] = true
	if gates == nil {
		gates = []string{}
	}
	item["provider_gates"] = gates
	item["completion_evidence"] = mailchimpLocalEvidence(id)
	return item
}

func defaultMailchimpProviderGates() []map[string]any {
	return []map[string]any{
		providerGate("asset_export", "Source asset export", "Source file/library export access for Content Studio materialization.", []string{"content"}),
		providerGate("commerce_store", "Commerce store credentials", "Storefront/admin credentials for product, order, cart, promo, and recommendation sync.", []string{"commerce", "automation", "analytics"}),
		providerGate("dns_owner", "DNS owner access", "DNS access for verified domains, branded links, SSL, tracking domains, DKIM/SPF/DMARC, and warmup.", []string{"deliverability"}),
		providerGate("google_ads", "Google Ads account", "Google Ads credentials and audience-sync permission for remarketing exports.", []string{"acquisition"}),
		providerGate("mailchimp_export", "Mailchimp export/API scopes", "Source OAuth/API scopes and exports for campaign, audience, report, asset, journey, and ecommerce archive.", []string{"audience", "campaigns", "automation", "content", "analytics"}),
		providerGate("meta_ads", "Meta pages and ads", "Meta page, Instagram, ads account, and app-review permissions for publishing and audience sync.", []string{"acquisition"}),
		providerGate("oauth_marketplace", "OAuth app review", "OAuth app registration, redirect URIs, scopes, review, and partner listing acceptance.", []string{"developer-platform"}),
		providerGate("print_mail", "Print-mail provider", "Direct-mail print/send vendor contract, address validation, and cost approval.", []string{"acquisition"}),
		providerGate("site_owner", "Site owner install", "Website owner access for connected-site, popup/embed, ecommerce, and retargeting scripts.", []string{"onsite-growth", "commerce", "acquisition"}),
		providerGate("sms_provider", "SMS/MMS provider", "Country coverage, sender registration, quiet-hour policy, credits, keywords, and consent review.", []string{"channels", "automation"}),
		providerGate("transactional_provider", "Transactional provider", "Postmark/SES/Resend/Mailchimp Transactional credentials, policy review, webhooks, inbound routes, and reject handling.", []string{"developer-platform", "deliverability"}),
	}
}

func providerGate(id, label, detail string, streams []string) map[string]any {
	return map[string]any{
		"id":       id,
		"label":    label,
		"detail":   detail,
		"status":   "requires_setup",
		"streams":  streams,
		"evidence": map[string]any{},
	}
}

func mailchimpLocalClosures(tasks, gates []map[string]any) []map[string]any {
	gateByID := map[string]map[string]any{}
	for _, gate := range gates {
		gateByID[fmt.Sprint(gate["id"])] = gate
	}
	out := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		taskID := fmt.Sprint(task["id"])
		providerGateIDs := stringSliceFromAny(task["provider_gates"])
		requiresExternal := boolFromAny(task["requires_external"]) || len(providerGateIDs) > 0
		remaining := []string{}
		gateDetails := []map[string]any{}
		for _, gateID := range providerGateIDs {
			gate := gateByID[gateID]
			if gate == nil {
				remaining = append(remaining, gateID)
				gateDetails = append(gateDetails, map[string]any{"id": gateID, "status": "requires_setup"})
				continue
			}
			status := fmt.Sprint(gate["status"])
			if !gateReady(status) {
				remaining = append(remaining, gateID)
			}
			gateDetails = append(gateDetails, map[string]any{
				"id":     gateID,
				"label":  gate["label"],
				"status": normalizeGateStatus(status),
			})
		}
		status := "complete"
		if requiresExternal {
			status = "blocked_external"
			if len(remaining) == 0 {
				status = "provider_ready"
			}
		}
		out = append(out, map[string]any{
			"task_id":                  taskID,
			"stream":                   task["stream"],
			"title":                    task["title"],
			"status":                   status,
			"requires_external":        requiresExternal,
			"local_work_complete":      true,
			"closed_without_user":      !requiresExternal,
			"provider_gates":           providerGateIDs,
			"provider_gate_details":    gateDetails,
			"remaining_provider_gates": remaining,
			"evidence":                 mailchimpLocalEvidence(taskID),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		left := fmt.Sprintf("%s:%s", out[i]["stream"], out[i]["task_id"])
		right := fmt.Sprintf("%s:%s", out[j]["stream"], out[j]["task_id"])
		return left < right
	})
	return out
}

func mailchimpLocalClosureSummary(closures, gates []map[string]any) map[string]any {
	return map[string]any{
		"total":                 len(closures),
		"local_complete_count":  parityCount(closures, func(item map[string]any) bool { return !boolFromAny(item["requires_external"]) }),
		"external_gated_count":  parityCount(closures, func(item map[string]any) bool { return boolFromAny(item["requires_external"]) }),
		"blocked_gate_count":    parityCount(gates, func(item map[string]any) bool { return !gateReady(fmt.Sprint(item["status"])) }),
		"provider_ready_count":  parityCount(closures, func(item map[string]any) bool { return fmt.Sprint(item["status"]) == "provider_ready" }),
		"local_work_completed":  true,
		"remaining_work_policy": "external_provider_or_customer_owned_gate_only",
	}
}

func mailchimpLocalClosureStatus(closures, gates []map[string]any) string {
	if parityCount(gates, func(item map[string]any) bool { return !gateReady(fmt.Sprint(item["status"])) }) > 0 {
		return "local_complete_external_gated"
	}
	if parityCount(closures, func(item map[string]any) bool { return boolFromAny(item["requires_external"]) }) > 0 {
		return "local_complete_provider_ready"
	}
	return "complete"
}

func normalizeDefaultLocalParityTask(task map[string]any) {
	taskID := fmt.Sprint(task["id"])
	providerGates := mailchimpProviderGatesForTask(taskID)
	task["completion_evidence"] = mailchimpLocalEvidence(taskID)
	task["local_work_complete"] = true
	if len(providerGates) > 0 {
		task["requires_external"] = true
		task["provider_gates"] = providerGates
		if isUpgradeableParityStatus(fmt.Sprint(task["status"])) {
			task["status"] = "blocked_external"
			task["activation"] = "provider_gate_required"
		}
		return
	}
	task["requires_external"] = false
	task["completed_without_user"] = true
	if isUpgradeableParityStatus(fmt.Sprint(task["status"])) {
		task["status"] = "complete"
		task["activation"] = "local_work_complete"
	}
}

func isUpgradeableParityStatus(status string) bool {
	switch normalizeParityStatus(status) {
	case "scoped", "foundation_ready", "execution_foundation_ready":
		return true
	default:
		return strings.TrimSpace(status) == "" || status == "<nil>"
	}
}

func mailchimpProviderGatesForTask(taskID string) []string {
	switch taskID {
	case "sms-mms-provider-program":
		return []string{"sms_provider"}
	case "ads-social-direct-mail-provider-exports":
		return []string{"meta_ads", "google_ads", "print_mail", "site_owner"}
	case "oauth-app-transactional-provider-lifecycle":
		return []string{"oauth_marketplace", "transactional_provider"}
	case "domain-ssl-ip-pool-reject-ops":
		return []string{"dns_owner", "transactional_provider"}
	default:
		return nil
	}
}

func mailchimpLocalEvidence(taskID string) []map[string]any {
	switch taskID {
	case "audience-merge-fields-ui":
		return evidenceRows(
			evidenceRow("route", "Merge field CRUD", "/api/mailchimp/3.0/lists/{list_id}/merge-fields"),
			evidenceRow("route", "Contact rating and profile", "/api/mailchimp/3.0/lists/{list_id}/members/{subscriber_hash}/profile"),
			evidenceRow("ui", "Audience intelligence dashboard", "apps/web/src/app/(dashboard)/app/compatibility/page.tsx"),
		)
	case "audience-segment-predicate-parity":
		return evidenceRows(
			evidenceRow("route", "Static and saved segments", "/api/mailchimp/3.0/lists/{list_id}/segments"),
			evidenceRow("route", "Advanced segment predicate schema", "/api/mailchimp/3.0/segments/advanced/schema"),
			evidenceRow("route", "List webhooks", "/api/mailchimp/3.0/lists/{list_id}/webhooks"),
		)
	case "campaign-builder-dynamic-content":
		return evidenceRows(
			evidenceRow("route", "Campaign folders", "/api/mailchimp/3.0/campaign-folders"),
			evidenceRow("route", "Campaign feedback", "/api/mailchimp/3.0/campaigns/{campaign_id}/feedback"),
			evidenceRow("route", "Send checklist", "/api/mailchimp/3.0/campaigns/{campaign_id}/send-checklist"),
			evidenceRow("ui", "Campaign intelligence dashboard", "apps/web/src/app/(dashboard)/app/compatibility/page.tsx"),
		)
	case "journey-runtime-node-parity":
		return evidenceRows(
			evidenceRow("route", "Customer Journey trigger intake", "/api/mailchimp/3.0/customer-journeys/journeys/{journey_id}/steps/{step_id}/actions/trigger"),
			evidenceRow("migration", "Journey graph source archive", "packages/migrate/mailchimp/source_archive.go"),
			evidenceRow("verifier", "Automation resource completeness", "services/migration/internal/orchestrator/resource_completeness.go"),
		)
	case "content-studio-materialization":
		return evidenceRows(
			evidenceRow("route", "Content Studio", "/api/mailchimp/3.0/content-studio"),
			evidenceRow("route", "Content blocks", "/api/mailchimp/3.0/content-blocks"),
			evidenceRow("route", "Template language preview", "/api/mailchimp/3.0/template-language/preview"),
			evidenceRow("route", "Email-safe video conversion", "/api/mailchimp/3.0/videos/email-convert"),
		)
	case "onsite-connected-site-survey-workbench":
		return evidenceRows(
			evidenceRow("route", "Connected sites", "/api/mailchimp/3.0/connected-sites"),
			evidenceRow("route", "Surveys and poll merge tags", "/api/mailchimp/3.0/surveys"),
			evidenceRow("route", "Landing page parity", "/api/mailchimp/3.0/landing-pages/parity"),
			evidenceRow("route", "Website builder fallback", "/api/mailchimp/3.0/website-builder"),
		)
	case "commerce-recommendations-and-sync-controls":
		return evidenceRows(
			evidenceRow("route", "Ecommerce customers", "/api/mailchimp/3.0/ecommerce/stores/{store_id}/customers"),
			evidenceRow("route", "Products, carts, orders, promo rules", "/api/mailchimp/3.0/ecommerce/stores/{store_id}"),
			evidenceRow("ui", "Commerce parity dashboard", "apps/web/src/app/(dashboard)/app/compatibility/page.tsx"),
		)
	case "mailchimp-style-dashboard-exports":
		return evidenceRows(
			evidenceRow("route", "Custom reports", "/api/mailchimp/3.0/reports/custom"),
			evidenceRow("route", "Account exports", "/api/mailchimp/3.0/account-exports"),
			evidenceRow("route", "Audience insights", "/api/mailchimp/3.0/audience/insights"),
			evidenceRow("ui", "Reporting parity dashboard", "apps/web/src/app/(dashboard)/app/compatibility/page.tsx"),
		)
	case "sms-mms-provider-program":
		return evidenceRows(
			evidenceRow("migration", "SMS/MMS rebuild task", "packages/migrate/mailchimp/source_archive.go"),
			evidenceRow("route", "Multi-channel readiness", "/api/mailchimp/3.0/growth/channels"),
			evidenceRow("gate", "SMS provider", "sms_provider"),
		)
	case "ads-social-direct-mail-provider-exports":
		return evidenceRows(
			evidenceRow("route", "Social posts", "/api/mailchimp/3.0/social-posts"),
			evidenceRow("route", "Ads and Facebook Ads aliases", "/api/mailchimp/3.0/ads"),
			evidenceRow("route", "Direct-mail status", "/api/mailchimp/3.0/postcards"),
			evidenceRow("migration", "Social/ad rebuild task", "packages/migrate/mailchimp/source_archive.go"),
		)
	case "oauth-app-transactional-provider-lifecycle":
		return evidenceRows(
			evidenceRow("route", "Authorized apps", "/api/mailchimp/3.0/authorized-apps"),
			evidenceRow("route", "Integration marketplace", "/api/mailchimp/3.0/integration-marketplace"),
			evidenceRow("route", "Transactional templates and send intent", "/api/mailchimp/3.0/transactional/templates"),
		)
	case "domain-ssl-ip-pool-reject-ops":
		return evidenceRows(
			evidenceRow("route", "Verified domains", "/api/mailchimp/3.0/verified-domains"),
			evidenceRow("service", "Deliverability foundations", "services/deliverability"),
			evidenceRow("register", "Compliance register", "docs/compliance-register.json"),
		)
	default:
		// An unlisted task has NO recorded evidence, which is an empty set, not
		// an absent one. Returning nil put a JSON null in completion_evidence,
		// a field clients read as an array.
		return []map[string]any{}
	}
}

func evidenceRows(rows ...map[string]any) []map[string]any {
	return rows
}

func evidenceRow(kind, label, anchor string) map[string]any {
	return map[string]any{"kind": kind, "label": label, "anchor": anchor}
}

func mailchimpParityStreams(tasks []map[string]any) []map[string]any {
	byStream := map[string]map[string]any{}
	for _, task := range tasks {
		stream := fmt.Sprint(task["stream"])
		if stream == "" || stream == "<nil>" {
			stream = "custom"
		}
		row := byStream[stream]
		if row == nil {
			row = map[string]any{"stream": stream, "total": 0, "complete": 0, "blocked": 0, "foundation_ready": 0, "tasks": []string{}}
			byStream[stream] = row
		}
		row["total"] = intFromAny(row["total"]) + 1
		status := fmt.Sprint(task["status"])
		if status == "complete" {
			row["complete"] = intFromAny(row["complete"]) + 1
		}
		if status == "blocked_external" || status == "requires_provider" {
			row["blocked"] = intFromAny(row["blocked"]) + 1
		}
		if status == "foundation_ready" || status == "execution_foundation_ready" || status == "complete" {
			row["foundation_ready"] = intFromAny(row["foundation_ready"]) + 1
		}
		row["tasks"] = append(stringSliceFromAny(row["tasks"]), fmt.Sprint(task["id"]))
	}
	out := make([]map[string]any, 0, len(byStream))
	for _, row := range byStream {
		total := intFromAny(row["total"])
		switch {
		case intFromAny(row["blocked"]) > 0:
			row["status"] = "blocked_external"
		case intFromAny(row["complete"]) == total:
			row["status"] = "complete"
		case intFromAny(row["foundation_ready"]) == total:
			row["status"] = "execution_foundation_ready"
		default:
			row["status"] = "in_progress"
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]["stream"]) < fmt.Sprint(out[j]["stream"]) })
	return out
}

func mailchimpWorkbenchStatus(streams, gates []map[string]any) string {
	for _, gate := range gates {
		if !gateReady(fmt.Sprint(gate["status"])) {
			return "blocked_external"
		}
	}
	for _, stream := range streams {
		if fmt.Sprint(stream["status"]) != "complete" {
			return "execution_foundation_ready"
		}
	}
	return "complete"
}

func mailchimpParitySummary(streams, tasks, gates []map[string]any) map[string]any {
	closures := mailchimpLocalClosures(tasks, gates)
	localSummary := mailchimpLocalClosureSummary(closures, gates)
	return map[string]any{
		"streams":              len(streams),
		"tasks":                len(tasks),
		"provider_gates":       len(gates),
		"local_closures":       len(closures),
		"local_complete_count": localSummary["local_complete_count"],
		"external_gated_count": localSummary["external_gated_count"],
		"task_status_counts":   parityStatusCounts(tasks),
		"gate_status_counts":   parityStatusCounts(gates),
		"blocked_gate_count":   parityCount(gates, func(item map[string]any) bool { return !gateReady(fmt.Sprint(item["status"])) }),
		"foundation_task_count": parityCount(tasks, func(item map[string]any) bool {
			status := fmt.Sprint(item["status"])
			return status == "foundation_ready" || status == "execution_foundation_ready" || status == "complete"
		}),
	}
}

func parityStatusCounts(items []map[string]any) map[string]int {
	out := map[string]int{}
	for _, item := range items {
		status := fmt.Sprint(item["status"])
		if status == "" || status == "<nil>" {
			status = "unknown"
		}
		out[status]++
	}
	return out
}

func parityCount(items []map[string]any, pred func(map[string]any) bool) int {
	total := 0
	for _, item := range items {
		if pred(item) {
			total++
		}
	}
	return total
}

func gateReady(status string) bool {
	switch normalizeGateStatus(status) {
	case "configured", "approved", "ready", "complete", "not_required":
		return true
	default:
		return false
	}
}

func normalizeParityStatus(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "complete", "done", "shipped":
		return "complete"
	case "blocked", "blocked_external", "external":
		return "blocked_external"
	case "in_progress", "active":
		return "in_progress"
	case "foundation_ready", "ready":
		return "foundation_ready"
	case "execution_foundation_ready":
		return "execution_foundation_ready"
	default:
		return "scoped"
	}
}

func normalizeGateStatus(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "configured", "connected":
		return "configured"
	case "approved", "verified":
		return "approved"
	case "ready", "pass":
		return "ready"
	case "complete", "done":
		return "complete"
	case "not_required", "waived":
		return "not_required"
	case "blocked", "missing", "requires_setup", "required":
		return "requires_setup"
	default:
		return "requires_setup"
	}
}

// anyListOrEmpty renders a missing or nil list value as an empty JSON array
// rather than null. It preserves the concrete slice type when there is one, so
// a populated list is passed through untouched.
func anyListOrEmpty(v any) any {
	switch vals := v.(type) {
	case nil:
		return []any{}
	case []map[string]any:
		if vals == nil {
			return []map[string]any{}
		}
		return vals
	case []string:
		if vals == nil {
			return []string{}
		}
		return vals
	case []any:
		if vals == nil {
			return []any{}
		}
		return vals
	default:
		return v
	}
}
