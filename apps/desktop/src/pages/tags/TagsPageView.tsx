import type { ReactElement } from "react";

import { PageHeader } from "../../components/PageHeader";
import { PendingSyncStatus } from "../../components/PendingSyncStatus";
import { TagGroupSidebar } from "../../components/tags/TagGroupSidebar";
import { ValuePropCard } from "../../components/ValuePropCard";
import { TagCatalog } from "./TagCatalog";
import { TagOverlays } from "./TagOverlays";
import {
  TagAvailabilityNotices,
  TagCatalogControls,
  TagRemoteNotices,
} from "./TagPageChrome";
import type { TagsPageController } from "./useTagsPageController";

export function TagsPageView({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Audience"
        title="Tags"
        subtitle={controller.totalLabel}
        actions={[
          {
            label: controller.catalog.loading ? "Refreshing…" : "Refresh",
            onClick: () => void controller.catalog.refresh(),
            disabled: controller.catalog.loading,
          },
          {
            label: "Merge…",
            onClick: () => controller.openMerge([]),
            disabled: true,
            title: controller.mergeUnavailableReason,
          },
          {
            label: "New tag",
            onClick: controller.create.openCreate,
            variant: "primary",
            disabled: !controller.canMutate,
            title: controller.writeUnavailableReason ?? undefined,
          },
        ]}
      />

      <TagAvailabilityNotices
        writeReason={controller.writeUnavailableReason}
        mergeReason={controller.mergeUnavailableReason}
        deleteReason={controller.deleteUnavailableReason}
        hasOrphans={controller.orphanCount > 0}
      />
      <PendingSyncStatus resource="tags" />

      {controller.catalog.rows && controller.catalog.rows.length > 0 ? (
        <ValuePropCard
          title="Tags drive segments and sequence triggers."
          body="Label a subscriber as 'vip' here, and every campaign, automation, and personalization rule that targets 'vip' picks them up — no SQL required."
        />
      ) : null}

      <div className="tags-workspace-layout">
        <TagGroupSidebar
          groups={controller.catalog.groups}
          tags={controller.catalog.rows ?? []}
          selected={controller.groupFilter}
          onSelect={controller.changeGroupFilter}
          onManage={() => controller.setGroupManageOpen(true)}
          canManage={
            controller.canAdmin &&
            controller.groupFeatureAvailable &&
            !controller.catalog.groupStatus.error
          }
          unavailableReason={controller.groupUnavailableReason}
          remoteError={controller.catalog.groupStatus.error}
          remoteLoading={controller.catalog.groupStatus.loading}
          onRetry={() => void controller.catalog.loadGroups()}
        />
        <div className="tags-catalog-pane">
          <TagCatalogControls
            query={controller.query}
            color={controller.colorFilter}
            onQueryChange={controller.changeQuery}
            onColorChange={controller.changeColorFilter}
            resultCount={controller.resultCount}
            hasActiveView={
              Boolean(controller.query) ||
              controller.colorFilter !== "all" ||
              Boolean(controller.groupFilter)
            }
            hiddenOrphans={
              controller.orphanCount - controller.visibleOrphanCount
            }
            onReset={controller.resetView}
          />
          <TagRemoteNotices
            catalog={controller.catalog.catalogStatus}
            taxonomy={controller.catalog.taxonomyStatus}
            onRetryCatalog={() => void controller.catalog.load()}
            onRetryTaxonomy={() => void controller.catalog.reloadTaxonomy()}
          />
          <TagCatalog controller={controller} />
        </div>
      </div>

      <TagOverlays controller={controller} />
    </>
  );
}
