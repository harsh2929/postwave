// Package profilestore is the Postgres-backed VoiceProfile read/write store.
package profilestore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/profile"
)

// Store is the public type.
type Store struct {
	Pool *pgxpool.Pool
}

// New constructs a Store.
func New(p *pgxpool.Pool) (*Store, error) {
	if p == nil {
		return nil, errors.New("nil pgx pool")
	}
	return &Store{Pool: p}, nil
}

// SaveProfile upserts the per-tenant VoiceProfile row.
func (s *Store) SaveProfile(ctx context.Context, p profile.VoiceProfile) error {
	tx, err := s.beginTenant(ctx, p.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	pb, err := json.Marshal(p)
	if err != nil {
		return err
	}
	sb, _ := json.Marshal(p.RepresentativeSamples)
	_, err = tx.Exec(ctx, `
		INSERT INTO voice_profiles (tenant_id, profile, built_at, representative_samples)
		VALUES ($1::uuid, $2::jsonb, $3, $4::jsonb)
		ON CONFLICT (tenant_id) DO UPDATE SET
			profile = EXCLUDED.profile,
			built_at = EXCLUDED.built_at,
			representative_samples = EXCLUDED.representative_samples,
			updated_at = now()
	`, p.TenantID, string(pb), time.Now().UTC(), string(sb))
	if err != nil {
		return fmt.Errorf("upsert voice_profile: %w", err)
	}
	return tx.Commit(ctx)
}

// GetProfile reads the profile JSON back.
func (s *Store) GetProfile(ctx context.Context, tenantID string) (profile.VoiceProfile, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return profile.VoiceProfile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	err = tx.QueryRow(ctx,
		`SELECT profile FROM voice_profiles WHERE tenant_id = $1::uuid`, tenantID,
	).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return profile.VoiceProfile{}, ErrNotFound
	}
	if err != nil {
		return profile.VoiceProfile{}, err
	}
	var p profile.VoiceProfile
	if err := json.Unmarshal(raw, &p); err != nil {
		return profile.VoiceProfile{}, fmt.Errorf("decode profile: %w", err)
	}
	return p, tx.Commit(ctx)
}

func (s *Store) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("tenant id required")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// ErrNotFound is returned when no row exists for the tenant.
var ErrNotFound = errors.New("profilestore: not found")
