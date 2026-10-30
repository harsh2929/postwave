// SPDX-License-Identifier: AGPL-3.0-only
//
// Dry-run preview card — listed alongside the existing dry-run report
// detail. Renders one row per resource ("we'd import N subscribers, M
// campaigns, K sequences") and a yellow banner of features that won't
// migrate as-is.
"use client";

import type { ReactNode } from "react";

import type { VerificationReport } from "@/lib/types";
import { boundPreview, prettyJsonValue } from "@/lib/json-preview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

interface UnsupportedFeature {
  id: string;
  label: string;
  note: string;
}

interface Props {
  jobId: string;
  sourceLabel: string;
  preview: VerificationReport;
  onConfirm: () => void;
  onCancel: () => void;
  /** In-flight: disables BOTH buttons and shows "Starting…". */
  busy?: boolean;
  /**
   * MIGR-038: blocks only the confirm/commit button (e.g. a past schedule or a
   * blocked session) while keeping Cancel/navigation available. Defaults to
   * `busy` so existing callers are unchanged.
   */
  commitDisabled?: boolean;
}

export function DryRunPreviewCard({
  jobId,
  sourceLabel,
  preview,
  onConfirm,
  onCancel,
  busy,
  commitDisabled,
}: Props) {
  const subscribers = preview.subscribers_imported;
  const segments = preview.segments_translated;
  const automations = preview.automations_translated;
  const isActiveCampaign = sourceLabel === "ActiveCampaign";
  const isBeehiiv = sourceLabel === "Beehiiv";
  const isKlaviyo = sourceLabel === "Klaviyo";
  const isCustomerIO = sourceLabel === "Customer.io";
  const isMailchimp = sourceLabel === "Mailchimp";
  // The verifier only ever appends to this slice and the canonical struct has
  // no `omitempty`, so a job with nothing untranslatable arrives as JSON
  // `null`. Read it through one guard: a bare `.length` here takes the whole
  // plan-review step down behind the error boundary, and the migration can then
  // never be committed. Array.isArray rather than `?? []` because the nullish
  // guard admits a truthy non-array straight into the loop below.
  const unsupportedAutomations = Array.isArray(preview.automations_unsupported)
    ? preview.automations_unsupported
    : [];
  const automationRebuildTotal =
    preview.resource_completeness?.find((row) => row.resource === "automations")
      ?.source_total ?? unsupportedAutomations.length;
  const archive = preview.archive_imported;
  const paidSubs = preview.paid_subs_imported;
  const premiumMembershipMetadata =
    preview.resource_completeness?.find(
      (row) => row.resource === "premium_memberships",
    )?.imported ?? 0;
  const suppressed = preview.suppression_list_size;
  const reviewSurfaceRows = cutoverReviewRows(preview);
  const preservedFields = preview.custom_fields_unmapped ?? [];
  const mergedContacts = preview.duplicate_subscribers_merged ?? 0;

  const unsupported: UnsupportedFeature[] = [];
  for (const warning of preview.discovery_warnings ?? []) {
    unsupported.push({
      id: `discovery:${warning}`,
      label: "Discovery warning",
      note: warning,
    });
  }
  for (const u of unsupportedAutomations) {
    unsupported.push({
      id: `automation:${u.name}`,
      label: u.name,
      note: u.reason,
    });
  }
  for (const w of preview.segments_with_warnings ?? []) {
    unsupported.push({
      id: `segment:${w.name}`,
      label: `Segment "${w.name}"`,
      note: w.warning,
    });
  }
  for (const w of preview.campaign_archive_warnings ?? []) {
    unsupported.push({
      id: `campaign:${w.source_id ?? w.name}`,
      label: w.name ? `Campaign "${w.name}"` : "Campaign archive",
      note: w.warning,
    });
  }
  for (const w of preview.template_warnings ?? []) {
    unsupported.push({
      id: `template:${w.source_id ?? w.name}`,
      label: w.name ? `Template "${w.name}"` : "Template",
      note: w.warning,
    });
  }
  for (const w of preview.source_archive_warnings ?? []) {
    unsupported.push({
      id: `source-archive:${w.resource}:${w.source_id ?? w.name}`,
      label: w.name ? `Source archive "${w.name}"` : "Source archive",
      note: w.warning,
    });
  }

  return (
    <Card data-testid="dry-run-preview">
      <CardHeader>
        <CardTitle>Plan review</CardTitle>
        <CardDescription>
          Dry-run for {sourceLabel} · job <code>{jobId.slice(0, 8)}</code>…
          Nothing has been imported yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ResourceRow
          label={
            isKlaviyo
              ? "Primary-email profiles"
              : isCustomerIO
                ? "Email-addressable cio_id profiles"
                : "Subscribers"
          }
          n={subscribers}
          verb="will be imported"
          note={
            suppressed > 0
              ? `${suppressed.toLocaleString()} suppressed or unsubscribed at the source (preserved)`
              : undefined
          }
        />
        <ResourceRow
          label={
            isCustomerIO
              ? "Frozen segment/topic memberships"
              : isKlaviyo
                ? "Suppression-filtered audience snapshots"
                : isBeehiiv
                  ? "Frozen segment/list snapshots"
                  : "Segments"
          }
          n={segments}
          verb={
            isBeehiiv || isKlaviyo || isCustomerIO
              ? "will be imported as tag-backed snapshots"
              : "will be created"
          }
        />
        {isActiveCampaign || isBeehiiv || isKlaviyo || isCustomerIO ? (
          <ResourceRow
            label={
              isBeehiiv
                ? "Beehiiv automation rebuild records"
                : isKlaviyo
                  ? "Klaviyo flow rebuild records"
                  : isCustomerIO
                    ? "Customer.io workflow rebuild records"
                    : "Automation rebuilds"
            }
            n={automationRebuildTotal}
            verb={
              isBeehiiv
                ? "must be rebuilt or retired"
                : isKlaviyo
                  ? "must be rebuilt or waived"
                  : isCustomerIO
                    ? "must be rebuilt or retired"
                    : "need rebuild review"
            }
            note={
              isBeehiiv
                ? "Automation metadata and email/statistics inventory are source-preserved. Beehiiv does not expose executable graphs or message bodies, and no runtime automation is activated."
                : isKlaviyo
                  ? "Flow trigger metadata and source evidence are preserved. Executable graphs, splits, webhooks, message variants, and profile/list update actions require rebuild review; no Klaviyo flow is activated as a Moosewave runtime automation."
                  : isCustomerIO
                    ? "Campaign automation and API-broadcast definitions plus hydrated actions are preserved. They are rebuild evidence only; no Customer.io workflow is activated as a Moosewave runtime automation."
                    : "Source definitions are preserved; no ActiveCampaign automation is activated as a Moosewave runtime automation until rebuilt and tested."
            }
          />
        ) : (
          <ResourceRow
            label={isMailchimp ? "Classic Automations" : "Sequences"}
            n={automations}
            verb={isMailchimp ? "will be imported paused" : "will be created"}
            note={
              unsupportedAutomations.length > 0
                ? `${unsupportedAutomations.length} automation${
                    unsupportedAutomations.length === 1 ? "" : "s"
                  } ${
                    unsupportedAutomations.length === 1 ? "requires" : "require"
                  } manual rebuild or review and will not be activated`
                : undefined
            }
          />
        )}
        <ResourceRow
          label={
            isBeehiiv
              ? "Eligible sent posts"
              : isKlaviyo
                ? "Sent email campaign archive"
                : isCustomerIO
                  ? "Sent email newsletter archive"
                  : "Campaigns"
          }
          n={archive}
          verb="will be archived"
        />
        {isBeehiiv ? (
          <>
            <ResourceRow
              label="Premium memberships (metadata only)"
              n={premiumMembershipMetadata}
              verb="will be preserved on subscribers"
            />
            <Alert variant="warning">
              <AlertTitle>Stripe billing is not part of this import</AlertTitle>
              <AlertDescription>
                No Stripe customers, products, prices, subscriptions, renewals,
                or billing ownership will be created. Complete and verify a
                separate billing handoff before cutover.
              </AlertDescription>
            </Alert>
          </>
        ) : isCustomerIO ? (
          <Alert variant="warning">
            <AlertTitle>Paid billing is not part of this import</AlertTitle>
            <AlertDescription>
              Customer.io billing, commerce, and subscription ownership are not
              imported. Rebuild or retain any applicable system of record before
              cutover.
            </AlertDescription>
          </Alert>
        ) : (
          <ResourceRow
            label="Paid Stripe subscriptions"
            n={paidSubs}
            verb="will be linked"
          />
        )}
        {preservedFields.length > 0 ? (
          <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {preservedFields.length.toLocaleString()} source field
            {preservedFields.length === 1 ? "" : "s"} will be preserved as
            subscriber attributes.
          </p>
        ) : null}
        {mergedContacts > 0 ? (
          <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {mergedContacts.toLocaleString()} overlapping subscriber
            {mergedContacts === 1 ? "" : "s"} will be merged across Mailchimp
            audiences with source IDs and conflicting fields preserved.
          </p>
        ) : null}
        {(preview.sample_subscribers?.length ?? 0) > 0 ? (
          <div
            className="rounded-md border bg-muted/20 px-3 py-2"
            data-testid="sample-subscribers"
          >
            <div className="mb-2 flex items-center justify-between gap-2 text-sm">
              <strong>Sample of how records will land</strong>
              <span className="text-xs text-muted-foreground">
                emails masked · a preview, not the full set
              </span>
            </div>
            <div
              role="region"
              aria-label="Dry-run subscriber preview"
              tabIndex={0}
              className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Email
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Tags
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Mapped fields
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample_subscribers!.map((s, i) => {
                    const fields = Object.entries(s.custom_fields ?? {});
                    return (
                      <tr
                        key={`${s.email}-${i}`}
                        className="border-t border-border/50"
                      >
                        <td className="py-1 pr-3 font-mono">{s.email}</td>
                        <td className="py-1 pr-3">
                          <Badge variant="secondary">{s.status}</Badge>
                        </td>
                        <td className="py-1 pr-3">
                          {(s.tags ?? []).length > 0 ? (
                            <span className="flex flex-wrap gap-1">
                              {(s.tags ?? []).slice(0, 4).map((t) => (
                                <Badge key={t} variant="outline">
                                  {t}
                                </Badge>
                              ))}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-1 text-muted-foreground">
                          {fields.length > 0
                            ? fields
                                .map(
                                  ([k, v]) =>
                                    `${k}: ${boundPreview(prettyJsonValue(v) ?? String(v), 240)}`,
                                )
                                .join(" · ")
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {reviewSurfaceRows.length > 0 ? (
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-2 text-sm">
              <strong>Cutover review surfaces</strong>
              <span className="text-xs text-muted-foreground">
                imported, preserved, or requiring rebuild
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {reviewSurfaceRows.map((row) => (
                <div
                  key={row.resource}
                  className="rounded-md bg-background px-2 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>{row.label}</span>
                    <span className="tabular-nums">
                      {row.imported.toLocaleString()}/
                      {row.source_total.toLocaleString()}
                    </span>
                  </div>
                  {row.notes?.[0] ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.notes[0]}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {unsupported.length > 0 ? (
          <Alert variant="warning">
            <AlertTitle>Won&apos;t migrate as-is</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5 space-y-1">
                {unsupported.map((u) => (
                  <li key={u.id} className="text-sm">
                    <strong>{u.label}</strong>{" "}
                    <span className="text-muted-foreground">— {u.note}</span>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Estimated data-loss vs source:{" "}
          {preview.data_loss_estimate_pct.toFixed(1)}%. The remaining percentage
          is migrated 1:1 or with a documented fallback above.
        </p>
      </CardContent>
      <CardFooter className="justify-between">
        {/* Cancel stays available on a validation block (only in-flight disables it). */}
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={busy || commitDisabled}>
          {busy ? "Starting…" : "Looks good — start the real import"}
        </Button>
      </CardFooter>
    </Card>
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
]);

function cutoverReviewRows(
  report: VerificationReport,
): ResourceCompletenessRow[] {
  return (report.resource_completeness ?? []).filter(
    (row) =>
      row.source_total > 0 &&
      CUTOVER_REVIEW_RESOURCES.has(row.resource) &&
      (row.imported > 0 ||
        row.status === "preserved_for_rebuild" ||
        row.status === "manual_rebuild_required" ||
        row.status === "not_supported"),
  );
}

function ResourceRow({
  label,
  n,
  verb,
  note,
}: {
  label: string;
  n: number;
  verb: string;
  note?: ReactNode;
}) {
  if (n <= 0) return null;
  return (
    <div
      data-testid="resource-card"
      className="rounded-md border bg-muted/20 px-3 py-2"
    >
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <strong>{label}</strong>
        <span className="tabular-nums">
          {n.toLocaleString()} {verb}
        </span>
      </div>
      {note ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}
