// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Inbox, MessagesSquare, RefreshCw } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { CopySmsMessageBodyButton } from "@/components/sms/CopyMessageBodyButton";
import {
  type SmsInboxFilter,
  SmsInboxFilters,
  type SmsInboxSort,
} from "@/components/sms/InboxFilters";
import {
  isRetryableSmsMessage,
  RetryFailedSmsButton,
} from "@/components/sms/RetryFailedSmsButton";
import { SmsConversationContextPanel } from "@/components/sms/ThreadHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { onContextEpochObserved, readContextEpoch } from "@/lib/context-epoch";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { qk } from "@/lib/query-keys";
import {
  listSmsConversationMessages,
  listSmsConversations,
  markSmsConversationRead,
} from "@/lib/sms-api";
import {
  mergeSmsConversationPages,
  mergeSmsMessagePages,
  safeSmsText,
  smsDeliveryLabel,
  type SmsConversationStateMutationReceipt,
  type SmsConversationSummary,
} from "@/lib/sms-inbox-contract";
import { useOnline } from "@/lib/use-online";
import { formatMicrosAggregate } from "./page-helpers";
import { CardLoadError } from "./sms-card-states";
import {
  SmsInboxBulkActions,
  type SmsInboxAdminIdentity,
  SmsInboxStatePanel,
} from "./sms-inbox-state-panel";

// The reply composer (sender/consent reads, the saved-reply picker and the
// segment math) is thread-only UI below the message list; it loads on demand
// so the inbox tab's chunk stays lean.
const ReplyComposer = dynamic(
  () =>
    import("@/components/sms/ReplyComposer").then((mod) => mod.ReplyComposer),
  {
    loading: () => (
      <p role="status" className="text-xs text-muted-foreground">
        Loading reply composer…
      </p>
    ),
  },
);

export const SMS_INBOX_POLL_MS = 10_000;

export function shouldPollSmsInbox(
  online: string,
  pageVisible: boolean,
): boolean {
  return online === "online" && pageVisible;
}

export function smsInboxPollTargets<T>(
  threadOpen: boolean,
  conversations: T,
  messages: T,
): T[] {
  return threadOpen ? [conversations, messages] : [conversations];
}

export function shouldPauseSmsInboxPoll(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const pages = (data as { pages?: unknown }).pages;
  return Array.isArray(pages) && pages.length > 1;
}

function inboxIdentity(me: MeResponse | null): SmsInboxAdminIdentity | null {
  if (!me) return null;
  const effectiveRole = effectiveAuthRole(me);
  if (
    (effectiveRole !== "owner" && effectiveRole !== "admin") ||
    me.viewer_mode === true
  ) {
    return null;
  }
  return {
    tenantId: me.tenant_id,
    userId: me.user_id,
    effectiveRole,
    viewerMode: false,
    fingerprint: JSON.stringify([
      me.tenant_id,
      me.user_id,
      effectiveRole,
      false,
      me.workspace_slug,
    ]),
  };
}

export function SmsInboxTab({
  active,
  baseKey,
  me,
}: {
  active: boolean;
  baseKey: readonly unknown[];
  me: MeResponse | null;
}) {
  if (!active) return null;
  const identity = inboxIdentity(me);
  if (!identity) {
    return (
      <Card role="note">
        <CardHeader>
          <CardTitle className="text-base">SMS Inbox is restricted</CardTitle>
          <CardDescription>
            Only the current effective workspace owner or admin may request
            customer SMS.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <SmsMessageLogCard baseKey={baseKey} identity={identity} />;
}

function inboundKeyword(body: string): "STOP" | "HELP" | null {
  const value = body.trim().toUpperCase();
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)\b/u.test(value))
    return "STOP";
  if (/^(HELP|INFO)\b/u.test(value)) return "HELP";
  return null;
}

export function applySmsConversationStateReceipt(
  row: SmsConversationSummary,
  receipt: SmsConversationStateMutationReceipt,
): SmsConversationSummary {
  if (row.phoneE164 !== receipt.phoneE164) {
    throw new Error("SMS state receipt does not belong to the active thread");
  }
  const {
    snoozeUntil: _snoozeUntil,
    archivedAt: _archivedAt,
    assigneeUserId: _assigneeUserId,
    stateUpdatedAt: _stateUpdatedAt,
    ...unchanged
  } = row;
  return {
    ...unchanged,
    ...(receipt.snoozeUntil ? { snoozeUntil: receipt.snoozeUntil } : {}),
    ...(receipt.archivedAt ? { archivedAt: receipt.archivedAt } : {}),
    ...(receipt.assigneeUserId
      ? { assigneeUserId: receipt.assigneeUserId }
      : {}),
    stateUpdatedAt: receipt.stateUpdatedAt,
  };
}

export function SmsMessageLogCard({
  baseKey,
  identity,
}: {
  baseKey: readonly unknown[];
  identity: SmsInboxAdminIdentity;
}) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [activeConversation, setActiveConversation] =
    useState<SmsConversationSummary | null>(null);
  const activePhone = activeConversation?.phoneE164 ?? null;
  const [status, setStatus] = useState<
    "active" | "snoozed" | "archived" | "any"
  >("active");
  const [filter, setFilter] = useState<SmsInboxFilter>("all");
  const [sort, setSort] = useState<SmsInboxSort>("recent");
  const [selectedPhones, setSelectedPhones] = useState<Set<string>>(
    () => new Set(),
  );
  const [restoreFocusPhone, setRestoreFocusPhone] = useState<string | null>(
    null,
  );
  const [conversationsRestartRequired, setConversationsRestartRequired] =
    useState(false);
  const [messagesRestartRequired, setMessagesRestartRequired] = useState(false);
  const [readBoundaryError, setReadBoundaryError] = useState(false);
  const [readBoundaryRetry, setReadBoundaryRetry] = useState(0);
  const [contextEpoch, setContextEpoch] = useState<string | null>(
    () => readContextEpoch() ?? null,
  );
  const [pageVisible, setPageVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => onContextEpochObserved(setContextEpoch), []);
  useEffect(() => {
    const observeVisibility = () =>
      setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", observeVisibility);
    return () =>
      document.removeEventListener("visibilitychange", observeVisibility);
  }, []);

  const requestScope = useMemo(
    () => JSON.stringify([identity.fingerprint, contextEpoch]),
    [contextEpoch, identity.fingerprint],
  );
  const inboxRoot = useMemo(
    () => [...baseKey, "inbox-v2", requestScope] as const,
    [baseKey, requestScope],
  );
  const conversationsKey = useMemo(
    () => [...inboxRoot, "conversations", status, filter, sort] as const,
    [filter, inboxRoot, sort, status],
  );
  // Deliberately constant: raw phone/body/search text never enters cache metadata.
  const messagesKey = useMemo(
    () => [...inboxRoot, "active-thread"] as const,
    [inboxRoot],
  );
  // Thread-scoped children share the opaque thread prefix so closing the
  // thread retires their context/sender/saved-reply caches with it.
  const intentScope = `${identity.tenantId}:${identity.userId}`;
  const threadContextKey = useMemo(
    () => [...messagesKey, "context"] as const,
    [messagesKey],
  );
  const composerQueryBase = useMemo(
    () => [...messagesKey, "composer"] as const,
    [messagesKey],
  );
  const retryQueryBase = useMemo(
    () => [...messagesKey, "retry"] as const,
    [messagesKey],
  );
  const liveScope = useRef<string | null>(requestScope);
  const readAttempt = useRef<{
    key: string;
    controller: AbortController;
    status: "pending" | "succeeded" | "failed";
  } | null>(null);

  useEffect(() => {
    liveScope.current = requestScope;
    setActiveConversation(null);
    setSelectedPhones(new Set());
    setRestoreFocusPhone(null);
    setConversationsRestartRequired(false);
    setMessagesRestartRequired(false);
    setReadBoundaryError(false);
    return () => {
      if (liveScope.current === requestScope) liveScope.current = null;
      void queryClient.cancelQueries({ queryKey: inboxRoot, exact: false });
      queryClient.removeQueries({ queryKey: inboxRoot, exact: false });
    };
  }, [inboxRoot, queryClient, requestScope]);

  useEffect(() => {
    setActiveConversation(null);
    setSelectedPhones(new Set());
    setConversationsRestartRequired(false);
  }, [filter, sort, status]);

  useEffect(() => {
    if (activePhone !== null) return;
    // A query observer can briefly recreate its cache entry between the Back
    // handler's synchronous removal and React committing the closed thread.
    // Retire the opaque prefix again after every close, when all private
    // thread observers are definitively unmounted.
    void queryClient.cancelQueries({ queryKey: messagesKey, exact: false });
    queryClient.removeQueries({ queryKey: messagesKey, exact: false });
  }, [activePhone, messagesKey, queryClient]);

  const assertCurrent = useCallback(() => {
    const me = queryClient.getQueryData<MeResponse>(qk.authMe());
    const current = inboxIdentity(me ?? null);
    const epoch = readContextEpoch() ?? null;
    if (
      !current ||
      current.fingerprint !== identity.fingerprint ||
      liveScope.current !== requestScope ||
      (contextEpoch !== null && epoch !== contextEpoch)
    ) {
      throw new Error("SMS inbox identity or effective role changed");
    }
  }, [contextEpoch, identity.fingerprint, queryClient, requestScope]);

  const refreshFirstPage = useCallback(
    async (queryKey: readonly unknown[]) => {
      assertCurrent();
      const state = queryClient.getQueryState(queryKey);
      if (state?.fetchStatus === "fetching") return;

      // A continuation cursor is bound to its response cutoff. Retire every
      // loaded continuation before refreshing page one so a poll/manual
      // refresh can never merge a new cutoff with old cursor pages.
      queryClient.setQueryData<{
        pages: unknown[];
        pageParams: unknown[];
      }>(
        queryKey,
        (current) =>
          current && current.pages?.length > 1
            ? {
                pages: current.pages.slice(0, 1),
                pageParams: current.pageParams.slice(0, 1),
              }
            : current,
        // Trimming pagination is not a verified network refresh. Preserve the
        // prior success time until the replacement response decodes.
        { updatedAt: state?.dataUpdatedAt },
      );
      await queryClient.refetchQueries({
        queryKey,
        exact: true,
        type: "active",
      });
    },
    [assertCurrent, queryClient],
  );

  const restartAtLatest = useCallback(
    async (
      queryKey: readonly unknown[],
      clearRestartRequired: (value: boolean) => void,
    ) => {
      clearRestartRequired(false);
      await refreshFirstPage(queryKey);
    },
    [refreshFirstPage],
  );

  const conversations = useInfiniteQuery({
    queryKey: conversationsKey,
    enabled: online !== "offline",
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      assertCurrent();
      const page = await listSmsConversations({
        tenantId: identity.tenantId,
        limit: 50,
        status,
        filter,
        sort,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      });
      assertCurrent();
      return page;
    },
    getNextPageParam: (page) => page.nextCursor,
  });
  const messages = useInfiniteQuery({
    queryKey: messagesKey,
    enabled: online !== "offline" && activePhone !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      assertCurrent();
      if (!activePhone) throw new Error("No active SMS thread");
      const page = await listSmsConversationMessages(
        activePhone,
        identity.tenantId,
        {
          limit: 100,
          ...(pageParam ? { cursor: pageParam } : {}),
          signal,
        },
      );
      assertCurrent();
      return page;
    },
    getNextPageParam: (page) => page.nextCursor,
  });

  useEffect(() => {
    if (!shouldPollSmsInbox(online, pageVisible)) return;
    const queryKeys = smsInboxPollTargets(
      activePhone !== null,
      conversationsKey as readonly unknown[],
      messagesKey as readonly unknown[],
    );
    const timer = window.setInterval(() => {
      const refreshes = queryKeys.flatMap((key) => {
        const isMessages = key === messagesKey;
        if (shouldPauseSmsInboxPoll(queryClient.getQueryData(key))) {
          // A continuation is inseparable from the response cutoff that
          // produced it. Preserve the operator's loaded history and pause
          // automatic replacement until they explicitly restart at latest.
          if (isMessages) setMessagesRestartRequired(true);
          else setConversationsRestartRequired(true);
          return [];
        }
        return [refreshFirstPage(key)];
      });
      void Promise.all(refreshes).catch(() => {
        // Each query owns its visible refetch error. Identity changes are
        // handled by the enclosing cancellation/removal boundary.
      });
    }, SMS_INBOX_POLL_MS);
    return () => window.clearInterval(timer);
  }, [
    activePhone,
    conversationsKey,
    messagesKey,
    online,
    pageVisible,
    queryClient,
    refreshFirstPage,
  ]);

  const conversationMerge = useMemo(
    () =>
      mergeSafely(() =>
        mergeSmsConversationPages(conversations.data?.pages ?? []),
      ),
    [conversations.data?.pages],
  );
  const messageMerge = useMemo(
    () => mergeSafely(() => mergeSmsMessagePages(messages.data?.pages ?? [])),
    [messages.data?.pages],
  );

  // Mark only the inbound UUIDs in the strictly decoded first page, after the
  // page has committed to the UI. A timestamp boundary would sweep a late
  // inbound row the operator never saw; a merged-page boundary could clear
  // rows that were not present when this thread first opened.
  useEffect(() => {
    const firstPage = messages.data?.pages[0];
    if (
      !activePhone ||
      !messages.isSuccess ||
      messageMerge.error ||
      !messageMerge.value ||
      !firstPage
    ) {
      return;
    }
    const messageIds = firstPage.messages
      .filter((message) => message.direction === "inbound")
      .map((message) => message.id);
    if (messageIds.length === 0) return;
    const key = JSON.stringify([
      requestScope,
      activePhone,
      firstPage.snapshotAt,
      messageIds,
      readBoundaryRetry,
    ]);
    if (readAttempt.current?.key === key) return;

    readAttempt.current?.controller.abort();
    const controller = new AbortController();
    readAttempt.current = { key, controller, status: "pending" };
    setReadBoundaryError(false);
    void markSmsConversationRead(activePhone, messageIds, {
      signal: controller.signal,
    })
      .then(() => {
        assertCurrent();
        if (controller.signal.aborted || readAttempt.current?.key !== key)
          return;
        readAttempt.current.status = "succeeded";
        void queryClient.invalidateQueries({
          queryKey: conversationsKey,
          exact: true,
        });
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError") ||
          readAttempt.current?.key !== key
        ) {
          return;
        }
        readAttempt.current.status = "failed";
        setReadBoundaryError(true);
      });
    return () => {
      controller.abort();
      if (
        readAttempt.current?.key === key &&
        readAttempt.current.status === "pending"
      ) {
        readAttempt.current = null;
      }
    };
  }, [
    activePhone,
    assertCurrent,
    conversationsKey,
    messageMerge.error,
    messageMerge.value,
    messages.data?.pages,
    messages.isSuccess,
    queryClient,
    readBoundaryRetry,
    requestScope,
  ]);

  const closeThread = () => {
    // Tags/activity deliberately share this opaque thread prefix so raw phone
    // numbers never enter cache metadata. Retire the whole prefix before a
    // different phone can reuse it; otherwise the next thread could briefly
    // render the previous conversation's private state while refetching.
    void queryClient.cancelQueries({ queryKey: messagesKey, exact: false });
    queryClient.removeQueries({ queryKey: messagesKey, exact: false });
    readAttempt.current?.controller.abort();
    readAttempt.current = null;
    setReadBoundaryError(false);
    setActiveConversation(null);
  };

  if (activePhone) {
    const thread = messageMerge.value?.messages ?? [];
    const refreshConversationState = () => {
      void restartAtLatest(
        conversationsKey,
        setConversationsRestartRequired,
      ).catch(() => {
        // The query exposes its own refetch error while the last verified
        // lifecycle row remains visible.
      });
    };
    const onStateChanged = (receipt: SmsConversationStateMutationReceipt) => {
      setActiveConversation((current) =>
        current ? applySmsConversationStateReceipt(current, receipt) : current,
      );
      refreshConversationState();
      if (receipt.action !== "assign") closeThread();
    };
    const refreshThreadAfterSend = () => {
      // The composer/retry already reported the persisted receipt; the thread
      // and inbox queries expose their own refetch errors.
      void restartAtLatest(messagesKey, setMessagesRestartRequired).catch(
        () => {},
      );
      refreshConversationState();
    };
    return (
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={closeThread}
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden /> Back
            </Button>
            <CardTitle className="min-w-0 text-base tabular-nums">
              <bdi dir="ltr" className="break-all">
                {activePhone}
              </bdi>
            </CardTitle>
          </div>
          <SnapshotTruth
            online={online}
            fetching={messages.isFetching}
            refreshFailed={messages.isRefetchError}
            refreshedAt={messages.dataUpdatedAt || null}
            polling={shouldPollSmsInbox(online, pageVisible)}
            restartRequired={messagesRestartRequired}
            snapshotAt={messageMerge.value?.snapshotAt ?? null}
            partial={messageMerge.value?.hasMore ?? false}
          />
          <SmsConversationContextPanel
            tenantId={identity.tenantId}
            phoneE164={activePhone}
            queryKey={threadContextKey}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={online !== "online" || messages.isFetching}
            onClick={() =>
              void restartAtLatest(messagesKey, setMessagesRestartRequired)
            }
          >
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden /> Refresh thread
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeConversation ? (
            <SmsInboxStatePanel
              key={activeConversation.phoneE164}
              conversation={activeConversation}
              identity={identity}
              online={online}
              queryBase={[...messagesKey, "state"]}
              assertCurrent={assertCurrent}
              onStateChanged={onStateChanged}
              onRefreshRequired={refreshConversationState}
            />
          ) : null}
          {readBoundaryError ? (
            <div
              role="status"
              className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm"
            >
              Read status could not be updated; these messages may remain
              unread.
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-2"
                onClick={() => setReadBoundaryRetry((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {online === "offline" && !messages.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              Offline — no verified thread page is available.
            </p>
          ) : messages.isPending ? (
            <SkeletonRows width="w-2/3" />
          ) : (messages.isError && !messages.data) || messageMerge.error ? (
            <CardLoadError
              message="Messages failed identity, response-cutoff, or wire checks."
              onRetry={() => void messages.refetch()}
            />
          ) : thread.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No messages returned for this response cutoff.
            </p>
          ) : (
            <>
              {messages.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={messages.isFetching}
                  onClick={() =>
                    void loadNextQueryPage(messages, messages.isEnabled)
                  }
                >
                  {messages.isFetchingNextPage
                    ? "Loading…"
                    : "Load older messages"}
                </Button>
              ) : null}
              {thread
                .slice()
                .reverse()
                .map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    tenantId={identity.tenantId}
                    phoneE164={activePhone}
                    intentScope={intentScope}
                    online={online}
                    retryQueryBase={retryQueryBase}
                    onRetried={refreshThreadAfterSend}
                  />
                ))}
            </>
          )}
          <ReplyComposer
            tenantId={identity.tenantId}
            phoneE164={activePhone}
            intentScope={intentScope}
            online={online}
            queryBase={composerQueryBase}
            onSent={refreshThreadAfterSend}
          />
        </CardContent>
      </Card>
    );
  }

  const rows = conversationMerge.value?.conversations ?? [];
  const selectedRows = rows.filter((row) => selectedPhones.has(row.phoneE164));
  const lifecycleTotals = conversationMerge.value
    ? {
        active: conversationMerge.value.activeTotal,
        snoozed: conversationMerge.value.snoozedTotal,
        archived: conversationMerge.value.archivedTotal,
        any: conversationMerge.value.totalConversations,
      }
    : null;
  // unreadTotal/unknownTotal/totalConversations are inbox-wide (the server
  // ignores both `filter` and `status` for them), so a filtered page has no
  // bucket-scoped denominator to claim. They ride the decoded first page.
  const firstConversationPage = conversations.data?.pages[0] ?? null;
  const inboxTotals = firstConversationPage
    ? {
        total: firstConversationPage.totalConversations,
        unread: firstConversationPage.unreadTotal,
        unknown: firstConversationPage.unknownTotal,
      }
    : null;
  const shownOf =
    filter === "unread"
      ? `· unread filter (${inboxTotals?.unread ?? 0} unread inbox-wide)`
      : filter === "unknown"
        ? `· unknown-subscriber filter (${inboxTotals?.unknown ?? 0} unknown inbox-wide)`
        : `of ${lifecycleTotals?.[status] ?? 0} ${status === "any" ? "total" : status}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Message log</CardTitle>
        <CardDescription>
          Tenant-bound two-way SMS conversations and provider delivery evidence.
        </CardDescription>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Conversation lifecycle"
        >
          {(["active", "snoozed", "archived", "any"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={status === value ? "default" : "outline"}
              className="min-h-11"
              aria-pressed={status === value}
              disabled={conversations.isFetching && !conversations.data}
              onClick={() => setStatus(value)}
            >
              {value === "any"
                ? "All"
                : value[0]!.toUpperCase() + value.slice(1)}
              {lifecycleTotals ? ` (${lifecycleTotals[value]})` : ""}
            </Button>
          ))}
        </div>
        <SmsInboxFilters
          filter={filter}
          sort={sort}
          totals={inboxTotals}
          disabled={conversations.isFetching && !conversations.data}
          onFilterChange={setFilter}
          onSortChange={setSort}
        />
        <SnapshotTruth
          online={online}
          fetching={conversations.isFetching}
          refreshFailed={conversations.isRefetchError}
          refreshedAt={conversations.dataUpdatedAt || null}
          polling={shouldPollSmsInbox(online, pageVisible)}
          restartRequired={conversationsRestartRequired}
          snapshotAt={conversationMerge.value?.snapshotAt ?? null}
          partial={conversationMerge.value?.hasMore ?? false}
          count={
            conversationMerge.value
              ? `${rows.length} shown ${shownOf}`
              : undefined
          }
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={online !== "online" || conversations.isFetching}
          onClick={() =>
            void restartAtLatest(
              conversationsKey,
              setConversationsRestartRequired,
            )
          }
        >
          <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden /> Refresh inbox
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {online === "offline" && !conversations.data ? (
          <p role="status" className="text-sm text-muted-foreground">
            Offline — no verified inbox page is available.
          </p>
        ) : conversations.isPending ? (
          <SkeletonRows width="w-full" />
        ) : (conversations.isError && !conversations.data) ||
          conversationMerge.error ? (
          <CardLoadError
            message="Conversations failed count, response-cutoff, ordering, or wire checks."
            onRetry={() => void conversations.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No conversations returned for this response cutoff"
            description={`The ${status === "any" ? "all-conversations" : status} page returned no rows.`}
          />
        ) : (
          <>
            {rows.map((row) => (
              <ConversationRow
                key={row.phoneE164}
                row={row}
                selectable={status !== "any"}
                selected={selectedPhones.has(row.phoneE164)}
                onSelectedChange={(selected) =>
                  setSelectedPhones((current) => {
                    const next = new Set(current);
                    if (selected) next.add(row.phoneE164);
                    else next.delete(row.phoneE164);
                    return next;
                  })
                }
                restoreFocus={restoreFocusPhone === row.phoneE164}
                onOpen={() => {
                  setRestoreFocusPhone(row.phoneE164);
                  setActiveConversation(row);
                }}
              />
            ))}
            {conversations.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                disabled={conversations.isFetching}
                onClick={() =>
                  void loadNextQueryPage(conversations, conversations.isEnabled)
                }
              >
                {conversations.isFetchingNextPage
                  ? "Loading…"
                  : "Load more conversations"}
              </Button>
            ) : null}
            <SmsInboxBulkActions
              conversations={selectedRows}
              status={status}
              identity={identity}
              online={online}
              assertCurrent={assertCurrent}
              onRefreshRequired={() =>
                void restartAtLatest(
                  conversationsKey,
                  setConversationsRestartRequired,
                )
              }
              onComplete={() => {
                setSelectedPhones(new Set());
                void restartAtLatest(
                  conversationsKey,
                  setConversationsRestartRequired,
                );
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ConversationRow({
  row,
  selectable,
  selected,
  onSelectedChange,
  restoreFocus,
  onOpen,
}: {
  row: ReturnType<typeof mergeSmsConversationPages>["conversations"][number];
  selectable: boolean;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  restoreFocus: boolean;
  onOpen: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (restoreFocus) triggerRef.current?.focus();
  }, [restoreFocus]);
  const preview =
    row.lastMessagePreviewOmittedReason === "body_exceeds_inbox_limit"
      ? "Message preview unavailable because it exceeds the safe inbox display limit"
      : row.lastMessagePreviewOmittedReason === "legacy_body_unavailable"
        ? "Legacy message preview unavailable"
        : row.lastMessagePreview;
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {selectable ? (
            <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={selected}
                onChange={(event) => onSelectedChange(event.target.checked)}
                aria-label={`Select conversation with ${row.phoneE164}`}
              />
            </label>
          ) : null}
          <button
            ref={triggerRef}
            type="button"
            className="min-h-11 min-w-0 font-medium tabular-nums underline-offset-4 hover:underline"
            aria-label={`Open conversation with ${row.phoneE164}${row.unreadCount ? `, ${row.unreadCount} unread` : ""}`}
            onClick={onOpen}
          >
            <bdi dir="ltr">{row.phoneE164}</bdi>
            {row.unreadCount > 0 ? (
              <span className="ml-2 rounded-full bg-info-subtle px-2 py-0.5 text-[10px] font-semibold text-info">
                {row.unreadCount} new
              </span>
            ) : null}
          </button>
        </div>
        <span className="shrink-0 text-right text-xs text-muted-foreground">
          <MessagesSquare className="ml-auto mb-0.5 h-3.5 w-3.5" aria-hidden />
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
      </p>
    </div>
  );
}

function MessageRow({
  message,
  tenantId,
  phoneE164,
  intentScope,
  online,
  retryQueryBase,
  onRetried,
}: {
  message: ReturnType<typeof mergeSmsMessagePages>["messages"][number];
  tenantId: string;
  phoneE164: string;
  intentScope: string;
  online: string;
  retryQueryBase: readonly unknown[];
  onRetried: () => void;
}) {
  const outbound = message.direction === "outbound";
  const keyword =
    outbound || message.body_omitted_reason
      ? null
      : inboundKeyword(message.body);
  const displayBody =
    message.body_omitted_reason === "body_exceeds_inbox_limit"
      ? "Message text unavailable because it exceeds the safe inbox display limit"
      : message.body_omitted_reason === "legacy_body_unavailable"
        ? "Legacy message content unavailable"
        : message.body;
  return (
    <div className={outbound ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${outbound ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted text-foreground"}`}
      >
        {keyword ? (
          <Badge
            variant={keyword === "STOP" ? "destructive" : "info"}
            className="mb-1"
          >
            {keyword}
          </Badge>
        ) : null}
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          <bdi dir="auto" className="[unicode-bidi:isolate]">
            {safeSmsText(displayBody, 4_800)}
          </bdi>
        </p>
        <div
          className={`mt-1 flex flex-wrap items-center gap-2 text-[11px] ${outbound ? "text-primary-foreground/80" : "text-muted-foreground"}`}
        >
          <span>{smsDeliveryLabel(message.direction, message.status)}</span>
          {message.error_code ? (
            <span>
              · error{" "}
              <bdi dir="ltr">{safeSmsText(message.error_code, 128)}</bdi>
            </span>
          ) : null}
          {message.cost_micros > 0 ? (
            <span>· {formatMicrosAggregate(message.cost_micros)}</span>
          ) : null}
          <RelativeTime
            iso={message.created_at}
            className={outbound ? "text-primary-foreground/80" : undefined}
          />
          <CopySmsMessageBodyButton
            body={message.body}
            bodyOmittedReason={message.body_omitted_reason}
            tone={outbound ? "inverse" : "muted"}
          />
          {isRetryableSmsMessage(message) ? (
            <RetryFailedSmsButton
              tenantId={tenantId}
              phoneE164={phoneE164}
              message={message}
              intentScope={intentScope}
              online={online}
              queryBase={retryQueryBase}
              onRetried={onRetried}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SnapshotTruth({
  online,
  fetching,
  refreshFailed,
  refreshedAt,
  polling,
  restartRequired,
  snapshotAt,
  partial,
  count,
}: {
  online: string;
  fetching: boolean;
  refreshFailed: boolean;
  refreshedAt: number | null;
  polling: boolean;
  restartRequired: boolean;
  snapshotAt: string | null;
  partial: boolean;
  count?: string;
}) {
  const text =
    online === "offline"
      ? `Offline · ${snapshotAt ? "showing the last verified page set" : "no verified page available"}`
      : restartRequired
        ? "Loaded history preserved; automatic refresh is paused until you restart at the latest response cutoff"
        : refreshFailed && snapshotAt
          ? "Refresh failed; showing the last verified page set"
          : fetching && snapshotAt
            ? "Refreshing; the displayed page set may be stale"
            : snapshotAt
              ? `${count ? `${count} · ` : ""}${partial ? "more pages available for this response cutoff" : "no continuation cursor returned; newer writes may still exist"}`
              : "Waiting for a verified response";
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {text}
      {snapshotAt ? (
        <>
          {" "}
          · response cutoff <RelativeTime iso={snapshotAt} />
        </>
      ) : null}
      {refreshedAt ? (
        <>
          {" "}
          · last verified refresh{" "}
          <RelativeTime iso={new Date(refreshedAt).toISOString()} />
        </>
      ) : null}
      {online !== "offline" ? (
        <>
          {" "}
          ·{" "}
          {polling && !restartRequired
            ? "auto-refresh every 10 seconds"
            : "auto-refresh paused"}
        </>
      ) : null}
    </p>
  );
}

function SkeletonRows({ width }: { width: string }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className={`h-14 ${width}`} />
      ))}
    </div>
  );
}

function mergeSafely<T>(merge: () => T): { value: T | null; error: unknown } {
  try {
    return { value: merge(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}
