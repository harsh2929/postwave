/**
 * lib/messagesEn.ts — the BASE message catalogue.
 *
 * This is the "one extracted catalogue" half of the i18n seam (LOVE#22). It is
 * deliberately NOT the whole app: a catalogue that covers three modules and is
 * ENFORCED (see i18nCoverage.test.ts) is worth more than one that covers forty
 * and rots, because the enforced one cannot silently regress.
 *
 * THREE RULES FOR ADDING A MESSAGE, all of which exist because the strings
 * this file replaced were untranslatable by construction:
 *
 *  1. A COUNTED SENTENCE IS A PLURAL ENTRY, NOT A CONCATENATION. The line this
 *     work started from was
 *
 *         `${n} change${n === 1 ? "" : "s"} waiting to send —
 *          ${n === 1 ? "it" : "they"} will go out…`
 *
 *     which assumes a language has exactly two number forms and that the
 *     pronoun agrees with the same boundary. Polish has four categories and
 *     Japanese has one. A plural entry here carries whole SENTENCES per CLDR
 *     category, so a translator can rewrite the grammar rather than fill in a
 *     blank inside English syntax.
 *
 *  2. NEVER SPLIT A SENTENCE ACROSS TWO KEYS. `"Showing {loaded} of {total}"`
 *     keeps the whole frame in one string so word order can move; assembling
 *     "Showing " + n + " of " + m in code freezes English order forever.
 *
 *  3. AN ADJECTIVE IS A PARAMETER, NOT A PREFIX. `"{count} {noun} subscriber"`
 *     lets a translator move the qualifier after the noun (or inflect it),
 *     which `filterNoun + " subscriber"` in TypeScript cannot.
 *
 * `as const` is load-bearing: it is what gives `msg()` literal key types, so a
 * typo in a key is a COMPILE error rather than a string that renders its own
 * key at runtime. It is also what lets the plural/simple split be checked by
 * the type system — see `lib/i18n.ts`.
 *
 * Import-free on purpose (like lib/format and lib/startupGate) so it loads in
 * the node vitest environment.
 */

import { DELIVERABILITY_MESSAGES } from "@/lib/messagesDeliverability";

export const EN_MESSAGES = {
  // ——— Subscribers count line (app/(tabs)/subscribers/index.tsx header) ———
  // The finding's named anchor. What was here before was a nested ternary
  // hand-assembling `Showing ${n} of ${m} ${searching ? "results" : …}`.
  "subscribers.count.showing": "Showing {loaded} of {total}",
  "subscribers.count.all": {
    one: "{count} subscriber",
    other: "{count} subscribers",
  },
  "subscribers.count.filtered": {
    one: "{count} {noun} subscriber",
    other: "{count} {noun} subscribers",
  },
  "subscribers.count.results": {
    one: "{count} result",
    other: "{count} results",
  },
  // English does not inflect "loaded", but the SENTENCE may in a language that
  // agrees the participle with the count — so it stays a plural entry.
  "subscribers.count.loaded": {
    one: "{count} loaded",
    other: "{count} loaded",
  },
  "subscribers.count.loadedMore": {
    one: "{count} loaded · scroll for more",
    other: "{count} loaded · scroll for more",
  },
  "subscribers.noun.subscriber": "subscriber",
  "subscribers.noun.filtered": "{noun} subscriber",
  "subscribers.noun.result": "result",

  // ——— App-wide offline banner (lib/offlineBannerCopy.ts) ———
  "offline.title": "No connection",
  "offline.pending": {
    one: "{count} change waiting to send — it will go out when you reconnect.",
    other:
      "{count} changes waiting to send — they will go out when you reconnect.",
  },
  "offline.failed": {
    one: "{count} change couldn't be sent. Open Diagnostics to review.",
    other: "{count} changes couldn't be sent. Open Diagnostics to review.",
  },
  "offline.action.recheck": "Check again",
  "offline.action.rechecking": "Checking…",
  // The screen-reader label is its own sentence frame: punctuation and the
  // order of the two clauses are both language-specific.
  "offline.a11y.withDetail": "{title}. {detail}",
  "offline.a11y.plain": "{title}.",

  // ——— Display preferences (components/settings/DisplayPreferencesSection) ———
  "display.title": "Display",
  "display.subtitle": "Theme, list density, and which screen the app opens on.",
  "display.theme.legend": "Theme",
  "display.theme.hint": "System follows the OS setting.",
  "display.theme.system": "System",
  "display.theme.light": "Light",
  "display.theme.dark": "Dark",
  "display.density.legend": "List density",
  "display.density.hint":
    "Compact fits more rows on screen. Text size still follows your OS setting.",
  "display.density.comfortable": "Comfortable",
  "display.density.compact": "Compact",
  "display.landing.legend": "Open the app on",
  "display.landing.hint":
    "Where a cold launch lands. Notifications and links still open the screen they point at.",
  // The SHORT tab-bar words, because the setting picks between things on the
  // tab bar and the tab bar is where the user looks to check it took effect.
  "display.landing.dashboard": "Home",
  "display.landing.subscribers": "People",
  "display.landing.campaigns": "Send",
  "display.landing.approvals": "Approve",
  "display.landing.a11y": "Open the app on {label}",
  "display.tabOrder.legend": "Tab bar order",
  "display.tabOrder.hint":
    "The five bottom tabs are fixed so a shortcut, a screenshot, or a support answer means the same thing on every device. Pin your own destinations at the top of More instead.",

  // ——— Dashboard chrome (app/(tabs)/dashboard.tsx) ———
  // The first screen anybody sees, and the finding's named anchor
  // (DASHBOARD#83). Section headings and their "see everything" links are
  // separate keys because a language may need a different noun in the heading
  // than in the link — "Recent campaigns" / "See all" do not share a stem.
  "dashboard.title": "Dashboard",
  "dashboard.range.a11y": "Reporting window",
  "dashboard.section.whatChanged": "What changed",
  "dashboard.section.goals": "Goals",
  "dashboard.section.anomalies": "Detected anomalies",
  "dashboard.section.happening": "What's happening",
  "dashboard.section.recentActivity": "Recent activity",
  "dashboard.section.recentCampaigns": "Recent campaigns",
  "dashboard.link.viewAll": "View all",
  "dashboard.link.viewAll.a11y": "View the full audit log",
  "dashboard.link.seeAll": "See all",
  "dashboard.link.seeAll.a11y": "See all campaigns",

  // ——— Freshness badge (lib/dashboardLiveness.ts, components/…/LiveDot) ———
  // Every spoken form keeps `{age}` INSIDE the sentence rather than being
  // concatenated after it: "last read 4m ago" puts the age mid-clause in
  // English and at the head of the clause in several other languages, and a
  // frame split in code can never move it.
  "dashboard.live.label.loading": "Loading",
  // The never-loaded-AND-failed state. Deliberately not "Loading": the screen
  // beside it is already showing a load-failure notice, and a pill claiming
  // progress contradicts it.
  "dashboard.live.label.failed": "Load failed",
  "dashboard.live.label.stale": "Stale",
  "dashboard.live.label.live": "Live",
  "dashboard.live.label.reconnecting": "Reconnecting",
  "dashboard.live.label.onTimer": "On timer",
  "dashboard.live.label.idle": "Idle",
  "dashboard.live.age.notLoaded": "not loaded",
  "dashboard.live.spoken.loading": "Dashboard has not loaded yet",
  // No `{age}` frame here on purpose: nothing has ever been read, so there is
  // no instant to date this from.
  "dashboard.live.spoken.failed":
    "Dashboard could not load. No figures are shown",
  "dashboard.live.spoken.stale":
    "Dashboard could not refresh. These figures were read {age}",
  "dashboard.live.spoken.live":
    "Dashboard live. Changes arrive as they happen; last read {age}",
  "dashboard.live.spoken.reconnecting":
    "Live updates reconnecting. Refreshing on a timer instead; last read {age}",
  "dashboard.live.spoken.reconnectingBehind":
    "Live updates reconnecting and the timed refresh is behind. Last read {age}",
  "dashboard.live.spoken.onTimer":
    "Live updates are off; the dashboard refreshes on a timer. Last read {age}",
  "dashboard.live.spoken.idle":
    "Dashboard is not updating. These figures were read {age}",

  // ——— Dashboard load failures (lib/dashboardFailure.ts) ———
  // The taxonomy's copy, which the screen renders verbatim. Titles are keyed
  // per KIND rather than reused across kinds even where English repeats
  // ("Dashboard unavailable" covers three): a language that inflects the noun
  // for the cause needs three different sentences, and merging them here would
  // make that impossible without unpicking the taxonomy.
  "dashboard.failure.retry": "Try again",
  "dashboard.failure.invalid.title": "Dashboard unavailable",
  "dashboard.failure.invalid.body":
    "Moosewave sent a dashboard this app couldn't read. Nothing has been lost — try again in a moment.",
  "dashboard.failure.unauthenticated.title": "Your session has expired",
  "dashboard.failure.unauthenticated.body":
    "Your session has expired. Sign in again to load workspace metrics.",
  "dashboard.failure.restricted.title": "Metrics are restricted",
  "dashboard.failure.restricted.body":
    "Your role doesn't include workspace analytics. Ask a workspace admin if you need these numbers.",
  "dashboard.failure.rateLimited.title": "Too many requests",
  "dashboard.failure.rateLimited.body":
    "Moosewave is rate-limiting this device. Give it a moment and try again.",
  "dashboard.failure.server.title": "Dashboard unavailable",
  "dashboard.failure.server.body":
    "Moosewave couldn't build your dashboard just now. This is on our side — try again shortly.",
  "dashboard.failure.noSnapshot.title": "Nothing saved for offline",
  "dashboard.failure.noSnapshot.body":
    "This device hasn't saved a recent copy of these numbers. They'll load as soon as it can reach Moosewave again.",
  "dashboard.failure.offline.title": "You're offline",
  "dashboard.failure.offline.body":
    "You appear to be offline. The dashboard will refresh as soon as you reconnect.",
  "dashboard.failure.unknown.title": "Dashboard unavailable",
  "dashboard.failure.unknown.body":
    "Something went wrong loading the dashboard. Please try again.",

  // ——— The six stat tiles (components/dashboard/DashboardStatGrid) ———
  // The finding's other named strings. `{range}` is a data token ("7d"), so it
  // is a PARAMETER inside the label rather than a suffix glued on in code —
  // a language that says "last 30 days sent" needs to move it.
  "dashboard.tile.subscribers": "Subscribers",
  "dashboard.tile.openRate": "Open rate",
  "dashboard.tile.clickRate": "Click rate",
  "dashboard.tile.bounceRate": "Bounce rate",
  "dashboard.tile.sent": "Sent {range}",
  "dashboard.tile.sequences": "Active sequences",
  "dashboard.tile.destination.subscribers": "Open subscribers",
  "dashboard.tile.destination.analytics": "Open analytics",
  "dashboard.tile.destination.campaigns": "Open campaigns",
  "dashboard.tile.destination.sequences": "Open sequences",
  "dashboard.tile.loading": "Loading metrics",
  // ABSENCE IS NOT ZERO: an unmeasured figure is said as unmeasured. The tile
  // prints an em-dash; VoiceOver has to hear a word.
  "dashboard.tile.notReported": "not reported",
  "dashboard.tile.delta.flat": "no net change {range}",
  // Two entries rather than one with a `{sign}` parameter: the minus is a
  // typographic MINUS (−), not a hyphen, and a translator must be able to see
  // and keep it.
  "dashboard.tile.delta.up": "+{count} {range}",
  "dashboard.tile.delta.down": "−{count} {range}",
  "dashboard.tile.anomaly.bounces":
    "Bounce volume is unusually high against the trailing window.",
  "dashboard.tile.options": "Metric options",
  "dashboard.tile.configure": "Choose which metrics appear on this device",
  "dashboard.tile.configure.hidden":
    "Choose which metrics appear. {count} hidden on this device.",
  // FOUR WHOLE FRAMES, not one frame plus optional fragments. The spoken tile
  // sentence has four shapes (with/without an anomaly × with/without a
  // movement) and each is written out end to end, so a translator can reorder
  // the clauses, change the punctuation between them, or drop the comma splice
  // English uses. Assembling it from `", " + delta` in code — which is what
  // this replaced — freezes all of that.
  "dashboard.tile.a11y": "{label}, {value}. {destination}.",
  "dashboard.tile.a11y.delta": "{label}, {value}, {delta}. {destination}.",
  "dashboard.tile.a11y.anomaly":
    "{label}, {value}. Unusual. {reason} {destination}.",
  "dashboard.tile.a11y.anomalyDelta":
    "{label}, {value}. Unusual. {reason}, {delta}. {destination}.",

  // ——— Campaigns list chrome (CAMPAIGNS#75) ———
  // The flagship surface. Its status-chip announcement has FOUR whole frames
  // rather than one frame with two optional clauses glued on: "needs
  // attention" is a different sentence, not a suffix, and the count clause
  // inflects. What this does NOT claim is the chip WORDS themselves
  // (lib/campaignPolicy) or the row cards — the ratchet grows one file at a
  // time and listing a file it does not clean is the rot it exists to stop.
  "campaigns.title": "Campaigns",
  "campaigns.subtitle.shown": { one: "{count} shown", other: "{count} shown" },
  "campaigns.subtitle.shownMore": {
    one: "{count} shown · more available",
    other: "{count} shown · more available",
  },
  "campaigns.action.new": "New",
  "campaigns.search.placeholder": "Search by name or subject…",
  "campaigns.search.a11y": "Search campaigns by name or subject",
  "campaigns.search.resultNoun": "campaign",
  "campaigns.filter.a11y": "Filter to {label} campaigns",
  "campaigns.filter.a11y.counted": {
    one: "Filter to {label} campaigns, {count} campaign",
    other: "Filter to {label} campaigns, {count} campaigns",
  },
  "campaigns.filter.a11y.urgent":
    "Filter to {label} campaigns, needs attention",
  "campaigns.filter.a11y.urgentCounted": {
    one: "Filter to {label} campaigns, {count} campaign, needs attention",
    other: "Filter to {label} campaigns, {count} campaigns, needs attention",
  },
  "campaigns.folder.a11y": "Filter campaigns by folder",
  "campaigns.sort.a11y": "Sort campaigns",
  "campaigns.agenda.note":
    "Grouped by send day, soonest first. Anything past its send time is listed first, under Overdue.",

  // ——— Governance first-run copy (lib/governanceEmptyStates) ———
  // GOVERNANCE#30. Two clauses, always in this order: what the surface is for,
  // then what makes a row appear. These are the screens whose purpose is least
  // self-evident, so a bare "No SCIM tokens" tells a first-time admin nothing
  // they did not already see by the list being empty.
  "governance.empty.approvals.title": "Nothing needs a decision",
  "governance.empty.approvals.body":
    "Sends and other guarded changes wait here for someone with permission to approve them. A request appears when a teammate starts one.",
  "governance.empty.audit.title": "No activity in this window",
  "governance.empty.audit.body":
    "Every privileged action in this workspace is recorded here — who did it, to what, and when. Widen the time window to look further back.",
  "governance.empty.scimTokens.title": "No provisioning tokens",
  "governance.empty.scimTokens.body":
    "A token lets your identity provider create and deactivate Moosewave accounts automatically. Create one on desktop, then paste it into your IdP.",
  "governance.empty.scimMappings.title": "No role mappings",
  "governance.empty.scimMappings.body":
    "A mapping decides which Moosewave role an IdP group receives. Without one, everyone provisioned by SCIM gets the server's default role.",
  "governance.empty.auditSinks.title": "No streaming destinations",
  "governance.empty.auditSinks.body":
    "A sink forwards this workspace's audit events to your own SIEM or log store as they happen. Add one on desktop; its health and dead letters show up here.",
  "governance.empty.agencyBilling.title": "Agency billing release-held",
  "governance.empty.agencyBilling.body":
    "Consolidated invoicing rolls every child workspace's usage into one estimate the agency pays. An estimate appears here once that invoicing has a fixed rated ledger, a temporal cutoff, a history consumer and proven payer authority.",

  // ——— Governance offline copy (lib/governanceOfflineStates) ———
  // GOVERNANCE#33. The other half of the contract above: what these screens say
  // when the device cannot reach the server. Each pair names the thing that is
  // read LIVE and why a cached answer would be the wrong answer — because the
  // failure being corrected is a screen claiming "no migration jobs" to an
  // operator whose import is running right now.
  "governance.offline.migrationJobs.title": "Reconnect to load migrations",
  "governance.offline.migrationJobs.body":
    "Import jobs are read live from the server, so this is the absence of an answer rather than an answer. Reconnect to see what is running and to cancel it.",
  "governance.offline.migrationJobs.stale":
    "Reconnect before acting on a job. Showing the last loaded progress.",
  "governance.offline.migrationSources.title":
    "Reconnect to load source coverage",
  "governance.offline.migrationSources.body":
    "The matrix of what each provider adapter can import is read from the server. Reconnect to load it.",
  "governance.offline.migrationSources.stale":
    "Reconnect to refresh source coverage. Showing the last loaded matrix.",
  "governance.offline.agency.title": "Reconnect to load your portfolio",
  "governance.offline.agency.body":
    "The child roster and stored audit-portal branding settings are read live. Reconnect to load them; held billing estimates are never requested.",
  "governance.offline.agency.stale":
    "Reconnect to refresh the child roster and stored audit-portal branding. No billing estimate is shown.",
  // Reported BEFORE any per-surface sentence: no workspace is the thing the
  // reader can actually act on, and telling someone who is merely signed out
  // that they are offline sends them to check their wifi.
  "governance.offline.noWorkspace.title": "Reconnect your workspace",
  "governance.offline.noWorkspace.body":
    "This screen needs an authenticated workspace before it can load.",
  "governance.offline.noWorkspace.stale":
    "Reconnect your workspace before refreshing. Showing anything already loaded.",

  // ——— The unsent-writes bar (lib/offlineQueueStatusLine) ———
  // SHELL#67's named anchor. Each clause is a whole plural entry, not a count
  // glued to a status word: English reuses one participle for both numbers and
  // most languages do not, and `${n} ${status}` also freezes number-then-word
  // order. `{count}` is grouped by `interpolate`, so this bar finally agrees
  // with every other number in the app.
  "offline.queue.queued": { one: "{count} queued", other: "{count} queued" },
  "offline.queue.syncing": { one: "{count} syncing", other: "{count} syncing" },
  "offline.queue.failed": { one: "{count} failed", other: "{count} failed" },
  "offline.queue.sent": { one: "{count} sent", other: "{count} sent" },
  "offline.queue.review": "Review",
  // One whole frame, not `label + ". " + summary`: assembling it in code
  // freezes the English sentence break as surely as concatenating a plural.
  "offline.queue.review.a11y": "Review offline change status. {summary}",
  "offline.queue.review.a11yPlain": "Review offline change status.",
  "offline.queue.review.hint":
    "Opens diagnostics, where each unsent change can be retried or discarded",

  // ——— What this phone does NOT do (lib/desktopOnlyCapabilities) ———
  // MAP#73. The More menu's six section headings are a claim about coverage;
  // this block is the app admitting where the claim stops. The body says WHY
  // rather than promising a roadmap — a menu that says "coming soon" about
  // six things is a menu you stop believing.
  "desktopOnly.heading": "Not on this phone",
  "desktopOnly.body":
    "Everything above is here. These parts of Moosewave require a larger screen; availability differs between the desktop app and web — the menu above is not the whole product.",
  "desktopOnly.a11y":
    "Not on this phone. {names}. Availability differs between the desktop app and web.",
  "desktopOnly.affiliates.label": "Affiliates",
  "desktopOnly.affiliates.hint": "Partner links, commission tiers and payouts.",
  "desktopOnly.aiChangelog.label": "AI changelog",
  "desktopOnly.aiChangelog.hint":
    "What the assistant changed in this workspace, and when.",
  "desktopOnly.apiPlayground.label": "API playground",
  "desktopOnly.apiPlayground.hint":
    "Run live Moosewave API calls in the desktop app. Web provides API reference only.",
  "desktopOnly.webhookSimulator.label": "Custom webhook simulator",
  "desktopOnly.webhookSimulator.hint":
    "Craft payloads and inspect live receiver evidence on desktop. Settings still offers the canned signed test.",

  ...DELIVERABILITY_MESSAGES,
} as const;
