/**
 * SequenceParticipants — who is actually moving through this journey, and who
 * has stopped moving.
 *
 * Desktop's participants drawer is the largest single sequence-debugging
 * surface it ships; mobile had none of it, so "did my welcome flow reach
 * anyone?" was unanswerable away from a desk.
 *
 * Two decisions worth stating:
 *
 *  - IT RENDERS INSIDE THE CANVAS'S SCROLLER, as StepCanvas's `footer`, not as
 *    a second scrollable stacked beside it. Nested vertical scrollables on a
 *    phone make both of them feel broken.
 *  - ITS ZERO-STATE NAMES THE RUNTIME. Participants derive from
 *    `sequence_funnel_events`, and nothing writes that table while delivery is
 *    unqualified, so an empty list is the EXPECTED answer today. A generic
 *    "No results" would blame the operator's filter for a platform boundary.
 *    See lib/sequenceParticipants.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";

import { Card } from "@/components/Card";
import {
  Pager,
  SectionHeading,
  SectionNotice,
  rowStyle,
} from "@/components/sequences/SectionChrome";
import { ChipRow } from "@/components/ChipRow";
import { Pill } from "@/components/Pill";
import { SkeletonList } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { plural, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_SEQUENCE_RUNTIME_AVAILABLE } from "@/lib/sequenceCapabilities";
import {
  PARTICIPANTS_PAGE_SIZE,
  PARTICIPANT_FILTERS,
  participantStatusPresentation,
  participantsSectionState,
  stuckRowSpoken,
  stuckSectionState,
  type ParticipantStatusFilter,
} from "@/lib/sequenceParticipants";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  useSequenceParticipants,
  useStuckParticipants,
} from "@/hooks/useSequences";
import { SequenceFunnelSummary } from "@/components/sequences/SequenceFunnelSummary";
import type {
  SequenceParticipantWire,
  StuckParticipantWire,
} from "@/api/sequences";

export function SequenceParticipantsSection({
  id,
  visible,
}: {
  id: string | undefined;
  /** False offline or before the sequence loaded — these are live-only reads. */
  visible: boolean;
}) {
  const [filter, setFilter] = useState<ParticipantStatusFilter>("all");
  const [page, setPage] = useState(1);
  const query = useSequenceParticipants(id, filter, page);

  const onFilter = useCallback((next: ParticipantStatusFilter) => {
    haptics.tap();
    setFilter(next);
    setPage(1);
  }, []);

  if (!visible) return null;

  const payload = query.data?.data ?? null;
  const rows = Array.isArray(payload?.items) ? payload?.items : [];
  const total = payload?.total ?? 0;
  const state = participantsSectionState({
    loading: query.isLoading,
    status: query.data?.error?.status ?? (query.isError ? 500 : 0),
    ...(query.data?.error?.message
      ? { message: query.data.error.message }
      : {}),
    rowCount: rows.length,
    filter,
    runtimeQualified: MOBILE_SEQUENCE_RUNTIME_AVAILABLE,
  });
  const pageCount = Math.max(1, Math.ceil(total / PARTICIPANTS_PAGE_SIZE));

  return (
    <Card style={{ marginTop: 16, gap: 10 }}>
      <SectionHeading
        title="Participants"
        detail={
          state.kind === "rows"
            ? `${plural(total, "subscriber")} in this journey`
            : undefined
        }
      />
      <ChipRow<ParticipantStatusFilter>
        options={PARTICIPANT_FILTERS}
        value={filter}
        onChange={onFilter}
        accessibilityLabel="Filter participants by state"
        paddingHorizontal={0}
      />
      {state.kind === "loading" ? (
        <SkeletonList rows={3} lines={2} />
      ) : state.kind === "rows" ? (
        <View style={{ gap: 8 }}>
          {rows.map((row) => (
            <ParticipantRow
              key={`${row.subscriber_id || row.email}-${row.entered_at}`}
              row={row}
            />
          ))}
          {pageCount > 1 ? (
            <Pager
              page={page}
              pageCount={pageCount}
              onChange={(next) => {
                haptics.tap();
                setPage(next);
              }}
            />
          ) : null}
        </View>
      ) : (
        <SectionNotice state={state} onRetry={() => void query.refetch()} />
      )}
    </Card>
  );
}

export function SequenceStuckSection({
  id,
  visible,
}: {
  id: string | undefined;
  visible: boolean;
}) {
  const query = useStuckParticipants(id, visible);
  if (!visible) return null;

  const payload = query.data?.data ?? null;
  const rows = Array.isArray(payload?.items) ? payload?.items : [];
  const state = stuckSectionState({
    loading: query.isLoading,
    status: query.data?.error?.status ?? (query.isError ? 500 : 0),
    ...(query.data?.error?.message
      ? { message: query.data.error.message }
      : {}),
    rowCount: rows.length,
    thresholdDays: payload?.threshold_days ?? 0,
    runtimeQualified: MOBILE_SEQUENCE_RUNTIME_AVAILABLE,
  });

  return (
    <Card style={{ marginTop: 12, gap: 10 }}>
      <SectionHeading
        title="Stuck participants"
        detail={
          state.kind === "rows"
            ? `Idle longer than ${plural(payload?.threshold_days ?? 0, "day")}`
            : undefined
        }
      />
      {state.kind === "loading" ? (
        <SkeletonList rows={2} lines={2} />
      ) : state.kind === "rows" ? (
        <View style={{ gap: 8 }}>
          {rows.map((row) => (
            <StuckRow key={`${row.subscriber_id || row.email}`} row={row} />
          ))}
        </View>
      ) : (
        <SectionNotice state={state} onRetry={() => void query.refetch()} />
      )}
    </Card>
  );
}

/* ---------------- pieces ------------------------------------------- */
function ParticipantRow({ row }: { row: SequenceParticipantWire }) {
  const { t } = useTheme();
  const status = participantStatusPresentation(row.status);
  const entered = row.entered_at ? relativeTime(row.entered_at) : null;
  const step = Math.max(1, Math.trunc(row.current_step || 0));
  // The subscriber row is gone for "exited" participants whose record was
  // deleted; navigating to a profile that does not exist is worse than a row
  // that simply does not navigate.
  const canOpen = Boolean(row.subscriber_id);
  const label = `${row.email || "Unknown subscriber"}. ${status.label}. On step ${step}.${entered ? ` Entered ${entered}.` : ""}`;

  const body = (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("callout")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
        >
          {row.email || "Unknown subscriber"}
        </Text>
        <Pill label={status.label} tone={status.tone} />
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Step {step}
        {entered ? ` · entered ${entered}` : ""}
      </Text>
    </View>
  );

  if (!canOpen) {
    return (
      <View
        accessible
        accessibilityLabel={`${label} This subscriber's record no longer exists.`}
        style={rowStyle(t.borderSubtle)}
      >
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${label}`}
      onPress={() => {
        haptics.tap();
        router.push({
          pathname: "/(tabs)/subscribers/[id]",
          params: { id: row.subscriber_id },
        });
      }}
      style={rowStyle(t.borderSubtle)}
    >
      {body}
    </Pressable>
  );
}

function StuckRow({ row }: { row: StuckParticipantWire }) {
  const { t } = useTheme();
  const idle = Math.max(0, Math.trunc(row.idle_days));
  return (
    <View
      accessible
      accessibilityLabel={stuckRowSpoken(row)}
      style={rowStyle(t.borderSubtle)}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("callout")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
        >
          {row.email || "Unknown subscriber"}
        </Text>
        {/* Tone alone never carries the reading — the label says the days. */}
        <Pill label={`Idle ${plural(idle, "day")}`} tone="warning" />
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        Waiting at step {Math.max(1, Math.trunc(row.current_step || 0))}
      </Text>
    </View>
  );
}

/**
 * Every live section in one node, so the detail screen hands StepCanvas a
 * single `footer` and keeps its own branch count for the read states.
 */
export function SequenceLiveSections({
  id,
  visible,
}: {
  id: string | undefined;
  visible: boolean;
}) {
  return (
    <>
      <SequenceFunnelSummary id={id} visible={visible} />
      <SequenceParticipantsSection id={id} visible={visible} />
      <SequenceStuckSection id={id} visible={visible} />
    </>
  );
}
