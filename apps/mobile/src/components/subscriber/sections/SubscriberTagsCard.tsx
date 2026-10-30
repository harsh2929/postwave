/**
 * The Tags card and the Custom fields card.
 *
 * Tag removal goes straight through with an Undo toast raised by the screen,
 * rather than a destructive confirm dialog. The two removal paths (this card
 * and the Edit-tags sheet) used to disagree — one confirmed, one didn't —
 * for the same trivially reversible action.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberTagsCard({
  tags,
  canMutate,
  unavailableReason,
  isUpdatingTags,
  onRemoveTag,
}: {
  tags: readonly string[] | undefined;
  canMutate: boolean;
  unavailableReason?: string | undefined;
  isUpdatingTags: boolean;
  onRemoveTag: (tag: string) => void;
}) {
  const { t } = useTheme();
  return (
    <Card style={{ marginTop: 12 }}>
      <Label>Tags</Label>
      {tags && tags.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 4,
          }}
        >
          {tags.map((tag) => (
            <Pressable
              key={tag}
              onPress={() => {
                if (!canMutate || isUpdatingTags) return;
                haptics.warning();
                onRemoveTag(tag);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Remove tag ${tag}`}
              {...(!canMutate && unavailableReason
                ? { accessibilityHint: unavailableReason }
                : {})}
              accessibilityState={{ disabled: !canMutate || isUpdatingTags }}
              disabled={!canMutate || isUpdatingTags}
              hitSlop={10}
            >
              <Pill label={canMutate ? `${tag}  ✕` : tag} tone="neutral" />
            </Pressable>
          ))}
        </View>
      ) : (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          No tags yet. Tap &quot;Edit tags&quot; above to add one.
        </Text>
      )}
    </Card>
  );
}

export function SubscriberCustomFieldsCard({
  customFields,
}: {
  customFields: Record<string, unknown> | undefined;
}) {
  const { t } = useTheme();
  const entries = Object.entries(customFields ?? {}).filter(
    ([k]) => !k.startsWith("_"),
  );
  if (entries.length === 0) return null;
  return (
    <Card style={{ marginTop: 12 }}>
      <Label>Custom fields</Label>
      <View style={{ marginTop: 4 }}>
        {entries.map(([k, v]) => (
          <View
            key={k}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "flex-start",
              paddingVertical: 4,
              gap: 12,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {k}
            </Text>
            {/* No literal textAlign:'right': React Native auto-flips
                flexDirection under I18nManager.isRTL but never flips a
                hardcoded alignment, so RTL locales got a broken row. The
                row's space-between + flex:1 flip correctly on their own. */}
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                flex: 1,
                fontFamily: FONT.regular,
              }}
              selectable
            >
              {String(v ?? "")}
            </Text>
          </View>
        ))}
      </View>
    </Card>
  );
}
