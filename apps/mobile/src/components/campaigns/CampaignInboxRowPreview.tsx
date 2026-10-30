/**
 * CampaignInboxRowPreview — the identity fields as one inbox row.
 *
 * The artifact being tuned in the identity sheet IS an inbox row: sender,
 * subject, and the snippet under it. Desktop shows the three assembled while
 * they are typed (InboxRowPreview.tsx); raw form fields hide how they read
 * together. The model — including the "from-name wins over address" rule and
 * the honest fallback for empty preview text — lives in lib/campaignInboxRow;
 * this component renders exactly that model.
 */
import { Text, View } from "react-native";

import {
  INBOX_ROW_EMPTY_SNIPPET_NOTE,
  inboxRowModel,
  type InboxRowInput,
} from "@/lib/campaignInboxRow";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignInboxRowPreview({ input }: { input: InboxRowInput }) {
  const { t } = useTheme();
  const row = inboxRowModel(input);
  return (
    <View
      accessible
      accessibilityLabel={`Inbox preview. From ${row.sender}. Subject: ${row.subject}. ${
        row.snippet ?? INBOX_ROW_EMPTY_SNIPPET_NOTE
      }`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        marginTop: 12,
        gap: 2,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginBottom: 4,
        }}
      >
        How it reads in an inbox
      </Text>
      <Text
        {...typeCap("bodySmall")}
        numberOfLines={1}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.bold,
        }}
      >
        {row.sender}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        numberOfLines={1}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
          writingDirection: "auto",
        }}
      >
        {row.subject}
      </Text>
      <Text
        {...typeCap("caption")}
        numberOfLines={2}
        style={{
          color: row.snippet ? t.fgMuted : t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          fontStyle: row.snippet ? "normal" : "italic",
          writingDirection: "auto",
        }}
      >
        {row.snippet ?? INBOX_ROW_EMPTY_SNIPPET_NOTE}
      </Text>
    </View>
  );
}
