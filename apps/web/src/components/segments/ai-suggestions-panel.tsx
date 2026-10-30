// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lightbulb, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { base, STALE } from "@/lib/query-keys";
import { whoami } from "@/lib/auth-api";
import {
  createSegment,
  getAiSuggestions,
  type AiSuggestion,
} from "@/lib/segments-api";

/**
 * AI-suggested segments (SEG-037). Ranked suggestions computed from real tenant
 * signals (GET /segments/ai-suggestions), each applyable as a prefilled
 * segment. Fetched lazily (only when opened) so the list paint isn't taxed, and
 * the disclosure notice is always shown.
 */
export function AiSuggestionsPanel() {
  const router = useRouter();
  const panelId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [applying, setApplying] = React.useState<string | null>(null);

  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data?.role ?? null;

  const suggestionsQuery = useQuery({
    queryKey: [...base("segment-ai-suggestions", tenantId, role)],
    enabled: open && me.isFetched,
    queryFn: getAiSuggestions,
    staleTime: STALE.dashboard,
    retry: false,
  });

  const apply = async (s: AiSuggestion) => {
    setApplying(s.key);
    try {
      const created = await createSegment({
        name: s.name,
        description: s.description,
        queryAst: s.predicate_json,
      });
      toast.success(`Created "${s.name}" — review and save.`);
      router.push(`/app/subscribers/segments/${created.id}/edit`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't apply suggestion.",
      );
      setApplying(null);
    }
  };

  const suggestions = Array.isArray(suggestionsQuery.data?.items)
    ? suggestionsQuery.data?.items
    : [];

  return (
    <div className="rounded-lg border bg-card p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 w-full items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-8"
      >
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-sm font-medium">Suggested segments</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open ? (
        <div id={panelId} className="mt-3 space-y-3">
          {suggestionsQuery.isLoading ? (
            <div className="grid gap-2 sm:grid-cols-2" aria-hidden>
              {Array.from({ length: 2 }).map((_, i) => (
                <div
                  key={i}
                  className="h-24 animate-pulse rounded-md border bg-muted/40"
                />
              ))}
            </div>
          ) : suggestionsQuery.isError ? (
            <p className="text-sm text-muted-foreground">
              Suggestions aren&apos;t available right now.
            </p>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not enough signal yet — suggestions appear as engagement and
              commerce data accrues.
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {suggestions.map((s) => (
                  <div
                    key={s.key}
                    className="flex flex-col rounded-md border bg-background p-3"
                  >
                    <div className="flex items-start gap-2">
                      <Lightbulb
                        className="mt-0.5 h-4 w-4 text-primary"
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{s.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {s.description}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {s.category ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 uppercase tracking-wide">
                          {s.category}
                        </span>
                      ) : null}
                      <span>
                        ~{s.estimated_size.toLocaleString()} subscribers
                      </span>
                    </div>
                    {s.rationale ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {s.rationale}
                      </p>
                    ) : null}
                    <div className="mt-3">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11 sm:min-h-8"
                        disabled={applying !== null}
                        onClick={() => void apply(s)}
                      >
                        {applying === s.key ? "Applying…" : "Use this segment"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {suggestionsQuery.data?.notice ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {suggestionsQuery.data.notice}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
