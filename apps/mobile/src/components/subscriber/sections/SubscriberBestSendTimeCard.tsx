/**
 * SubscriberBestSendTimeCard — "when does THIS person actually read mail?"
 *
 * MAP#49: mobile shipped SendTimeOptBanner (a nudge inside the campaign
 * schedule modal) but had no per-subscriber lookup, which is the half of the
 * desktop's SendTime.tsx that is genuinely phone-shaped — a support call asking
 * "why did they not see it?" is answered by one line.
 *
 * Three deliberate decisions:
 *
 *  - THE LOCAL TIME LEADS. The wire value is an hour of WEEK in UTC. A New
 *    Yorker reading "Tuesday 14:00 UTC" has to do arithmetic; the card projects
 *    the next matching instant into the DEVICE's timezone and prints that, with
 *    the UTC bucket kept underneath so the number the API returned is still
 *    visible and checkable.
 *  - "NOT ENOUGH SIGNAL" IS NOT AN ERROR. The handler 404s on purpose for any
 *    subscriber below MinOpens, which is most of them. That renders as a calm
 *    sentence, never a red retry.
 *  - SAMPLE SIZE IS NOT SHOWN. `Repo.GetByID` never populates it, so it is 0 on
 *    every response from this route; printing it would say "0 signals" about a
 *    well-modelled contact. See src/lib/subscriberSendTime.ts.
 */
import { Text } from "react-native";

import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import {
  useCanReadBestSendTime,
  useSubscriberBestSendTime,
} from "@/hooks/useSubscriberBestSendTime";
import { FONT } from "@/lib/fonts";
import { date as fmtDate, dateTime } from "@/lib/format";
import {
  computedAt,
  decodeBestHourOfWeek,
  insufficientMessage,
  nextBestSendInstant,
} from "@/lib/subscriberSendTime";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberBestSendTimeCard({
  subscriberId,
  now,
}: {
  subscriberId: string;
  /** Injected under test so the projected instant is deterministic. */
  now?: Date | undefined;
}) {
  const { t } = useTheme();
  const allowed = useCanReadBestSendTime();
  const query = useSubscriberBestSendTime(subscriberId);

  // Below admin the route is a guaranteed 403 (see the hook). Render nothing
  // rather than a locked panel on every profile.
  if (!allowed) return null;

  const result = query.data;

  // Still loading, or the gate is closed offline: say nothing. The card is
  // supplementary — a skeleton for it would imply the profile is incomplete.
  if (!result) return null;

  if (!result.ok) {
    if (result.outcome === "insufficient") {
      return (
        <Card style={{ marginTop: 12 }}>
          <Label>Best send time</Label>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 6,
              fontFamily: FONT.regular,
            }}
          >
            {insufficientMessage(result.minSignalUnits)}
          </Text>
        </Card>
      );
    }
    // `missing` means the subscriber id did not resolve, which the profile
    // above has already contradicted by rendering — and `forbidden` cannot
    // happen here because the hook does not fire below admin. Both are
    // reported as an inability to read, never as "no best time".
    if (result.outcome === "error" || result.outcome === "forbidden") {
      return (
        <Card style={{ marginTop: 12 }}>
          <Label>Best send time</Label>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 6,
              fontFamily: FONT.regular,
            }}
          >
            Couldn&apos;t read the send-time model for this contact.
          </Text>
        </Card>
      );
    }
    return null;
  }

  const decoded = decodeBestHourOfWeek(result.row.best_hour_utc);
  if (!decoded) return null;

  const nextAt = nextBestSendInstant(decoded.hourOfWeek, now ?? new Date());
  const scoredAt = computedAt(result.row.computed_at);

  return (
    <Card style={{ marginTop: 12 }}>
      <Label>Best send time</Label>
      <Text
        // One spoken sentence: the local window IS the answer, and a screen
        // reader should not have to stitch it out of two lines.
        accessible
        accessibilityLabel={
          nextAt
            ? `Best send time for this contact: ${dateTime(nextAt.toISOString())} local, which is ${decoded.utcLabel}.`
            : `Best send time for this contact: ${decoded.utcLabel}.`
        }
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          marginTop: 6,
          fontFamily: FONT.semibold,
        }}
      >
        {nextAt ? dateTime(nextAt.toISOString()) : decoded.utcLabel}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 3,
          fontFamily: FONT.regular,
        }}
      >
        {/* The UTC bucket the model actually holds, so the projection above is
            checkable rather than something the phone asserts. */}
        {`Weekly window · ${decoded.utcLabel}`}
      </Text>
      {scoredAt ? (
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("badgeSmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {`Modelled ${fmtDate(scoredAt)}`}
        </Text>
      ) : null}
    </Card>
  );
}
