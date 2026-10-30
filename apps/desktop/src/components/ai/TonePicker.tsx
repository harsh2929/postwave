/**
 * TonePicker — small chip-rack tone selector shared by the Compose form
 * and the chat composer.
 *
 * The backend's `tone` parameter is free-form string; we constrain it
 * to a small palette in the UI to make the value predictable and the
 * outputs comparable across runs.
 */

import type { ReactElement } from "react";

export type Tone =
  | ""
  | "friendly"
  | "direct"
  | "authoritative"
  | "playful"
  | "educational"
  | "urgent";

export const TONE_OPTIONS: { value: Tone; label: string; hint: string }[] = [
  { value: "", label: "Auto", hint: "Use voice profile default" },
  { value: "friendly", label: "Friendly", hint: "Warm, casual" },
  { value: "direct", label: "Direct", hint: "Punchy, no fluff" },
  { value: "authoritative", label: "Authoritative", hint: "Expert, confident" },
  { value: "playful", label: "Playful", hint: "Witty, light" },
  { value: "educational", label: "Educational", hint: "Explain & teach" },
  { value: "urgent", label: "Urgent", hint: "Time-sensitive" },
];

export function TonePicker({
  value,
  onChange,
}: {
  value: Tone;
  onChange: (t: Tone) => void;
}): ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label="Tone"
      style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
    >
      {TONE_OPTIONS.map((opt) => {
        const on = value === opt.value;
        return (
          <button
            key={opt.value || "auto"}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${opt.label}: ${opt.hint}`}
            onClick={() => onChange(opt.value)}
            className="chip"
            style={{
              borderColor: on ? "var(--pw-accent)" : "var(--pw-border)",
              background: on
                ? "color-mix(in srgb, var(--pw-accent) 14%, transparent)"
                : "transparent",
              color: on ? "var(--pw-fg)" : "var(--pw-fg-muted)",
              fontWeight: on ? 600 : 400,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
