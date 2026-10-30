package handlers

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

type RollbackRehearsalReport struct {
	JobID          string                   `json:"job_id"`
	Source         canonical.SourcePlatform `json:"source"`
	GeneratedAt    time.Time                `json:"generated_at"`
	Status         string                   `json:"status"` // pass|warning|blocker
	CountSource    string                   `json:"count_source,omitempty"`
	RollbackUntil  *time.Time               `json:"rollback_until,omitempty"`
	TotalResources int                      `json:"total_resources"`
	Items          []RollbackRehearsalItem  `json:"items"`

	// destinationStateValidated is deliberately not serialized. It is an
	// internal persistence guard proving this report ran the current read-only
	// rollback preflight rather than the legacy count-only rehearsal.
	destinationStateValidated bool
}

type RollbackRehearsalItem struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Status string `json:"status"` // pass|warning|blocker
	Count  int    `json:"count,omitempty"`
	Detail string `json:"detail,omitempty"`
	Order  int    `json:"order,omitempty"`
}

func (h *Migration) GetRollbackRehearsal(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	jobID := chi.URLParam(r, "job_id")
	executionLease, err := h.acquireJobExecution(r.Context(), tenantID, jobID)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer func() { _ = executionLease.Release() }()
	job, err := h.loadJob(r.Context(), tenantID, jobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "rollback rehearsal evidence"); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	report := h.buildRollbackRehearsalReport(r.Context(), job, time.Now().UTC())
	if err := h.persistRollbackRehearsalEvidence(jobstore.WithTenantID(r.Context(), tenantID), job, report); err != nil {
		writeTransitionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (h *Migration) persistRollbackRehearsalEvidence(ctx context.Context, job *canonical.MigrationJob, report RollbackRehearsalReport) error {
	if job == nil {
		return nil
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	status := report.Status
	generatedAt := report.GeneratedAt.UTC().Format(time.RFC3339)
	total := strconv.Itoa(report.TotalResources)
	job.Cursor[rollbackRehearsalStatusKey] = &status
	job.Cursor[rollbackRehearsalAtKey] = &generatedAt
	job.Cursor[rollbackRehearsalTotalKey] = &total
	if report.CountSource != "" {
		countSource := report.CountSource
		job.Cursor[rollbackRehearsalSourceKey] = &countSource
	}
	if report.destinationStateValidated {
		validation := rollbackRehearsalValidationV1
		job.Cursor[rollbackRehearsalValidationKey] = &validation
	} else {
		delete(job.Cursor, rollbackRehearsalValidationKey)
	}
	return h.transitionJob(ctx, job, job.Status)
}

func BuildRollbackRehearsalReport(job *canonical.MigrationJob, now time.Time) RollbackRehearsalReport {
	return buildRollbackRehearsalReport(job, now, nil, "progress")
}

func (h *Migration) buildRollbackRehearsalReport(ctx context.Context, job *canonical.MigrationJob, now time.Time) RollbackRehearsalReport {
	if job == nil {
		return BuildRollbackRehearsalReport(job, now)
	}
	if h == nil || h.db == nil || job.TenantID == "" {
		out := buildRollbackRehearsalReport(job, now, nil, "progress")
		if strictRollbackRehearsalSource(job.Source) {
			out.addRollbackItem(RollbackRehearsalItem{
				Key:    "rollback_ledger",
				Label:  "Imported-resource ledger",
				Status: "blocker",
				Detail: rollbackLedgerRequiredDetail(job.Source),
			})
			out.finishRollback()
		}
		out.addRollbackItem(RollbackRehearsalItem{
			Key:    "destination_preflight",
			Label:  "Destination conflict preflight",
			Status: "blocker",
			Detail: "Current destination state and rollback after-images cannot be validated without the Postgres imported-resource ledger.",
		})
		out.finishRollback()
		return out
	}
	counts, err := rollbackRehearsalLedgerCounts(ctx, h.db, job)
	if err != nil {
		out := buildRollbackRehearsalReport(job, now, nil, "progress")
		out.addRollbackItem(RollbackRehearsalItem{
			Key:    "rollback_ledger",
			Label:  "Imported-resource ledger",
			Status: "blocker",
			Detail: "Imported-resource rollback ledger could not be read: " + err.Error(),
		})
		out.finishRollback()
		return out
	}
	out := buildRollbackRehearsalReport(job, now, counts, "imported_resource_ledger")
	intentCount, intentErr := listmonkx.CountExternalWriteIntents(ctx, h.db, job.TenantID, job.ID)
	if intentErr != nil {
		out.addRollbackItem(RollbackRehearsalItem{
			Key:    "external_write_intents",
			Label:  "Unresolved destination writes",
			Status: "blocker",
			Detail: "Durable destination-write intents could not be inspected. Restore database access before cutover or rollback.",
		})
		out.finishRollback()
	} else if intentCount > 0 {
		out.addRollbackItem(RollbackRehearsalItem{
			Key:    "external_write_intents",
			Label:  "Unresolved destination writes",
			Status: "blocker",
			Count:  intentCount,
			Detail: "One or more external mutation outcomes remain unresolved. Retry the migration or run rollback reconciliation before cutover; do not delete the intent ledger manually.",
		})
		out.finishRollback()
	}
	if out.TotalResources == 0 && rollbackProgressTotal(job) > 0 {
		out.addRollbackItem(RollbackRehearsalItem{
			Key:    "rollback_ledger",
			Label:  "Imported-resource ledger",
			Status: "blocker",
			Detail: "No active imported-resource ledger rows were found even though the job reports imported resources. Repair rollback tracking before cutover.",
		})
		out.finishRollback()
	}
	out.finishRollback()
	if out.Status != "pass" {
		return out
	}
	engine, err := h.newRollbackEngineForJob(ctx, job)
	if err != nil {
		out.addRollbackItem(RollbackRehearsalItem{
			Key:    "destination_preflight",
			Label:  "Destination conflict preflight",
			Status: "blocker",
			Detail: "Current rollback destinations could not be opened for read-only validation: " + sanitizeMigrationErrorText(job.Source, err),
		})
		out.finishRollback()
		return out
	}
	if err := engine.PreflightRollback(ctx, job); err != nil {
		out.addRollbackItem(RollbackRehearsalItem{
			Key:    "destination_preflight",
			Label:  "Destination conflict preflight",
			Status: "blocker",
			Detail: "Current destination state no longer matches the rollback ledger and tracked after-images: " + sanitizeMigrationErrorText(job.Source, err),
		})
		out.finishRollback()
		return out
	}
	out.destinationStateValidated = true
	out.addRollbackItem(RollbackRehearsalItem{
		Key:    "destination_preflight",
		Label:  "Destination conflict preflight",
		Status: "pass",
		Detail: "Current Listmonk ownership fingerprints and Postgres destination after-images match the rollback ledger.",
	})
	out.finishRollback()
	return out
}

func buildRollbackRehearsalReport(job *canonical.MigrationJob, now time.Time, counts map[string]int, countSource string) RollbackRehearsalReport {
	out := RollbackRehearsalReport{GeneratedAt: now, Status: "pass", CountSource: countSource}
	if job == nil {
		out.Status = "blocker"
		out.Items = append(out.Items, RollbackRehearsalItem{Key: "job", Label: "Migration job", Status: "blocker", Detail: "Migration job was not found."})
		return out
	}
	out.JobID = job.ID
	out.Source = job.Source
	out.RollbackUntil = job.RollbackUntil
	if job.Status != canonical.MigCompleted {
		out.addRollbackItem(RollbackRehearsalItem{Key: "job_status", Label: "Job completed", Status: "warning", Detail: "Rollback rehearsal is final only after the migration commit completes."})
	} else {
		out.addRollbackItem(RollbackRehearsalItem{Key: "job_status", Label: "Job completed", Status: "pass", Detail: "Migration commit is complete."})
	}
	if job.RollbackUntil == nil {
		out.addRollbackItem(RollbackRehearsalItem{Key: "rollback_window", Label: "Rollback window", Status: "blocker", Detail: "No rollback window is available for this job."})
	} else if now.After(*job.RollbackUntil) {
		out.addRollbackItem(RollbackRehearsalItem{Key: "rollback_window", Label: "Rollback window", Status: "blocker", Detail: "Rollback window has expired."})
	} else {
		out.addRollbackItem(RollbackRehearsalItem{Key: "rollback_window", Label: "Rollback window", Status: "pass", Detail: "Rollback window is open."})
	}
	out.addRollbackItem(RollbackRehearsalItem{
		Key:    "count_source",
		Label:  "Resource count source",
		Status: "pass",
		Detail: rollbackCountSourceDetail(countSource),
	})
	steps := rollbackRehearsalSteps(job, counts)
	for _, step := range steps {
		status := "pass"
		detail := "No rows to delete."
		if step.Count > 0 {
			detail = "Rollback will delete or revert tracked resources in this order."
			if countSource == "imported_resource_ledger" {
				detail = "Rollback will delete or revert ledger-tracked resources in this order."
			}
		}
		step.Status = status
		step.Detail = detail
		out.TotalResources += step.Count
		out.addRollbackItem(step)
	}
	if out.TotalResources == 0 {
		out.addRollbackItem(RollbackRehearsalItem{Key: "tracked_resources", Label: "Tracked resources", Status: "warning", Detail: "No tracked writes are recorded yet; run a commit before final rollback rehearsal."})
	}
	out.finishRollback()
	return out
}

func rollbackRehearsalLedgerCounts(ctx context.Context, db *sql.DB, job *canonical.MigrationJob) (map[string]int, error) {
	counts := map[string]int{}
	for _, step := range rollbackRehearsalStepSpecs(job) {
		for _, resourceType := range step.LedgerResourceTypes {
			resources, err := listmonkx.ListImportedResources(ctx, db, job.TenantID, job.ID, resourceType)
			if err != nil {
				return nil, err
			}
			counts[step.Key] += len(resources)
		}
	}
	return counts, nil
}

type rollbackRehearsalStepSpec struct {
	Key                 string
	Label               string
	Order               int
	ProgressCount       int
	LedgerResourceTypes []string
}

func rollbackRehearsalStepSpecs(job *canonical.MigrationJob) []rollbackRehearsalStepSpec {
	progress := canonical.MigrationProgress{}
	automationLabel := "Automations"
	if job != nil {
		progress = job.Progress
		if job.Source == canonical.SourceActiveCampaign {
			automationLabel = "Runtime automations"
		}
	}
	return []rollbackRehearsalStepSpec{
		{Key: "paid_subscriptions", Label: "Paid subscription mirrors", ProgressCount: progress.PaidSubsDone, Order: 1, LedgerResourceTypes: []string{listmonkx.ResourcePaidSubscription}},
		{Key: "templates", Label: "Editable templates", ProgressCount: progress.TemplatesDone, Order: 2, LedgerResourceTypes: []string{listmonkx.ResourceTemplate}},
		{Key: "source_materialized", Label: "Materialized source surfaces", Order: 3, LedgerResourceTypes: []string{
			listmonkx.ResourceAutomationJourney,
			listmonkx.ResourcePopupForm,
			listmonkx.ResourceLandingPage,
			listmonkx.ResourceCommerceIntegration,
		}},
		{Key: "source_archive", Label: "Source archive records", ProgressCount: progress.SourceArchiveDone, Order: 4, LedgerResourceTypes: []string{listmonkx.ResourceSourceArchive}},
		{Key: "campaign_archive", Label: "Campaign archive records", ProgressCount: progress.ArchiveDone, Order: 5, LedgerResourceTypes: []string{
			listmonkx.ResourceCampaignEvent,
			listmonkx.ResourceCampaign,
			listmonkx.ResourceCampaignArchive,
		}},
		{Key: "automations", Label: automationLabel, ProgressCount: progress.AutomationsDone, Order: 6, LedgerResourceTypes: []string{listmonkx.ResourceAutomation}},
		{Key: "segments", Label: "Segments", ProgressCount: progress.SegmentsDone, Order: 7, LedgerResourceTypes: []string{listmonkx.ResourceSegment}},
		{Key: "subscribers", Label: "Subscribers", ProgressCount: progress.SubscribersDone, Order: 8, LedgerResourceTypes: []string{listmonkx.ResourceSubscriber}},
		{Key: "lists", Label: "Audience lists", Order: 9, LedgerResourceTypes: []string{listmonkx.ResourceList}},
	}
}

func rollbackRehearsalSteps(job *canonical.MigrationJob, counts map[string]int) []RollbackRehearsalItem {
	specs := rollbackRehearsalStepSpecs(job)
	out := make([]RollbackRehearsalItem, 0, len(specs))
	for _, spec := range specs {
		count := spec.ProgressCount
		if counts != nil {
			count = counts[spec.Key]
		}
		out = append(out, RollbackRehearsalItem{
			Key:   spec.Key,
			Label: spec.Label,
			Count: count,
			Order: spec.Order,
		})
	}
	return out
}

func rollbackCountSourceDetail(countSource string) string {
	if countSource == "imported_resource_ledger" {
		return "Resource counts were read from the durable imported-resource rollback ledger."
	}
	return "Resource counts were derived from job progress counters."
}

func strictRollbackRehearsalSource(source canonical.SourcePlatform) bool {
	switch source {
	case canonical.SourceActiveCampaign, canonical.SourceHubSpot, canonical.SourceBeehiiv, canonical.SourceKlaviyo, canonical.SourceCustomerIO:
		return true
	default:
		return false
	}
}

func rollbackLedgerRequiredDetail(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceActiveCampaign:
		return "ActiveCampaign rollback rehearsal requires the durable imported-resource ledger; run the service with Postgres-backed rollback tracking before cutover."
	case canonical.SourceHubSpot:
		return "HubSpot bridge rollback rehearsal requires the durable imported-resource ledger; run the service with Postgres-backed rollback tracking before bridge acceptance."
	case canonical.SourceCustomerIO:
		return "Customer.io rollback rehearsal requires the durable imported-resource ledger; run the service with Postgres-backed rollback tracking before cutover."
	default:
		return "Rollback rehearsal requires the durable imported-resource ledger; run the service with Postgres-backed rollback tracking before cutover."
	}
}

func rollbackProgressTotal(job *canonical.MigrationJob) int {
	if job == nil {
		return 0
	}
	return job.Progress.PaidSubsDone +
		job.Progress.TemplatesDone +
		job.Progress.SourceArchiveDone +
		job.Progress.ArchiveDone +
		job.Progress.AutomationsDone +
		job.Progress.SegmentsDone +
		job.Progress.SubscribersDone
}

func (r *RollbackRehearsalReport) addRollbackItem(item RollbackRehearsalItem) {
	if item.Status == "" {
		item.Status = "pass"
	}
	r.Items = append(r.Items, item)
}

func (r *RollbackRehearsalReport) finishRollback() {
	r.Status = "pass"
	for _, item := range r.Items {
		if item.Status == "blocker" {
			r.Status = "blocker"
			return
		}
		if item.Status == "warning" && r.Status == "pass" {
			r.Status = "warning"
		}
	}
}
