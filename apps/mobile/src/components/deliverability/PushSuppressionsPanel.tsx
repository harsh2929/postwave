/**
 * PushSuppressionsPanel — the push channel of the Suppressions screen.
 *
 * Exact-admin registry for tenant-customer APNs, FCM, and Web push tokens.
 * It is independent from this operator app's Expo devices. Customer runtime,
 * materialization, and providers remain release-held; automatic provider
 * feedback is unavailable. Only a reversible manual dashboard authority is removable.
 *
 * The two writes offered here both act on that reversible manual authority:
 * ADD one by pasted token (PushSuppressionAddSheet; desktop's add-by-token
 * verb) and REMOVE one by swipe. Both are online-only and never queued, so
 * the add affordance HIDES rather than refuses when there is no connection —
 * the same rule the header's Sync follows.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";

import { ChipRow } from "@/components/ChipRow";
import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { SuppressionListFooter } from "@/components/deliverability/SuppressionListFooter";
import { SwipeableRow } from "@/components/SwipeableRow";
import { useToast } from "@/components/Toast";
import { PushSuppressionAddSheet } from "@/components/deliverability/PushSuppressionAddSheet";
import {
  useAddPushSuppression,
  usePushSuppressionAccess,
  usePushSuppressions,
  useRemovePushSuppression,
} from "@/hooks/usePushSuppressions";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { FONT } from "@/lib/fonts";
import { num, plural, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import {
  deviceHandle,
  deviceHandleSpoken,
  isReversibleManualPushSuppression,
  mergePushSuppressionPages,
  pushPlatformLabel,
  pushReasonHint,
  pushReasonLabel,
  pushReasonTone,
  pushUnsuppressCopy,
  PUSH_PLATFORM_FILTERS,
  type PushPlatform,
  type PushSuppressionRow,
} from "@/lib/pushSuppressions";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function DeviceRow({
  row,
  now,
  t,
}: {
  row: PushSuppressionRow;
  now: number;
  t: ThemeTokens;
}) {
  const platform = pushPlatformLabel(row.platform);
  const reason = pushReasonLabel(row.reason);
  const hint = pushReasonHint(row.reason);
  const when = relativeTime(row.createdAt ?? undefined, { now, fallback: "" });
  return (
    <View
      accessible
      accessibilityLabel={[
        `${platform} device`,
        deviceHandleSpoken(row.deviceTokenHash),
        reason,
        when ? `suppressed ${when}` : "",
        hint,
      ]
        .filter(Boolean)
        .join(". ")}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        minHeight: 64,
        gap: 6,
        marginBottom: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Pill label={platform} tone="neutral" />
        <Pill label={reason} tone={pushReasonTone(row.reason)} />
        {!row.reversible ? (
          <Pill label="Locked authority" tone="warning" />
        ) : null}
        {when ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {when}
          </Text>
        ) : null}
      </View>
      {/* The bounded fingerprint is the only handle an operator can correlate
          with an authority record. It is decoration for a screen
          reader: the row's own label already spells it out. */}
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
      >
        {deviceHandle(row.deviceTokenHash)}
      </Text>
      {hint ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function PushSuppressionsPanel({
  platform,
  onPlatformChange,
  now,
  t,
}: {
  platform: string;
  onPlatformChange: (next: string) => void;
  now: number;
  t: ThemeTokens;
}) {
  const access = usePushSuppressionAccess();
  const confirm = useConfirm();
  const { toast } = useToast();
  const query = usePushSuppressions(platform, access);
  const remove = useRemovePushSuppression(access);
  const add = useAddPushSuppression(access);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const writeLock = useRef(false);

  const merged = useMemo(() => {
    if (!access.canRequest || !query.isSuccess)
      return { value: null, error: null };
    try {
      return {
        value: mergePushSuppressionPages(query.data.pages),
        error: null,
      };
    } catch (error) {
      return { value: null, error };
    }
  }, [access.canRequest, query.data?.pages, query.isSuccess]);
  const rows = merged.value?.items ?? [];
  const total = merged.value?.total ?? null;
  const mutationReady =
    access.canRequest && query.isSuccess && !query.isFetching && !merged.error;

  const onRemove = useCallback(
    async (row: PushSuppressionRow) => {
      if (!mutationReady || !isReversibleManualPushSuppression(row)) return;
      if (writeLock.current) return;
      writeLock.current = true;
      setBusyId(row.id);
      try {
        const copy = pushUnsuppressCopy();
        const ok = await confirm({
          title: copy.title,
          message: copy.message,
          confirmLabel: copy.confirmLabel,
          confirmPhrase: row.deviceTokenHash,
          consequence:
            "Only this versioned manual authority is removed. Locked authority remains untouched.",
          destructive: true,
        });
        if (!ok) return;
        const receipt = await remove.mutateAsync(row);
        haptics.success();
        toast({
          kind: "success",
          message: receipt.stillSuppressed
            ? "Manual authority removed. Another locked registry authority still holds this token."
            : "Manual registry authority removed. Customer push delivery remains release-held.",
        });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: writeFailureMessage(
            error,
            "Couldn't remove the manual registry hold.",
          ),
        });
      } finally {
        writeLock.current = false;
        setBusyId(null);
      }
    },
    [confirm, mutationReady, remove, toast],
  );

  const onAdd = useCallback(
    (input: { deviceToken: string; platform: PushPlatform }) => {
      if (add.isPending) return;
      add.mutate(input, {
        onSuccess: () => {
          haptics.success();
          setAddOpen(false);
          toast({
            kind: "success",
            message:
              "Manual hold recorded for this device. Customer push delivery remains release-held.",
          });
        },
        onError: (error) => {
          haptics.error();
          toast({
            kind: "error",
            message: writeFailureMessage(error, "Couldn't suppress the device token."),
          });
        },
      });
    },
    [add, toast],
  );

  const renderItem = useCallback(
    ({ item }: { item: PushSuppressionRow }) => {
      const card = <DeviceRow row={item} now={now} t={t} />;
      if (
        !mutationReady ||
        !isReversibleManualPushSuppression(item) ||
        busyId === item.id
      )
        return card;
      return (
        <SwipeableRow
          accessibilityLabel={`${pushPlatformLabel(item.platform)} device, ${pushReasonLabel(item.reason)}`}
          right={[
            {
              label: "Remove",
              kind: "danger",
              onPress: () => void onRemove(item),
            },
          ]}
        >
          {card}
        </SwipeableRow>
      );
    },
    [busyId, mutationReady, now, onRemove, t],
  );

  const countLine = useMemo(() => {
    if (total == null) return "";
    return platform === "all"
      ? plural(total, "active registry authority")
      : `${plural(total, "active registry authority")} on ${pushPlatformLabel(platform)}`;
  }, [platform, total]);

  if (!access.roleAllowed) {
    return (
      <ErrorState
        message={
          access.denialReason ?? "The customer push registry is restricted."
        }
      />
    );
  }

  if (merged.error) {
    return (
      <ErrorState message="The customer push registry response could not be verified, so no rows or totals are shown." />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingBottom: 8 }}>
        <ChipRow
          options={PUSH_PLATFORM_FILTERS.map((f) => ({
            value: f.key,
            label: f.label,
            accessibilityLabel: f.accessibilityLabel,
          }))}
          value={platform}
          onChange={onPlatformChange}
          accessibilityLabel="Filter by device platform"
        />
      </View>
      <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 4 }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Registry only: tenant-customer APNs, FCM, and Web push. Customer
          runtime, materialization, and providers are release-held; automatic
          provider feedback is unavailable.
        </Text>
        {access.canRequest ? (
          <Pressable
            onPress={() => setAddOpen(true)}
            accessibilityRole="button"
            // The NAME is the verb with its object — "Add" told a screen
            // reader nothing about what would be added.
            accessibilityLabel="Suppress a device token"
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
              Suppress a device token…
            </Text>
          </Pressable>
        ) : null}
      </View>
      {countLine ? (
        <Text
          {...typeCap("label")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            paddingHorizontal: 16,
            paddingBottom: 8,
          }}
        >
          {countLine}
        </Text>
      ) : null}
      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={renderItem}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 32,
          flexGrow: 1,
        }}
        ListEmptyComponent={
          <QueryStates
            query={query}
            gate={{ enabled: access.canRequest }}
            isEmpty
            skeleton={<SkeletonList rows={5} />}
            offlineMessage="You're offline. Push suppressions aren't saved for offline use yet."
            empty={{
              title:
                platform === "all"
                  ? "No customer push authorities"
                  : `No ${pushPlatformLabel(platform)} authorities`,
              description:
                "The verified snapshot contains no active authority rows. This does not prove push delivery readiness, and automatic provider feedback is unavailable.",
            }}
          >
            {null}
          </QueryStates>
        }
        ListFooterComponent={
          <SuppressionListFooter
            scopeNote={
              merged.value?.hasMore
                ? `${num(rows.length)} of ${num(merged.value.total)} verified authority rows loaded from one snapshot.`
                : ""
            }
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
            t={t}
          />
        }
      />
      <PushSuppressionAddSheet
        visible={addOpen}
        submitting={add.isPending}
        onClose={() => setAddOpen(false)}
        onSubmit={onAdd}
      />
    </View>
  );
}
