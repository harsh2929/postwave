/**
 * PrivacyIncidentsScreen — an on-call view of recorded incident state and the
 * legacy operational response target.
 *
 * See the route file for why this surface exists and where its authorization
 * comes from. This file owns the composition: the register, its headline, the
 * detail sheet, the declare sheet, and the live (non-closure) transition rail.
 *
 * WHAT IS KNOWN is decided in hooks/usePrivacyIncidentsScreen — including the
 * three empty-looking states that mean completely different things (a loaded
 * empty register, a refused read, a failed read) and the ticking clock. This
 * file renders those verdicts and adds none of its own.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { DeclareIncidentSheet } from "@/components/privacy-incidents/DeclareIncidentSheet";
import { IncidentDetailSheet } from "@/components/privacy-incidents/IncidentDetailSheet";
import { IncidentRegisterEmpty } from "@/components/privacy-incidents/IncidentRegisterEmpty";
import { IncidentRegisterHeader } from "@/components/privacy-incidents/IncidentRegisterHeader";
import { IncidentRow } from "@/components/privacy-incidents/IncidentRow";
import { usePrivacyIncidentsScreen } from "@/hooks/usePrivacyIncidentsScreen";
import { EMDASH } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { incidentRegisterSubtitle } from "@/lib/privacyIncidentCopy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function PrivacyIncidentsScreen() {
  const { t } = useTheme();
  const screen = usePrivacyIncidentsScreen();
  const {
    read,
    write,
    incidents,
    detail,
    events,
    refresh,
    dataState,
    page,
    now,
    rows,
    counts,
    openIncident,
    canAttemptProtectedReads,
    countsUnknown,
    openRow,
    closeSheet,
    keyExtractor,
  } = screen;

  // A REFUSAL IS NOT AN EMPTY REGISTER. `read.known` is false only while the
  // session role is still unknown, and an unknown verdict is never rendered as
  // a decided one.
  if (read.known && !read.allowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Breach incidents" onBack={goBackOrMore} />
        <View style={{ padding: 16 }}>
          <MobileScopeNotice
            title="Breach incidents need an owner or admin role"
            body={read.notice ?? ""}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Breach incidents"
        subtitle={
          countsUnknown
            ? `${EMDASH} open`
            : incidentRegisterSubtitle(counts, Boolean(page?.truncated))
        }
        onBack={goBackOrMore}
        right={
          // Only a session that can WRITE the register gets the verb at all
          // (read.allowed here means owner/admin — same floor as the POST).
          // Offline it stays visible but inert: the person who just learned of
          // a breach should see the verb exists and why it cannot fire yet.
          read.allowed ? (
            <DeclareButton
              enabled={write.allowed}
              onPress={() => screen.setDeclaring(true)}
            />
          ) : null
        }
      />

      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={page === undefined ? [] : rows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 12,
          paddingBottom: 32,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={canAttemptProtectedReads}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <IncidentRegisterHeader
            dataState={dataState}
            headline={screen.headline}
            incidents={incidents}
            page={page}
            rows={rows}
            write={write}
          />
        }
        ListEmptyComponent={
          <IncidentRegisterEmpty
            dataState={dataState}
            forbidden={screen.forbidden}
            incidents={incidents}
            listFailed={screen.listFailed}
            restoredPageMalformed={screen.restoredPageMalformed}
            rows={rows}
          />
        }
        renderItem={({ item }) => (
          <IncidentRow incident={item} onPress={openRow} now={now} />
        )}
      />

      <IncidentDetailSheet
        incident={dataState === "hidden" ? null : openIncident}
        detail={
          detail.isFetching || detail.isError ? null : (detail.data ?? null)
        }
        detailLoading={detail.isLoading || detail.isFetching}
        detailFailed={detail.isError}
        // Same shape guard: IncidentActivityList reads `.length` and `.map`.
        events={
          events.isFetching || events.isError || !Array.isArray(events.data)
            ? []
            : events.data
        }
        eventsLoading={events.isLoading || events.isFetching}
        eventsFailed={events.isError}
        onClose={closeSheet}
        canTransition={write.allowed}
        transitionNotice={write.notice}
        onFreshReadNeeded={() => {
          void detail.refetch();
          void events.refetch();
        }}
        now={now}
      />

      <DeclareIncidentSheet
        visible={screen.declaring}
        onClose={() => screen.setDeclaring(false)}
        // The same live gate the detail sheet's rail reads: the sheet can
        // outlive the connection it was opened on.
        canDeclare={write.allowed}
        notice={write.notice}
      />
    </SafeAreaView>
  );
}

/**
 * The header verb. Kept visible-but-inert offline (accessibilityState says
 * so): the register's one urgent write should be discoverable at the moment
 * it is needed, and the offline notice below the header explains the pause.
 */
function DeclareButton({
  enabled,
  onPress,
}: {
  enabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        enabled
          ? "Declare a preliminary breach incident"
          : "Declare a preliminary breach incident. Needs a live connection."
      }
      accessibilityState={{ disabled: !enabled }}
      style={{
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 6,
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: enabled ? t.accent : t.fgSubtle,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          ...typeStyle("callout"),
        }}
      >
        Declare
      </Text>
    </Pressable>
  );
}
