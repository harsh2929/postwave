// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  leftLabel?: string;
  rightLabel?: string;
  className?: string;
  /** Hide the numeric read-out next to the label (caller renders its own). */
  hideValue?: boolean;
  /** Accessible name when no visible `label` is provided. */
  "aria-label"?: string;
}

/**
 * Value read-out. A leading "+" only makes sense on a signed/centered axis
 * (min < 0, e.g. serious↔playful). On a 0..1 axis the "+" is misleading, so we
 * drop it and show two decimals (SEQ-035).
 */
function formatSliderValue(value: number, min: number): string {
  if (min < 0) return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
  return value.toFixed(2);
}

export function Slider({
  value,
  onChange,
  min = -1,
  max = 1,
  step = 0.1,
  label,
  leftLabel,
  rightLabel,
  className,
  hideValue,
  "aria-label": ariaLabel,
}: SliderProps) {
  // Associate the visible label with the range input so screen readers
  // announce a name (SEQ-036); a sibling <span> alone is not an accessible
  // name for the control.
  const labelId = React.useId();
  return (
    <div className={cn("space-y-2", className)}>
      {label && (
        <div className="flex items-center justify-between">
          <span id={labelId} className="text-sm font-medium">
            {label}
          </span>
          {!hideValue && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatSliderValue(value, min)}
            </span>
          )}
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-labelledby={label ? labelId : undefined}
        aria-label={!label ? ariaLabel : undefined}
        className="h-11 w-full cursor-pointer appearance-none rounded-md bg-transparent ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-foreground [&::-moz-range-thumb]:shadow-sm [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-muted [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted [&::-webkit-slider-thumb]:-mt-[7px] [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:shadow-sm"
      />
      {(leftLabel || rightLabel) && (
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{leftLabel}</span>
          <span>{rightLabel}</span>
        </div>
      )}
    </div>
  );
}
