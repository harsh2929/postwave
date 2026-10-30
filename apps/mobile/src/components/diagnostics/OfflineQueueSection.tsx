/**
 * OfflineQueueSection — the offline queue, inspectable (NATIVE#35).
 *
 * The queue model is genuinely rich: per-item status, cancellability, an
 * expiry, a stable operation id that doubles as the server idempotency key,
 * and a separate durable failure journal. All of it was surfaced through ONE
 * `Alert.alert` built from a newline-joined string that could not scroll,
 * silently `.slice(0, 6)`'d both lists, and offered no per-item action.
 *
 * This renders the same model as real rows: every item, a status pill, the
 * expiry in words, per-item discard for the cancellable ones, and a "Try now"
 * that resumes paused mutations. It lives inside the diagnostics screen's
 * ScrollView, so it is a mapped list rather than a nested FlatList — the queue
 * is bounded by the persister's own cap, not by user data.
 *
 * NativeWind v4 gotcha: STATIC Pressable styles only.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { useQueuedWriteTools } from "@/components/diagnostics/QueuedWriteTools";
import { Pill, type PillTone } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  clearOfflineMutationFailures,
  listOfflineMutationFailures,
  subscribeOfflineMutationFailures,
  type OfflineMutationFailure,
} from "@/lib/offlineMutationFailures";
import type { OfflineMutationAuthScope } from "@/lib/offlineMutationContract";
import { currentOfflineAuthScope } from "@/lib/offlineMutations";
import {
  describeOfflineExpiry,
  offlineQueueCounts,
  shortOperationId,
  statusTone,
  type OfflineQueueCounts,
} from "@/lib/offlineQueueView";
import {
  discardPausedOfflineMutations,
  dismissSettledOfflineMutationHistory,
  listOfflineMutationQueue,
  type OfflineMutationQueueItem,
} from "@/lib/offlineMutationQueue";
import { queryClient } from "@/lib/queryClient";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export interface OfflineQueueModel {
  items: OfflineMutationQueueItem[];
  failures: OfflineMutationFailure[];
  counts: OfflineQueueCounts;
  refresh: () => Promise<void>;
  scope: OfflineMutationAuthScope | null;
}

/**
 * Reads the queue for the CURRENT identity only. `currentOfflineAuthScope`
 * throws when the identity is incomplete (mid sign-in, mid workspace switch);
 * that is treated as "nothing to show", never as another identity's queue.
 */
export function useOfflineQueueModel(): OfflineQueueModel {
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const tenantId = useAuthStore((s) => s.tenantId);
  const mode = useAuthStore((s) => s.mode);
  const [items, setItems] = useState<OfflineMutationQueueItem[]>([]);
  const [failures, setFailures] = useState<OfflineMutationFailure[]>([]);
  const [scope, setScope] = useState<OfflineMutationAuthScope | null>(null);
  const epoch = useRef(0);

  const refresh = useCallback(async () => {
    const current = epoch.current + 1;
    epoch.current = current;
    let next: OfflineMutationAuthScope;
    try {
      next = currentOfflineAuthScope();
    } catch {
      setScope(null);
      setItems([]);
      setFailures([]);
      return;
    }
    setScope(next);
    setItems(listOfflineMutationQueue(queryClient, next));
    const rows = await listOfflineMutationFailures(next).catch(() => []);
    if (epoch.current === current) setFailures(rows);
  }, []);

  useEffect(() => {
    // The first call is safe synchronously: an effect body never runs during
    // another component's render. The SUBSCRIPTIONS are not --
    // `mutationCache.subscribe` notifies from inside the mutating component, so
    // a refresh that sets state there triggers React's "Cannot update a
    // component while rendering a different component". Same fault and same fix
    // as OfflineBanner and OfflineMutationFailureBanner; this screen is only
    // reachable from diagnostics, which is why it was the last of the three.
    void refresh();
    let live = true;
    const deferred = () => {
      queueMicrotask(() => {
        if (live) void refresh();
      });
    };
    const stopFailures = subscribeOfflineMutationFailures(deferred);
    const stopQueue = queryClient.getMutationCache().subscribe(deferred);
    return () => {
      live = false;
      stopFailures();
      stopQueue();
    };
  }, [refresh, baseUrl, tenantId, mode]);

  return {
    items,
    failures,
    counts: offlineQueueCounts(items, failures.length),
    refresh,
    scope,
  };
}

export function OfflineQueueSection({
  model,
  resolveOperationId = null,
}: {
  model: OfflineQueueModel;
  /** `?resolve=<operationId>` from the failure banner: open that write's resolver. */
  resolveOperationId?: string | null;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { items, failures, counts } = model;
  // Details / Edit / Resolve per row, the two sheets, and the undo-able
  // discard (components/diagnostics/QueuedWriteTools).
  const tools = useQueuedWriteTools(model.refresh, resolveOperationId);

  const onDiscard = useCallback(
    async (item: OfflineMutationQueueItem) => {
      const ok = await confirm({
        title: "Discard this change?",
        message: `"${item.label}" has not reached the server. Discarding drops it from this phone — Undo on the confirmation puts it back.`,
        confirmLabel: "Discard",
        destructive: true,
      });
      if (!ok) return;
      // With the request shape in hand the discard is undoable; without it
      // (a write this build cannot read back) it is the plain removal.
      const detail = tools.detailFor(item.operationId);
      if (detail) {
        tools.discardWithUndo(detail);
        return;
      }
      try {
        discardPausedOfflineMutations(
          queryClient,
          currentOfflineAuthScope(),
          new Set([item.mutationId]),
        );
        haptics.success();
        toast({ kind: "success", message: "Change discarded." });
      } catch {
        toast({ kind: "error", message: "Signed-in identity changed." });
      }
      void model.refresh();
    },
    [confirm, model, toast, tools],
  );

  const onResume = useCallback(() => {
    haptics.tap();
    void queryClient
      .resumePausedMutations()
      .then(() => toast({ kind: "info", message: "Retrying queued changes…" }))
      .catch(() =>
        toast({ kind: "error", message: "Couldn't start a retry right now." }),
      )
      .finally(() => void model.refresh());
  }, [model, toast]);

  const onClearHistory = useCallback(() => {
    try {
      const scope = currentOfflineAuthScope();
      dismissSettledOfflineMutationHistory(queryClient, scope);
      void clearOfflineMutationFailures(scope).finally(() => void model.refresh());
    } catch {
      toast({ kind: "error", message: "Signed-in identity changed." });
    }
  }, [model, toast]);

  if (items.length === 0 && failures.length === 0) {
    return (
      <Card>
        <SectionLabel topMargin={0}>Offline queue</SectionLabel>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Everything you have changed on this phone has reached the server.
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <SectionLabel
        topMargin={0}
        subtitle={`${counts.queued} queued · ${counts.syncing} syncing · ${counts.failed} failed · ${counts.sent} sent`}
      >
        Offline queue
      </SectionLabel>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          marginBottom: 8,
          fontFamily: FONT.regular,
        }}
      >
        Retries reuse the same server deduplication id, so nothing is sent
        twice and a conflict is never overwritten automatically.
      </Text>

      {items.map((item) => (
        <QueueRow
          key={item.mutationId}
          item={item}
          onDiscard={onDiscard}
          actions={tools.actionsFor(item.operationId)}
        />
      ))}

      {failures.map((failure) => (
        <View
          key={failure.id}
          style={{ paddingVertical: 8, gap: 4 }}
          accessible
          accessibilityLabel={`${failure.label}. Failed. ${failure.message}`}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pill label="Failed" tone="danger" size="sm" />
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                flexShrink: 1,
                fontFamily: FONT.medium,
              }}
            >
              {failure.label}
            </Text>
          </View>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {failure.message} · {shortOperationId(failure.operationId)}
          </Text>
          {tools.actionsFor(failure.operationId)}
        </View>
      ))}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
        <ActionButton label="Try now" onPress={onResume} />
        {counts.failed > 0 || counts.sent > 0 ? (
          <ActionButton label="Clear history" onPress={onClearHistory} />
        ) : null}
      </View>
      {tools.sheets}
    </Card>
  );
}

function QueueRow({
  item,
  onDiscard,
  actions,
}: {
  item: OfflineMutationQueueItem;
  onDiscard: (item: OfflineMutationQueueItem) => void | Promise<void>;
  actions?: ReactNode;
}) {
  const { t } = useTheme();
  const expiry = describeOfflineExpiry(item.expiresAt);
  const tone: PillTone = statusTone(item.status);
  return (
    <View style={{ paddingVertical: 8, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pill
          label={item.status}
          tone={tone}
          size="sm"
          accessibilityLabel={`Status: ${item.status}`}
        />
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            flexShrink: 1,
            fontFamily: FONT.medium,
          }}
        >
          {item.label}
        </Text>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            flexShrink: 1,
            fontFamily: FONT.regular,
          }}
        >
          {expiry} · {shortOperationId(item.operationId)}
        </Text>
        {item.cancellable ? (
          <Pressable
            onPress={() => void onDiscard(item)}
            accessibilityRole="button"
            accessibilityLabel={`Discard ${item.label}`}
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.danger,
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Discard
            </Text>
          </Pressable>
        ) : null}
      </View>
      {actions}
    </View>
  );
}

function ActionButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flex: 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.fg,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
