/**
 * TemplateSheetActions — the two verbs, and the sentence explaining any "no".
 *
 * Split out of TemplateDetailSheet so the decision of WHETHER a verb is offered
 * lives next to the button rather than three levels up in the screen. Every
 * refusal path renders as a disabled control with a stated reason instead of a
 * hidden one: a button that vanishes teaches nothing, and the reasons here
 * ("this is a reference design", "you need an editor role") are exactly the
 * things an operator needs to know to go and fix them.
 *
 * `accessibilityState={{ disabled }}` is on every control, so a screen reader
 * announces the "no" rather than reading a button that silently does nothing.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface TemplateSheetActionsProps {
  /** Server-side eligibility, already evaluated by lib/templatePolicy. */
  eligible: boolean;
  /** Why not — rendered verbatim when `eligible` is false. */
  ineligibleMessage: string;
  /**
   * Both verbs are editor-gated server-side. Read off the middleware, not the
   * manifest: they are mounted behind `apikeys.RequireScope(write:campaigns)`,
   * which is outside `readOnlyScopes`, so the session path runs
   * `sessionRoleAllowsScopes` and admits owner, admin, and editor.
   */
  canWrite: boolean;
  online: boolean;
  starting: boolean;
  duplicating: boolean;
  onStartCampaign: () => void;
  onDuplicate: () => void;
}

function reasonFor(props: TemplateSheetActionsProps): string | null {
  if (!props.eligible) return props.ineligibleMessage;
  if (!props.canWrite) {
    return "Starting a campaign or duplicating a design needs an editor role on this workspace.";
  }
  if (!props.online) {
    return "You're offline. Neither verb is queued — a draft created hours later, unattended, is not something this screen will do behind your back.";
  }
  return null;
}

export function TemplateSheetActions(props: TemplateSheetActionsProps) {
  const { t } = useTheme();
  const reason = reasonFor(props);
  const blocked = reason !== null;
  const startDisabled = blocked || props.starting || props.duplicating;
  const duplicateDisabled = blocked || props.starting || props.duplicating;

  return (
    <View style={{ gap: 10 }}>
      {reason ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {reason}
        </Text>
      ) : null}

      <Pressable
        onPress={props.onStartCampaign}
        disabled={startDisabled}
        accessibilityRole="button"
        accessibilityLabel="Start a campaign from this design"
        accessibilityHint={
          blocked
            ? undefined
            : "Creates a draft campaign in this workspace and opens it. Nothing is sent."
        }
        accessibilityState={{ disabled: startDisabled, busy: props.starting }}
        style={{
          minHeight: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 16,
          backgroundColor: startDisabled ? t.surfaceElevated : t.accent,
          borderWidth: 1,
          borderColor: startDisabled ? t.border : t.accent,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: startDisabled ? t.fgSubtle : t.accentFg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {props.starting ? "Creating draft…" : "Start a campaign"}
        </Text>
      </Pressable>

      <Pressable
        onPress={props.onDuplicate}
        disabled={duplicateDisabled}
        accessibilityRole="button"
        accessibilityLabel="Duplicate this design"
        accessibilityHint={
          blocked
            ? undefined
            : "Saves an editable copy of this design into your workspace's templates."
        }
        accessibilityState={{
          disabled: duplicateDisabled,
          busy: props.duplicating,
        }}
        style={{
          minHeight: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 16,
          backgroundColor: t.surface,
          borderWidth: 1,
          borderColor: t.border,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: duplicateDisabled ? t.fgSubtle : t.fg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {props.duplicating ? "Duplicating…" : "Duplicate"}
        </Text>
      </Pressable>
    </View>
  );
}
