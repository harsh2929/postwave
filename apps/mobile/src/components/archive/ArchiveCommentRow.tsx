/**
 * ArchiveCommentRow — one comment in the archive moderation queue.
 *
 * A moderation row must answer, before any tap: who said it, what they said,
 * which published issue it is sitting on, whether it is a reply, whether the
 * author is a real subscriber or an anonymous guest, and how the readers have
 * voted. Everything longer than a preview belongs behind the tap.
 *
 * THE ISSUE NAME IS NOT ALWAYS KNOWABLE. The admin projection carries a
 * campaign UUID and no title (`archive_comments.go` ListForModeration selects
 * `campaign_id::text` only), so the label comes from the archive index and
 * degrades to a truncated id — never to an invented name.
 *
 * "GUEST" IS EVIDENCE, NOT DECORATION. A guest comment carries no identity the
 * workspace can act on, and a run of them is the signature of a spam wave, so
 * it earns a pill rather than a line of body text.
 *
 * VOTES ARE COMPACTED, SO THE ROW SPEAKS THEM. "+5" is unrecoverable by a
 * screen reader; `voteLabel` puts "+5 · 7 up, 2 down" in the row's own label.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";
import {
  authorLabel,
  authorOrigin,
  commentPreview,
  commentStatusPresentation,
  issueLabel,
  voteLabel,
  type MobileArchiveComment,
} from "@/lib/archiveCommentQueue";

export interface ArchiveCommentRowProps {
  comment: MobileArchiveComment;
  onPress: (comment: MobileArchiveComment) => void;
  /** campaignId → issue subject, from the archive index. May be empty. */
  titles: ReadonlyMap<string, string> | null;
  /** Dims the row while one of its verbs is in flight. */
  busy?: boolean | undefined;
  /** `Date.now()` from the screen's ticker, so "3h ago" stays honest. */
  now?: number | undefined;
}

function ArchiveCommentRowImpl({
  comment,
  onPress,
  titles,
  busy,
  now,
}: ArchiveCommentRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const status = commentStatusPresentation(comment.status);
  const who = authorLabel(comment);
  const origin = authorOrigin(comment);
  const issue = issueLabel(comment.campaignId, titles);
  const when = relativeTime(comment.createdAt, {
    ...(now === undefined ? {} : { now }),
  });
  const preview = commentPreview(comment.body);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        `${who}, ${origin}`,
        comment.parentId ? "reply" : "top-level comment",
        `on ${issue}`,
        status.spoken,
        comment.pinned ? "pinned" : "",
        preview || "no text",
        voteLabel(comment),
        when,
      ]
        .filter(Boolean)
        .join(". ")}
      accessibilityHint="Opens the full comment and its moderation actions"
      accessibilityState={{ disabled: Boolean(busy) }}
      onPress={() => onPress(comment)}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        minHeight: 44,
        opacity: busy ? 0.55 : 1,
        gap: 6,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontWeight: "700",
            fontFamily: FONT.bold,
            flexShrink: 1,
          }}
        >
          {who}
        </Text>
        <Pill
          label={origin}
          tone={comment.subscriberId ? "info" : "neutral"}
          size="sm"
          accessibilityLabel={
            comment.subscriberId
              ? "Posted by a signed-in subscriber"
              : "Posted by a guest with no subscriber record"
          }
        />
        <Pill
          label={status.label}
          tone={status.tone}
          size="sm"
          accessibilityLabel={status.spoken}
        />
        {comment.pinned ? (
          <Pill
            label="Pinned"
            tone="accent"
            size="sm"
            accessibilityLabel="Pinned to the top of the public thread"
          />
        ) : null}
        {comment.parentId ? (
          <Pill
            label="Reply"
            tone="neutral"
            size="sm"
            accessibilityLabel="This is a reply to another comment"
          />
        ) : null}
      </View>

      <Text
        {...typeCap("bodySmall")}
        numberOfLines={maxLinesAtScale(2, fontScale)}
        style={{
          color: preview ? t.fg : t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {preview || "(no text)"}
      </Text>

      <Text
        {...typeCap("caption")}
        numberOfLines={maxLinesAtScale(1, fontScale)}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {issue}
      </Text>

      <Text
        {...typeCap("caption")}
        // The row's own label already speaks all of this; repeating it would
        // announce the votes twice.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {`${when} · ${voteLabel(comment)}`}
      </Text>
    </Pressable>
  );
}

export const ArchiveCommentRow = memo(ArchiveCommentRowImpl);
