// SPDX-License-Identifier: AGPL-3.0-only
//
// settings.go is the management surface for the two tables the send-execution
// gates read: channel_sender_profiles (per-tenant, per-channel sender readiness)
// and channel_smart_sending_policies (per-channel recency-dedup windows). Before
// this, both tables were schema-only, so non-email channels could never become
// 'ready' and Smart Sending could never be configured.
package omnichannel

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type SenderProfile struct {
	ID           string         `json:"id,omitempty"`
	Channel      string         `json:"channel"`
	Provider     string         `json:"provider,omitempty"`
	SenderRef    string         `json:"sender_ref,omitempty"`
	DisplayName  string         `json:"display_name,omitempty"`
	Country      string         `json:"country,omitempty"`
	Status       string         `json:"status,omitempty"`
	Capabilities map[string]any `json:"capabilities,omitempty"`
	Limits       map[string]any `json:"limits,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	CreatedAt    time.Time      `json:"created_at,omitempty"`
	UpdatedAt    time.Time      `json:"updated_at,omitempty"`
}

type SmartSendingPolicy struct {
	ID            string         `json:"id,omitempty"`
	Name          string         `json:"name"`
	Channel       string         `json:"channel"`
	Status        string         `json:"status,omitempty"`
	WindowSeconds int            `json:"window_seconds"`
	Scope         string         `json:"scope,omitempty"`
	Settings      map[string]any `json:"settings,omitempty"`
	CreatedAt     time.Time      `json:"created_at,omitempty"`
	UpdatedAt     time.Time      `json:"updated_at,omitempty"`
}

var (
	senderChannels = []string{"email", "sms", "whatsapp", "rcs", "push"}
	senderStatuses = []string{"not_configured", "draft", "pending", "ready", "rejected", "suspended", "disabled"}
	policyChannels = []string{"email", "sms", "whatsapp", "rcs", "push", "all"}
	policyStatuses = []string{"draft", "active", "paused", "archived"}
	policyScopes   = []string{"campaigns", "flows", "campaigns_and_flows"}
)

func (r *Repo) ListSenderProfiles(ctx context.Context, tenantID string) ([]SenderProfile, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, channel, provider, sender_ref, display_name, country, status,
       capabilities, limits, metadata, created_at, updated_at
FROM channel_sender_profiles
WHERE tenant_id = $1::uuid
ORDER BY channel, provider, sender_ref`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SenderProfile{}
	for rows.Next() {
		var p SenderProfile
		var caps, limits, meta []byte
		if err := rows.Scan(&p.ID, &p.Channel, &p.Provider, &p.SenderRef, &p.DisplayName,
			&p.Country, &p.Status, &caps, &limits, &meta, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.Capabilities = decodeMap(caps)
		p.Limits = decodeMap(limits)
		p.Metadata = decodeMap(meta)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// UpsertSenderProfile creates or updates a sender profile keyed by
// (channel, provider, sender_ref). This is how a tenant marks an SMS/WhatsApp/
// RCS/push channel 'ready' so the dispatch readiness gate lets it through.
func (r *Repo) UpsertSenderProfile(ctx context.Context, tenantID string, in SenderProfile) (*SenderProfile, error) {
	if !allowedString(in.Channel, senderChannels) {
		return nil, errInvalid("channel")
	}
	if in.Status == "" {
		in.Status = "not_configured"
	}
	if !allowedString(in.Status, senderStatuses) {
		return nil, errInvalid("status")
	}
	caps, _ := json.Marshal(orEmpty(in.Capabilities))
	limits, _ := json.Marshal(orEmpty(in.Limits))
	meta, _ := json.Marshal(orEmpty(in.Metadata))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO channel_sender_profiles
    (tenant_id, channel, provider, sender_ref, display_name, country, status,
     capabilities, limits, metadata)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
ON CONFLICT (tenant_id, channel, provider, sender_ref) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    country      = EXCLUDED.country,
    status       = EXCLUDED.status,
    capabilities = EXCLUDED.capabilities,
    limits       = EXCLUDED.limits,
    metadata     = EXCLUDED.metadata,
    updated_at   = now()
RETURNING id::text, channel, provider, sender_ref, display_name, country, status,
          capabilities, limits, metadata, created_at, updated_at`,
		tenantID, in.Channel, defaulted(in.Provider, "postwave"), in.SenderRef,
		in.DisplayName, in.Country, in.Status, string(caps), string(limits), string(meta))
	var p SenderProfile
	var rc, rl, rm []byte
	if err := row.Scan(&p.ID, &p.Channel, &p.Provider, &p.SenderRef, &p.DisplayName,
		&p.Country, &p.Status, &rc, &rl, &rm, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	p.Capabilities, p.Limits, p.Metadata = decodeMap(rc), decodeMap(rl), decodeMap(rm)
	return &p, tx.Commit(ctx)
}

func (r *Repo) DeleteSenderProfile(ctx context.Context, tenantID, id string) error {
	return r.deleteByID(ctx, tenantID, "channel_sender_profiles", id)
}

func (r *Repo) ListSmartSendingPolicies(ctx context.Context, tenantID string) ([]SmartSendingPolicy, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, channel, status, window_seconds, scope, settings, created_at, updated_at
FROM channel_smart_sending_policies
WHERE tenant_id = $1::uuid
ORDER BY channel, name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SmartSendingPolicy{}
	for rows.Next() {
		var p SmartSendingPolicy
		var settings []byte
		if err := rows.Scan(&p.ID, &p.Name, &p.Channel, &p.Status, &p.WindowSeconds,
			&p.Scope, &settings, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.Settings = decodeMap(settings)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// UpsertSmartSendingPolicy creates or updates a Smart-Sending window keyed by
// (channel, name).
func (r *Repo) UpsertSmartSendingPolicy(ctx context.Context, tenantID string, in SmartSendingPolicy) (*SmartSendingPolicy, error) {
	if in.Name == "" {
		return nil, errInvalid("name")
	}
	if !allowedString(in.Channel, policyChannels) {
		return nil, errInvalid("channel")
	}
	if in.Status == "" {
		in.Status = "active"
	}
	if !allowedString(in.Status, policyStatuses) {
		return nil, errInvalid("status")
	}
	if in.Scope == "" {
		in.Scope = "campaigns_and_flows"
	}
	if !allowedString(in.Scope, policyScopes) {
		return nil, errInvalid("scope")
	}
	if in.WindowSeconds < 0 {
		return nil, errInvalid("window_seconds")
	}
	settings, _ := json.Marshal(orEmpty(in.Settings))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO channel_smart_sending_policies
    (tenant_id, name, channel, status, window_seconds, scope, settings)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (tenant_id, channel, name) DO UPDATE SET
    status         = EXCLUDED.status,
    window_seconds = EXCLUDED.window_seconds,
    scope          = EXCLUDED.scope,
    settings       = EXCLUDED.settings,
    updated_at     = now()
RETURNING id::text, name, channel, status, window_seconds, scope, settings, created_at, updated_at`,
		tenantID, in.Name, in.Channel, in.Status, in.WindowSeconds, in.Scope, string(settings))
	var p SmartSendingPolicy
	var rs []byte
	if err := row.Scan(&p.ID, &p.Name, &p.Channel, &p.Status, &p.WindowSeconds,
		&p.Scope, &rs, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	p.Settings = decodeMap(rs)
	return &p, tx.Commit(ctx)
}

func (r *Repo) DeleteSmartSendingPolicy(ctx context.Context, tenantID, id string) error {
	return r.deleteByID(ctx, tenantID, "channel_smart_sending_policies", id)
}

// deleteByID deletes a tenant-scoped row. table is a fixed internal literal
// (never user input), so the interpolation is safe.
func (r *Repo) deleteByID(ctx context.Context, tenantID, table, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func errInvalid(field string) error {
	return fmt.Errorf("%w: %s", ErrInvalidInput, field)
}
