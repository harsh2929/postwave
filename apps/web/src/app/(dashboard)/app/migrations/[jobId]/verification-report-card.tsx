// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Download } from "lucide-react";

import { ResourceCompleteness } from "@/components/migration/resource-completeness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { downloadTextFile } from "@/lib/download";
import { buildVerificationReportCsv } from "@/lib/migration-verification-export";
import {
  SOURCE_LABELS,
  type SourcePlatform,
  type VerificationReport,
} from "@/lib/types";

import { Stat } from "./migration-detail-primitives";

export function VerificationReportCard({
  report,
  source,
  preview = false,
}: {
  report: VerificationReport;
  source?: SourcePlatform;
  preview?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isActiveCampaign = source === "activecampaign";
  const isBeehiiv = source === "beehiiv";
  const isKlaviyo = source === "klaviyo";
  const isCustomerIO = source === "customerio";
  const isRebuildOnly =
    isActiveCampaign || isBeehiiv || isKlaviyo || isCustomerIO;
  // The server marshals an empty Go slice as `null`, so a job with nothing
  // untranslatable arrives without an array here; reading `.length` on it
  // would take the whole migration detail page down with the error boundary
  // the moment an operator expands the report.
  const unsupportedAutomations = Array.isArray(report.automations_unsupported)
    ? report.automations_unsupported
    : [];
  const fidelity = 100 - report.data_loss_estimate_pct;
  const fidelityVariant: "success" | "warning" | "destructive" =
    fidelity >= 99 ? "success" : fidelity >= 95 ? "warning" : "destructive";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Verification report</CardTitle>
            <CardDescription>
              {preview
                ? "Dry-run estimates and translation findings. These counts do not confirm an import."
                : "Recorded import counts and translation findings."}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={fidelityVariant}>
              {fidelity.toFixed(1)}% fidelity
            </Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                downloadTextFile(
                  "migration-verification-report.csv",
                  buildVerificationReportCsv(
                    report,
                    source ? SOURCE_LABELS[source] : "source",
                    preview ? "preview" : "imported",
                  ),
                  "text/csv;charset=utf-8",
                )
              }
            >
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label={
              isKlaviyo
                ? "Primary-email profiles"
                : isCustomerIO
                  ? "Email-addressable cio_id profiles"
                  : "Subscribers"
            }
            value={report.subscribers_imported}
          />
          <Stat
            label={
              isCustomerIO
                ? "Frozen segment/topic memberships"
                : isKlaviyo
                  ? "Suppression-filtered audience snapshots"
                  : isBeehiiv
                    ? "Frozen segment/list snapshots"
                    : "Segments"
            }
            value={report.segments_translated}
          />
          <Stat
            label={
              isBeehiiv
                ? "Automation rebuild records"
                : isKlaviyo
                  ? "Flow rebuild records"
                  : isCustomerIO
                    ? "Workflow rebuild records"
                    : isActiveCampaign
                      ? "Automation rebuilds"
                      : "Automations"
            }
            value={
              isRebuildOnly
                ? automationRebuildCount(report)
                : report.automations_translated
            }
          />
          <Stat
            label={
              isKlaviyo
                ? "Sent email campaign archive"
                : isCustomerIO
                  ? "Sent email newsletter archive"
                  : "Archive posts"
            }
            value={report.archive_imported}
          />
          <Stat
            label={
              isCustomerIO
                ? "Workflow/channel/ecosystem evidence"
                : isKlaviyo
                  ? "SMS/push and rebuild source archive"
                  : "Source archive"
            }
            value={report.source_archive_imported ?? 0}
          />
          {isBeehiiv ? (
            <>
              <Stat
                label="Premium memberships (metadata)"
                value={resourceImported(report, "premium_memberships")}
              />
              <Stat
                label="Stripe billing objects imported"
                value={report.paid_subs_imported}
              />
            </>
          ) : isCustomerIO ? (
            <Stat label="Paid subscriptions (not imported)" value={0} />
          ) : (
            <Stat label="Paid subs" value={report.paid_subs_imported} />
          )}
          <Stat label="Suppressed" value={report.suppression_list_size} />
          <Stat
            label="Merged contacts"
            value={report.duplicate_subscribers_merged ?? 0}
          />
        </div>
        <CutoverSurfaceSummary report={report} />
        {open && (
          <>
            <Separator />
            <ResourceCompleteness
              rows={report.resource_completeness}
              preview={preview}
            />
            <Separator />
            <section>
              <h3 className="mb-2 text-sm font-medium">Custom field mapping</h3>
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th
                        scope="col"
                        className="px-3 py-2 text-left font-medium"
                      >
                        Source
                      </th>
                      <th
                        scope="col"
                        className="px-3 py-2 text-left font-medium"
                      >
                        Moosewave field
                      </th>
                      <th
                        scope="col"
                        className="px-3 py-2 text-left font-medium"
                      >
                        Type
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.custom_fields_mapped.map((m, i) => (
                      <tr key={`mapped-${m.source}-${i}`} className="border-t">
                        <td className="px-3 py-2 font-mono text-xs">
                          {m.source}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {m.canonical}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {m.type}
                        </td>
                      </tr>
                    ))}
                    {report.custom_fields_unmapped.map((u, i) => (
                      <tr
                        key={`unmapped-${u}-${i}`}
                        className="border-t bg-warning-subtle/50"
                      >
                        <td className="px-3 py-2 font-mono text-xs">{u}</td>
                        <td
                          className="px-3 py-2 text-xs text-muted-foreground"
                          colSpan={2}
                        >
                          Preserved as subscriber attributes
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <SubscriberMergeSection report={report} />
            <StringWarningSection
              title="Discovery warnings"
              warnings={report.discovery_warnings}
            />
            <ResourceWarningSection
              title="Campaign archive warnings"
              warnings={report.campaign_archive_warnings}
            />
            <ResourceWarningSection
              title="Template warnings"
              warnings={report.template_warnings}
            />
            <ResourceWarningSection
              title="Source archive warnings"
              warnings={report.source_archive_warnings}
            />
            {report.segments_with_warnings.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">Segment warnings</h3>
                <ul className="space-y-1.5">
                  {report.segments_with_warnings.map((s, i) => (
                    <li
                      key={`${s.name}-${i}`}
                      className="rounded-md border bg-warning-subtle/50 p-3 text-sm"
                    >
                      <span className="font-medium">{s.name}</span>{" "}
                      <span className="text-muted-foreground">
                        - {s.warning}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {unsupportedAutomations.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">
                  {isRebuildOnly
                    ? isBeehiiv
                      ? "Beehiiv automations to rebuild or retire"
                      : isKlaviyo
                        ? "Klaviyo flows to rebuild or waive"
                        : isCustomerIO
                          ? "Customer.io workflows to rebuild or retire"
                          : "Automation rebuilds to review"
                    : "Automations we couldn't translate"}
                </h3>
                <ul className="space-y-1.5">
                  {unsupportedAutomations.map((a, i) => (
                    <li
                      key={`${a.name}-${i}`}
                      className="rounded-md border bg-warning-subtle/50 p-3 text-sm"
                    >
                      <p className="font-medium">{a.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {a.reason}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </CardContent>
      <CardFooter>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? (
            <>
              Hide details <ChevronUp className="h-4 w-4" />
            </>
          ) : (
            <>
              Show full report <ChevronDown className="h-4 w-4" />
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}

function StringWarningSection({
  title,
  warnings,
}: {
  title: string;
  warnings?: string[];
}) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <ul className="space-y-1.5">
        {warnings.map((warning, i) => (
          <li
            key={`${warning}-${i}`}
            className="rounded-md border bg-warning-subtle/50 p-3 text-sm"
          >
            {warning}
          </li>
        ))}
      </ul>
    </section>
  );
}

function automationRebuildCount(report: VerificationReport): number {
  return (
    report.resource_completeness?.find((row) => row.resource === "automations")
      ?.source_total ??
    (Array.isArray(report.automations_unsupported)
      ? report.automations_unsupported.length
      : 0)
  );
}

function resourceImported(
  report: VerificationReport,
  resource: string,
): number {
  return (
    report.resource_completeness?.find((row) => row.resource === resource)
      ?.imported ?? 0
  );
}

function ResourceWarningSection({
  title,
  warnings,
}: {
  title: string;
  warnings?: VerificationReport["campaign_archive_warnings"];
}) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <ul className="space-y-1.5">
        {warnings.map((warning, i) => (
          <li
            key={`${warning.resource}-${warning.source_id ?? warning.name}-${i}`}
            className="rounded-md border bg-warning-subtle/50 p-3 text-sm"
          >
            <p className="font-medium">{warning.name || warning.source_id}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {warning.warning}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SubscriberMergeSection({ report }: { report: VerificationReport }) {
  const merges = report.subscriber_merge_conflicts ?? [];
  if (merges.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">Subscriber merges</h3>
      <ul className="space-y-1.5">
        {merges.map((merge) => (
          <li key={merge.email} className="rounded-md border p-3 text-sm">
            <p className="font-medium">{merge.email}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {merge.source_ids?.length ?? 0} source rows merged
              {merge.conflict_fields && merge.conflict_fields.length > 0
                ? `; conflicts preserved for ${merge.conflict_fields.join(", ")}`
                : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

type ResourceCompletenessRow = NonNullable<
  VerificationReport["resource_completeness"]
>[number];

const CUTOVER_REVIEW_RESOURCES = new Set([
  "automations",
  "templates",
  "forms",
  "landing",
  "landing_pages",
  "ecommerce",
  "reports",
  "crm",
  "custom_objects",
  "sms",
  "omni_channels",
  "paid_subs",
  "beehiiv_website_capture_rebuild",
  "beehiiv_boosts_recommendations_rebuild",
  "beehiiv_ad_network_rebuild",
]);

function CutoverSurfaceSummary({ report }: { report: VerificationReport }) {
  const rows = (report.resource_completeness ?? []).filter(
    (row) =>
      row.source_total > 0 &&
      CUTOVER_REVIEW_RESOURCES.has(row.resource) &&
      (row.imported > 0 ||
        row.status === "preserved_for_rebuild" ||
        row.status === "manual_rebuild_required" ||
        row.status === "not_supported"),
  );
  if (rows.length === 0) return null;

  return (
    <section className="rounded-md border bg-muted/20 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Cutover review surfaces</h3>
        <span className="text-xs text-muted-foreground">
          Imported, preserved, or requiring rebuild
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.resource}
            className="rounded-md bg-background p-2 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{row.label}</span>
              <Badge variant={resourceStatusVariant(row)}>
                {row.status.replaceAll("_", " ")}
              </Badge>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {row.imported.toLocaleString()} of{" "}
              {row.source_total.toLocaleString()} represented
            </div>
            {row.notes?.[0] ? (
              <div className="mt-1 text-xs text-muted-foreground">
                {row.notes[0]}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function resourceStatusVariant(
  row: ResourceCompletenessRow,
): "success" | "warning" | "secondary" | "destructive" {
  if (row.status === "imported_runtime") return "success";
  if (
    row.status === "partial_runtime" ||
    row.status === "preserved_for_rebuild" ||
    row.status === "manual_rebuild_required"
  ) {
    return "warning";
  }
  if (row.status === "not_supported") return "destructive";
  return "secondary";
}
