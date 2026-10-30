/**
 * SourceEventReviewList — the manual-review queue of a post-cutover source
 * watch, and the one WRITE this surface exposes (GOVERNANCE#53).
 *
 * MOBILE RE-OPENS A SIGN-OFF; IT NEVER GRANTS ONE. The `reviewed` direction of
 * `PATCH /api/v1/migrations/{job}/source-events/{id}/review` requires a
 * reconciliation narrative (<=1,000 chars) plus one to fifty auditable
 * evidence references, both hard-validated server-side
 * (services/migration/internal/handlers/source_events.go:262-296). That is a
 * compliance record and a phone is the wrong place to author one. Re-opening
 * needs no body, costs nothing, and is the safe direction: it puts a cutover
 * gate BACK, it never removes one.
 *
 * The button's availability mirrors the handler's own 409 conditions via
 * `reopenUnavailableReason`, so it is disabled-with-a-reason rather than
 * present-and-doomed. The reason is carried on the accessibilityHint, not
 * only in the visual dimming.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useReopenSourceEventReview } from "@/hooks/useCutoverWatch";
import {
  reopenUnavailableReason,
  type SourceEventRow,
} from "@/lib/cutoverWatch";
import { dateTime, num } from "@/lib/format";
import { CARD_RADIUS } from "@/lib/shellStyleTokens";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SourceEventReviewListProps {
  jobId: string | null;
  status: string | undefined;
  online: boolean;
  rows: readonly SourceEventRow[];
}

export function SourceEventReviewList({
  jobId,
  status,
  online,
  rows,
}: SourceEventReviewListProps) {
  const { t } = useTheme();

  return (
    <View style={{ marginTop: 16 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("caption")}
        style={{
          color: t.fg,
          ...typeStyle("caption"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        Manual review ({num(rows.length)})
      </Text>
      {/* Bounded on purpose: this is a glance, and a source that produced
          hundreds of review events is a "go to a desk" answer in itself. */}
      {rows.slice(0, 12).map((row) => (
        <ReviewRow
          key={row.id}
          row={row}
          jobId={jobId}
          status={status}
          online={online}
        />
      ))}
      {rows.length > 12 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          Showing 12 of {num(rows.length)}. The full queue is on the web app.
        </Text>
      ) : null}
    </View>
  );
}

function ReviewRow({
  row,
  jobId,
  status,
  online,
}: {
  row: SourceEventRow;
  jobId: string | null;
  status: string | undefined;
  online: boolean;
}) {
  const { t } = useTheme();
  const confirm = useConfirm();
  const { toast } = useToast();
  const reopen = useReopenSourceEventReview(jobId);
  const blocked = reopenUnavailableReason({ jobStatus: status, event: row });
  const canReopen = blocked === null && online;
  const resource = row.resourceType.replace(/_/g, " ");

  const onReopen = () => {
    void (async () => {
      const ok = await confirm({
        title: "Re-open this review?",
        message:
          "The sign-off and its evidence stay on the record; the event returns to the open queue so it blocks cutover again.",
        confirmLabel: "Re-open",
      });
      if (!ok) return;
      haptics.tap();
      try {
        await reopen.mutateAsync(row.id);
        haptics.success();
        toast("Review re-opened.");
      } catch (error) {
        haptics.error();
        toast({
          message:
            error instanceof Error
              ? error.message
              : "Could not re-open the review.",
          kind: "error",
        });
      }
    })();
  };

  return (
    <View
      style={{
        marginTop: 10,
        borderRadius: CARD_RADIUS,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        padding: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
        >
          {resource}
        </Text>
        {/* State as a word, never as a colour alone. */}
        <Pill
          label={row.reviewed ? "signed off" : "open"}
          tone={row.reviewed ? "success" : "warning"}
          size="sm"
        />
      </View>
      {row.occurredAt ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 3,
            fontFamily: FONT.regular,
          }}
        >
          {dateTime(row.occurredAt)}
        </Text>
      ) : null}
      {row.reviewDetail ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {row.reviewDetail}
        </Text>
      ) : null}
      {row.error ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {row.error}
        </Text>
      ) : null}
      {row.reviewed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Re-open the sign-off for this ${resource} review`}
          accessibilityHint={
            canReopen
              ? "Puts the review back in the open queue."
              : (blocked ?? "Re-opening a review needs a connection.")
          }
          accessibilityState={{ disabled: !canReopen || reopen.isPending }}
          disabled={!canReopen || reopen.isPending}
          onPress={onReopen}
          style={{
            marginTop: 10,
            minHeight: 44,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.bgSubtle,
            opacity: canReopen ? 1 : 0.5,
            paddingHorizontal: 12,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {reopen.isPending ? "Re-opening…" : "Re-open"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
