package omnichannel

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/runtimecapability"
)

const omnichannelJSONMaxBodyBytes int64 = 1 << 20

const omnichannelRuntimeQualified = false

var omnichannelRuntime = func() runtimecapability.Descriptor {
	runtime := runtimecapability.Unavailable(
		"omnichannel_campaign_execution",
		"omnichannel_runtime_unavailable",
		"Omnichannel campaign execution is unavailable; the campaign was not materialized, evaluated, or dispatched.",
		"explicit_audience_enforcement",
		"durable_dispatcher",
		"live_provider_certification",
	)
	runtime.ExecutionEnabled = omnichannelRuntimeQualified
	return runtime
}()

// ErrOmnichannelRuntimeUnavailable protects non-HTTP repository/runtime seams
// from persisting or executing operational state while the release gate is
// closed.
var ErrOmnichannelRuntimeUnavailable = errors.New("omnichannel: runtime unavailable")

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
	// Sender is retained behind the contained runtime boundary for future live
	// certification. A nil sender fails delivery; it never records a no-op as a
	// successful handoff.
	Sender ChannelSender
}

type CatalogResponse struct {
	SchemaVersion  string                       `json:"schema_version"`
	Runtime        runtimecapability.Descriptor `json:"runtime"`
	Channels       []CatalogItem                `json:"channels"`
	SendStrategies []CatalogItem                `json:"send_strategies"`
	SnapshotModes  []CatalogItem                `json:"recipient_snapshot_modes"`
	PathStatuses   []string                     `json:"path_statuses"`
}

type CatalogItem struct {
	Key           string      `json:"key"`
	Label         string      `json:"label"`
	RuntimeStatus string      `json:"runtime_status"`
	Provider      string      `json:"provider,omitempty"`
	Fields        []FieldSpec `json:"fields,omitempty"`
}

type FieldSpec struct {
	Key      string   `json:"key"`
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Options  []string `json:"options,omitempty"`
}

type OmniCampaign struct {
	ID                    string                        `json:"id,omitempty"`
	TenantID              string                        `json:"tenant_id,omitempty"`
	Runtime               *runtimecapability.Descriptor `json:"runtime,omitempty"`
	Name                  string                        `json:"name"`
	Status                string                        `json:"status,omitempty"`
	Objective             string                        `json:"objective,omitempty"`
	AudienceStrategy      map[string]any                `json:"audience_strategy,omitempty"`
	Schedule              map[string]any                `json:"schedule,omitempty"`
	SendStrategy          map[string]any                `json:"send_strategy,omitempty"`
	RecipientSnapshotMode string                        `json:"recipient_snapshot_mode,omitempty"`
	SourceCampaignID      string                        `json:"source_campaign_id,omitempty"`
	Paths                 []CampaignPath                `json:"paths,omitempty"`
	CreatedAt             time.Time                     `json:"created_at,omitempty"`
	UpdatedAt             time.Time                     `json:"updated_at,omitempty"`
}

type CampaignPath struct {
	ID                       string         `json:"id,omitempty"`
	TenantID                 string         `json:"tenant_id,omitempty"`
	CampaignID               string         `json:"campaign_id,omitempty"`
	PathKey                  string         `json:"path_key"`
	Name                     string         `json:"name"`
	Channel                  string         `json:"channel"`
	Status                   string         `json:"status,omitempty"`
	Audience                 map[string]any `json:"audience,omitempty"`
	MessageTemplateID        string         `json:"message_template_id,omitempty"`
	FallbackPathKey          string         `json:"fallback_path_key,omitempty"`
	TrafficWeightBasisPoints int            `json:"traffic_weight_basis_points,omitempty"`
	Sequence                 int            `json:"sequence,omitempty"`
	Settings                 map[string]any `json:"settings,omitempty"`
	CreatedAt                time.Time      `json:"created_at,omitempty"`
	UpdatedAt                time.Time      `json:"updated_at,omitempty"`
}

type MessageTemplate struct {
	ID                 string         `json:"id,omitempty"`
	TenantID           string         `json:"tenant_id,omitempty"`
	Channel            string         `json:"channel"`
	Name               string         `json:"name"`
	Status             string         `json:"status,omitempty"`
	Subject            string         `json:"subject,omitempty"`
	BodyText           string         `json:"body_text,omitempty"`
	BodyHTML           string         `json:"body_html,omitempty"`
	Media              map[string]any `json:"media,omitempty"`
	Variables          []string       `json:"variables,omitempty"`
	ProviderTemplateID string         `json:"provider_template_id,omitempty"`
	ApprovalStatus     string         `json:"approval_status,omitempty"`
	CreatedAt          time.Time      `json:"created_at,omitempty"`
	UpdatedAt          time.Time      `json:"updated_at,omitempty"`
}

type ValidationRequest struct {
	Campaign OmniCampaign `json:"campaign"`
}

type ValidationResponse struct {
	Valid            bool                         `json:"valid"`
	Errors           []string                     `json:"errors,omitempty"`
	Warnings         []string                     `json:"warnings,omitempty"`
	SupportedPaths   int                          `json:"supported_paths"`
	PartialPaths     int                          `json:"partial_paths"`
	PlannedPaths     int                          `json:"planned_paths"`
	UnsupportedPaths int                          `json:"unsupported_paths"`
	Runtime          runtimecapability.Descriptor `json:"runtime"`
}

func MountRoutes(r chi.Router, d *Deps) {
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/omnichannel/catalog", d.Catalog)
	r.With(read).Get("/api/v1/omnichannel/campaigns", d.ListCampaigns)
	r.With(read).Get("/api/v1/omnichannel/campaigns/{id}", d.GetCampaign)
	r.With(write).Post("/api/v1/omnichannel/campaigns", d.CreateCampaign)
	r.With(write).Post("/api/v1/omnichannel/validate", d.ValidateCampaign)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, Catalog())
}

func (d *Deps) ValidateCampaign(w http.ResponseWriter, r *http.Request) {
	var in ValidationRequest
	if err := httpbody.DecodeJSON(w, r, omnichannelJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out := Validate(in.Campaign)
	status := http.StatusOK
	if !out.Valid {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, out)
}

func (d *Deps) ListCampaigns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	items, err := d.repo().ListCampaigns(r.Context(), tenantID, r.URL.Query().Get("status"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for i := range items {
		annotateCampaignRuntime(&items[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *Deps) GetCampaign(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repo().GetCampaign(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	annotateCampaignRuntime(out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateCampaign(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in OmniCampaign
	if err := httpbody.DecodeJSON(w, r, omnichannelJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if requestsRuntimeState(in) {
		runtimecapability.WriteUnavailable(w, omnichannelRuntime)
		return
	}
	validation := Validate(in)
	if !validation.Valid {
		writeJSON(w, http.StatusUnprocessableEntity, validation)
		return
	}
	out, err := d.repo().CreateCampaign(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	annotateCampaignRuntime(out)
	writeJSON(w, http.StatusCreated, out)
}

func Catalog() CatalogResponse {
	return CatalogResponse{
		SchemaVersion: "klv01.omnichannel.v1",
		Runtime:       omnichannelRuntime,
		Channels: []CatalogItem{
			{Key: "email", Label: "Email", RuntimeStatus: "unavailable", Provider: "postwave"},
			{Key: "sms", Label: "SMS", RuntimeStatus: "unavailable", Provider: "twilio"},
			{Key: "whatsapp", Label: "WhatsApp", RuntimeStatus: "unavailable", Provider: "meta", Fields: []FieldSpec{{Key: "provider_template_id", Type: "string", Required: true}}},
			{Key: "rcs", Label: "RCS", RuntimeStatus: "unavailable", Provider: "google-rbm", Fields: []FieldSpec{{Key: "fallback_path_key", Type: "string", Required: true}}},
			{Key: "push", Label: "Customer mobile push", RuntimeStatus: "unavailable", Provider: "apns_fcm", Fields: []FieldSpec{{Key: "app_id", Type: "string", Required: true}}},
		},
		SendStrategies: []CatalogItem{
			{Key: "fixed", Label: "Fixed time", RuntimeStatus: "unavailable"},
			{Key: "gradual", Label: "Gradual send", RuntimeStatus: "unavailable", Fields: []FieldSpec{{Key: "duration_seconds", Type: "number", Required: true}}},
			{Key: "recipient_local_time", Label: "Recipient local time", RuntimeStatus: "unavailable"},
			{Key: "smart_send_time_exploration", Label: "Smart Send Time exploration", RuntimeStatus: "unavailable"},
			{Key: "personalized_send_time", Label: "Personalized send time", RuntimeStatus: "unavailable"},
		},
		SnapshotModes: []CatalogItem{
			{Key: "draft_time", Label: "Determine recipients now", RuntimeStatus: "unavailable"},
			{Key: "send_time", Label: "Determine recipients at send time", RuntimeStatus: "unavailable"},
		},
		PathStatuses: []string{"draft", "ready", "scheduled", "sending", "sent", "paused", "cancelled", "blocked"},
	}
}

func Validate(in OmniCampaign) ValidationResponse {
	normalizeCampaign(&in)
	out := ValidationResponse{Valid: true, Runtime: omnichannelRuntime}
	if in.Name == "" {
		out.Errors = append(out.Errors, "campaign.name is required")
	}
	if !allowedString(in.Status, []string{"draft", "scheduled", "sending", "sent", "paused", "cancelled", "archived"}) {
		out.Errors = append(out.Errors, "campaign.status must be draft|scheduled|sending|sent|paused|cancelled|archived")
	}
	if !allowedString(in.Objective, []string{"marketing", "transactional", "service", "winback", "announcement", "custom"}) {
		out.Errors = append(out.Errors, "campaign.objective is not supported")
	}
	if !allowedString(in.RecipientSnapshotMode, []string{"draft_time", "send_time"}) {
		out.Errors = append(out.Errors, "campaign.recipient_snapshot_mode must be draft_time|send_time")
	}
	if len(in.Paths) == 0 {
		out.Errors = append(out.Errors, "at least one campaign path is required")
	}
	if len(in.Paths) > 10 {
		out.Errors = append(out.Errors, "omnichannel campaigns support at most ten paths")
	}
	if err := validateJSONSize("campaign.audience_strategy", in.AudienceStrategy); err != nil {
		out.Errors = append(out.Errors, err.Error())
	}
	if err := validateJSONSize("campaign.schedule", in.Schedule); err != nil {
		out.Errors = append(out.Errors, err.Error())
	}
	if err := validateJSONSize("campaign.send_strategy", in.SendStrategy); err != nil {
		out.Errors = append(out.Errors, err.Error())
	}
	strategy, _ := in.SendStrategy["mode"].(string)
	if strategy != "" && !allowedString(strategy, []string{"fixed", "gradual", "recipient_local_time", "smart_send_time_exploration", "personalized_send_time"}) {
		out.Errors = append(out.Errors, "campaign.send_strategy.mode is not supported")
	}
	keys := map[string]string{}
	channels := map[string]struct{}{}
	totalWeight := 0
	for i := range in.Paths {
		path := in.Paths[i]
		normalizePath(&path, i)
		if path.PathKey == "" {
			out.Errors = append(out.Errors, fmt.Sprintf("path %d: path_key is required", i))
		}
		if _, exists := keys[path.PathKey]; exists {
			out.Errors = append(out.Errors, fmt.Sprintf("path %q: duplicate path_key", path.PathKey))
		}
		keys[path.PathKey] = path.Channel
		if path.Name == "" {
			out.Errors = append(out.Errors, fmt.Sprintf("path %q: name is required", path.PathKey))
		}
		status := channelStatus(path.Channel)
		switch status {
		case "supported":
			out.SupportedPaths++
		case "partial":
			out.PartialPaths++
			out.Warnings = append(out.Warnings, fmt.Sprintf("path %q channel %q is partially supported", path.PathKey, path.Channel))
		case "planned":
			out.PlannedPaths++
			out.Warnings = append(out.Warnings, fmt.Sprintf("path %q channel %q is cataloged but provider sending is planned", path.PathKey, path.Channel))
		case "unavailable":
			out.PlannedPaths++
			out.Warnings = append(out.Warnings, fmt.Sprintf("path %q channel %q can be authored but campaign execution is unavailable", path.PathKey, path.Channel))
		default:
			out.UnsupportedPaths++
			out.Errors = append(out.Errors, fmt.Sprintf("path %q: unsupported channel %q", path.PathKey, path.Channel))
		}
		if !allowedString(path.Status, []string{"draft", "ready", "scheduled", "sending", "sent", "paused", "cancelled", "blocked"}) {
			out.Errors = append(out.Errors, fmt.Sprintf("path %q: invalid status", path.PathKey))
		}
		if path.TrafficWeightBasisPoints < 0 || path.TrafficWeightBasisPoints > 10000 {
			out.Errors = append(out.Errors, fmt.Sprintf("path %q: traffic_weight_basis_points must be between 0 and 10000", path.PathKey))
		}
		totalWeight += path.TrafficWeightBasisPoints
		channels[path.Channel] = struct{}{}
		if path.Channel == "rcs" && strings.TrimSpace(path.FallbackPathKey) == "" {
			out.Errors = append(out.Errors, fmt.Sprintf("path %q: RCS requires fallback_path_key for SMS fallback", path.PathKey))
		}
		if path.Channel == "whatsapp" && path.Status == "ready" && path.MessageTemplateID == "" {
			out.Warnings = append(out.Warnings, fmt.Sprintf("path %q: WhatsApp ready paths should reference an approved template", path.PathKey))
		}
		if err := validateJSONSize("path."+path.PathKey+".audience", path.Audience); err != nil {
			out.Errors = append(out.Errors, err.Error())
		}
		if err := validateJSONSize("path."+path.PathKey+".settings", path.Settings); err != nil {
			out.Errors = append(out.Errors, err.Error())
		}
	}
	for _, path := range in.Paths {
		if path.FallbackPathKey != "" {
			channel, ok := keys[path.FallbackPathKey]
			if !ok {
				out.Errors = append(out.Errors, fmt.Sprintf("path %q: fallback_path_key does not reference another path", path.PathKey))
			} else if path.Channel == "rcs" && channel != "sms" {
				out.Errors = append(out.Errors, fmt.Sprintf("path %q: RCS fallback must target an SMS path", path.PathKey))
			}
		}
	}
	if len(in.Paths) > 1 && totalWeight != 10000 {
		out.Errors = append(out.Errors, "multi-path traffic weights must total 10000 basis points")
	}
	if len(channels) > 1 && strategy == "" {
		out.Warnings = append(out.Warnings, "multi-channel campaigns should declare send_strategy.mode")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func normalizeCampaign(in *OmniCampaign) {
	in.Name = strings.TrimSpace(in.Name)
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.Objective = defaulted(strings.TrimSpace(in.Objective), "marketing")
	in.RecipientSnapshotMode = defaulted(strings.TrimSpace(in.RecipientSnapshotMode), "send_time")
	if in.AudienceStrategy == nil {
		in.AudienceStrategy = map[string]any{}
	}
	if in.Schedule == nil {
		in.Schedule = map[string]any{}
	}
	if in.SendStrategy == nil {
		in.SendStrategy = map[string]any{}
	}
	for i := range in.Paths {
		normalizePath(&in.Paths[i], i)
	}
}

func normalizePath(in *CampaignPath, index int) {
	in.PathKey = normalizeKey(in.PathKey)
	if in.PathKey == "" && in.Channel != "" {
		in.PathKey = normalizeKey(in.Channel)
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Channel = strings.TrimSpace(strings.ToLower(in.Channel))
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.FallbackPathKey = normalizeKey(in.FallbackPathKey)
	if in.TrafficWeightBasisPoints == 0 {
		in.TrafficWeightBasisPoints = 10000
	}
	if in.Audience == nil {
		in.Audience = map[string]any{}
	}
	if in.Settings == nil {
		in.Settings = map[string]any{}
	}
	if in.Sequence == 0 {
		in.Sequence = index
	}
}

func channelStatus(channel string) string {
	switch channel {
	case "email", "sms", "push", "whatsapp", "rcs":
		return "unavailable"
	default:
		return "unsupported"
	}
}

// requestsRuntimeState distinguishes strictly draft-only authoring from every
// lifecycle state. Creation is the only campaign mutation route; accepting a
// paused, blocked, cancelled, ready, or execution state would make a persisted
// record imply that a lifecycle controller exists when none is qualified.
func requestsRuntimeState(in OmniCampaign) bool {
	normalizeCampaign(&in)
	if in.Status != "draft" {
		return true
	}
	for _, path := range in.Paths {
		if path.Status != "draft" {
			return true
		}
	}
	return false
}

// annotateCampaignRuntime keeps pre-existing operational-looking records
// inspectable without implying that this build can execute them.
func annotateCampaignRuntime(in *OmniCampaign) {
	if in == nil {
		return
	}
	runtime := omnichannelRuntime
	in.Runtime = &runtime
}

func normalizeKey(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func validateJSONSize(name string, value map[string]any) error {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("%s must be valid JSON", name)
	}
	if len(raw) > int(256<<10) {
		return fmt.Errorf("%s must be 256KiB or smaller", name)
	}
	return nil
}

func allowedString(value string, allowed []string) bool {
	for _, item := range allowed {
		if value == item {
			return true
		}
	}
	return false
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func (d *Deps) repo() *Repo {
	if d == nil {
		return nil
	}
	return d.Repo
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, ErrInvalidInput):
		// ErrInvalidInput is wrapped in repo.CreateCampaign with our own
		// Validate() error strings (operator-authored) — safe to echo.
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_input", err.Error())
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
