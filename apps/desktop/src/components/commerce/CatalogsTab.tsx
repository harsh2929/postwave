/**
 * Commerce → Catalogs tab (#33b).
 *
 * Product catalogs (cursor-paged list + connected-store create), bounded
 * synchronous JSON product import, and per-catalog draft product feeds:
 * list / create / resolve. The resolver preview presents returned selection
 * evidence without claiming it is a campaign render or delivery preview.
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Named, bounded table regions must be keyboard-focusable so keyboard users can pan overflow locally. */

import { prefersReducedMotionNow } from "../../hooks/usePrefersReducedMotion";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import {
  type CommerceCatalog,
  type CommerceIntegration,
  type CommercePage,
  type CommerceProductFeed,
  type CommerceResolvedFeed,
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
  importSummaryMessage,
  parseProductsJson,
} from "./commerce-helpers";
import { Pager } from "./Pager";

const CATALOG_COLS = "1.6fr 1fr 110px 170px 200px";
const FEED_COLS = "1.6fr 1fr 110px 110px 140px";
const PER_PAGE = 25;
const MAX_IMPORT_TEXT_LENGTH = 900_000;
const MAX_IMPORT_BODY_BYTES = 1_000_000;
const MAX_IMPORT_PRODUCTS = 1_000;

type CatalogPageLoader<T> = (
  cursor: string | undefined,
) => Promise<{ data?: CommercePage<T>; error?: RemoteApiError }>;

interface CatalogPageController<T> {
  data: CommercePage<T> | null;
  transport: RemoteTransport;
  failure: RemoteFailure | null;
  stale: boolean;
  retry: () => void;
  firstPage: () => void;
  pageNumber: number;
  hasPrevious: boolean;
  nextCursor: string | null;
  previousPage: () => void;
  nextPage: (cursor: string) => void;
}

function useCatalogPage<T>(
  identity: string,
  loader: CatalogPageLoader<T>,
): CatalogPageController<T> {
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

function safeCatalogFailure(error: RemoteApiError): string {
  if (error.status === 404) {
    return "Commerce catalogs are not enabled on this Moosewave server.";
  }
  return remoteFailureFromError(error).message;
}

function CatalogTime({ value }: { value?: string | null }): ReactElement {
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

function CatalogLoadState({
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

function CatalogRefreshAction({
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

function formatCatalogRecord(value: Record<string, unknown>): string {
  const count = Object.keys(value).length;
  return count > 0
    ? `${count.toLocaleString()} configured field${count === 1 ? "" : "s"}`
    : "none";
}

function safeHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export function CatalogsTab({
  canAdmin,
  integrations,
}: {
  canAdmin: boolean;
  integrations?: CommerceIntegration[] | null;
}): ReactElement {
  const feedsPanelId = useId();
  const catalogCreateReturnFocusRef = useRef<HTMLElement | null>(null);
  const catalogImportReturnFocusRef = useRef<HTMLElement | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<CommerceCatalog | null>(
    null,
  );
  const [feedsFor, setFeedsFor] = useState<CommerceCatalog | null>(null);
  const source = useCatalogPage<CommerceCatalog>(
    "commerce-catalogs",
    (cursor) => commerceApi.listCatalogs({ cursor, limit: PER_PAGE }),
  );
  const data = source.data;
  const closeFeedsPanel = (): void => {
    const opener = Array.from(
      document.querySelectorAll<HTMLElement>("[aria-controls]"),
    ).find(
      (candidate) =>
        candidate.getAttribute("aria-controls") === feedsPanelId &&
        candidate.getAttribute("aria-expanded") === "true",
    );
    setFeedsFor(null);
    window.setTimeout(() => opener?.focus(), 0);
  };

  return (
    <div className="commerce-surface">
      <SectionHeader
        title="Catalogs & product feeds"
        description="Build store-owned product collections, import bounded product batches, and inspect resolver output without implying a campaign was rendered or sent."
        actions={
          canAdmin ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={(event) => {
                catalogCreateReturnFocusRef.current = event.currentTarget;
                setCreateOpen(true);
              }}
            >
              + New catalog
            </button>
          ) : undefined
        }
      />

      {!canAdmin ? (
        <p className="muted commerce-role-note" role="note">
          You have view-only access. An administrator can create catalogs,
          import products, and create feeds.
        </p>
      ) : null}
      <CatalogLoadState
        label="catalogs"
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
              {data.items.length.toLocaleString()} catalog
              {data.items.length === 1 ? "" : "s"} on this page
              {source.nextCursor ? "; more are available." : "."}
            </p>
            <CatalogRefreshAction
              label="catalogs"
              transport={source.transport}
              onRefresh={source.retry}
            />
          </div>
          <div
            className="list commerce-list commerce-catalogs-list"
            role="table"
            aria-label="Product catalogs"
            aria-rowcount={data.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: CATALOG_COLS }}
              >
                <div role="columnheader">Catalog and status</div>
                <div role="columnheader">Source</div>
                <div role="columnheader">Currency</div>
                <div role="columnheader">Lifecycle times</div>
                <div role="columnheader">Actions</div>
              </div>
            </div>
            <div role="rowgroup">
              {data.items.length === 0 ? (
                <div className="list-empty" role="row">
                  <div className="empty-state" role="cell" aria-colspan={5}>
                    <div className="empty-state-icon" aria-hidden="true">
                      ·
                    </div>
                    <h3>No catalogs yet</h3>
                    <p>
                      {canAdmin
                        ? "Create a catalog, then import products as JSON or point it at an integration. Feeds and campaign product blocks resolve from here."
                        : "An administrator can create the first product catalog."}
                    </p>
                  </div>
                </div>
              ) : (
                data.items.map((catalog) => (
                  <div
                    key={catalog.id}
                    className="list-row"
                    role="row"
                    style={{
                      gridTemplateColumns: CATALOG_COLS,
                      cursor: "default",
                    }}
                  >
                    <div
                      role="cell"
                      className="commerce-value"
                      style={{ fontWeight: 500 }}
                    >
                      <span>{catalog.name}</span>
                      <span className="commerce-detail mono">
                        Catalog ID: {catalog.id} · Status:{" "}
                        {catalog.status || "unknown"}
                      </span>
                      {catalog.error_message ? (
                        <span className="commerce-inline-error" role="status">
                          The catalog source reported a sync error. Review its
                          source configuration before the next import or sync.
                        </span>
                      ) : null}
                    </div>
                    <div
                      role="cell"
                      className="muted commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>{catalog.source_type || "Unknown source"}</span>
                      <span className="commerce-detail mono">
                        Integration ID: {catalog.integration_id || "not linked"}
                      </span>
                      {catalog.feed_url ? (
                        <>
                          <span className="commerce-detail">
                            Feed origin:{" "}
                            {safeHttpsOrigin(catalog.feed_url) ||
                              "unverified source"}
                          </span>
                          <span className="commerce-secret-mask">
                            Feed path and query hidden
                          </span>
                        </>
                      ) : null}
                    </div>
                    <div
                      role="cell"
                      className="muted tabular commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>{catalog.default_currency || "Not recorded"}</span>
                      <span className="commerce-detail">
                        Locale: {catalog.locale || "not recorded"}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="muted tabular commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>Last sync</span>
                      <CatalogTime value={catalog.last_sync_at} />
                      <span className="commerce-detail">
                        Created <CatalogTime value={catalog.created_at} /> ·
                        Updated <CatalogTime value={catalog.updated_at} />
                      </span>
                    </div>
                    <div role="cell" className="commerce-row-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        aria-expanded={feedsFor?.id === catalog.id}
                        aria-controls={feedsPanelId}
                        aria-label={`${feedsFor?.id === catalog.id ? "Hide" : "Show"} product feeds for ${catalog.name}`}
                        onClick={() => {
                          if (feedsFor?.id === catalog.id) closeFeedsPanel();
                          else setFeedsFor(catalog);
                        }}
                      >
                        {feedsFor?.id === catalog.id ? "Hide feeds" : "Feeds"}
                      </button>
                      {canAdmin ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`Import products into ${catalog.name}`}
                          onClick={(event) => {
                            catalogImportReturnFocusRef.current =
                              event.currentTarget;
                            setImportTarget(catalog);
                          }}
                        >
                          Import products
                        </button>
                      ) : null}
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
            label="Catalogs"
          />
        </>
      ) : null}

      {feedsFor ? (
        <FeedsPanel
          key={feedsFor.id}
          id={feedsPanelId}
          catalog={feedsFor}
          canAdmin={canAdmin}
          onClose={closeFeedsPanel}
        />
      ) : null}

      {createOpen ? (
        <CatalogCreateModal
          integrations={integrations}
          returnFocusRef={catalogCreateReturnFocusRef}
          onClose={() => setCreateOpen(false)}
          onCreated={source.firstPage}
        />
      ) : null}

      {importTarget ? (
        <ImportProductsModal
          catalog={importTarget}
          returnFocusRef={catalogImportReturnFocusRef}
          onClose={() => setImportTarget(null)}
          onImported={source.retry}
        />
      ) : null}
    </div>
  );
}

/* ---------- create catalog ---------- */

function CatalogCreateModal({
  integrations,
  returnFocusRef,
  onClose,
  onCreated,
}: {
  integrations?: CommerceIntegration[] | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreated: () => void;
}): ReactElement {
  const defaultIntegrationId = integrations?.[0]?.id ?? "";
  const [name, setName] = useState("");
  const [integrationId, setIntegrationId] = useState(defaultIntegrationId);
  const [currency, setCurrency] = useState("USD");
  const [err, setErr] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const completedRef = useRef(false);
  const dirty = Boolean(
    name || integrationId !== defaultIntegrationId || currency !== "USD",
  );

  const save = async (): Promise<boolean> => {
    if (!name.trim()) {
      setErr("Catalog name is required.");
      setErrorField("name");
      return false;
    }
    const normalizedCurrency = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(normalizedCurrency)) {
      setErr("Default currency must be a three-letter ISO 4217 code.");
      setErrorField("currency");
      return false;
    }
    if (!integrationId.trim()) {
      setErr("Choose a connected store for this catalog.");
      setErrorField("integration");
      return false;
    }
    setErr(null);
    setErrorField(null);
    const res = await commerceApi.createCatalog({
      name: name.trim(),
      source_type: "integration",
      integration_id: integrationId.trim(),
      default_currency: normalizedCurrency,
    });
    if (res.error) {
      setErr(safeCatalogFailure(res.error));
      return false;
    }
    toast.success(`Catalog "${name.trim()}" created`);
    return true;
  };
  const lifecycle = useDraftLifecycleController({
    ownerId: "commerce-catalog-create",
    label: "Product catalog draft",
    mode: "create",
    enabled: true,
    dirty,
    save,
    discard: () => {
      setName("");
      setIntegrationId(defaultIntegrationId);
      setCurrency("USD");
      setErr(null);
      setErrorField(null);
    },
    close: onClose,
    detail: "This product catalog has not been created.",
    onError: () => {
      setErr("The product catalog could not be created. Retry when ready.");
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
        returnFocusRef={returnFocusRef}
        title="New catalog"
        description="Create an import-ready catalog owned by one connected store. Manual and remote-feed catalog sources stay unavailable until their ingestion lifecycles are implemented."
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
            label="Name"
            required
            error={errorField === "name" ? err : null}
          >
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errorField === "name") {
                  setErr(null);
                  setErrorField(null);
                }
              }}
              placeholder="e.g. Spring collection"
              maxLength={160}
              disabled={lifecycle.active}
            />
          </FormField>
          <div className="commerce-form-grid">
            <FormField
              label="Source"
              help="Connected store is the only create path with a complete import contract on this server."
            >
              <select value="integration" disabled>
                <option value="integration">Connected store</option>
              </select>
            </FormField>
            <FormField
              label="Default currency"
              required
              help="Three-letter ISO 4217 code, such as USD, EUR, or INR."
              error={errorField === "currency" ? err : null}
            >
              <input
                type="text"
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value.toUpperCase());
                  if (errorField === "currency") {
                    setErr(null);
                    setErrorField(null);
                  }
                }}
                placeholder="USD"
                minLength={3}
                maxLength={3}
                disabled={lifecycle.active}
                autoCapitalize="characters"
                spellCheck={false}
              />
            </FormField>
          </div>
          <FormField
            label="Connected store"
            required
            help="The catalog keeps this exact store as its product-import owner."
            error={errorField === "integration" ? err : null}
          >
            {integrations !== undefined ? (
              <select
                value={integrationId}
                onChange={(event) => {
                  setIntegrationId(event.target.value);
                  if (errorField === "integration") {
                    setErr(null);
                    setErrorField(null);
                  }
                }}
                disabled={lifecycle.active || integrations === null}
              >
                {integrations === null ? (
                  <option value="">Loading connected stores…</option>
                ) : integrations.length === 0 ? (
                  <option value="">No connected store is available</option>
                ) : (
                  integrations.map((integration) => (
                    <option key={integration.id} value={integration.id}>
                      {integration.shop_domain || integration.provider} ·{" "}
                      {integration.provider}
                    </option>
                  ))
                )}
              </select>
            ) : (
              <input
                type="text"
                value={integrationId}
                onChange={(e) => {
                  setIntegrationId(e.target.value);
                  if (errorField === "integration") {
                    setErr(null);
                    setErrorField(null);
                  }
                }}
                placeholder="Integration ID"
                maxLength={256}
                disabled={lifecycle.active}
                autoCapitalize="none"
                spellCheck={false}
              />
            )}
          </FormField>
          {integrations !== undefined &&
          integrations !== null &&
          integrations.length === 0 ? (
            <div className="notice" role="status">
              <span>
                Connect a store in the Stores workspace before creating a
                catalog. No unsupported manual catalog will be created.
              </span>
            </div>
          ) : null}
          <p
            className="muted commerce-operation-status"
            role="status"
            aria-live="polite"
          >
            {lifecycle.active
              ? "Creating the catalog. Fields and dismissal stay locked until the request finishes."
              : "Nothing is created until you choose Create catalog."}
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
              {lifecycle.active ? "Creating…" : "Create catalog"}
            </button>
          </ModalFooter>
        </form>
      </Modal>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard product catalog draft?"
        description="The catalog name, source settings, integration ID, and currency will be cleared."
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

/* ---------- import products ---------- */

function ImportProductsModal({
  catalog,
  returnFocusRef,
  onClose,
  onImported,
}: {
  catalog: CommerceCatalog;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onImported: () => void;
}): ReactElement {
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const completedRef = useRef(false);
  const dirty = Boolean(text || replace);

  const run = async (): Promise<boolean> => {
    if (text.length > MAX_IMPORT_TEXT_LENGTH) {
      setErr(
        `The import exceeds the ${MAX_IMPORT_TEXT_LENGTH.toLocaleString()}-character desktop safety limit. Split it into smaller batches.`,
      );
      return false;
    }
    const parsed = parseProductsJson(text);
    if (parsed.error) {
      setErr(parsed.error);
      return false;
    }
    if (parsed.products.length > MAX_IMPORT_PRODUCTS) {
      setErr(
        `This batch contains ${parsed.products.length.toLocaleString()} products. Split it into batches of ${MAX_IMPORT_PRODUCTS.toLocaleString()} or fewer.`,
      );
      return false;
    }
    const payload = {
      products: parsed.products,
      ...(replace ? { replace: true } : {}),
    };
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify(payload),
    ).byteLength;
    if (payloadBytes > MAX_IMPORT_BODY_BYTES) {
      setErr(
        `The encoded request is ${payloadBytes.toLocaleString()} bytes. Split it into batches below the server's ${MAX_IMPORT_BODY_BYTES.toLocaleString()}-byte limit.`,
      );
      return false;
    }
    setErr(null);
    const res = await commerceApi.importCatalogProducts(catalog.id, payload);
    if (res.error) {
      setErr(safeCatalogFailure(res.error));
      return false;
    }
    toast.success(importSummaryMessage(res.data));
    return true;
  };
  const lifecycle = useDraftLifecycleController({
    ownerId: `commerce-catalog-import-${catalog.id}`,
    label: `Product import for ${catalog.name}`,
    mode: "action",
    enabled: true,
    dirty,
    save: run,
    discard: () => {
      setText("");
      setReplace(false);
      setErr(null);
      setReplaceConfirmOpen(false);
    },
    close: onClose,
    detail: `The product import draft for ${catalog.name} has not been submitted.`,
    onError: () =>
      setErr("The product import could not be completed. Retry when ready."),
  });
  const submit = async (): Promise<void> => {
    if (!(await lifecycle.submit()) || completedRef.current) return;
    completedRef.current = true;
    setReplaceConfirmOpen(false);
    onImported();
    onClose();
  };
  const requestImport = (): void => {
    if (lifecycle.active) return;
    if (replace) {
      setReplaceConfirmOpen(true);
      return;
    }
    void submit();
  };

  return (
    <>
      <Modal
        open
        onClose={lifecycle.requestClose}
        closeOnBackdrop={!lifecycle.active}
        closeOnEscape={!lifecycle.active}
        closeDisabled={lifecycle.active}
        size="lg"
        returnFocusRef={returnFocusRef}
        title={`Import products — ${catalog.name}`}
        description={`Paste a JSON array of up to ${MAX_IMPORT_PRODUCTS.toLocaleString()} product objects and ${MAX_IMPORT_BODY_BYTES.toLocaleString()} encoded request bytes. Keep this dialog open while the server processes the import.`}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            requestImport();
          }}
        >
          <FormField
            label="Products JSON"
            required
            error={err}
            help='Use a bare array or {"products": [...]}. Each item must be an object; include stable source_id, title, price_cents, and currency values.'
          >
            <textarea
              rows={10}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setErr(null);
              }}
              style={{ fontFamily: "var(--pw-font-mono)", fontSize: 12 }}
              placeholder='[{"source_id": "p1", "title": "Mug", "price_cents": 1900, "currency": "USD"}]'
              maxLength={MAX_IMPORT_TEXT_LENGTH + 1}
              disabled={lifecycle.active}
              autoCapitalize="none"
              spellCheck={false}
            />
          </FormField>
          <label className="commerce-checkbox-row">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
              disabled={lifecycle.active}
            />
            <span>
              Replace existing catalog items instead of merging
              <span className="commerce-detail">
                This can remove existing catalog membership and requires a
                second confirmation.
              </span>
            </span>
          </label>
          <p
            className="muted commerce-operation-status"
            role="status"
            aria-live="polite"
          >
            {lifecycle.active
              ? "Import in progress. The draft and dismissal stay locked until the request finishes."
              : `${text.length.toLocaleString()} of ${MAX_IMPORT_TEXT_LENGTH.toLocaleString()} characters entered.`}
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
                ? "Importing…"
                : replace
                  ? "Review replacement import"
                  : "Import products"}
            </button>
          </ModalFooter>
        </form>
      </Modal>
      <ConfirmModal
        open={replaceConfirmOpen}
        title={`Replace products in ${catalog.name}?`}
        description="This import uses replacement mode and may remove existing catalog membership that is absent from the pasted payload. The catalog itself is kept."
        confirmLabel="Import and replace"
        cancelLabel="Review payload"
        danger
        busy={lifecycle.active}
        onConfirm={submit}
        onClose={() => {
          if (!lifecycle.active) setReplaceConfirmOpen(false);
        }}
      />
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard product import draft?"
        description="The pasted JSON and replacement choice will be cleared from memory."
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

/* ---------- product feeds ---------- */

function FeedsPanel({
  id,
  catalog,
  canAdmin,
  onClose,
}: {
  id: string;
  catalog: CommerceCatalog;
  canAdmin: boolean;
  onClose: () => void;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const feedCreateReturnFocusRef = useRef<HTMLElement | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [resolveTarget, setResolveTarget] =
    useState<CommerceProductFeed | null>(null);
  const resolveReturnFocusRef = useRef<HTMLElement | null>(null);
  const source = useCatalogPage<CommerceProductFeed>(
    `commerce-feeds:${catalog.id}`,
    (cursor) =>
      commerceApi.listProductFeeds(catalog.id, {
        cursor,
        limit: PER_PAGE,
      }),
  );
  const data = source.data;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotionNow() ? "auto" : "smooth",
    });
  }, []);

  return (
    <div
      ref={panelRef}
      id={id}
      className="card commerce-feeds-panel"
      role="region"
      aria-label={`Product feeds for ${catalog.name}`}
      tabIndex={-1}
      style={{ marginTop: 16, padding: 16 }}
    >
      <SectionHeader
        title={`Product feeds — ${catalog.name}`}
        description="Draft and active product selections returned by the feed resolver. A resolve preview is review evidence, not a send or delivery event."
        actions={
          <div className="commerce-row-actions">
            {canAdmin ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={(event) => {
                  feedCreateReturnFocusRef.current = event.currentTarget;
                  setCreateOpen(true);
                }}
              >
                + New feed
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onClose}
            >
              Close feeds
            </button>
          </div>
        }
      />

      <CatalogLoadState
        label="product feeds"
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
              {data.items.length.toLocaleString()} feed
              {data.items.length === 1 ? "" : "s"} on this page for catalog ID{" "}
              <span className="mono">{catalog.id}</span>.
              {source.nextCursor ? " More are available." : ""}
            </p>
            <CatalogRefreshAction
              label="product feeds"
              transport={source.transport}
              onRefresh={source.retry}
            />
          </div>
          <div
            className="list commerce-list commerce-feeds-list"
            role="table"
            aria-label={`Product feeds for ${catalog.name}`}
            aria-rowcount={data.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: FEED_COLS }}
              >
                <div role="columnheader">Feed and identifiers</div>
                <div role="columnheader">Type and rules</div>
                <div role="columnheader">Status</div>
                <div role="columnheader">Limits</div>
                <div role="columnheader">Preview</div>
              </div>
            </div>
            <div role="rowgroup">
              {data.items.length === 0 ? (
                <div className="list-empty" role="row">
                  <div className="empty-state" role="cell" aria-colspan={5}>
                    <div className="empty-state-icon" aria-hidden="true">
                      ·
                    </div>
                    <h3>No feeds for this catalog yet</h3>
                    <p>
                      {canAdmin
                        ? "Create a feed to define which products a campaign block shows, then resolve it here to preview the selection."
                        : "An administrator can create feeds for this catalog."}
                    </p>
                  </div>
                </div>
              ) : (
                data.items.map((feed) => (
                  <div
                    key={feed.id}
                    className="list-row"
                    role="row"
                    style={{
                      gridTemplateColumns: FEED_COLS,
                      cursor: "default",
                    }}
                  >
                    <div
                      role="cell"
                      className="commerce-value"
                      style={{ fontWeight: 500 }}
                    >
                      <span>{feed.name}</span>
                      <span className="commerce-detail mono">
                        Feed ID: {feed.id} · Catalog ID:{" "}
                        {feed.catalog_id || catalog.id}
                      </span>
                      <span className="commerce-detail">
                        Created <CatalogTime value={feed.created_at} /> ·
                        Updated <CatalogTime value={feed.updated_at} />
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="muted commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>{feed.feed_type || "Unknown type"}</span>
                      <span className="commerce-detail">
                        Criteria: {formatCatalogRecord(feed.criteria)}
                      </span>
                      <span className="commerce-detail">
                        Fallback: {formatCatalogRecord(feed.fallback)}
                      </span>
                    </div>
                    <div role="cell">
                      <span
                        className={`badge${feed.status === "active" ? " success" : ""}`}
                      >
                        {feed.status || "Unknown"}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="muted tabular commerce-value"
                      style={{ fontSize: 12 }}
                    >
                      <span>
                        Maximum {feed.max_items.toLocaleString()} items
                      </span>
                      <span className="commerce-detail">
                        {feed.exclude_out_of_stock
                          ? "Out-of-stock products excluded"
                          : "Out-of-stock products may be included"}
                      </span>
                    </div>
                    <div role="cell" className="commerce-row-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Resolve a preview of ${feed.name}`}
                        onClick={(event) => {
                          resolveReturnFocusRef.current = event.currentTarget;
                          setResolveTarget(feed);
                        }}
                      >
                        Resolve preview
                      </button>
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
            label="Product feeds"
          />
        </>
      ) : null}

      {createOpen ? (
        <FeedCreateModal
          catalogId={catalog.id}
          returnFocusRef={feedCreateReturnFocusRef}
          onClose={() => setCreateOpen(false)}
          onCreated={source.firstPage}
        />
      ) : null}

      {resolveTarget ? (
        <ResolvePreviewModal
          catalogId={catalog.id}
          feed={resolveTarget}
          returnFocusRef={resolveReturnFocusRef}
          onClose={() => setResolveTarget(null)}
        />
      ) : null}
    </div>
  );
}

function FeedCreateModal({
  catalogId,
  returnFocusRef,
  onClose,
  onCreated,
}: {
  catalogId: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreated: () => void;
}): ReactElement {
  const [name, setName] = useState("");
  const [feedType, setFeedType] = useState("recent");
  const [maxItems, setMaxItems] = useState("6");
  const [excludeOOS, setExcludeOOS] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const completedRef = useRef(false);
  const dirty = Boolean(
    name || feedType !== "recent" || maxItems !== "6" || !excludeOOS,
  );

  const save = async (): Promise<boolean> => {
    if (!name.trim()) {
      setErr("Feed name is required.");
      setErrorField("name");
      return false;
    }
    const max = Number(maxItems);
    if (!Number.isSafeInteger(max) || max < 1 || max > 50) {
      setErr("Maximum items must be a whole number from 1 through 50.");
      setErrorField("max");
      return false;
    }
    setErr(null);
    setErrorField(null);
    const res = await commerceApi.createProductFeed(catalogId, {
      name: name.trim(),
      feed_type: feedType,
      max_items: max,
      exclude_out_of_stock: excludeOOS,
    });
    if (res.error) {
      setErr(safeCatalogFailure(res.error));
      return false;
    }
    toast.success(`Draft feed "${name.trim()}" created`);
    return true;
  };
  const lifecycle = useDraftLifecycleController({
    ownerId: `commerce-feed-create-${catalogId}`,
    label: "Product feed draft",
    mode: "create",
    enabled: true,
    dirty,
    save,
    discard: () => {
      setName("");
      setFeedType("recent");
      setMaxItems("6");
      setExcludeOOS(true);
      setErr(null);
      setErrorField(null);
    },
    close: onClose,
    detail: "This product feed has not been created.",
    onError: () => {
      setErr("The product feed could not be created. Retry when ready.");
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
        returnFocusRef={returnFocusRef}
        title="New product feed"
        description="Choose a server-backed selection strategy and bounded result limit. New feeds are saved as drafts; this workspace does not claim they are published."
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
            label="Name"
            required
            error={errorField === "name" ? err : null}
          >
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errorField === "name") {
                  setErr(null);
                  setErrorField(null);
                }
              }}
              placeholder="e.g. Best sellers"
              maxLength={160}
              disabled={lifecycle.active}
            />
          </FormField>
          <div className="commerce-form-grid">
            <FormField
              label="Feed type"
              help="Only strategies with defined resolver behavior are available here."
            >
              <select
                value={feedType}
                onChange={(e) => setFeedType(e.target.value)}
                disabled={lifecycle.active}
              >
                <option value="recent">Recent catalog products</option>
                <option value="behavioral_recommendation">
                  Behavioral recommendation
                </option>
                <option value="dynamic">
                  Dynamic selection with subscriber context
                </option>
              </select>
            </FormField>
            <FormField
              label="Maximum items"
              required
              help="Whole number from 1 through 50. Campaign layouts may render fewer."
              error={errorField === "max" ? err : null}
            >
              <input
                type="number"
                min={1}
                max={50}
                step={1}
                inputMode="numeric"
                value={maxItems}
                onChange={(e) => {
                  setMaxItems(e.target.value);
                  if (errorField === "max") {
                    setErr(null);
                    setErrorField(null);
                  }
                }}
                disabled={lifecycle.active}
              />
            </FormField>
          </div>
          <label className="commerce-checkbox-row">
            <input
              type="checkbox"
              checked={excludeOOS}
              onChange={(e) => setExcludeOOS(e.target.checked)}
              disabled={lifecycle.active}
            />
            Exclude out-of-stock products from resolved campaign output
          </label>
          <p
            className="muted commerce-operation-status"
            role="status"
            aria-live="polite"
          >
            {lifecycle.active
              ? "Creating the feed. Fields and dismissal stay locked until the request finishes."
              : "Nothing is created until you choose Create draft feed. Publication remains a separate unavailable lifecycle."}
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
              {lifecycle.active ? "Creating…" : "Create draft feed"}
            </button>
          </ModalFooter>
        </form>
      </Modal>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard product feed draft?"
        description="The feed name, selection type, limit, and stock policy will be cleared."
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

const RESOLVE_COLS = "50px 2fr 110px 110px 1fr";

function ResolvePreviewModal({
  catalogId,
  feed,
  returnFocusRef,
  onClose,
}: {
  catalogId: string;
  feed: CommerceProductFeed;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): ReactElement {
  const [emailDraft, setEmailDraft] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const reloadFlightRef = useRef<Promise<void> | null>(null);
  const source = useRemoteResource<CommerceResolvedFeed>(
    async () => {
      const result = await commerceApi.resolveProductFeed(catalogId, feed.id, {
        ...(submittedEmail ? { subscriber_email: submittedEmail } : {}),
      });
      if (result.error) return { error: result.error };
      if (!result.data || !Array.isArray(result.data.items)) {
        return {
          error: { message: "Invalid feed preview", kind: "parse" },
        };
      }
      return { data: result.data };
    },
    { identity: `feed-preview:${catalogId}:${feed.id}:${submittedEmail}` },
  );
  const reload = (): void => {
    if (reloadFlightRef.current) return;
    const request = source.reload();
    reloadFlightRef.current = request;
    void request.finally(() => {
      if (reloadFlightRef.current === request) reloadFlightRef.current = null;
    });
  };
  const resolveDraft = (): void => {
    if (source.transport === "loading") return;
    const normalized = emailDraft.trim();
    if (normalized && !/^[^\s@]+@[^\s@]+$/u.test(normalized)) {
      setEmailError(
        "Enter a valid subscriber email address or leave it empty.",
      );
      return;
    }
    setEmailError(null);
    if (normalized === submittedEmail) reload();
    else setSubmittedEmail(normalized);
  };
  const resolved = source.data;
  const draftDiffers = emailDraft.trim() !== submittedEmail;

  return (
    <Modal
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="xl"
      title={`Resolve preview — ${feed.name}`}
      description="A review-only snapshot of the resolver response. It does not send a message or prove final campaign rendering, enrollment, or delivery."
    >
      <form
        className="commerce-resolve-form"
        onSubmit={(event) => {
          event.preventDefault();
          resolveDraft();
        }}
      >
        <FormField
          label="Subscriber email (optional)"
          help="Leave empty for the non-personalized resolver result. The preview never sends a message."
          error={emailError}
        >
          <input
            className="input"
            type="email"
            placeholder="customer@example.com"
            value={emailDraft}
            onChange={(event) => {
              setEmailDraft(event.target.value);
              setEmailError(null);
            }}
            maxLength={320}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
          />
        </FormField>
        <button
          type="submit"
          className="btn"
          aria-disabled={source.transport === "loading" || undefined}
          aria-busy={source.transport === "loading" || undefined}
        >
          {source.transport === "loading" ? "Resolving…" : "Resolve preview"}
        </button>
      </form>
      <p
        className="muted commerce-operation-status"
        role="status"
        aria-live="polite"
      >
        {source.transport === "loading"
          ? `Resolving ${submittedEmail ? "with supplied subscriber context" : "without subscriber personalization"}.`
          : draftDiffers
            ? "The email draft has changed. Choose Resolve preview to apply it; the table still represents the previous request."
            : `Preview represents ${submittedEmail ? "the submitted subscriber context" : "the non-personalized resolver"}. No message was sent.`}
      </p>

      <CatalogLoadState
        label="feed preview"
        dataPresent={resolved !== null}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={reload}
      />
      {resolved === null ? null : resolved.items.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          The resolver returned no items — the catalog may be empty, or every
          candidate was filtered (e.g. out of stock with in-stock-only set).
        </p>
      ) : (
        <>
          <div className="commerce-preview-context">
            <span>Feed ID: {resolved.feed_id}</span>
            <span>Catalog ID: {resolved.catalog_id || catalogId}</span>
            <span>Feed type: {resolved.feed_type}</span>
            <span>
              Stock policy:{" "}
              {resolved.exclude_out_of_stock
                ? "out-of-stock excluded"
                : "out-of-stock allowed"}
            </span>
            <span>Generated time: unavailable</span>
            <span>Campaign rendering: not executed</span>
          </div>
          <div className="commerce-product-preview" aria-hidden="true">
            {resolved.items.slice(0, 6).map((item) => (
              <article
                key={`preview-${item.product_id}-${item.variant_id ?? ""}`}
              >
                <span className="commerce-product-preview-art">
                  {(item.title || "P").slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{item.title || "Untitled product"}</strong>
                  <small>{fmtCents(item.price_cents, item.currency)}</small>
                </span>
                <span
                  className={`commerce-product-preview-state${item.available ? " is-available" : ""}`}
                >
                  {item.available ? "Available" : "Unavailable"}
                </span>
              </article>
            ))}
          </div>
          <div
            className="list commerce-list commerce-resolve-list"
            role="table"
            aria-label={`Resolved products for ${feed.name}`}
            aria-rowcount={resolved.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: RESOLVE_COLS }}
              >
                <div role="columnheader">Rank</div>
                <div role="columnheader">Product and identifiers</div>
                <div role="columnheader">Price</div>
                <div role="columnheader">Availability</div>
                <div role="columnheader">Resolver reason</div>
              </div>
            </div>
            <div role="rowgroup">
              {resolved.items.map((item) => (
                <div
                  key={`${item.product_id}-${item.variant_id ?? ""}`}
                  className="list-row"
                  role="row"
                  style={{
                    gridTemplateColumns: RESOLVE_COLS,
                    cursor: "default",
                  }}
                >
                  <div role="cell" className="tabular muted">
                    {item.rank}
                  </div>
                  <div role="cell" className="commerce-value">
                    <span>{item.title || "Untitled product"}</span>
                    <span className="commerce-detail mono">
                      Product ID: {item.product_id} · Source ID:{" "}
                      {item.source_id}
                    </span>
                    <span className="commerce-detail mono">
                      Variant ID: {item.variant_id || "product level"} · Variant
                      source ID: {item.variant_source_id || "not recorded"}
                    </span>
                  </div>
                  <div
                    role="cell"
                    className="tabular commerce-value"
                    style={{ fontSize: 12 }}
                  >
                    <span>{fmtCents(item.price_cents, item.currency)}</span>
                    <span className="commerce-detail">
                      Compare at:{" "}
                      {item.compare_at_price_cents != null
                        ? fmtCents(item.compare_at_price_cents, item.currency)
                        : "not recorded"}
                    </span>
                  </div>
                  <div role="cell">
                    {item.available ? (
                      <span className="badge success">Available</span>
                    ) : (
                      <span className="badge">Unavailable</span>
                    )}
                  </div>
                  <div
                    role="cell"
                    className="muted commerce-value"
                    style={{ fontSize: 11 }}
                  >
                    {item.reason || "No reason returned"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}
