/**
 * SettingsHelpSheet — the second layer of explanation, opened on demand.
 *
 * Desktop answers "what does this actually do?" with an `InlineHelp` tooltip,
 * which is the only place a hover-driven UI can put that copy. A phone has no
 * hover, so mobile already renders a one-line `hint` under every control —
 * the right pattern, but one line has room for what a control DOES and no room
 * for what it COSTS. This is where the cost goes.
 *
 * Three deliberate choices:
 *  - SCOPE IS ALWAYS STATED. Settings mixes per-device, per-user and
 *    workspace-wide controls in one scroll, and confusing them is the failure
 *    that actually hurts ("I turned my notifications off and now nobody gets
 *    approval alerts").
 *  - THE CONSEQUENCE IS ABSENT, NOT INVENTED, when a control is genuinely
 *    local and reversible. A padded warning teaches people to skip warnings.
 *  - IT IS REACHABLE FROM SEARCH. The Settings index already knows every
 *    section by anchor; the help is keyed on the same anchor, so looking a
 *    setting up and understanding it are one gesture apart.
 */
import { Pressable, Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import {
  settingsHelpFor,
  settingsHelpParagraphs,
} from "@/lib/settingsHelp";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SettingsHelpSheet({
  anchorKey,
  title,
  onClose,
  onJump,
}: {
  /** Null closes the sheet. */
  anchorKey: string | null;
  title: string;
  onClose: () => void;
  /** Scrolls the settings screen to this section and closes the sheet. */
  onJump: ((key: string) => void) | null;
}) {
  const { t } = useTheme();
  const help = anchorKey ? settingsHelpFor(anchorKey) : null;
  const paragraphs = help ? settingsHelpParagraphs(help) : [];

  return (
    <KeyboardFormSheet
      visible={anchorKey !== null}
      onClose={onClose}
      accessibilityLabel={`About ${title}`}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          accessibilityRole="header"
          {...typeCap("title")}
          style={{
            color: t.fg,
            fontFamily: FONT.bold,
            ...typeStyle("title"),
            flex: 1,
          }}
        >
          {title}
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close help"
          hitSlop={8}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
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

      {help ? (
        <>
          <View
            style={{
              alignSelf: "flex-start",
              marginTop: 8,
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surfaceElevated,
            }}
          >
            <Text
              // The scope badge is the most load-bearing line in the sheet, so
              // it is a full sentence for VoiceOver rather than a bare noun.
              accessibilityLabel={`Applies to: ${help.scope}`}
              {...typeCap("badgeSmall")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.semibold,
                ...typeStyle("badgeSmall"),
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {help.scope}
            </Text>
          </View>

          <View style={{ marginTop: 14, gap: 12 }}>
            {paragraphs.map((paragraph, index) => (
              <Text
                key={`help-${index}`}
                {...typeCap("body")}
                style={{
                  // The consequence paragraph carries the warning, so it is
                  // set apart by WEIGHT as well as position — never by colour
                  // alone, and never as a red block that reads as an error.
                  color: t.fg,
                  fontFamily: index === 0 ? FONT.regular : FONT.semibold,
                  ...typeStyle("body"),
                }}
              >
                {paragraph}
              </Text>
            ))}
          </View>

          {onJump && anchorKey ? (
            <Pressable
              onPress={() => onJump(anchorKey)}
              accessibilityRole="link"
              accessibilityLabel={`Go to ${title}`}
              style={{
                marginTop: 20,
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.surface,
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  fontFamily: FONT.semibold,
                  ...typeStyle("body"),
                }}
              >
                Go to this section
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("body"),
            marginTop: 14,
          }}
        >
          {/* ABSENCE IS NOT A BLANK SHEET — say that no help is written yet
              rather than presenting an empty panel as an explanation. */}
          No extra explanation has been written for this section yet. The hint
          under each control describes what it does.
        </Text>
      )}
    </KeyboardFormSheet>
  );
}
