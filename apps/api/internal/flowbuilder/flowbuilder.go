package flowbuilder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
	"github.com/postwave/postwave/apps/api/internal/runtimecapability"
)

const flowBuilderJSONMaxBodyBytes int64 = 1 << 20

const flowRuntimeQualified = false

var flowRuntime = func() runtimecapability.Descriptor {
	runtime := runtimecapability.Unavailable(
		"flow_execution",
		"flow_runtime_unavailable",
		"Flow execution is unavailable; the flow was not activated, published, or dispatched.",
		"tenant_scoped_worker_authority",
		"authenticated_internal_trigger_delivery",
		"durable_claim_recovery",
	)
	runtime.ExecutionEnabled = flowRuntimeQualified
	return runtime
}()

// RuntimeDescriptor is the canonical end-to-end flow execution capability.
// Authoring and inspection may remain mounted while this reports unavailable.
func RuntimeDescriptor() runtimecapability.Descriptor { return flowRuntime }

type Deps struct {
	Repo        *Repo
	TagExecutor TagActionExecutor
	Logger      *slog.Logger
}

// TagActionExecutor is implemented by the tags subscriber-tag store.
// The flow runtime can use this for profile/list action nodes without
// making flowbuilder import tags directly.
type TagActionExecutor interface {
	ApplyByName(ctx context.Context, tenantID, subscriberID, name, appliedBy, source string) (string, error)
	RemoveByName(ctx context.Context, tenantID, subscriberID, name string) error
}

type CatalogResponse struct {
	SchemaVersion string                       `json:"schema_version"`
	Runtime       runtimecapability.Descriptor `json:"runtime"`
	Triggers      []CatalogItem                `json:"triggers"`
	Nodes         []CatalogItem                `json:"nodes"`
	Actions       []CatalogItem                `json:"actions"`
	Statuses      []string                     `json:"statuses"`
	// ConditionFields enumerates the fields a branch/goal segment_condition can
	// reference, so the UI can offer them in a dropdown. The `custom.predicted_*`
	// / `custom.rfm_*` fields are hydrated onto every subscriber at flow-execution
	// time (services/automation hydratePredictionFields), powering Klaviyo-style
	// predictive triggers ("churn risk > 0.8 → win-back").
	ConditionFields []ConditionFieldSpec `json:"condition_fields,omitempty"`
}

type ConditionFieldSpec struct {
	Key      string `json:"key"` // condition field path, e.g. "custom.predicted_churn_risk"
	Label    string `json:"label"`
	Type     string `json:"type"`     // number | string | datetime
	Category string `json:"category"` // profile | predictive | rfm
}

type CatalogItem struct {
	Key            string         `json:"key"`
	Label          string         `json:"label"`
	Category       string         `json:"category"`
	Channel        string         `json:"channel,omitempty"`
	RuntimeStatus  string         `json:"runtime_status"`
	Fields         []FieldSpec    `json:"fields,omitempty"`
	RequiresReview bool           `json:"requires_review,omitempty"`
	Definition     map[string]any `json:"definition,omitempty"`
}

type FieldSpec struct {
	Key      string   `json:"key"`
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Options  []string `json:"options,omitempty"`
}

type GraphValidateRequest struct {
	EntryID  string        `json:"entry_id,omitempty"`
	Triggers []TriggerSpec `json:"triggers,omitempty"`
	Nodes    []NodeSpec    `json:"nodes"`
	Edges    []EdgeSpec    `json:"edges,omitempty"`
}

type TriggerSpec struct {
	ID   string `json:"id,omitempty"`
	Type string `json:"type"`
}

type NodeSpec struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	TrueNext  string         `json:"true_next,omitempty"`
	FalseNext string         `json:"false_next,omitempty"`
	Action    map[string]any `json:"action,omitempty"`
	// Raw is the node exactly as it was authored, when the caller had it.
	//
	// FlowGraph.Nodes is []map[string]any BY DESIGN and every authoring surface
	// writes type-specific values FLAT on the node — apps/web's FlowNode has
	// template_id, sms_body, duration_seconds and webhook_url as top-level keys
	// (apps/web/src/lib/flows-api.ts:48). NodeSpec cannot hold those, so a
	// required-field check that saw only NodeSpec was looking somewhere the
	// value never is. Carrying the original map is what lets
	// missingRequiredFields answer about the node that actually exists.
	//
	// json:"-": this is a decode-side convenience, never part of the wire
	// contract in either direction.
	Raw map[string]any `json:"-"`
}

type EdgeSpec struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type GraphValidateResponse struct {
	Valid       bool                         `json:"valid"`
	Executable  bool                         `json:"executable"`
	Errors      []string                     `json:"errors,omitempty"`
	Warnings    []string                     `json:"warnings,omitempty"`
	Supported   int                          `json:"supported_nodes"`
	Planned     int                          `json:"planned_nodes"`
	Unsupported int                          `json:"unsupported_nodes"`
	Runtime     runtimecapability.Descriptor `json:"runtime"`
}

type FlowGraph struct {
	EntryID  string           `json:"entry_id,omitempty"`
	Triggers []map[string]any `json:"triggers,omitempty"`
	Nodes    []map[string]any `json:"nodes"`
	Edges    []map[string]any `json:"edges,omitempty"`
	Goals    []map[string]any `json:"goals,omitempty"`
}

type FlowInput struct {
	Name   string `json:"name,omitempty"`
	Status string `json:"status,omitempty"`
	// Pointers so "not supplied" is distinguishable from "set to the zero
	// value" — a PATCH that omits the policy must not silently reset it to
	// "once".
	ReEnrollment              *string          `json:"re_enrollment,omitempty"`
	ReEnrollmentCooldownHours *int             `json:"re_enrollment_cooldown_hours,omitempty"`
	Graph                     *FlowGraph       `json:"graph,omitempty"`
	EntryID                   string           `json:"entry_id,omitempty"`
	Triggers                  []map[string]any `json:"triggers,omitempty"`
	Nodes                     []map[string]any `json:"nodes,omitempty"`
	Edges                     []map[string]any `json:"edges,omitempty"`
	Goals                     []map[string]any `json:"goals,omitempty"`
	Analytics                 map[string]any   `json:"analytics,omitempty"`
	GeneratedBy               string           `json:"generated_by,omitempty"`
	SourceRef                 string           `json:"source_ref,omitempty"`
}

type Flow struct {
	ID       string `json:"id"`
	TenantID string `json:"tenant_id,omitempty"`
	// ETag is the exact strong validator clients must echo in If-Match for
	// every mutable flow write. It is present in list bodies as well as the
	// response header so card actions never need a save-time token fetch.
	ETag    string `json:"etag"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	Version int    `json:"version"`
	// ReEnrollment controls whether a subscriber may enter this flow more than
	// once: once (default) | always | cooldown. Abandoned-cart, win-back,
	// birthday and back-in-stock all need re-entry; a welcome series does not.
	// The column existed but nothing read or wrote it, so the policy was
	// settable only by hand in the database.
	ReEnrollment string `json:"re_enrollment"`
	// ReEnrollmentCooldownHours applies only when ReEnrollment == "cooldown".
	ReEnrollmentCooldownHours int                           `json:"re_enrollment_cooldown_hours"`
	Graph                     FlowGraph                     `json:"graph"`
	Analytics                 map[string]any                `json:"analytics,omitempty"`
	LatestVersion             *FlowVersion                  `json:"latest_version,omitempty"`
	PublishedAt               *time.Time                    `json:"published_at,omitempty"`
	CreatedAt                 time.Time                     `json:"created_at"`
	UpdatedAt                 time.Time                     `json:"updated_at"`
	Runtime                   *runtimecapability.Descriptor `json:"runtime,omitempty"`
}

type FlowVersion struct {
	ID          string     `json:"id"`
	TenantID    string     `json:"tenant_id,omitempty"`
	FlowID      string     `json:"flow_id"`
	Version     int        `json:"version"`
	Status      string     `json:"status"`
	Graph       FlowGraph  `json:"graph"`
	GeneratedBy string     `json:"generated_by"`
	SourceRef   string     `json:"source_ref,omitempty"`
	PublishedAt *time.Time `json:"published_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

type VersionInput struct {
	Graph       *FlowGraph `json:"graph,omitempty"`
	GeneratedBy string     `json:"generated_by,omitempty"`
	SourceRef   string     `json:"source_ref,omitempty"`
}

type PromoteInput struct {
	Activate bool `json:"activate,omitempty"`
}

var ErrNotFound = errors.New("flowbuilder: not found")

// ErrPreconditionFailed means the flow changed after the representation the
// caller edited was read. Repository writes enforce it atomically as well as
// the HTTP handler, closing the read-check-write race.
var ErrPreconditionFailed = errors.New("flowbuilder: stale flow version")

// ErrInvalidInput is a 400-class rejection: the caller sent something the flow
// model cannot represent (e.g. an unknown re-enrollment policy).
var ErrInvalidInput = errors.New("flowbuilder: invalid input")

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil {
		d = &Deps{}
	}
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/flow-builder/catalog", d.Catalog)
	r.With(write).Post("/api/v1/flow-builder/validate", d.ValidateGraph)
	if d.Repo == nil {
		return
	}
	r.With(read).Get("/api/v1/flow-builder/flows", d.ListFlows)
	r.With(write).Post("/api/v1/flow-builder/flows", d.CreateFlow)
	r.With(read).Get("/api/v1/flow-builder/flows/{id}", d.GetFlow)
	r.With(write).Patch("/api/v1/flow-builder/flows/{id}", d.UpdateFlow)
	r.With(read).Get("/api/v1/flow-builder/flows/{id}/versions", d.ListVersions)
	r.With(read).Get("/api/v1/flow-builder/flows/{id}/runs", d.ListRuns)
	r.With(write).Post("/api/v1/flow-builder/flows/{id}/versions", d.CreateVersion)
	r.With(write).Post("/api/v1/flow-builder/flows/{id}/versions/{version_id}/promote", d.PromoteVersion)
	r.With(write).Post("/api/v1/flow-builder/flows/{id}/publish", d.PublishFlow)
	r.With(write).Post("/api/v1/flow-builder/flows/{id}/activate", d.ActivateFlow)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, Catalog())
}

// graphValidateWire is the HTTP request shape for ValidateGraph.
//
// It exists because GraphValidateRequest is the wrong DECODE target even
// though it is the right VALIDATION type. httpbody.DecodeJSON rejects unknown
// fields, and a node is []map[string]any everywhere else in this package — so
// decoding straight into []NodeSpec made the endpoint 400 `unknown_field` on
// the only node shape any editor in this repository produces (a send_email
// carrying template_id, or any node the canvas has given a `position`).
//
// Decoding the ENVELOPE strictly and the graph free-form keeps the typo
// protection where it is useful and routes the body through the exact same
// ValidateFlowGraph → graphValidateRequest path CreateVersion uses. The HTTP
// verdict and the in-process verdict are now the same function, so they cannot
// disagree about whether a graph is publishable.
type graphValidateWire struct {
	EntryID  string           `json:"entry_id,omitempty"`
	Triggers []map[string]any `json:"triggers,omitempty"`
	Nodes    []map[string]any `json:"nodes"`
	Edges    []map[string]any `json:"edges,omitempty"`
	Goals    []map[string]any `json:"goals,omitempty"`
}

func (d *Deps) ValidateGraph(w http.ResponseWriter, r *http.Request) {
	var in graphValidateWire
	if err := httpbody.DecodeJSON(w, r, flowBuilderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out := ValidateFlowGraph(FlowGraph{
		EntryID:  in.EntryID,
		Triggers: in.Triggers,
		Nodes:    in.Nodes,
		Edges:    in.Edges,
		Goals:    in.Goals,
	})
	status := http.StatusOK
	if !out.Valid {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, out)
}

func (d *Deps) ListFlows(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	out, next, err := d.Repo.ListFlows(r.Context(), tenantID, r.URL.Query().Get("status"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for i := range out {
		annotateFlowRuntime(&out[i])
	}
	// Envelope serializes as {"items":[...], "nextCursor"?} — additive over
	// the prior {"items":[...]} shape (nextCursor omitted on the last page).
	writeJSON(w, http.StatusOK, pagination.Envelope[Flow]{Items: out, NextCursor: next})
}

func (d *Deps) CreateFlow(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in FlowInput
	if err := httpbody.DecodeJSON(w, r, flowBuilderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if normalizeFlowStatus(in.Status) != "draft" {
		runtimecapability.WriteUnavailable(w, flowRuntime)
		return
	}
	graph, _ := in.EffectiveGraph(FlowGraph{})
	if validation := ValidateFlowGraph(graph); !validation.Valid {
		writeJSON(w, http.StatusUnprocessableEntity, validation)
		return
	} else if normalizeFlowStatus(in.Status) == "active" && !validation.Executable {
		writeJSON(w, http.StatusConflict, validation)
		return
	}
	out, err := d.Repo.CreateFlow(r.Context(), tenantID, in)
	if err != nil {
		d.writeFlowRepoError(w, r, err, "create_flow_failed")
		return
	}
	writeFlowResponse(w, http.StatusCreated, out)
}

func (d *Deps) GetFlow(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.GetFlow(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeFlowRepoError(w, r, err, "flow_failed")
		return
	}
	writeFlowResponse(w, http.StatusOK, out)
}

func (d *Deps) UpdateFlow(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in FlowInput
	if err := httpbody.DecodeJSON(w, r, flowBuilderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.Status) != "" && normalizeFlowStatus(in.Status) == "active" {
		runtimecapability.WriteUnavailable(w, flowRuntime)
		return
	}
	existing, err := d.Repo.GetFlow(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeFlowRepoError(w, r, err, "flow_failed")
		return
	}
	if !requireFlowIfMatch(w, r, existing) {
		return
	}
	graph, _ := in.EffectiveGraph(existing.Graph)
	targetStatus := normalizeFlowStatus(in.Status)
	if strings.TrimSpace(in.Status) == "" {
		targetStatus = existing.Status
	}
	// FLOW-008: editing an ACTIVE flow (no explicit status change) must NOT
	// mutate the live journey graph. Persist the edit as a DRAFT version
	// instead — the live graph only changes on an explicit Publish. (Explicit
	// activation is still contained above.) A graph is validated but not
	// required to be Executable, which is never true under containment.
	if existing.Status == "active" && strings.TrimSpace(in.Status) == "" {
		if validation := ValidateFlowGraph(graph); !validation.Valid {
			writeJSON(w, http.StatusUnprocessableEntity, validation)
			return
		}
		_, out, err := d.Repo.CreateVersionWithFlow(
			r.Context(), tenantID, existing,
			VersionInput{GeneratedBy: in.GeneratedBy, SourceRef: in.SourceRef}, graph,
		)
		if err != nil {
			d.writeFlowRepoError(w, r, err, "save_draft_failed")
			return
		}
		writeFlowResponse(w, http.StatusOK, out)
		return
	}
	if targetStatus == "active" {
		runtimecapability.WriteUnavailable(w, flowRuntime)
		return
	}
	if validation := ValidateFlowGraph(graph); !validation.Valid {
		writeJSON(w, http.StatusUnprocessableEntity, validation)
		return
	} else if targetStatus == "active" && !validation.Executable {
		writeJSON(w, http.StatusConflict, validation)
		return
	}
	out, err := d.Repo.UpdateFlow(r.Context(), tenantID, existing, in)
	if err != nil {
		d.writeFlowRepoError(w, r, err, "update_flow_failed")
		return
	}
	writeFlowResponse(w, http.StatusOK, out)
}

func (d *Deps) ListVersions(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Keyset pagination; this list was previously unbounded, so 200 is the
	// new default page size (and ceiling) to bound response payloads.
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	out, next, err := d.Repo.ListVersions(r.Context(), tenantID, chi.URLParam(r, "id"), limit, cursor)
	if err != nil {
		d.writeFlowRepoError(w, r, err, "versions_failed")
		return
	}
	// Envelope serializes as {"items":[...], "nextCursor"?} — additive over
	// the prior {"items":[...]} shape (nextCursor omitted on the last page).
	writeJSON(w, http.StatusOK, pagination.Envelope[FlowVersion]{Items: out, NextCursor: next})
}

// ListRuns GET /api/v1/flow-builder/flows/{id}/runs — per-subscriber run
// timeline for the run inspector (FLOW-035). Reads the existing flow_runs
// table via the already-tenant-scoped repo query.
func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit := 100
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	out, err := d.Repo.ListRecentRuns(r.Context(), tenantID, chi.URLParam(r, "id"), limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateVersion(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in VersionInput
	if err := httpbody.DecodeJSON(w, r, flowBuilderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	existing, err := d.Repo.GetFlow(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeFlowRepoError(w, r, err, "flow_failed")
		return
	}
	if !requireFlowIfMatch(w, r, existing) {
		return
	}
	graph := existing.Graph
	if in.Graph != nil {
		graph = *in.Graph
	}
	normalizeGraph(&graph)
	if validation := ValidateFlowGraph(graph); !validation.Valid {
		writeJSON(w, http.StatusUnprocessableEntity, validation)
		return
	}
	out, current, err := d.Repo.CreateVersionWithFlow(r.Context(), tenantID, existing, in, graph)
	if err != nil {
		d.writeFlowRepoError(w, r, err, "create_version_failed")
		return
	}
	annotateFlowRuntime(current)
	w.Header().Set("ETag", current.ETag)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) PromoteVersion(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantID(r); !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PromoteInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, httpbody.DefaultJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return

		}
	}
	runtimecapability.WriteUnavailable(w, flowRuntime)
}

// PublishInput is the optional body of POST /flows/{id}/publish. An empty body
// publishes the latest draft version.
type PublishInput struct {
	VersionID string `json:"version_id,omitempty"`
}

// PublishFlow POST /api/v1/flow-builder/flows/{id}/publish (FLOW-008).
//
// Promotes a draft version's graph into an ACTIVE flow's live journey. This is
// control-plane graph movement, not an execution transition — it only applies
// to an already-active flow and can never start execution, so unlike
// PromoteVersion/ActivateFlow it is not gated on the flow runtime.
func (d *Deps) PublishFlow(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PublishInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, httpbody.DefaultJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
	}
	existing, err := d.Repo.GetFlow(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeFlowRepoError(w, r, err, "flow_failed")
		return
	}
	if !requireFlowIfMatch(w, r, existing) {
		return
	}
	out, err := d.Repo.PublishFlow(
		r.Context(), tenantID, existing.ID, in.VersionID, existing.UpdatedAt,
	)
	if err != nil {
		d.writeFlowRepoError(w, r, err, "publish_flow_failed")
		return
	}
	writeFlowResponse(w, http.StatusOK, out)
}

func (d *Deps) ActivateFlow(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantID(r); !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runtimecapability.WriteUnavailable(w, flowRuntime)
}

func Catalog() CatalogResponse {
	catalog := CatalogResponse{
		SchemaVersion: "klv03.flow-builder.v1",
		Runtime:       flowRuntime,
		Statuses:      []string{"draft", "active", "paused", "archived"},
		ConditionFields: []ConditionFieldSpec{
			{Key: "email", Label: "Email", Type: "string", Category: "profile"},
			{Key: "status", Label: "Status", Type: "string", Category: "profile"},
			{Key: "tags", Label: "Tags", Type: "string", Category: "profile"},
			{Key: "consent_source", Label: "Consent source", Type: "string", Category: "profile"},
			{Key: "custom.predicted_churn_risk", Label: "Predicted churn risk", Type: "number", Category: "predictive"},
			{Key: "custom.predicted_clv_cents", Label: "Predicted CLV (cents)", Type: "number", Category: "predictive"},
			{Key: "custom.predicted_order_count", Label: "Predicted order count", Type: "number", Category: "predictive"},
			{Key: "custom.predicted_next_order_at", Label: "Expected next order", Type: "datetime", Category: "predictive"},
			{Key: "custom.predicted_gender", Label: "Predicted gender", Type: "string", Category: "predictive"},
			{Key: "custom.rfm_segment", Label: "RFM segment", Type: "string", Category: "rfm"},
			{Key: "custom.rfm_score", Label: "RFM score", Type: "string", Category: "rfm"},
			{Key: "custom.rfm_recency", Label: "RFM recency (1-5)", Type: "number", Category: "rfm"},
			{Key: "custom.rfm_frequency", Label: "RFM frequency (1-5)", Type: "number", Category: "rfm"},
			{Key: "custom.rfm_monetary", Label: "RFM monetary (1-5)", Type: "number", Category: "rfm"},
		},
		Triggers: []CatalogItem{
			{Key: "list_joined", Label: "Joined list", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "list_id", Type: "string", Required: true}}},
			{Key: "tag_added", Label: "Tag added", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "tag", Type: "string"}}},
			{Key: "tag_removed", Label: "Tag removed", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "tag", Type: "string"}}},
			{Key: "segment_joined", Label: "Entered segment", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "segment_id", Type: "string", Required: true}}},
			{Key: "product_event", Label: "Product event", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "event_name", Type: "string", Required: true}}},
			{Key: "subscriber_opened_email", Label: "Opened email", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "campaign_id", Type: "string"}}},
			{Key: "subscriber_clicked_link", Label: "Clicked link", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "campaign_id", Type: "string"}, {Key: "url_pattern", Type: "string"}}},
			{Key: "subscriber_delivered_email", Label: "Delivered email", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "campaign_id", Type: "string"}, {Key: "delay_strategy", Type: "select", Options: []string{"immediate", "optimized"}}}},
			{Key: "subscriber_did_not_open", Label: "Did not open", Category: "trigger", RuntimeStatus: "partial", Fields: []FieldSpec{{Key: "campaign_id", Type: "string", Required: true}, {Key: "after_days", Type: "number", Required: true}}},
			{Key: "inbound_webhook", Label: "Inbound webhook", Category: "trigger", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "event_type", Type: "string", Required: true}}},
			{Key: "email_reply", Label: "Email reply", Category: "trigger", RuntimeStatus: "supported"},
			{Key: "date_field", Label: "Profile date", Category: "trigger", RuntimeStatus: "partial", Fields: []FieldSpec{{Key: "field", Type: "string", Required: true}, {Key: "offset_days", Type: "number"}}},
		},
		Nodes: []CatalogItem{
			{Key: "wait", Label: "Time delay", Category: "wait", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "duration_seconds", Type: "number", Required: true}, {Key: "delay_strategy", Type: "select", Options: []string{"fixed", "optimized"}}}},
			{Key: "wait_until", Label: "Wait until date", Category: "wait", RuntimeStatus: "partial", Fields: []FieldSpec{{Key: "wait_until", Type: "datetime", Required: true}}},
			{Key: "wait_until_trigger", Label: "Wait until event", Category: "wait", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "wait_trigger", Type: "trigger", Required: true}}},
			{Key: "send_email", Label: "Email message", Category: "message", Channel: "email", RuntimeStatus: "supported", RequiresReview: true, Fields: []FieldSpec{{Key: "template_id", Type: "string", Required: true}}},
			{Key: "send_sms", Label: "SMS message", Category: "message", Channel: "sms", RuntimeStatus: "supported", RequiresReview: true, Fields: []FieldSpec{{Key: "sms_body", Type: "textarea", Required: true}}},
			{Key: "branch", Label: "Conditional split", Category: "split", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "condition", Type: "segment_condition", Required: true}}},
			{Key: "percentage_split", Label: "Percentage split", Category: "split", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "variants", Type: "array", Required: true}}},
			{Key: "ab_test", Label: "A/B test", Category: "split", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "variants", Type: "array", Required: true}}},
			{Key: "webhook", Label: "Webhook", Category: "action", Channel: "webhook", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "webhook_url", Type: "url", Required: true}, {Key: "webhook_method", Type: "select", Options: []string{"POST", "PUT", "PATCH"}}}},
			{Key: "action", Label: "Profile/list action", Category: "action", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "action.kind", Type: "select", Required: true, Options: []string{"add_tag", "remove_tag", "move_to_list", "unsubscribe", "update_profile_property"}}}},
			{Key: "goal", Label: "Goal", Category: "goal", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "goal", Type: "segment_condition", Required: true}}},
			{Key: "manual_review", Label: "Manual review", Category: "control", RuntimeStatus: "supported", RequiresReview: true},
			{Key: "coupon_assign", Label: "Assign coupon", Category: "commerce", RuntimeStatus: "unavailable", Fields: []FieldSpec{{Key: "metadata.coupon_pool_id", Type: "string", Required: true}}},
			{Key: "exit", Label: "Exit", Category: "control", RuntimeStatus: "supported"},
		},
		Actions: []CatalogItem{
			{Key: "add_tag", Label: "Add tag", Category: "tag", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "tag", Type: "string", Required: true}}},
			{Key: "remove_tag", Label: "Remove tag", Category: "tag", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "tag", Type: "string", Required: true}}},
			{Key: "move_to_list", Label: "Move to list", Category: "list", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "list_id", Type: "string", Required: true}}},
			{Key: "unsubscribe", Label: "Unsubscribe", Category: "consent", RuntimeStatus: "supported"},
			{Key: "update_profile_property", Label: "Update profile property", Category: "profile", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "field", Type: "string", Required: true}, {Key: "value", Type: "json", Required: true}}},
			{Key: "flow_webhook", Label: "Send webhook", Category: "webhook", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "url", Type: "url", Required: true}}},
		},
	}
	// The catalog remains useful for draft authoring, but no individual item may
	// imply an end-to-end executable path while the shared runtime is contained.
	for _, items := range [][]CatalogItem{catalog.Triggers, catalog.Nodes, catalog.Actions} {
		for i := range items {
			items[i].RuntimeStatus = runtimecapability.StatusUnavailable
		}
	}
	return catalog
}

func Validate(in GraphValidateRequest) GraphValidateResponse {
	out := GraphValidateResponse{Valid: true, Runtime: flowRuntime}
	// incomplete: at least one node is missing a field its own catalog entry
	// marks Required. Structurally fine (drafts are allowed), but it cannot run.
	incomplete := false
	if len(in.Nodes) == 0 {
		out.Errors = append(out.Errors, "at least one node is required")
	}
	allowed := nodeStatusMap()
	ids := map[string]struct{}{}
	for i, node := range in.Nodes {
		node.ID = strings.TrimSpace(node.ID)
		node.Type = strings.TrimSpace(node.Type)
		if node.ID == "" {
			out.Errors = append(out.Errors, fmt.Sprintf("node %d: id is required", i))
			continue
		}
		if _, exists := ids[node.ID]; exists {
			out.Errors = append(out.Errors, fmt.Sprintf("node %q: duplicate id", node.ID))
		}
		ids[node.ID] = struct{}{}
		status, ok := allowed[node.Type]
		if !ok {
			out.Errors = append(out.Errors, fmt.Sprintf("node %q: unsupported type %q", node.ID, node.Type))
			out.Unsupported++
			continue
		}
		switch status {
		case "supported":
			out.Supported++
		case "planned", "partial", runtimecapability.StatusUnavailable:
			out.Planned++
			out.Warnings = append(out.Warnings, fmt.Sprintf("node %q: type %q is %s", node.ID, node.Type, status))
		default:
			out.Unsupported++
		}
		if node.Type == "branch" && (node.TrueNext == "" || node.FalseNext == "") {
			out.Warnings = append(out.Warnings, fmt.Sprintf("branch node %q should define true_next and false_next", node.ID))
		}
		// Enforce the catalog's own Required fields. FieldSpec.Required was
		// declared and read NOWHERE: a send_email node with no template_id
		// validated clean, reported Executable:true, and then failed at runtime
		// for every subscriber who reached it. The builder blessed a graph it
		// already knew could not run.
		for _, missing := range missingRequiredFields(node) {
			// A WARNING, not an error: a half-built graph must still validate,
			// which is what the builder's draft workflow depends on. But it must
			// NOT be reported Executable — that was the actual harm. A send_email
			// node with no template_id used to validate clean, report
			// Executable:true, ship, and then fail at runtime for every
			// subscriber who reached it.
			incomplete = true
			out.Warnings = append(out.Warnings,
				fmt.Sprintf("node %q (%s): required field %q is missing", node.ID, node.Type, missing))
		}
	}
	if in.EntryID != "" {
		if _, ok := ids[in.EntryID]; !ok {
			out.Errors = append(out.Errors, "entry_id does not reference a node")
		}
	}
	for _, edge := range in.Edges {
		if _, ok := ids[edge.From]; !ok {
			out.Errors = append(out.Errors, fmt.Sprintf("edge from %q does not reference a node", edge.From))
		}
		if _, ok := ids[edge.To]; !ok {
			out.Errors = append(out.Errors, fmt.Sprintf("edge to %q does not reference a node", edge.To))
		}
	}
	out.Valid = len(out.Errors) == 0
	out.Executable = flowRuntimeQualified && out.Valid && out.Unsupported == 0 && out.Planned == 0 && !incomplete
	return out
}

func ValidateFlowGraph(graph FlowGraph) GraphValidateResponse {
	normalizeGraph(&graph)
	return Validate(graphValidateRequest(graph))
}

func (in FlowInput) EffectiveGraph(existing FlowGraph) (FlowGraph, bool) {
	if in.Graph != nil {
		graph := *in.Graph
		normalizeGraph(&graph)
		return graph, true
	}
	if in.EntryID != "" || in.Triggers != nil || in.Nodes != nil || in.Edges != nil || in.Goals != nil {
		graph := FlowGraph{
			EntryID:  in.EntryID,
			Triggers: in.Triggers,
			Nodes:    in.Nodes,
			Edges:    in.Edges,
			Goals:    in.Goals,
		}
		normalizeGraph(&graph)
		return graph, true
	}
	normalizeGraph(&existing)
	return existing, false
}

func graphValidateRequest(graph FlowGraph) GraphValidateRequest {
	var nodes []NodeSpec
	var triggers []TriggerSpec
	var edges []EdgeSpec
	remarshal(graph.Nodes, &nodes)
	remarshal(graph.Triggers, &triggers)
	remarshal(graph.Edges, &edges)
	// Attach each node's ORIGINAL map. remarshal preserves order and length, so
	// index i of the decoded slice is index i of the source; the length guard
	// keeps that an assertion rather than an assumption.
	if len(nodes) == len(graph.Nodes) {
		for i := range nodes {
			nodes[i].Raw = graph.Nodes[i]
		}
	}
	return GraphValidateRequest{
		EntryID:  graph.EntryID,
		Triggers: triggers,
		Nodes:    nodes,
		Edges:    edges,
	}
}

func normalizeGraph(graph *FlowGraph) {
	graph.EntryID = strings.TrimSpace(graph.EntryID)
	graph.Triggers = nonNilMaps(graph.Triggers)
	graph.Nodes = nonNilMaps(graph.Nodes)
	for _, node := range graph.Nodes {
		normalizeNodePosition(node)
	}
	graph.Edges = nonNilMaps(graph.Edges)
	graph.Goals = nonNilMaps(graph.Goals)
}

// Keep in sync with MAX_CANVAS_COORDINATE in apps/web/src/lib/flow-layout.ts.
// This prevents API-authored graphs from persisting coordinates that force the
// browser to allocate an effectively unbounded canvas/SVG surface.
const maxFlowCanvasCoordinate = 16_384

func normalizeNodePosition(node map[string]any) {
	raw, ok := node["position"].(map[string]any)
	if !ok {
		delete(node, "position")
		return
	}
	x, xOK := finiteCoordinate(raw["x"])
	y, yOK := finiteCoordinate(raw["y"])
	if !xOK || !yOK {
		delete(node, "position")
		return
	}
	raw["x"] = math.Min(maxFlowCanvasCoordinate, math.Max(0, x))
	raw["y"] = math.Min(maxFlowCanvasCoordinate, math.Max(0, y))
}

func finiteCoordinate(value any) (float64, bool) {
	var coordinate float64
	switch typed := value.(type) {
	case float64:
		coordinate = typed
	case float32:
		coordinate = float64(typed)
	case int:
		coordinate = float64(typed)
	case int32:
		coordinate = float64(typed)
	case int64:
		coordinate = float64(typed)
	default:
		return 0, false
	}
	return coordinate, !math.IsNaN(coordinate) && !math.IsInf(coordinate, 0)
}

func normalizeFlowStatus(status string) string {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case "", "draft":
		return "draft"
	case "live", "active":
		return "active"
	case "paused":
		return "paused"
	case "archived":
		return "archived"
	default:
		return strings.TrimSpace(strings.ToLower(status))
	}
}

func annotateFlowRuntime(flow *Flow) {
	if flow == nil {
		return
	}
	flow.ETag = flowETag(flow)
	runtime := flowRuntime
	flow.Runtime = &runtime
}

func flowETag(flow *Flow) string {
	if flow == nil || strings.TrimSpace(flow.ID) == "" || flow.UpdatedAt.IsZero() {
		return ""
	}
	return httpcache.ConcurrencyToken("flow", flow.ID, flow.UpdatedAt)
}

// requireFlowIfMatch accepts exactly one strong validator captured with the
// representation being edited. Missing/wildcard values cannot prevent a lost
// update and receive 428; malformed, weak, multi-value, and stale validators
// receive 412. ParseIfMatch deliberately preserves weak/list syntax so neither
// can be truncated into an accidental match.
func requireFlowIfMatch(w http.ResponseWriter, r *http.Request, flow *Flow) bool {
	values := r.Header.Values("If-Match")
	token, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard {
		httpcache.WritePreconditionRequired(w)
		return false
	}
	if len(values) != 1 || strings.HasPrefix(token, "W/") || strings.Contains(token, ",") ||
		len(token) < 2 || token[0] != '"' || token[len(token)-1] != '"' || token != flowETag(flow) {
		httpcache.WritePreconditionFailed(w)
		return false
	}
	return true
}

func writeFlowResponse(w http.ResponseWriter, status int, flow *Flow) {
	annotateFlowRuntime(flow)
	if flow != nil && flow.ETag != "" {
		w.Header().Set("ETag", flow.ETag)
	}
	writeJSON(w, status, flow)
}

func normalizeGeneratedBy(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "ai", "migration", "template":
		return strings.TrimSpace(strings.ToLower(value))
	default:
		return "human"
	}
}

func nonNilMaps(items []map[string]any) []map[string]any {
	if items == nil {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if item == nil {
			item = map[string]any{}
		}
		out = append(out, item)
	}
	return out
}

func remarshal(in any, out any) {
	raw, err := json.Marshal(in)
	if err != nil {
		return
	}
	_ = json.Unmarshal(raw, out)
}

type validationError struct {
	Validation *GraphValidateResponse
}

func (e validationError) Error() string {
	return "flow graph is not executable"
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func (d *Deps) writeFlowRepoError(w http.ResponseWriter, r *http.Request, err error, _ string) {
	if errors.Is(err, ErrPreconditionFailed) {
		httpcache.WritePreconditionFailed(w)
		return
	}
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	if strings.Contains(err.Error(), "validation:") {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	if errors.Is(err, ErrInvalidInput) {
		httperror.Write(w, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

func nodeStatusMap() map[string]string {
	out := map[string]string{}
	for _, node := range Catalog().Nodes {
		out[node.Key] = node.RuntimeStatus
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// nodeFieldSpecs indexes the catalog's field specs by node type.
func nodeFieldSpecs() map[string][]FieldSpec {
	out := map[string][]FieldSpec{}
	for _, node := range Catalog().Nodes {
		out[node.Key] = node.Fields
	}
	return out
}

// missingRequiredFields returns the Required field keys the node does not carry.
//
// WHERE A VALUE LIVES IS NOT ONE PLACE, AND ASSUMING IT WAS PRODUCED A
// PERMANENT FALSE ALARM. This used to read node.Action[key] and nothing else,
// so:
//
//   - send_email/send_sms/wait/wait_until/webhook author their values FLAT on
//     the node (apps/web/src/lib/flows-api.ts:48). None of them has an `action`
//     object at all, so every one of them was reported missing its required
//     field even when it carried it.
//   - the `action` node's catalog key is the DOTTED PATH "action.kind" and the
//     value sits at node.action.kind. Looking up the literal string
//     "action.kind" inside the action map found nothing, so a fully configured
//     action node was also always incomplete.
//
// Result: `incomplete` was true for essentially every real graph, which is the
// same as the check not existing — it could no longer distinguish a graph that
// cannot run from one that can.
//
// A blank string is still absent: an empty template_id is not a template id.
func missingRequiredFields(node NodeSpec) []string {
	specs, ok := nodeFieldSpecs()[node.Type]
	if !ok {
		return nil
	}
	var missing []string
	for _, f := range specs {
		if !f.Required {
			continue
		}
		if !nodeFieldPresent(node, f.Key) {
			missing = append(missing, f.Key)
		}
	}
	return missing
}

// nodeFieldPresent resolves one catalog field key against the node as authored.
//
// Order is widest-first: the raw node map (honouring a dotted path), then the
// typed Action map, which is what an in-process caller that built a NodeSpec by
// hand supplies. Any one of them carrying a non-blank value is enough.
func nodeFieldPresent(node NodeSpec, key string) bool {
	if valuePresent(lookupPath(node.Raw, key)) {
		return true
	}
	if valuePresent(lookupPath(node.Action, key)) {
		return true
	}
	// A dotted key rooted at "action" also resolves against the typed Action
	// map directly ("action.kind" → Action["kind"]), which is how NodeSpec
	// carries an action node when the raw map was never supplied.
	if rest, ok := strings.CutPrefix(key, "action."); ok {
		return valuePresent(lookupPath(node.Action, rest))
	}
	return false
}

// lookupPath walks a dotted key through nested maps. A key with no dot is a
// plain lookup, so the common case costs one map read.
func lookupPath(root map[string]any, key string) (any, bool) {
	if root == nil {
		return nil, false
	}
	if !strings.Contains(key, ".") {
		v, ok := root[key]
		return v, ok
	}
	var current any = root
	for _, segment := range strings.Split(key, ".") {
		node, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = node[segment]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

// valuePresent applies the "blank is absent" rule to a resolved lookup.
func valuePresent(value any, found bool) bool {
	if !found || value == nil {
		return false
	}
	if str, isStr := value.(string); isStr {
		return strings.TrimSpace(str) != ""
	}
	return true
}

// ValidReEnrollment reports whether v is a policy the engine understands.
// Mirrors the automations_re_enrollment_check CHECK constraint (migration 1705)
// and canonical.ReEnrollment in services/automation.
func ValidReEnrollment(v string) bool {
	switch strings.TrimSpace(strings.ToLower(v)) {
	case "once", "always", "cooldown":
		return true
	default:
		return false
	}
}
