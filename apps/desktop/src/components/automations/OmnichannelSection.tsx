/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- bounded overflow regions must be keyboard-scrollable. */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";

import {
  AUTOMATION_SURFACE_BOUNDARIES,
  OMNICHANNEL_DRAFT_CREATION_AVAILABLE,
} from "../../lib/automation-operational-availability";
import {
  type OmniCampaign,
  type OmniCatalogItem,
  type OmniCatalogResponse,
  omnichannelApi,
} from "../../lib/api-client";
import { HeroEmptyState } from "../HeroEmptyState";
import { SectionHeader } from "../SectionHeader";
import { SlideoverShell } from "../SlideoverShell";

import {
  basisPointsToPercent,
  normalizeOmniCampaign,
  normalizeOmniCampaignList,
  normalizeOmniCatalog,
} from "./omnichannel-helpers";
import { fmtRelative } from "./zero-copy-helpers";

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  stale: boolean;
  updatedAt: number | null;
}

function initialResource<T>(): ResourceState<T> {
  return {
    data: null,
    loading: true,
    refreshing: false,
    error: null,
    stale: false,
    updatedAt: null,
  };
}

export function OmnichannelSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const [catalog, setCatalog] =
    useState<ResourceState<OmniCatalogResponse>>(initialResource);
  const [campaigns, setCampaigns] =
    useState<ResourceState<OmniCampaign[]>>(initialResource);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const catalogSequenceRef = useRef(0);
  const campaignsSequenceRef = useRef(0);
  const creationReasonId = useId();
  const boundary = AUTOMATION_SURFACE_BOUNDARIES["omnichannel-drafts"];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      catalogSequenceRef.current += 1;
      campaignsSequenceRef.current += 1;
    };
  }, []);

  const loadCatalog = useCallback(async (retain: boolean): Promise<void> => {
    const sequence = ++catalogSequenceRef.current;
    setCatalog((previous) => ({
      data: retain ? previous.data : null,
      loading: !retain || previous.data === null,
      refreshing: retain && previous.data !== null,
      error: null,
      stale: false,
      updatedAt: retain ? previous.updatedAt : null,
    }));
    try {
      const response = await omnichannelApi.catalog();
      if (!mountedRef.current || sequence !== catalogSequenceRef.current)
        return;
      if (response.error) {
        setCatalog((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error:
            "The channel schema request failed. Retry, then review secure service logs if it persists.",
          stale: previous.data !== null,
        }));
        return;
      }
      const normalized = normalizeOmniCatalog(response.data);
      if (!normalized.ok) {
        setCatalog((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error: normalized.message,
          stale: previous.data !== null,
        }));
        return;
      }
      setCatalog({
        data: normalized.value,
        loading: false,
        refreshing: false,
        error: null,
        stale: false,
        updatedAt: Date.now(),
      });
    } catch {
      if (!mountedRef.current || sequence !== catalogSequenceRef.current)
        return;
      setCatalog((previous) => ({
        ...previous,
        loading: false,
        refreshing: false,
        error:
          "The channel schema request did not complete. Retry, then review secure service logs if it persists.",
        stale: previous.data !== null,
      }));
    }
  }, []);

  const loadCampaigns = useCallback(async (retain: boolean): Promise<void> => {
    const sequence = ++campaignsSequenceRef.current;
    setCampaigns((previous) => ({
      data: retain ? previous.data : null,
      loading: !retain || previous.data === null,
      refreshing: retain && previous.data !== null,
      error: null,
      stale: false,
      updatedAt: retain ? previous.updatedAt : null,
    }));
    try {
      const response = await omnichannelApi.listCampaigns();
      if (!mountedRef.current || sequence !== campaignsSequenceRef.current)
        return;
      if (response.error) {
        setCampaigns((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error:
            "The campaign definition list request failed. Retry, then review secure service logs if it persists.",
          stale: previous.data !== null,
        }));
        return;
      }
      const normalized = normalizeOmniCampaignList(response.data?.items);
      if (!normalized.ok) {
        setCampaigns((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error: normalized.message,
          stale: previous.data !== null,
        }));
        return;
      }
      setCampaigns({
        data: normalized.value,
        loading: false,
        refreshing: false,
        error: null,
        stale: false,
        updatedAt: Date.now(),
      });
    } catch {
      if (!mountedRef.current || sequence !== campaignsSequenceRef.current)
        return;
      setCampaigns((previous) => ({
        ...previous,
        loading: false,
        refreshing: false,
        error:
          "The campaign definition list request did not complete. Retry, then review secure service logs if it persists.",
        stale: previous.data !== null,
      }));
    }
  }, []);

  useEffect(() => {
    void loadCatalog(false);
    void loadCampaigns(false);
  }, [loadCampaigns, loadCatalog]);

  const refreshAll = (): void => {
    void loadCatalog(true);
    void loadCampaigns(true);
  };
  const refreshing = catalog.refreshing || campaigns.refreshing;

  return (
    <section
      id="omnichannel-definitions"
      className="automations-surface"
      aria-label="Omnichannel campaign definitions"
    >
      <SectionHeader
        title="Omnichannel campaign definitions"
        description="Inspect declared channel schemas and summarized stored campaign paths. Catalog support is not tenant readiness, and these summaries are not complete definitions, validation results, execution, or delivery evidence."
        helpText="Safe campaign creation requires an explicit audience, bound templates, qualified scheduling and dispatch, and delivery receipts. The current desktop form cannot prove those prerequisites, so creation is unavailable."
        actions={
          <div className="automations-toolbar">
            <button
              type="button"
              className="btn"
              disabled={catalog.loading || campaigns.loading || refreshing}
              onClick={refreshAll}
            >
              {refreshing ? "Refreshing…" : "Refresh definitions"}
            </button>
            {canAdmin ? (
              <button
                type="button"
                className="btn btn-primary"
                aria-disabled={!OMNICHANNEL_DRAFT_CREATION_AVAILABLE}
                aria-describedby={creationReasonId}
                onClick={() => {
                  if (!OMNICHANNEL_DRAFT_CREATION_AVAILABLE) return;
                }}
              >
                New campaign unavailable
              </button>
            ) : null}
          </div>
        }
      />

      <div className="automations-boundary" id={creationReasonId}>
        <div>
          <span className="automations-boundary__label">Available</span>
          <strong>{boundary.available}</strong>
        </div>
        <div data-blocked="true">
          <span className="automations-boundary__label">Unavailable</span>
          <strong>{boundary.unavailable}</strong>
        </div>
      </div>

      <CatalogPanel state={catalog} onRetry={() => void loadCatalog(true)} />
      <CampaignDefinitions
        state={campaigns}
        onRetry={() => void loadCampaigns(true)}
        onSelect={setSelectedId}
      />

      {selectedId ? (
        <OmniCampaignDetailSlideover
          campaignId={selectedId}
          catalog={catalog.data}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </section>
  );
}

function CatalogPanel({
  state,
  onRetry,
}: {
  state: ResourceState<OmniCatalogResponse>;
  onRetry: () => void;
}): ReactElement {
  if (state.data === null && state.loading) {
    return (
      <p className="muted" role="status">
        Loading declared channel schema…
      </p>
    );
  }
  if (state.data === null && state.error) {
    return (
      <LoadError
        title="Channel schema is unavailable."
        message={state.error}
        onRetry={onRetry}
      />
    );
  }
  const catalog = state.data;
  return (
    <div className="automations-card automations-catalog">
      <div className="automations-card-heading">
        <div>
          <span className="label">Static schema</span>
          <h3>Declared channel capabilities</h3>
          <p>
            These entries describe accepted fields. They do not check tenant
            credentials, provider health, consent, audience, or deliverability.
          </p>
        </div>
        <span className="automations-card-heading__meta">
          {catalog?.channels.length ?? 0} channel types · schema{" "}
          {catalog?.schema_version ?? "unknown"}
        </span>
      </div>
      {state.error && state.stale ? (
        <StaleNotice message={state.error} onRetry={onRetry} />
      ) : null}
      <div className="automations-channel-grid">
        {(catalog?.channels ?? []).map((channel) => (
          <ChannelCard key={channel.key} channel={channel} />
        ))}
      </div>
      {(catalog?.channels ?? []).length === 0 ? (
        <div className="automations-inline-empty">
          <strong>No channel types declared</strong>
          <span>
            The empty catalog does not establish runtime availability.
          </span>
        </div>
      ) : null}
      <CatalogChipRow
        label="Declared send strategies"
        items={catalog?.send_strategies ?? []}
      />
      <CatalogChipRow
        label="Declared snapshot modes"
        items={catalog?.recipient_snapshot_modes ?? []}
      />
    </div>
  );
}

function ChannelCard({ channel }: { channel: OmniCatalogItem }): ReactElement {
  const fields = channel.fields ?? [];
  const status = channel.runtime_status || "unspecified";
  const unavailable = /unavailable|disabled|error/i.test(status);
  return (
    <article className="automations-channel-card">
      <div>
        <strong>{channel.label || channel.key}</strong>
        <span className={`badge ${unavailable ? "danger" : ""}`}>
          Declared: {status}
        </span>
      </div>
      <p>
        <code>{channel.key}</code>
        {channel.provider ? ` · provider ${channel.provider}` : ""}
      </p>
      <p>
        {fields.length > 0
          ? `Schema fields: ${fields.map((field) => `${field.key}${field.required ? "*" : ""}`).join(", ")}`
          : "No channel-specific fields declared."}
      </p>
      <small>Tenant runtime not checked</small>
    </article>
  );
}

function CatalogChipRow({
  label,
  items,
}: {
  label: string;
  items: OmniCatalogItem[];
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="automations-chip-row">
      <span className="label">{label}</span>
      <div>
        {items.map((item) => (
          <span key={item.key} className="badge">
            {item.label || item.key}
          </span>
        ))}
      </div>
    </div>
  );
}

function CampaignDefinitions({
  state,
  onRetry,
  onSelect,
}: {
  state: ResourceState<OmniCampaign[]>;
  onRetry: () => void;
  onSelect: (id: string) => void;
}): ReactElement {
  if (state.data === null && state.loading) {
    return (
      <p className="muted" role="status">
        Loading stored campaign definitions…
      </p>
    );
  }
  if (state.data === null && state.error) {
    return (
      <LoadError
        title="Campaign definitions are unavailable."
        message={state.error}
        onRetry={onRetry}
      />
    );
  }
  const rows = state.data ?? [];
  return (
    <div className="automations-definition-list">
      <div className="automations-card-heading">
        <div>
          <span className="label">Definitions</span>
          <h3>Stored campaign drafts</h3>
          <p>
            Status values below are persisted metadata, not a runtime monitor.
          </p>
        </div>
        <span className="automations-card-heading__meta">
          {rows.length.toLocaleString()} returned · service limit 200 · total
          unknown
        </span>
      </div>
      {state.error && state.stale ? (
        <StaleNotice message={state.error} onRetry={onRetry} />
      ) : null}
      {rows.length === 0 ? (
        <HeroEmptyState
          tone="blue"
          eyebrow="Campaign definitions"
          title="No stored definitions yet."
          subtitle="Creation remains unavailable until audience, template, scheduling, dispatch, and delivery-proof prerequisites are qualified."
          imageSrc={null}
        />
      ) : (
        <div
          className="automations-table-scroll"
          role="region"
          aria-label="Stored omnichannel campaign definitions"
          tabIndex={0}
        >
          <table className="data-table automations-responsive-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Stored status</th>
                <th scope="col">Path definitions</th>
                <th scope="col">Snapshot mode</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((campaign) => (
                <tr key={campaign.id}>
                  <td data-label="Name">
                    {campaign.id ? (
                      <button
                        type="button"
                        className="link-button automations-name-button"
                        onClick={() => onSelect(campaign.id!)}
                      >
                        {campaign.name || "(unnamed)"}
                      </button>
                    ) : (
                      campaign.name || <em>(unnamed)</em>
                    )}
                  </td>
                  <td data-label="Stored status">
                    <span className="badge">
                      stored {campaign.status ?? "unknown"}
                    </span>
                  </td>
                  <td data-label="Path definitions" className="tabular">
                    {(campaign.paths ?? []).length}
                  </td>
                  <td data-label="Snapshot mode">
                    {campaign.recipient_snapshot_mode ?? "—"}
                  </td>
                  <td data-label="Created" className="muted tabular">
                    {fmtRelative(campaign.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LoadError({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="automations-load-error" role="alert">
      <strong>{title}</strong>
      <span>{message}</span>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function StaleNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="callout warning" role="status">
      Showing the last loaded definitions. Refresh failed: {message}{" "}
      <button type="button" className="link-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function OmniCampaignDetailSlideover({
  campaignId,
  catalog,
  onClose,
}: {
  campaignId: string;
  catalog: OmniCatalogResponse | null;
  onClose: () => void;
}): ReactElement {
  const [state, setState] =
    useState<ResourceState<OmniCampaign>>(initialResource);
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(
    async (retain: boolean): Promise<void> => {
      const sequence = ++sequenceRef.current;
      setState((previous) => ({
        data: retain ? previous.data : null,
        loading: !retain || previous.data === null,
        refreshing: retain && previous.data !== null,
        error: null,
        stale: false,
        updatedAt: retain ? previous.updatedAt : null,
      }));
      try {
        const response = await omnichannelApi.getCampaign(campaignId);
        if (!mountedRef.current || sequence !== sequenceRef.current) return;
        if (response.error) {
          setState((previous) => ({
            ...previous,
            loading: false,
            refreshing: false,
            error:
              "The campaign definition request failed. Retry, then review secure service logs if it persists.",
            stale: previous.data !== null,
          }));
          return;
        }
        const normalized = normalizeOmniCampaign(response.data);
        if (!normalized.ok) {
          setState((previous) => ({
            ...previous,
            loading: false,
            refreshing: false,
            error: normalized.message,
            stale: previous.data !== null,
          }));
          return;
        }
        setState({
          data: normalized.value,
          loading: false,
          refreshing: false,
          error: null,
          stale: false,
          updatedAt: Date.now(),
        });
      } catch {
        if (!mountedRef.current || sequence !== sequenceRef.current) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error:
            "The campaign definition request did not complete. Retry, then review secure service logs if it persists.",
          stale: previous.data !== null,
        }));
      }
    },
    [campaignId],
  );

  useEffect(() => {
    mountedRef.current = true;
    void load(false);
    return () => {
      mountedRef.current = false;
      sequenceRef.current += 1;
    };
  }, [load]);

  const campaign = state.data;
  const channelLabel = (key: string): string =>
    catalog?.channels.find((channel) => channel.key === key)?.label || key;

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      eyebrow="Stored campaign path summary"
      title={
        campaign?.name ?? (state.error ? "Definition unavailable" : "Loading…")
      }
      subtitle={
        campaign ? (
          <>
            stored {campaign.status ?? "unknown"} · created{" "}
            {fmtRelative(campaign.created_at)}
          </>
        ) : undefined
      }
      headerActions={
        campaign ? (
          <button
            type="button"
            className="btn"
            disabled={state.refreshing}
            onClick={() => void load(true)}
          >
            {state.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        ) : undefined
      }
    >
      <div className="automations-runtime-note is-blocked" role="note">
        <strong>Partial path summary</strong>
        <span>
          Objective, audience, scheduling, send strategy, template identity,
          settings, dispatch, and delivery readiness are not represented here.
        </span>
      </div>
      {campaign === null && state.loading ? (
        <p className="muted" role="status">
          Loading campaign definition…
        </p>
      ) : null}
      {campaign === null && state.error ? (
        <LoadError
          title="Campaign definition is unavailable."
          message={state.error}
          onRetry={() => void load(true)}
        />
      ) : null}
      {campaign && state.error && state.stale ? (
        <StaleNotice message={state.error} onRetry={() => void load(true)} />
      ) : null}
      {campaign ? (
        (campaign.paths ?? []).length === 0 ? (
          <div className="automations-inline-empty">
            <strong>No path definitions</strong>
            <span>This definition cannot describe a send plan.</span>
          </div>
        ) : (
          <div
            className="automations-table-scroll"
            role="region"
            aria-label="Campaign path definitions"
            tabIndex={0}
          >
            <table className="data-table automations-responsive-table">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Path</th>
                  <th scope="col">Declared channel</th>
                  <th scope="col">Stored status</th>
                  <th scope="col">Weight</th>
                  <th scope="col">Fallback</th>
                </tr>
              </thead>
              <tbody>
                {(campaign.paths ?? []).map((path) => (
                  <tr key={path.path_key}>
                    <td data-label="Order" className="tabular">
                      {path.sequence ?? "—"}
                    </td>
                    <td data-label="Path">
                      <strong>{path.name}</strong>
                      <small>
                        <code>{path.path_key}</code>
                      </small>
                    </td>
                    <td data-label="Declared channel">
                      {channelLabel(path.channel)}
                    </td>
                    <td data-label="Stored status">{path.status ?? "—"}</td>
                    <td data-label="Weight" className="tabular">
                      {basisPointsToPercent(path.traffic_weight_basis_points)}
                    </td>
                    <td data-label="Fallback">
                      {path.fallback_path_key ? (
                        <code>{path.fallback_path_key}</code>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </SlideoverShell>
  );
}
