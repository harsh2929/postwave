// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";

import { ConversionKeysPanel } from "@/components/integrations/conversion-keys-panel";
import { ConversionIngestSecretsPanel } from "@/components/integrations/conversion-ingest-secrets-panel";
import { CopyTextButton } from "@/components/copy-text-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import {
  formatConversionAmount,
  listConversions,
  type ConversionCursor,
  type ConversionRow,
} from "@/lib/conversions-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { STALE } from "@/lib/query-keys";

const CONVERSION_SNIPPET = `# Publishable telemetry example — not signed ingest. Replace the host and key.
curl -X POST 'https://api.example.invalid/api/public/track/conversion' \\
  -H 'Authorization: Bearer <tracking-key>' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "event_name": "purchase",
    "amount_cents": 4900,
    "currency": "USD",
    "properties": {"sku": "DEMO-001"}
  }'`;

function attributionLabel(value: ConversionRow["attributed_via"]): string {
  if (value === "explicit") return "Explicit campaign hint";
  if (value === "last_touch") return "Heuristic last touch";
  if (value === "none") return "Unattributed";
  if (value === "code_redemption") return "Code assignment linkage";
  if (value === "campaign_vanity_path") return "Shared campaign path";
  return "Legacy / unclassified";
}

function attributionTone(
  value: ConversionRow["attributed_via"],
): "success" | "warning" | "secondary" | "outline" {
  if (value === "explicit") return "success";
  if (value === "last_touch") return "warning";
  if (value === "none") return "secondary";
  if (value === "code_redemption" || value === "campaign_vanity_path") {
    return "outline";
  }
  return "outline";
}

function verifyPages(pages: { items: ConversionRow[] }[]): {
  rows: ConversionRow[];
  error: string | null;
} {
  const rows = pages.flatMap((page) => page.items);
  const ids = new Set<number>();
  let previousTime = Number.POSITIVE_INFINITY;
  let previousId = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const at = Date.parse(row.occurred_at);
    if (
      ids.has(row.id) ||
      at > previousTime ||
      (at === previousTime && row.id >= previousId)
    ) {
      return {
        rows: [],
        error:
          "Conversion pages overlapped or arrived out of order. Retry before relying on this feed.",
      };
    }
    ids.add(row.id);
    previousTime = at;
    previousId = row.id;
  }
  return { rows, error: null };
}

export function TrackConversionsPanel({
  identity,
  queryKeyBase,
}: {
  identity: MeResponse;
  queryKeyBase: QueryKey;
}) {
  const [selected, setSelected] = useState<ConversionRow | null>(null);
  const conversions = useInfiniteQuery({
    queryKey: [...queryKeyBase, "conversions"],
    initialPageParam: null as ConversionCursor | null,
    queryFn: ({ pageParam, signal }) =>
      listConversions({
        tenantId: identity.tenant_id,
        cursor: pageParam,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: STALE.list,
  });
  const verified = useMemo(
    () => verifyPages(conversions.data?.pages ?? []),
    [conversions.data?.pages],
  );

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm leading-6">
        <strong>Telemetry trust boundary.</strong> A publishable conversion key
        proves workspace routing, not that an amount came from an authoritative
        financial system. Explicit attribution reflects a supplied campaign
        hint; last-touch attribution is a heuristic, not proof of causation.
      </div>

      {conversions.isPending ? (
        <p
          role="status"
          className="rounded-lg border p-4 text-sm text-muted-foreground"
        >
          Loading conversion events…
        </p>
      ) : conversions.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm"
        >
          <p>
            {apiErrorMessage(
              conversions.error,
              "The raw conversion feed could not be loaded. This read requires both report and subscriber scopes.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void conversions.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : verified.error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm"
        >
          <p>{verified.error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void conversions.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : verified.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          The conversion feed was verified and is empty. Conversions arrive
          through the public tracking endpoint or trusted backend integrations.
        </div>
      ) : (
        <div
          role="region"
          aria-label="Conversion event feed"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <table className="w-full min-w-[900px] text-left text-sm">
            <caption className="sr-only">Conversion event feed</caption>
            <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Occurred
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Event
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Subscriber
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Amount
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Attribution
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {verified.rows.map((conversion) => (
                <tr key={conversion.id}>
                  <td className="whitespace-nowrap px-3 py-3 text-xs">
                    {formatWireTimestamp(conversion.occurred_at, "Unknown")}
                  </td>
                  <td className="px-3 py-3">
                    <code className="break-all text-xs">
                      {conversion.event_name}
                    </code>
                  </td>
                  <td className="max-w-64 px-3 py-3">
                    <span
                      className="block truncate text-xs"
                      title={conversion.subscriber_email}
                    >
                      {conversion.subscriber_email || "Not recorded"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                    {formatConversionAmount(
                      conversion.amount_cents,
                      conversion.currency,
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant={attributionTone(conversion.attributed_via)}>
                      {attributionLabel(conversion.attributed_via)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(conversion)}
                    >
                      View details
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {conversions.hasNextPage && !verified.error ? (
        <div className="text-center">
          <Button
            type="button"
            variant="outline"
            disabled={conversions.isFetchingNextPage}
            loading={conversions.isFetchingNextPage}
            onClick={() =>
              void loadNextQueryPage(conversions, conversions.isEnabled)
            }
          >
            Load older conversions
          </Button>
          {conversions.isFetchNextPageError ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {apiErrorMessage(
                conversions.error,
                "Older conversions could not be loaded. Existing verified rows were retained.",
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      <section
        className="rounded-xl border p-4"
        aria-labelledby="conversion-posting-heading"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3
              id="conversion-posting-heading"
              className="flex items-center gap-2 font-medium"
            >
              <TrendingUp className="size-4" aria-hidden="true" />
              Posting conversions
            </h3>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              This public endpoint accepts low-trust telemetry with a
              publishable tracking key. It is not the signed-ingest endpoint and
              the example never sends an email. Trusted server ingest below
              accepts only a key-scoped email HMAC, never plaintext.
            </p>
          </div>
          <CopyTextButton
            value={CONVERSION_SNIPPET}
            label="Copy example"
            copiedLabel="Example copied"
            size="sm"
          />
        </div>
        <pre
          tabIndex={0}
          className="mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/20 p-3 text-xs"
        >
          {CONVERSION_SNIPPET}
        </pre>
      </section>

      <ConversionKeysPanel />
      <ConversionIngestSecretsPanel />

      <Dialog
        open={selected !== null}
        onOpenChange={(next) => !next && setSelected(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Conversion details</DialogTitle>
            <DialogDescription>
              Subscriber-linked conversion telemetry and attribution provenance.
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Conversion ID</dt>
                <dd className="mt-1 font-mono">{selected.id}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Event</dt>
                <dd className="mt-1 break-all font-mono">
                  {selected.event_name}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">
                  Subscriber email
                </dt>
                <dd className="mt-1 break-all">
                  {selected.subscriber_email || "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Amount</dt>
                <dd className="mt-1">
                  {formatConversionAmount(
                    selected.amount_cents,
                    selected.currency,
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Attribution</dt>
                <dd className="mt-1">
                  {attributionLabel(selected.attributed_via)}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Campaign</dt>
                <dd className="mt-1 break-all font-mono">
                  {selected.campaign_id || "Unattributed"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Properties</dt>
                <dd>
                  <pre
                    tabIndex={0}
                    className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/20 p-3 text-xs"
                  >
                    {JSON.stringify(selected.properties, null, 2)}
                  </pre>
                </dd>
              </div>
            </dl>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
