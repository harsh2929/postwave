/**
 * TemplateLifecycleAction — the archive / restore control on the detail
 * sheet (desktop parity: TemplateDetailSlideover.tsx:255).
 *
 * Split out of TemplateDetailSheet so the four-way gate (a handler, an
 * editor, a live session, a strong tag) and the verb's two labels live next
 * to the button instead of inside the sheet's already-branchy render. The
 * rules themselves are lib/templateLifecycle, shared with the hook that runs
 * the PATCH, so the control can never be offered where the hook would refuse.
 *
 * It sits BELOW the two creating verbs rather than among them: reversible,
 * and about the library rather than about a campaign.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import type { MobileTemplate } from "@/lib/templateCatalog";
import {
  TEMPLATE_LIFECYCLE_A11Y,
  templateLifecycleButtonLabel,
  templateLifecycleOffered,
  templateLifecycleVerb,
} from "@/lib/templateLifecycle";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface TemplateLifecycleActionProps {
  /** The row on screen — the DETAIL read, once it has landed (it carries the tag). */
  template: MobileTemplate;
  canWrite: boolean;
  online: boolean;
  toggling: boolean;
  /** Absent for read-only embeddings: no handler, no control. */
  onToggle: ((template: MobileTemplate) => void) | undefined;
}

export function TemplateLifecycleAction(props: TemplateLifecycleActionProps) {
  const { t } = useTheme();
  const onToggle = props.onToggle;
  if (
    !onToggle ||
    !templateLifecycleOffered({
      template: props.template,
      canWrite: props.canWrite,
      online: props.online,
    })
  ) {
    return null;
  }
  const verb = templateLifecycleVerb(props.template);
  const a11y = TEMPLATE_LIFECYCLE_A11Y[verb];
  return (
    <Pressable
      onPress={() => onToggle(props.template)}
      disabled={props.toggling}
      accessibilityRole="button"
      accessibilityLabel={a11y.label}
      accessibilityHint={a11y.hint}
      accessibilityState={{ disabled: props.toggling, busy: props.toggling }}
      style={{
        minHeight: 48,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 16,
        borderWidth: 1,
        borderColor: t.border,
        opacity: props.toggling ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.fg,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {templateLifecycleButtonLabel(verb, props.toggling)}
      </Text>
    </Pressable>
  );
}
