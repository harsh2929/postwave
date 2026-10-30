// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  BarChart3,
  Layers3,
  MousePointerClick,
  Route,
  ShoppingBag,
  Users,
} from "lucide-react";

import type {
  CampaignReport,
  CompatResource,
  MailchimpCompatSummary,
} from "@/lib/mailchimp-compat-api";

import { journeyStatus, money, ParityCard, pct } from "./compatibility-ui";
import { pluralizeCount } from "@/lib/pluralize";

const SECTIONS = [
  "Contact model",
  "Campaign builder",
  "Reports",
  "Automations",
  "Landing pages & popups",
  "Ecommerce",
] as const;

type CompatibilityOverviewGridProps = {
  summary: MailchimpCompatSummary | null;
  assets: CompatResource[];
  sections: CompatResource[];
  journeys: CompatResource[];
  landingPages: CompatResource[];
  popups: CompatResource[];
  integrations: CompatResource[];
  report: CampaignReport | null;
  busy: string | null;
  demoActionsEnabled: boolean;
  runAction: (label: string, action: () => Promise<void>) => Promise<void>;
  seedContactModel: () => Promise<void>;
  seedCampaignBuilder: () => Promise<void>;
  seedReport: () => Promise<void>;
  seedJourney: () => Promise<void>;
  seedGrowth: () => Promise<void>;
  seedCommerce: () => Promise<void>;
};

export function CompatibilityOverviewGrid({
  summary,
  assets,
  sections,
  journeys,
  landingPages,
  popups,
  integrations,
  report,
  busy,
  demoActionsEnabled,
  runAction,
  seedContactModel,
  seedCampaignBuilder,
  seedReport,
  seedJourney,
  seedGrowth,
  seedCommerce,
}: CompatibilityOverviewGridProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <ParityCard
        icon={Users}
        title={SECTIONS[0]}
        metric={pluralizeCount(summary?.contacts?.total ?? 0, "contact")}
        detail={`${pluralizeCount(summary?.contacts?.groups ?? 0, "group")}, ${pluralizeCount(summary?.contacts?.activity_events ?? 0, "activity event")}`}
        items={Object.entries(summary?.contacts?.by_mailchimp_status ?? {}).map(
          ([k, v]) => `${k}: ${v}`,
        )}
        action="Create group"
        busy={busy}
        demoActionsEnabled={demoActionsEnabled}
        onAction={() => runAction("Create group", seedContactModel)}
        hint={
          (summary?.contacts?.groups ?? 0) === 0
            ? {
                text: "Import contacts or create a group",
                href: "/app/subscribers",
              }
            : undefined
        }
      />
      <ParityCard
        icon={Layers3}
        title={SECTIONS[1]}
        metric={`${summary?.campaigns?.total ?? 0} campaigns`}
        detail={`${summary?.campaigns?.assets ?? 0} assets, ${summary?.campaigns?.reusable_sections ?? 0} reusable sections`}
        items={[
          `${assets.length} content-library items`,
          `${sections.length} saved sections`,
        ]}
        action="Seed builder"
        busy={busy}
        demoActionsEnabled={demoActionsEnabled}
        onAction={() => runAction("Seed builder", seedCampaignBuilder)}
        hint={
          (summary?.campaigns?.assets ?? 0) === 0 ||
          (summary?.campaigns?.reusable_sections ?? 0) === 0
            ? // There is no /app/campaigns/new route — the campaigns/[id]
              // segment would swallow it and try to load a campaign named
              // "new". Creation lives in the dialog the list opens on
              // ?create=1, the same handoff the shell's Create menu uses.
              { text: "Build a campaign", href: "/app/campaigns?create=1" }
            : undefined
        }
      />
      <ParityCard
        icon={BarChart3}
        title={SECTIONS[2]}
        metric={`${summary?.reports?.events ?? 0} events`}
        detail={
          report
            ? `${pct(report.open_rate)} open, ${pct(report.click_rate)} click, ${money(report.revenue_cents)} revenue`
            : `${summary?.reports?.reportable_campaigns ?? 0} reportable campaigns`
        }
        items={[
          ...(report
            ? report.top_links.map((item) => `${item.key}: ${item.count}`)
            : (summary?.reports?.reportable_campaigns ?? 0) > 0
              ? ["Detailed report evidence is unavailable in this environment"]
              : []),
        ]}
        action="Seed report"
        busy={busy}
        demoActionsEnabled={demoActionsEnabled}
        onAction={() => runAction("Seed report", seedReport)}
        hint={
          (summary?.reports?.events ?? 0) === 0 ||
          (!report && (summary?.reports?.reportable_campaigns ?? 0) > 0)
            ? {
                text:
                  (summary?.reports?.events ?? 0) === 0
                    ? "Send a campaign to generate reports"
                    : "Review sent campaigns",
                href: "/app/campaigns",
              }
            : undefined
        }
      />
      <ParityCard
        icon={Route}
        title={SECTIONS[3]}
        metric={`${summary?.automations?.total ?? 0} journeys`}
        detail={
          Object.entries(summary?.automations?.by_status ?? {})
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ") || "No journeys yet"
        }
        items={journeys
          .slice(0, 3)
          .map(
            (j) =>
              `${j.name ?? "Journey"}: ${journeyStatus(j)} · ${
                j.nodes?.length ?? 0
              } nodes`,
          )}
        action="Create journey"
        busy={busy}
        demoActionsEnabled={demoActionsEnabled}
        onAction={() => runAction("Create journey", seedJourney)}
        hint={
          (summary?.automations?.total ?? 0) === 0
            ? { text: "Create an automation", href: "/app/flows" }
            : undefined
        }
      />
      <ParityCard
        icon={MousePointerClick}
        title={SECTIONS[4]}
        metric={`${summary?.growth?.landing_pages ?? 0} landing pages`}
        detail={`${summary?.growth?.popups ?? 0} popups, ${summary?.growth?.conversions ?? 0} conversions`}
        items={[
          ...landingPages.slice(0, 2).map((p) => `${p.slug}: ${p.status}`),
          ...popups.slice(0, 2).map((p) => `${p.name}: ${p.status}`),
        ]}
        action="Seed growth"
        busy={busy}
        demoActionsEnabled={demoActionsEnabled}
        onAction={() => runAction("Seed growth", seedGrowth)}
        hint={
          (summary?.growth?.landing_pages ?? 0) === 0 &&
          (summary?.growth?.popups ?? 0) === 0
            ? { text: "Create a landing page", href: "/app/landing-pages" }
            : undefined
        }
      />
      <ParityCard
        icon={ShoppingBag}
        title={SECTIONS[5]}
        metric={`${summary?.ecommerce?.integrations ?? 0} integrations`}
        detail={`${summary?.ecommerce?.orders ?? 0} orders, ${money(summary?.ecommerce?.revenue_cents ?? 0)} revenue`}
        items={integrations
          .slice(0, 3)
          .map((i) => `${i.provider}: ${i.shop_domain ?? i.status}`)}
        action="Sync demo store"
        busy={busy}
        demoActionsEnabled={demoActionsEnabled}
        onAction={() => runAction("Sync demo store", seedCommerce)}
        hint={
          (summary?.ecommerce?.integrations ?? 0) === 0 ||
          (summary?.ecommerce?.orders ?? 0) === 0
            ? { text: "Connect a store", href: "/app/integrations" }
            : undefined
        }
      />
    </div>
  );
}
