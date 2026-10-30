/**
 * ReviewRow — one review in the moderation queue.
 *
 * A moderation row has to answer, at a glance and before any tap: how many
 * stars, who wrote it, what it says, whether the person actually bought the
 * thing, and how long they have been waiting. Everything else (full body,
 * replies, product, moderation reason) belongs behind the tap.
 *
 * THE STAR ROW IS DECORATIVE. Five identical glyphs read aloud as "black star
 * black star white star…", so the glyphs are hidden from the accessibility
 * tree and the row's own label carries the words instead
 * (`ratingLabel` in lib/reviewQueue).
 *
 * "VERIFIED BUYER" IS NOT A COMPLIMENT, IT IS EVIDENCE. It changes how much a
 * one-star review should weigh, so it earns a pill rather than a line of body
 * text. "Incentivized" is shown for the same reason in the other direction —
 * FTC guidance requires disclosing it, and a moderator publishing it needs to
 * know before they publish.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import {
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";
import {
  ratingLabel,
  ratingStars,
  reviewPreview,
  reviewStatusPresentation,
  reviewerLabel,
  type MobileReview,
} from "@/lib/reviewQueue";

export interface ReviewRowProps {
  review: MobileReview;
  onPress: (review: MobileReview) => void;
  /** Dims the row while its decision is in flight. */
  busy?: boolean | undefined;
  /** `Date.now()` from the screen's ticker, so "3h ago" stays honest. */
  now?: number | undefined;
}

function ReviewRowImpl({ review, onPress, busy, now }: ReviewRowProps) {
  const { t } = useTheme();
  // At a raised OS text size a 2-line preview and a 1-line byline both lose
  // most of their content to the ellipsis; each is allowed one extra line.
  const { fontScale } = useWindowDimensions();
  const status = reviewStatusPresentation(review.status);
  const who = reviewerLabel(review);
  const preview = reviewPreview(review);
  const waited = relativeTime(
    review.submittedAt,
    now === undefined ? {} : { now },
  );

  return (
    <Pressable
      onPress={() => onPress(review)}
      disabled={busy === true}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy === true, busy: busy === true }}
      accessibilityLabel={`${ratingLabel(review.rating)}. ${who}. ${preview}. ${
        status.label
      }. Submitted ${waited}.`}
      accessibilityHint="Opens the review to read it in full, publish, reject or reply"
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        gap: 6,
        opacity: busy === true ? 0.55 : 1,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          // Not `allowFontScaling={false}`: these glyphs ARE the rating for a
          // sighted user, so they must grow with the OS setting. They are
          // capped like a badge because five stars plus a status pill divide
          // one row's width and cannot reflow. The deliberate 14pt (one step
          // above `badge`) and the letter-spacing survive — a capped odd size
          // beats an uncapped one.
          {...typeCap("badge")}
          style={{
            color: review.rating >= 4 ? t.success : t.warning,
            fontSize: 14,
            letterSpacing: 1,
            fontFamily: FONT.regular,
          }}
        >
          {ratingStars(review.rating)}
        </Text>
        <Pill label={status.label} tone={status.tone} />
      </View>

      <Text
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
        }}
      >
        {preview}
      </Text>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
        >
          {who} · {waited}
        </Text>
        {review.verifiedBuyer ? <Pill label="Verified buyer" tone="info" /> : null}
        {review.incentivized ? <Pill label="Incentivized" tone="warning" /> : null}
      </View>
    </Pressable>
  );
}

export const ReviewRow = memo(ReviewRowImpl);
