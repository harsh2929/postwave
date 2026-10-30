# Moosewave AI — 2026 Gap Analysis

This document audits the current Moosewave AI surface (chat shell, compose forms, voice profile, agent integrations) against the 2026 industry state-of-the-art across general AI chat UX, marketing-AI platforms, and agentic CRM tooling. It ranks the highest-leverage gaps with effort/impact estimates and concrete acceptance criteria scoped to existing files.

## Current state

What ships today inside `apps/desktop/src/pages/PostwaveAI.tsx` and its component cluster:

- **Tabbed workspace shell** — five modes (Chat, Compose, Subject lab, Pre-send, Agent) with ARIA tablist semantics, mounted form panels via display:none/block to preserve work, and lazy-mounted Agent panel.
- **Streaming chat transport** — SSE-first against `/api/v1/voice/generate` parsing `event: delta` / `event: done` frames, JSON fallback with synthesised ~60cps typing replay, hard caps at 64 KiB/frame and 200k chars total.
- **Cancel mid-stream** — AbortController-backed `streamRef.current?.abort()`; partial bubble finalised with `(cancelled)` if empty.
- **Persistent chat history** — localStorage at `postwave.ai.chat-history.v1`, 100-message cap, 500ms debounce, unmount flush ref, streaming flag stripped on save.
- **Quick-prompt chips** — 5 canned prompts on `HeroEmptyState`; appends `fill` text into composer with smart newline/space joining and rAF refocus.
- **Tone picker** — ARIA radiogroup with 6 named tones + Auto; selected tone appended as `\n\n[Tone: …]` and shown on user bubble; Auto falls back to tenant voice profile.
- **Intent auto-classification** — `inferKind()` regex picks `subject_line / campaign_draft / summary / free_form` before dispatch.
- **Draft handoff to Campaigns** — `Use as draft` CTA fires when server returns structured `draft` or heuristic finds Subject:/markdown headings; pipes `{name, subject, body, preview_text}` via `setPendingCampaignDraft` + `setSection('campaigns')`.
- **Context-ref resolver** — `resolveContextRefs()` walks `AIContextRef[]` for campaign/subscriber/sequence/template/form ids, strips HTML, packages as `[[type:id]]` blocks (capped 12k chars), inline `<error>` placeholders per failing ref.
- **Cmd+Enter to send** — placeholder advertises the binding.
- **Streaming visual indicators** — `aria-live=polite`, zero-width-space placeholder, `.ai-streaming-bar` progressbar.
- **Clear chat with confirmation** — `ConfirmModal` (Tauri-safe), skips dialog when history empty, aborts in-flight stream.
- **Saved Prompts library sidebar** — `postwave.ai.saved-prompts.v1` per-browser, plus server-curated VoiceTemplates from `/api/v1/voice/templates`, graceful degrade on voice-service unavailability.
- **Voice Profile sidebar card** — tenant brand voice, training sources, add-URL flow, rebuild trigger.
- **Status-aware error formatting** — `formatError` translates 404/401/403/429/5xx into operator copy ("Configure it in Settings → AI", "rate limit reached") instead of raw HTTP.
- **Errored-state assistant bubble** — `errored: true` flag, `ai-msg-errored` styling, suppresses Use-as-draft on failure.
- **Auto-scroll history** — rAF de-duplicated scroll-to-bottom, cancels pending frames during fast token streams, cleans up on unmount.
- **Privacy disclosure on empty state** — hero copy explicitly tells the user where prompts go, what context is referenced, and that history is browser-local.
- **ComposeBroadcastForm** — structured form (brief, tone, audience, 1-5 variants) calling `POST /api/v1/ai/compose/broadcast`, with clickable subject-variant rack and `Use as draft` handoff.
- **SubjectLab** — generates 3-8 variants with client-side scoring (length, spam-word regex, ALL-CAPS, merge-field bonus, emoji balance, question-mark bonus) ranked 0-100 with color bands.
- **PresendCheckPanel** — `POST /api/v1/presend/verdict` fans out to EQ Score + voice drift + placement; renders verdict pill + per-component rows.
- **Agent integrations** — `AgentConnectCard` (9 MCP client snippets with copy/download), `AgentKeyCard` (mint/list/revoke with scope chips and one-time plaintext), `CapabilityGallery` (19 capability categories with copyable prompts), `RecentExecutionsStrip` (5s poll of last 8 MCP calls).

## 2026 industry SOTA

### General AI chat UX
- **Markdown + code rendering** with copy buttons on fenced blocks (every major chat UI).
- **Per-message actions** — Copy, Regenerate, Retry, Edit, Branch (ChatGPT, Claude, Gemini, Perplexity).
- **Inline citations** with numbered references (Perplexity 94%, ChatGPT Search, Gemini, Microsoft Copilot, Claude).
- **Conversation branching / edit-to-fork** with Git-style version switcher (ChatGPT, Claude, Gemini, LibreChat).
- **Persistent memory + custom instructions** on by default (ChatGPT Saved Memories, Claude Projects + Memory, Gemini Personalization).
- **Slash commands** as the extensibility surface (Claude Code, Codex CLI, Copilot CLI, Cursor 3.3, Slashprompt).
- **Multimodal attachments** — images, PDFs, audio, video, screenshots (ChatGPT, Claude, Gemini, Grok).
- **Advanced voice mode** — sub-300ms latency with screen/video share (ChatGPT Advanced Voice, Gemini Live, Claude voice).
- **Native multimodal output** — inline image gen with selective region editing (GPT-4o Image Gen 2.0, Gemini).
- **Share-link permalinks** read-only snapshots (ChatGPT share, Claude share, Notion AI links).
- **Hybrid prompt history search** semantic + keyword (ChatGPT, Claude, Gemini, Thredly).
- **Regenerate / stop-and-continue / preserve partial output** as non-negotiable patterns.
- **Deep research agents** with visible thinking trace (Gemini Deep Research, ChatGPT Deep Research, Claude Research, Perplexity Pro).
- **MCP / tool integrations exposed inside chat** (Claude, Cursor MCP, ChatGPT Connectors).
- **Parallel agents / cloud background runs** (Cursor 3 Agents, Claude subagents, ChatGPT Agent, Devin).
- **Artifacts / Canvas side-pane** for iterative document/code editing (Claude Artifacts, ChatGPT Canvas, Cursor Composer).

### Marketing-AI platforms
- **One-prompt full-campaign generation** with human approval gate (Klaviyo Composer, Iterable Nova, Salesforce Agentforce Marketing).
- **Natural-language segment builder** with AI-source tagging (Klaviyo Segments AI, Mailchimp AI Segment Builder, Brevo AI Segmentation, ActiveCampaign).
- **Per-profile send-time RL** with lookalike cold-start (Klaviyo Personalized Send Time, Iterable, Brevo, Mailchimp, ActiveCampaign).
- **In-journey LLM step** as first-class workflow node (Customer.io LLM Actions, Iterable Nova handlebars, Adobe Journey Optimizer).
- **Conversational analytics agent** — plain-English diagnostics joined with revenue (Mailchimp Analytics AI GA, Klaviyo Composer Q&A, ActiveCampaign AI Performance Intelligence).
- **Autonomous customer-service agent paired with marketing CRM** (Klaviyo Customer Agent, HubSpot Breeze Customer Agent).
- **Brand-voice-tuned generative copy + imagery** (Klaviyo Email AI, Mailchimp Email Content Generator, Brevo Aura, Beehiiv, Braze Tone Control, Adobe AJO Firefly, Iterable Copy Assist).
- **Predictive lifecycle metrics with enforcement** — Audience Optimization auto-suppresses at-risk profiles pre-send (Klaviyo, Iterable Nova, Mailchimp Predictive Segmentation, Braze).
- **AI-inbox optimization** for Apple Intelligence / Gmail Gemini summary readiness (Adobe AJO LLM Email Optimizer; Stripo, Litmus guidance).
- **Multi-channel personalized path / channel decisioning** (Braze Personalized Paths, Iterable channel decisioning, ActiveCampaign agents).
- **MCP / chat-app integrations** with Claude and ChatGPT (Mailchimp app inside Claude/ChatGPT US/CA/UK/AU, HubSpot Breeze marketplace, Klaviyo MCP-style).
- **Two-way conversational email** routing to an AI agent (Salesforce Agentforce Marketing Feb 2026 GA).
- **AI-powered deliverability engine** as headline feature (Kit/ConvertKit AI deliverability, Klaviyo, Iterable).

### Agentic CRM / autonomous workflows
- **Multi-day autonomous campaign agents** with continuous re-optimization (Albert.ai, Bloomreach Loomi, Salesforce Agentforce, Adobe Brand Concierge, Klaviyo AI) — 31% ROAS lift documented.
- **Multi-agent handoffs** (researcher → copywriter → reviewer → sender) — first-class Handoff primitive in Microsoft Agent Framework, Writer.com Agent Builder, Salesforce Agentforce, Claude Agent SDK Teams.
- **Persistent cross-session agent memory** via vector + graph + episodic stores (Mem0, Zep, Cognee, Letta, Anthropic Memory/Dreaming May 2026, Google Memory Bank).
- **Policy guards + content guardrails** in 200-300ms (Lakera Guard, AWS Bedrock Guardrails, NVIDIA NeMo Guardrails, Galileo, Future AGI, Maxim).
- **Send-threshold human-in-the-loop approvals** (OpenAI Agents SDK, Braze Sage, Klaviyo, Birdeye Reviews AI) — over-permissioned send-authority is the #1 documented agent risk.
- **Scoped short-lived API tokens** (OAuth 2.1 + RFC 8693 token exchange) — Scalekit, Aembit, BeyondTrust JIT, CyberArk, Curity, AWS Bedrock AgentCore Identity.
- **Agent audit logs with reasoning provenance** — required by EU AI Act Annex III enforcement Aug 2, 2026 (Coralogix, Arize AX, Atlan, Tetrate MCP audit, Waxell, F5).
- **MCP-native marketing tool servers** (Mailjet, MailerLite, Constant Contact, ActiveCampaign, Klaviyo, Knak).
- **Staged-autonomy ladder** with explicit success gates (McKinsey maturity model, Demandbase, Improvado, Birdeye governance).
- **Agent observability + reasoning traces** as procurement requirement (Arize AX, Galileo, Coralogix Agent Tracing, Langfuse, PostHog LLM Analytics).
- **Frontier: agent dreaming + async memory consolidation** (Anthropic Dreaming Managed Agents May 2026, Cognee feedback-driven self-improvement).

### Content quality, accessibility, compliance
- **Inline generative imagery** in composer with bias mitigation + IAB AI Transparency labeling (Marketo+Firefly, HubSpot, Stripo, Litmus, getimg.ai, MindStudio, Hoppycopy).
- **AI alt-text with human review** required by EAA (June 2025) + DOJ Title II (April 2026) — Litmus, Knak, Visme, AltText.ai, Picture Smart.
- **Pre-send accessibility audit** — contrast in both modes, halation flags, semantic landmarks, screen-reader preview (Litmus, Visme, Knak, Spotler, Access Audit).
- **Quantified brand-voice guardrails** — "80% casual / 20% formal" + do/don't lexicons (HubSpot Brand Voice, Typeface, Averi, Mavik Labs, Pressmaster, Jasper Brand Voice) — ~95% usable first drafts.
- **Claim / promise / profanity filters** NLP-based, regulated-industry aware (WebPurify, Sightengine, MediaFirewall, FastPix, Azure Content Moderator).
- **One-click multilingual translation with locale-tone variants** (DeepL, Lokalise, Jenova, Taskade Email Translation Agent, translate.email).
- **Deliverability spam-trigger + AI-pattern detection** (Mailreach, InboxAlly, Folderly, Landbase, Instantly, Mailflow Authority) — 51% of spam now AI-generated; Gmail Gemini filters pattern-match too-perfect grammar.
- **AI content-provenance + disclosure labeling** under IAB framework + EU AI Act Article 50 (Adweek-tracked publisher coalitions, DoubleVerify, IAS, Sprinklr).
- **Agentic AI brand-safety adjacency control** with kill-switches + threshold approvals (HCL Unica AI Guardrails, Envive, FutureAGI, Sprinklr Brand Safety).
- **Screen-reader + assistive-tech preview** with multimodal narration (Freedom Scientific JAWS AI Agent beta summer 2026, Apple VoiceOver/Accessibility Reader WWDC 2026, Equally AI, accessiBe).

## Gaps ranked by impact

### 1. Markdown + code rendering in bubbles  [effort: S / impact: high]
**What:** Render assistant replies through a lightweight markdown parser so headings, lists, tables, fenced code, bold/italic and links display correctly, with a copy button on code blocks. Today `AIMessage` uses `whitespace-pre-wrap` and the literal `#` and `**` characters leak through.
**Why:** Every 2026 chat surface (ChatGPT, Claude, Gemini, Perplexity) ships markdown; without it Moosewave's Subject:/heading-style replies look unfinished and the chat feels a half-generation behind competitors.
**Touch points:** `apps/desktop/src/components/AIMessage.tsx`, `apps/desktop/src/styles.css`
**Acceptance:**
  - An assistant reply containing `# Heading`, `**bold**`, a fenced ```code block``` and a `- list` renders styled, not as raw characters
  - Code blocks expose a per-block Copy button that writes to clipboard and shows a 1.5s confirmation
  - Links render as `<a>` with `rel=noreferrer` and open in the system browser via the existing handler
  - Streaming updates re-render markdown safely without flicker (memoized on content)

### 2. Per-message actions (copy, regenerate, retry)  [effort: S / impact: high]
**What:** Add a hover action row to every assistant bubble with Copy, Regenerate, and (when errored) Retry. Regenerate replays the prior user prompt with the same tone/kind; Retry re-runs after a failure without retyping.
**Why:** Regenerate and Copy are baseline chat affordances in 2026 — users currently have to retype prompts after errors and select-all-copy multi-paragraph drafts by hand.
**Touch points:** `apps/desktop/src/components/AIMessage.tsx`, `apps/desktop/src/pages/PostwaveAI.tsx`
**Acceptance:**
  - Hovering an assistant bubble reveals Copy / Regenerate buttons; errored bubbles also show Retry
  - Copy writes the bubble body to clipboard with a transient checkmark
  - Regenerate finds the matching prior user message, removes the current assistant bubble, and re-streams a fresh reply with the same tone
  - Retry on an errored bubble re-issues the same request and replaces the error in place

### 3. Slash commands in the composer  [effort: M / impact: high]
**What:** Type `/` in the textarea to open a popover menu of canned actions (`/draft`, `/subject`, `/summarize`, `/sequence`, `/clear`, `/new`). Picking one fills the composer with the same templates the empty-state chips use today, and works at any point — not just on a blank chat.
**Why:** Quick-prompt chips disappear after the first user turn (`HeroEmptyState` only renders when `messages.length===0`); slash commands give users a discoverable, persistent verb set that matches the ChatGPT / Claude / Cursor norm.
**Touch points:** `apps/desktop/src/pages/PostwaveAI.tsx`, `apps/desktop/src/components/ai/SlashCommandMenu.tsx` (new)
**Acceptance:**
  - Typing `/` at the start of a line (or after whitespace) opens a popover anchored to the textarea
  - Arrow keys navigate, Enter selects, Esc closes, the popover filters as the user types
  - Selecting a command replaces the `/x` token with the canned fill text and refocuses the textarea cursor at the end
  - Slash menu appears even after the first user turn (not gated on empty state)

### 4. Inline citations / context-used chip strip  [effort: M / impact: high]
**What:** Above each assistant reply, show a chip strip naming what grounded the answer: "Voice profile v3 · 14 subscribers · campaign #1234". Each chip is clickable and opens the underlying resource. Built from the `contextRefs` the client already resolved plus the voice profile state.
**Why:** Inline citations are now the trust contract for AI answers (Perplexity 94%, Claude/Gemini standard); without this, users cannot tell whether grounding actually happened or fell back to generic prompting.
**Touch points:** `apps/desktop/src/components/AIMessage.tsx`, `apps/desktop/src/lib/ai-client.ts`, `apps/desktop/src/pages/PostwaveAI.tsx`
**Acceptance:**
  - Sending a prompt that includes `contextRefs` renders a "Grounded in:" chip row on the resulting assistant bubble
  - Each chip shows resource type + label and routes via `setSection()` to the correct page on click
  - When no refs and no voice profile were used, the strip is omitted (no empty container)
  - Chips persist after reload (stored alongside the message in chat history)

### 5. @-mention context picker in composer  [effort: M / impact: high]
**What:** Type `@` in the textarea to open a typeahead over campaigns / subscribers / sequences / templates / forms (using existing `api.listX` methods). Picking a result inserts a styled token and pushes a `contextRef` onto the request — exposing the `contextRefs` transport that today is only reachable programmatically.
**Why:** `lib/ai-client` already supports `contextRefs` grounding; without an `@` picker the feature is dark, so users cannot wire campaign or subscriber context into chat at all from the UI.
**Touch points:** `apps/desktop/src/pages/PostwaveAI.tsx`, `apps/desktop/src/components/ai/MentionMenu.tsx` (new), `apps/desktop/src/lib/ai-client.ts`
**Acceptance:**
  - Typing `@camp` shows up to 8 campaign matches via `api.listCampaigns` with debounced search
  - Selecting a result inserts a `@[name]` token and adds an `AIContextRef` to the next request
  - The mentioned tokens render as pill spans inside the composer and round-trip into the user bubble
  - Backspace at the end of a token deletes the whole token and removes the ref

### 6. Multi-conversation sessions sidebar  [effort: L / impact: high]
**What:** Replace the single global chat with named sessions: a "New chat" button, a left-rail list of recent conversations (rename / delete / pin), and tenant-partitioned storage keys `postwave.ai.chat.<tenantId>.<sessionId>`. Each session keeps its own messages, tone default, and pinned context refs.
**Why:** Today one tenant overwrites another's chat (privacy footgun called out in the audit), and 100-message truncation silently drops history; multi-session is the table-stakes layout for any 2026 chat product.
**Touch points:** `apps/desktop/src/pages/PostwaveAI.tsx`, `apps/desktop/src/components/ai/SessionList.tsx` (new), `apps/desktop/src/lib/store.ts`
**Acceptance:**
  - Creating a new chat clears the active thread without losing prior sessions
  - Renaming a session persists and survives reload
  - Switching tenants in-session swaps the visible chat list (no cross-tenant leakage in localStorage)
  - Sessions panel shows last-message snippet + relative time and supports keyboard navigation

### 7. Conversation search across history  [effort: M / impact: mid]
**What:** A search input above the session list that filters sessions and messages by substring (case-insensitive). Matches highlight in-line and clicking a result jumps to the session and scrolls to the message.
**Why:** Users accumulate hundreds of chats; without search they cannot find a half-remembered draft or summary, and "history is saved locally" becomes a graveyard rather than a knowledge store.
**Touch points:** `apps/desktop/src/components/ai/SessionList.tsx` (new), `apps/desktop/src/pages/PostwaveAI.tsx`
**Acceptance:**
  - Typing 2+ characters filters sessions by title and matching message snippet
  - Clicking a match opens the session and scrolls the matching message into view with a 1.5s highlight
  - Empty results render an explicit "No matches" state, not a blank list
  - Search uses `requestIdleCallback` / debounce so typing is not janky on 100+ message stores

### 8. Tenant-scoped localStorage partitioning  [effort: S / impact: high]
**What:** Namespace every AI localStorage key by the current tenant id (chat history, saved prompts, agent client preference, etc.) using the active tenant from store. Migrate any existing global keys into the active tenant on first load.
**Why:** Audit calls this out explicitly: today switching tenants in the same browser blends conversations across tenants, which contradicts the page's "tenant-scoped" privacy promise.
**Touch points:** `apps/desktop/src/pages/PostwaveAI.tsx`, `apps/desktop/src/components/ai/SavedPromptsCard.tsx`, `apps/desktop/src/components/ai/AgentConnectCard.tsx`, `apps/desktop/src/lib/store.ts`
**Acceptance:**
  - All AI keys read/write `postwave.ai.<tenantId>.*` rather than a flat key
  - Switching tenant from the sidebar swaps the visible chat + saved prompts to the new tenant's data without a reload
  - A first-time migration moves legacy global keys into the current tenant's namespace exactly once
  - Audit script (or manual repro) shows zero shared chat between two tenant ids

### 9. Suggested follow-up prompts under each reply  [effort: M / impact: mid]
**What:** After an assistant reply finishes streaming, generate 3 short follow-up suggestions based on the reply's intent (extracted client-side via lightweight regex over headings, or asked from the same model as a tiny second call). Render as chips below the bubble; click sends.
**Why:** Once the first user turn lands, the empty-state chips vanish forever and users have nothing to anchor on. Suggested follow-ups are the modern pattern for keeping the conversation moving (Perplexity, ChatGPT, Gemini all ship them).
**Touch points:** `apps/desktop/src/components/AIMessage.tsx`, `apps/desktop/src/pages/PostwaveAI.tsx`, `apps/desktop/src/lib/ai-client.ts`
**Acceptance:**
  - Completed (non-errored) assistant bubbles render up to 3 chips with short follow-up prompts
  - Clicking a chip fills the composer and (optionally) submits in one tap based on a setting
  - Chips are suppressed during streaming and on errored bubbles
  - Follow-ups are derived locally for `kind=campaign_draft/subject_line/summary` so no extra LLM call is required on the happy path

### 10. Auto-grow textarea + token/char counter  [effort: S / impact: mid]
**What:** Replace the fixed `rows={3}` textarea with an auto-growing input (min 3 / max 12 rows), show a live character count (and rough token estimate at chars/4), and let the user queue the next prompt while a stream is in flight (rather than disabling the input).
**Why:** Power users in 2026 expect an auto-growing composer with visible context budget; the disabled-while-streaming behavior makes Moosewave feel slower than ChatGPT/Claude where you can stage the next message.
**Touch points:** `apps/desktop/src/pages/PostwaveAI.tsx`, `apps/desktop/src/styles.css`
**Acceptance:**
  - Textarea expands smoothly between 3 and 12 rows as the user types
  - A char counter (and approximate token count) updates live in the input footer
  - Typing while streaming is allowed; pressing Cmd+Enter queues the message and dispatches it as soon as the prior stream finishes
  - Counter turns muted-warning past 4000 chars and muted-error past 12,000 (the `MAX_CONTEXT_CHARS` cap)

### 11. Edit-and-resend on user turns (branching)  [effort: M / impact: mid]
**What:** Add an Edit pencil to user bubbles. Editing opens an inline textarea seeded with the prior prompt; saving re-runs the assistant from that turn forward, archiving the old branch (small chevron to switch between branches).
**Why:** Branching/edit-to-fork is now a standard chat affordance because LLM outputs are path-dependent; without it users have to type variations as new messages and lose comparability.
**Touch points:** `apps/desktop/src/components/AIMessage.tsx`, `apps/desktop/src/pages/PostwaveAI.tsx`
**Acceptance:**
  - Edit on a user bubble swaps in a textarea seeded with the prior content
  - Saving the edit truncates messages after that point, archives the old branch under the message, and re-runs the assistant
  - A "branch 1/2" control on the edited message swaps between the original and edited timelines
  - Cancel restores the original bubble without losing the active branch

### 12. Latency + token usage badge per turn  [effort: S / impact: mid]
**What:** On the footer of each assistant bubble (after streaming ends), show a small muted badge: "gpt/sonnet · 1.4s · ~820 tok". Latency comes from the streaming wallclock the client already knows; tokens are estimated by char count / 4. A "usage today" rollup lives on the sidebar.
**Why:** Operators billed via the tenant LLM proxy expect at least a directional cost/usage readout; this also makes regressions visible without backend changes.
**Touch points:** `apps/desktop/src/components/AIMessage.tsx`, `apps/desktop/src/pages/PostwaveAI.tsx`, `apps/desktop/src/lib/ai-client.ts`
**Acceptance:**
  - Each assistant bubble shows latency in seconds and approximate token count after streaming
  - Hovering the badge surfaces the exact start/end timestamps and char counts
  - A sidebar "Today" panel aggregates total bubbles, total latency, and token estimate (local only)
  - Errored bubbles do not contribute to the rollup

### 13. Per-variant pre-send verdict + EQ Score in SubjectLab  [effort: M / impact: high]
**What:** In SubjectLab, add a "Score with engine" button per variant that calls `/api/v1/presend/verdict` with the row's subject + the body, then displays the EQ + voice-drift + placement scores alongside the existing client-side heuristic. A "Score all" option fans out for all visible variants in parallel.
**Why:** Today the heuristic regex score and the server EQ/placement engine are siloed; merging them closes the "outcome-grounded scoring" gap called out in the audit and makes SubjectLab actually trustworthy for ranking.
**Touch points:** `apps/desktop/src/components/ai/SubjectLab.tsx`, `apps/desktop/src/lib/api-client.ts`
**Acceptance:**
  - Each variant row exposes a Score button that triggers a verdict request and displays inbox/EQ/voice scores
  - Score-all runs verdict for every visible variant in parallel (capped at 5 concurrent) with a progress indicator
  - Server scores render alongside heuristic scores without overwriting them; tooltips disambiguate the two
  - Failures degrade per-row to a "verdict unavailable" chip; one failure does not block siblings

### 14. Inline composer refinement on Compose drafts  [effort: M / impact: high]
**What:** Below the read-only draft body in `ComposeBroadcastForm`, add a refinement chat strip: "make it shorter", "add a CTA", "change the angle", plus a free-form "refine…" input. Each submit calls `/api/v1/voice/generate` with the current draft as `context_text` and replaces the body in place (with undo).
**Why:** Today Compose is one-shot and any refinement wipes the result; adding a conversational refinement loop closes the biggest "chat-vs-compose" UX gap without backend changes.
**Touch points:** `apps/desktop/src/components/ai/ComposeBroadcastForm.tsx`, `apps/desktop/src/lib/ai-client.ts`
**Acceptance:**
  - Three preset refinement chips and a free-text input appear under a generated draft
  - Submitting a refinement streams a new body that replaces the prior one with a visible diff highlight for ~3s
  - An Undo control restores the previous draft; a "Versions" chevron exposes the last 5 revisions
  - Subject and preview-text remain stable unless the refinement explicitly mentions them

### 15. Conversation export (copy / .md download)  [effort: S / impact: mid]
**What:** A header action in chat mode: "Export" opens a small menu — Copy as markdown, Download .md, Copy as JSON. Renders messages with role labels and timestamps; respects tenant partitioning.
**Why:** Users keep losing chat history to localStorage clears and have no way to share a transcript with a teammate; export is the cheapest unlock for the "share with teammate" and "save to runbook" use cases without building a server-side share endpoint.
**Touch points:** `apps/desktop/src/pages/PostwaveAI.tsx`
**Acceptance:**
  - Export menu opens from the page header and is disabled when there are zero messages
  - Copy-as-markdown writes a well-formed transcript to clipboard with role headings and ISO timestamps
  - Download .md saves `postwave-chat-<sessionTitle>-<date>.md`
  - JSON export round-trips through an import path (future-proof; document but do not build the import in this gap)

### 16. Thumbs-up/down feedback per reply  [effort: S / impact: mid]
**What:** Add small thumbs-up / thumbs-down icons + an optional "why?" textarea to assistant bubble actions. Persist locally per message (tenant-scoped) and POST to a debounced `/api/v1/ai/feedback` if available (silently no-op if 404).
**Why:** Moosewave has a parity-scoring mindset but captures no chat-quality signal; thumbs feedback is the lowest-cost way to start a quality loop and to flag bad outputs for later voice-profile refinement.
**Touch points:** `apps/desktop/src/components/AIMessage.tsx`, `apps/desktop/src/lib/api-client.ts`, `apps/desktop/src/pages/PostwaveAI.tsx`
**Acceptance:**
  - Each assistant bubble shows thumbs-up / thumbs-down buttons in the action row
  - Clicking down-thumb opens a small "tell us why" textarea with a submit button
  - Feedback persists locally and survives reload; a muted badge ("Marked unhelpful") replaces the buttons after submit
  - If `POST /ai/feedback` returns 404 the client silently keeps local-only state without surfacing an error
