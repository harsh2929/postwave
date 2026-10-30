// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, apiErrorMessage } from "@/lib/api";
import { useVerifiedAuthScope } from "@/lib/auth-scope";
import {
  archiveCampaignTemplateDesign,
  campaignTemplateDesignIdempotencyKey,
  createCampaignFromTemplateDesign,
  createCampaignTemplateDesign,
  getCampaignTemplateDesign,
  listCampaignTemplateDesigns,
  listCampaignTemplateDesignRevisions,
  refineCampaignTemplateDesign,
  retryCampaignTemplateDesign,
  saveCampaignTemplateDesign,
  waitForCampaignTemplateDesign,
  type CampaignTemplateDesignDraft,
  type CampaignTemplateDesignRevision,
  type CreateCampaignFromDesignInput,
  type CreateCampaignTemplateDesignInput,
  type RefineCampaignTemplateDesignInput,
  type SaveCampaignTemplateDesignInput,
} from "@/lib/campaign-templates-api";
import {
  campaignTemplateDesignMutationFingerprint,
  clearCampaignTemplateDesignSession,
  readCampaignTemplateDesignSession,
  writeCampaignTemplateDesignSession,
  type CampaignTemplateDesignPendingMutation,
  type CampaignTemplateDesignSession,
} from "@/lib/campaign-template-design-session";

function designFailureMessage(draft: CampaignTemplateDesignDraft): string {
  if (draft.last_error_code === "design_expired") {
    return "This draft expired before it finished. Start a new design with the same brief.";
  }
  return (
    draft.last_error_message ||
    "This design attempt failed. Your brief is still available, and you can retry when the server allows it."
  );
}

function mutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.kind === "offline" || error.code === "offline") {
      return "You’re offline. This operation was not queued; reconnect and retry so the reviewed revision stays exact.";
    }
    if (
      error.code === "design_revision_conflict" ||
      error.code === "design_output_hash_mismatch"
    ) {
      return "The design changed in another window. We refreshed the latest immutable revision; review it before trying again.";
    }
    if (error.code === "idempotency_key_request_mismatch") {
      return "That retry key belongs to a different request. Start the changed request again.";
    }
    if (error.code === "design_draft_not_found") {
      return "This design is no longer available. It may have expired or been removed.";
    }
  }
  return apiErrorMessage(error, fallback);
}

function hasVerifiedMutationRejection(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // The API's requireOnline preflight proves an offline request never crossed
  // the network. Retaining/replaying its key on the next mount would create a
  // request the user was explicitly told was not queued.
  if (error.kind === "offline" || error.code === "offline") return true;
  if (error.kind !== "http") return false;
  // A received, non-transient 4xx is proof the server rejected this request
  // before accepting the mutation. Timeouts, throttling, early-data retries,
  // and every 5xx remain ambiguous and must retain the exact replay key.
  return (
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 425 &&
    error.status !== 429
  );
}

function isDesignUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === "design_draft_not_found")
  );
}

function mergeDesigns(
  current: CampaignTemplateDesignDraft[],
  incoming: CampaignTemplateDesignDraft[],
): CampaignTemplateDesignDraft[] {
  const byID = new Map(current.map((draft) => [draft.id, draft]));
  for (const draft of incoming) byID.set(draft.id, draft);
  return Array.from(byID.values());
}

export function useCampaignTemplateDesignWorkflow({
  mode,
  sourceTemplateId,
  enabled,
}: {
  mode: "adapt" | "generate";
  sourceTemplateId?: string;
  enabled: boolean;
}) {
  const verifiedScope = useVerifiedAuthScope();
  const recoveryScope = useMemo(
    () => ({
      tenantId: verifiedScope.tenantId,
      userId: verifiedScope.userId,
    }),
    [verifiedScope.tenantId, verifiedScope.userId],
  );
  const [designs, setDesigns] = useState<CampaignTemplateDesignDraft[]>([]);
  const [selectedDesignId, setSelectedDesignId] = useState<string>();
  // Committed value, readable from a callback without reading it inside a
  // setState updater — see removeDesign.
  const selectedDesignIdRef = useRef(selectedDesignId);
  selectedDesignIdRef.current = selectedDesignId;
  const [revisions, setRevisions] = useState<CampaignTemplateDesignRevision[]>(
    [],
  );
  const [working, setWorking] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [awaitingAcknowledgement, setAwaitingAcknowledgement] = useState(false);
  const [recoveryPersistenceAvailable, setRecoveryPersistenceAvailable] =
    useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<CampaignTemplateDesignSession | null>(null);

  const selectedDesign = useMemo(
    () =>
      designs.find((draft) => draft.id === selectedDesignId) ??
      designs.find((draft) => draft.status === "ready") ??
      designs[0],
    [designs, selectedDesignId],
  );

  const persist = useCallback(
    (
      patch: Partial<
        Omit<
          CampaignTemplateDesignSession,
          "version" | "scope" | "updatedAt" | "mode"
        >
      >,
    ) => {
      const current = sessionRef.current;
      const hasPatch = (
        key: keyof Omit<
          CampaignTemplateDesignSession,
          "version" | "scope" | "updatedAt" | "mode"
        >,
      ) => Object.prototype.hasOwnProperty.call(patch, key);
      const selectedDesignId = hasPatch("selectedDesignId")
        ? patch.selectedDesignId
        : current?.selectedDesignId;
      const pendingCreate = hasPatch("pendingCreate")
        ? patch.pendingCreate
        : current?.pendingCreate;
      const pendingArchiveKeys = hasPatch("pendingArchiveKeys")
        ? patch.pendingArchiveKeys
        : current?.pendingArchiveKeys;
      const pendingMutations = hasPatch("pendingMutations")
        ? patch.pendingMutations
        : current?.pendingMutations;
      const result = writeCampaignTemplateDesignSession(recoveryScope, {
        mode,
        ...(sourceTemplateId ? { sourceTemplateId } : {}),
        designIds: patch.designIds ?? current?.designIds ?? [],
        ...(selectedDesignId ? { selectedDesignId } : {}),
        ...(pendingCreate ? { pendingCreate } : {}),
        ...(pendingArchiveKeys ? { pendingArchiveKeys } : {}),
        ...(pendingMutations ? { pendingMutations } : {}),
      });
      if (result.session) sessionRef.current = result.session;
      setRecoveryPersistenceAvailable(result.persisted);
      return result;
    },
    [mode, recoveryScope, sourceTemplateId],
  );

  const preparePendingMutation = useCallback(
    (
      operation: CampaignTemplateDesignPendingMutation["operation"],
      designId: string,
      payload: CampaignTemplateDesignPendingMutation["payload"],
    ): CampaignTemplateDesignPendingMutation => {
      const fingerprint = campaignTemplateDesignMutationFingerprint(
        operation,
        designId,
        payload,
      );
      const existing = sessionRef.current?.pendingMutations?.find(
        (mutation) =>
          mutation.operation === operation && mutation.designId === designId,
      );
      if (existing) {
        if (existing.fingerprint === fingerprint) return existing;
        throw new Error(
          "A previous request is still awaiting reconciliation. Refresh this design before changing that request.",
        );
      }
      const mutation = {
        operation,
        designId,
        fingerprint,
        payload,
        idempotencyKey: campaignTemplateDesignIdempotencyKey(operation),
        createdAt: Date.now(),
      } as CampaignTemplateDesignPendingMutation;
      const pendingMutations = [
        ...(sessionRef.current?.pendingMutations ?? []),
        mutation,
      ];
      persist({
        designIds: Array.from(
          new Set([...(sessionRef.current?.designIds ?? []), designId]),
        ),
        pendingMutations,
      });
      return mutation;
    },
    [persist],
  );

  const dropDesignFromRecovery = useCallback(
    (designId: string) => {
      const current = sessionRef.current;
      const designIds = (current?.designIds ?? []).filter(
        (id) => id !== designId,
      );
      const selectedDesignId =
        current?.selectedDesignId === designId
          ? designIds[0]
          : current?.selectedDesignId;
      const pendingArchiveKeys = Object.fromEntries(
        Object.entries(current?.pendingArchiveKeys ?? {}).filter(
          ([id]) => id !== designId,
        ),
      );
      const pendingMutations = (current?.pendingMutations ?? []).filter(
        (mutation) => mutation.designId !== designId,
      );
      persist({
        designIds,
        selectedDesignId,
        pendingArchiveKeys: Object.keys(pendingArchiveKeys).length
          ? pendingArchiveKeys
          : undefined,
        pendingMutations: pendingMutations.length
          ? pendingMutations
          : undefined,
      });
      setDesigns((drafts) => drafts.filter((draft) => draft.id !== designId));
      // Clearing revisions is a side effect, so it cannot live inside the
      // setSelectedDesignId updater — React may invoke that more than once.
      // selectedDesignIdRef mirrors the committed value, so the decision can
      // be made out here and the updater kept pure.
      if (selectedDesignIdRef.current === designId) {
        setRevisions([]);
        setSelectedDesignId(designIds[0]);
      }
    },
    [persist],
  );

  const acknowledgePendingMutation = useCallback(
    (fingerprint: string) => {
      const pendingMutations = (
        sessionRef.current?.pendingMutations ?? []
      ).filter((mutation) => mutation.fingerprint !== fingerprint);
      persist({
        pendingMutations: pendingMutations.length
          ? pendingMutations
          : undefined,
      });
    },
    [persist],
  );

  const upsert = useCallback(
    (draft: CampaignTemplateDesignDraft) => {
      setDesigns((current) => mergeDesigns(current, [draft]));
      const ids = Array.from(
        new Set([...(sessionRef.current?.designIds ?? []), draft.id]),
      );
      const selected = sessionRef.current?.selectedDesignId ?? draft.id;
      setSelectedDesignId((current) => current ?? selected);
      persist({ designIds: ids, selectedDesignId: selected });
      if (draft.status === "failed") setError(designFailureMessage(draft));
      return draft;
    },
    [persist],
  );

  const loadRevisions = useCallback(
    async (id: string, signal?: AbortSignal) => {
      try {
        const response = await listCampaignTemplateDesignRevisions(id, signal);
        setRevisions(
          [...(Array.isArray(response.items) ? response.items : [])].sort((a, b) => b.revision - a.revision),
        );
      } catch (loadError) {
        if (signal?.aborted) return;
        setError(
          mutationErrorMessage(
            loadError,
            "The immutable revision history could not be loaded.",
          ),
        );
      }
    },
    [],
  );

  const poll = useCallback(
    async (draft: CampaignTemplateDesignDraft, signal: AbortSignal) => {
      if (draft.status !== "queued" && draft.status !== "generating") {
        if (draft.current_revision > 0) await loadRevisions(draft.id, signal);
        return upsert(draft);
      }
      const terminal = await waitForCampaignTemplateDesign(draft.id, {
        signal,
        onUpdate: upsert,
      });
      upsert(terminal);
      if (terminal.current_revision > 0) {
        await loadRevisions(terminal.id, signal);
      }
      return terminal;
    },
    [loadRevisions, upsert],
  );

  const replayPendingCreate = useCallback(
    async (
      pending: NonNullable<CampaignTemplateDesignSession["pendingCreate"]>,
      signal: AbortSignal,
    ) => {
      setAwaitingAcknowledgement(true);
      const settled = await Promise.allSettled(
        pending.idempotencyKeys.map((idempotencyKey) =>
          createCampaignTemplateDesign(pending.input, {
            idempotencyKey,
            signal,
          }),
        ),
      );
      const created = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failures = settled.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              {
                result,
                key: pending.idempotencyKeys[index]!,
                ambiguous: !hasVerifiedMutationRejection(result.reason),
              },
            ]
          : [],
      );
      const ambiguousKeys = failures
        .filter((failure) => failure.ambiguous)
        .map((failure) => failure.key);
      let persisted = true;
      if (created.length || failures.length) {
        setDesigns((current) => mergeDesigns(current, created));
        const ids = Array.from(
          new Set([
            ...(sessionRef.current?.designIds ?? []),
            ...created.map((draft) => draft.id),
          ]),
        );
        const selected =
          sessionRef.current?.selectedDesignId ?? created[0]?.id ?? ids[0];
        const result = persist({
          designIds: ids,
          selectedDesignId: selected,
          pendingCreate: ambiguousKeys.length
            ? {
                input: pending.input,
                idempotencyKeys: ambiguousKeys,
              }
            : undefined,
        });
        persisted = result.persisted;
        setSelectedDesignId(selected);
      }
      if (!signal.aborted) {
        // A request with no response is safe to leave only when its exact key
        // was read-back verified locally. Successful responses have actor-
        // scoped server IDs and verified rejections/offline preflights need no
        // replay at all.
        setAwaitingAcknowledgement(ambiguousKeys.length > 0 && !persisted);
      }
      if (failures.length && created.length === 0) {
        throw failures[0]!.result.reason;
      }
      if (failures.length) {
        setError(
          `${created.length} variation${created.length === 1 ? "" : "s"} started; ${failures.length} could not be started.`,
        );
      }
      return created;
    },
    [persist],
  );

  const replayPendingMutations = useCallback(
    async (
      pendingMutations: CampaignTemplateDesignPendingMutation[],
      currentDrafts: CampaignTemplateDesignDraft[],
      signal: AbortSignal,
    ): Promise<CampaignTemplateDesignDraft[]> => {
      let drafts = currentDrafts;
      for (const mutation of pendingMutations) {
        if (signal.aborted) break;
        const current = drafts.find((draft) => draft.id === mutation.designId);
        if (
          current &&
          mutation.operation === "refine" &&
          current.current_revision > mutation.payload.base_revision
        ) {
          try {
            await listCampaignTemplateDesignRevisions(
              mutation.designId,
              signal,
            );
          } catch {
            // Current state and lineage help surface the latest design, but
            // neither proves which tab submitted a mutation. The exact key is
            // therefore still replayed below.
          }
        }

        setAwaitingAcknowledgement(true);
        try {
          switch (mutation.operation) {
            case "refine": {
              const queued = await refineCampaignTemplateDesign(
                mutation.designId,
                mutation.payload,
                {
                  idempotencyKey: mutation.idempotencyKey,
                  signal,
                },
              );
              drafts = mergeDesigns(drafts, [queued]);
              upsert(queued);
              break;
            }
            case "retry": {
              const queued = await retryCampaignTemplateDesign(
                mutation.designId,
                {
                  idempotencyKey: mutation.idempotencyKey,
                  signal,
                },
              );
              drafts = mergeDesigns(drafts, [queued]);
              upsert(queued);
              break;
            }
            case "save":
              await saveCampaignTemplateDesign(
                mutation.designId,
                mutation.payload,
                {
                  idempotencyKey: mutation.idempotencyKey,
                  signal,
                },
              );
              break;
            case "create-campaign":
              await createCampaignFromTemplateDesign(
                mutation.designId,
                mutation.payload,
                {
                  idempotencyKey: mutation.idempotencyKey,
                  signal,
                },
              );
              break;
          }
          acknowledgePendingMutation(mutation.fingerprint);
          const refreshed = await getCampaignTemplateDesign(mutation.designId, {
            signal,
          });
          drafts = mergeDesigns(drafts, [refreshed]);
          upsert(refreshed);
        } catch (mutationError) {
          if (hasVerifiedMutationRejection(mutationError)) {
            acknowledgePendingMutation(mutation.fingerprint);
          }
          if (isDesignUnavailable(mutationError)) {
            dropDesignFromRecovery(mutation.designId);
            drafts = drafts.filter((draft) => draft.id !== mutation.designId);
          }
          if (!signal.aborted) {
            setError(
              mutationErrorMessage(
                mutationError,
                `The pending ${mutation.operation.replace("-", " ")} request could not be reconciled.`,
              ),
            );
          }
        } finally {
          if (!signal.aborted) setAwaitingAcknowledgement(false);
        }
      }
      return drafts;
    },
    [acknowledgePendingMutation, dropDesignFromRecovery, upsert],
  );

  const reconcilePendingArchives = useCallback(
    async (
      session: CampaignTemplateDesignSession,
      signal: AbortSignal,
    ): Promise<{
      designIds: string[];
      archivedIds: string[];
      pendingArchiveKeys?: Record<string, string>;
    }> => {
      const entries = Object.entries(session.pendingArchiveKeys ?? {}).filter(
        ([id]) => session.designIds.includes(id),
      );
      if (!entries.length) {
        return { designIds: session.designIds, archivedIds: [] };
      }
      setAwaitingAcknowledgement(true);
      const settled = await Promise.allSettled(
        entries.map(([id, idempotencyKey]) =>
          archiveCampaignTemplateDesign(id, { idempotencyKey, signal }),
        ),
      );
      if (signal.aborted) {
        return {
          designIds: session.designIds,
          archivedIds: [],
          pendingArchiveKeys: session.pendingArchiveKeys,
        };
      }

      const archivedIds: string[] = [];
      const pendingArchiveKeys: Record<string, string> = {};
      let firstFailure: unknown;
      entries.forEach(([id, key], index) => {
        const result = settled[index];
        if (result?.status === "fulfilled") {
          archivedIds.push(id);
          return;
        }
        const reason =
          result?.status === "rejected"
            ? result.reason
            : new Error("Missing archive response");
        if (isDesignUnavailable(reason)) {
          archivedIds.push(id);
          return;
        }
        firstFailure ??= reason;
        // Retain the exact key only while the response is ambiguous. Offline
        // preflight and terminal 4xx responses prove this archive was not
        // accepted; reusing their key later could replay a permanent rejection.
        if (!hasVerifiedMutationRejection(reason)) {
          pendingArchiveKeys[id] = key;
        }
      });
      const designIds = session.designIds.filter(
        (id) => !archivedIds.includes(id),
      );
      const selectedDesignId = designIds.includes(
        session.selectedDesignId ?? "",
      )
        ? session.selectedDesignId
        : designIds[0];
      const persistence = persist({
        designIds,
        selectedDesignId,
        pendingArchiveKeys: Object.keys(pendingArchiveKeys).length
          ? pendingArchiveKeys
          : undefined,
      });
      setAwaitingAcknowledgement(
        Object.keys(pendingArchiveKeys).length > 0 && !persistence.persisted,
      );
      if (firstFailure) {
        setError(
          mutationErrorMessage(
            firstFailure,
            Object.keys(pendingArchiveKeys).length
              ? "An archive response is still unknown. Its exact retry key remains recoverable."
              : "A prior archive was rejected. The draft remains available and can be discarded again.",
          ),
        );
      }
      return {
        designIds,
        archivedIds,
        ...(Object.keys(pendingArchiveKeys).length
          ? { pendingArchiveKeys }
          : {}),
      };
    },
    [persist],
  );

  const resume = useCallback(async () => {
    let stored = readCampaignTemplateDesignSession(
      recoveryScope,
      mode,
      sourceTemplateId,
    );
    sessionRef.current = stored;
    if (!stored) {
      // Verify storage while the composer is still idle so a privacy/quota
      // warning is visible before the user dispatches a durable request.
      stored = persist({ designIds: [] }).session;
    } else {
      // A successful read does not prove this browser still permits writes.
      // Re-write and read back the exact scoped record before resuming work.
      persist({});
    }
    if (!stored) return;
    setRecovering(true);
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let loaded: CampaignTemplateDesignDraft[] = [];
      let serverDesignIDs: string[] = [];
      try {
        const recoveryPage = await listCampaignTemplateDesigns(
          { limit: 50 },
          { signal: controller.signal },
        );
        serverDesignIDs = (Array.isArray(recoveryPage.items) ? recoveryPage.items : [])
          .filter(
            (draft) =>
              draft.mode === mode &&
              (mode === "generate"
                ? !draft.source_template_id
                : draft.source_template_id === sourceTemplateId),
          )
          .map((draft) => draft.id)
          .slice(0, 3);
      } catch (serverRecoveryError) {
        if (controller.signal.aborted) return;
        setError(
          mutationErrorMessage(
            serverRecoveryError,
            "Server-backed design recovery is temporarily unavailable. Local recovery will still be attempted.",
          ),
        );
      }
      if (stored.pendingArchiveKeys) {
        const archiveRecovery = await reconcilePendingArchives(
          stored,
          controller.signal,
        );
        serverDesignIDs = serverDesignIDs.filter(
          (id) => !archiveRecovery.archivedIds.includes(id),
        );
        stored = {
          ...stored,
          designIds: archiveRecovery.designIds,
          selectedDesignId: archiveRecovery.designIds.includes(
            stored.selectedDesignId ?? "",
          )
            ? stored.selectedDesignId
            : archiveRecovery.designIds[0],
          pendingArchiveKeys: archiveRecovery.pendingArchiveKeys,
        };
      }
      if (stored.pendingCreate) {
        loaded = await replayPendingCreate(
          stored.pendingCreate,
          controller.signal,
        );
      }
      const recoverableIDs = Array.from(
        new Set([...stored.designIds, ...serverDesignIDs]),
      ).slice(0, 3);
      if (recoverableIDs.length) {
        const fetched = await Promise.allSettled(
          recoverableIDs.map((id) =>
            getCampaignTemplateDesign(id, { signal: controller.signal }),
          ),
        );
        loaded = mergeDesigns(
          loaded,
          fetched.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          ),
        );
        const fetchFailure = fetched.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected" &&
            !(
              result.reason instanceof ApiError &&
              result.reason.code === "design_draft_not_found"
            ),
        );
        if (fetchFailure && loaded.length === 0) throw fetchFailure.reason;
        if (fetchFailure) {
          setError(
            mutationErrorMessage(
              fetchFailure.reason,
              "Some saved variations could not be recovered yet.",
            ),
          );
        }
        const missing = fetched.filter(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof ApiError &&
            result.reason.code === "design_draft_not_found",
        ).length;
        if (missing && loaded.length === 0) {
          clearCampaignTemplateDesignSession(
            recoveryScope,
            mode,
            sourceTemplateId,
          );
          sessionRef.current = null;
          setError(
            "The previous design is no longer available. Start a new one with your brief.",
          );
          return;
        }
      }
      if (stored.pendingMutations?.length) {
        loaded = await replayPendingMutations(
          stored.pendingMutations,
          loaded,
          controller.signal,
        );
      }
      setDesigns(loaded);
      const storedSelectedDesignId = stored.selectedDesignId;
      const selected =
        storedSelectedDesignId &&
        loaded.some((draft) => draft.id === storedSelectedDesignId)
          ? storedSelectedDesignId
          : loaded[0]?.id;
      setSelectedDesignId(selected);
      if (loaded.length) {
        persist({
          designIds: loaded.map((draft) => draft.id),
          selectedDesignId: selected,
          pendingCreate: undefined,
        });
      }
      const terminals = await Promise.allSettled(
        loaded.map((draft) => poll(draft, controller.signal)),
      );
      const firstRejected = terminals.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (firstRejected && !controller.signal.aborted) {
        throw firstRejected.reason;
      }
    } catch (resumeError) {
      if (!controller.signal.aborted) {
        setError(
          mutationErrorMessage(
            resumeError,
            "The saved design could not be resumed.",
          ),
        );
      }
    } finally {
      if (!controller.signal.aborted) setRecovering(false);
    }
  }, [
    mode,
    persist,
    poll,
    recoveryScope,
    replayPendingCreate,
    replayPendingMutations,
    reconcilePendingArchives,
    sourceTemplateId,
  ]);

  useEffect(() => {
    if (enabled) void resume();
    else {
      abortRef.current?.abort();
      setWorking(false);
      setRecovering(false);
      setAwaitingAcknowledgement(false);
      const session = sessionRef.current;
      if (
        session &&
        session.designIds.length === 0 &&
        !session.pendingCreate &&
        !session.pendingArchiveKeys &&
        !session.pendingMutations
      ) {
        clearCampaignTemplateDesignSession(
          recoveryScope,
          mode,
          sourceTemplateId,
        );
        sessionRef.current = null;
      }
    }
    return () => abortRef.current?.abort();
  }, [enabled, mode, recoveryScope, resume, sourceTemplateId]);

  useEffect(() => {
    if (!enabled || !selectedDesign?.id || selectedDesign.current_revision < 1)
      return;
    const controller = new AbortController();
    void loadRevisions(selectedDesign.id, controller.signal);
    return () => controller.abort();
  }, [
    enabled,
    loadRevisions,
    selectedDesign?.current_revision,
    selectedDesign?.id,
  ]);

  const start = useCallback(
    async (input: CreateCampaignTemplateDesignInput, count = 1) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setWorking(true);
      setError(null);
      setDesigns([]);
      setRevisions([]);
      setSelectedDesignId(undefined);
      const keys = Array.from({ length: Math.min(3, Math.max(1, count)) }, () =>
        campaignTemplateDesignIdempotencyKey("create"),
      );
      persist({
        designIds: [],
        pendingCreate: { input, idempotencyKeys: keys },
      });
      try {
        const created = await replayPendingCreate(
          { input, idempotencyKeys: keys },
          controller.signal,
        );
        const results = await Promise.allSettled(
          created.map((draft) => poll(draft, controller.signal)),
        );
        const failed = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failed && !controller.signal.aborted) throw failed.reason;
        return results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
      } catch (startError) {
        if (!controller.signal.aborted) {
          setError(
            mutationErrorMessage(
              startError,
              "The newsletter design could not be generated.",
            ),
          );
        }
        return [];
      } finally {
        if (!controller.signal.aborted) setWorking(false);
      }
    },
    [poll, replayPendingCreate, persist],
  );

  const refresh = useCallback(async () => {
    if (!selectedDesign) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setWorking(true);
    setError(null);
    try {
      const latest = await getCampaignTemplateDesign(selectedDesign.id, {
        signal: controller.signal,
      });
      upsert(latest);
      if (latest.status === "queued" || latest.status === "generating") {
        return await poll(latest, controller.signal);
      }
      if (latest.current_revision > 0) await loadRevisions(latest.id);
      return latest;
    } catch (refreshError) {
      if (controller.signal.aborted) return;
      if (isDesignUnavailable(refreshError)) {
        dropDesignFromRecovery(selectedDesign.id);
      }
      setError(
        mutationErrorMessage(
          refreshError,
          "The latest design could not be loaded.",
        ),
      );
    } finally {
      if (!controller.signal.aborted) setWorking(false);
    }
  }, [dropDesignFromRecovery, loadRevisions, poll, selectedDesign, upsert]);

  const refine = useCallback(
    async (instructions: string) => {
      if (!selectedDesign?.revision) {
        const unavailable = new Error(
          "The selected design has no immutable revision to refine.",
        );
        setError(unavailable.message);
        throw unavailable;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setWorking(true);
      setError(null);
      try {
        const payload: RefineCampaignTemplateDesignInput = {
          instructions,
          base_revision: selectedDesign.revision.revision,
        };
        let pending: CampaignTemplateDesignPendingMutation;
        try {
          pending = preparePendingMutation(
            "refine",
            selectedDesign.id,
            payload,
          );
        } catch (pendingError) {
          setError(
            mutationErrorMessage(
              pendingError,
              "The refinement could not be prepared safely.",
            ),
          );
          throw pendingError;
        }
        let queued: CampaignTemplateDesignDraft;
        setAwaitingAcknowledgement(true);
        try {
          queued = await refineCampaignTemplateDesign(
            selectedDesign.id,
            pending.payload as RefineCampaignTemplateDesignInput,
            {
              idempotencyKey: pending.idempotencyKey,
              signal: controller.signal,
            },
          );
          acknowledgePendingMutation(pending.fingerprint);
        } catch (refineError) {
          if (hasVerifiedMutationRejection(refineError)) {
            acknowledgePendingMutation(pending.fingerprint);
          }
          if (isDesignUnavailable(refineError)) {
            dropDesignFromRecovery(selectedDesign.id);
          }
          if (!controller.signal.aborted) {
            const message = mutationErrorMessage(
              refineError,
              "The design could not be refined.",
            );
            setError(message);
            if (
              refineError instanceof ApiError &&
              (refineError.code === "design_revision_conflict" ||
                refineError.code === "design_output_hash_mismatch")
            ) {
              // `refresh` replaces (and therefore aborts) this controller. Drop
              // the pre-ack close guard first because this HTTP response is a
              // verified rejection, not an ambiguous in-flight mutation.
              setAwaitingAcknowledgement(false);
              await refresh();
              // `refresh` clears its previous error before loading. Restore the
              // conflict explanation after the latest revision is visible.
              setError(message);
            }
          }
          throw refineError;
        } finally {
          if (!controller.signal.aborted) setAwaitingAcknowledgement(false);
        }
        upsert(queued);
        try {
          await poll(queued, controller.signal);
        } catch (pollError) {
          if (!controller.signal.aborted) {
            setError(
              mutationErrorMessage(
                pollError,
                "The refinement was accepted, but its latest state could not be loaded. Reopen this design to resume it.",
              ),
            );
          }
        }
        // The mutation is durable once the refine endpoint accepts it. A later
        // polling failure must not encourage a duplicate refinement request.
        return true;
      } finally {
        if (!controller.signal.aborted) setWorking(false);
      }
    },
    [
      acknowledgePendingMutation,
      dropDesignFromRecovery,
      poll,
      preparePendingMutation,
      refresh,
      selectedDesign,
      upsert,
    ],
  );

  const retry = useCallback(async () => {
    if (!selectedDesign) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setWorking(true);
    setError(null);
    let pending: CampaignTemplateDesignPendingMutation | undefined;
    try {
      pending = preparePendingMutation("retry", selectedDesign.id, {
        base_attempt_count: selectedDesign.attempt_count,
      });
      setAwaitingAcknowledgement(true);
      const queued = await retryCampaignTemplateDesign(selectedDesign.id, {
        idempotencyKey: pending.idempotencyKey,
        signal: controller.signal,
      });
      acknowledgePendingMutation(pending.fingerprint);
      setAwaitingAcknowledgement(false);
      upsert(queued);
      return await poll(queued, controller.signal);
    } catch (retryError) {
      if (pending && hasVerifiedMutationRejection(retryError)) {
        acknowledgePendingMutation(pending.fingerprint);
      }
      if (isDesignUnavailable(retryError)) {
        dropDesignFromRecovery(selectedDesign.id);
      }
      if (!controller.signal.aborted) {
        setError(
          mutationErrorMessage(
            retryError,
            "The failed design could not be retried.",
          ),
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        setAwaitingAcknowledgement(false);
        setWorking(false);
      }
    }
  }, [
    acknowledgePendingMutation,
    dropDesignFromRecovery,
    poll,
    preparePendingMutation,
    selectedDesign,
    upsert,
  ]);

  const saveExactRevision = useCallback(
    async (input: SaveCampaignTemplateDesignInput) => {
      if (!selectedDesign) {
        throw new Error("Select a durable design before saving it.");
      }
      const pending = preparePendingMutation("save", selectedDesign.id, input);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setAwaitingAcknowledgement(true);
      try {
        const saved = await saveCampaignTemplateDesign(
          selectedDesign.id,
          pending.payload as SaveCampaignTemplateDesignInput,
          {
            idempotencyKey: pending.idempotencyKey,
            signal: controller.signal,
          },
        );
        acknowledgePendingMutation(pending.fingerprint);
        return saved;
      } catch (saveError) {
        if (hasVerifiedMutationRejection(saveError)) {
          acknowledgePendingMutation(pending.fingerprint);
        }
        if (isDesignUnavailable(saveError)) {
          dropDesignFromRecovery(selectedDesign.id);
        }
        throw saveError;
      } finally {
        if (!controller.signal.aborted) setAwaitingAcknowledgement(false);
      }
    },
    [
      acknowledgePendingMutation,
      dropDesignFromRecovery,
      preparePendingMutation,
      selectedDesign,
    ],
  );

  const createCampaignExactRevision = useCallback(
    async (input: CreateCampaignFromDesignInput) => {
      if (!selectedDesign) {
        throw new Error("Select a durable design before creating a campaign.");
      }
      const pending = preparePendingMutation(
        "create-campaign",
        selectedDesign.id,
        input,
      );
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setAwaitingAcknowledgement(true);
      try {
        const campaign = await createCampaignFromTemplateDesign(
          selectedDesign.id,
          pending.payload as CreateCampaignFromDesignInput,
          {
            idempotencyKey: pending.idempotencyKey,
            signal: controller.signal,
          },
        );
        acknowledgePendingMutation(pending.fingerprint);
        return campaign;
      } catch (createError) {
        if (hasVerifiedMutationRejection(createError)) {
          acknowledgePendingMutation(pending.fingerprint);
        }
        if (isDesignUnavailable(createError)) {
          dropDesignFromRecovery(selectedDesign.id);
        }
        throw createError;
      } finally {
        if (!controller.signal.aborted) setAwaitingAcknowledgement(false);
      }
    },
    [
      acknowledgePendingMutation,
      dropDesignFromRecovery,
      preparePendingMutation,
      selectedDesign,
    ],
  );

  const discard = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const ids = Array.from(
      new Set(
        sessionRef.current?.designIds ?? designs.map((draft) => draft.id),
      ),
    );
    if (ids.length === 0) {
      clearCampaignTemplateDesignSession(recoveryScope, mode, sourceTemplateId);
      sessionRef.current = null;
      return true;
    }
    const pendingArchiveKeys = Object.fromEntries(
      ids.map((id) => [
        id,
        sessionRef.current?.pendingArchiveKeys?.[id] ??
          campaignTemplateDesignIdempotencyKey(`archive:${id}`),
      ]),
    );
    persist({
      designIds: ids,
      pendingCreate: undefined,
      pendingArchiveKeys,
    });
    setAwaitingAcknowledgement(true);
    const settled = await Promise.allSettled(
      ids.map((id) =>
        archiveCampaignTemplateDesign(id, {
          idempotencyKey: pendingArchiveKeys[id]!,
          signal: controller.signal,
        }),
      ),
    );
    if (controller.signal.aborted) return false;
    const failedIDs = ids.filter((_, index) => {
      const result = settled[index];
      return (
        result?.status === "rejected" && !isDesignUnavailable(result.reason)
      );
    });
    const ambiguousFailedIDs = ids.filter((_, index) => {
      const result = settled[index];
      return (
        result?.status === "rejected" &&
        !hasVerifiedMutationRejection(result.reason)
      );
    });
    let archiveRecoveryPersisted = true;
    if (failedIDs.length) {
      const remainingDesigns = designs.filter((draft) =>
        failedIDs.includes(draft.id),
      );
      const selected = failedIDs.includes(selectedDesignId ?? "")
        ? selectedDesignId
        : failedIDs[0];
      setDesigns(remainingDesigns);
      setSelectedDesignId(selected);
      setRevisions([]);
      const persistence = persist({
        designIds: failedIDs,
        selectedDesignId: selected,
        pendingArchiveKeys: ambiguousFailedIDs.length
          ? Object.fromEntries(
              ambiguousFailedIDs.map((id) => [id, pendingArchiveKeys[id]!]),
            )
          : undefined,
      });
      archiveRecoveryPersisted = persistence.persisted;
    }
    setAwaitingAcknowledgement(
      ambiguousFailedIDs.length > 0 && !archiveRecoveryPersisted,
    );
    const busy = settled.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof ApiError &&
        result.reason.code === "design_draft_in_progress",
    );
    if (busy) {
      setError(
        "Generation is still finishing. Close this window now; you can discard it after the attempt reaches a terminal state.",
      );
      return false;
    }
    const failure = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && !isDesignUnavailable(result.reason),
    );
    if (failure) {
      setError(
        mutationErrorMessage(
          failure.reason,
          "The server drafts could not be archived. They remain resumable.",
        ),
      );
      return false;
    }
    clearCampaignTemplateDesignSession(recoveryScope, mode, sourceTemplateId);
    sessionRef.current = null;
    setAwaitingAcknowledgement(false);
    setDesigns([]);
    setSelectedDesignId(undefined);
    setRevisions([]);
    setError(null);
    return true;
  }, [
    designs,
    mode,
    persist,
    recoveryScope,
    selectedDesignId,
    sourceTemplateId,
  ]);

  const select = useCallback(
    (id: string) => {
      setSelectedDesignId(id);
      persist({ selectedDesignId: id });
    },
    [persist],
  );

  const forget = useCallback(() => {
    abortRef.current?.abort();
    clearCampaignTemplateDesignSession(recoveryScope, mode, sourceTemplateId);
    sessionRef.current = null;
    setDesigns([]);
    setSelectedDesignId(undefined);
    setRevisions([]);
    setWorking(false);
    setRecovering(false);
    setError(null);
  }, [mode, recoveryScope, sourceTemplateId]);

  return {
    designs,
    selectedDesign,
    selectedDesignId,
    revisions,
    working,
    recovering,
    awaitingAcknowledgement,
    recoveryPersistenceAvailable,
    error,
    setError,
    start,
    select,
    refine,
    retry,
    saveExactRevision,
    createCampaignExactRevision,
    refresh,
    discard,
    forget,
    upsert,
  };
}

export { mutationErrorMessage as campaignTemplateDesignMutationErrorMessage };
