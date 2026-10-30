import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { PlaygroundHistory } from "../components/playground/PlaygroundHistory";
import {
  type PlaygroundEnvironment,
  classifyPlaygroundEnvironment,
} from "../components/playground/playground-safety";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { getApiUrl } from "../lib/api-client";
import { onContextEpochObserved, readContextEpoch } from "../lib/context-epoch";
import {
  desktopRouteIdentityScope,
  getDesktopRoute,
  navigateDesktopRoute,
  useDesktopRouteTab,
} from "../lib/desktop-router";
import { useMe, useRoleStatus } from "../lib/store";
import { APIPlaygroundReference } from "./APIPlaygroundReference";
import { APIPlaygroundWorkbench } from "./APIPlaygroundWorkbench";
import {
  type NormalizedPlaygroundCatalog,
  PlaygroundCatalogError,
  normalizePlaygroundCatalog,
} from "./api-playground-openapi";
import { executionPolicyFor } from "./api-playground-policy";
import {
  loadPlaygroundCatalogDocument,
  playgroundApiCredentialFingerprintSuffix,
  playgroundHasApiCredentialFor,
} from "./api-playground-transport";
import { usePlaygroundWorkbenchController } from "./api-playground-workbench-state";

import "../styles-mcp.css";
import "../styles-playground-v2.css";

type PlaygroundTab = "explore" | "reference" | "history";

const PLAYGROUND_TABS: readonly { value: PlaygroundTab; label: string }[] = [
  { value: "explore", label: "Explore" },
  { value: "reference", label: "API Reference" },
  { value: "history", label: "History" },
];
const PLAYGROUND_TAB_VALUES = PLAYGROUND_TABS.map((item) => item.value);

function usePlaygroundRouteTab() {
  const routeTab = useDesktopRouteTab(
    "apiPlayground",
    PLAYGROUND_TAB_VALUES,
    "explore",
  );
  const discardDisabledTab = useCallback((): void => {
    const current = getDesktopRoute();
    if (current.section !== "apiPlayground" || current.tab === undefined) {
      return;
    }
    const next = { ...current };
    delete next.tab;
    navigateDesktopRoute(next, { replace: true });
  }, []);
  return [...routeTab, discardDisabledTab] as const;
}

export function PlaygroundTabs({
  tab,
  onChange,
  onDiscardDisabledTab,
  panels,
  disabled = false,
}: {
  tab: PlaygroundTab;
  onChange: (tab: PlaygroundTab) => void;
  onDiscardDisabledTab?: () => void;
  panels: Record<PlaygroundTab, ReactNode>;
  disabled?: boolean;
}): ReactElement {
  // Back/Forward and deep-link state can change independently of a disabled
  // button. Drop that change while a request is in flight so it cannot become
  // a deferred panel switch that hides the eventual response warning.
  const wasDisabled = useRef(disabled);
  const discardRoutedTab =
    tab !== "explore" && (disabled || wasDisabled.current);
  useEffect(() => {
    wasDisabled.current = disabled;
    if (!discardRoutedTab) return;
    if (onDiscardDisabledTab) onDiscardDisabledTab();
    else onChange("explore");
  }, [disabled, discardRoutedTab, onChange, onDiscardDisabledTab]);
  const activeTab: PlaygroundTab =
    disabled || discardRoutedTab ? "explore" : tab;
  const tabs = useTabsInteraction({
    value: activeTab,
    items: PLAYGROUND_TABS,
    onChange,
    activation: "manual",
  });
  return (
    <>
      <div
        ref={tabs.listRef}
        className="play-tabs"
        {...tabs.listProps}
        aria-label="Playground sections"
      >
        {PLAYGROUND_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            {...tabs.getTabProps(item.value)}
            disabled={disabled}
            className={`play-tab${activeTab === item.value ? " is-active" : ""}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {PLAYGROUND_TABS.map((item) => (
        <div key={item.value} {...tabs.getPanelProps(item.value)}>
          {activeTab === item.value ? panels[item.value] : null}
        </div>
      ))}
    </>
  );
}

const RESPONSE_TABS = [
  { value: "body", label: "Body" },
  { value: "headers", label: "Headers" },
] as const;

export function ResponseTabs({
  value,
  onChange,
  headerCount,
  panels,
  action,
}: {
  value: "body" | "headers";
  onChange: (value: "body" | "headers") => void;
  headerCount: number;
  panels: Record<"body" | "headers", ReactNode>;
  action: ReactNode;
}): ReactElement {
  const tabs = useTabsInteraction({
    value,
    items: RESPONSE_TABS,
    onChange,
    activation: "automatic",
  });
  return (
    <>
      <div className="play-tabs play-tabs-inner">
        <div
          ref={tabs.listRef}
          {...tabs.listProps}
          aria-label="Response content"
        >
          {RESPONSE_TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              {...tabs.getTabProps(item.value)}
              className={`play-tab${value === item.value ? " is-active" : ""}`}
            >
              {item.label}
              {item.value === "headers" ? (
                <span className="play-tab-count">{headerCount}</span>
              ) : null}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {action}
      </div>
      {RESPONSE_TABS.map((item) => (
        <div key={item.value} {...tabs.getPanelProps(item.value)}>
          {value === item.value ? panels[item.value] : null}
        </div>
      ))}
    </>
  );
}

/* ---------- main page --------------------------------------------- */

export function APIPlayground(): ReactElement {
  const apiURL = getApiUrl();
  const me = useMe();
  const roleStatus = useRoleStatus();
  const contextEpoch = useSyncExternalStore(
    onContextEpochObserved,
    readContextEpoch,
    readContextEpoch,
  );
  const historyScope = useMemo(() => {
    if (!me?.user || !me.tenant) return null;
    return desktopRouteIdentityScope(
      `${canonicalAuthority(apiURL)}\u0000${me.user}`,
      me.tenant,
    );
  }, [apiURL, me?.tenant, me?.user]);
  const credentialConflict = Boolean(
    me?.credentialSource === "session" && playgroundHasApiCredentialFor(apiURL),
  );
  const [credentialLabel, setCredentialLabel] = useState(
    "Credential: resolving",
  );
  useEffect(() => {
    let active = true;
    const apiCredential = playgroundHasApiCredentialFor(apiURL);
    if (!apiCredential) {
      setCredentialLabel(
        me?.credentialSource === "session"
          ? `Credential: session · identity …${historyScope?.slice(-8) ?? "unavailable"}`
          : "Credential: unresolved",
      );
      return () => {
        active = false;
      };
    }
    void playgroundApiCredentialFingerprintSuffix(apiURL).then((suffix) => {
      if (active) {
        setCredentialLabel(
          `Credential: API key${suffix ? ` · fingerprint …${suffix}` : " · fingerprint unavailable"}`,
        );
      }
    });
    return () => {
      active = false;
    };
  }, [apiURL, historyScope, me?.credentialSource]);
  const workspaceKey = JSON.stringify([
    historyScope ?? "api-playground-identity-unresolved",
    roleStatus,
    me?.effectiveRole ?? "effective-role-unresolved",
    contextEpoch ?? "context-epoch-unobserved",
  ]);
  return (
    <APIPlaygroundWorkspace
      key={workspaceKey}
      apiURL={apiURL}
      historyScope={historyScope}
      credentialConflict={credentialConflict}
      credentialLabel={credentialLabel}
    />
  );
}

function APIPlaygroundWorkspace({
  apiURL,
  historyScope,
  credentialConflict,
  credentialLabel,
}: {
  apiURL: string;
  historyScope: string | null;
  credentialConflict: boolean;
  credentialLabel: string;
}): ReactElement {
  const [catalog, setCatalog] = useState<NormalizedPlaygroundCatalog | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const environment = useMemo(
    () => classifyPlaygroundEnvironment(apiURL),
    [apiURL],
  );

  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    setCatalog(null);
    if (credentialConflict) {
      setError(
        "API Playground is unavailable while both a session and an API key are active. Sign out or remove the API key so review and execution use one identity.",
      );
      return () => abort.abort("credential-conflict");
    }
    void loadPlaygroundCatalogDocument(apiURL, abort.signal)
      .then((document) => normalizePlaygroundCatalog(document))
      .then(setCatalog)
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setError(
          reason instanceof PlaygroundCatalogError || reason instanceof Error
            ? reason.message
            : "The API catalog could not be loaded.",
        );
      });
    return () => abort.abort("catalog-loader-unmounted");
  }, [apiURL, credentialConflict, loadNonce]);

  return (
    <div className="page api-playground-page">
      <header className="page-header play-page-header">
        <div>
          <span className="eyebrow">Developer console</span>
          <h1 className="page-title">API Playground</h1>
          <p className="page-subtitle">
            A complete contract reference and a deliberately reviewed live
            runner.
          </p>
        </div>
      </header>
      <EnvironmentBanner environment={environment} apiURL={apiURL} />
      <p className="play-credential-binding" aria-label={credentialLabel}>
        {credentialLabel}
      </p>
      {catalog ? (
        <APIPlaygroundReady
          catalog={catalog}
          apiURL={apiURL}
          historyScope={historyScope}
          environment={environment}
        />
      ) : error ? (
        <CatalogError
          error={error}
          onRetry={() => setLoadNonce((value) => value + 1)}
        />
      ) : (
        <CatalogLoading />
      )}
    </div>
  );
}

function APIPlaygroundReady({
  catalog,
  apiURL,
  historyScope,
  environment,
}: {
  catalog: NormalizedPlaygroundCatalog;
  apiURL: string;
  historyScope: string | null;
  environment: PlaygroundEnvironment;
}): ReactElement {
  const me = useMe();
  const roleStatus = useRoleStatus();
  const [tab, setTab, discardDisabledTab] = usePlaygroundRouteTab();
  const effectiveRole =
    roleStatus === "resolved" ? (me?.effectiveRole ?? null) : null;
  const workspaceLabel = me?.tenant ?? "Identity unresolved";
  const principalLabel = me?.user ?? "Identity unresolved";
  const controller = usePlaygroundWorkbenchController({
    operations: catalog.operations,
    apiURL,
    historyScope,
    effectiveRole,
  });
  const operationKeys = useMemo(
    () =>
      new Set(
        catalog.operations.map(
          (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
        ),
      ),
    [catalog.operations],
  );
  const [favorites, setFavorites] = useState<Set<string>>(() =>
    readFavorites(historyScope, operationKeys),
  );
  const toggleFavorite = useCallback(
    (key: string): void => {
      setFavorites((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else if (next.size < 100) next.add(key);
        writeFavorites(historyScope, next);
        return next;
      });
    },
    [historyScope],
  );
  const summary = useMemo(
    () => ({
      runnable: catalog.operations.filter(
        (operation) => executionPolicyFor(operation).executable,
      ).length,
      held: catalog.operations.filter((operation) => operation.releaseHold)
        .length,
      tags: new Set(catalog.operations.map((operation) => operation.primaryTag))
        .size,
    }),
    [catalog.operations],
  );

  return (
    <>
      <section className="play-catalog-summary" aria-label="Catalog status">
        <SummaryMetric
          label="Reference operations"
          value={catalog.operations.length}
        />
        <SummaryMetric
          label="Reviewed runner"
          value={summary.runnable}
          tone="success"
        />
        <SummaryMetric label="Reference tags" value={summary.tags} />
        <SummaryMetric
          label="Release-held"
          value={summary.held}
          tone="warning"
        />
        <div className="play-catalog-version">
          <span>{catalog.title}</span>
          <code>v{catalog.version}</code>
        </div>
      </section>
      <PlaygroundTabs
        tab={tab}
        onChange={setTab}
        onDiscardDisabledTab={discardDisabledTab}
        disabled={controller.sending}
        panels={{
          explore: (
            <APIPlaygroundWorkbench
              operations={catalog.operations}
              controller={controller}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              environment={environment}
              workspaceLabel={workspaceLabel}
              principalLabel={principalLabel}
              effectiveRole={effectiveRole}
            />
          ),
          reference: (
            <APIPlaygroundReference
              operations={catalog.operations}
              selectedOperationKey={controller.selectedKey}
              onSelectedOperationChange={(operation) =>
                controller.select(
                  `${operation.method.toUpperCase()} ${operation.path}`,
                )
              }
            />
          ),
          history: (
            <PlaygroundHistory
              identityScope={historyScope}
              onReplay={(entry) => {
                controller.replay(entry);
                setTab("explore");
              }}
            />
          ),
        }}
      />
    </>
  );
}

function EnvironmentBanner({
  environment,
  apiURL,
}: {
  environment: PlaygroundEnvironment;
  apiURL: string;
}): ReactElement {
  return (
    <section
      className={`play-environment-banner is-${environment.tone}`}
      aria-label="API request environment"
    >
      <div>
        <strong>{environment.label} API authority</strong>
        <code>{apiURL}</code>
      </div>
      <p>
        Credentials remain transport-owned. Live execution is same-authority,
        cancellable, non-retrying, response-bounded, and unavailable for
        unreviewed, public-capability, held, streaming, binary, or
        unsupported-auth routes.
      </p>
    </section>
  );
}

function SummaryMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "warning";
}): ReactElement {
  return (
    <div className={`play-summary-metric is-${tone}`}>
      <strong className="tabular">{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function CatalogLoading(): ReactElement {
  return (
    <section className="play-catalog-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div>
        <h2>Validating the live API contract…</h2>
        <p>
          Loading the bounded catalog, resolving local refs, and checking every
          path placeholder.
        </p>
      </div>
    </section>
  );
}

function CatalogError({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <section className="play-catalog-state is-error" role="alert">
      <div>
        <h2>The API contract is unavailable</h2>
        <p>{error}</p>
        <p>
          No endpoint was made executable from a partial or malformed catalog.
        </p>
      </div>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Retry contract load
      </button>
    </section>
  );
}

const FAVORITES_PREFIX = "pw_api_playground_favorites_v2";

function favoritesKey(scope: string | null): string | null {
  return scope ? `${FAVORITES_PREFIX}:${scope}` : null;
}

function readFavorites(
  scope: string | null,
  allowed: ReadonlySet<string>,
): Set<string> {
  const key = favoritesKey(scope);
  if (!key) return new Set();
  try {
    const value = JSON.parse(
      window.localStorage.getItem(key) ?? "[]",
    ) as unknown;
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value
        .filter(
          (item): item is string =>
            typeof item === "string" &&
            item.length <= 2_200 &&
            allowed.has(item),
        )
        .slice(0, 100),
    );
  } catch {
    return new Set();
  }
}

function writeFavorites(scope: string | null, favorites: Set<string>): void {
  const key = favoritesKey(scope);
  if (!key) return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify([...favorites].slice(0, 100)),
    );
  } catch {
    // Favorites are a convenience; request safety never depends on persistence.
  }
}

function canonicalAuthority(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "invalid-api-authority";
  }
}
