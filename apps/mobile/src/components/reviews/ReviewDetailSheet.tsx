/**
 * ReviewDetailSheet — read the whole review, then decide or answer it.
 *
 * A sheet rather than a route: the queue's rhythm is open → decide → next, and
 * a pushed screen makes every decision cost a navigation animation in each
 * direction. It also keeps this cluster to ONE route file, so the surface adds
 * one tab-layout registration instead of two.
 *
 * IT RE-READS THE REVIEW ON OPEN. `Repo.ListReviews` does not select replies —
 * only `Repo.GetReview` runs `listRepliesTx` — so the reply thread simply does
 * not exist in the list payload. The sheet therefore fetches the single review
 * and, until that lands, says "Checking for replies…" (see ReviewDetailBody)
 * instead of rendering the list row's absence of replies as "no replies yet".
 *
 * IT RENDERS THE TAPPED ROW IMMEDIATELY. `review` is the list row and is
 * available at open; `detail` arrives a moment later and supersedes it. Waiting
 * for the detail read before showing anything would put a spinner between the
 * tap and the content the operator has already seen.
 *
 * THE REPLY IS PUBLIC AND IMMEDIATE. `normalizeReply` defaults the reply's
 * status to "published", so there is no draft state to fall back on. The
 * composer says so above the field, not in a toast afterwards.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import {
  RepliesBlock,
  ReviewBody,
} from "@/components/reviews/ReviewDetailBody";
import { ReviewSheetActions } from "@/components/reviews/ReviewSheetActions";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import {
  fontSizeFor,
  maxLinesAtScale,
  typeCap,
  typeStyle,
} from "@/lib/typeScale";
import {
  replyDraftState,
  reviewerLabel,
  type MobileReview,
} from "@/lib/reviewQueue";

export interface ReviewDetailSheetProps {
  /** The row that was tapped — available at open, before the detail read. */
  review: MobileReview | null;
  /** The single-review read, which is the only source of replies. */
  detail: MobileReview | null;
  detailLoading: boolean;
  detailFailed: boolean;
  onClose: () => void;
  onDecide: (review: MobileReview, decision: "approve" | "reject") => void;
  deciding: boolean;
  /** False for non-admins: the moderation verbs are ScopeAdmin server-side. */
  canModerate: boolean;
  online: boolean;
  /**
   * The merchandising tap — null below admin or offline (the PATCH is admin
   * and never queued). Only offered on an APPROVED review: featuring an
   * unpublished one decorates nothing and would imply it is live.
   */
  onToggleFeatured?: ((review: MobileReview, next: boolean) => void) | null;
  togglingFeatured?: boolean;
  draft: string;
  onDraftChange: (next: string) => void;
  onSendReply: () => void;
  replying: boolean;
}

/** Vertical padding inside the composer, on both edges. */
const COMPOSER_PAD_Y = 10;
/** Lines of reply the composer may grow to before it scrolls internally. */
const COMPOSER_MAX_LINES = 4;

/**
 * The composer's min/max height DERIVED from the `body` role rather than the
 * literal `44 / 120` it used to carry. A fixed 120 is only correct at one text
 * size: raise the OS setting and a four-line box becomes a one-and-a-half-line
 * slit that the operator has to scroll to read their own sentence back. The
 * `body` ceiling (1.8x) bounds the growth, and 44pt stays the floor because it
 * is also the touch target.
 */
export function reviewComposerHeights(fontScale: unknown): {
  minHeight: number;
  maxHeight: number;
} {
  const raw =
    typeof fontScale === "number" && Number.isFinite(fontScale) && fontScale > 1
      ? fontScale
      : 1;
  const effective = Math.min(raw, typeCap("body").maxFontSizeMultiplier);
  const line = typeStyle("body").lineHeight * effective;
  const chrome = COMPOSER_PAD_Y * 2;
  return {
    minHeight: Math.max(44, Math.round(line + chrome)),
    maxHeight: Math.round(line * COMPOSER_MAX_LINES + chrome),
  };
}

export function ReviewDetailSheet(props: ReviewDetailSheetProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const composer = reviewComposerHeights(fontScale);
  const shown = props.detail ?? props.review;
  const reply = replyDraftState(props.draft, {
    sending: props.replying,
    online: props.online,
  });

  return (
    <ReducedMotionModal
      visible={props.review !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        {shown === null ? null : (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <SheetHeader title={reviewerLabel(shown)} onClose={props.onClose} />

            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 14 }}
              keyboardShouldPersistTaps="handled"
            >
              <ReviewBody review={shown} />
              <RepliesBlock
                detail={props.detail}
                loading={props.detailLoading}
                failed={props.detailFailed}
              />
            </ScrollView>

            {props.canModerate ? (
              <View style={footer(t.borderSubtle)}>
                {props.onToggleFeatured &&
                (shown.status ?? "").trim().toLowerCase() === "approved" ? (
                  <Pressable
                    onPress={() =>
                      props.onToggleFeatured?.(shown, !shown.featured)
                    }
                    disabled={props.togglingFeatured === true}
                    accessibilityRole="button"
                    accessibilityLabel={
                      shown.featured
                        ? "Remove this review from featured"
                        : "Feature this review on your storefront"
                    }
                    accessibilityState={{
                      disabled: props.togglingFeatured === true,
                    }}
                    style={{ minHeight: 44, justifyContent: "center" }}
                  >
                    <Text
                      {...typeCap("control")}
                      style={{
                        color:
                          props.togglingFeatured === true
                            ? t.fgSubtle
                            : t.accent,
                        ...typeStyle("control"),
                        fontFamily: FONT.semibold,
                      }}
                    >
                      {props.togglingFeatured === true
                        ? "Saving…"
                        : shown.featured
                          ? "Remove from featured"
                          : "Feature on storefront"}
                    </Text>
                  </Pressable>
                ) : null}
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  A reply is published to your storefront widgets immediately and
                  is attributed to the workspace, not to you.
                </Text>
                <TextInput
                  value={props.draft}
                  onChangeText={props.onDraftChange}
                  editable={props.online && !props.replying}
                  multiline
                  placeholder={
                    props.online
                      ? "Write a public reply…"
                      : "Offline — replies are not queued"
                  }
                  placeholderTextColor={t.fgSubtle}
                  accessibilityLabel="Public reply"
                  // No explicit lineHeight on a TextInput: it mis-centres the
                  // caret and clips descenders on Android, which is why
                  // typeScale exposes `fontSizeFor` separately.
                  {...typeCap("body")}
                  style={{
                    color: t.fg,
                    backgroundColor: t.surface,
                    borderColor: t.borderSubtle,
                    borderWidth: 1,
                    borderRadius: 12,
                    paddingHorizontal: 12,
                    paddingVertical: COMPOSER_PAD_Y,
                    fontSize: fontSizeFor("body"),
                    fontFamily: FONT.regular,
                    minHeight: composer.minHeight,
                    maxHeight: composer.maxHeight,
                  }}
                />
                {reply.reason ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    {...typeCap("label")}
                    style={{
                      color: t.warning,
                      ...typeStyle("label"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {reply.reason}
                  </Text>
                ) : null}
                <ReviewSheetActions
                  review={shown}
                  onDecide={props.onDecide}
                  deciding={props.deciding}
                  canSendReply={reply.canSend}
                  replying={props.replying}
                  onSendReply={props.onSendReply}
                />
              </View>
            ) : (
              <View style={footer(t.borderSubtle)}>
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Publishing, rejecting and replying need an admin role on this
                  workspace. You can read the queue.
                </Text>
              </View>
            )}
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function SheetHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        gap: 12,
      }}
    >
      <Text
        // A reviewer's name is the one string here we do not control the
        // length of, so at a raised text size it gets a second line rather
        // than collapsing to an initial and an ellipsis.
        numberOfLines={maxLinesAtScale(1, fontScale)}
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.display,
          flexShrink: 1,
        }}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close review"
        style={{ paddingHorizontal: 8, paddingVertical: 6, minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}

function footer(border: string) {
  return {
    borderTopColor: border,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 8,
  } as const;
}
