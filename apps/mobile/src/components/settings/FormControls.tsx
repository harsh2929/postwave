import { useId, type ReactNode } from "react";
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";

import { FONT } from "@/lib/fonts";
import { accessoryIdFor, needsDoneAccessory } from "@/lib/keyboardAccessory";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

/**
 * useDoneAccessory — a way OFF an iOS numeric keyboard.
 *
 * iOS number pads have no return key, and `returnKeyType="done"` is silently
 * ignored on them. With no accessory bar the only dismissal is a tap outside
 * the field — which, for the numeric inputs that sit inside a Modal (the
 * retention editor, the webhook thresholds, the voice-label value), is bound
 * to close the sheet. Dismissing the keyboard therefore cost the user the edit
 * they were in the middle of making.
 *
 * Each input gets its OWN nativeID: two InputAccessoryViews sharing one is
 * undefined behaviour, and these controls repeat across sections.
 *
 * Returns `{}` and `null` on Android and for keyboards that already have a
 * return key, so call sites can spread unconditionally.
 */
export function useDoneAccessory(keyboardType: string | undefined): {
  inputProps: { inputAccessoryViewID?: string };
  accessory: ReactNode;
} {
  const instanceId = useId();
  const { t } = useTheme();
  if (!needsDoneAccessory(keyboardType, Platform.OS)) {
    return { inputProps: {}, accessory: null };
  }
  const nativeID = accessoryIdFor(instanceId);
  return {
    inputProps: { inputAccessoryViewID: nativeID },
    accessory: (
      <InputAccessoryView nativeID={nativeID} backgroundColor={t.surface}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            borderTopWidth: 1,
            borderTopColor: t.borderSubtle,
            paddingHorizontal: 12,
          }}
        >
          <Pressable
            onPress={() => Keyboard.dismiss()}
            accessibilityRole="button"
            accessibilityLabel="Dismiss the number keyboard"
            style={{
              minHeight: 44,
              minWidth: 64,
              alignItems: "flex-end",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                fontFamily: FONT.semibold,
                ...typeStyle("control"),
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>
      </InputAccessoryView>
    ),
  };
}

export function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View>
      <Text
        // Uppercase field label above a control: prose on its own line.
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.5,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {label}
      </Text>
      {children}
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function SettingsTextInput({
  label,
  hint,
  style,
  ...props
}: TextInputProps & {
  label: string;
  hint?: string;
}) {
  const { t } = useTheme();
  const accessibilityHint = props.accessibilityHint ?? hint;
  // Every numeric field routed through this primitive gets its Done bar for
  // free; the ones that hand-roll a bare TextInput call the hook themselves.
  const done = useDoneAccessory(props.keyboardType);
  return (
    <SettingsField label={label} {...(hint ? { hint } : {})}>
      <TextInput
        {...props}
        // A TextInput scales with the OS text setting exactly like a Text, and
        // its 44pt minHeight does not, so an uncapped input clips its own
        // caret at accessibility sizes.
        {...typeCap("body")}
        accessibilityLabel={props.accessibilityLabel ?? label}
        {...(accessibilityHint ? { accessibilityHint } : {})}
        {...done.inputProps}
        style={[settingsInputStyle(t), style]}
      />
      {done.accessory}
    </SettingsField>
  );
}

export function SettingsSwitchRow({
  label,
  hint,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          minHeight: 44,
        }}
      >
        <Text
          // Control label beside a Switch. It is prose (flex:1, wraps) and the
          // row is minHeight not fixed height, so it grows with the text.
          {...typeCap("callout")}
          style={{
            color: disabled ? t.fgSubtle : t.fg,
            ...typeStyle("callout"),
            flex: 1,
            fontFamily: FONT.regular,
          }}
        >
          {label}
        </Text>
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={{ true: t.accent, false: t.border }}
          thumbColor={t.surface}
          accessibilityLabel={label}
          {...(hint ? { accessibilityHint: hint } : {})}
          accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
        />
      </View>
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function settingsInputStyle(t: ThemeTokens) {
  return {
    backgroundColor: t.bgSubtle,
    borderColor: t.border,
    borderWidth: 1,
    color: t.fg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    // Size only, no lineHeight: an explicit leading mis-centres the caret and
    // clips descenders on Android (see typeScale's `fontSizeFor` note).
    fontSize: fontSizeFor("body"),
  };
}
