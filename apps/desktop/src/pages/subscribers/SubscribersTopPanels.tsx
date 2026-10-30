import type { ReactElement } from "react";

import { EngagementScoreSection } from "../../components/subscribers/EngagementScoreSection";
import { LifecycleDistributionCard } from "../../components/subscribers/LifecycleDistributionCard";
import { PIIFindingsCard } from "../../components/subscribers/PIIFindingsCard";
import { ScoringRulesCard } from "../../components/subscribers/ScoringRulesCard";
import { SubscribersGrowthCard } from "../../components/subscribers/SubscribersGrowthCard";
import { SubscribersStatStrip } from "../../components/subscribers/SubscribersStatStrip";
import { SunsetPoliciesCard } from "../../components/subscribers/SunsetPoliciesCard";
import { PageHeader } from "../../components/PageHeader";
import { PendingSyncStatus } from "../../components/PendingSyncStatus";
import { resolveSubscribersExportSort } from "./subscribers-page-utils";
import type { SubscribersPageController } from "./useSubscribersPageController";

export function SubscribersPageHeader({
  controller,
}: {
  controller: SubscribersPageController;
}): ReactElement {
  const { data, state } = controller;
  return (
    <>
      <PageHeader
        eyebrow="Audience"
        title="Subscribers"
        subtitle={controller.subtitle}
        actions={[
          {
            label: "Import CSV",
            onClick: controller.openImport,
            disabled: !controller.canAdmin,
            title: controller.canAdmin
              ? undefined
              : "Subscriber imports require an admin-scoped session",
          },
          {
            label: controller.exporter.exporting ? "Exporting…" : "Export",
            onClick: () => void controller.exporter.exportVisible(),
            disabled:
              controller.exporter.exporting ||
              data.loading ||
              state.query.trim() !== state.debouncedQuery.trim() ||
              !resolveSubscribersExportSort(state.sortColumn) ||
              !data.rows ||
              data.pageRows.length === 0,
            title:
              state.query.trim() !== state.debouncedQuery.trim() || data.loading
                ? "Wait for the applied subscriber view to finish updating"
                : !resolveSubscribersExportSort(state.sortColumn)
                  ? "Choose a server-backed sort before exporting the complete view"
                  : "Export the complete applied view to CSV; partial files are disclosed and page-only fallback is disabled",
          },
          {
            label: "Dedupe",
            onClick: () => state.setDedupeOpen(true),
            disabled: !controller.canMutate,
            title: controller.canMutate
              ? "Find duplicate subscribers"
              : "Viewer role can't merge",
          },
          {
            label: "Add subscriber",
            onClick: controller.openCreate,
            variant: "primary",
            disabled: !controller.canMutate,
            title: controller.canMutate
              ? undefined
              : "Viewer role can't add subscribers",
          },
        ]}
      />
      <PendingSyncStatus resource="subscribers" />
    </>
  );
}

export function SubscribersInsightsPanels({
  controller,
}: {
  controller: SubscribersPageController;
}): ReactElement {
  const { data, state } = controller;
  return (
    <>
      {data.rows ? (
        <SubscribersStatStrip
          rows={data.rows}
          serverTotal={data.serverTotal}
          matchTotal={data.matchTotal}
          {...(controller.added30d !== undefined
            ? { added30d: controller.added30d }
            : {})}
          {...(controller.unsubbed30d !== undefined
            ? { unsubbed30d: controller.unsubbed30d }
            : {})}
        />
      ) : null}
      <SubscribersGrowthCard />
      <LifecycleDistributionCard />
      <EngagementScoreSection
        onOpenSubscriber={(id, email) => state.setSelected({ id, email })}
      />
    </>
  );
}

export function SubscribersGovernancePanels({
  controller,
}: {
  controller: SubscribersPageController;
}): ReactElement {
  return (
    <>
      <PIIFindingsCard canAdmin={controller.canAdmin} />
      <SunsetPoliciesCard
        canMutate={controller.canMutate}
        canAdmin={controller.canAdmin}
      />
    </>
  );
}

export function SubscribersRulesPanels({
  controller,
}: {
  controller: SubscribersPageController;
}): ReactElement {
  return (
    <>
      <section
        className="subscribers-surface subscribers-schema-surface"
        aria-labelledby="subscriber-schema-heading"
      >
        <div>
          <h3 id="subscriber-schema-heading">Audience field schema</h3>
          <p>
            Review the merge fields available to imports, personalization, and
            downstream subscriber workflows before changing their contract.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (controller.canMutate) controller.state.setMergeFieldsOpen(true);
          }}
          aria-disabled={!controller.canMutate || undefined}
          aria-describedby="subscriber-schema-action-description"
        >
          Edit field schema…
        </button>
        <span
          id="subscriber-schema-action-description"
          className={controller.canMutate ? "visually-hidden" : "muted"}
        >
          {controller.canMutate
            ? "Edit the audience field schema and Mailchimp-compatible merge tags."
            : "Viewer access is read-only; an editor or admin can edit the schema."}
        </span>
      </section>
      <ScoringRulesCard
        canMutate={controller.canMutate}
        canAdmin={controller.canAdmin}
      />
    </>
  );
}
