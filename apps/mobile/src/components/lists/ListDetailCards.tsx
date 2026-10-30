/**
 * The Overview and Growth cards of the list detail screen.
 *
 * Kept out of the route file so the screen stays a composition rather than
 * one 350-line function, and so the honest-empty rules (below) are stated
 * once instead of inline in a nested ternary.
 */
import { Text, View } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { SkeletonList } from "@/components/Skeleton";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import type { ListGrowth } from "@/api/listDetail";
import type { ListOption } from "@/hooks/useListOptions";
import { FONT } from "@/lib/fonts";
import { date as fmtDate, num, plural, signedPercent } from "@/lib/format";
import {
  gradeAccessibilityLabel,
  gradeTone,
  type ListHealthSummary,
} from "@/lib/listHealth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function DetailLine({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 4,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          flex: 1,
          fontFamily: FONT.regular,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function HealthBlock({
  health,
  isLoading,
  isError,
}: {
  health: ListHealthSummary | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const { t } = useTheme();
  if (isLoading) {
    return (
      <View style={{ marginTop: 6 }}>
        <SkeletonList rows={1} />
      </View>
    );
  }
  if (isError) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.danger,
          ...typeStyle("bodySmall"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        Couldn&apos;t score this list.
      </Text>
    );
  }
  if (!health?.grade) {
    // No grade is "not scored yet", never a green A.
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        Not scored yet.
      </Text>
    );
  }
  return (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
          flexWrap: "wrap",
        }}
      >
        {/* The letter is rendered as text, so tone is never the only
            carrier of the signal. */}
        <Pill
          label={`Grade ${health.grade}`}
          tone={gradeTone(health.grade)}
          size="md"
        />
        <Text
          accessibilityLabel={gradeAccessibilityLabel(
            health.grade,
            health.score,
          )}
          {...typeCap("numeric")}
          style={{
            color: t.fgMuted,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
          }}
        >
          {health.score == null ? "" : `${num(Math.round(health.score))}/100`}
        </Text>
      </View>
      {health.notes.map((note) => (
        <Text
          key={note}
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          {note}
        </Text>
      ))}
    </>
  );
}

export function ListOverviewCard({
  list,
  catalogueLoading,
  blocked,
  health,
  healthLoading,
  healthError,
}: {
  list: ListOption | null;
  catalogueLoading: boolean;
  /** The gate is closed, so "missing" means "not loaded", not "deleted". */
  blocked: boolean;
  health: ListHealthSummary | undefined;
  healthLoading: boolean;
  healthError: boolean;
}) {
  const { t } = useTheme();
  return (
    <Card>
      <Label>Overview</Label>
      <View style={{ marginTop: 6 }}>
        {list?.type ? <DetailLine label="Type" value={list.type} /> : null}
        {list?.optin ? <DetailLine label="Opt-in" value={list.optin} /> : null}
        {typeof list?.count === "number" ? (
          <DetailLine label="Members" value={num(list.count)} />
        ) : null}
        {list?.description ? (
          <DetailLine label="Description" value={list.description} />
        ) : null}
        {!list && catalogueLoading ? <SkeletonList rows={3} /> : null}
        {!list && !catalogueLoading && !blocked ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            This list is no longer in the catalogue.
          </Text>
        ) : null}
      </View>
      <View style={{ marginTop: 12 }}>
        <Label>Health</Label>
        <HealthBlock
          health={health}
          isLoading={healthLoading}
          isError={healthError}
        />
      </View>
    </Card>
  );
}

export function ListGrowthCard({
  growth,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  growth: ListGrowth | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  const points = growth?.points ?? [];
  const net = points.reduce((n, p) => n + p.net, 0);
  const start = (growth?.current ?? 0) - net;
  // A raw "+42" means nothing without the base it grew from.
  const ratio = start > 0 ? net / start : null;

  return (
    <Card>
      <Label>Growth</Label>
      {isLoading ? (
        <View style={{ marginTop: 8 }}>
          <SkeletonList rows={4} />
        </View>
      ) : isError ? (
        <View style={{ marginTop: 8 }}>
          <ErrorState error={error} onRetry={onRetry} />
        </View>
      ) : points.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          No membership changes in the last{" "}
          {plural(growth?.windowDays ?? 30, "day")}.
        </Text>
      ) : (
        <View style={{ marginTop: 8, gap: 8 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            {net >= 0 ? "+" : ""}
            {num(net)} net{ratio == null ? "" : ` (${signedPercent(ratio)})`}
          </Text>
          <TimeSeriesChart
            title="Members added vs removed"
            labels={points.map((p) => fmtDate(p.date, p.date))}
            series={[
              { id: "added", label: "Added", values: points.map((p) => p.added) },
              {
                id: "removed",
                label: "Removed",
                values: points.map((p) => p.removed),
              },
            ]}
            valueNoun="members"
          />
        </View>
      )}
    </Card>
  );
}

/**
 * The Members section's own header: skeleton on first load, error before
 * empty, and the honest "N of M" count line.
 *
 * It lives beside the other two cards so the route file stays a
 * composition — the ternary ladder for this alone pushed the screen
 * function past its complexity budget.
 */
export function ListMembersHeader({
  isLoading,
  isError,
  error,
  onRetry,
  blocked,
  query,
  loaded,
  total,
  canAdd = false,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  /** The gate is closed: "no members" would be a lie. */
  blocked: boolean;
  query: string;
  loaded: number;
  total: number | undefined;
  /**
   * The "Add members" control is on screen for this session. The empty state
   * must not send the operator to a subscriber profile or the web admin while
   * the button that does it sits directly above the sentence.
   */
  canAdd?: boolean;
}) {
  const { t } = useTheme();
  if (isLoading) return <SkeletonList rows={6} />;
  if (isError) return <ErrorState error={error} onRetry={onRetry} />;
  if (loaded === 0) {
    if (blocked) return null;
    return (
      <EmptyState
        title={query ? "No members match" : "No members yet"}
        description={
          query
            ? `Nothing matches "${query}" on this list.`
            : canAdd
              ? "Use Add members to search subscribers and put them on this list."
              : "Add subscribers to this list from a subscriber profile or the web admin."
        }
      />
    );
  }
  const line =
    typeof total === "number" && total > loaded
      ? `Showing ${num(loaded)} of ${plural(total, "member")}`
      : plural(loaded, "member");
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgMuted,
        ...typeStyle("label"),
        marginBottom: 8,
        fontFamily: FONT.regular,
      }}
    >
      {line}
    </Text>
  );
}
