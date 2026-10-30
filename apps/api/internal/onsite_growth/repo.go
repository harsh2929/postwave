package onsite_growth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	ErrNotFound                = errors.New("onsite_growth: not found")
	ErrInvalidInput            = errors.New("onsite_growth: invalid input")
	ErrCouponRewardUnavailable = errors.New("onsite_growth: coupon reward unavailable")
)

type Repo struct {
	Pool *db.Pool
}

type FormScope struct {
	TenantID string
	FormID   string
	Slug     string
}

func (r *Repo) PublicFormScopeBySlug(ctx context.Context, slug string) (*FormScope, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_form_slug', $1, true)`, slug); err != nil {
		return nil, err
	}
	var out FormScope
	if err := tx.QueryRow(ctx, `
SELECT tenant_id::text, id::text, slug::text
FROM forms
WHERE slug = $1 AND status = 'published'
LIMIT 1`, slug).Scan(&out.TenantID, &out.FormID, &out.Slug); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *Repo) GetFormTargeting(ctx context.Context, tenantID, formID string) (*TargetingRules, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, form_id::text, status, priority,
       trigger, frequency, audience, url_rules, utm_rules, cart_rules,
       geo_rules, device_rules, visitor_state_rules, custom_trigger_rules,
       compiled, created_at, updated_at
FROM onsite_targeting_rules
WHERE tenant_id = $1::uuid AND form_id = $2::uuid
LIMIT 1`, tenantID, formID)
	out, err := scanTargetingRules(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) PutFormTargeting(ctx context.Context, tenantID string, in TargetingRules) (*TargetingRules, error) {
	if strings.TrimSpace(in.FormID) == "" {
		return nil, fmt.Errorf("%w: form_id is required", ErrInvalidInput)
	}
	ensureTargetingMaps(&in)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureFormTx(ctx, tx, tenantID, in.FormID); err != nil {
		return nil, err
	}
	raw := map[string]string{}
	for name, value := range map[string]map[string]any{
		"trigger":              in.Trigger,
		"frequency":            in.Frequency,
		"audience":             in.Audience,
		"url_rules":            in.URLRules,
		"utm_rules":            in.UTMRules,
		"cart_rules":           in.CartRules,
		"geo_rules":            in.GeoRules,
		"device_rules":         in.DeviceRules,
		"visitor_state_rules":  in.VisitorStateRules,
		"custom_trigger_rules": in.CustomTriggerRules,
		"compiled":             in.Compiled,
	} {
		b, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		raw[name] = string(b)
	}
	row := tx.QueryRow(ctx, `
INSERT INTO onsite_targeting_rules
    (tenant_id, form_id, status, priority, trigger, frequency, audience,
     url_rules, utm_rules, cart_rules, geo_rules, device_rules,
     visitor_state_rules, custom_trigger_rules, compiled)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
     $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
     $13::jsonb, $14::jsonb, $15::jsonb)
ON CONFLICT (tenant_id, form_id) DO UPDATE SET
    status = EXCLUDED.status,
    priority = EXCLUDED.priority,
    trigger = EXCLUDED.trigger,
    frequency = EXCLUDED.frequency,
    audience = EXCLUDED.audience,
    url_rules = EXCLUDED.url_rules,
    utm_rules = EXCLUDED.utm_rules,
    cart_rules = EXCLUDED.cart_rules,
    geo_rules = EXCLUDED.geo_rules,
    device_rules = EXCLUDED.device_rules,
    visitor_state_rules = EXCLUDED.visitor_state_rules,
    custom_trigger_rules = EXCLUDED.custom_trigger_rules,
    compiled = EXCLUDED.compiled,
    updated_at = now()
RETURNING id::text, tenant_id::text, form_id::text, status, priority,
       trigger, frequency, audience, url_rules, utm_rules, cart_rules,
       geo_rules, device_rules, visitor_state_rules, custom_trigger_rules,
       compiled, created_at, updated_at`,
		tenantID, in.FormID, in.Status, in.Priority, raw["trigger"], raw["frequency"], raw["audience"],
		raw["url_rules"], raw["utm_rules"], raw["cart_rules"], raw["geo_rules"], raw["device_rules"],
		raw["visitor_state_rules"], raw["custom_trigger_rules"], raw["compiled"])
	out, err := scanTargetingRules(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ListFormExperiments(ctx context.Context, tenantID, formID string) ([]Experiment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, form_id::text, key, name, status,
       allocation_mode, winner_metric, adaptive_config,
       COALESCE(winner_variant_id::text, ''), starts_at, ends_at,
       created_at, updated_at
FROM onsite_form_experiments
WHERE tenant_id = $1::uuid AND form_id = $2::uuid
ORDER BY updated_at DESC`, tenantID, formID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Experiment{}
	for rows.Next() {
		item, err := scanExperiment(rows)
		if err != nil {
			return nil, err
		}
		variants, err := listVariantsTx(ctx, tx, tenantID, item.ID)
		if err != nil {
			return nil, err
		}
		item.Variants = variants
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) UpsertFormExperiment(ctx context.Context, tenantID string, in Experiment) (*Experiment, error) {
	if strings.TrimSpace(in.FormID) == "" {
		return nil, fmt.Errorf("%w: form_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(in.Key) == "" {
		return nil, fmt.Errorf("%w: experiment key is required", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureFormTx(ctx, tx, tenantID, in.FormID); err != nil {
		return nil, err
	}
	adaptive, _ := json.Marshal(nonNilMap(in.AdaptiveConfig))
	row := tx.QueryRow(ctx, `
INSERT INTO onsite_form_experiments
    (tenant_id, form_id, key, name, status, allocation_mode, winner_metric,
     adaptive_config, starts_at, ends_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
ON CONFLICT (tenant_id, form_id, key) DO UPDATE SET
    name = EXCLUDED.name,
    status = EXCLUDED.status,
    allocation_mode = EXCLUDED.allocation_mode,
    winner_metric = EXCLUDED.winner_metric,
    adaptive_config = EXCLUDED.adaptive_config,
    starts_at = EXCLUDED.starts_at,
    ends_at = EXCLUDED.ends_at,
    updated_at = now()
RETURNING id::text, tenant_id::text, form_id::text, key, name, status,
       allocation_mode, winner_metric, adaptive_config,
       COALESCE(winner_variant_id::text, ''), starts_at, ends_at,
       created_at, updated_at`,
		tenantID, in.FormID, in.Key, in.Name, in.Status, in.AllocationMode,
		in.WinnerMetric, string(adaptive), in.StartsAt, in.EndsAt)
	out, err := scanExperiment(row)
	if err != nil {
		return nil, err
	}
	if in.Variants != nil {
		if err := replaceVariantsTx(ctx, tx, tenantID, in.FormID, out.ID, in.Variants); err != nil {
			return nil, err
		}
	}
	out.Variants, err = listVariantsTx(ctx, tx, tenantID, out.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) RecordExperimentEvent(ctx context.Context, tenantID, formID, experimentKey string, in EventInput) (int64, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureFormTx(ctx, tx, tenantID, formID); err != nil {
		return 0, err
	}
	experimentID, err := experimentIDTx(ctx, tx, tenantID, formID, experimentKey)
	if err != nil {
		return 0, err
	}
	meta, _ := json.Marshal(nonNilMap(in.Metadata))
	var id int64
	if err := tx.QueryRow(ctx, `
INSERT INTO onsite_experiment_events
    (tenant_id, form_id, experiment_id, variant_id, reward_id, event_type,
     subscriber_id, email, revenue_cents, metadata)
VALUES
    ($1::uuid, $2::uuid, $3::uuid, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid, $6,
     NULLIF($7, '')::uuid, NULLIF($8, ''), $9, $10::jsonb)
RETURNING id`,
		tenantID, formID, experimentID, in.VariantID, in.RewardID, in.EventType,
		in.SubscriberID, strings.TrimSpace(strings.ToLower(in.Email)), in.RevenueCents, string(meta)).Scan(&id); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return id, nil
}

func (r *Repo) RecordSpinRewardEvent(ctx context.Context, tenantID, formID string, reward SpinReward, in SpinResolveRequest, coupon *AssignedCoupon) error {
	if reward.ID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	meta := nonNilMap(in.Metadata)
	if coupon != nil {
		meta["coupon_pool_id"] = coupon.PoolID
		meta["coupon_assignment_id"] = coupon.AssignmentID
	}
	raw, _ := json.Marshal(meta)
	_, err = tx.Exec(ctx, `
INSERT INTO onsite_experiment_events
    (tenant_id, form_id, variant_id, reward_id, event_type,
     subscriber_id, email, metadata)
VALUES
    ($1::uuid, $2::uuid, NULLIF($3, '')::uuid, $4::uuid, 'reward_assigned',
     NULLIF($5, '')::uuid, NULLIF($6, ''), $7::jsonb)`,
		tenantID, formID, reward.VariantID, reward.ID, in.SubscriberID,
		strings.TrimSpace(strings.ToLower(in.SubscriberEmail)), string(raw))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) ListSpinRewards(ctx context.Context, tenantID, formID string) ([]SpinReward, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, form_id::text, COALESCE(variant_id::text, ''),
       key, label, reward_type, weight_basis_points, static_code,
       COALESCE(coupon_pool_id::text, ''), success_step_key, flow_branch_key,
       display, status, sort_order, created_at, updated_at
FROM onsite_spin_to_win_rewards
WHERE tenant_id = $1::uuid AND form_id = $2::uuid
ORDER BY sort_order ASC, key ASC`, tenantID, formID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SpinReward{}
	for rows.Next() {
		item, err := scanSpinReward(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ReplaceSpinRewards(ctx context.Context, tenantID, formID string, rewards []SpinReward) ([]SpinReward, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureFormTx(ctx, tx, tenantID, formID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM onsite_spin_to_win_rewards WHERE tenant_id = $1::uuid AND form_id = $2::uuid`, tenantID, formID); err != nil {
		return nil, err
	}
	for i, reward := range rewards {
		if reward.SortOrder == 0 {
			reward.SortOrder = i
		}
		display, _ := json.Marshal(nonNilMap(reward.Display))
		if _, err := tx.Exec(ctx, `
INSERT INTO onsite_spin_to_win_rewards
    (tenant_id, form_id, variant_id, key, label, reward_type,
     weight_basis_points, static_code, coupon_pool_id, success_step_key,
     flow_branch_key, display, status, sort_order)
VALUES
    ($1::uuid, $2::uuid, NULLIF($3, '')::uuid, $4, $5, $6,
     $7, $8, NULLIF($9, '')::uuid, $10, $11, $12::jsonb, $13, $14)`,
			tenantID, formID, reward.VariantID, reward.Key, reward.Label, reward.RewardType,
			reward.WeightBasisPoints, strings.TrimSpace(reward.StaticCode), reward.CouponPoolID,
			reward.SuccessStepKey, reward.FlowBranchKey, string(display), reward.Status, reward.SortOrder); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, form_id::text, COALESCE(variant_id::text, ''),
       key, label, reward_type, weight_basis_points, static_code,
       COALESCE(coupon_pool_id::text, ''), success_step_key, flow_branch_key,
       display, status, sort_order, created_at, updated_at
FROM onsite_spin_to_win_rewards
WHERE tenant_id = $1::uuid AND form_id = $2::uuid
ORDER BY sort_order ASC, key ASC`, tenantID, formID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SpinReward{}
	for rows.Next() {
		item, err := scanSpinReward(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func replaceVariantsTx(ctx context.Context, tx pgx.Tx, tenantID, formID, experimentID string, variants []Variant) error {
	if _, err := tx.Exec(ctx, `DELETE FROM onsite_form_variants WHERE tenant_id = $1::uuid AND experiment_id = $2::uuid`, tenantID, experimentID); err != nil {
		return err
	}
	for _, variant := range variants {
		snapshot, _ := json.Marshal(nonNilMap(variant.FormSnapshot))
		success, _ := json.Marshal(nonNilMap(variant.SuccessBehavior))
		metrics, _ := json.Marshal(nonNilMap(variant.Metrics))
		if _, err := tx.Exec(ctx, `
INSERT INTO onsite_form_variants
    (tenant_id, form_id, experiment_id, key, name, traffic_weight_basis_points,
     is_control, status, form_snapshot, success_behavior, coupon_pool_id, metrics)
VALUES
    ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
     $9::jsonb, $10::jsonb, NULLIF($11, '')::uuid, $12::jsonb)`,
			tenantID, formID, experimentID, variant.Key, variant.Name, variant.TrafficWeightBasisPoints,
			variant.IsControl, variant.Status, string(snapshot), string(success), variant.CouponPoolID, string(metrics)); err != nil {
			return err
		}
	}
	return nil
}

func listVariantsTx(ctx context.Context, tx pgx.Tx, tenantID, experimentID string) ([]Variant, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, form_id::text, experiment_id::text,
       key, name, traffic_weight_basis_points, is_control, status,
       form_snapshot, success_behavior, COALESCE(coupon_pool_id::text, ''),
       metrics, created_at, updated_at
FROM onsite_form_variants
WHERE tenant_id = $1::uuid AND experiment_id = $2::uuid
ORDER BY key`, tenantID, experimentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Variant{}
	for rows.Next() {
		item, err := scanVariant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	return out, rows.Err()
}

func ensureFormTx(ctx context.Context, tx pgx.Tx, tenantID, formID string) error {
	if strings.TrimSpace(formID) == "" {
		return fmt.Errorf("%w: form_id is required", ErrInvalidInput)
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS(SELECT 1 FROM forms WHERE tenant_id = $1::uuid AND id = $2::uuid)`, tenantID, formID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func experimentIDTx(ctx context.Context, tx pgx.Tx, tenantID, formID, key string) (string, error) {
	var id string
	if err := tx.QueryRow(ctx, `
SELECT id::text
FROM onsite_form_experiments
WHERE tenant_id = $1::uuid AND form_id = $2::uuid AND key = $3
LIMIT 1`, tenantID, formID, key).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return id, nil
}

func scanTargetingRules(row pgx.Row) (*TargetingRules, error) {
	var out TargetingRules
	var trigger, frequency, audience, urlRules, utmRules, cartRules []byte
	var geoRules, deviceRules, visitorStateRules, customTriggerRules, compiled []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.FormID, &out.Status, &out.Priority,
		&trigger, &frequency, &audience, &urlRules, &utmRules, &cartRules,
		&geoRules, &deviceRules, &visitorStateRules, &customTriggerRules,
		&compiled, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.Trigger = decodeMap(trigger)
	out.Frequency = decodeMap(frequency)
	out.Audience = decodeMap(audience)
	out.URLRules = decodeMap(urlRules)
	out.UTMRules = decodeMap(utmRules)
	out.CartRules = decodeMap(cartRules)
	out.GeoRules = decodeMap(geoRules)
	out.DeviceRules = decodeMap(deviceRules)
	out.VisitorStateRules = decodeMap(visitorStateRules)
	out.CustomTriggerRules = decodeMap(customTriggerRules)
	out.Compiled = decodeMap(compiled)
	return &out, nil
}

func scanExperiment(row pgx.Row) (*Experiment, error) {
	var out Experiment
	var adaptive []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.FormID, &out.Key, &out.Name, &out.Status,
		&out.AllocationMode, &out.WinnerMetric, &adaptive, &out.WinnerVariantID,
		&out.StartsAt, &out.EndsAt, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.AdaptiveConfig = decodeMap(adaptive)
	return &out, nil
}

func scanVariant(row pgx.Row) (*Variant, error) {
	var out Variant
	var snapshot, success, metrics []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.FormID, &out.ExperimentID,
		&out.Key, &out.Name, &out.TrafficWeightBasisPoints, &out.IsControl,
		&out.Status, &snapshot, &success, &out.CouponPoolID, &metrics,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.FormSnapshot = decodeMap(snapshot)
	out.SuccessBehavior = decodeMap(success)
	out.Metrics = decodeMap(metrics)
	return &out, nil
}

func scanSpinReward(row pgx.Row) (*SpinReward, error) {
	var out SpinReward
	var display []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.FormID, &out.VariantID,
		&out.Key, &out.Label, &out.RewardType, &out.WeightBasisPoints,
		&out.StaticCode, &out.CouponPoolID, &out.SuccessStepKey,
		&out.FlowBranchKey, &display, &out.Status, &out.SortOrder,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.Display = decodeMap(display)
	return &out, nil
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	if out == nil {
		out = map[string]any{}
	}
	return out
}

func nonNilMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	return in
}
