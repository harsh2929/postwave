/**
 * ReviewDetailBody — the scrollable half of the review sheet: the review
 * itself, and the public-reply thread.
 *
 * Split out of ReviewDetailSheet when that file crossed the 450-line source
 * budget. The seam is real rather than mechanical: this file is PRESENTATION of
 * a review that has already been fetched, while the sheet owns the modal
 * chrome, the composer and the decision wiring.
 *
 * The three-state replies block is the reason this file is worth reading. The
 * list read (`Repo.ListReviews`) never selects replies; only `Repo.GetReview`
 * runs `listRepliesTx`. So there are genuinely three different things to say —
 * "not loaded yet", "loaded, none", and "we could not find out" — and
 * collapsing them into "No public reply yet" would tell a moderator that a
 * complaint is unanswered when a teammate may have answered it an hour ago.
 */
import { ActivityIndicator, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle, type TypeRole } from "@/lib/typeScale";
import {
  ratingLabel,
  ratingStars,
  reviewStatusPresentation,
  type MobileReview,
} from "@/lib/reviewQueue";

export function ReviewBody({ review }: { review: MobileReview }) {
  const { t } = useTheme();
  const status = reviewStatusPresentation(review.status);
  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Text
          accessibilityLabel={ratingLabel(review.rating)}
          // The sheet's star row sits in a `flexWrap` header, so unlike the
          // list row it CAN reflow — but it still shares its line with up to
          // four pills, so it keeps the dense badge ceiling rather than a
          // prose one. Deliberate 17pt + letter-spacing survive, capped.
          {...typeCap("badge")}
          style={{
            color: review.rating >= 4 ? t.success : t.warning,
            fontSize: 17,
            letterSpacing: 1.5,
            fontFamily: FONT.regular,
          }}
        >
          {ratingStars(review.rating)}
        </Text>
        <Pill label={status.label} tone={status.tone} />
        {review.verifiedBuyer ? (
          <Pill label="Verified buyer" tone="info" />
        ) : null}
        {review.incentivized ? (
          <Pill label="Incentivized" tone="warning" />
        ) : null}
        {review.featured ? <Pill label="Featured" tone="accent" /> : null}
      </View>

      {review.title ? (
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontFamily: FONT.display,
          }}
        >
          {review.title}
        </Text>
      ) : null}

      <Text
        {...typeCap("body")}
        style={{
          color: review.body ? t.fg : t.fgSubtle,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
        }}
      >
        {review.body || "This reviewer left a rating with no written review."}
      </Text>

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Submitted {dateTime(review.submittedAt)}
        {review.sourcePlatform ? ` · via ${review.sourcePlatform}` : ""}
        {review.productId ? `\nProduct ${review.productId}` : ""}
        {review.moderationReason
          ? `\nModeration note: ${review.moderationReason}`
          : ""}
      </Text>
    </View>
  );
}

export interface RepliesBlockProps {
  detail: MobileReview | null;
  loading: boolean;
  failed: boolean;
}

export function RepliesBlock({ detail, loading, failed }: RepliesBlockProps) {
  const { t } = useTheme();
  const replies = detail?.replies ?? null;

  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>Public replies</SectionLabel>
      {failed ? (
        <Text {...typeCap(MUTED_ROLE)} style={mutedText(t.warning)}>
          Couldn&apos;t load existing replies. Sending one now could duplicate an
          answer a teammate already published.
        </Text>
      ) : replies === null ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {loading ? <ActivityIndicator size="small" color={t.fgMuted} /> : null}
          <Text {...typeCap(MUTED_ROLE)} style={mutedText(t.fgSubtle)}>
            Checking for replies…
          </Text>
        </View>
      ) : replies.length === 0 ? (
        <Text {...typeCap(MUTED_ROLE)} style={mutedText(t.fgSubtle)}>
          No public reply yet.
        </Text>
      ) : (
        replies.map((entry) => (
          <View
            key={entry.id}
            style={{
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 10,
              gap: 4,
            }}
          >
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.semibold,
              }}
            >
              {entry.author} · {dateTime(entry.createdAt)}
            </Text>
            <Text
              {...typeCap("callout")}
              style={{
                color: t.fg,
                ...typeStyle("callout"),
                fontFamily: FONT.regular,
              }}
            >
              {entry.body}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

/**
 * The three replies-block states share one role, so the ceiling is named once
 * here and spread as a PROP at each call site — `maxFontSizeMultiplier` is a
 * prop, and putting it in this style object would silently do nothing.
 */
const MUTED_ROLE: TypeRole = "bodySmall";

function mutedText(color: string) {
  return {
    color,
    ...typeStyle(MUTED_ROLE),
    fontFamily: FONT.regular,
  } as const;
}
