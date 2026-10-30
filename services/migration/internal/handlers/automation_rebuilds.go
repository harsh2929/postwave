package handlers

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

var automationRebuildPassStatuses = map[string]bool{
	"test_passed":         true,
	"approved_not_needed": true,
}

func (h *Migration) ListAutomationRebuilds(w http.ResponseWriter, r *http.Request) {
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
	if err := activeCampaignPostPilotCleanupFreezeError(job, "automation rebuild evidence"); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if job.VerificationReport == nil {
		writeErr(w, http.StatusConflict, fmt.Errorf("verification report is not ready yet"))
		return
	}
	ensureAutomationRebuilds(job.VerificationReport)
	sanitizeMigrationJobEvidence(job)
	if err := h.transitionJob(jobstore.WithTenantID(r.Context(), tenantID), job, job.Status); err != nil {
		writeTransitionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": job.VerificationReport.AutomationRebuilds})
}

func (h *Migration) UpdateAutomationRebuilds(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	var in canonical.AutomationRebuildItem
	if err := decodeRequestJSON(w, r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
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
	if err := activeCampaignPostPilotCleanupFreezeError(job, "automation rebuild evidence"); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if job.VerificationReport == nil {
		writeErr(w, http.StatusConflict, fmt.Errorf("verification report is not ready yet"))
		return
	}
	item, err := updateAutomationRebuild(job.VerificationReport, in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	sanitizeMigrationJobEvidence(job)
	item.Notes = sanitizeMigrationText(job.Source, item.Notes)
	item.TestEvidence = sanitizeMigrationText(job.Source, item.TestEvidence)
	if err := h.transitionJob(jobstore.WithTenantID(r.Context(), tenantID), job, job.Status); err != nil {
		writeTransitionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func ensureAutomationRebuilds(report *canonical.VerificationReport) []canonical.AutomationRebuildItem {
	if report == nil {
		return nil
	}
	if len(report.AutomationRebuilds) > 0 {
		normalizeAutomationRebuilds(report.AutomationRebuilds)
		return report.AutomationRebuilds
	}
	limit := len(report.AutomationsUnsupported)
	report.AutomationRebuilds = make([]canonical.AutomationRebuildItem, 0, limit)
	for i := 0; i < limit; i++ {
		auto := report.AutomationsUnsupported[i]
		report.AutomationRebuilds = append(report.AutomationRebuilds, canonical.AutomationRebuildItem{
			Rank:   i + 1,
			Name:   defaulted(auto.Name, fmt.Sprintf("Automation %d", i+1)),
			Status: "not_started",
			Notes:  auto.Reason,
		})
	}
	return report.AutomationRebuilds
}

func updateAutomationRebuild(report *canonical.VerificationReport, in canonical.AutomationRebuildItem) (canonical.AutomationRebuildItem, error) {
	if report == nil {
		return canonical.AutomationRebuildItem{}, fmt.Errorf("verification report is not ready yet")
	}
	if in.Rank < 1 || in.Rank > 10000 {
		return canonical.AutomationRebuildItem{}, fmt.Errorf("rank must be between 1 and 10000")
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "not_started"
	}
	if !oneOf(status, "not_started", "rebuilding", "test_passed", "approved_not_needed", "blocked") {
		return canonical.AutomationRebuildItem{}, fmt.Errorf("unsupported automation rebuild status")
	}
	if automationRebuildPassStatuses[status] && strings.TrimSpace(in.TestEvidence) == "" {
		return canonical.AutomationRebuildItem{}, fmt.Errorf("automation rebuild pass or waiver requires test_evidence")
	}
	rebuilds := ensureAutomationRebuilds(report)
	now := time.Now().UTC()
	for i := range rebuilds {
		if rebuilds[i].Rank == in.Rank {
			if in.Name != "" {
				rebuilds[i].Name = in.Name
			}
			if in.SourceID != "" {
				rebuilds[i].SourceID = in.SourceID
			}
			rebuilds[i].Status = status
			rebuilds[i].Owner = in.Owner
			rebuilds[i].Notes = in.Notes
			rebuilds[i].TestEvidence = in.TestEvidence
			rebuilds[i].UpdatedAt = &now
			report.AutomationRebuilds = rebuilds
			return rebuilds[i], nil
		}
	}
	if in.Name == "" {
		return canonical.AutomationRebuildItem{}, fmt.Errorf("name is required for a new automation rebuild item")
	}
	in.Status = status
	in.UpdatedAt = &now
	report.AutomationRebuilds = append(rebuilds, in)
	normalizeAutomationRebuilds(report.AutomationRebuilds)
	return in, nil
}

func normalizeAutomationRebuilds(items []canonical.AutomationRebuildItem) {
	for i := range items {
		if items[i].Rank == 0 {
			items[i].Rank = i + 1
		}
		items[i].Status = defaulted(items[i].Status, "not_started")
	}
}

func automationRebuildsPassed(report *canonical.VerificationReport) bool {
	rebuilds := ensureAutomationRebuilds(report)
	if len(rebuilds) == 0 {
		return len(report.AutomationsUnsupported) == 0
	}
	for _, item := range rebuilds {
		if !automationRebuildItemPassed(item) {
			return false
		}
	}
	return true
}

func automationRebuildItemPassed(item canonical.AutomationRebuildItem) bool {
	return automationRebuildPassStatuses[item.Status] && strings.TrimSpace(item.TestEvidence) != ""
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
