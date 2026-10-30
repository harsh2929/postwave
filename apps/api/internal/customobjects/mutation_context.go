// SPDX-License-Identifier: AGPL-3.0-only

package customobjects

import (
	"context"
	"errors"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type mutationAuditMetaContextKey struct{}

// withMutationAuditMeta carries request attribution from the HTTP boundary to
// the transaction that performs the write. Keeping it in context preserves the
// Store interface used by workers/tests while still making the Postgres path
// fail closed if a production mutation cannot be audited atomically.
func withMutationAuditMeta(ctx context.Context, meta db.AuditMeta) context.Context {
	return context.WithValue(ctx, mutationAuditMetaContextKey{}, meta)
}

func mutationAuditMeta(ctx context.Context, tenantID string) (db.AuditMeta, error) {
	meta, ok := ctx.Value(mutationAuditMetaContextKey{}).(db.AuditMeta)
	if !ok || meta.TenantID == "" || meta.TenantID != tenantID {
		return db.AuditMeta{}, errors.New("customobjects: mutation audit attribution missing")
	}
	return meta, nil
}
