// SPDX-License-Identifier: AGPL-3.0-only
//
// Package cost owns the append-only billable-work ledger. Every chargeable
// unit of work the API performs (a send, an AI generation, a render) lands
// here with a tenant id, an optional api_key id, an actor type, and the
// cents it cost. Aggregates back the way out via /api/v1/costs.
package cost

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Kind enumerates the chargeable verbs. The DB CHECK constraint mirrors this
// list — keep them in sync.
type Kind string

const (
	KindSend         Kind = "send"
	KindAIGeneration Kind = "ai_generation"
	KindAIDiagnostic Kind = "ai_diagnostic"
	KindRendering    Kind = "rendering"
	KindStorage      Kind = "storage"
	KindMigration    Kind = "migration"
	KindOther        Kind = "other"
)

// Entry is one row in the cost ledger.
type Entry struct {
	ID        int64   `json:"id"`
	TenantID  string  `json:"tenantId"`
	APIKeyID  *string `json:"apiKeyId,omitempty"`
	ActorType *string `json:"actorType,omitempty"`
	Kind      Kind    `json:"kind"`
	Cents     int     `json:"cents"`
	// Microcents is the precise cost (1 cent = 10,000 microcents). Cents is a
	// rounded display value derived from it. Record fills Cents from Microcents
	// when only Microcents is set, so callers can supply either.
	Microcents int64          `json:"microcents"`
	Quantity   int            `json:"quantity"`
	At         time.Time      `json:"at"`
	Metadata   map[string]any `json:"metadata"`
}

// Recorder is the surface handlers use to push entries.
type Recorder interface {
	Record(ctx context.Context, e *Entry) error
}

// Repo is the pgx-backed Recorder + the read side used by the aggregator.
type Repo struct {
	Pool *db.Pool
}

// Record inserts a single ledger row. Tenant id is required; api_key_id and
// actor_type are optional.
func (r *Repo) Record(ctx context.Context, e *Entry) error {
	if e == nil || e.TenantID == "" {
		return errors.New("cost: tenant id required")
	}
	if e.Quantity == 0 {
		e.Quantity = 1
	}
	if e.Metadata == nil {
		e.Metadata = map[string]any{}
	}
	// Accept either unit. When a caller supplies microcents (the precise path),
	// derive the rounded display cents from it. When a caller supplies only
	// cents (legacy), keep microcents in sync so the two never disagree.
	if e.Microcents != 0 && e.Cents == 0 {
		e.Cents = CentsFromMicrocents(e.Microcents)
	} else if e.Microcents == 0 && e.Cents != 0 {
		e.Microcents = int64(e.Cents) * 10000
	}
	tx, err := db.WithTenant(ctx, r.Pool, e.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var apiKeyID, actorType any
	if e.APIKeyID != nil && *e.APIKeyID != "" {
		apiKeyID = *e.APIKeyID
	}
	if e.ActorType != nil && *e.ActorType != "" {
		actorType = *e.ActorType
	}

	if err := tx.QueryRow(ctx, `
INSERT INTO cost_ledger
    (tenant_id, api_key_id, actor_type, kind, cents, microcents, quantity, metadata)
VALUES
    ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, at`,
		e.TenantID, apiKeyID, actorType, string(e.Kind),
		e.Cents, e.Microcents, e.Quantity, e.Metadata,
	).Scan(&e.ID, &e.At); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordFromContext is the convenience helper most call sites use. It pulls
// tenant + api_key_id + actor_type out of the request context and writes the
// row. The running per-request total is also accumulated for the cost-header
// middleware.
func RecordFromContext(ctx context.Context, rec Recorder, kind Kind, cents int, qty int, meta map[string]any) error {
	t, ok := middleware.TenantFromContext(ctx)
	if !ok {
		return errors.New("cost: no tenant on context")
	}
	at, _ := middleware.ActorFromContext(ctx)
	keyID := middleware.APIKeyIDFromContext(ctx)

	e := &Entry{
		TenantID: t.ID,
		Kind:     kind,
		Cents:    cents,
		Quantity: qty,
		Metadata: meta,
	}
	if keyID != "" {
		e.APIKeyID = &keyID
	}
	if at != "" {
		e.ActorType = &at
	}
	if err := rec.Record(ctx, e); err != nil {
		return err
	}
	addRunningTotal(ctx, cents)
	return nil
}

// RecordTokensFromContext records the cost of an LLM generation, priced from the
// model + token counts in microcents. This replaces the hardcoded cents=0 that
// every AI call used to record.
func RecordTokensFromContext(ctx context.Context, rec Recorder, kind Kind, p Pricing, model string, inputTokens, outputTokens int, meta map[string]any) error {
	if meta == nil {
		meta = map[string]any{}
	}
	meta["model"] = model
	meta["input_tokens"] = inputTokens
	meta["output_tokens"] = outputTokens
	mc := p.MicrocentsForTokens(model, inputTokens, outputTokens)
	return recordMicroFromContext(ctx, rec, kind, mc, 1, meta)
}

// RecordSends records the cost of delivering n emails for an explicit tenant,
// priced in microcents. Use this on paths that are NOT request-scoped (the
// campaign queue runs from a scheduler and an approval callback too, where no
// tenant rides on the context).
func RecordSends(ctx context.Context, rec Recorder, p Pricing, tenantID string, n int, meta map[string]any) error {
	if rec == nil || tenantID == "" || n <= 0 {
		return nil
	}
	if meta == nil {
		meta = map[string]any{}
	}
	return rec.Record(ctx, &Entry{
		TenantID:   tenantID,
		Kind:       KindSend,
		Microcents: p.MicrocentsForSends(n),
		Quantity:   n,
		Metadata:   meta,
	})
}

// RecordSendsFromContext records the cost of delivering n emails, priced in
// microcents. Called once per queued batch (not per email) — a batch is large
// enough that its cents value is meaningful, and per-email rows would flood the
// ledger.
func RecordSendsFromContext(ctx context.Context, rec Recorder, p Pricing, n int, meta map[string]any) error {
	if n <= 0 {
		return nil
	}
	return recordMicroFromContext(ctx, rec, KindSend, p.MicrocentsForSends(n), n, meta)
}

func recordMicroFromContext(ctx context.Context, rec Recorder, kind Kind, microcents int64, qty int, meta map[string]any) error {
	t, ok := middleware.TenantFromContext(ctx)
	if !ok {
		return errors.New("cost: no tenant on context")
	}
	at, _ := middleware.ActorFromContext(ctx)
	keyID := middleware.APIKeyIDFromContext(ctx)
	e := &Entry{
		TenantID:   t.ID,
		Kind:       kind,
		Microcents: microcents,
		Quantity:   qty,
		Metadata:   meta,
	}
	if keyID != "" {
		e.APIKeyID = &keyID
	}
	if at != "" {
		e.ActorType = &at
	}
	if err := rec.Record(ctx, e); err != nil {
		return err
	}
	addRunningTotal(ctx, CentsFromMicrocents(microcents))
	return nil
}

// runningTotal lets the cost middleware tally per-request cents without
// threading a writer all the way through every handler. It lives on the
// context as an *int64 the middleware allocates on entry.
type runningTotalCtxKey struct{}

type runningTotal struct {
	mu    sync.Mutex
	cents int64
}

// WithRunningTotal returns ctx augmented with a fresh running-total cell.
// The cost middleware calls this; handlers don't need to.
func WithRunningTotal(ctx context.Context) context.Context {
	return context.WithValue(ctx, runningTotalCtxKey{}, &runningTotal{})
}

// RunningTotalCents reads the running total out of ctx. Returns 0 if no cell
// is attached.
func RunningTotalCents(ctx context.Context) int64 {
	rt, ok := ctx.Value(runningTotalCtxKey{}).(*runningTotal)
	if !ok {
		return 0
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.cents
}

func addRunningTotal(ctx context.Context, cents int) {
	rt, ok := ctx.Value(runningTotalCtxKey{}).(*runningTotal)
	if !ok {
		return
	}
	rt.mu.Lock()
	rt.cents += int64(cents)
	rt.mu.Unlock()
}
