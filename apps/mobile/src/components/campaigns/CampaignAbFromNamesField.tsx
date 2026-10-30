/**
 * CampaignAbFromNamesField — the optional multivariate axis input for the A/B
 * hand-off: one from-name per line, crossed with the subject variants.
 *
 * Desktop has carried this field since G14 (CampaignCreateOverlays.tsx:309);
 * mobile could fan out subjects but never test sender identity. All the rules
 * — parse, the 1-name-is-not-an-axis fallback, the ≤8-combo cap — live in
 * lib/campaignAbVariants where node vitest reaches them; this component only
 * renders the field and says what the cross-product will be.
 *
 * NativeWind v4 house rule: static Pressable styles only (none here anyway).
 */
import { Text } from "react-native";

import { CampaignFieldInput } from "@/components/campaigns/CampaignFieldInput";
import {
  abComboBlockReason,
  abComboCaption,
  parseFromNameVariants,
} from "@/lib/campaignAbVariants";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

export function CampaignAbFromNamesField({
  value,
  onChangeText,
  subjectCount,
}: {
  value: string;
  onChangeText: (next: string) => void;
  /** How many subject variants the strip currently offers (min 2 assumed). */
  subjectCount: number;
}) {
  const { t } = useTheme();
  const fromNames = parseFromNameVariants(value);
  const subjects = Math.max(2, subjectCount);
  const blocked = abComboBlockReason(subjects, fromNames);
  return (
    <>
      <CampaignFieldInput
        label="A/B from-name variants (optional)"
        value={value}
        onChangeText={onChangeText}
        placeholder={"One from-name per line\nAcme Team\nJane at Acme"}
        multiline
        autoCapitalize="words"
      />
      <Text
        {...typeCap("caption")}
        accessibilityLiveRegion="polite"
        style={{
          color: blocked ? t.warning : t.fgSubtle,
          fontSize: 11,
          lineHeight: 16,
          marginTop: -6,
          fontFamily: FONT.regular,
        }}
      >
        {blocked ?? abComboCaption(subjects, fromNames)}
      </Text>
    </>
  );
}
