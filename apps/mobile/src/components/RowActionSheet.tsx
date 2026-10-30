/**
 * RowActionSheet — the multi-action context menu the app did not have
 * (LOVE#32).
 *
 * The audit's finding: `onLongPress` appears on list rows across the app and
 * every one of them invokes exactly one verb — `Share.share()`. Long press is
 * the phone's right-click, and rows were spending it on a single action.
 *
 * WHY A CONTROLLED COMPONENT RATHER THAN A PROVIDER. `ConfirmSheet` and
 * `Toast` are providers because they are summoned from deep inside callbacks
 * that have no place to keep state. A row menu is different: the screen
 * already knows which row is open (it needs that to render selection, swipe
 * state and highlight anyway), and a provider would additionally have to be
 * mounted in app/_layout.tsx. Owning `open` in the screen keeps the mount
 * graph unchanged.
 *
 * A11Y rules this bakes in so an adopter cannot forget them:
 *   - every item is a ≥44pt button with a role and a label;
 *   - the sheet itself is `accessibilityViewIsModal`, so VoiceOver cannot
 *     wander into the list underneath it;
 *   - Cancel is a real, focusable control and not only a backdrop tap — a
 *     backdrop is invisible to a screen reader;
 *   - a destructive item is named ("Delete…"), never signalled by red alone.
 */
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RowAction {
  /** Stable identity for the list key. */
  key: string;
  label: string;
  /** Spoken instead of `label` when the label alone is ambiguous out of context. */
  accessibilityLabel?: string | undefined;
  /** One line under the label. Also appended to what VoiceOver announces. */
  hint?: string | undefined;
  destructive?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Spoken when `disabled`, so a dimmed row is never unexplained. */
  disabledReason?: string | undefined;
  onPress: () => void;
}

export function RowActionSheet({
  visible,
  title,
  subtitle,
  actions,
  onClose,
}: {
  visible: boolean;
  /** What the actions act ON — a tag name, an address, a campaign subject. */
  title: string;
  subtitle?: string | undefined;
  actions: readonly RowAction[];
  onClose: () => void;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <ReducedMotionModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        // The backdrop is a convenience for a pointer, never the only exit:
        // it is hidden from the accessibility tree and Cancel below is the
        // real control.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.45)",
          justifyContent: "flex-end",
        }}
      />
      <View
        accessibilityViewIsModal
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: t.bg,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          paddingTop: 14,
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 12) + 8,
          borderColor: t.border,
          borderWidth: 1,
        }}
      >
        <Text
          accessibilityRole="header"
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
          numberOfLines={2}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
            numberOfLines={2}
          >
            {subtitle}
          </Text>
        ) : null}

        <View style={{ marginTop: 12 }}>
          {actions.map((action) => (
            <ActionRow key={action.key} action={action} onClose={onClose} />
          ))}
        </View>

        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={{
            minHeight: 44,
            marginTop: 10,
            paddingVertical: 12,
            borderRadius: 12,
            borderColor: t.border,
            borderWidth: 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fgMuted,
              ...typeStyle("callout"),
              fontFamily: FONT.semibold,
            }}
          >
            Cancel
          </Text>
        </Pressable>
      </View>
    </ReducedMotionModal>
  );
}

function ActionRow({
  action,
  onClose,
}: {
  action: RowAction;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const disabled = Boolean(action.disabled);
  const spoken = action.accessibilityLabel ?? action.label;
  return (
    <Pressable
      onPress={() => {
        if (disabled) return;
        haptics.tap();
        // Dismiss FIRST: an action that navigates would otherwise leave the
        // sheet mounted over the destination.
        onClose();
        action.onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ disabled }}
      {...(disabled && action.disabledReason
        ? { accessibilityHint: action.disabledReason }
        : action.hint
          ? { accessibilityHint: action.hint }
          : {})}
      // NativeWind v4: never a function-style `style` on a Pressable.
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingVertical: 12,
        paddingHorizontal: 4,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: action.destructive ? t.danger : t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.medium,
        }}
        numberOfLines={2}
      >
        {action.label}
      </Text>
      {action.hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
          numberOfLines={2}
        >
          {action.hint}
        </Text>
      ) : null}
    </Pressable>
  );
}
