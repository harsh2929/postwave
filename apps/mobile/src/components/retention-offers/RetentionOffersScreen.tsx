/**
 * RetentionOffersScreen — inspect stored retention configuration and history.
 *
 * WHY THIS IS A MONITOR AND NOT AN EDITOR, stated once here because it is the
 * single most important thing about the surface. `retention_offers` has a full
 * write side — `Upsert`, `Deactivate`, `LogEvent`, `PortalLookup`,
 * `PortalAccept`, `PortalDecline` — and NONE of it is mounted. The only
 * registration anywhere in the server calls `MountRoutes` from the main
 * composition and registers three GETs. The package
 * header says why: "Paid retention-offer mutations and portal acceptance
 * remain unmounted until a real Stripe adapter and reconciliation are
 * certified." An authoring form here would post to a 404, so there is none —
 * and the screen says so out loud rather than leaving the reader to wonder
 * where the edit button went.
 *
 * WHY THE ROUTE IS ADMIN. The three retention reads are mounted through
 * `apikeys.RequireExactTenantAdmin`; the supporting paywall-tier read has the
 * same owner/admin floor. The guard is invisible from handlers.go, which is
 * exactly the trap this screen was written to avoid: a deep-linked viewer must
 * issue zero protected requests, not mount four calls that can only return 403.
 *
 * WHAT A PHONE ANSWERS HERE. It reports stored rows and recorded counters. It
 * does not turn an `active` or `enabled` database flag into a claim that offer
 * authoring, portal acceptance, enrollment, or delivery is available.
 *
 * NativeWind v4: static style objects only.
 */
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { FunnelTotalsCard } from "@/components/retention-offers/FunnelTotalsCard";
import { ObservationList } from "@/components/retention-offers/ObservationList";
import { OfferFunnelRow } from "@/components/retention-offers/OfferFunnelRow";
import { RetentionOfferDetailSheet } from "@/components/retention-offers/RetentionOfferDetailSheet";
import { WinbackStatusCard } from "@/components/retention-offers/WinbackStatusCard";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import {
  usePaywallTierNames,
  useRetentionFunnel,
  useRetentionOffers,
  useRetentionOffersAccess,
  useWinbackSettings,
} from "@/hooks/useRetentionOffers";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { goBackOrMore } from "@/lib/nav";
import {
  funnelTotals,
  isRetentionScopeDenied,
  joinOffersToFunnel,
  retentionObservations,
} from "@/lib/retentionOffers";
import { RETENTION_WINBACK_RELEASE_HOLD_CODE } from "@/lib/retentionWinbackReleaseStatus";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const NO_TIER_NAMES: Record<string, string> = {};

export function RetentionOffersScreen() {
  const { t } = useTheme();
  const access = useRetentionOffersAccess();
  const gate = access.gate;
  useScreenViewed("retention-offers");

  const offers = useRetentionOffers();
  const funnel = useRetentionFunnel();
  const winback = useWinbackSettings();
  const tiers = usePaywallTierNames();

  const offerRows = useMemo(
    () => (!offers.isError && Array.isArray(offers.data) ? offers.data : []),
    [offers.data, offers.isError],
  );
  // `undefined` from TanStack means "not resolved". TanStack can also retain
  // the last good `data` after a failed refetch; because this phone surface has
  // no last-verified timestamp, rendering that cache as current would lie. An
  // error therefore wins over retained data and makes every count UNKNOWN.
  const tiles = funnel.isError ? null : (funnel.data ?? null);
  const tierNames = tiers.isError
    ? NO_TIER_NAMES
    : (tiers.data ?? NO_TIER_NAMES);
  const winbackSettings = winback.isError ? null : (winback.data ?? null);
  const rows = useMemo(
    () => joinOffersToFunnel(offerRows, tiles, tierNames),
    [offerRows, tiles, tierNames],
  );
  const totals = tiles === null ? null : funnelTotals(tiles);
  const observations = useMemo(
    () =>
      retentionObservations({
        offers: offerRows,
        tiles,
        winback: winbackSettings,
      }),
    [offerRows, tiles, winbackSettings],
  );

  const refresh = useManualRefresh(
    [offers.refetch, funnel.refetch, winback.refetch, tiers.refetch],
    { enabled: access.allowed },
  );

  // The reconciliation-evidence drill-down (desktop's RetentionOfferDetail):
  // the row shows the numbers, the sheet says whether to trust them.
  const [openOfferId, setOpenOfferId] = useState<string | null>(null);
  const openRow = useMemo(
    () => rows.find((row) => row.offer.id === openOfferId) ?? null,
    [rows, openOfferId],
  );

  const scopeDenied =
    !access.authorized ||
    isRetentionScopeDenied(offers.error) ||
    isRetentionScopeDenied(funnel.error) ||
    isRetentionScopeDenied(winback.error) ||
    isRetentionScopeDenied(tiers.error);
  const activeCount = offerRows.filter((offer) => offer.active).length;
  const subtitle =
    offers.data !== undefined && offerRows.length > 0
      ? `${plural(offerRows.length, "stored offer")} · ${num(activeCount)} marked active`
      : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Retention offers"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={access.allowed}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {scopeDenied ? (
          <MobileScopeNotice
            title={
              access.viewerMode
                ? "Exit viewer mode to inspect retention evidence"
                : "Needs an owner or admin session"
            }
            body={
              access.viewerMode
                ? "Viewer mode deliberately withholds every retention-offer read. Exit viewer mode before opening this admin-only evidence surface."
                : "Every retention-offer read on this server is admin-scoped, so this identity issued no protected requests. Use an owner or admin session."
            }
          />
        ) : (
          <>
            <MobileScopeNotice
              title="Stored retention evidence only"
              body={`This admin-only view reads stored offer rows, stored win-back settings, and aggregate event counters. It does not identify customers or prove offer presentation, acceptance, coupon application, or automated delivery. Authoring and dispatch remain unavailable (${RETENTION_WINBACK_RELEASE_HOLD_CODE}).`}
            />
            <QueryStates
              query={offers}
              gate={gate}
              isEmpty={offerRows.length === 0}
              offlineMessage="The offer funnel needs a connection. Reconnect and pull to refresh — this is not the same as having no offers."
              skeleton={
                <SkeletonList
                  rows={3}
                  lines={3}
                  label="Loading retention offers"
                />
              }
              empty={{
                title: "No retention offers yet",
                description:
                  "The read completed and returned no stored offer rows. No authoring surface or subscriber cancel-flow is mounted in this release.",
              }}
            >
              <SectionLabel topMargin={0}>Funnel, all offers</SectionLabel>
              <FunnelTotalsCard
                totals={totals}
                {...(funnel.isError
                  ? { onRetry: () => void funnel.refetch() }
                  : {})}
              />

              {observations.length > 0 ? (
                <View style={{ marginTop: 12 }}>
                  <ObservationList items={observations} />
                </View>
              ) : null}

              <SectionLabel topMargin={24}>Win-back</SectionLabel>
              <WinbackStatusCard
                settings={winbackSettings}
                unavailable={winback.isError || winback.data === undefined}
              />

              <SectionLabel topMargin={24}>Per tier</SectionLabel>
              {tiers.isError ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    marginBottom: 8,
                    fontFamily: FONT.regular,
                  }}
                >
                  Tier names didn&apos;t load, so rows show the tier id instead.
                </Text>
              ) : null}
              {rows.map((row) => (
                <OfferFunnelRow
                  key={row.offer.id}
                  row={row}
                  onPress={(pressed) => setOpenOfferId(pressed.offer.id)}
                />
              ))}
            </QueryStates>
          </>
        )}
      </ScrollView>

      <RetentionOfferDetailSheet
        row={openRow}
        // The UNJOINED tile list: duplicate detection needs every tile, not
        // the one the join picked. `undefined` (unresolved) maps to null.
        tiles={tiles}
        funnelPending={funnel.isLoading || funnel.isFetching}
        onClose={() => setOpenOfferId(null)}
      />
    </SafeAreaView>
  );
}
