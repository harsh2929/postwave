/**
 * CustomerHubConfig — the storefront Customer Hub settings form (KLV-10).
 *
 * Edits the simple, scalar config the backend exposes: a `status` and the
 * five feature toggles (order history / favorites / coupons / recommendations
 * / customer agent). Save sends a complete replacement carrying every
 * strictly decoded object field forward, guarded by the verified version.
 *
 * HONEST scope: the complex object fields (storefronts, content_blocks,
 * personalization_rules, styling) are NOT editable here in v1 — we show a
 * read-only note that they're managed elsewhere rather than faking an editor
 * we can't round-trip safely.
 *
 * Writes are ADMIN-gated (PUT /service-suite/config → 403 for non-admins);
 * the form renders for everyone but disables Save and explains why for
 * non-admin sessions, and translates a server 403 into a clear toast.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type ServiceHubConfig, serviceSuiteApi } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { toast } from "../Toast";
import {
  HUB_READ_ONLY_OBJECT_FIELDS,
  HUB_TOGGLES,
  buildHubPatch,
  buildHubReplacement,
  decodeHubConfig,
  describeWriteError,
  humanizeToken,
  patchHasChanges,
} from "./agent-helpers";

type ToggleKey = (typeof HUB_TOGGLES)[number]["key"];

interface Draft {
  status: string;
  order_history_enabled: boolean;
  favorites_enabled: boolean;
  coupons_enabled: boolean;
  recommendations_enabled: boolean;
  customer_agent_enabled: boolean;
}

function toDraft(cfg: ServiceHubConfig): Draft {
  return {
    status: cfg.status ?? "",
    order_history_enabled: Boolean(cfg.order_history_enabled),
    favorites_enabled: Boolean(cfg.favorites_enabled),
    coupons_enabled: Boolean(cfg.coupons_enabled),
    recommendations_enabled: Boolean(cfg.recommendations_enabled),
    customer_agent_enabled: Boolean(cfg.customer_agent_enabled),
  };
}

const ADMIN_403_COPY =
  "Saving the Customer Hub config needs an admin-scoped key.";

export function CustomerHubConfig({
  tenantId,
  accessAllowed,
  online = true,
}: {
  tenantId: string | null;
  accessAllowed: boolean;
  online?: boolean;
}): ReactElement {
  const canAdmin = useCanAdmin();

  const [config, setConfig] = useState<ServiceHubConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [stale, setStale] = useState(false);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const writeGenerationRef = useRef(0);
  const saveOperationRef = useRef(false);
  const hasConfigRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (!accessAllowed || !tenantId || !online) return;
    const generation = ++loadGenerationRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setErr(null);
    const res = await serviceSuiteApi.config({ signal: controller.signal });
    if (controller.signal.aborted || generation !== loadGenerationRef.current) {
      return;
    }
    if (res.error) {
      setErr("The Customer Hub configuration could not be verified.");
      setStale(hasConfigRef.current);
    } else {
      const decoded = decodeHubConfig(res.data as unknown, tenantId);
      if (!decoded.value) {
        setErr(decoded.error ?? "The configuration response was invalid.");
        setStale(hasConfigRef.current);
      } else {
        setConfig(decoded.value);
        hasConfigRef.current = true;
        setDraft(toDraft(decoded.value));
        setStale(false);
      }
    }
    setLoading(false);
  }, [accessAllowed, online, tenantId]);

  useEffect(() => {
    if (!accessAllowed || !tenantId) {
      loadAbortRef.current?.abort();
      setConfig(null);
      hasConfigRef.current = false;
      setDraft(null);
      setLoading(false);
      return;
    }
    if (!online) {
      loadAbortRef.current?.abort();
      setLoading(false);
      setErr("Helpdesk is offline; configuration verification is paused.");
      setStale(hasConfigRef.current);
      return;
    }
    void load();
    return () => {
      loadGenerationRef.current += 1;
      writeGenerationRef.current += 1;
      loadAbortRef.current?.abort();
    };
  }, [accessAllowed, load, online, tenantId]);

  const setToggle = (key: ToggleKey, value: boolean): void => {
    setDraft((d) => (d ? { ...d, [key]: Boolean(value) } : d));
  };

  const onSave = async (): Promise<void> => {
    if (!config || !draft || !tenantId || !online || saveOperationRef.current)
      return;
    const expectedTenantId = tenantId;
    const changes = buildHubPatch(config, draft);
    if (!patchHasChanges(changes)) {
      toast.info("No changes to save.");
      return;
    }
    if (draft.status === "active" || draft.customer_agent_enabled) {
      toast.error(
        "Customer Hub publication and Customer Agent enablement are release-held.",
      );
      return;
    }
    saveOperationRef.current = true;
    const generation = writeGenerationRef.current;
    setSaving(true);
    let res: Awaited<ReturnType<typeof serviceSuiteApi.updateConfig>>;
    try {
      res = await serviceSuiteApi.updateConfig(
        buildHubReplacement(config, draft),
        config.version,
      );
    } catch {
      if (generation === writeGenerationRef.current) {
        toast.error(
          "Customer Hub replacement outcome is unknown. Refresh before another write.",
        );
        setStale(true);
      }
      return;
    } finally {
      saveOperationRef.current = false;
      if (generation === writeGenerationRef.current) setSaving(false);
    }
    if (generation !== writeGenerationRef.current) return;
    if (res.error) {
      if (
        res.error.status === 412 ||
        res.error.status === 428 ||
        res.error.kind === "network" ||
        res.error.kind === "timeout" ||
        (typeof res.error.status === "number" && res.error.status >= 500)
      ) {
        setStale(true);
      }
      toast.error({
        message: "Couldn't save Customer Hub config",
        detail: describeWriteError(res.error, ADMIN_403_COPY),
      });
      return;
    }
    const decoded = decodeHubConfig(res.data as unknown, expectedTenantId);
    if (!decoded.value) {
      // The replacement may already have committed even though its 2xx body
      // cannot be trusted. Retire the old ETag and require a verified refresh.
      setStale(true);
      toast.error({
        message: "Customer Hub response could not be verified",
        detail: decoded.error ?? "The replacement result was invalid.",
      });
      return;
    }
    setConfig(decoded.value);
    setDraft(toDraft(decoded.value));
    toast.success(
      "Configuration record replaced. Storefront and channel runtimes remain release-held.",
    );
  };

  if (!accessAllowed || !tenantId || !canAdmin) {
    return (
      <div
        className="card helpdesk-locked-panel"
        data-helpdesk-state="access-denied"
      >
        <div className="helpdesk-state-icon" aria-hidden="true">
          ⌁
        </div>
        <h2>Customer Hub configuration is admin-only</h2>
        <p>No Hub configuration or storefront settings were requested.</p>
      </div>
    );
  }

  if (loading && !config) {
    return (
      <div className="card" style={{ padding: 16 }}>
        <div className="skel-row" />
        <div className="skel-row" />
        <div className="skel-row" />
      </div>
    );
  }

  if ((err && !config) || !config || !draft) {
    return (
      <div className="card" style={{ padding: 16 }}>
        <div className="notice">
          <span>
            Couldn&apos;t load the Customer Hub config{err ? `: ${err}` : "."}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const dirty = patchHasChanges(buildHubPatch(config, draft));
  const releaseBlocked =
    draft.status === "active" || draft.customer_agent_enabled;

  return (
    <div className="card helpdesk-hub-card">
      <div>
        <div className="helpdesk-section-kicker">Configuration record</div>
        <h2>Customer Hub</h2>
        <p className="muted">
          Review and replace the complete Hub configuration record. No
          authenticated storefront widget/session runtime exists, so these
          values do not prove that a customer can see or use a feature.
        </p>
      </div>

      <div className="helpdesk-release-hold" role="status">
        <strong>Runtime release held</strong>
        <span>
          Server readiness: {humanizeToken(config.runtime_status)} ·{" "}
          {config.runtime_reason_code}. Publication, live channel status, and
          effective Customer Agent enablement remain unavailable.
        </span>
      </div>

      {stale ? (
        <div className="helpdesk-partial-notice" role="status">
          The last verified configuration is retained as stale. Refresh before
          replacing it. No stale write will be retried automatically.
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void load()}
            disabled={loading || saving}
          >
            {loading ? "Refreshing…" : "Refresh verified config"}
          </button>
        </div>
      ) : null}

      {/* Status (scalar). */}
      <div className="field">
        <label className="field-label" htmlFor="hub-status">
          Status
        </label>
        <select
          id="hub-status"
          className="input mono"
          value={draft.status ?? ""}
          onChange={(e) =>
            setDraft((d) => (d ? { ...d, status: e.target.value } : d))
          }
          disabled={!canAdmin || saving || !online}
        >
          {!["draft", "paused", "archived"].includes(draft.status) ? (
            <option value={draft.status}>
              {humanizeToken(draft.status)} (recorded; runtime unverified)
            </option>
          ) : null}
          <option value="draft">Draft</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
          <option value="active" disabled>
            Active — publication release held
          </option>
        </select>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          This is record lifecycle only. “Active” cannot be selected because no
          authenticated customer runtime exists.
        </div>
      </div>

      {/* The five feature toggles. */}
      <div className="helpdesk-hub-toggle-list">
        {HUB_TOGGLES.map((t) => {
          const checked = Boolean(draft[t.key]);
          return (
            <label
              key={t.key}
              htmlFor={`hub-${t.key}`}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "8px 0",
                borderBottom: "1px solid var(--pw-border-soft)",
                cursor: canAdmin ? "pointer" : "default",
              }}
            >
              <input
                id={`hub-${t.key}`}
                type="checkbox"
                checked={checked}
                role="switch"
                aria-label={t.label}
                aria-checked={checked}
                disabled={
                  !canAdmin ||
                  saving ||
                  !online ||
                  (t.key === "customer_agent_enabled" && !checked)
                }
                onChange={(e) => setToggle(t.key, e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{t.label}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {t.hint}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {/* Read-only note for the object-shaped config we don't edit in v1. */}
      <div
        className="muted"
        style={{
          fontSize: 11,
          background: "var(--pw-bg-elev)",
          border: "1px solid var(--pw-border)",
          borderRadius: 6,
          padding: "8px 10px",
          lineHeight: 1.5,
        }}
      >
        Advanced configuration —{" "}
        {HUB_READ_ONLY_OBJECT_FIELDS.map(humanizeToken).join(", ")} — is managed
        as read-only data here. The complete verified values are carried forward
        in PUT replacement semantics; this form never sends a sparse body.
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void onSave()}
          disabled={
            !canAdmin || !online || saving || stale || releaseBlocked || !dirty
          }
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {!online ? (
          <span className="muted" style={{ fontSize: 11 }}>
            Reconnect and refresh before replacing this record.
          </span>
        ) : releaseBlocked ? (
          <span className="muted" style={{ fontSize: 11 }}>
            Change status away from Active and turn off Customer Agent before
            replacing this release-held record.
          </span>
        ) : stale ? (
          <span className="muted" style={{ fontSize: 11 }}>
            Refresh is required before a replacement write.
          </span>
        ) : !dirty ? (
          <span className="muted" style={{ fontSize: 11 }}>
            No unsaved changes.
          </span>
        ) : null}
      </div>
    </div>
  );
}
