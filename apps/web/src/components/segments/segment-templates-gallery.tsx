// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { Sparkles, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { qk } from "@/lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import {
  listSegmentTemplates,
  type SegmentNode,
  type SegmentTemplate,
} from "@/lib/segments-api";
import { whoami } from "@/lib/auth-api";
import { STALE } from "@/lib/query-keys";

/**
 * Starter-template gallery for the New-segment flow (SEG-011). Lists the
 * backend catalog (GET /segments/templates) and applies a chosen template's
 * suggested name + ready-to-materialize AST into the builder.
 */
export function SegmentTemplatesGallery({
  onApply,
}: {
  onApply: (template: SegmentTemplate) => void;
}) {
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data?.role ?? null;

  const templatesQuery = useQuery({
    queryKey: qk.templates(tenantId, role, "segments"),
    queryFn: listSegmentTemplates,
    staleTime: STALE.reference,
  });

  const [expanded, setExpanded] = React.useState(false);

  if (templatesQuery.isError) return null;
  const templates = Array.isArray(templatesQuery.data) ? templatesQuery.data : [];
  if (!templatesQuery.isLoading && templates.length === 0) return null;

  const shown = expanded ? templates : templates.slice(0, 6);

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-medium">Start from a template</h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Curated predictive audiences you can apply, then fine-tune below.
      </p>
      {templatesQuery.isLoading ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-md border bg-muted/40" />
          ))}
        </div>
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => onApply(t)}
                className="group flex flex-col items-start gap-1 rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Wand2 className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />
                  {t.label}
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {t.description}
                </span>
                {t.category ? (
                  <span className="mt-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t.category}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {templates.length > 6 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show fewer" : `Show all ${templates.length}`}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

export function applyTemplate(t: SegmentTemplate): {
  name: string;
  ast: SegmentNode;
} {
  return { name: t.suggested_name || t.label, ast: t.predicate_json };
}
