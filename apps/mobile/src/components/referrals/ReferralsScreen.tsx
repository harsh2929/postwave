/**
 * Referrals — the inspection surface (COMMERCE#26 / MAP#43).
 *
 * THE BANNER IS CONDITIONAL NOW, AND THAT IS THE POINT. This screen used to
 * open with an unconditional "the referral runtime is off — the public referral
 * redirect is unmounted and no new conversion is being credited". Every clause
 * of that was true when it was written and every clause is false now:
 * `OperationalRuntimeAvailable` is `true`, so the public redirect at
 * /api/public/r/{code} is mounted and conversions are being credited. An app
 * asserting a false fact about live data is worse than an app saying nothing,
 * so the banner is gated on `REFERRAL_RUNTIME_AVAILABLE` — it is the mirror of
 * the Go constant, and lib/referrals.boundary.test.ts fails the build if the
 * two drift apart again.
 *
 * WHAT THE SCREEN READS. Three routes mount unconditionally (programme, funnel,
 * leaderboard) and three more mount behind that same gate: the payout
 * fulfilment ledger, the programme's A/B variants, and — per explicit tap, one
 * referrer at a time — the subscriber link that MAP#43 wanted the share sheet
 * for. The gated reads are `enabled` on the flag, so a future close of the gate
 * stops them at the client rather than collecting 404s.
 *
 * ORDER IS THE ARGUMENT. The programme comes first because "what does it give
 * away" is the frame for "how many took it". The funnel is second. Fulfilment
 * is third — it is the only outstanding-work reading on the screen and it
 * belongs above a ranked list nobody has to act on. Top referrers, the one act
 * with a verb, comes next, and the leaderboard is last because it is the only
 * scrolling element and a phone should not scroll past a list to reach a
 * summary.
 */
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Chip } from "@/components/Chip";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { ReferralFunnelCard } from "@/components/referrals/ReferralFunnelCard";
import { ReferralLeaderboardRow } from "@/components/referrals/ReferralLeaderboardRow";
import { ReferralNotice } from "@/components/referrals/ReferralNotice";
import { ReferralPayoutsCard } from "@/components/referrals/ReferralPayoutsCard";
import { ReferralProgramCard } from "@/components/referrals/ReferralProgramCard";
import { ReferralProgramEditSheet } from "@/components/referrals/ReferralProgramEditSheet";
import { ReferralTopReferrersCard } from "@/components/referrals/ReferralTopReferrersCard";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { REFERRAL_ADMIN_MINIMUM_ROLE } from "@/lib/referralAdmin";
import { useAuthStore } from "@/store/auth";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useReferralLeaderboard,
  useReferralPayouts,
  useReferralProgram,
  useReferralStats,
  useReferralVariants,
} from "@/hooks/useReferrals";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import {
  DEFAULT_REFERRAL_WINDOW,
  REFERRAL_EMPTY_WINDOW_DESCRIPTION,
  REFERRAL_RUNTIME_AVAILABLE,
  REFERRAL_WINDOWS,
  type ReferralLeaderboardRow as Row,
} from "@/lib/referrals";
import { useTheme } from "@/lib/theme";

export function ReferralsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  useScreenViewed("referrals");

  const [window, setWindow] = useState<string>(DEFAULT_REFERRAL_WINDOW);
  const [editOpen, setEditOpen] = useState(false);
  const stats = useReferralStats();
  const program = useReferralProgram();
  const leaderboard = useReferralLeaderboard(window);
  const payouts = useReferralPayouts();
  const variants = useReferralVariants();

  // The admin verbs (programme save, payout advance) are r.With(admin)
  // server-side AND mount only while the operational runtime gate is open —
  // with the gate closed every one of those routes is a 404, so the mirrored
  // constant gates the affordances the same way it gates the reads.
  // API-key sessions fail closed as everywhere.
  const mode = useAuthStore((s) => s.mode);
  const canAdmin =
    REFERRAL_RUNTIME_AVAILABLE &&
    canAccessMinimumRole(
      REFERRAL_ADMIN_MINIMUM_ROLE,
      gate.effectiveRole,
      mode,
    ) &&
    gate.enabled;

  const refresh = useManualRefresh(
    [
      stats.refetch,
      program.refetch,
      leaderboard.refetch,
      payouts.refetch,
      variants.refetch,
    ],
    { enabled: gate.enabled },
  );

  const rows = useMemo(() => (Array.isArray(leaderboard.data?.rows) ? leaderboard.data?.rows : []), [leaderboard.data]);
  const keyExtractor = useCallback(
    (row: Row, index: number) => `${row.rank}-${row.emailMasked}-${index}`,
    [],
  );
  const renderRow = useCallback<ListRenderItem<Row>>(
    ({ item }) => <ReferralLeaderboardRow row={item} />,
    [],
  );

  /**
   * The header is the whole non-scrolling half of the screen. It rides in
   * ListHeaderComponent rather than sitting above the FlatList so the funnel
   * and programme scroll away when the leaderboard is long, and so the pull-to-
   * refresh gesture covers the entire surface rather than the list alone.
   */
  const header = useMemo(
    () => (
      <View>
        {/* GATED ON THE MIRROR OF THE GO CONSTANT, not rendered unconditionally.
            The banner's every clause is a claim that the runtime is switched
            off; with `OperationalRuntimeAvailable` now true, showing it would
            tell the operator that live, credited conversions are frozen
            history. When the release gate closes again the flag flips and the
            banner returns with it. */}
        {REFERRAL_RUNTIME_AVAILABLE ? null : <ReferralNotice />}
        {/* THE PROGRAMME READ NEEDS ITS OWN FAILURE HANDLING, and it did not
            have any. `useReferralProgram` maps a 404 to `null` data — "no
            programme configured", a real resting state — and THROWS everything
            else, so a 500 or a dropped connection left `data` undefined with
            `isLoading` false. The card only knows three states (loading / none
            / configured), so it rendered the "none" copy: the screen told the
            operator their referral programme does not exist because a GET
            failed. `undefined` — and ONLY undefined — is "no answer yet", so
            that is the emptiness predicate: a `null` from the 404 still reaches
            the card and still reads "no programme configured", while a failure,
            a cold offline start and a first load each get their own state. */}
        <QueryStates
          query={program}
          isEmpty={program.data === undefined}
          gate={gate}
          offlineMessage="You're offline and the referral programme hasn't been cached yet. It'll load when you reconnect."
        >
          <ReferralProgramCard
            program={program.data ?? null}
            loading={program.isLoading}
            // Undefined until the variants read answers. The card renders no
            // split line for undefined AND for an empty array, but only the
            // array is an answer — a failed variants read must never be drawn
            // as "this programme has no A/B arms".
            variants={variants.data}
            // Only once the programme read has ANSWERED (data !== undefined):
            // the editor's full-replace body is built on what is stored, so
            // opening it against an unanswered read could erase a programme
            // that merely had not loaded yet.
            onEdit={
              canAdmin && program.data !== undefined
                ? () => setEditOpen(true)
                : null
            }
          />
        </QueryStates>
        {/* The funnel comes from a DIFFERENT query than the leaderboard, so it
            gets its own failure handling: a broken stats read must not blank
            the leaderboard, and vice versa. `isEmpty` is false because a funnel
            of zeroes is a real answer, not an empty result. */}
        <QueryStates query={stats} isEmpty={false} gate={gate}>
          <ReferralFunnelCard
            funnel={
              stats.data?.funnel ?? {
                conversions7d: null,
                conversions30d: null,
                conversions90d: null,
                clicksTotal: null,
                fraudFilteredCount: null,
              }
            }
            topReferrerCount={stats.data?.topReferrerCount ?? null}
          />
        </QueryStates>
        {/* Fulfilment is its own query and its own failure: a broken payouts
            read must not blank the funnel above it. `isEmpty` is false because
            "no rewards recorded" is an answer the card states in words — an
            EmptyState here would imply the read found nothing to show, which is
            the same sentence with less information. */}
        {REFERRAL_RUNTIME_AVAILABLE ? (
          <QueryStates query={payouts} isEmpty={false} gate={gate}>
            <ReferralPayoutsCard
              payouts={payouts.data ?? { rows: [], total: null }}
              canAdmin={canAdmin}
            />
          </QueryStates>
        ) : null}
        {/* Rides on the stats query rather than one of its own — the rows come
            out of the same /referrals/stats payload the funnel above already
            paid for. The per-referrer link is fetched inside the card, on tap
            only, because that request mints a code. */}
        {/* `Array.isArray`, not `?? []`: `??` substitutes only for null and
            undefined, so a truthy non-array out of the persisted cache would
            sail straight into the card's `.map`. lib/nullishArrayGuard.test.ts
            enforces this idiom across the app. */}
        <ReferralTopReferrersCard
          rows={
            Array.isArray(stats.data?.topReferrers) ? stats.data.topReferrers : []
          }
        />
        <SectionLabel subtitle="Emails are masked by the server; there is no drill-down.">
          Leaderboard
        </SectionLabel>
        <View
          style={{
            flexDirection: "row",
            gap: 6,
            flexWrap: "wrap",
            paddingHorizontal: 16,
            paddingBottom: 8,
          }}
        >
          {REFERRAL_WINDOWS.map((w) => (
            <Chip
              key={w.key}
              label={w.label}
              active={window === w.key}
              accessibilityLabel={`Rank referrers over the last ${w.label}`}
              onPress={() => setWindow(w.key)}
            />
          ))}
        </View>
      </View>
    ),
    [canAdmin, gate, payouts, program, stats, variants.data, window],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Referrals" onBack={goBackOrMore} />
      <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
          />
        }
        ListEmptyComponent={
          <QueryStates
            query={leaderboard}
            isEmpty={rows.length === 0}
            gate={gate}
            empty={{
              title: "No credited referrals in this window",
              // Owned by lib/referrals so the runtime clause cannot be
              // reintroduced here while the gate is open.
              description: REFERRAL_EMPTY_WINDOW_DESCRIPTION,
            }}
            offlineMessage="The referral leaderboard is not cached for offline reading."
          >
            <View />
          </QueryStates>
        }
        {...MOBILE_LIST_PERF_PROPS}
      />

      {/* The programme editor — admin-only entry from the card above. */}
      <ReferralProgramEditSheet
        visible={editOpen}
        program={program.data ?? null}
        onClose={() => setEditOpen(false)}
      />
    </SafeAreaView>
  );
}
