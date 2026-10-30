# Roadmap features explicitly NOT built in this commit

This commit shipped two of the four features requested. The other two
are documented here with honest scope estimates so the gap is visible
and the eventual implementation doesn't get rushed into the same
marketing-claims-debt the PR #2 audit caught.

## NOT BUILT: Customer.io-class automation builder

**What the roadmap entry asked for:**
- Visual canvas with conditional branches on opens/clicks/replies/custom events
- Pause-on-reply via Gmail thread detection
- Goal events

**What already exists:**
- `services/automation/internal/runtime/` — full execution engine with
  branch.go, engine.go, fanout.go, postgres_resolver.go
- `infra/migrations/0011_automation_state.sql` — automation_executions table
- `infra/migrations/0085_sequence_step_types.sql` — step shape with branches
- `apps/api/internal/replies/` — reply ingestion package
- `apps/api/internal/inbound_email/` — DSN/reply parsing

**What's actually missing:**
1. **Goal events**: a "goal_reached" branch type that ends the
   workflow when a custom analytics event fires (e.g. "purchase").
   The runtime has branch evaluation; it doesn't yet have the
   goal-completion exit semantics.
2. **Reply-pause integration**: the replies package detects inbound
   replies; the automation runtime doesn't subscribe to them as a
   trigger. A new event type (`subscriber.replied`) needs wiring
   from replies/ → runtime/events.go.
3. **Web canvas**: the React Flow editor scaffold exists per the
   PR #2 audit but doesn't render the new branch types or goal nodes.

**Honest scope to ship:**
- Backend: 2-3 days (new event type, goal node, runtime branch eval
  extension, integration tests)
- Frontend canvas: 3-5 days (custom node UI, branch-edge picker,
  goal-node sidebar)
- Total: ~2 weeks of focused work for a real, polished release

**Why it's not in this commit:** shipping a goal node + reply trigger
without the canvas UI = a feature the customer can't see. Shipping
the canvas UI without the backend = a feature the customer can't use.
The honest move is to scope the work as a single 2-week effort and
not stage it as half-baked stubs.

---

## NOT BUILT: Dedicated IPs + automatic warmup curves

**What the roadmap entry asked for:**
- 30-day engagement-driven ramp
- Per-pool reputation tracking
- Auto-rotation on blocklisting

**What already exists:**
- `apps/api/internal/sending/warmup.go` — full 30-day curve
  (50/100/500/1k/2k/5k/.../continuing through Day 30) + EnforceCap
- `apps/api/internal/sending/warmup_postgres.go` — durable state
- `services/deliverability/internal/reputation/` — per-IP + per-domain
  reputation aggregator with Postmaster Tools, SenderScore, DNSBLs

**What's actually missing:**
1. **Engagement-driven ramp adjustment**: the warmup curve is static.
   It should DECREASE when complaint_rate or bounce_rate rises during
   the ramp, then resume when it recovers. Requires reading the
   reputation aggregator's output and feeding it back into
   warmup_postgres.go's daily-cap calculation.
2. **Per-pool reputation tracking**: today's `reputation` package
   tracks per-IP and per-domain. A "pool" abstraction (free_pool,
   paid_standard, paid_pro, paid_reputation, byo) needs to roll IPs
   up — straightforward SQL but it's a new table or materialised view.
3. **Auto-rotation on blocklisting**: when an IP lands on a major
   blocklist (Spamhaus/SpamCop), drain its sends to other IPs in the
   same pool. Requires a coordinated change across the dispatcher
   (route selection), warmup (cap → 0), and blocklist watch
   (the detector that fires the event).

**Honest scope to ship:**
- Engagement-driven ramp: 1-2 days (new SQL view + Go modifier on the
  daily cap)
- Per-pool reputation: 1 day (new aggregation query)
- Auto-rotation: 2-3 days (event hook + dispatcher integration +
  end-to-end test simulating a blocklist hit mid-warmup)
- Total: ~1 week

**Why it's not in this commit:** the existing warmup machine + the
existing reputation aggregator are both load-bearing for paying
customers TODAY. Modifying either without a dedicated load test is
risky. The right path is one bounded PR that wires the three pieces
together with integration tests over a real-ish simulation of a
30-day warmup window.

---

## NOT BUILT: Blocklist watch (80+ lists) + auto-suppress

**What the roadmap entry asked for:**
- Continuous monitoring of 80+ DNSBLs
- Auto-suppress hook when an IP gets listed

**What already exists:**
- `services/deliverability/internal/reputation/blacklist/blacklist.go`
  — DNSBL client with 12 zones (Spamhaus Zen/DBL, SpamCop, Barracuda,
  SORBS, PSBL, CBL, Truncate, s5h, Mailspike, Manitu, UCEPROTECT-1)

**What's actually missing:**
1. **Extending to 80+ lists**: mechanical. Each new DNSBL is one entry
   in DefaultZones plus a per-zone confidence weight (some lists have
   more false positives than others — Spamhaus Zen is gospel, ix.dnsbl
   .manitu.net is signal-with-noise). A real production list needs the
   weights, not just the count.
2. **Continuous monitoring**: today's blacklist.Client is on-demand
   (Fetch() is called by Aggregator.Get()). A continuous worker that
   polls every active sending IP every N hours and writes the results
   to a `blocklist_observations` table doesn't exist.
3. **Auto-suppress hook**: when an IP lands on a list, the existing
   code reports it in the reputation envelope. There's no integration
   that ACTS — e.g. pauses warmup, drains the IP, or alerts ops.

**Honest scope to ship:**
- Extend DNSBL list: half a day (mostly research on weights)
- Continuous monitor: 1-2 days (new worker + table + tests)
- Auto-suppress integration: 1-2 days (event hook + dispatcher
  integration + tier-gating so paid customers get auto-rotation but
  free pool just gets an alert)
- Total: ~1 week

**Why it's not in this commit:** auto-suppress on a blocklist hit
is a customer-impacting action. Shipping it without a per-tenant
configuration ("automatic" vs "alert me, I decide") would be an
opinionated behaviour change. The right shipping order is:
(a) extend the blocklist count and monitor cadence first as
read-only data, (b) add the dashboard surface so customers see the
data, (c) THEN add the per-tenant policy that decides whether to
auto-act on a listing.
