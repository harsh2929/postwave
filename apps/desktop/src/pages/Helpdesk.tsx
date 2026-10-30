/**
 * Helpdesk — the customer-service suite surface (Klaviyo-parity KLV-10).
 *
 * Three tabs over the service_suite backend:
 *   · Inbox        — conversation list + thread view + reply/assign/status/macros
 *   · Customer Hub — the storefront hub config (toggles, agent enablement)
 *   · Agent        — source-held Customer Agent capability and static
 *                    deterministic-template guardrail truth
 *
 * HONEST framing: inbound email is NOT auto-bridged into conversations yet
 * (no inbound-email→service_suite bridge exists), so the Inbox shows the
 * conversations the backend actually has (SMS / web-chat / manually created)
 * — it never implies a unified email inbox that isn't wired.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { RemoteDataNotice } from "../components/RemoteDataNotice";
import { CustomerAgentPanel } from "../components/helpdesk/CustomerAgentPanel";
import { CustomerHubConfig } from "../components/helpdesk/CustomerHubConfig";
import { HelpdeskInbox } from "../components/helpdesk/HelpdeskInbox";
import {
  getApiUrl,
  type ServiceSuiteCatalog,
  serviceSuiteApi,
} from "../lib/api-client";
import { useCapabilityReporter } from "../lib/capability-observations";
import { useRemoteResource } from "../hooks/useRemoteResource";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  getDesktopRoute,
  desktopRouteIdentityScope,
  navigateDesktopRoute,
  useDesktopRoute,
  useDesktopRouteTab,
} from "../lib/desktop-router";
import { isInitialRemoteLoad } from "../lib/remote-resource";
import { useCanAdmin, useMe, useRoleStatus } from "../lib/store";
import { decodeServiceSuiteCatalog } from "../components/helpdesk/agent-helpers";
import {
  canonicalNoteRecoveryApiBaseUrl,
  sessionNoteRecoveryAuthority,
} from "../components/helpdesk/internal-note-recovery";
import {
  isCanonicalHelpdeskId,
  isSafeHelpdeskStatusRouteValue,
} from "../components/helpdesk/helpdesk-helpers";
import { onContextEpochObserved, readContextEpoch } from "../lib/context-epoch";
import { apiIdentityGenerationIsCurrent } from "../lib/api-identity-transition";
import { useOnline } from "../lib/online-manager";

import "../styles-helpdesk.css";

type Tab = "inbox" | "hub" | "agent";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "hub", label: "Customer Hub" },
  { id: "agent", label: "Agent" },
];

export function Helpdesk(): ReactElement {
  const me = useMe();
  const canAdmin = useCanAdmin();
  const roleStatus = useRoleStatus();
  const online = useOnline();
  const route = useDesktopRoute();
  const tenantId = me?.tenant ?? null;
  const contextEpoch = useSyncExternalStore(
    onContextEpochObserved,
    readContextEpoch,
    readContextEpoch,
  );
  const routeIdentityScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  // Durable note tombstones survive role/context-epoch refreshes for the same
  // principal, tenant, and canonical full API base. Reauthorization still uses
  // the epoch-bound scope below; the opaque authority is only the encrypted
  // idempotency namespace and must change across workspace/API origins.
  // The durable note ledger is server-bound to the canonical session user.
  // API-key `actor` is caller-controlled display text and self-info does not
  // expose the key id, so it cannot safely namespace recovery. Keep note
  // creation unavailable for API-key provenance rather than risk cross-key
  // tombstone reuse after a key rotation or switch.
  const noteRecoveryPrincipal = me?.noteRecoveryPrincipal;
  const currentNoteApiBaseUrl = canonicalNoteRecoveryApiBaseUrl(getApiUrl());
  const noteRecoveryAuthority =
    noteRecoveryPrincipal &&
    currentNoteApiBaseUrl === noteRecoveryPrincipal.apiBaseUrl &&
    apiIdentityGenerationIsCurrent(noteRecoveryPrincipal.apiIdentityGeneration)
      ? sessionNoteRecoveryAuthority(
          noteRecoveryPrincipal.user,
          noteRecoveryPrincipal.tenant,
          noteRecoveryPrincipal.apiBaseUrl,
          noteRecoveryPrincipal.apiIdentityGeneration,
        )
      : null;
  const identityScope =
    routeIdentityScope && me?.effectiveRole && contextEpoch
      ? `${routeIdentityScope}:${me.effectiveRole}:${contextEpoch}`
      : null;
  const { available, fromApiError } = useCapabilityReporter(
    "helpdesk",
    "service-suite",
  );
  const [tab] = useDesktopRouteTab<Tab>(
    "helpdesk",
    TABS.map((item) => item.id),
    "inbox",
  );
  // Catalog drives enum-backed pickers (statuses, channels, guardrail
  // descriptor). A failure remains non-fatal, but it is never silent.
  const catalogResource = useRemoteResource<ServiceSuiteCatalog>(
    async () => {
      const res = await serviceSuiteApi.catalog();
      if ("error" in res && res.error) {
        fromApiError(res.error, {
          endpointAbsenceMeansNotConfigured: true,
        });
        return { error: res.error };
      }
      const decoded = decodeServiceSuiteCatalog(res.data as unknown);
      if (!decoded.value) {
        return {
          error: {
            kind: "parse" as const,
            message: decoded.error ?? "The catalog response was invalid.",
          },
        };
      }
      available();
      return { data: decoded.value };
    },
    { identity: "helpdesk-catalog" },
  );
  const catalog = catalogResource.data;
  const catalogHasPickerValues = Boolean(
    catalog &&
    ((catalog.conversation_statuses?.length ?? 0) > 0 ||
      (catalog.channels?.length ?? 0) > 0 ||
      (catalog.agent_run_types?.length ?? 0) > 0),
  );

  const setCanonicalTab = useCallback((next: Tab): void => {
    // A queue selection/filter belongs only to Inbox. Do not leak it into
    // the canonical Hub/Agent URLs when switching sections.
    if (next !== "inbox") {
      navigateDesktopRoute({ section: "helpdesk", tab: next });
    } else {
      navigateDesktopRoute({ section: "helpdesk" });
    }
  }, []);
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: TABS.map((item) => ({ value: item.id })),
    onChange: setCanonicalTab,
  });
  const routeStatusFilters =
    route.filters?.filter((filter) => filter.key === "status") ?? [];
  const syntacticallySafeStatus =
    routeStatusFilters.length === 1 &&
    isSafeHelpdeskStatusRouteValue(routeStatusFilters[0]?.value)
      ? routeStatusFilters[0].value
      : null;
  const activeStatus = tab === "inbox" ? syntacticallySafeStatus : null;
  const routeStatusAwaitingCatalog = Boolean(activeStatus && !catalog);
  const routeStatusRejectedByCatalog = Boolean(
    activeStatus &&
    catalog &&
    !(catalog.conversation_statuses ?? []).includes(activeStatus),
  );
  const routeHasMalformedConversationId =
    tab === "inbox" &&
    route.resourceId !== undefined &&
    !isCanonicalHelpdeskId(route.resourceId);
  const routeHasUnsafeState =
    route.section === "helpdesk" &&
    (route.query !== undefined ||
      route.sort !== undefined ||
      route.overlay !== undefined ||
      (route.tab !== undefined &&
        !TABS.some((item) => item.id === route.tab)) ||
      (route.filters?.some((filter) => filter.key !== "status") ?? false) ||
      routeStatusFilters.length > 1 ||
      (routeStatusFilters.length === 1 && syntacticallySafeStatus === null) ||
      (tab !== "inbox" &&
        (route.resourceId !== undefined || (route.filters?.length ?? 0) > 0)));
  const selectedConversationId =
    tab === "inbox" && isCanonicalHelpdeskId(route.resourceId)
      ? route.resourceId
      : null;
  const setInboxRoute = useCallback(
    (next: { selectedId?: string | null; status?: string | null }): void => {
      const current = getDesktopRoute();
      const currentStatus =
        current.section === "helpdesk"
          ? (current.filters?.find((filter) => filter.key === "status")
              ?.value ?? null)
          : null;
      const status = next.status === undefined ? currentStatus : next.status;
      const selectedId =
        next.selectedId === undefined
          ? current.section === "helpdesk"
            ? current.resourceId
            : undefined
          : next.selectedId || undefined;
      navigateDesktopRoute({
        section: "helpdesk",
        ...(selectedId ? { resourceId: selectedId } : {}),
        ...(status ? { filters: [{ key: "status", value: status }] } : {}),
      });
    },
    [],
  );
  const setSelectedConversation = useCallback(
    (selectedId: string | null) => setInboxRoute({ selectedId }),
    [setInboxRoute],
  );
  const setStatusFilter = useCallback(
    (status: string | null) => setInboxRoute({ status, selectedId: null }),
    [setInboxRoute],
  );
  const previousIdentityScopeRef = useRef<string | null>(identityScope);
  useEffect(() => {
    const previous = previousIdentityScopeRef.current;
    previousIdentityScopeRef.current = identityScope;
    const invalidResource = routeHasMalformedConversationId;
    const contextChanged = previous !== null && previous !== identityScope;
    if (
      invalidResource ||
      routeHasUnsafeState ||
      routeStatusRejectedByCatalog ||
      contextChanged ||
      (!canAdmin && route.resourceId)
    ) {
      navigateDesktopRoute(
        {
          section: "helpdesk",
          ...(tab === "inbox" ? {} : { tab }),
          ...(tab === "inbox" && activeStatus && !routeStatusRejectedByCatalog
            ? { filters: [{ key: "status", value: activeStatus }] }
            : {}),
        },
        { replace: true },
      );
    }
  }, [
    activeStatus,
    canAdmin,
    identityScope,
    route,
    routeHasMalformedConversationId,
    routeStatusRejectedByCatalog,
    routeHasUnsafeState,
    tab,
  ]);

  const protectedAccess =
    canAdmin &&
    roleStatus === "resolved" &&
    identityScope !== null &&
    !routeHasMalformedConversationId &&
    !routeHasUnsafeState &&
    !routeStatusAwaitingCatalog &&
    !routeStatusRejectedByCatalog;

  return (
    <div
      className="page helpdesk-page"
      data-helpdesk-access={canAdmin ? "admin" : "read-only"}
    >
      <header className="helpdesk-page-header">
        <div>
          <div className="helpdesk-eyebrow">Service suite foundation</div>
          <h1 className="page-title">Helpdesk</h1>
          <p className="helpdesk-page-intro">
            Triage tenant-scoped service records, configure release-held
            Customer Hub settings, and review source-held deterministic Agent
            guardrails. Customer delivery, Agent draft creation, and an
            authenticated storefront runtime are not available from this
            surface.
          </p>
        </div>
        <span className="spacer" />
        <div className="helpdesk-page-actions">
          <span
            className={`helpdesk-access-badge${canAdmin ? " is-admin" : ""}`}
          >
            {roleStatus !== "resolved"
              ? "Access unresolved"
              : canAdmin
                ? "Admin workspace"
                : "Catalog only"}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void catalogResource.reload()}
            disabled={catalogResource.transport === "loading"}
          >
            {catalogResource.transport === "loading"
              ? "Refreshing catalog…"
              : "Refresh catalog"}
          </button>
        </div>
      </header>

      <RemoteDataNotice
        resource={catalogResource}
        label="helpdesk catalog"
        onRetry={() => void catalogResource.reload()}
      />
      {isInitialRemoteLoad(catalogResource) ? (
        <div className="muted" role="status" style={{ marginBottom: 12 }}>
          Loading helpdesk catalog…
        </div>
      ) : catalog && !catalogHasPickerValues ? (
        <div
          className="notice"
          data-remote-state="verified-empty"
          style={{ marginBottom: 12 }}
        >
          <span>
            The helpdesk catalog is verified but has no configured picker
            values. No unverified picker values are substituted.
          </span>
        </div>
      ) : null}

      {!tenantId || roleStatus !== "resolved" || !contextEpoch ? (
        <div className="notice helpdesk-access-notice" role="status">
          Workspace identity, effective role, and server context epoch must
          resolve before protected Helpdesk records can load.
        </div>
      ) : !canAdmin ? (
        <div
          className="notice helpdesk-access-notice"
          data-remote-state="access-denied"
        >
          <strong>
            Protected Helpdesk records require exact admin access.
          </strong>
          <span>
            Your effective role can read the catalog only. Conversation, ticket,
            macro, Hub configuration, and Agent endpoints are not requested in
            this view.
          </span>
        </div>
      ) : null}

      {online === "offline" ? (
        <div className="notice helpdesk-access-notice" role="status">
          Helpdesk is offline. Verified records already loaded in this window
          may remain visible as stale, but reads and all writes are paused.
        </div>
      ) : null}

      <div
        ref={tabs.listRef}
        className="tabs helpdesk-tabs"
        {...tabs.listProps}
        aria-label="Helpdesk sections"
        style={{ marginBottom: 12 }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            {...tabs.getTabProps(t.id)}
            onClick={() => setCanonicalTab(t.id)}
            className={`tab${tab === t.id ? " is-active" : ""}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section
        key={identityScope ?? "helpdesk-context-unresolved"}
        {...tabs.getPanelProps(tab)}
        className="helpdesk-tab-panel"
      >
        {routeHasMalformedConversationId || routeHasUnsafeState ? (
          <div
            className="card helpdesk-locked-panel"
            data-helpdesk-state="invalid-route"
            role="status"
          >
            <div className="helpdesk-state-icon" aria-hidden="true">
              ⌁
            </div>
            <h2>Helpdesk route state rejected</h2>
            <p>
              The route included an invalid conversation identifier or
              non-Helpdesk search/filter state. It is being cleared before any
              protected request can start.
            </p>
          </div>
        ) : routeStatusAwaitingCatalog || routeStatusRejectedByCatalog ? (
          <div
            className="card helpdesk-locked-panel"
            data-helpdesk-state={
              routeStatusAwaitingCatalog
                ? "status-verification-pending"
                : "status-rejected"
            }
            role="status"
          >
            <div className="helpdesk-state-icon" aria-hidden="true">
              ⌁
            </div>
            <h2>
              {routeStatusAwaitingCatalog
                ? "Verifying queue filter"
                : "Queue filter rejected"}
            </h2>
            <p>
              {routeStatusAwaitingCatalog
                ? "The safe status intent remains in the URL while the static catalog is verified. Protected records stay unmounted during loading or transport failure."
                : "The verified catalog does not contain this status. The filter is being cleared before protected records can load."}
            </p>
          </div>
        ) : !protectedAccess ? (
          <div
            className="card helpdesk-locked-panel"
            data-helpdesk-state={
              roleStatus === "resolved" ? "access-denied" : "context-unresolved"
            }
          >
            <div className="helpdesk-state-icon" aria-hidden="true">
              ⌁
            </div>
            <h2>
              {roleStatus === "resolved"
                ? "Protected Helpdesk records are admin-only"
                : "Resolving protected context"}
            </h2>
            <p>
              {roleStatus === "resolved"
                ? "No conversation, requester, ticket, template, Hub configuration, or Agent record was requested."
                : "Protected panes stay unmounted until workspace identity, effective role, and server context epoch are all verified."}
            </p>
          </div>
        ) : tab === "inbox" ? (
          <HelpdeskInbox
            catalog={catalog}
            tenantId={tenantId}
            identityScope={identityScope}
            noteRecoveryAuthority={noteRecoveryAuthority}
            accessAllowed={protectedAccess}
            online={online !== "offline"}
            catalogVerified={catalog !== null}
            selectedConversationId={selectedConversationId}
            statusFilter={activeStatus}
            onSelectedConversationChange={setSelectedConversation}
            onStatusFilterChange={setStatusFilter}
          />
        ) : tab === "hub" ? (
          <CustomerHubConfig
            tenantId={tenantId}
            accessAllowed={protectedAccess}
            online={online !== "offline"}
          />
        ) : (
          <CustomerAgentPanel
            catalog={catalog}
            tenantId={tenantId}
            accessAllowed={protectedAccess}
            online={online !== "offline"}
          />
        )}
      </section>
    </div>
  );
}
