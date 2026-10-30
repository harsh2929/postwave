// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";
import {
  MCP_CATEGORY_COUNT,
  NATIVE_TOOL_COUNT,
} from "@/lib/mcp-catalog-stats";
import { MCP_SOURCE_CANDIDATE_TOOL_COUNT } from "@/lib/mcp-release-status";

export type ProductShotVariant =
  | "migration"
  | "inbox"
  | "deliverability"
  | "voice"
  | "audiences"
  | "commerce"
  | "sms"
  | "automations"
  | "developers"
  | "analytics"
  | "podcasts"
  | "forms"
  | "landing"
  | "generic";

// Layout emphasis. Rendering the same variant with different views lets a
// section show two or three genuinely distinct mocks instead of byte-identical
// copies (MKTC-004 / MKTP-006 / MKTN-007).
export type ProductShotView = "trend" | "list" | "grid";

const DATA: Record<
  ProductShotVariant,
  {
    title: string;
    metric: string;
    /** Label above the metric — matches the value's semantics (MKTP-005). */
    metricLabel: string;
    accent: string;
    rows: Array<[string, string]>;
  }
> = {
  migration: {
    title: "Migration dry-run",
    metric: "99.7%",
    metricLabel: "Fidelity",
    accent: "bg-pw-ember-500",
    rows: [
      ["Subscribers", "12,733"],
      ["Segments", "12"],
      ["Automations", "4 flagged"],
    ],
  },
  inbox: {
    title: "Inbox Reality",
    metric: "Primary",
    metricLabel: "Placement",
    accent: "bg-emerald-500",
    rows: [
      ["Gmail", "Primary"],
      ["Outlook", "Promotions"],
      ["Yahoo", "Primary"],
    ],
  },
  voice: {
    title: "Voice sequence",
    metric: "94",
    metricLabel: "Fidelity",
    accent: "bg-blue-500",
    rows: [
      ["Email 1", "96 fidelity"],
      ["Email 2", "93 fidelity"],
      ["Email 3", "95 fidelity"],
    ],
  },
  forms: {
    title: "Growth form",
    metric: "Live",
    metricLabel: "Status",
    accent: "bg-amber-500",
    rows: [
      ["Submissions", "842"],
      ["Conversion", "7.8%"],
      ["Consent", "Stored"],
    ],
  },
  deliverability: {
    title: "Deliverability",
    metric: "97%",
    metricLabel: "Inbox rate",
    accent: "bg-emerald-500",
    rows: [
      ["Seedlist", "Active roster"],
      ["DMARC", "Pass"],
      ["Warmup", "Day 14"],
    ],
  },
  audiences: {
    title: "Audience sync",
    metric: "Synced",
    metricLabel: "Status",
    accent: "bg-violet-500",
    rows: [
      ["Meta", "48,102"],
      ["Google Ads", "47,890"],
      ["TikTok", "Queued"],
    ],
  },
  commerce: {
    title: "Commerce",
    metric: "Connected",
    metricLabel: "Status",
    accent: "bg-emerald-600",
    rows: [
      ["Shopify", "Synced"],
      ["Orders 30d", "1,204"],
      ["Attributed", "$24,810"],
    ],
  },
  sms: {
    title: "SMS campaign",
    metric: "Sent",
    metricLabel: "Status",
    accent: "bg-sky-500",
    rows: [
      ["Sender", "10DLC"],
      ["Delivered", "98.2%"],
      ["Consent", "Opted-in"],
    ],
  },
  automations: {
    title: "Automation flow",
    metric: "Active",
    metricLabel: "Status",
    accent: "bg-indigo-500",
    rows: [
      ["Trigger", "Signup"],
      ["Nodes", "7"],
      ["In flow", "312"],
    ],
  },
  developers: {
    title: "Developer platform",
    // Was "v22" under the label "Registry". The agent registry has no version
    // concept at all — native_manifest.json is a flat array of tools with no
    // version field — and the native count had been 59 since before this mock
    // still said 22. Both figures now come from the shared constants.
    metric: String(MCP_SOURCE_CANDIDATE_TOOL_COUNT),
    metricLabel: "Source candidates",
    accent: "bg-slate-600",
    rows: [
      ["Native tools", String(NATIVE_TOOL_COUNT)],
      ["Categories", String(MCP_CATEGORY_COUNT)],
      ["Qualification", "Release-held"],
    ],
  },
  analytics: {
    title: "Analytics",
    metric: "On track",
    metricLabel: "Pace",
    accent: "bg-blue-600",
    rows: [
      ["Open rate", "41.2%"],
      ["Goal pace", "Ahead"],
      ["Revenue", "$8,440"],
    ],
  },
  podcasts: {
    title: "Private podcast",
    metric: "Live",
    metricLabel: "Status",
    accent: "bg-rose-500",
    rows: [
      ["Episodes", "24"],
      ["Access", "Tier-gated"],
      ["Feed", "Tokenized"],
    ],
  },
  landing: {
    title: "Landing page",
    metric: "Live",
    metricLabel: "Status",
    accent: "bg-teal-500",
    rows: [
      ["Views", "3,204"],
      ["Submits", "486"],
      ["Conversion", "15.2%"],
    ],
  },
  generic: {
    title: "Moosewave workspace",
    metric: "Ready",
    metricLabel: "Status",
    accent: "bg-slate-500",
    rows: [
      ["Status", "Healthy"],
      ["API", "Online"],
      ["Billing", "Synced"],
    ],
  },
};

function ShotBody({
  view,
  accent,
  rows,
}: {
  view: ProductShotView;
  accent: string;
  rows: Array<[string, string]>;
}): JSX.Element {
  if (view === "list") {
    // Emphasises rows as a scannable list (picker / report feel) — no chart.
    return (
      <div className="space-y-2">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center gap-3 rounded-md border border-pw-ink2/10 px-3 py-2.5"
          >
            <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", accent)} />
            <span className="flex-1 text-xs text-pw-muted-on-paper">
              {label}
            </span>
            <span className="text-xs font-medium text-pw-ink2">{value}</span>
          </div>
        ))}
      </div>
    );
  }

  if (view === "grid") {
    // Emphasises a gallery/grid of tiles (picker / preview feel).
    return (
      <div className="grid grid-cols-3 gap-2">
        {rows.concat(rows).slice(0, 6).map(([label], i) => (
          <div
            key={`${label}-${i}`}
            className="rounded-md border border-pw-ink2/10 bg-pw-surface/50 p-2"
          >
            <div className={cn("h-1.5 w-8 rounded-full", accent)} />
            <div className="mt-2 h-1.5 w-full rounded bg-pw-ink2/10" />
            <div className="mt-1 h-1.5 w-2/3 rounded bg-pw-ink2/10" />
          </div>
        ))}
      </div>
    );
  }

  // "trend" (default): bar chart above the rows.
  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {[68, 84, 52].map((height, i) => (
          <div
            key={height}
            className="flex h-16 items-end rounded-md border border-pw-ink2/10 bg-pw-surface/60 px-2 pb-2"
          >
            <div
              className={cn("w-full rounded-sm", accent)}
              style={{ height: `${height - i * 8}%` }}
            />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between rounded-md border border-pw-ink2/10 px-3 py-2"
          >
            <span className="text-xs text-pw-muted-on-paper">{label}</span>
            <span className="text-xs font-medium text-pw-ink2">{value}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function ProductShot({
  alt,
  variant = "generic",
  view = "trend",
  className,
}: {
  alt: string;
  variant?: ProductShotVariant;
  /** Layout emphasis — vary across repeated shots so they aren't identical. */
  view?: ProductShotView;
  className?: string;
}) {
  const data = DATA[variant];

  return (
    <div
      role="img"
      aria-label={alt}
      className={cn(
        "aspect-video w-full overflow-hidden rounded-lg border border-pw-ink2/10 bg-white shadow-sm",
        className,
      )}
    >
      <div className="flex h-full">
        <div className="hidden w-16 border-r bg-pw-surface/80 p-2 sm:block">
          <div className="mb-4 h-6 rounded bg-pw-ink2" />
          {["", "", "", ""].map((_, i) => (
            <div key={i} className="mb-2 h-5 rounded bg-pw-ink2/10" />
          ))}
        </div>
        <div className="min-w-0 flex-1 p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="h-2.5 w-24 rounded bg-pw-ink2/15" />
              <div className="mt-2 text-sm font-semibold text-pw-ink2">
                {data.title}
              </div>
            </div>
            <div className="rounded-md border border-pw-ink2/10 px-3 py-2 text-right">
              <div className="text-[10px] uppercase tracking-wider text-pw-muted-on-paper">
                {data.metricLabel}
              </div>
              <div className="text-sm font-semibold text-pw-ink2">
                {data.metric}
              </div>
            </div>
          </div>
          <ShotBody view={view} accent={data.accent} rows={data.rows} />
        </div>
      </div>
    </div>
  );
}
