/**
 * Sequences — visual drag-and-drop step canvas (Customer.io / ConvertKit
 * / ActiveCampaign style). The list view stays the same; clicking a
 * sequence opens an in-page canvas builder. The legacy form-based
 * SequenceDetailSlideover is no longer reachable from here.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { HeroEmptyState } from "../components/HeroEmptyState";
import { ConfirmModal } from "../components/ConfirmModal";
import { ChoiceGroup, type ChoiceGroupOption } from "../components/ChoiceGroup";
import { Modal, ModalFooter } from "../components/Modal";
import {
  DRAFT_BRIEF_MAX_LENGTH,
  DRAFT_STEP_COUNT_MAX,
  DRAFT_TONE_MAX_LENGTH,
  draftStepsToCanvasSteps,
  formatDraftDelay,
} from "../components/sequence/draft-steps";
import { StepCanvas } from "../components/sequence/StepCanvas";
import { toast } from "../components/Toast";
import {
  type Sequence,
  type SequenceCanvasStep,
  type SequenceDraftResponse,
  api,
} from "../lib/api-client";
import {
  navigateDesktopResource,
  requestDesktopRouteNavigation,
  useDesktopRoute,
} from "../lib/desktop-router";
import {
  SEQUENCE_RUNTIME_UNAVAILABLE_REASON,
  sequenceStatusPresentation,
} from "../lib/sequence-operational-availability";
import { HERO } from "../lib/heroAssets";
import {
  AI_BRIEF_EXAMPLES,
  type AiBriefDraft,
  generateSequenceFromBrief,
} from "../lib/sequences-ai-brief";
import {
  SEQUENCES_TEMPLATES,
  type SequencesTemplate,
} from "../lib/sequences-templates";
import { useCanWrite, useRoleStatus } from "../lib/store";
import { usePersistentLifecycleOperation } from "../hooks/usePersistentLifecycleOperation";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../hooks/useSettingsDraftLifecycle";
import "../styles-sequences-v2.css";

type CreateMode = "templates" | "ai" | "blank";

const SEQUENCE_LIBRARY_ROW_LIMIT = 500;
const SEQUENCE_LIBRARY_STEP_LIMIT = 1_000;
const SEQUENCE_ID_MAX_LENGTH = 254;
const SEQUENCE_NAME_MAX_LENGTH = 512;

const SEQUENCE_CREATE_TABS = [
  { value: "templates", label: "Templates" },
  { value: "ai", label: "AI generate" },
  { value: "blank", label: "Blank" },
] as const;

function cloneSequenceSteps(steps: SequenceCanvasStep[]): SequenceCanvasStep[] {
  return steps.map((step, index) => {
    const copy = JSON.parse(JSON.stringify(step)) as SequenceCanvasStep;
    copy.position = index + 1;
    return copy;
  });
}

function statusBadge(status: string | undefined): ReactElement {
  const presentation = sequenceStatusPresentation(status);
  const toneClass =
    presentation.tone === "danger"
      ? " danger"
      : presentation.tone === "warning"
        ? " warning"
        : "";
  return (
    <span
      className={`badge${toneClass}`}
      aria-label={`${presentation.label}: ${presentation.detail}`}
    >
      {presentation.label}
    </span>
  );
}

function SequenceTemplateChoices({
  canCreate,
  operationActive,
  selectedTemplateKey,
  onPick,
}: {
  canCreate: boolean;
  operationActive: boolean;
  selectedTemplateKey: string;
  onPick: (template: SequencesTemplate | null) => void;
}): ReactElement {
  const options: readonly ChoiceGroupOption<string>[] = [
    {
      value: "blank",
      label: (
        <span
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--pw-sp-2)",
          }}
        >
          <span className="seq-template-icon" aria-hidden="true">
            +
          </span>
          <span className="seq-template-body">
            <span className="seq-template-title">Blank canvas</span>
            <span className="seq-template-desc">
              Start empty and drag each step yourself.
            </span>
            <span className="seq-template-preview">0 starter steps</span>
          </span>
        </span>
      ),
    },
    ...SEQUENCES_TEMPLATES.map(
      (template): ChoiceGroupOption<string> => ({
        value: template.key,
        label: (
          <span
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "var(--pw-sp-2)",
            }}
          >
            <span className="seq-template-icon" aria-hidden="true">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={template.iconPath} />
              </svg>
            </span>
            <span className="seq-template-body">
              <span className="seq-template-title">{template.name}</span>
              <span className="seq-template-desc">{template.description}</span>
              <span className="seq-template-preview">
                {template.previewSteps.join(" · ")}
              </span>
            </span>
          </span>
        ),
      }),
    ),
  ];
  return (
    <ChoiceGroup
      legend="Sequence template"
      value={selectedTemplateKey}
      options={options}
      onChange={(key) => {
        const selected = SEQUENCES_TEMPLATES.find(
          (template) => template.key === key,
        );
        onPick(selected ?? null);
      }}
      disabled={operationActive || !canCreate}
      className="seq-template-grid"
      optionClassName="seq-template-card"
    />
  );
}

function SequenceAiDraftFields({
  aiDraft,
  aiGenerating,
  aiServerDraft,
  aiStepCount,
  aiTone,
  brief,
  canCreate,
  operationActive,
  onBriefChange,
  onGenerate,
  onQuickMatch,
  onStepCountChange,
  onToneChange,
}: {
  aiDraft: AiBriefDraft | null;
  aiGenerating: boolean;
  aiServerDraft: SequenceDraftResponse | null;
  aiStepCount: string;
  aiTone: string;
  brief: string;
  canCreate: boolean;
  operationActive: boolean;
  onBriefChange: (value: string) => void;
  onGenerate: () => void;
  onQuickMatch: () => void;
  onStepCountChange: (value: string) => void;
  onToneChange: (value: string) => void;
}): ReactElement {
  return (
    <div className="seq-ai-brief-panel">
      <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
        Describe the sequence you want; the voice service drafts the subjects,
        body copy, and waits with AI. Review the structure before it is stored;
        the result remains an inactive draft.
      </p>
      <div className="field">
        <label className="field-label" htmlFor="seq-ai-brief">
          Brief
        </label>
        <textarea
          id="seq-ai-brief"
          className="input"
          rows={4}
          maxLength={DRAFT_BRIEF_MAX_LENGTH}
          value={brief}
          disabled={operationActive || !canCreate}
          onChange={(event) => onBriefChange(event.target.value)}
          placeholder="4-step welcome for B2C signups, nudge first purchase by day 7"
        />
        <div className="field-help">
          {brief.length}/{DRAFT_BRIEF_MAX_LENGTH} characters
        </div>
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <div className="field" style={{ flex: "0 0 140px" }}>
          <label className="field-label" htmlFor="seq-ai-step-count">
            Emails (optional)
          </label>
          <input
            id="seq-ai-step-count"
            type="number"
            className="input"
            min={1}
            max={DRAFT_STEP_COUNT_MAX}
            step={1}
            placeholder="auto"
            value={aiStepCount}
            disabled={operationActive || !canCreate}
            onChange={(event) => onStepCountChange(event.target.value)}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label" htmlFor="seq-ai-tone">
            Tone (optional)
          </label>
          <input
            id="seq-ai-tone"
            type="text"
            className="input"
            maxLength={DRAFT_TONE_MAX_LENGTH}
            placeholder="friendly, no-nonsense, playful…"
            value={aiTone}
            disabled={operationActive || !canCreate}
            onChange={(event) => onToneChange(event.target.value)}
          />
        </div>
      </div>
      <div className="seq-ai-examples" aria-label="Example briefs">
        {AI_BRIEF_EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="btn btn-sm"
            disabled={operationActive || !canCreate}
            onClick={() => onBriefChange(example)}
          >
            {example}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={operationActive || !canCreate}
          onClick={onGenerate}
        >
          {aiGenerating ? "Drafting…" : "Generate with AI"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={operationActive || !canCreate}
          onClick={onQuickMatch}
        >
          Quick match (no AI)
        </button>
      </div>
      <p className="field-help" style={{ margin: "4px 0 0" }}>
        Quick match uses the curated template library locally. It is instant and
        does not make an AI request or consume AI quota.
      </p>
      {aiGenerating ? (
        <p
          className="muted"
          role="status"
          style={{ fontSize: 12, margin: "8px 0 0" }}
        >
          Drafting with AI — a full sequence draft can take up to a minute. Keep
          this dialog open.
        </p>
      ) : null}
      {aiServerDraft ? (
        <div className="seq-ai-preview" role="status">
          <div style={{ fontWeight: 600 }}>AI draft: {aiServerDraft.name}</div>
          <ol>
            {aiServerDraft.steps.map((step, index) => (
              <li key={`${step.position}-${index}`}>
                <span>
                  {formatDraftDelay(step.delay_hours)} · {step.subject}
                </span>
                <small>
                  {step.body.length > 160
                    ? `${step.body.slice(0, 160)}…`
                    : step.body}
                </small>
              </li>
            ))}
          </ol>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            Nothing is saved yet — hit “Create sequence” to accept this draft,
            or regenerate with a sharper brief.
          </p>
        </div>
      ) : null}
      {aiDraft ? (
        <div className="seq-ai-preview" role="status">
          <div style={{ fontWeight: 600 }}>{aiDraft.summary}</div>
          <ol>
            {aiDraft.steps.map((step, index) => (
              <li key={`${step.step.type}-${index}`}>
                <span>{step.step.type.replace("_", " ")}</span>
                <small>{step.rationale}</small>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

export function SequenceCreateDialog({
  aiDraft,
  aiGenerating,
  aiServerDraft,
  aiStepCount,
  aiTone,
  brief,
  canCreate,
  createMode,
  name,
  open,
  operationActive,
  selectedTemplateKey,
  submitErr,
  submitting,
  unavailableReason,
  onAiStepCountChange,
  onAiToneChange,
  onBriefChange,
  onClose,
  onGenerate,
  onModeChange,
  onNameChange,
  onPickTemplate,
  onQuickMatch,
  onSubmit,
}: {
  aiDraft: AiBriefDraft | null;
  aiGenerating: boolean;
  aiServerDraft: SequenceDraftResponse | null;
  aiStepCount: string;
  aiTone: string;
  brief: string;
  canCreate: boolean;
  createMode: CreateMode;
  name: string;
  open: boolean;
  operationActive: boolean;
  selectedTemplateKey: string;
  submitErr: string | null;
  submitting: boolean;
  unavailableReason: string | null;
  onAiStepCountChange: (value: string) => void;
  onAiToneChange: (value: string) => void;
  onBriefChange: (value: string) => void;
  onClose: () => void;
  onGenerate: () => void;
  onModeChange: (mode: CreateMode) => void;
  onNameChange: (value: string) => void;
  onPickTemplate: (template: SequencesTemplate | null) => void;
  onQuickMatch: () => void;
  onSubmit: () => void;
}): ReactElement {
  const tabs = useTabsInteraction<CreateMode>({
    activation: "manual",
    value: createMode,
    items: SEQUENCE_CREATE_TABS.map((item) => ({
      value: item.value,
      disabled: operationActive,
    })),
    onChange: onModeChange,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New sequence"
      description="Create a reviewable journey draft from starter copy, AI-assisted copy, or a blank canvas. Nothing created here activates delivery."
    >
      <div
        ref={tabs.listRef}
        className="seq-create-tabs"
        {...tabs.listProps}
        aria-label="Sequence creation mode"
      >
        {SEQUENCE_CREATE_TABS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            {...tabs.getTabProps(value)}
            className={
              "btn btn-sm" + (createMode === value ? " btn-primary" : "")
            }
            disabled={operationActive || !canCreate}
          >
            {label}
          </button>
        ))}
      </div>

      <section {...tabs.getPanelProps("templates")}>
        <SequenceTemplateChoices
          canCreate={canCreate}
          operationActive={operationActive}
          selectedTemplateKey={selectedTemplateKey}
          onPick={onPickTemplate}
        />
      </section>
      <section {...tabs.getPanelProps("ai")}>
        <SequenceAiDraftFields
          aiDraft={aiDraft}
          aiGenerating={aiGenerating}
          aiServerDraft={aiServerDraft}
          aiStepCount={aiStepCount}
          aiTone={aiTone}
          brief={brief}
          canCreate={canCreate}
          operationActive={operationActive}
          onBriefChange={onBriefChange}
          onGenerate={onGenerate}
          onQuickMatch={onQuickMatch}
          onStepCountChange={onAiStepCountChange}
          onToneChange={onAiToneChange}
        />
      </section>
      <section {...tabs.getPanelProps("blank")}>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
          Start with an empty canvas and add each message, wait, branch, and
          draft-only exit yourself.
        </p>
      </section>

      <div className="field">
        <label className="field-label" htmlFor="seq-name">
          Name
        </label>
        <input
          id="seq-name"
          type="text"
          className="input"
          placeholder="Onboarding drip"
          value={name}
          disabled={operationActive || !canCreate}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      {unavailableReason ? (
        <div className="notice" role="status">
          <span>{unavailableReason}</span>
        </div>
      ) : null}
      {submitErr ? (
        <div className="field-error" role="alert">
          {submitErr}
        </div>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={operationActive}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSubmit}
          disabled={operationActive || !canCreate}
        >
          {submitting ? "Creating…" : "Create sequence"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

interface MountedFlag {
  current: boolean;
}

function unwrapSequences(payload: unknown): Sequence[] | null {
  let rows: unknown[] | null = null;
  if (Array.isArray(payload)) rows = payload;
  if (!rows && (!payload || typeof payload !== "object")) return null;
  const record = payload as Record<string, unknown>;
  if (!rows) {
    for (const key of ["items", "sequences", "data"] as const) {
      if (Array.isArray(record[key])) {
        rows = record[key];
        break;
      }
    }
  }
  if (!rows) return null;
  if (rows.length > SEQUENCE_LIBRARY_ROW_LIMIT) return null;
  const identities = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return null;
    }
    const candidate = row as Sequence;
    const id = candidate.id;
    const validId =
      (typeof id === "string" &&
        id.trim().length > 0 &&
        id.length <= SEQUENCE_ID_MAX_LENGTH) ||
      (typeof id === "number" && Number.isSafeInteger(id) && id > 0);
    if (!validId) return null;
    const identity = `${typeof id}:${String(id)}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    if (
      candidate.name !== undefined &&
      (typeof candidate.name !== "string" ||
        candidate.name.trim().length === 0 ||
        candidate.name.length > SEQUENCE_NAME_MAX_LENGTH)
    ) {
      return null;
    }
    if (
      candidate.status !== undefined &&
      (typeof candidate.status !== "string" ||
        !["draft", "archived", "active", "running", "paused"].includes(
          candidate.status.trim().toLowerCase(),
        ))
    ) {
      return null;
    }
    if (
      candidate.active_runs !== undefined &&
      (typeof candidate.active_runs !== "number" ||
        !Number.isSafeInteger(candidate.active_runs) ||
        candidate.active_runs < 0)
    ) {
      return null;
    }
    const steps = candidate.steps as unknown;
    if (
      steps !== undefined &&
      !(
        (typeof steps === "number" &&
          Number.isSafeInteger(steps) &&
          steps >= 0 &&
          steps <= SEQUENCE_LIBRARY_STEP_LIMIT) ||
        (Array.isArray(steps) && steps.length <= SEQUENCE_LIBRARY_STEP_LIMIT)
      )
    ) {
      return null;
    }
  }
  return rows as Sequence[];
}

function parseDraftStepCount(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= DRAFT_STEP_COUNT_MAX
    ? parsed
    : Number.NaN;
}

function useSequencesData(
  mountedRef: MountedFlag,
  routeResourceId: string | undefined,
) {
  const [items, setItems] = useState<Sequence[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Sequence | null>(
    null,
  );
  const itemsRef = useRef<Sequence[] | null>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  itemsRef.current = items;

  const load = useCallback(async (): Promise<boolean> => {
    const token = ++requestRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    const retainingSnapshot = itemsRef.current !== null;
    setLoading(!retainingSnapshot);
    setRefreshing(retainingSnapshot);
    setErr(null);
    try {
      const res = await api.listSequences({ signal: abort.signal });
      if (!mountedRef.current || token !== requestRef.current) return false;
      if (res.error) {
        setErr(res.error.message);
        setStale(retainingSnapshot);
        return false;
      } else {
        const next = unwrapSequences(res.data);
        if (!next) {
          setErr("The sequence service returned an invalid library response.");
          setStale(retainingSnapshot);
          return false;
        }
        itemsRef.current = next;
        setItems(next);
        setStale(false);
        return true;
      }
    } catch (loadError) {
      if (mountedRef.current && token === requestRef.current) {
        setErr(
          lifecycleOperationError(loadError, "Sequences could not be loaded."),
        );
        setStale(retainingSnapshot);
      }
      return false;
    } finally {
      if (mountedRef.current && token === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
        if (abortRef.current === abort) abortRef.current = null;
      }
    }
  }, [mountedRef]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
      abortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (
      selectedSnapshot?.id != null &&
      String(selectedSnapshot.id) !== routeResourceId
    ) {
      setSelectedSnapshot(null);
    }
  }, [routeResourceId, selectedSnapshot]);

  const selected = routeResourceId
    ? selectedSnapshot?.id != null &&
      String(selectedSnapshot.id) === routeResourceId
      ? selectedSnapshot
      : (items?.find((sequence) => String(sequence.id) === routeResourceId) ?? {
          id: routeResourceId,
          name: "Sequence draft",
        })
    : null;

  const openSelected = useCallback((sequence: Sequence): void => {
    if (sequence.id == null) return;
    setSelectedSnapshot(sequence);
    navigateDesktopResource("sequences", String(sequence.id));
  }, []);

  const updateSelected = useCallback(
    (sequence: Sequence): void => {
      if (
        sequence.id == null ||
        !routeResourceId ||
        String(sequence.id) !== routeResourceId
      ) {
        return;
      }
      setSelectedSnapshot(sequence);
      setItems(
        (current) =>
          current?.map((item) =>
            String(item.id) === routeResourceId
              ? { ...item, ...sequence }
              : item,
          ) ?? current,
      );
    },
    [routeResourceId],
  );

  return {
    err,
    items,
    load,
    loading,
    refreshing,
    stale,
    selected,
    openSelected,
    updateSelected,
  };
}

function useSequenceCreateController({
  canCreate,
  createUnavailableReason,
  mountedRef,
  onCreated,
}: {
  canCreate: boolean;
  createUnavailableReason: string | null;
  mountedRef: MountedFlag;
  onCreated: (sequence: Sequence | undefined) => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "" });
  const [createMode, setCreateMode] = useState<CreateMode>("templates");
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("blank");
  const [brief, setBrief] = useState("");
  const [aiDraft, setAiDraft] = useState<AiBriefDraft | null>(null);
  const [aiServerDraft, setAiServerDraft] =
    useState<SequenceDraftResponse | null>(null);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiStepCount, setAiStepCount] = useState("");
  const [aiTone, setAiTone] = useState("");
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const aiRequestSeq = useRef(0);
  const canCreateRef = useRef(canCreate);
  canCreateRef.current = canCreate;
  const operation = usePersistentLifecycleOperation({
    ownerId: "sequence-create",
    label: "Sequence draft request",
    detail:
      "Wait for the sequence drafting or create request to finish before leaving Moosewave.",
  });

  useEffect(
    () => () => {
      aiRequestSeq.current += 1;
    },
    [],
  );

  const createDraftDirty =
    createOpen &&
    (draft.name !== "" ||
      createMode !== "templates" ||
      selectedTemplateKey !== "blank" ||
      brief !== "" ||
      aiDraft !== null ||
      aiServerDraft !== null ||
      aiStepCount !== "" ||
      aiTone !== "");
  const discardCreateDraft = useCallback((): void => {
    aiRequestSeq.current += 1;
    setDraft({ name: "" });
    setCreateMode("templates");
    setSelectedTemplateKey("blank");
    setBrief("");
    setAiDraft(null);
    setAiServerDraft(null);
    setAiGenerating(false);
    setAiStepCount("");
    setAiTone("");
    setSubmitErr(null);
    setDiscardConfirmOpen(false);
    setCreateOpen(false);
  }, []);
  const requestCreateClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (createDraftDirty) setDiscardConfirmOpen(true);
    else discardCreateDraft();
  }, [createDraftDirty, discardCreateDraft, operation.promiseRef]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "sequence-create",
    label: "Sequence create and AI draft",
    dirty: createDraftDirty,
    operationRef: operation.promiseRef,
    discard: discardCreateDraft,
    detail:
      "This sequence name, template selection, brief, or generated step draft has not been created. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the sequence drafting or create request to finish before leaving Moosewave.",
    enabled: createOpen,
  });

  const openCreate = (): void => {
    if (operation.promiseRef.current || !canCreateRef.current) return;
    setDraft({ name: "" });
    setCreateMode("templates");
    setSelectedTemplateKey("blank");
    setBrief("");
    setAiDraft(null);
    setAiServerDraft(null);
    setAiGenerating(false);
    setAiStepCount("");
    setAiTone("");
    aiRequestSeq.current += 1;
    setSubmitErr(null);
    setDiscardConfirmOpen(false);
    setCreateOpen(true);
  };

  const pickTemplate = (template: SequencesTemplate | null): void => {
    if (!canCreateRef.current) return;
    setSubmitErr(null);
    setAiDraft(null);
    setAiServerDraft(null);
    setSelectedTemplateKey(template?.key ?? "blank");
    setDraft({ name: template?.name ?? "" });
  };

  const generateFromBrief = (): void => {
    if (!canCreateRef.current) return;
    const trimmed = brief.trim();
    if (!trimmed) {
      setSubmitErr("Describe the sequence you want to generate.");
      return;
    }
    const generated = generateSequenceFromBrief(trimmed);
    if (!generated) {
      setAiDraft(null);
      setSubmitErr(
        "No close template match yet. Try one of the examples or start from a template.",
      );
      return;
    }
    setSubmitErr(null);
    setAiDraft(generated);
    setAiServerDraft(null);
    setSelectedTemplateKey("blank");
    setDraft({ name: generated.proposedName });
  };

  const generateWithAi = async (): Promise<void> => {
    if (!canCreateRef.current) return;
    const trimmed = brief.trim();
    if (!trimmed) {
      setSubmitErr("Describe the sequence you want to generate.");
      return;
    }
    const parsedStepCount = parseDraftStepCount(aiStepCount);
    if (parsedStepCount !== null && Number.isNaN(parsedStepCount)) {
      setSubmitErr(
        `Email count must be a whole number between 1 and ${DRAFT_STEP_COUNT_MAX}.`,
      );
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const requestId = ++aiRequestSeq.current;
    setAiGenerating(true);
    setSubmitErr(null);
    const tone = aiTone.trim();
    const request = operation.run(async (): Promise<void> => {
      try {
        if (!canCreateRef.current) return;
        const res = await api.draftSequence({
          brief: trimmed,
          ...(parsedStepCount === null ? {} : { step_count: parsedStepCount }),
          ...(tone ? { tone } : {}),
        });
        if (
          !mountedRef.current ||
          !createOpen ||
          requestId !== aiRequestSeq.current
        ) {
          return;
        }
        if (res.error) {
          if (res.error.status === 429) {
            setSubmitErr(
              `AI quota reached: ${res.error.message} Try again later, or use Quick match below — it's instant and doesn't consume quota.`,
            );
          } else if (res.error.status === 503) {
            setSubmitErr(
              `AI drafting isn't configured on this server (${res.error.message}). Use Quick match or a template instead.`,
            );
          } else {
            setSubmitErr(`Couldn't draft the sequence: ${res.error.message}`);
          }
          return;
        }
        const generated = res.data;
        if (
          !generated ||
          !Array.isArray(generated.steps) ||
          generated.steps.length === 0
        ) {
          setSubmitErr(
            "The AI returned an empty draft — try rephrasing the brief.",
          );
          return;
        }
        setAiServerDraft(generated);
        setAiDraft(null);
        setSelectedTemplateKey("blank");
        setDraft((current) => ({
          ...current,
          name: generated.name || current.name,
        }));
      } catch (draftError) {
        if (mountedRef.current && requestId === aiRequestSeq.current) {
          setSubmitErr(
            `Couldn't draft the sequence: ${lifecycleOperationError(
              draftError,
              "The AI drafting request did not complete.",
            )}`,
          );
        }
      } finally {
        if (mountedRef.current && requestId === aiRequestSeq.current) {
          setAiGenerating(false);
        }
      }
    });
    if (request) await request;
  };

  const submitCreate = async (): Promise<void> => {
    if (!canCreateRef.current) return;
    const selectedTemplate = SEQUENCES_TEMPLATES.find(
      (template) => template.key === selectedTemplateKey,
    );
    const name =
      draft.name.trim() ||
      (createMode === "ai"
        ? aiServerDraft?.name || aiDraft?.proposedName
        : createMode === "templates"
          ? selectedTemplate?.name
          : undefined) ||
      "Untitled sequence";
    const steps =
      createMode === "ai"
        ? aiServerDraft
          ? draftStepsToCanvasSteps(aiServerDraft.steps)
          : aiDraft
            ? cloneSequenceSteps(aiDraft.steps.map((step) => step.step))
            : []
        : createMode === "templates" && selectedTemplate
          ? cloneSequenceSteps(selectedTemplate.steps)
          : [];
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    const request = operation.run(async (): Promise<void> => {
      try {
        if (!canCreateRef.current) return;
        const res = await api.createSequence({ name, steps });
        if (!mountedRef.current) return;
        if (res.error) {
          setSubmitErr(res.error.message);
          return;
        }
        if (res.data?.id == null) {
          setSubmitErr(
            "The server did not confirm the new sequence identity. Creation may have completed; refresh the library before trying again.",
          );
          return;
        }
        discardCreateDraft();
        toast.success(`Sequence "${name}" created`);
        await onCreated(res.data);
      } catch (createError) {
        if (mountedRef.current) {
          setSubmitErr(
            lifecycleOperationError(
              createError,
              "The sequence create request did not complete.",
            ),
          );
        }
      } finally {
        if (mountedRef.current) setSubmitting(false);
      }
    });
    if (request) await request;
  };

  return {
    dialogProps: {
      aiDraft,
      aiGenerating,
      aiServerDraft,
      aiStepCount,
      aiTone,
      brief,
      canCreate,
      createMode,
      name: draft.name,
      open: createOpen,
      operationActive: operation.active,
      selectedTemplateKey,
      submitErr,
      submitting,
      unavailableReason: createUnavailableReason,
      onAiStepCountChange: (value: string): void => {
        if (!canCreateRef.current) return;
        setAiStepCount(value);
        setSubmitErr(null);
      },
      onAiToneChange: (value: string): void => {
        if (!canCreateRef.current) return;
        setAiTone(value);
        setSubmitErr(null);
      },
      onBriefChange: (value: string): void => {
        if (!canCreateRef.current) return;
        setBrief(value);
        setSubmitErr(null);
      },
      onClose: requestCreateClose,
      onGenerate: (): void => void generateWithAi(),
      onModeChange: (mode: CreateMode): void => {
        if (!canCreateRef.current) return;
        setCreateMode(mode);
        setSubmitErr(null);
        if (mode === "blank") pickTemplate(null);
      },
      onNameChange: (name: string): void => {
        if (!canCreateRef.current) return;
        setDraft((current) => ({ ...current, name }));
      },
      onPickTemplate: pickTemplate,
      onQuickMatch: generateFromBrief,
      onSubmit: (): void => void submitCreate(),
    },
    discardConfirmOpen,
    discardCreateDraft,
    closeDiscardConfirm: (): void => setDiscardConfirmOpen(false),
    openCreate,
  };
}

type SequenceCreateController = ReturnType<typeof useSequenceCreateController>;

function SequenceCreateModals({
  controller,
}: {
  controller: SequenceCreateController;
}): ReactElement {
  return (
    <>
      <SequenceCreateDialog {...controller.dialogProps} />
      <ConfirmModal
        open={controller.discardConfirmOpen}
        title="Discard this sequence draft?"
        description="The name, template choice, brief, and generated steps have not been created."
        confirmLabel="Discard sequence"
        danger
        onConfirm={controller.discardCreateDraft}
        onClose={controller.closeDiscardConfirm}
      />
    </>
  );
}

function SequenceDetailView({
  canMutate,
  sequence,
  onBack,
  onChange,
}: {
  canMutate: boolean;
  sequence: Sequence;
  onBack: () => void | Promise<void>;
  onChange: (sequence: Sequence) => void;
}): ReactElement {
  return (
    <>
      <div className="page-header">
        <div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void onBack()}
            style={{ marginBottom: 6 }}
          >
            ← All sequences
          </button>
          <h1 className="page-title">{sequence.name ?? "Untitled sequence"}</h1>
          <div className="page-subtitle">
            Build and review a draft journey. Live automation stays disabled.
          </div>
        </div>
      </div>
      {sequence.id != null ? (
        <StepCanvas
          key={String(sequence.id)}
          sequence={sequence}
          canMutate={canMutate}
          onSequenceChange={onChange}
        />
      ) : (
        <div className="notice">
          <span>Sequence has no id — can&apos;t open the canvas.</span>
        </div>
      )}
    </>
  );
}

function SequenceRow({
  sequence,
  onOpen,
}: {
  sequence: Sequence;
  onOpen: (sequence: Sequence) => void;
}): ReactElement {
  const rawSteps = sequence.steps as unknown;
  const stepCount =
    typeof rawSteps === "number"
      ? rawSteps
      : Array.isArray(rawSteps)
        ? rawSteps.length
        : null;
  return (
    <article className="seq-library-row list-row">
      <button
        type="button"
        className="seq-library-row-open"
        onClick={() => onOpen(sequence)}
        aria-label={`Open ${sequence.name ?? "untitled sequence"} in the draft builder`}
      >
        <span className="step-num" aria-hidden="true">
          {stepCount ?? "—"}
        </span>
        <span className="seq-library-row-copy">
          <span className="seq-library-row-title">
            {sequence.name ?? "Untitled sequence"}
            <span>{statusBadge(sequence.status)}</span>
          </span>
          <span className="seq-library-row-meta">
            {stepCount == null
              ? "Step count unavailable"
              : `${stepCount} draft step${stepCount === 1 ? "" : "s"}`}
            {" · Design and review only"}
          </span>
        </span>
        <span className="seq-library-row-arrow" aria-hidden="true">
          →
        </span>
      </button>
    </article>
  );
}

function SequenceListContent({
  canCreate,
  err,
  items,
  loading,
  onNew,
  onOpen,
  onRetry,
  refreshing,
}: {
  canCreate: boolean;
  err: string | null;
  items: Sequence[] | null;
  loading: boolean;
  onNew: () => void;
  onOpen: (sequence: Sequence) => void;
  onRetry: () => void;
  refreshing: boolean;
}): ReactElement {
  if (loading && !items) {
    return (
      <div className="step-list" data-tour="sequences-list">
        {[0, 1, 2].map((index) => (
          <div key={index} className="skel" style={{ height: 60 }} />
        ))}
      </div>
    );
  }
  if (err && !items) {
    return (
      <section className="seq-library-error" role="alert">
        <div className="seq-library-error-icon" aria-hidden="true">
          !
        </div>
        <div>
          <h2>Sequence library unavailable</h2>
          <p>
            Moosewave could not confirm whether this workspace has sequence
            drafts. No empty-state or deletion claim is being inferred.
          </p>
          <p className="muted">{err}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Retry library
        </button>
      </section>
    );
  }
  if (items?.length) {
    return (
      <div
        className="step-list seq-library-list"
        data-tour="sequences-list"
        aria-busy={refreshing || undefined}
      >
        {items.map((sequence) => (
          <SequenceRow
            key={String(sequence.id)}
            sequence={sequence}
            onOpen={onOpen}
          />
        ))}
      </div>
    );
  }
  return (
    <HeroEmptyState
      tone="blue"
      eyebrow="Draft workspace"
      title="Design the welcome, the win-back, and everything between."
      subtitle="Create and review multi-step journey drafts now. Live triggers, enrollment, and delivery remain disabled until the runtime is qualified."
      primaryCta={
        canCreate ? { label: "New draft", onClick: onNew } : undefined
      }
      imageSrc={HERO.sequences}
      imageAlt="Three envelopes connected in a sequence"
    />
  );
}

function SequencesIndexView({
  canCreate,
  createUnavailableReason,
  create,
  err,
  items,
  loading,
  onOpen,
  onRetry,
  refreshing,
  stale,
}: {
  canCreate: boolean;
  createUnavailableReason: string | null;
  create: SequenceCreateController;
  err: string | null;
  items: Sequence[] | null;
  loading: boolean;
  onOpen: (sequence: Sequence) => void;
  onRetry: () => void;
  refreshing: boolean;
  stale: boolean;
}): ReactElement {
  const createDescriptionId = useId();
  const refreshDescriptionId = useId();
  const refreshUnavailableReason = loading
    ? "Wait for the sequence library to finish loading."
    : refreshing
      ? "Wait for the current sequence library refresh to finish."
      : null;
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Sequences</h1>
          <div className="page-subtitle">
            Multi-step journey drafts · live runtime unavailable
          </div>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className={`btn${refreshUnavailableReason ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!refreshUnavailableReason) onRetry();
            }}
            aria-disabled={refreshUnavailableReason ? true : undefined}
            aria-describedby={refreshDescriptionId}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className={`btn btn-primary${createUnavailableReason ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!createUnavailableReason) create.openCreate();
            }}
            aria-disabled={createUnavailableReason ? true : undefined}
            aria-describedby={createDescriptionId}
          >
            New draft
          </button>
        </div>
        <span id={refreshDescriptionId} className="visually-hidden">
          {refreshUnavailableReason ??
            "Refresh the sequence library from the server."}
        </span>
        <span id={createDescriptionId} className="visually-hidden">
          {createUnavailableReason ??
            "Create a sequence from a template, an AI draft, or a blank canvas."}
        </span>
      </div>
      <section className="seq-library-boundary" role="status">
        <span className="badge warning">Runtime off</span>
        <span>{SEQUENCE_RUNTIME_UNAVAILABLE_REASON}</span>
      </section>
      {err && items ? (
        <div className="notice" role="alert">
          <span>
            Showing the last confirmed sequence library. Refresh failed: {err}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry refresh
          </button>
        </div>
      ) : null}
      {stale && !err ? (
        <div className="notice" role="status">
          <span>
            Showing a retained sequence snapshot until refresh succeeds.
          </span>
        </div>
      ) : null}
      <SequenceListContent
        canCreate={canCreate}
        err={err}
        items={items}
        loading={loading}
        onNew={create.openCreate}
        onOpen={onOpen}
        onRetry={onRetry}
        refreshing={refreshing}
      />
      <SequenceCreateModals controller={create} />
    </>
  );
}

export function Sequences(): ReactElement {
  const route = useDesktopRoute();
  const routeResourceId =
    route.section === "sequences" ? route.resourceId : undefined;
  const hasWriteRole = useCanWrite();
  const roleStatus = useRoleStatus();
  const createUnavailableReason =
    roleStatus === "loading"
      ? "Wait for Moosewave to confirm your workspace permissions."
      : roleStatus !== "resolved"
        ? "Reconnect and confirm your workspace permissions before creating a sequence draft."
        : !hasWriteRole
          ? "Ask a workspace editor or admin for permission to create sequence drafts."
          : null;
  const canCreate = createUnavailableReason === null;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const data = useSequencesData(mountedRef, routeResourceId);
  const create = useSequenceCreateController({
    canCreate,
    createUnavailableReason,
    mountedRef,
    onCreated: async (sequence) => {
      if (sequence?.id != null) data.openSelected(sequence);
      await data.load();
    },
  });
  if (data.selected) {
    return (
      <SequenceDetailView
        canMutate={canCreate}
        sequence={data.selected}
        onBack={async () => {
          const result = await requestDesktopRouteNavigation({
            section: "sequences",
          });
          if (result === "proceeded") await data.load();
        }}
        onChange={data.updateSelected}
      />
    );
  }
  return (
    <SequencesIndexView
      canCreate={canCreate}
      createUnavailableReason={createUnavailableReason}
      create={create}
      err={data.err}
      items={data.items}
      loading={data.loading}
      onOpen={data.openSelected}
      onRetry={() => void data.load()}
      refreshing={data.refreshing}
      stale={data.stale}
    />
  );
}
