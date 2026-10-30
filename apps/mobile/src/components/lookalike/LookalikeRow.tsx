/**
 * LookalikeRow — one modeled audience, triaged before any tap.
 *
 * The row answers three questions from the list wire alone, because
 * `ListLookalikes` selects the same columns `GetLookalike` does and the
 * `payload` jsonb rides along with them: did this model BUILD, how many people
 * did it actually match against how many were asked for, and how old is the
 * snapshot. Nothing here requires opening the sheet, which is the point.
 *
 * THE MEMBER COUNT IS SUPPRESSED WHILE THE MODEL IS UNFINISHED. A row whose
 * status is not 'ready' has a `member_count` that is not final — the column
 * defaults to 0 and only the terminal write fills it — so printing "0 members"
 * beside "Building" would be a confident lie about a number nobody has written
 * yet. It renders as an em-dash instead (house rule 8).
 *
 * TWO NUMBERS ARE SHOWN TWICE, DIFFERENTLY. The visible line compacts
 * ("4.2K of 5K"); the accessibility label carries the exact figures, because
 * compaction is precisely what a screen reader cannot recover.
 *
 * THE HEALTH PILL IS NEVER COLOUR-ALONE. It carries a word ("Failed", "Weak
 * match", "Short") plus a full spoken sentence, and the border tint is a second
 * channel rather than the only one.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { compactNum, date, EMDASH, num, plural, relativeTime } from "@/lib/format";
import {
  lookalikeHealthPresentation,
  lookalikeHealthState,
  isStaleLookalike,
  LOOKALIKE_STALE_DAYS,
} from "@/lib/lookalikeHealth";
import { lookalikeName, type LookalikeAudience } from "@/lib/lookalikeAudiences";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface LookalikeRowProps {
  audience: LookalikeAudience;
  onPress: (audience: LookalikeAudience) => void;
  /** Resolved from the segments catalogue; null when it could not be read. */
  seedName: string | null;
  /** `Date.now()` from the screen's ticker, so "3 weeks ago" stays honest. */
  now: number;
}

function LookalikeRowImpl({ audience, onPress, seedName, now }: LookalikeRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const state = lookalikeHealthState(audience);
  const health = lookalikeHealthPresentation(state);
  const settled = state !== "building" && state !== "unknown";
  const stale = isStaleLookalike(audience, now);

  // While the model is unfinished the count is not a measurement yet.
  const sizeLine = settled
    ? `${compactNum(audience.memberCount)} of ${compactNum(audience.sizeRequested)} asked for`
    : `${EMDASH} of ${compactNum(audience.sizeRequested)} asked for`;
  const sizeSpoken = settled
    ? `${plural(audience.memberCount, "member")} matched, out of ${num(
        audience.sizeRequested,
      )} asked for.`
    : `The member count is not final while the model is unfinished. ${num(
        audience.sizeRequested,
      )} were asked for.`;

  // A seed we could not resolve is named as unresolved, never invented and
  // never rendered as a bare uuid.
  const seedLine =
    seedName ?? (audience.seedSegmentId ? "Seed segment not resolved" : EMDASH);

  const builtLine = audience.createdAt
    ? `Built ${relativeTime(audience.createdAt, { now })}`
    : "Build date unknown";
  const builtSpoken = audience.createdAt
    ? `Built ${date(audience.createdAt)}.`
    : "Its build date was not recorded.";

  const alarming = health.tone === "danger" || health.tone === "warning";

  return (
    <Pressable
      onPress={() => onPress(audience)}
      accessibilityRole="button"
      accessibilityLabel={`${lookalikeName(audience)}. ${health.spoken} ${sizeSpoken} Seed: ${seedLine}. ${builtSpoken}${
        stale
          ? ` Older than ${LOOKALIKE_STALE_DAYS} days, so the seed segment has probably moved since.`
          : ""
      }`}
      accessibilityHint="Opens this model's quality breakdown, where you can also reveal a sample of its ranked members"
      style={{
        backgroundColor: t.surface,
        borderColor: alarming
          ? health.tone === "danger"
            ? t.danger
            : t.warning
          : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        gap: 6,
        // The content already exceeds the 44pt target floor; stating it keeps a
        // future compaction from dropping below.
        minHeight: 44,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {lookalikeName(audience)}
        </Text>
        <Pill
          label={health.label}
          tone={health.tone}
          accessibilityLabel={health.spoken}
        />
      </View>

      <Text
        numberOfLines={maxLinesAtScale(1, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {sizeLine}
      </Text>

      <Text
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {seedLine} {EMDASH} {builtLine}
      </Text>

      {stale ? (
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Built more than {LOOKALIKE_STALE_DAYS} days ago. A lookalike is a
          frozen snapshot — nothing re-runs it, so the seed has moved since.
        </Text>
      ) : null}
    </Pressable>
  );
}

export const LookalikeRow = memo(LookalikeRowImpl);
