/**
 * ReferralMilestoneRow — one editable milestone tier (count / reward label /
 * kind cycler / remove), split out of ReferralProgramEditSheet at its source
 * budget. NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, TextInput, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { REFERRAL_REWARD_KINDS, type MilestoneDraft } from "@/lib/referralAdmin";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

function cycleKind(kind: string): string {
  const ring = ["", ...REFERRAL_REWARD_KINDS];
  const index = ring.indexOf(kind);
  return ring[(index + 1) % ring.length] ?? "";
}

/** One milestone tier: count + label inputs, the kind cycler, remove. */
export function TierDraftRow({
  draft,
  index,
  removable,
  onPatch,
  onRemove,
}: {
  draft: MilestoneDraft;
  index: number;
  removable: boolean;
  onPatch: (patch: Partial<MilestoneDraft>) => void;
  onRemove: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 10,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput
          value={draft.count}
          onChangeText={(count) => onPatch({ count })}
          placeholder="Referrals"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel={`Tier ${index + 1}: referrals required`}
          returnKeyType="done"
          keyboardType="number-pad"
          maxLength={7}
          {...typeCap("body")}
          style={{
            ...inputStyle(t.fg, t.surface, t.borderSubtle),
            flexBasis: 110,
            flexGrow: 0,
          }}
        />
        <TextInput
          value={draft.label}
          onChangeText={(label) => onPatch({ label })}
          placeholder="Reward label"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel={`Tier ${index + 1}: reward label`}
          returnKeyType="done"
          maxLength={200}
          {...typeCap("body")}
          style={{
            ...inputStyle(t.fg, t.surface, t.borderSubtle),
            flexGrow: 1,
            flexShrink: 1,
          }}
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Pressable
          onPress={() => onPatch({ kind: cycleKind(draft.kind) })}
          accessibilityRole="button"
          accessibilityLabel={`Tier ${index + 1} reward kind: ${draft.kind || "unset"}. Tap to change.`}
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
            {`Kind: ${draft.kind || "unset"}`}
          </Text>
        </Pressable>
        {removable ? (
          <Pressable
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel={`Remove tier ${index + 1}`}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.danger,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Remove
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function inputStyle(color: string, background: string, border: string) {
  return {
    color,
    backgroundColor: background,
    borderColor: border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: fontSizeFor("body"),
    fontFamily: FONT.regular,
    minHeight: 44,
  } as const;
}
