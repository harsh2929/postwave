/**
 * ReviewSheetActions — the decision row at the foot of the review sheet.
 *
 * Split out of ReviewDetailSheet at its 450-line source budget. Keeping the
 * buttons here means the sheet reads as chrome + composer + actions rather than
 * as one 500-line function.
 *
 * REJECT SITS ON THE LEFT, PUBLISH ON THE RIGHT. Publish is the affirmative,
 * higher-consequence verb (it puts a stranger's words on the storefront), so it
 * takes the filled treatment and the thumb-nearest edge, and reject stays an
 * outline. Both still pass through a ConfirmSheet — the button styling is a
 * hint about weight, never the guard.
 *
 * The decision pair only renders for a pending review: `approve` on an already
 * approved row is a no-op round trip that re-stamps `moderated_at`, and
 * offering it would imply a state change that does not happen.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { isDecidable, type MobileReview } from "@/lib/reviewQueue";

export interface ReviewSheetActionsProps {
  review: MobileReview;
  onDecide: (review: MobileReview, decision: "approve" | "reject") => void;
  deciding: boolean;
  canSendReply: boolean;
  replying: boolean;
  onSendReply: () => void;
}

export function ReviewSheetActions({
  review,
  onDecide,
  deciding,
  canSendReply,
  replying,
  onSendReply,
}: ReviewSheetActionsProps) {
  const { t } = useTheme();
  const decidable = isDecidable(review);
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {decidable ? (
        <>
          <ActionButton
            label="Reject"
            onPress={() => onDecide(review, "reject")}
            disabled={deciding}
            background={t.surface}
            border={t.danger}
            color={t.danger}
          />
          <ActionButton
            label="Publish"
            onPress={() => onDecide(review, "approve")}
            disabled={deciding}
            background={t.success}
            border={t.success}
            color={t.accentFg}
          />
        </>
      ) : null}
      <ActionButton
        label={replying ? "Replying…" : "Reply"}
        onPress={onSendReply}
        disabled={!canSendReply}
        background={t.accent}
        border={t.accent}
        color={t.accentFg}
      />
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled,
  background,
  border,
  color,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  background: string;
  border: string;
  color: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        // 44pt is the iOS minimum touch target; these are the buttons that
        // publish to a storefront, so they are the last place to shave it.
        minHeight: 44,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: background,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        // Three buttons divide one row, so the label is a dense `control`
        // rather than prose: at an uncapped 3x, "Publish" alone would be
        // wider than its own third of the footer.
        {...typeCap("control")}
        numberOfLines={1}
        style={{
          color,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
