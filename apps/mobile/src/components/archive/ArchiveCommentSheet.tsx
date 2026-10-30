/**
 * ArchiveCommentSheet — read the whole comment, then act on it.
 *
 * A sheet rather than a route: the rhythm of a moderation queue is open →
 * decide → next, and a pushed screen makes every decision cost a navigation
 * animation in each direction. It also keeps this surface to ONE route file.
 *
 * IT DOES NOT RE-READ ANYTHING. Unlike the review sheet next door, the archive
 * moderation API has no single-comment GET at all — `MountAdminRoutes`
 * registers a list, three verbs and a delete, and nothing else. The list row IS
 * the whole record, which is also why the body is rendered in full here rather
 * than promised behind a second fetch.
 *
 * IT CANNOT SHOW THE THREAD. `Comment.Children` is populated only by the
 * public tree builder; the moderation projection leaves it empty
 * (archive_comments.go:88-90). So a reply can say it IS a reply, and nothing
 * can say what it is a reply TO. The sheet says that rather than showing an
 * empty "Replies" section that reads as "none".
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  actionsForComment,
  authorLabel,
  authorOrigin,
  commentStatusPresentation,
  issueLabel,
  voteLabel,
  type ArchiveCommentAction,
  type MobileArchiveComment,
} from "@/lib/archiveCommentQueue";

export interface ArchiveCommentSheetProps {
  comment: MobileArchiveComment | null;
  titles: ReadonlyMap<string, string> | null;
  onClose: () => void;
  onAction: (
    comment: MobileArchiveComment,
    action: ArchiveCommentAction,
  ) => void;
  /** True while any verb is in flight — every button disables together. */
  busy: boolean;
  /** False when the device is offline: none of these verbs is queued. */
  online: boolean;
}

const ACTION_LABELS: Record<ArchiveCommentAction, string> = {
  hide: "Hide",
  spam: "Mark spam",
  restore: "Make live",
  pin: "Pin",
  unpin: "Unpin",
  delete: "Delete",
};

export function ArchiveCommentSheet({
  comment,
  titles,
  onClose,
  onAction,
  busy,
  online,
}: ArchiveCommentSheetProps) {
  const { t } = useTheme();
  return (
    <ReducedMotionModal
      visible={comment !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        {comment === null ? null : (
          <>
            <SheetHeader title={authorLabel(comment)} onClose={onClose} />
            <ScrollView
              contentContainerStyle={{
                padding: 16,
                paddingBottom: 24,
                gap: 14,
              }}
            >
              <Facts comment={comment} titles={titles} />
              <Body body={comment.body} />
              {comment.parentId ? (
                <Note text="This is a reply. The moderation API returns a flat list with no thread, so the comment it answers is only visible on the published issue." />
              ) : null}
            </ScrollView>
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: t.borderSubtle,
                padding: 16,
                gap: 10,
              }}
            >
              {online ? null : (
                <Text
                  accessibilityLiveRegion="polite"
                  {...typeCap("label")}
                  style={{
                    color: t.warning,
                    ...typeStyle("label"),
                    fontFamily: FONT.regular,
                  }}
                >
                  You&apos;re offline. Moderation is never queued — a hide that lands
                  an hour late is an hour of the comment being public.
                </Text>
              )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {actionsForComment(comment).map((action) => (
                  <ActionButton
                    key={action}
                    label={ACTION_LABELS[action]}
                    destructive={action === "delete"}
                    primary={action === "restore"}
                    disabled={busy || !online}
                    onPress={() => onAction(comment, action)}
                  />
                ))}
              </View>
            </View>
          </>
        )}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function Facts({
  comment,
  titles,
}: {
  comment: MobileArchiveComment;
  titles: ReadonlyMap<string, string> | null;
}) {
  const { t } = useTheme();
  const status = commentStatusPresentation(comment.status);
  const rows: { label: string; value: string; spoken?: string }[] = [
    { label: "Status", value: status.label, spoken: status.spoken },
    { label: "Issue", value: issueLabel(comment.campaignId, titles) },
    {
      label: "Author",
      value: `${authorLabel(comment)} · ${authorOrigin(comment)}`,
    },
    { label: "Posted", value: dateTime(comment.createdAt) },
    { label: "Votes", value: voteLabel(comment) },
  ];
  return (
    <View style={{ gap: 8 }}>
      {rows.map((row) => (
        <View
          key={row.label}
          accessible
          accessibilityLabel={`${row.label}: ${row.spoken ?? row.value}`}
          style={{ flexDirection: "row", gap: 10 }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              width: 76,
            }}
          >
            {row.label}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              flex: 1,
            }}
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Body({ body }: { body: string }) {
  const { t } = useTheme();
  const text = body.trim();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: text ? t.fg : t.fgSubtle,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
        }}
      >
        {text || "This comment has no text."}
      </Text>
    </View>
  );
}

function Note({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
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
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: t.borderSubtle,
        gap: 12,
      }}
    >
      <Text
        {...typeCap("heading")}
        numberOfLines={1}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "700",
          fontFamily: FONT.bold,
          flex: 1,
        }}
      >
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close comment"
        onPress={onClose}
        hitSlop={12}
        style={{
          minWidth: 44,
          minHeight: 44,
          alignItems: "flex-end",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.accent,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.medium,
          }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled,
  destructive,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  destructive: boolean;
  primary: boolean;
}) {
  const { t } = useTheme();
  const background = primary ? t.accent : t.surface;
  const border = destructive ? t.danger : primary ? t.accent : t.borderSubtle;
  const color = primary ? t.accentFg : destructive ? t.danger : t.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        backgroundColor: background,
        borderColor: border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 16,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.medium,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
