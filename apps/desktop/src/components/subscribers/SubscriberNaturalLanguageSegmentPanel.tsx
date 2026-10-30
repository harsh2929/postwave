import {
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  compileSegmentFromText,
  getSegmentAIProcessingDisclosure,
  isSegmentAIProcessingDisclosure,
  previewCompiledSegment,
  type CompiledSegmentPreview,
  type SegmentAIProcessingDisclosure,
  type SegmentNode,
  type SegmentNutritionFacts,
} from "../../lib/api-client";
import { queueReceiptMessage } from "../../lib/api/result";
import type { ApiErr } from "../../lib/api/result";
import {
  composeNLCompiledAST,
  flattenNLChips,
  formatNLConditionLabel,
  NL_DIRECTORY_SEARCH_BLOCKED_MESSAGE,
  normalizeNLStatusCondition,
  pruneNLFacts,
  removeNLNodeAtPath,
  validateNLCompiledAST,
  type NLCompileContext,
} from "../../pages/subscribers-nl-segment";
import { segmentsClient } from "../segments/segmentsClient";
import { toast } from "../Toast";

interface SubscriberNaturalLanguageSegmentPanelProps {
  canMutate: boolean;
  status: string;
  query: string;
  onSaved: () => void | Promise<void>;
}

interface CompiledDraftSnapshot extends NLCompileContext {
  prompt: string;
  engine: "rules" | "ai";
  compiledAt: string;
  processing: SegmentAIProcessingDisclosure | null;
}

interface PreviewState {
  status: "idle" | "loading" | "ready" | "error";
  data: CompiledSegmentPreview | null;
}

interface AIProcessingPreflightState {
  status: "loading" | "ready" | "error";
  available: boolean;
  processing: SegmentAIProcessingDisclosure | null;
}

const INITIAL_PREVIEW: PreviewState = { status: "idle", data: null };

export function SubscriberNaturalLanguageSegmentPanel({
  canMutate,
  status,
  query,
  onSaved,
}: SubscriberNaturalLanguageSegmentPanelProps): ReactElement {
  const [prompt, setPrompt] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ast, setAST] = useState<SegmentNode | null>(null);
  const [snapshot, setSnapshot] = useState<CompiledDraftSnapshot | null>(null);
  const [facts, setFacts] = useState<SegmentNutritionFacts | null>(null);
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW);
  const [aiAcknowledged, setAIAcknowledged] = useState(false);
  const [aiPreflight, setAIPreflight] = useState<AIProcessingPreflightState>({
    status: "loading",
    available: false,
    processing: null,
  });
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const compileRequestSeq = useRef(0);
  const previewRequestSeq = useRef(0);
  const saveRequestSeq = useRef(0);
  const compileBusyRef = useRef(false);
  const saveBusyRef = useRef(false);
  const compileController = useRef<AbortController | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const logicRef = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(true);
  const panelId = useId();
  const headingId = `${panelId}-heading`;
  const compileDescriptionId = `${panelId}-compile-description`;
  const aiDisclosureId = `${panelId}-ai-disclosure`;
  const saveDescriptionId = `${panelId}-save-description`;
  const chips = useMemo(() => (ast ? flattenNLChips(ast) : []), [ast]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      compileRequestSeq.current += 1;
      previewRequestSeq.current += 1;
      saveRequestSeq.current += 1;
      compileController.current?.abort();
      previewController.current?.abort();
      compileBusyRef.current = false;
      saveBusyRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void getSegmentAIProcessingDisclosure({ signal: controller.signal })
      .then((result) => {
        if (!mounted.current || controller.signal.aborted) return;
        if (result.error || !result.data) {
          setAIPreflight({
            status: "error",
            available: false,
            processing: null,
          });
          setAIAcknowledged(false);
          return;
        }
        setAIPreflight({
          status: "ready",
          available: result.data.available,
          processing: result.data.ai_processing,
        });
        if (!result.data.available) setAIAcknowledged(false);
      })
      .catch(() => {
        if (!mounted.current || controller.signal.aborted) return;
        setAIPreflight({
          status: "error",
          available: false,
          processing: null,
        });
        setAIAcknowledged(false);
      });
    return () => controller.abort();
  }, []);

  const loadPreview = async (nextAST: SegmentNode): Promise<void> => {
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    const requestSeq = ++previewRequestSeq.current;
    setPreview({ status: "loading", data: null });
    try {
      const result = await previewCompiledSegment(nextAST, {
        signal: controller.signal,
      });
      if (
        !mounted.current ||
        controller.signal.aborted ||
        requestSeq !== previewRequestSeq.current
      ) {
        return;
      }
      setPreview(
        result.error || !result.data
          ? { status: "error", data: null }
          : { status: "ready", data: result.data },
      );
    } catch {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestSeq === previewRequestSeq.current
      ) {
        setPreview({ status: "error", data: null });
      }
    }
  };

  const compile = async (engine: "ai" | "rules" = "rules"): Promise<void> => {
    const description = prompt.trim();
    if (!description || compileBusyRef.current || saveBusyRef.current) return;
    if (query.trim()) {
      setError(NL_DIRECTORY_SEARCH_BLOCKED_MESSAGE);
      return;
    }
    if (engine === "ai" && !aiAcknowledged) {
      setError(
        "Review and acknowledge the external AI-processing disclosure before using Try AI.",
      );
      return;
    }
    if (
      engine === "ai" &&
      (aiPreflight.status !== "ready" || !aiPreflight.available)
    ) {
      setError(
        aiPreflight.status === "loading"
          ? "Wait for the external AI-processing preflight to finish before using Try AI."
          : "External AI processing is not currently available with a complete preflight disclosure.",
      );
      return;
    }

    compileController.current?.abort();
    previewController.current?.abort();
    const controller = new AbortController();
    compileController.current = controller;
    const requestSeq = ++compileRequestSeq.current;
    compileBusyRef.current = true;
    setCompiling(true);
    setError(null);
    setPreview(INITIAL_PREVIEW);
    try {
      const result = await compileSegmentFromText(description, {
        engine,
        aiProcessingAcknowledged: engine === "ai" ? true : undefined,
        signal: controller.signal,
      });
      if (
        !mounted.current ||
        controller.signal.aborted ||
        requestSeq !== compileRequestSeq.current
      ) {
        return;
      }
      if (result.error) {
        resetCompiledDraft();
        setError(segmentCompileErrorMessage(result.error, engine === "ai"));
        return;
      }
      const data = result.data;
      if (
        !data ||
        data.engine_used !== engine ||
        (engine === "ai" &&
          !isSegmentAIProcessingDisclosure(data.ai_processing))
      ) {
        resetCompiledDraft();
        setError(
          engine === "ai"
            ? "The AI compiler did not return a complete processing disclosure. No AI-generated draft was accepted."
            : "The compiler returned an unexpected processing engine. No draft was accepted.",
        );
        return;
      }
      const validation = validateNLCompiledAST(data.ast);
      if (!validation.ok) {
        resetCompiledDraft();
        setError(validation.error);
        return;
      }
      if (flattenNLChips(validation.ast).length === 0) {
        resetCompiledDraft();
        setError(
          "The compiler could not express this audience with an executable condition. No empty or match-all draft was accepted.",
        );
        return;
      }
      const context = { status, query };
      const reviewedAST = composeNLCompiledAST(validation.ast, context);
      setAST(reviewedAST);
      setSnapshot({
        ...context,
        prompt: description,
        engine: data.engine_used,
        compiledAt: new Date().toISOString(),
        processing: data.ai_processing ?? null,
      });
      setFacts(data.nutrition_facts ?? null);
      if (!saveName.trim() && (data.suggested_name ?? data.suggestedName)) {
        setSaveName(data.suggested_name ?? data.suggestedName ?? "");
      }
      void loadPreview(reviewedAST);
    } catch {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestSeq === compileRequestSeq.current
      ) {
        resetCompiledDraft();
        setError(
          "The segment compiler didn't complete. Check your connection and try again.",
        );
      }
    } finally {
      if (requestSeq === compileRequestSeq.current) {
        compileBusyRef.current = false;
        if (mounted.current) {
          setCompiling(false);
          if (engine === "ai") setAIAcknowledged(false);
        }
      }
    }
  };

  const resetCompiledDraft = (): void => {
    setAST(null);
    setSnapshot(null);
    setFacts(null);
    setPreview(INITIAL_PREVIEW);
  };

  const removeCondition = (path: number[]): void => {
    if (!ast || compiling || saving) return;
    const lockedPath = findLockedContextPath(ast, snapshot?.status ?? "all");
    if (lockedPath && pathsEqual(path, lockedPath)) return;
    const next = removeNLNodeAtPath(ast, path);
    setAST(next);
    setFacts((current) => pruneNLFacts(current, next));
    if (next) void loadPreview(next);
    else setPreview(INITIAL_PREVIEW);
    window.requestAnimationFrame(() => logicRef.current?.focus());
  };

  const clear = (): void => {
    compileRequestSeq.current += 1;
    previewRequestSeq.current += 1;
    compileController.current?.abort();
    previewController.current?.abort();
    compileBusyRef.current = false;
    setCompiling(false);
    resetCompiledDraft();
    setError(null);
    setSaveName("");
    setAIAcknowledged(false);
  };

  const save = async (): Promise<void> => {
    if (
      !ast ||
      !snapshot ||
      !canMutate ||
      chips.length === 0 ||
      compileBusyRef.current ||
      saveBusyRef.current ||
      preview.status !== "ready" ||
      !preview.data ||
      prompt.trim() !== snapshot.prompt
    ) {
      return;
    }
    const name = saveName.trim();
    if (!name) {
      setError("Give the segment a name before saving.");
      return;
    }
    const requestSeq = ++saveRequestSeq.current;
    saveBusyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await segmentsClient.create({
        name,
        description: snapshot.prompt,
        queryAst: ast,
      });
      if (!mounted.current || requestSeq !== saveRequestSeq.current) return;
      if (result.error) {
        toast.error(
          "Couldn't save the segment. Review the name and try again.",
        );
        return;
      }
      if (result.queued) {
        toast.info({
          message: queueReceiptMessage(result.receipt),
          detail: `“${name}” will appear in Segments after the server validates and confirms it.`,
        });
        setPrompt("");
        clear();
        return;
      }
      if (!result.data?.id) {
        toast.error(
          "The server did not confirm the created segment. Try again.",
        );
        return;
      }
      toast.success(`Saved exact audience "${name}" in Segments`);
      setPrompt("");
      clear();
      try {
        await onSaved();
      } catch {
        toast.error(
          "The segment was created, but the surrounding segment view couldn't refresh.",
        );
      }
    } catch {
      if (mounted.current && requestSeq === saveRequestSeq.current) {
        toast.error(
          "Couldn't save the segment. Check your connection and retry.",
        );
      }
    } finally {
      if (requestSeq === saveRequestSeq.current) {
        saveBusyRef.current = false;
        if (mounted.current) setSaving(false);
      }
    }
  };

  const contextChanged = Boolean(
    snapshot && (snapshot.status !== status || snapshot.query !== query),
  );
  const promptChanged = Boolean(snapshot && prompt.trim() !== snapshot.prompt);
  const descriptions = getSegmentActionDescriptions({
    canMutate,
    compiling,
    saving,
    prompt,
    saveName,
    conditionCount: chips.length,
    contextChanged,
    promptChanged,
    previewStatus: preview.status,
    searchActive: Boolean(query.trim()),
  });

  return (
    <section
      className="subscriber-nl-studio"
      data-tour="subscribers-nl-segment"
      aria-labelledby={headingId}
      aria-busy={compiling || saving || preview.status === "loading"}
    >
      <StudioHeader headingId={headingId} />
      <div className="subscriber-nl-compose">
        <label
          className="subscriber-nl-prompt-label"
          htmlFor={`${panelId}-prompt`}
        >
          <span>Describe who should be in this audience</span>
          <span>{prompt.length.toLocaleString()}/4,096</span>
        </label>
        <textarea
          id={`${panelId}-prompt`}
          className="input subscriber-nl-prompt"
          placeholder="For example: subscribed readers who opened in the last 7 days, but have never clicked"
          value={prompt}
          maxLength={4096}
          rows={3}
          onChange={(event) => {
            setPrompt(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void compile();
            }
          }}
          autoComplete="off"
          spellCheck
          disabled={compiling || saving}
          aria-label="Natural language segment description"
          aria-describedby={`${compileDescriptionId} ${aiDisclosureId}`}
        />
        <div className="subscriber-nl-actions">
          <button
            type="button"
            className={`btn btn-sm${!prompt.trim() ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => void compile()}
            disabled={compiling || saving}
            aria-disabled={
              compiling ||
              saving ||
              !prompt.trim() ||
              Boolean(query.trim()) ||
              undefined
            }
            aria-describedby={compileDescriptionId}
          >
            <span aria-hidden="true" className="subscriber-nl-action-mark">
              ↳
            </span>
            {compiling ? "Building rules…" : "Build with rules"}
          </button>
          <button
            type="button"
            className={`btn btn-sm btn-ghost${!prompt.trim() || !aiAcknowledged || aiPreflight.status !== "ready" || !aiPreflight.available ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => void compile("ai")}
            disabled={compiling || saving}
            aria-disabled={
              compiling ||
              saving ||
              !prompt.trim() ||
              !aiAcknowledged ||
              aiPreflight.status !== "ready" ||
              !aiPreflight.available ||
              Boolean(query.trim()) ||
              undefined
            }
            aria-describedby={`${compileDescriptionId} ${aiDisclosureId}`}
          >
            Try AI
          </button>
          {ast ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={clear}
              disabled={saving}
            >
              Discard draft
            </button>
          ) : null}
          <span className="subscriber-nl-shortcut" aria-hidden="true">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} + Enter
          </span>
        </div>
        <p
          id={compileDescriptionId}
          className="subscriber-nl-action-status"
          role="status"
        >
          {descriptions.compileDescription}
        </p>
      </div>

      <AIDisclosure
        id={aiDisclosureId}
        acknowledged={aiAcknowledged}
        disabled={
          compiling ||
          saving ||
          aiPreflight.status !== "ready" ||
          !aiPreflight.available
        }
        processing={
          snapshot?.engine === "ai"
            ? snapshot.processing
            : aiPreflight.processing
        }
        preflightStatus={aiPreflight.status}
        available={aiPreflight.available}
        onChange={setAIAcknowledged}
      />

      {error ? (
        <div className="notice subscriber-nl-error" role="alert">
          <strong>Draft not updated.</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {ast && snapshot ? (
        <CompiledSegmentDraft
          ast={ast}
          canMutate={canMutate}
          compiling={compiling}
          contextChanged={contextChanged}
          logicRef={logicRef}
          facts={facts}
          promptChanged={promptChanged}
          preview={preview}
          saveDescription={descriptions.saveDescription}
          saveDescriptionId={saveDescriptionId}
          saveName={saveName}
          saving={saving}
          snapshot={snapshot}
          onRemoveCondition={removeCondition}
          onRetryPreview={() => void loadPreview(ast)}
          onSave={() => void save()}
          onSaveNameChange={setSaveName}
        />
      ) : (
        <StudioEmptyState />
      )}
    </section>
  );
}

function StudioHeader({ headingId }: { headingId: string }): ReactElement {
  return (
    <header className="subscriber-nl-header">
      <div className="subscriber-nl-orbit" aria-hidden="true">
        <span />
        <span />
      </div>
      <div>
        <div className="subscriber-nl-eyebrow">
          Audience copilot <span>Review before save</span>
        </div>
        <h3 id={headingId}>Turn an idea into exact, inspectable rules</h3>
        <p>
          Moosewave starts with a deterministic compiler, preserves boolean
          grouping, freezes a compatible status filter, and previews only
          aggregate membership—never subscriber identities. Clear directory
          search first so broad search semantics cannot be narrowed silently.
        </p>
      </div>
    </header>
  );
}

function StudioEmptyState(): ReactElement {
  return (
    <div className="subscriber-nl-empty" aria-hidden="true">
      <div>
        <span>01</span>
        <strong>Describe</strong>
        <small>Use plain language</small>
      </div>
      <i />
      <div>
        <span>02</span>
        <strong>Inspect</strong>
        <small>Review every branch</small>
      </div>
      <i />
      <div>
        <span>03</span>
        <strong>Preview</strong>
        <small>Confirm aggregate reach</small>
      </div>
      <i />
      <div>
        <span>04</span>
        <strong>Save</strong>
        <small>Reuse the exact AST</small>
      </div>
    </div>
  );
}

function AIDisclosure({
  id,
  acknowledged,
  disabled,
  processing,
  preflightStatus,
  available,
  onChange,
}: {
  id: string;
  acknowledged: boolean;
  disabled: boolean;
  processing: SegmentAIProcessingDisclosure | null;
  preflightStatus: AIProcessingPreflightState["status"];
  available: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <details className="subscriber-nl-ai-disclosure" id={id}>
      <summary>
        <span>Optional external AI processing</span>
        <small>
          {preflightStatus === "loading"
            ? "Checking provider…"
            : preflightStatus === "error"
              ? "Preflight unavailable"
              : available
                ? "Available · Never selected automatically"
                : "Not configured"}
        </small>
      </summary>
      <div className="subscriber-nl-ai-body">
        <p>
          Try AI sends the audience description and this workspace&apos;s
          predicate catalog to the configured external provider. Moosewave does
          not attach subscriber records or preview members automatically, but
          everything you type—including email addresses or other personal
          data—is transmitted, along with workspace field and event names.
        </p>
        <dl>
          <div>
            <dt>Provider</dt>
            <dd>
              {processing?.provider ||
                (preflightStatus === "loading" ? "Checking…" : "Not disclosed")}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {processing?.model ||
                (preflightStatus === "loading" ? "Checking…" : "Not disclosed")}
            </dd>
          </div>
          <div>
            <dt>Retention</dt>
            <dd>
              {processing?.retention === "not_declared"
                ? "Not declared"
                : processing?.retention || "Not declared"}
            </dd>
          </div>
          <div>
            <dt>Residency</dt>
            <dd>
              {processing?.residency === "not_declared"
                ? "Not declared"
                : processing?.residency || "Not declared"}
            </dd>
          </div>
        </dl>
        <p className="subscriber-nl-ai-categories">
          <strong>Data sent</strong>
          {(
            processing?.data_categories ?? [
              "operator_supplied_segment_description",
              "segment_predicate_catalog",
            ]
          )
            .map(humanizeExclusion)
            .join(" · ")}
        </p>
        <label className="subscriber-nl-ai-consent">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>
            I understand exactly what is transmitted, that provider identity or
            policy may be undisclosed, and choose external processing for this
            draft. This choice is not remembered and is enforced for this
            request only.
          </span>
        </label>
        {preflightStatus === "error" ? (
          <p className="subscriber-nl-ai-preflight-status" role="status">
            Provider availability could not be verified. Try AI stays disabled;
            deterministic rules and the visual builder remain local options.
          </p>
        ) : preflightStatus === "ready" && !available ? (
          <p className="subscriber-nl-ai-preflight-status" role="status">
            No external compiler is configured for this workspace. Nothing has
            been transmitted.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function getSegmentActionDescriptions({
  canMutate,
  compiling,
  saving,
  prompt,
  saveName,
  conditionCount,
  contextChanged,
  promptChanged,
  previewStatus,
  searchActive,
}: {
  canMutate: boolean;
  compiling: boolean;
  saving: boolean;
  prompt: string;
  saveName: string;
  conditionCount: number;
  contextChanged: boolean;
  promptChanged: boolean;
  previewStatus: PreviewState["status"];
  searchActive: boolean;
}): { compileDescription: string; saveDescription: string } {
  const compileDescription = compiling
    ? "Building a reviewable rule tree. A new request or discard cancels this result."
    : saving
      ? "Wait for the segment save to finish before building another draft."
      : !prompt.trim()
        ? "Describe an audience to begin. Rules mode never sends text to an AI provider."
        : searchActive
          ? "Clear directory search first. Its broad matching across names, email, tags, groups, and profile fields cannot be preserved as one exact rule."
          : "Rules mode is deterministic. Use Command or Control + Enter to build the draft.";
  const saveDescription = !canMutate
    ? "Read-only access: subscriber write permission is required to save segments."
    : saving
      ? "Saving the exact rule tree shown above."
      : promptChanged
        ? "The description changed after compilation. Rebuild the rules before saving so the visible source and reviewed tree agree."
        : contextChanged
          ? "The directory filters changed after compilation; this save keeps the frozen filters shown above."
          : previewStatus !== "ready"
            ? previewStatus === "error"
              ? "A fresh aggregate preview is required before this exact audience can be saved. Retry the preview."
              : "Wait for the aggregate reach estimate before saving this definition."
            : !saveName.trim()
              ? "Name the reviewed audience before saving."
              : conditionCount === 0
                ? "Keep at least one condition before saving."
                : "Creates the validated, audited audience in Segments from exactly this reviewed tree.";
  return { compileDescription, saveDescription };
}

function CompiledSegmentDraft({
  ast,
  canMutate,
  compiling,
  contextChanged,
  logicRef,
  facts,
  promptChanged,
  preview,
  saveDescription,
  saveDescriptionId,
  saveName,
  saving,
  snapshot,
  onRemoveCondition,
  onRetryPreview,
  onSave,
  onSaveNameChange,
}: {
  ast: SegmentNode;
  canMutate: boolean;
  compiling: boolean;
  contextChanged: boolean;
  logicRef: RefObject<HTMLDivElement | null>;
  facts: SegmentNutritionFacts | null;
  promptChanged: boolean;
  preview: PreviewState;
  saveDescription: string;
  saveDescriptionId: string;
  saveName: string;
  saving: boolean;
  snapshot: CompiledDraftSnapshot;
  onRemoveCondition: (path: number[]) => void;
  onRetryPreview: () => void;
  onSave: () => void;
  onSaveNameChange: (value: string) => void;
}): ReactElement {
  const conditionCount = flattenNLChips(ast).length;
  const lockedPath = findLockedContextPath(ast, snapshot.status);
  const saveUnavailable =
    !canMutate ||
    !saveName.trim() ||
    conditionCount === 0 ||
    preview.status !== "ready" ||
    promptChanged;
  return (
    <div className="subscriber-nl-review">
      <div className="subscriber-nl-review-heading">
        <div>
          <span className="subscriber-nl-step">Review 01</span>
          <h4>Exact audience logic</h4>
          <p>
            Groups preserve ALL, ANY, and NOT semantics. Remove a leaf to
            recalculate reach.
          </p>
        </div>
        <span className={`subscriber-nl-engine is-${snapshot.engine}`}>
          <i aria-hidden="true" />
          {snapshot.engine === "ai" ? "AI-assisted" : "Rules engine"}
        </span>
      </div>

      <CompileContext
        snapshot={snapshot}
        directoryChanged={contextChanged}
        promptChanged={promptChanged}
      />
      <div
        ref={logicRef}
        className="subscriber-nl-logic"
        role="group"
        tabIndex={-1}
        aria-label="Compiled audience logic"
      >
        {conditionCount > 0 ? (
          <RuleTreeNode
            node={ast}
            path={[]}
            lockedPath={lockedPath}
            disabled={compiling || saving}
            onRemove={onRemoveCondition}
          />
        ) : (
          <div className="subscriber-nl-logic-empty" role="status">
            No conditions remain. Build the draft again to continue.
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {conditionCount.toLocaleString()} audience condition
        {conditionCount === 1 ? "" : "s"} in the reviewed tree.
      </p>

      <SegmentNutritionFacts facts={facts} snapshot={snapshot} ast={ast} />
      <AudiencePreviewCard preview={preview} onRetry={onRetryPreview} />

      <div className="subscriber-nl-save">
        <div className="subscriber-nl-save-copy">
          <span className="subscriber-nl-step">Commit 03</span>
          <h4>Create a canonical segment</h4>
          <p id={saveDescriptionId} role="status">
            {saveDescription}
          </p>
        </div>
        <div className="subscriber-nl-save-actions">
          <label>
            <span>Segment name</span>
            <input
              type="text"
              className="input"
              placeholder="e.g. Engaged readers · 7 days"
              value={saveName}
              maxLength={120}
              onChange={(event) => onSaveNameChange(event.target.value)}
              disabled={saving || !canMutate}
              aria-label="Saved segment name"
              aria-describedby={saveDescriptionId}
            />
          </label>
          <button
            type="button"
            className={`btn btn-sm${saveUnavailable ? " pw-discoverable-unavailable" : ""}`}
            onClick={onSave}
            disabled={compiling || saving}
            aria-disabled={compiling || saving || saveUnavailable || undefined}
            aria-describedby={saveDescriptionId}
          >
            {saving ? "Creating in Segments…" : "Save exact segment"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CompileContext({
  snapshot,
  directoryChanged,
  promptChanged,
}: {
  snapshot: CompiledDraftSnapshot;
  directoryChanged: boolean;
  promptChanged: boolean;
}): ReactElement {
  const filters = [
    snapshot.status && snapshot.status !== "all"
      ? `Status · ${snapshot.status}`
      : null,
  ].filter(Boolean);
  return (
    <div
      className={`subscriber-nl-context${directoryChanged || promptChanged ? " is-stale" : ""}`}
    >
      <div>
        <strong>
          {promptChanged
            ? "Description changed; rebuild before save"
            : directoryChanged
              ? "Directory changed; draft stayed frozen"
              : "Compile context is frozen"}
        </strong>
        <span>
          Built {formatRelativeTimestamp(snapshot.compiledAt)} from the source
          description and locked filters below. Later edits cannot silently
          alter this reviewed tree.
        </span>
      </div>
      <div className="subscriber-nl-context-filters">
        {filters.length > 0 ? (
          filters.map((filter) => <span key={filter}>{filter}</span>)
        ) : (
          <span>No compatible directory filters</span>
        )}
      </div>
    </div>
  );
}

function RuleTreeNode({
  node,
  path,
  lockedPath,
  disabled,
  onRemove,
}: {
  node: SegmentNode;
  path: number[];
  lockedPath: number[] | null;
  disabled: boolean;
  onRemove: (path: number[]) => void;
}): ReactElement {
  if (node.op === "condition") {
    const label = formatNLConditionLabel(node);
    const locked = lockedPath ? pathsEqual(path, lockedPath) : false;
    const presentation = conditionPresentation(node.comparator, node.value);
    return (
      <div className="subscriber-nl-condition">
        <span className="subscriber-nl-condition-field">
          {humanizeField(node.field)}
        </span>{" "}
        <span className="subscriber-nl-condition-operator">
          {presentation.operator}
        </span>
        {presentation.value ? (
          <>
            {" "}
            <strong>{presentation.value}</strong>
          </>
        ) : null}
        {locked ? (
          <span
            className="subscriber-nl-condition-lock"
            title="Inherited from the frozen Directory status filter"
          >
            <span aria-hidden="true">◆</span> Locked context
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onRemove(path)}
            disabled={disabled}
            aria-label={`Remove condition: ${label}`}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
    );
  }
  if (node.op === "not") {
    const child = node.child ?? node.children?.[0];
    return (
      <div
        className="subscriber-nl-group is-not"
        role="group"
        aria-label="NOT group: exclude matches"
      >
        <div className="subscriber-nl-group-label">
          <strong>NOT</strong>
          <span>Exclude matches</span>
        </div>
        {child ? (
          <RuleTreeNode
            node={child}
            path={[...path, -1]}
            lockedPath={lockedPath}
            disabled={disabled}
            onRemove={onRemove}
          />
        ) : null}
      </div>
    );
  }
  const isAll = node.op === "and";
  return (
    <div
      className={`subscriber-nl-group is-${node.op}`}
      role="group"
      aria-label={
        isAll
          ? "ALL group: every branch must match"
          : "ANY group: at least one branch must match"
      }
    >
      <div className="subscriber-nl-group-label">
        <strong>{isAll ? "ALL" : "ANY"}</strong>
        <span>
          {isAll ? "Every branch must match" : "At least one branch must match"}
        </span>
      </div>
      <div className="subscriber-nl-group-children">
        {node.children.map((child, index) => (
          <RuleTreeNode
            key={`${path.join(".") || "root"}.${index}`}
            node={child}
            path={[...path, index]}
            lockedPath={lockedPath}
            disabled={disabled}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  );
}

function findLockedContextPath(
  ast: SegmentNode,
  status: string,
): number[] | null {
  const context = normalizeNLStatusCondition(status);
  if (!context) return null;
  const matches = (node: SegmentNode): boolean =>
    node.op === "condition" &&
    node.field === context.field &&
    node.comparator === "equals" &&
    node.value === context.value;
  if (matches(ast)) return [];
  if (ast.op !== "and") return null;
  for (let index = ast.children.length - 1; index >= 0; index -= 1) {
    const child = ast.children[index];
    if (child && matches(child)) return [index];
  }
  return null;
}

function pathsEqual(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function AudiencePreviewCard({
  preview,
  onRetry,
}: {
  preview: PreviewState;
  onRetry: () => void;
}): ReactElement {
  return (
    <section
      className="subscriber-nl-preview"
      aria-busy={preview.status === "loading"}
    >
      <div className="subscriber-nl-preview-heading">
        <div>
          <span className="subscriber-nl-step">Validate 02</span>
          <h4>Live aggregate preview</h4>
        </div>
        <span className="subscriber-nl-private">
          <i aria-hidden="true" /> Identity-safe
        </span>
      </div>
      {preview.status === "loading" ? (
        <div className="subscriber-nl-preview-loading" role="status">
          <span />{" "}
          <div>
            <strong>Calculating current reach…</strong>
            <small>No member records are returned.</small>
          </div>
        </div>
      ) : preview.status === "ready" && preview.data ? (
        <div className="subscriber-nl-preview-result" role="status">
          <div className="subscriber-nl-preview-number">
            <strong>{preview.data.count.toLocaleString()}</strong>{" "}
            <span>matching active profiles</span>
          </div>
          <div>
            <strong>
              {preview.data.workspace_percentage.toLocaleString(undefined, {
                maximumFractionDigits: 1,
              })}
              %
            </strong>
            <span>
              of {preview.data.workspace_total.toLocaleString()} in scope
            </span>
          </div>
          <div>
            <strong>{formatClockTime(preview.data.generated_at)}</strong>
            <span>aggregate generated</span>
          </div>
          <p>
            Excludes{" "}
            {preview.data.applied_exclusions
              .map(humanizeExclusion)
              .join(", ") || "nothing additional"}
            . Delivery-time consent, suppression, and channel eligibility still
            apply.
          </p>
        </div>
      ) : preview.status === "error" ? (
        <div className="subscriber-nl-preview-error" role="status">
          <div>
            <strong>Reach is temporarily unavailable</strong>
            <span>
              The rule tree remains reviewable, but an exact audience cannot be
              saved until a fresh aggregate preview succeeds.
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onRetry}
          >
            Retry preview
          </button>
        </div>
      ) : (
        <p className="subscriber-nl-preview-idle">
          A valid rule tree is required before reach can be calculated.
        </p>
      )}
    </section>
  );
}

function SegmentNutritionFacts({
  facts,
  snapshot,
  ast,
}: {
  facts: SegmentNutritionFacts | null;
  snapshot: CompiledDraftSnapshot;
  ast: SegmentNode;
}): ReactElement {
  const fallbackPredicates = Array.from(
    new Set(flattenNLChips(ast).map((chip) => chip.label.split(" ")[0] ?? "")),
  ).filter(Boolean);
  const predicates = facts?.predicates.length
    ? facts.predicates
    : fallbackPredicates;
  return (
    <div className="subscriber-nl-facts">
      <span>
        <strong>{flattenNLChips(ast).length}</strong> conditions
      </span>
      <span>
        <strong>{predicates.length}</strong> fields
      </span>
      {facts?.time_windows.length ? (
        <span>
          <strong>{facts.time_windows.length}</strong> time windows
        </span>
      ) : null}
      <span>
        Source ·{" "}
        {snapshot.engine === "ai"
          ? "AI-assisted, operator-reviewed"
          : "deterministic rules"}
      </span>
    </div>
  );
}

function humanizeField(field: string): string {
  return field
    .replace(/^custom\./, "Custom · ")
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanizeComparator(comparator: string): string {
  const labels: Record<string, string> = {
    equals: "is",
    not_equals: "is not",
    contains: "contains",
    not_contains: "does not contain",
    starts_with: "starts with",
    ends_with: "ends with",
    gt: "is greater than",
    gte: "is at least",
    lt: "is less than",
    lte: "is at most",
    in: "is one of",
    not_in: "is not one of",
    is_null: "has no value",
    is_not_null: "has a value",
    after: "is after",
    before: "is before",
    in_last_days: "occurred in the last",
    more_than_days_ago: "did not occur in the last",
    ever: "has occurred",
    never: "has never occurred",
  };
  return labels[comparator] ?? comparator.replace(/_/g, " ");
}

function conditionPresentation(
  comparator: string,
  value: unknown,
): { operator: string; value: string | null } {
  const normalized = comparator.toLowerCase();
  if (
    normalized === "is_null" ||
    normalized === "is_not_null" ||
    normalized === "exists" ||
    normalized === "not_exists" ||
    normalized === "ever" ||
    normalized === "never"
  ) {
    return { operator: humanizeComparator(normalized), value: null };
  }
  const formatted = formatRuleValue(value);
  if (
    (normalized === "in_last_days" || normalized === "more_than_days_ago") &&
    /^\d+(?:\.\d+)?$/.test(formatted)
  ) {
    return {
      operator: humanizeComparator(normalized),
      value: `${formatted} ${formatted === "1" ? "day" : "days"}`,
    };
  }
  return { operator: humanizeComparator(normalized), value: formatted };
}

function formatRuleValue(value: unknown): string {
  if (value == null || value === "") return "—";
  const formatted = Array.isArray(value)
    ? value.map(String).join(" · ")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return formatted.length > 180 ? `${formatted.slice(0, 177)}…` : formatted;
}

function humanizeExclusion(value: string): string {
  return value.replace(/_/g, " ");
}

function formatClockTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Just now"
    : new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}

function formatRelativeTimestamp(value: string): string {
  const elapsed = Date.now() - new Date(value).valueOf();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  return `${minutes.toLocaleString()} ${minutes === 1 ? "minute" : "minutes"} ago`;
}

function segmentCompileErrorMessage(
  error: ApiErr["error"],
  attemptedAI: boolean,
): string {
  const status = error.kind === "http" ? error.status : null;
  if (attemptedAI && status === 503) {
    return "AI compilation isn't available in this workspace. Reword the description or use deterministic rules.";
  }
  if (status === 422) {
    return attemptedAI
      ? "AI couldn't derive a safe rule tree. Reword the description or use the visual builder."
      : "Rules couldn't express that description safely. Reword it, use the visual builder, or review the disclosure and explicitly choose Try AI.";
  }
  return "The segment compiler couldn't complete this draft. Check your connection and retry.";
}
