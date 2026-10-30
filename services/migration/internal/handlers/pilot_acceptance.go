package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

type PilotAcceptanceReport struct {
	JobID       string                   `json:"job_id"`
	Source      canonical.SourcePlatform `json:"source"`
	GeneratedAt time.Time                `json:"generated_at"`
	Status      string                   `json:"status"` // pass|warning|blocker
	Blockers    int                      `json:"blockers"`
	Warnings    int                      `json:"warnings"`
	Items       []PilotAcceptanceItem    `json:"items"`
}

type PilotAcceptanceItem struct {
	Key      string   `json:"key"`
	Label    string   `json:"label"`
	Status   string   `json:"status"` // pass|warning|blocker
	Expected int      `json:"expected,omitempty"`
	Actual   int      `json:"actual,omitempty"`
	Detail   string   `json:"detail,omitempty"`
	Evidence []string `json:"evidence,omitempty"`
}

const (
	activeCampaignConsentExclusionReviewKey  = "activecampaign_consent_exclusion_review"
	activeCampaignCampaignFidelityReviewKey  = "activecampaign_campaign_archive_fidelity_review"
	activeCampaignDeliverabilityReviewKey    = "activecampaign_deliverability_review"
	activeCampaignMinimumSourceEventOverlap  = 7 * 24 * time.Hour
	activeCampaignSourceEventGapGrace        = 60 * time.Second
	beehiivWebsiteCaptureReviewKey           = "beehiiv_website_capture_rebuild_review"
	beehiivBoostsRecommendationsReviewKey    = "beehiiv_boosts_recommendations_rebuild_review"
	beehiivAdNetworkReviewKey                = "beehiiv_ad_network_review"
	beehiivAutomationRetirementReviewKey     = "beehiiv_automation_retirement_review"
	klaviyoConsentSuppressionReviewKey       = "klaviyo_consent_suppression_review"
	klaviyoAudienceSnapshotReviewKey         = "klaviyo_audience_snapshot_review"
	klaviyoFlowRebuildReviewKey              = "klaviyo_flow_rebuild_review"
	klaviyoChannelIdentityReviewKey          = "klaviyo_channel_identity_review"
	klaviyoDeliverabilityReviewKey           = "klaviyo_deliverability_review"
	klaviyoEcosystemDependenciesReviewKey    = "klaviyo_ecosystem_dependencies_review"
	customerIOConsentSubscriptionReviewKey   = "customerio_consent_subscription_review"
	customerIOIdentityAudienceReviewKey      = "customerio_identity_audience_review"
	customerIOAutomationRebuildReviewKey     = "customerio_automation_rebuild_review"
	customerIOChannelDependencyReviewKey     = "customerio_channel_dependency_review"
	customerIODeliverabilityReviewKey        = "customerio_deliverability_review"
	customerIOEcosystemDependenciesReviewKey = "customerio_ecosystem_dependencies_review"
	hubSpotCRMBridgeScopeReviewKey           = "hubspot_crm_bridge_scope_review"
)

const (
	maxCutoverEvidenceDetailChars = 1000
	maxCutoverEvidenceItemChars   = 500
)

var (
	cutoverActiveCampaignAPIURLPattern   = regexp.MustCompile(`(?i)https?://[^\s"'<>]*(?:api-[a-z0-9-]+\.com|activehosted\.com)(?:/[^\s"'<>]*)?`)
	cutoverActiveCampaignBareHostPattern = regexp.MustCompile(`(?i)(^|[\s"'(<={:\[])((?:[a-z0-9-]+\.)+(?:api-[a-z0-9-]+\.com|activehosted\.com)(?:/[^\s"'<>]*)?)`)
	cutoverTokenLikePattern              = regexp.MustCompile(`(?i)\b(authorization|api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?secret|password)\s*[:=]\s*["']?(?:(?:bearer|basic)\s+)?[^"',\s}]+`)
	cutoverBasicAuthURLPattern           = regexp.MustCompile(`(?i)(https?://)[^/@\s]+@`)
	cutoverSourceEventIDPattern          = regexp.MustCompile(`(?i)\bactivecampaign:contact:[^\s"',;)}\]]+`)
	cutoverHubSpotSourceEventIDPattern   = regexp.MustCompile(`(?i)\bhubspot:contact:[^\s"',;)}\]]+`)
	cutoverSourceEventCursorIDPattern    = regexp.MustCompile(`(?i)(\blast_id=)[^&\s"',;)}\]]+`)
	cutoverSourceEventContactPattern     = regexp.MustCompile(`(?i)(\bcontact\s+)(?:[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}|[a-z0-9:_\-]+)(\s+(?:missing|source-event|order|failed|replay)|[.;,:)]|$)`)
)

const (
	activeCampaignPostPilotCleanupEvidenceKey  = "activecampaign_post_pilot_cleanup"
	activeCampaignPostPilotCleanupStartedAtKey = "activecampaign_post_pilot_cleanup_started_at"
	hubSpotPostPilotCleanupEvidenceKey         = "hubspot_post_pilot_cleanup"
	hubSpotPostPilotCleanupStartedAtKey        = "hubspot_post_pilot_cleanup_started_at"
	hubSpotPostPilotSessionClearedAtKey        = "hubspot_post_pilot_source_session_cleared_at"
)

var errActiveCampaignPostPilotCleanupFrozen = errors.New("post-pilot cleanup authorization freezes acceptance evidence")

func postPilotCleanupEvidence(job *canonical.MigrationJob) (string, time.Time, bool, error) {
	if job == nil {
		return "", time.Time{}, false, nil
	}
	switch job.Source {
	case canonical.SourceActiveCampaign:
		status, reviewedAt, _, _, ok, err := activeCampaignCutoverEvidence(job, activeCampaignPostPilotCleanupEvidenceKey)
		return status, reviewedAt, ok, err
	case canonical.SourceHubSpot:
		status, reviewedAt, _, _, ok, err := hubSpotCutoverEvidence(job, hubSpotPostPilotCleanupEvidenceKey)
		return status, reviewedAt, ok, err
	default:
		return "", time.Time{}, false, nil
	}
}

func postPilotCleanupAuthorized(job *canonical.MigrationJob) bool {
	if job == nil || job.CompletedAt == nil {
		return false
	}
	status, reviewedAt, ok, err := postPilotCleanupEvidence(job)
	_, hasOverlap := cursorString(job.Cursor, sourceEventOverlapSnapshotKey)
	return err == nil && ok && status == "pass" && hasOverlap &&
		isDeltaImportRun(job) && !latestDeltaImportFailed(job) &&
		!reviewedAt.Before(job.CompletedAt.UTC())
}

func postPilotCleanupStartedAtKey(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceActiveCampaign:
		return activeCampaignPostPilotCleanupStartedAtKey
	case canonical.SourceHubSpot:
		return hubSpotPostPilotCleanupStartedAtKey
	default:
		return ""
	}
}

func postPilotCleanupStarted(job *canonical.MigrationJob) bool {
	if job == nil {
		return false
	}
	key := postPilotCleanupStartedAtKey(job.Source)
	if key == "" {
		return false
	}
	_, ok := cursorString(job.Cursor, key)
	return ok
}

func markPostPilotCleanupStarted(job *canonical.MigrationJob, now time.Time) bool {
	if !postPilotCleanupAuthorized(job) || postPilotCleanupStarted(job) {
		return false
	}
	key := postPilotCleanupStartedAtKey(job.Source)
	if key == "" {
		return false
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	startedAt := now.UTC().Format(time.RFC3339Nano)
	job.Cursor[key] = &startedAt
	return true
}

func postPilotCleanupFreezeError(job *canonical.MigrationJob, operation string) error {
	if !postPilotCleanupAuthorized(job) {
		return nil
	}
	return fmt.Errorf("%w; %s %s is frozen until the cleanup marker is revoked before cleanup starts",
		errActiveCampaignPostPilotCleanupFrozen,
		pilotSourceDisplayName(job.Source),
		operation,
	)
}

func (h *Migration) clearHubSpotPostPilotSourceSession(ctx context.Context, job *canonical.MigrationJob, now time.Time) error {
	if h == nil || job == nil || job.Source != canonical.SourceHubSpot || !postPilotCleanupStarted(job) {
		return fmt.Errorf("HubSpot source-session cleanup requires a durably started post-pilot cleanup")
	}
	err := h.store.DeleteSession(ctx, job.TenantID, job.ID)
	if err != nil && !errors.Is(err, jobstore.ErrNotFound) {
		return fmt.Errorf("clear HubSpot migration source session: %w", err)
	}
	if _, ok := cursorString(job.Cursor, hubSpotPostPilotSessionClearedAtKey); ok {
		return nil
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	clearedAt := now.UTC().Format(time.RFC3339Nano)
	job.Cursor[hubSpotPostPilotSessionClearedAtKey] = &clearedAt
	if err := h.transitionJob(ctx, job, job.Status); err != nil {
		return fmt.Errorf("persist HubSpot source-session cleanup: %w", err)
	}
	return nil
}

func activeCampaignPostPilotCleanupAuthorized(job *canonical.MigrationJob) bool {
	return job != nil && job.Source == canonical.SourceActiveCampaign && postPilotCleanupAuthorized(job)
}

func activeCampaignPostPilotCleanupStarted(job *canonical.MigrationJob) bool {
	return job != nil && job.Source == canonical.SourceActiveCampaign && postPilotCleanupStarted(job)
}

func markActiveCampaignPostPilotCleanupStarted(job *canonical.MigrationJob, now time.Time) bool {
	return job != nil && job.Source == canonical.SourceActiveCampaign && markPostPilotCleanupStarted(job, now)
}

func activeCampaignPostPilotCleanupFreezeError(job *canonical.MigrationJob, operation string) error {
	return postPilotCleanupFreezeError(job, operation)
}

var activeCampaignCutoverEvidenceKeys = map[string]bool{
	"activecampaign_automation_rebuild_review": true,
	"activecampaign_segments_review":           true,
	"activecampaign_templates_review":          true,
	"activecampaign_forms_review":              true,
	"activecampaign_custom_objects_review":     true,
	"activecampaign_ecommerce_review":          true,
	"activecampaign_crm_archive_review":        true,
	"activecampaign_audience_schema_review":    true,
	activeCampaignCampaignFidelityReviewKey:    true,
	"source_discovery_warnings":                true,
	"source_archive_warnings":                  true,
	"sms_readiness":                            true,
	activeCampaignConsentExclusionReviewKey:    true,
	activeCampaignDeliverabilityReviewKey:      true,
	activeCampaignPostPilotCleanupEvidenceKey:  true,
}

var activeCampaignEvidenceClearsBlockers = map[string]bool{
	"activecampaign_segments_review":        true,
	"activecampaign_templates_review":       true,
	"activecampaign_forms_review":           true,
	"activecampaign_custom_objects_review":  true,
	"activecampaign_ecommerce_review":       true,
	"activecampaign_crm_archive_review":     true,
	"activecampaign_audience_schema_review": true,
	activeCampaignCampaignFidelityReviewKey: true,
	"source_discovery_warnings":             true,
	"source_archive_warnings":               true,
	"sms_readiness":                         true,
	activeCampaignConsentExclusionReviewKey: true,
}

var beehiivCutoverEvidenceKeys = map[string]bool{
	"beehiiv_consent_reconciliation":      true,
	"beehiiv_segment_rules_review":        true,
	"beehiiv_campaign_archive_fidelity":   true,
	beehiivAutomationRetirementReviewKey:  true,
	beehiivWebsiteCaptureReviewKey:        true,
	beehiivBoostsRecommendationsReviewKey: true,
	beehiivAdNetworkReviewKey:             true,
	"source_discovery_warnings":           true,
	"source_archive_warnings":             true,
}

var klaviyoCutoverEvidenceKeys = map[string]bool{
	klaviyoConsentSuppressionReviewKey:    true,
	klaviyoAudienceSnapshotReviewKey:      true,
	klaviyoFlowRebuildReviewKey:           true,
	klaviyoChannelIdentityReviewKey:       true,
	klaviyoDeliverabilityReviewKey:        true,
	klaviyoEcosystemDependenciesReviewKey: true,
	"source_discovery_warnings":           true,
	"source_archive_warnings":             true,
}

var customerIOCutoverEvidenceKeys = map[string]bool{
	customerIOConsentSubscriptionReviewKey:   true,
	customerIOIdentityAudienceReviewKey:      true,
	customerIOAutomationRebuildReviewKey:     true,
	customerIOChannelDependencyReviewKey:     true,
	customerIODeliverabilityReviewKey:        true,
	customerIOEcosystemDependenciesReviewKey: true,
	"source_discovery_warnings":              true,
	"source_archive_warnings":                true,
}

var hubSpotCutoverEvidenceKeys = map[string]bool{
	hubSpotCRMBridgeScopeReviewKey:     true,
	hubSpotPostPilotCleanupEvidenceKey: true,
}

type cutoverEvidenceRequest struct {
	Key      string   `json:"key"`
	Status   string   `json:"status"`
	Detail   string   `json:"detail"`
	Evidence []string `json:"evidence"`
}

func (h *Migration) GetPilotAcceptance(w http.ResponseWriter, r *http.Request) {
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
	report := BuildPilotAcceptanceReport(job)
	h.addPersistentCutoverEvidence(r.Context(), tenantID, job, &report)
	h.revalidateRollbackRehearsalAcceptance(r.Context(), job, &report)
	writeJSON(w, http.StatusOK, report)
}

// revalidateRollbackRehearsalAcceptance keeps a previously passing rehearsal
// from becoming stale between its persisted point-in-time proof and pilot
// acceptance. The caller holds the tenant/job execution lease, and this check
// deliberately does not update the job cursor: pilot acceptance remains a
// read while sharing the exact conflict preflight used by real rollback.
func (h *Migration) revalidateRollbackRehearsalAcceptance(ctx context.Context, job *canonical.MigrationJob, report *PilotAcceptanceReport) {
	if job == nil || report == nil || !strictRollbackRehearsalSource(job.Source) {
		return
	}
	itemIndex := -1
	for i := range report.Items {
		if report.Items[i].Key == "rollback_rehearsal" && report.Items[i].Status == "pass" {
			itemIndex = i
			break
		}
	}
	if itemIndex < 0 {
		return
	}

	current := h.buildRollbackRehearsalReport(ctx, job, time.Now().UTC())
	if current.Status == "pass" && current.destinationStateValidated {
		return
	}

	detail := "Current destination ownership and tracked after-images could not be conflict-checked before pilot acceptance."
	for _, currentItem := range current.Items {
		if currentItem.Status != "blocker" {
			continue
		}
		detail = currentItem.Detail
		if currentItem.Key == "destination_preflight" {
			break
		}
	}
	item := &report.Items[itemIndex]
	item.Status = "blocker"
	item.Expected = current.TotalResources
	item.Actual = 0
	item.Detail = "The previously recorded rollback rehearsal is stale or no longer matches current destination state: " + detail
	item.Evidence = append(item.Evidence,
		"current_recheck_status="+current.Status,
		"current_recheck_generated_at="+current.GeneratedAt.UTC().Format(time.RFC3339Nano),
	)
	if current.CountSource != "" {
		item.Evidence = append(item.Evidence, "current_recheck_count_source="+current.CountSource)
	}
	report.recount()
}

func (h *Migration) UpdateCutoverEvidence(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	var in cutoverEvidenceRequest
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
	if err := h.persistCutoverEvidence(jobstore.WithTenantID(r.Context(), tenantID), job, in); err != nil {
		if errors.Is(err, jobstore.ErrStatusTransitionConflict) {
			writeTransitionErr(w, err)
		} else if errors.Is(err, errActiveCampaignPostPilotCleanupFrozen) {
			writeErr(w, http.StatusConflict, err)
		} else {
			writeErr(w, http.StatusBadRequest, err)
		}
		return
	}
	report := BuildPilotAcceptanceReport(job)
	h.addPersistentCutoverEvidence(r.Context(), tenantID, job, &report)
	h.revalidateRollbackRehearsalAcceptance(r.Context(), job, &report)
	writeJSON(w, http.StatusOK, report)
}

func BuildPilotAcceptanceReport(job *canonical.MigrationJob) PilotAcceptanceReport {
	out := PilotAcceptanceReport{
		GeneratedAt: time.Now().UTC(),
		Status:      "pass",
	}
	if job == nil {
		out.Status = "blocker"
		out.Blockers = 1
		out.Items = append(out.Items, PilotAcceptanceItem{
			Key:    "job",
			Label:  "Migration job",
			Status: "blocker",
			Detail: "Migration job was not found.",
		})
		return out
	}
	out.JobID = job.ID
	out.Source = job.Source
	report := pilotAcceptanceVerificationReport(job)
	if report == nil {
		out.add(PilotAcceptanceItem{
			Key:    "verification_report",
			Label:  "Verification report",
			Status: "blocker",
			Detail: "Run a dry run or import before accepting the pilot.",
		})
		out.finish()
		return out
	}
	out.add(PilotAcceptanceItem{
		Key:    "verification_report",
		Label:  "Verification report",
		Status: "pass",
		Detail: "Migration produced a resource-level audit report.",
	})
	out.add(discoveryWarningAcceptanceItem(job, report))
	out.add(sourceArchiveWarningAcceptanceItem(job, report))
	out.add(contactAcceptanceItem(report))
	out.add(PilotAcceptanceItem{
		Key:    "suppressions",
		Label:  "Suppression preservation",
		Status: "pass",
		Actual: report.SuppressionListSize,
		Detail: "Imported suppressions are recorded in the verification report; source APIs may not expose every suppression subtype.",
	})
	if job.Source != canonical.SourceActiveCampaign && job.Source != canonical.SourceHubSpot && job.Source != canonical.SourceKlaviyo && job.Source != canonical.SourceCustomerIO {
		out.add(consentAcceptanceItem(job, report))
	}
	out.add(resourceAcceptanceItem(report, "groups", "Lists, tags, and audience groups"))
	if job.Source == canonical.SourceBeehiiv {
		out.add(beehiivSegmentAcceptanceItem(job, report))
		out.add(beehiivPreservedCoverageAcceptanceItem(report, "segment_definitions", "Beehiiv segment-definition archive"))
		out.add(beehiivPreservedCoverageAcceptanceItem(report, "condition_set_archive", "Beehiiv dynamic-content condition-set archive"))
		out.add(beehiivPreservedCoverageAcceptanceItem(report, "custom_field_schema", "Beehiiv custom-field schema archive"))
		out.add(beehiivPreservedCoverageAcceptanceItem(report, "newsletter_list_definitions", "Beehiiv newsletter-list definition archive"))
		out.add(beehiivPreservedCoverageAcceptanceItem(report, "newsletter_list_history", "Beehiiv newsletter-list history archive"))
		out.add(beehiivPreservedCoverageAcceptanceItem(report, "automations", "Beehiiv automation-definition archive"))
		out.add(beehiivPreservedCoverageAcceptanceItem(report, "automation_email_inventory", "Beehiiv automation email-inventory archive"))
		out.add(beehiivPreservedCoverageAcceptanceItem(report, "automation_journey_inventory", "Beehiiv automation journey-inventory archive"))
	}
	out.add(resourceAcceptanceItem(report, "campaigns", "Campaign archive"))
	if job.Source == canonical.SourceBeehiiv {
		out.add(beehiivCampaignFidelityAcceptanceItem(job, report))
	}
	out.add(automationAcceptanceItem(report))
	if job.Source == canonical.SourceBeehiiv {
		out.add(beehiivAutomationRetirementAcceptanceItem(job, report))
	}
	if job.Source == canonical.SourceMailchimp {
		for _, item := range mailchimpCutoverAcceptanceItems(report) {
			out.add(item)
		}
	}
	if job.Source == canonical.SourceActiveCampaign {
		for _, item := range activeCampaignCutoverAcceptanceItems(job, report) {
			out.add(item)
		}
		out.add(activeCampaignFinalDeltaAcceptanceItem(job))
	}
	if job.Source == canonical.SourceHubSpot {
		out.add(hubSpotCommunicationPreferenceAcceptanceItem(report))
		out.add(hubSpotCRMBridgeScopeReviewAcceptanceItem(job, report))
		out.add(sourceBridgeFinalDeltaAcceptanceItem(job))
	}
	if job.Source == canonical.SourceBeehiiv {
		out.add(sourceBridgeFinalDeltaAcceptanceItem(job))
		for _, item := range beehiivParityGapAcceptanceItems(job, report) {
			out.add(item)
		}
	}
	if job.Source == canonical.SourceKlaviyo {
		out.add(sourceBridgeFinalDeltaAcceptanceItem(job))
		for _, item := range klaviyoCutoverAcceptanceItems(job, report) {
			out.add(item)
		}
	}
	if job.Source == canonical.SourceCustomerIO {
		out.add(sourceBridgeFinalDeltaAcceptanceItem(job))
		for _, item := range customerIOCutoverAcceptanceItems(job, report) {
			out.add(item)
		}
	}
	for _, item := range unsupportedResourceAcceptanceItems(job.Source, report) {
		out.add(item)
	}
	if job.Source != canonical.SourceHubSpot {
		out.add(smsAcceptanceItem(job, report))
	}
	out.add(rollbackRehearsalAcceptanceItem(job))
	out.finish()
	return out
}

func pilotAcceptanceVerificationReport(job *canonical.MigrationJob) *canonical.VerificationReport {
	if job == nil || job.VerificationReport == nil {
		return nil
	}
	if !migrationSensitiveSource(job.Source) {
		return job.VerificationReport
	}
	report := cloneVerificationReportForPilotAcceptance(job.VerificationReport)
	jobCopy := &canonical.MigrationJob{
		Source:             job.Source,
		VerificationReport: report,
	}
	sanitizeMigrationJobEvidence(jobCopy)
	return report
}

func cloneVerificationReportForPilotAcceptance(report *canonical.VerificationReport) *canonical.VerificationReport {
	if report == nil {
		return nil
	}
	cp := *report
	cp.DiscoveryWarnings = append([]string(nil), report.DiscoveryWarnings...)
	cp.SegmentsWithWarnings = append([]canonical.SegmentWarning(nil), report.SegmentsWithWarnings...)
	cp.AutomationsUnsupported = append([]canonical.AutomationUnsupported(nil), report.AutomationsUnsupported...)
	cp.AutomationRebuilds = append([]canonical.AutomationRebuildItem(nil), report.AutomationRebuilds...)
	cp.CampaignArchiveWarnings = append([]canonical.ResourceWarning(nil), report.CampaignArchiveWarnings...)
	cp.TemplateWarnings = append([]canonical.ResourceWarning(nil), report.TemplateWarnings...)
	cp.SourceArchiveWarnings = append([]canonical.ResourceWarning(nil), report.SourceArchiveWarnings...)
	cp.ResourceCompleteness = append([]canonical.ResourceCompleteness(nil), report.ResourceCompleteness...)
	for i := range cp.ResourceCompleteness {
		cp.ResourceCompleteness[i].Notes = append([]string(nil), report.ResourceCompleteness[i].Notes...)
	}
	return &cp
}

func (h *Migration) addPersistentCutoverEvidence(ctx context.Context, tenantID string, job *canonical.MigrationJob, report *PilotAcceptanceReport) {
	if job == nil || report == nil {
		return
	}
	switch job.Source {
	case canonical.SourceActiveCampaign:
		shadow, shadowErr, supported := h.latestShadowCheck(ctx, tenantID, job.ID)
		report.add(activeCampaignShadowCheckAcceptanceItem(job, shadow, shadowErr, supported))
		sourceEvents, sourceEventRows, sourceEventErr, sourceEventSupported := h.latestSourceEventReplay(ctx, tenantID, job.ID)
		report.add(activeCampaignSourceEventReplayAcceptanceItem(job, sourceEvents, sourceEventRows, sourceEventErr, sourceEventSupported))
	case canonical.SourceHubSpot:
		shadow, shadowErr, supported := h.latestShadowCheck(ctx, tenantID, job.ID)
		report.add(sourceBridgeShadowCheckAcceptanceItem(job, shadow, shadowErr, supported))
		sourceEvents, sourceEventRows, sourceEventErr, sourceEventSupported := h.latestSourceEventReplay(ctx, tenantID, job.ID)
		report.add(sourceBridgeSourceEventReplayAcceptanceItem(job, sourceEvents, sourceEventRows, sourceEventErr, sourceEventSupported))
	case canonical.SourceBeehiiv:
		shadow, shadowErr, supported := h.latestShadowCheck(ctx, tenantID, job.ID)
		report.add(sourceBridgeShadowCheckAcceptanceItem(job, shadow, shadowErr, supported))
	case canonical.SourceKlaviyo:
		shadow, shadowErr, supported := h.latestShadowCheck(ctx, tenantID, job.ID)
		report.add(sourceBridgeShadowCheckAcceptanceItem(job, shadow, shadowErr, supported))
		sourceEvents, sourceEventRows, sourceEventErr, sourceEventSupported := h.latestSourceEventReplay(ctx, tenantID, job.ID)
		report.add(sourceBridgeSourceEventReplayAcceptanceItem(job, sourceEvents, sourceEventRows, sourceEventErr, sourceEventSupported))
	case canonical.SourceCustomerIO:
		shadow, shadowErr, supported := h.latestShadowCheck(ctx, tenantID, job.ID)
		report.add(sourceBridgeShadowCheckAcceptanceItem(job, shadow, shadowErr, supported))
	default:
		return
	}
	report.finish()
}

func (h *Migration) latestShadowCheck(ctx context.Context, tenantID, jobID string) (*shadowCheckResponse, error, bool) {
	if _, ok := h.store.(jobstore.ShadowMonitorStore); !ok {
		return nil, nil, false
	}
	// Read enough immutable rows to prioritize the job's durable current attempt
	// token before falling back to provider observation time. Each attempt writes
	// a start sentinel and a final row, so the bounded history covers in-flight
	// persistence races without trusting replica clocks.
	history, err := h.shadowHistory(ctx, tenantID, jobID, 50)
	if err != nil {
		return nil, err, true
	}
	if len(history) == 0 {
		return nil, nil, true
	}
	return &history[0], nil, true
}

func (h *Migration) latestSourceEventReplay(ctx context.Context, tenantID, jobID string) (*jobstore.SourceEventMonitorRecord, []jobstore.SourceEventRecord, error, bool) {
	store, ok := h.store.(jobstore.SourceEventMonitorStore)
	if !ok {
		return nil, nil, nil, false
	}
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(ctx, tenantID), tenantID, jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		return nil, nil, nil, true
	}
	if err != nil {
		return nil, nil, err, true
	}
	events, err := store.ListSourceEventResults(jobstore.WithTenantID(ctx, tenantID), tenantID, jobID, 20)
	if err != nil {
		return &monitor, nil, err, true
	}
	failed, err := store.ListFailedSourceEventResults(jobstore.WithTenantID(ctx, tenantID), tenantID, jobID, 20)
	if err != nil {
		return &monitor, events, err, true
	}
	events = mergeSourceEventReplayEvidenceRows(events, failed)
	reviewed, err := store.ListReviewedSourceEventResults(jobstore.WithTenantID(ctx, tenantID), tenantID, jobID, 100)
	if err != nil {
		return &monitor, events, err, true
	}
	return &monitor, mergeSourceEventReplayEvidenceRows(reviewed, events), nil, true
}

func mergeSourceEventReplayEvidenceRows(recent, failed []jobstore.SourceEventRecord) []jobstore.SourceEventRecord {
	out := make([]jobstore.SourceEventRecord, 0, len(failed)+len(recent))
	seen := map[string]struct{}{}
	add := func(rec jobstore.SourceEventRecord) {
		key := strings.TrimSpace(rec.SourceEventID)
		if key == "" {
			key = strings.TrimSpace(rec.ID)
		}
		if key != "" {
			if _, ok := seen[key]; ok {
				return
			}
			seen[key] = struct{}{}
		}
		out = append(out, rec)
	}
	for _, rec := range failed {
		add(rec)
	}
	for _, rec := range recent {
		add(rec)
	}
	return out
}

func mailchimpCutoverAcceptanceItems(report *canonical.VerificationReport) []PilotAcceptanceItem {
	items := []PilotAcceptanceItem{}

	mergeStatus := "pass"
	mergeDetail := "No overlapping Mailchimp audience subscribers were detected."
	if report.DuplicateSubscribersMerged > 0 {
		mergeStatus = "warning"
		mergeDetail = "Overlapping Mailchimp audience subscribers were merged. Review preserved source IDs and conflicting fields before cutover."
	}
	items = append(items, PilotAcceptanceItem{
		Key:      "mailchimp_audience_merges",
		Label:    "Mailchimp audience overlap",
		Status:   mergeStatus,
		Actual:   report.DuplicateSubscribersMerged,
		Detail:   mergeDetail,
		Evidence: subscriberMergeEvidence(report),
	})

	segmentStatus := "pass"
	segmentDetail := "Mailchimp saved/static segments are represented for targeting; spot-check key segments before activating sends."
	if row, ok := resourceByName(report, "segments"); ok && (row.Status == "partial" || row.SourceTotal > row.Imported) {
		segmentStatus = "blocker"
		segmentDetail = "Some Mailchimp segments were not fully translated. Fix or explicitly rebuild before cutover."
	}
	if len(report.SegmentsWithWarnings) > 0 {
		segmentStatus = "blocker"
		segmentDetail = "Mailchimp segment warnings remain. Fix targeting or document a manual rebuild before cutover."
	}
	items = append(items, PilotAcceptanceItem{
		Key:      "mailchimp_segment_spot_checks",
		Label:    "Mailchimp segment spot checks",
		Status:   segmentStatus,
		Expected: len(report.SegmentsWithWarnings),
		Actual:   0,
		Detail:   segmentDetail,
		Evidence: segmentWarningEvidence(report),
	})

	templateStatus := "pass"
	templateDetail := "Imported templates have no adapter-reported fidelity warnings. Render previews before live activation."
	if len(report.TemplateWarnings) > 0 {
		templateStatus = "blocker"
		templateDetail = "Some Mailchimp templates imported with partial fidelity. Render/fix them before live sends."
	}
	items = append(items, PilotAcceptanceItem{
		Key:      "mailchimp_template_render_review",
		Label:    "Mailchimp template render review",
		Status:   templateStatus,
		Expected: len(report.TemplateWarnings),
		Actual:   0,
		Detail:   templateDetail,
		Evidence: resourceWarningEvidence(report.TemplateWarnings),
	})

	archiveStatus := "pass"
	archiveDetail := "Campaign archive reports imported without adapter-reported partial-detail warnings."
	if len(report.CampaignArchiveWarnings) > 0 {
		archiveStatus = "warning"
		archiveDetail = "Some sent-campaign report details could not be enriched. Archive history is usable but partial."
	}
	items = append(items, PilotAcceptanceItem{
		Key:      "mailchimp_campaign_report_fidelity",
		Label:    "Mailchimp campaign report fidelity",
		Status:   archiveStatus,
		Expected: len(report.CampaignArchiveWarnings),
		Actual:   0,
		Detail:   archiveDetail,
		Evidence: resourceWarningEvidence(report.CampaignArchiveWarnings),
	})

	liveSurfaces := mailchimpLiveSurfaceCount(report)
	liveStatus := "pass"
	liveDetail := "No imported Mailchimp automations/forms/landing/commerce surfaces were detected."
	if liveSurfaces > 0 {
		liveStatus = "warning"
		liveDetail = "Supported Mailchimp Classic Automations land paused, while forms, landing pages, and commerce integrations land draft/disabled. The adapter cannot inventory Customer Journeys; review a manual Mailchimp Journey rebuild/waiver checklist before publishing or activating anything."
	}
	items = append(items, PilotAcceptanceItem{
		Key:    "mailchimp_paused_surface_review",
		Label:  "Mailchimp paused surface review",
		Status: liveStatus,
		Actual: liveSurfaces,
		Detail: liveDetail,
	})

	items = append(items, PilotAcceptanceItem{
		Key:    "mailchimp_deliverability_review",
		Label:  "Mailchimp deliverability review",
		Status: "warning",
		Detail: "Verify sending domains, branded links, DNS, warmup, and suppression policies in Moosewave before moving live traffic.",
	})

	return items
}

func activeCampaignCutoverAcceptanceItems(job *canonical.MigrationJob, report *canonical.VerificationReport) []PilotAcceptanceItem {
	items := []PilotAcceptanceItem{}
	if item, ok := activeCampaignSegmentReviewItem(job, report); ok {
		items = append(items, item)
	}
	if item, ok := activeCampaignAutomationReviewItem(job, report); ok {
		items = append(items, item)
	}
	for _, resource := range []string{"templates", "forms", "custom_objects", "ecommerce", "audience_schema"} {
		row, ok := resourceByName(report, resource)
		if !ok || row.SourceTotal == 0 {
			continue
		}
		status := "warning"
		detail := "Source records were preserved for rebuild/review. Confirm this surface is rebuilt or explicitly out of cutover scope before moving live traffic."
		if row.Imported == 0 {
			status = "blocker"
			detail = "Source records were detected but no rebuild evidence was preserved. Re-run after fixing source archive access or explicitly export this surface before cutover."
		} else if row.Imported < row.SourceTotal {
			status = "blocker"
			detail = "Only some source records were preserved for rebuild/review. Re-run after fixing source archive access or explicitly export/sign off the missing records before cutover."
		}
		item := PilotAcceptanceItem{
			Key:      "activecampaign_" + resource + "_review",
			Label:    "ActiveCampaign " + row.Label,
			Status:   status,
			Expected: row.SourceTotal,
			Actual:   row.Imported,
			Detail:   detail,
			Evidence: row.Notes,
		}
		items = append(items, applyActiveCampaignCutoverEvidence(job, item))
	}
	if row, ok := resourceByName(report, "crm"); ok && row.SourceTotal > 0 {
		status := "warning"
		detail := "ActiveCampaign CRM records were preserved as read-only context. Confirm HubSpot or another CRM remains the system of record, or explicitly sign off that CRM is out of email/SMS cutover scope."
		if row.Imported == 0 {
			status = "blocker"
			detail = "ActiveCampaign CRM records were detected but no CRM archive evidence was preserved. Fix source archive access or explicitly export/sign off CRM before email/SMS cutover."
		} else if row.Imported < row.SourceTotal {
			status = "blocker"
			detail = "Some ActiveCampaign CRM records were not preserved. Fix source archive access, export/sign off the missing CRM records, or document the external CRM system of record before email/SMS cutover."
		}
		item := PilotAcceptanceItem{
			Key:      "activecampaign_crm_archive_review",
			Label:    "ActiveCampaign CRM archive",
			Status:   status,
			Expected: row.SourceTotal,
			Actual:   row.Imported,
			Detail:   detail,
			Evidence: row.Notes,
		}
		items = append(items, applyActiveCampaignCutoverEvidence(job, item))
	}
	if item, ok := activeCampaignCampaignFidelityAcceptanceItem(job, report); ok {
		items = append(items, item)
	}
	items = append(items, activeCampaignConsentExclusionAcceptanceItem(job, report))
	items = append(items, activeCampaignDeliverabilityAcceptanceItem(job))
	return items
}

func activeCampaignConsentExclusionAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	emailRow, hasEmailRow := resourceByName(report, "consent_exclusions")
	if !hasEmailRow {
		emailRow, hasEmailRow = resourceByName(report, "subscribers")
	}
	nonEmailRow, hasNonEmailRow := resourceByName(report, "non_email_contacts")
	if !hasEmailRow || !hasNonEmailRow {
		return applyActiveCampaignCutoverEvidence(job, PilotAcceptanceItem{
			Key:    activeCampaignConsentExclusionReviewKey,
			Label:  "ActiveCampaign consent, exclusion, and contact-identity review",
			Status: "blocker",
			Detail: "Contact-channel coverage is missing from this verification report. Re-run the migration before reviewing email exclusions, SMS consent, phone-only/email-less contacts, and source contacts removed or moved to a different email identity during the overlap window.",
		})
	}
	totalContacts := emailRow.SourceTotal + nonEmailRow.SourceTotal
	if totalContacts == 0 {
		return applyActiveCampaignCutoverEvidence(job, PilotAcceptanceItem{
			Key:    activeCampaignConsentExclusionReviewKey,
			Label:  "ActiveCampaign consent, exclusion, and contact-identity review",
			Status: "blocker",
			Detail: "No current ActiveCampaign contacts were detected. Confirm the account was intentionally empty and reconcile any contacts removed after the earlier import before clearing this review.",
			Evidence: []string{
				"Changed-contact polling cannot prove hard-deleted source contacts; compare a reviewed source export/audit against the destination.",
			},
		})
	}
	item := PilotAcceptanceItem{
		Key:      activeCampaignConsentExclusionReviewKey,
		Label:    "ActiveCampaign consent, exclusion, and contact-identity review",
		Status:   "blocker",
		Expected: totalContacts,
		Actual:   report.ConsentKnown,
		Detail:   "Reconcile email and SMS consent by channel, compare ActiveCampaign exclusions, and compare the final source-ID-to-email plus source-owned tag/list mappings with the destination before activation. List status or subscription date alone is not consent proof; keep unresolved contacts unconfirmed, disable destination identities whose source contact was removed or whose prior email became stale after a source email change, require exactly one current destination identity per source ID, and remove list-targeting tags affected by global or list-specific exclusions.",
		Evidence: []string{
			"ActiveCampaign API v3 does not expose a complete exclusion-list read contract.",
			"Changed-contact polling cannot prove hard-deleted source contacts; compare a reviewed source export/audit against the destination.",
			"A changed contact is replayed at its current email, but the import does not automatically retire a prior destination email for the same source ID; reconcile the source-ID-to-email mapping explicitly.",
			"Returned same-source contacts replace provider-owned tags, list-targeting tags, and custom fields while preserving local or different-source data; hard-deleted contacts still require reviewed reconciliation.",
			"Phone-only and email-less contacts are review evidence, not email-keyed subscribers.",
		},
	}
	return applyActiveCampaignCutoverEvidence(job, item)
}

func activeCampaignCampaignFidelityAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) (PilotAcceptanceItem, bool) {
	row, hasCampaigns := resourceByName(report, "campaigns")
	warnings := resourceWarningEvidence(report.CampaignArchiveWarnings)
	if (!hasCampaigns || row.SourceTotal == 0) && len(warnings) == 0 {
		return PilotAcceptanceItem{}, false
	}
	item := PilotAcceptanceItem{
		Key:      activeCampaignCampaignFidelityReviewKey,
		Label:    "ActiveCampaign campaign archive fidelity",
		Status:   "pass",
		Expected: row.SourceTotal,
		Actual:   row.Imported,
		Detail:   "Imported ActiveCampaign sent campaigns have no adapter-reported subject, content, send-time, or aggregate-metric fidelity warnings.",
		Evidence: row.Notes,
	}
	if len(warnings) > 0 {
		item.Status = "blocker"
		item.Detail = "One or more ActiveCampaign sent campaigns have partial archive fidelity. Fix and rerun the archive or record explicit post-delta review before accepting historical parity."
		item.Evidence = append(append([]string(nil), row.Notes...), warnings...)
	}
	return applyActiveCampaignCutoverEvidence(job, item), true
}

func activeCampaignSegmentReviewItem(job *canonical.MigrationJob, report *canonical.VerificationReport) (PilotAcceptanceItem, bool) {
	row, hasRow := resourceByName(report, "lists")
	warnings := segmentWarningEvidence(report)
	if (!hasRow || row.SourceTotal == 0) && len(warnings) == 0 {
		return PilotAcceptanceItem{}, false
	}
	expected := row.SourceTotal
	actual := row.Imported
	item := PilotAcceptanceItem{
		Key:      "activecampaign_segments_review",
		Label:    "ActiveCampaign list and saved segment review",
		Status:   "pass",
		Expected: expected,
		Actual:   actual,
		Detail:   "ActiveCampaign list-backed segments are executable and no saved-segment translation warnings remain.",
		Evidence: row.Notes,
	}
	if len(warnings) > 0 || (hasRow && row.SourceTotal > row.Imported) {
		item.Status = "blocker"
		item.Detail = "Some ActiveCampaign saved segments could not be translated into executable Moosewave targeting. Rebuild them or record explicit cutover sign-off before moving live traffic."
		item.Evidence = append(append([]string(nil), row.Notes...), warnings...)
	}
	return applyActiveCampaignCutoverEvidence(job, item), true
}

func (h *Migration) persistCutoverEvidence(ctx context.Context, job *canonical.MigrationJob, in cutoverEvidenceRequest) error {
	if job == nil {
		return fmt.Errorf("migration job was not found")
	}
	if job.Source == canonical.SourceBeehiiv {
		return h.persistBeehiivCutoverEvidence(ctx, job, in)
	}
	if job.Source == canonical.SourceKlaviyo {
		return h.persistKlaviyoCutoverEvidence(ctx, job, in)
	}
	if job.Source == canonical.SourceCustomerIO {
		return h.persistCustomerIOCutoverEvidence(ctx, job, in)
	}
	if job.Source == canonical.SourceHubSpot {
		return h.persistHubSpotCutoverEvidence(ctx, job, in)
	}
	if job.Source != canonical.SourceActiveCampaign {
		return fmt.Errorf("cutover evidence is only supported for ActiveCampaign, Beehiiv, HubSpot, Klaviyo, and Customer.io migrations")
	}
	key := strings.TrimSpace(in.Key)
	if !activeCampaignCutoverEvidenceKeys[key] {
		return fmt.Errorf("unsupported cutover evidence key")
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "pass"
	}
	if !oneOf(status, "pass", "warning", "blocker") {
		return fmt.Errorf("unsupported cutover evidence status")
	}
	if activeCampaignPostPilotCleanupAuthorized(job) {
		revokingCleanup := key == activeCampaignPostPilotCleanupEvidenceKey && oneOf(status, "warning", "blocker")
		if !revokingCleanup {
			return activeCampaignPostPilotCleanupFreezeError(job, "cutover evidence")
		}
		if activeCampaignPostPilotCleanupStarted(job) {
			return fmt.Errorf("%w; cleanup already started and its authorization can no longer be revoked", errActiveCampaignPostPilotCleanupFrozen)
		}
	}
	detail := cleanCutoverEvidenceDetail(in.Detail)
	evidence := cleanCutoverEvidence(in.Evidence)
	if detail == "" && len(evidence) == 0 {
		return fmt.Errorf("cutover evidence requires detail or evidence")
	}
	if status == "pass" {
		if !activeCampaignFinalDeltaCompleted(job) {
			return fmt.Errorf("ActiveCampaign cutover evidence can pass only after the final delta import completes")
		}
		if latestDeltaImportFailed(job) {
			return fmt.Errorf("ActiveCampaign cutover evidence can pass only after the latest final delta import succeeds")
		}
		if key == activeCampaignPostPilotCleanupEvidenceKey {
			report := BuildPilotAcceptanceReport(job)
			h.addPersistentCutoverEvidence(ctx, job.TenantID, job, &report)
			h.revalidateRollbackRehearsalAcceptance(ctx, job, &report)
			if report.Status != "pass" || report.Blockers != 0 {
				return fmt.Errorf("post-pilot cleanup authorization requires strict passing pilot acceptance with no blockers")
			}
		}
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	reviewedAt := time.Now().UTC().Format(time.RFC3339Nano)
	rawEvidence, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("marshal cutover evidence: %w", err)
	}
	evidenceJSON := string(rawEvidence)
	statusKey, atKey, detailKey, evidenceKey := activeCampaignCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &reviewedAt
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidenceJSON
	if key == activeCampaignDeliverabilityReviewKey {
		job.Cursor[acDeliverabilityStatusKey] = &status
		job.Cursor[acDeliverabilityAtKey] = &reviewedAt
		job.Cursor[acDeliverabilityDetailKey] = &detail
		job.Cursor[acDeliverabilityEvidenceKey] = &evidenceJSON
	}
	return h.transitionJob(ctx, job, job.Status)
}

func (h *Migration) persistBeehiivCutoverEvidence(ctx context.Context, job *canonical.MigrationJob, in cutoverEvidenceRequest) error {
	key := strings.TrimSpace(in.Key)
	if !beehiivCutoverEvidenceKeys[key] {
		return fmt.Errorf("unsupported Beehiiv cutover evidence key")
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "pass"
	}
	if !oneOf(status, "pass", "warning", "blocker") {
		return fmt.Errorf("unsupported cutover evidence status")
	}
	detail := cleanCutoverEvidenceDetail(in.Detail)
	evidence := cleanCutoverEvidence(in.Evidence)
	if detail == "" && len(evidence) == 0 {
		return fmt.Errorf("cutover evidence requires detail or evidence")
	}
	if status == "pass" {
		if !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) {
			return fmt.Errorf("Beehiiv cutover evidence can pass only after the latest final delta import succeeds")
		}
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	reviewedAt := time.Now().UTC().Format(time.RFC3339Nano)
	rawEvidence, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("marshal Beehiiv cutover evidence: %w", err)
	}
	evidenceJSON := string(rawEvidence)
	statusKey, atKey, detailKey, evidenceKey := beehiivCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &reviewedAt
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidenceJSON
	return h.transitionJob(ctx, job, job.Status)
}

func beehiivCutoverEvidenceCursorKeys(key string) (string, string, string, string) {
	prefix := "beehiiv_cutover_evidence_" + key
	return prefix + "_status", prefix + "_reviewed_at", prefix + "_detail", prefix + "_evidence"
}

func beehiivCutoverEvidence(job *canonical.MigrationJob, key string) (string, time.Time, string, []string, bool, error) {
	if job == nil || job.Cursor == nil {
		return "", time.Time{}, "", nil, false, nil
	}
	statusKey, atKey, detailKey, evidenceKey := beehiivCutoverEvidenceCursorKeys(key)
	status, ok := cursorString(job.Cursor, statusKey)
	if !ok || strings.TrimSpace(status) == "" {
		return "", time.Time{}, "", nil, false, nil
	}
	status = strings.TrimSpace(status)
	if !oneOf(status, "pass", "warning", "blocker") {
		return status, time.Time{}, "", nil, true, fmt.Errorf("unsupported Beehiiv cutover evidence status %q", status)
	}
	reviewedRaw, ok := cursorString(job.Cursor, atKey)
	if !ok || strings.TrimSpace(reviewedRaw) == "" {
		return status, time.Time{}, "", nil, true, fmt.Errorf("Beehiiv cutover evidence reviewed_at is missing")
	}
	reviewedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(reviewedRaw))
	if err != nil {
		return status, time.Time{}, "", nil, true, fmt.Errorf("Beehiiv cutover evidence reviewed_at is invalid: %w", err)
	}
	detail, _ := cursorString(job.Cursor, detailKey)
	evidenceRaw, _ := cursorString(job.Cursor, evidenceKey)
	evidence := []string{}
	if strings.TrimSpace(evidenceRaw) != "" {
		if err := json.Unmarshal([]byte(evidenceRaw), &evidence); err != nil {
			return status, time.Time{}, strings.TrimSpace(detail), nil, true, fmt.Errorf("Beehiiv cutover evidence is invalid: %w", err)
		}
	}
	return status, reviewedAt.UTC(), cleanCutoverEvidenceDetail(detail), cleanCutoverEvidence(evidence), true, nil
}

func applyBeehiivCutoverEvidence(job *canonical.MigrationJob, item PilotAcceptanceItem) PilotAcceptanceItem {
	status, reviewedAt, detail, evidence, ok, err := beehiivCutoverEvidence(job, item.Key)
	if !ok {
		return item
	}
	if err != nil {
		item.Status = "blocker"
		item.Detail = "Beehiiv cutover evidence could not be parsed. Re-record the review after final delta import."
		item.Evidence = append(item.Evidence, err.Error())
		return item
	}
	recorded := append([]string{
		"status=" + status,
		"reviewed_at=" + reviewedAt.Format(time.RFC3339),
	}, evidence...)
	if !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) || job.CompletedAt == nil || reviewedAt.Before(job.CompletedAt.UTC()) {
		item.Status = "blocker"
		item.Detail = "Beehiiv cutover evidence must be recorded after the latest successful final delta import."
		item.Evidence = append(item.Evidence, recorded...)
		return item
	}
	item.Status = status
	item.Detail = defaulted(detail, "Beehiiv cutover review evidence was recorded.")
	item.Evidence = recorded
	return item
}

func (h *Migration) persistKlaviyoCutoverEvidence(ctx context.Context, job *canonical.MigrationJob, in cutoverEvidenceRequest) error {
	key := strings.TrimSpace(in.Key)
	if !klaviyoCutoverEvidenceKeys[key] {
		return fmt.Errorf("unsupported Klaviyo cutover evidence key")
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "pass"
	}
	if !oneOf(status, "pass", "warning", "blocker") {
		return fmt.Errorf("unsupported cutover evidence status")
	}
	detail := cleanCutoverEvidenceDetail(in.Detail)
	evidence := cleanCutoverEvidence(in.Evidence)
	if detail == "" && len(evidence) == 0 {
		return fmt.Errorf("cutover evidence requires detail or evidence")
	}
	if status == "pass" && (!activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job)) {
		return fmt.Errorf("Klaviyo cutover evidence can pass only after the latest final delta import succeeds")
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	reviewedAt := time.Now().UTC().Format(time.RFC3339Nano)
	rawEvidence, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("marshal Klaviyo cutover evidence: %w", err)
	}
	evidenceJSON := string(rawEvidence)
	statusKey, atKey, detailKey, evidenceKey := klaviyoCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &reviewedAt
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidenceJSON
	return h.transitionJob(ctx, job, job.Status)
}

func klaviyoCutoverEvidenceCursorKeys(key string) (string, string, string, string) {
	prefix := "klaviyo_cutover_evidence_" + key
	return prefix + "_status", prefix + "_reviewed_at", prefix + "_detail", prefix + "_evidence"
}

func klaviyoCutoverEvidence(job *canonical.MigrationJob, key string) (string, time.Time, string, []string, bool, error) {
	if job == nil || job.Cursor == nil {
		return "", time.Time{}, "", nil, false, nil
	}
	statusKey, atKey, detailKey, evidenceKey := klaviyoCutoverEvidenceCursorKeys(key)
	status, ok := cursorString(job.Cursor, statusKey)
	if !ok || strings.TrimSpace(status) == "" {
		return "", time.Time{}, "", nil, false, nil
	}
	status = strings.TrimSpace(status)
	if !oneOf(status, "pass", "warning", "blocker") {
		return status, time.Time{}, "", nil, true, fmt.Errorf("unsupported Klaviyo cutover evidence status %q", status)
	}
	reviewedRaw, ok := cursorString(job.Cursor, atKey)
	if !ok || strings.TrimSpace(reviewedRaw) == "" {
		return status, time.Time{}, "", nil, true, fmt.Errorf("Klaviyo cutover evidence reviewed_at is missing")
	}
	reviewedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(reviewedRaw))
	if err != nil {
		return status, time.Time{}, "", nil, true, fmt.Errorf("Klaviyo cutover evidence reviewed_at is invalid: %w", err)
	}
	detail, _ := cursorString(job.Cursor, detailKey)
	evidenceRaw, _ := cursorString(job.Cursor, evidenceKey)
	evidence := []string{}
	if strings.TrimSpace(evidenceRaw) != "" {
		if err := json.Unmarshal([]byte(evidenceRaw), &evidence); err != nil {
			return status, time.Time{}, strings.TrimSpace(detail), nil, true, fmt.Errorf("Klaviyo cutover evidence is invalid: %w", err)
		}
	}
	return status, reviewedAt.UTC(), cleanCutoverEvidenceDetail(detail), cleanCutoverEvidence(evidence), true, nil
}

func applyKlaviyoCutoverEvidence(job *canonical.MigrationJob, item PilotAcceptanceItem) PilotAcceptanceItem {
	status, reviewedAt, detail, evidence, ok, err := klaviyoCutoverEvidence(job, item.Key)
	if !ok {
		return item
	}
	if err != nil {
		item.Status = "blocker"
		item.Detail = "Klaviyo cutover evidence could not be parsed. Re-record the review after final delta import."
		item.Evidence = append(item.Evidence, err.Error())
		return item
	}
	recorded := append([]string{
		"status=" + status,
		"reviewed_at=" + reviewedAt.Format(time.RFC3339),
	}, evidence...)
	if !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) || job.CompletedAt == nil || reviewedAt.Before(job.CompletedAt.UTC()) {
		item.Status = "blocker"
		item.Detail = "Klaviyo cutover evidence must be recorded after the latest successful final delta import."
		item.Evidence = append(item.Evidence, recorded...)
		return item
	}
	item.Status = status
	item.Detail = defaulted(detail, "Klaviyo cutover review evidence was recorded.")
	item.Evidence = recorded
	return item
}

func (h *Migration) persistCustomerIOCutoverEvidence(ctx context.Context, job *canonical.MigrationJob, in cutoverEvidenceRequest) error {
	key := strings.TrimSpace(in.Key)
	if !customerIOCutoverEvidenceKeys[key] {
		return fmt.Errorf("unsupported Customer.io cutover evidence key")
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "pass"
	}
	if !oneOf(status, "pass", "warning", "blocker") {
		return fmt.Errorf("unsupported cutover evidence status")
	}
	detail := cleanCutoverEvidenceDetail(in.Detail)
	evidence := cleanCutoverEvidence(in.Evidence)
	if detail == "" && len(evidence) == 0 {
		return fmt.Errorf("cutover evidence requires detail or evidence")
	}
	if status == "pass" && (!activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job)) {
		return fmt.Errorf("Customer.io cutover evidence can pass only after the latest final delta import succeeds")
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	reviewedAt := time.Now().UTC().Format(time.RFC3339Nano)
	rawEvidence, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("marshal Customer.io cutover evidence: %w", err)
	}
	evidenceJSON := string(rawEvidence)
	statusKey, atKey, detailKey, evidenceKey := customerIOCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &reviewedAt
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidenceJSON
	return h.transitionJob(ctx, job, job.Status)
}

func customerIOCutoverEvidenceCursorKeys(key string) (string, string, string, string) {
	prefix := "customerio_cutover_evidence_" + key
	return prefix + "_status", prefix + "_reviewed_at", prefix + "_detail", prefix + "_evidence"
}

func customerIOCutoverEvidence(job *canonical.MigrationJob, key string) (string, time.Time, string, []string, bool, error) {
	if job == nil || job.Cursor == nil {
		return "", time.Time{}, "", nil, false, nil
	}
	statusKey, atKey, detailKey, evidenceKey := customerIOCutoverEvidenceCursorKeys(key)
	status, ok := cursorString(job.Cursor, statusKey)
	if !ok || strings.TrimSpace(status) == "" {
		return "", time.Time{}, "", nil, false, nil
	}
	status = strings.TrimSpace(status)
	if !oneOf(status, "pass", "warning", "blocker") {
		return status, time.Time{}, "", nil, true, fmt.Errorf("unsupported Customer.io cutover evidence status %q", status)
	}
	reviewedRaw, ok := cursorString(job.Cursor, atKey)
	if !ok || strings.TrimSpace(reviewedRaw) == "" {
		return status, time.Time{}, "", nil, true, fmt.Errorf("Customer.io cutover evidence reviewed_at is missing")
	}
	reviewedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(reviewedRaw))
	if err != nil {
		return status, time.Time{}, "", nil, true, fmt.Errorf("Customer.io cutover evidence reviewed_at is invalid: %w", err)
	}
	detail, _ := cursorString(job.Cursor, detailKey)
	evidenceRaw, _ := cursorString(job.Cursor, evidenceKey)
	evidence := []string{}
	if strings.TrimSpace(evidenceRaw) != "" {
		if err := json.Unmarshal([]byte(evidenceRaw), &evidence); err != nil {
			return status, time.Time{}, strings.TrimSpace(detail), nil, true, fmt.Errorf("Customer.io cutover evidence is invalid: %w", err)
		}
	}
	return status, reviewedAt.UTC(), cleanCutoverEvidenceDetail(detail), cleanCutoverEvidence(evidence), true, nil
}

func applyCustomerIOCutoverEvidence(job *canonical.MigrationJob, item PilotAcceptanceItem) PilotAcceptanceItem {
	status, reviewedAt, detail, evidence, ok, err := customerIOCutoverEvidence(job, item.Key)
	if !ok {
		return item
	}
	if err != nil {
		item.Status = "blocker"
		item.Detail = "Customer.io cutover evidence could not be parsed. Re-record the review after final delta import."
		item.Evidence = append(item.Evidence, err.Error())
		return item
	}
	recorded := append([]string{
		"status=" + status,
		"reviewed_at=" + reviewedAt.Format(time.RFC3339),
	}, evidence...)
	if !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) || job.CompletedAt == nil || reviewedAt.Before(job.CompletedAt.UTC()) {
		item.Status = "blocker"
		item.Detail = "Customer.io cutover evidence must be recorded after the latest successful final delta import."
		item.Evidence = append(item.Evidence, recorded...)
		return item
	}
	item.Status = status
	item.Detail = defaulted(detail, "Customer.io cutover review evidence was recorded.")
	item.Evidence = recorded
	return item
}

func (h *Migration) persistHubSpotCutoverEvidence(ctx context.Context, job *canonical.MigrationJob, in cutoverEvidenceRequest) error {
	key := strings.TrimSpace(in.Key)
	if !hubSpotCutoverEvidenceKeys[key] {
		return fmt.Errorf("unsupported HubSpot cutover evidence key")
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		status = "pass"
	}
	if !oneOf(status, "pass", "warning", "blocker") {
		return fmt.Errorf("unsupported cutover evidence status")
	}
	if postPilotCleanupAuthorized(job) {
		revokingCleanup := key == hubSpotPostPilotCleanupEvidenceKey && oneOf(status, "warning", "blocker")
		if !revokingCleanup {
			return postPilotCleanupFreezeError(job, "cutover evidence")
		}
		if postPilotCleanupStarted(job) {
			return fmt.Errorf("%w; cleanup already started and its authorization can no longer be revoked", errActiveCampaignPostPilotCleanupFrozen)
		}
	}
	detail := cleanCutoverEvidenceDetail(in.Detail)
	evidence := cleanCutoverEvidence(in.Evidence)
	if detail == "" && len(evidence) == 0 {
		return fmt.Errorf("cutover evidence requires detail or evidence")
	}
	if status == "pass" && (!activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job)) {
		return fmt.Errorf("HubSpot cutover evidence can pass only after the latest final full snapshot succeeds")
	}
	if status == "pass" && key == hubSpotPostPilotCleanupEvidenceKey {
		report := BuildPilotAcceptanceReport(job)
		h.addPersistentCutoverEvidence(ctx, job.TenantID, job, &report)
		h.revalidateRollbackRehearsalAcceptance(ctx, job, &report)
		if report.Status != "pass" || report.Blockers != 0 {
			return fmt.Errorf("HubSpot post-pilot cleanup authorization requires strict passing pilot acceptance with no blockers")
		}
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	reviewedAt := time.Now().UTC().Format(time.RFC3339Nano)
	rawEvidence, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("marshal HubSpot cutover evidence: %w", err)
	}
	evidenceJSON := string(rawEvidence)
	statusKey, atKey, detailKey, evidenceKey := hubSpotCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &reviewedAt
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidenceJSON
	return h.transitionJob(ctx, job, job.Status)
}

func hubSpotCutoverEvidenceCursorKeys(key string) (string, string, string, string) {
	prefix := "hubspot_cutover_evidence_" + key
	return prefix + "_status", prefix + "_reviewed_at", prefix + "_detail", prefix + "_evidence"
}

func hubSpotCutoverEvidence(job *canonical.MigrationJob, key string) (string, time.Time, string, []string, bool, error) {
	if job == nil || job.Cursor == nil {
		return "", time.Time{}, "", nil, false, nil
	}
	statusKey, atKey, detailKey, evidenceKey := hubSpotCutoverEvidenceCursorKeys(key)
	status, ok := cursorString(job.Cursor, statusKey)
	if !ok || strings.TrimSpace(status) == "" {
		return "", time.Time{}, "", nil, false, nil
	}
	status = strings.TrimSpace(status)
	if !oneOf(status, "pass", "warning", "blocker") {
		return status, time.Time{}, "", nil, true, fmt.Errorf("unsupported HubSpot cutover evidence status %q", status)
	}
	reviewedRaw, ok := cursorString(job.Cursor, atKey)
	if !ok || strings.TrimSpace(reviewedRaw) == "" {
		return status, time.Time{}, "", nil, true, fmt.Errorf("HubSpot cutover evidence reviewed_at is missing")
	}
	reviewedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(reviewedRaw))
	if err != nil {
		return status, time.Time{}, "", nil, true, fmt.Errorf("HubSpot cutover evidence reviewed_at is invalid: %w", err)
	}
	detail, _ := cursorString(job.Cursor, detailKey)
	evidenceRaw, _ := cursorString(job.Cursor, evidenceKey)
	evidence := []string{}
	if strings.TrimSpace(evidenceRaw) != "" {
		if err := json.Unmarshal([]byte(evidenceRaw), &evidence); err != nil {
			return status, time.Time{}, strings.TrimSpace(detail), nil, true, fmt.Errorf("HubSpot cutover evidence is invalid: %w", err)
		}
	}
	return status, reviewedAt.UTC(), cleanCutoverEvidenceDetail(detail), cleanCutoverEvidence(evidence), true, nil
}

func applyHubSpotCutoverEvidence(job *canonical.MigrationJob, item PilotAcceptanceItem) PilotAcceptanceItem {
	status, reviewedAt, detail, evidence, ok, err := hubSpotCutoverEvidence(job, item.Key)
	if !ok {
		return item
	}
	if err != nil {
		item.Status = "blocker"
		item.Detail = "HubSpot cutover evidence could not be parsed. Re-record the review after the final full snapshot."
		item.Evidence = append(item.Evidence, err.Error())
		return item
	}
	recorded := append([]string{
		"status=" + status,
		"reviewed_at=" + reviewedAt.Format(time.RFC3339),
	}, evidence...)
	if !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) || job.CompletedAt == nil || reviewedAt.Before(job.CompletedAt.UTC()) {
		item.Status = "blocker"
		item.Detail = "HubSpot cutover evidence must be recorded after the latest successful final full snapshot."
		item.Evidence = append(item.Evidence, recorded...)
		return item
	}
	item.Status = status
	item.Detail = defaulted(detail, "HubSpot CRM-bridge scope review evidence was recorded.")
	item.Evidence = recorded
	return item
}

func activeCampaignCutoverEvidenceCursorKeys(key string) (string, string, string, string) {
	prefix := "activecampaign_cutover_evidence_" + key
	return prefix + "_status", prefix + "_reviewed_at", prefix + "_detail", prefix + "_evidence"
}

func applyActiveCampaignCutoverEvidence(job *canonical.MigrationJob, item PilotAcceptanceItem) PilotAcceptanceItem {
	status, reviewedAt, detail, evidence, ok, err := activeCampaignCutoverEvidence(job, item.Key)
	if !ok {
		return item
	}
	if err != nil {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign cutover evidence could not be parsed. Re-record review after final delta import."
		item.Evidence = append([]string{"status=" + sanitizeMigrationText(canonical.SourceActiveCampaign, status)}, sanitizeMigrationText(canonical.SourceActiveCampaign, err.Error()))
		return item
	}
	recorded := append([]string{
		"status=" + status,
		"reviewed_at=" + reviewedAt.UTC().Format(time.RFC3339),
	}, evidence...)
	if !activeCampaignFinalDeltaCompleted(job) {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign cutover evidence requires a completed final delta import. Re-record review after final delta import."
		item.Evidence = append(item.Evidence, recorded...)
		return item
	}
	if latestDeltaImportFailed(job) {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign cutover evidence requires the latest final delta import to succeed. Re-run final delta import, then re-record review."
		item.Evidence = append(item.Evidence, recorded...)
		return item
	}
	if reviewedAt.Before(job.CompletedAt.UTC()) {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign cutover evidence predates the latest completed import. Re-record review after final delta import."
		item.Evidence = append(item.Evidence, recorded...)
		return item
	}
	if item.Status == "blocker" && !activeCampaignEvidenceClearsBlockers[item.Key] {
		item.Evidence = append(item.Evidence, recorded...)
		return item
	}
	item.Status = status
	item.Detail = defaulted(detail, "ActiveCampaign cutover review evidence was recorded.")
	item.Evidence = recorded
	return item
}

func activeCampaignCutoverEvidence(job *canonical.MigrationJob, key string) (string, time.Time, string, []string, bool, error) {
	if job == nil || job.Cursor == nil {
		return "", time.Time{}, "", nil, false, nil
	}
	statusKey, atKey, detailKey, evidenceKey := activeCampaignCutoverEvidenceCursorKeys(key)
	status, ok := cursorString(job.Cursor, statusKey)
	if !ok || strings.TrimSpace(status) == "" {
		return "", time.Time{}, "", nil, false, nil
	}
	status = strings.TrimSpace(status)
	if !oneOf(status, "pass", "warning", "blocker") {
		return status, time.Time{}, "", nil, true, fmt.Errorf("unsupported ActiveCampaign cutover evidence status %q", status)
	}
	reviewedRaw, ok := cursorString(job.Cursor, atKey)
	if !ok || strings.TrimSpace(reviewedRaw) == "" {
		return status, time.Time{}, "", nil, true, fmt.Errorf("cutover evidence reviewed_at is missing")
	}
	reviewedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(reviewedRaw))
	if err != nil {
		return status, time.Time{}, "", nil, true, fmt.Errorf("cutover evidence reviewed_at %q is invalid: %w", reviewedRaw, err)
	}
	detail, _ := cursorString(job.Cursor, detailKey)
	evidenceRaw, _ := cursorString(job.Cursor, evidenceKey)
	evidence := []string{}
	if strings.TrimSpace(evidenceRaw) != "" {
		if err := json.Unmarshal([]byte(evidenceRaw), &evidence); err != nil {
			return status, time.Time{}, strings.TrimSpace(detail), nil, true, fmt.Errorf("cutover evidence is invalid: %w", err)
		}
	}
	return status, reviewedAt.UTC(), cleanCutoverEvidenceDetail(detail), cleanCutoverEvidence(evidence), true, nil
}

func activeCampaignDeliverabilityAcceptanceItem(job *canonical.MigrationJob) PilotAcceptanceItem {
	item := PilotAcceptanceItem{
		Key:    activeCampaignDeliverabilityReviewKey,
		Label:  "ActiveCampaign deliverability review",
		Status: "warning",
		Detail: "Verify sending domains, tracking links, suppression policies, forms, webhooks, and final delta import evidence before moving ActiveCampaign traffic to Moosewave.",
	}
	status, reviewedAt, detail, evidence, ok, err := activeCampaignDeliverabilityEvidence(job)
	if !ok {
		return item
	}
	if err != nil {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign deliverability evidence could not be parsed. Re-record deliverability review after final delta import."
		item.Evidence = append([]string{"status=" + sanitizeMigrationText(canonical.SourceActiveCampaign, status)}, sanitizeMigrationText(canonical.SourceActiveCampaign, err.Error()))
		return item
	}
	item.Status = status
	item.Detail = defaulted(detail, "ActiveCampaign deliverability review evidence was recorded.")
	item.Evidence = append([]string{
		"status=" + status,
		"reviewed_at=" + reviewedAt.UTC().Format(time.RFC3339),
	}, evidence...)
	if job != nil && job.CompletedAt != nil && reviewedAt.Before(job.CompletedAt.UTC()) {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign deliverability evidence predates the latest completed import. Re-record review after final delta import."
		return item
	}
	if status == "pass" && !activeCampaignFinalDeltaCompleted(job) {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign deliverability evidence requires a completed final delta import. Re-record review after final delta import."
		return item
	}
	if status == "pass" && latestDeltaImportFailed(job) {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign deliverability evidence requires the latest final delta import to succeed. Re-run final delta import, then re-record review."
		return item
	}
	if status == "pass" && detail == "" {
		item.Detail = "ActiveCampaign deliverability review was signed off after final delta import."
	}
	return item
}

func activeCampaignDeliverabilityEvidence(job *canonical.MigrationJob) (string, time.Time, string, []string, bool, error) {
	if job == nil || job.Cursor == nil {
		return "", time.Time{}, "", nil, false, nil
	}
	status, ok := cursorString(job.Cursor, acDeliverabilityStatusKey)
	if !ok || strings.TrimSpace(status) == "" {
		return "", time.Time{}, "", nil, false, nil
	}
	status = strings.TrimSpace(status)
	if !oneOf(status, "pass", "warning", "blocker") {
		return status, time.Time{}, "", nil, true, fmt.Errorf("unsupported ActiveCampaign deliverability status %q", status)
	}
	reviewedRaw, ok := cursorString(job.Cursor, acDeliverabilityAtKey)
	if !ok || strings.TrimSpace(reviewedRaw) == "" {
		return status, time.Time{}, "", nil, true, fmt.Errorf("deliverability reviewed_at is missing")
	}
	reviewedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(reviewedRaw))
	if err != nil {
		return status, time.Time{}, "", nil, true, fmt.Errorf("deliverability reviewed_at %q is invalid: %w", reviewedRaw, err)
	}
	detail, _ := cursorString(job.Cursor, acDeliverabilityDetailKey)
	evidenceRaw, _ := cursorString(job.Cursor, acDeliverabilityEvidenceKey)
	evidence := []string{}
	if strings.TrimSpace(evidenceRaw) != "" {
		if err := json.Unmarshal([]byte(evidenceRaw), &evidence); err != nil {
			return status, time.Time{}, strings.TrimSpace(detail), nil, true, fmt.Errorf("deliverability evidence is invalid: %w", err)
		}
	}
	return status, reviewedAt.UTC(), cleanCutoverEvidenceDetail(detail), cleanCutoverEvidence(evidence), true, nil
}

func cleanCutoverEvidence(items []string) []string {
	out := []string{}
	for _, item := range items {
		value := cleanCutoverEvidenceText(item, maxCutoverEvidenceItemChars)
		if value == "" {
			continue
		}
		out = append(out, value)
		if len(out) == 20 {
			break
		}
	}
	return out
}

func cleanCutoverEvidenceDetail(value string) string {
	return cleanCutoverEvidenceText(value, maxCutoverEvidenceDetailChars)
}

func cleanCutoverEvidenceText(value string, maxChars int) string {
	cleaned := redactCutoverEvidenceText(strings.TrimSpace(value))
	if cleaned == "" {
		return ""
	}
	runes := []rune(cleaned)
	if maxChars > 0 && len(runes) > maxChars {
		return string(runes[:maxChars])
	}
	return cleaned
}

func redactCutoverEvidenceText(value string) string {
	out := cutoverActiveCampaignAPIURLPattern.ReplaceAllString(value, "[redacted-activecampaign-api-url]")
	out = cutoverActiveCampaignBareHostPattern.ReplaceAllString(out, "$1[redacted-activecampaign-api-url]")
	out = redactConfiguredActiveCampaignAPIHosts(out)
	out = cutoverTokenLikePattern.ReplaceAllString(out, "$1=[redacted]")
	out = cutoverBasicAuthURLPattern.ReplaceAllString(out, "$1[redacted]@")
	out = cutoverSourceEventIDPattern.ReplaceAllString(out, "[redacted-activecampaign-source-event-id]")
	out = cutoverHubSpotSourceEventIDPattern.ReplaceAllString(out, "[redacted-hubspot-source-event-id]")
	out = cutoverSourceEventCursorIDPattern.ReplaceAllString(out, "$1[redacted]")
	out = cutoverSourceEventContactPattern.ReplaceAllString(out, "$1[redacted-activecampaign-contact]$2")
	return out
}

func redactConfiguredActiveCampaignAPIHosts(value string) string {
	out := value
	for _, entry := range strings.Split(os.Getenv("ACTIVECAMPAIGN_ALLOWED_API_HOSTS"), ",") {
		host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(entry)), ".")
		if host == "" || !strings.Contains(host, ".") || strings.ContainsAny(host, "/:@?#[]*") {
			continue
		}
		out = regexp.MustCompile(`(?i)`+regexp.QuoteMeta(host)).ReplaceAllString(out, "[redacted-activecampaign-api-url]")
	}
	return out
}

func latestDeltaImportFailed(job *canonical.MigrationJob) bool {
	if job == nil || job.Cursor == nil {
		return false
	}
	value, ok := cursorString(job.Cursor, deltaImportLastErrorKey)
	return ok && strings.TrimSpace(value) != ""
}

func activeCampaignFinalDeltaCompleted(job *canonical.MigrationJob) bool {
	return job != nil &&
		job.Status == canonical.MigCompleted &&
		job.CompletedAt != nil &&
		isDeltaImportRun(job)
}

func activeCampaignFinalDeltaStartedAt(job *canonical.MigrationJob) (time.Time, bool, error) {
	return sourceBridgeFinalDeltaStartedAt(job)
}

func sourceBridgeFinalDeltaStartedAt(job *canonical.MigrationJob) (time.Time, bool, error) {
	if job == nil || !isDeltaImportRun(job) {
		return time.Time{}, false, nil
	}
	if job.Cursor != nil {
		if raw, ok := cursorString(job.Cursor, deltaImportStartedAtKey); ok && strings.TrimSpace(raw) != "" {
			startedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
			if err != nil {
				return time.Time{}, true, fmt.Errorf("final delta started_at %q is invalid: %w", raw, err)
			}
			return startedAt.UTC(), true, nil
		}
	}
	if !job.StartedAt.IsZero() {
		return job.StartedAt.UTC(), true, nil
	}
	return time.Time{}, false, nil
}

func activeCampaignSourceEventSyncedBeforeDeltaAt(job *canonical.MigrationJob) (time.Time, bool, error) {
	return sourceBridgeSourceEventSyncedBeforeDeltaAt(job)
}

func sourceBridgeSourceEventSyncedBeforeDeltaAt(job *canonical.MigrationJob) (time.Time, bool, error) {
	if job == nil || job.Cursor == nil {
		return time.Time{}, false, nil
	}
	raw, ok := cursorString(job.Cursor, sourceEventPreDeltaSyncedKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return time.Time{}, false, nil
	}
	syncedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, true, fmt.Errorf("pre-delta source-event synced_at %q is invalid: %w", raw, err)
	}
	return syncedAt.UTC(), true, nil
}

func activeCampaignAutomationReviewItem(job *canonical.MigrationJob, report *canonical.VerificationReport) (PilotAcceptanceItem, bool) {
	row, ok := resourceByName(report, "automations")
	if !ok || row.SourceTotal == 0 {
		return PilotAcceptanceItem{}, false
	}
	rebuilds := ensureAutomationRebuilds(report)
	passed := countPassedAutomationRebuilds(rebuilds)
	item := PilotAcceptanceItem{
		Key:      "activecampaign_automation_rebuild_review",
		Label:    "ActiveCampaign automation rebuild review",
		Status:   "pass",
		Expected: row.SourceTotal,
		Actual:   passed,
		Detail:   "Tracked ActiveCampaign automation rebuilds are test-passed or explicitly approved as not needed.",
		Evidence: row.Notes,
	}
	if len(rebuilds) == 0 {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign automations were detected but no rebuild ledger exists. Re-run import or create rebuild/sign-off items before cutover."
		return item, true
	}
	pending := pendingAutomationRebuildEvidence(rebuilds)
	if len(pending) > 0 {
		item.Status = "blocker"
		item.Detail = "ActiveCampaign automations must be rebuilt, test-passed, or explicitly approved as not needed before cutover."
		item.Evidence = append(append([]string(nil), row.Notes...), pending...)
		return item, true
	}
	if row.SourceTotal > len(rebuilds) {
		item.Status = "warning"
		item.Detail = "Only the highest-priority ActiveCampaign automation rebuilds are tracked in this report. Review the remaining source automations or record explicit out-of-scope sign-off before cutover."
		item.Actual = len(rebuilds)
		return applyActiveCampaignCutoverEvidence(job, item), true
	}
	return applyActiveCampaignCutoverEvidence(job, item), true
}

func countPassedAutomationRebuilds(rebuilds []canonical.AutomationRebuildItem) int {
	count := 0
	for _, item := range rebuilds {
		if automationRebuildItemPassed(item) {
			count++
		}
	}
	return count
}

func pendingAutomationRebuildEvidence(rebuilds []canonical.AutomationRebuildItem) []string {
	pending := []string{}
	for _, item := range rebuilds {
		if !automationRebuildPassStatuses[item.Status] {
			pending = append(pending, fmt.Sprintf("#%d %s (%s)", item.Rank, item.Name, item.Status))
			continue
		}
		if !automationRebuildItemPassed(item) {
			pending = append(pending, fmt.Sprintf("#%d %s (%s; missing test evidence)", item.Rank, item.Name, item.Status))
		}
	}
	return pending
}

func activeCampaignFinalDeltaAcceptanceItem(job *canonical.MigrationJob) PilotAcceptanceItem {
	return sourceFinalDeltaAcceptanceItem(
		job,
		"activecampaign_final_delta_import",
		"ActiveCampaign final delta import",
		"Run final delta import after freezing ActiveCampaign edits and before moving traffic to Moosewave.",
	)
}

func sourceBridgeFinalDeltaAcceptanceItem(job *canonical.MigrationJob) PilotAcceptanceItem {
	source := canonical.SourcePlatform("")
	if job != nil {
		source = job.Source
	}
	label := pilotSourceDisplayName(source)
	return sourceFinalDeltaAcceptanceItem(
		job,
		string(source)+"_final_delta_import",
		label+" final delta import",
		"Run final delta import after freezing "+label+" contact/list edits that affect the bridge audience.",
	)
}

func sourceFinalDeltaAcceptanceItem(job *canonical.MigrationJob, key, label, detail string) PilotAcceptanceItem {
	item := PilotAcceptanceItem{
		Key:    key,
		Label:  label,
		Status: "blocker",
		Detail: detail,
	}
	if job == nil || job.Cursor == nil {
		return item
	}
	if lastErr, ok := cursorString(job.Cursor, deltaImportLastErrorKey); ok && strings.TrimSpace(lastErr) != "" {
		item.Detail = "The most recent final delta import failed. Re-run it successfully before accepting the cutover."
		item.Evidence = []string{sanitizeMigrationText(job.Source, lastErr)}
		return item
	}
	if isDeltaImportRun(job) && job.Status == canonical.MigCompleted {
		if job.CompletedAt == nil {
			item.Detail = "Final delta import completion time is missing. Re-run final delta import before accepting the cutover."
			return item
		}
		item.Status = "pass"
		item.Detail = "Final delta import completed after the committed migration."
		item.Evidence = []string{"completed_at=" + job.CompletedAt.UTC().Format(time.RFC3339)}
		return item
	}
	return item
}

func activeCampaignShadowCheckAcceptanceItem(job *canonical.MigrationJob, shadow *shadowCheckResponse, err error, supported bool) PilotAcceptanceItem {
	item := PilotAcceptanceItem{
		Key:    "activecampaign_shadow_check",
		Label:  "ActiveCampaign shadow check",
		Status: "blocker",
		Detail: "Run shadow check after the final delta import and confirm no unhandled source deltas remain.",
	}
	if !supported {
		item.Detail = "Shadow-check evidence is unavailable because this migration store does not support shadow monitoring."
		return item
	}
	if err != nil {
		item.Detail = "Latest shadow-check evidence could not be loaded."
		item.Evidence = []string{sanitizeMigrationText(canonical.SourceActiveCampaign, err.Error())}
		return item
	}
	if shadow == nil {
		item.Detail = "No persisted shadow-check evidence exists for this ActiveCampaign migration."
		return item
	}
	evidence := []string{
		"generated_at=" + shadow.GeneratedAt.UTC().Format(time.RFC3339),
		"recommended_action=" + firstNonEmpty(shadow.RecommendedAction, "unknown"),
	}
	if strings.TrimSpace(shadow.AttemptToken) != "" {
		evidence = append(evidence, "attempt_token="+strings.TrimSpace(shadow.AttemptToken))
	}
	if strings.TrimSpace(shadow.ImportEpoch) != "" {
		evidence = append(evidence, "import_epoch="+strings.TrimSpace(shadow.ImportEpoch))
	}
	if strings.TrimSpace(shadow.BaselineFingerprint) != "" {
		evidence = append(evidence, "baseline_fingerprint="+strings.TrimSpace(shadow.BaselineFingerprint))
	}
	if strings.TrimSpace(shadow.Error) != "" {
		evidence = append(evidence, "error="+cleanCutoverEvidenceDetail(shadow.Error))
		item.Detail = "Latest shadow check failed. Resolve the error and run a fresh successful shadow check before cutover."
		item.Evidence = evidence
		return item
	}
	action := strings.TrimSpace(shadow.RecommendedAction)
	if action == "" {
		item.Detail = "Latest shadow-check evidence is missing a cutover recommendation. Re-run shadow check after final delta import."
		item.Evidence = evidence
		return item
	}
	if matches, bindingErr := shadowAttemptMatchesCurrentJob(job, shadow); bindingErr != nil || !matches {
		item.Detail = "The latest shadow check belongs to an earlier migration or shadow attempt. Re-run shadow check after the current final delta import."
		item.Evidence = evidence
		if bindingErr != nil {
			item.Evidence = append(item.Evidence, sanitizeMigrationText(canonical.SourceActiveCampaign, bindingErr.Error()))
		}
		return item
	}
	if shadow.NeedsDeltaImport || action == "run_delta_import_before_cutover" {
		item.Detail = "Latest shadow check found source-side changes that require another final delta import before cutover."
		item.Evidence = evidence
		return item
	}
	if len(shadow.Blockers) > 0 || action == "manual_review_required" || action == "check_failed" {
		item.Detail = "Latest shadow check found manual-review blockers before cutover."
		item.Evidence = append(evidence, shadow.Blockers...)
		return item
	}
	if action != "ready_for_cutover_review" {
		item.Detail = "Latest shadow-check evidence has an unrecognized cutover recommendation. Re-run shadow check after final delta import."
		item.Evidence = evidence
		return item
	}
	item.Status = "pass"
	item.Detail = "Latest shadow check found no unhandled ActiveCampaign source deltas."
	item.Evidence = evidence
	return item
}

func activeCampaignSourceEventReplayAcceptanceItem(job *canonical.MigrationJob, monitor *jobstore.SourceEventMonitorRecord, events []jobstore.SourceEventRecord, err error, supported bool) PilotAcceptanceItem {
	item := PilotAcceptanceItem{
		Key:    "activecampaign_source_event_replay",
		Label:  "ActiveCampaign source-event replay",
		Status: "blocker",
		Detail: "Enable source-event replay during the pilot overlap and confirm the latest sync is clean before final cutover.",
	}
	if !supported {
		item.Detail = "Source-event replay evidence is unavailable because this migration store does not support source-event monitoring."
		return item
	}
	if err != nil {
		item.Detail = "Latest source-event replay evidence could not be loaded."
		item.Evidence = []string{sanitizeMigrationText(canonical.SourceActiveCampaign, err.Error())}
		return item
	}
	if monitor == nil {
		item.Detail = "No persisted source-event replay monitor exists for this ActiveCampaign migration."
		return item
	}
	evidence := []string{
		fmt.Sprintf("enabled=%t", monitor.Enabled),
		fmt.Sprintf("events_seen=%d", monitor.EventsSeen),
		fmt.Sprintf("events_applied=%d", monitor.EventsApplied),
	}
	if monitor.LastSyncedAt != nil {
		evidence = append(evidence, "last_synced_at="+monitor.LastSyncedAt.UTC().Format(time.RFC3339))
	}
	if monitor.LastEventAt != nil {
		evidence = append(evidence, "last_event_at="+monitor.LastEventAt.UTC().Format(time.RFC3339))
	}
	finalDeltaStartedAt, hasFinalDeltaStartedAt, finalDeltaStartedErr := activeCampaignFinalDeltaStartedAt(job)
	var preDeltaSyncedAt time.Time
	if finalDeltaStartedErr != nil {
		item.Detail = "Final delta start evidence is invalid. Re-run final delta import before accepting source-event replay."
		item.Evidence = append(evidence, sanitizeMigrationText(canonical.SourceActiveCampaign, finalDeltaStartedErr.Error()))
		return item
	}
	if hasFinalDeltaStartedAt && !monitor.CreatedAt.IsZero() && monitor.CreatedAt.After(finalDeltaStartedAt) {
		item.Detail = "Source-event replay was enabled after the final delta import began. Enable replay during the pilot overlap before final delta, rerun final delta, then refresh pilot acceptance."
		item.Evidence = append(evidence,
			"monitor_created_at="+monitor.CreatedAt.UTC().Format(time.RFC3339),
			"final_delta_started_at="+finalDeltaStartedAt.Format(time.RFC3339),
		)
		return item
	}
	if strings.TrimSpace(monitor.LastError) != "" {
		item.Detail = "The latest source-event replay sync failed. Fix the replay error, rerun source-event sync, then refresh pilot acceptance."
		item.Evidence = append(evidence, cleanCutoverEvidenceDetail(monitor.LastError))
		return item
	}
	if monitor.LastSyncedAt == nil {
		item.Detail = "Source-event replay has not completed an initial sync yet."
		item.Evidence = evidence
		return item
	}
	if hasFinalDeltaStartedAt {
		var hasPreDeltaSyncedAt bool
		var preDeltaSyncedErr error
		preDeltaSyncedAt, hasPreDeltaSyncedAt, preDeltaSyncedErr = activeCampaignSourceEventSyncedBeforeDeltaAt(job)
		if preDeltaSyncedErr != nil {
			item.Detail = "Pre-delta source-event replay evidence is invalid. Re-run source-event sync, then rerun final delta import before accepting source-event replay."
			item.Evidence = append(evidence, sanitizeMigrationText(canonical.SourceActiveCampaign, preDeltaSyncedErr.Error()))
			return item
		}
		if !hasPreDeltaSyncedAt {
			item.Detail = "Source-event replay evidence is missing a clean pre-delta sync snapshot. Run source-event sync before final delta, rerun final delta import, then refresh pilot acceptance."
			item.Evidence = append(evidence, "final_delta_started_at="+finalDeltaStartedAt.Format(time.RFC3339))
			return item
		}
		maxAge := time.Duration(normalizeSourceEventInterval(monitor.IntervalSeconds)) * time.Second
		staleBefore := finalDeltaStartedAt.Add(-maxAge)
		if preDeltaSyncedAt.After(finalDeltaStartedAt) {
			item.Detail = "Pre-delta source-event replay evidence was captured after final delta began. Run source-event sync before final delta, rerun final delta import, then refresh pilot acceptance."
			item.Evidence = append(evidence,
				"pre_delta_source_event_synced_at="+preDeltaSyncedAt.Format(time.RFC3339),
				"final_delta_started_at="+finalDeltaStartedAt.Format(time.RFC3339),
			)
			return item
		}
		if preDeltaSyncedAt.Before(staleBefore) {
			item.Detail = "Source-event replay evidence is stale for the final delta import. Run source-event sync within one monitor interval before final delta, then rerun final delta and refresh pilot acceptance."
			item.Evidence = append(evidence,
				"pre_delta_source_event_synced_at="+preDeltaSyncedAt.Format(time.RFC3339),
				"final_delta_started_at="+finalDeltaStartedAt.Format(time.RFC3339),
				"max_source_event_staleness="+maxAge.String(),
			)
			return item
		}
		evidence = append(evidence, "pre_delta_source_event_synced_at="+preDeltaSyncedAt.Format(time.RFC3339))
	}
	if failed := sourceEventReplayFailures(events); len(failed) > 0 {
		item.Detail = "Persisted source-event replay results include failed automatic replays or unresolved manual-review events. Fix automatic failures and record evidence for each manual review before ActiveCampaign cutover."
		item.Evidence = append(evidence, failed...)
		return item
	}
	if reviewed := sourceEventReplayReviewedCount(events); reviewed > 0 {
		evidence = append(evidence, fmt.Sprintf("manual_review_events_reviewed=%d", reviewed))
	}
	if hasFinalDeltaStartedAt {
		overlapEvidence, overlapErr := validateActiveCampaignSourceEventOverlap(job, finalDeltaStartedAt, preDeltaSyncedAt)
		evidence = append(evidence, overlapEvidence...)
		if overlapErr != nil {
			item.Detail = overlapErr.Error()
			item.Evidence = evidence
			return item
		}
	}
	item.Status = "pass"
	item.Detail = "Durable source-event evidence proves the required continuous overlap and a clean sync before final delta; intentionally unapplied events have row-level review evidence."
	item.Evidence = evidence
	return item
}

func activeCampaignSourceEventOverlapSnapshot(job *canonical.MigrationJob) (sourceEventOverlapSnapshotV1, bool, error) {
	if job == nil || job.Cursor == nil {
		return sourceEventOverlapSnapshotV1{}, false, nil
	}
	raw, ok := cursorString(job.Cursor, sourceEventOverlapSnapshotKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return sourceEventOverlapSnapshotV1{}, false, nil
	}
	var snapshot sourceEventOverlapSnapshotV1
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		return sourceEventOverlapSnapshotV1{}, true, fmt.Errorf("continuous source-event overlap evidence is invalid; keep replay enabled and rerun final delta: %w", err)
	}
	if snapshot.Version != 1 || snapshot.EnabledSince.IsZero() || snapshot.FirstSuccessfulSync.IsZero() ||
		snapshot.PreDeltaSyncedAt.IsZero() || snapshot.CapturedAt.IsZero() ||
		snapshot.IntervalSeconds != normalizeSourceEventInterval(snapshot.IntervalSeconds) ||
		snapshot.SuccessfulSyncs < 0 || snapshot.MaxSyncGapSeconds < 0 {
		return sourceEventOverlapSnapshotV1{}, true, fmt.Errorf("continuous source-event overlap evidence is incomplete or invalid; keep replay enabled and rerun final delta")
	}
	return snapshot, true, nil
}

func validateActiveCampaignSourceEventOverlap(job *canonical.MigrationJob, finalDeltaStartedAt, preDeltaSyncedAt time.Time) ([]string, error) {
	snapshot, ok, err := activeCampaignSourceEventOverlapSnapshot(job)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("final delta did not capture durable continuous source-event overlap evidence. Keep replay enabled for at least seven days, then rerun final delta")
	}
	evidence := []string{
		"overlap_enabled_since=" + snapshot.EnabledSince.UTC().Format(time.RFC3339),
		"overlap_first_successful_sync_at=" + snapshot.FirstSuccessfulSync.UTC().Format(time.RFC3339),
		fmt.Sprintf("overlap_successful_sync_count=%d", snapshot.SuccessfulSyncs),
		fmt.Sprintf("overlap_max_success_gap_seconds=%d", snapshot.MaxSyncGapSeconds),
		fmt.Sprintf("overlap_interval_seconds=%d", snapshot.IntervalSeconds),
		"required_continuous_overlap=" + activeCampaignMinimumSourceEventOverlap.String(),
	}
	if !snapshot.CapturedAt.Equal(finalDeltaStartedAt) || !snapshot.PreDeltaSyncedAt.Equal(preDeltaSyncedAt) {
		return evidence, fmt.Errorf("continuous source-event overlap evidence does not match the latest final delta; keep replay enabled and rerun final delta")
	}
	if snapshot.FirstSuccessfulSync.Before(snapshot.EnabledSince) || snapshot.PreDeltaSyncedAt.Before(snapshot.FirstSuccessfulSync) {
		return evidence, fmt.Errorf("continuous source-event overlap timestamps are inconsistent; re-enable replay and rebuild the overlap before final delta")
	}
	interval := time.Duration(snapshot.IntervalSeconds) * time.Second
	allowedGap := interval + activeCampaignSourceEventGapGrace
	initialGap := snapshot.FirstSuccessfulSync.Sub(snapshot.EnabledSince)
	if initialGap > allowedGap {
		return evidence, fmt.Errorf("source-event replay did not complete its first clean sync within the allowed scheduling gap; re-enable replay and rebuild the overlap before final delta")
	}
	overlap := finalDeltaStartedAt.Sub(snapshot.FirstSuccessfulSync)
	evidence = append(evidence, "continuous_overlap_before_delta="+overlap.String())
	if overlap < activeCampaignMinimumSourceEventOverlap {
		return evidence, fmt.Errorf("source-event replay has not accumulated the required seven-day continuous successful overlap before final delta. Keep it enabled, then rerun final delta after the overlap completes")
	}
	finalGap := finalDeltaStartedAt.Sub(snapshot.PreDeltaSyncedAt)
	evidence = append(evidence, "final_clean_sync_gap="+finalGap.String())
	if finalGap < 0 || finalGap > allowedGap {
		return evidence, fmt.Errorf("source-event replay did not complete a clean sync within the allowed scheduling gap before final delta; keep replay enabled, sync it, then rerun final delta")
	}
	if snapshot.SuccessfulSyncs < 2 || time.Duration(snapshot.MaxSyncGapSeconds)*time.Second > allowedGap {
		return evidence, fmt.Errorf("source-event replay has missing or overlong clean-sync gaps in the overlap window; re-enable replay and rebuild the overlap before final delta")
	}
	minimumSyncs := int(snapshot.PreDeltaSyncedAt.Sub(snapshot.FirstSuccessfulSync)/allowedGap) + 1
	if minimumSyncs < 2 {
		minimumSyncs = 2
	}
	if snapshot.SuccessfulSyncs < minimumSyncs {
		return append(evidence, fmt.Sprintf("minimum_successful_sync_count=%d", minimumSyncs)), fmt.Errorf("source-event replay has too few clean syncs to prove continuous overlap; keep it enabled and rerun final delta after coverage is complete")
	}
	return evidence, nil
}

func sourceBridgeShadowCheckAcceptanceItem(job *canonical.MigrationJob, shadow *shadowCheckResponse, err error, supported bool) PilotAcceptanceItem {
	source := canonical.SourcePlatform("")
	if job != nil {
		source = job.Source
	}
	label := pilotSourceDisplayName(source)
	item := PilotAcceptanceItem{
		Key:    string(source) + "_shadow_check",
		Label:  label + " shadow check",
		Status: "blocker",
		Detail: "Run shadow check after the latest " + label + " bridge import and confirm no unhandled source deltas remain.",
	}
	if !supported {
		item.Detail = "Shadow-check evidence is unavailable because this migration store does not support shadow monitoring."
		return item
	}
	if err != nil {
		item.Detail = "Latest shadow-check evidence could not be loaded."
		item.Evidence = []string{sanitizeMigrationText(source, err.Error())}
		return item
	}
	if shadow == nil {
		item.Detail = "No persisted shadow-check evidence exists for this " + label + " migration."
		return item
	}
	evidence := []string{
		"generated_at=" + shadow.GeneratedAt.UTC().Format(time.RFC3339),
		"recommended_action=" + firstNonEmpty(shadow.RecommendedAction, "unknown"),
	}
	if strings.TrimSpace(shadow.AttemptToken) != "" {
		evidence = append(evidence, "attempt_token="+strings.TrimSpace(shadow.AttemptToken))
	}
	if strings.TrimSpace(shadow.ImportEpoch) != "" {
		evidence = append(evidence, "import_epoch="+strings.TrimSpace(shadow.ImportEpoch))
	}
	if strings.TrimSpace(shadow.BaselineFingerprint) != "" {
		evidence = append(evidence, "baseline_fingerprint="+strings.TrimSpace(shadow.BaselineFingerprint))
	}
	if strings.TrimSpace(shadow.Error) != "" {
		evidence = append(evidence, "error="+cleanCutoverEvidenceDetail(shadow.Error))
		item.Detail = "Latest shadow check failed. Resolve the error and run a fresh successful shadow check before bridge acceptance."
		item.Evidence = evidence
		return item
	}
	action := strings.TrimSpace(shadow.RecommendedAction)
	if action == "" {
		item.Detail = "Latest shadow-check evidence is missing a cutover recommendation. Re-run shadow check after the latest bridge import."
		item.Evidence = evidence
		return item
	}
	if matches, bindingErr := shadowAttemptMatchesCurrentJob(job, shadow); bindingErr != nil || !matches {
		item.Detail = "The latest shadow check belongs to an earlier migration or shadow attempt. Re-run shadow check after the current final delta import."
		item.Evidence = evidence
		if bindingErr != nil {
			item.Evidence = append(item.Evidence, sanitizeMigrationText(source, bindingErr.Error()))
		}
		return item
	}
	if source == canonical.SourceBeehiiv {
		fingerprint, fingerprintFound, fingerprintErr := orchestrator.BeehiivSourceFingerprintFromJob(job)
		epoch, epochFound, epochErr := orchestrator.BeehiivImportEpochFromJob(job)
		if fingerprintErr != nil || epochErr != nil {
			item.Detail = "The current Beehiiv final-delta shadow binding is invalid. Run a fresh final delta import and shadow check before bridge acceptance."
			item.Evidence = append(evidence, sanitizeMigrationText(source, errors.Join(fingerprintErr, epochErr).Error()))
			return item
		}
		if !fingerprintFound || !epochFound {
			item.Detail = "The current Beehiiv final delta predates durable shadow binding. Run a fresh final delta import and shadow check before bridge acceptance."
			item.Evidence = evidence
			return item
		}
		if !validBeehiivShadowBinding(*shadow) || shadow.ImportEpoch != epoch || shadow.BaselineFingerprint != fingerprint.Digest {
			item.Detail = "The latest shadow check belongs to an earlier Beehiiv import baseline. Re-run shadow check after the current final delta import."
			item.Evidence = evidence
			return item
		}
	}
	if source == canonical.SourceHubSpot {
		fingerprint, fingerprintFound, fingerprintErr := orchestrator.HubSpotSourceFingerprintFromJob(job)
		epoch, epochFound, epochErr := orchestrator.HubSpotImportEpochFromJob(job)
		if fingerprintErr != nil || epochErr != nil {
			item.Detail = "The current HubSpot final-delta shadow binding is invalid. Run a fresh final delta import and shadow check before bridge acceptance."
			item.Evidence = append(evidence, sanitizeMigrationText(source, errors.Join(fingerprintErr, epochErr).Error()))
			return item
		}
		if !fingerprintFound || !epochFound {
			item.Detail = "The current HubSpot final delta predates durable exact-source shadow binding. Run a fresh final delta import and shadow check before bridge acceptance."
			item.Evidence = evidence
			return item
		}
		if !validHubSpotShadowBinding(*shadow) || shadow.ImportEpoch != epoch || shadow.BaselineFingerprint != fingerprint.Digest {
			item.Detail = "The latest shadow check belongs to an earlier HubSpot import baseline. Re-run shadow check after the current final delta import."
			item.Evidence = evidence
			return item
		}
	}
	if source == canonical.SourceKlaviyo {
		fingerprint, fingerprintFound, fingerprintErr := orchestrator.KlaviyoSourceFingerprintFromJob(job)
		epoch, epochFound, epochErr := orchestrator.KlaviyoImportEpochFromJob(job)
		if fingerprintErr != nil || epochErr != nil {
			item.Detail = "The current Klaviyo final-delta shadow binding is invalid. Run a fresh final delta import and shadow check before bridge acceptance."
			item.Evidence = append(evidence, sanitizeMigrationText(source, errors.Join(fingerprintErr, epochErr).Error()))
			return item
		}
		if !fingerprintFound || !epochFound {
			item.Detail = "The current Klaviyo final delta predates durable shadow binding. Run a fresh final delta import and shadow check before bridge acceptance."
			item.Evidence = evidence
			return item
		}
		if !validKlaviyoShadowBinding(*shadow) || shadow.ImportEpoch != epoch || shadow.BaselineFingerprint != fingerprint.Digest {
			item.Detail = "The latest shadow check belongs to an earlier Klaviyo import baseline. Re-run shadow check after the current final delta import."
			item.Evidence = evidence
			return item
		}
	}
	if source == canonical.SourceCustomerIO {
		fingerprint, fingerprintFound, fingerprintErr := orchestrator.CustomerIOSourceFingerprintFromJob(job)
		epoch, epochFound, epochErr := orchestrator.CustomerIOImportEpochFromJob(job)
		if fingerprintErr != nil || epochErr != nil {
			item.Detail = "The current Customer.io final-delta shadow binding is invalid. Run a fresh final delta import and shadow check before bridge acceptance."
			item.Evidence = append(evidence, sanitizeMigrationText(source, errors.Join(fingerprintErr, epochErr).Error()))
			return item
		}
		if !fingerprintFound || !epochFound {
			item.Detail = "The current Customer.io final delta predates durable shadow binding. Run a fresh final delta import and shadow check before bridge acceptance."
			item.Evidence = evidence
			return item
		}
		if !validCustomerIOShadowBinding(*shadow) || shadow.ImportEpoch != epoch || shadow.BaselineFingerprint != fingerprint.Digest {
			item.Detail = "The latest shadow check belongs to an earlier Customer.io import baseline. Re-run shadow check after the current final delta import."
			item.Evidence = evidence
			return item
		}
	}
	if shadow.NeedsDeltaImport || action == "run_delta_import_before_cutover" {
		item.Detail = "Latest shadow check found source-side changes that require another delta import before accepting the bridge."
		item.Evidence = evidence
		return item
	}
	if len(shadow.Blockers) > 0 || action == "manual_review_required" || action == "check_failed" {
		item.Detail = "Latest shadow check found manual-review blockers before bridge acceptance."
		item.Evidence = append(evidence, shadow.Blockers...)
		return item
	}
	if action != "ready_for_cutover_review" {
		item.Detail = "Latest shadow-check evidence has an unrecognized recommendation. Re-run shadow check after the latest bridge import."
		item.Evidence = evidence
		return item
	}
	item.Status = "pass"
	item.Detail = "Latest shadow check found no unhandled " + label + " source deltas."
	item.Evidence = evidence
	return item
}

func shadowAttemptMatchesCurrentJob(job *canonical.MigrationJob, shadow *shadowCheckResponse) (bool, error) {
	if shadow == nil || !validShadowDigest(shadow.AttemptToken) {
		return false, nil
	}
	token, found, err := shadowAttemptTokenFromJob(job)
	if err != nil || !found {
		return false, err
	}
	return shadow.AttemptToken == token, nil
}

func sourceBridgeSourceEventReplayAcceptanceItem(job *canonical.MigrationJob, monitor *jobstore.SourceEventMonitorRecord, events []jobstore.SourceEventRecord, err error, supported bool) PilotAcceptanceItem {
	source := canonical.SourcePlatform("")
	if job != nil {
		source = job.Source
	}
	label := pilotSourceDisplayName(source)
	item := PilotAcceptanceItem{
		Key:    string(source) + "_source_event_replay",
		Label:  label + " source-event replay",
		Status: "blocker",
		Detail: "Enable source-event replay during the bridge pilot and confirm the latest sync is clean.",
	}
	if !supported {
		item.Detail = "Source-event replay evidence is unavailable because this migration store does not support source-event monitoring."
		return item
	}
	if err != nil {
		item.Detail = "Latest source-event replay evidence could not be loaded."
		item.Evidence = []string{sanitizeMigrationText(source, err.Error())}
		return item
	}
	if monitor == nil {
		item.Detail = "No persisted source-event replay monitor exists for this " + label + " migration."
		return item
	}
	evidence := []string{
		fmt.Sprintf("enabled=%t", monitor.Enabled),
		fmt.Sprintf("events_seen=%d", monitor.EventsSeen),
		fmt.Sprintf("events_applied=%d", monitor.EventsApplied),
	}
	if monitor.LastSyncedAt != nil {
		evidence = append(evidence, "last_synced_at="+monitor.LastSyncedAt.UTC().Format(time.RFC3339))
	}
	if monitor.LastEventAt != nil {
		evidence = append(evidence, "last_event_at="+monitor.LastEventAt.UTC().Format(time.RFC3339))
	}
	finalDeltaStartedAt, hasFinalDeltaStartedAt, finalDeltaStartedErr := sourceBridgeFinalDeltaStartedAt(job)
	if finalDeltaStartedErr != nil {
		item.Detail = "Final delta start evidence is invalid. Re-run final delta import before accepting source-event replay."
		item.Evidence = append(evidence, sanitizeMigrationText(source, finalDeltaStartedErr.Error()))
		return item
	}
	if hasFinalDeltaStartedAt && !monitor.CreatedAt.IsZero() && monitor.CreatedAt.After(finalDeltaStartedAt) {
		item.Detail = "Source-event replay was enabled after the final delta import began. Enable replay during the bridge overlap before final delta, rerun final delta, then refresh pilot acceptance."
		item.Evidence = append(evidence,
			"monitor_created_at="+monitor.CreatedAt.UTC().Format(time.RFC3339),
			"final_delta_started_at="+finalDeltaStartedAt.Format(time.RFC3339),
		)
		return item
	}
	if strings.TrimSpace(monitor.LastError) != "" {
		item.Detail = "The latest source-event replay sync failed. Fix the replay error, rerun source-event sync, then refresh pilot acceptance."
		item.Evidence = append(evidence, cleanCutoverEvidenceDetail(monitor.LastError))
		return item
	}
	if monitor.LastSyncedAt == nil {
		item.Detail = "Source-event replay has not completed an initial sync yet."
		item.Evidence = evidence
		return item
	}
	if hasFinalDeltaStartedAt {
		preDeltaSyncedAt, hasPreDeltaSyncedAt, preDeltaSyncedErr := sourceBridgeSourceEventSyncedBeforeDeltaAt(job)
		if preDeltaSyncedErr != nil {
			item.Detail = "Pre-delta source-event replay evidence is invalid. Re-run source-event sync, then rerun final delta import before accepting source-event replay."
			item.Evidence = append(evidence, sanitizeMigrationText(source, preDeltaSyncedErr.Error()))
			return item
		}
		if !hasPreDeltaSyncedAt {
			item.Detail = "Source-event replay evidence is missing a clean pre-delta sync snapshot. Run source-event sync before final delta, rerun final delta import, then refresh pilot acceptance."
			item.Evidence = append(evidence, "final_delta_started_at="+finalDeltaStartedAt.Format(time.RFC3339))
			return item
		}
		maxAge := time.Duration(normalizeSourceEventInterval(monitor.IntervalSeconds)) * time.Second
		staleBefore := finalDeltaStartedAt.Add(-maxAge)
		if preDeltaSyncedAt.After(finalDeltaStartedAt) {
			item.Detail = "Pre-delta source-event replay evidence was captured after final delta began. Run source-event sync before final delta, rerun final delta import, then refresh pilot acceptance."
			item.Evidence = append(evidence,
				"pre_delta_source_event_synced_at="+preDeltaSyncedAt.Format(time.RFC3339),
				"final_delta_started_at="+finalDeltaStartedAt.Format(time.RFC3339),
			)
			return item
		}
		if preDeltaSyncedAt.Before(staleBefore) {
			item.Detail = "Source-event replay evidence is stale for the final delta import. Run source-event sync within one monitor interval before final delta, then rerun final delta and refresh pilot acceptance."
			item.Evidence = append(evidence,
				"pre_delta_source_event_synced_at="+preDeltaSyncedAt.Format(time.RFC3339),
				"final_delta_started_at="+finalDeltaStartedAt.Format(time.RFC3339),
				"max_source_event_staleness="+maxAge.String(),
			)
			return item
		}
		evidence = append(evidence, "pre_delta_source_event_synced_at="+preDeltaSyncedAt.Format(time.RFC3339))
	}
	if failed := sourceEventReplayFailures(events); len(failed) > 0 {
		item.Detail = "Persisted source-event replay results include failed automatic replays or unresolved manual-review events. Fix automatic failures and record evidence for each manual review before accepting the bridge."
		item.Evidence = append(evidence, failed...)
		return item
	}
	if reviewed := sourceEventReplayReviewedCount(events); reviewed > 0 {
		evidence = append(evidence, fmt.Sprintf("manual_review_events_reviewed=%d", reviewed))
	}
	item.Status = "pass"
	item.Detail = "Source-event replay has synced cleanly for the " + label + " bridge overlap window."
	if source == canonical.SourceKlaviyo {
		item.Detail = "Klaviyo profile-update replay synced cleanly for the overlap window. This polling stream is supplemental: consent/suppression and the final send-targetable list/segment projection still come from the mandatory full snapshot."
	}
	item.Evidence = evidence
	if !monitor.Enabled {
		if source == canonical.SourceKlaviyo {
			item.Detail = "Klaviyo profile-update replay synced cleanly and was disabled after evidence capture; the final full snapshot remains the consent/suppression and send-targetable audience authority."
		} else {
			item.Detail = "Source-event replay synced cleanly and the monitor was disabled after evidence capture."
		}
	}
	return item
}

func pilotSourceDisplayName(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceHubSpot:
		return "HubSpot"
	case canonical.SourceActiveCampaign:
		return "ActiveCampaign"
	case canonical.SourceMailchimp:
		return "Mailchimp"
	case canonical.SourceBeehiiv:
		return "Beehiiv"
	case canonical.SourceKlaviyo:
		return "Klaviyo"
	case canonical.SourceCustomerIO:
		return "Customer.io"
	default:
		if source == "" {
			return "Source"
		}
		return string(source)
	}
}

func sourceEventReplayFailures(events []jobstore.SourceEventRecord) []string {
	out := []string{}
	for _, event := range events {
		if event.Applied && strings.TrimSpace(event.Error) == "" {
			continue
		}
		if sourceEventManualReviewComplete(event) {
			continue
		}
		detail := sourceEventReplayFailureLabel(event) + ": "
		if event.Applied {
			detail += "applied with warning"
		} else {
			detail += "not applied"
		}
		if strings.TrimSpace(event.Error) != "" {
			detail += " - " + cleanCutoverEvidenceDetail(event.Error)
		}
		out = append(out, detail)
	}
	return out
}

func sourceEventReplayReviewedCount(events []jobstore.SourceEventRecord) int {
	count := 0
	for _, event := range events {
		if sourceEventManualReviewComplete(event) {
			count++
		}
	}
	return count
}

func sourceEventManualReviewComplete(event jobstore.SourceEventRecord) bool {
	return !event.Applied &&
		strings.EqualFold(strings.TrimSpace(event.Action), "manual_review") &&
		strings.EqualFold(strings.TrimSpace(event.ReviewStatus), "reviewed") &&
		event.ReviewedAt != nil &&
		strings.TrimSpace(event.ReviewDetail) != "" &&
		len(event.ReviewEvidence) > 0
}

func sourceEventReplayFailureLabel(event jobstore.SourceEventRecord) string {
	parts := []string{}
	if resource := strings.TrimSpace(event.ResourceType); resource != "" {
		parts = append(parts, resource)
	}
	if action := strings.TrimSpace(event.Action); action != "" {
		parts = append(parts, action)
	}
	if event.OccurredAt != nil {
		parts = append(parts, "occurred_at="+event.OccurredAt.UTC().Format(time.RFC3339))
	}
	if len(parts) == 0 {
		return "source event"
	}
	return strings.Join(parts, " ")
}

func subscriberMergeEvidence(report *canonical.VerificationReport) []string {
	out := make([]string, 0, len(report.SubscriberMergeConflicts))
	for _, merge := range report.SubscriberMergeConflicts {
		detail := fmt.Sprintf("%s: %d source rows", merge.Email, len(merge.SourceIDs))
		if len(merge.ConflictFields) > 0 {
			detail += "; conflicts: " + strings.Join(merge.ConflictFields, ", ")
		}
		out = append(out, detail)
	}
	return out
}

func segmentWarningEvidence(report *canonical.VerificationReport) []string {
	out := make([]string, 0, len(report.SegmentsWithWarnings))
	for _, warning := range report.SegmentsWithWarnings {
		out = append(out, warning.Name+": "+warning.Warning)
	}
	return out
}

func resourceWarningEvidence(warnings []canonical.ResourceWarning) []string {
	out := make([]string, 0, len(warnings))
	for _, warning := range warnings {
		name := firstNonEmpty(warning.Name, warning.SourceID, warning.Resource)
		out = append(out, name+": "+warning.Warning)
	}
	return out
}

func discoveryWarningAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	warnings := append([]string(nil), report.DiscoveryWarnings...)
	if len(warnings) == 0 {
		return PilotAcceptanceItem{
			Key:    "source_discovery_warnings",
			Label:  "Source discovery warnings",
			Status: "pass",
			Detail: "Discovery completed without adapter-reported source inventory warnings.",
		}
	}
	source := canonical.SourcePlatform("")
	if job != nil {
		source = job.Source
	}
	status := "warning"
	detail := "Discovery completed with source inventory warnings. Review these before accepting the pilot."
	if source == canonical.SourceActiveCampaign {
		status = "blocker"
		detail = "ActiveCampaign discovery warnings mean optional source inventory may be unknown. Fix permissions, rerun discovery, or record explicit cutover sign-off before moving live traffic."
	} else if source == canonical.SourceHubSpot {
		status = "blocker"
		detail = "HubSpot discovery warnings mean bridge inventory may be incomplete. Fix private-app scopes and rerun discovery before accepting the pilot."
	} else if source == canonical.SourceCustomerIO {
		status = "blocker"
		detail = "Customer.io discovery warnings mean workspace inventory, consent, suppression, or ecosystem coverage may be incomplete. Fix App API access and rerun the final delta before cutover review."
	}
	item := PilotAcceptanceItem{
		Key:      "source_discovery_warnings",
		Label:    "Source discovery warnings",
		Status:   status,
		Expected: 0,
		Actual:   len(warnings),
		Detail:   detail,
		Evidence: warnings,
	}
	if source == canonical.SourceActiveCampaign {
		return applyActiveCampaignCutoverEvidence(job, item)
	}
	if source == canonical.SourceBeehiiv {
		return applyBeehiivCutoverEvidence(job, item)
	}
	if source == canonical.SourceKlaviyo {
		return applyKlaviyoCutoverEvidence(job, item)
	}
	if source == canonical.SourceCustomerIO {
		return applyCustomerIOWarningReviewEvidence(job, report, item, "discovery")
	}
	return item
}

func sourceArchiveWarningAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	warnings := report.SourceArchiveWarnings
	if len(warnings) == 0 {
		return PilotAcceptanceItem{
			Key:    "source_archive_warnings",
			Label:  "Source archive warnings",
			Status: "pass",
			Detail: "Source archive preservation completed without adapter-reported endpoint warnings.",
		}
	}
	item := PilotAcceptanceItem{
		Key:      "source_archive_warnings",
		Label:    "Source archive warnings",
		Status:   "blocker",
		Expected: 0,
		Actual:   len(warnings),
		Detail:   "One or more source archive surfaces could not be fetched. Fix source permissions, rerun the migration, or record explicit cutover sign-off before accepting the pilot.",
		Evidence: resourceWarningEvidence(warnings),
	}
	if job != nil && job.Source == canonical.SourceActiveCampaign {
		return applyActiveCampaignCutoverEvidence(job, item)
	}
	if job != nil && job.Source == canonical.SourceBeehiiv {
		return applyBeehiivCutoverEvidence(job, item)
	}
	if job != nil && job.Source == canonical.SourceKlaviyo {
		return applyKlaviyoCutoverEvidence(job, item)
	}
	if job != nil && job.Source == canonical.SourceCustomerIO {
		return applyCustomerIOWarningReviewEvidence(job, report, item, "source archive")
	}
	return item
}

func applyCustomerIOWarningReviewEvidence(job *canonical.MigrationJob, report *canonical.VerificationReport, item PilotAcceptanceItem, surface string) PilotAcceptanceItem {
	if !customerIOExactSnapshotComplete(report) {
		item.Status = "blocker"
		item.Detail = "Customer.io " + surface + " warnings cannot be approved until the final delta proves exact subscriber, audience, sent-newsletter, and source-archive coverage."
		return item
	}
	missing := make([]string, 0, len(customerIOCutoverEvidenceKeys))
	for _, key := range []string{
		customerIOConsentSubscriptionReviewKey,
		customerIOIdentityAudienceReviewKey,
		customerIOAutomationRebuildReviewKey,
		customerIOChannelDependencyReviewKey,
		customerIODeliverabilityReviewKey,
		customerIOEcosystemDependenciesReviewKey,
	} {
		if !customerIOShadowEvidencePassed(job, key) {
			missing = append(missing, key)
			continue
		}
		item.Evidence = append(item.Evidence, key+"=pass")
	}
	if len(missing) > 0 {
		item.Status = "blocker"
		item.Detail = "Customer.io " + surface + " limitations require all six post-final-delta cutover reviews before they can be accepted."
		item.Evidence = append(item.Evidence, "missing_reviews="+strings.Join(missing, ","))
		return item
	}
	item.Status = "pass"
	item.Detail = "Expected Customer.io " + surface + " limitations were reconciled by all six post-final-delta cutover reviews; retained warnings remain audit evidence."
	return item
}

func mailchimpLiveSurfaceCount(report *canonical.VerificationReport) int {
	total := 0
	for _, resource := range []string{"automations", "forms", "landing", "landing_pages", "ecommerce"} {
		if row, ok := resourceByName(report, resource); ok {
			total += row.Imported
		}
	}
	return total
}

func consentAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	total := report.ConsentKnown + report.ConsentUnknown
	key := "consent_reconciliation"
	label := "Consent reconciliation"
	if job != nil && job.Source == canonical.SourceBeehiiv {
		key = "beehiiv_consent_reconciliation"
		label = "Beehiiv consent and suppression reconciliation"
	}
	var item PilotAcceptanceItem
	if total == 0 {
		item = PilotAcceptanceItem{
			Key:    key,
			Label:  label,
			Status: "warning",
			Detail: "This report predates consent coverage metrics. Re-run dry-run/import before customer cutover.",
		}
	} else if report.ConsentUnknown > 0 {
		item = PilotAcceptanceItem{
			Key:      key,
			Label:    label,
			Status:   "warning",
			Expected: total,
			Actual:   report.ConsentKnown,
			Detail:   "Some contacts lack timestamped/typed consent proof. Exclude them from live audiences or obtain explicit sign-off before sending.",
		}
	} else {
		item = PilotAcceptanceItem{
			Key:      key,
			Label:    label,
			Status:   "pass",
			Expected: total,
			Actual:   report.ConsentKnown,
			Detail:   "All imported contacts have typed/source consent evidence reported by the source adapter; channel activation still follows source-specific consent and exclusion gates.",
		}
	}
	if job != nil && job.Source == canonical.SourceBeehiiv {
		return applyBeehiivCutoverEvidence(job, item)
	}
	return item
}

func beehiivSegmentAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	item := resourceAcceptanceItem(report, "segments", "Beehiiv dynamic audience rules and membership snapshots")
	item.Key = "beehiiv_segment_rules_review"
	conditionSetDefinitions := 0
	if report != nil && report.SourceArchiveByResource != nil {
		conditionSetDefinitions = report.SourceArchiveByResource["beehiiv_condition_set"]
	}
	row, hasSegments := resourceByName(report, "segments")
	if (hasSegments && row.SourceTotal > 0) || conditionSetDefinitions > 0 {
		item.Status = "warning"
		item.Detail = "Membership snapshots and condition-set metadata were preserved, but Beehiiv does not expose their saved dynamic predicates. Rebuild or explicitly retire every source rule before cutover."
		if conditionSetDefinitions > item.Expected {
			item.Expected = conditionSetDefinitions
		}
	}
	return applyBeehiivCutoverEvidence(job, item)
}

func beehiivPreservedCoverageAcceptanceItem(report *canonical.VerificationReport, resource, label string) PilotAcceptanceItem {
	row, ok := resourceByName(report, resource)
	key := "beehiiv_" + resource + "_coverage"
	if !ok {
		return PilotAcceptanceItem{
			Key:    key,
			Label:  label,
			Status: "blocker",
			Detail: "This verification report predates required Beehiiv archive coverage. Re-run the final delta before cutover.",
		}
	}
	if row.SourceTotal == 0 {
		return PilotAcceptanceItem{Key: key, Label: label, Status: "pass", Detail: "No source records detected."}
	}
	item := PilotAcceptanceItem{
		Key:      key,
		Label:    label,
		Status:   "pass",
		Expected: row.SourceTotal,
		Actual:   row.Imported,
		Detail:   "Every discovered source definition was durably preserved.",
		Evidence: row.Notes,
	}
	if row.Imported != row.SourceTotal {
		item.Status = "blocker"
		item.Detail = "The durable source archive does not exactly cover the discovery-bound inventory; rerun or repair the archive before cutover."
	}
	return item
}

type beehiivParityGapAcceptanceSpec struct {
	key      string
	resource string
	label    string
	detail   string
}

func beehiivParityGapAcceptanceItems(job *canonical.MigrationJob, report *canonical.VerificationReport) []PilotAcceptanceItem {
	specs := []beehiivParityGapAcceptanceSpec{
		{
			key:      beehiivWebsiteCaptureReviewKey,
			resource: "beehiiv_website_capture_rebuild",
			label:    "Beehiiv website, theme, and capture-widget rebuild",
			detail:   "Inventory the publication site, custom domain, navigation, pages, subscribe forms, popups, embeds, and widget styling; attach post-delta rebuild or explicit retirement evidence before changing traffic.",
		},
		{
			key:      beehiivBoostsRecommendationsReviewKey,
			resource: "beehiiv_boosts_recommendations_rebuild",
			label:    "Beehiiv Boosts and recommendation-network rebuild",
			detail:   "Inventory Boost marketplace relationships, recommendation placements, acquisition history, payouts, and network settings; attach post-delta rebuild or explicit retirement evidence before cutover.",
		},
		{
			key:      beehiivAdNetworkReviewKey,
			resource: "beehiiv_ad_network_rebuild",
			label:    "Beehiiv Ad Network review",
			detail:   "Preserve required Ad Network exports and record ownership for eligibility, placements, campaign history, creative approvals, advertiser relationships, and payouts before cutover.",
		},
	}
	out := make([]PilotAcceptanceItem, 0, len(specs))
	for _, spec := range specs {
		row, ok := resourceByName(report, spec.resource)
		item := PilotAcceptanceItem{
			Key:      spec.key,
			Label:    spec.label,
			Status:   "blocker",
			Expected: 1,
			Detail:   spec.detail,
		}
		if !ok || row.SourceTotal != 1 || row.Imported != 1 {
			if ok {
				item.Actual = row.Imported
				item.Evidence = row.Notes
			}
			item.Detail = "The required Beehiiv parity-gap record is missing or duplicated. Re-run or repair the source archive before recording cutover review evidence."
			out = append(out, item)
			continue
		}
		item.Actual = row.Imported
		item.Evidence = row.Notes
		out = append(out, applyBeehiivCutoverEvidence(job, item))
	}
	return out
}

func hubSpotCommunicationPreferenceAcceptanceItem(report *canonical.VerificationReport) PilotAcceptanceItem {
	item := PilotAcceptanceItem{
		Key:    "hubspot_communication_preferences",
		Label:  "HubSpot email preference and eligibility projection",
		Status: "blocker",
		Detail: "The final report must prove complete communication-preference and current-primary-email eligibility projections for every email-addressable HubSpot contact.",
	}
	preferenceRow, preferenceOK := resourceByName(report, "communication_preferences")
	eligibilityRow, eligibilityOK := resourceByName(report, "email_eligibility")
	if !preferenceOK || !eligibilityOK {
		item.Detail = "This verification report predates complete HubSpot communication-preference or current-email eligibility coverage. Run a new final full snapshot before cutover."
		return item
	}
	item.Expected = preferenceRow.SourceTotal
	item.Actual = preferenceRow.Imported
	item.Evidence = append(item.Evidence, preferenceRow.Notes...)
	item.Evidence = append(item.Evidence, eligibilityRow.Notes...)
	if preferenceRow.SourceTotal < 0 ||
		preferenceRow.Imported != preferenceRow.SourceTotal ||
		preferenceRow.Imported != report.SubscribersImported {
		item.Detail = "HubSpot communication preferences were not projected for every email-addressable contact in the final snapshot."
		return item
	}
	if eligibilityRow.SourceTotal < 0 ||
		eligibilityRow.Imported != eligibilityRow.SourceTotal ||
		eligibilityRow.Imported != report.SubscribersImported {
		item.Detail = "HubSpot current-primary-email eligibility was not evaluated for every email-addressable contact in the final snapshot."
		return item
	}
	if report.ConsentKnown < 0 || report.ConsentUnknown < 0 || report.ConsentKnown+report.ConsentUnknown != report.SubscribersImported {
		item.Detail = "HubSpot consent-timestamp evidence does not account for every imported contact."
		return item
	}
	item.Status = "pass"
	item.Detail = "Every email-addressable HubSpot contact has complete final-snapshot preference and current-primary-email eligibility projections. Enabled requires SUBSCRIBED across every active email definition with no global/scoped opt-out and no hard-bounce, quarantine, invalid-address, marketing-contact, double-opt-in, or legacy-opt-out restriction. This is conservative import eligibility, not exact HubSpot sendability parity."
	item.Evidence = append(item.Evidence,
		fmt.Sprintf("consent_timestamp_known=%d", report.ConsentKnown),
		fmt.Sprintf("consent_timestamp_unknown=%d", report.ConsentUnknown),
		fmt.Sprintf("preference_projection_covered=%d", preferenceRow.Imported),
		fmt.Sprintf("current_email_eligibility_covered=%d", eligibilityRow.Imported),
		fmt.Sprintf("suppression_list_size=%d", report.SuppressionListSize),
	)
	return item
}

func hubSpotCRMBridgeScopeReviewAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	resources := []string{
		"non_email_profiles",
		"additional_email_identities",
		"contact_property_definitions",
		"dynamic_list_predicates",
		"automations",
		"campaigns",
		"templates",
		"reports",
		"forms",
		"landing",
		"ecommerce",
		"sms",
		"custom_objects",
		"other_crm_objects",
	}
	item := PilotAcceptanceItem{
		Key:      hubSpotCRMBridgeScopeReviewKey,
		Label:    "HubSpot CRM-bridge scope review",
		Status:   "blocker",
		Expected: len(resources),
		Detail:   "After the final full snapshot, review excluded non-email/additional-email identities, non-materialized contact-property definitions, and dynamic-list predicates, then inventory HubSpot workflows, marketing email/archive, templates, reports, forms, landing pages, ecommerce, SMS, custom objects, and other CRM objects. Rebuild, export, retain in HubSpot, or explicitly retire every dependency before cutover.",
	}
	for _, resource := range resources {
		row, ok := resourceByName(report, resource)
		if !ok {
			item.Evidence = append(item.Evidence, "missing_static_scope_row="+resource)
			continue
		}
		item.Actual++
		item.Evidence = append(item.Evidence, row.Notes...)
	}
	if item.Actual != item.Expected {
		item.Detail = "This verification report predates the complete HubSpot CRM-bridge scope checklist. Run a new final full snapshot before recording scope approval."
		return item
	}
	return applyHubSpotCutoverEvidence(job, item)
}

func klaviyoCutoverAcceptanceItems(job *canonical.MigrationJob, report *canonical.VerificationReport) []PilotAcceptanceItem {
	items := make([]PilotAcceptanceItem, 0, 6)

	consentTotal := report.ConsentKnown + report.ConsentUnknown
	consent := PilotAcceptanceItem{
		Key:      klaviyoConsentSuppressionReviewKey,
		Label:    "Klaviyo consent and suppression review",
		Status:   "blocker",
		Expected: consentTotal,
		Actual:   report.ConsentKnown,
		Detail:   "After final delta, reconcile Klaviyo email marketing consent, global suppressions, list suppressions, double-opt-in evidence, Multi-Email Profile secondary addresses with independent per-address consent, and any retained non-email channel consent before enabling sends.",
		Evidence: []string{fmt.Sprintf("suppression_list_size=%d", report.SuppressionListSize)},
	}
	if consentTotal == 0 {
		consent.Status = "pass"
		consent.Detail = "No email-addressable Klaviyo profiles were imported."
	} else {
		consent = applyKlaviyoCutoverEvidence(job, consent)
	}
	items = append(items, consent)

	audienceRow, hasAudience := resourceByName(report, "segments")
	audience := PilotAcceptanceItem{
		Key:    klaviyoAudienceSnapshotReviewKey,
		Label:  "Klaviyo audience snapshot and rule rebuild",
		Status: "pass",
		Detail: "No Klaviyo lists or dynamic segments were detected.",
	}
	if hasAudience && audienceRow.SourceTotal > 0 {
		audience.Status = "blocker"
		audience.Expected = audienceRow.SourceTotal
		audience.Actual = audienceRow.Imported
		audience.Detail = "Verify every final list/segment snapshot of enumerated membership after validated list-level suppressions are excluded, and rebuild or retire every Klaviyo dynamic audience rule before cutover. These are send-targetable projections rather than raw membership totals, and snapshots do not keep evaluating Klaviyo predicates."
		audience.Evidence = audienceRow.Notes
		if audienceRow.Imported == audienceRow.SourceTotal {
			audience = applyKlaviyoCutoverEvidence(job, audience)
		}
	}
	items = append(items, audience)

	flowRow, hasFlows := resourceByName(report, "automations")
	flows := PilotAcceptanceItem{
		Key:    klaviyoFlowRebuildReviewKey,
		Label:  "Klaviyo flow rebuild and retirement",
		Status: "pass",
		Detail: "No Klaviyo flows were detected.",
	}
	if hasFlows && flowRow.SourceTotal > 0 {
		flows.Status = "blocker"
		flows.Expected = flowRow.SourceTotal
		flows.Actual = flowRow.Imported
		flows.Detail = "Rebuild and test required flows natively, then pause/retire their Klaviyo counterparts with ownership and timestamp evidence before activating destination automations. Preserved definitions are never executable imports."
		flows.Evidence = append([]string(nil), flowRow.Notes...)
		if !automationRebuildsPassed(report) {
			flows.Evidence = append(flows.Evidence, pendingAutomationRebuildEvidence(ensureAutomationRebuilds(report))...)
		} else if flowRow.Imported == flowRow.SourceTotal {
			flows = applyKlaviyoCutoverEvidence(job, flows)
		}
	}
	items = append(items, flows)

	channelRow, _ := resourceByName(report, "omni_channels")
	channel := PilotAcceptanceItem{
		Key:      klaviyoChannelIdentityReviewKey,
		Label:    "Klaviyo non-email channel identity review",
		Status:   "blocker",
		Expected: channelRow.SourceTotal,
		Actual:   channelRow.Imported,
		Detail:   "Inventory phone-only/push-only identities and SMS, push, WhatsApp, and RCS consent/sender state. Migrate or explicitly retain/retire each channel before cutover; profile evidence alone does not activate those channels.",
		Evidence: channelRow.Notes,
	}
	items = append(items, applyKlaviyoCutoverEvidence(job, channel))

	deliverabilityRow, _ := resourceByName(report, "deliverability")
	deliverability := PilotAcceptanceItem{
		Key:      klaviyoDeliverabilityReviewKey,
		Label:    "Klaviyo deliverability cutover",
		Status:   "blocker",
		Expected: deliverabilityRow.SourceTotal,
		Actual:   deliverabilityRow.Imported,
		Detail:   "Verify destination sending domains, DNS, branded tracking, SSL, dedicated-IP routing/warmup, suppression continuity, and rollback ownership before moving production traffic.",
		Evidence: deliverabilityRow.Notes,
	}
	items = append(items, applyKlaviyoCutoverEvidence(job, deliverability))

	dependencyResources := []string{"campaign_rebuilds", "structured_templates", "forms", "multi_email_profiles", "ecommerce", "reviews", "service", "cdp", "marketplace", "reports"}
	dependencies := PilotAcceptanceItem{
		Key:    klaviyoEcosystemDependenciesReviewKey,
		Label:  "Klaviyo ecosystem dependency review",
		Status: "blocker",
		Detail: "Review non-sent campaigns, structured templates, forms, Multi-Email Profile secondary identities, reporting retention, commerce/review/service/CDP dependencies, and installed apps. Rebuild, export, retain Klaviyo access, or explicitly retire each dependency before cutover.",
	}
	for _, resource := range dependencyResources {
		if row, ok := resourceByName(report, resource); ok {
			dependencies.Expected += row.SourceTotal
			dependencies.Actual += row.Imported
			dependencies.Evidence = append(dependencies.Evidence, row.Notes...)
		}
	}
	items = append(items, applyKlaviyoCutoverEvidence(job, dependencies))
	return items
}

func customerIOCutoverAcceptanceItems(job *canonical.MigrationJob, report *canonical.VerificationReport) []PilotAcceptanceItem {
	if report == nil {
		return nil
	}
	exactSnapshot := customerIOExactSnapshotComplete(report)
	apply := func(item PilotAcceptanceItem) PilotAcceptanceItem {
		if !exactSnapshot {
			item.Evidence = append(item.Evidence, "The Customer.io verification report does not prove exact subscriber, audience, editable-template, sent-newsletter, and source-archive coverage; rerun the final delta before recording approval.")
			return item
		}
		return applyCustomerIOCutoverEvidence(job, item)
	}

	consentTotal := report.ConsentKnown + report.ConsentUnknown
	consent := PilotAcceptanceItem{
		Key:      customerIOConsentSubscriptionReviewKey,
		Label:    "Customer.io consent, subscription, and suppression review",
		Status:   "blocker",
		Expected: consentTotal,
		Actual:   report.ConsentKnown,
		Detail:   "After the final delta, prove email is enabled only when global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default, and the applicable topic is subscribed explicitly or by configured default. Reconcile ESP suppressions and any explicit consent proof; profile creation time never authorizes sending. Subscription-center channel preferences apply by channel type, while /v1/optouts contains separate sender-specific SMS/WhatsApp evidence.",
		Evidence: []string{fmt.Sprintf("suppression_list_size=%d", report.SuppressionListSize)},
	}

	identityExpected, identityActual, identityEvidence := customerIOResourceSummary(report, "subscribers", "segments", "non_email_profiles", "subscription_topics")
	identity := PilotAcceptanceItem{
		Key:      customerIOIdentityAudienceReviewKey,
		Label:    "Customer.io identity and audience cutover",
		Status:   "blocker",
		Expected: identityExpected,
		Actual:   identityActual,
		Detail:   "Verify immutable `cio_id` ownership, duplicate-email profiles, email moves, hard deletions, final segment/topic membership snapshots, and rebuild or retire every dynamic audience rule before enabling sends.",
		Evidence: identityEvidence,
	}

	automationExpected, automationActual, automationEvidence := customerIOResourceSummary(report, "workflow_definitions", "transactional", "templates", "structured_templates")
	automations := PilotAcceptanceItem{
		Key:      customerIOAutomationRebuildReviewKey,
		Label:    "Customer.io automation and transactional rebuild",
		Status:   "blocker",
		Expected: automationExpected,
		Actual:   automationActual,
		Detail:   "Rebuild and test every required campaign, API broadcast, action graph, transactional trigger, and Design Studio dependency, then record source retirement ownership. Preserved definitions are never executable imports.",
		Evidence: automationEvidence,
	}

	channelExpected, channelActual, channelEvidence := customerIOResourceSummary(report, "non_email_profiles", "channel_dependencies", "consent_exclusions")
	channels := PilotAcceptanceItem{
		Key:      customerIOChannelDependencyReviewKey,
		Label:    "Customer.io non-email channel dependency review",
		Status:   "blocker",
		Expected: channelExpected,
		Actual:   channelActual,
		Detail:   "Inventory SMS, push, in-app, Slack, WhatsApp, webhook, phone/device identities, sender registrations, consent, quiet hours, and routing. Migrate, retain, or explicitly retire each dependency before cutover.",
		Evidence: channelEvidence,
	}

	deliverabilityExpected, deliverabilityActual, deliverabilityEvidence := customerIOResourceSummary(report, "deliverability")
	deliverability := PilotAcceptanceItem{
		Key:      customerIODeliverabilityReviewKey,
		Label:    "Customer.io deliverability cutover",
		Status:   "blocker",
		Expected: deliverabilityExpected,
		Actual:   deliverabilityActual,
		Detail:   "Verify destination domains, DNS, sender identities, branded links, SSL, dedicated-IP routing and warmup, bounce/complaint handling, suppression continuity, and rollback ownership before moving traffic.",
		Evidence: deliverabilityEvidence,
	}

	ecosystemExpected, ecosystemActual, ecosystemEvidence := customerIOResourceSummary(report, "custom_objects", "ecosystem", "source_archive")
	ecosystem := PilotAcceptanceItem{
		Key:      customerIOEcosystemDependenciesReviewKey,
		Label:    "Customer.io ecosystem dependency review",
		Status:   "blocker",
		Expected: ecosystemExpected,
		Actual:   ecosystemActual,
		Detail:   "Review custom objects, reporting webhooks, events and Data Pipelines, connected destinations, forms, commerce, snippets/assets, retained analytics/export access, and every external trigger or integration. Rebuild, retain, export, or explicitly retire each dependency.",
		Evidence: ecosystemEvidence,
	}

	return []PilotAcceptanceItem{
		apply(consent),
		apply(identity),
		apply(automations),
		apply(channels),
		apply(deliverability),
		apply(ecosystem),
	}
}

func customerIOExactSnapshotComplete(report *canonical.VerificationReport) bool {
	if report == nil {
		return false
	}
	for _, resource := range []string{"subscribers", "segments", "templates", "campaigns", "source_archive"} {
		row, ok := resourceByName(report, resource)
		if !ok || row.SourceTotal < 0 || row.Imported != row.SourceTotal {
			return false
		}
	}
	return true
}

func customerIOResourceSummary(report *canonical.VerificationReport, resources ...string) (int, int, []string) {
	expected := 0
	actual := 0
	evidence := make([]string, 0, len(resources))
	for _, resource := range resources {
		row, ok := resourceByName(report, resource)
		if !ok {
			evidence = append(evidence, resource+"=missing")
			continue
		}
		expected += row.SourceTotal
		actual += row.Imported
		evidence = append(evidence, fmt.Sprintf("%s=%d/%d (%s)", resource, row.Imported, row.SourceTotal, row.Status))
	}
	return expected, actual, evidence
}

func beehiivCampaignFidelityAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	partial := make([]canonical.ResourceWarning, 0, len(report.CampaignArchiveWarnings))
	for _, warning := range report.CampaignArchiveWarnings {
		if strings.TrimSpace(warning.Warning) == "Beehiiv does not expose a plain-text rendering for posts; the archived text body is empty." {
			continue
		}
		partial = append(partial, warning)
	}
	item := PilotAcceptanceItem{
		Key:    "beehiiv_campaign_archive_fidelity",
		Label:  "Beehiiv campaign archive content fidelity",
		Status: "pass",
		Detail: "Every imported Beehiiv campaign has expanded HTML; Beehiiv does not expose a separate plain-text rendering.",
	}
	if len(partial) > 0 {
		item.Status = "blocker"
		item.Expected = 0
		item.Actual = len(partial)
		item.Detail = "One or more Beehiiv campaign archive entries lack the expected expanded HTML or require premium-content review. Fix the archive or record explicit post-delta review before cutover."
		item.Evidence = resourceWarningEvidence(partial)
	}
	return applyBeehiivCutoverEvidence(job, item)
}

func (r *PilotAcceptanceReport) add(item PilotAcceptanceItem) {
	if item.Status == "" {
		item.Status = "pass"
	}
	r.Items = append(r.Items, item)
	switch item.Status {
	case "blocker":
		r.Blockers++
	case "warning":
		r.Warnings++
	}
}

func (r *PilotAcceptanceReport) finish() {
	switch {
	case r.Blockers > 0:
		r.Status = "blocker"
	case r.Warnings > 0:
		r.Status = "warning"
	default:
		r.Status = "pass"
	}
}

func (r *PilotAcceptanceReport) recount() {
	r.Blockers = 0
	r.Warnings = 0
	for _, item := range r.Items {
		switch item.Status {
		case "blocker":
			r.Blockers++
		case "warning":
			r.Warnings++
		}
	}
	r.finish()
}

func contactAcceptanceItem(report *canonical.VerificationReport) PilotAcceptanceItem {
	row, ok := resourceByName(report, "subscribers")
	if ok {
		status := "pass"
		detail := "Contacts imported exactly."
		if row.SourceTotal > row.Imported {
			status = "blocker"
			detail = "Contact counts do not match the source inventory."
		}
		return PilotAcceptanceItem{
			Key:      "contacts",
			Label:    "Contacts",
			Status:   status,
			Expected: row.SourceTotal,
			Actual:   row.Imported,
			Detail:   detail,
		}
	}
	status := "pass"
	if report.SubscribersImported == 0 {
		status = "warning"
	}
	return PilotAcceptanceItem{
		Key:    "contacts",
		Label:  "Contacts",
		Status: status,
		Actual: report.SubscribersImported,
		Detail: "Legacy report did not include source contact totals.",
	}
}

func resourceAcceptanceItem(report *canonical.VerificationReport, resource, label string) PilotAcceptanceItem {
	row, ok := resourceByName(report, resource)
	if !ok || row.SourceTotal == 0 {
		return PilotAcceptanceItem{Key: resource, Label: label, Status: "pass", Detail: "No source records detected."}
	}
	status := "pass"
	detail := "Resource imported."
	if row.Status == "partial" || row.Status == "partial_runtime" || row.Status == "manual_rebuild_required" || row.Status == "preserved_for_rebuild" || row.SourceTotal > row.Imported {
		status = "warning"
		detail = "Some records require manual review before cutover."
	}
	if row.Status == "not_supported" || !row.Supported {
		status = "blocker"
		detail = "Source records exist but this resource is not supported yet."
	}
	return PilotAcceptanceItem{
		Key:      resource,
		Label:    label,
		Status:   status,
		Expected: row.SourceTotal,
		Actual:   row.Imported,
		Detail:   detail,
		Evidence: row.Notes,
	}
}

func automationAcceptanceItem(report *canonical.VerificationReport) PilotAcceptanceItem {
	rebuilds := ensureAutomationRebuilds(report)
	if len(rebuilds) == 0 {
		return PilotAcceptanceItem{Key: "top_automations", Label: "Top automation rebuilds", Status: "pass", Detail: "No unsupported automations were detected."}
	}
	if automationRebuildsPassed(report) {
		return PilotAcceptanceItem{Key: "top_automations", Label: "Top automation rebuilds", Status: "pass", Actual: len(rebuilds), Detail: "All tracked rebuilds are test-passed or explicitly approved as not needed."}
	}
	pending := []string{}
	for _, item := range rebuilds {
		if !automationRebuildPassStatuses[item.Status] {
			pending = append(pending, fmt.Sprintf("#%d %s (%s)", item.Rank, item.Name, item.Status))
			continue
		}
		if !automationRebuildItemPassed(item) {
			pending = append(pending, fmt.Sprintf("#%d %s (%s; missing test evidence)", item.Rank, item.Name, item.Status))
		}
	}
	return PilotAcceptanceItem{
		Key:      "top_automations",
		Label:    "Top automation rebuilds",
		Status:   "blocker",
		Expected: len(rebuilds),
		Actual:   len(rebuilds) - len(pending),
		Detail:   "Unsupported source automations must be rebuilt and test-passed before customer cutover.",
		Evidence: pending,
	}
}

func beehiivAutomationRetirementAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	row, ok := resourceByName(report, "automations")
	if !ok {
		return PilotAcceptanceItem{
			Key:    beehiivAutomationRetirementReviewKey,
			Label:  "Beehiiv source-automation retirement",
			Status: "blocker",
			Detail: "The verification report predates source-automation retirement evidence. Re-run the final delta before cutover.",
		}
	}
	if row.SourceTotal == 0 {
		return PilotAcceptanceItem{Key: beehiivAutomationRetirementReviewKey, Label: "Beehiiv source-automation retirement", Status: "pass", Detail: "No source automations were detected."}
	}
	item := PilotAcceptanceItem{
		Key:      beehiivAutomationRetirementReviewKey,
		Label:    "Beehiiv source-automation retirement",
		Status:   "warning",
		Expected: row.SourceTotal,
		Actual:   row.Imported,
		Detail:   "Before any rebuilt Moosewave automation is activated, inventory every running Beehiiv automation, pause or retire it, capture the final journey snapshot, and attach post-final-delta ownership/timestamp evidence (or an explicit no-activation waiver).",
		Evidence: row.Notes,
	}
	return applyBeehiivCutoverEvidence(job, item)
}

func unsupportedResourceAcceptanceItems(source canonical.SourcePlatform, report *canonical.VerificationReport) []PilotAcceptanceItem {
	out := []PilotAcceptanceItem{}
	for _, row := range report.ResourceCompleteness {
		if row.SourceTotal == 0 || row.Supported {
			continue
		}
		if source == canonical.SourceBeehiiv && (row.Resource == "forms" || row.Resource == "landing") {
			// These two views share one API-unexportable website/capture parity
			// record and are enforced by the dedicated post-delta evidence gate.
			continue
		}
		if source == canonical.SourceKlaviyo && klaviyoDedicatedReviewResource(row.Resource) {
			continue
		}
		if source == canonical.SourceCustomerIO && customerIODedicatedReviewResource(row.Resource) {
			continue
		}
		if source == canonical.SourceHubSpot && hubSpotDedicatedScopeReviewResource(row.Resource) {
			continue
		}
		unsupported := row.Status == "not_supported"
		if source == canonical.SourceBeehiiv {
			unsupported = unsupported || row.Status == "manual_rebuild_required" || row.Status == "preserved_for_rebuild"
		}
		if !unsupported {
			continue
		}
		if row.Resource == "sms" {
			continue
		}
		if emailSMSPilotWaivedResource(row.Resource) {
			continue
		}
		out = append(out, PilotAcceptanceItem{
			Key:      "unsupported_" + row.Resource,
			Label:    row.Label,
			Status:   "blocker",
			Expected: row.SourceTotal,
			Actual:   row.Imported,
			Detail:   "Source has production data here. Mark it archived/manual-review or implement support before full cutover.",
			Evidence: row.Notes,
		})
	}
	return out
}

func hubSpotDedicatedScopeReviewResource(resource string) bool {
	switch resource {
	case "non_email_profiles", "additional_email_identities", "contact_property_definitions", "dynamic_list_predicates", "automations", "campaigns", "templates", "reports", "forms", "landing", "ecommerce", "sms", "custom_objects", "other_crm_objects":
		return true
	default:
		return false
	}
}

func klaviyoDedicatedReviewResource(resource string) bool {
	switch resource {
	case "non_email_profiles", "multi_email_profiles", "non_email_campaigns", "campaign_rebuilds", "structured_templates", "forms", "ecommerce", "reviews", "service", "cdp", "omni_channels", "deliverability", "marketplace", "reports":
		return true
	default:
		return false
	}
}

func customerIODedicatedReviewResource(resource string) bool {
	switch resource {
	case "non_email_profiles", "channel_dependencies":
		return true
	default:
		return false
	}
}

func emailSMSPilotWaivedResource(resource string) bool {
	switch resource {
	case "crm", "custom_objects", "ecommerce":
		// First-customer scope is email + SMS with HubSpot as CRM system of
		// record. These resources must stay visible in the parity report, but
		// they do not block Moosewave send cutover unless a live journey depends
		// on them.
		return true
	default:
		return false
	}
}

func smsAcceptanceItem(job *canonical.MigrationJob, report *canonical.VerificationReport) PilotAcceptanceItem {
	row, ok := resourceByName(report, "sms")
	if !ok || row.SourceTotal == 0 {
		return PilotAcceptanceItem{Key: "sms_readiness", Label: "SMS readiness", Status: "pass", Detail: "No SMS source inventory detected in this migration report."}
	}
	item := PilotAcceptanceItem{
		Key:      "sms_readiness",
		Label:    "SMS readiness",
		Status:   "blocker",
		Expected: row.SourceTotal,
		Actual:   row.Imported,
		Detail:   "SMS usage was detected. Pass `/api/v1/sms/pilot-readiness` before limited live pilot.",
		Evidence: row.Notes,
	}
	if job != nil && job.Source == canonical.SourceActiveCampaign {
		return applyActiveCampaignCutoverEvidence(job, item)
	}
	return item
}

func rollbackRehearsalAcceptanceItem(job *canonical.MigrationJob) PilotAcceptanceItem {
	rehearsal := BuildRollbackRehearsalReport(job, time.Now().UTC())
	status := rehearsal.Status
	if status == "warning" {
		status = "warning"
	}
	item := PilotAcceptanceItem{
		Key:      "rollback_rehearsal",
		Label:    "Rollback rehearsal",
		Status:   status,
		Expected: rehearsal.TotalResources,
		Actual:   rehearsal.TotalResources,
		Detail:   "Rollback delete order and rollback window were rehearsed from tracked migration resources.",
	}
	if job == nil || !strictRollbackRehearsalSource(job.Source) {
		return item
	}
	evidenceStatus, generatedAt, ok, err := rollbackRehearsalEvidence(job)
	if !ok {
		item.Status = "blocker"
		item.Actual = 0
		item.Detail = rollbackRehearsalMissingEvidenceDetail(job.Source)
		return item
	}
	if err != nil {
		item.Status = "blocker"
		item.Detail = rollbackRehearsalInvalidEvidenceDetail(job.Source)
		item.Evidence = []string{
			"status=" + sanitizeMigrationText(job.Source, evidenceStatus),
			sanitizeMigrationText(job.Source, err.Error()),
		}
		return item
	}
	item.Evidence = []string{
		"status=" + evidenceStatus,
		"generated_at=" + generatedAt.UTC().Format(time.RFC3339),
	}
	if total, ok := cursorString(job.Cursor, rollbackRehearsalTotalKey); ok {
		item.Evidence = append(item.Evidence, "total_resources="+total)
	}
	countSource, hasCountSource := cursorString(job.Cursor, rollbackRehearsalSourceKey)
	if hasCountSource {
		item.Evidence = append(item.Evidence, "count_source="+countSource)
	}
	validation, hasValidation := cursorString(job.Cursor, rollbackRehearsalValidationKey)
	if hasValidation {
		item.Evidence = append(item.Evidence, "destination_validation="+validation)
	}
	if job.CompletedAt != nil && generatedAt.Before(job.CompletedAt.UTC()) {
		item.Status = "blocker"
		item.Detail = rollbackRehearsalStaleEvidenceDetail(job.Source)
		return item
	}
	if evidenceStatus != "pass" {
		item.Status = "blocker"
		item.Detail = rollbackRehearsalFailedEvidenceDetail(job.Source)
		return item
	}
	if !hasCountSource || countSource != "imported_resource_ledger" {
		item.Status = "blocker"
		item.Detail = rollbackRehearsalLedgerEvidenceDetail(job.Source)
		return item
	}
	if !hasValidation || validation != rollbackRehearsalValidationV1 {
		item.Status = "blocker"
		item.Detail = "Run rollback rehearsal again so current destination ownership and tracked after-images are conflict-checked before cutover."
		return item
	}
	return item
}

func rollbackRehearsalMissingEvidenceDetail(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceActiveCampaign:
		return "Run rollback rehearsal after the final delta import and preserve the rehearsal evidence before ActiveCampaign cutover."
	case canonical.SourceHubSpot:
		return "Run rollback rehearsal after the latest HubSpot bridge import and preserve the rehearsal evidence before bridge acceptance."
	case canonical.SourceBeehiiv:
		return "Run rollback rehearsal after the latest Beehiiv final delta import and preserve the rehearsal evidence before cutover."
	case canonical.SourceKlaviyo:
		return "Run rollback rehearsal after the latest Klaviyo final delta import and preserve the rehearsal evidence before cutover."
	case canonical.SourceCustomerIO:
		return "Run rollback rehearsal after the latest Customer.io final delta import and preserve the rehearsal evidence before cutover."
	default:
		return "Run rollback rehearsal after the latest import and preserve the rehearsal evidence before cutover."
	}
}

func rollbackRehearsalInvalidEvidenceDetail(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceHubSpot:
		return "Rollback rehearsal evidence could not be parsed. Re-run rollback rehearsal after the latest HubSpot bridge import."
	case canonical.SourceBeehiiv:
		return "Rollback rehearsal evidence could not be parsed. Re-run rollback rehearsal after the latest Beehiiv final delta import."
	case canonical.SourceKlaviyo:
		return "Rollback rehearsal evidence could not be parsed. Re-run rollback rehearsal after the latest Klaviyo final delta import."
	case canonical.SourceCustomerIO:
		return "Rollback rehearsal evidence could not be parsed. Re-run rollback rehearsal after the latest Customer.io final delta import."
	default:
		return "Rollback rehearsal evidence could not be parsed. Re-run rollback rehearsal after final delta import."
	}
}

func rollbackRehearsalStaleEvidenceDetail(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceHubSpot:
		return "Rollback rehearsal evidence predates the latest completed HubSpot bridge import. Re-run rollback rehearsal after the latest bridge import."
	case canonical.SourceBeehiiv:
		return "Rollback rehearsal evidence predates the latest completed Beehiiv final delta import. Re-run rollback rehearsal after the latest final delta."
	case canonical.SourceKlaviyo:
		return "Rollback rehearsal evidence predates the latest completed Klaviyo final delta import. Re-run rollback rehearsal after the latest final delta."
	case canonical.SourceCustomerIO:
		return "Rollback rehearsal evidence predates the latest completed Customer.io final delta import. Re-run rollback rehearsal after the latest final delta."
	default:
		return "Rollback rehearsal evidence predates the latest completed import. Re-run rollback rehearsal after final delta import."
	}
}

func rollbackRehearsalFailedEvidenceDetail(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceHubSpot:
		return "The latest recorded rollback rehearsal did not pass. Fix rollback blockers and re-run rehearsal before HubSpot bridge acceptance."
	case canonical.SourceBeehiiv:
		return "The latest recorded rollback rehearsal did not pass. Fix rollback blockers and re-run rehearsal before Beehiiv cutover."
	case canonical.SourceKlaviyo:
		return "The latest recorded rollback rehearsal did not pass. Fix rollback blockers and re-run rehearsal before Klaviyo cutover."
	case canonical.SourceCustomerIO:
		return "The latest recorded rollback rehearsal did not pass. Fix rollback blockers and re-run rehearsal before Customer.io cutover."
	default:
		return "The latest recorded rollback rehearsal did not pass. Fix rollback blockers and re-run rehearsal before ActiveCampaign cutover."
	}
}

func rollbackRehearsalLedgerEvidenceDetail(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceActiveCampaign:
		return "ActiveCampaign rollback rehearsal must pass using the durable imported-resource ledger, not job progress counters. Re-run rollback rehearsal on the Postgres-backed migration service."
	case canonical.SourceHubSpot:
		return "HubSpot bridge rollback rehearsal must pass using the durable imported-resource ledger, not job progress counters. Re-run rollback rehearsal on the Postgres-backed migration service."
	case canonical.SourceBeehiiv:
		return "Beehiiv rollback rehearsal must pass using the durable imported-resource ledger, not job progress counters. Re-run rollback rehearsal on the Postgres-backed migration service."
	case canonical.SourceKlaviyo:
		return "Klaviyo rollback rehearsal must pass using the durable imported-resource ledger, not job progress counters. Re-run rollback rehearsal on the Postgres-backed migration service."
	case canonical.SourceCustomerIO:
		return "Customer.io rollback rehearsal must pass using the durable imported-resource ledger, not job progress counters. Re-run rollback rehearsal on the Postgres-backed migration service."
	default:
		return "Rollback rehearsal must pass using the durable imported-resource ledger, not job progress counters. Re-run rollback rehearsal on the Postgres-backed migration service."
	}
}

func rollbackRehearsalEvidence(job *canonical.MigrationJob) (string, time.Time, bool, error) {
	if job == nil || job.Cursor == nil {
		return "", time.Time{}, false, nil
	}
	status, ok := cursorString(job.Cursor, rollbackRehearsalStatusKey)
	if !ok || strings.TrimSpace(status) == "" {
		return "", time.Time{}, false, nil
	}
	generatedRaw, ok := cursorString(job.Cursor, rollbackRehearsalAtKey)
	if !ok || strings.TrimSpace(generatedRaw) == "" {
		return strings.TrimSpace(status), time.Time{}, true, fmt.Errorf("rollback rehearsal generated_at is missing")
	}
	generatedAt, err := time.Parse(time.RFC3339, strings.TrimSpace(generatedRaw))
	if err != nil {
		return strings.TrimSpace(status), time.Time{}, true, fmt.Errorf("rollback rehearsal generated_at %q is invalid: %w", generatedRaw, err)
	}
	return strings.TrimSpace(status), generatedAt.UTC(), true, nil
}

func resourceByName(report *canonical.VerificationReport, resource string) (canonical.ResourceCompleteness, bool) {
	if report == nil {
		return canonical.ResourceCompleteness{}, false
	}
	for _, row := range report.ResourceCompleteness {
		if strings.EqualFold(row.Resource, resource) {
			return row, true
		}
	}
	return canonical.ResourceCompleteness{}, false
}
