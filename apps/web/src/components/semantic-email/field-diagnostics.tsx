// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { AlertTriangle, CircleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { diagnosticsForField } from "@/lib/semantic-email/authoring";
import type { Diagnostic } from "@/lib/semantic-email/types";

/**
 * Renders the diagnostics that belong to one field pointer.
 *
 * The point of putting them HERE rather than in a summary at the top is that
 * the author is told which box is wrong while their attention is still on that
 * box. A list of "3 problems" above the fold, addressed by JSON Pointer, is a
 * puzzle; an error under the input is an instruction.
 */
export function FieldDiagnostics({
  diagnostics,
  pointer,
  id,
  mode = "exact",
}: {
  diagnostics: readonly Diagnostic[];
  pointer: string;
  id?: string;
  /** "subtree" only where the child paths have no control of their own. */
  mode?: "exact" | "subtree";
}) {
  const own = diagnosticsForField(diagnostics, pointer, mode);
  if (own.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5" id={id}>
      {own.map((diagnostic, index) => (
        <li
          key={`${diagnostic.code}:${diagnostic.path}:${index}`}
          className={cn(
            "flex items-start gap-1.5 text-xs",
            diagnostic.severity === "error"
              ? "text-destructive"
              : "text-amber-700 dark:text-amber-400",
          )}
        >
          {diagnostic.severity === "error" ? (
            <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          )}
          <span>
            {diagnostic.message}{" "}
            <code className="text-[10px] opacity-70">{diagnostic.code}</code>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** True when any error (not warning) addresses this pointer or below it. */
export function hasFieldError(
  diagnostics: readonly Diagnostic[],
  pointer: string,
): boolean {
  return diagnosticsForField(diagnostics, pointer, "subtree").some(
    (diagnostic) => diagnostic.severity === "error",
  );
}
