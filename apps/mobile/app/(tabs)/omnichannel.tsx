/**
 * Omnichannel — the cross-channel definitions, finally visible from a phone.
 *
 * WHAT WAS MISSING. Desktop has a 731-line OmnichannelSection inside
 * Automations; mobile had no form of this at all, so a definition that spans
 * email + SMS + WhatsApp was invisible away from a desk even as a READ. This
 * screen is that read and only that read.
 *
 * THE HONESTY THIS SURFACE LIVES OR DIES BY. Omnichannel EXECUTION is
 * deliberately fail-closed: `omnichannelRuntimeQualified` is the compile-time
 * constant `false` (omnichannel.go:22), every catalog channel reports
 * `runtime_status: "unavailable"`, and every campaign response is stamped with
 * the same `runtimecapability.Descriptor`. Nothing dispatches. That makes this
 * the easiest screen in the app to misread as a delivery monitor — a row whose
 * status says "sending" is a value in a column, not a sender's report — so
 * `OmnichannelRuntimeNotice` states it at the top of the list and again inside
 * every definition, sourced from the server's own descriptor so it disappears
 * by itself the day the runtime is qualified.
 *
 * WHY IT IS VIEWER. All three reads are mounted behind a single
 * `RequireScope(ScopeReadCampaigns)` (omnichannel.go:145-147), and
 * `ScopeReadCampaigns` is in the `readOnlyScopes` allowlist
 * (apikeys/middleware.go:332-337), so `requireAdminRoleForScopes` is false and
 * the session-role branch never runs. The generated routeauth manifest
 * independently says `session_minimum_role: "viewer"` for each. Both
 * middlewares agree, so no client-side floor is added: gating above the
 * server's own answer hides a surface the API is happy to serve.
 *
 * NO WRITES, AND EACH OMISSION HAS A REASON — see the header of
 * src/api/omnichannel.ts. In short: authoring is a ten-path form with a
 * basis-point invariant, and every execution verb answers a deliberate 503.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { OmnichannelCampaignRow } from "@/components/omnichannel/OmnichannelCampaignRow";
import { OmnichannelDetailSheet } from "@/components/omnichannel/OmnichannelDetailSheet";
import { OmnichannelRuntimeNotice } from "@/components/omnichannel/OmnichannelRuntimeNotice";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useOmnichannelCampaigns,
  useOmnichannelCatalog,
} from "@/hooks/useOmnichannel";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import {
  claimsRuntimeState,
  matchesOmniQuery,
  OMNI_STATUS_FILTERS,
  type OmniCampaignDefinition,
  type OmniStatusFilter,
} from "@/lib/omnichannelDefinitions";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary };

const FILTER_LABELS: Record<OmniStatusFilter, string> = {
  all: "All",
  draft: "Draft",
  scheduled: "Scheduled",
  sent: "Sent",
  paused: "Paused",
};

const EMPTY_ALL = {
  title: "No cross-channel definitions",
  description:
    "An omnichannel definition groups up to ten channel paths — email, SMS, WhatsApp, RCS, push — under one plan with a traffic split between them. They are authored on desktop; once one exists, the channels it spans and the state of each path show up here.",
};

export default function OmnichannelScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  useScreenViewed("omnichannel");

  const [filter, setFilter] = useState<OmniStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  // The status filter is a SERVER predicate, not a client one: the list is
  // capped at 200 rows, so filtering after the cap would hide rows the filter
  // was supposed to surface.
  const campaigns = useOmnichannelCampaigns(filter);
  // The catalog is only used to say "your definition names a channel the schema
  // does not list", so its failure degrades to claiming nothing rather than to
  // an error on the list.
  const catalog = useOmnichannelCatalog();
  const refresh = useRefreshControl(campaigns);

  const all = useMemo(
    () => (Array.isArray(campaigns.data) ? campaigns.data : []),
    [campaigns.data],
  );
  const rows = useMemo(
    () => all.filter((campaign) => matchesOmniQuery(campaign, query)),
    [all, query],
  );
  const open = useMemo(
    () => all.find((campaign) => campaign.id === openId) ?? null,
    [all, openId],
  );
  const anyLiveSounding = useMemo(
    () => rows.some(claimsRuntimeState),
    [rows],
  );

  const closeSheet = useCallback(() => setOpenId(null), []);
  const changeFilter = useCallback((next: OmniStatusFilter) => {
    setFilter(next);
    // The open sheet is fed from the list; a filter change can evict its row.
    setOpenId(null);
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Omnichannel"
        {...(campaigns.data
          ? {
              subtitle: `${all.length} ${all.length === 1 ? "definition" : "definitions"} · ${FILTER_LABELS[filter]}`,
            }
          : {})}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
        <SegmentedControl
          accessibilityLabel="Definition status"
          scrollable
          options={OMNI_STATUS_FILTERS.map((value) => ({
            value,
            label: FILTER_LABELS[value],
          }))}
          value={filter}
          onChange={changeFilter}
        />
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search definitions and channels"
          accessibilityLabel="Search omnichannel definitions by name or channel"
          resultCount={rows.length}
          resultNoun="definition"
        />
      </View>

      <FlatList
        keyboardDismissMode="on-drag"
        data={campaigns.data === undefined ? [] : rows}
        keyExtractor={(campaign) => campaign.id}
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
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        ListHeaderComponent={
          rows.length > 0 ? (
            <View style={{ marginBottom: 12 }}>
              <OmnichannelRuntimeNotice
                runtime={catalog.data?.runtime ?? rows[0]?.runtime ?? null}
                statusIsLiveSounding={anyLiveSounding}
              />
            </View>
          ) : null
        }
        ListFooterComponent={
          rows.length > 0 ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              Definitions are authored, validated and cloned on desktop. This
              screen exists so a cross-channel plan is readable away from one —
              open a definition to see its paths, its traffic split and anything
              that would fail validation.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <QueryStates
            query={campaigns}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so your omnichannel definitions can't be loaded. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={4} />}
            empty={
              query.trim()
                ? {
                    title: "No match",
                    description:
                      "No definition's name, path or channel contains that. Clear the search to see them all.",
                  }
                : filter === "all"
                  ? EMPTY_ALL
                  : {
                      title: `No ${FILTER_LABELS[filter].toLowerCase()} definitions`,
                      description:
                        "Nothing in this workspace carries that status. Switch to All to see every definition.",
                    }
            }
          >
            {null}
          </QueryStates>
        }
        renderItem={({ item }: { item: OmniCampaignDefinition }) => (
          <OmnichannelCampaignRow
            campaign={item}
            onPress={(campaign) => setOpenId(campaign.id)}
          />
        )}
      />

      <OmnichannelDetailSheet
        campaign={open}
        catalog={catalog.data ?? null}
        onClose={closeSheet}
      />
    </SafeAreaView>
  );
}
