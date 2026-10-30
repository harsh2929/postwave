import { useEffect, useRef, useState } from "react";

import { toast } from "../../components/Toast";
import {
  analyticsIntegrationsApi,
  type ApiResult,
  crmIntegrationsApi,
  integrationsApi,
  leadIntegrationsApi,
  loyaltyIntegrationsApi,
  reviewIntegrationsApi,
  subscriptionIntegrationsApi,
  supportIntegrationsApi,
  type IntegrationCatalogItem,
  type IntegrationConnection,
  type IntegrationDetailResponse,
  type IntegrationLifecycleAction,
  type IntegrationsCatalogResponse,
} from "../../lib/api-client";
import {
  commerceAdministrationRoute,
  commerceTaskForLifecycleAction,
  isCommerceOwnedIntegration,
  type CommerceAdministrationTask,
} from "../../lib/commerce-owner-intents";
import { buildDashboardHref, getDashboardUrl } from "../../lib/dashboard-url";
import {
  navigateDesktopSection,
  requestDesktopRouteNavigation,
} from "../../lib/desktop-router";
import { pathToSection } from "../../lib/store";
import { tauriApi } from "../../lib/tauri";
import {
  integrationApiErrorDetail,
  lifecycleActionLabel,
  nativeConnectTarget,
  nativeProviderFamily,
  type NativeConnectTarget,
  type NativeProviderFamily,
} from "../integrations-helpers";
import {
  parseIntegrationActionResponse,
  parseIntegrationDetail,
} from "../integrations-response-contract";

type NativeLifecycleApi = {
  sync: (id: string) => Promise<ApiResult<unknown>>;
  backfill: (id: string) => Promise<ApiResult<unknown>>;
  pause: (id: string) => Promise<ApiResult<unknown>>;
  disconnect: (id: string) => Promise<ApiResult<unknown>>;
};

type NativeLifecycleOutcome = "not-handled" | "succeeded" | "failed";
type MutationSurface = "card" | "detail";

const ALLOWED_LIFECYCLE_ACTIONS = new Set([
  "connect/start",
  "connect/callback",
  "sync",
  "backfill",
  "pause",
  "disconnect",
  "roadmap",
]);

export interface NativeConnectSelection {
  target: NativeConnectTarget;
  item: IntegrationCatalogItem;
}

export interface IntegrationLifecycleController {
  busySlug: string;
  busyLifecycleAction: string;
  selectedSlug: string;
  detail: IntegrationDetailResponse | null;
  detailLoading: boolean;
  disconnectVerifying: boolean;
  pendingDisconnectItem: IntegrationCatalogItem | null;
  connectSelection: NativeConnectSelection | null;
  runAction: (
    item: IntegrationCatalogItem,
    action: "connect" | "sync",
  ) => Promise<boolean>;
  openManage: (path?: string, item?: IntegrationCatalogItem) => void;
  openDetail: (item: IntegrationCatalogItem) => Promise<void>;
  closeDetail: () => void;
  runLifecycleAction: (
    item: IntegrationCatalogItem,
    action: string,
  ) => Promise<void>;
  closeConnect: () => void;
  completeConnect: () => Promise<void>;
  confirmDisconnect: () => Promise<void>;
  closeDisconnect: () => void;
}

interface LifecycleControllerOptions {
  canAdmin: boolean;
  catalog: IntegrationsCatalogResponse | null;
  connectionMap: Map<string, IntegrationConnection>;
  refresh: () => Promise<void>;
}

function nativeLifecycleApiForFamily(
  family: NativeProviderFamily | null,
): NativeLifecycleApi | null {
  switch (family) {
    case "crm":
      return crmIntegrationsApi;
    case "lead_capture":
      return leadIntegrationsApi;
    case "review_integration":
      return reviewIntegrationsApi;
    case "loyalty_integration":
      return loyaltyIntegrationsApi;
    case "subscription_integration":
      return subscriptionIntegrationsApi;
    case "support_integration":
      return supportIntegrationsApi;
    case "analytics_integration":
      return analyticsIntegrationsApi;
    default:
      return null;
  }
}

function boundedText(value: unknown, max = 120): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nativeLifecycleDetail(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const row = data as Record<string, unknown>;
  return [
    boundedText(row.status) ? `Status ${boundedText(row.status)}` : "",
    boundedText(row.run_id) ? `Run ${boundedText(row.run_id)}` : "",
    boundedText(row.id) ? `Connection ${boundedText(row.id)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function safeExternalDestination(path: string): string | null {
  if (!/^https?:\/\//iu.test(path)) {
    return buildDashboardHref(getDashboardUrl(), path);
  }
  try {
    const parsed = new URL(path);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function openIntegrationPath(path?: string): void {
  if (!path) {
    toast.info("No setup destination was supplied for this integration.");
    return;
  }
  const target = pathToSection(path);
  if (target) {
    navigateDesktopSection(target);
    return;
  }
  const destination = safeExternalDestination(path);
  if (!destination) {
    toast.error("The integration supplied an invalid setup destination.");
    return;
  }
  void tauriApi.openUrl(destination).catch(() => {
    toast.error({
      message: "Could not open the setup destination",
      detail: "Check the default-browser settings and try again.",
    });
  });
}

function connectionIDs(
  connection: IntegrationConnection | undefined,
): string[] {
  if (!connection) return [];
  return Array.from(
    new Set(
      [
        ...(connection.connection_ids ?? []),
        connection.primary_connection_id ?? "",
      ].filter(Boolean),
    ),
  );
}

function sameConnectionIdentity(
  before: IntegrationConnection | undefined,
  after: IntegrationConnection,
): boolean {
  const beforeIDs = connectionIDs(before).sort();
  if (beforeIDs.length === 0) return true;
  const afterIDs = connectionIDs(after).sort();
  return (
    beforeIDs.length === afterIDs.length &&
    beforeIDs.every((id, index) => id === afterIDs[index])
  );
}

export function useIntegrationLifecycleController({
  canAdmin,
  catalog,
  connectionMap,
  refresh,
}: LifecycleControllerOptions): IntegrationLifecycleController {
  const [busySlug, setBusySlug] = useState("");
  const [busyLifecycleAction, setBusyLifecycleAction] = useState("");
  const [selectedSlug, setSelectedSlug] = useState("");
  const [detail, setDetail] = useState<IntegrationDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [disconnectVerifying, setDisconnectVerifying] = useState(false);
  const [pendingDisconnectItem, setPendingDisconnectItem] =
    useState<IntegrationCatalogItem | null>(null);
  const [connectSelection, setConnectSelection] =
    useState<NativeConnectSelection | null>(null);
  const mountedRef = useRef(true);
  const detailRequestSequence = useRef(0);
  const activeMutation = useRef("");
  const disconnectVerification = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailRequestSequence.current += 1;
      activeMutation.current = "";
      disconnectVerification.current = false;
    };
  }, []);

  const beginMutation = (
    key: string,
    surface: MutationSurface,
    item: IntegrationCatalogItem,
  ): boolean => {
    if (activeMutation.current || disconnectVerification.current) {
      toast.info({
        message: "Another integration operation is still in progress",
        detail: "Wait for it to finish before changing another connection.",
      });
      return false;
    }
    activeMutation.current = key;
    if (surface === "card") setBusySlug(item.slug);
    else setBusyLifecycleAction(key);
    return true;
  };

  const finishMutation = (key: string, surface: MutationSurface): void => {
    if (activeMutation.current !== key) return;
    activeMutation.current = "";
    if (!mountedRef.current) return;
    if (surface === "card") setBusySlug("");
    else setBusyLifecycleAction("");
  };

  const connectionFor = (
    item: IntegrationCatalogItem,
  ): IntegrationConnection | undefined =>
    detail?.item.slug === item.slug
      ? detail.connection
      : connectionMap.get(item.slug);

  const handoffCommerceAdministration = async (
    item: IntegrationCatalogItem,
    task: CommerceAdministrationTask,
  ): Promise<void> => {
    const connection = connectionFor(item);
    await requestDesktopRouteNavigation(
      commerceAdministrationRoute({
        task,
        provider: item.slug,
        ...(connection?.primary_connection_id
          ? { integrationId: connection.primary_connection_id }
          : {}),
      }),
    );
  };

  const closeDetail = (): void => {
    detailRequestSequence.current += 1;
    setSelectedSlug("");
    setDetail(null);
    setDetailLoading(false);
  };

  const openDetail = async (item: IntegrationCatalogItem): Promise<void> => {
    if (isCommerceOwnedIntegration(item)) {
      closeDetail();
      await handoffCommerceAdministration(item, "manage");
      return;
    }
    const sequence = detailRequestSequence.current + 1;
    detailRequestSequence.current = sequence;
    setSelectedSlug(item.slug);
    setDetail(null);
    setDetailLoading(true);
    try {
      const result = await integrationsApi.detail(item.slug);
      if (!mountedRef.current || detailRequestSequence.current !== sequence) {
        return;
      }
      if (result.error) {
        toast.error({
          message: `Could not load ${item.name}`,
          detail: integrationApiErrorDetail(result.error),
        });
        return;
      }
      const parsed = parseIntegrationDetail(result.data, item.slug);
      if (!parsed) {
        toast.error({
          message: `Could not verify ${item.name}`,
          detail:
            "The server returned malformed or mismatched integration evidence.",
        });
        return;
      }
      setDetail(parsed);
    } finally {
      if (mountedRef.current && detailRequestSequence.current === sequence) {
        setDetailLoading(false);
      }
    }
  };

  const runNativeManagedLifecycleAction = async (
    item: IntegrationCatalogItem,
    action: string,
    openAfter = true,
    exactConnection?: IntegrationConnection,
  ): Promise<NativeLifecycleOutcome> => {
    const api = nativeLifecycleApiForFamily(nativeProviderFamily(item));
    if (!api || !["sync", "backfill", "pause", "disconnect"].includes(action)) {
      return "not-handled";
    }
    const connection = exactConnection ?? connectionFor(item);
    const ids = connectionIDs(connection);
    if ((connection?.count ?? ids.length) > 1 || ids.length > 1) {
      toast.error({
        message: `Choose the exact ${item.name} connection first`,
        detail:
          "This workspace has multiple configured accounts. Open Manage and select one before running a lifecycle action.",
      });
      return "failed";
    }
    const connectionID = ids[0];
    if (!connectionID) return "not-handled";
    const result =
      action === "sync"
        ? await api.sync(connectionID)
        : action === "backfill"
          ? await api.backfill(connectionID)
          : action === "pause"
            ? await api.pause(connectionID)
            : await api.disconnect(connectionID);
    if (result.error) {
      toast.error({
        message: `${item.name} ${lifecycleActionLabel(action)} failed`,
        detail: integrationApiErrorDetail(result.error),
      });
      return "failed";
    }
    toast.info({
      message: `${item.name} ${lifecycleActionLabel(action)} request accepted`,
      detail:
        nativeLifecycleDetail(result.data) ||
        connection?.manage_path ||
        "Refresh connection health to confirm completion.",
    });
    await refresh();
    if (openAfter) await openDetail(item);
    return "succeeded";
  };

  const runAction = async (
    item: IntegrationCatalogItem,
    action: "connect" | "sync",
  ): Promise<boolean> => {
    if (!canAdmin) {
      toast.error("Admin access is required to manage integrations.");
      return false;
    }
    if (isCommerceOwnedIntegration(item)) {
      await handoffCommerceAdministration(
        item,
        action === "connect" ? "connect" : "sync",
      );
      return true;
    }
    if (nativeProviderFamily(item) === "support_integration") {
      setConnectSelection({ target: "support_integration", item });
      return true;
    }
    const connectTarget = nativeConnectTarget(item, action);
    if (connectTarget) {
      setConnectSelection({ target: connectTarget, item });
      return true;
    }
    const key = `${item.slug}:${action}`;
    if (!beginMutation(key, "card", item)) return false;
    try {
      if (action === "sync" && nativeProviderFamily(item)) {
        const outcome = await runNativeManagedLifecycleAction(
          item,
          "sync",
          false,
        );
        if (outcome !== "not-handled") return outcome === "succeeded";
      }
      const result =
        action === "connect"
          ? await integrationsApi.startConnect(item.slug)
          : await integrationsApi.sync(item.slug);
      if (result.error) {
        toast.error({
          message: `${item.name} ${action} failed`,
          detail: integrationApiErrorDetail(result.error),
        });
        return false;
      }
      const expectedAction = action === "connect" ? "connect/start" : "sync";
      const parsed = parseIntegrationActionResponse(result.data, {
        slug: item.slug,
        action: expectedAction,
      });
      if (!parsed) {
        toast.error({
          message: `${item.name} could not be verified`,
          detail:
            "The operation returned malformed or mismatched response evidence.",
        });
        return false;
      }
      const delegated = parsed.status === "delegated";
      toast.info({
        message: delegated
          ? `${item.name} ${action === "connect" ? "setup" : "sync"} handoff is ready`
          : parsed.message,
        detail: delegated
          ? "No connection change was performed in this screen. Continue in the owning setup surface."
          : (parsed.manage_path ?? parsed.delegated_to),
      });
      await refresh();
      if (delegated) {
        openIntegrationPath(
          parsed.manage_path ?? item.setup_path ?? item.docs_url,
        );
      }
      return parsed.status === "delegated";
    } finally {
      finishMutation(key, "card");
    }
  };

  const performLifecycleAction = async (
    item: IntegrationCatalogItem,
    action: string,
    exactConnection?: IntegrationConnection,
  ): Promise<boolean> => {
    if (!ALLOWED_LIFECYCLE_ACTIONS.has(action)) {
      toast.error({
        message: "Unsupported integration action",
        detail: `${lifecycleActionLabel(action)} is not in this client's verified action allowlist.`,
      });
      return false;
    }
    if (action === "roadmap") {
      openIntegrationPath(item.docs_url);
      return true;
    }
    if (!canAdmin) {
      toast.error("Admin access is required to manage integrations.");
      return false;
    }
    if (isCommerceOwnedIntegration(item)) {
      const task = commerceTaskForLifecycleAction(action);
      await handoffCommerceAdministration(item, task ?? "manage");
      return true;
    }
    if (action === "connect/start") return runAction(item, "connect");
    if (action === "connect/callback") {
      toast.info({
        message: "Complete OAuth from the provider setup flow",
        detail:
          "Moosewave will only accept a provider callback that is bound to the original browser authorization session.",
      });
      openIntegrationPath(item.setup_path ?? item.docs_url);
      return true;
    }

    const key = `${item.slug}:${action}`;
    if (!beginMutation(key, "detail", item)) return false;
    try {
      const nativeOutcome = await runNativeManagedLifecycleAction(
        item,
        action,
        true,
        exactConnection,
      );
      if (nativeOutcome !== "not-handled") {
        return nativeOutcome === "succeeded";
      }
      const result =
        action === "sync"
          ? await integrationsApi.sync(item.slug)
          : action === "backfill"
            ? await integrationsApi.backfill(item.slug)
            : action === "pause"
              ? await integrationsApi.pause(item.slug)
              : await integrationsApi.disconnect(item.slug);
      if (result.error) {
        toast.error({
          message: `${item.name} ${lifecycleActionLabel(action)} failed`,
          detail: integrationApiErrorDetail(result.error),
        });
        return false;
      }
      const parsed = parseIntegrationActionResponse(result.data, {
        slug: item.slug,
        action: action as IntegrationLifecycleAction,
      });
      if (!parsed) {
        toast.error({
          message: `${item.name} could not be verified`,
          detail:
            "The server returned malformed or mismatched lifecycle evidence.",
        });
        return false;
      }
      const delegated = parsed.status === "delegated";
      const detailParts = [
        delegated
          ? "No lifecycle change was performed in this screen. Continue in the owning management surface."
          : "Refresh health to confirm completion.",
        parsed.primary_connection_id
          ? `Connection ${parsed.primary_connection_id}`
          : "",
      ].filter(Boolean);
      toast.info({
        message: delegated
          ? `${item.name} ${lifecycleActionLabel(action)} handoff is ready`
          : parsed.message,
        detail: detailParts.join(" · ") || parsed.manage_path,
      });
      await refresh();
      if (delegated) {
        openIntegrationPath(
          parsed.manage_path ?? item.setup_path ?? item.docs_url,
        );
      } else if (action !== "disconnect") {
        await openDetail(item);
      }
      return parsed.status === "delegated";
    } finally {
      finishMutation(key, "detail");
    }
  };

  const runLifecycleAction = async (
    item: IntegrationCatalogItem,
    action: string,
  ): Promise<void> => {
    if (nativeProviderFamily(item) === "support_integration") {
      setConnectSelection({ target: "support_integration", item });
      return;
    }
    if (!ALLOWED_LIFECYCLE_ACTIONS.has(action)) {
      await performLifecycleAction(item, action);
      return;
    }
    if (!isCommerceOwnedIntegration(item) && action === "disconnect") {
      setPendingDisconnectItem(item);
      return;
    }
    await performLifecycleAction(item, action);
  };

  const confirmDisconnect = async (): Promise<void> => {
    const item = pendingDisconnectItem;
    if (!item) return;
    if (disconnectVerification.current || activeMutation.current) {
      toast.info({
        message: "Another integration operation is still in progress",
        detail: "Wait for it to finish before confirming disconnection.",
      });
      return;
    }
    disconnectVerification.current = true;
    setDisconnectVerifying(true);
    try {
      const before = connectionFor(item);
      const sequence = detailRequestSequence.current + 1;
      detailRequestSequence.current = sequence;
      const result = await integrationsApi.detail(item.slug);
      if (
        !mountedRef.current ||
        detailRequestSequence.current !== sequence ||
        pendingDisconnectItem?.slug !== item.slug
      ) {
        return;
      }
      if (result.error) {
        toast.error({
          message: `Could not re-verify ${item.name}`,
          detail: `Disconnect was not started because the exact connection could not be checked again. · ${integrationApiErrorDetail(result.error)}`,
        });
        return;
      }
      const exact = parseIntegrationDetail(result.data, item.slug);
      if (!exact) {
        toast.error({
          message: "Disconnect target changed",
          detail:
            "Nothing was disconnected because the re-verification evidence was malformed or mismatched.",
        });
        return;
      }
      if (!sameConnectionIdentity(before, exact.connection)) {
        setDetail(exact);
        toast.error({
          message: "Connection identity changed",
          detail:
            "Nothing was disconnected. Review the newly verified connection before trying again.",
        });
        return;
      }
      const exactConnectionCount = Math.max(
        exact.connection.count,
        connectionIDs(exact.connection).length,
      );
      if (exactConnectionCount > 1) {
        setDetail(exact);
        toast.error({
          message: `Choose the exact ${item.name} connection first`,
          detail:
            "Nothing was disconnected. Open Manage and select one configured account before trying again.",
        });
        return;
      }
      if (selectedSlug === item.slug) setDetail(exact);
      // The exact-target preflight owns the lock until this synchronous call
      // acquires the normal mutation lock. No event loop turn exists between
      // the handoff, so a second operation cannot slip into the gap.
      disconnectVerification.current = false;
      const completed = await performLifecycleAction(
        exact.item,
        "disconnect",
        exact.connection,
      );
      if (completed && mountedRef.current) setPendingDisconnectItem(null);
    } finally {
      disconnectVerification.current = false;
      if (mountedRef.current) setDisconnectVerifying(false);
    }
  };

  return {
    busySlug,
    busyLifecycleAction,
    selectedSlug,
    detail,
    detailLoading,
    disconnectVerifying,
    pendingDisconnectItem,
    connectSelection,
    runAction,
    openManage: (path, item) => {
      if (item && nativeProviderFamily(item) === "support_integration") {
        setConnectSelection({ target: "support_integration", item });
        return;
      }
      if (item && isCommerceOwnedIntegration(item)) {
        void handoffCommerceAdministration(item, "manage");
        return;
      }
      openIntegrationPath(path);
    },
    openDetail,
    closeDetail,
    runLifecycleAction,
    closeConnect: () => setConnectSelection(null),
    completeConnect: async () => {
      const selected = connectSelection;
      if (!selected) return;
      setConnectSelection(null);
      await refresh();
      const latest =
        (catalog?.items ?? []).find(
          (candidate) => candidate.slug === selected.item.slug,
        ) ?? selected.item;
      await openDetail(latest);
    },
    confirmDisconnect,
    closeDisconnect: () => {
      if (!activeMutation.current && !disconnectVerification.current) {
        setPendingDisconnectItem(null);
      }
    },
  };
}
