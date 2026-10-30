# Moosewave Sequences — 2026 Gap Analysis

This document audits the current Moosewave Sequences surface (list page, visual step canvas, step editor, legacy slideover) against the 2026 industry state-of-the-art across lifecycle journey builders, agentic AI sequence generation, and per-step analytics. It ranks the highest-leverage gaps with effort/impact estimates and concrete acceptance criteria scoped to existing files.

## Current state

What ships today inside `apps/desktop/src/pages/Sequences.tsx`, `apps/desktop/src/components/sequence/*`, and the unreachable `SequenceDetailSlideover.tsx`:

- **Sequence list with status badges** — renders status pills for active, paused, draft, archived. List shows name, step count, active runs, and a RateBar fill ranking each row against the page max.
- **Create new sequence modal** — collects name + optional description, POSTs via `api.createSequence`, then reloads. No template picker, no goal selection, no trigger picker.
- **Trigger primer ValueProp card** — informational card describing triggers (product event, list subscription, scheduled time). Copy-only; the canvas does not let the user configure these triggers.
- **Empty-state hero** — `HeroEmptyState` with eyebrow, title, subtitle, and primary CTA. Marketing-grade copy but no template gallery.
- **Visual step canvas with palette + drop zones** — vertical drag-and-drop builder with `StepPalette` on the left, before/after drop targets per node, end-of-flow drop zone, and `StepConnector` hits. Top-level steps can now be reordered by grip-drag or Alt+ArrowUp/Down; branch-node reorder remains tied to the branch-maintenance gap below.
- **Six step types** — backend-persistable step union: email, delay (min/hours/days), condition (yes/no branches), tag_add, tag_remove, exit. Round-trip-validated through `services/voice` PATCH.
- **Condition branching (yes/no)** — conditions render two drop-target branches. Predicates: opened, clicked, tagged, custom_property, product_event. Branches accept palette drops and persist recursively.
- **Per-step editor slideover** — type-specific fields: email (subject, body, template_id), delay (value + unit), condition (predicate + value), tag (name), exit (no config). Validation, delete confirmation.
- **Keyboard navigation on canvas** — ArrowUp/Down focus moves, Enter edits, Delete/Backspace deletes (with confirmation). Tab order is preserved by `registerNodeRef`.
- **Optimistic save with rollback** — `persistNow` PATCHes the full steps array; on error the last-saved snapshot rolls UI back and toasts the error. `canPersistSteps` gates partial-state writes.
- **Role-based read-only enforcement** — `useCanWrite` gates palette tiles, drop handlers, edit/delete, and `persistNow` has a belt-and-suspenders `canMutate` re-check to prevent race-condition 403s on role downgrade.
- **Skeleton loaders** — three skeleton rows on list load; canvas shows palette skel + 3 row skels on detail load.
- **Pause/Activate and Delete (legacy slideover)** — toggle status between active/paused via PATCH; delete via API. NOTE: no longer reachable from the list (canvas replaced it).
- **Funnel mini-chart per step (legacy slideover)** — per-step reached/opened/clicked bars from `api.getSequenceFunnel`. Only available in the legacy slideover, NOT in the active canvas detail view.
- **Step regenerate via AI (legacy slideover)** — `POST regenerateSequenceStep` replaces a step's content via AI. Available only in the unreachable slideover, not the canvas builder.
- **Legacy email-only steps editor (slideover)** — form-based add/edit/remove emails with subject + body + interval_days. Replaced by canvas but still in tree.

## 2026 industry SOTA

### Visual journey builders
- **Drag-and-drop visual canvas with zoom and pan** — Klaviyo Flows, Loops.so, Customer.io, Iterable Studio, Braze Canvas Flow, ActiveCampaign all ship 2D infinite canvas with trackpad zoom and panning as table-stakes.
- **Conditional split (if/else) on profile attributes vs trigger payload** — Klaviyo separates Conditional Split (profile-based) from Trigger Split (event-payload-based) with up to 12 branches each.
- **Wait-until-event step with multi-condition branches** — Customer.io Wait Until, Braze Canvas, Iterable hold a person at a node until they perform an event, join a segment, or hit a max-time fallback, each condition spawning its own path.
- **Wait-until-timezone-window with quiet hours respect** — Iterable Quiet Hours, Klaviyo STO, Omnisend, Mailchimp SMS quiet hours defer sends to the user's local-time window combined with send-time optimization.
- **A/B test split step with auto-winner promotion** — Klaviyo flow A/B, Iterable Experiments, Customer.io, Braze Experiment Paths split audience by percentage across N variants and auto-select the statistically significant winner.
- **Experiment Paths with Winning Path / Personalized Paths** — Braze Canvas tests entire branch variations on a slice of audience then routes remaining + future users either down the global best path or down the personally best path via ML.
- **Goal nodes with conversion tracking and early exit** — ActiveCampaign Goals, Salesforce Marketing Cloud act as "teleporters" when satisfied and tally as conversions against the journey.
- **Exit conditions (global rules)** — Salesforce Journey Builder, Customer.io, Klaviyo pull people out without crediting them (e.g., unsubscribed, refunded, joined suppression segment).
- **Per-step performance overlay on the canvas** — Loops Metrics tab, Klaviyo flow analytics, Airship Journey Report render inline counts of entered/opened/clicked/converted/dropped-off directly on each node.
- **Multi-channel send steps (email + SMS + push + in-app)** — Iterable Studio, Braze Canvas Flow, Customer.io, Klaviyo orchestrate email, SMS, push, web push, in-app, embedded, and WhatsApp from one canvas.
- **Universal holdout group (persistent control cohort)** — Iterable keeps the same N% of users dark across all journeys via two committed Lists (control + holdout) referenced inside Journeys.
- **Live mode showing real subscribers traveling the canvas** — Adobe Journey Optimizer, Bloomreach, Braze, Meiro show real-time enrolled / entering / advancing / exiting counts at each node.
- **Journey auto-transition between flows** — Salesforce Marketing Cloud (GA Oct 2025) promotes contacts from one journey into another based on actions taken.
- **Canvas Context (per-user contextual data attached at any step)** — Braze Canvas (2026 launch) attaches contextual data specific to each customer and acts on it in subsequent steps.
- **Copy-email / copy-branch across loops** — Loops.so Copy Existing Email button pulls in any email node from another loop.
- **Version history with revert and side-by-side diff** — enterprise tools (Iterable, Braze, Salesforce) ship time-machine views with single-click revert.
- **Set Journey Attributes action (mutate user state mid-flow)** — Customer.io (March 2026) writes attributes to the user profile mid-journey for cohort tagging and downstream segments.

### AI-driven sequence authoring
- **Brief-to-canvas sequence generation** — Klaviyo Flows AI Builder and Composer collapse hours of workflow administration into a single prompt, producing a complete multi-step canvas with triggers, delays, channels, and exit conditions.
- **Per-step copy auto-drafted with brand voice profile** — Jasper-style brand voice tooling plus a built-in critic loop drafts subject lines and body copy for every step in one pass, cutting voice failures 60-70%.
- **AI-suggested branch conditions from segment history** — RAG over campaign history and behavioral micro-segment clustering recommends splits that historically predicted divergence in engagement.
- **Per-step reinforcement-learning send time** — Adobe Journey Optimizer and Klaviyo run RL models per-recipient per-step picking the moment each subscriber is most likely to open or click that specific message.
- **AI-suggested holdout group** — Customer.io and Klaviyo propose a statistically-sized holdout (5-15%) on flow generation and recommend measurement windows for incremental lift.
- **AI explain-this-step** — Klaviyo Composer's conversational interface answers "why this delay, why this branch, why this copy" from the original brief, historical data, and brand voice profile.
- **Drift detection vs original goal** — original brief stored as a goal vector and continuously compared against actual outcomes, flagging when the flow has drifted from its hired purpose.
- **Mid-journey next-best-action rerouting** — Customer.io LLM action steps and Klaviyo's next-best-product rollouts evaluate current engagement at each node and reroute, skip steps, jump branches, or switch channels.
- **Loss-point diagnosis and auto-remediation** — Klaviyo Composer 2026 identifies the worst-performing step (open cliff, click cliff, unsub spike) and proposes a specific fix (rewrite subject, shorten delay, drop the step).
- **Compliance and guardrail enforcement at generation** — brand policies, frequency caps, suppression rules, regional consent (GDPR, CASL), unsubscribe placement encoded into the generator itself.
- **Human-pass review checkpoint before activation** — AI-generated canvases route through structured human review (copy diff, branch rationale, holdout config, projected volume/revenue) before going live.
- **AI Decisioning Agents instead of hand-drawn branches** — Salesforce Journey Decisioning Agents, Braze Sage, Bloomreach are given a goal, brand guidelines, and data access, then decide the next best step per user in real time.
- **Native MCP server / agent-callable journey ops** — Braze 2026 native MCP server exposes the journey-building API to Claude/ChatGPT/agents.

### Per-sequence analytics & attribution
- **Multi-step funnel with per-step conversion windows** — Mixpanel funnels, Amplitude funnel analysis, Heap, Mitzu, GA4 default to 4-7 steps with explicit conversion window per transition.
- **Retention heatmap with cohort segmentation** — Mixpanel retention (D1/D7/D30 cohort grid), Amplitude cohort retention, PostHog retention insights provide the universal triangular cohort view.
- **Conversion path & sequence drop-off funnels** — per-sequence funnel (sent → opened → clicked → next step → goal) with branch attribution, exit-reason tagging, and time-to-convert distributions.
- **Multi-Touch Attribution overlay (MTA + MMM reconciliation)** — 47% of marketing teams in 2026 credit each sequence step against the final conversion using behavioral signals, driving 15-25% ROI improvement.
- **Predictive LTV cohort scoring** — gradient boosting scores each subscriber's 12-month LTV from early signals, powering value-tiered branching in sequences and quality monitoring in analytics.
- **Audience overlap analysis across sequences** — overlap matrix (rows = sequences, cells = shared subscriber counts) plus per-subscriber "currently active in" badge prevents fatigue when 4+ messages triple spam complaints.
- **Sequence-aware send-time optimization with lift measurement** — per-recipient optimal-send-time models adjusted per sequence step, paired with rigorous lift measurement against held-out control to earn marketer trust.
- **Cohort engagement decay & sunset policy automation** — rolling 30/60/90-day open rate by signup cohort makes list-fatigue visible, with automated suppression after N consecutive unengaged sends.
- **Audience-level holdout groups for sequence lift** — randomized opt-in holdouts feed back into MTA models as ground truth for incremental lift defense.
- **Subscribers-in-sequence drilldown** — Mixpanel cohorts "view the list of users that comprise them", Customer.io campaign subscribers, Klaviyo flow subscribers, Iterable journey participants — clicking a number jumps to the underlying rows.

### Content quality & operational safety
- **Sequence templates library** — Klaviyo, Customer.io, Iterable, Loops, ActiveCampaign all ship 20+ pre-built flow templates (Welcome, Win-back, Abandoned cart, Re-engagement, Onboarding, Post-purchase, Birthday) as the primary entry point.
- **Test send / preview with sample subscriber payload** — Klaviyo, Mailchimp, ActiveCampaign, Customer.io make test-send a one-click action on every message node, with merge-tag rendering preview and client-rendering check.
- **Merge-tag autocomplete and personalization preview** — Klaviyo variable picker, Mailchimp merge tag drawer, ActiveCampaign personalization tags provide `{` autocomplete, fallback-value picker, and live preview.
- **Drag-handle reorder for existing steps** — Klaviyo, Customer.io, Iterable, Loops all support drag-to-reorder as the obvious affordance for adjusting flow shape.
- **Drafts vs. live publish workflow** — Klaviyo, Customer.io, Iterable separate draft from live with diff and rollback, preventing accidental live edits while subscribers are mid-flow.
- **Pause / Resume / Archive with confirm overlay** — standard control on every journey tool, with confirm-on-pause listing active-run count and stuck-at-step messaging.
- **Trigger configuration UI** — Klaviyo, Customer.io, Iterable, Salesforce Marketing Cloud require trigger setup as the first step in a flow (list subscription, segment match, custom event, scheduled).
- **Activity / audit log on a sequence** — compliance and team-collab feature standard in Klaviyo/Customer.io showing who edited what when.
- **Concurrent multi-edit awareness** — presence indicators or edit locks prevent two editors from clobbering each other via full-array PATCH.
- **Re-entry rules** — Klaviyo Flow Once-Per-Profile, Customer.io Re-entry settings control whether a subscriber can re-enter the sequence and with what cool-down.
- **Frequency caps & throttling** — per-sequence and per-user frequency caps plus global send throttle prevent multiple active sequences from hitting a subscriber unbounded.

## Gaps ranked by impact

### 1. Surface per-step funnel analytics inside the canvas builder  [effort: S / impact: high]
**What:** Pull `api.getSequenceFunnel(id)` data into the StepCanvas detail view and render reached / opened / clicked / drop-off counts and bars directly on each node — the same data the legacy slideover already shows, but inline on the production canvas the list opens. Refresh on focus, expose a per-step revenue micro-row if the funnel response carries it.
**Why:** The funnel endpoint already exists and is wired into the dead `SequenceDetailSlideover`, but the canvas that users actually open has zero step-level metrics — marketers cannot see which step is leaking conversions without leaving the builder. Modern journey tools (Loops, Klaviyo, Airship) treat per-node performance overlays as table stakes; Moosewave regressed this when the canvas replaced the slideover. Surfacing it is a pure client-side wiring job against an endpoint that already returns the data.
**Touch points:** `apps/desktop/src/components/sequence/StepCanvas.tsx`, `apps/desktop/src/components/sequence/StepNode.tsx`, `apps/desktop/src/components/SequenceDetailSlideover.tsx:608-634`
**Acceptance:**
  - StepCanvas calls `api.getSequenceFunnel(sequenceId)` on mount and refresh, with skeleton state and graceful empty-data fallback for new sequences
  - Each StepNode renders a compact metrics row (reached / opened / clicked / drop-off %) sourced from the funnel response, matched by position
  - Drop-off > 40% at any step renders an inline warning chip with a tooltip explaining the threshold
  - Funnel refresh is debounced after `persistNow` so post-edit reloads do not race the optimistic save
  - Role-gated: viewers still see metrics; only editors get the warning-action affordances

### 2. Restore per-step AI Regenerate on the canvas  [effort: S / impact: high]
**What:** Bring the `regenerateSequenceStep` action back as a button in StepEditor for email steps — POST the step's position to the existing endpoint, replace the step's subject/body with the returned content, and surface a diff/Accept-Discard preview before committing the PATCH.
**Why:** The legacy slideover had an AI Regenerate per email step (`api-client.ts:3175`). That capability was silently lost when the canvas replaced the slideover, leaving users without any AI authoring help. The Sequences research register lists "AI-suggested copy with brand voice" as standard in 2026 (Klaviyo Composer, Customer.io Copilot). Endpoint and backend logic already exist — this is purely a UI wiring task with a preview pattern.
**Touch points:** `apps/desktop/src/components/sequence/StepEditor.tsx`, `apps/desktop/src/lib/api-client.ts:3175-3193`, `apps/desktop/src/components/SequenceDetailSlideover.tsx:208-223`
**Acceptance:**
  - StepEditor for `type='email'` shows a "Regenerate with AI" button (disabled in read-only mode)
  - Clicking it calls `api.regenerateSequenceStep(seqId, step.position)`, shows inline loading state, and renders a before/after diff modal with Accept and Discard
  - Accept commits via the existing saveStep callback; Discard leaves the draft untouched
  - Errors toast the message and leave the editor in its prior state
  - Concurrent regenerate requests are guarded by an in-flight flag

### 3. Editable steps inside condition branches  [effort: M / impact: high]
**What:** Replace the flat display-only summary tiles in `renderConditionBranches` (StepCanvas.tsx:659-679) with full StepNode renders inside each yes/no branch, including edit, delete, and reorder affordances, plus recursive drop targets so branches accept the same palette interactions as the trunk.
**Why:** Today users can drop a step into a branch but cannot subsequently edit or delete it — the branch items have no UI affordance, only an icon and a one-line summary. Branching is the most-used pattern in Klaviyo/Customer.io/Iterable journeys and the inability to maintain branch steps post-creation effectively breaks the feature. The backend already round-trips recursive `yes_branch[]`/`no_branch[]` arrays; the gap is purely in StepCanvas rendering.
**Touch points:** `apps/desktop/src/components/sequence/StepCanvas.tsx:601-690`, `apps/desktop/src/components/sequence/StepNode.tsx`, `apps/desktop/src/components/sequence/StepEditor.tsx`
**Acceptance:**
  - Branch items render as full StepNode components, not summary tiles, with the same select/edit/delete and keyboard handlers as trunk nodes
  - Edits to a branch step PATCH via the same `persistNow` path with the recursive branch arrays intact
  - Deleting a branch step removes only that node, leaves the parent condition intact, and rolls back optimistically on error
  - Drag targets exist before and after each branch step (not just at the bottom of the branch)
  - Keyboard navigation flows trunk → yes branch → no branch → next trunk step in DOM order

### 4. Sequence templates gallery in the Create modal  [effort: M / impact: high]
**What:** Replace the blank-name-only Create modal with a 2-step picker: a gallery of pre-built starter sequences (Welcome, Win-back, Abandoned cart, Re-engagement, Onboarding, Post-purchase, Birthday) that each map to a hardcoded `steps[]` array, then a name/description form. Selecting a template POSTs `createSequence` with the pre-built steps; "Blank canvas" remains as the always-available option.
**Why:** Every sequence today starts from a blank canvas. Klaviyo, Customer.io, Iterable, Loops, and ActiveCampaign all ship 20+ pre-built flow templates as the primary entry point — they materially reduce time-to-first-send and educate users on best-practice multi-step patterns. Templates can be a static client-side asset of `SequenceStoredStep[]` arrays piped through the existing `createSequence` POST; no backend work required.
**Touch points:** `apps/desktop/src/pages/Sequences.tsx:59-76`, `apps/desktop/src/pages/Sequences.tsx:270-308`, `apps/desktop/src/lib/api-client.ts:1741-1750`
**Acceptance:**
  - Create modal shows a template gallery first (7+ templates with name, description, step count, visual preview thumbnail)
  - "Blank canvas" remains as a card so users can opt out of templates
  - Selecting a template advances to the existing name/description form pre-filled from the template
  - Submit POSTs `createSequence` with `steps:` populated from the template, lands the user directly on the new sequence's canvas
  - Templates live as a typed client-side constant module so adding a template is a one-PR data change

### 5. AI brief-to-canvas sequence generation  [effort: L / impact: high]
**What:** Add a "Generate with AI" option in the Create modal that accepts a natural-language brief ("4-step welcome for B2C signups, nudge first purchase by day 7") and posts to the existing AI/regenerate or a new whole-sequence endpoint to produce a complete `steps[]` array. Render the proposed canvas in a preview pane with per-step rationale and an Accept/Edit gate before persisting.
**Why:** Brief-to-canvas generation is the headline 2026 sequences feature across Klaviyo Composer, Customer.io Copilot, and Loops Smart Flows — the research register places it as "emerging standard" with documented hours-to-minutes time savings. Moosewave already has the AI infrastructure for single-step regenerate; extending it to whole-sequence drafting is a high-leverage product wedge. Even an MVP that returns 3-5 canonical templates from prompt-keyword matching client-side would land the affordance.
**Touch points:** `apps/desktop/src/pages/Sequences.tsx`, `apps/desktop/src/lib/api-client.ts` (new endpoint hook), `apps/desktop/src/components/sequence/StepCanvas.tsx` (preview mode)
**Acceptance:**
  - Create modal has an "AI generate" tab alongside "Templates" and "Blank"
  - Brief textarea (max 500 chars) with example prompts shown as quick-pick chips
  - Submit calls the AI endpoint, shows generating state with skeleton canvas, then renders a preview with per-step rationale tooltips
  - Accept commits via `createSequence` with steps; Edit drops user on the new sequence's canvas for tweaks before activation
  - Failures fall back to "try a template instead" affordance, not a dead end

### 6. Test send / preview a single step with sample subscriber  [effort: M / impact: high]
**What:** Add a "Send test" button to StepEditor for email steps. It opens a small panel collecting (a) a recipient address from the current user's verified senders and (b) optional sample merge-tag values, then POSTs a single-email send through the existing campaign test-send path scoped to this sequence step's content.
**Why:** There is no way to preview or test a step's email before subscribers receive it — no merge-tag rendering, no inbox preview, no client-rendering check. Every modern ESP (Klaviyo, Mailchimp, ActiveCampaign, Customer.io) makes test-send a one-click action on every message node. Without it, the only way to verify a step is to push it live and inspect a real subscriber's inbox — a guaranteed source of embarrassing fixes-in-prod. The campaign side likely already has a test-send endpoint to reuse.
**Touch points:** `apps/desktop/src/components/sequence/StepEditor.tsx`, `apps/desktop/src/lib/api-client.ts` (reuse or extend test-send endpoint)
**Acceptance:**
  - StepEditor for `type='email'` has a "Send test" button next to Save
  - Clicking opens an inline panel with verified-sender picker, recipient address (defaults to current user), and key/value rows for sample merge data
  - Submit calls the test-send API, shows in-flight state, success toast with "sent to X"
  - Validation: recipient must be a valid email; rejects empty subject
  - Read-only/viewer role hides the button entirely

### 7. Subscribers-in-sequence drawer (who is at step N right now)  [effort: M / impact: high]
**What:** Add an "Active subscribers" drawer accessible from the canvas header that lists subscribers currently enrolled in the sequence, their current step, entry time, and last activity. Backed by a paginated list endpoint scoped to the sequence (or filtered subscriber-list call). Clicking a row jumps to the subscriber profile.
**Why:** The list row today shows a raw `active_runs` count but the detail surface has no visibility into WHO is in the sequence right now, where they are stuck, or who failed. This is the single biggest debugging gap: marketers cannot answer "why is Jane not getting step 3?" without grepping logs. Standard in Customer.io (campaign subscribers), Klaviyo (flow subscribers), and Iterable (journey participants). Counts already flow through; this is a list view over existing data.
**Touch points:** `apps/desktop/src/pages/Sequences.tsx`, `apps/desktop/src/components/sequence/StepCanvas.tsx`, `apps/desktop/src/lib/api-client.ts` (new `listSequenceParticipants` endpoint hook)
**Acceptance:**
  - Canvas header shows "Subscribers (N)" button that opens a right-side drawer
  - Drawer lists subscriber email, current step number+label, entry timestamp, status (active/stuck/exited)
  - Sortable by entry time, current step; filterable by status
  - Row click navigates to subscriber profile
  - Empty state for new sequences with copy directing user to trigger config
  - Paginated at 50/page; total count matches list row's `active_runs`

### 8. Drag-handle reorder for existing steps  [done: top-level / impact: mid]
**What:** Activate the dormant `persistDebounced` (StepCanvas.tsx:415 "Reserved for the future reorder-by-drag-handle path") by adding a drag handle on each StepNode, wiring HTML5 drag with same-canvas reorder (move-not-copy semantics), recomputing positions, and persisting via the existing debounced PATCH. Branch nodes get the same handle once gap #3 lands.
**Why:** Today reordering a step requires delete + re-add — destructive, error-prone, and loses any per-step analytics history if surfaced (gap #1). The code already comments that drag-to-reorder is "reserved for the future" and the debounce helper exists unused. Every comparable builder (Klaviyo, Customer.io, Iterable, Loops) supports drag-to-reorder as the obvious affordance for adjusting flow shape. Pure client work against the existing PATCH endpoint.
**Touch points:** `apps/desktop/src/components/sequence/StepCanvas.tsx:395-415`, `apps/desktop/src/components/sequence/StepNode.tsx`
**Acceptance:**
  - Each StepNode shows a drag handle (cursor: grab) on hover; keyboard reorder via Alt+ArrowUp/Down also works
  - Dragging an existing step shows the same before/after drop markers as palette drops
  - Same-canvas drag semantics are MOVE (not copy); palette drag semantics remain copy
  - Reorder PATCH uses `persistDebounced` 500ms after the user settles, with optimistic update and rollback on error
  - Conditions move with their full branch contents as an atomic unit
  - Reordering inside a branch (after gap #3) works with the same handle

**2026-06-27 update:** top-level canvas reorder is implemented. Branch-node reorder is still intentionally deferred until gap #3 replaces branch summaries with fully maintainable branch nodes.

### 9. Merge-tag autocomplete and personalization preview in email editor  [effort: M / impact: high]
**What:** Upgrade the StepEditor email body from a plain textarea to a tag-aware input: `{` triggers an autocomplete menu of available merge tags (first_name, last_name, email, custom attributes from the workspace), inline highlighting of detected tags, a fallback-value picker per tag, and a "Preview" toggle that renders the body with sample subscriber data.
**Why:** The body editor today is a monospace textarea with no merge-tag affordance — users hand-type `{{first_name}}` with no autocomplete, no detection of typos, no fallback config, and no preview. Standard in Klaviyo (variable picker), Mailchimp (merge tag drawer), ActiveCampaign (personalization tags). Without it, every email step risks shipping broken merge tags to thousands of subscribers. Client-only feature against a static tag catalogue plus optional API hook for tenant-specific attributes.
**Touch points:** `apps/desktop/src/components/sequence/StepEditor.tsx`, `apps/desktop/src/lib/api-client.ts` (optional subscriber-attributes hook)
**Acceptance:**
  - Typing `{` in the body textarea opens an autocomplete menu with standard + tenant tags
  - Recognized tags render with distinct background tint in the textarea
  - Each tag supports a fallback value via a small popover (e.g., `{{first_name|friend}}`)
  - Preview toggle renders the body with sample data drawn from a dummy subscriber, with merge tags substituted live
  - Unknown tags show a warning chip below the textarea before save

### 10. Sequence-level performance header in the canvas detail  [effort: S / impact: high]
**What:** Above the StepCanvas, render a compact stat strip with sequence-level KPIs computed from the funnel response: entered, completed, drop-off %, average time-to-complete, and (if funnel data exposes them) total opens / clicks / unsubscribes. Plus a 30-day sparkline of daily entries.
**Why:** The list row's only per-sequence metric is `active_runs` — a single integer. Inside the detail view there is zero aggregate performance summary; users have no way to evaluate whether a sequence is working. Klaviyo's flow detail, Customer.io's campaign overview, and Mailchimp's automation report all open with a KPI header. With `getSequenceFunnel` already returning per-step data, aggregating to sequence-level metrics is client-side math.
**Touch points:** `apps/desktop/src/components/sequence/StepCanvas.tsx`, `apps/desktop/src/pages/Sequences.tsx:101-134`, `apps/desktop/src/lib/api-client.ts:6173-6187`
**Acceptance:**
  - Detail view header shows a 4-6 tile stat strip (entered, completed, completion %, drop-off step, avg duration) computed from funnel data
  - Tiles link to the corresponding drill (clicking "drop-off step" scrolls to and highlights that node)
  - Sparkline of last 30 days entries if the timeseries endpoint exists; otherwise hide it cleanly
  - Loading state has skeleton tiles matching layout
  - Empty state (no runs yet) shows a single "No subscribers have entered this sequence yet" message instead of zero-filled tiles

### 11. Loss-point diagnosis with one-click fix suggestion  [effort: M / impact: mid]
**What:** When per-step analytics show a drop-off greater than a threshold (say 40% relative to previous step) at any node, render an "Investigate" chip on that step that opens a small panel with the step's metrics, comparison vs. preceding/following steps, and 2-3 actionable suggestions: "Rewrite subject with AI", "Shorten the preceding delay", "Try an A/B subject test". Each action wires to the appropriate existing surface (regenerate, edit delay, etc.).
**Why:** The Sequences AI research register calls this out as an emerging standard ("Loss-point diagnosis and auto-remediation") shipped in Klaviyo Composer 2026. Today users would have to manually scan, identify, and conjure their own fix — the platform owes them the diagnosis at minimum. Builds on gaps #1 (per-step analytics) and #2 (regenerate) and turns them from passive data into a closed-loop optimization affordance. Pure client orchestration.
**Touch points:** `apps/desktop/src/components/sequence/StepCanvas.tsx`, `apps/desktop/src/components/sequence/StepEditor.tsx`
**Acceptance:**
  - Steps with drop-off > 40% (configurable) show a yellow "Investigate" chip
  - Click opens a panel with side-by-side comparison vs. neighbouring step rates, narrative explanation ("60% open cliff between step 2 and step 3")
  - Panel offers 2-3 action buttons that route to the matching tool (regenerate, edit delay, open A/B builder if it lands)
  - Dismissable per-session so users do not see the same chip repeatedly
  - Hidden in read-only / viewer mode

### 12. Drafts vs. live publish workflow  [effort: L / impact: mid]
**What:** Add a draft/publish split on the canvas: edits accumulate in a draft state (badged "Unpublished changes (N)") and a "Publish" button promotes them to live. Track the last published step array client-side as the baseline, render a diff modal before publishing ("3 steps added, 1 deleted, 2 reordered"), and keep an in-memory undo history of the last N publishes for the session.
**Why:** Today every edit PATCHes the steps array live — subscribers mid-flow see edits instantly, two collaborators can clobber each other, and there's no rollback. Klaviyo, Customer.io, and Iterable all separate draft from live, with diff and rollback being standard for any team that takes sequences seriously. Even without server-side versioning, a session-local draft buffer plus an explicit publish gate eliminates the worst class of accidental damage and matches the mental model marketers expect.
**Touch points:** `apps/desktop/src/components/sequence/StepCanvas.tsx`, `apps/desktop/src/components/sequence/StepEditor.tsx`, `apps/desktop/src/pages/Sequences.tsx`
**Acceptance:**
  - Local edits update a draft buffer, NOT a live PATCH; canvas header badges "N unpublished changes"
  - Publish button opens a diff modal listing added/removed/modified/reordered steps with before/after preview
  - Confirm publishes via the existing PATCH; cancel keeps the draft buffer
  - "Discard changes" reverts the draft to the last published state
  - Status pill shows "Draft" vs "Live" vs "Live with unpublished edits" clearly
  - Read-only role cannot enter draft state (the existing `canMutate` gate stands)

### 13. Pause / Resume / Archive controls in the canvas header  [effort: S / impact: mid]
**What:** Bring the pause/activate/archive controls from the legacy slideover (SequenceDetailSlideover.tsx:284-316) into the active canvas header as a status dropdown next to the sequence name. The same PATCH endpoint applies; UI gains a confirm-on-pause overlay because pausing an active sequence affects live subscribers.
**Why:** The list shows a status badge but offers no way to change status from the detail view. Users open a sequence to investigate a problem and have to back out, find the legacy controls, and the legacy slideover is unreachable from the list (per the file-header comment). Standard control on every journey tool. Tiny scope — three API calls already exist.
**Touch points:** `apps/desktop/src/pages/Sequences.tsx:101-134`, `apps/desktop/src/components/SequenceDetailSlideover.tsx:284-316`, `apps/desktop/src/lib/api-client.ts` (`updateSequence` with status)
**Acceptance:**
  - Canvas header shows a status badge that doubles as a dropdown (Active / Paused / Draft / Archived)
  - Selecting Pause from Active state opens a confirm overlay listing active-run count and "These subscribers will hold at their current step"
  - Archive requires text-input confirmation ("type the sequence name to archive")
  - Status PATCH is optimistic with rollback; toast on success/failure
  - Disabled in read-only mode with explanatory tooltip

### 14. Trigger configuration UI (entry conditions)  [effort: M / impact: high]
**What:** Add a "Trigger" card at the top of the canvas that lets the user pick how the sequence starts: list subscription, segment match, custom event, or scheduled. The card is the first element above the steps list. Selection persists via an extended `updateSequence` payload (or a `sequence.trigger` sub-field if the backend supports it). The misleading ValueProp card on the list page goes away once this lands.
**Why:** The list page's ValueProp card promises product event / list subscription / scheduled triggers but no UI exists anywhere to configure them — sequences just exist with no entry condition. This is the most visible promise-vs-product gap on the page. Even if the backend currently only supports list-subscription triggers, the UI should make the configured trigger explicit rather than implicit. Coordinate with backend on the trigger sub-field if it does not exist; if it does, this is client-only.
**Touch points:** `apps/desktop/src/components/sequence/StepCanvas.tsx`, `apps/desktop/src/pages/Sequences.tsx:168-178`, `apps/desktop/src/lib/api-client.ts:6121-6135`
**Acceptance:**
  - Above the first step, a "Trigger" card shows the current entry type with an Edit button
  - Edit opens a picker with options: "When subscriber joins list", "When subscriber matches segment", "On custom event", "On schedule"
  - Each option has the relevant follow-up input (list picker, segment picker, event name, cron/datetime)
  - Trigger persists via `updateSequence` (extend `SequenceUpdateInput` to include trigger config; coordinate with backend)
  - Empty trigger renders a warning chip on the canvas: "No trigger configured — this sequence cannot start"
  - ValueProp card on the list page is removed (replaced by the in-canvas trigger surface)
