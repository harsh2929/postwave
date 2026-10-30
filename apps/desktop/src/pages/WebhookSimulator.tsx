/**
 * WebhookSimulator — pick an outbound webhook, pick an event type,
 * edit the payload, fire it.
 *
 * Layout:
 *   Top: webhook + event selectors + Fire button + Verify-signature link.
 *   Two-column body:
 *     • Left  — payload editor (textarea) and ResponseInspector below
 *               (body / headers / curl tabs + retry schedule on failure).
 *     • Right — SavedPayloadsPanel + RecentFiresPanel.
 *
 * Backend: /api/v1/outbound-webhooks/playground/events (catalog) +
 * /api/v1/outbound-webhooks/{id}/playground/fire (the actual send).
 */

import {
  type MutableRefObject,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { type RecentFire } from "../components/webhook-simulator/RecentFiresPanel";
import {
  sanitizeInspectableUrl,
  type FireResponse,
} from "../components/webhook-simulator/ResponseInspector";
import { toast } from "../components/Toast";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import {
  type OutboundWebhook,
  api,
  getApiUrl,
  listOutboundWebhooks,
} from "../lib/api-client";
import { captureApiIdentityGeneration } from "../lib/api-identity-transition";
import {
  registerLifecycleGuard,
  signalLifecycleOwnerChanged,
} from "../lib/lifecycle-coordinator";
import { useCanAdmin, useMe } from "../lib/store";
import {
  createWebhookPlaygroundFireRecoveryAuthority,
  webhookPlaygroundFireRecovery,
  type WebhookPlaygroundFireSnapshot,
} from "../lib/webhook-playground-fire-recovery";
import { tryAcquireWebhookPlaygroundFireOperationLease } from "../lib/webhook-playground-fire-operation";
import {
  MAX_RECENT_FIRES,
  SimulatorDialogs,
  SimulatorIntro,
  SimulatorWorkspace,
  type EventCatalogEntry,
  type FireReconciliation,
  type FireSnapshot,
  type PayloadReplacement,
  webhookFireReadinessReason,
} from "./webhook-simulator-surface";
import {
  SIMULATOR_TARGET_PAGE_SIZE,
  type FireRecoveryGate,
  type SimulatorFireDisposition,
  type SimulatorFireError,
  eventSampleReplacement,
  fireErrorHasAmbiguousDispatch,
  fireErrorClaimsExpiredIdentity,
  fireErrorProvesExpiredIdentity,
  fireSnapshotFromRecovery,
  isPlaceholderSample,
  playgroundReceiptMatchesSnapshot,
  recentFireReplacement,
  recoveryAuthorityKey,
  recoveryHoldDetail,
  recoverySnapshotFromFire,
  savedPayloadReplacement,
  simulatorFireSnapshot,
  validateSimulatorPayload,
} from "./webhook-simulator-model";
import "../styles-api-playground-shared.css";
import "../styles-mcp.css";
import "../styles-webhook-simulator.css";
import "../styles-webhooks.css";

function useSimulatorCatalogLoader(
  onLoaded: (webhooks: OutboundWebhook[], events: EventCatalogEntry[]) => void,
  onAppended: (webhooks: OutboundWebhook[]) => void,
): {
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  moreError: string | null;
  nextCursor: string;
  activeRef: MutableRefObject<boolean>;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
} {
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState("");
  const activeRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const loadFlightRef = useRef<Promise<void> | null>(null);
  const loadMoreFlightRef = useRef<Promise<void> | null>(null);
  const nextCursorRef = useRef("");
  nextCursorRef.current = nextCursor;

  const load = useCallback((): Promise<void> => {
    if (loadFlightRef.current) return loadFlightRef.current;
    const requestId = ++loadSequenceRef.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    loadMoreFlightRef.current = null;
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const [webhookResponse, eventResponse] = await Promise.all([
          listOutboundWebhooks({ limit: SIMULATOR_TARGET_PAGE_SIZE }),
          api.listWebhookPlaygroundEvents(),
        ]);
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        if (webhookResponse.error) {
          setError(webhookResponse.error.message);
          return;
        }
        if (eventResponse.error) {
          setError(eventResponse.error.message);
          return;
        }
        onLoaded(
          webhookResponse.data?.webhooks ?? [],
          eventResponse.data?.events ?? [],
        );
        setNextCursor(webhookResponse.data?.next_cursor ?? "");
      } catch (caught) {
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        setError(
          lifecycleOperationError(
            caught,
            "The simulator catalog couldn't be loaded. Check your connection and try again.",
          ),
        );
      } finally {
        if (activeRef.current && requestId === loadSequenceRef.current) {
          setLoading(false);
        }
        if (requestId === loadSequenceRef.current) loadFlightRef.current = null;
      }
    })();
    loadFlightRef.current = request;
    return request;
  }, [onLoaded]);

  const loadMore = useCallback((): Promise<void> => {
    if (loadFlightRef.current) return loadFlightRef.current;
    if (loadMoreFlightRef.current) return loadMoreFlightRef.current;
    const cursor = nextCursorRef.current;
    if (!cursor) return Promise.resolve();
    const requestId = loadSequenceRef.current;
    setLoadingMore(true);
    setMoreError(null);
    const request = (async (): Promise<void> => {
      try {
        const response = await listOutboundWebhooks({
          limit: SIMULATOR_TARGET_PAGE_SIZE,
          cursor,
        });
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        if (response.error) {
          setMoreError(response.error.message);
          return;
        }
        const followingCursor = response.data?.next_cursor ?? "";
        if (followingCursor && followingCursor === cursor) {
          setMoreError(
            "The server repeated the same target cursor. Loading stopped to prevent a loop.",
          );
          setNextCursor("");
          return;
        }
        onAppended(response.data?.webhooks ?? []);
        setNextCursor(followingCursor);
      } catch (caught) {
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        setMoreError(
          lifecycleOperationError(
            caught,
            "Older webhook targets couldn't be loaded. Check your connection and try again.",
          ),
        );
      } finally {
        if (activeRef.current && requestId === loadSequenceRef.current) {
          setLoadingMore(false);
        }
      }
    })();
    loadMoreFlightRef.current = request;
    void request.finally(() => {
      if (loadMoreFlightRef.current === request) {
        loadMoreFlightRef.current = null;
      }
    });
    return request;
  }, [onAppended]);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
      loadSequenceRef.current += 1;
      loadFlightRef.current = null;
      loadMoreFlightRef.current = null;
    };
  }, [load]);

  return {
    loading,
    loadingMore,
    error,
    moreError,
    nextCursor,
    activeRef,
    load,
    loadMore,
  };
}

function useSimulatorCatalogState({
  operation,
  onResetResponse,
  onStatus,
}: {
  operation: ReturnType<typeof useSingleFlightOperation>;
  onResetResponse: () => void;
  onStatus: (status: string) => void;
}): {
  webhooks: OutboundWebhook[];
  events: EventCatalogEntry[];
  webhookID: string;
  eventType: string;
  payload: string;
  payloadBaselineRef: MutableRefObject<string>;
  setWebhookID: (id: string) => void;
  setEventType: (eventType: string) => void;
  setPayload: (payload: string) => void;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  moreError: string | null;
  nextCursor: string;
  activeRef: MutableRefObject<boolean>;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
} {
  const [webhooks, setWebhooks] = useState<OutboundWebhook[]>([]);
  const [events, setEvents] = useState<EventCatalogEntry[]>([]);
  const [webhookID, setWebhookID] = useState("");
  const [eventType, setEventType] = useState("");
  const [payload, setPayload] = useState("");
  const payloadBaselineRef = useRef("");
  const webhookIDRef = useRef("");
  const eventTypeRef = useRef("");
  webhookIDRef.current = webhookID;
  eventTypeRef.current = eventType;

  const discardPayloadDraft = useCallback((): void => {
    setPayload(payloadBaselineRef.current);
    onResetResponse();
  }, [onResetResponse]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "webhook-simulator-payload",
    label: "Webhook simulator payload draft",
    dirty: payload !== payloadBaselineRef.current,
    operationRef: operation.promiseRef,
    discard: discardPayloadDraft,
    detail:
      "The webhook simulator JSON has edits that are not in the saved payload library.",
  });

  const handleLoaded = useCallback(
    (
      nextWebhooks: OutboundWebhook[],
      nextEvents: EventCatalogEntry[],
    ): void => {
      setWebhooks(nextWebhooks);
      setEvents(nextEvents);
      if (!nextWebhooks.some((item) => item.id === webhookIDRef.current)) {
        setWebhookID(nextWebhooks[0]?.id ?? "");
        onResetResponse();
      }
      if (nextEvents.some((item) => item.event_type === eventTypeRef.current)) {
        return;
      }
      const previousEvent = eventTypeRef.current;
      const first = nextEvents[0];
      setEventType(first?.event_type ?? "");
      if (!previousEvent && first) {
        const initialPayload = JSON.stringify(first.sample_payload, null, 2);
        setPayload(initialPayload);
        payloadBaselineRef.current = initialPayload;
      } else if (previousEvent) {
        onStatus(
          first
            ? `The selected event is no longer in the catalog. ${first.event_type} is selected and your edited payload was retained.`
            : "The selected event is no longer in the catalog. Your edited payload was retained, but firing is unavailable.",
        );
      }
    },
    [onResetResponse, onStatus],
  );
  const handleAppended = useCallback((additional: OutboundWebhook[]): void => {
    setWebhooks((current) => {
      const known = new Set(current.map((webhook) => webhook.id));
      const unique: OutboundWebhook[] = [];
      for (const webhook of additional) {
        if (known.has(webhook.id)) continue;
        known.add(webhook.id);
        unique.push(webhook);
      }
      return [...current, ...unique];
    });
  }, []);
  const loader = useSimulatorCatalogLoader(handleLoaded, handleAppended);
  return {
    webhooks,
    events,
    webhookID,
    eventType,
    payload,
    payloadBaselineRef,
    setWebhookID,
    setEventType,
    setPayload,
    ...loader,
  };
}

function useSimulatorFire({
  operation,
  activeRef,
  abortRef,
  onStart,
  onFinish,
  onFailure,
  onResponse,
}: {
  operation: ReturnType<typeof useSingleFlightOperation>;
  activeRef: MutableRefObject<boolean>;
  abortRef: MutableRefObject<AbortController | null>;
  onStart: () => void;
  onFinish: () => void;
  onFailure: (error: SimulatorFireError, snapshot: FireSnapshot) => void;
  onResponse: (response: FireResponse | null, snapshot: FireSnapshot) => void;
}): (snapshot: FireSnapshot) => Promise<SimulatorFireDisposition> {
  return async (snapshot: FireSnapshot): Promise<SimulatorFireDisposition> => {
    const controller = new AbortController();
    abortRef.current = controller;
    const request = operation.run(() =>
      api.fireWebhookPlayground(
        snapshot.webhookID,
        {
          fire_id: snapshot.fireID,
          event_type: snapshot.eventType,
          expected_webhook_config_version: snapshot.webhookConfigVersion,
          payloadJSON: snapshot.payload,
        },
        {
          idempotencyKey: snapshot.idempotencyKey,
          signal: controller.signal,
        },
      ),
    );
    if (!request) {
      if (abortRef.current === controller) abortRef.current = null;
      return "not_started";
    }
    onStart();
    let result: Awaited<ReturnType<typeof api.fireWebhookPlayground>>;
    try {
      result = await request;
    } catch (caught) {
      if (activeRef.current) {
        const error = {
          kind: "network" as const,
          message: lifecycleOperationError(
            caught,
            "The signed test delivery failed before a response was received.",
          ),
        };
        onFailure(error, snapshot);
        toast.error(`Fire outcome unknown: ${error.message}`);
      }
      return "unresolved";
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (activeRef.current) onFinish();
    }
    if (!activeRef.current) return "unresolved";
    if (result.error) {
      onFailure(result.error, snapshot);
      toast.error(
        `${fireErrorHasAmbiguousDispatch(result.error) ? "Fire outcome unknown" : "Fire failed"}: ${result.error.message}`,
      );
      if (fireErrorProvesExpiredIdentity(result.error, snapshot.fireID)) {
        return "identity_consumed";
      }
      if (fireErrorClaimsExpiredIdentity(result.error)) return "unresolved";
      return fireErrorHasAmbiguousDispatch(result.error)
        ? "unresolved"
        : "not_dispatched";
    }
    onResponse(result.data ?? null, snapshot);
    return result.data && result.data.ambiguous !== true
      ? "resolved"
      : "unresolved";
  };
}

type SimulatorStateSetter<T> = (value: T | ((current: T) => T)) => void;

function useConfiguredSimulatorFire({
  operation,
  activeRef,
  abortRef,
  setSending,
  setResponse,
  setResponseContext,
  setFireError,
  setActionStatus,
  setFireRequiresRefresh,
  setRecentFires,
  setReconciliation,
  setReconciliationAcknowledged,
}: {
  operation: ReturnType<typeof useSingleFlightOperation>;
  activeRef: MutableRefObject<boolean>;
  abortRef: MutableRefObject<AbortController | null>;
  setSending: SimulatorStateSetter<boolean>;
  setResponse: SimulatorStateSetter<FireResponse | null>;
  setResponseContext: SimulatorStateSetter<FireSnapshot | null>;
  setFireError: SimulatorStateSetter<string | null>;
  setActionStatus: SimulatorStateSetter<string | null>;
  setFireRequiresRefresh: SimulatorStateSetter<boolean>;
  setRecentFires: SimulatorStateSetter<RecentFire[]>;
  setReconciliation: SimulatorStateSetter<FireReconciliation | null>;
  setReconciliationAcknowledged: SimulatorStateSetter<boolean>;
}): (snapshot: FireSnapshot) => Promise<SimulatorFireDisposition> {
  return useSimulatorFire({
    operation,
    activeRef,
    abortRef,
    onStart: () => {
      setSending(true);
      setResponse(null);
      setResponseContext(null);
      setFireError(null);
      setFireRequiresRefresh(false);
    },
    onFinish: () => setSending(false),
    onFailure: (error, snapshot) => {
      const staleTarget = error.code === "webhook_changed";
      const receiptExpired = fireErrorProvesExpiredIdentity(
        error,
        snapshot.fireID,
      );
      const ambiguous =
        (fireErrorClaimsExpiredIdentity(error) && !receiptExpired) ||
        fireErrorHasAmbiguousDispatch(error);
      const waitingWasCancelled =
        error.code === "aborted" ||
        /abort|stopped waiting/iu.test(error.message);
      setFireRequiresRefresh(staleTarget);
      setFireError(
        staleTarget
          ? "The destination changed since this catalog snapshot. Refresh the target and review it before firing again."
          : error.message,
      );
      if (receiptExpired) {
        setReconciliationAcknowledged(false);
        setReconciliation({
          snapshot,
          phase: "receipt_expired",
          detail:
            "The server still permanently fences this fire identity, but its private retained response and payload have expired. Clearing the encrypted local checkpoint will not contact the receiver again.",
          receipt: null,
        });
      } else if (ambiguous) {
        setReconciliationAcknowledged(false);
        setReconciliation({
          snapshot,
          phase:
            error.code === "playground_fire_outcome_pending"
              ? "pending"
              : "unknown",
          detail:
            error.code === "playground_fire_outcome_pending"
              ? "The server reserved the fire and has not recorded a terminal receiver outcome yet."
              : waitingWasCancelled
                ? "The desktop stopped waiting, but cancellation cannot recall a receiver request that may already have crossed the network boundary."
                : "The desktop did not receive trustworthy proof of whether the receiver was contacted.",
          receipt: null,
        });
      } else {
        setReconciliation(null);
      }
      setActionStatus(
        receiptExpired
          ? `Private receipt details for fire ${snapshot.fireID} expired; the server identity fence remains permanent and no redispatch will run.`
          : ambiguous
            ? `Fire ${snapshot.fireID} has an unknown receiver outcome and is blocked for reconciliation.`
            : `Fire failed before dispatch for ${snapshot.webhookURL}. ${error.message}`,
      );
    },
    onResponse: (data, snapshot) => {
      setResponse(data);
      setResponseContext(data ? snapshot : null);
      if (!data || data.ambiguous === true) {
        setReconciliationAcknowledged(false);
        setReconciliation({
          snapshot,
          phase: data?.ambiguous === true ? "ambiguous" : "unknown",
          detail:
            data?.ambiguous === true
              ? "Moosewave reached the outbound transport boundary but received no receiver status. Check receiver logs using this fire ID before proceeding."
              : "The server accepted the fire request but returned no trustworthy receipt body. Reconcile this exact fire identity before proceeding.",
          receipt: null,
        });
      } else {
        setReconciliation(null);
        setReconciliationAcknowledged(false);
      }
      setActionStatus(
        data
          ? data.filtered
            ? `${snapshot.eventType} was filtered before delivery to ${snapshot.webhookURL}; no receiver request was made.`
            : data.ambiguous
              ? `${snapshot.eventType} fire ${snapshot.fireID} has a transport-ambiguous receiver outcome.`
              : `${snapshot.eventType} fired to ${snapshot.webhookURL}; response ${data.status_code ?? "not reported"}.`
          : `The server accepted the fire request for ${snapshot.webhookURL} but returned no response details.`,
      );
      if (!data) return;
      setRecentFires((current) =>
        [
          {
            id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            fire_id: data.fire_id,
            delivery_id: data.delivery_id,
            outcome: data.outcome,
            webhook_url: snapshot.webhookURL,
            event_type: snapshot.eventType,
            status_code: data.status_code ?? 0,
            latency_ms: data.latency_ms ?? 0,
            error: !!data.error,
            filtered: data.filtered === true,
            fired_at: Date.now(),
            payload: snapshot.payload,
            webhook_id: snapshot.webhookID,
          },
          ...current,
        ].slice(0, MAX_RECENT_FIRES),
      );
    },
  });
}

function useSimulatorAdminState() {
  const me = useMe();
  const apiBaseURL = getApiUrl();
  const apiIdentityGeneration = captureApiIdentityGeneration();
  const recoveryIdentity = useMemo(
    () =>
      me
        ? {
            credentialFingerprint: me.credentialFingerprint,
            credentialSource: me.credentialSource,
            tenant: me.tenant,
            user: me.user,
            webhookPlaygroundRecoveryScope: me.webhookPlaygroundRecoveryScope,
          }
        : null,
    [
      me?.credentialFingerprint,
      me?.credentialSource,
      me?.tenant,
      me?.user,
      me?.webhookPlaygroundRecoveryScope,
    ],
  );
  const recoveryAuthority = useMemo(
    () =>
      createWebhookPlaygroundFireRecoveryAuthority(
        recoveryIdentity,
        apiBaseURL,
        apiIdentityGeneration,
      ),
    [apiBaseURL, apiIdentityGeneration, recoveryIdentity],
  );
  const currentRecoveryAuthorityKey = recoveryAuthorityKey(recoveryAuthority);
  const pendingFireRef = useRef<FireSnapshot | null>(null);
  const fireAbortRef = useRef<AbortController | null>(null);
  const payloadEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const responseRegionRef = useRef<HTMLDivElement | null>(null);
  const [response, setResponse] = useState<FireResponse | null>(null);
  const [responseContext, setResponseContext] = useState<FireSnapshot | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [checkingReceipt, setCheckingReceipt] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [fireError, setFireError] = useState<string | null>(null);
  const [fireRequiresRefresh, setFireRequiresRefresh] = useState(false);
  const [reconciliation, setReconciliation] =
    useState<FireReconciliation | null>(null);
  const [reconciliationAcknowledged, setReconciliationAcknowledged] =
    useState(false);
  const [recoveryGate, setRecoveryGate] = useState<FireRecoveryGate>({
    status: "loading",
    authorityKey: currentRecoveryAuthorityKey,
  });
  const [restoredRecoverySnapshot, setRestoredRecoverySnapshot] =
    useState<WebhookPlaygroundFireSnapshot | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [pendingReplacement, setPendingReplacement] =
    useState<PayloadReplacement | null>(null);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const operation = useSingleFlightOperation({
    ownerId: "webhook-simulator-fire",
    label: "Webhook simulator delivery",
    detail:
      "Wait for the signed webhook test delivery to finish before leaving.",
  });
  const reconciliationRef = useRef<FireReconciliation | null>(null);
  const recoveryGateRef = useRef<FireRecoveryGate>(recoveryGate);
  const recoveryAuthorityKeyRef = useRef(currentRecoveryAuthorityKey);
  reconciliationRef.current = reconciliation;
  recoveryGateRef.current = recoveryGate;
  recoveryAuthorityKeyRef.current = currentRecoveryAuthorityKey;
  useEffect(() => {
    signalLifecycleOwnerChanged();
  }, [reconciliation, recoveryGate]);
  useEffect(
    () =>
      registerLifecycleGuard({
        id: "webhook-simulator-unresolved-fire",
        label: "Unresolved webhook simulator fire",
        inspect: () => {
          const current = reconciliationRef.current;
          if (!current) {
            const gate = recoveryGateRef.current;
            if (
              gate.status === "ready" &&
              gate.authorityKey === recoveryAuthorityKeyRef.current
            ) {
              return null;
            }
            return {
              level: "blocking",
              detail:
                gate.status === "held"
                  ? recoveryHoldDetail(gate.reason)
                  : "Moosewave is still checking this identity's encrypted webhook fire checkpoint.",
              canSave: false,
              canDiscard: false,
              canRecover: false,
            };
          }
          return {
            level: "blocking",
            detail:
              current.phase === "ambiguous"
                ? `Fire ${current.snapshot.fireID} must be reconciled or explicitly acknowledged before leaving, signing out, or switching workspaces.`
                : `Fire ${current.snapshot.fireID} must be reconciled before leaving, signing out, or switching workspaces.`,
            canSave: false,
            canDiscard: false,
            canRecover: false,
          };
        },
      }),
    [],
  );
  const resetResponse = useCallback((): void => {
    setPayloadError(null);
    setFireError(null);
    setFireRequiresRefresh(false);
    setResponse(null);
    setResponseContext(null);
    setPendingReplacement(null);
  }, []);
  const {
    webhooks,
    events,
    webhookID,
    eventType,
    payload,
    payloadBaselineRef,
    setWebhookID,
    setEventType,
    setPayload,
    loading,
    loadingMore,
    error: err,
    moreError,
    nextCursor,
    activeRef,
    load,
    loadMore,
  } = useSimulatorCatalogState({
    operation,
    onResetResponse: resetResponse,
    onStatus: setActionStatus,
  });
  return {
    recoveryAuthority,
    currentRecoveryAuthorityKey,
    pendingFireRef,
    fireAbortRef,
    payloadEditorRef,
    responseRegionRef,
    response,
    setResponse,
    responseContext,
    setResponseContext,
    sending,
    setSending,
    checkingReceipt,
    setCheckingReceipt,
    payloadError,
    setPayloadError,
    fireError,
    setFireError,
    fireRequiresRefresh,
    setFireRequiresRefresh,
    reconciliation,
    setReconciliation,
    reconciliationAcknowledged,
    setReconciliationAcknowledged,
    recoveryGate,
    setRecoveryGate,
    restoredRecoverySnapshot,
    setRestoredRecoverySnapshot,
    actionStatus,
    setActionStatus,
    pendingReplacement,
    setPendingReplacement,
    confirmClearHistory,
    setConfirmClearHistory,
    operation,
    reconciliationRef,
    recoveryAuthorityKeyRef,
    webhooks,
    events,
    webhookID,
    eventType,
    payload,
    payloadBaselineRef,
    setWebhookID,
    setEventType,
    setPayload,
    loading,
    loadingMore,
    err,
    moreError,
    nextCursor,
    activeRef,
    load,
    loadMore,
  };
}

type SimulatorAdminState = ReturnType<typeof useSimulatorAdminState>;

function useSimulatorRecoveryCheckpointLoad(state: SimulatorAdminState) {
  const {
    currentRecoveryAuthorityKey,
    recoveryAuthority,
    recoveryAuthorityKeyRef,
    setRecoveryGate,
    setRestoredRecoverySnapshot,
    setReconciliation,
    setReconciliationAcknowledged,
    setActionStatus,
    restoredRecoverySnapshot,
    setPayload,
    payloadBaselineRef,
    events,
    setEventType,
    webhooks,
    setWebhookID,
    pendingFireRef,
    fireAbortRef,
    activeRef,
  } = state;
  const recoveryLoadSequenceRef = useRef(0);
  const loadRecoveryCheckpoint = useCallback((): void => {
    const sequence = ++recoveryLoadSequenceRef.current;
    const authorityKey = currentRecoveryAuthorityKey;
    setRecoveryGate({ status: "loading", authorityKey });
    setRestoredRecoverySnapshot(null);
    setReconciliation(null);
    setReconciliationAcknowledged(false);
    if (!recoveryAuthority) {
      setRecoveryGate({
        status: "held",
        authorityKey,
        reason: "identity-unresolved",
      });
      return;
    }
    void webhookPlaygroundFireRecovery
      .load(recoveryAuthority)
      .then((result) => {
        if (
          !activeRef.current ||
          sequence !== recoveryLoadSequenceRef.current ||
          recoveryAuthorityKeyRef.current !== authorityKey
        ) {
          return;
        }
        if (result.status === "held") {
          setRecoveryGate({
            status: "held",
            authorityKey,
            reason: result.reason,
          });
          return;
        }
        if (result.status === "clear") {
          setRecoveryGate({ status: "ready", authorityKey });
          return;
        }
        const restored = fireSnapshotFromRecovery(result.snapshot);
        if (!restored) {
          setRecoveryGate({
            status: "held",
            authorityKey,
            reason: "snapshot-invalid",
          });
          return;
        }
        setRestoredRecoverySnapshot(result.snapshot);
        setRecoveryGate({ status: "ready", authorityKey });
        setReconciliation({
          snapshot: restored,
          phase: "unknown",
          detail:
            "Moosewave restored this exact fire identity from the encrypted local checkpoint after an interrupted desktop lifecycle. Check the server receipt before proceeding.",
          receipt: null,
        });
        setActionStatus(
          `Recovered unresolved fire ${restored.fireID} from encrypted local storage.`,
        );
      });
  }, [activeRef, currentRecoveryAuthorityKey, recoveryAuthority]);
  useEffect(() => {
    loadRecoveryCheckpoint();
    return () => {
      recoveryLoadSequenceRef.current += 1;
    };
  }, [loadRecoveryCheckpoint]);
  useEffect(() => {
    if (!restoredRecoverySnapshot) return;
    setPayload(restoredRecoverySnapshot.payloadJSON);
    payloadBaselineRef.current = restoredRecoverySnapshot.payloadJSON;
    if (
      events.some(
        (event) => event.event_type === restoredRecoverySnapshot.eventType,
      )
    ) {
      setEventType(restoredRecoverySnapshot.eventType);
    }
    const target = webhooks.find(
      (webhook) => webhook.id === restoredRecoverySnapshot.webhookId,
    );
    if (target) {
      setWebhookID(target.id);
      setReconciliation((current) =>
        current?.snapshot.fireID === restoredRecoverySnapshot.fireId
          ? {
              ...current,
              snapshot: {
                ...current.snapshot,
                webhookURL: sanitizeInspectableUrl(target.url).url,
              },
            }
          : current,
      );
    }
  }, [
    events,
    payloadBaselineRef,
    restoredRecoverySnapshot,
    setEventType,
    setPayload,
    setWebhookID,
    webhooks,
  ]);
  useEffect(
    () => () => {
      pendingFireRef.current = null;
      fireAbortRef.current?.abort();
      fireAbortRef.current = null;
    },
    [],
  );
  return loadRecoveryCheckpoint;
}

function useSimulatorResponseLifecycle(state: SimulatorAdminState) {
  const {
    response,
    responseRegionRef,
    operation,
    activeRef,
    fireAbortRef,
    setSending,
    setResponse,
    setResponseContext,
    setFireError,
    setActionStatus,
    setFireRequiresRefresh,
    setReconciliation,
    setReconciliationAcknowledged,
  } = state;
  // Session-only history of fires.
  const [recentFires, setRecentFires] = useState<RecentFire[]>([]);

  // Verification-snippet dialog state.
  const [verifyOpen, setVerifyOpen] = useState<boolean>(false);

  useEffect(() => {
    if (!response) return;
    requestAnimationFrame(() => {
      responseRegionRef.current?.focus({ preventScroll: true });
      responseRegionRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "auto",
      });
    });
  }, [response]);

  const performFire = useConfiguredSimulatorFire({
    operation,
    activeRef,
    abortRef: fireAbortRef,
    setSending,
    setResponse,
    setResponseContext,
    setFireError,
    setActionStatus,
    setFireRequiresRefresh,
    setRecentFires,
    setReconciliation,
    setReconciliationAcknowledged,
  });
  return {
    recentFires,
    setRecentFires,
    verifyOpen,
    setVerifyOpen,
    performFire,
  };
}

type SimulatorResponseLifecycle = ReturnType<
  typeof useSimulatorResponseLifecycle
>;

function useSimulatorRecoveryActions(
  state: SimulatorAdminState,
  responseLifecycle: SimulatorResponseLifecycle,
) {
  const {
    recoveryAuthority,
    currentRecoveryAuthorityKey,
    recoveryAuthorityKeyRef,
    setRecoveryGate,
    setRestoredRecoverySnapshot,
    setReconciliation,
    setReconciliationAcknowledged,
    setFireError,
    setActionStatus,
    setSending,
    activeRef,
    reconciliationRef,
    reconciliationAcknowledged,
  } = state;
  const { performFire } = responseLifecycle;

  const settleRecoveryCheckpoint = async (
    snapshot: FireSnapshot,
  ): Promise<boolean> => {
    const authority = recoveryAuthority;
    const authorityKey = currentRecoveryAuthorityKey;
    if (!authority) {
      setRecoveryGate({
        status: "held",
        authorityKey,
        reason: "identity-unresolved",
      });
      return false;
    }
    const result = await webhookPlaygroundFireRecovery.settle(
      authority,
      recoverySnapshotFromFire(snapshot),
    );
    if (
      recoveryAuthorityKeyRef.current !== authorityKey ||
      result.status === "held"
    ) {
      const reason =
        result.status === "held" ? result.reason : "identity-changed";
      setRecoveryGate({ status: "held", authorityKey, reason });
      setReconciliation({
        snapshot,
        phase: "checkpoint_cleanup",
        detail: `${recoveryHoldDetail(reason)} Retry encrypted cleanup before creating another identity.`,
        receipt: null,
      });
      setFireError(
        "The receiver outcome is known, but the encrypted local recovery fence could not be cleared.",
      );
      return false;
    }
    setRecoveryGate({ status: "ready", authorityKey });
    setRestoredRecoverySnapshot(null);
    setReconciliation(null);
    setReconciliationAcknowledged(false);
    return true;
  };

  const executeCheckpointedFire = async (
    snapshot: FireSnapshot,
    checkpointPrepared: boolean,
  ): Promise<void> => {
    const lease = tryAcquireWebhookPlaygroundFireOperationLease();
    if (!lease) {
      setFireError(
        "A destructive sign-out or another fire lifecycle already owns local recovery. Wait for it to finish.",
      );
      return;
    }
    const authority = recoveryAuthority;
    const authorityKey = currentRecoveryAuthorityKey;
    setSending(true);
    try {
      if (!authority) {
        setRecoveryGate({
          status: "held",
          authorityKey,
          reason: "identity-unresolved",
        });
        setFireError(recoveryHoldDetail("identity-unresolved"));
        return;
      }
      if (!checkpointPrepared) {
        setRecoveryGate({ status: "loading", authorityKey });
        const prepared = await webhookPlaygroundFireRecovery.prepare(
          authority,
          recoverySnapshotFromFire(snapshot),
        );
        if (
          recoveryAuthorityKeyRef.current !== authorityKey ||
          prepared.status === "held"
        ) {
          const reason =
            prepared.status === "held" ? prepared.reason : "identity-changed";
          setRecoveryGate({ status: "held", authorityKey, reason });
          setFireError(recoveryHoldDetail(reason));
          return;
        }
        setRestoredRecoverySnapshot(prepared.snapshot);
        setRecoveryGate({ status: "ready", authorityKey });
      }
      if (
        !activeRef.current ||
        recoveryAuthorityKeyRef.current !== authorityKey
      ) {
        if (activeRef.current) {
          setRecoveryGate({
            status: "held",
            authorityKey,
            reason: "identity-changed",
          });
        }
        return;
      }
      const disposition = await performFire(snapshot);
      if (disposition === "unresolved") return;
      if (
        checkpointPrepared &&
        (disposition === "not_dispatched" || disposition === "not_started")
      ) {
        // This refusal proves only that the retry did not dispatch. The
        // prepared checkpoint may represent an earlier request that crossed
        // the receiver boundary, so retain its identity fence until receipt
        // reconciliation (or a permanent 410 tombstone) resolves it.
        setRecoveryGate({ status: "ready", authorityKey });
        setReconciliationAcknowledged(false);
        setReconciliation({
          snapshot,
          phase: "unknown",
          detail:
            disposition === "not_started"
              ? "This retry did not start, but the recovered checkpoint still represents an earlier request with an unknown receiver boundary. Check the server receipt before proceeding."
              : "The server refused this retry before dispatch, but that does not resolve whether the earlier checkpointed request crossed the receiver boundary. Check the server receipt before proceeding.",
          receipt: null,
        });
        return;
      }
      setRecoveryGate({ status: "loading", authorityKey });
      await settleRecoveryCheckpoint(snapshot);
    } finally {
      lease.release();
      if (activeRef.current) setSending(false);
    }
  };

  const retryRecoverySettlement = async (): Promise<void> => {
    const current = reconciliationRef.current;
    if (
      !current ||
      (current.phase !== "checkpoint_cleanup" &&
        current.phase !== "receipt_expired")
    ) {
      return;
    }
    const receiptExpired = current.phase === "receipt_expired";
    const lease = tryAcquireWebhookPlaygroundFireOperationLease();
    if (!lease) return;
    setSending(true);
    try {
      if (await settleRecoveryCheckpoint(current.snapshot)) {
        setFireError(null);
        setActionStatus(
          receiptExpired
            ? `Expired private receipt details for fire ${current.snapshot.fireID} were cleared locally. The permanent server identity fence remains and no receiver request was sent.`
            : `Encrypted recovery checkpoint for fire ${current.snapshot.fireID} was cleared.`,
        );
      }
    } finally {
      lease.release();
      if (activeRef.current) setSending(false);
    }
  };

  const releaseAcknowledgedAmbiguousFire = async (): Promise<void> => {
    const current = reconciliationRef.current;
    if (
      !current ||
      current.phase !== "ambiguous" ||
      !reconciliationAcknowledged
    ) {
      return;
    }
    const lease = tryAcquireWebhookPlaygroundFireOperationLease();
    if (!lease) return;
    setSending(true);
    try {
      if (!(await settleRecoveryCheckpoint(current.snapshot))) return;
      setFireError(null);
      setActionStatus(
        `Ambiguous fire ${current.snapshot.fireID} was acknowledged after receiver verification. A new logical fire is now available.`,
      );
    } finally {
      lease.release();
      if (activeRef.current) setSending(false);
    }
  };

  return {
    executeCheckpointedFire,
    retryRecoverySettlement,
    releaseAcknowledgedAmbiguousFire,
  };
}

function useSimulatorReceiptReconciliation(state: SimulatorAdminState) {
  const {
    activeRef,
    reconciliationRef,
    operation,
    fireAbortRef,
    setSending,
    setCheckingReceipt,
    setActionStatus,
    setReconciliation,
    setReconciliationAcknowledged,
  } = state;

  const reconcileFire = async (): Promise<void> => {
    const current = reconciliationRef.current;
    if (!current || operation.promiseRef.current) return;
    const controller = new AbortController();
    fireAbortRef.current = controller;
    const request = operation.run(() =>
      api.getWebhookPlaygroundFire(current.snapshot.fireID, {
        signal: controller.signal,
      }),
    );
    if (!request) {
      if (fireAbortRef.current === controller) fireAbortRef.current = null;
      return;
    }
    setSending(true);
    setCheckingReceipt(true);
    try {
      const result = await request;
      if (
        !activeRef.current ||
        reconciliationRef.current?.snapshot.fireID !== current.snapshot.fireID
      ) {
        return;
      }
      if (result.error) {
        if (result.error.code === "aborted") {
          setActionStatus(
            `Receipt check stopped for fire ${current.snapshot.fireID}; the existing reconciliation fence remains in place.`,
          );
          return;
        }
        if (result.error.status === 404) {
          setReconciliation({
            ...current,
            phase: "not_registered",
            detail:
              "No durable receipt is registered yet. Continue only with this same fire identity; doing so is idempotent even if the original request is still arriving.",
            receipt: null,
          });
          setActionStatus(
            `No receipt is currently registered for fire ${current.snapshot.fireID}; a new fire identity remains blocked.`,
          );
          return;
        }
        setReconciliation({
          ...current,
          detail: `Receipt lookup failed: ${result.error.message}`,
        });
        toast.error(`Receipt check failed: ${result.error.message}`);
        return;
      }
      const receipt = result.data;
      if (!playgroundReceiptMatchesSnapshot(receipt, current.snapshot)) {
        setReconciliation({
          ...current,
          detail:
            "The server receipt identity did not match this local fire snapshot. The local recovery fence remains in place and no terminal action is available.",
          receipt: null,
        });
        setActionStatus(
          `Receipt identity mismatch for fire ${current.snapshot.fireID}; recovery remains blocked.`,
        );
        toast.error("Receipt identity mismatch; recovery remains blocked.");
        return;
      }
      if (receipt.state === "pending") {
        setReconciliation({
          ...current,
          phase: "pending",
          detail:
            "The server reserved this fire and is still waiting to record a terminal receiver outcome. Check again; do not create another identity.",
          receipt,
        });
      } else if (receipt.state === "receipt_expired") {
        setReconciliationAcknowledged(false);
        setReconciliation({
          ...current,
          phase: "receipt_expired",
          detail:
            "The server permanently fences this fire identity from redispatch, but its private retained payload and response have expired. Clear only the encrypted local checkpoint to finish; this does not contact the receiver.",
          receipt,
        });
        setActionStatus(
          `Private receipt details for fire ${current.snapshot.fireID} expired; the permanent server identity fence remains.`,
        );
      } else if (receipt.state === "ambiguous") {
        setReconciliationAcknowledged(false);
        setReconciliation({
          ...current,
          phase: "ambiguous",
          detail:
            "The durable receipt confirms a transport-ambiguous outcome. Check the receiver for this fire or delivery ID before proceeding.",
          receipt,
        });
      } else {
        setReconciliation({
          ...current,
          phase: "recoverable",
          detail:
            "The server retained a terminal response. Restore it with the exact same request identity; this does not contact the receiver again.",
          receipt,
        });
      }
    } catch (caught) {
      if (activeRef.current) {
        setReconciliation({
          ...current,
          detail: `Receipt lookup failed: ${lifecycleOperationError(caught, "network unavailable")}`,
        });
      }
    } finally {
      if (fireAbortRef.current === controller) fireAbortRef.current = null;
      if (activeRef.current) {
        setCheckingReceipt(false);
        setSending(false);
      }
    }
  };
  return reconcileFire;
}

type SimulatorRecoveryActions = ReturnType<typeof useSimulatorRecoveryActions>;

function useSimulatorAdminInteractions(
  state: SimulatorAdminState,
  recoveryActions: SimulatorRecoveryActions,
) {
  const {
    setPayload,
    payloadBaselineRef,
    setEventType,
    setWebhookID,
    setPayloadError,
    setFireError,
    setFireRequiresRefresh,
    setResponse,
    setResponseContext,
    setPendingReplacement,
    setActionStatus,
    operation,
    payload,
    events,
    pendingFireRef,
    load,
    webhooks,
    webhookID,
    eventType,
    loading,
    err,
    recoveryGate,
    restoredRecoverySnapshot,
    currentRecoveryAuthorityKey,
    recoveryAuthority,
    reconciliationRef,
    payloadEditorRef,
    activeRef,
  } = state;
  const { executeCheckpointedFire } = recoveryActions;

  // When the event type changes, pre-fill the payload editor with
  // the sample so operators start with a working template.
  const commitPayloadReplacement = (replacement: PayloadReplacement): void => {
    setPayload(replacement.payload);
    payloadBaselineRef.current = replacement.payload;
    setEventType(replacement.eventType);
    if (replacement.webhookID) setWebhookID(replacement.webhookID);
    setPayloadError(null);
    setFireError(null);
    setFireRequiresRefresh(false);
    setResponse(null);
    setResponseContext(null);
    setPendingReplacement(null);
    setActionStatus(`${replacement.source} loaded into the payload editor.`);
  };

  const requestPayloadReplacement = (replacement: PayloadReplacement): void => {
    if (operation.promiseRef.current) return;
    if (payload !== payloadBaselineRef.current) {
      setPendingReplacement(replacement);
      return;
    }
    commitPayloadReplacement(replacement);
  };

  const onEventChange = (nextEventType: string): void => {
    const replacement = eventSampleReplacement(events, nextEventType);
    if (replacement) requestPayloadReplacement(replacement);
  };

  const [prodConfirmOpen, setProdConfirmOpen] = useState(false);

  const refreshCatalog = (): void => {
    pendingFireRef.current = null;
    setProdConfirmOpen(false);
    setFireRequiresRefresh(false);
    void load();
  };

  const selectedWebhook = useMemo(
    () => webhooks.find((w) => w.id === webhookID),
    [webhooks, webhookID],
  );

  // D12-comms-webhooks#5: is the registered sample for the selected event a
  // placeholder (no realistic payload on the backend)? Drives an honest
  // warning so the operator doesn't write handler parsers against junk.
  const selectedEvent = useMemo(
    () => events.find((e) => e.event_type === eventType),
    [events, eventType],
  );
  const samplePlaceholder =
    !!selectedEvent && isPlaceholderSample(selectedEvent.sample_payload);
  const catalogReady = !loading && !err;
  const recoveryReady =
    recoveryGate.status === "ready" &&
    recoveryGate.authorityKey === currentRecoveryAuthorityKey &&
    recoveryAuthority !== null &&
    restoredRecoverySnapshot === null;
  const recoveryUnavailableReason = restoredRecoverySnapshot
    ? "An encrypted fire checkpoint is still retained. Reconcile that exact fire before creating a new identity."
    : recoveryReady
      ? null
      : recoveryGate.status === "held" &&
          recoveryGate.authorityKey === currentRecoveryAuthorityKey
        ? recoveryHoldDetail(recoveryGate.reason)
        : "Moosewave is checking this identity's encrypted fire checkpoint before enabling a new live request.";

  // Entry point: validate JSON, then review every destination. Environment
  // labels do not change the fact that the playground performs a real signed
  // POST at the operator's customer-facing handler.
  const fire = (): void => {
    if (
      !webhookID ||
      !eventType ||
      !catalogReady ||
      !recoveryReady ||
      webhookFireReadinessReason(selectedWebhook) ||
      reconciliationRef.current ||
      operation.promiseRef.current
    ) {
      return;
    }
    const validation = validateSimulatorPayload(payload);
    if (validation.parsed === null) {
      setPayloadError(validation.error);
      toast.error(
        validation.kind === "too_large"
          ? `Payload is too large: ${validation.error}`
          : validation.kind === "limits"
            ? `Payload exceeds simulator limits: ${validation.error}`
            : validation.kind === "shape"
              ? `Payload shape is invalid: ${validation.error}`
              : `Payload isn't valid JSON: ${validation.error}`,
      );
      queueMicrotask(() => payloadEditorRef.current?.focus());
      return;
    }
    setPayloadError(null);
    if (!selectedWebhook?.url) {
      setFireError(
        "The selected webhook is no longer available. Refresh and choose another target.",
      );
      return;
    }
    const snapshot = simulatorFireSnapshot(selectedWebhook, eventType, payload);
    // Environment labels are organizational metadata, not a sandbox boundary:
    // every configured destination receives a real signed POST.
    setProdConfirmOpen(true);
    pendingFireRef.current = snapshot;
  };

  const confirmProdFire = async (): Promise<void> => {
    const snapshot = pendingFireRef.current;
    if (!snapshot) return;
    const currentTarget = webhooks.find(
      (webhook) => webhook.id === snapshot.webhookID,
    );
    if (
      !catalogReady ||
      !recoveryReady ||
      currentTarget?.config_version !== snapshot.webhookConfigVersion
    ) {
      setFireError(
        "The target changed after confirmation opened. Refresh the catalog, review the current destination, and fire again.",
      );
      setFireRequiresRefresh(true);
      pendingFireRef.current = null;
      setProdConfirmOpen(false);
      return;
    }
    // The review ceremony is complete. Close it before awaiting the network so
    // the operator can reach the explicit “stop waiting & reconcile” control.
    setProdConfirmOpen(false);
    await executeCheckpointedFire(snapshot, false);
    if (!activeRef.current) return;
    pendingFireRef.current = null;
  };

  function applySavedPayload(p: string, et: string): void {
    if (operation.promiseRef.current) return;
    requestPayloadReplacement(
      savedPayloadReplacement(p, et, events, eventType),
    );
  }

  function applyRecentFire(f: RecentFire): void {
    if (operation.promiseRef.current) return;
    requestPayloadReplacement(
      recentFireReplacement(f, events, eventType, webhooks),
    );
  }
  return {
    prodConfirmOpen,
    setProdConfirmOpen,
    commitPayloadReplacement,
    onEventChange,
    refreshCatalog,
    selectedWebhook,
    samplePlaceholder,
    catalogReady,
    recoveryUnavailableReason,
    fire,
    confirmProdFire,
    applySavedPayload,
    applyRecentFire,
  };
}

function WebhookSimulatorAdmin(): ReactElement {
  const state = useSimulatorAdminState();
  const loadRecoveryCheckpoint = useSimulatorRecoveryCheckpointLoad(state);
  const responseLifecycle = useSimulatorResponseLifecycle(state);
  const recoveryActions = useSimulatorRecoveryActions(state, responseLifecycle);
  const reconcileFire = useSimulatorReceiptReconciliation(state);
  const interactions = useSimulatorAdminInteractions(state, recoveryActions);
  const {
    webhooks,
    events,
    webhookID,
    eventType,
    payload,
    payloadBaselineRef,
    payloadError,
    fireError,
    fireRequiresRefresh,
    reconciliation,
    reconciliationAcknowledged,
    response,
    responseContext,
    sending,
    checkingReceipt,
    actionStatus,
    loading,
    err,
    nextCursor,
    loadingMore,
    moreError,
    payloadEditorRef,
    responseRegionRef,
    operation,
    setWebhookID,
    setResponse,
    setResponseContext,
    setFireError,
    setFireRequiresRefresh,
    setPayload,
    setPayloadError,
    pendingFireRef,
    reconciliationRef,
    fireAbortRef,
    setReconciliationAcknowledged,
    setReconciliation,
    loadMore,
    pendingReplacement,
    setPendingReplacement,
    confirmClearHistory,
    setConfirmClearHistory,
    setActionStatus,
  } = state;
  const { recentFires, setRecentFires, verifyOpen, setVerifyOpen } =
    responseLifecycle;
  const {
    executeCheckpointedFire,
    retryRecoverySettlement,
    releaseAcknowledgedAmbiguousFire,
  } = recoveryActions;
  const {
    prodConfirmOpen,
    setProdConfirmOpen,
    commitPayloadReplacement,
    onEventChange,
    refreshCatalog,
    selectedWebhook,
    samplePlaceholder,
    catalogReady,
    recoveryUnavailableReason,
    fire,
    confirmProdFire,
    applySavedPayload,
    applyRecentFire,
  } = interactions;

  return (
    <div className="page">
      <SimulatorIntro
        webhooks={webhooks}
        eventCount={events.length}
        loading={loading}
        error={err}
        sending={sending}
        checkingReceipt={checkingReceipt}
        actionStatus={actionStatus}
        onLoad={refreshCatalog}
      />
      <SimulatorWorkspace
        webhooks={webhooks}
        events={events}
        webhookID={webhookID}
        eventType={eventType}
        payload={payload}
        payloadDirty={payload !== payloadBaselineRef.current}
        payloadError={payloadError}
        fireError={fireError}
        fireRequiresRefresh={fireRequiresRefresh}
        reconciliation={reconciliation}
        reconciliationAcknowledged={reconciliationAcknowledged}
        response={response}
        responseContext={responseContext}
        recentFires={recentFires}
        sending={sending}
        checkingReceipt={checkingReceipt}
        recoveryUnavailableReason={recoveryUnavailableReason}
        catalogReady={catalogReady}
        moreTargetsAvailable={nextCursor.length > 0}
        loadingMoreTargets={loadingMore}
        targetLoadError={moreError}
        selectedWebhook={selectedWebhook}
        samplePlaceholder={samplePlaceholder}
        verifyOpen={verifyOpen}
        payloadEditorRef={payloadEditorRef}
        responseRegionRef={responseRegionRef}
        onWebhookChange={(nextWebhookID) => {
          if (operation.promiseRef.current) return;
          setWebhookID(nextWebhookID);
          setResponse(null);
          setResponseContext(null);
          setFireError(null);
          setFireRequiresRefresh(false);
        }}
        onEventChange={onEventChange}
        onPayloadChange={(nextPayload) => {
          setPayload(nextPayload);
          setPayloadError(null);
          setFireError(null);
          setFireRequiresRefresh(false);
          setResponse(null);
          setResponseContext(null);
        }}
        onFire={fire}
        onCancelFire={() => {
          const current =
            pendingFireRef.current ?? reconciliationRef.current?.snapshot;
          fireAbortRef.current?.abort();
          if (checkingReceipt) return;
          if (current) {
            setReconciliationAcknowledged(false);
            setReconciliation({
              snapshot: current,
              phase: "unknown",
              detail:
                "The desktop stopped waiting, but cancellation cannot recall a receiver request that may already have crossed the network boundary.",
              receipt: null,
            });
          }
        }}
        onCheckReceipt={() => void reconcileFire()}
        onRecoverFire={() => {
          const current = reconciliationRef.current;
          if (current) void executeCheckpointedFire(current.snapshot, true);
        }}
        onSettleFire={() => void retryRecoverySettlement()}
        onReconciliationAcknowledgedChange={setReconciliationAcknowledged}
        onReleaseAmbiguousFire={() => void releaseAcknowledgedAmbiguousFire()}
        onRefreshCatalog={refreshCatalog}
        onVerify={() => setVerifyOpen(true)}
        onLoadMoreTargets={() => void loadMore()}
        onRetryRecovery={loadRecoveryCheckpoint}
        onApplySaved={applySavedPayload}
        onApplyRecent={applyRecentFire}
        onRequestClearHistory={() => {
          if (recentFires.length > 0) setConfirmClearHistory(true);
        }}
      />
      <SimulatorDialogs
        verifyOpen={verifyOpen}
        signingAlgorithm={selectedWebhook?.signing_algorithm ?? "hmac_sha256"}
        productionOpen={prodConfirmOpen}
        productionDescription={
          pendingFireRef.current
            ? `This will make one real signed POST for ${pendingFireRef.current.eventType} to ${pendingFireRef.current.webhookURL}. The destination's environment label does not create a sandbox. Your downstream handler can trigger orders, notifications, billing, or other side effects. Fire ID ${pendingFireRef.current.fireID} will remain stable for reconciliation.`
            : ""
        }
        sending={sending}
        fireError={fireError}
        pendingReplacement={pendingReplacement}
        clearHistoryOpen={confirmClearHistory}
        onCloseVerify={() => setVerifyOpen(false)}
        onConfirmProduction={confirmProdFire}
        onCloseProduction={() => {
          if (sending) return;
          setProdConfirmOpen(false);
          pendingFireRef.current = null;
          setFireError(null);
        }}
        onConfirmReplacement={() => {
          if (pendingReplacement) commitPayloadReplacement(pendingReplacement);
        }}
        onCloseReplacement={() => setPendingReplacement(null)}
        onConfirmClearHistory={() => {
          setRecentFires([]);
          setConfirmClearHistory(false);
          setActionStatus(
            "Recent simulator fire history cleared for this session.",
          );
        }}
        onCloseClearHistory={() => setConfirmClearHistory(false)}
      />
    </div>
  );
}

function SimulatorAdminRequired(): ReactElement {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Developer"
        title="Webhook Simulator"
        subtitle="This surface can send signed requests to real outbound destinations and expose retained delivery diagnostics."
      />
      <Notice tone="danger" announcement="assertive">
        Workspace admin access is required to view webhook destinations or fire
        simulator events. No simulator catalog or destination data was loaded.
      </Notice>
    </div>
  );
}

export function WebhookSimulator(): ReactElement {
  const canAdmin = useCanAdmin();
  return canAdmin ? <WebhookSimulatorAdmin /> : <SimulatorAdminRequired />;
}
