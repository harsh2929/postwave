# Feature Roadmap — 2026-06-11

Criteria: (1) implementable with infrastructure already in this repo (each item cites the
existing `apps/api/internal/` package or desktop component that does the heavy lifting),
(2) high love/request probability based on competitor demand signals, (3) positions
Moosewave ahead of Klaviyo / Mailchimp / Customer.io / Braze / beehiiv on that surface.

## Dashboard
- **Goals & pacing** — operator sets KPI targets (list growth, open rate, revenue); cards show progress + "on pace / behind" deltas. Pure CRUD + existing stats. Nobody does goal pacing well.
- **"Explain this spike"** — click any anomaly → AI investigation brief (anomalies endpoint + voice service + the audit-NLQ pattern already shipped). Category-defining.
- **Weekly AI digest email** — digest prefs backend exists (`getDashboardDigestPrefs`); add AI commentary via voice service.

## Campaigns
- **Resend to non-openers, one click, with AI subject remix** — `internal/resend_unopened` + `subject_lab` + `content_remix` all exist. Mailchimp's version is dumb; remix makes it better.
- **Recurring / RSS-to-email campaigns** — `internal/newsletter_feed` exists. Newsletter operators' #1 ask.
- **Pre-send gate: link checker + UTM autotagging** — `internal/link_checker` + `internal/utm_tagging` exist; SendChecklist component already mounts pre-send checks.
- **Holdout / control groups** — `internal/holdout` + `internal/control_group` exist. Braze-grade incrementality measurement; Klaviyo/MC have nothing.
- **Replies inbox + reply analytics** — `internal/campaign_replies` + `reply_analytics` exist; CampaignRepliesSection partially surfaces it. Finish thread view + auto-categorization (OOO / unsubscribe-intent / genuine).

## Subscribers
- **Engagement score everywhere** — `internal/subscriberscore` + `eqscore` + `contact_rating` exist. Score column, score filter chips, score-based smart segments. This is Klaviyo's stickiest feature.
- **Duplicate finder & merge** — `internal/subscriber_dedupe` + `merge` exist; desktop already has DuplicatesModal. Finish the merge flow.
- **Notes + full activity timeline (CRM-lite)** — `internal/subscriber_notes` exists; timeline components partially built.
- **Sunset automation** — `internal/sunset` + `inactive_keys` exist: auto-flag disengaged → re-permission sequence → suppress. Protects deliverability; Klaviyo makes you build this by hand.
- **Validate on entry** — `internal/email_validator` exists; wire into add/import paths.

## Lists
- **Health grade → fix-it actions** — `internal/list_health` exists (badge already in UI); expand into graded recommendations with one-click remediations.
- **Growth source attribution** — `internal/growth_source` exists; per-list "where did these people come from" breakdown.

## Segments
- **Predictive segments** — likely-to-open / churn-risk / next-best-product from `internal/predictive`, `predictenrich`, `subscriberscore`. The Klaviyo killer.
- **Segment overlap visualizer** — pairwise intersection counts is cheap SQL; great UI moment.
- **Recipe gallery** — `internal/preset_segments` exists; one-click "Lapsed 90d", "VIP top 5%", "Window shoppers".
- **Segment growth tracking** — membership count time series (snapshot job + chart).

## Tags
- **Behavior auto-tagging rules** — "clicked X → tag Y", "opened 3 of last 5 → tag engaged" via `internal/zerocopy_triggers` + `trigger_delay`. The desktop already has the jsonpath trigger editor pattern.

## Templates
- **On-brand AI template generator** — the Brand Voice profile (`internal/brand_voice` + voice service) is already built and surfaced; generate full templates that pass the existing voice-drift check. beehiiv/MC AI is generic; yours knows the brand.
- **Inline content optimizer** — `internal/content_optimizer` + `subject_analyzer` exist; squiggly-underline suggestions in the editor.
- **Template leaderboard** — open/click performance per template across campaigns (events join).

## Sequences
- **A/B branches inside a sequence** — `internal/abtests` exists; StepCanvas already renders branches. Closes the Customer.io/Braze gap.
- **Goals & exit criteria** — "exit on purchase" via `internal/conversions`; per-step conversion targets on the funnel overlay you already ship.
- **Stuck-participant alerts** — participants endpoint now exists; alert when N people idle at a step > X days, with one-click nudge.
- **Entry-cohort comparison** — funnel by entry week; pure SQL on existing funnel events.

## Forms
- **Form A/B variants** — `internal/form_variants` exists end-to-end; just needs the desktop UI (you now have visit tracking for significance).
- **Hosted landing pages** — `internal/landingpages` exists; tightly-scoped LP builder (headline/hero/form) beats Mailchimp's bloat.
- **Multi-step preference quizzes** — feed answers into custom fields (`internal/customfields`) for segmentation.

## Analytics
- **Cohort retention curves** — engagement by signup month; pure SQL on the events table. Data teams love it, nobody in email does it well.
- **Revenue attribution** — per-campaign revenue + ROI is available via `internal/conversions` + `commerce`. Per-sequence attribution remains a future build and requires durable sequence/send/conversion linkage before it can be advertised.
- **Scheduled reports** — `internal/scheduled_reports` exists; deliver to email/Slack (`internal/slackint`).
- **Custom dashboard layouts** — the dashboard layout endpoint already exists (`getDashboardLayout`); add drag-to-arrange.

## Deliverability Hub (already strong — extend the lead)
- **Automated warmup ramps** — `internal/domain_warmup` exists; guided day-by-day volume ramps with auto-throttle.
- **Auto-remediation surfacing** — `internal/spam_trap_guard`, `soft_bounce_recovery`, `intelligent_retry` exist; show what the system caught/fixed ("we auto-retried 1.2k soft bounces, recovered 940").
- **Fatigue analysis** — frequency caps UI exists; add sends-vs-engagement-decay curve per subscriber decile.

## SMS
- **SMS broadcasts** — the send gate, quiet hours, keywords, suppressions, and inbox all exist now; the composer is the missing 20%. Most email competitors' SMS is a bolt-on.
- **Cross-channel timeline** — email + SMS events on one subscriber timeline.

## Moosewave AI / MCP (the category-defining tab)
- **Agent routines with approval gates** — "every Monday, draft the newsletter from this feed, queue for approval." MCP + voice service + the Approvals system you already have = workflow nobody else can ship safely.
- **Analytics NLQ** — "which campaign drove the most unsubscribes last quarter?" — clone the shipped audit-NLQ pattern onto analytics.
- **Unified AI copilot rail** — presend verdict, subject lab, voice drift, inbox-reality already exist as separate banners; one rail in the campaign editor.

## Growth suite (Referrals / Discounts / Gifts / Retention / Archive)
- **Referral leaderboard + automated milestone rewards** — payouts now exist; auto-send reward emails via sequences. Matches beehiiv, exceeds it with payout tracking.
- **Paid subscriptions** — `internal/paywall` + `paid_tiers` exist; if completable, this is Substack/beehiiv territory inside an ESP.
- **Archive → social remix** — `internal/archive_content_remix` + `social_capture` + `socialads` exist; turn every campaign into post drafts. Your archive + AEO sensor are already unique.
- **Churn-triggered win-backs** — `internal/retention_offers` exists; trigger from the churn-risk score instead of manual.

## Audit / Compliance (already ahead of everyone — press it)
- **Scheduled evidence packs** — evidence export exists; add cron delivery for auditors.
- **Security alerts → Slack** — `audit_alerts` + `slackint` exist; wire the pipe.

## Settings / Platform
- **API key scope editor UI** — scopes exist in `internal/apikeys`; visual grant editor.
- **Custom objects + CDP transforms** — `internal/customobjects` + `cdp_transforms` exist; lightweight-CDP positioning against Klaviyo's data platform.

## Desktop-native (the moat nobody can copy)
- **"Works on a plane"** — the offline outbox/queue/conflict-editor you just shipped is unique in this market; add offline campaign drafts + a visible offline-mode UX and market it loudly.
- **Global quick-compose hotkey** — OS-level shortcut → compose window; Tauri shell makes this trivial.
- **Tray live counter** — tray badge plumbing already wired; show live subscriber count / queue state.
- **Multi-workspace switcher** — WorkspaceMenu component exists; wire true multi-account.

---

## Top 10, ranked (impact × certainty)

1. **Resend to non-openers + AI remix** — direct revenue lift, infra 90% built.
2. **Engagement scores + predictive segments** — Klaviyo's moat, your packages already exist.
3. **Revenue attribution (campaigns now; sequences after durable linkage)** — the budget-justifying feature.
4. **AI agent routines with approval gates** — category-defining; only possible because Approvals + MCP exist.
5. **Sequence A/B branches + goals/exit criteria** — closes the last automation gap vs Customer.io.
6. **Cohort retention + scheduled reports** — wins data-driven teams.
7. **Sunset → win-back automation chain** — deliverability + retention in one loop.
8. **RSS/recurring campaigns** — table stakes for newsletter operators, package exists.
9. **Form variants + landing pages** — top-of-funnel completeness.
10. **Desktop offline polish + quick-compose** — the structural moat; market it, don't just ship it.

---

# Round 2 — additions from the deep package inventory (2026-06-11)

A systematic sweep of all ~150 backend packages, `packages/`, `services/`, and the
companion apps found these misses. Legend: **[wiring]** backend real + mounted, UI only;
**[mount]** backend real but routes unmounted; **[finish]** scaffold needs completion.

## Campaign editor (round 1's biggest blind spot)
- **Drag-and-drop block editor** [wiring] — `internal/email_blocks` has the block library + ordered-block composer; the desktop still composes raw HTML in a textarea. The single most-requested feature gap vs every competitor.
- **Real cross-client previews** [wiring] — `services/deliverability` already renders in 10 client environments; EmailPreviewTabs currently simulates chrome. Litmus built-in.
- **Accessibility checker in the Send Checklist** [wiring] — `internal/a11y`: 8 WCAG 2.1 AA checks, real and mounted. No ESP ships this.
- **AI campaign translation** [wiring] — `internal/translations`: LLM translation with terminology-dictionary masking, real and mounted. First-class localization; Klaviyo/MC have nothing.
- **Send-window guard at scheduling** [wiring] — `internal/send_window` blocks sends outside business hours.
- **Campaign priority when audiences overlap** [wiring] — `internal/prioritization` filters overlapping sends; Braze-class frequency governance.
- **From-name suggestions** [finish], **one-click clone / save-as-template** [finish] — `from_name_picker`, `campaign_clone`, `campaign_to_template` scaffolds are cheap to land.

## Automations — a whole missing tab
- **Visual Flow Builder** [wiring] — `internal/flowbuilder` + `services/automation` (wait/branch/send/action nodes on Asynq/Redis) are a real execution runtime with no desktop canvas. The #1 competitive checkbox vs Customer.io/Braze; the sequences StepCanvas is the natural base.
- **LLM decision nodes** [wiring] — `internal/llmactions`: per-recipient LLM scoring inside flows with journey attributes. Nobody in the market has this.
- **Inbound-email triggers** [mount] — `internal/inbound_email` is complete but unmounted: "on reply/forward → run automation."

## Deliverability (round 1 under-sold what's already built)
- **Real seedlist placement tests per campaign** [wiring] — the Inbox Reality service polls 30 real inboxes; the desktop only uses the predictor. GlockApps/Validity as a built-in.
- **Reputation aggregation dashboard** [wiring] — Postmaster/SNDS/SenderScore/DNSBL feeds already aggregated in `services/deliverability`.
- **AI Deliverability Diagnostician chat** [wiring] — proprietary diagnostician prompt + 45-case eval corpus exist; conversational "why did placement drop."
- **FBL ingestion surfaced** [mount] — `internal/feedback` parses bounce/complaint feedback loops; show the stream.

## Subscribers / CRM
- **Lifecycle stages** [wiring] — `internal/lifecycle`: HubSpot-parity stages (lead→MQL→SQL→customer), real and mounted. Pipeline view + stage-change automations.
- **Lead scoring rules UI** [wiring] — `internal/scoring`: rules CRUD + background engagement_score recompute.
- **Preference center / subscription types** [mount] — `subscription_types` (complete) + `preferences` (token-gated public page) are unmounted. Per-topic opt-outs beat Mailchimp groups and reduce unsubscribes.

## Analytics
- **Cohort retention heatmap** [wiring] — `internal/cohorts` is REAL AND MOUNTED (round 1 proposed building this — it exists; it's UI-only).
- **Hosted-page web vitals** [wiring] — `internal/webvitals` ingestion already runs.

## Growth & monetization
- **Paid newsletters end-to-end** [mount] — `paywall` + `paid_tiers` + existing gift subs + Stripe webhook plumbing (in affiliates). Substack/beehiiv territory.
- **Affiliate program** [wiring] — `internal/affiliates`: signup, click attribution, conversions, payout admin, Stripe — real and mounted.
- **Private podcast feeds** [wiring] — `internal/podcast`: per-tenant RSS with per-subscriber tokens + entitlement filtering. Paid-podcast tier nobody else has.
- **Fediverse publishing** [finish] — `internal/activitypub`: archive as a followable Mastodon actor (HTTP-signature delivery still deferred). Unique.
- **Signup attack mode** [wiring] — `internal/firewall_attack_mode`: Buttondown-parity bot-score gate, mounted; surface the toggle + insights.
- **Coupon assignment** [wiring] — `internal/onsite_growth`.

## Channels (beyond email + SMS)
- **Mobile push as a channel** [wiring] — `internal/mobilepush` (Expo) is real, and the desktop already ships a Push Suppressions page; add push steps to sequences/flows.
- **Discord + Teams notifications** [wiring] — `discordint`/`teamsint` dispatchers are real; sit them next to the existing Slack integration.
- **Omnichannel failover strategies** [finish] — `internal/omnichannel` catalog exists; "email → push if unopened in 24h → SMS" send strategies.

## Data platform
- **Warehouse connections UI** [wiring] — `internal/warehouse` connection CRUD is real.
- **Self-serve full-tenant exports** [wiring] — `internal/exports` async jobs.
- **Data-residency surfacing** [wiring] — `internal/regions` pins tenants to regions (421 on mismatch); show it, sell it.

## Platform, trust & team
- **Per-API-key budgets & spend caps** [mount] — `internal/budgets` + `cost` ledger: send/dollar caps per key. Combined with MCP, this is "give your AI agent a budgeted key" — no competitor has it and it's perfect for the agent positioning.
- **API usage dashboard** [finish] — `internal/api_usage_dashboard`.
- **Public status page + in-app banner** [mount] — `internal/status` powers status.moosewave.com.
- **Feature flags / beta program UI** [finish] — `internal/feature_flags` per-tenant toggles.
- **Tag taxonomy ops** [wiring] — `internal/tag_taxonomy`: merge/rename with usage counts; round 1 missed that Tags can get this for free.
- **Archive comments** [finish] — `internal/archive_comments`: Substack-parity community under published issues.
- **Support impersonation w/ audit trail** [wiring] — `internal/impersonate`.

## Developer platform — an entire missed category, already PUBLISHED
`packages/` ships a Zapier connector, an official MCP server, a CLI (with `postwave dev` + live event streaming), a VS Code extension (live email preview + deliverability lint), TS/Python/PHP SDKs, a JSX→MJML compiler (`email-react`), and a full OpenAPI 3.1 spec. None of this is surfaced in-app. Add an **Integrations & Developers** tab: connector gallery, SDK quickstarts, in-app API reference (`internal/apidocs`), and grow the existing MCP page into the `developer_marketplace` (mounted).

## Mobile companion (apps/mobile exists — Expo, published)
- **Approve on your phone** — Approvals + push notifications; desktop queues, mobile approves. No competitor has the desktop+mobile combo.
- **Anomaly push alerts**, **pause-send from phone**.

## Migrations
- `packages/migrate` reads ActiveCampaign, HubSpot, Mailchimp, ConvertKit, Brevo, Substack, Beehiiv, MailerLite, Klaviyo, Customer.io, Sendy, CSV — verify the desktop wizard advertises all 12 and lead with "switch in a day."

## Revised top tier (rounds 1+2 combined)
1. Drag-and-drop block editor (`email_blocks`) — table stakes you're missing
2. Visual Flow Builder + LLM nodes (`flowbuilder`, `llmactions`, services/automation)
3. Real inbox-placement tests + reputation dashboard (services/deliverability)
4. Resend non-openers + AI remix; engagement scores + predictive segments (round 1 #1–2)
5. Preference center / subscription types (compliance + churn reduction)
6. Paid newsletters + affiliates + private podcasts (monetization suite)
7. Per-key budgets + MCP marketplace ("budgeted agent keys" — unique)
8. Mobile push channel + approve-on-phone
9. Cohort heatmap + revenue attribution (mostly wiring)
10. AI translation + accessibility checker (instant differentiators, already mounted)
