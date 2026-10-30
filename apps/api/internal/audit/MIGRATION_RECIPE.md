# audit.Emit + MutatingAspect — migration recipe

Phase 1a (cross-cutting `p1-audit-emit-helper`) ships two new
primitives that replace the four-step `audit_log` boilerplate
scattered across handlers, workers, and service code. This doc is
the recipe Phase 1b will follow when migrating call-sites; it also
serves as the reference for any net-new handler that needs to emit
an audit row.

## What changed

Before — every handler that wanted a typed audit row repeated this
dance, with subtle drift across packages (some forgot `Commit`,
some used the request `ctx` and lost rows when the client
disconnected mid-200):

```go
meta := middleware.AuditMetaFromRequest(r)
tx, err := db.WithTenant(ctx, pool, tenant.ID)
if err != nil { return err }
defer tx.Rollback(ctx)
if err := db.Audit(ctx, tx, meta, "subscriber.create", "subscriber", sub.ID, map[string]any{
    "after": sub,
}); err != nil {
    return err
}
_ = tx.Commit(ctx)
```

After — one call, fresh `bgCtx` for the write, canonical metadata
shape, redaction hook always applied:

```go
audit.EmitOrLog(ctx, pool, "subscriber.create", "subscriber", sub.ID,
    nil /* before */, sub /* after */, nil /* metadata */)
```

Or, for a chi-routed mutation that maps 1:1 to one audit row,
register `MutatingAspect` on the route and call `AuditAttach` from
inside the handler when the post-state is known:

```go
// router wiring (one-time)
r.With(middleware.MutatingAspect(pool, "subscriber.create", "subscriber")).
    Post("/subscribers", createSubscriber)

// handler body
func createSubscriber(w http.ResponseWriter, r *http.Request) {
    sub := /* ... insert ... */
    ctx := middleware.AuditAttach(r.Context(), sub.ID, nil /* before */, sub, nil)
    _ = ctx // attached on the holder; aspect harvests on the way out
    writeJSON(w, 201, sub)
}
```

## API surface

### `audit.Emit(ctx, pool, action, resource, resourceID, before, after, metadata) error`

Imperative emit. Resolves tenant + actor from `ctx` (via
`middleware.AuditMetaFromContext`, with a fallback to
`TenantFromContext`/`ActorFromContext` for worker code that never
went through the request middleware chain). Returns an error so
test wiring can assert; production callers should prefer
`EmitOrLog`.

### `audit.EmitOrLog(ctx, pool, action, resource, resourceID, before, after, metadata)`

Same shape, but wraps the failure in a `slog.Warn` and returns void.
Use from handler bodies — losing an audit row should never surface
as a user-visible 500.

### `middleware.MutatingAspect(pool, action, resourceType) func(http.Handler) http.Handler`

Chi middleware. On 2xx — harvests the holder populated by
`AuditAttach` and writes one canonical audit_log row. Coexists with
the existing generic `AuditMiddleware`: a wrapped route ends up
with both a generic `http.<method>.<path>` forensics row AND a
typed `<action>` product row, which is the desired audit-2026
behaviour.

### `middleware.AuditAttach(ctx, resourceID, before, after, metadata) ctx`

Handler-side stash setter. Safe to call when no aspect wraps the
route (silent no-op) — handlers can be hoisted in/out of the
aspect without guarding every call site. Last write wins.

### `middleware.AuditSkip(ctx)`

Opt out of the aspect emit for handlers that already wrote one or
more precise audit rows themselves (bulk import, fan-out actions).
Aspect still attaches the holder so subsequent `AuditAttach` calls
don't NPE.

## Canonical metadata shape

Every aspect-emitted row (and every `Emit` call) lands with the
same metadata shape so the Compliance UI / exports / NLQ search
can parse without knowing the action label:

```json
{
  "before":  {...},        // omitted when nil
  "after":   {...},        // omitted when nil
  "context": {...}         // omitted when nil or empty map
}
```

`context` is the catch-all for action-specific fields (e.g.
`{"diff_field_count": 3, "soft_delete": true}`). Prefer this over
shoving extras at the top level — it leaves room for the canonical
keys to grow without breaking consumers.

## Migration checklist (Phase 1b)

For each handler that currently does the 4-step `db.Audit` boilerplate:

1. **Pick the shape**: aspect (one-line metadata, 2xx-only) or
   imperative (mid-handler, retries, workers). Most CRUD handlers
   fit the aspect.
2. **Register the aspect** at the route (one line in the router).
3. **Replace the boilerplate** with a single `AuditAttach` call
   inside the handler (aspect path) or a single `EmitOrLog` call
   (imperative path).
4. **Delete the local `auditMetaFromRequest` helper** if the
   package had one — `middleware.AuditMetaFromRequest` is the only
   blessed source now.
5. **Run the package's tests** to confirm the row still appears in
   the audit fixtures. The canonical metadata shape is stable, so
   any DeepEqual on `metadata` keys needs updating to
   `{"before","after","context"}`.

## Worker / queue-consumer pattern

Workers that never see an HTTP request can still call `audit.Emit`
— they just need to seed `ctx` themselves:

```go
ctx := middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
ctx = middleware.WithActor(ctx, "system", "campaign-scheduler")
audit.EmitOrLog(ctx, pool, "campaign.auto_send", "campaign", id, nil, after, nil)
```

The fallback meta path (`buildFallbackMeta` in `emit.go`) handles
this — no `r *http.Request` is needed, no synthetic
`AuditMetaFromRequest` call required.

## When NOT to use these helpers

- **Bulk operations that already emit per-item rows** — call
  `middleware.AuditSkip(ctx)` from inside the handler so the
  aspect doesn't add a redundant summary row, OR use a single
  `audit.Emit` call with `metadata={"item_count": N}` instead of
  N individual rows.
- **Audit reads** (the /api/v1/audit/list path) — those use
  `middleware.AuditMetaMiddleware` + the `AuditReadKind` enum,
  which already writes the meta-audit trail. Don't double up.
- **PII unmask events** — `db.Audit` deliberately skips the
  redaction hook for `audit.pii_unmask` actions (the trail IS the
  point). Use `db.Audit` directly there, not `audit.Emit`, so the
  intent is obvious to the next reader.
