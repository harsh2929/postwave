import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import {
  type MigrationJob,
  type MigrationSourceCapability,
  api,
  cancelMigration,
} from "../../lib/api-client";
import { parseMigrationSourceCapabilities } from "../../lib/api/migrations";
import type { RemoteApiError } from "../../lib/remote-resource";
import { toast } from "../Toast";
import { preflightMigrationResume } from "./migration-source-session";
import {
  countMigrations,
  filterMigrations,
  isMigrationInFlight,
  migrationStatusLabel,
  normalizeMigrationRollbackCandidate,
  parseMigrationJobsPayload,
  safeMigrationFailure,
  type MigrationStatusFilter,
} from "./migrations-surface-helpers";

type MigrationMutation = "cancel" | "resume" | "rollback";

interface MutationResult {
  ok: boolean;
  acknowledgedStatus?: string;
}

export function useMigrationsPageController(): {
  jobs: ReturnType<typeof useRemoteResource<MigrationJob[]>>;
  sources: ReturnType<typeof useRemoteResource<MigrationSourceCapability[]>>;
  filteredJobs: MigrationJob[];
  counts: ReturnType<typeof countMigrations>;
  filter: MigrationStatusFilter;
  setFilter: (value: MigrationStatusFilter) => void;
  refreshing: boolean;
  refreshAll: () => Promise<void>;
  refreshAfterMutation: () => Promise<void>;
} {
  const jobs = useRemoteResource<MigrationJob[]>(
    async () => {
      const result = await api.listMigrations();
      if (result.error) return { error: result.error };
      const parsed = parseMigrationJobsPayload(result.data);
      return parsed.ok ? { data: parsed.jobs } : { error: parsed.error };
    },
    { identity: "migration-jobs", auto: false },
  );
  const sources = useRemoteResource<MigrationSourceCapability[]>(
    async () => {
      const result = await api.listMigrationSources();
      if (result.error) return { error: result.error };
      const parsed = parseMigrationSourceCapabilities(result.data);
      return parsed.error ? { error: parsed.error } : { data: parsed.data };
    },
    { identity: "migration-source-capabilities", auto: false },
  );
  const jobsFlight = useSingleFlightOperation();
  const sourcesFlight = useSingleFlightOperation();
  const [filter, setFilter] = useState<MigrationStatusFilter>("all");

  const reloadJobs = useCallback(
    async (afterCurrent = false): Promise<void> => {
      const current = jobsFlight.promiseRef.current;
      if (current) {
        await current.catch(() => undefined);
        if (!afterCurrent) return;
      }
      const next = jobsFlight.run(jobs.reload);
      if (next) await next.catch(() => undefined);
    },
    [jobs.reload, jobsFlight.promiseRef, jobsFlight.run],
  );

  const reloadSources = useCallback(
    async (afterCurrent = false): Promise<void> => {
      const current = sourcesFlight.promiseRef.current;
      if (current) {
        await current.catch(() => undefined);
        if (!afterCurrent) return;
      }
      const next = sourcesFlight.run(sources.reload);
      if (next) await next.catch(() => undefined);
    },
    [sources.reload, sourcesFlight.promiseRef, sourcesFlight.run],
  );

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([reloadJobs(), reloadSources()]);
  }, [reloadJobs, reloadSources]);

  const refreshAfterMutation = useCallback(
    async (): Promise<void> => reloadJobs(true),
    [reloadJobs],
  );

  useEffect(() => {
    // Deferring one task makes the StrictMode setup/cleanup probe cancel its
    // first owner before any request starts, while production still begins on
    // the next event-loop turn. The second setup owns the exact initial flight.
    const timer = window.setTimeout(() => void refreshAll(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshAll]);

  const hasInFlight = (jobs.data ?? []).some((job) =>
    isMigrationInFlight(job.status),
  );
  useEffect(() => {
    if (!hasInFlight) return;
    let disposed = false;
    let timer: number | null = null;
    const baseDelay = jobs.failure ? 30_000 : 10_000;
    const schedule = (): void => {
      if (disposed) return;
      const jitter = 0.85 + Math.random() * 0.3;
      timer = window.setTimeout(
        () => void tick(),
        Math.round(baseDelay * jitter),
      );
    };
    const tick = async (): Promise<void> => {
      if (disposed) return;
      if (
        document.visibilityState !== "visible" ||
        navigator.onLine === false
      ) {
        schedule();
        return;
      }
      await reloadJobs();
      schedule();
    };
    const resume = (): void => {
      if (
        disposed ||
        document.visibilityState !== "visible" ||
        navigator.onLine === false
      ) {
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void tick();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    schedule();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [hasInFlight, jobs.failure, reloadJobs]);

  const verifiedJobs = jobs.data ?? [];
  const counts = useMemo(() => countMigrations(verifiedJobs), [verifiedJobs]);
  const filteredJobs = useMemo(
    () => filterMigrations(verifiedJobs, filter),
    [filter, verifiedJobs],
  );

  return {
    jobs,
    sources,
    filteredJobs,
    counts,
    filter,
    setFilter,
    refreshing: jobsFlight.active || sourcesFlight.active,
    refreshAll,
    refreshAfterMutation,
  };
}

export function useMigrationMutationController(
  refreshAfterMutation: () => Promise<void>,
): {
  active: boolean;
  activeJobId: string | null;
  activeKind: MigrationMutation | null;
  run: (kind: MigrationMutation, job: MigrationJob) => Promise<boolean>;
} {
  const mountedRef = useRef(true);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<MigrationMutation | null>(null);
  const operationOptions = useMemo(
    () => ({
      ownerId: "migration-tenant-operation",
      label: "Migration tenant operation",
      detail:
        "Wait for the migration cancellation, resumption, or rollback acknowledgement before leaving Moosewave.",
    }),
    [],
  );
  const operation = useSingleFlightOperation(operationOptions);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (kind: MigrationMutation, job: MigrationJob): Promise<boolean> => {
      const flight = operation.run(async (): Promise<MutationResult> => {
        try {
          if (kind === "rollback") {
            const snapshot = await Promise.resolve().then(() =>
              api.getMigration(job.id),
            );
            if (snapshot.error) throw snapshot.error;
            if (!normalizeMigrationRollbackCandidate(snapshot.data, job)) {
              throw {
                kind: "parse",
                code: "migration_rollback_preflight_unavailable",
              } satisfies RemoteApiError;
            }
            const result = await api.rollbackMigration(job.id);
            if (result.error) throw result.error;
            const acknowledgement = result.data as unknown;
            if (
              !acknowledgement ||
              typeof acknowledgement !== "object" ||
              (acknowledgement as { job_id?: unknown }).job_id !== job.id ||
              (acknowledgement as { state?: unknown }).state !== "running"
            ) {
              throw {
                kind: "parse",
                code: "migration_rollback_invalid_ack",
              } satisfies RemoteApiError;
            }
            return { ok: true };
          }
          if (kind === "resume") {
            const snapshot = await Promise.resolve().then(() =>
              api.getMigration(job.id),
            );
            if (snapshot.error) throw snapshot.error;
            const preflight = preflightMigrationResume(snapshot.data, job);
            if (!preflight.ok) {
              throw {
                kind: "parse",
                code: preflight.code,
              } satisfies RemoteApiError;
            }
            const result = await api.resumeMigration(job.id);
            if (result.error) throw result.error;
            if (
              result.data.job_id !== job.id ||
              !isKnownMigrationAcknowledgementStatus(result.data.status)
            ) {
              throw {
                kind: "parse",
                code: "migration_resume_invalid_ack",
              } satisfies RemoteApiError;
            }
            return { ok: true, acknowledgedStatus: result.data.status };
          }
          const result = await cancelMigration(job.id);
          if (result.error) throw result.error;
          if (
            result.data.job_id !== job.id ||
            typeof result.data.cancelled !== "boolean" ||
            !isKnownMigrationAcknowledgementStatus(result.data.status)
          ) {
            throw {
              kind: "parse",
              code: "migration_cancel_invalid_ack",
            } satisfies RemoteApiError;
          }
          return {
            ok: true,
            acknowledgedStatus: result.data.cancelled
              ? "cancel_requested"
              : result.data.status,
          };
        } catch (caught) {
          const error =
            caught && typeof caught === "object"
              ? (caught as RemoteApiError)
              : ({ kind: "network" } satisfies RemoteApiError);
          const safe = safeMigrationFailure(
            error,
            kind === "rollback"
              ? "Rollback"
              : kind === "resume"
                ? "Resume"
                : "Cancellation",
          );
          toast.error({ message: safe.message, detail: safe.detail });
          return { ok: false };
        }
      });
      if (!flight) return false;
      if (mountedRef.current) {
        setActiveJobId(job.id);
        setActiveKind(kind);
      }
      try {
        const result = await flight;
        if (!result.ok) return false;
        if (!mountedRef.current) return true;
        if (kind === "rollback") {
          toast.success({
            message: "Rollback accepted",
            detail:
              "The job is moving through server checkpoints. Keep the detail view open or refresh history for verified status.",
          });
        } else if (kind === "resume") {
          toast.success({
            message: "Resume accepted",
            detail:
              "The server will continue from its recorded checkpoint; imported records are not re-imported.",
          });
        } else if (result.acknowledgedStatus === "cancel_requested") {
          toast.success({
            message: "Cancellation requested",
            detail:
              "The runner will stop at the next safe checkpoint. Existing imported records remain in Moosewave.",
          });
        } else {
          toast.info({
            message: "Job was already terminal",
            detail: `The server reports ${migrationStatusLabel(result.acknowledgedStatus).toLowerCase()}. No new cancellation was sent.`,
          });
        }
        if (mountedRef.current) void refreshAfterMutation();
        return true;
      } finally {
        if (mountedRef.current) {
          setActiveJobId(null);
          setActiveKind(null);
        }
      }
    },
    [operation, refreshAfterMutation],
  );

  return {
    active: operation.active,
    activeJobId,
    activeKind,
    run,
  };
}

function isKnownMigrationAcknowledgementStatus(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    [
      "pending",
      "authenticating",
      "discovering",
      "dry_run",
      "awaiting_confirmation",
      "importing",
      "rolling_back",
      "completed",
      "failed",
      "rolled_back",
    ].includes(value)
  );
}
