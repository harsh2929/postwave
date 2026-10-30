/**
 * Production migration operations surface.
 *
 * Remote list and capability reads retain only verified snapshots; refreshes,
 * polls, and tenant mutations are race-safe single flights. Presentation lives
 * in migration-local owners so history, stream, evidence, and destructive
 * confirmation behavior can be tested independently.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  MigrationActionDialog,
  type MigrationActionKind,
} from "../components/migration/MigrationActionDialog";
import { MigrationDetailSurface } from "../components/migration/MigrationDetailSurface";
import { MigrationHistorySurface } from "../components/migration/MigrationHistorySurface";
import { decodeExactMigrationJob } from "../components/migration/migration-source-session";
import {
  mergeMigrationJob,
  migrationRollbackEligibility,
  safeMigrationFailure,
  safeMigrationOperationFailure,
} from "../components/migration/migrations-surface-helpers";
import {
  useMigrationMutationController,
  useMigrationsPageController,
} from "../components/migration/useMigrationsPageController";
import { MigrationWizard } from "../components/MigrationWizard";
import { toast } from "../components/Toast";
import { api, type MigrationJob } from "../lib/api-client";
import type { PendingMigrationApiKeyReturn } from "../lib/migration-deep-link";
import { consumePendingMigrationApiKeyReturn } from "../lib/migration-deep-link";
import {
  applyRuntimeMigrationCapability,
  findSource,
  type MigrationSourceId,
} from "../lib/migration-sources";
import { useCanAdmin, useRoleStatus } from "../lib/store";
import "../styles-migrations.css";
import "../styles-migrations-maturity.css";

interface PendingAction {
  kind: MigrationActionKind;
  job: MigrationJob;
}

export function Migrations(): ReactElement {
  const canAdmin = useCanAdmin();
  const roleStatus = useRoleStatus();
  const controller = useMigrationsPageController();
  const mutation = useMigrationMutationController(
    controller.refreshAfterMutation,
  );
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSource, setWizardSource] = useState<
    MigrationSourceId | undefined
  >();
  const [wizardAuthState, setWizardAuthState] = useState<string | undefined>();
  const [detail, setDetail] = useState<MigrationJob | null>(null);
  const [detailRefreshing, setDetailRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );

  const detailId = detail?.id ?? null;
  useEffect(() => {
    if (!detailId || controller.jobs.data === null) return;
    const verified = controller.jobs.data.find((job) => job.id === detailId);
    if (verified) {
      setDetail((current) =>
        current?.id === verified.id
          ? mergeMigrationJob(current, verified)
          : current,
      );
    }
  }, [controller.jobs.data, detailId]);

  useEffect(() => {
    if (controller.jobs.access !== "denied") return;
    setDetail(null);
    setPendingAction(null);
  }, [controller.jobs.access]);

  useEffect(() => {
    if (canAdmin) return;
    setPendingAction(null);
    if (wizardOpen) {
      setWizardOpen(false);
      setWizardSource(undefined);
      setWizardAuthState(undefined);
    }
  }, [canAdmin, wizardOpen]);

  useEffect(() => {
    if (
      roleStatus === "loading" ||
      controller.sources.data === null ||
      controller.sources.stale
    ) {
      return;
    }
    const pending = consumePendingMigrationApiKeyReturn();
    if (!pending) return;
    openReturnedCredential(
      pending,
      canAdmin,
      controller.sources.data,
      (source, state) => {
        setWizardSource(source);
        setWizardAuthState(state);
        setWizardOpen(true);
      },
    );
  }, [canAdmin, controller.sources.data, controller.sources.stale, roleStatus]);

  const openWizard = (source?: MigrationSourceId): void => {
    if (
      !canAdmin ||
      controller.sources.data === null ||
      controller.sources.stale ||
      controller.sources.transport !== "ready"
    ) {
      return;
    }
    setWizardSource(source);
    setWizardAuthState(undefined);
    setWizardOpen(true);
  };

  const openAction = (kind: MigrationActionKind, job: MigrationJob): void => {
    if (!canAdmin || mutation.active) return;
    setPendingAction({ kind, job });
  };

  const confirmAction = async (): Promise<void> => {
    if (!pendingAction || mutation.active) return;
    if (!canAdmin) {
      setPendingAction(null);
      return;
    }
    if (
      pendingAction.kind === "rollback" &&
      !migrationRollbackEligibility(pendingAction.job, canAdmin).allowed
    ) {
      setPendingAction(null);
      toast.info({
        message: "Rollback is no longer available",
        detail:
          "The locally verified deadline or job state no longer permits rollback. Refresh migration history for the server-authoritative state.",
      });
      return;
    }
    const acknowledged = await mutation.run(
      pendingAction.kind,
      pendingAction.job,
    );
    if (!acknowledged) return;
    setPendingAction(null);
  };

  const applySnapshot = (snapshot: MigrationJob): void => {
    setDetail((current) =>
      current?.id === snapshot.id
        ? mergeMigrationJob(current, snapshot)
        : current,
    );
  };

  const refreshDetail = async (): Promise<void> => {
    if (!detail || detailRefreshing) return;
    const requestedJobId = detail.id;
    setDetailRefreshing(true);
    try {
      const result = await api.getMigration(requestedJobId);
      if (result.error) {
        const safe = safeMigrationFailure(
          result.error,
          "Migration snapshot refresh",
        );
        toast.error({ message: safe.message, detail: safe.detail });
        return;
      }
      const snapshot = decodeExactMigrationJob(result.data, detail);
      if (!snapshot) {
        const safe = safeMigrationFailure(
          {
            kind: "parse",
            code: "migration_detail_invalid_snapshot",
          },
          "Migration snapshot refresh",
        );
        toast.error({ message: safe.message, detail: safe.detail });
        return;
      }
      setDetail((current) =>
        current?.id === requestedJobId
          ? mergeMigrationJob(current, snapshot)
          : current,
      );
    } catch (caught) {
      const safe = safeMigrationOperationFailure(
        caught,
        "Migration snapshot refresh",
      );
      toast.error({ message: safe.message, detail: safe.detail });
    } finally {
      setDetailRefreshing(false);
    }
  };

  return (
    <>
      <MigrationHistorySurface
        jobs={controller.jobs}
        sources={controller.sources}
        filteredJobs={controller.filteredJobs}
        counts={controller.counts}
        filter={controller.filter}
        canAdmin={canAdmin}
        refreshing={controller.refreshing}
        onFilter={controller.setFilter}
        onRefresh={() => void controller.refreshAll()}
        onStart={openWizard}
        onView={setDetail}
        onRollback={(job) => openAction("rollback", job)}
        onCancel={(job) => openAction("cancel", job)}
      />

      {wizardOpen ? (
        <MigrationWizard
          initialSourceId={wizardSource}
          initialAuthState={wizardAuthState}
          initialCapabilities={controller.sources.data ?? undefined}
          onClose={(didCreate) => {
            setWizardOpen(false);
            setWizardSource(undefined);
            setWizardAuthState(undefined);
            if (didCreate) void controller.refreshAfterMutation();
          }}
        />
      ) : null}

      {detail ? (
        <MigrationDetailSurface
          job={detail}
          canAdmin={canAdmin}
          listVerifiedAt={controller.jobs.lastVerifiedAt}
          listStale={controller.jobs.stale}
          refreshing={detailRefreshing}
          onClose={() => setDetail(null)}
          onRefresh={() => void refreshDetail()}
          onRollback={() => openAction("rollback", detail)}
          onCancel={() => openAction("cancel", detail)}
          onResume={() => openAction("resume", detail)}
          onSnapshot={applySnapshot}
        />
      ) : null}

      {pendingAction ? (
        <MigrationActionDialog
          kind={pendingAction.kind}
          job={pendingAction.job}
          busy={mutation.active}
          onClose={() => {
            if (!mutation.active) setPendingAction(null);
          }}
          onConfirm={() => void confirmAction()}
        />
      ) : null}
    </>
  );
}

function openReturnedCredential(
  pending: PendingMigrationApiKeyReturn,
  canAdmin: boolean,
  capabilities: Array<{ source: string; auth_method: string }>,
  open: (source: MigrationSourceId, state: string | undefined) => void,
): void {
  if (!canAdmin) {
    toast.info({
      message: "Admin role required to finish this migration",
      detail:
        "The returned credential was not opened. Switch to an admin session and restart the provider handoff.",
    });
    return;
  }
  const definition = findSource(pending.source);
  const capability = capabilities.find(
    (candidate) => candidate.source === pending.source,
  );
  if (!definition || !capability) {
    toast.error({
      message: "Migration source is not available in this deployment.",
      detail:
        "The returned credential was not opened because the current server capability catalog does not advertise that source.",
    });
    return;
  }
  const runtime = applyRuntimeMigrationCapability(definition, capability);
  if (!runtime.serverSupport || runtime.authFlow !== "api_key") {
    toast.error({
      message: "Credential handoff does not match this source.",
      detail:
        "The returned value was not opened. Restart the migration using the authorization method shown in the verified source catalog.",
    });
    return;
  }
  open(runtime.id, pending.state);
}
