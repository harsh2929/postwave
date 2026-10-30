/**
 * AiChatDraftCard — a reply that came back with a campaign draft.
 *
 * The aichat handler attaches `draft` when the voice service composed one
 * (`kind: campaign_draft`), with the body already carrying the Article 50
 * marker. The card shows what the server sent and offers the two things a
 * phone can do with it: hand it to Campaigns as a real draft (editor and
 * above, subject required — the create contract's rule, not ours) or copy
 * the body.
 */
import * as Clipboard from "expo-clipboard";
import { Pressable, Text, View } from "react-native";

import { aiDraftToCampaignInput, type AiChatDraft } from "@/lib/aiChat";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AiChatDraftCard({
  draft,
  canCreate,
  creating,
  onCreate,
  onCopied,
}: {
  draft: AiChatDraft;
  canCreate: boolean;
  creating: boolean;
  onCreate: (draft: AiChatDraft) => void;
  onCopied: () => void;
}) {
  const { t } = useTheme();
  const creatable = aiDraftToCampaignInput(draft) !== null;
  const bodyChars = draft.body.trim().length;
  return (
    <View
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
        gap: 6,
        marginTop: 8,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
        }}
      >
        Campaign draft
      </Text>
      {draft.subject.trim() ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {draft.subject.trim()}
        </Text>
      ) : null}
      {draft.previewText.trim() ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {draft.previewText.trim()}
        </Text>
      ) : null}
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {bodyChars > 0
          ? `Email body: ${bodyChars} characters. Finish it on the web after it lands in Campaigns.`
          : "No email body came back — only the subject line."}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {canCreate && creatable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create campaign draft"
            accessibilityHint="Saves this draft in Campaigns and opens it"
            accessibilityState={{ disabled: creating, busy: creating }}
            disabled={creating}
            onPress={() => {
              haptics.tap();
              onCreate(draft);
            }}
            style={{
              minHeight: 40,
              paddingHorizontal: 12,
              justifyContent: "center",
              borderRadius: 10,
              backgroundColor: t.accent,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accentFg,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {creating ? "Creating…" : "Create campaign draft"}
            </Text>
          </Pressable>
        ) : null}
        {bodyChars > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy the email body"
            onPress={() => {
              haptics.tap();
              void Clipboard.setStringAsync(draft.body);
              onCopied();
            }}
            style={{
              minHeight: 40,
              paddingHorizontal: 12,
              justifyContent: "center",
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fg,
                ...typeStyle("control"),
                fontFamily: FONT.medium,
              }}
            >
              Copy body
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
