/**
 * Admin-only outbound webhook workspace backed exclusively by the canonical
 * `/api/v1/outbound-webhooks` service also used by Webhook Simulator.
 */

import {
  type MutableRefObject,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { InlineHelp } from "../components/InlineHelp";
import { Modal, ModalFooter } from "../components/Modal";
import { Notice } from "../components/Notice";
import { OutboundWebhookDeliveriesSlideover } from "../components/OutboundWebhookDeliveriesSlideover";
import { PageHeader } from "../components/PageHeader";
import { StatStrip, type StatCell } from "../components/StatStrip";
import { toast } from "../components/Toast";
import { BulkActionsBar } from "../components/webhooks/BulkActionsBar";
import { EventCatalogDialog } from "../components/webhooks/EventCatalogDialog";
import { OutboundWebhookEditDialog } from "../components/webhooks/OutboundWebhookEditDialog";
import {
  type ReceiverPreset,
  RECEIVER_PRESETS,
  ReceiverPresetDialog,
} from "../components/webhooks/ReceiverPresetDialog";
import { WebhookOnboardingGallery } from "../components/webhooks/WebhookOnboardingGallery";
import {
  sanitizeInspectableText,
  sanitizeInspectableUrl,
} from "../components/webhook-simulator/ResponseInspector";
import { useShownOnceSecretLifecycle } from "../hooks/useShownOnceSecretLifecycle";
import {
  lifecycleOperationError,
  type SingleFlightOperation,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import {
  deleteOutboundWebhook,
  listOutboundWebhooks,
  reEnableOutboundWebhook,
  rotateOutboundWebhookSigningMaterial,
  testOutboundWebhook,
  type OutboundWebhook,
  type OutboundWebhookCreateResponse,
} from "../lib/api-client";
import { clipboardSuccessDetail, writeClipboardText } from "../lib/clipboard";
import { HERO } from "../lib/heroAssets";
import { newUUIDv7 } from "../lib/http-fetch";
import { useCanAdmin } from "../lib/store";
import "../styles-webhooks.css";

const TABLE_COLUMNS =
  "36px minmax(210px, 1.5fr) minmax(120px, .7fr) minmax(190px, 1.05fr) minmax(180px, 1fr) minmax(280px, .9fr)";
const OUTBOUND_PAGE_LIMIT = 50;
const OUTBOUND_SEARCH_DEBOUNCE_MS = 250;

interface LoadError {
  message: string;
  contract: boolean;
}

interface RevealedMaterial {
  reason: "created" | "rotated";
  response: OutboundWebhookCreateResponse;
}

interface SafeTestResult {
  statusCode: number;
  response: string;
  error?: string;
  redactedCount: number;
  filtered: boolean;
  signed: boolean;
}

function exactTimestamp(value: string | undefined): ReactElement | string {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return (
    <time dateTime={parsed.toISOString()} className="tabular">
      {parsed.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "long",
      })}
    </time>
  );
}

function inspectableWebhookURL(url: string): string {
  return sanitizeInspectableUrl(url).url;
}

function webhookStatus(webhook: OutboundWebhook): {
  label: string;
  badge: string;
  detail: string;
} {
  if (webhook.url_status === "invalid") {
    return {
      label: "URL blocked",
      badge: "badge danger",
      detail: "Enter a complete replacement URL in Edit before delivery.",
    };
  }
  if (webhook.url_status === "legacy_pending") {
    return {
      label: "URL migration",
      badge: "badge warning",
      detail:
        "The destination is being moved to encrypted storage. Delivery is held.",
    };
  }
  if (webhook.delivery_policy_status === "invalid") {
    return {
      label: "Policy blocked",
      badge: "badge danger",
      detail: "Repair the event filter or payload projection in Edit.",
    };
  }
  if (webhook.auth_config_status === "invalid") {
    return {
      label: "Auth blocked",
      badge: "badge danger",
      detail:
        "Stored receiver credentials are invalid. Replace or clear them before delivery.",
    };
  }
  if (webhook.auth_config_status === "legacy_pending") {
    return {
      label: "Auth migration",
      badge: "badge warning",
      detail:
        "Receiver credentials are being encrypted. Live delivery is temporarily held.",
    };
  }
  if (!webhook.active) {
    return {
      label:
        webhook.disabled_reason === "auto_failures" ? "Auto-paused" : "Paused",
      badge: "badge warning",
      detail:
        webhook.disabled_reason === "auto_failures"
          ? "Moosewave paused delivery after repeated receiver failures."
          : "New events and pending delivery attempts are paused.",
    };
  }
  if (webhook.consecutive_failures > 0) {
    return {
      label: "Active",
      badge: "badge warning",
      detail: `${webhook.consecutive_failures.toLocaleString()} consecutive failure${webhook.consecutive_failures === 1 ? "" : "s"}.`,
    };
  }
  return {
    label: "Active",
    badge: "badge success",
    detail: "No consecutive failures recorded.",
  };
}

function deliverySetupBlock(webhook: OutboundWebhook): string | null {
  if (
    webhook.url_status === "invalid" ||
    webhook.url_status === "legacy_pending"
  ) {
    return "Replace the complete destination URL in Edit, or wait for URL migration to finish.";
  }
  if (
    webhook.auth_config_status === "invalid" ||
    webhook.auth_config_status === "legacy_pending"
  ) {
    return "Repair receiver authentication in Edit, or wait for credential migration to finish.";
  }
  if (webhook.delivery_policy_status === "invalid") {
    return "Repair the event filter or payload projection in Edit.";
  }
  return null;
}

function actionableOutboundError(
  code: string | undefined,
  fallback: string,
): string {
  switch (code) {
    case "not_found":
      return "This destination no longer exists. Refresh the list before continuing.";
    case "cipher_unconfigured":
      return "Server-side secret encryption is not configured. Ask a workspace administrator to configure the outbound-webhook cipher before testing.";
    case "delivery_configuration_pending":
      return "Secure destination or receiver-auth migration is still running. Wait until the destination reports Ready, then retry.";
    case "destination_unavailable":
      return "The destination is unavailable. Open Edit and enter the complete replacement URL.";
    case "receiver_auth_unavailable":
      return "Receiver authentication is unavailable. Open Edit to replace or clear the credentials.";
    case "delivery_configuration_invalid":
      return "The event filter or payload projection is invalid. Open Edit, repair the delivery policy, and save it before retrying.";
    default:
      return fallback;
  }
}

function receiverAuthSummary(webhook: OutboundWebhook): string {
  const auth = webhook.auth_config;
  if (!auth || !auth.secret_redacted) return "Receiver auth: none";
  const methods: string[] = [];
  if (auth.bearer_configured) methods.push("Bearer");
  if ((auth.header_names?.length ?? 0) > 0) {
    methods.push(
      `${auth.header_names!.length} custom header${
        auth.header_names!.length === 1 ? "" : "s"
      }`,
    );
  }
  if (auth.mtls_configured) methods.push("mTLS");
  return `Receiver auth: ${methods.length > 0 ? methods.join(" + ") : auth.type || "configured"}`;
}

function useDebouncedOutboundQuery(query: string): string {
  const normalized = query.trim();
  const [debounced, setDebounced] = useState(normalized);
  useEffect(() => {
    if (normalized === debounced) return;
    const timer = window.setTimeout(
      () => setDebounced(normalized),
      OUTBOUND_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [debounced, normalized]);
  return debounced;
}

function buildStats(rows: OutboundWebhook[] | null): StatCell[] {
  if (!rows) {
    return ["Loaded destinations", "Active", "Paused", "Needs attention"].map(
      (label) => ({ label, value: "—" }),
    );
  }
  const active = rows.filter((row) => row.active).length;
  const paused = rows.length - active;
  const attention = rows.filter(
    (row) =>
      row.disabled_reason === "auto_failures" ||
      (row.active && row.consecutive_failures > 0) ||
      row.auth_config_status === "legacy_pending" ||
      row.auth_config_status === "invalid" ||
      row.url_status === "legacy_pending" ||
      row.url_status === "invalid" ||
      row.delivery_policy_status === "invalid",
  ).length;
  return [
    {
      label: "Loaded destinations",
      value: rows.length.toLocaleString(),
      hint: "Rows loaded for the current server query. Additional cursor pages may still be available.",
    },
    {
      label: "Active",
      value: active.toLocaleString(),
      hint: "Authoritative active=true rows among the loaded query pages.",
    },
    {
      label: "Paused",
      value: paused.toLocaleString(),
      hint: "Authoritative active=false rows among the loaded query pages. Delivery history is retained.",
    },
    {
      label: "Needs attention",
      value: attention.toLocaleString(),
      hint: "Loaded rows with a failure streak or destination, receiver-auth, or delivery-policy setup that is not ready.",
    },
  ];
}

async function copyWebhookValue(text: string, label: string): Promise<string> {
  const credentialBearingURL =
    label.toLowerCase().includes("url") &&
    sanitizeInspectableUrl(text).redactedCount > 0;
  const sensitive =
    credentialBearingURL ||
    /secret|private key|credential/i.test(label) ||
    text.includes("PRIVATE KEY");
  const result = await writeClipboardText(text, {
    contentClass: sensitive ? "secret" : "public",
    label,
    clearIfUnchangedAfterMs: sensitive ? 60_000 : undefined,
  });
  if (!result.ok) {
    toast.error(result.message);
    return `${label} wasn't copied. ${result.message}`;
  }
  const detail = clipboardSuccessDetail(result);
  toast.success({ message: `${label} copied`, detail });
  return `${label} copied. ${detail}`;
}

function SelectAllCheckbox({
  checked,
  mixed,
  disabled,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  onChange: () => void;
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all loaded webhooks in this query"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      style={{ width: 20, height: 20 }}
    />
  );
}

type BulkKind = "resume" | "pause" | "delete";

const BULK_COPY: Record<BulkKind, { past: string; failure: string }> = {
  resume: { past: "Resumed", failure: "Resume failed" },
  pause: { past: "Paused", failure: "Pause failed" },
  delete: { past: "Deleted", failure: "Delete failed" },
};

function useCanonicalBulkActions({
  rows,
  filtered,
  scopeKey,
  operation,
  activeRef,
  onReload,
  onStatus,
}: {
  rows: OutboundWebhook[] | null;
  filtered: OutboundWebhook[];
  scopeKey: string;
  operation: SingleFlightOperation;
  activeRef: MutableRefObject<boolean>;
  onReload: () => void;
  onStatus: (status: string) => void;
}) {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCheckedIds(new Set());
  }, [scopeKey]);

  useEffect(() => {
    if (!rows) return;
    const valid = new Set(rows.map((row) => row.id));
    setCheckedIds(
      (current) => new Set([...current].filter((id) => valid.has(id))),
    );
  }, [rows]);

  const visibleIds = useMemo(
    () => new Set(filtered.map((row) => row.id)),
    [filtered],
  );
  const selectedVisible = filtered.filter((row) =>
    checkedIds.has(row.id),
  ).length;
  const allVisibleChecked =
    filtered.length > 0 && selectedVisible === filtered.length;
  const mixedVisible = selectedVisible > 0 && !allVisibleChecked;
  const hiddenCount = [...checkedIds].filter(
    (id) => !visibleIds.has(id),
  ).length;

  const run = async (kind: BulkKind): Promise<void> => {
    if (checkedIds.size === 0 || busy || operation.promiseRef.current) return;
    const ids = [...checkedIds];
    const request = operation.run(async () => {
      const failedIds: string[] = [];
      for (const id of ids) {
        try {
          const result =
            kind === "resume"
              ? await reEnableOutboundWebhook(id)
              : await deleteOutboundWebhook(id, { soft: kind === "pause" });
          if (result.error) failedIds.push(id);
        } catch {
          failedIds.push(id);
        }
      }
      return { succeeded: ids.length - failedIds.length, failedIds };
    });
    if (!request) return;
    setBusy(true);
    try {
      const result = await request;
      if (!activeRef.current) return;
      const failed = result.failedIds.length;
      setCheckedIds(new Set(result.failedIds));
      const status =
        failed > 0
          ? `${BULK_COPY[kind].past} ${result.succeeded}; ${failed} failed and remain selected for retry.`
          : `${BULK_COPY[kind].past} ${result.succeeded} webhook${result.succeeded === 1 ? "" : "s"}.`;
      onStatus(status);
      if (failed > 0) toast.error(status);
      else toast.success(status);
      onReload();
    } catch (error) {
      if (activeRef.current) {
        const message = sanitizeInspectableText(
          lifecycleOperationError(error, "The bulk request failed."),
        ).text;
        toast.error(`${BULK_COPY[kind].failure}: ${message}`);
      }
    } finally {
      if (activeRef.current) setBusy(false);
    }
  };

  return {
    checkedIds,
    busy,
    allVisibleChecked,
    mixedVisible,
    hiddenCount,
    toggle(id: string) {
      setCheckedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    toggleAll() {
      setCheckedIds((current) => {
        const next = new Set(current);
        for (const row of filtered) {
          if (allVisibleChecked) next.delete(row.id);
          else next.add(row.id);
        }
        return next;
      });
    },
    clear: () => setCheckedIds(new Set()),
    resume: () => run("resume"),
    pause: () => run("pause"),
    remove: () => run("delete"),
  };
}

type BulkController = ReturnType<typeof useCanonicalBulkActions>;

function AdminRequired(): ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Connections"
        title="Outbound webhooks"
        subtitle="Outbound destinations expose signing metadata and can send or replay live traffic."
      />
      <Notice tone="danger" announcement="assertive">
        Workspace admin access is required to view or manage outbound webhook
        destinations. This surface does not expose a partial read-only mode.
      </Notice>
    </>
  );
}

export function OutboundWebhooks(): ReactElement {
  const canAdmin = useCanAdmin();
  return canAdmin ? <OutboundWebhooksAdmin /> : <AdminRequired />;
}

interface OutboundCatalogController {
  rows: OutboundWebhook[] | null;
  visibleRows: OutboundWebhook[] | null;
  loading: boolean;
  loadingMore: boolean;
  loadError: LoadError | null;
  moreError: LoadError | null;
  nextCursor: string | null;
  appliedQuery: string;
  queryScopeKey: string;
  searchPending: boolean;
  activeRef: MutableRefObject<boolean>;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
}

function ownsOutboundRequest(
  activeRef: MutableRefObject<boolean>,
  controller: AbortController,
  sequence: number,
  currentSequence: number,
): boolean {
  return (
    activeRef.current &&
    !controller.signal.aborted &&
    sequence === currentSequence
  );
}

function validateOutboundCursorPage(
  webhooks: OutboundWebhook[],
  cursor: string,
  rawNext: string,
  loadedIds: Set<string>,
  loadedCursors: Set<string>,
): {
  pageIds: Set<string>;
  next: string | null;
  error: LoadError | null;
} {
  const pageIds = new Set<string>();
  for (const webhook of webhooks) {
    if (pageIds.has(webhook.id) || loadedIds.has(webhook.id)) {
      return {
        pageIds,
        next: null,
        error: {
          message:
            "Moosewave repeated a destination across cursor pages. Pagination stopped before any duplicate or partial page was accepted.",
          contract: true,
        },
      };
    }
    pageIds.add(webhook.id);
  }
  const next = rawNext || null;
  if (next && (next === cursor || loadedCursors.has(next))) {
    return {
      pageIds,
      next: null,
      error: {
        message:
          "Moosewave repeated an outbound-webhook pagination cursor. Pagination stopped safely before another request could loop.",
        contract: true,
      },
    };
  }
  return { pageIds, next, error: null };
}

function useOutboundWebhookCatalog(query: string): OutboundCatalogController {
  const [rows, setRows] = useState<OutboundWebhook[] | null>(null);
  const [rowsScope, setRowsScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [moreError, setMoreError] = useState<LoadError | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const appliedQuery = useDebouncedOutboundQuery(query);
  const queryScopeKey = query.trim();
  const searchPending = queryScopeKey !== appliedQuery;
  const activeRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const loadFlightRef = useRef<Promise<void> | null>(null);
  const loadMoreFlightRef = useRef<Promise<void> | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadedIdsRef = useRef<Set<string>>(new Set());
  const loadedCursorsRef = useRef<Set<string>>(new Set());
  const rawQueryScopeRef = useRef(queryScopeKey);

  const load = useCallback((): Promise<void> => {
    if (loadFlightRef.current) return loadFlightRef.current;
    const sequence = ++loadSequenceRef.current;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setLoadError(null);
    setMoreError(null);
    setNextCursor(null);
    loadMoreFlightRef.current = null;
    const flight = (async (): Promise<void> => {
      try {
        const result = await listOutboundWebhooks({
          signal: controller.signal,
          requireOnline: true,
          limit: OUTBOUND_PAGE_LIMIT,
          ...(appliedQuery ? { query: appliedQuery } : {}),
        });
        if (
          !ownsOutboundRequest(
            activeRef,
            controller,
            sequence,
            loadSequenceRef.current,
          )
        ) {
          return;
        }
        if (result.error) {
          if (result.error.code !== "aborted") {
            setLoadError({
              message: sanitizeInspectableText(result.error.message).text,
              contract: result.error.code === "outbound_webhook_contract",
            });
          }
          return;
        }
        const ids = new Set<string>();
        for (const webhook of result.data.webhooks) {
          if (ids.has(webhook.id)) {
            setLoadError({
              message:
                "Moosewave repeated a destination inside the first page. The last verified rows remain unchanged and no duplicate was accepted.",
              contract: true,
            });
            return;
          }
          ids.add(webhook.id);
        }
        const next = result.data.next_cursor || null;
        loadedIdsRef.current = ids;
        loadedCursorsRef.current = new Set(next ? [next] : []);
        setRows(result.data.webhooks);
        setRowsScope(appliedQuery);
        setNextCursor(next);
        setLoadError(null);
      } catch (error) {
        if (
          activeRef.current &&
          !controller.signal.aborted &&
          sequence === loadSequenceRef.current
        ) {
          setLoadError({
            message: sanitizeInspectableText(
              lifecycleOperationError(
                error,
                "The outbound webhook request failed.",
              ),
            ).text,
            contract: false,
          });
        }
      } finally {
        if (
          activeRef.current &&
          !controller.signal.aborted &&
          sequence === loadSequenceRef.current
        ) {
          setLoading(false);
        }
        if (sequence === loadSequenceRef.current) {
          loadFlightRef.current = null;
        }
        if (loadControllerRef.current === controller) {
          loadControllerRef.current = null;
        }
      }
    })();
    loadFlightRef.current = flight;
    return flight;
  }, [appliedQuery]);

  const loadMore = useCallback((): Promise<void> => {
    if (loadMoreFlightRef.current) return loadMoreFlightRef.current;
    if (!nextCursor || loading || rowsScope !== appliedQuery || searchPending) {
      return Promise.resolve();
    }
    const cursor = nextCursor;
    const scope = appliedQuery;
    const sequence = loadSequenceRef.current;
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoadingMore(true);
    setMoreError(null);
    const flight = (async (): Promise<void> => {
      try {
        const result = await listOutboundWebhooks({
          signal: controller.signal,
          requireOnline: true,
          cursor,
          limit: OUTBOUND_PAGE_LIMIT,
          ...(scope ? { query: scope } : {}),
        });
        if (
          !ownsOutboundRequest(
            activeRef,
            controller,
            sequence,
            loadSequenceRef.current,
          )
        ) {
          return;
        }
        if (result.error) {
          if (result.error.code !== "aborted") {
            setMoreError({
              message: sanitizeInspectableText(result.error.message).text,
              contract: result.error.code === "outbound_webhook_contract",
            });
          }
          return;
        }
        const validation = validateOutboundCursorPage(
          result.data.webhooks,
          cursor,
          result.data.next_cursor,
          loadedIdsRef.current,
          loadedCursorsRef.current,
        );
        if (validation.error) {
          setMoreError(validation.error);
          setNextCursor(null);
          return;
        }
        setRows((current) => [...(current ?? []), ...result.data.webhooks]);
        for (const id of validation.pageIds) loadedIdsRef.current.add(id);
        if (validation.next) loadedCursorsRef.current.add(validation.next);
        setNextCursor(validation.next);
        setMoreError(null);
      } catch (error) {
        if (
          ownsOutboundRequest(
            activeRef,
            controller,
            sequence,
            loadSequenceRef.current,
          )
        ) {
          setMoreError({
            message: sanitizeInspectableText(
              lifecycleOperationError(
                error,
                "More outbound destinations couldn't be loaded. Check your connection and retry.",
              ),
            ).text,
            contract: false,
          });
        }
      } finally {
        if (
          ownsOutboundRequest(
            activeRef,
            controller,
            sequence,
            loadSequenceRef.current,
          )
        ) {
          setLoadingMore(false);
        }
        if (sequence === loadSequenceRef.current) {
          loadMoreFlightRef.current = null;
        }
        if (loadControllerRef.current === controller) {
          loadControllerRef.current = null;
        }
      }
    })();
    loadMoreFlightRef.current = flight;
    return flight;
  }, [appliedQuery, loading, nextCursor, rowsScope, searchPending]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      loadSequenceRef.current += 1;
      loadControllerRef.current?.abort();
      loadFlightRef.current = null;
      loadMoreFlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadSequenceRef.current += 1;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      loadFlightRef.current = null;
      loadMoreFlightRef.current = null;
    };
  }, [load]);

  useEffect(() => {
    const scopeChanged = rawQueryScopeRef.current !== queryScopeKey;
    rawQueryScopeRef.current = queryScopeKey;
    if (!scopeChanged) return;
    loadSequenceRef.current += 1;
    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    loadFlightRef.current = null;
    loadMoreFlightRef.current = null;
    setLoading(false);
    setLoadingMore(false);
    setLoadError(null);
    setMoreError(null);
    if (queryScopeKey === appliedQuery) void load();
  }, [appliedQuery, load, queryScopeKey]);

  return {
    rows,
    visibleRows: !searchPending && rowsScope === appliedQuery ? rows : null,
    loading,
    loadingMore,
    loadError,
    moreError,
    nextCursor,
    appliedQuery,
    queryScopeKey,
    searchPending,
    activeRef,
    load,
    loadMore,
  };
}

function useOutboundWebhookActionState(catalog: OutboundCatalogController) {
  const { rows, loading, loadingMore, queryScopeKey, activeRef } = catalog;
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState<OutboundWebhook | null>(null);
  const [editing, setEditing] = useState<OutboundWebhook | null>(null);
  const [preset, setPreset] = useState<ReceiverPreset | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [testTarget, setTestTarget] = useState<OutboundWebhook | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SafeTestResult | null>(null);
  const [pauseTarget, setPauseTarget] = useState<OutboundWebhook | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OutboundWebhook | null>(
    null,
  );
  const [rotateTarget, setRotateTarget] = useState<OutboundWebhook | null>(
    null,
  );
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [bulkPauseOpen, setBulkPauseOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [revealed, setRevealed] = useState<RevealedMaterial | null>(null);
  const [confirmSecretClose, setConfirmSecretClose] = useState(false);
  const copyFlightRef = useRef<Promise<void> | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: "canonical-outbound-webhook-action",
    label: "Outbound webhook operation",
    detail: "Wait for the live webhook request to finish before leaving.",
  });
  const secretLifecycle = useShownOnceSecretLifecycle(
    "canonical-outbound-webhook-signing-material",
    "Outbound webhook signing material",
    revealed?.response.webhook.signing_algorithm === "hmac_sha256" &&
      Boolean(revealed.response.signing_secret),
  );

  useEffect(() => {
    setSelected(null);
    setEditing(null);
    setTestTarget(null);
    setTestError(null);
    setTestResult(null);
    setPauseTarget(null);
    setDeleteTarget(null);
    setRotateTarget(null);
    setBulkPauseOpen(false);
    setBulkDeleteOpen(false);
  }, [queryScopeKey]);

  useEffect(
    () => () => {
      copyFlightRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!rows) return;
    const current = new Map(rows.map((row) => [row.id, row]));
    setSelected((value) => (value ? (current.get(value.id) ?? null) : null));
    setEditing((value) => (value ? (current.get(value.id) ?? null) : null));
    setTestTarget((value) => (value ? (current.get(value.id) ?? null) : null));
    setPauseTarget((value) => (value ? (current.get(value.id) ?? null) : null));
    setDeleteTarget((value) =>
      value ? (current.get(value.id) ?? null) : null,
    );
    setRotateTarget((value) =>
      value ? (current.get(value.id) ?? null) : null,
    );
  }, [rows]);

  const copy = (value: string, label: string): void => {
    if (copyFlightRef.current) {
      setClipboardStatus("A clipboard write is already in progress.");
      return;
    }
    copyFlightRef.current = copyWebhookValue(value, label)
      .then((status) => {
        if (activeRef.current) setClipboardStatus(status);
      })
      .finally(() => {
        copyFlightRef.current = null;
      });
  };

  const openCreate = (receiverName?: string): void => {
    if (loading || loadingMore || operation.active || revealed) {
      setActionStatus(
        revealed
          ? "Store or discard the shown signing material before creating another destination."
          : "Wait for the current webhook request to finish.",
      );
      return;
    }
    setPreset(
      (receiverName && RECEIVER_PRESETS[receiverName]) ||
        RECEIVER_PRESETS["Your own server"],
    );
  };

  const publishMaterial = (
    response: OutboundWebhookCreateResponse,
    reason: RevealedMaterial["reason"],
  ): void => {
    if (
      response.webhook.signing_algorithm === "hmac_sha256" &&
      response.signing_secret
    ) {
      secretLifecycle.activate();
    } else {
      secretLifecycle.resolve();
    }
    setRevealed({ reason, response });
  };

  const resolveMaterial = (): void => {
    secretLifecycle.resolve();
    setConfirmSecretClose(false);
    setRevealed(null);
  };

  return {
    actionStatus,
    setActionStatus,
    clipboardStatus,
    selected,
    setSelected,
    editing,
    setEditing,
    preset,
    setPreset,
    catalogOpen,
    setCatalogOpen,
    testTarget,
    setTestTarget,
    testing,
    setTesting,
    testError,
    setTestError,
    testResult,
    setTestResult,
    pauseTarget,
    setPauseTarget,
    deleteTarget,
    setDeleteTarget,
    rotateTarget,
    setRotateTarget,
    mutatingId,
    setMutatingId,
    bulkPauseOpen,
    setBulkPauseOpen,
    bulkDeleteOpen,
    setBulkDeleteOpen,
    revealed,
    confirmSecretClose,
    setConfirmSecretClose,
    operation,
    copy,
    openCreate,
    publishMaterial,
    resolveMaterial,
  };
}

type OutboundActionState = ReturnType<typeof useOutboundWebhookActionState>;

function useOutboundWebhookLiveActions(
  catalog: OutboundCatalogController,
  state: OutboundActionState,
) {
  const { activeRef, load } = catalog;
  const {
    operation,
    testTarget,
    rotateTarget,
    revealed,
    setActionStatus,
    setMutatingId,
    setTesting,
    setTestError,
    setTestResult,
    setRotateTarget,
    publishMaterial,
  } = state;
  const rotateIdentityRef = useRef<{
    webhookId: string;
    key: string;
  } | null>(null);

  useEffect(() => {
    if (!rotateTarget) rotateIdentityRef.current = null;
  }, [rotateTarget]);

  const runRowMutation = async (
    row: OutboundWebhook,
    action: "pause" | "resume" | "delete",
  ): Promise<boolean> => {
    if (operation.promiseRef.current) return false;
    const request = operation.run(() =>
      action === "resume"
        ? reEnableOutboundWebhook(row.id)
        : deleteOutboundWebhook(row.id, { soft: action === "pause" }),
    );
    if (!request) return false;
    setMutatingId(row.id);
    try {
      const result = await request;
      if (!activeRef.current) return false;
      if (result.error) {
        const message = sanitizeInspectableText(
          actionableOutboundError(result.error.code, result.error.message),
        ).text;
        toast.error(`${action} failed: ${message}`);
        setActionStatus(
          `${inspectableWebhookURL(row.url)} was not ${action}d. ${message}`,
        );
        return false;
      }
      const verb =
        action === "pause"
          ? "paused"
          : action === "resume"
            ? "resumed"
            : "deleted";
      toast.success(`Webhook ${verb}`);
      setActionStatus(`${inspectableWebhookURL(row.url)} was ${verb}.`);
      await load();
      return true;
    } catch (error) {
      if (activeRef.current) {
        const message = sanitizeInspectableText(
          lifecycleOperationError(error, `The ${action} request failed.`),
        ).text;
        toast.error(`${action} failed: ${message}`);
      }
      return false;
    } finally {
      if (activeRef.current) setMutatingId(null);
    }
  };

  const runTest = async (): Promise<void> => {
    const target = testTarget;
    if (!target || operation.promiseRef.current) return;
    const request = operation.run(() => testOutboundWebhook(target.id));
    if (!request) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await request;
      if (!activeRef.current) return;
      if (result.error) {
        const message = sanitizeInspectableText(
          actionableOutboundError(result.error.code, result.error.message),
        ).text;
        setTestError(message);
        toast.error("Test delivery needs attention. Follow the action shown.");
        return;
      }
      const safeResponse = sanitizeInspectableText(result.data.response);
      const safeError = result.data.error
        ? sanitizeInspectableText(result.data.error)
        : null;
      setTestResult({
        statusCode: result.data.status_code,
        response: safeResponse.text,
        error: safeError?.text,
        redactedCount:
          safeResponse.redactedCount + (safeError?.redactedCount ?? 0),
        filtered: result.data.filtered,
        signed: result.data.signed,
      });
      if (result.data.filtered) {
        toast.success("Test event was filtered; no receiver request was made");
        setActionStatus(
          `The configured filter suppressed the test event for ${inspectableWebhookURL(target.url)}. Nothing was signed or sent.`,
        );
        return;
      }
      const succeeded =
        result.data.status_code >= 200 &&
        result.data.status_code < 300 &&
        !result.data.error;
      if (succeeded) {
        toast.success(`Test returned HTTP ${result.data.status_code}`);
      } else {
        toast.error(
          `Test returned HTTP ${result.data.status_code || "no response"}`,
        );
      }
      setActionStatus(
        `Live test to ${inspectableWebhookURL(target.url)} returned HTTP ${result.data.status_code || "no response"}.`,
      );
      void load();
    } catch (error) {
      if (activeRef.current) {
        const message = sanitizeInspectableText(
          lifecycleOperationError(error, "The live test request failed."),
        ).text;
        setTestError(message);
        toast.error(`Test failed: ${message}`);
      }
    } finally {
      if (activeRef.current) setTesting(false);
    }
  };

  const rotate = async (): Promise<void> => {
    const target = rotateTarget;
    if (!target || operation.promiseRef.current || revealed) return;
    if (rotateIdentityRef.current?.webhookId !== target.id) {
      rotateIdentityRef.current = {
        webhookId: target.id,
        key: newUUIDv7(),
      };
    }
    const idempotencyKey = rotateIdentityRef.current.key;
    const request = operation.run(() =>
      rotateOutboundWebhookSigningMaterial(target.id, undefined, {
        idempotencyKey,
      }),
    );
    if (!request) return;
    setMutatingId(target.id);
    try {
      const result = await request;
      if (!activeRef.current) return;
      if (result.error) {
        toast.error(
          `Rotation failed: ${sanitizeInspectableText(result.error.message).text}`,
        );
        return;
      }
      rotateIdentityRef.current = null;
      publishMaterial(result.data, "rotated");
      setRotateTarget(null);
      toast.success(
        "Signing material rotated; the 24-hour grace window is active",
      );
      void load();
    } catch (error) {
      if (activeRef.current) {
        toast.error(
          `Rotation failed: ${
            sanitizeInspectableText(
              lifecycleOperationError(error, "The rotation request failed."),
            ).text
          }`,
        );
      }
    } finally {
      if (activeRef.current) setMutatingId(null);
    }
  };

  const abandonRotate = (): void => {
    if (operation.promiseRef.current) return;
    rotateIdentityRef.current = null;
    setRotateTarget(null);
  };

  return { runRowMutation, runTest, rotate, abandonRotate };
}

type OutboundLiveActions = ReturnType<typeof useOutboundWebhookLiveActions>;

function outboundLoadedScopeCopy(
  catalog: OutboundCatalogController,
): string | null {
  const { visibleRows, loading, loadError, nextCursor } = catalog;
  if (!visibleRows) return null;
  const count = visibleRows.length.toLocaleString();
  const noun = visibleRows.length === 1 ? "destination" : "destinations";
  if (loading) {
    return `${count} previously verified ${noun} remain visible while the first page refreshes`;
  }
  if (loadError) {
    return `${count} previously verified ${noun} remain visible but may be stale; paging is unavailable until refresh succeeds`;
  }
  return `${count} ${noun} loaded${nextCursor ? "; more are available" : "; end of the current server query"}`;
}

function outboundPageSubtitle(catalog: OutboundCatalogController): string {
  const { searchPending, queryScopeKey, loadError, appliedQuery } = catalog;
  if (searchPending) return `Searching the server for “${queryScopeKey}”…`;
  const loadedCopy = outboundLoadedScopeCopy(catalog);
  if (loadedCopy) {
    return `${loadedCopy}. Counts and bulk actions cover loaded rows only.`;
  }
  if (loadError) {
    return appliedQuery
      ? `Matching destination state for “${appliedQuery}” is unavailable until the server query succeeds.`
      : "Destination state is unavailable until the server request succeeds.";
  }
  return appliedQuery
    ? `Loading matching destinations for “${appliedQuery}”…`
    : "Loading destinations from the canonical delivery service…";
}

function outboundResultsSummary(catalog: OutboundCatalogController): string {
  const {
    searchPending,
    loading,
    visibleRows,
    appliedQuery,
    loadError,
    nextCursor,
  } = catalog;
  if (searchPending) return "Searching server…";
  if (loading && visibleRows === null) {
    return appliedQuery
      ? "Loading matching destinations…"
      : "Loading destinations…";
  }
  if (!visibleRows) return "Current query unavailable";
  const count = visibleRows.length.toLocaleString();
  const noun = visibleRows.length === 1 ? "destination" : "destinations";
  if (loading)
    return `${count} verified ${noun} visible · refreshing first page`;
  if (loadError) return `${count} verified ${noun} visible · stale`;
  return `${count} ${appliedQuery ? "matching " : ""}${noun} loaded${nextCursor ? " · more available" : " · end of results"}`;
}

function outboundPaginationCopy(catalog: OutboundCatalogController): string {
  const { visibleRows, loadError, moreError, nextCursor, appliedQuery } =
    catalog;
  if (!visibleRows) return "";
  const count = visibleRows.length.toLocaleString();
  const noun = visibleRows.length === 1 ? "destination" : "destinations";
  if (loadError) {
    return `${count} previously verified ${noun} remain visible. Refresh must succeed before additional cursor pages can be loaded.`;
  }
  if (moreError && !nextCursor) {
    return `${count} verified ${noun} remain loaded; the query may be incomplete because pagination stopped safely.`;
  }
  if (nextCursor) {
    return `${count} ${noun} loaded. More ${appliedQuery ? "matching destination" : "destination"} records are available from the server.`;
  }
  return `All available ${appliedQuery ? "matching " : ""}destination records are loaded.`;
}

function outboundPageActions(
  catalog: OutboundCatalogController,
  state: OutboundActionState,
) {
  const { loading, loadingMore, searchPending, load } = catalog;
  const { operation, revealed, setCatalogOpen, openCreate } = state;
  const busy = operation.active || loading || loadingMore;
  let refreshTitle =
    "Reload destination state from the canonical delivery service.";
  if (loading) refreshTitle = "The destination list is already refreshing.";
  else if (loadingMore) {
    refreshTitle = "Wait for the current cursor page to finish loading.";
  } else if (searchPending) {
    refreshTitle = "Wait for the debounced server query to start.";
  }
  let createTitle = "Create a live signed delivery destination.";
  if (revealed) {
    createTitle =
      "Store or explicitly discard the shown signing material before creating another destination.";
  } else if (busy) {
    createTitle = "Wait for the current destination request to finish.";
  }
  return [
    {
      label: loading ? "Refreshing…" : "Refresh",
      onClick: () => void load(),
      variant: "ghost" as const,
      disabled: loading || loadingMore || searchPending,
      title: refreshTitle,
    },
    {
      label: "Event catalog",
      onClick: () => setCatalogOpen(true),
      disabled: operation.active,
      title:
        "Review producer-backed events, their signed envelope, and delivery headers.",
    },
    {
      label: "New destination",
      onClick: () => openCreate(),
      variant: "primary" as const,
      disabled: busy || revealed !== null,
      title: createTitle,
    },
  ];
}

function OutboundWebhookLoadNotice({
  catalog,
}: {
  catalog: OutboundCatalogController;
}): ReactElement | null {
  const { loadError, visibleRows, rows, loading, load } = catalog;
  if (!loadError) return null;
  const prefix = loadError.contract ? "Contract error: " : "";
  const retention = visibleRows
    ? "Previously loaded destinations remain visible and may be stale."
    : rows
      ? "Verified rows from a different server query are retained but are not shown in this query scope."
      : "No empty result was inferred from this failure.";
  return (
    <Notice
      tone="danger"
      announcement={visibleRows ? "polite" : "assertive"}
      action={
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          Retry
        </button>
      }
    >
      {prefix}
      {loadError.message} {retention}
    </Notice>
  );
}

function OutboundWebhookSearchToolbar({
  query,
  onQueryChange,
  catalog,
  state,
  bulk,
  resultsSummary,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  catalog: OutboundCatalogController;
  state: OutboundActionState;
  bulk: BulkController;
  resultsSummary: string;
}): ReactElement {
  const listStatusId = useId();
  const searchUnavailableId = useId();
  const searchDisabled = state.operation.active || bulk.busy;
  const { searchPending, loading } = catalog;
  return (
    <>
      <span id={listStatusId} className="sr-only">
        {resultsSummary}
      </span>
      <span id={searchUnavailableId} className="sr-only">
        Wait for the current live destination action to finish before changing
        the server query.
      </span>
      <div
        className="wh-list-controls wh-list-toolbar"
        aria-label="Search outbound webhook destinations on the server"
        aria-busy={searchPending || loading || undefined}
      >
        <label className="sr-only" htmlFor="outbound-webhook-search">
          Search destinations on the server
        </label>
        <input
          id="outbound-webhook-search"
          className="input"
          style={{ width: 280, maxWidth: "100%" }}
          placeholder="Search destination or event…"
          maxLength={200}
          value={query}
          disabled={searchDisabled}
          aria-describedby={searchDisabled ? searchUnavailableId : listStatusId}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              !event.nativeEvent.isComposing &&
              event.key === "Escape" &&
              query
            ) {
              event.preventDefault();
              onQueryChange("");
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={searchDisabled}
            aria-describedby={searchDisabled ? searchUnavailableId : undefined}
            onClick={() => onQueryChange("")}
          >
            Clear search
          </button>
        ) : null}
        <span className="spacer" />
        <span className="wh-results-summary" role="status" aria-live="polite">
          {resultsSummary}
        </span>
      </div>
    </>
  );
}

function OutboundWebhookBulkBar({
  state,
  bulk,
}: {
  state: OutboundActionState;
  bulk: BulkController;
}): ReactElement | null {
  if (bulk.checkedIds.size === 0) return null;
  return (
    <BulkActionsBar
      count={bulk.checkedIds.size}
      hiddenCount={bulk.hiddenCount}
      canEnable
      canDisable
      canDelete
      busy={bulk.busy || state.operation.active}
      onClear={bulk.clear}
      onEnableAll={() => void bulk.resume()}
      onDisableAll={() => state.setBulkPauseOpen(true)}
      onDeleteAll={() => state.setBulkDeleteOpen(true)}
    />
  );
}

function OutboundWebhookPageChrome({
  query,
  onQueryChange,
  catalog,
  state,
  bulk,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  catalog: OutboundCatalogController;
  state: OutboundActionState;
  bulk: BulkController;
}): ReactElement {
  const { visibleRows, appliedQuery } = catalog;
  const { actionStatus, clipboardStatus } = state;
  const stats = useMemo(() => buildStats(visibleRows), [visibleRows]);
  const resultsSummary = outboundResultsSummary(catalog);
  const hasRows = (visibleRows?.length ?? 0) > 0;
  return (
    <>
      <PageHeader
        eyebrow="Connections"
        title="Outbound webhooks"
        subtitle={outboundPageSubtitle(catalog)}
        actions={outboundPageActions(catalog, state)}
      />
      <div className="wh-live-operations-note" role="note">
        <span className="wh-live-status-dot" aria-hidden="true" />
        <span>
          <strong>Live delivery controls.</strong> Tests, replays, key rotation,
          and configuration changes run against the server now; Moosewave never
          queues them on this device.
        </span>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {[actionStatus, clipboardStatus].filter(Boolean).join(" ")}
      </div>
      <OutboundWebhookLoadNotice catalog={catalog} />
      {visibleRows && (hasRows || Boolean(appliedQuery)) ? (
        <StatStrip cells={stats} />
      ) : null}
      <OutboundWebhookSearchToolbar
        query={query}
        onQueryChange={onQueryChange}
        catalog={catalog}
        state={state}
        bulk={bulk}
        resultsSummary={resultsSummary}
      />
      <OutboundWebhookBulkBar state={state} bulk={bulk} />
    </>
  );
}

function OutboundWebhookPaginationFooter({
  catalog,
  operationActive,
}: {
  catalog: OutboundCatalogController;
  operationActive: boolean;
}): ReactElement {
  const { loading, loadingMore, moreError, nextCursor, loadMore } = catalog;
  const statusId = useId();
  let loadLabel = "Load more destinations";
  if (loadingMore) loadLabel = "Loading more destinations…";
  else if (moreError) loadLabel = "Retry loading more";
  return (
    <div
      className="wh-pagination-footer"
      aria-live="polite"
      aria-label="Outbound destination pagination"
    >
      <div className="wh-pagination-copy">
        {moreError ? (
          <span className="field-error" role="alert">
            {moreError.contract
              ? "Pagination contract error"
              : "Couldn't load more destinations"}
            : {moreError.message}
          </span>
        ) : null}
        <span id={statusId} className="muted small">
          {outboundPaginationCopy(catalog)}
        </span>
      </div>
      {nextCursor ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading || loadingMore || operationActive}
          aria-describedby={
            loading || loadingMore || operationActive ? statusId : undefined
          }
          onClick={() => void loadMore()}
        >
          {loadLabel}
        </button>
      ) : null}
    </div>
  );
}

function OutboundWebhookListContent({
  onQueryChange,
  catalog,
  state,
  live,
  bulk,
}: {
  onQueryChange: (value: string) => void;
  catalog: OutboundCatalogController;
  state: OutboundActionState;
  live: OutboundLiveActions;
  bulk: BulkController;
}): ReactElement | null {
  const {
    visibleRows,
    loading,
    loadingMore,
    loadError,
    appliedQuery,
    searchPending,
  } = catalog;
  const {
    operation,
    mutatingId,
    setSelected,
    setEditing,
    setTestTarget,
    setTestError,
    setTestResult,
    copy,
    setPauseTarget,
    setRotateTarget,
    setDeleteTarget,
    openCreate,
    setCatalogOpen,
  } = state;
  const busy = operation.active || loading || loadingMore || bulk.busy;
  if (searchPending) {
    return (
      <div className="list" role="status" aria-live="polite">
        <div className="list-empty">
          Searching server… Results will update after you pause typing.
        </div>
      </div>
    );
  }
  if (loading && visibleRows === null) {
    return (
      <div className="list" role="status" aria-live="polite">
        <div className="list-empty">
          {appliedQuery
            ? `Loading destinations matching “${appliedQuery}”…`
            : "Loading outbound destinations…"}
        </div>
      </div>
    );
  }
  if (loadError && visibleRows === null) return null;
  if (visibleRows?.length === 0 && !appliedQuery && !loadError) {
    return (
      <>
        <HeroEmptyState
          tone="sand"
          eyebrow="Outbound webhooks"
          title="Send signed events to your customer systems"
          subtitle="Create a destination, choose its exact event contract, and verify every request before applying side effects."
          primaryCta={{ label: "New destination", onClick: () => openCreate() }}
          secondaryCta={{
            label: "Review event catalog",
            onClick: () => setCatalogOpen(true),
          }}
          imageSrc={HERO.outboundWebhooks}
        />
        <WebhookOnboardingGallery direction="outbound" onCreate={openCreate} />
      </>
    );
  }
  if (visibleRows?.length === 0) {
    return (
      <div className="list">
        <div className="list-empty">
          No destinations match “{appliedQuery}” on the server.{" "}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onQueryChange("")}
          >
            Clear search
          </button>
        </div>
      </div>
    );
  }
  if (!visibleRows) return null;
  const openTest = (row: OutboundWebhook): void => {
    setTestError(null);
    setTestResult(null);
    setTestTarget(row);
  };
  return (
    <>
      <WebhookTable
        rows={visibleRows}
        bulk={bulk}
        busy={busy}
        mutatingId={mutatingId}
        onOpen={setSelected}
        onEdit={setEditing}
        onTest={openTest}
        onCopy={copy}
        onPause={setPauseTarget}
        onResume={(row) => void live.runRowMutation(row, "resume")}
        onRotate={setRotateTarget}
        onDelete={setDeleteTarget}
      />
      <OutboundWebhookPaginationFooter
        catalog={catalog}
        operationActive={operation.active}
      />
    </>
  );
}

function OutboundWebhookResourceOverlays({
  catalog,
  state,
}: {
  catalog: OutboundCatalogController;
  state: OutboundActionState;
}): ReactElement {
  const { load } = catalog;
  const {
    selected,
    setSelected,
    editing,
    setEditing,
    preset,
    setPreset,
    catalogOpen,
    setCatalogOpen,
    revealed,
    confirmSecretClose,
    setConfirmSecretClose,
    publishMaterial,
    resolveMaterial,
    copy,
  } = state;
  return (
    <>
      {selected ? (
        <OutboundWebhookDeliveriesSlideover
          subscription={selected}
          onClose={() => setSelected(null)}
          onRetried={() => void load()}
        />
      ) : null}
      <OutboundWebhookEditDialog
        webhook={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
      <ReceiverPresetDialog
        open={preset !== null}
        preset={preset}
        onClose={() => setPreset(null)}
        onCreated={(created) => {
          setPreset(null);
          publishMaterial(created, "created");
          void load();
        }}
      />
      <EventCatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
      />
      <OutboundMaterialReveal
        revealed={revealed}
        confirmClose={confirmSecretClose}
        onRequestClose={() => setConfirmSecretClose(true)}
        onKeepOpen={() => setConfirmSecretClose(false)}
        onResolve={resolveMaterial}
        onCopy={copy}
      />
    </>
  );
}

function OutboundWebhookRowConfirmations({
  state,
  live,
}: {
  state: OutboundActionState;
  live: OutboundLiveActions;
}): ReactElement {
  const {
    testTarget,
    setTestTarget,
    testing,
    testError,
    setTestError,
    testResult,
    setTestResult,
    pauseTarget,
    setPauseTarget,
    deleteTarget,
    setDeleteTarget,
    rotateTarget,
    mutatingId,
  } = state;
  return (
    <>
      <ConfirmModal
        open={testTarget !== null}
        title="Send a live test delivery?"
        description={
          testTarget
            ? `Send a test to this production webhook only when the receiver is ready. Moosewave will apply this destination's filter and transform to a webhook.test event. If the event passes, Moosewave will sign and send it to ${inspectableWebhookURL(testTarget.url)} now; the receiver may execute real side effects.`
            : ""
        }
        confirmLabel={
          testing ? "Sending…" : testResult ? "Send another test" : "Send test"
        }
        cancelLabel={testResult || testError ? "Close" : "Cancel"}
        danger
        busy={testing}
        onConfirm={live.runTest}
        onClose={() => {
          if (!testing) {
            setTestTarget(null);
            setTestError(null);
            setTestResult(null);
          }
        }}
      >
        {testError ? (
          <p className="field-error" role="alert">
            {testError}
          </p>
        ) : null}
        {testResult ? <TestResultPanel result={testResult} /> : null}
        {!testError && !testResult ? (
          <p className="muted small">
            This action is never queued or retried by the desktop client.
          </p>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={pauseTarget !== null}
        title="Pause this destination?"
        description={
          pauseTarget
            ? `New events will stop being enqueued for ${inspectableWebhookURL(pauseTarget.url)}, and pending deliveries will not be attempted while paused. History, delivery rows, and signing configuration are retained for a later resume.`
            : ""
        }
        confirmLabel="Pause destination"
        cancelLabel="Cancel"
        busy={mutatingId !== null}
        onConfirm={async () => {
          if (
            pauseTarget &&
            (await live.runRowMutation(pauseTarget, "pause"))
          ) {
            setPauseTarget(null);
          }
        }}
        onClose={() => {
          if (!mutatingId) setPauseTarget(null);
        }}
      />
      <ConfirmModal
        open={deleteTarget !== null}
        title="Permanently delete this destination?"
        description={
          deleteTarget
            ? `This permanently tombstones ${inspectableWebhookURL(deleteTarget.url)}. Pending deliveries are cancelled as “skipped,” retained history stays available in tenant-wide diagnostics, and destination/auth/signing secrets are shredded. A receiver request already in flight may still finish. Pause instead if you need a reversible stop.`
            : ""
        }
        confirmLabel="Delete permanently"
        cancelLabel="Cancel"
        typeToConfirm="DELETE"
        danger
        busy={mutatingId !== null}
        onConfirm={async () => {
          if (
            deleteTarget &&
            (await live.runRowMutation(deleteTarget, "delete"))
          ) {
            setDeleteTarget(null);
          }
        }}
        onClose={() => {
          if (!mutatingId) setDeleteTarget(null);
        }}
      />
      <ConfirmModal
        open={rotateTarget !== null}
        title="Rotate signing material?"
        description={
          rotateTarget
            ? `Moosewave will generate new ${rotateTarget.signing_algorithm} material for ${inspectableWebhookURL(rotateTarget.url)} and dual-sign deliveries for 24 hours. Store the returned one-time value and update every verifier before the old key expires.`
            : ""
        }
        confirmLabel="Rotate key"
        cancelLabel="Cancel"
        danger
        busy={mutatingId !== null}
        onConfirm={live.rotate}
        onClose={() => {
          if (!mutatingId) live.abandonRotate();
        }}
      />
    </>
  );
}

function OutboundWebhookBulkConfirmations({
  catalog,
  state,
  bulk,
}: {
  catalog: OutboundCatalogController;
  state: OutboundActionState;
  bulk: BulkController;
}): ReactElement {
  const { activeRef } = catalog;
  const { bulkPauseOpen, setBulkPauseOpen, bulkDeleteOpen, setBulkDeleteOpen } =
    state;
  const selectedNoun =
    bulk.checkedIds.size === 1 ? "destination" : "destinations";
  return (
    <>
      <ConfirmModal
        open={bulkPauseOpen}
        title={`Pause ${bulk.checkedIds.size} ${selectedNoun}?`}
        description={`This affects only the ${bulk.checkedIds.size} selected ${selectedNoun} among the rows loaded for the current server query. Unloaded cursor pages are not selected. New events and pending attempts are paused; history, delivery rows, and signing configuration are retained, and each destination can be resumed.`}
        confirmLabel="Pause selected"
        cancelLabel="Cancel"
        busy={bulk.busy}
        onConfirm={async () => {
          await bulk.pause();
          if (activeRef.current) setBulkPauseOpen(false);
        }}
        onClose={() => {
          if (!bulk.busy) setBulkPauseOpen(false);
        }}
      />
      <ConfirmModal
        open={bulkDeleteOpen}
        title={`Delete ${bulk.checkedIds.size} ${selectedNoun}?`}
        description={`This permanently tombstones only the ${bulk.checkedIds.size} selected ${selectedNoun} among the rows loaded for the current server query; unloaded cursor pages are not selected. Pending deliveries are cancelled as “skipped,” tenant-wide diagnostics retain delivery evidence, and destination/auth/signing secrets are shredded. Already in-flight receiver requests may still finish. Pause instead for a reversible stop.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        typeToConfirm="DELETE"
        danger
        busy={bulk.busy}
        onConfirm={async () => {
          await bulk.remove();
          if (activeRef.current) setBulkDeleteOpen(false);
        }}
        onClose={() => {
          if (!bulk.busy) setBulkDeleteOpen(false);
        }}
      />
    </>
  );
}

function OutboundWebhooksAdmin(): ReactElement {
  const [query, setQuery] = useState("");
  const catalog = useOutboundWebhookCatalog(query);
  const actionState = useOutboundWebhookActionState(catalog);
  const live = useOutboundWebhookLiveActions(catalog, actionState);
  const bulk = useCanonicalBulkActions({
    rows: catalog.visibleRows,
    filtered: catalog.visibleRows ?? [],
    scopeKey: catalog.queryScopeKey,
    operation: actionState.operation,
    activeRef: catalog.activeRef,
    onReload: () => void catalog.load(),
    onStatus: actionState.setActionStatus,
  });

  return (
    <>
      <OutboundWebhookPageChrome
        query={query}
        onQueryChange={setQuery}
        catalog={catalog}
        state={actionState}
        bulk={bulk}
      />
      <OutboundWebhookListContent
        onQueryChange={setQuery}
        catalog={catalog}
        state={actionState}
        live={live}
        bulk={bulk}
      />
      <OutboundWebhookResourceOverlays catalog={catalog} state={actionState} />
      <OutboundWebhookRowConfirmations state={actionState} live={live} />
      <OutboundWebhookBulkConfirmations
        catalog={catalog}
        state={actionState}
        bulk={bulk}
      />
    </>
  );
}

interface OutboundWebhookRowHandlers {
  onOpen: (row: OutboundWebhook) => void;
  onEdit: (row: OutboundWebhook) => void;
  onTest: (row: OutboundWebhook) => void;
  onCopy: (value: string, label: string) => void;
  onPause: (row: OutboundWebhook) => void;
  onResume: (row: OutboundWebhook) => void;
  onRotate: (row: OutboundWebhook) => void;
  onDelete: (row: OutboundWebhook) => void;
}

function OutboundDestinationCell({
  row,
  url,
  status,
  onOpen,
}: {
  row: OutboundWebhook;
  url: ReturnType<typeof sanitizeInspectableUrl>;
  status: ReturnType<typeof webhookStatus>;
  onOpen: (row: OutboundWebhook) => void;
}): ReactElement {
  return (
    <td data-label="Destination">
      <button
        type="button"
        className="wh-row-primary"
        onClick={() => onOpen(row)}
      >
        <span className="wh-row-titleline">
          <strong>{row.description || "Unnamed destination"}</strong>
          <span className={status.badge}>{status.label}</span>
        </span>
        <span className="mono wh-full-identifier">{url.url}</span>
        <span className="wh-row-secondary muted small mono">{row.id}</span>
      </button>
      {url.redactedCount > 0 ? (
        <span className="muted small">
          Credential-bearing URL values are redacted.
        </span>
      ) : null}
    </td>
  );
}

function OutboundEventsCell({ row }: { row: OutboundWebhook }): ReactElement {
  const projectedFields = Object.keys(row.transform_template ?? {}).length;
  const deliveryCopy = row.filter_expression
    ? "Conditional delivery"
    : "All selected events";
  const projectionCopy =
    projectedFields > 0
      ? ` · ${projectedFields} projected field${projectedFields === 1 ? "" : "s"}`
      : " · original payload";
  return (
    <td data-label="Events and signing">
      <div className="wh-event-chip-list">
        {row.events.slice(0, 2).map((event) => (
          <span key={event} className="chip mono">
            {event}
          </span>
        ))}
        {row.events.length > 2 ? (
          <span className="muted small">+{row.events.length - 2}</span>
        ) : null}
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {row.signing_algorithm}
        {row.secondary_expires_at ? " · rotation grace active" : ""}
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {receiverAuthSummary(row)}
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {deliveryCopy}
        {projectionCopy}
      </div>
    </td>
  );
}

function OutboundActionsCell({
  row,
  url,
  rowBusy,
  setupBlock,
  handlers,
}: {
  row: OutboundWebhook;
  url: ReturnType<typeof sanitizeInspectableUrl>;
  rowBusy: boolean;
  setupBlock: string | null;
  handlers: OutboundWebhookRowHandlers;
}): ReactElement {
  const reasonSuffix = row.id.replace(/[^A-Za-z0-9_-]/g, "-");
  const setupReasonId = `outbound-setup-${reasonSuffix}`;
  const busyReasonId = `outbound-busy-${reasonSuffix}`;
  const busyDescription = rowBusy ? busyReasonId : undefined;
  const testDescription = setupBlock ? setupReasonId : busyDescription;
  const toggleBlocked = !row.active && Boolean(setupBlock);
  const toggleDescription = toggleBlocked ? setupReasonId : busyDescription;
  const toggleLabel = row.active ? "Pause" : "Resume";
  const toggle = (): void => {
    if (row.active) handlers.onPause(row);
    else handlers.onResume(row);
  };
  return (
    <td data-label="Actions">
      <div className="wh-row-actions-cell">
        <span id={setupReasonId} className="sr-only">
          {setupBlock ??
            "Repair this destination before sending or activating it."}
        </span>
        <span id={busyReasonId} className="sr-only">
          Wait for the current destination operation to finish.
        </span>
        <div className="wh-row-actions-primary">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => handlers.onOpen(row)}
          >
            Deliveries
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={rowBusy || Boolean(setupBlock)}
            aria-describedby={testDescription}
            aria-label={`Send a synthetic test delivery to ${url.url}`}
            onClick={() => handlers.onTest(row)}
          >
            Test
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={rowBusy}
            aria-describedby={busyDescription}
            onClick={() => handlers.onEdit(row)}
          >
            Edit
          </button>
        </div>
        <details className="wh-row-more">
          <summary
            className="btn btn-sm"
            aria-label={`More actions for ${row.description || url.url}`}
            aria-disabled={rowBusy ? "true" : undefined}
            aria-describedby={busyDescription}
            onClick={(event) => {
              if (rowBusy) event.preventDefault();
            }}
          >
            More
            <span className="wh-row-more-chevron" aria-hidden="true">
              ⌄
            </span>
          </summary>
          <div className="wh-row-more-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={rowBusy}
              aria-describedby={busyDescription}
              onClick={() => handlers.onRotate(row)}
            >
              Rotate key
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={rowBusy || toggleBlocked}
              aria-describedby={toggleDescription}
              onClick={toggle}
            >
              {toggleLabel}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={rowBusy}
              aria-describedby={busyDescription}
              onClick={() => handlers.onCopy(row.url, "Receiver display URL")}
            >
              Copy display URL
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={rowBusy}
              aria-describedby={busyDescription}
              onClick={() => handlers.onDelete(row)}
            >
              Delete
            </button>
          </div>
        </details>
      </div>
    </td>
  );
}

function OutboundWebhookTableRow({
  row,
  bulk,
  busy,
  mutatingId,
  handlers,
}: {
  row: OutboundWebhook;
  bulk: BulkController;
  busy: boolean;
  mutatingId: string | null;
  handlers: OutboundWebhookRowHandlers;
}): ReactElement {
  const url = sanitizeInspectableUrl(row.url);
  const status = webhookStatus(row);
  const setupBlock = deliverySetupBlock(row);
  const rowBusy = busy || mutatingId === row.id;
  return (
    <tr
      className="list-row wh-destination-row"
      style={{ gridTemplateColumns: TABLE_COLUMNS, cursor: "default" }}
    >
      <td data-label="Select">
        <input
          type="checkbox"
          className="wh-row-checkbox"
          aria-label={`Select ${url.url}`}
          checked={bulk.checkedIds.has(row.id)}
          disabled={rowBusy}
          onChange={() => bulk.toggle(row.id)}
          style={{ width: 20, height: 20 }}
        />
      </td>
      <OutboundDestinationCell
        row={row}
        url={url}
        status={status}
        onOpen={handlers.onOpen}
      />
      <td data-label="State">
        <span className={status.badge}>{status.label}</span>
        <div className="muted small" style={{ marginTop: 4 }}>
          {status.detail}
        </div>
      </td>
      <td data-label="Delivery activity">
        <div className="small">
          Last success: {exactTimestamp(row.last_succeeded_at)}
        </div>
        <div className="small" style={{ marginTop: 4 }}>
          Last failure: {exactTimestamp(row.last_failed_at)}
        </div>
      </td>
      <OutboundEventsCell row={row} />
      <OutboundActionsCell
        row={row}
        url={url}
        rowBusy={rowBusy}
        setupBlock={setupBlock}
        handlers={handlers}
      />
    </tr>
  );
}

function WebhookTable({
  rows,
  bulk,
  busy,
  mutatingId,
  onOpen,
  onEdit,
  onTest,
  onCopy,
  onPause,
  onResume,
  onRotate,
  onDelete,
}: {
  rows: OutboundWebhook[];
  bulk: BulkController;
  busy: boolean;
  mutatingId: string | null;
  onOpen: (row: OutboundWebhook) => void;
  onEdit: (row: OutboundWebhook) => void;
  onTest: (row: OutboundWebhook) => void;
  onCopy: (value: string, label: string) => void;
  onPause: (row: OutboundWebhook) => void;
  onResume: (row: OutboundWebhook) => void;
  onRotate: (row: OutboundWebhook) => void;
  onDelete: (row: OutboundWebhook) => void;
}): ReactElement {
  return (
    <table
      className="list wh-webhook-list wh-outbound-table"
      style={{ display: "block", width: "100%" }}
      aria-busy={busy ? "true" : undefined}
    >
      <caption className="sr-only">Outbound webhook destinations</caption>
      <thead
        className="list-header"
        style={{ gridTemplateColumns: TABLE_COLUMNS }}
      >
        <tr style={{ display: "contents" }}>
          <th scope="col">
            <SelectAllCheckbox
              checked={bulk.allVisibleChecked}
              mixed={bulk.mixedVisible}
              disabled={busy || rows.length === 0}
              onChange={() => bulk.toggleAll()}
            />
          </th>
          <th scope="col">Destination</th>
          <th scope="col">State</th>
          <th scope="col">Delivery activity</th>
          <th scope="col">Events and signing</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody style={{ display: "contents" }}>
        {rows.map((row) => (
          <OutboundWebhookTableRow
            key={row.id}
            row={row}
            bulk={bulk}
            busy={busy}
            mutatingId={mutatingId}
            handlers={{
              onOpen,
              onEdit,
              onTest,
              onCopy,
              onPause,
              onResume,
              onRotate,
              onDelete,
            }}
          />
        ))}
      </tbody>
    </table>
  );
}

function TestResultPanel({ result }: { result: SafeTestResult }): ReactElement {
  if (result.filtered) {
    return (
      <div className="notice" aria-live="polite">
        <strong>Filtered before delivery</strong>
        <p className="muted small" style={{ marginBottom: 0 }}>
          The configured filter suppressed this test event. No network request
          was made, no payload was signed, and HTTP 204 is Moosewave&apos;s
          internal filtered outcome—not a receiver response.
        </p>
      </div>
    );
  }
  return (
    <div className="notice" aria-live="polite">
      <strong>
        Receiver returned HTTP {result.statusCode || "no response"}
      </strong>
      <p className="muted small" style={{ marginBlock: "4px 0" }}>
        {result.signed
          ? "The transformed payload was signed before delivery."
          : "The server reports that this request was not signed."}
      </p>
      {result.error ? <p className="field-error">{result.error}</p> : null}
      {result.response ? (
        <pre className="wh-verification-snippet" style={{ marginTop: 8 }}>
          <code>{result.response}</code>
        </pre>
      ) : (
        <p className="muted small">The receiver returned an empty body.</p>
      )}
      {result.redactedCount > 0 ? (
        <p className="muted small">
          {result.redactedCount} credential-like value
          {result.redactedCount === 1 ? " was" : "s were"} redacted.
        </p>
      ) : null}
    </div>
  );
}

function OutboundReceiverDisplayField({
  response,
  onCopy,
}: {
  response: OutboundWebhookCreateResponse;
  onCopy: (value: string, label: string) => void;
}): ReactElement {
  const safeURL = sanitizeInspectableUrl(response.webhook.url);
  return (
    <div className="field">
      <div className="label">Receiver display address</div>
      <div className="copy-text mono">{safeURL.url}</div>
      <p className="field-help">
        This read-only address intentionally hides the configured path and
        query. It is not a usable delivery destination.
      </p>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onCopy(safeURL.url, "Receiver display address")}
        style={{ marginTop: 6 }}
      >
        Copy display address
      </button>
    </div>
  );
}

function OutboundSigningMaterialField({
  response,
  onCopy,
}: {
  response: OutboundWebhookCreateResponse;
  onCopy: (value: string, label: string) => void;
}): ReactElement {
  if (response.webhook.signing_algorithm === "hmac_sha256") {
    const secret = response.signing_secret;
    return (
      <div className="field">
        <div className="label">
          Shared signing secret{" "}
          <InlineHelp text="This secret is shown once. Store it in an approved secret manager before closing." />
        </div>
        {secret ? (
          <>
            <pre className="wh-verification-snippet">
              <code>{secret}</code>
            </pre>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => onCopy(secret, "Shared signing secret")}
              style={{ marginTop: 6 }}
            >
              Copy secret
            </button>
          </>
        ) : (
          <p className="field-error" role="alert">
            The server did not return the one-time shared secret. Keep this
            dialog open and contact support.
          </p>
        )}
      </div>
    );
  }

  const publicKey =
    response.public_key_pem ?? response.webhook.signing_public_key;
  return (
    <div className="field">
      <div className="label">
        Public verification key{" "}
        <InlineHelp text="Give this public key to the receiver that verifies Moosewave signatures." />
      </div>
      <p className="field-help">
        Moosewave keeps the corresponding private signing key server-side and
        never returns it to clients. This public key is safe to distribute and
        remains available in destination details.
      </p>
      {publicKey ? (
        <>
          <pre className="wh-verification-snippet">
            <code>{publicKey}</code>
          </pre>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => onCopy(publicKey, "Public verification key")}
            style={{ marginTop: 6 }}
          >
            Copy public key
          </button>
        </>
      ) : (
        <p className="field-error" role="alert">
          The server did not return the public verification key. Refresh
          destination details or contact support.
        </p>
      )}
    </div>
  );
}

function OutboundSecretStorageConfirmation({
  secret,
  stored,
  helpId,
  onChange,
}: {
  secret: string | undefined;
  stored: boolean;
  helpId: string;
  onChange: (stored: boolean) => void;
}): ReactElement {
  return (
    <>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={stored}
          disabled={!secret}
          onChange={(event) => onChange(event.target.checked)}
          style={{ width: 20, height: 20 }}
        />
        <span>
          I stored the shared signing secret in an approved secret manager and
          understand it cannot be shown again.
        </span>
      </label>
      {!stored ? (
        <p id={helpId} className="field-help">
          Confirm secure storage before dismissing this one-time secret.
        </p>
      ) : null}
    </>
  );
}

function OutboundMaterialReveal({
  revealed,
  confirmClose,
  onRequestClose,
  onKeepOpen,
  onResolve,
  onCopy,
}: {
  revealed: RevealedMaterial | null;
  confirmClose: boolean;
  onRequestClose: () => void;
  onKeepOpen: () => void;
  onResolve: () => void;
  onCopy: (value: string, label: string) => void;
}): ReactElement {
  const [stored, setStored] = useState(false);
  const helpId = useId();
  const response = revealed?.response;
  const algorithm = response?.webhook.signing_algorithm;
  const requiresSecretStorage = algorithm === "hmac_sha256";
  const canResolve = !requiresSecretStorage || stored;

  useEffect(() => {
    setStored(false);
  }, [revealed?.reason, response?.webhook.id]);

  return (
    <>
      <Modal
        open={revealed !== null}
        onClose={() => (canResolve ? onResolve() : onRequestClose())}
        title={
          revealed?.reason === "rotated"
            ? "Signing material rotated"
            : "Destination created"
        }
        description={
          algorithm === "hmac_sha256"
            ? "Copy the shared secret now. It is envelope-encrypted at rest and cannot be retrieved again."
            : "Configure the receiver with this public verification key. Moosewave retains the private signing key server-side."
        }
      >
        {response ? (
          <>
            <OutboundReceiverDisplayField response={response} onCopy={onCopy} />
            <OutboundSigningMaterialField response={response} onCopy={onCopy} />
            <Notice tone="info" announcement="off">
              Requests use <code>X-Postwave-Signature</code> over the exact raw
              body and include <code>X-Postwave-Key-Id</code>,{" "}
              <code>X-Postwave-Event</code>, <code>X-Postwave-Event-Id</code>,
              and <code>X-Postwave-Delivery</code>. Reject stale <code>t=</code>{" "}
              timestamps from the signature header. The signature authenticates
              the body, not those auxiliary identity headers: deduplicate only
              an identity retained inside the verified signed body. Tests
              additionally include <code>X-Postwave-Test: true</code>;
              production deliveries do not.
            </Notice>
            {revealed?.reason === "rotated" ? (
              <p className="muted small">
                The previous key remains valid during the server&apos;s 24-hour
                dual-signing grace window. Update the receiver before the expiry
                shown in destination details.
              </p>
            ) : null}
            {requiresSecretStorage ? (
              <OutboundSecretStorageConfirmation
                secret={response.signing_secret}
                stored={stored}
                helpId={helpId}
                onChange={setStored}
              />
            ) : null}
          </>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canResolve}
            aria-describedby={
              requiresSecretStorage && !stored ? helpId : undefined
            }
            onClick={onResolve}
          >
            {requiresSecretStorage ? "I've stored it securely" : "Done"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmClose && requiresSecretStorage}
        title="Discard the shown signing material?"
        description="This shared secret cannot be recovered. You will need to rotate the destination again before relying on it."
        confirmLabel="Discard shown secret"
        cancelLabel="Keep it open"
        danger
        onConfirm={onResolve}
        onClose={onKeepOpen}
      />
    </>
  );
}
