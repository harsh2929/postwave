/**
 * Export-retention settings controller.
 *
 * Owns loading, bounded policy edits, storage presentation, and the admin-only
 * save action independently from the account-wide Settings page.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import {
  lifecycleOperationError,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { InlineHelp } from "../InlineHelp";
import { toast } from "../Toast";
import {
  type ExportRetentionPolicy,
  apiSendTimeAssets,
} from "../../lib/api-client";

export function clampExportRetentionDays(value: number): number {
  if (!Number.isFinite(value)) return 7;
  return Math.max(7, Math.min(2555, Math.round(value)));
}

export function clampStoredExportCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(500, Math.round(value)));
}

export function formatExportStorageBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) value = 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Workstream 4 (Mailchimp parity polish): export retention controls.
 *
 * Sits below the existing "Data retention" section. Surfaces:
 *   - retention_days slider (7-2555)
 *   - max_per_tenant counter (1-500)
 *   - current_storage_bytes as a horizontal usage bar (denormalised
 *     server-side; recomputed on every read so it tracks live exports)
 *
 * Save action sends a PATCH with only the changed fields.
 */
export function ExportRetentionSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const [policy, setPolicy] = useState<ExportRetentionPolicy | null>(null);
  const [days, setDays] = useState<number>(30);
  const [maxPer, setMaxPer] = useState<number>(20);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const activeRef = useRef(true);
  const saveDescriptionId = useId();
  const operation = useSingleFlightOperation({
    ownerId: "export-retention",
    label: "Export-retention request",
  });
  const dirty =
    policy != null &&
    (days !== policy.retention_days || maxPer !== policy.max_per_tenant);

  useEffect(() => {
    activeRef.current = true;
    void (async () => {
      try {
        const res = await apiSendTimeAssets.getExportRetentionPolicy();
        if (!activeRef.current) return;
        if (res.error) {
          setErr(res.error.message);
          return;
        }
        const p = res.data;
        if (!p) {
          setErr("The server returned no export-retention policy.");
          return;
        }
        setPolicy(p);
        setDays(p.retention_days);
        setMaxPer(p.max_per_tenant);
      } catch (loadError) {
        if (activeRef.current) {
          setErr(
            lifecycleOperationError(
              loadError,
              "The export-retention policy couldn't be loaded.",
            ),
          );
        }
      } finally {
        if (activeRef.current) setLoading(false);
      }
    })();
    return () => {
      activeRef.current = false;
    };
  }, []);

  const onSave = async (): Promise<boolean> => {
    if (!canAdmin || !policy) return false;
    if (!dirty) return true;
    const pending = operation.promiseRef.current;
    if (pending) {
      return (await pending) === true;
    }
    const changes: {
      retention_days?: number;
      max_per_tenant?: number;
    } = {};
    if (days !== policy.retention_days) changes.retention_days = days;
    if (maxPer !== policy.max_per_tenant) changes.max_per_tenant = maxPer;
    setBusy(true);
    setErr(null);
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const res = await apiSendTimeAssets.patchExportRetentionPolicy(changes);
        if (!activeRef.current) return false;
        if (res.error) {
          setErr(res.error.message);
          toast.error(`Couldn't save: ${res.error.message}`);
          return false;
        }
        const saved = res.data ?? { ...policy, ...changes };
        setPolicy(saved);
        setDays(saved.retention_days);
        setMaxPer(saved.max_per_tenant);
        toast.success("Export retention policy saved");
        return true;
      } catch (saveError) {
        if (!activeRef.current) return false;
        const message = lifecycleOperationError(
          saveError,
          "The export-retention policy couldn't be saved.",
        );
        setErr(message);
        toast.error(`Couldn't save: ${message}`);
        return false;
      } finally {
        if (activeRef.current) setBusy(false);
      }
    });
    return request ? await request : false;
  };

  const discard = (): void => {
    if (!policy) return;
    setDays(policy.retention_days);
    setMaxPer(policy.max_per_tenant);
    setErr(null);
  };
  useExistingSettingLifecycle({
    ownerId: "export-retention",
    label: "Export retention policy",
    dirty,
    operationRef: operation.promiseRef,
    save: onSave,
    discard,
    detail: "Export-retention changes have not been saved.",
  });

  // Visual usage bar: assume 5 GB soft ceiling for the bar fill.
  // The actual server-side cap is governed by max_per_tenant + bundle
  // sizes; this is just a visual cue.
  const usageFraction = Math.min(
    1,
    Math.max(
      0,
      (policy?.current_storage_bytes ?? 0) / (5 * 1024 * 1024 * 1024),
    ),
  );
  const saveUnavailableReason = !canAdmin
    ? "Admin role required."
    : loading || !policy
      ? "Wait for the export-retention policy to load."
      : operation.active
        ? "The export-retention policy is already being saved."
        : !dirty
          ? "No changes to save."
          : null;

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Export retention</h2>
        <div className="settings-section-sub">
          Set the expiry assigned to newly completed export ZIPs and cap
          queued, running, or unexpired ready bundles.
        </div>
      </div>
      <div className="settings-section-body">
        {err ? (
          <div className="notice">
            <span>{err}</span>
          </div>
        ) : null}
        {loading ? (
          <div className="muted">Loading retention policy…</div>
        ) : null}
        <div className="settings-row">
          <div>
            <div
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              Retention window
              <InlineHelp text="How many days after completion a new export remains available before it becomes eligible for cleanup. Existing exports keep the deadline assigned when they completed." />
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Minimum 7 days, maximum 2555 days (≈7 years).
            </div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="range"
              min={7}
              max={2555}
              step={1}
              value={days ?? 0}
              onChange={(e) => {
                setDays(Number(e.target.value));
              }}
              disabled={!canAdmin || loading || !policy || operation.active}
              style={{ width: 180 }}
              aria-label="Retention days"
            />
            <input
              type="number"
              aria-label="Export retention days"
              className="input"
              min={7}
              max={2555}
              value={days ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) {
                  setDays(clampExportRetentionDays(n));
                }
              }}
              disabled={!canAdmin || loading || !policy || operation.active}
              style={{ width: 90 }}
            />
            <span className="muted" style={{ fontSize: 12 }}>
              day{days === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="settings-row">
          <div>
            <div
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              Active exports
              <InlineHelp text="Maximum queued, running, or unexpired ready exports for the tenant. New requests are refused at the cap; existing bundles are not silently evicted." />
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Capacity reservations per tenant (1-500).
            </div>
          </div>
          <input
            type="number"
            aria-label="Maximum concurrent exports"
            className="input"
            min={1}
            max={500}
            value={maxPer ?? ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setMaxPer(clampStoredExportCount(n));
              }
            }}
            disabled={!canAdmin || loading || !policy || operation.active}
            style={{ width: 90 }}
          />
        </div>
        <div className="settings-row" style={{ alignItems: "flex-start" }}>
          <div>
            <div>Current usage</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Sum of bytes across all of your tenant's ready exports.
            </div>
          </div>
          <div style={{ minWidth: 280 }}>
            <div
              style={{
                height: 8,
                borderRadius: 4,
                background:
                  "color-mix(in srgb, var(--pw-fg-muted) 12%, transparent)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${(usageFraction * 100).toFixed(1)}%`,
                  height: "100%",
                  background: "var(--pw-accent)",
                  transition: "width 200ms ease",
                }}
              />
            </div>
            <div
              className="muted"
              style={{ fontSize: 12, marginTop: 4, textAlign: "right" }}
            >
              {formatExportStorageBytes(policy?.current_storage_bytes ?? 0)}{" "}
              stored
            </div>
          </div>
        </div>
        <div className="settings-row">
          <div className="muted" style={{ fontSize: 12 }}>
            {policy?.updated_at
              ? `Last updated ${new Date(policy.updated_at).toLocaleString()}`
              : "Not yet saved"}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (!saveUnavailableReason) void onSave();
            }}
            aria-disabled={saveUnavailableReason !== null || undefined}
            aria-describedby={saveDescriptionId}
            aria-busy={operation.active || undefined}
          >
            {busy ? "Saving…" : "Save policy"}
          </button>
          <span id={saveDescriptionId} className="visually-hidden">
            {saveUnavailableReason ?? "Save the export-retention policy."}
          </span>
        </div>
      </div>
    </div>
  );
}
