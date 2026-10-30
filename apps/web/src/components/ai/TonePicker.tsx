// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Tone selector for the Moosewave AI chat composer (desktop TonePicker.tsx).
// The server has no `tone` field: the chosen tone is appended to the prompt as
// a `[Tone: …]` hint, exactly as desktop does. "Auto" sends no hint so the
// voice profile's defaults apply. The palette is constrained so outputs stay
// comparable across runs.

import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export type AiTone =
  | ""
  | "friendly"
  | "direct"
  | "authoritative"
  | "playful"
  | "educational"
  | "urgent";

export const AI_TONE_OPTIONS: ReadonlyArray<{
  value: AiTone;
  label: string;
  hint: string;
}> = [
  { value: "", label: "Auto", hint: "Use voice profile default" },
  { value: "friendly", label: "Friendly", hint: "Warm, casual" },
  { value: "direct", label: "Direct", hint: "Punchy, no fluff" },
  { value: "authoritative", label: "Authoritative", hint: "Expert, confident" },
  { value: "playful", label: "Playful", hint: "Witty, light" },
  { value: "educational", label: "Educational", hint: "Explain and teach" },
  { value: "urgent", label: "Urgent", hint: "Time-sensitive" },
];

export function isAiTone(value: unknown): value is AiTone {
  return AI_TONE_OPTIONS.some((option) => option.value === value);
}

/** The prompt the server receives for a chosen tone. */
export function applyToneHint(prompt: string, tone: AiTone): string {
  return tone ? `${prompt}\n\n[Tone: ${tone}]` : prompt;
}

export function TonePicker({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: AiTone;
  disabled?: boolean;
  onChange: (tone: AiTone) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Label htmlFor={id} className="shrink-0 text-xs text-muted-foreground">
        Tone
      </Label>
      <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
        <Select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            const next = event.target.value;
            if (isAiTone(next)) onChange(next);
          }}
        >
          {AI_TONE_OPTIONS.map((option) => (
            <option key={option.value || "auto"} value={option.value}>
              {option.label} — {option.hint}
            </option>
          ))}
        </Select>
      </div>
      <span id={`${id}-hint`} className="sr-only">
        Optional. Appended to the prompt as a tone hint; Auto uses your voice
        profile defaults.
      </span>
    </div>
  );
}
