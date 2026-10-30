// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

import {
  BarChart3,
  Boxes,
  Brain,
  Film,
  FilePlus2,
  Megaphone,
  Route,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  CreativeAssistantResponse,
  OptimizationResponse,
  TemplateLanguagePreviewResponse,
  VideoConvertResponse,
} from "@/lib/mailchimp-compat-api";
import { cn } from "@/lib/utils";

import type { CompatibilityPageData } from "./compatibility-page-data";
import {
  journeyStatus,
  localClosureCount,
  MiniList,
  providerGateReady,
} from "./compatibility-ui";

export function optimizationEvidenceRows(
  prefix: string,
  result: OptimizationResponse | null,
): string[] {
  if (!result) return [`${prefix}: pending data`];
  return [
    `${prefix}: ${result.recommendation.label} (${result.recommendation.grade ?? "ungraded"})`,
    `${prefix} confidence: ${result.recommendation.confidence}; ${result.data_points} data point${result.data_points === 1 ? "" : "s"}`,
    `${prefix} method: ${result.recommendation.method_note ?? result.method}`,
  ];
}

type ActionHandler = () => Promise<void>;

type CompatibilityDetailSectionsProps = Pick<
  CompatibilityPageData,
  | "groups"
  | "assets"
  | "journeys"
  | "landingPages"
  | "popups"
  | "integrations"
  | "planner"
  | "multivariate"
  | "sendTime"
  | "sendDay"
  | "clickMap"
  | "customReport"
  | "deliveryInsights"
  | "inbox"
  | "multiChannel"
  | "surveys"
  | "landingParity"
  | "websiteStatus"
  | "audienceInsights"
  | "segmentSchema"
  | "contentStudio"
  | "blockCatalog"
  | "batches"
  | "accountExports"
  | "connectedSites"
  | "verifiedDomains"
  | "marketplace"
  | "agencyEcosystem"
  | "parityWorkbench"
> & {
  busy: string | null;
  creativeDraft: CreativeAssistantResponse | null;
  demoActionsEnabled: boolean;
  templatePreview: TemplateLanguagePreviewResponse | null;
  videoConversion: VideoConvertResponse | null;
  applyLocalMailchimpClosures: ActionHandler;
  createAccountExportSnapshot: ActionHandler;
  convertSampleVideo: ActionHandler;
  draftCampaignCreative: ActionHandler;
  previewSampleTemplate: ActionHandler;
  runBatchCompatibilityCheck: ActionHandler;
};

// Anchor targets for the in-page section nav (GOV-033) so a specific parity
// area is reachable without scrolling the wall of cards.
const COMPAT_SECTIONS: { id: string; label: string }[] = [
  { id: "compat-workbench", label: "Parity workbench" },
  { id: "compat-intelligence", label: "Campaign intelligence" },
  { id: "compat-multichannel", label: "Multi-channel" },
  { id: "compat-audience", label: "Audience" },
  { id: "compat-content", label: "Content & AI" },
  { id: "compat-developer", label: "Developer API" },
  { id: "compat-objects", label: "Objects" },
];

export function CompatibilityDetailSections({
  groups,
  assets,
  journeys,
  landingPages,
  popups,
  integrations,
  planner,
  multivariate,
  sendTime,
  sendDay,
  clickMap,
  customReport,
  deliveryInsights,
  inbox,
  multiChannel,
  surveys,
  landingParity,
  websiteStatus,
  audienceInsights,
  segmentSchema,
  contentStudio,
  blockCatalog,
  batches,
  accountExports,
  connectedSites,
  verifiedDomains,
  marketplace,
  agencyEcosystem,
  parityWorkbench,
  busy,
  creativeDraft,
  demoActionsEnabled,
  templatePreview,
  videoConversion,
  applyLocalMailchimpClosures,
  createAccountExportSnapshot,
  convertSampleVideo,
  draftCampaignCreative,
  previewSampleTemplate,
  runBatchCompatibilityCheck,
}: CompatibilityDetailSectionsProps) {
  const [activeSection, setActiveSection] = useState(COMPAT_SECTIONS[0].id);

  useEffect(() => {
    const sectionIds = new Set(COMPAT_SECTIONS.map((section) => section.id));
    const syncHash = () => {
      const id = window.location.hash.slice(1);
      if (sectionIds.has(id)) setActiveSection(id);
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);

    if (typeof IntersectionObserver === "undefined") {
      return () => window.removeEventListener("hashchange", syncHash);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const firstVisible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          )[0];
        if (firstVisible) setActiveSection(firstVisible.target.id);
      },
      { rootMargin: "0px 0px -75% 0px", threshold: 0 },
    );
    COMPAT_SECTIONS.forEach(({ id }) => {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    });

    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", syncHash);
    };
  }, []);

  return (
    <>
      <nav
        aria-label="Parity sections"
        className="sticky top-0 z-20 -mx-4 flex touch-pan-x snap-x items-center gap-1 overflow-x-auto overscroll-x-contain border-y bg-background/95 px-4 py-2 shadow-pw-sm backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 lg:mx-0 lg:rounded-lg lg:border lg:px-2"
      >
        {COMPAT_SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={activeSection === s.id ? "location" : undefined}
            onClick={() => setActiveSection(s.id)}
            className={cn(
              "inline-flex min-h-11 shrink-0 snap-start items-center rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-9",
              activeSection === s.id
                ? "border-primary/30 bg-primary/10 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle
                as="h2"
                id="compat-workbench"
                className="flex scroll-mt-28 items-center gap-2 text-base"
              >
                <Boxes className="h-4 w-4" /> Remaining parity workbench
              </CardTitle>
              <CardDescription>
                Execution tasks, provider gates, local closures, and activation
                evidence for the Mailchimp surfaces that still depend on data
                materialization or external credentials.
              </CardDescription>
            </div>
            {demoActionsEnabled && (
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-8"
                onClick={() => void applyLocalMailchimpClosures()}
                disabled={busy !== null}
                loading={busy === "Local closures"}
              >
                {busy !== "Local closures" ? (
                  <Boxes className="h-4 w-4" />
                ) : null}
                Apply local closures
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniList
            title="Streams"
            rows={[
              `Status: ${parityWorkbench?.status ?? "loading"}`,
              `${parityWorkbench?.streams?.length ?? 0} streams tracked`,
              ...(parityWorkbench?.streams ?? [])
                .slice(0, 3)
                .map((stream) => `${stream.stream}: ${stream.status}`),
            ]}
          />
          <MiniList
            title="Execution tasks"
            rows={[
              `${parityWorkbench?.tasks?.length ?? 0} tasks`,
              `${localClosureCount(parityWorkbench?.local_closures, false)} local-only closures`,
              `${localClosureCount(parityWorkbench?.local_closures, true)} provider-gated closures`,
              ...(parityWorkbench?.tasks ?? [])
                .slice(0, 4)
                .map((task) => `${task.stream}: ${task.status}`),
            ]}
          />
          <MiniList
            title="Provider gates"
            rows={[
              `${parityWorkbench?.provider_gates?.length ?? 0} gates`,
              ...(parityWorkbench?.provider_gates ?? [])
                .filter((gate) => !providerGateReady(gate.status))
                .slice(0, 4)
                .map((gate) => ({
                  text: `${gate.label}: ${gate.status}`,
                  href: "/app/integrations",
                })),
            ]}
            action={
              (parityWorkbench?.provider_gates ?? []).some(
                (gate) => !providerGateReady(gate.status),
              )
                ? { label: "Resolve gates", href: "/app/integrations" }
                : undefined
            }
          />
          <MiniList
            title="Activation"
            rows={[
              `Blocked gates: ${String(parityWorkbench?.summary?.blocked_gate_count ?? 0)}`,
              `Foundation tasks: ${String(parityWorkbench?.summary?.foundation_task_count ?? 0)}`,
              `Local complete: ${String(parityWorkbench?.summary?.local_complete_count ?? 0)}`,
              `Generated: ${parityWorkbench?.generated_at ? new Date(parityWorkbench.generated_at).toLocaleString() : "pending"}`,
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle
            as="h2"
            id="compat-intelligence"
            className="flex scroll-mt-28 items-center gap-2 text-base"
          >
            <BarChart3 className="h-4 w-4" /> P1 campaign intelligence
          </CardTitle>
          <CardDescription>
            Live Mailchimp-parity surfaces for planner, multivariate tests,
            optimization, click maps, custom reports, delivery, and replies.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniList
            title="Campaign manager"
            rows={[
              `${planner?.touchpoints?.length ?? 0} calendar touchpoints`,
              `${planner?.tasks?.length ?? 0} planner tasks`,
              `${planner?.workflow?.phases?.filter((p) => p.status === "active").length ?? 0} active workflow phases`,
              `${planner?.channels?.length ?? 0} channels on calendar`,
              ...(planner?.capabilities ?? [])
                .slice(0, 1)
                .map((cap) => `${cap.feature}: ${cap.status}`),
            ]}
          />
          <MiniList
            title="Testing & timing"
            rows={[
              `Multivariate: ${multivariate?.variations?.length ?? 0}/8 variants`,
              `Ready: ${multivariate?.execution?.ready ? "yes" : "needs review"}`,
              ...optimizationEvidenceRows("STO", sendTime),
              ...optimizationEvidenceRows("SDO", sendDay),
            ]}
          />
          <MiniList
            title="Reports"
            rows={[
              `Click map: ${clickMap?.total_clicks ?? 0} clicks`,
              `Overlay: ${clickMap?.overlay ? `${clickMap.overlay.width}px` : "pending"}`,
              `Custom rows: ${customReport?.rows?.length ?? 0}`,
              `Retention: ${String(customReport?.retention?.max_retention ?? "unknown")}`,
              ...(clickMap?.links ?? [])
                .slice(0, 1)
                .map((link) => `${link.url}: ${link.clicks}`),
            ]}
          />
          <MiniList
            title="Delivery & inbox"
            rows={[
              `Delivery: ${deliveryInsights?.delivery_status ?? "unknown"}`,
              `Cancel: ${deliveryInsights?.cancellation_guarantee ?? (deliveryInsights?.can_cancel ? "available" : "no")}`,
              `Replies: ${inbox?.total_items ?? 0}`,
              `Follow-up: ${inbox?.follow_up_open ?? 0}`,
            ]}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle
              as="h2"
              id="compat-multichannel"
              className="flex scroll-mt-28 items-center gap-2 text-base"
            >
              <Megaphone className="h-4 w-4" /> P1/P2 multi-channel parity
            </CardTitle>
            <CardDescription>
              Social, ads, surveys, poll links, postcards, website, and
              landing-page replacement readiness.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <MiniList
              title="Publishing & ads"
              rows={[
                `Mode: ${multiChannel?.operational_mode ?? "unknown"}`,
                `${multiChannel?.summary?.social_posts ?? 0} social posts planned`,
                `${multiChannel?.summary?.ads ?? 0} ad plans`,
                ...(multiChannel?.channels ?? [])
                  .filter(
                    (c) =>
                      c.feature.includes("social") || c.feature.includes("ads"),
                  )
                  .slice(0, 2)
                  .map((c) => `${c.feature}: ${c.status}`),
              ]}
            />
            <MiniList
              title="Provider credentials"
              rows={[
                ...(multiChannel?.provider_setup ?? [])
                  .slice(0, 2)
                  .map((s) => `${s.label}: ${s.status}`),
                ...Object.values(multiChannel?.providers ?? {})
                  .slice(0, 4)
                  .map((p) =>
                    p.status === "configured"
                      ? `${p.provider}: ${p.tenant_scoped ? "tenant" : "env"} configured`
                      : {
                          text: `${p.provider}: missing ${(p.missing ?? []).join(", ") || "credentials"}`,
                          href: "/app/integrations",
                        },
                  ),
              ]}
              action={
                Object.values(multiChannel?.providers ?? {}).some(
                  (p) => p.status !== "configured",
                )
                  ? { label: "Connect providers", href: "/app/integrations" }
                  : undefined
              }
            />
            <MiniList
              title="Surveys & pages"
              rows={[
                `${surveys?.total_items ?? 0} hosted surveys`,
                `Survey builder: ${surveys?.surveys?.[0]?.builder?.mode ?? "ready"}`,
                `Landing parity: ${landingParity?.status ?? "unknown"}`,
                `Landing blocks: ${Array.isArray(landingParity?.builder?.blocks) ? landingParity.builder.blocks.length : 0}`,
                `Website builder: ${websiteStatus?.status ?? "not native"}`,
              ]}
            />
            <MiniList
              title="Warnings"
              rows={(multiChannel?.warnings ?? []).slice(0, 3)}
            />
            <MiniList
              title="Capabilities"
              rows={(multiChannel?.channels ?? [])
                .filter(
                  (c) =>
                    c.feature.includes("poll") ||
                    c.feature.includes("landing") ||
                    c.feature.includes("direct_mail"),
                )
                .slice(0, 3)
                .map((c) => `${c.feature}: ${c.status}`)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle
              as="h2"
              id="compat-audience"
              className="flex scroll-mt-28 items-center gap-2 text-base"
            >
              <Brain className="h-4 w-4" /> Audience intelligence parity
            </CardTitle>
            <CardDescription>
              Contact ratings, profile data, predicted commerce value,
              demographics evidence, groups, and advanced segmentation.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <MiniList
              title="Ratings & CLV"
              rows={[
                ...Object.entries(audienceInsights?.contact_ratings ?? {})
                  .slice(0, 3)
                  .map(([rating, count]) => `${rating} star: ${count}`),
                `CLV: ${String(audienceInsights?.predictive_clv?.status ?? "unavailable")}`,
              ]}
            />
            <MiniList
              title="Demographics"
              rows={Object.entries(
                audienceInsights?.predicted_demographics ?? {},
              )
                .slice(0, 4)
                .map(([country, count]) => `${country}: ${count}`)}
            />
            <MiniList
              title="Segment breadth"
              rows={(segmentSchema?.dimensions ?? [])
                .slice(0, 5)
                .map((dimension) => `${dimension.key}: ${dimension.type}`)}
            />
            <MiniList
              title="Model coverage"
              rows={[
                `${groups.length} group/interests`,
                `${audienceInsights?.segment_dimensions?.length ?? 0} segment dimensions`,
                `${Object.keys(audienceInsights?.status_counts ?? {}).length} contact statuses`,
                `Evaluator: ${String(segmentSchema?.evaluator?.status ?? "unknown")}`,
              ]}
            />
            <MiniList
              title="Model notes"
              rows={(audienceInsights?.model_notes ?? []).slice(0, 3)}
            />
            <MiniList
              title="Segment coverage"
              rows={Object.entries(segmentSchema?.coverage ?? {})
                .slice(0, 4)
                .map(([key, status]) => `${key}: ${status}`)}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle
                as="h2"
                id="compat-content"
                className="flex scroll-mt-28 items-center gap-2 text-base"
              >
                <Sparkles className="h-4 w-4" /> P2 content, AI, and assets
              </CardTitle>
              <CardDescription>
                Content Studio, Mailchimp-style blocks, inline AI, video
                conversion, and template-language compatibility exposed through
                product-facing checks.
              </CardDescription>
            </div>
            {demoActionsEnabled && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => void draftCampaignCreative()}
                  disabled={busy !== null}
                  loading={busy === "Creative Assistant"}
                >
                  {busy !== "Creative Assistant" ? (
                    <Sparkles className="h-4 w-4" />
                  ) : null}
                  Generate creative
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => void convertSampleVideo()}
                  disabled={busy !== null}
                  loading={busy === "Email video"}
                >
                  {busy !== "Email video" ? <Film className="h-4 w-4" /> : null}
                  Convert video
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => void previewSampleTemplate()}
                  disabled={busy !== null}
                  loading={busy === "Template preview"}
                >
                  {busy !== "Template preview" ? (
                    <FilePlus2 className="h-4 w-4" />
                  ) : null}
                  Preview template
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniList
            title="Content Studio"
            rows={[
              `Files: ${contentStudio?.files?.length ?? assets.length}`,
              `Folders: ${contentStudio?.folders?.length ?? 0}`,
              `With alt text: ${contentStudio?.summary?.files_with_alt_text ?? 0}`,
              ...(contentStudio?.capabilities ?? [])
                .slice(0, 2)
                .map((cap) => `${cap.feature}: ${cap.status}`),
            ]}
          />
          <MiniList
            title="Mailchimp blocks"
            rows={[
              `${blockCatalog?.total_items ?? 0} compatible blocks`,
              ...(blockCatalog?.blocks ?? [])
                .filter((block) =>
                  [
                    "product_recommendations",
                    "discount_code",
                    "survey",
                    "social_follow",
                    "rss",
                    "video",
                    "dynamic_content",
                    "conditional_content",
                  ].includes(block.id),
                )
                .slice(0, 4)
                .map((block) => block.name),
            ]}
          />
          <MiniList
            title="Creative Assistant"
            rows={[
              ...(creativeDraft?.subject_lines ?? []).slice(0, 2),
              ...(creativeDraft?.body_drafts ?? []).slice(0, 1),
              ...(creativeDraft?.checklist ?? [])
                .slice(0, 2)
                .map((item) => `Check: ${item}`),
            ]}
          />
          <MiniList
            title="Video & template parity"
            rows={[
              ...(videoConversion
                ? [
                    `${videoConversion.provider}: ${videoConversion.merge_tag}`,
                    videoConversion.plain_text,
                  ]
                : []),
              ...(templatePreview
                ? [
                    `Template tags: ${templatePreview.found_tags.join(", ")}`,
                    templatePreview.required_footer_present
                      ? "Footer check: passed"
                      : "Footer check: required footer missing",
                  ]
                : []),
            ].filter(Boolean)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle
                as="h2"
                id="compat-developer"
                className="flex scroll-mt-28 items-center gap-2 text-base"
              >
                <Route className="h-4 w-4" /> P2 developer/platform API parity
              </CardTitle>
              <CardDescription>
                Batch operations, account exports, connected sites, verified
                domains, Facebook Ads aliases, marketplace, and agency ecosystem
                surfaces.
              </CardDescription>
            </div>
            {demoActionsEnabled && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => void runBatchCompatibilityCheck()}
                  disabled={busy !== null}
                  loading={busy === "Batch API"}
                >
                  {busy !== "Batch API" ? <Route className="h-4 w-4" /> : null}
                  Run batch check
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => void createAccountExportSnapshot()}
                  disabled={busy !== null}
                  loading={busy === "Account export"}
                >
                  {busy !== "Account export" ? (
                    <FilePlus2 className="h-4 w-4" />
                  ) : null}
                  Create export
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniList
            title="Batch operations"
            rows={[
              `${batches?.total_items ?? 0} batch job${(batches?.total_items ?? 0) === 1 ? "" : "s"}`,
              ...(batches?.batches ?? [])
                .slice(0, 3)
                .map(
                  (batch) =>
                    `${batch.status}: ${batch.finished_operations}/${batch.total_operations} ops`,
                ),
            ]}
          />
          <MiniList
            title="Account exports"
            rows={[
              `${accountExports?.total_items ?? 0} export snapshot${(accountExports?.total_items ?? 0) === 1 ? "" : "s"}`,
              ...(accountExports?.exports ?? [])
                .slice(0, 3)
                .map(
                  (item) =>
                    `${item.status}: ${(item.sections ?? []).join(", ")}`,
                ),
            ]}
          />
          <MiniList
            title="Sites & domains"
            rows={[
              `${connectedSites?.total_items ?? 0} connected sites`,
              `${verifiedDomains?.total_items ?? 0} verified domains`,
              ...(verifiedDomains?.domains ?? [])
                .slice(0, 2)
                .map((domain) => `${domain.domain}: ${domain.status}`),
            ]}
          />
          <MiniList
            title="Marketplace & experts"
            rows={[
              `${marketplace?.total_items ?? 0} integration catalog entries`,
              `${agencyEcosystem?.resources?.length ?? 0} partner resources`,
              ...(marketplace?.capabilities ?? [])
                .slice(0, 2)
                .map((cap) => `${cap.feature}: ${cap.status}`),
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle
            as="h2"
            id="compat-objects"
            className="flex scroll-mt-28 items-center gap-2 text-base"
          >
            <Boxes className="h-4 w-4" /> Compatibility objects
          </CardTitle>
          <CardDescription>
            Current tenant-scoped records created by the parity layer.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MiniList title="Groups" rows={groups.map((g) => g.name ?? g.id)} />
          <MiniList
            title="Journeys"
            rows={journeys.map((j) => `${j.name}: ${journeyStatus(j)}`)}
          />
          <MiniList
            title="Growth"
            rows={[...landingPages, ...popups].map(
              (r) => r.name ?? r.slug ?? r.id,
            )}
          />
          <MiniList
            title="Commerce"
            rows={integrations.map(
              (i) => `${i.provider} ${i.shop_domain ?? ""}`,
            )}
          />
        </CardContent>
      </Card>
    </>
  );
}
