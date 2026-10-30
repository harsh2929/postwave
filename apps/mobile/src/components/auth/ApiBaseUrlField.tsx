/**
 * ApiBaseUrlField — the collapsed "Connecting to …" row and the input behind it.
 *
 * Self-hosted operators need to change the server address; everyone else needs
 * to never see it. Collapsed by default with the current origin in the summary
 * line, so the value is always visible even when the input is not — and the
 * screen can force it open when a validation message refers to it, which is
 * the whole reason the summary reads the value rather than a static label.
 */
import { Pressable, Text, TextInput } from "react-native";

import { authInputStyle } from "@/components/auth/authInputStyle";
import { AuthField } from "@/components/auth/AuthField";
import { DEFAULT_API_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";

export function ApiBaseUrlField({
  value,
  expanded,
  onToggle,
  onChange,
}: {
  value: string;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: string) => void;
}) {
  const { t } = useTheme();
  return (
    <AuthField label="API base URL">
      <Pressable
        onPress={onToggle}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={
          expanded ? "Hide API base URL field" : "Change API base URL"
        }
        accessibilityState={{ expanded }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginBottom: 6,
          }}
          numberOfLines={1}
        >
          {expanded ? "Hide" : `Connecting to ${value}`}
        </Text>
      </Pressable>
      {expanded ? (
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          value={value}
          onChangeText={onChange}
          placeholder={DEFAULT_API_BASE_URL}
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          {...keyboardDismiss()}
          style={authInputStyle(t)}
          accessibilityLabel="API base URL"
        />
      ) : null}
    </AuthField>
  );
}
