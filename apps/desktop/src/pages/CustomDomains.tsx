/**
 * Branded domains — legacy DNS-ownership registry.
 *
 * Important truth boundary: a row proves only that Moosewave registered a
 * hostname and (when current) found its ownership records. It is not evidence
 * that TLS has been issued or that product traffic is routed through it.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CustomDomainSlideover } from "../components/CustomDomainSlideover";
import {
  type CustomDomainFilter,
  type CustomDomainSort,
  customDomainPurposeLabel,
  filterAndSortCustomDomains,
  inventoryForCustomDomains,
  parseCustomDomainList,
} from "../components/domains/custom-domain-contract";
import { PageHeader } from "../components/PageHeader";
import type { CustomDomain } from "../lib/api-client";
import { api } from "../lib/api-client";
import { fmtDate, fmtDateTime } from "../lib/format-date";
import "../styles-custom-domains.css";
import "../styles-custom-domains-detail.css";

type LoadFailure = "request" | "contract" | null;

const FILTERS: Array<{
  value: CustomDomainFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "verified", label: "Last check passed" },
  { value: "pending", label: "Needs DNS" },
];

const SORTS: Array<{ value: CustomDomainSort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "domain", label: "Hostname A–Z" },
  { value: "status", label: "Needs action first" },
];

function SearchGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="8.5" cy="8.5" r="5.25" />
      <path d="m12.4 12.4 4.1 4.1" />
    </svg>
  );
}

function ArrowGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}

function ShieldGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3 20 6v5.6c0 4.6-3.2 7.8-8 9.4-4.8-1.6-8-4.8-8-9.4V6l8-3Z" />
      <path d="m8.6 12 2.1 2.1 4.8-5" />
    </svg>
  );
}

function filterCount(
  filter: CustomDomainFilter,
  inventory: ReturnType<typeof inventoryForCustomDomains>,
): number {
  if (filter === "verified") return inventory.verified;
  if (filter === "pending") return inventory.pending;
  return inventory.total;
}

function DomainStatus({ domain }: { domain: CustomDomain }): ReactElement {
  return domain.verified ? (
    <span className="cd-status cd-status-verified">
      <span className="cd-status-dot" aria-hidden="true" />
      Last check passed
    </span>
  ) : (
    <span className="cd-status cd-status-pending">
      <span className="cd-status-dot" aria-hidden="true" />
      Needs DNS
    </span>
  );
}

function RegistryLoading(): ReactElement {
  return (
    <section
      className="cd-state-surface cd-loading-surface"
      aria-label="Loading registered domains"
      aria-busy="true"
    >
      <div className="cd-loading-heading">
        <span className="cd-skeleton cd-skeleton-title" />
        <span className="cd-skeleton cd-skeleton-copy" />
      </div>
      <div className="cd-loading-rows" aria-hidden="true">
        {[0, 1, 2, 3].map((row) => (
          <div className="cd-loading-row" key={row}>
            <span className="cd-skeleton cd-skeleton-domain" />
            <span className="cd-skeleton cd-skeleton-pill" />
            <span className="cd-skeleton cd-skeleton-cell" />
            <span className="cd-skeleton cd-skeleton-cell" />
          </div>
        ))}
      </div>
      <span className="visually-hidden">Loading registered domains…</span>
    </section>
  );
}

function ReadinessFlow({
  total,
  verified,
}: {
  total: number | null;
  verified: number | null;
}): ReactElement {
  const ownershipLabel =
    total === null || verified === null
      ? "Awaiting a trusted snapshot"
      : total === 0
        ? "No registrations"
        : verified === total
          ? "Latest check passed for every row"
          : `${verified.toLocaleString()} of ${total.toLocaleString()} latest checks passed`;
  return (
    <div className="cd-readiness" aria-label="Hostname readiness boundary">
      <div className="cd-readiness-head">
        <span>Readiness boundary</span>
        <span className="cd-readiness-live">
          <span aria-hidden="true" /> Registry signal
        </span>
      </div>
      <ol className="cd-readiness-flow">
        <li className={total === null ? "is-waiting" : "is-observed"}>
          <span className="cd-stage-index">01</span>
          <span className="cd-stage-copy">
            <strong>Registered</strong>
            <small>
              {total === null
                ? "Snapshot unavailable"
                : `${total.toLocaleString()} stored`}
            </small>
          </span>
        </li>
        <li
          className={
            verified !== null && verified > 0 ? "is-observed" : "is-waiting"
          }
        >
          <span className="cd-stage-index">02</span>
          <span className="cd-stage-copy">
            <strong>DNS ownership</strong>
            <small>{ownershipLabel}</small>
          </span>
        </li>
        <li className="is-blocked">
          <span className="cd-stage-index">03</span>
          <span className="cd-stage-copy">
            <strong>TLS issued</strong>
            <small>Not connected</small>
          </span>
        </li>
        <li className="is-blocked">
          <span className="cd-stage-index">04</span>
          <span className="cd-stage-copy">
            <strong>Traffic routed</strong>
            <small>Not connected</small>
          </span>
        </li>
      </ol>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "neutral" | "success" | "warning" | "unknown";
}): ReactElement {
  return (
    <div className={`cd-metric is-${tone}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <dd className="cd-metric-detail">{detail}</dd>
    </div>
  );
}

export function CustomDomains(): ReactElement {
  const [rows, setRows] = useState<CustomDomain[] | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailure, setLoadFailure] = useState<LoadFailure>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CustomDomainFilter>("all");
  const [sort, setSort] = useState<CustomDomainSort>("newest");
  const [selected, setSelected] = useState<CustomDomain | null>(null);
  const requestGenerationRef = useRef(0);
  const selectedOpenerRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    const generation = ++requestGenerationRef.current;
    if (mode === "initial") setInitialLoading(true);
    else setRefreshing(true);
    setLoadFailure(null);
    try {
      const response = await api.listCustomDomains();
      if (generation !== requestGenerationRef.current) return;
      if (response.error) {
        setLoadFailure("request");
        return;
      }
      const parsed = parseCustomDomainList(response.data);
      if (!parsed) {
        setLoadFailure("contract");
        return;
      }
      setRows(parsed);
      setSelected((current) =>
        current ? (parsed.find((row) => row.id === current.id) ?? null) : null,
      );
      setLastSyncedAt(Date.now());
    } catch {
      if (generation === requestGenerationRef.current) {
        setLoadFailure("request");
      }
    } finally {
      if (generation === requestGenerationRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load("initial");
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [load]);

  const inventory = useMemo(
    () => inventoryForCustomDomains(rows ?? []),
    [rows],
  );
  const visibleRows = useMemo(
    () => filterAndSortCustomDomains(rows ?? [], query, filter, sort),
    [filter, query, rows, sort],
  );
  const hasActiveQuery = query.trim().length > 0 || filter !== "all";

  const openDomain = (
    domain: CustomDomain,
    opener: HTMLButtonElement,
  ): void => {
    selectedOpenerRef.current = opener;
    setSelected(domain);
  };

  return (
    <main className="custom-domains-route">
      <PageHeader
        eyebrow="Infrastructure"
        title="Branded domains"
        subtitle="Inspect legacy hostname registrations and their latest persisted DNS ownership results. TLS and traffic routing are intentionally reported as separate, unqualified capabilities."
        actions={[
          {
            label: refreshing ? "Refreshing…" : "Refresh registry",
            onClick: () => void load("refresh"),
            variant: "ghost",
            disabled: initialLoading || refreshing,
            ...(refreshing
              ? { title: "A registry refresh is already in progress." }
              : {}),
          },
          {
            label: "Register hostname",
            onClick: () => undefined,
            variant: "primary",
            disabled: true,
            title:
              "Registration is held until automated TLS issuance, dependency inventory, and a production traffic-routing path are qualified.",
          },
        ]}
      />

      <section className="cd-hero" aria-labelledby="cd-hero-title">
        <div className="cd-hero-copy">
          <div className="cd-kicker">
            <span className="cd-kicker-icon">
              <ShieldGlyph />
            </span>
            Ownership registry
            <span className="cd-kicker-separator" aria-hidden="true" />
            Evidence, not activation
          </div>
          <h2 id="cd-hero-title">
            Know what is proven.
            <span>Know what is not live.</span>
          </h2>
          <p>
            A successful DNS check confirms control of a hostname. It does not
            mean Moosewave has a certificate for it or serves product traffic
            through it. This workspace keeps those boundaries visible.
          </p>
          <div className="cd-hero-note">
            <span className="cd-hero-note-mark" aria-hidden="true">
              i
            </span>
            <span>
              Sending-domain authentication remains in Deliverability and is not
              inferred from these registrations.
            </span>
          </div>
        </div>
        <ReadinessFlow
          total={rows ? inventory.total : null}
          verified={rows ? inventory.verified : null}
        />
        <div className="cd-hero-orbit" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>

      {rows ? (
        <dl className="cd-metrics" aria-label="Domain registry summary">
          <Metric
            label="Registered"
            value={inventory.total.toLocaleString()}
            detail="Legacy hostname rows"
            tone="neutral"
          />
          <Metric
            label="Latest check passed"
            value={inventory.verified.toLocaleString()}
            detail="Persisted explicit DNS results"
            tone="success"
          />
          <Metric
            label="Needs DNS"
            value={inventory.pending.toLocaleString()}
            detail="No successful result persisted"
            tone={inventory.pending > 0 ? "warning" : "neutral"}
          />
          <Metric
            label="Traffic-ready"
            value="Not measured"
            detail="TLS and routing unavailable"
            tone="unknown"
          />
        </dl>
      ) : null}

      {loadFailure && rows ? (
        <div className="cd-inline-alert" role="alert">
          <span className="cd-alert-mark" aria-hidden="true">
            !
          </span>
          <div>
            <strong>Registry refresh did not complete.</strong>
            <span>
              Showing the last successful snapshot
              {lastSyncedAt
                ? ` from ${fmtDateTime(new Date(lastSyncedAt).toISOString())}`
                : ""}
              .
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load("refresh")}
            disabled={refreshing}
          >
            Try again
          </button>
        </div>
      ) : null}

      {initialLoading && rows === null ? <RegistryLoading /> : null}

      {!initialLoading && rows === null && loadFailure ? (
        <section className="cd-state-surface cd-error-surface" role="alert">
          <div className="cd-state-icon is-error" aria-hidden="true">
            !
          </div>
          <div>
            <p className="cd-state-eyebrow">Registry unavailable</p>
            <h2>
              {loadFailure === "contract"
                ? "This response cannot be displayed safely."
                : "The domain registry could not be reached."}
            </h2>
            <p>
              {loadFailure === "contract"
                ? "Moosewave rejected an unexpected server payload instead of guessing at domain state. Update the API and desktop to a compatible version before continuing."
                : "No zero counts or empty state are being inferred. Check the connection, then retry the read-only request."}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void load("initial")}
          >
            Retry registry
          </button>
        </section>
      ) : null}

      {rows ? (
        <section className="cd-registry" aria-labelledby="cd-registry-title">
          <div className="cd-section-head">
            <div>
              <p className="cd-section-eyebrow">Workspace inventory</p>
              <h2 id="cd-registry-title">Registered hostnames</h2>
              <p>
                Review the records Moosewave expects and run an explicit DNS
                ownership check from each hostname’s detail panel.
              </p>
            </div>
            <div className="cd-snapshot" aria-live="polite">
              <span className="cd-snapshot-dot" aria-hidden="true" />
              {refreshing
                ? "Refreshing registry…"
                : lastSyncedAt
                  ? `Synced ${fmtDateTime(new Date(lastSyncedAt).toISOString())}`
                  : "Snapshot not synced"}
            </div>
          </div>

          <div className="cd-toolbar">
            <label className="cd-search">
              <span className="visually-hidden">Search registered domains</span>
              <SearchGlyph />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search hostname or registration intent"
                autoComplete="off"
                spellCheck={false}
              />
              {query ? (
                <button
                  type="button"
                  className="cd-search-clear"
                  onClick={() => setQuery("")}
                  aria-label="Clear domain search"
                >
                  Clear
                </button>
              ) : null}
            </label>
            <div
              className="cd-filter-group"
              role="group"
              aria-label="Filter domains by ownership status"
            >
              {FILTERS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={filter === item.value ? "is-active" : undefined}
                  aria-pressed={filter === item.value}
                  onClick={() => setFilter(item.value)}
                >
                  <span>{item.label}</span>
                  <strong>{filterCount(item.value, inventory)}</strong>
                </button>
              ))}
            </div>
            <label className="cd-sort">
              <span>Sort</span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as CustomDomainSort)
                }
              >
                {SORTS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="visually-hidden" role="status" aria-live="polite">
            Showing {visibleRows.length.toLocaleString()} of{" "}
            {inventory.total.toLocaleString()} registered domains.
          </p>

          {inventory.total === 0 ? (
            <div className="cd-empty-state">
              <div className="cd-state-icon" aria-hidden="true">
                <ShieldGlyph />
              </div>
              <p className="cd-state-eyebrow">No legacy registrations</p>
              <h3>The ownership registry is empty.</h3>
              <p>
                New hostname intake is intentionally held while certificate
                issuance, dependency checks, and production routing are being
                qualified. Nothing is missing from this snapshot.
              </p>
              <span className="cd-empty-boundary">
                Registration unavailable · Existing sending domains are managed
                in Deliverability
              </span>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="cd-empty-state is-compact">
              <div className="cd-state-icon" aria-hidden="true">
                <SearchGlyph />
              </div>
              <p className="cd-state-eyebrow">No matching hostnames</p>
              <h3>Broaden the registry view.</h3>
              <p>
                No domain matches this search and ownership filter. The
                underlying registry has {inventory.total.toLocaleString()} row
                {inventory.total === 1 ? "" : "s"}.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="cd-table-shell">
              <table className="cd-table">
                <caption className="visually-hidden">
                  Registered custom hostnames and DNS ownership evidence
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Hostname</th>
                    <th scope="col">Ownership</th>
                    <th scope="col">Registration intent</th>
                    <th scope="col">Evidence</th>
                    <th scope="col">Added</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((domain) => {
                    const recordCount = domain.dns_records.length;
                    return (
                      <tr key={domain.id}>
                        <th scope="row" data-label="Hostname">
                          <span className="cd-domain-cell">
                            <span
                              className="cd-domain-monogram"
                              aria-hidden="true"
                            >
                              {domain.domain.slice(0, 1).toUpperCase()}
                            </span>
                            <span>
                              <code title={domain.domain}>{domain.domain}</code>
                              <small>Legacy hostname registration</small>
                            </span>
                          </span>
                        </th>
                        <td data-label="Ownership">
                          <DomainStatus domain={domain} />
                        </td>
                        <td data-label="Registration intent">
                          <span className="cd-purpose">
                            {customDomainPurposeLabel(domain.purpose)}
                          </span>
                        </td>
                        <td data-label="Evidence">
                          <span className="cd-evidence">
                            <strong>
                              {recordCount.toLocaleString()} DNS record
                              {recordCount === 1 ? "" : "s"}
                            </strong>
                            <small>
                              {domain.verified
                                ? domain.verifiedAt
                                  ? `Accepted ${fmtDateTime(domain.verifiedAt)}`
                                  : "Successful check; time unavailable"
                                : "No successful check recorded"}
                            </small>
                          </span>
                        </td>
                        <td data-label="Added">
                          <time
                            className="cd-added tabular"
                            dateTime={domain.createdAt}
                          >
                            {fmtDate(domain.createdAt)}
                          </time>
                        </td>
                        <td className="cd-row-action">
                          <button
                            type="button"
                            className="cd-open-domain"
                            onClick={(event) =>
                              openDomain(domain, event.currentTarget)
                            }
                            aria-label={`Open DNS ownership details for ${domain.domain}`}
                          >
                            <span>View setup</span>
                            <ArrowGlyph />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {hasActiveQuery && visibleRows.length > 0 ? (
            <div className="cd-results-note">
              Showing {visibleRows.length.toLocaleString()} matching hostname
              {visibleRows.length === 1 ? "" : "s"} from a registry of{" "}
              {inventory.total.toLocaleString()}.
            </div>
          ) : null}
        </section>
      ) : null}

      {selected ? (
        <CustomDomainSlideover
          domain={selected}
          returnFocusRef={selectedOpenerRef}
          onClose={() => setSelected(null)}
          onChange={(updated) => {
            if (!updated) {
              setSelected(null);
              return;
            }
            setSelected(updated);
            setRows(
              (current) =>
                current?.map((row) =>
                  row.id === updated.id ? updated : row,
                ) ?? null,
            );
          }}
        />
      ) : null}
    </main>
  );
}
