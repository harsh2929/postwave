package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
	"github.com/postwave/postwave/services/migration/internal/uploadstore"
)

// DeleteSourceSession removes our stored credentials and uploaded raw data.
// Provider-side grants/keys are deliberately not reported as revoked.
func (h *Migration) DeleteSourceSession(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, 401, fmt.Errorf("tenant header required"))
		return
	}
	id := chi.URLParam(r, "job_id")
	ctx := jobstore.WithTenantID(r.Context(), tenant)
	job, err := h.store.Get(ctx, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	lease, err := h.acquireJobExecution(ctx, tenant, id)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer lease.Release()
	job, err = h.store.Get(ctx, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if migrationJobSessionRefreshRunning(job.Status) {
		writeErr(w, http.StatusConflict, fmt.Errorf("stop the active migration before removing its source data"))
		return
	}
	// Serializes with credential rotation on every replica. Job-then-session is
	// the same order used by reconnect and worker initialization.
	refreshLease, err := orchestrator.AcquireMigrationSessionRefreshLease(ctx, h.db, tenant, id)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer refreshLease.Release()
	if monitors, ok := h.store.(jobstore.ShadowMonitorStore); ok {
		if err = monitors.DisableShadowMonitor(ctx, tenant, id); err != nil && !errors.Is(err, jobstore.ErrNotFound) {
			writeJobStoreErr(w, err)
			return
		}
	}
	if monitors, ok := h.store.(jobstore.SourceEventMonitorStore); ok {
		if err = monitors.DisableSourceEventMonitor(ctx, tenant, id); err != nil && !errors.Is(err, jobstore.ErrNotFound) {
			writeJobStoreErr(w, err)
			return
		}
	}
	// Persist a fence before erasure so an OAuth callback issued before this
	// cleanup cannot recreate credentials after a crash or a delayed redirect.
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	started := time.Now().UTC().Format(time.RFC3339Nano)
	job.Cursor["source_cleanup_started_at"] = &started
	if err = h.transitionJob(ctx, job, job.Status); err != nil {
		writeTransitionErr(w, err)
		return
	}
	// Delete the raw payload before the encrypted path so partial failures can
	// be retried using the durable upload identity on the job.
	if uploadID, ok := cursorString(job.Cursor, "upload_id"); ok && uploadID != "" {
		if !migrationUploadsAllowed() {
			writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("source upload storage is unavailable; retry cleanup when the shared mount is restored"))
			return
		}
		err = configuredUploadStore().Delete(ctx, tenant, string(job.Source), uploadID)
		if err != nil && !errors.Is(err, os.ErrNotExist) && !errors.Is(err, uploadstore.ErrDeleted) {
			writeUploadError(w, err)
			return
		}
	}
	if err = h.store.DeleteSession(ctx, tenant, id); err != nil && !errors.Is(err, jobstore.ErrNotFound) {
		writeJobStoreErr(w, err)
		return
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	job.Cursor["source_data_removed_at"] = &stamp
	if err = h.transitionJob(ctx, job, job.Status); err != nil {
		writeTransitionErr(w, err)
		return
	}
	h.decorateJobSessionInfo(ctx, tenant, job)
	writeJSON(w, http.StatusOK, map[string]interface{}{"job": job, "stored_source_data_removed": true, "provider_access_revoked": false})
}
