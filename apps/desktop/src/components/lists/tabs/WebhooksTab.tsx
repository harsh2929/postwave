/**
 * WebhooksTab — admin-only list-scoped façade over the canonical outbound
 * webhook engine. The tab uses the Moosewave UUID, server-side list scoping,
 * cursor pagination, signed canonical probes, and shown-once secret handling.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type List,
  type OutboundWebhookDelivery,
  type ListScopedWebhook,
  type ListScopedWebhookCreateResponse,
  type ListScopedWebhookEvent,
  LIST_SCOPED_WEBHOOK_EVENTS,
  createListScopedWebhook,
  deleteListScopedWebhook,
  listListScopedWebhookDeliveries,
  listListScopedWebhooks,
  rotateListScopedWebhookSigningMaterial,
  testListScopedWebhook,
} from "../../../lib/api-client";
import { newUUIDv7 } from "../../../lib/http-fetch";
import { useCanAdmin } from "../../../lib/store";
import { fmtDateTime } from "../../../lib/format-date";
import { ConfirmModal } from "../../ConfirmModal";
import { FormField } from "../../FormField";
import { Modal, ModalFooter } from "../../Modal";
import { CopyButton } from "../../playground/Copy";
import { toast } from "../../Toast";
import { sanitizeInspectableText } from "../../webhook-simulator/ResponseInspector";
import {
  type PersistentLifecycleOperation,
  usePersistentLifecycleOperation,
} from "../../../hooks/usePersistentLifecycleOperation";
import { useShownOnceSecretLifecycle } from "../../../hooks/useShownOnceSecretLifecycle";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../../hooks/useSettingsDraftLifecycle";

interface Props {
  list: List;
}

const LIST_EVENTS = LIST_SCOPED_WEBHOOK_EVENTS;
const LIST_WEBHOOK_PAGE_LIMIT = 50;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function canonicalListID(list: List): string | null {
  const value = list.postwave_uuid?.trim();
  return value && CANONICAL_UUID.test(value) ? value : null;
}

function webhookTestUnavailableReason(
  webhook: ListScopedWebhook,
): string | null {
  if (!webhook.active) return "Resume this endpoint before sending a test.";
  if (webhook.url_status !== "ready") {
    return "Replace or finish securing the destination before sending a test.";
  }
  if (webhook.auth_config_status !== "ready") {
    return "Repair receiver authentication before sending a test.";
  }
  if (webhook.delivery_policy_status !== "ready") {
    return "Repair the endpoint filter or transform before sending a test.";
  }
  return null;
}

function webhookCanTest(webhook: ListScopedWebhook): boolean {
  return webhookTestUnavailableReason(webhook) === null;
}

function readinessLabel(webhook: ListScopedWebhook): string {
  return [
    webhook.active ? "Active" : "Paused",
    `destination ${webhook.url_status.replace("_", " ")}`,
    `authentication ${webhook.auth_config_status.replace("_", " ")}`,
    `policy ${webhook.delivery_policy_status.replace("_", " ")}`,
  ].join(" · ");
}

function safeDeliveryEvidence(delivery: OutboundWebhookDelivery): string {
  const raw =
    delivery.last_error ?? delivery.last_response_body_truncated ?? "";
  return raw ? sanitizeInspectableText(raw).text : "";
}

interface WebhookTabHeaderProps {
  actionReasonId: string;
  actionUnavailableReason: string | null;
  listName: string;
  onAdd: () => void;
}

function WebhookTabHeader({
  actionReasonId,
  actionUnavailableReason,
  listName,
  onAdd,
}: WebhookTabHeaderProps): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <div className="muted" style={{ fontSize: 12 }}>
        Webhooks scoped to <code>{listName}</code> fire when a subscriber is
        added to this list.
      </div>
      <span className="spacer" style={{ flex: 1 }} />
      {actionUnavailableReason ? (
        <span id={actionReasonId} className="muted" style={{ fontSize: 11 }}>
          {actionUnavailableReason}
        </span>
      ) : null}
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={onAdd}
        aria-disabled={actionUnavailableReason ? true : undefined}
        aria-describedby={actionUnavailableReason ? actionReasonId : undefined}
      >
        Add webhook
      </button>
    </div>
  );
}

export function WebhooksTab({ list }: Props): ReactElement {
  const canAdmin = useCanAdmin();
  if (!canAdmin) {
    return (
      <div className="notice" role="status">
        <strong>Admin access required</strong>
        <div className="muted" style={{ marginTop: 4 }}>
          Webhook destinations, delivery evidence, test sends, and signing
          material are restricted to workspace admins. No webhook data was
          requested.
        </div>
      </div>
    );
  }
  return (
    <AdminWebhooksTab
      key={canonicalListID(list) ?? `missing-${String(list.id)}`}
      list={list}
    />
  );
}

function useListWebhookCatalog(listID: string | null) {
  const mountedRef = useRef(true);
  const refreshSequenceRef = useRef(0);
  const loadedCursorsRef = useRef<Set<string>>(new Set());
  const webhooksRef = useRef<ListScopedWebhook[]>([]);
  const [webhooks, setWebhooks] = useState<ListScopedWebhook[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshSequenceRef.current += 1;
    };
  }, []);

  const loadPage = async (cursor: string, append: boolean): Promise<void> => {
    const requestId = ++refreshSequenceRef.current;
    if (!listID) {
      setErr(
        "This list has no canonical Moosewave UUID. Refresh the list catalog and try again.",
      );
      webhooksRef.current = [];
      setWebhooks([]);
      setNextCursor("");
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    if (append && (!cursor || loadedCursorsRef.current.has(cursor))) {
      setErr(
        "Moosewave returned a repeated webhook cursor. The verified rows above were kept; refresh before loading more.",
      );
      setLoadingMore(false);
      return;
    }
    if (append) {
      setLoadingMore(true);
    } else {
      loadedCursorsRef.current.clear();
      setLoadingMore(false);
      setLoading(true);
    }
    setErr(null);
    try {
      const res = await listListScopedWebhooks(listID, {
        limit: LIST_WEBHOOK_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (!mountedRef.current || requestId !== refreshSequenceRef.current)
        return;
      if (res.error) {
        setErr(res.error.message);
      } else {
        const page = res.data;
        if (!append) {
          webhooksRef.current = page.webhooks;
          setWebhooks(page.webhooks);
          setNextCursor(page.next_cursor);
          return;
        }
        loadedCursorsRef.current.add(cursor);
        const existingIDs = new Set(
          webhooksRef.current.map((webhook) => webhook.id),
        );
        if (page.webhooks.some((webhook) => existingIDs.has(webhook.id))) {
          setErr(
            "Moosewave returned a webhook already present in an earlier page. The entire unverified page was rejected.",
          );
          setNextCursor("");
          return;
        }
        const combined = [...webhooksRef.current, ...page.webhooks];
        webhooksRef.current = combined;
        setWebhooks(combined);
        if (
          page.next_cursor &&
          loadedCursorsRef.current.has(page.next_cursor)
        ) {
          setErr(
            "Moosewave returned a repeated webhook cursor. The verified rows above were kept; refresh before loading more.",
          );
          setNextCursor("");
        } else {
          setNextCursor(page.next_cursor);
        }
      }
    } catch (error) {
      if (!mountedRef.current || requestId !== refreshSequenceRef.current)
        return;
      setErr(lifecycleOperationError(error, "Couldn't load webhooks."));
    } finally {
      if (mountedRef.current && requestId === refreshSequenceRef.current) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  };

  const refresh = (): Promise<void> => {
    loadedCursorsRef.current.clear();
    setLoadingMore(false);
    return loadPage("", false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listID]);

  return {
    err,
    loading,
    loadingMore,
    nextCursor,
    webhooks,
    loadPage,
    refresh,
  };
}

function useListWebhookRotation({
  listID,
  blocked,
  operation,
  onReveal,
  onRefresh,
}: {
  listID: string | null;
  blocked: boolean;
  operation: PersistentLifecycleOperation;
  onReveal: (response: ListScopedWebhookCreateResponse) => void;
  onRefresh: () => void;
}) {
  const mountedRef = useRef(true);
  const identityRef = useRef<{ webhookID: string; key: string } | null>(null);
  const [pendingRotate, setPendingRotate] = useState<ListScopedWebhook | null>(
    null,
  );
  const [rotateBusy, setRotateBusy] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestRotate = (webhook: ListScopedWebhook): void => {
    if (blocked || operation.promiseRef.current) return;
    if (identityRef.current?.webhookID !== webhook.id) {
      identityRef.current = null;
    }
    setPendingRotate(webhook);
  };

  const abandonRotate = (): void => {
    if (operation.promiseRef.current) return;
    identityRef.current = null;
    setPendingRotate(null);
  };

  const confirmRotate = async (): Promise<void> => {
    const target = pendingRotate;
    if (!target || !listID || blocked || operation.promiseRef.current) return;
    if (identityRef.current?.webhookID !== target.id) {
      identityRef.current = { webhookID: target.id, key: newUUIDv7() };
    }
    const idempotencyKey = identityRef.current.key;
    const pending = operation.run(() =>
      rotateListScopedWebhookSigningMaterial(listID, target.id, undefined, {
        idempotencyKey,
      }),
    );
    if (!pending) return;
    setRotateBusy(true);
    try {
      const result = await pending;
      if (!mountedRef.current) return;
      if (result.error) {
        toast.error(`Rotation failed: ${result.error.message}`);
        return;
      }
      identityRef.current = null;
      setPendingRotate(null);
      onReveal(result.data);
      toast.success(
        "Signing secret rotated — store it before leaving this view",
      );
      onRefresh();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          `Rotation failed: ${lifecycleOperationError(
            error,
            "The signing-secret rotation request failed.",
          )}`,
        );
      }
    } finally {
      if (mountedRef.current) setRotateBusy(false);
    }
  };

  return {
    abandonRotate,
    confirmRotate,
    pendingRotate,
    requestRotate,
    rotateBusy,
  };
}

function useAdminWebhooksController(list: List) {
  const mountedRef = useRef(true);
  const createIdentityRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const actionReasonId = useId();
  const listID = canonicalListID(list);
  const { err, loading, loadingMore, nextCursor, webhooks, loadPage, refresh } =
    useListWebhookCatalog(listID);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [revealed, setRevealed] =
    useState<ListScopedWebhookCreateResponse | null>(null);
  const [confirmSecretDiscard, setConfirmSecretDiscard] = useState(false);
  const secretLifecycle = useShownOnceSecretLifecycle(
    `list-webhook-${listID ?? "identity-missing"}-signing-secret`,
    "List webhook signing secret",
    revealed !== null,
  );
  const [addOpen, setAddOpen] = useState(false);
  const [whURL, setWhURL] = useState("");
  const [whEvents, setWhEvents] = useState<Set<ListScopedWebhookEvent>>(
    new Set(LIST_EVENTS),
  );
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ListScopedWebhook | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: `list-webhooks-${String(list.id)}`,
    label: "List webhook operation",
  });
  const defaultEventsSelected =
    whEvents.size === LIST_EVENTS.length &&
    LIST_EVENTS.every((event) => whEvents.has(event));
  const draftDirty = whURL !== "" || !defaultEventsSelected;
  const actionUnavailableReason = !listID
    ? "This list is missing its canonical Moosewave identity. Refresh Lists before configuring webhooks."
    : revealed
      ? "Store or explicitly discard the shown signing secret before starting another webhook action."
      : loading
        ? "Wait while Moosewave verifies the current webhook configuration."
        : loadingMore
          ? "Wait for the older webhook page to finish loading."
          : operation.active
            ? "Wait for the current webhook operation to finish."
            : null;

  const publishSecret = (response: ListScopedWebhookCreateResponse): void => {
    secretLifecycle.activate();
    setRevealed(response);
  };
  const rotation = useListWebhookRotation({
    listID,
    blocked: !listID || loading || loadingMore || revealed !== null,
    operation,
    onReveal: publishSecret,
    onRefresh: () => void refresh(),
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const discardAddDraft = useCallback((): void => {
    createIdentityRef.current = null;
    setWhURL("");
    setWhEvents(new Set(LIST_EVENTS));
    setDiscardConfirmOpen(false);
  }, []);

  useDiscardOnlyDraftLifecycle({
    ownerId: `list-webhook-create-${String(list.id)}`,
    label: `New webhook for ${list.name}`,
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardAddDraft,
    enabled: addOpen || draftDirty,
    detail:
      "This webhook URL or event selection has not been submitted. Return to it or explicitly discard it.",
  });

  const submitAdd = async (): Promise<void> => {
    const url = whURL.trim();
    if (!listID || !url || whEvents.size === 0 || actionUnavailableReason)
      return;
    const events = Array.from(whEvents);
    const input = { url, events };
    const fingerprint = JSON.stringify(input);
    if (createIdentityRef.current?.fingerprint !== fingerprint) {
      createIdentityRef.current = { fingerprint, key: newUUIDv7() };
    }
    const idempotencyKey = createIdentityRef.current.key;
    const pending = operation.run(() =>
      createListScopedWebhook(listID, input, { idempotencyKey }),
    );
    if (!pending) return;
    setSubmitting(true);
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error(`Couldn't add webhook: ${res.error.message}`);
        return;
      }
      const created = res.data;
      createIdentityRef.current = null;
      publishSecret(created);
      discardAddDraft();
      setAddOpen(false);
      toast.success("Webhook added — store the signing secret now");
      void refresh();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          `Couldn't add webhook: ${lifecycleOperationError(
            error,
            "The webhook request failed.",
          )}`,
        );
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const removeWebhook = (w: ListScopedWebhook): void => {
    // Stage for ConfirmModal — confirmRemoveWebhook() runs the API call.
    setPendingDelete(w);
  };

  const confirmRemoveWebhook = async (): Promise<void> => {
    if (!pendingDelete || !listID || loading || loadingMore || revealed) return;
    setDeleteBusy(true);
    const target = pendingDelete;
    const pending = operation.run(() =>
      deleteListScopedWebhook(listID, target.id),
    );
    if (!pending) {
      setDeleteBusy(false);
      return;
    }
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error(`Couldn't delete: ${res.error.message}`);
        return;
      }
      setPendingDelete(null);
      void refresh();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          `Couldn't delete: ${lifecycleOperationError(
            error,
            "The webhook delete request failed.",
          )}`,
        );
      }
    } finally {
      if (mountedRef.current) setDeleteBusy(false);
    }
  };

  const testWebhook = async (w: ListScopedWebhook): Promise<void> => {
    if (!listID || loading || loadingMore || revealed || !webhookCanTest(w))
      return;
    const pending = operation.run(() => testListScopedWebhook(listID, w.id));
    if (!pending) return;
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error(`Test failed: ${res.error.message}`);
        return;
      }
      if (res.data.filtered) {
        toast.info(
          "Test did not match the endpoint filter; no request was signed or sent.",
        );
        return;
      }
      const status = res.data.status_code;
      if (status >= 200 && status < 300 && res.data.signed) {
        toast.success(`Test fired — ${status}`);
      } else if (status >= 200 && status < 300) {
        toast.error("Test was not signed; review the endpoint configuration.");
      } else {
        toast.error(`Test returned HTTP ${status}`);
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          `Test failed: ${lifecycleOperationError(
            error,
            "The webhook test request failed.",
          )}`,
        );
      }
    }
  };

  const requestCloseAdd = (): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setAddOpen(false);
  };

  const discardAndCloseAdd = (): void => {
    if (operation.promiseRef.current) return;
    discardAddDraft();
    setAddOpen(false);
  };

  const openAdd = (): void => {
    if (actionUnavailableReason) return;
    discardAddDraft();
    setAddOpen(true);
  };

  const changeWhURL = (value: string): void => {
    if (value !== whURL) createIdentityRef.current = null;
    setWhURL(value);
  };

  const changeWhEvents = (events: Set<ListScopedWebhookEvent>): void => {
    createIdentityRef.current = null;
    setWhEvents(events);
  };

  const resolveSecret = (): void => {
    secretLifecycle.resolve();
    setConfirmSecretDiscard(false);
    setRevealed(null);
  };

  return {
    actionReasonId,
    actionUnavailableReason,
    addOpen,
    confirmSecretDiscard,
    deleteBusy,
    discardConfirmOpen,
    err,
    expanded,
    listID,
    loading,
    loadingMore,
    nextCursor,
    operation,
    pendingDelete,
    revealed,
    submitting,
    webhooks,
    whEvents,
    whURL,
    confirmRemoveWebhook,
    discardAndCloseAdd,
    loadPage,
    openAdd,
    removeWebhook,
    requestCloseAdd,
    rotation,
    resolveSecret,
    setConfirmSecretDiscard,
    setDiscardConfirmOpen,
    setExpanded,
    setPendingDelete,
    setWhEvents: changeWhEvents,
    setWhURL: changeWhURL,
    submitAdd,
    testWebhook,
  };
}

function AdminWebhooksTab({ list }: Props): ReactElement {
  const controller = useAdminWebhooksController(list);
  const {
    actionReasonId,
    actionUnavailableReason,
    addOpen,
    confirmSecretDiscard,
    deleteBusy,
    discardConfirmOpen,
    err,
    expanded,
    listID,
    loading,
    loadingMore,
    nextCursor,
    operation,
    pendingDelete,
    revealed,
    submitting,
    webhooks,
    whEvents,
    whURL,
    confirmRemoveWebhook,
    discardAndCloseAdd,
    loadPage,
    openAdd,
    removeWebhook,
    requestCloseAdd,
    rotation,
    resolveSecret,
    setConfirmSecretDiscard,
    setDiscardConfirmOpen,
    setExpanded,
    setPendingDelete,
    setWhEvents,
    setWhURL,
    submitAdd,
    testWebhook,
  } = controller;
  const {
    abandonRotate,
    confirmRotate,
    pendingRotate,
    requestRotate,
    rotateBusy,
  } = rotation;
  const liveActionBusy =
    operation.active || loading || loadingMore || revealed !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <WebhookTabHeader
        actionReasonId={actionReasonId}
        actionUnavailableReason={actionUnavailableReason}
        listName={list.name}
        onAdd={openAdd}
      />

      {err ? (
        <div
          className="notice"
          role={webhooks.length === 0 ? "alert" : "status"}
        >
          <span>Couldn&apos;t load webhooks: {err}</span>
          {webhooks.length === 0 && !loading ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void loadPage("", false)}
              style={{ marginLeft: 8 }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {loading && webhooks.length === 0 ? (
        <>
          <div className="skel-row" />
          <div className="skel-row" />
        </>
      ) : webhooks.length === 0 && !err ? (
        <div className="pw-chart-empty">
          No webhooks scoped to this list yet. Add one to receive a signed POST
          whenever a subscriber is added.
        </div>
      ) : (
        <WebhookRows
          listID={listID!}
          webhooks={webhooks}
          expanded={expanded}
          setExpanded={setExpanded}
          busy={liveActionBusy}
          actionReasonId={actionReasonId}
          onTest={testWebhook}
          onRotate={requestRotate}
          onRemove={removeWebhook}
        />
      )}
      {loading && webhooks.length > 0 ? (
        <div className="muted" role="status" style={{ fontSize: 11 }}>
          Refreshing webhooks… verified rows remain visible.
        </div>
      ) : null}

      {!loading && nextCursor ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={loadingMore || operation.active || revealed !== null}
          onClick={() => void loadPage(nextCursor, true)}
          style={{ alignSelf: "center" }}
        >
          {loadingMore ? "Loading older webhooks…" : "Load older webhooks"}
        </button>
      ) : null}

      <WebhookCreateModal
        open={addOpen}
        listName={list.name}
        url={whURL}
        setUrl={setWhURL}
        events={whEvents}
        setEvents={setWhEvents}
        busy={operation.active || loading || loadingMore}
        submitting={submitting}
        onClose={requestCloseAdd}
        onSubmit={submitAdd}
      />

      <WebhookSecretModal
        revealed={revealed}
        confirmDiscard={confirmSecretDiscard}
        onRequestDiscard={() => setConfirmSecretDiscard(true)}
        onKeepOpen={() => setConfirmSecretDiscard(false)}
        onResolve={resolveSecret}
      />

      <ConfirmModal
        open={pendingRotate !== null}
        title="Rotate signing secret?"
        description={
          pendingRotate
            ? `Generate a new one-time signing secret for ${pendingRotate.url}? Moosewave will dual-sign during the 24-hour grace window so you can update the receiver without an abrupt cutover.`
            : ""
        }
        confirmLabel="Rotate secret"
        busy={rotateBusy || operation.active}
        onConfirm={confirmRotate}
        onClose={abandonRotate}
      />

      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard webhook draft?"
        description="The webhook URL and event selection in this draft will be lost."
        confirmLabel="Discard draft"
        danger
        busy={operation.active}
        onConfirm={discardAndCloseAdd}
        onClose={() => setDiscardConfirmOpen(false)}
      />

      {/* Delete-webhook confirm. Replaces the legacy native confirm() so
          the destructive prompt matches the rest of the admin surface
          and works inside Tauri webviews. */}
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete webhook?"
        description={
          pendingDelete
            ? `Permanently tombstone ${pendingDelete.url}? Pending deliveries will be cancelled as “skipped,” signing/destination secrets are shredded immediately, and an HTTP request already in flight may still finish. Value-free delivery evidence remains until retention purges it.`
            : ""
        }
        confirmLabel="Delete webhook"
        typeToConfirm="DELETE"
        danger
        busy={deleteBusy || liveActionBusy}
        confirmDisabled={loading || loadingMore || revealed !== null}
        onConfirm={(): Promise<void> => confirmRemoveWebhook()}
        onClose={(): void => setPendingDelete(null)}
      />
    </div>
  );
}

function WebhookRows({
  listID,
  webhooks,
  expanded,
  setExpanded,
  busy,
  actionReasonId,
  onTest,
  onRotate,
  onRemove,
}: {
  listID: string;
  webhooks: ListScopedWebhook[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  busy: boolean;
  actionReasonId: string;
  onTest: (webhook: ListScopedWebhook) => Promise<void>;
  onRotate: (webhook: ListScopedWebhook) => void;
  onRemove: (webhook: ListScopedWebhook) => void;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {webhooks.map((webhook) => (
        <div
          key={webhook.id}
          style={{
            background: "var(--pw-bg-elev-2)",
            borderRadius: 4,
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto auto auto",
              gap: 8,
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: "var(--pw-fg)",
                  fontSize: 12,
                }}
                title={webhook.url}
              >
                {webhook.url}
              </div>
              <div className="muted" style={{ fontSize: 10 }}>
                {webhook.events.join(", ")}
              </div>
              <div
                className="muted"
                style={{
                  fontSize: 10,
                  color: webhookCanTest(webhook)
                    ? "var(--pw-fg-muted)"
                    : "var(--pw-warning, #d79b31)",
                }}
              >
                {readinessLabel(webhook)}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (busy || !webhookCanTest(webhook)) return;
                void onTest(webhook);
              }}
              aria-disabled={busy || !webhookCanTest(webhook) || undefined}
              aria-describedby={busy ? actionReasonId : undefined}
              title={
                busy
                  ? undefined
                  : (webhookTestUnavailableReason(webhook) ?? undefined)
              }
            >
              Test
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                if (busy) return;
                onRotate(webhook);
              }}
              aria-disabled={busy || undefined}
              aria-describedby={busy ? actionReasonId : undefined}
            >
              Rotate secret
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                setExpanded(expanded === webhook.id ? null : webhook.id)
              }
              aria-expanded={expanded === webhook.id}
            >
              {expanded === webhook.id ? "Hide deliveries" : "Deliveries"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                if (busy) return;
                onRemove(webhook);
              }}
              aria-disabled={busy || undefined}
              aria-describedby={busy ? actionReasonId : undefined}
              aria-label={`Delete webhook ${webhook.url}`}
            >
              ×
            </button>
          </div>
          {expanded === webhook.id ? (
            <DeliveriesPanel listID={listID} webhookId={webhook.id} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function WebhookCreateModal({
  open,
  listName,
  url,
  setUrl,
  events,
  setEvents,
  busy,
  submitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  listName: string;
  url: string;
  setUrl: (url: string) => void;
  events: Set<ListScopedWebhookEvent>;
  setEvents: (events: Set<ListScopedWebhookEvent>) => void;
  busy: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}): ReactElement {
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      title={`Add webhook to ${listName}`}
      description="POSTs a signed payload when a subscriber is added to this list."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void onSubmit();
        }}
      >
        <FormField label="URL" required htmlFor="lwt-url">
          <input
            id="lwt-url"
            className="input"
            type="url"
            placeholder="https://example.com/postwave-hook"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            autoComplete="url"
            spellCheck={false}
            required
          />
        </FormField>
        <FormField label="Events" required>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {LIST_EVENTS.map((item) => (
              <label
                key={item}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                }}
              >
                <input
                  type="checkbox"
                  checked={events.has(item)}
                  onChange={(event) => {
                    const next = new Set(events);
                    if (event.target.checked) next.add(item);
                    else next.delete(item);
                    setEvents(next);
                  }}
                />
                <code>{item}</code>
              </label>
            ))}
          </div>
        </FormField>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !url.trim() || events.size === 0}
          >
            {submitting ? "Adding…" : "Add webhook"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function WebhookSecretModal({
  revealed,
  confirmDiscard,
  onRequestDiscard,
  onKeepOpen,
  onResolve,
}: {
  revealed: ListScopedWebhookCreateResponse | null;
  confirmDiscard: boolean;
  onRequestDiscard: () => void;
  onKeepOpen: () => void;
  onResolve: () => void;
}): ReactElement {
  const [stored, setStored] = useState(false);
  const helpID = useId();

  useEffect(() => {
    setStored(false);
  }, [revealed?.id, revealed?.signing_secret]);

  return (
    <>
      <Modal
        open={revealed !== null}
        onClose={() => {
          if (stored) onResolve();
          else onRequestDiscard();
        }}
        closeOnBackdrop={false}
        closeOnEscape={false}
        title="Store your signing secret"
        description="This HMAC-SHA256 secret is shown exactly once. Moosewave cannot retrieve it for you after this dialog closes."
      >
        {revealed ? (
          <>
            <div className="field">
              <div className="label">Receiver display address</div>
              <div className="copy-text mono">{revealed.url}</div>
              <p className="field-help">
                This read-only address intentionally hides the complete path and
                query. It is not a usable replacement destination.
              </p>
            </div>
            <div className="field">
              <div className="label">Shared signing secret</div>
              <pre className="wh-verification-snippet">
                <code>{revealed.signing_secret}</code>
              </pre>
              <CopyButton
                value={revealed.signing_secret}
                label="Copy signing secret"
                ariaLabel="Copy the one-time list webhook signing secret"
                contentClass="secret"
                clearIfUnchangedAfterMs={60_000}
              />
              <p className="field-help">
                Parse <code>X-Postwave-Signature</code> as{" "}
                <code>t=&lt;unix-seconds&gt;,v1=&lt;digest&gt;</code>, reject
                stale timestamps, and compare <code>v1</code> against an HMAC of
                the exact raw body in constant time. During rotation, accept
                either valid signature only for the advertised grace window.
                Never authorize a request from unsigned auxiliary{" "}
                <code>X-Postwave-*</code> headers. Store this value in an
                approved secret manager, not source control.
              </p>
            </div>
            <label
              style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
            >
              <input
                type="checkbox"
                checked={stored}
                onChange={(event) => setStored(event.target.checked)}
                style={{ width: 20, height: 20 }}
              />
              <span>
                I stored this secret securely and understand it cannot be shown
                again.
              </span>
            </label>
            {!stored ? (
              <p id={helpID} className="field-help">
                Confirm secure storage before closing this one-time view.
              </p>
            ) : null}
          </>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onRequestDiscard}
          >
            Discard shown secret…
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!stored}
            aria-describedby={!stored ? helpID : undefined}
            onClick={onResolve}
          >
            I&apos;ve stored it securely
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmDiscard}
        title="Discard the shown signing secret?"
        description="This value cannot be recovered. The webhook remains active, so use Rotate secret on this list before relying on receiver verification."
        confirmLabel="Discard shown value"
        cancelLabel="Keep it open"
        danger
        onConfirm={onResolve}
        onClose={onKeepOpen}
      />
    </>
  );
}

/* ---------- delivery history drawer ------------------------------- */

function DeliveriesPanel({
  listID,
  webhookId,
}: {
  listID: string;
  webhookId: string;
}): ReactElement {
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadedCursorsRef = useRef<Set<string>>(new Set());
  const itemsRef = useRef<OutboundWebhookDelivery[]>([]);
  const [items, setItems] = useState<OutboundWebhookDelivery[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestSequenceRef.current;
    loadedCursorsRef.current.clear();
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setErr(null);
    itemsRef.current = [];
    setItems([]);
    setNextCursor("");
    void (async () => {
      try {
        const res = await listListScopedWebhookDeliveries(listID, webhookId, {
          limit: 50,
        });
        if (
          cancelled ||
          !mountedRef.current ||
          requestId !== requestSequenceRef.current
        )
          return;
        if (res.error) {
          setErr(res.error.message);
        } else {
          itemsRef.current = res.data.deliveries;
          setItems(res.data.deliveries);
          setNextCursor(res.data.next_cursor);
        }
      } catch (error) {
        if (
          cancelled ||
          !mountedRef.current ||
          requestId !== requestSequenceRef.current
        )
          return;
        setErr(lifecycleOperationError(error, "Couldn't load deliveries."));
      } finally {
        if (
          !cancelled &&
          mountedRef.current &&
          requestId === requestSequenceRef.current
        ) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, [listID, webhookId]);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loadingMoreRef.current) return;
    const cursor = nextCursor;
    if (loadedCursorsRef.current.has(cursor)) {
      setErr(
        "Moosewave returned a repeated delivery cursor. Verified deliveries remain visible; close and reopen the history before loading more.",
      );
      setNextCursor("");
      return;
    }
    const requestId = ++requestSequenceRef.current;
    loadedCursorsRef.current.add(cursor);
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setErr(null);
    try {
      const res = await listListScopedWebhookDeliveries(listID, webhookId, {
        limit: 50,
        cursor,
      });
      if (!mountedRef.current || requestId !== requestSequenceRef.current)
        return;
      if (res.error) {
        loadedCursorsRef.current.delete(cursor);
        setErr(res.error.message);
        return;
      }
      const existingIDs = new Set(
        itemsRef.current.map((delivery) => delivery.id),
      );
      if (
        res.data.deliveries.some((delivery) => existingIDs.has(delivery.id))
      ) {
        setErr(
          "Moosewave returned a delivery already present in an earlier page. The entire unverified page was rejected.",
        );
        setNextCursor("");
        return;
      }
      const combined = [...itemsRef.current, ...res.data.deliveries];
      itemsRef.current = combined;
      setItems(combined);
      if (
        res.data.next_cursor &&
        loadedCursorsRef.current.has(res.data.next_cursor)
      ) {
        setErr(
          "Moosewave returned a repeated delivery cursor. Verified deliveries remain visible; close and reopen the history before loading more.",
        );
        setNextCursor("");
      } else {
        setNextCursor(res.data.next_cursor);
      }
    } catch (error) {
      if (!mountedRef.current || requestId !== requestSequenceRef.current)
        return;
      loadedCursorsRef.current.delete(cursor);
      setErr(lifecycleOperationError(error, "Couldn't load older deliveries."));
    } finally {
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  if (loading && items.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 11, paddingLeft: 4 }}>
        Loading deliveries…
      </div>
    );
  }
  if (err && items.length === 0) {
    return (
      <div
        className="muted"
        role="alert"
        style={{ fontSize: 11, paddingLeft: 4 }}
      >
        Couldn&apos;t load deliveries: {err}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 11, paddingLeft: 4 }}>
        No deliveries recorded yet.
      </div>
    );
  }
  return (
    <div
      style={{
        borderTop: "1px solid var(--pw-border)",
        paddingTop: 6,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {err ? (
        <div className="muted" role="status" style={{ fontSize: 11 }}>
          Couldn&apos;t load older deliveries: {err} Verified deliveries remain
          visible.
        </div>
      ) : null}
      {items.map((d) => (
        <div
          key={d.id}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 60px 70px 130px",
            gap: 8,
            alignItems: "baseline",
            fontSize: 11,
            padding: "2px 4px",
          }}
          title={safeDeliveryEvidence(d)}
        >
          <span
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "var(--pw-fg)",
            }}
          >
            {d.event_type}
          </span>
          <span
            className="tabular"
            style={{
              textAlign: "right",
              color:
                d.last_status_code && d.last_status_code >= 400
                  ? "var(--pw-danger)"
                  : "var(--pw-fg-muted)",
            }}
          >
            {d.last_status_code ?? "—"}
          </span>
          <span className="muted" style={{ fontSize: 10 }}>
            {d.status}
          </span>
          <span
            className="muted tabular"
            style={{ fontSize: 10, textAlign: "right" }}
          >
            {fmtDateTime(d.delivered_at ?? d.created_at)}
          </span>
        </div>
      ))}
      {nextCursor ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          style={{ alignSelf: "center", marginTop: 4 }}
        >
          {loadingMore ? "Loading older deliveries…" : "Load older deliveries"}
        </button>
      ) : null}
    </div>
  );
}
