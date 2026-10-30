// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The selected email step's controls (delay, subject, suggestions, A/B) and
 * its body editor or read-only view. Moved out of page.tsx verbatim and
 * loaded on demand; the editor itself stays a further deferred boundary.
 */

import {
  useId,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import dynamic from "next/dynamic";
import { SplitSquareHorizontal, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  delayToHours,
  hoursToDelay,
  type DelayUnit,
} from "@/lib/sequence-helpers";
import type { SequenceEmail } from "@/lib/voice-types";

const EditorShell = dynamic(
  () =>
    import("@/components/editor/editor-shell").then(
      (module) => module.EditorShell,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        className="flex min-h-72 items-center justify-center text-sm text-muted-foreground"
      >
        Loading sequence editor…
      </div>
    ),
  },
);

export function EmailStepSection({
  selected,
  canEdit,
  editUnavailableReason,
  editorRevision,
  saving,
  canvasBusy,
  canvasLockedReason,
  selectedVariantCount,
  subjectSuggestions,
  setSubjectSuggestions,
  suggesting,
  suggestSubjects,
  abTriggerRef,
  setAbOpen,
  onDelayChange,
  onSubjectChange,
  onMarkdownChange,
  onMjmlChange,
  onMjmlSourceChange,
  onSaveMarkdown,
  onSaveMjml,
}: {
  selected: SequenceEmail;
  canEdit: boolean;
  editUnavailableReason: string;
  editorRevision: number;
  saving: boolean;
  canvasBusy: boolean;
  canvasLockedReason: string;
  selectedVariantCount: number;
  subjectSuggestions: string[] | null;
  setSubjectSuggestions: Dispatch<SetStateAction<string[] | null>>;
  suggesting: boolean;
  suggestSubjects: () => Promise<void>;
  abTriggerRef: RefObject<HTMLButtonElement | null>;
  setAbOpen: Dispatch<SetStateAction<boolean>>;
  onDelayChange: (position: number, delayHours: number) => void;
  onSubjectChange: (subject: string) => void;
  onMarkdownChange: (bodyMarkdown: string) => void | Promise<void>;
  onMjmlChange: (bodyMjml: string, bodyHtml: string) => void;
  onMjmlSourceChange: (bodyMjml: string) => void;
  onSaveMarkdown: (md: string) => Promise<void>;
  onSaveMjml: (mjml: string, html: string) => Promise<void>;
}) {
  return (
    <>
      <div className="border-b bg-card px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="shrink-0 text-xs text-muted-foreground">
            Draft delay
          </span>
          <DelayField
            key={`delay-${selected.id}-${editorRevision}`}
            hours={selected.delayHours}
            disabled={!canEdit}
            onChange={(h) => onDelayChange(selected.position, h)}
          />
          <span className="text-xs text-muted-foreground">
            after the previous email if a future runtime is qualified
          </span>
          {selected.regenerationCount ? (
            <span className="ml-auto text-xs text-muted-foreground">
              Regenerated {selected.regenerationCount}×
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Label
            htmlFor="subject"
            className="text-xs text-muted-foreground shrink-0"
          >
            Subject
          </Label>
          <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1">
            <Input
              id="subject"
              value={selected.subject}
              disabled={!canEdit}
              onChange={(e) => {
                onSubjectChange(e.target.value);
                setSubjectSuggestions(null);
              }}
            />
            {subjectSuggestions && subjectSuggestions.length > 0 ? (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border bg-popover p-1 shadow-md">
                <p className="px-2 py-1 text-[11px] text-muted-foreground">
                  Suggestions
                </p>
                {subjectSuggestions.map((variant, i) => (
                  <button
                    key={i}
                    type="button"
                    className="block min-h-10 w-full rounded px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      onSubjectChange(variant);
                      setSubjectSuggestions(null);
                    }}
                  >
                    {variant}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit || suggesting}
            title={canEdit ? "Suggest subject lines" : editUnavailableReason}
            onClick={() => void suggestSubjects()}
          >
            <Wand2 className="h-4 w-4" />
            <span className="hidden sm:inline">
              {suggesting ? "Suggesting…" : "Suggest"}
            </span>
          </Button>
          <Button
            ref={abTriggerRef}
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit || canvasBusy}
            title={
              canEdit
                ? canvasBusy
                  ? canvasLockedReason
                  : undefined
                : editUnavailableReason
            }
            onClick={() => {
              if (!canEdit || canvasBusy) return;
              setAbOpen(true);
            }}
            className="w-full sm:w-auto"
          >
            <SplitSquareHorizontal className="h-4 w-4" />
            {selectedVariantCount > 0
              ? `A/B test · ${selectedVariantCount} variants`
              : "A/B test"}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {canEdit ? (
          <EditorShell
            key={`${selected.id}:${editorRevision}`}
            documentId={selected.id}
            initialMarkdown={selected.bodyMarkdown}
            initialMjml={selected.bodyMjml ?? undefined}
            initialHtml={selected.bodyHtml}
            onMarkdownChange={onMarkdownChange}
            onMjmlChange={(mjml, html) => onMjmlChange(mjml, html)}
            onMjmlSourceChange={onMjmlSourceChange}
            onSaveMarkdown={onSaveMarkdown}
            onSaveMjml={onSaveMjml}
            saving={saving}
          />
        ) : (
          <ReadOnlyEmailBody email={selected} reason={editUnavailableReason} />
        )}
      </div>
    </>
  );
}

function DelayField({
  hours,
  disabled,
  onChange,
}: {
  hours: number;
  disabled: boolean;
  onChange: (hours: number) => void;
}) {
  const initial = hoursToDelay(hours);
  // Kept as the raw string so a rejected entry stays visible and named.
  // delayToHours clamps through Math.max(0, …), so "-3 days" and an emptied
  // field would both store 0 hours ("send immediately") while the box still
  // showed what the operator typed — a divergence only a reload reveals.
  const [value, setValue] = useState(String(initial.value));
  const [unit, setUnit] = useState<DelayUnit>(initial.unit);
  const valueId = useId();
  const unitId = useId();
  const errorId = useId();
  const parsed = Number(value);
  const invalid = value.trim() === "" || !Number.isFinite(parsed) || parsed < 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor={valueId} className="sr-only">
        Delay value
      </Label>
      <Input
        id={valueId}
        type="number"
        min={0}
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          const v = Number(next);
          if (next.trim() === "" || !Number.isFinite(v) || v < 0) return;
          onChange(delayToHours(v, unit));
        }}
        className="w-20"
      />
      <Label htmlFor={unitId} className="sr-only">
        Delay unit
      </Label>
      <Select
        id={unitId}
        value={unit}
        disabled={disabled}
        onChange={(e) => {
          const u = e.target.value as DelayUnit;
          setUnit(u);
          if (invalid) return;
          onChange(delayToHours(parsed, u));
        }}
        className="w-28"
      >
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </Select>
      {invalid ? (
        <p id={errorId} className="basis-full text-xs text-destructive">
          Delay must be zero or more. The draft keeps its last valid delay until
          this reads as a number.
        </p>
      ) : null}
    </div>
  );
}

function ReadOnlyEmailBody({
  email,
  reason,
}: {
  email: SequenceEmail;
  reason: string;
}) {
  const content =
    email.bodyMarkdown ||
    email.bodyMjml ||
    email.bodyHtml ||
    "No stored body content was returned for this email.";
  return (
    <section
      aria-label="Read-only email body"
      className="h-full overflow-auto bg-muted/20 p-4 sm:p-6"
    >
      <div className="mx-auto max-w-3xl rounded-lg border bg-card p-5 shadow-sm">
        <div className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Read-only review. {reason}
        </div>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground">
          {content}
        </pre>
      </div>
    </section>
  );
}
