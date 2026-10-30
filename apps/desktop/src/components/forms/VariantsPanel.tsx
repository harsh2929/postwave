/**
 * VariantsPanel — per-form display-variant A/B slideover, opened from
 * a form tile on the Forms page (mirrors GrowthPanel's pattern).
 *
 * Backend surface (apps/api/internal/form_variants — ROADMAP-WRAPPERS
 * T1, camelCase on the wire, unique in the API):
 *   GET    /forms/{id}/variants                 (bare array)
 *   POST   /forms/{id}/variants
 *   PATCH  /forms/{id}/variants/{variantId}
 *   DELETE /forms/{id}/variants/{variantId}     → {ok:true}
 *   GET    /forms/{id}/variants/promotions      (bare array)
 *   POST   /forms/{id}/variants/evaluate        (manual bandit pass)
 *
 * Honesty notes: writes are admin-scoped, so the editor gates on the
 * admin role. "promoted" status is server-assigned by auto-promotion —
 * the panel only toggles active↔paused. displayConfig is opaque jsonb
 * edited as raw JSON. conversionRate / promotion rates are 0..1
 * fractions on the wire.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { SlideoverShell } from "../SlideoverShell";
import { toast } from "../Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type FormVariant,
  type FormVariantEvaluateResponse,
  type FormVariantPromotion,
  formVariantsApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import {
  type VariantDraft,
  buildVariantInput,
  decisionWeightRows,
  fmtFraction,
  newVariantDraft,
  sampleContextLine,
  significanceLabel,
  toggledStatus,
  trafficSplitSummary,
  variantToDraft,
} from "./variants-helpers";

interface Props {
  formId: string;
  formName: string;
  /** FormSummary.visits30d — optional, older API builds don't compute it. */
  visits30d?: number;
  onClose: () => void;
}

function variantStatusBadge(status: string | undefined): ReactElement {
  const s = (status ?? "active").toLowerCase();
  if (s === "promoted") return <span className="badge success">Promoted</span>;
  if (s === "paused") return <span className="badge warning">Paused</span>;
  return <span className="badge accent">Active</span>;
}

export function VariantsPanel({
  formId,
  formName,
  visits30d,
  onClose,
}: Props): ReactElement {
  // Reads are read:forms-equivalent; WRITES are admin-equivalent
  // (handlers.go r.With(write)) — gate the editors on admin.
  const canAdmin = useCanAdmin();
  const [items, setItems] = useState<FormVariant[] | null>(null);
  const [promotions, setPromotions] = useState<FormVariantPromotion[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // True when the API build doesn't expose the variants routes at all
  // (404/501) — render the honest unavailable state, no editors.
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState<VariantDraft | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<VariantDraft | null>(null);
  const [draftErr, setDraftErr] = useState<{
    field: string;
    error: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FormVariant | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evalResult, setEvalResult] =
    useState<FormVariantEvaluateResponse | null>(null);
  const [closePanelAfterDiscard, setClosePanelAfterDiscard] = useState(false);
  const activeRef = useRef(true);
  const mutation = useSingleFlightOperation({
    ownerId: `form-variant-mutation-${formId}`,
    label: "Form variant mutation",
    detail: "Wait for the form-variant request to finish before leaving.",
  });

  const load = useCallback(async (): Promise<void> => {
    const res = await formVariantsApi.list(formId);
    if (res.error) {
      if (res.error.status === 404 || res.error.status === 501) {
        setUnavailable(true);
        setItems([]);
        return;
      }
      setLoadErr(res.error.message);
      setItems([]);
      return;
    }
    setLoadErr(null);
    setItems(res.data ?? []);
    // Promotions are best-effort context — a failure here shouldn't
    // block the variant list.
    const promos = await formVariantsApi.listPromotions(formId);
    if (!promos.error) setPromotions(promos.data ?? []);
  }, [formId]);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
    };
  }, [load]);

  const openEdit = (v?: FormVariant): void => {
    setDraftErr(null);
    const next = v ? variantToDraft(v) : newVariantDraft();
    setDraftBaseline(next);
    setDraft(next);
  };

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setDraftErr(null);
    const built = buildVariantInput(draft);
    if (!built.ok) {
      setDraftErr({ field: built.field, error: built.error });
      return false;
    }
    const res = draft.id
      ? await formVariantsApi.update(formId, draft.id, built.patch)
      : await formVariantsApi.create(formId, built.create);
    if (!activeRef.current) return false;
    if (res.error) {
      toast.error(`Save failed: ${res.error.message}`);
      return false;
    }
    toast.success(draft.id ? "Variant updated" : "Variant created");
    setDraft(null);
    setDraftBaseline(null);
    setEvalResult(null);
    void load();
    return true;
  };

  const draftDirty =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(draftBaseline);
  const draftLifecycle = useDraftLifecycleController({
    ownerId: draft?.id
      ? `form-variant-edit-${draft.id}`
      : `form-variant-create-${formId}`,
    label: draft?.id ? "Form variant changes" : "New form variant draft",
    mode: draft?.id ? "edit" : "create",
    enabled: draft !== null,
    dirty: draftDirty,
    save,
    discard: () => {
      setDraft(draftBaseline);
      setDraftErr(null);
    },
    close: () => {
      setDraft(null);
      setDraftBaseline(null);
    },
    detail: draft?.id
      ? "These form-variant changes have not been saved."
      : "This form variant has not been created. Return to the editor or explicitly discard it.",
    operationDetail:
      "Wait for the form-variant save request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The form variant couldn't be saved."),
      ),
  });

  const requestPanelClose = (): void => {
    if (draftLifecycle.promiseRef.current || mutation.promiseRef.current)
      return;
    if (draftDirty) {
      setClosePanelAfterDiscard(true);
      draftLifecycle.requestClose();
      return;
    }
    onClose();
  };

  const toggle = async (v: FormVariant): Promise<void> => {
    const next = toggledStatus(v.status);
    if (!next) return;
    const request = mutation.run(async () => {
      setBusyId(v.id);
      try {
        const res = await formVariantsApi.update(formId, v.id, {
          status: next,
        });
        if (!activeRef.current) return;
        if (res.error) {
          toast.error(
            `Couldn't ${next === "paused" ? "pause" : "resume"}: ${res.error.message}`,
          );
          return;
        }
        toast.success(next === "paused" ? "Variant paused" : "Variant resumed");
        void load();
      } catch (error) {
        if (activeRef.current) {
          toast.error(
            lifecycleOperationError(
              error,
              "The variant status wasn't changed.",
            ),
          );
        }
      } finally {
        if (activeRef.current) setBusyId(null);
      }
    });
    if (!request) await mutation.wait();
  };

  const remove = async (): Promise<void> => {
    if (!deleteTarget) return;
    const v = deleteTarget;
    const request = mutation.run(async () => {
      setBusyId(v.id);
      try {
        const res = await formVariantsApi.remove(formId, v.id);
        if (!activeRef.current) return;
        if (res.error) {
          toast.error(`Delete failed: ${res.error.message}`);
          return;
        }
        setDeleteTarget(null);
        toast.success(`Variant "${v.label}" deleted`);
        setEvalResult(null);
        void load();
      } catch (error) {
        if (activeRef.current) {
          toast.error(
            lifecycleOperationError(error, "The variant wasn't deleted."),
          );
        }
      } finally {
        if (activeRef.current) setBusyId(null);
      }
    });
    if (!request) await mutation.wait();
  };

  const evaluate = async (): Promise<void> => {
    const request = mutation.run(async () => {
      setEvaluating(true);
      try {
        const res = await formVariantsApi.evaluate(formId);
        if (!activeRef.current) return;
        if (res.error) {
          toast.error(`Evaluate failed: ${res.error.message}`);
          return;
        }
        setEvalResult(res.data ?? null);
        void load();
      } catch (error) {
        if (activeRef.current) {
          toast.error(
            lifecycleOperationError(error, "The evaluation didn't complete."),
          );
        }
      } finally {
        if (activeRef.current) setEvaluating(false);
      }
    });
    if (!request) await mutation.wait();
  };

  return (
    <SlideoverShell
      open
      onClose={requestPanelClose}
      size="lg"
      eyebrow="A/B variants"
      title={formName || "Form"}
      subtitle="Display variants split this form's traffic and track which presentation converts best."
    >
      <VariantsPanelContent
        busyId={busyId}
        canAdmin={canAdmin}
        draft={draft}
        draftBusy={draftLifecycle.active}
        draftError={draftErr}
        evaluating={evaluating}
        evaluation={evalResult}
        items={items}
        loadError={loadErr}
        promotions={promotions}
        unavailable={unavailable}
        visits30d={visits30d}
        onCreate={() => openEdit()}
        onDelete={setDeleteTarget}
        onDraftCancel={() => {
          setClosePanelAfterDiscard(false);
          draftLifecycle.requestClose();
        }}
        onDraftChange={setDraft}
        onDraftSave={() => void draftLifecycle.submit()}
        onEdit={openEdit}
        onEvaluate={() => {
          if (evaluating || mutation.promiseRef.current) return;
          void evaluate();
        }}
        onToggle={(variant) => void toggle(variant)}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title={`Delete variant "${deleteTarget?.label ?? ""}"?`}
        description="Its impression and submission counters are removed with it."
        confirmLabel="Delete"
        danger
        busy={mutation.active}
        onConfirm={() => void remove()}
        onClose={() => {
          if (!mutation.active) setDeleteTarget(null);
        }}
      />
      <ConfirmModal
        open={draftLifecycle.discardConfirmOpen}
        title={
          draft?.id ? "Discard variant changes?" : "Discard variant draft?"
        }
        description={
          draft?.id
            ? "Your changes will be restored to the last loaded variant."
            : "The variant has not been created."
        }
        confirmLabel="Discard"
        danger
        busy={draftLifecycle.active}
        onConfirm={() => {
          const closePanel = closePanelAfterDiscard;
          draftLifecycle.discardAndClose();
          setClosePanelAfterDiscard(false);
          if (closePanel) onClose();
        }}
        onClose={() => {
          setClosePanelAfterDiscard(false);
          draftLifecycle.keepEditing();
        }}
      />
    </SlideoverShell>
  );
}

interface VariantsPanelContentProps {
  busyId: string | null;
  canAdmin: boolean;
  draft: VariantDraft | null;
  draftBusy: boolean;
  draftError: { field: string; error: string } | null;
  evaluating: boolean;
  evaluation: FormVariantEvaluateResponse | null;
  items: FormVariant[] | null;
  loadError: string | null;
  promotions: FormVariantPromotion[];
  unavailable: boolean;
  visits30d?: number;
  onCreate: () => void;
  onDelete: (variant: FormVariant) => void;
  onDraftCancel: () => void;
  onDraftChange: (draft: VariantDraft) => void;
  onDraftSave: () => void;
  onEdit: (variant: FormVariant) => void;
  onEvaluate: () => void;
  onToggle: (variant: FormVariant) => void;
}

function VariantsPanelContent({
  busyId,
  canAdmin,
  draft,
  draftBusy,
  draftError,
  evaluating,
  evaluation,
  items,
  loadError,
  promotions,
  unavailable,
  visits30d,
  onCreate,
  onDelete,
  onDraftCancel,
  onDraftChange,
  onDraftSave,
  onEdit,
  onEvaluate,
  onToggle,
}: VariantsPanelContentProps): ReactElement {
  if (items === null) return <p className="muted">Loading variants…</p>;
  if (unavailable) {
    return (
      <p className="muted" style={{ fontSize: 12 }}>
        This API build doesn&apos;t expose form display variants
        (/forms/&#123;id&#125;/variants returned not-found). Upgrade the backend
        to use A/B variants.
      </p>
    );
  }
  if (loadError) return <p className="field-error">{loadError}</p>;
  const split = trafficSplitSummary(items);
  const context = sampleContextLine(visits30d, items);
  return (
    <>
      {context ? (
        <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          {context}
        </div>
      ) : null}
      {items.length > 0 && !split.balanced ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 12 }}>
            Live traffic split totals {split.totalPct}% across{" "}
            {split.activeCount}
            variant{split.activeCount === 1 ? "" : "s"} — a balanced test totals
            exactly 100%.
          </span>
        </div>
      ) : null}
      {items.length === 0 && !draft ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No variants on this form yet. A variant overrides how the form is
          presented (heading, copy, layout knobs in its display config) for a
          percentage of traffic; the server tracks impressions and submissions
          per variant and auto-promotes a winner once the difference is
          statistically significant.
        </p>
      ) : null}
      <VariantCards
        items={items}
        canAdmin={canAdmin}
        busyId={busyId}
        editorOpen={draft !== null}
        onEdit={onEdit}
        onToggle={onToggle}
        onDelete={onDelete}
      />
      {!draft && canAdmin ? (
        <VariantCreateActions
          canEvaluate={items.length >= 2}
          evaluating={evaluating}
          onCreate={onCreate}
          onEvaluate={onEvaluate}
        />
      ) : null}
      {!canAdmin && items.length > 0 ? (
        <p className="muted" style={{ fontSize: 11 }}>
          Editing variants requires an admin role.
        </p>
      ) : null}
      {evaluation ? (
        <VariantEvaluation evaluation={evaluation} items={items} />
      ) : null}
      {draft ? (
        <VariantDraftEditor
          draft={draft}
          error={draftError}
          busy={draftBusy}
          onChange={onDraftChange}
          onSave={onDraftSave}
          onCancel={onDraftCancel}
        />
      ) : null}
      {promotions.length > 0 ? (
        <VariantPromotionHistory items={items} promotions={promotions} />
      ) : null}
    </>
  );
}

function VariantEvaluation({
  evaluation,
  items,
}: {
  evaluation: FormVariantEvaluateResponse;
  items: FormVariant[];
}): ReactElement {
  const weights = decisionWeightRows(evaluation.decision?.weights);
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 10,
        marginBottom: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        Bandit decision
      </div>
      {weights.length > 0 ? (
        <div className="tabular" style={{ fontSize: 11 }}>
          {weights.map((row) => (
            <div key={row.id} style={{ display: "flex", gap: 8 }}>
              <span
                className="mono muted"
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {items.find((variant) => variant.id === row.id)?.label ??
                  row.id}
              </span>
              <strong>{row.weight}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 11 }}>
          The pass returned no weight changes.
        </div>
      )}
    </div>
  );
}

function VariantPromotionHistory({
  items,
  promotions,
}: {
  items: FormVariant[];
  promotions: FormVariantPromotion[];
}): ReactElement {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        Promotion history
      </div>
      {promotions.map((promotion) => (
        <div
          key={promotion.id}
          className="muted"
          style={{ fontSize: 11, marginBottom: 4 }}
        >
          {new Date(promotion.decidedAt).toLocaleString()} — winner{" "}
          <span className="mono">
            {items.find((variant) => variant.id === promotion.winnerVariantId)
              ?.label ?? promotion.winnerVariantId}
          </span>{" "}
          at {fmtFraction(promotion.winnerRate)} vs{" "}
          {fmtFraction(promotion.runnerUpRate)} (z ={" "}
          {promotion.zScore.toFixed(2)};{" "}
          {promotion.winnerImpressions.toLocaleString()} vs{" "}
          {promotion.runnerUpImpressions.toLocaleString()} impressions)
        </div>
      ))}
    </div>
  );
}

function VariantCreateActions({
  canEvaluate,
  evaluating,
  onCreate,
  onEvaluate,
}: {
  canEvaluate: boolean;
  evaluating: boolean;
  onCreate: () => void;
  onEvaluate: () => void;
}): ReactElement {
  const evaluationDescriptionId = useId();
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
      <button type="button" className="btn btn-sm" onClick={onCreate}>
        New variant
      </button>
      {canEvaluate ? (
        <>
          <span
            id={evaluationDescriptionId}
            className="visually-hidden"
            role={evaluating ? "status" : undefined}
          >
            {evaluating
              ? "A bandit re-weight pass is already running."
              : "Runs one idempotent bandit re-weight pass over the current counters."}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (evaluating) return;
              onEvaluate();
            }}
            aria-disabled={evaluating || undefined}
            aria-describedby={evaluationDescriptionId}
          >
            {evaluating ? "Evaluating…" : "Re-evaluate weights"}
          </button>
        </>
      ) : null}
    </div>
  );
}

function VariantCards({
  items,
  canAdmin,
  busyId,
  editorOpen,
  onEdit,
  onToggle,
  onDelete,
}: {
  items: FormVariant[];
  canAdmin: boolean;
  busyId: string | null;
  editorOpen: boolean;
  onEdit: (variant: FormVariant) => void;
  onToggle: (variant: FormVariant) => void;
  onDelete: (variant: FormVariant) => void;
}): ReactElement {
  const editorReasonId = useId();
  const busyReasonId = useId();
  return (
    <>
      {editorOpen ? (
        <span id={editorReasonId} className="visually-hidden">
          Finish or cancel the open variant draft before using another variant
          action.
        </span>
      ) : null}
      {busyId !== null ? (
        <span id={busyReasonId} className="visually-hidden" role="status">
          Wait for the current variant action to finish.
        </span>
      ) : null}
      {items.map((variant) => {
        const significance = significanceLabel(variant.lastZScore);
        const next = toggledStatus(variant.status);
        const actionUnavailable = editorOpen || busyId !== null;
        const actionDescription =
          [
            editorOpen ? editorReasonId : null,
            busyId !== null ? busyReasonId : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined;
        return (
          <div
            key={variant.id}
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
              <strong style={{ fontSize: 13 }}>
                {variant.label || "Untitled"}
              </strong>
              {variantStatusBadge(variant.status)}
              <span className="muted" style={{ fontSize: 11 }}>
                {variant.trafficPct}% of traffic
              </span>
              <span className="spacer" />
              {canAdmin ? (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      if (actionUnavailable) return;
                      onEdit(variant);
                    }}
                    aria-disabled={actionUnavailable || undefined}
                    aria-describedby={actionDescription}
                  >
                    Edit
                  </button>
                  {next ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        if (actionUnavailable) return;
                        onToggle(variant);
                      }}
                      aria-disabled={actionUnavailable || undefined}
                      aria-describedby={actionDescription}
                    >
                      {next === "paused" ? "Pause" : "Resume"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      if (actionUnavailable) return;
                      onDelete(variant);
                    }}
                    aria-disabled={actionUnavailable || undefined}
                    aria-describedby={actionDescription}
                  >
                    Delete
                  </button>
                </>
              ) : null}
            </div>
            <div
              className="tabular"
              style={{ display: "flex", gap: 14, fontSize: 11, marginTop: 6 }}
            >
              <span>
                <strong>{(variant.impressions ?? 0).toLocaleString()}</strong>{" "}
                <span className="muted">impressions</span>
              </span>
              <span>
                <strong>{(variant.submissions ?? 0).toLocaleString()}</strong>{" "}
                <span className="muted">submissions</span>
              </span>
              <span>
                <strong>{fmtFraction(variant.conversionRate)}</strong>{" "}
                <span className="muted">conv.</span>
              </span>
              <span className="muted">
                {significance.significant
                  ? `significant (${significance.label})`
                  : significance.label}
              </span>
            </div>
            {variant.promotedAt ? (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                Promoted {new Date(variant.promotedAt).toLocaleString()}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function VariantDraftEditor({
  draft,
  error,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: VariantDraft;
  error: { field: string; error: string } | null;
  busy: boolean;
  onChange: (draft: VariantDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 12,
        marginTop: 8,
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor="variant-label">
          Label
        </label>
        <input
          id="variant-label"
          className="input"
          placeholder="Shorter headline"
          value={draft.label}
          onChange={(event) =>
            onChange({ ...draft, label: event.target.value })
          }
        />
        {error?.field === "label" ? (
          <div className="field-error">{error.error}</div>
        ) : null}
      </div>
      <div className="field" style={{ width: 160 }}>
        <label className="field-label" htmlFor="variant-traffic">
          Traffic %
        </label>
        <input
          id="variant-traffic"
          className="input"
          type="number"
          min={0}
          max={100}
          placeholder="(server default)"
          value={draft.trafficPctText}
          onChange={(event) =>
            onChange({ ...draft, trafficPctText: event.target.value })
          }
        />
        {error?.field === "trafficPct" ? (
          <div className="field-error">{error.error}</div>
        ) : null}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="variant-config">
          Display config <span className="muted">(JSON)</span>
        </label>
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
          Presentation overrides applied by the embed when this variant is
          served — e.g. heading / copy / button-label keys. Free-form JSON
          object on the wire; blank saves &#123;&#125;.
        </div>
        <textarea
          id="variant-config"
          className="input mono"
          rows={5}
          style={{ fontSize: 11 }}
          placeholder='{"heading":"Join 10,000 readers","buttonLabel":"Count me in"}'
          value={draft.displayConfigText}
          onChange={(event) =>
            onChange({ ...draft, displayConfigText: event.target.value })
          }
        />
        {error?.field === "displayConfig" ? (
          <div className="field-error">{error.error}</div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={busy}
        >
          {busy ? "Saving…" : draft.id ? "Save variant" : "Create variant"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
