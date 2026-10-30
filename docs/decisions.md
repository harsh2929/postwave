# Architecture Decision Records

This is the Moosewave ADR log, per `plan.md` Appendix C. We record every
decision that is expensive to reverse so future contributors can understand
not just _what_ we built but _why_.

## Format

Each ADR has:

- **ID + date + title** — `ADR-NNN (YYYY-MM-DD): One-line decision.`
- **Status** — Proposed / Accepted / Superseded by ADR-NNN / Deprecated.
- **Context** — the forces and constraints in play. Reference PRD / `research.md` /
  `plan.md` sections where applicable.
- **Decision** — what we chose, in one or two sentences.
- **Rationale** — why this choice over the alternatives we considered.
- **Consequences** — second-order effects, both positive and negative.
- **Reversibility** — Low / Medium / High. How painful is it to undo?

ADRs are immutable once Accepted. To change a decision, write a new ADR that
supersedes the old one and update the old one's Status.

---

## ADR-001 (2026-04-29): Engine choice — Listmonk fork

**Status:** Superseded by ADR-006

**Context:** PRD §9.1 lays out three engine options: (a) fork Listmonk, (b)
build the engine from scratch, (c) wrap a hosted ESP. We need a sending
engine capable of 200M+ emails/mo, Postgres-native segmentation, and a
tractable license footprint.

**Decision:** Fork Listmonk (Path A in PRD §9.1). The fork lives at
`github.com/postwave/listmonk`; our local checkout is the `engine/` git
submodule.

**Rationale:**

- Listmonk has demonstrated 200M emails/mo in production at Zerodha — the
  scale risk is gone.
- It is a single Go binary with Postgres-native segmentation, which matches
  the rest of our stack.
- The engine being free is a feature, not a bug: our moat is the layer above
  (migration, deliverability, voice). Spending months reinventing a sending
  engine would burn the timing window described in `research.md` §2.

**Consequences:**

- AGPL contagion risk: addressed by the network-boundary architecture
  documented in `LICENSE-BOUNDARY.md`. We never import Listmonk Go packages
  from proprietary code; we only call its HTTP API.
- We must publish our fork's source per AGPL §13. That is a feature too — it
  builds OSS goodwill and lets self-hosters validate our claims.
- Our fork is the source of truth for engine patches; generic improvements
  flow back to upstream `knadh/listmonk` via PRs.

**Reversibility:** Low. Switching engines after V1 is a 3+ month project
because the canonical schema, segment translator, and automation runtime
all assume Listmonk's data model and API surface.

---

## ADR-002 (2026-04-29): License posture — closed-source product, public AGPL fork only

**Status:** Superseded by ADR-006

**Context:** Listmonk is AGPL-3.0. Naive use (vendoring, in-tree patches,
linking) would force us to release Moosewave's proprietary code. Plausible,
Sentry, and Grafana have all proven a network-boundary pattern that keeps
proprietary code closed while satisfying AGPL §13.

**Decision:** Moosewave's product code (`apps/`, `services/`, `packages/`,
`infra/`) is closed source and proprietary. The only public repository is
`github.com/postwave/listmonk` — our fork of upstream Listmonk — as required
by AGPL. The two communicate exclusively over HTTP across a process
boundary.

**Rationale:**

- Maximum business moat: proprietary migration adapters, deliverability AI,
  and voice cloning stay private.
- The OSS components we depend on outside the engine (GrapesJS, MJML, Maily,
  Tiptap, shadcn, chi, Asynq, etc.) are all permissive (MIT/BSD/Apache) and
  impose no disclosure burden. Combining them in a closed product is fine.
- Network-boundary AGPL compliance is well-established legal practice.

**Consequences:**

- The hard rules in `LICENSE-BOUNDARY.md` are non-negotiable. Any forbidden
  import slipping into proprietary code is a license-contamination event.
- A CI grep check (`scripts/check-license-boundary.sh`) enforces the
  boundary on every PR.
- New contractors must read `LICENSE-BOUNDARY.md` before their first PR.
- We preserve copyright notices for permissive components in
  `THIRD_PARTY_LICENSES`.

**Reversibility:** Medium. We could selectively open-source some pieces
later — for example, the canonical migration adapter interface and a few
adapters (PRD §17.1) — without disturbing the rest of the codebase, since
they are already a separable package.

---

## ADR-003 (2026-04-29): Stack — Go services + Next.js 15 + Postgres + Asynq + Hetzner

**Status:** Superseded by ADR-006

**Context:** PRD §9.2. We need a stack that (a) matches Listmonk's
language/DB to keep operational surface area small at the engine layer,
(b) gives us a modern frontend story for the admin app and marketing site,
and (c) is cheap enough to host at LTD margins.

**Decision:**

- Backend services: Go 1.23, chi router, sqlc + pgx for Postgres access.
- Frontend: Next.js 15 + React 19 + Tailwind + shadcn/ui, deployed on
  Vercel.
- Database: Postgres 16 (Neon for managed dev; self-hosted on Hetzner for
  prod data plane where appropriate).
- Background jobs: Asynq (engine layer, matches Listmonk's choice) +
  Inngest (application-layer durable workflows like migration runs).
- Hosting: Hetzner Cloud for engine + services; Vercel for the web app.

**Rationale:**

- Single language at the engine + services layer (Go) keeps hiring focused
  and matches Listmonk's stack — fork patches and our service code share
  idioms.
- Postgres 16 covers OLTP, segmentation, audit logs, and queue data
  (Asynq) without bringing in another datastore.
- Hetzner is materially cheaper than AWS for compute-heavy workloads (email
  send ramp), which is critical at LTD pricing per `research.md`.
- Next.js 15 + Vercel is the fastest path to a polished admin app and gives
  us an SSR-ready marketing site for free.

**Consequences:**

- We require Go expertise on the backend, which narrows the contractor
  pool. Mitigated by the language being well-documented and Listmonk
  being a reference implementation we can point at.
- Monorepo tooling: pnpm + turbo for the JS workspace; Go workspace
  (`go.work`) for the Go modules.
- Two job systems (Asynq, Inngest) is mild overhead but each fits its
  layer cleanly — Asynq for fast in-engine jobs, Inngest for long-running
  human-time migration workflows with durable state.

**Reversibility:** Medium per layer. Changing frontend hosting is days;
changing the database is a multi-week migration; changing the primary
backend language would essentially be a rewrite.

---

## ADR-004 (2026-04-29): Pull V2 editor + forms into V1 via permissive OSS

**Status:** Accepted

**Context:** PRD §4.3 deferred a block editor and form builder to V2 on
the assumption they would each take months to build. User feedback during
research highlighted this as the biggest UX gap for Mailchimp migrants —
they expect drag-drop block editing and embeddable signup forms on day
one. The permissive OSS landscape (GrapesJS, MJML, Maily.to) has matured
to the point that integration is a ~2 week task each.

**Decision:**

- **Phase 2:** Integrate GrapesJS + `grapesjs-mjml` for the block editor,
  with Maily.to as a Markdown-first fallback editor.
- **Phase 3:** Reuse the GrapesJS investment to ship a basic embeddable
  signup-form builder (single + double opt-in, hosted form pages, embed
  snippet).

**Rationale:**

- All three components are MIT-licensed; no disclosure burden, no
  contamination of our closed-source posture (see ADR-002).
- ~2 weeks each for integration vs. months to build from scratch.
- Closes the largest UX gap for newsletter refugees and removes a major
  objection at the migration decision point.

**Consequences:**

- `plan.md` Phase 2 and Phase 3 todo lists are updated to include these
  workstreams.
- The visual _automation builder_ UI remains V2 — this ADR only pulls in
  editor and form builder UIs. Automation runtime is covered by ADR-005.
- Output formats stay neutral: editor stores MJML source and compiles to
  HTML at send time, so we can swap front-end editors later without
  re-encoding stored campaigns.

**Reversibility:** High. If we slip on schedule we can ship V1 with a
plain HTML/Markdown editor only and add GrapesJS as a fast-follow.

---

## ADR-005 (2026-04-29): Automation runtime in V1 (no builder UI)

**Status:** Accepted

**Context:** Listmonk has no automation primitive — it can send campaigns
on a schedule but does not support multi-step wait/branch/send sequences.
Pillar 3 (voice-native sequences) and migrated Mailchimp/ConvertKit
journeys both require exactly this primitive. PRD §4.3 punted automation
entirely to V2, but that would gut both Pillar 3 and the Mailchimp
migration story.

**Decision:** Build a small in-house automation runtime in
`services/automation` for V1. It executes wait, branch, send, and action
nodes against Listmonk's transactional API. The visual drag-drop canvas
for users to author automations stays in V2 — V1 only ships the runtime,
driven by templates and migrated journey definitions.

**Rationale:**

- ~2 weeks of work for the runtime alone, vs. months for runtime + canvas.
- The runtime is proprietary code (lives in `services/automation`) and
  uses only Listmonk's HTTP API — no AGPL boundary issue.
- Doubles as the V2 builder's backend, so this work isn't throwaway.
- Without it, Pillar 3 has no shipping vehicle and Pillar 1 cannot execute the
  source automation semantics that can be proven safe. Mailchimp Customer
  Journeys still require manual inventory/rebuild because the supported API
  cannot list or export their graphs.

**Consequences:**

- New Go module at `services/automation` with its own sqlc queries,
  scheduler, and API surface.
- Canonical Automation AST defined in `packages/schema/` is shared by the
  runtime and every migration adapter that produces journey data.
- We must commit to the AST early — changing it later forces every
  adapter to retest.

**Reversibility:** Low. Once Pillar 3 sequences and migrated journeys
ship against this runtime, ripping it out would break both pillars.

---

## ADR-006 (2026-07-15): Current engine, licensing, and production platform

**Status:** Accepted

**Context:** ADR-001 through ADR-003 described an intended public Listmonk
fork, a closed application layer, and a Hetzner deployment. The implemented
repository instead uses the upstream Listmonk image, licenses the application
under AGPL-3.0-only, and defines AWS ECS Fargate in `us-west-2` as the sole
Moosewave Cloud target. Leaving the intended design marked current made build,
legal, and operational documentation contradict the artifacts.

**Decision:**

- Run the version-tagged upstream Listmonk v6.1.0 image for development over an
  HTTP service boundary; production releases must resolve a reviewed immutable
  image digest. There is no Moosewave fork or `engine/` submodule unless a
  future reviewed change adds one and satisfies the applicable AGPL source and
  notice obligations.
- License `apps/`, `services/`, and `infra/` as AGPL-3.0-only. Each immediate
  client package root remains MIT, without promising a public mirror, registry
  release, maintenance, or support. Calibrated assets under `proprietary/` are
  present only in private/internal checkouts and selected private Moosewave
  Cloud images; they are excluded from public, customer, self-host, and
  corresponding-source artifacts. MIT placeholders live in
  `proprietary-stubs/`.
- Treat the CloudFormation AWS deployment in `us-west-2`, governed by
  `config/production-platform.json`, as the only Moosewave Cloud production
  path. Compose and archived Terraform/MVP material are non-production.

**Rationale:** This records the repository and release contracts that actually
exist. It removes claims about an absent fork/submodule and prevents multiple
production platforms or license models from being inferred from historical
planning documents.

**Consequences:** Any custom engine fork needs a new ADR, immutable source and
image provenance, and an AGPL corresponding-source publication path. Any cloud,
region, domain, or license change must update the platform and license contract
gates in the same release.

**Reversibility:** Medium. Each choice can change, but only with coordinated
legal, infrastructure, distribution, and customer-migration evidence.

---
