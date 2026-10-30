# Desktop App (Windows/macOS) Audit — 2026-06-10

**Scope:** `apps/desktop` — Tauri shell (`src-tauri`, ~1.1k lines Rust), core library (`src/lib`, ~26.5k lines), pages (`src/pages`, ~48k lines), components (`src/components`, ~80k lines), hooks. Backend wiring claims were cross-verified against `apps/api` and `services/voice` where relevant.

**Method:** 11 parallel deep-read review agents, one per subsystem, each instructed to verify claims against actual code (not comments) and to cross-check IPC/event/endpoint wiring by grep. `pnpm typecheck` and `pnpm lint` both pass — everything below is a runtime/logic/wiring issue, not a compile error.

**Severity legend:** 🔴 high · 🟠 medium · 🟡 low. Confidence noted where below high.

---

## Executive summary — the 12 worst items

1. **🔴 Headline analytics rates are mathematically wrong everywhere.** Open/click/bounce rates divide event counts by *number of campaigns* (`campaigns_sent` = `count(DISTINCT campaign_id)` in `apps/api/internal/analytics/analytics.go:545`), not emails sent. Affects `Analytics.tsx`, `DashboardStatGrid.tsx`, `BenchmarksCard.tsx` — values like "150000.0%" are possible, and the benchmarks comparison is permanently pinned. (§1.1)
2. **🔴 Offline queue is not identity-scoped and survives sign-out** — queued mutations from user A replay under user B's credentials (cross-tenant writes). (§3.1)
3. **🔴 One transient failure permanently strands a queued offline mutation** — items are marked `failed` after a single replay error, and every flush path (including "Retry all") skips `failed` items. The 6-attempt budget is unreachable. (§3.2)
4. **🔴 Boot race can wipe the stored API key for the session** — `getApiKey()` deletes the legacy localStorage copy before `hydrateSecureApiConfig()` persists to keychain; the hydrate then clobbers the in-memory key with `null`. (§2.1)
5. **🔴 "Sign out" doesn't sign out API-key users** — `fullSignOut()` never clears the keychain API key; the app boots straight back in authenticated. (§2.2)
6. **🔴 Window-focus listener can bypass the MFA challenge** on SignIn — refocusing the window while the TOTP screen is up completes sign-in. (§2.3)
7. **🔴 Lists tabs are wired to endpoints that don't exist** — members list (route never mounted), all five analytics cards (extra `/analytics/` URL segment), and the entire merge-fields tab (3 independent wire-shape mismatches). All render as "no data yet". (§5.1–5.3)
8. **🔴 Import wizard silently discards consent/tags/strategy data** — backend `patchInput` only reads `mapping` and `on_existing`; consent provenance, tags, and auto-create-properties are dropped; the "Replace" dedupe strategy is rejected server-side and the error swallowed. (§5.4)
9. **🔴 Server 500s rendered as healthy empty states** across the api-client (anomalies, digest prefs, layout, folders, saved blocks, segments) and many pages — outages are indistinguishable from "no data". (§4.1)
10. **🔴 Subscribers/Suppressions KPIs computed over a server-truncated sample** (50 rows default, or 100/500 caps) and presented as workspace totals; `InboxProviderHealthCard` can falsely trigger a compliance-grade "Gmail/Yahoo complaint threshold crossed" banner from this broken math. (§1.2–1.4)
11. **🔴 Persisted query cache is destroyed on every boot** — the IDB cache buster is computed before `me` resolves (`anon:anon`), mismatches, and `removeClient()` wipes the cache that offline cold-boot depends on. (§3.4)
12. **🔴 Inbox-placement "prediction" is fed fabricated inputs** (`sender_score: 70`, `OpenRate: 0.22`, etc.) and presented as a real prediction about the tenant's sending. (§4.2)

**Totals:** ~95 findings — 31 high, 38 medium, 26 low. Cross-cutting themes below; full findings follow.

---

## Cross-cutting themes (fix once, resolve many)

- **T1 — Wrong denominator (`campaigns_sent`).** One backend field misunderstanding poisons Analytics, Dashboard stat grid, Benchmarks, and the engagement funnel. Fix: expose/consume a true `emails_sent` count.
- **T2 — Truncated samples presented as totals.** Pages fetch the first page (50/100/200/500 rows) and compute "Total", rates, mixes, and filters over it: Subscribers, Suppressions, InboxProviderHealthCard, SubscribersStatStrip, SuppressionsStatStrip, `suppressionsConvergedApi.get`, AuditInvestigationTimeline, SubmissionsAnalytics.
- **T3 — Relative URLs / missing auth in the Tauri webview.** Anything using a bare path or `window.location.origin` resolves against `tauri://localhost`, not the API host, and carries no bearer token: ConflictModal server-version fetch, AuditInvestigation SSE, MCP CSV export, AuditSinks JWKS copy, forms CSV export, NextBestProductSection, OCSF doc links. The codebase already has the fix (`buildStreamUrl`, `*UrlAuthed`) — it just isn't used in these spots.
- **T4 — `window.confirm`/`window.prompt` known-broken in Tauri but still used.** The repo's own comments document the failure; these flows silently no-op: annotation creation (AnnotationsLayer — makes the whole ~700-line feature unreachable), migration cancel, form-field removal, BYOK key activate/delete, playground history clear, saved-prompt naming, merge-field-schema delete.
- **T5 — Errors swallowed into empty states.** Dozens of loaders coerce `res.error` into `[]`/defaults: api-client 404/500 swallows, DeliverabilityHub, OutboundWebhooks (renders the marketing hero on a 500), AEOSensor, SendTime heatmap, lists AnalyticsTab, CampaignAnalyticsSlideover secondary fetches, AlertPrefsSection (then *persists* the fabricated defaults on first toggle), PreferenceCenterCustomization (same overwrite hazard).
- **T6 — Shipped-but-unreachable code.** Fully built features with zero import sites: PresendVerdictBanner (~280 lines), five suppressions components (~1,000 lines incl. bulk actions, date filter, detail slideover, trend chart), SettingsRail + SettingsNav, webhooks BulkActionsBar, campaign/AudiencePicker (tag targeting), sendtime tz/a11y/responsive helpers (tested but never imported by the UI), NextBestProductSection, tray badge API, `checkForUpdates`.
- **T7 — Frontend wired to endpoints the backend doesn't expose.** Lists members/analytics/merge-fields (wrong or unmounted routes), SMS quiet-hours, SMS keyword-responses, sequence participants, referral payouts, ESP suppression mirror (503 stub backend-side), Mailchimp-parity dashboard methods (hardcoded `{}`), suppressions audit log (TODO).
- **T8 — Dead event wiring between Rust and JS.** Menu/tray items emit events nothing listens to (`menu:docs`, `tray:sign-out`, `tray:about`); JS listens for events Rust never emits (`menu:settings`, `menu:approvals`, `menu:dashboard`, `tray:open`); `postwave:edit-queued-mutation` has zero listeners.

---

## 1. Data correctness — wrong numbers on screen

### 1.1 🔴 `campaigns_sent` used as the rate denominator (T1)
- `src/pages/Analytics.tsx:978-994, 1011-1018, 1301-1355` — open/bounce/unsub rates and the deliverability score divide event counts by campaign count. With 3 campaigns and 5,000 opens: "166,666.7%".
- `src/pages/Analytics.tsx:1011-1018` — engagement funnel mixes units: `Delivered = max(0, campaigns_sent − bounces_total)` clamps to 0; funnel renders inverted/nonsense stages.
- `src/components/dashboard/DashboardStatGrid.tsx:92-107` — same bug; bonus: current window falls back with `campaignsSent || subsAdded` (0 falls through) while previous uses `?? `, so the two windows can use different denominators.
- `src/components/dashboard/BenchmarksCard.tsx:53-66,100-110` — same rates plotted against 0–1 industry benchmarks with `VISUAL_MAX = 0.5`; the tenant's bar is permanently pinned at 100%.

### 1.2 🔴 Subscribers page: truncation + status-mapping errors
- `src/pages/Subscribers.tsx:721-733` — `setRows(list.slice(0, 100))`, no server paging; subtitle, stat strip, filter counts and pagination all present ≤100 rows as the audience.
- `src/components/subscribers/SubscribersStatStrip.tsx:65-127` — page fetches with no `per_page` (server default 50); `rows.length` labeled **Total**, rates derived from it.
- `src/pages/Subscribers.tsx:116-131` — `engineStatusToUi` has no case for `disabled`/`unconfirmed`; both render and filter as **Subscribed** (also a write hazard: re-saving the select flips them to `enabled`).
- `src/pages/Subscribers.tsx:87-107` — the "Bounced" chip can never match (writes collapse bounced→blocklisted; engine has no `bounced` status); dropdown selection reverts after reload.

### 1.3 🔴 Suppressions: KPIs/search/pagination over first 50 rows
- `src/pages/Suppressions.tsx:117-145,177-194` + `src/components/suppressions/SuppressionsStatStrip.tsx:37-67` — no `per_page` sent, server `total` discarded. 10,000-suppression tenant sees "Total 50", "Page 1 of 1", and search misses everything past row 50.
- `src/lib/api-client.ts:15127-15151` — `suppressionsConvergedApi.get` fetches first 200 rows and fabricates a 404 for anything beyond — reports suppressed addresses as *not suppressed* (compliance falsehood). Same pattern in `subscriptionTypesApi.get` (15319).

### 1.4 🔴 `src/components/analytics/InboxProviderHealthCard.tsx:220-267, 314-317, 487-520` — per-provider complaint/bounce "rates" divide suppression rows by current-subscriber rows, both capped at 500 and from disjoint populations; can falsely display the red "crossed the 0.3% Gmail/Yahoo complaint threshold" banner. Card shows the page's date-range label while ignoring the range entirely.

### 1.5 🟠 Other wrong-math findings
- `src/components/forms/FormsStatStrip.tsx:35-48` — "Avg conversion" weighted by its own numerator (submissions), systematically inflating the KPI (verified: 25.5% true → ~49% shown).
- `src/components/domains/CustomDomainsStatStrip.tsx:88-117` — "DNS health" KPI actually displays the domain-verification rate; value and hint can contradict ("100%" in red with "2 broken").
- `src/lib/dashboard-helpers.ts:51-57` — `formatDelta` auto-detects fraction-vs-percent per value (`v > 1 ? v : v*100`); curr/prev can normalize on different scales → fabricated deltas like "+93.5pt".
- `src/lib/dashboard-helpers.ts:100-104` — `sparklinePath` padding applied at the bottom, not the top (inverted); peaks clip at the SVG edge.
- `src/components/charts/LineChart.tsx:98-105`, `BarChart.tsx:78-83` — all-zero data renders y-axis labels "0, 0, -1, -1"; `MultiLineChart` fixed this exact bug but it was never backported.
- `src/components/sequence/StepCanvas.tsx:419-424, 988-995` — branch steps matched to funnel metrics by branch-local position; branch step 1 gets top-level step 1's Reached/Opened/Clicked overlay.
- `src/components/analytics/CampaignAnalyticsSlideover.tsx:44-47` — `fmtRate` guesses units (`>1` = percent); a 0.8% rate can render as 80%; inconsistent with link CTR in the same file.
- `src/components/forms/SubmissionsAnalytics.tsx:156` — weekend shading computed from bucket index, not actual day-of-week.
- `src/lib/email-byte-size.ts:18-19` — Gmail clip threshold `102*1024 = 104448` vs the documented 102,400; under-warns by 2KB at the boundary. Also `utf8ByteLength` fallback miscounts lone high surrogates (61-64) — the `dmarc-format.ts` copy does it correctly.
- `src/components/migration/ProgressView.tsx:365-384` — `deriveResources` labels every not-imported row `failed` (`skipped: 0`); cancelled/skipped rows reported as failures.
- `src/pages/Consent.tsx:57-66` — unknown `source` strings silently bucketed as "api" in a compliance-auditor surface.

---

## 2. Auth & security

### 2.1 🔴 API key wiped by boot-order race — `src/lib/api-client.ts:1121-1126, 1211-1241`
`getApiKey()` lazily migrates the legacy localStorage key into memory and **deletes it** without writing to keychain. If any request fires before async `hydrateSecureApiConfig()` completes, hydrate finds empty keychain + empty localStorage and sets `cachedApiKey = null`, clobbering the live key. Silent sign-out; key never persisted anywhere.

### 2.2 🔴 `fullSignOut()` never clears the API key — `src/lib/auth.ts:69-77`
Docstring and the AccountMenu confirm dialog promise the local API config is cleared; only the session cookie/hint are. After reload, `detectSession()` falls back to the keychain key and boots back in authenticated. (Settings' "Sign out and reset" works only because it separately calls `clearApiConfig()`.)

### 2.3 🔴 MFA bypass via window-focus listener — `src/pages/SignIn.tsx:172-184` (confidence: medium)
The focus handler calls `getAuthMe()` and on any success calls `props.onSignedIn()` — with no `needMfa`/`totp_enabled` check. The password flow proves `/me` succeeds before the TOTP challenge, so refocusing the window while the MFA screen is up completes sign-in around it.

### 2.4 🟠 Other auth/security findings
- `src/lib/auth.ts:136-153` — `extractAuthToken` matches `magic`/`reset` in any path segment of any action/scheme (`moosewave://campaign/magic?token=x` triggers the magic-link consume flow) — login-CSRF-shaped widening; the documented `https://app.moosewave.com` web-bounce variants are dead code.
- `src/App.tsx:313-354 vs 395-408` — boot race: `detectSession()` unconditionally `setBoot("signin")/("ready")` and can clobber the magic-link/reset screens set by the deep-link handler; cold-start magic links intermittently dump the user on SignIn with the token lost.
- `src/lib/auth.ts:41-61` — `detectSession()` conflates network failure with 401: offline launch destroys the remembered session hint and shows SignIn (in an app with a whole offline subsystem).
- `src-tauri/tauri.conf.json:28-30` — CSP allows `connect-src https:`, `frame-src https:`, `img-src https:` (any HTTPS origin) and ships dev `localhost` entries in prod; exfil/iframe surface if any injection lands.
- `src/lib/safe-url.ts:18-19` — open-redirect bypass: `/\evil.com` passes the relative-path check (browsers normalize `\`→`/`); `safeDashboardPath` elsewhere checks `\\` but this one doesn't. Used to validate form success redirects.
- `src/lib/secure-vault.ts:46-67, 82-103` — `vaultGetJSON` deletes encrypted items on *any* error including transient keychain failures; a keychain read failure can regenerate the vault key, silently re-keying the vault and orphaning all existing ciphertext. Also a first-use double-keygen race (two concurrent calls mint different keys).
- `src/lib/sentry.ts:91-121` — `beforeSend` scrubs `event.request` only; fetch/XHR breadcrumbs (which carry `stream_token`/`api_key` query params) are sent unscrubbed. Missing `beforeBreadcrumb`.
- `src/lib/dashboard-url.ts:108-116` — production fallback candidate list includes `http://localhost:3001`/`:3000`.
- `src/components/TotpSetupModal.tsx:114-127, 189-219` — recovery-codes step dismissible via Esc/backdrop without acknowledgement (codes lost; `onEnrolled()` never fires, parent desyncs); clipboard copy toasts success before the promise settles.
- `src/components/hipaa/EvidenceExportButton.tsx:117-125` — `_sha256` computed over the bundle *without* the field but the file embeds it; hashing the downloaded file never matches; canonicalization undocumented — auditors will conclude tampering.
- `src/lib/jsonpath.ts:171-176` — user regex compiled directly on the render path (catastrophic backtracking hangs the main thread); `:20-26` — malformed paths like `$foo` evaluate to the root match, so "exists" triggers fire on garbage paths.

---

## 3. Offline/sync subsystem

### 3.1 🔴 Queue + cache not identity-scoped, not cleared on sign-out — `src/lib/offline-store.ts:24-25` (+ `store.ts:432-450`, `api-client.ts:1572-1640`)
Global localStorage keys; `signOut()` clears only API key/url. Next account on the same machine replays the previous identity's queued writes with the new credentials and reads the previous tenant's cached responses offline.

### 3.2 🔴 `failed` items permanently stranded — `src/lib/outbox.ts:105-112`, `api-client.ts:1611-1630`
A single unsuccessful replay marks the item `failed`; `drainOutbox` treats `failed` as terminal; "Retry all" calls the same flush that skips them. The 6-attempt budget and `moveToDeadLetter` are unreachable via HTTP failures. Replay is one raw `fetch` — no backoff, no retry (the advertised `decorrelatedJitter` is never wired into the drain).

### 3.3 🔴 Replay ordering violations
- `src/lib/outbox.ts:168-181` — when item 1 of a resource bucket fails/conflicts, the loop still replays item 2 (statuses snapshotted at drain start) — the exact reordering the comments claim is prevented.
- `src/lib/outbox.ts:309-322` — "Keep mine" re-enqueues at queue tail; a newer queued edit behind it now replays *before* the overwrite and gets clobbered.

### 3.4 🔴 IDB query-cache destroyed every boot — `src/lib/query-client.ts:79-84`, `App.tsx:303-311, 575-578`
Buster computed as `VERSION:anon:anon` before `me` resolves; mismatch triggers `persister.removeClient()`. The 24h offline persistence effectively never survives a restart for signed-in users.

### 3.5 🟠 Other offline/sync findings
- `src/lib/offline-store.ts:113-116, 431-457` — size pressure silently drops the oldest half of the queue repeatedly, then deletes the whole queue if still over budget — user edits destroyed with no toast/dead-letter.
- `api-client.ts:1572-1640` — successful replay never invalidates TanStack caches; UI shows pre-replay data until staleTime, so reconnect "sync" appears to do nothing.
- `src/lib/query-client.ts:91-125` — paused TanStack mutations are persisted but can never resume (`resumePausedMutations` never called; no default `mutationFn`) — offline campaign/subscriber mutations silently lost across restart.
- `outbox.ts:146-151` + `api-client.ts:1419-1424` — TanStack-level retries re-mint the Idempotency-Key per invocation (defeats server dedupe; up to 6×3 = 18 wire attempts with stacked backoff).
- `api-client.ts:1425-1458` — offline queueing engages only on `navigator.onLine === false`, ignoring the heartbeat-based `onlineManager` built precisely because `navigator.onLine` lies; router-up/WAN-down edits error instead of queueing.
- `src/lib/online-manager.ts:142-157` — `noteRequestSuccess`/`noteRequestFailure` never called anywhere; the documented api-client integration was never wired (heartbeat probes every 30s even under heavy traffic).
- `src/lib/online-manager.ts:82-116` — concurrent probe race can flap to "offline" without probing.
- `api-client.ts:1440-1449` — offline ACK object cast to the caller's response type (`queuedMutationAck(queued) as T`); callers read `res.data.id` → `undefined`, broken optimistic state.
- `src/lib/event-bus.ts:284-305` — named SSE events outside the hardcoded topic list are silently dropped (the "safety net via onmessage" comment is wrong — `onmessage` doesn't fire for named events); new backend topics require a desktop release.
- `src/lib/event-bus.ts:119-134, 352-362` — topic renegotiation during pending backoff delayed up to 30s; backoff doubles on intentional reconnects. `:150-156` — EventSource stays open after the last subscriber leaves.
- `src/lib/offline-store.ts:88-111, 270-280` — every queue read does full sanitize + double-stringify; every item update rewrites the whole store (O(n²) during drains). Multi-window read-modify-write races on one key.
- `src/lib/store.ts:265-280` — `setLiveSubs` no-op guard broken for null/identical values; wakes every store subscriber per SSE tick.
- Conflict resolution is overwrite-or-discard only: ConflictModal "Merge" and QueueTray "Edit" dispatch `postwave:edit-queued-mutation`, which has **zero listeners** (`QueueTray.tsx:214-216, 245-260`, `ConflictModal.tsx:92-99`).
- `ConflictModal.tsx:49-58` 🔴 — the "Server version" diff pane fetches `item.path` relative with no auth (T3); operators resolve conflicts against "(no body)".

---

## 4. Fabricated/simulated data & silent failure (api-client and friends)

### 4.1 🔴 HTTP 500 swallowed into healthy empty payloads
`src/lib/api-client.ts:2199-2275` (dashboard anomalies, digest prefs, layout), `4422-4434` (campaign folders), `11431-11449` (saved blocks), `14616-14630` (merge-field schema), `14763-14777` (saved segments) — all treat **500** like 404 and resolve `{items: []}`/defaults. Outage renders as "no anomalies"/"no saved segments". Variants: `getSubscribersViewPrefs` swallows 401 (14866); suppressions audit log returns an empty page for an endpoint that doesn't exist (15210, explicit TODO).

### 4.2 🔴 Fabricated prediction inputs — `api-client.ts:13089-13123`
`predictInboxPlacement` defaults `google_score: "medium"`, `sender_score: 70`, `OpenRate: 0.22`, `ComplaintRate: 0.0005` instead of tenant data; the Inbox Reality banner presents Primary/Promotions/Spam splits computed from invented numbers as a real prediction.

### 4.3 🟠 Other api-client findings
- `api-client.ts:2420-2439` — four Mailchimp-parity methods resolve hardcoded `{ data: {} }` with no HTTP request.
- `api-client.ts:35` + LLM call sites (4669, 5341, 5354, 3546, 5293, 5531, 14845, 3807) 🔴 — all LLM-backed POSTs inherit the 5s default timeout *and* get retried up to 3× (Idempotency-Key always present → retryable). AI features look flaky; each user attempt can trigger 3 server-side LLM invocations.
- `src/lib/ai-client.ts:251-291, 402-441` — SSE mid-stream failure falls back to JSON and replays the **entire** response into the same `onDelta` sink — partial stream + full regenerated text concatenated in the chat bubble; LLM invoked twice.
- `ai-client.ts:268-291, 478-506` — synthesized fake "typing" stream on the JSON fallback (adds up to 1500ms artificial latency).
- `ai-client.ts:61-76` — context refs resolved serially (N×5s before generation starts).
- `src/lib/http-fetch.ts:170-196` — every mutation auto-retried on 429/5xx; safety rests on every backend route honoring Idempotency-Key, including `POST /campaigns/{id}/send` — double-send risk if any handler doesn't dedupe.
- `api-client.ts:5670-5687` 🔴 — resumable-upload offset clamps the server-acked byte count **upwards** (`Math.max(received ?? end+1, end+1)`); short writes are skipped over, silently corrupting migration CSV uploads.
- `api-client.ts:5647-5669` — migration chunk PUTs use the global 5s timeout with no retry; uploads can never finish on slow uplinks.
- `api-client.ts:12580-12673` — `authRequest` errors omit `kind`; timeout vs invalid-credentials indistinguishable downstream.
- `api-client.ts:12866-12870` — `oauthIsAvailable` catch returns `false` ("hide button") while its own comment says default to showing it.
- `api-client.ts:3882-3918, 4093-4129, 4141-4177, 7206-7243` — blob/download helpers have no abort/timeout; hung server = "preparing…" forever.
- `api-client.ts:11735-11757` — `suppressionsApi.bulkAdd` rewrites minority reasons to the batch's most common reason (compliance-relevant field) with no warning.
- `api-client.ts:16107-16112, 13352-13362` — "Authed" download URL has no auth attached (401s in Tauri); Slack OAuth URL same.
- `api-client.ts:12549-12556` — oversized session hint removed from the wrong storage (localStorage vs sessionStorage); guard re-trips every read.
- `api-client.ts:1459` — outbox flush + localStorage read kicked at the top of *every* online request.
- `api-client.ts:16366-16387` — `frequencyCapsApi.create/update` can resolve `{ data: undefined }` if the server doesn't wrap in `rule`.

---

## 5. Frontend wired to nonexistent/mismatched backend (T7)

### 5.1 🔴 Lists → Members tab dead end-to-end — `src/components/lists/tabs/MembersTab.tsx:81-120, 358-368`
`GET /lists/{id}/subscribers` is defined backend-side (`members.go`) but **never mounted** — always 404. Per-row "Remove" and the fully-built Add-subscribers modal are toast-only stubs ("lands in Wave 2"); the modal closes as if it succeeded.

### 5.2 🔴 Lists → Analytics tab: all five cards 404 — `src/components/lists/tabs/AnalyticsTab.tsx:60-100`
Client requests `/lists/{id}/analytics/growth` etc.; backend registers `/lists/{id}/growth` (no `/analytics/` segment). Errors are coerced to empty states, so every card shows "No … data yet" forever.

### 5.3 🔴 Lists → Merge fields tab wire-incompatible — `src/components/lists/tabs/MergeFieldsTab.tsx:73-163`
(a) reads `items` but server returns `merge_fields`; (b) create omits required `tag` → always 400; (c) edit/delete use `f.id` but rows carry `tag` → `PATCH /merge-fields/undefined`. No operation in the tab can succeed.

### 5.4 🔴 Import wizard data discarded — `src/components/subscribers/ImportSubscribersWizard.tsx:170-222`
Backend `patchInput` decodes only `mapping`/`on_existing`; consent source/url/timestamp, tags, `update_existing`, `auto_create_properties` are silently dropped (GDPR provenance not persisted). "Replace" strategy is rejected (`skip|update|error`) and the failure swallowed — previous strategy silently applies. Patch result unchecked.

### 5.5 🔴 SMS compliance cards target routes that don't exist
- `src/components/sms/SmsQuietHoursCard.tsx:99-184` — `/sms/quiet-hours` CRUD: no route, no table. Card promises TCPA/CRTC enforcement that real gating (`gate.go`) doesn't read.
- `src/components/sms/SmsKeywordResponsesCard.tsx:130-219` — `/sms/keyword-responses`: no route, no table; STOP/HELP behavior is hardcoded server-side and not influenced by this card.

### 5.6 🟠 More dead wiring
- `src/components/sequence/SequenceParticipantsDrawer.tsx` — voice service exposes no participants endpoint; the full drawer (filters/sort/pagination) renders only a "not yet available" notice while the canvas shows an inviting "Subscribers (N)" button.
- `src/components/referrals/ReferralPayoutChecklist.tsx:46-91` — probes `api.listReferralPayouts` which doesn't exist; component always renders `null`. The "Payout checklist" feature never appears.
- `src/components/suppressions/MirrorFromEspModal.tsx` — backend handler short-circuits 503 `not_configured` (`Mirrors` never wired in `main.go`); modal also imported by zero pages.
- `src/pages/AudienceSyncs.tsx:5-23` — entire page is a "Coming soon" stub.

---

## 6. Tauri shell, menus, deep links (T8)

- 🟠 `src-tauri/src/menu.rs:118-120` — Help → Documentation emits `menu:docs`; nothing listens. Silent no-op.
- 🟠 `src-tauri/src/tray.rs:89-97` — tray "Sign out" and "About Moosewave" emit events with no JS subscriber; clicks only focus the window.
- 🟠 `src-tauri/src/menu.rs:111-115` + `main.rs:126` — Cmd+W/close destroys the only window and (no `ExitRequested` handler) exits the app, killing the tray; violates macOS convention.
- 🟠 `src/App.tsx:277-285` — JS listens for `menu:settings/approvals/dashboard` (no such menu items) and `tray:open` (handled Rust-side, never emitted) — dead listeners both directions.
- 🟠 `src-tauri/src/commands.rs:276-320` + `src/lib/tauri.ts:23-27` — updater dead end-to-end: snake_case payload vs TS `version?` field, zero call sites, `active:false`/empty pubkey in conf.
- 🟡 `src/lib/tauri.ts:29-34` — `NotificationOptions.url` documented as click-routing; Rust accepts only title/body/icon and no click handler exists ("Tap to investigate" does nothing).
- 🟡 `src-tauri/src/commands.rs:177-214` — `set_tray_badge` fully implemented, never invoked.
- 🟡 `src-tauri/src/net.rs:61-74` — connectivity watcher is a 1-hour-sleep no-op scaffold; renderer's `"online"/"offline"` branches are dead.
- 🟠 `src/App.tsx:402-405` — deep links discard the resource id (`moosewave://approval/abc123` → generic Approvals list); Rust computes the full route but JS reads only `raw_url`.
- 🟡 `src/App.tsx:469-474` — ⌘M bound to Migrations collides with macOS Minimize (native menu intercepts first).
- 🟡 `src/lib/config.ts:51-54` — `validateApiUrl`'s "required" branch unreachable (empty input silently normalizes to the default URL).

---

## 7. Page/component logic bugs (selected, by surface)

### Audit suite
- 🔴 `src/pages/AuditInvestigation.tsx:91-116` — investigation SSE opened with a relative URL + cookies; never works in the packaged app (T3). Live status panel silently dead.
- 🟠 `src/pages/Audit.tsx:566-589` — stale-filter guard compares `args !== filterArgs` where `args = filterArgs` in the same closure — always false; load-more can append rows from a different filter.
- 🟠 `src/pages/Audit.tsx:405-451` — SSE live-tail effect keyed on `isScrolled`; every scroll transition reconnects the EventSource and drops buffered rows.
- 🟠 `src/pages/Audit.tsx:802-816` — "Request access" button performs no API call; toasts a fabricated "Request sent" confirmation.
- 🟠 `src/pages/AuditSinks.tsx:2033-2067` — "Copy JWKS URL" built from `window.location.origin` (`tauri://localhost`) — unusable in external receivers (T3).
- 🟠 `src/components/audit/AuditInvestigationTimeline.tsx:28-77` — evidence fetched via a single contiguous id-window scan; sparse/older evidence vanishes with a misleading "retention-trimmed" explanation.
- 🟡 `src/pages/Audit.tsx:1334-1358` — heatmap drill-down is a "coming in the next iteration" toast; calendar day-click doesn't apply the documented day filter.

### Campaigns / Templates / Sequences
- 🔴 `src/pages/Templates.tsx:914` + `TemplateDetailSlideover` — slideover favorite makes its own API call, then `onFavoriteChanged` is wired to `onToggleFavorite`, which fires a second call computed from the already-toggled object — **the server immediately reverses the favorite**; grid and slideover stars disagree.
- 🟠 `src/pages/Sequences.tsx:436-494` — the "AI generate" tab is a client-side keyword matcher over curated templates (`sequences-ai-brief.ts` admits no model endpoint exists), presented as AI.
- 🟡 `src/pages/Campaigns.tsx:1108-1125` — A/B winner lift looked up by JSON key insertion order vs variant index (confidence: medium).
- 🟡 `src/components/sequence/StepCanvas.tsx:782-795` — trigger/status PATCHes bypass the If-Match version handshake; next step edit can 412.

### Subscribers / Lists / Tags
- 🟠 `src/pages/Subscribers.tsx:573-582, 697-719` — saved NL segments store an AST but `applySavedSegment` reads `{status?, q?}` — clicking a saved segment changes nothing yet toasts "Loaded segment".
- 🟠 `src/pages/Subscribers.tsx:502-528` — optimistic patch rolls back to a stale full-list snapshot; overlapping patches wipe each other's confirmed changes.
- 🟠 `src/components/subscribers/BulkActionBar.tsx:120-208` — per-row unbounded `Promise.all` fan-out despite shipped bulk endpoints; optimistic suppress writes `status: "unsubscribed"` (not an engine status) and skips reload on success, persisting the desync.
- 🟠 `src/components/SubscriberDetailSlideover.tsx:736-755` — "Unsubscribe" actually blocklists (global suppression) while toasting "Unsubscribed"; badge then shows "Suppressed".
- 🟠 `src/pages/Tags.tsx:14-17, 608-627` — colour filter rail filters on data the backend doesn't persist (per the file's own contract note); 7 of 8 chips can never match (confidence: medium).
- 🟡 `src/pages/Tags.tsx:433-449` — single delete refreshes the list but not the taxonomy; orphan tracking stale.
- 🟡 `src/components/tags/TagDetailSlideover.tsx:196-208` — promised drill-down is just `setSection("subscribers")`; no filter carried.

### Dashboard / Analytics / SendTime
- 🟠 `src/pages/Analytics.tsx:305-327` — custom date-range picker displays the user's exact dates while silently snapping data to 7d/30d/90d presets.
- 🟠 `src/lib/dashboard-notifier.ts:73-99` — milestone dedupe lives in sessionStorage; every app launch fires native notifications for **every** historical milestone (7 notifications for a 12k-subscriber tenant, every start).
- 🟠 `src/pages/SendTime.tsx:199-204, 487-500` — non-404 heatmap errors render the "not enough open signal yet" placeholder (server failure presented as insufficient data).
- 🟠 `src/pages/SendTime.tsx:94-126, 437-458` — "workspace-level" STO disable toggle is a per-device localStorage flag; other operators/devices and the API are unaffected.
- 🟠 `src/components/analytics/InsightsStrip.tsx:60-157` — "per-session" dismissals stored forever in localStorage under stable ids; dismissing one complaint-spike warning suppresses all future ones permanently.
- 🟠 `src/components/analytics/AnnotationsLayer.tsx:651-664` — annotation creation is `window.prompt`, documented broken in Tauri (T4); ~700-line feature unreachable.
- 🟡 `src/pages/Dashboard.tsx:109-122 + 224-258` — duplicate stats fetch per mount/range change (useQuery shadow-read + legacy load); same pattern in Campaigns (double) and Subscribers (triple, `:376-385, 736-767`).
- 🟡 `src/pages/Dashboard.tsx:384-394` — anomaly refetch keyed on object identity; refires every poll tick while an anomaly is active.

### Approvals / Compliance / Privacy
- 🟠 `src/pages/Approvals.tsx:157-203` — KPI memo reads `statRows ?? rows` but deps are `[rows]`; resolved-rows fetch never recomputes the stats — the exact bug the separate dataset was added to prevent.
- 🟠 `src/pages/Compliance.tsx:1086-1165` — framework detail panel never resets state across framework switches; shows the previous framework's attestations under the new name; partial failures leave it permanently.
- 🟡 `src/pages/Compliance.tsx:335-373, 1253-1268` — Article-50 checklist: 4 of 5 items hardcoded `ok: true`; generic gate checklist flips all-green on any attestation.
- 🟠 `src/components/privacy/PreferenceCenterCustomization.tsx:28-39` — load error swallowed; defaults rendered as saved theme; one Save overwrites the tenant's real customization.

### Webhooks / MCP / Forms / Misc
- 🔴 `src/pages/MCP.tsx:604-618` — Export CSV anchor uses a relative unauthenticated URL (T3); 404/401s for desktop users. The page's own SSE was already fixed with `buildStreamUrl`.
- 🟠 `src/pages/MCP.tsx:504-584` — tool-name filter refetches four endpoints per keystroke, no debounce, and tears down/reopens the SSE per keystroke. Window selector doesn't filter the executions table its empty-state copy claims it does (`:755, 1283`).
- 🟠 `src/pages/OutboundWebhooks.tsx:274-334` — load failure renders the marketing hero ("Send your events anywhere") instead of an error; the crafted 404 message is unreachable.
- 🟠 `src/components/webhooks/AlertPrefsSection.tsx:18-50` — load error → fabricated defaults rendered as saved settings; first toggle PUTs the whole object, overwriting real server prefs (T5).
- 🟡 `src/components/webhooks/ReceiverPresetDialog.tsx:57-65` — setState-during-render reset: the last checkbox can't be unchecked; selections leak across presets.
- 🟠 `src/components/forms/SubmissionsAnalytics.tsx:105-130` — Export CSV anchor unauthenticated (admin-scoped route) (T3).
- 🟠 `src/pages/SMSInbox.tsx:140-168, 222-239` — 15s poll replaces the conversation list with page 1, wiping "Load more" results; 10s thread poll auto-scrolls the reader to the bottom every tick (`:604-617`).
- 🟠 `src/pages/Referrals.tsx:151-170` — deleting a milestone POSTs without `expires_at`; api-client sends `expires_at: null` — silently makes a time-bound program open-ended.
- 🟠 `src/pages/Settings.tsx:1274-1422` — sample-data badge never reflects server state (no status fetch); already-seeded tenants see "Empty" + enabled "Load sample data".
- 🟠 `src/pages/APIPlayground.tsx:242-271` — history replay only works if the endpoint form is *not* already mounted; otherwise scrolls and silently restores nothing.
- 🟠 `src/components/DynamicContentPanel.tsx:53-109` — regions refetched per keystroke of the body draft (no debounce), and saved-body byte offsets spliced into the unsaved local draft → corrupted branch previews.
- 🟠 `src/components/CommandPalette.tsx` — Esc closes the palette *and* the dialog under it (never registers on dialogStack, `:911-916`); entity hits navigate to unfiltered sections (`:719-854`); client-side re-ranking drops server-matched hits (`:880-891`); cache comment wrong — every keystroke refetches entire lists (`:443-450`).
- 🟠 `src/components/Modal.tsx:73-117` — focus trap caches focusables on first Tab and never invalidates while open; multi-step modals trap against detached nodes. `size` prop is a typed no-op (`:35-42`).
- 🟠 `src/components/EmailPreviewTabs.tsx:133-145` — the empty-body Recommendations carve-out is unreachable (early return hides the tab strip needed to reach it).
- 🟠 `src/components/onboarding/StepDomain.tsx:50-84` — verified *tracking-only* domains satisfy the sending-domain gate and auto-advance the wizard.
- 🟠 `src/components/tour/TourOverlay.tsx:66-98` — CSS masks don't affect hit-testing; the full-viewport SVG captures clicks over the spotlight — the tour blocks the element it's pointing at (violates its own stated requirement).
- 🟠 `src/components/CursorOverlay.tsx:238-244` — refs read during render; emitter/BroadcastChannel wiring starts late or never until an unrelated re-render.
- 🟠 `src/components/MigrationWizard.tsx:1283-1303` — verify-step "Roll back"/"Re-enter key" CTAs are toast-only stubs; step 4 runs two parallel progress watchers (SSE + 3s poll) for the same job (`:283-344`).
- 🟡 `src/pages/InboundRoutes.tsx:1459-1466` — priority `0` coerced to `100` (`parseInt(v) || 100`); highest-priority rules silently become near-last.
- 🟡 `src/pages/PostwaveAI.tsx:296-318` — mention-search "abort" never aborts the five network calls; only the merge is guarded.
- 🟡 `src/hooks/useSidebarCallout.ts:127-148` — billing/trial/domain callouts read fields that don't exist on the store (`store.tenant`, `me.billing_failure_until`); priorities 1–3 are dead code.
- 🟡 `src/pages/Archive.tsx:212-221` 🔴 — campaign id resolution reads `campaign_id ?? id` but the API returns camelCase `campaignId`; pin/edit/unpublish always fall back to subject-matching the first 200 campaigns — can act on the **wrong campaign** when subjects repeat.
- 🟡 Page clamp missing after list shrinks: `Forms.tsx:194`, `Lists.tsx:186`, `GiftSubscriptions.tsx:201`, `Archive.tsx:255` (Discounts has the fix; not copied).
- 🟡 Double-fetch on mount: `PushSuppressions.tsx:143-155`, `SmsSuppressions.tsx:163-176`, `Suppressions.tsx:148-164`.
- 🟡 `src/pages/SmsSuppressions.tsx:138-161` — partial phone round-tripped to an exact-match server filter (the email twin documents why not to); typing empties the list (confidence: medium).
- 🟡 `src/pages/MagicLinkReturn.tsx:34-66` — StrictMode double-mount strands the page on the spinner (dev only).
- 🟡 `src/pages/AEOSensor.tsx:94-116` — initial `Promise.all` ignores all three error results; failures render as a healthy zero-KPI page.
- 🟡 `src/components/ai/VoiceProfileCard.tsx:78-113` — rebuild/ingest/add/delete errors silently swallowed (429 = button stops spinning, nothing else).
- 🟡 `src/components/settings/ArchiveDomainSection.tsx:127-153` — stale closure (`server` always null in `refresh`); clean non-empty drafts never sync during SSL polling.
- 🟡 `src/components/sms/ReplyComposer.tsx:206-208` — empty composer shows "0 left in segment" instead of 160.
- 🟡 `src/components/sms/TapToTextBlockEditor.tsx:39-44` — QR generated via `api.qrserver.com` (third party, sends short code + keyword) while the header claims "purely client-side"; cross-origin `download` attr ignored.
- 🟡 `src/components/library/AssetPicker.tsx:47-66` — unthrottled 100-row fetch per keystroke.
- 🟡 `src/components/audit/OCSFMappingInfo.tsx:80-113` — doc links are relative repo paths; dead in the webview.
- 🟡 `src/lib/auth.ts:89-111` — `scorePassword` shows "OK" for 8-char passwords the server (≥12) will reject.
- 🟡 `src/lib/format-date.ts:21-35` — bare `YYYY-MM-DD` dates shift a day in negative-UTC-offset timezones; the promised consolidation of 18+ local `fmtDate` copies also never finished.
- 🟡 `src/lib/sentry.ts:147-159` — pre-init `captureException` drops events (no queue).
- 🟡 `src/lib/telemetry.ts:196-221` — `identify()`/`reset()` exported, documented for sign-out, never called.
- 🟡 `src/lib/auditScopes.ts:57-67, 107-110` — fetch failure self-grants `audit:read` (UI-gating only); `refresh()` resets cache without notifying subscribers.
- 🟡 `src/hooks/useOnboardingProgress.ts:188-241` — unhandled fallback rejection; per-render localStorage parse as effect dep; cache not tenant-scoped.
- 🟡 `src/hooks/useOptimisticMutation.ts:86-111` — overlapping mutations corrupt rollback (no cancelQueries/concurrency handling).
- 🟡 `src/components/Toast.tsx:17-19 vs 204-216` — action click dismisses immediately, contradicting the documented contract.
- 🟡 `src/components/TopBar.tsx:128-142` — unread dot computed once on mount; the documented panel-close re-poll doesn't exist.
- 🟡 `src/pages/SCIM.tsx:149-154` — "Mint a staging token" CTA silently no-ops for non-admins.
- 🟡 `src/pages/SendingSettings.tsx:728-797` — "IP pool: Shared" is hardcoded copy.
- 🟡 `src/pages/Settings.tsx:302` — "Theme picked" milestone always complete (theme always has a value).
- 🟡 `src/pages/AuditAlerts.tsx:127-187` — keyless fragment in `rules.map` risks mis-reconciliation of the expandable row.
- 🟡 `src/pages/Assets.tsx:451-499` — bulk delete `break`s on first 409; remaining selected assets silently skipped with a success toast.
- 🟡 `src/components/subscribers/ImportSubscribersWizard.tsx:195-222` — re-clicking import leaks a 2s poll interval.
- 🟡 `src/lib/sequences-ai-brief.ts:172-174` — word-boundary check is dead code; "cart" matches "cartoon".
- 🟡 `src/components/PresenceIndicator.tsx` — avatar stack renders "user-1234" server placeholders as teammate identities.

---

## 8. Dead code shipped to production (T6)

| What | Where | Size/impact |
|---|---|---|
| PresendVerdictBanner (claims to replace 3 legacy banners; legacy pair still mounted) | `src/components/PresendVerdictBanner.tsx` | ~280 lines unreachable |
| Suppressions bulk actions, date-range filter, detail slideover, trend chart, ESP mirror | `src/components/suppressions/{BulkActionsMenu,DateRangePopover,SuppressionDetailSlideover,SuppressionsTrendChart,MirrorFromEspModal}.tsx` | ~1,000 lines; Suppressions page lacks all of it |
| Settings navigation (both generations) | `settings/SettingsRail.tsx`, `settings/SettingsNav.tsx` | deep-link/anchor UX doesn't exist |
| Webhooks bulk enable/disable/delete bar | `webhooks/BulkActionsBar.tsx` | built, never mounted |
| Campaign tag-targeting audience picker | `campaign/AudiencePicker.tsx` | tag targeting unreachable |
| SendTime timezone toggle, a11y summary, mobile layout | `sendtime/{tz,a11y,responsive}.ts` | only imported by tests |
| NBP settings panel (also wrong-origin fetch) | `settings/NextBestProductSection.tsx` | dead + broken |
| Tray badge, updater check, notification click-routing | `commands.rs` / `tauri.ts` | shipped plumbing, zero callers |
| `RunStep` migration component | `MigrationWizard.tsx:1071-1145` | kept alive via `void RunStep` |

---

## 9. Verified clean (for confidence calibration)

`usePoller`, `useDialogStack`, `useSlideoverBehavior`, `sse.ts`, `query.ts`, `query-keys.ts`, `pending-mutations.ts` key factory, `stats.ts` (A&S erf approximation, pooled SE, p-values hand-verified), `dmarc-format.ts`, `http-fetch.ts` core (jitter/Retry-After/abort), `stream-payload.ts`, charts Donut/Funnel/Heatmap/Sparkline math, deliverability/* wiring, Migrations.tsx SSE lifecycle, tour targets, dmarc components math, Discounts, CustomDomains, Agency, PrivacyIncidents, PrivacyPortal pages, and `pnpm typecheck` + `pnpm lint` pass clean.

---

## Suggested fix order

1. **Data lies (T1, T2, §4.1, §4.2)** — wrong metrics and fake-empty error states are the worst kind of bug for a marketing analytics product: silently wrong, trusted, compliance-adjacent.
2. **Auth & identity (§2.1–2.3, §3.1)** — key-wipe race, sign-out that doesn't, MFA bypass, cross-tenant queue replay.
3. **Offline/sync (§3.2–3.5)** — the subsystem's core promises (replay, retry, conflict, persistence) are each broken at least once.
4. **Backend wiring (§5)** — lists tabs, import wizard, SMS cards: decide ship-or-hide; today they're broken UI presented as features.
5. **Tauri-environment family fixes (T3, T4, T8)** — mechanical, high yield: one `authedUrl` helper sweep, one ConfirmModal sweep, one menu/tray event reconciliation.
6. **Dead code (T6/§8)** — either mount it (much of it is finished work!) or delete it.
