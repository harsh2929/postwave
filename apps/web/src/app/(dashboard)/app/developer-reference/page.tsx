// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Developer reference — webhook events, transform operations, merge fields
 * and feed sources.
 *
 * Four paths desktop reached and web did not.
 *
 * Two caveats the raw data does not carry and a reader will otherwise assume
 * away:
 *
 *   - Sample payloads are illustrations with fixed identifiers and dates, not
 *     a schema. Someone building a consumer from them would treat the example
 *     values as canonical and the absent optional fields as impossible.
 *
 *   - The fifteen event types are what THIS build emits, not what the
 *     protocol permits. A consumer that switches exhaustively over them
 *     breaks when a sixteenth ships.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Braces,
  Check,
  ChevronDown,
  Copy,
  FlaskConical,
  Search,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

import {
  DataSection,
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { MergeFieldsSchemaEditor } from "@/components/subscribers/MergeFieldsSchemaModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  getMergeFieldSchema,
  getTransformOps,
  getWebhookSampleEvents,
  listFeedSources,
  sampleFields,
} from "@/lib/developer-reference-api";
import { base, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

export default function DeveloperReferencePage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canReadWebhookCatalog =
    meQuery.data?.viewer_mode !== true && roleCanWrite(effectiveRole);
  const keyBase = useMemo(
    () =>
      base(
        "developer-reference",
        meQuery.data?.tenant_id ?? "anon",
        effectiveRole,
      ),
    [effectiveRole, meQuery.data?.tenant_id],
  );

  const events = useQuery({
    queryKey: [...keyBase, "webhook-events"],
    queryFn: getWebhookSampleEvents,
    // This catalogue is an admin live diagnostic, even though the rest of the
    // developer reference is readable by viewers. Fail closed on identity and
    // honour View as viewer: a disabled query makes zero protected requests.
    enabled: meQuery.isSuccess && canReadWebhookCatalog,
    staleTime: STALE.reference,
  });
  const ops = useQuery({
    queryKey: [...keyBase, "transform-ops"],
    queryFn: getTransformOps,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const mergeFields = useQuery({
    queryKey: [...keyBase, "merge-fields"],
    queryFn: getMergeFieldSchema,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const feeds = useQuery({
    queryKey: [...keyBase, "feed-sources"],
    queryFn: listFeedSources,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });

  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const eventRows = Array.isArray(events.data) ? events.data : [];
  const opRows = Array.isArray(ops.data) ? ops.data : [];
  const mergeRows = Array.isArray(mergeFields.data) ? mergeFields.data : [];
  const feedRows = Array.isArray(feeds.data) ? feeds.data : [];
  const shownEvents = eventRows.filter((event) =>
    event.event_type.toLowerCase().includes(query.trim().toLowerCase()),
  );

  async function copyPayload(eventType: string, payload: unknown) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(eventType);
      toast.success("Sample payload copied");
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      toast.error("Couldn’t copy the sample payload");
    }
  }

  if (meQuery.isLoading || meQuery.isError) {
    return (
      <DataSurfaceShell className="max-w-5xl">
        <DataSurfaceHeader
          icon={Braces}
          eyebrow="Build with Moosewave"
          title="Developer reference"
          description="Inspect emitted webhook examples, supported transform operations, merge fields, and content-feed sources without leaving the dashboard."
        />
        {meQuery.isLoading ? (
          <SectionSkeleton rows={4} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="Reference requests were not started without a verified workspace context."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-5xl">
      <DataSurfaceHeader
        icon={Braces}
        eyebrow="Build with Moosewave"
        title="Developer reference"
        description="Inspect emitted webhook examples, supported transform operations, merge fields, and content-feed sources without leaving the dashboard."
        actions={
          <div className="flex flex-wrap gap-2">
            {/* Every role may browse the contract; the playground gates each
                operation on its own declared minimum role. */}
            <Link
              href="/app/developer-reference/playground"
              className="gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent"
            >
              <TerminalSquare aria-hidden className="size-4" />
              Open API playground
            </Link>
            {
              // The simulator sends real signed requests and its routes require
              // the exact owner/admin role, so the entry point is withheld from
              // everyone the page already withholds the event catalog from.
              canReadWebhookCatalog ? (
                <Link
                  href="/app/developer-reference/webhook-simulator"
                  className="gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent"
                >
                  <FlaskConical aria-hidden className="size-4" />
                  Open webhook simulator
                </Link>
              ) : null
            }
          </div>
        }
      />

      <DataSection
        id="dr-events"
        title="Webhook events"
        description="This is the set emitted by the current build, not a closed protocol. Handle unknown event types safely. Samples illustrate shape; they are not schemas."
        aside={
          canReadWebhookCatalog && !events.isLoading && !events.isError ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {shownEvents.length} of {eventRows.length}
            </span>
          ) : undefined
        }
      >
        {!canReadWebhookCatalog ? (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            Webhook event samples are an admin-only live diagnostic. No
            protected catalog request was made for this non-admin session.
          </p>
        ) : events.isLoading ? (
          <SectionSkeleton rows={4} />
        ) : events.isError ? (
          <QueryError
            title="Webhook events could not be loaded"
            description="The event list is unavailable; it has not been represented as an empty protocol."
            onRetry={() => void events.refetch()}
          />
        ) : eventRows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            This build emits no webhook events.
          </p>
        ) : (
          <>
            <div className="relative mb-3">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter event types…"
                aria-label="Filter webhook event types"
                className="pl-9 text-base sm:text-sm"
              />
            </div>
            {shownEvents.length === 0 ? (
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                No event types match “{query}”.
              </p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-xl border">
                {shownEvents.map((e, index) => {
                  const panelId = `event-sample-${index}`;
                  const expanded = open === e.event_type;
                  return (
                    <li key={e.event_type} className="bg-background">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-sm px-3.5 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        aria-expanded={expanded}
                        aria-controls={panelId}
                        onClick={() => setOpen(expanded ? null : e.event_type)}
                      >
                        <span className="min-w-0 break-all font-mono text-xs font-medium">
                          {e.event_type}
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                          {sampleFields(e).length} fields
                          <ChevronDown
                            aria-hidden
                            className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
                          />
                        </span>
                      </button>
                      {expanded ? (
                        <div id={panelId} className="border-t bg-muted/15 p-3">
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <span className="text-xs font-medium text-muted-foreground">
                              Example JSON
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                void copyPayload(e.event_type, e.sample_payload)
                              }
                              aria-label={`Copy ${e.event_type} sample payload`}
                            >
                              {copied === e.event_type ? (
                                <Check aria-hidden className="size-4" />
                              ) : (
                                <Copy aria-hidden className="size-4" />
                              )}
                              {copied === e.event_type ? "Copied" : "Copy"}
                            </Button>
                          </div>
                          {/* A JSON block has nothing focusable inside it, so the
                          scroll container itself must take focus or a keyboard
                          user cannot scroll a wide payload at all. */}
                          <pre
                            tabIndex={0}
                            role="group"
                            aria-label={`${e.event_type} sample payload`}
                            className="max-h-96 overflow-auto rounded-lg border bg-background p-3 text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <code>
                              {JSON.stringify(e.sample_payload, null, 2)}
                            </code>
                          </pre>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </DataSection>

      <DataSection
        id="dr-ops"
        title="Transform operations"
        description="Operations accepted by the current CDP transform runtime."
      >
        {ops.isLoading ? (
          <SectionSkeleton rows={2} />
        ) : ops.isError ? (
          <QueryError
            title="Transform operations could not be loaded"
            description="The runtime’s operation list is currently unreadable."
            onRetry={() => void ops.refetch()}
          />
        ) : opRows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            No transform operations available.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {opRows.map((o) => (
              <li
                key={o}
                className="max-w-full break-all rounded-md border bg-muted/20 px-2.5 py-1.5 font-mono text-xs text-foreground"
              >
                {o}
              </li>
            ))}
          </ul>
        )}
      </DataSection>

      <DataSection
        id="dr-merge"
        title="Merge-field schema"
        description="Fields currently available to personalization and template rendering."
        aside={
          mergeFields.isSuccess ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {mergeRows.length} fields
            </span>
          ) : undefined
        }
      >
        <ReferenceRows
          rows={mergeRows}
          loading={mergeFields.isLoading}
          errored={mergeFields.isError}
          empty="No merge fields are defined."
          retry={() => void mergeFields.refetch()}
        />
        {/* Parity row audience-44: the schema editor shares this list's key. */}
        <MergeFieldsSchemaEditor
          identity={meQuery.data ?? null}
          queryKey={[...keyBase, "merge-fields"]}
        />
      </DataSection>

      <DataSection
        id="dr-feeds"
        title="Feed sources"
        description="Connected content sources exposed to the current workspace."
        aside={
          feeds.isSuccess ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {feedRows.length} sources
            </span>
          ) : undefined
        }
      >
        <ReferenceRows
          rows={feedRows}
          loading={feeds.isLoading}
          errored={feeds.isError}
          empty="No content feeds are connected."
          retry={() => void feeds.refetch()}
        />
      </DataSection>
    </DataSurfaceShell>
  );
}

function ReferenceRows({
  rows,
  loading,
  errored,
  empty,
  retry,
}: {
  rows: unknown[];
  loading: boolean;
  errored: boolean;
  empty: string;
  retry: () => void;
}) {
  if (loading) return <SectionSkeleton rows={2} />;
  if (errored) {
    return (
      <QueryError
        description="This reference query failed; no empty state has been inferred."
        onRetry={retry}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
        {empty}
      </p>
    );
  }

  return (
    <ul className="divide-y overflow-hidden rounded-xl border">
      {rows.map((row, index) => {
        const record =
          row && typeof row === "object" && !Array.isArray(row)
            ? (row as Record<string, unknown>)
            : null;
        const label =
          record?.label ??
          record?.name ??
          record?.key ??
          record?.slug ??
          record?.id ??
          `Item ${index + 1}`;
        const detail =
          record?.type ?? record?.source ?? record?.provider ?? record?.status;
        return (
          <li
            key={`${String(label)}-${index}`}
            className="grid min-w-0 gap-1 p-3.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
          >
            <span className="break-words font-medium">{String(label)}</span>
            {detail != null ? (
              <span className="break-all text-xs text-muted-foreground sm:text-right">
                {String(detail).replaceAll("_", " ")}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
