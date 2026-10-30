/**
 * CutoverWatchSection — "is the old platform still receiving traffic?"
 *
 * GOVERNANCE#53. The verification report above this section answers "did the
 * import work". Once it has, the operator's job becomes a loop that runs for
 * days: watch the SOURCE account, and notice the moment it changes underneath
 * the new one. That loop needs a glance, not a desk, which is why it is here
 * and why it is the only part of the migrations surface that polls.
 *
 * THE HEADLINE IS THE PRODUCT. Everything below it is corroboration. The
 * ordering that produces it lives in lib/cutoverWatch.ts and is unit-tested,
 * because the dangerous case is subtle: a STOPPED monitor's frozen counters
 * are byte-identical to a live monitor's quiet ones, and "0 events since
 * cutover" off a stopped monitor is the sentence that loses a customer's data.
 *
 * ONE WRITE, IN THE SAFE DIRECTION ONLY. Mobile can RE-OPEN a manual-review
 * sign-off; it can never grant one. Granting requires a reconciliation
 * narrative plus auditable evidence references, hard-validated server-side —
 * a compliance record, and a phone is the wrong place to author one. Re-opening
 * puts a gate back and needs no body.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { Pill, type PillTone } from "@/components/Pill";
import { SkeletonList } from "@/components/Skeleton";
import { SourceEventReviewList } from "@/components/migrations/SourceEventReviewList";
import { useShadowWatch, useSourceEventWatch } from "@/hooks/useCutoverWatch";
import { useNowTicker } from "@/hooks/useNowTicker";
import {
  cutoverHeadline,
  pendingReviewCount,
  reviewedCount,
  shadowActionCopy,
  watchAgeCopy,
  type CutoverTone,
} from "@/lib/cutoverWatch";
import { dateTime, num } from "@/lib/format";
import { CARD_RADIUS } from "@/lib/shellStyleTokens";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TONE_PILL: Record<CutoverTone, PillTone> = {
  ok: "success",
  attention: "warning",
  danger: "danger",
  neutral: "neutral",
};

const TONE_WORD: Record<CutoverTone, string> = {
  ok: "clear",
  attention: "needs attention",
  danger: "blocked",
  neutral: "not running",
};

export interface CutoverWatchSectionProps {
  jobId: string | null;
  /** The job's lifecycle status; only `completed` has a watch to read. */
  status: string | undefined;
  online: boolean;
}

export function CutoverWatchSection({
  jobId,
  status,
  online,
}: CutoverWatchSectionProps) {
  const { t } = useTheme();
  const shadow = useShadowWatch(jobId, status);
  const events = useSourceEventWatch(jobId, status);
  const now = useNowTicker();

  if (String(status ?? "").toLowerCase() !== "completed") return null;

  const loading = shadow.isLoading || events.isLoading;
  // A failed fetch is an error state, never an empty list (house rule 8) —
  // "nothing is watching" and "we could not find out" are different sentences.
  const failure = shadow.error ?? events.error;

  const headline = cutoverHeadline({
    shadow: shadow.data ?? null,
    events: events.data ?? null,
  });
  const pending = pendingReviewCount(events.data ?? null);
  const reviewed = reviewedCount(events.data ?? null);
  const lastAction = shadowActionCopy(shadow.data?.lastAction);

  return (
    <View style={{ marginTop: 24 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        Cutover watch
      </Text>

      {loading ? (
        <View style={{ marginTop: 10 }}>
          <SkeletonList rows={2} lines={2} label="Loading the cutover watch" />
        </View>
      ) : failure ? (
        <View style={{ marginTop: 10 }}>
          <ErrorState
            error={failure}
            onRetry={() => {
              void shadow.refetch();
              void events.refetch();
            }}
          />
        </View>
      ) : (
        <>
          <View
            accessible
            // The tone is spoken as a word, never left to colour alone.
            accessibilityLabel={`Cutover watch, ${TONE_WORD[headline.tone]}. ${headline.headline}. ${headline.detail}`}
            style={{
              marginTop: 10,
              borderRadius: CARD_RADIUS,
              borderWidth: 1,
              borderColor:
                headline.tone === "danger" ? t.danger : t.borderSubtle,
              backgroundColor: t.bgSubtle,
              padding: 12,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontWeight: "700",
                  fontFamily: FONT.bold,
                  flex: 1,
                }}
              >
                {headline.headline}
              </Text>
              <Pill
                label={TONE_WORD[headline.tone]}
                tone={TONE_PILL[headline.tone]}
                size="sm"
              />
            </View>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                marginTop: 6,
                fontFamily: FONT.regular,
              }}
            >
              {headline.detail}
            </Text>
          </View>

          {shadow.data ? (
            <WatchLine
              title="Shadow check"
              value={lastAction.label}
              age={watchAgeCopy(shadow.data.lastCheckedAt, now)}
              nextAt={shadow.data.nextCheckAt}
              enabled={shadow.data.enabled}
            />
          ) : null}

          {events.data ? (
            <WatchLine
              title="Source events"
              // ABSENCE IS NOT ZERO: a monitor that has never synced reports no
              // count, which is not a report of no events.
              value={
                events.data.eventsSeen == null
                  ? "— seen"
                  : `${num(events.data.eventsSeen)} seen · ${
                      events.data.eventsApplied == null
                        ? "—"
                        : num(events.data.eventsApplied)
                    } replayed`
              }
              age={watchAgeCopy(events.data.lastSyncedAt, now)}
              nextAt={events.data.nextSyncAt}
              enabled={events.data.enabled}
            />
          ) : null}

          {pending > 0 || reviewed > 0 ? (
            <SourceEventReviewList
              jobId={jobId}
              status={status}
              online={online}
              rows={(Array.isArray(events.data?.events) ? events.data?.events : []).filter(
                (row) => !row.applied && row.action === "manual_review",
              )}
            />
          ) : null}

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 14,
              fontFamily: FONT.regular,
            }}
          >
            Starting or stopping a watch, and signing a review off, stay on the
            web app — a sign-off is an auditable record that needs its evidence
            attached.
          </Text>
        </>
      )}
    </View>
  );
}

function WatchLine({
  title,
  value,
  age,
  nextAt,
  enabled,
}: {
  title: string;
  value: string;
  age: string;
  nextAt: string | null;
  enabled: boolean;
}) {
  const { t } = useTheme();
  const state = enabled ? "running" : "stopped";
  return (
    <View
      accessible
      accessibilityLabel={`${title}, ${state}. ${value}. ${age}${
        enabled && nextAt ? `, next ${dateTime(nextAt)}` : ""
      }`}
      style={{ marginTop: 12 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontWeight: "700",
            fontFamily: FONT.bold,
            flex: 1,
          }}
        >
          {title}
        </Text>
        {/* "stopped" is stated, not implied by a dimmed row. */}
        <Pill
          label={state}
          tone={enabled ? "success" : "warning"}
          size="sm"
        />
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          marginTop: 3,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
      >
        {age}
        {enabled && nextAt ? ` · next ${dateTime(nextAt)}` : ""}
      </Text>
    </View>
  );
}
