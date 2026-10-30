/** Frequency-cap administration for the canonical queue-admission pipeline. */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";

import {
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import {
  type FrequencyCap,
  type FrequencyCapInput,
  frequencyCapsApi,
} from "../../lib/api-client";
import { newUUIDv7 } from "../../lib/http-fetch";
import { useCanAdmin, useMe, useRoleStatus } from "../../lib/store";
import "../../styles-frequency-caps.css";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import { toast } from "../Toast";
import {
  EMPTY_FREQUENCY_CAP_DRAFT,
  FREQUENCY_CAP_CHANNELS,
  FREQUENCY_CAP_LABEL_MAX,
  FREQUENCY_CAP_MAX_SENDS,
  FREQUENCY_CAP_MAX_WINDOW_HOURS,
  firstFrequencyCapDraftError,
  frequencyCapChannelsChanged,
  frequencyCapDraftFromRow,
  frequencyCapDraftInput,
  isFrequencyCap,
  sameFrequencyCapDraft,
  validateFrequencyCapDraft,
  type FrequencyCapChannel,
  type FrequencyCapDraft,
  type FrequencyCapDraftErrors,
} from "./frequency-cap-contract";

export { isFrequencyCap } from "./frequency-cap-contract";

const CHANNEL_LABEL: Record<FrequencyCapChannel, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
};

function emptyDraft(): FrequencyCapDraft {
  return {
    ...EMPTY_FREQUENCY_CAP_DRAFT,
    channels: [...EMPTY_FREQUENCY_CAP_DRAFT.channels],
  };
}

interface UncertainFrequencyMutation {
  owner: string;
  kind: "create" | "update" | "delete";
  beforeIds: string[];
  idempotencyKey: string;
  createdAtMs: number;
  input?: FrequencyCapInput;
  target?: FrequencyCap;
}

interface ExpiredReceiptVerification {
  owner: string;
  idempotencyKey: string;
  requestId: number;
  requestStartedAtMs: number;
  verifiedAtMs: number;
}

type PersistedMutationRead =
  | { kind: "empty" }
  | { kind: "receipt"; receipt: UncertainFrequencyMutation }
  | { kind: "blocked"; message: string };

function sameChannels(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalize = (
    channels: readonly string[] | undefined,
  ): readonly string[] =>
    channels === undefined
      ? ["email"]
      : channels.length === 0
        ? FREQUENCY_CAP_CHANNELS
        : channels;
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((channel) => b.includes(channel));
}

function capMatchesInput(cap: FrequencyCap, input: FrequencyCapInput): boolean {
  return (
    cap.label === input.label &&
    cap.max_sends === input.max_sends &&
    cap.window_hours === input.window_hours &&
    cap.active === input.active &&
    sameChannels(cap.channels, input.channels)
  );
}

function sameCap(left: FrequencyCap, right: FrequencyCap): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.max_sends === right.max_sends &&
    left.window_hours === right.window_hours &&
    left.active === right.active &&
    left.updated_at === right.updated_at &&
    sameChannels(left.channels, right.channels)
  );
}

function ambiguousFrequencyError(error: {
  kind?: string;
  status?: number;
  code?: string;
}): boolean {
  if (error.code === "offline" || error.code === "identity_transition") {
    return false;
  }
  return (
    error.code === "idempotency_key_in_progress" ||
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.kind === "parse" ||
    (error.status ?? 0) >= 500
  );
}

const PENDING_FREQUENCY_MUTATION_PREFIX = "postwave.frequency-cap.pending.v1:";
// Server replay records expire after 24 hours. Stop an hour early so clock
// skew or boundary latency can never turn an exact-key retry into a fresh
// create after the replay record has disappeared.
const FREQUENCY_MUTATION_RETRY_MAX_AGE_MS = 23 * 60 * 60 * 1_000;

function frequencyMutationRetryWindowOpen(
  pending: UncertainFrequencyMutation,
): boolean {
  const age = Date.now() - pending.createdAtMs;
  return age >= 0 && age < FREQUENCY_MUTATION_RETRY_MAX_AGE_MS;
}

function verificationProvesExpiredReceipt(
  verification: ExpiredReceiptVerification | null,
  pending: UncertainFrequencyMutation | null,
): boolean {
  if (!verification || !pending) return false;
  const expiredAtMs = pending.createdAtMs + FREQUENCY_MUTATION_RETRY_MAX_AGE_MS;
  return (
    verification.owner === pending.owner &&
    verification.idempotencyKey === pending.idempotencyKey &&
    verification.requestStartedAtMs >= expiredAtMs &&
    verification.verifiedAtMs >= verification.requestStartedAtMs
  );
}

function pendingStorageKey(owner: string): string {
  return `${PENDING_FREQUENCY_MUTATION_PREFIX}${encodeURIComponent(owner)}`;
}

function isFrequencyCapInput(value: unknown): value is FrequencyCapInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const channels = input.channels;
  if (
    typeof input.label !== "string" ||
    typeof input.max_sends !== "number" ||
    typeof input.window_hours !== "number" ||
    typeof input.active !== "boolean" ||
    !Array.isArray(channels) ||
    channels.length > FREQUENCY_CAP_CHANNELS.length ||
    new Set(channels).size !== channels.length ||
    !channels.every((channel) =>
      FREQUENCY_CAP_CHANNELS.includes(channel as FrequencyCapChannel),
    )
  ) {
    return false;
  }
  return (
    Object.keys(
      validateFrequencyCapDraft({
        label: input.label,
        maxSends: String(input.max_sends),
        windowHours: String(input.window_hours),
        active: input.active,
        channels: channels as FrequencyCapChannel[],
      }),
    ).length === 0
  );
}

function isPersistedMutation(
  value: unknown,
  owner: string,
): value is UncertainFrequencyMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  const kind = pending.kind;
  const beforeIds = pending.beforeIds;
  const key = pending.idempotencyKey;
  if (
    pending.owner !== owner ||
    (kind !== "create" && kind !== "update" && kind !== "delete") ||
    typeof key !== "string" ||
    key.length < 1 ||
    key.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(key) ||
    !Number.isSafeInteger(pending.createdAtMs) ||
    Number(pending.createdAtMs) <= 0 ||
    !Array.isArray(beforeIds) ||
    beforeIds.length > 1_000 ||
    !beforeIds.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 128,
    )
  ) {
    return false;
  }
  const inputValid = isFrequencyCapInput(pending.input);
  const targetValid = isFrequencyCap(pending.target);
  return kind === "create"
    ? inputValid
    : kind === "update"
      ? inputValid && targetValid
      : targetValid;
}

function readPersistedMutation(owner: string): PersistedMutationRead {
  if (typeof window === "undefined") {
    return {
      kind: "blocked",
      message:
        "Durable receipt storage is unavailable. Frequency-cap changes remain blocked.",
    };
  }
  const key = pendingStorageKey(owner);
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return {
      kind: "blocked",
      message:
        "Durable frequency-cap receipt storage could not be read. No receipt was discarded; changes remain blocked until storage access is restored.",
    };
  }
  if (raw === null) return { kind: "empty" };
  if (raw.length > 128 * 1024) {
    return {
      kind: "blocked",
      message:
        "A durable frequency-cap receipt is oversized and cannot be verified. Its bytes were retained; changes remain blocked until the receipt is recovered or safely retired.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: "blocked",
      message:
        "A durable frequency-cap receipt is malformed and cannot be verified. Its bytes were retained; changes remain blocked until the receipt is recovered or safely retired.",
    };
  }
  if (isPersistedMutation(parsed, owner)) {
    return { kind: "receipt", receipt: parsed };
  }
  return {
    kind: "blocked",
    message:
      "A durable frequency-cap receipt belongs to an unverifiable request. Its bytes were retained; changes remain blocked until the receipt is recovered or safely retired.",
  };
}

function persistMutation(pending: UncertainFrequencyMutation): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = pendingStorageKey(pending.owner);
    const serialized = JSON.stringify(pending);
    if (serialized.length > 128 * 1024) return false;
    const existing = window.localStorage.getItem(key);
    if (existing !== null && existing !== serialized) return false;
    window.localStorage.setItem(key, serialized);
    const secured = window.localStorage.getItem(key);
    if (secured !== serialized) return false;
    const parsed: unknown = JSON.parse(secured);
    return isPersistedMutation(parsed, pending.owner);
  } catch {
    return false;
  }
}

function clearPersistedMutation(pending: UncertainFrequencyMutation): boolean {
  if (typeof window === "undefined") return true;
  try {
    const key = pendingStorageKey(pending.owner);
    const expected = JSON.stringify(pending);
    const current = window.localStorage.getItem(key);
    if (current === null) return true;
    if (current !== expected) return false;
    window.localStorage.removeItem(key);
    return window.localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}

const FREQUENCY_RECEIPT_CLEAR_ERROR =
  "The server outcome was checked, but Moosewave could not clear its durable request receipt. Frequency-cap changes remain blocked until local storage is available and the canonical list is verified again.";

function unresolvedFrequencyMutationMessage(
  pending: UncertainFrequencyMutation,
  observation: string,
): string {
  return frequencyMutationRetryWindowOpen(pending)
    ? `${observation} The outcome remains unknown; retry the original request receipt with the same idempotency key or verify again.`
    : `${observation} The exact replay window has expired, so this old receipt will not be dispatched. Verify the canonical list, then accept that verified list before another change.`;
}

function draftFromInput(input: FrequencyCapInput): FrequencyCapDraft {
  return {
    label: input.label,
    maxSends: String(input.max_sends),
    windowHours: String(input.window_hours),
    active: input.active,
    channels: [...(input.channels as FrequencyCapChannel[])],
  };
}

export function FrequencyCapsCard({
  readOnly = false,
}: {
  readOnly?: boolean;
} = {}): ReactElement {
  const canAdmin = useCanAdmin();
  const me = useMe();
  const roleStatus = useRoleStatus();
  const tenant = me?.tenant.trim() ?? "";
  const principal = me?.user.trim() ?? "";
  const recoveryScope = me?.webhookPlaygroundRecoveryScope?.trim() ?? "";
  const canRead =
    roleStatus === "resolved" &&
    tenant.length > 0 &&
    principal.length > 0 &&
    canAdmin;
  // The recovery scope is a SHA-256 namespace over API base, credential
  // provenance, exact principal, and tenant. Role/effective-role stay in the
  // owner too so a preview or authority transition cannot inherit a write.
  const identity = JSON.stringify({
    tenant,
    principal,
    recoveryScope,
    credentialSource: me?.credentialSource ?? "unresolved",
    role: me?.role ?? "unresolved",
    effectiveRole: me?.effectiveRole ?? "unresolved",
    roleStatus,
    canAdmin,
  });
  const hasRecoveryOwner = recoveryScope.length > 0;
  const hasMutationAuthority = canRead && hasRecoveryOwner && !readOnly;
  const [rows, setRows] = useState<FrequencyCap[] | null>(null);
  const [rowsOwner, setRowsOwner] = useState("");
  const visibleRows = rowsOwner === identity ? rows : null;
  const [rowsCanonical, setRowsCanonical] = useState(false);
  const [receiptStorageFault, setReceiptStorageFault] = useState<string | null>(
    null,
  );
  const canMutate = hasMutationAuthority && receiptStorageFault === null;
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<FrequencyCapDraft>(emptyDraft);
  const [draftErrors, setDraftErrors] = useState<FrequencyCapDraftErrors>({});
  const [editTarget, setEditTarget] = useState<FrequencyCap | null>(null);
  const [editDraft, setEditDraft] = useState<FrequencyCapDraft>(emptyDraft);
  const [editErrors, setEditErrors] = useState<FrequencyCapDraftErrors>({});
  const [deleteTarget, setDeleteTarget] = useState<FrequencyCap | null>(null);
  const [discardTarget, setDiscardTarget] = useState<"create" | "edit" | null>(
    null,
  );
  const [uncertainMutation, setUncertainMutation] =
    useState<UncertainFrequencyMutation | null>(null);
  const [expiredReceiptVerification, setExpiredReceiptVerification] =
    useState<ExpiredReceiptVerification | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const hasVerifiedRowsRef = useRef(false);
  const identityRef = useRef(identity);
  const uncertainMutationRef = useRef(uncertainMutation);
  const createKeyRef = useRef<string | null>(null);
  const editKeyRef = useRef<string | null>(null);
  const deleteKeyRef = useRef<string | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  identityRef.current = identity;
  uncertainMutationRef.current = uncertainMutation;
  const titleId = useId();
  const permissionReasonId = useId();
  const operation = useSingleFlightOperation({
    ownerId: "frequency-cap",
    label: "Frequency-cap request",
    detail:
      "Wait for the frequency-cap request to finish before leaving Moosewave.",
  });

  const resetEditors = useCallback((): void => {
    setCreateOpen(false);
    setDraft(emptyDraft());
    setDraftErrors({});
    setEditTarget(null);
    setEditDraft(emptyDraft());
    setEditErrors({});
    setDeleteTarget(null);
    setDiscardTarget(null);
    createKeyRef.current = null;
    editKeyRef.current = null;
    deleteKeyRef.current = null;
  }, []);

  const restoreRecoveredMutation = useCallback(
    (recovered: UncertainFrequencyMutation): void => {
      setExpiredReceiptVerification(null);
      uncertainMutationRef.current = recovered;
      setUncertainMutation(recovered);
      setErr(
        frequencyMutationRetryWindowOpen(recovered)
          ? "Recovered an unresolved request receipt for this exact recovery identity. Verify or retry that exact request before another mutation."
          : "Recovered an unresolved request receipt for this exact recovery identity, but its replay window has expired. The old request will not be dispatched; verify and accept the canonical list before another mutation.",
      );
      if (recovered.kind === "create" && recovered.input) {
        createKeyRef.current = recovered.idempotencyKey;
        setDraft(draftFromInput(recovered.input));
        setCreateOpen(true);
      } else if (
        recovered.kind === "update" &&
        recovered.input &&
        recovered.target
      ) {
        editKeyRef.current = recovered.idempotencyKey;
        setEditTarget(recovered.target);
        setEditDraft(draftFromInput(recovered.input));
      } else if (recovered.target) {
        deleteKeyRef.current = recovered.idempotencyKey;
        setDeleteTarget(recovered.target);
      }
    },
    [],
  );

  const clearUncertainMutation = useCallback(
    (owner?: string, receipt?: UncertainFrequencyMutation): boolean => {
      const pending = receipt ?? uncertainMutationRef.current;
      const persistedOwner = owner ?? pending?.owner;
      if (
        persistedOwner &&
        (!pending ||
          pending.owner !== persistedOwner ||
          !clearPersistedMutation(pending))
      ) {
        if (pending) {
          uncertainMutationRef.current = pending;
          setUncertainMutation(pending);
        }
        setErr(FREQUENCY_RECEIPT_CLEAR_ERROR);
        return false;
      }
      uncertainMutationRef.current = null;
      setUncertainMutation(null);
      setExpiredReceiptVerification(null);
      return true;
    },
    [],
  );

  const reconcileMutation = useCallback(
    (
      pending: UncertainFrequencyMutation,
      verifiedRows: FrequencyCap[],
    ): string | null => {
      if (identityRef.current !== pending.owner) return null;

      if (pending.kind === "create" && pending.input) {
        const priorIds = new Set(pending.beforeIds);
        const matches = verifiedRows.filter(
          (cap) =>
            !priorIds.has(cap.id) && capMatchesInput(cap, pending.input!),
        );
        if (matches.length === 1) {
          if (!clearUncertainMutation(pending.owner, pending)) {
            return FREQUENCY_RECEIPT_CLEAR_ERROR;
          }
          resetEditors();
          toast.success(`Cap "${pending.input.label}" created and verified`);
          return null;
        }
        if (matches.length === 0) {
          return unresolvedFrequencyMutationMessage(
            pending,
            "No matching rule is visible yet.",
          );
        }
        if (!clearUncertainMutation(pending.owner, pending)) {
          return FREQUENCY_RECEIPT_CLEAR_ERROR;
        }
        resetEditors();
        return "Multiple matching rules appeared while the create outcome was unknown. Review the verified list and remove any duplicate before creating another cap.";
      }

      const target = pending.target;
      if (!target) {
        if (!clearUncertainMutation(pending.owner, pending)) {
          return FREQUENCY_RECEIPT_CLEAR_ERROR;
        }
        resetEditors();
        return "The previous mutation could not be reconciled. Review the verified list before another change.";
      }
      const current = verifiedRows.find((cap) => cap.id === target.id);

      if (pending.kind === "update" && pending.input) {
        if (current && capMatchesInput(current, pending.input)) {
          if (!clearUncertainMutation(pending.owner, pending)) {
            return FREQUENCY_RECEIPT_CLEAR_ERROR;
          }
          resetEditors();
          toast.success("Cap update verified");
          return null;
        }
        if (current && sameCap(current, target)) {
          return unresolvedFrequencyMutationMessage(
            pending,
            "No updated revision is visible yet.",
          );
        }
        if (!clearUncertainMutation(pending.owner, pending)) {
          return FREQUENCY_RECEIPT_CLEAR_ERROR;
        }
        resetEditors();
        return current
          ? "This rule changed while the update outcome was unknown. Review the current rule before editing again."
          : "This rule no longer exists. The verified list has been refreshed.";
      }

      if (!current) {
        if (!clearUncertainMutation(pending.owner, pending)) {
          return FREQUENCY_RECEIPT_CLEAR_ERROR;
        }
        deleteKeyRef.current = null;
        setDeleteTarget(null);
        toast.success("Cap deletion verified");
        return null;
      }
      if (sameCap(current, target)) {
        setDeleteTarget(current);
        return unresolvedFrequencyMutationMessage(
          pending,
          "The rule is still visible.",
        );
      }
      if (!clearUncertainMutation(pending.owner, pending)) {
        return FREQUENCY_RECEIPT_CLEAR_ERROR;
      }
      deleteKeyRef.current = null;
      setDeleteTarget(null);
      return "This rule changed while the delete outcome was unknown. Review it before deleting again.";
    },
    [clearUncertainMutation, resetEditors],
  );

  const load = useCallback(async (): Promise<void> => {
    if (!mountedRef.current || !canRead) return;
    const owner = identity;
    const requestId = ++requestIdRef.current;
    const requestStartedAtMs = Date.now();
    // A prior complete list remains useful for display, but it is never proof
    // that an expired durable receipt is safe to retire. Only this exact fresh
    // request may establish that recovery proof.
    setExpiredReceiptVerification(null);
    setLoading(true);
    setErr(null);
    try {
      const res = await frequencyCapsApi.list();
      if (
        !mountedRef.current ||
        requestId !== requestIdRef.current ||
        identityRef.current !== owner
      ) {
        return;
      }
      if (res.error) {
        const missing =
          res.error.status === 404 ||
          /does not exist|not found|404/iu.test(res.error.message || "");
        setErr(
          missing
            ? "The canonical frequency-cap endpoint was not found. No empty state has been assumed."
            : res.error.message || "Frequency caps are unavailable.",
        );
        return;
      }
      const items = res.data?.items;
      if (!Array.isArray(items)) {
        setErr("The server returned invalid frequency-cap data.");
        return;
      }
      const validItems = items.filter(isFrequencyCap);
      const invalidCount = items.length - validItems.length;
      const invalidWarning =
        invalidCount > 0
          ? `${invalidCount} malformed server ${invalidCount === 1 ? "rule was" : "rules were"} omitted. The sending pipeline may still consult ${invalidCount === 1 ? "it" : "them"}; repair the underlying data before relying on this list.`
          : null;
      hasVerifiedRowsRef.current = true;
      setRowsCanonical(invalidCount === 0);
      setRows(validItems);
      setRowsOwner(owner);
      const pending = uncertainMutationRef.current;
      const reconciliation =
        pending && pending.owner === owner && invalidCount === 0
          ? reconcileMutation(pending, validItems)
          : pending && pending.owner === owner
            ? "The server returned an incomplete rule list, so the retained request cannot be reconciled or retired from this response. Repair the malformed rule data and verify again."
            : null;
      const remaining = uncertainMutationRef.current;
      const verifiedAtMs = Date.now();
      if (
        invalidCount === 0 &&
        remaining?.owner === owner &&
        requestStartedAtMs >=
          remaining.createdAtMs + FREQUENCY_MUTATION_RETRY_MAX_AGE_MS
      ) {
        setExpiredReceiptVerification({
          owner,
          idempotencyKey: remaining.idempotencyKey,
          requestId,
          requestStartedAtMs,
          verifiedAtMs,
        });
      }
      setErr(
        [invalidWarning, reconciliation].filter(Boolean).join(" ") || null,
      );
    } catch {
      if (
        mountedRef.current &&
        requestId === requestIdRef.current &&
        identityRef.current === owner
      ) {
        setErr("Moosewave couldn't load frequency caps.");
      }
    } finally {
      if (
        mountedRef.current &&
        requestId === requestIdRef.current &&
        identityRef.current === owner
      ) {
        setLoading(false);
      }
    }
  }, [canRead, identity, reconcileMutation]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    requestIdRef.current += 1;
    hasVerifiedRowsRef.current = false;
    setRows(null);
    setRowsOwner("");
    setRowsCanonical(false);
    setExpiredReceiptVerification(null);
    setReceiptStorageFault(null);
    setErr(null);
    setLoading(canRead);
    uncertainMutationRef.current = null;
    setUncertainMutation(null);
    resetEditors();
    const recovery: PersistedMutationRead = canRead
      ? readPersistedMutation(identity)
      : { kind: "empty" };
    if (recovery.kind === "blocked") {
      setReceiptStorageFault(recovery.message);
      setErr(recovery.message);
    } else if (recovery.kind === "receipt") {
      restoreRecoveredMutation(recovery.receipt);
    }
    if (canRead) void load();
  }, [canRead, identity, load, resetEditors, restoreRecoveredMutation]);

  useEffect(() => {
    if (
      !uncertainMutation ||
      !frequencyMutationRetryWindowOpen(uncertainMutation)
    ) {
      return undefined;
    }
    const elapsed = Date.now() - uncertainMutation.createdAtMs;
    const remaining = Math.max(
      1,
      FREQUENCY_MUTATION_RETRY_MAX_AGE_MS - elapsed + 10,
    );
    const timer = window.setTimeout(() => {
      const current = uncertainMutationRef.current;
      if (
        current?.owner === uncertainMutation.owner &&
        current.idempotencyKey === uncertainMutation.idempotencyKey
      ) {
        setExpiredReceiptVerification(null);
        setUncertainMutation({ ...current });
        // Re-read only after the replay boundary. A list captured before this
        // timer fired can never authorize retirement of the durable receipt.
        void load();
      }
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [load, uncertainMutation]);

  const createDirty = createOpen && !sameFrequencyCapDraft(draft, emptyDraft());
  const editDirty =
    editTarget !== null &&
    !sameFrequencyCapDraft(editDraft, frequencyCapDraftFromRow(editTarget));

  useDiscardOnlyDraftLifecycle({
    ownerId: "frequency-cap-editor",
    label: "Frequency-cap draft",
    dirty: createDirty || editDirty,
    operationRef: operation.promiseRef,
    discard: resetEditors,
    detail: "This frequency-cap draft has unsaved local changes.",
    operationDetail:
      "Wait for the frequency-cap request to finish before leaving Moosewave.",
    enabled: createOpen || editTarget !== null,
  });

  useEffect(() => {
    if (!uncertainMutation) return undefined;
    return registerLifecycleGuard({
      id: `frequency-cap-reconciliation:${identity}`,
      label: "Frequency-cap reconciliation",
      inspect: () => ({
        level: "blocking",
        detail:
          "Refresh and reconcile the unknown frequency-cap outcome before leaving this workspace.",
        canSave: false,
        canDiscard: false,
        canRecover: false,
      }),
    });
  }, [identity, uncertainMutation]);

  const cancelPendingLoad = (): void => {
    requestIdRef.current += 1;
    setExpiredReceiptVerification(null);
    setLoading(false);
  };

  const reconcileUnknownMutation = async (
    pending: UncertainFrequencyMutation,
  ): Promise<void> => {
    // This was already persisted before dispatch. Rewriting keeps the stored
    // receipt canonical if a future migration adds fields; failure here does
    // not erase the successfully secured pre-dispatch copy.
    persistMutation(pending);
    uncertainMutationRef.current = pending;
    setUncertainMutation(pending);
    setErr(
      "The request outcome is unknown. Moosewave is verifying the canonical rule list before another mutation is allowed.",
    );
    await load();
  };

  const openCreate = (): void => {
    if (!canMutate) return;
    createKeyRef.current = null;
    setDraft(emptyDraft());
    setDraftErrors({});
    setCreateOpen(true);
  };

  const openEdit = (cap: FrequencyCap): void => {
    if (!canMutate) return;
    editReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    editKeyRef.current = null;
    setEditTarget(cap);
    setEditDraft(frequencyCapDraftFromRow(cap));
    setEditErrors({});
  };

  const requestCreateClose = (): void => {
    if (operation.promiseRef.current || uncertainMutationRef.current) return;
    if (createDirty) setDiscardTarget("create");
    else resetEditors();
  };

  const requestEditClose = (): void => {
    if (operation.promiseRef.current || uncertainMutationRef.current) return;
    if (editDirty) setDiscardTarget("edit");
    else resetEditors();
  };

  const submitCreate = async (): Promise<void> => {
    if (!canMutate) return;
    if (
      uncertainMutationRef.current &&
      !frequencyMutationRetryWindowOpen(uncertainMutationRef.current)
    ) {
      setErr(
        "The exact replay window has expired. This old receipt will not be dispatched; verify and accept the canonical list before another change.",
      );
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const errors = validateFrequencyCapDraft(draft);
    const firstError = firstFrequencyCapDraftError(errors);
    if (firstError) {
      setDraftErrors(errors);
      toast.error(firstError);
      return;
    }
    const owner = identity;
    const input = frequencyCapDraftInput(draft);
    const idempotencyKey = createKeyRef.current ?? newUUIDv7();
    createKeyRef.current = idempotencyKey;
    const retained = uncertainMutationRef.current;
    const pending: UncertainFrequencyMutation =
      retained?.owner === owner &&
      retained.kind === "create" &&
      retained.idempotencyKey === idempotencyKey
        ? retained
        : {
            owner,
            kind: "create",
            beforeIds: (visibleRows ?? []).map((cap) => cap.id),
            idempotencyKey,
            createdAtMs: Date.now(),
            input,
          };
    if (!persistMutation(pending)) {
      toast.error({
        message: "Couldn't secure retry receipt",
        detail:
          "No request was sent. Restore local storage access, then try again.",
      });
      return;
    }
    const request = operation.run(async (): Promise<void> => {
      cancelPendingLoad();
      try {
        const res = await frequencyCapsApi.create(input, { idempotencyKey });
        if (!mountedRef.current || identityRef.current !== owner) return;
        if (res.error) {
          if (ambiguousFrequencyError(res.error)) {
            await reconcileUnknownMutation(pending);
            return;
          }
          toast.error({
            message: "Couldn't create cap",
            detail: res.error.message,
          });
          if (!clearUncertainMutation(owner, pending)) {
            void load();
            return;
          }
          createKeyRef.current = null;
          return;
        }
        const priorIds = new Set(pending.beforeIds);
        if (
          !isFrequencyCap(res.data) ||
          priorIds.has(res.data.id) ||
          !capMatchesInput(res.data, input)
        ) {
          await reconcileUnknownMutation(pending);
          return;
        }
        hasVerifiedRowsRef.current = true;
        setRows((current) => [...(current ?? []), res.data!]);
        if (!clearUncertainMutation(owner, pending)) {
          void load();
          return;
        }
        resetEditors();
        toast.success(`Cap "${input.label}" created`);
        void load();
      } catch {
        if (mountedRef.current && identityRef.current === owner) {
          await reconcileUnknownMutation(pending);
        }
      }
    });
    if (request) await request;
  };

  const submitEdit = async (): Promise<void> => {
    if (!canMutate || !editTarget) return;
    if (
      uncertainMutationRef.current &&
      !frequencyMutationRetryWindowOpen(uncertainMutationRef.current)
    ) {
      setErr(
        "The exact replay window has expired. This old receipt will not be dispatched; verify and accept the canonical list before another change.",
      );
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const errors = validateFrequencyCapDraft(editDraft);
    const firstError = firstFrequencyCapDraftError(errors);
    if (firstError) {
      setEditErrors(errors);
      toast.error(firstError);
      return;
    }
    const owner = identity;
    const target = editTarget;
    const input = frequencyCapDraftInput(editDraft);
    const idempotencyKey = editKeyRef.current ?? newUUIDv7();
    editKeyRef.current = idempotencyKey;
    const update: Partial<FrequencyCapInput> = {
      label: input.label,
      max_sends: input.max_sends,
      window_hours: input.window_hours,
      active: input.active,
      ...(frequencyCapChannelsChanged(target, editDraft.channels)
        ? { channels: input.channels }
        : {}),
    };
    const retained = uncertainMutationRef.current;
    const pending: UncertainFrequencyMutation =
      retained?.owner === owner &&
      retained.kind === "update" &&
      retained.idempotencyKey === idempotencyKey
        ? retained
        : {
            owner,
            kind: "update",
            beforeIds: (visibleRows ?? []).map((cap) => cap.id),
            idempotencyKey,
            createdAtMs: Date.now(),
            input,
            target,
          };
    if (!persistMutation(pending)) {
      toast.error({
        message: "Couldn't secure retry receipt",
        detail:
          "No request was sent. Restore local storage access, then try again.",
      });
      return;
    }
    const request = operation.run(async (): Promise<void> => {
      cancelPendingLoad();
      try {
        const res = await frequencyCapsApi.update(
          target.id,
          update,
          target.updated_at,
          { idempotencyKey },
        );
        if (!mountedRef.current || identityRef.current !== owner) return;
        if (res.error) {
          if (ambiguousFrequencyError(res.error)) {
            await reconcileUnknownMutation(pending);
            return;
          }
          toast.error({
            message: "Couldn't update cap",
            detail: res.error.message,
          });
          if (!clearUncertainMutation(owner, pending)) {
            void load();
            return;
          }
          editKeyRef.current = null;
          return;
        }
        if (
          !isFrequencyCap(res.data) ||
          res.data.id !== target.id ||
          res.data.updated_at === target.updated_at ||
          !capMatchesInput(res.data, input)
        ) {
          await reconcileUnknownMutation(pending);
          return;
        }
        setRows(
          (current) =>
            current?.map((cap) => (cap.id === target.id ? res.data! : cap)) ??
            null,
        );
        if (!clearUncertainMutation(owner, pending)) {
          void load();
          return;
        }
        resetEditors();
        toast.success("Cap updated");
        void load();
      } catch {
        if (mountedRef.current && identityRef.current === owner) {
          await reconcileUnknownMutation(pending);
        }
      }
    });
    if (request) await request;
  };

  const submitDelete = async (): Promise<void> => {
    if (!canMutate || !deleteTarget) return;
    if (
      uncertainMutationRef.current &&
      !frequencyMutationRetryWindowOpen(uncertainMutationRef.current)
    ) {
      setErr(
        "The exact replay window has expired. This old receipt will not be dispatched; verify and accept the canonical list before another change.",
      );
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const owner = identity;
    const target = deleteTarget;
    const idempotencyKey = deleteKeyRef.current ?? newUUIDv7();
    deleteKeyRef.current = idempotencyKey;
    const retained = uncertainMutationRef.current;
    const pending: UncertainFrequencyMutation =
      retained?.owner === owner &&
      retained.kind === "delete" &&
      retained.idempotencyKey === idempotencyKey
        ? retained
        : {
            owner,
            kind: "delete",
            beforeIds: (visibleRows ?? []).map((cap) => cap.id),
            idempotencyKey,
            createdAtMs: Date.now(),
            target,
          };
    if (!persistMutation(pending)) {
      toast.error({
        message: "Couldn't secure retry receipt",
        detail:
          "No request was sent. Restore local storage access, then try again.",
      });
      return;
    }
    const request = operation.run(async (): Promise<void> => {
      cancelPendingLoad();
      try {
        const res = await frequencyCapsApi.remove(
          target.id,
          target.updated_at,
          { idempotencyKey },
        );
        if (!mountedRef.current || identityRef.current !== owner) return;
        if (res.error) {
          if (ambiguousFrequencyError(res.error)) {
            await reconcileUnknownMutation(pending);
            return;
          }
          toast.error({
            message: "Couldn't delete cap",
            detail: res.error.message,
          });
          if (!clearUncertainMutation(owner, pending)) {
            void load();
            return;
          }
          deleteKeyRef.current = null;
          return;
        }
        // DELETE is canonically 204 No Content. HTTP success is the receipt;
        // requiring a fabricated `{ok:true}` body would turn success into error.
        setRows(
          (current) => current?.filter((cap) => cap.id !== target.id) ?? null,
        );
        if (!clearUncertainMutation(owner, pending)) {
          void load();
          return;
        }
        setDeleteTarget(null);
        deleteKeyRef.current = null;
        toast.success("Cap deleted");
        void load();
      } catch {
        if (mountedRef.current && identityRef.current === owner) {
          await reconcileUnknownMutation(pending);
        }
      }
    });
    if (request) await request;
  };

  const retryUncertainMutation = (): void => {
    if (!uncertainMutation || operation.active || loading) return;
    if (!frequencyMutationRetryWindowOpen(uncertainMutation)) {
      setErr(
        "The exact replay window has expired. This old receipt will not be dispatched; verify and accept the canonical list before another change.",
      );
      toast.error({
        message: "Retry window expired",
        detail:
          "No request was sent. Verify the canonical list and accept it to retire this receipt.",
      });
      return;
    }
    if (uncertainMutation.kind === "create") {
      void submitCreate();
    } else if (uncertainMutation.kind === "update") {
      void submitEdit();
    } else {
      void submitDelete();
    }
  };

  const recheckReceiptStorage = (): void => {
    const recovery = readPersistedMutation(identity);
    if (recovery.kind === "blocked") {
      setReceiptStorageFault(recovery.message);
      setErr(recovery.message);
      return;
    }
    setReceiptStorageFault(null);
    resetEditors();
    uncertainMutationRef.current = null;
    setUncertainMutation(null);
    if (recovery.kind === "receipt") {
      restoreRecoveredMutation(recovery.receipt);
    } else {
      setErr(null);
    }
    void load();
  };

  const expiredReceiptVerified = verificationProvesExpiredReceipt(
    expiredReceiptVerification,
    uncertainMutation,
  );

  const acceptExpiredVerifiedList = (): void => {
    const pending = uncertainMutationRef.current;
    if (
      !pending ||
      frequencyMutationRetryWindowOpen(pending) ||
      operation.active ||
      loading ||
      visibleRows === null ||
      !hasVerifiedRowsRef.current ||
      !rowsCanonical ||
      !verificationProvesExpiredReceipt(expiredReceiptVerification, pending)
    ) {
      return;
    }
    if (!clearUncertainMutation(pending.owner, pending)) {
      toast.error({
        message: "Couldn't retire request receipt",
        detail:
          "Local storage is unavailable. The verified receipt remains blocked and no request was sent.",
      });
      return;
    }
    resetEditors();
    setErr(null);
    toast.success(
      "Verified frequency-cap list accepted; the expired request was not replayed",
    );
    void load();
  };

  const uncertainRetryOpen =
    uncertainMutation !== null &&
    frequencyMutationRetryWindowOpen(uncertainMutation);

  const actionsUnavailable =
    operation.active ||
    uncertainMutation !== null ||
    loading ||
    visibleRows === null ||
    !rowsCanonical ||
    editTarget !== null ||
    createOpen;

  return (
    <section className="card frequency-caps-card" aria-labelledby={titleId}>
      <header className="frequency-caps-card__header">
        <div>
          <h2 id={titleId}>Frequency caps</h2>
          <p>Subscriber limits checked during queue admission</p>
        </div>
        <div className="frequency-caps-card__header-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void load()}
            disabled={!canRead || loading || operation.active}
          >
            Refresh caps
          </button>
          {!readOnly ? (
            <button
              ref={createTriggerRef}
              type="button"
              className="btn btn-sm btn-primary"
              onClick={openCreate}
              disabled={!canMutate || actionsUnavailable}
              aria-disabled={!canMutate || undefined}
              aria-describedby={!canMutate ? permissionReasonId : undefined}
            >
              New cap
            </button>
          ) : null}
        </div>
      </header>

      {readOnly || !canMutate || (visibleRows !== null && !rowsCanonical) ? (
        <p
          id={permissionReasonId}
          className="frequency-caps-card__readonly"
          role="note"
        >
          {readOnly
            ? "Demo data is read-only. Frequency caps can be reviewed here, but add, edit, and delete actions are unavailable."
            : receiptStorageFault
              ? "Read-only access. A durable request receipt cannot be verified; its bytes are retained and all changes remain blocked."
              : canRead && visibleRows !== null && !rowsCanonical
                ? "Read-only access. The server returned an incomplete frequency-cap list, so changes remain blocked until every rule can be verified."
                : canRead && !hasRecoveryOwner
                  ? "Read-only access. A verified recovery identity is required before frequency-cap changes can be secured and replayed safely."
                  : "Read-only access. An owner or admin role is required to create, edit, or delete frequency caps."}
        </p>
      ) : null}

      {(receiptStorageFault || err) && !uncertainMutation ? (
        <div className="frequency-caps-card__error" role="alert">
          <span>
            {hasVerifiedRowsRef.current
              ? `${receiptStorageFault ?? err} ${
                  rowsCanonical
                    ? "Showing the last verified complete rule list."
                    : "Showing only the readable rule subset; mutations remain blocked."
                }`
              : (receiptStorageFault ?? err)}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              receiptStorageFault ? recheckReceiptStorage() : void load()
            }
            disabled={loading}
          >
            {receiptStorageFault ? "Recheck receipt storage" : "Retry"}
          </button>
        </div>
      ) : null}

      {uncertainMutation ? (
        <div className="frequency-caps-card__error" role="alert">
          <span>
            <strong>Outcome unknown.</strong> {err ? `${err} ` : ""}The original
            request receipt is retained until a verified response resolves it.
          </span>
          <span className="frequency-caps-card__recovery-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load()}
              disabled={loading || operation.active}
            >
              {loading ? "Verifying…" : "Verify outcome"}
            </button>
            {uncertainRetryOpen ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={retryUncertainMutation}
                disabled={loading || operation.active}
              >
                Retry original request
              </button>
            ) : visibleRows !== null &&
              hasVerifiedRowsRef.current &&
              rowsCanonical &&
              expiredReceiptVerified ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={acceptExpiredVerifiedList}
                disabled={loading || operation.active}
              >
                Accept verified list
              </button>
            ) : null}
          </span>
        </div>
      ) : null}

      <FrequencyCapsTable
        rows={visibleRows}
        loading={loading}
        error={err}
        canMutate={canMutate}
        readOnly={readOnly}
        actionsUnavailable={actionsUnavailable}
        permissionReasonId={permissionReasonId}
        onEdit={openEdit}
        onDelete={(cap) => {
          deleteReturnFocusRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          deleteKeyRef.current = null;
          setDeleteTarget(cap);
        }}
      />

      <Modal
        open={createOpen}
        onClose={requestCreateClose}
        closeDisabled={operation.active || uncertainMutation !== null}
        closeOnBackdrop={!operation.active && uncertainMutation === null}
        closeOnEscape={!operation.active && uncertainMutation === null}
        title="New frequency cap"
        description="Caps are evaluated during queue admission. In an otherwise admitted campaign, eligible cap-skipped email recipients can enter intelligent retry for a later admission check; SMS and push recipients remain withheld."
        returnFocusRef={createTriggerRef}
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
        >
          <FrequencyCapDraftFields
            draft={draft}
            errors={draftErrors}
            disabled={
              operation.active || uncertainMutation !== null || !canMutate
            }
            onChange={(next) => {
              createKeyRef.current = null;
              setDraft(next);
              if (Object.keys(draftErrors).length > 0) {
                setDraftErrors(validateFrequencyCapDraft(next));
              }
            }}
          />
          <ModalFooter>
            <button
              type="button"
              className="btn"
              onClick={requestCreateClose}
              disabled={operation.active || uncertainMutation !== null}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                operation.active || uncertainMutation !== null || !canMutate
              }
            >
              {operation.active ? "Creating…" : "Create cap"}
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal
        open={editTarget !== null}
        onClose={requestEditClose}
        closeDisabled={operation.active || uncertainMutation !== null}
        closeOnBackdrop={!operation.active && uncertainMutation === null}
        closeOnEscape={!operation.active && uncertainMutation === null}
        title="Edit frequency cap"
        returnFocusRef={editReturnFocusRef}
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitEdit();
          }}
        >
          <FrequencyCapDraftFields
            draft={editDraft}
            errors={editErrors}
            disabled={
              operation.active || uncertainMutation !== null || !canMutate
            }
            legacyGlobal={editTarget?.channels?.length === 0}
            onChange={(next) => {
              editKeyRef.current = null;
              setEditDraft(next);
              if (Object.keys(editErrors).length > 0) {
                setEditErrors(validateFrequencyCapDraft(next));
              }
            }}
          />
          <ModalFooter>
            <button
              type="button"
              className="btn"
              onClick={requestEditClose}
              disabled={operation.active || uncertainMutation !== null}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                operation.active || uncertainMutation !== null || !canMutate
              }
            >
              {operation.active ? "Saving…" : "Save changes"}
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <ConfirmModal
        open={discardTarget !== null}
        title="Discard frequency-cap draft?"
        description="Your unsaved frequency-cap changes will be cleared."
        confirmLabel="Discard draft"
        danger
        onClose={() => setDiscardTarget(null)}
        onConfirm={resetEditors}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete cap"
        description={
          deleteTarget
            ? `Delete “${deleteTarget.label}”? Future queue fills will no longer consult this rule.`
            : ""
        }
        confirmLabel="Delete cap"
        danger
        busy={operation.active}
        confirmDisabled={uncertainMutation !== null}
        returnFocusRef={deleteReturnFocusRef}
        onClose={() => {
          if (!operation.promiseRef.current && !uncertainMutationRef.current) {
            setDeleteTarget(null);
          }
        }}
        onConfirm={submitDelete}
      />
    </section>
  );
}

function FrequencyCapsTable({
  rows,
  loading,
  error,
  canMutate,
  readOnly,
  actionsUnavailable,
  permissionReasonId,
  onEdit,
  onDelete,
}: {
  rows: FrequencyCap[] | null;
  loading: boolean;
  error: string | null;
  canMutate: boolean;
  readOnly: boolean;
  actionsUnavailable: boolean;
  permissionReasonId: string;
  onEdit: (cap: FrequencyCap) => void;
  onDelete: (cap: FrequencyCap) => void;
}): ReactElement {
  const columns: readonly DataTableColumn<FrequencyCap>[] = [
    {
      id: "label",
      header: "Label",
      className: "frequency-cap-cell frequency-cap-cell--label",
      cell: (cap) => <strong>{cap.label}</strong>,
    },
    {
      id: "limit",
      header: "Limit",
      className: "frequency-cap-cell frequency-cap-cell--limit",
      cell: (cap) => (
        <span className="tabular">
          {cap.max_sends.toLocaleString()} per{" "}
          {cap.window_hours.toLocaleString()}h
        </span>
      ),
    },
    {
      id: "channels",
      header: "Channels",
      className: "frequency-cap-cell frequency-cap-cell--channels",
      cell: (cap) => (
        <span className="frequency-cap-channels">
          {cap.channels?.length === 0 ? (
            <span className="badge">All channels</span>
          ) : (
            (cap.channels ?? ["email"]).map((channel) => (
              <span key={channel} className="badge">
                {CHANNEL_LABEL[channel as FrequencyCapChannel]}
              </span>
            ))
          )}
        </span>
      ),
    },
    {
      id: "state",
      header: "State",
      className: "frequency-cap-cell frequency-cap-cell--state",
      cell: (cap) => (
        <span className={cap.active ? "badge success" : "badge"}>
          {cap.active ? "On" : "Off"}
        </span>
      ),
    },
    ...(!readOnly
      ? [
          {
            id: "actions",
            header: <span className="visually-hidden">Actions</span>,
            align: "end",
            className: "frequency-cap-cell frequency-cap-cell--actions",
            cell: (cap) => (
              <span className="frequency-cap-row-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (!canMutate) return;
                    onEdit(cap);
                  }}
                  disabled={!canMutate || actionsUnavailable}
                  aria-disabled={!canMutate || undefined}
                  aria-describedby={!canMutate ? permissionReasonId : undefined}
                  aria-label={`Edit ${cap.label}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (!canMutate) return;
                    onDelete(cap);
                  }}
                  disabled={!canMutate || actionsUnavailable}
                  aria-disabled={!canMutate || undefined}
                  aria-describedby={!canMutate ? permissionReasonId : undefined}
                  aria-label={`Delete ${cap.label}`}
                >
                  Delete
                </button>
              </span>
            ),
          } satisfies DataTableColumn<FrequencyCap>,
        ]
      : []),
  ];
  return (
    <DataTable
      className="frequency-caps-table"
      caption="Configured frequency caps"
      description={
        loading && rows !== null
          ? "Refreshing · showing the last verified rules"
          : error && rows !== null
            ? "Attention required · showing the last verified rules"
            : "Per-subscriber limits across the selected channels"
      }
      columns={columns}
      rows={rows ?? []}
      getRowKey={(cap) => cap.id}
      loading={loading && rows === null}
      loadingLabel="Loading frequency caps…"
      emptyState={
        error
          ? "Frequency caps are unavailable. Retry to verify the current rules."
          : "No frequency caps configured. The send pipeline applies no tenant-level cap from this rule set."
      }
      density="compact"
    />
  );
}

function FrequencyCapDraftFields({
  draft,
  errors,
  disabled,
  legacyGlobal = false,
  onChange,
}: {
  draft: FrequencyCapDraft;
  errors: FrequencyCapDraftErrors;
  disabled: boolean;
  legacyGlobal?: boolean;
  onChange: (next: FrequencyCapDraft) => void;
}): ReactElement {
  const id = useId();
  const channelsErrorId = `${id}-channels-error`;
  return (
    <div className="frequency-cap-editor">
      {legacyGlobal ? (
        <p className="frequency-cap-editor__legacy" role="note">
          This legacy rule applies to all channels. Leaving all channels
          selected preserves that global scope.
        </p>
      ) : null}
      <FormField
        label="Label"
        htmlFor={`${id}-label`}
        required
        error={errors.label}
      >
        <input
          id={`${id}-label`}
          className="input"
          maxLength={FREQUENCY_CAP_LABEL_MAX}
          placeholder="Marketing — daily limit"
          value={draft.label}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, label: event.currentTarget.value })
          }
        />
      </FormField>
      <div className="frequency-cap-editor__numbers">
        <FormField
          label="Maximum sends"
          htmlFor={`${id}-max`}
          required
          error={errors.maxSends}
        >
          <input
            id={`${id}-max`}
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={FREQUENCY_CAP_MAX_SENDS}
            step={1}
            value={draft.maxSends}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, maxSends: event.currentTarget.value })
            }
          />
        </FormField>
        <FormField
          label="Window (hours)"
          htmlFor={`${id}-window`}
          required
          error={errors.windowHours}
        >
          <input
            id={`${id}-window`}
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={FREQUENCY_CAP_MAX_WINDOW_HOURS}
            step={1}
            value={draft.windowHours}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, windowHours: event.currentTarget.value })
            }
          />
        </FormField>
      </div>
      <fieldset
        className="frequency-cap-editor__channels"
        aria-invalid={errors.channels ? "true" : undefined}
        aria-describedby={errors.channels ? channelsErrorId : undefined}
      >
        <legend>Shared cap channels</legend>
        <p>
          A send on any selected channel counts toward one shared threshold.
        </p>
        <div>
          {FREQUENCY_CAP_CHANNELS.map((channel) => (
            <label key={channel}>
              <input
                type="checkbox"
                checked={draft.channels.includes(channel)}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    channels: event.currentTarget.checked
                      ? [...draft.channels, channel]
                      : draft.channels.filter((item) => item !== channel),
                  })
                }
              />
              <span>{CHANNEL_LABEL[channel]}</span>
            </label>
          ))}
        </div>
        {errors.channels ? (
          <p id={channelsErrorId} className="field-v2-error" role="alert">
            {errors.channels}
          </p>
        ) : null}
      </fieldset>
      <label className="frequency-cap-editor__active" htmlFor={`${id}-active`}>
        <input
          id={`${id}-active`}
          type="checkbox"
          checked={draft.active}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, active: event.currentTarget.checked })
          }
        />
        <span>
          Enabled
          <small>Active rules are consulted during queue admission.</small>
        </span>
      </label>
    </div>
  );
}
