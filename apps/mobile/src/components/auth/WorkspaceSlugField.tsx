/**
 * WorkspaceSlugField — the workspace URL, shown as the URL it will become.
 *
 * The "moosewave.com/" prefix sits INSIDE the field's row rather than in the
 * hint text because the slug is not a name, it is the address teammates will
 * type; showing the stem makes that concrete before the workspace exists. The
 * prefix is muted and non-interactive — it is not part of what the user edits,
 * and it is deliberately not inside the TextInput, where it would be selectable
 * and deletable.
 */
import { forwardRef } from "react";
import { Text, TextInput, View } from "react-native";

import { AuthField } from "@/components/auth/AuthField";
import { authInputStyle } from "@/components/auth/authInputStyle";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export const WorkspaceSlugField = forwardRef<
  TextInput,
  {
    value: string;
    onChangeText: (value: string) => void;
    onSubmitEditing: () => void;
  }
>(function WorkspaceSlugField({ value, onChangeText, onSubmitEditing }, ref) {
  const { t } = useTheme();
  return (
    <AuthField
      label="Workspace URL"
      hint="Lowercase letters, digits, and hyphens. Must be unique."
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          moosewave.com/
        </Text>
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          placeholder="acme"
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Workspace URL slug"
          returnKeyType="go"
          onSubmitEditing={onSubmitEditing}
          style={[authInputStyle(t), { flex: 1 }]}
        />
      </View>
    </AuthField>
  );
});
