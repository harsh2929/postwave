// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getContentStudio,
  getMailchimpBlockCatalog,
  type ContentStudioResponse,
  type MailchimpBlockCatalogResponse,
} from "@/lib/mailchimp-compat-api";

import {
  entries,
  LoadingLine,
  metric,
  MetricBox,
  PanelError,
} from "./product-panel-primitives";

export function summarizeBlockCategories(
  blocks: MailchimpBlockCatalogResponse["blocks"] | undefined,
) {
  const counts: Record<string, number> = {};
  for (const block of blocks ?? []) {
    counts[block.category] = (counts[block.category] ?? 0) + 1;
  }
  return Object.entries(counts);
}

export function ContentStudioPanel({ className = "" }: { className?: string }) {
  const [studio, setStudio] = useState<ContentStudioResponse | null>(null);
  const [catalog, setCatalog] = useState<MailchimpBlockCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const [studioRes, catalogRes] = await Promise.all([
          getContentStudio(),
          getMailchimpBlockCatalog(),
        ]);
        if (!active) return;
        setStudio(studioRes);
        setCatalog(catalogRes);
        setError(null);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load content studio.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  const blockCategories = useMemo(
    () => summarizeBlockCategories(catalog?.blocks),
    [catalog],
  );

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Content Studio</CardTitle>
        <CardDescription>
          Asset lifecycle, reusable sections, AI surfaces, video conversion readiness, and Mailchimp-style content blocks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <LoadingLine /> : null}
        {error ? <PanelError message={error} /> : null}
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">Files and folders</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <MetricBox label="Files" value={studio?.files?.length ?? 0} />
              <MetricBox label="Folders" value={studio?.folders?.length ?? 0} />
              {entries(studio?.summary).slice(0, 4).map(([key, value]) => (
                <MetricBox key={key} label={key} value={metric(value)} />
              ))}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">Lifecycle and policies</div>
            <div className="mt-2 space-y-2">
              {entries(studio?.lifecycle).slice(0, 4).map(([key, value]) => (
                <div key={key} className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                  <span className="font-medium">{key}:</span> {metric(value, "enabled")}
                </div>
              ))}
              {studio?.limitations?.slice(0, 2).map((limit) => (
                // Use semantic warning tokens (dark-mode-safe) instead of raw amber-* swatches.
                <div key={limit} className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis">
                  {limit}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">Content block parity</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {blockCategories.map(([category, count]) => (
                <Badge key={category} variant="outline">
                  {category}: {count}
                </Badge>
              ))}
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              {catalog?.total_items ?? 0} supported block definitions.
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
