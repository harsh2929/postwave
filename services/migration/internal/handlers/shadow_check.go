package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

type shadowCheckResponse struct {
	JobID               string                   `json:"job_id"`
	Source              canonical.SourcePlatform `json:"source"`
	GeneratedAt         time.Time                `json:"generated_at"`
	AttemptToken        string                   `json:"attempt_token,omitempty"`
	ImportEpoch         string                   `json:"import_epoch,omitempty"`
	BaselineFingerprint string                   `json:"baseline_fingerprint,omitempty"`
	Error               string                   `json:"error,omitempty"`
	Warnings            []string                 `json:"warnings,omitempty"`
	CurrentDiscovery    map[string]int           `json:"current_discovery"`
	NeedsDeltaImport    bool                     `json:"needs_delta_import"`
	RecommendedAction   string                   `json:"recommended_action"`
	Blockers            []string                 `json:"blockers,omitempty"`
	Deltas              []shadowResourceDelta    `json:"deltas"`
}

const shadowAttemptTokenCursorKey = "__postwave_shadow_attempt_token"

type shadowResourceDelta struct {
	Resource    string   `json:"resource"`
	Label       string   `json:"label"`
	SourceTotal int      `json:"source_total"`
	Imported    int      `json:"imported"`
	Delta       int      `json:"delta"`
	Status      string   `json:"status"`
	Supported   bool     `json:"supported"`
	CutoverRisk string   `json:"cutover_risk"`
	Notes       []string `json:"notes,omitempty"`
}

// ShadowCheck reruns source discovery for an already-connected migration job
// and compares the current source totals with the latest verification report.
// Beehiiv, Klaviyo, and Customer.io additionally compare bounded full-source
// fingerprints so a same-count mutation cannot appear unchanged.
// It is designed for the first-customer shadow window: keep the source
// platform live, run this daily, and only cut over when deltas are understood.
func (h *Migration) ShadowCheck(w http.ResponseWriter, r *http.Request) {
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}

	var body struct {
		JobID string `json:"job_id"`
	}
	if err := decodeRequestJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	resp, err := h.runShadowCheck(r.Context(), tenantID, source, body.JobID)
	if err != nil {
		writeErr(w, statusForShadowErr(err), sanitizeMigrationError(source, err))
		return
	}
	resp = sanitizeShadowCheckResponse(source, resp)
	writeJSON(w, http.StatusOK, resp)
}

func (h *Migration) runShadowCheck(ctx context.Context, tenantID string, source canonical.SourcePlatform, jobID string) (resp shadowCheckResponse, err error) {
	executionLease, err := h.acquireJobExecution(ctx, tenantID, jobID)
	if err != nil {
		return shadowCheckResponse{}, err
	}
	resp, checkErr, persistErr, releaseErr := h.runPersistedShadowCheckUnderExecutionLease(ctx, tenantID, source, jobID, executionLease)
	return resp, errors.Join(checkErr, persistErr, releaseErr)
}

// runPersistedShadowCheckUnderExecutionLease owns and releases executionLease.
// It durably supersedes any older ready result with a fail-closed sentinel
// before provider reads begin. The completed result is persisted only after the
// execution lease release is known, so a process death, persistence failure, or
// lease-release error cannot leave a ready result from this attempt as latest.
func (h *Migration) runPersistedShadowCheckUnderExecutionLease(ctx context.Context, tenantID string, source canonical.SourcePlatform, jobID string, executionLease *orchestrator.MigrationExecutionLease) (resp shadowCheckResponse, checkErr, persistErr, releaseErr error) {
	// A result row cannot reference a missing job. Preserve the ordinary 404
	// contract without attempting provider work or manufacturing orphan history.
	job, err := h.loadJob(ctx, tenantID, jobID)
	if err == nil && job.Source != source {
		err = fmt.Errorf("job source %q does not match route source %q", job.Source, source)
	}
	if err == nil {
		err = requireCompletedShadowJob(job)
	}
	if err == nil {
		err = activeCampaignPostPilotCleanupFreezeError(job, "shadow check")
	}
	if err != nil {
		if executionLease != nil {
			releaseErr = executionLease.Release()
		}
		if releaseErr != nil {
			releaseErr = fmt.Errorf("release shadow-check job execution lease: %w", releaseErr)
		}
		return shadowCheckResponse{}, err, nil, releaseErr
	}

	attemptToken, err := h.rotateShadowAttemptToken(ctx, job)
	if err != nil {
		if executionLease != nil {
			releaseErr = executionLease.Release()
		}
		if releaseErr != nil {
			releaseErr = fmt.Errorf("release shadow-check job execution lease: %w", releaseErr)
		}
		return shadowCheckResponse{}, fmt.Errorf("persist shadow-check attempt identity: %w", err), nil, releaseErr
	}

	started := shadowAttemptStartedResponse(jobID, source)
	started.AttemptToken = attemptToken
	if err := h.persistShadowCheck(ctx, tenantID, started); err != nil {
		persistErr = fmt.Errorf("persist shadow-check attempt start: %w", err)
	} else {
		resp, checkErr = h.runShadowCheckUnderLease(ctx, tenantID, source, jobID)
	}
	resp.AttemptToken = attemptToken

	// Release before publishing the completed result. Until that final row is
	// durable, the start sentinel remains the latest evidence and pilot
	// acceptance stays fail closed.
	if executionLease != nil {
		releaseErr = executionLease.Release()
	}
	if releaseErr != nil {
		releaseErr = fmt.Errorf("release shadow-check job execution lease: %w", releaseErr)
	}

	resp = finalizeShadowAttemptResponse(resp, jobID, source, errors.Join(checkErr, persistErr, releaseErr))
	// GeneratedAt is the provider observation-completion time, not the later
	// persistence time. A delta can acquire the lease after release; moving this
	// timestamp forward would let the pre-delta snapshot masquerade as post-delta
	// evidence. Only repair clocks that did not advance beyond the start marker.
	resp.GeneratedAt = shadowObservationCompletedAt(resp.GeneratedAt, started.GeneratedAt)
	if err := h.persistShadowCheck(ctx, tenantID, resp); err != nil {
		persistErr = errors.Join(persistErr, fmt.Errorf("persist shadow-check completed attempt: %w", err))
		resp = finalizeShadowAttemptResponse(resp, jobID, source, errors.Join(checkErr, persistErr, releaseErr))
		resp.GeneratedAt = nextShadowAttemptTimestamp(resp.GeneratedAt)
		// One bounded correction handles a transient write failure. The original
		// persistence error still propagates even when this correction succeeds.
		if retryErr := h.persistShadowCheck(ctx, tenantID, resp); retryErr != nil {
			persistErr = errors.Join(persistErr, fmt.Errorf("persist shadow-check failure correction: %w", retryErr))
		}
	}
	return resp, checkErr, persistErr, releaseErr
}

func (h *Migration) rotateShadowAttemptToken(ctx context.Context, job *canonical.MigrationJob) (string, error) {
	if job == nil || job.Status != canonical.MigCompleted {
		return "", fmt.Errorf("shadow attempt identity requires a completed migration job")
	}
	raw := make([]byte, sha256.Size)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate shadow attempt identity: %w", err)
	}
	token := hex.EncodeToString(raw)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	job.Cursor[shadowAttemptTokenCursorKey] = &token
	if err := h.transitionJob(jobstore.WithTenantID(ctx, job.TenantID), job, canonical.MigCompleted); err != nil {
		return "", err
	}
	return token, nil
}

func shadowAttemptTokenFromJob(job *canonical.MigrationJob) (string, bool, error) {
	if job == nil || job.Cursor == nil || job.Cursor[shadowAttemptTokenCursorKey] == nil {
		return "", false, nil
	}
	token := strings.TrimSpace(*job.Cursor[shadowAttemptTokenCursorKey])
	if !validShadowDigest(token) {
		return "", true, fmt.Errorf("current shadow attempt identity is invalid")
	}
	return token, true, nil
}

func shadowObservationCompletedAt(observedAt, startedAt time.Time) time.Time {
	if observedAt.After(startedAt) {
		return observedAt
	}
	return nextShadowAttemptTimestamp(startedAt)
}

func shadowAttemptStartedResponse(jobID string, source canonical.SourcePlatform) shadowCheckResponse {
	const detail = "shadow check attempt started; no completed result is available"
	return shadowCheckResponse{
		JobID:             jobID,
		Source:            source,
		GeneratedAt:       time.Now().UTC(),
		Error:             detail,
		CurrentDiscovery:  map[string]int{},
		RecommendedAction: "check_failed",
		Blockers:          []string{detail},
		Deltas:            []shadowResourceDelta{},
	}
}

func finalizeShadowAttemptResponse(resp shadowCheckResponse, jobID string, source canonical.SourcePlatform, attemptErr error) shadowCheckResponse {
	resp = ensureShadowResponse(resp, jobID, source)
	if attemptErr == nil {
		return resp
	}
	resp.RecommendedAction = "check_failed"
	resp.Error = sanitizeMigrationErrorText(source, attemptErr)
	return sanitizeShadowCheckResponse(source, resp)
}

func nextShadowAttemptTimestamp(previous time.Time) time.Time {
	now := time.Now().UTC()
	if !now.After(previous) {
		return previous.Add(time.Microsecond)
	}
	return now
}

// runShadowCheckUnderLease executes a check while the caller owns the job
// execution lease. Any history persistence must happen before that lease is
// released so cleanup authorization cannot race a stale shadow result.
func (h *Migration) runShadowCheckUnderLease(ctx context.Context, tenantID string, source canonical.SourcePlatform, jobID string) (resp shadowCheckResponse, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = errors.Join(err, fmt.Errorf("shadow check panic: %v", rec))
			resp = ensureShadowResponse(resp, jobID, source)
		}
	}()
	job, err := h.loadJob(ctx, tenantID, jobID)
	if err != nil {
		return shadowCheckResponse{}, err
	}
	if job.Source != source {
		return shadowCheckResponse{}, fmt.Errorf("job source %q does not match route source %q", job.Source, source)
	}
	if err := requireCompletedShadowJob(job); err != nil {
		return shadowCheckResponse{}, err
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "shadow check"); err != nil {
		return shadowCheckResponse{}, err
	}
	sess, _, err := h.loadCutoverSession(ctx, tenantID, jobID, source, "shadow-check")
	if err != nil {
		return shadowCheckResponse{}, err
	}
	accountExecutionLease, err := h.acquireActiveCampaignSessionExecution(ctx, job, sess)
	if err != nil {
		return shadowCheckResponse{}, err
	}
	defer func() {
		if releaseErr := accountExecutionLease.Release(); releaseErr != nil {
			err = errors.Join(err, fmt.Errorf("release shadow-check account execution lease: %w", releaseErr))
		}
	}()

	var discovery adapter.DiscoveryReport
	var ad adapter.Adapter
	if isLocalDemoSession(sess) {
		discovery = localDemoDiscovery(source)
	} else {
		ad, err = adapter.Get(source)
		if err != nil {
			return shadowCheckResponse{}, err
		}
		discovery, err = ad.Discover(ctx, sess)
		if err != nil {
			return shadowCheckResponse{}, err
		}
	}

	report := canonical.VerificationReport{}
	if job.VerificationReport != nil {
		report = *job.VerificationReport
	}
	deltas, needsDelta, blockers := buildShadowDeltas(job, source, discovery, report)
	importEpoch := ""
	baselineFingerprint := ""
	if source == canonical.SourceBeehiiv {
		baseline, found, fingerprintErr := orchestrator.BeehiivSourceFingerprintFromJob(job)
		if fingerprintErr != nil {
			return shadowCheckResponse{}, fmt.Errorf("load Beehiiv final-delta source fingerprint: %w", fingerprintErr)
		}
		epoch, epochFound, epochErr := orchestrator.BeehiivImportEpochFromJob(job)
		if epochErr != nil {
			return shadowCheckResponse{}, fmt.Errorf("load Beehiiv final-delta import epoch: %w", epochErr)
		}
		if found {
			baselineFingerprint = baseline.Digest
		}
		if epochFound {
			importEpoch = epoch
		}
		if !found {
			blockers = append(blockers, "Beehiiv final-delta source fingerprint is missing; rerun the final delta import before cutover review")
		} else if !epochFound {
			blockers = append(blockers, "Beehiiv final-delta import epoch is missing; rerun the final delta import before cutover review")
		} else if isLocalDemoSession(sess) {
			blockers = append(blockers, "Beehiiv source fingerprint certification requires a credentialed publication; local demo data cannot certify cutover")
		} else {
			current, err := orchestrator.BuildBeehiivSourceFingerprint(ctx, ad, sess, discovery)
			if err != nil {
				return shadowCheckResponse{}, fmt.Errorf("recompute Beehiiv source fingerprint: %w", err)
			}
			fingerprintDeltas, fingerprintChanged, err := beehiivFingerprintShadowDeltas(baseline, current)
			if err != nil {
				return shadowCheckResponse{}, err
			}
			deltas = append(deltas, fingerprintDeltas...)
			needsDelta = needsDelta || fingerprintChanged
		}
	}
	if source == canonical.SourceHubSpot {
		baseline, found, fingerprintErr := orchestrator.HubSpotSourceFingerprintFromJob(job)
		if fingerprintErr != nil {
			return shadowCheckResponse{}, fmt.Errorf("load HubSpot final-delta source fingerprint: %w", fingerprintErr)
		}
		epoch, epochFound, epochErr := orchestrator.HubSpotImportEpochFromJob(job)
		if epochErr != nil {
			return shadowCheckResponse{}, fmt.Errorf("load HubSpot final-delta import epoch: %w", epochErr)
		}
		if found {
			baselineFingerprint = baseline.Digest
		}
		if epochFound {
			importEpoch = epoch
		}
		if !found {
			blockers = append(blockers, "HubSpot final-delta source fingerprint is missing; rerun the final delta import before bridge cutover review")
		} else if !epochFound {
			blockers = append(blockers, "HubSpot final-delta import epoch is missing; rerun the final delta import before bridge cutover review")
		} else if isLocalDemoSession(sess) {
			blockers = append(blockers, "HubSpot source fingerprint certification requires a credentialed portal; local demo data cannot certify bridge cutover")
		} else {
			current, err := orchestrator.BuildHubSpotSourceFingerprint(ctx, ad, sess, discovery)
			if err != nil {
				return shadowCheckResponse{}, fmt.Errorf("recompute HubSpot source fingerprint: %w", err)
			}
			fingerprintDeltas, fingerprintChanged, err := hubSpotFingerprintShadowDeltas(baseline, current)
			if err != nil {
				return shadowCheckResponse{}, err
			}
			deltas = append(deltas, fingerprintDeltas...)
			needsDelta = needsDelta || fingerprintChanged
		}
	}
	if source == canonical.SourceKlaviyo {
		baseline, found, fingerprintErr := orchestrator.KlaviyoSourceFingerprintFromJob(job)
		if fingerprintErr != nil {
			return shadowCheckResponse{}, fmt.Errorf("load Klaviyo final-delta source fingerprint: %w", fingerprintErr)
		}
		epoch, epochFound, epochErr := orchestrator.KlaviyoImportEpochFromJob(job)
		if epochErr != nil {
			return shadowCheckResponse{}, fmt.Errorf("load Klaviyo final-delta import epoch: %w", epochErr)
		}
		if found {
			baselineFingerprint = baseline.Digest
		}
		if epochFound {
			importEpoch = epoch
		}
		if !found {
			blockers = append(blockers, "Klaviyo final-delta source fingerprint is missing; rerun the final delta import before cutover review")
		} else if !epochFound {
			blockers = append(blockers, "Klaviyo final-delta import epoch is missing; rerun the final delta import before cutover review")
		} else if isLocalDemoSession(sess) {
			blockers = append(blockers, "Klaviyo source fingerprint certification requires a credentialed account; local demo data cannot certify cutover")
		} else {
			current, err := orchestrator.BuildKlaviyoSourceFingerprint(ctx, ad, sess, discovery)
			if err != nil {
				return shadowCheckResponse{}, fmt.Errorf("recompute Klaviyo source fingerprint: %w", err)
			}
			fingerprintDeltas, fingerprintChanged, err := klaviyoFingerprintShadowDeltas(baseline, current)
			if err != nil {
				return shadowCheckResponse{}, err
			}
			deltas = append(deltas, fingerprintDeltas...)
			needsDelta = needsDelta || fingerprintChanged
		}
	}
	if source == canonical.SourceCustomerIO {
		baseline, found, fingerprintErr := orchestrator.CustomerIOSourceFingerprintFromJob(job)
		if fingerprintErr != nil {
			return shadowCheckResponse{}, fmt.Errorf("load Customer.io final-delta source fingerprint: %w", fingerprintErr)
		}
		epoch, epochFound, epochErr := orchestrator.CustomerIOImportEpochFromJob(job)
		if epochErr != nil {
			return shadowCheckResponse{}, fmt.Errorf("load Customer.io final-delta import epoch: %w", epochErr)
		}
		if found {
			baselineFingerprint = baseline.Digest
		}
		if epochFound {
			importEpoch = epoch
		}
		if !found {
			blockers = append(blockers, "Customer.io final-delta source fingerprint is missing; rerun the final delta import before cutover review")
		} else if !epochFound {
			blockers = append(blockers, "Customer.io final-delta import epoch is missing; rerun the final delta import before cutover review")
		} else if isLocalDemoSession(sess) {
			blockers = append(blockers, "Customer.io source fingerprint certification requires a credentialed workspace; local demo data cannot certify cutover")
		} else {
			current, err := orchestrator.BuildCustomerIOSourceFingerprint(ctx, ad, sess, discovery)
			if err != nil {
				return shadowCheckResponse{}, fmt.Errorf("recompute Customer.io source fingerprint: %w", err)
			}
			fingerprintDeltas, fingerprintChanged, err := customerIOFingerprintShadowDeltas(baseline, current)
			if err != nil {
				return shadowCheckResponse{}, err
			}
			deltas = append(deltas, fingerprintDeltas...)
			needsDelta = needsDelta || fingerprintChanged
		}
	}
	recommendation := "ready_for_cutover_review"
	if len(blockers) > 0 {
		recommendation = "manual_review_required"
	} else if needsDelta {
		recommendation = "run_delta_import_before_cutover"
	}

	return shadowCheckResponse{
		JobID:               job.ID,
		Source:              source,
		GeneratedAt:         time.Now().UTC(),
		ImportEpoch:         importEpoch,
		BaselineFingerprint: baselineFingerprint,
		Warnings:            append([]string(nil), discovery.Warnings...),
		CurrentDiscovery:    discoveryCounts(discovery),
		NeedsDeltaImport:    needsDelta,
		RecommendedAction:   recommendation,
		Blockers:            blockers,
		Deltas:              deltas,
	}, nil
}

func validBeehiivShadowBinding(resp shadowCheckResponse) bool {
	if resp.Source != canonical.SourceBeehiiv {
		return true
	}
	return validShadowDigest(resp.ImportEpoch) && validShadowDigest(resp.BaselineFingerprint)
}

func validKlaviyoShadowBinding(resp shadowCheckResponse) bool {
	if resp.Source != canonical.SourceKlaviyo {
		return true
	}
	return validShadowDigest(resp.ImportEpoch) && validShadowDigest(resp.BaselineFingerprint)
}

func validHubSpotShadowBinding(resp shadowCheckResponse) bool {
	if resp.Source != canonical.SourceHubSpot {
		return true
	}
	return validShadowDigest(resp.ImportEpoch) && validShadowDigest(resp.BaselineFingerprint)
}

func validCustomerIOShadowBinding(resp shadowCheckResponse) bool {
	if resp.Source != canonical.SourceCustomerIO {
		return true
	}
	return validShadowDigest(resp.ImportEpoch) && validShadowDigest(resp.BaselineFingerprint)
}

func validSourceShadowBinding(resp shadowCheckResponse) bool {
	return validBeehiivShadowBinding(resp) && validHubSpotShadowBinding(resp) && validKlaviyoShadowBinding(resp) && validCustomerIOShadowBinding(resp)
}

func validShadowDigest(value string) bool {
	value = strings.TrimSpace(value)
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}

func beehiivFingerprintShadowDeltas(baseline, current orchestrator.BeehiivSourceFingerprint) ([]shadowResourceDelta, bool, error) {
	changed, err := orchestrator.ChangedBeehiivFingerprintComponents(baseline, current)
	if err != nil {
		return nil, false, fmt.Errorf("compare Beehiiv source fingerprint: %w", err)
	}
	if len(changed) == 0 {
		return nil, false, nil
	}
	labels := map[string]string{
		"subscribers":    "Subscriber identity, status, fields, tags, and audience membership",
		"segments":       "Segment and newsletter-list definitions",
		"automations":    "Automation definitions and email inventory",
		"campaigns":      "Eligible sent posts and analytics",
		"source_archive": "Beehiiv source archive, automation journeys, and non-campaign posts",
	}
	out := make([]shadowResourceDelta, 0, len(changed))
	for _, component := range changed {
		before := baseline.Components[component]
		after := current.Components[component]
		delta := after.Count - before.Count
		if delta < 0 {
			delta = -delta
		}
		if delta == 0 {
			delta = 1 // same-count content/identity mutation
		}
		out = append(out, shadowResourceDelta{
			Resource:    "source_fingerprint:" + component,
			Label:       labels[component],
			SourceTotal: after.Count,
			Imported:    before.Count,
			Delta:       delta,
			Status:      "delta_detected",
			Supported:   true,
			CutoverRisk: "delta_import",
			Notes: []string{
				"The bounded Beehiiv source fingerprint changed after the latest successful import. Freeze source edits and rerun final delta before cutover review.",
			},
		})
	}
	return out, true, nil
}

func hubSpotFingerprintShadowDeltas(baseline, current orchestrator.HubSpotSourceFingerprint) ([]shadowResourceDelta, bool, error) {
	changed, err := orchestrator.ChangedHubSpotFingerprintComponents(baseline, current)
	if err != nil {
		return nil, false, fmt.Errorf("compare HubSpot source fingerprint: %w", err)
	}
	if len(changed) == 0 {
		return nil, false, nil
	}
	labels := map[string]string{
		"subscribers":                 "HubSpot email-addressable contact identity, status, fields, and exact list membership",
		"profiles_without_email":      "HubSpot contacts excluded from email import by immutable contact ID",
		"additional_email_identities": "HubSpot additional email identities preserved for contact identity review",
		"segments":                    "HubSpot list and active-subscription targeting boundaries",
		"contact_properties":          "HubSpot contact-property definitions",
	}
	out := make([]shadowResourceDelta, 0, len(changed))
	for _, component := range changed {
		before := baseline.Components[component]
		after := current.Components[component]
		delta := after.Count - before.Count
		if delta < 0 {
			delta = -delta
		}
		if delta == 0 {
			delta = 1
		}
		out = append(out, shadowResourceDelta{
			Resource:    "source_fingerprint:" + component,
			Label:       labels[component],
			SourceTotal: after.Count,
			Imported:    before.Count,
			Delta:       delta,
			Status:      "delta_detected",
			Supported:   true,
			CutoverRisk: "delta_import",
			Notes: []string{
				"The bounded HubSpot source fingerprint changed after the latest successful import. Freeze contact and list edits and rerun final delta before bridge cutover review.",
			},
		})
	}
	return out, true, nil
}

func klaviyoFingerprintShadowDeltas(baseline, current orchestrator.KlaviyoSourceFingerprint) ([]shadowResourceDelta, bool, error) {
	changed, err := orchestrator.ChangedKlaviyoFingerprintComponents(baseline, current)
	if err != nil {
		return nil, false, fmt.Errorf("compare Klaviyo source fingerprint: %w", err)
	}
	if len(changed) == 0 {
		return nil, false, nil
	}
	labels := map[string]string{
		"subscribers":           "Subscriber identity, consent, status, fields, tags, and exact audience membership",
		"segments":              "List and frozen dynamic-segment definitions",
		"editable_templates":    "Editable rendered templates",
		"rebuild_flows":         "Rebuild-only flow definitions and graph metadata",
		"sent_campaign_archive": "Sent email campaign archive",
		"source_archive":        "Exact forms, non-email and non-sent campaigns, rebuild-only templates, and ecosystem guidance archive",
	}
	out := make([]shadowResourceDelta, 0, len(changed))
	for _, component := range changed {
		before := baseline.Components[component]
		after := current.Components[component]
		delta := after.Count - before.Count
		if delta < 0 {
			delta = -delta
		}
		if delta == 0 {
			delta = 1
		}
		out = append(out, shadowResourceDelta{
			Resource:    "source_fingerprint:" + component,
			Label:       labels[component],
			SourceTotal: after.Count,
			Imported:    before.Count,
			Delta:       delta,
			Status:      "delta_detected",
			Supported:   true,
			CutoverRisk: "delta_import",
			Notes: []string{
				"The bounded Klaviyo source fingerprint changed after the latest successful import. Freeze source edits and rerun final delta before cutover review.",
			},
		})
	}
	return out, true, nil
}

func customerIOFingerprintShadowDeltas(baseline, current orchestrator.CustomerIOSourceFingerprint) ([]shadowResourceDelta, bool, error) {
	changed, err := orchestrator.ChangedCustomerIOFingerprintComponents(baseline, current)
	if err != nil {
		return nil, false, fmt.Errorf("compare Customer.io source fingerprint: %w", err)
	}
	if len(changed) == 0 {
		return nil, false, nil
	}
	labels := map[string]string{
		"subscribers":            "Customer.io profile identity, consent, status, fields, and exact audience/topic membership",
		"profiles_without_email": "Customer.io profiles excluded from email import by immutable cio_id",
		"segments":               "Customer.io segment definitions and frozen membership projections",
		"editable_templates":     "Customer.io editable Design Studio email templates",
		"sent_campaign_archive":  "Customer.io sent email newsletter archive",
		"source_archive":         "Customer.io campaign, broadcast, transactional, template, topic, object, and ecosystem source archive",
	}
	out := make([]shadowResourceDelta, 0, len(changed))
	for _, component := range changed {
		before := baseline.Components[component]
		after := current.Components[component]
		delta := after.Count - before.Count
		if delta < 0 {
			delta = -delta
		}
		if delta == 0 {
			delta = 1
		}
		out = append(out, shadowResourceDelta{
			Resource:    "source_fingerprint:" + component,
			Label:       labels[component],
			SourceTotal: after.Count,
			Imported:    before.Count,
			Delta:       delta,
			Status:      "delta_detected",
			Supported:   true,
			CutoverRisk: "delta_import",
			Notes: []string{
				"The bounded Customer.io source fingerprint changed after the latest successful import. Freeze source edits and rerun final delta before cutover review.",
			},
		})
	}
	return out, true, nil
}

func (h *Migration) persistShadowCheck(ctx context.Context, tenantID string, resp shadowCheckResponse) error {
	store, ok := h.store.(jobstore.ShadowMonitorStore)
	if !ok {
		return fmt.Errorf("shadow-check history persistence is unavailable")
	}
	resp = ensureShadowResponse(resp, resp.JobID, resp.Source)
	if strings.TrimSpace(resp.Error) != "" {
		resp.RecommendedAction = "check_failed"
	}
	resp = sanitizeShadowCheckResponse(resp.Source, resp)
	snapshot, err := json.Marshal(resp)
	if err != nil {
		return fmt.Errorf("marshal shadow-check result: %w", err)
	}
	rec := jobstore.ShadowCheckRecord{
		JobID:             resp.JobID,
		TenantID:          tenantID,
		Source:            resp.Source,
		GeneratedAt:       defaultShadowGeneratedAt(resp.GeneratedAt),
		NeedsDeltaImport:  resp.NeedsDeltaImport,
		RecommendedAction: resp.RecommendedAction,
		Error:             resp.Error,
		Snapshot:          snapshot,
	}
	if err := store.SaveShadowCheckResult(jobstore.WithTenantID(ctx, tenantID), rec); err != nil {
		return fmt.Errorf("save shadow-check result: %w", err)
	}
	return nil
}

func defaultShadowGeneratedAt(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now().UTC()
	}
	return t
}

func statusForShadowErr(err error) int {
	msg := err.Error()
	var rateLimited *adapter.ErrRateLimited
	switch {
	case errors.Is(err, jobstore.ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, errActiveCampaignPostPilotCleanupFrozen):
		return http.StatusConflict
	case errors.Is(err, orchestrator.ErrMigrationExecutionInProgress):
		return http.StatusConflict
	case errors.Is(err, orchestrator.ErrMigrationExecutionLockUnavailable):
		return http.StatusServiceUnavailable
	case errors.Is(err, adapter.ErrAuth), errors.As(err, &rateLimited):
		return http.StatusBadGateway
	case strings.Contains(msg, "does not match"), strings.Contains(msg, "expired"), strings.Contains(msg, "source session expires"), strings.Contains(msg, "requires a completed migration job"):
		return http.StatusConflict
	default:
		return http.StatusBadGateway
	}
}

func requireCompletedShadowJob(job *canonical.MigrationJob) error {
	if job == nil {
		return fmt.Errorf("shadow monitoring requires a completed migration job")
	}
	if job.Status != canonical.MigCompleted {
		return fmt.Errorf("shadow monitoring requires a completed migration job; current status is %q", job.Status)
	}
	return nil
}

func buildShadowDeltas(job *canonical.MigrationJob, source canonical.SourcePlatform, discovery adapter.DiscoveryReport, report canonical.VerificationReport) ([]shadowResourceDelta, bool, []string) {
	rows := orchestrator.ResourceCompletenessForSource(source, discovery, report)
	out := make([]shadowResourceDelta, 0, len(rows))
	needsDelta := false
	blockers := []string{}
	if source == canonical.SourceActiveCampaign {
		for _, warning := range discovery.Warnings {
			if warning = strings.TrimSpace(warning); warning != "" {
				blockers = append(blockers, "Source discovery warning: "+warning)
			}
		}
	}
	activeCampaignReviews := activeCampaignShadowReviewStatuses(job, source, &report)
	for _, row := range rows {
		rawDelta := row.SourceTotal - row.Imported
		delta := rawDelta
		if delta < 0 {
			delta = 0
		}
		risk := "none"
		if source == canonical.SourceActiveCampaign && row.Resource == "subscribers" && rawDelta < 0 {
			// Review evidence is tied to the inventory observed when it was
			// recorded. A later shadow check with fewer contacts is a new source
			// state and must never be cleared by that older sign-off. Reconcile the
			// removals, run a fresh final delta so the verification baseline moves
			// to the reviewed inventory, and then record new cutover evidence.
			risk = "source_deletion_review"
			blockers = append(blockers, "ActiveCampaign email-addressable contact inventory decreased; reconcile removed contacts and disable any matching destination subscribers, then run a fresh final delta before cutover")
		}
		if source == canonical.SourceBeehiiv && row.Resource == "subscribers" && rawDelta < 0 {
			// Beehiiv is a full-snapshot source today; there is no source-event
			// delete bridge. A lower inventory must therefore be reconciled by
			// source identity before the older destination rows can be considered
			// safe for cutover.
			risk = "source_deletion_review"
			blockers = append(blockers, "Beehiiv subscription inventory decreased; reconcile deleted source IDs and disable matching destination subscribers, then run a fresh final delta and shadow check before cutover")
		}
		if source == canonical.SourceCustomerIO && row.Resource == "subscribers" && rawDelta < 0 {
			risk = "source_deletion_review"
			blockers = append(blockers, "Customer.io email-addressable profile inventory decreased; reconcile removed cio_id values and disable or transfer matching destination projections, then run a fresh final delta and shadow check before cutover")
		}
		manualReview := row.SourceTotal > 0 && (!row.Supported || manualReviewResourceStatus(row.Status))
		if source == canonical.SourceBeehiiv && beehiivPilotOnlyReviewResource(row.Resource) {
			// These provider-only surfaces have no countable runtime delta. Their
			// durable gap records and post-delta operator evidence are enforced by
			// strict pilot acceptance rather than presented as importable shadow work.
			manualReview = false
			delta = 0
		}
		if source == canonical.SourceBeehiiv && row.Resource == "segments" && row.Imported < row.SourceTotal {
			if previous, found := resourceByName(&report, row.Resource); found && row.SourceTotal <= previous.SourceTotal {
				manualReview = true
			}
		}
		if manualReview && activeCampaignShadowReviewResolved(job, row, &report, activeCampaignReviews) {
			manualReview = false
			row.Notes = append(append([]string(nil), row.Notes...), "Post-delta ActiveCampaign review evidence resolves this preserved source surface for shadow cutover review.")
		}
		if (manualReview || delta > 0) && beehiivShadowReviewResolved(job, source, row, &report) {
			manualReview = false
			delta = 0
			note := "Every preserved Beehiiv automation has post-delta rebuild or retirement evidence and a passing test review."
			if row.Resource == "segments" {
				note = "Post-delta Beehiiv evidence confirms every unavailable dynamic segment was rebuilt or explicitly retired; frozen membership snapshots remain unchanged."
			}
			row.Notes = append(append([]string(nil), row.Notes...), note)
		}
		if (manualReview || delta > 0) && klaviyoShadowReviewResolved(job, source, row, &report) {
			manualReview = false
			delta = 0
			row.Notes = append(append([]string(nil), row.Notes...), "Post-final-delta Klaviyo review evidence resolves this preserved or intentionally retained source surface for shadow cutover review.")
		}
		if (manualReview || delta > 0) && customerIOShadowReviewResolved(job, source, row, &report) {
			manualReview = false
			delta = 0
			row.Notes = append(append([]string(nil), row.Notes...), "Post-final-delta Customer.io review evidence resolves this preserved, rebuilt, retained, or intentionally retired source surface for shadow cutover review.")
		}
		if manualReview {
			risk = "manual_rebuild"
			blockers = append(blockers, row.Label+" requires manual rebuild or explicit sign-off")
		} else if delta > 0 && risk == "none" {
			risk = "delta_import"
			needsDelta = true
		}
		out = append(out, shadowResourceDelta{
			Resource:    row.Resource,
			Label:       row.Label,
			SourceTotal: row.SourceTotal,
			Imported:    row.Imported,
			Delta:       delta,
			Status:      row.Status,
			Supported:   row.Supported,
			CutoverRisk: risk,
			Notes:       row.Notes,
		})
	}
	return out, needsDelta, blockers
}

func klaviyoShadowReviewResolved(job *canonical.MigrationJob, source canonical.SourcePlatform, row canonical.ResourceCompleteness, report *canonical.VerificationReport) bool {
	if source != canonical.SourceKlaviyo || job == nil || report == nil {
		return false
	}
	resource := strings.TrimSpace(row.Resource)
	previous, found := resourceByName(report, resource)
	if !found || row.SourceTotal != previous.SourceTotal {
		// Review evidence is bound to the exact final-delta inventory. A later
		// increase or decrease is a new source state and requires another final
		// delta plus fresh evidence.
		return false
	}
	key, ok := klaviyoShadowReviewKey(resource)
	if !ok {
		return false
	}
	if klaviyoShadowPreservedArchiveResource(resource) && row.Imported < row.SourceTotal {
		// Evidence may approve a complete rebuild record, never hide missing
		// rows from a partial source archive or audience snapshot.
		return false
	}
	if resource == "automations" && !automationRebuildsPassed(report) {
		return false
	}
	return klaviyoShadowEvidencePassed(job, key)
}

func klaviyoShadowReviewKey(resource string) (string, bool) {
	switch strings.TrimSpace(resource) {
	case "segments":
		return klaviyoAudienceSnapshotReviewKey, true
	case "automations":
		return klaviyoFlowRebuildReviewKey, true
	case "multi_email_profiles":
		return klaviyoConsentSuppressionReviewKey, true
	case "non_email_profiles", "non_email_campaigns", "omni_channels":
		return klaviyoChannelIdentityReviewKey, true
	case "deliverability":
		return klaviyoDeliverabilityReviewKey, true
	case "campaign_rebuilds", "structured_templates", "forms", "ecommerce", "reviews", "service", "cdp", "marketplace", "reports":
		return klaviyoEcosystemDependenciesReviewKey, true
	default:
		return "", false
	}
}

func klaviyoShadowPreservedArchiveResource(resource string) bool {
	switch strings.TrimSpace(resource) {
	case "segments", "automations", "multi_email_profiles", "non_email_campaigns", "campaign_rebuilds", "structured_templates", "forms", "ecommerce", "reviews", "service", "cdp", "omni_channels", "deliverability", "marketplace":
		return true
	default:
		return false
	}
}

func klaviyoShadowEvidencePassed(job *canonical.MigrationJob, key string) bool {
	status, reviewedAt, _, _, ok, err := klaviyoCutoverEvidence(job, key)
	if !ok || err != nil || status != "pass" || !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) || job.CompletedAt == nil {
		return false
	}
	return !reviewedAt.Before(job.CompletedAt.UTC())
}

func customerIOShadowReviewResolved(job *canonical.MigrationJob, source canonical.SourcePlatform, row canonical.ResourceCompleteness, report *canonical.VerificationReport) bool {
	if source != canonical.SourceCustomerIO || job == nil || report == nil {
		return false
	}
	resource := strings.TrimSpace(row.Resource)
	previous, found := resourceByName(report, resource)
	if !found || row.SourceTotal != previous.SourceTotal {
		return false
	}
	key, ok := customerIOShadowReviewKey(resource)
	if !ok {
		return false
	}
	// Evidence can approve an intentionally retained or manual-rebuild surface,
	// but never conceal a partial exact archive or destination projection.
	if row.Supported && row.SourceTotal > 0 && row.Imported < row.SourceTotal {
		return false
	}
	return customerIOShadowEvidencePassed(job, key)
}

func customerIOShadowReviewKey(resource string) (string, bool) {
	switch strings.TrimSpace(resource) {
	case "segments", "subscription_topics":
		return customerIOIdentityAudienceReviewKey, true
	case "workflow_definitions", "transactional", "templates", "structured_templates":
		return customerIOAutomationRebuildReviewKey, true
	case "consent_exclusions":
		return customerIOConsentSubscriptionReviewKey, true
	case "non_email_profiles", "channel_dependencies":
		return customerIOChannelDependencyReviewKey, true
	case "deliverability":
		return customerIODeliverabilityReviewKey, true
	case "custom_objects", "ecosystem":
		return customerIOEcosystemDependenciesReviewKey, true
	default:
		return "", false
	}
}

func customerIOShadowEvidencePassed(job *canonical.MigrationJob, key string) bool {
	status, reviewedAt, _, _, ok, err := customerIOCutoverEvidence(job, key)
	if !ok || err != nil || status != "pass" || !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) || job.CompletedAt == nil {
		return false
	}
	return !reviewedAt.Before(job.CompletedAt.UTC())
}

func beehiivPilotOnlyReviewResource(resource string) bool {
	switch strings.TrimSpace(resource) {
	case "forms", "landing", "beehiiv_website_capture_rebuild", "beehiiv_boosts_recommendations_rebuild", "beehiiv_ad_network_rebuild":
		return true
	default:
		return false
	}
}

func beehiivShadowReviewResolved(job *canonical.MigrationJob, source canonical.SourcePlatform, row canonical.ResourceCompleteness, report *canonical.VerificationReport) bool {
	if source != canonical.SourceBeehiiv || report == nil {
		return false
	}
	resource := strings.TrimSpace(row.Resource)
	previous, found := resourceByName(report, resource)
	if found && row.SourceTotal > previous.SourceTotal {
		// Evidence for the completed import cannot approve source records first
		// observed by this later shadow check.
		return false
	}
	switch resource {
	case "automations":
		if row.SourceTotal > row.Imported {
			return false
		}
		return automationRebuildsPassed(report) && beehiivShadowEvidencePassed(job, beehiivAutomationRetirementReviewKey)
	case "segments":
		return found && beehiivShadowEvidencePassed(job, "beehiiv_segment_rules_review")
	case "condition_set_rules":
		return found && beehiivShadowEvidencePassed(job, "beehiiv_segment_rules_review")
	default:
		return false
	}
}

func beehiivShadowEvidencePassed(job *canonical.MigrationJob, key string) bool {
	status, reviewedAt, _, _, ok, err := beehiivCutoverEvidence(job, key)
	if !ok || err != nil || status != "pass" || !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) || job.CompletedAt == nil {
		return false
	}
	return !reviewedAt.Before(job.CompletedAt.UTC())
}

func activeCampaignShadowReviewStatuses(job *canonical.MigrationJob, source canonical.SourcePlatform, report *canonical.VerificationReport) map[string]string {
	if source != canonical.SourceActiveCampaign || job == nil || report == nil {
		return nil
	}
	statuses := map[string]string{}
	for _, item := range activeCampaignCutoverAcceptanceItems(job, report) {
		statuses[item.Key] = item.Status
	}
	sms := smsAcceptanceItem(job, report)
	statuses[sms.Key] = sms.Status
	return statuses
}

func activeCampaignShadowReviewResolved(job *canonical.MigrationJob, row canonical.ResourceCompleteness, report *canonical.VerificationReport, reviewStatuses map[string]string) bool {
	key, ok := activeCampaignShadowReviewKey(row.Resource)
	if !ok || job == nil || report == nil {
		return false
	}
	if previous, found := resourceByName(report, row.Resource); found && row.SourceTotal > previous.SourceTotal {
		// Evidence for the completed import cannot approve source records that
		// appeared after it. Import and review the larger inventory first.
		return false
	}
	if activeCampaignShadowArchiveSurface(row.Resource) && (row.SourceTotal <= 0 || row.Imported < row.SourceTotal) {
		// Review can resolve a fully preserved archive surface, but cannot hide
		// missing source rows from an earlier partial archive.
		return false
	}
	if status, found := reviewStatuses[key]; found {
		return status == "pass"
	}
	return activeCampaignShadowEvidencePassed(job, key)
}

func activeCampaignShadowReviewKey(resource string) (string, bool) {
	switch strings.TrimSpace(resource) {
	case "templates":
		return "activecampaign_templates_review", true
	case "forms":
		return "activecampaign_forms_review", true
	case "custom_objects":
		return "activecampaign_custom_objects_review", true
	case "ecommerce":
		return "activecampaign_ecommerce_review", true
	case "crm":
		return "activecampaign_crm_archive_review", true
	case "automations":
		return "activecampaign_automation_rebuild_review", true
	case "audience_schema":
		return "activecampaign_audience_schema_review", true
	case "consent_exclusions", "non_email_contacts":
		return activeCampaignConsentExclusionReviewKey, true
	case "sms":
		return "sms_readiness", true
	default:
		return "", false
	}
}

func activeCampaignShadowArchiveSurface(resource string) bool {
	switch strings.TrimSpace(resource) {
	case "templates", "forms", "custom_objects", "ecommerce", "crm", "audience_schema", "non_email_contacts", "sms":
		return true
	default:
		return false
	}
}

func activeCampaignShadowEvidencePassed(job *canonical.MigrationJob, key string) bool {
	status, reviewedAt, _, _, ok, err := activeCampaignCutoverEvidence(job, key)
	if !ok || err != nil || status != "pass" || !activeCampaignFinalDeltaCompleted(job) || latestDeltaImportFailed(job) || job.CompletedAt == nil {
		return false
	}
	return !reviewedAt.Before(job.CompletedAt.UTC())
}

func manualReviewResourceStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "manual_rebuild_required", "preserved_for_rebuild":
		return true
	default:
		return false
	}
}

func discoveryCounts(rep adapter.DiscoveryReport) map[string]int {
	return map[string]int{
		"subscribers":                 rep.SubscribersTotal,
		"profiles_without_email":      rep.ProfilesWithoutEmailTotal,
		"additional_email_identities": rep.AdditionalEmailIdentitiesTotal,
		"segments":                    rep.SegmentsTotal,
		"automations":                 rep.AutomationsTotal,
		"archive":                     rep.ArchiveTotal,
		"source_archive":              rep.SourceArchiveTotal,
		"paid_subs":                   rep.PaidSubsTotal,
		"templates":                   rep.TemplatesTotal,
		"campaigns":                   rep.CampaignsTotal,
		"reports":                     rep.ReportsTotal,
		"groups":                      rep.GroupsTotal,
		"forms":                       rep.FormsTotal,
		"landing_pages":               rep.LandingPagesTotal,
		"ecommerce":                   rep.EcommerceTotal,
		"crm":                         rep.CRMTotal,
		"deals":                       rep.DealsTotal,
		"pipelines":                   rep.PipelinesTotal,
		"custom_objects":              rep.CustomObjectsTotal,
		"subscription_channels":       rep.SubscriptionChannelsTotal,
		"sms_campaigns":               rep.SMSCampaignsTotal,
		"push_campaigns":              rep.PushCampaignsTotal,
	}
}
