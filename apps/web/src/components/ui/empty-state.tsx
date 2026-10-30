// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Lucide icon shown in a Moosewave highlighter chip above the title. */
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  /** Optional CTA — typically a <Button>. */
  action?: React.ReactNode;
  className?: string;
}

/**
 * Shared empty-state block: a highlighter icon chip, a condensed editorial
 * title, warm guidance copy, and an optional CTA. Replaces the bare
 * "No X yet" table cells so empty surfaces feel intentional, not broken.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-sm flex-col items-center px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? (
        <span
          className="mb-4 inline-flex h-12 w-12 rotate-[-2deg] items-center justify-center rounded-[10px_15px_10px_15px] border-[1.5px] border-mw-ink bg-mw-yellow text-mw-ink shadow-[2px_3px_0_var(--mw-ink)]"
          aria-hidden
        >
          <Icon className="h-6 w-6" />
        </span>
      ) : null}
      <h3 className="font-display text-xl font-normal uppercase leading-none tracking-tight text-foreground">
        {title}
      </h3>
      {description ? (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
