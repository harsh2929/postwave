// Package handlers wires Pillar 3 HTTP routes onto chi.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/services/voice/internal/fidelity"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/quota"
)

const (
	minProfileBuildWords               = 3000
	voiceHandlerJSONMaxBodyBytes int64 = 1 << 20
)

// VoiceStore is the persistence contract behind these handlers.
//
// V1 implementations may use an in-memory store; production wiring composes
// the Postgres-backed stores under internal/storage.
type VoiceStore interface {
	RegisterSource(ctx context.Context, tenantID string, sourceType ingest.SourceType, params ingest.IngestParams) (string, error)
	ListSources(ctx context.Context, tenantID string) ([]SourceRecord, error)
	GetSource(ctx context.Context, tenantID, sourceID string) (SourceRecord, error)
	DeleteSource(ctx context.Context, tenantID, sourceID string) error
	RecordIngest(ctx context.Context, tenantID, sourceID string, items []ingest.Item) error
	ListItems(ctx context.Context, tenantID string) ([]ingest.Item, error)
	SaveProfile(ctx context.Context, p profile.VoiceProfile) error
	GetProfile(ctx context.Context, tenantID string) (profile.VoiceProfile, error)
}

// SourceRecord is the durable record for a registered source.
type SourceRecord struct {
	ID            string              `json:"id"`
	TenantID      string              `json:"tenant_id"`
	Type          ingest.SourceType   `json:"type"`
	Params        ingest.IngestParams `json:"params"`
	LastIngest    time.Time           `json:"last_ingested_at,omitempty"`
	LastItemCount int                 `json:"last_item_count"`
}

// SourceSummary is the least-privilege list projection exposed to campaign
// readers. SourceRecord.Params can contain paste-in corpus text, tenant ids,
// local archive paths, connector knobs, and credential-like URL query values;
// those remain available only to the internal ingestion path via GetSource.
type SourceSummary struct {
	ID            string            `json:"id"`
	Type          ingest.SourceType `json:"type"`
	Label         string            `json:"label"`
	LastIngest    *time.Time        `json:"last_ingested_at,omitempty"`
	LastItemCount int               `json:"last_item_count"`
}

// IngestJob is the polling-shape view of a /sources/{id}/ingest run. The
// fields mirror jobstore.Job; we duplicate the type here to keep the handler
// package free of the Postgres jobstore import.
type IngestJob struct {
	ID           string     `json:"id"`
	TenantID     string     `json:"tenant_id"`
	SourceID     string     `json:"source_id"`
	Status       string     `json:"status"`
	ItemCount    int        `json:"item_count"`
	ErrorMessage string     `json:"error_message,omitempty"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// IngestJobStore is the contract behind the polling endpoint. Production
// wires the Postgres-backed jobstore.Store via a tiny adapter; tests can
// supply an in-memory shim. When nil, the handler falls back to fire-and-
// forget — the response still returns a job_id but polls always 404.
type IngestJobStore interface {
	Create(ctx context.Context, tenantID, sourceID string) (string, error)
	Start(ctx context.Context, tenantID, jobID string) error
	Succeed(ctx context.Context, tenantID, jobID string, itemCount int) error
	Fail(ctx context.Context, tenantID, jobID, errMsg string) error
	Get(ctx context.Context, tenantID, jobID string) (IngestJob, error)
}

// ErrNotFound is returned by stores when a record is missing.
var ErrNotFound = errors.New("voice: not found")

// Handler bundles dependencies for the chi routes.
type Handler struct {
	Registry *ingest.Registry
	Store    VoiceStore
	Builder  *profile.Builder
	// IngestJobs persists job state for /sources/{id}/ingest. When nil,
	// the handler falls back to fire-and-forget (the legacy V1 shape).
	IngestJobs IngestJobStore
	// SequenceJobs exposes historical sequence-generation jobs to the polling
	// endpoint. Until a durable worker owns generation atomically, wiring this
	// store makes new template-backed generation fail closed with 503. Dev/tests
	// may leave it nil to exercise the bounded synchronous path.
	SequenceJobs SequenceJobStore
	// FanoutEmitter, when non-nil, writes a webhook.fanout outbox row
	// whenever a sequence is generated so apps/api can fan out to
	// tenant subscriptions. nil disables (test/dev).
	FanoutEmitter FanoutEmitter
	// Chat powers the desktop "Moosewave AI" chat panel via /generate.
	// Nil disables the route — the handler returns 503 in that case so
	// the UI can show a clear "configure GEMINI_API_KEY" hint.
	Chat ChatStreamer
	// Quota gates every LLM call by per-tenant monthly AI credits. Nil falls
	// back to NoopQuota (always allows) so dev / tests don't need to
	// wire a Postgres pool. Production wires PostgresQuota in main.go.
	Quota quota.Quota
	// RegressionEvaluator is the production fidelity evaluator used by the
	// internal regression endpoint. It is intentionally separate from the
	// heuristic drift fallback: an evidence run fails closed when the qualified
	// evaluator is unavailable.
	RegressionEvaluator fidelity.Evaluator
	// RegressionRuntime is the server-attested model/prompt identity. Callers
	// must request this exact identity; a free-form client label can never select
	// or impersonate a runtime.
	RegressionRuntime RegressionRuntimeIdentity
	// Participants serves derived per-subscriber sequence state for
	// GET /sequences/{id}/participants. Postgres-only (reads
	// sequence_funnel_events); nil makes the endpoint return a retryable 503.
	Participants SequenceParticipantStore
	// Performance serves aggregate send performance (reached/opened/clicked
	// per email position + a sequence rollup) for GET
	// /sequences/{id}/performance (SEQ-009). Postgres-only, same
	// sequence_funnel_events source as Participants; nil → retryable 503.
	Performance SequencePerformanceStore
	// Activity serves raw per-subscriber activity aggregates for the
	// stuck-participant report (GET /sequences/{id}/stuck) and the
	// stuck scanner worker. Postgres-only like Participants; nil makes
	// the endpoint return a retryable 503.
	Activity SequenceActivityStore
	// Enrollments is the retained read model for future goal progress support.
	// The public route remains unmounted until the sequence runtime enforces
	// exit-on-goal semantics end to end.
	Enrollments SequenceEnrollmentStore
	// TenantFromRequest extracts the tenant ID from the inbound request.
	// Default uses the X-Tenant-ID header so chi/auth middleware can be
	// swapped in later without changing handlers.
	TenantFromRequest func(*http.Request) string

	// gen holds optional generation collaborators (engine + template store
	// + sequence store). Installed via WithGeneration. When nil, the
	// generation routes are not mounted.
	gen GenerationDeps
}

// RegressionRuntimeIdentity binds a replay receipt to what the Voice service
// actually executed. PromptPolicyVersion changes whenever the replay prompt,
// schema, or projection changes.
type RegressionRuntimeIdentity struct {
	Provider            string `json:"provider"`
	ModelID             string `json:"model_id"`
	PromptPolicyVersion string `json:"prompt_policy_version"`
}

// FanoutEmitter is the narrow interface for emitting webhook.fanout
// outbox rows. The Postgres-backed implementation lives in fanout.go.
type FanoutEmitter interface {
	Emit(ctx context.Context, tenantID, eventType string, body any) error
}

// SequenceJob is the polling-shape view of a generation run. Mirrors
// seqjobstore.Job verbatim; we duplicate the type here so the handlers
// package stays free of the seqjobstore import.
type SequenceJob struct {
	ID            string     `json:"id"`
	TenantID      string     `json:"tenant_id"`
	SequenceID    string     `json:"sequence_id,omitempty"`
	EmailPosition *int       `json:"email_position,omitempty"`
	Status        string     `json:"status"`
	ErrorMessage  string     `json:"error_message,omitempty"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	FinishedAt    *time.Time `json:"finished_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// SequenceJobStore is the persisted historical-job contract. New
// template-backed generation does not write it until a durable worker exists;
// the polling methods remain available to resolve rows created by older
// deployments. Regeneration candidates intentionally do not use this store.
type SequenceJobStore interface {
	Create(ctx context.Context, tenantID, sequenceID string, emailPosition *int, request any) (string, error)
	Start(ctx context.Context, tenantID, jobID string) error
	Succeed(ctx context.Context, tenantID, jobID, sequenceID string) error
	Fail(ctx context.Context, tenantID, jobID, errMsg string) error
	Get(ctx context.Context, tenantID, jobID string) (SequenceJob, error)
}

// WithIngestJobs installs an IngestJobStore. Call before Routes(). Returns
// the receiver so it composes with NewHandler in main.go.
func (h *Handler) WithIngestJobs(s IngestJobStore) *Handler {
	h.IngestJobs = s
	return h
}

// AutoRebuildThreshold caps the cumulative new-item count between
// auto-rebuilds. Set to 0 to disable; default 50.
//
// Why 50: Claude profile-build prompts run on the most recent N
// representative samples. New items below 50 are unlikely to shift
// the inferred tone enough to be worth a rebuild + the cost. Above
// 50 the new content's signature has probably moved.
const AutoRebuildThreshold = 50

// AsyncJobStaleAfter bounds "pending/running forever" states after a host
// crash. Legacy workers used a 5 minute timeout; 10 minutes lets polling
// classify historical pending/running rows without leaving them active forever.
const AsyncJobStaleAfter = 10 * time.Minute

// maybeAutoRebuildProfile fires a profile.Build() in the background
// when the tenant's cumulative new-item count since their last build
// crosses AutoRebuildThreshold. Idempotent (no-op when the threshold
// hasn't been crossed) + best-effort (a build failure doesn't bubble
// up to the ingest call site that triggered it).
//
// We track "items since last build" via voice_profiles.built_at +
// voice_items.created_at so no extra schema is needed — the threshold
// query is COUNT(items WHERE created_at > built_at).
func (h *Handler) maybeAutoRebuildProfile(ctx context.Context, tenantID string, addedThisRun int) {
	if h == nil || h.Builder == nil || tenantID == "" || addedThisRun <= 0 {
		return
	}
	// Cheap pre-check: skip if this run alone didn't add enough to
	// possibly cross. Real "since last build" count happens server-
	// side in the Store; this avoids a DB roundtrip on tiny runs.
	if addedThisRun < AutoRebuildThreshold && !h.likelyOverThreshold(ctx, tenantID) {
		return
	}
	// Run rebuild in a detached goroutine — same context lifetime
	// pattern as the ingest worker itself. 5min cap matches the
	// generation engine's outer Claude bound.
	if !startBoundedVoiceJob(profileBuildSlots, func() {
		buildCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := h.quotaOrNoop().CheckAndConsume(buildCtx, tenantID, "profile_auto_rebuild", quota.CostMilliCredits("profile_auto_rebuild", 1)); err != nil {
			slog.WarnContext(buildCtx, "voice profile auto-rebuild skipped by AI allowance", "tenant_id", tenantID, "error", err)
			return
		}
		items, err := h.Store.ListItems(buildCtx, tenantID)
		if err != nil {
			return
		}
		b := *h.Builder
		b.TenantID = tenantID
		prof, err := b.Build(buildCtx, items)
		if err != nil {
			return
		}
		_ = h.Store.SaveProfile(buildCtx, prof)
	}, func(recovered any, stack []byte) {
		slog.Error("voice profile auto-rebuild panic", "tenant_id", tenantID, "panic", recovered, "stack", string(stack))
	}) {
		slog.Warn("voice profile auto-rebuild skipped: worker capacity exhausted", "tenant_id", tenantID)
	}
}

// likelyOverThreshold returns true when the tenant has accumulated
// >= AutoRebuildThreshold items SINCE their last build. Best-effort:
// errors fall back to false (skip the rebuild rather than risk
// firing on every ingest).
//
// Counting via ListItems is O(N) — acceptable because (a) tenants
// don't have huge item totals at this scale, (b) the alternative
// (a tracker column on voice_profiles) is more state to keep in
// sync. Trade simplicity for cost.
func (h *Handler) likelyOverThreshold(ctx context.Context, tenantID string) bool {
	prof, err := h.Store.GetProfile(ctx, tenantID)
	if err != nil {
		// No profile yet — first ingest threshold is the same as
		// rebuild threshold; let the caller decide on addedThisRun.
		return false
	}
	items, err := h.Store.ListItems(ctx, tenantID)
	if err != nil {
		return false
	}
	added := 0
	for _, it := range items {
		// Items with a published-at AFTER the last profile build count
		// toward the threshold. PublishedAt zero values can't beat
		// GeneratedAt so they're safely ignored.
		if it.PublishedAt.After(prof.GeneratedAt) {
			added++
			if added >= AutoRebuildThreshold {
				return true
			}
		}
	}
	return false
}

// WithSequenceJobs installs the historical polling store. While no durable
// worker is configured, its presence also makes new template-backed sequence
// generation fail closed instead of starting detached work.
func (h *Handler) WithSequenceJobs(s SequenceJobStore) *Handler {
	h.SequenceJobs = s
	return h
}

// WithFanoutEmitter installs a FanoutEmitter. Call before Routes().
func (h *Handler) WithFanoutEmitter(e FanoutEmitter) *Handler {
	h.FanoutEmitter = e
	return h
}

// New constructs a Handler with sensible defaults.
func New(reg *ingest.Registry, store VoiceStore, builder *profile.Builder) *Handler {
	return &Handler{
		Registry: reg,
		Store:    store,
		Builder:  builder,
		TenantFromRequest: func(r *http.Request) string {
			return r.Header.Get("X-Tenant-ID")
		},
	}
}

// WithChat installs an LLM streamer so the /generate (chat) route can
// power the desktop AI panel. Returns the receiver so it can be chained
// alongside the other With* helpers in main.go.
func (h *Handler) WithChat(c ChatStreamer) *Handler {
	h.Chat = c
	return h
}

// WithQuota installs a per-tenant Quota gate. Call before Routes(). A
// nil quota is replaced with NoopQuota internally so handlers can call
// h.quotaOrNoop() without a nil-check on every LLM call.
func (h *Handler) WithQuota(q quota.Quota) *Handler {
	h.Quota = q
	return h
}

// WithRegressionRuntime installs the qualified evaluator and server-owned
// runtime identity for the internal replay endpoint.
func (h *Handler) WithRegressionRuntime(
	evaluator fidelity.Evaluator,
	runtime RegressionRuntimeIdentity,
) *Handler {
	h.RegressionEvaluator = evaluator
	h.RegressionRuntime = runtime
	return h
}

// quotaOrNoop returns h.Quota or a NoopQuota when nil. Used by every
// LLM call site so the unwired-in-tests path doesn't need a guard.
func (h *Handler) quotaOrNoop() quota.Quota {
	if h.Quota == nil {
		return quota.NoopQuota{}
	}
	return h.Quota
}

// Routes returns a chi router mounted under /v1/voice.
func (h *Handler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Post("/sources", h.registerSource)
	r.Get("/sources", h.listSources)
	r.Post("/sources/{id}/ingest", h.kickIngest)
	r.Get("/sources/{id}/ingest/{job_id}", h.getIngestJob)
	r.Delete("/sources/{id}", h.deleteSource)
	r.Get("/profile", h.getProfile)
	r.Post("/profile/build", h.buildProfile)
	// Chat (Moosewave AI panel). Always mounted — the handler itself
	// returns 503 if h.Chat is nil so callers can detect the gap.
	r.Post("/generate", h.generate)
	// Voice drift check: given a proposed email body, return a 0..100
	// fidelity score + per-component breakdown + a "warn" flag that
	// the desktop pre-send UI can render. Pure heuristic when no
	// embedding client is configured.
	r.Post("/drift", h.driftCheck)
	// AI-output regression harness (#1): replay a tenant's golden set
	// through the current model config and score each output against the
	// voice profile. Internal-only (the whole /v1 group is internalauth-
	// gated in main.go); apps/api calls it to run a regression batch.
	r.Post("/regression/replay-batch", h.replayBatch)
	if h.gen.Engine != nil && h.gen.Templates != nil && h.gen.Sequences != nil {
		h.genRoutes(r)
	}
	return r
}

// --- requests / responses ---

type registerSourceReq struct {
	Type   ingest.SourceType   `json:"type"`
	Params ingest.IngestParams `json:"params"`
}

type registerSourceResp struct {
	SourceID string `json:"source_id"`
}

type ingestResp struct {
	JobID  string `json:"job_id"`
	Status string `json:"status,omitempty"`
}

// --- handlers ---

func (h *Handler) registerSource(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	var req registerSourceReq
	if err := decodeRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &req); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	if _, err := h.Registry.Get(req.Type); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req.Params = ingest.NormalizeParams(req.Type, req.Params)
	req.Params.TenantID = tenant
	if err := ingest.ValidateParams(r.Context(), req.Type, req.Params); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	id, err := h.Store.RegisterSource(r.Context(), tenant, req.Type, req.Params)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, registerSourceResp{SourceID: id})
}

func (h *Handler) listSources(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	rows, err := h.Store.ListSources(r.Context(), tenant)
	if err != nil {
		http.Error(w, "could not list voice sources", http.StatusInternalServerError)
		return
	}
	summaries := make([]SourceSummary, 0, len(rows))
	for _, row := range rows {
		summaries = append(summaries, sourceSummary(row))
	}
	writeJSON(w, http.StatusOK, summaries)
}

func sourceSummary(source SourceRecord) SourceSummary {
	label := string(source.Type)
	if parsed, err := url.Parse(strings.TrimSpace(source.Params.FeedURL)); err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" {
		// A source URL is useful recognition context, but query/fragment values
		// can carry signed tokens or campaign identifiers and are not needed by
		// this list surface. Userinfo is omitted defensively even though source
		// registration rejects it.
		label = (&url.URL{Scheme: parsed.Scheme, Host: parsed.Host, Path: parsed.Path}).String()
	}
	var lastIngest *time.Time
	if !source.LastIngest.IsZero() {
		value := source.LastIngest
		lastIngest = &value
	}
	return SourceSummary{
		ID:            source.ID,
		Type:          source.Type,
		Label:         label,
		LastIngest:    lastIngest,
		LastItemCount: source.LastItemCount,
	}
}

func (h *Handler) kickIngest(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	id := chi.URLParam(r, "id")
	rec, err := h.Store.GetSource(r.Context(), tenant, id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	src, err := h.Registry.Get(rec.Type)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	params := ingest.NormalizeParams(rec.Type, rec.Params)
	params.TenantID = tenant
	if err := ingest.ValidateParams(r.Context(), rec.Type, params); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Job persistence: when IngestJobs is wired, create the row up front
	// so the response carries a real, pollable id. When unset (dev / in-
	// memory mode) we still mint a UUID so the response shape is stable.
	var jobID string
	if h.IngestJobs != nil {
		id, err := h.IngestJobs.Create(r.Context(), tenant, rec.ID)
		if err != nil {
			http.Error(w, fmt.Sprintf("create job: %v", err), http.StatusInternalServerError)
			return
		}
		jobID = id
	} else {
		jobID = uuid.NewString()
	}

	// Fire-and-forget worker. The goroutine drives the job state machine
	// itself so the polling endpoint reflects reality without a separate
	// worker process. A panic-recover keeps the row from being stranded
	// in 'running' if Ingest blows up unexpectedly.
	jobs := h.IngestJobs
	tenantForJob := rec.TenantID
	started := startBoundedVoiceJob(voiceIngestSlots, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		defer func() {
			if rec := recover(); rec != nil && jobs != nil {
				_ = jobs.Fail(ctx, tenantForJob, jobID, fmt.Sprintf("panic: %v", rec))
			}
		}()
		if jobs != nil {
			_ = jobs.Start(ctx, tenantForJob, jobID)
		}
		seq, err := src.Ingest(ctx, params)
		if err != nil {
			if jobs != nil {
				_ = jobs.Fail(ctx, tenantForJob, jobID, err.Error())
			}
			return
		}
		var collected []ingest.Item
		for it, ierr := range seq {
			if ierr != nil {
				continue
			}
			collected = append(collected, it)
		}
		if err := h.Store.RecordIngest(ctx, tenantForJob, rec.ID, collected); err != nil {
			if jobs != nil {
				_ = jobs.Fail(ctx, tenantForJob, jobID, err.Error())
			}
			return
		}
		if jobs != nil {
			_ = jobs.Succeed(ctx, tenantForJob, jobID, len(collected))
		}
		// Auto-rebuild voice profile when this run crossed the threshold.
		// Best-effort + non-blocking: failure here doesn't fail the
		// ingest job because ingest is the user-visible action; the
		// profile rebuild is a downstream nicety. The handler logs via
		// the engine's standard error path.
		h.maybeAutoRebuildProfile(ctx, tenantForJob, len(collected))
	}, func(recovered any, _ []byte) {
		if jobs != nil {
			panicCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = jobs.Fail(panicCtx, tenantForJob, jobID, fmt.Sprintf("panic: %v", recovered))
		}
	})
	if !started {
		if jobs != nil {
			_ = jobs.Fail(r.Context(), tenantForJob, jobID, "voice ingest capacity exhausted")
		}
		http.Error(w, "voice ingest capacity exhausted; retry later", http.StatusServiceUnavailable)
		return
	}

	writeJSON(w, http.StatusAccepted, ingestResp{JobID: jobID, Status: "pending"})
}

// getIngestJob returns the polled job state. Returns 404 when the job is
// unknown (or the IngestJobs store is unwired in dev mode).
func (h *Handler) getIngestJob(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	if h.IngestJobs == nil {
		http.Error(w, "ingest job polling unavailable in this mode", http.StatusNotFound)
		return
	}
	sourceID := chi.URLParam(r, "id")
	jobID := chi.URLParam(r, "job_id")
	job, err := h.IngestJobs.Get(r.Context(), tenant, jobID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "job not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Cross-source guard: a tenant trying to poll a job through the wrong
	// source URL still gets a 404 (don't leak the existence of jobs across
	// sources).
	if job.SourceID != sourceID {
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	job = h.failStaleIngestJob(r.Context(), tenant, job)
	writeJSON(w, http.StatusOK, job)
}

func (h *Handler) failStaleIngestJob(ctx context.Context, tenant string, job IngestJob) IngestJob {
	if h == nil || h.IngestJobs == nil || !isActiveAsyncStatus(job.Status) {
		return job
	}
	if time.Since(job.UpdatedAt) <= AsyncJobStaleAfter {
		return job
	}
	msg := fmt.Sprintf("job timed out after %s without worker progress", AsyncJobStaleAfter)
	if err := h.IngestJobs.Fail(ctx, tenant, job.ID, msg); err != nil {
		return job
	}
	now := time.Now().UTC()
	job.Status = "failed"
	job.ErrorMessage = msg
	job.FinishedAt = &now
	job.UpdatedAt = now
	return job
}

func isActiveAsyncStatus(status string) bool {
	switch status {
	case "pending", "running":
		return true
	default:
		return false
	}
}

func (h *Handler) deleteSource(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	if err := h.Store.DeleteSource(r.Context(), tenant, chi.URLParam(r, "id")); err != nil {
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "source not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) getProfile(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	p, err := h.Store.GetProfile(r.Context(), tenant)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "no profile yet", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (h *Handler) buildProfile(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	items, err := h.Store.ListItems(r.Context(), tenant)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if h.Builder == nil {
		http.Error(w, "builder not configured", http.StatusInternalServerError)
		return
	}
	if words := totalItemWords(items); words < minProfileBuildWords {
		http.Error(
			w,
			fmt.Sprintf("not enough source material: %d words available, %d required; add a paste-in source or ingest more archives", words, minProfileBuildWords),
			http.StatusUnprocessableEntity,
		)
		return
	}
	if err := h.quotaOrNoop().CheckAndConsume(r.Context(), tenant, "profile_build", quota.CostMilliCredits("profile_build", 1)); err != nil {
		if errors.Is(err, quota.ErrOverQuota) {
			writeQuotaExceeded(w, h.quotaOrNoop(), r.Context(), tenant, "profile_build")
			return
		}
		http.Error(w, "AI allowance could not be verified", http.StatusServiceUnavailable)
		return
	}
	// Use a tenant-scoped builder so tenant_id is set on the resulting profile.
	b := *h.Builder
	b.TenantID = tenant
	prof, err := b.Build(r.Context(), items)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.Store.SaveProfile(r.Context(), prof); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, prof)
}

func totalItemWords(items []ingest.Item) int {
	total := 0
	for _, item := range items {
		total += len(strings.Fields(item.Text))
	}
	return total
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// --- in-memory store (V1 default) ---

// MemoryStore is an in-process VoiceStore for development and tests.
type MemoryStore struct {
	mu       sync.RWMutex
	sources  map[string]SourceRecord  // sourceID → record
	tenants  map[string][]string      // tenantID → sourceIDs
	items    map[string][]ingest.Item // tenantID → items
	profiles map[string]profile.VoiceProfile
}

// NewMemoryStore returns an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		sources:  map[string]SourceRecord{},
		tenants:  map[string][]string{},
		items:    map[string][]ingest.Item{},
		profiles: map[string]profile.VoiceProfile{},
	}
}

// RegisterSource implements VoiceStore.
func (m *MemoryStore) RegisterSource(_ context.Context, tenantID string, t ingest.SourceType, p ingest.IngestParams) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := uuid.NewString()
	m.sources[id] = SourceRecord{ID: id, TenantID: tenantID, Type: t, Params: p}
	m.tenants[tenantID] = append(m.tenants[tenantID], id)
	return id, nil
}

// ListSources implements VoiceStore.
func (m *MemoryStore) ListSources(_ context.Context, tenantID string) ([]SourceRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := m.tenants[tenantID]
	out := make([]SourceRecord, 0, len(ids))
	for _, id := range ids {
		out = append(out, m.sources[id])
	}
	return out, nil
}

// GetSource implements VoiceStore.
func (m *MemoryStore) GetSource(_ context.Context, tenantID, sourceID string) (SourceRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.sources[sourceID]
	if !ok || r.TenantID != tenantID {
		return SourceRecord{}, ErrNotFound
	}
	return r, nil
}

// DeleteSource implements VoiceStore.
func (m *MemoryStore) DeleteSource(_ context.Context, tenantID, sourceID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.sources[sourceID]
	if !ok || r.TenantID != tenantID {
		return ErrNotFound
	}
	delete(m.sources, sourceID)
	ids := m.tenants[tenantID]
	for i, id := range ids {
		if id == sourceID {
			m.tenants[tenantID] = append(ids[:i], ids[i+1:]...)
			break
		}
	}
	return nil
}

// RecordIngest implements VoiceStore.
func (m *MemoryStore) RecordIngest(_ context.Context, tenantID, sourceID string, items []ingest.Item) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.sources[sourceID]
	if !ok || rec.TenantID != tenantID {
		return ErrNotFound
	}
	rec.LastIngest = time.Now().UTC()
	rec.LastItemCount = len(items)
	m.sources[sourceID] = rec
	m.items[rec.TenantID] = append(m.items[rec.TenantID], items...)
	return nil
}

// ListItems implements VoiceStore.
func (m *MemoryStore) ListItems(_ context.Context, tenantID string) ([]ingest.Item, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]ingest.Item, len(m.items[tenantID]))
	copy(out, m.items[tenantID])
	return out, nil
}

// SaveProfile implements VoiceStore.
func (m *MemoryStore) SaveProfile(_ context.Context, p profile.VoiceProfile) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.profiles[p.TenantID] = p
	return nil
}

// GetProfile implements VoiceStore.
func (m *MemoryStore) GetProfile(_ context.Context, tenantID string) (profile.VoiceProfile, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.profiles[tenantID]
	if !ok {
		return profile.VoiceProfile{}, ErrNotFound
	}
	return p, nil
}
