/**
 * Private, ephemeral SMS thread with verified consent and sender selection.
 *
 * THIS FILE IS THE REACT HALF and nothing else: the queries, the FlatList, the
 * scroll and read-boundary refs, and the screen's guard states. The two jobs it
 * used to also carry now live beside it —
 *   `@/hooks/useSmsThreadComposer`  the reply path and its encrypted hold,
 *   `@/lib/smsThreadCopy`           the pure sentences both halves speak.
 * The copy module imports no react, so its rules are unit-tested in the node
 * vitest environment rather than only through a rendered screen.
 */
import { useIsFocused } from "@react-navigation/native";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ErrorState } from "@/components/ErrorState";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { MessageBubble } from "@/components/sms/MessageBubble";
import { ReplyComposer } from "@/components/sms/ReplyComposer";
import { SmsConversationTriageSheet } from "@/components/sms/SmsConversationTriageSheet";
import { SmsInboxBoundary } from "@/components/sms/SmsInboxBoundary";
import { SmsQuickReplyPicker } from "@/components/sms/SmsQuickReplyPicker";
import { SmsThreadListHeader } from "@/components/sms/SmsThreadListHeader";
import { SmsThreadMetaSection } from "@/components/sms/SmsThreadMetaSection";
import { SmsThreadTriageAction } from "@/components/sms/SmsThreadTriageAction";
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
  useMarkConversationRead,
  useSmsConversationContext,
  useSmsInboxAccess,
  useSmsReply,
  useSmsSenders,
  useSmsThread,
} from "@/hooks/useSmsInbox";
import { useSmsConversationTriage } from "@/hooks/useSmsInboxTriage";
import { useSmsQuickReplyInsert } from "@/hooks/useSmsQuickReplyInsert";
import { useSmsReadBoundary } from "@/hooks/useSmsReadBoundary";
import { useSmsThreadComposer } from "@/hooks/useSmsThreadComposer";
import type { SmsQuickReply } from "@/lib/smsQuickReply";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOr } from "@/lib/nav";
import {
  decodePhoneParam,
  isEligibleSmsSender,
  mergeSmsMessagePages,
  smsReplyBlockReason,
} from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function SmsThread() {
  const { t } = useTheme();
  const focused = useIsFocused();
  const access = useSmsInboxAccess(focused);
  const { toast } = useToast();
  const params = useLocalSearchParams<{ phone?: string | string[] }>();
  const phone = decodePhoneParam(params.phone);
  useScreenViewed("sms-thread");

  const thread = useSmsThread(phone, access);
  const context = useSmsConversationContext(phone, access);
  const senders = useSmsSenders(access);
  const reply = useSmsReply(phone, access);
  const markRead = useMarkConversationRead(access);
  const triage = useSmsConversationTriage(access);
  const now = useNowTicker();
  const [triageOpen, setTriageOpen] = useState(false);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const quickReplyInsert = useSmsQuickReplyInsert(access, toast);
  const refresh = useRefreshControl(
    { isRefetching: thread.isRefetching, refetch: thread.refreshFirstPage },
    { isRefetching: context.isRefetching, refetch: context.refetch },
    { isRefetching: senders.isRefetching, refetch: senders.refetch },
  );

  const listRef = useRef<FlatList>(null);
  const shouldScrollEnd = useRef(true);
  const lastMessageRef = useRef<string | null>(null);

  const merged = useMemo(() => {
    if (!thread.data) return { value: null, error: null };
    try {
      return { value: mergeSmsMessagePages(thread.data.pages), error: null };
    } catch (error) {
      return { value: null, error };
    }
  }, [thread.data]);
  const messages = useMemo(
    () => merged.value?.messages ?? [],
    [merged.value?.messages],
  );
  const eligibleSenders = useMemo(
    () =>
      (Array.isArray(senders.data) ? senders.data : []).filter(
        isEligibleSmsSender,
      ),
    [senders.data],
  );
  const eligibleLists = useMemo(
    () =>
      Array.isArray(context.data?.eligibleLists)
        ? context.data.eligibleLists
        : [],
    [context.data?.eligibleLists],
  );
  const identityFingerprint = access.identity?.fingerprint ?? null;
  const contextFailed = context.isError || (!access.online && !context.data);
  const sendersFailed = senders.isError || (!access.online && !senders.data);
  const blockReason = smsReplyBlockReason({
    phoneE164: phone,
    online: access.online && access.sessionReady,
    context: context.data,
    contextFailed,
    sendersFailed,
    eligibleSenders,
  });
  const composer = useSmsThreadComposer({
    phoneE164: phone,
    identityFingerprint,
    roleAllowed: access.roleAllowed,
    messages,
    eligibleSenders,
    eligibleLists,
    blockReason,
    reply,
    toast,
    onPersisted: quickReplyInsert.onPersisted,
  });
  const insertQuickReply = useCallback(
    (quickReply: SmsQuickReply) => {
      quickReplyInsert.noteInserted(quickReply);
      composer.setDraft(quickReply.body);
    },
    [composer, quickReplyInsert],
  );

  useEffect(() => {
    shouldScrollEnd.current = true;
  }, [identityFingerprint, phone]);
  useSmsReadBoundary({
    phone,
    access,
    isSuccess: thread.isSuccess,
    pages: thread.data?.pages,
    mergedValue: merged.value,
    identityFingerprint,
    markRead,
  });
  useEffect(() => {
    const latest = messages.at(-1)?.id ?? null;
    if (latest && latest !== lastMessageRef.current)
      shouldScrollEnd.current = true;
    lastMessageRef.current = latest;
  }, [messages]);

  /**
   * Triage from inside the thread — read the message, then deal with it.
   *
   * The lifecycle stamps live on the CONVERSATION LIST row, not on
   * `GET .../context`, so this screen genuinely does not know whether the
   * number is already snoozed or archived. The sheet is told so
   * (`conversation={null}`) and offers the full verb set rather than guessing a
   * toggle: every server verb is a SET, so nothing here can invert an operator's
   * intent.
   */
  const onTriage = useCallback(
    (option: SmsTriageOptionId) => {
      if (!phone) return;
      const intent = smsTriageIntentFor(option, {
        phoneE164: phone,
        now: Date.now(),
        currentUserId: access.identity?.userId ?? null,
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
              "This conversation could not be changed.",
            ),
          });
        },
      });
    },
    [access.identity?.userId, phone, toast, triage],
  );

  if (!access.roleAllowed) {
    return (
      <ThreadShell title="Conversation">
        <SmsInboxBoundary
          title="SMS conversation is restricted"
          message={
            access.denialReason ??
            "This workspace role cannot read customer SMS."
          }
        />
      </ThreadShell>
    );
  }
  if (!phone) {
    return (
      <ThreadShell title="Conversation">
        <SmsInboxBoundary
          title="Invalid conversation link"
          message="No valid E.164 phone was present, so no customer data was requested and no reply can be sent."
        />
      </ThreadShell>
    );
  }
  if (merged.error) {
    return (
      <ThreadShell title={phone}>
        <ErrorState
          message="This thread failed its tenant, phone, timestamp, response-cutoff, duplicate, or ordering checks. No messages were shown."
          onRetry={() => void thread.refreshFirstPage()}
        />
      </ThreadShell>
    );
  }

  const loadingOlder =
    thread.isFetchingNextPage || thread.pollState === "refreshing";
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={phone}
        onBack={() => goBackOr("/(tabs)/sms")}
        right={
          access.canRequest ? (
            <SmsThreadTriageAction onPress={() => setTriageOpen(true)} />
          ) : null
        }
      />
      <SmsConversationTriageSheet
        visible={triageOpen}
        conversation={null}
        title={phone}
        currentUserId={access.identity?.userId ?? null}
        now={now}
        busy={triage.isPending}
        onClose={() => setTriageOpen(false)}
        onSelect={(option) => {
          setTriageOpen(false);
          onTriage(option);
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(row) => row.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 8, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={refresh.refreshing}
              onRefresh={refresh.onRefresh}
              tintColor={t.fgMuted}
              colors={[t.accent]}
            />
          }
          {...MOBILE_LIST_PERF_PROPS}
          onContentSizeChange={() => {
            if (!shouldScrollEnd.current) return;
            shouldScrollEnd.current = false;
            listRef.current?.scrollToEnd({ animated: false });
          }}
          ListHeaderComponent={
            <SmsThreadListHeader
              context={context.data}
              contextLoading={context.isLoading && access.online}
              contextFailed={contextFailed}
              online={access.online}
              fetching={thread.isFetching || thread.pollState === "refreshing"}
              refreshFailed={thread.pollState === "failed"}
              restartRequired={thread.pollState === "restart_required"}
              snapshotAt={merged.value?.snapshotAt ?? null}
              partial={Boolean(merged.value?.hasMore)}
              hasOlder={thread.hasNextPage}
              loadingOlder={loadingOlder}
              onLoadOlder={() => void thread.fetchNextPage()}
              meta={<SmsThreadMetaSection phoneE164={phone} access={access} />}
            />
          }
          ListEmptyComponent={
            <QueryStates
              query={thread}
              gate={{ enabled: access.canRequest }}
              isEmpty={messages.length === 0}
              offlineMessage="You're offline. No uncached messages were requested, and replies remain locked."
              skeleton={<SkeletonList rows={4} lines={2} />}
              empty={{
                title: "No messages returned for this response cutoff",
                description:
                  "The server returned an empty thread for this number.",
              }}
            >
              <View />
            </QueryStates>
          }
          renderItem={({ item }) => <MessageBubble message={item} />}
        />
        <ReplyComposer
          value={composer.draft}
          onChangeText={composer.setDraft}
          onSend={() => void composer.send()}
          sending={reply.isPending}
          enabled={access.canRequest && !blockReason && composer.holdsClear}
          disabledReason={composer.selectionReason}
          senders={eligibleSenders}
          senderId={composer.senderId}
          onSenderChange={composer.setSenderId}
          lists={eligibleLists}
          listId={composer.listId}
          onListChange={composer.setListId}
          onOpenQuickReplies={
            access.canRequest ? () => setQuickRepliesOpen(true) : undefined
          }
        />
      </KeyboardAvoidingView>
      <SmsQuickReplyPicker
        visible={quickRepliesOpen}
        access={access}
        onInsert={insertQuickReply}
        onClose={() => setQuickRepliesOpen(false)}
      />
    </SafeAreaView>
  );
}

function ThreadShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title={title} onBack={() => goBackOr("/(tabs)/sms")} />
      {children}
    </SafeAreaView>
  );
}
