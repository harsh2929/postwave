/**
 * Commerce → Recovery & alerts tab (#33c).
 *
 * Three subscription surfaces against one selected integration:
 *   - Cart-recovery links (list + upsert)
 *   - Back-in-stock subscriptions (list + create — the create route is
 *     nested under /integrations/{id}/products/{product_id}/…)
 *   - Price-drop watchers (list + create, same nesting)
 *
 * Lists accept ?status=; creates are admin-gated.
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Named, bounded table regions must be keyboard-focusable so keyboard users can pan overflow locally. */

import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { ChoiceGroup } from "../ChoiceGroup";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import {
  type CommerceBackInStockSubscription,
  type CommerceCartRecoveryLink,
  type CommerceIntegration,
  type CommercePage,
  type CommercePriceDropWatcher,
  commerceApi,
} from "../../lib/api-client";
import {
  remoteFailureFromError,
  type RemoteApiError,
  type RemoteFailure,
  type RemoteTransport,
} from "../../lib/remote-resource";

import {
  fmtCents,
  fmtCommerceDate,
  recoveryStatusTone,
} from "./commerce-helpers";
import { Pager } from "./Pager";

const PER_PAGE = 25;
const RECOVERY_VIEWS = [
  {
    id: "carts",
    label: "Abandoned carts",
    description: "Resume-link records",
  },
  {
    id: "stock",
    label: "Back in stock",
    description: "Inventory demand",
  },
  {
    id: "price",
    label: "Price drops",
    description: "Price-watch demand",
  },
] as const;
type RecoveryView = (typeof RECOVERY_VIEWS)[number]["id"];

type RecoveryPageLoader<T> = (
  cursor: string | undefined,
) => Promise<{ data?: CommercePage<T>; error?: RemoteApiError }>;

interface RecoveryPageController<T> {
  data: CommercePage<T> | null;
  transport: RemoteTransport;
  failure: RemoteFailure | null;
  stale: boolean;
  retry: () => void;
  resetPage: () => void;
  firstPage: () => void;
  pageNumber: number;
  hasPrevious: boolean;
  nextCursor: string | null;
  previousPage: () => void;
  nextPage: (cursor: string) => void;
}

function useRecoveryPage<T>(
  identity: string,
  loader: RecoveryPageLoader<T>,
): RecoveryPageController<T> {
  const [cursorState, setCursorState] = useState<{
    identity: string;
    trail: string[];
  }>({ identity, trail: [] });
  const cursorTrail =
    cursorState.identity === identity ? cursorState.trail : [];
  const cursor = cursorTrail.at(-1);
  const pageNumber = cursorTrail.length + 1;
  const retryFlightRef = useRef<Promise<void> | null>(null);
  const resource = useRemoteResource<CommercePage<T>>(
    async () => {
      const result = await loader(cursor);
      if (result.error) return { error: result.error };
      if (!result.data || !Array.isArray(result.data.items)) {
        return {
          error: { message: "Invalid commerce page", kind: "parse" },
        };
      }
      return { data: result.data };
    },
    { identity: JSON.stringify([identity, cursor ?? null]) },
  );
  const retry = (): void => {
    if (retryFlightRef.current) return;
    const request = resource.reload();
    retryFlightRef.current = request;
    void request.finally(() => {
      if (retryFlightRef.current === request) retryFlightRef.current = null;
    });
  };
  const rawNextCursor = resource.data?.next_cursor;
  const nextCursor =
    typeof rawNextCursor === "string" &&
    rawNextCursor.length > 0 &&
    !cursorTrail.includes(rawNextCursor)
      ? rawNextCursor
      : null;
  return {
    data: resource.data,
    transport: resource.transport,
    failure: resource.failure,
    stale: resource.stale,
    retry,
    resetPage: () => setCursorState({ identity, trail: [] }),
    firstPage: () => {
      if (cursorTrail.length === 0) retry();
      else setCursorState({ identity, trail: [] });
    },
    pageNumber,
    hasPrevious: cursorTrail.length > 0,
    nextCursor,
    previousPage: () => {
      if (resource.transport === "loading" || cursorTrail.length === 0) return;
      setCursorState({
        identity,
        trail: cursorTrail.slice(0, -1),
      });
    },
    nextPage: (requestedCursor) => {
      if (resource.transport === "loading" || requestedCursor !== nextCursor) {
        return;
      }
      setCursorState({
        identity,
        trail: [...cursorTrail, requestedCursor],
      });
    },
  };
}

function safeRecoveryFailure(error: RemoteApiError): string {
  return remoteFailureFromError(error).message;
}

function RecoveryTime({ value }: { value?: string | null }): ReactElement {
  if (!value) return <span className="muted">Not recorded</span>;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return <span className="commerce-value">{value}</span>;
  }
  return (
    <time dateTime={parsed.toISOString()} className="commerce-time">
      <span>{fmtCommerceDate(value)}</span>
      <span className="commerce-detail">{parsed.toISOString()}</span>
    </time>
  );
}

function RecoveryLoadState({
  label,
  dataPresent,
  transport,
  failure,
  stale,
  onRetry,
}: {
  label: string;
  dataPresent: boolean;
  transport: RemoteTransport;
  failure: RemoteFailure | null;
  stale: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (transport === "loading") {
    return (
      <p className="muted" role="status" aria-live="polite">
        {dataPresent ? `Refreshing ${label}…` : `Loading ${label}…`}
      </p>
    );
  }
  if (!failure) return null;
  return (
    <div className="notice commerce-resource-notice" role="alert">
      <span>
        {failure.message}
        {stale ? ` Showing the last successfully loaded ${label}.` : ""}
        {failure.requestId ? ` Request ID: ${failure.requestId}.` : ""}
      </span>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Retry {label}
      </button>
    </div>
  );
}

function RecoveryRefreshAction({
  label,
  transport,
  onRefresh,
}: {
  label: string;
  transport: RemoteTransport;
  onRefresh: () => void;
}): ReactElement {
  const loading = transport === "loading";
  return (
    <button
      type="button"
      className="btn btn-sm"
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={() => {
        if (!loading) onRefresh();
      }}
    >
      {loading ? `Refreshing ${label}…` : `Refresh ${label}`}
    </button>
  );
}

function verifiedHttpsUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function maskedEmail(value?: string | null): string {
  if (!value) return "Email not recorded";
  const [local, domain, ...rest] = value.trim().split("@");
  if (!local || !domain || rest.length > 0) return "Email recorded · masked";
  const first = local.slice(0, 1);
  return `${first || "•"}•••@${domain}`;
}

export function RecoveryTab({
  integrations,
  integrationsErr,
  canAdmin,
}: {
  integrations: CommerceIntegration[] | null;
  integrationsErr: string | null;
  canAdmin: boolean;
}): ReactElement {
  const [integrationId, setIntegrationId] = useState<string>("");
  const [view, setView] = useState<RecoveryView>("carts");
  const rows: CommerceIntegration[] | null =
    integrations === null
      ? null
      : Array.isArray(integrations)
        ? integrations
        : [];

  useEffect(() => {
    if (!rows || rows.length === 0) return;
    if (!rows.some((integration) => integration.id === integrationId)) {
      setIntegrationId(rows[0]?.id ?? "");
    }
  }, [integrationId, rows]);
  const tabs = useTabsInteraction<RecoveryView>({
    activation: "manual",
    value: view,
    items: RECOVERY_VIEWS.map((item) => ({ value: item.id })),
    onChange: setView,
  });
  const selectedIntegration =
    rows?.find((integration) => integration.id === integrationId) ?? null;

  if (integrationsErr && (!rows || rows.length === 0)) {
    return (
      <div className="notice" role="alert">
        <span>
          Store integrations could not be verified. Check your connection and
          retry from Commerce.
        </span>
      </div>
    );
  }
  if (rows === null) {
    return (
      <p className="muted" role="status" aria-live="polite">
        Loading store integrations…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="list-empty">
        <div className="empty-state">
          <div className="empty-state-icon">·</div>
          <h3>Recovery &amp; alerts need a store integration</h3>
          <p>
            Cart-recovery links, back-in-stock subscriptions, and price-drop
            watchers all hang off an integration. Connect a store on the
            Integrations tab first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="commerce-surface">
      <div className="commerce-store-context">
        <div className="commerce-store-context-copy">
          <span className="commerce-context-kicker">Recovery workspace</span>
          <strong>
            {selectedIntegration?.shop_domain ||
              selectedIntegration?.provider ||
              "Choose a store"}
          </strong>
          <span>
            {selectedIntegration
              ? `${selectedIntegration.provider} · recorded state ${selectedIntegration.status || "unknown"}`
              : "Recovery records are always scoped to one connected store."}
          </span>
        </div>
        <FormField
          label="Store"
          help="Switching stores replaces the active recovery dataset; it never creates or updates a record."
        >
          <select
            id="recovery-integration"
            value={integrationId}
            onChange={(e) => setIntegrationId(e.target.value)}
            aria-label="Recovery store"
          >
            {rows.map((integration) => (
              <option key={integration.id} value={integration.id}>
                {integration.shop_domain || integration.provider} ·{" "}
                {integration.provider}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      {integrationsErr ? (
        <div className="notice" role="alert">
          <span>
            Store refresh failed. The last loaded store selection remains in
            view; retry from the Commerce workspace before relying on current
            connection state.
          </span>
        </div>
      ) : null}

      {!canAdmin ? (
        <p className="muted commerce-role-note" role="note">
          You have view-only access. An administrator can register recovery
          links and product alert subscriptions.
        </p>
      ) : null}

      <div
        ref={tabs.listRef}
        {...tabs.listProps}
        className="commerce-recovery-tabs"
        aria-label="Recovery datasets"
      >
        {RECOVERY_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            {...tabs.getTabProps(item.id)}
            className={`commerce-recovery-tab${view === item.id ? " is-active" : ""}`}
          >
            <strong>{item.label}</strong>
            <span>{item.description}</span>
          </button>
        ))}
      </div>

      {integrationId
        ? RECOVERY_VIEWS.map((item) => (
            <section
              key={item.id}
              {...tabs.getPanelProps(item.id)}
              className="commerce-recovery-panel"
            >
              {view !== item.id ? null : item.id === "carts" ? (
                <CartRecoverySection
                  key={`cart:${integrationId}`}
                  integrationId={integrationId}
                  canAdmin={canAdmin}
                />
              ) : item.id === "stock" ? (
                <BackInStockSection
                  key={`stock:${integrationId}`}
                  integrationId={integrationId}
                  canAdmin={canAdmin}
                />
              ) : (
                <PriceDropSection
                  key={`price:${integrationId}`}
                  integrationId={integrationId}
                  canAdmin={canAdmin}
                />
              )}
            </section>
          ))
        : null}
    </div>
  );
}

/* ---------- shared status filter chips ---------- */

function StatusFilter({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}): ReactElement {
  return (
    <ChoiceGroup
      legend={legend}
      value={value}
      options={["", ...options].map((status) => ({
        value: status,
        label: status || "All",
      }))}
      onChange={onChange}
      className="commerce-status-filter"
      optionClassName="commerce-status-filter-option"
    />
  );
}

/* ---------- cart recovery ---------- */

const CART_COLS = "1.25fr 1.45fr 92px 190px";

function CartRecoverySection({
  integrationId,
  canAdmin,
}: {
  integrationId: string;
  canAdmin: boolean;
}): ReactElement {
  const [status, setStatus] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const createReturnFocusRef = useRef<HTMLElement | null>(null);
  const source = useRecoveryPage<CommerceCartRecoveryLink>(
    `cart-recovery:${integrationId}:${status || "all"}`,
    (cursor) =>
      commerceApi.listCartRecoveryLinks(integrationId, {
        ...(status ? { status } : {}),
        cursor,
        limit: PER_PAGE,
      }),
  );
  const data = source.data;

  return (
    <section style={{ marginBottom: 24 }}>
      <SectionHeader
        title="Cart-recovery links"
        description="Per-cart resume URLs for abandoned-cart emails — automations insert them into recovery sends."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusFilter
              legend="Filter cart-recovery links by status"
              value={status}
              options={["active", "converted", "expired", "disabled"]}
              onChange={(nextStatus) => {
                source.resetPage();
                setStatus(nextStatus);
              }}
            />
            {canAdmin ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={(event) => {
                  createReturnFocusRef.current = event.currentTarget;
                  setCreateOpen(true);
                }}
              >
                + New link
              </button>
            ) : null}
          </div>
        }
      />
      <RecoveryLoadState
        label="cart-recovery links"
        dataPresent={data !== null}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      {data ? (
        <>
          <div className="commerce-subsection-toolbar">
            <p className="muted">
              {data.items.length.toLocaleString()} link
              {data.items.length === 1 ? "" : "s"} on this page
              {status ? ` with status ${status}` : " across all statuses"}
              {source.nextCursor ? "; more are available." : "."}
            </p>
            <RecoveryRefreshAction
              label="cart-recovery links"
              transport={source.transport}
              onRefresh={source.retry}
            />
          </div>
          <div
            className="list commerce-list commerce-cart-list"
            role="table"
            aria-label="Cart-recovery links"
            aria-rowcount={data.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: CART_COLS }}
              >
                <div role="columnheader">Customer and identifiers</div>
                <div role="columnheader">Recovery URL</div>
                <div role="columnheader">Status</div>
                <div role="columnheader">Lifecycle times</div>
              </div>
            </div>
            <div role="rowgroup">
              {data.items.length === 0 ? (
                <div className="list-empty" role="row">
                  <div className="empty-state" role="cell" aria-colspan={4}>
                    <div className="empty-state-icon" aria-hidden="true">
                      ·
                    </div>
                    <h3>
                      No cart-recovery links
                      {status ? ` with status “${status}”` : ""}
                    </h3>
                    <p>
                      Links are usually created by the store webhook when a cart
                      is abandoned
                      {canAdmin ? "; you can also register one manually" : ""}.
                    </p>
                  </div>
                </div>
              ) : (
                data.items.map((link) => (
                  <div
                    key={link.id}
                    className="list-row"
                    role="row"
                    style={{
                      gridTemplateColumns: CART_COLS,
                      cursor: "default",
                    }}
                  >
                    <div
                      role="cell"
                      className="mono commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>{maskedEmail(link.customer_email)}</span>
                      <span className="commerce-detail">
                        Link ID: {link.id} · Source cart ID:{" "}
                        {link.source_cart_id}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="mono muted commerce-value"
                      style={{ fontSize: 11 }}
                    >
                      <span>
                        {verifiedHttpsUrl(link.recovery_url)
                          ? new URL(link.recovery_url).origin
                          : "Unverified recovery URL"}
                      </span>
                      <span className="commerce-secret-mask">
                        Secure path and token hidden
                      </span>
                    </div>
                    <div role="cell">
                      <span
                        className={`badge${recoveryStatusTone(link.status) === "neutral" ? "" : ` ${recoveryStatusTone(link.status)}`}`}
                      >
                        {link.status || "Unknown"}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="muted tabular commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>Expires</span>
                      <RecoveryTime value={link.expires_at} />
                      <span className="commerce-detail">Created</span>
                      <RecoveryTime value={link.created_at} />
                      <span className="commerce-detail">Updated</span>
                      <RecoveryTime value={link.updated_at} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <Pager
            itemCount={data.items.length}
            pageNumber={source.pageNumber}
            hasPrevious={source.hasPrevious}
            nextCursor={source.nextCursor}
            busy={source.transport === "loading"}
            onPrevious={source.previousPage}
            onNext={source.nextPage}
            label="Cart-recovery links"
          />
        </>
      ) : null}

      {createOpen ? (
        <CartLinkCreateModal
          integrationId={integrationId}
          returnFocusRef={createReturnFocusRef}
          onClose={() => setCreateOpen(false)}
          onCreated={source.firstPage}
        />
      ) : null}
    </section>
  );
}

function CartLinkCreateModal({
  integrationId,
  returnFocusRef,
  onClose,
  onCreated,
}: {
  integrationId: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreated: () => void;
}): ReactElement {
  const [cartId, setCartId] = useState("");
  const [email, setEmail] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const completedRef = useRef(false);
  const dirty = Boolean(cartId || email || url);

  const save = async (): Promise<boolean> => {
    if (!cartId.trim()) {
      setErr("Source cart ID is required.");
      setErrorField("cart");
      return false;
    }
    const recoveryUrl = verifiedHttpsUrl(url);
    if (!recoveryUrl) {
      setErr(
        "Enter a valid HTTPS recovery URL without embedded username or password credentials.",
      );
      setErrorField("url");
      return false;
    }
    setErr(null);
    setErrorField(null);
    const res = await commerceApi.upsertCartRecoveryLink(integrationId, {
      source_cart_id: cartId.trim(),
      recovery_url: recoveryUrl,
      ...(email.trim() ? { customer_email: email.trim() } : {}),
    });
    if (res.error) {
      setErr(safeRecoveryFailure(res.error));
      return false;
    }
    toast.success("Cart-recovery link saved");
    return true;
  };
  const lifecycle = useDraftLifecycleController({
    ownerId: `cart-recovery-create-${integrationId}`,
    label: "Cart-recovery link draft",
    mode: "create",
    enabled: true,
    dirty,
    save,
    discard: () => {
      setCartId("");
      setEmail("");
      setUrl("");
      setErr(null);
      setErrorField(null);
    },
    close: onClose,
    detail: "This cart-recovery link has not been saved.",
    onError: () => {
      setErr("The cart-recovery link could not be saved. Retry when ready.");
      setErrorField(null);
    },
  });
  const submit = async (): Promise<void> => {
    if (!(await lifecycle.submit()) || completedRef.current) return;
    completedRef.current = true;
    onCreated();
    onClose();
  };

  return (
    <>
      <Modal
        open
        onClose={lifecycle.requestClose}
        returnFocusRef={returnFocusRef}
        closeOnBackdrop={!lifecycle.active}
        closeOnEscape={!lifecycle.active}
        closeDisabled={lifecycle.active}
        title="New cart-recovery link"
        description="Upserts on the cart id — re-registering the same cart updates the link."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {err && errorField === null ? (
            <div className="notice" role="alert">
              <span>{err}</span>
            </div>
          ) : null}
          <FormField
            label="Source cart ID"
            required
            error={errorField === "cart" ? err : null}
          >
            <input
              type="text"
              value={cartId}
              onChange={(e) => {
                setCartId(e.target.value);
                if (errorField === "cart") {
                  setErr(null);
                  setErrorField(null);
                }
              }}
              placeholder="cart_123"
              maxLength={256}
              disabled={lifecycle.active}
              autoCapitalize="none"
              spellCheck={false}
            />
          </FormField>
          <FormField
            label="Recovery URL"
            required
            error={errorField === "url" ? err : null}
            help="HTTPS only. Query parameters may contain recovery tokens, so the list keeps the full value behind an explicit disclosure."
          >
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (errorField === "url") {
                  setErr(null);
                  setErrorField(null);
                }
              }}
              placeholder="https://store.example.com/cart/restore?token=…"
              maxLength={4096}
              disabled={lifecycle.active}
              autoCapitalize="none"
              spellCheck={false}
            />
          </FormField>
          <FormField label="Customer email (optional)">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
              maxLength={320}
              disabled={lifecycle.active}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
            />
          </FormField>
          <p
            className="muted commerce-operation-status"
            role="status"
            aria-live="polite"
          >
            {lifecycle.active
              ? "Saving the link. Fields and dismissal stay locked until the request finishes."
              : "Nothing is saved until you choose Save link."}
          </p>
          <ModalFooter>
            <button
              type="button"
              className="btn"
              aria-disabled={lifecycle.active || undefined}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              aria-disabled={lifecycle.active || undefined}
              aria-busy={lifecycle.active || undefined}
            >
              {lifecycle.active ? "Saving…" : "Save link"}
            </button>
          </ModalFooter>
        </form>
      </Modal>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard cart-recovery link draft?"
        description="The source cart ID, recovery URL, and optional customer email will be cleared."
        confirmLabel="Discard draft"
        cancelLabel="Keep editing"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </>
  );
}

/* ---------- back in stock ---------- */

const BIS_COLS = "1.4fr 1.4fr 110px 150px 150px";

function BackInStockSection({
  integrationId,
  canAdmin,
}: {
  integrationId: string;
  canAdmin: boolean;
}): ReactElement {
  const [status, setStatus] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const source = useRecoveryPage<CommerceBackInStockSubscription>(
    `back-in-stock:${integrationId}:${status || "all"}`,
    (cursor) =>
      commerceApi.listBackInStockSubscriptions(integrationId, {
        ...(status ? { status } : {}),
        cursor,
        limit: PER_PAGE,
      }),
  );
  const data = source.data;

  return (
    <section style={{ marginBottom: 24 }}>
      <SectionHeader
        title="Back-in-stock subscriptions"
        description="Subscribers waiting on a product to restock. The lifecycle evaluator flips them to eligible when inventory returns."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusFilter
              legend="Filter back-in-stock subscriptions by status"
              value={status}
              options={[
                "waiting",
                "eligible",
                "notified",
                "expired",
                "cancelled",
              ]}
              onChange={(nextStatus) => {
                source.resetPage();
                setStatus(nextStatus);
              }}
            />
            {canAdmin ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setCreateOpen(true)}
              >
                + New subscription
              </button>
            ) : null}
          </div>
        }
      />
      <RecoveryLoadState
        label="back-in-stock subscriptions"
        dataPresent={data !== null}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      {data ? (
        <>
          <div className="commerce-subsection-toolbar">
            <p className="muted">
              {data.items.length.toLocaleString()} subscription
              {data.items.length === 1 ? "" : "s"} on this page
              {status ? ` with status ${status}` : " across all statuses"}
              {source.nextCursor ? "; more are available." : "."}
            </p>
            <RecoveryRefreshAction
              label="back-in-stock subscriptions"
              transport={source.transport}
              onRefresh={source.retry}
            />
          </div>
          <div
            className="list commerce-list commerce-stock-list"
            role="table"
            aria-label="Back-in-stock subscriptions"
            aria-rowcount={data.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: BIS_COLS }}
              >
                <div role="columnheader">Subscriber and subscription ID</div>
                <div role="columnheader">Product and variant IDs</div>
                <div role="columnheader">Status</div>
                <div role="columnheader">Requested and eligible</div>
                <div role="columnheader">Notified and expiry</div>
              </div>
            </div>
            <div role="rowgroup">
              {data.items.length === 0 ? (
                <div className="list-empty" role="row">
                  <div className="empty-state" role="cell" aria-colspan={5}>
                    <div className="empty-state-icon" aria-hidden="true">
                      ·
                    </div>
                    <h3>
                      No back-in-stock subscriptions
                      {status ? ` with status “${status}”` : ""}
                    </h3>
                    <p>
                      These usually come from a storefront “notify me” form
                      {canAdmin
                        ? "; you can also create one against a product ID"
                        : ""}
                      .
                    </p>
                  </div>
                </div>
              ) : (
                data.items.map((subscription) => (
                  <div
                    key={subscription.id}
                    className="list-row"
                    role="row"
                    style={{ gridTemplateColumns: BIS_COLS, cursor: "default" }}
                  >
                    <div
                      role="cell"
                      className="mono commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>{maskedEmail(subscription.subscriber_email)}</span>
                      <span className="commerce-detail">
                        Subscription ID: {subscription.id} · Subscriber ID:{" "}
                        {subscription.subscriber_id || "not recorded"}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="mono muted commerce-value"
                      style={{ fontSize: 11 }}
                    >
                      <span>Product ID: {subscription.product_id}</span>
                      <span className="commerce-detail">
                        Variant ID: {subscription.variant_id || "product level"}
                      </span>
                    </div>
                    <div role="cell">
                      <span
                        className={`badge${recoveryStatusTone(subscription.status) === "neutral" ? "" : ` ${recoveryStatusTone(subscription.status)}`}`}
                      >
                        {subscription.status || "Unknown"}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="muted tabular commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>Requested</span>
                      <RecoveryTime value={subscription.requested_at} />
                      <span className="commerce-detail">
                        Eligible{" "}
                        <RecoveryTime value={subscription.eligible_at} />
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="muted tabular commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>Notified</span>
                      <RecoveryTime value={subscription.notified_at} />
                      <span className="commerce-detail">
                        Expires <RecoveryTime value={subscription.expires_at} />
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <Pager
            itemCount={data.items.length}
            pageNumber={source.pageNumber}
            hasPrevious={source.hasPrevious}
            nextCursor={source.nextCursor}
            busy={source.transport === "loading"}
            onPrevious={source.previousPage}
            onNext={source.nextPage}
            label="Back-in-stock subscriptions"
          />
        </>
      ) : null}

      {createOpen ? (
        <ProductSubscriptionModal
          kind="back-in-stock"
          integrationId={integrationId}
          onClose={() => setCreateOpen(false)}
          onCreated={source.firstPage}
        />
      ) : null}
    </section>
  );
}

/* ---------- price drop ---------- */

const PD_COLS = "1.4fr 1.4fr 130px 110px 150px";

function PriceDropSection({
  integrationId,
  canAdmin,
}: {
  integrationId: string;
  canAdmin: boolean;
}): ReactElement {
  const [status, setStatus] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const source = useRecoveryPage<CommercePriceDropWatcher>(
    `price-drop:${integrationId}:${status || "all"}`,
    (cursor) =>
      commerceApi.listPriceDropWatchers(integrationId, {
        ...(status ? { status } : {}),
        cursor,
        limit: PER_PAGE,
      }),
  );
  const data = source.data;

  return (
    <section style={{ marginBottom: 24 }}>
      <SectionHeader
        title="Price-drop watchers"
        description="Subscribers watching a product's price. The evaluator marks them eligible when the price falls below their target (or by the minimum drop %)."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusFilter
              legend="Filter price-drop watchers by status"
              value={status}
              options={[
                "watching",
                "eligible",
                "notified",
                "expired",
                "cancelled",
              ]}
              onChange={(nextStatus) => {
                source.resetPage();
                setStatus(nextStatus);
              }}
            />
            {canAdmin ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setCreateOpen(true)}
              >
                + New watcher
              </button>
            ) : null}
          </div>
        }
      />
      <RecoveryLoadState
        label="price-drop watchers"
        dataPresent={data !== null}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      {data ? (
        <>
          <div className="commerce-subsection-toolbar">
            <p className="muted">
              {data.items.length.toLocaleString()} watcher
              {data.items.length === 1 ? "" : "s"} on this page
              {status ? ` with status ${status}` : " across all statuses"}
              {source.nextCursor ? "; more are available." : "."}
            </p>
            <RecoveryRefreshAction
              label="price-drop watchers"
              transport={source.transport}
              onRefresh={source.retry}
            />
          </div>
          <div
            className="list commerce-list commerce-price-drop-list"
            role="table"
            aria-label="Price-drop watchers"
            aria-rowcount={data.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: PD_COLS }}
              >
                <div role="columnheader">Subscriber and watcher ID</div>
                <div role="columnheader">Product and variant IDs</div>
                <div role="columnheader">Price rule</div>
                <div role="columnheader">Status</div>
                <div role="columnheader">Lifecycle times</div>
              </div>
            </div>
            <div role="rowgroup">
              {data.items.length === 0 ? (
                <div className="list-empty" role="row">
                  <div className="empty-state" role="cell" aria-colspan={5}>
                    <div className="empty-state-icon" aria-hidden="true">
                      ·
                    </div>
                    <h3>
                      No price-drop watchers
                      {status ? ` with status “${status}”` : ""}
                    </h3>
                    <p>
                      Watchers track a product&apos;s price history snapshot
                      {canAdmin
                        ? "; create one against a product ID to try it"
                        : ""}
                      .
                    </p>
                  </div>
                </div>
              ) : (
                data.items.map((watcher) => (
                  <div
                    key={watcher.id}
                    className="list-row"
                    role="row"
                    style={{ gridTemplateColumns: PD_COLS, cursor: "default" }}
                  >
                    <div
                      role="cell"
                      className="mono commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>{maskedEmail(watcher.subscriber_email)}</span>
                      <span className="commerce-detail">
                        Watcher ID: {watcher.id} · Subscriber ID:{" "}
                        {watcher.subscriber_id || "not recorded"}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="mono muted commerce-value"
                      style={{ fontSize: 11 }}
                    >
                      <span>Product ID: {watcher.product_id}</span>
                      <span className="commerce-detail">
                        Variant ID: {watcher.variant_id || "product level"}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="tabular commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>
                        Original:{" "}
                        {fmtCents(
                          watcher.original_price_cents,
                          watcher.currency,
                        )}
                      </span>
                      <span className="commerce-detail">
                        {watcher.target_price_cents != null
                          ? `Target: ${fmtCents(watcher.target_price_cents, watcher.currency)}`
                          : watcher.min_drop_percent != null
                            ? `Minimum drop: ${watcher.min_drop_percent}%`
                            : "No stored price rule"}
                      </span>
                    </div>
                    <div role="cell">
                      <span
                        className={`badge${recoveryStatusTone(watcher.status) === "neutral" ? "" : ` ${recoveryStatusTone(watcher.status)}`}`}
                      >
                        {watcher.status || "Unknown"}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="muted tabular commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>Watching since</span>
                      <RecoveryTime value={watcher.watched_at} />
                      <span className="commerce-detail">
                        Eligible <RecoveryTime value={watcher.eligible_at} /> ·
                        Notified <RecoveryTime value={watcher.notified_at} /> ·
                        Expires <RecoveryTime value={watcher.expires_at} />
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <Pager
            itemCount={data.items.length}
            pageNumber={source.pageNumber}
            hasPrevious={source.hasPrevious}
            nextCursor={source.nextCursor}
            busy={source.transport === "loading"}
            onPrevious={source.previousPage}
            onNext={source.nextPage}
            label="Price-drop watchers"
          />
        </>
      ) : null}

      {createOpen ? (
        <ProductSubscriptionModal
          kind="price-drop"
          integrationId={integrationId}
          onClose={() => setCreateOpen(false)}
          onCreated={source.firstPage}
        />
      ) : null}
    </section>
  );
}

/* ---------- shared create modal (BIS + price drop) ---------- */

function PriceRuleFields({
  targetPrice,
  currency,
  error,
  errorField,
  disabled,
  onTargetPriceChange,
  onCurrencyChange,
}: {
  targetPrice: string;
  currency: string;
  error: string | null;
  errorField: string | null;
  disabled: boolean;
  onTargetPriceChange: (value: string) => void;
  onCurrencyChange: (value: string) => void;
}): ReactElement {
  return (
    <div className="commerce-form-grid">
      <FormField
        label="Target price"
        required
        help={`Enter the customer-facing amount in ${currency}, not integer cents.`}
        error={errorField === "target" ? error : null}
      >
        <input
          type="number"
          min={0.01}
          step={0.01}
          inputMode="decimal"
          value={targetPrice}
          onChange={(event) => onTargetPriceChange(event.target.value)}
          placeholder="39.00"
          disabled={disabled}
          required
        />
      </FormField>
      <FormField
        label="Currency"
        required
        help="Three-letter ISO currency code for the target amount."
        error={errorField === "currency" ? error : null}
      >
        <input
          type="text"
          value={currency}
          onChange={(event) => onCurrencyChange(event.target.value)}
          placeholder="USD"
          minLength={3}
          maxLength={3}
          disabled={disabled}
          required
          autoCapitalize="characters"
          spellCheck={false}
        />
      </FormField>
    </div>
  );
}

function ProductSubscriptionModal({
  kind,
  integrationId,
  onClose,
  onCreated,
}: {
  kind: "back-in-stock" | "price-drop";
  integrationId: string;
  onClose: () => void;
  onCreated: () => void;
}): ReactElement {
  const [productId, setProductId] = useState("");
  const [email, setEmail] = useState("");
  const [variantId, setVariantId] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [err, setErr] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const completedRef = useRef(false);
  const dirty = Boolean(
    productId || email || variantId || targetPrice || currency !== "USD",
  );

  const save = async (): Promise<boolean> => {
    if (!productId.trim()) {
      setErr(
        "Product ID is required. Find the full ID in the Integrations product browser.",
      );
      setErrorField("product");
      return false;
    }
    const subscriberEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+$/u.test(subscriberEmail)) {
      setErr("Enter a valid subscriber email address.");
      setErrorField("email");
      return false;
    }
    let targetCents: number | undefined;
    if (kind === "price-drop") {
      const normalizedTarget = targetPrice.trim();
      if (!/^\d+(?:\.\d{1,2})?$/u.test(normalizedTarget)) {
        setErr(
          "Enter a positive target price with no more than two decimal places.",
        );
        setErrorField("target");
        return false;
      }
      const n = Math.round(Number(normalizedTarget) * 100);
      if (!Number.isSafeInteger(n) || n <= 0) {
        setErr("Target price must be greater than zero.");
        setErrorField("target");
        return false;
      }
      if (!/^[A-Z]{3}$/u.test(currency)) {
        setErr("Currency must be a three-letter ISO code.");
        setErrorField("currency");
        return false;
      }
      targetCents = n;
    }
    setErr(null);
    setErrorField(null);
    const base = {
      subscriber_email: subscriberEmail,
      ...(variantId.trim() ? { variant_id: variantId.trim() } : {}),
    };
    const res =
      kind === "back-in-stock"
        ? await commerceApi.createBackInStockSubscription(
            integrationId,
            productId.trim(),
            base,
          )
        : await commerceApi.createPriceDropWatcher(
            integrationId,
            productId.trim(),
            {
              ...base,
              ...(targetCents != null
                ? {
                    target_price_cents: targetCents,
                    currency,
                  }
                : {}),
            },
          );
    if (res.error) {
      setErr(safeRecoveryFailure(res.error));
      return false;
    }
    toast.success(
      kind === "back-in-stock"
        ? "Back-in-stock subscription created"
        : "Price-drop watcher created",
    );
    return true;
  };
  const label =
    kind === "back-in-stock"
      ? "Back-in-stock subscription"
      : "Price-drop watcher";
  const lifecycle = useDraftLifecycleController({
    ownerId: `${kind}-subscription-create-${integrationId}`,
    label: `${label} draft`,
    mode: "create",
    enabled: true,
    dirty,
    save,
    discard: () => {
      setProductId("");
      setEmail("");
      setVariantId("");
      setTargetPrice("");
      setCurrency("USD");
      setErr(null);
      setErrorField(null);
    },
    close: onClose,
    detail: `This ${label.toLowerCase()} has not been created.`,
    onError: () => {
      setErr(
        `The ${label.toLowerCase()} could not be created. Retry when ready.`,
      );
      setErrorField(null);
    },
  });
  const submit = async (): Promise<void> => {
    if (!(await lifecycle.submit()) || completedRef.current) return;
    completedRef.current = true;
    onCreated();
    onClose();
  };

  return (
    <>
      <Modal
        open
        onClose={lifecycle.requestClose}
        closeOnBackdrop={!lifecycle.active}
        closeOnEscape={!lifecycle.active}
        closeDisabled={lifecycle.active}
        title={
          kind === "back-in-stock"
            ? "New back-in-stock subscription"
            : "New price-drop watcher"
        }
        description="Created against a synced product. Use the Integrations product browser to copy complete product and variant IDs."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {err && errorField === null ? (
            <div className="notice" role="alert">
              <span>{err}</span>
            </div>
          ) : null}
          <FormField
            label="Product ID"
            required
            error={errorField === "product" ? err : null}
          >
            <input
              type="text"
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                if (errorField === "product") {
                  setErr(null);
                  setErrorField(null);
                }
              }}
              placeholder="prd_…"
              maxLength={256}
              disabled={lifecycle.active}
              required
              autoCapitalize="none"
              spellCheck={false}
            />
          </FormField>
          <div className="commerce-form-grid">
            <FormField
              label="Subscriber email"
              required
              error={errorField === "email" ? err : null}
            >
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errorField === "email") {
                    setErr(null);
                    setErrorField(null);
                  }
                }}
                placeholder="customer@example.com"
                maxLength={320}
                disabled={lifecycle.active}
                required
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
              />
            </FormField>
            <FormField label="Variant ID (optional)">
              <input
                type="text"
                value={variantId}
                onChange={(e) => setVariantId(e.target.value)}
                placeholder="var_…"
                maxLength={256}
                disabled={lifecycle.active}
                autoCapitalize="none"
                spellCheck={false}
              />
            </FormField>
          </div>
          {kind === "price-drop" ? (
            <PriceRuleFields
              targetPrice={targetPrice}
              currency={currency}
              error={err}
              errorField={errorField}
              disabled={lifecycle.active}
              onTargetPriceChange={(value) => {
                setTargetPrice(value);
                if (errorField === "target") {
                  setErr(null);
                  setErrorField(null);
                }
              }}
              onCurrencyChange={(value) => {
                setCurrency(value.toUpperCase().slice(0, 3));
                if (errorField === "currency") {
                  setErr(null);
                  setErrorField(null);
                }
              }}
            />
          ) : null}
          <p
            className="muted commerce-operation-status"
            role="status"
            aria-live="polite"
          >
            {lifecycle.active
              ? `Creating the ${label.toLowerCase()}. Fields and dismissal stay locked until the request finishes.`
              : `Nothing is created until you choose Create ${kind === "back-in-stock" ? "subscription" : "watcher"}.`}
          </p>
          <ModalFooter>
            <button
              type="button"
              className="btn"
              aria-disabled={lifecycle.active || undefined}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              aria-disabled={lifecycle.active || undefined}
              aria-busy={lifecycle.active || undefined}
            >
              {lifecycle.active
                ? "Creating…"
                : `Create ${kind === "back-in-stock" ? "subscription" : "watcher"}`}
            </button>
          </ModalFooter>
        </form>
      </Modal>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title={`Discard ${label.toLowerCase()} draft?`}
        description="The product, subscriber, variant, and price-rule fields will be cleared."
        confirmLabel="Discard draft"
        cancelLabel="Keep editing"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </>
  );
}
