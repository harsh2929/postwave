// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export interface Step {
  key: string;
  label: string;
}

export function Stepper({
  steps,
  current,
}: {
  steps: Step[];
  current: number;
}) {
  return (
    <ol
      className="flex w-full min-w-0 items-center"
      aria-label="Migration progress"
    >
      {steps.map((step, idx) => {
        const isDone = idx < current;
        const isActive = idx === current;
        const isLast = idx === steps.length - 1;
        const state = isDone ? "completed" : isActive ? "current" : "upcoming";
        return (
          <li
            key={step.key}
            aria-current={isActive ? "step" : undefined}
            aria-label={`${step.label}: ${state}`}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 sm:gap-3",
              !isLast && "min-w-0",
            )}
          >
            <div className="flex shrink-0 items-center gap-3">
              <div
                aria-hidden="true"
                className={cn(
                  "h-7 w-7 rounded-full inline-flex items-center justify-center text-xs font-semibold border transition-colors",
                  isDone && "bg-primary text-primary-foreground border-primary",
                  isActive && "border-primary text-primary bg-primary/10",
                  !isDone &&
                    !isActive &&
                    "border-border text-muted-foreground bg-card",
                )}
              >
                {isDone ? <Check className="h-3.5 w-3.5" /> : idx + 1}
              </div>
              <span
                aria-hidden="true"
                className={cn(
                  "hidden whitespace-nowrap text-sm sm:inline",
                  isActive
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </div>
            {!isLast && (
              <div
                className={cn(
                  "h-px flex-1 transition-colors",
                  isDone ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
