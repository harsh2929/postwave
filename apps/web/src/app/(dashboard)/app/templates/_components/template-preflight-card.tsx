// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { useMemo } from "react";

import { Card, CardContent } from "@/components/ui/card";
import {
  runTemplatePreflight,
  type TemplatePreflightContext,
} from "@/lib/template-merge-tags";
import { cn } from "@/lib/utils";

/**
 * Template pre-flight card — shifts the campaign-level readiness checks left to
 * the template surface (TMPL-023). Runs a lightweight, client-side scan of the
 * source (unsubscribe/footer presence, image alt coverage, expected merge
 * variables, balanced mustache braces) and surfaces each as a pass/warn row so
 * authors can catch issues before the design ever reaches a draft.
 */
export function TemplatePreflightCard({
  source,
  context,
}: {
  source: string;
  context?: TemplatePreflightContext;
}) {
  const checks = useMemo(
    () => runTemplatePreflight(source, context),
    [source, context],
  );
  const warnings = checks.filter((check) => check.status === "warn").length;

  return (
    <Card>
      <CardContent className="space-y-3 p-5 text-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="font-medium">Pre-flight checks</h2>
          <span
            className={cn(
              "ml-auto text-xs font-medium",
              warnings
                ? "text-amber-800 dark:text-amber-300"
                : "text-muted-foreground",
            )}
          >
            {warnings ? `${warnings} to review` : "All clear"}
          </span>
        </div>
        <ul className="space-y-2.5">
          {checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2.5">
              {check.status === "warn" ? (
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                  aria-hidden
                />
              ) : (
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
                  aria-hidden
                />
              )}
              <div className="min-w-0">
                <p className="font-medium leading-snug">{check.label}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {check.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          Draft checks only. Headers, authentication, resolved recipient data,
          and the final MIME message must be verified at test-send or send time.
        </p>
      </CardContent>
    </Card>
  );
}
