package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/internalauth"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/quota"
	"github.com/postwave/postwave/services/voice/internal/sequencecontract"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

// SequenceStore is the persistence contract for generated sequences. The
// default implementation is in-memory; production swaps in Postgres.
type SequenceStore interface {
	Save(ctx context.Context, seq generation.Sequence) error
	Get(ctx context.Context, tenantID, id string) (generation.Sequence, error)
	List(ctx context.Context, tenantID string) ([]generation.Sequence, error)
	Delete(ctx context.Context, tenantID, id string) error
}

// VersionedSequenceStore is the optimistic-concurrency contract required by
// every public PATCH. A configured store that cannot compare-and-swap must
// fail closed rather than silently falling back to an unconditional write.
type VersionedSequenceStore interface {
	SaveWithVersion(ctx context.Context, seq generation.Sequence, expectedVersion int64) (int64, error)
}

// VersionedSequenceDeleteStore is the optimistic-concurrency contract
// required by every public DELETE. Delete remains on SequenceStore for
// trusted server-side maintenance paths; HTTP callers always use this CAS
// surface.
type VersionedSequenceDeleteStore interface {
	DeleteWithVersion(ctx context.Context, tenantID, id string, expectedVersion int64) error
}

// ErrVersionMismatch aliases the dependency-neutral sequence contract so every
// store returns an errors.Is-equivalent value. In particular, the production
// seqstore sentinel must map to HTTP 412 rather than falling through to 500.
var ErrVersionMismatch = sequencecontract.ErrVersionMismatch

func sequenceETag(version int64) string {
	return `"` + strconv.FormatInt(version, 10) + `"`
}

type updateTemplateRequest struct {
	Slug        *string                        `json:"slug"`
	Category    *templates.TemplateCategory    `json:"category"`
	Name        *string                        `json:"name"`
	Description *string                        `json:"description"`
	Length      *int                           `json:"length"`
	Variables   *[]templates.TemplateVariable  `json:"variables"`
	Emails      *[]templates.TemplateEmail     `json:"emails"`
	Tags        *[]string                      `json:"tags"`
	Author      *string                        `json:"author"`
	Performance *templates.TemplatePerformance `json:"performance"`
}

type updateSequenceRequest struct {
	Name   *string                     `json:"name"`
	Status *string                     `json:"status"`
	Emails []generation.GeneratedEmail `json:"emails"`
	// Steps is the v0.3+ richer canvas shape: condition / delay /
	// tag-add / tag-remove / exit nodes alongside emails. When set
	// (non-nil pointer), the handler stores the supplied step list
	// authoritatively — the request can supply EITHER Emails OR Steps,
	// not both. The handler validates the union and rejects mixed
	// requests so producers don't accidentally double-write.
	Steps *[]generation.Step `json:"steps,omitempty"`
	// Ops is the Phase-2 operation-based delta surface. When set, the
	// handler ignores the legacy full-array Steps/Emails fields and
	// applies the ordered ops to the current step list inside a single
	// transaction (the memory store imitates a tx with its own mutex;
	// the Postgres store relies on SaveWithVersion's RETURNING guard).
	//
	// Like every sequence PATCH, requests that include Ops MUST send an
	// If-Match header carrying the row's current version. A mismatch returns
	// 412 Precondition Failed so the client can re-fetch and re-emit.
	Ops *[]sequenceOp `json:"ops,omitempty"`
	// Goal sets/clears the sequence-level goal (roadmap: goals / exit
	// criteria). Raw so the handler can distinguish three states:
	// absent (leave unchanged), JSON null (clear), object (validate +
	// set).
	Goal json.RawMessage `json:"goal,omitempty"`
	// StuckAfterDays configures the stuck-participant threshold.
	// nil = leave unchanged, 0 = disable, 1..365 = enable.
	StuckAfterDays *int `json:"stuck_after_days,omitempty"`
}

// generateSequenceRequest preserves field presence so the two creation modes
// can reject known-but-inapplicable fields instead of silently accepting a
// request whose apparent instructions have no effect.
type generateSequenceRequest struct {
	TenantID       *string                   `json:"tenant_id"`
	TemplateID     *string                   `json:"template_id"`
	Name           string                    `json:"name"`
	Status         *string                   `json:"status"`
	Steps          *[]generation.Step        `json:"steps"`
	Goal           json.RawMessage           `json:"goal"`
	StuckAfterDays *int                      `json:"stuck_after_days"`
	Profile        *profile.VoiceProfile     `json:"profile"`
	Variables      *map[string]string        `json:"variables"`
	StyleControls  *generation.StyleControls `json:"style_controls"`
}

// stuckAfterDaysMax bounds the configurable stuck threshold. A year of
// idleness is an archive problem, not an alerting problem.
const stuckAfterDaysMax = 365

// parseGoalPatch interprets the raw `goal` field of a PATCH body.
// Returns (newGoal, set, err): set=false means the field was absent and
// the existing goal should be kept; set=true with a nil goal clears it.
func parseGoalPatch(raw json.RawMessage) (*generation.SequenceGoal, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return nil, true, nil
	}
	var g generation.SequenceGoal
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&g); err != nil {
		return nil, false, fmt.Errorf("invalid goal: %w", err)
	}
	g.Kind = strings.ToLower(strings.TrimSpace(g.Kind))
	if err := g.Validate(); err != nil {
		return nil, false, err
	}
	return &g, true, nil
}

// sequenceOp is one element of the ops-based delta surface. Exactly one
// set of operation-specific fields is interpreted per op according to
// `op`:
//
//   - "insert"  reads AfterID (or omits to prepend) + Step
//   - "move"    reads StepID + BeforeID (or omit BeforeID to move to end)
//   - "update"  reads StepID + Patch (a fully-populated Step)
//   - "delete"  reads StepID
//
// The step list is addressed by 1-based `position` because that is the
// existing wire-level identifier; the canvas tracks the position the
// server assigned at last GET and feeds it back through these fields.
// Stable client-minted IDs would be a cleaner contract but require a
// schema change to land first; we treat position as the id-equivalent
// for now and accept that concurrent reorderings need an If-Match retry.
type sequenceOp struct {
	Op       string           `json:"op"`
	StepID   int              `json:"step_id,omitempty"`
	AfterID  int              `json:"after_id,omitempty"`
	BeforeID int              `json:"before_id,omitempty"`
	Step     *generation.Step `json:"step,omitempty"`
	Patch    *generation.Step `json:"patch,omitempty"`
}

// MemorySequenceStore is the V1 in-process SequenceStore.
type MemorySequenceStore struct {
	mu        sync.RWMutex
	byID      map[string]generation.Sequence
	byTenant  map[string][]string // tenant → ordered IDs
	createdAt map[string]int64
}

// NewMemorySequenceStore returns an empty store.
func NewMemorySequenceStore() *MemorySequenceStore {
	return &MemorySequenceStore{
		byID:      map[string]generation.Sequence{},
		byTenant:  map[string][]string{},
		createdAt: map[string]int64{},
	}
}

// Save implements SequenceStore. The in-memory store bumps Version by 1
// on each Save so tests can exercise the optimistic-concurrency path
// without standing up Postgres. New rows start at version=1.
func (m *MemorySequenceStore) Save(_ context.Context, seq generation.Sequence) error {
	status, err := sequencecontract.NormalizeStatus(seq.Status)
	if err != nil {
		return err
	}
	seq.Status = status
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	existing, hadExisting := m.byID[seq.ID]
	if !hadExisting {
		m.byTenant[seq.TenantID] = append(m.byTenant[seq.TenantID], seq.ID)
		if seq.Version == 0 {
			seq.Version = 1
		}
	} else {
		if seq.CreatedAt.IsZero() {
			seq.CreatedAt = existing.CreatedAt
		}
		// Unconditional Save bumps from whatever was persisted.
		seq.Version = existing.Version + 1
	}
	if seq.CreatedAt.IsZero() {
		seq.CreatedAt = now
	}
	seq.UpdatedAt = now
	m.byID[seq.ID] = seq
	m.createdAt[seq.ID] = seq.CreatedAt.UnixNano()
	return nil
}

// SaveWithVersion implements VersionedSequenceStore for the in-memory
// store. Returns ErrVersionMismatch when the caller's expectedVersion
// no longer matches the persisted row; otherwise bumps Version by 1 and
// returns the new value.
func (m *MemorySequenceStore) SaveWithVersion(_ context.Context, seq generation.Sequence, expectedVersion int64) (int64, error) {
	status, err := sequencecontract.NormalizeStatus(seq.Status)
	if err != nil {
		return 0, err
	}
	seq.Status = status
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.byID[seq.ID]
	if !ok || existing.TenantID != seq.TenantID {
		return 0, ErrNotFound
	}
	if existing.Version != expectedVersion {
		return 0, ErrVersionMismatch
	}
	now := time.Now().UTC()
	if seq.CreatedAt.IsZero() {
		seq.CreatedAt = existing.CreatedAt
	}
	seq.UpdatedAt = now
	seq.Version = existing.Version + 1
	m.byID[seq.ID] = seq
	return seq.Version, nil
}

// Get implements SequenceStore.
func (m *MemorySequenceStore) Get(_ context.Context, tenantID, id string) (generation.Sequence, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.byID[id]
	if !ok || s.TenantID != tenantID {
		return generation.Sequence{}, ErrNotFound
	}
	return s, nil
}

// List implements SequenceStore.
func (m *MemorySequenceStore) List(_ context.Context, tenantID string) ([]generation.Sequence, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := append([]string(nil), m.byTenant[tenantID]...)
	sort.SliceStable(ids, func(i, j int) bool {
		return m.createdAt[ids[i]] > m.createdAt[ids[j]]
	})
	out := make([]generation.Sequence, 0, len(ids))
	for _, id := range ids {
		out = append(out, m.byID[id])
	}
	return out, nil
}

// Delete implements SequenceStore.
func (m *MemorySequenceStore) Delete(_ context.Context, tenantID, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	seq, ok := m.byID[id]
	if !ok || seq.TenantID != tenantID {
		return ErrNotFound
	}
	m.deleteLocked(tenantID, id)
	return nil
}

// DeleteWithVersion implements VersionedSequenceDeleteStore for the in-memory
// store. A stale caller cannot delete a row that changed after it was read.
func (m *MemorySequenceStore) DeleteWithVersion(_ context.Context, tenantID, id string, expectedVersion int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	seq, ok := m.byID[id]
	if !ok || seq.TenantID != tenantID {
		return ErrNotFound
	}
	if seq.Version != expectedVersion {
		return ErrVersionMismatch
	}
	m.deleteLocked(tenantID, id)
	return nil
}

func (m *MemorySequenceStore) deleteLocked(tenantID, id string) {
	delete(m.byID, id)
	delete(m.createdAt, id)
	ids := m.byTenant[tenantID]
	for i, existingID := range ids {
		if existingID == id {
			m.byTenant[tenantID] = append(ids[:i], ids[i+1:]...)
			break
		}
	}
}

// GenerationDeps bundles the generation-specific collaborators a Handler
// needs. We add it to Handler via WithGeneration so existing constructors
// stay backward compatible.
type GenerationDeps struct {
	Engine    *generation.Engine
	Templates templates.TemplateStore
	Sequences SequenceStore
}

// WithGeneration installs generation deps on the handler. Returns h for
// chaining.
func (h *Handler) WithGeneration(d GenerationDeps) *Handler {
	h.gen = d
	return h
}

// genRoutes mounts the /v1/voice/templates and /v1/voice/sequences routes.
// Called from Routes() if generation deps are present.
func (h *Handler) genRoutes(r chi.Router) {
	r.Get("/templates", h.listTemplates)
	r.Get("/templates/{id}", h.getTemplate)
	r.Post("/templates", h.createTemplate)
	// On-brand AI template generator (LLM-backed; quota-gated). Static
	// segment, registered alongside the other static /templates routes
	// so chi never confuses it with /templates/{id}.
	r.Post("/templates/generate", h.generateTemplateFromBrief)
	r.Patch("/templates/{id}", h.updateTemplate)
	r.Delete("/templates/{id}", h.deleteTemplate)
	r.Post("/sequences", h.generateSequence)
	// Whole-sequence draft from a free-text brief (desktop gap A26).
	// Static segment, so it must not be shadowed by a /sequences/{id}
	// pattern — kept with the other static /sequences/* routes.
	r.Post("/sequences/draft", h.draftSequence)
	// Historical job polling endpoint. Listed before /sequences/{id} so chi's
	// longest-prefix match doesn't interpret "jobs" as a sequence ID.
	r.Get("/sequences/jobs/{job_id}", h.getSequenceJob)
	r.Get("/sequences", h.listSequences)
	r.Get("/sequences/{id}", h.getSequence)
	// Derived per-subscriber enrollment state (desktop gap A9). Returns a
	// retryable dependency failure when no Postgres pool is wired.
	r.Get("/sequences/{id}/participants", h.listSequenceParticipants)
	// Aggregate send performance: reached/opened/clicked per email position +
	// a distinct-subscriber rollup (SEQ-009). Postgres-only like participants;
	// returns a retryable 503 when the read model is unavailable.
	r.Get("/sequences/{id}/performance", h.getSequencePerformance)
	// Stuck-participant report (roadmap item 3). Postgres-only like
	// participants; see stuck.go for the dependency-failure contract.
	r.Get("/sequences/{id}/stuck", h.listStuckParticipants)
	// Goal progress is deliberately not mounted while the sequence execution
	// runtime is unavailable. Publishing a read-model route would imply that
	// exit_on_goal is operational when no qualified dispatcher enforces it.
	// Deterministic A/B resolution accepts only an opaque subscriber ID in a
	// POST body. Subscriber emails never appear in URLs, logs, or referrers.
	r.Post("/sequences/{id}/steps/{position}/variant", h.assignStepVariant)
	r.Patch("/sequences/{id}", h.updateSequence)
	r.Delete("/sequences/{id}", h.deleteSequence)
	r.Post("/sequences/{id}/regenerate/{position}", h.regenerateEmail)
}

// --- template routes ---

func (h *Handler) listTemplates(w http.ResponseWriter, r *http.Request) {
	cat := templates.TemplateCategory(r.URL.Query().Get("category"))
	rows, err := h.gen.Templates.List(r.Context(), cat)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *Handler) getTemplate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	t, err := h.gen.Templates.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, templates.ErrNotFound) {
			http.Error(w, "template not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (h *Handler) createTemplate(w http.ResponseWriter, r *http.Request) {
	if !isTemplateAdmin(r) {
		http.Error(w, "admin role required", http.StatusForbidden)
		return
	}
	var t templates.Template
	if err := decodeRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &t); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	created, err := h.gen.Templates.Create(r.Context(), t)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (h *Handler) updateTemplate(w http.ResponseWriter, r *http.Request) {
	if !isTemplateAdmin(r) {
		http.Error(w, "admin role required", http.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	t, err := h.gen.Templates.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, templates.ErrNotFound) {
			http.Error(w, "template not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var req updateTemplateRequest
	if err := decodeRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &req); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	if req.Slug != nil {
		t.Slug = strings.TrimSpace(*req.Slug)
		if t.Slug == "" {
			http.Error(w, "slug required", http.StatusBadRequest)
			return
		}
	}
	if req.Category != nil {
		category := templates.TemplateCategory(strings.TrimSpace(string(*req.Category)))
		if !validTemplateCategory(category) {
			http.Error(w, "invalid category", http.StatusBadRequest)
			return
		}
		t.Category = category
	}
	if req.Name != nil {
		t.Name = strings.TrimSpace(*req.Name)
		if t.Name == "" {
			http.Error(w, "name required", http.StatusBadRequest)
			return
		}
	}
	if req.Description != nil {
		t.Description = strings.TrimSpace(*req.Description)
	}
	if req.Length != nil {
		if *req.Length < 0 {
			http.Error(w, "length must be non-negative", http.StatusBadRequest)
			return
		}
		t.Length = *req.Length
	}
	if req.Variables != nil {
		t.Variables = *req.Variables
	}
	if req.Emails != nil {
		t.Emails = *req.Emails
		if t.Length == 0 {
			t.Length = len(t.Emails)
		}
	}
	if req.Tags != nil {
		t.Tags = cleanTemplateTags(*req.Tags)
	}
	if req.Author != nil {
		t.Author = strings.TrimSpace(*req.Author)
	}
	if req.Performance != nil {
		t.Performance = *req.Performance
	}
	updated, err := h.gen.Templates.Update(r.Context(), t)
	if err != nil {
		if errors.Is(err, templates.ErrNotFound) {
			http.Error(w, "template not found", http.StatusNotFound)
			return
		}
		if errors.Is(err, templates.ErrConflict) {
			http.Error(w, "template slug already exists", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (h *Handler) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	if !isTemplateAdmin(r) {
		http.Error(w, "admin role required", http.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	t, err := h.gen.Templates.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, templates.ErrNotFound) {
			http.Error(w, "template not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.gen.Templates.Delete(r.Context(), t.ID); err != nil {
		if errors.Is(err, templates.ErrNotFound) {
			http.Error(w, "template not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validTemplateCategory(category templates.TemplateCategory) bool {
	for _, allowed := range templates.AllCategories() {
		if category == allowed {
			return true
		}
	}
	return false
}

func cleanTemplateTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := map[string]struct{}{}
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, tag)
	}
	return out
}

func isTemplateAdmin(r *http.Request) bool {
	if internalauth.IsInternalBearerAuth(r.Context()) {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("X-Postwave-Role"))) {
	case "owner", "admin":
		return true
	default:
		return false
	}
}

// --- sequence routes ---

func (h *Handler) generateSequence(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	var wire generateSequenceRequest
	if err := decodeStrictRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &wire); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	if wire.TenantID != nil {
		http.Error(w, "tenant_id is derived from authentication and must not be supplied", http.StatusBadRequest)
		return
	}
	if err := validateSingleLine("name", wire.Name, sequenceMaxNameRunes, true); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	goal, goalSet, err := parseGoalPatch(wire.Goal)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req := generation.GenerateRequest{TenantID: tenant, Name: strings.TrimSpace(wire.Name), Goal: goal}
	if wire.Status != nil {
		req.Status = *wire.Status
	}
	if wire.Steps != nil {
		req.Steps = *wire.Steps
	}
	if wire.StuckAfterDays != nil {
		req.StuckAfterDays = *wire.StuckAfterDays
	}
	if wire.Profile != nil {
		req.Profile = *wire.Profile
	}
	if wire.Variables != nil {
		req.Variables = *wire.Variables
	}
	if wire.StyleControls != nil {
		req.StyleControls = *wire.StyleControls
	}
	if wire.TemplateID == nil {
		if wire.Profile != nil || wire.Variables != nil || wire.StyleControls != nil {
			http.Error(w, "manual drafts do not accept profile, variables, or style_controls", http.StatusBadRequest)
			return
		}
		h.createDraftSequence(w, r, tenant, req)
		return
	}
	req.TemplateID = strings.TrimSpace(*wire.TemplateID)
	if err := validateSingleLine("template_id", *wire.TemplateID, sequenceMaxTemplateIDRunes, true); err != nil {
		http.Error(w, "template_id must be omitted for a manual draft or contain a bounded printable template identifier", http.StatusBadRequest)
		return
	}
	if wire.Status != nil || wire.Steps != nil || goalSet || wire.StuckAfterDays != nil {
		http.Error(w, "template-backed generation does not accept status, steps, goal, or stuck_after_days", http.StatusBadRequest)
		return
	}
	// Production currently wires a persistence store for historical job
	// polling, but there is no durable worker that can own generation after the
	// request ends. Never launch template-backed generation in a detached
	// goroutine: a process restart could save a sequence without reaching a
	// terminal job state (or vice versa). Development/tests may leave the job
	// store nil and exercise the bounded synchronous path below.
	if h.SequenceJobs != nil {
		http.Error(w, "template-backed sequence generation is unavailable until a durable worker is configured", http.StatusServiceUnavailable)
		return
	}
	// If the caller didn't include a profile inline, fall back to the stored one.
	if len(req.Profile.RepresentativeSamples) == 0 {
		stored, err := h.Store.GetProfile(r.Context(), tenant)
		if err == nil {
			req.Profile = stored
		}
	}

	// Quota gate. Sequence generation is the heaviest LLM call shape
	// in the service — count it as one quota unit per request even
	// though the engine fans out across email_count Claude turns.
	// Per-email cost would be a noisier story for the user; one row
	// per request keeps the daily-total semantics intuitive.
	if err := h.quotaOrNoop().CheckAndConsume(r.Context(), tenant, "sequence", quota.CostMilliCredits("sequence", 1)); err != nil {
		if errors.Is(err, quota.ErrOverQuota) {
			writeQuotaExceeded(w, h.quotaOrNoop(), r.Context(), tenant, "sequence")
			return
		}
		http.Error(w, "sequence quota unavailable", http.StatusInternalServerError)
		return
	}

	// Development-only synchronous path: blocks for the bounded engine call.
	seq, err := h.gen.Engine.Generate(r.Context(), req)
	if err != nil {
		http.Error(w, "sequence generation failed", statusForLLMError(err))
		return
	}
	if len(seq.Steps) > 0 {
		if err := validateSteps(seq.Steps); err != nil {
			http.Error(w, "generated sequence failed validation", http.StatusInternalServerError)
			return
		}
	} else if err := validateGeneratedEmails(seq.Emails); err != nil {
		http.Error(w, "generated sequence failed validation", http.StatusInternalServerError)
		return
	}
	if err := h.gen.Sequences.Save(r.Context(), seq); err != nil {
		http.Error(w, "sequence save failed", http.StatusInternalServerError)
		return
	}
	persisted, err := h.gen.Sequences.Get(r.Context(), tenant, seq.ID)
	if err != nil {
		http.Error(w, "sequence lookup failed", http.StatusInternalServerError)
		return
	}
	h.fireSequenceGenerated(r.Context(), tenant, persisted)
	w.Header().Set("ETag", sequenceETag(persisted.Version))
	writeJSON(w, http.StatusAccepted, persisted)
}

// createDraftSequence is the manual sequence path used by the visual canvas.
// It deliberately avoids the LLM/template engine and therefore does not spend
// AI quota. Calls with template_id still flow through generateSequence above.
func (h *Handler) createDraftSequence(
	w http.ResponseWriter,
	r *http.Request,
	tenant string,
	req generation.GenerateRequest,
) {
	name := strings.TrimSpace(req.Name)
	if err := validateSingleLine("name", req.Name, sequenceMaxNameRunes, true); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	status, err := sequencecontract.NormalizeStatus(req.Status)
	if err != nil {
		writeSequenceStatusError(w, req.Status)
		return
	}
	if status == sequencecontract.StatusActive {
		writeSequenceStatusError(w, req.Status)
		return
	}
	steps := append([]generation.Step(nil), req.Steps...)
	if len(steps) > 0 {
		if err := validateSteps(steps); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		sort.SliceStable(steps, func(i, j int) bool {
			return steps[i].Position < steps[j].Position
		})
	}
	if req.Goal != nil {
		req.Goal.Kind = strings.ToLower(strings.TrimSpace(req.Goal.Kind))
		if err := req.Goal.Validate(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	if req.StuckAfterDays < 0 || req.StuckAfterDays > stuckAfterDaysMax {
		http.Error(w, fmt.Sprintf("stuck_after_days must be between 0 (off) and %d", stuckAfterDaysMax), http.StatusBadRequest)
		return
	}
	now := time.Now().UTC()
	seq := generation.Sequence{
		ID:             uuid.NewString(),
		TenantID:       tenant,
		Name:           name,
		Status:         status,
		Steps:          steps,
		Goal:           req.Goal,
		StuckAfterDays: req.StuckAfterDays,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := h.gen.Sequences.Save(r.Context(), seq); err != nil {
		http.Error(w, "sequence save failed", http.StatusInternalServerError)
		return
	}
	persisted, err := h.gen.Sequences.Get(r.Context(), tenant, seq.ID)
	if err != nil {
		http.Error(w, "sequence lookup failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("ETag", sequenceETag(persisted.Version))
	writeJSON(w, http.StatusCreated, persisted)
}

// fireSequenceGenerated emits the webhook event for the synchronous
// development path after the sequence has been persisted.
func (h *Handler) fireSequenceGenerated(ctx context.Context, tenant string, seq generation.Sequence) {
	if h.FanoutEmitter == nil || tenant == "" {
		return
	}
	_ = h.FanoutEmitter.Emit(ctx, tenant, "sequence.generated", map[string]any{
		"tenant_id":   tenant,
		"sequence_id": seq.ID,
		"template_id": seq.TemplateID,
		"name":        seq.Name,
		"status":      seq.Status,
		"email_count": len(seq.Emails),
		"created_at":  seq.CreatedAt,
	})
}

// getSequenceJob returns the current state of a sequence-generation
// job. Returns 404 when the job is unknown OR when the SequenceJobs
// store is unwired (sync mode — no jobs to poll).
func (h *Handler) getSequenceJob(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	if h.SequenceJobs == nil {
		http.Error(w, "sequence job polling unavailable in this mode", http.StatusNotFound)
		return
	}
	jobID := chi.URLParam(r, "job_id")
	job, err := h.SequenceJobs.Get(r.Context(), tenant, jobID)
	if err != nil {
		// Both ErrNotFound and tenant-mismatch surface as 404 so we
		// don't leak the existence of jobs across tenants.
		http.Error(w, "job not found", http.StatusNotFound)
		return
	}
	job = h.failStaleSequenceJob(r.Context(), tenant, job)
	writeJSON(w, http.StatusOK, job)
}

func (h *Handler) failStaleSequenceJob(ctx context.Context, tenant string, job SequenceJob) SequenceJob {
	if h == nil || h.SequenceJobs == nil || !isActiveAsyncStatus(job.Status) {
		return job
	}
	if time.Since(job.UpdatedAt) <= AsyncJobStaleAfter {
		return job
	}
	msg := fmt.Sprintf("job timed out after %s without worker progress", AsyncJobStaleAfter)
	if err := h.SequenceJobs.Fail(ctx, tenant, job.ID, msg); err != nil {
		return job
	}
	now := time.Now().UTC()
	job.Status = "failed"
	job.ErrorMessage = msg
	job.FinishedAt = &now
	job.UpdatedAt = now
	return job
}

func (h *Handler) listSequences(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	rows, err := h.gen.Sequences.List(r.Context(), tenant)
	if err != nil {
		http.Error(w, "sequence list unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *Handler) getSequence(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	id, ok := sequenceIDFromRequest(w, r)
	if !ok {
		return
	}
	seq, err := h.gen.Sequences.Get(r.Context(), tenant, id)
	if err != nil {
		if isSequenceNotFound(err) {
			http.Error(w, "sequence not found", http.StatusNotFound)
			return
		}
		http.Error(w, "sequence lookup failed", http.StatusInternalServerError)
		return
	}
	// Surface the current row version as an HTTP ETag so the canvas
	// can feed it back through `If-Match` on the next PATCH without
	// having to re-parse the JSON body.
	w.Header().Set("ETag", sequenceETag(seq.Version))
	writeJSON(w, http.StatusOK, seq)
}

func (h *Handler) updateSequence(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	id, ok := sequenceIDFromRequest(w, r)
	if !ok {
		return
	}
	var req updateSequenceRequest
	if err := decodeStrictRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &req); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	if err := validateSequenceUpdateShape(req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	seq, err := h.gen.Sequences.Get(r.Context(), tenant, id)
	if err != nil {
		if isSequenceNotFound(err) {
			http.Error(w, "sequence not found", http.StatusNotFound)
			return
		}
		http.Error(w, "sequence lookup failed", http.StatusInternalServerError)
		return
	}
	original := seq
	// Restore is the reversible counterpart of the exclusive archive action.
	// It may change only archived -> draft; content/settings remain locked and
	// the same If-Match/CAS checks below still apply to the transition.
	restoring := strings.ToLower(strings.TrimSpace(seq.Status)) == sequencecontract.StatusArchived &&
		req.Status != nil && strings.ToLower(strings.TrimSpace(*req.Status)) == sequencecontract.StatusDraft &&
		req.Name == nil && req.Emails == nil && req.Steps == nil && req.Ops == nil &&
		len(req.Goal) == 0 && req.StuckAfterDays == nil
	if strings.ToLower(strings.TrimSpace(seq.Status)) != sequencecontract.StatusDraft && !restoring {
		http.Error(w, "only draft sequences are editable; duplicate this sequence into a new draft before changing it", http.StatusConflict)
		return
	}
	if req.Name != nil {
		seq.Name = strings.TrimSpace(*req.Name)
		if seq.Name == "" {
			http.Error(w, "name required", http.StatusBadRequest)
			return
		}
	}
	if req.Status != nil {
		status, statusErr := sequencecontract.NormalizeStatus(*req.Status)
		if statusErr != nil {
			writeSequenceStatusError(w, *req.Status)
			return
		}
		if status == sequencecontract.StatusActive {
			writeSequenceStatusError(w, *req.Status)
			return
		}
		if status == sequencecontract.StatusArchived &&
			(req.Name != nil || req.Emails != nil || req.Steps != nil || req.Ops != nil || len(req.Goal) != 0 || req.StuckAfterDays != nil) {
			http.Error(w, "archiving must be an exclusive status-only update", http.StatusBadRequest)
			return
		}
		seq.Status = status
	}
	if goal, set, err := parseGoalPatch(req.Goal); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	} else if set {
		seq.Goal = goal
	}
	if req.StuckAfterDays != nil {
		if *req.StuckAfterDays < 0 || *req.StuckAfterDays > stuckAfterDaysMax {
			http.Error(w, fmt.Sprintf("stuck_after_days must be between 0 (off) and %d", stuckAfterDaysMax), http.StatusBadRequest)
			return
		}
		seq.StuckAfterDays = *req.StuckAfterDays
	}
	if req.Emails != nil {
		if err := validateGeneratedEmails(req.Emails); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		sort.SliceStable(req.Emails, func(i, j int) bool {
			return req.Emails[i].Position < req.Emails[j].Position
		})
		seq.Emails = req.Emails
		// Replacing emails wholesale clears the parallel Steps shape so
		// readers don't see a stale step list shadowed by the new
		// emails. The two surfaces are mutually exclusive.
		seq.Steps = nil
	}
	if req.Steps != nil {
		steps := *req.Steps
		if len(steps) > 0 {
			if err := validateSteps(steps); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		sort.SliceStable(steps, func(i, j int) bool {
			return steps[i].Position < steps[j].Position
		})
		seq.Steps = steps
		// Replacing the step list clears the legacy Emails projection
		// so the persisted row is unambiguous about which shape is
		// authoritative.
		seq.Emails = nil
	}
	if req.Ops != nil {
		// Op-based delta path. The handler folds the current step list
		// projection from whichever side (Steps or Emails) is
		// authoritative, applies the ops in order, then re-validates.
		base := currentSteps(seq)
		next, applyErr := applySequenceOps(base, *req.Ops)
		if applyErr != nil {
			http.Error(w, applyErr.Error(), http.StatusBadRequest)
			return
		}
		if len(next) > 0 {
			if err := validateSteps(next); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		seq.Steps = next
		// Ops-based writes always normalise to the Steps projection so
		// the row can carry the richer canvas shape. The legacy Emails
		// projection is cleared.
		seq.Emails = nil
	}
	if seq.Status == "" {
		seq.Status = "draft"
	}
	if sequenceAuthoringEqual(original, seq) {
		http.Error(w, "patch does not change the sequence", http.StatusBadRequest)
		return
	}
	seq.UpdatedAt = time.Now().UTC()

	// Every public PATCH is compare-and-swap protected. Full-array writes are
	// at least as destructive as op deltas, so permitting them to bypass the
	// precondition would preserve the lost-update window this contract closes.
	newVersion, ok := writeWithIfMatch(w, r, h.gen.Sequences, seq)
	if !ok {
		return
	}
	// Build the acknowledgement from the exact CAS result. A follow-up GET
	// would reopen a race where a second writer advances the row between our
	// commit and response, causing this request to claim somebody else's
	// revision (and making exact expected+1 client confirmation impossible).
	seq.Version = newVersion
	// Echo the new version in ETag so the canvas can capture it without
	// a follow-up GET. The body also carries `version` so plain JSON
	// clients keep working.
	w.Header().Set("ETag", sequenceETag(seq.Version))
	writeJSON(w, http.StatusOK, seq)
}

// writeWithIfMatch routes the save through VersionedSequenceStore. Returns
// the exact committed revision on success; on failure it writes the
// appropriate HTTP error and returns false so the caller bails out of the
// handler. There is deliberately no unconditional fallback.
//
// If-Match parsing accepts the canonical strong ETag form `"<version>"` and
// the legacy bare integer during the compatibility window. First-party
// clients always emit the quoted form.
func writeWithIfMatch(w http.ResponseWriter, r *http.Request, store SequenceStore, seq generation.Sequence) (int64, bool) {
	expected, ok := parseSequenceIfMatch(w, r)
	if !ok {
		return 0, false
	}
	versioned, supported := store.(VersionedSequenceStore)
	if !supported {
		http.Error(w, "sequence store does not support required optimistic concurrency", http.StatusServiceUnavailable)
		return 0, false
	}
	newVersion, err := versioned.SaveWithVersion(r.Context(), seq, expected)
	if err != nil {
		if errors.Is(err, ErrVersionMismatch) {
			http.Error(w, "version mismatch — reload and retry", http.StatusPreconditionFailed)
			return 0, false
		}
		if isSequenceNotFound(err) {
			http.Error(w, "sequence not found", http.StatusNotFound)
			return 0, false
		}
		http.Error(w, "sequence save failed", http.StatusInternalServerError)
		return 0, false
	}
	if newVersion != expected+1 {
		http.Error(w, "sequence store returned an invalid committed version", http.StatusServiceUnavailable)
		return 0, false
	}
	return newVersion, true
}

// parseSequenceIfMatch accepts the legacy bare integer token and the standard
// quoted strong ETag form. Missing tokens are a 428 contract error; wildcard,
// weak, multiple, non-positive, and malformed tokens are never accepted.
func parseSequenceIfMatch(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	if raw == "" {
		http.Error(w, "If-Match header required for sequence mutations", http.StatusPreconditionRequired)
		return 0, false
	}
	if raw == "*" || strings.HasPrefix(raw, "W/") || strings.Contains(raw, ",") {
		http.Error(w, "If-Match must be one exact strong sequence version", http.StatusBadRequest)
		return 0, false
	}
	trimmed := raw
	if strings.HasPrefix(trimmed, `"`) || strings.HasSuffix(trimmed, `"`) {
		if len(trimmed) < 2 || !strings.HasPrefix(trimmed, `"`) || !strings.HasSuffix(trimmed, `"`) {
			http.Error(w, "If-Match must be the row's integer version", http.StatusBadRequest)
			return 0, false
		}
		trimmed = strings.TrimSuffix(strings.TrimPrefix(trimmed, `"`), `"`)
	}
	expected, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || expected < 1 {
		http.Error(w, "If-Match must be the row's positive integer version", http.StatusBadRequest)
		return 0, false
	}
	return expected, true
}

// currentSteps returns the authoritative step list for a sequence. The
// Steps projection wins when populated; otherwise the legacy Emails
// projection is lifted into the Step envelope so producers can run ops
// against rows that pre-date the v0.3 canvas without a separate seed
// step.
func currentSteps(seq generation.Sequence) []generation.Step {
	if len(seq.Steps) > 0 {
		out := make([]generation.Step, len(seq.Steps))
		copy(out, seq.Steps)
		return out
	}
	if len(seq.Emails) > 0 {
		out := make([]generation.Step, 0, len(seq.Emails))
		for _, e := range seq.Emails {
			email := e // copy
			out = append(out, generation.Step{
				Type:     generation.StepTypeEmail,
				Position: e.Position,
				Email: &generation.EmailConfig{
					Subject:      email.Subject,
					Body:         email.Body,
					BodyHTML:     email.BodyHTML,
					BodyMJML:     email.BodyMJML,
					DelaySeconds: email.DelaySeconds,
				},
			})
		}
		return out
	}
	return nil
}

// applySequenceOps runs the ordered op list against the working step
// list. Each op type is dispatched in turn; positions are renumbered to
// stay dense (1..N) after structural mutations so subsequent ops in the
// same request can address the result with simple 1-based positions.
//
// The implementation is intentionally pure (no I/O) so it's exercised
// by table-driven unit tests at the package level.
func applySequenceOps(base []generation.Step, ops []sequenceOp) ([]generation.Step, error) {
	steps := append([]generation.Step(nil), base...)
	for i, op := range ops {
		switch strings.ToLower(strings.TrimSpace(op.Op)) {
		case "insert":
			if op.Step == nil {
				return nil, fmt.Errorf("op %d: insert requires `step`", i)
			}
			inserted := *op.Step
			if op.AfterID == 0 {
				// Prepend.
				inserted.Position = 1
				steps = append([]generation.Step{inserted}, steps...)
			} else {
				idx := indexByPosition(steps, op.AfterID)
				if idx < 0 {
					return nil, fmt.Errorf("op %d: insert after_id=%d not found", i, op.AfterID)
				}
				inserted.Position = op.AfterID + 1
				steps = append(steps[:idx+1], append([]generation.Step{inserted}, steps[idx+1:]...)...)
			}
		case "move":
			fromIdx := indexByPosition(steps, op.StepID)
			if fromIdx < 0 {
				return nil, fmt.Errorf("op %d: move step_id=%d not found", i, op.StepID)
			}
			moved := steps[fromIdx]
			steps = append(steps[:fromIdx], steps[fromIdx+1:]...)
			if op.BeforeID == 0 {
				steps = append(steps, moved)
			} else {
				toIdx := indexByPosition(steps, op.BeforeID)
				if toIdx < 0 {
					return nil, fmt.Errorf("op %d: move before_id=%d not found", i, op.BeforeID)
				}
				steps = append(steps[:toIdx], append([]generation.Step{moved}, steps[toIdx:]...)...)
			}
		case "update":
			if op.Patch == nil {
				return nil, fmt.Errorf("op %d: update requires `patch`", i)
			}
			idx := indexByPosition(steps, op.StepID)
			if idx < 0 {
				return nil, fmt.Errorf("op %d: update step_id=%d not found", i, op.StepID)
			}
			patched := *op.Patch
			patched.Position = steps[idx].Position
			steps[idx] = patched
		case "delete":
			idx := indexByPosition(steps, op.StepID)
			if idx < 0 {
				return nil, fmt.Errorf("op %d: delete step_id=%d not found", i, op.StepID)
			}
			steps = append(steps[:idx], steps[idx+1:]...)
		default:
			return nil, fmt.Errorf("op %d: unknown op %q", i, op.Op)
		}
		// Renumber so subsequent ops in the same request operate on a
		// dense 1..N space. Without this, an insert-then-delete-then-
		// insert combo would skip positions and confuse callers.
		for k := range steps {
			steps[k].Position = k + 1
		}
	}
	return steps, nil
}

// indexByPosition is a linear scan over the (small) step list. Returns
// -1 when no entry matches. We don't bother with a map because the
// canvas surfaces don't expect more than a few dozen steps per sequence
// and the renumber-after-each-op invariant means a map would just be
// rebuilt every iteration.
func indexByPosition(steps []generation.Step, pos int) int {
	for i := range steps {
		if steps[i].Position == pos {
			return i
		}
	}
	return -1
}

func (h *Handler) deleteSequence(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	id, ok := sequenceIDFromRequest(w, r)
	if !ok {
		return
	}
	expected, ok := parseSequenceIfMatch(w, r)
	if !ok {
		return
	}
	versioned, supported := h.gen.Sequences.(VersionedSequenceDeleteStore)
	if !supported {
		http.Error(w, "sequence store does not support required optimistic concurrency", http.StatusServiceUnavailable)
		return
	}
	if err := versioned.DeleteWithVersion(r.Context(), tenant, id, expected); err != nil {
		if errors.Is(err, ErrVersionMismatch) {
			http.Error(w, "version mismatch — reload and retry", http.StatusPreconditionFailed)
			return
		}
		if isSequenceNotFound(err) {
			http.Error(w, "sequence not found", http.StatusNotFound)
			return
		}
		http.Error(w, "sequence delete failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeSequenceStatusError(w http.ResponseWriter, raw string) {
	status := strings.ToLower(strings.TrimSpace(raw))
	if status == "active" || status == "paused" {
		http.Error(w, "live sequence statuses are unavailable because the execution runtime is not qualified; allowed authoring values are draft and archived", http.StatusConflict)
		return
	}
	http.Error(w, "unsupported status; allowed authoring values are draft and archived", http.StatusBadRequest)
}

func isSequenceNotFound(err error) bool {
	return errors.Is(err, ErrNotFound) || errors.Is(err, sequencecontract.ErrNotFound)
}

func (h *Handler) regenerateEmail(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	id, ok := sequenceIDFromRequest(w, r)
	if !ok {
		return
	}
	posStr := chi.URLParam(r, "position")
	pos, err := strconv.Atoi(posStr)
	if err != nil || pos < 1 || pos > sequenceMaxPosition {
		http.Error(w, "position must be a positive integer within the supported sequence range", http.StatusBadRequest)
		return
	}
	var req generation.RegenerateRequest
	if err := decodeRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &req); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	req.SequenceID = id
	req.EmailPosition = pos

	// Regeneration is a two-phase authoring operation: this endpoint produces a
	// review candidate, and the client persists that candidate through the
	// ordinary versioned PATCH path only after explicit acceptance. Loading and
	// validating the target before consuming quota also prevents invalid IDs or
	// unsupported canvas drafts from spending a tenant's allowance.
	seq, err := h.gen.Sequences.Get(r.Context(), tenant, id)
	if err != nil {
		if isSequenceNotFound(err) {
			http.Error(w, "sequence not found", http.StatusNotFound)
			return
		}
		http.Error(w, "sequence lookup failed", http.StatusInternalServerError)
		return
	}
	if seq.Status != sequencecontract.StatusDraft {
		http.Error(w, "regeneration previews are available only for draft sequences", http.StatusConflict)
		return
	}
	if strings.TrimSpace(seq.TemplateID) == "" {
		http.Error(w, "regeneration preview unavailable: sequence has no source template", http.StatusConflict)
		return
	}
	if !sequenceHasTopLevelEmailAt(seq, pos) {
		http.Error(w, "email step not found", http.StatusNotFound)
		return
	}
	prof, err := h.Store.GetProfile(r.Context(), tenant)
	if err != nil {
		http.Error(w, "profile not built", http.StatusBadRequest)
		return
	}

	// Quota gate. Regenerate is one Claude turn per call, so it
	// counts as one quota unit — same as a chat / subject_line call.
	if err := h.quotaOrNoop().CheckAndConsume(r.Context(), tenant, "regenerate", quota.CostMilliCredits("regenerate", 1)); err != nil {
		if errors.Is(err, quota.ErrOverQuota) {
			writeQuotaExceeded(w, h.quotaOrNoop(), r.Context(), tenant, "regenerate")
			return
		}
		http.Error(w, "sequence quota unavailable", http.StatusInternalServerError)
		return
	}

	// Return the generated candidate synchronously even when SequenceJobs is
	// configured. The current job schema has no isolated preview-result field;
	// its old async implementation made the job "succeed" by overwriting the
	// sequence before the user accepted the candidate. Synchronous preview keeps
	// the established GeneratedEmail response contract without a destructive
	// side effect. A future async version must persist the candidate separately.
	em, err := h.gen.Engine.Regenerate(r.Context(), seq, req, prof)
	if err != nil {
		if errors.Is(err, templates.ErrNotFound) {
			http.Error(w, "regeneration preview unavailable: source template not found", http.StatusConflict)
			return
		}
		http.Error(w, "regeneration preview failed", statusForLLMError(err))
		return
	}
	writeJSON(w, http.StatusOK, em)
}

// sequenceHasTopLevelEmailAt deliberately excludes nested condition branches:
// the public regenerate route addresses a top-level integer position and cannot
// identify a branch-local step without risking a rewrite of the wrong email.
func sequenceHasTopLevelEmailAt(seq generation.Sequence, position int) bool {
	for _, step := range seq.Steps {
		if step.Position == position && step.Type == generation.StepTypeEmail && step.Email != nil {
			return true
		}
	}
	for _, email := range seq.Emails {
		if email.Position == position {
			return true
		}
	}
	return false
}
