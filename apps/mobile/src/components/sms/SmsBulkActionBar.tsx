/**
 * SmsBulkActionBar — the selection-mode footer of the SMS inbox.
 *
 * Appears while multi-select is active: the running count, the verbs the
 * current status slice honestly offers (`smsBulkOptions`), and the exit. The
 * verbs are all reversible lifecycle SETs (unarchive/unsnooze exist), so per
 * the app's confirm policy there is no pre-confirm — the receipt toast plus
 * the 409-on-conflict server contract are the guard rails.
 */
import { Pressable, ScrollView, Text, View } from "react-native";

import { smsBulkVerbs, type SmsBulkVerbId } from "@/components/sms/smsBulkOptions";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { SMS_BULK_MAX_TARGETS } from "@/lib/smsBulkAction";
import type { SmsConversationStatus } from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsBulkActionBar({
  status,
  selectedCount,
  busy,
  onVerb,
  onCancel,
}: {
  status: SmsConversationStatus;
  selectedCount: number;
  busy: boolean;
  onVerb: (id: SmsBulkVerbId) => void;
  onCancel: () => void;
}) {
  const { t } = useTheme();
  const verbs = smsBulkVerbs(status);
  const none = selectedCount === 0;
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        backgroundColor: t.bg,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 12,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {`${num(selectedCount)} selected`}
          {selectedCount >= SMS_BULK_MAX_TARGETS
            ? ` · limit ${num(SMS_BULK_MAX_TARGETS)}`
            : ""}
        </Text>
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Exit selection"
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            Done
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {verbs.map((verb) => {
            const disabled = busy || none;
            return (
              <Pressable
                key={verb.id}
                onPress={() => onVerb(verb.id)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={`${verb.label}, applies to ${num(selectedCount)} selected conversations`}
                accessibilityState={{ disabled }}
                style={{
                  minHeight: 44,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: disabled ? t.borderSubtle : t.accent,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                <Text
                  {...typeCap("control")}
                  style={{
                    color: disabled ? t.fgMuted : t.accent,
                    ...typeStyle("control"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  {busy ? "Applying…" : verb.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
