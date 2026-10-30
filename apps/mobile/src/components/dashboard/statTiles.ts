/**
 * statTiles — the six headline numbers as DATA, before anything draws them.
 *
 * Split out of DashboardStatGrid.tsx (DASHBOARD#83): moving the tile COPY into
 * the message catalogue pushed that file past its 450-line ceiling, and the
 * honest cut is the one that was already implicit in it. Everything here is
 * derivation — which numbers exist, what each is called, what it says out loud,
 * which movement it reports, where tapping it goes, and in what order the
 * device shows them. Nothing here renders, and nothing here imports React
 * Native. The component is left with layout and interaction only.
 *
 * Every user-facing string is read from `lib/messagesEn` through `msg()`,
 * including the four whole VoiceOver frames — `src/lib/i18nCoverage.test.ts`
 * fails the build if a literal comes back.
 */
import {
  pickActiveSequences,
  pickAnomaly,
  pickBounceRate,
  pickCampaignsSent30d,
  pickClickRate,
  pickOpenRate,
  pickPreviousBounceRate,
  pickPreviousCampaignsSent,
  pickPreviousClickRate,
  pickPreviousOpenRate,
  pickSparkline,
  pickSubscribersDelta30d,
  pickSubscribersTotal,
  type DashboardRange,
  type DashboardStats,
} from "@/hooks/useDashboard";
import {
  countDelta,
  neutralDelta,
  rateDelta,
  type MetricDelta,
} from "@/lib/dashboardMetrics";
import {
  MOBILE_TILE_KEYS,
  visibleTiles,
  type MobileTileKey,
} from "@/lib/dashboardLayout";
import { EMDASH, compactNum, num, percent } from "@/lib/format";
import { msg } from "@/lib/i18n";
import { tileSpokenSentence } from "@/lib/dashboardTileSpeech";

export type TileRoute =
  | "/(tabs)/subscribers"
  | "/(tabs)/analytics"
  | "/(tabs)/campaigns"
  | "/(tabs)/sequences";

export interface Tile {
  key: MobileTileKey;
  label: string;
  value: string;
  spoken: string;
  numeric: number | undefined;
  delta: MetricDelta | null;
  route: TileRoute;
  destination: string;
  /** Daily series drawn under the tile, when the server bucketed one. */
  sparkline?: number[] | undefined;
  /** Server-detected spike for this metric over the trailing window. */
  anomaly?: boolean | undefined;
  anomalyReason?: string | undefined;
  /**
   * The metric id the anomaly-brief endpoint accepts for this tile, when it
   * accepts one. `subscribers` is charted here but is NOT on that whitelist,
   * so its long-press menu offers Share and no Explain — better than an
   * Explain that fails with `invalid_metric`.
   */
  briefMetric?: string | undefined;
}

/**
 * Said out loud after the value, and printed under the badge. Written as a
 * fact about the measurement rather than an instruction, because the phone
 * cannot know whether a bounce spike is a bad list or a provider incident.
 */
function bounceAnomalyReason(): string {
  return msg("dashboard.tile.anomaly.bounces");
}

/**
 * `spoken` is the VALUE only, never the label. The Pressable below announces
 * `${label}, ${spoken}`, so a `spoken` that repeats the noun made VoiceOver say
 * "Subscribers, 12,345 subscribers, open subscribers". What it must carry is
 * the EXACT figure, because the visible one is compacted to fit the tile.
 */
function countTile(
  value: number | null,
): Pick<Tile, "value" | "spoken" | "numeric"> {
  return {
    value: value === null ? EMDASH : compactNum(value),
    spoken: value === null ? msg("dashboard.tile.notReported") : num(value),
    numeric: value ?? undefined,
  };
}

function rateTile(
  value: number | null,
): Pick<Tile, "value" | "spoken" | "numeric"> {
  return {
    value: value === null ? EMDASH : percent(value),
    spoken:
      value === null ? msg("dashboard.tile.notReported") : percent(value),
    numeric: undefined,
  };
}

function subscriberDelta(
  net: number | null,
  range: DashboardRange,
): MetricDelta | null {
  if (net === null) return null;
  if (net === 0) {
    return { dir: "flat", text: msg("dashboard.tile.delta.flat", { range }) };
  }
  return {
    dir: net > 0 ? "up" : "down",
    text: msg(net > 0 ? "dashboard.tile.delta.up" : "dashboard.tile.delta.down", {
      count: Math.abs(net),
      range,
    }),
  };
}

export function buildTiles(
  stats: DashboardStats | undefined,
  range: DashboardRange,
): Tile[] {
  const openRate = pickOpenRate(stats);
  const clickRate = pickClickRate(stats);
  const bounceRate = pickBounceRate(stats);
  const sent = pickCampaignsSent30d(stats);

  return [
    {
      key: "subscribers",
      label: msg("dashboard.tile.subscribers"),
      ...countTile(pickSubscribersTotal(stats)),
      delta: subscriberDelta(pickSubscribersDelta30d(stats), range),
      route: "/(tabs)/subscribers",
      destination: msg("dashboard.tile.destination.subscribers"),
      // Subscribers is the ONLY tile that gets a trend line, and the same
      // restraint the desktop grid shows: the other series the server buckets
      // (opens/clicks/bounces) are gross event counts, and drawing a gross
      // count under a unique-recipient RATE would be a chart of a different
      // number than the one printed above it.
      sparkline: pickSparkline(stats, "subscribers") ?? undefined,
    },
    {
      key: "open-rate",
      label: msg("dashboard.tile.openRate"),
      ...rateTile(openRate),
      delta: rateDelta(openRate, pickPreviousOpenRate(stats)),
      route: "/(tabs)/analytics",
      destination: msg("dashboard.tile.destination.analytics"),
      briefMetric: "opens",
    },
    {
      key: "click-rate",
      label: msg("dashboard.tile.clickRate"),
      ...rateTile(clickRate),
      delta: rateDelta(clickRate, pickPreviousClickRate(stats)),
      route: "/(tabs)/analytics",
      destination: msg("dashboard.tile.destination.analytics"),
      briefMetric: "clicks",
    },
    {
      key: "bounce-rate",
      label: msg("dashboard.tile.bounceRate"),
      ...rateTile(bounceRate),
      // A rise in bounces is bad news; the up-arrow's success colour would
      // assert the opposite, so the movement is reported in neutral ink.
      delta: neutralDelta(rateDelta(bounceRate, pickPreviousBounceRate(stats))),
      route: "/(tabs)/analytics",
      destination: msg("dashboard.tile.destination.analytics"),
      // `anomalies` only ever carries `bounces` (analytics.go), and it is
      // populated only alongside the sparklines — which is why this badge
      // could not exist while the phone asked for `sparklines=false`.
      anomaly: pickAnomaly(stats, "bounces"),
      anomalyReason: bounceAnomalyReason(),
      briefMetric: "bounces",
    },
    {
      key: "sent",
      label: msg("dashboard.tile.sent", { range }),
      ...countTile(sent),
      delta: countDelta(sent, pickPreviousCampaignsSent(stats)),
      route: "/(tabs)/campaigns",
      destination: msg("dashboard.tile.destination.campaigns"),
    },
    {
      key: "sequences",
      label: msg("dashboard.tile.sequences"),
      ...countTile(pickActiveSequences(stats)),
      delta: null,
      route: "/(tabs)/sequences",
      destination: msg("dashboard.tile.destination.sequences"),
    },
  ];
}

/**
 * Apply the saved order and the device's hidden set to the built tiles.
 *
 * Order and visibility arrive from two different authorities on purpose — see
 * lib/dashboardLayout.ts — so they are applied in one place here rather than
 * being braided into `buildTiles`, which is only responsible for the numbers.
 */
export function arrangeTiles(
  tiles: readonly Tile[],
  order: readonly MobileTileKey[] | undefined,
  hidden: readonly MobileTileKey[] | undefined,
): Tile[] {
  const byKey = new Map(tiles.map((tile) => [tile.key, tile]));
  const resolved = order && order.length > 0 ? order : MOBILE_TILE_KEYS;
  // `visibleTiles` guarantees a non-empty result: a grid configured out of
  // existence is indistinguishable from a broken screen.
  return visibleTiles(resolved, hidden ?? [])
    .map((key) => byKey.get(key))
    .filter((tile): tile is Tile => tile !== undefined);
}

// Re-exported so the grid imports its data model from one place. The RULE
// itself lives in lib/dashboardTileSpeech, which is import-free and therefore
// unit-tested under node (house rule: policy in a module a node test can load).
export { tileSpokenSentence };
