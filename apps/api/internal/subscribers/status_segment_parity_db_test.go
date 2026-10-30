// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

type statusParityFixture struct {
	key             string
	engineStatus    string
	lifecycleStatus string
}

// TestDirectoryStatusChipsMatchSegmentPreview_DB pins the status vocabulary
// boundary shared by the Subscribers Directory and segment previews. The
// fixture deliberately disagrees across subscribers.status (delivery-engine
// state) and subscribers.mailchimp_status (lifecycle state), so accidentally
// compiling or filtering against the wrong column cannot produce a false
// positive.
func TestDirectoryStatusChipsMatchSegmentPreview_DB(t *testing.T) {
	pool := newStatusParityTestPool(t)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedStatusParityTenant(t, ctx, pool, tenantID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		tx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("cleanup tenant scope: %v", cleanupErr)
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		if _, cleanupErr = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup tenant: %v", cleanupErr)
			return
		}
		if cleanupErr = tx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("cleanup commit: %v", cleanupErr)
		}
	})

	fixtures := []statusParityFixture{
		{key: "subscribed", engineStatus: StatusBlocklisted, lifecycleStatus: "subscribed"},
		{key: "unsubscribed", engineStatus: StatusEnabled, lifecycleStatus: "unsubscribed"},
		{key: "disabled", engineStatus: StatusDisabled, lifecycleStatus: "pending"},
		{key: "unconfirmed", engineStatus: StatusUnconfirmed, lifecycleStatus: "transactional"},
		{key: "bounced", engineStatus: StatusEnabled, lifecycleStatus: "cleaned"},
	}
	fixtureIDs := seedStatusParitySubscribers(t, ctx, pool, tenantID, fixtures)

	tests := []struct {
		chip     string
		astField string
		astValue string
		wantKey  string
	}{
		{chip: "subscribed", astField: "mailchimp_status", astValue: "subscribed", wantKey: "subscribed"},
		{chip: "unsubscribed", astField: "mailchimp_status", astValue: "unsubscribed", wantKey: "unsubscribed"},
		{chip: "disabled", astField: "status", astValue: StatusDisabled, wantKey: "disabled"},
		{chip: "unconfirmed", astField: "status", astValue: StatusUnconfirmed, wantKey: "unconfirmed"},
		// The Directory's legacy bounced chip is the lifecycle alias for
		// Mailchimp's canonical cleaned value.
		{chip: "bounced", astField: "mailchimp_status", astValue: "cleaned", wantKey: "bounced"},
	}

	repo := &Repo{Pool: pool}
	for _, tc := range tests {
		t.Run(tc.chip, func(t *testing.T) {
			wantIDs := []string{fixtureIDs[tc.wantKey]}

			directory, listErr := repo.ListWithOptions(ctx, tenantID, ListOptions{
				Status:  tc.chip,
				Sort:    "email",
				Order:   "ASC",
				Page:    1,
				PerPage: 100,
			})
			if listErr != nil {
				t.Fatalf("Directory ListWithOptions(%q): %v", tc.chip, listErr)
			}
			directoryIDs := make([]string, 0, len(directory.Items))
			for _, subscriber := range directory.Items {
				directoryIDs = append(directoryIDs, subscriber.ID)
			}
			sort.Strings(directoryIDs)
			sort.Strings(wantIDs)
			if directory.Total != len(wantIDs) || !reflect.DeepEqual(directoryIDs, wantIDs) {
				t.Fatalf("Directory chip %q membership = %v total=%d; want %v total=%d",
					tc.chip, directoryIDs, directory.Total, wantIDs, len(wantIDs))
			}

			ast, marshalErr := json.Marshal(map[string]any{
				"op":         "condition",
				"field":      tc.astField,
				"comparator": "equals",
				"value":      tc.astValue,
			})
			if marshalErr != nil {
				t.Fatalf("marshal canonical AST: %v", marshalErr)
			}
			segmentIDs, segmentCount := executeStatusParityAST(t, ctx, pool, tenantID, ast)
			if segmentCount != len(wantIDs) || !reflect.DeepEqual(segmentIDs, wantIDs) {
				t.Fatalf("segment AST %s=%q membership = %v count=%d; want %v count=%d",
					tc.astField, tc.astValue, segmentIDs, segmentCount, wantIDs, len(wantIDs))
			}
			if directory.Total != segmentCount || !reflect.DeepEqual(directoryIDs, segmentIDs) {
				t.Fatalf("Directory/segment parity for %q diverged: directory=%v total=%d segment=%v count=%d",
					tc.chip, directoryIDs, directory.Total, segmentIDs, segmentCount)
			}
		})
	}
}

func newStatusParityTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping Directory/segment status parity test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedStatusParityTenant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'status-parity-test', 'status-parity-' || $1::text, 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedStatusParitySubscribers(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	fixtures []statusParityFixture,
) map[string]string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("subscriber seed scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ids := make(map[string]string, len(fixtures))
	for _, fixture := range fixtures {
		var id, storedEngine, storedLifecycle string
		email := fmt.Sprintf("status-parity-%s-%s@example.test", fixture.key, tenantID)
		if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, mailchimp_status, consent_source)
VALUES ($1::uuid, $2, $3, $4, 'api')
RETURNING id::text, status, mailchimp_status`,
			tenantID, email, fixture.engineStatus, fixture.lifecycleStatus,
		).Scan(&id, &storedEngine, &storedLifecycle); err != nil {
			t.Fatalf("seed %s subscriber: %v", fixture.key, err)
		}
		if storedEngine != fixture.engineStatus || storedLifecycle != fixture.lifecycleStatus {
			t.Fatalf("seed %s was normalized unexpectedly: status=%q mailchimp_status=%q; want %q/%q",
				fixture.key, storedEngine, storedLifecycle, fixture.engineStatus, fixture.lifecycleStatus)
		}
		ids[fixture.key] = id
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber fixtures: %v", err)
	}
	return ids
}

func executeStatusParityAST(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	ast json.RawMessage,
) ([]string, int) {
	t.Helper()
	fragment, args, err := segments.CompileAST(ast)
	if err != nil {
		t.Fatalf("CompileAST(%s): %v", ast, err)
	}
	fragment = segments.ShiftPlaceholders(fragment, 1)
	queryArgs := append([]any{tenantID}, args...)
	where := `tenant_id = $1::uuid AND archived_at IS NULL AND (` + fragment + `)`

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("segment preview tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM subscribers WHERE `+where+` ORDER BY id`, queryArgs...)
	if err != nil {
		t.Fatalf("execute segment AST: %v", err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			t.Fatalf("scan segment member: %v", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate segment members: %v", err)
	}
	rows.Close()

	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE `+where, queryArgs...).Scan(&count); err != nil {
		t.Fatalf("count segment AST: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit segment preview read: %v", err)
	}
	sort.Strings(ids)
	return ids, count
}
