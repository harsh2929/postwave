/**
 * The trigger-rule form's Cancel / Save pair.
 *
 * Split out because `InboundTriggerRuleForm` ran to 313 lines against a
 * 300-line ceiling once its Dynamic Type caps and return-key chain were wired.
 * A button row is the cleanest thing to lift: it reads only four booleans and
 * two callbacks, and none of the form's validation state.
 *
 * `blocked` and `submitting` are deliberately separate. Submitting means a
 * request is in flight, and only then does the primary button swap its label
 * for a spinner; blocked also covers "the form is not valid yet", where the
 * label must stay readable so the operator can see what the button would do.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function InboundTriggerRuleFormFooter({
  submitting,
  blocked,
  isEdit,
  onCancel,
  onSubmit,
}: {
  submitting: boolean;
  blocked: boolean;
  isEdit: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTheme();
  const saveLabel = isEdit ? "Save rule" : "Create rule";
  return (
      <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
        <Pressable
          onPress={onCancel}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Cancel editing the rule"
          accessibilityState={{ disabled: submitting }}
          style={{
            flex: 1,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 13,
            alignItems: "center",
            opacity: submitting ? 0.5 : 1,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.medium }}
          >
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={onSubmit}
          disabled={blocked}
          accessibilityRole="button"
          accessibilityLabel={saveLabel}
          accessibilityState={{ disabled: blocked }}
          style={{
            flex: 1,
            backgroundColor: blocked ? t.bgSubtle : t.accent,
            borderRadius: 12,
            paddingVertical: 13,
            alignItems: "center",
          }}
        >
          {submitting ? (
            <ActivityIndicator color={t.accentFg} />
          ) : (
            <Text
              {...typeCap("body")}
              style={{
                color: blocked ? t.fgMuted : t.accentFg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
            >
              {saveLabel}
            </Text>
          )}
        </Pressable>
      </View>
  );
}
