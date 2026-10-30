/**
 * NaturalLanguageBuilder — the "New segment" modal, with two modes that
 * both converge on a query AST → name → save (segmentsClient.create):
 *
 *   • "Describe" — text → compiled AST. Wraps the backend's deterministic
 *     /segments/compile-from-text route (apps/api/internal/segments/
 *     text_compiler.go). Two-step: describe in prose, Compile, inspect the
 *     AST + live count, name it, save. Backend returns 422 for ambiguous
 *     prompts — we surface the rationale rather than silently failing.
 *
 *   • "Build" — a structured rule-row editor (VisualSegmentBuilder) that
 *     assembles the AST directly from the predicate registry. The builder
 *     lifts its current AST here via onAstChange; Save uses that AST
 *     instead of the NL-compiled one.
 *
 * The "Save" CTA is disabled until the active mode has produced a valid AST.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { FormField } from "../FormField";
import { ChoiceGroup } from "../ChoiceGroup";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { PredicateRegistryCatalog } from "./PredicateRegistryCatalog";
import { toast } from "../Toast";
import { SegmentPreviewCount } from "./SegmentPreviewCount";
import { VisualSegmentBuilder } from "./VisualSegmentBuilder";
import { queueReceiptMessage } from "../../lib/api/result";
import { type Segment, segmentsClient } from "./segmentsClient";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";

type Mode = "describe" | "build";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called once the new segment is persisted. */
  onCreated: (segment: Segment) => void;
  /**
   * Optional seed for the description textarea, applied each time the
   * modal opens (full-surface wiring #25: "Recreate as segment" hands
   * the preset-recipe definition here). The user still compiles and
   * reviews before anything is saved.
   */
  initialText?: string;
  /**
   * Optional pre-compiled AST seed (SUB-065 cohort discovery: an
   * AI-suggested segment's "Use as segment" hands its predicate_json
   * here so the operator lands on a ready-to-review AST without a
   * recompile). When set the modal opens in Describe mode showing the
   * compiled predicate; the operator names it and saves.
   */
  initialAst?: unknown;
  /** Optional pre-filled name to accompany `initialAst`. */
  initialName?: string;
}

const PLACEHOLDER =
  "Customers who opened any email in the last 14 days but haven't purchased in 60";

export function NaturalLanguageBuilder({
  open,
  onClose,
  onCreated,
  initialText,
  initialAst,
  initialName,
}: Props): ReactElement {
  const mountedRef = useRef(true);
  const [mode, setMode] = useState<Mode>("describe");
  const [text, setText] = useState("");
  const [ast, setAst] = useState<unknown>(null);
  // AST assembled by the visual builder (Build mode). Kept separate from
  // the NL-compiled `ast` so switching tabs doesn't clobber either.
  const [visualAst, setVisualAst] = useState<unknown>(null);
  const [visualDirty, setVisualDirty] = useState(false);
  const [rationale, setRationale] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: "segment-builder",
    label: "Segment builder operation",
  });

  // The AST that Save will persist, per the active mode.
  const activeAst = mode === "build" ? visualAst : ast;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Seed on open (not on every render) so a preset-recipe / AI-suggestion
  // handoff pre-fills without clobbering in-flight edits. Two seed paths:
  //   • initialAst (SUB-065 "Use as segment") — a ready compiled AST that
  //     skips the recompile step; we land the operator on the predicate
  //     review + name input directly.
  //   • initialText (preset "Recreate as segment") — prose the operator
  //     compiles before saving.
  useEffect(() => {
    if (!open) return;
    if (initialAst) {
      setMode("describe");
      setAst(initialAst);
      setText(initialText ?? "");
      setVisualAst(null);
      setVisualDirty(false);
      setRationale("");
      if (initialName) setName(initialName);
      setErr(null);
      return;
    }
    if (initialText) {
      setText(initialText);
      setAst(null);
      // A re-seed while the modal is already open (e.g. a second "Recreate
      // as segment" click) must land the operator on the seeded prose, not
      // a stale Build-mode AST from a different audience. Reset both.
      setMode("describe");
      setVisualAst(null);
      setVisualDirty(false);
      setRationale("");
      setErr(null);
    }
  }, [open, initialText, initialAst, initialName]);

  const reset = useCallback((): void => {
    setMode("describe");
    setText("");
    setAst(null);
    setVisualAst(null);
    setVisualDirty(false);
    setRationale("");
    setName("");
    setErr(null);
    setCompiling(false);
    setSaving(false);
    setDiscardConfirmOpen(false);
  }, []);

  const draftDirty =
    text !== "" ||
    ast !== null ||
    visualAst !== null ||
    visualDirty ||
    rationale !== "" ||
    name !== "" ||
    mode !== "describe";

  useDiscardOnlyDraftLifecycle({
    ownerId: "segment-builder",
    label: "New segment draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: reset,
    detail:
      "This segment description, rule tree, or name has not been saved. Return to it or explicitly discard it.",
  });

  const close = (): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  };

  const discardAndClose = (): void => {
    if (operation.promiseRef.current) return;
    reset();
    onClose();
  };

  const compile = async (): Promise<void> => {
    const t = text.trim();
    if (!t) {
      setErr("Describe the segment in plain language first.");
      return;
    }
    setErr(null);
    setCompiling(true);
    const pending = operation.run(() => segmentsClient.compileFromText(t));
    if (!pending) {
      setCompiling(false);
      return;
    }
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        setAst(null);
        setErr(res.error.message);
        return;
      }
      const d = res.data;
      const compiled = d.queryAst ?? d.query_ast ?? null;
      setAst(compiled);
      setRationale(d.rationale ?? "");
      const suggested = d.suggestedName ?? d.suggested_name ?? "";
      if (!name && suggested) setName(suggested);
    } catch (error) {
      if (mountedRef.current) {
        setAst(null);
        setErr(
          lifecycleOperationError(error, "The segment couldn't be compiled."),
        );
      }
    } finally {
      if (mountedRef.current) setCompiling(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!activeAst) {
      setErr(
        mode === "build"
          ? "Add at least one complete condition before saving."
          : "Compile a description before saving.",
      );
      return;
    }
    const n = name.trim();
    if (!n) {
      setErr("Give the segment a name.");
      return;
    }
    setErr(null);
    setSaving(true);
    const pending = operation.run(() =>
      segmentsClient.create({
        name: n,
        // In Describe mode the prose is a meaningful description; in Build
        // mode there is no prose, so we leave it empty.
        description: mode === "describe" ? text.trim() : undefined,
        queryAst: activeAst,
      }),
    );
    if (!pending) {
      setSaving(false);
      return;
    }
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        setErr(res.error.message);
        return;
      }
      if (res.queued) {
        toast.info({
          message: queueReceiptMessage(res.receipt),
          detail: `“${n}” will appear after the server confirms the create.`,
        });
        reset();
        onClose();
        return;
      }
      toast.success(`Segment "${n}" created`);
      const created = res.data;
      reset();
      try {
        onCreated(created);
      } catch (refreshError) {
        toast.error({
          message: "Segment created, but the list couldn't refresh",
          detail: lifecycleOperationError(
            refreshError,
            "Refresh the segment list to see the new segment.",
          ),
        });
      }
    } catch (error) {
      if (mountedRef.current) {
        setErr(
          lifecycleOperationError(error, "The segment couldn't be saved."),
        );
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        closeOnBackdrop={!operation.active}
        closeOnEscape={!operation.active}
        closeDisabled={operation.active}
        title="New segment"
        description="Describe the audience in plain language, or build the rules visually. Either way we save a segment you can target from campaigns and flows."
      >
        <ModeTabs
          mode={mode}
          onChange={(next) => {
            setMode(next);
            setErr(null);
          }}
        />

        {mode === "build" ? (
          <>
            <VisualSegmentBuilder
              onAstChange={setVisualAst}
              onDirtyChange={setVisualDirty}
            />
            <FormField label="Name" htmlFor="seg-visual-name" required>
              <input
                id="seg-visual-name"
                className="input"
                placeholder="High-value engaged buyers"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>
          </>
        ) : (
          <DescribeBody
            text={text}
            setText={setText}
            ast={ast}
            setAst={setAst}
            rationale={rationale}
            name={name}
            setName={setName}
            compiling={compiling}
            saving={saving}
            onCompile={() => void compile()}
          />
        )}

        {err ? (
          <div className="field-error" style={{ marginTop: 8 }}>
            {err}
          </div>
        ) : null}

        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={close}
            disabled={operation.active}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={!activeAst || operation.active || !name.trim()}
          >
            {saving ? "Saving…" : "Save segment"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard segment draft?"
        description="The description, compiled predicate, visual rules, rationale, and name in this draft will be lost."
        confirmLabel="Discard draft"
        danger
        busy={operation.active}
        onConfirm={discardAndClose}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}

function ModeTabs({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
}): ReactElement {
  return (
    <ChoiceGroup
      legend="Segment authoring mode"
      value={mode}
      onChange={onChange}
      className="tabs"
      optionClassName="tab"
      style={{ marginBottom: 12, width: "auto" }}
      options={(["describe", "build"] as const).map((candidate) => ({
        value: candidate,
        label: candidate === "describe" ? "Describe" : "Build",
        className: mode === candidate ? "is-active" : undefined,
      }))}
    />
  );
}

/* ─── Describe (natural-language) body ─────────────────────────────── */

interface DescribeBodyProps {
  text: string;
  setText: (v: string) => void;
  ast: unknown;
  setAst: (v: unknown) => void;
  rationale: string;
  name: string;
  setName: (v: string) => void;
  compiling: boolean;
  saving: boolean;
  onCompile: () => void;
}

function DescribeBody({
  text,
  setText,
  ast,
  setAst,
  rationale,
  name,
  setName,
  compiling,
  saving,
  onCompile,
}: DescribeBodyProps): ReactElement {
  return (
    <>
      <FormField label="Describe the segment" htmlFor="seg-nl-text">
        <textarea
          id="seg-nl-text"
          className="input"
          style={{ minHeight: 96, fontFamily: "inherit", lineHeight: 1.5 }}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Stale AST — force a recompile before save.
            if (ast) setAst(null);
          }}
          aria-describedby="seg-nl-help"
        />
      </FormField>
      <div
        id="seg-nl-help"
        className="muted"
        style={{ fontSize: 11, marginTop: -6, marginBottom: 8 }}
      >
        Example: &ldquo;{PLACEHOLDER}&rdquo;
      </div>

      {/* Discoverability: browse the tenant's available fields / metrics /
          custom objects so the prose isn't a guess. */}
      <PredicateRegistryCatalog />

      <div
        style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}
      >
        <button
          type="button"
          className="btn"
          onClick={onCompile}
          disabled={compiling || saving || !text.trim()}
        >
          {compiling ? "Compiling…" : ast ? "Recompile" : "Compile"}
        </button>
        <SegmentPreviewCount
          queryAst={ast ?? undefined}
          text={ast ? undefined : text}
        />
      </div>

      {ast ? (
        <>
          <div
            className="section-title"
            style={{ marginTop: 14, marginBottom: 6 }}
          >
            Compiled predicate
          </div>
          {rationale ? (
            <div
              className="muted"
              style={{ fontSize: 11, marginBottom: 6, lineHeight: 1.5 }}
            >
              {rationale}
            </div>
          ) : null}
          <pre
            style={{
              background: "var(--pw-bg-elev-2)",
              border: "1px solid var(--pw-border)",
              borderRadius: 4,
              padding: 10,
              fontSize: 11,
              lineHeight: 1.4,
              maxHeight: 220,
              overflow: "auto",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
            aria-label="Compiled segment AST"
          >
            {JSON.stringify(ast, null, 2)}
          </pre>

          <FormField label="Name" htmlFor="seg-nl-name" required>
            <input
              id="seg-nl-name"
              className="input"
              placeholder="Engaged but unpurchased"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
        </>
      ) : null}
    </>
  );
}
