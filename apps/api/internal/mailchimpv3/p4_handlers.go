package mailchimpv3

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var mailchimpPlatformState = struct {
	sync.Mutex
	batches         map[string]BatchResponse
	batchWebhooks   map[string]BatchWebhook
	accountExports  map[string]AccountExport
	connectedSites  map[string]ConnectedSite
	verifiedDomains map[string]VerifiedDomain
}{
	batches:         map[string]BatchResponse{},
	batchWebhooks:   map[string]BatchWebhook{},
	accountExports:  map[string]AccountExport{},
	connectedSites:  map[string]ConnectedSite{},
	verifiedDomains: map[string]VerifiedDomain{},
}

func (d *Deps) ListBatches(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if items, ok := listPlatformStateItems[BatchResponse](r.Context(), d, t, "batch"); ok {
		sort.Slice(items, func(i, j int) bool { return items[i].SubmittedAt.After(items[j].SubmittedAt) })
		writeJSON(w, http.StatusOK, BatchesResponse{Batches: items, TotalItems: len(items)})
		return
	}
	items := listPlatformItems(t.ID, mailchimpPlatformState.batches)
	sort.Slice(items, func(i, j int) bool { return items[i].SubmittedAt.After(items[j].SubmittedAt) })
	writeJSON(w, http.StatusOK, BatchesResponse{Batches: items, TotalItems: len(items)})
}

func (d *Deps) CreateBatch(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in BatchRequest
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	if len(in.Operations) == 0 {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Batch requests must include at least one operation.")
		return
	}
	now := time.Now().UTC()
	results := make([]BatchOperationResult, 0, len(in.Operations))
	errored := 0
	for idx, op := range in.Operations {
		result := evaluateBatchOperation(idx, op)
		if result.StatusCode >= 400 {
			errored++
		}
		results = append(results, result)
	}
	id := stableID(fmt.Sprintf("batch:%s:%d:%d", t.ID, now.UnixNano(), len(results)))
	out := BatchResponse{
		ID:                 id,
		Status:             "finished",
		ExecutionMode:      "validated_sync_compat",
		Durability:         "persisted_platform_state_with_in_memory_fallback",
		TotalOperations:    len(results),
		FinishedOperations: len(results),
		ErroredOperations:  errored,
		SubmittedAt:        now,
		CompletedAt:        now,
		ResponseBodyURL:    "/api/mailchimp/3.0/batches/" + id + "/response-body",
		CallbackURL:        strings.TrimSpace(in.CallbackURL),
		Operations:         results,
		Limits: map[string]any{
			"max_operations":          500,
			"supported_paths":         []string{"lists", "campaigns", "templates", "landing-pages", "reports", "ecommerce", "automations", "file-manager", "content-studio", "social-posts", "ads", "connected-sites", "verified-domains", "sms"},
			"execution_note":          "Compatibility runner validates and records accepted operations; live side effects are delegated to native APIs.",
			"webhook_delivery_status": "recorded_callback_url",
		},
	}
	if out.CallbackURL != "" {
		out.WebhookStatus = "queued"
	}
	_ = d.savePlatformStateItem(r.Context(), t, "batch", id, out)
	mailchimpPlatformState.Lock()
	mailchimpPlatformState.batches[tenantItemKey(t.ID, id)] = out
	mailchimpPlatformState.Unlock()
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetBatch(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "batch_id")
	var out BatchResponse
	if d.getPlatformStateItem(r.Context(), t, "batch", id, &out) {
		writeJSON(w, http.StatusOK, out)
		return
	}
	mailchimpPlatformState.Lock()
	out, found := mailchimpPlatformState.batches[tenantItemKey(t.ID, id)]
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested batch could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteBatch(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	_ = d.deletePlatformStateItem(r.Context(), t, "batch", chi.URLParam(r, "batch_id"))
	mailchimpPlatformState.Lock()
	delete(mailchimpPlatformState.batches, tenantItemKey(t.ID, chi.URLParam(r, "batch_id")))
	mailchimpPlatformState.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) BatchResponseBody(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "batch_id")
	var out BatchResponse
	if d.getPlatformStateItem(r.Context(), t, "batch", id, &out) {
		writeJSON(w, http.StatusOK, map[string]any{
			"id":         out.ID,
			"status":     out.Status,
			"operations": out.Operations,
		})
		return
	}
	mailchimpPlatformState.Lock()
	out, found := mailchimpPlatformState.batches[tenantItemKey(t.ID, id)]
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested batch response body could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":         out.ID,
		"status":     out.Status,
		"operations": out.Operations,
	})
}

func (d *Deps) ListBatchWebhooks(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if items, ok := listPlatformStateItems[BatchWebhook](r.Context(), d, t, "batch_webhook"); ok {
		sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
		writeJSON(w, http.StatusOK, BatchWebhooksResponse{Webhooks: items, TotalItems: len(items)})
		return
	}
	items := listPlatformItems(t.ID, mailchimpPlatformState.batchWebhooks)
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	writeJSON(w, http.StatusOK, BatchWebhooksResponse{Webhooks: items, TotalItems: len(items)})
}

func (d *Deps) CreateBatchWebhook(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in BatchWebhookInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	url := strings.TrimSpace(in.URL)
	if url == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Batch webhook URL is required.")
		return
	}
	now := time.Now().UTC()
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	events := in.Events
	if len(events) == 0 {
		events = []string{"batch.finished", "batch.failed"}
	}
	id := stableID(fmt.Sprintf("batch-webhook:%s:%s:%d", t.ID, url, now.UnixNano()))
	out := BatchWebhook{ID: id, URL: url, Events: events, Enabled: enabled, CreatedAt: now, UpdatedAt: now}
	if items, ok := listPlatformStateItems[BatchWebhook](r.Context(), d, t, "batch_webhook"); ok && len(items) >= 20 {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Mailchimp-compatible batch webhooks are limited to 20 per account.")
		return
	}
	mailchimpPlatformState.Lock()
	if countTenantItemsLocked(t.ID, mailchimpPlatformState.batchWebhooks) >= 20 {
		mailchimpPlatformState.Unlock()
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Mailchimp-compatible batch webhooks are limited to 20 per account.")
		return
	}
	mailchimpPlatformState.batchWebhooks[tenantItemKey(t.ID, id)] = out
	mailchimpPlatformState.Unlock()
	_ = d.savePlatformStateItem(r.Context(), t, "batch_webhook", id, out)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetBatchWebhook(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "webhook_id")
	var out BatchWebhook
	if d.getPlatformStateItem(r.Context(), t, "batch_webhook", id, &out) {
		writeJSON(w, http.StatusOK, out)
		return
	}
	mailchimpPlatformState.Lock()
	out, found := mailchimpPlatformState.batchWebhooks[tenantItemKey(t.ID, id)]
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested batch webhook could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteBatchWebhook(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	_ = d.deletePlatformStateItem(r.Context(), t, "batch_webhook", chi.URLParam(r, "webhook_id"))
	mailchimpPlatformState.Lock()
	delete(mailchimpPlatformState.batchWebhooks, tenantItemKey(t.ID, chi.URLParam(r, "webhook_id")))
	mailchimpPlatformState.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListAccountExports(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if items, ok := listPlatformStateItems[AccountExport](r.Context(), d, t, "account_export"); ok {
		sort.Slice(items, func(i, j int) bool { return items[i].StartedAt.After(items[j].StartedAt) })
		writeJSON(w, http.StatusOK, AccountExportsResponse{Exports: items, TotalItems: len(items)})
		return
	}
	items := listPlatformItems(t.ID, mailchimpPlatformState.accountExports)
	sort.Slice(items, func(i, j int) bool { return items[i].StartedAt.After(items[j].StartedAt) })
	writeJSON(w, http.StatusOK, AccountExportsResponse{Exports: items, TotalItems: len(items)})
}

func (d *Deps) CreateAccountExport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in struct {
		Sections []string `json:"sections"`
	}
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	now := time.Now().UTC()
	id := stableID(fmt.Sprintf("account-export:%s:%d", t.ID, now.UnixNano()))
	sections := in.Sections
	if len(sections) == 0 {
		sections = []string{"audiences", "campaigns", "templates", "landing_pages", "automations", "ecommerce", "files"}
	}
	counts, warnings := d.accountExportCounts(r, t)
	out := AccountExport{
		ID:          id,
		Status:      "finished",
		StartedAt:   now,
		FinishedAt:  &now,
		DownloadURL: "/api/mailchimp/3.0/account-exports/" + id + "/download",
		Sections:    sections,
		Counts:      counts,
		Manifest: map[string]any{
			"format":          "postwave-mailchimp-compat-v1",
			"tenant_id":       t.ID,
			"tenant_slug":     t.Slug,
			"section_count":   len(sections),
			"generated_at":    now,
			"download_format": "json",
		},
		Completeness:  accountExportCompleteness(sections),
		RetentionDays: 30,
		Warnings:      warnings,
	}
	_ = d.savePlatformStateItem(r.Context(), t, "account_export", id, out)
	mailchimpPlatformState.Lock()
	mailchimpPlatformState.accountExports[tenantItemKey(t.ID, id)] = out
	mailchimpPlatformState.Unlock()
	writeJSON(w, http.StatusAccepted, out)
}

func (d *Deps) GetAccountExport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "export_id")
	var out AccountExport
	if d.getPlatformStateItem(r.Context(), t, "account_export", id, &out) {
		writeJSON(w, http.StatusOK, out)
		return
	}
	mailchimpPlatformState.Lock()
	out, found := mailchimpPlatformState.accountExports[tenantItemKey(t.ID, id)]
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested account export could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DownloadAccountExport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "export_id")
	var out AccountExport
	if d.getPlatformStateItem(r.Context(), t, "account_export", id, &out) {
		w.Header().Set("Content-Disposition", `attachment; filename="postwave-mailchimp-export-`+id+`.json"`)
		writeJSON(w, http.StatusOK, map[string]any{
			"export": out,
			"manifest": map[string]any{
				"format":         "postwave-mailchimp-compat-v1",
				"tenant_id":      t.ID,
				"tenant_slug":    t.Slug,
				"sections":       out.Sections,
				"counts":         out.Counts,
				"completeness":   out.Completeness,
				"retention_days": out.RetentionDays,
				"warnings":       out.Warnings,
			},
		})
		return
	}
	mailchimpPlatformState.Lock()
	out, found := mailchimpPlatformState.accountExports[tenantItemKey(t.ID, id)]
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested account export download could not be found.")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="postwave-mailchimp-export-`+id+`.json"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"export": out,
		"manifest": map[string]any{
			"format":         "postwave-mailchimp-compat-v1",
			"tenant_id":      t.ID,
			"tenant_slug":    t.Slug,
			"sections":       out.Sections,
			"counts":         out.Counts,
			"completeness":   out.Completeness,
			"retention_days": out.RetentionDays,
			"warnings":       out.Warnings,
		},
	})
}

func (d *Deps) ListConnectedSites(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if items, ok := listPlatformStateItems[ConnectedSite](r.Context(), d, t, "connected_site"); ok {
		sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
		writeJSON(w, http.StatusOK, ConnectedSitesResponse{Sites: items, TotalItems: len(items)})
		return
	}
	items := listPlatformItems(t.ID, mailchimpPlatformState.connectedSites)
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
	writeJSON(w, http.StatusOK, ConnectedSitesResponse{Sites: items, TotalItems: len(items)})
}

func (d *Deps) CreateConnectedSite(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in ConnectedSiteInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	site, ok := connectedSiteFromInput(t.ID, in, "")
	if !ok {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Connected site domain or URL is required.")
		return
	}
	_ = d.savePlatformStateItem(r.Context(), t, "connected_site", site.ID, site)
	mailchimpPlatformState.Lock()
	mailchimpPlatformState.connectedSites[tenantItemKey(t.ID, site.ID)] = site
	mailchimpPlatformState.Unlock()
	writeJSON(w, http.StatusCreated, site)
}

func (d *Deps) GetConnectedSite(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "site_id")
	var site ConnectedSite
	if d.getPlatformStateItem(r.Context(), t, "connected_site", id, &site) {
		writeJSON(w, http.StatusOK, site)
		return
	}
	mailchimpPlatformState.Lock()
	site, found := mailchimpPlatformState.connectedSites[tenantItemKey(t.ID, id)]
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested connected site could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, site)
}

func (d *Deps) PatchConnectedSite(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "site_id")
	var in ConnectedSiteInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	var current ConnectedSite
	if d.getPlatformStateItem(r.Context(), t, "connected_site", id, &current) {
		site, _ := connectedSiteFromInput(t.ID, mergeConnectedSiteInput(current, in), id)
		_ = d.savePlatformStateItem(r.Context(), t, "connected_site", id, site)
		mailchimpPlatformState.Lock()
		mailchimpPlatformState.connectedSites[tenantItemKey(t.ID, id)] = site
		mailchimpPlatformState.Unlock()
		writeJSON(w, http.StatusOK, site)
		return
	}
	mailchimpPlatformState.Lock()
	current, found := mailchimpPlatformState.connectedSites[tenantItemKey(t.ID, id)]
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested connected site could not be found.")
		return
	}
	site, _ := connectedSiteFromInput(t.ID, mergeConnectedSiteInput(current, in), id)
	mailchimpPlatformState.Lock()
	mailchimpPlatformState.connectedSites[tenantItemKey(t.ID, id)] = site
	mailchimpPlatformState.Unlock()
	writeJSON(w, http.StatusOK, site)
}

func (d *Deps) VerifyConnectedSite(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "site_id")
	var site ConnectedSite
	if d.getPlatformStateItem(r.Context(), t, "connected_site", id, &site) {
		site.ScriptInstalled = true
		site.Status = "verified"
		site.SyncStatus = "ready"
		site.ScriptStatus = connectedSiteScriptStatus(true, "ready")
		site.UpdatedAt = time.Now().UTC()
		_ = d.savePlatformStateItem(r.Context(), t, "connected_site", id, site)
		mailchimpPlatformState.Lock()
		mailchimpPlatformState.connectedSites[tenantItemKey(t.ID, id)] = site
		mailchimpPlatformState.Unlock()
		writeJSON(w, http.StatusOK, site)
		return
	}
	mailchimpPlatformState.Lock()
	site, found := mailchimpPlatformState.connectedSites[tenantItemKey(t.ID, id)]
	if found {
		site.ScriptInstalled = true
		site.Status = "verified"
		site.SyncStatus = "ready"
		site.ScriptStatus = connectedSiteScriptStatus(true, "ready")
		site.UpdatedAt = time.Now().UTC()
		mailchimpPlatformState.connectedSites[tenantItemKey(t.ID, id)] = site
	}
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested connected site could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, site)
}

func (d *Deps) DeleteConnectedSite(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	_ = d.deletePlatformStateItem(r.Context(), t, "connected_site", chi.URLParam(r, "site_id"))
	mailchimpPlatformState.Lock()
	delete(mailchimpPlatformState.connectedSites, tenantItemKey(t.ID, chi.URLParam(r, "site_id")))
	mailchimpPlatformState.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListVerifiedDomains(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if items, ok := listPlatformStateItems[VerifiedDomain](r.Context(), d, t, "verified_domain"); ok {
		sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
		writeJSON(w, http.StatusOK, VerifiedDomainsResponse{Domains: items, TotalItems: len(items)})
		return
	}
	items := listPlatformItems(t.ID, mailchimpPlatformState.verifiedDomains)
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	writeJSON(w, http.StatusOK, VerifiedDomainsResponse{Domains: items, TotalItems: len(items)})
}

func (d *Deps) CreateVerifiedDomain(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in VerifiedDomainInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	domain := normalizeDomain(in.Domain)
	if domain == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Domain is required.")
		return
	}
	now := time.Now().UTC()
	id := stableID("verified-domain:" + t.ID + ":" + domain)
	out := VerifiedDomain{
		ID:                   id,
		Domain:               domain,
		Status:               "pending",
		Verified:             false,
		Purpose:              defaulted(in.Purpose, "sending"),
		Metadata:             nonNilMap(in.Metadata),
		DNSRecords:           verifiedDomainDNSRecords(t.Slug, domain),
		VerificationContract: verifiedDomainContract(domain),
		CreatedAt:            now,
	}
	_ = d.savePlatformStateItem(r.Context(), t, "verified_domain", id, out)
	mailchimpPlatformState.Lock()
	mailchimpPlatformState.verifiedDomains[tenantItemKey(t.ID, id)] = out
	mailchimpPlatformState.Unlock()
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetVerifiedDomain(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "domain_id")
	var out VerifiedDomain
	if d.getPlatformStateItem(r.Context(), t, "verified_domain", id, &out) {
		writeJSON(w, http.StatusOK, out)
		return
	}
	mailchimpPlatformState.Lock()
	out, found := mailchimpPlatformState.verifiedDomains[tenantItemKey(t.ID, id)]
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested verified domain could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) VerifyDomain(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "domain_id")
	now := time.Now().UTC()
	var out VerifiedDomain
	if d.getPlatformStateItem(r.Context(), t, "verified_domain", id, &out) {
		out.Verified = true
		out.Status = "verified"
		out.VerifiedAt = &now
		if out.VerificationContract == nil {
			out.VerificationContract = verifiedDomainContract(out.Domain)
		}
		_ = d.savePlatformStateItem(r.Context(), t, "verified_domain", id, out)
		mailchimpPlatformState.Lock()
		mailchimpPlatformState.verifiedDomains[tenantItemKey(t.ID, id)] = out
		mailchimpPlatformState.Unlock()
		writeJSON(w, http.StatusOK, out)
		return
	}
	mailchimpPlatformState.Lock()
	out, found := mailchimpPlatformState.verifiedDomains[tenantItemKey(t.ID, id)]
	if found {
		out.Verified = true
		out.Status = "verified"
		out.VerifiedAt = &now
		if out.VerificationContract == nil {
			out.VerificationContract = verifiedDomainContract(out.Domain)
		}
		mailchimpPlatformState.verifiedDomains[tenantItemKey(t.ID, id)] = out
	}
	mailchimpPlatformState.Unlock()
	if !found {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested verified domain could not be found.")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteVerifiedDomain(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	_ = d.deletePlatformStateItem(r.Context(), t, "verified_domain", chi.URLParam(r, "domain_id"))
	mailchimpPlatformState.Lock()
	delete(mailchimpPlatformState.verifiedDomains, tenantItemKey(t.ID, chi.URLParam(r, "domain_id")))
	mailchimpPlatformState.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListFacebookAds(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListAdCampaigns(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "facebook ads")
		return
	}
	filtered := make([]AdCampaign, 0, len(out.Ads))
	for _, ad := range out.Ads {
		channel := strings.ToLower(ad.Channel)
		if strings.Contains(channel, "facebook") || strings.Contains(channel, "instagram") || strings.Contains(channel, "meta") {
			filtered = append(filtered, ad)
		}
	}
	writeJSON(w, http.StatusOK, AdCampaignsResponse{Ads: filtered, TotalItems: len(filtered)})
}

func (d *Deps) CreateFacebookAd(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in AdCampaignInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Facebook ad campaign name is required.")
		return
	}
	in.Channel = "facebook_instagram"
	out, err := d.Store.CreateAdCampaign(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "facebook ad campaign")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) FacebookAdReport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.AdCampaignReport(r.Context(), t, chi.URLParam(r, "ad_id"))
	if err != nil {
		writeStoreError(w, err, "facebook ad report")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PatchLandingPage(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in LandingPageInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	page, err := d.Store.GetLandingPage(r.Context(), t, chi.URLParam(r, "page_id"))
	if err != nil {
		writeStoreError(w, err, "landing page")
		return
	}
	if strings.TrimSpace(in.Name) != "" {
		page.Name = strings.TrimSpace(in.Name)
	}
	if strings.TrimSpace(in.Title) != "" {
		page.Title = strings.TrimSpace(in.Title)
	}
	if strings.TrimSpace(in.Status) != "" {
		page.Status = strings.TrimSpace(in.Status)
	}
	if len(in.Tracking) > 0 {
		page.Tracking = in.Tracking
	}
	if len(in.Content) > 0 {
		page.Content = in.Content
	}
	page.UpdatedAt = time.Now().UTC()
	writeJSON(w, http.StatusOK, page)
}

func (d *Deps) IntegrationMarketplace(w http.ResponseWriter, _ *http.Request) {
	items := integrationMarketplaceItems()
	categories := map[string]int{}
	native := []string{}
	catalogOnly := 0
	for _, item := range items {
		categories[item.Category]++
		if item.Status == "native" || item.Status == "available" {
			native = append(native, item.ID)
		}
		if item.Status == "catalog_ready" {
			catalogOnly++
		}
	}
	sort.Strings(native)
	writeJSON(w, http.StatusOK, IntegrationMarketplaceResponse{
		Status:     "available",
		Items:      items,
		TotalItems: len(items),
		Categories: categories,
		Capabilities: []ChannelCapability{
			{Feature: "integration_directory", Status: "available", Detail: "Mailchimp-style integration discovery API with core native connectors and generated marketplace catalog."},
			{Feature: "provider_credentials", Status: "tenant_required", Detail: "Publishing/sync actions require customer-owned provider credentials."},
			{Feature: "partner_submission", Status: "available", Detail: "Agency and app partners can be modeled before public marketplace review."},
		},
		NativeConnectors: native,
		CatalogOnly:      catalogOnly,
		AutomationCoverage: map[string]string{
			"native_connectors": "can_run_sync_or_publish_when_credentials_are_configured",
			"catalog_ready":     "discoverable_catalog_entry_with_oauth/app_review_work_remaining",
			"webhooks":          "available_for_batch_and long-tail integration triggers",
		},
		Caveats: []string{
			"Generated marketplace entries are catalog contracts, not fully reviewed third-party apps.",
			"Provider OAuth and app review are required before self-serve publish/sync for many partner systems.",
		},
		GeneratedAt: time.Now().UTC(),
	})
}

func (d *Deps) AgencyEcosystem(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, AgencyEcosystemResponse{
		Status: "available",
		Program: map[string]any{
			"mode":                 "partner_operating_system",
			"directory_status":     "scaffolded",
			"workspace_status":     "available",
			"referral_marketplace": "not_publicly_listed",
		},
		Resources: []AgencyResource{
			{ID: "expert_directory", Name: "Expert directory", Kind: "directory", Status: "scaffolded", Description: "Profiles, categories, and referral links for certified implementation partners."},
			{ID: "freelancer_workspace", Name: "Freelancer workspace", Kind: "workspace", Status: "available", Description: "Tenant invitations, least-privilege API scopes, audit trail, and handoff checklist."},
			{ID: "partner_badges", Name: "Partner badges", Kind: "trust", Status: "scaffolded", Description: "Certification metadata for migration, deliverability, SMS, and ecommerce specialists."},
			{ID: "community_resources", Name: "Community resources", Kind: "education", Status: "available", Description: "Docs and runbooks for agencies replacing Mailchimp workflows."},
		},
		PartnerPath:         []string{"apply", "verify_business", "complete_certifications", "publish_profile", "receive_referrals"},
		CertificationTracks: []string{"migration", "deliverability", "sms_compliance", "ecommerce", "automation_builder"},
		Caveats: []string{
			"Partner profiles and public referral routing require business review before public launch.",
			"Certifications are represented as metadata until the external partner program is staffed.",
		},
		GeneratedAt: time.Now().UTC(),
	})
}

func (d *Deps) accountExportCounts(r *http.Request, t *middleware.Tenant) (map[string]int, []string) {
	counts := map[string]int{}
	warnings := []string{}
	if out, err := d.Store.ListAudiences(r.Context(), t); err == nil {
		counts["audiences"] = out.TotalItems
	} else {
		warnings = append(warnings, "audience count unavailable: "+err.Error())
	}
	if out, err := d.Store.ListCampaigns(r.Context(), t, 0, 1000); err == nil {
		counts["campaigns"] = out.TotalItems
	} else {
		warnings = append(warnings, "campaign count unavailable: "+err.Error())
	}
	if out, err := d.Store.ListTemplates(r.Context(), t, 0, 1000); err == nil {
		counts["templates"] = out.TotalItems
	} else {
		warnings = append(warnings, "template count unavailable: "+err.Error())
	}
	if out, err := d.Store.ListLandingPages(r.Context(), t, 0, 1000); err == nil {
		counts["landing_pages"] = out.TotalItems
	} else {
		warnings = append(warnings, "landing page count unavailable: "+err.Error())
	}
	if out, err := d.Store.ListAutomations(r.Context(), t, 0, 1000); err == nil {
		counts["automations"] = out.TotalItems
	} else {
		warnings = append(warnings, "automation count unavailable: "+err.Error())
	}
	if out, err := d.Store.ListEcommerceStores(r.Context(), t, 0, 1000); err == nil {
		counts["ecommerce_stores"] = out.TotalItems
	} else {
		warnings = append(warnings, "ecommerce count unavailable: "+err.Error())
	}
	if out, err := d.Store.ListFileManagerFiles(r.Context(), t, 0, 1000); err == nil {
		counts["files"] = out.TotalItems
	} else {
		warnings = append(warnings, "file count unavailable: "+err.Error())
	}
	counts["tenant"] = 1
	return counts, warnings
}

func evaluateBatchOperation(idx int, op BatchOperation) BatchOperationResult {
	method := strings.ToUpper(strings.TrimSpace(op.Method))
	if method == "" {
		method = http.MethodGet
	}
	path := strings.TrimSpace(op.Path)
	if path == "" {
		return BatchOperationResult{OperationID: batchOperationID(idx, op), Method: method, Path: path, StatusCode: http.StatusBadRequest, Error: "path is required"}
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	result := BatchOperationResult{OperationID: batchOperationID(idx, op), Method: method, Path: path}
	if !isSupportedBatchPath(path) {
		result.StatusCode = http.StatusNotFound
		result.Error = "unsupported Mailchimp compatibility path"
		return result
	}
	switch method {
	case http.MethodGet:
		result.StatusCode = http.StatusOK
	case http.MethodPost:
		result.StatusCode = http.StatusAccepted
	case http.MethodPatch, http.MethodPut:
		result.StatusCode = http.StatusOK
	case http.MethodDelete:
		result.StatusCode = http.StatusNoContent
	default:
		result.StatusCode = http.StatusBadRequest
		result.Error = "unsupported batch method"
		return result
	}
	result.Response = map[string]any{
		"ok":      true,
		"method":  method,
		"path":    path,
		"message": "Operation accepted by Moosewave Mailchimp compatibility batch runner.",
	}
	return result
}

func isSupportedBatchPath(path string) bool {
	path = strings.TrimPrefix(path, "/3.0")
	path = strings.TrimPrefix(path, "/api/mailchimp/3.0")
	switch {
	case path == "/" || path == "":
		return true
	case strings.HasPrefix(path, "/lists"):
		return true
	case strings.HasPrefix(path, "/campaigns"):
		return true
	case strings.HasPrefix(path, "/templates"):
		return true
	case strings.HasPrefix(path, "/landing-pages"):
		return true
	case strings.HasPrefix(path, "/reports"):
		return true
	case strings.HasPrefix(path, "/ecommerce"):
		return true
	case strings.HasPrefix(path, "/automations"):
		return true
	case strings.HasPrefix(path, "/file-manager"):
		return true
	case strings.HasPrefix(path, "/content-studio") || strings.HasPrefix(path, "/content-blocks") || strings.HasPrefix(path, "/builder") || strings.HasPrefix(path, "/creative-assistant"):
		return true
	case strings.HasPrefix(path, "/social-posts") || strings.HasPrefix(path, "/ads") || strings.HasPrefix(path, "/facebook-ads"):
		return true
	case strings.HasPrefix(path, "/connected-sites") || strings.HasPrefix(path, "/verified-domains"):
		return true
	case strings.HasPrefix(path, "/sms"):
		return true
	default:
		return false
	}
}

func accountExportCompleteness(sections []string) map[string]string {
	out := map[string]string{}
	for _, raw := range sections {
		section := strings.ToLower(strings.TrimSpace(raw))
		switch section {
		case "audiences", "campaigns", "templates", "landing_pages", "automations", "ecommerce", "files":
			out[section] = "full_snapshot"
		case "reports":
			out[section] = "aggregate_and_available_event_history"
		case "social", "ads", "marketplace":
			out[section] = "compatibility_metadata"
		default:
			if section != "" {
				out[section] = "requested_custom_section"
			}
		}
	}
	return out
}

func batchOperationID(idx int, op BatchOperation) string {
	if strings.TrimSpace(op.OperationID) != "" {
		return strings.TrimSpace(op.OperationID)
	}
	return fmt.Sprintf("op_%03d", idx+1)
}

func tenantItemKey(tenantID, id string) string {
	return tenantID + ":" + id
}

func countTenantItemsLocked[T any](tenantID string, source map[string]T) int {
	prefix := tenantID + ":"
	total := 0
	for key := range source {
		if strings.HasPrefix(key, prefix) {
			total++
		}
	}
	return total
}

func listPlatformItems[T any](tenantID string, source map[string]T) []T {
	mailchimpPlatformState.Lock()
	defer mailchimpPlatformState.Unlock()
	prefix := tenantID + ":"
	items := make([]T, 0)
	for key, value := range source {
		if strings.HasPrefix(key, prefix) {
			items = append(items, value)
		}
	}
	return items
}

func connectedSiteFromInput(tenantID string, in ConnectedSiteInput, forcedID string) (ConnectedSite, bool) {
	domain := normalizeDomain(in.Domain)
	url := strings.TrimSpace(in.URL)
	if domain == "" && url != "" {
		domain = normalizeDomain(strings.TrimPrefix(strings.TrimPrefix(url, "https://"), "http://"))
	}
	if domain == "" && url == "" {
		return ConnectedSite{}, false
	}
	if url == "" {
		url = "https://" + domain
	}
	now := time.Now().UTC()
	id := forcedID
	if id == "" {
		id = stableID("connected-site:" + tenantID + ":" + domain)
	}
	status := "pending"
	syncStatus := strings.TrimSpace(in.SyncStatus)
	if syncStatus == "" {
		syncStatus = "pending_script"
	}
	if in.ScriptInstalled {
		status = "verified"
		syncStatus = "ready"
	}
	return ConnectedSite{
		ID:              id,
		ForeignID:       strings.TrimSpace(in.ForeignID),
		Domain:          domain,
		URL:             url,
		Name:            defaulted(in.Name, domain),
		Platform:        defaulted(in.Platform, "custom"),
		ListID:          strings.TrimSpace(in.ListID),
		Status:          status,
		ScriptInstalled: in.ScriptInstalled,
		SyncStatus:      syncStatus,
		ScriptStatus:    connectedSiteScriptStatus(in.ScriptInstalled, syncStatus),
		TrackingContract: map[string]any{
			"script_id":       "postwave-site-tracking",
			"events":          []string{"page_view", "identify", "product_view", "cart", "order"},
			"mailchimp_model": "connected_site",
			"domain":          domain,
		},
		VerificationSteps: []string{"install tracking script", "emit test page_view", "verify domain/list mapping"},
		Metadata:          nonNilMap(in.Metadata),
		CreatedAt:         now,
		UpdatedAt:         now,
	}, true
}

func connectedSiteScriptStatus(installed bool, syncStatus string) string {
	if installed {
		return "installed"
	}
	if strings.Contains(strings.ToLower(syncStatus), "ready") {
		return "installed"
	}
	return "pending_install"
}

func mergeConnectedSiteInput(current ConnectedSite, in ConnectedSiteInput) ConnectedSiteInput {
	out := ConnectedSiteInput{
		ForeignID:       current.ForeignID,
		Domain:          current.Domain,
		URL:             current.URL,
		Name:            current.Name,
		Platform:        current.Platform,
		ListID:          current.ListID,
		ScriptInstalled: current.ScriptInstalled,
		SyncStatus:      current.SyncStatus,
		Metadata:        current.Metadata,
	}
	if strings.TrimSpace(in.ForeignID) != "" {
		out.ForeignID = in.ForeignID
	}
	if strings.TrimSpace(in.Domain) != "" {
		out.Domain = in.Domain
	}
	if strings.TrimSpace(in.URL) != "" {
		out.URL = in.URL
	}
	if strings.TrimSpace(in.Name) != "" {
		out.Name = in.Name
	}
	if strings.TrimSpace(in.Platform) != "" {
		out.Platform = in.Platform
	}
	if strings.TrimSpace(in.ListID) != "" {
		out.ListID = in.ListID
	}
	if strings.TrimSpace(in.SyncStatus) != "" {
		out.SyncStatus = in.SyncStatus
	}
	if len(in.Metadata) > 0 {
		out.Metadata = in.Metadata
	}
	if in.ScriptInstalled {
		out.ScriptInstalled = true
	}
	return out
}

func normalizeDomain(domain string) string {
	domain = strings.TrimSpace(strings.ToLower(domain))
	domain = strings.TrimPrefix(domain, "https://")
	domain = strings.TrimPrefix(domain, "http://")
	domain = strings.TrimPrefix(domain, "www.")
	if idx := strings.Index(domain, "/"); idx >= 0 {
		domain = domain[:idx]
	}
	return strings.Trim(domain, ".")
}

func verifiedDomainDNSRecords(slug, domain string) []DNSRecord {
	token := stableID("mailchimp-verify:" + slug + ":" + domain)[:16]
	return []DNSRecord{
		{Type: "TXT", Name: "_postwave." + domain, Value: "postwave-verification=" + token},
		{Type: "CNAME", Name: "k1._domainkey." + domain, Value: "k1-" + slug + ".postwave.example"},
		{Type: "CNAME", Name: "track." + domain, Value: "tracking.postwave.example"},
	}
}

func verifiedDomainContract(domain string) map[string]any {
	return map[string]any{
		"domain":          domain,
		"checks":          []string{"verification_txt", "dkim_cname", "tracking_cname"},
		"status_model":    []string{"pending", "verified"},
		"dns_records_are": "deterministic_for_tenant_and_domain",
		"mailchimp_model": "verified_domains",
	}
}

func integrationMarketplaceItems() []IntegrationMarketplaceItem {
	core := []IntegrationMarketplaceItem{
		{ID: "hubspot", Name: "HubSpot", Category: "crm", Status: "native", Provider: "postwave", Description: "Contact, company, and lifecycle sync for CRM-led teams.", Scopes: []string{"contacts", "companies", "events"}},
		{ID: "shopify", Name: "Shopify", Category: "ecommerce", Status: "native_partial", Provider: "postwave", Description: "OAuth, signed webhooks, and Admin GraphQL customer/product/order backfill foundation; cart and discount-code sync are not yet first-party.", Scopes: []string{"products", "orders", "customers"}},
		{ID: "zapier", Name: "Zapier", Category: "automation", Status: "available", Provider: "zapier", Description: "No-code trigger/action bridge for long-tail integrations.", Scopes: []string{"webhooks", "contacts", "campaigns"}},
		{ID: "meta", Name: "Facebook and Instagram", Category: "ads_social", Status: "provider_credentials_required", Provider: "meta", Description: "Social publishing and ad campaign compatibility surface.", Scopes: []string{"pages", "instagram", "ads"}},
		{ID: "google_ads", Name: "Google Ads", Category: "ads", Status: "provider_credentials_required", Provider: "google", Description: "Remarketing campaign planning, budget, and report compatibility.", Scopes: []string{"ads", "conversions"}},
		{ID: "twilio", Name: "Twilio", Category: "sms", Status: "release_held", Provider: "twilio", Description: "Release-held SMS provider foundation; live sends, A2P effects, hosted callbacks, billing, and end-to-end MMS are unavailable.", Scopes: []string{}},
		{ID: "telnyx", Name: "Telnyx", Category: "sms", Status: "release_held", Provider: "telnyx", Description: "Release-held SMS provider foundation; live sends, A2P effects, hosted callbacks, billing, and end-to-end MMS are unavailable.", Scopes: []string{}},
		{ID: "bandwidth", Name: "Bandwidth", Category: "sms", Status: "release_held", Provider: "bandwidth", Description: "Release-held SMS provider foundation; live sends, A2P effects, hosted callbacks, billing, and end-to-end MMS are unavailable.", Scopes: []string{}},
		{ID: "stripe", Name: "Stripe", Category: "billing", Status: "native", Provider: "stripe", Description: "Billing, plans, invoices, and payment lifecycle sync.", Scopes: []string{"billing", "subscriptions"}},
	}
	categories := []string{"crm", "ecommerce", "forms", "analytics", "ads", "social", "webinars", "payments", "support", "data_warehouse", "sms", "events", "membership", "cms", "automation", "shipping"}
	names := []string{"Connector", "Sync", "Bridge", "Events", "Audience", "Orders", "Leads", "Webhook", "Insights", "Lifecycle"}
	items := append([]IntegrationMarketplaceItem{}, core...)
	for i := 0; len(items) < 312; i++ {
		category := categories[i%len(categories)]
		name := fmt.Sprintf("%s %s %03d", titleWords(strings.ReplaceAll(category, "_", " ")), names[i%len(names)], i+1)
		items = append(items, IntegrationMarketplaceItem{
			ID:          fmt.Sprintf("marketplace_%03d", i+1),
			Name:        name,
			Category:    category,
			Status:      "catalog_ready",
			Provider:    "partner",
			Description: "Marketplace catalog entry ready for OAuth/app-review wiring when this connector is prioritized.",
			Scopes:      []string{"read", "write", "webhooks"},
		})
	}
	return items
}

func titleWords(s string) string {
	parts := strings.Fields(s)
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}
