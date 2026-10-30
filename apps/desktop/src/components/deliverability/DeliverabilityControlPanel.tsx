import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { deliverabilityControlApi } from "../../lib/api-client";
import type { DomainSetup } from "../../lib/api/deliverability-control";
import { setSection, useMe, type Section } from "../../lib/store";
import { Icon } from "../Icon";
import {
  parseClickTrackingPolicy,
  parseDomainSetups,
  parseEntitlement,
  parseRoutingPolicy,
} from "./sending-control-response-contract";

interface ControlState<T> {
  data: T | null;
  loading: boolean;
  failed: boolean;
  verifiedAt: Date | null;
}

interface ControlSection<T> extends ControlState<T> {
  refresh: () => Promise<void>;
}

const NUM = new Intl.NumberFormat();

const fetchDomains = () => deliverabilityControlApi.listDomainSetups();
const fetchClickTracking = () => deliverabilityControlApi.getClickTracking();
const fetchRouting = () => deliverabilityControlApi.getRoutingPolicy();
const fetchEntitlement = () => deliverabilityControlApi.getEntitlement();

export function DeliverabilityControlPanel(): ReactElement {
  const tenant = useMe()?.tenant ?? "unresolved";
  const domains = useControlSection(fetchDomains, parseDomainSetups, tenant);
  const clickTracking = useControlSection(
    fetchClickTracking,
    parseClickTrackingPolicy,
    tenant,
  );
  const routing = useControlSection(fetchRouting, parseRoutingPolicy, tenant);
  const entitlement = useControlSection(
    fetchEntitlement,
    parseEntitlement,
    tenant,
  );
  const refreshing =
    domains.loading ||
    clickTracking.loading ||
    routing.loading ||
    entitlement.loading;

  const refreshAll = (): void => {
    void Promise.all([
      domains.refresh(),
      clickTracking.refresh(),
      routing.refresh(),
      entitlement.refresh(),
    ]);
  };

  return (
    <section
      className="dhw-control-center"
      aria-labelledby="dhw-control-center-title"
    >
      <header>
        <div>
          <small>Authoritative configuration snapshots</small>
          <h3 id="dhw-control-center-title">Deliverability controls</h3>
          <p>
            Read-only evidence from four independent services. Changes stay in
            their canonical workspaces to prevent conflicting configuration.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={refreshAll}
          disabled={refreshing}
        >
          {refreshing ? "Rechecking…" : "Recheck all"}
        </button>
      </header>

      <div className="dhw-control-grid">
        <ControlCard
          title="Sending domains"
          description="Verification, TLS, and routing state"
          section={domains}
          owner="domains"
          ownerLabel="Open Domains"
        >
          {(setups) => <DomainEvidence setups={setups} />}
        </ControlCard>

        <ControlCard
          title="Click tracking"
          description="Tracking-domain and certificate state"
          section={clickTracking}
          owner="track"
          ownerLabel="Open Tracking"
        >
          {(policy) => (
            <EvidenceRows
              rows={[
                ["Tracking domain", policy.tracking_domain || "Not configured"],
                ["Policy status", policy.status || "Unknown"],
                ["TLS status", policy.ssl_status || "Unknown"],
              ]}
            />
          )}
        </ControlCard>

        <ControlCard
          title="IP routing"
          description="Shared and dedicated-pool allocation"
          section={routing}
          owner="sending"
          ownerLabel="Open Sending"
        >
          {(policy) => (
            <EvidenceRows
              rows={[
                ["Strategy", policy.strategy || "Unknown"],
                ["Policy status", policy.status || "Unknown"],
                [
                  "Dedicated share",
                  pct(
                    policy.effective_dedicated_percent,
                    policy.dedicated_percentage_bp,
                  ),
                ],
                ["Shared share", pct(policy.effective_shared_percent)],
              ]}
            />
          )}
        </ControlCard>

        <ControlCard
          title="Inbox-test allowance"
          description="Current metered plan period"
          section={entitlement}
          owner="settings"
          ownerLabel="Open Settings"
        >
          {(value) => (
            <EvidenceRows
              rows={[
                ["Plan", value.plan_tier || "Unknown"],
                ["Period", value.period_start || "Unknown"],
                ["Inbox tests used", NUM.format(value.inbox_tests_used)],
                [
                  "Inbox tests remaining",
                  NUM.format(value.inbox_tests_remaining),
                ],
                [
                  "Render previews remaining",
                  NUM.format(value.render_previews_remaining),
                ],
              ]}
            />
          )}
        </ControlCard>
      </div>
    </section>
  );
}

function useControlSection<T>(
  fetcher: () => Promise<{ data?: unknown; error?: unknown }>,
  parser: (value: unknown) => T | null,
  tenant: string,
): ControlSection<T> {
  const [state, setState] = useState<ControlState<T>>({
    data: null,
    loading: true,
    failed: false,
    verifiedAt: null,
  });
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    setState((current) => ({ ...current, loading: true, failed: false }));
    try {
      const result = await fetcher();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const parsed = result.error ? null : parser(result.data);
      if (parsed) {
        setState({
          data: parsed,
          loading: false,
          failed: false,
          verifiedAt: new Date(),
        });
      } else {
        setState((current) => ({
          ...current,
          loading: false,
          failed: true,
        }));
      }
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setState((current) => ({
          ...current,
          loading: false,
          failed: true,
        }));
      }
    }
  }, [fetcher, parser]);

  useEffect(() => {
    mountedRef.current = true;
    setState({ data: null, loading: true, failed: false, verifiedAt: null });
    void refresh();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [refresh, tenant]);

  return { ...state, refresh };
}

function ControlCard<T>({
  title,
  description,
  section,
  owner,
  ownerLabel,
  children,
}: {
  title: string;
  description: string;
  section: ControlSection<T>;
  owner: Section;
  ownerLabel: string;
  children: (data: T) => ReactNode;
}): ReactElement {
  return (
    <article className="dhw-control-card">
      <header>
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setSection(owner)}
        >
          {ownerLabel}
          <Icon name="arrow-up-right" size={14} />
        </button>
      </header>

      {section.failed ? (
        <div className="dhw-control-error" role="alert">
          <Icon name="alert-triangle" size={15} />
          <span>
            {section.data
              ? "Refresh failed; last verified evidence remains visible."
              : "This configuration could not be verified."}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void section.refresh()}
            disabled={section.loading}
          >
            Retry
          </button>
        </div>
      ) : null}

      {section.loading && !section.data ? (
        <div className="dhw-control-skeleton" aria-busy="true">
          <div className="skel" />
          <div className="skel" />
          <span className="visually-hidden" role="status">
            Loading {title.toLowerCase()}
          </span>
        </div>
      ) : section.data ? (
        <>
          <div className={section.loading ? "dhw-control-stale" : undefined}>
            {children(section.data)}
          </div>
          <p className="dhw-control-provenance">
            {section.loading ? "Refreshing" : "Verified in this session"}
            {section.verifiedAt
              ? ` · ${section.verifiedAt.toLocaleTimeString()}`
              : ""}
          </p>
        </>
      ) : null}
    </article>
  );
}

function DomainEvidence({ setups }: { setups: DomainSetup[] }): ReactElement {
  if (setups.length === 0) {
    return (
      <p className="dhw-control-empty">
        No sending-domain setup was returned. This is not a DNS-health proof.
      </p>
    );
  }
  return (
    <ul className="dhw-control-domains">
      {setups.map((setup) => (
        <li key={setup.id ?? setup.domain}>
          <strong>{setup.domain}</strong>
          <StatusBadge value={setup.status} />
          <small>
            TLS {setup.ssl_status || "unknown"} · routing{" "}
            {setup.routing_status || "unknown"}
          </small>
        </li>
      ))}
    </ul>
  );
}

function EvidenceRows({ rows }: { rows: [string, string][] }): ReactElement {
  return (
    <dl className="dhw-control-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatusBadge({ value }: { value: string }): ReactElement {
  const normalized = value.toLowerCase();
  const tone = ["active", "verified", "healthy", "ok"].includes(normalized)
    ? "success"
    : ["pending", "warming", "in_progress"].includes(normalized)
      ? "warning"
      : ["failed", "error", "rejected"].includes(normalized)
        ? "danger"
        : "neutral";
  return (
    <span className="dhw-control-badge" data-tone={tone}>
      {value || "unknown"}
    </span>
  );
}

function pct(effective?: number, basisPoints?: number): string {
  if (typeof effective === "number" && effective >= 0)
    return `${effective.toFixed(1)}%`;
  if (typeof basisPoints === "number")
    return `${(basisPoints / 100).toFixed(1)}%`;
  return "Unknown";
}
