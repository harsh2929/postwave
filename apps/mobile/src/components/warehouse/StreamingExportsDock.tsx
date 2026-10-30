/**
 * StreamingExportsDock — "did the streaming exports keep up", pinned under
 * the batch-run list on the warehouse-runs screen.
 *
 * WHY IT IS A DOCK. `WarehouseRunsScreen` owns the screen's ScrollView, and
 * this section is mounted beside it from the route file rather than inside
 * it. A strip under the list keeps the batch monitor untouched, costs the
 * list one row of height only when the workspace actually HAS a streaming
 * connection, and puts the one sentence that matters ("1 of 2 connections
 * did not land the newest window") where a thumb finds it. The full history
 * opens as a sheet with its own scroll.
 *
 * RENDERS NOTHING for a workspace without a streaming connection, for a
 * session the host screen would refuse (see
 * `STREAMING_EXPORT_RUNS_MINIMUM_ROLE`), and before the connection roster has
 * arrived — a strip announcing "0 connections" derived from an unloaded or
 * failed roster would be a statement about the workspace made from no data.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Pill } from "@/components/Pill";
import { StreamingExportsSheet } from "@/components/warehouse/StreamingExportsSheet";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useStreamingExportHistories } from "@/hooks/useStreamingExportRuns";
import { useWarehouseConnections } from "@/hooks/useWarehouseRuns";
import { forwardChevron } from "@/lib/direction";
import { relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  STREAMING_EXPORT_RUNS_MINIMUM_ROLE,
  isStreamingExportConnection,
} from "@/lib/streamingExportRuns";
import {
  streamingConnectionEntries,
  streamingDockSummary,
} from "@/lib/streamingExportVerdict";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function StreamingExportsDock() {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const gate = useOnlineQueryGate();
  // Same source as the host screen: the store carries the role AND the auth
  // mode, and an api_key session is refused at admin exactly as it is there.
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  const allowed = canAccessMinimumRole(
    STREAMING_EXPORT_RUNS_MINIMUM_ROLE,
    role,
    mode,
  );

  // Same query key as the screen's own roster read — TanStack dedupes it, so
  // this costs no second request.
  const connections = useWarehouseConnections(allowed);
  const streaming = useMemo(
    () =>
      (Array.isArray(connections.data) ? connections.data : []).filter(
        isStreamingExportConnection,
      ),
    [connections.data],
  );
  const ids = useMemo(() => streaming.map((c) => c.id), [streaming]);
  const histories = useStreamingExportHistories(ids, allowed);
  const [open, setOpen] = useState(false);

  const loaded = histories.data !== undefined;
  const entries = useMemo(
    () => streamingConnectionEntries(streaming, histories.data),
    [streaming, histories.data],
  );
  const summary = useMemo(
    () => streamingDockSummary(entries, loaded, !gate.enabled),
    [entries, loaded, gate.enabled],
  );

  const onOpen = useCallback(() => {
    haptics.tap();
    setOpen(true);
  }, []);
  const onClose = useCallback(() => setOpen(false), []);

  if (!allowed || streaming.length === 0) return null;

  const lastShipped = summary.lastShippedAt
    ? `Last caught-up window ${relativeTime(summary.lastShippedAt)}.`
    : "";
  const badge =
    summary.failing > 0
      ? { label: `${summary.failing} not landed`, tone: "danger" as const }
      : summary.unreadable > 0
        ? { label: `${summary.unreadable} unreadable`, tone: "warning" as const }
        : null;

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        backgroundColor: t.bg,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: Math.max(insets.bottom, 12),
      }}
    >
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Streaming exports. ${summary.headline}. ${lastShipped}`.trim()}
        accessibilityHint="Opens the shipped-window history for every streaming connection"
        style={{
          backgroundColor: t.surface,
          borderColor: summary.tone === "danger" ? t.danger : t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
            numberOfLines={1}
          >
            Streaming exports
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: summary.tone === "danger" ? t.danger : t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 2,
              fontFamily:
                summary.tone === "danger" ? FONT.semibold : FONT.regular,
            }}
            numberOfLines={2}
          >
            {[summary.headline, lastShipped].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {badge ? <Pill label={badge.label} tone={badge.tone} /> : null}
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...typeCap("body")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {forwardChevron()}
        </Text>
      </Pressable>
      <StreamingExportsSheet
        visible={open}
        onClose={onClose}
        entries={entries}
        loading={!loaded && !histories.isError}
        refetch={histories.refetch}
        gate={gate}
      />
    </View>
  );
}
