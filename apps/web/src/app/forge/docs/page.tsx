// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";

import { SidebarNav } from "./_components/sidebar-nav";
import { MCP_CATEGORY_COUNT, MCP_TOOL_COUNT } from "@/lib/mcp-catalog-stats";
import {
  AGENT_INTERACTIVE_RELEASE_HOLD_CODE,
  AGENT_INTERACTIVE_RELEASE_STATUS_COPY,
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
} from "@/lib/mcp-release-status";
import { compactProse } from "@/styles/compact-prose";

export const metadata: Metadata = {
  title: "Forge docs — Moosewave",
  description: `Review the release-held MCP source candidate, including ${MCP_TOOL_COUNT} mutable definitions and its qualification boundaries.`,
};

const SECTIONS = [
  { id: "quickstart", label: "Release status" },
  { id: "auth", label: "Auth & API keys" },
  { id: "sandbox", label: "Sandbox" },
  { id: "budgets", label: "Budgets" },
  { id: "approvals", label: "Approvals" },
  { id: "loop", label: "Agent loop" },
  { id: "tools", label: "Tool reference" },
  { id: "transports", label: "Transports" },
  { id: "errors", label: "Errors" },
  { id: "source-license", label: "Source license" },
];

const QUICKSTART = `status: ${MCP_RELEASE_HOLD_CODE}
runnable_setup: false
hosted_connector: unavailable
catalog_provenance: mutable source candidate (${MCP_TOOL_COUNT} definitions)

Release requires a new immutable version and digest, installed-artifact parity,
hosted authorization and tenant isolation, and protocol qualification.`;

const AUTH = `// API keys carry explicit, additive scopes — there is no bare
// "read" or "write". Grant only what the agent needs:
//   read:subscribers   write:subscribers
//   read:campaigns     write:campaigns
//   send:transactional read:reports
//   mcp                audit:* (read, read_pii, configure_sinks, …)
//   admin              (wildcard — grants everything above)
// This is the API scope vocabulary for design review only. MCP setup is held,
// and this page intentionally publishes no credential-bearing configuration.
`;

const SANDBOX_SNIPPET = `// Source-shape illustration only; runtime and recipient isolation are held.

await pw.campaigns.send(campaignId, {
  sandbox: true,
  idempotency_key: "welcome-2026-05-02",
});

// Sandbox is a per-send flag, not a session mode: there is no session-start
// call and no TTL. A key can also be provisioned sandbox-only, which whoami
// reports as sandbox_only: true.

// Check what the simulator has already delivered for a send:
const s = await pw.sandbox.status(campaignId);
// { state: "scheduled" | "running" | "completed", scheduled_remaining: n }

// If no simulator is configured the send is refused with
// 503 sandbox_unavailable rather than quietly going out for real.
`;

const BUDGETS_SNIPPET = `// Budgets attach to API keys, not seats.
// The gateway enforces them; agents see 429 budget_exhausted on overage.

// Budgets are provisioned per key by an operator. There is no
// self-service write endpoint, and no soft/warn tier — the gateway
// enforces one hard limit and returns 429 with Retry-After.

// What an agent CAN do is read its own remaining allowance first,
// via whoami (GET /api/v1/api-keys/me):
const me = await pw.apiKeys.me();
// { sends_per_day, sends_used_today, sends_remaining,
//   cost_cents_per_month, cost_cents_used, cost_cents_remaining }

// null means "no budget configured", which is NOT a zero balance.
// Check for it, or an unlimited key looks exhausted.
if (me.sends_remaining !== null && me.sends_remaining < recipients.length) {
  // throttle, split, or escalate.
}
`;

const APPROVALS_SNIPPET = `// requires_approval makes the send return status: "approval_required"
// with an approval_id and recipients_queued: 0. The campaign itself stays
// in its current status — there is no separate awaiting_approval state.
// A human signs off via CLI, in-app, or Slack one-click.

const draft = await pw.campaigns.create({
  subject: "Q3 launch",
  body_html: html,
  segment_id: segmentId,
  requires_approval: true,
});

// Agent waits (or does other work):
const decision = await pw.approvals.poll(draft.approval_id, {
  timeout_seconds: 600,
});

if (decision.status === "approved") {
  await pw.campaigns.send(draft.id);
}
`;

const LOOP = `// The end-to-end agent loop.

// 1. Read the writer's voice profile.
const profile = await pw.voiceProfile.get();

// 2. Generate a sequence in that voice.
const seq = await pw.sequences.generate({
  template_id: "welcome-7-day",
  variables: { newsletter: "Acme Weekly" },
});

// 3. Predict inbox placement before any real send.
const placement = await pw.inboxReality.predict({
  html: seq.emails[0].body_html,
  subject: seq.emails[0].subject,
});
if (placement.primary_pct < 70) {
  // Run the diagnostician and regenerate.
  const diag = await pw.deliverability.diagnostician({ campaign_id: seq.id });
  // ...apply fixes, re-predict.
}

// 4. Sandbox first.
await pw.campaigns.send(seq.id, { sandbox: true });

// 5. Request approval, then production-send.
const draft = await pw.campaigns.create({
  ...seq.emails[0],
  requires_approval: true,
});
await pw.approvals.poll(draft.approval_id);
await pw.campaigns.send(draft.id);

// 6. Stream events, react.
for await (const e of pw.events.stream({ type: ["opened", "replied"] })) {
  if (e.type === "replied") {
    // Trigger the inbound-reply automation.
  }
}
`;

const TRANSPORTS = `distribution: release-held
stdio: source implementation only; installed artifact not qualified
http: internal loopback evaluation only; no hosted/OAuth deployment
streamable_http_lifecycle: not qualified
runnable_configuration: intentionally unavailable`;

const ERRORS = `// Stable error codes. Agents pattern-match on these.
// 4xx codes are agent-recoverable; 5xx are infra.

400 invalid_request
400 validation_failed          // yes, 400 — not 422
401 no_tenant                  // also: no_session, invalid_signature
401 missing_principal          // no API key and no dashboard user
403 insufficient_scope         // API key lacks the required scope
404 not_found
409 idempotency_conflict       // same key, different payload
429 budget_exhausted           // carries Retry-After; back off or escalate
429 rate_limited               // honor Retry-After
503 sandbox_unavailable

// Approval is NOT an error. A gated tool call returns a successful
// result whose payload is:
//   { status: "approval_required", approval_ref: "…" }
// Branch on that field, then poll approvals.poll(approval_ref).
`;

const SOURCE_CHECKOUT = `Source review only; no runnable MCP setup is published.

Candidate evidence must not be promoted as production packaging, deployment,
upgrade, backup/restore, hosted authorization, or commercial support evidence.`;

export default function ForgeDocsPage() {
  return (
    <div className="font-sans">
      <section className="border-b border-white/10">
        <div className="mx-auto grid min-w-0 max-w-6xl grid-cols-1 gap-10 px-4 py-12 sm:px-6 md:grid-cols-[200px_minmax(0,1fr)] md:py-16">
          <aside className="md:sticky md:top-20 md:self-start">
            <div className="font-mono text-[10px] uppercase tracking-widest text-white/50">
              Forge docs
            </div>
            <SidebarNav sections={SECTIONS} />
            <div className="mt-8 border-t border-white/10 pt-4">
              <Link
                href="/mcp"
                className="inline-flex min-h-11 items-center font-mono text-xs text-pw-ember-300 underline-offset-4 hover:text-pw-ember-200 hover:underline md:min-h-0"
              >
                Candidate catalog →
              </Link>
            </div>
          </aside>

          <article
            className={`${compactProse.root} ${compactProse.invert} ${compactProse.forge} min-w-0 max-w-none scroll-smooth bg-pw-ink`}
          >
            <h1>Forge docs</h1>
            <p>
              This page documents a mutable MCP source candidate with{" "}
              {MCP_TOOL_COUNT} definitions across {MCP_CATEGORY_COUNT}
              categories. It is not a distribution, deployment, or full-surface
              availability claim. {MCP_RELEASE_STATUS_COPY}{" "}
              {AGENT_INTERACTIVE_RELEASE_STATUS_COPY}
            </p>

            <h2 id="quickstart">Release status</h2>
            <p>
              No install command, hosted URL, client configuration, or working
              key example is published while the hold is active.
            </p>
            <pre
              tabIndex={0}
              aria-label="Release status source example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{QUICKSTART}</code>
            </pre>

            <h2 id="auth">Auth and API keys</h2>
            <p>
              Candidate review uses the API&apos;s explicit additive scope
              names; there are no bare read/write/send grants. Distribution and
              key provisioning remain held, and telemetry is best-effort rather
              than an audit receipt.
            </p>
            <pre
              tabIndex={0}
              aria-label="Authentication scope source example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{AUTH}</code>
            </pre>

            <h2 id="sandbox">Sandbox</h2>
            <p>
              Sandbox is a source candidate for simulated outcomes. Recipient
              isolation, downstream effects, and deterministic event behavior
              are not release-qualified; this is not a production safety
              guarantee.
            </p>
            <pre
              tabIndex={0}
              aria-label="Sandbox source example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{SANDBOX_SNIPPET}</code>
            </pre>

            <h2 id="budgets">Budgets</h2>
            <p>
              Budget checks are provisional source evidence, not an atomic
              billing, effect, or mutation boundary. Per-key attribution and
              recorder/quota coupling remain under qualification.
            </p>
            <pre
              tabIndex={0}
              aria-label="Budget source example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{BUDGETS_SNIPPET}</code>
            </pre>

            <h2 id="approvals">Approvals</h2>
            <p>
              Approval shapes illustrate an intended pending decision. They do
              not yet prove atomic coupling among mutation, effect, budget,
              approval, and audit, so no zero-recipient or eventual-send
              guarantee is published.{" "}
              <code>{AGENT_INTERACTIVE_RELEASE_HOLD_CODE}</code> remains
              authoritative.
            </p>
            <pre
              tabIndex={0}
              aria-label="Approval source example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{APPROVALS_SNIPPET}</code>
            </pre>

            <h2 id="loop">The agent loop</h2>
            <p>
              The block below is an SDK-oriented design illustration. It is not
              an MCP compatibility transcript; interactive MCP writes remain
              structurally held.
            </p>
            <pre
              tabIndex={0}
              aria-label="Agent loop source example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{LOOP}</code>
            </pre>

            <h2 id="tools">Tool reference</h2>
            <p>
              {MCP_TOOL_COUNT} source definitions across {MCP_CATEGORY_COUNT}{" "}
              categories. The mutable candidate list with schemas lives at{" "}
              <Link
                href="/mcp"
                className="text-pw-ember-300 underline underline-offset-4 hover:text-pw-ember-200"
              >
                /mcp
              </Link>
              . Categories at a glance:
            </p>
            <ul>
              <li>
                <strong>audience</strong> — lists, tags, suppressions, CSV
                import/export, merge, activity, engagement
              </li>
              <li>
                <strong>campaigns</strong> — create, send, schedule, recurrence,
                pause/resume/cancel, resend-to-non-openers, link-check
              </li>
              <li>
                <strong>analytics</strong> — per-link clicks, geography,
                devices, bounces, cohorts, revenue attribution, cross-campaign
                compare
              </li>
              <li>
                <strong>automations</strong> — opens / clicks / dates /
                every-N-days / product events / inbound webhooks / replies
              </li>
              <li>
                <strong>deliverability</strong> — Inbox Reality (placement
                prediction), Diagnostician, DMARC reports, IP warmup
              </li>
              <li>
                <strong>platform</strong> — image CDN, signed inbound webhooks,
                product-event track API, inbound email parsing
              </li>
              <li>
                <strong>billing</strong> — paid subs, discounts, gifts,
                founding, annual interval
              </li>
              <li>
                <strong>domains</strong> — read-only legacy ownership evidence;
                registration, DNS re-check, TLS, removal, and routing are
                release-held
              </li>
              <li>
                <strong>archive</strong> — public web archive of past issues +
                sitemap.xml
              </li>
              <li>
                <strong>referrals</strong> — share-to-grow widget with
                milestones
              </li>
              <li>
                <strong>forms</strong> — multi-step, conditional fields, UTM
                auto-capture
              </li>
              <li>
                <strong>voice</strong> — voice profile, sequence generation,
                regenerate-one-email
              </li>
              <li>
                <strong>agent</strong> — sandbox sessions, approvals, budgets
              </li>
              <li>
                <strong>migration</strong> — Mailchimp, Beehiiv, Kit,
                MailerLite, Substack, generic CSV
              </li>
            </ul>

            <h2 id="transports">Transports</h2>
            <p>
              Source contains stdio and internal-loopback HTTP adapters. No
              installed transport, hosted service, OAuth flow, multi-tenant
              boundary, or Streamable HTTP lifecycle is qualified.
            </p>
            <pre
              tabIndex={0}
              aria-label="Transport source example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{TRANSPORTS}</code>
            </pre>

            <h2 id="errors">Errors</h2>
            <p>
              Stable codes that agents can pattern-match on. 4xx are
              agent-recoverable; 5xx are infrastructure problems.
            </p>
            <pre
              tabIndex={0}
              aria-label="Error response source example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{ERRORS}</code>
            </pre>

            <h2 id="source-license">Source license</h2>
            <p>
              The Moosewave application is AGPL-3.0-only; identified SDK, CLI,
              MCP, migration, and component packages are MIT. The checkout below
              is for development and license review. It is not a promise of a
              supported self-host distribution, bundled proprietary assets,
              production upgrades, or continuity support.
            </p>
            <pre
              tabIndex={0}
              aria-label="Source license checkout example"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300"
            >
              <code>{SOURCE_CHECKOUT}</code>
            </pre>
          </article>
        </div>
      </section>
    </div>
  );
}
