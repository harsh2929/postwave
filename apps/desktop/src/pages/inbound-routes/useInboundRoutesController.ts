import { useEffect, useId, useRef, useState } from "react";

import type { StatCell } from "../../components/StatStrip";
import { toast } from "../../components/Toast";
import {
  type InboundEmailEndpoint,
  type InboundRoute,
  type InboundRouteInput,
  api,
} from "../../lib/api-client";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { safeInboundFailure } from "../../lib/inbound-safe-error";
import { isRemotePermissionError } from "../../lib/remote-resource";
import { useCanAdmin } from "../../lib/store";

const ROUTE_REORDER_OPERATION = "routes:reorder";
const ENDPOINT_ROTATE_OPERATION = "endpoint:rotate";

function unexpectedOperationDetail(action: string): string {
  return `${action} did not complete. Check your connection and try again.`;
}

function actionsForDisabledDuplicate(
  route: InboundRoute,
): InboundRouteInput["actions"] {
  return route.actions.map((action) => {
    const {
      has_stored_hmac_secret: _storedMarker,
      preserve_hmac_from_index: _preserveMarker,
      remove_stored_hmac: _removeMarker,
      ...safeAction
    } = action;
    void _storedMarker;
    void _preserveMarker;
    void _removeMarker;
    if (action.kind !== "webhook" || !action.extra) return safeAction;
    const { hmac_secret: _secret, ...safeExtra } = action.extra;
    void _secret;
    const duplicate = { ...safeAction };
    if (Object.keys(safeExtra).length > 0) duplicate.extra = safeExtra;
    else delete duplicate.extra;
    return duplicate;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInboundRoute(value: unknown): value is InboundRoute {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    typeof value.priority === "number" &&
    Number.isFinite(value.priority) &&
    typeof value.stop_on_match === "boolean" &&
    typeof value.enabled === "boolean" &&
    typeof value.match_recipient === "string" &&
    Array.isArray(value.actions) &&
    typeof value.match_count === "number" &&
    Number.isFinite(value.match_count) &&
    typeof value.updated_at === "string" &&
    Number.isFinite(Date.parse(value.updated_at))
  );
}

function isInboundEndpoint(value: unknown): value is InboundEmailEndpoint {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.tenantId === "string" &&
    typeof value.slug === "string" &&
    value.slug.trim().length > 0 &&
    typeof value.secretConfigured === "boolean" &&
    typeof value.rotationRequired === "boolean" &&
    typeof value.createdAt === "string"
  );
}

export function inboundRouteStats(rows: InboundRoute[] | null): StatCell[] {
  if (!rows) {
    return [
      { label: "Routes", value: "—" },
      { label: "Enabled", value: "—" },
      { label: "Total matches", value: "—" },
    ];
  }
  const enabled = rows.filter((route) => route.enabled).length;
  const matches = rows.reduce(
    (total, route) => total + (route.match_count ?? 0),
    0,
  );
  return [
    { label: "Routes", value: rows.length.toLocaleString() },
    {
      label: "Enabled",
      value: enabled.toLocaleString(),
      hint: "Disabled rules are skipped during evaluation; they stay in the table for reference.",
    },
    {
      label: "Total matches",
      value: matches.toLocaleString(),
      hint: "Cumulative match count across all rules since each was created.",
    },
  ];
}

function useInboundRoutesRemoteState() {
  const [rows, setRows] = useState<InboundRoute[] | null>(null);
  const [endpoint, setEndpoint] = useState<InboundEmailEndpoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [endpointStatus, setEndpointStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [endpointErr, setEndpointErr] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const routesRequestRef = useRef(0);
  const endpointRequestRef = useRef(0);
  const reloadRequestRef = useRef(0);
  const reloadFlightRef = useRef<Promise<void> | null>(null);

  const loadRoutes = async (): Promise<void> => {
    if (!mountedRef.current) return;
    const token = ++routesRequestRef.current;
    let response;
    try {
      response = await api.inboundRoutesList();
    } catch {
      if (mountedRef.current && token === routesRequestRef.current) {
        setErr(
          "Couldn't load inbound routes. Check your connection and retry.",
        );
      }
      return;
    }
    if (!mountedRef.current || token !== routesRequestRef.current) return;
    if (response.error) {
      setErr(
        safeInboundFailure(response.error, "Couldn't verify inbound routes."),
      );
      if (isRemotePermissionError(response.error)) setRows(null);
      return;
    }
    if (
      !response.data ||
      !Array.isArray(response.data.routes) ||
      !response.data.routes.every(isInboundRoute)
    ) {
      setErr("Couldn't verify inbound routes. The response was incomplete.");
      return;
    }
    setErr(null);
    setRows(response.data.routes);
  };

  const loadEndpoint = async (): Promise<void> => {
    if (!mountedRef.current) return;
    const token = ++endpointRequestRef.current;
    setEndpointStatus("loading");
    setEndpointErr(null);
    let response;
    try {
      response = await api.inboundEndpointGet();
    } catch {
      if (mountedRef.current && token === endpointRequestRef.current) {
        setEndpointStatus("error");
        setEndpointErr(
          "Couldn't verify the inbound endpoint. Check the connection and retry.",
        );
      }
      return;
    }
    if (!mountedRef.current || token !== endpointRequestRef.current) return;
    if (response.error) {
      if (response.error.status === 404) {
        setEndpoint(null);
        setEndpointStatus("ready");
        setEndpointErr(null);
        return;
      }
      if (isRemotePermissionError(response.error)) setEndpoint(null);
      setEndpointStatus("error");
      setEndpointErr(
        safeInboundFailure(
          response.error,
          "Couldn't verify the inbound endpoint.",
        ),
      );
      return;
    }
    if (!isInboundEndpoint(response.data)) {
      setEndpointStatus("error");
      setEndpointErr(
        "Couldn't verify the inbound endpoint. The response was incomplete.",
      );
      return;
    }
    setEndpoint(response.data);
    setEndpointStatus("ready");
    setEndpointErr(null);
  };

  const reload = async (): Promise<void> => {
    if (reloadFlightRef.current) {
      await reloadFlightRef.current;
      return;
    }
    if (!mountedRef.current) return;
    const token = ++reloadRequestRef.current;
    let request: Promise<void>;
    request = (async (): Promise<void> => {
      setLoading(true);
      await Promise.all([loadRoutes(), loadEndpoint()]);
    })();
    reloadFlightRef.current = request;
    try {
      await request;
    } finally {
      if (reloadFlightRef.current === request) reloadFlightRef.current = null;
      if (mountedRef.current && token === reloadRequestRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
      routesRequestRef.current += 1;
      endpointRequestRef.current += 1;
      reloadRequestRef.current += 1;
      // Active mutations deliberately keep their process-wide guards until
      // their promises settle.
      // Do not unregister them merely because a typed route unmounted this page.
      // Request tokens only retire remote reads.
    };
    // The mount lifecycle owns the first load; request tokens handle overlap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    rows,
    setRows,
    endpoint,
    setEndpoint,
    loading,
    err,
    endpointStatus,
    endpointErr,
    mountedRef,
    endpointRequestRef,
    loadRoutes,
    reload,
  };
}

function useInboundOperationRegistry(
  instanceId: string,
  mountedRef: React.RefObject<boolean>,
) {
  const activeOperationsRef = useRef(new Map<string, () => void>());
  const [activeOperations, setActiveOperations] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  /**
   * The registry owner is intentionally imperative: it outlives this page if a
   * typed route change unmounts the controller while the request is still in
   * flight. The request's `finally` releases it. React state is only a UI
   * mirror and is never touched after unmount.
   */
  const beginOperation = (
    key: string,
    label: string,
    detail: string,
  ): boolean => {
    if (!mountedRef.current || activeOperationsRef.current.has(key)) {
      return false;
    }
    const unregister = registerLifecycleGuard({
      id: `active-operation-inbound-routes-${instanceId}-${key}`,
      label,
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : {
              level: "blocking",
              detail,
              canSave: false,
              canDiscard: false,
              canRecover: false,
            },
    });
    activeOperationsRef.current.set(key, unregister);
    setActiveOperations(new Set(activeOperationsRef.current.keys()));
    return true;
  };

  const finishOperation = (key: string): void => {
    const unregister = activeOperationsRef.current.get(key);
    if (!unregister) return;
    activeOperationsRef.current.delete(key);
    unregister();
    if (mountedRef.current) {
      setActiveOperations(new Set(activeOperationsRef.current.keys()));
    }
  };

  return { activeOperations, beginOperation, finishOperation };
}

interface RouteOrderOperation {
  beginOperation: (key: string, label: string, detail: string) => boolean;
  finishOperation: (key: string) => void;
  loadRoutes: () => Promise<void>;
  mountedRef: React.RefObject<boolean>;
}

async function persistRouteOrder(
  orderedRoutes: InboundRoute[],
  failureMessage: string,
  operation: RouteOrderOperation,
): Promise<void> {
  if (
    !operation.beginOperation(
      ROUTE_REORDER_OPERATION,
      "Inbound route reorder",
      "Wait for route reordering to finish before leaving Moosewave.",
    )
  ) {
    return;
  }
  try {
    const response = await api.inboundRoutesReorder(
      orderedRoutes.map((route) => route.id),
    );
    if (!operation.mountedRef.current) return;
    if (response.error) {
      toast.error({
        message: failureMessage,
        detail: safeInboundFailure(
          response.error,
          "The route order wasn't changed. Refresh to verify the current order.",
        ),
      });
    }
    await operation.loadRoutes();
  } catch {
    if (operation.mountedRef.current) {
      toast.error({
        message: failureMessage,
        detail: unexpectedOperationDetail("Route reorder"),
      });
    }
  } finally {
    operation.finishOperation(ROUTE_REORDER_OPERATION);
  }
}

export function useInboundRoutesController() {
  const canAdmin = useCanAdmin();
  const instanceId = useId();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<InboundRoute | null>(null);
  const [deleting, setDeleting] = useState<InboundRoute | null>(null);
  const remote = useInboundRoutesRemoteState();
  const {
    rows,
    endpoint,
    endpointStatus,
    endpointErr,
    setEndpoint,
    loading,
    err,
    mountedRef,
    endpointRequestRef,
    loadRoutes,
    reload,
  } = remote;
  const { activeOperations, beginOperation, finishOperation } =
    useInboundOperationRegistry(instanceId, mountedRef);
  const routeOrderOperation: RouteOrderOperation = {
    beginOperation,
    finishOperation,
    loadRoutes,
    mountedRef,
  };

  const toggleEnabled = async (route: InboundRoute): Promise<void> => {
    const key = `route:${route.id}:toggle`;
    const action = route.enabled ? "Route disable" : "Route enable";
    if (
      !beginOperation(
        key,
        action,
        `Wait for the ${action.toLowerCase()} request to finish before leaving Moosewave.`,
      )
    ) {
      return;
    }
    try {
      const response = await api.inboundRoutePatch(route.id, {
        enabled: !route.enabled,
      });
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error({
          message: route.enabled
            ? "Couldn't disable route"
            : "Couldn't enable route",
          detail: safeInboundFailure(
            response.error,
            "The route status wasn't changed.",
          ),
        });
        return;
      }
      await loadRoutes();
    } catch {
      if (mountedRef.current) {
        toast.error({
          message: route.enabled
            ? "Couldn't disable route"
            : "Couldn't enable route",
          detail: unexpectedOperationDetail(action),
        });
      }
    } finally {
      finishOperation(key);
    }
  };

  const move = async (
    route: InboundRoute,
    direction: -1 | 1,
  ): Promise<void> => {
    if (!rows) return;
    const index = rows.findIndex((item) => item.id === route.id);
    if (index < 0) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rows.length) return;
    const neighbour = rows[targetIndex];
    const next = [...rows];
    next[index] = neighbour;
    next[targetIndex] = route;
    await persistRouteOrder(
      next,
      "Couldn't reorder routes",
      routeOrderOperation,
    );
  };

  const reorder = async (
    sourceId: string,
    targetId: string,
    placeBefore: boolean,
  ): Promise<void> => {
    if (!rows || sourceId === targetId) return;
    const source = rows.find((item) => item.id === sourceId);
    const target = rows.find((item) => item.id === targetId);
    if (!source || !target) return;
    const withoutSource = rows.filter((item) => item.id !== sourceId);
    const targetIndex = withoutSource.findIndex((item) => item.id === targetId);
    if (targetIndex < 0) return;
    const insertAt = placeBefore ? targetIndex : targetIndex + 1;
    const next = [
      ...withoutSource.slice(0, insertAt),
      source,
      ...withoutSource.slice(insertAt),
    ];
    await persistRouteOrder(next, "Reorder failed", routeOrderOperation);
  };

  const duplicate = async (route: InboundRoute): Promise<void> => {
    const key = `route:${route.id}:duplicate`;
    if (
      !beginOperation(
        key,
        "Inbound route duplication",
        "Wait for route duplication to finish before leaving Moosewave.",
      )
    ) {
      return;
    }
    const input: InboundRouteInput = {
      name: `${route.name} (copy)`,
      priority: route.priority + 1,
      stop_on_match: route.stop_on_match,
      enabled: false,
      match_recipient: route.match_recipient,
      match_subject_prefix: route.match_subject_prefix,
      match_from_domain: route.match_from_domain,
      actions: actionsForDisabledDuplicate(route),
    };
    try {
      const response = await api.inboundRouteCreate(input);
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error({
          message: "Couldn't duplicate route",
          detail: safeInboundFailure(
            response.error,
            "The route wasn't duplicated.",
          ),
        });
        return;
      }
      toast.success({
        message: "Route duplicated",
        detail:
          "The copy is disabled and webhook signing secrets were removed — review credentials before enabling it.",
      });
      await loadRoutes();
    } catch {
      if (mountedRef.current) {
        toast.error({
          message: "Couldn't duplicate route",
          detail: unexpectedOperationDetail("Route duplication"),
        });
      }
    } finally {
      finishOperation(key);
    }
  };

  const rotateEndpoint = async (): Promise<boolean> => {
    if (
      !beginOperation(
        ENDPOINT_ROTATE_OPERATION,
        "Inbound endpoint signing-secret rotation",
        "Wait for endpoint secret creation or rotation to finish before leaving Moosewave.",
      )
    ) {
      return false;
    }
    const creating = endpoint == null;
    const token = ++endpointRequestRef.current;
    try {
      const response = await api.inboundEndpointRotate();
      if (!mountedRef.current || token !== endpointRequestRef.current) {
        return false;
      }
      if (response.error) {
        toast.error({
          message: "Couldn't rotate signing secret",
          detail: safeInboundFailure(
            response.error,
            "The signing secret wasn't rotated.",
          ),
        });
        return false;
      }
      if (!response.data?.secret) {
        const metadata = response.data ?? endpoint;
        if (metadata) {
          const { secret: _secret, ...safeMetadata } = metadata;
          void _secret;
          setEndpoint({ ...safeMetadata, rotationRequired: true });
        } else {
          setEndpoint(null);
        }
        toast.error({
          message: "Signing secret changed without a usable reveal",
          detail:
            "Do not send traffic with the previous value. Rotate again to obtain a new one-time secret.",
        });
        return false;
      }
      setEndpoint(response.data);
      toast.success({
        message: creating
          ? "Inbound endpoint created"
          : "Signing secret rotated",
        detail: "Copy the new secret now and update your signing proxy.",
      });
      return true;
    } catch {
      if (mountedRef.current) {
        toast.error({
          message: creating
            ? "Couldn't create inbound endpoint"
            : "Couldn't rotate signing secret",
          detail: unexpectedOperationDetail(
            creating ? "Endpoint creation" : "Signing-secret rotation",
          ),
        });
      }
      return false;
    } finally {
      finishOperation(ENDPOINT_ROTATE_OPERATION);
    }
  };

  const clearEndpointSecret = (): void => {
    setEndpoint((current) => {
      if (!current?.secret) return current;
      const { secret: _secret, ...metadata } = current;
      void _secret;
      return metadata;
    });
  };

  return {
    canAdmin,
    rows,
    endpoint,
    endpointStatus,
    endpointErr,
    loading,
    err,
    activeOperations,
    stats: inboundRouteStats(rows),
    showCreate,
    setShowCreate,
    editing,
    setEditing,
    deleting,
    setDeleting,
    loadRoutes,
    reload,
    toggleEnabled,
    move,
    reorder,
    duplicate,
    rotateEndpoint,
    clearEndpointSecret,
  };
}

export type InboundRoutesController = ReturnType<
  typeof useInboundRoutesController
>;
