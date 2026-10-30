/**
 * CampaignSubjectLabLink — seed Subject Lab from the campaign being edited.
 *
 * Desktop opens its SubjectLab overlay pre-seeded with the draft's subject
 * (CampaignCreateOverlays.tsx:376). Mobile's lab is a tab, so the seam is a
 * deep link: push /(tabs)/subject-lab with the current subject as `?seed` and
 * the campaign id as `?campaignId`, which arms the lab's one-tap bandit
 * against this campaign's audience. Press-driven navigation only — nothing is
 * prefetched or minted by rendering this row.
 *
 * The param grammar is lib/subjectLabSeed — the SAME module the screen decodes
 * with, so the two sides of the link are pinned by one round-trip test.
 *
 * NativeWind v4 house rule: static Pressable style objects only.
 */
import { router } from "expo-router";
import { Pressable, Text } from "react-native";

import { forwardArrow } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { subjectLabSeedParams } from "@/lib/subjectLabSeed";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

export function CampaignSubjectLabLink({
  subject,
  campaignId,
  onNavigate,
}: {
  subject: string;
  campaignId: string;
  /** Close the hosting sheet before the push, or the tab opens behind it. */
  onNavigate: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Score this subject in Subject Lab"
      accessibilityHint="Opens Subject Lab seeded with this subject line, where you can score it against your send history and run the winners as a bandit test"
      onPress={() => {
        haptics.tap();
        onNavigate();
        router.push({
          pathname: "/(tabs)/subject-lab",
          params: subjectLabSeedParams(subject, campaignId),
        });
      }}
      style={{
        minHeight: 44,
        justifyContent: "center",
        marginTop: 4,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.accent,
          fontSize: 13,
          fontFamily: FONT.semibold,
        }}
      >
        {`Score in Subject Lab ${forwardArrow()}`}
      </Text>
    </Pressable>
  );
}
