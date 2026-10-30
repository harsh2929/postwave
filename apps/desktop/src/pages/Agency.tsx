/** Read-only agency administration backed only by release-authoritative reads. */

import {
  type ButtonHTMLAttributes,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { AgencyStatStrip } from "../components/agency/AgencyStatStrip";
import {
  formatInstant,
  formatInteger,
  isNotAgencyError,
  parseAgencyBranding,
  parseAgencyChildren,
} from "../components/agency/agency-maturity";
import { BrandingPreviewCard } from "../components/agency/BrandingPreviewCard";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { RemoteDataNotice } from "../components/RemoteDataNotice";
import { useRemoteResource } from "../hooks/useRemoteResource";
import {
  type SingleFlightOperation,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  type AgencyBranding,
  type AgencyChild,
  type AgencyChildrenResponse,
  api,
  getApiUrl,
} from "../lib/api-client";
import { useCapabilityReporter } from "../lib/capability-observations";
import { canonicalApiBaseUrl } from "../lib/config";
import {
  navigateDesktopRoute,
  useDesktopRouteTab,
} from "../lib/desktop-router";
import { HERO } from "../lib/heroAssets";
import {
  hasVerifiedRemoteData,
  remoteFailureFromError,
  type RemoteApiError,
  type RemoteFailure,
} from "../lib/remote-resource";
import { loadMe, type Me, useMe, useRoleStatus } from "../lib/store";
import type { RemoteResourceController } from "../hooks/useRemoteResource";

import "../components/agency/agency.css";

type Tab = "children" | "branding" | "invoice";

const AGENCY_TABS = [
  { value: "children" },
  { value: "branding" },
  { value: "invoice" },
] as const;
const ROSTER_LIMIT = 200;
const PLAN_REQUIRED_COPY =
  "The audit-portal branding record remains available to workspace admins. Child-workspace roster access requires agency eligibility; lifecycle, billing, invoice, and branding mutations remain release-held.";
const RELEASE_HOLD_COPY =
  "Sub-account creation, unlinking, billing-owner changes, branding changes, and invoice projections are release-held. These controls send no request.";

/**
 * Agency reads are an administrator privacy boundary. The workspace subtree is
 * absent until every authority dimension is known and is synchronously
 * replaced whenever origin, credential, principal, tenant, or role changes.
 */
export function Agency(): ReactElement {
  const me = useMe();
  const roleStatus = useRoleStatus();
  const authorityKey = me ? agencyAuthorityKey(me) : null;

  if (
    roleStatus !== "resolved" ||
    !me ||
    me.effectiveRole !== "admin" ||
    !authorityKey
  ) {
    return (
      <AgencyAccessState
        me={me}
        roleStatus={roleStatus}
        authorityMissing={
          roleStatus === "resolved" &&
          me?.effectiveRole === "admin" &&
          !authorityKey
        }
      />
    );
  }

  return <AgencyWorkspace key={authorityKey} tenantId={me.tenant.trim()} />;
}

const API_KEY_FINGERPRINT_PATTERN =
  /^(?:[a-f0-9]{64}|api-credential:sha256:[a-f0-9]{64})$/u;
const RECOVERY_SCOPE_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_AGENCY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function agencyAuthorityKey(me: Me): string | null {
  const apiOrigin = canonicalApiBaseUrl(getApiUrl());
  const user = me.user.trim();
  const tenant = me.tenant.trim();
  if (
    !apiOrigin ||
    !CANONICAL_AGENCY_UUID_PATTERN.test(tenant) ||
    !me.credentialSource
  ) {
    return null;
  }

  let credentialIdentity: string;
  if (me.credentialSource === "api-key") {
    if (!user) return null;
    const fingerprint = me.credentialFingerprint?.trim() ?? "";
    const recoveryScope = me.webhookPlaygroundRecoveryScope?.trim() ?? "";
    if (API_KEY_FINGERPRINT_PATTERN.test(fingerprint)) {
      credentialIdentity = `fingerprint:${fingerprint}`;
    } else if (RECOVERY_SCOPE_PATTERN.test(recoveryScope)) {
      credentialIdentity = `reviewed-recovery:${recoveryScope}`;
    } else {
      return null;
    }
  } else if (
    me.credentialSource === "session" &&
    CANONICAL_AGENCY_UUID_PATTERN.test(user)
  ) {
    credentialIdentity = "session";
  } else {
    return null;
  }

  return JSON.stringify([
    1,
    apiOrigin,
    me.credentialSource,
    credentialIdentity,
    user,
    tenant,
    me.effectiveRole,
  ]);
}

function AgencyAccessState({
  me,
  roleStatus,
  authorityMissing,
}: {
  me: Me | null;
  roleStatus: ReturnType<typeof useRoleStatus>;
  authorityMissing: boolean;
}): ReactElement {
  const loading = roleStatus === "loading";
  const denied = roleStatus === "resolved" && me?.effectiveRole !== "admin";
  return (
    <main
      className="page page-with-pad agency-page"
      aria-labelledby="agency-title"
      aria-busy={loading || undefined}
    >
      <header className="agency-page__header">
        <div>
          <h1 id="agency-title">Agency</h1>
          <p>Review bounded client-workspace and branding records.</p>
        </div>
      </header>
      <div className="callout warning agency-access-state" role="status">
        <strong>
          {loading
            ? "Verifying agency access"
            : denied
              ? "Workspace admin access required"
              : authorityMissing
                ? "Credential identity could not be verified"
                : "Agency access could not be verified"}
        </strong>
        <p>
          {loading
            ? "No agency data is requested or displayed until the current workspace and effective role are verified."
            : denied
              ? "Child workspaces and branding are admin-only. No agency request was made, and viewer mode retains no administrator data."
              : authorityMissing
                ? "The exact API origin, principal, tenant, and credential identity are required before administrator data can be requested. No agency request was made."
                : "The current workspace and role could not be resolved, so no agency request was made."}
        </p>
        {!loading && (!denied || authorityMissing) ? (
          <button type="button" className="btn" onClick={() => void loadMe()}>
            Retry access check
          </button>
        ) : null}
      </div>
    </main>
  );
}

function useAuthorityAbortController(): MutableRefObject<AbortController> {
  const controllerRef = useRef<AbortController | null>(null);
  if (!controllerRef.current) controllerRef.current = new AbortController();
  useEffect(() => {
    if (controllerRef.current?.signal.aborted) {
      controllerRef.current = new AbortController();
    }
    return () => controllerRef.current?.abort();
  }, []);
  return controllerRef as MutableRefObject<AbortController>;
}

function AgencyWorkspace({ tenantId }: { tenantId: string }): ReactElement {
  const { available, fromApiError, partialPlanRequired } =
    useCapabilityReporter("agency", "subaccounts");
  const abortController = useAuthorityAbortController();
  const [tab, setTab] = useDesktopRouteTab<Tab>(
    "agency",
    ["children", "branding", "invoice"],
    "children",
  );
  const [visited, setVisited] = useState<Record<Tab, boolean>>(() => ({
    children: tab === "children",
    branding: tab === "branding",
    invoice: tab === "invoice",
  }));
  const mountedRef = useRef(true);
  const readSequenceRef = useRef(0);
  const rosterOperation = useSingleFlightOperation();
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: AGENCY_TABS,
    onChange: setTab,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setVisited((current) =>
      current[tab] ? current : { ...current, [tab]: true },
    );
  }, [tab]);

  const childrenResource = useRemoteResource<AgencyChildrenResponse>(
    async () => {
      const sequence = ++readSequenceRef.current;
      let result: Awaited<ReturnType<typeof api.agencyListChildren>>;
      try {
        result = await api.agencyListChildren({
          limit: ROSTER_LIMIT,
          signal: abortController.current.signal,
        });
      } catch {
        result = {
          error: { message: "Request failed", kind: "network" as const },
        };
      }
      if (result.error) {
        if (mountedRef.current && sequence === readSequenceRef.current) {
          if (isNotAgencyError(result.error)) {
            partialPlanRequired(PLAN_REQUIRED_COPY);
          } else {
            fromApiError(result.error, { impact: "partial" });
          }
        }
        return { error: result.error };
      }
      const parsed = parseAgencyChildren(result.data);
      if (
        !parsed ||
        parsed.children.some(
          (child) =>
            child.parent_tenant_id !== tenantId || child.id === tenantId,
        )
      ) {
        const error: RemoteApiError = {
          message: "Invalid response",
          kind: "parse",
          code: "invalid_agency_children_response",
        };
        if (mountedRef.current && sequence === readSequenceRef.current) {
          fromApiError(error, { impact: "partial" });
        }
        return { error };
      }
      if (mountedRef.current && sequence === readSequenceRef.current) {
        available();
      }
      return { data: parsed };
    },
    { identity: JSON.stringify(["agency-children", tenantId]) },
  );
  const roster = useAgencyRosterContinuation({
    resource: childrenResource,
    tenantId,
    abortController,
    operation: rosterOperation,
    onAvailable: available,
    onError: (error) => fromApiError(error, { impact: "partial" }),
  });

  const refreshRoster = useCallback(async (): Promise<void> => {
    if (rosterOperation.promiseRef.current) {
      await rosterOperation.wait();
      return;
    }
    const request = rosterOperation.run(() => childrenResource.reload());
    if (request) await request;
  }, [childrenResource, rosterOperation]);

  const refreshUnavailable =
    rosterOperation.active || childrenResource.transport === "loading";
  const pageStatusId = useId();

  return (
    <main
      className="page page-with-pad agency-page"
      aria-labelledby="agency-title"
    >
      <header className="agency-page__header">
        <div>
          <h1 id="agency-title">Agency</h1>
          <p>
            Inspect the bounded client-workspace roster and stored audit-portal
            branding record. No held write or invoice request leaves this app.
          </p>
        </div>
        <button
          type="button"
          className="btn pw-discoverable-unavailable"
          aria-disabled={refreshUnavailable || undefined}
          aria-describedby={pageStatusId}
          aria-busy={rosterOperation.active || undefined}
          onClick={() => {
            if (!refreshUnavailable) void refreshRoster();
          }}
        >
          {rosterOperation.active ? "Refreshing…" : "Refresh roster"}
        </button>
      </header>

      <p id={pageStatusId} className="pw-action-status" role="status">
        {rosterOperation.active
          ? "A roster read is in progress. Previously verified rows remain visible unless authority is revoked."
          : childrenResource.lastVerifiedAt
            ? `Roster first page verified ${formatInstant(childrenResource.lastVerifiedAt)}.`
            : "The first roster page is being verified before any workspace is displayed."}
      </p>

      {childrenResource.data && roster.children.length > 0 ? (
        <AgencyStatStrip children={roster.children} hasMore={roster.hasMore} />
      ) : null}

      <div
        ref={tabs.listRef}
        className="tabs agency-tabs"
        {...tabs.listProps}
        aria-label="Agency sections"
      >
        <TabButton
          active={tab === "children"}
          {...tabs.getTabProps("children")}
        >
          Sub-accounts
        </TabButton>
        <TabButton
          active={tab === "branding"}
          {...tabs.getTabProps("branding")}
        >
          Branding
        </TabButton>
        <TabButton active={tab === "invoice"} {...tabs.getTabProps("invoice")}>
          Usage &amp; invoices
        </TabButton>
      </div>

      <section {...tabs.getPanelProps("children")}>
        {visited.children ? (
          <ChildrenTab
            resource={childrenResource}
            roster={roster}
            onReload={refreshRoster}
          />
        ) : null}
      </section>
      <section {...tabs.getPanelProps("branding")}>
        {visited.branding ? (
          <BrandingTab tenantId={tenantId} abortController={abortController} />
        ) : null}
      </section>
      <section {...tabs.getPanelProps("invoice")}>
        {visited.invoice ? <InvoiceHoldTab /> : null}
      </section>
    </main>
  );
}

interface RosterTail {
  firstPage: AgencyChildrenResponse;
  children: AgencyChild[];
  nextCursor: string | null;
  seenCursors: ReadonlySet<string>;
  lastVerifiedAt: number;
}

interface AgencyRosterContinuation {
  children: AgencyChild[];
  hasMore: boolean;
  loading: boolean;
  failure: RemoteFailure | null;
  lastVerifiedAt: number | null;
  loadMore: () => Promise<void>;
}

function useAgencyRosterContinuation({
  resource,
  tenantId,
  abortController,
  operation,
  onAvailable,
  onError,
}: {
  resource: RemoteResourceController<AgencyChildrenResponse>;
  tenantId: string;
  abortController: MutableRefObject<AbortController>;
  operation: SingleFlightOperation;
  onAvailable: () => void;
  onError: (error: RemoteApiError) => void;
}): AgencyRosterContinuation {
  const [tail, setTail] = useState<RosterTail | null>(null);
  const [failure, setFailure] = useState<RemoteFailure | null>(null);
  const mountedRef = useRef(true);
  const sequenceRef = useRef(0);
  const activeTail =
    resource.data && tail?.firstPage === resource.data ? tail : null;
  const baseChildren = resource.data?.children ?? [];
  const children = useMemo(
    () => [...baseChildren, ...(activeTail?.children ?? [])],
    [activeTail, baseChildren],
  );
  const nextCursor = activeTail
    ? activeTail.nextCursor
    : resource.data?.has_more
      ? (resource.data.next_cursor ?? null)
      : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      sequenceRef.current += 1;
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setFailure(null);
  }, [resource.data]);

  const loadMore = useCallback(async (): Promise<void> => {
    const firstPage = resource.data;
    if (!firstPage || !nextCursor) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const sequence = ++sequenceRef.current;
    const currentTail = tail?.firstPage === firstPage ? tail : null;
    const usedCursors = new Set(currentTail?.seenCursors ?? []);
    usedCursors.add(nextCursor);
    const request = operation.run(async () => {
      let result: Awaited<ReturnType<typeof api.agencyListChildren>>;
      try {
        result = await api.agencyListChildren({
          limit: ROSTER_LIMIT,
          cursor: nextCursor,
          signal: abortController.current.signal,
        });
      } catch {
        result = {
          error: { message: "Request failed", kind: "network" as const },
        };
      }
      if (!mountedRef.current || sequence !== sequenceRef.current) return;
      if (result.error) {
        setFailure(remoteFailureFromError(result.error));
        onError(result.error);
        return;
      }
      const parsed = parseAgencyChildren(result.data);
      const existing = [
        ...firstPage.children,
        ...(currentTail?.children ?? []),
      ];
      const existingById = new Map(existing.map((child) => [child.id, child]));
      const existingSlugOwner = new Map(
        existing.map((child) => [child.slug, child.id]),
      );
      const additions: AgencyChild[] = [];
      let overlapConflict = false;
      if (parsed) {
        for (const child of parsed.children) {
          const known = existingById.get(child.id);
          const slugOwner = existingSlugOwner.get(child.slug);
          if (child.parent_tenant_id !== tenantId || child.id === tenantId) {
            overlapConflict = true;
            break;
          }
          if (known) {
            if (!sameAgencyChild(known, child)) overlapConflict = true;
            continue;
          }
          if (slugOwner && slugOwner !== child.id) {
            overlapConflict = true;
            break;
          }
          additions.push(child);
          existingById.set(child.id, child);
          existingSlugOwner.set(child.slug, child.id);
        }
      }
      const invalid =
        !parsed ||
        overlapConflict ||
        (parsed.has_more &&
          (!parsed.next_cursor || usedCursors.has(parsed.next_cursor)));
      if (invalid || !parsed) {
        const error: RemoteApiError = {
          message: "Invalid response",
          kind: "parse",
          code: "invalid_agency_roster_continuation",
        };
        setFailure(remoteFailureFromError(error));
        onError(error);
        return;
      }
      setTail({
        firstPage,
        children: [...(currentTail?.children ?? []), ...additions],
        nextCursor: parsed.has_more ? (parsed.next_cursor ?? null) : null,
        seenCursors: usedCursors,
        lastVerifiedAt: Date.now(),
      });
      setFailure(null);
      onAvailable();
    });
    if (request) await request;
  }, [
    abortController,
    nextCursor,
    onAvailable,
    onError,
    operation,
    resource.data,
    tail,
    tenantId,
  ]);

  return {
    children,
    hasMore: nextCursor !== null,
    loading: operation.active,
    failure,
    lastVerifiedAt:
      activeTail?.lastVerifiedAt ?? resource.lastVerifiedAt ?? null,
    loadMore,
  };
}

function sameAgencyChild(left: AgencyChild, right: AgencyChild): boolean {
  return (
    left.id === right.id &&
    left.slug === right.slug &&
    left.name === right.name &&
    left.tier === right.tier &&
    left.parent_tenant_id === right.parent_tenant_id &&
    left.billing_mode === right.billing_mode &&
    left.reseller_markup_bps === right.reseller_markup_bps &&
    left.whitelabel_enabled === right.whitelabel_enabled &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at
  );
}

function TabButton({
  active,
  children,
  ...props
}: {
  active: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement {
  return (
    <button
      {...props}
      type="button"
      className={active ? "tab-button active" : "tab-button"}
    >
      {children}
    </button>
  );
}

function ChildrenTab({
  resource,
  roster,
  onReload,
}: {
  resource: RemoteResourceController<AgencyChildrenResponse>;
  roster: AgencyRosterContinuation;
  onReload: () => Promise<void>;
}): ReactElement {
  const holdId = useId();
  const continuationStatusId = useId();
  const notAgency = isNotAgencyError(resource.failure);
  if (notAgency && !resource.data) return <AgencyPlanState />;

  return (
    <div className="agency-section" aria-busy={roster.loading || undefined}>
      <header className="agency-section__toolbar">
        <div>
          <h2>Client workspaces</h2>
          <p>
            Review verified relationships and stored configuration. Counts are
            explicitly limited to the pages loaded in this session.
          </p>
        </div>
        <HeldButton describedBy={holdId}>New sub-account</HeldButton>
      </header>
      <p id={holdId} className="pw-action-status" role="status">
        {RELEASE_HOLD_COPY}
      </p>

      {!notAgency ? (
        <RemoteDataNotice
          resource={resource}
          label="sub-accounts"
          onRetry={() => void onReload()}
        />
      ) : null}
      {!resource.data && resource.transport === "loading" ? (
        <p className="pw-action-status" role="status">
          Verifying the first roster page. An empty portfolio is shown only
          after the server confirms it.
        </p>
      ) : null}

      {resource.data && roster.children.length === 0 ? (
        <HeroEmptyState
          tone="neutral"
          eyebrow="Verified empty portfolio"
          title="No client workspaces are linked."
          subtitle="Child provisioning remains release-held. No workspace is inferred from an empty response."
          imageSrc={HERO.agency}
          imageAlt="Four notebooks fanned out with teal bookmarks"
        />
      ) : roster.children.length > 0 ? (
        <div className="agency-table-wrap">
          <table className="data-table agency-table">
            <caption>
              Loaded, verified sub-accounts. Lifecycle and billing actions are
              release-held and request-free.
            </caption>
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Plan</th>
                <th scope="col">Billing owner</th>
                <th scope="col">Markup</th>
                <th scope="col">Branding</th>
                <th scope="col">Verified record</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {roster.children.map((child) => (
                <ChildRow key={child.id} child={child} holdId={holdId} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {roster.failure ? (
        <div className="notice" role="alert" data-remote-state="stale-error">
          <span>
            <strong>Showing the loaded roster window.</strong>{" "}
            {roster.failure.message}
            {roster.failure.code ? (
              <span className="muted">
                {" "}
                Reference: {roster.failure.code}
                {roster.failure.requestId
                  ? ` · ${roster.failure.requestId}`
                  : ""}
                .
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      {resource.data ? (
        <div className="agency-pagination">
          <p
            id={continuationStatusId}
            className="pw-action-status"
            role="status"
          >
            {roster.loading
              ? "Loading the next bounded roster page. Existing rows remain visible."
              : roster.hasMore
                ? `${formatInteger(roster.children.length)} verified rows loaded; another page is available.`
                : `All ${formatInteger(roster.children.length)} verified rows are loaded.`}
            {roster.lastVerifiedAt
              ? ` Last page verified ${formatInstant(roster.lastVerifiedAt)}.`
              : ""}
          </p>
          {roster.hasMore ? (
            <button
              type="button"
              className="btn"
              aria-describedby={continuationStatusId}
              aria-disabled={roster.loading || undefined}
              aria-busy={roster.loading || undefined}
              onClick={() => {
                if (!roster.loading) void roster.loadMore();
              }}
            >
              {roster.loading
                ? "Loading…"
                : roster.failure
                  ? "Retry next page"
                  : "Load next page"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChildRow({
  child,
  holdId,
}: {
  child: AgencyChild;
  holdId: string;
}): ReactElement {
  return (
    <tr>
      <th scope="row" data-label="Workspace">
        <strong>{child.name}</strong>
        <span>{child.slug}</span>
        <span className="agency-table__id">
          <span>Tenant ID </span>
          <code>{child.id}</code>
        </span>
      </th>
      <td data-label="Plan">
        <strong>{child.tier}</strong>
      </td>
      <td data-label="Billing owner">
        <strong>
          {child.billing_mode === "parent" ? "This agency" : "Child workspace"}
        </strong>
      </td>
      <td data-label="Markup" className="tabular">
        <strong>{(child.reseller_markup_bps / 100).toFixed(2)}%</strong>
        <span>{formatInteger(child.reseller_markup_bps)} bps</span>
      </td>
      <td data-label="Branding">
        <strong>{child.whitelabel_enabled ? "Enabled" : "Disabled"}</strong>
      </td>
      <td data-label="Verified record">
        <span>
          Created{" "}
          <time dateTime={child.created_at}>
            {formatInstant(child.created_at)}
          </time>
        </span>
        <span>
          Updated{" "}
          <time dateTime={child.updated_at}>
            {formatInstant(child.updated_at)}
          </time>
        </span>
        <span className="agency-table__exact-time">{child.updated_at}</span>
      </td>
      <td data-label="Actions">
        <div className="agency-row-actions">
          <HeldButton describedBy={holdId} compact>
            Change billing
          </HeldButton>
          <HeldButton describedBy={holdId} compact danger>
            Unlink
          </HeldButton>
        </div>
      </td>
    </tr>
  );
}

function HeldButton({
  children,
  describedBy,
  compact = false,
  danger = false,
}: {
  children: ReactNode;
  describedBy: string;
  compact?: boolean;
  danger?: boolean;
}): ReactElement {
  const className = [
    "btn",
    compact ? "btn-sm" : "",
    danger ? "btn-danger" : "",
    "pw-discoverable-unavailable",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={className}
      aria-disabled="true"
      aria-describedby={describedBy}
      data-agency-held-control
    >
      {children}
    </button>
  );
}

function BrandingTab({
  tenantId,
  abortController,
}: {
  tenantId: string;
  abortController: MutableRefObject<AbortController>;
}): ReactElement {
  const resource = useRemoteResource<AgencyBranding>(
    async () => {
      const result = await api.agencyGetBranding({
        expectedTenantId: tenantId,
        signal: abortController.current.signal,
      });
      if (result.error) return { error: result.error };
      const parsed = parseAgencyBranding(result.data);
      if (!parsed) {
        return {
          error: {
            message: "Invalid response",
            kind: "parse" as const,
            code: "invalid_agency_branding_response",
          },
        };
      }
      return { data: parsed };
    },
    { identity: JSON.stringify(["agency-branding", tenantId]) },
  );
  const operation = useSingleFlightOperation();
  const statusId = useId();
  const holdId = useId();
  const refresh = useCallback(async (): Promise<void> => {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const request = operation.run(() => resource.reload());
    if (request) await request;
  }, [operation, resource]);
  const unavailable = operation.active || resource.transport === "loading";

  return (
    <div className="agency-section">
      <header className="agency-section__toolbar">
        <div>
          <h2>Audit portal branding record</h2>
          <p>
            Read the stored identity projection and its matching strong ETag.
            This does not publish a custom hostname or public portal.
          </p>
        </div>
        <div className="agency-toolbar-actions">
          <button
            type="button"
            className="btn pw-discoverable-unavailable"
            aria-disabled={unavailable || undefined}
            aria-describedby={statusId}
            aria-busy={operation.active || undefined}
            onClick={() => {
              if (!unavailable) void refresh();
            }}
          >
            {operation.active ? "Refreshing…" : "Refresh branding"}
          </button>
          <HeldButton describedBy={holdId}>Change branding</HeldButton>
        </div>
      </header>
      <p id={statusId} className="pw-action-status" role="status">
        {operation.active
          ? "Refreshing the stored branding record. The last verified record remains visible."
          : resource.lastVerifiedAt
            ? `Branding record verified ${formatInstant(resource.lastVerifiedAt)}.`
            : "The branding record is being verified."}
      </p>
      <p id={holdId} className="pw-action-status" role="status">
        Branding changes are release-held until every audit-portal consumer
        honors the enable boundary. The control sends no request.
      </p>
      <RemoteDataNotice
        resource={resource}
        label="agency branding"
        onRetry={() => void refresh()}
      />

      <BrandingScopeGuide />

      {hasVerifiedRemoteData(resource) ? (
        <div className="agency-branding-layout">
          <BrandingFacts branding={resource.data} />
          <div className="agency-branding-preview-rail">
            <BrandingPreviewCard branding={resource.data} />
          </div>
        </div>
      ) : resource.transport === "loading" ? (
        <p className="pw-action-status" role="status">
          Verifying branding. No empty configuration is inferred while the read
          is pending.
        </p>
      ) : null}
    </div>
  );
}

function BrandingFacts({
  branding,
}: {
  branding: AgencyBranding;
}): ReactElement {
  return (
    <dl className="agency-branding-form agency-branding-facts">
      <BrandingFact label="Branding preference">
        {branding.whitelabel_enabled ? "Enabled" : "Disabled"}
      </BrandingFact>
      <BrandingFact label="Brand name">
        {branding.brand_name || "Not configured"}
      </BrandingFact>
      <BrandingFact label="Reserved custom hostname">
        {branding.custom_domain
          ? `${branding.custom_domain} · stored legacy value, not published`
          : "Not configured"}
      </BrandingFact>
      <BrandingFact label="Logo URL">
        {branding.logo_url || "Not configured"}
      </BrandingFact>
      <BrandingFact label="Primary color">
        {branding.primary_color || "Not configured"}
      </BrandingFact>
      <BrandingFact label="Support email">
        {branding.support_email || "Not configured"}
      </BrandingFact>
      <BrandingFact label="Reserved legal entity">
        {branding.legal_entity
          ? `${branding.legal_entity} · preserved compatibility value; no current reader consumes it`
          : "Not configured · no current reader consumes this field"}
      </BrandingFact>
      <BrandingFact label="Revision baseline time">
        <span className="agency-branding-fact-stack">
          <time dateTime={branding.updated_at}>
            {formatInstant(branding.updated_at)}
          </time>
          <code>{branding.updated_at}</code>
          <small>
            Legacy records may use the migration initialization time; this is
            not asserted as the last human edit.
          </small>
        </span>
      </BrandingFact>
      <BrandingFact label="Strong ETag">
        <code>{branding.etag}</code>
      </BrandingFact>
    </dl>
  );
}

function BrandingScopeGuide(): ReactElement {
  return (
    <section
      className="agency-branding-scope"
      aria-labelledby="agency-branding-scope-title"
    >
      <div>
        <h3 id="agency-branding-scope-title">One record, one narrow scope</h3>
        <p>
          These values belong only to the audit-portal branding projection,
          whose evidence experience remains release-held. They do not theme
          email, signup, preference-center, workspace-shell, or archive pages.
        </p>
      </div>
      <nav
        className="agency-branding-scope__links"
        aria-label="Canonical branding owners"
      >
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            navigateDesktopRoute({
              section: "settings",
              settingsAnchor: "workspace-profile",
            })
          }
        >
          Workspace brand
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => navigateDesktopRoute({ section: "privacyPortal" })}
        >
          Preference center
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => navigateDesktopRoute({ section: "archive" })}
        >
          Public archive
        </button>
      </nav>
    </section>
  );
}

function BrandingFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function InvoiceHoldTab(): ReactElement {
  const holdId = useId();
  return (
    <div className="agency-section">
      <header className="agency-section__toolbar">
        <div>
          <h2>Usage and invoices</h2>
          <p>
            Consolidated invoice projections have no fixed rated ledger,
            temporal cutoff, tax authority, or payer authority in this release.
          </p>
        </div>
        <HeldButton describedBy={holdId}>Refresh invoice projection</HeldButton>
      </header>
      <div className="callout warning agency-release-hold" role="note">
        <strong>Invoice projection is release-held.</strong>
        <p id={holdId}>
          No usage amount, cost, invoice line, or zero value is inferred, and
          this tab sends no invoice-preview request. Rating, temporal cutoffs,
          active payer authority, tax, credits, and payment status are not yet
          one authoritative workflow.
        </p>
      </div>
      <div className="agency-hold-grid">
        <article>
          <span className="agency-hold-grid__index">01</span>
          <h3>Usage projection</h3>
          <p>No cross-tenant event aggregate is exposed as billable truth.</p>
          <HeldButton describedBy={holdId} compact>
            Preview usage
          </HeldButton>
        </article>
        <article>
          <span className="agency-hold-grid__index">02</span>
          <h3>Billing owner</h3>
          <p>Stored parent/self mode is not proof of an active payer.</p>
          <HeldButton describedBy={holdId} compact>
            Change billing owner
          </HeldButton>
        </article>
        <article>
          <span className="agency-hold-grid__index">03</span>
          <h3>Invoice document</h3>
          <p>
            No invoice number, tax treatment, credits, due date, or status
            exists.
          </p>
          <HeldButton describedBy={holdId} compact>
            Export invoice
          </HeldButton>
        </article>
      </div>
    </div>
  );
}

function AgencyPlanState(): ReactElement {
  return (
    <HeroEmptyState
      tone="neutral"
      eyebrow="Agency eligibility"
      title="Manage multiple client workspaces from one account."
      subtitle="The service verified that this workspace is not agency-enabled. The admin-only branding record remains available; contact support to discuss agency eligibility."
      imageSrc={HERO.agency}
      imageAlt="Four notebooks fanned out with teal bookmarks"
    />
  );
}
