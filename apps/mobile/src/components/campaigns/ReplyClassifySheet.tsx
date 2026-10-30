/**
 * ReplyClassifySheet — label what a reply was about.
 *
 * ASSURE#11. Desktop could classify a reply's intent and mobile could not, and
 * `lib/campaignReplies.ts` recorded the reason as a server gap: the analytics
 * rollup's `recent` rows carry no id. That was true of THAT payload and wrong as a
 * conclusion — `GET /api/v1/campaigns/{id}/replies` returns addressable rows, so
 * the verb was reachable all along from a route mobile was not reading.
 *
 * Two refusals are mirrored rather than discovered at runtime: a redacted body
 * (409, and a privacy act rather than a transient state) shows its reason instead
 * of a control, and an unconfigured classifier (503) is reported as the deployment
 * fact it is rather than a failure the operator can retry.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  useAddressableReplies,
  useClassifyReply,
} from "@/hooks/useReplyClassification";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  REPLY_INTENTS,
  REPLY_INTENT_LABELS,
  replyClassifyBlockedReason,
  replyClassifyErrorMessage,
  replyIsClassifiable,
  type ReplyIntent,
} from "@/lib/replyClassification";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ReplyClassifySection({ campaignId }: { campaignId: string }) {
  const { t } = useTheme();
  const { toast } = useToast();
  const replies = useAddressableReplies(campaignId);
  const classify = useClassifyReply(campaignId);

  const rows = Array.isArray(replies.data) ? replies.data : [];
  // Unclassified first: a reply already labelled is not the one asking for a
  // decision.
  const pending = rows.filter((row) => row.intentLabel === "");
  if (pending.length === 0) return null;

  const onClassify = (replyId: string, intent: ReplyIntent) => {
    haptics.tap();
    classify.mutate(
      { replyId, intent },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message: `Marked as ${REPLY_INTENT_LABELS[intent].toLowerCase()}.`,
          }),
        onError: (err) =>
          toast({
            kind: "error",
            message: replyClassifyErrorMessage(
              err && typeof err === "object" && "code" in err
                ? String((err as { code?: unknown }).code ?? "")
                : "",
              "Couldn't classify that reply.",
            ),
          }),
      },
    );
  };

  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Replies awaiting a label
      </Text>
      {pending.slice(0, 5).map((row) => {
        const blocked = replyClassifyBlockedReason(row);
        return (
          <View
            key={row.id}
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingTop: 10,
              gap: 6,
            }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
              numberOfLines={1}
            >
              {row.subject}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {row.fromEmail}
              {row.receivedAt ? ` · ${row.receivedAt}` : ""}
            </Text>
            {blocked ? (
              <Pill label={blocked} tone="neutral" />
            ) : (
              <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
                {REPLY_INTENTS.map((intent) => (
                  <Pressable
                    key={intent}
                    onPress={() => onClassify(row.id, intent)}
                    disabled={classify.isPending || !replyIsClassifiable(row)}
                    accessibilityRole="button"
                    accessibilityLabel={`Mark this reply as ${REPLY_INTENT_LABELS[intent]}`}
                    accessibilityState={{ disabled: classify.isPending }}
                    style={{ minHeight: 44, justifyContent: "center" }}
                  >
                    <Text
                      {...typeCap("control")}
                      style={{
                        color: classify.isPending ? t.fgSubtle : t.accent,
                        ...typeStyle("control"),
                        fontFamily: FONT.semibold,
                      }}
                    >
                      {REPLY_INTENT_LABELS[intent]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
