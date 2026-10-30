/**
 * Segments — the saved-audience catalogue.
 *
 * Mobile had no segments surface at all: an operator reviewing a campaign
 * on a phone could see a segment's NAME and nothing about what it means or
 * how big it is, and a segment hit in global search dumped them on an
 * unfiltered subscribers list.
 *
 * Rows show name, size (or an honest "not evaluated yet" — the server's
 * `lastCount` is a pointer, so absent is NOT zero), how many conditions the
 * rule has, and when it was last materialised.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CachedSessionNotice } from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { HeaderAction } from "@/components/deliverability/HeaderAction";
import { DescribeAudienceSheet } from "@/components/segments/DescribeAudienceSheet";
import { SegmentCompareSheet } from "@/components/segments/SegmentCompareSheet";
import { SegmentRow } from "@/components/segments/SegmentRow";
import { StartingPointsSection } from "@/components/segments/StartingPointsSection";
import { AudienceNav } from "@/components/subscriber/AudienceNav";
import { useToast } from "@/components/Toast";
import { useDebounced } from "@/hooks/useDebounced";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSegments } from "@/hooks/useSegments";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import type { MobileSegment } from "@/api/segments";
import { audienceGateNotice } from "@/lib/audienceGateNotice";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { describeSaveGate } from "@/lib/segmentSaveGate";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const SEGMENTS_ROUTE = "/(tabs)/segments";

export default function Segments() {
  useScreenViewed("segments");
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const segments = useSegments();
  const gateNotice = audienceGateNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    noun: "segments",
  });

  // A segment hit in global search whose id isn't a routable UUID lands here
  // with the hit's title as `q`, so the catalogue opens already narrowed
  // rather than making the operator find it again by hand.
  const params = useLocalSearchParams<{ q?: string }>();
  const [q, setQ] = useState(typeof params.q === "string" ? params.q : "");
  const debouncedQ = useDebounced(q, 200);
  const [describeOpen, setDescribeOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  // Set when the describe sheet is opened FROM a starting point; cleared on
  // close so the next blank-box open starts blank.
  const [describeSeed, setDescribeSeed] = useState<{
    text: string;
    name: string;
  } | null>(null);
  const { toast } = useToast();
  const online = useIsOnline();
  const authMode = useAuthStore((state) => state.mode);
  // Compiling and previewing ride `read:subscribers` (every role); SAVING is
  // POST /api/v1/segments, mounted with `write:subscribers`, which
  // `editorWriteScopes` extends to owner|admin|editor. Two different gates,
  // so the sheet opens for everyone and only Save is withheld.
  const saveGate = describeSaveGate({
    hasWriteRole: canAccessMinimumRole("editor", gate.effectiveRole, authMode),
    online,
    gated: Boolean(gateNotice),
  });

  // Array.isArray, not `?? []`. The nullish guard passes a truthy `{}` or
  // `{items: []}` straight through — and this screen's own entry point makes
  // that fatal rather than merely blank: arriving from global search pre-fills
  // `q`, which takes the `.filter` path below, and `.filter` does not exist on
  // an object. `fetchSegments` normalises a LIVE response; a payload restored
  // from a cache an older build wrote never passes through it (see the schema
  // buster in lib/secureQueryPersister).
  const all = useMemo(
    () => (Array.isArray(segments.data) ? segments.data : []),
    [segments.data],
  );
  const rows = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((s) =>
      `${s.name} ${s.description}`.toLowerCase().includes(needle),
    );
  }, [all, debouncedQ]);

  const keyExtractor = useCallback((item: MobileSegment) => item.id, []);
  const renderItem = useCallback<ListRenderItem<MobileSegment>>(
    ({ item }) => <SegmentRow segment={item} />,
    [],
  );

  const total = all.length;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Segments"
        onBack={goBackOrMore}
        right={
          // Read-only on this deployment? The sheet still compiles and counts
          // — that is a read — so the entry point is offered to every role and
          // the gate lands on Save, where the write actually is.
          gate.enabled ? (
            <View style={{ flexDirection: "row", gap: 12 }}>
              {/* Both compare reads are viewer-floor, so the entry point is
                  offered to every role — but only once there are two rows
                  to compare. */}
              {all.length >= 2 ? (
                <HeaderAction
                  label="Compare"
                  accessibilityLabel="Compare audiences"
                  onPress={() => setCompareOpen(true)}
                />
              ) : null}
              <HeaderAction
                label="Describe"
                accessibilityLabel="Describe an audience in words"
                onPress={() => setDescribeOpen(true)}
              />
            </View>
          ) : null
        }
      />
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 4,
          paddingBottom: 8,
          gap: 10,
        }}
      >
        <AudienceNav active={SEGMENTS_ROUTE} />
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Search segments…"
          accessibilityLabel="Search segments"
          {...(debouncedQ ? { resultCount: rows.length } : {})}
          resultNoun="matching segment"
        />
        {total > 0 ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            {debouncedQ
              ? `${rows.length} of ${plural(total, "segment")}`
              : plural(total, "segment")}
          </Text>
        ) : null}
      </View>
      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        {...MOBILE_LIST_PERF_PROPS}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 32,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={segments.isRefetching && !segments.isLoading}
            onRefresh={() => void segments.refetch()}
            enabled={!gateNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          // Preset/template/AI starting points — collapsed, fetched only
          // when opened, hidden while the gate is closed (every source is a
          // live read) and while a search is narrowing the catalogue.
          !gateNotice && !debouncedQ ? (
            <StartingPointsSection
              onPick={(seed) => {
                setDescribeSeed(seed);
                setDescribeOpen(true);
              }}
            />
          ) : null
        }
        ListEmptyComponent={
          // Error first — a failed load is never "you have no segments".
          segments.isLoading ? (
            <SkeletonList rows={5} />
          ) : segments.isError ? (
            <ErrorState
              error={segments.error}
              onRetry={() => void segments.refetch()}
            />
          ) : gateNotice ? (
            <CachedSessionNotice notice={gateNotice} />
          ) : debouncedQ ? (
            <EmptyState
              title="No segments match"
              description={`Nothing matches "${debouncedQ}".`}
              cta={{ label: "Clear search", onPress: () => setQ("") }}
            />
          ) : (
            <EmptyState
              title="No segments yet"
              description="Describe the people you want to reach and Moosewave turns it into a rule you can check before saving."
              cta={{
                label: "Describe an audience",
                onPress: () => setDescribeOpen(true),
              }}
            />
          )
        }
      />
      <DescribeAudienceSheet
        visible={describeOpen}
        onClose={() => {
          setDescribeOpen(false);
          setDescribeSeed(null);
        }}
        seed={describeSeed}
        canSave={saveGate.canSave}
        {...(saveGate.reason ? { saveDisabledReason: saveGate.reason } : {})}
        onSaved={(saved) => {
          toast({ kind: "success", message: `Saved “${saved.name}”` });
          void segments.refetch();
        }}
      />
      <SegmentCompareSheet
        visible={compareOpen}
        onClose={() => setCompareOpen(false)}
        segments={all}
      />
    </SafeAreaView>
  );
}
