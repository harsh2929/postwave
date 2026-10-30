"use client";

import type { RefObject } from "react";

import type { SequenceEmail, StyleControls } from "@/lib/voice-types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RegenerateEmailDialogProps {
  accepting: boolean;
  candidate: SequenceEmail | null;
  currentEmail: SequenceEmail;
  emailPosition: number;
  error: string | null;
  generating: boolean;
  hint: string;
  onAccept: () => void;
  onAdjust: () => void;
  onHintChange: (value: string) => void;
  onNewAttempt: () => void;
  onOpenChange: (open: boolean) => void;
  onRegenerate: () => void;
  onStyleChange: (style: StyleControls) => void;
  open: boolean;
  returnFocus: RefObject<HTMLButtonElement | null>;
  style: StyleControls;
}

export function RegenerateEmailDialog({
  accepting,
  candidate,
  currentEmail,
  emailPosition,
  error,
  generating,
  hint,
  onAccept,
  onAdjust,
  onHintChange,
  onNewAttempt,
  onOpenChange,
  onRegenerate,
  onStyleChange,
  open,
  returnFocus,
  style,
}: RegenerateEmailDialogProps) {
  const busy = generating || accepting;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        closeDisabled={busy}
        className="max-w-3xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => returnFocus.current?.focus());
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {candidate
              ? `Review email #${emailPosition} candidate`
              : `Regenerate email #${emailPosition}`}
          </DialogTitle>
          <DialogDescription>
            {candidate
              ? "This candidate is not saved. Compare it with the current draft, then explicitly accept or discard it."
              : "Generate a private review candidate with an optional hint and style nudge. Nothing changes until you accept and save the preview."}
          </DialogDescription>
        </DialogHeader>
        {candidate ? (
          <div className="space-y-3" aria-live="polite">
            <div className="grid gap-3 md:grid-cols-2">
              <EmailComparisonCard label="Current draft" email={currentEmail} />
              <EmailComparisonCard label="Candidate" email={candidate} />
            </div>
            <p className="text-xs text-muted-foreground">
              Acceptance replaces this email&apos;s copy and fidelity metadata.
              Its position and delay stay unchanged. The save uses the draft
              version from which this preview was requested.
            </p>
          </div>
        ) : (
          <fieldset disabled={generating} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="regeneration-hint">Hint</Label>
              <Textarea
                id="regeneration-hint"
                value={hint}
                maxLength={2000}
                onChange={(event) => onHintChange(event.target.value)}
                placeholder="Make it punchier. Mention the founder story."
                rows={3}
              />
              <p className="text-right text-[11px] text-muted-foreground tabular-nums">
                {hint.length}/2,000
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Slider
                label="Humor"
                value={style.humor}
                onChange={(value) => onStyleChange({ ...style, humor: value })}
                leftLabel="serious"
                rightLabel="playful"
              />
              <Slider
                label="Directness"
                value={style.directness}
                onChange={(value) =>
                  onStyleChange({ ...style, directness: value })
                }
                leftLabel="meandering"
                rightLabel="direct"
              />
              <Slider
                label="Length"
                value={style.lengthBias}
                onChange={(value) =>
                  onStyleChange({ ...style, lengthBias: value })
                }
                leftLabel="tight"
                rightLabel="long"
              />
              <Slider
                label="Formality"
                value={style.formality}
                onChange={(value) =>
                  onStyleChange({ ...style, formality: value })
                }
                leftLabel="casual"
                rightLabel="formal"
              />
            </div>
          </fieldset>
        )}
        {error ? (
          <div className="space-y-1">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            {!candidate ? (
              <p className="text-xs text-muted-foreground">
                Retry uses the same request key, which prevents an ambiguous
                response from spending twice. Starting a new attempt may use
                another generation quota unit.
              </p>
            ) : null}
          </div>
        ) : null}
        {candidate ? (
          <DialogFooter>
            <Button variant="ghost" onClick={onAdjust} disabled={busy}>
              Adjust prompt
            </Button>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Discard preview
            </Button>
            <Button
              onClick={onAccept}
              loading={accepting}
              disabled={generating}
            >
              {accepting ? "Saving candidate…" : "Accept & save"}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            {error ? (
              <Button variant="outline" onClick={onNewAttempt} disabled={busy}>
                Start new attempt
              </Button>
            ) : null}
            <Button onClick={onRegenerate} loading={generating}>
              {generating
                ? "Generating preview…"
                : error
                  ? "Retry same request"
                  : "Generate preview"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmailComparisonCard({
  email,
  label,
}: {
  email: SequenceEmail;
  label: string;
}) {
  const body =
    email.bodyMarkdown ||
    email.bodyMjml ||
    email.bodyHtml ||
    "No body content returned.";
  return (
    <section className="min-w-0 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          Fidelity {email.fidelity}/100
        </span>
      </div>
      <p className="mt-3 break-words text-sm font-medium">
        {email.subject || "(no subject)"}
      </p>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-sans text-xs leading-5 text-foreground">
        {body}
      </pre>
    </section>
  );
}
