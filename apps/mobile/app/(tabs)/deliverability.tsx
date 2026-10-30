/**
 * Deliverability hub — "is our sending healthy, and if not, what broke?"
 *
 * Everything on this screen already existed server-side and was invisible on
 * mobile: GET /api/v1/deliverability/hub returns a 0-100 score, a grade, a
 * 30-sample history, per-send bounce/complaint/engagement rates, the threshold
 * breaches that tripped, the blocklist listings, and — the one that matters at
 * 2am — whether Moosewave has ALREADY auto-throttled this workspace's send rate.
 * Without it a phone user watching a campaign crawl had no way to learn that
 * the platform, not the campaign, was the cause.
 *
 * Design notes:
 *  - Snapshot-backed. "Are we throttled?" is exactly the question you want
 *    answered in a basement, and the payload is small enough to keep. The
 *    CachedNotice makes the provenance explicit so a cached answer is never
 *    mistaken for a live one.
 *  - Blocklist rows come from the DEDICATED endpoint rather than the hub's
 *    copy of them, because only that one carries `delist_url` — the difference
 *    between naming a problem and offering the fix.
 *  - It is a single SectionList so the whole thing is one virtualised scroll
 *    with a working pull-to-refresh, rather than nested scroll views.
 */
import { useCallback, useMemo } from "react";
import { RefreshControl, SectionList, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CachedNotice } from "@/components/deliverability/CachedNotice";
import { HubBanner } from "@/components/deliverability/HubBanner";
import { HubDiagnostics } from "@/components/deliverability/HubDiagnostics";
import { HubScoreCard } from "@/components/deliverability/HubScoreCard";
import {
  BlocklistCard,
  BreachCard,
  type BlocklistHitRow,
} from "@/components/deliverability/HubSections";
import { OpsCluster } from "@/components/deliverability/OpsCluster";
import { QueryStates } from "@/components/QueryStates";
import { RepairOverrideCard } from "@/components/deliverability/RepairOverrideCard";
import { ReplyMailboxPanel } from "@/components/deliverability/ReplyMailboxPanel";
import { ReputationResponseCard } from "@/components/deliverability/ReputationResponseCard";
import { SendingKillSwitchCard } from "@/components/deliverability/SendingKillSwitchCard";
import { InboxRealityTestsPanel } from "@/components/deliverability/InboxRealityTestsPanel";
import { TransactionalTriageSection } from "@/components/deliverability/TransactionalTriageSection";
import { VerificationJobsPanel } from "@/components/deliverability/VerificationJobsPanel";
import { VerificationProvidersCard } from "@/components/deliverability/VerificationProvidersCard";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonCard } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import {
  useBlocklistHits,
  useDeliverabilityHub,
} from "@/hooks/useDeliverability";
import { useDeliverabilityWidgetMirror } from "@/hooks/useDeliverabilityWidgetMirror";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  blocklistSummary,
  hubBanner,
  sortedBreaches,
} from "@/lib/deliverabilityHubView";
import { sideSignalNotice } from "@/lib/deliverabilitySignals";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { MOBILE_SECTION_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

type HubItem =
  | {
      kind: "breach";
      key: string;
      breach: {
        code: string;
        severity: string;
        title: string;
        detail: string;
        fixLabel?: string;
        fixHref?: string;
        fixSection?: string;
      };
    }
  | { kind: "blocklist"; key: string; hit: BlocklistHitRow }
  | { kind: "note"; key: string; text: string };

interface HubSection {
  title: string;
  caption: string;
  data: HubItem[];
}

export default function Deliverability() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const now = useNowTicker();
  const { toast } = useToast();
  useScreenViewed("deliverability");

  const hubQuery = useDeliverabilityHub();
  const blocklist = useBlocklistHits();
  const refresh = useManualRefresh([hubQuery.refetch, blocklist.refetch]);

  const hub = hubQuery.data?.value;
  // Mirror the score to the home-screen widget's App Group (DELIVERABILITY#64).
  // This screen is the only foreground writer of that record — sender health is
  // the number whose value is highest when it is checked PASSIVELY, and the
  // widget's empty state names this tab because nothing else can fill it in.
  useDeliverabilityWidgetMirror({ hub });
  const banner = useMemo(() => hubBanner(hub ?? null), [hub]);
  // Array.isArray, not `?? []`: the hub is SNAPSHOT-BACKED and
  // `loadSnapshotBacked`'s `isStored` guard validates only that the vault
  // record has a `value` and a numeric `capturedAt` — never the shape inside
  // it. `sortedBreaches` SPREADS what it is given and the hit fallback below
  // MAPS it, so a snapshot written by a build with a different payload took
  // down the one screen an operator opens to ask "are we throttled?".
  const breaches = useMemo(
    () => sortedBreaches(Array.isArray(hub?.breaches) ? hub.breaches : []),
    [hub],
  );

  // The dedicated blocklist read is a SIDE signal: when it fails we must not
  // imply "you are not listed anywhere". Fall back to the hub's own copy (no
  // delist links, but the listing is still named) and say so.
  // True when the rows on screen came from the hub payload rather than the
  // dedicated endpoint, i.e. `delist_url` and `delisting_status` are UNKNOWN
  // rather than absent. The cards must say so instead of asserting.
  const usingHubHits = !(blocklist.data && blocklist.data.length > 0);

  const hits: BlocklistHitRow[] = useMemo(() => {
    if (blocklist.data && blocklist.data.length > 0) {
      return blocklist.data.map((row) => ({
        id: row.id,
        listName: row.listName,
        identifier: row.identifier,
        tier1: row.tier1,
        firstSeenAt: row.firstSeenAt,
        delistUrl: row.delistUrl,
        delistingStatus: row.delistingStatus,
      }));
    }
    const hubHits = Array.isArray(hub?.blocklistHits) ? hub.blocklistHits : [];
    return hubHits.map((row) => ({
      id: `${row.subject}|${row.zone}`,
      listName: row.zone,
      identifier: row.subject,
      tier1: row.tier1,
      firstSeenAt: row.checkedAt,
      delistUrl: "",
      delistingStatus: "",
    }));
  }, [blocklist.data, hub]);

  // Offline, the side query never runs, so `isError` stays false — reporting
  // only on error left an offline reader with delist-less rows and no reason
  // for it. Treat "could not run" the same as "failed".
  const blocklistNotice = sideSignalNotice(
    "Delisting links",
    blocklist.isError || (!gate.enabled && hits.length > 0),
    !gate.enabled,
  );

  const onDelistFailed = useCallback(
    (message: string) => toast({ kind: "error", message }),
    [toast],
  );

  const sections: HubSection[] = useMemo(() => {
    const out: HubSection[] = [];
    out.push({
      title: "What's wrong",
      caption:
        breaches.length === 0
          ? "No thresholds are being breached."
          : `${breaches.length} threshold${breaches.length === 1 ? "" : "s"} breached`,
      data:
        breaches.length === 0
          ? [
              {
                kind: "note",
                key: "no-breaches",
                text: "Bounce, complaint and engagement rates are all inside their limits.",
              },
            ]
          : breaches.map((breach) => ({
              kind: "breach" as const,
              key: `breach-${breach.code || breach.title}`,
              breach,
            })),
    });
    const summary = blocklistSummary(hits);
    out.push({
      title: "Blocklists",
      caption: summary.caption || "No active listings in the last 30 days.",
      data:
        hits.length === 0
          ? [
              {
                kind: "note",
                key: "no-hits",
                text: "None of your sending identities appear on a monitored blocklist.",
              },
            ]
          : hits.map((hit) => ({
              kind: "blocklist" as const,
              key: `hit-${hit.id}`,
              hit,
            })),
    });
    return out;
  }, [breaches, hits]);

  const renderItem = useCallback(
    ({ item }: { item: HubItem }) => {
      if (item.kind === "breach") {
        return <BreachCard breach={item.breach} onFixFailed={onDelistFailed} />;
      }
      if (item.kind === "blocklist") {
        return (
          <BlocklistCard
            hit={item.hit}
            now={now}
            onDelistFailed={onDelistFailed}
            delistUnknown={usingHubHits}
          />
        );
      }
      return (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            marginBottom: 12,
            fontFamily: FONT.regular,
          }}
        >
          {item.text}
        </Text>
      );
    },
    [now, onDelistFailed, t, usingHubHits],
  );

  const computedLabel = hub?.computedAt
    ? `Computed ${relativeTime(hub.computedAt, { now })}`
    : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Deliverability"
        subtitle={computedLabel}
        onBack={goBackOrMore}
      />
      <SectionList
        sections={hub ? sections : []}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 8,
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
        {...MOBILE_SECTION_LIST_PERF_PROPS}
        ListHeaderComponent={
          <>
            <CachedNotice backing={hubQuery.data} now={now} />
            <HubBanner banner={banner} />
            {/* Directly under the banner that NAMES the throttle: the verb
                that releases it. Self-gating (renders nothing unless the hub
                says autoThrottled). */}
            <RepairOverrideCard
              key={`repair-override:${gate.tenantId ?? "unresolved"}:${gate.userId ?? "anonymous"}:${gate.effectiveRole ?? "unresolved"}:${hub?.autoThrottled ? "active" : "inactive"}`}
              hub={hub ?? null}
            />
            <SendingKillSwitchCard effectiveRole={gate.effectiveRole} />
            {/* Directly under the kill switch: both answer "make it stop", and
                this one carries the finer-grained brakes (suppress one listed
                IP, close the signup door) for when stopping everything is too
                blunt. */}
            <ReputationResponseCard />
            <VerificationJobsPanel />
            {/* Beside the jobs that spend the credits: WHICH vendor is
                spending them. Self-gating — admin-only, because the row points
                at a billable credential. */}
            <VerificationProvidersCard />
            {/* Beside the other in-flight resources: a broken reply mailbox is
                the same class of fact — something ingesting on your behalf has
                stopped. Self-gating when none are registered. */}
            <ReplyMailboxPanel />
            <TransactionalTriageSection />
            <InboxRealityTestsPanel />
            {hub ? (
              <HubScoreCard hub={hub} loading={hubQuery.isLoading} />
            ) : null}
            {blocklistNotice ? (
              <Text
                accessibilityRole="alert"
                {...typeCap("label")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("label"),
                  marginBottom: 10,
                  fontFamily: FONT.regular,
                }}
              >
                {blocklistNotice}
              </Text>
            ) : null}
            <QueryStates
              query={hubQuery}
              gate={gate}
              isEmpty={!hub}
              skeleton={
                <View style={{ gap: 12 }}>
                  <SkeletonCard lines={3} />
                  <SkeletonCard lines={2} />
                </View>
              }
              offlineMessage="You're offline and no deliverability snapshot has been saved yet. It'll load when you reconnect."
              empty={{
                title: "No deliverability data yet",
                description:
                  "Send a campaign and this workspace's score, breaches and blocklist status appear here.",
              }}
            >
              {null}
            </QueryStates>
          </>
        }
        // The follow-up questions live BELOW the alarms, because "which
        // provider is bouncing" is what you ask after you know something is
        // wrong — never instead of it. Each card owns its own read and its own
        // failure copy, so a dead side-fetch here cannot blank the hub.
        ListFooterComponent={
          hub ? (
            <>
              <HubDiagnostics />
              {/* The recovery/evidence/policy cluster sits below the
                  diagnostics for the same reason the diagnostics sit below
                  the alarms: each answers a LATER question. */}
              <OpsCluster />
            </>
          ) : null
        }
        renderSectionHeader={({ section }) =>
          hub ? (
            <View style={{ marginTop: 8, marginBottom: 8 }}>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.bold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                }}
              >
                {section.title}
              </Text>
              {section.caption ? (
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("label"),
                    marginTop: 2,
                    fontFamily: FONT.regular,
                  }}
                >
                  {section.caption}
                </Text>
              ) : null}
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}
