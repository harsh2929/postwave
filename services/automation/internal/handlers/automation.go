// Package handlers serves the automation runtime's HTTP control plane.
//
// These endpoints are mounted by services/automation/main.go and consumed by
// the apps/api gateway (which proxies them after tenant auth). They are NOT
// exposed publicly.
package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/automation/internal/canonical"
	"github.com/postwave/postwave/services/automation/internal/httpbody"
	"github.com/postwave/postwave/services/automation/internal/runtime"
)

const automationJSONMaxBodyBytes int64 = 64 << 10

// Handlers bundles per-request engine + store deps.
type Handlers struct {
	Engine     *runtime.Engine
	Store      runtime.StateStore
	Queue      runtime.Queue
	Dispatcher *runtime.EventDispatcher
	Triggers   runtime.BehavioralTriggerWriter
	// Automations backs GET/POST /v1/automations and PATCH /v1/automations/{id}.
	//
	// It is NOT the runtime's AutomationLister, and the first version of the
	// list route was wrong to reuse that: ListActiveByTenant answers "what
	// should execute", which excludes drafts -- so an agent that created an
	// automation could not list it, and the SDK's `status` filter had nothing
	// to filter. The store reads both tables (the web builder writes to
	// automation_journeys) across every status.
	Automations runtime.AutomationStore
}

// Register mounts the automation routes on r.
func Register(r chi.Router, h *Handlers) {
	r.Get("/v1/automations/health", h.Health)
	r.Get("/v1/automations", h.List)
	r.Post("/v1/automations", h.Create)
	r.Patch("/v1/automations/{id}", h.Update)
	r.Post("/v1/automations/trigger", h.Trigger)
	r.Get("/v1/automations/{id}/executions", h.ListExecutions)
	r.Get("/v1/automations/{id}/events", h.ListEvents)
	r.Get("/v1/automations/{id}/step-metrics", h.ListStepMetrics)
	r.Post("/v1/automations/{id}/behavioral-triggers", h.CreateBehavioralTrigger)
	r.Post("/v1/automations/{id}/pause", h.Pause)
	r.Post("/v1/automations/{id}/resume", h.Resume)
	if h.Dispatcher != nil {
		r.Post("/v1/automations/event", h.Dispatcher.HTTPHandler())
	}
}

type triggerReq struct {
	AutomationID    string                 `json:"automation_id"`
	TriggerType     string                 `json:"trigger_type"`
	SubscriberEmail string                 `json:"subscriber_email"`
	SourceEventID   string                 `json:"source_event_id,omitempty"`
	Payload         map[string]interface{} `json:"payload"`
}

type behavioralTriggerReq struct {
	TriggerType string `json:"trigger_type"`
	CampaignID  string `json:"campaign_id"`
	URLPattern  string `json:"url_pattern"`
	WithinDays  int    `json:"within_days"`
	AfterDays   int    `json:"after_days"`
}

type behavioralTriggerResp struct {
	ID           string `json:"id"`
	AutomationID string `json:"automation_id"`
	TriggerType  string `json:"trigger_type"`
	CampaignID   string `json:"campaign_id,omitempty"`
	URLPattern   string `json:"url_pattern,omitempty"`
	WithinDays   int    `json:"within_days,omitempty"`
	AfterDays    int    `json:"after_days,omitempty"`
	CreatedAt    string `json:"created_at"`
}

// Trigger handles POST /v1/automations/trigger.
func (h *Handlers) Trigger(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	var body triggerReq
	if err := httpbody.DecodeJSON(w, r, automationJSONMaxBodyBytes, &body); err != nil {
		writeErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.Message(err))
		return
	}
	if body.AutomationID == "" || body.TriggerType == "" || body.SubscriberEmail == "" {
		writeErr(w, http.StatusBadRequest, "missing_field",
			"automation_id, trigger_type, subscriber_email required")
		return
	}
	ctx := runtime.WithTenant(r.Context(), tenantID)
	sourceEventID := strings.TrimSpace(body.SourceEventID)
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if sourceEventID != "" || idempotencyKey != "" {
		if sourceEventID == "" || idempotencyKey == "" || sourceEventID != idempotencyKey {
			writeErr(w, http.StatusBadRequest, "idempotency_mismatch",
				"Idempotency-Key must exactly match source_event_id")
			return
		}
		disposition, err := h.Engine.TriggerDurable(
			ctx,
			body.AutomationID,
			body.TriggerType,
			body.SubscriberEmail,
			body.Payload,
			sourceEventID,
		)
		if err != nil {
			switch {
			case errors.Is(err, runtime.ErrAutomationNotFound):
				writeErr(w, http.StatusNotFound, "automation_not_found", err.Error())
			case errors.Is(err, runtime.ErrTriggerDefinitionChanged):
				writeErr(w, http.StatusConflict, "trigger_definition_changed",
					"the snapshotted automation trigger no longer exists")
			default:
				w.Header().Set("Retry-After", "1")
				writeErr(w, http.StatusServiceUnavailable, "trigger_retry_required",
					"the durable trigger was not fully accepted; retry with the same idempotency key")
			}
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]string{
			"status":      "accepted",
			"disposition": string(disposition),
		})
		return
	}
	if err := h.Engine.Trigger(ctx, body.AutomationID, body.TriggerType,
		body.SubscriberEmail, body.Payload); err != nil {
		if errors.Is(err, runtime.ErrAutomationNotFound) {
			writeErr(w, http.StatusNotFound, "automation_not_found", err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "trigger_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued"})
}

// CreateBehavioralTrigger handles POST /v1/automations/{id}/behavioral-triggers.
func (h *Handlers) CreateBehavioralTrigger(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	if h.Triggers == nil {
		writeErr(w, http.StatusServiceUnavailable, "trigger_store_unavailable", "automation trigger store is not configured")
		return
	}
	var body behavioralTriggerReq
	if err := httpbody.DecodeJSON(w, r, automationJSONMaxBodyBytes, &body); err != nil {
		writeErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.Message(err))
		return
	}
	trigger, resp, err := buildBehavioralTrigger(chi.URLParam(r, "id"), body)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "unsupported_trigger", err.Error())
		return
	}
	ctx := runtime.WithTenant(r.Context(), tenantID)
	if _, err := h.Triggers.AppendBehavioralTrigger(ctx, resp.AutomationID, trigger); err != nil {
		if errors.Is(err, runtime.ErrAutomationNotFound) {
			writeErr(w, http.StatusNotFound, "automation_not_found", err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "trigger_create_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

func buildBehavioralTrigger(automationID string, body behavioralTriggerReq) (canonical.AutomationTrigger, behavioralTriggerResp, error) {
	id := "bt_" + randomHex(10)
	now := time.Now().UTC()
	triggerType := strings.TrimSpace(body.TriggerType)
	trigger := canonical.AutomationTrigger{
		ID:         id,
		CreatedAt:  &now,
		CampaignID: strings.TrimSpace(body.CampaignID),
		URLPattern: strings.TrimSpace(body.URLPattern),
		WithinDays: body.WithinDays,
		AfterDays:  body.AfterDays,
	}
	switch triggerType {
	case "campaign_opened":
		trigger.Type = runtime.TriggerOpenedEmail
	case "campaign_not_opened":
		trigger.Type = runtime.TriggerDidNotOpen
		if trigger.CampaignID == "" {
			return canonical.AutomationTrigger{}, behavioralTriggerResp{}, fmt.Errorf("campaign_id is required for campaign_not_opened")
		}
		if trigger.AfterDays <= 0 {
			return canonical.AutomationTrigger{}, behavioralTriggerResp{}, fmt.Errorf("after_days must be positive for campaign_not_opened")
		}
	case "link_clicked":
		trigger.Type = runtime.TriggerClickedLink
	case "page_visited":
		trigger.Type = canonical.TriggerProductEvent
		trigger.EventName = "page_visited"
	case "no_link_clicked", "no_activity":
		return canonical.AutomationTrigger{}, behavioralTriggerResp{}, fmt.Errorf("%s requires a scheduled negative-event evaluator that is not enabled yet", triggerType)
	default:
		return canonical.AutomationTrigger{}, behavioralTriggerResp{}, fmt.Errorf("unknown trigger_type %q", triggerType)
	}
	resp := behavioralTriggerResp{
		ID:           id,
		AutomationID: automationID,
		TriggerType:  triggerType,
		CampaignID:   trigger.CampaignID,
		URLPattern:   trigger.URLPattern,
		WithinDays:   trigger.WithinDays,
		AfterDays:    trigger.AfterDays,
		CreatedAt:    now.Format(time.RFC3339Nano),
	}
	return trigger, resp, nil
}

// ListExecutions handles GET /v1/automations/{id}/executions.
//
// The tenant id is derived from the X-Tenant-Id header (set by apps/api when
// it proxies to us).
func (h *Handlers) ListExecutions(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	states, err := h.Store.ListActive(r.Context(), tenantID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	id := chi.URLParam(r, "id")
	filtered := make([]runtime.ExecutionState, 0, len(states))
	for _, st := range states {
		if st.AutomationID == id {
			filtered = append(filtered, st)
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"executions": filtered})
}

// ListEvents handles GET /v1/automations/{id}/events.
func (h *Handlers) ListEvents(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_limit", "limit must be a positive integer")
			return
		}
		limit = n
	}
	events, err := h.Store.ListEvents(r.Context(), tenantID, chi.URLParam(r, "id"), limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"events": events})
}

// ListStepMetrics handles GET /v1/automations/{id}/step-metrics. It returns the
// rolled-up per-node applied/failed counters the flow inspector renders next to
// each step ("send_email applied 1,240, failed 3").
func (h *Handlers) ListStepMetrics(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	metrics, err := h.Store.ListStepMetrics(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"step_metrics": metrics})
}

// Pause handles POST /v1/automations/{id}/pause.
func (h *Handlers) Pause(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.Store.SetPaused(runtime.WithTenant(r.Context(), tenantID), id, true); err != nil {
		writeErr(w, http.StatusInternalServerError, "pause_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "paused"})
}

// Resume handles POST /v1/automations/{id}/resume.
func (h *Handlers) Resume(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.Store.SetPaused(runtime.WithTenant(r.Context(), tenantID), id, false); err != nil {
		writeErr(w, http.StatusInternalServerError, "resume_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "active"})
}

// Health reports queue depth + paused-flags coverage.
func (h *Handlers) Health(w http.ResponseWriter, r *http.Request) {
	depth, err := h.Queue.Depth(context.Background())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "queue_depth_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":      "ok",
		"queue_depth": depth,
	})
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]interface{}{
		"error": map[string]string{"code": code, "message": msg},
	})
}

func tenantIDFromRequest(r *http.Request) string {
	if v := r.Header.Get("X-Tenant-Id"); v != "" {
		return v
	}
	return r.Header.Get("X-Tenant-ID")
}

func randomHex(n int) string {
	if n <= 0 {
		return ""
	}
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return hex.EncodeToString(b)
}

// List handles GET /v1/automations.
//
// Answers the SDK's AutomationListPage: {items, next_cursor}. The first
// version of this route returned {automations} -- a key no client reads -- and
// only active rows, so a freshly created draft was invisible to the agent that
// had just created it. next_cursor is always null: the store returns every row
// the tenant owns, and a page token would promise a second page that never
// exists.
func (h *Handlers) List(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	if h.Automations == nil {
		writeStoreUnavailable(w)
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	out, err := h.Automations.ListByTenant(r.Context(), tenantID, status)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	// Never nil: a nil slice marshals to JSON null and the SDK types this as
	// an array; the empty case is the ordinary one for a new tenant.
	if out == nil {
		out = []*canonical.Automation{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": out, "next_cursor": nil})
}

// Create handles POST /v1/automations.
//
// The body is the SDK's shape -- triggers and nodes carry their settings under
// `config` -- and is flattened onto the canonical structs before validation
// (see automation_wire.go). The graph is validated as the engine would need
// it, and persisted as a draft.
func (h *Handlers) Create(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	if h.Automations == nil {
		writeStoreUnavailable(w)
		return
	}
	var body wireCreate
	if err := httpbody.DecodeJSON(w, r, automationJSONMaxBodyBytes, &body); err != nil {
		writeErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.Message(err))
		return
	}
	triggers, err := decodeTriggers(body.Triggers)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_automation", err.Error())
		return
	}
	nodes, err := decodeNodes(body.Nodes)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_automation", err.Error())
		return
	}
	edges, err := applyEdges(body.Edges, nodes)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_automation", err.Error())
		return
	}
	out, err := h.Automations.Create(r.Context(), tenantID, canonical.Automation{
		Name: body.Name, Triggers: triggers, Nodes: nodes, Edges: edges,
	})
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// Update handles PATCH /v1/automations/{id}.
//
// Partial: absent fields are left alone. Branch labels on edges are stored on
// the branch NODE (TrueNext/FalseNext), so a patch that sends labelled edges
// must send the nodes in the same request -- there is no node to fold the
// label onto otherwise. That is stated as a 400 rather than silently dropping
// the label, which would leave a branch node routing by first-edge order.
func (h *Handlers) Update(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantIDFromRequest(r)
	if tenantID == "" {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "X-Tenant-Id header required")
		return
	}
	if h.Automations == nil {
		writeStoreUnavailable(w)
		return
	}
	id := chi.URLParam(r, "id")
	var body wireUpdate
	if err := httpbody.DecodeJSON(w, r, automationJSONMaxBodyBytes, &body); err != nil {
		writeErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.Message(err))
		return
	}
	patch := runtime.AutomationPatch{Name: body.Name, Status: body.Status}
	if body.Triggers != nil {
		t, err := decodeTriggers(*body.Triggers)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_automation", err.Error())
			return
		}
		patch.Triggers = &t
	}
	var nodes []canonical.AutomationNode
	if body.Nodes != nil {
		n, err := decodeNodes(*body.Nodes)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_automation", err.Error())
			return
		}
		nodes = n
		patch.Nodes = &nodes
	}
	if body.Edges != nil {
		if body.Nodes == nil {
			for _, e := range *body.Edges {
				if e.Branch != "" {
					writeErr(w, http.StatusBadRequest, "invalid_automation",
						"edges with a branch label must be sent together with nodes: the label is stored on the branch node")
					return
				}
			}
		}
		e, err := applyEdges(*body.Edges, nodes)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_automation", err.Error())
			return
		}
		patch.Edges = &e
	}
	out, err := h.Automations.Update(r.Context(), tenantID, id, patch)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func writeStoreUnavailable(w http.ResponseWriter) {
	// Handlers is built field-by-field in main.go. An unwired store is a
	// deployment that cannot answer this, which is a different statement from
	// "you have no automations" -- and saying the wrong one would have a
	// caller conclude their flows had vanished.
	writeErr(w, http.StatusServiceUnavailable, "store_unavailable",
		"automation storage is not configured on this deployment")
}

func writeStoreErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, runtime.ErrAutomationNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "automation not found")
	case errors.Is(err, runtime.ErrInvalidAutomation):
		writeErr(w, http.StatusBadRequest, "invalid_automation",
			strings.TrimPrefix(err.Error(), runtime.ErrInvalidAutomation.Error()+": "))
	default:
		writeErr(w, http.StatusInternalServerError, "store_failed", err.Error())
	}
}
