package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

type shadowMonitorResponse struct {
	Monitor jobstore.ShadowMonitorRecord `json:"monitor"`
	History []shadowCheckResponse        `json:"history"`
}

func (h *Migration) StartShadowMonitor(w http.ResponseWriter, r *http.Request) {
	store, ok := h.store.(jobstore.ShadowMonitorStore)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("shadow monitoring requires a monitor-capable migration job store"))
		return
	}
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	var body struct {
		JobID           string `json:"job_id"`
		IntervalSeconds int    `json:"interval_seconds"`
	}
	if err := decodeRequestJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	executionLease, err := h.acquireJobExecution(r.Context(), tenantID, body.JobID)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	leaseReleased := false
	defer func() {
		if !leaseReleased {
			_ = executionLease.Release()
		}
	}()
	job, err := h.loadJob(r.Context(), tenantID, body.JobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.Source != source {
		writeErr(w, http.StatusConflict, fmt.Errorf("job source %q does not match route source %q", job.Source, source))
		return
	}
	if err := requireCompletedShadowJob(job); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "shadow monitor restart"); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if _, status, err := h.loadCutoverSession(r.Context(), tenantID, body.JobID, source, "starting shadow monitor"); err != nil {
		if status != 0 {
			writeErr(w, status, err)
			return
		}
		writeJobStoreErr(w, err)
		return
	}
	interval := normalizeShadowInterval(body.IntervalSeconds)
	now := time.Now().UTC()
	_, err = store.UpsertShadowMonitor(jobstore.WithTenantID(r.Context(), tenantID), jobstore.ShadowMonitorRecord{
		JobID:           job.ID,
		TenantID:        tenantID,
		Source:          source,
		Enabled:         true,
		IntervalSeconds: interval,
		NextCheckAt:     &now,
	})
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	resp, checkErr, persistErr, releaseErr := h.runPersistedShadowCheckUnderExecutionLease(r.Context(), tenantID, source, job.ID, executionLease)
	leaseReleased = true
	attemptErr := errors.Join(checkErr, persistErr, releaseErr)
	action := resp.RecommendedAction
	errText := resp.Error
	next := nextRetryAwareAttemptAt(now, time.Duration(interval)*time.Second, attemptErr)
	if err := store.UpdateShadowMonitorAfterCheck(jobstore.WithTenantID(r.Context(), tenantID), tenantID, job.ID, now, next, action, errText); err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if persistErr != nil || releaseErr != nil {
		writeErr(w, http.StatusServiceUnavailable, sanitizeMigrationError(source, errors.Join(persistErr, releaseErr)))
		return
	}
	monitor, _ := store.GetShadowMonitor(jobstore.WithTenantID(r.Context(), tenantID), tenantID, job.ID)
	history, _ := h.shadowHistory(r.Context(), tenantID, job.ID, 10)
	out := sanitizeShadowMonitorResponse(shadowMonitorResponse{Monitor: monitor, History: history})
	if checkErr != nil {
		writeJSON(w, http.StatusAccepted, out)
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

func (h *Migration) GetShadowMonitor(w http.ResponseWriter, r *http.Request) {
	store, ok := h.store.(jobstore.ShadowMonitorStore)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("shadow monitoring requires a monitor-capable migration job store"))
		return
	}
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	jobID := chi.URLParam(r, "job_id")
	monitor, err := store.GetShadowMonitor(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	history, err := h.shadowHistory(r.Context(), tenantID, jobID, 20)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sanitizeShadowMonitorResponse(shadowMonitorResponse{Monitor: monitor, History: history}))
}

func (h *Migration) StopShadowMonitor(w http.ResponseWriter, r *http.Request) {
	store, ok := h.store.(jobstore.ShadowMonitorStore)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("shadow monitoring requires a monitor-capable migration job store"))
		return
	}
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
	if err := store.DisableShadowMonitor(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID); err != nil {
		writeJobStoreErr(w, err)
		return
	}
	monitor, err := store.GetShadowMonitor(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if monitor.Enabled {
		writeErr(w, http.StatusConflict, fmt.Errorf("shadow monitor disable did not persist"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job_id": jobID, "enabled": false})
}

func (h *Migration) StartShadowMonitorWorker(ctx context.Context, interval time.Duration) {
	if _, ok := h.store.(jobstore.ShadowMonitorStore); !ok {
		return
	}
	if interval <= 0 {
		interval = time.Minute
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if n, err := h.RunDueShadowChecks(ctx, 25); err != nil {
					slog.Warn("migration: shadow monitor worker failed", "err", err.Error())
				} else if n > 0 {
					slog.Info("migration: shadow monitor checks completed", "count", n)
				}
			}
		}
	}()
}

func (h *Migration) RunDueShadowChecks(ctx context.Context, limit int) (int, error) {
	store, ok := h.store.(jobstore.ShadowMonitorStore)
	if !ok {
		return 0, nil
	}
	now := time.Now().UTC()
	monitors, err := store.ListDueShadowMonitors(ctx, now, limit)
	if err != nil {
		return 0, err
	}
	for _, monitor := range monitors {
		executionLease, err := h.acquireJobExecution(ctx, monitor.TenantID, monitor.JobID)
		if err != nil {
			return 0, err
		}
		current, err := store.GetShadowMonitor(jobstore.WithTenantID(ctx, monitor.TenantID), monitor.TenantID, monitor.JobID)
		if err != nil {
			_ = executionLease.Release()
			if errors.Is(err, jobstore.ErrNotFound) {
				continue
			}
			return 0, err
		}
		if !current.Enabled {
			_ = executionLease.Release()
			continue
		}
		monitor = current
		job, err := h.loadJob(ctx, monitor.TenantID, monitor.JobID)
		if err != nil {
			_ = executionLease.Release()
			return 0, err
		}
		if migrationMonitorPaused(job) {
			next := now.Add(time.Duration(normalizeShadowInterval(monitor.IntervalSeconds)) * time.Second)
			_, err := store.UpsertShadowMonitor(jobstore.WithTenantID(ctx, monitor.TenantID), jobstore.ShadowMonitorRecord{
				JobID:           monitor.JobID,
				TenantID:        monitor.TenantID,
				Source:          monitor.Source,
				Enabled:         monitor.Enabled,
				IntervalSeconds: normalizeShadowInterval(monitor.IntervalSeconds),
				NextCheckAt:     &next,
			})
			if err != nil {
				_ = executionLease.Release()
				return 0, err
			}
			if err := executionLease.Release(); err != nil {
				return 0, err
			}
			continue
		}
		resp, checkErr, persistErr, releaseErr := h.runPersistedShadowCheckUnderExecutionLease(ctx, monitor.TenantID, monitor.Source, monitor.JobID, executionLease)
		attemptErr := errors.Join(checkErr, persistErr, releaseErr)
		action := resp.RecommendedAction
		errText := resp.Error
		next := nextRetryAwareAttemptAt(now, time.Duration(normalizeShadowInterval(monitor.IntervalSeconds))*time.Second, attemptErr)
		if err := store.UpdateShadowMonitorAfterCheck(jobstore.WithTenantID(ctx, monitor.TenantID), monitor.TenantID, monitor.JobID, now, next, action, errText); err != nil {
			return 0, err
		}
		if persistErr != nil || releaseErr != nil {
			return 0, errors.Join(persistErr, releaseErr)
		}
	}
	return len(monitors), nil
}

func (h *Migration) shouldPauseMigrationMonitor(ctx context.Context, tenantID, jobID string) bool {
	job, err := h.loadJob(ctx, tenantID, jobID)
	if err != nil {
		return false
	}
	return migrationMonitorPaused(job)
}

func migrationMonitorPaused(job *canonical.MigrationJob) bool {
	if job == nil {
		return false
	}
	if migrationMonitorPausedStatus(job.Status) {
		return true
	}
	if postPilotCleanupAuthorized(job) {
		return true
	}
	// A failed rollback restores the origin status so cleanup can be retried,
	// but keeps this durable origin sentinel. Pause monitors while that retry is
	// pending so they cannot recreate rows during a partial rollback.
	_, rollbackPending := cursorString(job.Cursor, rollbackOriginStatusCursorKey)
	return rollbackPending
}

func migrationMonitorPausedStatus(status canonical.MigrationStatus) bool {
	// Monitoring is valid only while the committed destination is live. In
	// particular, a monitor that could not be disabled after rollback must stay
	// inert; otherwise it could recreate destination rows after cleanup.
	return status != canonical.MigCompleted
}

func ensureShadowResponse(resp shadowCheckResponse, jobID string, source canonical.SourcePlatform) shadowCheckResponse {
	if resp.JobID == "" {
		resp.JobID = jobID
	}
	if resp.Source == "" {
		resp.Source = source
	}
	if resp.GeneratedAt.IsZero() {
		resp.GeneratedAt = time.Now().UTC()
	}
	if resp.RecommendedAction == "" {
		resp.RecommendedAction = "check_failed"
	}
	return resp
}

func (h *Migration) shadowHistory(ctx context.Context, tenantID, jobID string, limit int) ([]shadowCheckResponse, error) {
	store, ok := h.store.(jobstore.ShadowMonitorStore)
	if !ok {
		return nil, nil
	}
	records, err := store.ListShadowCheckResults(jobstore.WithTenantID(ctx, tenantID), tenantID, jobID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]shadowCheckResponse, 0, len(records))
	for _, record := range records {
		var resp shadowCheckResponse
		var snapshotErr error
		if len(record.Snapshot) > 0 {
			snapshotErr = json.Unmarshal(record.Snapshot, &resp)
		} else {
			snapshotErr = fmt.Errorf("snapshot is missing")
		}
		snapshotValid := snapshotErr == nil && resp.JobID == record.JobID && resp.Source == record.Source &&
			!resp.GeneratedAt.IsZero() && resp.RecommendedAction == record.RecommendedAction
		if snapshotValid && record.RecommendedAction == "ready_for_cutover_review" {
			snapshotValid = resp.CurrentDiscovery != nil && resp.Deltas != nil && validShadowDigest(resp.AttemptToken) && validSourceShadowBinding(resp)
		}
		// Indexed status columns are authoritative. generated_at inside the
		// snapshot is different: it is the provider observation time. Stores may
		// advance the row timestamp solely to avoid insert-order collisions, which
		// must not make an older scan appear newer than a later delta/attempt.
		resp.JobID = record.JobID
		resp.Source = record.Source
		if resp.GeneratedAt.IsZero() {
			resp.GeneratedAt = record.GeneratedAt
		}
		resp.NeedsDeltaImport = record.NeedsDeltaImport
		resp.RecommendedAction = record.RecommendedAction
		resp.Error = record.Error
		if !snapshotValid {
			const detail = "persisted shadow-check snapshot is invalid; run a fresh shadow check"
			resp.RecommendedAction = "check_failed"
			resp.Error = detail
			resp.Blockers = append(resp.Blockers, detail)
			if resp.CurrentDiscovery == nil {
				resp.CurrentDiscovery = map[string]int{}
			}
			if resp.Deltas == nil {
				resp.Deltas = []shadowResourceDelta{}
			}
		}
		resp = sanitizeShadowCheckResponse(record.Source, resp)
		out = append(out, resp)
	}
	currentAttemptToken := ""
	if job, jobErr := h.store.Get(jobstore.WithTenantID(ctx, tenantID), jobID); jobErr == nil {
		if token, found, tokenErr := shadowAttemptTokenFromJob(job); tokenErr == nil && found {
			currentAttemptToken = token
		}
	}
	// PostgreSQL orders immutable rows by insert timestamp. A completed result
	// may be inserted after its execution lease is released, so persistence order
	// is not necessarily source-observation order. Cutover consumers must see a
	// newer attempt-start sentinel ahead of an older scan that finished first.
	sort.SliceStable(out, func(i, j int) bool {
		if currentAttemptToken != "" {
			iCurrent := out[i].AttemptToken == currentAttemptToken
			jCurrent := out[j].AttemptToken == currentAttemptToken
			if iCurrent != jCurrent {
				return iCurrent
			}
		}
		return out[i].GeneratedAt.After(out[j].GeneratedAt)
	})
	return out, nil
}

func sanitizeShadowMonitorResponse(resp shadowMonitorResponse) shadowMonitorResponse {
	source := resp.Monitor.Source
	resp.Monitor.LastError = sanitizeMigrationText(source, resp.Monitor.LastError)
	for i := range resp.History {
		resp.History[i] = sanitizeShadowCheckResponse(source, resp.History[i])
	}
	return resp
}

func sanitizeShadowCheckResponse(source canonical.SourcePlatform, resp shadowCheckResponse) shadowCheckResponse {
	if resp.Source != "" {
		source = resp.Source
	}
	resp.Error = sanitizeMigrationText(source, resp.Error)
	resp.Warnings = sanitizeStringSlice(source, resp.Warnings)
	resp.Blockers = sanitizeStringSlice(source, resp.Blockers)
	for i := range resp.Deltas {
		resp.Deltas[i].Notes = sanitizeStringSlice(source, resp.Deltas[i].Notes)
	}
	return resp
}

func normalizeShadowInterval(seconds int) int {
	if seconds <= 0 {
		return 3600
	}
	if seconds < 300 {
		return 300
	}
	if seconds > 7*24*3600 {
		return 7 * 24 * 3600
	}
	return seconds
}
