/** Admin-only SMS triage with cursor-bound pagination and honest freshness. */
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ErrorState } from "@/components/ErrorState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SmsBulkActionBar } from "@/components/sms/SmsBulkActionBar";
import { SmsConversationTriageSheet } from "@/components/sms/SmsConversationTriageSheet";
import { SmsExportSheet } from "@/components/sms/SmsExportSheet";
import { SmsInboxHoldBanner } from "@/components/sms/SmsInboxHoldBanner";
import { SmsInboxBoundary } from "@/components/sms/SmsInboxBoundary";
import { SmsInboxFilters } from "@/components/sms/SmsInboxFilters";
import { SmsInboxList } from "@/components/sms/SmsInboxList";
import { SmsExportHeaderButton } from "@/components/sms/SmsInboxParts";
import { SmsSearchResults } from "@/components/sms/SmsSearchResults";
import {
  smsBulkDoneMessage,
  smsBulkIntentFor,
  type SmsBulkVerbId,
} from "@/components/sms/smsBulkOptions";
import {
  smsTriageDoneMessage,
  smsTriageIntentFor,
  type SmsTriageOptionId,
} from "@/components/sms/smsTriageOptions";
import { useToast } from "@/components/Toast";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useSmsConversations,
  useSmsInboxAccess,
  type ConversationFilter,
  type ConversationStatus,
} from "@/hooks/useSmsInbox";
import { useMergedSmsConversations } from "@/hooks/useMergedSmsConversations";
import { useSmsBulkTriage } from "@/hooks/useSmsInboxOps";
import { useSmsReplyHolds } from "@/hooks/useSmsReplyHolds";
import { useSmsConversationTriage } from "@/hooks/useSmsInboxTriage";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { goBackOrMore } from "@/lib/nav";
import { SMS_BULK_MAX_TARGETS, smsBulkTargetsFrom } from "@/lib/smsBulkAction";
import {
  conversationTitle,
  type SmsConversationSummary,
} from "@/lib/smsConversation";
import { smsInboxHoldBanner } from "@/lib/smsInboxHoldRollup";
import { smsSearchQueryError } from "@/lib/smsInboxSearch";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function SmsInbox() {
  const { t } = useTheme();
  const focused = useIsFocused();
  const access = useSmsInboxAccess(focused);
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [status, setStatus] = useState<ConversationStatus>("active");
  const [triageFor, setTriageFor] = useState<SmsConversationSummary | null>(
    null,
  );
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [selected, setSelected] = useState<
    ReadonlyMap<string, SmsConversationSummary>
  >(new Map());
  const { toast } = useToast();
  const now = useNowTicker();
  useScreenViewed("sms");

  const conversations = useSmsConversations(filter, access, status);
  const triage = useSmsConversationTriage(access);
  const bulk = useSmsBulkTriage(access);
  const currentUserId = access.identity?.userId ?? null;

  // Lifecycle writes are never queued: a snooze that lands twenty minutes
  // late re-buries a conversation the operator already dealt with by hand.
  const onTriage = useCallback(
    (conversation: SmsConversationSummary, option: SmsTriageOptionId) => {
      const intent = smsTriageIntentFor(option, {
        phoneE164: conversation.phoneE164,
        now: Date.now(),
        currentUserId,
      });
      triage.mutate(intent, {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "info", message: smsTriageDoneMessage(option) });
        },
        onError: (error: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: writeFailureMessage(
              error,
              "That conversation could not be changed.",
            ),
          });
        },
      });
    },
    [currentUserId, toast, triage],
  );

  // A different slice is a different selection universe: keep nothing.
  useEffect(() => {
    setSelected(new Map());
  }, [filter, status, access.identity?.fingerprint]);

  const onSubmitSearch = useCallback(() => {
    const invalid = smsSearchQueryError(searchDraft);
    if (invalid) {
      setSearchError(invalid);
      return;
    }
    setSearchError(null);
    setSelecting(false);
    setSearchQuery(searchDraft.trim());
  }, [searchDraft]);
  const onSearchText = useCallback((next: string) => {
    setSearchDraft(next);
    setSearchError(null);
    if (next.trim() === "") setSearchQuery("");
  }, []);

  const toggleSelect = useCallback(
    (conversation: SmsConversationSummary) => {
      setSelected((current) => {
        const next = new Map(current);
        if (next.has(conversation.phoneE164)) {
          next.delete(conversation.phoneE164);
        } else if (next.size >= SMS_BULK_MAX_TARGETS) {
          toast({
            kind: "warning",
            message: `Bulk actions are limited to ${num(SMS_BULK_MAX_TARGETS)} conversations.`,
          });
          return current;
        } else {
          next.set(conversation.phoneE164, conversation);
        }
        return next;
      });
    },
    [toast],
  );

  const onBulkVerb = useCallback(
    (id: SmsBulkVerbId) => {
      const rows = [...selected.values()];
      if (rows.length === 0) return;
      const { action, until } = smsBulkIntentFor(id, Date.now());
      bulk.mutate(
        {
          conversations: smsBulkTargetsFrom(rows),
          action,
          ...(until ? { until } : {}),
        },
        {
          onSuccess: (receipt) => {
            haptics.success();
            toast({
              kind: "info",
              message: smsBulkDoneMessage(id, receipt.applied),
            });
            setSelected(new Map());
            setSelecting(false);
          },
          onError: (error: unknown) => {
            haptics.error();
            toast({
              kind: "error",
              message: writeFailureMessage(
                error,
                "The bulk action was not applied.",
              ),
            });
            // A 409 means the list moved; refresh so reselection is honest.
            void conversations.refreshFirstPage();
          },
        },
      );
    },
    [bulk, conversations, selected, toast],
  );

  const refresh = useRefreshControl({
    isRefetching: conversations.isRefetching,
    refetch: conversations.refreshFirstPage,
  });
  const merged = useMergedSmsConversations(conversations.data?.pages);
  const rows = merged.value?.conversations ?? [];
  const first = conversations.data?.pages[0];
  const searching = searchQuery !== "";
  const holds = useSmsReplyHolds(
    access,
    useMemo(() => rows.map((row) => row.phoneE164), [rows]),
  );
  const holdBanner = smsInboxHoldBanner(holds.summary, holds.matchedPhone);

  if (!access.roleAllowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="SMS inbox" onBack={goBackOrMore} />
        <SmsInboxBoundary
          title="SMS Inbox is restricted"
          message={
            access.denialReason ??
            "This workspace role cannot read SMS conversations."
          }
        />
      </SafeAreaView>
    );
  }

  if (merged.error) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="SMS inbox" onBack={goBackOrMore} />
        <ErrorState
          message="The inbox response failed its tenant, count, response-cutoff, or ordering checks. No rows were shown."
          onRetry={() => void conversations.refreshFirstPage()}
        />
      </SafeAreaView>
    );
  }

  const shown = rows.length;
  const total = merged.value?.totalConversations ?? 0;
  const unread = merged.value?.unreadTotal ?? 0;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="SMS inbox"
        {...(merged.value && !searching
          ? {
              subtitle: `${num(shown)} shown of ${num(total)}${
                unread > 0 ? ` · ${num(unread)} unread conversations` : ""
              } · reported at response cutoff`,
            }
          : {})}
        onBack={goBackOrMore}
        right={
          access.canRequest ? (
            <SmsExportHeaderButton onPress={() => setExportOpen(true)} />
          ) : null
        }
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
        <SearchField
          value={searchDraft}
          onChangeText={onSearchText}
          onSubmit={onSubmitSearch}
          placeholder="Search message text, phone, email"
          accessibilityLabel="Search conversations on the server"
        />
        {searchError ? (
          <Text
            accessibilityLiveRegion="polite"
            {...typeCap("caption")}
            style={{
              color: t.danger,
              ...typeStyle("caption"),
              fontFamily: FONT.medium,
            }}
          >
            {searchError}
          </Text>
        ) : null}
        <SmsInboxHoldBanner banner={holdBanner} />
        {!searching ? (
          <SmsInboxFilters
            filter={filter}
            status={status}
            unread={unread}
            unknownTotal={first?.unknownTotal ?? 0}
            activeTotal={first?.activeTotal ?? 0}
            snoozedTotal={first?.snoozedTotal ?? 0}
            archivedTotal={first?.archivedTotal ?? 0}
            onFilter={setFilter}
            onStatus={setStatus}
          />
        ) : null}
      </View>
      {searching ? (
        <SmsSearchResults
          query={searchQuery}
          access={access}
          now={now}
          currentUserId={currentUserId}
          onTriage={setTriageFor}
        />
      ) : (
        <SmsInboxList
          access={access}
          rows={rows}
          filter={filter}
          status={status}
          now={now}
          currentUserId={currentUserId}
          snapshotAt={merged.value?.snapshotAt ?? null}
          hasMore={Boolean(merged.value?.hasMore)}
          pollState={conversations.pollState}
          query={conversations}
          refreshing={refresh.refreshing}
          onRefresh={refresh.onRefresh}
          selecting={selecting}
          selected={selected}
          onToggleSelect={toggleSelect}
          onStartSelecting={() => setSelecting(true)}
          onTriage={setTriageFor}
        />
      )}
      {selecting && !searching ? (
        <SmsBulkActionBar
          status={status}
          selectedCount={selected.size}
          busy={bulk.isPending}
          onVerb={onBulkVerb}
          onCancel={() => {
            setSelecting(false);
            setSelected(new Map());
          }}
        />
      ) : null}
      <SmsExportSheet
        visible={exportOpen}
        access={access}
        onClose={() => setExportOpen(false)}
      />
      <SmsConversationTriageSheet
        visible={triageFor !== null}
        conversation={triageFor}
        title={triageFor ? conversationTitle(triageFor) : ""}
        currentUserId={currentUserId}
        now={now}
        busy={triage.isPending}
        onClose={() => setTriageFor(null)}
        onSelect={(option) => {
          if (triageFor) onTriage(triageFor, option);
          setTriageFor(null);
        }}
      />
    </SafeAreaView>
  );
}
