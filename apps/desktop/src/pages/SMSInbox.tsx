/**
 * SMSInbox — two-way SMS conversational view.
 *
 * Refined SMS Inbox PR 1: substantial rewrite. Layout still chat-style
 * (list left, thread right) but every piece is now its own component
 * + the surface is richer:
 *
 *   - InboxFilters: server-side filter chips (All / Unread / Unknown
 *     subscriber) with stable badge counts, plus a sort picker
 *     (Most recent vs Oldest unread first — the inbox-triage view).
 *   - ConversationRow: extracted row with subscriber affordance.
 *   - ThreadHeader: phone + consent posture badge + subscriber context
 *     strip (email, list count, opt-in source + date, total messages,
 *     first-seen). Loaded lazily via new /context endpoint.
 *   - MessageBubble: status pill (queued / sent / delivered / failed /
 *     blocked) with colour cues + retry button for failed outbound.
 *     Copy-body shortcut on every bubble.
 *   - DaySeparator: visual divider between bubbles on different days
 *     ("Today", "Yesterday", weekday for last week, dated for older).
 *   - ReplyComposer: Cmd+Enter sends, segment+chars left in segment
 *     surface, sender phone shown explicitly, opted-out compliance
 *     warning when context.consentStatus === "opted_out".
 *   - "Last refreshed Xs ago" indicator so operators can tell when
 *     the inbox last polled (and refresh manually if a thread feels
 *     stuck).
 *
 * Polling: 15s on conversations list, 10s on the open thread. Both
 * remain — the auto-refresh interval doesn't need PR 2 to land.
 *
 * Backend: apps/api/internal/sms/inbox.go (filter + sort + context
 * endpoint added in this PR; reply / mark-read are unchanged).
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { HeroEmptyState } from "../components/HeroEmptyState";
import { Modal, ModalFooter } from "../components/Modal";
import { ConfirmModal } from "../components/ConfirmModal";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { StatStrip, type StatCell } from "../components/StatStrip";
import { ActivityFeed } from "../components/sms/ActivityFeed";
import { ConversationRow } from "../components/sms/ConversationRow";
import { ConversationTagsNotes } from "../components/sms/ConversationTagsNotes";
import { DaySeparator } from "../components/sms/DaySeparator";
import { InboxBulkBar } from "../components/sms/InboxBulkBar";
import { InboxFilters } from "../components/sms/InboxFilters";
import { MessageBubble } from "../components/sms/MessageBubble";
import { QuickReplyPicker } from "../components/sms/QuickReplyPicker";
import { ReplyComposer } from "../components/sms/ReplyComposer";
import { BroadcastsPanel } from "../components/sms/broadcasts/BroadcastsPanel";
import { SnoozePicker } from "../components/sms/SnoozePicker";
import { StatusChips } from "../components/sms/StatusChips";
import { ThreadHeader } from "../components/sms/ThreadHeader";
import {
  classifySMSReplyUncertainty,
  eligibleSMSSenders,
  normalizeSMSUSCA,
  smsReplyBodyConstraint,
  smsReplyDispatchHoldCopy,
  smsReplyReconciliationCopy,
  smsReplyUncertaintyCopy,
  type SMSReplyRequest,
} from "../components/sms/sms-reply-intent";
import {
  SMS_REPLY_RECOVERY_CHANGE_EVENT,
  smsReplyRecovery,
  type SMSReplyPrepareResult,
  type SMSReplyRecoverySummary,
} from "../components/sms/sms-reply-recovery";
import { useSMSDocumentVisible } from "../components/sms/sms-page-activity";
import { smsSegmentInfo } from "../components/sms/broadcasts/broadcast-helpers";
import {
  type SMSInboxMode,
  routeWithSMSInboxView,
  safeSMSInboxBoundaryRoute,
  smsInboxRouteView,
} from "../components/sms/sms-inbox-route";
import { toast } from "../components/Toast";
import {
  type SMSConversationContext,
  type SMSConversationFilter,
  type SMSConversationSort,
  type SMSConversationStatus,
  type SMSConversationSummary,
  type SMSMessage,
  api,
  getApiKey,
  getApiUrl,
} from "../lib/api-client";
import {
  desktopRouteIdentityScope,
  navigateDesktopRoute,
  useDesktopRoute,
  useDesktopRouteSnapshot,
} from "../lib/desktop-router";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { HERO } from "../lib/heroAssets";
import { saveFile } from "../lib/file-transfer";
import { nativeAwareFetch } from "../lib/native-api-fetch";
import { onContextEpochObserved, readContextEpoch } from "../lib/context-epoch";
import { useCanAdmin, useMe } from "../lib/store";
import "../styles-sms-inbox.css";

const AUTO_REFRESH_CONVERSATIONS_MS = 15_000;
const AUTO_REFRESH_THREAD_MS = 10_000;

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function fmtAge(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

const SMS_PAGE_TABS = [{ value: "inbox" }, { value: "broadcasts" }] as const;

interface SMSInboxTotals {
  total: number;
  unread: number;
  unknown: number;
  active: number;
  snoozed: number;
  archived: number;
}

function buildSmsStatCells(
  totals: SMSInboxTotals,
  setFilter: (filter: SMSConversationFilter) => void,
  setStatus: (status: SMSConversationStatus) => void,
): StatCell[] {
  return [
    {
      label: "Conversations",
      value: totals.total.toLocaleString(),
      hint: "Distinct phone numbers that have ever messaged with this workspace.",
    },
    {
      label: "Unread",
      value: totals.unread.toLocaleString(),
      hint: "Inbound messages that haven't been viewed. Selecting a thread marks it read.",
      onClick: totals.unread > 0 ? () => setFilter("unread") : undefined,
      ariaLabel: "Filter to unread conversations",
    },
    {
      label: "Unknown senders",
      value: totals.unknown.toLocaleString(),
      hint: "Phone numbers not yet linked to a known subscriber profile.",
      onClick: totals.unknown > 0 ? () => setFilter("unknown") : undefined,
      ariaLabel: "Filter to unknown-sender conversations",
    },
    {
      label: "Snoozed",
      value: totals.snoozed.toLocaleString(),
      hint: "Conversations temporarily hidden until a scheduled time. They reappear here when the snooze expires.",
      onClick: totals.snoozed > 0 ? () => setStatus("snoozed") : undefined,
      ariaLabel: "Switch to snoozed conversations",
    },
  ];
}

function describeSmsFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function emptySmsTotals(): SMSInboxTotals {
  return {
    total: 0,
    unread: 0,
    unknown: 0,
    active: 0,
    snoozed: 0,
    archived: 0,
  };
}

function useSMSOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const markOnline = (): void => setOnline(true);
    const markOffline = (): void => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);
  return online;
}

interface SMSFeedControls {
  enabled: boolean;
  filter: SMSConversationFilter;
  onFilter: (value: SMSConversationFilter) => void;
  onSearch: (value: string) => void;
  onSort: (value: SMSConversationSort) => void;
  onStatus: (value: SMSConversationStatus) => void;
  search: string;
  sort: SMSConversationSort;
  status: SMSConversationStatus;
}

function useSMSConversationFeed(controls: SMSFeedControls) {
  const [conversations, setConversations] = useState<
    SMSConversationSummary[] | null
  >(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [totals, setTotals] = useState<SMSInboxTotals>(emptySmsTotals);
  const {
    enabled,
    filter,
    onFilter: setFilter,
    onSearch: setSearch,
    onSort: setSort,
    onStatus: setStatus,
    search,
    sort,
    status,
  } = controls;
  const [searchResults, setSearchResults] = useState<
    SMSConversationSummary[] | null
  >(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchResultQuery, setSearchResultQuery] = useState<string | null>(
    null,
  );
  const [searchNextCursor, setSearchNextCursor] = useState<
    string | undefined
  >();
  const [searchSnapshotAt, setSearchSnapshotAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const listGenerationRef = useRef(0);
  const searchSeqRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const loadMoreRef = useRef(false);
  const refreshBusyRef = useRef(false);
  const refreshOwnerRef = useRef(0);
  const online = useSMSOnlineStatus();
  const documentVisible = useSMSDocumentVisible();
  const active = enabled && documentVisible;
  const listIdentity = `${status}:${filter}:${sort}`;

  const fetchFirstPage = useCallback(
    async (showBusy: boolean): Promise<void> => {
      if (!active || !online) return;
      listAbortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;
      const generation = ++listGenerationRef.current;
      // A first-page request starts a new insertion-cutoff window. Invalidate
      // the previous cursor immediately so no later page can be mixed into it.
      setNextCursor(undefined);
      setSnapshotAt(null);
      if (showBusy) setRefreshing(true);
      try {
        const result = await api.listSMSConversations({
          limit: 100,
          filter,
          sort,
          status,
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          generation !== listGenerationRef.current
        ) {
          return;
        }
        if (result.error) {
          setErr("The SMS inbox page could not be loaded.");
          return;
        }
        const data = result.data;
        setErr(null);
        // Poll/manual refresh replaces the complete loaded window atomically.
        // Mutable lifecycle/read state may have changed since the prior cutoff.
        setConversations(data.conversations);
        setNextCursor(data.nextCursor);
        setSnapshotAt(data.snapshotAt);
        setTotals({
          total: data.totalConversations,
          unread: data.unreadTotal,
          unknown: data.unknownTotal,
          active: data.activeTotal,
          snoozed: data.snoozedTotal,
          archived: data.archivedTotal,
        });
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (
          !controller.signal.aborted &&
          generation === listGenerationRef.current
        ) {
          setErr(describeSmsFailure(error, "The SMS inbox is unavailable."));
        }
      } finally {
        if (
          showBusy &&
          !controller.signal.aborted &&
          generation === listGenerationRef.current
        ) {
          setRefreshing(false);
        }
      }
    },
    [active, filter, online, sort, status],
  );

  const loadConversations = useCallback(
    async (force = false): Promise<void> => {
      if (!force && refreshBusyRef.current) return;
      const owner = ++refreshOwnerRef.current;
      refreshBusyRef.current = true;
      try {
        await fetchFirstPage(true);
      } finally {
        if (owner === refreshOwnerRef.current) refreshBusyRef.current = false;
      }
    },
    [fetchFirstPage],
  );
  useEffect(() => {
    if (!active) {
      listAbortRef.current?.abort();
      searchAbortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
      listGenerationRef.current += 1;
      searchSeqRef.current += 1;
      setRefreshing(false);
      return;
    }
    if (!online) {
      listAbortRef.current?.abort();
      searchAbortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
      listGenerationRef.current += 1;
      searchSeqRef.current += 1;
      setRefreshing(false);
      return;
    }
    setConversations(null);
    setNextCursor(undefined);
    setSnapshotAt(null);
    setErr(null);
    setLastRefreshedAt(null);
    void loadConversations(true);
  }, [active, listIdentity, loadConversations, online]);

  useEffect(() => {
    if (!active || !online || search.trim().length >= 2) return;
    const timer = window.setInterval(
      () => void fetchFirstPage(false),
      AUTO_REFRESH_CONVERSATIONS_MS,
    );
    return () => window.clearInterval(timer);
  }, [active, fetchFirstPage, online, search]);

  useEffect(() => {
    if (!active || !online) {
      searchAbortRef.current?.abort();
      searchSeqRef.current += 1;
      setSearching(false);
      setSearchResults(null);
      setSearchResultQuery(null);
      setSearchNextCursor(undefined);
      setSearchSnapshotAt(null);
      return;
    }
    const query = search.trim();
    if (query.length < 2) {
      searchAbortRef.current?.abort();
      searchSeqRef.current += 1;
      setSearchResults(null);
      setSearchResultQuery(null);
      setSearchNextCursor(undefined);
      setSearchSnapshotAt(null);
      setSearching(false);
      setSearchErr(null);
      return;
    }
    searchAbortRef.current?.abort();
    const seq = ++searchSeqRef.current;
    setSearching(true);
    setSearchResults(null);
    setSearchResultQuery(query);
    setSearchNextCursor(undefined);
    setSearchSnapshotAt(null);
    setSearchErr(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        searchAbortRef.current?.abort();
        const controller = new AbortController();
        searchAbortRef.current = controller;
        try {
          const result = await api.searchSMSConversations(
            { query, limit: 100 },
            { signal: controller.signal },
          );
          if (controller.signal.aborted || seq !== searchSeqRef.current) return;
          if (result.error) {
            setSearchResults(null);
            setSearchErr("Server search could not complete.");
          } else {
            setSearchResults(result.data.conversations);
            setSearchNextCursor(result.data.nextCursor);
            setSearchSnapshotAt(result.data.snapshotAt);
          }
        } catch (error) {
          if (!controller.signal.aborted && seq === searchSeqRef.current) {
            setSearchResults(null);
            setSearchErr(
              describeSmsFailure(error, "Server search could not complete."),
            );
          }
        } finally {
          if (!controller.signal.aborted && seq === searchSeqRef.current) {
            setSearching(false);
          }
        }
      })();
    }, 280);
    return () => window.clearTimeout(timer);
  }, [active, online, search]);

  const filtered = useMemo(() => {
    if (!conversations) return null;
    const query = search.trim().toLowerCase();
    if (!query) return conversations;
    if (
      search.trim().length >= 2 &&
      searchResultQuery === search.trim() &&
      searchResults !== null
    ) {
      return searchResults;
    }
    if (searching) return null;
    if (!searchErr && online) return null;
    return conversations.filter(
      (row) =>
        row.phoneE164.toLowerCase().includes(query) ||
        (row.subscriberEmail ?? "").toLowerCase().includes(query) ||
        row.lastMessagePreview.toLowerCase().includes(query),
    );
  }, [
    conversations,
    online,
    search,
    searchErr,
    searchResultQuery,
    searching,
    searchResults,
  ]);

  const onLoadMore = async (): Promise<void> => {
    if (loadMoreRef.current) return;
    const query = search.trim();
    const isServerSearch =
      query.length >= 2 &&
      searchResultQuery === query &&
      searchResults !== null;
    const cursor = isServerSearch ? searchNextCursor : nextCursor;
    const ownerSnapshot = isServerSearch ? searchSnapshotAt : snapshotAt;
    if (!cursor || !ownerSnapshot) return;
    const listGeneration = listGenerationRef.current;
    const searchGeneration = searchSeqRef.current;
    const ownerIdentity = listIdentity;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    loadMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = isServerSearch
        ? await api.searchSMSConversations(
            { query, cursor, limit: 100 },
            { signal: controller.signal },
          )
        : await api.listSMSConversations({
            limit: 100,
            filter,
            sort,
            status,
            cursor,
            signal: controller.signal,
          });
      if (
        controller.signal.aborted ||
        listGeneration !== listGenerationRef.current ||
        ownerIdentity !== listIdentity ||
        (isServerSearch &&
          (searchGeneration !== searchSeqRef.current ||
            query !== search.trim()))
      ) {
        return;
      }
      if (result.error) {
        if (isServerSearch) setSearchErr("More search results could not load.");
        else setErr("More conversations could not load.");
        return;
      }
      if (result.data.snapshotAt !== ownerSnapshot) {
        if (isServerSearch) {
          setSearchNextCursor(undefined);
          setSearchErr(
            "The search window changed before the next page loaded. Refresh the search.",
          );
        } else {
          setNextCursor(undefined);
          setErr(
            "The inbox window changed before the next page loaded. Refresh the inbox.",
          );
        }
        return;
      }
      const append = (
        previous: SMSConversationSummary[] | null,
      ): SMSConversationSummary[] => {
        const existing = new Set((previous ?? []).map((row) => row.phoneE164));
        const next = result.data.conversations.filter(
          (row) => !existing.has(row.phoneE164),
        );
        return [...(previous ?? []), ...next];
      };
      if (isServerSearch) {
        setSearchErr(null);
        setSearchResults(append);
        setSearchNextCursor(result.data.nextCursor);
      } else {
        setErr(null);
        setConversations(append);
        setNextCursor(result.data.nextCursor);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setErr(describeSmsFailure(error, "More conversations could not load."));
      }
    } finally {
      if (loadMoreAbortRef.current === controller) {
        loadMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  const refreshSearch = useCallback(async (): Promise<void> => {
    const query = search.trim();
    if (query.length < 2 || !online) return;
    const seq = ++searchSeqRef.current;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setSearchNextCursor(undefined);
    setSearchSnapshotAt(null);
    try {
      const result = await api.searchSMSConversations(
        { query, limit: 100 },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || seq !== searchSeqRef.current) return;
      if (result.error) setSearchErr("Server search could not refresh.");
      else {
        setSearchErr(null);
        setSearchResultQuery(query);
        setSearchResults(result.data.conversations);
        setSearchNextCursor(result.data.nextCursor);
        setSearchSnapshotAt(result.data.snapshotAt);
      }
    } catch (error) {
      if (!controller.signal.aborted && seq === searchSeqRef.current) {
        setSearchErr(
          describeSmsFailure(error, "Server search could not refresh."),
        );
      }
    } finally {
      if (!controller.signal.aborted && seq === searchSeqRef.current) {
        setSearching(false);
      }
    }
  }, [online, search]);

  useEffect(
    () => () => {
      listAbortRef.current?.abort();
      searchAbortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
    },
    [],
  );

  const insertionCutoffAt =
    search.trim().length >= 2 &&
    searchResultQuery === search.trim() &&
    searchResults !== null
      ? searchSnapshotAt
      : snapshotAt;

  return {
    conversations,
    filtered,
    hasMore:
      search.trim().length >= 2 &&
      searchResultQuery === search.trim() &&
      searchResults !== null
        ? Boolean(searchNextCursor)
        : Boolean(nextCursor),
    snapshotAt,
    insertionCutoffAt,
    loadingMore,
    refreshing,
    totals,
    filter,
    setFilter,
    sort,
    setSort,
    status,
    setStatus,
    search,
    setSearch,
    searchResults,
    setSearchResults,
    searching,
    searchErr,
    err,
    online,
    lastRefreshedAt,
    loadConversations,
    refreshSearch,
    onLoadMore,
  };
}

type SMSConversationFeed = ReturnType<typeof useSMSConversationFeed>;
type SMSMutationResult = Promise<{ error?: { message: string } | null }>;

function useSMSInboxMutations(
  feed: SMSConversationFeed,
  selectedPhone: string | null,
  setSelectedPhone: (phone: string | null) => void,
) {
  const [composeOpen, setComposeOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rowBusyPhone, setRowBusyPhone] = useState<string | null>(null);
  const bulkBusyRef = useRef(false);
  const rowBusyRef = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.key === "Escape" &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        selected.size > 0 &&
        !bulkBusyRef.current
      ) {
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const refreshAfterRowAction = useCallback(async (): Promise<void> => {
    await Promise.all([feed.loadConversations(true), feed.refreshSearch()]);
  }, [feed.loadConversations, feed.refreshSearch]);

  const runRowAction = useCallback(
    async ({
      phone,
      label,
      success,
      action,
    }: {
      phone: string;
      label: string;
      success?: string;
      action: () => SMSMutationResult;
    }): Promise<void> => {
      if (rowBusyRef.current) return;
      rowBusyRef.current = true;
      setRowBusyPhone(phone);
      try {
        const result = await action();
        if (result.error) {
          toast.error(`${label} failed: ${result.error.message}`);
          return;
        }
        if (success) toast.success(success);
        await refreshAfterRowAction();
      } catch (error) {
        toast.error(
          `${label} failed: ${describeSmsFailure(error, "request unavailable")}`,
        );
      } finally {
        rowBusyRef.current = false;
        setRowBusyPhone(null);
      }
    },
    [refreshAfterRowAction],
  );

  const onBulkAction = async (action: "archive" | "snooze"): Promise<void> => {
    const phones = Array.from(selected);
    if (phones.length === 0 || bulkBusyRef.current) return;
    bulkBusyRef.current = true;
    setBulkBusy(true);
    const currentRows = new Map(
      (feed.filtered ?? feed.conversations ?? []).map((row) => [
        row.phoneE164,
        row,
      ]),
    );
    if (phones.some((phone) => !currentRows.has(phone))) {
      toast.error("The selected lifecycle inventory changed. Refresh before retrying.");
      setSelected(new Set());
      return;
    }
    const input: Parameters<typeof api.bulkSMSConversationAction>[0] = {
      conversations: phones.map((phoneE164) => ({
        phoneE164,
        expectedUpdatedAt:
          currentRows.get(phoneE164)?.stateUpdatedAt ?? null,
      })),
      action,
    };
    if (action === "snooze") {
      input.until = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
    }
    try {
      const result = await api.bulkSMSConversationAction(input);
      if (result.error) {
        toast.error(`Bulk ${action} failed: ${result.error.message}`);
        return;
      }
      const applied = result.data?.applied;
      if (
        typeof applied !== "number" ||
        !Number.isSafeInteger(applied) ||
        applied < 0 ||
        applied > phones.length
      ) {
        toast.error(
          `Bulk ${action} returned no trustworthy applied-count receipt. Refresh before retrying.`,
        );
        await feed.loadConversations(true);
        return;
      }
      toast.success(`Applied to ${applied.toLocaleString()}`);
      setSelected(new Set());
      feed.setSearchResults(null);
      feed.setSearch("");
      await feed.loadConversations(true);
    } catch (error) {
      toast.error(
        `Bulk ${action} failed: ${describeSmsFailure(error, "request unavailable")}`,
      );
    } finally {
      bulkBusyRef.current = false;
      setBulkBusy(false);
    }
  };

  return {
    selectedPhone,
    setSelectedPhone,
    composeOpen,
    setComposeOpen,
    selected,
    setSelected,
    bulkBusy,
    rowBusyPhone,
    onBulkAction,
    onRowSnooze: (conversation: SMSConversationSummary) =>
      runRowAction({
        phone: conversation.phoneE164,
        label: "Snooze",
        success: "Snoozed for 1 hour",
        action: () =>
          api.snoozeSMSConversation(
            conversation.phoneE164,
            new Date(Date.now() + 60 * 60_000).toISOString(),
            conversation.stateUpdatedAt ?? null,
          ),
      }),
    onRowArchive: (conversation: SMSConversationSummary) =>
      runRowAction({
        phone: conversation.phoneE164,
        label: "Archive",
        success: "Archived",
        action: () =>
          api.archiveSMSConversation(
            conversation.phoneE164,
            conversation.stateUpdatedAt ?? null,
          ),
      }),
  };
}

type SMSInboxMutations = ReturnType<typeof useSMSInboxMutations>;

interface SMSExportTruth {
  limit: number;
  asOf: string;
  rowCount: number;
  truncated: boolean;
}

interface SMSPendingExport {
  blob: Blob;
  filename: string;
  truth: SMSExportTruth;
}

export function parseSMSExportTruth(headers: Headers): SMSExportTruth | null {
  const limitRaw = headers.get("X-Postwave-Export-Limit");
  const asOf = headers.get("X-Postwave-Export-As-Of");
  const rowCountRaw = headers.get("X-Postwave-Export-Row-Count");
  const truncatedRaw = headers.get("X-Postwave-Truncated");
  if (!limitRaw || !asOf || !rowCountRaw) return null;
  const limit = Number(limitRaw);
  const rowCount = Number(rowCountRaw);
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    rowCount > limit ||
    !Number.isFinite(Date.parse(asOf)) ||
    (truncatedRaw !== "true" && truncatedRaw !== "false")
  ) {
    return null;
  }
  return { limit, asOf, rowCount, truncated: truncatedRaw === "true" };
}

async function fetchSMSConversationsExport(
  auditReason: string,
  signal?: AbortSignal,
): Promise<SMSPendingExport> {
  const reason = auditReason.trim();
  if (
    reason.length === 0 ||
    reason.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(reason)
  ) {
    throw new Error("Enter a plain-text audit reason of 1–160 characters.");
  }
  const headers: Record<string, string> = {
    Accept: "text/csv",
    "X-Postwave-Audit-Reason": reason,
  };
  const key = getApiKey();
  if (key) {
    headers.Authorization = `Bearer ${key.startsWith("pw_") ? key : `pw_${key}`}`;
  }
  const response = await nativeAwareFetch(
    `${getApiUrl()}/api/v1/sms/conversations.csv`,
    {
      method: "GET",
      headers,
      credentials: "include",
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok)
    throw new Error(`Export request failed (${response.status}).`);
  const truth = parseSMSExportTruth(response.headers);
  if (!truth) {
    throw new Error(
      "The export response omitted or contradicted its row limit, row count, or as-of metadata.",
    );
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const candidate = /filename="([A-Za-z0-9._-]{1,128})"/u.exec(
    disposition,
  )?.[1];
  return {
    blob: await response.blob(),
    filename:
      candidate ??
      `sms-conversations-${new Date(truth.asOf).toISOString().slice(0, 10)}.csv`,
    truth,
  };
}

export function SMSInbox(): ReactElement {
  const canAdmin = useCanAdmin();
  return canAdmin ? <SMSInboxAdminRoute /> : <SMSInboxAccessBoundary />;
}

function SMSInboxAdminRoute(): ReactElement {
  const me = useMe();
  const contextEpoch = useSyncExternalStore(
    onContextEpochObserved,
    readContextEpoch,
    readContextEpoch,
  );
  const intentScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const identityScope = `${
    intentScope ?? "unresolved"
  }:${me?.effectiveRole ?? "unknown"}:${contextEpoch ?? "unobserved"}`;
  return (
    <SMSInboxIdentityRoute key={identityScope} intentScope={intentScope} />
  );
}

function SMSInboxIdentityRoute({
  intentScope,
}: {
  intentScope: string | null;
}): ReactElement {
  const snapshot = useDesktopRouteSnapshot();
  const route = snapshot.route;
  const routeView = useMemo(() => smsInboxRouteView(route), [route]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const updateRoute = useCallback(
    (
      patch: Parameters<typeof routeWithSMSInboxView>[1],
      options: { replace?: boolean } = {},
    ): void => {
      navigateDesktopRoute(routeWithSMSInboxView(route, patch), {
        replace: options.replace,
        source: "navigation",
      });
    },
    [route],
  );

  useEffect(() => {
    if (!routeView.needsNormalization) return;
    navigateDesktopRoute(routeWithSMSInboxView(route, routeView), {
      replace: true,
      source: "navigation",
    });
  }, [route, routeView]);

  useEffect(() => {
    if (snapshot.source !== "history" && snapshot.source !== "identity") {
      return;
    }
    setSelectedPhone(null);
    setSearch("");
  }, [snapshot.revision, snapshot.source]);

  useEffect(() => {
    if (routeView.mode === "inbox") return;
    setSelectedPhone(null);
    setSearch("");
  }, [routeView.mode]);

  const feed = useSMSConversationFeed({
    enabled: routeView.mode === "inbox",
    filter: routeView.filter,
    onFilter: (filter) => updateRoute({ filter }),
    onSearch: setSearch,
    onSort: (sort) => updateRoute({ sort }),
    onStatus: (status) => updateRoute({ status }),
    search,
    sort: routeView.sort,
    status: routeView.status,
  });
  useEffect(() => {
    if (
      !selectedPhone ||
      routeView.mode !== "inbox" ||
      feed.filtered === null
    ) {
      return;
    }
    if (!feed.filtered.some((row) => row.phoneE164 === selectedPhone)) {
      setSelectedPhone(null);
    }
  }, [feed.filtered, routeView.mode, selectedPhone]);
  const mutations = useSMSInboxMutations(feed, selectedPhone, setSelectedPhone);
  return (
    <SMSInboxPageView
      feed={feed}
      mode={routeView.mode}
      mutations={mutations}
      onModeChange={(mode) => updateRoute({ mode })}
      broadcastProgressId={routeView.broadcastProgressId}
      onBroadcastProgressChange={(broadcastProgressId) =>
        updateRoute({ broadcastProgressId }, { replace: false })
      }
      intentScope={intentScope}
    />
  );
}

function SMSInboxAccessBoundary(): ReactElement {
  const route = useDesktopRoute();
  useEffect(() => {
    if (
      route.section !== "smsInbox" ||
      JSON.stringify(route) === JSON.stringify(safeSMSInboxBoundaryRoute())
    ) {
      return;
    }
    navigateDesktopRoute(safeSMSInboxBoundaryRoute(), {
      replace: true,
      source: "navigation",
    });
  }, [route]);
  return (
    <div className="page sms-inbox-page sms-inbox-access-page">
      <PageHeader
        eyebrow="Messaging"
        title="SMS Inbox"
        subtitle="Two-way SMS conversations and broadcast delivery records are restricted to workspace owners and administrators."
      />
      <section className="sms-inbox-access-boundary" role="note">
        <span className="sms-access-lock" aria-hidden="true">
          ◇
        </span>
        <div>
          <span className="sms-kicker">Admin-scoped messaging</span>
          <h2>Your current role cannot open SMS conversations</h2>
          <p>
            This surface can reveal phone numbers, message bodies, consent
            posture, and delivery history. Ask a workspace owner to grant an
            admin role if operating SMS is part of your responsibility.
          </p>
        </div>
        <ul aria-label="Access boundary guarantees">
          <li>Protected conversation requests are not started for this role</li>
          <li>Prior thread selection and filters are removed from the route</li>
          <li>No message body or recipient detail remains mounted</li>
        </ul>
      </section>
    </div>
  );
}

function SMSReplyRecoveryHolds({
  identityScope,
}: {
  identityScope: string | null;
}): ReactElement | null {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; intents: SMSReplyRecoverySummary[] }
    | { status: "identity-unresolved" }
    | { status: "vault-unavailable" }
    | { status: "vault-corrupt" }
  >({ status: "loading" });

  const refresh = useCallback(async (): Promise<void> => {
    setState(await smsReplyRecovery.list(identityScope));
  }, [identityScope]);

  useEffect(() => {
    let active = true;
    void smsReplyRecovery.list(identityScope).then((result) => {
      if (active) setState(result);
    });
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener(SMS_REPLY_RECOVERY_CHANGE_EVENT, onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(SMS_REPLY_RECOVERY_CHANGE_EVENT, onFocus);
    };
  }, [identityScope, refresh]);

  if (state.status === "loading" || state.status === "identity-unresolved") {
    return null;
  }
  if (
    state.status === "vault-unavailable" ||
    state.status === "vault-corrupt"
  ) {
    return (
      <Notice tone="danger" announcement="assertive">
        The encrypted reply-intent safeguard could not be verified. Live SMS
        submission remains unavailable; do not recreate or resend a prior draft.
      </Notice>
    );
  }
  if (state.intents.length === 0) return null;

  return (
    <Notice tone="warning" announcement="assertive">
      <div className="sms-recovery-holds">
        <div>
          <strong>Unresolved SMS send safeguard</strong>
          <p>
            These encrypted checkpoints survived a reload or have an unknown
            response. No message body is stored here. They remain held until an
            authoritative terminal server result settles the original intent.
          </p>
        </div>
        <ul aria-label="Unresolved SMS reply intents">
          {state.intents.map((intent) => (
            <li key={intent.signature}>
              <span>
                <bdi className="mono" dir="ltr">
                  {intent.phone}
                </bdi>{" "}
                ·{" "}
                {intent.state === "request-identity-conflict"
                  ? "key/request identity conflict"
                  : intent.state === "another-intent-pending"
                    ? "blocked by another unresolved intent"
                    : intent.state === "unknown"
                      ? "outcome unknown"
                      : "recovered after restart"}
                {" · checkpointed "}
                {new Date(intent.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Notice>
  );
}

function SMSInboxPageView({
  feed,
  mutations,
  mode,
  onModeChange,
  broadcastProgressId,
  onBroadcastProgressChange,
  intentScope,
}: {
  feed: SMSConversationFeed;
  mutations: SMSInboxMutations;
  mode: SMSInboxMode;
  onModeChange: (mode: SMSInboxMode) => void;
  broadcastProgressId: string | null;
  onBroadcastProgressChange: (id: string | null) => void;
  intentScope: string | null;
}): ReactElement {
  const tabs = useTabsInteraction({
    activation: "manual",
    value: mode,
    items: SMS_PAGE_TABS,
    onChange: onModeChange,
  });
  const [, setNowTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportReasonOpen, setExportReasonOpen] = useState(false);
  const [exportReason, setExportReason] = useState("");
  const [pendingExport, setPendingExport] = useState<SMSPendingExport | null>(
    null,
  );
  const exportBusyRef = useRef(false);
  const exportAbortRef = useRef<AbortController | null>(null);
  const threadRegionRef = useRef<HTMLElement | null>(null);
  const documentVisible = useSMSDocumentVisible();
  useEffect(() => {
    if (!documentVisible) return;
    const timer = window.setInterval(
      () => setNowTick((value) => value + 1),
      5_000,
    );
    return () => window.clearInterval(timer);
  }, [documentVisible]);
  const refreshAgeLabel = !feed.online
    ? feed.conversations
      ? "Offline · showing last loaded inbox"
      : "Offline · inbox not loaded"
    : feed.err
      ? "Refresh failed"
      : feed.refreshing
        ? "Refreshing…"
        : feed.lastRefreshedAt
          ? `Refreshed ${fmtAge(Date.now() - feed.lastRefreshedAt)}`
          : "Refreshing…";
  const statCells = buildSmsStatCells(
    feed.totals,
    feed.setFilter,
    feed.setStatus,
  );
  const normalizedExportReason = exportReason.trim();
  const selectedConversation = mutations.selectedPhone
    ? (feed.filtered ?? feed.conversations ?? []).find(
        (row) => row.phoneE164 === mutations.selectedPhone,
      ) ?? null
    : null;
  const exportReasonValid =
    normalizedExportReason.length > 0 &&
    normalizedExportReason.length <= 160 &&
    !/[\u0000-\u001f\u007f]/u.test(normalizedExportReason);
  const onRequestExport = async (): Promise<void> => {
    if (exportBusyRef.current || !feed.online) return;
    exportAbortRef.current?.abort();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    exportBusyRef.current = true;
    setExporting(true);
    try {
      const pending = await fetchSMSConversationsExport(
        normalizedExportReason,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPendingExport(pending);
      setExportReasonOpen(false);
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(
          `Couldn't prepare export: ${describeSmsFailure(error, "unknown error")}`,
        );
      }
    } finally {
      if (exportAbortRef.current === controller) {
        exportBusyRef.current = false;
        setExporting(false);
      }
    }
  };

  useEffect(() => {
    if (documentVisible) return;
    exportAbortRef.current?.abort();
    exportBusyRef.current = false;
    setExporting(false);
    setExportReasonOpen(false);
    setPendingExport(null);
  }, [documentVisible]);

  useEffect(
    () => () => {
      exportAbortRef.current?.abort();
      exportBusyRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (!mutations.selectedPhone) return;
    window.requestAnimationFrame(() => threadRegionRef.current?.focus());
  }, [mutations.selectedPhone]);

  return (
    <div className="page sms-inbox-page">
      <SMSInboxHeader
        mode={mode}
        feed={feed}
        mutations={mutations}
        refreshAgeLabel={refreshAgeLabel}
        exporting={exporting}
        onExportCsv={() => setExportReasonOpen(true)}
      />

      <Modal
        open={exportReasonOpen}
        onClose={() => {
          if (!exporting) setExportReasonOpen(false);
        }}
        title="Prepare audited SMS export"
        closeDisabled={exporting}
      >
        <div className="sms-export-reason-form">
          <p>
            This downloads a tenant-wide summary of retained SMS conversation
            records. Current inbox filters and search are not applied.
          </p>
          <label>
            <span>Audit reason</span>
            <textarea
              rows={3}
              maxLength={160}
              value={exportReason}
              onChange={(event) => setExportReason(event.target.value)}
              placeholder="Example: Quarterly support-response review"
              disabled={exporting}
            />
            <span className="muted small">
              Required · {normalizedExportReason.length}/160 characters. This
              reason is recorded with the export audit event.
            </span>
          </label>
        </div>
        <ModalFooter>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={exporting}
            onClick={() => setExportReasonOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!exportReasonValid || exporting || !feed.online}
            onClick={() => void onRequestExport()}
          >
            {exporting ? "Preparing…" : "Review export bounds"}
          </button>
        </ModalFooter>
      </Modal>

      <ConfirmModal
        open={pendingExport !== null}
        title={
          pendingExport
            ? `Save ${pendingExport.truth.rowCount.toLocaleString()}-row SMS export?`
            : "Save SMS export?"
        }
        description={
          pendingExport
            ? `Server export boundary as of ${new Date(pendingExport.truth.asOf).toLocaleString()}. The response cap is ${pendingExport.truth.limit.toLocaleString()} rows. ${pendingExport.truth.truncated ? "The server reports this export is truncated; additional rows are omitted." : "The server did not report truncation."} Current inbox filters and search are not applied.`
            : "Review the server-provided bounds before saving."
        }
        confirmLabel="Save private CSV"
        cancelLabel="Discard prepared export"
        busy={exporting}
        onClose={() => {
          if (!exporting) setPendingExport(null);
        }}
        onConfirm={() => {
          if (!pendingExport || exportBusyRef.current) return;
          exportBusyRef.current = true;
          setExporting(true);
          void saveFile({
            data: pendingExport.blob,
            suggestedName: pendingExport.filename,
            label: "SMS conversations export",
            privacy: "personal",
            mimeType: "text/csv;charset=utf-8",
          })
            .then((saved) => {
              if (!saved.ok) throw new Error(saved.message);
              if (saved.status !== "cancelled") {
                toast.success(
                  `${pendingExport.truth.rowCount.toLocaleString()} rows saved with a server as-of boundary of ${new Date(pendingExport.truth.asOf).toLocaleString()}${pendingExport.truth.truncated ? `; export capped at ${pendingExport.truth.limit.toLocaleString()} rows` : ""}.`,
                );
              }
              setPendingExport(null);
              setExportReason("");
            })
            .catch((error: unknown) => {
              toast.error(
                `Couldn't save export: ${describeSmsFailure(error, "unknown error")}`,
              );
            })
            .finally(() => {
              exportBusyRef.current = false;
              setExporting(false);
            });
        }}
      />

      <div
        ref={tabs.listRef}
        className="tab-bar"
        {...tabs.listProps}
        aria-label="SMS sections"
      >
        <button
          type="button"
          {...tabs.getTabProps("inbox")}
          className={mode === "inbox" ? "tab-button active" : "tab-button"}
        >
          Inbox
          {feed.totals.unread > 0 ? (
            <span className="muted">
              {" "}
              ({feed.totals.unread.toLocaleString()})
            </span>
          ) : null}
        </button>
        <button
          type="button"
          {...tabs.getTabProps("broadcasts")}
          className={mode === "broadcasts" ? "tab-button active" : "tab-button"}
        >
          Broadcasts
        </button>
      </div>

      <section {...tabs.getPanelProps("broadcasts")}>
        {mode === "broadcasts" ? (
          <BroadcastsPanel
            expandedId={broadcastProgressId}
            onExpandedIdChange={onBroadcastProgressChange}
          />
        ) : null}
      </section>

      <NewConversationModal
        intentScope={intentScope}
        open={mutations.composeOpen}
        onClose={() => mutations.setComposeOpen(false)}
        onSent={(phone) => {
          mutations.setComposeOpen(false);
          mutations.setSelectedPhone(phone);
          void feed.loadConversations();
        }}
      />

      <section {...tabs.getPanelProps("inbox")}>
        {mode === "inbox" ? (
          <SMSReplyRecoveryHolds identityScope={intentScope} />
        ) : null}
        {mode === "inbox" && feed.totals.total > 0 ? (
          <StatStrip cells={statCells} />
        ) : null}

        {mode === "inbox" ? (
          <div
            className={`sms-inbox-shell${mutations.selectedPhone ? " has-thread" : ""}`}
          >
            <aside className="sms-inbox-list" aria-label="SMS conversations">
              <div className="sms-inbox-list-heading">
                <div>
                  <span className="sms-kicker">Queue</span>
                  <h2>Conversations</h2>
                </div>
                <span className="sms-polling-state muted small">
                  {feed.online ? "Auto-refresh · 15s" : "Auto-refresh paused"}
                </span>
              </div>
              <StatusChips
                status={feed.status}
                totals={{
                  active: feed.totals.active,
                  snoozed: feed.totals.snoozed,
                  archived: feed.totals.archived,
                  any: feed.totals.total,
                }}
                onChange={feed.setStatus}
              />
              <InboxFilters
                filter={feed.filter}
                sort={feed.sort}
                totals={feed.totals}
                onFilterChange={feed.setFilter}
                onSortChange={feed.setSort}
              />
              <input
                type="search"
                className="sms-inbox-filter"
                aria-label="Search SMS conversations"
                placeholder="Search phone, subscriber, or message text"
                value={feed.search}
                onChange={(e) => feed.setSearch(e.target.value)}
              />
              {feed.insertionCutoffAt ? (
                <p className="muted small sms-inbox-insertion-boundary">
                  Loaded pages use a message-created cutoff of{" "}
                  {new Date(feed.insertionCutoffAt).toLocaleString()}.
                  Lifecycle, unread, and delivery fields can change; late
                  commits at or before the cutoff may differ after refresh.
                </p>
              ) : null}
              {!feed.online ? (
                <Notice
                  tone="warning"
                  announcement="polite"
                  className="sms-inbox-inline-notice"
                >
                  {feed.conversations
                    ? "You’re offline. Showing the last inbox loaded in this window; polling and server search are paused."
                    : "You’re offline. Reconnect to load SMS conversations."}
                </Notice>
              ) : null}
              {feed.err ? (
                <Notice
                  tone="danger"
                  announcement="assertive"
                  className="sms-inbox-inline-notice"
                >
                  {feed.conversations
                    ? "Refresh failed: "
                    : "Couldn't load inbox: "}
                  {feed.err}
                </Notice>
              ) : null}
              {feed.searching ? (
                <div
                  className="muted small sms-inbox-search-state"
                  role="status"
                >
                  Searching…
                </div>
              ) : null}
              {feed.searchErr ? (
                <Notice
                  tone="warning"
                  announcement="polite"
                  className="sms-inbox-inline-notice"
                >
                  Server search failed: {feed.searchErr}. Showing matches from
                  only the conversation rows already loaded in this window; this
                  is not a complete server result.
                </Notice>
              ) : null}
              {!feed.filtered ? (
                <div className="muted sms-inbox-list-state" role="status">
                  {!feed.online
                    ? "Reconnect to load conversations."
                    : feed.err
                      ? "Conversations couldn't be loaded."
                      : "Loading conversations…"}
                </div>
              ) : feed.filtered.length === 0 ? (
                feed.filter !== "all" ||
                feed.status !== "active" ||
                feed.search ? (
                  <div className="muted sms-inbox-list-state" role="status">
                    No conversations match the current filter.
                  </div>
                ) : (
                  <HeroEmptyState
                    tone="blush"
                    eyebrow="Conversations"
                    title="Two-way SMS, threaded."
                    subtitle="Replies surface here after the inbox polls. Delivery pills show the latest status recorded by the SMS provider."
                    imageSrc={HERO.smsInbox}
                    imageAlt="A phone showing teal and grey speech bubbles"
                  />
                )
              ) : (
                <>
                  <div
                    className="visually-hidden"
                    role="status"
                    aria-live="polite"
                  >
                    {feed.filtered.length.toLocaleString()} conversation
                    {feed.filtered.length === 1 ? "" : "s"} shown
                  </div>
                  <ul
                    className="sms-inbox-rows"
                    aria-label="Conversation results"
                  >
                    {feed.filtered.map((c) => {
                      const isChecked = mutations.selected.has(c.phoneE164);
                      return (
                        <li key={c.phoneE164} className="sms-inbox-row-wrapper">
                          <input
                            type="checkbox"
                            className="sms-inbox-row-check"
                            checked={isChecked}
                            onChange={(e) => {
                              const next = new Set(mutations.selected);
                              if (e.target.checked) next.add(c.phoneE164);
                              else next.delete(c.phoneE164);
                              mutations.setSelected(next);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${c.phoneE164}`}
                          />
                          <ConversationRow
                            conversation={c}
                            selected={mutations.selectedPhone === c.phoneE164}
                            onClick={() =>
                              mutations.setSelectedPhone(c.phoneE164)
                            }
                            onSnooze={
                              feed.status !== "archived" &&
                              !mutations.rowBusyPhone
                                ? () => void mutations.onRowSnooze(c)
                                : undefined
                            }
                            onArchive={
                              feed.status !== "archived" &&
                              !mutations.rowBusyPhone
                                ? () => void mutations.onRowArchive(c)
                                : undefined
                            }
                          />
                        </li>
                      );
                    })}
                  </ul>
                  {feed.hasMore ? (
                    <div className="sms-inbox-load-more">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={feed.loadingMore}
                        onClick={() => void feed.onLoadMore()}
                      >
                        {feed.loadingMore ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </aside>
            <main
              ref={threadRegionRef}
              className="sms-inbox-thread"
              aria-label={
                mutations.selectedPhone
                  ? `Conversation with ${mutations.selectedPhone}`
                  : "Conversation detail"
              }
              tabIndex={-1}
            >
              {mutations.selectedPhone ? (
                <ConversationThread
                  key={mutations.selectedPhone}
                  phone={mutations.selectedPhone}
                  stateUpdatedAt={selectedConversation?.stateUpdatedAt ?? null}
                  intentScope={intentScope}
                  onBack={() => mutations.setSelectedPhone(null)}
                  onReplySent={() => void feed.loadConversations()}
                  onLifecycleChange={() => {
                    mutations.setSelectedPhone(null);
                    void feed.loadConversations();
                  }}
                />
              ) : (
                <div className="sms-inbox-empty">
                  <h3>Pick a conversation</h3>
                  <p className="muted">
                    Choose a row to inspect its retained message records,
                    consent context, and reply controls. Opening a thread also
                    attempts to mark it read.
                  </p>
                </div>
              )}
            </main>
          </div>
        ) : null}

        {mode === "inbox" && mutations.bulkBusy ? (
          <div className="sms-bulk-bar" role="status" aria-live="polite">
            Applying the selected conversation action…
          </div>
        ) : mode === "inbox" ? (
          <InboxBulkBar
            count={mutations.selected.size}
            onClear={() => mutations.setSelected(new Set())}
            onArchive={() => void mutations.onBulkAction("archive")}
            onSnooze={() => void mutations.onBulkAction("snooze")}
          />
        ) : null}
      </section>
    </div>
  );
}

function SMSInboxHeader({
  mode,
  feed,
  mutations,
  refreshAgeLabel,
  exporting,
  onExportCsv,
}: {
  mode: SMSInboxMode;
  feed: SMSConversationFeed;
  mutations: SMSInboxMutations;
  refreshAgeLabel: string;
  exporting: boolean;
  onExportCsv: () => void;
}): ReactElement {
  const subtitle =
    mode === "broadcasts"
      ? "Draft and review one-to-many SMS broadcasts. Any later dispatch must pass live consent, suppression, and release-readiness gates."
      : !feed.online
        ? feed.conversations
          ? "Two-way SMS conversations. Offline; showing the last pages loaded in this window."
          : "Two-way SMS conversations. Reconnect to load the inbox."
        : feed.err
          ? feed.conversations
            ? "Two-way SMS conversations. Refresh failed; showing the last loaded inbox."
            : "Two-way SMS conversations. Couldn't load the inbox — try refreshing."
          : feed.conversations === null || feed.lastRefreshedAt === null
            ? "Loading the first two-way SMS conversation page…"
            : feed.totals.unread > 0
              ? `Two-way SMS conversations. ${feed.totals.unread.toLocaleString()} unread waiting on a reply.`
              : "A conversation page is loaded. No unread records are reported in this result; later changes may differ after refresh.";
  return (
    <PageHeader
      eyebrow="Messaging"
      title="SMS Inbox"
      subtitle={subtitle}
      meta={
        mode === "inbox" ? (
          <span className="muted small tabular" aria-live="polite">
            {refreshAgeLabel}
          </span>
        ) : undefined
      }
      actions={
        mode === "inbox"
          ? [
              {
                label: "New conversation",
                onClick: () => mutations.setComposeOpen(true),
                disabled: !feed.online,
                title:
                  "Draft a first outbound SMS; sending remains subject to live dispatch and consent gates",
              },
              {
                label: exporting ? "Exporting…" : "Export CSV",
                onClick: onExportCsv,
                variant: "ghost",
                disabled: exporting || !feed.online,
                title: exporting
                  ? "The CSV export is being prepared"
                  : !feed.online
                    ? "Reconnect before exporting"
                    : "Download the server-produced retained conversation summary; current inbox filters are not applied",
              },
              {
                label: "Refresh",
                onClick: () => void feed.loadConversations(),
                disabled: feed.refreshing || !feed.online,
                title: feed.refreshing
                  ? "The conversation list is already refreshing"
                  : !feed.online
                    ? "Reconnect before refreshing"
                    : "Reload the conversation list now",
              },
            ]
          : []
      }
    />
  );
}
/* ----------------------------------------------------------------------
 * Thread view — owns the messages, context, and reply composer.
 * -------------------------------------------------------------------- */

function ConversationThread(props: {
  phone: string;
  stateUpdatedAt: string | null;
  intentScope: string | null;
  onBack: () => void;
  onReplySent: () => void;
  /** Refined PR 2: called when the snooze / archive / unarchive
   *  buttons mutate lifecycle so the parent list refreshes. */
  onLifecycleChange?: () => void;
}): ReactElement {
  const { phone } = props;
  const [messages, setMessages] = useState<SMSMessage[] | null>(null);
  const [context, setContext] = useState<SMSConversationContext | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextErr, setContextErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [messagesRefreshing, setMessagesRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderErr, setOlderErr] = useState<string | null>(null);
  const [nextMessagesCursor, setNextMessagesCursor] = useState<
    string | undefined
  >();
  const [messagesSnapshotAt, setMessagesSnapshotAt] = useState<string | null>(
    null,
  );
  const [lastMessagesAt, setLastMessagesAt] = useState<number | null>(null);
  const [markReadErr, setMarkReadErr] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [retryTarget, setRetryTarget] = useState<{
    message: SMSMessage;
    listId: string;
  } | null>(null);
  const [retryRecoveryHold, setRetryRecoveryHold] = useState<Extract<
    SMSReplyPrepareResult,
    { status: "held" }
  > | null>(null);
  const [retryReconciliation, setRetryReconciliation] = useState<{
    sourceMessageId: string;
    idempotencyKey: string;
    signature: string;
    intentMessageId?: string;
  } | null>(null);
  const messageSeqRef = useRef(0);
  const contextSeqRef = useRef(0);
  const mutationBusyRef = useRef(false);
  const loadOlderBusyRef = useRef(false);
  const messagesAbortRef = useRef<AbortController | null>(null);
  const olderAbortRef = useRef<AbortController | null>(null);
  const contextAbortRef = useRef<AbortController | null>(null);
  const readAbortRef = useRef<AbortController | null>(null);
  const loadedInboundBoundaryRef = useRef<string[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /**
   * True while the reader is at (or near) the bottom of the thread.
   * The 10s poll must not yank the scroll position while the operator
   * is reading history further up — we only auto-scroll when they're
   * already at the bottom, on first load, or right after they send.
   */
  const nearBottomRef = useRef(true);
  /** One-shot scroll override: first load of a thread + own sends. */
  const forceScrollRef = useRef(true);
  const online = useSMSOnlineStatus();
  const documentVisible = useSMSDocumentVisible();
  const hardenedContext = context as
    | (SMSConversationContext & {
        eligibleLists?: Array<{ id: string; name: string }>;
        suppressed?: boolean;
        consentMixed?: boolean;
        identityAmbiguous?: boolean;
        consentEvidenceSufficient?: boolean;
        replyDispatchAvailable?: boolean;
        replyDispatchUnavailableReason?: string;
      })
    | null;
  const threadEligibleLists = hardenedContext?.eligibleLists ?? [];
  const threadSendLocked =
    contextLoading ||
    contextErr !== null ||
    context === null ||
    hardenedContext?.suppressed === true ||
    hardenedContext?.consentMixed === true ||
    hardenedContext?.identityAmbiguous === true ||
    hardenedContext?.consentEvidenceSufficient !== true ||
    hardenedContext?.replyDispatchAvailable !== true ||
    context?.consentStatus === "opted_out" ||
    threadEligibleLists.length === 0;

  const markLoadedReadBoundary = useCallback(
    async (messageIds = loadedInboundBoundaryRef.current): Promise<void> => {
      if (!online || !documentVisible || messageIds.length === 0) return;
      readAbortRef.current?.abort();
      const controller = new AbortController();
      readAbortRef.current = controller;
      try {
        const response = await api.markSMSConversationRead(phone, messageIds, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setMarkReadErr(Boolean(response.error));
      } catch {
        if (!controller.signal.aborted) setMarkReadErr(true);
      }
    },
    [documentVisible, online, phone],
  );

  const onBodyScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadMessages = useCallback(async () => {
    if (!online || !documentVisible) {
      setMessagesRefreshing(false);
      return;
    }
    messagesAbortRef.current?.abort();
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    messagesAbortRef.current = controller;
    const seq = ++messageSeqRef.current;
    setNextMessagesCursor(undefined);
    setMessagesSnapshotAt(null);
    setOlderErr(null);
    setMessagesRefreshing(true);
    try {
      const res = await api.listSMSConversationMessages(phone, {
        limit: 200,
        signal: controller.signal,
      });
      if (controller.signal.aborted || seq !== messageSeqRef.current) return;
      if (res.error) {
        setErr("The retained message records could not be loaded.");
        return;
      }
      setErr(null);
      setMessages([...res.data.messages].reverse());
      const inboundIds = Array.from(
        new Set(
          res.data.messages
            .filter((message) => message.direction === "inbound")
            .map((message) => message.id),
        ),
      );
      loadedInboundBoundaryRef.current = inboundIds;
      void markLoadedReadBoundary(inboundIds);
      setRetryReconciliation((current) => {
        const terminal =
          current?.intentMessageId &&
          res.data.messages.some((message) => {
            const candidate = message as SMSMessage & {
              dispatch_state?:
                | "reserved"
                | "reconciliation_required"
                | "persisted"
                | "provider_failed";
            };
            return (
              candidate.id === current.intentMessageId &&
              (candidate.dispatch_state === "persisted" ||
                candidate.dispatch_state === "provider_failed")
            );
          });
        if (!current || !terminal) return current;
        void smsReplyRecovery
          .settle(props.intentScope, current.signature)
          .then((cleared) => {
            if (!cleared) {
              setRetryRecoveryHold({
                status: "held",
                signature: current.signature,
                idempotencyKey: current.idempotencyKey,
                reason: "checkpoint-clear-failed",
              });
            }
          });
        return null;
      });
      setNextMessagesCursor(res.data.nextCursor);
      setMessagesSnapshotAt(res.data.snapshotAt);
      setLastMessagesAt(Date.now());
    } catch (error) {
      if (!controller.signal.aborted && seq === messageSeqRef.current) {
        setErr(describeSmsFailure(error, "Messages could not load."));
      }
    } finally {
      if (!controller.signal.aborted && seq === messageSeqRef.current) {
        setMessagesRefreshing(false);
      }
    }
  }, [
    documentVisible,
    markLoadedReadBoundary,
    online,
    phone,
    props.intentScope,
  ]);

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (
      !online ||
      !documentVisible ||
      loadOlderBusyRef.current ||
      !nextMessagesCursor ||
      !messagesSnapshotAt
    ) {
      return;
    }
    const generation = messageSeqRef.current;
    const cursor = nextMessagesCursor;
    const ownerSnapshot = messagesSnapshotAt;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    loadOlderBusyRef.current = true;
    setLoadingOlder(true);
    setOlderErr(null);
    try {
      const res = await api.listSMSConversationMessages(phone, {
        cursor,
        limit: 200,
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== messageSeqRef.current) {
        return;
      }
      if (res.error) {
        setOlderErr("Older retained message records could not be loaded.");
        return;
      }
      if (res.data.snapshotAt !== ownerSnapshot) {
        setNextMessagesCursor(undefined);
        setOlderErr(
          "The message insertion window changed. Refresh before loading older records.",
        );
        return;
      }
      setMessages((previous) => {
        const existing = new Set((previous ?? []).map((message) => message.id));
        const older = [...res.data.messages]
          .reverse()
          .filter((message) => !existing.has(message.id));
        return [...older, ...(previous ?? [])];
      });
      const olderInboundIds = Array.from(
        new Set(
          res.data.messages
            .filter((message) => message.direction === "inbound")
            .map((message) => message.id),
        ),
      );
      if (olderInboundIds.length > 0)
        void markLoadedReadBoundary(olderInboundIds);
      setNextMessagesCursor(res.data.nextCursor);
    } catch {
      if (!controller.signal.aborted && generation === messageSeqRef.current) {
        setOlderErr("Older retained message records could not be loaded.");
      }
    } finally {
      if (olderAbortRef.current === controller) {
        loadOlderBusyRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [
    documentVisible,
    markLoadedReadBoundary,
    messagesSnapshotAt,
    nextMessagesCursor,
    online,
    phone,
  ]);

  const loadContext = useCallback(async () => {
    if (!online || !documentVisible) return;
    contextAbortRef.current?.abort();
    const controller = new AbortController();
    contextAbortRef.current = controller;
    const seq = ++contextSeqRef.current;
    setContextLoading(true);
    setContextErr(null);
    try {
      const res = await api.getSMSConversationContext(phone, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || seq !== contextSeqRef.current) return;
      if (res.error) {
        setContext(null);
        setContextErr(res.error.message);
        return;
      }
      setContext(res.data ?? null);
    } catch (error) {
      if (!controller.signal.aborted && seq === contextSeqRef.current) {
        setContext(null);
        setContextErr(
          describeSmsFailure(error, "Conversation context could not load."),
        );
      }
    } finally {
      if (!controller.signal.aborted && seq === contextSeqRef.current) {
        setContextLoading(false);
      }
    }
  }, [documentVisible, online, phone]);

  // Clear recipient-owned state only when the recipient changes. Going
  // Offline retains only the last successfully decoded pages in this window.
  useEffect(() => {
    messageSeqRef.current += 1;
    contextSeqRef.current += 1;
    messagesAbortRef.current?.abort();
    olderAbortRef.current?.abort();
    contextAbortRef.current?.abort();
    readAbortRef.current?.abort();
    loadedInboundBoundaryRef.current = [];
    setMessages(null);
    setContext(null);
    setErr(null);
    setOlderErr(null);
    setContextErr(null);
    setMarkReadErr(false);
    setRetryReconciliation(null);
    setRetryRecoveryHold(null);
    setLastMessagesAt(null);
    setNextMessagesCursor(undefined);
    setMessagesSnapshotAt(null);
    forceScrollRef.current = true;
    nearBottomRef.current = true;
  }, [phone]);

  // Load first, then mark only the decoded inbound ids from that page.
  useEffect(() => {
    if (!online || !documentVisible) {
      messagesAbortRef.current?.abort();
      olderAbortRef.current?.abort();
      contextAbortRef.current?.abort();
      readAbortRef.current?.abort();
      setMessagesRefreshing(false);
      setContextLoading(false);
      return;
    }
    void loadMessages();
    void loadContext();
  }, [documentVisible, online, phone, loadMessages, loadContext]);

  useEffect(
    () => () => {
      messagesAbortRef.current?.abort();
      olderAbortRef.current?.abort();
      contextAbortRef.current?.abort();
      readAbortRef.current?.abort();
    },
    [],
  );

  // Auto-scroll to bottom when messages refresh — but only when the
  // reader is already at/near the bottom (or on first load / own
  // send). The 10s poll must not hijack the scroll position while the
  // operator reads older history.
  useEffect(() => {
    if (!messages) return;
    if (bodyRef.current && (forceScrollRef.current || nearBottomRef.current)) {
      forceScrollRef.current = false;
      bodyRef.current.scrollTo({
        top: bodyRef.current.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }
  }, [messages]);

  // Live refresh — every 10s while the thread is open.
  useEffect(() => {
    if (!online || !documentVisible) return;
    const t = window.setInterval(
      () => void loadMessages(),
      AUTO_REFRESH_THREAD_MS,
    );
    return () => window.clearInterval(t);
  }, [documentVisible, loadMessages, online]);

  // Refined PR 1: failed-message retry. We re-POST through the same
  // reply endpoint with the same body + sender; the server records a
  // brand-new sms_messages row (we don't mutate the failed one) so
  // there's no row-level race with the provider webhook handler.
  // Pull onReplySent off props at render time so the useCallback below
  // doesn't have to list `props` as a dep — `props` is a new reference
  // on every render, which would rebuild this callback every time and
  // invalidate any child memoization keyed off it.
  const { onReplySent } = props;
  const onRetry = useCallback(
    async (target: NonNullable<typeof retryTarget>) => {
      if (mutationBusyRef.current || !online) return;
      const m = target.message;
      if (!target.listId) return;
      if (!m.sender_profile_id) {
        toast.error("Can't retry — original sender is no longer available");
        return;
      }
      mutationBusyRef.current = true;
      setLifecycleBusy(true);
      const request: SMSReplyRequest = {
        sender_profile_id: m.sender_profile_id,
        body: m.body,
        list_id: target.listId,
        ...(m.media_url ? { media_url: m.media_url } : {}),
      };
      let intent: Extract<SMSReplyPrepareResult, { status: "ready" }> | null =
        null;
      try {
        const prepared = await smsReplyRecovery.prepare(props.intentScope, {
          phone,
          request,
        });
        if (prepared.status === "held") {
          setRetryRecoveryHold(prepared);
          toast.error(
            "This exact retry intent is already checkpointed without a proven server retention boundary. No replay request was made.",
          );
          return;
        }
        intent = prepared;
        setRetryRecoveryHold(null);
        const res = await api.replySMSConversation(
          phone,
          request,
          intent.idempotencyKey,
        );
        if (res.error) {
          const uncertainty = classifySMSReplyUncertainty(res.error);
          if (uncertainty) {
            const checkpointed =
              uncertainty === "request-identity-conflict"
                ? await smsReplyRecovery.markRequestIdentityConflict(
                    props.intentScope,
                    intent.signature,
                  )
                : uncertainty === "another-intent-pending"
                  ? await smsReplyRecovery.markAnotherIntentPending(
                      props.intentScope,
                      intent.signature,
                    )
                  : await smsReplyRecovery.markUnknown(
                      props.intentScope,
                      intent.signature,
                    );
            if (!checkpointed) {
              setRetryRecoveryHold({
                status: "held",
                signature: intent.signature,
                idempotencyKey: intent.idempotencyKey,
                reason: "checkpoint-update-failed",
              });
            } else if (uncertainty !== "outcome-unknown") {
              setRetryRecoveryHold({
                status: "held",
                signature: intent.signature,
                idempotencyKey: intent.idempotencyKey,
                reason: uncertainty,
              });
            }
            if (uncertainty === "outcome-unknown") {
              setRetryReconciliation({
                sourceMessageId: m.id,
                idempotencyKey: intent.idempotencyKey,
                signature: intent.signature,
              });
            }
            if (uncertainty === "outcome-unknown") setRetryTarget(null);
            toast.error({
              message:
                uncertainty === "request-identity-conflict"
                  ? "Retry intent identity conflict"
                  : uncertainty === "another-intent-pending"
                    ? "Another reply intent is still pending"
                    : "Retry outcome is being reconciled",
              detail: smsReplyUncertaintyCopy(uncertainty),
            });
            return;
          }
          const cleared = await smsReplyRecovery.settle(
            props.intentScope,
            intent.signature,
          );
          if (cleared) setRetryTarget(null);
          else {
            setRetryRecoveryHold({
              status: "held",
              signature: intent.signature,
              idempotencyKey: intent.idempotencyKey,
              reason: "checkpoint-clear-failed",
            });
          }
          toast.error(
            res.error.code === "sms_reply_dispatch_release_held"
              ? "Retry dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider send was attempted."
              : res.error.code === "sms_financial_reservation_unavailable"
                ? "Retry was held because a durable financial reservation could not be established. No provider send was attempted."
                : "Retry was not accepted. No persisted/provider receipt was returned.",
          );
          return;
        }
        if (res.data.disposition === "reconciliation_required") {
          const checkpointed = await smsReplyRecovery.markUnknown(
            props.intentScope,
            intent.signature,
          );
          if (!checkpointed) {
            setRetryRecoveryHold({
              status: "held",
              signature: intent.signature,
              idempotencyKey: intent.idempotencyKey,
              reason: "checkpoint-update-failed",
            });
          }
          setRetryReconciliation({
            sourceMessageId: m.id,
            idempotencyKey: intent.idempotencyKey,
            signature: intent.signature,
            intentMessageId: res.data.intentMessageId,
          });
          setRetryTarget(null);
          toast.error({
            message: "Retry outcome is being reconciled",
            detail: smsReplyReconciliationCopy(),
          });
          return;
        }
        const cleared = await smsReplyRecovery.settle(
          props.intentScope,
          intent.signature,
        );
        if (!cleared) {
          setRetryRecoveryHold({
            status: "held",
            signature: intent.signature,
            idempotencyKey: intent.idempotencyKey,
            reason: "checkpoint-clear-failed",
          });
          toast.error(
            "Retry persisted, but its encrypted local checkpoint could not be cleared. Do not retry again.",
          );
          return;
        }
        toast.success("Retry persisted with a provider receipt");
        setRetryTarget(null);
        forceScrollRef.current = true;
        void loadMessages();
        onReplySent();
      } catch {
        if (intent) {
          const checkpointed = await smsReplyRecovery.markUnknown(
            props.intentScope,
            intent.signature,
          );
          if (!checkpointed) {
            setRetryRecoveryHold({
              status: "held",
              signature: intent.signature,
              idempotencyKey: intent.idempotencyKey,
              reason: "checkpoint-update-failed",
            });
          }
          setRetryReconciliation({
            sourceMessageId: m.id,
            idempotencyKey: intent.idempotencyKey,
            signature: intent.signature,
          });
          setRetryTarget(null);
          toast.error({
            message: "Retry outcome is unknown",
            detail: smsReplyReconciliationCopy(),
          });
        } else {
          setRetryRecoveryHold({ status: "held", reason: "vault-unavailable" });
          toast.error(
            "The encrypted retry checkpoint could not be prepared. No send request was made.",
          );
        }
      } finally {
        mutationBusyRef.current = false;
        setLifecycleBusy(false);
      }
    },
    [phone, loadMessages, onReplySent, online, props.intentScope],
  );

  // Refined PR 2: thread-level lifecycle actions. Each fires the
  // corresponding API + bubbles the change to the parent list so the
  // row disappears/reappears in the right bucket.
  const onSnooze = async (until: Date): Promise<void> => {
    if (mutationBusyRef.current || !online) return;
    mutationBusyRef.current = true;
    setLifecycleBusy(true);
    try {
      const res = await api.snoozeSMSConversation(
        phone,
        until.toISOString(),
        props.stateUpdatedAt,
      );
      if (res.error) {
        toast.error(
          "The conversation could not be snoozed. Refresh and retry.",
        );
        return;
      }
      toast.success(`Snoozed until ${until.toLocaleString()}`);
      props.onLifecycleChange?.();
    } catch {
      toast.error(
        "The conversation could not be snoozed. Check the connection and retry.",
      );
    } finally {
      mutationBusyRef.current = false;
      setLifecycleBusy(false);
    }
  };
  const onArchive = async (): Promise<void> => {
    if (mutationBusyRef.current || !online) return;
    mutationBusyRef.current = true;
    setLifecycleBusy(true);
    try {
      const res = await api.archiveSMSConversation(
        phone,
        props.stateUpdatedAt,
      );
      if (res.error) {
        toast.error(
          "The conversation could not be archived. Refresh and retry.",
        );
        return;
      }
      setArchiveConfirmOpen(false);
      toast.success("Conversation archived");
      props.onLifecycleChange?.();
    } catch {
      toast.error(
        "The conversation could not be archived. Check the connection and retry.",
      );
    } finally {
      mutationBusyRef.current = false;
      setLifecycleBusy(false);
    }
  };

  // Refined PR 3: composer body lifted so the QuickReplyPicker can
  // fill it. We pass body+setBody into ReplyComposer.
  const [composerBody, setComposerBody] = useState("");
  const [composerSourceReplyId, setComposerSourceReplyId] = useState<
    string | null
  >(null);
  // Reset composer when phone changes (defence-in-depth — the
  // composer also resets internally).
  useEffect(() => {
    setComposerBody("");
    setComposerSourceReplyId(null);
  }, [phone]);

  return (
    <div className="sms-thread">
      <div className="sms-thread-mobile-nav">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={props.onBack}
        >
          ← Conversations
        </button>
        <span className="muted small">
          {online
            ? messagesRefreshing
              ? "Refreshing messages…"
              : lastMessagesAt
                ? `Updated ${fmtAge(Date.now() - lastMessagesAt)}`
                : "Loading messages…"
            : "Offline · polling paused"}
        </span>
      </div>
      <div className="sms-thread-head-row">
        <ThreadHeader
          phone={phone}
          context={context}
          loading={contextLoading}
        />
        <div className="sms-thread-actions">
          <SnoozePicker
            disabled={lifecycleBusy || !online}
            onPick={(d) => void onSnooze(d)}
          />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setArchiveConfirmOpen(true)}
            disabled={lifecycleBusy || !online}
            aria-label="Archive conversation (move to the Archived list)"
          >
            Archive
          </button>
        </div>
      </div>
      {contextErr ? (
        <Notice tone="warning" announcement="polite">
          Subscriber context unavailable: {contextErr}
        </Notice>
      ) : null}
      <Notice
        tone="info"
        announcement="off"
        className="sms-thread-evidence-notice"
      >
        This view contains retained SMS message records. Provider-managed
        compliance auto-replies may not appear here, so this thread is not proof
        that every automated reply was delivered.
      </Notice>
      {!online ? (
        <Notice
          tone="warning"
          announcement="polite"
          className="sms-thread-notice"
        >
          This thread is offline. The last loaded messages remain visible;
          replies, lifecycle changes, and polling are paused.
        </Notice>
      ) : null}
      {markReadErr ? (
        <Notice
          tone="warning"
          announcement="polite"
          className="sms-thread-notice"
          action={
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setMarkReadErr(false);
                void markLoadedReadBoundary().then(() => props.onReplySent());
              }}
              disabled={
                !online ||
                !documentVisible ||
                loadedInboundBoundaryRef.current.length === 0
              }
            >
              Retry mark read
            </button>
          }
        >
          Messages loaded, but the read marker was not confirmed. The queue may
          still show this conversation as unread.
        </Notice>
      ) : null}
      <ConversationTagsNotes phone={phone} />
      <ActivityFeed phone={phone} />
      {retryReconciliation ? (
        <Notice
          tone="warning"
          announcement="assertive"
          className="sms-thread-notice"
          action={
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void loadMessages()}
              disabled={!online || messagesRefreshing}
            >
              Refresh retained records
            </button>
          }
        >
          {smsReplyReconciliationCopy()}
        </Notice>
      ) : null}
      <div className="sms-thread-body" ref={bodyRef} onScroll={onBodyScroll}>
        {err ? (
          <Notice
            tone={messages ? "warning" : "danger"}
            announcement={messages ? "polite" : "assertive"}
            action={
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void loadMessages()}
                disabled={!online || messagesRefreshing}
              >
                Retry
              </button>
            }
          >
            {messages
              ? `Message refresh failed: ${err}. Showing the last loaded history.`
              : err}
          </Notice>
        ) : null}
        {olderErr ? (
          <Notice tone="warning" announcement="polite">
            {olderErr}
          </Notice>
        ) : null}
        {messages && nextMessagesCursor ? (
          <div className="sms-thread-load-older">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={!online || loadingOlder || messagesRefreshing}
              onClick={() => void loadOlderMessages()}
            >
              {loadingOlder ? "Loading older records…" : "Load older records"}
            </button>
            {messagesSnapshotAt ? (
              <span className="muted small">
                Pages share one message-insertion cutoff. Delivery and read
                state may still change, and late commits at or before the cutoff
                can differ after refresh.
              </span>
            ) : null}
          </div>
        ) : null}
        {!messages ? (
          <div className="sms-thread-loading" role="status">
            <span className="sms-thread-loading-mark" aria-hidden="true" />
            <span>
              {online
                ? "Loading messages…"
                : "No messages loaded in this window."}
            </span>
          </div>
        ) : messages.length === 0 ? (
          <div className="sms-thread-empty">
            <strong>No retained messages</strong>
            <span className="muted small">
              The conversation record exists, but its message history is empty.
            </span>
          </div>
        ) : (
          <>
            {(() => {
              // Render bubbles with day separators interleaved when
              // the calendar date changes. Walking the list once
              // keeps this O(n) and avoids materialising a
              // grouped-by-day intermediate.
              const out: ReactElement[] = [];
              let prevDay: Date | null = null;
              for (const m of messages) {
                const d = new Date(m.created_at);
                if (!prevDay || !isSameLocalDay(prevDay, d)) {
                  out.push(<DaySeparator key={`day:${m.id}`} date={d} />);
                  prevDay = d;
                }
                out.push(
                  <MessageBubble
                    key={m.id}
                    message={m}
                    onRetry={
                      lifecycleBusy ||
                      !online ||
                      threadSendLocked ||
                      retryReconciliation?.sourceMessageId === m.id
                        ? undefined
                        : () =>
                            setRetryTarget({
                              message: m,
                              listId:
                                threadEligibleLists.length === 1
                                  ? (threadEligibleLists[0]?.id ?? "")
                                  : "",
                            })
                    }
                  />,
                );
              }
              return out;
            })()}
            <div ref={bottomRef} />
          </>
        )}
      </div>
      <ReplyComposer
        phone={phone}
        intentScope={props.intentScope}
        context={context}
        prefillBody={composerBody || undefined}
        onPrefillConsumed={() => setComposerBody("")}
        extraActions={
          <QuickReplyPicker
            onPick={(r) => {
              setComposerBody(r.body);
              setComposerSourceReplyId(r.id);
            }}
          />
        }
        unavailableReason={
          !online
            ? "Reconnect before sending a reply."
            : contextLoading
              ? "Wait for consent context to load before replying."
              : contextErr
                ? "Consent context could not be verified. Retry the thread before replying."
                : hardenedContext?.replyDispatchAvailable !== true
                  ? smsReplyDispatchHoldCopy(
                      hardenedContext?.replyDispatchUnavailableReason,
                    )
                  : undefined
        }
        onSent={() => {
          // Refined PR 3: if the body originated from a quick reply,
          // bump that reply's use counter so the picker can rank
          // most-used at top.
          if (composerSourceReplyId) {
            void api.recordSMSQuickReplyUse(composerSourceReplyId);
            setComposerSourceReplyId(null);
          }
          // Own send: always snap the thread to the new message.
          forceScrollRef.current = true;
          void loadMessages();
          void loadContext();
          props.onReplySent();
        }}
      />
      <ConfirmModal
        open={archiveConfirmOpen}
        title={`Archive conversation with ${phone}?`}
        description="The thread moves out of the Active queue. Its retained messages are not deleted."
        confirmLabel="Archive conversation"
        cancelLabel="Keep active"
        danger
        busy={lifecycleBusy}
        onClose={() => {
          if (!lifecycleBusy) setArchiveConfirmOpen(false);
        }}
        onConfirm={() => void onArchive()}
      />
      <ConfirmModal
        open={retryTarget !== null}
        title={
          retryRecoveryHold
            ? "Retry intent remains held"
            : "Retry this failed SMS?"
        }
        description={
          retryRecoveryHold
            ? "The encrypted checkpoint has no authoritative server expiry or retention guarantee. It remains held until a terminal server result settles it; another request is disabled."
            : "This creates another outbound delivery attempt with one durable intent key and may incur another carrier charge. The failed record remains in history."
        }
        confirmLabel={retryRecoveryHold ? "Retry held" : "Retry SMS"}
        cancelLabel="Do not retry"
        busy={lifecycleBusy}
        confirmDisabled={!retryTarget?.listId || retryRecoveryHold !== null}
        onClose={() => {
          if (!lifecycleBusy) {
            setRetryTarget(null);
            setRetryRecoveryHold(null);
          }
        }}
        onConfirm={() => {
          if (retryTarget) void onRetry(retryTarget);
        }}
      >
        {retryTarget ? (
          <div className="sms-retry-summary">
            <span className="muted small">Recipient</span>
            <strong className="mono">{phone}</strong>
            <span className="muted small">Message</span>
            <p>
              <bdi className="sms-message-text" dir="auto">
                {retryTarget.message.body}
              </bdi>
            </p>
            <label>
              <span className="muted small">Eligible consent list</span>
              <select
                value={retryTarget.listId}
                disabled={lifecycleBusy}
                onChange={(event) =>
                  setRetryTarget((current) =>
                    current
                      ? { ...current, listId: event.target.value }
                      : current,
                  )
                }
              >
                <option value="">Choose an eligible list…</option>
                {threadEligibleLists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </ConfirmModal>
    </div>
  );
}

/**
 * NewConversationModal — start a brand-new outbound SMS thread.
 *
 * QA-nit follow-up: prior QA flagged that the inbox had no
 * compose/new-conversation CTA. This modal collects a recipient phone
 * (E.164), a sender profile from the configured senders list, and the
 * body, then fires the existing replySMSConversation endpoint (which
 * upserts the conversation server-side). On backend failure (404 in
 * unwired envs) we surface a clear inline error.
 */
function NewConversationModal(props: {
  open: boolean;
  intentScope: string | null;
  onClose: () => void;
  onSent: (phone: string) => void;
}): ReactElement | null {
  type OutboundContext = SMSConversationContext & {
    hasInboundThread: boolean;
    eligibleLists: Array<{
      id: string;
      name: string;
      description?: string;
      consentSource?: string;
      consentAt?: string;
    }>;
    suppressed: boolean;
    suppressionReason?: string;
    consentMixed: boolean;
    identityAmbiguous: boolean;
    consentEvidenceSufficient: boolean;
    replyDispatchAvailable: boolean;
    replyDispatchUnavailableReason?: string;
  };

  const [phone, setPhone] = useState("");
  const [senders, setSenders] = useState<Array<{
    id: string;
    label?: string;
    phone_number?: string;
  }> | null>(null);
  const [senderId, setSenderId] = useState("");
  const [context, setContext] = useState<OutboundContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextErr, setContextErr] = useState<string | null>(null);
  const [listId, setListId] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [recoveryHold, setRecoveryHold] = useState<Extract<
    SMSReplyPrepareResult,
    { status: "held" }
  > | null>(null);
  const sendAvailabilityId = useId();
  const sendingRef = useRef(false);
  const contextSeqRef = useRef(0);
  const contextAbortRef = useRef<AbortController | null>(null);
  const senderAbortRef = useRef<AbortController | null>(null);
  const documentVisible = useSMSDocumentVisible();
  const [err, setErr] = useState<string | null>(null);
  const [sendersErr, setSendersErr] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open || !documentVisible) {
      senderAbortRef.current?.abort();
      return;
    }
    let cancelled = false;
    senderAbortRef.current?.abort();
    const controller = new AbortController();
    senderAbortRef.current = controller;
    setSenders(null);
    setSendersErr(null);
    void (async () => {
      try {
        const res = await api.listSMSSenders({ signal: controller.signal });
        if (cancelled || controller.signal.aborted) return;
        if (res.error) {
          setSenders([]);
          setSendersErr(res.error.message);
          return;
        }
        const list = eligibleSMSSenders(res.data?.items ?? []);
        setSenders(list);
        setSenderId((current) =>
          current && list.some((sender) => sender.id === current)
            ? current
            : (list[0]?.id ?? ""),
        );
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setSenders([]);
          setSendersErr(
            describeSmsFailure(error, "Sender profiles could not load."),
          );
        }
      }
    })();
    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [documentVisible, props.open]);

  const normalizedPhone = normalizeSMSUSCA(phone);
  useEffect(() => {
    if (!props.open || !normalizedPhone || !documentVisible) {
      contextAbortRef.current?.abort();
      contextSeqRef.current += 1;
      setContext(null);
      setContextLoading(false);
      setContextErr(null);
      setListId("");
      return;
    }
    const seq = ++contextSeqRef.current;
    contextAbortRef.current?.abort();
    const controller = new AbortController();
    contextAbortRef.current = controller;
    setContext(null);
    setContextLoading(true);
    setContextErr(null);
    setListId("");
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await api.getSMSConversationContext(
            normalizedPhone,
            { signal: controller.signal },
          );
          if (controller.signal.aborted || seq !== contextSeqRef.current)
            return;
          if (response.error) {
            setContextErr(
              "Consent eligibility could not be verified for this number.",
            );
            return;
          }
          const verified = response.data as OutboundContext;
          setContext(verified);
          if (verified.eligibleLists.length === 1) {
            setListId(verified.eligibleLists[0]?.id ?? "");
          }
        } catch {
          if (!controller.signal.aborted && seq === contextSeqRef.current) {
            setContextErr(
              "Consent eligibility could not be verified for this number.",
            );
          }
        } finally {
          if (!controller.signal.aborted && seq === contextSeqRef.current) {
            setContextLoading(false);
          }
        }
      })();
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [documentVisible, normalizedPhone, props.open]);

  useEffect(() => {
    if (props.open) return;
    contextSeqRef.current += 1;
    contextAbortRef.current?.abort();
    senderAbortRef.current?.abort();
    setPhone("");
    setBody("");
    setContext(null);
    setContextErr(null);
    setListId("");
    setReconciling(false);
    setRecoveryHold(null);
    setErr(null);
  }, [props.open]);

  if (!props.open) return null;

  const e164 = normalizedPhone ?? "";
  const validPhone = normalizedPhone !== null;
  const bodyConstraint = smsReplyBodyConstraint(body);
  const trimmedBody = bodyConstraint.trimmed;
  const bodySegments = smsSegmentInfo(body);
  const optedOut = context?.consentStatus === "opted_out";
  const suppressed = context?.suppressed === true;
  const eligibleLists = context?.eligibleLists ?? [];
  const sendEligible =
    !sending &&
    !reconciling &&
    validPhone &&
    context !== null &&
    !contextLoading &&
    contextErr === null &&
    !optedOut &&
    !suppressed &&
    !context.consentMixed &&
    !context.identityAmbiguous &&
    context.consentEvidenceSufficient &&
    context.replyDispatchAvailable &&
    eligibleLists.some((list) => list.id === listId) &&
    bodyConstraint.error === null &&
    senderId !== "";
  const canSend = sendEligible && recoveryHold === null;
  const sendAvailability = sending
    ? "The send intent is being submitted. Keep this window open until its outcome is known."
    : reconciling
      ? smsReplyReconciliationCopy()
      : recoveryHold
        ? "The stored send safeguard remains held until an authoritative terminal server result settles it."
        : !validPhone
          ? "Enter a US/Canada phone with 10 digits (country code +1 is optional)."
          : contextLoading
            ? "Verifying authoritative consent eligibility…"
            : contextErr
              ? contextErr
              : context === null
                ? "Wait for consent eligibility to be verified."
                : suppressed
                  ? `This number has an authoritative ${context.suppressionReason ?? "system"} suppression.`
                  : context.identityAmbiguous
                    ? "Multiple subscriber identities are linked to this phone. Outbound SMS is locked."
                    : context.consentMixed
                      ? "Conflicting consent evidence is recorded for this phone. Outbound SMS is locked."
                      : !context.consentEvidenceSufficient
                        ? "No complete timestamped consent evidence authorizes outbound SMS."
                        : !context.replyDispatchAvailable
                          ? smsReplyDispatchHoldCopy(
                              context.replyDispatchUnavailableReason,
                            )
                          : optedOut
                            ? "The loaded consent record is revoked. A new outbound message is unavailable."
                            : eligibleLists.length === 0
                              ? "No exact eligible SMS list is recorded for this number."
                              : !listId
                                ? "Choose the exact eligible SMS list authorizing this message."
                                : bodyConstraint.error
                                  ? bodyConstraint.error
                                  : !senderId
                                    ? senders === null
                                      ? "Wait for approved sender profiles to load."
                                      : "Pick an approved US/Canada sender before sending."
                                    : null;

  const onSend = async (): Promise<void> => {
    setErr(null);
    if (!canSend || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    const request: SMSReplyRequest = {
      sender_profile_id: senderId,
      body: trimmedBody,
      list_id: listId,
    };
    const recoveryInput = {
      phone: e164,
      request,
    };
    let intent: Extract<SMSReplyPrepareResult, { status: "ready" }> | null =
      null;
    try {
      const prepared = await smsReplyRecovery.prepare(
        props.intentScope,
        recoveryInput,
      );
      if (prepared.status === "held") {
        setRecoveryHold(prepared);
        setErr(
          prepared.reason === "outcome-unknown" ||
            prepared.reason === "recovered-after-restart"
            ? "This recovered send intent remains held until an authoritative terminal server result settles it. No replay request was made."
            : "The encrypted send checkpoint is unavailable. No send request was made.",
        );
        return;
      }
      intent = prepared;
      setRecoveryHold(null);
      const res = await api.replySMSConversation(
        e164,
        request,
        intent.idempotencyKey,
      );
      if (res.error) {
        const uncertainty = classifySMSReplyUncertainty(res.error);
        if (uncertainty) {
          const checkpointed =
            uncertainty === "request-identity-conflict"
              ? await smsReplyRecovery.markRequestIdentityConflict(
                  props.intentScope,
                  intent.signature,
                )
              : uncertainty === "another-intent-pending"
                ? await smsReplyRecovery.markAnotherIntentPending(
                    props.intentScope,
                    intent.signature,
                  )
                : await smsReplyRecovery.markUnknown(
                    props.intentScope,
                    intent.signature,
                  );
          if (!checkpointed) {
            setRecoveryHold({
              status: "held",
              signature: intent.signature,
              idempotencyKey: intent.idempotencyKey,
              reason: "checkpoint-update-failed",
            });
          } else if (uncertainty !== "outcome-unknown") {
            setRecoveryHold({
              status: "held",
              signature: intent.signature,
              idempotencyKey: intent.idempotencyKey,
              reason: uncertainty,
            });
          }
          setReconciling(uncertainty === "outcome-unknown");
          setErr(smsReplyUncertaintyCopy(uncertainty));
          return;
        }
        const cleared = await smsReplyRecovery.settle(
          props.intentScope,
          intent.signature,
        );
        if (!cleared) {
          setRecoveryHold({
            status: "held",
            signature: intent.signature,
            idempotencyKey: intent.idempotencyKey,
            reason: "checkpoint-clear-failed",
          });
        }
        setErr(
          res.error.code === "sms_reply_dispatch_release_held"
            ? "SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider send was attempted."
            : res.error.code === "sms_financial_reservation_unavailable"
              ? "SMS sending is unavailable because a durable financial reservation could not be established. No provider send was attempted."
              : res.error.code === "consent_required"
                ? "No eligible SMS list consent authorizes this message."
                : res.error.code === "list_selection_required"
                  ? "Choose one exact eligible SMS list before sending."
                  : "The message was not accepted. No persisted/provider receipt was returned.",
        );
        return;
      }
      if (res.data.disposition === "reconciliation_required") {
        const checkpointed = await smsReplyRecovery.markUnknown(
          props.intentScope,
          intent.signature,
        );
        if (!checkpointed) {
          setRecoveryHold({
            status: "held",
            signature: intent.signature,
            idempotencyKey: intent.idempotencyKey,
            reason: "checkpoint-update-failed",
          });
        }
        setReconciling(true);
        setErr(smsReplyReconciliationCopy());
        return;
      }
      const cleared = await smsReplyRecovery.settle(
        props.intentScope,
        intent.signature,
      );
      if (!cleared) {
        setRecoveryHold({
          status: "held",
          signature: intent.signature,
          idempotencyKey: intent.idempotencyKey,
          reason: "checkpoint-clear-failed",
        });
        setErr(
          "The message persisted with a provider receipt, but the encrypted local checkpoint could not be cleared. Do not resend it.",
        );
        return;
      }
      toast.success("Message persisted with a provider receipt");
      setPhone("");
      setBody("");
      setErr(null);
      props.onSent(e164);
    } catch {
      if (intent) {
        const checkpointed = await smsReplyRecovery.markUnknown(
          props.intentScope,
          intent.signature,
        );
        if (!checkpointed) {
          setRecoveryHold({
            status: "held",
            signature: intent.signature,
            idempotencyKey: intent.idempotencyKey,
            reason: "checkpoint-update-failed",
          });
        }
        setReconciling(true);
        setErr(smsReplyReconciliationCopy());
      } else {
        setRecoveryHold({ status: "held", reason: "vault-unavailable" });
        setErr(
          "The encrypted send checkpoint could not be prepared. No send request was made.",
        );
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <>
      <Modal
        open={props.open}
        onClose={() => {
          if (!sendingRef.current && !reconciling) props.onClose();
        }}
        title="New SMS conversation"
        closeOnBackdrop={!sending && !reconciling}
        closeOnEscape={!sending && !reconciling}
        closeDisabled={sending || reconciling}
      >
        <div className="sms-new-conversation-form">
          <label>
            <span className="muted small">Recipient (US/Canada only)</span>
            <input
              type="tel"
              placeholder="+1 202 555 0118"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-invalid={phone.trim() !== "" && !validPhone}
              disabled={sending || reconciling}
            />
            {phone.trim() !== "" && !validPhone ? (
              <span
                className="muted small"
                style={{ color: "var(--pw-danger)" }}
              >
                Enter 10 US/Canada digits, optionally prefixed with country code
                +1 — for example +1 202 555 0118.
              </span>
            ) : null}
          </label>
          <label>
            <span className="muted small">From sender</span>
            <select
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              disabled={
                senders === null ||
                senders.length === 0 ||
                sending ||
                reconciling
              }
            >
              {senders === null ? (
                <option value="">Loading senders…</option>
              ) : senders.length === 0 ? (
                <option value="">No approved senders available</option>
              ) : (
                senders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label ?? s.phone_number ?? s.id}
                  </option>
                ))
              )}
            </select>
            {sendersErr ? (
              <span className="muted small" role="status">
                Couldn&apos;t load senders: {sendersErr}
              </span>
            ) : null}
          </label>
          <label>
            <span className="muted small">Eligible consent list</span>
            <select
              value={listId}
              onChange={(event) => setListId(event.target.value)}
              disabled={
                sending ||
                reconciling ||
                contextLoading ||
                suppressed ||
                eligibleLists.length === 0
              }
            >
              <option value="">
                {contextLoading
                  ? "Verifying eligibility…"
                  : eligibleLists.length === 0
                    ? "No eligible list recorded"
                    : "Choose an eligible list…"}
              </option>
              {eligibleLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
            <span className="muted small">
              New outbound messages always send one exact list id to the
              authoritative consent gate. Aggregate status is not enough.
            </span>
          </label>
          <label>
            <span className="muted small">Message</span>
            <textarea
              rows={4}
              placeholder="Type the first message…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={sending || reconciling}
              aria-invalid={body.length > 0 && bodyConstraint.error !== null}
            />
            <span className="muted small">
              {bodyConstraint.runes.toLocaleString()} characters ·{" "}
              {bodyConstraint.bytes.toLocaleString()} UTF-8 bytes ·{" "}
              {bodySegments.segments} billable segment
              {bodySegments.segments === 1 ? "" : "s"}
              {bodySegments.encoding === "unicode" ? " · Unicode encoding" : ""}
            </span>
          </label>
          {context && !context.replyDispatchAvailable ? (
            <Notice tone="warning" announcement="polite">
              {smsReplyDispatchHoldCopy(context.replyDispatchUnavailableReason)}
            </Notice>
          ) : null}
          {recoveryHold ? (
            <Notice tone="warning" announcement="assertive">
              <div className="sms-recovery-hold-inline">
                <strong>Stored send safeguard is holding this draft.</strong>
                <span>
                  {recoveryHold.reason === "request-identity-conflict"
                    ? "The server and encrypted vault disagree about this key's request identity. Operator reconciliation is required; checking it again is disabled."
                    : recoveryHold.reason === "another-intent-pending"
                      ? "Another intent for this phone is unresolved. This checkpoint was not reported as sent and remains blocked pending operator reconciliation."
                      : recoveryHold.reason === "checkpoint-clear-failed"
                        ? "An authoritative response returned, but the encrypted checkpoint could not be cleared. Do not resend."
                        : recoveryHold.reason === "checkpoint-update-failed"
                          ? "The outcome is unknown and the encrypted checkpoint state could not be updated. Do not resend."
                          : "No replacement key or replay request will be created. This intent remains held pending an authoritative terminal server result."}
                </span>
              </div>
            </Notice>
          ) : null}
          {err ? (
            <Notice tone="danger" announcement="assertive">
              {err}
            </Notice>
          ) : null}
          {sendAvailability ? (
            <div
              id={sendAvailabilityId}
              className="muted small"
              role="status"
              aria-live="polite"
            >
              {sendAvailability}
            </div>
          ) : null}
        </div>
        <ModalFooter>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (!sendingRef.current) props.onClose();
            }}
            disabled={sending || reconciling}
            aria-describedby={sending ? sendAvailabilityId : undefined}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void onSend()}
            disabled={!canSend}
            aria-describedby={sendAvailability ? sendAvailabilityId : undefined}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </ModalFooter>
      </Modal>
    </>
  );
}
