// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-record presence badge (SHELL-036). Shows a small avatar stack of the
// OTHER people currently viewing this exact record (campaign, flow, sequence,
// …), so collaborators don't unknowingly edit the same thing. Renders nothing
// when you're the only viewer, so it's invisible until it matters.
"use client";

import { useEntityPresence, summarizePresence } from "@/lib/realtime/use-presence";
import { cn } from "@/lib/utils";

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * @param entityRef opaque record ref, e.g. `campaign:${id}` — must be stable
 *   for the lifetime of the page. Compose it once (see entityRefFor).
 */
export function EntityPresence({
  entityRef,
  className,
}: {
  entityRef: string;
  className?: string;
}) {
  const presence = useEntityPresence(entityRef);
  const { viewers, others } = summarizePresence(presence);
  if (others <= 0) return null;

  const extra = others - viewers.length;
  const label = `${others} other ${others === 1 ? "person" : "people"} viewing this`;

  return (
    <div
      className={cn("flex items-center gap-2", className)}
      title={label}
      aria-label={label}
      data-testid="entity-presence"
    >
      <span className="flex -space-x-1.5" aria-hidden>
        {viewers.map((v, i) => (
          <span
            key={v.id ?? `${v.label}-${i}`}
            className="flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-medium text-muted-foreground"
          >
            {initials(v.label ?? "?")}
          </span>
        ))}
        {extra > 0 || viewers.length === 0 ? (
          <span className="flex size-6 items-center justify-center rounded-full border-2 border-background bg-primary/15 text-[10px] font-medium text-primary">
            +{viewers.length === 0 ? others : extra}
          </span>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">viewing</span>
    </div>
  );
}

/** Compose a stable, namespaced entity ref for {@link EntityPresence}. */
export function entityRefFor(kind: string, id: string): string {
  return `${kind}:${id}`;
}
