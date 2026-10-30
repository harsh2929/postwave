/**
 * DiscountRedeemability — what the SERVER says about this code, right now.
 *
 * The status pill on the card above is DERIVED: `statusOf()` compares the
 * `expires_at` and `max_redemptions` carried on the list row, and that row may
 * have come out of a twelve-hour offline snapshot. This block is the other
 * thing — `GET /api/v1/discounts/{code}/check`, which re-reads the row inside
 * the tenant transaction and runs `CheckRedeemable`, the same function the
 * redeem path runs (apps/api/internal/discounts/handlers.go:66-89). Its own doc
 * says it "mirrors what Redeem decides at the top of its flow", which is why it
 * can legitimately disagree with the list — and the disagreement is the answer
 * to the only support question a phone gets asked about a discount: "the
 * customer says the code doesn't work".
 *
 * A FAILED PROBE IS NOT A VERDICT. If the check itself errors we say the
 * re-check failed and that the pill above is the stale list's opinion. Falling
 * back silently would let a network failure read as "confirmed working".
 *
 * All the wording lives in `lib/discountEdit` (import-free, unit-tested); this
 * file only chooses the colour, and never uses colour alone — the headline
 * carries the state in words.
 */
import { Text, View } from "react-native";

import type { DiscountStatusLabel } from "@/components/discounts/discountStatus";
import {
  DISCOUNT_LIVE_CHECK_MOUNTED,
  DISCOUNT_LIVE_CHECK_UNAVAILABLE_NOTICE,
} from "@/lib/discountMutationBoundary";
import {
  redeemabilityDisagreement,
  redeemabilitySummary,
  type DiscountCheck,
} from "@/lib/discountEdit";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** The `useDiscountCheck` query, narrowed to what is rendered. */
export interface DiscountCheckQuery {
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  data: DiscountCheck | undefined;
}

export interface DiscountRedeemabilityProps {
  /** The label `statusOf()` derived from the list row. */
  localLabel: DiscountStatusLabel;
  check: DiscountCheckQuery;
}

export function DiscountRedeemability({
  localLabel,
  check,
}: DiscountRedeemabilityProps) {
  const { t } = useTheme();

  // The probe route is not mounted in this build (lib/discountMutationBoundary),
  // so the query never runs and there is nothing to be fetching. Saying so is
  // not optional: without this block the panel renders NOTHING, and the derived
  // pill above silently inherits the authority of a server verdict it never
  // got. Rendered before the fetching/error branches because neither can be
  // true when the query is disabled.
  if (!DISCOUNT_LIVE_CHECK_MOUNTED) {
    return (
      <Notice
        border={t.borderSubtle}
        color={t.fgMuted}
        headline={DISCOUNT_LIVE_CHECK_UNAVAILABLE_NOTICE.headline}
        detail={DISCOUNT_LIVE_CHECK_UNAVAILABLE_NOTICE.detail}
        spoken={DISCOUNT_LIVE_CHECK_UNAVAILABLE_NOTICE.spoken}
      />
    );
  }

  // Fetching with nothing yet: say the check is running rather than showing a
  // stale verdict from the previously-expanded code.
  if (check.data === undefined && check.isFetching) {
    return (
      <Notice
        border={t.borderSubtle}
        color={t.fgMuted}
        headline="Checking with the server…"
        detail="Re-reading this code to see whether a customer could redeem it right now."
        spoken="Checking whether this code is redeemable right now."
      />
    );
  }

  if (check.isError) {
    return (
      <Notice
        border={t.borderSubtle}
        color={t.fgMuted}
        headline="Couldn't re-check this code"
        detail={
          check.error instanceof Error && check.error.message
            ? `${check.error.message} The status above comes from the list, which may be out of date.`
            : "The status above comes from the list, which may be out of date."
        }
        spoken="The live redeemability check failed. The status shown comes from the list and may be out of date."
      />
    );
  }

  // No verdict, not fetching, no error — the code has no answer to give (a 404
  // for a deleted code, or a query that has not been asked yet). This USED to be
  // unreachable: the route was unmounted, so the branch above always caught it
  // first. A1 mounted /check and made it reachable, and returning null here is
  // the exact silence the block above exists to prevent — the derived pill would
  // inherit the authority of a server verdict that never arrived.
  if (check.data === undefined) {
    return (
      <Notice
        border={t.borderSubtle}
        color={t.fgMuted}
        headline="No live answer for this code"
        detail="The status above is derived from the code list, which can be up to a refresh old."
        spoken="There is no live redeemability answer for this code. The status shown is derived from the list and may be out of date."
      />
    );
  }

  const summary = redeemabilitySummary(check.data);
  const disagreement = redeemabilityDisagreement(localLabel, check.data);
  const color =
    summary.tone === "success"
      ? t.success
      : summary.tone === "warning"
        ? t.warning
        : t.danger;

  return (
    <Notice
      border={disagreement ? color : t.borderSubtle}
      color={color}
      headline={summary.headline}
      detail={disagreement ? `${summary.detail} ${disagreement}` : summary.detail}
      spoken={
        disagreement ? `${summary.detail} ${disagreement}` : summary.detail
      }
    />
  );
}

/**
 * One notice block. `accessible` collapses the two lines into a single
 * VoiceOver stop reading the EXPANDED sentence, because "Not redeemable —
 * limit reached" out of context does not say who checked or when.
 */
function Notice({
  border,
  color,
  headline,
  detail,
  spoken,
}: {
  border: string;
  color: string;
  headline: string;
  detail: string;
  spoken: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={spoken}
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: t.bg,
        borderColor: border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
        marginBottom: 10,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color,
          ...typeStyle("bodySmall"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {headline}
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
        {detail}
      </Text>
    </View>
  );
}
