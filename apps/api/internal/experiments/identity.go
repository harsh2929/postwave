// SPDX-License-Identifier: AGPL-3.0-only
package experiments

import (
	"context"
	"errors"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The identity every variant system can register into.
//
// The registry above catalogues nine systems and MEASURES what each records.
// The measurement is bleak on purpose: hypothesis 0 of 9, owner 0 of 9, object
// version 0 of 9. A registry that only counts is a document; this is the place
// the missing facts go.
//
// A SIDECAR rather than a migration. Rewriting nine live experiment schemas
// onto a shared identity is nine cutovers, and it would deliver the same fact
// this delivers now — that somebody wrote down what the test was for. Each
// system keeps its store and writes one row keyed to its own record.
//
// The asymmetry worth stating: a metric can be inferred from the data later and
// an owner from the audit log, but a HYPOTHESIS exists only if it was written
// before the result. That is why this is worth having even while the nine
// systems remain disjoint.

// ErrUnknownSystem is returned for a system_key the registry does not know.
//
// Refused rather than stored, because an identity table that accepts arbitrary
// keys accumulates rows for systems nobody can find, and then reports coverage
// that is not real — which is worse than reporting none.
var ErrUnknownSystem = errors.New("experiments: unknown system key")

// Identity is what an experiment was for.
type Identity struct {
	SystemKey      string `json:"system_key"`
	ExternalID     string `json:"external_id"`
	Hypothesis     string `json:"hypothesis,omitempty"`
	OwnerUserID    string `json:"owner_user_id,omitempty"`
	ObjectVersion  string `json:"object_version,omitempty"`
	MetricID       string `json:"metric_id,omitempty"`
	MetricVersion  string `json:"metric_version,omitempty"`
	StoppingPolicy string `json:"stopping_policy,omitempty"`
}

// KnownSystem reports whether the registry knows this key.
func KnownSystem(key string) bool {
	for _, s := range Systems {
		if s.Key == key {
			return true
		}
	}
	return false
}

type IdentityRepo struct{ Pool *db.Pool }

// Register records or updates one experiment's identity.
//
// UPSERT rather than insert-only: an experiment is often registered before its
// metric or stopping policy is chosen, and forcing a delete-and-recreate would
// lose the created_at that says when somebody first wrote the hypothesis down.
//
// Empty fields do NOT overwrite stored values. Registering again to add an owner
// must not erase a hypothesis recorded earlier — a partial update that silently
// blanks the field this table exists to hold would be worse than refusing the
// write.
func (r *IdentityRepo) Register(ctx context.Context, tenantID string, in Identity) error {
	in.SystemKey = strings.TrimSpace(in.SystemKey)
	in.ExternalID = strings.TrimSpace(in.ExternalID)
	if !KnownSystem(in.SystemKey) {
		return ErrUnknownSystem
	}
	if in.ExternalID == "" {
		return errors.New("experiments: external_id required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
INSERT INTO experiment_identities
  (tenant_id, system_key, external_id, hypothesis, owner_user_id,
   object_version, metric_id, metric_version, stopping_policy)
VALUES ($1::uuid, $2, $3, NULLIF($4,''), NULLIF($5,'')::uuid,
        NULLIF($6,''), NULLIF($7,''), NULLIF($8,''), NULLIF($9,''))
ON CONFLICT (tenant_id, system_key, external_id) DO UPDATE SET
  hypothesis      = COALESCE(NULLIF(EXCLUDED.hypothesis, ''), experiment_identities.hypothesis),
  owner_user_id   = COALESCE(EXCLUDED.owner_user_id, experiment_identities.owner_user_id),
  object_version  = COALESCE(NULLIF(EXCLUDED.object_version, ''), experiment_identities.object_version),
  metric_id       = COALESCE(NULLIF(EXCLUDED.metric_id, ''), experiment_identities.metric_id),
  metric_version  = COALESCE(NULLIF(EXCLUDED.metric_version, ''), experiment_identities.metric_version),
  stopping_policy = COALESCE(NULLIF(EXCLUDED.stopping_policy, ''), experiment_identities.stopping_policy),
  updated_at      = now()`,
		tenantID, in.SystemKey, in.ExternalID, in.Hypothesis, in.OwnerUserID,
		in.ObjectVersion, in.MetricID, in.MetricVersion, in.StoppingPolicy); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// List returns every registered identity for a tenant.
func (r *IdentityRepo) List(ctx context.Context, tenantID string) ([]Identity, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT system_key, external_id, COALESCE(hypothesis,''),
       COALESCE(owner_user_id::text,''), COALESCE(object_version,''),
       COALESCE(metric_id,''), COALESCE(metric_version,''),
       COALESCE(stopping_policy,'')
  FROM experiment_identities
 WHERE tenant_id = $1::uuid
 ORDER BY system_key, external_id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Identity{}
	for rows.Next() {
		var i Identity
		if err := rows.Scan(&i.SystemKey, &i.ExternalID, &i.Hypothesis,
			&i.OwnerUserID, &i.ObjectVersion, &i.MetricID, &i.MetricVersion,
			&i.StoppingPolicy); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
