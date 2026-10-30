// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { cn } from "@/lib/utils";
import { TAG_PALETTE, tagColorPresentation } from "../tag-catalogue-model";

/**
 * The tag colour picker: one radio per palette entry. A stored colour outside
 * the palette is announced as legacy so the operator knows saving a swatch
 * replaces it, while leaving it untouched is still allowed.
 */
export function TagColorPalette({
  id,
  value,
  onChange,
  disabled,
  legend = "Tag colour",
}: {
  id: string;
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  legend?: string;
}) {
  const presentation = tagColorPresentation(value);
  const current = value.toLowerCase();
  return (
    <div className="grid gap-2">
      <div
        id={id}
        role="radiogroup"
        aria-label={legend}
        className={cn("flex flex-wrap gap-2", disabled && "opacity-50")}
      >
        {TAG_PALETTE.map((p) => {
          const active = current === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={p.label}
              title={p.label}
              disabled={disabled}
              onClick={() => onChange(p.id)}
              className={cn(
                "size-7 rounded-full border-2 border-transparent transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed",
                active && "ring-2 ring-ring ring-offset-2",
              )}
              style={{ background: p.bg }}
            />
          );
        })}
      </div>
      {presentation.legacy ? (
        <p role="status" className="text-xs text-muted-foreground">
          Legacy colour: the stored value {JSON.stringify(value)} is shown as
          neutral slate. Choose a swatch only if you want to replace it.
        </p>
      ) : null}
    </div>
  );
}

/** A colour dot for a row or heading; legacy values render as slate. */
export function TagSwatch({ color }: { color: string | null | undefined }) {
  const presentation = tagColorPresentation(color);
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3 shrink-0 rounded-full"
      style={{ background: presentation.background }}
    />
  );
}
