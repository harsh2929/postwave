/** Browsable, verified catalog of fields available to segment rules. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { hasVerifiedRemoteData } from "../../lib/remote-resource";
import { RemoteDataNotice } from "../RemoteDataNotice";
import {
  type PredicateDefinition,
  type PredicateRegistry,
  segmentsClient,
} from "./segmentsClient";
import { comparatorsFor } from "./visual-segment-ast";

import "../../styles-predicate-catalog.css";

function isSupported(status: string | undefined): boolean {
  return (status ?? "").toLowerCase() === "supported";
}

function byCategory(
  predicates: PredicateDefinition[],
): Array<{ category: string; items: PredicateDefinition[] }> {
  const order: string[] = [];
  const map = new Map<string, PredicateDefinition[]>();
  for (const predicate of predicates) {
    const category = predicate.category || "other";
    if (!map.has(category)) {
      map.set(category, []);
      order.push(category);
    }
    map.get(category)?.push(predicate);
  }
  return order.map((category) => ({
    category,
    items: map.get(category) ?? [],
  }));
}

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  return fields.some((field) =>
    (field ?? "").toLocaleLowerCase().includes(needle),
  );
}

async function loadRegistry() {
  const result = await segmentsClient.registry();
  if (result.error) return { error: result.error };
  if (!result.data || !Array.isArray(result.data.predicates)) {
    return {
      error: {
        kind: "parse" as const,
        code: "invalid_predicate_registry",
      },
    };
  }
  return { data: result.data };
}

export function PredicateRegistryCatalog(): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const panelId = useId();
  const searchId = useId();
  const resultsId = useId();
  const resource = useRemoteResource<PredicateRegistry>(loadRegistry, {
    identity: "predicate-registry-catalog",
    auto: false,
  });
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshPromiseRef.current) {
      await refreshPromiseRef.current;
      return;
    }
    let tracked: Promise<void>;
    tracked = resource.reload().finally(() => {
      if (refreshPromiseRef.current === tracked)
        refreshPromiseRef.current = null;
    });
    refreshPromiseRef.current = tracked;
    await tracked;
  }, [resource.reload]);

  useEffect(() => {
    if (open && resource.transport === "idle") void refresh();
  }, [open, refresh, resource.transport]);

  return (
    <section className="predicate-catalog" aria-label="Segment field catalog">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="btn btn-ghost predicate-catalog-toggle"
      >
        <span>
          <strong>What can I segment on?</strong>
          <small>
            Fields, metrics, and custom objects available to this workspace
          </small>
        </span>
        <span className="predicate-catalog-toggle-state" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open ? (
        <div id={panelId} className="predicate-catalog-panel">
          <RemoteDataNotice
            resource={resource}
            label="segment field catalog"
            onRetry={() => void refresh()}
          />
          {!hasVerifiedRemoteData(resource) ? (
            resource.transport === "loading" ||
            resource.transport === "idle" ? (
              <div
                className="predicate-catalog-state"
                role="status"
                aria-busy="true"
              >
                Loading the field catalog…
              </div>
            ) : (
              <div className="predicate-catalog-state" role="status">
                The catalog is unavailable. Retry to verify filterable fields.
              </div>
            )
          ) : (
            <CatalogContent
              registry={resource.data}
              query={query}
              searchId={searchId}
              resultsId={resultsId}
              refreshing={resource.transport === "loading"}
              onQuery={setQuery}
              onRefresh={() => void refresh()}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

function CatalogContent({
  registry,
  query,
  searchId,
  resultsId,
  refreshing,
  onQuery,
  onRefresh,
}: {
  registry: PredicateRegistry;
  query: string;
  searchId: string;
  resultsId: string;
  refreshing: boolean;
  onQuery: (value: string) => void;
  onRefresh: () => void;
}): ReactElement {
  const predicates = Array.isArray(registry.predicates)
    ? registry.predicates
    : [];
  const metrics = Array.isArray(registry.metrics) ? registry.metrics : [];
  const customObjects = Array.isArray(registry.custom_objects)
    ? registry.custom_objects
    : [];
  const booleanOps = Array.isArray(registry.boolean_ops)
    ? registry.boolean_ops
    : [];
  const warnings = Array.isArray(registry.warnings) ? registry.warnings : [];
  const normalizedQuery = query.trim();
  const groups = useMemo(
    () =>
      byCategory(
        predicates.filter(
          (p) =>
            isSupported(p.compiler_status) &&
            matches(normalizedQuery, p.label, p.key, p.category, p.help),
        ),
      ),
    [normalizedQuery, predicates],
  );
  const filteredMetrics = useMemo(
    () =>
      metrics.filter((metric) =>
        matches(
          normalizedQuery,
          metric.label,
          metric.key,
          metric.source,
          metric.event_name,
        ),
      ),
    [metrics, normalizedQuery],
  );
  const filteredObjects = useMemo(
    () =>
      customObjects.filter((object) =>
        matches(
          normalizedQuery,
          object.label,
          object.key,
          object.id,
          object.primary_key,
        ),
      ),
    [customObjects, normalizedQuery],
  );
  const predicateCount = groups.reduce(
    (total, group) => total + group.items.length,
    0,
  );
  const resultCount =
    predicateCount + filteredMetrics.length + filteredObjects.length;

  return (
    <>
      <div className="predicate-catalog-controls">
        <label htmlFor={searchId}>
          <span className="sr-only">Filter segment fields and metrics</span>
          <input
            id={searchId}
            className="input"
            type="search"
            placeholder="Filter fields, metrics, or objects…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            aria-describedby={resultsId}
          />
        </label>
        {query ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onQuery("")}
          >
            Clear filter
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm pw-discoverable-unavailable"
          onClick={() => {
            if (!refreshing) onRefresh();
          }}
          aria-disabled={refreshing || undefined}
          aria-busy={refreshing ? "true" : undefined}
          aria-describedby={resultsId}
        >
          {refreshing ? "Refreshing…" : "Refresh catalog"}
        </button>
      </div>
      <p
        id={resultsId}
        className="pw-action-status"
        role="status"
        aria-live="polite"
      >
        {resultCount.toLocaleString()} matching catalog item
        {resultCount === 1 ? "" : "s"}. Catalog{" "}
        {registry.registry_version || "version not reported"}.
      </p>

      {resultCount === 0 ? (
        <div className="predicate-catalog-state" role="status">
          Nothing matches “{normalizedQuery}”. Clear the filter to review the
          complete verified catalog.
        </div>
      ) : null}

      {groups.map((group) => (
        <PredicateGroup key={group.category} group={group} />
      ))}
      {filteredMetrics.length > 0 ? (
        <MetricCatalog metrics={filteredMetrics} />
      ) : null}
      {filteredObjects.length > 0 ? (
        <CustomObjectCatalog objects={filteredObjects} />
      ) : null}

      <footer className="predicate-catalog-footer">
        <span>
          Combine conditions with{" "}
          {booleanOps.length > 0
            ? booleanOps.map((operation) => operation.toUpperCase()).join(" / ")
            : "AND / OR / NOT"}
          .
        </span>
        {warnings.length > 0 ? (
          <span>
            The registry reported {warnings.length.toLocaleString()}{" "}
            availability warning{warnings.length === 1 ? "" : "s"}; unsupported
            fields are omitted from this catalog.
          </span>
        ) : null}
      </footer>
    </>
  );
}

function PredicateGroup({
  group,
}: {
  group: { category: string; items: PredicateDefinition[] };
}): ReactElement {
  return (
    <section className="predicate-catalog-section" aria-label={group.category}>
      <h4>{group.category}</h4>
      <ul>
        {group.items.map((predicate) => {
          const comparators = comparatorsFor(predicate);
          return (
            <li key={predicate.key}>
              <div className="predicate-catalog-item-heading">
                <strong>{predicate.label || predicate.key}</strong>
                <code>{predicate.key}</code>
                <span className="badge">{predicate.value_type}</span>
              </div>
              <dl>
                <div>
                  <dt>Comparisons</dt>
                  <dd>
                    {comparators.length > 0
                      ? comparators
                          .map((comparator) => comparator.replaceAll("_", " "))
                          .join(" · ")
                      : "No compiler-valid comparisons reported"}
                  </dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    {predicate.source || "Not reported"}
                    {predicate.source_ref ? ` · ${predicate.source_ref}` : ""}
                  </dd>
                </div>
              </dl>
              {predicate.help ? <p>{predicate.help}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MetricCatalog({
  metrics,
}: {
  metrics: PredicateRegistry["metrics"];
}): ReactElement {
  return (
    <section className="predicate-catalog-section" aria-label="Event metrics">
      <h4>Event metrics</h4>
      <ul>
        {metrics.map((metric) => (
          <li key={metric.key}>
            <div className="predicate-catalog-item-heading">
              <strong>{metric.label || metric.key}</strong>
              <code>{metric.key}</code>
              <span className="badge">{metric.aggregation}</span>
            </div>
            <dl>
              <div>
                <dt>Source</dt>
                <dd>{metric.source || "Not reported"}</dd>
              </div>
              <div>
                <dt>Event</dt>
                <dd>{metric.event_name || "Any matching event"}</dd>
              </div>
              <div>
                <dt>Events recorded</dt>
                <dd>
                  {typeof metric.total === "number"
                    ? metric.total.toLocaleString()
                    : "Not reported"}
                </dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>
                  {metric.last_seen_at ? (
                    <time dateTime={metric.last_seen_at}>
                      {formatCatalogTime(metric.last_seen_at)}
                    </time>
                  ) : (
                    "Not reported"
                  )}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CustomObjectCatalog({
  objects,
}: {
  objects: PredicateRegistry["custom_objects"];
}): ReactElement {
  return (
    <section className="predicate-catalog-section" aria-label="Custom objects">
      <h4>Custom objects</h4>
      <ul>
        {objects.map((object) => (
          <li key={object.id || object.key}>
            <div className="predicate-catalog-item-heading">
              <strong>{object.label || object.key}</strong>
              <code>{object.key}</code>
              <span className="badge">{object.status}</span>
            </div>
            <dl>
              <div>
                <dt>Object ID</dt>
                <dd>{object.id}</dd>
              </div>
              <div>
                <dt>Primary key</dt>
                <dd>{object.primary_key}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>
                  <time dateTime={object.updated_at}>
                    {formatCatalogTime(object.updated_at)}
                  </time>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatCatalogTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
