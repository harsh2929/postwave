export const meta = {
  name: 'subscribers-batch',
  description: 'Plan + implement one category batch of the subscribers 2026 gap register',
  phases: [
    { title: 'Plan' },
    { title: 'Backend' },
    { title: 'Frontend' },
    { title: 'Review' },
  ],
}

const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const { category, items = [], migrationBase = 413 } = A
if (!items.length) throw new Error('subscribers-batch: no items in args (got ' + typeof args + ')')
log(`Batch "${category}": ${items.length} items; migrations from ${migrationBase}`)

// ---------- WORKTREE PINNING (parallel-session isolation) ----------
// Subagents inherit the SESSION cwd, which is NOT this isolated worktree. Two other Claude
// sessions are editing OTHER checkouts of the same repo concurrently. Pin every agent to the
// worktree absolute path so reads/writes/builds never touch another session's checkout.
const WORKDIR = String(A.workdir || '').replace(/\/+$/, '')
const WORKDIR_DIRECTIVE = WORKDIR ? `
================ WORKING DIRECTORY (CRITICAL) ================
This repository is checked out in an ISOLATED git worktree at:
  ${WORKDIR}
TWO OTHER Claude sessions are editing OTHER checkouts of the same repo RIGHT NOW. You MUST
operate ONLY inside ${WORKDIR}:
- Treat ${WORKDIR} as the repository root.
- Every file path mentioned below is RELATIVE TO ${WORKDIR}. When you Read/Edit/Write/Grep/Glob,
  use ABSOLUTE paths under ${WORKDIR} (e.g. ${WORKDIR}/apps/api/internal/subscribers/repo.go).
- Run EVERY shell command with the worktree as cwd: prefix with "cd ${WORKDIR} && ...".
- NEVER read, edit, or build outside ${WORKDIR}; sibling paths may be OTHER sessions' checkouts.
  Touching them corrupts their work and yours.
- Only create migrations numbered >= ${migrationBase}. Never reuse any existing migration number.
=============================================================

` : ''

const BACKEND_CONVENTIONS = `
BACKEND CONVENTIONS (Moosewave, Go + chi + Postgres, multi-tenant):
- Subscriber backend package: apps/api/internal/subscribers/ — one file per feature.
- Route groups use the pattern: func Mount<Name>Routes(r chi.Router, d *Deps) { ... }, and are
  wired in apps/api/main.go between ~L2150 and ~L2429. To wire a new group, find the line
  "subscribers.MountBulkRoutes(r, subscriberDeps)" in main.go and add
  "subscribers.Mount<Name>Routes(r, subscriberDeps)" near it.
- Repo + SQL: apps/api/internal/subscribers/repo.go and repo_helpers.go. Types in types.go.
  Custom-field type validation: apps/api/internal/customfields/validator.go.
- Migrations: infra/migrations/NNNN_description.sql. Use ONLY the migration numbers assigned to
  your group (gaps are fine; NEVER reuse an existing number). Any new tenant-scoped table MUST
  have a tenant_id uuid column + RLS enabled, and every RLS policy MUST read the tenant via
  NULLIF(current_setting('app.tenant_id', true), '')::uuid  (a raw ::uuid cast crashes on an
  unset GUC). Copy the tenant/RLS shape from a recent migration such as
  infra/migrations/0264_subscriber_view_prefs.sql or 0303_subscriber_signup_source.sql.
- OpenAPI: source of truth is packages/openapi/openapi.yaml. After editing it, run
  "pnpm --filter @postwave/openapi sync-json" to regenerate openapi.json. New props on the
  Subscriber schema must keep "pnpm audit:subscribers" green
  (scripts/check-subscriber-parity.mjs cross-checks openapi props against Go json tags).
- Tests: Go table tests as *_test.go in the subscribers package; follow identify_test.go /
  data_export_test.go for style (httptest + a fake Repo/Engine where used).
- VERIFY YOUR OWN WORK before returning: run
    go build ./apps/api/internal/subscribers/...
    go test  ./apps/api/internal/subscribers/...
  plus any new sibling package you created. Fix every failure you introduce.
- SCOPE DISCIPLINE: only touch apps/api/internal/subscribers/, infra/migrations/,
  packages/openapi/openapi.yaml, apps/api/main.go (route wiring only), and NEW sibling packages
  you create under apps/api/internal/. Do NOT edit unrelated packages, do NOT attempt a repo-wide
  build/fix, and do NOT modify the gap register JSON (the orchestrator owns it).`

const FRONTEND_CONVENTIONS = `
FRONTEND CONVENTIONS (Moosewave desktop, React + TS + Tauri):
- App root: apps/desktop/src/. Typed API client: apps/desktop/src/lib/api-client.ts (returns a
  discriminated { data } | { error }; reads config at call time). Hand types live in
  apps/desktop/src/lib/api-types.ts. Components in apps/desktop/src/components/. The subscriber
  list is Subscribers.tsx; the detail drawer is SubscriberDetailSlideover.tsx.
- Add new client methods to api-client.ts following the existing method shapes; add UI to the
  most appropriate existing component (or a small new component file under components/).
- The backend endpoints for this batch were JUST implemented — read openapi.yaml and the relevant
  handler files in apps/api/internal/subscribers/ to find the exact paths, methods, and payloads.
- VERIFY YOUR OWN WORK: "pnpm -C apps/desktop exec tsc --noEmit" must report 0 errors. Keep all
  changes type-clean. Follow existing styling/token conventions (no inline hex; use existing CSS
  vars / classes).
- SCOPE DISCIPLINE: only touch apps/desktop/src/. Do not modify backend or the gap register.`

// ---------- PLAN ----------
phase('Plan')
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    needs_backend: { type: 'boolean' },
    needs_frontend: { type: 'boolean' },
    needs_migration: { type: 'boolean' },
    migrations_needed: { type: 'integer' },
    files_backend: { type: 'array', items: { type: 'string' } },
    files_frontend: { type: 'array', items: { type: 'string' } },
    endpoints: { type: 'array', items: { type: 'string' } },
    ui_surface: { type: 'string' },
    test_files: { type: 'array', items: { type: 'string' } },
    existing_partial: { type: 'string' },
    approach: { type: 'string' },
    risks: { type: 'string' },
  },
  required: ['id', 'needs_backend', 'needs_frontend', 'needs_migration', 'migrations_needed', 'approach'],
}

const planPrompt = (it) => WORKDIR_DIRECTIVE + `You are planning the implementation of ONE gap-register item in the
Moosewave subscribers domain. Explore the codebase to design the precise, MINIMAL implementation —
do NOT write or modify any files; planning only.

ITEM ${it.id}: ${it.name}  (current status: ${it.status})
Capability needed: ${it.cap}
Current evidence / what exists today: ${it.evidence}
Reference sources: ${(it.sources || []).join(', ')}

Explore these areas to ground the plan:
- apps/api/internal/subscribers/ (repo.go, types.go, handlers.go, *.go), apps/api/internal/customfields/
- infra/migrations/ (recent files for the table/RLS shape; find what columns/tables already exist)
- packages/openapi/openapi.yaml (existing Subscriber schema + subscriber routes)
- apps/desktop/src/components/Subscribers.tsx, SubscriberDetailSlideover.tsx, lib/api-client.ts

Decide: does this need backend (Go/SQL/migration), frontend (UI), or both? If the item is
"Partial", identify exactly what already exists and what is missing (existing_partial). Give a
concrete approach (3-6 sentences) naming the specific files to create/edit, endpoints to add, and
migrations needed (count). Be realistic and minimal — reuse existing tables/columns where possible.

Return the plan via the structured output schema.`

const plans = (await parallel(items.map((it) => () =>
  agent(planPrompt(it), { label: `plan:${it.id}`, phase: 'Plan', agentType: 'Explore', schema: PLAN_SCHEMA })
))).filter(Boolean)

const planById = {}
for (const p of plans) planById[p.id] = p
log(`Planned ${plans.length}/${items.length} items`)

// ---------- SEQUENCE (assign migration ranges) ----------
const itemById = {}
for (const it of items) itemById[it.id] = it
const withItem = (p) => ({ ...p, item: itemById[p.id] || { id: p.id, name: p.id } })

const backendPlans = plans.filter((p) => p.needs_backend || p.needs_migration || (p.endpoints || []).length).map(withItem)
const frontendPlans = plans.filter((p) => p.needs_frontend || (p.ui_surface && p.ui_surface.trim())).map(withItem)

const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r }
const beGroups = chunk(backendPlans, 3)
const feGroups = chunk(frontendPlans, 3)

const GROUP_MIG_SPAN = 12 // headroom per backend group; gaps are fine
const renderItem = (p) => `  - ${p.id} ${p.item.name}
      capability: ${p.item.cap}
      existing: ${p.existing_partial || p.item.evidence}
      approach: ${p.approach}
      planned backend files: ${(p.files_backend || []).join(', ') || '(decide)'}
      planned endpoints: ${(p.endpoints || []).join(', ') || '(decide)'}
      migrations needed (est): ${p.migrations_needed || 0}
      tests: ${(p.test_files || []).join(', ') || '(add)'}`

// ---------- BACKEND (sequential groups) ----------
phase('Backend')
const backendResults = []
for (let gi = 0; gi < beGroups.length; gi++) {
  const g = beGroups[gi]
  const base = migrationBase + gi * GROUP_MIG_SPAN
  const prompt = WORKDIR_DIRECTIVE + `Implement the BACKEND for the following ${g.length} subscriber gap-register item(s)
in category "${category}". Implement each fully: migration(s), Go types/repo/handlers/route group,
OpenAPI additions, and Go tests. This is group ${gi + 1} of ${beGroups.length}.

MIGRATION NUMBERS for this group: use files numbered from ${String(base).padStart(4, '0')} upward
(you have up to ${GROUP_MIG_SPAN} slots: ${String(base).padStart(4, '0')}..${String(base + GROUP_MIG_SPAN - 1).padStart(4, '0')}).
Earlier groups in this batch used lower numbers; do not reuse any existing migration number.

ITEMS:
${g.map(renderItem).join('\n')}
${BACKEND_CONVENTIONS}

Work item-by-item. Read the current state of any shared file (repo.go, types.go, main.go,
openapi.yaml) immediately before editing it, since prior groups in this batch may have changed it.
When done, return a concise prose report: for EACH item id — files created/edited, migration
numbers used, endpoints added, test names, and the exact result of "go build" + "go test" for the
subscribers package (paste the final status lines). If you could not fully implement an item, say
so explicitly and why. Do not claim success you did not verify.`
  const res = await agent(prompt, { label: `backend:${category}:g${gi + 1}`, phase: 'Backend' })
  backendResults.push({ group: gi + 1, ids: g.map((p) => p.id), report: res })
}

// ---------- FRONTEND (sequential groups, after backend) ----------
phase('Frontend')
const frontendResults = []
for (let gi = 0; gi < feGroups.length; gi++) {
  const g = feGroups[gi]
  const prompt = WORKDIR_DIRECTIVE + `Implement the FRONTEND (desktop UI) for the following ${g.length} subscriber
gap-register item(s) in category "${category}". The backend for this batch is already implemented.
This is group ${gi + 1} of ${feGroups.length}.

ITEMS:
${g.map((p) => `  - ${p.id} ${p.item.name}
      capability: ${p.item.cap}
      ui surface: ${p.ui_surface || '(decide the most natural surface)'}
      approach: ${p.approach}
      planned frontend files: ${(p.files_frontend || []).join(', ') || '(decide)'}`).join('\n')}
${FRONTEND_CONVENTIONS}

Work item-by-item. Read the current state of any shared file (Subscribers.tsx,
SubscriberDetailSlideover.tsx, api-client.ts, api-types.ts) immediately before editing, since prior
groups may have changed it. When done, return a concise prose report: for EACH item id — files
created/edited, client methods added, the UI surface wired, and the exact result of
"pnpm -C apps/desktop exec tsc --noEmit" (paste the final status). If an item needs no UI, say so.
Do not claim success you did not verify.`
  const res = await agent(prompt, { label: `frontend:${category}:g${gi + 1}`, phase: 'Frontend' })
  frontendResults.push({ group: gi + 1, ids: g.map((p) => p.id), report: res })
}

// ---------- REVIEW (parallel, read-only) ----------
phase('Review')
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['implemented', 'partial', 'missing', 'broken'] },
    evidence: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
    severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
  },
  required: ['id', 'verdict', 'evidence', 'severity'],
}
const reviewPrompt = (p) => WORKDIR_DIRECTIVE + `Adversarially verify whether this subscriber gap-register item was
actually implemented in the working tree. Read the relevant files (do not modify anything).

ITEM ${p.id}: ${p.item.name}
Capability required: ${p.item.cap}
Planned approach: ${p.approach}
Planned files: ${[...(p.files_backend || []), ...(p.files_frontend || [])].join(', ')}

Check: do the files/migrations/endpoints/UI actually exist and implement the capability? Is tenant
isolation (tenant_id + RLS with the NULLIF GUC idiom) present on any new table? Any obvious
correctness, error-handling, or scope bug? Return a verdict (implemented/partial/missing/broken),
short evidence (cite real file paths/symbols you saw), any issues, and severity.`

const reviews = (await parallel(plans.map((p) => () =>
  agent(reviewPrompt(withItem(p)), { label: `review:${p.id}`, phase: 'Review', agentType: 'Explore', schema: REVIEW_SCHEMA })
))).filter(Boolean)

const migrationsTop = migrationBase + Math.max(0, beGroups.length - 1) * GROUP_MIG_SPAN + GROUP_MIG_SPAN - 1
return {
  category,
  itemCount: items.length,
  planned: plans.length,
  backendGroups: beGroups.length,
  frontendGroups: feGroups.length,
  migrationRange: [migrationBase, migrationsTop],
  plans,
  backendResults,
  frontendResults,
  reviews,
}
