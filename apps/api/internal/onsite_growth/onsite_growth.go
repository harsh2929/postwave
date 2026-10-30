package onsite_growth

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const onsiteGrowthJSONMaxBodyBytes int64 = 1 << 20

// CouponRewardDeliveryAvailable keeps coupon-bearing spin outcomes fail-closed
// until a verified entitlement and provider-reconciliation boundary exists.
// Non-financial spin outcomes and the rest of onsite growth remain available.
const CouponRewardDeliveryAvailable = false

type Deps struct {
	Repo           *Repo
	CouponAssigner CouponAssigner
	// Logger is optional — when nil httperror.WriteInternal still emits
	// the user-facing 500 envelope but suppresses the structured log line.
	Logger *slog.Logger
}

type CouponAssigner interface {
	AssignCoupon(ctx context.Context, tenantID, poolID string, in CouponAssignmentInput) (*AssignedCoupon, error)
}

type CouponAssignmentInput struct {
	SubscriberID          string         `json:"subscriber_id,omitempty"`
	SubscriberEmail       string         `json:"subscriber_email,omitempty"`
	ContextKey            string         `json:"context_key,omitempty"`
	RenderKey             string         `json:"render_key,omitempty"`
	Channel               string         `json:"channel,omitempty"`
	Surface               string         `json:"surface,omitempty"`
	ReservationTTLSeconds int            `json:"reservation_ttl_seconds,omitempty"`
	Metadata              map[string]any `json:"metadata,omitempty"`
}

type AssignedCoupon struct {
	Code         string     `json:"code"`
	PoolID       string     `json:"pool_id"`
	AssignmentID string     `json:"assignment_id,omitempty"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
}

type CatalogResponse struct {
	SchemaVersion    string        `json:"schema_version"`
	TriggerTypes     []CatalogItem `json:"trigger_types"`
	TargetingGroups  []CatalogItem `json:"targeting_groups"`
	FrequencyModes   []CatalogItem `json:"frequency_modes"`
	ExperimentModes  []CatalogItem `json:"experiment_modes"`
	WinnerMetrics    []CatalogItem `json:"winner_metrics"`
	SpinRewardTypes  []CatalogItem `json:"spin_reward_types"`
	ExperimentEvents []string      `json:"experiment_events"`
}

type CatalogItem struct {
	Key           string      `json:"key"`
	Label         string      `json:"label"`
	RuntimeStatus string      `json:"runtime_status"`
	Fields        []FieldSpec `json:"fields,omitempty"`
}

type FieldSpec struct {
	Key      string   `json:"key"`
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Options  []string `json:"options,omitempty"`
}

type TargetingRules struct {
	ID                 string         `json:"id,omitempty"`
	TenantID           string         `json:"tenant_id,omitempty"`
	FormID             string         `json:"form_id,omitempty"`
	Status             string         `json:"status,omitempty"`
	Priority           int            `json:"priority,omitempty"`
	Trigger            map[string]any `json:"trigger,omitempty"`
	Frequency          map[string]any `json:"frequency,omitempty"`
	Audience           map[string]any `json:"audience,omitempty"`
	URLRules           map[string]any `json:"url_rules,omitempty"`
	UTMRules           map[string]any `json:"utm_rules,omitempty"`
	CartRules          map[string]any `json:"cart_rules,omitempty"`
	GeoRules           map[string]any `json:"geo_rules,omitempty"`
	DeviceRules        map[string]any `json:"device_rules,omitempty"`
	VisitorStateRules  map[string]any `json:"visitor_state_rules,omitempty"`
	CustomTriggerRules map[string]any `json:"custom_trigger_rules,omitempty"`
	Compiled           map[string]any `json:"compiled,omitempty"`
	CreatedAt          time.Time      `json:"created_at,omitempty"`
	UpdatedAt          time.Time      `json:"updated_at,omitempty"`
}

type Experiment struct {
	ID              string         `json:"id,omitempty"`
	TenantID        string         `json:"tenant_id,omitempty"`
	FormID          string         `json:"form_id,omitempty"`
	Key             string         `json:"key"`
	Name            string         `json:"name"`
	Status          string         `json:"status,omitempty"`
	AllocationMode  string         `json:"allocation_mode,omitempty"`
	WinnerMetric    string         `json:"winner_metric,omitempty"`
	AdaptiveConfig  map[string]any `json:"adaptive_config,omitempty"`
	WinnerVariantID string         `json:"winner_variant_id,omitempty"`
	StartsAt        *time.Time     `json:"starts_at,omitempty"`
	EndsAt          *time.Time     `json:"ends_at,omitempty"`
	Variants        []Variant      `json:"variants,omitempty"`
	CreatedAt       time.Time      `json:"created_at,omitempty"`
	UpdatedAt       time.Time      `json:"updated_at,omitempty"`
}

type Variant struct {
	ID                       string         `json:"id,omitempty"`
	TenantID                 string         `json:"tenant_id,omitempty"`
	FormID                   string         `json:"form_id,omitempty"`
	ExperimentID             string         `json:"experiment_id,omitempty"`
	Key                      string         `json:"key"`
	Name                     string         `json:"name"`
	TrafficWeightBasisPoints int            `json:"traffic_weight_basis_points"`
	IsControl                bool           `json:"is_control,omitempty"`
	Status                   string         `json:"status,omitempty"`
	FormSnapshot             map[string]any `json:"form_snapshot,omitempty"`
	SuccessBehavior          map[string]any `json:"success_behavior,omitempty"`
	CouponPoolID             string         `json:"coupon_pool_id,omitempty"`
	Metrics                  map[string]any `json:"metrics,omitempty"`
	CreatedAt                time.Time      `json:"created_at,omitempty"`
	UpdatedAt                time.Time      `json:"updated_at,omitempty"`
}

type SpinReward struct {
	ID                string         `json:"id,omitempty"`
	TenantID          string         `json:"tenant_id,omitempty"`
	FormID            string         `json:"form_id,omitempty"`
	VariantID         string         `json:"variant_id,omitempty"`
	Key               string         `json:"key"`
	Label             string         `json:"label"`
	RewardType        string         `json:"reward_type,omitempty"`
	WeightBasisPoints int            `json:"weight_basis_points"`
	StaticCode        string         `json:"static_code,omitempty"`
	CouponPoolID      string         `json:"coupon_pool_id,omitempty"`
	SuccessStepKey    string         `json:"success_step_key,omitempty"`
	FlowBranchKey     string         `json:"flow_branch_key,omitempty"`
	Display           map[string]any `json:"display,omitempty"`
	Status            string         `json:"status,omitempty"`
	SortOrder         int            `json:"sort_order,omitempty"`
	CreatedAt         time.Time      `json:"created_at,omitempty"`
	UpdatedAt         time.Time      `json:"updated_at,omitempty"`
}

type ValidationRequest struct {
	Targeting   *TargetingRules `json:"targeting,omitempty"`
	Experiment  *Experiment     `json:"experiment,omitempty"`
	SpinRewards []SpinReward    `json:"spin_rewards,omitempty"`
}

type ValidationResponse struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

type EventInput struct {
	VariantID    string         `json:"variant_id,omitempty"`
	RewardID     string         `json:"reward_id,omitempty"`
	EventType    string         `json:"event_type"`
	SubscriberID string         `json:"subscriber_id,omitempty"`
	Email        string         `json:"email,omitempty"`
	RevenueCents int            `json:"revenue_cents,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
}

type SpinResolveRequest struct {
	VariantID             string         `json:"variant_id,omitempty"`
	SubscriberID          string         `json:"subscriber_id,omitempty"`
	SubscriberEmail       string         `json:"subscriber_email,omitempty"`
	ContextKey            string         `json:"context_key,omitempty"`
	RenderKey             string         `json:"render_key,omitempty"`
	EntropyBasisPoints    *int           `json:"entropy_basis_points,omitempty"`
	ReservationTTLSeconds int            `json:"reservation_ttl_seconds,omitempty"`
	Metadata              map[string]any `json:"metadata,omitempty"`
}

type SpinResolveResponse struct {
	Reward  SpinReward      `json:"reward"`
	Coupon  *AssignedCoupon `json:"coupon,omitempty"`
	Entropy int             `json:"entropy_basis_points"`
}

func MountRoutes(r chi.Router, d *Deps) {
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/onsite-growth/catalog", d.Catalog)
	r.With(write).Post("/api/v1/onsite-growth/validate", d.Validate)
	r.With(read).Get("/api/v1/onsite-growth/forms/{form_id}/targeting", d.GetFormTargeting)
	r.With(write).Put("/api/v1/onsite-growth/forms/{form_id}/targeting", d.PutFormTargeting)
	r.With(read).Get("/api/v1/onsite-growth/forms/{form_id}/experiments", d.ListFormExperiments)
	r.With(write).Put("/api/v1/onsite-growth/forms/{form_id}/experiments/{experiment_key}", d.UpsertFormExperiment)
	r.With(write).Post("/api/v1/onsite-growth/forms/{form_id}/experiments/{experiment_key}/events", d.RecordExperimentEvent)
	r.With(read).Get("/api/v1/onsite-growth/forms/{form_id}/spin/rewards", d.ListSpinRewards)
	r.With(write).Put("/api/v1/onsite-growth/forms/{form_id}/spin/rewards", d.ReplaceSpinRewards)
	r.With(write).Post("/api/v1/onsite-growth/forms/{form_id}/spin/resolve", d.ResolveSpin)
}

func MountPublicRoutes(r chi.Router, d *Deps) {
	r.Post("/api/public/forms/{slug}/spin", d.PublicResolveSpin)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, Catalog())
}

func (d *Deps) Validate(w http.ResponseWriter, r *http.Request) {
	var in ValidationRequest
	if err := httpbody.DecodeJSON(w, r, onsiteGrowthJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out := Validate(in)
	status := http.StatusOK
	if !out.Valid {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, out)
}

func (d *Deps) GetFormTargeting(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repo().GetFormTargeting(r.Context(), tenantID, chi.URLParam(r, "form_id"))
	if err != nil {
		d.writeRepoError(w, r, err, "targeting_lookup_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PutFormTargeting(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in TargetingRules
	if err := httpbody.DecodeJSON(w, r, onsiteGrowthJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.FormID = chi.URLParam(r, "form_id")
	if out := Validate(ValidationRequest{Targeting: &in}); !out.Valid {
		writeJSON(w, http.StatusUnprocessableEntity, out)
		return
	}
	out, err := d.repo().PutFormTargeting(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "targeting_save_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListFormExperiments(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repo().ListFormExperiments(r.Context(), tenantID, chi.URLParam(r, "form_id"))
	if err != nil {
		d.writeRepoError(w, r, err, "experiments_lookup_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) UpsertFormExperiment(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in Experiment
	if err := httpbody.DecodeJSON(w, r, onsiteGrowthJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.FormID = chi.URLParam(r, "form_id")
	if key := chi.URLParam(r, "experiment_key"); key != "" {
		in.Key = key
	}
	if out := Validate(ValidationRequest{Experiment: &in}); !out.Valid {
		writeJSON(w, http.StatusUnprocessableEntity, out)
		return
	}
	out, err := d.repo().UpsertFormExperiment(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "experiment_save_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RecordExperimentEvent(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in EventInput
	if err := httpbody.DecodeJSON(w, r, onsiteGrowthJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if !allowedString(strings.TrimSpace(in.EventType), experimentEventTypes()) {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_event_type", "event_type is not supported")
		return
	}
	in.EventType = strings.TrimSpace(in.EventType)
	id, err := d.repo().RecordExperimentEvent(r.Context(), tenantID, chi.URLParam(r, "form_id"), chi.URLParam(r, "experiment_key"), in)
	if err != nil {
		d.writeRepoError(w, r, err, "event_record_failed")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "event_id": id})
}

func (d *Deps) ListSpinRewards(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repo().ListSpinRewards(r.Context(), tenantID, chi.URLParam(r, "form_id"))
	if err != nil {
		d.writeRepoError(w, r, err, "spin_rewards_lookup_failed")
		return
	}
	if !CouponRewardDeliveryAvailable {
		out = redactUnavailableCouponRewards(out)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) ReplaceSpinRewards(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var body struct {
		Items []SpinReward `json:"items"`
	}
	if err := httpbody.DecodeJSON(w, r, onsiteGrowthJSONMaxBodyBytes, &body); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if out := Validate(ValidationRequest{SpinRewards: body.Items}); !out.Valid {
		writeJSON(w, http.StatusUnprocessableEntity, out)
		return
	}
	out, err := d.repo().ReplaceSpinRewards(r.Context(), tenantID, chi.URLParam(r, "form_id"), body.Items)
	if err != nil {
		d.writeRepoError(w, r, err, "spin_rewards_save_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) ResolveSpin(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in SpinResolveRequest
	if err := httpbody.DecodeJSON(w, r, onsiteGrowthJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.resolveSpin(r.Context(), tenantID, chi.URLParam(r, "form_id"), in)
	if err != nil {
		d.writeRepoError(w, r, err, "spin_resolve_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PublicResolveSpin(w http.ResponseWriter, r *http.Request) {
	scope, err := d.repo().PublicFormScopeBySlug(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		d.writeRepoError(w, r, err, "spin_lookup_failed")
		return
	}
	var in SpinResolveRequest
	if err := httpbody.DecodeJSON(w, r, onsiteGrowthJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.SubscriberEmail = strings.TrimSpace(strings.ToLower(in.SubscriberEmail))
	out, err := d.resolveSpin(r.Context(), scope.TenantID, scope.FormID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "spin_resolve_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) resolveSpin(ctx context.Context, tenantID, formID string, in SpinResolveRequest) (*SpinResolveResponse, error) {
	rewards, err := d.repo().ListSpinRewards(ctx, tenantID, formID)
	if err != nil {
		return nil, err
	}
	entropy := 0
	if in.EntropyBasisPoints != nil {
		entropy = *in.EntropyBasisPoints
	} else {
		entropy = secureEntropyBasisPoints()
	}
	reward, err := SelectSpinReward(rewards, entropy)
	if err != nil {
		return nil, err
	}
	if !CouponRewardDeliveryAvailable && spinRewardRequiresCouponDelivery(reward) {
		return nil, ErrCouponRewardUnavailable
	}
	out := &SpinResolveResponse{Reward: *reward, Entropy: normalizeEntropy(entropy)}
	if reward.CouponPoolID != "" && d.CouponAssigner != nil {
		identity := defaulted(in.SubscriberID, defaulted(in.SubscriberEmail, in.RenderKey))
		if identity == "" {
			return nil, fmt.Errorf("%w: subscriber_email, subscriber_id, or render_key is required for coupon rewards", ErrInvalidInput)
		}
		coupon, err := d.CouponAssigner.AssignCoupon(ctx, tenantID, reward.CouponPoolID, CouponAssignmentInput{
			SubscriberID:          in.SubscriberID,
			SubscriberEmail:       in.SubscriberEmail,
			ContextKey:            defaulted(in.ContextKey, "form:"+formID+":spin:"+reward.Key+":"+identity),
			RenderKey:             in.RenderKey,
			Channel:               "onsite",
			Surface:               "form_spin_to_win",
			ReservationTTLSeconds: in.ReservationTTLSeconds,
			Metadata:              in.Metadata,
		})
		if err != nil {
			return nil, err
		}
		out.Coupon = coupon
	}
	_ = d.repo().RecordSpinRewardEvent(ctx, tenantID, formID, *reward, in, out.Coupon)
	return out, nil
}

func Catalog() CatalogResponse {
	return CatalogResponse{
		SchemaVersion: "klv09.onsite-growth.v1",
		TriggerTypes: []CatalogItem{
			{Key: "immediate", Label: "Immediate", RuntimeStatus: "supported"},
			{Key: "delay", Label: "Time delay", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "seconds", Type: "number", Required: true}}},
			{Key: "scroll", Label: "Scroll depth", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "percent", Type: "number", Required: true}}},
			{Key: "exit_intent", Label: "Exit intent", RuntimeStatus: "supported"},
			{Key: "custom_event", Label: "Custom JavaScript event", RuntimeStatus: "partial", Fields: []FieldSpec{{Key: "event_name", Type: "string", Required: true}}},
			{Key: "button_click", Label: "Button click", RuntimeStatus: "partial", Fields: []FieldSpec{{Key: "selector", Type: "string", Required: true}}},
		},
		TargetingGroups: []CatalogItem{
			{Key: "device", Label: "Device type", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "devices", Type: "multi_select", Options: []string{"desktop", "mobile", "tablet"}}}},
			{Key: "url", Label: "URL rules", RuntimeStatus: "supported"},
			{Key: "utm", Label: "UTM rules", RuntimeStatus: "supported"},
			{Key: "cart", Label: "Cart contents", RuntimeStatus: "partial"},
			{Key: "geo", Label: "Location", RuntimeStatus: "partial"},
			{Key: "visitor_state", Label: "Visitor state", RuntimeStatus: "partial"},
			{Key: "list_segment", Label: "List and segment membership", RuntimeStatus: "partial"},
			{Key: "custom_trigger", Label: "Custom trigger", RuntimeStatus: "partial"},
		},
		FrequencyModes: []CatalogItem{
			{Key: "session", Label: "Per session", RuntimeStatus: "supported"},
			{Key: "visitor", Label: "Per visitor", RuntimeStatus: "partial"},
			{Key: "cooldown", Label: "Cooldown window", RuntimeStatus: "supported", Fields: []FieldSpec{{Key: "seconds", Type: "number", Required: true}}},
		},
		ExperimentModes: []CatalogItem{
			{Key: "manual", Label: "Manual traffic weights", RuntimeStatus: "supported"},
			{Key: "adaptive", Label: "Adaptive winner routing", RuntimeStatus: "partial"},
		},
		WinnerMetrics: []CatalogItem{
			{Key: "views", Label: "Views", RuntimeStatus: "supported"},
			{Key: "submissions", Label: "Submissions", RuntimeStatus: "supported"},
			{Key: "confirmed_submissions", Label: "Confirmed submissions", RuntimeStatus: "supported"},
			{Key: "conversion_rate", Label: "Conversion rate", RuntimeStatus: "partial"},
			{Key: "revenue", Label: "Revenue", RuntimeStatus: "partial"},
		},
		SpinRewardTypes: []CatalogItem{
			{Key: "none", Label: "No reward", RuntimeStatus: "supported"},
			{Key: "static_coupon", Label: "Static coupon", RuntimeStatus: "unavailable", Fields: []FieldSpec{{Key: "static_code", Type: "string", Required: true}}},
			{Key: "coupon_pool", Label: "Unique coupon pool", RuntimeStatus: "unavailable", Fields: []FieldSpec{{Key: "coupon_pool_id", Type: "string", Required: true}}},
			{Key: "custom_content", Label: "Custom success content", RuntimeStatus: "supported"},
		},
		ExperimentEvents: experimentEventTypes(),
	}
}

func Validate(in ValidationRequest) ValidationResponse {
	out := ValidationResponse{Valid: true}
	if in.Targeting != nil {
		out.Errors = append(out.Errors, validateTargeting(in.Targeting)...)
	}
	if in.Experiment != nil {
		errs, warnings := validateExperiment(in.Experiment)
		out.Errors = append(out.Errors, errs...)
		out.Warnings = append(out.Warnings, warnings...)
	}
	if in.SpinRewards != nil {
		out.Errors = append(out.Errors, validateSpinRewards(in.SpinRewards)...)
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func validateTargeting(in *TargetingRules) []string {
	errs := []string{}
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	if !allowedString(in.Status, []string{"draft", "published", "paused", "archived"}) {
		errs = append(errs, "targeting.status must be draft|published|paused|archived")
	}
	if in.Priority == 0 {
		in.Priority = 100
	}
	if in.Priority < 0 || in.Priority > 1000 {
		errs = append(errs, "targeting.priority must be between 0 and 1000")
	}
	if in.Trigger == nil {
		in.Trigger = map[string]any{}
	}
	if typ, _ := in.Trigger["type"].(string); typ != "" && !allowedString(typ, []string{"immediate", "delay", "scroll", "exit_intent", "custom_event", "button_click"}) {
		errs = append(errs, "targeting.trigger.type is not supported")
	}
	for name, payload := range map[string]map[string]any{
		"targeting.trigger":              in.Trigger,
		"targeting.frequency":            in.Frequency,
		"targeting.audience":             in.Audience,
		"targeting.url_rules":            in.URLRules,
		"targeting.utm_rules":            in.UTMRules,
		"targeting.cart_rules":           in.CartRules,
		"targeting.geo_rules":            in.GeoRules,
		"targeting.device_rules":         in.DeviceRules,
		"targeting.visitor_state_rules":  in.VisitorStateRules,
		"targeting.custom_trigger_rules": in.CustomTriggerRules,
		"targeting.compiled":             in.Compiled,
	} {
		if err := validateJSONMapSize(name, payload); err != nil {
			errs = append(errs, err.Error())
		}
	}
	ensureTargetingMaps(in)
	return errs
}

func validateExperiment(in *Experiment) ([]string, []string) {
	errs := []string{}
	warnings := []string{}
	in.Key = normalizeKey(in.Key)
	in.Name = strings.TrimSpace(in.Name)
	if in.Key == "" {
		errs = append(errs, "experiment.key is required")
	}
	if in.Name == "" {
		in.Name = in.Key
	}
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	if !allowedString(in.Status, []string{"draft", "running", "paused", "completed", "archived"}) {
		errs = append(errs, "experiment.status must be draft|running|paused|completed|archived")
	}
	in.AllocationMode = defaulted(strings.TrimSpace(in.AllocationMode), "manual")
	if !allowedString(in.AllocationMode, []string{"manual", "adaptive"}) {
		errs = append(errs, "experiment.allocation_mode must be manual|adaptive")
	}
	if in.AllocationMode == "adaptive" {
		warnings = append(warnings, "adaptive allocation state is stored now; automatic traffic rebalancing is a follow-up runtime task")
	}
	in.WinnerMetric = defaulted(strings.TrimSpace(in.WinnerMetric), "confirmed_submissions")
	if !allowedString(in.WinnerMetric, []string{"views", "submissions", "confirmed_submissions", "conversion_rate", "revenue"}) {
		errs = append(errs, "experiment.winner_metric is not supported")
	}
	if len(in.Variants) > 7 {
		errs = append(errs, "experiment.variants supports at most seven variants")
	}
	keys := map[string]struct{}{}
	total := 0
	active := 0
	controls := 0
	for i := range in.Variants {
		v := &in.Variants[i]
		v.Key = normalizeKey(v.Key)
		v.Name = strings.TrimSpace(v.Name)
		v.Status = defaulted(strings.TrimSpace(v.Status), "active")
		if v.Key == "" {
			errs = append(errs, fmt.Sprintf("variant %d: key is required", i))
		}
		if _, ok := keys[v.Key]; ok {
			errs = append(errs, fmt.Sprintf("variant %q: duplicate key", v.Key))
		}
		keys[v.Key] = struct{}{}
		if v.Name == "" {
			v.Name = v.Key
		}
		if !allowedString(v.Status, []string{"active", "paused", "archived"}) {
			errs = append(errs, fmt.Sprintf("variant %q: status must be active|paused|archived", v.Key))
		}
		if v.TrafficWeightBasisPoints < 0 || v.TrafficWeightBasisPoints > 10000 {
			errs = append(errs, fmt.Sprintf("variant %q: traffic_weight_basis_points must be between 0 and 10000", v.Key))
		}
		if v.Status == "active" {
			active++
			total += v.TrafficWeightBasisPoints
		}
		if v.IsControl {
			controls++
		}
		if err := validateJSONMapSize("variant."+v.Key+".form_snapshot", v.FormSnapshot); err != nil {
			errs = append(errs, err.Error())
		}
		if err := validateJSONMapSize("variant."+v.Key+".success_behavior", v.SuccessBehavior); err != nil {
			errs = append(errs, err.Error())
		}
		if v.FormSnapshot == nil {
			v.FormSnapshot = map[string]any{}
		}
		if v.SuccessBehavior == nil {
			v.SuccessBehavior = map[string]any{}
		}
		if v.Metrics == nil {
			v.Metrics = map[string]any{}
		}
	}
	if in.Status == "running" && active < 2 {
		errs = append(errs, "running experiments require at least two active variants")
	}
	if in.Status == "running" && active > 0 && total != 10000 {
		errs = append(errs, "running experiment active variant weights must total 10000 basis points")
	}
	if len(in.Variants) > 0 && controls == 0 {
		warnings = append(warnings, "no control variant is marked")
	}
	if in.AdaptiveConfig == nil {
		in.AdaptiveConfig = map[string]any{}
	}
	return errs, warnings
}

func validateSpinRewards(rewards []SpinReward) []string {
	errs := []string{}
	if len(rewards) > 20 {
		errs = append(errs, "spin_rewards supports at most twenty wheel slices")
	}
	keys := map[string]struct{}{}
	total := 0
	active := 0
	for i := range rewards {
		r := &rewards[i]
		r.Key = normalizeKey(r.Key)
		r.Label = strings.TrimSpace(r.Label)
		r.RewardType = defaulted(strings.TrimSpace(r.RewardType), "none")
		r.Status = defaulted(strings.TrimSpace(r.Status), "active")
		if r.Key == "" {
			errs = append(errs, fmt.Sprintf("spin reward %d: key is required", i))
		}
		if _, ok := keys[r.Key]; ok {
			errs = append(errs, fmt.Sprintf("spin reward %q: duplicate key", r.Key))
		}
		keys[r.Key] = struct{}{}
		if r.Label == "" {
			r.Label = r.Key
		}
		if !allowedString(r.RewardType, []string{"none", "static_coupon", "coupon_pool", "custom_content"}) {
			errs = append(errs, fmt.Sprintf("spin reward %q: reward_type is not supported", r.Key))
		}
		if !allowedString(r.Status, []string{"active", "paused", "archived"}) {
			errs = append(errs, fmt.Sprintf("spin reward %q: status must be active|paused|archived", r.Key))
		}
		if r.WeightBasisPoints < 0 || r.WeightBasisPoints > 10000 {
			errs = append(errs, fmt.Sprintf("spin reward %q: weight_basis_points must be between 0 and 10000", r.Key))
		}
		if r.RewardType == "static_coupon" && strings.TrimSpace(r.StaticCode) == "" {
			errs = append(errs, fmt.Sprintf("spin reward %q: static_code is required", r.Key))
		}
		if r.RewardType == "coupon_pool" && strings.TrimSpace(r.CouponPoolID) == "" {
			errs = append(errs, fmt.Sprintf("spin reward %q: coupon_pool_id is required", r.Key))
		}
		if r.Status == "active" {
			active++
			total += r.WeightBasisPoints
		}
		if err := validateJSONMapSize("spin_reward."+r.Key+".display", r.Display); err != nil {
			errs = append(errs, err.Error())
		}
		if r.Display == nil {
			r.Display = map[string]any{}
		}
	}
	if active > 0 && total != 10000 {
		errs = append(errs, "active spin reward weights must total 10000 basis points")
	}
	return errs
}

func SelectSpinReward(rewards []SpinReward, entropyBasisPoints int) (*SpinReward, error) {
	active := []SpinReward{}
	total := 0
	for _, reward := range rewards {
		if reward.Status == "active" && reward.WeightBasisPoints > 0 {
			active = append(active, reward)
			total += reward.WeightBasisPoints
		}
	}
	if len(active) == 0 || total <= 0 {
		return nil, ErrNotFound
	}
	entropy := normalizeEntropy(entropyBasisPoints)
	target := entropy
	if total != 10000 {
		target = entropy * total / 10000
	}
	cursor := 0
	for i := range active {
		cursor += active[i].WeightBasisPoints
		if target < cursor {
			return &active[i], nil
		}
	}
	return &active[len(active)-1], nil
}

func ensureTargetingMaps(in *TargetingRules) {
	if in.Trigger == nil {
		in.Trigger = map[string]any{}
	}
	if in.Frequency == nil {
		in.Frequency = map[string]any{}
	}
	if in.Audience == nil {
		in.Audience = map[string]any{}
	}
	if in.URLRules == nil {
		in.URLRules = map[string]any{}
	}
	if in.UTMRules == nil {
		in.UTMRules = map[string]any{}
	}
	if in.CartRules == nil {
		in.CartRules = map[string]any{}
	}
	if in.GeoRules == nil {
		in.GeoRules = map[string]any{}
	}
	if in.DeviceRules == nil {
		in.DeviceRules = map[string]any{}
	}
	if in.VisitorStateRules == nil {
		in.VisitorStateRules = map[string]any{}
	}
	if in.CustomTriggerRules == nil {
		in.CustomTriggerRules = map[string]any{}
	}
	if in.Compiled == nil {
		in.Compiled = map[string]any{}
	}
}

func validateJSONMapSize(name string, value map[string]any) error {
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

func experimentEventTypes() []string {
	return []string{"view", "impression", "submit", "confirmed", "conversion", "winner_selected", "reward_assigned", "reward_redeemed"}
}

func secureEntropyBasisPoints() int {
	n, err := rand.Int(rand.Reader, big.NewInt(10000))
	if err != nil {
		return int(time.Now().UnixNano() % 10000)
	}
	return int(n.Int64())
}

func normalizeEntropy(value int) int {
	value %= 10000
	if value < 0 {
		value += 10000
	}
	return value
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

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, err error, fallback string) {
	_ = fallback // retained for call-site clarity; 5xx code is now httperror.CodeInternal.
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "invalid_input", err.Error())
	case errors.Is(err, ErrCouponRewardUnavailable):
		httperror.Write(w, http.StatusServiceUnavailable, "coupon_reward_unavailable", "coupon rewards are not available")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func spinRewardRequiresCouponDelivery(reward *SpinReward) bool {
	if reward == nil {
		return false
	}
	return reward.RewardType == "static_coupon" ||
		reward.RewardType == "coupon_pool" ||
		strings.TrimSpace(reward.StaticCode) != "" ||
		strings.TrimSpace(reward.CouponPoolID) != ""
}

func redactUnavailableCouponRewards(rewards []SpinReward) []SpinReward {
	out := make([]SpinReward, len(rewards))
	copy(out, rewards)
	for i := range out {
		if spinRewardRequiresCouponDelivery(&out[i]) {
			out[i].StaticCode = ""
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
