/**
 * AIRegressionSettings — the Settings → AI sub-section for the regression
 * harness (#1). Lets an operator:
 *
 *   - configure how the server records threshold outcomes,
 *   - set the advisory warn threshold (default 60),
 *   - trigger a regression replay with an operator correlation label (admin),
 *   - add a golden example manually (the D2 "save as reference" escape hatch).
 *
 * Honest-UI: policy outcomes are recorded evaluations, not deployment
 * enforcement receipts. Read-authorized golden evidence remains visible to
 * non-admins while settings and mutations stay behind an explicit capability.
 */
import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  api,
  type GoldenExample,
  type RegressionSettings,
} from "../../lib/api-client";
import { useBlockingLifecycleOperation } from "../../hooks/useBlockingLifecycleOperation";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { surfaceLabel } from "../../lib/regression-helpers";
import { ConfirmModal } from "../ConfirmModal";
import { Notice } from "../Notice";
import { Skeleton } from "../Skeleton";
import "../../styles-ai-regression.css";

/** GAP-2#5: change-detection over the editable fields so keyboard/blur
 *  commits don't fire redundant saves for an unchanged value. */
function sameSettings(a: RegressionSettings, b: RegressionSettings): boolean {
  return (
    a.warn_threshold === b.warn_threshold &&
    a.hard_gate_enabled === b.hard_gate_enabled &&
    a.hard_gate_threshold === b.hard_gate_threshold &&
    a.min_examples_for_gate === b.min_examples_for_gate
  );
}

const SURFACE_KINDS = [
  "campaign_draft",
  "subject_line",
  "sequence_draft",
  "campaign_summary",
  "reply_intent",
] as const;
const MAX_POLICY_EXAMPLES = 2_147_483_647;
const CAPTURE_ID_UNAVAILABLE =
  "A secure capture request identifier is unavailable. The form was retained and no reference was submitted.";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RegressionStatusVariant = "error" | "progress" | "success";

interface RegressionStatus {
  message: string;
  variant: RegressionStatusVariant;
}

function regressionStatus(
  message: string,
  variant: RegressionStatusVariant,
): RegressionStatus {
  return { message, variant };
}

function regressionStatusTone(
  variant: RegressionStatusVariant,
): "danger" | "info" | "success" {
  switch (variant) {
    case "error":
      return "danger";
    case "success":
      return "success";
    case "progress":
      return "info";
  }
}

function isolatePlainText(value: string): string {
  return `\u2068${value}\u2069`;
}

function createCaptureRequestID(): string | null {
  const secure = globalThis.crypto;
  if (!secure) return null;
  if (typeof secure.randomUUID === "function") return secure.randomUUID();
  const bytes = new Uint8Array(16);
  secure.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

interface CaptureRequestState {
  fingerprint: string;
  requestID: string;
}

function captureRequestFor(
  current: CaptureRequestState | null,
  surface: string,
  brief: string,
  output: string,
): CaptureRequestState | null {
  const fingerprint = JSON.stringify([surface, brief.trim(), output.trim()]);
  if (current?.fingerprint === fingerprint) return current;
  const requestID = createCaptureRequestID();
  return requestID ? { fingerprint, requestID } : null;
}

function hasValidTriggerReceipt(value: unknown): value is {
  run_id: string;
  status: "pending";
  runtime: {
    provider: string;
    model_id: string;
    prompt_policy_version: string;
  };
} {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.run_id !== "string" ||
    !UUID_PATTERN.test(receipt.run_id) ||
    receipt.status !== "pending" ||
    !receipt.runtime ||
    typeof receipt.runtime !== "object"
  ) {
    return false;
  }
  const runtime = receipt.runtime as Record<string, unknown>;
  return [
    runtime.provider,
    runtime.model_id,
    runtime.prompt_policy_version,
  ].every((part) => typeof part === "string" && part.trim().length > 0);
}

function reconcileGoldenExamples(
  canonical: GoldenExample[],
  include: GoldenExample[] = [],
  excludeIds: string[] = [],
): GoldenExample[] {
  const excluded = new Set(excludeIds);
  const seen = new Set<string>();
  return [...include, ...canonical]
    .filter((example) => {
      if (excluded.has(example.id) || seen.has(example.id)) return false;
      seen.add(example.id);
      return true;
    })
    .slice(0, 200);
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function GateSettingsFields({
  settings,
  loadedGoldenCount,
  goldenCountIsCapped,
  goldenCountLoading,
  goldenCountError,
  onDraft,
  onCommit,
}: {
  settings: RegressionSettings;
  loadedGoldenCount: number;
  goldenCountIsCapped: boolean;
  goldenCountLoading: boolean;
  goldenCountError: boolean;
  onDraft: (next: RegressionSettings) => void;
  onCommit: (next: RegressionSettings) => void;
}): ReactElement {
  const reachesConfiguredMinimum =
    !goldenCountLoading &&
    !goldenCountError &&
    loadedGoldenCount >= settings.min_examples_for_gate;
  const eligibilityCopy = goldenCountLoading
    ? "The golden reference count is still loading, so policy eligibility cannot be assessed yet."
    : goldenCountError
      ? "The active reference count is unavailable, so policy eligibility cannot be assessed from this view."
      : reachesConfiguredMinimum
        ? "The loaded reference count reaches the configured minimum. Actual eligibility still depends on how many examples receive scores in a replay."
        : goldenCountIsCapped
          ? "This view is capped before the configured minimum, so policy eligibility cannot be confirmed here."
          : `The loaded set is below the configured minimum by ${(settings.min_examples_for_gate - loadedGoldenCount).toLocaleString()} reference${settings.min_examples_for_gate - loadedGoldenCount === 1 ? "" : "s"}.`;

  return (
    <div className="ai-regression-settings__policy">
      <div className="ai-regression-settings__section-heading">
        <div>
          <span className="ai-regression-settings__eyebrow">Admin policy</span>
          <h3>Recorded policy evaluation</h3>
        </div>
        <span
          className={settings.hard_gate_enabled ? "badge warning" : "badge"}
        >
          {settings.hard_gate_enabled
            ? "Threshold outcome enabled"
            : "Advisory only"}
        </span>
      </div>
      <p className="muted">
        When enabled, the server can record a pass or concern after enough
        examples are scored. No deployment authority is connected to that
        outcome in this workspace.
      </p>
      <label className="ai-regression-settings__toggle">
        <input
          type="checkbox"
          checked={settings.hard_gate_enabled}
          onChange={(event) =>
            onCommit({
              ...settings,
              hard_gate_enabled: event.target.checked,
            })
          }
        />
        Record a threshold pass or concern when the replay is eligible
      </label>
      <label className="ai-regression-settings__field">
        <span>
          Concern threshold <strong>{settings.hard_gate_threshold}/100</strong>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={settings.hard_gate_threshold}
          disabled={!settings.hard_gate_enabled}
          onChange={(event) =>
            onDraft({
              ...settings,
              hard_gate_threshold: Number(event.target.value),
            })
          }
          onMouseUp={() => onCommit(settings)}
          onKeyUp={() => onCommit(settings)}
          onBlur={() => onCommit(settings)}
        />
      </label>
      <label className="ai-regression-settings__field">
        <span>
          Warning threshold <strong>{settings.warn_threshold}/100</strong>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={settings.warn_threshold}
          onChange={(event) =>
            onDraft({
              ...settings,
              warn_threshold: Number(event.target.value),
            })
          }
          onMouseUp={() => onCommit(settings)}
          onKeyUp={() => onCommit(settings)}
          onBlur={() => onCommit(settings)}
        />
      </label>
      <label className="ai-regression-settings__field ai-regression-settings__field--number">
        <span>Minimum scored examples for a threshold outcome</span>
        <input
          type="number"
          min={1}
          max={MAX_POLICY_EXAMPLES}
          step={1}
          aria-label="Minimum scored examples for policy evaluation"
          value={settings.min_examples_for_gate}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (!Number.isFinite(next)) return;
            onDraft({
              ...settings,
              min_examples_for_gate: Math.min(
                MAX_POLICY_EXAMPLES,
                Math.max(1, Math.floor(next)),
              ),
            });
          }}
          onBlur={() => onCommit(settings)}
          onKeyUp={(event) => {
            if (event.key === "Enter") onCommit(settings);
          }}
        />
      </label>
      <div className="ai-regression-settings__eligibility" role="note">
        <strong>
          {goldenCountLoading ? (
            "Loading active reference count"
          ) : goldenCountError ? (
            "Active reference count unavailable"
          ) : (
            <>
              {loadedGoldenCount.toLocaleString()}
              {goldenCountIsCapped ? "+" : ""} active references loaded
            </>
          )}
        </strong>
        <span>{eligibilityCopy}</span>
      </div>
    </div>
  );
}

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The bounded golden
   brief is intentionally focusable so keyboard users can scroll it. */
function GoldenSetPanel({
  examples,
  loading,
  error,
  onRetry,
  onArchive,
  canArchive,
}: {
  examples: GoldenExample[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onArchive: (example: GoldenExample) => void;
  canArchive: boolean;
}): ReactElement {
  let content: ReactElement;
  if (loading) {
    content = <Skeleton lines={4} aria-label="Loading golden references" />;
  } else if (error) {
    content = (
      <Notice
        tone="danger"
        title="Golden references unavailable"
        action={
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        }
      >
        {error}
      </Notice>
    );
  } else if (examples.length === 0) {
    content = (
      <Notice
        tone="neutral"
        title="No golden references yet"
        announcement="off"
      >
        Approved outputs can be saved as known-good evidence for future replays.
      </Notice>
    );
  } else {
    content = (
      <div className="ai-regression-settings__golden-list">
        {examples.map((example, index) => (
          <div
            key={example.id}
            data-testid="golden-example-row"
            className="ai-regression-settings__golden-row"
          >
            <div className="ai-regression-settings__golden-copy">
              <div className="ai-regression-settings__golden-title">
                <strong>{surfaceLabel(example.surface_kind)}</strong>
                <span className="badge">Reference {index + 1}</span>
              </div>
              <details className="ai-regression-settings__brief">
                <summary
                  aria-label={`Review brief for golden reference ${index + 1}`}
                >
                  Review reference brief
                </summary>
                {/* This pane can overflow vertically and must remain
                    keyboard-scrollable without pointer input. */}
                <p
                  className="ai-regression-forensic-block"
                  dir="auto"
                  tabIndex={0}
                >
                  {example.brief}
                </p>
              </details>
              <div className="muted ai-regression-settings__golden-meta">
                Source model{" "}
                <bdi className="ai-regression-forensic">
                  {example.model_id || "not recorded"}
                </bdi>{" "}
                · {formatCreatedAt(example.created_at)}
              </div>
            </div>
            {canArchive ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                aria-label={`Archive golden reference ${index + 1}`}
                onClick={() => onArchive(example)}
              >
                Archive
              </button>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="ai-regression-settings__golden">
      <div className="ai-regression-settings__section-heading">
        <div>
          <span className="ai-regression-settings__eyebrow">
            Readable evidence
          </span>
          <h3>Golden reference set</h3>
        </div>
        {!loading && !error ? (
          <span className="badge">
            {examples.length.toLocaleString()} loaded
          </span>
        ) : null}
      </div>
      {content}
    </div>
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-tabindex */

function useRegressionSettingsPersistence(
  instanceId: string,
  enabled: boolean,
) {
  const [settings, setSettings] = useState<RegressionSettings | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<RegressionStatus | null>(null);
  const mountedRef = useRef(false);
  const lastSavedRef = useRef<RegressionSettings | null>(null);
  const queuedSettingsRef = useRef<RegressionSettings | null>(null);
  const settingsSaveActiveRef = useRef(false);
  const settingsDrainPromiseRef = useRef<Promise<void> | null>(null);
  const currentSettingsRef = useRef<RegressionSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const settingsLoadIdRef = useRef(0);
  const settingsSnapshotEpochRef = useRef(0);
  const retainedSettingsDraftRef = useRef<RegressionSettings | null>(null);
  const [hasRetainedSettingsDraft, setHasRetainedSettingsDraft] =
    useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const clearSettingsSnapshot = useCallback((): void => {
    const live = currentSettingsRef.current;
    const saved = lastSavedRef.current;
    const interruptedDraft =
      queuedSettingsRef.current ??
      (live && saved && !sameSettings(live, saved) ? live : null);
    if (interruptedDraft) {
      retainedSettingsDraftRef.current = interruptedDraft;
      setHasRetainedSettingsDraft(true);
    }
    settingsSnapshotEpochRef.current += 1;
    setSettings(null);
    currentSettingsRef.current = null;
    lastSavedRef.current = null;
    queuedSettingsRef.current = null;
  }, []);

  const loadSettings = useCallback(async (): Promise<void> => {
    if (!enabled) {
      clearSettingsSnapshot();
      setLoading(false);
      setLoadError(null);
      return;
    }
    const loadId = ++settingsLoadIdRef.current;
    // A full settings PUT must never be based on a snapshot from a previous
    // permission epoch or a failed reload. Hide/disable the old snapshot until
    // this request establishes a fresh server acknowledgement.
    clearSettingsSnapshot();
    setLoading(true);
    setLoadError(null);
    setStatus(null);
    try {
      const res = await api.getRegressionSettings();
      if (!mountedRef.current || loadId !== settingsLoadIdRef.current) return;
      if (res.error) {
        clearSettingsSnapshot();
        setLoadError(res.error.message || "Could not load settings.");
        return;
      }
      if (!res.data) {
        clearSettingsSnapshot();
        setLoadError("The server returned no regression settings.");
        return;
      }
      setSettings(res.data);
      currentSettingsRef.current = res.data;
      lastSavedRef.current = res.data;
    } catch {
      if (mountedRef.current && loadId === settingsLoadIdRef.current) {
        clearSettingsSnapshot();
        setLoadError(
          "Could not load settings. Check your connection and retry.",
        );
      }
    } finally {
      if (mountedRef.current && loadId === settingsLoadIdRef.current) {
        setLoading(false);
      }
    }
  }, [clearSettingsSnapshot, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) void loadSettings();
    else {
      clearSettingsSnapshot();
      setLoading(false);
      setLoadError(null);
    }
    return () => {
      mountedRef.current = false;
      settingsLoadIdRef.current += 1;
    };
  }, [clearSettingsSnapshot, enabled, loadSettings]);

  const flushSettingsSaves = useCallback((): Promise<void> => {
    if (settingsDrainPromiseRef.current) return settingsDrainPromiseRef.current;
    let drain!: Promise<void>;
    drain = Promise.resolve().then(async (): Promise<void> => {
      settingsSaveActiveRef.current = true;
      if (mountedRef.current) setSettingsSaving(true);
      let finalFailure: string | null = null;
      try {
        while (queuedSettingsRef.current) {
          const next = queuedSettingsRef.current;
          queuedSettingsRef.current = null;
          if (!enabledRef.current) {
            finalFailure =
              "Administrator access is required to save regression settings.";
            if (mountedRef.current) {
              setStatus(regressionStatus(finalFailure, "error"));
            }
            break;
          }
          try {
            const requestEpoch = settingsSnapshotEpochRef.current;
            const res = await api.updateRegressionSettings(next);
            if (res.error) {
              finalFailure =
                res.error.message || "Could not save regression settings.";
              if (mountedRef.current) {
                setStatus(regressionStatus(finalFailure, "error"));
              }
              continue;
            }
            if (!res.data) {
              finalFailure =
                "The server returned no settings acknowledgement. Your edit remains unsaved.";
              if (mountedRef.current) {
                setStatus(regressionStatus(finalFailure, "error"));
              }
              continue;
            }
            finalFailure = null;
            const saved = res.data;
            if (
              retainedSettingsDraftRef.current &&
              sameSettings(saved, retainedSettingsDraftRef.current)
            ) {
              retainedSettingsDraftRef.current = null;
              if (mountedRef.current) setHasRetainedSettingsDraft(false);
            }
            if (
              requestEpoch === settingsSnapshotEpochRef.current &&
              enabledRef.current
            ) {
              lastSavedRef.current = saved;
              if (!queuedSettingsRef.current) {
                currentSettingsRef.current = saved;
                if (mountedRef.current) setSettings(saved);
              }
            }
            if (mountedRef.current) {
              const hasRetainedDraft = Boolean(
                retainedSettingsDraftRef.current,
              );
              const hasQueuedSettings = Boolean(queuedSettingsRef.current);
              setStatus(
                regressionStatus(
                  hasRetainedDraft
                    ? "The submitted settings were saved; a newer interrupted edit remains retained for explicit discard."
                    : hasQueuedSettings
                      ? "Saving newer settings…"
                      : "Settings saved.",
                  hasQueuedSettings ? "progress" : "success",
                ),
              );
            }
          } catch {
            finalFailure =
              "Could not save regression settings. Check your connection and retry.";
            if (mountedRef.current) {
              setStatus(regressionStatus(finalFailure, "error"));
            }
          }
        }
        if (finalFailure) throw new Error(finalFailure);
      } finally {
        settingsSaveActiveRef.current = false;
        if (settingsDrainPromiseRef.current === drain) {
          settingsDrainPromiseRef.current = null;
        }
        if (mountedRef.current) setSettingsSaving(false);
      }
    });
    settingsDrainPromiseRef.current = drain;
    return drain;
  }, []);

  function save(next: RegressionSettings): void {
    if (!enabledRef.current) {
      setStatus(
        regressionStatus(
          "Administrator access is required to save regression settings.",
          "error",
        ),
      );
      return;
    }
    if (retainedSettingsDraftRef.current) {
      setStatus(
        regressionStatus(
          "Discard the settings edit retained from the earlier permission epoch before saving another full policy snapshot.",
          "error",
        ),
      );
      return;
    }
    const queued = queuedSettingsRef.current;
    if (queued && sameSettings(next, queued)) return;
    if (
      !settingsSaveActiveRef.current &&
      !queued &&
      lastSavedRef.current &&
      sameSettings(next, lastSavedRef.current)
    ) {
      return;
    }
    currentSettingsRef.current = next;
    setSettings(next);
    setStatus(regressionStatus("Saving settings…", "progress"));
    queuedSettingsRef.current = next;
    void flushSettingsSaves().catch(() => undefined);
  }

  const draftSettings = useCallback((next: RegressionSettings): void => {
    currentSettingsRef.current = next;
    setSettings(next);
  }, []);
  const persistSettings = useCallback(async (): Promise<void> => {
    if (retainedSettingsDraftRef.current) {
      throw new Error(
        "A settings edit from an earlier permission epoch must be discarded before continuing.",
      );
    }
    const current = currentSettingsRef.current;
    const baseline = lastSavedRef.current;
    if (current && (!baseline || !sameSettings(current, baseline))) {
      queuedSettingsRef.current = current;
      if (mountedRef.current) {
        setStatus(regressionStatus("Saving settings…", "progress"));
      }
    }
    await flushSettingsSaves();
  }, [flushSettingsSaves]);
  const discardSettings = useCallback((): void => {
    if (settingsSaveActiveRef.current) {
      throw new Error("settings save is still active");
    }
    queuedSettingsRef.current = null;
    retainedSettingsDraftRef.current = null;
    setHasRetainedSettingsDraft(false);
    const baseline = lastSavedRef.current;
    currentSettingsRef.current = baseline;
    if (baseline && mountedRef.current) setSettings(baseline);
    if (mountedRef.current) {
      setStatus(regressionStatus("Unsaved settings discarded.", "success"));
    }
  }, []);

  useEffect(() => {
    const current = currentSettingsRef.current;
    const baseline = lastSavedRef.current;
    const dirty = Boolean(
      current && baseline && !sameSettings(current, baseline),
    );
    if (
      !dirty &&
      !settingsSaving &&
      !queuedSettingsRef.current &&
      !hasRetainedSettingsDraft
    ) {
      return;
    }
    return registerLifecycleGuard({
      id: `ai-regression-settings-${instanceId}`,
      label: "AI regression settings",
      inspect: (intent) => {
        if (intent.disposition === "hide") return null;
        const live = currentSettingsRef.current;
        const saved = lastSavedRef.current;
        const hasDraft = Boolean(live && saved && !sameSettings(live, saved));
        const hasRetainedDraft = retainedSettingsDraftRef.current !== null;
        const active =
          settingsSaveActiveRef.current ||
          settingsDrainPromiseRef.current !== null ||
          queuedSettingsRef.current !== null;
        if (!hasDraft && !hasRetainedDraft && !active) return null;
        return {
          level: active ? "warning" : "blocking",
          detail: active
            ? "Wait for the queued AI regression settings save, or use Save and continue to drain it before leaving."
            : hasRetainedDraft
              ? "An AI regression settings edit was retained after administrator access or its server baseline changed. It cannot be replayed safely; explicitly discard it before leaving."
              : "AI regression settings differ from the last server acknowledgement.",
          canSave: enabled && !hasRetainedDraft,
          canDiscard: !active,
        };
      },
      prepare: persistSettings,
      discard: discardSettings,
    });
  }, [
    discardSettings,
    enabled,
    hasRetainedSettingsDraft,
    instanceId,
    persistSettings,
    settings,
    settingsSaving,
  ]);

  return {
    draftSettings,
    loadError,
    loading,
    loadSettings,
    save,
    settings,
    setStatus,
    status,
  };
}

function useAIRegressionController(canAdmin: boolean) {
  const instanceId = useId();
  const {
    draftSettings,
    loadError,
    loading,
    loadSettings,
    save,
    settings,
    setStatus,
    status,
  } = useRegressionSettingsPersistence(instanceId, canAdmin);
  const mountedRef = useRef(false);

  // Trigger-run form.
  const [modelTag, setModelTag] = useState("");
  const [triggering, setTriggering] = useState(false);
  const triggeringRef = useRef(false);

  // Manual golden-example form.
  const [surface, setSurface] = useState<string>(SURFACE_KINDS[0]);
  const [brief, setBrief] = useState("");
  const [output, setOutput] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const captureRequestRef = useRef<CaptureRequestState | null>(null);
  const [draftDiscardConfirmOpen, setDraftDiscardConfirmOpen] = useState(false);

  // Golden-set management. Archive is a soft delete on the backend, but it
  // changes future regression evidence, so it still requires confirmation.
  const [goldenExamples, setGoldenExamples] = useState<GoldenExample[]>([]);
  const [goldenLoading, setGoldenLoading] = useState(true);
  const [goldenError, setGoldenError] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] = useState<GoldenExample | null>(
    null,
  );
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveBusyRef = useRef(false);
  const goldenLoadIdRef = useRef(0);
  const loadGoldenExamples = useCallback(
    async (reconciliation?: {
      include?: GoldenExample[];
      excludeIds?: string[];
    }): Promise<void> => {
      const loadId = ++goldenLoadIdRef.current;
      setGoldenLoading(true);
      setGoldenError(null);
      try {
        const res = await api.listGoldenExamples({ limit: 200 });
        if (!mountedRef.current || loadId !== goldenLoadIdRef.current) return;
        if (res.error) {
          setGoldenError(
            res.error.message || "Could not load golden examples.",
          );
          return;
        }
        if (!res.data || !Array.isArray(res.data.items)) {
          setGoldenError(
            "The server returned an invalid golden-reference receipt.",
          );
          return;
        }
        setGoldenError(null);
        setGoldenExamples(
          reconcileGoldenExamples(
            res.data.items,
            reconciliation?.include,
            reconciliation?.excludeIds,
          ),
        );
      } catch {
        if (mountedRef.current && loadId === goldenLoadIdRef.current) {
          setGoldenError(
            "Could not load golden examples. Check your connection and retry.",
          );
        }
      } finally {
        if (mountedRef.current && loadId === goldenLoadIdRef.current) {
          setGoldenLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void loadGoldenExamples();
    return () => {
      mountedRef.current = false;
      goldenLoadIdRef.current += 1;
    };
  }, [loadGoldenExamples]);

  const localDraftDirty =
    modelTag !== "" ||
    surface !== SURFACE_KINDS[0] ||
    brief !== "" ||
    output !== "";
  const localDraftDirtyRef = useRef(localDraftDirty);
  localDraftDirtyRef.current = localDraftDirty;
  const discardLocalDraft = useCallback((): void => {
    localDraftDirtyRef.current = false;
    setModelTag("");
    setSurface(SURFACE_KINDS[0]);
    setBrief("");
    setOutput("");
    captureRequestRef.current = null;
    setDraftDiscardConfirmOpen(false);
    setStatus(
      regressionStatus("Unsaved AI regression draft discarded.", "success"),
    );
  }, []);

  useEffect(() => {
    if (!localDraftDirty || triggering || saving) return;
    return registerLifecycleGuard({
      id: `ai-regression-local-draft-${instanceId}`,
      label: "AI regression draft",
      inspect: (intent) =>
        !localDraftDirtyRef.current || intent.disposition === "hide"
          ? null
          : {
              level: "blocking",
              detail:
                "The replay correlation label or manual golden example has not been submitted. Return to the form or explicitly discard it.",
              canSave: false,
              canDiscard: true,
            },
      discard: discardLocalDraft,
    });
  }, [discardLocalDraft, instanceId, localDraftDirty, saving, triggering]);

  useBlockingLifecycleOperation(
    `ai-regression-operation-${instanceId}`,
    "AI regression operation",
    triggering || saving || archiveBusy,
  );

  async function triggerRun(): Promise<void> {
    if (!canAdmin) {
      setStatus(
        regressionStatus(
          "Administrator access is required to request a replay.",
          "error",
        ),
      );
      return;
    }
    if (triggeringRef.current) return;
    if (!modelTag.trim()) {
      setStatus(
        regressionStatus("Enter an operator correlation label first.", "error"),
      );
      return;
    }
    triggeringRef.current = true;
    setTriggering(true);
    try {
      const res = await api.triggerRegressionRun({
        model_version_tag: modelTag.trim(),
      });
      if (!mountedRef.current) return;
      if (res.error) {
        setStatus(
          regressionStatus(
            res.error.message || "Could not trigger a regression run.",
            "error",
          ),
        );
        return;
      }
      if (!hasValidTriggerReceipt(res.data)) {
        setStatus(
          regressionStatus(
            "The server returned an invalid replay receipt. The request cannot be shown as accepted; keep the operator correlation label and verify the run ledger before retrying.",
            "error",
          ),
        );
        return;
      }
      setModelTag("");
      setStatus(
        regressionStatus(
          `Replay request accepted as pending (${isolatePlainText(res.data.run_id)}). Server-attested runtime receipt: provider ${isolatePlainText(res.data.runtime.provider)} / model ID ${isolatePlainText(res.data.runtime.model_id)} / prompt policy ${isolatePlainText(res.data.runtime.prompt_policy_version)}.`,
          "success",
        ),
      );
    } catch {
      if (mountedRef.current) {
        setStatus(
          regressionStatus(
            "Could not trigger a regression run. Check your connection and retry.",
            "error",
          ),
        );
      }
    } finally {
      triggeringRef.current = false;
      if (mountedRef.current) setTriggering(false);
    }
  }

  async function saveGolden(): Promise<void> {
    if (!canAdmin) {
      setStatus(
        regressionStatus(
          "Administrator access is required to add a golden reference.",
          "error",
        ),
      );
      return;
    }
    if (savingRef.current) return;
    if (!brief.trim() || !output.trim()) {
      setStatus(
        regressionStatus(
          "Brief and approved output are both required.",
          "error",
        ),
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const captureRequest = captureRequestFor(
        captureRequestRef.current,
        surface,
        brief,
        output,
      );
      if (!captureRequest) {
        setStatus(regressionStatus(CAPTURE_ID_UNAVAILABLE, "error"));
        return;
      }
      captureRequestRef.current = captureRequest;
      const res = await api.captureGoldenExample({
        request_id: captureRequest.requestID,
        surface_kind: surface,
        brief: brief.trim(),
        approved_output: output.trim(),
      });
      if (!mountedRef.current) return;
      if (res.error) {
        setStatus(
          regressionStatus(
            res.error.message || "Could not save the golden example.",
            "error",
          ),
        );
        return;
      }
      if (!res.data) {
        setStatus(
          regressionStatus(
            "The server returned no golden-reference receipt. The form was retained; verify the corpus before retrying.",
            "error",
          ),
        );
        return;
      }
      setSurface(SURFACE_KINDS[0]);
      setBrief("");
      setOutput("");
      captureRequestRef.current = null;
      void loadGoldenExamples({ include: [res.data] });
      setStatus(
        regressionStatus(
          "Golden reference saved. Refreshing the canonical corpus…",
          "success",
        ),
      );
    } catch {
      if (mountedRef.current) {
        setStatus(
          regressionStatus(
            "Could not save the golden example. Check your connection and retry.",
            "error",
          ),
        );
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  async function confirmArchive(): Promise<void> {
    if (!canAdmin) {
      setPendingArchive(null);
      setStatus(
        regressionStatus(
          "Administrator access is required to archive a golden reference.",
          "error",
        ),
      );
      return;
    }
    if (!pendingArchive || archiveBusyRef.current) return;
    const archived = pendingArchive;
    archiveBusyRef.current = true;
    setArchiveBusy(true);
    try {
      const res = await api.archiveGoldenExample(archived.id);
      if (!mountedRef.current) return;
      if (res.error) {
        setStatus(
          regressionStatus(
            res.error.message || "Could not archive the golden example.",
            "error",
          ),
        );
        return;
      }
      setPendingArchive(null);
      void loadGoldenExamples({ excludeIds: [archived.id] });
      setStatus(
        regressionStatus(
          "Golden reference archived. Refreshing the canonical corpus…",
          "success",
        ),
      );
    } catch {
      if (mountedRef.current) {
        setStatus(
          regressionStatus(
            "Could not archive the golden example. Check your connection and retry.",
            "error",
          ),
        );
      }
    } finally {
      archiveBusyRef.current = false;
      if (mountedRef.current) setArchiveBusy(false);
    }
  }

  return {
    actions: {
      confirmArchive,
      discardLocalDraft,
      draftSettings,
      loadGoldenExamples,
      loadSettings,
      save,
      saveGolden,
      triggerRun,
    },
    data: {
      canAdmin,
      goldenError,
      goldenExamples,
      goldenLoading,
      loadError,
      loading,
      settings,
      status,
    },
    draft: {
      brief,
      localDraftDirty,
      modelTag,
      output,
      setBrief,
      setModelTag,
      setOutput,
      setSurface,
      surface,
    },
    operations: { archiveBusy, saving, triggering },
    overlays: {
      draftDiscardConfirmOpen,
      pendingArchive,
      setDraftDiscardConfirmOpen,
      setPendingArchive,
    },
  };
}

type AIRegressionController = ReturnType<typeof useAIRegressionController>;

export function AIRegressionSettings({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const controller = useAIRegressionController(canAdmin);
  return <AIRegressionSettingsView controller={controller} />;
}

function AIRegressionSettingsView({
  controller,
}: {
  controller: AIRegressionController;
}): ReactElement {
  const { actions, data, draft, operations, overlays } = controller;
  const {
    confirmArchive,
    discardLocalDraft,
    draftSettings,
    loadGoldenExamples,
    loadSettings,
    save,
    saveGolden,
    triggerRun,
  } = actions;
  const {
    canAdmin,
    goldenError,
    goldenExamples,
    goldenLoading,
    loadError,
    loading,
    settings,
    status,
  } = data;
  const {
    brief,
    localDraftDirty,
    modelTag,
    output,
    setBrief,
    setModelTag,
    setOutput,
    setSurface,
    surface,
  } = draft;
  const { archiveBusy, saving, triggering } = operations;
  const {
    draftDiscardConfirmOpen,
    pendingArchive,
    setDraftDiscardConfirmOpen,
    setPendingArchive,
  } = overlays;
  return (
    <section
      data-testid="ai-regression-settings"
      className="ai-regression-settings"
      data-capability={canAdmin ? "admin" : "read-only"}
    >
      <Notice
        tone="info"
        title="Policy evidence is advisory to deployment"
        announcement="off"
      >
        Settings below affect the policy outcome stored with a replay. This
        application does not currently receive an enforcement receipt from a
        deployment authority.
      </Notice>

      {canAdmin ? (
        <div className="ai-regression-settings__admin-grid">
          <article className="ai-regression-settings__card">
            {loading ? (
              <Skeleton
                lines={5}
                aria-label="Loading AI regression policy settings"
              />
            ) : settings ? (
              <GateSettingsFields
                settings={settings}
                loadedGoldenCount={goldenExamples.length}
                goldenCountIsCapped={goldenExamples.length >= 200}
                goldenCountLoading={goldenLoading}
                goldenCountError={Boolean(goldenError)}
                onDraft={draftSettings}
                onCommit={save}
              />
            ) : (
              <Notice
                tone="danger"
                title="Policy settings unavailable"
                action={
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void loadSettings()}
                  >
                    Retry settings
                  </button>
                }
              >
                {loadError ?? "Could not load AI regression policy settings."}
              </Notice>
            )}
          </article>

          <article className="ai-regression-settings__card">
            <div className="ai-regression-settings__section-heading">
              <div>
                <span className="ai-regression-settings__eyebrow">
                  Admin action
                </span>
                <h3>Request a replay</h3>
              </div>
            </div>
            <p className="muted">
              Add an operator correlation label for this replay request. The
              label neither selects nor attests a model; an accepted receipt
              separately records the server-attested runtime identity. Pending
              acceptance is not proof that a worker started.
            </p>
            <div className="ai-regression-settings__replay-form">
              <label>
                <span>Operator correlation label</span>
                <input
                  type="text"
                  aria-label="Operator correlation label"
                  placeholder="e.g. release-2026-06-15-a"
                  value={modelTag}
                  onChange={(event) => setModelTag(event.target.value)}
                  maxLength={160}
                />
                <small className="muted">160 character limit</small>
              </label>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void triggerRun()}
                disabled={triggering}
              >
                {triggering ? "Requesting…" : "Request replay"}
              </button>
            </div>
          </article>

          <article className="ai-regression-settings__card ai-regression-settings__card--wide">
            <div className="ai-regression-settings__section-heading">
              <div>
                <span className="ai-regression-settings__eyebrow">
                  Admin evidence
                </span>
                <h3>Add a golden reference</h3>
              </div>
            </div>
            <p className="muted">
              Save a known-good brief and approved output as frozen side-by-side
              evidence. The evaluator scores replayed output against the
              qualified voice profile, not against this approved text.
            </p>
            <div className="ai-regression-settings__golden-form">
              <label>
                <span>Surface</span>
                <select
                  aria-label="Golden example surface"
                  value={surface}
                  onChange={(event) => setSurface(event.target.value)}
                >
                  {SURFACE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {surfaceLabel(kind)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Brief or prompt</span>
                <textarea
                  aria-label="Golden example brief"
                  placeholder="Brief / prompt"
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  maxLength={8000}
                  rows={3}
                />
              </label>
              <label>
                <span>Approved output</span>
                <textarea
                  aria-label="Golden example approved output"
                  placeholder="Approved output"
                  value={output}
                  onChange={(event) => setOutput(event.target.value)}
                  maxLength={32000}
                  rows={5}
                />
              </label>
            </div>
            <div className="ai-regression-settings__actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveGolden()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save golden reference"}
              </button>
              {localDraftDirty ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={saving || triggering}
                  onClick={() => setDraftDiscardConfirmOpen(true)}
                >
                  Discard local draft
                </button>
              ) : null}
            </div>
          </article>
        </div>
      ) : (
        <Notice
          tone="neutral"
          title="Read-only regression evidence"
          announcement="off"
          action={
            localDraftDirty ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setDraftDiscardConfirmOpen(true)}
              >
                Discard retained draft
              </button>
            ) : undefined
          }
        >
          Golden references remain visible. Policy settings, replay requests,
          capture, and archive actions require administrator access.
        </Notice>
      )}

      <GoldenSetPanel
        examples={goldenExamples}
        loading={goldenLoading}
        error={goldenError}
        onRetry={() => void loadGoldenExamples()}
        onArchive={setPendingArchive}
        canArchive={canAdmin}
      />

      {status ? (
        <Notice
          className="ai-regression-settings__status"
          data-testid="ai-regression-settings-status"
          tone={regressionStatusTone(status.variant)}
          announcement={status.variant === "error" ? "assertive" : "polite"}
        >
          {status.message}
        </Notice>
      ) : null}
      <ConfirmModal
        open={draftDiscardConfirmOpen}
        title="Discard AI regression draft?"
        description="This clears the replay correlation label and every unsaved manual golden-reference field. No run or reference will be submitted."
        confirmLabel="Discard draft"
        danger
        busy={saving || triggering}
        onConfirm={discardLocalDraft}
        onClose={() => setDraftDiscardConfirmOpen(false)}
      />
      <ConfirmModal
        key={pendingArchive?.id ?? "closed"}
        open={pendingArchive !== null}
        title="Archive golden reference?"
        description={
          pendingArchive
            ? `Archive this ${surfaceLabel(pendingArchive.surface_kind).toLocaleLowerCase()} reference? It will be excluded from future regression runs.`
            : ""
        }
        confirmLabel="Archive reference"
        danger
        busy={archiveBusy}
        onConfirm={confirmArchive}
        onClose={() => setPendingArchive(null)}
      />
    </section>
  );
}
