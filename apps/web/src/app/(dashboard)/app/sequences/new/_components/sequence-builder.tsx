// SPDX-License-Identifier: AGPL-3.0-only
//
// Drag-step sequence builder for manual drafts. The backend now accepts the
// v0.3 sequence step union, so the web palette mirrors the desktop canvas:
// emails, standalone waits, conditions, tag mutations, and explicit exits.
"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, LayoutList, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { createSequence } from "@/lib/voice-api";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useVerifiedAuthScopeOptional } from "@/lib/auth-scope";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import {
  CONDITION_PREDICATES,
  DEFAULT_SEQUENCE_NAME,
  LEGACY_DRAFT_KEYS,
  MAX_SEQUENCE_DRAFT_STEPS,
  MAX_STORED_DRAFT_BYTES,
  PALETTE,
  byteLength,
  draftStorage,
  isPaletteStepKind,
  isStoredDraftTooLarge,
  newStep,
  restoreStoredDraft,
  sequenceDraftKey,
  serializeSequenceDraft,
  stepSummary,
  stepTitle,
  toStoredSteps,
  validateSequenceName,
  validateSteps,
  type CanvasStep,
  type DelayUnit,
  type PaletteStepKind,
} from "./sequence-builder-helpers";

export function SequenceBuilder(): JSX.Element {
  const router = useRouter();
  // Draft slots are keyed by the identity the dashboard verified at boot. When
  // it is unresolved both keys are null and the builder simply does not
  // persist — an unscoped fallback is what let one operator's subject/body
  // reach the next one on a shared tab.
  const authScope = useVerifiedAuthScopeOptional();
  const storageKey = sequenceDraftKey(authScope);
  const savedAtKey = storageKey ? `${storageKey}:at` : null;
  const [name, setName] = useState(DEFAULT_SEQUENCE_NAME);
  const [steps, setSteps] = useState<CanvasStep[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [baseline, setBaseline] = useState(() =>
    serializeSequenceDraft(DEFAULT_SEQUENCE_NAME, []),
  );
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const dragKindRef = useRef<PaletteStepKind | null>(null);
  const reorderFromRef = useRef<number | null>(null);
  const stepCountRef = useRef(0);
  const hydratedRef = useRef(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nameId = useId();
  const subjectId = useId();
  const bodyId = useId();
  const emailDelayId = useId();
  const emailUnitId = useId();
  const delayValueId = useId();
  const delayUnitId = useId();
  const conditionPredicateId = useId();
  const conditionValueId = useId();
  const tagId = useId();

  const serialized = useMemo(
    () => serializeSequenceDraft(name, steps),
    [name, steps],
  );
  const draftTooLarge = byteLength(serialized) > MAX_STORED_DRAFT_BYTES;
  const saveRequirement = draftTooLarge
    ? "Sequence draft is too large to save."
    : (validateSequenceName(name) ?? validateSteps(steps));
  const dirty = hydratedRef.current && serialized !== baseline;
  // Protect against tab close / in-app navigation while a manual build is in
  // progress (SEQ-004). Autosave (below) is the belt; this is the braces.
  useUnsavedChangesGuard(dirty);

  const stepLimitReached = steps.length >= MAX_SEQUENCE_DRAFT_STEPS;
  const appendStep = useCallback((kind: PaletteStepKind) => {
    if (stepCountRef.current >= MAX_SEQUENCE_DRAFT_STEPS) return;
    stepCountRef.current += 1;
    const step = newStep(kind);
    setSteps((prev) => {
      if (prev.length >= MAX_SEQUENCE_DRAFT_STEPS) {
        stepCountRef.current = prev.length;
        return prev;
      }
      return [...prev, step];
    });
    setSelectedId(step.id);
  }, []);

  useEffect(() => {
    stepCountRef.current = steps.length;
  }, [steps.length]);

  useEffect(() => {
    function onUp(e: MouseEvent) {
      const kind = dragKindRef.current;
      if (!kind) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      dragKindRef.current = null;
      if (inside) appendStep(kind);
    }
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [appendStep]);

  // Restore a previously-saved draft on mount and record when it was saved so
  // we can offer a "Restored draft" banner + Discard (SEQ-062).
  useEffect(() => {
    const store = draftStorage();
    try {
      // Drop anything written by the pre-scoping build rather than inheriting
      // it: that draft has no identity attached, so it cannot be shown to
      // anyone safely.
      for (const legacy of LEGACY_DRAFT_KEYS) store?.removeItem(legacy);
      const raw = storageKey ? store?.getItem(storageKey) : null;
      if (raw && !isStoredDraftTooLarge(raw)) {
        const restored = restoreStoredDraft(raw);
        if (
          restored &&
          (restored.steps.length > 0 || restored.name !== DEFAULT_SEQUENCE_NAME)
        ) {
          setName(restored.name);
          setSteps(restored.steps);
          setBaseline(serializeSequenceDraft(restored.name, restored.steps));
          setRestoredAt((savedAtKey ? store?.getItem(savedAtKey) : null) ?? "");
        }
      } else if (raw && storageKey) {
        store?.removeItem(storageKey);
      }
    } catch {
      // Ignore malformed drafts and start with an empty canvas.
    }
    hydratedRef.current = true;
  }, [savedAtKey, storageKey]);

  // Autosave-on-change so navigating away and back keeps in-progress work.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const store = draftStorage();
    if (!store || !storageKey || !savedAtKey) return;
    try {
      if (steps.length === 0 && name === DEFAULT_SEQUENCE_NAME) {
        store.removeItem(storageKey);
        store.removeItem(savedAtKey);
        return;
      }
      if (byteLength(serialized) <= MAX_STORED_DRAFT_BYTES) {
        store.setItem(storageKey, serialized);
        store.setItem(savedAtKey, new Date().toISOString());
      }
    } catch {
      /* best-effort autosave */
    }
  }, [name, savedAtKey, serialized, steps.length, storageKey]);

  const selected = steps.find((s) => s.id === selectedId) ?? null;

  const updateSelected = (patch: Partial<CanvasStep>) => {
    if (!selected) return;
    setSteps((prev) =>
      prev.map((s) =>
        s.id === selected.id ? ({ ...s, ...patch } as CanvasStep) : s,
      ),
    );
  };

  const removeStep = (id: string) => {
    setSteps((prev) => prev.filter((s) => s.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const moveStep = (index: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const reorderTo = (toIndex: number) => {
    const from = reorderFromRef.current;
    reorderFromRef.current = null;
    if (from === null || from === toIndex) return;
    setSteps((prev) => {
      if (from < 0 || from >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const discardDraft = () => {
    setName(DEFAULT_SEQUENCE_NAME);
    setSteps([]);
    setSelectedId(null);
    setBaseline(serializeSequenceDraft(DEFAULT_SEQUENCE_NAME, []));
    setRestoredAt(null);
    const store = draftStorage();
    if (storageKey) store?.removeItem(storageKey);
    if (savedAtKey) store?.removeItem(savedAtKey);
  };

  const save = async () => {
    const validation = validateSteps(steps);
    if (validation) {
      toast.error(validation);
      return;
    }
    if (draftTooLarge) {
      toast.error("Sequence draft is too large to save.");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast.success("Saved locally. Connect to create the backend draft.");
      return;
    }
    setSaving(true);
    try {
      const sequence = await createSequence({
        name: name.trim() || DEFAULT_SEQUENCE_NAME,
        status: "draft",
        steps: toStoredSteps(steps),
      });
      setBaseline(serialized); // clear dirty so the guard won't block the push
      const store = draftStorage();
      if (storageKey) store?.removeItem(storageKey);
      if (savedAtKey) store?.removeItem(savedAtKey);
      toast.success("Sequence draft created.");
      router.push(`/app/sequences/${sequence.id}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create sequence draft.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {restoredAt !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-accent/40 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            Restored your unsaved draft
            {restoredAt ? (
              <>
                {" "}
                from{" "}
                <span title={absoluteTime(restoredAt) || undefined}>
                  {timeAgo(restoredAt) || "earlier"}
                </span>
              </>
            ) : null}
            .
          </span>
          <Button variant="ghost" size="sm" onClick={discardDraft}>
            Discard draft
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[200px_1fr_320px]">
        <aside className="space-y-3 rounded-md border bg-card p-3">
          <div className="space-y-1">
            <Label htmlFor={nameId}>Sequence name</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-medium">Steps</h2>
            <ul className="space-y-2">
              {PALETTE.map((p) => (
                <li key={p.kind}>
                  <button
                    type="button"
                    data-testid={`palette-step-${p.kind}`}
                    draggable={!stepLimitReached}
                    disabled={stepLimitReached}
                    onMouseDown={() => {
                      dragKindRef.current = p.kind;
                    }}
                    onDragStart={(e) => {
                      dragKindRef.current = p.kind;
                      e.dataTransfer.setData("text/plain", p.kind);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => appendStep(p.kind)}
                    className="min-h-10 w-full rounded-md border bg-background px-3 py-2 text-left text-sm outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-border disabled:opacity-50"
                  >
                    {p.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <div
          ref={canvasRef}
          data-testid="sequence-canvas"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            e.preventDefault();
            // Ignore drops that are reorders (handled per-item); only the
            // palette-add flow lands on the container.
            if (reorderFromRef.current !== null) {
              reorderFromRef.current = null;
              return;
            }
            const raw = e.dataTransfer.getData("text/plain");
            const kind = isPaletteStepKind(raw) ? raw : dragKindRef.current;
            dragKindRef.current = null;
            if (kind) appendStep(kind);
          }}
          className="min-h-[280px] rounded-md border border-dashed bg-muted/20 p-4"
        >
          {steps.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-accent text-primary">
                <LayoutList className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium">Build your sequence</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Drag a step from the palette onto the canvas, or just click one
                to add it to the end.
              </p>
            </div>
          ) : (
            <ol className="space-y-2">
              {steps.map((s, i) => (
                <li
                  key={s.id}
                  draggable
                  onDragStart={() => {
                    reorderFromRef.current = i;
                  }}
                  onDragEnd={() => {
                    // Native dragend fires even when the pointer is released
                    // outside the canvas. Without this reset, the stale row
                    // index makes the next palette drop look like a reorder.
                    reorderFromRef.current = null;
                  }}
                  onDragOver={(e) => {
                    if (reorderFromRef.current !== null) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    reorderTo(i);
                  }}
                  className="flex items-stretch gap-2"
                >
                  <button
                    type="button"
                    data-testid={`canvas-step-${s.type}`}
                    onClick={() => setSelectedId(s.id)}
                    aria-pressed={selectedId === s.id}
                    className={`min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                      selectedId === s.id ? "border-primary" : ""
                    }`}
                  >
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Step {i + 1} - {s.type.replace("_", " ")}
                    </div>
                    <div className="mt-1 font-medium">{stepTitle(s)}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {stepSummary(s)}
                    </div>
                  </button>
                  <div className="flex flex-col justify-center gap-1">
                    <IconButton
                      size="sm"
                      aria-label={`Move step ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() => moveStep(i, -1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      aria-label={`Move step ${i + 1} down`}
                      disabled={i === steps.length - 1}
                      onClick={() => moveStep(i, 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        {selected ? (
          <aside
            data-testid="step-editor"
            className="space-y-3 rounded-md border bg-card p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Edit step</h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={() => removeStep(selected.id)}
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </Button>
            </div>

            {selected.type === "email" ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor={subjectId}>Subject</Label>
                  <Input
                    id={subjectId}
                    value={selected.subject}
                    onChange={(e) =>
                      updateSelected({ subject: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={bodyId}>Body</Label>
                  <Textarea
                    id={bodyId}
                    value={selected.body}
                    rows={5}
                    onChange={(e) => updateSelected({ body: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-[1fr_130px] gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={emailDelayId}>Delay before send</Label>
                    <Input
                      id={emailDelayId}
                      type="number"
                      min={0}
                      value={selected.delayValue}
                      onChange={(e) =>
                        updateSelected({ delayValue: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={emailUnitId}>Unit</Label>
                    <Select
                      id={emailUnitId}
                      value={selected.delayUnit}
                      onChange={(e) =>
                        updateSelected({
                          delayUnit: e.target.value as DelayUnit,
                        })
                      }
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </Select>
                  </div>
                </div>
              </>
            ) : null}

            {selected.type === "delay" ? (
              <div className="grid grid-cols-[1fr_130px] gap-2">
                <div className="space-y-1">
                  <Label htmlFor={delayValueId}>Wait</Label>
                  <Input
                    id={delayValueId}
                    type="number"
                    min={1}
                    value={selected.value}
                    onChange={(e) =>
                      updateSelected({ value: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={delayUnitId}>Unit</Label>
                  <Select
                    id={delayUnitId}
                    value={selected.unit}
                    onChange={(e) =>
                      updateSelected({ unit: e.target.value as DelayUnit })
                    }
                  >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </Select>
                </div>
              </div>
            ) : null}

            {selected.type === "condition" ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor={conditionPredicateId}>Predicate</Label>
                  <Select
                    id={conditionPredicateId}
                    value={selected.predicate}
                    onChange={(e) =>
                      updateSelected({ predicate: e.target.value })
                    }
                  >
                    {CONDITION_PREDICATES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={conditionValueId}>Argument</Label>
                  <Input
                    id={conditionValueId}
                    value={selected.value}
                    onChange={(e) => updateSelected({ value: e.target.value })}
                  />
                </div>
              </>
            ) : null}

            {selected.type === "tag_add" || selected.type === "tag_remove" ? (
              <div className="space-y-1">
                <Label htmlFor={tagId}>Tag</Label>
                <Input
                  id={tagId}
                  value={selected.tag}
                  onChange={(e) => updateSelected({ tag: e.target.value })}
                />
              </div>
            ) : null}

            {selected.type === "exit" ? (
              <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                This node ends the sequence for subscribers who reach it.
              </p>
            ) : null}
          </aside>
        ) : (
          <aside className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
            Select a step to edit its settings.
          </aside>
        )}
      </div>

      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
        {dirty ? (
          <span className="text-xs text-warning-emphasis">Unsaved changes</span>
        ) : null}
        {saveRequirement ? (
          <span
            id="sequence-save-requirement"
            role="status"
            className="text-xs text-muted-foreground sm:mr-auto"
          >
            Still needed: {saveRequirement}
          </span>
        ) : null}
        <Button
          type="button"
          onClick={() => void save()}
          disabled={saving || Boolean(saveRequirement)}
          aria-describedby={
            saveRequirement ? "sequence-save-requirement" : undefined
          }
        >
          {saving ? "Saving..." : "Save sequence"}
        </Button>
      </div>
    </div>
  );
}
