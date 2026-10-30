// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Slide-over editor for one canvas step (desktop parity automation-65; desktop
// reference apps/desktop/src/components/sequence/StepEditor.tsx:643 delay
// unit, :774-777 Save). Edits a local copy: email subject + body (and its A/B
// split), delay value + unit, condition predicate + argument, tag name. Save
// validates with the same rules the server applies and hands the finished step
// to the canvas, which saves the draft through the version-protected PATCH.

import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { markdownToHtml } from "@/components/editor/markdown";
import {
  CONDITION_PREDICATES,
  DELAY_UNIT_SECONDS,
  STEP_KIND_LABEL,
  stepProblem,
  type DelayUnit,
} from "@/lib/flow-canvas-model";
import type { SequenceStoredStep } from "@/lib/voice-types";

import {
  StepAbTestPanel,
  abTestStateFrom,
  abTestVariants,
  type AbTestState,
} from "./StepAbTestPanel";

type EmailStep = Extract<SequenceStoredStep, { type: "email" }>;

interface Draft {
  subject: string;
  body: string;
  delayValue: string;
  delayUnit: DelayUnit;
  predicate: string;
  conditionValue: string;
  tag: string;
  ab: AbTestState;
}

function delayParts(seconds: number): { value: number; unit: DelayUnit } {
  if (seconds > 0 && seconds % DELAY_UNIT_SECONDS.days === 0) {
    return { value: seconds / DELAY_UNIT_SECONDS.days, unit: "days" };
  }
  if (seconds > 0 && seconds % DELAY_UNIT_SECONDS.hours === 0) {
    return { value: seconds / DELAY_UNIT_SECONDS.hours, unit: "hours" };
  }
  return { value: Math.max(1, Math.round(seconds / 60)), unit: "minutes" };
}

function draftOf(step: SequenceStoredStep): Draft {
  const base: Draft = {
    subject: "",
    body: "",
    delayValue: "1",
    delayUnit: "days",
    predicate: "opened_previous",
    conditionValue: "",
    tag: "",
    ab: { enabled: false, drafts: [] },
  };
  switch (step.type) {
    case "email":
      return {
        ...base,
        subject: step.email.subject ?? "",
        body: step.email.body ?? "",
        ab: abTestStateFrom(step.email.variants),
      };
    case "delay": {
      const unit = step.delay.unit;
      const parts =
        unit && step.delay.value
          ? { value: step.delay.value, unit }
          : delayParts(step.delay.seconds);
      return {
        ...base,
        delayValue: String(parts.value),
        delayUnit: parts.unit,
      };
    }
    case "condition":
      return {
        ...base,
        predicate: step.condition.predicate,
        conditionValue: step.condition.value ?? "",
      };
    case "tag_add":
    case "tag_remove":
      return { ...base, tag: step.tag.tag ?? "" };
    case "exit":
      return base;
  }
}

/**
 * The step `draft` describes, or a sentence naming what blocks it. Only the
 * fields the editor owns change; everything else on the step (template id,
 * send delay, designed HTML for an untouched body) is carried through.
 */
function stepFromDraft(
  step: SequenceStoredStep,
  draft: Draft,
): { step: SequenceStoredStep } | { error: string } {
  let next: SequenceStoredStep;
  switch (step.type) {
    case "email": {
      const ab = abTestVariants(draft.ab);
      if ("error" in ab) return { error: ab.error };
      const bodyChanged = draft.body !== (step.email.body ?? "");
      // A rewritten plain body makes stored designed HTML/MJML stale, so the
      // rendered HTML is regenerated from it; an untouched body keeps both.
      const {
        body_html: _html,
        body_mjml: _mjml,
        variants: _variants,
        ...rest
      } = step.email;
      const email: EmailStep["email"] = {
        ...rest,
        subject: draft.subject.trim(),
        body: draft.body,
        ...(bodyChanged
          ? markdownToHtml(draft.body)
            ? { body_html: markdownToHtml(draft.body) }
            : {}
          : {
              ...(step.email.body_html
                ? { body_html: step.email.body_html }
                : {}),
              ...(step.email.body_mjml
                ? { body_mjml: step.email.body_mjml }
                : {}),
            }),
        ...(ab.variants ? { variants: ab.variants } : {}),
      };
      next = { ...step, email };
      break;
    }
    case "delay": {
      const value = Number(draft.delayValue);
      if (
        draft.delayValue.trim() === "" ||
        !Number.isInteger(value) ||
        value < 1
      ) {
        return { error: "Enter a whole number of 1 or more for the wait." };
      }
      next = {
        ...step,
        delay: {
          seconds: value * DELAY_UNIT_SECONDS[draft.delayUnit],
          value,
          unit: draft.delayUnit,
        },
      };
      break;
    }
    case "condition": {
      const { value: _value, ...condition } = step.condition;
      const argument = draft.conditionValue.trim();
      next = {
        ...step,
        condition: {
          ...condition,
          predicate: draft.predicate,
          ...(argument ? { value: argument } : {}),
        },
      };
      break;
    }
    case "tag_add":
    case "tag_remove":
      next = { ...step, tag: { tag: draft.tag.trim() } };
      break;
    case "exit":
      next = step;
      break;
  }
  const problem = stepProblem(next);
  return problem
    ? {
        error: `This ${STEP_KIND_LABEL[step.type].toLowerCase()} step ${problem}.`,
      }
    : { step: next };
}

function StepEditorForm({
  step,
  locationLabel,
  canEdit,
  lockedReason,
  onSave,
  onCancel,
}: {
  step: SequenceStoredStep;
  locationLabel: string;
  canEdit: boolean;
  lockedReason?: string;
  onSave: (step: SequenceStoredStep) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(step));
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const set = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const predicate = CONDITION_PREDICATES.find(
    (p) => p.value === draft.predicate,
  );

  const save = () => {
    if (!canEdit) {
      setError(lockedReason ?? "Editing is unavailable.");
      return;
    }
    const result = stepFromDraft(step, draft);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onSave(result.step);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Edit {STEP_KIND_LABEL[step.type].toLowerCase()} step
        </DialogTitle>
        <DialogDescription>
          {locationLabel}. Saving updates this draft; nothing enrolls or sends.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        {step.type === "email" ? (
          <>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-subject`} className="text-xs font-medium">
                Subject
              </Label>
              <Input
                id={`${ids}-subject`}
                value={draft.subject}
                disabled={!canEdit}
                onChange={(event) => set({ subject: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-body`} className="text-xs font-medium">
                Body (markdown)
              </Label>
              <Textarea
                id={`${ids}-body`}
                rows={8}
                value={draft.body}
                disabled={!canEdit}
                onChange={(event) => set({ body: event.target.value })}
              />
              {step.email.body_mjml ? (
                <p className="text-[11px] text-muted-foreground">
                  This email has a designed layout. Changing the body here
                  replaces that layout with the plain body.
                </p>
              ) : null}
            </div>
            <StepAbTestPanel
              value={draft.ab}
              base={{ subject: draft.subject, body: draft.body }}
              disabled={!canEdit}
              onChange={(ab) => set({ ab })}
            />
          </>
        ) : null}
        {step.type === "delay" ? (
          <div className="grid grid-cols-[1fr_130px] gap-2">
            <div className="space-y-1">
              <Label
                htmlFor={`${ids}-delay-value`}
                className="text-xs font-medium"
              >
                Wait
              </Label>
              <Input
                id={`${ids}-delay-value`}
                type="number"
                min={1}
                step={1}
                value={draft.delayValue}
                disabled={!canEdit}
                onChange={(event) => set({ delayValue: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label
                htmlFor={`${ids}-delay-unit`}
                className="text-xs font-medium"
              >
                Wait unit
              </Label>
              <Select
                id={`${ids}-delay-unit`}
                value={draft.delayUnit}
                disabled={!canEdit}
                onChange={(event) =>
                  set({ delayUnit: event.target.value as DelayUnit })
                }
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </Select>
            </div>
          </div>
        ) : null}
        {step.type === "condition" ? (
          <>
            <div className="space-y-1">
              <Label
                htmlFor={`${ids}-predicate`}
                className="text-xs font-medium"
              >
                Condition
              </Label>
              <Select
                id={`${ids}-predicate`}
                value={draft.predicate}
                disabled={!canEdit}
                onChange={(event) => set({ predicate: event.target.value })}
              >
                {CONDITION_PREDICATES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label
                htmlFor={`${ids}-condition-value`}
                className="text-xs font-medium"
              >
                {predicate?.needsValue
                  ? "Argument (required)"
                  : "Argument (optional)"}
              </Label>
              <Input
                id={`${ids}-condition-value`}
                value={draft.conditionValue}
                disabled={!canEdit}
                onChange={(event) =>
                  set({ conditionValue: event.target.value })
                }
              />
              {predicate?.valueHint ? (
                <p className="text-[11px] text-muted-foreground">
                  {predicate.valueHint}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
        {step.type === "tag_add" || step.type === "tag_remove" ? (
          <div className="space-y-1">
            <Label htmlFor={`${ids}-tag`} className="text-xs font-medium">
              Tag
            </Label>
            <Input
              id={`${ids}-tag`}
              value={draft.tag}
              disabled={!canEdit}
              onChange={(event) => set({ tag: event.target.value })}
            />
          </div>
        ) : null}
        {step.type === "exit" ? (
          <p className="text-sm text-muted-foreground">
            An exit step ends the journey for the subscriber. It has no
            settings.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {step.type === "exit" ? null : (
          <Button
            type="button"
            onClick={save}
            disabled={!canEdit}
            title={canEdit ? undefined : lockedReason}
          >
            Save step
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

export function StepEditorSlideover({
  step,
  locationLabel,
  canEdit,
  lockedReason,
  onSave,
  onClose,
}: {
  /** The step being edited; the panel renders nothing without one. */
  step: SequenceStoredStep | null;
  locationLabel: string;
  canEdit: boolean;
  lockedReason?: string;
  onSave: (step: SequenceStoredStep) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={step !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none border-l sm:max-w-md">
        {step ? (
          <StepEditorForm
            step={step}
            locationLabel={locationLabel}
            canEdit={canEdit}
            lockedReason={lockedReason}
            onSave={onSave}
            onCancel={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
