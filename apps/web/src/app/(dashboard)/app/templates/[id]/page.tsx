// SPDX-License-Identifier: AGPL-3.0-only
import {
  Archive,
  ArrowLeft,
  ExternalLink,
  FileCode2,
  History,
  Layers3,
} from "lucide-react";
import Link from "next/link";

import { EmailPreviewLazy } from "@/components/EmailPreviewLazy";
import { CopyTextButton } from "@/components/copy-text-button";
import { RelativeTime } from "@/components/relative-time";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  campaignTemplateHostedPreviewAssets,
  getCampaignTemplate,
  getCampaignTemplateFlowUsage,
  listCampaignTemplateRevisions,
} from "@/lib/campaign-templates-api";
import { handleCampaignTemplateRouteError } from "@/lib/campaign-template-route-error";
import { parseCampaignTemplateReturnPath } from "@/lib/campaign-template-navigation";
import { listCampaigns } from "@/lib/campaigns-api";
import { templateVariableEntries } from "@/lib/template-merge-tags";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

import { TemplateCapturePreview } from "../_components/template-capture-preview";
import { TemplateRestoreButton } from "../_components/template-restore-button";
import { TemplateDetailActions } from "../_components/template-detail-actions";
import { TemplateDetailFocus } from "../_components/template-detail-focus";
import { TemplateViewRecorder } from "../_components/template-view-recorder";
import { TemplateOutcomesPanel } from "../_components/template-outcomes-panel";
import { TemplateReviewPanel } from "../_components/template-review-panel";
import {
  LazyAdaptTemplateAction,
  LazyUseTemplateAction,
} from "../_components/deferred-template-actions";
import { TemplatePreviewFrame } from "../_components/template-preview";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ return_to?: string | string[] }>;
}

function humanize(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function provenanceLabel(provenance: Record<string, unknown> | undefined) {
  if (!provenance) return null;
  for (const key of ["source_url", "source_name", "imported_from", "origin"]) {
    if (typeof provenance[key] === "string" && provenance[key]) {
      return String(provenance[key]);
    }
  }
  return null;
}

function regionLabel(region: Record<string, unknown>, index: number): string {
  for (const key of ["name", "label", "key", "id"]) {
    if (typeof region[key] === "string" && region[key]) {
      return String(region[key]);
    }
  }
  return `Region ${index + 1}`;
}

type SecondaryLoadResult<T> = { ok: true; data: T } | { ok: false };

function loadSecondary<T>(
  request: Promise<T>,
): Promise<SecondaryLoadResult<T>> {
  return request.then(
    (data) => ({ ok: true as const, data }),
    () => ({ ok: false as const }),
  );
}

function SecondaryLoadError({
  description,
  id,
  retryHref,
  title,
}: {
  description: string;
  id?: string;
  retryHref: string;
  title: string;
}) {
  return (
    <Card id={id} className="scroll-mt-20 border-destructive/40">
      <CardContent className="space-y-3 p-5 text-sm">
        <div role="alert">
          <h2 className="font-medium">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        {/* A plain anchor deliberately performs a full request so every failed
            server-side lookup is retried rather than restored from client
            navigation state. */}
        <Button asChild type="button" variant="outline" size="sm">
          <a href={retryHref}>Retry</a>
        </Button>
      </CardContent>
    </Card>
  );
}

export default async function TemplateDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const query = await searchParams;
  const returnTo = parseCampaignTemplateReturnPath(
    Array.isArray(query.return_to) ? query.return_to[0] : query.return_to,
  );
  const retryHref = returnTo
    ? `/app/templates/${encodeURIComponent(id)}?return_to=${encodeURIComponent(returnTo)}`
    : `/app/templates/${encodeURIComponent(id)}`;
  let template;
  try {
    template = await getCampaignTemplate(id);
  } catch (error) {
    handleCampaignTemplateRouteError(error, `/app/templates/${id}`);
  }

  const facts = [
    ["Goal", template.goal],
    ["Category", template.category],
    ["Style", template.style],
    ["Industry", template.industry],
    ["Layout", template.layout_archetype],
    ["Source", template.provider || template.source],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const origin = provenanceLabel(template.provenance);
  const variableEntries = templateVariableEntries(template.variables);
  const editableRegions = template.editable_regions ?? [];
  const usageCount = template.usage_count ?? 0;
  const hostedPreviews = campaignTemplateHostedPreviewAssets(template);

  // The secondary fetches remain fail-soft and independent, but preserve their
  // failure state. A transport failure is not an empty usage/history result.
  const [campaignUsage, flowUsage, revisionHistoryResult] = await Promise.all([
    // TMPL-026: campaigns actually built from this template.
    loadSecondary(listCampaigns({ sourceTemplateId: id })),
    // FLOW-029: reverse "used by flows" — which automation flows reference this
    // template.
    loadSecondary(getCampaignTemplateFlowUsage(id)),
    template.tenant_id
      ? loadSecondary(listCampaignTemplateRevisions(id, 1, 8))
      : Promise.resolve(null),
  ]);
  const usedInCampaigns = campaignUsage.ok ? campaignUsage.data : [];
  const sentSourceCampaigns = usedInCampaigns
    .filter((campaign) => campaign.status === "sent")
    .sort((left, right) => (right.sent_at ?? "").localeCompare(left.sent_at ?? ""))
    .map((campaign) => ({ id: campaign.id, name: campaign.name }));
  const usedInFlows = flowUsage.ok ? flowUsage.data : [];
  const revisionHistory = revisionHistoryResult?.ok
    ? revisionHistoryResult.data
    : null;
  const campaignUsageHasTarget =
    !campaignUsage.ok || usedInCampaigns.length > 0;

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 sm:p-6 lg:p-8">
      <TemplateViewRecorder templateId={template.id} />
      <TemplateDetailFocus headingId="template-detail-heading" />
      <Button asChild variant="ghost" className="-ml-3">
        <Link href={asRoute(returnTo ?? "/app/templates")}>
          <ArrowLeft className="h-4 w-4" />
          Newsletter templates
        </Link>
      </Button>

      {template.archived_at ? (
        <Alert>
          <Archive className="h-4 w-4" />
          <AlertTitle>Archived and safely read-only</AlertTitle>
          <AlertDescription>
            This version remains available for preview and audit history, but
            cannot be edited or used in a new campaign. Choose Restore from the
            actions menu when you are ready to use it again.
          </AlertDescription>
        </Alert>
      ) : null}

      <header className="flex flex-col justify-between gap-5 border-b pb-6 lg:flex-row lg:items-start">
        <div className="max-w-3xl">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {template.is_featured ? <Badge>Featured</Badge> : null}
            {template.goal ? (
              <Badge variant="outline">{humanize(template.goal)}</Badge>
            ) : null}
            {template.source ? (
              <Badge variant="secondary">
                {template.provider || humanize(template.source)}
              </Badge>
            ) : null}
            {template.archived_at ? (
              <Badge variant="outline">Archived</Badge>
            ) : null}
            {template.version ? (
              <Badge variant="outline">Version {template.version}</Badge>
            ) : null}
            {usageCount > 0 && campaignUsageHasTarget ? (
              <a
                href="#used-in-campaigns"
                className={cn(
                  badgeVariants({ variant: "outline" }),
                  "font-normal underline-offset-2 hover:underline",
                )}
              >
                Used in {usageCount.toLocaleString()} campaign
                {usageCount === 1 ? "" : "s"}
              </a>
            ) : usageCount > 0 ? (
              <Badge variant="outline" className="font-normal">
                Used in {usageCount.toLocaleString()} campaign
                {usageCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </div>
          <h1
            id="template-detail-heading"
            tabIndex={-1}
            className="font-display text-3xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {template.name}
          </h1>
          {template.description ? (
            <p className="mt-2 text-base leading-7 text-muted-foreground">
              {template.description}
            </p>
          ) : null}
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span>
              <span className="text-muted-foreground">Suggested subject: </span>
              <span className="font-medium">{template.subject}</span>
            </span>
            <CopyTextButton
              value={template.subject}
              label="Copy"
              variant="ghost"
              size="sm"
              toastOnCopy={false}
            />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TemplateDetailActions template={template} />
          <Button asChild variant="outline">
            <Link href={`/app/templates/${template.id}/preview`}>
              <ExternalLink className="h-4 w-4" />
              Client preview
            </Link>
          </Button>
          <LazyAdaptTemplateAction template={template} label="Make it mine" />
          {template.template_kind !== "reference" ? (
            <LazyUseTemplateAction template={template} label="Use template" />
          ) : null}
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="design-preview-heading" className="min-w-0">
          <h2 id="design-preview-heading" className="sr-only">
            Design preview
          </h2>
          {template.template_kind === "reference" ? (
            hostedPreviews.length ? (
              <TemplateCapturePreview
                assets={hostedPreviews}
                templateName={template.name}
              />
            ) : (
              <Card>
                <CardContent className="space-y-2 p-8 text-center">
                  <p className="font-medium">Hosted preview unavailable</p>
                  <p className="text-sm text-muted-foreground">
                    This inspiration record is metadata-only until Moosewave has
                    a reviewed, sanitized hosted capture. Provider markup and
                    image URLs are never rendered here.
                  </p>
                </CardContent>
              </Card>
            )
          ) : template.body_html?.trim() ? (
            <TemplatePreviewFrame
              html={template.body_html}
              title={`${template.name} visual preview`}
            />
          ) : template.body_mjml?.trim() ? (
            <EmailPreviewLazy mjml={template.body_mjml} />
          ) : hostedPreviews.length ? (
            <TemplateCapturePreview
              assets={hostedPreviews}
              templateName={template.name}
            />
          ) : (
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                No governed preview is available for this template.
              </CardContent>
            </Card>
          )}
        </section>

        <aside className="space-y-4">
          <Card>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <Layers3 className="h-4 w-4 text-muted-foreground" />
                <h2 className="font-medium">Design details</h2>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-4 text-sm">
                {facts.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 font-medium">{humanize(value)}</dd>
                  </div>
                ))}
                {template.updated_at ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">Updated</dt>
                    <dd className="mt-0.5 font-medium">
                      <RelativeTime iso={template.updated_at} />
                    </dd>
                  </div>
                ) : null}
                {template.created_at ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">Created</dt>
                    <dd className="mt-0.5 font-medium">
                      <RelativeTime iso={template.created_at} />
                    </dd>
                  </div>
                ) : null}
              </dl>
              {template.tags.length ? (
                <div className="border-t pt-4">
                  <p className="mb-2 text-xs text-muted-foreground">Tags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {template.tags
                      .filter((tag) => !tag.includes(":"))
                      .slice(0, 12)
                      .map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className="font-normal"
                        >
                          {humanize(tag)}
                        </Badge>
                      ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {template.tenant_id && template.template_kind !== "reference" && template.version && template.etag ? (
            <TemplateReviewPanel
              templateId={template.id}
              version={template.version}
              etag={template.etag}
              canWrite={template.capabilities?.can_edit_directly === true && !template.archived_at}
            />
          ) : null}

          {revisionHistoryResult && !revisionHistoryResult.ok ? (
            <SecondaryLoadError
              title="Version history unavailable"
              description="The version-history request failed. No missing history has been inferred."
              retryHref={retryHref}
            />
          ) : revisionHistory?.items?.length ? (
            <Card>
              <CardContent className="space-y-3 p-5 text-sm">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-medium">Version history</h2>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Every save and lifecycle change keeps an immutable snapshot.
                </p>
                <ol className="space-y-2 border-t pt-3">
                  {revisionHistory.items.map((revision) => (
                    <li
                      key={revision.version}
                      className="flex items-center justify-between gap-3"
                    >
                      <span>
                        <span className="font-medium">
                          Version {revision.version}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {humanize(revision.transition)}
                          {revision.changed_by_email
                            ? ` · ${revision.changed_by_email}`
                            : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <RelativeTime iso={revision.snapshot_time} />
                        {template.version != null &&
                        revision.version !== template.version ? (
                          <TemplateRestoreButton
                            templateId={id}
                            version={revision.version}
                          />
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
                {revisionHistory.total > revisionHistory.items.length ? (
                  <p className="text-xs text-muted-foreground">
                    Showing the latest {revisionHistory.items.length} of{" "}
                    {revisionHistory.total.toLocaleString()} versions.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {!campaignUsage.ok || usedInCampaigns.length > 0 ? (
            <div id="used-in-campaigns" className="scroll-mt-20">
              {!campaignUsage.ok ? (
                <SecondaryLoadError
                  title="Campaign usage unavailable"
                  description="The campaign-usage request failed. This template may still be in use."
                  retryHref={retryHref}
                />
              ) : (
                <Card>
                  <CardContent className="space-y-3 p-5 text-sm">
                    <div className="flex items-center gap-2">
                      <Layers3 className="h-4 w-4 text-muted-foreground" />
                      <h2 className="font-medium">
                        Used in {usedInCampaigns.length.toLocaleString()}{" "}
                        campaign{usedInCampaigns.length === 1 ? "" : "s"}
                      </h2>
                    </div>
                    <ul className="space-y-1.5">
                      {usedInCampaigns.slice(0, 20).map((campaign) => (
                        <li key={campaign.id}>
                          <Link
                            href={`/app/campaigns/${campaign.id}`}
                            className="flex min-h-11 items-center truncate rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                          >
                            {campaign.name || "Untitled campaign"}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {usedInCampaigns.length > 20 ? (
                      <p className="text-xs text-muted-foreground">
                        Showing 20 of {usedInCampaigns.length.toLocaleString()}.
                      </p>
                    ) : null}
                    {sentSourceCampaigns.length > 0 ? (
                      <TemplateOutcomesPanel campaigns={sentSourceCampaigns} />
                    ) : null}
                  </CardContent>
                </Card>
              )}
            </div>
          ) : null}

          {/* FLOW-029: reverse "used by flows". */}
          {!flowUsage.ok || usedInFlows.length > 0 ? (
            <div id="used-in-flows" className="scroll-mt-20">
              {!flowUsage.ok ? (
                <SecondaryLoadError
                  title="Flow usage unavailable"
                  description="The flow-usage request failed. This template may still be referenced by a flow."
                  retryHref={retryHref}
                />
              ) : (
                <Card>
                  <CardContent className="space-y-3 p-5 text-sm">
                    <div className="flex items-center gap-2">
                      <Layers3 className="h-4 w-4 text-muted-foreground" />
                      <h2 className="font-medium">
                        Used in {usedInFlows.length.toLocaleString()} flow
                        {usedInFlows.length === 1 ? "" : "s"}
                      </h2>
                    </div>
                    <ul className="space-y-1.5">
                      {usedInFlows.slice(0, 20).map((flow) => (
                        <li key={flow.id}>
                          <Link
                            href={`/app/flows/${flow.id}`}
                            className="block truncate underline-offset-4 hover:underline"
                          >
                            {flow.name || "Untitled flow"}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {usedInFlows.length > 20 ? (
                      <p className="text-xs text-muted-foreground">
                        Showing 20 of {usedInFlows.length.toLocaleString()}.
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              )}
            </div>
          ) : null}

          <Card>
            <CardContent className="space-y-3 p-5 text-sm">
              <div className="flex items-center gap-2">
                <FileCode2 className="h-4 w-4 text-muted-foreground" />
                <h2 className="font-medium">Editable source</h2>
              </div>
              <p className="leading-6 text-muted-foreground">
                {template.template_kind === "reference"
                  ? "Visual inspiration. Choose Make it mine to produce an original, editable newsletter before creating a campaign."
                  : template.body_mjml
                    ? "MJML and compiled HTML are available in Moosewave. MCP client distribution is release-held."
                    : "Email-safe HTML is available in Moosewave. MCP client distribution is release-held."}
              </p>
              {variableEntries.length ? (
                <div className="border-t pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">
                    Merge variables ({variableEntries.length})
                  </p>
                  <ul className="space-y-1.5">
                    {variableEntries.map((entry) => (
                      <li
                        key={entry.key}
                        className="flex items-baseline justify-between gap-3 text-xs"
                      >
                        <code className="font-mono text-foreground">
                          {`{{ ${entry.key} }}`}
                        </code>
                        {entry.value ? (
                          <span className="truncate text-muted-foreground">
                            {entry.value}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="flex justify-between gap-3 border-t pt-3 text-xs">
                  <span className="text-muted-foreground">Merge variables</span>
                  <span>0</span>
                </div>
              )}
              {editableRegions.length ? (
                <div className="border-t pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">
                    Editable regions ({editableRegions.length})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {editableRegions.slice(0, 12).map((region, index) => (
                      <Badge
                        key={index}
                        variant="outline"
                        className="font-normal"
                      >
                        {humanize(regionLabel(region, index))}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {template.license_status ? (
                <div className="flex justify-between gap-3 border-t pt-3 text-xs">
                  <span className="text-muted-foreground">License</span>
                  <span>{humanize(template.license_status)}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {origin ? (
            <Card>
              <CardContent className="p-5 text-xs leading-5 text-muted-foreground">
                <span className="font-medium text-foreground">
                  Provenance:{" "}
                </span>
                {origin}
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
