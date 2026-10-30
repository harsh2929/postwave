package omnichannel

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
	ErrNotFound     = errors.New("omnichannel: not found")
	ErrInvalidInput = errors.New("omnichannel: invalid input")
)

type Repo struct {
	Pool *db.Pool
}

func (r *Repo) ListCampaigns(ctx context.Context, tenantID, status string) ([]OmniCampaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, status, objective, audience_strategy,
       schedule, send_strategy, recipient_snapshot_mode,
       COALESCE(source_campaign_id::text, ''), created_at, updated_at
FROM omni_campaigns
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
ORDER BY updated_at DESC
LIMIT 200`, tenantID, strings.TrimSpace(status))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OmniCampaign{}
	for rows.Next() {
		item, err := scanCampaign(rows)
		if err != nil {
			return nil, err
		}
		paths, err := listPathsTx(ctx, tx, tenantID, item.ID)
		if err != nil {
			return nil, err
		}
		item.Paths = paths
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

func (r *Repo) GetCampaign(ctx context.Context, tenantID, id string) (*OmniCampaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, status, objective, audience_strategy,
       schedule, send_strategy, recipient_snapshot_mode,
       COALESCE(source_campaign_id::text, ''), created_at, updated_at
FROM omni_campaigns
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1`, tenantID, id)
	out, err := scanCampaign(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	out.Paths, err = listPathsTx(ctx, tx, tenantID, out.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) CreateCampaign(ctx context.Context, tenantID string, in OmniCampaign) (*OmniCampaign, error) {
	normalizeCampaign(&in)
	if requestsRuntimeState(in) {
		return nil, ErrOmnichannelRuntimeUnavailable
	}
	if validation := Validate(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidInput, strings.Join(validation.Errors, "; "))
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	audience, _ := json.Marshal(in.AudienceStrategy)
	schedule, _ := json.Marshal(in.Schedule)
	sendStrategy, _ := json.Marshal(in.SendStrategy)
	row := tx.QueryRow(ctx, `
INSERT INTO omni_campaigns
    (tenant_id, name, status, objective, audience_strategy, schedule,
     send_strategy, recipient_snapshot_mode, source_campaign_id)
VALUES
    ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, NULLIF($9, '')::uuid)
RETURNING id::text, tenant_id::text, name, status, objective, audience_strategy,
       schedule, send_strategy, recipient_snapshot_mode,
       COALESCE(source_campaign_id::text, ''), created_at, updated_at`,
		tenantID, in.Name, in.Status, in.Objective, string(audience), string(schedule),
		string(sendStrategy), in.RecipientSnapshotMode, in.SourceCampaignID)
	out, err := scanCampaign(row)
	if err != nil {
		return nil, err
	}
	if err := replacePathsTx(ctx, tx, tenantID, out.ID, in.Paths); err != nil {
		return nil, err
	}
	out.Paths, err = listPathsTx(ctx, tx, tenantID, out.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func replacePathsTx(ctx context.Context, tx pgx.Tx, tenantID, campaignID string, paths []CampaignPath) error {
	if _, err := tx.Exec(ctx, `DELETE FROM omni_campaign_paths WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`, tenantID, campaignID); err != nil {
		return err
	}
	for i := range paths {
		path := paths[i]
		normalizePath(&path, i)
		audience, _ := json.Marshal(path.Audience)
		settings, _ := json.Marshal(path.Settings)
		if _, err := tx.Exec(ctx, `
INSERT INTO omni_campaign_paths
    (tenant_id, campaign_id, path_key, name, channel, status, audience,
     message_template_id, fallback_path_key, traffic_weight_basis_points,
     sequence, settings)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb,
     NULLIF($8, '')::uuid, $9, $10, $11, $12::jsonb)`,
			tenantID, campaignID, path.PathKey, path.Name, path.Channel,
			path.Status, string(audience), path.MessageTemplateID,
			path.FallbackPathKey, path.TrafficWeightBasisPoints, path.Sequence,
			string(settings)); err != nil {
			return err
		}
	}
	return nil
}

func listPathsTx(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) ([]CampaignPath, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, campaign_id::text, path_key, name, channel,
       status, audience, COALESCE(message_template_id::text, ''),
       fallback_path_key, traffic_weight_basis_points, sequence, settings,
       created_at, updated_at
FROM omni_campaign_paths
WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
ORDER BY sequence ASC, path_key ASC`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CampaignPath{}
	for rows.Next() {
		item, err := scanPath(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	return out, rows.Err()
}

func scanCampaign(row pgx.Row) (*OmniCampaign, error) {
	var out OmniCampaign
	var audience, schedule, sendStrategy []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Status,
		&out.Objective, &audience, &schedule, &sendStrategy,
		&out.RecipientSnapshotMode, &out.SourceCampaignID,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.AudienceStrategy = decodeMap(audience)
	out.Schedule = decodeMap(schedule)
	out.SendStrategy = decodeMap(sendStrategy)
	return &out, nil
}

func scanPath(row pgx.Row) (*CampaignPath, error) {
	var out CampaignPath
	var audience, settings []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.CampaignID, &out.PathKey,
		&out.Name, &out.Channel, &out.Status, &audience,
		&out.MessageTemplateID, &out.FallbackPathKey,
		&out.TrafficWeightBasisPoints, &out.Sequence, &settings,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.Audience = decodeMap(audience)
	out.Settings = decodeMap(settings)
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
