// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";

import {
  MCP_CATEGORY_COUNT,
  MCP_TOOL_COUNT,
  mcpExampleTools,
  mcpToolsInCategories,
} from "@/lib/mcp-catalog-stats";
import {
  AGENT_INTERACTIVE_RELEASE_HOLD_CODE,
  AGENT_INTERACTIVE_RELEASE_STATUS_COPY,
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
} from "@/lib/mcp-release-status";
import { TIERS } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import {
  CountUp,
  StaggerGrid,
  StaggerItem,
  TerminalTypeOn,
} from "./_components/motion";

const PRIMITIVES = [
  {
    name: "Sandbox",
    code: `X-Postwave-Sandbox: true`,
    body: "Source candidate for simulated outcomes. Recipient isolation, downstream effects, and deterministic event behavior are not release-qualified; do not treat this as a safe production loop.",
  },
  {
    name: "Budgets",
    code: `api_key.budget = {
  sends_per_day: 1000,
  dollars_per_month: 50,
}`,
    body: "Provisional source checks, not an atomic billing or mutation boundary. Recorder/quota coupling and per-key attribution still require qualification.",
  },
  {
    name: "Approval gates",
    code: `campaign.create({
  requires_approval: true,
})`,
    body: "Source design for a pending decision. Mutation, approval, effect, budget, and audit are not yet one durable atomic contract, so zero-recipient and eventual-send guarantees are release-held.",
  },
];

const OSS_PACKAGES = [
  {
    name: "@postwave/sdk",
    note: "TypeScript SDK",
    href: "/docs/api",
  },
  {
    name: "postwave (PyPI)",
    note: "Python SDK",
    href: "/docs/api",
  },
  {
    name: "@postwave/cli",
    note: "Moosewave command-line tool",
    href: "/forge/docs",
  },
  {
    name: "@postwave/mcp-server",
    note: "Release-held MCP source candidate",
    href: "/docs/skills",
  },
  {
    name: "@postwave/email-react",
    note: "JSX → MJML compiler",
    href: "/developers",
  },
  {
    name: "@postwave/migrate",
    note: "Six-source migration toolkit (Go)",
    href: "/migrate-anywhere",
  },
];

const DEMO_TRANSCRIPT = `# source-candidate status record

> MCP distribution
  held: ${MCP_RELEASE_HOLD_CODE}
  runnable setup: false

> in-app agent runtime
  held: ${AGENT_INTERACTIVE_RELEASE_HOLD_CODE}
  runtime demo: false

> governance primitives
  source evidence only; runtime qualification open`;

const AGENT_LOOP = `// 1. Read voice profile
const profile = await pw.voiceProfile.get();

// 2. Generate a sequence in the writer's voice
const seq = await pw.sequences.generate({
  template_id: "welcome-7-day",
  variables: { newsletter: "Acme Weekly" },
});

// 3. Predict placement before sending
const p = await pw.inboxReality.predict({
  html: seq.emails[0].body_html,
  subject: seq.emails[0].subject,
});

// 4. Send sandboxed; no real recipients yet
await pw.campaigns.send(seq.id, {
  sandbox: true,
  idempotency_key: "welcome-2026-05-02",
});

// 5. Stream events back as they fire
for await (const e of pw.events.stream({ type: "opened" })) {
  await handleCampaignOpened(e.campaign_id);
}`;

export default function ForgeHomePage() {
  return (
    <div className="font-sans">
      {/* Hero */}
      <section className="border-b border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24 md:py-28">
          <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-300">
            Source designs for software agents
          </div>
          <h1 className="mt-4 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Agent integration source, with explicit preview limits.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-white/70">
            The repository indexes {MCP_TOOL_COUNT} source-candidate definitions
            across {MCP_CATEGORY_COUNT} categories. MCP distribution, hosted
            service, and working-key setup are release-held.
          </p>

          <div
            id="release-status"
            className="mt-10 rounded-lg border border-pw-ember-500/40 bg-black/40 p-5"
          >
            <div className="font-mono text-[10px] uppercase tracking-wider text-pw-ember-300">
              {MCP_RELEASE_HOLD_CODE}
            </div>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-white/70">
              {MCP_RELEASE_STATUS_COPY}
              {" "}
              {AGENT_INTERACTIVE_RELEASE_STATUS_COPY}
            </p>
          </div>

          {/* Demo transcript */}
          <div className="mt-4 rounded-lg border border-white/10 bg-black/40">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
                release status record
              </span>
              <span className="font-mono text-[10px] text-pw-ember-300">
                scripted example
              </span>
            </div>
            <TerminalTypeOn
              label="Demo transcript"
              lines={DEMO_TRANSCRIPT.split("\n")}
              charDelayMs={14}
              lineDelayMs={280}
              className="overflow-x-auto px-4 py-4 font-mono text-sm leading-relaxed text-white/80 min-h-[180px]"
            />
          </div>

          {/* Trust stripe */}
          <div className="mt-10 grid grid-cols-2 gap-4 border-t border-white/10 pt-6 md:grid-cols-4">
            <div className="font-mono">
              <div className="text-2xl font-semibold text-pw-paper">
                <CountUp value={MCP_TOOL_COUNT} />
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-wider text-white/50">
                Source definitions
              </div>
            </div>
            <div className="font-mono">
              <div className="text-2xl font-semibold text-pw-paper">
                <CountUp value={MCP_CATEGORY_COUNT} />
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-wider text-white/50">
                Categories
              </div>
            </div>
            <div className="font-mono">
              <div className="text-2xl font-semibold text-pw-paper">
                Source primitives
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-wider text-white/50">
                Primitives
              </div>
            </div>
            <div className="font-mono">
              <div className="text-2xl font-semibold text-pw-paper">
                Release held
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-wider text-white/50">
                Distribution
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Three primitives */}
      <section id="primitives" className="border-b border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-300">
            Three source primitives
          </div>
          <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            Under qualification, not runtime guarantees.
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            These records illustrate intended shapes only. Do not stack them as
            a production safety boundary while mutation, effect, budget,
            approval, and audit coupling remains release-held.
          </p>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {PRIMITIVES.map((p) => (
              <div
                key={p.name}
                className="flex flex-col rounded-lg border border-white/10 bg-black/30 p-5"
              >
                <div className="font-mono text-[10px] uppercase tracking-wider text-white/50">
                  primitive
                </div>
                <div className="mt-1 text-xl font-semibold text-pw-paper">
                  {p.name}
                </div>
                <pre
                  tabIndex={0}
                  role="group"
                  aria-label="Primitive example"
                  className="mt-4 overflow-x-auto rounded bg-black/60 px-3 py-3 font-mono text-xs leading-relaxed text-pw-ember-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <code>{p.code}</code>
                </pre>
                <p className="mt-4 text-sm text-white/60 leading-relaxed">
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Surface area */}
      <section id="surface" className="border-b border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-300">
            Surface area
          </div>
          <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            Candidate catalog: {MCP_TOOL_COUNT} definitions across{" "}
            {MCP_CATEGORY_COUNT} categories.
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            Selected categories are shown below. Use the generated catalog and
            API documentation to verify the exact operations available in a
            release candidate.
          </p>

          <StaggerGrid className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {[
              {
                cat: "audience",
                slugs: ["audience"],
              },
              {
                cat: "campaigns",
                slugs: ["campaigns"],
              },
              {
                cat: "analytics",
                slugs: ["analytics"],
              },
              {
                cat: "automations",
                slugs: ["automations"],
              },
              {
                cat: "deliverability",
                slugs: ["deliverability"],
              },
              {
                cat: "platform",
                slugs: ["platform"],
              },
              {
                cat: "commerce reads",
                slugs: ["discounts", "gift-subscriptions"],
              },
              {
                cat: "domains",
                slugs: ["custom-domains"],
              },
              {
                cat: "archive",
                slugs: ["archive"],
              },
              {
                cat: "referrals",
                slugs: ["referrals"],
              },
              {
                cat: "forms",
                slugs: ["forms"],
              },
              {
                cat: "voice",
                slugs: ["voice"],
              },
              {
                cat: "subscribers",
                slugs: ["subscribers"],
              },
              {
                cat: "topics",
                slugs: ["topics"],
              },
              {
                cat: "templates",
                slugs: ["templates"],
              },
              {
                cat: "agent",
                slugs: ["agent-primitives"],
              },
              {
                cat: "admin",
                slugs: ["admin"],
              },
              {
                cat: "events",
                slugs: ["events"],
              },
              {
                cat: "migration",
                slugs: ["migration"],
              },
            ].map((c) => ({
              ...c,
              count: mcpToolsInCategories(c.slugs),
              ex: mcpExampleTools(c.slugs).join(", "),
            })).map((c) => (
              <StaggerItem
                key={c.cat}
                className="rounded-md border border-white/10 bg-black/30 px-4 py-3"
              >
                <div className="flex items-baseline justify-between">
                  <div className="font-mono text-sm text-pw-paper">{c.cat}</div>
                  <div className="font-mono text-[11px] text-pw-ember-300">
                    {c.count}
                  </div>
                </div>
                <div className="mt-2 line-clamp-2 font-mono text-[10px] leading-relaxed text-white/50">
                  {c.ex}
                </div>
              </StaggerItem>
            ))}
          </StaggerGrid>

          <div className="mt-8">
            <Link
              href="/mcp"
              className="font-mono text-xs text-pw-ember-300 hover:text-pw-ember-200"
            >
              Browse the source-candidate catalog →
            </Link>
          </div>
        </div>
      </section>

      {/* The agent loop */}
      <section id="loop" className="border-b border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-300">
            The agent loop
          </div>
          <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            An illustrative agent loop.
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            This sequence is a conceptual example, not a compatibility or
            latency guarantee. Verify method names against the release API
            catalog before integrating.
          </p>

          <div className="mt-10 rounded-lg border border-white/10 bg-black/40">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
                typescript · @postwave/sdk
              </span>
              <Link
                href="/docs/api"
                className="font-mono text-[10px] text-pw-ember-300 hover:text-pw-ember-200"
              >
                browse API docs →
              </Link>
            </div>
            <pre
              tabIndex={0}
              role="group"
              aria-label="Agent loop example"
              className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-[1.6] text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <code>{AGENT_LOOP}</code>
            </pre>
          </div>
        </div>
      </section>

      {/* OSS */}
      <section className="border-b border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-300">
            Open source
          </div>
          <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            Selected MIT-licensed packages.
          </h2>

          <div className="mt-10 divide-y divide-white/10 border-y border-white/10">
            {OSS_PACKAGES.map((pkg) => (
              <a
                key={pkg.name}
                href={pkg.href}
                rel="noopener noreferrer"
                className="flex items-center justify-between px-2 py-4 transition-colors hover:bg-white/5"
              >
                <div>
                  <div className="font-mono text-sm text-pw-paper">
                    {pkg.name}
                  </div>
                  <div className="mt-1 text-xs text-white/50">{pkg.note}</div>
                </div>
                <span className="font-mono text-xs text-pw-ember-300">→</span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing footer */}
      <section className="border-b border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-300">
            Pricing
          </div>
          <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight text-pw-paper">
            Clear monthly plans with finite allowances.
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            Monthly checkout is coming soon. Annual billing is planned
            separately and no payment is collected from the waitlist.
          </p>

          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {TIERS.map((t) => (
              <div
                key={t.tier}
                className={cn(
                  "flex flex-col rounded-lg border bg-black/40 p-5",
                  t.tier === "growth"
                    ? "border-pw-ember-500"
                    : "border-white/10",
                )}
              >
                <div className="font-mono text-[10px] uppercase tracking-wider text-white/50">
                  tier
                </div>
                <div className="mt-1 font-mono text-sm text-pw-ember-300">
                  {t.name}
                </div>
                <div className="mt-4 flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-semibold text-pw-paper">
                    {t.price}
                  </span>
                  <span className="font-mono text-[11px] text-white/50">
                    {t.cadence === "monthly" ? "/ month" : "simulation"}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-white/60">
                  {t.tier === "sandbox"
                    ? "no real recipients"
                    : "hard cap · no paid overage"}
                </div>
                <p className="mt-4 text-sm text-white/60 leading-relaxed">
                  {t.tagline}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/pricing"
              className="rounded-md bg-pw-ember-500 px-5 py-3 font-mono text-sm font-medium text-white shadow-[0_2px_0_0_#7A081B] hover:bg-pw-ember-600"
            >
              Compare Moosewave plans →
            </Link>
            <Link
              href="/"
              className="rounded-md border border-white/20 px-5 py-3 font-mono text-sm font-medium text-pw-paper hover:border-white/40"
            >
              Moosewave for writers →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
