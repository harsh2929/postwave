/**
 * CampaignListRow — one campaign in the list.
 *
 * Extracted from campaigns.tsx (which had grown past its size budget) and
 * given the four things the inline version was missing:
 *
 *   - A LABELLED date. "Mar 3" previously meant "sent on Mar 3" for one row
 *     and "created on Mar 3" for the next, and a campaign scheduled for next
 *     Tuesday showed the day it was CREATED.
 *   - CLICK rate as well as open rate. The Go list handler attaches both to
 *     every row; mobile read only open_rate, through an unsafe cast.
 *   - An A/B badge on genuine A/B parents.
 *   - Swipe actions. Every row was a bare Pressable that only opened the
 *     detail; duplicate/delete are now one gesture away — and, because
 *     SwipeableRow republishes them as accessibilityActions, one rotor
 *     action away for VoiceOver too.
 *
 * NativeWind v4: every Pressable `style` here is a STATIC object. The
 * function form silently drops layout.
 */
import { Link } from "expo-router";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SwipeableRow, type SwipeAction } from "@/components/SwipeableRow";
import { useDensityMetrics } from "@/hooks/useRowDensity";
import { isCampaignAbTest } from "@/lib/campaignAbTest";
import { MIN_TOUCH_TARGET } from "@/lib/displayPreferences";
import {
  campaignRate,
  campaignRatePercent,
  campaignRowDate,
  campaignStatusLabel,
  campaignTone,
  type CampaignRateScale,
} from "@/lib/campaignFormat";
import type { Campaign } from "@/hooks/useCampaigns";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignListRowProps {
  campaign: Campaign;
  actions?: readonly SwipeAction[] | undefined;
  /**
   * Selection mode (see hooks/useCampaignSelection). When active the row stops
   * navigating and becomes a checkbox — a tap that opened the detail while a
   * bulk delete was being assembled would be the worst possible misfire.
   */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: ((id: string) => void) | undefined;
  onBeginSelect?: ((id: string) => void) | undefined;
}

/**
 * The LIST endpoint ships 0..1 fractions — `attachListRates` in
 * apps/api/internal/campaigns/repo.go divides and does not multiply. The
 * REPORT endpoint on the detail screen ships 0..100; that is why the scale is
 * named at each call site instead of inferred from the number's magnitude.
 */
const LIST_RATE_SCALE: CampaignRateScale = "fraction";

/**
 * A 3px rate bar. Plain View + percentage width — no charting dependency.
 *
 * The width comes from the SAME scaling function as the printed number
 * (campaignRatePercent), so the bar can never disagree with the label beside
 * it — it previously carried its own inlined copy of the magnitude guess.
 */
function RateBar({ value, color }: { value: number; color: string }) {
  const { t } = useTheme();
  const pct = campaignRatePercent(value, LIST_RATE_SCALE) ?? 0;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        height: 3,
        borderRadius: 2,
        backgroundColor: t.borderSubtle,
        overflow: "hidden",
        marginTop: 3,
      }}
    >
      <View style={{ width: `${pct}%`, height: 3, backgroundColor: color }} />
    </View>
  );
}

function RateCell({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const { t } = useTheme();
  return (
    <View style={{ flexBasis: 78, flexGrow: 0 }}>
      <Text
        {...typeCap("badgeSmall")}
        style={{
          color: t.fgMuted,
          fontSize: 11,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {campaignRate(value, { scale: LIST_RATE_SCALE })} {label}
      </Text>
      <RateBar value={value} color={color} />
    </View>
  );
}

function CampaignListRowInner({
  campaign: c,
  actions,
  selecting = false,
  selected = false,
  onToggleSelect,
  onBeginSelect,
}: CampaignListRowProps) {
  const { t } = useTheme();
  const density = useDensityMetrics();
  // NAME first, subject as fallback — matching desktop's CampaignListView
  // (`campaign.name ?? campaign.subject ?? "Untitled"`, used for the row and
  // all three aria-labels). `name` is what the operator called this campaign;
  // `subject` is what recipients see and can differ per A/B variant, so
  // leading with it labels the same campaign differently on different screens.
  // Observed in-app: a campaign named "QA Campaign" with subject "FIRST" read
  // as "FIRST" in this list and "QA Campaign" in its own detail modals.
  const title = c.name || c.subject || "Untitled";
  const when = campaignRowDate(c);
  const statusLabel = campaignStatusLabel(c.status);
  const isAb = isCampaignAbTest(c);
  const id = String(c.id);

  const spoken = [
    `Campaign ${title}`,
    statusLabel,
    when ? `${when.prefix} ${when.absolute}` : null,
    typeof c.open_rate === "number"
      ? `${campaignRate(c.open_rate, { scale: LIST_RATE_SCALE })} open rate`
      : null,
    typeof c.click_rate === "number"
      ? `${campaignRate(c.click_rate, { scale: LIST_RATE_SCALE })} click rate`
      : null,
    isAb ? "A/B test" : null,
  ]
    .filter(Boolean)
    .join(", ");

  // Selection is carried by a border, a filled disc AND the accessibilityState
  // — never by the tint alone, which is invisible to a third of the people who
  // will use it.
  const container = {
    backgroundColor: t.surface,
    borderColor: selected ? t.accent : t.borderSubtle,
    borderWidth: selected ? 2 : 1,
    borderRadius: 14,
    // Padding compensates for the thicker selected border so the row's outer
    // box is identical in both states — otherwise every tap nudges the rest of
    // the list by a pixel and the whole column appears to twitch. The base
    // number is the user's density preference (LOVE#51); compact removes AIR
    // only, never type size.
    padding: selected ? density.rowPadding - 1 : density.rowPadding,
    marginBottom: density.rowSpacing,
    // Never below the 44pt target — asserted in displayPreferences.test.ts.
    minHeight: MIN_TOUCH_TARGET,
  } as const;

  const body = (
    <>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        {selecting ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              borderWidth: 2,
              borderColor: selected ? t.accent : t.border,
              backgroundColor: selected ? t.accent : "transparent",
              marginTop: 1,
            }}
          />
        ) : null}
        <View style={{ flex: 1 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontSize: 15,
            fontWeight: "600",
            fontFamily: FONT.semibold,
            // Tenant content can be RTL — a Hebrew or Arabic subject must
            // not render into a left-aligned Latin-ordered line.
            writingDirection: "auto",
          }}
          numberOfLines={1}
        >
          {title}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginTop: 8,
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Pill label={statusLabel} tone={campaignTone(c.status)} />
          {isAb ? <Pill label="A/B" tone="info" /> : null}
          {when ? (
            <Text
              {...typeCap("badgeSmall")}
              style={{
                color: t.fgSubtle,
                fontSize: 11,
                fontVariant: ["tabular-nums"],
                fontFamily: FONT.regular,
              }}
            >
              {when.prefix} {when.relative}
            </Text>
          ) : null}
        </View>
        {typeof c.open_rate === "number" || typeof c.click_rate === "number" ? (
          <View
            style={{
              flexDirection: "row",
              gap: 12,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            {typeof c.open_rate === "number" ? (
              <RateCell label="open" value={c.open_rate} color={t.success} />
            ) : null}
            {typeof c.click_rate === "number" ? (
              <RateCell label="click" value={c.click_rate} color={t.accent} />
            ) : null}
          </View>
        ) : null}
        </View>
      </View>
    </>
  );

  // In selection mode the row must NOT be a <Link>: expo-router's Link
  // navigates on press regardless of what the child's onPress does, so a tap
  // meant to tick a checkbox would push the detail screen.
  if (selecting) {
    return (
      <Pressable
        onPress={() => onToggleSelect?.(id)}
        accessibilityRole="checkbox"
        accessibilityLabel={spoken}
        accessibilityState={{ checked: selected }}
        accessibilityHint={
          selected
            ? "Removes this campaign from the selection."
            : "Adds this campaign to the selection."
        }
        style={container}
      >
        {body}
      </Pressable>
    );
  }

  const row = (
    <Link
      href={{
        pathname: "/(tabs)/campaigns/[id]",
        params: { id: String(c.id) },
      }}
      asChild
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint="Opens the campaign's report and actions."
        {...(onBeginSelect
          ? {
              onLongPress: () => onBeginSelect(id),
              delayLongPress: 350,
              // A long press is invisible to VoiceOver, so it is republished
              // as a rotor action alongside the swipe actions below.
              accessibilityActions: [
                { name: "select", label: "Select campaigns" },
              ],
              onAccessibilityAction: (event: {
                nativeEvent: { actionName: string };
              }) => {
                if (event.nativeEvent.actionName === "select") {
                  onBeginSelect(id);
                }
              },
            }
          : {})}
        style={container}
      >
        {body}
      </Pressable>
    </Link>
  );

  if (!actions || actions.length === 0) return row;
  return (
    <SwipeableRow right={actions} accessibilityLabel={spoken}>
      {row}
    </SwipeableRow>
  );
}

export const CampaignListRow = memo(CampaignListRowInner);
