import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { api, type MCPCatalogEntry } from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import {
  navigateDesktopRoute,
  type DesktopRoute,
  useDesktopRoute,
} from "../../lib/desktop-router";
import { isInitialRemoteLoad } from "../../lib/remote-resource";
import { Card } from "../Card";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import { safeMcpToolName } from "./mcp-execution-security";
import {
  formatMcpAbsoluteTime,
  formatMcpRelativeTime,
  mcpFailureMessage,
} from "./mcp-display";

const MAX_CATALOGUE_TOOLS = 2_000;
const CATALOGUE_PAGE_SIZE = 200;
const CATALOGUE_CATEGORY_FILTER = "catalog-category";
const MAX_CATALOGUE_SEARCH_CHARS = 256;
const UNSAFE_CATALOGUE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function catalogueRouteView(route: DesktopRoute): {
  search: string;
  category: string;
  needsNormalization: boolean;
} {
  if (route.section !== "mcp") {
    return { search: "", category: "", needsNormalization: false };
  }
  const categories = (route.filters ?? [])
    .filter((entry) => entry.key === CATALOGUE_CATEGORY_FILTER)
    .map((entry) => entry.value);
  const rawSearch = route.query ?? "";
  const search = rawSearch.slice(0, MAX_CATALOGUE_SEARCH_CHARS);
  const rawCategory = categories[0] ?? "";
  const category =
    rawCategory.length <= 128 && !UNSAFE_CATALOGUE_TEXT.test(rawCategory)
      ? rawCategory
      : "";
  return {
    search,
    category,
    needsNormalization:
      categories.length > 1 || search !== rawSearch || category !== rawCategory,
  };
}

function routeWithCatalogueView(
  route: DesktopRoute,
  search: string,
  category: string,
): DesktopRoute {
  const retainedFilters =
    route.section === "mcp"
      ? (route.filters ?? []).filter(
          (entry) => entry.key !== CATALOGUE_CATEGORY_FILTER,
        )
      : [];
  const filters = [
    ...retainedFilters,
    ...(category ? [{ key: CATALOGUE_CATEGORY_FILTER, value: category }] : []),
  ];
  const next: DesktopRoute = {
    ...(route.section === "mcp" ? route : { section: "mcp" as const }),
    section: "mcp",
    tab: "tools",
    query: search || undefined,
    filters: filters.length > 0 ? filters : undefined,
  };
  delete next.overlay;
  return next;
}

function verifiedCatalog(value: MCPCatalogEntry[] | undefined):
  | { data: MCPCatalogEntry[]; error?: never }
  | {
      data?: never;
      error: { kind: "parse"; message: string };
    } {
  if (!Array.isArray(value) || value.length > MAX_CATALOGUE_TOOLS) {
    return {
      error: { kind: "parse", message: "The tool catalogue was malformed." },
    };
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      safeMcpToolName(entry.name) !== entry.name ||
      typeof entry.category !== "string" ||
      !entry.category.trim() ||
      entry.category.trim() !== entry.category ||
      entry.category.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(entry.category) ||
      UNSAFE_CATALOGUE_TEXT.test(entry.category) ||
      typeof entry.description !== "string" ||
      !entry.description.trim() ||
      entry.description.length > 2_000 ||
      UNSAFE_CATALOGUE_TEXT.test(entry.description) ||
      seen.has(entry.name)
    ) {
      return {
        error: {
          kind: "parse",
          message: "The tool catalogue contained an invalid entry.",
        },
      };
    }
    seen.add(entry.name);
  }
  return {
    data: [...value].sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.name.localeCompare(right.name),
    ),
  };
}

function useCatalogClipboard(): {
  active: boolean;
  copyingName: string | null;
  copyToolName: (name: string) => void;
} {
  const [copyingName, setCopyingName] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const operation = useSingleFlightOperation();
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const copyToolName = (name: string): void => {
    const request = operation.run(async () => {
      setCopyingName(name);
      return writeClipboardText(name, {
        contentClass: "public",
        label: "MCP tool identifier",
      });
    });
    if (!request) return;
    void request
      .then((result) => {
        if (!mountedRef.current) return;
        if (result.ok) toast.success("Tool identifier copied");
        else toast.error(result.message);
      })
      .catch(() => {
        if (mountedRef.current) {
          toast.error(
            "The tool identifier could not be copied. Focus Moosewave and retry.",
          );
        }
      })
      .finally(() => {
        if (mountedRef.current) setCopyingName(null);
      });
  };
  return { active: operation.active, copyingName, copyToolName };
}

export function McpToolCatalog({
  identityScope,
}: {
  identityScope: string;
}): ReactElement {
  const route = useDesktopRoute();
  const routeView = useMemo(() => catalogueRouteView(route), [route]);
  const search = routeView.search;
  const activeCategory = routeView.category;
  const [visibleLimit, setVisibleLimit] = useState(CATALOGUE_PAGE_SIZE);
  const searchId = useId();
  const resultsId = useId();
  const refreshStatusId = useId();
  const copyStatusId = useId();
  const categoryIdBase = useId();
  const catalogue = useRemoteResource<MCPCatalogEntry[]>(
    async () => {
      const response = await api.getMCPCatalog();
      if (response.error) return { error: response.error };
      return verifiedCatalog(response.data);
    },
    { identity: "mcp-tool-catalogue:" + identityScope },
  );
  const refreshOperation = useSingleFlightOperation();
  const clipboard = useCatalogClipboard();

  const previousIdentityScope = useRef(identityScope);
  useEffect(() => {
    if (previousIdentityScope.current === identityScope) return;
    previousIdentityScope.current = identityScope;
    navigateDesktopRoute(routeWithCatalogueView(route, "", ""), {
      replace: true,
      source: "identity",
    });
  }, [identityScope, route]);

  useEffect(() => {
    setVisibleLimit(CATALOGUE_PAGE_SIZE);
  }, [activeCategory, search]);

  const categories = useMemo(
    () =>
      catalogue.data
        ? Array.from(new Set(catalogue.data.map((tool) => tool.category))).sort(
            (left, right) => left.localeCompare(right),
          )
        : [],
    [catalogue.data],
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tool of catalogue.data ?? []) {
      counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
    }
    return counts;
  }, [catalogue.data]);

  useEffect(() => {
    const categoryInvalid =
      Boolean(activeCategory) &&
      catalogue.data !== null &&
      !categories.includes(activeCategory);
    if (!routeView.needsNormalization && !categoryInvalid) return;
    navigateDesktopRoute(
      routeWithCatalogueView(
        route,
        search,
        categoryInvalid ? "" : activeCategory,
      ),
      { replace: true, source: "navigation" },
    );
  }, [
    activeCategory,
    catalogue.data,
    categories,
    route,
    routeView.needsNormalization,
    search,
  ]);

  const matches = useMemo(() => {
    if (!catalogue.data) return [];
    const query = search.trim().toLocaleLowerCase();
    return catalogue.data.filter(
      (tool) =>
        (!activeCategory || tool.category === activeCategory) &&
        (!query ||
          [tool.name, tool.description, tool.category].some((value) =>
            value.toLocaleLowerCase().includes(query),
          )),
    );
  }, [activeCategory, catalogue.data, search]);

  const grouped = useMemo(() => {
    const categories = new Map<string, MCPCatalogEntry[]>();
    for (const tool of matches.slice(0, visibleLimit)) {
      categories.set(tool.category, [
        ...(categories.get(tool.category) ?? []),
        tool,
      ]);
    }
    return Array.from(categories.entries());
  }, [matches, visibleLimit]);
  const visibleCount = grouped.reduce(
    (count, [, tools]) => count + tools.length,
    0,
  );

  const retry = (): void => {
    const request = refreshOperation.run(catalogue.reload);
    if (request) void request;
  };

  if (isInitialRemoteLoad(catalogue)) {
    return (
      <div className="mcp-section" role="status">
        Loading and validating the MCP candidate catalogue…
      </div>
    );
  }

  if (!catalogue.data) {
    return (
      <Notice
        tone="danger"
        title={
          catalogue.access === "denied"
            ? "Catalogue access denied"
            : "Catalogue unavailable"
        }
        action={
          <button
            type="button"
            className="btn ghost"
            aria-disabled={refreshOperation.active || undefined}
            aria-describedby={refreshStatusId}
            onClick={() => {
              if (!refreshOperation.active) retry();
            }}
          >
            {refreshOperation.active ? "Retrying…" : "Retry"}
          </button>
        }
      >
        <p>
          {mcpFailureMessage(
            catalogue.failure,
            "The candidate catalogue response could not be validated.",
          )}
        </p>
        <p id={refreshStatusId} className="muted small" aria-live="polite">
          {refreshOperation.active
            ? "One catalogue request is already in progress."
            : "Retry requests and validates a new candidate response from the server."}
        </p>
      </Notice>
    );
  }

  return (
    <div className="mcp-section">
      <header className="mcp-section-intro">
        <div>
          <span className="mcp-kicker">Server-bundled candidate surface</span>
          <h2>Explore the response-validated candidate catalogue</h2>
          <p>
            Search identifiers embedded in this server build. Catalogue presence
            describes source-tree discovery only; it does not prove the
            published npm artifact exposes the same tools, or establish
            workspace authorization, approval enforcement, or execution.
          </p>
        </div>
        <div className="mcp-section-stat" aria-label="Catalogue size">
          <strong>{catalogue.data.length.toLocaleString()}</strong>
          <span>server-bundled candidates</span>
        </div>
      </header>
      <div className="mcp-resource-toolbar">
        <p
          id={refreshStatusId}
          className="muted small"
          role="status"
          aria-live="polite"
        >
          {refreshOperation.active
            ? "Refreshing the catalogue; the last valid response remains visible."
            : catalogue.lastVerifiedAt
              ? "Catalogue response validated " +
                formatMcpRelativeTime(
                  new Date(catalogue.lastVerifiedAt).toISOString(),
                ) +
                " · " +
                formatMcpAbsoluteTime(
                  new Date(catalogue.lastVerifiedAt).toISOString(),
                ) +
                "."
              : "Catalogue verification time is unavailable."}
        </p>
        <button
          type="button"
          className="btn ghost"
          aria-disabled={refreshOperation.active || undefined}
          aria-describedby={refreshStatusId}
          onClick={() => {
            if (!refreshOperation.active) retry();
          }}
        >
          {refreshOperation.active
            ? "Refreshing catalogue…"
            : "Refresh catalogue"}
        </button>
      </div>
      {catalogue.stale ? (
        <Notice
          tone="warning"
          title="Showing the last response-validated candidate catalogue"
          action={
            <button
              type="button"
              className="btn ghost"
              aria-disabled={refreshOperation.active || undefined}
              aria-describedby={refreshStatusId}
              onClick={() => {
                if (!refreshOperation.active) retry();
              }}
            >
              {refreshOperation.active ? "Retrying…" : "Retry"}
            </button>
          }
        >
          {mcpFailureMessage(
            catalogue.failure,
            "The latest catalogue refresh failed.",
          )}
        </Notice>
      ) : null}

      <Notice tone="warning" title="Installed-client parity is not qualified">
        The public npm artifact and this server-bundled candidate response can
        differ. Treat these rows as build evidence, not as a promise that an
        installed client can discover or execute each identifier.
      </Notice>

      {categories.length > 0 ? (
        <div
          className="mcp-category-filter"
          role="group"
          aria-label="Filter tools by category"
        >
          <button
            type="button"
            className={!activeCategory ? "active" : ""}
            aria-pressed={!activeCategory}
            onClick={() => {
              navigateDesktopRoute(routeWithCatalogueView(route, search, ""));
            }}
          >
            All <span>{catalogue.data.length}</span>
          </button>
          {categories.map((category) => {
            const count = categoryCounts.get(category) ?? 0;
            return (
              <button
                key={category}
                type="button"
                className={activeCategory === category ? "active" : ""}
                aria-pressed={activeCategory === category}
                onClick={() => {
                  navigateDesktopRoute(
                    routeWithCatalogueView(
                      route,
                      search,
                      activeCategory === category ? "" : category,
                    ),
                  );
                }}
              >
                {category} <span>{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mcp-search-field">
        <label htmlFor={searchId}>Search tools</label>
        <div className="mcp-search-control">
          <input
            id={searchId}
            type="search"
            placeholder="Name, category, or description"
            className="mcp-search"
            value={search}
            maxLength={MAX_CATALOGUE_SEARCH_CHARS}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={resultsId}
            onChange={(event) => {
              navigateDesktopRoute(
                routeWithCatalogueView(
                  route,
                  event.target.value.slice(0, MAX_CATALOGUE_SEARCH_CHARS),
                  activeCategory,
                ),
                { replace: true, source: "navigation" },
              );
            }}
          />
          {search ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                navigateDesktopRoute(
                  routeWithCatalogueView(route, "", activeCategory),
                );
              }}
            >
              Clear search
            </button>
          ) : null}
        </div>
      </div>
      <p id={resultsId} className="muted small" aria-live="polite">
        {search || activeCategory
          ? String(matches.length) +
            " of " +
            String(catalogue.data.length) +
            " tools match the active filters."
          : String(catalogue.data.length) +
            " tools across " +
            String(categories.length) +
            " categories."}{" "}
        Names below are exact identifiers in this candidate response.
      </p>
      <p id={copyStatusId} className="muted small" aria-live="polite">
        {clipboard.active
          ? "One tool identifier is being written to the clipboard; wait before copying another."
          : "Copy name writes only the exact candidate identifier; it conveys no authorization or safety metadata."}
      </p>

      {catalogue.data.length === 0 ? (
        <Notice tone="neutral" title="Validated candidate catalogue is empty">
          The server returned no candidate identifiers. Artifact parity and
          transport governance still require independent qualification.
        </Notice>
      ) : grouped.length === 0 ? (
        <div className="mcp-empty" role="status">
          <h3>No tools match these filters</h3>
          <p>Try a shorter identifier or remove the selected category.</p>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              navigateDesktopRoute(routeWithCatalogueView(route, "", ""));
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="mcp-tools-list">
          {grouped.map(([category, tools], categoryIndex) => {
            const categoryId =
              categoryIdBase + "-category-" + String(categoryIndex);
            return (
              <section key={category} aria-labelledby={categoryId}>
                <h3 id={categoryId} className="mcp-category-title">
                  {category} <span className="muted">({tools.length})</span>
                </h3>
                <ul>
                  {tools.map((tool) => {
                    const copyBusy = clipboard.copyingName === tool.name;
                    const copyUnavailable = clipboard.active && !copyBusy;
                    return (
                      <Card
                        key={tool.name}
                        as="li"
                        variant="subtle"
                        padding="sm"
                        className="mcp-tool-row"
                      >
                        <div>
                          <span className="mcp-field-label">
                            Tool identifier
                          </span>
                          <code className="mcp-tool-name">{tool.name}</code>
                        </div>
                        <p className="mcp-tool-desc">{tool.description}</p>
                        <button
                          type="button"
                          className="btn ghost small"
                          aria-disabled={clipboard.active || undefined}
                          aria-describedby={copyStatusId}
                          aria-label={"Copy tool identifier " + tool.name}
                          onClick={() => {
                            if (!clipboard.active)
                              clipboard.copyToolName(tool.name);
                          }}
                        >
                          {copyBusy
                            ? "Copying…"
                            : copyUnavailable
                              ? "Copy busy"
                              : "Copy name"}
                        </button>
                      </Card>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {visibleCount < matches.length ? (
            <div className="mcp-catalogue-more">
              <p className="muted small">
                Showing {visibleCount.toLocaleString()} of{" "}
                {matches.length.toLocaleString()} matching identifiers.
              </p>
              <button
                type="button"
                className="btn ghost"
                onClick={() =>
                  setVisibleLimit((current) =>
                    Math.min(matches.length, current + CATALOGUE_PAGE_SIZE),
                  )
                }
              >
                Show{" "}
                {Math.min(CATALOGUE_PAGE_SIZE, matches.length - visibleCount)}{" "}
                more
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
