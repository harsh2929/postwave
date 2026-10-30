package service_suite

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Deps struct {
	Repo      *Repo
	Logger    *slog.Logger
	CursorKey []byte
}

type Repo struct {
	Pool *db.Pool
}

type HubConfig struct {
	TenantBinding          string         `json:"tenantId"`
	TenantID               string         `json:"tenant_id,omitempty"`
	Version                string         `json:"version"`
	Status                 string         `json:"status"`
	Storefronts            []any          `json:"storefronts"`
	ContentBlocks          []any          `json:"content_blocks"`
	PersonalizationRules   map[string]any `json:"personalization_rules"`
	SupportSettings        map[string]any `json:"support_settings"`
	OrderHistoryEnabled    bool           `json:"order_history_enabled"`
	FavoritesEnabled       bool           `json:"favorites_enabled"`
	CouponsEnabled         bool           `json:"coupons_enabled"`
	RecommendationsEnabled bool           `json:"recommendations_enabled"`
	CustomerAgentEnabled   bool           `json:"customer_agent_enabled"`
	Styling                map[string]any `json:"styling"`
	Metadata               map[string]any `json:"metadata"`
	RuntimeAvailable       bool           `json:"runtime_available"`
	RuntimeStatus          string         `json:"runtime_status"`
	RuntimeReasonCode      string         `json:"runtime_reason_code"`
	CustomerAgentEffective bool           `json:"customer_agent_effective_enabled"`
	CreatedAt              time.Time      `json:"-"`
	UpdatedAt              time.Time      `json:"-"`
}

func (config HubConfig) MarshalJSON() ([]byte, error) {
	type hubConfigWire HubConfig
	var createdAt, updatedAt *time.Time
	if !config.CreatedAt.IsZero() {
		value := config.CreatedAt.UTC()
		createdAt = &value
	}
	if !config.UpdatedAt.IsZero() {
		value := config.UpdatedAt.UTC()
		updatedAt = &value
	}
	return json.Marshal(struct {
		hubConfigWire
		CreatedAt *time.Time `json:"created_at,omitempty"`
		UpdatedAt *time.Time `json:"updated_at,omitempty"`
	}{
		hubConfigWire: hubConfigWire(config),
		CreatedAt:     createdAt,
		UpdatedAt:     updatedAt,
	})
}

type Channel struct {
	TenantBinding     string         `json:"tenantId"`
	ID                string         `json:"id,omitempty"`
	TenantID          string         `json:"tenant_id,omitempty"`
	Version           string         `json:"version"`
	Name              string         `json:"name"`
	ChannelType       string         `json:"channel_type"`
	Status            string         `json:"status"`
	ExternalRef       string         `json:"-"`
	RoutingRules      map[string]any `json:"routing_rules,omitempty"`
	AgentSettings     map[string]any `json:"agent_settings,omitempty"`
	Metadata          map[string]any `json:"metadata,omitempty"`
	RuntimeAvailable  bool           `json:"runtime_available"`
	RuntimeStatus     string         `json:"runtime_status"`
	RuntimeReasonCode string         `json:"runtime_reason_code"`
	CreatedAt         time.Time      `json:"created_at,omitempty"`
	UpdatedAt         time.Time      `json:"updated_at,omitempty"`
}

type Conversation struct {
	TenantBinding    string         `json:"tenantId"`
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	Version          string         `json:"version"`
	ChannelID        string         `json:"channel_id,omitempty"`
	ChannelType      string         `json:"channel_type"`
	SourceType       string         `json:"source_type"`
	ExternalThreadID string         `json:"-"`
	SubscriberID     string         `json:"subscriber_id,omitempty"`
	RequesterEmail   string         `json:"requester_email,omitempty"`
	RequesterPhone   string         `json:"requester_phone,omitempty"`
	RequesterName    string         `json:"requester_name,omitempty"`
	Subject          string         `json:"subject,omitempty"`
	Status           string         `json:"status"`
	Priority         string         `json:"priority"`
	AssignedTo       string         `json:"assigned_to,omitempty"`
	AssignedToUserID string         `json:"assigned_to_user_id,omitempty"`
	AssignmentState  string         `json:"assignment_state"`
	Tags             []string       `json:"tags,omitempty"`
	LastMessageAt    *time.Time     `json:"last_message_at,omitempty"`
	Metadata         map[string]any `json:"-"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
	UpdatedAt        time.Time      `json:"updated_at,omitempty"`
}

type Message struct {
	TenantBinding       string         `json:"tenantId"`
	ID                  string         `json:"id,omitempty"`
	TenantID            string         `json:"tenant_id,omitempty"`
	ConversationID      string         `json:"conversation_id,omitempty"`
	SourceType          string         `json:"source_type,omitempty"`
	SourceID            string         `json:"-"`
	Direction           string         `json:"direction"`
	SenderType          string         `json:"sender_type"`
	Sender              string         `json:"sender,omitempty"`
	BodyText            string         `json:"body_text,omitempty"`
	BodyHTML            string         `json:"-"`
	Attachments         []any          `json:"-"`
	Metadata            map[string]any `json:"-"`
	SentAt              time.Time      `json:"sent_at,omitempty"`
	CreatedAt           time.Time      `json:"created_at,omitempty"`
	RecordKind          string         `json:"record_kind"`
	DeliveryStatus      string         `json:"delivery_status"`
	BodyOmittedReason   string         `json:"body_omitted_reason,omitempty"`
	AttachmentCount     int            `json:"attachment_count"`
	ProjectionTruncated bool           `json:"projection_truncated"`
}

type Ticket struct {
	TenantBinding   string         `json:"tenantId"`
	ID              string         `json:"id,omitempty"`
	TenantID        string         `json:"tenant_id,omitempty"`
	Version         string         `json:"version"`
	ConversationID  string         `json:"conversation_id,omitempty"`
	TicketNumber    int64          `json:"ticket_number,omitempty"`
	Title           string         `json:"title"`
	Status          string         `json:"status"`
	Priority        string         `json:"priority"`
	Assignee        string         `json:"assignee,omitempty"`
	AssignmentState string         `json:"assignment_state"`
	SourceChannel   string         `json:"source_channel,omitempty"`
	DueAt           *time.Time     `json:"due_at,omitempty"`
	ResolvedAt      *time.Time     `json:"resolved_at,omitempty"`
	Metadata        map[string]any `json:"-"`
	CreatedAt       time.Time      `json:"created_at,omitempty"`
	UpdatedAt       time.Time      `json:"updated_at,omitempty"`
}

type AssignmentInput struct {
	AssignedTo       string `json:"assigned_to"`
	AssignedBy       string `json:"-"`
	AssignedToUserID string `json:"-"`
	Reason           string `json:"reason,omitempty"`
}

type AssignmentRequest struct {
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
}

type StatusInput struct {
	Status string `json:"status"`
}

type View struct {
	TenantBinding string         `json:"tenantId"`
	ID            string         `json:"id,omitempty"`
	TenantID      string         `json:"tenant_id,omitempty"`
	Version       string         `json:"version"`
	Name          string         `json:"name"`
	Visibility    string         `json:"visibility"`
	Filters       map[string]any `json:"filters,omitempty"`
	Sort          map[string]any `json:"sort,omitempty"`
	Status        string         `json:"status"`
	CreatedBy     string         `json:"-"`
	CreatedAt     time.Time      `json:"created_at,omitempty"`
	UpdatedAt     time.Time      `json:"updated_at,omitempty"`
}

type Macro struct {
	TenantBinding       string         `json:"tenantId"`
	ID                  string         `json:"id,omitempty"`
	TenantID            string         `json:"tenant_id,omitempty"`
	Version             string         `json:"version"`
	Name                string         `json:"name"`
	Body                string         `json:"body"`
	ChannelTypes        []string       `json:"channel_types,omitempty"`
	Tags                []string       `json:"tags,omitempty"`
	Status              string         `json:"status"`
	UseCount            int            `json:"use_count,omitempty"`
	LastUsedAt          *time.Time     `json:"last_used_at,omitempty"`
	Metadata            map[string]any `json:"-"`
	UsageEvidenceStatus string         `json:"usage_evidence_status"`
	CreatedAt           time.Time      `json:"created_at,omitempty"`
	UpdatedAt           time.Time      `json:"updated_at,omitempty"`
}

type SpamAssessment struct {
	TenantBinding       string         `json:"tenantId"`
	ID                  string         `json:"id,omitempty"`
	TenantID            string         `json:"tenant_id,omitempty"`
	ConversationID      string         `json:"conversation_id,omitempty"`
	MessageID           string         `json:"message_id,omitempty"`
	Score               int            `json:"score"`
	Verdict             string         `json:"verdict"`
	Signals             map[string]any `json:"signals,omitempty"`
	AssessedBy          string         `json:"-"`
	CreatedAt           time.Time      `json:"created_at,omitempty"`
	AssessmentMode      string         `json:"assessment_mode"`
	CertificationStatus string         `json:"certification_status"`
}

type SpamAssessmentRequest struct {
	ConversationID string         `json:"conversation_id"`
	MessageID      string         `json:"message_id"`
	Score          int            `json:"score"`
	Verdict        string         `json:"verdict"`
	Signals        map[string]any `json:"signals"`
}

type AgentRun struct {
	TenantBinding    string         `json:"tenantId"`
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	ConversationID   string         `json:"conversation_id,omitempty"`
	TicketID         string         `json:"ticket_id,omitempty"`
	RunType          string         `json:"run_type"`
	Status           string         `json:"status"`
	Model            string         `json:"model,omitempty"`
	Prompt           string         `json:"prompt,omitempty"`
	Draft            string         `json:"draft,omitempty"`
	SafetyFlags      []string       `json:"safety_flags,omitempty"`
	HandoffReason    string         `json:"handoff_reason,omitempty"`
	ToolPlan         map[string]any `json:"tool_plan,omitempty"`
	Metadata         map[string]any `json:"-"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
	UpdatedAt        time.Time      `json:"updated_at,omitempty"`
	ExecutionMode    string         `json:"execution_mode"`
	ProviderExecuted bool           `json:"provider_executed"`
}

type DraftReplyRequest struct {
	ConversationID string         `json:"conversation_id"`
	TicketID       string         `json:"ticket_id,omitempty"`
	Prompt         string         `json:"prompt,omitempty"`
	Tone           string         `json:"tone,omitempty"`
	Model          string         `json:"-"`
	Metadata       map[string]any `json:"-"`
}

type ValidationResult struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

var (
	ErrNotFound            = errors.New("service_suite: not found")
	ErrIdempotencyConflict = errors.New("service_suite: idempotency conflict")
	ErrPreconditionFailed  = errors.New("service_suite: precondition failed")
	ErrSourceConflict      = errors.New("service_suite: immutable source conflict")
	ErrPrincipalNotMember  = errors.New("service_suite: principal is not an active tenant admin")
	ErrInvalidPatch        = errors.New("service_suite: invalid patch")
	ErrInvalidProjection   = errors.New("service_suite: invalid projection")
	ErrGroundingMismatch   = errors.New("service_suite: grounding ownership mismatch")
	ErrIntentResultMissing = errors.New("service_suite: committed intent result is unavailable")
)

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireExactTenantAdmin
	protect := protectSensitiveResponse
	r.With(protect, read).Get("/api/v1/service-suite/catalog", d.Catalog)
	r.With(protect, admin).Get("/api/v1/service-suite/report", d.SupportReport)
	r.With(protect, admin).Get("/api/v1/service-suite/config", d.GetConfig)
	r.With(protect, admin).Put("/api/v1/service-suite/config", d.PutConfig)
	r.With(protect, admin).Get("/api/v1/service-suite/channels", d.ListChannels)
	r.With(protect, admin).Post("/api/v1/service-suite/channels", d.CreateChannel)
	r.With(protect, admin).Patch("/api/v1/service-suite/channels/{id}", d.UpdateChannel)
	r.With(protect, admin).Get("/api/v1/service-suite/conversations", d.ListConversations)
	r.With(protect, admin).Post("/api/v1/service-suite/conversations", d.CreateConversation)
	r.With(protect, admin).Get("/api/v1/service-suite/conversations/{id}", d.GetConversation)
	r.With(protect, admin).Get("/api/v1/service-suite/conversations/{id}/messages", d.ListMessages)
	r.With(protect, admin).Post("/api/v1/service-suite/conversations/{id}/messages", d.CreateMessage)
	r.With(protect, admin).Post("/api/v1/service-suite/conversations/{id}/internal-notes", d.CreateInternalNote)
	r.With(protect, admin).Post("/api/v1/service-suite/conversations/{id}/assign", d.AssignConversation)
	r.With(protect, admin).Post("/api/v1/service-suite/conversations/{id}/status", d.SetConversationStatus)
	r.With(protect, admin).Get("/api/v1/service-suite/tickets", d.ListTickets)
	r.With(protect, admin).Post("/api/v1/service-suite/tickets", d.CreateTicket)
	r.With(protect, admin).Patch("/api/v1/service-suite/tickets/{id}", d.UpdateTicket)
	r.With(protect, admin).Get("/api/v1/service-suite/views", d.ListViews)
	r.With(protect, admin).Post("/api/v1/service-suite/views", d.CreateView)
	r.With(protect, admin).Patch("/api/v1/service-suite/views/{id}", d.UpdateView)
	r.With(protect, admin).Delete("/api/v1/service-suite/views/{id}", d.ArchiveView)
	r.With(protect, admin).Get("/api/v1/service-suite/macros", d.ListMacros)
	r.With(protect, admin).Post("/api/v1/service-suite/macros", d.CreateMacro)
	r.With(protect, admin).Patch("/api/v1/service-suite/macros/{id}", d.UpdateMacro)
	r.With(protect, admin).Delete("/api/v1/service-suite/macros/{id}", d.ArchiveMacro)
	r.With(protect, admin).Post("/api/v1/service-suite/macros/{id}/use", d.UseMacro)
	r.With(protect, admin).Post("/api/v1/service-suite/spam-assessments", d.CreateSpamAssessment)
	r.With(protect, admin).Post("/api/v1/service-suite/agent/draft-reply", d.DraftReply)
}

func protectSensitiveResponse(next http.Handler) http.Handler {
	return ProtectSensitiveResponses(next)
}

// ProtectSensitiveResponses is intentionally path-conditional so it can be
// mounted on the outer router before authentication. Early 401/403/404/5xx
// responses share the same cache and MIME-sniffing boundary as successful
// Helpdesk and support-integration reads.
func ProtectSensitiveResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := ""
		if r != nil && r.URL != nil {
			path = r.URL.EscapedPath()
		}
		if strings.HasPrefix(path, "/api/v1/service-suite/") || path == "/api/v1/service-suite" ||
			strings.HasPrefix(path, "/api/v1/support-integrations/") || path == "/api/v1/support-integrations" ||
			strings.HasPrefix(path, "/api/public/support-integrations/") {
			w.Header().Set("Cache-Control", "private, no-store, max-age=0")
			w.Header().Set("Pragma", "no-cache")
			w.Header().Set("X-Content-Type-Options", "nosniff")
		}
		next.ServeHTTP(w, r)
	})
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": "postwave.service_suite.v2",
		"provenance": map[string]any{
			"tenant_bound": false,
			"source":       "static_server_catalog",
		},
		"channels": []map[string]string{
			{"key": "web_chat", "label": "Web chat", "runtime_status": "held"},
			{"key": "email", "label": "Email", "runtime_status": "held"},
			{"key": "sms", "label": "SMS", "runtime_status": "held"},
			{"key": "instagram", "label": "Instagram", "runtime_status": "held"},
			{"key": "whatsapp", "label": "WhatsApp", "runtime_status": "held"},
			{"key": "facebook", "label": "Facebook", "runtime_status": "held"},
		},
		"conversation_statuses": []string{"open", "pending", "waiting", "resolved", "closed", "spam", "archived"},
		"agent_run_types":       []string{"draft_reply", "triage", "handoff", "summary"},
		"capabilities": map[string]any{
			"outbound_reply_delivery": map[string]string{"status": "held", "code": "helpdesk_delivery_unavailable"},
			"inbound_email_bridge":    map[string]string{"status": "held"},
			"internal_notes":          map[string]string{"status": "available"},
			"privacy_lifecycle":       map[string]string{"status": "held"},
			"customer_hub_runtime":    map[string]string{"status": "held", "code": "customer_hub_runtime_unavailable"},
			"channel_runtime":         map[string]string{"status": "held", "code": "helpdesk_channel_runtime_unavailable"},
			"customer_agent":          map[string]string{"status": "held", "code": "customer_agent_draft_write_held", "execution_mode": "deterministic_template_only"},
			"spam_assessment_write":   map[string]string{"status": "held", "code": "spam_assessment_write_held"},
			"resource_creation":       map[string]string{"status": "held", "code": "helpdesk_create_replay_unavailable"},
			"macro_usage_evidence":    map[string]string{"status": "held", "code": "macro_usage_evidence_unavailable"},
		},
		"guardrail": map[string]bool{
			"draft_only": true, "provider_executed": false,
			"customer_mutations": false, "requires_human_review": true,
		},
	})
}

func (d *Deps) GetConfig(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetConfig(r.Context(), tenantID)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "config_failed")
		return
	}
	setEntityTag(w, out.Version)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PutConfig(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	expectedVersion, ok := mutationVersion(w, r)
	if !ok {
		return
	}
	var wire HubConfigPut
	if err := decodeHelpdeskJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &wire); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in, validation := wire.ValidateAndBuild()
	if !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	if in.Status == "active" || in.CustomerAgentEnabled {
		writeJSON(w, http.StatusConflict, errEnv("customer_hub_runtime_unavailable", "Customer Hub publication and Customer Agent enablement are release-held because no authenticated storefront runtime is configured."))
		return
	}
	out, err := d.Repo.ReplaceConfig(r.Context(), tenantID, in, expectedVersion)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "config_replace_failed")
		return
	}
	setEntityTag(w, out.Version)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListChannels(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	values, err := validateQuery(r, "channel_type", "limit", "cursor")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("query_invalid", err.Error()))
		return
	}
	channelType := strings.TrimSpace(values.Get("channel_type"))
	if channelType != "" && !allowed(channelType, channelTypes()) {
		writeJSON(w, http.StatusBadRequest, errEnv("channel_type_invalid", "channel_type is invalid"))
		return
	}
	limit, err := parseListLimit(values)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("limit_invalid", err.Error()))
		return
	}
	cursorValue, err := listCursorQueryValue(values)
	if err != nil {
		writeCursorError(w, err, "channel")
		return
	}
	cursor, err := decodeListCursor(d.CursorKey, cursorValue, tenantID, "channels", "channel_type:"+channelType, limit, time.Now().UTC())
	if err != nil {
		writeCursorError(w, err, "channel")
		return
	}
	out, err := d.Repo.ListChannelsPage(r.Context(), tenantID, channelType, d.CursorKey, cursor, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateChannel(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("helpdesk_channel_create_held", "Channel creation is release-held until a durable replay intent and verified runtime lifecycle are available."))
}

func (d *Deps) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if !validateUUID(chi.URLParam(r, "id")) {
		writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "channel id must be a canonical UUID"))
		return
	}
	expectedVersion, ok := mutationVersion(w, r)
	if !ok {
		return
	}
	var in ChannelPatch
	if err := decodeHelpdeskJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.empty() {
		writeJSON(w, http.StatusBadRequest, errEnv("patch_empty", "PATCH must include at least one editable field"))
		return
	}
	if in.Status.Present && !in.Status.Null && strings.EqualFold(strings.TrimSpace(in.Status.Value), "active") {
		writeJSON(w, http.StatusConflict, errEnv("helpdesk_channel_runtime_unavailable", "Channel activation is release-held until a verified inbound or outbound runtime is configured."))
		return
	}
	out, err := d.Repo.PatchChannel(r.Context(), tenantID, chi.URLParam(r, "id"), in, expectedVersion)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "channel_update_failed")
		return
	}
	setEntityTag(w, out.Version)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListConversations(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	values, err := validateQuery(r, "status", "limit", "cursor")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("query_invalid", err.Error()))
		return
	}
	status := strings.TrimSpace(values.Get("status"))
	if status != "" && !allowed(status, statuses()) {
		writeJSON(w, http.StatusBadRequest, errEnv("status_invalid", "status is invalid"))
		return
	}
	limit, err := parseListLimit(values)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("limit_invalid", err.Error()))
		return
	}
	cursorValue, err := listCursorQueryValue(values)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("cursor_invalid", "cursor is invalid for this conversation query"))
		return
	}
	cursor, err := decodeListCursor(d.CursorKey, cursorValue, tenantID, "conversations", status, limit, time.Now().UTC())
	if err != nil {
		if errors.Is(err, errCursorUnavailable) {
			writeJSON(w, http.StatusServiceUnavailable, errEnv("pagination_unavailable", "Helpdesk pagination is unavailable until its dedicated cursor key is configured."))
			return
		}
		writeJSON(w, http.StatusBadRequest, errEnv("cursor_invalid", "cursor is invalid for this conversation query"))
		return
	}
	out, err := d.Repo.ListConversationsPage(r.Context(), tenantID, status, d.CursorKey, cursor, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateConversation(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("helpdesk_conversation_create_held", "Conversation creation is release-held until a durable replay intent and complete privacy lifecycle are available."))
}

func (d *Deps) GetConversation(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if !validateUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "conversation id must be a canonical UUID"))
		return
	}
	out, err := d.Repo.GetConversation(r.Context(), tenantID, id)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "conversation_failed")
		return
	}
	setEntityTag(w, out.Version)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListMessages(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	values, err := validateQuery(r, "limit", "cursor", "order")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("query_invalid", err.Error()))
		return
	}
	conversationID := chi.URLParam(r, "id")
	if !validateUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "conversation id must be a canonical UUID"))
		return
	}
	limit, err := parseListLimit(values)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("limit_invalid", err.Error()))
		return
	}
	order := strings.ToLower(strings.TrimSpace(values.Get("order")))
	if order == "" {
		order = "desc"
	}
	if order != "asc" && order != "desc" {
		writeJSON(w, http.StatusBadRequest, errEnv("order_invalid", "order must be asc or desc"))
		return
	}
	cursorValue, err := listCursorQueryValue(values)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("cursor_invalid", "cursor is invalid for this message query"))
		return
	}
	cursor, err := decodeListCursor(d.CursorKey, cursorValue, tenantID, "messages:"+order, conversationID, limit, time.Now().UTC())
	if err != nil {
		if errors.Is(err, errCursorUnavailable) {
			writeJSON(w, http.StatusServiceUnavailable, errEnv("pagination_unavailable", "Helpdesk pagination is unavailable until its dedicated cursor key is configured."))
			return
		}
		writeJSON(w, http.StatusBadRequest, errEnv("cursor_invalid", "cursor is invalid for this message query"))
		return
	}
	out, err := d.Repo.ListMessagesPage(r.Context(), tenantID, conversationID, order, d.CursorKey, cursor, limit)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "messages_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateMessage(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("helpdesk_delivery_unavailable", "Outbound reply delivery is release-held; use the explicitly typed internal-notes endpoint to record a private note."))
}

func (d *Deps) CreateInternalNote(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	conversationID := chi.URLParam(r, "id")
	if !validateUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "conversation id must be a canonical UUID"))
		return
	}
	keyValues := r.Header.Values(idempotency.HeaderName)
	if len(keyValues) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("idempotency_key_required", "A single non-empty Idempotency-Key is required for an internal note."))
		return
	}
	if len(keyValues) != 1 || !idempotency.ValidKey(keyValues[0]) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_idempotency_key", "Idempotency-Key must be supplied once as 1-255 valid UTF-8 bytes without surrounding whitespace or controls."))
		return
	}
	storageKey, keyOK := idempotency.StorageKeyFromContext(r.Context())
	requestHash, hashOK := idempotency.RequestHashFromContext(r.Context())
	if !keyOK || !hashOK {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("internal_note_idempotency_unavailable", "Internal-note idempotency is not configured."))
		return
	}
	var in InternalNoteRequest
	if err := decodeHelpdeskJSON(w, r, 64<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if in.hasLegacyEnvelope() {
		writeJSON(w, http.StatusBadRequest, errEnv("internal_note_invalid", "Internal notes accept only body_text; delivery, sender, source, attachment, timing, and metadata fields are server-owned."))
		return
	}
	body := strings.TrimSpace(in.BodyText)
	if !validHelpdeskDisplayText(body, 16<<10, false) {
		writeJSON(w, http.StatusBadRequest, errEnv("internal_note_invalid", "body_text must be 1-16384 valid UTF-8 bytes and contain no unsafe control, bidi, or zero-width characters."))
		return
	}
	actorID, actorOK := serviceSuiteActorID(r)
	if !actorOK {
		writeJSON(w, http.StatusForbidden, errEnv("internal_note_actor_required", "A stable authenticated principal is required to record an internal note."))
		return
	}
	out, created, err := d.Repo.CreateInternalNote(r.Context(), tenantID, conversationID, actorID, storageKey, requestHash, body)
	if err != nil {
		if errors.Is(err, ErrIdempotencyConflict) {
			writeJSON(w, http.StatusConflict, errEnv("idempotency_key_conflict", "Idempotency-Key was already used for a different internal note request."))
			return
		}
		if errors.Is(err, ErrIntentResultMissing) {
			writeJSON(w, http.StatusGone, errEnv("internal_note_result_unavailable", "This idempotency intent committed previously, but its governed result is no longer available; do not create a replacement note with a new key."))
			return
		}
		writeRepoError(w, r, d.Logger, err, "internal_note_create_failed")
		return
	}
	status := http.StatusCreated
	if !created {
		status = http.StatusOK
		w.Header().Set(idempotency.ReplayedHeaderName, "true")
	}
	writeJSON(w, status, out)
}

func (d *Deps) AssignConversation(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	conversationID := chi.URLParam(r, "id")
	if !validateUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "conversation id must be a canonical UUID"))
		return
	}
	expectedVersion, ok := mutationVersion(w, r)
	if !ok {
		return
	}
	var request AssignmentRequest
	if err := decodeHelpdeskJSON(w, r, 16<<10, &request); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	request.Reason = strings.TrimSpace(request.Reason)
	if request.Action != "assign_self" && request.Action != "unassign" {
		writeJSON(w, http.StatusBadRequest, errEnv("assignment_invalid", "action must be assign_self or unassign"))
		return
	}
	request.Reason = strings.TrimSpace(request.Reason)
	if !validHelpdeskDisplayText(request.Reason, 1024, true) {
		writeJSON(w, http.StatusBadRequest, errEnv("assignment_invalid", "reason must be at most 1024 valid UTF-8 bytes and contain no unsafe control, bidi, or zero-width characters"))
		return
	}
	in := AssignmentInput{Reason: request.Reason}
	if request.Action == "assign_self" {
		user, userOK := middleware.UserFromContext(r.Context())
		if !userOK || user == nil || !validateUUID(strings.TrimSpace(user.ID)) || user.TenantID != tenantID {
			writeJSON(w, http.StatusConflict, errEnv("human_actor_required", "assign_self requires a current human tenant-member session principal"))
			return
		}
		in.AssignedTo = user.ID
		in.AssignedToUserID = user.ID
		in.AssignedBy = user.ID
	} else if actorID, actorOK := serviceSuiteActorID(r); actorOK {
		in.AssignedBy = actorID
	}
	out, err := d.Repo.AssignConversation(r.Context(), tenantID, conversationID, in, expectedVersion)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "assign_failed")
		return
	}
	setEntityTag(w, out.Version)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SetConversationStatus(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	conversationID := chi.URLParam(r, "id")
	if !validateUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "conversation id must be a canonical UUID"))
		return
	}
	expectedVersion, ok := mutationVersion(w, r)
	if !ok {
		return
	}
	var in StatusInput
	if err := decodeHelpdeskJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if !allowed(in.Status, statuses()) {
		writeJSON(w, http.StatusBadRequest, errEnv("status_invalid", "status is invalid"))
		return
	}
	out, err := d.Repo.SetConversationStatus(r.Context(), tenantID, conversationID, in.Status, expectedVersion)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "status_failed")
		return
	}
	setEntityTag(w, out.Version)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListTickets(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	values, err := validateQuery(r, "status", "conversation_id", "limit", "cursor")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("query_invalid", err.Error()))
		return
	}
	status := strings.TrimSpace(values.Get("status"))
	if status != "" && !allowed(status, statuses()) {
		writeJSON(w, http.StatusBadRequest, errEnv("status_invalid", "status is invalid"))
		return
	}
	conversationID := strings.TrimSpace(values.Get("conversation_id"))
	if conversationID != "" && !validateUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, errEnv("conversation_id_invalid", "conversation_id must be a canonical UUID"))
		return
	}
	limit, err := parseListLimit(values)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("limit_invalid", err.Error()))
		return
	}
	filter := "status:" + status + "\x00conversation:" + conversationID
	cursorValue, err := listCursorQueryValue(values)
	if err != nil {
		writeCursorError(w, err, "ticket")
		return
	}
	cursor, err := decodeListCursor(d.CursorKey, cursorValue, tenantID, "tickets", filter, limit, time.Now().UTC())
	if err != nil {
		writeCursorError(w, err, "ticket")
		return
	}
	out, err := d.Repo.ListTicketsPage(r.Context(), tenantID, status, conversationID, d.CursorKey, cursor, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateTicket(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("helpdesk_ticket_create_held", "Ticket creation is release-held until a durable replay intent and complete privacy lifecycle are available."))
}

func (d *Deps) UpdateTicket(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if !validateUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "ticket id must be a canonical UUID"))
		return
	}
	expectedVersion, ok := mutationVersion(w, r)
	if !ok {
		return
	}
	var in TicketPatch
	if err := decodeHelpdeskJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.empty() {
		writeJSON(w, http.StatusBadRequest, errEnv("patch_empty", "PATCH must include at least one editable field"))
		return
	}
	out, err := d.Repo.PatchTicket(r.Context(), tenantID, id, in, expectedVersion)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "ticket_update_failed")
		return
	}
	setEntityTag(w, out.Version)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListViews(w http.ResponseWriter, r *http.Request) { d.listViewsOrMacros(w, r, "views") }
func (d *Deps) ListMacros(w http.ResponseWriter, r *http.Request) {
	d.listViewsOrMacros(w, r, "macros")
}

func (d *Deps) listViewsOrMacros(w http.ResponseWriter, r *http.Request, kind string) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	values, err := validateQuery(r, "limit", "cursor")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("query_invalid", err.Error()))
		return
	}
	limit, err := parseListLimit(values)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("limit_invalid", err.Error()))
		return
	}
	if kind == "views" {
		cursorValue, cursorErr := listCursorQueryValue(values)
		if cursorErr != nil {
			writeCursorError(w, cursorErr, "view")
			return
		}
		cursor, cursorErr := decodeListCursor(d.CursorKey, cursorValue, tenantID, "views", "active", limit, time.Now().UTC())
		if cursorErr != nil {
			writeCursorError(w, cursorErr, "view")
			return
		}
		out, err := d.Repo.ListViewsPage(r.Context(), tenantID, d.CursorKey, cursor, limit)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	cursorValue, cursorErr := listCursorQueryValue(values)
	if cursorErr != nil {
		writeCursorError(w, cursorErr, "macro")
		return
	}
	cursor, cursorErr := decodeListCursor(d.CursorKey, cursorValue, tenantID, "macros", "active", limit, time.Now().UTC())
	if cursorErr != nil {
		writeCursorError(w, cursorErr, "macro")
		return
	}
	out, err := d.Repo.ListMacrosPage(r.Context(), tenantID, d.CursorKey, cursor, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateView(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("helpdesk_view_create_held", "View creation is release-held until a durable replay intent is available."))
}
func (d *Deps) UpdateView(w http.ResponseWriter, r *http.Request) {
	d.writeView(w, r, chi.URLParam(r, "id"))
}
func (d *Deps) CreateMacro(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("helpdesk_macro_create_held", "Macro creation is release-held until a durable replay intent is available."))
}
func (d *Deps) UpdateMacro(w http.ResponseWriter, r *http.Request) {
	d.writeMacro(w, r, chi.URLParam(r, "id"))
}

func (d *Deps) writeView(w http.ResponseWriter, r *http.Request, id string) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if id != "" {
		if !validateUUID(id) {
			writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "view id must be a canonical UUID"))
			return
		}
		expectedVersion, versionOK := mutationVersion(w, r)
		if !versionOK {
			return
		}
		var patch ViewPatch
		if err := decodeHelpdeskJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &patch); err != nil {
			httpbody.WriteError(w, err)
			return
		}
		if patch.empty() {
			writeJSON(w, http.StatusBadRequest, errEnv("patch_empty", "PATCH must include at least one editable field"))
			return
		}
		out, err := d.Repo.PatchView(r.Context(), tenantID, id, patch, expectedVersion)
		if err != nil {
			writeRepoError(w, r, d.Logger, err, "view_patch_failed")
			return
		}
		setEntityTag(w, out.Version)
		writeJSON(w, http.StatusOK, out)
		return
	}
	var request ViewCreate
	if err := decodeHelpdeskJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &request); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in := View{Name: request.Name, Visibility: request.Visibility, Filters: request.Filters, Sort: request.Sort, Status: request.Status}
	normalizeView(&in)
	if validation := ValidateView(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	if actorID, actorOK := serviceSuiteActorID(r); actorOK {
		in.CreatedBy = actorID
	} else {
		writeJSON(w, http.StatusConflict, errEnv("human_actor_required", "A stable authenticated principal is required to create a view."))
		return
	}
	out, err := d.Repo.UpsertView(r.Context(), tenantID, id, in)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "view_write_failed")
		return
	}
	status := http.StatusOK
	if id == "" {
		status = http.StatusCreated
	}
	setEntityTag(w, out.Version)
	writeJSON(w, status, out)
}

func (d *Deps) writeMacro(w http.ResponseWriter, r *http.Request, id string) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if id != "" {
		if !validateUUID(id) {
			writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", "macro id must be a canonical UUID"))
			return
		}
		expectedVersion, versionOK := mutationVersion(w, r)
		if !versionOK {
			return
		}
		var patch MacroPatch
		if err := decodeHelpdeskJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &patch); err != nil {
			httpbody.WriteError(w, err)
			return
		}
		if patch.empty() {
			writeJSON(w, http.StatusBadRequest, errEnv("patch_empty", "PATCH must include at least one editable field"))
			return
		}
		out, err := d.Repo.PatchMacro(r.Context(), tenantID, id, patch, expectedVersion)
		if err != nil {
			writeRepoError(w, r, d.Logger, err, "macro_patch_failed")
			return
		}
		setEntityTag(w, out.Version)
		writeJSON(w, http.StatusOK, out)
		return
	}
	var request MacroCreate
	if err := decodeHelpdeskJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &request); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in := Macro{Name: request.Name, Body: request.Body, ChannelTypes: request.ChannelTypes,
		Tags: request.Tags, Status: request.Status, Metadata: request.Metadata}
	normalizeMacro(&in)
	if validation := ValidateMacro(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.UpsertMacro(r.Context(), tenantID, id, in)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "macro_write_failed")
		return
	}
	status := http.StatusOK
	if id == "" {
		status = http.StatusCreated
	}
	setEntityTag(w, out.Version)
	writeJSON(w, status, out)
}

func (d *Deps) ArchiveView(w http.ResponseWriter, r *http.Request) {
	d.archiveViewOrMacro(w, r, "view")
}
func (d *Deps) ArchiveMacro(w http.ResponseWriter, r *http.Request) {
	d.archiveViewOrMacro(w, r, "macro")
}

func (d *Deps) archiveViewOrMacro(w http.ResponseWriter, r *http.Request, kind string) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if !validateUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("id_invalid", kind+" id must be a canonical UUID"))
		return
	}
	expectedVersion, ok := mutationVersion(w, r)
	if !ok {
		return
	}
	version, err := d.Repo.ArchiveViewOrMacro(r.Context(), tenantID, id, kind, expectedVersion)
	if err != nil {
		writeRepoError(w, r, d.Logger, err, "archive_failed")
		return
	}
	setEntityTag(w, version)
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) UseMacro(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("macro_usage_evidence_unavailable", "Macro selection is not delivery or note evidence; standalone usage counting is release-held."))
}

func (d *Deps) CreateSpamAssessment(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("spam_assessment_write_held", "Spam assessment writes are release-held until retry-safe review evidence and a resolvable status contract exist."))
}

func (d *Deps) DraftReply(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusConflict, errEnv("customer_agent_draft_write_held", "Draft-run persistence is release-held until a durable replay intent and governed prompt lifecycle exist; no model or provider executed."))
}

func ValidateConfig(in HubConfig) ValidationResult {
	in.Status = defaulted(in.Status, "draft")
	out := ValidationResult{Valid: true}
	if !allowed(in.Status, []string{"draft", "active", "paused", "archived"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if in.Storefronts == nil || len(in.Storefronts) > helpdeskSmallArrayMaxItems ||
		!validHelpdeskJSON(in.Storefronts, helpdeskMetadataMaxBytes, 8, 512) {
		out.Errors = append(out.Errors, "storefronts is invalid")
	}
	if in.ContentBlocks == nil || len(in.ContentBlocks) > helpdeskSmallArrayMaxItems ||
		!validHelpdeskJSON(in.ContentBlocks, helpdeskMetadataMaxBytes, 8, 512) {
		out.Errors = append(out.Errors, "content_blocks is invalid")
	}
	for _, field := range []struct {
		name  string
		value map[string]any
	}{
		{"personalization_rules", in.PersonalizationRules},
		{"support_settings", in.SupportSettings},
		{"styling", in.Styling},
		{"metadata", in.Metadata},
	} {
		if field.value == nil || !validHelpdeskJSON(field.value, helpdeskMetadataMaxBytes, 8, 512) {
			out.Errors = append(out.Errors, field.name+" is invalid")
		}
	}
	if (!in.CreatedAt.IsZero() || !in.UpdatedAt.IsZero()) &&
		(!validHelpdeskProjectionTime(in.CreatedAt, false) || !validHelpdeskProjectionTime(in.UpdatedAt, false) || in.UpdatedAt.Before(in.CreatedAt)) {
		out.Errors = append(out.Errors, "timestamps are invalid")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateChannel(in Channel) ValidationResult {
	out := ValidationResult{Valid: true}
	if strings.TrimSpace(in.Name) == "" {
		out.Errors = append(out.Errors, "name is required")
	}
	if !validHelpdeskDisplayText(in.Name, helpdeskNameMaxBytes, false) {
		out.Errors = append(out.Errors, "name is invalid")
	}
	if !allowed(defaulted(in.ChannelType, "generic"), channelTypes()) {
		out.Errors = append(out.Errors, "channel_type is invalid")
	}
	if !allowed(defaulted(in.Status, "draft"), []string{"draft", "active", "paused", "archived"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if !validHelpdeskOpaqueID(in.ExternalRef, 1024, true) {
		out.Errors = append(out.Errors, "external_ref is invalid")
	}
	for _, field := range []struct {
		name  string
		value map[string]any
	}{
		{"routing_rules", in.RoutingRules},
		{"agent_settings", in.AgentSettings},
		{"metadata", in.Metadata},
	} {
		if field.value != nil && !validHelpdeskJSON(field.value, helpdeskMetadataMaxBytes, 8, 512) {
			out.Errors = append(out.Errors, field.name+" is invalid")
		}
	}
	if (!in.CreatedAt.IsZero() || !in.UpdatedAt.IsZero()) &&
		(!validHelpdeskProjectionTime(in.CreatedAt, false) || !validHelpdeskProjectionTime(in.UpdatedAt, false) || in.UpdatedAt.Before(in.CreatedAt)) {
		out.Errors = append(out.Errors, "timestamps are invalid")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateConversation(in Conversation) ValidationResult {
	out := ValidationResult{Valid: true}
	if in.ChannelID != "" && !validateUUID(in.ChannelID) {
		out.Errors = append(out.Errors, "channel_id is invalid")
	}
	if in.SubscriberID != "" && !validateUUID(in.SubscriberID) {
		out.Errors = append(out.Errors, "subscriber_id is invalid")
	}
	if !allowed(defaulted(in.ChannelType, "generic"), channelTypes()) {
		out.Errors = append(out.Errors, "channel_type is invalid")
	}
	if !allowed(defaulted(in.SourceType, "manual"), []string{"manual", "inbound_email", "campaign_reply", "sms", "social", "web_chat", "whatsapp"}) {
		out.Errors = append(out.Errors, "source_type is invalid")
	}
	if !allowed(defaulted(in.Status, "open"), statuses()) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if !allowed(defaulted(in.Priority, "normal"), priorities()) {
		out.Errors = append(out.Errors, "priority is invalid")
	}
	if !validHelpdeskOpaqueID(in.ExternalThreadID, 1024, true) {
		out.Errors = append(out.Errors, "external_thread_id is invalid")
	}
	if !validHelpdeskEmail(in.RequesterEmail, true) {
		out.Errors = append(out.Errors, "requester_email is invalid")
	}
	if !validHelpdeskDisplayText(in.RequesterPhone, helpdeskRequesterPhoneMaxBytes, true) {
		out.Errors = append(out.Errors, "requester_phone is invalid")
	}
	if !validHelpdeskDisplayText(in.RequesterName, helpdeskRequesterNameMaxBytes, true) {
		out.Errors = append(out.Errors, "requester_name is invalid")
	}
	if !validHelpdeskDisplayText(in.Subject, helpdeskSubjectMaxBytes, true) {
		out.Errors = append(out.Errors, "subject is invalid")
	}
	if !validHelpdeskStringList(in.Tags, helpdeskTagMaxItems, helpdeskTagMaxBytes, nil) {
		out.Errors = append(out.Errors, "tags are invalid")
	}
	if strings.TrimSpace(in.AssignedTo) != "" || strings.TrimSpace(in.AssignedToUserID) != "" {
		out.Errors = append(out.Errors, "assignment is server-owned")
	}
	if in.Metadata != nil && !validHelpdeskJSON(in.Metadata, helpdeskMetadataMaxBytes, 8, 512) {
		out.Errors = append(out.Errors, "metadata is invalid")
	}
	if in.LastMessageAt != nil && !validHelpdeskProjectionTime(in.LastMessageAt.UTC(), false) {
		out.Errors = append(out.Errors, "last_message_at is invalid")
	}
	if (!in.CreatedAt.IsZero() || !in.UpdatedAt.IsZero()) &&
		(!validHelpdeskProjectionTime(in.CreatedAt, false) || !validHelpdeskProjectionTime(in.UpdatedAt, false) || in.UpdatedAt.Before(in.CreatedAt)) {
		out.Errors = append(out.Errors, "timestamps are invalid")
	}
	if strings.TrimSpace(in.RequesterEmail) == "" && strings.TrimSpace(in.RequesterPhone) == "" && strings.TrimSpace(in.ExternalThreadID) == "" {
		out.Warnings = append(out.Warnings, "conversation has no requester or source thread; mirror dedupe will rely on generated id")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateMessage(in Message) ValidationResult {
	out := ValidationResult{Valid: true}
	if !validHelpdeskSafeToken(defaulted(in.SourceType, "manual"), 64, false) {
		out.Errors = append(out.Errors, "source_type is invalid")
	}
	if !validHelpdeskOpaqueID(in.SourceID, 1024, true) {
		out.Errors = append(out.Errors, "source_id is invalid")
	}
	if !allowed(defaulted(in.Direction, "inbound"), []string{"inbound", "outbound", "internal"}) {
		out.Errors = append(out.Errors, "direction is invalid")
	}
	if !allowed(defaulted(in.SenderType, "customer"), []string{"customer", "agent", "system", "ai"}) {
		out.Errors = append(out.Errors, "sender_type is invalid")
	}
	if strings.TrimSpace(in.BodyText) == "" && strings.TrimSpace(in.BodyHTML) == "" && len(in.Attachments) == 0 {
		out.Errors = append(out.Errors, "message body or attachment is required")
	}
	if in.BodyText != "" && !validHelpdeskDisplayText(in.BodyText, 16<<10, true) {
		out.Errors = append(out.Errors, "body_text is invalid")
	}
	if len([]byte(in.BodyHTML)) > 256<<10 || !utf8.ValidString(in.BodyHTML) {
		out.Errors = append(out.Errors, "body_html is invalid")
	}
	if !validHelpdeskDisplayText(in.Sender, 320, true) {
		out.Errors = append(out.Errors, "sender is invalid")
	}
	if in.Attachments != nil && (len(in.Attachments) > 64 || !validHelpdeskJSON(in.Attachments, helpdeskMetadataMaxBytes, 8, 512)) {
		out.Errors = append(out.Errors, "attachments are invalid")
	}
	if in.Metadata != nil && !validHelpdeskJSON(in.Metadata, helpdeskMetadataMaxBytes, 8, 512) {
		out.Errors = append(out.Errors, "metadata is invalid")
	}
	if !validHelpdeskProjectionTime(in.SentAt, true) || !validHelpdeskProjectionTime(in.CreatedAt, true) {
		out.Errors = append(out.Errors, "message timestamp is invalid")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateTicket(in Ticket) ValidationResult {
	out := ValidationResult{Valid: true}
	if strings.TrimSpace(in.Title) == "" {
		out.Errors = append(out.Errors, "title is required")
	}
	if !validHelpdeskDisplayText(in.Title, helpdeskTitleMaxBytes, false) {
		out.Errors = append(out.Errors, "title is invalid")
	}
	if in.ConversationID != "" && !validateUUID(in.ConversationID) {
		out.Errors = append(out.Errors, "conversation_id is invalid")
	}
	if !allowed(defaulted(in.Status, "open"), statuses()) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if !allowed(defaulted(in.Priority, "normal"), priorities()) {
		out.Errors = append(out.Errors, "priority is invalid")
	}
	if strings.TrimSpace(in.Assignee) != "" {
		out.Errors = append(out.Errors, "assignee is not a verified tenant user")
	}
	if !validHelpdeskSafeToken(defaulted(in.SourceChannel, "generic"), 64, false) {
		out.Errors = append(out.Errors, "source_channel is invalid")
	}
	if in.Metadata != nil && !validHelpdeskJSON(in.Metadata, helpdeskMetadataMaxBytes, 8, 512) {
		out.Errors = append(out.Errors, "metadata is invalid")
	}
	if in.DueAt != nil && !validHelpdeskProjectionTime(in.DueAt.UTC(), false) {
		out.Errors = append(out.Errors, "due_at is invalid")
	}
	if in.ResolvedAt != nil && !validHelpdeskProjectionTime(in.ResolvedAt.UTC(), false) {
		out.Errors = append(out.Errors, "resolved_at is invalid")
	}
	if (!in.CreatedAt.IsZero() || !in.UpdatedAt.IsZero()) &&
		(!validHelpdeskProjectionTime(in.CreatedAt, false) || !validHelpdeskProjectionTime(in.UpdatedAt, false) || in.UpdatedAt.Before(in.CreatedAt)) {
		out.Errors = append(out.Errors, "timestamps are invalid")
	}
	if !in.CreatedAt.IsZero() {
		if in.DueAt != nil && in.DueAt.Before(in.CreatedAt) {
			out.Errors = append(out.Errors, "due_at precedes created_at")
		}
		if in.ResolvedAt != nil && in.ResolvedAt.Before(in.CreatedAt) {
			out.Errors = append(out.Errors, "resolved_at precedes created_at")
		}
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateView(in View) ValidationResult {
	out := ValidationResult{Valid: true}
	if strings.TrimSpace(in.Name) == "" {
		out.Errors = append(out.Errors, "name is required")
	}
	if !validHelpdeskDisplayText(in.Name, helpdeskNameMaxBytes, false) {
		out.Errors = append(out.Errors, "name is invalid")
	}
	if !allowed(defaulted(in.Visibility, "team"), []string{"private", "team", "system"}) {
		out.Errors = append(out.Errors, "visibility is invalid")
	}
	if !allowed(defaulted(in.Status, "active"), []string{"active", "archived"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if in.Filters != nil && !validHelpdeskJSON(in.Filters, helpdeskSmallJSONMaxBytes, 8, 512) {
		out.Errors = append(out.Errors, "filters is invalid")
	}
	if in.Sort != nil && !validHelpdeskJSON(in.Sort, helpdeskSmallJSONMaxBytes, 8, 512) {
		out.Errors = append(out.Errors, "sort is invalid")
	}
	if !validHelpdeskOpaqueID(in.CreatedBy, 320, true) {
		out.Errors = append(out.Errors, "created_by is invalid")
	}
	if (!in.CreatedAt.IsZero() || !in.UpdatedAt.IsZero()) &&
		(!validHelpdeskProjectionTime(in.CreatedAt, false) || !validHelpdeskProjectionTime(in.UpdatedAt, false) || in.UpdatedAt.Before(in.CreatedAt)) {
		out.Errors = append(out.Errors, "timestamps are invalid")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateMacro(in Macro) ValidationResult {
	out := ValidationResult{Valid: true}
	if strings.TrimSpace(in.Name) == "" {
		out.Errors = append(out.Errors, "name is required")
	}
	if !validHelpdeskDisplayText(in.Name, helpdeskNameMaxBytes, false) {
		out.Errors = append(out.Errors, "name is invalid")
	}
	if strings.TrimSpace(in.Body) == "" {
		out.Errors = append(out.Errors, "body is required")
	}
	if !validHelpdeskDisplayText(in.Body, helpdeskMacroBodyMaxBytes, false) {
		out.Errors = append(out.Errors, "body is invalid")
	}
	if !validHelpdeskStringList(in.ChannelTypes, len(channelTypes()), 64, channelTypes()) {
		out.Errors = append(out.Errors, "channel_types is invalid")
	}
	if !validHelpdeskStringList(in.Tags, helpdeskTagMaxItems, helpdeskTagMaxBytes, nil) {
		out.Errors = append(out.Errors, "tags are invalid")
	}
	if !allowed(defaulted(in.Status, "active"), []string{"active", "archived"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if in.Metadata != nil && !validHelpdeskJSON(in.Metadata, 16<<10, 8, 256) {
		out.Errors = append(out.Errors, "metadata is invalid")
	}
	if in.UseCount < 0 || (in.LastUsedAt != nil && !validHelpdeskProjectionTime(in.LastUsedAt.UTC(), false)) {
		out.Errors = append(out.Errors, "usage fields are invalid")
	}
	if (!in.CreatedAt.IsZero() || !in.UpdatedAt.IsZero()) &&
		(!validHelpdeskProjectionTime(in.CreatedAt, false) || !validHelpdeskProjectionTime(in.UpdatedAt, false) || in.UpdatedAt.Before(in.CreatedAt)) {
		out.Errors = append(out.Errors, "timestamps are invalid")
	}
	if in.LastUsedAt != nil && !in.CreatedAt.IsZero() && in.LastUsedAt.Before(in.CreatedAt) {
		out.Errors = append(out.Errors, "last_used_at precedes created_at")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateSpamAssessment(in SpamAssessment) ValidationResult {
	out := ValidationResult{Valid: true}
	if in.Score < 0 || in.Score > 100 {
		out.Errors = append(out.Errors, "score must be 0..100")
	}
	if !allowed(defaulted(in.Verdict, "unknown"), []string{"unknown", "ham", "spam", "review"}) {
		out.Errors = append(out.Errors, "verdict is invalid")
	}
	if in.ConversationID != "" && !validateUUID(in.ConversationID) {
		out.Errors = append(out.Errors, "conversation_id is invalid")
	}
	if in.MessageID != "" && !validateUUID(in.MessageID) {
		out.Errors = append(out.Errors, "message_id is invalid")
	}
	if in.Signals != nil && !validHelpdeskJSON(in.Signals, 16<<10, 8, 256) {
		out.Errors = append(out.Errors, "signals is invalid")
	}
	if in.AssessedBy != "" && !validHelpdeskSafeToken(in.AssessedBy, 64, false) {
		out.Errors = append(out.Errors, "assessed_by is invalid")
	}
	if !validHelpdeskProjectionTime(in.CreatedAt, true) {
		out.Errors = append(out.Errors, "created_at is invalid")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

// BuildDraftReply builds a draft with no conversation grounding. Retained for
// back-compat; the handler now resolves context and calls
// BuildGroundedDraftReply.
func BuildDraftReply(in DraftReplyRequest) AgentRun {
	return BuildGroundedDraftReply(in, DraftContext{})
}

func normalizeConfig(in *HubConfig) {
	in.Status = defaulted(in.Status, "draft")
	if in.Storefronts == nil {
		in.Storefronts = []any{}
	}
	if in.ContentBlocks == nil {
		in.ContentBlocks = []any{}
	}
	if in.PersonalizationRules == nil {
		in.PersonalizationRules = map[string]any{}
	}
	if in.SupportSettings == nil {
		in.SupportSettings = map[string]any{}
	}
	if in.Styling == nil {
		in.Styling = map[string]any{}
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeChannel(in *Channel) {
	in.Name = strings.TrimSpace(in.Name)
	in.ChannelType = defaulted(strings.TrimSpace(in.ChannelType), "generic")
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	if in.RoutingRules == nil {
		in.RoutingRules = map[string]any{}
	}
	if in.AgentSettings == nil {
		in.AgentSettings = map[string]any{}
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeConversation(in *Conversation) {
	in.ChannelType = defaulted(strings.TrimSpace(in.ChannelType), "generic")
	in.SourceType = defaulted(strings.TrimSpace(in.SourceType), "manual")
	in.RequesterEmail = strings.TrimSpace(strings.ToLower(in.RequesterEmail))
	in.Status = defaulted(strings.TrimSpace(in.Status), "open")
	in.Priority = defaulted(strings.TrimSpace(in.Priority), "normal")
	in.Tags = cleanStrings(in.Tags)
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeMessage(in *Message) {
	in.SourceType = defaulted(strings.TrimSpace(in.SourceType), "manual")
	in.Direction = defaulted(strings.TrimSpace(in.Direction), "inbound")
	in.SenderType = defaulted(strings.TrimSpace(in.SenderType), "customer")
	if in.Attachments == nil {
		in.Attachments = []any{}
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeTicket(in *Ticket) {
	in.Title = strings.TrimSpace(in.Title)
	in.Status = defaulted(strings.TrimSpace(in.Status), "open")
	in.Priority = defaulted(strings.TrimSpace(in.Priority), "normal")
	in.SourceChannel = defaulted(strings.TrimSpace(in.SourceChannel), "generic")
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeView(in *View) {
	in.Name = strings.TrimSpace(in.Name)
	in.Visibility = defaulted(strings.TrimSpace(in.Visibility), "team")
	in.Status = defaulted(strings.TrimSpace(in.Status), "active")
	if in.Filters == nil {
		in.Filters = map[string]any{}
	}
	if in.Sort == nil {
		in.Sort = map[string]any{}
	}
}

func normalizeMacro(in *Macro) {
	in.Name = strings.TrimSpace(in.Name)
	in.Status = defaulted(strings.TrimSpace(in.Status), "active")
	in.ChannelTypes = cleanStrings(in.ChannelTypes)
	in.Tags = cleanStrings(in.Tags)
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeSpamAssessment(in *SpamAssessment) {
	in.Verdict = defaulted(strings.TrimSpace(in.Verdict), "unknown")
	in.AssessedBy = defaulted(strings.TrimSpace(in.AssessedBy), "rule")
	if in.Signals == nil {
		in.Signals = map[string]any{}
	}
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func serviceSuiteActorID(r *http.Request) (string, bool) {
	if r == nil {
		return "", false
	}
	if middleware.IsAPIKeyAuth(r.Context()) {
		id := strings.TrimSpace(middleware.APIKeyIDFromContext(r.Context()))
		return id, id != ""
	}
	if user, ok := middleware.UserFromContext(r.Context()); ok && user != nil {
		id := strings.TrimSpace(user.ID)
		return id, id != ""
	}
	return "", false
}

func mutationVersion(w http.ResponseWriter, r *http.Request) (string, bool) {
	version, err := requireIfMatch(r)
	if err != nil {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("precondition_required", "Supply the exact strong ETag returned for this resource in one If-Match header."))
		return "", false
	}
	return version, true
}

func writeCursorError(w http.ResponseWriter, err error, resource string) {
	if errors.Is(err, errCursorUnavailable) {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("pagination_unavailable", "Helpdesk pagination is unavailable until its dedicated cursor key is configured."))
		return
	}
	writeJSON(w, http.StatusBadRequest, errEnv("cursor_invalid", "cursor is invalid for this "+resource+" query"))
}

func writeRepoError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error, code string) {
	_ = code
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "resource not found"))
		return
	}
	if errors.Is(err, ErrPreconditionFailed) {
		writeJSON(w, http.StatusPreconditionFailed, errEnv("precondition_failed", "The resource changed; refetch it and review before retrying."))
		return
	}
	if errors.Is(err, ErrPrincipalNotMember) {
		writeJSON(w, http.StatusConflict, errEnv("human_actor_required", "The acting user is no longer an active tenant administrator; refetch identity before retrying."))
		return
	}
	if errors.Is(err, ErrInvalidPatch) {
		writeJSON(w, http.StatusBadRequest, errEnv("patch_invalid", "The PATCH document contains an invalid value or clears a required field."))
		return
	}
	if errors.Is(err, ErrInvalidProjection) {
		writeJSON(w, http.StatusBadRequest, errEnv("projection_invalid", "The requested Helpdesk projection violates the canonical size, shape, text, identifier, or timestamp contract."))
		return
	}
	if errors.Is(err, ErrGroundingMismatch) {
		writeJSON(w, http.StatusConflict, errEnv("draft_ticket_mismatch", "ticket_id is not bound to this conversation in the current tenant"))
		return
	}
	tenant, _ := middleware.TenantFromContext(r.Context())
	httperror.WriteInternal(w, logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
}

// decodeHelpdeskJSON preserves the caller's exact decimal spelling in every
// map/interface projection. Converting through float64 first would silently
// round values such as 9007199254740991.1 before the canonical SQL/Go numeric
// boundary can reject them.
func decodeHelpdeskJSON(w http.ResponseWriter, r *http.Request, max int64, dst any) error {
	return httpbody.DecodeJSONWith(w, r, max, dst, httpbody.Options{UseNumber: true})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errEnv(code, message string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": message}}
}

func cleanStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

func channelTypes() []string {
	return []string{"web_chat", "email", "sms", "instagram", "whatsapp", "facebook", "generic"}
}

func statuses() []string {
	return []string{"open", "pending", "waiting", "resolved", "closed", "spam", "archived"}
}

func priorities() []string {
	return []string{"low", "normal", "high", "urgent"}
}

func allowed(v string, allowed []string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func defaulted(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}
