# ai_agent — Migration Recipe / Deferred Work

This package scaffolds the Phase 3 XL gap **`sto-ai-campaign-agent`** —
the LLM "Composer / Operator / Nova Agent" surface. The v1 ship in
this repo is intentionally a skeleton; this doc captures the multi-week
work a human engineer needs to complete to reach parity with the
inspiring vendors.

---

## Inspired by

| Vendor          | Product surface          | Notes                                        |
| --------------- | ------------------------ | -------------------------------------------- |
| Klaviyo         | Composer                 | Single-prompt → fully-configured campaign    |
| Iterable        | Nova Agent (Apr 2026)    | Multi-turn, tool-grounded, journey-aware     |
| MoEngage        | Merlin Custom Agents     | Tenant-trained agent variants                |
| Braze           | Operator                 | Operator-class autonomy + branching journeys |
| Customer.io     | AI Agent                 | Single-prompt audience + content + timing    |

---

## Architecture sketch

The runtime has four moving pieces:

1. **Session store** (`ai_campaign_agent_sessions` + `ai_campaign_agent_messages` + `ai_campaign_plans`)
   - One session per chat thread between an operator and the agent.
   - Messages capture the full ReAct trace (user prompts, assistant
     replies, tool calls + tool outputs).
   - Plans are the structured campaign-config artifacts; the latest is
     the one the operator confirms.

2. **Tool registry** (planned — `tools.go`)
   - Each tool is a Go function with a JSON-schema description that the
     LLM sees. The runtime exposes:
     - `list_segments(filter)` — read segments via the segments package
     - `list_templates(filter)` — read templates via the campaigntemplates package
     - `get_recent_campaign_performance(window_days, limit)` — analytics
       package, similar to `ai_subject_lines.TopPerformers`
     - `create_campaign_draft(plan)` — calls into campaigns.CreateDraft
     - `schedule_with_sto(audience_segment_ids, window)` — calls into
       send_time_opt for per-recipient time picking
   - All tools enforce the same tenant-scoped RLS transaction the
     repo uses; no tool can escape the tenant.

3. **Agent orchestrator** (`campaign.go` — the `Agent.Turn` method)
   - Currently a stub that echoes the prompt into a placeholder plan.
   - Full impl: runs the LLM tool-call loop (Gemini / Claude
     function-calling), accumulates tool traces as `role=tool`
     messages, terminates on a structured `final_plan` tool call from
     the LLM, validates the plan, calls `Repo.SavePlan`.

4. **Confirm guardrail** (`POST .../confirm`)
   - Re-loads the latest plan, runs `plan.Validate()`, calls into
     campaigns to materialize the draft, records the linkage with
     `Repo.MarkConfirmed`.

---

## Currently shipped (v1 scaffold)

- Migration `0343_sto_ai_campaign_agent.sql` — three tables, RLS,
  indexes, FK to tenants.
- `Repo` — full CRUD over sessions / messages / plans.
- `Agent.Turn` — happy-path stub that persists a deterministic
  placeholder plan from the operator's prompt.
- HTTP handlers — `/api/v1/ai-agent/sessions` (list/create), `/sessions/{id}`
  (get), `/sessions/{id}/messages` (list/post), `/sessions/{id}/confirm`,
  `/sessions/{id}/discard`.
- Plan validation (`CampaignPlan.Validate`) — minimum-viable invariants.

---

## Deferred work

### A. LLM tool-call loop (≈ 1.5 wks; one engineer)

- Wire `Agent.Voice` into a real ReAct loop using the existing
  `aicompose.VoiceClient` interface. Extend the voice service with a
  `ChatKind = campaign_agent` that supports structured tool-call
  outputs.
- Define the JSON-schema for each tool in `tools.go`.
- Persist every tool call as a `role=tool` message so the trace is
  reproducible in support cases.
- Terminate the loop on the LLM's `final_plan` tool call or a 10-turn
  cap (whichever first).
- **Inspiration**: Iterable Nova Agent's multi-turn trace UI; Braze
  Operator's "Show your work" panel.

### B. Tool implementations (≈ 2 wks; parallelizable across 3 engineers)

Each tool is independent and can be built in parallel:

| Tool                              | Backing package                       | Effort |
| --------------------------------- | ------------------------------------- | ------ |
| `list_segments`                   | `internal/segments`                   | 1–2d   |
| `list_templates`                  | `internal/campaigntemplates`          | 1–2d   |
| `get_recent_campaign_performance` | `internal/analytics`                  | 2–3d   |
| `create_campaign_draft`           | `internal/campaigns` (CreateDraft)    | 3–5d   |
| `schedule_with_sto`               | `internal/send_time_opt`              | 3–5d   |

The `create_campaign_draft` tool is the largest because it has to map
the LLM's loose JSON plan onto the real campaign DTO + run the
validations.

### C. Confirm → materialize (≈ 1 wk; one engineer)

- Replace `newPlaceholderID()` with a real call into
  `internal/campaigns` that creates a draft (NOT a send) and returns
  the campaign id.
- Plumb `confirmed_by_user` from the auth context (the user id is
  available via `middleware.UserFromContext`; the current scaffold
  passes nil).
- Add an audit-log emit so the confirm hits the standard
  `auditsink` stream for compliance.

### D. Desktop chat UI (≈ 2 wks; one frontend engineer)

- New page `apps/desktop/src/pages/CampaignAgent.tsx`.
- Reuse the chat affordances from `pages/PostwaveAI.tsx`
  (`AIMessage`, `SlashCommandMenu`, `BrandVoicePanel`).
- New plan-diff component: side-by-side audience / subject / schedule
  view with a Confirm button that POSTs to `/sessions/{id}/confirm`.
- Tool-trace expander (collapsed by default; click to expand to see
  each grounded tool call the agent ran).
- **Inspiration**: Klaviyo Composer's right-rail "what I'm doing" panel.

### E. Tenant grounding & few-shot prompts (≈ 1 wk; one engineer)

- Build a per-tenant prompt template that ships with the tenant's
  recent top-performing subject lines + voice profile in the system
  context (same idea as `aicompose.Composer.ContextText`, expanded to
  include sample audience names / template categories).
- This is what makes the agent "grounded in the workspace's actual
  data" — without it the agent feels generic.

### F. Rate-limiting + cost accounting (≈ 3d; one engineer)

- Mount the routes under the same `expensiveTenantLimit.Middleware`
  group as `aicompose` in `main.go` (the LLM tool-call loop spends N
  voice-service calls per turn).
- Persist `input_tokens` / `output_tokens` on each `role=assistant`
  message and aggregate in the analytics dashboard.

---

## Estimated total remaining effort

| Block                           | Eng-weeks (sequential) | Parallelizable? |
| ------------------------------- | ----------------------: | --------------- |
| A. LLM tool-call loop           | 1.5                    | Blocks B/C      |
| B. Tool implementations         | 2.0                    | Yes (3-way)     |
| C. Confirm → materialize        | 1.0                    | After A         |
| D. Desktop chat UI              | 2.0                    | Yes (parallel)  |
| E. Tenant grounding             | 1.0                    | Parallel        |
| F. Rate-limit + cost accounting | 0.6                    | Parallel        |

**Sequential critical path: A → B (parallel) → C → ship** ≈ 4–5 calendar
weeks with 2 backend + 1 frontend engineer. Down to 3 weeks with
parallel staffing on D/E/F.

---

## Wiring checklist (when full impl ships)

- [ ] `main.go`: construct `ai_agent.New(repo, aicompose.NewHTTPVoiceClient(cfg.VoiceServiceURL))`.
- [ ] Mount routes inside `expensiveTenantLimit.Middleware` group.
- [ ] Add the `campaign_agent` ChatKind to the voice service.
- [ ] Add a CapabilityGallery entry on `PostwaveAI.tsx` linking to the
      new agent page.
- [ ] Audit-log emit on `/confirm` via `auditsink`.
- [ ] Backfill RLS sanity test in `internal/ai_agent/campaign_test.go`.
