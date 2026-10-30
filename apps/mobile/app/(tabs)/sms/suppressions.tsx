/**
 * SMS suppression roster — exact-admin, tenant-bound, response-cutoff state.
 *
 * Email and SMS suppressions are different authority rosters with different
 * routes. A provider-authenticated STOP row is locked carrier/source state;
 * a manual row is a reversible workspace hold. The email suppressions screen
 * could not show either SMS source, so from a phone there was no way to answer
 * "what suppression state did the protected roster return at this cutoff?"
 * It does not certify carrier receipt, current consent, law, or a live send.
 *
 * Removing a reversible manual hold gets typed confirmation rather than an
 * undo toast. Removal only changes future eligibility under this one stored
 * authority; it does not restore consent or prove that dispatch is available.
 *
 * It also carries stored quiet-hours and keyword policy rows in a collapsed
 * panel. Their device-time evaluation is policy input only; SMS dispatch and
 * callbacks remain release-held, so the panel makes no live hold/delivery claim.
 */
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { TapToTextSheet } from "@/components/growth/TapToTextSheet";
import { SmsPolicyPanel } from "@/components/sms/SmsPolicyPanel";
import { SmsInboxBoundary } from "@/components/sms/SmsInboxBoundary";
import { SmsSuppressionRow } from "@/components/sms/SmsSuppressionRow";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useSmsSuppressionRoster } from "@/hooks/useSmsSuppressionRoster";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import type { SmsSuppression } from "@/lib/suppressionContracts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function SmsSuppressions() {
  const { t } = useTheme();
  const [tapToText, setTapToText] = useState(false);
  const now = useNowTicker();
  const roster = useSmsSuppressionRoster();
  useScreenViewed("sms-suppressions");
  const {
    access,
    canAddManual,
    canWrite,
    list,
    listAccess,
    loaded,
    merged,
    mutationReady,
    onAdd,
    onRemove,
    q,
    rows,
    searchPhone,
    setQ,
    writeBusy,
  } = roster;
  const refresh = useManualRefresh([list.refreshFirstPage]);

  const renderItem = useCallback(
    ({ item: row }: { item: SmsSuppression }) => (
      <SmsSuppressionRow
        mutationReady={mutationReady}
        now={now}
        onRemove={onRemove}
        row={row}
        writeBusy={writeBusy}
      />
    ),
    [mutationReady, now, onRemove, writeBusy],
  );

  if (!access.roleAllowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="SMS suppressions" onBack={goBackOrMore} />
        <SmsInboxBoundary
          title="SMS suppressions are restricted"
          message={
            access.denialReason ??
            "Only workspace owners and admins may request customer SMS suppression data."
          }
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="SMS suppressions"
        subtitle={
          loaded && merged.value
            ? `${rows.length} shown · ${merged.value.total} reported at response cutoff`
            : undefined
        }
        onBack={goBackOrMore}
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Exact US/Canada number lookup…"
          accessibilityLabel="Look up SMS suppression by exact number"
          // The live status below qualifies the server's count by response
          // cutoff. SearchField's bare "N numbers" announcement would imply a
          // current tenant total, which snapshotAt cannot prove.
        />
        {/* The tap-to-text block generator is a GROWTH artifact, not an SMS
            conversation verb: it mints an `sms:` link, its paste-ready anchor
            and a local QR entirely on device. It lands here because this is
            where desktop hosts it (SmsSuppressions), and because a phone is
            the only place you can test the link against a real composer. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Generate a tap-to-text block"
          onPress={() => setTapToText(true)}
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            marginTop: 8,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            Tap-to-text block…
          </Text>
        </Pressable>
        <TapToTextSheet
          visible={tapToText}
          onClose={() => setTapToText(false)}
        />
        {canAddManual && searchPhone ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add manual hold for ${searchPhone}`}
            disabled={writeBusy}
            onPress={onAdd}
            style={{
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              marginTop: 8,
              borderRadius: 10,
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {writeBusy ? "Manual hold change pending…" : "Add manual hold"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
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
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 8 }}>
            <SmsPolicyPanel canWrite={canWrite} />
            {loaded && merged.value ? (
              <Text
                accessibilityLiveRegion="polite"
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.medium,
                }}
              >
                {merged.value.hasMore
                  ? `${rows.length} of ${merged.value.total} rows loaded for this response cutoff; more are available.`
                  : `${plural(merged.value.total, "matching suppression")} reported for this response cutoff; no continuation cursor returned. Newer changes may still exist.`}
              </Text>
            ) : null}
            {list.isError && rows.length > 0 ? (
              <View
                accessibilityRole="alert"
                style={{
                  borderColor: t.warning,
                  borderWidth: 1,
                  borderRadius: 10,
                  padding: 10,
                  gap: 6,
                }}
              >
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.warning,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.medium,
                  }}
                >
                  The current suppression read failed. Rows below are from an
                  earlier response and may be stale; do not treat them as a
                  current roster.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry SMS suppression read"
                  onPress={() => void list.refreshFirstPage()}
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
                    Retry verified read
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={
          list.hasNextPage ? (
            <Pressable
              onPress={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
              accessibilityRole="button"
              accessibilityState={{ disabled: list.isFetchingNextPage }}
              style={{
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {list.isFetchingNextPage
                  ? "Loading…"
                  : "Load more suppressions"}
              </Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          searchPhone === null ? (
            <SmsInboxBoundary
              title="Enter an exact US/Canada number"
              message="Suppression lookup uses an exact +1 phone identity; partial and international searches make no request."
            />
          ) : merged.error ? (
            <SmsInboxBoundary
              title="Suppression response rejected"
              message="The page failed response-cutoff, total, duplicate, order, timestamp, or authority checks. No rows were shown."
            />
          ) : (
            <QueryStates
              query={list}
              gate={{ enabled: listAccess.canRequest }}
              isEmpty={rows.length === 0}
              skeleton={<SkeletonList rows={5} />}
              offlineMessage="You're offline, so the SMS opt-out list can't be read. It'll load when you reconnect."
              empty={{
                title: q ? "No exact SMS suppression" : "No SMS suppressions",
                description: q
                  ? "The verified response reported no suppression for that exact US/Canada number; newer changes may still exist."
                  : "Manual holds and authoritative STOP, carrier, complaint, and system suppressions appear here when the verified read succeeds.",
              }}
            >
              {null}
            </QueryStates>
          )
        }
      />
    </SafeAreaView>
  );
}
