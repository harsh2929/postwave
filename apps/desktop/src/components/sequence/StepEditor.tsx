/**
 * StepEditor — right slideover with type-specific fields for the
 * currently-selected step. Save PATCHes through the parent's onSave
 * callback; Cancel discards;
 * Delete confirms then removes.
 *
 * Feature 12 — UI-from-variables. The Save button keeps its existing
 * parent-callback contract (the canvas owns the persist round-trip)
 * but the local mutation wrapper below registers the variables under
 * the ["campaigns", "update"] key so the canvas overlay can render a
 * pending marker on the corresponding StepNode. Validation mirrors the
 * server-side rules (subject required for email steps, delay > 0,
 * tag non-empty) so the optimistic render never advances to a state
 * the backend would reject — when in doubt this falls back to the
 * non-optimistic path by surfacing an inline error.
 */
import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  api,
  type SequenceStepVariantAssignment,
  voiceRoadmapApi,
} from "../../lib/api-client";
import { useMutation } from "@tanstack/react-query";
import { mutKey } from "../../lib/pending-mutations";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import {
  SEQUENCE_REGENERATION_AVAILABLE,
  SEQUENCE_RUNTIME_AVAILABLE,
} from "../../lib/sequence-operational-availability";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { SlideoverShell } from "../SlideoverShell";
import { type CanvasStep, stepTypeLabel } from "./types";
import {
  VARIANT_MAX,
  VARIANT_MIN,
  VARIANT_STATS_HONESTY,
  type VariantDraft,
  addVariantDraft,
  bpToPctString,
  draftsToVariants,
  removeVariantDraft,
  seedVariantDrafts,
  validateVariantDrafts,
  variantsToDrafts,
  weightsSumBp,
} from "./variants";

interface Props {
  step: CanvasStep;
  /** When true, all controls are disabled (viewer role / read-only). */
  readOnly?: boolean;
  /** Required for per-step AI regenerate. */
  sequenceId?: string | number;
  /**
   * True when the step sits on the TOP-LEVEL canvas list (not inside a
   * condition branch). The variant-assignment preview endpoint only
   * resolves top-level positions — branch steps have no flat position
   * identity on the wire — so the preview hides itself otherwise.
   */
  isTopLevel?: boolean;
  onSave: (next: CanvasStep) => void | Promise<void>;
  onCancel: () => void;
  onDelete: (id: string) => void;
}

interface Draft {
  subject: string;
  body: string;
  template_id: string;
  /** null = A/B testing off; an array = the editable arms. */
  variants: VariantDraft[] | null;
  delay_value: number;
  delay_unit: "minutes" | "hours" | "days";
  condition_type:
    | "opened"
    | "clicked"
    | "tagged"
    | "custom_property"
    | "product_event";
  condition_value: string;
  tag: string;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

function draftFromStep(s: CanvasStep): Draft {
  return {
    subject: s.subject ?? "",
    body: s.body ?? s.body_html ?? "",
    template_id: s.template_id ?? "",
    variants:
      s.type === "email" && s.variants && s.variants.length > 0
        ? variantsToDrafts(s.variants)
        : null,
    delay_value: s.delay_value ?? 1,
    delay_unit: s.delay_unit ?? "days",
    condition_type: s.condition_type ?? "opened",
    condition_value: s.condition_value ?? "",
    tag: s.tag ?? "",
  };
}

function stepFromDraft(
  step: CanvasStep,
  draft: Draft,
): { next: CanvasStep } | { error: string } {
  const next: CanvasStep = { ...step };
  switch (step.type) {
    case "email": {
      const subject = draft.subject.trim();
      if (!subject) return { error: "Subject is required." };
      next.subject = subject;
      next.body = draft.body;
      next.template_id = draft.template_id.trim() || undefined;
      if (draft.variants != null) {
        const variantError = validateVariantDrafts(draft.variants);
        if (variantError) return { error: variantError };
        next.variants = draftsToVariants(draft.variants) ?? undefined;
      } else {
        next.variants = undefined;
      }
      break;
    }
    case "delay": {
      const value = Number.isFinite(draft.delay_value)
        ? Math.max(0, Math.floor(draft.delay_value))
        : 0;
      if (value <= 0) return { error: "Delay must be at least 1." };
      next.delay_value = value;
      next.delay_unit = draft.delay_unit;
      break;
    }
    case "condition":
      next.condition_type = draft.condition_type;
      next.condition_value = draft.condition_value.trim();
      break;
    case "tag_add":
    case "tag_remove": {
      const tag = draft.tag.trim();
      if (!tag) return { error: "Tag is required." };
      next.tag = tag;
      break;
    }
    case "exit":
      break;
  }
  return { next };
}

// D07#2: the regenerated-email extraction moved into the api-client
// (regenerateSequenceStep now polls the async job and returns the
// {subject, body} directly), so the local extractRegeneratedEmail /
// isCanvasEmailStep helpers that parsed a SequenceDetail here are gone.

interface StepVariantEditorProps {
  draft: Draft;
  setDraft: StateSetter<Draft>;
  setErr: StateSetter<string | null>;
  readOnly: boolean | undefined;
  isTopLevel: boolean | undefined;
  sequenceId: string | number | undefined;
  previewSubscriberId: string;
  setPreviewSubscriberId: StateSetter<string>;
  previewLoading: boolean;
  previewResult: SequenceStepVariantAssignment | null;
  setPreviewResult: StateSetter<SequenceStepVariantAssignment | null>;
  previewErr: string | null;
  setPreviewErr: StateSetter<string | null>;
  checkAssignment: () => Promise<void>;
}

function StepVariantEditor({
  draft,
  setDraft,
  setErr,
  readOnly,
  isTopLevel,
  sequenceId,
  previewSubscriberId,
  setPreviewSubscriberId,
  previewLoading,
  previewResult,
  setPreviewResult,
  previewErr,
  setPreviewErr,
  checkAssignment,
}: StepVariantEditorProps): ReactElement {
  return (
    <>
      {draft.variants != null
        ? (() => {
            const drafts = draft.variants;
            const sumBp = weightsSumBp(drafts);
            const sumOk = sumBp === 10000;
            return (
              <div
                role="group"
                aria-label="A/B variants"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {drafts.map((v, i) => (
                  <div
                    key={v.key}
                    style={{
                      border: "1px solid var(--pw-border-soft)",
                      borderRadius: "var(--pw-radius-md)",
                      padding: 10,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span className="badge">Variant {v.key}</span>
                      <span style={{ flex: 1 }} />
                      <label
                        className="muted"
                        style={{ fontSize: 11 }}
                        htmlFor={`step-variant-weight-${i}`}
                      >
                        Weight %
                      </label>
                      <input
                        id={`step-variant-weight-${i}`}
                        type="number"
                        className="input"
                        min={0.01}
                        max={100}
                        step={0.01}
                        style={{ width: 90 }}
                        value={v.weight_pct}
                        disabled={readOnly}
                        onChange={(e) => {
                          const next = drafts.map((d, j) =>
                            j === i ? { ...d, weight_pct: e.target.value } : d,
                          );
                          setErr(null);
                          setDraft({ ...draft, variants: next });
                        }}
                      />
                      {drafts.length > VARIANT_MIN ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={readOnly}
                          aria-label={`Remove variant ${v.key} and rebalance the remaining weights`}
                          onClick={() => {
                            setErr(null);
                            setDraft({
                              ...draft,
                              variants: removeVariantDraft(drafts, i),
                            });
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    <input
                      type="text"
                      className="input"
                      aria-label={`Variant ${v.key} subject`}
                      placeholder="Subject"
                      value={v.subject}
                      disabled={readOnly}
                      onChange={(e) => {
                        const next = drafts.map((d, j) =>
                          j === i ? { ...d, subject: e.target.value } : d,
                        );
                        setErr(null);
                        setDraft({ ...draft, variants: next });
                      }}
                    />
                    <textarea
                      className="input"
                      aria-label={`Variant ${v.key} body`}
                      placeholder="Body"
                      rows={4}
                      value={v.body}
                      disabled={readOnly}
                      onChange={(e) => {
                        const next = drafts.map((d, j) =>
                          j === i ? { ...d, body: e.target.value } : d,
                        );
                        setErr(null);
                        setDraft({ ...draft, variants: next });
                      }}
                      style={{
                        minHeight: 80,
                        resize: "vertical",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    />
                  </div>
                ))}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {drafts.length < VARIANT_MAX ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={readOnly}
                      onClick={() => {
                        setErr(null);
                        setDraft({
                          ...draft,
                          variants: addVariantDraft(drafts),
                        });
                      }}
                    >
                      + Add variant
                    </button>
                  ) : (
                    <span className="muted" style={{ fontSize: 11 }}>
                      Maximum {VARIANT_MAX} variants.
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span
                    role="status"
                    className={sumOk ? "muted" : "field-error"}
                    style={{ fontSize: 11 }}
                  >
                    {sumBp == null
                      ? "Enter a weight for every variant."
                      : `Weights total ${bpToPctString(sumBp)}%${sumOk ? "" : " — must be 100%"}`}
                  </span>
                </div>

                {/* Deterministic-assignment check. Top-level steps
                    only: the endpoint addresses the flat 1-based
                    step list, so branch steps can't be resolved. */}
                {isTopLevel &&
                sequenceId != null &&
                SEQUENCE_RUNTIME_AVAILABLE ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      borderTop: "1px dashed var(--pw-border-soft)",
                      paddingTop: 8,
                    }}
                  >
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="text"
                        className="input"
                        aria-label="Opaque subscriber ID to check assignment for"
                        placeholder="subscriber_01H…"
                        autoComplete="off"
                        maxLength={128}
                        value={previewSubscriberId}
                        onChange={(e) => {
                          setPreviewSubscriberId(e.target.value);
                          setPreviewErr(null);
                          setPreviewResult(null);
                        }}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={previewLoading}
                        onClick={() => void checkAssignment()}
                      >
                        {previewLoading ? "Checking…" : "Check assignment"}
                      </button>
                    </div>
                    {previewResult ? (
                      <div role="status" style={{ fontSize: 12 }}>
                        {previewSubscriberId.trim()} gets{" "}
                        <strong>variant {previewResult.variant_key}</strong> (
                        {bpToPctString(previewResult.weight_bp)}% arm) · “
                        {previewResult.subject}”
                      </div>
                    ) : null}
                    {previewErr ? (
                      <div className="field-error">{previewErr}</div>
                    ) : null}
                    <div className="muted" style={{ fontSize: 11 }}>
                      Resolves against the last saved variants — unsaved edits
                      here aren&apos;t reflected. This is a deterministic
                      planning preview; live sequence delivery is unavailable in
                      this build.
                    </div>
                  </div>
                ) : draft.variants != null && !SEQUENCE_RUNTIME_AVAILABLE ? (
                  <div className="muted" style={{ fontSize: 11 }}>
                    Subscriber assignment checks are unavailable until the
                    runtime and subscriber-data authorization contract are
                    qualified.
                  </div>
                ) : draft.variants != null && !isTopLevel ? (
                  <div className="muted" style={{ fontSize: 11 }}>
                    Assignment check isn&apos;t available for steps inside a
                    condition branch — only top-level steps are resolvable by
                    position.
                  </div>
                ) : null}
              </div>
            );
          })()
        : null}
    </>
  );
}

interface EmailStepFieldsProps extends StepVariantEditorProps {
  step: CanvasStep;
  regenerating: boolean;
  regenerationAvailable: boolean;
  regenerate: () => Promise<void>;
}

function EmailStepFields({
  step,
  draft,
  setDraft,
  setErr,
  readOnly,
  isTopLevel,
  sequenceId,
  previewSubscriberId,
  setPreviewSubscriberId,
  previewLoading,
  previewResult,
  setPreviewResult,
  previewErr,
  setPreviewErr,
  checkAssignment,
  regenerating,
  regenerationAvailable,
  regenerate,
}: EmailStepFieldsProps): ReactElement {
  const regenerateHelpId = useId();
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="step-edit-subject">
          Subject
        </label>
        <input
          id="step-edit-subject"
          type="text"
          className="input"
          value={draft.subject}
          disabled={readOnly}
          onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          placeholder="Welcome aboard"
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="step-edit-body">
          Body
        </label>
        <textarea
          id="step-edit-body"
          className="input"
          rows={8}
          value={draft.body}
          disabled={readOnly}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          style={{
            minHeight: 160,
            resize: "vertical",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="step-edit-template">
          Template ID (optional)
        </label>
        <input
          id="step-edit-template"
          type="text"
          className="input"
          value={draft.template_id}
          disabled={readOnly}
          onChange={(e) => setDraft({ ...draft, template_id: e.target.value })}
          placeholder="tmpl_…"
        />
      </div>

      {/* ----- A/B variants (roadmap: per-step email split) ----- */}
      <div className="field">
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: readOnly ? "default" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={draft.variants != null}
            disabled={readOnly}
            onChange={(e) => {
              setErr(null);
              setDraft({
                ...draft,
                variants: e.target.checked
                  ? seedVariantDrafts(draft.subject, draft.body, step.body_html)
                  : null,
              });
            }}
          />
          A/B test this email
        </label>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {VARIANT_STATS_HONESTY}
        </div>
      </div>

      <StepVariantEditor
        draft={draft}
        setDraft={setDraft}
        setErr={setErr}
        readOnly={readOnly}
        isTopLevel={isTopLevel}
        sequenceId={sequenceId}
        previewSubscriberId={previewSubscriberId}
        setPreviewSubscriberId={setPreviewSubscriberId}
        previewLoading={previewLoading}
        previewResult={previewResult}
        setPreviewResult={setPreviewResult}
        previewErr={previewErr}
        setPreviewErr={setPreviewErr}
        checkAssignment={checkAssignment}
      />

      {!readOnly ? (
        <div className="step-editor-ai-row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void regenerate()}
            disabled={
              regenerating ||
              !regenerationAvailable ||
              sequenceId == null ||
              !isTopLevel
            }
            aria-describedby={regenerateHelpId}
          >
            {regenerating ? "Regenerating…" : "Regenerate with AI"}
          </button>
          <span
            id={regenerateHelpId}
            className="muted"
            style={{ fontSize: 11 }}
          >
            {!regenerationAvailable
              ? "AI regeneration is unavailable because the current server mutates before review."
              : sequenceId == null
                ? "Save the sequence before regenerating."
                : !isTopLevel
                  ? "Available for top-level steps only."
                  : "Creates a preview before replacing the current draft."}
          </span>
        </div>
      ) : null}
    </>
  );
}

function OtherStepFields({
  step,
  draft,
  setDraft,
  readOnly,
}: {
  step: CanvasStep;
  draft: Draft;
  setDraft: StateSetter<Draft>;
  readOnly: boolean | undefined;
}): ReactElement {
  return (
    <>
      {step.type === "delay" ? (
        <>
          <div className="field">
            <label className="field-label" htmlFor="step-edit-delay-val">
              Wait
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="step-edit-delay-val"
                type="number"
                min={1}
                className="input"
                value={draft.delay_value}
                disabled={readOnly}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    delay_value: Number.parseInt(e.target.value, 10) || 0,
                  })
                }
                style={{ width: 100 }}
              />
              <select
                className="input"
                value={draft.delay_unit}
                disabled={readOnly}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    delay_unit: e.target.value as Draft["delay_unit"],
                  })
                }
                style={{ flex: 1 }}
                aria-label="Delay unit"
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </div>
          </div>
        </>
      ) : null}

      {step.type === "condition" ? (
        <>
          <div className="field">
            <label className="field-label" htmlFor="step-edit-cond-type">
              Branch on
            </label>
            <select
              id="step-edit-cond-type"
              className="input"
              value={draft.condition_type}
              disabled={readOnly}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  condition_type: e.target.value as Draft["condition_type"],
                })
              }
            >
              <option value="opened">Opened previous email</option>
              <option value="clicked">Clicked a link</option>
              <option value="tagged">Has tag</option>
              <option value="custom_property">Custom property</option>
              <option value="product_event">Product event</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="step-edit-cond-val">
              {draft.condition_type === "tagged"
                ? "Tag name"
                : draft.condition_type === "product_event"
                  ? "Event name"
                  : draft.condition_type === "custom_property"
                    ? "Property = value (e.g. plan=pro)"
                    : "Value (optional)"}
            </label>
            <input
              id="step-edit-cond-val"
              type="text"
              className="input"
              value={draft.condition_value}
              disabled={readOnly}
              onChange={(e) =>
                setDraft({ ...draft, condition_value: e.target.value })
              }
            />
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Two branches will appear on the canvas: one for Yes, one for No.
            Drag steps onto either branch.
          </div>
        </>
      ) : null}

      {step.type === "tag_add" || step.type === "tag_remove" ? (
        <div className="field">
          <label className="field-label" htmlFor="step-edit-tag">
            Tag
          </label>
          <input
            id="step-edit-tag"
            type="text"
            className="input"
            value={draft.tag}
            disabled={readOnly}
            onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
            placeholder="customer"
          />
        </div>
      ) : null}

      {step.type === "exit" ? (
        <div className="muted" style={{ fontSize: 12 }}>
          This marks the intended end of the draft path. It does not currently
          stop or move any subscriber. No configuration required.
        </div>
      ) : null}
    </>
  );
}

function StepEditorFooter({
  readOnly,
  busy,
  onDeleteRequest,
  onCancel,
  onSave,
}: {
  readOnly: boolean | undefined;
  busy: boolean;
  onDeleteRequest: () => void;
  onCancel: () => void;
  onSave: () => void;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        width: "100%",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <button
        type="button"
        className="btn btn-danger"
        onClick={onDeleteRequest}
        disabled={readOnly || busy}
      >
        Delete
      </button>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSave}
          disabled={readOnly || busy}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function RegeneratedStepReview({
  draft,
  onAccept,
  onClose,
  preview,
}: {
  draft: Pick<Draft, "subject" | "body">;
  onAccept: () => void | Promise<void>;
  onClose: () => void;
  preview: Pick<Draft, "subject" | "body"> | null;
}): ReactElement {
  return (
    <Modal
      open={preview != null}
      onClose={onClose}
      title="Review regenerated step"
      description="Accept replaces this step's subject and body. Discard keeps your current draft."
    >
      <div className="step-regenerate-diff">
        <div>
          <div className="field-label">Before</div>
          <div className="step-regenerate-panel">
            <div className="step-regenerate-subject">
              {draft.subject || "(no subject)"}
            </div>
            <pre>{draft.body || "(empty body)"}</pre>
          </div>
        </div>
        <div>
          <div className="field-label">After</div>
          <div className="step-regenerate-panel is-after">
            <div className="step-regenerate-subject">
              {preview?.subject || "(no subject)"}
            </div>
            <pre>{preview?.body || "(empty body)"}</pre>
          </div>
        </div>
      </div>
      <ModalFooter>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onClose}>
          Discard
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onAccept()}
        >
          Accept rewrite
        </button>
      </ModalFooter>
    </Modal>
  );
}

function stepEditorSubtitle(
  position: number,
  readOnly: boolean | undefined,
  dirty: boolean,
): string {
  const state = readOnly
    ? "Read-only"
    : dirty
      ? "Unsaved changes"
      : "No unsaved changes";
  return `Position ${position} in sequence · ${state}`;
}

export function StepEditor({
  step,
  readOnly,
  sequenceId,
  isTopLevel,
  onSave,
  onCancel,
  onDelete,
}: Props): ReactElement {
  const [draft, setDraft] = useState<Draft>(() => draftFromStep(step));
  const [discardOpen, setDiscardOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenPreview, setRegenPreview] = useState<Pick<
    Draft,
    "subject" | "body"
  > | null>(null);
  // Variant-assignment preview: "which arm would this subscriber get?"
  // Resolves against the LAST SAVED variants server-side (pure hash, no
  // state written) — unsaved edits in this editor are not reflected.
  const [previewSubscriberId, setPreviewSubscriberId] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] =
    useState<SequenceStepVariantAssignment | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const savingRef = useRef(false);
  const regeneratingRef = useRef(false);
  const previewLoadingRef = useRef(false);
  const requestEpochRef = useRef(0);

  // If the parent swaps to a different step while the editor is open,
  // re-seed the draft.
  useEffect(() => {
    requestEpochRef.current += 1;
    savingRef.current = false;
    regeneratingRef.current = false;
    previewLoadingRef.current = false;
    setDraft(draftFromStep(step));
    setDiscardOpen(false);
    setErr(null);
    setRegenerating(false);
    setRegenPreview(null);
    setPreviewSubscriberId("");
    setPreviewLoading(false);
    setPreviewResult(null);
    setPreviewErr(null);
    return () => {
      requestEpochRef.current += 1;
    };
  }, [step.id, step]);

  // Local mutation wrapper — keyed on [campaigns, update, stepId] so
  // the per-resource outbox retry/backoff defaults apply and the
  // canvas-level usePendingMutations selector can spot in-flight edits
  // for a specific step. The mutationFn just hands the next step to
  // the parent (which owns the persist round-trip) — TanStack tracks
  // the variables purely for the optimistic UI overlay.
  const saveStepMut = useMutation<void, Error, CanvasStep>({
    mutationKey: mutKey("campaigns", "update", step.id),
    mutationFn: async (next) => await onSave(next),
    onError: (error) => {
      setErr(error.message || "The step couldn't be saved. Try again.");
    },
    onSettled: () => {
      savingRef.current = false;
    },
  });
  const draftDirty =
    JSON.stringify(draft) !== JSON.stringify(draftFromStep(step));
  const operationBusy = regenerating || previewLoading || saveStepMut.isPending;

  useEffect(() => {
    if (!draftDirty && !operationBusy) return;
    return registerLifecycleGuard({
      id: `sequence-step-${step.id}`,
      label: `${stepTypeLabel(step.type)} step changes`,
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : operationBusy
            ? {
                level: "blocking",
                detail:
                  "The sequence step is still saving or generating content.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail: "The sequence step has unsaved local changes.",
              },
      discard: onCancel,
    });
  }, [draftDirty, onCancel, operationBusy, step.id, step.type]);

  const save = (): void => {
    if (savingRef.current || operationBusy) return;
    const result = stepFromDraft(step, draft);
    if ("error" in result) {
      setErr(result.error);
      return;
    }
    savingRef.current = true;
    setErr(null);
    saveStepMut.mutate(result.next);
  };

  const regenerate = async (): Promise<void> => {
    // D07#2: the AI-rewrite endpoint addresses steps by their flat,
    // top-level 1-based position; a step nested in a condition branch has
    // no flat position identity on the wire, so calling regenerate for one
    // would target the wrong step. Gate to top-level steps only (mirrors
    // the assignment-check gating below).
    if (
      readOnly ||
      !SEQUENCE_REGENERATION_AVAILABLE ||
      step.type !== "email" ||
      sequenceId == null ||
      !isTopLevel ||
      regeneratingRef.current
    ) {
      return;
    }
    const requestEpoch = requestEpochRef.current;
    regeneratingRef.current = true;
    setErr(null);
    setRegenerating(true);
    try {
      // The client polls the async regenerate job to completion and returns
      // the regenerated {subject, body} directly (D07#2) — no SequenceDetail
      // extraction needed here anymore.
      const res = await api.regenerateSequenceStep(sequenceId, step.position);
      if (requestEpoch !== requestEpochRef.current) return;
      if (res.error) {
        setErr(`AI regenerate failed: ${res.error.message}`);
        return;
      }
      const next = res.data;
      if (!next || (!next.subject.trim() && !next.body.trim())) {
        setErr("AI regenerate returned no editable email content.");
        return;
      }
      setRegenPreview(next);
    } catch (error) {
      if (requestEpoch !== requestEpochRef.current) return;
      setErr(
        error instanceof Error && error.message
          ? `AI regenerate failed: ${error.message}`
          : "AI regenerate failed. Try again.",
      );
    } finally {
      if (requestEpoch === requestEpochRef.current) {
        regeneratingRef.current = false;
        setRegenerating(false);
      }
    }
  };

  const checkAssignment = async (): Promise<void> => {
    if (
      !SEQUENCE_RUNTIME_AVAILABLE ||
      step.type !== "email" ||
      sequenceId == null ||
      previewLoadingRef.current
    ) {
      return;
    }
    const subscriberId = previewSubscriberId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(subscriberId)) {
      setPreviewErr(
        "Enter an opaque subscriber ID using letters, numbers, dots, underscores, or dashes.",
      );
      return;
    }
    const requestEpoch = requestEpochRef.current;
    previewLoadingRef.current = true;
    setPreviewErr(null);
    setPreviewResult(null);
    setPreviewLoading(true);
    try {
      const res = await voiceRoadmapApi.getStepVariant(
        sequenceId,
        step.position,
        subscriberId,
      );
      if (requestEpoch !== requestEpochRef.current) return;
      if (res.error) {
        // 404 = the SAVED step has no variants (or isn't an email step) —
        // the most common cause right after toggling A/B on.
        if (res.error.status === 404) {
          setPreviewErr(
            "No saved variants on this step yet — save the step first, then check again.",
          );
        } else {
          setPreviewErr(
            `Couldn't resolve the assignment: ${res.error.message}`,
          );
        }
        return;
      }
      setPreviewResult(res.data ?? null);
    } catch (error) {
      if (requestEpoch !== requestEpochRef.current) return;
      setPreviewErr(
        error instanceof Error && error.message
          ? `Couldn't resolve the assignment: ${error.message}`
          : "Couldn't resolve the assignment. Try again.",
      );
    } finally {
      if (requestEpoch === requestEpochRef.current) {
        previewLoadingRef.current = false;
        setPreviewLoading(false);
      }
    }
  };

  const acceptRegenerate = async (): Promise<void> => {
    if (
      readOnly ||
      !SEQUENCE_REGENERATION_AVAILABLE ||
      !regenPreview ||
      step.type !== "email"
    ) {
      return;
    }
    const subject = regenPreview.subject.trim();
    if (!subject) {
      setErr("AI regenerate returned an empty subject.");
      setRegenPreview(null);
      return;
    }
    savingRef.current = true;
    setErr(null);
    try {
      await saveStepMut.mutateAsync({
        ...step,
        subject,
        body: regenPreview.body,
        body_html: undefined,
      });
      setRegenPreview(null);
    } catch {
      // The shared mutation surfaces the server-confirmation error and keeps
      // the preview open so the operator can retry without losing the rewrite.
    }
  };

  const requestClose = (): void => {
    if (
      savingRef.current ||
      regeneratingRef.current ||
      previewLoadingRef.current ||
      operationBusy
    ) {
      return;
    }
    if (draftDirty) {
      setDiscardOpen(true);
      return;
    }
    onCancel();
  };

  return (
    <>
      <SlideoverShell
        open
        onClose={requestClose}
        size="md"
        eyebrow="Sequence step"
        title={`Edit ${stepTypeLabel(step.type).toLowerCase()} step`}
        subtitle={stepEditorSubtitle(step.position, readOnly, draftDirty)}
        closeOnBackdrop={!draftDirty && !operationBusy}
        busy={operationBusy}
        footer={
          <StepEditorFooter
            readOnly={readOnly}
            busy={operationBusy}
            onDeleteRequest={() => onDelete(step.id)}
            onCancel={requestClose}
            onSave={save}
          />
        }
      >
        {step.type === "email" ? (
          <EmailStepFields
            step={step}
            draft={draft}
            setDraft={setDraft}
            setErr={setErr}
            readOnly={readOnly}
            isTopLevel={isTopLevel}
            sequenceId={sequenceId}
            previewSubscriberId={previewSubscriberId}
            setPreviewSubscriberId={setPreviewSubscriberId}
            previewLoading={previewLoading}
            previewResult={previewResult}
            setPreviewResult={setPreviewResult}
            previewErr={previewErr}
            setPreviewErr={setPreviewErr}
            checkAssignment={checkAssignment}
            regenerating={regenerating}
            regenerationAvailable={SEQUENCE_REGENERATION_AVAILABLE}
            regenerate={regenerate}
          />
        ) : null}

        <OtherStepFields
          step={step}
          draft={draft}
          setDraft={setDraft}
          readOnly={readOnly}
        />

        {err ? (
          <div className="field-error" role="alert">
            {err}
          </div>
        ) : null}
      </SlideoverShell>

      <ConfirmModal
        open={discardOpen}
        title="Discard unsaved step changes?"
        description={`Your edits to this ${stepTypeLabel(step.type).toLowerCase()} step will be lost. The saved sequence remains unchanged.`}
        confirmLabel="Discard changes"
        danger
        onClose={() => setDiscardOpen(false)}
        onConfirm={onCancel}
      />

      <RegeneratedStepReview
        draft={draft}
        onAccept={acceptRegenerate}
        onClose={() => setRegenPreview(null)}
        preview={regenPreview}
      />
    </>
  );
}
