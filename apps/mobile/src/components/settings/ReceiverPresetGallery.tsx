/**
 * ReceiverPresetGallery — "start from a receiver" for the outbound webhook
 * create form.
 *
 * Desktop opens its create dialog FROM a gallery of named receivers
 * (WebhookOnboardingGallery → ReceiverPresetDialog); a phone has no room for a
 * dialog stack, so the gallery is a chip row above the fields it fills. Picking
 * one rewrites the draft in place: the description, the event chips and the URL
 * placeholder all change where the operator can see them, and the Create button
 * is still the only thing that sends anything.
 *
 * The role rule is stated, not implied. POST /api/v1/outbound-webhooks is
 * admin, so below admin (and under an API key) the templates are withheld with
 * the reason spelled out — an affordance whose only possible outcome is a 403
 * is worse than no affordance.
 *
 * The mapping rules and every sentence live in lib/receiverPresets, where node
 * vitest can reach them.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  RECEIVER_PRESETS,
  RECEIVER_PRESET_SIGNING_NOTE,
  receiverPresetGalleryAccess,
  type ReceiverPreset,
} from "@/lib/receiverPresets";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export interface ReceiverPresetGalleryProps {
  /** The preset currently applied to the draft, or null. */
  selected: ReceiverPreset | null;
  /** What the last apply did that the filled fields don't already show. */
  notes: readonly string[];
  /** Fired with the picked preset — the FORM owns the draft and applies it. */
  onPick: (preset: ReceiverPreset) => void;
}

export function ReceiverPresetGallery({
  selected,
  notes,
  onPick,
}: ReceiverPresetGalleryProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const access = receiverPresetGalleryAccess({
    hasAdminRole: canAccessMinimumRole("admin", gate.effectiveRole, mode),
    apiKeyMode: mode === "api_key",
  });

  return (
    <View style={{ gap: 6 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Start from a receiver
      </Text>

      {access.enabled ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {RECEIVER_PRESETS.map((preset) => (
              <Chip
                key={preset.name}
                label={preset.name}
                active={selected?.name === preset.name}
                accessibilityLabel={`${preset.name} receiver template`}
                onPress={() => onPick(preset)}
              />
            ))}
          </View>
          <GalleryNote tone="muted">
            {selected
              ? selected.helpText
              : "A template fills the description and event types below, and hints at the URL shape. It never fills the URL itself, and nothing is sent until you press Create."}
          </GalleryNote>
          {selected ? (
            <GalleryNote tone="muted">{RECEIVER_PRESET_SIGNING_NOTE}</GalleryNote>
          ) : null}
          {notes.map((note) => (
            <GalleryNote key={note} tone="warning">
              {note}
            </GalleryNote>
          ))}
        </>
      ) : null}
      {!access.enabled && access.reason ? (
        <GalleryNote tone="muted">{access.reason}</GalleryNote>
      ) : null}
    </View>
  );
}

function GalleryNote({
  tone,
  children,
}: {
  tone: "warning" | "muted";
  children: string;
}) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: tone === "warning" ? t.warning : t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
