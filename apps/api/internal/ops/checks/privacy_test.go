// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

// seedEraseRow inserts a sar_bundles row of the given kind with the given
// rows_deleted, and returns the tenant it belongs to (cleaned up by t.Cleanup).
func seedEraseRow(t *testing.T, env *ops.Env, rowsDeleted int64) string {
	t.Helper()
	ctx := context.Background()

	var tenantID string
	if err := env.Pool.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier)
		VALUES ('erasechk-' || substr(md5(random()::text), 1, 8), 'Erase Check', 'studio')
		RETURNING id::text`).Scan(&tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := env.Pool.Exec(ctx, `
		INSERT INTO sar_bundles
		  (tenant_id, subscriber_email, status, kind, rows_deleted, bundle, requested_at)
		VALUES ($1::uuid, 'erased+deadbeef@erased.invalid', 'ready', 'erase', $2, '{}'::jsonb, now())`,
		tenantID, rowsDeleted); err != nil {
		t.Fatalf("seed sar_bundles: %v", err)
	}
	t.Cleanup(func() {
		c := context.Background()
		_, _ = env.Pool.Exec(c, `DELETE FROM sar_bundles WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = env.Pool.Exec(c, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return tenantID
}

// An erasure marked fulfilled that deleted nothing is the Art. 17 breach this
// check exists to catch — and it is silent, because the operator saw a success
// message. It must be RED.
func TestProbeErasureIntegrity_ZeroRowErasureIsRed(t *testing.T) {
	env := &ops.Env{Pool: testPool(t)}
	seedEraseRow(t, env, 0)

	st, detail, err := probeErasureIntegrity(context.Background(), env)
	if err != nil {
		t.Fatal(err)
	}
	if st != ops.StatusRed {
		t.Fatalf("an erasure that deleted zero rows must be RED, got %q (%s)", st, detail)
	}
	if !strings.Contains(detail, "ZERO rows") {
		t.Fatalf("the detail must name the failure an operator has to act on, got %q", detail)
	}
}

func TestProbeErasureIntegrity_RealErasureIsOK(t *testing.T) {
	env := &ops.Env{Pool: testPool(t)}
	seedEraseRow(t, env, 7)

	st, detail, err := probeErasureIntegrity(context.Background(), env)
	if err != nil {
		t.Fatal(err)
	}
	if st != ops.StatusOK {
		t.Fatalf("an erasure that deleted rows is OK, got %q (%s)", st, detail)
	}
}
