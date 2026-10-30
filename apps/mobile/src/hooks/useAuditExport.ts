/**
 * hooks/useAuditExport.ts — the audit log's async export jobs.
 *
 * Wire contract (apps/api/internal/server/audit_operations.go:96-99, all behind
 * RequireScope(audit:read) — the same gate the list itself uses, so a user who
 * can read the log can export it):
 *
 *   POST /api/v1/audit/export-async   → AuditExportJob      body: { actorType?, since?, … }
 *   GET  /api/v1/audit/export-jobs    → { jobs: [...] }     ?limit=
 *
 * Every decision about what those jobs MEAN — queued vs stalled, percent
 * complete, whether a second export is worth starting, how often to poll —
 * lives in lib/auditExport, which imports nothing runtime-bound and is asserted
 * in the node test environment. This file is only the transport.
 */
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createAuditExportSchedule,
  deleteAuditExportSchedule,
  fetchAuditExportSchedules,
} from "@/api/auditExportSchedules";
import { getClient } from "@/api/client";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  AUDIT_EXPORT_HISTORY_LIMIT,
  auditExportPollMs,
  auditExportScope,
  normalizeAuditExportJobs,
  type AuditExportJob,
  type AuditExportScope,
  type AuditExportScopeInput,
} from "@/lib/auditExport";
import type {
  AuditExportSchedule,
  ExportScheduleBody,
} from "@/lib/auditExportSchedules";

/**
 * useAuditExportJobs — the export history, polled ONLY while something is
 * actually in flight.
 *
 * `refetchInterval` takes the callback form so the decision is re-made after
 * every response: the moment the last active job completes the poll stops
 * dead, instead of a screen left open burning a request every five seconds for
 * the rest of the session.
 */
export function useAuditExportJobs(enabled = true) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-export-jobs", gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<AuditExportJob[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        `/api/v1/audit/export-jobs?limit=${AUDIT_EXPORT_HISTORY_LIMIT}`,
      );
      return normalizeAuditExportJobs(res);
    },
    refetchInterval: (query) =>
      auditExportPollMs(query.state.data as AuditExportJob[] | undefined),
    refetchIntervalInBackground: false,
  });
}

/**
 * useStartAuditExport — enqueue a job from the filters the screen is showing.
 *
 * The response row is pushed into the history cache immediately rather than
 * only invalidating: the user just tapped Export and must see their job appear,
 * and an invalidate-only path shows an unchanged list until the refetch lands.
 * The invalidate still runs, so the optimistic row is replaced by the server's
 * within one round trip.
 *
 * ONLINE-ONLY, like the two schedule writes below: networkMode "always" (the
 * useInboundEndpointAdmin pattern). The client's default would PAUSE a write
 * started with no signal: "Starting…" spins with no toast, and on reconnect
 * the job is enqueued for an operator who may have given up on it. `canStart`
 * is auth state, not reachability, so that tap is on offer. "always" fails it
 * at once into the controller's error toast instead.
 */
export function useStartAuditExport() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (body: Record<string, string>): Promise<AuditExportJob> => {
      const { client } = getClient();
      const res = await client.request<AuditExportJob>(
        "POST",
        "/api/v1/audit/export-async",
        { body },
      );
      return res;
    },
    networkMode: "always",
    onSuccess: (job) => {
      if (job && typeof job.id === "string") {
        queryClient.setQueryData<AuditExportJob[]>(
          ["audit-export-jobs", gate.tenantId],
          (current) => [job, ...(current ?? [])],
        );
      }
      void queryClient.invalidateQueries({
        queryKey: ["audit-export-jobs", gate.tenantId],
      });
    },
  });
}

const SCHEDULES_KEY = "audit-export-schedules";

/**
 * The recurring evidence-pack schedules, fetched only while the export sheet
 * is open — the same open-gating as the job history and for the same reason.
 */
export function useAuditExportSchedules(enabled = true) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [SCHEDULES_KEY, gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: (): Promise<AuditExportSchedule[]> => fetchAuditExportSchedules(),
  });
}

export function useCreateExportSchedule() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, ExportScheduleBody>({
    mutationFn: (body) => createAuditExportSchedule(body),
    // A replayed create starts mailing evidence packs nobody confirmed.
    networkMode: "always",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [SCHEDULES_KEY, gate.tenantId] });
    },
  });
}

export function useDeleteExportSchedule() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => deleteAuditExportSchedule(id),
    // A replayed delete stops a schedule after the operator moved on.
    networkMode: "always",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [SCHEDULES_KEY, gate.tenantId] });
    },
  });
}

export interface AuditExportSchedulesController {
  rows: AuditExportSchedule[] | undefined;
  loading: boolean;
  failed: boolean;
  /** Admin + online — POST/DELETE sit behind the admin floor (manifest). */
  canManage: boolean;
  creating: boolean;
  create: (body: ExportScheduleBody) => Promise<boolean>;
  removing: boolean;
  remove: (schedule: AuditExportSchedule) => Promise<boolean>;
}

export interface AuditExportController {
  scope: AuditExportScope;
  jobs: AuditExportJob[] | undefined;
  loading: boolean;
  /** isPending + isPaused: the history's first fetch is waiting on a connection. */
  isPending: boolean;
  isPaused: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
  canStart: boolean;
  starting: boolean;
  start: () => void;
  schedules: AuditExportSchedulesController;
}

/**
 * useAuditExportController — everything the export sheet needs, assembled once.
 *
 * The screen previously carried the scope memo, the history query, the mutation
 * and the toast branches inline, which is four concerns of a feature the log
 * screen merely HOSTS. Collecting them here keeps the route file about the
 * log, and means the whole export affordance can be read (or removed) in two
 * files instead of five.
 *
 * `open` gates the history query: polling for export jobs on every visit to the
 * audit log — for a sheet the user has not opened — would be pure waste.
 */
export function useAuditExportController(
  open: boolean,
  input: AuditExportScopeInput,
  options: { isAdmin?: boolean } = {},
): AuditExportController {
  const { toast } = useToast();
  const gate = useOnlineQueryGate();
  const {
    actorType,
    since,
    windowDescription,
    query: searchQuery,
    destructiveOnly,
    securityOnly,
    action,
    resourceType,
    resourceId,
    actorLabel,
  } = input;
  const scope = useMemo(
    () =>
      auditExportScope({
        ...(actorType ? { actorType } : {}),
        ...(since ? { since } : {}),
        windowDescription,
        ...(searchQuery ? { query: searchQuery } : {}),
        ...(destructiveOnly ? { destructiveOnly } : {}),
        // The Security lens is client-side narrowing the file will NOT have;
        // it rides along so the sheet can disclose exactly that.
        ...(securityOnly ? { securityOnly } : {}),
        // The advanced facets are server facets of the export job itself.
        ...(action ? { action } : {}),
        ...(resourceType ? { resourceType } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(actorLabel ? { actorLabel } : {}),
      }),
    [
      action,
      actorLabel,
      actorType,
      destructiveOnly,
      resourceId,
      resourceType,
      searchQuery,
      securityOnly,
      since,
      windowDescription,
    ],
  );
  const jobs = useAuditExportJobs(open);
  const mutation = useStartAuditExport();
  const { mutateAsync } = mutation;
  const start = useCallback(() => {
    mutateAsync(scope.body)
      .then(() => {
        toast({
          kind: "success",
          message: "Export queued. It will appear in the history below.",
        });
      })
      .catch(() => {
        toast({
          kind: "error",
          message:
            "Couldn't queue the export. Check your connection and try again.",
        });
      });
  }, [mutateAsync, scope.body, toast]);

  const schedules = useAuditExportSchedules(open);
  const createSchedule = useCreateExportSchedule();
  const removeSchedule = useDeleteExportSchedule();
  const { mutateAsync: createAsync } = createSchedule;
  const { mutateAsync: removeAsync } = removeSchedule;
  const create = useCallback(
    async (body: ExportScheduleBody): Promise<boolean> => {
      try {
        await createAsync(body);
        toast({
          kind: "success",
          message:
            "Schedule created. Each finished export is emailed to its recipients.",
        });
        return true;
      } catch {
        toast({
          kind: "error",
          message:
            "Couldn't create the schedule. Check your connection and try again.",
        });
        return false;
      }
    },
    [createAsync, toast],
  );
  const remove = useCallback(
    async (schedule: AuditExportSchedule): Promise<boolean> => {
      try {
        await removeAsync(schedule.id);
        toast({ kind: "success", message: "Schedule deleted." });
        return true;
      } catch {
        toast({
          kind: "error",
          message:
            "Couldn't delete the schedule. Check your connection and try again.",
        });
        return false;
      }
    },
    [removeAsync, toast],
  );

  return {
    scope,
    jobs: jobs.data,
    loading: jobs.isLoading,
    isPending: jobs.isPending,
    isPaused: jobs.isPaused,
    isError: jobs.isError,
    error: jobs.error,
    refetch: jobs.refetch,
    canStart: gate.enabled && Boolean(gate.tenantId),
    starting: mutation.isPending,
    start,
    schedules: {
      rows: schedules.data,
      loading: schedules.isLoading,
      failed: schedules.isError,
      canManage:
        options.isAdmin === true && gate.enabled && Boolean(gate.tenantId),
      creating: createSchedule.isPending,
      create,
      removing: removeSchedule.isPending,
      remove,
    },
  };
}
