/**
 * AiChatMessageBubble — one turn of the transcript.
 *
 * Three assistant states and one user state, each saying what it is:
 *   pending — "Waiting for the reply", with a spinner and a Stop offered by
 *             the composer (not here), because the whole reply arrives at once;
 *   done    — the text, an explicit "AI-generated" tag (Article 50(2) in
 *             human-readable form; the wire carries the machine marker), Copy
 *             and Regenerate;
 *   failed  — the classified sentence, the request id when the server sent
 *             one, and Retry only when a retry could change the answer.
 */
import * as Clipboard from "expo-clipboard";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { AiChatDraftCard } from "@/components/ai-chat/AiChatDraftCard";
import type { AiChatDraft } from "@/lib/aiChat";
import type { AiChatMessage } from "@/lib/aiChatTranscript";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AiChatMessageBubbleProps {
  message: AiChatMessage;
  /** False while another turn is in flight, offline, or below editor. */
  canAct: boolean;
  onRetry: (assistantId: string) => void;
  onCreateDraft: (draft: AiChatDraft) => void;
  creatingDraft: boolean;
  onCopied: () => void;
  /**
   * Opens the report sheet for this reply.
   *
   * Google Play's generative-AI policy requires an in-app way to flag offensive
   * model output, and Apple Guideline 1.2 reaches the same content. The control
   * sits beside Copy rather than behind a long-press because a requirement that
   * is only discoverable by gesture is one a reviewer will not find either.
   */
  onReport: (assistantId: string, text: string) => void;
}

export function AiChatMessageBubble({
  message,
  canAct,
  onRetry,
  onCreateDraft,
  creatingDraft,
  onCopied,
  onReport,
}: AiChatMessageBubbleProps) {
  const { t } = useTheme();
  if (message.role === "user") {
    return (
      <View style={{ alignItems: "flex-end", marginBottom: 10 }}>
        <View
          accessible
          accessibilityLabel={`You asked: ${message.text}`}
          style={{
            maxWidth: "88%",
            backgroundColor: t.accent,
            borderRadius: 14,
            paddingHorizontal: 12,
            paddingVertical: 9,
            gap: 3,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.accentFg,
              ...typeStyle("body"),
              fontFamily: FONT.regular,
            }}
          >
            {message.text}
          </Text>
          {message.sourceTone ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.accentFg,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                opacity: 0.85,
              }}
            >
              {`Tone: ${message.sourceTone}`}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  const failure = message.status === "failed" ? message.failure : null;
  // Retry only when a retry could change the answer; Regenerate on a done turn.
  const showRetry =
    canAct &&
    (message.status === "failed"
      ? failure?.retryable === true
      : message.status === "done");
  return (
    <View style={{ alignItems: "flex-start", marginBottom: 10 }}>
      <View
        accessibilityRole={failure ? "alert" : undefined}
        accessibilityState={message.status === "pending" ? { busy: true } : undefined}
        style={{
          maxWidth: "92%",
          backgroundColor: t.surface,
          borderColor: failure ? t.danger : t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          paddingHorizontal: 12,
          paddingVertical: 9,
          gap: 6,
        }}
      >
        {message.status === "pending" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ActivityIndicator size="small" color={t.fgMuted} />
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              Waiting for the whole reply…
            </Text>
          </View>
        ) : null}

        {message.status === "done" ? (
          <>
            <Text
              {...typeCap("body")}
              selectable
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.regular,
              }}
            >
              {message.text}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              AI-generated
            </Text>
            {message.draft ? (
              <AiChatDraftCard
                draft={message.draft}
                canCreate={canAct}
                creating={creatingDraft}
                onCreate={onCreateDraft}
                onCopied={onCopied}
              />
            ) : null}
          </>
        ) : null}

        {failure ? (
          <>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.medium,
              }}
            >
              {failure.message}
            </Text>
            {failure.requestId ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {`Request ${failure.requestId}`}
              </Text>
            ) : null}
          </>
        ) : null}

        {message.status !== "pending" ? (
          <View style={{ flexDirection: "row", gap: 12, marginTop: 2 }}>
            {message.status === "done" ? (
              <ActionText
                label="Copy"
                accessibilityLabel="Copy this reply"
                onPress={() => {
                  haptics.tap();
                  void Clipboard.setStringAsync(message.text);
                  onCopied();
                }}
              />
            ) : null}
            {showRetry ? (
              <ActionText
                label={message.status === "done" ? "Regenerate" : "Retry"}
                accessibilityLabel={
                  message.status === "done"
                    ? "Regenerate this reply with the same prompt"
                    : "Retry this prompt"
                }
                onPress={() => {
                  haptics.tap();
                  onRetry(message.id);
                }}
              />
            ) : null}
            {message.status === "done" ? (
              <ActionText
                label="Report"
                accessibilityLabel="Report this AI reply as harmful or offensive"
                onPress={() => {
                  haptics.tap();
                  onReport(message.id, message.text);
                }}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ActionText({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={8}
      style={{ minHeight: 32, justifyContent: "center" }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
