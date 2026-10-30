# Sequence Loop Engine Contract

**Status:** in-repo read/aggregation side closed (2026-06-13). The three
remaining "loop closers" require the **external send dispatcher / engine**
(the producer named in migration `0052`) to write data this repo only
_reads_. This document is the exact, implement-1:1 contract for that
engine team.

## Verified truth (why the engine must do this)

Audited 2026-06-13 across `apps/api`, `services/voice`,
`services/automation`, and `infra/migrations`:

- `sequence_funnel_events` (migration `0052`, `step_id` added `0367`,
  `variant_key` added `0398`) is the ONLY per-`(sequence, subscriber,
position)` fact table. **Nothing in this repository writes it.**
  `apps/api` has no write path; `services/voice` only reads it
  (`internal/storage/participants.go`, `activity.go`);
  `services/automation` sends via Listmonk but has no sequence/funnel
  concept.
- Inbound opens/clicks arrive at `apps/api/internal/listmonk_events`
  (`OpenedEventData` / `ClickedEventData`). They carry **only**
  `subscriber.email` + `campaign.{id,uuid}`. **No `sequence_id`, no
  `position`.**
- Neither the `campaigns` table (`0027` + every ALTER), nor
  `subscriber_events` (`0013`), nor `campaign_report_events` (`0028`)
  stores a `sequence_id` / `email_position`. **There is no in-repo join
  that maps a campaign open/click back to a sequence step.**

Consequence: per-variant funnel stats and goal-completion **cannot be
populated in-repo** without the engine attaching attribution. The
deterministic-variant analytics works the moment funnel rows exist (it
recomputes assignment), but `opened_at` / `clicked_at` on those rows, and
`sequence_enrollments` goal-completion, depend on the engine.

## What this repo already does (so you don't duplicate it)

- **Per-variant funnel aggregation** — `apps/api/internal/analytics`
  `SequenceFunnel`. For every step that has an A/B split it returns a
  `variants[]` breakdown (`reached/opened/clicked/open_rate/click_rate`
  per arm). It prefers a stamped `sequence_funnel_events.variant_key`.
  Its legacy fallback still recomputes from `subscriber_email`; that fallback
  is NOT identity-compatible with the opaque-ID Voice resolver. A qualified
  dispatcher must stamp `variant_key` at send time until both sides share one
  canonical opaque identity contract.
- **Authoring-only deterministic variant preview** — `POST
/v1/voice/sequences/{id}/steps/{position}/variant` with an opaque
  `{subscriber_id}` JSON body. It keeps identity out of URLs, but it must not be
  described as delivery parity while the runtime and analytics fallback still
  use different identity material.
- **Goal-progress read model is not public.** Its handler remains unit-tested,
  but no `/goal-progress` route is mounted until exit-on-goal is enforced by a
  qualified runtime.
- **No sequence-attribution runtime hook is registered.** The event ingester
  persists campaign open/click facts only. Ship §B's durable attribution
  contract and its end-to-end tests before adding any sequence-enrollment
  mutation to that path.

---

## A. On each sequence send: write a `sequence_funnel_events` row

When the dispatcher sends email at `position` of `sequence_id` to
`subscriber_email`, INSERT one row. Stamp `step_id` and `variant_key`.

### Table (current shape after 0052 + 0367 + 0398)

```sql
CREATE TABLE sequence_funnel_events (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sequence_id      uuid NOT NULL,            -- voice_sequences(id), no FK on purpose
    subscriber_email citext NOT NULL,
    position         int  NOT NULL,            -- 0-indexed within the sequence
    step_id          text,                     -- stable step id (0367); see encoding below
    variant_key      text,                     -- resolved A/B arm (0398); NULL if no split
    sent_at          timestamptz NOT NULL DEFAULT now(),
    opened_at        timestamptz,              -- set later from the open webhook (§B)
    clicked_at       timestamptz               -- set later from the click webhook (§B)
);
-- Dedupe (0367): step-aware producers target the step_id index.
--   legacy (step_id NULL):  UNIQUE (tenant_id, sequence_id, subscriber_email, position)
--   step-aware:             UNIQUE (tenant_id, sequence_id, subscriber_email, step_id)
```

### Insert on send

```sql
INSERT INTO sequence_funnel_events
    (tenant_id, sequence_id, subscriber_email, position, step_id, variant_key, sent_at)
VALUES ($tenant, $sequence, $email, $position, $step_id, $variant_key, now())
ON CONFLICT (tenant_id, sequence_id, subscriber_email, step_id)
    WHERE step_id IS NOT NULL DO NOTHING;
```

- **`position`** is 0-indexed within the sequence (matches 0052 + the
  in-repo `max(position)+1` derivations).
- **`step_id`** encoding (MUST match
  `apps/desktop/src/components/sequence/funnel-metrics.ts`):
  `"p<position>"` for top-level steps; `"p<condPos>:yes:p<position>"` /
  `"p<condPos>:no:p<position>"` for branch steps; deeper nesting prepends
  segments (e.g. `"p1:yes:p2:no:p1"`). Use the **1-based flat position**
  in the `pN` segment (top-level `p1` is the first email step).
- **`variant_key`** = the `EmailVariant.Key` you resolved via §D
  (`AssignVariant`). Leave NULL when the step has no A/B split. Stamping
  is REQUIRED-IF-AUTHORITATIVE: if you ever change a step's variant
  weights mid-flight, stamp `variant_key` so historical rows keep the arm
  the subscriber actually received (recompute would re-bucket them under
  the new weights).

> ⚠️ Position convention for recompute parity: the analytics recompute
> path derives the 1-based position from `step_id` (`"pN"` → `N`) when
> present, else `position + 1` for legacy NULL-`step_id` rows. Feed
> `AssignVariant` the **1-based flat position** so a stamped and a
> recomputed `variant_key` agree.

---

## B. Attach `sequence_id` + `position` so opens/clicks carry it

The open/click webhook into
`POST /api/internal/listmonk/events` must let the ingester recover the
sequence step. Put the attribution in the event payload's `metadata`:

```jsonc
{
  "type": "subscriber.opened",
  "data": {
    "subscriber": { "email": "alice@example.com" },
    "campaign": { "uuid": "…" },
    "metadata": {
      "sequence_id": "11111111-2222-3333-4444-555555555555",
      "email_position": 1, // the SAME 0-indexed position as the funnel row
    },
  },
}
```

This unlocks **two** in-repo writes, both already coded and waiting:

1. **`opened_at` / `clicked_at` on `sequence_funnel_events`.** Update the
   matching funnel row so the funnel + per-variant breakdown show opens
   and clicks:

   ```sql
   UPDATE sequence_funnel_events
      SET opened_at = COALESCE(opened_at, $at)   -- or clicked_at for clicks
    WHERE tenant_id = $tenant
      AND sequence_id = $sequence
      AND subscriber_email = $email
      AND position = $position;
   ```

   (The engine may do this directly, OR this repo's ingester can once
   `metadata.sequence_id` is present — same transaction as the event
   persist.)

2. **`sequence_enrollments` goal completion.** Add an explicit, tested
   writer only after the engine supplies trusted attribution. Parse and
   validate `ev.Metadata["sequence_id"]` as a UUID plus
   `ev.Metadata["email_position"]` as a non-negative step, verify the
   tenant/sequence relationship, and perform an earliest-wins idempotent
   upsert in the same transaction as the event persist.

---

## C. Before sending a step: honor `exit_on_goal`

`voice_sequences.goal` (migration `0395`) is jsonb
`{"kind": "open"|"click"|"conversion", "exit_on_goal": bool}`. When a
sequence's `exit_on_goal` is `true`, the dispatcher MUST skip a step for a
subscriber who has already met the goal. The in-repo record is
`sequence_enrollments` (migration `0399`).

### Table

```sql
CREATE TABLE sequence_enrollments (
    id                  bigserial PRIMARY KEY,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sequence_id         uuid NOT NULL,
    subscriber_email    citext NOT NULL,
    enrolled_at         timestamptz NOT NULL DEFAULT now(),
    completed_goal_at   timestamptz,                  -- NULL until goal met
    completed_goal_kind text CHECK (completed_goal_kind IS NULL
                          OR completed_goal_kind IN ('open','click','conversion')),
    UNIQUE (tenant_id, sequence_id, subscriber_email)
);
```

### The exact pre-send query

```sql
SELECT 1
  FROM sequence_enrollments
 WHERE tenant_id = $tenant
   AND sequence_id = $sequence
   AND subscriber_email = $email
   AND completed_goal_at IS NOT NULL;
```

If this returns a row **and** the sequence's `goal.exit_on_goal` is true,
**skip the send** (the subscriber has exited on goal). The partial index
`sequence_enrollments_completed_idx` keeps this lookup cheap.

### Who writes completion

- **open/click goals:** the future verified §B attribution writer
  (earliest-wins upsert; first completion is durable).
- **conversion goals:** the engine stamps them — there is no in-repo
  conversion event source. Upsert with the same earliest-wins shape:

  ```sql
  INSERT INTO sequence_enrollments
      (tenant_id, sequence_id, subscriber_email, enrolled_at, completed_goal_at, completed_goal_kind)
  VALUES ($tenant, $sequence, $email, now(), now(), 'conversion')
  ON CONFLICT (tenant_id, sequence_id, subscriber_email) DO UPDATE SET
      completed_goal_at   = COALESCE(sequence_enrollments.completed_goal_at, EXCLUDED.completed_goal_at),
      completed_goal_kind = COALESCE(sequence_enrollments.completed_goal_kind, EXCLUDED.completed_goal_kind);
  ```

- The dispatcher SHOULD also upsert `enrolled_at` on first send (omit the
  `completed_goal_*` columns) so `goal-progress` can count "enrolled"
  before any open/click:

  ```sql
  INSERT INTO sequence_enrollments (tenant_id, sequence_id, subscriber_email, enrolled_at)
  VALUES ($tenant, $sequence, $email, now())
  ON CONFLICT (tenant_id, sequence_id, subscriber_email) DO NOTHING;
  ```

### RLS for engine writers

`sequence_enrollments` has FORCE RLS with the standard idiom. Engine
connections must, per transaction, `SELECT set_config('app.tenant_id',
$tenant, true)` before writing (the `WITH CHECK` is tenant-only — a raw
cast crashes on an unset GUC, hence the `NULLIF(...,'')` form). A
cross-tenant scanner may bind `app.outbox_worker='true'` to SELECT across
tenants, but MUST re-bind `app.tenant_id` per row before any write.

---

## D. Deterministic variant algorithm (implement 1:1)

Source of truth for the authoring preview:
`services/voice/internal/generation/variants.go` (`AssignVariant`). The
contract is:

```
key    = trim(subscriber_id) + "|" + sequence_id + "|p" + position
bucket = bigendian_uint64( sha256(key)[0:8] ) % 10000
```

Then walk the variants **in their stored order**, accumulating
`weight_bp`; the first variant whose cumulative weight strictly exceeds
the bucket wins:

```
acc = 0
for v in variants:        # stored order
    acc += v.weight_bp
    if bucket < acc:
        return v.key
return variants[-1].key    # unreachable when weights sum to 10000
```

Rules:

- `position` is the **1-based flat top-level position** (`p1` = first
  email step). This is the same value used in the `step_id` `pN` segment
  and by `POST …/steps/{position}/variant`.
- Variants are valid only when there are **2..4** of them, each
  `weight_bp >= 1`, summing to **exactly 10000**. An invalid/absent split
  means "no variant" — do not stamp `variant_key`.
- Same inputs always yield the same arm (no assignment table needed). The
  opaque subscriber ID is trimmed; case remains part of its identity.

### Reference vectors

The Voice tests assert repeatability, trimming, step/sequence variation, and
weighted distribution for opaque IDs. `apps/api/internal/analytics` retains a
separate legacy email-hash test only for reconstructing old unstamped funnel
rows. That is a migration fallback, not Voice/runtime parity. Before enabling
delivery, select a trustworthy opaque subscriber ID at send time, stamp the
chosen `variant_key`, and add an end-to-end parity test spanning dispatcher,
Voice, and analytics.

---

## Summary checklist for the engine team

- [ ] **§A** Write a `sequence_funnel_events` row per send, with
      `step_id` + `variant_key` (variant_key via §D).
- [ ] **§B** Put `sequence_id` + `email_position` in the open/click
      webhook `metadata`; then add the validated, tenant-scoped writer and tests
      so `opened_at`/`clicked_at` + `sequence_enrollments` populate.
- [ ] **§C** Before each step, consult `sequence_enrollments` and skip
      when `completed_goal_at IS NOT NULL` and the sequence's `exit_on_goal`
      is true. Stamp conversion completions yourself.
- [ ] **§D** Resolve arms with the exact hash (or call
      `POST …/steps/{position}/variant` with an opaque `subscriber_id`).
