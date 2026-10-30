/**
 * CustomFieldGovernance — Settings "Custom Fields Governance" card
 * (SUB-015 — custom-field soft limits + governance).
 *
 * Reads GET /api/v1/settings/custom-fields to render two usage bars:
 *   - "X / 1000 total fields"     against max_custom_fields
 *   - "Y / 3 searchable fields"   against max_searchable_fields
 * Each bar turns amber at >= 90% usage and red once the cap is reached,
 * and shows a "Near limit" / "At limit" badge so the governance state is
 * legible at a glance.
 *
 * Owners/admins additionally get an inline editor that PUTs the
 * per-tenant overrides (admin-scoped on the API). Non-admins see the
 * usage read-only with an explanatory note — no edit affordance.
 *
 * Honest-UI notes:
 *   - every load/save failure renders the error + a Retry/inline message;
 *     nothing is fabricated while a fetch is down.
 *   - the caps are the *effective* limits (per-tenant override when set,
 *     else the tier default), exactly as the server resolves them.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  lifecycleOperationError,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type CustomFieldLimits,
  type CustomFieldLimitsUpdateInput,
  customFieldSettingsApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { toast } from "../Toast";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { SettingsSectionHeader } from "./SettingsNav";

/** Usage fraction at which a bar flips to the "near limit" warning. */
const WARN_FRACTION = 0.9;

/** @internal Runtime boundary used before any server value reaches render. */
export function isCustomFieldLimits(
  value: unknown,
): value is CustomFieldLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return [
    candidate.max_custom_fields,
    candidate.max_searchable_fields,
    candidate.used_custom_fields,
    candidate.used_searchable_fields,
  ].every(
    (field) =>
      typeof field === "number" && Number.isSafeInteger(field) && field >= 0,
  );
}

export function CustomFieldGovernance(): ReactElement {
  const canAdmin = useCanAdmin();
  const [limits, setLimits] = useState<CustomFieldLimits | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  // Draft cap values for the admin editor. Kept as strings so the inputs
  // stay controlled while the operator clears/retypes a number.
  const [editing, setEditing] = useState<boolean>(false);
  const [draftMax, setDraftMax] = useState<string>("");
  const [draftSearchable, setDraftSearchable] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const activeRef = useRef(true);
  const operation = useSingleFlightOperation({
    ownerId: "custom-field-governance",
    label: "Custom-field governance request",
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const res = await customFieldSettingsApi.get();
      if (!activeRef.current) return;
      if (res.error) {
        setErr(res.error.message);
        setLimits(null);
        return;
      }
      if (!isCustomFieldLimits(res.data)) {
        setErr("The server returned invalid custom-field limits.");
        setLimits(null);
        return;
      }
      setLimits(res.data);
    } catch (loadError) {
      if (activeRef.current) {
        setErr(
          lifecycleOperationError(
            loadError,
            "Custom-field limits couldn't be loaded.",
          ),
        );
        setLimits(null);
      }
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
    };
  }, [load]);

  const beginEdit = useCallback((): void => {
    if (!limits) return;
    setDraftMax(String(limits.max_custom_fields));
    setDraftSearchable(String(limits.max_searchable_fields));
    setSaveErr(null);
    setEditing(true);
  }, [limits]);

  const cancelEdit = useCallback((): void => {
    if (limits) {
      setDraftMax(String(limits.max_custom_fields));
      setDraftSearchable(String(limits.max_searchable_fields));
    }
    setEditing(false);
    setSaveErr(null);
  }, [limits]);

  const dirty =
    editing &&
    limits !== null &&
    (draftMax !== String(limits.max_custom_fields) ||
      draftSearchable !== String(limits.max_searchable_fields));

  const save = useCallback(async (): Promise<boolean> => {
    if (!canAdmin || !limits) return false;
    const pending = operation.promiseRef.current;
    if (pending) {
      return (await pending) === true;
    }
    setSaveErr(null);

    // Only send caps that actually changed; an unchanged cap is omitted so
    // the server leaves it untouched. Empty/blank is treated as "unchanged"
    // (we never send a partial number).
    const input: CustomFieldLimitsUpdateInput = {};
    const parsedMax = parseCap(draftMax);
    const parsedSearchable = parseCap(draftSearchable);

    if (draftMax.trim() !== "" && parsedMax === null) {
      setSaveErr("Total fields cap must be a whole number ≥ 0.");
      return false;
    }
    if (draftSearchable.trim() !== "" && parsedSearchable === null) {
      setSaveErr("Searchable fields cap must be a whole number ≥ 0.");
      return false;
    }
    if (parsedMax !== null && parsedMax !== limits.max_custom_fields) {
      input.max_custom_fields = parsedMax;
    }
    if (
      parsedSearchable !== null &&
      parsedSearchable !== limits.max_searchable_fields
    ) {
      input.max_searchable_fields = parsedSearchable;
    }

    if (
      input.max_custom_fields === undefined &&
      input.max_searchable_fields === undefined
    ) {
      cancelEdit();
      return true;
    }

    setSaving(true);
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const res = await customFieldSettingsApi.update(input);
        if (!activeRef.current) return false;
        if (res.error || !isCustomFieldLimits(res.data)) {
          setSaveErr(
            res.error?.message ??
              "The server returned invalid custom-field limits.",
          );
          return false;
        }
        setLimits(res.data);
        setDraftMax(String(res.data.max_custom_fields));
        setDraftSearchable(String(res.data.max_searchable_fields));
        setEditing(false);
        toast.success("Custom-field limits updated.");
        return true;
      } catch (saveError) {
        if (activeRef.current) {
          setSaveErr(
            lifecycleOperationError(
              saveError,
              "Custom-field limits couldn't be saved.",
            ),
          );
        }
        return false;
      } finally {
        if (activeRef.current) setSaving(false);
      }
    });
    return request ? await request : false;
  }, [canAdmin, cancelEdit, draftMax, draftSearchable, limits, operation]);

  useExistingSettingLifecycle({
    ownerId: "custom-field-governance",
    label: "Custom-field governance",
    dirty,
    operationRef: operation.promiseRef,
    save,
    discard: cancelEdit,
    detail: "Custom-field governance changes have not been saved.",
  });

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Custom Fields Governance"
        description="Workspace caps on custom-field definitions and how many may be searchable. Limits are enforced when new fields are created."
        meta={
          !loading && !err && limits && canAdmin && !editing ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={beginEdit}
            >
              Configure limits
            </button>
          ) : undefined
        }
      />
      <div className="settings-section-body">
        {err ? (
          <div className="notice" role="alert">
            <span>Couldn&apos;t load custom-field limits: {err}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div role="status" aria-label="Loading custom-field limits">
            <div className="skel-row" aria-hidden="true" />
            <div className="skel-row" aria-hidden="true" />
          </div>
        ) : limits ? (
          <>
            <UsageBar
              label="Total fields"
              used={limits.used_custom_fields}
              max={limits.max_custom_fields}
            />
            <UsageBar
              label="Searchable fields"
              used={limits.used_searchable_fields}
              max={limits.max_searchable_fields}
            />
            <CustomFieldUsageData limits={limits} />

            {editing ? (
              <div
                className="settings-row"
                style={{
                  alignItems: "flex-start",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
                    gap: 12,
                    width: "100%",
                  }}
                >
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      Max total fields
                    </span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={draftMax}
                      onChange={(e) => setDraftMax(e.target.value)}
                      disabled={operation.active}
                    />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      Max searchable fields
                    </span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={draftSearchable}
                      onChange={(e) => setDraftSearchable(e.target.value)}
                      disabled={operation.active}
                    />
                  </label>
                </div>
                {saveErr ? (
                  <div
                    className="muted"
                    style={{ fontSize: 12, color: "var(--pw-danger)" }}
                  >
                    {saveErr}
                  </div>
                ) : null}
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void save()}
                    disabled={operation.active || !dirty}
                  >
                    {saving ? "Saving…" : "Save limits"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={cancelEdit}
                    disabled={operation.active}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : !canAdmin ? (
              <div className="muted" style={{ fontSize: 12 }}>
                Only workspace owners and admins can change these limits.
              </div>
            ) : null}
          </>
        ) : (
          <div className="muted" style={{ fontSize: 12 }} role="status">
            No custom-field limits available.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A single "used / max" governance bar. Amber at >= 90% usage, red once
 * the cap is reached or exceeded, accent otherwise. A trailing badge
 * surfaces the near-limit / at-limit state so it's legible without
 * parsing the bar colour.
 */
function UsageBar({
  label,
  used,
  max,
}: {
  label: string;
  used: number;
  max: number;
}): ReactElement {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const fraction = safeMax > 0 ? Math.min(used / safeMax, 1) : 0;
  const percent = safeMax > 0 ? Math.round((used / safeMax) * 100) : 0;
  const atLimit = safeMax > 0 && used >= safeMax;
  const nearLimit = !atLimit && safeMax > 0 && fraction >= WARN_FRACTION;
  const barColor = atLimit
    ? "var(--pw-danger)"
    : nearLimit
      ? "var(--pw-warning)"
      : "var(--pw-accent)";

  return (
    <div className="settings-row" style={{ alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            fontSize: 13,
            marginBottom: 4,
          }}
        >
          <span style={{ fontWeight: 600 }}>{label}</span>
          <span className="spacer" />
          <span className="tabular muted" style={{ fontSize: 12 }}>
            {used} / {max} ({percent}%)
          </span>
          {atLimit ? (
            <span className="badge danger" style={{ fontSize: 11 }}>
              At limit
            </span>
          ) : nearLimit ? (
            <span className="badge warning" style={{ fontSize: 11 }}>
              Near limit
            </span>
          ) : null}
        </div>
        <div
          role="progressbar"
          aria-valuenow={Math.max(0, Math.min(100, percent))}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} usage`}
          aria-valuetext={`${used} of ${max} fields · ${percent}% used${atLimit ? " · at limit" : nearLimit ? " · near limit" : ""}`}
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
              width: `${(fraction * 100).toFixed(1)}%`,
              height: "100%",
              background: barColor,
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function CustomFieldUsageData({
  limits,
}: {
  limits: CustomFieldLimits;
}): ReactElement {
  const rows = [
    {
      key: "total",
      label: "Total fields",
      used: limits.used_custom_fields,
      limit: limits.max_custom_fields,
    },
    {
      key: "searchable",
      label: "Searchable fields",
      used: limits.used_searchable_fields,
      limit: limits.max_searchable_fields,
    },
  ];
  return (
    <AccessibleChartData
      title="Custom-field limit usage"
      summary="Current custom-field definition usage against the effective workspace limits resolved by the server."
      rowHeaderLabel="Field class"
      columns={[
        { key: "used", label: "Fields used" },
        { key: "limit", label: "Effective limit" },
        { key: "utilization", label: "Utilization (%)" },
        { key: "status", label: "Status" },
      ]}
      rows={rows.map((row) => {
        const utilization = row.limit > 0 ? (row.used / row.limit) * 100 : null;
        const status =
          row.limit <= 0
            ? "No positive limit"
            : row.used >= row.limit
              ? "At limit"
              : utilization != null && utilization >= WARN_FRACTION * 100
                ? "Near limit"
                : "Within limit";
        return {
          key: row.key,
          label: row.label,
          values: {
            used: row.used.toLocaleString(),
            limit: row.limit.toLocaleString(),
            utilization:
              utilization == null
                ? "Not applicable"
                : `${utilization.toFixed(1)}%`,
            status,
          },
          exportValues: {
            used: row.used,
            limit: row.limit,
            utilization,
            status,
          },
        };
      })}
      provenance={dux025Provenance("customFieldUsage")}
      exportFileName="custom-field-limit-usage.csv"
      exportPrivacy="confidential"
    />
  );
}

/**
 * Parse a cap input into a non-negative integer, or null when the value
 * is blank or not a valid whole number ≥ 0. Used to distinguish "leave
 * unchanged / invalid" from a real new cap.
 */
function parseCap(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
