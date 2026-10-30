// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";

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
import type { SourcePlatform, VerificationReport } from "@/lib/types";

interface ReviewBreakdownCardProps {
  busy: boolean;
  source?: SourcePlatform;
  report: VerificationReport;
  onBack: () => void;
  onCommit: () => void | Promise<void>;
}

export function ReviewBreakdownCard({
  busy,
  source,
  report,
  onBack,
  onCommit,
}: ReviewBreakdownCardProps) {
  // `busy` arrives ORed with the review step's validation blocks (past
  // schedule, expired source session, missing Mailchimp audience scope), so it
  // cannot drive the spinner: a schedule typo would otherwise leave Commit
  // spinning forever with no request behind it. Track the commit this card
  // actually started and let `busy` do nothing but disable.
  const [committing, setCommitting] = useState(false);
  const handleCommit = async () => {
    if (committing) return;
    setCommitting(true);
    try {
      await onCommit();
    } finally {
      setCommitting(false);
    }
  };
  // The API omits automations_unsupported (wire `null`) when nothing was
  // untranslatable, so this is not the empty array the type promises.
  const unsupportedAutomations = Array.isArray(report.automations_unsupported)
    ? report.automations_unsupported
    : [];
  const isActiveCampaign = source === "activecampaign";
  const isBeehiiv = source === "beehiiv";
  const isKlaviyo = source === "klaviyo";
  const isCustomerIO = source === "customerio";
  const isHubSpot = source === "hubspot";
  const isRebuildOnly =
    isActiveCampaign || isBeehiiv || isKlaviyo || isCustomerIO;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Full dry-run breakdown</CardTitle>
            <CardDescription>
              Per-resource fidelity, custom-field mapping, and the long tail of
              warnings.
            </CardDescription>
          </div>
          <FidelityBadge lossPct={report.data_loss_estimate_pct} />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
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
                    : isHubSpot
                      ? "Frozen list/subscription targeting boundaries"
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
                ? activeCampaignAutomationRebuildCount(report)
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
          {isKlaviyo || isCustomerIO ? (
            <Stat
              label={
                isCustomerIO
                  ? "Workflow/channel/ecosystem evidence"
                  : "SMS/push and rebuild source archive"
              }
              value={report.source_archive_imported ?? 0}
            />
          ) : null}
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
          ) : isCustomerIO ? null : (
            <Stat label="Paid subs" value={report.paid_subs_imported} />
          )}
          <Stat label="Suppressed" value={report.suppression_list_size} />
          <Stat
            label="Merged contacts"
            value={report.duplicate_subscribers_merged ?? 0}
          />
        </div>

        <Separator />

        <ResourceCompleteness rows={report.resource_completeness} preview />

        <CustomFieldMappingTable report={report} />

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

        {unsupportedAutomations.length > 0 && (
          <UnsupportedAutomationsSection
            source={source}
            automations={unsupportedAutomations}
          />
        )}

        {report.segments_with_warnings.length > 0 && (
          <SegmentWarningsSection segments={report.segments_with_warnings} />
        )}
      </CardContent>
      <CardFooter className="justify-between">
        {/* Only an in-flight commit locks Back: aborting the fetch does not
            un-commit a job the server already accepted, so leaving mid-commit
            rewinds the wizard while the real import is running. A validation
            block leaves Back available — it is the way out of the block. */}
        <Button variant="ghost" onClick={onBack} disabled={committing}>
          <ArrowLeft className="h-4 w-4" /> Go back / re-map
        </Button>
        <Button
          onClick={() => void handleCommit()}
          disabled={busy || committing}
        >
          {committing && <Loader2 className="h-4 w-4 animate-spin" />}
          Commit migration
        </Button>
      </CardFooter>
    </Card>
  );
}

function FidelityBadge({ lossPct }: { lossPct: number }) {
  const fidelity = 100 - lossPct;
  const variant: "success" | "warning" | "destructive" =
    fidelity >= 99 ? "success" : fidelity >= 95 ? "warning" : "destructive";
  return <Badge variant={variant}>{fidelity.toFixed(1)}% fidelity</Badge>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value.toLocaleString()}</p>
    </div>
  );
}

function activeCampaignAutomationRebuildCount(
  report: VerificationReport,
): number {
  // automations_unsupported arrives as wire `null` on a job with nothing
  // untranslatable, and this fallback runs exactly then.
  const unsupported = Array.isArray(report.automations_unsupported)
    ? report.automations_unsupported
    : [];
  return (
    report.resource_completeness?.find((row) => row.resource === "automations")
      ?.source_total ?? unsupported.length
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
      <h3 className="text-sm font-medium mb-2">{title}</h3>
      <ul className="space-y-1.5">
        {warnings.map((warning, i) => (
          <li
            key={`${warning}-${i}`}
            className="text-sm rounded-md border bg-warning-subtle/50 p-3"
          >
            {warning}
          </li>
        ))}
      </ul>
    </section>
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
      <h3 className="text-sm font-medium mb-2">{title}</h3>
      <ul className="space-y-1.5">
        {warnings.map((warning, i) => (
          <li
            key={`${warning.resource}-${warning.source_id ?? warning.name}-${i}`}
            className="text-sm rounded-md border bg-warning-subtle/50 p-3"
          >
            <p className="font-medium">{warning.name || warning.source_id}</p>
            <p className="text-muted-foreground text-xs mt-0.5">
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
      <h3 className="text-sm font-medium mb-2">Subscriber merges</h3>
      <ul className="space-y-1.5">
        {merges.map((merge) => (
          <li key={merge.email} className="text-sm rounded-md border p-3">
            <p className="font-medium">{merge.email}</p>
            <p className="text-muted-foreground text-xs mt-0.5">
              {merge.source_ids?.length ?? 0} Mailchimp rows merged
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

function CustomFieldMappingTable({ report }: { report: VerificationReport }) {
  return (
    <section>
      <h3 className="text-sm font-medium mb-2">Custom field mapping</h3>
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="text-left font-medium px-3 py-2">
                Source
              </th>
              <th scope="col" className="text-left font-medium px-3 py-2">
                Moosewave field
              </th>
              <th scope="col" className="text-left font-medium px-3 py-2">
                Type
              </th>
            </tr>
          </thead>
          <tbody>
            {report.custom_fields_mapped.map((mapping) => (
              <tr key={mapping.source} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">
                  {mapping.source}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {mapping.canonical}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {mapping.type}
                </td>
              </tr>
            ))}
            {report.custom_fields_unmapped.map((field) => (
              <tr key={field} className="border-t bg-warning-subtle/50">
                <td className="px-3 py-2 font-mono text-xs">{field}</td>
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
  );
}

function UnsupportedAutomationsSection({
  source,
  automations,
}: {
  source?: SourcePlatform;
  automations: VerificationReport["automations_unsupported"];
}) {
  const isActiveCampaign = source === "activecampaign";
  const isBeehiiv = source === "beehiiv";
  const isKlaviyo = source === "klaviyo";
  const isCustomerIO = source === "customerio";
  const isRebuildOnly =
    isActiveCampaign || isBeehiiv || isKlaviyo || isCustomerIO;
  return (
    <section>
      <h3 className="text-sm font-medium mb-2">
        {isRebuildOnly
          ? isBeehiiv
            ? "Beehiiv automations to rebuild or retire"
            : isKlaviyo
              ? "Klaviyo flows to rebuild or waive"
              : isCustomerIO
                ? "Customer.io workflows to rebuild or retire"
                : "Automation rebuilds to review"
          : "Automations we can't translate"}
      </h3>
      <ul className="space-y-1.5">
        {automations.map((automation) => (
          <li
            key={automation.name}
            className="text-sm rounded-md border bg-warning-subtle/50 p-3 flex items-start justify-between gap-3"
          >
            <div>
              <p className="font-medium">{automation.name}</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {automation.reason}
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href="/app/sequences/new">
                {isRebuildOnly
                  ? "Rebuild in Sequences"
                  : "Recreate in Sequences"}
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
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

function SegmentWarningsSection({
  segments,
}: {
  segments: VerificationReport["segments_with_warnings"];
}) {
  return (
    <section>
      <h3 className="text-sm font-medium mb-2">Segment warnings</h3>
      <ul className="space-y-1.5">
        {segments.map((segment) => (
          <li
            key={segment.name}
            className="text-sm rounded-md border bg-warning-subtle/50 p-3"
          >
            <span className="font-medium">{segment.name}</span>{" "}
            <span className="text-muted-foreground">— {segment.warning}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
