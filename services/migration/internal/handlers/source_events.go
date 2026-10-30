package handlers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

type sourceEventMonitorResponse struct {
	Monitor jobstore.SourceEventMonitorRecord `json:"monitor"`
	Events  []jobstore.SourceEventRecord      `json:"events"`
}

type sourceEventReviewRequest struct {
	Status   string   `json:"status"`
	Detail   string   `json:"detail"`
	Evidence []string `json:"evidence"`
}

const (
	maxSourceEventReviewEvidenceItems = 50
	maxSourceEventSyncPages           = 10000
	maxSourceEventSyncCursorBytes     = 64 << 10
)

var sourceEventReviewEmailPattern = regexp.MustCompile(`(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b`)

func (h *Migration) StartSourceEventMonitor(w http.ResponseWriter, r *http.Request) {
	store, ok := h.store.(jobstore.SourceEventMonitorStore)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("source-event monitoring requires a monitor-capable migration job store"))
		return
	}
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	ad, err := adapter.Get(source)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if _, ok := ad.(adapter.SourceEventAdapter); !ok {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("%s does not support incremental source events", source))
		return
	}
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
	job, err := h.loadJob(r.Context(), tenantID, body.JobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.Source != source {
		writeErr(w, http.StatusConflict, fmt.Errorf("job source %q does not match route source %q", job.Source, source))
		return
	}
	if err := requireCompletedSourceEventJob(job); err != nil {
		writeErr(w, http.StatusConflict, err)
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
	if err := requireCompletedSourceEventJob(job); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "source-event monitoring restart"); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if _, status, err := h.loadCutoverSession(r.Context(), tenantID, body.JobID, source, "starting source-event monitoring"); err != nil {
		if status != 0 {
			writeErr(w, status, err)
			return
		}
		writeJobStoreErr(w, err)
		return
	}
	interval := normalizeSourceEventInterval(body.IntervalSeconds)
	now := time.Now().UTC()
	monitor, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(r.Context(), tenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        tenantID,
		Source:          source,
		Enabled:         true,
		IntervalSeconds: interval,
		NextSyncAt:      &now,
	})
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	seen, applied, cursor, lastEventAt, syncErr := h.runSourceEventSyncUnderLease(r.Context(), monitor)
	errText := ""
	if syncErr != nil {
		errText = sanitizeMigrationErrorText(source, syncErr)
	}
	next := nextRetryAwareAttemptAt(now, time.Duration(interval)*time.Second, syncErr)
	if err := store.UpdateSourceEventMonitorAfterSync(jobstore.WithTenantID(r.Context(), tenantID), tenantID, job.ID, cursor, lastEventAt, now, next, seen, applied, errText); err != nil {
		writeJobStoreErr(w, err)
		return
	}
	monitor, _ = store.GetSourceEventMonitor(jobstore.WithTenantID(r.Context(), tenantID), tenantID, job.ID)
	events, _ := store.ListSourceEventResults(jobstore.WithTenantID(r.Context(), tenantID), tenantID, job.ID, 20)
	writeJSON(w, http.StatusAccepted, sanitizeSourceEventMonitorResponse(sourceEventMonitorResponse{Monitor: monitor, Events: events}))
}

func (h *Migration) GetSourceEventMonitor(w http.ResponseWriter, r *http.Request) {
	store, ok := h.store.(jobstore.SourceEventMonitorStore)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("source-event monitoring requires a monitor-capable migration job store"))
		return
	}
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	jobID := chi.URLParam(r, "job_id")
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	events, err := store.ListSourceEventResults(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID, 50)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	unresolved, err := store.ListFailedSourceEventResults(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID, 100)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	events = mergeSourceEventReplayEvidenceRows(events, unresolved)
	reviewed, err := store.ListReviewedSourceEventResults(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID, 100)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	// Keep failure-first/recent ordering, then append completed reviews that
	// would otherwise disappear as soon as an older pending row is resolved.
	events = mergeSourceEventReplayEvidenceRows(reviewed, events)
	writeJSON(w, http.StatusOK, sanitizeSourceEventMonitorResponse(sourceEventMonitorResponse{Monitor: monitor, Events: events}))
}

func (h *Migration) UpdateSourceEventReview(w http.ResponseWriter, r *http.Request) {
	store, ok := h.store.(jobstore.SourceEventMonitorStore)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("source-event review requires a monitor-capable migration job store"))
		return
	}
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	jobID := chi.URLParam(r, "job_id")
	eventID := strings.TrimSpace(chi.URLParam(r, "event_id"))
	if _, err := uuid.Parse(eventID); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("valid source-event result id required"))
		return
	}
	var in sourceEventReviewRequest
	if err := decodeRequestJSON(w, r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	status := strings.ToLower(strings.TrimSpace(in.Status))
	if !oneOf(status, "pending", "reviewed") {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("source-event review status must be pending or reviewed"))
		return
	}

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
	if err := requireCompletedSourceEventJob(job); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "source-event review"); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	record, err := store.GetSourceEventResultByID(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID, eventID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if record.Applied || !strings.EqualFold(strings.TrimSpace(record.Action), "manual_review") {
		writeErr(w, http.StatusConflict, fmt.Errorf("only unapplied manual-review source events can be reviewed; automatic replay failures must be fixed and replayed"))
		return
	}
	if record.Source != "" && record.Source != job.Source {
		writeErr(w, http.StatusConflict, fmt.Errorf("source-event result source does not match its migration job"))
		return
	}
	if job.Source == canonical.SourceActiveCampaign && !strings.EqualFold(strings.TrimSpace(record.ResourceType), "activecampaign_non_email_contact") {
		writeErr(w, http.StatusConflict, fmt.Errorf("only ActiveCampaign non-email contact review events can use this resolution workflow"))
		return
	}

	detail := ""
	evidence := []string{}
	var reviewedAt *time.Time
	if status == "reviewed" {
		if len(in.Evidence) > maxSourceEventReviewEvidenceItems {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("source-event review evidence supports at most %d references", maxSourceEventReviewEvidenceItems))
			return
		}
		trimmedDetail := strings.TrimSpace(in.Detail)
		if utf8.RuneCountInString(trimmedDetail) > maxCutoverEvidenceDetailChars {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("source-event review detail supports at most %d characters", maxCutoverEvidenceDetailChars))
			return
		}
		for _, item := range in.Evidence {
			trimmedItem := strings.TrimSpace(item)
			if trimmedItem == "" {
				writeErr(w, http.StatusBadRequest, fmt.Errorf("source-event review evidence references must not be blank"))
				return
			}
			if utf8.RuneCountInString(trimmedItem) > maxCutoverEvidenceItemChars {
				writeErr(w, http.StatusBadRequest, fmt.Errorf("source-event review evidence references support at most %d characters each", maxCutoverEvidenceItemChars))
				return
			}
		}
		detail = sanitizeSourceEventReviewText(job.Source, cleanCutoverEvidenceText(trimmedDetail, 0))
		evidence = cleanSourceEventReviewEvidence(in.Evidence)
		for i := range evidence {
			evidence[i] = sanitizeSourceEventReviewText(job.Source, evidence[i])
		}
		if detail == "" || len(evidence) == 0 {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("reviewed source events require both reconciliation detail and evidence"))
			return
		}
		now := time.Now().UTC()
		reviewedAt = &now
	}
	record, err = store.UpdateSourceEventReview(
		jobstore.WithTenantID(r.Context(), tenantID),
		tenantID,
		jobID,
		eventID,
		status,
		detail,
		evidence,
		reviewedAt,
	)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sanitizeSourceEventRecordForResponse(job.Source, record))
}

func (h *Migration) StopSourceEventMonitor(w http.ResponseWriter, r *http.Request) {
	store, ok := h.store.(jobstore.SourceEventMonitorStore)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("source-event monitoring requires a monitor-capable migration job store"))
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
	if r.URL.Query().Get("post_pilot_cleanup") == "1" {
		job, err := h.loadJob(r.Context(), tenantID, jobID)
		if err != nil {
			writeJobStoreErr(w, err)
			return
		}
		if !postPilotCleanupAuthorized(job) {
			writeErr(w, http.StatusConflict, fmt.Errorf("valid %s post-pilot cleanup authorization is required", pilotSourceDisplayName(job.Source)))
			return
		}
		if markPostPilotCleanupStarted(job, time.Now()) {
			if err := h.transitionJob(jobstore.WithTenantID(r.Context(), tenantID), job, job.Status); err != nil {
				writeTransitionErr(w, err)
				return
			}
		}
	}
	if err := store.DisableSourceEventMonitor(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID); err != nil {
		writeJobStoreErr(w, err)
		return
	}
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(r.Context(), tenantID), tenantID, jobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if monitor.Enabled {
		writeErr(w, http.StatusConflict, fmt.Errorf("source-event monitor disable did not persist"))
		return
	}
	sourceSessionCleared := false
	if r.URL.Query().Get("post_pilot_cleanup") == "1" && monitor.Source == canonical.SourceHubSpot {
		job, err := h.loadJob(r.Context(), tenantID, jobID)
		if err != nil {
			writeJobStoreErr(w, err)
			return
		}
		if err := h.clearHubSpotPostPilotSourceSession(jobstore.WithTenantID(r.Context(), tenantID), job, time.Now()); err != nil {
			writeJobStoreErr(w, err)
			return
		}
		sourceSessionCleared = true
	}
	writeJSON(w, http.StatusOK, map[string]any{"job_id": jobID, "enabled": false, "source_session_cleared": sourceSessionCleared})
}

func (h *Migration) StartSourceEventMonitorWorker(ctx context.Context, interval time.Duration) {
	if _, ok := h.store.(jobstore.SourceEventMonitorStore); !ok {
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
				if n, err := h.RunDueSourceEventSyncs(ctx, 25); err != nil {
					slog.Warn("migration: source-event worker failed", "err", err.Error())
				} else if n > 0 {
					slog.Info("migration: source-event syncs completed", "count", n)
				}
			}
		}
	}()
}

func (h *Migration) RunDueSourceEventSyncs(ctx context.Context, limit int) (int, error) {
	store, ok := h.store.(jobstore.SourceEventMonitorStore)
	if !ok {
		return 0, nil
	}
	now := time.Now().UTC()
	monitors, err := store.ListDueSourceEventMonitors(ctx, now, limit)
	if err != nil {
		return 0, err
	}
	for _, monitor := range monitors {
		executionLease, err := h.acquireJobExecution(ctx, monitor.TenantID, monitor.JobID)
		if err != nil {
			return 0, err
		}
		current, err := store.GetSourceEventMonitor(jobstore.WithTenantID(ctx, monitor.TenantID), monitor.TenantID, monitor.JobID)
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
			next := now.Add(time.Duration(normalizeSourceEventInterval(monitor.IntervalSeconds)) * time.Second)
			_, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(ctx, monitor.TenantID), jobstore.SourceEventMonitorRecord{
				JobID:           monitor.JobID,
				TenantID:        monitor.TenantID,
				Source:          monitor.Source,
				Enabled:         true,
				IntervalSeconds: normalizeSourceEventInterval(monitor.IntervalSeconds),
				Cursor:          monitor.Cursor,
				LastEventAt:     monitor.LastEventAt,
				NextSyncAt:      &next,
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
		seen, applied, cursor, lastEventAt, syncErr := h.runSourceEventSyncUnderLease(ctx, monitor)
		if errors.Is(syncErr, errActiveCampaignPostPilotCleanupFrozen) {
			if err := executionLease.Release(); err != nil {
				return 0, err
			}
			continue
		}
		errText := ""
		if syncErr != nil {
			errText = sanitizeMigrationErrorText(monitor.Source, syncErr)
		}
		next := nextRetryAwareAttemptAt(now, time.Duration(normalizeSourceEventInterval(monitor.IntervalSeconds))*time.Second, syncErr)
		if err := store.UpdateSourceEventMonitorAfterSync(jobstore.WithTenantID(ctx, monitor.TenantID), monitor.TenantID, monitor.JobID, cursor, lastEventAt, now, next, seen, applied, errText); err != nil {
			_ = executionLease.Release()
			return 0, err
		}
		if err := executionLease.Release(); err != nil {
			return 0, err
		}
	}
	return len(monitors), nil
}

func (h *Migration) runSourceEventSync(ctx context.Context, monitor jobstore.SourceEventMonitorRecord) (seen int, applied int, nextCursor string, lastEventAt *time.Time, err error) {
	nextCursor = monitor.Cursor
	executionLease, err := h.acquireJobExecution(ctx, monitor.TenantID, monitor.JobID)
	if err != nil {
		return 0, 0, nextCursor, nil, err
	}
	defer func() {
		if releaseErr := executionLease.Release(); releaseErr != nil && err == nil {
			err = fmt.Errorf("release source-event execution lease: %w", releaseErr)
		}
	}()
	return h.runSourceEventSyncUnderLease(ctx, monitor)
}

// runSourceEventSyncUnderLease performs one sync while the caller owns the
// job execution lease and has re-read the enabled monitor under that lease.
func (h *Migration) runSourceEventSyncUnderLease(ctx context.Context, monitor jobstore.SourceEventMonitorRecord) (seen int, applied int, nextCursor string, lastEventAt *time.Time, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			nextCursor = monitor.Cursor
			lastEventAt = nil
			err = fmt.Errorf("source-event sync panic: %v", rec)
		}
	}()
	nextCursor = monitor.Cursor

	job, err := h.loadJob(ctx, monitor.TenantID, monitor.JobID)
	if err != nil {
		return 0, 0, nextCursor, nil, err
	}
	if err := requireCompletedSourceEventJob(job); err != nil {
		return 0, 0, nextCursor, nil, err
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "source-event synchronization"); err != nil {
		return 0, 0, nextCursor, nil, err
	}
	ad, err := adapter.Get(monitor.Source)
	if err != nil {
		return 0, 0, nextCursor, nil, err
	}
	eventAdapter, ok := ad.(adapter.SourceEventAdapter)
	if !ok {
		return 0, 0, nextCursor, nil, fmt.Errorf("%s does not expose incremental source events yet", monitor.Source)
	}
	sess, err := h.loadSourceEventSession(ctx, monitor)
	if err != nil {
		return 0, 0, nextCursor, nil, err
	}
	accountExecutionLease, err := h.acquireActiveCampaignSessionExecution(ctx, job, sess)
	if err != nil {
		return 0, 0, nextCursor, nil, err
	}
	defer func() {
		if releaseErr := accountExecutionLease.Release(); releaseErr != nil && err == nil {
			err = fmt.Errorf("release source-event account execution lease: %w", releaseErr)
		}
	}()
	store, _ := h.store.(jobstore.SourceEventMonitorStore)
	apply := h.applySourceEvent
	if h.sourceEventApply != nil {
		apply = h.sourceEventApply
	}
	since := sourceEventSince(job, monitor)
	cursor := monitor.Cursor
	seenCursors := map[[sha256.Size]byte]struct{}{}
	pageCalls := 0
	for {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return seen, applied, monitor.Cursor, nil, ctxErr
		}
		job, err = h.loadJob(ctx, monitor.TenantID, monitor.JobID)
		if err != nil {
			return seen, applied, monitor.Cursor, nil, err
		}
		if err := requireCompletedSourceEventJob(job); err != nil {
			return seen, applied, monitor.Cursor, nil, err
		}
		if pageCalls >= maxSourceEventSyncPages {
			return seen, applied, monitor.Cursor, nil, fmt.Errorf("source-event pagination exceeded the safe %d-page sync limit", maxSourceEventSyncPages)
		}
		if len(cursor) > maxSourceEventSyncCursorBytes {
			return seen, applied, monitor.Cursor, nil, fmt.Errorf("source-event pagination returned an oversized provider cursor")
		}
		cursorDigest := sha256.Sum256(append([]byte("postwave-source-event-cursor-v1\x00"), []byte(cursor)...))
		if _, ok := seenCursors[cursorDigest]; ok {
			return seen, applied, monitor.Cursor, nil, fmt.Errorf("source-event pagination repeated a provider cursor")
		}
		seenCursors[cursorDigest] = struct{}{}
		pageCalls++
		batch, err := eventAdapter.ListSourceEvents(ctx, sess, since, cursor, 100)
		if err != nil {
			return seen, applied, monitor.Cursor, nil, err
		}
		if batch.NextCursor != "" && len(batch.Events) == 0 && batch.HighWatermark.IsZero() {
			return seen, applied, monitor.Cursor, nil, fmt.Errorf("source-event pagination returned a next cursor without events or a source watermark")
		}
		for _, event := range batch.Events {
			job, err = h.loadJob(ctx, monitor.TenantID, monitor.JobID)
			if err != nil {
				return seen, applied, monitor.Cursor, nil, err
			}
			if err := requireCompletedSourceEventJob(job); err != nil {
				return seen, applied, monitor.Cursor, nil, err
			}
			index := seen
			seen++
			eventID := sourceEventID(*job, event, index)
			if store != nil {
				existing, lookupErr := store.GetSourceEventResult(jobstore.WithTenantID(ctx, monitor.TenantID), monitor.TenantID, monitor.JobID, eventID)
				if lookupErr != nil && !errors.Is(lookupErr, jobstore.ErrNotFound) {
					label := sourceEventReplayFailureLabel(normalizeSourceEventRecord(*job, event, index, jobstore.SourceEventRecord{}))
					return seen, applied, monitor.Cursor, nil, fmt.Errorf("lookup source-event result for %s: %w", label, lookupErr)
				}
				if lookupErr == nil && sourceEventAlreadyHandled(existing, event) {
					if !event.OccurredAt.IsZero() {
						t := event.OccurredAt.UTC()
						if lastEventAt == nil || t.After(*lastEventAt) {
							lastEventAt = &t
						}
					}
					continue
				}
			}
			record, ok := apply(ctx, *job, event, index)
			record = normalizeSourceEventRecord(*job, event, index, record)
			if ok {
				applied++
				record.Applied = true
			}
			record = sanitizeSourceEventRecord(job.Source, record)
			if store != nil {
				if saveErr := store.SaveSourceEventResult(jobstore.WithTenantID(ctx, monitor.TenantID), record); saveErr != nil && err == nil {
					return seen, applied, monitor.Cursor, nil, fmt.Errorf("save source-event result for %s: %w", sourceEventReplayFailureLabel(record), saveErr)
				}
			}
			if !ok && sourceEventRequiresAutomaticReplay(event) {
				return seen, applied, monitor.Cursor, nil, sourceEventReplayError(*job, event, index, record)
			}
			if !event.OccurredAt.IsZero() {
				t := event.OccurredAt.UTC()
				if lastEventAt == nil || t.After(*lastEventAt) {
					lastEventAt = &t
				}
			}
		}
		if !batch.HighWatermark.IsZero() {
			t := batch.HighWatermark.UTC()
			if lastEventAt == nil || t.After(*lastEventAt) {
				lastEventAt = &t
			}
		}
		if batch.NextCursor == "" {
			nextCursor = ""
			return seen, applied, nextCursor, lastEventAt, err
		}
		cursor = batch.NextCursor
	}
}

func (h *Migration) loadSourceEventSession(ctx context.Context, monitor jobstore.SourceEventMonitorRecord) (adapter.Session, error) {
	sess, err := h.loadSession(ctx, monitor.TenantID, monitor.JobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		return adapter.Session{}, fmt.Errorf("source session expired; reconnect source before source-event replay")
	}
	return sess, err
}

func sourceEventAlreadyHandled(existing jobstore.SourceEventRecord, event canonical.SourceEvent) bool {
	if existing.Applied {
		return true
	}
	return !sourceEventRequiresAutomaticReplay(event)
}

func normalizeSourceEventRecord(job canonical.MigrationJob, event canonical.SourceEvent, index int, record jobstore.SourceEventRecord) jobstore.SourceEventRecord {
	if record.JobID == "" {
		record.JobID = job.ID
	}
	if record.TenantID == "" {
		record.TenantID = job.TenantID
	}
	if record.Source == "" {
		record.Source = event.SourcePlatform
	}
	if record.Source == "" {
		record.Source = job.Source
	}
	if strings.TrimSpace(record.SourceEventID) == "" {
		record.SourceEventID = sourceEventID(job, event, index)
	}
	if strings.TrimSpace(record.ResourceType) == "" {
		record.ResourceType = strings.TrimSpace(event.ResourceType)
	}
	if strings.TrimSpace(record.ResourceType) == "" {
		record.ResourceType = "unknown"
	}
	if strings.TrimSpace(record.Action) == "" {
		record.Action = strings.TrimSpace(event.Action)
	}
	if strings.TrimSpace(record.Action) == "" {
		record.Action = "manual_review"
	}
	if strings.TrimSpace(record.ReviewStatus) == "" {
		record.ReviewStatus = "pending"
	}
	if record.OccurredAt == nil && !event.OccurredAt.IsZero() {
		t := event.OccurredAt.UTC()
		record.OccurredAt = &t
	}
	if len(record.Payload) == 0 {
		record.Payload = marshalSourceEvent(event)
	}
	return record
}

func sourceEventRequiresAutomaticReplay(event canonical.SourceEvent) bool {
	return strings.EqualFold(strings.TrimSpace(event.Action), "upsert") &&
		strings.EqualFold(strings.TrimSpace(event.ResourceType), "subscriber") &&
		event.Subscriber != nil
}

func sourceEventReplayError(job canonical.MigrationJob, event canonical.SourceEvent, index int, record jobstore.SourceEventRecord) error {
	msg := strings.TrimSpace(sanitizeMigrationText(job.Source, record.Error))
	if msg == "" {
		msg = "automatic replay failed"
	}
	return fmt.Errorf("source-event replay failed for %s: %s", sourceEventReplayFailureLabel(record), msg)
}

func sanitizeSourceEventMonitorResponse(resp sourceEventMonitorResponse) sourceEventMonitorResponse {
	source := resp.Monitor.Source
	resp.Monitor.Cursor = sanitizeMigrationText(source, resp.Monitor.Cursor)
	resp.Monitor.LastError = sanitizeMigrationText(source, resp.Monitor.LastError)
	for i := range resp.Events {
		resp.Events[i] = sanitizeSourceEventRecordForResponse(source, resp.Events[i])
	}
	return resp
}

func sanitizeSourceEventRecord(source canonical.SourcePlatform, rec jobstore.SourceEventRecord) jobstore.SourceEventRecord {
	if rec.Source != "" {
		source = rec.Source
	}
	rec.Error = sanitizeMigrationText(source, rec.Error)
	rec.ReviewDetail = sanitizeSourceEventReviewText(source, cleanCutoverEvidenceText(rec.ReviewDetail, 0))
	rec.ReviewEvidence = cleanSourceEventReviewEvidence(rec.ReviewEvidence)
	for i := range rec.ReviewEvidence {
		rec.ReviewEvidence[i] = sanitizeSourceEventReviewText(source, rec.ReviewEvidence[i])
	}
	return rec
}

// cleanSourceEventReviewEvidence deliberately does not reuse
// cleanCutoverEvidence: cutover checklist evidence is capped at 20 entries,
// while the source-event review contract permits 50. The write handler rejects
// requests above that limit before cleaning, so no accepted reference is
// silently discarded. Response sanitization also preserves every stored entry.
func cleanSourceEventReviewEvidence(items []string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		value := cleanCutoverEvidenceText(item, 0)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func sanitizeSourceEventReviewText(source canonical.SourcePlatform, value string) string {
	return sourceEventReviewEmailPattern.ReplaceAllString(sanitizeMigrationText(source, value), "[redacted-email]")
}

func sanitizeSourceEventRecordForResponse(source canonical.SourcePlatform, rec jobstore.SourceEventRecord) jobstore.SourceEventRecord {
	rec = sanitizeSourceEventRecord(source, rec)
	if rec.Source != "" {
		source = rec.Source
	}
	if migrationSensitiveSource(source) {
		switch source {
		case canonical.SourceActiveCampaign:
			rec.SourceEventID = "[redacted-activecampaign-source-event-id]"
		case canonical.SourceHubSpot:
			rec.SourceEventID = "[redacted-hubspot-source-event-id]"
		default:
			rec.SourceEventID = sanitizeMigrationText(source, rec.SourceEventID)
		}
		rec.Payload = json.RawMessage(`{}`)
	}
	return rec
}

func requireCompletedSourceEventJob(job *canonical.MigrationJob) error {
	if job == nil {
		return fmt.Errorf("source-event monitoring requires a completed migration job")
	}
	if job.Status != canonical.MigCompleted {
		return fmt.Errorf("source-event monitoring requires a completed migration job; current status is %q", job.Status)
	}
	return nil
}

func sourceEventSince(job *canonical.MigrationJob, monitor jobstore.SourceEventMonitorRecord) time.Time {
	if monitor.LastEventAt != nil {
		return *monitor.LastEventAt
	}
	if job != nil && !job.StartedAt.IsZero() {
		return job.StartedAt
	}
	if job != nil && job.CompletedAt != nil {
		return *job.CompletedAt
	}
	return time.Time{}
}

func (h *Migration) applySourceEvent(ctx context.Context, job canonical.MigrationJob, event canonical.SourceEvent, index int) (jobstore.SourceEventRecord, bool) {
	record := jobstore.SourceEventRecord{
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        event.SourcePlatform,
		SourceEventID: sourceEventID(job, event, index),
		ResourceType:  strings.TrimSpace(event.ResourceType),
		Action:        strings.TrimSpace(event.Action),
		Applied:       false,
		Payload:       marshalSourceEvent(event),
	}
	if record.Source == "" {
		record.Source = job.Source
	}
	if record.ResourceType == "" {
		record.ResourceType = "unknown"
	}
	if record.Action == "" {
		record.Action = "manual_review"
	}
	if !event.OccurredAt.IsZero() {
		t := event.OccurredAt.UTC()
		record.OccurredAt = &t
	}

	switch {
	case record.Action == "upsert" && record.ResourceType == "subscriber" && event.Subscriber != nil:
		client, err := h.listmonkClientForJob(ctx, &job)
		if err != nil {
			record.Error = sanitizeMigrationText(job.Source, err.Error())
			return record, false
		}
		if err := client.ValidateMigrationIsolation(job.TenantID); err != nil {
			record.Error = sanitizeMigrationText(job.Source, fmt.Sprintf("source-event replay tenant isolation: %v", err))
			return record, false
		}
		if h.db == nil {
			record.Error = "source-event replay requires Moosewave DB persistence before destination writes"
			return record, false
		}

		var audienceMappings map[string]listmonkx.AudienceMapping
		if sourceEventNeedsAudienceMappings(job, event) {
			audienceMappings, err = listmonkx.LoadAudienceMappings(ctx, h.db, job.TenantID, job.ID, job.Source)
			if err != nil {
				record.Error = sanitizeMigrationText(job.Source, fmt.Sprintf("load source-event audience mappings: %v", err))
				return record, false
			}
		}

		res := listmonkx.WriteSubscribers(ctx, client, []canonical.Subscriber{*event.Subscriber}, sourceEventSubscriberWriteOptions(job, event, h.db, audienceMappings)...)
		if res.Failed > 0 || len(res.Errors) > 0 {
			record.Error = sanitizeMigrationText(job.Source, joinErrors(res.Errors))
			return record, false
		}
		record.Applied = true
		return record, true
	default:
		record.Error = "captured for review; no automatic replay for this source-event type"
		return record, false
	}
}

func sourceEventSubscriberWriteOptions(job canonical.MigrationJob, event canonical.SourceEvent, db *sql.DB, audienceMappings map[string]listmonkx.AudienceMapping) []listmonkx.WriteOption {
	opts := []listmonkx.WriteOption{
		listmonkx.WithMigrationJobID(job.ID),
		listmonkx.WithTenantPersistence(db, job.TenantID),
		listmonkx.WithAudienceMappings(audienceMappings),
	}
	policy := sourceEventSubscriberAuthority(job, event)
	if policy.status {
		opts = append(opts, listmonkx.WithAuthoritativeStatus())
	}
	if policy.tags {
		opts = append(opts, listmonkx.WithAuthoritativeTags())
	}
	if policy.fields {
		opts = append(opts, listmonkx.WithAuthoritativeFields())
	}
	if policy.preserveSourceAudiences {
		opts = append(opts, listmonkx.WithPreservedSourceAudienceProjection())
	}
	if policy.guardSourceEmailMove {
		opts = append(opts, listmonkx.WithSourceIdentityEmailGuard())
	}
	return opts
}

type sourceEventSubscriberAuthorityPolicy struct {
	status                  bool
	tags                    bool
	fields                  bool
	preserveSourceAudiences bool
	guardSourceEmailMove    bool
}

func sourceEventSubscriberAuthority(job canonical.MigrationJob, event canonical.SourceEvent) sourceEventSubscriberAuthorityPolicy {
	sources := []canonical.SourcePlatform{job.Source, event.SourcePlatform}
	policy := sourceEventSubscriberAuthorityPolicy{}
	for _, source := range sources {
		switch source {
		case canonical.SourceActiveCampaign:
			policy.status = true
			policy.tags = true
			policy.fields = true
		case canonical.SourceHubSpot:
			policy.status = true
			// Contact polling returns the complete current contact-property
			// projection and an exact list-membership snapshot for each
			// changed contact. Clear values and memberships removed from that
			// contact, but reject primary-email moves until the mandatory
			// final full snapshot can reconcile both destination identities.
			policy.tags = true
			policy.fields = true
			policy.guardSourceEmailMove = true
		case canonical.SourceKlaviyo:
			// The profiles feed is a complete source of status and profile
			// fields, but it does not prove current list/segment membership.
			// Preserve the last full-snapshot audience projection until the
			// mandatory final snapshot refreshes it authoritatively.
			policy.status = true
			policy.fields = true
			policy.preserveSourceAudiences = true
			policy.guardSourceEmailMove = true
		}
	}
	return policy
}

func sourceEventNeedsAudienceMappings(job canonical.MigrationJob, event canonical.SourceEvent) bool {
	if job.Source == canonical.SourceMailchimp || event.SourcePlatform == canonical.SourceMailchimp {
		return true
	}
	if event.Subscriber == nil {
		return false
	}
	for _, tag := range event.Subscriber.Tags {
		if strings.HasPrefix(strings.TrimSpace(tag), "mailchimp:list:") {
			return true
		}
	}
	return false
}

func sourceEventStatusAuthoritative(job canonical.MigrationJob, event canonical.SourceEvent) bool {
	return sourceEventSubscriberAuthority(job, event).status
}

func sourceEventStatusAuthoritativeSource(source canonical.SourcePlatform) bool {
	switch source {
	case canonical.SourceActiveCampaign, canonical.SourceHubSpot, canonical.SourceKlaviyo:
		return true
	default:
		return false
	}
}

func sourceEventID(job canonical.MigrationJob, event canonical.SourceEvent, index int) string {
	if strings.TrimSpace(event.SourceID) != "" {
		return event.SourceID
	}
	occurred := "unknown"
	if !event.OccurredAt.IsZero() {
		occurred = event.OccurredAt.UTC().Format(time.RFC3339Nano)
	}
	return fmt.Sprintf("%s:%s:%s:%s:%d", job.Source, event.ResourceType, event.Action, occurred, index)
}

func marshalSourceEvent(event canonical.SourceEvent) json.RawMessage {
	raw, err := json.Marshal(event)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return raw
}

func joinErrors(errs []error) string {
	if len(errs) == 0 {
		return "unknown error"
	}
	parts := make([]string, 0, len(errs))
	for _, err := range errs {
		if err != nil {
			parts = append(parts, err.Error())
		}
	}
	if len(parts) == 0 {
		return "unknown error"
	}
	return strings.Join(parts, "; ")
}

func normalizeSourceEventInterval(seconds int) int {
	if seconds <= 0 {
		return 300
	}
	if seconds < 60 {
		return 60
	}
	if seconds > 24*3600 {
		return 24 * 3600
	}
	return seconds
}
