// SPDX-License-Identifier: AGPL-3.0-only
//
// Package boot owns process bring-up — the "what runs before
// server.New / workers.Run" portion of apps/api/main.go.
//
// In the current monolith (main.go ~7100 LoC), boot-time work is
// inlined: env loading, slog wiring, pgxpool construction, OTel +
// Sentry init, KMS/secretsmanager clients, AWS config, the events
// bus, etc. Splitting this into a Deps-returning Init function gives
// us:
//
//   - A single place to look at "what does this process depend on".
//   - A clean injection point for tests (substitute a real or stub
//     Deps without spinning the full main.go).
//   - Symmetry with packages/runtime (used by services/voice +
//     services/automation), which already exposes shared db + obs
//     primitives.
//
// Migration plan: see apps/api/MIGRATION.md. The initial Init() here
// constructs only the subset of Deps that server.New currently needs
// (the deliverability_hub mount). It is intentionally a skeleton —
// main.go still drives most of boot-up today. As mount blocks move
// to server.New, the dependencies they require move into Init().
package boot

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/server"
)

// Init builds a server.Deps from process environment + dependencies.
//
// This is currently a skeleton: it returns a Deps with a logger and
// (when DATABASE_URL is set) a pool + events bus. main.go's existing
// boot sequence is the real one; this function exists so freshly
// migrated mounts can be unit-tested end-to-end and so future
// refactors have a "north star" target API.
//
// The full boot sequence — OTel tracer + meter providers, Sentry,
// AWS clients, listmonk forwarder, redis backends, etc. — is documented
// in apps/api/MIGRATION.md and migrated incrementally.
func Init(ctx context.Context) (server.Deps, error) {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	deps := server.Deps{
		Router:   chi.NewRouter(),
		Logger:   logger,
		HTTPAddr: envOr("API_HTTP_ADDR", ":9000"),
	}

	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		// Boot in degraded mode — no database. Useful for the
		// /healthz path and for skill / smoke tests that don't
		// actually exercise persistence. Real main.go fails closed
		// here; we don't, because partial boot is fine for the
		// skeleton.
		return deps, nil
	}

	pool, err := db.New(ctx, dsn)
	if err != nil {
		return server.Deps{}, errors.Join(errors.New("boot.Init: db.New failed"), err)
	}
	deps.Pool = pool
	deps.Bus = events.NewBus()
	return deps, nil
}

// envOr returns os.Getenv(key) or def when empty.
func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// Close releases the resources held by Deps. main.go drives shutdown
// today; this is the target API for once Init() owns the full chain.
func Close(deps server.Deps) {
	if deps.Pool != nil {
		deps.Pool.Close()
	}
}
