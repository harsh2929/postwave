/**
 * GrowthPanel — per-form onsite-growth admin slideover (backlog #49).
 * Opened from a form tile on the Forms page.
 *
 * Backend surface (apps/api/internal/onsite_growth):
 *   GET  /onsite-growth/catalog
 *   POST /onsite-growth/validate                 {targeting|experiment|spin_rewards}
 *   GET/PUT /onsite-growth/forms/{id}/targeting
 *   GET  /onsite-growth/forms/{id}/experiments
 *   PUT  /onsite-growth/forms/{id}/experiments/{key}
 *   GET/PUT /onsite-growth/forms/{id}/spin/rewards   (PUT = full replace, admin)
 *
 * Wire-shape honesty: targeting rule groups are opaque JSON objects on
 * the wire (Record<string, unknown>), so the panel edits them as raw
 * JSON per group and runs the server validator BEFORE every save —
 * PUT itself also 422s with the validation payload, which surfaces as
 * a generic error, hence the explicit pre-validate step.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import { ConfirmModal } from "../ConfirmModal";
import { SlideoverShell } from "../SlideoverShell";
import { toast } from "../Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import {
  type OnsiteExperiment,
  type OnsiteGrowthCatalog,
  type OnsiteSpinReward,
  type OnsiteValidationResponse,
  onsiteGrowthApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import {
  MAX_EXPERIMENT_VARIANTS,
  type SpinRewardDraft,
  TARGETING_RULE_GROUPS,
  type VariantDraft,
  buildSpinRewardsInput,
  buildTargetingInput,
  buildVariantsInput,
  experimentEventTotals,
  fmtBasisPoints,
  newSpinRewardDraft,
  newVariantDraft,
  ruleGroupText,
  spinDraftWeightSummary,
  spinRewardToDraft,
  spinWeightSummary,
  variantDraftWeightSummary,
  variantToDraft,
} from "./growth-helpers";

type Tab = "targeting" | "experiments" | "spin";
const GROWTH_TABS: readonly { value: Tab; label: string }[] = [
  { value: "targeting", label: "Targeting" },
  { value: "experiments", label: "Experiments" },
  { value: "spin", label: "Spin-to-win" },
];

interface GrowthOwnerState {
  dirty: boolean;
  busy: boolean;
}

type GrowthOwnerStateReporter = (tab: Tab, state: GrowthOwnerState) => void;

interface Props {
  formId: string;
  formName: string;
  canMutate: boolean;
  onClose: () => void;
}

function ValidationNotice({
  v,
}: {
  v: OnsiteValidationResponse | null;
}): ReactElement | null {
  if (!v) return null;
  if (v.valid && !v.warnings?.length) return null;
  return (
    <div className="notice" role="alert" style={{ marginBottom: 10 }}>
      <span style={{ fontSize: 12 }}>
        {!v.valid && v.errors?.length ? (
          <>
            <strong>Validation failed:</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {v.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </>
        ) : null}
        {v.warnings?.length ? (
          <>
            <strong>Warnings:</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {v.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function GrowthPanel({
  formId,
  formName,
  canMutate,
  onClose,
}: Props): ReactElement {
  const [tab, setTab] = useState<Tab>("targeting");
  const [catalog, setCatalog] = useState<OnsiteGrowthCatalog | null>(null);
  const [ownerStates, setOwnerStates] = useState<
    Partial<Record<Tab, GrowthOwnerState>>
  >({});
  const [confirmClose, setConfirmClose] = useState(false);
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: GROWTH_TABS,
    onChange: setTab,
  });

  const reportOwnerState = useCallback<GrowthOwnerStateReporter>(
    (owner, state) => {
      setOwnerStates((current) => {
        const previous = current[owner];
        if (previous?.dirty === state.dirty && previous.busy === state.busy) {
          return current;
        }
        return { ...current, [owner]: state };
      });
    },
    [],
  );
  const anyDirty = Object.values(ownerStates).some((state) => state?.dirty);
  const anyBusy = Object.values(ownerStates).some((state) => state?.busy);
  const requestClose = (): void => {
    if (anyBusy) return;
    if (anyDirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  useEffect(() => {
    void (async () => {
      const res = await onsiteGrowthApi.catalog();
      if (!res.error) setCatalog(res.data ?? null);
    })();
  }, []);

  return (
    <SlideoverShell
      open
      onClose={requestClose}
      size="lg"
      eyebrow="Onsite growth"
      title={formName || "Form"}
      subtitle="Targeting rules, experiments, and spin-to-win rewards for this form."
    >
      <div
        ref={tabs.listRef}
        {...tabs.listProps}
        aria-label="Growth sections"
        style={{ display: "flex", gap: 6, marginBottom: 14 }}
      >
        {GROWTH_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            {...tabs.getTabProps(item.value)}
            className={`chip${tab === item.value ? " is-active" : ""}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div {...tabs.getPanelProps("targeting")}>
        <TargetingTab
          formId={formId}
          canMutate={canMutate}
          catalog={catalog}
          onLifecycleState={reportOwnerState}
        />
      </div>
      <div {...tabs.getPanelProps("experiments")}>
        <ExperimentsTab
          formId={formId}
          canMutate={canMutate}
          catalog={catalog}
          onLifecycleState={reportOwnerState}
        />
      </div>
      <div {...tabs.getPanelProps("spin")}>
        <SpinTab formId={formId} onLifecycleState={reportOwnerState} />
      </div>
      <ConfirmModal
        open={confirmClose}
        title="Discard onsite-growth changes?"
        description="Unsaved targeting, experiment, or spin-reward changes will be discarded when this panel closes."
        confirmLabel="Discard and close"
        danger
        busy={anyBusy}
        onConfirm={onClose}
        onClose={() => {
          if (!anyBusy) setConfirmClose(false);
        }}
      />
    </SlideoverShell>
  );
}

/* ---------- targeting --------------------------------------------------- */

function TargetingTab({
  formId,
  canMutate,
  catalog,
  onLifecycleState,
}: {
  formId: string;
  canMutate: boolean;
  catalog: OnsiteGrowthCatalog | null;
  onLifecycleState: GrowthOwnerStateReporter;
}): ReactElement {
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [status, setStatus] = useState("active");
  const [priority, setPriority] = useState(0);
  const [groupTexts, setGroupTexts] = useState<Record<string, string>>({});
  const [groupErr, setGroupErr] = useState<{
    group: string;
    error: string;
  } | null>(null);
  const [validation, setValidation] = useState<OnsiteValidationResponse | null>(
    null,
  );
  const [exists, setExists] = useState(false);
  const [baseline, setBaseline] = useState<{
    status: string;
    priority: number;
    groupTexts: Record<string, string>;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const res = await onsiteGrowthApi.getTargeting(formId);
      setLoading(false);
      if (res.error) {
        if (res.error.status === 404) {
          // No rules yet — start from the empty defaults.
          setExists(false);
          setBaseline({ status: "active", priority: 0, groupTexts: {} });
          return;
        }
        setLoadErr(res.error.message);
        return;
      }
      const t = res.data;
      if (!t) return;
      setExists(true);
      setStatus(t.status ?? "active");
      setPriority(typeof t.priority === "number" ? t.priority : 0);
      const texts: Record<string, string> = {};
      for (const g of TARGETING_RULE_GROUPS) {
        texts[g.key] = ruleGroupText(
          t[g.key] as Record<string, unknown> | undefined,
        );
      }
      setGroupTexts(texts);
      setBaseline({
        status: t.status ?? "active",
        priority: typeof t.priority === "number" ? t.priority : 0,
        groupTexts: texts,
      });
    })();
  }, [formId]);

  const save = async (): Promise<boolean> => {
    setGroupErr(null);
    setValidation(null);
    const built = buildTargetingInput({ status, priority }, groupTexts);
    if (!built.ok) {
      setGroupErr({ group: built.group, error: built.error });
      return false;
    }
    // Pre-validate: PUT also 422s, but its body surfaces as a generic
    // error — the explicit validate call gets us the field-level list.
    const check = await onsiteGrowthApi.validate({ targeting: built.input });
    if (check.error) {
      toast.error(`Validation call failed: ${check.error.message}`);
      return false;
    }
    setValidation(check.data ?? null);
    if (check.data && !check.data.valid) {
      return false;
    }
    const res = await onsiteGrowthApi.putTargeting(formId, built.input);
    if (res.error) {
      toast.error(`Save failed: ${res.error.message}`);
      return false;
    }
    setExists(true);
    setBaseline({ status, priority, groupTexts });
    toast.success("Targeting rules saved");
    return true;
  };

  const dirty =
    baseline !== null &&
    JSON.stringify({ status, priority, groupTexts }) !==
      JSON.stringify(baseline);
  const lifecycle = useDraftLifecycleController({
    ownerId: `onsite-targeting-${formId}`,
    label: exists ? "Onsite targeting changes" : "New onsite targeting draft",
    mode: exists ? "edit" : "create",
    enabled: baseline !== null && !loadErr,
    dirty,
    save,
    discard: () => {
      if (!baseline) return;
      setStatus(baseline.status);
      setPriority(baseline.priority);
      setGroupTexts(baseline.groupTexts);
      setGroupErr(null);
      setValidation(null);
    },
    detail: exists
      ? "These onsite targeting changes have not been saved."
      : "These targeting rules have not been created. Return to the editor or explicitly discard them.",
    operationDetail:
      "Wait for the onsite-targeting request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(
          error,
          "The targeting rules couldn't be saved.",
        ),
      ),
  });

  useEffect(() => {
    onLifecycleState("targeting", { dirty, busy: lifecycle.active });
  }, [dirty, lifecycle.active, onLifecycleState]);

  if (loading) return <p className="muted">Loading targeting rules…</p>;
  if (loadErr) return <p className="field-error">{loadErr}</p>;

  const triggerKeys = catalog?.trigger_types?.map((t) => t.key) ?? [];

  return (
    <div>
      {!exists ? (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          No targeting rules saved for this form yet — the editors below start
          empty. Leave a group blank to skip it.
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label className="field-label" htmlFor="growth-targeting-status">
            Status
          </label>
          <select
            id="growth-targeting-status"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {["active", "paused", "draft"]
              .concat(
                ["active", "paused", "draft"].includes(status) ? [] : [status],
              )
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </select>
        </div>
        <div className="field" style={{ width: 140, marginBottom: 0 }}>
          <label className="field-label" htmlFor="growth-targeting-priority">
            Priority
          </label>
          <input
            id="growth-targeting-priority"
            type="number"
            className="input"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) || 0)}
          />
        </div>
      </div>

      {triggerKeys.length > 0 ? (
        <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          Trigger types this deployment supports: {triggerKeys.join(", ")}
        </div>
      ) : null}

      {TARGETING_RULE_GROUPS.map((g) => (
        <div className="field" key={g.key}>
          <label className="field-label" htmlFor={`growth-rule-${g.key}`}>
            {g.label} <span className="muted">(JSON)</span>
          </label>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            {g.hint}
          </div>
          <textarea
            id={`growth-rule-${g.key}`}
            className="input mono"
            rows={groupTexts[g.key] ? 4 : 2}
            placeholder="{ } — leave blank for no rules"
            value={groupTexts[g.key] ?? ""}
            style={{ fontSize: 11 }}
            onChange={(e) =>
              setGroupTexts((prev) => ({ ...prev, [g.key]: e.target.value }))
            }
          />
          {groupErr?.group === g.key ? (
            <div className="field-error">{groupErr.error}</div>
          ) : null}
        </div>
      ))}

      <ValidationNotice v={validation} />

      <button
        type="button"
        className={`btn btn-primary${canMutate ? "" : " pw-discoverable-unavailable"}`}
        onClick={() => {
          if (canMutate) void lifecycle.submit();
        }}
        disabled={lifecycle.active}
        aria-disabled={!canMutate || lifecycle.active || undefined}
        aria-describedby="growth-targeting-save-description"
      >
        {lifecycle.active ? "Validating + saving…" : "Validate + save"}
      </button>
      <div
        id="growth-targeting-save-description"
        className="muted"
        role="status"
        style={{ fontSize: 11, marginTop: 6 }}
      >
        {canMutate
          ? "Validates every rule group on the server before replacing this form's targeting configuration."
          : "Read-only access: write permission is required to change targeting."}
      </div>
    </div>
  );
}

/* ---------- experiments -------------------------------------------------- */

interface ExperimentDraft {
  key: string;
  name: string;
  status: string;
  allocation_mode: string;
  winner_metric: string;
  /** Structured variant rows (ONS-02 visual editor — replaces the old
   *  raw-JSON textarea). */
  variants: VariantDraft[];
}

const EMPTY_EXPERIMENT_DRAFT: ExperimentDraft = {
  key: "",
  name: "",
  status: "draft",
  allocation_mode: "",
  winner_metric: "",
  variants: [],
};

function ExperimentsTab({
  formId,
  canMutate,
  catalog,
  onLifecycleState,
}: {
  formId: string;
  canMutate: boolean;
  catalog: OnsiteGrowthCatalog | null;
  onLifecycleState: GrowthOwnerStateReporter;
}): ReactElement {
  const [items, setItems] = useState<OnsiteExperiment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExperimentDraft | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<ExperimentDraft | null>(
    null,
  );
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const [validation, setValidation] = useState<OnsiteValidationResponse | null>(
    null,
  );

  const load = useCallback(async (): Promise<void> => {
    const res = await onsiteGrowthApi.listExperiments(formId);
    if (res.error) {
      setErr(res.error.message);
      setItems([]);
      return;
    }
    setErr(null);
    setItems(res.data?.items ?? []);
  }, [formId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (exp?: OnsiteExperiment): void => {
    setValidation(null);
    setDraftErr(null);
    if (!exp) {
      const next = { ...EMPTY_EXPERIMENT_DRAFT, variants: [] };
      setDraftBaseline(next);
      setDraft(next);
      return;
    }
    const next = {
      key: exp.key,
      name: exp.name,
      status: exp.status ?? "draft",
      allocation_mode: exp.allocation_mode ?? "",
      winner_metric: exp.winner_metric ?? "",
      variants: (exp.variants ?? []).map(variantToDraft),
    };
    setDraftBaseline(next);
    setDraft(next);
  };

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setDraftErr(null);
    setValidation(null);
    // Existing experiment keys identify the acknowledged resource. Treat the
    // key as immutable so lifecycle Save cannot turn an edit into an upsert of
    // a second experiment.
    const key = draftBaseline?.key || draft.key.trim();
    if (!key) {
      setDraftErr("Experiment key is required (e.g. headline-test).");
      return false;
    }
    if (!draft.name.trim()) {
      setDraftErr("Name is required.");
      return false;
    }
    const built = buildVariantsInput(draft.variants);
    if (!built.ok) {
      // Flag the offending row verbatim — never lose the draft.
      setDraftErr(`Variant ${built.index + 1}: ${built.error}`);
      return false;
    }
    const input: OnsiteExperiment = {
      key,
      name: draft.name.trim(),
      status: draft.status,
    };
    if (draft.allocation_mode) input.allocation_mode = draft.allocation_mode;
    if (draft.winner_metric) input.winner_metric = draft.winner_metric;
    if (built.items.length > 0) input.variants = built.items;

    const check = await onsiteGrowthApi.validate({ experiment: input });
    if (check.error) {
      toast.error(`Validation call failed: ${check.error.message}`);
      return false;
    }
    setValidation(check.data ?? null);
    if (check.data && !check.data.valid) {
      return false;
    }
    const res = await onsiteGrowthApi.upsertExperiment(formId, key, input);
    if (res.error) {
      toast.error(`Save failed: ${res.error.message}`);
      return false;
    }
    toast.success(`Experiment "${key}" saved`);
    setDraft(null);
    setDraftBaseline(null);
    void load();
    return true;
  };

  const dirty =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(draftBaseline);
  const lifecycle = useDraftLifecycleController({
    ownerId: draftBaseline?.key
      ? `onsite-experiment-edit-${formId}-${draftBaseline.key}`
      : `onsite-experiment-create-${formId}`,
    label: draftBaseline?.key
      ? "Onsite experiment changes"
      : "New onsite experiment draft",
    mode: draftBaseline?.key ? "edit" : "create",
    enabled: draft !== null,
    dirty,
    save,
    discard: () => {
      setDraft(draftBaseline);
      setDraftErr(null);
      setValidation(null);
    },
    close: () => {
      setDraft(null);
      setDraftBaseline(null);
    },
    detail: draftBaseline?.key
      ? "These onsite experiment changes have not been saved."
      : "This onsite experiment has not been created. Return to the editor or explicitly discard it.",
    operationDetail:
      "Wait for the onsite-experiment request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The experiment couldn't be saved."),
      ),
  });

  useEffect(() => {
    onLifecycleState("experiments", { dirty, busy: lifecycle.active });
  }, [dirty, lifecycle.active, onLifecycleState]);

  if (err) return <p className="field-error">{err}</p>;
  if (items === null) return <p className="muted">Loading experiments…</p>;

  return (
    <div>
      {items.length === 0 && !draft ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No experiments on this form yet. An experiment splits traffic across
          form variants (weights are basis points; 10000 = 100%) and records
          impression / submit / conversion events per variant.
        </p>
      ) : null}

      <ExperimentCards
        items={items}
        canMutate={canMutate}
        editorOpen={draft !== null}
        onEdit={openEdit}
      />

      {!draft && canMutate ? (
        <button type="button" className="btn btn-sm" onClick={() => openEdit()}>
          New experiment
        </button>
      ) : null}

      {draft ? (
        <div
          style={{
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            padding: 12,
            marginTop: 8,
          }}
        >
          <ExperimentIdentityFields
            draft={draft}
            existingKey={draftBaseline?.key ?? ""}
            onChange={setDraft}
          />
          <ExperimentConfigurationFields
            catalog={catalog}
            draft={draft}
            onChange={setDraft}
          />
          <ExperimentVariantsEditor draft={draft} onChange={setDraft} />
          {draftErr ? <div className="field-error">{draftErr}</div> : null}
          <ValidationNotice v={validation} />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void lifecycle.submit()}
              disabled={lifecycle.active}
            >
              {lifecycle.active ? "Validating + saving…" : "Validate + save"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={lifecycle.requestClose}
              disabled={lifecycle.active}
            >
              Cancel
            </button>
          </div>
          <ConfirmModal
            open={lifecycle.discardConfirmOpen}
            title={
              draftBaseline?.key
                ? "Discard experiment changes?"
                : "Discard experiment draft?"
            }
            description={
              draftBaseline?.key
                ? "Your changes will be restored to the last loaded experiment."
                : "The experiment has not been created."
            }
            confirmLabel="Discard"
            danger
            busy={lifecycle.active}
            onConfirm={lifecycle.discardAndClose}
            onClose={lifecycle.keepEditing}
          />
        </div>
      ) : null}
    </div>
  );
}

function ExperimentIdentityFields({
  draft,
  existingKey,
  onChange,
}: {
  draft: ExperimentDraft;
  existingKey: string;
  onChange: (draft: ExperimentDraft) => void;
}): ReactElement {
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="growth-exp-key">
          Key
        </label>
        <input
          id="growth-exp-key"
          className="input mono"
          placeholder="headline-test"
          value={draft.key}
          onChange={(event) => onChange({ ...draft, key: event.target.value })}
          disabled={Boolean(existingKey)}
          aria-describedby="growth-experiment-key-help"
        />
        <div
          id="growth-experiment-key-help"
          className="field-help"
          role={existingKey ? "status" : undefined}
        >
          {existingKey
            ? "Experiment keys are permanent after creation. Duplicate the experiment to use a different key."
            : "Choose a stable key; it cannot be changed after creation."}
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="growth-exp-name">
          Name
        </label>
        <input
          id="growth-exp-name"
          className="input"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </div>
    </>
  );
}

function ExperimentConfigurationFields({
  catalog,
  draft,
  onChange,
}: {
  catalog: OnsiteGrowthCatalog | null;
  draft: ExperimentDraft;
  onChange: (draft: ExperimentDraft) => void;
}): ReactElement {
  const statuses = ["draft", "running", "paused", "completed"];
  if (!statuses.includes(draft.status)) statuses.push(draft.status);
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <div className="field" style={{ flex: 1 }}>
        <label className="field-label" htmlFor="growth-exp-status">
          Status
        </label>
        <select
          id="growth-exp-status"
          className="input"
          value={draft.status}
          onChange={(event) =>
            onChange({ ...draft, status: event.target.value })
          }
        >
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
      <div className="field" style={{ flex: 1 }}>
        <label className="field-label" htmlFor="growth-exp-mode">
          Allocation mode
        </label>
        <select
          id="growth-exp-mode"
          className="input"
          value={draft.allocation_mode}
          onChange={(event) =>
            onChange({ ...draft, allocation_mode: event.target.value })
          }
        >
          <option value="">(server default)</option>
          {(catalog?.experiment_modes ?? []).map((mode) => (
            <option key={mode.key} value={mode.key}>
              {mode.label || mode.key}
            </option>
          ))}
        </select>
      </div>
      <div className="field" style={{ flex: 1 }}>
        <label className="field-label" htmlFor="growth-exp-metric">
          Winner metric
        </label>
        <select
          id="growth-exp-metric"
          className="input"
          value={draft.winner_metric}
          onChange={(event) =>
            onChange({ ...draft, winner_metric: event.target.value })
          }
        >
          <option value="">(server default)</option>
          {(catalog?.winner_metrics ?? []).map((metric) => (
            <option key={metric.key} value={metric.key}>
              {metric.label || metric.key}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ExperimentVariantsEditor({
  draft,
  onChange,
}: {
  draft: ExperimentDraft;
  onChange: (draft: ExperimentDraft) => void;
}): ReactElement {
  const weight = variantDraftWeightSummary(draft.variants);
  const updateVariant = (index: number, patch: Partial<VariantDraft>): void => {
    onChange({
      ...draft,
      variants: draft.variants.map((variant, currentIndex) =>
        currentIndex === index ? { ...variant, ...patch } : variant,
      ),
    });
  };
  return (
    <div className="field">
      <label className="field-label">
        Variants{" "}
        <span className="muted" id="growth-experiment-weight-help">
          (up to {MAX_EXPERIMENT_VARIANTS}; weights in basis points, 10000 =
          100%)
        </span>
      </label>
      <div style={{ fontSize: 11, marginBottom: 6 }}>
        <span className="muted">Total traffic: </span>
        <span className={`badge${weight.complete ? " success" : " warning"}`}>
          {fmtBasisPoints(weight.totalBp)}
        </span>
        {!weight.complete ? (
          <span style={{ color: "var(--pw-danger)", marginLeft: 6 }}>
            weights should total 100% (10000bp)
          </span>
        ) : null}
      </div>
      {draft.variants.length === 0 ? (
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          No variants yet — add at least a control and one challenger.
        </div>
      ) : null}
      {draft.variants.map((variant, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <input
            className="input"
            style={{ flex: 2, minWidth: 120 }}
            placeholder="Name (e.g. Control)"
            aria-label={`Variant ${index + 1} name`}
            value={variant.name ?? ""}
            onChange={(event) =>
              updateVariant(index, { name: event.target.value })
            }
          />
          <input
            className="input mono"
            style={{ flex: 1, minWidth: 90 }}
            placeholder="key"
            aria-label={`Variant ${index + 1} key`}
            value={variant.key ?? ""}
            onChange={(event) =>
              updateVariant(index, { key: event.target.value })
            }
          />
          <input
            className="input tabular"
            style={{ width: 90 }}
            type="number"
            min={0}
            max={10000}
            placeholder="bp"
            aria-label={`Variant ${index + 1} traffic weight in basis points`}
            aria-describedby="growth-experiment-weight-help"
            value={variant.weightText ?? ""}
            onChange={(event) =>
              updateVariant(index, { weightText: event.target.value })
            }
          />
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
            }}
          >
            <input
              type="checkbox"
              aria-label={`Use variant ${variant.name || index + 1} as the control baseline`}
              checked={variant.isControl}
              onChange={(event) =>
                updateVariant(index, { isControl: event.target.checked })
              }
            />
            control
          </label>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={`Remove variant ${variant.name || index + 1}`}
            onClick={() =>
              onChange({
                ...draft,
                variants: draft.variants.filter(
                  (_, currentIndex) => currentIndex !== index,
                ),
              })
            }
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className={`btn btn-sm${
          draft.variants.length >= MAX_EXPERIMENT_VARIANTS
            ? " pw-discoverable-unavailable"
            : ""
        }`}
        aria-disabled={
          draft.variants.length >= MAX_EXPERIMENT_VARIANTS || undefined
        }
        aria-describedby="growth-experiment-limit-help"
        onClick={() => {
          if (draft.variants.length >= MAX_EXPERIMENT_VARIANTS) return;
          onChange({
            ...draft,
            variants: [...draft.variants, newVariantDraft()],
          });
        }}
      >
        + Add variant
      </button>
      <div
        id="growth-experiment-limit-help"
        className="muted"
        role="status"
        style={{ fontSize: 11, marginTop: 4 }}
      >
        {draft.variants.length >= MAX_EXPERIMENT_VARIANTS
          ? `Maximum reached: experiments support ${MAX_EXPERIMENT_VARIANTS} variants.`
          : `${draft.variants.length} of ${MAX_EXPERIMENT_VARIANTS} variants added.`}
      </div>
    </div>
  );
}

function ExperimentCards({
  items,
  canMutate,
  editorOpen,
  onEdit,
}: {
  items: OnsiteExperiment[];
  canMutate: boolean;
  editorOpen: boolean;
  onEdit: (experiment: OnsiteExperiment) => void;
}): ReactElement {
  return (
    <>
      {canMutate ? (
        <div
          id="growth-experiment-editor-status"
          className="muted"
          role="status"
          style={{ fontSize: 11, marginBottom: 8 }}
        >
          {editorOpen
            ? "Finish or cancel the open experiment draft before editing another experiment."
            : "Choose Edit to review an experiment; live traffic changes only after validation and save."}
        </div>
      ) : null}
      {items.map((experiment) => {
        const totals = experimentEventTotals(experiment);
        return (
          <div
            key={experiment.key}
            style={{
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
              padding: 10,
              marginBottom: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <strong style={{ fontSize: 13 }}>{experiment.name}</strong>
              <span className="muted mono" style={{ fontSize: 11 }}>
                {experiment.key}
              </span>
              <span className="badge">{experiment.status ?? "draft"}</span>
              {experiment.winner_metric ? (
                <span className="muted" style={{ fontSize: 11 }}>
                  winner: {experiment.winner_metric}
                </span>
              ) : null}
              <span className="spacer" />
              {canMutate ? (
                <button
                  type="button"
                  className={`btn btn-sm btn-ghost${editorOpen ? " pw-discoverable-unavailable" : ""}`}
                  onClick={() => {
                    if (!editorOpen) onEdit(experiment);
                  }}
                  aria-disabled={editorOpen || undefined}
                  aria-describedby="growth-experiment-editor-status"
                >
                  Edit
                </button>
              ) : null}
            </div>
            {experiment.variants?.length ? (
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {experiment.variants
                  .map(
                    (variant) =>
                      `${variant.name || variant.key} (${fmtBasisPoints(variant.traffic_weight_basis_points)})`,
                  )
                  .join(" · ")}
              </div>
            ) : null}
            {totals.length > 0 ? (
              <div
                className="tabular"
                style={{ display: "flex", gap: 14, fontSize: 11, marginTop: 6 }}
              >
                {totals.map((total) => (
                  <span key={total.event}>
                    <strong>{total.count.toLocaleString()}</strong>{" "}
                    <span className="muted">{total.event}</span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                No events recorded yet.
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/* ---------- spin-to-win --------------------------------------------------- */

function SpinTab({
  formId,
  onLifecycleState,
}: {
  formId: string;
  onLifecycleState: GrowthOwnerStateReporter;
}): ReactElement {
  // #49 — PUT /spin/rewards is admin-scoped, so the editor gates on
  // the admin role rather than the panel-wide editor/write gate.
  const canAdmin = useCanAdmin();
  const [items, setItems] = useState<OnsiteSpinReward[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // null = read view; an array = the editor is open over those drafts.
  const [drafts, setDrafts] = useState<SpinRewardDraft[] | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<SpinRewardDraft[] | null>(
    null,
  );
  const [rowErr, setRowErr] = useState<{ index: number; error: string } | null>(
    null,
  );
  const [validation, setValidation] = useState<OnsiteValidationResponse | null>(
    null,
  );

  useEffect(() => {
    void (async () => {
      const res = await onsiteGrowthApi.listSpinRewards(formId);
      if (res.error) {
        setErr(res.error.message);
        setItems([]);
        return;
      }
      setItems(res.data?.items ?? []);
    })();
  }, [formId]);

  const openEditor = (): void => {
    setRowErr(null);
    setValidation(null);
    const next = (items ?? []).map(spinRewardToDraft);
    setDraftBaseline(next);
    setDrafts(next);
  };

  const save = async (): Promise<boolean> => {
    if (!drafts) return false;
    setRowErr(null);
    setValidation(null);
    const built = buildSpinRewardsInput(drafts);
    if (!built.ok) {
      setRowErr({ index: built.index, error: built.error });
      return false;
    }
    // Same pre-validate pattern as targeting/experiments: PUT also
    // 422s, but the explicit validate call yields the field-level list.
    const check = await onsiteGrowthApi.validate({ spin_rewards: built.items });
    if (check.error) {
      toast.error(`Validation call failed: ${check.error.message}`);
      return false;
    }
    setValidation(check.data ?? null);
    if (check.data && !check.data.valid) {
      return false;
    }
    const res = await onsiteGrowthApi.replaceSpinRewards(formId, built.items);
    if (res.error) {
      toast.error(`Save failed: ${res.error.message}`);
      return false;
    }
    // Render the server's saved set verbatim (ids/defaults it filled in).
    setItems(res.data?.items ?? []);
    setDrafts(null);
    setDraftBaseline(null);
    toast.success("Spin rewards saved");
    return true;
  };

  const dirty =
    drafts !== null && JSON.stringify(drafts) !== JSON.stringify(draftBaseline);
  const lifecycle = useDraftLifecycleController({
    ownerId: `onsite-spin-rewards-${formId}`,
    label: "Spin reward changes",
    mode: "edit",
    enabled: drafts !== null,
    dirty,
    save,
    discard: () => {
      setDrafts(draftBaseline);
      setRowErr(null);
      setValidation(null);
    },
    close: () => {
      setDrafts(null);
      setDraftBaseline(null);
    },
    detail: "These spin-reward changes have not been saved.",
    operationDetail:
      "Wait for the spin-reward request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The spin rewards couldn't be saved."),
      ),
  });

  useEffect(() => {
    onLifecycleState("spin", { dirty, busy: lifecycle.active });
  }, [dirty, lifecycle.active, onLifecycleState]);

  if (err) return <p className="field-error">{err}</p>;
  if (items === null) return <p className="muted">Loading spin rewards…</p>;

  const summary = drafts
    ? spinDraftWeightSummary(drafts)
    : spinWeightSummary(items);

  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        The wheel is spun by the public form embed — the visitor&apos;s browser
        calls the public spin endpoint, which draws a reward server-side using
        the weights below (basis points; 10000 = 100%) and, for coupon rewards,
        reserves a code from the linked pool. The result is recorded as an
        experiment event.
      </div>

      {!summary.complete && (drafts ? drafts.length > 0 : items.length > 0) ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 12 }}>
            Weights total {fmtBasisPoints(summary.totalBp)} — a healthy wheel
            totals exactly 100%, otherwise the displayed odds don&apos;t match
            the draw.
          </span>
        </div>
      ) : null}

      {drafts ? (
        <SpinRewardsEditor
          drafts={drafts}
          rowErr={rowErr}
          validation={validation}
          saving={lifecycle.active}
          onChange={(next) => setDrafts(next)}
          onSave={() => void lifecycle.submit()}
          onCancel={lifecycle.requestClose}
        />
      ) : items.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No spin rewards configured on this form yet.
          {canAdmin
            ? " Add rewards below — the editor saves the full set in one go."
            : " Configuring rewards requires an admin role."}
        </p>
      ) : (
        <div className="list">
          <div
            className="list-header"
            style={{ gridTemplateColumns: "1.2fr 1fr 90px 100px 90px" }}
          >
            <div>Reward</div>
            <div>Type</div>
            <div style={{ textAlign: "right" }}>Weight</div>
            <div>Code / pool</div>
            <div>Status</div>
          </div>
          {items.map((r) => (
            <div
              key={r.id ?? r.key}
              className="list-row"
              style={{
                gridTemplateColumns: "1.2fr 1fr 90px 100px 90px",
                cursor: "default",
              }}
            >
              <div
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={r.label}
              >
                {r.label || r.key}
              </div>
              <div className="muted">{r.reward_type || "—"}</div>
              <div className="tabular" style={{ textAlign: "right" }}>
                {fmtBasisPoints(r.weight_basis_points)}
              </div>
              <div
                className="muted mono"
                style={{
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={r.static_code || r.coupon_pool_id || undefined}
              >
                {r.static_code || r.coupon_pool_id || "—"}
              </div>
              <div>
                <span className="badge">{r.status || "active"}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!drafts && canAdmin ? (
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: items.length === 0 ? 0 : 8 }}
          onClick={openEditor}
        >
          {items.length === 0 ? "Add rewards" : "Edit rewards"}
        </button>
      ) : null}
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard spin-reward changes?"
        description="Your changes will be restored to the last loaded reward set."
        confirmLabel="Discard"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </div>
  );
}

/** Admin editor over the full reward set — PUT is a full replace, so
 *  the rows below are exactly what will be saved. */
function SpinRewardsEditor({
  drafts,
  rowErr,
  validation,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  drafts: SpinRewardDraft[];
  rowErr: { index: number; error: string } | null;
  validation: OnsiteValidationResponse | null;
  saving: boolean;
  onChange: (next: SpinRewardDraft[]) => void;
  onSave: () => void;
  onCancel: () => void;
}): ReactElement {
  const setRow = (i: number, patch: Partial<SpinRewardDraft>): void => {
    onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  };

  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        id="growth-spin-weight-help"
        className="muted"
        style={{ fontSize: 11, marginBottom: 8 }}
      >
        Reward weights use basis points: 10,000 equals 100% of spins.
      </div>
      {drafts.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No rows — saving now removes every reward from the wheel.
        </p>
      ) : null}
      {drafts.map((d, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input
              className="input mono"
              aria-label={`Reward ${i + 1} key`}
              placeholder="key (ten-off)"
              style={{ width: 120, fontSize: 12 }}
              value={d.key}
              onChange={(e) => setRow(i, { key: e.target.value })}
            />
            <input
              className="input"
              aria-label={`Reward ${i + 1} label`}
              placeholder="Label (10% off)"
              style={{ flex: 1, minWidth: 140 }}
              value={d.label}
              onChange={(e) => setRow(i, { label: e.target.value })}
            />
            <input
              className="input"
              type="number"
              aria-label={`Reward ${i + 1} weight in basis points`}
              placeholder="bp"
              aria-describedby="growth-spin-weight-help"
              style={{ width: 90 }}
              value={d.weightText}
              onChange={(e) => setRow(i, { weightText: e.target.value })}
            />
            <select
              className="input"
              aria-label={`Reward ${i + 1} coupon type`}
              style={{ width: 130 }}
              value={d.couponKind}
              onChange={(e) =>
                setRow(i, {
                  couponKind: e.target.value as SpinRewardDraft["couponKind"],
                  ...(e.target.value === "none" ? { couponValue: "" } : {}),
                })
              }
            >
              <option value="none">No coupon</option>
              <option value="static_code">Static code</option>
              <option value="coupon_pool">Coupon pool</option>
            </select>
            {d.couponKind !== "none" ? (
              <input
                className="input mono"
                aria-label={`Reward ${i + 1} coupon value`}
                placeholder={
                  d.couponKind === "static_code" ? "SAVE10" : "pool id"
                }
                style={{ width: 130, fontSize: 12 }}
                value={d.couponValue}
                onChange={(e) => setRow(i, { couponValue: e.target.value })}
              />
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label={`Remove reward ${i + 1}`}
              onClick={() => onChange(drafts.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
          {rowErr?.index === i ? (
            <div className="field-error">{rowErr.error}</div>
          ) : null}
        </div>
      ))}

      <div style={{ marginBottom: 10 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onChange([...drafts, newSpinRewardDraft()])}
        >
          + Add reward
        </button>
      </div>

      <ValidationNotice v={validation} />

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Validating + saving…" : "Validate + save"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
