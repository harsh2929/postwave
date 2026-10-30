// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  createFrequencyCapRule,
  deleteFrequencyCapRule,
  FREQUENCY_CHANNELS,
  listFrequencyCapRules,
  sameFrequencyCapRevision,
  updateFrequencyCapRule,
  type FrequencyCapInput,
  type FrequencyCapRule,
  type FrequencyChannel,
} from "@/lib/deliverability-admin-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { newUUIDv7 } from "@/lib/http-fetch";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

const CHANNEL_LABEL: Record<FrequencyChannel, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
};

const FREQUENCY_RECEIPT_STORAGE_PREFIX = "postwave:frequency-cap-mutation:v1:";
const FREQUENCY_RECEIPT_MAX_BYTES = 128 * 1024;
// The server replay record lasts 24 hours. Stop one hour early so clock skew
// or boundary latency can never turn "same request" into a new create.
const FREQUENCY_RECEIPT_RETRY_MAX_AGE_MS = 23 * 60 * 60 * 1000;

interface Draft {
  label: string;
  maxSends: string;
  windowHours: string;
  active: boolean;
  channels: FrequencyChannel[];
}

const EMPTY_DRAFT: Draft = {
  label: "",
  maxSends: "3",
  windowHours: "24",
  active: true,
  channels: ["email"],
};

interface ExpectedFrequencyCap {
  label: string;
  max_sends: number;
  window_hours: number;
  active: boolean;
  channels: FrequencyChannel[];
}

interface FrequencyCapSnapshot extends ExpectedFrequencyCap {
  created_at: string;
}

interface MutationIdentityScope {
  tenantId: string;
  userId: string;
  role: string;
  viewerMode: boolean;
}

interface MutationReceiptBase extends MutationIdentityScope {
  idempotencyKey: string;
  createdAtMs: number;
  response?: { id: string; updatedAt: string };
  integrityConflict?: boolean;
}

type FrequencyMutationReceipt =
  | (MutationReceiptBase & {
      kind: "create";
      beforeIds: string[];
      input: FrequencyCapInput;
      expected: ExpectedFrequencyCap;
    })
  | (MutationReceiptBase & {
      kind: "update";
      targetId: string;
      expectedUpdatedAt: string;
      baseline: FrequencyCapSnapshot;
      input: Partial<FrequencyCapInput>;
      expected: ExpectedFrequencyCap;
    })
  | (MutationReceiptBase & {
      kind: "delete";
      targetId: string;
      expectedUpdatedAt: string;
      baseline: FrequencyCapSnapshot;
    });

type ReconciliationState =
  | "applied"
  | "retryable"
  | "conflict"
  | "unavailable"
  | "expired"
  | "identity_mismatch";

type ReceiptStorageStatus = "checking" | "ready" | "fault";

export function FrequencyCapsPanel({ identity }: { identity: MeResponse }) {
  const role = effectiveAuthRole(identity);
  const canWrite = roleCanWrite(role) && !identity.viewer_mode;
  const identityScope: MutationIdentityScope = {
    tenantId: identity.tenant_id,
    userId: identity.user_id,
    role,
    viewerMode: Boolean(identity.viewer_mode),
  };
  const identityScopeKey = JSON.stringify(identityScope);
  const queryClient = useQueryClient();
  const queryKey = frequencyCapsQueryKey(identityScope);
  const rules = useQuery({
    queryKey,
    queryFn: ({ signal }) => listFrequencyCapRules({ signal }),
    enabled: canWrite,
    staleTime: STALE.detail,
    retry: false,
  });
  const [editing, setEditing] = useState<FrequencyCapRule | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<FrequencyCapRule | null>(
    null,
  );
  const [mutationReceipt, setMutationReceipt] =
    useState<FrequencyMutationReceipt | null>(null);
  const [reconciliationState, setReconciliationState] =
    useState<ReconciliationState | null>(null);
  const [uiOwnerKey, setUiOwnerKey] = useState(identityScopeKey);
  const [receiptStorageStatus, setReceiptStorageStatus] =
    useState<ReceiptStorageStatus>("checking");
  const [receiptStorageOwnerKey, setReceiptStorageOwnerKey] = useState("");
  const mutationReceiptRef = useRef<FrequencyMutationReceipt | null>(null);
  const reconcileMutationReceiptRef = useRef<
    ((receipt: FrequencyMutationReceipt) => Promise<ReconciliationState>) | null
  >(null);
  const identityScopeRef = useRef(identityScope);
  identityScopeRef.current = identityScope;
  const operationRef = useRef(false);
  const uiOwnedByCurrentIdentity = uiOwnerKey === identityScopeKey;
  const visibleEditing = uiOwnedByCurrentIdentity ? editing : null;
  const ruleRows =
    canWrite && uiOwnedByCurrentIdentity && Array.isArray(rules.data)
      ? rules.data
      : [];
  const receiptStorageReady =
    receiptStorageOwnerKey === identityScopeKey &&
    receiptStorageStatus === "ready";
  const mutationBlocked = !receiptStorageReady || mutationReceipt !== null;
  const receiptMatchesCurrentIdentity =
    mutationReceipt === null ||
    sameMutationIdentity(mutationReceipt, identityScope);
  const effectiveReconciliationState = receiptMatchesCurrentIdentity
    ? reconciliationState
    : "identity_mismatch";

  useEffect(() => {
    const scope = { ...identityScopeRef.current };
    setReceiptStorageOwnerKey(identityScopeKey);
    setReceiptStorageStatus("checking");
    setUiOwnerKey(identityScopeKey);
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setRemoveTarget(null);
    setSuccess(null);
    const restored = readStoredFrequencyReceipt(scope);
    if (restored.kind === "fault") {
      mutationReceiptRef.current = null;
      setMutationReceipt(null);
      setReconciliationState(null);
      setReceiptStorageStatus("fault");
      setError(restored.message);
      return;
    }
    setReceiptStorageStatus("ready");
    if (restored.kind === "none") {
      mutationReceiptRef.current = null;
      setMutationReceipt(null);
      setReconciliationState(null);
      setError(null);
      return;
    }
    const retained = restored.receipt;
    mutationReceiptRef.current = retained;
    setMutationReceipt(retained);
    setReconciliationState("unavailable");
    setError(
      "A durable mutation receipt was recovered. Its canonical outcome is being verified before any retry.",
    );
    if (operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    void Promise.resolve()
      .then(() => reconcileMutationReceiptRef.current?.(retained))
      .finally(() => {
        operationRef.current = false;
        setSaving(false);
      });
  }, [identityScopeKey]);

  useEffect(() => {
    if (
      !mutationReceipt ||
      !sameMutationIdentity(mutationReceipt, identityScopeRef.current)
    ) {
      return;
    }
    const remaining =
      mutationReceipt.createdAtMs +
      FREQUENCY_RECEIPT_RETRY_MAX_AGE_MS -
      Date.now();
    const expire = () => {
      if (
        mutationReceiptRef.current?.idempotencyKey !==
        mutationReceipt.idempotencyKey
      ) {
        return;
      }
      setReconciliationState("unavailable");
      setError(
        "The retained request reached its conservative replay boundary. Verify the canonical list; the old key will not be dispatched again.",
      );
    };
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [mutationReceipt]);

  const validation = useMemo(() => validateDraft(draft), [draft]);
  const channelDraftChanged = useMemo(() => {
    if (!visibleEditing || visibleEditing === "new") return true;
    // Empty is a legacy/global rule. Selecting every currently supported
    // channel is how the editor represents it; omit `channels` on save unless
    // the operator narrows the scope, preserving its exact global semantics.
    if (visibleEditing.channels.length === 0) {
      return !FREQUENCY_CHANNELS.every((channel) =>
        draft.channels.includes(channel),
      );
    }
    return !sameChannels(visibleEditing.channels, draft.channels);
  }, [draft.channels, visibleEditing]);
  const dirty = useMemo(() => {
    if (!visibleEditing) return false;
    if (visibleEditing === "new") {
      return (
        draft.label !== EMPTY_DRAFT.label ||
        draft.maxSends !== EMPTY_DRAFT.maxSends ||
        draft.windowHours !== EMPTY_DRAFT.windowHours ||
        draft.active !== EMPTY_DRAFT.active ||
        !sameChannels(draft.channels, EMPTY_DRAFT.channels)
      );
    }
    const displayedChannels =
      visibleEditing.channels.length === 0
        ? [...FREQUENCY_CHANNELS]
        : visibleEditing.channels;
    return (
      draft.label !== visibleEditing.label ||
      draft.maxSends !== String(visibleEditing.max_sends) ||
      draft.windowHours !== String(visibleEditing.window_hours) ||
      draft.active !== visibleEditing.active ||
      !sameChannels(draft.channels, displayedChannels)
    );
  }, [draft, visibleEditing]);
  useUnsavedChangesGuard(dirty || saving || mutationReceipt !== null);

  function beginCreate(): void {
    if (!receiptStorageReady || mutationReceiptRef.current) return;
    setUiOwnerKey(identityScopeKey);
    setEditing("new");
    setDraft(EMPTY_DRAFT);
    setError(null);
    setSuccess(null);
  }

  function beginEdit(rule: FrequencyCapRule): void {
    if (!receiptStorageReady || mutationReceiptRef.current) return;
    setUiOwnerKey(identityScopeKey);
    setEditing(rule);
    setDraft({
      label: rule.label,
      maxSends: String(rule.max_sends),
      windowHours: String(rule.window_hours),
      active: rule.active,
      channels:
        rule.channels.length === 0
          ? [...FREQUENCY_CHANNELS]
          : [...rule.channels],
    });
    setError(null);
    setSuccess(null);
  }

  function closeEditor(): void {
    if (mutationReceiptRef.current) return;
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setError(null);
  }

  function markReceiptStorageFault(message: string): void {
    setReceiptStorageOwnerKey(identityScopeKey);
    setReceiptStorageStatus("fault");
    setError(message);
  }

  async function retainMutationReceipt(
    receipt: FrequencyMutationReceipt,
  ): Promise<boolean> {
    const stored = await writeStoredFrequencyReceipt(receipt);
    if (!stored.ok) {
      markReceiptStorageFault(stored.message);
      return false;
    }
    if (sameMutationIdentity(receipt, identityScopeRef.current)) {
      mutationReceiptRef.current = receipt;
      setMutationReceipt(receipt);
      setReceiptStorageOwnerKey(identityScopeKey);
      setReceiptStorageStatus("ready");
    }
    return true;
  }

  async function installMutationReceipt(
    receipt: FrequencyMutationReceipt,
  ): Promise<boolean> {
    if (!(await retainMutationReceipt(receipt))) return false;
    if (sameMutationIdentity(receipt, identityScopeRef.current)) {
      setReconciliationState(null);
    }
    return true;
  }

  async function clearMutationReceipt(
    receipt: FrequencyMutationReceipt,
  ): Promise<boolean> {
    const removed = await removeStoredFrequencyReceipt(receipt);
    if (!removed.ok) {
      markReceiptStorageFault(removed.message);
      return false;
    }
    if (mutationReceiptRef.current?.idempotencyKey === receipt.idempotencyKey) {
      mutationReceiptRef.current = null;
      setMutationReceipt(null);
      setReconciliationState(null);
      setReceiptStorageOwnerKey(identityScopeKey);
      setReceiptStorageStatus("ready");
    }
    return true;
  }

  function quarantineForIdentityChange(
    receipt: FrequencyMutationReceipt,
  ): void {
    if (mutationReceiptRef.current?.idempotencyKey !== receipt.idempotencyKey) {
      return;
    }
    setReconciliationState("identity_mismatch");
    setError(
      "This retained mutation belongs to another user, role, viewer state, or workspace. Return to that exact identity to verify it; this panel will not replay it here.",
    );
  }

  async function dispatchMutationReceipt(
    receipt: FrequencyMutationReceipt,
  ): Promise<FrequencyCapRule | undefined> {
    const options = { idempotencyKey: receipt.idempotencyKey };
    if (receipt.kind === "create") {
      return createFrequencyCapRule(receipt.input, options);
    }
    if (receipt.kind === "update") {
      return updateFrequencyCapRule(
        receipt.targetId,
        receipt.input,
        receipt.expectedUpdatedAt,
        options,
      );
    }
    await deleteFrequencyCapRule(
      receipt.targetId,
      receipt.expectedUpdatedAt,
      options,
    );
    return undefined;
  }

  async function dispatchRetainedMutationReceipt(
    receipt: FrequencyMutationReceipt,
  ): Promise<
    | { dispatched: true; response: FrequencyCapRule | undefined }
    | { dispatched: false }
  > {
    if (typeof navigator === "undefined" || !navigator.locks) {
      markReceiptStorageFault(
        "Cross-tab durable-receipt coordination is unavailable. The retained request was not replayed.",
      );
      return { dispatched: false };
    }
    let lockEntered = false;
    try {
      const result = await navigator.locks.request(
        frequencyReceiptLockName(receipt),
        { mode: "exclusive" },
        async () => {
          lockEntered = true;
          const asserted = assertStoredFrequencyReceipt(receipt);
          if (!asserted.ok) return asserted;
          return {
            ok: true as const,
            response: await dispatchMutationReceipt(receipt),
          };
        },
      );
      if (!result.ok) {
        markReceiptStorageFault(result.message);
        return { dispatched: false };
      }
      return { dispatched: true, response: result.response };
    } catch (caught) {
      if (lockEntered) throw caught;
      markReceiptStorageFault(
        "Cross-tab durable-receipt coordination failed. The retained request was not replayed.",
      );
      return { dispatched: false };
    }
  }

  function attachMutationResponse(
    receipt: FrequencyMutationReceipt,
    response: FrequencyCapRule | undefined,
  ): FrequencyMutationReceipt {
    if (!response || receipt.kind === "delete") return receipt;
    return {
      ...receipt,
      response: { id: response.id, updatedAt: response.updated_at },
    };
  }

  async function finishConfirmedMutation(
    receipt: FrequencyMutationReceipt,
    after: FrequencyCapRule[],
  ): Promise<void> {
    if (mutationReceiptRef.current?.idempotencyKey !== receipt.idempotencyKey) {
      return;
    }
    if (!sameMutationIdentity(receipt, identityScopeRef.current)) {
      quarantineForIdentityChange(receipt);
      return;
    }
    queryClient.setQueryData(frequencyCapsQueryKey(receipt), after);
    if (!(await clearMutationReceipt(receipt))) return;
    setRemoveTarget(null);
    setError(null);
    if (receipt.kind === "delete") {
      if (editing !== "new" && editing?.id === receipt.targetId) {
        setEditing(null);
        setDraft(EMPTY_DRAFT);
      }
      setSuccess("Frequency cap removed and confirmed by a fresh server read.");
      toast.success("Frequency cap removed.");
      return;
    }
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setSuccess("Frequency cap saved and confirmed by a fresh server read.");
    toast.success("Frequency cap saved.");
  }

  async function reconcileMutationReceipt(
    receipt: FrequencyMutationReceipt,
    cause?: string,
    forceConflict = false,
  ): Promise<ReconciliationState> {
    if (!sameMutationIdentity(receipt, identityScopeRef.current)) {
      quarantineForIdentityChange(receipt);
      return "identity_mismatch";
    }
    let after: FrequencyCapRule[];
    try {
      after = await listFrequencyCapRules({ fresh: true });
    } catch (caught) {
      if (!sameMutationIdentity(receipt, identityScopeRef.current)) {
        quarantineForIdentityChange(receipt);
        return "identity_mismatch";
      }
      const verificationError = apiErrorMessage(
        caught,
        "The canonical frequency-cap list could not be refreshed.",
      );
      setError(
        `${cause ? `${cause} ` : ""}The outcome remains unknown because a fresh read failed. This tab retained the original request key and has blocked other changes. ${verificationError}`,
      );
      setReconciliationState("unavailable");
      return "unavailable";
    }
    if (!sameMutationIdentity(receipt, identityScopeRef.current)) {
      quarantineForIdentityChange(receipt);
      return "identity_mismatch";
    }
    queryClient.setQueryData(frequencyCapsQueryKey(receipt), after);
    let state: ReconciliationState =
      forceConflict || receipt.integrityConflict
        ? "conflict"
        : classifyMutationReceipt(receipt, after);
    if (state === "retryable" && !receiptRetryWindowOpen(receipt)) {
      state = "expired";
    }
    setReconciliationState(state);
    if (state === "applied") {
      await finishConfirmedMutation(receipt, after);
      return state;
    }
    if (state === "retryable") {
      setError(
        `${cause ? `${cause} ` : ""}A fresh read does not yet prove that the original ${mutationKindLabel(receipt.kind)} was applied. This tab retained its request key; verify again or retry that exact request.`,
      );
      return state;
    }
    if (state === "expired") {
      setError(
        "A fresh read cannot prove the original mutation was applied, but its safe server replay window has expired. Replay is disabled; use the refreshed state to start a reviewed follow-up.",
      );
      return state;
    }
    setError(
      `${cause ? `${cause} ` : ""}Fresh server state no longer matches the pre-write revision, so automatic replay is blocked. Keep this tab open and verify the rule before making another change.`,
    );
    return state;
  }

  async function acceptRefreshedConflict(): Promise<void> {
    const receipt = mutationReceiptRef.current;
    if (
      !receipt ||
      !["conflict", "expired"].includes(effectiveReconciliationState ?? "")
    ) {
      return;
    }
    if (!(await clearMutationReceipt(receipt))) return;
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setRemoveTarget(null);
    setError(null);
    setSuccess(
      "Refreshed server state accepted. Start any follow-up from the current rows.",
    );
  }

  async function verifyRetainedMutation(): Promise<void> {
    const receipt = mutationReceiptRef.current;
    if (!receipt || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    setSuccess(null);
    try {
      await reconcileMutationReceipt(receipt);
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function retryRetainedMutation(): Promise<void> {
    const receipt = mutationReceiptRef.current;
    if (!receipt || operationRef.current) return;
    const operationScope = { ...identityScopeRef.current };
    if (!sameMutationIdentity(receipt, operationScope)) {
      quarantineForIdentityChange(receipt);
      return;
    }
    operationRef.current = true;
    setSaving(true);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity);
      if (!sameMutationIdentity(operationScope, identityScopeRef.current)) {
        quarantineForIdentityChange(receipt);
        return;
      }
      const beforeRetry = await reconcileMutationReceipt(receipt);
      if (beforeRetry !== "retryable") return;
      const retained = mutationReceiptRef.current;
      if (
        !retained ||
        retained.idempotencyKey !== receipt.idempotencyKey ||
        !sameMutationIdentity(retained, identityScopeRef.current)
      ) {
        if (retained) quarantineForIdentityChange(retained);
        return;
      }
      try {
        const dispatched = await dispatchRetainedMutationReceipt(retained);
        if (!dispatched.dispatched) return;
        const nextReceipt = attachMutationResponse(
          retained,
          dispatched.response,
        );
        if (!(await retainMutationReceipt(nextReceipt))) return;
        if (!sameMutationIdentity(nextReceipt, identityScopeRef.current)) {
          quarantineForIdentityChange(nextReceipt);
          return;
        }
        await reconcileMutationReceipt(nextReceipt);
      } catch (caught) {
        const active = retained;
        const integrityConflict = isIdempotencyIntegrityConflict(caught);
        const reviewReceipt = integrityConflict
          ? { ...active, integrityConflict: true }
          : active;
        if (
          integrityConflict &&
          !(await retainMutationReceipt(reviewReceipt))
        ) {
          return;
        }
        await reconcileMutationReceipt(
          reviewReceipt,
          apiErrorMessage(
            caught,
            "The retained request could not be replayed.",
          ),
          integrityConflict,
        );
      }
    } catch (caught) {
      if (!sameMutationIdentity(operationScope, identityScopeRef.current)) {
        quarantineForIdentityChange(receipt);
        return;
      }
      setError(
        apiErrorMessage(
          caught,
          "The retained frequency-cap mutation could not be retried.",
        ),
      );
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function save(): Promise<void> {
    const editor = visibleEditing;
    if (
      !canWrite ||
      !receiptStorageReady ||
      !editor ||
      validation ||
      operationRef.current ||
      mutationReceiptRef.current
    ) {
      return;
    }
    const operationScope = { ...identityScopeRef.current };
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    let receipt: FrequencyMutationReceipt | null = null;
    try {
      await verifyFreshAdminAuthority(identity);
      if (!sameMutationIdentity(operationScope, identityScopeRef.current)) {
        setError("Identity changed before dispatch. No request was sent.");
        return;
      }
      const before = await listFrequencyCapRules({ fresh: true });
      if (!sameMutationIdentity(operationScope, identityScopeRef.current)) {
        setError("Identity changed before dispatch. No request was sent.");
        return;
      }
      const baseInput = {
        label: draft.label.trim(),
        max_sends: Number(draft.maxSends),
        window_hours: Number(draft.windowHours),
        active: draft.active,
      };
      if (editor === "new") {
        const input: FrequencyCapInput = {
          ...baseInput,
          channels: [...draft.channels],
        };
        receipt = {
          kind: "create",
          ...operationScope,
          idempotencyKey: newUUIDv7(),
          createdAtMs: Date.now(),
          beforeIds: before.map((rule) => rule.id),
          input,
          expected: { ...input, channels: [...draft.channels] },
        };
      } else {
        const current = before.find((rule) => rule.id === editor.id);
        if (!current || !sameFrequencyCapRevision(editor, current)) {
          queryClient.setQueryData(
            frequencyCapsQueryKey(operationScope),
            before,
          );
          throw new Error(
            "This cap changed after the editor opened. Review the latest server state.",
          );
        }
        const input: Partial<FrequencyCapInput> = {
          ...baseInput,
          ...(channelDraftChanged ? { channels: [...draft.channels] } : {}),
        };
        receipt = {
          kind: "update",
          ...operationScope,
          idempotencyKey: newUUIDv7(),
          createdAtMs: Date.now(),
          targetId: current.id,
          expectedUpdatedAt: current.updated_at,
          baseline: snapshotFrequencyCap(current),
          input,
          expected: {
            ...baseInput,
            channels: channelDraftChanged
              ? [...draft.channels]
              : [...current.channels],
          },
        };
      }
      // Persist and read-verify the owner-scoped receipt before dispatch. A
      // reload restores this exact request key; unavailable storage refuses the
      // mutation before fetch rather than losing replay identity.
      if (!(await installMutationReceipt(receipt))) return;
      if (!sameMutationIdentity(receipt, identityScopeRef.current)) {
        await clearMutationReceipt(receipt);
        setError("Identity changed before dispatch. No request was sent.");
        return;
      }
      const response = await dispatchMutationReceipt(receipt);
      receipt = attachMutationResponse(receipt, response);
      if (!(await retainMutationReceipt(receipt))) return;
      if (!sameMutationIdentity(receipt, identityScopeRef.current)) {
        quarantineForIdentityChange(receipt);
        return;
      }
      await reconcileMutationReceipt(receipt);
    } catch (caught) {
      const activeReceipt = receipt;
      const integrityConflict = isIdempotencyIntegrityConflict(caught);
      const reviewReceipt =
        activeReceipt && integrityConflict
          ? { ...activeReceipt, integrityConflict: true }
          : activeReceipt;
      if (
        reviewReceipt &&
        (mutationOutcomeMayBeUnknown(caught) || integrityConflict)
      ) {
        if (
          integrityConflict &&
          !(await retainMutationReceipt(reviewReceipt))
        ) {
          return;
        }
        await reconcileMutationReceipt(
          reviewReceipt,
          apiErrorMessage(caught, "The frequency-cap response was uncertain."),
          integrityConflict,
        );
      } else {
        if (!sameMutationIdentity(operationScope, identityScopeRef.current)) {
          setError("Identity changed before dispatch. No request was sent.");
          return;
        }
        if (activeReceipt) {
          if (!(await clearMutationReceipt(activeReceipt))) return;
        }
        setError(apiErrorMessage(caught, "Could not save the frequency cap."));
        void rules.refetch();
      }
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function remove(rule: FrequencyCapRule): Promise<void> {
    if (
      !canWrite ||
      !receiptStorageReady ||
      operationRef.current ||
      mutationReceiptRef.current
    ) {
      return;
    }
    const operationScope = { ...identityScopeRef.current };
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    let receipt: FrequencyMutationReceipt | null = null;
    try {
      await verifyFreshAdminAuthority(identity);
      if (!sameMutationIdentity(operationScope, identityScopeRef.current)) {
        setError("Identity changed before dispatch. No request was sent.");
        return;
      }
      const before = await listFrequencyCapRules({ fresh: true });
      if (!sameMutationIdentity(operationScope, identityScopeRef.current)) {
        setError("Identity changed before dispatch. No request was sent.");
        return;
      }
      const current = before.find((candidate) => candidate.id === rule.id);
      if (!current || !sameFrequencyCapRevision(rule, current)) {
        queryClient.setQueryData(frequencyCapsQueryKey(operationScope), before);
        throw new Error(
          "This cap changed after removal was opened. Review the latest server state.",
        );
      }
      receipt = {
        kind: "delete",
        ...operationScope,
        idempotencyKey: newUUIDv7(),
        createdAtMs: Date.now(),
        targetId: current.id,
        expectedUpdatedAt: current.updated_at,
        baseline: snapshotFrequencyCap(current),
      };
      if (!(await installMutationReceipt(receipt))) return;
      if (!sameMutationIdentity(receipt, identityScopeRef.current)) {
        await clearMutationReceipt(receipt);
        setError("Identity changed before dispatch. No request was sent.");
        return;
      }
      await dispatchMutationReceipt(receipt);
      if (!sameMutationIdentity(receipt, identityScopeRef.current)) {
        quarantineForIdentityChange(receipt);
        return;
      }
      await reconcileMutationReceipt(receipt);
    } catch (caught) {
      const activeReceipt = receipt;
      const integrityConflict = isIdempotencyIntegrityConflict(caught);
      const reviewReceipt =
        activeReceipt && integrityConflict
          ? { ...activeReceipt, integrityConflict: true }
          : activeReceipt;
      if (
        reviewReceipt &&
        (mutationOutcomeMayBeUnknown(caught) || integrityConflict)
      ) {
        setRemoveTarget(null);
        if (
          integrityConflict &&
          !(await retainMutationReceipt(reviewReceipt))
        ) {
          return;
        }
        await reconcileMutationReceipt(
          reviewReceipt,
          apiErrorMessage(caught, "The frequency-cap response was uncertain."),
          integrityConflict,
        );
        return;
      }
      if (activeReceipt && !(await clearMutationReceipt(activeReceipt))) return;
      if (!sameMutationIdentity(operationScope, identityScopeRef.current)) {
        setError("Identity changed before dispatch. No request was sent.");
        return;
      }
      setError(apiErrorMessage(caught, "Could not remove the frequency cap."));
      void rules.refetch();
      throw caught;
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  reconcileMutationReceiptRef.current = (receipt) =>
    reconcileMutationReceipt(receipt);

  return (
    <Card aria-labelledby="frequency-caps-title">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle as="h2" id="frequency-caps-title">
            Enforced frequency caps
          </CardTitle>
          <CardDescription>
            Per-subscriber, cross-channel limits evaluated in the canonical
            campaign queue-fill path before delivery.
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={
            !canWrite || saving || mutationBlocked || visibleEditing !== null
          }
          onClick={beginCreate}
        >
          Add cap
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert role="note">
          <AlertTitle>Concurrency boundary</AlertTitle>
          <AlertDescription>
            The web console re-reads the rule immediately before update or
            removal, and the server atomically rejects the write if that exact
            revision is no longer current. Every accepted write is confirmed by
            another uncached read.
          </AlertDescription>
        </Alert>

        {!canWrite ? null : rules.isPending && !rules.data ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading frequency caps…
          </p>
        ) : rules.isError && !rules.data ? (
          <Alert variant="destructive">
            <AlertTitle>Frequency caps unavailable</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {apiErrorMessage(
                  rules.error,
                  "Frequency caps could not be verified.",
                )}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={rules.isFetching}
                onClick={() => void rules.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {ruleRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No frequency cap is configured. The send pipeline applies no
                tenant-level cap from this rule set.
              </p>
            ) : (
              <ul className="space-y-2">
                {ruleRows.map((rule) => (
                  <li
                    key={rule.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{rule.label}</p>
                        <Badge variant={rule.active ? "success" : "outline"}>
                          {rule.active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        At most {rule.max_sends.toLocaleString()} send(s) per{" "}
                        {rule.window_hours.toLocaleString()} hour(s) ·{" "}
                        {rule.channels.length === 0
                          ? "all channels (legacy/global)"
                          : rule.channels
                              .map((channel) => CHANNEL_LABEL[channel])
                              .join(", ")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Created{" "}
                        {formatWireTimestamp(
                          rule.created_at,
                          "at an unknown time",
                        )}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          !canWrite ||
                          saving ||
                          mutationBlocked ||
                          visibleEditing !== null
                        }
                        onClick={() => beginEdit(rule)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={!canWrite || saving || mutationBlocked}
                        onClick={() => setRemoveTarget(rule)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {visibleEditing ? (
          <form
            className="space-y-4 rounded-lg border bg-muted/20 p-4"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h3 className="font-medium">
              {visibleEditing === "new"
                ? "Add frequency cap"
                : `Edit ${visibleEditing.label}`}
            </h3>
            {visibleEditing !== "new" &&
            visibleEditing.channels.length === 0 ? (
              <Alert variant="warning">
                <AlertTitle>Legacy global scope</AlertTitle>
                <AlertDescription>
                  This rule currently applies to every channel. All supported
                  channels are selected below; leaving them unchanged preserves
                  the empty/global server scope.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="frequency-cap-label">Label</Label>
              <Input
                id="frequency-cap-label"
                value={draft.label}
                maxLength={160}
                disabled={saving || mutationBlocked}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    label: event.target.value,
                  }))
                }
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="frequency-cap-max-sends">Maximum sends</Label>
                <Input
                  id="frequency-cap-max-sends"
                  type="number"
                  min={1}
                  max={1_000}
                  inputMode="numeric"
                  value={draft.maxSends}
                  disabled={saving || mutationBlocked}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      maxSends: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="frequency-cap-window-hours">Window hours</Label>
                <Input
                  id="frequency-cap-window-hours"
                  type="number"
                  min={1}
                  max={720}
                  inputMode="numeric"
                  value={draft.windowHours}
                  disabled={saving || mutationBlocked}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      windowHours: event.target.value,
                    }))
                  }
                />
              </div>
            </div>
            <fieldset
              className="space-y-2"
              disabled={saving || mutationBlocked}
            >
              <legend className="text-sm font-medium">
                Shared cap channels
              </legend>
              <div className="flex flex-wrap gap-4">
                {FREQUENCY_CHANNELS.map((channel) => (
                  <label
                    key={channel}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={draft.channels.includes(channel)}
                      disabled={saving || mutationBlocked}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          channels: event.target.checked
                            ? [...current.channels, channel]
                            : current.channels.filter(
                                (item) => item !== channel,
                              ),
                        }))
                      }
                    />
                    {CHANNEL_LABEL[channel]}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                A recipient&apos;s sends on every selected channel count toward
                one shared threshold.
              </p>
            </fieldset>
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                checked={draft.active}
                disabled={saving || mutationBlocked}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    active: event.target.checked,
                  }))
                }
              />
              <span>
                <strong className="block">Active rule</strong>
                Inactive rules remain stored but do not filter the queue.
              </span>
            </label>
            {validation ? (
              <p role="alert" className="text-sm text-destructive">
                {validation}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={
                  Boolean(validation) || saving || mutationBlocked || !dirty
                }
                loading={saving}
              >
                {visibleEditing === "new" ? "Create cap" : "Save cap"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={saving || mutationBlocked}
                onClick={closeEditor}
              >
                {dirty ? "Discard draft" : "Cancel"}
              </Button>
            </div>
          </form>
        ) : null}

        {receiptStorageStatus === "fault" ? (
          <Alert variant="destructive">
            <AlertTitle>Durable recovery storage unavailable</AlertTitle>
            <AlertDescription>
              {error ??
                "Frequency-cap mutations are disabled before dispatch because a recovery receipt cannot be safely stored."}
            </AlertDescription>
          </Alert>
        ) : mutationReceipt ? (
          <Alert variant="warning">
            <AlertTitle>Durable original request retained</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {error ??
                  "The server outcome has not been confirmed. Other frequency-cap changes are blocked."}
              </p>
              <p>
                The exact request is durably scoped to this workspace, user,
                role, and viewer state. A reload restores the same key and
                verifies canonical state before replay; replay is disabled
                before the server&apos;s 24-hour boundary.
              </p>
              <div className="flex flex-wrap gap-2">
                {effectiveReconciliationState !== "identity_mismatch" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => void verifyRetainedMutation()}
                  >
                    Verify outcome
                  </Button>
                ) : null}
                {effectiveReconciliationState === "retryable" ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving}
                    onClick={() => void retryRetainedMutation()}
                  >
                    Retry original request
                  </Button>
                ) : null}
                {["conflict", "expired"].includes(
                  effectiveReconciliationState ?? "",
                ) ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving}
                    onClick={() => void acceptRefreshedConflict()}
                  >
                    Use refreshed state
                  </Button>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTitle>Frequency-cap operation not confirmed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {success ? (
          <p role="status" className="text-sm text-success-emphasis">
            {success}
          </p>
        ) : null}
        {!canWrite ? (
          <p className="text-sm text-muted-foreground">
            Owner or admin access is required to change frequency caps.
          </p>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove this enforced frequency cap?"
        description="Future campaign queue fills will stop applying this rule. In an otherwise admitted campaign, email recipients skipped by a cap may still enter the intelligent-retry queue; SMS and push recipients remain withheld. Queue admission is not a delivery guarantee."
        confirmLabel="Remove cap"
        confirmationToken="REMOVE CAP"
        onConfirm={async () => {
          if (removeTarget) await remove(removeTarget);
        }}
      />
    </Card>
  );
}

function validateDraft(draft: Draft): string | null {
  if (!draft.label.trim()) return "Label is required.";
  const maxSends = Number(draft.maxSends);
  if (!Number.isSafeInteger(maxSends) || maxSends < 1 || maxSends > 1_000) {
    return "Maximum sends must be a whole number from 1 to 1,000.";
  }
  const windowHours = Number(draft.windowHours);
  if (
    !Number.isSafeInteger(windowHours) ||
    windowHours < 1 ||
    windowHours > 720
  ) {
    return "Window hours must be a whole number from 1 to 720.";
  }
  if (draft.channels.length === 0) return "Select at least one channel.";
  return null;
}

function sameChannels(
  left: readonly FrequencyChannel[],
  right: readonly FrequencyChannel[],
): boolean {
  return (
    left.length === right.length &&
    left.every((channel) => right.includes(channel))
  );
}

function ruleMatchesExpected(
  rule: FrequencyCapRule,
  expected: ExpectedFrequencyCap,
): boolean {
  return (
    rule.label === expected.label &&
    rule.max_sends === expected.max_sends &&
    rule.window_hours === expected.window_hours &&
    rule.active === expected.active &&
    sameChannels(rule.channels, expected.channels)
  );
}

function snapshotFrequencyCap(rule: FrequencyCapRule): FrequencyCapSnapshot {
  return {
    label: rule.label,
    max_sends: rule.max_sends,
    window_hours: rule.window_hours,
    active: rule.active,
    channels: [...rule.channels],
    created_at: rule.created_at,
  };
}

function ruleMatchesSnapshot(
  rule: FrequencyCapRule,
  snapshot: FrequencyCapSnapshot,
): boolean {
  return (
    rule.created_at === snapshot.created_at &&
    ruleMatchesExpected(rule, snapshot)
  );
}

function sameMutationIdentity(
  left: MutationIdentityScope,
  right: MutationIdentityScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.role === right.role &&
    left.viewerMode === right.viewerMode
  );
}

function frequencyCapsQueryKey(scope: MutationIdentityScope) {
  return [
    "list-hygiene",
    scope.tenantId,
    scope.userId,
    scope.role,
    scope.viewerMode,
    "enforced-frequency-caps",
  ] as const;
}

function classifyMutationReceipt(
  receipt: FrequencyMutationReceipt,
  rules: FrequencyCapRule[],
): "applied" | "retryable" | "conflict" {
  if (receipt.kind === "create") {
    const beforeIds = new Set(receipt.beforeIds);
    if (receipt.response) {
      if (beforeIds.has(receipt.response.id)) return "conflict";
      const responseRule = rules.find(
        (rule) => rule.id === receipt.response?.id,
      );
      if (!responseRule) return "retryable";
      return responseRule.updated_at === receipt.response.updatedAt &&
        ruleMatchesExpected(responseRule, receipt.expected)
        ? "applied"
        : "conflict";
    }
    const candidates = rules.filter(
      (rule) =>
        !beforeIds.has(rule.id) && ruleMatchesExpected(rule, receipt.expected),
    );
    if (candidates.length === 1) return "applied";
    return candidates.length === 0 ? "retryable" : "conflict";
  }

  const current = rules.find((rule) => rule.id === receipt.targetId);
  if (receipt.kind === "delete") {
    if (!current) return "applied";
    return current.updated_at === receipt.expectedUpdatedAt &&
      ruleMatchesSnapshot(current, receipt.baseline)
      ? "retryable"
      : "conflict";
  }

  if (receipt.response && receipt.response.id !== receipt.targetId) {
    return "conflict";
  }
  if (!current) return "conflict";
  if (current.updated_at === receipt.expectedUpdatedAt) {
    return ruleMatchesSnapshot(current, receipt.baseline)
      ? "retryable"
      : "conflict";
  }
  if (
    current.created_at !== receipt.baseline.created_at ||
    Date.parse(current.updated_at) <= Date.parse(receipt.expectedUpdatedAt)
  ) {
    return "conflict";
  }
  if (!ruleMatchesExpected(current, receipt.expected)) return "conflict";
  if (receipt.response && current.updated_at !== receipt.response.updatedAt) {
    return "conflict";
  }
  return "applied";
}

function mutationOutcomeMayBeUnknown(caught: unknown): boolean {
  if (!isApiError(caught)) return true;
  if (caught.kind === "offline") return false;
  if (caught.kind !== "http") return true;
  return (
    caught.code === "idempotency_key_in_progress" ||
    caught.status >= 500 ||
    caught.status === 408 ||
    caught.status === 425 ||
    caught.status === 429
  );
}

function isIdempotencyIntegrityConflict(caught: unknown): boolean {
  return (
    isApiError(caught) && caught.code === "idempotency_key_request_mismatch"
  );
}

function receiptRetryWindowOpen(receipt: FrequencyMutationReceipt): boolean {
  const age = Date.now() - receipt.createdAtMs;
  return age >= 0 && age < FREQUENCY_RECEIPT_RETRY_MAX_AGE_MS;
}

function mutationKindLabel(kind: FrequencyMutationReceipt["kind"]): string {
  if (kind === "create") return "creation";
  if (kind === "update") return "update";
  return "removal";
}

type StoredReceiptRead =
  | { kind: "none" }
  | { kind: "receipt"; receipt: FrequencyMutationReceipt }
  | { kind: "fault"; message: string };

function frequencyReceiptStorageKey(scope: MutationIdentityScope): string {
  return `${FREQUENCY_RECEIPT_STORAGE_PREFIX}${[
    scope.tenantId,
    scope.userId,
    scope.role,
    String(scope.viewerMode),
  ]
    .map(encodeURIComponent)
    .join(":")}`;
}

function readStoredFrequencyReceipt(
  scope: MutationIdentityScope,
): StoredReceiptRead {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return {
        kind: "fault",
        message:
          "Durable recovery storage is unavailable, so frequency-cap mutations are disabled before dispatch.",
      };
    }
    const raw = window.localStorage.getItem(frequencyReceiptStorageKey(scope));
    if (raw === null) return { kind: "none" };
    if (
      new TextEncoder().encode(raw).byteLength > FREQUENCY_RECEIPT_MAX_BYTES
    ) {
      return {
        kind: "fault",
        message:
          "The durable frequency-cap recovery receipt is oversized. Mutations remain disabled until the stored receipt is reviewed.",
      };
    }
    const receipt = parseStoredFrequencyReceipt(JSON.parse(raw));
    if (!receipt || !sameMutationIdentity(receipt, scope)) {
      return {
        kind: "fault",
        message:
          "The durable frequency-cap recovery receipt is invalid or belongs to another identity. Mutations remain disabled until it is reviewed.",
      };
    }
    return { kind: "receipt", receipt };
  } catch {
    return {
      kind: "fault",
      message:
        "Durable recovery storage could not be read. Frequency-cap mutations are disabled before dispatch.",
    };
  }
}

type StoredReceiptMutationResult =
  | { ok: true }
  | { ok: false; message: string };

async function writeStoredFrequencyReceipt(
  receipt: FrequencyMutationReceipt,
): Promise<StoredReceiptMutationResult> {
  return withFrequencyReceiptStorageLock(receipt, () => {
    try {
      if (typeof window === "undefined" || !window.localStorage) {
        throw new Error("storage unavailable");
      }
      const serialized = JSON.stringify(receipt);
      if (
        new TextEncoder().encode(serialized).byteLength >
        FREQUENCY_RECEIPT_MAX_BYTES
      ) {
        throw new Error("receipt too large");
      }
      const key = frequencyReceiptStorageKey(receipt);
      const currentRaw = window.localStorage.getItem(key);
      if (currentRaw !== null) {
        const current = parseStoredReceiptRaw(currentRaw, receipt);
        if (!current) {
          return receiptStorageCollision(
            "The existing durable frequency-cap receipt is invalid or unreadable. It was not overwritten; further dispatch is blocked and any in-flight outcome remains unconfirmed.",
          );
        }
        if (
          current.idempotencyKey !== receipt.idempotencyKey ||
          mutationReceiptRequestFingerprint(current) !==
            mutationReceiptRequestFingerprint(receipt)
        ) {
          return receiptStorageCollision(
            "Another tab already owns a different durable frequency-cap request. It was not overwritten; further dispatch is blocked and any in-flight outcome remains unconfirmed.",
          );
        }
      }
      window.localStorage.setItem(key, serialized);
      const readBack = window.localStorage.getItem(key);
      if (readBack !== serialized) {
        throw new Error("receipt verification failed");
      }
      const parsed = parseStoredFrequencyReceipt(JSON.parse(readBack));
      if (
        !parsed ||
        parsed.idempotencyKey !== receipt.idempotencyKey ||
        !sameMutationIdentity(parsed, receipt) ||
        mutationReceiptRequestFingerprint(parsed) !==
          mutationReceiptRequestFingerprint(receipt)
      ) {
        throw new Error("receipt validation failed");
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        message:
          "The durable recovery receipt could not be stored and verified. Mutation dispatch is blocked; if a request was already in flight, its outcome remains unconfirmed.",
      };
    }
  });
}

async function removeStoredFrequencyReceipt(
  receipt: FrequencyMutationReceipt,
): Promise<StoredReceiptMutationResult> {
  return withFrequencyReceiptStorageLock(receipt, () => {
    try {
      if (typeof window === "undefined" || !window.localStorage) {
        throw new Error("storage unavailable");
      }
      const key = frequencyReceiptStorageKey(receipt);
      const currentRaw = window.localStorage.getItem(key);
      if (currentRaw === null) return { ok: true };
      const current = parseStoredReceiptRaw(currentRaw, receipt);
      if (!current) {
        return receiptStorageCollision(
          "The durable frequency-cap receipt changed into an invalid or unreadable value. It was not removed; further mutations remain disabled.",
        );
      }
      if (
        current.idempotencyKey !== receipt.idempotencyKey ||
        mutationReceiptRequestFingerprint(current) !==
          mutationReceiptRequestFingerprint(receipt)
      ) {
        return receiptStorageCollision(
          "Another tab owns the current durable frequency-cap request. This tab did not remove it; further mutations remain disabled.",
        );
      }
      window.localStorage.removeItem(key);
      if (window.localStorage.getItem(key) !== null) {
        throw new Error("receipt removal failed");
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        message:
          "The confirmed recovery receipt could not be removed. Further frequency-cap mutations remain disabled.",
      };
    }
  });
}

async function withFrequencyReceiptStorageLock(
  scope: MutationIdentityScope,
  operation: () => StoredReceiptMutationResult,
): Promise<StoredReceiptMutationResult> {
  try {
    if (typeof navigator === "undefined" || !navigator.locks) {
      return {
        ok: false,
        message:
          "Cross-tab durable-receipt coordination is unavailable. Frequency-cap mutations are disabled before dispatch.",
      };
    }
    return await navigator.locks.request(
      frequencyReceiptLockName(scope),
      { mode: "exclusive" },
      () => operation(),
    );
  } catch {
    return {
      ok: false,
      message:
        "Cross-tab durable-receipt coordination failed. Further dispatch is disabled and any in-flight outcome remains unconfirmed.",
    };
  }
}

function frequencyReceiptLockName(scope: MutationIdentityScope): string {
  return `postwave:frequency-cap-mutation-lock:v1:${[
    scope.tenantId,
    scope.userId,
    scope.role,
    String(scope.viewerMode),
  ]
    .map(encodeURIComponent)
    .join(":")}`;
}

function parseStoredReceiptRaw(
  raw: string,
  scope: MutationIdentityScope,
): FrequencyMutationReceipt | null {
  try {
    if (
      new TextEncoder().encode(raw).byteLength > FREQUENCY_RECEIPT_MAX_BYTES
    ) {
      return null;
    }
    const parsed = parseStoredFrequencyReceipt(JSON.parse(raw));
    return parsed && sameMutationIdentity(parsed, scope) ? parsed : null;
  } catch {
    return null;
  }
}

function assertStoredFrequencyReceipt(
  receipt: FrequencyMutationReceipt,
): StoredReceiptMutationResult {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      throw new Error("storage unavailable");
    }
    const raw = window.localStorage.getItem(
      frequencyReceiptStorageKey(receipt),
    );
    if (raw === null) {
      return receiptStorageCollision(
        "The retained durable frequency-cap request was removed by another tab. It was not replayed; verify canonical state before making another change.",
      );
    }
    const current = parseStoredReceiptRaw(raw, receipt);
    if (
      !current ||
      current.idempotencyKey !== receipt.idempotencyKey ||
      mutationReceiptRequestFingerprint(current) !==
        mutationReceiptRequestFingerprint(receipt)
    ) {
      return receiptStorageCollision(
        "The retained durable frequency-cap request was replaced or changed by another tab. It was not replayed; verify canonical state before making another change.",
      );
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      message:
        "The retained durable frequency-cap request could not be read and verified. It was not replayed.",
    };
  }
}

function receiptStorageCollision(message: string): StoredReceiptMutationResult {
  return { ok: false, message };
}

function mutationReceiptRequestFingerprint(
  receipt: FrequencyMutationReceipt,
): string {
  const base = {
    kind: receipt.kind,
    tenantId: receipt.tenantId,
    userId: receipt.userId,
    role: receipt.role,
    viewerMode: receipt.viewerMode,
    idempotencyKey: receipt.idempotencyKey,
    createdAtMs: receipt.createdAtMs,
  };
  if (receipt.kind === "create") {
    return JSON.stringify({
      ...base,
      beforeIds: receipt.beforeIds,
      input: receipt.input,
      expected: receipt.expected,
    });
  }
  if (receipt.kind === "update") {
    return JSON.stringify({
      ...base,
      targetId: receipt.targetId,
      expectedUpdatedAt: receipt.expectedUpdatedAt,
      baseline: receipt.baseline,
      input: receipt.input,
      expected: receipt.expected,
    });
  }
  return JSON.stringify({
    ...base,
    targetId: receipt.targetId,
    expectedUpdatedAt: receipt.expectedUpdatedAt,
    baseline: receipt.baseline,
  });
}

function parseStoredFrequencyReceipt(
  value: unknown,
): FrequencyMutationReceipt | null {
  if (!storedRecord(value)) return null;
  const identity = parseStoredIdentity(value);
  if (
    !identity ||
    !storedText(value.idempotencyKey, 128) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value.idempotencyKey,
    ) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    Number(value.createdAtMs) <= 0 ||
    !(
      value.integrityConflict === undefined ||
      typeof value.integrityConflict === "boolean"
    )
  ) {
    return null;
  }
  const response = parseStoredMutationResponse(value.response);
  if (value.response !== undefined && !response) return null;
  const base: MutationReceiptBase = {
    ...identity,
    idempotencyKey: value.idempotencyKey,
    createdAtMs: Number(value.createdAtMs),
    ...(response ? { response } : {}),
    ...(value.integrityConflict === true ? { integrityConflict: true } : {}),
  };
  if (value.kind === "create") {
    const input = parseStoredFrequencyInput(value.input, true);
    const expected = parseStoredExpectedCap(value.expected);
    if (
      !input ||
      !expected ||
      !Array.isArray(value.beforeIds) ||
      value.beforeIds.length > 1_000 ||
      !value.beforeIds.every((id) => storedText(id, 128)) ||
      new Set(value.beforeIds).size !== value.beforeIds.length
    ) {
      return null;
    }
    return {
      ...base,
      kind: "create",
      beforeIds: [...value.beforeIds],
      input,
      expected,
    };
  }
  if (value.kind === "update") {
    const input = parseStoredFrequencyInput(value.input, false);
    const expected = parseStoredExpectedCap(value.expected);
    const baseline = parseStoredCapSnapshot(value.baseline);
    if (
      !input ||
      !expected ||
      !baseline ||
      !storedText(value.targetId, 128) ||
      !storedTimestamp(value.expectedUpdatedAt)
    ) {
      return null;
    }
    return {
      ...base,
      kind: "update",
      targetId: value.targetId,
      expectedUpdatedAt: value.expectedUpdatedAt,
      baseline,
      input,
      expected,
    };
  }
  if (value.kind === "delete") {
    const baseline = parseStoredCapSnapshot(value.baseline);
    if (
      !baseline ||
      !storedText(value.targetId, 128) ||
      !storedTimestamp(value.expectedUpdatedAt)
    ) {
      return null;
    }
    return {
      ...base,
      kind: "delete",
      targetId: value.targetId,
      expectedUpdatedAt: value.expectedUpdatedAt,
      baseline,
    };
  }
  return null;
}

function parseStoredIdentity(
  value: Record<string, unknown>,
): MutationIdentityScope | null {
  if (
    !storedText(value.tenantId, 128) ||
    !storedText(value.userId, 128) ||
    !storedText(value.role, 32) ||
    typeof value.viewerMode !== "boolean"
  ) {
    return null;
  }
  return {
    tenantId: value.tenantId,
    userId: value.userId,
    role: value.role,
    viewerMode: value.viewerMode,
  };
}

function parseStoredFrequencyInput(
  value: unknown,
  requireChannels: boolean,
): FrequencyCapInput | null {
  if (!storedRecord(value)) return null;
  const expected = parseStoredExpectedCap({
    ...value,
    channels: value.channels ?? [],
  });
  if (!expected || (requireChannels && !Array.isArray(value.channels))) {
    return null;
  }
  return {
    label: expected.label,
    max_sends: expected.max_sends,
    window_hours: expected.window_hours,
    active: expected.active,
    ...(Array.isArray(value.channels) ? { channels: expected.channels } : {}),
  };
}

function parseStoredExpectedCap(value: unknown): ExpectedFrequencyCap | null {
  if (
    !storedRecord(value) ||
    !storedText(value.label, 160) ||
    value.label.trim().length === 0 ||
    !Number.isSafeInteger(value.max_sends) ||
    Number(value.max_sends) < 1 ||
    Number(value.max_sends) > 1_000 ||
    !Number.isSafeInteger(value.window_hours) ||
    Number(value.window_hours) < 1 ||
    Number(value.window_hours) > 720 ||
    typeof value.active !== "boolean" ||
    !storedChannels(value.channels)
  ) {
    return null;
  }
  return {
    label: value.label,
    max_sends: Number(value.max_sends),
    window_hours: Number(value.window_hours),
    active: value.active,
    channels: [...value.channels],
  };
}

function parseStoredCapSnapshot(value: unknown): FrequencyCapSnapshot | null {
  const expected = parseStoredExpectedCap(value);
  if (!expected || !storedRecord(value) || !storedTimestamp(value.created_at)) {
    return null;
  }
  return { ...expected, created_at: value.created_at };
}

function parseStoredMutationResponse(
  value: unknown,
): { id: string; updatedAt: string } | null {
  if (value === undefined) return null;
  if (
    !storedRecord(value) ||
    !storedText(value.id, 128) ||
    !storedTimestamp(value.updatedAt)
  ) {
    return null;
  }
  return { id: value.id, updatedAt: value.updatedAt };
}

function storedChannels(value: unknown): value is FrequencyChannel[] {
  return (
    Array.isArray(value) &&
    value.length <= FREQUENCY_CHANNELS.length &&
    new Set(value).size === value.length &&
    value.every(
      (channel) =>
        typeof channel === "string" &&
        (FREQUENCY_CHANNELS as readonly string[]).includes(channel),
    )
  );
}

function storedTimestamp(value: unknown): value is string {
  return (
    storedText(value, 128) &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function storedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function storedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
