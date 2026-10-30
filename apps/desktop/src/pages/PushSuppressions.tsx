import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { PushSuppressionRow } from "../lib/api/push-suppressions";
import { onContextEpochObserved, readContextEpoch } from "../lib/context-epoch";
import { desktopRouteIdentityScope } from "../lib/desktop-router";
import { useCanAdmin, useMe } from "../lib/store";
import {
  PushSuppressionAddDialog,
  PushSuppressionDetail,
  PushSuppressionRemoveDialog,
} from "./PushSuppressionDialogs";
import { PushSuppressionBulkRemoveDialog } from "./PushSuppressionBulkRemoveDialog";
import { PushSuppressionFilters } from "./PushSuppressionFilters";
import { PushSuppressionImportDialog } from "./PushSuppressionImportDialog";
import {
  PushRegistrySurface,
  PushRuntimeDisclosure,
  PushSuppressionsHeader,
} from "./PushSuppressionsSurface";
import { usePushSuppressionExport } from "./usePushSuppressionExport";
import { usePushSuppressionBulkRemove } from "./usePushSuppressionBulkRemove";
import { usePushSuppressionImport } from "./usePushSuppressionImport";
import { usePushSuppressionsController } from "./usePushSuppressionsController";

import "../styles-push-suppressions.css";

export function PushSuppressions(): ReactElement {
  const canAdmin = useCanAdmin();
  return canAdmin ? (
    <PushSuppressionsAdminRoute />
  ) : (
    <PushSuppressionsAccessBoundary />
  );
}

function PushSuppressionsAdminRoute(): ReactElement {
  const me = useMe();
  const contextEpoch = useSyncExternalStore(
    onContextEpochObserved,
    readContextEpoch,
    readContextEpoch,
  );
  const durableScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const identityScope = `${durableScope ?? "unresolved"}:${
    me?.effectiveRole ?? "unknown"
  }:${contextEpoch ?? "unobserved"}`;
  return <PushSuppressionsAdmin key={identityScope} />;
}

function PushSuppressionsAccessBoundary(): ReactElement {
  return (
    <section
      className="page push-suppressions-route push-access-boundary"
      aria-labelledby="push-suppressions-access-title"
    >
      <div className="page-header-v2">
        <div>
          <div className="page-header-v2-eyebrow">Audience protection</div>
          <h1 id="push-suppressions-access-title" className="page-header-v2-title">
            Push suppressions
          </h1>
          <p className="page-header-v2-subtitle">
            Exact-admin token authority registry
          </p>
        </div>
      </div>
      <div className="notice" role="note">
        Push suppression records contain customer-device identifiers and consent
        or provider authority. Your current role cannot read or change this
        registry; no protected push-suppression request was started.
      </div>
    </section>
  );
}

function routeMutationReady({
  authorityCurrent,
  exporting,
  pickingImport,
  importing,
  adding,
  removing,
  bulkRemoving,
}: {
  authorityCurrent: boolean;
  exporting: boolean;
  pickingImport: boolean;
  importing: boolean;
  adding: boolean;
  removing: boolean;
  bulkRemoving: boolean;
}): boolean {
  return (
    authorityCurrent &&
    !exporting &&
    !pickingImport &&
    !importing &&
    !adding &&
    !removing &&
    !bulkRemoving
  );
}

function PushSuppressionsAdmin(): ReactElement {
  const canAdmin = useCanAdmin();
  const controller = usePushSuppressionsController({ canAdmin });
  const { directory } = controller;
  const exporter = usePushSuppressionExport({
    authorityCurrent: directory.authorityCurrent,
    rows: directory.visibleRows,
    pageIndex: directory.pageIndex,
  });
  const importer = usePushSuppressionImport({
    canAdmin,
    authorityCurrent: directory.authorityCurrent,
    refresh: controller.refresh,
  });
  const bulkRemove = usePushSuppressionBulkRemove({
    canAdmin,
    authorityCurrent: directory.authorityCurrent,
    rows: directory.visibleRows,
    refresh: controller.refresh,
  });
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailRow = useMemo(
    () => directory.rows?.find((row) => row.id === detailId) ?? null,
    [detailId, directory.rows],
  );

  useEffect(() => {
    if (detailId && directory.rows && !detailRow) setDetailId(null);
  }, [detailId, detailRow, directory.rows]);

  const mutationReady = routeMutationReady({
    authorityCurrent: directory.authorityCurrent,
    exporting: exporter.busy,
    pickingImport: importer.state.picking,
    importing: importer.state.busy,
    adding: controller.add.busy,
    removing: controller.remove.busy,
    bulkRemoving: bulkRemove.state.busy,
  });
  const routeBusy =
    directory.loading ||
    exporter.busy ||
    importer.state.picking ||
    importer.state.busy ||
    controller.add.busy ||
    controller.remove.busy ||
    bulkRemove.state.busy;

  const openDetail = (
    row: PushSuppressionRow,
    trigger: HTMLButtonElement,
  ): void => {
    detailReturnFocusRef.current = trigger;
    setDetailId(row.id);
  };

  return (
    <section
      className="page push-suppressions-route"
      aria-labelledby="push-suppressions-title"
      aria-busy={routeBusy ? "true" : undefined}
    >
      <PushSuppressionsHeader
        directory={directory}
        exporting={exporter.busy}
        pickingImport={importer.state.picking}
        mutationReady={mutationReady}
        addButtonRef={addButtonRef}
        onRefresh={controller.refresh}
        onExport={exporter.saveCurrentPage}
        onImport={importer.chooseFile}
        onAdd={controller.openAdd}
      />

      <PushRuntimeDisclosure />

      <PushSuppressionFilters
        platform={directory.platform}
        reason={directory.reason}
        source={directory.source}
        sourceChoices={directory.sourceChoices}
        queryInput={directory.queryInput}
        queryError={directory.queryError}
        loading={directory.loading}
        onPlatformChange={controller.setPlatform}
        onReasonChange={controller.setReason}
        onSourceChange={controller.setSource}
        onQueryChange={controller.setQueryInput}
      />

      <PushRegistrySurface
        directory={directory}
        mutationReady={mutationReady}
        bulkRemove={bulkRemove}
        addButtonRef={addButtonRef}
        onRetry={controller.retry}
        onClearFilters={controller.clearFilters}
        onAdd={controller.openAdd}
        onDetail={openDetail}
        onRemove={controller.requestRemove}
        onPrevious={controller.previousPage}
        onNext={controller.nextPage}
      />

      <PushSuppressionAddDialog
        open={controller.add.open}
        platform={controller.add.platform}
        token={controller.add.token}
        tokenError={controller.add.tokenError}
        requestError={controller.add.requestError}
        busy={controller.add.busy}
        returnFocusRef={controller.add.returnFocusRef}
        onPlatformChange={controller.setAddPlatform}
        onTokenChange={controller.setAddToken}
        onClose={controller.closeAdd}
        onSubmit={controller.submitAdd}
      />
      <PushSuppressionImportDialog
        state={importer.state}
        authorityCurrent={directory.authorityCurrent}
        onClose={importer.close}
        onSubmit={importer.submit}
      />
      <PushSuppressionBulkRemoveDialog
        state={bulkRemove.state}
        authorityCurrent={directory.authorityCurrent}
        onClose={bulkRemove.close}
        onConfirm={bulkRemove.confirm}
      />
      <PushSuppressionDetail
        row={detailRow}
        returnFocusRef={detailReturnFocusRef}
        onClose={() => setDetailId(null)}
      />
      <PushSuppressionRemoveDialog
        target={controller.remove.target}
        error={controller.remove.error}
        busy={controller.remove.busy}
        authorityCurrent={directory.authorityCurrent}
        returnFocusRef={controller.remove.returnFocusRef}
        onClose={controller.closeRemove}
        onConfirm={controller.confirmRemove}
      />
    </section>
  );
}
