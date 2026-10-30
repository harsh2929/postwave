// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newIncidentTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed privacy incident integration test")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect to PostgreSQL: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestIncidentTransitionLockSerializesConcurrentStateWriters(t *testing.T) {
	pool := newIncidentTestPool(t)
	tenantID := uuid.NewString()
	incidentID := uuid.NewString()
	seedErasureTenant(t, pool, tenantID)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open incident seed transaction: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO privacy_incidents (id, tenant_id, status, summary)
VALUES ($1::uuid, $2::uuid, 'open', 'transition lock integration fixture')`, incidentID, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed incident: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit incident seed: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		tx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr == nil {
			_, cleanupErr = tx.Exec(cleanupCtx, `DELETE FROM privacy_incidents WHERE id = $1::uuid`, incidentID)
			if cleanupErr == nil {
				cleanupErr = tx.Commit(cleanupCtx)
			} else {
				_ = tx.Rollback(cleanupCtx)
			}
		}
		if cleanupErr != nil {
			t.Logf("cleanup incident lock fixture: %v", cleanupErr)
		}
		cleanupErasureTenant(t, pool, tenantID)
	}()

	first, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open first transition transaction: %v", err)
	}
	defer func() { _ = first.Rollback(ctx) }()
	var initial string
	if err := first.QueryRow(ctx, incidentTransitionLockSQL, incidentID, tenantID).Scan(&initial); err != nil {
		t.Fatalf("first lock: %v", err)
	}
	if initial != "open" {
		t.Fatalf("initial state = %q, want open", initial)
	}

	second, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open second transition transaction: %v", err)
	}
	defer func() { _ = second.Rollback(ctx) }()
	type lockResult struct {
		state string
		err   error
	}
	result := make(chan lockResult, 1)
	go func() {
		var state string
		err := second.QueryRow(ctx, incidentTransitionLockSQL, incidentID, tenantID).Scan(&state)
		result <- lockResult{state: state, err: err}
	}()

	select {
	case got := <-result:
		t.Fatalf("second writer bypassed row lock: %+v", got)
	case <-time.After(150 * time.Millisecond):
	}
	if _, err := first.Exec(ctx, `
UPDATE privacy_incidents
SET status = 'contained'
WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'open'`, incidentID, tenantID); err != nil {
		t.Fatalf("update locked state: %v", err)
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatalf("commit first transition: %v", err)
	}

	select {
	case got := <-result:
		if got.err != nil {
			t.Fatalf("second lock after first commit: %v", got.err)
		}
		if got.state != "contained" {
			t.Fatalf("second writer observed stale state %q, want contained", got.state)
		}
	case <-ctx.Done():
		t.Fatalf("second writer remained blocked after first commit: %v", ctx.Err())
	}
	if err := second.Rollback(ctx); err != nil {
		t.Fatalf("release second transaction: %v", err)
	}

	// Both clients formed their intent from the original "open" snapshot. The
	// second request must not reinterpret that stale intent after observing the
	// first writer's newly committed "contained" state.
	recorder := httptest.NewRecorder()
	request := incidentHandlerRequest(
		http.MethodPost,
		"/api/v1/privacy/incidents/"+incidentID+"/transition",
		`{"expected_from":"open","to":"notifications_pending","reason":"stale second operator intent"}`,
		incidentID,
		"",
	)
	request = request.WithContext(middleware.WithTenant(request.Context(), &middleware.Tenant{ID: tenantID}))
	(&IncidentsDeps{Pool: pool}).TransitionState(recorder, request)
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "stale_incident_state") {
		t.Fatalf("stale second transition status=%d body=%s, want typed 409", recorder.Code, recorder.Body.String())
	}
}

func TestIncidentInsertPreservesUnknownAndExplicitDiscoveryTimestamp(t *testing.T) {
	pool := newIncidentTestPool(t)
	tenantID := uuid.NewString()
	seedErasureTenant(t, pool, tenantID)
	defer cleanupErasureTenant(t, pool, tenantID)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open incident timestamp transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	detectedAt := time.Date(2026, 8, 19, 10, 0, 0, 0, time.UTC)
	deadline := detectedAt.Add(gdprWindow)
	insert := func(summary string, discoveredAt any) *time.Time {
		t.Helper()
		var (
			id                                   string
			storedDetectedAt, storedClockStarted time.Time
			storedDeadline, createdAt, updatedAt time.Time
			storedDiscoveredAt                   *time.Time
		)
		err := tx.QueryRow(ctx, incidentInsertSQL,
			tenantID, "investigating", detectedAt, discoveredAt, detectedAt,
			deadline, []string{}, []string{}, nil, summary, templateVersion, []string{},
		).Scan(
			&id, &storedDetectedAt, &storedDiscoveredAt, &storedClockStarted,
			&storedDeadline, &createdAt, &updatedAt,
		)
		if err != nil {
			t.Fatalf("insert incident %q: %v", summary, err)
		}
		return storedDiscoveredAt
	}

	if got := insert("unknown discovery timestamp fixture", nil); got != nil {
		t.Fatalf("omitted discovery time persisted as %v, want SQL NULL", got)
	}
	explicit := detectedAt.Add(2 * time.Minute)
	got := insert("explicit discovery timestamp fixture", explicit)
	if got == nil || !got.Equal(explicit) {
		t.Fatalf("explicit discovery time persisted as %v, want %v", got, explicit)
	}
}
