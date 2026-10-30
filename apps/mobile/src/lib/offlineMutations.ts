/**
 * Offline-safe mutation defaults.
 *
 * TanStack Query can persist paused (offline) mutations to disk, but on
 * app restart the rehydrated mutation has no `mutationFn` — it lived in a
 * screen closure that no longer exists. `resumePausedMutations()` then
 * rejects with "No mutationFn found" and the queued edit is silently lost.
 *
 * The fix (per TanStack's offline guide) is to register a default
 * mutationFn keyed by a STABLE mutationKey, reconstructable from the
 * persisted variables alone. Screens use the same mutationKey, so the
 * online path and the rehydrated/resumed path run identical logic.
 *
 * registerOfflineMutationDefaults() must run before the persister restores
 * and calls resumePausedMutations() (app/_layout.tsx wires it at module
 * load, alongside Sentry).
 */
import type { QueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";

import { checkedApiResult } from "@/api/request";
import {
  createSequence,
  type SequenceStepWire,
  updateSequence,
} from "@/api/sequences";
import { registerEntityWriteMutationDefaults } from "./offlineEntityWrite";
import {
  OFFLINE_MUTATION_KEYS,
  type OfflineMutationAuthScope,
} from "./offlineMutationContract";
import {
  assertCurrentAuthScope,
  assertOperationId,
  currentOfflineAuthScope,
  OFFLINE_MUTATION_TTL_MS,
} from "./offlineMutationScope";
import { recordOfflineMutationFailure } from "./offlineMutationFailures";
import { trackOfflineReplay } from "./offlineReplayTelemetry";

const SEQUENCE_SAVE_SCOPE_ID = "postwave:sequence-save";

// TanStack serializes all sequence saves through the scope below. This
// process-local registry then chains the confirmed revision into the next
// queued/offline snapshot, including after hydration where multiple saved
// mutations may all carry the same originally observed baseVersion.
const confirmedSequenceVersions = new Map<string, number>();
const blockedSequenceVersions = new Set<string>();

export { OFFLINE_MUTATION_KEYS } from "./offlineMutationContract";
export type { OfflineMutationAuthScope } from "./offlineMutationContract";
export {
  currentOfflineAuthScope,
  OfflineMutationReplayError,
} from "./offlineMutationScope";

/**
 * A process-stable operation identifier persisted with every queued write.
 * It is also sent as the API Idempotency-Key, so a retry after app
 * termination cannot duplicate a server-side mutation.
 */
export function newOfflineOperationId(): string {
  return Crypto.randomUUID();
}

export function newOfflineMutationMetadata(): {
  auth: OfflineMutationAuthScope;
  operationId: string;
} {
  return {
    auth: currentOfflineAuthScope(),
    operationId: newOfflineOperationId(),
  };
}

/**
 * Variables persisted with an offline campaign authoring edit.
 *
 * `subject` stays required so records queued by an older build still replay.
 * `fields` carries the rest of the authoring surface the sheet now edits
 * (preview text, from-name, reply-to) as a DIFF — only what the user actually
 * changed — because updateAuthoringInput applies present fields and leaves
 * absent ones alone.
 */
export interface CampaignUpdateVars {
  auth: OfflineMutationAuthScope;
  operationId: string;
  id: string;
  subject: string;
  fields?: {
    subject?: string;
    preview_text?: string;
    from_name?: string;
    reply_to?: string;
  };
}

/** Variables persisted with an offline sequence-create. */
export interface SequenceCreateVars {
  auth: OfflineMutationAuthScope;
  operationId: string;
  name: string;
}

/**
 * Variables persisted with an offline sequence-builder save. Steps are
 * already serialized to wire form by the screen so this stays free of the
 * canvas serializer and survives a JSON round-trip on disk.
 */
export interface SequenceSaveVars {
  auth: OfflineMutationAuthScope;
  operationId: string;
  id: string;
  /** Last server revision observed when this durable mutation was authored. */
  baseVersion: number;
  steps: SequenceStepWire[];
}

export interface ConfirmedSequenceSaveResult {
  data: {
    id: string;
    version: number;
    [key: string]: unknown;
  };
  error: null;
  /** Revision actually placed in If-Match after serialized chaining. */
  confirmedBaseVersion: number;
}

export class SequenceSaveAuthorityError extends Error {
  readonly code = "sequence_save_requires_reload";

  constructor(message: string) {
    super(message);
    this.name = "SequenceSaveAuthorityError";
  }
}

export async function executeCampaignUpdate(vars: CampaignUpdateVars) {
  const { client } = assertCurrentAuthScope(vars.auth);
  assertOperationId(vars.operationId);
  // `fields` wins when present (it is the diff the sheet computed); `subject`
  // remains the whole body for records queued by an older build.
  const body =
    vars.fields && Object.keys(vars.fields).length > 0
      ? vars.fields
      : { subject: vars.subject };
  return client.request(
    "PATCH",
    `/api/v1/campaigns/${encodeURIComponent(vars.id)}`,
    { body, idempotencyKey: vars.operationId },
  );
}

export async function executeSequenceCreate(vars: SequenceCreateVars) {
  assertCurrentAuthScope(vars.auth);
  assertOperationId(vars.operationId);
  return checkedApiResult(
    createSequence({ name: vars.name }, { idempotencyKey: vars.operationId }),
  );
}

export async function executeSequenceSave(
  vars: SequenceSaveVars,
): Promise<ConfirmedSequenceSaveResult> {
  assertCurrentAuthScope(vars.auth);
  assertOperationId(vars.operationId);
  if (!vars.id.trim()) {
    throw new SequenceSaveAuthorityError(
      "This queued sequence edit has no sequence identity. Reload the draft before editing again.",
    );
  }
  if (!Number.isSafeInteger(vars.baseVersion) || vars.baseVersion < 1) {
    throw new SequenceSaveAuthorityError(
      "A confirmed sequence version is required before saving. Reload the latest draft.",
    );
  }

  const key = sequenceVersionKey(vars.auth, vars.id);
  if (blockedSequenceVersions.has(key)) {
    throw new SequenceSaveAuthorityError(
      "Sequence saving is locked after an unconfirmed write. Reload the latest draft before retrying.",
    );
  }
  const cachedVersion = confirmedSequenceVersions.get(key);
  const expectedVersion = Math.max(vars.baseVersion, cachedVersion ?? 0);

  let result;
  try {
    result = await checkedApiResult(
      updateSequence(
        vars.id,
        { steps: vars.steps },
        {
          idempotencyKey: vars.operationId,
          expectedVersion,
        },
      ),
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status?: unknown }).status === 412
    ) {
      blockedSequenceVersions.add(key);
      throw new SequenceSaveAuthorityError(
        "This sequence changed elsewhere. Reload the latest draft before re-applying your changes.",
      );
    }
    throw error;
  }

  if (!result.data) {
    blockedSequenceVersions.add(key);
    throw new SequenceSaveAuthorityError(
      "The server did not confirm this sequence identity and next version. Reload the latest draft before editing again.",
    );
  }
  const returnedId = String(result.data.id ?? "");
  const returnedVersion = result.data.version;
  if (
    returnedId !== vars.id ||
    !Number.isSafeInteger(returnedVersion) ||
    returnedVersion !== expectedVersion + 1
  ) {
    blockedSequenceVersions.add(key);
    throw new SequenceSaveAuthorityError(
      "The server did not confirm this sequence identity and next version. Reload the latest draft before editing again.",
    );
  }
  confirmedSequenceVersions.set(key, returnedVersion);
  return {
    data: { ...result.data, id: returnedId, version: returnedVersion },
    error: null,
    confirmedBaseVersion: expectedVersion,
  };
}

/** Seed/replace local authority only from a freshly fetched detail response. */
export function acceptFetchedSequenceVersion(
  auth: OfflineMutationAuthScope,
  id: string,
  version: number,
): void {
  if (!id.trim() || !Number.isSafeInteger(version) || version < 1) return;
  const key = sequenceVersionKey(auth, id);
  // A stale GET may settle after an offline mutation has already confirmed a
  // newer revision. Never move authority backwards from such a completion.
  confirmedSequenceVersions.set(
    key,
    Math.max(version, confirmedSequenceVersions.get(key) ?? 0),
  );
  blockedSequenceVersions.delete(key);
}

export function isSequenceSaveAuthorityError(
  error: unknown,
): error is SequenceSaveAuthorityError {
  return (
    error instanceof SequenceSaveAuthorityError ||
    (error != null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "sequence_save_requires_reload")
  );
}

/** Test-only reset for module-local replay authority. */
export function resetSequenceSaveAuthorityForTests(): void {
  confirmedSequenceVersions.clear();
  blockedSequenceVersions.clear();
}

export function recordCampaignUpdateFailure(
  vars: CampaignUpdateVars,
  error: unknown,
): void {
  void recordOfflineMutationFailure({
    auth: vars.auth,
    kind: "campaign_update",
    label: "Campaign edit",
    operationId: vars.operationId,
    error,
  });
}

export function recordSequenceCreateFailure(
  vars: SequenceCreateVars,
  error: unknown,
): void {
  void recordOfflineMutationFailure({
    auth: vars.auth,
    kind: "sequence_create",
    label: "New sequence",
    operationId: vars.operationId,
    error,
  });
}

export function recordSequenceSaveFailure(
  vars: SequenceSaveVars,
  error: unknown,
): void {
  void recordOfflineMutationFailure({
    auth: vars.auth,
    kind: "sequence_save",
    label: "Sequence changes",
    operationId: vars.operationId,
    error,
  });
}

export function registerOfflineMutationDefaults(qc: QueryClient): void {
  // The generic entity-write queue (NATIVE#1). Registered here so there is
  // still exactly ONE call site the root layout has to run before the
  // persister rehydrates and resumes paused mutations.
  registerEntityWriteMutationDefaults(qc);

  qc.setMutationDefaults(OFFLINE_MUTATION_KEYS.campaignUpdate, {
    mutationFn: executeCampaignUpdate,
    onSuccess: (_data, vars) => {
      trackOfflineReplay("campaign_update", "success", vars.auth);
      void qc.invalidateQueries({ queryKey: ["campaign"] });
      void qc.invalidateQueries({ queryKey: ["campaign-report"] });
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (error, vars) => {
      trackOfflineReplay("campaign_update", "failure", vars.auth, error);
      recordCampaignUpdateFailure(vars, error);
    },
  });

  qc.setMutationDefaults(OFFLINE_MUTATION_KEYS.sequenceCreate, {
    mutationFn: executeSequenceCreate,
    onSuccess: (_data, vars) => {
      trackOfflineReplay("sequence_create", "success", vars.auth);
      void qc.invalidateQueries({ queryKey: ["sequences"] });
    },
    onError: (error, vars) => {
      trackOfflineReplay("sequence_create", "failure", vars.auth, error);
      recordSequenceCreateFailure(vars, error);
    },
  });

  qc.setMutationDefaults(OFFLINE_MUTATION_KEYS.sequenceSave, {
    // One scope is intentionally global: the process registry above keys by
    // workspace/identity/sequence, while a single scope guarantees no two
    // full-snapshot saves can execute concurrently during replay.
    scope: { id: SEQUENCE_SAVE_SCOPE_ID },
    mutationFn: executeSequenceSave,
    onSuccess: (_data, vars) => {
      trackOfflineReplay("sequence_save", "success", vars.auth);
      void qc.invalidateQueries({
        queryKey: ["sequence", vars.auth.tenantId, vars.id],
      });
      void qc.invalidateQueries({ queryKey: ["sequences"] });
    },
    onError: (error, vars) => {
      trackOfflineReplay("sequence_save", "failure", vars.auth, error);
      recordSequenceSaveFailure(vars, error);
    },
  });
}

function sequenceVersionKey(
  auth: OfflineMutationAuthScope,
  id: string,
): string {
  return JSON.stringify([
    auth.baseUrl,
    auth.tenantId,
    auth.principalId,
    auth.role,
    id,
  ]);
}

export const offlineMutationPolicy = {
  ttlMs: OFFLINE_MUTATION_TTL_MS,
  persistedForApiKeys: false,
} as const;
