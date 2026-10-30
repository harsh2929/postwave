/**
 * RevenueSection — what the programme earned, and how much of that email can
 * honestly claim.
 *
 * Backed by GET /api/v1/conversions/attribution/campaigns
 * (apps/api/internal/conversions/attribution.go). Revenue was the one number
 * with no mobile surface at all, which made the phone unusable for the person
 * most likely to be holding one.
 *
 * The card is built around the three disclosures the Go handler goes out of its
 * way to send, because a revenue figure without them is a claim rather than a
 * measurement:
 *
 *  - ATTRIBUTED IS NOT TOTAL. The headline is attributed revenue; the total is
 *    printed beside it with the share. Leading with the total would credit
 *    email with money it never touched.
 *  - LAST TOUCH IS A HEURISTIC. The provenance split is shown whenever the
 *    server sends one, and the caveat is SIZED by it: a window that is mostly
 *    explicitly tagged says so quietly, one that is mostly last-touch says so
 *    loudly.
 *  - ONE CURRENCY IS SUMMED. Every figure here is in the dominant currency; a
 *    mixed-currency workspace is told what is missing rather than shown a
 *    quietly short total.
 *
 * All of that reasoning lives in `lib/revenueAttribution`, which is import-free
 * and tested; this file only renders.
 */
import { useCallback } from "react";
import { router } from "expo-router";
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { BarChart, type BarDatum } from "@/components/charts/BarChart";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { money, num, percent, plural } from "@/lib/format";
import {
  attributedCents,
  attributedShare,
  centsToMajor,
  excludedCurrencies,
  heuristicShare,
  isTruncated,
  provenanceRows,
  type RevenueAttribution,
} from "@/lib/revenueAttribution";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Above this share of last-touch attribution the figure is an estimate rather
 * than a measurement, and the card says so in the warning tone instead of as a
 * footnote. Half is the natural line: below it, most of the revenue was tagged
 * by the sender.
 */
const HEURISTIC_WARNING_SHARE = 0.5;

/** Rows charted before the rest fold into "Other". */
const CHART_ROWS = 6;

export interface RevenueSectionProps {
  query: QueryLike;
  report: RevenueAttribution | undefined;
  gate: Pick<OnlineQueryGate, "enabled">;
  rangeLabel: string;
}

export function RevenueSection({
  query,
  report,
  gate,
  rangeLabel,
}: RevenueSectionProps) {
  const { t } = useTheme();
  const currency = report?.currency ? report.currency.toUpperCase() : null;
  const attributed = report ? attributedCents(report) : 0;
  const share = report ? attributedShare(report) : null;
  const rows = report ? provenanceRows(report.provenance) : [];
  const heuristic = report ? heuristicShare(report.provenance) : null;
  const excluded = report ? excludedCurrencies(report) : [];

  // "Nothing to show" is a window with no money AND no attributed conversions
  // — not merely an empty `items` array, which is also what a window of
  // non-monetary conversions looks like.
  const empty =
    !report ||
    (report.totalRevenueCents === 0 && report.provenance.total === 0);

  const data: BarDatum[] = (report?.items ?? [])
    .filter((item) => item.revenueCents > 0)
    .map((item) => ({
      id: item.id,
      label: item.name,
      value: centsToMajor(item.revenueCents),
      hint: hintFor(item, currency),
    }));

  // The bar IS the campaign, and the obvious next question about the campaign
  // that earned the most is "what did it say". `id` here is the server's
  // `campaign_id` (attribution.go AttributionItem), the same key
  // /(tabs)/campaigns/[id] is addressed by — so this is a real destination,
  // not a tap that reveals a tooltip. BarChart withholds the press branch from
  // its folded "Other" row on its own, which is the one row with no id to
  // navigate to.
  const onPressCampaign = useCallback((datum: BarDatum) => {
    router.push({
      pathname: "/(tabs)/campaigns/[id]",
      params: { id: datum.id },
    });
  }, []);

  return (
    <View>
      <SectionLabel topMargin={20}>Revenue</SectionLabel>
      <Card style={{ gap: 12 }}>
        <QueryStates
          query={query}
          isEmpty={empty}
          gate={gate}
          skeleton={<SkeletonCard lines={4} />}
          empty={{
            title: "No attributed revenue yet",
            description:
              "Revenue appears here once a conversion is recorded against a campaign in this window.",
          }}
        >
          {report ? (
            <>
              <Headline
                attributedCents={attributed}
                totalCents={report.totalRevenueCents}
                share={share}
                currency={currency}
                conversions={report.provenance.total}
                rangeLabel={rangeLabel}
              />

              {rows.length > 0 ? (
                <View style={{ gap: 6 }}>
                  <Text
                    {...typeCap("caption")}
                    style={{
                      color: t.fgMuted,
                      ...typeStyle("caption"),
                      letterSpacing: 0.6,
                      fontFamily: FONT.semibold,
                      textTransform: "uppercase",
                    }}
                  >
                    How these were attributed
                  </Text>
                  {rows.map((row) => (
                    <View
                      key={row.key}
                      accessible
                      accessibilityLabel={`${row.label}: ${plural(row.count, "conversion")}, ${percent(row.share, { digits: 0 })} of the window.`}
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <Text
                        {...typeCap("bodySmall")}
                        numberOfLines={2}
                        style={{
                          color: t.fgMuted,
                          ...typeStyle("bodySmall"),
                          fontFamily: FONT.regular,
                          flex: 1,
                        }}
                      >
                        {row.label}
                      </Text>
                      <Text
                        {...typeCap("numeric")}
                        style={{
                          color: t.fg,
                          ...typeStyle("numeric"),
                          fontFamily: FONT.medium,
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {percent(row.share, { digits: 0 })}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {heuristic !== null && heuristic > 0 ? (
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  {/* Tone AND words: the pill is never the only signal. */}
                  <Pill
                    label={
                      heuristic >= HEURISTIC_WARNING_SHARE
                        ? "Mostly estimated"
                        : "Partly estimated"
                    }
                    tone={
                      heuristic >= HEURISTIC_WARNING_SHARE
                        ? "warning"
                        : "neutral"
                    }
                  />
                  <Text
                    {...typeCap("label")}
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("label"),
                      fontFamily: FONT.regular,
                      flex: 1,
                    }}
                  >
                    {percent(heuristic, { digits: 0 })} was matched to a recent
                    click rather than tagged by the sender.
                  </Text>
                </View>
              ) : null}

              {data.length > 0 ? (
                <BarChart
                  data={data}
                  title={`Attributed revenue by campaign${currency ? ` · ${currency}` : ""}`}
                  valueNoun={currency ?? "revenue"}
                  maxRows={CHART_ROWS}
                  onPressRow={onPressCampaign}
                />
              ) : null}

              <Footnotes
                truncated={isTruncated(report)}
                listed={data.length}
                totalCampaigns={report.totalCampaigns}
                excluded={excluded.map((entry) => entry.currency.toUpperCase())}
                currency={currency}
              />
            </>
          ) : null}
        </QueryStates>
      </Card>
    </View>
  );
}

function hintFor(
  item: { conversions: number; emailsSent: number; revenuePerSendCents: number | null },
  currency: string | null,
): string {
  const parts = [plural(item.conversions, "conversion")];
  // Revenue per send is omitted by the server when `emails_sent` is 0 — there
  // is no honest denominator — so an absent value must not become "0.00".
  if (item.revenuePerSendCents !== null && currency) {
    parts.push(
      `${money(centsToMajor(item.revenuePerSendCents), currency, { cents: true })} per send`,
    );
  }
  return parts.join(" · ");
}

function Headline({
  attributedCents: attributed,
  totalCents,
  share,
  currency,
  conversions,
  rangeLabel,
}: {
  attributedCents: number;
  totalCents: number;
  share: number | null;
  currency: string | null;
  conversions: number;
  rangeLabel: string;
}) {
  const { t } = useTheme();
  // A window can hold conversions with no money in them at all (the server
  // omits `currency` in that case). Printing "$0.00" there would report a
  // failure the workspace did not have.
  const value = currency
    ? money(centsToMajor(attributed), currency)
    : num(conversions);
  const caption = currency
    ? `attributed of ${money(centsToMajor(totalCents), currency)} total${
        share === null ? "" : ` · ${percent(share, { digits: 0 })}`
      }`
    : `attributed conversions · no monetary value recorded`;

  return (
    <View
      accessible
      accessibilityLabel={`${value} ${caption}, ${rangeLabel}.`}
      style={{ gap: 2 }}
    >
      <Text
        {...typeCap("figure")}
        style={{
          color: t.fg,
          ...typeStyle("figure"),
          fontFamily: FONT.display,
          letterSpacing: -0.6,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {caption}
      </Text>
    </View>
  );
}

function Footnotes({
  truncated,
  listed,
  totalCampaigns,
  excluded,
  currency,
}: {
  truncated: boolean;
  listed: number;
  totalCampaigns: number;
  excluded: readonly string[];
  currency: string | null;
}) {
  const { t } = useTheme();
  const notes: string[] = [];
  if (truncated && totalCampaigns > 0) {
    notes.push(
      `Showing ${listed} of ${totalCampaigns} campaigns with attributed revenue.`,
    );
  }
  if (excluded.length > 0 && currency) {
    notes.push(
      `Figures are in ${currency}. Revenue in ${excluded.join(", ")} is recorded but not included in these sums.`,
    );
  }
  if (notes.length === 0) return null;
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {notes.join(" ")}
    </Text>
  );
}
