# Remaining half-implemented / unwired features — 2026-06-10

State of the desktop app after branch `fix/desktop-audit-20260610` (commit `aa045a25`).
That branch fixed all *bugs* from `AUDIT-DESKTOP-2026-06-10.md`; what remains below is
*missing functionality* — features whose UI is honestly disabled, statically labeled, or
absent because the backend (or a product decision) is needed to finish them.

## A. Frontend ready (or honestly disabled) — blocked on backend endpoints

| # | Feature | Frontend state | Backend work needed |
|---|---|---|---|
| A1 | **List membership editing** — add/remove subscribers on a list | `MembersTab` read path works; Add/Remove buttons disabled ("ships with the Wave-2 API") | `POST/DELETE /api/v1/lists/{id}/subscribers[/{sub_id}]` (handlers don't exist; `members.go` only has GET) |
| A2 | **Per-list suppressions** (GAP-LS-143) | `SuppressionTab` shows tenant-wide recent 50, disclosed in copy | List-scoped suppressions endpoint |
| A3 | **Suppression audit history** (GAP-LS-008) | `SuppressionDetailSlideover` renders "no audit history"; client degrades 404/501→empty | Audit-log *read* endpoint (backend already writes rows) |
| A4 | **Suppressions bulk delete / change-reason** | UI deleted (`BulkActionsMenu`) — `MountX1BulkRoutes` exists in Go but has **zero callers** in main.go, and its handlers target X1 ids while the page lists legacy `email_suppressions` rows | Mount the bulk routes + reconcile the id model, then rebuild the UI (git history has it) |
| A5 | **Suppressions trend chart** | UI deleted (`SuppressionsTrendChart`) | `GET /api/v1/suppressions/trend` (no route anywhere) |
| A6 | **ESP suppression mirror** (GAP-LS-026) | UI deleted (`MirrorFromEspModal`) | `Handlers.Mirrors` is never wired in main.go — every run 503s; the actual provider-fetch path is a TODO |
| A7 | **SMS quiet hours** (GAP-LS-145) | Card is a static explainer — states outbound SMS is NOT currently gated by quiet hours | Route + `sms_quiet_hours` table + sender-package enforcement |
| A8 | **SMS keyword auto-responses** (GAP-LS-146/147) | Card is a read-only table of the hardcoded STOP/START/HELP switch in `sms/phone.go` | Configurable keyword-response storage + route; api-client Wave-3 scaffolds (`/sms/quiet-hours`, `/sms/keyword-responses`) are now dead code — delete or implement |
| A9 | **Sequence participants drawer** | Deleted; toolbar button disabled ("requires a newer server") | `GET /voice/sequences/{id}/participants` in the voice service |
| A10 | **Referral payouts checklist** | Deleted (probed nonexistent client methods) | Payout list/update endpoints + api-client wrappers |
| A11 | **Import wizard: consent provenance, tags, auto-create properties** | Steps removed — backend `patchInput` only persists `mapping` + `on_existing` | Extend subscriber_import to store/apply consent fields, tags, property auto-create; then restore the wizard steps (git history) |
| A12 | **Webhooks bulk disable/delete** | `BulkActionsBar` mounted with **re-enable only** | Routes exist server-side; api-client lacks `PATCH/DELETE /webhooks/{id}` wrappers — add wrappers, then enable the other two verbs |
| A13 | **Audience Syncs page** (reverse-ETL: Snowflake/Meta/Google Ads) | Entire page is a "Coming soon" stub | Everything |
| A14 | **Audit "Request access" flow** | Replaced fake toast with informational copy | An access-request endpoint + owner notification |
| A15 | **Audit export download in cookieless contexts** | Goes through `buildStreamUrl`, but backend `StreamTokenAllowedPath` doesn't admit audit routes — token is ignored | Allow audit export paths in the stream-token allowlist |
| A16 | **Slack integration under API-key auth** | Connect button disabled with hint (OAuth start route is session-cookie-gated) | Accept stream-token/API-key auth on the OAuth start route, or document session-only |
| A17 | **Mailchimp-parity dashboard card for session users** | Card hides on 401/403 (endpoints are API-key-scoped) | Session-auth access to `/api/mailchimp/3.0/...` parity routes if the card should show for everyone |
| A18 | **Migration resume-after-cancel** | `MigrationErrorBanners` has no Resume action (commented) | Server resume-cancelled-job endpoint |
| A19 | **Analytics group-by dimensions** | `GroupByMenu` disables some dimensions ("backend doesn't expose per-group time series / per-campaign attribution") | Per-group time-series + attribution endpoints |
| A20 | **Suppression lookup by email** | `suppressionsConvergedApi.get` does a budgeted 5×200 scan; returns honest `scan_truncated` beyond that | An `email`/`q` filter param on the suppressions list endpoint |
| A21 | **Audit evidence by id** | `AuditInvestigationTimeline` cursor-walks with a 5×500 budget | Get-audit-event-by-id (or id-filter) endpoint |
| A22 | **Branch-step funnel metrics** (sequences) | Overlays hidden on branch steps — funnel payload has no branch identity | Key `SequenceFunnel` rows by step id (or branch path), not flat position |
| A23 | **Form conversion weighting** | `FormsStatStrip` shows an unweighted mean, labeled as such | Add visit counts to `FormSummary` so a true visit-weighted rate is computable |
| A24 | **Workspace-level send-time-optimization toggle** | Relabeled "on this device" (localStorage only) | A tenant-level STO setting endpoint |
| A25 | **Dedicated IP pool display** | "Shared (platform default)" hardcoded, labeled as such | Per-tenant pool config endpoint |
| A26 | **Whole-sequence AI drafting** | "From brief (templates)" tab is keyword matching, labeled honestly | Voice-service whole-sequence draft endpoint; then rename back |
| A27 | **Real presence identities** | Avatar stack hidden while server sends `user-NNNN` placeholders (neutral "N viewing" shown) | Presence payload with real user names/ids |
| A28 | **Heatmap "median recipient timezone" mode** | tz helper supports it; not exposed in UI | Per-recipient timezone data in the heatmap payload |
| A29 | **Sample-data seeded status** | Per-tenant localStorage flag + honest "Unknown" state | A status endpoint (`GET` sample-data state) |
| A30 | **Compliance gate verification** | Article-50 / generic gates render as informational rows ("attestation recorded", not verified) | Real per-gate control-state data if verified checkmarks are wanted |
| A31 | **Email preview fidelity** | Backend renderer falls back to passing input through (stub renderer path documented in api-client) | Full server-side MJML/template renderer |

## B. Product/feature work (both sides exist, integration incomplete)

| # | Feature | Current state | To finish |
|---|---|---|---|
| B1 | **Deep-link / palette → entity targets** | `setPendingDeepLinkTarget` consumed by **Approvals, Subscribers, Campaigns** only. Lists, forms, templates, tags, sequences hits still land on bare sections | Add consumption per page (pattern established in Approvals.tsx) |
| B2 | **Tag → subscribers drill-down** | TagDetailSlideover has one "Open Subscribers" button; per-row drill-down removed | Could now be wired via the pending-target mechanism (tag as search query) |
| B3 | **Conflict resolution** | Honestly overwrite-or-discard; "Merge"/"Edit queued mutation" removed (no editor ever existed) | Build a real merge/edit surface for queued offline mutations |
| B4 | **Offline durability for campaigns/subscribers mutations** | Outbox covers forms/segments/templates/lists/tags; TanStack paused mutations deliberately not persisted (were unreplayable) | Extend the outbox replay allowlist or implement mutation resumption with default mutationFns |
| B5 | **Auto-update** | Entire updater plumbing deleted (was inert: `active:false`, empty pubkey, zero call sites) | Decide on auto-update: signing keys, update endpoint, re-add plugin + a "Check for updates" UI |
| B6 | **Notification click-routing** | `url` field removed; clicking a native notification does nothing | Tauri notification click handler → navigate (plugin supports it in v2) |
| B7 | **OS-level connectivity detection** | net.rs no-op watcher deleted; detection = JS heartbeat + focus probe | SCNetworkReachability / NetworkInformation integration if heartbeat ever proves insufficient |
| B8 | **True server-side pagination for Subscribers/Suppressions** | "First N loaded" model (per_page 500/200) with disclosed truncation + server totals | Real paged tables (server-side search/sort/page) |
| B9 | **AbortSignal support in api-client `request()`** | PostwaveAI mention search single-flights batches but can't abort in-flight network calls (commented) | Thread an optional `signal` through `request()`/`httpFetch` |

## C. Deliberate tech-debt deferrals (documented in code)

- **Multi-window offline-queue race** — read-modify-write on one localStorage key; memoized parse landed, locking didn't (`offline-store.ts` comment).
- **jsonpath regex safety** — pattern (512) + subject (10k) caps bound the damage; not a true linear-time engine (RE2-style) — fine for self-authored triggers.
- **CSP `connect-src 'self' https:`** — kept broad because the API host is user-configurable at runtime; tighten if the API URL ever becomes fixed/enumerable.
- **`fmtDate` consolidation** — several components still carry local date formatters (the audit's "18+ copies" note); centralization never finished.
- **api-client Wave-3 scaffolds** — `/sms/quiet-hours` and `/sms/keyword-responses` client methods are now uncalled (cards went static); delete with A7/A8 or when implementing them.
- **`outbox` 429 handling on replay** — replay is single-attempt per drain pass (drain owns the budget); Retry-After from a 429 is not specially honored mid-drain.

## Suggested priorities

1. **A1 + A11** (list membership editing, import consent/tags) — operator-facing CRUD gaps users will hit weekly; backend work is small and the UIs exist in git history.
2. **A4/A5 + A3** (suppressions bulk/trend/audit) — the deliverability/compliance console is the thinnest surface relative to its importance.
3. **B5** (auto-update) — a desktop app with no update channel compounds every other fix's rollout.
4. **B1/B2** (finish deep-link consumption) — mechanism is built; each page is ~30 lines.
5. **A22/A23** (funnel branch identity, form visit counts) — small payload changes that turn "hidden/approximate" metrics into real ones.
