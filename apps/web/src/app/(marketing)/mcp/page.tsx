// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import toolsData from "@/lib/mcp-tools.json";
import { McpToolFilter } from "@/components/marketing/mcp-tool-filter";
import { pageMetadata } from "@/lib/marketing-metadata";
import { MCP_CATEGORY_LABELS } from "@/lib/mcp-category-labels";
import { NATIVE_TOOL_COUNT } from "@/lib/mcp-catalog-stats";
import {
  AGENT_INTERACTIVE_RELEASE_STATUS_COPY,
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
  MCP_SOURCE_CANDIDATE_LABEL,
} from "@/lib/mcp-release-status";

export const metadata: Metadata = pageMetadata({
  title: "MCP source candidate",
  description:
    "Review Moosewave's release-held MCP source-candidate catalogue and qualification status.",
  path: "/mcp",
});

interface ToolEntry {
  name: string;
  category: string;
  description: string;
}

const tools = toolsData as ToolEntry[];

// Categories are ordered by their position in the shared label map. Every
// category has a human label (enforced by mcp-category-labels.test.ts), so the
// `?? key` fallback never fires — no heading renders as a raw kebab slug.
const LABEL_ORDER = Object.keys(MCP_CATEGORY_LABELS);
const CATEGORIES: { key: string; label: string }[] = Array.from(
  new Set(tools.map((t) => t.category)),
)
  .sort((a, b) => {
    const ai = LABEL_ORDER.indexOf(a);
    const bi = LABEL_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  })
  .map((key) => ({ key, label: MCP_CATEGORY_LABELS[key] ?? key }));

// The in-app native agent registry is a distinct, governed surface from the
// MCP/CLI tool catalogue above. The count now lives in lib/mcp-catalog-stats
// as the single literal, tied to apps/api's native_manifest.json by
// __tests__/tool-catalog-claims.test.ts — it was written out separately here,
// on /developers, and in the developer product shot, and the three drifted
// apart. Agent tools have no version concept, so no registry version is quoted.
const ASSISTANT_TOOL_COUNT = NATIVE_TOOL_COUNT;

const AGENT_PLATFORM: { title: string; body: string }[] = [
  {
    title: "Candidate scope containment",
    body: "The current source proxy hides and refuses tools when key-scope introspection is unavailable or a definition lacks reviewed scope metadata. That local containment is not a claim about the immutable published package.",
  },
  {
    title: "Native output boundary",
    body: "The separate native preview discovers only four reviewed aggregate projections for model context. Interactive writes and unreviewed reads are structurally held; source registration does not mean model availability.",
  },
  {
    title: "Best-effort evidence",
    body: "Execution telemetry is minimized, tenant-bound, bounded, asynchronous observability. Cost and quota values are provisional estimates, not an audit ledger, enforcement receipt, or billing authority.",
  },
  {
    title: "Protocol and deployment hold",
    body: `The native endpoint is a custom JSON-RPC preview, not a qualified Streamable HTTP MCP lifecycle, and no hosted OAuth/tenant deployment is approved. ${MCP_RELEASE_HOLD_CODE} remains authoritative.`,
  },
];

export default function McpPage() {
  return (
    <div className="bg-pw-paper text-pw-ink2">
      <section className="bg-pw-ink text-pw-paper">
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight">
            MCP distribution is release-held.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-pw-muted-on-ink">
            Inspect the source-candidate catalogue and current qualification
            boundary. It is not a supported install or hosted connector.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <a
              href="#status"
              className="rounded-md bg-pw-ember-500 px-5 py-3 font-medium text-pw-paper shadow-[0_2px_0_0_#7A081B] hover:bg-pw-ember-600"
            >
              Review status
            </a>
            <a
              href="#tools"
              className="rounded-md border border-pw-line/30 px-5 py-3 font-medium text-pw-paper hover:border-pw-line/60"
            >
              View tools
            </a>
          </div>
        </div>
      </section>

      <section id="status" className="border-t border-pw-line">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">
            No runnable setup is published
          </h2>
          <div className="mt-6 rounded-md border border-pw-ember-500/40 bg-pw-surface p-6">
            <div className="font-mono text-xs uppercase tracking-wider text-pw-ember-600">
              {MCP_RELEASE_HOLD_CODE}
            </div>
            <p className="mt-3 max-w-3xl text-pw-muted-on-paper">
              {MCP_RELEASE_STATUS_COPY}
            </p>
            <p className="mt-3 text-sm text-pw-muted-on-paper">
              A release requires a new immutable package version and digest,
              installed-artifact parity, hosted authorization and tenant-bound
              deployment evidence, and protocol qualification.
            </p>
          </div>
        </div>
      </section>

      <section id="tools" className="border-t border-pw-line bg-pw-surface">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">
            Tool catalogue
          </h2>
          <p className="mt-3 text-pw-muted-on-paper">
            {MCP_SOURCE_CANDIDATE_LABEL}. These entries document mutable source;
            they are not a claim about tools exposed by an installed package or
            deployed service.
          </p>
          {/* RSC-04: the catalogue is rendered here, on the server, once. It
              used to be handed to a client component as props as well, so the
              /mcp document carried every entry twice — ~57 KB of flight
              data on top of the HTML — to power a substring filter. The filter
              is now an island that hides the rows already on the page. */}
          <div className="mt-10">
            <div className="sticky top-14 z-10 -mx-6 mb-8 border-b border-pw-line bg-pw-surface/95 px-6 py-4 backdrop-blur">
              <McpToolFilter total={tools.length} />
              <div className="mt-3 flex flex-wrap gap-1.5">
                {CATEGORIES.map((cat) => (
                  <a
                    key={cat.key}
                    href={`#cat-${cat.key}`}
                    data-mcp-chip={cat.key}
                    className="rounded-full border border-pw-line bg-pw-paper px-2.5 py-1 text-xs text-pw-ink2 transition-colors hover:border-pw-ember-500 hover:text-pw-ember-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                  >
                    {cat.label}
                    <span
                      data-mcp-chip-count
                      className="ml-1 text-pw-muted-on-paper"
                    >
                      {tools.filter((t) => t.category === cat.key).length}
                    </span>
                  </a>
                ))}
              </div>
            </div>

            <div id="mcp-tool-catalogue" className="space-y-10">
              {CATEGORIES.map((cat) => (
                <div
                  key={cat.key}
                  id={`cat-${cat.key}`}
                  data-mcp-category={cat.key}
                  className="scroll-mt-36"
                >
                  <h3 className="text-sm font-semibold uppercase tracking-widest text-pw-ember-600">
                    {cat.label}
                  </h3>
                  <ul className="mt-4 divide-y divide-pw-line border-y border-pw-line bg-pw-paper">
                    {tools
                      .filter((t) => t.category === cat.key)
                      .map((t) => (
                        <li
                          key={t.name}
                          data-mcp-tool
                          className="flex min-w-0 flex-col gap-1 px-4 py-3 md:flex-row md:items-center md:gap-6"
                        >
                          <code className="break-all font-mono text-sm text-pw-ink2 md:w-72 md:break-normal">
                            {t.name}
                          </code>
                          <span className="min-w-0 break-words text-sm text-pw-muted-on-paper [overflow-wrap:anywhere]">
                            {t.description}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-pw-line bg-pw-surface">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">
            Why MCP for newsletters
          </h2>
          <p className="mt-6 text-pw-muted-on-paper">
            Most newsletter platforms ship either no agent surface or a small
            slice. Resend ships MCP for transactional. Loops, Kit, and Beehiiv
            have community servers with no vendor support. Substack has no
            public API. This repository studies an agent-send counterpart to
            inbox-focused agent systems; that design is not a currently
            supported Moosewave agent-send surface.
          </p>
          <p className="mt-4 text-pw-muted-on-paper">
            This repository explores audience, campaign, automation, form,
            analytics, migration, and agent-governance adapters. Coverage in the
            source catalogue does not establish distribution, authorization,
            protocol, or production compatibility.
          </p>
          <p className="mt-4 text-pw-muted-on-paper">
            The server, the SDKs, and the CLI are MIT-licensed. Build on top of
            them, or fork.
          </p>
        </div>
      </section>

      <section className="border-t border-pw-line">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">
            Retained agent source beside it.
          </h2>
          <p className="mt-3 max-w-2xl text-pw-muted-on-paper">
            The catalogue above is a source inventory, not what a client is
            promised to see. The retained future in-app-agent implementation
            would use a distinct registry of {ASSISTANT_TOOL_COUNT} native
            source tools; distribution parity with the MCP candidate is not
            claimed. {AGENT_INTERACTIVE_RELEASE_STATUS_COPY}
          </p>

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {AGENT_PLATFORM.map((item) => (
              <div
                key={item.title}
                className="rounded-md border border-pw-line bg-pw-surface p-6"
              >
                <div className="text-sm font-semibold uppercase tracking-widest text-pw-ember-600">
                  {item.title}
                </div>
                <p className="mt-3 text-sm leading-relaxed text-pw-muted-on-paper">
                  {item.body}
                </p>
              </div>
            ))}
          </div>

          <p className="mt-10 max-w-2xl text-pw-muted-on-paper">
            The native runtime and proxy candidate have different execution and
            evidence boundaries. Review the developer platform separately; no
            cross-surface parity claim is made.{" "}
            <Link
              href="/developers"
              className="font-medium text-pw-ember-600 underline-offset-4 hover:underline"
            >
              See the full developer platform
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="border-t border-pw-line bg-pw-ink text-pw-paper">
        <div className="mx-auto max-w-5xl px-6 py-20 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Explore the source-candidate catalog.
          </h2>
          <p className="mt-3 text-pw-muted-on-ink">
            Review candidate definitions and categories without treating them as
            an install or availability promise.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/docs/skills"
              className="rounded-md bg-pw-ember-500 px-5 py-3 font-medium text-pw-paper shadow-[0_2px_0_0_#7A081B] hover:bg-pw-ember-600"
            >
              Browse candidate definitions
            </Link>
            <Link
              href="/migrate-anywhere"
              className="rounded-md border border-pw-line/30 px-5 py-3 font-medium text-pw-paper hover:border-pw-line/60"
            >
              See the migration toolkit
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
