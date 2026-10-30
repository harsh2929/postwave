/**
 * lib/messagesDeliverability.ts — the catalogue's deliverability + dashboard
 * additions, split out of `messagesEn.ts` purely for the source-line budget
 * (scripts/check-source-budgets.mjs caps a file at 450 lines and the ceiling
 * is never raised). The three rules in `messagesEn.ts` apply here unchanged;
 * read that file's header before adding a key.
 *
 * It is merged into `EN_MESSAGES` by spread, so `msg()` still sees ONE
 * catalogue and key types stay literal.
 *
 * Import-free, like the rest of the catalogue, so it loads under node.
 */

export const DELIVERABILITY_MESSAGES = {
  // ——— The in-flight send strip (lib/activeSend + dashboard/ActiveSendStrip) ———
  // DASHBOARD#45. Four progress shapes, and they are four KEYS rather than one
  // key with optional halves, because "waiting for the first delivery event"
  // and "4,201 of 12,483 sent" are different sentences in every language, not
  // the same sentence with a blank in it.
  "dashboard.activeSend.label": "Sending now",
  "dashboard.activeSend.untitled": "Untitled campaign",
  "dashboard.activeSend.progress.pending":
    "Waiting for the first delivery event",
  "dashboard.activeSend.progress.unavailable":
    "Live progress couldn't be read just now",
  "dashboard.activeSend.progress.noTotal": {
    one: "{count} message sent so far",
    other: "{count} messages sent so far",
  },
  "dashboard.activeSend.progress.ofTotal": "{sent} of {audience} sent",
  "dashboard.activeSend.others": {
    one: "+{count} more sending",
    other: "+{count} more sending",
  },
  // The rate line is ONE frame with two slots, so the separator and the order
  // move with the language. The slots are pre-formatted percentages or an
  // em-dash — a rate the server did not report is never rendered as 0%.
  "dashboard.activeSend.rates": "{open} opened · {click} clicked",
  // FOUR WHOLE SPOKEN FRAMES, not one frame with a "not reported" phrase
  // dropped into a percentage slot. Substituting a clause into a slot that
  // expects a number produced "click rate not reported clicked" — the exact
  // failure the catalogue's whole-frame rule exists to prevent, caught by
  // __tests__/dashboard-active-send.native.test.tsx.
  "dashboard.activeSend.rates.spoken": "{open} opened, {click} clicked",
  "dashboard.activeSend.rates.spoken.noOpen":
    "Open rate not reported, {click} clicked",
  "dashboard.activeSend.rates.spoken.noClick":
    "{open} opened, click rate not reported",
  "dashboard.activeSend.rates.spoken.neither":
    "Neither open nor click rate has been reported",
  "dashboard.activeSend.a11y":
    "{title} is sending now. {progress}. {rates}. Open this campaign.",
  "dashboard.activeSend.a11y.others":
    "{title} is sending now. {progress}. {rates}. {others}. Open this campaign.",

  // ——— Bounce mix (lib/dashboardBounceMix + dashboard/BounceMixCard) ———
  // DASHBOARD#35. The class LABELS are server-supplied ("Hard bounce") and
  // stay out of this catalogue for the same reason a campaign subject does:
  // they are workspace data, not product copy.
  "dashboard.bounceMix.heading": {
    one: "Why they bounced · last day",
    other: "Why they bounced · last {count} days",
  },
  "dashboard.bounceMix.total": {
    one: "{count} bounce",
    other: "{count} bounces",
  },
  "dashboard.bounceMix.unavailable":
    "The bounce breakdown couldn't be read just now.",
  "dashboard.bounceMix.a11y.row": "{label}, {count}, {share} of bounces.",
  "dashboard.bounceMix.a11y":
    "{heading}. {total}. {rows} Open the deliverability hub.",

  // ——— DMARC screen (app/(tabs)/dmarc.tsx) ———
  // DELIVERABILITY#52's cluster, first whole surface. Two things worth
  // noticing: the share affordance's spoken label is a PLURAL ENTRY (it used
  // to be `length === 1 ? "this report" : \`these ${n} reports\``, an English
  // binary baked into the call site), and the two "insights unavailable"
  // sentences are written out whole rather than assembled from a noun plus a
  // shared frame — gluing "Alignment insights" onto "{label} couldn't be
  // loaded" fixes English subject-verb order for every language downstream.
  "dmarc.title": "DMARC",
  "dmarc.range.a11y": "Report window",
  "dmarc.domain.all": "All domains",
  "dmarc.domain.a11y": "Filter by sending domain",
  "dmarc.result.a11y": "Filter by result",
  "dmarc.result.all": "All",
  "dmarc.result.passing": "Passing",
  "dmarc.result.failing": "With failures",
  "dmarc.share.a11y": {
    one: "Share this report as CSV",
    other: "Share these {count} reports as CSV",
  },
  "dmarc.share.truncated": {
    one: "Shared the first {included} of {count} report — the rest need the web export.",
    other:
      "Shared the first {included} of {count} reports — the rest need the web export.",
  },
  "dmarc.share.failed": "Couldn't open the share sheet.",
  "dmarc.section.rawReports": "Raw reports",
  "dmarc.insights.pickDomain":
    "Pick a single domain to see its alignment trend, failing sources and suggested record changes.",
  "dmarc.insights.offline":
    "Alignment insights are unavailable offline — they show as —, not as \"not configured\".",
  "dmarc.insights.failed":
    "Alignment insights couldn't be loaded, so they show as — rather than \"not configured\".",
  "dmarc.empty.offline":
    "You're offline and no DMARC reports have been saved yet. They'll load when you reconnect.",
  "dmarc.empty.title": "No DMARC reports",
  "dmarc.empty.body":
    "Reports arrive via mailbox forwarding and inbound webhooks. Once configured they appear here as receiving providers send them — typically daily.",
  "dmarc.empty.filtered.title": "Nothing in this window",
  "dmarc.empty.filtered.body":
    "No reports arrived for this filter in the last {window}. Try a wider window.",
  "dmarc.filterMiss.title": "No reports match this filter",
  "dmarc.filterMiss.body":
    "Reports exist in this window, but none for this domain and result.",
  "dmarc.filterMiss.reset": "Reset filters",
  "dmarc.filterMiss.reset.a11y": "Reset the domain and result filters",

  // ——— Custom domains screen (app/(tabs)/custom-domains.tsx) ———
  // The finding's named anchor. Every confirm/toast frame is whole: a
  // destructive confirmation is the last place to freeze English clause order.
  "customDomains.title": "Custom domains",
  // One frame, not `plural(n, "domain") + " · " + verified + " verified"`:
  // both halves and the separator have to be able to move.
  "customDomains.subtitle": {
    one: "{count} domain · {verified} verified",
    other: "{count} domains · {verified} verified",
  },
  "customDomains.filter.all": "All",
  "customDomains.filter.pending": "Pending",
  "customDomains.filter.verified": "Verified",
  "customDomains.filter.a11y": "Filter domains by verification state",
  "customDomains.recheck.a11y": "Re-check DNS for all domains",
  "customDomains.add.a11y": "Add a custom domain",
  "customDomains.health.offline":
    "DNS health is unavailable offline — it shows as —, not as \"not configured\".",
  "customDomains.health.failed":
    "DNS health couldn't be loaded, so it shows as — rather than \"not configured\".",
  "customDomains.verify.ok": "{domain} is verified",
  "customDomains.verify.pending":
    "{domain} isn't verified yet — DNS can take up to 48h",
  "customDomains.verify.failed": "Couldn't check {domain}.",
  "customDomains.remove.title": "Remove this domain?",
  "customDomains.remove.body":
    "{domain} stops serving Moosewave links and its DNS records become inert.",
  "customDomains.remove.warning":
    "Links already sent on this domain will stop resolving.",
  "customDomains.remove.confirm": "Remove",
  "customDomains.remove.ok": "{domain} removed",
  "customDomains.remove.failed": "Couldn't remove {domain}.",
  "customDomains.recheck.queued": "DNS check queued",
  "customDomains.recheck.failed": "Couldn't queue a check.",
  "customDomains.add.ok": "{domain} added — publish its DNS records next",
  "customDomains.add.failed": "Couldn't add that domain.",
  "customDomains.share.failed": "Couldn't open the share sheet.",
  "customDomains.row.a11y.verified": "{domain}, verified",
  "customDomains.row.a11y.pending": "{domain}, pending",
  "customDomains.empty.offline":
    "You're offline and no copy of your domains has been saved yet. It'll load when you reconnect.",
  "customDomains.empty.pending.title": "Nothing pending",
  "customDomains.empty.verified.title": "No verified domains",
  "customDomains.empty.title": "No custom domains",
  "customDomains.empty.body":
    "A custom domain puts forms and tracked links on your own branded URL.",
  "customDomains.empty.cta": "Add a domain",
} as const;
