/**
 * LifecycleSection — the declared stage vocabulary versus the occupied one.
 *
 * Mobile's port of desktop's LifecycleDistributionCard: one bar per stage,
 * zero-filled from the catalog so an empty stage is visibly empty rather
 * than missing, unknown stages appended so every counted subscriber is
 * accounted for. Self-contained (owns its query) so the analytics screen's
 * mount stays one line inside its own CardBoundary.
 *
 * Three deliberate silences:
 *  - `data === null` → the deployment has no lifecycle routes; render
 *    NOTHING rather than an error a user cannot act on.
 *  - the section is informational only — no stage is tappable, because no
 *    list endpoint takes a lifecycle filter and a chip that appears to
 *    filter but does not is worse than no chip. LIFECYCLE_EDIT_NOTE says
 *    where the write actually lives.
 *  - offline with nothing cached → nothing; the screen-level notice owns
 *    that state.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { useLifecycleDistribution } from "@/hooks/useLifecycleDistribution";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import {
  LIFECYCLE_EDIT_NOTE,
  LIFECYCLE_EMPTY_COPY,
  lifecycleRowSpokenLabel,
  type LifecycleStageView,
} from "@/lib/lifecycleDistribution";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TITLE = "Lifecycle stages";

export function LifecycleSection() {
  const { t } = useTheme();
  const query = useLifecycleDistribution();

  if (query.isLoading) {
    return (
      <View style={{ marginTop: 24 }}>
        <SectionLabel>{TITLE}</SectionLabel>
        <SkeletonCard />
      </View>
    );
  }

  if (query.isError) {
    return (
      <View style={{ marginTop: 24 }}>
        <SectionLabel>{TITLE}</SectionLabel>
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          compact
        />
      </View>
    );
  }

  const view = query.data;
  // undefined = the query never ran (offline, no tenant); null = the
  // deployment has no lifecycle routes. Neither is worth a region.
  if (view === undefined || view === null) return null;

  return (
    <View style={{ marginTop: 24 }}>
      <SectionLabel subtitle="Every active subscriber, bucketed by lifecycle stage.">
        {TITLE}
      </SectionLabel>
      <View
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          padding: 14,
          gap: 10,
        }}
      >
        {view.total === 0 ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {LIFECYCLE_EMPTY_COPY}
          </Text>
        ) : (
          view.rows.map((row) => (
            <StageBar key={row.stage || row.label} row={row} t={t} />
          ))
        )}
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {LIFECYCLE_EDIT_NOTE}
        </Text>
      </View>
    </View>
  );
}

/** One stage: label + count on the left, share bar underneath. */
function StageBar({ row, t }: { row: LifecycleStageView; t: ThemeTokens }) {
  return (
    <View accessible accessibilityLabel={lifecycleRowSpokenLabel(row)}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {row.label}
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {num(row.count)}
        </Text>
      </View>
      <View
        style={{
          marginTop: 4,
          height: 6,
          borderRadius: 3,
          backgroundColor: t.surface,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            // A non-zero count always shows at least a sliver, so a 0.4%
            // stage does not render identically to an empty one.
            width: `${row.count > 0 ? Math.max(row.pct, 2) : 0}%`,
            height: 6,
            borderRadius: 3,
            backgroundColor: t.accent,
          }}
        />
      </View>
    </View>
  );
}
