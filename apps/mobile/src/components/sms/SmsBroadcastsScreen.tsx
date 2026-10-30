/**
 * SmsBroadcastsScreen — broadcast DRAFT management on the phone.
 *
 * List, author, edit, delete, and read recorded progress. DISPATCH IS
 * DELIBERATELY ABSENT: POST .../send is release-held server-side and the list
 * response's own `dispatchAvailable` bit drives the banner explaining why no
 * Send control exists. Deleting a draft destroys its content permanently, so
 * it goes through ConfirmSheet with the broadcast's name as the typed phrase.
 */
import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfirm } from "@/components/ConfirmSheet";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { SmsBroadcastEditorSheet } from "@/components/sms/SmsBroadcastEditorSheet";
import { SmsBroadcastRow } from "@/components/sms/SmsBroadcastRow";
import { SmsInboxBoundary } from "@/components/sms/SmsInboxBoundary";
import { LoadMoreButton } from "@/components/sms/SmsInboxParts";
import { useToast } from "@/components/Toast";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useSmsInboxAccess } from "@/hooks/useSmsInbox";
import {
  useSmsBroadcasts,
  useSmsBroadcastWrites,
} from "@/hooks/useSmsBroadcasts";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOr } from "@/lib/nav";
import { broadcastDispatchUnavailableSentence } from "@/lib/smsBroadcastCopy";
import type {
  SmsBroadcast,
  SmsBroadcastDraftInput,
} from "@/lib/smsBroadcastWire";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsBroadcastsScreen() {
  const { t } = useTheme();
  const access = useSmsInboxAccess();
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("sms-broadcasts");
  const broadcasts = useSmsBroadcasts(access);
  const writes = useSmsBroadcastWrites(access);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SmsBroadcast | null>(null);
  const [progressFor, setProgressFor] = useState<string | null>(null);
  const refresh = useRefreshControl({
    isRefetching: broadcasts.isRefetching,
    refetch: broadcasts.refetch,
  });

  const pages = Array.isArray(broadcasts.data?.pages)
    ? broadcasts.data.pages
    : [];
  const rows = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  const first = pages[0];

  const onSave = (draft: SmsBroadcastDraftInput) => {
    writes.mutate(
      editing
        ? {
            action: "update",
            id: editing.id,
            draft,
            existing: {
              listIds: editing.listIds,
              segmentId: editing.segmentId,
            },
          }
        : { action: "create", draft },
      {
        onSuccess: () => {
          haptics.success();
          toast({
            kind: "info",
            message: editing ? "Broadcast draft saved." : "Broadcast draft created.",
          });
          setEditorOpen(false);
          setEditing(null);
        },
        onError: (error) => {
          haptics.error();
          toast({
            kind: "error",
            message: writeFailureMessage(error, "The draft was not saved."),
          });
        },
      },
    );
  };

  const onDelete = (broadcast: SmsBroadcast) => {
    void (async () => {
      const confirmed = await confirm({
        title: `Delete “${broadcast.name}”?`,
        message:
          "Deleting a broadcast permanently removes its message and recorded delivery counters. Type its name to confirm.",
        confirmLabel: "Delete broadcast",
        destructive: true,
        confirmPhrase: broadcast.name,
      });
      if (!confirmed) return;
      writes.mutate(
        { action: "delete", id: broadcast.id },
        {
          onSuccess: () => {
            haptics.success();
            toast({ kind: "info", message: "Broadcast deleted." });
          },
          onError: (error) => {
            haptics.error();
            toast({
              kind: "error",
              message: writeFailureMessage(
                error,
                "The broadcast was not deleted.",
              ),
            });
          },
        },
      );
    })();
  };

  if (!access.roleAllowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader
          title="SMS broadcasts"
          onBack={() => goBackOr("/(tabs)/sms")}
        />
        <SmsInboxBoundary
          title="SMS broadcasts are restricted"
          message={
            access.denialReason ??
            "This workspace role cannot manage SMS broadcasts."
          }
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="SMS broadcasts"
        onBack={() => goBackOr("/(tabs)/sms")}
        right={
          access.canRequest ? (
            <Pressable
              onPress={() => {
                haptics.tap();
                setEditing(null);
                setEditorOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="New broadcast draft"
              hitSlop={8}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                New
              </Text>
            </Pressable>
          ) : null
        }
      />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 32, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        ListHeaderComponent={
          first ? (
            <View style={{ gap: 6, marginBottom: 10 }}>
              {!first.dispatchAvailable ? (
                <Text
                  accessibilityLiveRegion="polite"
                  // The server's reason code is kept HERE rather than in the
                  // sentence: it is diagnostic, not copy, and the banner used
                  // to interpolate it raw at an operator who cannot act on it.
                  // `broadcastDispatchUnavailableSentence` owns the wording.
                  testID={`sms-broadcast-dispatch-hold-${first.dispatchUnavailableReason ?? "unknown"}`}
                  {...typeCap("caption")}
                  style={{
                    color: t.warning,
                    ...typeStyle("caption"),
                    fontFamily: FONT.medium,
                  }}
                >
                  {broadcastDispatchUnavailableSentence(
                    first.dispatchUnavailableReason,
                  )}
                </Text>
              ) : null}
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.medium,
                }}
              >
                {`Response cutoff ${dateTime(first.snapshotAt)}`}
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          broadcasts.hasNextPage ? (
            <LoadMoreButton
              label={
                broadcasts.isFetchingNextPage
                  ? "Loading…"
                  : "Load more broadcasts"
              }
              disabled={broadcasts.isFetchingNextPage}
              onPress={() => void broadcasts.fetchNextPage()}
            />
          ) : null
        }
        ListEmptyComponent={
          <QueryStates
            query={broadcasts}
            gate={{ enabled: access.canRequest }}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline. Broadcast drafts need a connection."
            skeleton={<SkeletonList rows={4} />}
            empty={{
              title: "No broadcasts yet",
              description:
                "Create a draft here; audience lists and segments are managed from desktop.",
            }}
          >
            <View />
          </QueryStates>
        }
        renderItem={({ item }) => (
          <SmsBroadcastRow
            broadcast={item}
            access={access}
            progressOpen={progressFor === item.id}
            onToggleProgress={() =>
              setProgressFor((current) =>
                current === item.id ? null : item.id,
              )
            }
            onEdit={() => {
              setEditing(item);
              setEditorOpen(true);
            }}
            onDelete={() => onDelete(item)}
          />
        )}
      />
      <SmsBroadcastEditorSheet
        visible={editorOpen}
        broadcast={editing}
        busy={writes.isPending}
        onSave={onSave}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
      />
    </SafeAreaView>
  );
}
