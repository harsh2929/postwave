package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

// DeltaImport reruns an already-authenticated job against the source system.
// Adapters are idempotent, so the first production-safe delta mode is a clean
// replay that updates existing mapped resources and imports newly discovered
// records without requiring the customer to reconnect credentials.
func (h *Migration) DeltaImport(w http.ResponseWriter, r *http.Request) {
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	var body struct {
		JobID string `json:"job_id"`
		// MIGR-038: optional RFC3339 instant to defer the delta import until.
		ScheduledFor string `json:"scheduled_for,omitempty"`
	}
	if err := decodeRequestJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, body.JobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.Source != source {
		writeErr(w, http.StatusConflict, fmt.Errorf("job source %q does not match route source %q", job.Source, source))
		return
	}
	if job.Status != canonical.MigCompleted {
		writeErr(w, http.StatusConflict, fmt.Errorf("delta import requires a completed committed migration; current status is %q", job.Status))
		return
	}
	executionLease, err := h.acquireJobExecution(r.Context(), tenantID, job.ID)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer func() { _ = executionLease.Release() }()

	job, err = h.loadJob(r.Context(), tenantID, body.JobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.Source != source {
		writeErr(w, http.StatusConflict, fmt.Errorf("job source %q does not match route source %q", job.Source, source))
		return
	}
	if job.Status != canonical.MigCompleted {
		writeErr(w, http.StatusConflict, fmt.Errorf("delta import requires a completed committed migration; current status is %q", job.Status))
		return
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "delta import"); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	sess, status, err := h.loadCutoverSession(r.Context(), tenantID, body.JobID, source, "running a delta import")
	if err != nil {
		if status != 0 {
			writeErr(w, status, err)
			return
		}
		writeJobStoreErr(w, err)
		return
	}
	if source == canonical.SourceActiveCampaign {
		if err := requireActiveCampaignAccount(job, sess); err != nil {
			writeErr(w, http.StatusConflict, err)
			return
		}
	}
	if err := attachDeltaImportSnapshot(job); err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("snapshot completed migration before delta import: %w", err))
		return
	}

	deltaStartedAt := time.Now().UTC()
	deltaStartedAtValue := deltaStartedAt.Format(time.RFC3339Nano)
	h.captureSourceEventSyncBeforeDelta(r.Context(), tenantID, job, source, deltaStartedAt)
	job.Status = canonical.MigImporting
	job.Progress = canonical.MigrationProgress{}
	job.Error = nil
	job.CompletedAt = nil
	job.RollbackUntil = nil
	job.VerificationReport = nil
	job.StartedAt = deltaStartedAt
	job.Cursor[deltaImportStartedAtKey] = &deltaStartedAtValue
	// MIGR-038: demo sessions complete immediately (below) and can't honor a
	// deferral — reject scheduling rather than silently running now.
	if body.ScheduledFor != "" && isLocalDemoSession(sess) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("scheduling is not supported for demo migrations"))
		return
	}
	// attachDeltaImportSnapshot above already scrubbed any inherited base-run
	// schedule; stamp the delta's own if the operator requested one.
	scheduled, err := applyScheduledStart(job, body.ScheduledFor)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	scopedCtx := jobstore.WithTenantID(r.Context(), tenantID)
	if err := h.transitionJob(scopedCtx, job, canonical.MigCompleted); err != nil {
		writeTransitionErr(w, err)
		return
	}
	if err := orchestrator.ClearSubscriberVerifierObservations(scopedCtx, h.db, tenantID, job.ID); err != nil {
		h.failJob(scopedCtx, job, err)
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if isLocalDemoSession(sess) {
		h.completeDemoJob(scopedCtx, job, false)
		writeJSON(w, http.StatusAccepted, map[string]string{"job_id": job.ID, "mode": "delta_import"})
		return
	}
	if err := executionLease.Release(); err != nil {
		h.failJob(scopedCtx, job, err)
		writeExecutionLeaseErr(w, err)
		return
	}
	// MIGR-038: a scheduled delta waits for the recovery worker at its start time.
	if !scheduled {
		h.launchRunnableJob(tenantID, job.ID)
	}

	writeJSON(w, http.StatusAccepted, map[string]string{"job_id": job.ID, "mode": "delta_import"})
}

type sourceEventOverlapSnapshotV1 struct {
	Version             int       `json:"version"`
	EnabledSince        time.Time `json:"enabled_since"`
	FirstSuccessfulSync time.Time `json:"first_successful_sync_at"`
	PreDeltaSyncedAt    time.Time `json:"pre_delta_synced_at"`
	IntervalSeconds     int       `json:"interval_seconds"`
	SuccessfulSyncs     int       `json:"successful_sync_count"`
	MaxSyncGapSeconds   int       `json:"max_success_gap_seconds"`
	CapturedAt          time.Time `json:"captured_at"`
}

func (h *Migration) captureSourceEventSyncBeforeDelta(ctx context.Context, tenantID string, job *canonical.MigrationJob, source canonical.SourcePlatform, capturedAt time.Time) {
	if job == nil || !sourceBridgeSessionSource(source) {
		return
	}
	store, ok := h.store.(jobstore.SourceEventMonitorStore)
	if !ok {
		return
	}
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(ctx, tenantID), tenantID, job.ID)
	if err != nil || !monitor.Enabled || monitor.EnabledSince == nil || monitor.FirstSyncedAt == nil ||
		monitor.LastSyncedAt == nil || monitor.SuccessfulSyncs <= 0 || monitor.MaxSyncGapSecs < 0 ||
		strings.TrimSpace(monitor.LastError) != "" {
		return
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	syncedAt := monitor.LastSyncedAt.UTC().Format(time.RFC3339Nano)
	job.Cursor[sourceEventPreDeltaSyncedKey] = &syncedAt
	snapshot := sourceEventOverlapSnapshotV1{
		Version:             1,
		EnabledSince:        monitor.EnabledSince.UTC(),
		FirstSuccessfulSync: monitor.FirstSyncedAt.UTC(),
		PreDeltaSyncedAt:    monitor.LastSyncedAt.UTC(),
		IntervalSeconds:     normalizeSourceEventInterval(monitor.IntervalSeconds),
		SuccessfulSyncs:     monitor.SuccessfulSyncs,
		MaxSyncGapSeconds:   monitor.MaxSyncGapSecs,
		CapturedAt:          capturedAt.UTC(),
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		delete(job.Cursor, sourceEventPreDeltaSyncedKey)
		return
	}
	encoded := string(raw)
	job.Cursor[sourceEventOverlapSnapshotKey] = &encoded
}
