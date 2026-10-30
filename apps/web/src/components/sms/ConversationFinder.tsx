// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// "Find conversations" card for the SMS Inbox tab (desktop
// pages/SMSInbox.tsx:421-582 search, 1465-1472 input; ThreadHeader context;
// 1275-1360 audited export).
//
//  * Server search — POST /api/v1/sms/conversations/search once the trimmed
//    text reaches the server's 3-character floor, debounced; paged with the
//    server's snapshot-bound cursor ("Load more results"); "Refresh search"
//    restarts at a new response cutoff.
//  * Per-result subscriber + consent context — GET …/{phone}/context.
//  * Audited tenant-wide CSV export — GET /api/v1/sms/conversations.csv.
//
// Owner/admin only (the routes are exact-admin), withheld entirely otherwise —
// the Inbox tab already explains the restriction. Raw search text and phone
// numbers never enter cache metadata: keys carry an opaque generation.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, RefreshCw, Search } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { onContextEpochObserved, readContextEpoch } from "@/lib/context-epoch";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { searchSmsConversations } from "@/lib/sms-api";
import {
  mergeSmsConversationSearchPages,
  smsSearchQueryProblem,
} from "@/lib/sms-conversation-lookup-contract";
import {
  safeSmsText,
  type SmsConversationSummary,
} from "@/lib/sms-inbox-contract";
import { useOnline } from "@/lib/use-online";

import { SmsConversationsCsvExport } from "./ConversationsCsvExport";
import { SmsConversationContextPanel } from "./ThreadHeader";

export const SMS_SEARCH_DEBOUNCE_MS = 300;
export const SMS_SEARCH_PAGE_LIMIT = 50;

interface FinderIdentity {
  tenantId: string;
  fingerprint: string;
}

function finderIdentity(me: MeResponse | null): FinderIdentity | null {
  if (!me) return null;
  const role = effectiveAuthRole(me);
  if ((role !== "owner" && role !== "admin") || me.viewer_mode === true) {
    return null;
  }
  return {
    tenantId: me.tenant_id,
    fingerprint: JSON.stringify([me.tenant_id, me.user_id, role, false]),
  };
}

export function SmsConversationFinder({
  baseKey,
  me,
}: {
  baseKey: readonly unknown[];
  me: MeResponse | null;
}) {
  const identity = finderIdentity(me);
  if (!identity) return null;
  return <FinderCard baseKey={baseKey} identity={identity} />;
}

function FinderCard({
  baseKey,
  identity,
}: {
  baseKey: readonly unknown[];
  identity: FinderIdentity;
}) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const inputId = useId();
  const hintId = useId();
  const [contextEpoch, setContextEpoch] = useState<string | null>(
    () => readContextEpoch() ?? null,
  );
  useEffect(() => onContextEpochObserved(setContextEpoch), []);

  const root = useMemo(
    () =>
      [
        ...baseKey,
        "conversation-finder",
        identity.fingerprint,
        contextEpoch,
      ] as const,
    [baseKey, contextEpoch, identity.fingerprint],
  );

  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState<{
    query: string;
    generation: number;
  } | null>(null);
  const generation = useRef(0);
  const [openContext, setOpenContext] = useState<{
    phone: string;
    seq: number;
  } | null>(null);
  const contextSeq = useRef(0);

  // Identity or epoch change: retire every private result under the old root.
  useEffect(() => {
    setSubmitted(null);
    setOpenContext(null);
    return () => {
      void queryClient.cancelQueries({ queryKey: root, exact: false });
      queryClient.removeQueries({ queryKey: root, exact: false });
    };
  }, [queryClient, root]);

  const trimmed = draft.trim();
  const problem = trimmed ? smsSearchQueryProblem(trimmed) : null;

  useEffect(() => {
    if (!trimmed || problem) {
      setSubmitted(null);
      return;
    }
    if (submitted?.query === trimmed) return;
    const timer = window.setTimeout(() => {
      generation.current += 1;
      setOpenContext(null);
      setSubmitted({ query: trimmed, generation: generation.current });
    }, SMS_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [problem, submitted?.query, trimmed]);

  const searchKey = useMemo(
    () => [...root, "search", submitted?.generation ?? 0] as const,
    [root, submitted?.generation],
  );
  const search = useInfiniteQuery({
    queryKey: searchKey,
    enabled: submitted !== null && online !== "offline",
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!submitted) throw new Error("No SMS search is active");
      return searchSmsConversations({
        tenantId: identity.tenantId,
        query: submitted.query,
        limit: SMS_SEARCH_PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      });
    },
    getNextPageParam: (page) => page.nextCursor,
    // Every search is an audited private read; only an explicit Refresh or a
    // new query may repeat it.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const merged = useMemo(() => {
    try {
      return {
        value: mergeSmsConversationSearchPages(
          Array.isArray(search.data?.pages) ? search.data.pages : [],
        ),
        error: null as string | null,
      };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : "Search pages disagree",
      };
    }
  }, [search.data?.pages]);

  const refreshSearch = () => {
    if (!submitted) return;
    generation.current += 1;
    setOpenContext(null);
    setSubmitted({ query: submitted.query, generation: generation.current });
  };

  const rows = merged.value?.conversations ?? [];
  const snapshotAt = merged.value?.snapshotAt ?? null;
  const hint = !trimmed
    ? "Search phone number, subscriber email, or message text. The server searches the whole workspace."
    : problem
      ? problem
      : null;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Find conversations</CardTitle>
            <CardDescription>
              Server search across every SMS conversation, with the linked
              subscriber and consent context for each match.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SmsConversationsCsvExport online={online === "online"} />
          </div>
        </div>
        <form
          role="search"
          aria-label="SMS conversation search"
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed || problem) return;
            if (submitted?.query === trimmed) refreshSearch();
            else {
              generation.current += 1;
              setOpenContext(null);
              setSubmitted({ query: trimmed, generation: generation.current });
            }
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Search SMS conversations
          </label>
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={inputId}
              type="search"
              className="pl-8"
              value={draft}
              maxLength={256}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search phone, subscriber, or message text"
              aria-describedby={hintId}
              aria-invalid={problem !== null && trimmed.length > 0}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!submitted || online !== "online" || search.isFetching}
            onClick={refreshSearch}
          >
            <RefreshCw aria-hidden /> Refresh search
          </Button>
        </form>
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint ??
            (online === "offline"
              ? "Offline — search needs a live connection."
              : search.isFetching && !search.isFetchingNextPage
                ? "Searching…"
                : snapshotAt
                  ? `${rows.length} match${rows.length === 1 ? "" : "es"} shown · ${
                      merged.value?.hasMore
                        ? "more results available for this response cutoff"
                        : "end of results for this response cutoff"
                    }`
                  : "")}
          {snapshotAt && !hint ? (
            <>
              {" "}
              · response cutoff <RelativeTime iso={snapshotAt} />
            </>
          ) : null}
        </p>
      </CardHeader>
      {submitted ? (
        <CardContent className="space-y-2">
          {search.isPending && online !== "offline" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Searching…
            </p>
          ) : search.isError && !search.data ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-destructive">
                Server search could not complete.{" "}
                {apiErrorMessage(search.error)}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={refreshSearch}
              >
                Retry search
              </Button>
            </div>
          ) : merged.error ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-destructive">
                {merged.error}. Refresh the search to start at a new response
                cutoff.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={refreshSearch}
              >
                Refresh search
              </Button>
            </div>
          ) : search.data && rows.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              No conversations matched this search at the response cutoff.
            </p>
          ) : rows.length > 0 ? (
            <>
              <ul aria-label="Search results" className="space-y-2">
                {rows.map((row) => (
                  <SearchResultRow
                    key={row.phoneE164}
                    row={row}
                    snapshotAt={snapshotAt}
                    tenantId={identity.tenantId}
                    contextOpen={openContext?.phone === row.phoneE164}
                    contextKey={[
                      ...root,
                      "context",
                      openContext?.phone === row.phoneE164
                        ? openContext.seq
                        : -1,
                    ]}
                    onToggleContext={() =>
                      setOpenContext((current) => {
                        if (current?.phone === row.phoneE164) return null;
                        contextSeq.current += 1;
                        return {
                          phone: row.phoneE164,
                          seq: contextSeq.current,
                        };
                      })
                    }
                  />
                ))}
              </ul>
              {search.isFetchNextPageError ? (
                <p role="alert" className="text-sm text-destructive">
                  More search results could not load.{" "}
                  {apiErrorMessage(search.error)}
                </p>
              ) : null}
              {search.hasNextPage ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={search.isFetching || online !== "online"}
                  onClick={() =>
                    void loadNextQueryPage(search, search.isEnabled)
                  }
                >
                  {search.isFetchingNextPage ? "Loading…" : "Load more results"}
                </Button>
              ) : null}
              <p className="text-xs text-muted-foreground">
                To read or change a thread, open the number from the message log
                below.
              </p>
            </>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function SearchResultRow({
  row,
  snapshotAt,
  tenantId,
  contextOpen,
  contextKey,
  onToggleContext,
}: {
  row: SmsConversationSummary;
  snapshotAt: string | null;
  tenantId: string;
  contextOpen: boolean;
  contextKey: readonly unknown[];
  onToggleContext: () => void;
}) {
  const preview =
    row.lastMessagePreviewOmittedReason === "body_exceeds_inbox_limit"
      ? "Message preview unavailable because it exceeds the safe inbox display limit"
      : row.lastMessagePreviewOmittedReason === "legacy_body_unavailable"
        ? "Legacy message preview unavailable"
        : row.lastMessagePreview;
  const cutoff = snapshotAt ? Date.parse(snapshotAt) : Number.NaN;
  const snoozed =
    row.snoozeUntil !== undefined &&
    !row.archivedAt &&
    Date.parse(row.snoozeUntil) > cutoff;
  return (
    <li className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium tabular-nums">
            <bdi dir="ltr">{row.phoneE164}</bdi>
          </span>
          {row.unreadCount > 0 ? (
            <Badge variant="info">{row.unreadCount} unread</Badge>
          ) : null}
          {row.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
          {snoozed ? <Badge variant="secondary">Snoozed</Badge> : null}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          <RelativeTime iso={row.lastMessageAt} />
        </span>
      </div>
      <p className="mt-1 min-w-0 text-xs text-muted-foreground">
        <span aria-hidden>{row.lastDirection === "inbound" ? "↩ " : "→ "}</span>
        <bdi
          dir="auto"
          className="[unicode-bidi:isolate] [overflow-wrap:anywhere]"
        >
          {safeSmsText(preview, 512)}
        </bdi>
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {row.identityAmbiguous ? (
          "Multiple subscriber identities; no email selected"
        ) : row.subscriberEmail ? (
          <bdi dir="auto">{safeSmsText(row.subscriberEmail, 320)}</bdi>
        ) : (
          "No linked subscriber identity"
        )}
        {" · "}
        {row.messageCount.toLocaleString()} message
        {row.messageCount === 1 ? "" : "s"}
      </p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="mt-1 px-2"
        aria-expanded={contextOpen}
        aria-label={`${contextOpen ? "Hide" : "Show"} subscriber & consent for ${row.phoneE164}`}
        onClick={onToggleContext}
      >
        {contextOpen ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        {contextOpen ? "Hide" : "Show"} subscriber &amp; consent
      </Button>
      {contextOpen ? (
        <div className="mt-2">
          <SmsConversationContextPanel
            tenantId={tenantId}
            phoneE164={row.phoneE164}
            queryKey={contextKey}
          />
        </div>
      ) : null}
    </li>
  );
}
