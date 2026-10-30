// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRef, useState } from "react";
import { Info, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  voiceLabelsApi,
  VOICE_LABEL_AXES,
  type VoiceLabelAxis,
  type VoiceLabelInput,
} from "@/lib/voice-labels-api";
import { parseLabelImport } from "@/lib/voice-labels-helpers";
import { pluralize } from "@/lib/analytics-format";
import { ApiError } from "@/lib/api";
import { isServiceNotDeployed } from "@/lib/service-availability";

const AXIS_HINTS: Record<
  VoiceLabelAxis,
  { left: string; right: string; example: string }
> = {
  humor: {
    left: "earnest",
    right: "playful",
    example: "Deadpan asides and puns push right; a straight report sits left.",
  },
  formality: {
    left: "casual",
    right: "formal",
    example:
      "Contractions and slang push left; full titles and hedging push right.",
  },
  optimism: {
    left: "skeptical",
    right: "optimistic",
    example:
      "‘This might fail’ sits left; ‘this will change everything’ sits right.",
  },
  directness: {
    left: "indirect",
    right: "direct",
    example: "Long wind-ups sit left; a blunt ask in sentence one sits right.",
  },
  warmth: {
    left: "reserved",
    right: "warm",
    example:
      "Detached and clinical sits left; personal and encouraging sits right.",
  },
};

/** Rough guardrails so labelers calibrate consistently (SEQ-061). */
const RECOMMENDED_SAMPLE_WORDS = "40–200 words";
const TARGET_PER_AXIS = 20;

// The voice service rejects a label request body over 64 KiB. One submission
// posts the same sample five times (once per axis), so an oversized paste
// fails five ways at once with a raw 413 that no retry can fix. Cap the field
// far enough below that budget that multi-byte text plus notes still fits.
const SAMPLE_TEXT_MAX_CHARS = 8_000;

// Bulk import has no batch endpoint and no server-side de-duplication: every
// parsed row becomes a new label. Bound the file and the row count so a
// mis-picked export cannot fire thousands of simultaneous POSTs, and send them
// through a small pool so the tab stays responsive and can report progress.
const IMPORT_MAX_ROWS = 500;
const IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const IMPORT_CONCURRENCY = 5;

interface PendingImport {
  fileName: string;
  rows: VoiceLabelInput[];
  skipped: number;
}

type Values = Record<VoiceLabelAxis, number>;

function defaultValues(): Values {
  return {
    humor: 0.5,
    formality: 0.5,
    optimism: 0.5,
    directness: 0.5,
    warmth: 0.5,
  };
}

interface LabelFormProps {
  onSubmitted?: () => void;
  /**
   * Voice labeling isn't set up in this environment. The form stays on the
   * page, switched off, and every control is described by the page's notice.
   */
  notDeployed?: boolean;
  /** The id of the page's not-deployed notice, for aria-describedby. */
  notDeployedId?: string;
  /** Called when a save answers 503 service_not_deployed. */
  onServiceNotDeployed?: () => void;
}

/**
 * One submission produces one row per axis (the backend stores a single
 * scalar per row, axis-tagged). This matches the trainer feed format:
 * five rows per sample so each axis is independently learnable.
 */
export function LabelForm({
  onSubmitted,
  notDeployed = false,
  notDeployedId,
  onServiceNotDeployed,
}: LabelFormProps): JSX.Element {
  const [sampleText, setSampleText] = useState("");
  const [notes, setNotes] = useState("");
  const [values, setValues] = useState<Values>(defaultValues);
  const [submitting, setSubmitting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(
    null,
  );
  const importInputRef = useRef<HTMLInputElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  // There is no batch endpoint — one submission = five independent POSTs
  // (one row per axis). Promise.all used to reject on the first failure and
  // leave the already-resolved rows committed, so a natural retry duplicated
  // those axes. We track which axes have been persisted for the CURRENT sample
  // so a retry only re-sends the axes that did not yet succeed (idempotent).
  // Kept in a ref so it survives re-renders without triggering one.
  const persistedAxesRef = useRef<Set<VoiceLabelAxis>>(new Set());
  // The persisted-axes set is only valid for the EXACT payload that produced
  // it. If the sample text, notes, or any axis value changed since the last
  // submit, the prior per-axis successes no longer correspond to this
  // submission, so the dedup set must reset — otherwise a new sample would
  // silently skip the axes that succeeded for the previous one.
  const persistedSigRef = useRef<string>("");

  const sampleTooLong = sampleText.length > SAMPLE_TEXT_MAX_CHARS;
  const disabled =
    notDeployed ||
    submitting ||
    importing ||
    sampleText.trim().length === 0 ||
    sampleTooLong;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (disabled) return;
    setSubmitting(true);
    try {
      // Reset the dedup set if the payload changed since the last submit, so
      // we only ever skip an axis when re-submitting the IDENTICAL payload.
      const sig = JSON.stringify([sampleText.trim(), notes.trim(), values]);
      if (sig !== persistedSigRef.current) {
        persistedAxesRef.current = new Set();
        persistedSigRef.current = sig;
      }
      // Only POST axes that have not already been committed for this sample —
      // on a retry after a partial failure this avoids duplicating the rows
      // that already succeeded.
      const persisted = persistedAxesRef.current;
      const pending = VOICE_LABEL_AXES.filter((axis) => !persisted.has(axis));

      // allSettled (not all) so a mid-flight failure does not discard the
      // outcome of the axes that DID succeed — we record each success.
      const results = await Promise.allSettled(
        pending.map((axis) =>
          voiceLabelsApi.create({
            sample_text: sampleText.trim(),
            axis,
            value: Number(values[axis].toFixed(2)),
            notes: notes.trim() || undefined,
          }),
        ),
      );

      const failed: { axis: VoiceLabelAxis; reason: unknown }[] = [];
      results.forEach((result, i) => {
        const axis = pending[i];
        if (result.status === "fulfilled") {
          persisted.add(axis);
        } else {
          failed.push({ axis, reason: result.reason });
        }
      });

      if (
        failed.length > 0 &&
        failed.every((f) => isServiceNotDeployed(f.reason))
      ) {
        // Nothing to retry: this environment doesn't run voice labeling. The
        // page switches the form off and says so; a toast would say "retry".
        onServiceNotDeployed?.();
        return;
      }

      if (failed.length > 0) {
        // Partial (or total) failure: surface which axes failed and KEEP the
        // form input intact so the user can retry. The retry will skip the
        // axes already in persistedAxesRef, so no duplicate rows are written.
        const first = failed[0].reason;
        const detail =
          first instanceof ApiError
            ? `${first.status} ${first.message}`
            : first instanceof Error
              ? first.message
              : "Save failed";
        const axisList = failed.map((f) => f.axis).join(", ");
        toast.error(
          `Save incomplete (${axisList} failed: ${detail}). Submit again to retry the remaining axes.`,
        );
        return;
      }

      // Full success: reset the persisted set + signature for the next sample.
      persisted.clear();
      persistedSigRef.current = "";
      toast.success("Label saved");
      setSampleText("");
      setNotes("");
      setValues(defaultValues());
      onSubmitted?.();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `Save failed: ${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : "Save failed";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // Bulk import (SEQ-049): parse a JSON export/array and validate every row.
  // Malformed rows are surfaced rather than silently dropped. Parsing does not
  // write anything — the rows wait for an explicit confirmation, because the
  // service matches nothing against existing labels and the neighbouring
  // "Export all (JSON)" button produces exactly the file most likely to be
  // re-imported by mistake.
  async function handleImportFile(file: File | null): Promise<void> {
    if (!file) return;
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      toast.error(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Import files must stay under ${IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB.`,
      );
      if (importInputRef.current) importInputRef.current.value = "";
      return;
    }
    setImporting(true);
    try {
      const text = await file.text();
      const { valid, errors } = parseLabelImport(text);
      if (valid.length === 0) {
        toast.error(errors[0] ?? "No valid labels found in that file.");
        return;
      }
      if (valid.length > IMPORT_MAX_ROWS) {
        toast.error(
          `That file holds ${valid.length.toLocaleString()} labels. Import at most ${IMPORT_MAX_ROWS.toLocaleString()} at a time; split the file and import it in parts.`,
        );
        return;
      }
      setPendingImport({
        fileName: file.name,
        rows: valid,
        skipped: errors.length,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not read that file.",
      );
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  // There is no batch endpoint, so this is one POST per row. Firing them all at
  // once opened a connection per label and froze the tab behind a button that
  // said only "Importing..."; a small pool keeps the page responsive and lets
  // the count advance while the import runs.
  async function runImport(job: PendingImport): Promise<void> {
    setImporting(true);
    setImportProgress({ done: 0, total: job.rows.length });
    let saved = 0;
    let failedPost = 0;
    let done = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const input = job.rows[cursor];
        if (!input) return;
        cursor += 1;
        try {
          await voiceLabelsApi.create(input);
          saved += 1;
        } catch {
          failedPost += 1;
        }
        done += 1;
        setImportProgress({ done, total: job.rows.length });
      }
    };
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(IMPORT_CONCURRENCY, job.rows.length) },
          () => worker(),
        ),
      );
      if (saved > 0) onSubmitted?.();
      const parts = [`Imported ${saved} ${pluralize(saved, "label")}`];
      if (failedPost > 0) parts.push(`${failedPost} failed to save`);
      if (job.skipped > 0) parts.push(`${job.skipped} skipped (invalid)`);
      if (failedPost > 0 || job.skipped > 0) {
        toast.error(parts.join("; ") + ".");
      } else {
        toast.success(parts.join("; ") + ".");
      }
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* One disabled fieldset switches off every control below — textareas,
          sliders, import and save — when voice labeling isn't set up here,
          and ties them all to the page's explanation. */}
      <fieldset
        disabled={notDeployed}
        aria-describedby={notDeployed ? notDeployedId : undefined}
        className="min-w-0 space-y-5"
      >
        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <Info className="h-3.5 w-3.5" aria-hidden />
            How to rate
          </p>
          <p className="mt-1">
            Use a {RECOMMENDED_SAMPLE_WORDS} excerpt of real writing. Rate 0.50
            when an axis feels neutral. Aim for ~{TARGET_PER_AXIS} labeled
            samples per axis so the model has a balanced signal.
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="voice-label-sample"
            className="text-sm font-medium block"
          >
            Sample text
          </label>
          <Textarea
            id="voice-label-sample"
            value={sampleText}
            onChange={(e) => setSampleText(e.currentTarget.value)}
            rows={8}
            maxLength={SAMPLE_TEXT_MAX_CHARS}
            placeholder="Paste a sample of your writing voice..."
            aria-required="true"
            aria-invalid={sampleTooLong}
            aria-describedby="voice-label-sample-count"
          />
          <p
            id="voice-label-sample-count"
            className={
              sampleTooLong
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {sampleTooLong
              ? `Trim this sample to ${SAMPLE_TEXT_MAX_CHARS.toLocaleString()} characters. The voice service rejects a larger body outright, and one submission sends it once per axis.`
              : `${sampleText.length.toLocaleString()} / ${SAMPLE_TEXT_MAX_CHARS.toLocaleString()} characters · ${RECOMMENDED_SAMPLE_WORDS} recommended`}
          </p>
        </div>

        <fieldset className="space-y-4">
          <legend className="text-sm font-medium mb-1">
            Voice axes (0.00–1.00)
          </legend>
          {VOICE_LABEL_AXES.map((axis) => (
            <div key={axis}>
              <Slider
                label={axis.charAt(0).toUpperCase() + axis.slice(1)}
                leftLabel={AXIS_HINTS[axis].left}
                rightLabel={AXIS_HINTS[axis].right}
                min={0}
                max={1}
                step={0.01}
                value={values[axis]}
                onChange={(v) => setValues((prev) => ({ ...prev, [axis]: v }))}
              />
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                {AXIS_HINTS[axis].example}
              </p>
            </div>
          ))}
        </fieldset>

        <div className="space-y-2">
          <label
            htmlFor="voice-label-notes"
            className="text-sm font-medium block"
          >
            Notes (optional)
          </label>
          <Textarea
            id="voice-label-notes"
            value={notes}
            onChange={(e) => setNotes(e.currentTarget.value)}
            rows={3}
            placeholder="Anything the trainer should know about this sample"
          />
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) =>
            void handleImportFile(e.currentTarget.files?.[0] ?? null)
          }
        />
        <div className="flex items-center justify-between gap-3">
          <Button
            ref={importButtonRef}
            type="button"
            variant="outline"
            disabled={submitting || importing}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {importing
              ? importProgress
                ? `Importing ${importProgress.done}/${importProgress.total}...`
                : "Importing..."
              : "Import JSON"}
          </Button>
          <Button type="submit" disabled={disabled}>
            {submitting ? "Saving..." : "Save label"}
          </Button>
        </div>
      </fieldset>

      {pendingImport ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setPendingImport(null);
          }}
          title="Import these labels?"
          description={`${pendingImport.rows.length.toLocaleString()} ${pluralize(
            pendingImport.rows.length,
            "label",
          )} from “${pendingImport.fileName}” will be created as new rows. Nothing is matched against the labels you already have, so importing a file twice stores every sample twice.${
            pendingImport.skipped > 0
              ? ` ${pendingImport.skipped.toLocaleString()} malformed ${pluralize(pendingImport.skipped, "row")} will be skipped.`
              : ""
          }`}
          confirmLabel={`Import ${pendingImport.rows.length.toLocaleString()} ${pluralize(pendingImport.rows.length, "label")}`}
          confirmVariant="default"
          returnFocusRef={importButtonRef}
          onConfirm={() => {
            const job = pendingImport;
            setPendingImport(null);
            void runImport(job);
          }}
        />
      ) : null}
    </form>
  );
}
