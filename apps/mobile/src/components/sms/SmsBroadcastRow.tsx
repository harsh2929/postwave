/**
 * SmsBroadcastRow — one broadcast in the drafts list, with a press-driven
 * progress expander.
 *
 * The row offers Edit only for draft|scheduled (the server 409s edits to
 * anything else) and Delete for everything except `sending` (the server
 * refuses mid-send deletes). There is deliberately NO Send control anywhere —
 * dispatch is release-held server-side, and the screen's banner explains it.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import { useSmsBroadcastProgress } from "@/hooks/useSmsBroadcasts";
import { FONT } from "@/lib/fonts";
import { dateTime, num } from "@/lib/format";
import {
  smsBroadcastAudienceLine,
  type SmsBroadcast,
} from "@/lib/smsBroadcastWire";
import { safeSmsDisplayText } from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const STATUS_TONE: Record<
  SmsBroadcast["status"],
  "neutral" | "info" | "warning" | "success" | "danger"
> = {
  draft: "neutral",
  scheduled: "info",
  sending: "warning",
  sent: "success",
  cancelled: "danger",
};

export function SmsBroadcastRow({
  broadcast,
  access,
  progressOpen,
  onToggleProgress,
  onEdit,
  onDelete,
}: {
  broadcast: SmsBroadcast;
  access: SmsInboxAccess;
  progressOpen: boolean;
  onToggleProgress: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTheme();
  const editable =
    broadcast.status === "draft" || broadcast.status === "scheduled";
  const deletable = broadcast.status !== "sending";
  const caption = (text: string) => (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
  return (
    <View style={{ marginBottom: 8 }}>
      <Card>
        <View style={{ gap: 6 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
                flex: 1,
              }}
              numberOfLines={1}
            >
              {safeSmsDisplayText(broadcast.name, 256)}
            </Text>
            <Pill
              label={broadcast.status}
              tone={STATUS_TONE[broadcast.status]}
            />
          </View>
          {broadcast.body ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                writingDirection: "auto",
              }}
              numberOfLines={2}
            >
              {safeSmsDisplayText(broadcast.body, 512)}
            </Text>
          ) : (
            caption("No message written yet")
          )}
          {caption(
            `${smsBroadcastAudienceLine(broadcast)} · ${
              broadcast.segmentsPerMessage > 0
                ? `${num(broadcast.segmentsPerMessage)} segment${broadcast.segmentsPerMessage === 1 ? "" : "s"}/message · `
                : ""
            }updated ${dateTime(broadcast.updatedAt)}${
              broadcast.scheduledAt
                ? ` · scheduled ${dateTime(broadcast.scheduledAt)}`
                : ""
            }`,
          )}
          {broadcast.sentCount + broadcast.failedCount + broadcast.heldCount > 0
            ? caption(
                `Recorded: ${num(broadcast.sentCount)} sent · ${num(broadcast.failedCount)} failed · ${num(broadcast.heldCount)} held`,
              )
            : null}
          {access.canRequest ? (
            <View style={{ flexDirection: "row", gap: 16 }}>
              {editable ? (
                <RowLink label="Edit" onPress={onEdit} name={broadcast.name} />
              ) : null}
              <RowLink
                label={progressOpen ? "Hide progress" : "Progress"}
                onPress={onToggleProgress}
                name={broadcast.name}
              />
              {deletable ? (
                <RowLink
                  label="Delete"
                  onPress={onDelete}
                  name={broadcast.name}
                  danger
                />
              ) : null}
            </View>
          ) : null}
          {progressOpen ? (
            <ProgressLine id={broadcast.id} access={access} />
          ) : null}
        </View>
      </Card>
    </View>
  );
}

function RowLink({
  label,
  name,
  onPress,
  danger = false,
}: {
  label: string;
  name: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} broadcast ${name}`}
      hitSlop={8}
      style={{ minHeight: 36, justifyContent: "center" }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: danger ? t.danger : t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ProgressLine({
  id,
  access,
}: {
  id: string;
  access: SmsInboxAccess;
}) {
  const { t } = useTheme();
  const progress = useSmsBroadcastProgress(id, access);
  const text = progress.isError
    ? "Progress could not be loaded."
    : !progress.data
      ? "Loading recorded progress…"
      : `Recorded ${progress.data.status}: ${num(progress.data.sent)} sent · ${num(progress.data.failed)} failed · ${num(progress.data.held)} held · ${num(progress.data.total)} total`;
  return (
    <Text
      accessibilityLiveRegion="polite"
      {...typeCap("caption")}
      style={{
        color: progress.isError ? t.danger : t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.medium,
      }}
    >
      {text}
    </Text>
  );
}
